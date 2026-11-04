/**
 * PivotTable component — native reports (see design-docs/native-reports-and-dashboards.md).
 *
 * This is a SERVICE-LAYER component, not engine core. Per the design, the
 * report builder/renderer reads through the typed computational view and
 * never touches the engine or storage directly: this module operates purely
 * on plain JSON records that the caller obtained via TypedView. It imports
 * nothing from workbook.ts, protocol.ts, or any storage code.
 *
 * A pivot is described by a versioned, serializable spec (PivotSpec) so it
 * can live in the service metadata store and travel over the MCP protocol.
 */

export const PIVOT_SPEC_VERSION = 1 as const;

/** Aggregation functions Excel offers for pivot value fields (v1 set). */
export type PivotAggregation =
  | 'sum'
  | 'count'
  | 'average'
  | 'max'
  | 'min'
  | 'product'
  | 'countnums'
  | 'stdev'
  | 'var';

export const PIVOT_AGGREGATIONS: { id: PivotAggregation; label: string }[] = [
  { id: 'sum', label: 'Sum' },
  { id: 'count', label: 'Count' },
  { id: 'average', label: 'Average' },
  { id: 'max', label: 'Max' },
  { id: 'min', label: 'Min' },
  { id: 'product', label: 'Product' },
  { id: 'countnums', label: 'Count Numbers' },
  { id: 'stdev', label: 'StdDev' },
  { id: 'var', label: 'Var' },
];

export interface PivotValueField {
  /** Source field name. */
  field: string;
  aggregation: PivotAggregation;
  /** Display label; defaults to "Sum of <field>" etc. */
  label?: string;
}

export interface PivotFilter {
  /** Source field name. */
  field: string;
  /** Include-only list, matched against display labels. Empty = exclude all. */
  selected: string[];
}

/**
 * Versioned, serializable pivot spec. Data bindings (field names), layout
 * (rows/columns/values areas) and filters — no live references, so it can be
 * stored in the service metadata store and sent over MCP.
 */
export interface PivotSpec {
  version: typeof PIVOT_SPEC_VERSION;
  rows: string[];
  columns: string[];
  values: PivotValueField[];
  filters?: PivotFilter[];
  /**
   * Grouping operators for row/column fields (Excel's Group dialog).
   * Fields without an entry use exact-value grouping.
   */
  groupings?: PivotGrouping[];
}

/**
 * Grouping operators for pivot row/column fields (Excel's Group dialog).
 *
 * - date: bucket date values (Excel serials or parseable date strings) by
 *   year / quarter / month / ISO week / day.
 * - numeric: bucket numbers into fixed-width bins, Excel-style ("0-9").
 * - custom: map explicit value lists onto labels, in declared order.
 * Fields without a grouping entry keep exact-value grouping.
 */
export type PivotDateUnit = 'year' | 'quarter' | 'month' | 'week' | 'day';

export const PIVOT_DATE_UNITS: readonly PivotDateUnit[] = [
  'year',
  'quarter',
  'month',
  'week',
  'day',
];

export interface PivotDateGrouping {
  field: string;
  kind: 'date';
  unit: PivotDateUnit;
}

export interface PivotNumericGrouping {
  field: string;
  kind: 'numeric';
  /** Bin width; must be > 0. */
  by: number;
  /** Bin range start; defaults to the data minimum snapped down to `by`. */
  start?: number;
  /** Bin range end (exclusive); defaults to the data maximum snapped up. */
  end?: number;
}

export interface PivotCustomGroup {
  label: string;
  /** Values mapped to this label (matched by exact-value equality). */
  values: unknown[];
}

export interface PivotCustomGrouping {
  field: string;
  kind: 'custom';
  groups: PivotCustomGroup[];
}

export type PivotGrouping = PivotDateGrouping | PivotNumericGrouping | PivotCustomGrouping;

/** One record of source data: field name -> JSON value. */
export type PivotRecord = Record<string, unknown>;

