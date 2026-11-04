/**
 * Volatile function recalculation policy.
 *
 * Volatile functions (NOW, TODAY, RAND, RANDBETWEEN, OFFSET, INDIRECT, CELL,
 * INFO) recalculate on EVERY recalculation cycle, not just when their
 * precedents change. This matches Excel's behavior.
 *
 * Policy:
 * - Automatic mode: volatile functions recalculate on any cell change.
 * - Manual mode: volatile functions recalculate only on explicit recalculate.
 * - RAND()/RANDBETWEEN() also recalculate on sheet open (fresh randoms).
 *
 * HyperFormula marks these as volatile internally; this module documents the
 * policy and provides the host-facing recalculateVolatile() helper.
 */

/** Function names treated as volatile (case-insensitive). */
export const VOLATILE_FUNCTIONS = new Set([
  'NOW',
  'TODAY',
  'RAND',
  'RANDBETWEEN',
  'RANDARRAY',
  'OFFSET',
  'INDIRECT',
  'CELL',
  'INFO',
]);

/** True if the formula text contains a volatile function call. */
export function isVolatileFormula(formula: string): boolean {
  const upper = formula.toUpperCase();
  for (const fn of VOLATILE_FUNCTIONS) {
    // Match FN( with word boundary to avoid SUBSTRING false positives.
    const re = new RegExp(`\\b${fn}\\s*\\(`, '');
    if (re.test(upper)) return true;
  }
  return false;
}

/** Recalculation modes. */
export type CalcMode = 'automatic' | 'manual';

/**
 * Decide whether volatile cells need recalculation.
 * - automatic: always recalculate on any change.
 * - manual: only on explicit recalculate() call.
 */
export function shouldRecalcVolatile(mode: CalcMode, explicit: boolean): boolean {
  return mode === 'automatic' || explicit;
}
