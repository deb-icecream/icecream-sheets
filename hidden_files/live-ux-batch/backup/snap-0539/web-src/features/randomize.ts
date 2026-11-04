/**
 * Randomize range (Data > Data Tools > Randomize Range).
 *
 * Shuffles the data rows of a range with Fisher-Yates, keeping the header
 * row (row 0 of the range) in place. Formulas travel with their cells via
 * the same snapshot/write path as sort (features/sheetOps.ts): a value
 * permutation, not a structural change.
 *
 * The RNG is injectable so tests are deterministic; the UI passes the
 * default Math.random-based RNG.
 */
import type { EngineHost } from '@icecream-sheets/engine';
import { cellRef } from '../engine';

export interface RandomizeRange {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface RandomizeCell {
  row: number;
  col: number;
  value: string | number | boolean | null;
  formula?: string;
}

export type RandomFn = () => number;

export const defaultRandom: RandomFn = () => Math.random();

/**
 * Fisher-Yates shuffle of row order. Pure: returns the permutation of
 * row indices (0-based into the input rows array).
 */
export function shuffledRowOrder(rowCount: number, rng: RandomFn = defaultRandom): number[] {
  const order = Array.from({ length: rowCount }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order;
}

/**
 * Read the range, shuffle its data rows (keeping the first row as the
 * header when `hasHeader` is true), and write the rows back. Returns the
 * number of data rows shuffled.
 */
export function randomizeRange(
  host: EngineHost,
  range: RandomizeRange,
  hasHeader = true,
  rng: RandomFn = defaultRandom,
): number {
  const { sheet, startRow, startCol, endRow, endCol } = range;
  const firstDataRow = hasHeader ? startRow + 1 : startRow;
  if (firstDataRow > endRow) return 0;
  const view = host.getView();
  const rows: RandomizeCell[][] = [];
  for (let r = firstDataRow; r <= endRow; r++) {
    const row: RandomizeCell[] = [];
    for (let c = startCol; c <= endCol; c++) {
      const cell = view.readCell(cellRef(sheet, r, c));
      const v = cell.value;
      let value: string | number | boolean | null = null;
      if (v.kind === 'number' || v.kind === 'string' || v.kind === 'boolean') {
        value = v.value as string | number | boolean;
      }
      row.push({ row: r, col: c, value, formula: cell.formula });
    }
    rows.push(row);
  }
  const order = shuffledRowOrder(rows.length, rng);
  order.forEach((srcIdx, destIdx) => {
    const src = rows[srcIdx]!;
    const destRow = firstDataRow + destIdx;
    src.forEach((snap, j) => {
      const ref = cellRef(sheet, destRow, startCol + j);
      if (snap.formula !== undefined) {
        host.execute({ cmd: 'setFormula', ref, formula: snap.formula });
      } else {
        host.execute({ cmd: 'setCell', ref, value: snap.value });
      }
    });
  });
  return rows.length;
}
