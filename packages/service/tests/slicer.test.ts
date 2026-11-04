import { describe, expect, it } from 'vitest';
import {
  SLICER_BINDING_VERSION,
  applySlicersToPivotSpec,
  bindingsForPivot,
  bindSlicerToPivot,
  boundPivotIds,
  createPivot,
  filterRecordsBySlicers,
  makeSlicerPivotBinding,
  recordsFromGrid,
  removeSlicerFiltersFromSpec,
  slicerBindingLabelOf,
  slicerSelectionPasses,
  unbindSlicerFromPivot,
  validateSlicerPivotBinding,
  type PivotRecord,
  type PivotSpec,
  type SlicerPivotBinding,
} from '../src/index.js';

const sales: PivotRecord[] = [
  { Region: 'East', Quarter: 'Q1', Sales: 100 },
  { Region: 'East', Quarter: 'Q2', Sales: 200 },
  { Region: 'West', Quarter: 'Q1', Sales: 150 },
  { Region: 'West', Quarter: 'Q2', Sales: 250 },
  { Region: 'East', Quarter: 'Q1', Sales: 50 },
];

const baseSpec: PivotSpec = {
  version: 1,
  rows: ['Region'],
  columns: ['Quarter'],
  values: [{ field: 'Sales', aggregation: 'sum' }],
};

describe('slicer → pivot binding model', () => {
  it('makes a versioned binding with a generated id', () => {
    const b = makeSlicerPivotBinding({ slicerId: 's1', field: 'Region' });
    expect(b.version).toBe(SLICER_BINDING_VERSION);
    expect(b.slicerId).toBe('s1');
    expect(b.field).toBe('Region');
    expect(b.pivotIds).toEqual([]);
    expect(validateSlicerPivotBinding(b)).toEqual([]);
  });

  it('binds and unbinds pivots idempotently', () => {
    let b = makeSlicerPivotBinding({ slicerId: 's1', field: 'Region' });
    b = bindSlicerToPivot(b, 'p1');
    b = bindSlicerToPivot(b, 'p2');
    b = bindSlicerToPivot(b, 'p1');
    expect(boundPivotIds(b)).toEqual(['p1', 'p2']);
    b = unbindSlicerFromPivot(b, 'p1');
    expect(boundPivotIds(b)).toEqual(['p2']);
    b = unbindSlicerFromPivot(b, 'p9');
    expect(boundPivotIds(b)).toEqual(['p2']);
  });

  it('validates bindings structurally', () => {
    const bad = { ...makeSlicerPivotBinding({ slicerId: 's1', field: 'Region' }), field: ' ' };
    expect(validateSlicerPivotBinding(bad).length).toBeGreaterThan(0);
    const dup: SlicerPivotBinding = {
      ...makeSlicerPivotBinding({ slicerId: 's1', field: 'Region' }),
      pivotIds: ['p1', 'p1'],
    };
    expect(validateSlicerPivotBinding(dup).join(' ')).toMatch(/duplicates/);
  });

  it('finds bindings driving a pivot', () => {
    const a = bindSlicerToPivot(makeSlicerPivotBinding({ slicerId: 's1', field: 'Region' }), 'p1');
    const b = bindSlicerToPivot(makeSlicerPivotBinding({ slicerId: 's2', field: 'Quarter' }), 'p2');
    expect(bindingsForPivot([a, b], 'p1').map((x) => x.slicerId)).toEqual(['s1']);
    expect(bindingsForPivot([a, b], 'p2').map((x) => x.slicerId)).toEqual(['s2']);
    expect(bindingsForPivot([a, b], 'p3')).toEqual([]);
  });
});

describe('applySlicersToPivotSpec', () => {
  it('merges a slicer selection as a pivot filter without mutating the spec', () => {
    const merged = applySlicersToPivotSpec(baseSpec, [{ field: 'Region', selected: ['East'] }]);
    expect(baseSpec.filters).toBeUndefined();
    expect(merged.filters).toEqual([{ field: 'Region', selected: ['East'] }]);
    const result = createPivot(sales, merged);
    expect(result.filteredRowCount).toBe(3);
    expect(result.grandTotals).toEqual([350]);
  });

  it('an empty selection contributes no filter (select all)', () => {
    const merged = applySlicersToPivotSpec(baseSpec, [{ field: 'Region', selected: [] }]);
    expect(merged.filters).toBeUndefined();
    expect(createPivot(sales, merged).filteredRowCount).toBe(5);
  });

  it('a slicer replaces the existing filter on the same field and preserves others', () => {
    const spec: PivotSpec = {
      ...baseSpec,
      filters: [
        { field: 'Region', selected: ['West'] },
        { field: 'Quarter', selected: ['Q1'] },
      ],
    };
    const merged = applySlicersToPivotSpec(spec, [{ field: 'Region', selected: ['East', 'West'] }]);
    expect(merged.filters).toEqual([
      { field: 'Quarter', selected: ['Q1'] },
      { field: 'Region', selected: ['East', 'West'] },
    ]);
  });

  it('multiple slicers compose', () => {
    const merged = applySlicersToPivotSpec(baseSpec, [
      { field: 'Region', selected: ['East'] },
      { field: 'Quarter', selected: ['Q1'] },
    ]);
    const result = createPivot(sales, merged);
    expect(result.filteredRowCount).toBe(2);
    expect(result.grandTotals).toEqual([150]);
  });

  it('removeSlicerFiltersFromSpec drops only that field', () => {
    const spec: PivotSpec = {
      ...baseSpec,
      filters: [
        { field: 'Region', selected: ['East'] },
        { field: 'Quarter', selected: ['Q1'] },
      ],
    };
    expect(removeSlicerFiltersFromSpec(spec, 'Region').filters).toEqual([{ field: 'Quarter', selected: ['Q1'] }]);
  });
});

describe('slicer selection helpers', () => {
  it('slicerSelectionPasses treats empty as select-all', () => {
    expect(slicerSelectionPasses([], 'East')).toBe(true);
    expect(slicerSelectionPasses(['East'], 'East')).toBe(true);
    expect(slicerSelectionPasses(['East'], 'West')).toBe(false);
  });

  it('slicerBindingLabelOf follows the pivot label convention', () => {
    expect(slicerBindingLabelOf(null)).toBe('(blank)');
    expect(slicerBindingLabelOf('')).toBe('(blank)');
    expect(slicerBindingLabelOf(true)).toBe('TRUE');
    expect(slicerBindingLabelOf(false)).toBe('FALSE');
    expect(slicerBindingLabelOf(42)).toBe('42');
  });

  it('filterRecordsBySlicers pre-filters records', () => {
    const out = filterRecordsBySlicers(sales, [{ field: 'Region', selected: ['West'] }]);
    expect(out).toHaveLength(2);
    expect(filterRecordsBySlicers(sales, [{ field: 'Region', selected: [] }])).toHaveLength(5);
  });

  it('end to end: recordsFromGrid → slicer-filtered pivot', () => {
    const grid = [
      ['Region', 'Sales'],
      ['East', 100],
      ['West', 200],
      ['East', 300],
    ];
    const records = recordsFromGrid(['Region', 'Sales'], grid.slice(1));
    const spec = applySlicersToPivotSpec(
      { version: 1, rows: ['Region'], columns: [], values: [{ field: 'Sales', aggregation: 'sum' }] },
      [{ field: 'Region', selected: ['East'] }],
    );
    const result = createPivot(records, spec);
    expect(result.grandTotals).toEqual([400]);
  });
});
