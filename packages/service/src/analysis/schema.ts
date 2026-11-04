/**
 * Data-analysis schema extraction (design-docs: data-analysis component).
 *
 * Extracts a DataSchema from a sheet range through the typed computational
 * view. This module never touches the engine or storage: the host supplies
 * a RangeReader port bound to host.readRange(...) (or an MCP read_cells
 * result), so the module stays headless and browser-safe.
 *
 * Column type inference reuses the app builder's approach
 * (packages/service/src/appbuilder/model.ts: inferColumnType) — a strict
 * majority of non-empty values earns a non-text type, denied (#PERM!) and
 * empty cells are ignored, and mixed columns stay text.
 */

import { inferColumnType, isDenied, type CellInput } from '../appbuilder/model.js';
import type { ColumnType } from '../appbuilder/spec.js';

export type { CellInput };

/** 0-based, per-cell coordinates as the reader port sees them. */
export interface RangeRef {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Reader port over the typed computational view. The host binds this to
 * the engine's readRange (through authorize()), so denied cells arrive as
 * { error: '#PERM!' } and are excluded from schema statistics below.
 */
export type RangeReader = (
  sheet: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
) => Promise<CellInput[][]> | CellInput[][];

export interface NumericStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  /** Sample standard deviation (null when fewer than 2 values). */
  stdev: number | null;
}

export interface CategoricalStats {
  distinct: number;
  /** Top values by frequency, capped for schema brevity. */
  topValues: { value: string; count: number }[];
}

export interface DateStats {
  count: number;
  min: string;
  max: string;
}

/** Per-column summary statistics used by the Python generator templates. */
export interface ColumnStats {
  /** Non-empty, non-denied values observed. */
  nonEmpty: number;
  nullCount: number;
  numeric: NumericStats | null;
  categorical: CategoricalStats | null;
  date: DateStats | null;
}

export interface ColumnInfo {
  name: string;
  /** 0-based index within the extracted range. */
  index: number;
  inferredType: ColumnType;
  stats: ColumnStats;
}

/** The data schema handed to the Python generator: what the data looks like. */
export interface DataSchema {
  sheet: string;
  /** Human-readable A1-style reference, e.g. "Sheet1!A1:D21". */
  rangeRef: string;
  /** Data rows (excluding the header row when present). */
  rowCount: number;
  /**
   * Whether the range's first row was consumed as the header row (column
   * names) instead of as data. Consumers that re-read the range (the
   * analysis pipeline's Python input, rerun_analysis) MUST slice off the
   * first row iff this is true — the header decision is made ONCE, here,
   * and never re-decided (or silently assumed) downstream.
   */
  hasHeaderRow: boolean;
  columns: ColumnInfo[];
}

const TOP_VALUES_CAP = 10;

/** Convert a range to an A1-style reference string. */
export function a1Ref(ref: RangeRef): string {
  const col = (i: number): string => {
    let n = i + 1;
    let s = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const cell = (r: number, c: number): string => `${col(c)}${r + 1}`;
  const a = cell(ref.startRow, ref.startCol);
  const b = cell(ref.endRow, ref.endCol);
  return `${ref.sheet}!${a}${a === b ? '' : `:${b}`}`;
}

function isEmpty(v: CellInput): boolean {
  return v === null || v === undefined || v === '' || isDenied(v);
}

function toNumber(v: CellInput): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v.trim()))) {
    return Number(v.trim());
  }
  return null;
}

function displayOf(v: CellInput): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function numericStats(values: number[]): NumericStats | null {
  if (values.length === 0) return null;
  let min = values[0]!;
  let max = values[0]!;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / values.length;
  let stdev: number | null = null;
  if (values.length >= 2) {
    let sq = 0;
    for (const v of values) sq += (v - mean) * (v - mean);
    stdev = Math.sqrt(sq / (values.length - 1));
  }
  return { count: values.length, min, max, mean, stdev };
}

function categoricalStats(values: CellInput[]): CategoricalStats | null {
  const present = values.filter((v) => !isEmpty(v));
  if (present.length === 0) return null;
  const freq = new Map<string, number>();
  for (const v of present) {
    const k = displayOf(v);
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  const topValues = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_VALUES_CAP)
    .map(([value, count]) => ({ value, count }));
  return { distinct: freq.size, topValues };
}

function dateStats(values: CellInput[]): DateStats | null {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const dates: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string' || isEmpty(v)) continue;
    const t = v.trim();
    if (ISO_RE.test(t) && !Number.isNaN(new Date(t).getTime())) dates.push(t);
  }
  if (dates.length === 0) return null;
  dates.sort();
  return { count: dates.length, min: dates[0]!, max: dates[dates.length - 1]! };
}

function columnStats(values: CellInput[], inferredType: ColumnType): ColumnStats {
  const present = values.filter((v) => !isEmpty(v));
  const nullCount = values.length - present.length;
  const nums: number[] = [];
  for (const v of present) {
    const n = toNumber(v);
    if (n !== null) nums.push(n);
  }
  return {
    nonEmpty: present.length,
    nullCount,
    numeric: inferredType === 'numeric' || inferredType === 'boolean' ? numericStats(nums) : null,
    categorical:
      inferredType === 'text' || inferredType === 'reference' || inferredType === 'boolean'
        ? categoricalStats(values)
        : null,
    date: inferredType === 'date' ? dateStats(values) : null,
  };
}

