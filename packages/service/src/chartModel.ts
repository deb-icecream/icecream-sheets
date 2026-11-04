/**
 * Chart component core — the native reporting/visuals component.
 *
 * Follows design-docs/native-reports-and-dashboards.md:
 * - Charts are a versioned, serializable spec (data bindings, visuals, layout).
 * - The component reads ONLY through the typed computational view, via the
 *   CellReader adapter. It never touches the engine or storage directly.
 * - Specs live in the service metadata store (see chartStore.ts).
 *
 * Follows design-docs/connector-vs-component.md: this is a native component
 * (first-party code); chart.js is a rendering library, not a service.
 *
 * This module is pure and headless: no DOM, no React, no engine imports, so
 * it is fully unit-testable under vitest/node.
 */
import type { ChartConfiguration, Plugin } from 'chart.js';
import type { TrendlineSpec } from './trendline.js';
import type { PivotChartBinding } from './pivotChart.js';

/** Current version of the serialized ChartSpec. Bump when the shape changes. */
export const CHART_SPEC_VERSION = 2;

/** Every chart kind, mirroring the Excel Insert-tab chart galleries. */
export type ChartKind =
  | 'column-clustered'
  | 'column-stacked'
  | 'column-stacked100'
  | 'column-3d-clustered'
  | 'column-3d-stacked'
  | 'column-3d-stacked100'
  | 'column-3d'
  | 'line'
  | 'line-stacked'
  | 'line-stacked100'
  | 'line-markers'
  | 'line-stacked-markers'
  | 'line-stacked100-markers'
  | 'line-3d'
  | 'line-smooth'
  | 'pie'
  | 'pie-3d'
  | 'pie-of-pie'
  | 'bar-of-pie'
  | 'doughnut'
  | 'bar-clustered'
  | 'bar-stacked'
  | 'bar-stacked100'
  | 'bar-3d-clustered'
  | 'bar-3d-stacked'
  | 'bar-3d-stacked100'
  | 'area'
  | 'area-stacked'
  | 'area-stacked100'
  | 'area-3d'
  | 'area-3d-stacked'
  | 'area-3d-stacked100'
  | 'scatter'
  | 'scatter-smooth'
  | 'scatter-lines'
  | 'scatter-lines-markers'
  | 'scatter-smooth-markers'
  | 'bubble'
  | 'bubble-3d'
  | 'map-filled'
  | 'stock-hlc'
  | 'stock-ohlc'
  | 'stock-volume-hlc'
  | 'stock-volume-ohlc'
  | 'surface-3d'
  | 'surface-3d-wireframe'
  | 'contour'
  | 'contour-wireframe'
  | 'histogram'
  | 'pareto'
  | 'boxplot'
  | 'treemap'
  | 'sunburst'
  | 'waterfall'
  | 'radar'
  | 'radar-markers'
  | 'radar-filled'
  | 'funnel'
  | 'combo-column-line'
  | 'combo-column-line-2axis'
  | 'combo-stacked-area-column';

export interface ChartKindEntry {
  id: ChartKind;
  label: string;
}

export interface ChartGroup {
  id: string;
  label: string;
  kinds: ChartKindEntry[];
}

/** Excel Insert-tab chart galleries, in Excel's order. */
export const CHART_GROUPS: ChartGroup[] = [
  {
    id: 'column',
    label: 'Column',
    kinds: [
      { id: 'column-clustered', label: 'Clustered Column' },
      { id: 'column-stacked', label: 'Stacked Column' },
      { id: 'column-stacked100', label: '100% Stacked Column' },
      { id: 'column-3d-clustered', label: '3-D Clustered Column' },
      { id: 'column-3d-stacked', label: '3-D Stacked Column' },
      { id: 'column-3d-stacked100', label: '3-D 100% Stacked Column' },
      { id: 'column-3d', label: '3-D Column' },
    ],
  },
  {
    id: 'line',
    label: 'Line',
    kinds: [
      { id: 'line', label: 'Line' },
      { id: 'line-stacked', label: 'Stacked Line' },
      { id: 'line-stacked100', label: '100% Stacked Line' },
      { id: 'line-markers', label: 'Line with Markers' },
      { id: 'line-stacked-markers', label: 'Stacked Line with Markers' },
      { id: 'line-stacked100-markers', label: '100% Stacked Line with Markers' },
      { id: 'line-3d', label: '3-D Line' },
      { id: 'line-smooth', label: 'Smoothed Line' },
    ],
  },
  {
    id: 'pie',
    label: 'Pie',
    kinds: [
      { id: 'pie', label: 'Pie' },
      { id: 'pie-3d', label: '3-D Pie' },
      { id: 'pie-of-pie', label: 'Pie of Pie' },
      { id: 'bar-of-pie', label: 'Bar of Pie' },
      { id: 'doughnut', label: 'Doughnut' },
    ],
  },
  {
    id: 'bar',
    label: 'Bar',
    kinds: [
      { id: 'bar-clustered', label: 'Clustered Bar' },
      { id: 'bar-stacked', label: 'Stacked Bar' },
      { id: 'bar-stacked100', label: '100% Stacked Bar' },
      { id: 'bar-3d-clustered', label: '3-D Clustered Bar' },
      { id: 'bar-3d-stacked', label: '3-D Stacked Bar' },
      { id: 'bar-3d-stacked100', label: '3-D 100% Stacked Bar' },
    ],
  },
  {
    id: 'area',
    label: 'Area',
    kinds: [
      { id: 'area', label: 'Area' },
      { id: 'area-stacked', label: 'Stacked Area' },
      { id: 'area-stacked100', label: '100% Stacked Area' },
      { id: 'area-3d', label: '3-D Area' },
      { id: 'area-3d-stacked', label: '3-D Stacked Area' },
      { id: 'area-3d-stacked100', label: '3-D 100% Stacked Area' },
    ],
  },
  {
    id: 'scatter',
    label: 'Scatter',
    kinds: [
      { id: 'scatter', label: 'Scatter with only Markers' },
      { id: 'scatter-smooth', label: 'Scatter with Smooth Lines' },
      { id: 'scatter-lines', label: 'Scatter with Straight Lines' },
      { id: 'scatter-lines-markers', label: 'Scatter with Straight Lines and Markers' },
      { id: 'scatter-smooth-markers', label: 'Scatter with Smooth Lines and Markers' },
      { id: 'bubble', label: 'Bubble' },
      { id: 'bubble-3d', label: '3-D Bubble' },
    ],
  },
  {
    id: 'map',
    label: 'Map',
    kinds: [{ id: 'map-filled', label: 'Filled Map' }],
  },
  {
    id: 'stock',
    label: 'Stock',
    kinds: [
      { id: 'stock-hlc', label: 'High-Low-Close' },
      { id: 'stock-ohlc', label: 'Open-High-Low-Close' },
      { id: 'stock-volume-hlc', label: 'Volume-High-Low-Close' },
      { id: 'stock-volume-ohlc', label: 'Volume-Open-High-Low-Close' },
    ],
  },
  {
    id: 'surface',
    label: 'Surface',
    kinds: [
      { id: 'surface-3d', label: '3-D Surface' },
      { id: 'surface-3d-wireframe', label: 'Wireframe 3-D Surface' },
      { id: 'contour', label: 'Contour' },
      { id: 'contour-wireframe', label: 'Wireframe Contour' },
    ],
  },
  {
    id: 'statistical',
    label: 'Statistical',
    kinds: [
      { id: 'histogram', label: 'Histogram' },
      { id: 'pareto', label: 'Pareto' },
      { id: 'boxplot', label: 'Box and Whisker' },
    ],
  },
  {
    id: 'combo',
    label: 'Combo',
    kinds: [
      { id: 'combo-column-line', label: 'Clustered Column – Line' },
      { id: 'combo-column-line-2axis', label: 'Clustered Column – Line on Secondary Axis' },
      { id: 'combo-stacked-area-column', label: 'Stacked Area – Clustered Column' },
    ],
  },
  {
    id: 'other',
    label: 'Other Charts',
    kinds: [
      { id: 'treemap', label: 'Treemap' },
      { id: 'sunburst', label: 'Sunburst' },
      { id: 'waterfall', label: 'Waterfall' },
      { id: 'radar', label: 'Radar' },
      { id: 'radar-markers', label: 'Radar with Markers' },
      { id: 'radar-filled', label: 'Filled Radar' },
      { id: 'funnel', label: 'Funnel' },
    ],
  },
];

