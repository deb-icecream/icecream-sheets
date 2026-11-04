/**
 * Unit tests for cell operations: row/column hide-unhide, filter clearing,
 * and AutoSum helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  hideRow,
  unhideRow,
  hideCol,
  unhideCol,
  sortFilterClear,
  autosumFormula,
  suggestAutosumRange,
} from './cellOps';
import type { FilterState } from './models';

describe('hideRow / unhideRow', () => {
  it('adds a row to the hidden set', () => {
    expect(hideRow(new Set(), 3)).toEqual(new Set([3]));
  });

  it('does not mutate the input set', () => {
    const hidden = new Set([1]);
    const next = hideRow(hidden, 3);
    expect(hidden).toEqual(new Set([1]));
    expect(next).toEqual(new Set([1, 3]));
  });

  it('hiding an already-hidden row is idempotent', () => {
    expect(hideRow(new Set([3]), 3)).toEqual(new Set([3]));
  });

  it('unhideRow removes the row', () => {
    expect(unhideRow(new Set([1, 3]), 3)).toEqual(new Set([1]));
  });

  it('unhideRow on a visible row leaves the set unchanged', () => {
    expect(unhideRow(new Set([1]), 3)).toEqual(new Set([1]));
  });
});

describe('hideCol / unhideCol', () => {
  it('adds a column to the hidden set', () => {
    expect(hideCol(new Set(), 2)).toEqual(new Set([2]));
  });

  it('does not mutate the input set', () => {
    const hidden = new Set([0]);
    const next = hideCol(hidden, 2);
    expect(hidden).toEqual(new Set([0]));
    expect(next).toEqual(new Set([0, 2]));
  });

  it('unhideCol removes the column', () => {
    expect(unhideCol(new Set([0, 2]), 0)).toEqual(new Set([2]));
  });

  it('unhideCol on a visible column leaves the set unchanged', () => {
    expect(unhideCol(new Set(), 5)).toEqual(new Set());
  });
});

describe('sortFilterClear', () => {
  it('returns an empty filter state', () => {
    const filters: FilterState = new Map([[0, new Set(['a', 'b'])]]);
    expect(sortFilterClear(filters).size).toBe(0);
  });

  it('does not mutate the original filters', () => {
    const filters: FilterState = new Map([[0, new Set(['a'])]]);
    sortFilterClear(filters);
    expect(filters.size).toBe(1);
  });
});

describe('autosumFormula', () => {
  it('builds a SUM formula', () => {
    expect(autosumFormula('SUM', 'A1:A5')).toBe('=SUM(A1:A5)');
  });

  it('builds an AVERAGE formula', () => {
    expect(autosumFormula('AVERAGE', 'B2:B10')).toBe('=AVERAGE(B2:B10)');
  });

  it('works with a single-cell reference', () => {
    expect(autosumFormula('MAX', 'C7')).toBe('=MAX(C7)');
  });
});

describe('suggestAutosumRange', () => {
  const used = { startRow: 0, endRow: 3, startCol: 0, endCol: 1 };

  it('picks the column above the selection', () => {
    expect(suggestAutosumRange(used, 4, 0)).toBe('A1:A4');
  });

  it('clamps the column range to used rows when data extends below', () => {
    expect(suggestAutosumRange({ ...used, endRow: 9 }, 4, 1)).toBe('B1:B4');
  });

  it('picks the row left of the selection when there is no data above', () => {
    expect(suggestAutosumRange(used, 2, 3)).toBe('A3:B3');
  });

  it('prefers the column above over the row left', () => {
    expect(suggestAutosumRange(used, 5, 1)).toBe('B1:B4');
  });

  it('falls back to the selected cell when the used range is null', () => {
    expect(suggestAutosumRange(null, 4, 0)).toBe('A5');
  });

  it('falls back to the selected cell when the selection is above all data', () => {
    expect(suggestAutosumRange({ startRow: 2, endRow: 3, startCol: 0, endCol: 1 }, 0, 0)).toBe('A1');
  });

  it('falls back to the selected cell when selection is inside the used range only', () => {
    expect(suggestAutosumRange({ startRow: 2, endRow: 2, startCol: 2, endCol: 2 }, 2, 2)).toBe('C3');
  });

  it('uses multi-letter column labels', () => {
    expect(
      suggestAutosumRange({ startRow: 0, endRow: 3, startCol: 26, endCol: 26 }, 4, 26),
    ).toBe('AA1:AA4');
  });
});
