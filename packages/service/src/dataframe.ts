/**
 * DataFrame — columnar in-memory table for the service layer (ecosystem gap).
 *
 * A DataFrame stores data column-by-column (`DfColumn.values`) instead of
 * row-by-row. Columnar layout makes column operations (select a column,
 * aggregate a column, filter with a mask, type-convert a column) single
 * passes over dense arrays instead of per-row object walks — the same
 * reason pandas/Arrow are columnar.
 *
 * Python integration: `toColumnDict()` / `DataFrame.fromColumnDict()` move
 * data across the sandbox boundary as `{ column: [...] }`, which is exactly
 * the shape `pandas.DataFrame(dict)` consumes, so sandboxed Python
 * (PY() formulas, ETL `custom` python steps) can hand a DataFrame back and
 * forth without row reshaping. `toEtlTable()` / `fromEtlTable()` bridge to
 * the ETL pipeline's row-oriented EtlTable.
 *
 * All operations are immutable (they return new DataFrames); nulls are
 * first-class (EtlValue-compatible).
 */

import {
  type EtlColumnType,
  type EtlTable,
  type EtlValue,
} from './etl/types.js';

export type DfValue = EtlValue;
export type DfColumnType = 'string' | 'number' | 'boolean' | 'date' | 'unknown';

export interface DfColumn {
  name: string;
  type: DfColumnType;
  /** Dense columnar values; length === rowCount for every column. */
  values: DfValue[];
}

export type DfAgg = 'sum' | 'mean' | 'min' | 'max' | 'count' | 'nunique' | 'first' | 'last';

export interface DfGroupAgg {
  column: string;
  agg: DfAgg;
  as: string;
}

function inferType(values: DfValue[]): DfColumnType {
  let seen: DfColumnType | null = null;
  for (const v of values) {
    if (v === null) continue;
    const t: DfColumnType = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
    if (seen === null) seen = t;
    else if (seen !== t) return 'unknown';
  }
  return seen ?? 'unknown';
}

function etlTypeToDf(t: EtlColumnType): DfColumnType {
  return t === 'text' ? 'string' : t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : t === 'date' ? 'date' : 'unknown';
}

function dfTypeToEtl(t: DfColumnType): EtlColumnType {
  return t === 'string' ? 'text' : t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : t === 'date' ? 'date' : 'unknown';
}

export class DataFrame {
  private readonly cols: DfColumn[];

  constructor(columns: DfColumn[]) {
    const names = columns.map((c) => c.name);
    if (new Set(names).size !== names.length) {
      throw new Error('DataFrame: duplicate column names');
    }
    const n = columns.length > 0 ? columns[0].values.length : 0;
    for (const c of columns) {
      if (c.values.length !== n) {
        throw new Error(`DataFrame: column "${c.name}" has ${c.values.length} values, expected ${n}`);
      }
    }
    this.cols = columns.map((c) => ({ name: c.name, type: c.type, values: [...c.values] }));
  }

  // -- construction ----------------------------------------------------------

  static empty(): DataFrame {
    return new DataFrame([]);
  }

