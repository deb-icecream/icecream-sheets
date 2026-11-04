/**
 * Live pivot queries over a worksheet-range data model (#114, Piece 1).
 *
 * Pure module, beside the cube registry (cube-functions.ts): it never
 * touches the formula recalc chain and never imports the service package
 * (that would be circular — the service builds the model, this module
 * only executes a resolved query against plain data).
 *
 * A resolved pivot names its dimension table/column, the join column
 * shared with each fact table, and value definitions the service layer
 * already resolved (including calibration against the pivot's cached
 * outputs — see packages/service/src/dataModel.ts). This module trusts
 * those bindings and only aggregates; it never guesses a measure mapping.
 *
 * Filter semantics (Excel slicer behavior): a null/empty selection means
 * "all members". A filtered query returns ONLY the selected members, in
 * dimension-table order; non-selected members vanish (the pivot
 * contracts). A selected member with no fact rows sums to 0 (Excel SUM
 * over an empty set) and counts to 0; a ratio over a zero denominator
 * (or an average over no rows) is null.
 * Never throws for bad bindings — it returns an empty matrix so a
 * failed query degrades to "no refresh" upstream, never a broken open.
 */

export interface OlapModelTable {
  /** Model table name, e.g. 'tblCal'. Matched case-insensitively. */
  name: string;
  columns: string[];
  /** One record per data row: column name -> cell value. */
  rows: Record<string, unknown>[];
}

export interface OlapModel {
  tables: OlapModelTable[];
}

export type OlapResolvedValue =
  | {
      kind: 'sum' | 'count' | 'average' | 'max' | 'min' | 'product';
      /** Display label, e.g. 'Sum of Revenue'. */
      label: string;
      /** Fact table holding the column. */
      table: string;
      column: string;
      /** -1 when the model measure is the negated column sum (calibrated). */
      sign?: 1 | -1;
    }
  | {
      kind: 'ratio';
      /** Display label, e.g. 'Sum of COGS Pct of Rev'. */
      label: string;
      /** Fact table holding both columns. */
      table: string;
      numeratorColumn: string;
      denominatorColumn: string;
    };

export interface OlapResolvedPivot {
  /** Pivot name, e.g. 'pvtEarnings'. */
  name: string;
  /** Dimension table, e.g. 'tblCal'. */
  dimensionTable: string;
  /** Dimension attribute column, e.g. 'Year'. */
  dimensionColumn: string;
  /**
   * Join key shared by the dimension table and every fact table, e.g.
   * 'Period'. Null when the fact table IS the dimension table (the
   * dimension value is read straight off the fact row).
   */
  joinColumn: string | null;
  values: OlapResolvedValue[];
}

export interface OlapPivotMatrix {
  /** Dimension member labels, in dimension-table order. */
  rowKeys: string[];
  /** data[rowIdx][valueIdx], aligned with rowKeys and pivot.values. */
  data: (number | null)[][];
}

function normKey(s: string): string {
  return s.trim().toLowerCase();
}

function findTable(model: OlapModel, name: string): OlapModelTable | undefined {
  const want = normKey(name);
  return model.tables.find((t) => normKey(t.name) === want);
}

function findColumn(row: Record<string, unknown>, column: string): unknown {
  const want = normKey(column);
  for (const key of Object.keys(row)) {
    if (normKey(key) === want) return row[key];
  }
  return undefined;
}

/** Display label for a dimension member value (2012 -> '2012'). */
export function olapMemberLabel(value: unknown): string {
  if (value === null || value === undefined) return '(blank)';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '(blank)';
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value).trim();
}

/**
 * Loose cell equality for join keys: numbers compare numerically
 * (1 == 1.0 == '1'), everything else compares as trimmed
 * case-insensitive strings. Null/blank never matches.
 */
function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (a === '' || b === '') return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  const an = typeof a === 'number' ? a : Number(String(a).trim());
  const bn = typeof b === 'number' ? b : Number(String(b).trim());
  if (Number.isFinite(an) && Number.isFinite(bn) && String(a).trim() !== '' && String(b).trim() !== '') {
    return an === bn;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Execute a resolved pivot query. `selected` is null/empty for "all
 * members"; otherwise only the listed member labels (compared loosely,
 * so '2012' matches the number 2012) are returned.
 */
