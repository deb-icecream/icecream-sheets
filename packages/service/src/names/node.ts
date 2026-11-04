/**
 * Node-only sandboxed runtime for named functions.
 *
 * Implements the InvokeFn hook from './namedFunctions.js': runs a named
 * function's CURRENT source with positional args bound to the signature's
 * param names and returns the completion value.
 *
 * - JavaScript: fresh node:vm context per call. The guest global exposes
 *   only JSON-serialized, deep-frozen param bindings plus the guest realm's
 *   own Math/JSON intrinsics. No require/process/fetch/timers/console. CPU
 *   bounded by the vm timeout (default 2000ms).
 * - TypeScript: erasable annotations stripped (stripTypeScript), then the
 *   JavaScript path. Non-erasable bodies are rejected at definition time.
 * - Python: spawns `python3` with the restricted prelude (safe builtins,
 *   allowlisted imports, params via argv, code via stdin, wall-clock
 *   timeout), mirroring packages/mcp-server/src/sandbox/python.ts. The
 *   program MUST assign `result`.
 *
 * Honest limits (same as the mcp-server/automation sandboxes): node:vm and
 * restricted Python are protection against accidental misuse and casual
 * probing, NOT hard isolation for hostile code. Named functions run with
 * the defining user's authority; only JSON crosses the boundary.
 *
 * Node-only: this module is exported from the
 * '@icecream-sheets/service/names-node' subpath, never from the main
 * browser-safe entry (same split as the automation lane's node.js).
 */
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import {
  stripTypeScript,
  type InvokeFn,
} from './namedFunctions.js';
import type { NamedFunctionLanguage } from './types.js';

export interface InvokeOptions {
  /** Max CPU/wall time for the invocation. Defaults to 2000ms. */
  timeoutMs?: number;
}

export type InvokeResult = { value: unknown } | { error: string };

const DEFAULT_TIMEOUT_MS = 2000;
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Names the guest prelude reserves; params colliding with them are dropped. */
const RESERVED = new Set([
  'args',
  'params',
  'console',
  'globalThis',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Number',
  'String',
  'Boolean',
  'Symbol',
  'BigInt',
  'Function',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Promise',
  'Proxy',
  'Reflect',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'ArrayBuffer',
  'DataView',
  'RegExp',
  'Date',
  'Intl',
  'eval',
  'arguments',
  'undefined',
  'NaN',
  'Infinity',
  'result',
]);

function guestSource(paramsJson: string, names: string[]): string {
  const bindings = names
    .filter((k) => SAFE_KEY.test(k) && !RESERVED.has(k))
    .map((k, i) => `const ${k} = __params[${i}];`)
    .join('\n');
  return `'use strict';
const console = undefined;
const __params = JSON.parse(${JSON.stringify(paramsJson)});
(function deepFreeze(v) {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) { deepFreeze(v[k]); }
    Object.freeze(v);
  }
  return v;
})(__params);
${bindings}
void 0;`;
}

/**
 * Invoke one named-function body in the sandbox. `params` are the
 * signature's param names; `args` the positional values.
 */
export function invokeNamedFunction(
  body: { language: NamedFunctionLanguage; source: string; params: string[] },
  args: unknown[],
  opts: InvokeOptions = {},
): InvokeResult {
  if (body.language === 'python') return invokePython(body, args, opts);
  return invokeJavaScript(body, args, opts);
}

function invokeJavaScript(
  body: { language: NamedFunctionLanguage; source: string; params: string[] },
  args: unknown[],
  opts: InvokeOptions,
): InvokeResult {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { error: 'timeoutMs must be a positive number' };
  }
  let code = body.source;
  if (body.language === 'typescript') {
    try {
      code = stripTypeScript(code);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  } else if (body.language !== 'javascript') {
    return { error: `unsupported language '${body.language}'` };
  }
  // JSON round-trip on the host: rejects non-serializable args up front.
  let paramsJson: string;
  try {
    paramsJson = JSON.stringify(args ?? []);
  } catch {
    return { error: 'args must be JSON-serializable' };
  }
  const source = `${guestSource(paramsJson, body.params)}\n${code}`;
  try {
    const context = vm.createContext(Object.create(null));
    const value: unknown = vm.runInContext(source, context, { timeout: timeoutMs });
    return { value: value === undefined ? null : value };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Python (mirrors packages/mcp-server/src/sandbox/python.ts)
// ---------------------------------------------------------------------------

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
_payload = _json.loads(_sys.argv[1])
_params = _payload['params']
_args = _payload['args']
_user_globals = {'__builtins__': _SAFE_BUILTINS_DICT, 'params': _params, 'args': _args}
try:
    exec(_user_code, _user_globals)
except ImportError as _e:
    print(_json.dumps({'__sandbox_error__': str(_e)}))
    raise SystemExit(0)
except Exception as _e:
    print(_json.dumps({'__sandbox_error__': '%s: %s' % (type(_e).__name__, _e)}))
    raise SystemExit(0)
if 'result' not in _user_globals:
    print(_json.dumps({'__sandbox_error__': "program must assign a variable named 'result'"}))
    raise SystemExit(0)
try:
    print(_json.dumps({'__sandbox_value__': _user_globals['result']}))
except Exception as _e:
    print(_json.dumps({'__sandbox_error__': 'result is not JSON-serializable: %s' % _e}))
    raise SystemExit(0)
`.replace('__MEM_LIMIT__', String(PY_MEMORY_LIMIT_BYTES));

function invokePython(
  body: { source: string; params: string[] },
  args: unknown[],
  opts: InvokeOptions,
): InvokeResult {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { error: 'timeoutMs must be a positive number' };
  }
  let payload: string;
  try {
    const params: Record<string, unknown> = {};
    body.params.forEach((name, i) => {
      if (SAFE_KEY.test(name) && !RESERVED.has(name)) params[name] = args[i] ?? null;
    });
    payload = JSON.stringify({ params, args: args ?? [] });
    JSON.parse(payload);
  } catch {
    return { error: 'args must be JSON-serializable' };
  }
  try {
    const out = execFileSync('python3', ['-c', PY_PRELUDE, payload], {
      input: body.source,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const line = String(out).trim().split('\n').pop() ?? '';
    let envelope: unknown;
    try {
      envelope = JSON.parse(line);
    } catch {
      return { error: `sandbox produced non-JSON output: ${line.slice(0, 200)}` };
    }
    if (typeof envelope === 'object' && envelope !== null) {
      const env = envelope as Record<string, unknown>;
      if (typeof env['__sandbox_error__'] === 'string') {
        return { error: String(env['__sandbox_error__']) };
      }
      if ('__sandbox_value__' in env) return { value: env['__sandbox_value__'] ?? null };
    }
    return { error: 'sandbox produced an unrecognized envelope' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ETIMEDOUT|timed out/i.test(msg)) return { error: `sandbox timed out after ${timeoutMs}ms` };
    return { error: msg };
  }
}

/**
 * Build the InvokeFn hook for NamedFunctionRegistry from this runtime.
 * Pass as `invoke` so definition-time signature checks really execute.
 */
export function makeInvokeFn(opts: InvokeOptions = {}): InvokeFn {
  return (body, args) => invokeNamedFunction(body, args, opts);
}
