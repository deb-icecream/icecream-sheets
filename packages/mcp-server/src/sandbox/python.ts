/**
 * Synchronous Python sandbox for Icecream Sheets (Phase 3).
 *
 * Mechanism: each call spawns `<interpreter> -c <prelude>` via
 * `child_process.execFileSync` (argv list — never a shell). The prelude:
 *  1. Applies a best-effort address-space cap with `resource.setrlimit`
 *     (Linux only, guarded — no-op elsewhere).
 *  2. Replaces `builtins` with a safe subset (no `open`, no `eval`/`exec`/
 *     `compile`, no `input`, no `globals`/`locals`/`vars`/`dir`).
 *  3. Installs an `__import__` hook that allows only the allowlisted
 *     modules and raises ImportError for everything else (`os`, `sys`,
 *     `subprocess`, `socket`, `importlib`, ...).
 *  4. Reads `args` (JSON) from argv[1] and the user program from stdin —
 *     no shell quoting, no source-code interpolation.
 *  5. `exec`s the user program in a globals dict containing only the safe
 *     builtins and `args`; the program MUST assign `result`, which is
 *     printed as JSON on stdout. stdout is parsed back on the host.
 * - CPU is bounded by execFileSync's `timeout` (default 2000ms); the child
 *   is killed on expiry and the call returns a timeout error.
 *
 * Pinned environment (default): runs use the content-addressed pinned
 * Python venv from @icecream-sheets/service/python-env
 * (numpy/pandas/matplotlib at pinned versions; the venv lives at
 * <root>/<sha256(requirements + python version)>/) and the import
 * allowlist additionally permits pandas, numpy, matplotlib (plus io and
 * base64, matching the engine PY() prelude contract). The environment is
 * provisioned lazily on first use (python3 -m venv + pip install of the
 * pinned requirements); provisioning failures are honest errors, never a
 * silent fallback to the system interpreter.
 *
 * Content-addressed result cache (default): successful results are cached
 * under sha256(env fingerprint + code + args), so an identical PY() call
 * reuses the exact result computed in the exact pinned environment.
 * Errors are never cached.
 *
 * Honest limits:
 * - This is a "restricted execution" sandbox, not a kernel sandbox. The
 *   Python object model remains reachable (e.g. `().__class__`), so a
 *   determined attacker may find an escape; without imports of `os`/`sys`/
 *   `subprocess` there is little ambient authority to reach, but do NOT
 *   treat this as isolation for truly hostile code.
 * - `datetime` is allowlisted, so `datetime.datetime.now()` technically
 *   exposes wall-clock time. `random` is NOT allowlisted.
 * - No network, no filesystem, no subprocess access by construction
 *   (no `open`, blocked imports).
 * - Memory cap is best-effort and Linux-only; elsewhere only the timeout
 *   applies.
 * - Requires a `python3` binary on PATH (to create the venv; the pinned
 *   runs then use the venv's own interpreter).
 */
import { execFileSync } from 'node:child_process';
import {
  PinnedPythonEnv,
  PythonResultCache,
  pythonCacheKey,
  sha256Hex,
} from '@icecream-sheets/service/python-env';

export interface SandboxOptions {
  /** Max wall-clock time for the child. Defaults to 2000ms. */
  timeoutMs?: number;
  /**
   * Use the pinned Python environment (default true): the run executes in
   * the content-addressed venv (pinned numpy/pandas/matplotlib) with the
   * extended import allowlist, and results go through the content-addressed
   * cache. When false, the system `python3` runs with the stdlib-only
   * allowlist and no caching.
   */
  pinned?: boolean;
  /**
   * Serve/store results in the content-addressed result cache (default
   * true; pinned runs only). Errors are never cached.
   */
  cache?: boolean;
}

export type SandboxResult = { value: unknown } | { error: string };

const DEFAULT_TIMEOUT_MS = 2000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/** Import allowlist for system-python runs: stdlib only. */
const STDLIB_MODULES = ['math', 'json', 're', 'itertools', 'functools', 'datetime', 'statistics'];

/**
 * Extra imports for pinned runs: the data-science stack (matching the
 * engine PY() prelude contract in extended-functions11.ts) plus io/base64
 * for in-memory buffers. pandas/numpy/matplotlib resolve from the pinned
 * venv, so versions are exactly the pinned ones.
 */
const PINNED_EXTRA_MODULES = ['pandas', 'numpy', 'matplotlib', 'io', 'base64'];

const PRELUDE_TEMPLATE = String.raw`
import sys as _sys, json as _json, builtins as _builtins
_real_import = _builtins.__import__

# Best-effort memory cap (Linux only).
try:
    import resource as _resource
    _resource.setrlimit(_resource.RLIMIT_AS, (__MEM_LIMIT__, __MEM_LIMIT__))
except Exception:
    pass

_ALLOWED_MODULES = frozenset(__ALLOWED_JSON__)

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
# NOTE: the underscore-prefixed names above must NOT be deleted: _safe_import
# (which user code can reach as __import__) closes over _ALLOWED_MODULES and
# _real_import, and the handlers below need _json. They live in the prelude's
# own module namespace, which user code cannot see: user code executes with
# _user_globals, containing only the safe builtins and args.
_user_code = _sys.stdin.read()
_args = _json.loads(_sys.argv[1])
_user_globals = {'__builtins__': _SAFE_BUILTINS_DICT, 'args': _args}
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
`;

