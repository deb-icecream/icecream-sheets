/**
 * ETL pipeline — fixed typed transform library.
 *
 * Per design-docs/etl-pipeline.md §3, every operation is pure, typed and
 * testable: EtlTable in, { table, failures } out. Row-level failures (bad
 * type conversions) are reported, not thrown, so the runner can quarantine
 * them per the recipe's failure policy.
 */

import {
  columnNames,
  toEtlValue,
  type EtlColumn,
  type EtlColumnType,
  type EtlRow,
  type EtlTable,
  type EtlValue,
  type RowFailure,
} from './types.js';
import type { Aggregation, ConvertTarget, FilterOperator, JoinHow, SortDir, TransformOp } from './recipe.js';

export interface TransformResult {
  table: EtlTable;
  failures: RowFailure[];
}

function ok(table: EtlTable): TransformResult {
  return { table, failures: [] };
}

function requireColumn(table: EtlTable, column: string): void {
  if (!columnNames(table).includes(column)) {
    throw new Error(`unknown column "${column}"`);
  }
}

function project(table: EtlTable, columns: string[]): EtlTable {
  const cols: EtlColumn[] = columns.map((name) => {
    const existing = table.columns.find((c) => c.name === name);
    return { name, type: existing?.type ?? 'unknown' };
  });
  const rows = table.rows.map((r) => {
    const row: EtlRow = {};
    for (const c of columns) row[c] = c in r ? r[c] : null;
    return row;
  });
  return { columns: cols, rows };
}

// ---------------------------------------------------------------------------
// select / drop / rename
// ---------------------------------------------------------------------------

export function selectColumns(table: EtlTable, columns: string[]): EtlTable {
  for (const c of columns) requireColumn(table, c);
  return project(table, columns);
}

export function dropColumns(table: EtlTable, columns: string[]): EtlTable {
  for (const c of columns) requireColumn(table, c);
  return project(table, columnNames(table).filter((c) => !columns.includes(c)));
}

export function renameColumns(table: EtlTable, mapping: Record<string, string>): EtlTable {
  for (const from of Object.keys(mapping)) requireColumn(table, from);
  const columns = table.columns.map((c) => ({
    name: mapping[c.name] ?? c.name,
    type: c.type,
  }));
  const rows = table.rows.map((r) => {
    const row: EtlRow = {};
    for (const c of table.columns) row[mapping[c.name] ?? c.name] = r[c.name];
    return row;
  });
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

function convertOne(value: EtlValue, to: ConvertTarget): EtlValue {
  if (value === null) return null;
  switch (to) {
    case 'text':
      return typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
    case 'number': {
      if (typeof value === 'number') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      const n = Number(value.trim().replace(/,/g, ''));
      if (value.trim() === '' || Number.isNaN(n)) throw new Error(`cannot convert "${value}" to number`);
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 't'].includes(s)) return true;
      if (['false', '0', 'no', 'n', 'f', ''].includes(s)) return false;
      throw new Error(`cannot convert "${value}" to boolean`);
    }
    case 'date': {
      if (typeof value === 'number') {
        // Excel serial date -> ISO (day 1 = 1899-12-30).
        const ms = Math.round((value - 25569) * 86400 * 1000);
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) throw new Error(`cannot convert ${value} to date`);
        return d.toISOString().slice(0, 10);
      }
      const ms = Date.parse(String(value));
      if (Number.isNaN(ms)) throw new Error(`cannot convert "${value}" to date`);
      return new Date(ms).toISOString().slice(0, 10);
    }
  }
}

/**
 * Convert a column's type. Values that fail conversion become null and are
 * reported as failures (the runner quarantines them when the policy says
 * so); the run is NOT aborted here — that is the threshold's job.
 */
export function convertType(table: EtlTable, column: string, to: ConvertTarget): TransformResult {
  requireColumn(table, column);
  const failures: RowFailure[] = [];
  const columns = table.columns.map((c) => (c.name === column ? { ...c, type: to as EtlColumnType } : c));
  const rows = table.rows.map((r, i) => {
    try {
      return { ...r, [column]: convertOne(r[column], to) };
    } catch (e) {
      failures.push({
        rowIndex: i,
        column,
        reason: e instanceof Error ? e.message : 'conversion failed',
      });
      return { ...r, [column]: null };
    }
  });
  return { table: { columns, rows }, failures };
}

// ---------------------------------------------------------------------------
// filter / sort
// ---------------------------------------------------------------------------

