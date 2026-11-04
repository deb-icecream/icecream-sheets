/**
 * Increase / Decrease Decimal Places (Home > Number group).
 *
 * Pure functions over CellFormat: they adjust the fixed `decimals` count
 * and, when the current number format has no decimal places to adjust
 * (e.g. General), promote it to Number — matching Excel's behavior where
 * "Increase Decimal" converts General to a numeric format.
 *
 * Rendering: the grid should pass the decimals through, e.g.
 *   formatNumber(value, fmt.numberFormat, fmt.decimals ?? 2)
 */
import type { CellFormat, NumberFormat } from './formatting';

/** Formats whose display carries adjustable decimal places. */
const DECIMAL_FORMATS: NumberFormat[] = ['Number', 'Currency', 'Accounting', 'Percentage', 'Scientific'];

export const MAX_DECIMALS = 30;

/** Default decimals Excel shows for a format when the user never set one. */
export function defaultDecimalsFor(fmt: NumberFormat | undefined): number {
  return fmt !== undefined && (DECIMAL_FORMATS as (NumberFormat | undefined)[]).includes(fmt) ? 2 : 0;
}

/** Effective decimal count for a format (explicit field, else the default). */
export function currentDecimals(format: CellFormat | undefined): number {
  if (typeof format?.decimals === 'number') {
    return Math.min(MAX_DECIMALS, Math.max(0, Math.floor(format.decimals)));
  }
  return defaultDecimalsFor(format?.numberFormat);
}

function withDecimals(format: CellFormat | undefined, decimals: number): CellFormat {
  const next: CellFormat = { ...(format ?? {}) };
  const clamped = Math.min(MAX_DECIMALS, Math.max(0, decimals));
  next.decimals = clamped;
  if (!(DECIMAL_FORMATS as (NumberFormat | undefined)[]).includes(next.numberFormat)) {
    // Excel promotes General/Text to Number when decimals are introduced.
    next.numberFormat = 'Number';
  }
  return next;
}

/**
 * Increase Decimal: one more decimal place (max 30). Promotes General to
 * Number, like Excel.
 */
export function increaseDecimals(format: CellFormat | undefined): CellFormat {
  return withDecimals(format, currentDecimals(format) + 1);
}

/**
 * Decrease Decimal: one fewer decimal place (min 0). Keeps the format
 * category; a Number format at 0 decimals still shows thousands separators.
 */
export function decreaseDecimals(format: CellFormat | undefined): CellFormat {
  return withDecimals(format, currentDecimals(format) - 1);
}

/** True when the Increase Decimal button should be enabled for this format. */
export function canIncreaseDecimals(format: CellFormat | undefined): boolean {
  return currentDecimals(format) < MAX_DECIMALS;
}

/** True when the Decrease Decimal button should be enabled for this format. */
export function canDecreaseDecimals(format: CellFormat | undefined): boolean {
  return currentDecimals(format) > 0;
}
