/**
 * Native slicer/timeline import mapping (issue #69 item 1, Phase E piece A).
 *
 * The xlsx-adapter already parses native slicer/timeline parts into the
 * typed SlicersTimelinesModel and carries it through workbook metadata
 * under `icecream.slicersTimelines` (adapter.ts import + save re-injection).
 * What was missing was the app side: turning that model into the
 * SlicerSpec / TimelineSpec values the existing panels
 * (components/Slicer.tsx, components/Timeline.tsx) already render, and
 * writing an edited timeline's range back into the model so a save can
 * carry it to Excel.
 *
 * This module is that mapping. It is deliberately runtime-independent of
 * `@icecream-sheets/xlsx-adapter`: it accepts the metadata value (a JSON
 * string, or an already-parsed object) and mirrors only the model fields
 * it reads, so a stale adapter dist can never break it. It never throws:
 * malformed metadata yields null / empty results, and every control it
 * cannot render is reported in `unresolved` instead of being dropped
 * silently.
 *
 * Resolution rules (see the piece-A report for the full analysis):
 * - Table slicer (cache data kind 'table', tableId + column): column =
 *   TableDef.startCol + column, sheet = the view's sheet. Needs the
 *   caller to supply TableDefs (adapter attaches them to sheet data).
 * - Tabular slicer: pivot with cacheId == data.pivotCacheId, whose source
 *   is a worksheet range and whose fieldNames contain cache.sourceName;
 *   column = source.startCol + field index.
 * - Timeline: same pivot-source resolution via cache.state.pivotCacheId
 *   and cache.sourceName; range = state.selection ?? state.bounds;
 *   granularity = view.level ?? view.selectionLevel ?? 'months'.
 * - OLAP slicers (#114) have no worksheet column, so they cannot drive
 *   the grid filter; instead they map to a spec with col -1 plus an
 *   `olap` binding (dimension table/column from the cache sourceName)
 *   and the pivot refs the cache already lists (tabId + name,
 *   sheet-qualified so same-named pivots never collide). Panel values
 *   come from the cache level members, and the caller resolves the
 *   pivot refs to app pivot ids. An OLAP slicer whose dimension or
 *   members cannot be read still lands in `unresolved`.
 *
 * KNOWN NON-RESTORATION (honest, not a bug in this mapping): slicer
 * SELECTIONS are not restored. Tabular cache items carry only shared-item
 * indices + s flags, and the model carries no shared-item strings, so an
 * index cannot be turned into a panel value string; table caches carry no
 * selection at all. Imported slicers therefore start at select-all
 * (selected = []) with selectionRestored = false, and the save path must
 * preserve the original model verbatim for untouched slicers — it must
 * NOT overwrite cache items from panel state. Timeline ranges, by
 * contrast, are ISO dates in the model and round-trip exactly via
 * applyTimelineSelectionsToModel.
 *
 * Geometry is likewise absent from the model (views carry no drawing
 * anchor), so mapped specs use the same stagger defaults as App's
 * insert handlers (slicer x = 32 + i*48, y = 170, w = 220; timeline
 * x = 280 + i*48, y = 170, w = 300).
 *
 * Panel VALUES are not computed here: the caller fills them exactly as
 * App's insert handlers do, via distinctColumnValues(col, 2000,
 * readCellText) keyed by spec id. Pivot binding names are returned as
 * pivotNames; the caller resolves them to app pivot ids (the app assigns
 * numeric ids at hydrate time, so this module cannot know them).
 */
import type { SlicerSpec } from './slicers';
import type { TimelineGranularity, TimelineSpec } from './timelines';

// ---------------------------------------------------------------------------
// Mirrored native-model shapes (structural: extra fields are ignored).
// Field names match packages/xlsx-adapter/src/slicersTimelines.ts.
// ---------------------------------------------------------------------------

export interface NativeCachePivotTableRef {
  tabId?: number;
  name: string;
}

export interface NativeOlapLevelItem {
  /** Adapter shape: `name` (unique name) + `caption`. Raw XML attrs
   * `n`/`c` are accepted as well for forward compatibility. */
  name?: string;
  caption?: string;
  n?: string;
  c?: string;
}

