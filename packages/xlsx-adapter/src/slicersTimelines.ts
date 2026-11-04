/**
 * Native XLSX slicer + timeline parts (OOXML wave 3a, audit §§4.1–4.2, §7.4).
 *
 * SheetJS CE drops these parts entirely, so — like pivotTables.ts — this
 * module reads and writes them directly at the OOXML package level:
 *
 * - Slicer caches: `xl/slicerCaches/slicerCacheN.xml`, root
 *   `<slicerCacheDefinition>` in the x14 namespace ([MS-XLSX] §2.6). The
 *   cache carries its source name, the pivot tables it drives
 *   (`<pivotTables><pivotTable tabId name/>`), and its filter state in
 *   `<data>`: a `<tabular>` cache (pivotCacheId + selected item indexes
 *   into the pivot cache field's shared items), an `<olap>` cache
 *   (levels/ranges/selections over an OLAP hierarchy), or — for table
 *   slicers — no `<data>` at all and an x15 `tableSlicerCache` extension
 *   (tableId + column) in the part's `<extLst>`.
 * - Per-sheet slicer views: `xl/slicers/slicerN.xml`, root `<slicers>`
 *   (x14), one `<slicer>` per control, bound to a cache by NAME and
 *   linked from the worksheet part via a `slicer` relationship.
 * - Timeline caches: `xl/timelineCaches/timelineCacheN.xml`, root
 *   `<timelineCacheDefinition>` in the x15 namespace ([MS-XLSX] §2.6):
 *   the driven pivot tables, and `<state>` — the pivotCacheId binding,
 *   the data bounds, and the SELECTED date range.
 * - Per-sheet timeline views: `xl/timelines/timelineN.xml`, root
 *   `<timelines>` (x15): each `<timeline>` names its cache and carries
 *   the granularity level (years/quarters/months/days), the level the
 *   selection was made at, and the scroll position.
 * - Pivot linkage (§7.4): the binding lives primarily in the cache parts
 *   (tabular/olap `pivotCacheId`, the caches' `<pivotTables>` lists,
 *   timeline state `pivotCacheId`). This module also parses the
 *   pivot-side references when a producer writes them — `slicerCache` /
 *   `timelineCache` relationship references inside a pivotCacheDefinition
 *   part's `<extLst>` (resolved through that part's `.rels`), the x15
 *   `timelinePivotCacheDefinition` marker on a cache definition, and
 *   slicer references in a pivotTableDefinition `<extLst>` — and exposes
 *   them as typed `linkage` records.
 * - Drawing references: a slicer/timeline control's on-sheet shape is a
 *   drawing graphicFrame whose `<a:graphicData>` (drawing 2010 slicer /
 *   2012 timeslicer namespaces) names the view. Those names are parsed
 *   into `drawingRefs`; the drawing parts themselves round-trip through
 *   the existing drawings path.
 *
 * Write path: unlike pivots (byte-verbatim re-injection), slicer and
 * timeline parts are REGENERATED from the typed model
 * (`injectSlicerTimelineParts`), with workbook relationships, the
 * workbook `<extLst>` slicer-cache registry lists (x14 list for
 * pivot/OLAP caches, x15 list for table caches — the split real Excel
 * files carry), sheet relationships, and content-type overrides wired
 * to match. The original part bytes are still captured (`rawParts`,
 * base64) as a fallback for callers that hold parts but no model.
 *
 * Model fidelity rule (same as the rest of the adapter): an attribute
 * is present in the model iff it was present in the XML, and the
 * serializer writes exactly the attributes the model carries — so
 * parse → model → write → re-parse is an identity on the model.
 *
 * Never throws: any missing/corrupt part yields fewer entries, never an
 * error (read), and an unchanged package (write).
 */

import { unzipSync } from 'fflate';
import { base64ToU8, u8ToBase64 } from './macroProject.js';
import { zipSyncStable } from './zipStable.js';

// ---------------------------------------------------------------------------
// Namespaces, relationship types, extension URIs, content types.
// ---------------------------------------------------------------------------

export const X14_NAMESPACE = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
export const X15_NAMESPACE = 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main';
export const XR10_NAMESPACE = 'http://schemas.microsoft.com/office/spreadsheetml/2016/revision10';
const MC_NAMESPACE = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const MAIN_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

export const SLICER_CACHE_REL_TYPE =
  'http://schemas.microsoft.com/office/2007/relationships/slicerCache';
export const SLICER_REL_TYPE = 'http://schemas.microsoft.com/office/2007/relationships/slicer';
export const TIMELINE_CACHE_REL_TYPE =
  'http://schemas.microsoft.com/office/2007/relationships/timelineCache';
export const TIMELINE_REL_TYPE = 'http://schemas.microsoft.com/office/2007/relationships/timeline';

/** x15 extension inside a slicer cache part that binds it to a table column. */
export const TABLE_SLICER_CACHE_EXT_URI = '{2F2917AC-EB37-4324-AD4E-5DD8C200BD13}';
/** Workbook <extLst> extension listing pivot/OLAP slicer caches. */
export const WORKBOOK_SLICER_CACHES_X14_EXT_URI = '{BBE1A952-AA13-448e-AADC-164F8A28A991}';
/** Workbook <extLst> extension listing table slicer caches. */
export const WORKBOOK_SLICER_CACHES_X15_EXT_URI = '{46BE6895-7355-4a93-B00E-2C351335B9C9}';

/** Workbook-metadata key carrying the parsed model (JSON). */
export const SLICERS_TIMELINES_METADATA_KEY = 'icecream.slicersTimelines';
/**
 * Raw-parts metadata key. Deliberately NOT `icecream.`-prefixed so the
 * adapter's custom-property persistence does not duplicate the base64
 * bulk into the file (same rule as PIVOT_PARTS_METADATA_KEY).
 */
export const SLICER_PARTS_METADATA_KEY = 'xlsx.slicerParts';

// ---------------------------------------------------------------------------
// Typed model.
// ---------------------------------------------------------------------------

/** A pivot table a slicer/timeline cache drives (tabId = the sheetId of the sheet hosting the pivot). */
export interface CachePivotTableRef {
  tabId: number;
  name: string;
}

/** One item of a tabular (non-OLAP) slicer cache: an index into the cache field's shared items. */
export interface TabularSlicerCacheItem {
  /** `x` — zero-based index into the pivot cache field's shared items. */
  index: number;
  /** `s` — present iff the attribute was in the XML. */
  selected?: boolean;
  /** `nd` — non-display item (no longer present in the source data). */
  nonDisplay?: boolean;
}

export interface TabularSlicerCacheData {
  kind: 'tabular';
  /** The pivot cache this slicer filters (CT_PivotCacheDefinition cacheId / OLAP id). */
  pivotCacheId: number;
  sortOrder?: 'ascending' | 'descending';
  customListSort?: boolean;
  showMissing?: boolean;
  /** ST_SlicerCacheCrossFilter value, verbatim. */
  crossFilter?: string;
  items: TabularSlicerCacheItem[];
}

/** One OLAP slicer item: a hierarchy member. */
export interface OlapSlicerCacheItem {
  /** `n` — member unique name, e.g. "[tblCal].[Year].&[2012]". */
  name: string;
  /** `c` — display caption, when present. */
  caption?: string;
}

export interface OlapSlicerCacheRange {
  startItem?: number;
  items: OlapSlicerCacheItem[];
}

export interface OlapSlicerCacheLevel {
  uniqueName: string;
  sourceCaption?: string;
  /** Item count Excel recorded for the level (0 for the (All) level). */
  count?: number;
  ranges: OlapSlicerCacheRange[];
}

export interface OlapSlicerCacheSelection {
  /** `n` — the selected member unique name (e.g. the hierarchy's [All] member). */
  name?: string;
  ranges: OlapSlicerCacheRange[];
}

