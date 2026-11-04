/**
 * Insert Cells… / Delete Cells… (Home > Cells, shift-direction variants).
 *
 * The engine protocol has no shift-cell command, so these are implemented
 * as read-shift-write sequences through EngineHost.execute(), following the
 * same pattern as sheetOps.ts (insertRows/deleteRows). All reads go through
 * the protocol view; all writes through execute().
 */
import type { EngineHost } from '@icecream-sheets/engine';
import { cellRef } from '../engine';

export type CellShiftDirection = 'right' | 'down' | 'rows' | 'cols';

export interface CellBlock {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

interface CellSnapshot {
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

function clearCell(host: EngineHost, sheet: string, row: number, col: number): void {
  host.execute({ cmd: 'setCell', ref: cellRef(sheet, row, col), value: null });
}

function usedEnd(host: EngineHost, sheet: string): { endRow: number; endCol: number } {
  const used = host.getView().usedRange(sheet);
  return { endRow: used ? used.endRow : -1, endCol: used ? used.endCol : -1 };
}

/**
 * Insert blank cells over `block`, shifting existing cells:
 * - 'right': cells in each block row shift right by the block width
 * - 'down': cells in each block column shift down by the block height
 * - 'rows': whole rows inserted (like Insert Sheet Rows)
 * - 'cols': whole columns inserted (like Insert Sheet Columns)
 */
export function insertCells(host: EngineHost, sheet: string, block: CellBlock, dir: CellShiftDirection): void {
  const { endRow, endCol } = usedEnd(host, sheet);

  if (dir === 'rows' || dir === 'cols') {
    const count = dir === 'rows' ? block.endRow - block.startRow + 1 : block.endCol - block.startCol + 1;
    if (dir === 'rows') {
      if (endRow < block.startRow) return;
      for (let r = endRow; r >= block.startRow; r--) {
        for (let c = 0; c <= endCol; c++) {
          writeCell(host, sheet, snapshotCell(host, sheet, r, c), r + count, c);
        }
      }
      for (let r = block.startRow; r < block.startRow + count; r++) {
        for (let c = 0; c <= endCol; c++) clearCell(host, sheet, r, c);
      }
    } else {
      if (endCol < block.startCol) return;
      for (let c = endCol; c >= block.startCol; c--) {
        for (let r = 0; r <= endRow; r++) {
          writeCell(host, sheet, snapshotCell(host, sheet, r, c), r, c + count);
        }
      }
      for (let c = block.startCol; c < block.startCol + count; c++) {
        for (let r = 0; r <= endRow; r++) clearCell(host, sheet, r, c);
      }
    }
    return;
  }

  if (dir === 'right') {
    const width = block.endCol - block.startCol + 1;
    for (let r = block.startRow; r <= block.endRow; r++) {
      for (let c = endCol; c >= block.startCol; c--) {
        writeCell(host, sheet, snapshotCell(host, sheet, r, c), r, c + width);
      }
      for (let c = block.startCol; c <= block.endCol; c++) clearCell(host, sheet, r, c);
    }
    return;
  }

  // 'down'
  const height = block.endRow - block.startRow + 1;
  for (let c = block.startCol; c <= block.endCol; c++) {
    for (let r = endRow; r >= block.startRow; r--) {
      writeCell(host, sheet, snapshotCell(host, sheet, r, c), r + height, c);
    }
    for (let r = block.startRow; r <= block.endRow; r++) clearCell(host, sheet, r, c);
  }
}

/**
 * Delete the cells in `block`, shifting remaining cells to close the gap:
 * - 'right' (Excel "Shift cells left"): cells right of the block shift left
 * - 'down' (Excel "Shift cells up"): cells below the block shift up
 * - 'rows': whole rows deleted
 * - 'cols': whole columns deleted
 */
export function deleteCells(host: EngineHost, sheet: string, block: CellBlock, dir: CellShiftDirection): void {
  const { endRow, endCol } = usedEnd(host, sheet);

  if (dir === 'rows' || dir === 'cols') {
    const count = dir === 'rows' ? block.endRow - block.startRow + 1 : block.endCol - block.startCol + 1;
    if (dir === 'rows') {
      if (endRow < block.startRow) return;
      for (let r = block.startRow + count; r <= endRow; r++) {
        for (let c = 0; c <= endCol; c++) {
          writeCell(host, sheet, snapshotCell(host, sheet, r, c), r - count, c);
        }
      }
      for (let r = Math.max(block.startRow, endRow - count + 1); r <= endRow; r++) {
        for (let c = 0; c <= endCol; c++) clearCell(host, sheet, r, c);
      }
    } else {
      if (endCol < block.startCol) return;
      for (let c = block.startCol + count; c <= endCol; c++) {
        for (let r = 0; r <= endRow; r++) {
          writeCell(host, sheet, snapshotCell(host, sheet, r, c), r, c - count);
        }
      }
      for (let c = Math.max(block.startCol, endCol - count + 1); c <= endCol; c++) {
        for (let r = 0; r <= endRow; r++) clearCell(host, sheet, r, c);
      }
    }
    return;
  }

  if (dir === 'right') {
    // Shift cells left: for each block row, pull cells from the right.
    const width = block.endCol - block.startCol + 1;
    for (let r = block.startRow; r <= block.endRow; r++) {
      for (let c = block.startCol; c <= endCol; c++) {
        const src = c + width;
        if (src <= endCol) {
          writeCell(host, sheet, snapshotCell(host, sheet, r, src), r, c);
        } else {
          clearCell(host, sheet, r, c);
        }
      }
    }
    return;
  }

  // 'down' -> shift cells up.
  const height = block.endRow - block.startRow + 1;
  for (let c = block.startCol; c <= block.endCol; c++) {
    for (let r = block.startRow; r <= endRow; r++) {
      const src = r + height;
      if (src <= endRow) {
        writeCell(host, sheet, snapshotCell(host, sheet, src, c), r, c);
      } else {
        clearCell(host, sheet, r, c);
      }
    }
  }
}