export interface PivotResult {
  spec: PivotSpec;
  rowFieldNames: string[];
  colFieldNames: string[];
  /** Display label per value field, e.g. "Sum of Amount". */
  valueLabels: string[];
  /** Display labels of the row key tuples, in order. */
  rowKeys: string[][];
  /** Display labels of the column key tuples, in order. */
  colKeys: string[][];
  /** Aggregated values: data[rowIdx][colIdx][valueIdx]. */
  data: (number | null)[][][];
  /** Per-row totals across all columns, per value field. */
  rowTotals: (number | null)[][];
  /** Per-column totals across all rows, per value field. */
  colTotals: (number | null)[][];
  /** Grand totals, per value field. */
  grandTotals: (number | null)[];
  sourceRowCount: number;
  /** Rows surviving the filters. */
  filteredRowCount: number;
}

const BLANK_LABEL = '(blank)';

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/**
 * A grouped field value: a sortable key plus the display label. Produced by
 * applyGroupings() for date/numeric/custom groupings; keyOf()/labelOf()
 * below understand it so groups sort correctly (numeric bins numerically,
 * months chronologically, custom groups in declared order).
 */
export interface PivotGroupValue {
  readonly __pivotGroup: true;
  /** Sortable key — numbers sort numerically, strings lexicographically. */
  groupKey: number | string;
  /** Display label, e.g. "Q3 2026" or "0-9". */
  groupLabel: string;
  /**
   * The original field value before grouping. Aggregations unwrap to
   * this, so a field can be grouped on rows/columns AND aggregated as a
   * value field (Excel groups into a derived field; same semantics).
   */
  original: unknown;
}

export function isPivotGroupValue(v: unknown): v is PivotGroupValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __pivotGroup?: unknown }).__pivotGroup === true
  );
}

/** Canonical grouping key that keeps numbers and strings distinct. */
function keyOf(v: unknown): string {
  if (isPivotGroupValue(v)) {
    return typeof v.groupKey === 'number' ? `n:${v.groupKey}` : `s:${v.groupKey}`;
  }
  if (isBlank(v)) return 'b:';
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  return `s:${String(v)}`;
}

