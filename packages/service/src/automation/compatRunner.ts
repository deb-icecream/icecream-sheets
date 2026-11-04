/**
 * Compatibility runner for unmigrated Windows automation
 * (design-docs/automation-lane.md §6 — Node-only).
 *
 * VBA / Apps Script that the migration translator could not (or could only
 * partly) migrate — and opaque preserved macro projects (vbaProject.bin) —
 * must NEVER run inside the engine process. CompatRunner executes them in a
 * separate OS process behind a narrow JSON protocol:
 *
 * - Parent -> child: one JSON document on stdin: { code, input }.
 *   `input` is a read-only data snapshot ({ cells: { "Sheet!row,col": value } })
 *   exposed to the script as a deep-frozen `input` binding.
 * - Child -> parent: exactly one JSON envelope on stdout:
 *   { ok: true, value, actions, notifications } or { ok: false, error }.
 *   There is NO IPC channel, no shared memory, no host function the child
 *   can call: the child literally cannot reach the engine process. Write
 *   requests come back as *declared actions* ({ method, args }) which the
 *   host replays through the permissioned AutomationApi (authorize() on
 *   every call) — the same action-collecting model as the Python sandbox
 *   in sandbox.ts.
 *
 * Isolation enforcement:
 * - The child runs with a scrubbed environment (env: {}) and no IPC stdio.
 * - Guest code executes in a node:vm context with no require, process,
 *   fetch, timers or I/O; only a narrow `api` shim backed by the snapshot.
 * - Wall-clock timeout: the child is SIGKILLed past the deadline and the
 *   run reports { ok: false, code: 'timeout' }.
 * - Memory: --max-old-space-size caps the child's JS heap.
 * - Output: stdout is capped; a child that floods the pipe is killed and
 *   reported as a protocol failure.
 * - Anything suspicious — a crash, unreadable output, actions outside the
 *   allowlist — becomes a clean { ok: false } failure, never a parent crash.
 *
 * Byte-faithful VBA execution is OUT OF SCOPE for v1 (automation-lane.md
 * §8): opaque payloads (raw vbaProject.bin, COM/OLE automation) are never
 * executed. CompatRunner reports them as clean 'unsupported' failures.
 *
 * Honest limits (same convention as sandbox.ts): node:vm is protection
 * against accidental misuse and casual probing, not a hard boundary for
 * hostile code. The HARD boundary is the OS process: even a guest that
 * escaped the vm context would find a scrubbed env, no IPC handle to the
 * parent, and no engine reference — the worst it can do is kill its own
 * child process, which the parent reports as a protocol failure.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import { AutomationApi, type DeclaredPermission } from './api.js';
import { stripTypeAnnotations, TypeStripError } from './tsStrip.js';
import {
  translateAppsScript,
  translateVba,
  type UntranslatedLine,
} from './translator.js';

// ---------------------------------------------------------------------------
// Payloads and results
// ---------------------------------------------------------------------------

/** A migrated (or hand-written) automation script to run in isolation. */
export interface CompatScriptPayload {
  kind: 'script';
  /** 'typescript' sources are type-stripped before execution. */
  language: 'typescript' | 'javascript';
  /** Script text. Must define `main(api)` (translator output does). */
  code: string;
  /** Permissions the script declares (informational; the host enforces grants). */
  permissions?: DeclaredPermission[];
  /**
   * JSON-serializable data exposed read-only to the script as `input`.
   * Convention: { cells: { "<sheet>!<row>,<col>": value } } — see
   * compatCellKey() / snapshotCells().
   */
  input?: unknown;
}

/**
 * Opaque Windows automation that cannot be migrated: a preserved
 * vbaProject.bin, COM/OLE automation, etc. Never executed — running it
 * byte-faithfully is v2-excluded (automation-lane.md §8).
 */
export interface CompatOpaquePayload {
  kind: 'opaque';
  /** e.g. 'vbaProject.bin'. */
  format: string;
  /** Base64 of the opaque bytes (for round-trip preservation, not execution). */
  dataBase64: string;
  reason: string;
}

