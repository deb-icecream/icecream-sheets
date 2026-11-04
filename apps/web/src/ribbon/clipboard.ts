/**
 * Pure helpers for the ribbon's clipboard and sheet-creation logic.
 * Headless and UI-free so they can be unit tested with node/vitest.
 */
import type { TypedCell } from '@icecream-sheets/engine';
import { formatDisplay } from '../engine';

/**
 * The text a cell contributes to the clipboard: its formula (with a leading
 * '=') when it has one, otherwise its display text. Pasting this text back
 * through parseEdit round-trips formulas and values.
 */
export function cellEditText(cell: TypedCell): string {
  if (cell.formula !== undefined) {
    return cell.formula.startsWith('=') ? cell.formula : `=${cell.formula}`;
  }
  return formatDisplay(cell.value);
}

/**
 * Reduce pasted clipboard text to a single cell's text: the first line's
 * first tab-separated field. Multi-cell pastes are a follow-up; v1 pastes
 * into the selected cell only.
 */
export function firstCellText(clipText: string): string {
  const line = clipText.split(/\r\n|\r|\n/, 1)[0] ?? '';
  return line.split('\t', 1)[0] ?? '';
}

/**
 * Next default sheet name: Sheet1, Sheet2, ... skipping names already taken.
 * Custom names are ignored; only the Sheet<N> pattern counts.
 */
export function nextSheetName(existing: string[]): string {
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`Sheet${n}`)) {
    n++;
  }
  return `Sheet${n}`;
}
