/**
 * Native XLSX drawingML chart import.
 *
 * SheetJS community edition drops drawingML charts entirely, so this module
 * reads them directly from the OOXML package with fflate (the same
 * unzip-only pattern as pageBreaksXml.ts — no new dependencies):
 *
 * - read:  for every worksheet part, follow
 *          `xl/worksheets/_rels/sheetN.xml.rels` → drawing part →
 *          `xl/drawings/drawingN.xml` (`xdr:twoCellAnchor` → anchor cells +
 *          `c:chart` r:id) → `xl/drawings/_rels/drawingN.xml.rels` → chart
 *          part → `xl/charts/chartN.xml` (kind from the plotArea child,
 *          per-series title / category formula / value formula, chart title).
 *
 * Design-doc note (checked 2026-10-18): the 15 design docs are silent on
 * imported drawingML charts — native-reports-and-dashboards.md covers
 * report/dashboard visuals bound to tables and queries, not XLSX chart
 * import. The mapping below is therefore the module's own contract:
 * EVERY `c:*Chart` plotArea child maps to a ChartKind — nothing is ever
 * silently dropped (user-locked requirement 2026-10-18).
 */

export interface ImportedChartAnchor {
  /** 0-based. */
  fromCol: number;
  /** 0-based. */
  fromRow: number;
  /** 0-based. */
  toCol: number;
  /** 0-based. */
  toRow: number;
  /**
   * Sub-cell offsets in EMUs (9525 EMU = 1px), as written in
   * xdr:from/xdr:to colOff/rowOff. Absent = 0 (cell-snapped anchor).
   * Carried so a moved chart's pixel-exact position round-trips:
   * the web maps these to px offsets, and the save re-anchor writes
   * them back (#125). oneCellAnchor extents have no offsets.
   */
  fromColOff?: number;
  fromRowOff?: number;
  toColOff?: number;
  toRowOff?: number;
}

export interface ImportedChartSeriesTrendline {
  /** Trendline name (may be ''). */
  name: string;
  /** Excel trendlineType val mapped to the app model. */
  type: 'linear' | 'exponential' | 'logarithmic' | 'polynomial' | 'power' | 'movingAverage';
  /** Polynomial order (only for polynomial). */
  order?: number;
  /** Moving-average period (only for movingAverage). */
  period?: number;
  /** Forecast forward periods (Excel <c:forward>). */
  forward?: number;
  /** Forecast backward periods (Excel <c:backward>). */
  backward?: number;
  /** Custom intercept (Excel <c:intercept>); undefined = fit normally. */
  intercept?: number;
  /** Excel <c:dispEq val="1"/>. */
  displayEquation?: boolean;
  /** Excel <c:dispRSqr val="1"/>. */
  displayRSquared?: boolean;
}

export interface ImportedChartSeries {
  /** Series name (may be ''). */
  name: string;
  /** Category formula, e.g. `'INCOME STATEMENT'!$C$6:$I$6` (may be ''). */
  catFormula: string;
  /** Value formula, e.g. `'INCOME STATEMENT'!$C$9:$I$9` (may be ''). */
  valFormula: string;
  /**
   * Cached category points from the chart part's own strCache/numCache
   * (or strLit/numLit for literal series) — the values Excel itself shows
   * before recalc. Cycle 10 progressive-display rule: charts render FIRST
   * from this cache, then re-render with live engine values. Absent when
   * the file carries no cache for this series (e.g. saveData-free parts).
   */
  catCache?: (string | number | null)[];
  /**
   * Cached value points from the chart part's numCache/strCache. Same
   * first-paint role as {@link ImportedChartSeries.catCache}; nulls are
   * gaps (blank/error points in the cache).
   */
  valCache?: (number | null)[];
  /** Trendlines declared on this series (Excel: Format Trendline). */
  trendlines: ImportedChartSeriesTrendline[];
}

