import { describe, expect, it } from 'vitest';
import {
  PIVOT_SPEC_VERSION,
  createPivot,
  describePivotBinding,
  isPivotChartFileBinding,
  pivotBindingFromFile,
  pivotBindingToFile,
  pivotResultToSeries,
  type PivotRecord,
  type PivotResult,
  type PivotSpec,
} from '../src/index.js';

const sales: PivotRecord[] = [
  { Region: 'East', Quarter: 'Q1', Sales: 100, Units: 10 },
  { Region: 'East', Quarter: 'Q2', Sales: 200, Units: 20 },
  { Region: 'West', Quarter: 'Q1', Sales: 150, Units: 15 },
  { Region: 'West', Quarter: 'Q2', Sales: 250, Units: 25 },
  { Region: 'East', Quarter: 'Q1', Sales: 50, Units: 5 },
];

const spec: PivotSpec = {
  version: PIVOT_SPEC_VERSION,
  rows: ['Region'],
  columns: ['Quarter'],
  values: [
    { field: 'Sales', aggregation: 'sum' },
    { field: 'Units', aggregation: 'sum' },
  ],
};

function result(): PivotResult {
  return createPivot(sales, spec);
}

describe('pivotResultToSeries', () => {
  it('maps row keys to labels and column keys to datasets (rowsAsLabels)', () => {
    const series = pivotResultToSeries(result(), 0);
    expect(series.labels).toEqual(['East', 'West']);
    expect(series.datasets.map((d) => d.label)).toEqual(['Q1', 'Q2']);
    // East/Q1 = 100+50, East/Q2 = 200, West/Q1 = 150, West/Q2 = 250.
    expect(series.datasets[0].data).toEqual([150, 150]);
    expect(series.datasets[1].data).toEqual([200, 250]);
  });

  it('selects the value field by valueIndex', () => {
    const series = pivotResultToSeries(result(), 1);
    // Units: East/Q1 = 10+5, East/Q2 = 20, West/Q1 = 15, West/Q2 = 25.
    expect(series.datasets[0].data).toEqual([15, 15]);
    expect(series.datasets[1].data).toEqual([20, 25]);
  });

  it('clamps an out-of-range valueIndex instead of throwing', () => {
    const r = result();
    expect(pivotResultToSeries(r, 99).datasets[0].data).toEqual(
      pivotResultToSeries(r, 1).datasets[0].data,
    );
    expect(pivotResultToSeries(r, -5).datasets[0].data).toEqual(
      pivotResultToSeries(r, 0).datasets[0].data,
    );
  });

  it('transposes with columnsAsLabels', () => {
    const series = pivotResultToSeries(result(), 0, 'columnsAsLabels');
    expect(series.labels).toEqual(['Q1', 'Q2']);
    expect(series.datasets.map((d) => d.label)).toEqual(['East', 'West']);
    expect(series.datasets[0].data).toEqual([150, 200]);
    expect(series.datasets[1].data).toEqual([150, 250]);
  });

  it('joins multi-field keys with " | "', () => {
    const multi = createPivot(sales, {
      version: PIVOT_SPEC_VERSION,
      rows: ['Region', 'Quarter'],
      columns: [],
      values: [{ field: 'Sales', aggregation: 'sum' }],
    });
    const series = pivotResultToSeries(multi, 0);
    expect(series.labels).toEqual(['East | Q1', 'East | Q2', 'West | Q1', 'West | Q2']);
  });

  it('re-derives from a refreshed result (no snapshot)', () => {
    const r1 = result();
    const before = pivotResultToSeries(r1, 0);
    expect(before.datasets[0].data).toEqual([150, 150]);
    const grown = [...sales, { Region: 'East', Quarter: 'Q1', Sales: 1000, Units: 1 }];
    const r2 = createPivot(grown, spec);
    const after = pivotResultToSeries(r2, 0);
    expect(after.datasets[0].data).toEqual([1150, 150]);
  });
});

describe('describePivotBinding', () => {
  it('names the bound value field', () => {
    const r = result();
    expect(describePivotBinding(r, { pivotId: 7, valueIndex: 0 })).toBe(
      'PivotChart of Sum of Sales',
    );
    expect(describePivotBinding(r, { pivotId: 7, valueIndex: 1 })).toBe(
      'PivotChart of Sum of Units',
    );
  });

  it('falls back for an unknown value index', () => {
    expect(describePivotBinding(result(), { pivotId: 7, valueIndex: 9 })).toBe(
      'PivotChart of Value 10',
    );
  });
});

describe('file-persistent pivot bindings', () => {
  it('converts a live binding to its name form', () => {
    expect(pivotBindingToFile({ pivotId: 7, valueIndex: 1 }, 'PivotTable1')).toEqual({
      pivotName: 'PivotTable1',
      valueIndex: 1,
    });
  });

  it('returns undefined without a binding or a pivot name', () => {
    expect(pivotBindingToFile(undefined, 'PivotTable1')).toBeUndefined();
    expect(pivotBindingToFile({ pivotId: 7, valueIndex: 0 }, undefined)).toBeUndefined();
    expect(pivotBindingToFile({ pivotId: 7, valueIndex: 0 }, '')).toBeUndefined();
  });

  it('resolves a stored binding back to a live id', () => {
    expect(
      pivotBindingFromFile({ pivotName: 'PivotTable1', valueIndex: 2 }, 42),
    ).toEqual({ pivotId: 42, valueIndex: 2 });
  });

  it('returns undefined when the pivot is gone or the shape is corrupt', () => {
    expect(pivotBindingFromFile({ pivotName: 'PivotTable1', valueIndex: 0 }, undefined)).toBeUndefined();
    expect(pivotBindingFromFile({ pivotName: 'X', valueIndex: 0 }, 1)).toEqual({
      pivotId: 1,
      valueIndex: 0,
    });
    expect(pivotBindingFromFile(null, 1)).toBeUndefined();
    expect(pivotBindingFromFile({ pivotName: '', valueIndex: 0 }, 1)).toBeUndefined();
    expect(pivotBindingFromFile({ pivotName: 'X', valueIndex: -1 }, 1)).toBeUndefined();
    expect(pivotBindingFromFile({ pivotName: 'X' }, 1)).toBeUndefined();
    expect(pivotBindingFromFile('nope', 1)).toBeUndefined();
  });

  it('round-trips through JSON (the .xlsx metadata channel)', () => {
    const stored = pivotBindingToFile({ pivotId: 7, valueIndex: 1 }, 'PivotTable1');
    const revived = JSON.parse(JSON.stringify(stored));
    expect(isPivotChartFileBinding(revived)).toBe(true);
    expect(pivotBindingFromFile(revived, 99)).toEqual({ pivotId: 99, valueIndex: 1 });
  });
});