export interface ExtractOptions {
  /**
   * Header contract for the range's first row:
   * - true: the caller DECLARES the first row is a header row — it names
   *   the columns and is excluded from the data rows.
   * - false: the caller DECLARES the range is data-only — EVERY row is a
   *   data row and synthetic "Column N" names are used.
   * - omitted: auto-detect via detectHeaderRow() — the first row counts
   *   as a header only when it looks like one. A range supplied as data
   *   therefore aggregates ALL of its rows; extraction never silently
   *   drops the first row of a data range.
   */
  headerRow?: boolean;
}

/**
 * Decide whether a grid's first row is a header row (column labels) rather
 * than a data row. A row "looks like a header" when every non-empty cell is
 * a non-numeric string AND at least one of those label cells sits over a
 * column containing numeric values below it — labels over measures. A first
 * row containing a number, a boolean, or a numeric string is data; so is a
 * text-only first row with no numeric column beneath it (a lone category
 * column's first value is data, not a label). Fewer than two rows can never
 * be a header (there would be no data left to label). Denied (#PERM!) cells
 * are invisible and count as empty.
 */
export function detectHeaderRow(grid: CellInput[][]): boolean {
  if (grid.length < 2) return false;
  const first = grid[0]!;
  const labelCols: number[] = [];
  for (let c = 0; c < first.length; c++) {
    const v = first[c];
    if (isEmpty(v)) continue;
    if (typeof v !== 'string' || toNumber(v) !== null) return false;
    labelCols.push(c);
  }
  if (labelCols.length === 0) return false;
  return labelCols.some((c) =>
    grid.slice(1).some((row) => {
      const below = row[c];
      return below !== undefined && !isEmpty(below) && toNumber(below) !== null;
    }),
  );
}

/**
 * Extract the data schema for a rectangular range.
 *
 * Headers come from the first row when it is a header row (see
 * ExtractOptions for the contract; blank header cells fall back to
 * "Column N"); every other cell is a data cell. Denied (#PERM!)
 * cells are treated as invisible: they contribute to neither headers nor
 * statistics, so schema extraction never leaks values the subject cannot
 * read (permission-model.md §4).
 */
export async function extractDataSchema(
  reader: RangeReader,
  range: RangeRef,
  opts: ExtractOptions = {},
): Promise<DataSchema> {
  const grid = await reader(range.sheet, range.startRow, range.startCol, range.endRow, range.endCol);
  const hasHeaderRow = opts.headerRow ?? detectHeaderRow(grid);
  const colCount = range.endCol - range.startCol + 1;
  const headers: string[] = [];
  for (let c = 0; c < colCount; c++) {
    const raw = hasHeaderRow && grid.length > 0 ? grid[0]![c] : null;
    const text = raw === null || raw === undefined || isEmpty(raw) ? '' : displayOf(raw).trim();
    headers.push(text !== '' ? text : `Column ${c + 1}`);
  }
  const dataRows = hasHeaderRow ? grid.slice(1) : grid;
  const columns: ColumnInfo[] = headers.map((name, index) => {
    const values = dataRows.map((row) => (index < row.length ? row[index]! : null));
    const inferredType = inferColumnType(name, values);
    return { name, index, inferredType, stats: columnStats(values, inferredType) };
  });
  return {
    sheet: range.sheet,
    rangeRef: a1Ref(range),
    rowCount: dataRows.length,
    hasHeaderRow,
    columns,
  };
}

/** Column names whose inferred type is numeric (usable as measure axes). */
export function numericColumns(schema: DataSchema): ColumnInfo[] {
  return schema.columns.filter((c) => c.inferredType === 'numeric');
}

/** Column names usable as category/label axes (text, date, boolean, reference). */
export function categoricalColumns(schema: DataSchema): ColumnInfo[] {
  return schema.columns.filter(
    (c) =>
      c.inferredType === 'text' ||
      c.inferredType === 'date' ||
      c.inferredType === 'boolean' ||
      c.inferredType === 'reference',
  );
}

/**
 * Force one extracted column to categorical ('text') with recomputed
 * stats. For the horizontal-year transposition (#152 remaining scope):
 * the transposed dimension column holds year labels as STRINGS, but
 * inferColumnType counts numeric strings as NUMERIC (majority isNum),
 * so the transposed schema has zero categorical columns and aggregate
 * plans fail with 'group-by needs a category column' unless the
 * dimension name happens to match a hint exactly (the #152 e2e passed
 * only via that coincidence: 'Year' above the run). The dimension IS
 * categorical by construction (labels, not measures), so forcing it is
 * a correction, not a guess — group resolution then works via the
 * category pool regardless of the dimension's name or the hints.
 * Names, order, and every other column are untouched.
 */
export function forceTextColumn(
  schema: DataSchema,
  index: number,
  values: CellInput[],
): DataSchema {
  const columns = schema.columns.map((c, i) =>
    i === index ? { ...c, inferredType: 'text' as const, stats: columnStats(values, 'text') } : c,
  );
  return { ...schema, columns };
}