export type CompatPayload = CompatScriptPayload | CompatOpaquePayload;

/** A write the isolated script asked the host to perform. */
export interface CompatAction {
  method: 'setCell' | 'setRange';
  args: unknown[];
}

export interface CompatRunOptions {
  /** Wall-clock budget for the child. The child is SIGKILLed past it. Defaults to 5000. */
  timeoutMs?: number;
  /** Child JS heap cap in MiB (via --max-old-space-size). Defaults to 256. */
  maxMemoryMb?: number;
  /** Stdout cap in bytes before the child is killed. Defaults to 4 MiB. */
  maxOutputBytes?: number;
}

export type CompatFailureCode = 'timeout' | 'unsupported' | 'execution' | 'protocol' | 'input';

export type CompatResult =
  | {
      ok: true;
      /** The script's completion value (JSON). */
      value: unknown;
      /** Declared writes for the host to replay through AutomationApi. */
      actions: CompatAction[];
      /** api.notify() messages collected in the child. */
      notifications: string[];
      durationMs: number;
    }
  | { ok: false; code: CompatFailureCode; error: string; durationMs: number };

// ---------------------------------------------------------------------------
// Snapshot helpers (parent side)
// ---------------------------------------------------------------------------

/** Snapshot key for one cell: "<sheet>!<row>,<col>" (0-based). */
export function compatCellKey(sheet: string, row: number, col: number): string {
  return `${sheet}!${row},${col}`;
}

export type CompatCellValue = string | number | boolean | null;

/**
 * Build the read-only cell snapshot the child sees as `input.cells` from
 * an AutomationApi range read. Values are unwrapped to JSON scalars
 * (error cells become their error code, e.g. '#DIV/0!').
 */
