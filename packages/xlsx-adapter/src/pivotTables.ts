/**
 * Native XLSX pivot table import.
 *
 * SheetJS community edition drops pivot tables entirely (pivotCache and
 * pivotTable parts), so this module reads them directly from the OOXML
 * package with fflate (the same unzip-only pattern as charts.ts — no new
 * dependencies):
 *
 * - read:  for every worksheet part, follow
 *          `xl/worksheets/_rels/sheetN.xml.rels` → pivotTable part →
 *          `xl/pivotTables/_rels/pivotTableN.xml.rels` → pivotCacheDefinition
 *          part (+ its `.rels` → pivotCacheRecords part). The cacheId →
 *          definition link in `xl/workbook.xml` (`<pivotCaches>`) is the
 *          fallback when the table's own `.rels` is missing.
 * - cache: `pivotCacheDefinition*.xml` gives the field names, the shared
 *          item lists, and the cache source; `pivotCacheRecords*.xml` gives
 *          the records (`<x v="N"/>` cells index into the field's shared
 *          items, `<s>/<n>/<b>/<e>/<d>` carry inline values, `<m/>` is
 *          blank).
 * - table: `pivotTable*.xml` gives the location, row/column fields (field
 *          indexes into the cache; `x="-2"` is the Values/Data position),
 *          page (report-filter) fields, data fields with their aggregation
 *          (`subtotal`), hidden-item filters, and the style name.
 *
 * Design-doc note: pivot tables are the native report visual
 * (design-docs/native-reports-and-dashboards.md covers the report builder as
 * a service-layer component). This module is the ADAPTER-layer half: it
 * extracts the OOXML into plain JSON (`ImportedPivotTable`) and stashes it
 * in workbook metadata. The layout computation itself reuses the service
 * pivot component (`createPivot` in packages/service/src/pivot.ts) — the
 * web app maps `ImportedPivotTable` → `PivotSpec` and computes the
 * `PivotResult` there. Nothing here touches the engine.
 *
 * Round-trip: the raw part bytes are captured alongside the parsed model
 * (`PivotRawParts`) and re-injected verbatim on write by
 * `injectPivotParts()` — the same opaque-preservation pattern as the VBA
 * macro project (macroProject.ts). SheetJS rebuilds the package from its
 * own model, so without this every pivot would be dropped on save.
 *
 * Never throws: any missing/corrupt part yields fewer (or warning-marked)
 * pivots, never an error. A pivot whose cache definition is missing is
 * still reported — with `warning` set — so the UI can say so instead of
 * silently dropping it (user-locked requirement 2026-10-18).
 */

import { unzipSync } from 'fflate';
import { base64ToU8, u8ToBase64 } from './macroProject.js';
import { zipSyncStable } from './zipStable.js';

/** Aggregation functions the service pivot component supports (v1 set). */
export type ImportedPivotAggregation =
  | 'sum'
  | 'count'
  | 'average'
  | 'max'
  | 'min'
  | 'product'
  | 'countnums'
  | 'stdev'
  | 'var';

export interface ImportedPivotValueField {
  /** Source cache field name. */
  field: string;
  aggregation: ImportedPivotAggregation;
  /** Display label (the dataField name, or "Sum of <field>" style default). */
  label: string;
}

export interface ImportedPivotFilter {
  /** Source cache field name. */
  field: string;
  /** Include-only list, matched against display labels. Empty = exclude all. */
  selected: string[];
}

/** Where the pivot cache reads its source data from. */
export type ImportedPivotSource =
  | { kind: 'worksheet'; sheet: string; ref: string; name?: string }
  | { kind: 'external'; detail: string }
  | { kind: 'scenario' }
  | { kind: 'consolidation' }
  | { kind: 'unknown'; detail: string };

export interface ImportedPivotAnchor {
  /** 0-based top-left cell of the pivot's location ref. */
  row: number;
  col: number;
  /** Original location ref, e.g. "A3:C20". */
  ref: string;
}

