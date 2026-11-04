/**
 * Synchronous JavaScript sandbox for Icecream Sheets (Phase 3).
 *
 * Security model (honest version):
 * - Runs user code in a fresh `node:vm` context per call. The ONLY host data
 *   crossing the boundary is the `args` payload, which is serialized through
 *   JSON *inside* the guest (never as a host object reference), so guest code
 *   cannot reach host intrinsics via constructor chains like
 *   `args.constructor.constructor`.
 * - The guest global exposes `args` (frozen), bare bindings for each
 *   identifier-safe arg key (e.g. `arg1`), plus the guest realm's own `Math`
 *   and `JSON` intrinsics. It does NOT expose `require`, `module`, `process`,
 *   `Buffer`, `setTimeout`/`setInterval`, `fetch`, `URL`, `TextEncoder`,
 *   `queueMicrotask`, or any I/O. `console` is shadowed to `undefined`
 *   (Node >=22 vm contexts otherwise include one).
 * - CPU is bounded by the `vm` timeout option (default 2000ms); infinite
 *   loops terminate with a timeout error instead of hanging the sheet.
 * - `node:vm` is NOT a hard security boundary (the Node.js docs say so
 *   explicitly): a sufficiently motivated attacker with a vm-escape gadget
 *   could break out. Treat this sandbox as protection against accidental
 *   misuse and casual probing, NOT as isolation for hostile code. Never run
 *   untrusted code with ambient authority; the MCP server itself runs with
 *   the invoking user's privileges.
 *
 * Result contract: the script's completion value is the result, e.g.
 * `runJavaScript("arg1 * 2", { arg1: 21 })` -> `{ value: 42 }`.
 * `undefined` completion values are normalized to `null`.
 * Reserved top-level names: `args`, `console`, and every arg key (arg keys
 * that are not valid identifiers, or that collide with reserved names, are
 * reachable only through `args[...]`).
 */
import vm from 'node:vm';

export interface SandboxOptions {
  /** Max CPU time for the script. Defaults to 2000ms. */
  timeoutMs?: number;
}

export type SandboxResult = { value: unknown } | { error: string };

const DEFAULT_TIMEOUT_MS = 2000;

/** Identifier-safe, so `const <key> = ...` is syntactically valid. */
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Names the prelude reserves; colliding arg keys stay reachable via `args`. */
const RESERVED = new Set([
  'args',
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
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'decodeURI',
  'encodeURI',
  'decodeURIComponent',
  'encodeURIComponent',
]);

/**
 * Guest-side prelude, inlined as source so the host never shares object
 * references with the guest.
 *
 * Two subtleties handled here:
 * 1. V8 script completion carries the last expression-statement value through
 *    trailing declarations, so a value-producing prelude would leak into the
 *    "completion value is the result" contract. The prelude therefore ends
 *    with `void 0;`, making it value-neutral.
 * 2. `const` bindings are emitted for identifier-safe arg keys (computed on
 *    the host, where the keys are known), so formula code can write `arg1`
 *    instead of `args["arg1"]`.
 */
function guestSource(argsJson: string, keys: string[]): string {
  const bindings = keys
    .filter((k) => SAFE_KEY.test(k) && !RESERVED.has(k))
    .map((k) => `const ${k} = args[${JSON.stringify(k)}];`)
    .join('\n');
  return `'use strict';
const console = undefined;
const args = JSON.parse(${JSON.stringify(argsJson)});
(function deepFreeze(v) {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) { deepFreeze(v[k]); }
    Object.freeze(v);
  }
  return v;
})(args);
${bindings}
void 0;`;
}

export function runJavaScript(
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

  // Round-trip through JSON on the host: rejects non-serializable args
  // (functions, BigInt, undefined, ...) up front instead of silently
  // dropping them, and gives us the concrete key list for bindings.
  let argsJson: string;
  let keys: string[];
  try {
    const roundTripped: unknown = JSON.parse(JSON.stringify(args));
    if (roundTripped === null || typeof roundTripped !== 'object' || Array.isArray(roundTripped)) {
      return { error: 'args must be a JSON object' };
    }
    argsJson = JSON.stringify(roundTripped);
    keys = Object.keys(roundTripped as Record<string, unknown>);
  } catch {
    return { error: 'args must be JSON-serializable' };
  }

  const source = `${guestSource(argsJson, keys)}\n${code}`;

  try {
    const context = vm.createContext(Object.create(null));
    const value: unknown = vm.runInContext(source, context, { timeout: timeoutMs });
    return { value: value === undefined ? null : value };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: message };
  }
}
