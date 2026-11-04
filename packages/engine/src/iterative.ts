/**
 * Iterative calculation settings (track 22: formula-localization / calc options).
 *
 * Excel allows circular references to converge via iteration:
 * - Enable iterative calculation: on/off
 * - Maximum iterations: 1–32767 (default 100)
 * - Maximum change: convergence threshold (default 0.001)
 *
 * HyperFormula does not natively iterate circular refs; this module owns the
 * settings model so the UI (Calculation Options) can expose it and a future
 * solver can consume it. Settings persist in workbook metadata.
 */

export interface IterativeSettings {
  enabled: boolean;
  /** 1–32767, default 100. */
  maxIterations: number;
  /** Convergence threshold, default 0.001. */
  maxChange: number;
}

export const DEFAULT_ITERATIVE: IterativeSettings = {
  enabled: false,
  maxIterations: 100,
  maxChange: 0.001,
};

/** Validate and normalize iterative settings (clamps to Excel's limits). */
export function normalizeIterative(s: Partial<IterativeSettings>): IterativeSettings {
  const maxIterations =
    typeof s.maxIterations === 'number' && Number.isFinite(s.maxIterations)
      ? Math.min(32767, Math.max(1, Math.floor(s.maxIterations)))
      : DEFAULT_ITERATIVE.maxIterations;
  const maxChange =
    typeof s.maxChange === 'number' && Number.isFinite(s.maxChange) && s.maxChange > 0
      ? s.maxChange
      : DEFAULT_ITERATIVE.maxChange;
  return { enabled: s.enabled === true, maxIterations, maxChange };
}

/**
 * Run iterative evaluation of a circular formula.
 * Evaluates `evaluate` repeatedly until the change is below maxChange or
 * maxIterations is reached. Returns the converged value and iteration count.
 */
export function iterateUntilConverged(
  evaluate: () => number,
  settings: IterativeSettings,
): { value: number; iterations: number; converged: boolean } {
  let value = evaluate();
  for (let i = 1; i <= settings.maxIterations; i++) {
    const next = evaluate();
    if (Math.abs(next - value) <= settings.maxChange) {
      return { value: next, iterations: i, converged: true };
    }
    value = next;
  }
  return { value, iterations: settings.maxIterations, converged: false };
}