function labelOf(v: unknown): string {
  if (isPivotGroupValue(v)) return v.groupLabel;
  if (isBlank(v)) return BLANK_LABEL;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** Excel-like key ordering: numbers numerically, then strings, blanks last. */
function compareKeys(a: string, b: string): number {
  const ta = a.slice(0, 2);
  const tb = b.slice(0, 2);
  if (ta === 'b:') return tb === 'b:' ? 0 : 1;
  if (tb === 'b:') return -1;
  if (ta === 'n:' && tb === 'n:') return Number(a.slice(2)) - Number(b.slice(2));
  if (ta === 'n:') return -1;
  if (tb === 'n:') return 1;
  return a.slice(2).localeCompare(b.slice(2));
}

function keyToLabel(key: string): string {
  if (key === 'b:') return BLANK_LABEL;
  const kind = key.slice(0, 2);
  const raw = key.slice(2);
  if (kind === 'b:') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

function numbersOf(records: PivotRecord[], field: string): number[] {
  const out: number[] = [];
  for (const r of records) {
    const v = rawOf(r[field]);
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grouping operators (Excel's Group dialog): date / numeric / custom.
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Excel serial (1900 date system) -> UTC Date. */
function excelSerialToDate(serial: number): Date | null {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Accept Excel serials, Date objects and date strings; always UTC. */
function parsePivotDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return excelSerialToDate(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** ISO-8601 week number and its week-year for a date. */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - day + 3); // shift to Thursday
  const year = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400 * 1000));
  return { year, week };
}

function groupValue(key: number | string, groupLabel: string, original: unknown): PivotGroupValue {
  return { __pivotGroup: true, groupKey: key, groupLabel, original };
}

/** The pre-grouping value (aggregations always see originals). */
function rawOf(v: unknown): unknown {
  return isPivotGroupValue(v) ? v.original : v;
}

/**
 * Bucket one date value by unit. Returns null when the value is not a
 * date — the caller keeps the original value (exact grouping).
 */
export function groupDateValue(value: unknown, unit: PivotDateUnit): PivotGroupValue | null {
  const d = parsePivotDate(value);
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const mm = String(m + 1).padStart(2, '0');
  switch (unit) {
    case 'year':
      return groupValue(`${y}`, `${y}`, value);
    case 'quarter': {
      const q = Math.floor(m / 3) + 1;
      return groupValue(`${y}-Q${q}`, `Q${q} ${y}`, value);
    }
    case 'month':
      return groupValue(`${y}-${mm}`, `${MONTH_NAMES[m]} ${y}`, value);
    case 'week': {
      const { year, week } = isoWeek(d);
      const ww = String(week).padStart(2, '0');
      return groupValue(`${year}-W${ww}`, `W${week} ${year}`, value);
    }
    case 'day': {
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return groupValue(`${y}-${mm}-${dd}`, `${y}-${mm}-${dd}`, value);
    }
  }
}

function trimNum(n: number): string {
  return String(Number(n.toFixed(10)));
}

/**
 * Bucket one number into fixed-width bins. `dataMin`/`dataMax` seed the
 * default start/end when the grouping omits them. Values below `start`
 * land in a "< start" group, values at/above `end` in a ">= end" group.
 * Returns null for non-numbers (caller keeps the original value).
 */
export function groupNumericValue(
  value: unknown,
  g: PivotNumericGrouping,
  dataMin: number,
  dataMax: number,
): PivotGroupValue | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const by = g.by;
  const start = g.start ?? Math.floor(dataMin / by) * by;
  const span = Math.max(dataMax - start, by);
  const count = Math.max(1, Math.ceil(span / by - 1e-12));
  const end = g.end ?? start + count * by;
  if (value < start) return groupValue(-1, `< ${trimNum(start)}`, value);
  if (value >= end) return groupValue(count, `>= ${trimNum(end)}`, value);
  const i = Math.min(count - 1, Math.floor((value - start) / by));
  const lo = start + i * by;
  const label =
    Number.isInteger(by) && Number.isInteger(lo)
      ? `${trimNum(lo)}-${trimNum(lo + by - 1)}`
      : `${trimNum(lo)}-${trimNum(lo + by)}`;
  return groupValue(i, label, value);
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Numbers stored as text (or vice versa) still match, like Excel.
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b.trim();
  if (typeof a === 'string' && typeof b === 'number') return a.trim() === String(b);
  return false;
}

/**
 * Map one value onto a custom group label. Returns null when the value
 * matches no group — the caller keeps the original value.
 */
export function groupCustomValue(
  value: unknown,
  groups: PivotCustomGroup[],
): PivotGroupValue | null {
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i]!;
    if (g.values.some((x) => looseEqual(x, value))) {
      return groupValue(i, g.label, value);
    }
  }
  return null;
}

/**
 * Apply grouping operators to records, replacing grouped fields with
 * PivotGroupValues. Values a grouping cannot bucket keep exact-value
 * grouping. Pure; the input records are not mutated.
 */
export function applyGroupings(
  records: PivotRecord[],
  groupings: PivotGrouping[] | undefined,
): PivotRecord[] {
  if (!groupings || groupings.length === 0) return records;
  const numericRanges = new Map<string, { min: number; max: number }>();
  for (const g of groupings) {
    if (g.kind !== 'numeric') continue;
    if (g.start !== undefined && g.end !== undefined) continue;
    const nums = numbersOf(records, g.field);
    if (nums.length > 0) {
      numericRanges.set(g.field, { min: Math.min(...nums), max: Math.max(...nums) });
    }
  }
  return records.map((r) => {
    let out: PivotRecord | null = null;
    for (const g of groupings) {
      const gv =
        g.kind === 'date'
          ? groupDateValue(r[g.field], g.unit)
          : g.kind === 'numeric'
            ? (() => {
                const range = numericRanges.get(g.field);
                if (!range) return null;
                return groupNumericValue(r[g.field], g, range.min, range.max);
              })()
            : groupCustomValue(r[g.field], g.groups);
      if (gv) {
        if (!out) out = { ...r };
        out[g.field] = gv;
      }
    }
    return out ?? r;
  });
}

