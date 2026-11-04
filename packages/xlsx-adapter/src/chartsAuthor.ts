/**
 * Native XLSX chart AUTHORING — the write half of charts.ts.
 *
 * charts.ts parses native chart parts out of a package (import only);
 * this module is its inverse: it turns chart specs (the service
 * ChartSpec shape, structurally — this package does not depend on the
 * service package) into real `xl/charts/chartN.xml` parts, wires a
 * `twoCellAnchor` for each into the anchor sheet's drawing part
 * (creating the drawing part when the sheet has none, APPENDING to the
 * existing drawing part when it has one — a sheet may have only one
 * drawing part), and registers the sheet→drawing relationship and the
 * [Content_Types].xml overrides.
 *
 * Two integration surfaces, matching the two save paths:
 * - `authorChartParts(files, specs)` — surgery on an unzipped
 *   path→bytes map (the directSave parts pipeline).
 * - `injectChartParts(bytes, specs)` — bytes-level wrapper (unzip →
 *   author → deterministic re-zip) for the adapter-fallback path,
 *   cloned from `injectPivotParts`/`injectSmartArtParts`.
 *
 * Package surgery scaffolding is cloned from smartart.ts (drawing
 * authoring, freePartPath, rels/content-type helpers) and
 * pivotTables.ts (post-write injection shape, freshRid). The chart XML
 * itself is new: `buildChartXml` emits a minimal-but-valid c:chartSpace
 * whose oracle is the REAL parser — readCharts() must parse the
 * authored part back to the same kind / title / series formulas /
 * anchor (see tests/chartsAuthor.test.ts).
 *
 * Fail-closed kind subset (trace §4.1a/d): only the kinds with a
 * faithful single-part form are authorable — column-clustered,
 * column-stacked, bar-clustered, line, line-markers, area, pie,
 * doughnut. Anything else THROWS from authorChartParts/buildChartXml;
 * the bytes wrapper follows the injection precedents and never fails a
 * save (it returns the input bytes unchanged instead).
 */

import { unzipSync } from 'fflate';
import { readCharts, serializeTrendlineXml, type ImportedChartSeriesTrendline } from './charts.js';
import { zipSyncStable } from './zipStable.js';

// ---------------------------------------------------------------------------
// Spec shape (structural subset of the service ChartSpec)
// ---------------------------------------------------------------------------

export interface ChartAuthorRange {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface ChartAuthorSeriesRange {
  name: string;
  cat: ChartAuthorRange | null;
  val: ChartAuthorRange;
}

export interface ChartAuthorSpec {
  id?: number | string;
  kind: string;
  title?: string;
  range: ChartAuthorRange;
  seriesRanges?: ChartAuthorSeriesRange[];
  anchorCells?: { fromCol: number; fromRow: number; toCol: number; toRow: number };
  /** First-paint cache (used for part caches when no resolver is given). */
  cachedSeries?: {
    labels: (string | number)[];
    datasets: Array<{ label: string; data: (number | null)[] }>;
  };
  trendlines?: Array<{
    type: ImportedChartSeriesTrendline['type'];
    seriesIndex?: number;
    order?: number;
    period?: number;
    forward?: number;
    backward?: number;
    intercept?: number;
    label?: string;
    displayEquation?: boolean;
    displayRSquared?: boolean;
  }>;
}

/** Live cell lookup for cache computation (text + numeric view of a cell). */
export type ChartCellResolver = (
  sheet: string,
  row: number,
  col: number,
) => { text: string; num: number | null } | null | undefined;

export interface AuthorChartOptions {
  resolveCell?: ChartCellResolver;
}

export interface AuthorChartResult {
  /** Specs actually authored as new parts. */
  added: number;
  /** Specs skipped by the dedup rule (an identical part already exists). */
  skipped: number;
  /** Chart part paths created, in spec order. */
  chartPaths: string[];
  /**
   * Sheet name → drawing relationship id, ONLY for sheets that had no
   * drawing part before (their sheet XML needs a <drawing r:id="…"/>
   * element; authorChartParts already inserts it into the files map,
   * and the streaming serializer's drawingRid option uses this map as
   * its belt-and-braces source when regenerating such a sheet).
   */
  drawingRidBySheet: Map<string, string>;
}

/** The fail-closed authorable kind subset (trace §4.1a/d). */
export const AUTHORABLE_CHART_KINDS: ReadonlySet<string> = new Set([
  'column-clustered',
  'column-stacked',
  'bar-clustered',
  'line',
  'line-markers',
  'area',
  'pie',
  'doughnut',
]);

export function isAuthorableChartKind(kind: string): boolean {
  return AUTHORABLE_CHART_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Small XML helpers (cloned patterns from smartart.ts / pivotTables.ts)
// ---------------------------------------------------------------------------

const DEC = new TextDecoder();
const ENC = new TextEncoder();

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  const rels = DEC.decode(raw);
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    const type = attr(tag, 'Type') ?? '';
    if (id && target && type.endsWith(typeSuffix)) out.set(id, resolveTarget(ownerPart, target));
  }
  return out;
}