/**
 * Excel 3-D chart kinds render as their 2-D counterparts. chart.js has no
 * 3-D rendering pipeline (no depth axis, no extrusion), so true 3-D visuals
 * are not possible with the current renderer. The spec preserves the real
 * 3-D kind — `buildChartConfig` reports it via `BuiltConfig.renderedAs` —
 * so a future WebGL/3-D renderer can pick the kind up and render it
 * faithfully without any spec migration.
 */
export const THREE_D_FALLBACK: Record<string, ChartKind> = {
  'column-3d-clustered': 'column-clustered',
  'column-3d-stacked': 'column-stacked',
  'column-3d-stacked100': 'column-stacked100',
  'column-3d': 'column-clustered',
  'line-3d': 'line',
  'pie-3d': 'pie',
  'bar-3d-clustered': 'bar-clustered',
  'bar-3d-stacked': 'bar-stacked',
  'bar-3d-stacked100': 'bar-stacked100',
  'area-3d': 'area',
  'area-3d-stacked': 'area-stacked',
  'area-3d-stacked100': 'area-stacked100',
  'bubble-3d': 'bubble',
};

/** True when the kind is an Excel 3-D chart rendered via its 2-D fallback. */
export function is3DKind(kind: ChartKind): boolean {
  return Object.prototype.hasOwnProperty.call(THREE_D_FALLBACK, kind);
}

/**
 * Excel parity status per kind. Every enumerated kind is renderable: the
 * filled map's geographic boundaries ship bundled (see mapGeometry.ts), so
 * there are currently no out-of-scope kinds. The record is kept (empty) so
 * any future enumerated-but-unrenderable kind has a documented home, and
 * buildChartConfig keeps its honest-throw behavior.
 */
export const UNSUPPORTED_KINDS: Record<string, string> = {};

/** True when the kind is enumerated but explicitly out of scope for rendering. */
export function isUnsupportedKind(kind: ChartKind): boolean {
  return Object.prototype.hasOwnProperty.call(UNSUPPORTED_KINDS, kind);
}

export function kindLabel(kind: ChartKind): string {
  for (const g of CHART_GROUPS) {
    const found = g.kinds.find((k) => k.id === kind);
    if (found) return found.label;
  }
  return kind;
}

export function groupLabelForKind(kind: ChartKind): string {
  for (const g of CHART_GROUPS) {
    if (g.kinds.some((k) => k.id === kind)) return g.label;
  }
  return '';
}

export interface ChartRange {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export type LegendPosition = 'top' | 'bottom' | 'left' | 'right' | 'none';

/** One imported chart series: its own category + value ranges (any sheet). */
export interface ChartSeriesRange {
  /** Series name from the file (may be ''). */
  name: string;
  /** Category range (single row or single column), or null when absent. */
  cat: ChartRange | null;
  /** Value range. */
  val: ChartRange;
}

/**
 * Versioned, serializable chart spec. Stored in the service metadata store
 * (chartStore.ts), never inside the engine.
 */
export interface ChartSpec {
  version: number;
  id: number;
  kind: ChartKind;
  title: string;
  range: ChartRange;
  xAxisTitle: string;
  yAxisTitle: string;
  legend: LegendPosition;
  dataLabels: boolean;
  /** Trendline overlays (Excel: Format Trendline). */
  trendlines?: TrendlineSpec[];
  /**
   * Pivot binding: when set, the chart derives its series from the live
   * pivot result with this id instead of from `range` (PivotCharts).
   */
  pivot?: PivotChartBinding;
  /** Overlay geometry in px, relative to the grid container. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Cell anchor for the overlay (imported drawingML charts). When present,
   * the web client positions the overlay from these cells via the grid's
   * content-coordinate mapping (colLeft/rowTop) so it scrolls with the
   * cells and follows column/row resizes; x/y/w/h remain as fallback.
   * All indices 0-based.
   */
  anchorCells?: {
    fromCol: number;
    fromRow: number;
    toCol: number;
    toRow: number;
    /**
     * Sub-cell offsets in CSS px (the web's content-coordinate unit),
     * mapped from the file's EMU colOff/rowOff on import (EMU / 9525)
     * and written back as EMU on save (#125). Absent = 0. A moved
     * native chart keeps its anchor (recomputed from its px position)
     * instead of dropping it, so the position survives save/reopen.
     */
    fromColOff?: number;
    fromRowOff?: number;
    toColOff?: number;
    toRowOff?: number;
  };
  /**
   * Per-series data ranges for imported charts (drawingML import). When
   * present, the chart renderer builds the ChartSeries directly from these
   * ranges and bypasses `extractSeries` entirely: Excel charts reference
   * non-contiguous per-series ranges, and unioning them into one contiguous
   * block misreads unrelated cells as headers/labels. Each series keeps its
   * own sheet. `range` is still populated (union, best-effort) for
   * compatibility with consumers that only understand a single range.
   */
  seriesRanges?: ChartSeriesRange[];
  /**
   * First-paint series from the chart part's own cached points
   * (numCache/strCache — what Excel shows before recalc). Cycle 10
   * progressive-display rule: the renderer paints from this cache first
   * when live values are not yet available (engine still loading), then
   * re-renders with live values once they land. Live values always win
   * when they exist — the cache never overrides real data.
   */
  cachedSeries?: ChartSeries;
  /**
   * True when this spec is backed by a REAL native chart part in the
   * workbook package (authored via the xlsx-adapter chart author, or
   * imported from a native part). Such specs must be EXCLUDED from the
   * `icecream.chartspecs` metadata writer: the part itself is the
   * persistence, and carrying a metadata twin would render a duplicate
   * overlay on reopen (trace FIX-F §4.1e).
   */
  nativePart?: boolean;
}

export function makeChartSpec(partial: Partial<ChartSpec> & { kind: ChartKind; range: ChartRange }): ChartSpec {
  return {
    version: CHART_SPEC_VERSION,
    id: partial.id ?? Date.now(),
    kind: partial.kind,
    title: partial.title ?? kindLabel(partial.kind),
    range: partial.range,
    xAxisTitle: partial.xAxisTitle ?? '',
    yAxisTitle: partial.yAxisTitle ?? '',
    legend: partial.legend ?? 'bottom',
    dataLabels: partial.dataLabels ?? false,
    trendlines: partial.trendlines,
    pivot: partial.pivot,
    x: partial.x ?? 120,
    y: partial.y ?? 120,
    w: partial.w ?? 480,
    h: partial.h ?? 320,
    anchorCells: partial.anchorCells,
    seriesRanges: partial.seriesRanges,
    cachedSeries: partial.cachedSeries,
    nativePart: partial.nativePart,
  };
}

/**
 * Adapter over the typed computational view. The chart component calls this
 * to read display text and numeric values; the host wires it to
 * host.getView().readCell(...). The component never imports the engine.
 */
export interface CellReader {
  (row: number, col: number): { text: string; num: number | null };
}

export interface ChartDataset {
  label: string;
  data: (number | null)[];
}

export interface ChartSeries {
  labels: string[];
  datasets: ChartDataset[];
}

const isBlank = (s: string): boolean => s.trim() === '';

/**
 * Extract multi-series chart data using Excel's layout convention:
 * - First row (after the corner) with text becomes the series names.
 * - First column (after the corner) with text becomes the category labels.
 * - The body must be numeric; non-numeric body cells become null gaps.
 */
export function extractSeries(read: CellReader, range: ChartRange): ChartSeries {
  const rows: { text: string; num: number | null }[][] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    const row: { text: string; num: number | null }[] = [];
    for (let c = range.startCol; c <= range.endCol; c++) row.push(read(r, c));
    rows.push(row);
  }
  if (rows.length === 0 || rows[0].length === 0) return { labels: [], datasets: [] };

  const headerRow = rows[0].slice(1).some((cell) => !isBlank(cell.text) && cell.num === null);
  const labelCol = rows.slice(1).some((row) => !isBlank(row[0].text) && row[0].num === null);

  const bodyRows = headerRow ? rows.slice(1) : rows;
  const bodyCols = labelCol ? 1 : 0;

  const labels: string[] = bodyRows.map((row, i) =>
    labelCol ? row[0].text : `Category ${i + 1}`,
  );

  const datasets: ChartDataset[] = [];
  const dataColCount = rows[0].length - bodyCols;
  for (let c = bodyCols; c < rows[0].length; c++) {
    const label = headerRow && !isBlank(rows[0][c].text) ? rows[0][c].text : `Series ${c - bodyCols + 1}`;
    const data = bodyRows.map((row) => row[c].num);
    // Skip entirely-empty columns.
    if (data.every((v) => v === null)) continue;
    void dataColCount;
    datasets.push({ label, data });
  }
  return { labels, datasets };
}

