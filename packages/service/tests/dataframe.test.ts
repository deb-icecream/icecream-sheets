/** Tests for the columnar DataFrame (dataframe.ts). */
import { describe, expect, it } from 'vitest';
import { DataFrame } from '../src/dataframe.js';

const ORDERS = DataFrame.fromRows([
  { id: 1, customer: 'Ann', amount: 120, region: 'west' },
  { id: 2, customer: 'Bob', amount: 40, region: 'east' },
  { id: 3, customer: 'Cat', amount: 200, region: 'west' },
  { id: 4, customer: 'Dan', amount: null, region: 'east' },
]);

describe('DataFrame construction', () => {
  it('builds columnar storage from rows', () => {
    expect(ORDERS.columnNames).toEqual(['id', 'customer', 'amount', 'region']);
    expect(ORDERS.rowCount).toBe(4);
    expect(ORDERS.column('amount')).toEqual([120, 40, 200, null]);
  });

  it('infers column types', () => {
    expect(ORDERS.columnType('amount')).toBe('number');
    expect(ORDERS.columnType('customer')).toBe('string');
  });

  it('round-trips rows', () => {
    expect(ORDERS.toRows()).toEqual([
      { id: 1, customer: 'Ann', amount: 120, region: 'west' },
      { id: 2, customer: 'Bob', amount: 40, region: 'east' },
      { id: 3, customer: 'Cat', amount: 200, region: 'west' },
      { id: 4, customer: 'Dan', amount: null, region: 'east' },
    ]);
  });

  it('rejects ragged or duplicate columns', () => {
    expect(() => DataFrame.fromColumns(['a'], [[1, 2]], )).not.toThrow();
    expect(() => DataFrame.fromColumns(['a', 'a'], [[1], [2]])).toThrow();
    expect(() => DataFrame.fromColumns(['a', 'b'], [[1, 2], [1]])).toThrow();
  });

  it('round-trips column-dict (pandas handoff shape)', () => {
    const dict = ORDERS.toColumnDict();
    expect(Object.keys(dict)).toEqual(['id', 'customer', 'amount', 'region']);
    expect(DataFrame.fromColumnDict(dict).toRows()).toEqual(ORDERS.toRows());
  });

  it('round-trips JSON snapshots', () => {
    const snap = ORDERS.toJSON();
    expect(DataFrame.fromJSON(snap).toRows()).toEqual(ORDERS.toRows());
  });

  it('converts to/from EtlTable', () => {
    const t = ORDERS.toEtlTable();
    expect(t.columns.map((c) => c.name)).toEqual(['id', 'customer', 'amount', 'region']);
    expect(DataFrame.fromEtlTable(t).toRows()).toEqual(ORDERS.toRows());
  });
});

describe('DataFrame column operations', () => {
  it('select/drop/rename preserve data', () => {
    expect(ORDERS.select(['customer', 'amount']).columnNames).toEqual(['customer', 'amount']);
    expect(ORDERS.drop(['region']).columnNames).toEqual(['id', 'customer', 'amount']);
    const r = ORDERS.rename({ amount: 'total' });
    expect(r.columnNames).toContain('total');
    expect(r.column('total')).toEqual([120, 40, 200, null]);
  });

  it('withColumn adds computed columns', () => {
    const df = ORDERS.withColumn('double', (r) => (typeof r['amount'] === 'number' ? r['amount'] * 2 : null));
    expect(df.column('double')).toEqual([240, 80, 400, null]);
    expect(df.columnNames).toEqual(['id', 'customer', 'amount', 'region', 'double']);
  });

  it('filter keeps matching rows across all columns', () => {
    const f = ORDERS.filter((r) => r['region'] === 'west');
    expect(f.rowCount).toBe(2);
    expect(f.column('customer')).toEqual(['Ann', 'Cat']);
  });

  it('filterMask is the vectorized primitive', () => {
    const f = ORDERS.filterMask([true, false, true, false]);
    expect(f.column('id')).toEqual([1, 3]);
  });

  it('sortBy orders stably on multiple keys', () => {
    const s = ORDERS.sortBy([{ column: 'region' }, { column: 'amount', dir: 'desc' }]);
    expect(s.column('customer')).toEqual(['Bob', 'Dan', 'Cat', 'Ann']);
  });

  it('head/tail/slice window rows', () => {
    expect(ORDERS.head(2).rowCount).toBe(2);
    expect(ORDERS.tail(1).column('customer')).toEqual(['Dan']);
    expect(ORDERS.slice(1, 3).column('id')).toEqual([2, 3]);
  });

  it('fillNull fills with scalar or ffill', () => {
    expect(ORDERS.fillNull('amount', 0).column('amount')).toEqual([120, 40, 200, 0]);
    const df = DataFrame.fromRows([{ a: 1 }, { a: null }, { a: null }, { a: 4 }]);
    expect(df.fillNull('a', 'ffill').column('a')).toEqual([1, 1, 1, 4]);
  });

  it('deduplicate drops repeated keys', () => {
    const df = DataFrame.fromRows([{ a: 1 }, { a: 1 }, { a: 2 }]);
    expect(df.deduplicate(['a']).rowCount).toBe(2);
  });
});

describe('DataFrame aggregations', () => {
  it('computes single-pass column aggregates', () => {
    expect(ORDERS.agg('amount', 'sum')).toBe(360);
    expect(ORDERS.agg('amount', 'mean')).toBe(120);
    expect(ORDERS.agg('amount', 'min')).toBe(40);
    expect(ORDERS.agg('amount', 'max')).toBe(200);
    expect(ORDERS.agg('amount', 'count')).toBe(3);
    expect(ORDERS.agg('customer', 'nunique')).toBe(4);
    expect(ORDERS.agg('customer', 'first')).toBe('Ann');
    expect(ORDERS.agg('customer', 'last')).toBe('Dan');
  });

  it('describe summarizes each column', () => {
    const d = ORDERS.describe();
    expect(d['amount'].sum).toBe(360);
    expect(d['amount'].mean).toBe(120);
    expect(d['amount'].nulls).toBe(1);
    expect(d['region'].nunique).toBe(2);
  });

  it('groupBy aggregates per key', () => {
    const g = ORDERS.groupBy(['region'], [
      { column: 'amount', agg: 'sum', as: 'total' },
      { column: 'id', agg: 'count', as: 'n' },
    ]);
    expect(g.columnNames).toEqual(['region', 'total', 'n']);
    const rows = g.toRows().sort((a, b) => String(a['region']).localeCompare(String(b['region'])));
    expect(rows).toEqual([
      { region: 'east', total: 40, n: 2 },
      { region: 'west', total: 320, n: 2 },
    ]);
  });

  it('join combines tables on keys', () => {
    const customers = DataFrame.fromRows([
      { customer: 'Ann', tier: 'gold' },
      { customer: 'Bob', tier: 'silver' },
    ]);
    const j = ORDERS.select(['customer', 'amount']).join(customers, ['customer'], 'left');
    expect(j.rowCount).toBe(4);
    const ann = j.toRows().find((r) => r['customer'] === 'Ann')!;
    expect(ann['tier']).toBe('gold');
    const dan = j.toRows().find((r) => r['customer'] === 'Dan')!;
    expect(dan['tier']).toBeNull();
  });

  it('append unions rows with null fill', () => {
    const extra = DataFrame.fromRows([{ id: 5, customer: 'Eve', amount: 10 }]);
    const a = ORDERS.append(extra);
    expect(a.rowCount).toBe(5);
    expect(a.toRows()[4]['region']).toBeNull();
  });
});
