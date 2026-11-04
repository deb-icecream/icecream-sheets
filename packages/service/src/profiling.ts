/**
 * Column statistics profiling (Data > Column Statistics).
 *
 * Computes a descriptive-statistics profile for a column (or any list of
 * values): counts, unique/null counts, data-type distribution, numeric
 * aggregates (min/max/mean/median/stddev), and most-common values.
 *
 * SERVICE-LAYER, pure and headless: operates on plain JSON values read
 * through the typed computational view. It imports nothing from
 * workbook.ts, protocol.ts, or any storage code.
 */

export interface TypeDistribution {
  number: number;
  text: number;
  boolean: number;
  date: number;
  error: number;
  blank: number;
}

export interface CommonValue {
  /** Display label of the value. */
  value: string;
  count: number;
}

export interface ColumnProfile {
  /** Header text, or the column letter when there is no header. */
  name: string;
  /** Non-blank values. */
  count: number;
  blankCount: number;
  uniqueCount: number;
  typeCounts: TypeDistribution;
  /** Numeric aggregates over finite numbers; null when there are none. */
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  /** Sample standard deviation (n-1), Excel STDEV.S convention; null when < 2 values. */
  stddev: number | null;
  /** Most common non-blank values, count-descending then label-ascending. */
  mostCommon: CommonValue[];
}

export interface ProfileColumnInput {
  name: string;
  values: unknown[];
}

export interface ProfileOptions {
  /** How many most-common values to keep. Default 5. */
  topN?: number;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

function isErrorValue(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'error' in v;
}

/** Display label for a value (pivot/slicer convention). */
function labelOf(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString();
  if (isErrorValue(v)) return String((v as { error: unknown }).error);
  return String(v);
}

/** Canonical key that keeps numbers, booleans and strings distinct. */
function keyOf(v: unknown): string {
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  if (v instanceof Date) return `d:${v.getTime()}`;
  if (isErrorValue(v)) return `e:${String((v as { error: unknown }).error)}`;
  return `s:${String(v)}`;
}

function classify(v: unknown): keyof TypeDistribution {
  if (isBlank(v)) return 'blank';
  if (isErrorValue(v)) return 'error';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (v instanceof Date) return 'date';
  return 'text';
}

/**
 * Profile one column of values. Non-finite numbers (NaN/Infinity) count
 * as numbers for type distribution but are excluded from aggregates.
 */
export function profileColumn(input: ProfileColumnInput, opts: ProfileOptions = {}): ColumnProfile {
  const topN = Math.max(1, opts.topN ?? 5);
  const typeCounts: TypeDistribution = { number: 0, text: 0, boolean: 0, date: 0, error: 0, blank: 0 };
  const nums: number[] = [];
  const freq = new Map<string, { label: string; count: number }>();
  const seen = new Set<string>();
  let count = 0;

  for (const v of input.values) {
    typeCounts[classify(v)] += 1;
    if (isBlank(v)) continue;
    count += 1;
    seen.add(keyOf(v));
    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
    const label = labelOf(v);
    const key = keyOf(v);
    const entry = freq.get(key);
    if (entry) entry.count += 1;
    else freq.set(key, { label, count: 1 });
  }

  let min: number | null = null;
  let max: number | null = null;
  let mean: number | null = null;
  let median: number | null = null;
  let stddev: number | null = null;
  if (nums.length > 0) {
    const sorted = [...nums].sort((a, b) => a - b);
    min = sorted[0];
    max = sorted[sorted.length - 1];
    const sum = nums.reduce((a, b) => a + b, 0);
    mean = sum / nums.length;
    const mid = Math.floor(sorted.length / 2);
    median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    if (nums.length > 1 && mean !== null) {
      const m = mean;
      const variance = nums.reduce((a, b) => a + (b - m) * (b - m), 0) / (nums.length - 1);
      stddev = Math.sqrt(variance);
    }
  }

  const mostCommon = [...freq.values()]
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, topN)
    .map(({ label, count: c }) => ({ value: label, count: c }));

  return {
    name: input.name,
    count,
    blankCount: typeCounts.blank,
    uniqueCount: seen.size,
    typeCounts,
    min,
    max,
    mean,
    median,
    stddev,
    mostCommon,
  };
}

/** Profile several columns at once (one profile per input). */
export function profileColumnSet(inputs: ProfileColumnInput[], opts: ProfileOptions = {}): ColumnProfile[] {
  return inputs.map((input) => profileColumn(input, opts));
}

/**
 * Convenience: profile grid columns. `headers` names each column;
 * `columns[i]` holds that column's values (ragged arrays are fine).
 */
export function profileGrid(headers: string[], columns: unknown[][], opts: ProfileOptions = {}): ColumnProfile[] {
  return headers.map((name, i) => profileColumn({ name, values: columns[i] ?? [] }, opts));
}
