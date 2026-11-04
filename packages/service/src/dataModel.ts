/**
 * Data-model source built at open from worksheet ranges (#114, Piece 2).
 *
 * The workbook's embedded Power Pivot model (xl/model/item.data) is NOT
 * parsed here — that binary format is a later phase, only for models
 * whose tables are not backed by sheet ranges. This module builds the
 * model from what the file declares in plain XML: the adapter's table
 * definitions (name, sheet, bounds, columns) plus the range connections
 * that name them, and resolves each OLAP pivot's measures against those
 * tables.
 *
 * Measure resolution is self-verifying, never guessed blind:
 * - An exact column match is accepted only when the pivot's cached
 *   outputs (its anchor cells) agree with the recomputed column — or,
 *   when no cached outputs exist, on trust.
 * - Otherwise calibration tries sign-flipped columns and ratio pairs
 *   (SUM(num)/SUM(den) within one fact table) and accepts the FIRST
 *   candidate whose unfiltered recompute matches EVERY cached row.
 *   This is how 'Sum of invested Cash' resolves to -SUM(Cash from
 *   Investing) and 'Sum of COGS Pct of Rev' to
 *   SUM(Cost of Goods Sold)/SUM(Revenue) on bxl3way: both reproduce
 *   the cached pivot columns exactly, which a name-only match cannot.
 * - A pivot with any unresolvable value is left out entirely — a
 *   partial refresh would write wrong numbers into the grid.
 *
 * Gating: returns null for files without a data-model connection, for
 * files with no tables, and for files with no resolvable OLAP pivot.
 * Callers build once at open, cache per session, and free on release.
 * Never throws.
 */
import {
  queryOlapPivot,
  olapMemberLabel,
  type OlapModel,
  type OlapModelTable,
  type OlapResolvedPivot,
  type OlapResolvedValue,
} from '@icecream-sheets/engine';
import type {
  ImportedConnection,
  ImportedPivotTable,
  TableDef,
} from '@icecream-sheets/xlsx-adapter';

export interface DataModelPivot extends OlapResolvedPivot {
  /** Sheet hosting the pivot. */
  sheetName: string;
  /** Workbook sheetId of the hosting sheet, when the file carries one
   * (slicer caches reference pivots by (tabId, name) — tabId IS the
   * sheetId — so route lookups match on (name, sheetId) first). */
  sheetId?: number;
  /** Pivot location bounds (0-based, inclusive), from the anchor ref. */
  anchor: { startRow: number; startCol: number; endRow: number; endCol: number };
  /** Value labels in grid-column order (value j lives at startCol + 1 + j). */
  valueLabels: string[];
}

export interface DataModelBuild {
  model: OlapModel;
  /** Only fully resolvable row-only OLAP pivots. */
  pivots: DataModelPivot[];
}

export interface DataModelBuildInput {
  tables: TableDef[];
  connections: ImportedConnection[];
  pivots: ImportedPivotTable[];
  /** Computed cell values over a range (engine view reads server-side). */
  readRange: (
    sheet: string,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => unknown[][];
}

function normKey(s: string): string {
  return s.trim().toLowerCase();
}


function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parse an A1 ref like 'A6:D16' into 0-based inclusive bounds. */
export function parseAnchorRef(ref: string): DataModelPivot['anchor'] | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const startCol = colLettersToIndex(m[1]!);
  const startRow = parseInt(m[2]!, 10) - 1;
  const endCol = colLettersToIndex(m[3]!);
  const endRow = parseInt(m[4]!, 10) - 1;
  if (startRow < 0 || startCol < 0 || endRow < startRow || endCol < startCol) return null;
  return { startRow, startCol, endRow, endCol };
}

/**
 * Split a bracketed MDX name into segments: '[tblCal].[Year].[Year]'
 * -> ['tblCal', 'Year', 'Year']. Returns null for malformed input.
 */
export function splitMdxName(field: string): string[] | null {
  const t = field.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1);
  if (inner === '') return null;
  return inner.split('].[');
}

