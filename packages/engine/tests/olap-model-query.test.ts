/**
 * Live pivot queries over a worksheet-range data model (#114, Piece 1).
 * Synthetic model shaped like bxl3way: tblCal (Period->Year) joined to
 * fact tables on Period, with sum, sign-flipped sum, and ratio measures.
 */
import { describe, expect, it } from 'vitest';
import {
  queryOlapPivot,
  type OlapModel,
  type OlapResolvedPivot,
} from '../src/olap-model-query.js';

const model: OlapModel = {
  tables: [
    {
      name: 'tblCal',
      columns: ['Period', 'Year'],
      rows: [
        { Period: 1, Year: 2012 },
        { Period: 2, Year: 2013 },
        { Period: 3, Year: 2014 },
      ],
    },
    {
      name: 'tblIS',
      columns: ['Period', 'Revenue', 'Cost of Goods Sold'],
      rows: [
        { Period: 1, Revenue: 100, 'Cost of Goods Sold': 40 },
        { Period: 2, Revenue: 200, 'Cost of Goods Sold': 90 },
        { Period: 3, Revenue: 300, 'Cost of Goods Sold': 90 },
      ],
    },
    {
      name: 'tblCF',
      columns: ['Period', 'Cash from Investing'],
      rows: [
        { Period: 1, 'Cash from Investing': 15 },
        { Period: 2, 'Cash from Investing': 25 },
      ],
    },
  ],
};

const earnings: OlapResolvedPivot = {
  name: 'pvtEarnings',
  dimensionTable: 'tblCal',
  dimensionColumn: 'Year',
  joinColumn: 'Period',
  values: [
    { kind: 'sum', label: 'Sum of Revenue', table: 'tblIS', column: 'Revenue' },
    { kind: 'ratio', label: 'Sum of COGS Pct of Rev', table: 'tblIS', numeratorColumn: 'Cost of Goods Sold', denominatorColumn: 'Revenue' },
  ],
};

describe('queryOlapPivot', () => {
  it('returns all members unfiltered, in dimension-table order', () => {
    const m = queryOlapPivot(model, earnings, null);
    expect(m.rowKeys).toEqual(['2012', '2013', '2014']);
    expect(m.data).toEqual([
      [100, 0.4],
      [200, 0.45],
      [300, 0.3],
    ]);
  });

  it('empty selection means all members', () => {
    expect(queryOlapPivot(model, earnings, []).rowKeys).toEqual(['2012', '2013', '2014']);
  });

  it('filters to selected members only (pivot contracts)', () => {
    const m = queryOlapPivot(model, earnings, ['2013']);
    expect(m.rowKeys).toEqual(['2013']);
    expect(m.data).toEqual([[200, 0.45]]);
  });

  it('matches string member labels against numeric dimension values', () => {
    const m = queryOlapPivot(model, earnings, ['2014', '2012']);
    // Dimension-table order wins over selection order.
    expect(m.rowKeys).toEqual(['2012', '2014']);
    expect(m.data).toEqual([
      [100, 0.4],
      [300, 0.3],
    ]);
  });

  it('applies sign flips (negated column sums)', () => {
    const cf: OlapResolvedPivot = {
      name: 'pvtCF',
      dimensionTable: 'tblCal',
      dimensionColumn: 'Year',
      joinColumn: 'Period',
      values: [
        { kind: 'sum', label: 'Sum of invested Cash', table: 'tblCF', column: 'Cash from Investing', sign: -1 },
      ],
    };
    const m = queryOlapPivot(model, cf, null);
    expect(m.rowKeys).toEqual(['2012', '2013', '2014']);
    expect(m.data).toEqual([[-15], [-25], [0]]);
  });

  it('returns null for a ratio over a zero denominator', () => {
    const zero: OlapModel = {
      tables: [
        { name: 'tblCal', columns: ['Period', 'Year'], rows: [{ Period: 1, Year: 2012 }] },
        { name: 'tblF', columns: ['Period', 'A', 'B'], rows: [{ Period: 1, A: 5, B: 0 }] },
      ],
    };
    const p: OlapResolvedPivot = {
      name: 'p',
      dimensionTable: 'tblCal',
      dimensionColumn: 'Year',
      joinColumn: 'Period',
      values: [{ kind: 'ratio', label: 'A/B', table: 'tblF', numeratorColumn: 'A', denominatorColumn: 'B' }],
    };
    expect(queryOlapPivot(zero, p, null).data).toEqual([[null]]);
  });

  it('never throws for unknown tables or columns', () => {
    const bad: OlapResolvedPivot = {
      ...earnings,
      dimensionTable: 'tblNope',
    };
    expect(queryOlapPivot(model, bad, null)).toEqual({ rowKeys: [], data: [] });
    const badCol: OlapResolvedPivot = {
      ...earnings,
      values: [{ kind: 'sum', label: 'x', table: 'tblIS', column: 'Nope' }],
    };
    expect(queryOlapPivot(model, badCol, null).data).toEqual([[0], [0], [0]]);
  });
});
