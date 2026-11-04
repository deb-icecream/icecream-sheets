/**
 * Unit tests for the recommendation engines.
 */
import { describe, expect, it } from 'vitest';
import {
  profileRange,
  recommendCharts,
  recommendPivots,
  type PivotSourceProfile,
} from './recommend';
import type { CellReader, ChartRange } from '@icecream-sheets/service';

function readerFrom(grid: unknown[][]): CellReader {
  return (row: number, col: number) => {
    const v = grid[row]?.[col];
    if (typeof v === 'number' && Number.isFinite(v)) return { text: String(v), num: v };
    if (typeof v === 'string') return { text: v, num: null };
    return { text: '', num: null };
  };
}

function rangeOf(grid: unknown[][]): ChartRange {
  return {
    sheet: 'Sheet1',
    startRow: 0,
    startCol: 0,
    endRow: grid.length - 1,
    endCol: Math.max(...grid.map((r) => r.length)) - 1,
  };
}

describe('profileRange', () => {
  it('detects a label column and one numeric column', () => {
    const grid = [['a', 1], ['b', 2], ['c', 3]];
    const p = profileRange(readerFrom(grid), rangeOf(grid));
    expect(p.labelCol).toBe(true);
    expect(p.numericCols).toEqual([1]);
    expect(p.rows).toBe(3);
  });

  it('detects two numeric columns without labels', () => {
    const grid = [[1, 2], [3, 4]];
    const p = profileRange(readerFrom(grid), rangeOf(grid));
    expect(p.labelCol).toBe(false);
    expect(p.numericCols).toEqual([0, 1]);
  });

  it('detects date-like labels', () => {
    const grid = [['2026-01-01', 1], ['2026-02-01', 2], ['2026-03-01', 3]];
    const p = profileRange(readerFrom(grid), rangeOf(grid));
    expect(p.dateLikeLabels).toBe(true);
  });
});

describe('recommendCharts', () => {
  it('suggests pie for a small category/value table', () => {
    const grid = [['a', 1], ['b', 2], ['c', 3]];
    const recs = recommendCharts(readerFrom(grid), rangeOf(grid));
    expect(recs).toHaveLength(3);
    expect(recs[0].kind).toBe('pie');
    expect(recs[0].reason).toMatch(/share/i);
  });

  it('suggests line for date-like labels', () => {
    const grid = [['2026-01-01', 1], ['2026-02-01', 2], ['2026-03-01', 3]];
    const recs = recommendCharts(readerFrom(grid), rangeOf(grid));
    expect(recs[0].kind).toBe('line');
  });

  it('suggests clustered columns for multiple numeric series', () => {
    const grid = [['a', 1, 4], ['b', 2, 5]];
    const recs = recommendCharts(readerFrom(grid), rangeOf(grid));
    expect(recs[0].kind).toBe('column-clustered');
  });

  it('suggests scatter for two numeric columns', () => {
    const grid = [[1, 2], [3, 4], [5, 6]];
    const recs = recommendCharts(readerFrom(grid), rangeOf(grid));
    expect(recs[0].kind).toBe('scatter');
  });

  it('never repeats a kind', () => {
    const grid = [['a', 1]];
    const recs = recommendCharts(readerFrom(grid), rangeOf(grid));
    const kinds = recs.map((r) => r.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe('recommendPivots', () => {
  const profile: PivotSourceProfile = {
    headers: ['Region', 'Product', 'Sales'],
    distinct: {
      Region: ['East', 'West'],
      Product: ['A', 'B', 'C'],
      Sales: ['10', '20'],
    },
    numericFields: ['Sales'],
    rowCount: 100,
  };

  it('proposes sum-by-row, cross-tab, and count', () => {
    const recs = recommendPivots(profile);
    expect(recs).toHaveLength(3);
    expect(recs[0].spec.rows).toEqual(['Region']);
    expect(recs[0].spec.values).toEqual([{ field: 'Sales', aggregation: 'sum' }]);
    expect(recs[1].spec.columns).toEqual(['Product']);
    expect(recs[2].spec.values).toEqual([{ field: 'Region', aggregation: 'count' }]);
  });

  it('falls back to a numeric summary without text fields', () => {
    const recs = recommendPivots({
      headers: ['Sales'],
      distinct: { Sales: ['1'] },
      numericFields: ['Sales'],
      rowCount: 10,
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].spec.values).toHaveLength(2);
  });

  it('returns nothing useful for an empty profile', () => {
    expect(recommendPivots({ headers: [], distinct: {}, numericFields: [], rowCount: 0 })).toEqual([]);
  });
});
