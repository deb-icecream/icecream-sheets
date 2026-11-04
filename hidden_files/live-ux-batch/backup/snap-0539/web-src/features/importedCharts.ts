/**
 * Imported drawingML chart → native ChartSpec conversion.
 *
 * The xlsx-adapter extracts every embedded chart (kind, series formulas,
 * anchor) into metadata; this module maps the OOXML kinds to real ChartKind
 * ids and turns series range formulas into ChartRange specs the existing
 * floating-overlay renderer can paint.
 *
 * User-locked requirement (2026-10-18): NO chart type may be silently
 * dropped. Every `c:*Chart` plotArea child maps to the closest ChartKind;
 * the fallback is 'column-clustered', never a skip.
 */
import {
  isPivotChartFileBinding,
  makeChartSpec,
  pivotBindingFromFile,
  pivotBindingToFile,
  type ChartKind,
  type ChartRange,
  type ChartSeries,
  type ChartSeriesRange,
  type ChartSpec,
  type TrendlineSpec,
} from '@icecream-sheets/service';
import type { ImportedChart, ImportedChartSeriesTrendline } from '@icecream-sheets/xlsx-adapter';
import type { DefinedName } from '@icecream-sheets/engine';

/**
 * Map an imported drawingML trendline to a native TrendlineSpec bound to
 * the given dataset index. Returns null for unknown types (never throws).
 */
export function importedTrendlineToSpec(
  t: ImportedChartSeriesTrendline,
  datasetIndex: number,
): TrendlineSpec | null {
  const allowed: TrendlineSpec['type'][] = [
    'linear',
    'exponential',
    'logarithmic',
    'polynomial',
    'power',
    'movingAverage',
  ];
  if (!allowed.includes(t.type)) return null;
  const spec: TrendlineSpec = { type: t.type, seriesIndex: datasetIndex };
  if (t.name) spec.label = t.name;
  if (t.order !== undefined) spec.order = t.order;
  if (t.period !== undefined) spec.period = t.period;
  if (t.forward) spec.forward = t.forward;
  if (t.backward) spec.backward = t.backward;
  if (t.intercept !== undefined) spec.intercept = t.intercept;
  if (t.displayEquation) spec.displayEquation = true;
  if (t.displayRSquared) spec.displayRSquared = true;
  return spec;
}

/**
 * Map a raw OOXML plotArea child name (e.g. 'barChart', 'line3DChart',
 * 'ofPieChart') to a real ChartKind id. Never throws; unknown kinds fall
 * back to 'column-clustered' (never skipped).
 */
export function ooxmlKindToChartKind(
  kind: string,
  barDir?: string,
  ofPieType?: string,
  plotTypes?: string[],
  secondaryAxis?: boolean,
): ChartKind {
  const isBar = barDir === 'bar';
  // Real combo charts (e.g. clustered column + line, the line on the
  // secondary axis): the renderer draws the last dataset as the line.
  const combo = plotTypes ?? [kind];
  if (combo.length > 1) {
    const hasBarCol = combo.includes('barChart') && !isBar;
    const hasLine = combo.some((c) => c === 'lineChart' || c === 'line3DChart');
    if (hasBarCol && hasLine) {
      return secondaryAxis ? 'combo-column-line-2axis' : 'combo-column-line';
    }
  }
  switch (kind) {
    case 'barChart':
      return isBar ? 'bar-clustered' : 'column-clustered';
    case 'bar3DChart':
      return isBar ? 'bar-3d-clustered' : 'column-3d-clustered';
    case 'lineChart':
      return 'line';
    case 'line3DChart':
      return 'line-3d';
    case 'pieChart':
      return 'pie';
    case 'pie3DChart':
      return 'pie-3d';
    case 'areaChart':
      return 'area';
    case 'area3DChart':
      return 'area-3d';
    case 'scatterChart':
      return 'scatter';
    case 'doughnutChart':
      return 'doughnut';
    case 'radarChart':
      return 'radar';
    case 'bubbleChart':
      return 'bubble';
    case 'stockChart':
      return 'stock-ohlc';
    case 'surfaceChart':
    case 'surface3DChart':
      return 'surface-3d';
    case 'ofPieChart':
      if (ofPieType === 'bar') return 'bar-of-pie';
      if (ofPieType === 'pie') return 'pie-of-pie';
      return 'pie';
    default:
      // Any other *Chart child: closest kind, never a silent drop.
      return 'column-clustered';
  }
}

