/**
 * ETL transform library tests (design-docs/etl-pipeline.md §3).
 * The transform library is pure — EtlTable in, { table, failures } out.
 */
import { describe, expect, it } from 'vitest';
import {
  appendTables,
  applyTransform,
  convertType,
  deduplicate,
  dropColumns,
  fillDown,
  filterRows,
  groupBy,
  joinTables,
  makeTable,
  mergeColumns,
  pivotTable,
  renameColumns,
  selectColumns,
  sortRows,
  splitColumn,
  unpivotTable,
  type EtlTable,
} from '../src/index.js';

const sales: EtlTable = makeTable(
  ['Region', 'Quarter', 'Sales', 'Active'],
  [
    ['East', 'Q1', 100, true],
    ['East', 'Q2', 200, true],
    ['West', 'Q1', 150, false],
    ['West', 'Q2', 250, true],
    ['East', 'Q1', 50, true],
  ],
);

describe('select / drop / rename', () => {
  it('selects columns in the requested order', () => {
    const t = selectColumns(sales, ['Sales', 'Region']);
    expect(t.columns.map((c) => c.name)).toEqual(['Sales', 'Region']);
    expect(t.rows[0]).toEqual({ Sales: 100, Region: 'East' });
  });

  it('select throws on unknown column', () => {
    expect(() => selectColumns(sales, ['Nope'])).toThrow(/unknown column "Nope"/);
  });

  it('drops columns', () => {
    const t = dropColumns(sales, ['Active', 'Quarter']);
    expect(t.columns.map((c) => c.name)).toEqual(['Region', 'Sales']);
    expect(t.rows).toHaveLength(5);
  });

  it('renames columns without touching values', () => {
    const t = renameColumns(sales, { Sales: 'Revenue' });
    expect(t.columns.map((c) => c.name)).toContain('Revenue');
    expect(t.rows[0]['Revenue']).toBe(100);
    expect('Sales' in t.rows[0]).toBe(false);
  });

  it('rename throws on unknown source column', () => {
    expect(() => renameColumns(sales, { Nope: 'X' })).toThrow(/unknown column/);
  });
});

describe('convert', () => {
  it('converts text numbers to numbers', () => {
    const t = makeTable(['n'], [['42'], ['3.5']]);
    const { table, failures } = convertType(t, 'n', 'number');
    expect(failures).toHaveLength(0);
    expect(table.rows.map((r) => r['n'])).toEqual([42, 3.5]);
    expect(table.columns[0].type).toBe('number');
  });

  it('quarantines unconvertible values as null with reasons', () => {
    const t = makeTable(['n'], [['42'], ['abc'], ['7']]);
    const { table, failures } = convertType(t, 'n', 'number');
    expect(table.rows.map((r) => r['n'])).toEqual([42, null, 7]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ rowIndex: 1, column: 'n' });
    expect(failures[0].reason).toMatch(/cannot convert/);
  });

  it('converts to boolean with common spellings', () => {
    const t = makeTable(['b'], [['yes'], ['0'], ['TRUE']]);
    const { table, failures } = convertType(t, 'b', 'boolean');
    expect(failures).toHaveLength(0);
    expect(table.rows.map((r) => r['b'])).toEqual([true, false, true]);
  });

  it('converts to date as ISO strings', () => {
    const t = makeTable(['d'], [['2026-10-18']]);
    const { table, failures } = convertType(t, 'd', 'date');
    expect(failures).toHaveLength(0);
    expect(table.rows[0]['d']).toBe('2026-10-18');
  });

  it('leaves nulls as null', () => {
    const t = makeTable(['n'], [[null]]);
    const { table, failures } = convertType(t, 'n', 'number');
    expect(table.rows[0]['n']).toBeNull();
    expect(failures).toHaveLength(0);
  });
});