export interface OlapSlicerCacheData {
  kind: 'olap';
  pivotCacheId: number;
  levels: OlapSlicerCacheLevel[];
  selections: OlapSlicerCacheSelection[];
}

/** A slicer over a worksheet table (ListObject) column — the binding lives in the cache part's x15 extLst. */
export interface TableSlicerCacheData {
  kind: 'table';
  tableId: number;
  /** Zero-based column index within the table. */
  column: number;
}

export type SlicerCacheData = TabularSlicerCacheData | OlapSlicerCacheData | TableSlicerCacheData;

export interface SlicerCache {
  /** Cache name — slicer views bind to the cache by this name. */
  name: string;
  /** xr10:uid, when the producer wrote one. */
  uid?: string;
  /** Source field: a cache field name ("Type") or an OLAP unique name ("[tblCal].[Year]"). */
  sourceName?: string;
  /**
   * Which workbook <extLst> registry lists this cache: 'x14' for
   * pivot/OLAP caches, 'x15' for table caches (the split real Excel
   * files carry). Defaults to 'x14' when the file has no registry.
   */
  registry: 'x14' | 'x15';
  /** Pivot tables this cache drives (empty for table caches). */
  pivotTables: CachePivotTableRef[];
  /** Filter state + source binding. Absent when the part carried neither <data> nor a table ext. */
  data?: SlicerCacheData;
  /** Part path in the source package, e.g. "xl/slicerCaches/slicerCache1.xml". */
  partPath: string;
}

/** One slicer control on a sheet (xl/slicers/slicerN.xml `<slicer>`). */
export interface SlicerView {
  name: string;
  uid?: string;
  /** Name of the slicer cache this control is bound to. */
  cache: string;
  caption?: string;
  startItem?: number;
  columnCount?: number;
  showCaption?: boolean;
  /** OLAP hierarchy level displayed (0-based), when present. */
  level?: number;
  style?: string;
  lockedPosition?: boolean;
  rowHeight?: number;
}

export interface SheetSlicers {
  sheetName: string;
  sheetIndex: number;
  partPath: string;
  slicers: SlicerView[];
}

/** Timeline granularity — the same vocabulary as the app's TimelineSpec. */
export type TimelineLevel = 'years' | 'quarters' | 'months' | 'days';

export interface TimelineRange {
  /** ISO dateTime as written in the file, e.g. "2013-01-01T00:00:00". */
  startDate: string;
  endDate: string;
}

export interface TimelineCacheState {
  /** The pivot cache this timeline filters — the pivot binding. */
  pivotCacheId: number;
  /** ST_PivotFilterType value, verbatim (e.g. "dateAll"). */
  filterType: string;
  minimalRefreshVersion: number;
  lastRefreshVersion: number;
  singleRangeFilterState?: boolean;
  /** The selected date range; absent = no selection (whole bounds). */
  selection?: TimelineRange;
  /** The full date range present in the cache. */
  bounds: TimelineRange;
}

export interface TimelineCache {
  name: string;
  uid?: string;
  sourceName?: string;
  partPath: string;
  pivotTables: CachePivotTableRef[];
  state: TimelineCacheState;
  /** True when the part carried a <timelinePivotFilter> (its filter detail is not modeled in v1). */
  pivotFilterPresent: boolean;
}

/** One timeline control on a sheet (xl/timelines/timelineN.xml `<timeline>`). */
export interface TimelineView {
  name: string;
  uid?: string;
  /** Name of the timeline cache this control is bound to. */
  cache: string;
  caption?: string;
  showHeader?: boolean;
  showSelectionLabel?: boolean;
  showTimeLevel?: boolean;
  showHorizontalScrollbar?: boolean;
  /** Granularity currently displayed. */
  level?: TimelineLevel;
  /** Granularity at which the current selection was made. */
  selectionLevel?: TimelineLevel;
  /** Scroll position (ISO dateTime), when present. */
  scrollingPosition?: string;
  style?: string;
}

export interface SheetTimelines {
  sheetName: string;
  sheetIndex: number;
  partPath: string;
  timelines: TimelineView[];
}

/** Slicer/timeline linkage resolved onto one pivot cache (§7.4). */
export interface PivotCacheLinkage {
  /** cacheId from the workbook <pivotCaches> list; -1 when unresolvable. */
  cacheId: number;
  /** pivotCacheDefinition part path. */
  defPath: string;
  /** Slicer cache names bound to this pivot cache (cache-side declarations + def extLst refs). */
  slicerCacheNames: string[];
  /** Timeline cache names bound to this pivot cache. */
  timelineCacheNames: string[];
  /** x15 timelinePivotCacheDefinition timelineData marker on the cache definition. */
  timelineData: boolean;
}

/** Slicer references found in one pivotTableDefinition part's <extLst>. */
export interface PivotTableLinkage {
  tablePath: string;
  pivotTableName: string;
  slicerCacheNames: string[];
}

/** A drawing graphicFrame reference to a slicer/timeline view, by view name. */
export interface SlicerDrawingRef {
  partPath: string;
  kind: 'slicer' | 'timeline';
  name: string;
}

export interface SlicersTimelinesModel {
  slicerCaches: SlicerCache[];
  sheetSlicers: SheetSlicers[];
  timelineCaches: TimelineCache[];
  sheetTimelines: SheetTimelines[];
  linkage: { caches: PivotCacheLinkage[]; tables: PivotTableLinkage[] };
  drawingRefs: SlicerDrawingRef[];
}

/** Raw part bytes for the no-model fallback write path. */
export interface SlicerTimelineRawParts {
  /** Part path → base64 bytes for every slicer/timeline part read. */
  parts: Record<string, string>;
  slicerCaches: { name: string; partPath: string; registry: 'x14' | 'x15' }[];
  sheetSlicers: { sheetName: string; partPath: string }[];
  timelineCaches: { name: string; partPath: string }[];
  sheetTimelines: { sheetName: string; partPath: string }[];
}

export interface ReadSlicersTimelinesResult extends SlicersTimelinesModel {
  rawParts: SlicerTimelineRawParts;
}

// ---------------------------------------------------------------------------
// Small XML helpers (same regex-based approach as pivotTables.ts).
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip namespace prefixes from element names (attribute names untouched). */
function denamespaceXml(xml: string): string {
  return xml.replace(/<(\/?)([A-Za-z_][\w.-]*):/g, '<$1');
}

/**
 * One attribute of a tag string, or null. Anchored on whitespace/start so
 * `name` never matches the tail of `sourceName`.
 */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[:]/g, '\\:')}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]!) : null;
}