/** Sheet-aware cell reader (for per-series ranges that may span sheets). */
export type SheetCellReader = (
  sheet: string,
  row: number,
  col: number,
) => { text: string; num: number | null };

/**
 * Build a ChartSeries directly from per-series ranges (imported charts).
 * Bypasses `extractSeries` entirely: Excel charts reference non-contiguous
 * per-series ranges, and unioning them into one block misreads unrelated
 * cells as headers/labels.
 *
 * - labels: from the first series with a non-null cat range — across for a
 *   single-row cat, down for a single-column cat; blank cells become
 *   "Category N". Without any cat range, generic labels sized to the data.
 * - one dataset per series, in order: label = series name, else the val
 *   range's header cell text (left of a single-row val, above a
 *   single-column val), else "Series N". Data follows range order;
 *   non-numeric cells become null gaps.
 */
export function extractSeriesFromRanges(
  read: SheetCellReader,
  ranges: ChartSeriesRange[],
): ChartSeries {
  const readRange = (r: ChartRange): { text: string; num: number | null }[][] => {
    const out: { text: string; num: number | null }[][] = [];
    for (let row = r.startRow; row <= r.endRow; row++) {
      const line: { text: string; num: number | null }[] = [];
      for (let col = r.startCol; col <= r.endCol; col++) line.push(read(r.sheet, row, col));
      out.push(line);
    }
    return out;
  };

  let labels: string[] = [];
  const catRange = ranges.map((sr) => sr.cat).find((c): c is ChartRange => c !== null);
  if (catRange) {
    const cells = readRange(catRange);
    const flat =
      catRange.startRow === catRange.endRow
        ? (cells[0] ?? [])
        : cells.map((row) => row[0] ?? { text: '', num: null });
    labels = flat.map((c, i) => (!isBlank(c.text) ? c.text : `Category ${i + 1}`));
  }

  const datasets: ChartDataset[] = [];
  ranges.forEach((sr, si) => {
    const cells = readRange(sr.val);
    const singleRow = sr.val.startRow === sr.val.endRow;
    const vals = singleRow ? (cells[0] ?? []) : cells.map((row) => row[0] ?? { text: '', num: null });
    let label = sr.name.trim();
    if (!label) {
      const header =
        singleRow
          ? sr.val.startCol > 0
            ? read(sr.val.sheet, sr.val.startRow, sr.val.startCol - 1)
            : null
          : sr.val.startRow > 0
            ? read(sr.val.sheet, sr.val.startRow - 1, sr.val.startCol)
            : null;
      label = header && !isBlank(header.text) ? header.text : `Series ${si + 1}`;
    }
    datasets.push({ label, data: vals.map((c) => c.num) });
  });

  if (labels.length === 0) {
    const n = Math.max(0, ...datasets.map((d) => d.data.length));
    labels = Array.from({ length: n }, (_, i) => `Category ${i + 1}`);
  }
  return { labels, datasets };
}

/** Flatten all numeric body values from a range (for histogram / box plot). */
export function numericValues(read: CellReader, range: ChartRange): number[] {
  const out: number[] = [];
  const skipFirstRow = true;
  for (let r = range.startRow + (skipFirstRow ? 1 : 0); r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      const v = read(r, c).num;
      if (v !== null && Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

/** Sturges' rule bin count, clamped to [1, 50]. */
export function sturgesBinCount(n: number): number {
  if (n <= 0) return 1;
  return Math.min(50, Math.max(1, Math.ceil(Math.log2(n) + 1)));
}

export interface Histogram {
  labels: string[];
  counts: number[];
}

/** Bin values into equal-width bins for a histogram. */
export function histogramBins(values: number[], binCount?: number): Histogram {
  if (values.length === 0) return { labels: [], counts: [] };
  const bins = binCount ?? sturgesBinCount(values.length);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { labels: [`${min}`], counts: [values.length] };
  const width = (max - min) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / width));
    counts[idx]++;
  }
  const labels = counts.map((_, i) => {
    const a = min + i * width;
    const b = min + (i + 1) * width;
    return `${round2(a)}–${round2(b)}`;
  });
  return { labels, counts };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface ParetoData {
  labels: string[];
  values: number[];
  cumulativePct: number[];
}

/** Sort descending and compute cumulative percentage (Pareto). */
export function paretoTransform(labels: string[], values: number[]): ParetoData {
  const pairs = labels.map((label, i) => ({ label, value: values[i] ?? 0 }));
  pairs.sort((a, b) => b.value - a.value);
  const total = pairs.reduce((s, p) => s + p.value, 0);
  let running = 0;
  const cumulativePct = pairs.map((p) => {
    running += p.value;
    return total > 0 ? round2((running / total) * 100) : 0;
  });
  return {
    labels: pairs.map((p) => p.label),
    values: pairs.map((p) => p.value),
    cumulativePct,
  };
}

export interface WaterfallData {
  labels: string[];
  /** [start, end] floating segments for each bar. */
  floats: [number, number][];
  /** 'up' | 'down' | 'total' per bar. */
  kinds: ('up' | 'down' | 'total')[];
}

/** Build waterfall floating segments; appends a Total bar. */
export function waterfallSegments(labels: string[], values: number[]): WaterfallData {
  const outLabels = [...labels, 'Total'];
  const floats: [number, number][] = [];
  const kinds: ('up' | 'down' | 'total')[] = [];
  let running = 0;
  values.forEach((v) => {
    const start = running;
    running += v;
    floats.push([Math.min(start, running), Math.max(start, running)]);
    kinds.push(v >= 0 ? 'up' : 'down');
  });
  floats.push([0, running]);
  kinds.push('total');
  return { labels: outLabels, floats, kinds };
}

export interface BoxStats {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return sorted[base] + rest * ((next ?? sorted[base]) - sorted[base]);
}

/** Five-number summary for a box-and-whisker plot. */
export function boxPlotStats(values: number[]): BoxStats | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  return {
    min: clean[0],
    q1: quantile(clean, 0.25),
    median: quantile(clean, 0.5),
    q3: quantile(clean, 0.75),
    max: clean[clean.length - 1],
  };
}

/** Normalize stacked datasets to 100% per category. */
export function toPercentStacked(datasets: ChartDataset[]): ChartDataset[] {
  const n = Math.max(0, ...datasets.map((d) => d.data.length));
  const totals: number[] = [];
  for (let i = 0; i < n; i++) {
    let t = 0;
    for (const d of datasets) {
      const v = d.data[i];
      if (typeof v === 'number' && Number.isFinite(v)) t += Math.abs(v);
    }
    totals.push(t);
  }
  return datasets.map((d) => ({
    label: d.label,
    data: d.data.map((v, i) =>
      typeof v === 'number' && Number.isFinite(v) && totals[i] > 0
        ? round2((Math.abs(v) / totals[i]) * 100)
        : 0,
    ),
  }));
}

/** Fixed pleasant palette, cycled for more series. */
export const CHART_PALETTE = [
  '#4F81BD',
  '#C0504D',
  '#9BBB59',
  '#8064A2',
  '#4BACC6',
  '#F79646',
  '#2C4D75',
  '#772C2A',
  '#5B7FA6',
  '#A6A6A6',
];

export const colorFor = (i: number): string => CHART_PALETTE[i % CHART_PALETTE.length];

/** Parse "A1:D10" (or "A1") into a ChartRange for the given sheet. */
export function parseA1Range(text: string, sheet: string): ChartRange | null {
  const m = text.trim().toUpperCase().match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  if (!m) return null;
  const c1 = colLettersToIndex(m[1]);
  const r1 = parseInt(m[2], 10) - 1;
  const c2 = m[3] ? colLettersToIndex(m[3]) : c1;
  const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
  if (r1 < 0 || c1 < 0 || r2 < 0 || c2 < 0) return null;
  return {
    sheet,
    startRow: Math.min(r1, r2),
    startCol: Math.min(c1, c2),
    endRow: Math.max(r1, r2),
    endCol: Math.max(c1, c2),
  };
}