export interface ParsedRangeFormula {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Parse a series formula like `'INCOME STATEMENT'!$C$6:$I$6` or
 * `Sheet1!$B$2:$B$13` into a 0-based range. Handles quoted sheet names with
 * doubled single-quotes (`'Bob''s Sheet'!$A$1`). Returns null when the
 * formula is not a plain rectangular A1 range.
 */
export function parseRangeFormula(formula: string): ParsedRangeFormula | null {
  const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/i.exec(
    formula.trim(),
  );
  if (!m) return null;
  const sheet = (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]).trim();
  const startCol = colLettersToIndex(m[3]);
  const startRow = parseInt(m[4], 10) - 1;
  const endCol = colLettersToIndex(m[5]);
  const endRow = parseInt(m[6], 10) - 1;
  if (
    !sheet ||
    startCol < 0 || endCol < 0 ||
    startRow < 0 || endRow < 0 ||
    startCol > endCol || startRow > endRow
  ) {
    return null;
  }
  return { sheet, startRow, startCol, endRow, endCol };
}

/**
 * Context for resolving defined-name references in chart series formulas.
 * Chart series formulas (`<c:f>`) may reference workbook/sheet-scoped
 * defined names instead of plain A1 ranges — including dynamic names built
 * on OFFSET/COUNTA. Excel resolves them to ranges when rendering; the
 * importer must do the same, otherwise every such chart is silently
 * dropped (violates the no-silent-drop rule in this module's header).
 */
export interface ChartNameResolutionContext {
  /** Defined names from the opened workbook (adapter `definedNames`). */
  definedNames: DefinedName[];
  /** Sheet names in workbook order (for sheet-scoped names). */
  sheetNames: string[];
  /**
   * Count of non-empty cells in a 0-based column of a sheet (COUNTA
   * semantics: any cell holding a value — number, text, boolean, error —
   * counts; truly blank cells do not).
   */
  countNonEmpty: (sheet: string, col: number) => number;
}

/** `Sheet1!$B$3` (or bare `$B$3`, resolved against `defaultSheet`). */
function parseCellFormula(formula: string, defaultSheet: string): ParsedRangeFormula | null {
  const m = /^(?:'((?:[^']|'')+)'|([^'!]+))?!?\$?([A-Z]{1,3})\$?(\d+)$/i.exec(formula.trim());
  if (!m) return null;
  const sheet = (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] ?? defaultSheet).trim() || defaultSheet;
  const col = colLettersToIndex(m[3]);
  const row = parseInt(m[4], 10) - 1;
  if (!sheet || col < 0 || row < 0) return null;
  return { sheet, startRow: row, startCol: col, endRow: row, endCol: col };
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * Evaluate a dimension argument of an OFFSET defined name: a plain integer,
 * or `COUNTA(<column range>)[+-k]` (the standard dynamic-range idiom).
 */
function evalOffsetDimension(
  expr: string,
  defaultSheet: string,
  ctx: ChartNameResolutionContext,
): number | null {
  const t = expr.trim();
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  const cm = /^COUNTA\((.+)\)([+-]\d+)?$/i.exec(t);
  if (!cm) return null;
  const inner = cm[1].trim();
  const colm = /^(?:'((?:[^']|'')+)'|([^'!]+))?!?\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/i.exec(inner);
  if (!colm || colm[3].toUpperCase() !== colm[4].toUpperCase()) return null;
  const sheet = (colm[1] !== undefined ? colm[1].replace(/''/g, "'") : colm[2] ?? defaultSheet).trim() || defaultSheet;
  const col = colLettersToIndex(colm[3]);
  if (col < 0) return null;
  const adjust = cm[2] ? parseInt(cm[2], 10) : 0;
  return ctx.countNonEmpty(sheet, col) + adjust;
}