function intAttr(tag: string, name: string): number | null {
  const v = attr(tag, name);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/** OOXML boolean attribute: present → boolean, absent → undefined (model fidelity rule). */
function boolAttr(tag: string, name: string): boolean | undefined {
  const v = attr(tag, name);
  if (v === null) return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

function boolStr(v: boolean): string {
  return v ? '1' : '0';
}

/** Open tag of the first `<name ...>` element (self-closing or not). */
function openTag(xml: string, name: string): string {
  const m = new RegExp(`<${name}(\\s[^>]*)?/?>`).exec(xml);
  return m ? m[0] : '';
}

/** Every `<name ...>...</name>` or `<name .../>` block, in document order. */
function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}(\\s[^>]*?)?(?:/>|>[\\s\\S]*?</${name}>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

/** First `<name ...>...</name>` block (non-greedy); '' when absent. */
function element(xml: string, name: string): string {
  const m = new RegExp(`<${name}(\\s[^>]*)?>[\\s\\S]*?</${name}>`).exec(xml);
  return m ? m[0] : '';
}

/** Resolve a relationship Target against the part that owns the .rels file. */
function resolveTarget(ownerPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const dir = ownerPart.includes('/') ? ownerPart.slice(0, ownerPart.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  for (const seg of (dir + target).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** r:id → resolved part path for relationships whose Type ends with `suffix`. */
function relTargets(
  files: Record<string, Uint8Array>,
  relsPath: string,
  typeSuffix: string,
  ownerPart: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const raw = files[relsPath];
  if (!raw) return out;
  const rels = denamespaceXml(decoder.decode(raw));
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    const type = attr(tag, 'Type') ?? '';
    if (id && target && type.endsWith(typeSuffix)) {
      out.set(id, resolveTarget(ownerPart, target));
    }
  }
  return out;
}

interface SheetPartInfo {
  name: string;
  path: string;
  sheetId: number;
}

/** Sheets via xl/workbook.xml + workbook rels (exact — no sheetN guessing). */
function sheetPartPaths(files: Record<string, Uint8Array>): SheetPartInfo[] {
  const out: SheetPartInfo[] = [];
  const wbXml = files['xl/workbook.xml'];
  if (!wbXml) return out;
  const wb = denamespaceXml(decoder.decode(wbXml));
  const targetByRid = relTargets(files, 'xl/_rels/workbook.xml.rels', '/worksheet', 'xl/workbook.xml');
  for (const tag of wb.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attr(tag, 'name');
    const rid = attr(tag, 'r:id');
    if (name && rid) {
      const path = targetByRid.get(rid);
      if (path) out.push({ name, path, sheetId: intAttr(tag, 'sheetId') ?? -1 });
    }
  }
  return out;
}

function relsPathFor(partPath: string): string {
  return partPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
}

function sheetRelsPath(sheetPath: string): string {
  const dir = sheetPath.includes('/') ? sheetPath.slice(0, sheetPath.lastIndexOf('/')) : '';
  const base = sheetPath.slice(sheetPath.lastIndexOf('/') + 1);
  return `${dir}/_rels/${base}.rels`;
}

// ---------------------------------------------------------------------------
// Parse: slicer caches.
// ---------------------------------------------------------------------------

function parseCachePivotTables(scope: string): CachePivotTableRef[] {
  const out: CachePivotTableRef[] = [];
  const el = element(scope, 'pivotTables');
  if (!el) return out;
  for (const tag of el.match(/<pivotTable\b[^>]*>/g) ?? []) {
    const name = attr(tag, 'name');
    const tabId = intAttr(tag, 'tabId');
    if (name !== null && tabId !== null) out.push({ tabId, name });
  }
  return out;
}

function parseOlapRanges(scope: string): OlapSlicerCacheRange[] {
  const out: OlapSlicerCacheRange[] = [];
  const rangesEl = element(scope, 'ranges');
  const inner = rangesEl || '';
  for (const rangeBlock of blocks(inner, 'range')) {
    const items: OlapSlicerCacheItem[] = [];
    for (const tag of rangeBlock.match(/<i\b[^>]*>/g) ?? []) {
      const n = attr(tag, 'n');
      if (n === null) continue;
      const c = attr(tag, 'c');
      items.push(c !== null ? { name: n, caption: c } : { name: n });
    }
    const startItem = intAttr(openTag(rangeBlock, 'range'), 'startItem');
    out.push(startItem !== null ? { startItem, items } : { items });
  }
  return out;
}

function parseOlapData(olapBlock: string): OlapSlicerCacheData {
  const pivotCacheId = intAttr(openTag(olapBlock, 'olap'), 'pivotCacheId') ?? 0;
  const levels: OlapSlicerCacheLevel[] = [];
  const levelsEl = element(olapBlock, 'levels');
  if (levelsEl) {
    for (const levelBlock of blocks(levelsEl, 'level')) {
      const tag = openTag(levelBlock, 'level');
      const uniqueName = attr(tag, 'uniqueName');
      if (uniqueName === null) continue;
      const level: OlapSlicerCacheLevel = { uniqueName, ranges: parseOlapRanges(levelBlock) };
      const sourceCaption = attr(tag, 'sourceCaption');
      if (sourceCaption !== null) level.sourceCaption = sourceCaption;
      const count = intAttr(tag, 'count');
      if (count !== null) level.count = count;
      levels.push(level);
    }
  }
  const selections: OlapSlicerCacheSelection[] = [];
  const selectionsEl = element(olapBlock, 'selections');
  if (selectionsEl) {
    for (const selBlock of blocks(selectionsEl, 'selection')) {
      const sel: OlapSlicerCacheSelection = { ranges: parseOlapRanges(selBlock) };
      const n = attr(openTag(selBlock, 'selection'), 'n');
      if (n !== null) sel.name = n;
      selections.push(sel);
    }
  }
  return { kind: 'olap', pivotCacheId, levels, selections };
}

function parseTabularData(tabularBlock: string): TabularSlicerCacheData {
  const tag = openTag(tabularBlock, 'tabular');
  const data: TabularSlicerCacheData = {
    kind: 'tabular',
    pivotCacheId: intAttr(tag, 'pivotCacheId') ?? 0,
    items: [],
  };
  const sortOrder = attr(tag, 'sortOrder');
  if (sortOrder === 'ascending' || sortOrder === 'descending') data.sortOrder = sortOrder;
  const customListSort = boolAttr(tag, 'customListSort');
  if (customListSort !== undefined) data.customListSort = customListSort;
  const showMissing = boolAttr(tag, 'showMissing');
  if (showMissing !== undefined) data.showMissing = showMissing;
  const crossFilter = attr(tag, 'crossFilter');
  if (crossFilter !== null) data.crossFilter = crossFilter;
  const itemsEl = element(tabularBlock, 'items');
  if (itemsEl) {
    for (const itemTag of itemsEl.match(/<item\b[^>]*>/g) ?? []) {
      const x = intAttr(itemTag, 'x');
      if (x === null) continue;
      const item: TabularSlicerCacheItem = { index: x };
      const s = boolAttr(itemTag, 's');
      if (s !== undefined) item.selected = s;
      const nd = boolAttr(itemTag, 'nd');
      if (nd !== undefined) item.nonDisplay = nd;
      data.items.push(item);
    }
  }
  return data;
}

/** Parse one slicerCacheDefinition part into the typed cache model (null when unparseable). */
export function parseSlicerCacheXml(xml: string, partPath: string): SlicerCache | null {
  try {
    const den = denamespaceXml(xml);
    const rootTag = openTag(den, 'slicerCacheDefinition');
    if (!rootTag) return null;
    const name = attr(rootTag, 'name');
    if (name === null) return null;
    const cache: SlicerCache = { name, registry: 'x14', pivotTables: parseCachePivotTables(den), partPath };
    const uid = attr(rootTag, 'xr10:uid');
    if (uid !== null) cache.uid = uid;
    const sourceName = attr(rootTag, 'sourceName');
    if (sourceName !== null) cache.sourceName = sourceName;

    const dataEl = element(den, 'data');
    if (dataEl) {
      const tabular = element(dataEl, 'tabular');
      const olap = element(dataEl, 'olap');
      if (tabular) cache.data = parseTabularData(tabular);
      else if (olap) cache.data = parseOlapData(olap);
    }
    if (!cache.data) {
      // Table slicer: the binding is the x15 tableSlicerCache extension.
      const extLst = element(den, 'extLst');
      const tsTag = extLst ? openTag(extLst, 'tableSlicerCache') : '';
      if (tsTag) {
        const tableId = intAttr(tsTag, 'tableId');
        const column = intAttr(tsTag, 'column');
        if (tableId !== null && column !== null) {
          cache.data = { kind: 'table', tableId, column };
        }
      }
    }
    // Default registry from the data kind (table caches are x15-listed);
    // readSlicersTimelines overrides this from the workbook <extLst> when
    // the file carries an explicit registry.
    if (cache.data?.kind === 'table') cache.registry = 'x15';
    return cache;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parse: per-sheet slicer views.
// ---------------------------------------------------------------------------

/** Parse one xl/slicers/slicerN.xml part into its view list. */
export function parseSlicersXml(xml: string): SlicerView[] {
  const out: SlicerView[] = [];
  try {
    const den = denamespaceXml(xml);
    for (const tag of den.match(/<slicer\b[^>]*>/g) ?? []) {
      const name = attr(tag, 'name');
      const cacheName = attr(tag, 'cache');
      if (name === null || cacheName === null) continue;
      const view: SlicerView = { name, cache: cacheName };
      const uid = attr(tag, 'xr10:uid');
      if (uid !== null) view.uid = uid;
      const caption = attr(tag, 'caption');
      if (caption !== null) view.caption = caption;
      const startItem = intAttr(tag, 'startItem');
      if (startItem !== null) view.startItem = startItem;
      const columnCount = intAttr(tag, 'columnCount');
      if (columnCount !== null) view.columnCount = columnCount;
      const showCaption = boolAttr(tag, 'showCaption');
      if (showCaption !== undefined) view.showCaption = showCaption;
      const level = intAttr(tag, 'level');
      if (level !== null) view.level = level;
      const style = attr(tag, 'style');
      if (style !== null) view.style = style;
      const lockedPosition = boolAttr(tag, 'lockedPosition');
      if (lockedPosition !== undefined) view.lockedPosition = lockedPosition;
      const rowHeight = intAttr(tag, 'rowHeight');
      if (rowHeight !== null) view.rowHeight = rowHeight;
      out.push(view);
    }
  } catch {
    // best-effort
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parse: timeline caches + views.
// ---------------------------------------------------------------------------

const TIMELINE_LEVELS: TimelineLevel[] = ['years', 'quarters', 'months', 'days'];

function parseTimelineLevel(raw: string | null): TimelineLevel | undefined {
  if (raw === null) return undefined;
  const t = raw.trim().toLowerCase();
  if ((TIMELINE_LEVELS as string[]).includes(t)) return t as TimelineLevel;
  const n = parseInt(t, 10);
  if (!Number.isNaN(n) && n >= 0 && n < TIMELINE_LEVELS.length) return TIMELINE_LEVELS[n];
  return undefined;
}

function parseTimelineRange(scope: string, tagName: 'selection' | 'bounds'): TimelineRange | null {
  const tag = openTag(scope, tagName);
  if (!tag) return null;
  const startDate = attr(tag, 'startDate');
  const endDate = attr(tag, 'endDate');
  if (startDate === null || endDate === null) return null;
  return { startDate, endDate };
}

/** Parse one timelineCacheDefinition part into the typed cache model (null when unparseable). */
export function parseTimelineCacheXml(xml: string, partPath: string): TimelineCache | null {
  try {
    const den = denamespaceXml(xml);
    const rootTag = openTag(den, 'timelineCacheDefinition');
    if (!rootTag) return null;
    const name = attr(rootTag, 'name');
    if (name === null) return null;
    const stateEl = element(den, 'state');
    if (!stateEl) return null;
    const stateTag = openTag(stateEl, 'state');
    const bounds = parseTimelineRange(stateEl, 'bounds');
    if (!bounds) return null;
    const state: TimelineCacheState = {
      pivotCacheId: intAttr(stateTag, 'pivotCacheId') ?? 0,
      filterType: attr(stateTag, 'filterType') ?? 'dateAll',
      minimalRefreshVersion: intAttr(stateTag, 'minimalRefreshVersion') ?? 0,
      lastRefreshVersion: intAttr(stateTag, 'lastRefreshVersion') ?? 0,
      bounds,
    };
    const single = boolAttr(stateTag, 'singleRangeFilterState');
    if (single !== undefined) state.singleRangeFilterState = single;
    const selection = parseTimelineRange(stateEl, 'selection');
    if (selection) state.selection = selection;
    const cache: TimelineCache = {
      name,
      partPath,
      pivotTables: parseCachePivotTables(den),
      state,
      pivotFilterPresent: /<timelinePivotFilter\b/.test(den),
    };
    const uid = attr(rootTag, 'xr10:uid');
    if (uid !== null) cache.uid = uid;
    const sourceName = attr(rootTag, 'sourceName');
    if (sourceName !== null) cache.sourceName = sourceName;
    return cache;
  } catch {
    return null;
  }
}

/** Parse one xl/timelines/timelineN.xml part into its view list. */
export function parseTimelinesXml(xml: string): TimelineView[] {
  const out: TimelineView[] = [];
  try {
    const den = denamespaceXml(xml);
    for (const tag of den.match(/<timeline\b[^>]*>/g) ?? []) {
      const name = attr(tag, 'name');
      const cacheName = attr(tag, 'cache');
      if (name === null || cacheName === null) continue;
      const view: TimelineView = { name, cache: cacheName };
      const uid = attr(tag, 'xr10:uid');
      if (uid !== null) view.uid = uid;
      const caption = attr(tag, 'caption');
      if (caption !== null) view.caption = caption;
      const showHeader = boolAttr(tag, 'showHeader');
      if (showHeader !== undefined) view.showHeader = showHeader;
      const showSelectionLabel = boolAttr(tag, 'showSelectionLabel');
      if (showSelectionLabel !== undefined) view.showSelectionLabel = showSelectionLabel;
      const showTimeLevel = boolAttr(tag, 'showTimeLevel');
      if (showTimeLevel !== undefined) view.showTimeLevel = showTimeLevel;
      const showHorizontalScrollbar = boolAttr(tag, 'showHorizontalScrollbar');
      if (showHorizontalScrollbar !== undefined) view.showHorizontalScrollbar = showHorizontalScrollbar;
      const level = parseTimelineLevel(attr(tag, 'level'));
      if (level !== undefined) view.level = level;
      const selectionLevel = parseTimelineLevel(attr(tag, 'selectionLevel'));
      if (selectionLevel !== undefined) view.selectionLevel = selectionLevel;
      const scrollingPosition = attr(tag, 'scrollingPosition');
      if (scrollingPosition !== null) view.scrollingPosition = scrollingPosition;
      const style = attr(tag, 'style');
      if (style !== null) view.style = style;
      out.push(view);
    }
  } catch {
    // best-effort
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parse: pivot linkage (§7.4) + drawing references.
// ---------------------------------------------------------------------------

/** cacheId → pivotCacheDefinition part path, via workbook <pivotCaches> + rels. */
function pivotCacheDefById(files: Record<string, Uint8Array>): Map<number, string> {
  const out = new Map<number, string>();
  const wbRaw = files['xl/workbook.xml'];
  if (!wbRaw) return out;
  const wb = denamespaceXml(decoder.decode(wbRaw));
  const byRid = relTargets(files, 'xl/_rels/workbook.xml.rels', '/pivotCacheDefinition', 'xl/workbook.xml');
  for (const tag of wb.match(/<pivotCache\b[^>]*>/g) ?? []) {
    const cacheId = intAttr(tag, 'cacheId');
    const rid = attr(tag, 'r:id');
    const defPath = rid ? byRid.get(rid) : undefined;
    if (cacheId !== null && defPath) out.set(cacheId, defPath);
  }
  return out;
}

/** r:id attribute values of every `<localName ...>` element inside an extLst string. */
function extRefIds(extLstXml: string, localName: string): string[] {
  const out: string[] = [];
  for (const tag of extLstXml.match(new RegExp(`<${localName}\\b[^>]*>`, 'g')) ?? []) {
    const rid = attr(tag, 'r:id');
    if (rid) out.push(rid);
  }
  return out;
}

function parseDrawingRefs(files: Record<string, Uint8Array>): SlicerDrawingRef[] {
  const out: SlicerDrawingRef[] = [];
  for (const path of Object.keys(files)) {
    if (!/^xl\/drawings\/drawing\d+\.xml$/.test(path)) continue;
    try {
      const den = denamespaceXml(decoder.decode(files[path]!));
      for (const gd of blocks(den, 'graphicData')) {
        const uri = attr(openTag(gd, 'graphicData'), 'uri') ?? '';
        if (uri.includes('/slicer')) {
          const name = attr(openTag(gd, 'slicer'), 'name');
          if (name) out.push({ partPath: path, kind: 'slicer', name });
        } else if (uri.includes('timeslicer') || uri.includes('/timeline')) {
          const name = attr(openTag(gd, 'timeline'), 'name');
          if (name) out.push({ partPath: path, kind: 'timeline', name });
        }
      }
    } catch {
      // best-effort
    }
  }
  return out.sort((a, b) => a.partPath.localeCompare(b.partPath) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Serialize: model → part XML (Excel's own shapes, from real files).
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const X14_ROOT_DECLS =
  `xmlns="${X14_NAMESPACE}" xmlns:mc="${MC_NAMESPACE}" mc:Ignorable="x xr10" ` +
  `xmlns:x="${MAIN_NAMESPACE}" xmlns:xr10="${XR10_NAMESPACE}"`;
const X15_ROOT_DECLS =
  `xmlns="${X15_NAMESPACE}" xmlns:mc="${MC_NAMESPACE}" mc:Ignorable="xr10" xmlns:xr10="${XR10_NAMESPACE}"`;

function a(name: string, value: string | number | boolean | undefined): string {
  if (value === undefined) return '';
  const v = typeof value === 'boolean' ? boolStr(value) : String(value);
  return ` ${name}="${escapeXmlAttr(v)}"`;
}

function pivotTablesXml(refs: CachePivotTableRef[]): string {
  if (refs.length === 0) return '';
  const inner = refs.map((r) => `<pivotTable tabId="${r.tabId}" name="${escapeXmlAttr(r.name)}"/>`).join('');
  return `<pivotTables>${inner}</pivotTables>`;
}

function olapRangesXml(ranges: OlapSlicerCacheRange[]): string {
  if (ranges.length === 0) return '';
  const inner = ranges
    .map((r) => {
      const items = r.items
        .map((i) => `<i n="${escapeXmlAttr(i.name)}"${a('c', i.caption)}/>`)
        .join('');
      return `<range${a('startItem', r.startItem)}>${items}</range>`;
    })
    .join('');
  return `<ranges>${inner}</ranges>`;
}

function slicerCacheDataXml(data: SlicerCacheData): string {
  if (data.kind === 'tabular') {
    const items = data.items
      .map((i) => `<item x="${i.index}"${a('s', i.selected)}${a('nd', i.nonDisplay)}/>`)
      .join('');
    return (
      `<data><tabular pivotCacheId="${data.pivotCacheId}"${a('sortOrder', data.sortOrder)}` +
      `${a('customListSort', data.customListSort)}${a('showMissing', data.showMissing)}` +
      `${a('crossFilter', data.crossFilter)}><items count="${data.items.length}">${items}</items></tabular></data>`
    );
  }
  if (data.kind === 'olap') {
    const levels = data.levels
      .map((l) => {
        const ranges = olapRangesXml(l.ranges);
        const attrs = `uniqueName="${escapeXmlAttr(l.uniqueName)}"${a('sourceCaption', l.sourceCaption)}${a('count', l.count)}`;
        return ranges ? `<level ${attrs}>${ranges}</level>` : `<level ${attrs}/>`;
      })
      .join('');
    const selections = data.selections
      .map((s) => {
        const ranges = olapRangesXml(s.ranges);
        return ranges ? `<selection${a('n', s.name)}>${ranges}</selection>` : `<selection${a('n', s.name)}/>`;
      })
      .join('');
    return (
      `<data><olap pivotCacheId="${data.pivotCacheId}">` +
      (levels ? `<levels count="${data.levels.length}">${levels}</levels>` : '') +
      (selections ? `<selections count="${data.selections.length}">${selections}</selections>` : '') +
      `</olap></data>`
    );
  }
  return ''; // table caches carry no <data>; their binding is the extLst below.
}

export function slicerCacheToXml(cache: SlicerCache): string {
  const attrs =
    `${a('name', cache.name)}${a('xr10:uid', cache.uid)}${a('sourceName', cache.sourceName)}`;
  let inner = pivotTablesXml(cache.pivotTables);
  if (cache.data) inner += slicerCacheDataXml(cache.data);
  if (cache.data?.kind === 'table') {
    inner +=
      `<extLst><ext uri="${TABLE_SLICER_CACHE_EXT_URI}" xmlns:x15="${X15_NAMESPACE}">` +
      `<x15:tableSlicerCache tableId="${cache.data.tableId}" column="${cache.data.column}"/></ext></extLst>`;
  }
  return inner
    ? `${XML_DECL}<slicerCacheDefinition ${X14_ROOT_DECLS}${attrs}>${inner}</slicerCacheDefinition>`
    : `${XML_DECL}<slicerCacheDefinition ${X14_ROOT_DECLS}${attrs}/>`;
}

export function slicersToXml(sheetSlicers: SheetSlicers): string {
  const inner = sheetSlicers.slicers
    .map(
      (v) =>
        `<slicer${a('name', v.name)}${a('xr10:uid', v.uid)}${a('cache', v.cache)}` +
        `${a('caption', v.caption)}${a('startItem', v.startItem)}${a('columnCount', v.columnCount)}` +
        `${a('showCaption', v.showCaption)}${a('level', v.level)}${a('style', v.style)}` +
        `${a('lockedPosition', v.lockedPosition)}${a('rowHeight', v.rowHeight)}/>`,
    )
    .join('');
  return `${XML_DECL}<slicers ${X14_ROOT_DECLS}>${inner}</slicers>`;
}

export function timelineCacheToXml(cache: TimelineCache): string {
  const attrs = `${a('name', cache.name)}${a('xr10:uid', cache.uid)}${a('sourceName', cache.sourceName)}`;
  const s = cache.state;
  const selection = s.selection
    ? `<selection startDate="${escapeXmlAttr(s.selection.startDate)}" endDate="${escapeXmlAttr(s.selection.endDate)}"/>`
    : '';
  const state =
    `<state${a('singleRangeFilterState', s.singleRangeFilterState)}` +
    ` minimalRefreshVersion="${s.minimalRefreshVersion}" lastRefreshVersion="${s.lastRefreshVersion}"` +
    ` pivotCacheId="${s.pivotCacheId}" filterType="${escapeXmlAttr(s.filterType)}">` +
    `${selection}<bounds startDate="${escapeXmlAttr(s.bounds.startDate)}" endDate="${escapeXmlAttr(s.bounds.endDate)}"/></state>`;
  const inner = pivotTablesXml(cache.pivotTables) + state + (cache.pivotFilterPresent ? '<timelinePivotFilter/>' : '');
  return `${XML_DECL}<timelineCacheDefinition ${X15_ROOT_DECLS}${attrs}>${inner}</timelineCacheDefinition>`;
}

export function timelinesToXml(sheetTimelines: SheetTimelines): string {
  const inner = sheetTimelines.timelines
    .map(
      (v) =>
        `<timeline${a('name', v.name)}${a('xr10:uid', v.uid)}${a('cache', v.cache)}` +
        `${a('caption', v.caption)}${a('showHeader', v.showHeader)}` +
        `${a('showSelectionLabel', v.showSelectionLabel)}${a('showTimeLevel', v.showTimeLevel)}` +
        `${a('showHorizontalScrollbar', v.showHorizontalScrollbar)}${a('level', v.level)}` +
        `${a('selectionLevel', v.selectionLevel)}${a('scrollingPosition', v.scrollingPosition)}` +
        `${a('style', v.style)}/>`,
    )
    .join('');
  return `${XML_DECL}<timelines ${X15_ROOT_DECLS}>${inner}</timelines>`;
}

// ---------------------------------------------------------------------------
// Read: whole package.
// ---------------------------------------------------------------------------

function emptyRawParts(): SlicerTimelineRawParts {
  return { parts: {}, slicerCaches: [], sheetSlicers: [], timelineCaches: [], sheetTimelines: [] };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function byPath<T extends { partPath: string }>(a: T, b: T): number {
  return a.partPath.localeCompare(b.partPath, undefined, { numeric: true });
}

/**
 * Read every slicer cache, slicer view, timeline cache, timeline view,
 * pivot linkage record, and drawing reference in an unzipped OOXML
 * package. Never throws.
 */
export function readSlicersTimelines(files: Record<string, Uint8Array>): ReadSlicersTimelinesResult {
  const result: ReadSlicersTimelinesResult = {
    slicerCaches: [],
    sheetSlicers: [],
    timelineCaches: [],
    sheetTimelines: [],
    linkage: { caches: [], tables: [] },
    drawingRefs: [],
    rawParts: emptyRawParts(),
  };
  try {
    const stash = (path: string): void => {
      const bytes = files[path];
      if (bytes) result.rawParts.parts[path] = u8ToBase64(bytes);
    };

    // Workbook <extLst> registry: which list (x14 / x15) names each cache r:id.
    const registryByRid = new Map<string, 'x14' | 'x15'>();
    const wbRaw = files['xl/workbook.xml'];
    if (wbRaw) {
      const wb = denamespaceXml(decoder.decode(wbRaw));
      const extLst = element(wb, 'extLst');
      if (extLst) {
        for (const extBlock of blocks(extLst, 'ext')) {
          const uri = attr(openTag(extBlock, 'ext'), 'uri');
          const kind = uri === WORKBOOK_SLICER_CACHES_X15_EXT_URI ? 'x15' : 'x14';
          if (uri === WORKBOOK_SLICER_CACHES_X14_EXT_URI || uri === WORKBOOK_SLICER_CACHES_X15_EXT_URI) {
            for (const rid of extRefIds(extBlock, 'slicerCache')) registryByRid.set(rid, kind);
          }
        }
      }
    }

    // Slicer caches via workbook relationships.
    const cacheByRid = relTargets(files, 'xl/_rels/workbook.xml.rels', '/slicerCache', 'xl/workbook.xml');
    const cacheEntries = [...cacheByRid.entries()].sort((x, y) => x[1].localeCompare(y[1], undefined, { numeric: true }));
    for (const [rid, path] of cacheEntries) {
      const raw = files[path];
      if (!raw) continue;
      const cache = parseSlicerCacheXml(decoder.decode(raw), path);
      if (!cache) continue;
      const reg = registryByRid.get(rid);
      if (reg) cache.registry = reg;
      result.slicerCaches.push(cache);
      result.rawParts.slicerCaches.push({ name: cache.name, partPath: path, registry: cache.registry });
      stash(path);
    }

    // Timeline caches via workbook relationships.
    const tlByRid = relTargets(files, 'xl/_rels/workbook.xml.rels', '/timelineCache', 'xl/workbook.xml');
    const tlEntries = [...tlByRid.entries()].sort((x, y) => x[1].localeCompare(y[1], undefined, { numeric: true }));
    for (const [, path] of tlEntries) {
      const raw = files[path];
      if (!raw) continue;
      const cache = parseTimelineCacheXml(decoder.decode(raw), path);
      if (!cache) continue;
      result.timelineCaches.push(cache);
      result.rawParts.timelineCaches.push({ name: cache.name, partPath: path });
      stash(path);
    }

    // Per-sheet views via sheet relationships.
    const sheets = sheetPartPaths(files);
    sheets.forEach((sheet, sheetIndex) => {
      const relsPath = sheetRelsPath(sheet.path);
      const slicerByRid = relTargets(files, relsPath, '/slicer', sheet.path);
      for (const path of [...slicerByRid.values()].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))) {
        const raw = files[path];
        if (!raw) continue;
        const slicers = parseSlicersXml(decoder.decode(raw));
        result.sheetSlicers.push({ sheetName: sheet.name, sheetIndex, partPath: path, slicers });
        result.rawParts.sheetSlicers.push({ sheetName: sheet.name, partPath: path });
        stash(path);
      }
      const timelineByRid = relTargets(files, relsPath, '/timeline', sheet.path);
      for (const path of [...timelineByRid.values()].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))) {
        const raw = files[path];
        if (!raw) continue;
        const timelines = parseTimelinesXml(decoder.decode(raw));
        result.sheetTimelines.push({ sheetName: sheet.name, sheetIndex, partPath: path, timelines });
        result.rawParts.sheetTimelines.push({ sheetName: sheet.name, partPath: path });
        stash(path);
      }
    });
    result.sheetSlicers.sort(byPath);
    result.sheetTimelines.sort(byPath);

    // Pivot linkage (§7.4).
    const cacheNameByPart = new Map(result.slicerCaches.map((c) => [c.partPath, c.name]));
    const timelineNameByPart = new Map(result.timelineCaches.map((c) => [c.partPath, c.name]));
    const defById = pivotCacheDefById(files);
    for (const [cacheId, defPath] of [...defById.entries()].sort((x, y) => x[0] - y[0])) {
      const link: PivotCacheLinkage = {
        cacheId,
        defPath,
        slicerCacheNames: [],
        timelineCacheNames: [],
        timelineData: false,
      };
      const defRaw = files[defPath];
      if (defRaw) {
        const den = denamespaceXml(decoder.decode(defRaw));
        const extLst = element(den, 'extLst');
        if (extLst) {
          const tpd = openTag(extLst, 'timelinePivotCacheDefinition');
          if (tpd && attr(tpd, 'timelineData') !== '0') link.timelineData = true;
          const defSlicerRels = relTargets(files, relsPathFor(defPath), '/slicerCache', defPath);
          for (const rid of extRefIds(extLst, 'slicerCache')) {
            const p = defSlicerRels.get(rid);
            const nm = p ? cacheNameByPart.get(p) : undefined;
            if (nm) pushUnique(link.slicerCacheNames, nm);
          }
          const defTimelineRels = relTargets(files, relsPathFor(defPath), '/timelineCache', defPath);
          for (const rid of extRefIds(extLst, 'timelineCache')) {
            const p = defTimelineRels.get(rid);
            const nm = p ? timelineNameByPart.get(p) : undefined;
            if (nm) pushUnique(link.timelineCacheNames, nm);
          }
        }
      }
      // Cache-side declarations (the primary binding in real files).
      for (const c of result.slicerCaches) {
        if (c.data && c.data.kind !== 'table' && c.data.pivotCacheId === cacheId) {
          pushUnique(link.slicerCacheNames, c.name);
        }
      }
      for (const t of result.timelineCaches) {
        if (t.state.pivotCacheId === cacheId) pushUnique(link.timelineCacheNames, t.name);
      }
      result.linkage.caches.push(link);
    }
    // Pivot-table extLst slicer references.
    const tablePaths = Object.keys(files)
      .filter((p) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(p))
      .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
    for (const tablePath of tablePaths) {
      try {
        const den = denamespaceXml(decoder.decode(files[tablePath]!));
        const name = attr(openTag(den, 'pivotTableDefinition'), 'name');
        if (!name) continue;
        const extLst = element(den, 'extLst');
        if (!extLst) continue;
        const names: string[] = [];
        const tableRels = relTargets(files, relsPathFor(tablePath), '/slicerCache', tablePath);
        for (const tag of extLst.match(/<slicerCache\b[^>]*>/g) ?? []) {
          const nm = attr(tag, 'name');
          if (nm) pushUnique(names, nm);
          const rid = attr(tag, 'r:id');
          const p = rid ? tableRels.get(rid) : undefined;
          const resolved = p ? cacheNameByPart.get(p) : undefined;
          if (resolved) pushUnique(names, resolved);
        }
        if (names.length > 0) {
          result.linkage.tables.push({ tablePath, pivotTableName: name, slicerCacheNames: names });
        }
      } catch {
        // best-effort per table
      }
    }

    result.drawingRefs = parseDrawingRefs(files);
  } catch {
    // Best-effort: slicer/timeline import must never break the open.
  }
  return result;
}

/** The metadata model for a read result (everything except the raw part bytes). */
export function slicersTimelinesModelOf(result: ReadSlicersTimelinesResult): SlicersTimelinesModel {
  return {
    slicerCaches: result.slicerCaches,
    sheetSlicers: result.sheetSlicers,
    timelineCaches: result.timelineCaches,
    sheetTimelines: result.sheetTimelines,
    linkage: result.linkage,
    drawingRefs: result.drawingRefs,
  };
}

// ---------------------------------------------------------------------------
// Write: inject model (or raw fallback) into a package.
// ---------------------------------------------------------------------------

function coerceModel(v: unknown): SlicersTimelinesModel | null {
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Partial<SlicersTimelinesModel>;
  const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return {
    slicerCaches: arr<SlicerCache>(o.slicerCaches).filter(
      (c) => c && typeof c.name === 'string' && typeof c.partPath === 'string',
    ),
    sheetSlicers: arr<SheetSlicers>(o.sheetSlicers).filter(
      (s) => s && typeof s.sheetName === 'string' && Array.isArray(s.slicers),
    ),
    timelineCaches: arr<TimelineCache>(o.timelineCaches).filter(
      (c) => c && typeof c.name === 'string' && typeof c.partPath === 'string' && !!c.state,
    ),
    sheetTimelines: arr<SheetTimelines>(o.sheetTimelines).filter(
      (s) => s && typeof s.sheetName === 'string' && Array.isArray(s.timelines),
    ),
    linkage: {
      caches: arr<PivotCacheLinkage>(o.linkage?.caches),
      tables: arr<PivotTableLinkage>(o.linkage?.tables),
    },
    drawingRefs: arr<SlicerDrawingRef>(o.drawingRefs),
  };
}

function coerceRawParts(v: unknown): SlicerTimelineRawParts | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<SlicerTimelineRawParts>;
  if (!o.parts || typeof o.parts !== 'object') return null;
  return {
    parts: o.parts as Record<string, string>,
    slicerCaches: Array.isArray(o.slicerCaches) ? o.slicerCaches : [],
    sheetSlicers: Array.isArray(o.sheetSlicers) ? o.sheetSlicers : [],
    timelineCaches: Array.isArray(o.timelineCaches) ? o.timelineCaches : [],
    sheetTimelines: Array.isArray(o.sheetTimelines) ? o.sheetTimelines : [],
  };
}

const CONTENT_TYPES: Record<string, string> = {
  slicerCache: 'application/vnd.ms-excel.slicerCache+xml',
  slicer: 'application/vnd.ms-excel.slicer+xml',
  timelineCache: 'application/vnd.ms-excel.timelineCache+xml',
  timeline: 'application/vnd.ms-excel.timeline+xml',
};

function contentTypeFor(path: string): string | null {
  if (path.includes('/slicerCaches/')) return CONTENT_TYPES.slicerCache!;
  if (path.includes('/timelineCaches/')) return CONTENT_TYPES.timelineCache!;
  if (path.includes('/slicers/')) return CONTENT_TYPES.slicer!;
  if (path.includes('/timelines/')) return CONTENT_TYPES.timeline!;
  return null;
}

function ensureContentType(files: Record<string, Uint8Array>, path: string): boolean {
  const ct = contentTypeFor(path);
  if (!ct) return false;
  const ctPath = '[Content_Types].xml';
  const raw = files[ctPath];
  if (!raw) return false;
  let xml = decoder.decode(raw);
  if (xml.includes(`PartName="/${path}"`)) return false;
  if (!xml.includes('</Types>')) return false;
  xml = xml.replace('</Types>', `<Override PartName="/${path}" ContentType="${ct}"/></Types>`);
  files[ctPath] = encoder.encode(xml);
  return true;
}

function freshRid(relsXml: string): string {
  const used = new Set<string>();
  for (const m of relsXml.match(/Id="([^"]*)"/g) ?? []) {
    const id = /^Id="([^"]*)"$/.exec(m)?.[1];
    if (id) used.add(id);
  }
  let n = 1;
  while (used.has(`rId${n}`)) n += 1;
  return `rId${n}`;
}

/** Relative target from one part to another (same helper shape as pivotTables.ts). */
function relativeTarget(fromPart: string, toPart: string): string {
  const fromDir = fromPart.split('/').slice(0, -1);
  const toSegs = toPart.split('/');
  let i = 0;
  while (i < fromDir.length && i < toSegs.length - 1 && fromDir[i] === toSegs[i]) i += 1;
  return [...Array<string>(fromDir.length - i).fill('..'), ...toSegs.slice(i)].join('/');
}

interface WorkbookCacheEntry {
  partPath: string;
  relType: string;
  registry?: 'x14' | 'x15';
}

/** Ensure workbook relationships for the cache parts; returns partPath → r:id. */
function ensureWorkbookCacheRels(
  files: Record<string, Uint8Array>,
  entries: WorkbookCacheEntry[],
): Map<string, string> {
  const ridByPath = new Map<string, string>();
  const relsPath = 'xl/_rels/workbook.xml.rels';
  const relsRaw = files[relsPath];
  if (!relsRaw || entries.length === 0) return ridByPath;
  let relsXml = decoder.decode(relsRaw);
  let touched = false;
  for (const entry of entries) {
    const target = entry.partPath.startsWith('xl/') ? entry.partPath.slice(3) : entry.partPath;
    const existing = new RegExp(
      `<Relationship\\s+Id="([^"]*)"[^>]*Target="${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
    ).exec(relsXml);
    if (existing?.[1]) {
      ridByPath.set(entry.partPath, existing[1]);
      continue;
    }
    const rid = freshRid(relsXml);
    const rel = `<Relationship Id="${rid}" Type="${entry.relType}" Target="${target}"/>`;
    relsXml = relsXml.includes('</Relationships>')
      ? relsXml.replace('</Relationships>', `${rel}</Relationships>`)
      : `${relsXml}${rel}`;
    ridByPath.set(entry.partPath, rid);
    touched = true;
  }
  if (touched) files[relsPath] = encoder.encode(relsXml);
  return ridByPath;
}

/** Insert/replace the workbook <extLst> slicer-cache registry lists (x14 + x15). */
function patchWorkbookSlicerRegistry(
  files: Record<string, Uint8Array>,
  ridByPath: Map<string, string>,
  caches: { partPath: string; registry: 'x14' | 'x15' }[],
): boolean {
  if (caches.length === 0) return false;
  const wbPath = 'xl/workbook.xml';
  const wbRaw = files[wbPath];
  if (!wbRaw) return false;
  let wbXml = decoder.decode(wbRaw);
  const groups: Record<'x14' | 'x15', string[]> = { x14: [], x15: [] };
  for (const c of caches) {
    const rid = ridByPath.get(c.partPath);
    if (rid) groups[c.registry].push(rid);
  }
  const extFor = (kind: 'x14' | 'x15'): string => {
    const rids = groups[kind];
    if (rids.length === 0) return '';
    const refs = rids.map((rid) => `<x14:slicerCache r:id="${rid}"/>`).join('');
    return kind === 'x14'
      ? `<ext uri="${WORKBOOK_SLICER_CACHES_X14_EXT_URI}" xmlns:x14="${X14_NAMESPACE}"><x14:slicerCaches>${refs}</x14:slicerCaches></ext>`
      : `<ext uri="${WORKBOOK_SLICER_CACHES_X15_EXT_URI}" xmlns:x15="${X15_NAMESPACE}"><x15:slicerCaches xmlns:x14="${X14_NAMESPACE}">${refs}</x15:slicerCaches></ext>`;
  };
  let changed = false;
  for (const kind of ['x14', 'x15'] as const) {
    const ext = extFor(kind);
    if (!ext) continue;
    const uri = kind === 'x14' ? WORKBOOK_SLICER_CACHES_X14_EXT_URI : WORKBOOK_SLICER_CACHES_X15_EXT_URI;
    const existingRe = new RegExp(
      `<ext uri="${uri.replace(/[{}]/g, '\\$&')}"[^>]*(?:/>|>[\\s\\S]*?</ext>)`,
    );
    if (existingRe.test(wbXml)) {
      wbXml = wbXml.replace(existingRe, ext);
      changed = true;
    } else if (wbXml.includes('</extLst>')) {
      wbXml = wbXml.replace('</extLst>', `${ext}</extLst>`);
      changed = true;
    } else if (wbXml.includes('</workbook>')) {
      wbXml = wbXml.replace('</workbook>', `<extLst>${ext}</extLst></workbook>`);
      changed = true;
    }
  }
  if (changed) files[wbPath] = encoder.encode(wbXml);
  return changed;
}

function ensureSheetRel(
  files: Record<string, Uint8Array>,
  sheetName: string,
  partPath: string,
  relType: string,
): boolean {
  const sheet = sheetPartPaths(files).find((s) => s.name === sheetName);
  if (!sheet) return false;
  const relsPath = sheetRelsPath(sheet.path);
  const relTarget = relativeTarget(sheet.path, partPath);
  const relsRaw = files[relsPath];
  let relsXml = relsRaw
    ? decoder.decode(relsRaw)
    : `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (relsXml.includes(`Target="${relTarget}"`)) return false;
  const rid = freshRid(relsXml);
  const rel = `<Relationship Id="${rid}" Type="${relType}" Target="${relTarget}"/>`;
  relsXml = relsXml.includes('</Relationships>')
    ? relsXml.replace('</Relationships>', `${rel}</Relationships>`)
    : `${relsXml}${rel}`;
  files[relsPath] = encoder.encode(relsXml);
  return true;
}

/**
 * Write slicer/timeline parts into a freshly written package. With a
 * model, parts are regenerated from the model (native write); with only
 * raw parts, the original bytes are re-injected and the same wiring
 * (content types, workbook rels + registry, sheet rels) is applied.
 * Never throws — on any problem the input bytes are returned unchanged.
 */
export function injectSlicerTimelineParts(
  packageBytes: Uint8Array,
  modelUnknown: unknown,
  rawPartsUnknown: unknown,
): Uint8Array {
  try {
    const model = coerceModel(modelUnknown);
    const raw = coerceRawParts(rawPartsUnknown);
    const hasModel =
      model !== null &&
      (model.slicerCaches.length > 0 ||
        model.sheetSlicers.length > 0 ||
        model.timelineCaches.length > 0 ||
        model.sheetTimelines.length > 0);
    if (!hasModel && (!raw || Object.keys(raw.parts).length === 0)) return packageBytes;

    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;
    let touched = false;
    const assigned = new Set<string>();
    const assignPath = (recorded: string | undefined, folder: string, prefix: string): string => {
      if (recorded && !assigned.has(recorded)) {
        assigned.add(recorded);
        return recorded;
      }
      let n = 1;
      while (files[`${folder}/${prefix}${n}.xml`] || assigned.has(`${folder}/${prefix}${n}.xml`)) n += 1;
      const p = `${folder}/${prefix}${n}.xml`;
      assigned.add(p);
      return p;
    };
    const wbEntries: WorkbookCacheEntry[] = [];
    const slicerRegistry: { partPath: string; registry: 'x14' | 'x15' }[] = [];

    if (hasModel && model) {
      const recordedCachePath = new Map((raw?.slicerCaches ?? []).map((c) => [c.name, c.partPath]));
      for (const cache of model.slicerCaches) {
        const path = assignPath(recordedCachePath.get(cache.name) ?? cache.partPath, 'xl/slicerCaches', 'slicerCache');
        files[path] = encoder.encode(slicerCacheToXml({ ...cache, partPath: path }));
        ensureContentType(files, path);
        wbEntries.push({ partPath: path, relType: SLICER_CACHE_REL_TYPE, registry: cache.registry });
        slicerRegistry.push({ partPath: path, registry: cache.registry });
        touched = true;
      }
      const recordedTlPath = new Map((raw?.timelineCaches ?? []).map((c) => [c.name, c.partPath]));
      for (const cache of model.timelineCaches) {
        const path = assignPath(recordedTlPath.get(cache.name) ?? cache.partPath, 'xl/timelineCaches', 'timelineCache');
        files[path] = encoder.encode(timelineCacheToXml({ ...cache, partPath: path }));
        ensureContentType(files, path);
        wbEntries.push({ partPath: path, relType: TIMELINE_CACHE_REL_TYPE });
        touched = true;
      }
      const recordedSlicerPath = new Map((raw?.sheetSlicers ?? []).map((s) => [s.sheetName, s.partPath]));
      for (const ss of model.sheetSlicers) {
        const path = assignPath(recordedSlicerPath.get(ss.sheetName) ?? ss.partPath, 'xl/slicers', 'slicer');
        files[path] = encoder.encode(slicersToXml({ ...ss, partPath: path }));
        ensureContentType(files, path);
        ensureSheetRel(files, ss.sheetName, path, SLICER_REL_TYPE);
        touched = true;
      }
      const recordedTimelinePath = new Map((raw?.sheetTimelines ?? []).map((s) => [s.sheetName, s.partPath]));
      for (const st of model.sheetTimelines) {
        const path = assignPath(recordedTimelinePath.get(st.sheetName) ?? st.partPath, 'xl/timelines', 'timeline');
        files[path] = encoder.encode(timelinesToXml({ ...st, partPath: path }));
        ensureContentType(files, path);
        ensureSheetRel(files, st.sheetName, path, TIMELINE_REL_TYPE);
        touched = true;
      }
    } else if (raw) {
      for (const [path, b64] of Object.entries(raw.parts)) {
        if (typeof b64 !== 'string' || b64.length === 0) continue;
        try {
          files[path] = base64ToU8(b64);
        } catch {
          continue;
        }
        ensureContentType(files, path);
        touched = true;
      }
      for (const c of raw.slicerCaches) {
        wbEntries.push({ partPath: c.partPath, relType: SLICER_CACHE_REL_TYPE, registry: c.registry });
        slicerRegistry.push({ partPath: c.partPath, registry: c.registry });
      }
      for (const c of raw.timelineCaches) {
        wbEntries.push({ partPath: c.partPath, relType: TIMELINE_CACHE_REL_TYPE });
      }
      for (const s of raw.sheetSlicers) ensureSheetRel(files, s.sheetName, s.partPath, SLICER_REL_TYPE);
      for (const s of raw.sheetTimelines) ensureSheetRel(files, s.sheetName, s.partPath, TIMELINE_REL_TYPE);
    }

    if (!touched) return packageBytes;
    const ridByPath = ensureWorkbookCacheRels(files, wbEntries);
    patchWorkbookSlicerRegistry(files, ridByPath, slicerRegistry);
    return zipSyncStable(files);
  } catch {
    return packageBytes;
  }
}