export function snapshotCells(
  api: AutomationApi,
  sheet: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Record<string, CompatCellValue> {
  const cells: Record<string, CompatCellValue> = {};
  const grid = api.getRange({ sheet, startRow, startCol, endRow, endCol });
  for (let r = 0; r < grid.length; r += 1) {
    const line = grid[r] ?? [];
    for (let c = 0; c < line.length; c += 1) {
      const tv = line[c]!;
      let value: CompatCellValue;
      if (tv.kind === 'error') value = tv.code;
      else if (tv.kind === 'image') value = tv.alt;
      else value = tv.value;
      cells[compatCellKey(sheet, startRow + r, startCol + c)] = value;
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Child process source (plain JS, no imports beyond node built-ins)
// ---------------------------------------------------------------------------

/**
 * The child program, passed to `node -e`. It reads ONE JSON document from
 * stdin ({ code, input }), runs the code in a vm context whose only host
 * surface is the snapshot-backed `api` shim, and writes ONE JSON envelope
 * to stdout. It never requires() anything for the guest and never opens
 * an IPC channel.
 *
 * Written without template literals so it can live inside a TS template
 * string safely.
 */
const CHILD_SOURCE = String.raw`
'use strict';
const vm = require('node:vm');

function freezeDeep(v, seen) {
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return v;
  seen.add(v);
  const keys = Object.keys(v);
  for (let i = 0; i < keys.length; i++) freezeDeep(v[keys[i]], seen);
  return Object.freeze(v);
}

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(message) }) + '\n');
}

function tvOf(v) {
  if (v === null || v === undefined) return { kind: 'blank', value: null };
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return { kind: t, value: v };
  return { kind: 'string', value: String(v) };
}

function run(payload) {
  try {
    const input = freezeDeep(
      JSON.parse(JSON.stringify(payload.input === undefined ? null : payload.input)),
      new Set(),
    );
    const rawCells = input && typeof input === 'object' && input.cells && typeof input.cells === 'object'
      ? input.cells
      : {};
    const actions = [];
    const notifications = [];
    const keyOf = (ref) => String(ref.sheet) + '!' + ref.row + ',' + ref.col;
    const api = Object.freeze({
      getCell: (ref) => tvOf(rawCells[keyOf(ref)]),
      setCell: (ref, value) => {
        actions.push({ method: 'setCell', args: [ref, value] });
        return null;
      },
      getRange: (r) => {
        const rows = [];
        for (let row = r.startRow; row <= r.endRow; row++) {
          const line = [];
          for (let col = r.startCol; col <= r.endCol; col++) {
            line.push(tvOf(rawCells[String(r.sheet) + '!' + row + ',' + col]));
          }
          rows.push(line);
        }
        return rows;
      },
      setRange: (r, values) => {
        actions.push({ method: 'setRange', args: [r, values] });
        return null;
      },
      notify: (message) => {
        notifications.push(String(message));
        return null;
      },
    });
    // Null-prototype sandbox: no constructor/prototype chains to reach.
    const sandbox = Object.create(null);
    sandbox.api = api;
    sandbox.input = input;
    sandbox.JSON = JSON;
    sandbox.Math = Math;
    sandbox.Object = Object;
    sandbox.Array = Array;
    sandbox.String = String;
    sandbox.Number = Number;
    sandbox.Boolean = Boolean;
    sandbox.Date = Date;
    sandbox.RegExp = RegExp;
    sandbox.Error = Error;
    sandbox.isNaN = isNaN;
    sandbox.isFinite = isFinite;
    sandbox.parseInt = parseInt;
    sandbox.parseFloat = parseFloat;
    const context = vm.createContext(sandbox);
    const code = String(payload.code || '');
    // Per-call vm timeout: synchronous guests cannot outrun this; the
    // parent's SIGKILL is the backstop for anything else.
    vm.runInContext(code, context, { timeout: 4000 });
    const hasMain = vm.runInContext('typeof main === "function"', context, { timeout: 1000 });
    if (!hasMain) {
      fail("script must define a function named 'main(api)'");
      return;
    }
    const value = vm.runInContext('main(api)', context, { timeout: 4000 });
    let envelope;
    try {
      envelope = JSON.stringify({ ok: true, value: value === undefined ? null : value, actions, notifications });
    } catch (e) {
      fail('result is not JSON-serializable: ' + (e && e.message ? e.message : String(e)));
      return;
    }
    process.stdout.write(envelope + '\n');
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    fail('payload is not valid JSON: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  run(payload);
});
`;

// ---------------------------------------------------------------------------
// CompatRunner
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_MEMORY_MB = 256;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Keep failure messages readable: cap embedded child output. */
const STDERR_SNIPPET_LIMIT = 2000;

function isJsonScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isCellRef(v: unknown): v is { sheet: string; row: number; col: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { sheet?: unknown }).sheet === 'string' &&
    Number.isInteger((v as { row?: unknown }).row) &&
    Number.isInteger((v as { col?: unknown }).col)
  );
}

function isRangeRef(v: unknown): v is {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { sheet?: unknown }).sheet === 'string' &&
    Number.isInteger((v as { startRow?: unknown }).startRow) &&
    Number.isInteger((v as { startCol?: unknown }).startCol) &&
    Number.isInteger((v as { endRow?: unknown }).endRow) &&
    Number.isInteger((v as { endCol?: unknown }).endCol)
  );
}

/** Validate one declared action from the child before the host replays it. */
export function validateCompatAction(action: unknown): string[] {
  const errors: string[] = [];
  if (typeof action !== 'object' || action === null) return ['action must be an object'];
  const a = action as { method?: unknown; args?: unknown };
  if (a.method !== 'setCell' && a.method !== 'setRange') {
    return [`unknown compat action method "${String(a.method)}"`];
  }
  if (!Array.isArray(a.args)) return [`${String(a.method)}: args must be an array`];
  if (a.method === 'setCell') {
    const [ref, value] = a.args;
    if (!isCellRef(ref)) errors.push('setCell: args[0] must be a { sheet, row, col } ref');
    if (!isJsonScalar(value)) errors.push('setCell: args[1] must be a JSON scalar');
  } else {
    const [ref, values] = a.args;
    if (!isRangeRef(ref)) errors.push('setRange: args[0] must be a range ref');
    if (
      !Array.isArray(values) ||
      !values.every(
        (line) => Array.isArray(line) && line.every((v: unknown) => isJsonScalar(v)),
      )
    ) {
      errors.push('setRange: args[1] must be a 2D array of JSON scalars');
    }
  }
  return errors;
}