function sheetPartPaths(files: Record<string, Uint8Array>): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const wbXml = files['xl/workbook.xml'];
  if (!wbXml) return out;
  const wb = DEC.decode(wbXml);
  const targetByRid = relTargets(files, 'xl/_rels/workbook.xml.rels', '/worksheet', 'xl/workbook.xml');
  for (const tag of wb.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attr(tag, 'name');
    const rid = attr(tag, 'r:id');
    if (name && rid) {
      const path = targetByRid.get(rid);
      if (path) out.push({ name, path });
    }
  }
  return out;
}

function freePartPath(files: Record<string, Uint8Array>, dir: string, stem: string, ext: string): string {
  let n = 1;
  while (files[`${dir}/${stem}${n}.${ext}`]) n += 1;
  return `${dir}/${stem}${n}.${ext}`;
}

/** Fresh relationship id not already used in the rels XML. */
function freshRid(relsXml: string, prefix = 'rId'): string {
  const used = new Set<string>();
  for (const m of relsXml.match(/Id="([^"]*)"/g) ?? []) {
    const id = /^Id="([^"]*)"$/.exec(m)?.[1];
    if (id) used.add(id);
  }
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

function relsPathFor(partPath: string): string {
  return partPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
}

const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const DRAWING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.drawing+xml';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function ensureContentType(files: Record<string, Uint8Array>, path: string, contentType: string): void {
  const ctPath = '[Content_Types].xml';
  const raw = files[ctPath];
  if (!raw) return;
  let xml = DEC.decode(raw);
  if (xml.includes(`PartName="/${path}"`)) return;
  if (!xml.includes('</Types>')) return;
  xml = xml.replace('</Types>', `<Override PartName="/${path}" ContentType="${contentType}"/></Types>`);
  files[ctPath] = ENC.encode(xml);
}

// ---------------------------------------------------------------------------
// A1 formula helpers
// ---------------------------------------------------------------------------

