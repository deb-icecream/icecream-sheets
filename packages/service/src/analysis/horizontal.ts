/**
 * Horizontal-layout recognition for the data-analysis pipeline.
 *
 * The pipeline is column-oriented: headers come from the first row,
 * categories live in a column, measures live in columns. Some real sheets
 * lay the dimension out HORIZONTALLY instead — a row of years across
 * columns with one measure per row below it (the Income sheet's
 * "revenue by year" layout: row 6 holds 2012-2021, row 7 holds Revenue).
 * In that layout no column can serve as the "Year" group, so an aggregate
 * plan either mis-groups (first label column) or fails outright, and the
 * model reports "no Year column to group by" even though the years are
 * right there — in a row.
 *
 * This module detects that shape and transposes it into the column
 * orientation the pipeline already understands: the year run becomes
 * the dimension column (year values as STRINGS) and each measure row
 * below it becomes a numeric column named by its row label. NOTE: the
 * strings alone do NOT infer as categorical — inferColumnType counts
 * numeric strings as numeric — so the pipeline forces the dimension
 * column to categorical after extraction (analysis/schema.ts
 * forceTextColumn); without that, aggregate plans fail unless the
 * dimension name happens to match a hint exactly. The caller feeds the
 * transposed grid to schema extraction and to the script input in
 * place of the raw grid; detection is a pure function of the grid, so
 * rerun re-derives the same transposition from freshly-read data (no
 * schema or artifact change).
 *
 * Detection is deliberately strict so a vertical layout never changes:
 * the run must be >= 3 consecutive integers, each exactly +1 from the
 * previous, all in 1900-2100 (a real year sequence, not a coincidental
 * measure value); it must sit under a label (the cell above its start,
 * or a label in the row's first column); and at least one measure row
 * below it must carry a text label plus numerics under the run's columns.
 * Nothing is hardcoded to any file, sheet, or cell address.
 */

import type { CellInput } from '../appbuilder/model.js';

/** A detected horizontal dimension row plus its measure rows. */
export interface HorizontalYearLayout {
  /** 0-based row index of the year run. */
  dimensionRow: number;
  /** 0-based column index of the first year value. */
  runStart: number;
  /** 0-based column index of the last year value (inclusive). */
  runEnd: number;
  /** Name for the dimension column ('Year' when the cell above the run's start names it). */
  dimensionName: string;
  /** Measure rows below the dimension row, in sheet order. */
  measureRows: { row: number; label: string }[];
}

/** First year value a run may hold; last year value a run may hold. */
export const HORIZONTAL_YEAR_MIN = 1900;
export const HORIZONTAL_YEAR_MAX = 2100;
/** Minimum run length: a pair of years is not enough signal. */
export const HORIZONTAL_YEAR_MIN_RUN = 3;

function isTextLabel(v: CellInput | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Integer year value of a cell, or null (numbers and integer strings both count). */
function yearOf(v: CellInput | undefined): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) {
    return v >= HORIZONTAL_YEAR_MIN && v <= HORIZONTAL_YEAR_MAX ? v : null;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^-?\d+$/.test(t)) {
      const n = parseInt(t, 10);
      if (n >= HORIZONTAL_YEAR_MIN && n <= HORIZONTAL_YEAR_MAX) return n;
    }
  }
  return null;
}

/** Numeric value of a cell, or null (numbers and numeric strings both count). */
function numericOf(v: CellInput | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t !== '' && /^-?(\d+\.?\d*|\.\d+)$/.test(t)) {
      const n = parseFloat(t);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Detect a horizontal year layout in a grid, or null when the grid has
 * none. Scans rows top to bottom and returns the first qualifying row.
 */
export function detectHorizontalYearLayout(grid: CellInput[][]): HorizontalYearLayout | null {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!;
    // Find maximal runs of consecutive (+1) years in this row.
    let best: { start: number; end: number } | null = null;
    let runStart: number | null = null;
    let prevYear: number | null = null;
    for (let c = 0; c <= row.length; c++) {
      const y = c < row.length ? yearOf(row[c]) : null;
      if (y !== null && prevYear !== null && y === prevYear + 1) {
        // Run continues.
      } else {
        if (runStart !== null && prevYear !== null) {
          const end = c - 1;
          if (end - runStart + 1 >= HORIZONTAL_YEAR_MIN_RUN) {
            if (best === null || end - runStart > best.end - best.start) {
              best = { start: runStart, end };
            }
          }
        }
        runStart = y !== null ? c : null;
      }
      prevYear = y;
    }
    if (best === null) continue;
    const { start, end } = best;
    // The run must sit under a label: either the cell above its start
    // names the dimension ('Year'), or the row's first column labels it.
    const aboveLabel = r > 0 ? grid[r - 1]![start] : undefined;
    const rowLabel = row[0];
    if (!isTextLabel(aboveLabel) && !(start > 0 && isTextLabel(rowLabel))) continue;
    // At least one measure row below: text label in the first column
    // plus numerics under the run's columns.
    const measureRows: { row: number; label: string }[] = [];
    for (let m = r + 1; m < grid.length; m++) {
      const mrow = grid[m]!;
      const label = mrow[0];
      if (!isTextLabel(label)) continue;
      let hasNumeric = false;
      for (let c = start; c <= end; c++) {
        if (numericOf(mrow[c]) !== null) {
          hasNumeric = true;
          break;
        }
      }
      if (hasNumeric) measureRows.push({ row: m, label: label.trim() });
    }
    if (measureRows.length === 0) continue;
    return {
      dimensionRow: r,
      runStart: start,
      runEnd: end,
      dimensionName: isTextLabel(aboveLabel) ? aboveLabel.trim() : 'Category',
      measureRows,
    };
  }
  return null;
}

/**
 * Transpose a detected horizontal year layout into the pipeline's column
 * orientation: header row [dimensionName, ...measure labels], then one row
 * per year [year-as-string, ...measure values]. Duplicate measure labels
 * are suffixed (' (2)', ' (3)') so schema column names stay unique.
 * Returns null when the grid holds no horizontal year layout.
 */
export function transposeHorizontalYearGrid(grid: CellInput[][]): CellInput[][] | null {
  const layout = detectHorizontalYearLayout(grid);
  if (layout === null) return null;
  const usedLabels = new Map<string, number>();
  const uniqueLabel = (label: string): string => {
    const count = (usedLabels.get(label) ?? 0) + 1;
    usedLabels.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  };
  const header: CellInput[] = [layout.dimensionName];
  for (const m of layout.measureRows) header.push(uniqueLabel(m.label));
  const out: CellInput[][] = [header];
  for (let c = layout.runStart; c <= layout.runEnd; c++) {
    const year = yearOf(grid[layout.dimensionRow]![c]);
    if (year === null) continue;
    const row: CellInput[] = [String(year)];
    for (const m of layout.measureRows) {
      const v = numericOf(grid[m.row]![c]);
      row.push(v === null ? null : v);
    }
    out.push(row);
  }
  return out.length > 1 ? out : null;
}
