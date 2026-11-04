/**
 * Refresh swap planning — pure, headless, unit-testable.
 *
 * A connected sheet's data region is managed: refresh re-fetches the table
 * and atomically replaces the region. "Atomic" is achieved by computing the
 * full write/clear plan up front and applying it in one synchronous pass
 * (the host emits change events once the pass completes, so the UI renders
 * exactly one transition). Cells OUTSIDE the previously materialized region
 * are never touched — user notes/formulas beside the data survive refresh.
 *
 * The region is the rectangle [0, prevRows) x [0, prevCols) where prevRows
 * includes the header row. On first open prevRows/prevCols are 0 (nothing to
 * clear).
 */
import type { CellInput } from '@icecream-sheets/engine';
import type { TableData } from './table.js';

export interface CellWrite {
  row: number;
  col: number;
  value: CellInput;
}

export interface RefreshPlan {
  /** Cells to write (header row 0 + data rows). */
  writes: CellWrite[];
  /** Cells to clear (stale tail of a shrunk table). */
  clears: Array<{ row: number; col: number }>;
  /** New materialized dimensions, including the header row. */
  rowCount: number;
  colCount: number;
}

/**
 * Compute the swap plan for refreshing a connected sheet.
 *
 * @param prevRows previous materialized row count (incl. header), 0 on open
 * @param prevCols previous materialized column count, 0 on open
 * @param table freshly fetched table
 */
export function planSheetRefresh(prevRows: number, prevCols: number, table: TableData): RefreshPlan {
  const writes: CellWrite[] = [];
  const newRowCount = table.rows.length + 1; // header + data
  const newColCount = table.columns.length;
  table.columns.forEach((c, col) => writes.push({ row: 0, col, value: c }));
  table.rows.forEach((row, r) => {
    row.forEach((v, col) => writes.push({ row: r + 1, col, value: v }));
  });
  const clears: Array<{ row: number; col: number }> = [];
  // Clear stale cells: rows beyond the new table within the old region, and
  // columns beyond the new width within the old region.
  for (let r = 0; r < prevRows; r++) {
    for (let c = 0; c < prevCols; c++) {
      if (r >= newRowCount || c >= newColCount) clears.push({ row: r, col: c });
    }
  }
  return { writes, clears, rowCount: newRowCount, colCount: newColCount };
}