export interface NativeOlapLevel {
  uniqueName?: string;
  sourceCaption?: string;
  ranges?: { items?: NativeOlapLevelItem[] }[];
}

export type NativeSlicerCacheData =
  | { kind: 'tabular'; pivotCacheId: number; items?: { index: number; selected?: boolean; nonDisplay?: boolean }[] }
  | { kind: 'olap'; pivotCacheId?: number; levels?: NativeOlapLevel[]; selections?: unknown }
  | { kind: 'table'; tableId: number; column: number };

export interface NativeSlicerCache {
  name: string;
  sourceName?: string;
  pivotTables?: NativeCachePivotTableRef[];
  data?: NativeSlicerCacheData;
}

export interface NativeSlicerView {
  name: string;
  cache: string;
  caption?: string;
}

export interface NativeSheetSlicers {
  sheetName: string;
  slicers: NativeSlicerView[];
}

export interface NativeTimelineRange {
  startDate: string;
  endDate: string;
}

export interface NativeTimelineCache {
  name: string;
  sourceName?: string;
  state?: {
    pivotCacheId: number;
    selection?: NativeTimelineRange;
    bounds?: NativeTimelineRange;
  };
}

export interface NativeTimelineView {
  name: string;
  cache: string;
  caption?: string;
  level?: string;
  selectionLevel?: string;
}

export interface NativeSheetTimelines {
  sheetName: string;
  timelines: NativeTimelineView[];
}

export interface NativeSlicersTimelinesModel {
  slicerCaches?: NativeSlicerCache[];
  sheetSlicers?: NativeSheetSlicers[];
  timelineCaches?: NativeTimelineCache[];
  sheetTimelines?: NativeSheetTimelines[];
}

/** Pivot input for column resolution: the caller maps ImportedPivotTable
 * onto this shape (name/cacheId/fieldNames/source pass straight through). */
export interface NativePivotInput {
  cacheId: number;
  fieldNames: string[];
  source: { kind: string; sheet?: string; ref?: string } | null;
}

/** Table input for column resolution: the caller maps TableDef onto this
 * shape (id/startCol/columns/sheet pass straight through). */
export interface NativeTableInput {
  id?: number;
  sheet: string;
  startCol: number;
  columns: string[];
}

export interface ImportedSlicer {
  spec: SlicerSpec;
  /** Pivot-table names from the cache (caller resolves to app pivot ids). */
  pivotNames: string[];
  /**
   * Pivot-table refs from the cache (#114, OLAP only): tabId + name,
   * so the caller can resolve sheet-qualified instead of first-wins
   * by name (workbooks may duplicate pivot names across sheets).
   */
  pivotRefs?: NativeCachePivotTableRef[];
  /**
   * Panel values for OLAP slicers (#114): dimension member captions
   * from the cache levels. The caller uses these as the slicer values
   * instead of scanning a worksheet column (there is none).
   */
  members?: string[];
  /** Always false today: selections are not restorable from the model
   * (see the module docstring). Kept as a field so the save path can
   * branch on it instead of assuming the panel state is authoritative. */
  selectionRestored: false;
}

export interface ImportedTimeline {
  spec: TimelineSpec;
}

export interface UnresolvedControl {
  kind: 'slicer' | 'timeline';
  /** View name, or '' when the cache has no sheet view at all. */
  view: string;
  cache: string;
  sheet: string;
  reason: string;
}

export interface NativeSlicersTimelinesResult {
  slicers: ImportedSlicer[];
  timelines: ImportedTimeline[];
  unresolved: UnresolvedControl[];
}

// ---------------------------------------------------------------------------
// Parsing (never throws)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Parse the `icecream.slicersTimelines` metadata value (JSON string or an
 * already-parsed object) into the mirrored model shape. Returns null for
 * missing, malformed, or structurally unusable values.
 */
export function parseNativeSlicersTimelines(value: unknown): NativeSlicersTimelinesModel | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!isRecord(parsed)) return null;
    if (
      !Array.isArray(parsed.slicerCaches) &&
      !Array.isArray(parsed.sheetSlicers) &&
      !Array.isArray(parsed.timelineCaches) &&
      !Array.isArray(parsed.sheetTimelines)
    ) {
      return null;
    }
    return parsed as unknown as NativeSlicersTimelinesModel;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Column letters (A..XFD, case-insensitive, optional $) -> 0-based index. */