/**
 * Resolve one defined-name `ref` to a range. Handles plain A1 refs
 * (qualified or bare) and the OFFSET dynamic-range idiom
 * `OFFSET(base, rows, cols, height, width)` where height/width may be
 * integers or COUNTA expressions. Returns null when the ref cannot be
 * resolved to a concrete range.
 */
function resolveDefinedNameRef(
  ref: string,
  defaultSheet: string,
  ctx: ChartNameResolutionContext,
  depth: number,
): ParsedRangeFormula | null {
  const t = ref.trim().replace(/^=/, '');
  if (!t || /#REF!/.test(t)) return null;
  // Bare name → name chain (depth-limited).
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t) && depth > 0) {
    const next = ctx.definedNames.find((d) => d.name.toLowerCase() === t.toLowerCase());
    if (next && next !== undefined) return resolveDefinedNameRef(next.ref, defaultSheet, ctx, depth - 1);
    return null;
  }
  // Plain A1 range, qualified or bare (bare binds to the series' sheet).
  const qualified = t.includes('!') ? t : `${defaultSheet}!${t}`;
  const plain = parseRangeFormula(qualified);
  if (plain) return plain;
  const single = parseCellFormula(qualified, defaultSheet);
  if (single) return single;
  // OFFSET(base, rows, cols[, height[, width]]).
  const om = /^OFFSET\((.*)\)$/i.exec(t);
  if (!om) return null;
  const args = splitTopLevel(om[1]).map((a) => a.trim());
  // OFFSET(reference, rows, cols[, height[, width]]); height/width default to 1.
  if (args.length < 3 || args.length > 5) return null;
  const baseT = args[0].includes('!') ? args[0] : `${defaultSheet}!${args[0]}`;
  const base = parseCellFormula(baseT, defaultSheet);
  if (!base) return null;
  if (!/^[+-]?\d+$/.test(args[1]) || !/^[+-]?\d+$/.test(args[2])) return null;
  const dRow = parseInt(args[1], 10);
  const dCol = parseInt(args[2], 10);
  let height = 1;
  let width = 1;
  if (args.length >= 4) {
    const h = evalOffsetDimension(args[3], base.sheet, ctx);
    if (h === null) return null;
    height = h;
  }
  if (args.length === 5) {
    const w = evalOffsetDimension(args[4], base.sheet, ctx);
    if (w === null) return null;
    width = w;
  }
  const startRow = base.startRow + dRow;
  const startCol = base.startCol + dCol;
  if (startRow < 0 || startCol < 0 || height < 1 || width < 1) return null;
  return {
    sheet: base.sheet,
    startRow,
    startCol,
    endRow: startRow + height - 1,
    endCol: startCol + width - 1,
  };
}

/**
 * Resolve a chart series formula to a range. Plain A1 formulas resolve
 * directly; `Sheet!DefinedName` formulas resolve through the workbook's
 * defined names (plain A1 names and OFFSET/COUNTA dynamic names). Returns
 * null when the formula cannot be resolved to a concrete range.
 */
export function resolveSeriesFormula(
  formula: string,
  ctx?: ChartNameResolutionContext,
): ParsedRangeFormula | null {
  const direct = parseRangeFormula(formula);
  if (direct) return direct;
  if (!ctx) return null;
  const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!([A-Za-z_][A-Za-z0-9_.]*)$/.exec(formula.trim());
  if (!m) return null;
  const sheet = (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]).trim();
  const name = m[3].toLowerCase();
  if (!sheet || !name) return null;
  // Sheet-scoped names shadow workbook-scoped ones on their own sheet.
  const scoped = ctx.definedNames.find(
    (d) =>
      d.name.toLowerCase() === name &&
      d.sheet !== undefined &&
      ctx.sheetNames[d.sheet]?.toLowerCase() === sheet.toLowerCase(),
  );
  const dn =
    scoped ??
    ctx.definedNames.find((d) => d.name.toLowerCase() === name && d.sheet === undefined);
  if (!dn) return null;
  return resolveDefinedNameRef(dn.ref, sheet, ctx, 5);
}

