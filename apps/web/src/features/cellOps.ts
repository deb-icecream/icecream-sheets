/**
 * Cell operations for the web UI: row/column hide-unhide, filter clearing,
 * and AutoSum range guessing.
 *
 * Pure logic: every function returns new state rather than mutating its
 * input. Actual cell writes go through the engine host; this module only
 * computes the UI-level values needed for those commands.
 */
import type { FilterState } from './models';
import { a1Short, colLabel } from '../engine';

// ---------------------------------------------------------------------------
// Hide / unhide rows and columns
// ---------------------------------------------------------------------------

/** Mark a row hidden. Returns a new set; the input is unchanged. */
export function hideRow(hidden: Set<number>, row: number): Set<number> {
  const next = new Set(hidden);
  next.add(row);
  return next;
}

/** Mark a row visible again. Returns a new set; the input is unchanged. */
export function unhideRow(hidden: Set<number>, row: number): Set<number> {
  const next = new Set(hidden);
  next.delete(row);
  return next;
}

/** Mark a column hidden. Returns a new set; the input is unchanged. */
export function hideCol(hidden: Set<number>, col: number): Set<number> {
  const next = new Set(hidden);
  next.add(col);
  return next;
}

/** Mark a column visible again. Returns a new set; the input is unchanged. */
export function unhideCol(hidden: Set<number>, col: number): Set<number> {
  const next = new Set(hidden);
  next.delete(col);
  return next;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Clear all column filters (returns an empty filter state). */
export function sortFilterClear(_filters: FilterState): FilterState {
  return new Map();
}

// ---------------------------------------------------------------------------
// AutoSum
// ---------------------------------------------------------------------------

/** Build an AutoSum formula, e.g. autosumFormula('SUM', 'A1:A5') -> '=SUM(A1:A5)'. */
export function autosumFormula(fn: string, rangeRef: string): string {
  return `=${fn}(${rangeRef})`;
}

/** Bounding box of used cells (0-based indices, inclusive), or null when the sheet is empty. */
export interface UsedRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

/**
 * Guess the range an AutoSum should cover, returned as an A1-style ref
 * string such as 'A1:A4'. Prefers the column directly above the selection
 * (when the selection sits below used data in the same column); otherwise
 * the row directly left of the selection. Falls back to the selected cell
 * itself when there is no used data to extend from.
 */
export function suggestAutosumRange(
  usedRange: UsedRange | null,
  selRow: number,
  selCol: number,
): string {
  if (usedRange) {
    // Column above the selection.
    if (
      selCol >= usedRange.startCol &&
      selCol <= usedRange.endCol &&
      selRow > usedRange.startRow
    ) {
      const top = usedRange.startRow;
      const bottom = Math.min(selRow - 1, usedRange.endRow);
      if (bottom >= top) {
        return `${colLabel(selCol)}${top + 1}:${colLabel(selCol)}${bottom + 1}`;
      }
    }
    // Row left of the selection.
    if (
      selRow >= usedRange.startRow &&
      selRow <= usedRange.endRow &&
      selCol > usedRange.startCol
    ) {
      const left = usedRange.startCol;
      const right = Math.min(selCol - 1, usedRange.endCol);
      if (right >= left) {
        return `${colLabel(left)}${selRow + 1}:${colLabel(right)}${selRow + 1}`;
      }
    }
  }
  return a1Short(selRow, selCol);
}
