/**
 * Sandboxed script execution for the automation lane (Node-only).
 *
 * Reuses the sandbox patterns from packages/mcp-server/src/sandbox/:
 * - JavaScript runs in a fresh node:vm context per call. The guest global
 *   exposes only JSON-serialized, deep-frozen bindings plus a narrow `api`
 *   bridge object; it does NOT expose require, process, fetch, timers or
 *   any I/O. CPU is bounded by the vm timeout.
 * - Python spawns `python3` with a restricted prelude (safe builtins,
 *   allowlisted imports, args via argv, code via stdin) and a wall-clock
 *   timeout, mirroring sandbox/python.ts.
 *
 * Honest limits (same as the mcp-server sandbox): node:vm and restricted
 * Python execution are protection against accidental misuse and casual
 * probing, NOT hard isolation for hostile code. Scripts run with the
 * granting user's authority through the permissioned automation API, and
 * every api call re-authorizes — a sandbox escape could still only act
 * through authorize(), but do not run hostile scripts.
 *
 * Bridge model:
 * - JavaScript guests get a live, synchronous `api` object. Each method
 *   JSON-serializes its arguments, the host executes it on the real
 *   AutomationApi (which authorizes with the run's principal), and the
 *   JSON-serialized result or error comes back. Only JSON crosses the
 *   boundary; methods are allowlisted.
 * - Python guests run in a separate process and cannot call back into the
 *   host, so they use the action-collecting model: the script assigns
 *   `actions = [{"method": ..., "args": [...]}, ...]` and the host replays
 *   each action through the AutomationApi with authorization. The frozen
 *   `event` object is available up front for reads-by-event.
 */

import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { AutomationApi, AutomationError } from './api.js';

export interface AutomationSandboxOptions {
  /** Max CPU/wall time for the script. Defaults to 2000ms. */
  timeoutMs?: number;
}

export type AutomationSandboxResult = { value: unknown } | { error: string };

/**
 * Host side of the guest bridge: execute one AutomationApi method and
 * return a JSON envelope. The AutomationApi authorizes every call, so the
 * bridge cannot escalate beyond the run's principal.
 */
export type BridgeHandler = (method: string, argsJson: string) => string;

/** AutomationApi methods exposed to sandboxed scripts (JSON-safe only). */
export const BRIDGE_METHODS = [
  'getCell',
  'setCell',
  'getFormula',
  'setFormula',
  'getRange',
  'setRange',
  'clearRange',
  'listSheets',
  'addSheet',
  'getSheetInfo',
  'setCalculationMode',
  'recalculate',
  'notify',
] as const;

/** Build a bridge handler over one AutomationApi instance. */
export function createBridgeHandler(api: AutomationApi): BridgeHandler {
  const allowed = new Set<string>(BRIDGE_METHODS);
  return (method: string, argsJson: string): string => {
    if (!allowed.has(method)) {
      return JSON.stringify({ ok: false, error: `unknown api method: ${method}`, code: 'invalid' });
    }
    try {
      const args: unknown[] = JSON.parse(argsJson) as unknown[];
      if (!Array.isArray(args)) throw new Error('bridge args must be an array');
      const fn = (api as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
      const value = fn.apply(api, args);
      // JSON round-trip keeps only serializable results on the wire.
      return JSON.stringify({ ok: true, value: value === undefined ? null : value });
    } catch (e) {
      const code = e instanceof AutomationError ? e.code : 'engine';
      return JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        code,
      });
    }
  };
}

export interface ScriptRunOptions extends AutomationSandboxOptions {
  handler: BridgeHandler;
  /** Frozen event object the script receives (onEdit refs, timer info, ...). */
  event?: unknown;
}

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

const JS_DEFAULT_TIMEOUT_MS = 2000;

function jsGuestSource(eventJson: string): string {
  return `'use strict';
const console = undefined;
const event = JSON.parse(${JSON.stringify(eventJson)});
(function deepFreeze(v) {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) { deepFreeze(v[k]); }
    Object.freeze(v);
  }
  return v;
})(event);
const api = new Proxy(Object.create(null), {
  get(_t, m) {
    if (typeof m !== 'string') return undefined;
    return (...args) => {
      const res = JSON.parse(__hostCall(m, JSON.stringify(args)));
      if (!res || res.ok !== true) {
        const err = new Error(res && res.error ? res.error : 'api call failed');
        err.code = res && res.code ? res.code : 'engine';
        throw err;
      }
      return res.value;
    };
  },
});
void 0;`;
}

/**
 * Run JavaScript automation code in the vm sandbox with a live `api`
 * bridge and a frozen `event`. The completion value is returned.
 */