export function colLetters(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function quoteSheet(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

/** `'Sheet'!$B$2:$B$5` form of a range (single cell collapses to one ref). */
export function rangeToFormula(range: ChartAuthorRange): string {
  const a = `$${colLetters(range.startCol)}$${range.startRow + 1}`;
  const b = `$${colLetters(range.endCol)}$${range.endRow + 1}`;
  return `${quoteSheet(range.sheet)}!${a === b ? a : `${a}:${b}`}`;
}

function rangeCells(range: ChartAuthorRange): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = [];
  // Ranges used here are single-row or single-column; walk in range order.
  if (range.startRow === range.endRow) {
    for (let c = range.startCol; c <= range.endCol; c++) out.push({ row: range.startRow, col: c });
  } else {
    for (let r = range.startRow; r <= range.endRow; r++) out.push({ row: r, col: range.startCol });
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildChartXml — spec + resolved series → c:chartSpace (the inverse oracle
// is charts.ts parseChartPart: kind / barDir / title / series formulas and
// caches must parse back exactly)
// ---------------------------------------------------------------------------

export interface ChartXmlSeries {
  name: string;
  /** Formula for the series-name header cell (strRef tx) when known. */
  nameFormula?: string;
  catFormula?: string;
  catValues?: (string | number | null)[];
  valFormula: string;
  valValues?: (number | null)[];
  trendlines?: ImportedChartSeriesTrendline[];
}

interface KindForm {
  element: string;
  /** Extra elements before the series (barDir/grouping/varyColors…). */
  pre: string;
  /** True when the chart carries cat/val axes (not pie/doughnut). */
  axes: boolean;
  /** Grouping value for stacked kinds. */
  grouping?: string;
}

function kindForm(kind: string): KindForm {
  switch (kind) {
    case 'column-clustered':
      return { element: 'barChart', pre: '<c:barDir val="col"/><c:grouping val="clustered"/>', axes: true };
    case 'column-stacked':
      return { element: 'barChart', pre: '<c:barDir val="col"/><c:grouping val="stacked"/>', axes: true, grouping: 'stacked' };
    case 'bar-clustered':
      return { element: 'barChart', pre: '<c:barDir val="bar"/><c:grouping val="clustered"/>', axes: true };
    case 'line':
    case 'line-markers':
      return { element: 'lineChart', pre: '<c:grouping val="standard"/>', axes: true };
    case 'area':
      return { element: 'areaChart', pre: '<c:grouping val="standard"/>', axes: true };
    case 'pie':
      return { element: 'pieChart', pre: '<c:varyColors val="1"/>', axes: false };
    case 'doughnut':
      return { element: 'doughnutChart', pre: '<c:varyColors val="1"/>', axes: false };
    default:
      throw new Error(
        `buildChartXml: chart kind "${kind}" is not authorable (supported: ${[...AUTHORABLE_CHART_KINDS].join(', ')})`,
      );
  }
}

function numCache(values: (number | null)[]): string {
  const pts = values
    .map((v, i) => `<c:pt idx="${i}"><c:v>${v !== null && Number.isFinite(v) ? String(v) : ''}</c:v></c:pt>`)
    .join('');
  return `<c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}`;
}

function strCache(values: (string | number | null)[]): string {
  const pts = values
    .map((v, i) => `<c:pt idx="${i}"><c:v>${v === null ? '' : escapeXml(String(v))}</c:v></c:pt>`)
    .join('');
  return `<c:ptCount val="${values.length}"/>${pts}`;
}

function catXml(s: ChartXmlSeries): string {
  if (!s.catFormula) return '';
  const values = s.catValues ?? [];
  const numeric = values.length > 0 && values.every((v) => v === null || typeof v === 'number');
  if (numeric) {
    return `<c:cat><c:numRef><c:f>${escapeXml(s.catFormula)}</c:f><c:numCache>${numCache(values.map((v) => (typeof v === 'number' ? v : null)))}</c:numCache></c:numRef></c:cat>`;
  }
  return `<c:cat><c:strRef><c:f>${escapeXml(s.catFormula)}</c:f><c:strCache>${strCache(values)}</c:strCache></c:strRef></c:cat>`;
}

function seriesXml(kind: string, s: ChartXmlSeries, idx: number): string {
  const parts = [`<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>`];
  if (s.name) {
    if (s.nameFormula) {
      parts.push(
        `<c:tx><c:strRef><c:f>${escapeXml(s.nameFormula)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${escapeXml(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`,
      );
    } else {
      parts.push(`<c:tx><c:v>${escapeXml(s.name)}</c:v></c:tx>`);
    }
  }
  if (kind === 'line-markers') parts.push('<c:marker><c:symbol val="circle"/></c:marker>');
  for (const t of s.trendlines ?? []) parts.push(serializeTrendlineXml(t));
  parts.push(catXml(s));
  parts.push(
    `<c:val><c:numRef><c:f>${escapeXml(s.valFormula)}</c:f><c:numCache>${numCache(s.valValues ?? [])}</c:numCache></c:numRef></c:val>`,
  );
  if (kind === 'line' || kind === 'line-markers') parts.push('<c:smooth val="0"/>');
  parts.push('</c:ser>');
  return parts.join('');
}

const CAT_AX_ID = 111111111;
const VAL_AX_ID = 222222222;

function axesXml(kind: string): string {
  const horizontalBar = kind === 'bar-clustered';
  const catAx =
    `<c:catAx><c:axId val="${CAT_AX_ID}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${horizontalBar ? 'l' : 'b'}"/><c:crossAx val="${VAL_AX_ID}"/>` +
    `<c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`;
  const valAx =
    `<c:valAx><c:axId val="${VAL_AX_ID}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${horizontalBar ? 'b' : 'l'}"/><c:majorGridlines/>` +
    `<c:crossAx val="${CAT_AX_ID}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  return catAx + valAx;
}

/**
 * Emit a minimal-but-valid `<c:chartSpace>` for one spec. Throws on a
 * non-authorable kind or an empty series list (fail closed).
 */
export function buildChartXml(spec: ChartAuthorSpec, series: ChartXmlSeries[]): string {
  const form = kindForm(spec.kind); // throws for unsupported kinds
  if (series.length === 0) throw new Error('buildChartXml: at least one series is required');
  const title = spec.title ?? '';
  const titleXml =
    title.trim() !== ''
      ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr>` +
        `<a:r><a:rPr lang="en-US"/><a:t>${escapeXml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
      : '<c:autoTitleDeleted val="1"/>';
  const seriesParts = series.map((s, i) => seriesXml(spec.kind, s, i)).join('');
  const hole = spec.kind === 'doughnut' ? '<c:holeSize val="50"/><c:firstSliceAng val="0"/>' : '';
  const firstSlice = spec.kind === 'pie' ? '<c:firstSliceAng val="0"/>' : '';
  const plot =
    `<c:${form.element}>${form.pre}${seriesParts}${hole}${firstSlice}` +
    (form.axes ? `<c:axId val="${CAT_AX_ID}"/><c:axId val="${VAL_AX_ID}"/>` : '') +
    `</c:${form.element}>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:chart>${titleXml}<c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>${plot}${form.axes ? axesXml(spec.kind) : ''}</c:plotArea>` +
    `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/>` +
    `</c:chart></c:chartSpace>`
  );
}

// ---------------------------------------------------------------------------
// Series derivation from a spec (+ optional live resolver for caches)
// ---------------------------------------------------------------------------

function anchorOf(spec: ChartAuthorSpec): { fromCol: number; fromRow: number; toCol: number; toRow: number } {
  if (spec.anchorCells) return spec.anchorCells;
  // Trace §4.1a: default anchor below/right of the data range, fixed
  // size 8 cols × 15 rows.
  const fromCol = spec.range.startCol;
  const fromRow = spec.range.endRow + 2;
  return { fromCol, fromRow, toCol: fromCol + 8, toRow: fromRow + 15 };
}

function resolveRangeValues(
  range: ChartAuthorRange,
  resolve: ChartCellResolver | undefined,
  cached: (string | number | null)[] | undefined,
): { texts: (string | number | null)[]; nums: (number | null)[] } {
  const cells = rangeCells(range);
  if (resolve) {
    const texts: (string | number | null)[] = [];
    const nums: (number | null)[] = [];
    for (const { row, col } of cells) {
      const cell = resolve(range.sheet, row, col);
      texts.push(cell ? (cell.text !== '' ? cell.text : cell.num) : null);
      nums.push(cell ? cell.num : null);
    }
    return { texts, nums };
  }
  return { texts: cached ?? [], nums: (cached ?? []).map((v) => (typeof v === 'number' ? v : null)) };
}

function headerFormulaFor(val: ChartAuthorRange): string | undefined {
  // Column series: header cell directly above the values. Single-row
  // series: header cell directly left of the values. Mirrors the
  // fallback in service extractSeriesFromRanges.
  if (val.startRow === val.endRow) {
    if (val.startCol <= 0) return undefined;
    return rangeToFormula({ sheet: val.sheet, startRow: val.startRow, startCol: val.startCol - 1, endRow: val.startRow, endCol: val.startCol - 1 });
  }
  if (val.startRow <= 0) return undefined;
  return rangeToFormula({ sheet: val.sheet, startRow: val.startRow - 1, startCol: val.startCol, endRow: val.startRow - 1, endCol: val.startCol });
}

function deriveSeries(spec: ChartAuthorSpec, resolve: ChartCellResolver | undefined): ChartXmlSeries[] {
  const trendFor = (i: number): ImportedChartSeriesTrendline[] =>
    (spec.trendlines ?? [])
      .filter((t) => (t.seriesIndex ?? 0) === i)
      .map((t) => ({
        name: t.label ?? '',
        type: t.type,
        ...(t.order !== undefined ? { order: t.order } : {}),
        ...(t.period !== undefined ? { period: t.period } : {}),
        ...(t.forward ? { forward: t.forward } : {}),
        ...(t.backward ? { backward: t.backward } : {}),
        ...(t.intercept !== undefined ? { intercept: t.intercept } : {}),
        ...(t.displayEquation ? { displayEquation: true } : {}),
        ...(t.displayRSquared ? { displayRSquared: true } : {}),
      }));
  if (spec.seriesRanges && spec.seriesRanges.length > 0) {
    return spec.seriesRanges.map((sr, i) => {
      const cachedCat = i === 0 ? spec.cachedSeries?.labels : undefined;
      const cachedVal = spec.cachedSeries?.datasets[i]?.data;
      const cat = sr.cat ? resolveRangeValues(sr.cat, resolve, cachedCat) : null;
      const val = resolveRangeValues(sr.val, resolve, cachedVal);
      return {
        name: sr.name,
        nameFormula: sr.name ? headerFormulaFor(sr.val) : undefined,
        catFormula: sr.cat ? rangeToFormula(sr.cat) : undefined,
        catValues: cat ? cat.texts : undefined,
        valFormula: rangeToFormula(sr.val),
        valValues: val.nums,
        trendlines: trendFor(i),
      };
    });
  }
  // No per-series ranges: Excel layout convention over the single block
  // (trace §5) — first column = categories, first row = series names,
  // one series per remaining column.
  const r = spec.range;
  const out: ChartXmlSeries[] = [];
  const catRange: ChartAuthorRange = {
    sheet: r.sheet,
    startRow: r.startRow + 1,
    startCol: r.startCol,
    endRow: r.endRow,
    endCol: r.startCol,
  };
  const catVals = resolveRangeValues(catRange, resolve, spec.cachedSeries?.labels);
  for (let c = r.startCol + 1; c <= r.endCol; c++) {
    const valRange: ChartAuthorRange = { sheet: r.sheet, startRow: r.startRow + 1, startCol: c, endRow: r.endRow, endCol: c };
    const header = resolve ? resolve(r.sheet, r.startRow, c) : null;
    const name = header?.text ? header.text : (spec.cachedSeries?.datasets[out.length]?.label ?? `Series ${out.length + 1}`);
    const val = resolveRangeValues(valRange, resolve, spec.cachedSeries?.datasets[out.length]?.data);
    out.push({
      name,
      nameFormula: headerFormulaFor(valRange),
      catFormula: rangeToFormula(catRange),
      catValues: catVals.texts,
      valFormula: rangeToFormula(valRange),
      valValues: val.nums,
      trendlines: trendFor(out.length),
    });
  }
  // Single-column block: the column itself is the one series.
  if (out.length === 0) {
    const val = resolveRangeValues(r, resolve, spec.cachedSeries?.datasets[0]?.data);
    out.push({
      name: spec.cachedSeries?.datasets[0]?.label ?? 'Series 1',
      valFormula: rangeToFormula(r),
      valValues: val.nums,
      trendlines: trendFor(0),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drawing authoring
// ---------------------------------------------------------------------------

const CHART_GRAPHIC_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

function chartAnchorXml(anchor: { fromCol: number; fromRow: number; toCol: number; toRow: number }, rid: string, id: number, name: string): string {
  return (
    `<xdr:twoCellAnchor>` +
    `<xdr:from><xdr:col>${anchor.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchor.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${anchor.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchor.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:graphicFrame macro="">` +
    `<xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${escapeXml(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="${CHART_GRAPHIC_URI}">` +
    `<c:chart xmlns:c="${CHART_GRAPHIC_URI}" xmlns:r="${OFFICE_REL_NS}" r:id="${rid}"/>` +
    `</a:graphicData></a:graphic>` +
    `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
  );
}

function newDrawingXml(anchors: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="${OFFICE_REL_NS}">${anchors.join('')}</xdr:wsDr>`
  );
}

function appendAnchorToDrawing(drawingXml: string, anchorXml: string): string {
  const close = /<\/(\w+):wsDr>/.exec(drawingXml);
  if (close) return drawingXml.slice(0, close.index) + anchorXml + drawingXml.slice(close.index);
  if (drawingXml.includes('</wsDr>')) return drawingXml.replace('</wsDr>', `${anchorXml}</wsDr>`);
  return drawingXml + anchorXml;
}

function appendRel(relsXml: string, rid: string, type: string, target: string): string {
  const rel = `<Relationship Id="${rid}" Type="${type}" Target="${escapeXml(target)}"/>`;
  if (relsXml.includes('</Relationships>')) return relsXml.replace('</Relationships>', `${rel}</Relationships>`);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${REL_NS}">${rel}</Relationships>`
  );
}

function emptyRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"></Relationships>`;
}

/** Insert `<drawing r:id="…"/>` into a sheet part (after </sheetData>). */
function insertDrawingElement(sheetXml: string, rid: string): string {
  if (/<drawing\b/.test(sheetXml)) return sheetXml;
  const el = `<drawing r:id="${rid}"/>`;
  if (sheetXml.includes('</sheetData>')) return sheetXml.replace('</sheetData>', `</sheetData>${el}`);
  if (/<sheetData\b[^>]*\/>/.test(sheetXml)) return sheetXml.replace(/<sheetData\b[^>]*\/>/, (m) => `${m}${el}`);
  return sheetXml.replace('</worksheet>', `${el}</worksheet>`);
}

// ---------------------------------------------------------------------------
// authorChartParts — package surgery on a files map
// ---------------------------------------------------------------------------

/**
 * Author native chart parts for `specs` into an unzipped package map.
 * Mutates `files` in place (chart parts, drawing parts + rels, sheet
 * rels, sheet <drawing> element for newly-drawn sheets, content types).
 *
 * Dedup rule (trace §4.1d): a spec whose (anchor sheet, title, multiset
 * of series valFormulas) matches an existing native chart in the
 * package is skipped — save #2, rehydrate-then-save and the
 * imported-chart-on-the-same-sheet case never duplicate parts.
 *
 * Throws on a non-authorable kind (fail closed, BEFORE any mutation)
 * and on a spec whose anchor sheet is not in the package.
 */
export function authorChartParts(
  files: Record<string, Uint8Array>,
  specs: ChartAuthorSpec[],
  options: AuthorChartOptions = {},
): AuthorChartResult {
  const result: AuthorChartResult = { added: 0, skipped: 0, chartPaths: [], drawingRidBySheet: new Map() };
  if (specs.length === 0) return result;
  // Fail closed BEFORE mutating anything.
  for (const spec of specs) {
    if (!isAuthorableChartKind(spec.kind)) {
      throw new Error(
        `authorChartParts: chart kind "${spec.kind}" is not authorable (supported: ${[...AUTHORABLE_CHART_KINDS].join(', ')})`,
      );
    }
    if (!spec.range || typeof spec.range.sheet !== 'string') {
      throw new Error('authorChartParts: every spec needs a range with a sheet');
    }
  }
  const sheets = sheetPartPaths(files);
  const sheetPathByName = new Map(sheets.map((s) => [s.name, s.path]));

  // Dedup against the parts already in the package.
  const existing = readCharts(files);
  const existingKeys = new Set(
    existing.map((c) =>
      [c.sheetName, c.title, c.series.map((s) => s.valFormula).sort().join('|')].join('\u0000'),
    ),
  );

  // Group surviving specs by anchor sheet (creation order preserved).
  const bySheet = new Map<string, ChartAuthorSpec[]>();
  for (const spec of specs) {
    const series = deriveSeries(spec, options.resolveCell);
    const key = [spec.range.sheet, spec.title ?? '', series.map((s) => s.valFormula).sort().join('|')].join('\u0000');
    if (existingKeys.has(key)) {
      result.skipped += 1;
      continue;
    }
    existingKeys.add(key); // duplicate specs in one call also dedup
    const list = bySheet.get(spec.range.sheet) ?? [];
    list.push(spec);
    bySheet.set(spec.range.sheet, list);
  }

  for (const [sheetName, sheetSpecs] of bySheet) {
    const sheetPath = sheetPathByName.get(sheetName);
    if (!sheetPath) throw new Error(`authorChartParts: sheet "${sheetName}" is not in the package`);
    const sheetRelsPath = relsPathFor(sheetPath);

    // 1. Author the chart parts for this sheet.
    const authored: Array<{ spec: ChartAuthorSpec; chartPath: string }> = [];
    for (const spec of sheetSpecs) {
      const chartPath = freePartPath(files, 'xl/charts', 'chart', 'xml');
      const xml = buildChartXml(spec, deriveSeries(spec, options.resolveCell));
      files[chartPath] = ENC.encode(xml);
      ensureContentType(files, chartPath, CHART_CONTENT_TYPE);
      authored.push({ spec, chartPath });
      result.chartPaths.push(chartPath);
      result.added += 1;
    }

    // 2. Resolve (or create) the sheet's drawing part.
    const drawingByRid = relTargets(files, sheetRelsPath, '/drawing', sheetPath);
    let drawingPath: string | undefined = [...drawingByRid.values()][0];
    if (!drawingPath) {
      drawingPath = freePartPath(files, 'xl/drawings', 'drawing', 'xml');
      files[drawingPath] = ENC.encode(newDrawingXml([]));
      ensureContentType(files, drawingPath, DRAWING_CONTENT_TYPE);
      files[relsPathFor(drawingPath)] = ENC.encode(emptyRelsXml());
      // Sheet → drawing relationship + <drawing> element in the sheet.
      const existingSheetRels = files[sheetRelsPath] ? DEC.decode(files[sheetRelsPath]) : emptyRelsXml();
      const rid = freshRid(existingSheetRels);
      const target = `../drawings/${drawingPath.split('/').pop()}`;
      files[sheetRelsPath] = ENC.encode(
        appendRel(existingSheetRels, rid, `${OFFICE_REL_NS}/drawing`, target),
      );
      result.drawingRidBySheet.set(sheetName, rid);
      const sheetRaw = files[sheetPath];
      if (sheetRaw) files[sheetPath] = ENC.encode(insertDrawingElement(DEC.decode(sheetRaw), rid));
    }

    // 3. Append one anchor + chart rel per authored chart.
    const drawingRelsPath = relsPathFor(drawingPath);
    let drawingXml = DEC.decode(files[drawingPath] as Uint8Array);
    let drawingRelsXml = files[drawingRelsPath] ? DEC.decode(files[drawingRelsPath]) : emptyRelsXml();
    let maxNvId = 1;
    for (const m of drawingXml.match(/cNvPr id="(\d+)"/g) ?? []) {
      const id = Number(/^cNvPr id="(\d+)"$/.exec(m)?.[1] ?? 0);
      if (id > maxNvId) maxNvId = id;
    }
    authored.forEach(({ spec, chartPath }, i) => {
      const rid = freshRid(drawingRelsXml);
      drawingRelsXml = appendRel(drawingRelsXml, rid, `${OFFICE_REL_NS}/chart`, `../charts/${chartPath.split('/').pop()}`);
      drawingXml = appendAnchorToDrawing(
        drawingXml,
        chartAnchorXml(anchorOf(spec), rid, maxNvId + 1 + i, `Chart ${result.chartPaths.length - authored.length + i + 1}`),
      );
    });
    files[drawingPath] = ENC.encode(drawingXml);
    files[drawingRelsPath] = ENC.encode(drawingRelsXml);
  }
  return result;
}

// ---------------------------------------------------------------------------
// injectChartParts — bytes wrapper for the adapter-fallback save path
// ---------------------------------------------------------------------------

/**
 * Bytes-level wrapper (unzip → authorChartParts → zipSyncStable), the
 * `injectPivotParts` shape. Never throws and never fails a save: on any
 * problem — or when every spec dedups against parts already present —
 * the input bytes are returned unchanged.
 */
export function injectChartParts(
  packageBytes: Uint8Array,
  specs: ChartAuthorSpec[],
  options: AuthorChartOptions = {},
): Uint8Array {
  try {
    if (!Array.isArray(specs) || specs.length === 0) return packageBytes;
    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;
    const result = authorChartParts(files, specs, options);
    if (result.added === 0) return packageBytes;
    return zipSyncStable(files);
  } catch {
    return packageBytes;
  }
}