export interface ImportedChart {
  /** 0-based index into the workbook's sheet order. */
  sheetIndex: number;
  /** Exact sheet name (matches the loaded sheet). */
  sheetName: string;
  /** Raw OOXML plotArea child name, e.g. 'barChart', 'line3DChart'. */
  kind: string;
  /** 'bar' | 'col' for barChart/bar3DChart; undefined otherwise. */
  barDir?: string;
  /** 'bar' | 'pie' for ofPieChart; undefined otherwise. */
  ofPieType?: string;
  /** Chart title (may be ''). */
  title: string;
  series: ImportedChartSeries[];
  anchor: ImportedChartAnchor;
  /**
   * Pivot-table name from `<c:pivotSource><c:name>` when this is a pivot
   * chart (Excel writes `[Workbook.xlsx]Sheet!PivotName`; the table name —
   * after the last `!` — is kept). Undefined for regular charts.
   */
  pivotSource?: string;
  /**
   * Ordered distinct plotArea child names, e.g. ['barChart', 'lineChart']
   * for a combo chart. Length 1 for ordinary charts.
   */
  plotTypes: string[];
  /**
   * True when a non-first plotArea child references axes disjoint from the
   * first child's axes (Excel: series on the secondary axis).
   */
  secondaryAxis: boolean;
}

/** Workbook-metadata key (contract shared with the web app). */
export const CHARTS_METADATA_KEY = 'icecream.charts';

/** Minimal XML entity unescape for text/attribute values. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Strip namespace prefixes from element tags (`<c:chart>` → `<chart>`,
 * `</a:t>` → `</t>`). Real files vary: Excel/xlsxwriter use `c:`/`a:`/`xdr:`
 * prefixes, openpyxl writes the chart namespace as the default (no prefix).
 * Attributes (including `r:id` and `xmlns:*` declarations) are untouched.
 * All element lookups below use the stripped local names.
 */
