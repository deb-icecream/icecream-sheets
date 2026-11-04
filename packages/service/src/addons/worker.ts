/**
 * Worker-isolated add-on execution.
 *
 * Per design-docs/add-on-model.md §3: add-on code runs in a sandboxed
 * worker with no direct access to the service process, the metadata store
 * or other add-ons. CPU and memory limits apply per invocation. A crashing
 * or hanging add-on fails only its own invocation; the host is unaffected.
 *
 * Mechanism (extends packages/mcp-server/src/sandbox/javascript.ts):
 * - Each invocation spawns a fresh `worker_threads` Worker from a static
 *   bootstrap (never interpolated with add-on or user input).
 * - Inside the worker, add-on code runs in a fresh `node:vm` context whose
 *   global exposes ONLY: the `addon` facade, frozen invocation metadata,
 *   and the guest realm's own intrinsics. No `require`, `process`,
 *   `fetch`, `setTimeout`, `console`, `eval` or `Function` constructor —
 *   the last three are shadowed to undefined.
 * - The ONLY channel back to the service process is a synchronous
 *   request/response protocol: the guest calls `__hostCall(json)`, the
 *   worker posts a message and blocks on `Atomics.wait`; the service
 *   thread executes the op through the capability gate + authorize()
 *   (see bindings.ts) and writes the JSON response into a SharedArrayBuffer.
 *   Requests and responses cross as JSON strings built inside the guest,
 *   so guest object references never reach host code.
 * - CPU is bounded twice: the vm `timeout` option (per-invocation CPU ms)
 *   plus a wall-clock watchdog in the service thread that terminates the
 *   worker on expiry.
 * - Memory is bounded per invocation via V8 `resourceLimits`
 *   (maxOldGenerationSizeMb / maxYoungGenerationSizeMb); exceeding the cap
 *   terminates the worker with a detectable error while the host survives
 *   (verified on Node 24).
 *
 * Honest limits:
 * - `node:vm` is NOT a hard security boundary (Node.js docs say so
 *   explicitly). What saves us is the layering: even a vm-escape gadget
 *   lands in the worker thread's bootstrap realm, which holds no reference
 *   to the service process, the metadata store, or other add-ons — the
 *   only bridge is the message protocol, and every op on it is
 *   capability-gated and authorized. Treat this as strong isolation for
 *   accidental misuse and casual probing, not as a kernel sandbox.
 * - Add-on entry functions are synchronous in v1. Async entries are
 *   rejected (event-driven triggers are out of scope per §7).
 */

// NOTE: node:worker_threads is imported dynamically inside runAddonInWorker
// (variable specifier + @vite-ignore) so browser bundlers never see the
// node builtin in the static import graph. The Node production path is
// unaffected; the browser build gets a clean "not available" result.

export interface AddonLimits {
  /** CPU time enforced by the vm timeout option. Default 5000ms. */
  cpuMs?: number;
  /** Wall-clock budget; the worker is terminated on expiry. Default 30000ms. */
  wallMs?: number;
  /** V8 old-generation heap cap in MB. Default 128. */
  maxOldMb?: number;
  /** V8 young-generation heap cap in MB. Default 32. */
  maxYoungMb?: number;
  /** Max bytes for one host response payload. Default 4MB. */
  maxResponseBytes?: number;
}

export interface AddonInvocation {
  addonId: string;
  documentId: string;
  /** Granting user's principal, surfaced to the add-on read-only. */
  principal: string;
}

export type AddonRunResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: string;
      code: 'timeout' | 'memory-limit' | 'crashed' | 'runtime' | 'auth';
    };

const DEFAULTS: Required<AddonLimits> = {
  cpuMs: 5000,
  wallMs: 30000,
  maxOldMb: 128,
  maxYoungMb: 32,
  maxResponseBytes: 4 * 1024 * 1024,
};

/**
 * Static worker bootstrap. Runs in the worker thread; creates the vm
 * context, installs the host-call bridge, runs the add-on, posts 'done'.
 * Contains no interpolated input — everything arrives via workerData.
 */