/**
 * Parse a row-axis field into its dimension table + attribute column:
 * '[tblCal].[Year].[Year]' -> { table: 'tblCal', column: 'Year' }.
 * The attribute is the LAST segment (the level); the table is the first.
 */
export function parseDimensionField(field: string): { table: string; column: string } | null {
  const segs = splitMdxName(field);
  if (!segs || segs.length < 2) return null;
  return { table: segs[0]!, column: segs[segs.length - 1]! };
}

/**
 * Parse a measure field into its base name: '[Measures].[Sum of Revenue]'
 * -> 'Revenue'. Returns null for non-measure fields.
 */
export function parseMeasureBase(field: string): string | null {
  const segs = splitMdxName(field);
  if (!segs || segs.length < 2) return null;
  if (normKey(segs[0]!) !== 'measures') return null;
  const label = segs.slice(1).join('.');
  const m = /^sum of\s+(.+)$/i.exec(label.trim());
  return (m?.[1] ?? label).trim();
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function valuesMatch(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  const diff = Math.abs(a - b);
  if (diff <= 1e-6) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && diff / scale <= 1e-9;
}

interface CachedPivot {
  /** label -> value per value index (null when the cell is blank/non-numeric). */
  byLabel: Map<string, (number | null)[]>;
  labels: string[];
}

/**
 * Read a pivot's cached outputs from its anchor cells: the label column
 * is the anchor's first column; value j is the next column over. Rows
 * whose label is not a dimension member are skipped (header rows).
 */
function readCachedOutputs(
  readRange: DataModelBuildInput['readRange'],
  pivot: ImportedPivotTable,
  anchor: DataModelPivot['anchor'],
  memberLabels: Set<string>,
): CachedPivot {
  const out: CachedPivot = { byLabel: new Map(), labels: [] };
  try {
    const grid = readRange(pivot.sheetName, anchor.startRow, anchor.startCol, anchor.endRow, anchor.endCol);
    for (const row of grid) {
      if (!row) continue;
      const label = olapMemberLabel(row[0]);
      if (!memberLabels.has(label)) continue;
      if (out.byLabel.has(label)) continue;
      const vals = pivot.values.map((_, j) => asNumber(row[1 + j]));
      out.byLabel.set(label, vals);
      out.labels.push(label);
    }
  } catch {
    // No cached outputs: resolution falls back to exact-match trust.
  }
  return out;
}

interface JoinCandidate {
  table: OlapModelTable;
  /** Null when the table IS the dimension table. */
  joinColumn: string | null;
}

function joinCandidates(
  model: OlapModel,
  dimensionTable: OlapModelTable,
  dimensionColumn: string,
): JoinCandidate[] {
  const out: JoinCandidate[] = [];
  const dimCols = new Set(dimensionTable.columns.map(normKey));
  for (const table of model.tables) {
    if (normKey(table.name) === normKey(dimensionTable.name)) {
      out.push({ table, joinColumn: null });
      continue;
    }
    const shared = table.columns.filter(
      (c) => normKey(c) !== normKey(dimensionColumn) && dimCols.has(normKey(c)),
    );
    if (shared.length === 1) out.push({ table, joinColumn: shared[0]! });
  }
  return out;
}

function isNumericColumn(table: OlapModelTable, column: string): boolean {
  return table.rows.some((r) => {
    const want = normKey(column);
    for (const key of Object.keys(r)) {
      if (normKey(key) === want && asNumber(r[key]) !== null) return true;
    }
    return false;
  });
}

/**
 * Trial-check a candidate value definition: its unfiltered recompute
 * must match the cached column for EVERY cached label (when cached
 * outputs exist). With no cached outputs, only exact-match candidates
 * are trusted (callers pass allowUnverified=false for calibration).
 */
function trialMatches(
  model: OlapModel,
  base: Omit<OlapResolvedPivot, 'values'>,
  candidate: OlapResolvedValue,
  joinColumn: string | null,
  cached: CachedPivot,
  valueIndex: number,
  allowUnverified: boolean,
): boolean {
  if (cached.labels.length === 0) return allowUnverified;
  const trial: OlapResolvedPivot = { ...base, joinColumn, values: [candidate] };
  const matrix = queryOlapPivot(model, trial, null);
  const byLabel = new Map(matrix.rowKeys.map((k, i) => [k, matrix.data[i]?.[0] ?? null]));
  for (const label of cached.labels) {
    const want = cached.byLabel.get(label)?.[valueIndex] ?? null;
    const got = byLabel.has(label) ? byLabel.get(label)! : null;
    if (!valuesMatch(got, want)) return false;
  }
  return true;
}

interface ResolvedValue {
  value: OlapResolvedValue;
  joinColumn: string | null;
}

function resolveValue(
  model: OlapModel,
  base: Omit<OlapResolvedPivot, 'values'>,
  dimensionTable: OlapModelTable,
  aggregation: string,
  measureBase: string,
  displayLabel: string,
  cached: CachedPivot,
): ResolvedValue | null {
  const candidates = joinCandidates(model, dimensionTable, base.dimensionColumn);
  const exact: { candidate: JoinCandidate; column: string }[] = [];
  for (const c of candidates) {
    for (const col of c.table.columns) {
      if (normKey(col) === normKey(measureBase)) exact.push({ candidate: c, column: col });
    }
  }
  const kindFor = (agg: string): 'sum' | 'count' | 'average' | 'max' | 'min' | 'product' => {
    switch (agg) {
      case 'count':
      case 'countnums':
        return 'count';
      case 'average':
        return 'average';
      case 'max':
        return 'max';
      case 'min':
        return 'min';
      case 'product':
        return 'product';
      default:
        return 'sum';
    }
  };
  const kind = kindFor(aggregation);
  // 1. Exact column matches (trust when no cached outputs exist).
  for (const e of exact) {
    const value: OlapResolvedValue = {
      kind,
      label: displayLabel,
      table: e.candidate.table.name,
      column: e.column,
    };
    if (trialMatches(model, base, value, e.candidate.joinColumn, cached, 0, true)) {
      return { value, joinColumn: e.candidate.joinColumn };
    }
  }
  // Calibration needs cached outputs to validate against; without them
  // an unresolvable measure stays unresolvable rather than guessed.
  if (cached.labels.length === 0) return null;
  if (kind !== 'sum') return null;
  // 2. Sign-flipped columns, then 3. ratio pairs, each validated.
  for (const c of candidates) {
    for (const col of c.table.columns) {
      if (!isNumericColumn(c.table, col)) continue;
      for (const sign of [1, -1] as const) {
        if (sign === 1 && exact.some((e) => e.candidate.table === c.table && normKey(e.column) === normKey(col))) {
          continue; // already tried (and failed) above.
        }
        const value: OlapResolvedValue = {
          kind: 'sum',
          label: displayLabel,
          table: c.table.name,
          column: col,
          sign,
        };
        if (trialMatches(model, base, value, c.joinColumn, cached, 0, false)) {
          return { value, joinColumn: c.joinColumn };
        }
      }
    }
  }
  for (const c of candidates) {
    const numericCols = c.table.columns.filter((col) => isNumericColumn(c.table, col));
    for (const num of numericCols) {
      for (const den of numericCols) {
        if (normKey(num) === normKey(den)) continue;
        const value: OlapResolvedValue = {
          kind: 'ratio',
          label: displayLabel,
          table: c.table.name,
          numeratorColumn: num,
          denominatorColumn: den,
        };
        if (trialMatches(model, base, value, c.joinColumn, cached, 0, false)) {
          return { value, joinColumn: c.joinColumn };
        }
      }
    }
  }
  return null;
}

/**
 * Build the data model + resolved OLAP pivots for a workbook, or null
 * when the workbook carries no usable data model (no data-model
 * connection, no tables, or no fully resolvable OLAP pivot). The model
 * tables come from the adapter's table definitions; values come from
 * the caller's computed-value reader (engine view server-side, host
 * view in local mode) — WorkbookData rows hold raw inputs, and table
 * cells are usually formulas, so reading rows directly would yield
 * formula text instead of numbers.
 */
export function buildDataModel(input: DataModelBuildInput): DataModelBuild | null {
  try {
    if (!input.connections.some((c) => c.isDataModel)) return null;
    if (input.tables.length === 0) return null;
    const modelTables: OlapModelTable[] = [];
    for (const t of input.tables) {
      if (t.columns.length === 0) continue;
      let grid: unknown[][] = [];
      try {
        grid = input.readRange(t.sheet, t.startRow, t.startCol, t.endRow, t.endCol) ?? [];
      } catch {
        continue;
      }
      const body = t.headerRow ? grid.slice(1) : grid;
      const rows = (t.totalsRow ? body.slice(0, -1) : body)
        .filter((r) => r && r.some((v) => v !== null && v !== undefined && v !== ''))
        .map((r) => {
          const rec: Record<string, unknown> = {};
          t.columns.forEach((col, i) => {
            rec[col] = r[i] ?? null;
          });
          return rec;
        });
      modelTables.push({ name: t.name, columns: [...t.columns], rows });
    }
    if (modelTables.length === 0) return null;
    const model: OlapModel = { tables: modelTables };
    const tableByName = new Map(modelTables.map((t) => [normKey(t.name), t]));
    const pivots: DataModelPivot[] = [];
    for (const p of input.pivots) {
      if (p.rows.length !== 1 || p.columns.length !== 0 || p.values.length === 0) continue;
      const dim = parseDimensionField(p.rows[0]!);
      if (!dim) continue;
      const dimensionTable = tableByName.get(normKey(dim.table));
      if (!dimensionTable) continue;
      if (!dimensionTable.columns.some((c) => normKey(c) === normKey(dim.column))) continue;
      const anchor = parseAnchorRef(p.anchor.ref);
      if (!anchor) continue;
      if (anchor.endCol - anchor.startCol < p.values.length) continue;
      const memberLabels = new Set(
        dimensionTable.rows.map((r) => {
          const want = normKey(dim.column);
          for (const key of Object.keys(r)) {
            if (normKey(key) === want) return olapMemberLabel(r[key]);
          }
          return '(blank)';
        }),
      );
      memberLabels.delete('(blank)');
      const cached = readCachedOutputs(input.readRange, p, anchor, memberLabels);
      const base: Omit<OlapResolvedPivot, 'values'> = {
        name: p.name,
        dimensionTable: dimensionTable.name,
        dimensionColumn: dim.column,
        joinColumn: null,
      };
      const resolved: ResolvedValue[] = [];
      let ok = true;
      for (const v of p.values) {
        const measureBase = parseMeasureBase(v.field);
        if (measureBase === null) {
          ok = false;
          break;
        }
        // trialMatches compares valueIndex 0 of a single-value trial, so
        // remap the cached columns to this value's position first.
        const single: CachedPivot = {
          labels: cached.labels,
          byLabel: new Map(
            [...cached.byLabel.entries()].map(([label, vals]) => [label, [vals[resolved.length] ?? null]]),
          ),
        };
        const r = resolveValue(model, base, dimensionTable, v.aggregation, measureBase, v.label, single);
        if (!r) {
          ok = false;
          break;
        }
        resolved.push(r);
      }
      if (!ok) continue;
      const joinColumns = new Set(resolved.map((r) => r.joinColumn));
      if (joinColumns.size !== 1) continue;
      const joinColumn = [...joinColumns][0]!;
      pivots.push({
        ...base,
        joinColumn,
        values: resolved.map((r) => r.value),
        sheetName: p.sheetName,
        ...(p.sheetId !== undefined ? { sheetId: p.sheetId } : {}),
        anchor,
        valueLabels: p.values.map((v) => v.label),
      });
    }
    if (pivots.length === 0) return null;
    return { model, pivots };
  } catch (e) {
    if (typeof process !== 'undefined' && process.env?.OLAP_DEBUG) {
      console.error('[dataModel] build failed:', e);
    }
    return null;
  }
}