export function colLettersToIndex(letters: string): number | null {
  const clean = letters.replace(/\$/g, '').toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(clean)) return null;
  let idx = 0;
  for (const ch of clean) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

/** Start column of an A1 range ref ('$B$2:$F$100' -> 1). Null when unparsable. */
export function rangeRefStartCol(ref: string | undefined): number | null {
  if (!ref) return null;
  const m = /^\$?([A-Za-z]{1,3})\$?\d+/.exec(ref.trim());
  if (!m) return null;
  return colLettersToIndex(m[1]!);
}

/**
 * Parse an ISO dateTime from a timeline cache ('2023-03-01T00:00:00') as
 * the LOCAL calendar day it names (a raw UTC-midnight instant is the
 * previous local day west of UTC, and every consumer reads local calendar
 * fields — same rule as timelines.ts parseDateCell for date-only strings).
 * Returns null for malformed or overflowing dates.
 */
export function dateFromIsoDateTime(raw: string | undefined): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const local = new Date(y, mo - 1, d);
  if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d) return null;
  return local;
}

/** Format a local calendar day as the cache's ISO dateTime ('...T00:00:00'). */
export function isoDateTimeOf(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
}

function timelineGranularity(level: string | undefined, selectionLevel: string | undefined): TimelineGranularity {
  const raw = (level ?? selectionLevel ?? '').trim().toLowerCase();
  if (raw === 'days' || raw === 'months' || raw === 'quarters' || raw === 'years') return raw;
  return 'months';
}

/**
 * Parse an OLAP dimension sourceName (#114): '[tblCal].[Year]' ->
 * { table: 'tblCal', column: 'Year' }; a three-part hierarchy
 * '[tblCal].[Year].[Year]' takes the last part as the column. Returns
 * null when the shape is unrecognizable.
 */
export function parseOlapDimension(sourceName: string | undefined): { table: string; column: string } | null {
  if (!sourceName) return null;
  const parts = sourceName
    .split('].[')
    .map((p) => p.replace(/^\[/, '').replace(/\]$/, '').trim())
    .filter((p) => p !== '');
  if (parts.length < 2) return null;
  const table = parts[0]!;
  const column = parts[parts.length - 1]!;
  if (!table || !column) return null;
  return { table, column };
}

/** Member label from an OLAP cache item: caption wins, else the trailing
 * member of the unique name ('[tblCal].[Year].&[2012]' -> '2012'). */
function olapItemLabel(item: NativeOlapLevelItem): string | null {
  const caption = item.caption ?? item.c;
  if (typeof caption === 'string' && caption !== '') return caption;
  const unique = item.name ?? item.n;
  if (typeof unique === 'string') {
    const m = /&\[([^\]]*)\]\s*$/.exec(unique);
    if (m) return m[1]!;
    const segs = unique.split('].[').map((p) => p.replace(/^\[/, '').replace(/\]$/, ''));
    const last = segs[segs.length - 1];
    if (last) return last;
  }
  return null;
}

/**
 * Dimension members for an OLAP cache (#114): captions from the last
 * level that carries items (the (All) level carries none and is
 * skipped). Empty when the cache lists no members.
 */
export function olapCacheMembers(data: { levels?: NativeOlapLevel[] } | undefined): string[] {
  if (!data || !Array.isArray(data.levels)) return [];
  for (let i = data.levels.length - 1; i >= 0; i--) {
    const level = data.levels[i]!;
    const items: NativeOlapLevelItem[] = [];
    for (const range of Array.isArray(level.ranges) ? level.ranges : []) {
      for (const item of Array.isArray(range.items) ? range.items : []) items.push(item);
    }
    if (items.length === 0) continue;
    const out: string[] = [];
    for (const item of items) {
      const label = olapItemLabel(item);
      if (label !== null && label !== '(All)' && !out.includes(label)) out.push(label);
    }
    if (out.length > 0) return out;
  }
  return [];
}

/**
 * Resolve a pivot field to a grid column: pivot source must be a worksheet
 * range and fieldNames must contain the field. Returns null with a reason
 * when either fails.
 */