/**
 * Build per-series data ranges (and trendlines) from an imported chart's
 * series formulas. Shared by the regular path and the pivot-chart path:
 * pivot charts also carry real cell-range series formulas (Excel writes
 * them against the pivot table's sheet cells), which the renderer uses as
 * a fallback when the bound pivot has no computed data (e.g. its cache
 * was saved with saveData="0").
 */
export function importedSeriesRanges(
  chart: ImportedChart,
  sheetNames?: string[],
  nameCtx?: ChartNameResolutionContext,
): { seriesRanges: ChartSeriesRange[]; trendlines: TrendlineSpec[] } {
  const canonical = (s: string): string => {
    if (sheetNames) {
      const hit = sheetNames.find((n) => n.toLowerCase() === s.toLowerCase());
      if (hit) return hit;
    }
    return s;
  };
  const toRange = (p: ParsedRangeFormula): ChartRange => ({
    sheet: canonical(p.sheet),
    startRow: p.startRow,
    startCol: p.startCol,
    endRow: p.endRow,
    endCol: p.endCol,
  });

  const seriesRanges: ChartSeriesRange[] = [];
  const trendlines: TrendlineSpec[] = [];
  for (const s of chart.series) {
    if (!s.valFormula) continue;
    // Series formulas may reference defined names (incl. OFFSET/COUNTA
    // dynamic names) — resolve them exactly as Excel does when rendering.
    const val = resolveSeriesFormula(s.valFormula, nameCtx);
    if (!val) continue;
    let cat: ChartRange | null = null;
    if (s.catFormula) {
      const c = resolveSeriesFormula(s.catFormula, nameCtx);
      if (c) cat = toRange(c);
    }
    const datasetIndex = seriesRanges.length;
    seriesRanges.push({ name: s.name || '', cat, val: toRange(val) });
    // Carry Excel trendlines onto the matching dataset (Format Trendline).
    for (const t of s.trendlines ?? []) {
      const spec = importedTrendlineToSpec(t, datasetIndex);
      if (spec) trendlines.push(spec);
    }
  }
  return { seriesRanges, trendlines };
}

/**
 * First-paint ChartSeries from the chart part's own cached points
 * (strCache/numCache — Excel's own pre-recalc rendering). Labels come
 * from the first series carrying a category cache; datasets from every
 * series carrying a value cache. Returns undefined when the file cached
 * no values at all (then first paint simply waits for live values).
 */
export function cachedSeriesFromChart(chart: ImportedChart): ChartSeries | undefined {
  const withValues = chart.series.filter((s) => s.valCache && s.valCache.length > 0);
  if (withValues.length === 0) return undefined;
  const cat = chart.series.find((s) => s.catCache && s.catCache.length > 0)?.catCache ?? [];
  const labels = withValues[0]!.valCache!.map((_, i) => {
    const c = cat[i];
    return c === null || c === undefined ? '' : String(c);
  });
  return {
    labels,
    datasets: withValues.map((s) => ({ label: s.name || '', data: [...s.valCache!] })),
  };
}

/**
 * Convert one imported chart to a full ChartSpec, or null when none of its
 * series has a parseable value range (a broken spec must never be created).
 *
 * Per-series ranges are kept verbatim — NO unioning: Excel charts reference
 * non-contiguous per-series ranges, and unioning them into one block makes
 * the extractor misread unrelated cells as headers/labels. The renderer
 * builds the ChartSeries directly from `seriesRanges`, bypassing
 * `extractSeries`. `range` is still populated (union of val ranges,
 * best-effort) for consumers that only understand a single range.
 *
 * Position/size come from the drawingML anchor; `anchorCells` lets the
 * overlay layer position the chart live in grid content coordinates.
 */
