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

/** Current version of the serialized ChartSpec. Bump when the shape changes. */
export const CHART_SPEC_VERSION = 1;

/** Every chart kind, mirroring the Excel Insert-tab chart galleries. */
export type ChartKind =
  | 'column-clustered'
  | 'column-stacked'
  | 'column-stacked100'
  | 'line'
  | 'line-stacked'
  | 'line-stacked100'
  | 'line-markers'
  | 'line-stacked-markers'
  | 'line-stacked100-markers'
  | 'line-smooth'
  | 'pie'
  | 'doughnut'
  | 'bar-clustered'
  | 'bar-stacked'
  | 'bar-stacked100'
  | 'area'
  | 'area-stacked'
  | 'area-stacked100'
  | 'scatter'
  | 'scatter-smooth'
  | 'scatter-lines'
  | 'scatter-lines-markers'
  | 'scatter-smooth-markers'
  | 'bubble'
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
      { id: 'line-smooth', label: 'Smoothed Line' },
    ],
  },
  {
    id: 'pie',
    label: 'Pie',
    kinds: [
      { id: 'pie', label: 'Pie' },
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
    ],
  },
  {
    id: 'area',
    label: 'Area',
    kinds: [
      { id: 'area', label: 'Area' },
      { id: 'area-stacked', label: 'Stacked Area' },
      { id: 'area-stacked100', label: '100% Stacked Area' },
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
  /** Overlay geometry in px, relative to the grid container. */
  x: number;
  y: number;
  w: number;
  h: number;
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
    x: partial.x ?? 120,
    y: partial.y ?? 120,
    w: partial.w ?? 480,
    h: partial.h ?? 320,
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

/** Kinds rendered by chart.js (vs the custom SVG treemap/sunburst). */
export function isSvgKind(kind: ChartKind): boolean {
  return kind === 'treemap' || kind === 'sunburst';
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

interface BuiltConfig {
  config: ChartConfiguration;
  /** True when the caller should render the custom SVG instead of chart.js. */
  svg: 'treemap' | 'sunburst' | null;
}

/**
 * Build a chart.js configuration from a spec + extracted series.
 * Pure function — fully testable without a DOM.
 */
export function buildChartConfig(spec: ChartSpec, series: ChartSeries): BuiltConfig {
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
    case 'treemap':
      return { svg: 'treemap', config: { type: 'bar', data: { datasets: [] } } };
    case 'sunburst':
      return { svg: 'sunburst', config: { type: 'bar', data: { datasets: [] } } };
  }
}

/** All 37 kinds, flattened, for validation. */
export const ALL_KINDS: ChartKind[] = CHART_GROUPS.flatMap((g) => g.kinds.map((k) => k.id));