  /** Build from row objects; column order = first-seen key order. */
  static fromRows(rows: Record<string, DfValue>[]): DataFrame {
    const names: string[] = [];
    for (const r of rows) {
      for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k);
    }
    const columns = names.map((name) => {
      const values = rows.map((r) => (name in r ? r[name]! : null));
      return { name, type: inferType(values), values };
    });
    return new DataFrame(columns);
  }

  /** Build from parallel column arrays. */
  static fromColumns(names: string[], columns: DfValue[][], types?: DfColumnType[]): DataFrame {
    if (names.length !== columns.length) throw new Error('DataFrame.fromColumns: names/columns length mismatch');
    return new DataFrame(
      names.map((name, i) => ({
        name,
        type: types?.[i] ?? inferType(columns[i]),
        values: [...columns[i]],
      })),
    );
  }

  /** Column-dict form: `{ col: [...] }` — the pandas handoff shape. */
  static fromColumnDict(dict: Record<string, DfValue[]>): DataFrame {
    return DataFrame.fromColumns(Object.keys(dict), Object.values(dict));
  }

  static fromEtlTable(table: EtlTable): DataFrame {
    return new DataFrame(
      table.columns.map((c) => ({
        name: c.name,
        type: etlTypeToDf(c.type),
        values: table.rows.map((r) => r[c.name] ?? null),
      })),
    );
  }

  // -- shape -----------------------------------------------------------------

  get columnNames(): string[] {
    return this.cols.map((c) => c.name);
  }

  get rowCount(): number {
    return this.cols.length === 0 ? 0 : this.cols[0].values.length;
  }

  get columnCount(): number {
    return this.cols.length;
  }

  column(name: string): DfValue[] {
    const c = this.cols.find((x) => x.name === name);
    if (!c) throw new Error(`DataFrame: unknown column "${name}"`);
    return [...c.values];
  }

  columnType(name: string): DfColumnType {
    const c = this.cols.find((x) => x.name === name);
    if (!c) throw new Error(`DataFrame: unknown column "${name}"`);
    return c.type;
  }

  // -- export ------------------------------------------------------------------

  /** Row-oriented export. */
  toRows(): Record<string, DfValue>[] {
    const rows: Record<string, DfValue>[] = [];
    for (let i = 0; i < this.rowCount; i++) {
      const r: Record<string, DfValue> = {};
      for (const c of this.cols) r[c.name] = c.values[i];
      rows.push(r);
    }
    return rows;
  }

  /** Column-dict export: `{ col: [...] }` — feed straight to pandas.DataFrame. */
  toColumnDict(): Record<string, DfValue[]> {
    const out: Record<string, DfValue[]> = {};
    for (const c of this.cols) out[c.name] = [...c.values];
    return out;
  }

  toEtlTable(): EtlTable {
    return {
      columns: this.cols.map((c) => ({ name: c.name, type: dfTypeToEtl(c.type) })),
      rows: this.toRows(),
    };
  }

  /** JSON-serializable columnar snapshot (metadata store / MCP transport). */
  toJSON(): { columns: { name: string; type: DfColumnType }[]; data: DfValue[][] } {
    return {
      columns: this.cols.map((c) => ({ name: c.name, type: c.type })),
      data: this.cols.map((c) => [...c.values]),
    };
  }

  static fromJSON(snap: { columns: { name: string; type: DfColumnType }[]; data: DfValue[][] }): DataFrame {
    if (snap.columns.length !== snap.data.length) throw new Error('DataFrame.fromJSON: columns/data length mismatch');
    return new DataFrame(snap.columns.map((c, i) => ({ name: c.name, type: c.type, values: [...snap.data[i]] })));
  }

  // -- column operations (single pass over the column array) -------------------

  select(names: string[]): DataFrame {
    return new DataFrame(names.map((n) => {
      const c = this.cols.find((x) => x.name === n);
      if (!c) throw new Error(`DataFrame.select: unknown column "${n}"`);
      return { ...c, values: [...c.values] };
    }));
  }

  drop(names: string[]): DataFrame {
    const dropSet = new Set(names);
    return new DataFrame(this.cols.filter((c) => !dropSet.has(c.name)));
  }

  rename(mapping: Record<string, string>): DataFrame {
    return new DataFrame(
      this.cols.map((c) => ({ ...c, name: mapping[c.name] ?? c.name, values: [...c.values] })),
    );
  }

  /**
   * Add or replace a column. `values` may be an array or a per-row function
   * receiving the row object (materialized lazily per row).
   */
  withColumn(name: string, values: DfValue[] | ((row: Record<string, DfValue>, i: number) => DfValue), type?: DfColumnType): DataFrame {
    const vals = Array.isArray(values) ? [...values] : this.toRows().map((r, i) => (values as (row: Record<string, DfValue>, i: number) => DfValue)(r, i));
    if (vals.length !== this.rowCount) {
      throw new Error(`DataFrame.withColumn: ${vals.length} values for ${this.rowCount} rows`);
    }
    const next = this.cols.filter((c) => c.name !== name);
    next.push({ name, type: type ?? inferType(vals), values: vals });
    // Preserve original column order when replacing.
    const order = this.columnNames.includes(name) ? this.columnNames : [...this.columnNames, name];
    const byName = new Map(next.map((c) => [c.name, c]));
    return new DataFrame(order.map((n) => byName.get(n)!));
  }

  /** Keep rows where `predicate(row, i)` is true. Builds one boolean mask, then filters each column. */
  filter(predicate: (row: Record<string, DfValue>, i: number) => boolean): DataFrame {
    const mask: boolean[] = [];
    const rows = this.toRows();
    for (let i = 0; i < rows.length; i++) mask.push(predicate(rows[i], i));
    return this.filterMask(mask);
  }

  /** Keep rows where mask[i] is true — the vectorized filter primitive. */
  filterMask(mask: boolean[]): DataFrame {
    if (mask.length !== this.rowCount) throw new Error('DataFrame.filterMask: mask length mismatch');
    return new DataFrame(
      this.cols.map((c) => ({ ...c, values: c.values.filter((_, i) => mask[i]) })),
    );
  }

  sortBy(keys: { column: string; dir?: 'asc' | 'desc' }[]): DataFrame {
    const idx = Array.from({ length: this.rowCount }, (_, i) => i);
    const rows = this.toRows();
    idx.sort((a, b) => {
      for (const k of keys) {
        const dir = k.dir === 'desc' ? -1 : 1;
        const cmp = compareDf(rows[a][k.column] ?? null, rows[b][k.column] ?? null);
        if (cmp !== 0) return cmp * dir;
      }
      return 0;
    });
    return new DataFrame(this.cols.map((c) => ({ ...c, values: idx.map((i) => c.values[i]) })));
  }

  head(n: number): DataFrame {
    return this.slice(0, n);
  }

  tail(n: number): DataFrame {
    return this.slice(Math.max(0, this.rowCount - n), this.rowCount);
  }

  slice(start: number, end: number): DataFrame {
    return new DataFrame(this.cols.map((c) => ({ ...c, values: c.values.slice(start, end) })));
  }

  /** Fill nulls in a column (scalar or 'ffill'). */
  fillNull(column: string, value: DfValue | 'ffill'): DataFrame {
    const values = this.column(column);
    if (value === 'ffill') {
      let last: DfValue = null;
      for (let i = 0; i < values.length; i++) {
        if (values[i] === null) values[i] = last;
        else last = values[i];
      }
    } else {
      for (let i = 0; i < values.length; i++) if (values[i] === null) values[i] = value;
    }
    return this.withColumn(column, values, this.columnType(column));
  }

  deduplicate(columns?: string[]): DataFrame {
    const keyCols = columns ?? this.columnNames;
    const seen = new Set<string>();
    const mask = this.toRows().map((r) => {
      const k = JSON.stringify(keyCols.map((c) => r[c] ?? null));
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return this.filterMask(mask);
  }

  // -- aggregations (single pass over one column array) -------------------------

  private numericValues(column: string): number[] {
    return this.column(column).filter((v): v is number => typeof v === 'number');
  }

  agg(column: string, agg: DfAgg): DfValue {
    const vals = this.column(column);
    const nums = this.numericValues(column);
    switch (agg) {
      case 'sum': return nums.reduce((a, b) => a + b, 0);
      case 'mean': return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
      case 'min': {
        let best: DfValue = null;
        for (const v of vals) if (v !== null && (best === null || compareDf(v, best) < 0)) best = v;
        return best;
      }
      case 'max': {
        let best: DfValue = null;
        for (const v of vals) if (v !== null && (best === null || compareDf(v, best) > 0)) best = v;
        return best;
      }
      case 'count': return vals.filter((v) => v !== null).length;
      case 'nunique': return new Set(vals.filter((v) => v !== null).map((v) => JSON.stringify(v))).size;
      case 'first': return vals.find((v) => v !== null) ?? null;
      case 'last': {
        for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return vals[i];
        return null;
      }
    }
  }

  /** Per-column summary: type, non-null count, and numeric stats when applicable. */
  describe(): Record<string, { type: DfColumnType; count: number; nulls: number; sum?: number; mean?: number; min?: DfValue; max?: DfValue; nunique?: number }> {
    const out: Record<string, { type: DfColumnType; count: number; nulls: number; sum?: number; mean?: number; min?: DfValue; max?: DfValue; nunique?: number }> = {};
    for (const c of this.cols) {
      const nonNull = c.values.filter((v) => v !== null);
      const entry: { type: DfColumnType; count: number; nulls: number; sum?: number; mean?: number; min?: DfValue; max?: DfValue; nunique?: number } = {
        type: c.type,
        count: nonNull.length,
        nulls: c.values.length - nonNull.length,
        nunique: new Set(nonNull.map((v) => JSON.stringify(v))).size,
      };
      if (c.type === 'number') {
        const nums = nonNull as number[];
        entry.sum = nums.reduce((a, b) => a + b, 0);
        entry.mean = nums.length > 0 ? entry.sum / nums.length : undefined;
        entry.min = nums.length > 0 ? Math.min(...nums) : undefined;
        entry.max = nums.length > 0 ? Math.max(...nums) : undefined;
      } else if (nonNull.length > 0) {
        let mn = nonNull[0];
        let mx = nonNull[0];
        for (const v of nonNull) {
          if (compareDf(v, mn) < 0) mn = v;
          if (compareDf(v, mx) > 0) mx = v;
        }
        entry.min = mn;
        entry.max = mx;
      }
      out[c.name] = entry;
    }
    return out;
  }

  groupBy(keys: string[], aggs: DfGroupAgg[]): DataFrame {
    for (const k of keys) this.column(k); // validates
    const groups = new Map<string, { keyVals: DfValue[]; indices: number[] }>();
    const rows = this.toRows();
    rows.forEach((r, i) => {
      const gk = JSON.stringify(keys.map((k) => r[k] ?? null));
      let g = groups.get(gk);
      if (!g) {
        g = { keyVals: keys.map((k) => r[k] ?? null), indices: [] };
        groups.set(gk, g);
      }
      g.indices.push(i);
    });
    const outNames = [...keys, ...aggs.map((a) => a.as)];
    const outCols: DfValue[][] = outNames.map(() => []);
    for (const g of groups.values()) {
      const sub = new DataFrame(this.cols.map((c) => ({ ...c, values: g.indices.map((i) => c.values[i]) })));
      keys.forEach((k, ki) => outCols[ki].push(g.keyVals[ki]));
      aggs.forEach((a, ai) => outCols[keys.length + ai].push(sub.agg(a.column, a.agg)));
    }
    return DataFrame.fromColumns(outNames, outCols);
  }

  join(other: DataFrame, on: string[], how: 'inner' | 'left' | 'right' | 'outer' = 'inner'): DataFrame {
    for (const k of on) { this.column(k); other.column(k); }
    const buildIndex = (df: DataFrame): Map<string, number[]> => {
      const idx = new Map<string, number[]>();
      df.toRows().forEach((r, i) => {
        const k = JSON.stringify(on.map((c) => r[c] ?? null));
        const arr = idx.get(k);
        if (arr) arr.push(i);
        else idx.set(k, [i]);
      });
      return idx;
    };
    const leftIdx = buildIndex(this);
    const rightIdx = buildIndex(other);
    const rightExtra = other.columnNames.filter((c) => !on.includes(c) && !this.columnNames.includes(c));
    // Overlapping non-key columns from the right get suffixed.
    const rightOverlap = other.columnNames.filter((c) => !on.includes(c) && this.columnNames.includes(c));
    const pairs: [number | null, number | null][] = [];
    const matchedRight = new Set<number>();
    this.toRows().forEach((_, li) => {
      const k = JSON.stringify(on.map((c) => this.cols.find((x) => x.name === c)!.values[li] ?? null));
      const ris = rightIdx.get(k);
      if (ris && ris.length > 0) {
        for (const ri of ris) { pairs.push([li, ri]); matchedRight.add(ri); }
      } else if (how === 'left' || how === 'outer') {
        pairs.push([li, null]);
      }
    });
    if (how === 'right' || how === 'outer') {
      other.toRows().forEach((_, ri) => {
        if (!matchedRight.has(ri)) pairs.push([null, ri]);
      });
    }
    const outNames = [...this.columnNames, ...rightExtra, ...rightOverlap.map((c) => `${c}_right`)];
    const outCols: DfValue[][] = outNames.map(() => []);
    const leftRows = this.toRows();
    const rightRows = other.toRows();
    for (const [li, ri] of pairs) {
      const lr = li !== null ? leftRows[li] : null;
      const rr = ri !== null ? rightRows[ri] : null;
      let ci = 0;
      for (const c of this.columnNames) outCols[ci++].push(lr ? (lr[c] ?? null) : (rr && on.includes(c) ? (rr[c] ?? null) : null));
      for (const c of rightExtra) outCols[ci++].push(rr ? (rr[c] ?? null) : null);
      for (const c of rightOverlap) outCols[ci++].push(rr ? (rr[c] ?? null) : null);
    }
    return DataFrame.fromColumns(outNames, outCols);
  }

  /** Inner append (union of rows; missing columns become null). */
  append(other: DataFrame): DataFrame {
    const names = [...this.columnNames];
    for (const n of other.columnNames) if (!names.includes(n)) names.push(n);
    const get = (df: DataFrame, name: string): DfValue[] => {
      try { return df.column(name); } catch { return new Array(df.rowCount).fill(null); }
    };
    return DataFrame.fromColumns(
      names,
      names.map((n) => [...get(this, n), ...get(other, n)]),
    );
  }
}

function compareDf(a: DfValue, b: DfValue): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
