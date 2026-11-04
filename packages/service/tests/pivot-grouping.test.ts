/**
 * Pivot grouping operator tests (src/pivot.ts): date, numeric and custom
 * groupings for pivot row/column fields (Excel's Group dialog).
 */
import { describe, expect, it } from 'vitest';
import {
  applyGroupings,
  createPivot,
  getPivotValue,
  groupCustomValue,
  groupDateValue,
  groupNumericValue,
  isPivotGroupValue,
  type PivotRecord,
  type PivotSpec,
} from '../src/pivot.js';

function spec(partial: Partial<PivotSpec>): PivotSpec {
  return {
    version: 1,
    rows: [],
    columns: [],
    values: [{ field: 'Amount', aggregation: 'sum' }],
    ...partial,
  };
}

const SALES: PivotRecord[] = [
  { Date: '2026-01-05', Region: 'East', Amount: 10 },
  { Date: '2026-01-20', Region: 'West', Amount: 25 },
  { Date: '2026-02-10', Region: 'East', Amount: 40 },
  { Date: '2026-04-02', Region: 'West', Amount: 100 },
  { Date: '2026-04-15', Region: 'East', Amount: 250 },
];

describe('groupDateValue', () => {
  it('buckets by year / quarter / month / week / day', () => {
    expect(groupDateValue('2026-04-15', 'year')?.groupLabel).toBe('2026');
    expect(groupDateValue('2026-04-15', 'quarter')?.groupLabel).toBe('Q2 2026');
    expect(groupDateValue('2026-04-15', 'month')?.groupLabel).toBe('Apr 2026');
    expect(groupDateValue('2026-04-15', 'day')?.groupLabel).toBe('2026-04-15');
    const w = groupDateValue('2026-04-15', 'week');
    expect(w).not.toBeNull();
    expect(w!.groupKey).toBe('2026-W16'); // 2026-04-15 is ISO week 16
  });

  it('accepts Excel serial dates', () => {
    // 2026-01-05 is serial 46023.
    const g = groupDateValue(46023, 'month');
    expect(g?.groupLabel).toBe('Jan 2026');
  });

  it('returns null for non-dates (caller keeps exact grouping)', () => {
    expect(groupDateValue('not a date', 'month')).toBeNull();
    expect(groupDateValue(42, 'month')).not.toBeNull(); // 42 is a valid serial
    expect(groupDateValue(null, 'month')).toBeNull();
  });
});

describe('groupNumericValue', () => {
  const g = { field: 'Amount', kind: 'numeric' as const, by: 100 };

  it('bins Excel-style with integer widths', () => {
    expect(groupNumericValue(10, g, 10, 250)?.groupLabel).toBe('0-99');
    expect(groupNumericValue(100, g, 10, 250)?.groupLabel).toBe('100-199');
    expect(groupNumericValue(250, g, 10, 250)?.groupLabel).toBe('200-299');
  });

  it('clamps out-of-range values into edge groups', () => {
    const ranged = { field: 'Amount', kind: 'numeric' as const, by: 100, start: 0, end: 200 };
    expect(groupNumericValue(-5, ranged, -5, 300)?.groupLabel).toBe('< 0');
    expect(groupNumericValue(250, ranged, -5, 300)?.groupLabel).toBe('>= 200');
  });

  it('returns null for non-numbers', () => {
    expect(groupNumericValue('x', g, 0, 1)).toBeNull();
  });
});

describe('groupCustomValue', () => {
  const groups = [
    { label: 'Coasts', values: ['East', 'West'] },
    { label: 'Central', values: ['Midwest'] },
  ];

  it('maps values to labels in declared order', () => {
    const gv = groupCustomValue('West', groups);
    expect(gv?.groupLabel).toBe('Coasts');
    expect(isPivotGroupValue(gv)).toBe(true);
  });

  it('returns null when nothing matches', () => {
    expect(groupCustomValue('South', groups)).toBeNull();
  });

  it('matches numbers stored as text', () => {
    expect(groupCustomValue('5', [{ label: 'five', values: [5] }])?.groupLabel).toBe('five');
  });
});

describe('createPivot with groupings', () => {
  it('groups dates by month on rows', () => {
    const p = createPivot(
      SALES,
      spec({
        rows: ['Date'],
        groupings: [{ field: 'Date', kind: 'date', unit: 'month' }],
      }),
    );
    expect(p.rowKeys).toEqual([['Jan 2026'], ['Feb 2026'], ['Apr 2026']]);
    expect(getPivotValue(p, ['Jan 2026'], [])).toBe(35);
    expect(getPivotValue(p, ['Apr 2026'], [])).toBe(350);
  });

  it('groups numbers into bins on columns', () => {
    const p = createPivot(
      SALES,
      spec({
        rows: ['Region'],
        columns: ['Amount'],
        groupings: [{ field: 'Amount', kind: 'numeric', by: 100 }],
      }),
    );
    // Numeric bins sort numerically, not lexicographically.
    expect(p.colKeys).toEqual([['0-99'], ['100-199'], ['200-299']]);
    expect(getPivotValue(p, ['East'], ['0-99'])).toBe(50);
    expect(getPivotValue(p, ['West'], ['100-199'])).toBe(100);
  });

  it('groups custom labels in declared order', () => {
    const p = createPivot(
      SALES,
      spec({
        rows: ['Region'],
        groupings: [
          {
            field: 'Region',
            kind: 'custom',
            groups: [{ label: 'All Regions', values: ['East', 'West'] }],
          },
        ],
      }),
    );
    expect(p.rowKeys).toEqual([['All Regions']]);
    expect(p.grandTotals).toEqual([425]);
  });

  it('unmatched values keep exact grouping', () => {
    const p = createPivot(
      [...SALES, { Date: '2026-05-01', Region: 'South', Amount: 5 }],
      spec({
        rows: ['Region'],
        groupings: [
          {
            field: 'Region',
            kind: 'custom',
            groups: [{ label: 'Coasts', values: ['East', 'West'] }],
          },
        ],
      }),
    );
    expect(p.rowKeys).toEqual([['Coasts'], ['South']]);
  });

  it('filters match group labels', () => {
    const p = createPivot(
      SALES,
      spec({
        rows: ['Date'],
        groupings: [{ field: 'Date', kind: 'date', unit: 'quarter' }],
        filters: [{ field: 'Date', selected: ['Q1 2026'] }],
      }),
    );
    expect(p.rowKeys).toEqual([['Q1 2026']]);
    expect(p.filteredRowCount).toBe(3);
  });

  it('rejects invalid groupings', () => {
    expect(() =>
      createPivot(SALES, spec({ rows: ['Nope'], groupings: [{ field: 'Nope', kind: 'date', unit: 'month' }] })),
    ).toThrow('unknown field');
    expect(() =>
      createPivot(
        SALES,
        spec({ rows: ['Amount'], groupings: [{ field: 'Amount', kind: 'numeric', by: 0 }] }),
      ),
    ).toThrow('by > 0');
    expect(() =>
      createPivot(
        SALES,
        spec({
          rows: ['Region'],
          groupings: [{ field: 'Region', kind: 'custom', groups: [] }],
        }),
      ),
    ).toThrow('at least one group');
  });

  it('applyGroupings does not mutate the input records', () => {
    const before = JSON.stringify(SALES);
    applyGroupings(SALES, [{ field: 'Date', kind: 'date', unit: 'month' }]);
    expect(JSON.stringify(SALES)).toBe(before);
  });
});