export function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colIndexToLetters(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "A1:D10" form of a range. */
export function a1RangeString(range: ChartRange): string {
  const a = `${colIndexToLetters(range.startCol)}${range.startRow + 1}`;
  const b = `${colIndexToLetters(range.endCol)}${range.endRow + 1}`;
  return a === b ? a : `${a}:${b}`;
}

/** Kinds rendered by custom SVG (vs chart.js). */
export function isSvgKind(kind: ChartKind): boolean {
  return (
    kind === 'treemap' ||
    kind === 'sunburst' ||
    kind === 'contour' ||
    kind === 'contour-wireframe' ||
    kind === 'surface-3d' ||
    kind === 'surface-3d-wireframe' ||
    kind === 'map-filled'
  );
}

function legendOptions(spec: ChartSpec): Record<string, unknown> {
  if (spec.legend === 'none') return { display: false };
  return { display: true, position: spec.legend };
}

function titleOptions(spec: ChartSpec): Record<string, unknown> {
  return { display: spec.title.trim() !== '', text: spec.title };
}

function axisTitle(text: string): Record<string, unknown> {
  return { display: text.trim() !== '', text };
}

/**
 * Inline plugin: draw data labels on bars, line points and pie arcs.
 * Avoids the external chartjs-plugin-datalabels dependency.
 */
export const dataLabelsPlugin: Plugin = {
  id: 'icecream-data-labels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const meta of chart.getSortedVisibleDatasetMetas()) {
      for (const el of meta.data) {
        const raw = (el as unknown as { $context?: { raw?: unknown } }).$context?.raw;
        let label: string | null = null;
        if (typeof raw === 'number') label = String(round2(raw));
        else if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === 'number' && typeof raw[1] === 'number') {
          label = String(round2(raw[1] - raw[0]));
        }
        if (label === null) continue;
        const pos = (el as unknown as { tooltipPosition: () => { x: number; y: number } }).tooltipPosition();
        // For bars, nudge above the top edge; for points/arcs use the position.
        ctx.fillText(label, pos.x, pos.y - 4);
      }
    }
    ctx.restore();
  },
};

/**
 * Inline plugin: draw whiskers + median for box plots rendered as floating
 * bars [q1, q3]. Reads per-bar BoxStats from dataset.boxStats.
 */
export const boxWhiskerPlugin: Plugin = {
  id: 'icecream-box-whisker',
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (!meta) return;
    const ds = chart.data.datasets[0] as unknown as { boxStats?: BoxStats[] };
    const stats = ds.boxStats;
    if (!stats) return;
    const yScale = chart.scales['y'] as unknown as { getPixelForValue: (v: number) => number } | undefined;
    if (!yScale) return;
    const { ctx } = chart;
    ctx.save();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;
    meta.data.forEach((el, i) => {
      const s = stats[i];
      if (!s) return;
      const x = (el as unknown as { x: number }).x;
      const w = ((el as unknown as { width?: number }).width ?? 24) / 2;
      const yMin = yScale.getPixelForValue(s.min);
      const yQ1 = yScale.getPixelForValue(s.q1);
      const yMed = yScale.getPixelForValue(s.median);
      const yQ3 = yScale.getPixelForValue(s.q3);
      const yMax = yScale.getPixelForValue(s.max);
      ctx.beginPath();
      // Whiskers
      ctx.moveTo(x, yMax);
      ctx.lineTo(x, yQ3);
      ctx.moveTo(x, yQ1);
      ctx.lineTo(x, yMin);
      // Caps
      ctx.moveTo(x - w * 0.6, yMax);
      ctx.lineTo(x + w * 0.6, yMax);
      ctx.moveTo(x - w * 0.6, yMin);
      ctx.lineTo(x + w * 0.6, yMin);
      ctx.stroke();
      // Median (thicker, dark)
      ctx.beginPath();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 2;
      ctx.moveTo(x - w, yMed);
      ctx.lineTo(x + w, yMed);
      ctx.stroke();
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1.5;
    });
    ctx.restore();
  },
};

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Compound pies (Pie of Pie / Bar of Pie)
// ---------------------------------------------------------------------------

export interface CompoundPieSplit {
  mainLabels: string[];
  mainValues: number[];
  detailLabels: string[];
  detailValues: number[];
  /** False when there is nothing worth breaking out (fewer than 3 slices). */
  hasDetail: boolean;
}

/**
 * Split pie values the way Excel's Pie of Pie / Bar of Pie does: the
 * smallest slices (up to ~25% of the total) break out into a second chart
 * and are aggregated as "Other" in the main chart.
 */
export function splitCompoundPie(labels: string[], values: number[]): CompoundPieSplit {
  const pairs = labels.map((label, i) => ({ label, value: values[i] ?? 0 }));
  if (pairs.length < 3) {
    return {
      mainLabels: [...labels],
      mainValues: [...values],
      detailLabels: [],
      detailValues: [],
      hasDetail: false,
    };
  }
  const total = pairs.reduce((s, p) => s + Math.max(0, p.value), 0);
  const asc = [...pairs].sort((a, b) => a.value - b.value);
  const small: typeof pairs = [];
  let acc = 0;
  for (const p of asc) {
    if (small.length >= pairs.length - 1) break; // keep at least one main slice
    if (total > 0 && acc + Math.max(0, p.value) > total * 0.25 && small.length > 0) break;
    small.push(p);
    acc += Math.max(0, p.value);
  }
  const smallSet = new Set(small);
  const main = pairs.filter((p) => !smallSet.has(p));
  return {
    mainLabels: [...main.map((p) => p.label), 'Other'],
    mainValues: [...main.map((p) => p.value), acc],
    detailLabels: small.map((p) => p.label),
    detailValues: small.map((p) => p.value),
    hasDetail: true,
  };
}

// ---------------------------------------------------------------------------
// Stock charts
// ---------------------------------------------------------------------------

export interface StockColumns {
  volume: (number | null)[] | null;
  open: (number | null)[] | null;
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
}

/**
 * Map extracted series to Excel's stock data layout:
 * [Volume,] [Open,] High, Low, Close — one value set per category.
 * (support.microsoft.com "Select data for a chart": stock charts arrange
 * opening, high, low and closing values in columns, with names or dates
 * as labels.)
 */
export function stockColumns(kind: ChartKind, series: ChartSeries): StockColumns {
  const withVolume = kind === 'stock-volume-hlc' || kind === 'stock-volume-ohlc';
  const withOpen = kind === 'stock-ohlc' || kind === 'stock-volume-ohlc';
  const cols = series.datasets.map((d) => d.data.map(numOrNull));
  let i = 0;
  const volume = withVolume ? (cols[i++] ?? null) : null;
  const open = withOpen ? (cols[i++] ?? null) : null;
  const high = cols[i++] ?? [];
  const low = cols[i++] ?? [];
  const close = cols[i++] ?? [];
  return { volume, open, high, low, close };
}

// ---------------------------------------------------------------------------
// Surface & contour geometry (custom SVG kinds)
// ---------------------------------------------------------------------------

export interface SurfaceGrid {
  xLabels: string[];
  yLabels: string[];
  /** z[row][col], null for non-numeric cells. */
  z: (number | null)[][];
  zMin: number;
  zMax: number;
}

/**
 * Build the z-matrix for surface/contour charts: each dataset is an X
 * column, each category label a Y row, values are heights.
 */
export function surfaceGrid(series: ChartSeries): SurfaceGrid {
  const z: (number | null)[][] = series.labels.map((_, r) =>
    series.datasets.map((d) => numOrNull(d.data[r])),
  );
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const row of z) {
    for (const v of row) {
      if (v !== null) {
        zMin = Math.min(zMin, v);
        zMax = Math.max(zMax, v);
      }
    }
  }
  if (!Number.isFinite(zMin)) {
    zMin = 0;
    zMax = 1;
  }
  if (zMax === zMin) zMax = zMin + 1;
  return {
    xLabels: series.datasets.map((d) => d.label),
    yLabels: [...series.labels],
    z,
    zMin,
    zMax,
  };
}

export interface SurfacePoint {
  x: number;
  y: number;
}

export interface SurfaceQuad {
  pts: [SurfacePoint, SurfacePoint, SurfacePoint, SurfacePoint];
  fill: string;
  /** Row index: larger = further back. Quads are sorted back-to-front. */
  depth: number;
}

export interface SurfaceGeometry {
  /** Grid lines (wireframe), as point pairs. */
  lines: [SurfacePoint, SurfacePoint][];
  /** Filled quads for 3-D Surface, sorted back-to-front (painter's). */
  quads: SurfaceQuad[];
}