export interface ImportedPivotTable {
  /** pivotTableDefinition name, e.g. "PivotTable1". */
  name: string;
  /** Name of the sheet hosting the pivot. */
  sheetName: string;
  /** 0-based index into the workbook's sheet order. */
  sheetIndex: number;
  /**
   * Workbook sheetId of the hosting sheet (xl/workbook.xml <sheet
   * sheetId>), when the file carries one. Slicer caches reference their
   * pivot tables by (tabId, name) where tabId IS the sheetId — so
   * sheet-qualified slicer -> pivot binding (#114) matches on this, not
   * on the bare name (workbooks may duplicate pivot names across
   * sheets, e.g. bxl3way's two pvtCF pivots).
   */
  sheetId?: number;
  /** Cache id from the pivotTableDefinition (links to <pivotCaches>). */
  cacheId: number;
  /** Cache field names, in cache order. */
  fieldNames: string[];
  /**
   * Cache records as rows aligned with fieldNames. JSON-safe values only:
   * string | number | boolean | null. Resolved from pivotCacheRecords
   * (`<x v="N"/>` via the field's shared items).
   */
  records: unknown[][];
  /** False when the file carries no records for this cache (saveData="0"). */
  hasRecords: boolean;
  source: ImportedPivotSource;
  /** Cache field names on the row axis, in order. */
  rows: string[];
  /** Cache field names on the column axis, in order. */
  columns: string[];
  /** True when the Values area sits on rows (x="-2" in rowFields). */
  dataOnRows: boolean;
  values: ImportedPivotValueField[];
  filters: ImportedPivotFilter[];
  anchor: ImportedPivotAnchor;
  styleName: string;
  /** The dataCaption attribute ("Values" by default). */
  dataCaption: string;
  rowGrandTotals: boolean;
  colGrandTotals: boolean;
  /** Set when the pivot could only be partially imported (never throws). */
  warning?: string;
}

/**
 * Raw pivot parts for the byte-faithful write path. Kept separate from
 * ImportedPivotTable so the parsed model stays small, JSON-clean, and free
 * of base64 bulk.
 */
export interface PivotRawParts {
  /** Part path → base64 bytes, for every pivot part read. */
  parts: Record<string, string>;
  caches: { cacheId: number; defPath: string }[];
  tables: { tablePath: string; sheetName: string; cacheId: number }[];
}

export interface ReadPivotTablesResult {
  tables: ImportedPivotTable[];
  rawParts: PivotRawParts;
}

/** Workbook-metadata key (contract shared with the web app). */
export const PIVOT_TABLES_METADATA_KEY = 'icecream.pivots';
/**
 * Raw-parts metadata key. Deliberately NOT `icecream.`-prefixed so the
 * adapter's custom-property persistence (which mirrors every `icecream.*`
 * key into the file) does not duplicate the base64 bulk — the parts are
 * injected as real XML on write instead.
 */
export const PIVOT_PARTS_METADATA_KEY = 'xlsx.pivotParts';

/** Display label for a blank shared item — must match the service pivot's labelOf. */
const BLANK_LABEL = '(blank)';

// ---------------------------------------------------------------------------
// Small XML helpers (same regex-based approach as charts.ts).
// ---------------------------------------------------------------------------

/** Minimal XML entity unescape for text/attribute values. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

function intAttr(tag: string, name: string): number | null {
  const v = attr(tag, name);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Strip namespace prefixes from element names (`<x:sheet>` → `<sheet>`,
 * `</x:pivotCache>` → `</pivotCache>`). ClosedXML and several other
 * producers emit every element with an `x:` (or similar) prefix while the
 * regex-based parsers below match unprefixed names, so normalize before
 * matching. Attribute names (including `r:id`) are deliberately left alone:
 * a `<` can only open a tag in well-formed XML, so the replacement cannot
 * touch attribute values.
 */
function denamespaceXml(xml: string): string {
  return xml.replace(/<(\/?)([A-Za-z_][\w.-]*):/g, '<$1');
}

/** Open tag of the first `<name ...>` element (self-closing or not). */
function openTag(xml: string, name: string): string {
  const m = new RegExp(`<${name}(\\s[^>]*)?/?>`).exec(xml);
  return m ? m[0] : '';
}

/**
 * Every `<name ...>...</name>` or `<name .../>` block, in document order.
 * Unlike charts.ts's element(), this also matches self-closing elements
 * (pivotField/item/field/pageField are usually self-closing).
 */
function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  // Lazy attribute match: a greedy [^>]* would swallow the '/' of a
  // self-closing tag and the pair alternative would then eat through to a
  // later close tag.
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

/**
 * Resolve a relationship Target (possibly `../`-relative) against the part
 * that owns the .rels file.
 */
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
  const rels = denamespaceXml(new TextDecoder().decode(raw));
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

/**
 * Sheet name → worksheet part path, via xl/workbook.xml (sheet name → r:id)
 * and xl/_rels/workbook.xml.rels (r:id → part target). Exact: no
 * sheetN-number guessing.
 */
function sheetPartPaths(files: Record<string, Uint8Array>): Array<{ name: string; path: string; sheetId?: number }> {
  const out: Array<{ name: string; path: string; sheetId?: number }> = [];
  const wbXml = files['xl/workbook.xml'];
  if (!wbXml) return out;
  const wb = denamespaceXml(new TextDecoder().decode(wbXml));
  const targetByRid = relTargets(files, 'xl/_rels/workbook.xml.rels', '/worksheet', 'xl/workbook.xml');
  for (const tag of wb.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attr(tag, 'name');
    const rid = attr(tag, 'r:id');
    if (name && rid) {
      const path = targetByRid.get(rid);
      if (path) {
        const sid = attr(tag, 'sheetId');
        const sheetId = sid !== null && sid !== '' && Number.isFinite(Number(sid)) ? Number(sid) : undefined;
        out.push({ name, path, ...(sheetId !== undefined ? { sheetId } : {}) });
      }
    }
  }
  return out;
}