function compareValues(a: EtlValue, b: EtlValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls sort last
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

function parseFilterValue(raw: string | number | boolean | null | undefined): EtlValue {
  if (raw === undefined) return null;
  return toEtlValue(raw);
}

export function filterRows(
  table: EtlTable,
  column: string,
  operator: FilterOperator,
  value?: string | number | boolean | null,
): EtlTable {
  requireColumn(table, column);
  const v = parseFilterValue(value);
  const rows = table.rows.filter((r) => {
    const cell = r[column];
    switch (operator) {
      case 'eq': return cell === v || (typeof cell === 'number' && typeof v === 'number' && cell === v);
      case 'neq': return cell !== v;
      case 'contains': return typeof cell === 'string' && typeof v === 'string' && cell.includes(v);
      case 'not-contains': return !(typeof cell === 'string' && typeof v === 'string' && cell.includes(v));
      case 'gt': return compareValues(cell, v) > 0;
      case 'gte': return compareValues(cell, v) >= 0;
      case 'lt': return compareValues(cell, v) < 0;
      case 'lte': return compareValues(cell, v) <= 0;
      case 'is-null': return cell === null;
      case 'is-not-null': return cell !== null;
    }
  });
  return { columns: table.columns, rows };
}

export function sortRows(table: EtlTable, keys: { column: string; dir: SortDir }[]): EtlTable {
  for (const k of keys) requireColumn(table, k.column);
  const rows = [...table.rows].sort((a, b) => {
    for (const k of keys) {
      const cmp = compareValues(a[k.column], b[k.column]);
      if (cmp !== 0) return k.dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
  return { columns: table.columns, rows };
}

// ---------------------------------------------------------------------------
// split / merge columns
// ---------------------------------------------------------------------------

export function splitColumn(table: EtlTable, column: string, delimiter: string, into: string[]): EtlTable {
  requireColumn(table, column);
  for (const name of into) {
    if (columnNames(table).includes(name) && name !== column) {
      throw new Error(`split target "${name}" already exists`);
    }
  }
  const rest = table.columns.filter((c) => c.name !== column);
  const columns: EtlColumn[] = [
    ...rest,
    ...into.map((name) => ({ name, type: 'text' as EtlColumnType })),
  ];
  const rows = table.rows.map((r) => {
    const row: EtlRow = {};
    for (const c of rest) row[c.name] = r[c.name];
    const parts = r[column] === null ? [] : String(r[column]).split(delimiter);
    into.forEach((name, i) => {
      row[name] = i < parts.length ? parts[i] : null;
    });
    return row;
  });
  return { columns, rows };
}

export function mergeColumns(table: EtlTable, columns: string[], delimiter: string, into: string): EtlTable {
  for (const c of columns) requireColumn(table, c);
  if (columnNames(table).includes(into) && !columns.includes(into)) {
    throw new Error(`merge target "${into}" already exists`);
  }
  const rest = table.columns.filter((c) => !columns.includes(c.name));
  const result: EtlTable = {
    columns: [...rest, { name: into, type: 'text' }],
    rows: table.rows.map((r) => {
      const row: EtlRow = {};
      for (const c of rest) row[c.name] = r[c.name];
      row[into] = columns.map((c) => (r[c] === null ? '' : String(r[c]))).join(delimiter);
      return row;
    }),
  };
  return result;
}

// ---------------------------------------------------------------------------
// pivot / unpivot
// ---------------------------------------------------------------------------

function aggregateValues(agg: Aggregation, values: EtlValue[]): EtlValue {
  const nums = values.filter((v): v is number => typeof v === 'number');
  switch (agg) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return nums.length === 0 ? null : Math.min(...nums);
    case 'max': return nums.length === 0 ? null : Math.max(...nums);
    case 'count': return values.length;
    case 'count-distinct': return new Set(values.map(String)).size;
    case 'first': return values.length === 0 ? null : values[0];
    case 'last': return values.length === 0 ? null : values[values.length - 1];
  }
}

export function pivotTable(
  table: EtlTable,
  index: string[],
  column: string,
  value: string,
  agg: Aggregation,
): EtlTable {
  for (const c of [...index, column, value]) requireColumn(table, c);
  const pivotValues: string[] = [];
  const seen = new Set<string>();
  for (const r of table.rows) {
    const key = r[column] === null ? '' : String(r[column]);
    if (!seen.has(key)) { seen.add(key); pivotValues.push(key); }
  }
  const groups = new Map<string, { key: EtlRow; cells: Map<string, EtlValue[]> }>();
  for (const r of table.rows) {
    const gk = JSON.stringify(index.map((c) => r[c]));
    let g = groups.get(gk);
    if (!g) {
      const key: EtlRow = {};
      for (const c of index) key[c] = r[c];
      g = { key, cells: new Map() };
      groups.set(gk, g);
    }
    const ck = r[column] === null ? '' : String(r[column]);
    const list = g.cells.get(ck) ?? [];
    list.push(r[value]);
    g.cells.set(ck, list);
  }
  const columns: EtlColumn[] = [
    ...index.map((name) => table.columns.find((c) => c.name === name) ?? { name, type: 'unknown' as EtlColumnType }),
    ...pivotValues.map((name) => ({ name, type: 'number' as EtlColumnType })),
  ];
  const rows: EtlRow[] = [...groups.values()].map((g) => {
    const row: EtlRow = { ...g.key };
    for (const pv of pivotValues) {
      row[pv] = aggregateValues(agg, g.cells.get(pv) ?? []);
    }
    return row;
  });
  return { columns, rows };
}

export function unpivotTable(
  table: EtlTable,
  idColumns: string[],
  variableColumn: string,
  valueColumn: string,
  valueColumns?: string[],
): EtlTable {
  for (const c of idColumns) requireColumn(table, c);
  const vals = valueColumns ?? columnNames(table).filter((c) => !idColumns.includes(c));
  for (const c of vals) requireColumn(table, c);
  const columns: EtlColumn[] = [
    ...idColumns.map((name) => table.columns.find((c) => c.name === name) ?? { name, type: 'unknown' as EtlColumnType }),
    { name: variableColumn, type: 'text' },
    { name: valueColumn, type: 'unknown' },
  ];
  const rows: EtlRow[] = [];
  for (const r of table.rows) {
    for (const vc of vals) {
      const row: EtlRow = {};
      for (const c of idColumns) row[c] = r[c];
      row[variableColumn] = vc;
      row[valueColumn] = r[vc];
      rows.push(row);
    }
  }
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// join / append
// ---------------------------------------------------------------------------

export function joinTables(left: EtlTable, right: EtlTable, on: string[], how: JoinHow): EtlTable {
  for (const c of on) { requireColumn(left, c); requireColumn(right, c); }
  const rightExtra = columnNames(right).filter((c) => !on.includes(c));
  const columns: EtlColumn[] = [
    ...left.columns,
    ...right.columns.filter((c) => rightExtra.includes(c.name)),
  ];
  const keyOf = (r: EtlRow): string => JSON.stringify(on.map((c) => r[c]));
  const rightByKey = new Map<string, EtlRow[]>();
  for (const r of right.rows) {
    const k = keyOf(r);
    const list = rightByKey.get(k) ?? [];
    list.push(r);
    rightByKey.set(k, list);
  }
  const blankRight = (): EtlRow => {
    const row: EtlRow = {};
    for (const c of rightExtra) row[c] = null;
    return row;
  };
  const combine = (l: EtlRow, r: EtlRow): EtlRow => {
    const row: EtlRow = { ...l };
    for (const c of rightExtra) row[c] = r[c];
    return row;
  };
  const rows: EtlRow[] = [];
  const matchedRightKeys = new Set<string>();
  for (const l of left.rows) {
    const matches = rightByKey.get(keyOf(l)) ?? [];
    if (matches.length === 0) {
      if (how === 'left' || how === 'outer') rows.push(combine(l, blankRight()));
    } else {
      for (const m of matches) {
        rows.push(combine(l, m));
        matchedRightKeys.add(keyOf(m));
      }
    }
  }
  if (how === 'right' || how === 'outer') {
    for (const r of right.rows) {
      if (!matchedRightKeys.has(keyOf(r))) {
        const row: EtlRow = {};
        for (const c of columnNames(left)) row[c] = on.includes(c) ? r[c] : null;
        for (const c of rightExtra) row[c] = r[c];
        rows.push(row);
      }
    }
  }
  return { columns, rows };
}

export function appendTables(tables: EtlTable[]): EtlTable {
  if (tables.length === 0) return { columns: [], rows: [] };
  const columns = tables[0].columns;
  const names = columnNames(tables[0]);
  const rows: EtlRow[] = [];
  for (const t of tables) {
    for (const r of t.rows) {
      const row: EtlRow = {};
      for (const c of names) row[c] = c in r ? r[c] : null;
      rows.push(row);
    }
  }
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// group-by / fill-down / deduplicate
// ---------------------------------------------------------------------------

export interface GroupAggregation {
  column: string;
  agg: Aggregation;
  as: string;
}

export function groupBy(table: EtlTable, keys: string[], aggregations: GroupAggregation[]): EtlTable {
  for (const c of [...keys, ...aggregations.map((a) => a.column)]) requireColumn(table, c);
  const groups = new Map<string, { key: EtlRow; buckets: EtlValue[][] }>();
  for (const r of table.rows) {
    const gk = JSON.stringify(keys.map((c) => r[c]));
    let g = groups.get(gk);
    if (!g) {
      const key: EtlRow = {};
      for (const c of keys) key[c] = r[c];
      g = { key, buckets: aggregations.map(() => []) };
      groups.set(gk, g);
    }
    aggregations.forEach((a, i) => { g!.buckets[i].push(r[a.column]); });
  }
  const columns: EtlColumn[] = [
    ...keys.map((name) => table.columns.find((c) => c.name === name) ?? { name, type: 'unknown' as EtlColumnType }),
    ...aggregations.map((a) => ({ name: a.as, type: 'unknown' as EtlColumnType })),
  ];
  const rows: EtlRow[] = [...groups.values()].map((g) => {
    const row: EtlRow = { ...g.key };
    aggregations.forEach((a, i) => { row[a.as] = aggregateValues(a.agg, g!.buckets[i]); });
    return row;
  });
  return { columns, rows };
}

export function fillDown(table: EtlTable, column: string): EtlTable {
  requireColumn(table, column);
  let last: EtlValue = null;
  const rows = table.rows.map((r) => {
    if (r[column] !== null) last = r[column];
    return { ...r, [column]: r[column] === null ? last : r[column] };
  });
  return { columns: table.columns, rows };
}

export function deduplicate(table: EtlTable, columns?: string[], keep: 'first' | 'last' = 'first'): EtlTable {
  const keyCols = columns ?? columnNames(table);
  for (const c of keyCols) requireColumn(table, c);
  const seen = new Map<string, EtlRow>();
  const order: string[] = [];
  for (const r of table.rows) {
    const k = JSON.stringify(keyCols.map((c) => r[c]));
    if (keep === 'first') {
      if (!seen.has(k)) { seen.set(k, r); order.push(k); }
    } else {
      if (!seen.has(k)) order.push(k);
      seen.set(k, r);
    }
  }
  return { columns: table.columns, rows: order.map((k) => seen.get(k)!) };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Apply one transform op. `resolveTable` supplies the "other" table for
 * join/append; `custom` is rejected here — it needs a sandboxed code runner
 * (see custom.ts), which the ETL runner injects.
 */
export function applyTransform(
  table: EtlTable,
  op: TransformOp,
  resolveTable?: (t: TransformOp) => EtlTable,
): TransformResult {
  switch (op.op) {
    case 'select': return ok(selectColumns(table, op.columns));
    case 'drop': return ok(dropColumns(table, op.columns));
    case 'rename': return ok(renameColumns(table, op.mapping));
    case 'convert': return convertType(table, op.column, op.to);
    case 'filter': return ok(filterRows(table, op.column, op.operator, op.value));
    case 'sort': return ok(sortRows(table, op.keys));
    case 'split': return ok(splitColumn(table, op.column, op.delimiter, op.into));
    case 'merge-columns': return ok(mergeColumns(table, op.columns, op.delimiter, op.into));
    case 'pivot': return ok(pivotTable(table, op.index, op.column, op.value, op.agg));
    case 'unpivot': return ok(unpivotTable(table, op.idColumns, op.variableColumn, op.valueColumn, op.valueColumns));
    case 'join': {
      if (!resolveTable) throw new Error('join needs a table resolver for the "with" table');
      return ok(joinTables(table, resolveTable(op), op.on, op.how));
    }
    case 'append': {
      if (!resolveTable) throw new Error('append needs a table resolver for the "with" table');
      return ok(appendTables([table, resolveTable(op)]));
    }
    case 'group-by': return ok(groupBy(table, op.keys, op.aggregations));
    case 'fill-down': return ok(fillDown(table, op.column));
    case 'deduplicate': return ok(deduplicate(table, op.columns, op.keep));
    case 'custom':
      throw new Error('custom transforms need a sandboxed code runner — use runCustomTransform from custom.js');
  }
}