function validateGroupings(records: PivotRecord[], spec: PivotSpec): void {
  const known = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) known.add(k);
  for (const g of spec.groupings ?? []) {
    if (!known.has(g.field)) {
      throw new Error(`unknown field "${g.field}" in groupings`);
    }
    if (g.kind === 'date') {
      if (!PIVOT_DATE_UNITS.includes(g.unit)) {
        throw new Error(`unknown date grouping unit "${(g as { unit: string }).unit}" for field "${g.field}"`);
      }
    } else if (g.kind === 'numeric') {
      if (!Number.isFinite(g.by) || g.by <= 0) {
        throw new Error(`numeric grouping for field "${g.field}" needs by > 0`);
      }
      if (g.start !== undefined && g.end !== undefined && g.end <= g.start) {
        throw new Error(`numeric grouping for field "${g.field}" needs end > start`);
      }
    } else if (g.kind === 'custom') {
      if (g.groups.length === 0) {
        throw new Error(`custom grouping for field "${g.field}" needs at least one group`);
      }
      for (const grp of g.groups) {
        if (grp.label.trim() === '') {
          throw new Error(`custom grouping for field "${g.field}" has an empty group label`);
        }
        if (grp.values.length === 0) {
          throw new Error(`custom grouping "${grp.label}" for field "${g.field}" needs values`);
        }
      }
    } else {
      const unknown = g as { kind?: string; field?: string };
      throw new Error(`unknown grouping kind "${String(unknown.kind)}" for field "${String(unknown.field)}"`);
    }
  }
}

function aggregate(records: PivotRecord[], vf: PivotValueField): number | null {
  const field = vf.field;
  switch (vf.aggregation) {
    case 'count': {
      let n = 0;
      for (const r of records) if (!isBlank(rawOf(r[field]))) n += 1;
      return n;
    }
    case 'countnums':
      return numbersOf(records, field).length;
    case 'sum': {
      const nums = numbersOf(records, field);
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
    }
    case 'average': {
      const nums = numbersOf(records, field);
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case 'max': {
      const nums = numbersOf(records, field);
      return nums.length === 0 ? null : Math.max(...nums);
    }
    case 'min': {
      const nums = numbersOf(records, field);
      return nums.length === 0 ? null : Math.min(...nums);
    }
    case 'product': {
      const nums = numbersOf(records, field);
      return nums.length === 0 ? null : nums.reduce((a, b) => a * b, 1);
    }
    case 'stdev':
    case 'var': {
      // Sample statistics, matching Excel STDEV/VAR.
      const nums = numbersOf(records, field);
      if (nums.length < 2) return null;
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const ss = nums.reduce((a, b) => a + (b - mean) * (b - mean), 0);
      const variance = ss / (nums.length - 1);
      return vf.aggregation === 'stdev' ? Math.sqrt(variance) : variance;
    }
  }
}

function valueLabel(vf: PivotValueField): string {
  if (vf.label) return vf.label;
  const name = PIVOT_AGGREGATIONS.find((a) => a.id === vf.aggregation)?.label ?? vf.aggregation;
  return `${name} of ${vf.field}`;
}

function applyFilters(records: PivotRecord[], filters: PivotFilter[] | undefined): PivotRecord[] {
  if (!filters || filters.length === 0) return records;
  return records.filter((r) =>
    filters.every((f) => f.selected.includes(labelOf(r[f.field]))),
  );
}

function validateSpec(records: PivotRecord[], spec: PivotSpec): void {
  if (spec.version !== PIVOT_SPEC_VERSION) {
    throw new Error(`unsupported pivot spec version ${String(spec.version)}`);
  }
  if (spec.values.length === 0) {
    throw new Error('a PivotTable needs at least one value field');
  }
  const known = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) known.add(k);
  const check = (name: string, where: string): void => {
    if (!known.has(name)) throw new Error(`unknown field "${name}" in ${where}`);
  };
  for (const f of spec.rows) check(f, 'rows');
  for (const f of spec.columns) check(f, 'columns');
  for (const vf of spec.values) check(vf.field, 'values');
  for (const f of spec.filters ?? []) check(f.field, 'filters');
  for (const vf of spec.values) {
    if (!PIVOT_AGGREGATIONS.some((a) => a.id === vf.aggregation)) {
      throw new Error(`unknown aggregation "${vf.aggregation}"`);
    }
  }
  validateGroupings(records, spec);
}

