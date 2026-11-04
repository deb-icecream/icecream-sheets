import { describe, expect, it } from 'vitest';
import {
  PIVOT_AGGREGATIONS,
  PIVOT_SPEC_VERSION,
  createPivot,
  getPivotValue,
  pivotToMatrix,
  recordsFromGrid,
  refreshPivot,
  type PivotRecord,
  type PivotSpec,
} from '../src/index.js';

const sales: PivotRecord[] = [
  { Region: 'East', Quarter: 'Q1', Sales: 100, Units: 10, Rep: 'Amy' },
  { Region: 'East', Quarter: 'Q2', Sales: 200, Units: 20, Rep: 'Amy' },
  { Region: 'West', Quarter: 'Q1', Sales: 150, Units: 15, Rep: 'Bob' },
  { Region: 'West', Quarter: 'Q2', Sales: 250, Units: 25, Rep: 'Bob' },
  { Region: 'East', Quarter: 'Q1', Sales: 50, Units: 5, Rep: 'Cat' },
];

const sumSalesSpec: PivotSpec = {
  version: PIVOT_SPEC_VERSION,
  rows: ['Region'],
  columns: ['Quarter'],
  values: [{ field: 'Sales', aggregation: 'sum' }],
};

describe('pivot spec validation', () => {
  it('rejects a spec with no value fields', () => {
    expect(() =>
      createPivot(sales, { version: PIVOT_SPEC_VERSION, rows: ['Region'], columns: [], values: [] }),
    ).toThrow(/at least one value field/);
  });

  it('rejects unknown row fields', () => {
    expect(() =>
      createPivot(sales, { ...sumSalesSpec, rows: ['Nope'] }),
    ).toThrow(/unknown field "Nope" in rows/);
  });

  it('rejects unknown value fields', () => {
    expect(() =>
      createPivot(sales, {
        ...sumSalesSpec,
        values: [{ field: 'Nope', aggregation: 'sum' }],
      }),
    ).toThrow(/unknown field "Nope" in values/);
  });

  it('rejects unknown aggregations', () => {
    expect(() =>
      createPivot(sales, {
        ...sumSalesSpec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        values: [{ field: 'Sales', aggregation: 'median' as any }],
      }),
    ).toThrow(/unknown aggregation/);
  });

  it('rejects unsupported spec versions', () => {
    expect(() =>
      createPivot(sales, { ...sumSalesSpec, version: 99 as never }),
    ).toThrow(/unsupported pivot spec version/);
  });
});

describe('createPivot grouping', () => {
  it('groups rows and columns and sums values', () => {
    const p = createPivot(sales, sumSalesSpec);
    expect(p.rowKeys).toEqual([['East'], ['West']]);
    expect(p.colKeys).toEqual([['Q1'], ['Q2']]);
    // East/Q1 = 100 + 50
    expect(p.data[0]?.[0]?.[0]).toBe(150);
    expect(p.data[0]?.[1]?.[0]).toBe(200);
    expect(p.data[1]?.[0]?.[0]).toBe(150);
    expect(p.data[1]?.[1]?.[0]).toBe(250);
  });

  it('computes row, column and grand totals from raw records', () => {
    const p = createPivot(sales, sumSalesSpec);
    expect(p.rowTotals).toEqual([[350], [400]]);
    expect(p.colTotals).toEqual([[300], [450]]);
    expect(p.grandTotals).toEqual([750]);
  });

  it('sorts numeric keys numerically, not lexically', () => {
    const recs: PivotRecord[] = [
      { K: 10, V: 1 },
      { K: 2, V: 1 },
      { K: 9, V: 1 },
    ];
    const p = createPivot(recs, {
      version: PIVOT_SPEC_VERSION,
      rows: ['K'],
      columns: [],
      values: [{ field: 'V', aggregation: 'sum' }],
    });
    expect(p.rowKeys).toEqual([['2'], ['9'], ['10']]);
  });

  it('sorts string keys alphabetically with blanks last', () => {
    const recs: PivotRecord[] = [
      { K: 'b', V: 1 },
      { K: null, V: 1 },
      { K: 'a', V: 1 },
    ];
    const p = createPivot(recs, {
      version: PIVOT_SPEC_VERSION,
      rows: ['K'],
      columns: [],
      values: [{ field: 'V', aggregation: 'sum' }],
    });
    expect(p.rowKeys).toEqual([['a'], ['b'], ['(blank)']]);
  });

  it('keeps numbers and numeric strings as distinct groups', () => {
    const recs: PivotRecord[] = [
      { K: 1, V: 10 },
      { K: '1', V: 20 },
    ];
    const p = createPivot(recs, {
      version: PIVOT_SPEC_VERSION,
      rows: ['K'],
      columns: [],
      values: [{ field: 'V', aggregation: 'sum' }],
    });
    expect(p.rowKeys).toHaveLength(2);
    expect(p.grandTotals).toEqual([30]);
  });

  it('supports multiple row fields as nested keys', () => {
    const p = createPivot(sales, {
      version: PIVOT_SPEC_VERSION,
      rows: ['Region', 'Rep'],
      columns: [],
      values: [{ field: 'Sales', aggregation: 'sum' }],
    });
    expect(p.rowKeys).toContainEqual(['East', 'Amy']);
    expect(p.rowKeys).toContainEqual(['East', 'Cat']);
    expect(p.rowKeys).toContainEqual(['West', 'Bob']);
  });

  it('works with no row fields (single total row)', () => {
    const p = createPivot(sales, {
      version: PIVOT_SPEC_VERSION,
      rows: [],
      columns: ['Quarter'],
      values: [{ field: 'Sales', aggregation: 'sum' }],
    });
    expect(p.rowKeys).toEqual([[]]);
    expect(p.data[0]?.[0]?.[0]).toBe(300);
    expect(p.data[0]?.[1]?.[0]).toBe(450);
  });
});