export function runJavaScriptAutomation(
  code: string,
  opts: ScriptRunOptions,
): AutomationSandboxResult {
  if (typeof code !== 'string') return { error: 'code must be a string' };
  const timeoutMs = opts.timeoutMs ?? JS_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { error: 'timeoutMs must be a positive number' };
  }
  let eventJson: string;
  try {
    eventJson = JSON.stringify(opts.event ?? null);
  } catch {
    return { error: 'event must be JSON-serializable' };
  }
  const source = `${jsGuestSource(eventJson)}\n${code}`;
  try {
    const context = vm.createContext(Object.create(null));
    // The bridge is the one deliberate host reference: it only speaks
    // JSON, only exposes allowlisted methods, and every call authorizes.
    const hostCall = (method: string, argsJson: string): string => opts.handler(method, argsJson);
    (context as Record<string, unknown>).__hostCall = hostCall;
    const value: unknown = vm.runInContext(source, context, { timeout: timeoutMs });
    return { value: value === undefined ? null : value };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Python (action-collecting model)
// ---------------------------------------------------------------------------

const PY_DEFAULT_TIMEOUT_MS = 2000;
const PY_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

const PY_PRELUDE = String.raw`
import sys as _sys, json as _json, builtins as _builtins
_real_import = _builtins.__import__
try:
    import resource as _resource
    _resource.setrlimit(_resource.RLIMIT_AS, (__MEM_LIMIT__, __MEM_LIMIT__))
except Exception:
    pass
_ALLOWED_MODULES = frozenset(['math', 'json', 're', 'itertools', 'functools', 'datetime', 'statistics'])
def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    base = str(name).split('.')[0]
    if base not in _ALLOWED_MODULES:
        raise ImportError("import of '%s' is not allowed in the Icecream Sheets sandbox" % base)
    return _real_import(name, globals, locals, fromlist, level)
_SAFE_BUILTINS_DICT = {
    'abs': abs, 'all': all, 'any': any, 'bool': bool, 'bytes': bytes,
    'chr': chr, 'dict': dict, 'divmod': divmod, 'enumerate': enumerate,
    'float': float, 'frozenset': frozenset, 'hash': hash, 'hex': hex,
    'int': int, 'isinstance': isinstance, 'issubclass': issubclass,
    'len': len, 'list': list, 'map': map, 'max': max, 'min': min,
    'oct': oct, 'ord': ord, 'pow': pow, 'range': range, 'repr': repr,
    'reversed': reversed, 'round': round, 'set': set, 'slice': slice,
    'sorted': sorted, 'str': str, 'sum': sum, 'tuple': tuple,
    'type': type, 'zip': zip,
    'True': True, 'False': False, 'None': None,
    '__import__': _safe_import,
    '__build_class__': __build_class__,
}
_user_code = _sys.stdin.read()
_event = _json.loads(_sys.argv[1])
_user_globals = {'__builtins__': _SAFE_BUILTINS_DICT, 'event': _event}
try:
    exec(_user_code, _user_globals)
except ImportError as _e:
    print(_json.dumps({'__sandbox_error__': str(_e)}))
    raise SystemExit(0)
except Exception as _e:
    print(_json.dumps({'__sandbox_error__': '%s: %s' % (type(_e).__name__, _e)}))
    raise SystemExit(0)
if 'actions' not in _user_globals:
    print(_json.dumps({'__sandbox_error__': "program must assign a variable named 'actions' (list of {method, args})"}))
    raise SystemExit(0)
try:
    print(_json.dumps({'__sandbox_value__': _user_globals['actions']}))
except Exception as _e:
    print(_json.dumps({'__sandbox_error__': 'actions is not JSON-serializable: %s' % _e}))
    raise SystemExit(0)
`.replace('__MEM_LIMIT__', String(PY_MEMORY_LIMIT_BYTES));

interface PythonAction {
  method: string;
  args: unknown[];
}

function isPythonAction(v: unknown): v is PythonAction {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PythonAction).method === 'string' &&
    Array.isArray((v as PythonAction).args)
  );
}

/**
 * Run a Python automation script. The script collects a list of
 * `{method, args}` actions in the `actions` variable; the host replays
 * each through the permissioned AutomationApi (authorized per call).
 * Returns the per-action results.
 */
export function runPythonAutomation(
  code: string,
  opts: ScriptRunOptions,
): AutomationSandboxResult {
  if (typeof code !== 'string') return { error: 'code must be a string' };
  const timeoutMs = opts.timeoutMs ?? PY_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { error: 'timeoutMs must be a positive number' };
  }
  let eventJson: string;
  try {
    eventJson = JSON.stringify(opts.event ?? null);
  } catch {
    return { error: 'event must be JSON-serializable' };
  }

  let stdout: string;
  try {
    stdout = execFileSync('python3', ['-c', PY_PRELUDE, eventJson], {
      input: code,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    if (err.code === 'ETIMEDOUT') {
      return { error: `Python execution timed out after ${timeoutMs}ms` };
    }
    if (err.code === 'ENOENT') {
      return { error: 'python3 binary not found on PATH' };
    }
    return { error: `Python execution failed: ${err.message !== undefined ? String(err.message) : String(e)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '');
  } catch {
    return { error: 'Python sandbox produced unreadable output' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { error: 'Python sandbox produced an unexpected result envelope' };
  }
  const envelope = parsed as { __sandbox_value__?: unknown; __sandbox_error__?: string };
  if (envelope.__sandbox_error__ !== undefined) return { error: envelope.__sandbox_error__ };
  if (!Array.isArray(envelope.__sandbox_value__)) {
    return { error: "'actions' must be a list of {method, args}" };
  }
  const results: Array<{ method: string; ok: boolean; value?: unknown; error?: string; code?: string }> = [];
  for (const item of envelope.__sandbox_value__ as unknown[]) {
    if (!isPythonAction(item)) {
      results.push({ method: '?', ok: false, error: 'action must be {method: string, args: array}' });
      continue;
    }
    let res: { ok: boolean; value?: unknown; error?: string; code?: string };
    try {
      res = JSON.parse(opts.handler(item.method, JSON.stringify(item.args))) as {
        ok: boolean;
        value?: unknown;
        error?: string;
        code?: string;
      };
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    results.push({ method: item.method, ...res });
  }
  return { value: results };
}
