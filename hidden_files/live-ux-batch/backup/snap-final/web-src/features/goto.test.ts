/**
 * Unit tests for Go To / Go To Special helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  currentRegion,
  findSpecialCells,
  parseGoToTarget,
  type CellKind,
  type GoToAccess,
} from './goto';
import type { NamedRangeDef } from '@icecream-sheets/service';

/** In-memory accessor over a string grid; '=...' marks formulas. */
function accessFromGrid(grid: (string | null)[][]): GoToAccess {
  const kindAt = (r: number, c: number): CellKind => {
    const v = grid[r]?.[c];
    if (v === null || v === undefined || v === '') return 'blank';
    return v.startsWith('=') ? 'formula' : 'constant';
  };
  return {
    getCellKind: kindAt,
    usedRange: () => ({ startRow: 0, startCol: 0, endRow: grid.length - 1, endCol: grid[0].length - 1 }),
  };
}

const NAMES: NamedRangeDef[] = [
  {
    id: 'nr:test',
    name: 'Sales',
    scope: { kind: 'workbook' },
    ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 9, endCol: 0 },
    createdBy: 'test',
    createdAt: '2026-10-18T00:00:00Z',
    updatedAt: '2026-10-18T00:00:00Z',
  },
];

describe('parseGoToTarget', () => {
  it('parses an A1 cell reference', () => {
    expect(parseGoToTarget('B5', NAMES)).toEqual({ startRow: 4, startCol: 1, endRow: 4, endCol: 1 });
  });

  it('parses an A1 range', () => {
    expect(parseGoToTarget('A1:C3', NAMES)).toEqual({ startRow: 0, startCol: 0, endRow: 2, endCol: 2 });
  });

  it('resolves a named range (case-insensitive)', () => {
    expect(parseGoToTarget('sales', NAMES)).toEqual({ startRow: 0, startCol: 0, endRow: 9, endCol: 0 });
  });

  it('returns null for garbage', () => {
    expect(parseGoToTarget('!!!', NAMES)).toBeNull();
    expect(parseGoToTarget('', NAMES)).toBeNull();
  });
});

describe('findSpecialCells', () => {
  const access = accessFromGrid([
    ['a', null, '=B1'],
    [null, 'b', null],
  ]);

  it('finds constants', () => {
    expect(findSpecialCells(access, 'constants')).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 1 },
    ]);
  });

  it('finds formulas', () => {
    expect(findSpecialCells(access, 'formulas')).toEqual([{ row: 0, col: 2 }]);
  });

  it('finds blanks', () => {
    expect(findSpecialCells(access, 'blanks')).toEqual([
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 2 },
    ]);
  });

  it('returns empty when there is no used range', () => {
    const empty: GoToAccess = { getCellKind: () => 'blank', usedRange: () => null };
    expect(findSpecialCells(empty, 'constants')).toEqual([]);
  });
});

describe('currentRegion', () => {
  it('finds the contiguous block around a cell', () => {
    const access = accessFromGrid([
      ['a', 'b', null, 'z'],
      ['c', 'd', null, 'y'],
      [null, null, null, null],
      ['q', null, null, null],
    ]);
    expect(currentRegion(access, 0, 0)).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(currentRegion(access, 0, 3)).toEqual({ startRow: 0, startCol: 3, endRow: 1, endCol: 3 });
    expect(currentRegion(access, 3, 0)).toEqual({ startRow: 3, startCol: 0, endRow: 3, endCol: 0 });
  });

  it('returns just the cell when blank', () => {
    const access = accessFromGrid([[null]]);
    expect(currentRegion(access, 0, 0)).toEqual({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
  });
});