export class CompatRunner {
  private readonly timeoutMs: number;
  private readonly maxMemoryMb: number;
  private readonly maxOutputBytes: number;

  constructor(opts: CompatRunOptions = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive number');
    }
    const maxMemoryMb = opts.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB;
    if (!Number.isFinite(maxMemoryMb) || maxMemoryMb <= 0) {
      throw new Error('maxMemoryMb must be a positive number');
    }
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error('maxOutputBytes must be a positive number');
    }
    this.timeoutMs = timeoutMs;
    this.maxMemoryMb = maxMemoryMb;
    this.maxOutputBytes = maxOutputBytes;
  }

  /**
   * Run a payload in the isolated child process.
   *
   * - 'script': spawns the child, feeds { code, input } over stdin, and
   *   returns the child's envelope. Timeouts, crashes and protocol
   *   violations become clean failures.
   * - 'opaque': never executed (byte-faithful VBA is v2-excluded); returns
   *   a clean 'unsupported' failure without spawning anything.
   */
  async run(payload: CompatPayload): Promise<CompatResult> {
    const started = Date.now();
    const fail = (code: CompatFailureCode, error: string): CompatResult => ({
      ok: false,
      code,
      error,
      durationMs: Date.now() - started,
    });

    if (payload === null || typeof payload !== 'object' || (payload as { kind?: unknown }).kind === undefined) {
      return fail('input', 'payload must be an object with a kind');
    }

    if (payload.kind === 'opaque') {
      const byteLen = payload.dataBase64.length;
      return fail(
        'unsupported',
        `unmigrated Windows automation (${payload.format}, ${byteLen} base64 chars) cannot run: ` +
          `byte-faithful VBA execution is out of scope for v1 (automation-lane.md §8). ` +
          `The project is preserved byte-for-byte but never executed. ` +
          (payload.reason ? `Hint: ${payload.reason}` : ''),
      );
    }

    if (payload.kind !== 'script') {
      return fail('input', `unknown payload kind "${String((payload as { kind?: unknown }).kind)}"`);
    }

    if (typeof payload.code !== 'string' || payload.code.trim() === '') {
      return fail('input', 'script payload needs a non-empty code string');
    }

    // TypeScript sources are stripped to plain JS before crossing the
    // boundary; strip failures are clean input errors, not child crashes.
    let code: string = payload.code;
    if (payload.language === 'typescript') {
      try {
        code = stripTypeAnnotations(payload.code);
      } catch (e) {
        return fail(
          'input',
          e instanceof TypeStripError ? `type-strip failed: ${e.message}` : `type-strip failed: ${String(e)}`,
        );
      }
    }
    let wirePayload: string;
    try {
      wirePayload = JSON.stringify({ code, input: payload.input ?? null });
    } catch {
      return fail('input', 'payload input must be JSON-serializable');
    }

    return this.spawnChild(wirePayload, started);
  }

  private spawnChild(wirePayload: string, started: number): Promise<CompatResult> {
    const fail = (code: CompatFailureCode, error: string): CompatResult => ({
      ok: false,
      code,
      error,
      durationMs: Date.now() - started,
    });
    return new Promise<CompatResult>((resolve) => {
      let settled = false;
      const done = (r: CompatResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };

      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${Math.floor(this.maxMemoryMb)}`, '-e', CHILD_SOURCE],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          // Scrubbed environment: the child gets nothing from the parent.
          env: {},
          // No IPC channel: stdio is pipes only, so the child cannot
          // message the parent process even if it escaped the vm context.
          cwd: os.tmpdir(),
          windowsHide: true,
        },
      );

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL: no cleanup handlers run in the child; the run simply ends.
        child.kill('SIGKILL');
      }, this.timeoutMs);
      // Don't let the watchdog hold the event loop open on its own.
      if (typeof timer.unref === 'function') timer.unref();

      let stdout = '';
      let stdoutOverflow = false;
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutOverflow) return;
        stdout += chunk.toString('utf8');
        if (stdout.length > this.maxOutputBytes) {
          stdoutOverflow = true;
          child.kill('SIGKILL');
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_SNIPPET_LIMIT) {
          stderr += chunk.toString('utf8').slice(0, STDERR_SNIPPET_LIMIT - stderr.length);
        }
      });
      child.on('error', (e) => {
        done(fail('protocol', `failed to spawn the compatibility child: ${e.message}`));
      });

      child.stdin?.on('error', () => {
        // The child died before reading stdin; 'close' will report it.
      });
      child.stdin?.write(wirePayload);
      child.stdin?.end();

      child.on('close', (code, signal) => {
        if (timedOut || stdoutOverflow) {
          done(
            timedOut
              ? fail('timeout', `compatibility run timed out after ${this.timeoutMs}ms (child SIGKILLed)`)
              : fail('protocol', `compatibility child exceeded the ${this.maxOutputBytes}-byte output cap`),
          );
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
          done(
            fail(
              'protocol',
              `compatibility child exited with code ${String(code)}${signal ? ` (signal ${signal})` : ''}${detail}`,
            ),
          );
          return;
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(stdout.trim());
        } catch {
          const detail = stderr.trim() ? ` (stderr: ${stderr.trim()})` : '';
          done(fail('protocol', `compatibility child produced unreadable output${detail}`));
          return;
        }
        if (typeof envelope !== 'object' || envelope === null) {
          done(fail('protocol', 'compatibility child produced an unexpected envelope'));
          return;
        }
        const env = envelope as {
          ok?: unknown;
          value?: unknown;
          actions?: unknown;
          notifications?: unknown;
          error?: unknown;
        };
        if (env.ok !== true) {
          done(fail('execution', typeof env.error === 'string' ? env.error : 'child reported failure'));
          return;
        }
        const actions = Array.isArray(env.actions) ? env.actions : [];
        for (const a of actions) {
          const errs = validateCompatAction(a);
          if (errs.length > 0) {
            done(fail('protocol', `child declared a suspicious action: ${errs.join('; ')}`));
            return;
          }
        }
        const notifications = Array.isArray(env.notifications)
          ? env.notifications.filter((n): n is string => typeof n === 'string')
          : [];
        done({
          ok: true,
          value: env.value === undefined ? null : env.value,
          actions: actions as CompatAction[],
          notifications,
          durationMs: Date.now() - started,
        });
      });
    });
  }
}

/**
 * Replay declared compat actions through the permissioned AutomationApi.
 * Every call re-authorizes against the api's principal — the isolated
 * script can never write more than the granted permissions allow.
 * Throws on the first invalid action (fail closed).
 */
export function replayCompatActions(api: AutomationApi, actions: CompatAction[]): void {
  for (const action of actions) {
    const errs = validateCompatAction(action);
    if (errs.length > 0) {
      throw new Error(`refusing to replay suspicious compat action: ${errs.join('; ')}`);
    }
    if (action.method === 'setCell') {
      const [ref, value] = action.args as [{ sheet: string; row: number; col: number }, string | number | boolean | null];
      api.setCell(ref, value);
    } else {
      const [ref, values] = action.args as [
        { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number },
        (string | number | boolean | null)[][],
      ];
      api.setRange(ref, values);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point: route unmigrated Windows automation to the runner
// ---------------------------------------------------------------------------

export interface WindowsAutomationSource {
  kind: 'vba' | 'apps-script';
  source: string;
}

export interface UnmigratedRunOptions extends CompatRunOptions {
  /**
   * JSON-serializable data exposed read-only to the isolated script as
   * `input` (convention: { cells } — see snapshotCells()).
   */
  input?: unknown;
  /**
   * When set, the run's declared write actions are replayed through this
   * AutomationApi (authorize() on every call) before the report resolves.
   */
  api?: AutomationApi;
}

export interface UnmigratedRunReport {
  sourceLanguage: 'vba' | 'apps-script';
  /** Source lines the translator could not migrate, with reasons. */
  untranslated: UntranslatedLine[];
  /** Permissions the translated script declares. */
  permissions: DeclaredPermission[];
  result: CompatResult;
}

/**
 * Entry point for unmigrated Windows automation (automation-lane.md §6).
 *
 * VBA / Apps Script source is translated first; the translated script then
 * runs in the CompatRunner's isolated child process — never in the engine
 * process, never via the in-page runner. Lines the translator could not
 * migrate are reported (not guessed at); when NOTHING was translatable the
 * run fails cleanly without spawning a child.
 */
export async function runUnmigratedWindowsAutomation(
  source: WindowsAutomationSource,
  opts: UnmigratedRunOptions = {},
): Promise<UnmigratedRunReport> {
  const started = Date.now();
  const failResult = (code: CompatFailureCode, error: string): CompatResult => ({
    ok: false,
    code,
    error,
    durationMs: Date.now() - started,
  });

  if (typeof source.source !== 'string') {
    return {
      sourceLanguage: source.kind,
      untranslated: [],
      permissions: [],
      result: failResult('input', 'source must be a string'),
    };
  }

  const translated =
    source.kind === 'vba' ? translateVba(source.source) : translateAppsScript(source.source);

  // The translator always emits a `main` shell, even for a Sub whose body
  // was entirely untranslatable. The signal that something can actually run
  // is an AutomationApi call in the emitted code (every translated pattern
  // goes through `api.*`; comments are ignored).
  const codeWithoutComments = translated.code.replace(/\/\/[^\n]*/g, '');
  const hasRunnableApiCalls = /\bapi\.[A-Za-z]+\s*\(/.test(codeWithoutComments);
  if (!hasRunnableApiCalls) {
    return {
      sourceLanguage: translated.sourceLanguage,
      untranslated: translated.untranslated,
      permissions: translated.permissions,
      result: failResult(
        'unsupported',
        `no translatable statements in the ${source.kind} source ` +
          `(${translated.untranslated.length} untranslated line(s)); nothing was executed. ` +
          `Byte-faithful VBA execution is out of scope for v1 (automation-lane.md §8).`,
      ),
    };
  }

  const runner = new CompatRunner(opts);
  const result = await runner.run({
    kind: 'script',
    language: 'typescript',
    code: translated.code,
    permissions: translated.permissions,
    input: opts.input,
  });

  if (result.ok && opts.api) {
    try {
      replayCompatActions(opts.api, result.actions);
    } catch (e) {
      return {
        sourceLanguage: translated.sourceLanguage,
        untranslated: translated.untranslated,
        permissions: translated.permissions,
        result: {
          ok: false,
          code: 'execution',
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - started,
        },
      };
    }
  }

  return {
    sourceLanguage: translated.sourceLanguage,
    untranslated: translated.untranslated,
    permissions: translated.permissions,
    result,
  };
}

/**
 * Route a preserved macro project (the opaque vbaProject.bin bytes the XLSX
 * adapter keeps in workbook metadata) to the compatibility runner. The
 * project is never executed — this returns the runner's clean 'unsupported'
 * failure — so callers can surface "macros were preserved but not run"
 * instead of failing or running macro code in-process.
 */
export async function runPreservedMacroProject(
  dataBase64: string,
  opts: CompatRunOptions = {},
): Promise<CompatResult> {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
    return {
      ok: false,
      code: 'input',
      error: 'preserved macro project needs a non-empty base64 payload',
      durationMs: 0,
    };
  }
  const runner = new CompatRunner(opts);
  return runner.run({
    kind: 'opaque',
    format: 'vbaProject.bin',
    dataBase64,
    reason:
      'The macro project was preserved byte-for-byte by the XLSX adapter ' +
      '(automation-lane.md §6) as a round-trip hint; it is not parsed or executed.',
  });
}