function stripPrefixes(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

/** First `<prefix:name ...>...</prefix:name>` block (non-greedy). */
function element(xml: string, qualified: string): string {
  const m = new RegExp(`<${qualified}[\\s>][\\s\\S]*?</${qualified}>`).exec(xml);
  return m ? m[0] : '';
}

/** All `<prefix:name ...>...</prefix:name>` blocks (non-greedy). */
function elements(xml: string, qualified: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${qualified}[\\s>][\\s\\S]*?</${qualified}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

/** Concatenated text of all `<t>…</t>` runs inside the given XML. */
function richText(xml: string): string {
  const parts: string[] = [];
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) parts.push(unescapeXml(m[1]));
  return parts.join('').trim();
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
  const rels = new TextDecoder().decode(raw);
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
function sheetPartPaths(files: Record<string, Uint8Array>): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const wbXml = files['xl/workbook.xml'];
  if (!wbXml) return out;
  const wb = new TextDecoder().decode(wbXml);
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

/** Integer child element value (`<xdr:col>1</xdr:col>`), or null. */
function intChild(xml: string, qualified: string): number | null {
  const m = new RegExp(`<${qualified}>(-?\\d+)</${qualified}>`).exec(xml);
  return m ? parseInt(m[1], 10) : null;
}

/** Formula text inside `<c:f>…</f>` of a strRef/numRef block (unescaped). */
function refFormula(block: string): string {
  const m = /<f>([\s\S]*?)<\/f>/.exec(block);
  return m ? unescapeXml(m[1]).trim() : '';
}

/** Attribute value of a `<prefix:name val="..."/>` element, or null. */
function valAttr(xml: string, qualified: string): number | null {
  const m = new RegExp(`<${qualified}\\s+val="([^"]*)"`).exec(xml);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Boolean `<prefix:name val="1"/>` element; missing or "0"/"false" = false. */
function boolValAttr(xml: string, qualified: string): boolean {
  const m = new RegExp(`<${qualified}\\s+val="([^"]*)"`).exec(xml);
  return !!m && m[1] !== '0' && m[1].toLowerCase() !== 'false';
}

const TRENDLINE_TYPE_MAP: Record<string, ImportedChartSeriesTrendline['type']> = {
  exp: 'exponential',
  linear: 'linear',
  log: 'logarithmic',
  movingAvg: 'movingAverage',
  poly: 'polynomial',
  power: 'power',
};

const TRENDLINE_TYPE_VAL: Record<ImportedChartSeriesTrendline['type'], string> = {
  exponential: 'exp',
  linear: 'linear',
  logarithmic: 'log',
  movingAverage: 'movingAvg',
  polynomial: 'poly',
  power: 'power',
};

/** Minimal XML attribute/text escape for serialized values. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Parse the `<c:trendline>` blocks of one `<c:ser>` element.
 * Never throws; unknown trendlineType values are skipped.
 */
function seriesTrendlines(ser: string): ImportedChartSeriesTrendline[] {
  const out: ImportedChartSeriesTrendline[] = [];
  for (const block of elements(ser, 'trendline')) {
    const rawType = /<trendlineType\s+val="([^"]*)"/.exec(block)?.[1] ?? '';
    const type = TRENDLINE_TYPE_MAP[rawType];
    if (!type) continue;
    const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(block);
    const tl: ImportedChartSeriesTrendline = {
      name: nameMatch ? unescapeXml(nameMatch[1]).trim() : '',
      type,
    };
    const order = valAttr(block, 'order');
    if (type === 'polynomial' && order !== null) tl.order = order;
    const period = valAttr(block, 'period');
    if (type === 'movingAverage' && period !== null) tl.period = period;
    const forward = valAttr(block, 'forward');
    if (forward !== null && forward !== 0) tl.forward = forward;
    const backward = valAttr(block, 'backward');
    if (backward !== null && backward !== 0) tl.backward = backward;
    const intercept = valAttr(block, 'intercept');
    if (intercept !== null) tl.intercept = intercept;
    if (boolValAttr(block, 'dispEq')) tl.displayEquation = true;
    if (boolValAttr(block, 'dispRSqr')) tl.displayRSquared = true;
    out.push(tl);
  }
  return out;
}

/**
 * Serialize one trendline spec to its Excel `<c:trendline>` XML (the
 * write-back half of the round-trip). Emits only the elements Excel writes:
 * name, type, order (poly), period (movingAvg), non-zero forward/backward,
 * intercept when set, and dispEq/dispRSqr when true.
 */
export function serializeTrendlineXml(t: ImportedChartSeriesTrendline): string {
  const parts = [`<c:trendline><c:name>${escapeXml(t.name)}</c:name>`];
  parts.push(`<c:trendlineType val="${TRENDLINE_TYPE_VAL[t.type]}"/>`);
  if (t.type === 'polynomial' && t.order !== undefined) {
    parts.push(`<c:order val="${Math.min(6, Math.max(2, Math.round(t.order)))}"/>`);
  }
  if (t.type === 'movingAverage' && t.period !== undefined) {
    parts.push(`<c:period val="${Math.max(2, Math.round(t.period))}"/>`);
  }
  if (t.forward) parts.push(`<c:forward val="${t.forward}"/>`);
  if (t.backward) parts.push(`<c:backward val="${t.backward}"/>`);
  if (t.intercept !== undefined) parts.push(`<c:intercept val="${t.intercept}"/>`);
  if (t.displayRSquared) parts.push(`<c:dispRSqr val="1"/>`);
  if (t.displayEquation) parts.push(`<c:dispEq val="1"/>`);
  parts.push('</c:trendline>');
  return parts.join('');
}

/**
 * Series name from `<c:tx>`:
 * - `<c:strRef>` / `<c:numRef>` → first cached `<c:v>` value (the resolved name).
 * - `<c:rich>` → concatenated `<a:t>` runs.
 * - bare `<c:v>` → its text.
 */
function seriesName(ser: string): string {
  const tx = element(ser, 'tx');
  if (!tx) return '';
  const rich = element(tx, 'rich');
  if (rich) return richText(rich);
  const v = /<v>([\s\S]*?)<\/v>/.exec(tx);
  if (v) return unescapeXml(v[1]).trim();
  return '';
}

/**
 * Category/value formula from `<c:cat>` / `<c:val>`. Handles all four OOXML
 * reference flavours — `<c:strRef>`, `<c:numRef>`, `<c:multiLvlStrRef>`,
 * `<c:multiLvlNumRef>` — each carrying the range in its `<c:f>` child.
 */
function dataFormula(ser: string, slot: 'cat' | 'val'): string {
  const block = element(ser, slot);
  if (!block) return '';
  const ref =
    element(block, 'strRef') ||
    element(block, 'numRef') ||
    element(block, 'multiLvlStrRef') ||
    element(block, 'multiLvlNumRef');
  return ref ? refFormula(ref) : '';
}

/** The cache/lit block inside one `<c:cat>`/`<c:val>`/`<c:xVal>`/`<c:yVal>`. */
function cacheBlock(slotXml: string): { xml: string; numeric: boolean } | null {
  if (!slotXml) return null;
  const scope =
    element(slotXml, 'strRef') ||
    element(slotXml, 'numRef') ||
    element(slotXml, 'strLit') ||
    element(slotXml, 'numLit') ||
    slotXml;
  if (!scope) return null;
  const numCache = element(scope, 'numCache');
  if (numCache) return { xml: numCache, numeric: true };
  const strCache = element(scope, 'strCache');
  if (strCache) return { xml: strCache, numeric: false };
  const numLit = element(scope, 'numLit');
  if (numLit) return { xml: numLit, numeric: true };
  const strLit = element(scope, 'strLit');
  if (strLit) return { xml: strLit, numeric: false };
  return null;
}

/** Parse `<c:pt idx="i"><c:v>…</c:v></c:pt>` points of a cache block. */
function cachePoints(cache: { xml: string; numeric: boolean }): (string | number | null)[] {
  const pts = elements(cache.xml, 'pt');
  const out: (string | number | null)[] = [];
  for (const pt of pts) {
    const idxAttr = attr(pt.slice(0, pt.indexOf('>') + 1), 'idx');
    const idx = idxAttr !== null ? parseInt(idxAttr, 10) : out.length;
    const v = /<v>([\s\S]*?)<\/v>/.exec(pt)?.[1];
    let value: string | number | null = null;
    if (v !== undefined && v.trim() !== '') {
      if (cache.numeric) {
        const n = Number(unescapeXml(v).trim());
        value = Number.isFinite(n) ? n : null;
      } else {
        value = unescapeXml(v);
      }
    }
    if (Number.isInteger(idx) && idx >= 0) out[idx] = value;
    else out.push(value);
  }
  // Normalize holes (missing idx entries) to null so index = point index.
  for (let i = 0; i < out.length; i++) if (!(i in out)) out[i] = null;
  return out;
}

/**
 * Cached points for one series slot — `<c:cat>`/`<c:xVal>` categories or
 * `<c:val>`/`<c:yVal>` values (scatter/bubble charts use xVal/yVal).
 * Returns undefined when the part carries no cache for the slot.
 */
function dataCache(
  ser: string,
  slot: 'cat' | 'val' | 'xVal' | 'yVal',
): (string | number | null)[] | undefined {
  const block = cacheBlock(element(ser, slot));
  if (!block) return undefined;
  const points = cachePoints(block);
  return points.length > 0 ? points : undefined;
}

/** Chart title from `c:title > c:tx > c:rich > a:t` runs (may be ''). */
function chartTitle(chartXml: string): string {
  const title = element(chartXml, 'title');
  if (!title) return '';
  return richText(element(title, 'rich'));
}

interface ParsedChart {
  kind: string;
  barDir?: string;
  ofPieType?: string;
  title: string;
  series: ImportedChartSeries[];
  /** Pivot-table name from <c:pivotSource>, if this is a pivot chart. */
  pivotSource?: string;
  /**
   * Ordered distinct plotArea child names, e.g. ['barChart', 'lineChart']
   * for a combo chart. Length 1 for ordinary charts.
   */
  plotTypes: string[];
  /**
   * True when a non-first plotArea child references axes disjoint from the
   * first child's axes (Excel: line series on the secondary axis).
   */
  secondaryAxis: boolean;
}

/**
 * Pivot-table name from `<c:pivotSource><c:name>[Wb.xlsx]Sheet!PivotName</name>`.
 * Per the OOXML schema (CT_ChartSpace) pivotSource is a direct child of
 * c:chartSpace (a sibling of c:chart), so the whole chart part is searched.
 * Returns the table name (after the last `!`), or undefined when the chart
 * is not a pivot chart.
 */
function pivotSourceName(chartSpaceXml: string): string | undefined {
  const src = element(chartSpaceXml, 'pivotSource');
  if (!src) return undefined;
  const m = /<name>([\s\S]*?)<\/name>/.exec(src);
  if (!m) return undefined;
  const full = unescapeXml(m[1]).trim();
  if (!full) return undefined;
  const bang = full.lastIndexOf('!');
  const name = (bang >= 0 ? full.slice(bang + 1) : full).trim();
  return name === '' ? undefined : name;
}

function parseChartPart(rawXml: string): ParsedChart | null {
  // Producers disagree on prefixes (c: vs default namespace); normalize.
  const xml = stripPrefixes(rawXml);
  const chartEl = element(xml, 'chart');
  if (!chartEl) return null;
  const plotArea = element(chartEl, 'plotArea');
  if (!plotArea) return null;
  // The plotArea child element name determines the kind. EVERY *Chart child
  // maps — never skip (user-locked requirement 2026-10-18).
  const kindMatch = /<(\w+Chart)[\s>]/.exec(plotArea);
  if (!kindMatch) return null;
  const kind = kindMatch[1];
  const chartBody = element(plotArea, kind) || plotArea;

  let barDir: string | undefined;
  const bd = /<barDir\s+val="([^"]*)"/.exec(chartBody);
  if (bd) barDir = bd[1];
  let ofPieType: string | undefined;
  const ot = /<ofPieType\s+val="([^"]*)"/.exec(chartBody);
  if (ot) ofPieType = ot[1];

  const title = chartTitle(chartEl);
  const series: ImportedChartSeries[] = [];
  // Combo charts carry one *Chart child per series group (e.g. barChart +
  // lineChart); collect series from ALL of them so trendlines on a
  // secondary plotArea child are not dropped. kind/barDir/ofPieType still
  // come from the first child (existing kind-mapping contract); the ordered
  // child names plus axis-disjointness let the app map real combos
  // (e.g. column+line on a secondary axis).
  const seen = new Set<string>();
  const plotTypes: string[] = [];
  const axIds: Set<string>[] = [];
  const childRe = /<(\w+Chart)[\s>]/g;
  let cm: RegExpExecArray | null;
  while ((cm = childRe.exec(plotArea)) !== null) {
    const childName = cm[1];
    if (seen.has(childName)) continue;
    seen.add(childName);
    const body = element(plotArea, childName);
    if (!body) continue;
    plotTypes.push(childName);
    const ids = new Set<string>();
    const axRe = /<axId\s+val="([^"]*)"/g;
    let axm: RegExpExecArray | null;
    while ((axm = axRe.exec(body)) !== null) ids.add(axm[1]);
    axIds.push(ids);
    for (const ser of elements(body, 'ser')) {
      // Progressive display (Cycle 10): keep the chart part's own cached
      // points so first paint doesn't wait on engine values.
      const catCache = dataCache(ser, 'cat') ?? dataCache(ser, 'xVal');
      const valCacheRaw = dataCache(ser, 'val') ?? dataCache(ser, 'yVal');
      const imported: ImportedChartSeries = {
        name: seriesName(ser),
        catFormula: dataFormula(ser, 'cat'),
        valFormula: dataFormula(ser, 'val'),
        trendlines: seriesTrendlines(ser),
      };
      if (catCache !== undefined) imported.catCache = catCache;
      if (valCacheRaw !== undefined) {
        imported.valCache = valCacheRaw.map((v) => (typeof v === 'number' ? v : null));
      }
      series.push(imported);
    }
  }
  // A non-first child whose axes are disjoint from the first child's axes
  // renders on Excel's secondary axis.
  let secondaryAxis = false;
  if (axIds.length > 1 && axIds[0].size > 0) {
    for (let i = 1; i < axIds.length; i++) {
      let overlap = false;
      for (const id of axIds[i]) {
        if (axIds[0].has(id)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        secondaryAxis = true;
        break;
      }
    }
  }
  const parsed: ParsedChart = { kind, barDir, ofPieType, title, series, plotTypes, secondaryAxis };
  // pivotSource is a child of c:chartSpace (sibling of c:chart), so the
  // whole chart part is searched.
  const pivotSource = pivotSourceName(xml);
  if (pivotSource) parsed.pivotSource = pivotSource;
  return parsed;
}

