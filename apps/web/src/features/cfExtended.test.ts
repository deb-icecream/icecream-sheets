import { describe, expect, it } from 'vitest';
import {
  makeExtCFRule,
  topNMatches,
  dataBarWidth,
  colorScaleColor,
  iconFor,
  collectNumericValues,
  cfRangeMinMax,
  isVisualCFKind,
  type ExtCFRule,
} from './cfExtended';

const base = {
  sheet: 'Sheet1',
  startRow: 0,
  startCol: 0,
  endRow: 4,
  endCol: 0,
};

function topN(overrides: Partial<ExtCFRule> = {}): ExtCFRule {
  return makeExtCFRule({ ...base, kind: 'topN', ...overrides });
}

// ---------------------------------------------------------------------------
// makeExtCFRule
// ---------------------------------------------------------------------------

describe('makeExtCFRule', () => {
  it('assigns auto-incremented ids', () => {
    const a = topN();
    const b = topN();
    expect(b.id).toBe(a.id + 1);
  });
});

// ---------------------------------------------------------------------------
// topNMatches
// ---------------------------------------------------------------------------

describe('topNMatches', () => {
  it('marks the top n values', () => {
    const r = topN({ topBottom: 'top', n: 3 });
    expect(topNMatches([1, 2, 3, 4, 5], r)).toEqual([false, false, true, true, true]);
  });

  it('marks the bottom n values', () => {
    const r = topN({ topBottom: 'bottom', n: 2 });
    expect(topNMatches([5, 1, 4, 2, 3], r)).toEqual([false, true, false, true, false]);
  });

  it('defaults to top 10 when topBottom/n are unset', () => {
    const r = topN();
    const values = Array.from({ length: 12 }, (_, i) => i + 1);
    const got = topNMatches(values, r);
    expect(got.filter(Boolean).length).toBe(10);
    expect(got[0]).toBe(false);
    expect(got[1]).toBe(false);
    expect(got[11]).toBe(true);
  });

  it('includes ties at the cutoff', () => {
    const r = topN({ topBottom: 'top', n: 2 });
    // Two-way tie for 2nd place: all three top values rank within top 2.
    expect(topNMatches([5, 5, 5, 1], r)).toEqual([true, true, true, false]);
  });

  it('bottom N includes ties at the cutoff', () => {
    const r = topN({ topBottom: 'bottom', n: 2 });
    expect(topNMatches([9, 1, 1, 1], r)).toEqual([false, true, true, true]);
  });

  it('aboveAverage marks values strictly greater than the mean', () => {
    const r = topN({ aboveAverage: true });
    // mean of [1,2,3,4,10] = 4
    expect(topNMatches([1, 2, 3, 4, 10], r)).toEqual([false, false, false, false, true]);
  });

  it('aboveAverage excludes values equal to the mean', () => {
    const r = topN({ aboveAverage: true });
    // mean of [2,4,6] = 4
    expect(topNMatches([2, 4, 6], r)).toEqual([false, false, true]);
  });

  it('ignores non-finite values', () => {
    const r = topN({ topBottom: 'top', n: 1 });
    expect(topNMatches([NaN, 5, Infinity, -Infinity], r)).toEqual([false, true, false, false]);
  });

  it('returns all false for an empty input', () => {
    expect(topNMatches([], topN())).toEqual([]);
  });

  it('clamps n to at least 1', () => {
    const r = topN({ topBottom: 'top', n: 0 });
    expect(topNMatches([3, 7], r)).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// dataBarWidth
// ---------------------------------------------------------------------------

describe('dataBarWidth', () => {
  it('returns 0 at the min', () => {
    expect(dataBarWidth(0, 0, 100)).toBe(0);
  });

  it('returns 100 at the max', () => {
    expect(dataBarWidth(100, 0, 100)).toBe(100);
  });

  it('returns 50 at the midpoint', () => {
    expect(dataBarWidth(50, 0, 100)).toBe(50);
  });

  it('clamps values below min to 0 and above max to 100', () => {
    expect(dataBarWidth(-10, 0, 100)).toBe(0);
    expect(dataBarWidth(250, 0, 100)).toBe(100);
  });

  it('handles negative ranges', () => {
    expect(dataBarWidth(-50, -100, 0)).toBe(50);
  });

  it('returns 100 for a degenerate range (max <= min)', () => {
    expect(dataBarWidth(5, 5, 5)).toBe(100);
    expect(dataBarWidth(5, 10, 5)).toBe(100);
  });

  it('returns 0 for non-finite inputs', () => {
    expect(dataBarWidth(NaN, 0, 100)).toBe(0);
    expect(dataBarWidth(5, 0, NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// colorScaleColor
// ---------------------------------------------------------------------------

describe('colorScaleColor', () => {
  const LOW = '#000000';
  const HIGH = '#ffffff';

  it('returns the low color at the min', () => {
    expect(colorScaleColor(0, 0, 100, LOW, HIGH)).toBe('#000000');
  });

  it('returns the high color at the max', () => {
    expect(colorScaleColor(100, 0, 100, LOW, HIGH)).toBe('#ffffff');
  });

  it('interpolates the midpoint', () => {
    expect(colorScaleColor(50, 0, 100, LOW, HIGH)).toBe('#808080');
  });

  it('interpolates a red-to-green scale at 25%', () => {
    // 25% between #ff0000 and #00ff00 -> #bf4000
    expect(colorScaleColor(25, 0, 100, '#ff0000', '#00ff00')).toBe('#bf4000');
  });

  it('clamps out-of-range values', () => {
    expect(colorScaleColor(-5, 0, 100, LOW, HIGH)).toBe('#000000');
    expect(colorScaleColor(500, 0, 100, LOW, HIGH)).toBe('#ffffff');
  });

  it('accepts 3-digit hex colors', () => {
    expect(colorScaleColor(0, 0, 100, '#000', '#fff')).toBe('#000000');
    expect(colorScaleColor(100, 0, 100, '#000', '#fff')).toBe('#ffffff');
  });

  it('falls back to lowColor when a color is unparseable', () => {
    expect(colorScaleColor(50, 0, 100, 'not-a-color', HIGH)).toBe('not-a-color');
    expect(colorScaleColor(50, 0, 100, LOW, 'zzz')).toBe(LOW);
  });

  it('uses t=0 for a degenerate range', () => {
    expect(colorScaleColor(7, 5, 5, '#ff0000', '#00ff00')).toBe('#ff0000');
  });
});

// ---------------------------------------------------------------------------
// iconFor
// ---------------------------------------------------------------------------

describe('iconFor', () => {
  it('returns up in the top third', () => {
    expect(iconFor(90, 0, 100)).toBe('up');
    expect(iconFor(100, 0, 100)).toBe('up');
  });

  it('returns down in the bottom third', () => {
    expect(iconFor(10, 0, 100)).toBe('down');
    expect(iconFor(0, 0, 100)).toBe('down');
  });

  it('returns flat in the middle third', () => {
    expect(iconFor(50, 0, 100)).toBe('flat');
  });

  it('returns flat for a degenerate range', () => {
    expect(iconFor(5, 5, 5)).toBe('flat');
  });

  it('returns flat for non-finite inputs', () => {
    expect(iconFor(NaN, 0, 100)).toBe('flat');
  });
});

// ---------------------------------------------------------------------------
// collectNumericValues / cfRangeMinMax / isVisualCFKind
// ---------------------------------------------------------------------------

describe('collectNumericValues', () => {
  it('collects finite numbers in row-major order, skipping nulls', () => {
    const grid = new Map<string, number | null>([
      ['0,0', 5],
      ['0,1', null],
      ['1,0', 3],
      ['1,1', 7],
    ]);
    const rule = makeExtCFRule({ ...base, endRow: 1, endCol: 1, kind: 'dataBar' });
    const got = collectNumericValues((r, c) => grid.get(`${r},${c}`) ?? null, rule);
    expect(got).toEqual([5, 3, 7]);
  });
});

describe('cfRangeMinMax', () => {
  it('returns [min, max] over the range', () => {
    const rule = makeExtCFRule({ ...base, endRow: 0, endCol: 2, kind: 'colorScale' });
    const values = [40, 10, 90];
    const got = cfRangeMinMax((r, c) => values[c], rule);
    expect(got).toEqual([10, 90]);
  });

  it('returns null when there are no numeric values', () => {
    const rule = makeExtCFRule({ ...base, kind: 'colorScale' });
    expect(cfRangeMinMax(() => null, rule)).toBeNull();
  });
});

describe('isVisualCFKind', () => {
  it('classifies visual vs boolean kinds', () => {
    expect(isVisualCFKind('dataBar')).toBe(true);
    expect(isVisualCFKind('colorScale')).toBe(true);
    expect(isVisualCFKind('iconSet')).toBe(true);
    expect(isVisualCFKind('cell')).toBe(false);
    expect(isVisualCFKind('topN')).toBe(false);
  });
});
