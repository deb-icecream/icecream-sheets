/**
 * Sheet structure operations through the engine protocol.
 *
 * Insert/delete row/column use the protocol's structural commands, which
 * wrap HyperFormula's structural operations — named ranges track cell
 * identity through these (design-docs/named-ranges-and-named-functions.md
 * §1). Manual cell-shifting would break identity tracking (HyperFormula
 * would never see the structural change), so it must not be used here.
 * Sort is read-sort-write on a column (a value permutation, not a
 * structural change). All reads go through the protocol view; all writes
 * through EngineHost.execute().
 */
import type { EngineHost } from '@icecream-sheets/engine';
import { cellRef, formatDisplay } from '../engine';

export interface CellSnapshot {
  row: number;
  col: number;
  value: string | number | boolean | null;
  formula?: string;
}

function snapshotCell(host: EngineHost, sheet: string, row: number, col: number): CellSnapshot {
  const cell = host.getView().readCell(cellRef(sheet, row, col));
  const v = cell.value;
  let value: string | number | boolean | null = null;
  if (v.kind === 'number' || v.kind === 'string' || v.kind === 'boolean') {
    value = v.value as string | number | boolean;
  }
  return { row, col, value, formula: cell.formula };
}

function writeCell(host: EngineHost, sheet: string, snap: CellSnapshot, row: number, col: number): void {
  const ref = cellRef(sheet, row, col);
  if (snap.formula !== undefined) {
    host.execute({ cmd: 'setFormula', ref, formula: snap.formula });
  } else {
    host.execute({ cmd: 'setCell', ref, value: snap.value });
  }
}

/** Insert `count` blank rows at `atRow`. Names track cell identity. */
export function insertRows(host: EngineHost, sheet: string, atRow: number, count = 1): void {
  const res = host.execute({ cmd: 'insertRows', sheet, row: atRow, count });
  if (!res.ok) throw new Error(res.error);
}

/** Delete `count` rows starting at `atRow`. Names track cell identity. */
export function deleteRows(host: EngineHost, sheet: string, atRow: number, count = 1): void {
  const res = host.execute({ cmd: 'deleteRows', sheet, row: atRow, count });
  if (!res.ok) throw new Error(res.error);
}

/** Insert `count` blank columns at `atCol`. Names track cell identity. */
export function insertCols(host: EngineHost, sheet: string, atCol: number, count = 1): void {
  const res = host.execute({ cmd: 'insertCols', sheet, col: atCol, count });
  if (!res.ok) throw new Error(res.error);
}

/** Delete `count` columns starting at `atCol`. Names track cell identity. */
export function deleteCols(host: EngineHost, sheet: string, atCol: number, count = 1): void {
  const res = host.execute({ cmd: 'deleteCols', sheet, col: atCol, count });
  if (!res.ok) throw new Error(res.error);
}

export type SortDir = 'asc' | 'desc';

function compareValues(a: string | number | boolean | null, b: string | number | boolean | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Sort rows of the used range by the values in `sortCol`.
 * Header row (row 0) is kept in place when `hasHeader` is true.
 */
export function sortByColumn(
  host: EngineHost,
  sheet: string,
  sortCol: number,
  dir: SortDir,
  hasHeader = true,
): void {
  const used = host.getView().usedRange(sheet);
  if (!used) return;
  const firstDataRow = hasHeader ? used.startRow + 1 : used.startRow;
  if (firstDataRow >= used.endRow) return;
  // Snapshot all rows.
  const rows: CellSnapshot[][] = [];
  for (let r = firstDataRow; r <= used.endRow; r++) {
    const row: CellSnapshot[] = [];
    for (let c = used.startCol; c <= used.endCol; c++) {
      row.push(snapshotCell(host, sheet, r, c));
    }
    rows.push(row);
  }
  const colIdx = sortCol - used.startCol;
  rows.sort((ra, rb) => {
    const cmp = compareValues(
      ra[colIdx]?.value ?? null,
      rb[colIdx]?.value ?? null,
    );
    return dir === 'asc' ? cmp : -cmp;
  });
  // Write back.
  rows.forEach((row, i) => {
    const r = firstDataRow + i;
    row.forEach((snap, j) => {
      writeCell(host, sheet, snap, r, used.startCol + j);
    });
  });
}

/** Read a column's distinct display values (for filter UI). */
export function columnValues(host: EngineHost, sheet: string, col: number): string[] {
  const used = host.getView().usedRange(sheet);
  if (!used) return [];
  const values = host.readRange({
    sheet,
    startRow: used.startRow,
    startCol: col,
    endRow: used.endRow,
    endCol: col,
  });
  const seen = new Set<string>();
  for (const row of values) {
    for (const v of row) seen.add(formatDisplay(v));
  }
  return [...seen].sort();
}