function pivotFieldColumn(
  pivots: NativePivotInput[],
  pivotCacheId: number,
  field: string | undefined,
): { col: number; sheet: string } | { reason: string } {
  const pivot = pivots.find((p) => p.cacheId === pivotCacheId);
  if (!pivot) return { reason: `no imported pivot with cacheId ${pivotCacheId}` };
  if (!pivot.source || pivot.source.kind !== 'worksheet' || !pivot.source.sheet || !pivot.source.ref) {
    return { reason: `pivot cacheId ${pivotCacheId} has no worksheet source range` };
  }
  const startCol = rangeRefStartCol(pivot.source.ref);
  if (startCol === null) return { reason: `pivot cacheId ${pivotCacheId} source ref is unparsable` };
  if (!field) return { reason: `cache has no sourceName field to resolve` };
  const fieldIdx = pivot.fieldNames.indexOf(field);
  if (fieldIdx < 0) return { reason: `field '${field}' is not among pivot cacheId ${pivotCacheId} fields` };
  return { col: startCol + fieldIdx, sheet: pivot.source.sheet };
}

// ---------------------------------------------------------------------------
// Model -> app specs
// ---------------------------------------------------------------------------

export interface NativeMappingOptions {
  pivots?: NativePivotInput[];
  tables?: NativeTableInput[];
  /** First spec id assigned; the caller must pass a base that cannot
   * collide with existing specs (App passes Date.now()). Defaults to 1
   * for deterministic tests. */
  idBase?: number;
}

/**
 * Map a native slicer/timeline model to app specs. Never throws; every
 * control that cannot be rendered is listed in `unresolved` with a reason.
 * Accepts either a parsed model or a raw metadata value.
 */