/** Linear interpolation between two #rrggbb colors. */
export function lerpColor(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return (
    '#' +
    pa
      .map((v, i) => Math.round(v + ((pb[i] ?? v) - v) * c).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * Oblique-projection geometry for the 3-D surface charts. Row 0 is the
 * front row. For `surface-3d` the caller draws `quads` (already sorted
 * back-to-front); for `surface-3d-wireframe` it draws `lines`.
 * Pure math — the web UI turns this into SVG.
 */
export function surfaceGeometry(
  grid: SurfaceGrid,
  w: number,
  h: number,
  filled: boolean,
): SurfaceGeometry {
  const rows = grid.z.length;
  const cols = rows > 0 ? grid.z[0].length : 0;
  const lines: [SurfacePoint, SurfacePoint][] = [];
  const quads: SurfaceQuad[] = [];
  if (rows === 0 || cols === 0) return { lines, quads };
  const pad = 30;
  const dx = cols > 1 ? (w - pad * 2 - 40) / (cols - 1) : 0;
  const dy = rows > 1 ? (h - pad * 2 - 40) / (rows - 1) : 0;
  const maxLift = Math.min(w, h) * 0.32;
  const ang = Math.PI / 6; // 30° oblique
  const cosA = Math.cos(ang);
  const sinA = Math.sin(ang);
  const pt = (c: number, r: number): SurfacePoint | null => {
    const row = grid.z[r];
    const v = row ? row[c] : undefined;
    if (v === null || v === undefined) return null;
    const t = (v - grid.zMin) / (grid.zMax - grid.zMin);
    const lift = t * maxLift;
    return {
      x: pad + c * dx + lift * cosA,
      y: pad + (rows - 1 - r) * dy + 20 - lift * sinA,
    };
  };
  const P: (SurfacePoint | null)[][] = grid.z.map((row, r) => row.map((_, c) => pt(c, r)));
  const at = (c: number, r: number): SurfacePoint | null => (P[r] ? (P[r][c] ?? null) : null);

  // Grid lines, broken at nulls.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = at(c, r);
      const b = at(c + 1, r);
      if (a && b) lines.push([a, b]);
    }
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r + 1 < rows; r++) {
      const a = at(c, r);
      const b = at(c, r + 1);
      if (a && b) lines.push([a, b]);
    }
  }

  if (filled) {
    for (let r = 0; r + 1 < rows; r++) {
      for (let c = 0; c + 1 < cols; c++) {
        const p00 = at(c, r);
        const p10 = at(c + 1, r);
        const p11 = at(c + 1, r + 1);
        const p01 = at(c, r + 1);
        if (!p00 || !p10 || !p11 || !p01) continue;
        const vs = [grid.z[r][c], grid.z[r][c + 1], grid.z[r + 1][c + 1], grid.z[r + 1][c]].filter(
          (v): v is number => v !== null && v !== undefined,
        );
        const avg = vs.reduce((s, v) => s + v, 0) / vs.length;
        const t = (avg - grid.zMin) / (grid.zMax - grid.zMin);
        quads.push({
          pts: [p00, p10, p11, p01],
          fill: lerpColor('#4F81BD', '#C0504D', t),
          depth: r,
        });
      }
    }
    // Painter's algorithm: back rows (larger r) first.
    quads.sort((a, b) => b.depth - a.depth);
  }
  return { lines, quads };
}

export interface ContourBand {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

export interface ContourLevelLine {
  level: number;
  color: string;
  segments: [number, number, number, number][];
}

export interface ContourGeometry {
  bands: ContourBand[];
  levels: ContourLevelLine[];
}

/**
 * Marching-squares contour geometry for the contour charts. `bands` are
 * per-cell fills quantized to `levelCount` bands (drawn for `contour`,
 * skipped for `contour-wireframe`); `levels` are the contour lines.
 * Pure math — the web UI turns this into SVG.
 */
export function contourGeometry(
  grid: SurfaceGrid,
  w: number,
  h: number,
  levelCount = 8,
): ContourGeometry {
  const rows = grid.z.length;
  const cols = rows > 0 ? grid.z[0].length : 0;
  const bands: ContourBand[] = [];
  const levels: ContourLevelLine[] = [];
  if (rows < 2 || cols < 2) return { bands, levels };
  const pad = 30;
  const X = (c: number): number => pad + (c / (cols - 1)) * (w - pad * 2);
  // Row 0 at the bottom, like a chart axis.
  const Y = (r: number): number => pad + (1 - r / (rows - 1)) * (h - pad * 2);
  const span = grid.zMax - grid.zMin;
  const bandOf = (v: number): number =>
    Math.min(levelCount - 1, Math.floor(((v - grid.zMin) / span) * levelCount));

  // Per-cell fills.
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const vs = [grid.z[r][c], grid.z[r][c + 1], grid.z[r + 1][c + 1], grid.z[r + 1][c]].filter(
        (v): v is number => v !== null && v !== undefined,
      );
      if (vs.length < 4) continue;
      const avg = vs.reduce((s, v) => s + v, 0) / 4;
      bands.push({
        x: X(c),
        y: Y(r + 1),
        w: X(c + 1) - X(c),
        h: Y(r) - Y(r + 1),
        fill: lerpColor('#DCE9F7', '#1F4E79', bandOf(avg) / Math.max(1, levelCount - 1)),
      });
    }
  }

  // Marching squares. Corners: a=bottom-left, b=bottom-right, c=top-right, d=top-left.
  // Edges: 0=bottom(a-b), 1=right(b-c), 2=top(d-c), 3=left(a-d).
  const CASES: Record<number, [number, number][]> = {
    1: [[3, 0]],
    2: [[0, 1]],
    3: [[3, 1]],
    4: [[1, 2]],
    5: [[3, 0], [1, 2]],
    6: [[0, 2]],
    7: [[3, 2]],
    8: [[3, 2]],
    9: [[0, 2]],
    10: [[0, 1], [3, 2]],
    11: [[1, 2]],
    12: [[3, 1]],
    13: [[0, 1]],
    14: [[3, 0]],
  };
  for (let li = 1; li <= levelCount; li++) {
    const level = grid.zMin + (span * li) / (levelCount + 1);
    const segments: [number, number, number, number][] = [];
    for (let r = 0; r + 1 < rows; r++) {
      for (let c = 0; c + 1 < cols; c++) {
        const va = grid.z[r][c];
        const vb = grid.z[r][c + 1];
        const vc = grid.z[r + 1][c + 1];
        const vd = grid.z[r + 1][c];
        if (va === null || vb === null || vc === null || vd === null) continue;
        let idx = 0;
        if (va >= level) idx |= 1;
        if (vb >= level) idx |= 2;
        if (vc >= level) idx |= 4;
        if (vd >= level) idx |= 8;
        const pairs = CASES[idx];
        if (!pairs) continue;
        const corners: [number, number, number][] = [
          [X(c), Y(r), va],
          [X(c + 1), Y(r), vb],
          [X(c + 1), Y(r + 1), vc],
          [X(c), Y(r + 1), vd],
        ];
        // Edge endpoints: 0: corners 0-1, 1: 1-2, 2: 3-2, 3: 0-3.
        const edgePoint = (e: number): [number, number] | null => {
          const [i1, i2] = e === 0 ? [0, 1] : e === 1 ? [1, 2] : e === 2 ? [3, 2] : [0, 3];
          const p1 = corners[i1];
          const p2 = corners[i2];
          if (!p1 || !p2 || p2[2] === p1[2]) return null;
          const t = (level - p1[2]) / (p2[2] - p1[2]);
          return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
        };
        for (const [e1, e2] of pairs) {
          const q1 = edgePoint(e1);
          const q2 = edgePoint(e2);
          if (q1 && q2) segments.push([q1[0], q1[1], q2[0], q2[1]]);
        }
      }
    }
    levels.push({
      level: Math.round(level * 100) / 100,
      color: lerpColor('#9BBB59', '#772C2A', li / (levelCount + 1)),
      segments,
    });
  }
  return { bands, levels };
}

export interface BuiltDetailChart {
  /** 'pie' for Pie of Pie, 'bar' for Bar of Pie. */
  kind: 'pie' | 'bar';
  title: string;
  config: ChartConfiguration;
}

