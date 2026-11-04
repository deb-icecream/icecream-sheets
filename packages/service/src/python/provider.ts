/**
 * Engine-compatible PythonProvider backed by a pinned environment and the
 * content-addressed result cache (browser-safe: the actual `run` function
 * is injected, so this module never touches node: APIs).
 */
import type { PythonProvider, PythonResult } from '@icecream-sheets/engine';
import { pythonCacheKey, PythonResultCache, sha256Hex } from './cache.js';

/** A pinned-environment run: executes code, carries its env fingerprint. */
export interface PinnedPythonRun {
  (code: string, args: unknown[]): PythonResult;
  /** Content-addressed identity of the environment (pythonEnvFingerprint). */
  fingerprint: string;
}

export interface PinnedPythonProviderOptions {
  /** Results larger than this (plot base64 chars) are not cached. Defaults to 256_000. */
  maxCachedPlotChars?: number;
}

/**
 * Build an engine PythonProvider (for setPythonProvider) that serves
 * results from the content-addressed cache and only executes on a miss.
 * Errors are never cached; oversized plots are executed but not cached.
 */
export function createPinnedPythonProvider(
  run: PinnedPythonRun,
  cache: PythonResultCache = new PythonResultCache(),
  opts: PinnedPythonProviderOptions = {},
): PythonProvider {
  const maxCachedPlotChars = opts.maxCachedPlotChars ?? 256_000;
  return {
    run(code: string, args: unknown[]): PythonResult {
      let argsJson: string;
      try {
        argsJson = JSON.stringify(args ?? []);
      } catch {
        return { error: 'PY arguments are not JSON-serializable.' };
      }
      const key = pythonCacheKey(run.fingerprint, code, argsJson);
      const hit = cache.get(key);
      if (hit) {
        const cached: PythonResult = { value: hit.value };
        if (typeof hit.plot === 'string') (cached as { plot?: string }).plot = hit.plot;
        return cached;
      }
      const result = run(code, args);
      if (!('error' in result)) {
        const plotChars = typeof result.plot === 'string' ? result.plot.length : 0;
        if (plotChars <= maxCachedPlotChars) {
          // set() updates the in-memory LRU synchronously; the encrypted
          // persistence write is best-effort and never rejects, so the
          // sync engine hot path does not await it.
          void cache.set({
            key,
            value: result.value,
            ...(typeof result.plot === 'string' ? { plot: result.plot } : {}),
            envFingerprint: run.fingerprint,
            codeHash: sha256Hex(code),
            ranAt: new Date().toISOString(),
          });
        }
      }
      return result;
    },
  };
}
