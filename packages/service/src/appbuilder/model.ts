/**
 * No-code app builder: view-model logic (design-docs/no-code-app-builder.md §3-§4).
 *
 * Pure functions over plain JSON records. The service layer never touches the
 * engine or storage directly: the host reads the bound table through the
 * typed computational view (host.readRange(..., { principal })) and hands this
 * module plain values.
 *
 * Permission filtering (no-code-app-builder.md §6, permission-model.md §4):
 * every data access runs through authorize() as the end user, and the app
 * renders the per-subject filtered view. The v1 engine ships a default-allow
 * policy (engine/src/permissions.ts); the full object-tree policy is not
 * implemented yet. The seam is SubjectPolicy: hosts supply one derived from
 * the access table when it lands, and reads already mark denied cells with
 * the #PERM! error marker, which this module treats as invisible.
 */

import type { ColumnSpec, ColumnType, SliceFilter, ViewSpec } from './spec.js';

/**
 * Plain cell value as handed to the service layer. Denied cells arrive as
 * { error: '#PERM!' } — the same marker TypedView.toJson produces — and are
 * never rendered as values.
 */
export type CellInput = string | number | boolean | null | { error: string };

/** One bound-table row: its 0-based data-row index plus header-keyed values. */
export interface AppRecord {
  rowIndex: number;
  values: Record<string, CellInput>;
}

/** A table read as the app runtime sees it. */
export interface TableSnapshot {
  headers: string[];
  records: AppRecord[];
}

const IMAGE_URL_RE = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?\S*)?$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/** Documented reference convention: TableName[key] links into a related table. */
const REFERENCE_RE = /^[A-Za-z_][\w ]*\[[^\]]+\]$/;

/** A value the subject may not see. */
export function isDenied(value: CellInput): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    (value as { error: string }).error === '#PERM!'
  );
}

function isEmpty(v: CellInput): boolean {
  return v === null || v === undefined || v === '' || isDenied(v);
}

function looksLikeDate(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 40) return false;
  if (ISO_DATE_RE.test(t)) {
    const d = new Date(t);
    return !Number.isNaN(d.getTime());
  }
  return false;
}

/**
 * Infer one column's type from its values (§3: text, numeric, date,
 * image URL and reference columns). Denied/empty values are ignored. A
 * column needs a strict majority (>50% of non-empty values) to earn a
 * non-text type, so mixed columns stay text.
 */
export function inferColumnType(name: string, values: CellInput[]): ColumnType {
  const present = values.filter((v) => !isEmpty(v));
  if (present.length === 0) return 'text';
  const isBool = (v: CellInput): boolean =>
    typeof v === 'boolean' || (typeof v === 'string' && /^(true|false)$/i.test(v.trim()));
  const isNum = (v: CellInput): boolean =>
    typeof v === 'number' ||
    (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v.trim())));
  const isDate = (v: CellInput): boolean => typeof v === 'string' && looksLikeDate(v);
  const isImage = (v: CellInput): boolean => typeof v === 'string' && IMAGE_URL_RE.test(v.trim());
  const isRef = (v: CellInput): boolean => typeof v === 'string' && REFERENCE_RE.test(v.trim());

  const majority = (pred: (v: CellInput) => boolean): boolean =>
    present.filter(pred).length > present.length / 2;

  if (majority(isBool)) return 'boolean';
  if (majority(isNum)) return 'numeric';
  if (majority(isImage)) return 'imageUrl';
  if (majority(isRef)) return 'reference';
  if (majority(isDate)) return 'date';
  void name;
  return 'text';
}

/** Infer column specs for every header from a header-keyed value grid. */
export function inferColumns(headers: string[], grid: CellInput[][]): ColumnSpec[] {
  return headers.map((name, i) => {
    const type = inferColumnType(name, grid.map((row) => row[i] ?? null));
    const spec: ColumnSpec = { name, type };
    if (type === 'reference') {
      // The related table's stable id is the bracketed table name, e.g.
      // "Orders[1024]" -> table id "Orders". The host maps it to the
      // permission-tree object id (permission-model.md §1).
      const sample = grid.map((row) => row[i]).find((v) => typeof v === 'string' && REFERENCE_RE.test(v.trim()));
      if (typeof sample === 'string') {
        spec.referenceTableId = sample.trim().slice(0, sample.trim().indexOf('['));
      }
    }
    return spec;
  });
}

/**
 * Build records from a value grid read through the typed view. When
 * headerRow is true, grid[0] is the header row; otherwise headers are
 * positional ("Column A", ...). Denied cells are kept as markers so the
 * permission seam can hide them without inventing fake empties.
 */
export function recordsFromValues(
  grid: CellInput[][],
  opts?: { headerRow?: boolean; headers?: string[] },
): TableSnapshot {
  const headerRow = opts?.headerRow !== false;
  if (grid.length === 0) return { headers: [], records: [] };
  const headers = headerRow
    ? (grid[0] ?? []).map((h, i) =>
        typeof h === 'string' && h.trim() !== '' ? h.trim() : `Column ${i + 1}`,
      )
    : (opts?.headers ?? (grid[0] ?? []).map((_, i) => `Column ${i + 1}`));
  const dataRows = headerRow ? grid.slice(1) : grid;
  const records: AppRecord[] = dataRows.map((row, rowIndex) => {
    const values: Record<string, CellInput> = {};
    headers.forEach((h, i) => {
      values[h] = row[i] ?? null;
    });
    return { rowIndex, values };
  });
  return { headers, records };
}