export interface BuiltConfig {
  config: ChartConfiguration;
  /** Set when the caller should render the custom SVG instead of chart.js. */
  svg: 'treemap' | 'sunburst' | 'contour' | 'surface' | 'map' | null;
  /**
   * Compound pies (Pie of Pie / Bar of Pie): the breakout chart for the
   * "Other" slice, rendered side-by-side with the main chart.
   */
  detail?: BuiltDetailChart;
  /**
   * Set when an Excel 3-D kind was rendered as its 2-D counterpart
   * (see THREE_D_FALLBACK): the 2-D kind that was actually rendered.
   */
  renderedAs?: ChartKind;
}

/**
 * Build a chart.js configuration from a spec + extracted series.
 * Pure function — fully testable without a DOM.
 *
 * - Excel 3-D kinds render as their 2-D counterparts (THREE_D_FALLBACK);
 *   the result carries `renderedAs` so the UI can say so honestly.
 * - `map-filled` renders as custom SVG via the bundled world boundaries
 *   (see mapGeometry.ts); `built.svg` is 'map' and the caller renders
 *   buildMapSvg(mapSeriesToCountries(series), ...).
 */
export function buildChartConfig(spec: ChartSpec, series: ChartSeries): BuiltConfig {
  const unsupported = UNSUPPORTED_KINDS[spec.kind];
  if (unsupported) {
    throw new Error(`Chart kind "${kindLabel(spec.kind)}" is not renderable in v1: ${unsupported}`);
  }
  const fallback = THREE_D_FALLBACK[spec.kind];
  const effSpec = fallback ? { ...spec, kind: fallback } : spec;
  const built = buildForKind(effSpec, series);
  if (fallback) built.renderedAs = fallback;
  return built;
}