export function importedChartToSpec(
  chart: ImportedChart,
  id: number,
  sheetNames?: string[],
  nameCtx?: ChartNameResolutionContext,
): ChartSpec | null {
  const { seriesRanges, trendlines } = importedSeriesRanges(chart, sheetNames, nameCtx);
  if (seriesRanges.length === 0) return null;

  // Compat union of the value ranges (best-effort; renderer prefers seriesRanges).
  // NOTE: `range.sheet` is the chart's ANCHOR sheet (where the drawing
  // lives) — the overlay layer filters charts by it. The per-series data
  // sheets are kept verbatim in seriesRanges.
  let startRow = Infinity;
  let startCol = Infinity;
  let endRow = -Infinity;
  let endCol = -Infinity;
  let unionSheet = seriesRanges[0].val.sheet;
  for (const sr of seriesRanges) {
    const r = sr.val;
    if (r.sheet.toLowerCase() !== unionSheet.toLowerCase()) continue;
    startRow = Math.min(startRow, r.startRow);
    startCol = Math.min(startCol, r.startCol);
    endRow = Math.max(endRow, r.endRow);
    endCol = Math.max(endCol, r.endCol);
  }
  const range: ChartRange = { sheet: chart.sheetName, startRow, startCol, endRow, endCol };

  const a = chart.anchor;
  // plotTypes/secondaryAxis may be absent in metadata written before they
  // existed — fall back to the single-kind contract.
  const plotTypes = chart.plotTypes && chart.plotTypes.length > 0 ? chart.plotTypes : [chart.kind];
  return makeChartSpec({
    id,
    kind: ooxmlKindToChartKind(chart.kind, chart.barDir, chart.ofPieType, plotTypes, chart.secondaryAxis ?? false),
    range,
    seriesRanges,
    cachedSeries: cachedSeriesFromChart(chart),
    trendlines: trendlines.length > 0 ? trendlines : undefined,
    // Backed by a real native part in the package (FIX-G trace §4.1e):
    // excluded from the icecream.chartspecs metadata writer.
    nativePart: true,
    title: chart.title || `${chart.kind} chart`,
    // Fallback px geometry (also used where the grid metric mapping is
    // unavailable); the live position comes from anchorCells.
    x: a.fromCol * 64,
    y: a.fromRow * 20,
    w: Math.max(240, (a.toCol - a.fromCol) * 64),
    h: Math.max(180, (a.toRow - a.fromRow) * 20),
    anchorCells: {
      fromCol: a.fromCol,
      fromRow: a.fromRow,
      toCol: a.toCol,
      toRow: a.toRow,
    },
  });
}

/**
 * Convert an imported pivot chart (drawingML with <c:pivotSource>) into a
 * pivot-bound ChartSpec. The series are re-derived from the live pivot
 * result on every render (see ChartOverlay's getPivotSeries/pivotVersion),
 * so the chart stays in sync when the pivot refreshes or a slicer changes.
 *
 * The chart's own series formulas are ALSO baked into `seriesRanges`:
 * when the bound pivot has no computed data (e.g. its cache was saved
 * with saveData="0", as in real-world model files), the overlay falls
 * back to these cached ranges instead of showing an error. Live pivot
 * data always wins when it exists.
 *
 * `range.sheet` is the chart's anchor sheet (where the drawing lives —
 * often a Dashboard, not the pivot's sheet); the overlay layer filters
 * charts by it. Each seriesRange keeps its own sheet.
 */
export function importedPivotChartToSpec(
  chart: ImportedChart,
  pivot: {
    id: number;
    title: string;
    sourceSheet: string;
    sourceRange: { startRow: number; startCol: number; endRow: number; endCol: number };
  },
  id: number,
  sheetNames?: string[],
  nameCtx?: ChartNameResolutionContext,
): ChartSpec {
  const a = chart.anchor;
  const { seriesRanges, trendlines } = importedSeriesRanges(chart, sheetNames, nameCtx);
  return makeChartSpec({
    id,
    kind: ooxmlKindToChartKind(chart.kind, chart.barDir, chart.ofPieType),
    range: { ...pivot.sourceRange, sheet: chart.sheetName },
    title: chart.title || `PivotChart of ${pivot.title}`,
    pivot: { pivotId: pivot.id, valueIndex: 0 },
    seriesRanges: seriesRanges.length > 0 ? seriesRanges : undefined,
    nativePart: true,
    cachedSeries: cachedSeriesFromChart(chart),
    trendlines: trendlines.length > 0 ? trendlines : undefined,
    // Fallback px geometry; the live position comes from anchorCells.
    x: a.fromCol * 64,
    y: a.fromRow * 20,
    w: Math.max(240, (a.toCol - a.fromCol) * 64),
    h: Math.max(180, (a.toRow - a.fromRow) * 20),
    anchorCells: {
      fromCol: a.fromCol,
      fromRow: a.fromRow,
      toCol: a.toCol,
      toRow: a.toRow,
    },
  });
}

