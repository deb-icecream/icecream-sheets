/**
 * Tests for slicer state helpers (track 14): toggle / clear / filter
 * semantics and distinct-value collection.
 */
import { describe, expect, it } from 'vitest';
import {
  bindSlicerPivot,
  clearSlicer,
  distinctColumnValues,
  makeSlicerSpec,
  slicerValuesFromRangeRows,
  slicerPasses,
  toggleSlicerValue,
  unbindSlicerPivot,
  type SlicerSpec,
} from './slicers';

const spec = (selected: string[] = []): SlicerSpec => ({
  id: 1,
  col: 2,
  field: 'Region',
  selected,
  pivotIds: [],
  x: 0,
  y: 0,
  w: 200,
});

const ALL = ['East', 'West', 'North'];

describe('toggleSlicerValue', () => {
  it('selects a single value from the all-selected state', () => {
    // Toggling one value off "all" leaves everything else selected.
    const next = toggleSlicerValue(spec(), 'East', ALL);
    expect(next.selected.sort()).toEqual(['North', 'West']);
  });

  it('toggles a value back on', () => {
    const s1 = toggleSlicerValue(spec(), 'East', ALL);
    const s2 = toggleSlicerValue(s1, 'East', ALL);
    // Everything selected again collapses to "all".
    expect(s2.selected).toEqual([]);
  });

  it('collapses to all when every value ends up selected', () => {
    let s = spec(['East']);
    s = toggleSlicerValue(s, 'West', ALL);
    expect(s.selected.sort()).toEqual(['East', 'West']);
    s = toggleSlicerValue(s, 'North', ALL);
    expect(s.selected).toEqual([]);
  });

  it('does not mutate the input spec', () => {
    const s = spec();
    toggleSlicerValue(s, 'East', ALL);
    expect(s.selected).toEqual([]);
  });
});

describe('clearSlicer', () => {
  it('resets the selection to all', () => {
    expect(clearSlicer(spec(['East', 'West'])).selected).toEqual([]);
  });
});

describe('slicerPasses', () => {
  it('passes everything when nothing is selected (select all)', () => {
    expect(slicerPasses(spec(), 'East')).toBe(true);
    expect(slicerPasses(spec(), 'Anything')).toBe(true);
  });

  it('passes only selected values', () => {
    const s = spec(['East', 'North']);
    expect(slicerPasses(s, 'East')).toBe(true);
    expect(slicerPasses(s, 'North')).toBe(true);
    expect(slicerPasses(s, 'West')).toBe(false);
    expect(slicerPasses(s, '')).toBe(false);
  });
});

describe('distinctColumnValues', () => {
  it('collects distinct sorted values, skipping blanks', () => {
    const grid = [['West'], ['East'], [''], ['West'], ['North'], ['East']];
    const vals = distinctColumnValues(0, grid.length, (r, c) => grid[r][c] ?? '');
    expect(vals).toEqual(['East', 'North', 'West']);
  });

  it('returns empty for an empty column', () => {
    const vals = distinctColumnValues(0, 3, () => '');
    expect(vals).toEqual([]);
  });
});

describe('slicerValuesFromRangeRows', () => {
  it('collects distinct sorted values from a single-column range read, skipping blanks', () => {
    const vals = slicerValuesFromRangeRows(
      [['West'], ['East'], [''], ['West'], ['North'], ['East']],
      (v) => v,
    );
    expect(vals).toEqual(['East', 'North', 'West']);
  });

  it('returns empty for an empty column read', () => {
    const vals = slicerValuesFromRangeRows([[''], ['']], (v) => v);
    expect(vals).toEqual([]);
  });
});

describe('slicer → pivot binding', () => {
  it('binds and unbinds pivots idempotently', () => {
    let s = spec();
    expect(s.pivotIds).toEqual([]);
    s = bindSlicerPivot(s, 7);
    s = bindSlicerPivot(s, 9);
    s = bindSlicerPivot(s, 7);
    expect(s.pivotIds).toEqual([7, 9]);
    s = unbindSlicerPivot(s, 7);
    expect(s.pivotIds).toEqual([9]);
    s = unbindSlicerPivot(s, 42);
    expect(s.pivotIds).toEqual([9]);
  });

  it('makeSlicerSpec defaults pivotIds to []', () => {
    const s = makeSlicerSpec({ id: 2, col: 0, field: 'Q', selected: [], x: 0, y: 0, w: 100 });
    expect(s.pivotIds).toEqual([]);
  });

  it('selection helpers preserve bindings', () => {
    const s = bindSlicerPivot(spec(), 7);
    const toggled = toggleSlicerValue(s, 'East', ALL);
    expect(toggled.pivotIds).toEqual([7]);
    expect(clearSlicer(toggled).pivotIds).toEqual([7]);
  });
});