const BOOTSTRAP = `
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const flag = new Int32Array(workerData.flagSab);
const dataView = new DataView(workerData.dataSab);
const dataBytes = new Uint8Array(workerData.dataSab);
const MAX_RES = workerData.dataSab.byteLength - 4;
const MAX_REQ = 4 * 1024 * 1024;

function readResponse() {
  while (Atomics.load(flag, 0) !== 1) {
    Atomics.wait(flag, 0, 0);
  }
  const len = dataView.getUint32(0, true);
  if (len > MAX_RES) throw new Error('host response too large');
  const json = Buffer.from(dataBytes.subarray(4, 4 + len)).toString('utf8');
  const msg = JSON.parse(json);
  if (msg && typeof msg === 'object' && msg.error) {
    const err = new Error(msg.message || 'host error');
    err.code = msg.error;
    throw err;
  }
  return msg.result;
}

function hostCall(payload) {
  if (typeof payload !== 'string') throw new TypeError('host payload must be a string');
  if (Buffer.byteLength(payload, 'utf8') > MAX_REQ) throw new Error('host request too large');
  Atomics.store(flag, 0, 0);
  parentPort.postMessage({ type: 'call', payload: payload });
  return readResponse();
}

function hostLog(payload) {
  parentPort.postMessage({ type: 'log', payload: String(payload) });
}

const PRELUDE = [
  "'use strict';",
  '// add-on guest prelude: capability-scoped API only',
  'var __args = Object.freeze(JSON.parse(__argsJson));',
  'function __call(op, args) {',
  '  return __hostCall(JSON.stringify({ op: op, args: args === undefined ? null : args }));',
  '}',
  'var addon = Object.freeze({',
  '  id: __inv.addonId,',
  '  documentId: __inv.documentId,',
  '  principal: __inv.principal,',
  '  log: function () { __hostLog(JSON.stringify(Array.prototype.slice.call(arguments))); },',
  '  sheets: Object.freeze({',
  "    list: function () { return __call('sheets.list'); },",
  "    getCell: function (ref) { return __call('sheets.getCell', ref); },",
  "    getRange: function (ref) { return __call('sheets.getRange', ref); },",
  "    setCell: function (ref, value) { return __call('sheets.setCell', { ref: ref, value: value }); },",
  "    setRange: function (ref, values) { return __call('sheets.setRange', { ref: ref, values: values }); },",
  '  }),',
  '  net: Object.freeze({',
  "    fetch: function (req) { return __call('net.fetch', req); },",
  '  }),',
  '});',
].join('\\n');

const DRIVER = [
  ';var __addonResult = (function () {',
  '  var fn = globalThis[__inv.entrypoint];',
  "  if (typeof fn !== 'function') throw new Error('entrypoint not found: ' + __inv.entrypoint);",
  '  return fn(__args);',
  '})();',
].join('\\n');

function done(obj) {
  parentPort.postMessage({ type: 'done', json: JSON.stringify(obj) });
}

try {
  const inv = workerData.invocation;
  const sandbox = {
    __inv: Object.freeze({
      addonId: String(inv.addonId),
      documentId: String(inv.documentId),
      principal: String(inv.principal),
      entrypoint: String(workerData.entrypoint),
    }),
    __argsJson: String(workerData.argsJson),
    __hostCall: hostCall,
    __hostLog: hostLog,
    // Shadow eval / Function constructor and the Node>=22 vm console:
    // guest code must not reach them even by accident.
    eval: undefined,
    Function: undefined,
    console: undefined,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(PRELUDE + '\\n' + String(workerData.code) + '\\n' + DRIVER, context, {
    timeout: workerData.cpuMs,
  });
  const result = context.__addonResult;
  if (result && typeof result.then === 'function') {
    throw new Error('async entrypoint not supported in v1');
  }
  let value = null;
  try {
    value = result === undefined ? null : JSON.parse(JSON.stringify(result));
  } catch (e) {
    throw new Error('entrypoint result is not JSON-serializable');
  }
  done({ ok: true, value: value });
} catch (e) {
  done({
    ok: false,
    error: e && e.message ? String(e.message) : 'unknown error',
    code: e && e.code ? String(e.code) : 'runtime',
  });
}
`;

export interface RunAddonOptions {
  code: string;
  entrypoint: string;
  invocation: AddonInvocation;
  args?: unknown;
  limits?: AddonLimits;
  /** Host-side op handler (capability gate + authorize + binding). */
  onOp: (op: string, args: unknown) => Promise<unknown> | unknown;
  onLog?: (values: unknown[]) => void;
}

/**
 * Run add-on code in an isolated worker. Resolves exactly once.
 * A crashing or hanging add-on fails only its own invocation.
 */