/** Inner builder: every kind in the switch is directly renderable. */
function buildForKind(spec: ChartSpec, series: ChartSeries): BuiltConfig {
  const plugins: Plugin[] = [];
  if (spec.dataLabels) plugins.push(dataLabelsPlugin);

  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    plugins: {
      title: titleOptions(spec),
      legend: legendOptions(spec),
    },
  };

  const stacked = spec.kind.includes('stacked') && !spec.kind.includes('stacked100');
  const stacked100 = spec.kind.includes('stacked100');
  let datasets: ChartDataset[] = series.datasets;
  if (stacked100) datasets = toPercentStacked(datasets);

  const cartesianScales = (horizontal: boolean) => {
    const valueAxis = {
      stacked: stacked || stacked100,
      title: axisTitle(horizontal ? spec.xAxisTitle : spec.yAxisTitle),
      ...(stacked100 && !horizontal
        ? { ticks: { callback: (v: number | string) => `${v}%` } }
        : {}),
      ...(stacked100 && horizontal
        ? { ticks: { callback: (v: number | string) => `${v}%` } }
        : {}),
    };
    const categoryAxis = {
      stacked: stacked || stacked100,
      title: axisTitle(horizontal ? spec.yAxisTitle : spec.xAxisTitle),
    };
    return horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis };
  };

  const barDatasets = (horizontal: boolean) =>
    datasets.map((d, i) => ({
      label: d.label,
      data: d.data,
      backgroundColor: colorFor(i),
      borderColor: colorFor(i),
      borderWidth: 1,
    }));

  switch (spec.kind) {
    case 'column-clustered':
    case 'column-stacked':
    case 'column-stacked100':
      return {
        svg: null,
        config: {
          type: 'bar',
          data: { labels: series.labels, datasets: barDatasets(false) },
          options: { ...baseOptions, scales: cartesianScales(false) },
          plugins,
        },
      };
    case 'bar-clustered':
    case 'bar-stacked':
    case 'bar-stacked100':
      return {
        svg: null,
        config: {
          type: 'bar',
          data: { labels: series.labels, datasets: barDatasets(true) },
          options: { ...baseOptions, indexAxis: 'y' as const, scales: cartesianScales(true) },
          plugins,
        },
      };
    case 'line':
    case 'line-markers':
    case 'line-smooth':
    case 'line-stacked':
    case 'line-stacked-markers':
    case 'line-stacked100':
    case 'line-stacked100-markers': {
      const withMarkers = spec.kind.includes('markers') || spec.kind === 'line-smooth';
      const smooth = spec.kind === 'line-smooth';
      return {
        svg: null,
        config: {
          type: 'line',
          data: {
            labels: series.labels,
            datasets: datasets.map((d, i) => ({
              label: d.label,
              data: d.data,
              borderColor: colorFor(i),
              backgroundColor: colorFor(i),
              fill: spec.kind === 'line' || spec.kind === 'line-markers' ? false : false,
              tension: smooth ? 0.4 : 0,
              pointRadius: withMarkers ? 4 : 0,
              pointHoverRadius: 5,
              borderWidth: 2,
            })),
          },
          options: { ...baseOptions, scales: cartesianScales(false) },
          plugins,
        },
      };
    }
    case 'area':
    case 'area-stacked':
    case 'area-stacked100':
      return {
        svg: null,
        config: {
          type: 'line',
          data: {
            labels: series.labels,
            datasets: datasets.map((d, i) => ({
              label: d.label,
              data: d.data,
              borderColor: colorFor(i),
              backgroundColor: `${colorFor(i)}88`,
              fill: true,
              tension: 0,
              pointRadius: 0,
              borderWidth: 2,
            })),
          },
          options: { ...baseOptions, scales: cartesianScales(false) },
          plugins,
        },
      };
    case 'pie':
    case 'doughnut': {
      const first = datasets[0] ?? { label: '', data: [] };
      return {
        svg: null,
        config: {
          type: spec.kind,
          data: {
            labels: series.labels,
            datasets: [
              {
                label: first.label,
                data: first.data,
                backgroundColor: first.data.map((_, i) => colorFor(i)),
                borderColor: '#fff',
                borderWidth: 2,
              },
            ],
          },
          options: baseOptions,
          plugins,
        },
      };
    }
    case 'scatter':
    case 'scatter-smooth':
    case 'scatter-lines':
    case 'scatter-lines-markers':
    case 'scatter-smooth-markers':
    case 'bubble': {
      const showLine = spec.kind !== 'scatter' && spec.kind !== 'bubble';
      const smooth = spec.kind.includes('smooth');
      const withMarkers = !spec.kind.includes('only') && (spec.kind.includes('markers') || spec.kind === 'scatter' || spec.kind === 'bubble');
      // First numeric column is X; remaining columns are Y series.
      const xs: (number | null)[] = datasets[0]?.data ?? [];
      const ySets = datasets.slice(1);
      const isBubble = spec.kind === 'bubble';
      // Scale bubble radii (px) from raw size values via sqrt scale.
      const scaleBubbleRadii = (sets: { data: { x: number; y: number; r?: number }[] }[]) => {
        if (!isBubble) return;
        let maxR = 0;
        for (const s of sets) for (const p of s.data) maxR = Math.max(maxR, p.r ?? 0);
        for (const s of sets)
          for (const p of s.data) p.r = maxR > 0 ? 4 + 18 * Math.sqrt((p.r ?? 0) / maxR) : 8;
      };
      const toPoint = (x: number | null, y: number | null, r?: number | null) => {
        if (x === null || y === null) return null;
        return isBubble ? { x, y, r: typeof r === 'number' && r > 0 ? r : 6 } : { x, y };
      };
      const scatterSets = (ySets.length > 0 ? ySets : [{ label: datasets[0]?.label ?? 'Series 1', data: [] }]).map(
        (d, i) => ({
          label: d.label,
          data: xs.map((x, xi) => toPoint(x, d.data[xi], datasets[2]?.data[xi])).filter((p): p is { x: number; y: number; r?: number } => p !== null),
          backgroundColor: `${colorFor(i)}AA`,
          borderColor: colorFor(i),
          showLine,
          tension: smooth ? 0.4 : 0,
          pointRadius: withMarkers ? 4 : 0,
          borderWidth: 2,
        }),
      );
      // Single-column case: x = category index.
      const finalSets =
        ySets.length === 0
          ? [
              {
                label: datasets[0]?.label ?? 'Series 1',
                data: xs.map((x, xi) => (x !== null ? toPoint(xi + 1, x, undefined) : null)).filter((p): p is { x: number; y: number; r?: number } => p !== null),
                backgroundColor: `${colorFor(0)}AA`,
                borderColor: colorFor(0),
                showLine,
                tension: smooth ? 0.4 : 0,
                pointRadius: withMarkers ? 4 : 0,
                borderWidth: 2,
              },
            ]
          : scatterSets;
      scaleBubbleRadii(finalSets as { data: { x: number; y: number; r?: number }[] }[]);
      return {
        svg: null,
        config: {
          type: isBubble ? 'bubble' : 'scatter',
          data: { datasets: finalSets },
          options: {
            ...baseOptions,
            scales: {
              x: { title: axisTitle(spec.xAxisTitle || 'X') },
              y: { title: axisTitle(spec.yAxisTitle || 'Y') },
            },
          },
          plugins,
        },
      };
    }
    case 'histogram': {
      const allNums: number[] = [];
      for (const d of datasets) for (const v of d.data) if (typeof v === 'number') allNums.push(v);
      const hist = histogramBins(allNums);
      return {
        svg: null,
        config: {
          type: 'bar',
          data: {
            labels: hist.labels,
            datasets: [
              {
                label: 'Frequency',
                data: hist.counts,
                backgroundColor: colorFor(0),
                borderColor: colorFor(0),
                borderWidth: 1,
                categoryPercentage: 1.0,
                barPercentage: 1.0,
              },
            ],
          },
          options: {
            ...baseOptions,
            scales: { x: { title: axisTitle(spec.xAxisTitle || 'Bin') }, y: { title: axisTitle(spec.yAxisTitle || 'Frequency'), beginAtZero: true } },
          },
          plugins,
        },
      };
    }
    case 'pareto': {
      const first = datasets[0] ?? { label: '', data: [] };
      const nums = first.data.map((v) => (typeof v === 'number' ? v : 0));
      const p = paretoTransform(series.labels, nums);
      return {
        svg: null,
        config: {
          type: 'bar',
          data: {
            labels: p.labels,
            datasets: [
              { label: first.label, data: p.values, backgroundColor: colorFor(0), yAxisID: 'y' },
              {
                label: 'Cumulative %',
                data: p.cumulativePct,
                type: 'line' as const,
                borderColor: colorFor(1),
                backgroundColor: colorFor(1),
                yAxisID: 'y1',
                tension: 0,
                pointRadius: 3,
              },
            ],
          },
          options: {
            ...baseOptions,
            scales: {
              x: { title: axisTitle(spec.xAxisTitle) },
              y: { title: axisTitle(spec.yAxisTitle), beginAtZero: true },
              y1: {
                position: 'right' as const,
                min: 0,
                max: 100,
                grid: { drawOnChartArea: false },
                ticks: { callback: (v: number | string) => `${v}%` },
              },
            },
          },
          plugins,
        },
      };
    }
    case 'boxplot': {
      const stats = datasets.map((d) =>
        boxPlotStats(d.data.filter((v): v is number => typeof v === 'number')),
      );
      plugins.push(boxWhiskerPlugin);
      return {
        svg: null,
        config: {
          type: 'bar',
          data: {
            labels: datasets.map((d) => d.label),
            datasets: [
              {
                label: 'Box',
                data: stats.map((s) => (s ? [s.q1, s.q3] : [0, 0])),
                backgroundColor: datasets.map((_, i) => `${colorFor(i)}AA`),
                borderColor: datasets.map((_, i) => colorFor(i)),
                borderWidth: 1.5,
                // carried for the whisker plugin
                boxStats: stats,
              } as unknown as never,
            ],
          },
          options: {
            ...baseOptions,
            scales: { x: { title: axisTitle(spec.xAxisTitle) }, y: { title: axisTitle(spec.yAxisTitle) } },
          },
          plugins,
        },
      };
    }
    case 'waterfall': {
      const first = datasets[0] ?? { label: '', data: [] };
      const nums = first.data.map((v) => (typeof v === 'number' ? v : 0));
      const wf = waterfallSegments(series.labels, nums);
      return {
        svg: null,
        config: {
          type: 'bar',
          data: {
            labels: wf.labels,
            datasets: [
              {
                label: first.label,
                data: wf.floats,
                backgroundColor: wf.kinds.map((k) =>
                  k === 'up' ? '#4F81BD' : k === 'down' ? '#C0504D' : '#808080',
                ),
                borderWidth: 1,
              },
            ],
          },
          options: {
            ...baseOptions,
            scales: { x: { title: axisTitle(spec.xAxisTitle) }, y: { title: axisTitle(spec.yAxisTitle) } },
          },
          plugins,
        },
      };
    }
    case 'funnel': {
      const first = datasets[0] ?? { label: '', data: [] };
      const pairs = series.labels
        .map((label, i) => ({ label, value: typeof first.data[i] === 'number' ? (first.data[i] as number) : 0 }))
        .sort((a, b) => b.value - a.value);
      const max = Math.max(1, ...pairs.map((p) => p.value));
      return {
        svg: null,
        config: {
          type: 'bar',
          data: {
            labels: pairs.map((p) => p.label),
            datasets: [
              {
                label: first.label,
                data: pairs.map((p) => p.value),
                backgroundColor: pairs.map((_, i) => colorFor(i)),
                borderWidth: 0,
                // Funnel illusion: center bars via scriptable insets is complex;
                // bar thickness scaled by value ratio approximates the funnel.
                barThickness: undefined,
              },
            ],
          },
          options: {
            ...baseOptions,
            indexAxis: 'y' as const,
            scales: {
              x: { display: false, max: max * 1.15 },
              y: { title: axisTitle(spec.yAxisTitle) },
            },
          },
          plugins: [
            ...plugins,
            {
              id: 'icecream-funnel-center',
              beforeDatasetsDraw(chart) {
                // Center each bar horizontally proportional to its value.
                const meta = chart.getDatasetMeta(0);
                const xScale = chart.scales['x'] as unknown as { getPixelForValue: (v: number) => number; max: number };
                meta.data.forEach((el, i) => {
                  const v = pairs[i]?.value ?? 0;
                  const full = xScale.getPixelForValue(max * 1.15);
                  const zero = xScale.getPixelForValue(0);
                  const valPx = xScale.getPixelForValue(v);
                  const bar = el as unknown as { x: number; width: number };
                  const center = (zero + full) / 2;
                  const half = Math.abs(valPx - zero) / 2;
                  bar.x = center;
                  bar.width = Math.max(2, half * 2);
                });
              },
            } as Plugin,
          ],
        },
      };
    }
    case 'radar':
    case 'radar-markers':
    case 'radar-filled': {
      const withMarkers = spec.kind !== 'radar';
      const filled = spec.kind === 'radar-filled';
      return {
        svg: null,
        config: {
          type: 'radar',
          data: {
            labels: series.labels,
            datasets: datasets.map((d, i) => ({
              label: d.label,
              data: d.data,
              borderColor: colorFor(i),
              backgroundColor: filled ? `${colorFor(i)}66` : colorFor(i),
              fill: filled,
              pointRadius: withMarkers ? 4 : 0,
              borderWidth: 2,
            })),
          },
          options: baseOptions,
          plugins,
        },
      };
    }
    case 'combo-column-line':
    case 'combo-column-line-2axis':
    case 'combo-stacked-area-column': {
      const secondAxis = spec.kind === 'combo-column-line-2axis';
      const lineIdx = datasets.length > 1 ? datasets.length - 1 : 0;
      return {
        svg: null,
        config: {
          type: 'bar',
          data: {
            labels: series.labels,
            datasets: datasets.map((d, i) => {
              const isLine = i === lineIdx && datasets.length > 1;
              const isArea = spec.kind === 'combo-stacked-area-column' && !isLine;
              return {
                label: d.label,
                data: d.data,
                type: (isLine ? 'line' : 'bar') as 'line' | 'bar',
                backgroundColor: isArea ? `${colorFor(i)}88` : colorFor(i),
                borderColor: colorFor(i),
                borderWidth: 2,
                fill: isArea,
                tension: 0,
                pointRadius: isLine ? 3 : 0,
                ...(isLine && secondAxis ? { yAxisID: 'y1' } : {}),
                ...(isArea ? { stack: 'area' } : {}),
              };
            }),
          },
          options: {
            ...baseOptions,
            scales: {
              x: { stacked: spec.kind === 'combo-stacked-area-column', title: axisTitle(spec.xAxisTitle) },
              y: { stacked: spec.kind === 'combo-stacked-area-column', title: axisTitle(spec.yAxisTitle) },
              ...(secondAxis
                ? {
                    y1: {
                      position: 'right' as const,
                      grid: { drawOnChartArea: false },
                      title: axisTitle(''),
                    },
                  }
                : {}),
            },
          },
          plugins,
        },
      };
    }
    case 'pie-of-pie':
    case 'bar-of-pie': {
      const first = datasets[0] ?? { label: '', data: [] };
      const nums = first.data.map((v) => (typeof v === 'number' ? v : 0));
      const split = splitCompoundPie(series.labels, nums);
      const mainConfig: ChartConfiguration = {
        type: 'pie',
        data: {
          labels: split.mainLabels,
          datasets: [
            {
              label: first.label,
              data: split.mainValues,
              backgroundColor: split.mainValues.map((_, i) => colorFor(i)),
              borderColor: '#fff',
              borderWidth: 2,
            },
          ],
        },
        options: baseOptions,
        plugins,
      };
      if (!split.hasDetail) return { svg: null, config: mainConfig };
      const detailIsBar = spec.kind === 'bar-of-pie';
      const detailConfig: ChartConfiguration = detailIsBar
        ? {
            type: 'bar',
            data: {
              labels: split.detailLabels,
              datasets: [
                {
                  label: 'Other',
                  data: split.detailValues,
                  backgroundColor: split.detailValues.map((_, i) => colorFor(i)),
                  borderWidth: 1,
                },
              ],
            },
            options: baseOptions,
            plugins,
          }
        : {
            type: 'pie',
            data: {
              labels: split.detailLabels,
              datasets: [
                {
                  label: 'Other',
                  data: split.detailValues,
                  backgroundColor: split.detailValues.map((_, i) => colorFor(i)),
                  borderColor: '#fff',
                  borderWidth: 2,
                },
              ],
            },
            options: baseOptions,
            plugins,
          };
      return {
        svg: null,
        config: mainConfig,
        detail: { kind: detailIsBar ? 'bar' : 'pie', title: 'Other breakdown', config: detailConfig },
      };
    }
    case 'stock-hlc':
    case 'stock-ohlc':
    case 'stock-volume-hlc':
    case 'stock-volume-ohlc': {
      const { volume, open, high, low, close } = stockColumns(spec.kind, series);
      const n = series.labels.length;
      const floats: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const hv = high[i] ?? 0;
        const lv = low[i] ?? 0;
        floats.push([Math.min(lv, hv), Math.max(lv, hv)]);
      }
      const marker = (
        vals: (number | null)[],
        label: string,
        pointStyle: 'circle' | 'rect',
        color: string,
      ) => ({
        type: 'line' as const,
        label,
        data: vals,
        showLine: false,
        pointStyle,
        pointRadius: 5,
        borderColor: color,
        backgroundColor: color,
      });
      const stockDatasets: ChartConfiguration['data']['datasets'] = [
        {
          label: 'High–Low',
          data: floats,
          backgroundColor: '#4F81BD88',
          borderColor: '#4F81BD',
          borderWidth: 1,
        } as never,
        ...(open ? [marker(open, 'Open', 'rect', '#C0504D')] : []),
        marker(close, 'Close', 'circle', '#2C4D75'),
        ...(volume
          ? [
              {
                type: 'bar' as const,
                label: 'Volume',
                data: volume,
                backgroundColor: '#A6A6A688',
                yAxisID: 'y1',
              },
            ]
          : []),
      ];
      return {
        svg: null,
        config: {
          type: 'bar',
          data: { labels: series.labels, datasets: stockDatasets },
          options: {
            ...baseOptions,
            scales: {
              x: { title: axisTitle(spec.xAxisTitle) },
              y: { title: axisTitle(spec.yAxisTitle || 'Price') },
              ...(volume
                ? {
                    y1: {
                      position: 'right' as const,
                      beginAtZero: true,
                      grid: { drawOnChartArea: false },
                      title: axisTitle('Volume'),
                    },
                  }
                : {}),
            },
          },
          plugins,
        },
      };
    }
    case 'surface-3d':
    case 'surface-3d-wireframe':
      return { svg: 'surface', config: { type: 'bar', data: { datasets: [] } } };
    case 'contour':
    case 'contour-wireframe':
      return { svg: 'contour', config: { type: 'bar', data: { datasets: [] } } };
    case 'treemap':
      return { svg: 'treemap', config: { type: 'bar', data: { datasets: [] } } };
    case 'sunburst':
      return { svg: 'sunburst', config: { type: 'bar', data: { datasets: [] } } };
    case 'map-filled':
      return { svg: 'map', config: { type: 'bar', data: { datasets: [] } } };
    default:
      // Unreachable for valid ChartSpec: buildChartConfig throws for
      // unsupported kinds and maps 3-D kinds to their 2-D fallbacks first.
      throw new Error(`Chart kind "${spec.kind}" is not renderable`);
  }
}

