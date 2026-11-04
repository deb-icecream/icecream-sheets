/**
 * Group-by view tests (features/groupBy.ts): pivot-style summaries over
 * plain header + row arrays.
 */
import { describe, expect, it } from 'vitest';
import { groupByView } from './groupBy';

const HEADERS = ['Region', 'Amount'];
const ROWS: unknown[][] = [
  ['East', 10],
  ['West', 25],
  ['East', 40],
  ['West', 100],
];

describe('groupByView', () => {
  it('builds a grouped matrix with totals', () => {
    const { matrix, title } = groupByView(HEADERS, ROWS, {
      groupFields: ['Region'],
      valueFields: [{ field: 'Amount', aggregation: 'sum' }],
    });
    expect(title).toBe('GroupBy Region');
    // Header row: corner, row field, value column, grand total.
    expect(matrix[0]).toEqual([null, 'Region', 'Sum of Amount', 'Grand Total']);
    const east = matrix.find((r) => r[1] === 'East');
    expect(east?.[2]).toBe(50);
    const grand = matrix[matrix.length - 1];
    expect(grand?.[0]).toBe('Grand Total');
    expect(grand?.[3]).toBe(175);
  });

  it('supports grouping operators', () => {
    const { matrix } = groupByView(['Date', 'Amount'], [['2026-01-05', 10], ['2026-02-10', 20]], {
      groupFields: ['Date'],
      valueFields: [{ field: 'Amount', aggregation: 'sum' }],
      groupings: [{ field: 'Date', kind: 'date', unit: 'month' }],
    });
    const labels = matrix.slice(1, -1).map((r) => r[1]);
    expect(labels).toEqual(['Jan 2026', 'Feb 2026']);
  });

  it('rejects empty group/value selections with clear errors', () => {
    expect(() => groupByView(HEADERS, ROWS, { groupFields: [], valueFields: [{ field: 'Amount', aggregation: 'sum' }] })).toThrow(
      'at least one field to group by',
    );
    expect(() => groupByView(HEADERS, ROWS, { groupFields: ['Region'], valueFields: [] })).toThrow(
      'at least one value field',
    );
    expect(() =>
      groupByView(HEADERS, ROWS, { groupFields: ['Nope'], valueFields: [{ field: 'Amount', aggregation: 'sum' }] }),
    ).toThrow('Unknown field');
  });
});