export async function runAddonInWorker(opts: RunAddonOptions): Promise<AddonRunResult> {
  // Add-on workers cannot run in a browser bundle. Fail cleanly instead of
  // a cryptic externalized-module error.
  if (typeof process === 'undefined' || !process.versions?.node) {
    return { ok: false, error: 'add-on worker isolation is not available in the browser build', code: 'runtime' };
  }
  const wtMod = 'node:worker_threads';
  const { Worker } = await import(/* @vite-ignore */ wtMod);
  const limits = { ...DEFAULTS, ...opts.limits };
  const flagSab = new SharedArrayBuffer(4);
  const dataSab = new SharedArrayBuffer(limits.maxResponseBytes + 4);
  const flag = new Int32Array(flagSab);
  const dataView = new DataView(dataSab);
  const dataBytes = new Uint8Array(dataSab);

  let argsJson: string;
  try {
    argsJson = JSON.stringify(opts.args === undefined ? null : opts.args);
  } catch {
    return Promise.resolve({ ok: false, error: 'args are not JSON-serializable', code: 'runtime' });
  }

  return new Promise<AddonRunResult>((resolve) => {
    let settled = false;
    const finish = (r: AddonRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      void worker.terminate().catch(() => undefined);
      resolve(r);
    };

    const respond = (obj: unknown): void => {
      let json = '{"error":"auth","message":"host serialization failed"}';
      try {
        json = JSON.stringify(obj);
      } catch {
        // keep fallback
      }
      const bytes = Buffer.byteLength(json, 'utf8');
      const maxRes = limits.maxResponseBytes;
      if (bytes > maxRes) {
        const small = JSON.stringify({ error: 'runtime', message: 'host response too large' });
        const smallBytes = Buffer.byteLength(small, 'utf8');
        dataView.setUint32(0, smallBytes, true);
        dataBytes.set(Buffer.from(small, 'utf8'), 4);
      } else {
        dataView.setUint32(0, bytes, true);
        dataBytes.set(Buffer.from(json, 'utf8'), 4);
      }
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0, 1);
    };

    const worker = new Worker(BOOTSTRAP, {
      eval: true,
      // NOTE: the bootstrap is an ES module: Node >= 23 runs eval workers
      // in ESM scope (require is undefined there).
      workerData: {
        flagSab,
        dataSab,
        code: opts.code,
        entrypoint: opts.entrypoint,
        invocation: { ...opts.invocation },
        argsJson,
        cpuMs: limits.cpuMs,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: limits.maxOldMb,
        maxYoungGenerationSizeMb: limits.maxYoungMb,
      },
    });

    const watchdog = setTimeout(() => {
      finish({ ok: false, error: `add-on exceeded wall-clock limit of ${limits.wallMs}ms`, code: 'timeout' });
    }, limits.wallMs);
    if (typeof watchdog === 'object' && typeof (watchdog as unknown as { unref?: unknown }).unref === 'function') {
      (watchdog as unknown as { unref(): void }).unref();
    }

    worker.on('message', (msg: unknown) => {
      if (settled || typeof msg !== 'object' || msg === null) return;
      const m = msg as Record<string, unknown>;
      if (m.type === 'done') {
        let parsed: { ok: boolean; value?: unknown; error?: string; code?: string } = { ok: false };
        try {
          parsed = JSON.parse(m.json as string);
        } catch {
          finish({ ok: false, error: 'worker returned malformed result', code: 'crashed' });
          return;
        }
        if (parsed.ok) {
          finish({ ok: true, value: parsed.value === undefined ? null : parsed.value });
          return;
        }
        const message = String(parsed.error ?? 'add-on failed');
        const code: 'timeout' | 'memory-limit' | 'crashed' | 'runtime' | 'auth' =
          parsed.code === 'auth' ? 'auth' : /timed out/i.test(message) ? 'timeout' : 'runtime';
        finish({ ok: false, error: message, code });
        return;
      }
      if (m.type === 'log') {
        try {
          const values = JSON.parse(m.payload as string) as unknown[];
          opts.onLog?.(Array.isArray(values) ? values : [values]);
        } catch {
          // ignore malformed log payloads
        }
        return;
      }
      if (m.type === 'call') {
        void (async () => {
          if (settled) return;
          let req: { op?: unknown; args?: unknown } = {};
          try {
            req = JSON.parse(m.payload as string);
          } catch {
            respond({ error: 'runtime', message: 'malformed host request' });
            return;
          }
          if (typeof req.op !== 'string') {
            respond({ error: 'runtime', message: 'host request missing op' });
            return;
          }
          try {
            const result = await opts.onOp(req.op, req.args === undefined ? null : req.args);
            respond({ result: result === undefined ? null : result });
          } catch (e) {
            const code =
              e !== null && typeof e === 'object' && 'code' in e
                ? String((e as { code: unknown }).code)
                : 'runtime';
            const auth = code === 'capability' || code === 'denied' ? 'auth' : 'runtime';
            respond({ error: auth, message: e instanceof Error ? e.message : String(e) });
          }
        })();
      }
    });

    worker.on('error', (err: Error) => {
      if (/memory limit/i.test(err.message)) {
        finish({ ok: false, error: `add-on exceeded memory limit: ${err.message}`, code: 'memory-limit' });
      } else if (!settled) {
        finish({ ok: false, error: `worker error: ${err.message}`, code: 'crashed' });
      }
    });

    worker.on('exit', (exitCode: number) => {
      if (!settled) {
        finish({
          ok: false,
          error: `worker exited unexpectedly (code ${exitCode})`,
          code: 'crashed',
        });
      }
    });
  });
}