/**
 * Read all drawingML charts from an unzipped OOXML package
 * (path → bytes, as produced by fflate's unzipSync).
 * Never throws: any missing/corrupt part yields fewer charts, never an error.
 */
export function readCharts(files: Record<string, Uint8Array>): ImportedChart[] {
  const out: ImportedChart[] = [];
  try {
    const decoder = new TextDecoder();
    const sheets = sheetPartPaths(files);
    sheets.forEach(({ name: sheetName, path: sheetPath }, sheetIndex) => {
      // sheetN.xml → xl/worksheets/_rels/sheetN.xml.rels → drawing part.
      const dir = sheetPath.includes('/') ? sheetPath.slice(0, sheetPath.lastIndexOf('/')) : '';
      const sheetRelsPath = `${dir}/_rels/${sheetPath.slice(sheetPath.lastIndexOf('/') + 1)}.rels`;
      const drawingByRid = relTargets(files, sheetRelsPath, '/drawing', sheetPath);
      for (const drawingPath of drawingByRid.values()) {
        const drawingRaw = files[drawingPath];
        if (!drawingRaw) continue;
        const drawing = stripPrefixes(decoder.decode(drawingRaw));
        const chartByRid = relTargets(
          files,
          drawingPath.replace(/\/([^/]+)$/, '/_rels/$1.rels'),
          '/chart',
          drawingPath,
        );
        const anchors = [
          ...elements(drawing, 'twoCellAnchor').map((a) => ({ anchor: a, oneCell: false })),
          ...elements(drawing, 'oneCellAnchor').map((a) => ({ anchor: a, oneCell: true })),
        ];
        for (const { anchor, oneCell } of anchors) {
          const from = element(anchor, 'from');
          const to = element(anchor, 'to');
          const chartTag = /<chart\b[^>]*>/.exec(anchor)?.[0] ?? '';
          const rid = attr(chartTag, 'r:id');
          if (!from || !rid) continue;
          const chartPath = chartByRid.get(rid);
          const chartRaw = chartPath ? files[chartPath] : undefined;
          if (!chartRaw) continue;
          const parsed = parseChartPart(decoder.decode(chartRaw));
          if (!parsed) continue;
          const fromCol = intChild(from, 'col') ?? 0;
          const fromRow = intChild(from, 'row') ?? 0;
          // Sub-cell offsets (#125 round-trip): xdr:from/xdr:to colOff/
          // rowOff in EMUs; absent = 0. Only twoCellAnchor carries a
          // `to` with offsets; oneCellAnchor extents have none.
          const fromColOff = intChild(from, 'colOff') ?? 0;
          const fromRowOff = intChild(from, 'rowOff') ?? 0;
          const toColOff = to ? (intChild(to, 'colOff') ?? 0) : 0;
          const toRowOff = to ? (intChild(to, 'rowOff') ?? 0) : 0;
          // twoCellAnchor carries an explicit `to`; oneCellAnchor only has
          // an <ext> size in EMUs (9525 EMU = 1px; ~64px/col, ~20px/row).
          let toCol = fromCol + 1;
          let toRow = fromRow + 1;
          if (!oneCell && to) {
            toCol = intChild(to, 'col') ?? toCol;
            toRow = intChild(to, 'row') ?? toRow;
          } else if (oneCell) {
            const ext = /<ext\b[^>]*>/.exec(anchor)?.[0] ?? '';
            const cx = Number(attr(ext, 'cx') ?? '0');
            const cy = Number(attr(ext, 'cy') ?? '0');
            if (Number.isFinite(cx) && cx > 0) toCol = fromCol + Math.max(1, Math.round(cx / 9525 / 64));
            if (Number.isFinite(cy) && cy > 0) toRow = fromRow + Math.max(1, Math.round(cy / 9525 / 20));
          } else {
            continue;
          }
          out.push({
            sheetIndex,
            sheetName,
            kind: parsed.kind,
            barDir: parsed.barDir,
            ofPieType: parsed.ofPieType,
            title: parsed.title || parsed.series[0]?.name || '',
            series: parsed.series,
            pivotSource: parsed.pivotSource,
            plotTypes: parsed.plotTypes,
            secondaryAxis: parsed.secondaryAxis,
            anchor: {
              fromCol: Math.max(0, fromCol),
              fromRow: Math.max(0, fromRow),
              toCol: Math.max(0, toCol),
              toRow: Math.max(0, toRow),
              ...(fromColOff ? { fromColOff } : {}),
              ...(fromRowOff ? { fromRowOff } : {}),
              ...(toColOff ? { toColOff } : {}),
              ...(toRowOff ? { toRowOff } : {}),
            },
          });
        }
      }
    });
  } catch {
    // Best-effort: chart import must never break the open.
  }
  return out;
}