describe('aggregations', () => {
  const oneCol = (aggregation: PivotSpec['values'][number]['aggregation']): PivotSpec => ({
    version: PIVOT_SPEC_VERSION,
    rows: [],
    columns: [],
    values: [{ field: 'V', aggregation }],
  });

  it('count counts non-blank values including text', () => {
    const recs: PivotRecord[] = [
      { S: 'a', Sales: 1 },
      { S: '', Sales: 2 },
      { S: null, Sales: 3 },
    ];
    const p = createPivot(recs, {
      version: PIVOT_SPEC_VERSION,
      rows: [],
      columns: [],
      values: [{ field: 'S', aggregation: 'count' }],
    });
    expect(p.grandTotals).toEqual([1]);
  });

  it('countnums counts only numbers', () => {
    const recs: PivotRecord[] = [
      { S: 'a', V: 1 },
      { S: 'b', V: 'x' },
      { S: 'c', V: null },
    ];
    const p = createPivot(recs, {
      version: PIVOT_SPEC_VERSION,
      rows: [],
      columns: [],
      values: [{ field: 'V', aggregation: 'countnums' }],
    });
    expect(p.grandTotals).toEqual([1]);
  });

  it('average ignores non-numbers and blanks', () => {
    const recs: PivotRecord[] = [{ V: 10 }, { V: 20 }, { V: 'x' }, { V: null }];
    const p = createPivot(recs, oneCol('average'));
    expect(p.grandTotals).toEqual([15]);
  });

  it('max and min over numbers', () => {
    const recs: PivotRecord[] = [{ V: 3 }, { V: 9 }, { V: 5 }];
    expect(createPivot(recs, oneCol('max')).grandTotals).toEqual([9]);
    expect(createPivot(recs, oneCol('min')).grandTotals).toEqual([3]);
  });

  it('product multiplies numbers', () => {
    const recs: PivotRecord[] = [{ V: 2 }, { V: 3 }, { V: 4 }];
    expect(createPivot(recs, oneCol('product')).grandTotals).toEqual([24]);
  });

  it('stdev and var match Excel sample statistics', () => {
    // Sample statistics: mean=5, SS=32, VAR=32/7, STDEV=sqrt(32/7)
    const recs: PivotRecord[] = [2, 4, 4, 4, 5, 5, 7, 9].map((V) => ({ V }));
    expect(createPivot(recs, oneCol('stdev')).grandTotals[0]).toBeCloseTo(2.138089935299395, 10);
    expect(createPivot(recs, oneCol('var')).grandTotals[0]).toBeCloseTo(4.571428571428571, 10);
  });

  it('stdev/var return null with fewer than two numbers', () => {
    const recs: PivotRecord[] = [{ V: 5 }];
    expect(createPivot(recs, oneCol('stdev')).grandTotals).toEqual([null]);
    expect(createPivot(recs, oneCol('var')).grandTotals).toEqual([null]);
  });

  it('empty buckets aggregate to null, not 0', () => {
    const recs: PivotRecord[] = [{ V: 'text only' }];
    const p = createPivot(recs, oneCol('sum'));
    expect(p.grandTotals).toEqual([null]);
  });

  it('supports multiple value fields', () => {
    const p = createPivot(sales, {
      version: PIVOT_SPEC_VERSION,
      rows: ['Region'],
      columns: [],
      values: [
        { field: 'Sales', aggregation: 'sum' },
        { field: 'Units', aggregation: 'average' },
      ],
    });
    expect(p.valueLabels).toEqual(['Sum of Sales', 'Average of Units']);
    expect(p.data[0]?.[0]).toEqual([350, (10 + 20 + 5) / 3]);
  });

  it('honours custom value labels', () => {
    const p = createPivot(sales, {
      version: PIVOT_SPEC_VERSION,
      rows: [],
      columns: [],
      values: [{ field: 'Sales', aggregation: 'sum', label: 'Total revenue' }],
    });
    expect(p.valueLabels).toEqual(['Total revenue']);
  });
});