/** Decode an A1 ref's top-left cell ("G3:AB8" → {row: 2, col: 6}); null when unparseable. */
function topLeftOfRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)/.exec(ref.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2]!, 10) - 1, col: col - 1 };
}

// ---------------------------------------------------------------------------
// Pivot cache parsing.
// ---------------------------------------------------------------------------

interface CacheField {
  name: string;
  /** Shared items in order; string | number | boolean | null (blank). */
  items: unknown[];
  containsNumber: boolean;
}

/** Resolve one shared-item/record cell to a JSON-safe value. */
function cellValue(t: string, v: string | null): unknown {
  switch (t) {
    case 's':
      return v === null ? '' : unescapeXml(v);
    case 'n': {
      if (v === null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case 'b':
      return v === '1';
    case 'e':
      return v === null ? '#N/A' : unescapeXml(v);
    case 'd':
      return v === null ? null : unescapeXml(v);
    case 'm':
      return null;
    default:
      return null;
  }
}

/** Display label for a shared-item value — mirrors the service pivot's labelOf. */
function sharedItemLabel(v: unknown): string {
  if (v === null || v === undefined || v === '') return BLANK_LABEL;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function parseSharedItems(block: string): { items: unknown[]; containsNumber: boolean } {
  const inner = element(block, 'sharedItems') || block;
  const tag = openTag(block, 'sharedItems');
  const items: unknown[] = [];
  const re = /<(s|n|d|b|e|m)\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const t = m[1]!;
    if (t === 'm') {
      items.push(null);
      continue;
    }
    items.push(cellValue(t, attr(m[0], 'v')));
  }
  const containsNumber =
    attr(tag, 'containsNumber') === '1' || items.some((v) => typeof v === 'number');
  return { items, containsNumber };
}

function parseCacheSource(defXml: string): ImportedPivotSource {
  const srcTag = openTag(defXml, 'cacheSource');
  const type = attr(srcTag, 'type') ?? 'unknown';
  if (type === 'worksheet') {
    const wsTag = openTag(defXml, 'worksheetSource');
    const name = attr(wsTag, 'name');
    if (name !== null) {
      // A table name (Excel ListObject) or a defined name — the web app
      // refreshes these from the cached records (no live range available).
      return { kind: 'worksheet', sheet: '', ref: '', name };
    }
    return {
      kind: 'worksheet',
      sheet: attr(wsTag, 'sheet') ?? '',
      ref: attr(wsTag, 'ref') ?? '',
    };
  }
  if (type === 'external') {
    return { kind: 'external', detail: `connectionId=${attr(srcTag, 'connectionId') ?? '?'}` };
  }
  if (type === 'scenario') return { kind: 'scenario' };
  if (type === 'consolidation') return { kind: 'consolidation' };
  return { kind: 'unknown', detail: `cacheSource type="${type}"` };
}

interface ParsedCache {
  fields: CacheField[];
  source: ImportedPivotSource;
}

function parseCacheDefinition(xml: string): ParsedCache {
  xml = denamespaceXml(xml);
  const fields: CacheField[] = [];
  const cacheFieldsEl = element(xml, 'cacheFields');
  const scope = cacheFieldsEl || xml;
  let i = 0;
  for (const cf of blocks(scope, 'cacheField')) {
    i += 1;
    const { items, containsNumber } = parseSharedItems(cf);
    fields.push({ name: attr(openTag(cf, 'cacheField'), 'name') ?? `Field${i}`, items, containsNumber });
  }
  return { fields, source: parseCacheSource(xml) };
}

interface RecordCell {
  t: string;
  v: string | null;
}

/** Cells of one `<r>` block, in order. */
function recordCells(rBlock: string): RecordCell[] {
  const out: RecordCell[] = [];
  const re = /<(s|n|d|b|e|x|m)\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rBlock)) !== null) {
    const t = m[1]!;
    out.push({ t, v: t === 'm' ? null : attr(m[0], 'v') });
  }
  return out;
}

