/**
 * Tests for sparklines and slicers (track 14).
 */
import { describe, expect, it } from 'vitest';
import { renderSparkline, sparklineValues } from './sparklines';
import {
  toggleSlicerValue,
  clearSlicer,
  slicerPasses,
  distinctColumnValues,
  type SlicerSpec,
} from './slicers';

describe('renderSparkline', () => {
  it('renders empty svg for no data', () => {
    expect(renderSparkline('line', [], 60, 20)).toContain('<svg');
  });

  it('renders line polyline', () => {
    const svg = renderSparkline('line', [1, 5, 3], 60, 20);
    expect(svg).toContain('<polyline');
    expect(svg).toContain('stroke="#2563eb"');
  });

  it('marks min/max on line', () => {
    const svg = renderSparkline('line', [1, 5, 3], 60, 20);
    expect(svg).toContain('<circle');
  });

  it('renders column bars', () => {
    const svg = renderSparkline('column', [1, 5, 3], 60, 20);
    expect(svg).toContain('<rect');
    expect((svg.match(/<rect/g) || []).length).toBe(3);
  });

  it('renders winloss with center axis', () => {
    const svg = renderSparkline('winloss', [1, -1, 0], 60, 20);
    expect(svg).toContain('<line');
    expect(svg).toContain('#16a34a'); // win green
    expect(svg).toContain('#dc2626'); // loss red
  });

  it('handles single value', () => {
    const svg = renderSparkline('line', [5], 60, 20);
    expect(svg).toContain('<svg');
  });

  it('handles constant values (zero span)', () => {
    const svg = renderSparkline('column', [3, 3, 3], 60, 20);
    expect(svg).toContain('<rect');
  });
});

describe('sparklineValues', () => {
  const grid = [
    [1, 2, 3],
    [4, 5, 6],
  ];
  const read = (r: number, c: number) => grid[r]?.[c] ?? null;

  it('reads a row range', () => {
    expect(sparklineValues('A1:C1', read)).toEqual([1, 2, 3]);
  });

  it('reads a column range', () => {
    expect(sparklineValues('B1:B2', read)).toEqual([2, 5]);
  });

  it('returns [] for invalid range', () => {
    expect(sparklineValues('nope', read)).toEqual([]);
  });
});

function slicer(over: Partial<SlicerSpec> = {}): SlicerSpec {
  return { id: 1, col: 0, field: 'Region', selected: [], pivotIds: [], x: 0, y: 0, w: 160, ...over };
}

describe('slicers', () => {
  const all = ['East', 'West'];

  it('toggle deselects when all selected (Excel behavior)', () => {
    let s = slicer();
    s = toggleSlicerValue(s, 'East', all);
    expect(s.selected).toEqual(['West']); // East deselected
    s = toggleSlicerValue(s, 'East', all);
    expect(s.selected).toEqual([]); // back to all
  });

  it('selecting all collapses to empty (all)', () => {
    let s = slicer();
    s = toggleSlicerValue(s, 'East', all);
    s = toggleSlicerValue(s, 'West', all);
    expect(s.selected).toEqual([]);
  });

  it('clear resets', () => {
    const s = clearSlicer(slicer({ selected: ['East'] }));
    expect(s.selected).toEqual([]);
  });

  it('slicerPasses: empty = pass all', () => {
    expect(slicerPasses(slicer(), 'East')).toBe(true);
  });

  it('slicerPasses: filters', () => {
    const s = slicer({ selected: ['East'] });
    expect(slicerPasses(s, 'East')).toBe(true);
    expect(slicerPasses(s, 'West')).toBe(false);
  });

  it('distinctColumnValues dedupes and sorts', () => {
    const rows = ['West', 'East', 'West', ''];
    const vals = distinctColumnValues(0, 4, (r) => rows[r] ?? '');
    expect(vals).toEqual(['East', 'West']);
  });
});