/** All 61 kinds, flattened, for validation. */
export const ALL_KINDS: ChartKind[] = CHART_GROUPS.flatMap((g) => g.kinds.map((k) => k.id));

/** Migrate a single chart spec to the current version, filling defaults. */
export function migrateChart(spec: Partial<ChartSpec>): ChartSpec {
  const v = typeof spec.version === 'number' ? spec.version : 0;
  void v;
  const num = (x: unknown, d: number): number =>
    typeof x === 'number' && Number.isFinite(x) ? x : d;
  // Normalize legacy field names (xTitle -> xAxisTitle, etc.).
  const legend = (spec.legend ?? (spec as Record<string, unknown>).legendPosition ?? 'bottom') as ChartSpec['legend'];
  const isLegend = (v: unknown): v is ChartSpec['legend'] =>
    v === 'top' || v === 'bottom' || v === 'left' || v === 'right' || v === 'none';
  return {
    version: CHART_SPEC_VERSION,
    id: typeof spec.id === 'number' ? spec.id : Date.now(),
    kind: (spec.kind ?? 'column-clustered') as ChartSpec['kind'],
    title: typeof spec.title === 'string' ? spec.title : '',
    range:
      spec.range && typeof spec.range === 'object'
        ? {
            sheet: String(spec.range.sheet ?? 'Sheet1'),
            startRow: num(spec.range.startRow, 0),
            startCol: num(spec.range.startCol, 0),
            endRow: num(spec.range.endRow, 0),
            endCol: num(spec.range.endCol, 0),
          }
        : { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    xAxisTitle: typeof spec.xAxisTitle === 'string' ? spec.xAxisTitle : '',
    yAxisTitle: typeof spec.yAxisTitle === 'string' ? spec.yAxisTitle : '',
    legend: isLegend(legend) ? legend : 'bottom',
    dataLabels: spec.dataLabels === true,
    x: num(spec.x, 120),
    y: num(spec.y, 120),
    w: num(spec.w, 480),
    h: num(spec.h, 320),
    anchorCells:
      spec.anchorCells && typeof spec.anchorCells === 'object'
        ? {
            fromCol: num(spec.anchorCells.fromCol, 0),
            fromRow: num(spec.anchorCells.fromRow, 0),
            toCol: num(spec.anchorCells.toCol, 0),
            toRow: num(spec.anchorCells.toRow, 0),
          }
        : undefined,
    seriesRanges: Array.isArray(spec.seriesRanges)
      ? spec.seriesRanges
          .filter((sr) => sr && typeof sr === 'object' && sr.val && typeof sr.val === 'object')
          .map((sr) => ({
            name: typeof sr.name === 'string' ? sr.name : '',
            cat:
              sr.cat && typeof sr.cat === 'object'
                ? {
                    sheet: String(sr.cat.sheet ?? 'Sheet1'),
                    startRow: num(sr.cat.startRow, 0),
                    startCol: num(sr.cat.startCol, 0),
                    endRow: num(sr.cat.endRow, 0),
                    endCol: num(sr.cat.endCol, 0),
                  }
                : null,
            val: {
              sheet: String(sr.val.sheet ?? 'Sheet1'),
              startRow: num(sr.val.startRow, 0),
              startCol: num(sr.val.startCol, 0),
              endRow: num(sr.val.endRow, 0),
              endCol: num(sr.val.endCol, 0),
            },
          }))
      : undefined,
    // Pivot binding: a pivot-bound chart must survive the localStorage
    // round trip, or the overlay falls back to reading spec.range (which for
    // dialog-created pivot charts is meaningless) and crashes on render.
    pivot:
      spec.pivot && typeof spec.pivot === 'object'
        ? {
            pivotId: num((spec.pivot as { pivotId?: unknown }).pivotId, -1),
            valueIndex: Math.max(
              0,
              num((spec.pivot as { valueIndex?: unknown }).valueIndex, 0),
            ),
          }
        : undefined,
    trendlines: Array.isArray((spec as { trendlines?: unknown }).trendlines)
      ? (spec as { trendlines?: TrendlineSpec[] }).trendlines
      : undefined,
  };
}