export function nativeSlicersTimelinesToSpecs(
  modelOrValue: NativeSlicersTimelinesModel | unknown,
  opts: NativeMappingOptions = {},
): NativeSlicersTimelinesResult {
  const empty: NativeSlicersTimelinesResult = { slicers: [], timelines: [], unresolved: [] };
  const model = isRecord(modelOrValue) && ('slicerCaches' in modelOrValue || 'sheetSlicers' in modelOrValue || 'timelineCaches' in modelOrValue || 'sheetTimelines' in modelOrValue)
    ? (modelOrValue as NativeSlicersTimelinesModel)
    : parseNativeSlicersTimelines(modelOrValue);
  if (!model) return empty;
  const pivots = opts.pivots ?? [];
  const tables = opts.tables ?? [];
  let nextId = opts.idBase ?? 1;

  const caches = new Map<string, NativeSlicerCache>();
  for (const c of asArray(model.slicerCaches)) {
    if (isRecord(c) && typeof c.name === 'string') caches.set(c.name, c as unknown as NativeSlicerCache);
  }
  const timelineCaches = new Map<string, NativeTimelineCache>();
  for (const c of asArray(model.timelineCaches)) {
    if (isRecord(c) && typeof c.name === 'string') timelineCaches.set(c.name, c as unknown as NativeTimelineCache);
  }

  let slicerPos = 0;
  let timelinePos = 0;

  for (const sheet of asArray(model.sheetSlicers)) {
    if (!isRecord(sheet) || typeof sheet.sheetName !== 'string') continue;
    for (const view of asArray(sheet.slicers)) {
      if (!isRecord(view) || typeof view.name !== 'string' || typeof view.cache !== 'string') continue;
      const cache = caches.get(view.cache);
      if (!cache) {
        empty.unresolved.push({ kind: 'slicer', view: view.name, cache: view.cache, sheet: sheet.sheetName, reason: `no slicer cache named '${view.cache}'` });
        continue;
      }
      const field = (typeof view.caption === 'string' && view.caption !== '' ? view.caption : undefined) ?? cache.sourceName ?? cache.name;
      const pivotNames = asArray(cache.pivotTables)
        .filter((p): p is NativeCachePivotTableRef => isRecord(p) && typeof p.name === 'string')
        .map((p) => p.name);
      const data = cache.data;
      if (!data) {
        empty.unresolved.push({ kind: 'slicer', view: view.name, cache: cache.name, sheet: sheet.sheetName, reason: `cache '${cache.name}' carries no binding data` });
        continue;
      }
      if (data.kind === 'olap') {
        // #114: an OLAP slicer filters its bound pivots by re-query,
        // never by grid column. It maps to a spec (col -1) plus the
        // dimension binding and the cache's pivot refs; panel values
        // are the cache level members. Unresolvable here only when
        // the dimension or the members cannot be read.
        const dim = parseOlapDimension(cache.sourceName);
        const members = olapCacheMembers(data);
        if (!dim) {
          empty.unresolved.push({ kind: 'slicer', view: view.name, cache: cache.name, sheet: sheet.sheetName, reason: `OLAP slicer '${cache.name}' has an unparsable dimension '${cache.sourceName ?? ''}'` });
          continue;
        }
        if (members.length === 0) {
          empty.unresolved.push({ kind: 'slicer', view: view.name, cache: cache.name, sheet: sheet.sheetName, reason: `OLAP slicer '${cache.name}' lists no dimension members` });
          continue;
        }
        const pivotRefs = asArray(cache.pivotTables)
          .filter((p): p is NativeCachePivotTableRef => isRecord(p) && typeof p.name === 'string')
          .map((p) => ({ ...(typeof p.tabId === 'number' ? { tabId: p.tabId } : {}), name: p.name }));
        empty.slicers.push({
          spec: {
            id: nextId++,
            col: -1,
            field,
            selected: [],
            pivotIds: [],
            x: 32 + slicerPos * 48,
            y: 170,
            w: 220,
            sheet: sheet.sheetName,
            nativeCache: cache.name,
            nativeView: view.name,
            olap: { table: dim.table, column: dim.column, cacheName: cache.name },
          },
          pivotNames,
          pivotRefs,
          members,
          selectionRestored: false,
        });
        slicerPos++;
        continue;
      }
      if (data.kind === 'table') {
        const table = tables.find((t) => t.id === data.tableId);
        if (!table) {
          empty.unresolved.push({ kind: 'slicer', view: view.name, cache: cache.name, sheet: sheet.sheetName, reason: `tableId ${data.tableId} not found among supplied tables` });
          continue;
        }
        const colField = table.columns[data.column] ?? field;
        empty.slicers.push({
          spec: {
            id: nextId++,
            col: table.startCol + data.column,
            field: colField,
            selected: [],
            pivotIds: [],
            x: 32 + slicerPos * 48,
            y: 170,
            w: 220,
            sheet: sheet.sheetName,
            nativeCache: cache.name,
            nativeView: view.name,
          },
          pivotNames,
          selectionRestored: false,
        });
        slicerPos++;
        continue;
      }
      // Tabular: resolve through the pivot source range.
      const resolved = pivotFieldColumn(pivots, data.pivotCacheId, cache.sourceName);
      if ('reason' in resolved) {
        empty.unresolved.push({ kind: 'slicer', view: view.name, cache: cache.name, sheet: sheet.sheetName, reason: resolved.reason });
        continue;
      }
      empty.slicers.push({
        spec: {
          id: nextId++,
          col: resolved.col,
          field,
          selected: [],
          pivotIds: [],
          x: 32 + slicerPos * 48,
          y: 170,
          w: 220,
          sheet: sheet.sheetName,
          nativeCache: cache.name,
          nativeView: view.name,
        },
        pivotNames,
        selectionRestored: false,
      });
      slicerPos++;
    }
  }

  // Caches with no sheet view are controls Excel would not draw either,
  // but they are still not silently dropped: report them.
  for (const cache of caches.values()) {
    const hasView = asArray(model.sheetSlicers).some((s) =>
      isRecord(s) && asArray(s.slicers).some((v) => isRecord(v) && v.cache === cache.name),
    );
    if (!hasView) {
      empty.unresolved.push({ kind: 'slicer', view: '', cache: cache.name, sheet: '', reason: `cache '${cache.name}' has no sheet view` });
    }
  }

  for (const sheet of asArray(model.sheetTimelines)) {
    if (!isRecord(sheet) || typeof sheet.sheetName !== 'string') continue;
    for (const view of asArray(sheet.timelines)) {
      if (!isRecord(view) || typeof view.name !== 'string' || typeof view.cache !== 'string') continue;
      const cache = timelineCaches.get(view.cache);
      if (!cache) {
        empty.unresolved.push({ kind: 'timeline', view: view.name, cache: view.cache, sheet: sheet.sheetName, reason: `no timeline cache named '${view.cache}'` });
        continue;
      }
      const state = cache.state;
      const range = state?.selection ?? state?.bounds;
      if (!state || !range) {
        empty.unresolved.push({ kind: 'timeline', view: view.name, cache: cache.name, sheet: sheet.sheetName, reason: `cache '${cache.name}' carries no selection or bounds range` });
        continue;
      }
      const start = dateFromIsoDateTime(range.startDate);
      const end = dateFromIsoDateTime(range.endDate);
      if (!start || !end) {
        empty.unresolved.push({ kind: 'timeline', view: view.name, cache: cache.name, sheet: sheet.sheetName, reason: `cache '${cache.name}' range dates are unparsable` });
        continue;
      }
      const resolved = pivotFieldColumn(pivots, state.pivotCacheId, cache.sourceName);
      if ('reason' in resolved) {
        empty.unresolved.push({ kind: 'timeline', view: view.name, cache: cache.name, sheet: sheet.sheetName, reason: resolved.reason });
        continue;
      }
      const lo = start <= end ? start : end;
      const hi = start <= end ? end : start;
      empty.timelines.push({
        spec: {
          id: nextId++,
          col: resolved.col,
          field: (typeof view.caption === 'string' && view.caption !== '' ? view.caption : undefined) ?? cache.sourceName ?? cache.name,
          start: lo,
          end: hi,
          granularity: timelineGranularity(
            typeof view.level === 'string' ? view.level : undefined,
            typeof view.selectionLevel === 'string' ? view.selectionLevel : undefined,
          ),
          x: 280 + timelinePos * 48,
          y: 170,
          w: 300,
          sheet: sheet.sheetName,
          nativeCache: cache.name,
          nativeView: view.name,
        },
      });
      timelinePos++;
    }
  }

  for (const cache of timelineCaches.values()) {
    const hasView = asArray(model.sheetTimelines).some((s) =>
      isRecord(s) && asArray(s.timelines).some((v) => isRecord(v) && v.cache === cache.name),
    );
    if (!hasView) {
      empty.unresolved.push({ kind: 'timeline', view: '', cache: cache.name, sheet: '', reason: `cache '${cache.name}' has no sheet view` });
    }
  }
  return empty;
}

