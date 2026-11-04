/**
 * Parallel-recalculation pool sizing for the desktop shell (track 13).
 *
 * The desktop's main-process EngineHost runs explicit recalcs through the
 * engine's worker pool (node:worker_threads via the engine's
 * NodeWorkerBackend) instead of the single-threaded serial path. This
 * module resolves the pool size; it is deliberately pure (no Electron
 * imports) so it can be unit-tested.
 *
 * Configuration: ICECREAM_PARALLEL_WORKERS overrides the default. There is
 * no desktop settings store yet — platform-shell.md §4 says settings belong
 * in the user profile, so when one appears this default should become a
 * per-user preference and this constant its fallback.
 */
import * as os from 'node:os';
import { resolveParallelCellThreshold } from '@icecream-sheets/engine';

/**
 * The MT cell-count threshold for the desktop shell (Cycle 10 Phase 3):
 * the ONE FLAG's cell-count side (shouldEnableParallelRecalc) on the
 * main-process engine. Canonical env var ICECREAM_MT_CELL_COUNT_THRESHOLD
 * (shared with the web routing layer's hybridRecalcConfigFromEnv — one
 * threshold, one name); ICECREAM_PARALLEL_CELL_THRESHOLD is honored as a
 * legacy alias inside the engine's resolver. Desktop has no settings
 * store yet (platform-shell.md §4); when one appears, the settings field
 * wins under the env override the same way the web seam does.
 */
export function resolveDesktopMtThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveParallelCellThreshold(env);
}

/**
 * Resolve the parallel-recalculation worker count.
 *
 * Default: logical CPUs minus one (one core left for the UI / main thread),
 * minimum 1. The engine clamps the effective count to the partition count
 * anyway, and normalizeParallelOptions() caps it at MAX_WORKERS (64), so an
 * oversized value is harmless.
 *
 * @param env process.env (injectable for tests)
 */
export function resolveParallelWorkerCount(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['ICECREAM_PARALLEL_WORKERS'];
  if (raw !== undefined && raw !== '') {
    const n = Math.floor(Number(raw));
    if (Number.isInteger(n) && n >= 1) return n;
    // Malformed override: ignore it and fall through to the default rather
    // than disabling parallelism by accident.
  }
  return Math.max(1, logicalCpuCount() - 1);
}

/** Logical CPU count, defensively resolved (minimum 1). */
export function logicalCpuCount(): number {
  try {
    // availableParallelism() exists on Node 16+ (and Electron's Node).
    const n = os.availableParallelism();
    if (Number.isInteger(n) && n >= 1) return n;
    const cpus = os.cpus();
    if (Array.isArray(cpus) && cpus.length >= 1) return cpus.length;
  } catch {
    // fall through
  }
  return 1;
}