/** Drop trailing all-empty data rows (the used-range tail). */
export function dropTrailingBlankRows(snapshot: TableSnapshot): TableSnapshot {
  const records = [...snapshot.records];
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last && Object.values(last.values).every(isEmpty)) records.pop();
    else break;
  }
  return { headers: snapshot.headers, records };
}

function compareValues(op: SliceFilter['op'], cell: CellInput, want: SliceFilter['value']): boolean {
  if (isDenied(cell)) return false;
  const c = cell === null || cell === undefined ? null : cell;
  switch (op) {
    case 'eq':
      return c === want;
    case 'ne':
      return c !== want;
    case 'contains':
      return typeof c === 'string' && typeof want === 'string' && c.includes(want);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (c === null || want === null) return false;
      if (typeof c === 'number' && typeof want === 'number') {
        return op === 'gt' ? c > want : op === 'gte' ? c >= want : op === 'lt' ? c < want : c <= want;
      }
      const cs = String(c);
      const ws = String(want);
      return op === 'gt' ? cs > ws : op === 'gte' ? cs >= ws : op === 'lt' ? cs < ws : cs <= ws;
    }
  }
}

/** Apply a view's filtered slice (v1: single predicate). */
export function applySliceFilter(records: AppRecord[], filter?: SliceFilter): AppRecord[] {
  if (!filter) return records;
  return records.filter((r) => compareValues(filter.op, r.values[filter.column] ?? null, filter.value));
}

// ---------------------------------------------------------------------------
// Permission filtering seam (no-code-app-builder.md §6)
// ---------------------------------------------------------------------------

/**
 * Per-subject policy. The v1 engine's default-allow policy
 * (engine/src/permissions.ts allowAllPolicy) accepts everything; when the
 * permission-model.md object tree lands, the host derives a SubjectPolicy
 * from the access table and injects it here. Denied targets return
 * authorization errors, never silent empties (ai-agent.md §3) — so a column
 * or row the subject may not read disappears from the view rather than
 * rendering blank.
 */
export interface SubjectPolicy {
  /** Columns of the bound table the principal may read. Default: all. */
  readableColumns(principal: string, tableId: string | undefined, allColumns: string[]): string[];
  /** Whether the principal may read this record. Default: true. */
  rowVisible(principal: string, tableId: string | undefined, record: AppRecord): boolean;
}

/** v1 default: the single-user policy — everyone sees everything. */
export const allowAllSubjectPolicy: SubjectPolicy = {
  readableColumns: (_principal, _tableId, allColumns) => [...allColumns],
  rowVisible: () => true,
};

export interface FilteredView {
  columns: ColumnSpec[];
  records: AppRecord[];
}

/**
 * Render the per-subject filtered view: drop unreadable columns and rows,
 * then drop any column whose every remaining cell is a #PERM! marker (a
 * column the subject cannot read at all vanishes instead of showing a
 * column of blanks). Individual denied cells stay marked so the view layer
 * renders them as blank — values never leak.
 */
export function applySubjectFilter(
  columns: ColumnSpec[],
  records: AppRecord[],
  opts: {
    principal: string;
    tableId?: string;
    policy?: SubjectPolicy;
  },
): FilteredView {
  const policy = opts.policy ?? allowAllSubjectPolicy;
  const readable = new Set(
    policy.readableColumns(opts.principal, opts.tableId, columns.map((c) => c.name)),
  );
  let keptColumns = columns.filter((c) => readable.has(c.name));
  const keptRecords = records.filter((r) => policy.rowVisible(opts.principal, opts.tableId, r));
  // Defense in depth: a column that is entirely denied markers disappears.
  keptColumns = keptColumns.filter((c) => {
    if (keptRecords.length === 0) return true;
    return keptRecords.some((r) => !isDenied(r.values[c.name] ?? null));
  });
  // Strip unreadable columns from the record payloads: the filtered view
  // carries no value the subject may not read (markers excepted).
  const names = new Set(keptColumns.map((c) => c.name));
  const stripped = keptRecords.map((r) => {
    const values: Record<string, CellInput> = {};
    for (const [k, v] of Object.entries(r.values)) {
      if (names.has(k)) values[k] = v;
    }
    return { rowIndex: r.rowIndex, values };
  });
  return { columns: keptColumns, records: stripped };
}

/**
 * Resolve which columns a view shows: the view's explicit list, or all
 * non-hidden columns of the bound table, in table order.
 */
export function viewColumns(view: ViewSpec, tableColumns: ColumnSpec[]): ColumnSpec[] {
  if (view.columns && view.columns.length > 0) {
    const byName = new Map(tableColumns.map((c) => [c.name, c]));
    return view.columns
      .map((n) => byName.get(n))
      .filter((c): c is ColumnSpec => c !== undefined);
  }
  return tableColumns.filter((c) => !c.hidden);
}

/** Render a cell value for display. Denied cells render as blank. */
export function displayValue(value: CellInput): string {
  if (isDenied(value) || value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object' && 'error' in value) return String((value as { error: string }).error);
  return String(value);
}