function parseCacheRecords(xml: string, fields: CacheField[]): unknown[][] {
  xml = denamespaceXml(xml);
  const rows: unknown[][] = [];
  for (const r of blocks(xml, 'r')) {
    const cells = recordCells(r);
    const row: unknown[] = [];
    for (let i = 0; i < fields.length; i++) {
      const cell = cells[i];
      if (!cell) {
        row.push(null);
        continue;
      }
      if (cell.t === 'x') {
        const idx = cell.v === null ? -1 : parseInt(cell.v, 10);
        row.push(idx >= 0 && idx < fields[i]!.items.length ? fields[i]!.items[idx]! : null);
      } else {
        row.push(cellValue(cell.t, cell.v));
      }
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Pivot table parsing.
// ---------------------------------------------------------------------------

interface PivotFieldItem {
  x: number | null;
  hidden: boolean;
  isDefault: boolean;
}

interface ParsedPivotField {
  axis: 'axisRow' | 'axisCol' | 'axisPage' | null;
  dataField: boolean;
  items: PivotFieldItem[];
}

/** OOXML ST_DataConsolidateFunction → service aggregation. */
function mapSubtotal(subtotal: string | null, fieldHasNumbers: boolean): ImportedPivotAggregation {
  switch ((subtotal ?? '').toLowerCase()) {
    case 'sum':
      return 'sum';
    case 'count':
      return 'count';
    case 'average':
      return 'average';
    case 'max':
      return 'max';
    case 'min':
      return 'min';
    case 'product':
      return 'product';
    case 'countnums':
      return 'countnums';
    case 'stddev':
    case 'stddevp':
      return 'stdev';
    case 'var':
    case 'varp':
      return 'var';
    default:
      // Excel's default: Sum for numeric fields, Count otherwise.
      return fieldHasNumbers ? 'sum' : 'count';
  }
}

function defaultValueLabel(aggregation: ImportedPivotAggregation, field: string): string {
  const name =
    (
      {
        sum: 'Sum',
        count: 'Count',
        average: 'Average',
        max: 'Max',
        min: 'Min',
        product: 'Product',
        countnums: 'Count Nums',
        stdev: 'StdDev',
        var: 'Var',
      } as Record<ImportedPivotAggregation, string>
    )[aggregation] ?? aggregation;
  return `${name} of ${field}`;
}

function parsePivotFields(tableXml: string): ParsedPivotField[] {
  const out: ParsedPivotField[] = [];
  const scope = element(tableXml, 'pivotFields');
  if (!scope) return out;
  for (const pf of blocks(scope, 'pivotField')) {
    const tag = openTag(pf, 'pivotField');
    const axisAttr = attr(tag, 'axis');
    const items: PivotFieldItem[] = [];
    const itemsScope = element(pf, 'items');
    if (itemsScope) {
      for (const it of blocks(itemsScope, 'item')) {
        const itag = openTag(it, 'item');
        items.push({
          x: intAttr(itag, 'x'),
          hidden: attr(itag, 'h') === '1',
          isDefault: attr(itag, 't') === 'default',
        });
      }
    }
    out.push({
      axis:
        axisAttr === 'axisRow' || axisAttr === 'axisCol' || axisAttr === 'axisPage'
          ? axisAttr
          : null,
      dataField: attr(tag, 'dataField') === '1',
      items,
    });
  }
  return out;
}

/** `<field x="N"/>` indexes in document order (rowFields / colFields). */
function fieldIndexes(scope: string, name: string): number[] {
  const el = element(scope, name);
  if (!el) return [];
  const out: number[] = [];
  for (const tag of el.match(/<field\b[^>]*>/g) ?? []) {
    const x = intAttr(tag, 'x');
    if (x !== null) out.push(x);
  }
  return out;
}

interface ParsedPageField {
  fld: number;
  item: number | null;
}

function parsePageFields(tableXml: string): ParsedPageField[] {
  const el = element(tableXml, 'pageFields');
  if (!el) return [];
  const out: ParsedPageField[] = [];
  for (const tag of el.match(/<pageField\b[^>]*>/g) ?? []) {
    const fld = intAttr(tag, 'fld');
    if (fld === null) continue;
    out.push({ fld, item: intAttr(tag, 'item') });
  }
  return out;
}

interface ParsedDataField {
  name: string | null;
  fld: number;
  subtotal: string | null;
}

function parseDataFields(tableXml: string): ParsedDataField[] {
  const el = element(tableXml, 'dataFields');
  if (!el) return [];
  const out: ParsedDataField[] = [];
  for (const tag of el.match(/<dataField\b[^>]*>/g) ?? []) {
    const fld = intAttr(tag, 'fld');
    if (fld === null) continue;
    out.push({ fld, name: attr(tag, 'name'), subtotal: attr(tag, 'subtotal') });
  }
  return out;
}

/**
 * Labels of the visible (non-hidden) items of a pivot field, resolved
 * through the cache field's shared items. Returns null when the field has
 * no hidden items (i.e. no filtering to apply).
 */
function visibleItemLabels(pf: ParsedPivotField, cacheField: CacheField | undefined): string[] | null {
  if (!cacheField || pf.items.length === 0) return null;
  if (!pf.items.some((it) => it.hidden)) return null;
  const labels: string[] = [];
  for (const it of pf.items) {
    if (it.hidden || it.isDefault || it.x === null) continue;
    const v = cacheField.items[it.x];
    labels.push(sharedItemLabel(v));
  }
  return labels;
}

/** Label of one pivotField item (for pageField item="N" selection). */
function pivotItemLabel(
  pf: ParsedPivotField,
  itemIdx: number,
  cacheField: CacheField | undefined,
): string | null {
  if (!cacheField) return null;
  const it = pf.items[itemIdx];
  if (!it || it.isDefault || it.x === null) return null;
  return sharedItemLabel(cacheField.items[it.x]);
}

// ---------------------------------------------------------------------------
// Public API: read.
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function stashPart(
  files: Record<string, Uint8Array>,
  rawParts: PivotRawParts,
  path: string | undefined,
): void {
  if (!path) return;
  const bytes = files[path];
  if (!bytes) return;
  rawParts.parts[path] = u8ToBase64(bytes);
}

/**
 * Read every pivot table in an unzipped OOXML package (path → bytes, as
 * produced by fflate's unzipSync). Never throws: any missing/corrupt part
 * yields fewer pivots — or a warning-marked entry — never an error.
 */
export function readPivotTables(files: Record<string, Uint8Array>): ReadPivotTablesResult {
  const tables: ImportedPivotTable[] = [];
  const rawParts: PivotRawParts = { parts: {}, caches: [], tables: [] };
  try {
    const sheets = sheetPartPaths(files);
    if (sheets.length === 0) return { tables, rawParts };

    // cacheId → definition part, via xl/workbook.xml <pivotCaches> + rels.
    const wbXml = files['xl/workbook.xml'] ? denamespaceXml(decoder.decode(files['xl/workbook.xml']!)) : '';
    const cacheDefByRid = relTargets(
      files,
      'xl/_rels/workbook.xml.rels',
      '/pivotCacheDefinition',
      'xl/workbook.xml',
    );
    const cacheIdToDef = new Map<number, string>();
    for (const tag of wbXml.match(/<pivotCache\b[^>]*>/g) ?? []) {
      const cacheId = intAttr(tag, 'cacheId');
      const rid = attr(tag, 'r:id');
      const defPath = rid ? cacheDefByRid.get(rid) : undefined;
      if (cacheId !== null && defPath) {
        cacheIdToDef.set(cacheId, defPath);
        rawParts.caches.push({ cacheId, defPath });
      }
    }

    sheets.forEach(({ name: sheetName, path: sheetPath, sheetId }, sheetIndex) => {
      // sheetN.xml → xl/worksheets/_rels/sheetN.xml.rels → pivotTable parts.
      const dir = sheetPath.includes('/') ? sheetPath.slice(0, sheetPath.lastIndexOf('/')) : '';
      const base = sheetPath.slice(sheetPath.lastIndexOf('/') + 1);
      const sheetRelsPath = `${dir}/_rels/${base}.rels`;
      const tableByRid = relTargets(files, sheetRelsPath, '/pivotTable', sheetPath);
      for (const tablePath of tableByRid.values()) {
        const tableRaw = files[tablePath];
        if (!tableRaw) continue;
        stashPart(files, rawParts, tablePath);
        try {
          const table = parseOnePivotTable(
            files,
            rawParts,
            decoder.decode(tableRaw),
            tablePath,
            sheetName,
            sheetIndex,
            cacheIdToDef,
            sheetId,
          );
          tables.push(table);
        } catch (e) {
          // One corrupt pivot table must not kill the rest of the import.
          tables.push({
            name: tablePath.split('/').pop() ?? tablePath,
            sheetName,
            sheetIndex,
            ...(sheetId !== undefined ? { sheetId } : {}),
            cacheId: -1,
            fieldNames: [],
            records: [],
            hasRecords: false,
            source: { kind: 'unknown', detail: 'unparseable pivotTable part' },
            rows: [],
            columns: [],
            dataOnRows: false,
            values: [],
            filters: [],
            anchor: { row: 0, col: 0, ref: '' },
            styleName: '',
            dataCaption: 'Values',
            rowGrandTotals: true,
            colGrandTotals: true,
            warning: `Could not parse ${tablePath}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    });
  } catch {
    // Best-effort: pivot import must never break the open.
  }
  return { tables, rawParts };
}

function parseOnePivotTable(
  files: Record<string, Uint8Array>,
  rawParts: PivotRawParts,
  tableXml: string,
  tablePath: string,
  sheetName: string,
  sheetIndex: number,
  cacheIdToDef: Map<number, string>,
  sheetId?: number,
): ImportedPivotTable {
  tableXml = denamespaceXml(tableXml);
  const defTag = openTag(tableXml, 'pivotTableDefinition');
  const name = attr(defTag, 'name') ?? tablePath.split('/').pop() ?? 'PivotTable';
  const cacheId = intAttr(defTag, 'cacheId') ?? -1;

  const locTag = openTag(tableXml, 'location');
  const ref = attr(locTag, 'ref') ?? '';
  const topLeft = topLeftOfRef(ref) ?? { row: 0, col: 0 };

  const styleTag = openTag(tableXml, 'pivotTableStyleInfo');

  // Cache definition: the table's own .rels first, <pivotCaches> fallback.
  const tableRelsPath = tablePath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
  stashPart(files, rawParts, tableRelsPath);
  const defByRid = relTargets(files, tableRelsPath, '/pivotCacheDefinition', tablePath);
  let defPath: string | undefined = [...defByRid.values()][0] ?? cacheIdToDef.get(cacheId);
  const defRaw = defPath ? files[defPath] : undefined;
  if (defPath && !defRaw) {
    // The .rels points at a definition that is not in the package — fall
    // back to the <pivotCaches> mapping before giving up.
    defPath = cacheIdToDef.get(cacheId);
  }
  const defBytes = defPath ? files[defPath] : undefined;
  stashPart(files, rawParts, defPath);

  const base: ImportedPivotTable = {
    name,
    sheetName,
    sheetIndex,
    ...(sheetId !== undefined ? { sheetId } : {}),
    cacheId,
    fieldNames: [],
    records: [],
    hasRecords: false,
    source: { kind: 'unknown', detail: 'no cache definition' },
    rows: [],
    columns: [],
    dataOnRows: false,
    values: [],
    filters: [],
    anchor: { row: topLeft.row, col: topLeft.col, ref },
    styleName: attr(styleTag, 'name') ?? '',
    dataCaption: attr(defTag, 'dataCaption') ?? 'Values',
    rowGrandTotals: attr(defTag, 'rowGrandTotals') !== '0',
    colGrandTotals: attr(defTag, 'colGrandTotals') !== '0',
  };

  if (!defBytes || !defPath) {
    // The MissingReference-style error path: the pivot table points at a
    // cache that is not in the package. Report it, don't crash.
    base.warning =
      `Pivot cache${cacheId >= 0 ? ` ${cacheId}` : ''} for "${name}" is missing from the file — ` +
      `the pivot cannot be computed.`;
    rawParts.tables.push({ tablePath, sheetName, cacheId });
    return base;
  }

  const cache = parseCacheDefinition(decoder.decode(defBytes));
  base.fieldNames = cache.fields.map((f) => f.name);
  base.source = cache.source;

  // OLAP caches (cacheSource type=external) carry no records
  // (saveData=0) by design: records never live in the file — the data
  // lives in the embedded data model. Computed here (not only at the
  // aggregation step below) so the missing-records branch exempts them
  // from the error-style warning: a structural property of OLAP files
  // must not surface as "saved without records". (#132)
  const isOlapCache =
    /<cacheSource\b[^>]*type="external"/.test(denamespaceXml(decoder.decode(defBytes)));

  // Records: the definition's .rels → pivotCacheRecords, with a
  // sibling-name fallback (some producers omit the .rels).
  const defRelsPath = defPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
  stashPart(files, rawParts, defRelsPath);
  const recByRid = relTargets(files, defRelsPath, '/pivotCacheRecords', defPath);
  let recPath = [...recByRid.values()][0];
  if (!recPath || !files[recPath]) {
    const sibling = defPath.replace(/pivotCacheDefinition(\d*)\.xml$/, 'pivotCacheRecords$1.xml');
    if (sibling !== defPath && files[sibling]) recPath = sibling;
  }
  const recBytes = recPath ? files[recPath] : undefined;
  stashPart(files, rawParts, recPath);
  if (recBytes) {
    base.records = parseCacheRecords(decoder.decode(recBytes), cache.fields);
    base.hasRecords = true;
  } else if (isOlapCache) {
    // No warning: an external cache has no records to miss. The UI
    // treats model-served OLAP pivots as served (no error shell) and
    // only warns when no data-model connection backs the cache. (#132)
  } else if (attr(openTag(denamespaceXml(decoder.decode(defBytes)), 'pivotCacheDefinition'), 'saveData') === '0') {
    base.warning =
      `The pivot cache for "${name}" was saved without records (saveData="0") — ` +
      `refresh the pivot from its source to populate it.`;
  } else {
    base.warning = `No pivot cache records found for "${name}".`;
  }

  const fieldName = (i: number): string => cache.fields[i]?.name ?? `Field${i + 1}`;
  const pivotFields = parsePivotFields(tableXml);
  const rowXs = fieldIndexes(tableXml, 'rowFields');
  const colXs = fieldIndexes(tableXml, 'colFields');
  base.rows = rowXs.filter((x) => x >= 0).map(fieldName);
  base.columns = colXs.filter((x) => x >= 0).map(fieldName);
  base.dataOnRows = rowXs.includes(-2);

  // OLAP caches (cacheSource type=external) carry no records
  // (saveData=0), so containsNumber is unknown and the record scan is
  // empty — but OLAP data fields ARE model measures (numeric by
  // definition), so the Excel default for them is Sum, not Count.
  // Without this, every OLAP pivot value maps to 'count' and the
  // #114 model builder (correctly) refuses to resolve it.
  // (isOlapCache is computed above, before the records branch.)
  for (const df of parseDataFields(tableXml)) {
    const field = fieldName(df.fld);
    const hasNumbers =
      isOlapCache ||
      (cache.fields[df.fld]?.containsNumber ??
        base.records.some((r) => typeof r[df.fld] === 'number'));
    const aggregation = mapSubtotal(df.subtotal, hasNumbers);
    base.values.push({
      field,
      aggregation,
      label: df.name ?? defaultValueLabel(aggregation, field),
    });
  }

  // Filters: page (report-filter) fields first, then hidden items on row /
  // column fields (Excel hides filtered-out members with h="1").
  const pageFields = parsePageFields(tableXml);
  const filtered = new Set<string>();
  for (const pf of pageFields) {
    const pfDef = pivotFields[pf.fld];
    const field = fieldName(pf.fld);
    if (!pfDef) continue;
    if (pf.item !== null) {
      const label = pivotItemLabel(pfDef, pf.item, cache.fields[pf.fld]);
      if (label !== null) {
        base.filters.push({ field, selected: [label] });
        filtered.add(field);
      }
      continue;
    }
    const sel = visibleItemLabels(pfDef, cache.fields[pf.fld]);
    if (sel !== null) {
      base.filters.push({ field, selected: sel });
      filtered.add(field);
    }
  }
  pivotFields.forEach((pf, i) => {
    if (pf.axis !== 'axisRow' && pf.axis !== 'axisCol') return;
    const field = fieldName(i);
    if (filtered.has(field)) return;
    const sel = visibleItemLabels(pf, cache.fields[i]);
    if (sel !== null) base.filters.push({ field, selected: sel });
  });

  rawParts.tables.push({ tablePath, sheetName, cacheId });
  return base;
}

// ---------------------------------------------------------------------------
// Public API: write (byte-faithful round-trip).
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  pivotTable:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml',
  pivotCacheDefinition:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml',
  pivotCacheRecords:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml',
};

function partKind(path: string): keyof typeof CONTENT_TYPES | null {
  if (path.includes('/pivotTables/')) return 'pivotTable';
  if (path.includes('/pivotCache/pivotCacheDefinition')) return 'pivotCacheDefinition';
  if (path.includes('/pivotCache/pivotCacheRecords')) return 'pivotCacheRecords';
  return null;
}

function ensureContentType(files: Record<string, Uint8Array>, path: string): boolean {
  const kind = partKind(path);
  if (!kind) return false;
  const ctPath = '[Content_Types].xml';
  const raw = files[ctPath];
  if (!raw) return false;
  let xml = decoder.decode(raw);
  const needle = `PartName="/${path}"`;
  if (xml.includes(needle)) return false;
  const override = `<Override PartName="/${path}" ContentType="${CONTENT_TYPES[kind]}"/>`;
  if (!xml.includes('</Types>')) return false;
  xml = xml.replace('</Types>', `${override}</Types>`);
  files[ctPath] = encoder.encode(xml);
  return true;
}

/** Fresh relationship id not already used in the rels XML. */
function freshRid(relsXml: string, prefix: string): string {
  const used = new Set<string>();
  for (const m of relsXml.match(/Id="([^"]*)"/g) ?? []) {
    const id = /^Id="([^"]*)"$/.exec(m)?.[1];
    if (id) used.add(id);
  }
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

function ensureWorkbookPivotCaches(
  files: Record<string, Uint8Array>,
  caches: { cacheId: number; defPath: string }[],
): boolean {
  const wbPath = 'xl/workbook.xml';
  const wbRaw = files[wbPath];
  if (!wbRaw || caches.length === 0) return false;
  let wbXml = decoder.decode(wbRaw);

  // Workbook-level relationships for the cache definitions.
  const relsPath = 'xl/_rels/workbook.xml.rels';
  const relsRaw = files[relsPath];
  const ridByDef = new Map<string, string>();
  if (relsRaw) {
    let relsXml = decoder.decode(relsRaw);
    let touched = false;
    for (const { defPath } of caches) {
      const target = defPath.startsWith('xl/') ? defPath.slice(3) : defPath;
      if (relsXml.includes(`Target="${target}"`)) {
        const m = new RegExp(
          `<Relationship\\s+Id="([^"]*)"[^>]*Target="${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
        ).exec(relsXml);
        if (m?.[1]) ridByDef.set(defPath, m[1]);
        continue;
      }
      const rid = freshRid(relsXml, 'rId');
      const rel =
        `<Relationship Id="${rid}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" ` +
        `Target="${target}"/>`;
      relsXml = relsXml.includes('</Relationships>')
        ? relsXml.replace('</Relationships>', `${rel}</Relationships>`)
        : `${relsXml}${rel}`;
      ridByDef.set(defPath, rid);
      touched = true;
    }
    if (touched) {
      files[relsPath] = encoder.encode(relsXml);
    }
  }

  // <pivotCaches> block: insert after </sheets>, else before </workbook>.
  // The presence check is prefix-tolerant (ClosedXML writes <x:pivotCaches>).
  if (/(?:<\w+:)?pivotCaches[\s>]/.test(wbXml)) return true; // already present
  const entries = caches
    .map(({ cacheId, defPath }) => {
      const rid = ridByDef.get(defPath);
      return rid ? `<pivotCache cacheId="${cacheId}" r:id="${rid}"/>` : null;
    })
    .filter((e): e is string => e !== null);
  if (entries.length === 0) return false;
  const block = `<pivotCaches>${entries.join('')}</pivotCaches>`;
  if (wbXml.includes('</sheets>')) {
    wbXml = wbXml.replace('</sheets>', `</sheets>${block}`);
  } else if (wbXml.includes('</workbook>')) {
    wbXml = wbXml.replace('</workbook>', `${block}</workbook>`);
  } else {
    return false;
  }
  files[wbPath] = encoder.encode(wbXml);
  return true;
}

/** Relative target from one part to another (`xl/worksheets/sheet1.xml` → `xl/pivotTables/pivotTable1.xml` = `../pivotTables/pivotTable1.xml`). */
function relativeTarget(fromPart: string, toPart: string): string {
  const fromDir = fromPart.split('/').slice(0, -1);
  const toSegs = toPart.split('/');
  let i = 0;
  while (i < fromDir.length && i < toSegs.length - 1 && fromDir[i] === toSegs[i]) i += 1;
  return [...Array<string>(fromDir.length - i).fill('..'), ...toSegs.slice(i)].join('/');
}

function ensureSheetPivotRel(
  files: Record<string, Uint8Array>,
  sheetName: string,
  tablePath: string,
): boolean {
  const sheets = sheetPartPaths(files);
  const sheet = sheets.find((s) => s.name === sheetName);
  if (!sheet) return false;
  const dir = sheet.path.includes('/') ? sheet.path.slice(0, sheet.path.lastIndexOf('/')) : '';
  const base = sheet.path.slice(sheet.path.lastIndexOf('/') + 1);
  const relsPath = `${dir}/_rels/${base}.rels`;
  // Targets in a sheet .rels are relative to the worksheet part itself.
  const relTarget = relativeTarget(sheet.path, tablePath);
  const relsRaw = files[relsPath];
  let relsXml = relsRaw
    ? decoder.decode(relsRaw)
    : `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (relsXml.includes('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable"')) {
    return false;
  }
  const rid = freshRid(relsXml, 'rId');
  const rel =
    `<Relationship Id="${rid}" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" ` +
    `Target="${relTarget}"/>`;
  relsXml = relsXml.includes('</Relationships>')
    ? relsXml.replace('</Relationships>', `${rel}</Relationships>`)
    : `${relsXml}${rel}`;
  files[relsPath] = encoder.encode(relsXml);
  return true;
}

/**
 * Re-inject pivot parts (captured on read) into a freshly written package,
 * byte-for-byte. This is the write half of the round-trip: SheetJS rebuilds
 * the OOXML package from its own model and would otherwise drop every
 * pivot. Never throws — on any problem the input bytes are returned
 * unchanged.
 */
export function injectPivotParts(
  packageBytes: Uint8Array,
  rawParts: PivotRawParts | unknown,
): Uint8Array {
  try {
    if (
      !rawParts ||
      typeof rawParts !== 'object' ||
      !Array.isArray((rawParts as PivotRawParts).tables) ||
      (rawParts as PivotRawParts).tables.length === 0
    ) {
      return packageBytes;
    }
    const parts = (rawParts as PivotRawParts).parts ?? {};
    const partPaths = Object.keys(parts);
    if (partPaths.length === 0) return packageBytes;

    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;
    let touched = false;
    for (const path of partPaths) {
      const b64 = parts[path];
      if (typeof b64 !== 'string' || b64.length === 0) continue;
      try {
        files[path] = base64ToU8(b64);
      } catch {
        continue;
      }
      touched = true;
      ensureContentType(files, path);
    }
    if (!touched) return packageBytes;

    const rp = rawParts as PivotRawParts;
    ensureWorkbookPivotCaches(files, rp.caches ?? []);
    for (const t of rp.tables ?? []) {
      if (t.tablePath && t.sheetName) ensureSheetPivotRel(files, t.sheetName, t.tablePath);
    }
    return zipSyncStable(files);
  } catch {
    return packageBytes;
  }
}