function buildPrelude(modules: string[]): string {
  return PRELUDE_TEMPLATE.replace('__ALLOWED_JSON__', JSON.stringify(modules)).replace(
    '__MEM_LIMIT__',
    String(MEMORY_LIMIT_BYTES),
  );
}

const STDLIB_PRELUDE = buildPrelude(STDLIB_MODULES);
const PINNED_PRELUDE = buildPrelude([...STDLIB_MODULES, ...PINNED_EXTRA_MODULES]);

// ---------------------------------------------------------------------------
// Pinned environment (lazy singleton) + content-addressed result cache.
// ---------------------------------------------------------------------------

let pinnedEnv: PinnedPythonEnv | null = null;
let pinnedEnvError: string | null = null;

/**
 * Test seam: substitute the pinned environment (tests provision a scratch
 * venv with empty requirements so no network is needed). Pass null to
 * restore lazy provisioning.
 */
export function setPinnedEnvForTests(env: PinnedPythonEnv | null): void {
  pinnedEnv = env;
  pinnedEnvError = null;
}

/** The sandbox's content-addressed PY() result cache (module-lifetime). */
const resultCache = new PythonResultCache();

/** Read access to the sandbox result cache (tests / introspection). */
export function getPythonSandboxCache(): PythonResultCache {
  return resultCache;
}

/**
 * The pinned environment, provisioned on first use. Throws an honest error
 * when provisioning fails — callers must not silently fall back to the
 * system interpreter, which would break the "pinned" guarantee.
 */
export function ensurePinnedEnv(): PinnedPythonEnv {
  if (pinnedEnv) return pinnedEnv;
  if (pinnedEnvError) throw new Error(pinnedEnvError);
  try {
    const env = new PinnedPythonEnv();
    env.provision();
    pinnedEnv = env;
    return env;
  } catch (e) {
    pinnedEnvError =
      `pinned Python environment is not available: ${e instanceof Error ? e.message : String(e)}. ` +
      `Provision it (python3 -m venv + pip install of the pinned requirements) or run with { pinned: false }.`;
    throw new Error(pinnedEnvError);
  }
}

interface ChildEnvelope {
  __sandbox_value__?: unknown;
  __sandbox_error__?: string;
}

function isEnvelope(value: unknown): value is ChildEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('__sandbox_value__' in value || '__sandbox_error__' in value)
  );
}

export function runPython(
  code: string,
  args: Record<string, unknown>,
  opts: SandboxOptions = {},
): SandboxResult {
  if (typeof code !== 'string') {
    return { error: 'code must be a string' };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { error: 'timeoutMs must be a positive number' };
  }

  let argsJson: string;
  try {
    const roundTripped: unknown = JSON.parse(JSON.stringify(args));
    if (roundTripped === null || typeof roundTripped !== 'object' || Array.isArray(roundTripped)) {
      return { error: 'args must be a JSON object' };
    }
    argsJson = JSON.stringify(roundTripped);
  } catch {
    return { error: 'args must be JSON-serializable' };
  }

  const usePinned = opts.pinned !== false;
  const useCache = usePinned && opts.cache !== false;
  let prelude = STDLIB_PRELUDE;
  let interpreter = 'python3';
  let fingerprint: string | null = null;
  if (usePinned) {
    let env: PinnedPythonEnv;
    try {
      env = ensurePinnedEnv();
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    prelude = PINNED_PRELUDE;
    interpreter = env.venvPython();
    fingerprint = env.fingerprint();
  }

  const cacheKey = useCache && fingerprint ? pythonCacheKey(fingerprint, code, argsJson) : null;
  if (cacheKey) {
    const hit = resultCache.get(cacheKey);
    if (hit) return { value: hit.value };
  }

  let stdout: string;
  try {
    // encoding: 'utf8' makes execFileSync return a string directly.
    stdout = execFileSync(interpreter, ['-c', prelude, argsJson], {
      input: code,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      // Clean environment: no PYTHONPATH / PYTHONSTARTUP surprises.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    if (err.code === 'ETIMEDOUT') {
      return { error: `Python execution timed out after ${timeoutMs}ms` };
    }
    if (err.code === 'ENOENT') {
      return { error: `Python interpreter not found: ${interpreter}` };
    }
    const message = err.message !== undefined ? String(err.message) : String(e);
    return { error: `Python execution failed: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '');
  } catch {
    return { error: 'Python sandbox produced unreadable output' };
  }
  if (!isEnvelope(parsed)) {
    return { error: 'Python sandbox produced an unexpected result envelope' };
  }
  if (parsed.__sandbox_error__ !== undefined) {
    // Errors are never cached: a retry may succeed (e.g. after the env changes).
    return { error: parsed.__sandbox_error__ };
  }
  const result: SandboxResult = { value: parsed.__sandbox_value__ ?? null };
  if (cacheKey && fingerprint) {
    resultCache.set({
      key: cacheKey,
      value: result.value,
      envFingerprint: fingerprint,
      codeHash: sha256Hex(code),
      ranAt: new Date().toISOString(),
    });
  }
  return result;
}