describe('filter', () => {
  it('filters with eq', () => {
    expect(filterRows(sales, 'Region', 'eq', 'East').rows).toHaveLength(3);
  });

  it('filters with neq', () => {
    expect(filterRows(sales, 'Region', 'neq', 'East').rows).toHaveLength(2);
  });

  it('filters with gt on numbers', () => {
    const t = filterRows(sales, 'Sales', 'gt', 150);
    expect(t.rows.map((r) => r['Sales'])).toEqual([200, 250]);
  });

  it('filters with lte', () => {
    expect(filterRows(sales, 'Sales', 'lte', 100).rows).toHaveLength(2);
  });

  it('filters with contains on text', () => {
    const t = filterRows(sales, 'Region', 'contains', 'eas');
    expect(t.rows).toHaveLength(0);
    expect(filterRows(sales, 'Region', 'contains', 'East').rows).toHaveLength(3);
  });

  it('filters nulls with is-null / is-not-null', () => {
    const t = makeTable(['a'], [[1], [null], [3]]);
    expect(filterRows(t, 'a', 'is-null').rows).toHaveLength(1);
    expect(filterRows(t, 'a', 'is-not-null').rows).toHaveLength(2);
  });
});

describe('sort', () => {
  it('sorts ascending by a numeric column', () => {
    const t = sortRows(sales, [{ column: 'Sales', dir: 'asc' }]);
    expect(t.rows.map((r) => r['Sales'])).toEqual([50, 100, 150, 200, 250]);
  });

  it('sorts by multiple keys', () => {
    const t = sortRows(sales, [
      { column: 'Region', dir: 'asc' },
      { column: 'Sales', dir: 'desc' },
    ]);
    expect(t.rows.map((r) => [r['Region'], r['Sales']])).toEqual([
      ['East', 200], ['East', 100], ['East', 50], ['West', 250], ['West', 150],
    ]);
  });

  it('sorts nulls last', () => {
    const t = makeTable(['a'], [[3], [null], [1]]);
    expect(sortRows(t, [{ column: 'a', dir: 'asc' }]).rows.map((r) => r['a'])).toEqual([1, 3, null]);
  });
});

describe('split / merge columns', () => {
  it('splits a column on a delimiter', () => {
    const t = makeTable(['name'], [['Alice Smith'], ['Bob Jones']]);
    const out = splitColumn(t, 'name', ' ', ['first', 'last']);
    expect(out.columns.map((c) => c.name)).toEqual(['first', 'last']);
    expect(out.rows[0]).toEqual({ first: 'Alice', last: 'Smith' });
  });

  it('pads missing split parts with null', () => {
    const t = makeTable(['name'], [['Alice']]);
    const out = splitColumn(t, 'name', ' ', ['first', 'last']);
    expect(out.rows[0]).toEqual({ first: 'Alice', last: null });
  });

  it('merges columns with a delimiter', () => {
    const t = makeTable(['first', 'last'], [['Alice', 'Smith']]);
    const out = mergeColumns(t, ['first', 'last'], ' ', 'full');
    expect(out.columns.map((c) => c.name)).toEqual(['full']);
    expect(out.rows[0]['full']).toBe('Alice Smith');
  });
});

describe('pivot / unpivot', () => {
  it('pivots with sum aggregation', () => {
    const out = pivotTable(sales, ['Region'], 'Quarter', 'Sales', 'sum');
    expect(out.columns.map((c) => c.name)).toEqual(['Region', 'Q1', 'Q2']);
    const east = out.rows.find((r) => r['Region'] === 'East')!;
    expect(east['Q1']).toBe(150);
    expect(east['Q2']).toBe(200);
  });

  it('unpivot is the inverse shape of pivot', () => {
    const pivoted = pivotTable(sales, ['Region'], 'Quarter', 'Sales', 'sum');
    const out = unpivotTable(pivoted, ['Region'], 'Quarter', 'Sales');
    expect(out.columns.map((c) => c.name)).toEqual(['Region', 'Quarter', 'Sales']);
    expect(out.rows).toHaveLength(4); // 2 regions x 2 quarters
  });
});