/**
 * Build a pivot table from records read through the typed computational view.
 * Pure: no engine or storage access.
 */
export function createPivot(records: PivotRecord[], spec: PivotSpec): PivotResult {
  validateSpec(records, spec);
  // Grouping first: filters match against group labels (Excel behavior).
  const grouped = applyGroupings(records, spec.groupings);
  const filtered = applyFilters(grouped, spec.filters);

  // Group: rowKey -> colKey -> records. Group labels (e.g. "Q3 2026") are
  // not recoverable from the sortable compound keys, so they are tracked
  // in side maps keyed by field position + key part.
  const rowPartLabels = new Map<string, string>();
  const colPartLabels = new Map<string, string>();
  const partKeyOf = (
    v: unknown,
    fieldIdx: number,
    labelMap: Map<string, string>,
  ): string => {
    const k = keyOf(v);
    if (isPivotGroupValue(v)) labelMap.set(`${fieldIdx} ${k}`, v.groupLabel);
    return k;
  };
  const rowKeyOf = (r: PivotRecord): string =>
    spec.rows.map((f, i) => partKeyOf(r[f], i, rowPartLabels)).join('\u0001');
  const colKeyOf = (r: PivotRecord): string =>
    spec.columns.map((f, i) => partKeyOf(r[f], i, colPartLabels)).join('\u0001');
  const groups = new Map<string, Map<string, PivotRecord[]>>();
  const rowRecs = new Map<string, PivotRecord[]>();
  const colRecs = new Map<string, PivotRecord[]>();
  for (const r of filtered) {
    const rk = rowKeyOf(r);
    const ck = colKeyOf(r);
    let inner = groups.get(rk);
    if (!inner) {
      inner = new Map();
      groups.set(rk, inner);
    }
    let bucket = inner.get(ck);
    if (!bucket) {
      bucket = [];
      inner.set(ck, bucket);
    }
    bucket.push(r);
    const rr = rowRecs.get(rk);
    if (rr) rr.push(r);
    else rowRecs.set(rk, [r]);
    const cr = colRecs.get(ck);
    if (cr) cr.push(r);
    else colRecs.set(ck, [r]);
  }

  const tupleOf = (
    compound: string,
    count: number,
    labelMap: Map<string, string>,
  ): string[] => {
    if (count === 0) return [];
    const parts = compound.split('\u0001');
    while (parts.length < count) parts.push('b:');
    return parts.map((part, i) => labelMap.get(`${i} ${part}`) ?? keyToLabel(part));
  };

  const rowCompounds = [...groups.keys()].sort((a, b) => {
    const pa = a.split('\u0001');
    const pb = b.split('\u0001');
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const c = compareKeys(pa[i] ?? 'b:', pb[i] ?? 'b:');
      if (c !== 0) return c;
    }
    return 0;
  });
  const colCompounds = [...new Set([...groups.values()].flatMap((m) => [...m.keys()]))].sort((a, b) => {
    const pa = a.split('\u0001');
    const pb = b.split('\u0001');
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const c = compareKeys(pa[i] ?? 'b:', pb[i] ?? 'b:');
      if (c !== 0) return c;
    }
    return 0;
  });

  // Totals aggregate from raw records (average of averages would be wrong).
  const data: (number | null)[][][] = rowCompounds.map((rk) =>
    colCompounds.map((ck) => {
      const bucket = groups.get(rk)?.get(ck) ?? [];
      return spec.values.map((vf) => aggregate(bucket, vf));
    }),
  );
  const rowTotals: (number | null)[][] = rowCompounds.map((rk) =>
    spec.values.map((vf) => aggregate(rowRecs.get(rk) ?? [], vf)),
  );
  const colTotals: (number | null)[][] = colCompounds.map((ck) =>
    spec.values.map((vf) => aggregate(colRecs.get(ck) ?? [], vf)),
  );
  const grandTotals: (number | null)[] = spec.values.map((vf) => aggregate(filtered, vf));

  return {
    spec,
    rowFieldNames: [...spec.rows],
    colFieldNames: [...spec.columns],
    valueLabels: spec.values.map(valueLabel),
    rowKeys: rowCompounds.map((rk) => tupleOf(rk, spec.rows.length, rowPartLabels)),
    colKeys: colCompounds.map((ck) => tupleOf(ck, spec.columns.length, colPartLabels)),
    data,
    rowTotals,
    colTotals,
    grandTotals,
    sourceRowCount: records.length,
    filteredRowCount: filtered.length,
  };
}

