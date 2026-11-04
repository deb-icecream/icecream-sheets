/**
 * In-browser automation script runner (browser-safe).
 *
 * Runs TypeScript/JavaScript automation scripts (hand-written or migrated
 * by translator.ts) directly in the page for the Extensions > Apps Script
 * editor. The script is type-stripped (tsStrip.ts), then executed via the
 * AsyncFunction constructor with a locked-down scope:
 *
 * - `api`: the permissioned AutomationApi bound to `automation:<name>`.
 *   EVERY host call re-authorizes — the script cannot exceed the grants
 *   the user gave its principal.
 * - `console`: captured into the run report (log/warn/error/info/debug).
 * - `event`: the frozen trigger/event object (optional).
 * - Globals: JSON, Math, Object, Array, String, Number, Boolean, Date,
 *   RegExp, Error, Map, Set, WeakMap, Promise, isNaN, isFinite,
 *   parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
 *   TextEncoder, TextDecoder, URL, URLSearchParams, Intl, structuredClone.
 * - Shadowed (undefined): window, document, localStorage, sessionStorage,
 *   fetch, XMLHttpRequest, WebSocket, Worker, importScripts, process,
 *   require, module, exports, define, eval, Function, navigator, location,
 *   history, indexedDB, caches, Notification, customElements, crypto.
 *
 * Honest limits (same as automation/sandbox.ts): this is protection
 * against accidental misuse and casual probing, NOT hard isolation for
 * hostile code — a page-context script is as powerful as the browser
 * console. Do not run hostile scripts. The trust model is: the script is
 * the user's own code, acting with the user's own authority through
 * authorize(). A synchronous infinite loop cannot be preempted in the
 * page (no vm timeout); the timeout only bounds async completion.
 */
import { AutomationApi } from './api.js';
import { stripTypeAnnotations, TypeStripError } from './tsStrip.js';

export interface UserScriptRunOptions {
  /** Script name: the run principal is `automation:<name>`. Defaults to 'script'. */
  name?: string;
  /** Frozen event object visible as `event` (triggers). Defaults to null. */
  event?: unknown;
  /** Bounds async completion. Defaults to 5000ms. Sync hangs cannot be preempted. */
  timeoutMs?: number;
}

export type UserScriptResult =
  | { ok: true; value: unknown; logs: unknown[][]; notifications: string[]; durationMs: number }
  | { ok: false; error: string; logs: unknown[][]; notifications: string[]; durationMs: number };

const SAFE_GLOBALS: Record<string, unknown> = {
  JSON,
  Math,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Date,
  RegExp,
  Error,
  Map,
  Set,
  WeakMap,
  Promise,
  isNaN,
  isFinite,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  Intl,
  structuredClone,
};

const SHADOWED = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'importScripts',
  'process',
  'require',
  'module',
  'exports',
  'define',
  'eval',
  'Function',
  'navigator',
  'location',
  'history',
  'indexedDB',
  'caches',
  'Notification',
  'customElements',
  'crypto',
  'globalThis',
];

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {
  /* */
}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

/**
 * Run a user script against an AutomationApi. The script must define
 * `main(api)` (the translator emits `export function main(api)`; the
 * export keyword is stripped). Returns the completion value, captured
 * console output and api.notify() messages.
 */
export async function runUserScript(
  api: AutomationApi,
  source: string,
  opts: UserScriptRunOptions = {},
): Promise<UserScriptResult> {
  const started = Date.now();
  const logs: unknown[][] = [];
  const timeoutMs = opts.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      ok: false,
      error: 'timeoutMs must be a positive number',
      logs,
      notifications: [],
      durationMs: 0,
    };
  }

  let js: string;
  try {
    js = stripTypeAnnotations(source);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof TypeStripError ? e.message : `type-strip failed: ${String(e)}`,
      logs,
      notifications: [],
      durationMs: Date.now() - started,
    };
  }

  const capturedConsole = {
    log: (...a: unknown[]): void => void logs.push(['log', ...a]),
    warn: (...a: unknown[]): void => void logs.push(['warn', ...a]),
    error: (...a: unknown[]): void => void logs.push(['error', ...a]),
    info: (...a: unknown[]): void => void logs.push(['info', ...a]),
    debug: (...a: unknown[]): void => void logs.push(['debug', ...a]),
  };

  let eventJson: string;
  try {
    eventJson = JSON.stringify(opts.event ?? null);
  } catch {
    return { ok: false, error: 'event must be JSON-serializable', logs, notifications: [], durationMs: Date.now() - started };
  }

  const paramNames = ['api', 'console', 'event', ...Object.keys(SAFE_GLOBALS), ...SHADOWED];
  const paramValues = [
    api,
    capturedConsole,
    JSON.parse(eventJson),
    ...Object.values(SAFE_GLOBALS),
    ...SHADOWED.map(() => undefined),
  ];

  let fn: (...fnArgs: unknown[]) => Promise<unknown>;
  try {
    // NOTE: no 'use strict' here — strict mode forbids parameters named
    // `eval`/`Function`, and this sandbox shadows dangerous globals via
    // parameters. The trust model is unchanged (see module docstring):
    // the script is the user's own code.
    fn = new AsyncFunctionCtor(
      ...paramNames,
      `${js}\n;return (typeof main === 'function') ? main : null;`,
    );
  } catch (e) {
    return {
      ok: false,
      error: `script does not compile: ${e instanceof Error ? e.message : String(e)}`,
      logs,
      notifications: [],
      durationMs: Date.now() - started,
    };
  }

  try {
    const main = await fn(...paramValues);
    if (typeof main !== 'function') {
      return {
        ok: false,
        error: "script must define a function named 'main(api)'",
        logs,
        notifications: api.getNotifications(),
        durationMs: Date.now() - started,
      };
    }
    const value = await Promise.race([
      (main as (a: AutomationApi) => unknown)(api),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`script timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return {
      ok: true,
      value: value === undefined ? null : value,
      logs,
      notifications: api.getNotifications(),
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      logs,
      notifications: api.getNotifications(),
      durationMs: Date.now() - started,
    };
  }
}