// ---------------------------------------------------------------------------
// App specs -> native model (timeline selections only; see docstring)
// ---------------------------------------------------------------------------

/**
 * Write edited timeline ranges back into a native model: for each spec
 * with a nativeCache matching a timeline cache name, set
 * cache.state.selection to the spec's [start, end] as ISO dateTimes.
 * Everything else in the model is preserved verbatim (structured clone
 * via JSON). Returns the updated model as a JSON string, or null when
 * the input value is not a parsable model. Slicer specs are deliberately
 * NOT written back: their selections are not restorable from the model
 * (see module docstring), so overwriting cache items from panel state
 * would fabricate data — the save path must keep the original model for
 * slicers and only apply this function's timeline updates.
 */
export function applyTimelineSelectionsToModel(value: unknown, timelines: TimelineSpec[]): string | null {
  const model = parseNativeSlicersTimelines(value);
  if (!model) return null;
  const clone = JSON.parse(JSON.stringify(model)) as NativeSlicersTimelinesModel;
  const byCache = new Map<string, TimelineSpec>();
  for (const t of timelines) if (t.nativeCache) byCache.set(t.nativeCache, t);
  for (const cache of asArray(clone.timelineCaches)) {
    if (!isRecord(cache) || typeof cache.name !== 'string') continue;
    const spec = byCache.get(cache.name);
    if (!spec) continue;
    const state = (cache as unknown as { state?: { selection?: NativeTimelineRange } }).state;
    if (!state) continue;
    state.selection = { startDate: isoDateTimeOf(spec.start), endDate: isoDateTimeOf(spec.end) };
  }
  return JSON.stringify(clone);
}