export function queryOlapPivot(
  model: OlapModel,
  pivot: OlapResolvedPivot,
  selected: string[] | null,
): OlapPivotMatrix {
  try {
    const dimTable = findTable(model, pivot.dimensionTable);
    if (!dimTable) return { rowKeys: [], data: [] };
    // Dimension members in dimension-table order, deduplicated.
    const members: { label: string; value: unknown }[] = [];
    const seen = new Set<string>();
    for (const row of dimTable.rows) {
      const v = findColumn(row, pivot.dimensionColumn);
      const label = olapMemberLabel(v);
      if (label === '(blank)' || seen.has(label)) continue;
      seen.add(label);
      members.push({ label, value: v });
    }
    const wanted =
      selected === null || selected.length === 0
        ? null
        : new Set(selected.map((s) => s.trim().toLowerCase()));
    const kept = wanted === null ? members : members.filter((m) => wanted.has(m.label.toLowerCase()));
    if (kept.length === 0 || pivot.values.length === 0) {
      return { rowKeys: kept.map((m) => m.label), data: kept.map(() => pivot.values.map(() => null)) };
    }
    // Join: dimension value per fact row, per value's fact table.
    // Accumulators per member per value: sum, count, max, min, product,
    // plus ratio numerator/denominator sums.
    const sums = new Map<string, number[]>();
    const counts = new Map<string, number[]>();
    const maxes = new Map<string, (number | null)[]>();
    const mins = new Map<string, (number | null)[]>();
    const prods = new Map<string, number[]>();
    const ratioNums = new Map<string, number[]>();
    const ratioDens = new Map<string, number[]>();
    for (const m of kept) {
      sums.set(m.label, pivot.values.map(() => 0));
      counts.set(m.label, pivot.values.map(() => 0));
      maxes.set(m.label, pivot.values.map(() => null));
      mins.set(m.label, pivot.values.map(() => null));
      prods.set(m.label, pivot.values.map(() => 1));
      ratioNums.set(m.label, pivot.values.map(() => 0));
      ratioDens.set(m.label, pivot.values.map(() => 0));
    }
    const joinColumn = pivot.joinColumn;
    for (let vi = 0; vi < pivot.values.length; vi += 1) {
      const value = pivot.values[vi]!;
      const factTable = findTable(model, value.table);
      if (!factTable) continue;
      const isDimTable = normKey(factTable.name) === normKey(pivot.dimensionTable);
      for (const factRow of factTable.rows) {
        let dimValue: unknown;
        if (isDimTable || joinColumn === null) {
          dimValue = findColumn(factRow, pivot.dimensionColumn);
        } else {
          const key = findColumn(factRow, joinColumn);
          const dimRow = dimTable.rows.find((d) => looselyEqual(findColumn(d, joinColumn), key));
          if (!dimRow) continue;
          dimValue = findColumn(dimRow, pivot.dimensionColumn);
        }
        const label = olapMemberLabel(dimValue);
        if (!sums.has(label)) continue;
        if (value.kind === 'ratio') {
          const num = asNumber(findColumn(factRow, value.numeratorColumn));
          const den = asNumber(findColumn(factRow, value.denominatorColumn));
          if (num !== null) ratioNums.get(label)![vi]! += num;
          if (den !== null) ratioDens.get(label)![vi]! += den;
        } else {
          const n = asNumber(findColumn(factRow, value.column));
          if (n === null) continue;
          const signed = (value.sign ?? 1) * n;
          sums.get(label)![vi]! += signed;
          counts.get(label)![vi]! += 1;
          const prevMax = maxes.get(label)![vi]!;
          if (prevMax === null || signed > prevMax) maxes.get(label)![vi]! = signed;
          const prevMin = mins.get(label)![vi]!;
          if (prevMin === null || signed < prevMin) mins.get(label)![vi]! = signed;
          prods.get(label)![vi]! *= signed;
        }
      }
    }
    const data = kept.map((m) =>
      pivot.values.map((value, vi) => {
        if (value.kind === 'ratio') {
          const den = ratioDens.get(m.label)![vi]!;
          if (den === 0) return null;
          return ratioNums.get(m.label)![vi]! / den;
        }
        switch (value.kind) {
          case 'count':
            return counts.get(m.label)![vi]!;
          case 'average': {
            const c = counts.get(m.label)![vi]!;
            return c === 0 ? null : sums.get(m.label)![vi]! / c;
          }
          case 'max':
            return maxes.get(m.label)![vi]!;
          case 'min':
            return mins.get(m.label)![vi]!;
          case 'product':
            // No numeric rows: Excel PRODUCT over an empty set is 0 in a
            // pivot (not the multiplicative identity 1).
            return counts.get(m.label)![vi]! === 0 ? 0 : prods.get(m.label)![vi]!;
          case 'sum':
          default:
            // A member with no fact rows at all sums to 0 (Excel semantics).
            return sums.get(m.label)![vi]!;
        }
      }),
    );
    return { rowKeys: kept.map((m) => m.label), data };
  } catch {
    return { rowKeys: [], data: [] };
  }
}
