import { describe, expect, it } from 'vitest';
import { EngineWorkbook, scalar, type CellRef } from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

describe('Cross-sheet references', () => {
  it('resolves direct cross-sheet cell references at construction', () => {
    // Regression: the old constructor built only the first sheet via
    // buildFromSheets, so =Sheet2!A1 parsed before Sheet2 existed -> #REF!.
    const wb = new EngineWorkbook({
      Sheet1: [['=Sheet2!A1'], ['=Sheet2!A2']],
      Sheet2: [[42], [99]],
    });
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(42));
    expect(wb.getValue(c('Sheet1', 1, 0))).toEqual(scalar(99));
  });

  it('resolves quoted sheet names with spaces', () => {
    const rows: (number | string)[][] = [];
    for (let i = 0; i < 9; i++) rows.push([1, 2, 3, 4, 5, 6, 7, 8, 100 + i]);
    const wb = new EngineWorkbook({
      DASHBOARD: [["='INCOME STATEMENT'!I9"]],
      'INCOME STATEMENT': rows,
    });
    expect(wb.getValue(c('DASHBOARD', 0, 0))).toEqual(scalar(108));
  });

  it('resolves cross-sheet ranges', () => {
    const wb = new EngineWorkbook({
      Sheet1: [['=SUM(Sheet2!A1:A3)']],
      Sheet2: [[10], [20], [30]],
    });
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(60));
  });

  it('resolves cross-sheet refs added via setCell after construction', () => {
    const wb = new EngineWorkbook({ S1: [[1]], S2: [[2]] });
    wb.setCell(c('S1', 1, 0), '=S2!A1*10');
    expect(wb.getValue(c('S1', 1, 0))).toEqual(scalar(20));
  });
});