describe('join / append', () => {
  const reps = makeTable(
    ['Region', 'Rep'],
    [['East', 'Amy'], ['West', 'Bob']],
  );

  it('inner join keeps only matching rows', () => {
    const out = joinTables(sales, reps, ['Region'], 'inner');
    expect(out.rows).toHaveLength(5);
    expect(out.rows[0]['Rep']).toBe('Amy');
    expect(out.columns.map((c) => c.name)).toContain('Rep');
  });

  it('left join keeps all left rows', () => {
    const right = makeTable(['Region', 'Rep'], [['East', 'Amy']]);
    const out = joinTables(sales, right, ['Region'], 'left');
    expect(out.rows).toHaveLength(5);
    const west = out.rows.find((r) => r['Region'] === 'West')!;
    expect(west['Rep']).toBeNull();
  });

  it('outer join keeps unmatched rows from both sides', () => {
    const right = makeTable(['Region', 'Rep'], [['North', 'Ned']]);
    const out = joinTables(sales, right, ['Region'], 'outer');
    expect(out.rows).toHaveLength(6);
    const north = out.rows.find((r) => r['Rep'] === 'Ned')!;
    expect(north['Region']).toBe('North');
    expect(north['Sales']).toBeNull();
  });

  it('appends tables with a shared schema', () => {
    const a = makeTable(['x'], [[1]]);
    const b = makeTable(['x'], [[2], [3]]);
    const out = appendTables([a, b]);
    expect(out.rows.map((r) => r['x'])).toEqual([1, 2, 3]);
  });

  it('append fills missing columns with null', () => {
    const a = makeTable(['x'], [[1]]);
    const b = makeTable(['x', 'y'], [[2, 'z']]);
    const out = appendTables([a, b]);
    expect(out.columns.map((c) => c.name)).toEqual(['x']);
    expect(out.rows[0]).toEqual({ x: 1 });
  });
});

describe('group-by / fill-down / deduplicate', () => {
  it('groups with sum and count', () => {
    const out = groupBy(sales, ['Region'], [
      { column: 'Sales', agg: 'sum', as: 'Total' },
      { column: 'Sales', agg: 'count', as: 'N' },
    ]);
    expect(out.columns.map((c) => c.name)).toEqual(['Region', 'Total', 'N']);
    const east = out.rows.find((r) => r['Region'] === 'East')!;
    expect(east['Total']).toBe(350);
    expect(east['N']).toBe(3);
  });

  it('groups with avg', () => {
    const out = groupBy(sales, ['Region'], [{ column: 'Sales', agg: 'avg', as: 'Avg' }]);
    const west = out.rows.find((r) => r['Region'] === 'West')!;
    expect(west['Avg']).toBe(200);
  });

  it('fills down nulls', () => {
    const t = makeTable(['a'], [['x'], [null], [null], ['y']]);
    expect(fillDown(t, 'a').rows.map((r) => r['a'])).toEqual(['x', 'x', 'x', 'y']);
  });

  it('deduplicates on all columns by default', () => {
    const t = makeTable(['a', 'b'], [[1, 2], [1, 2], [1, 3]]);
    expect(deduplicate(t).rows).toHaveLength(2);
  });

  it('deduplicates on a subset keeping last', () => {
    const t = makeTable(['a', 'b'], [[1, 'old'], [1, 'new'], [2, 'x']]);
    const out = deduplicate(t, ['a'], 'last');
    expect(out.rows.map((r) => r['b'])).toEqual(['new', 'x']);
  });
});

describe('applyTransform dispatch', () => {
  it('dispatches select', () => {
    const { table, failures } = applyTransform(sales, { op: 'select', columns: ['Region'] });
    expect(failures).toHaveLength(0);
    expect(table.columns.map((c) => c.name)).toEqual(['Region']);
  });

  it('rejects custom without a runner', () => {
    expect(() => applyTransform(sales, { op: 'custom', language: 'javascript', code: '1' }))
      .toThrow(/sandboxed code runner/);
  });

  it('join resolves the "with" table through the resolver', () => {
    const other = makeTable(['Region', 'Rep'], [['East', 'Amy']]);
    const { table } = applyTransform(
      sales,
      { op: 'join', with: { kind: 'literal', table: other }, on: ['Region'], how: 'left' },
      () => other,
    );
    expect(table.rows).toHaveLength(5);
  });
});