/**
 * Parse the `icecream.charts` metadata value into ImportedChart[].
 * Returns [] for missing/corrupt metadata (never throws).
 */
export function importedChartsFromMetadata(value: unknown): ImportedChart[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is ImportedChart =>
        !!c && typeof c === 'object' &&
        typeof (c as ImportedChart).kind === 'string' &&
        typeof (c as ImportedChart).sheetName === 'string' &&
        Array.isArray((c as ImportedChart).series),
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// App-authored chart persistence (save → .xlsx → open round-trip).
// ---------------------------------------------------------------------------

/**
 * Metadata key carrying the app's own chart specs (overlays the user
 * created, including pivot-bound PivotCharts). The xlsx-adapter persists
 * `icecream.*` metadata as custom properties, so these survive the
 * save/reopen round trip. Pivot bindings are stored by pivot NAME
 * (session-local ids would be meaningless after reopen).
 */
export const CHART_SPECS_METADATA_KEY = 'icecream.chartspecs';

/**
 * Serialize chart specs for the save path. Pivot-bound charts keep their
 * binding in name form; charts whose pivot has no name keep a live binding
 * that simply won't resolve on open (the renderer shows a "pivot no longer
 * exists" error rather than inventing data).
 */
export function pivotChartSpecsToMetadata(
  charts: ChartSpec[],
  pivotNameOf: (pivotId: number) => string | undefined,
): string {
  // FIX-G hygiene (trace §4.1e): nativePart specs are persisted by
  // their real chart part, not by this metadata channel — carrying a
  // twin here would render a duplicate overlay on reopen (the imported
  // twin gets a fresh id at load, defeating the by-id merge).
  const stored = charts
    .filter((c) => !c.nativePart)
    .map((c) => {
    if (!c.pivot) return c;
    const file = pivotBindingToFile(c.pivot, pivotNameOf(c.pivot.pivotId));
    // Keep the chart even when the name is unknown — the id binding stays
    // as a hint but will not resolve on open (honest error, no silent drop).
    return { ...c, pivot: file ?? c.pivot };
  });
  return JSON.stringify(stored);
}

/**
 * Restore chart specs saved by pivotChartSpecsToMetadata. Name-based pivot
 * bindings resolve to this session's pivot ids; a binding whose pivot is
 * absent keeps the chart (the renderer reports the missing pivot). Returns
 * [] for missing/corrupt metadata (never throws).
 */
export function pivotChartSpecsFromMetadata(
  value: unknown,
  pivotIdOf: (pivotName: string) => number | undefined,
): ChartSpec[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ChartSpec[] = [];
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const c = raw as Partial<ChartSpec> & { pivot?: unknown };
    if (typeof c.kind !== 'string' || typeof c.id !== 'number') continue;
    if (typeof c.range !== 'object' || c.range === null) continue;
    let pivot = c.pivot;
    if (isPivotChartFileBinding(pivot)) {
      const resolved = pivotBindingFromFile(pivot, pivotIdOf(pivot.pivotName));
      // Keep the chart with an unresolvable binding dropped to undefined —
      // the renderer shows the missing-pivot error instead of wrong data.
      pivot = resolved;
    } else if (pivot !== undefined) {
      // A live id binding from another session is meaningless — drop it.
      pivot = undefined;
    }
    out.push({ ...(c as ChartSpec), pivot });
  }
  return out;
}