describe('filters', () => {
  it('include-only filters restrict the source rows', () => {
    const p = createPivot(sales, {
      ...sumSalesSpec,
      filters: [{ field: 'Region', selected: ['East'] }],
    });
    expect(p.filteredRowCount).toBe(3);
    expect(p.sourceRowCount).toBe(5);
    expect(p.grandTotals).toEqual([350]);
  });

  it('an empty selection excludes everything', () => {
    const p = createPivot(sales, {
      ...sumSalesSpec,
      filters: [{ field: 'Region', selected: [] }],
    });
    expect(p.filteredRowCount).toBe(0);
    expect(p.grandTotals).toEqual([null]);
  });

  it('filters match on display labels', () => {
    const recs: PivotRecord[] = [{ B: true, V: 1 }, { B: false, V: 2 }];
    const p = createPivot(recs, {
      version: PIVOT_SPEC_VERSION,
      rows: [],
      columns: [],
      values: [{ field: 'V', aggregation: 'sum' }],
      filters: [{ field: 'B', selected: ['TRUE'] }],
    });
    expect(p.grandTotals).toEqual([1]);
  });
});

describe('getPivotValue', () => {
  it('looks up cells by key labels', () => {
    const p = createPivot(sales, sumSalesSpec);
    expect(getPivotValue(p, ['East'], ['Q1'])).toBe(150);
    expect(getPivotValue(p, ['West'], ['Q2'])).toBe(250);
  });

  it('returns null for missing key combinations', () => {
    const p = createPivot(sales, sumSalesSpec);
    expect(getPivotValue(p, ['North'], ['Q1'])).toBeNull();
    expect(getPivotValue(p, ['East'], ['Q3'])).toBeNull();
  });

  it('supports a value index for multi-value pivots', () => {
    const p = createPivot(sales, {
      version: PIVOT_SPEC_VERSION,
      rows: ['Region'],
      columns: [],
      values: [
        { field: 'Sales', aggregation: 'sum' },
        { field: 'Units', aggregation: 'sum' },
      ],
    });
    expect(getPivotValue(p, ['East'], [], 1)).toBe(35);
  });
});

describe('recordsFromGrid', () => {
  it('maps header + rows to records', () => {
    const recs = recordsFromGrid(['A', 'B'], [[1, 'x'], [2, 'y']]);
    expect(recs).toEqual([
      { A: 1, B: 'x' },
      { A: 2, B: 'y' },
    ]);
  });

  it('fills missing cells with null', () => {
    const recs = recordsFromGrid(['A', 'B'], [[1]]);
    expect(recs).toEqual([{ A: 1, B: null }]);
  });
});

describe('pivotToMatrix', () => {
  it('renders headers, values and totals', () => {
    const p = createPivot(sales, sumSalesSpec);
    const m = pivotToMatrix(p);
    expect(m[0]).toEqual([null, 'Region', 'Q1', 'Q2', 'Grand Total']);
    expect(m[1]).toEqual([null, 'East', 150, 200, 350]);
    expect(m[2]).toEqual([null, 'West', 150, 250, 400]);
    expect(m[3]).toEqual(['Grand Total', null, 300, 450, 750]);
  });

  it('labels multi-value columns', () => {
    const p = createPivot(sales, {
      version: PIVOT_SPEC_VERSION,
      rows: [],
      columns: [],
      values: [
        { field: 'Sales', aggregation: 'sum' },
        { field: 'Units', aggregation: 'sum' },
      ],
    });
    const m = pivotToMatrix(p);
    expect(m[0]).toEqual([null, 'Sum of Sales', 'Sum of Units']);
    expect(m[1]).toEqual(['Grand Total', 750, 75]);
  });
});

describe('refreshPivot', () => {
  it('recomputes against new records', () => {
    const p1 = createPivot(sales, sumSalesSpec);
    expect(p1.grandTotals).toEqual([750]);
    const p2 = refreshPivot([...sales, { Region: 'East', Quarter: 'Q1', Sales: 1000 }], sumSalesSpec);
    expect(p2.grandTotals).toEqual([1750]);
    expect(p2.sourceRowCount).toBe(6);
  });
});

describe('PIVOT_AGGREGATIONS', () => {
  it('exposes the nine v1 aggregations', () => {
    expect(PIVOT_AGGREGATIONS.map((a) => a.id)).toEqual([
      'sum', 'count', 'average', 'max', 'min', 'product', 'countnums', 'stdev', 'var',
    ]);
  });
});