/** Recompute a pivot against fresh records (manual refresh / refresh on open). */
export function refreshPivot(records: PivotRecord[], spec: PivotSpec): PivotResult {
  return createPivot(records, spec);
}

/**
 * Look up one aggregated cell by row/column key labels.
 * Returns null when the key combination has no data.
 */
export function getPivotValue(
  pivot: PivotResult,
  rowKey: string[],
  colKey: string[],
  valueIdx = 0,
): number | null {
  const ri = pivot.rowKeys.findIndex((k) => arraysEqual(k, rowKey));
  const ci = pivot.colKeys.findIndex((k) => arraysEqual(k, colKey));
  if (ri < 0 || ci < 0) return null;
  return pivot.data[ri]?.[ci]?.[valueIdx] ?? null;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Build records from a grid whose first row is the header row —
 * the shape a caller assembles after reading through TypedView.
 */
export function recordsFromGrid(headers: string[], rows: unknown[][]): PivotRecord[] {
  return rows.map((row) => {
    const rec: PivotRecord = {};
    headers.forEach((h, i) => {
      rec[h] = row[i] ?? null;
    });
    return rec;
  });
}

/**
 * Render a pivot as a plain 2D matrix (strings/numbers/null) for grid
 * display, export, or MCP transport. Layout:
 *   row 0: corner blanks, row-field names, then one column per
 *          (column key x value field), then grand-total columns.
 *   body:  row-key labels, then values, then row totals.
 *   last row: "Grand Total" + column totals + grand totals.
 */
export function pivotToMatrix(pivot: PivotResult): (string | number | null)[][] {
  const nVals = pivot.valueLabels.length;
  // Degenerate case: no row or column dimensions — a single grand-total row.
  if (pivot.rowFieldNames.length === 0 && pivot.colFieldNames.length === 0) {
    return [
      [null, ...pivot.valueLabels],
      ['Grand Total', ...pivot.grandTotals],
    ];
  }
  const colHeaderFor = (colKey: string[], valueLabel: string): string => {
    const keyPart = colKey.length > 0 ? colKey.join(' | ') : '';
    if (nVals === 1) return keyPart === '' ? valueLabel : keyPart;
    return keyPart === '' ? valueLabel : `${keyPart} — ${valueLabel}`;
  };
  const totalHeaderFor = (valueLabel: string): string =>
    nVals === 1 ? 'Grand Total' : `Grand Total — ${valueLabel}`;

  const matrix: (string | number | null)[][] = [];
  const headerRow: (string | number | null)[] = [null, ...pivot.rowFieldNames];
  pivot.colKeys.forEach((ck) => {
    pivot.valueLabels.forEach((vl) => headerRow.push(colHeaderFor(ck, vl)));
  });
  pivot.valueLabels.forEach((vl) => headerRow.push(totalHeaderFor(vl)));
  matrix.push(headerRow);

  pivot.rowKeys.forEach((rk, ri) => {
    const row: (string | number | null)[] = [null, ...rk];
    pivot.colKeys.forEach((ck, ci) => {
      for (let vi = 0; vi < nVals; vi += 1) row.push(pivot.data[ri]?.[ci]?.[vi] ?? null);
    });
    for (let vi = 0; vi < nVals; vi += 1) row.push(pivot.rowTotals[ri]?.[vi] ?? null);
    matrix.push(row);
  });

  const totalRow: (string | number | null)[] = ['Grand Total', ...pivot.rowFieldNames.map(() => null)];
  pivot.colKeys.forEach((ck, ci) => {
    for (let vi = 0; vi < nVals; vi += 1) totalRow.push(pivot.colTotals[ci]?.[vi] ?? null);
  });
  for (let vi = 0; vi < nVals; vi += 1) totalRow.push(pivot.grandTotals[vi] ?? null);
  matrix.push(totalRow);
  return matrix;
}
