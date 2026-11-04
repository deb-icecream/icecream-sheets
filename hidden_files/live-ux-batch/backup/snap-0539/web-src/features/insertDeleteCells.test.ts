/**
 * Unit tests for Insert Cells… / Delete Cells… with shift directions.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import { cellRef, formatDisplay } from '../engine';
import { deleteCells, insertCells, type CellBlock } from './insertDeleteCells';

function makeHost(): EngineHost {
  return new EngineHost();
}

function set(host: EngineHost, row: number, col: number, value: string | number | null): void {
  host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', row, col), value });
}

function text(host: EngineHost, row: number, col: number): string {
  return formatDisplay(host.getView().readCell(cellRef('Sheet1', row, col)).value);
}

function fillRow(host: EngineHost, row: number, values: (string | number)[]): void {
  values.forEach((v, c) => set(host, row, c, v));
}

describe('insertCells', () => {
  it('shifts cells right within the block rows', () => {
    const host = makeHost();
    fillRow(host, 0, ['a', 'b', 'c']);
    fillRow(host, 1, ['d', 'e', 'f']);
    const block: CellBlock = { startRow: 0, startCol: 1, endRow: 0, endCol: 1 };
    insertCells(host, 'Sheet1', block, 'right');
    expect(text(host, 0, 0)).toBe('a');
    expect(text(host, 0, 1)).toBe('');
    expect(text(host, 0, 2)).toBe('b');
    expect(text(host, 0, 3)).toBe('c');
    // Untouched row keeps its data.
    expect(text(host, 1, 1)).toBe('e');
    host.dispose();
  });

  it('shifts cells down within the block columns', () => {
    const host = makeHost();
    set(host, 0, 0, 'a');
    set(host, 1, 0, 'b');
    set(host, 0, 1, 'x');
    insertCells(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 'down');
    expect(text(host, 0, 0)).toBe('');
    expect(text(host, 1, 0)).toBe('a');
    expect(text(host, 2, 0)).toBe('b');
    expect(text(host, 0, 1)).toBe('x');
    host.dispose();
  });

  it('inserts whole rows for the rows direction', () => {
    const host = makeHost();
    fillRow(host, 0, ['a']);
    fillRow(host, 1, ['b']);
    insertCells(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 'rows');
    expect(text(host, 0, 0)).toBe('');
    expect(text(host, 1, 0)).toBe('a');
    expect(text(host, 2, 0)).toBe('b');
    host.dispose();
  });

  it('inserts whole columns for the cols direction', () => {
    const host = makeHost();
    fillRow(host, 0, ['a', 'b']);
    insertCells(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 'cols');
    expect(text(host, 0, 0)).toBe('');
    expect(text(host, 0, 1)).toBe('a');
    expect(text(host, 0, 2)).toBe('b');
    host.dispose();
  });

  it('preserves formulas when shifting', () => {
    const host = makeHost();
    set(host, 1, 0, 4); // A2, outside the shifted row
    host.execute({ cmd: 'setFormula', ref: cellRef('Sheet1', 0, 1), formula: '=A2*3' });
    insertCells(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 'right');
    expect(text(host, 0, 2)).toBe('12');
    host.dispose();
  });
});

describe('deleteCells', () => {
  it('shifts cells left to close the gap', () => {
    const host = makeHost();
    fillRow(host, 0, ['a', 'b', 'c', 'd']);
    deleteCells(host, 'Sheet1', { startRow: 0, startCol: 1, endRow: 0, endCol: 1 }, 'right');
    expect(text(host, 0, 0)).toBe('a');
    expect(text(host, 0, 1)).toBe('c');
    expect(text(host, 0, 2)).toBe('d');
    expect(text(host, 0, 3)).toBe('');
    host.dispose();
  });

  it('shifts cells up to close the gap', () => {
    const host = makeHost();
    set(host, 0, 0, 'a');
    set(host, 1, 0, 'b');
    set(host, 2, 0, 'c');
    deleteCells(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 'down');
    expect(text(host, 0, 0)).toBe('b');
    expect(text(host, 1, 0)).toBe('c');
    expect(text(host, 2, 0)).toBe('');
    host.dispose();
  });

  it('deletes whole rows for the rows direction', () => {
    const host = makeHost();
    fillRow(host, 0, ['a']);
    fillRow(host, 1, ['b']);
    fillRow(host, 2, ['c']);
    deleteCells(host, 'Sheet1', { startRow: 1, startCol: 0, endRow: 1, endCol: 0 }, 'rows');
    expect(text(host, 0, 0)).toBe('a');
    expect(text(host, 1, 0)).toBe('c');
    expect(text(host, 2, 0)).toBe('');
    host.dispose();
  });

  it('deletes whole columns for the cols direction', () => {
    const host = makeHost();
    fillRow(host, 0, ['a', 'b', 'c']);
    deleteCells(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 'cols');
    expect(text(host, 0, 0)).toBe('b');
    expect(text(host, 0, 1)).toBe('c');
    expect(text(host, 0, 2)).toBe('');
    host.dispose();
  });

  it('only affects the block rows when shifting left', () => {
    const host = makeHost();
    fillRow(host, 0, ['a', 'b']);
    fillRow(host, 1, ['x', 'y']);
    deleteCells(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 'right');
    expect(text(host, 0, 0)).toBe('b');
    expect(text(host, 1, 0)).toBe('x'); // other row untouched
    host.dispose();
  });
});
