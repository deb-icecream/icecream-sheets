/**
 * Native reports & dashboards — web UI.
 *
 * Follows design-docs/native-reports-and-dashboards.md:
 * - Report builder + renderer are consumers of the typed computational view;
 *   all spec logic (validation, migration, KPI math, slicer filtering) lives
 *   in @icecream-sheets/service (packages/service/src/reports/).
 * - The ReportSpec is versioned + serializable and persisted through the
 *   service metadata store (features/reportStore.ts), never in the engine.
 * - PDF export uses the Download-as-PDF path (design §8): computed visuals
 *   are mapped to PDF blocks and rendered to real PDF bytes by the service
 *   renderer (renderReportPdf) — no window.print(), no OS print dialog.
 */
import { useMemo, useRef, useState } from 'react';
import ChartCanvas from './ChartCanvas';
import { TreemapSvg, SunburstSvg, ContourSvg, SurfaceSvg } from './Charts';
import {
  REPORT_FILTER_OPS,
  applyFiltersAndSlicers,
  buildChartConfig,
  buildHeatmap,
  clearReportSlicer,
  collectEtlRecipeIds,
  computeKpi,
  createPivot,
  distinctFieldValues,
  extractSeries,
  isRefreshDue,
  kindLabel,
  makeKpiSpec,
  makeReportSpec,
  makeReportSlicer,
  migrateBinding,
  pivotToMatrix,
  refreshReportEtlBindings,
  renderReportPdf,
  toggleSlicerValue,
  validateReportSpec,
  type BuiltConfig,
  type BuiltHeatmap,
  type CellReader,
  type ChartConfiguration,
  type ChartSeries,
  type ChartSpec,
  type EtlRefreshSummary,
  type KpiResult,
  type KpiSpec,
  type PivotRecord,
  type PivotResult,
  type PivotSpec,
  type RefreshMode,
  type ReportBinding,
  type ReportFilter,
  type ReportFilterOp,
  type ReportLayoutCell,
  type ReportPdfBlock,
  type ReportSlicer,
  type ReportSpec,
  type ReportVisual,
  type ReportVisualKind,
  type RunRecord,
} from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';

export interface ReportSourceInfo {
  sheet: string;
  range: { startRow: number; startCol: number; endRow: number; endCol: number };
  headers: string[];
  distinct: Record<string, string[]>;
}

export interface AvailableChart {
  id: number;
  title: string;
  spec: ChartSpec;
}

export interface AvailablePivot {
  id: number;
  title: string;
  spec: PivotSpec;
  sourceSheet: string;
  sourceRange: { startRow: number; startCol: number; endRow: number; endCol: number };
}

const fmtNum = (v: number | null): string => {
  if (v === null || v === undefined) return '';
  return Number.isInteger(v) ? v.toLocaleString('en-US') : String(Math.round(v * 100) / 100);
};

export function formatDataAsOf(iso: string | null): string {
  if (!iso) return 'never refreshed';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never refreshed';
  return d.toLocaleString();
}

const KPI_COLORS: Record<KpiResult['status'], string> = {
  good: '#1a7f37',
  warn: '#b7791f',
  bad: '#c0392b',
  neutral: '#333333',
};

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

export function KpiCard({ result }: { result: KpiResult }): JSX.Element {
  const color = KPI_COLORS[result.status];
  return (
    <div
      className="report-kpi-card"
      style={{
        border: `2px solid ${color}`,
        borderRadius: 8,
        padding: '12px 16px',
        minWidth: 220,
        background: '#fff',
      }}
    >
      <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>{result.label}</div>
      <div className="report-kpi-value" style={{ fontSize: 32, fontWeight: 700, color, lineHeight: 1.1 }}>
        {result.formatted}
      </div>
      {result.deltaFormatted !== null && (
        <div style={{ fontSize: 12, marginTop: 6, color: '#444' }}>
          <span style={{ color: (result.delta ?? 0) >= 0 ? '#1a7f37' : '#c0392b', fontWeight: 600 }}>
            {(result.delta ?? 0) >= 0 ? '▲' : '▼'} {result.deltaFormatted}
          </span>
          {result.deltaPct !== null && <span> ({result.deltaPct >= 0 ? '+' : ''}{Math.round(result.deltaPct * 10) / 10}% vs target)</span>}
          {result.targetFormatted !== null && <div style={{ color: '#888' }}>Target: {result.targetFormatted}</div>}
        </div>
      )}
      {result.deltaFormatted === null && result.targetFormatted !== null && (
        <div style={{ fontSize: 12, marginTop: 6, color: '#888' }}>Target: {result.targetFormatted}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slicer control
// ---------------------------------------------------------------------------

interface SlicerControlProps {
  slicer: ReportSlicer;
  values: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}

export function SlicerControl({ slicer, values, onToggle, onClear }: SlicerControlProps): JSX.Element {
  const all = slicer.selected.length === 0;
  return (
    <div
      style={{
        border: '1px solid #d0d7e3',
        borderRadius: 6,
        padding: '6px 8px',
        background: '#f7f9fd',
        minWidth: 140,
        maxWidth: 260,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <strong style={{ fontSize: 12 }}>{slicer.field}</strong>
        {!all && (
          <button type="button" onClick={onClear} style={{ fontSize: 11 }} title="Select all">
            Clear
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 96, overflowY: 'auto' }}>
        <button
          type="button"
          onClick={onClear}
          style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 10,
            border: all ? '2px solid #2b6cb0' : '1px solid #bbb',
            background: all ? '#e3eefc' : '#fff',
            cursor: 'pointer',
          }}
          title="Select all values"
        >
          All
        </button>
        {values.map((v) => {
          const on = all || slicer.selected.includes(v);
          return (
            <button
              key={v}
              type="button"
              onClick={() => onToggle(v)}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 10,
                border: on ? '2px solid #2b6cb0' : '1px solid #bbb',
                background: on ? '#e3eefc' : '#fff',
                cursor: 'pointer',
                maxWidth: 120,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={v}
            >
              {v}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-visual computed data (shared by the React render and the print view)
// ---------------------------------------------------------------------------

export interface ComputedVisual {
  visual: ReportVisual;
  binding: ReportBinding | undefined;
  records: PivotRecord[];
  kpi: KpiResult | null;
  pivot: PivotResult | null;
  pivotMatrix: (string | number | null)[][] | null;
  chartConfig: ChartConfiguration | null;
  chartSvg: 'treemap' | 'sunburst' | 'contour' | 'surface' | 'map' | null;
  chartSeries: ChartSeries | null;
  /** Compound pies: the "Other" breakout chart. */
  chartDetailConfig: ChartConfiguration | null;
  chartDetailTitle: string | null;
  /** 3-D kinds render as their 2-D counterpart (no 3-D pipeline in v1). */
  chartRenderedAs: string | null;
  /** Documented render failure (e.g. Filled Map is out of scope). */
  chartBuildError: string | null;
  tableRows: PivotRecord[] | null;
  heatmap: BuiltHeatmap | null;
  error: string | null;
}

/** Read one binding's records through the typed computational view. */
export type ReadBinding = (binding: ReportBinding) => PivotRecord[];
/** Read one chart source cell through the typed computational view. */
export type ReadChartCell = (sheet: string, row: number, col: number) => { text: string; num: number | null };

/**
 * Compute every visual's data for a report: re-read bindings, apply the
 * page-level typed filters + field-bound slicers, then compute each visual.
 * Pure given the two readers; used by the viewer and the PDF export.
 */
export function computeReportVisuals(
  spec: ReportSpec,
  readBinding: ReadBinding,
  readChartCell: ReadChartCell,
): ComputedVisual[] {
  const bindingRecords = new Map<string, PivotRecord[]>();
  const bindingErrors = new Map<string, string>();
  for (const b of spec.bindings) {
    try {
      bindingRecords.set(b.id, readBinding(b));
    } catch (e) {
      bindingErrors.set(b.id, e instanceof Error ? e.message : String(e));
      bindingRecords.set(b.id, []);
    }
  }

  return spec.visuals.map((visual): ComputedVisual => {
    const base: ComputedVisual = {
      visual,
      binding: spec.bindings.find((b) => b.id === visual.bindingId),
      records: [],
      kpi: null,
      pivot: null,
      pivotMatrix: null,
      chartConfig: null,
      chartSvg: null,
      chartSeries: null,
      chartDetailConfig: null,
      chartDetailTitle: null,
      chartRenderedAs: null,
      chartBuildError: null,
      tableRows: null,
      heatmap: null,
      error: null,
    };
    if (!base.binding) {
      return { ...base, error: `Unknown binding "${visual.bindingId}"` };
    }
    const bindingErr = bindingErrors.get(base.binding.id);
    if (bindingErr) return { ...base, error: bindingErr };
    try {
      const records = applyFiltersAndSlicers(
        bindingRecords.get(base.binding.id) ?? [],
        base.binding,
        spec.slicers,
        spec.filters,
      );
      base.records = records;
      switch (visual.kind) {
        case 'kpi':
          base.kpi = computeKpi(records, visual.kpi);
          break;
        case 'pivot': {
          const pivot = createPivot(records, visual.pivot);
          base.pivot = pivot;
          base.pivotMatrix = pivotToMatrix(pivot);
          break;
        }
        case 'table':
          base.tableRows = records.slice(0, Math.max(1, visual.maxRows));
          break;
        case 'heatmap':
          base.heatmap = buildHeatmap(visual.heatmap);
          break;
        case 'chart': {
          const computed = computeChartVisual(visual.chart, base.binding, records, spec.slicers, spec.filters, readChartCell);
          base.chartConfig = computed.config;
          base.chartSvg = computed.svg;
          base.chartSeries = computed.series;
          base.chartDetailConfig = computed.detailConfig;
          base.chartDetailTitle = computed.detailTitle;
          base.chartRenderedAs = computed.renderedAs;
          base.chartBuildError = computed.buildError;
          break;
        }
      }
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e);
    }
    return base;
  });
}

interface ComputedChart {
  config: ChartConfiguration | null;
  // Matches the service BuiltConfig.svg union (chart lane widened it to
  // cover contour/surface custom-SVG kinds).
  svg: 'treemap' | 'sunburst' | 'contour' | 'surface' | 'map' | null;
  series: ChartSeries | null;
  detailConfig: ChartConfiguration | null;
  detailTitle: string | null;
  renderedAs: string | null;
  buildError: string | null;
}

/**
 * Chart visuals read through their own ChartSpec range. Slicers/filters are
 * applied by projecting the range rows onto the visual's binding fields and
 * compacting out filtered rows, so the chart honors the page slicers.
 */
function computeChartVisual(
  chart: ChartSpec,
  binding: ReportBinding,
  _records: PivotRecord[],
  slicers: ReportSlicer[],
  filters: ReportFilter[],
  readChartCell: ReadChartCell,
): ComputedChart {
  void _records;
  const range = chart.range;
  const rows: { text: string; num: number | null }[][] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    const row: { text: string; num: number | null }[] = [];
    for (let c = range.startCol; c <= range.endCol; c++) row.push(readChartCell(range.sheet, r, c));
    rows.push(row);
  }
  if (rows.length === 0) {
    return {
      config: null,
      svg: null,
      series: null,
      detailConfig: null,
      detailTitle: null,
      renderedAs: null,
      buildError: null,
    };
  }

  // Project rows onto binding fields positionally, then keep the rows that
  // survive the page-level typed filters + field-bound slicers (reuses the
  // tested service pipeline per row to preserve row indices).
  const keep = new Set<number>();
  rows.slice(1).forEach((row, i) => {
    const rec: PivotRecord = {};
    binding.fields.forEach((f, fi) => {
      const cell = row[fi];
      rec[f] = cell ? cell.num ?? (cell.text === '' ? null : cell.text) : null;
    });
    if (applyFiltersAndSlicers([rec], binding, slicers, filters).length === 1) keep.add(i);
  });

  const compact = [rows[0], ...rows.slice(1).filter((_, i) => keep.has(i))];
  const read: CellReader = (r, c) => compact[r]?.[c] ?? { text: '', num: null };
  const compactRange = { ...range, endRow: range.startRow + compact.length - 1 };
  const series = extractSeries(read, compactRange);
  let built: BuiltConfig | null = null;
  let buildError: string | null = null;
  try {
    built = buildChartConfig(chart, series);
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }
  return {
    config: built && !built.svg ? built.config : null,
    detailConfig: built?.detail?.config ?? null,
    detailTitle: built?.detail?.title ?? null,
    renderedAs: built?.renderedAs ?? null,
    svg: built?.svg ?? null,
    series,
    buildError,
  };
}

// ---------------------------------------------------------------------------
// Visual rendering (viewer)
// ---------------------------------------------------------------------------

function MatrixTable({ matrix }: { matrix: (string | number | null)[][] }): JSX.Element {
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
      <tbody>
        {matrix.map((row, ri) => (
          <tr key={ri} style={{ background: ri === 0 || ri === matrix.length - 1 ? '#f2f6fc' : undefined }}>
            {row.map((cell, ci) => {
              const isHeader = ri === 0 || ci === 0 || ri === matrix.length - 1;
              const Tag = isHeader ? 'th' : 'td';
              return (
                <Tag
                  key={ci}
                  style={{
                    border: '1px solid #d0d7e3',
                    padding: '4px 8px',
                    textAlign: typeof cell === 'number' ? 'right' : 'left',
                    fontWeight: isHeader ? 600 : 400,
                  }}
                >
                  {fmtNum(typeof cell === 'number' ? cell : null) || (typeof cell === 'string' ? cell : '')}
                </Tag>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VisualView({ computed }: { computed: ComputedVisual }): JSX.Element {
  const { visual, error } = computed;
  if (error) {
    return <div style={{ color: '#c0392b', fontSize: 12 }}>⚠ {error}</div>;
  }
  switch (visual.kind) {
    case 'kpi':
      return computed.kpi ? <KpiCard result={computed.kpi} /> : <div style={{ fontSize: 12 }}>No data.</div>;
    case 'pivot':
      return computed.pivotMatrix ? (
        <div style={{ overflow: 'auto', maxHeight: 420 }}>
          <MatrixTable matrix={computed.pivotMatrix} />
        </div>
      ) : (
        <div style={{ fontSize: 12 }}>No data.</div>
      );
    case 'heatmap': {
      const heat = computed.heatmap;
      if (!heat || heat.cells.length === 0) {
        return <div style={{ fontSize: 12 }}>No data.</div>;
      }
      const cellAt = (r: number, c: number) => heat.cells.find((cell) => cell.row === r && cell.col === c);
      return (
        <div style={{ overflow: 'auto', maxHeight: 420 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ border: '1px solid #d0d7e3', padding: '4px 8px', background: '#f2f6fc' }} />
                {heat.colLabels.map((label, c) => (
                  <th key={c} style={{ border: '1px solid #d0d7e3', padding: '4px 8px', background: '#f2f6fc', textAlign: 'center' }}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {heat.rowLabels.map((label, r) => (
                <tr key={r}>
                  <th style={{ border: '1px solid #d0d7e3', padding: '4px 8px', background: '#f2f6fc', textAlign: 'left' }}>
                    {label}
                  </th>
                  {heat.colLabels.map((_, c) => {
                    const cell = cellAt(r, c);
                    return (
                      <td
                        key={c}
                        style={{
                          border: '1px solid #d0d7e3',
                          padding: '6px 10px',
                          textAlign: 'center',
                          background: cell?.color ?? '#f3f4f6',
                          color: '#111',
                        }}
                      >
                        {cell && cell.value !== null ? fmtNum(cell.value) : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'table': {
      const fields = visual.fields;
      const rows = computed.tableRows ?? [];
      return (
        <div style={{ overflow: 'auto', maxHeight: 420 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
            <thead>
              <tr style={{ background: '#f2f6fc' }}>
                {fields.map((f) => (
                  <th key={f} style={{ border: '1px solid #d0d7e3', padding: '4px 8px', textAlign: 'left' }}>
                    {f}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {fields.map((f) => (
                    <td key={f} style={{ border: '1px solid #d0d7e3', padding: '4px 8px' }}>
                      {r[f] === null || r[f] === undefined || r[f] === ''
                        ? ''
                        : typeof r[f] === 'number'
                          ? fmtNum(r[f] as number)
                          : String(r[f])}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={fields.length} style={{ padding: 8, color: '#888', textAlign: 'center' }}>
                    No rows match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      );
    }
    case 'chart': {
      if (computed.chartBuildError) {
        return <div style={{ fontSize: 12, color: '#a00' }}>{computed.chartBuildError}</div>;
      }
      if (computed.chartSvg === 'treemap' || computed.chartSvg === 'sunburst') {
        const labels = computed.chartSeries?.labels ?? [];
        const values = (computed.chartSeries?.datasets[0]?.data ?? []).map((v) =>
          typeof v === 'number' ? v : 0,
        );
        const Svg = computed.chartSvg === 'treemap' ? TreemapSvg : SunburstSvg;
        return (
          <div data-visual-id={visual.id}>
            <Svg labels={labels} values={values} width={440} height={300} title={visual.title} />
          </div>
        );
      }
      if (computed.chartSvg === 'contour' || computed.chartSvg === 'surface') {
        const Svg = computed.chartSvg === 'contour' ? ContourSvg : SurfaceSvg;
        const wireframe =
          computed.chartSvg === 'contour'
            ? visual.chart?.kind === 'contour-wireframe'
            : visual.chart?.kind === 'surface-3d-wireframe';
        return (
          <div data-visual-id={visual.id}>
            <Svg
              series={computed.chartSeries ?? { labels: [], datasets: [] }}
              width={440}
              height={300}
              title={visual.title}
              wireframe={wireframe}
            />
          </div>
        );
      }
      return computed.chartConfig ? (
        <div data-visual-id={visual.id}>
          <ChartCanvas config={computed.chartConfig} width={440} height={300} title={visual.title} />
          {computed.chartDetailConfig && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>{computed.chartDetailTitle}</div>
              <ChartCanvas config={computed.chartDetailConfig} width={440} height={220} title={computed.chartDetailTitle ?? ''} />
            </div>
          )}
          {computed.chartRenderedAs && (
            <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>
              Renders as {computed.chartRenderedAs} in v1 (no 3-D pipeline).
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12 }}>No data.</div>
      );
    }
    default:
      // Unreachable: ReportVisual.kind is a closed union.
      throw new Error(`unknown report visual kind "${(visual as { kind: string }).kind}"`);
  }
}

// ---------------------------------------------------------------------------
// Native PDF export (Download-as-PDF path)
//
// design-docs/native-reports-and-dashboards.md §8: "Export to PDF through
// the Download as PDF path. The layout renderer handles pagination."
// Computed visuals are mapped to report PDF blocks and rendered to real
// PDF bytes by the service renderer (renderReportPdf) — no window.print(),
// no browser print dialog. Charts are captured as JPEG images (canvas
// charts directly; SVG charts rasterized through a canvas on white).
// ---------------------------------------------------------------------------

export interface ReportChartImage {
  visualId: string;
  jpeg: Uint8Array;
}

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Canvas → JPEG bytes on a white background (JPEG has no alpha channel). */
function canvasToJpeg(canvas: HTMLCanvasElement): Uint8Array | null {
  try {
    const out = document.createElement('canvas');
    out.width = Math.max(1, canvas.width);
    out.height = Math.max(1, canvas.height);
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    return dataUrlToBytes(out.toDataURL('image/jpeg', 0.92));
  } catch {
    return null; // tainted canvas — skip the image, keep the title
  }
}

/** SVG → JPEG bytes, rasterized through a canvas on a white background. */
async function svgToJpeg(svg: SVGSVGElement): Promise<Uint8Array | null> {
  let url = '';
  try {
    const xml = new XMLSerializer().serializeToString(svg);
    url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg raster failed'));
      img.src = url;
    });
    const w = Math.max(1, Math.round(img.naturalWidth || Number(svg.getAttribute('width')) || 440));
    const h = Math.max(1, Math.round(img.naturalHeight || Number(svg.getAttribute('height')) || 300));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92));
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * Capture every chart visual as JPEG bytes, in DOM order. A compound pie's
 * "Other" breakout canvas follows its main chart inside the same
 * [data-visual-id] holder, so both are captured.
 */
async function captureChartImages(root: HTMLElement): Promise<ReportChartImage[]> {
  const images: ReportChartImage[] = [];
  const holders = root.querySelectorAll('[data-visual-id]');
  for (const holder of holders) {
    const visualId = holder.getAttribute('data-visual-id');
    if (!visualId) continue;
    const canvases: HTMLCanvasElement[] = [];
    if (holder instanceof HTMLCanvasElement) canvases.push(holder);
    holder.querySelectorAll('canvas').forEach((el) => canvases.push(el as HTMLCanvasElement));
    for (const canvas of canvases) {
      const jpeg = canvasToJpeg(canvas);
      if (jpeg) images.push({ visualId, jpeg });
    }
    const svgs: SVGSVGElement[] = [];
    if (holder instanceof SVGSVGElement) svgs.push(holder);
    holder.querySelectorAll('svg').forEach((el) => svgs.push(el as SVGSVGElement));
    for (const svg of svgs) {
      const jpeg = await svgToJpeg(svg);
      if (jpeg) images.push({ visualId, jpeg });
    }
  }
  return images;
}

const cellText = (v: string | number | null): string =>
  v === null ? '' : typeof v === 'number' ? fmtNum(v) : String(v);

/**
 * Map computed report visuals to PDF blocks for the native renderer.
 * Covers every visual kind the viewer renders: kpi, pivot, table, heatmap,
 * chart (with the "Other" breakout image), plus errors and empty states.
 */
export function buildReportPdfBlocks(
  spec: ReportSpec,
  computed: ComputedVisual[],
  chartImages: ReportChartImage[],
): ReportPdfBlock[] {
  const blocks: ReportPdfBlock[] = [];
  const visuals = spec.layout.cells
    .slice()
    .sort((a, b) => a.row - b.row || a.col - b.col);
  for (const cell of visuals) {
    const c = computed.find((x) => x.visual.id === cell.visualId);
    if (!c) continue;
    blocks.push({ kind: 'heading', text: c.visual.title });
    if (c.error) {
      blocks.push({ kind: 'note', text: `⚠ ${c.error}` });
      continue;
    }
    switch (c.visual.kind) {
      case 'kpi': {
        if (!c.kpi) {
          blocks.push({ kind: 'note', text: 'No data.' });
          break;
        }
        const r = c.kpi;
        const up = (r.delta ?? 0) >= 0;
        blocks.push({
          kind: 'kpiRow',
          kpis: [
            {
              label: r.label,
              value: r.formatted,
              color: KPI_COLORS[r.status],
              deltaText:
                r.deltaFormatted !== null
                  ? `${up ? '▲' : '▼'} ${r.deltaFormatted}${
                      r.deltaPct !== null ? ` (${r.deltaPct >= 0 ? '+' : ''}${Math.round(r.deltaPct * 10) / 10}% vs target)` : ''
                    }`
                  : null,
              deltaColor: r.deltaFormatted !== null ? (up ? '#1a7f37' : '#c0392b') : null,
              targetText: r.targetFormatted !== null ? `Target: ${r.targetFormatted}` : null,
            },
          ],
        });
        break;
      }
      case 'pivot': {
        if (!c.pivotMatrix || c.pivotMatrix.length === 0) {
          blocks.push({ kind: 'note', text: 'No data.' });
          break;
        }
        const [head, ...body] = c.pivotMatrix;
        blocks.push({
          kind: 'table',
          headers: head.map((v) => ({ text: cellText(v), bold: true })),
          rows: body.map((row) => row.map((v) => ({ text: cellText(v) }))),
        });
        break;
      }
      case 'table': {
        const fields = c.visual.fields;
        const rows = c.tableRows ?? [];
        if (rows.length === 0) {
          blocks.push({ kind: 'note', text: 'No rows match the current filters.' });
          break;
        }
        blocks.push({
          kind: 'table',
          headers: fields.map((f) => ({ text: f, bold: true })),
          rows: rows.map((r) =>
            fields.map((f) => {
              const v = r[f];
              return { text: v === null || v === undefined ? '' : typeof v === 'number' ? fmtNum(v) : String(v) };
            }),
          ),
        });
        break;
      }
      case 'heatmap': {
        const heat = c.heatmap;
        if (!heat || heat.cells.length === 0) {
          blocks.push({ kind: 'note', text: 'No data.' });
          break;
        }
        const cellAt = (r: number, cc: number) => heat.cells.find((x) => x.row === r && x.col === cc);
        blocks.push({
          kind: 'table',
          headers: [{ text: '', bold: true }, ...heat.colLabels.map((l) => ({ text: l, bold: true, align: 'center' as const }))],
          rows: heat.rowLabels.map((label, r) => [
            { text: label, bold: true },
            ...heat.colLabels.map((_, cc) => {
              const found = cellAt(r, cc);
              return {
                text: found && found.value !== null ? fmtNum(found.value) : '',
                fill: found?.color ?? '#f3f4f6',
                align: 'center' as const,
              };
            }),
          ]),
        });
        break;
      }
      case 'chart': {
        if (c.chartBuildError) {
          blocks.push({ kind: 'note', text: c.chartBuildError });
          break;
        }
        const imgs = chartImages.filter((i) => i.visualId === c.visual.id);
        if (imgs.length === 0) {
          blocks.push({ kind: 'note', text: 'No chart image.' });
        } else {
          imgs.forEach((img, idx) => {
            blocks.push({
              kind: 'image',
              jpeg: img.jpeg,
              // The compound-pie "Other" breakout canvas follows the main chart.
              caption: idx > 0 ? c.chartDetailTitle : null,
            });
          });
        }
        if (c.chartRenderedAs) {
          blocks.push({ kind: 'note', text: `Renders as ${c.chartRenderedAs} in v1 (no 3-D pipeline).` });
        }
        break;
      }
    }
  }
  return blocks;
}

// Report viewer dialog
// ---------------------------------------------------------------------------

/**
 * Result of running one ETL recipe for a report refresh: the run record,
 * plus the bindings with refreshed geometry (expanded ranges / re-read
 * fields when the loaded table changed shape), in the same order as the
 * input bindings.
 */
export interface EtlBindingRefreshResult {
  run: RunRecord;
  bindings: ReportBinding[];
}

/**
 * Host port for ETL-backed report tables (design §6): run the recipe and
 * load its output table into each of the given bindings' sheet ranges.
 */
export type EtlBindingRunner = (
  recipeId: string,
  bindings: ReportBinding[],
) => Promise<EtlBindingRefreshResult>;

interface ReportViewerDialogProps {
  spec: ReportSpec;
  readBinding: ReadBinding;
  readChartCell: ReadChartCell;
  onUpdate: (spec: ReportSpec) => void;
  onEdit: () => void;
  onClose: () => void;
  /**
   * Run ETL-backed bindings through the pipeline on refresh (design §6).
   * Absent = ETL-backed tables are read as-is; the viewer says so.
   */
  runEtlBindings?: EtlBindingRunner;
}

export function ReportViewerDialog({
  spec,
  readBinding,
  readChartCell,
  onUpdate,
  onEdit,
  onClose,
  runEtlBindings,
}: ReportViewerDialogProps): JSX.Element {
  const [slicers, setSlicers] = useState<ReportSlicer[]>(spec.slicers);
  const [dataAsOf, setDataAsOf] = useState<string | null>(spec.dataAsOf);
  const [tick, setTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [etlStatus, setEtlStatus] = useState<string | null>(null);
  const refreshingRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const liveSpec: ReportSpec = useMemo(
    () => ({ ...spec, slicers, dataAsOf }),
    [spec, slicers, dataAsOf],
  );

  const computed = useMemo(
    () => computeReportVisuals(liveSpec, readBinding, readChartCell),
    // Recompute on refresh tick or slicer/data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveSpec, tick],
  );

  const readBindingSafe = (b: ReportBinding): PivotRecord[] => {
    try {
      return readBinding(b);
    } catch {
      return [];
    }
  };

  // Slicer value lists: union of distinct values across bindings that include the field.
  const slicerValues = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of slicers) {
      const set = new Set<string>();
      for (const c of computed) {
        if (c.binding && c.binding.fields.includes(s.field)) {
          // Use the unfiltered binding records for the value list.
          for (const v of distinctFieldValues(readBindingSafe(c.binding), s.field)) set.add(v);
        }
      }
      map.set(s.id, [...set].sort());
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.bindings, slicers, tick]);

  /**
   * Refresh (design §6): ETL-backed tables refresh through the pipeline —
   * each distinct referenced recipe runs once via the host port before the
   * visuals recompute. Plain bindings are simply re-read. Manual refresh,
   * refresh-on-open, and due scheduled refreshes all flow through here.
   */
  const refresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setEtlStatus(null);
    let nextSpec = liveSpec;
    try {
      const recipeIds = collectEtlRecipeIds(liveSpec);
      if (recipeIds.length > 0) {
        if (!runEtlBindings) {
          setEtlStatus('ETL-backed tables were read as-is: this host cannot run ETL pipelines.');
        } else {
          const problems: string[] = [];
          const updated = new Map<string, ReportBinding>();
          let done = 0;
          const summary: EtlRefreshSummary = await refreshReportEtlBindings(liveSpec, {
            runEtlRecipe: async (recipeId: string) => {
              done += 1;
              setEtlStatus(`Running ETL pipeline ${done}/${recipeIds.length}…`);
              const targets = liveSpec.bindings.filter((b) => b.etlRecipeId === recipeId);
              const { run, bindings } = await runEtlBindings(recipeId, targets);
              for (const b of bindings) updated.set(b.id, b);
              if (run.status !== 'succeeded') {
                problems.push(`"${run.recipeName}": ${run.status}${run.error ? ` — ${run.error}` : ''}`);
              }
              return run;
            },
          });
          for (const t of summary.thrown) problems.push(`"${t.recipeId}": ${t.error}`);
          if (updated.size > 0) {
            nextSpec = {
              ...liveSpec,
              bindings: liveSpec.bindings.map((b) => updated.get(b.id) ?? b),
            };
          }
          setEtlStatus(
            problems.length > 0
              ? `ETL refresh issues: ${problems.join('; ')}`
              : `ETL pipelines refreshed (${recipeIds.length}).`,
          );
        }
      }
    } finally {
      const now = new Date().toISOString();
      setDataAsOf(now);
      setTick((t) => t + 1);
      onUpdate({ ...nextSpec, dataAsOf: now });
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  // Auto-refresh on open when the spec asks for it.
  const autoRefreshed = useRef(false);
  if (!autoRefreshed.current) {
    autoRefreshed.current = true;
    if (spec.refresh.mode === 'onOpen' || (spec.refresh.mode === 'scheduled' && isRefreshDue(spec))) {
      // Defer to an effect-like microtask so the first paint uses cached data.
      // ETL-backed tables run through the pipeline here too (design §6).
      setTimeout(() => {
        void refresh();
      }, 0);
    }
  }

  const setSlicer = (id: string, next: ReportSlicer) => {
    const updated = slicers.map((s) => (s.id === id ? next : s));
    setSlicers(updated);
    onUpdate({ ...liveSpec, slicers: updated });
  };

  const exportPdf = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const images = bodyRef.current ? await captureChartImages(bodyRef.current) : [];
      const blocks = buildReportPdfBlocks(liveSpec, computed, images);
      const bytes = renderReportPdf({
        title: liveSpec.name,
        meta: [
          `Data as of ${formatDataAsOf(liveSpec.dataAsOf)}`,
          ...(liveSpec.slicers.length === 0
            ? []
            : [
                `Slicers: ${liveSpec.slicers
                  .map((s) => `${s.field}: ${s.selected.length === 0 ? 'All' : s.selected.join(', ')}`)
                  .join(' · ')}`,
              ]),
        ],
        blocks,
      });
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${liveSpec.name || 'report'}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const cells = useMemo(
    () => [...liveSpec.layout.cells].sort((a, b) => a.row - b.row || a.col - b.col),
    [liveSpec.layout],
  );
  const cols = Math.max(1, liveSpec.layout.columns);

  return (
    <A11yDialog title={<>{liveSpec.name}</>} width={1180} onClose={onClose}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#666' }}>
            Data as of {formatDataAsOf(dataAsOf)}
          </span>
          {etlStatus && (
            <span style={{ fontSize: 11, color: '#8a6d00' }} title="ETL pipeline refresh status">
              {etlStatus}
            </span>
          )}
          {liveSpec.refresh.mode === 'scheduled' && liveSpec.refresh.schedule && (
            <span style={{ fontSize: 11, color: '#767676' }}>
              (scheduled: {liveSpec.refresh.schedule.kind}
              {liveSpec.refresh.schedule.time ? ` ${liveSpec.refresh.schedule.time}` : ''})
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            disabled={refreshing}
            title="Re-read all bindings from the workbook (ETL-backed tables reload through their pipelines)"
          >
            ↻ {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={() => {
              void exportPdf();
            }}
            disabled={exporting}
            title="Export this report as PDF"
          >
            ⤓ PDF
          </button>
          <button type="button" onClick={onEdit} title="Edit this report in the builder">Edit</button>
        </div>
        {slicers.length > 0 && (
          <div style={{ display: 'flex', gap: 8, padding: '8px 14px', borderBottom: '1px solid #eee', overflowX: 'auto' }}>
            {slicers.map((s) => (
              <SlicerControl
                key={s.id}
                slicer={s}
                values={slicerValues.get(s.id) ?? []}
                onToggle={(v) => setSlicer(s.id, toggleSlicerValue(s, v, slicerValues.get(s.id) ?? []))}
                onClear={() => setSlicer(s.id, clearReportSlicer(s))}
              />
            ))}
          </div>
        )}
        <div ref={bodyRef} style={{ flex: 1, overflow: 'auto', padding: 16, background: '#f4f6fa' }}>
          {cells.length === 0 && <p style={{ color: '#888' }}>This report has no visuals yet.</p>}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap: 12,
            }}
          >
            {cells.map((cell) => {
              const c = computed.find((x) => x.visual.id === cell.visualId);
              if (!c) return null;
              return (
                <div
                  key={cell.visualId}
                  style={{
                    gridColumn: `span ${Math.min(cell.colSpan, cols)}`,
                    background: '#fff',
                    border: '1px solid #e0e4ec',
                    borderRadius: 8,
                    padding: 12,
                    minWidth: 0,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{c.visual.title}</div>
                  <VisualView computed={c} />
                </div>
              );
            })}
          </div>
        </div>
    </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Report list dialog
// ---------------------------------------------------------------------------

interface ReportListDialogProps {
  reports: ReportSpec[];
  onOpen: (spec: ReportSpec) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function ReportListDialog({ reports, onOpen, onDelete, onNew, onClose }: ReportListDialogProps): JSX.Element {
  return (
    <A11yDialog title="Reports" width={560} onClose={onClose}>
        <div style={{ marginBottom: 8 }}>
          <button type="button" onClick={onNew}>+ New report</button>
        </div>
        <div style={{ overflowY: 'auto', padding: 8 }}>
          {reports.length === 0 && <p style={{ color: '#888', padding: 8 }}>No reports yet. Create one to get started.</p>}
          {reports.map((r) => (
            <div
              key={r.id}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderBottom: '1px solid #f0f0f0' }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</div>
                <div style={{ fontSize: 11, color: '#888' }}>
                  {r.visuals.length} visual{r.visuals.length === 1 ? '' : 's'} · {r.slicers.length} slicer{r.slicers.length === 1 ? '' : 's'} · data as of {formatDataAsOf(r.dataAsOf)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => onOpen(r)}>Open</button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete report "${r.name}"?`)) onDelete(r.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
    </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Report builder dialog
// ---------------------------------------------------------------------------

interface ReportBuilderDialogProps {
  editing: ReportSpec | null;
  source: ReportSourceInfo | null;
  charts: AvailableChart[];
  pivots: AvailablePivot[];
  readHeaders: (sheet: string, row: number, startCol: number, endCol: number) => string[];
  onSave: (spec: ReportSpec) => void;
  onClose: () => void;
  /** ETL recipes available to back a table (design §6). */
  etlRecipes?: Array<{ id: string; name: string }>;
}

const KIND_LABELS: Record<ReportVisualKind, string> = {
  chart: 'Chart',
  pivot: 'PivotTable',
  kpi: 'KPI card',
  heatmap: 'Heatmap',
  table: 'Table',
};

let builderSeq = 0;
const nextBuilderId = (prefix: string): string => {
  builderSeq += 1;
  return `${prefix}-${Date.now()}-${builderSeq}`;
};

export function ReportBuilderDialog({
  editing,
  source,
  charts,
  pivots,
  readHeaders,
  onSave,
  onClose,
  etlRecipes,
}: ReportBuilderDialogProps): JSX.Element {
  const [name, setName] = useState(editing?.name ?? 'Untitled report');
  const [bindings, setBindings] = useState<ReportBinding[]>(() => {
    if (editing) return editing.bindings;
    if (!source) return [];
    return [
      migrateBinding({
        id: nextBuilderId('b'),
        name: source.sheet,
        sheet: source.sheet,
        startRow: source.range.startRow,
        startCol: source.range.startCol,
        endRow: source.range.endRow,
        endCol: source.range.endCol,
        headerRow: source.range.startRow,
        fields: source.headers,
      }),
    ];
  });
  const [visuals, setVisuals] = useState<ReportVisual[]>(editing?.visuals ?? []);
  const [slicers, setSlicers] = useState<ReportSlicer[]>(editing?.slicers ?? []);
  const [filters, setFilters] = useState<ReportFilter[]>(editing?.filters ?? []);
  const [columns, setColumns] = useState(editing?.layout.columns ?? 2);
  const [refreshMode, setRefreshMode] = useState<RefreshMode>(editing?.refresh.mode ?? 'manual');
  const [schedKind, setSchedKind] = useState<'hourly' | 'daily' | 'weekly'>(editing?.refresh.schedule?.kind ?? 'daily');
  const [schedTime, setSchedTime] = useState(editing?.refresh.schedule?.time ?? '08:00');
  const [errors, setErrors] = useState<string[]>([]);

  // Add-visual forms.
  const [chartPick, setChartPick] = useState('');
  const [pivotPick, setPivotPick] = useState('');
  const [kpiBinding, setKpiBinding] = useState('');
  const [kpiField, setKpiField] = useState('');
  const [kpiAgg, setKpiAgg] = useState<KpiSpec['aggregation']>('sum');
  const [kpiLabel, setKpiLabel] = useState('');
  const [kpiTarget, setKpiTarget] = useState('');
  const [kpiGoodAt, setKpiGoodAt] = useState('');
  const [kpiWarnAt, setKpiWarnAt] = useState('');
  const [tblBinding, setTblBinding] = useState('');
  const [tblFields, setTblFields] = useState<string[]>([]);
  const [slicerField, setSlicerField] = useState('');
  const [fltField, setFltField] = useState('');
  const [fltOp, setFltOp] = useState<ReportFilterOp>('=');
  const [fltValue, setFltValue] = useState('');

  const allFields = useMemo(() => {
    const set = new Set<string>();
    for (const b of bindings) for (const f of b.fields) set.add(f);
    return [...set];
  }, [bindings]);
  const bindingById = useMemo(() => new Map(bindings.map((b) => [b.id, b])), [bindings]);

  /** Get or create a binding for a sheet range (fields read from the header row). */
  const ensureBinding = (sheet: string, range: { startRow: number; startCol: number; endRow: number; endCol: number }): ReportBinding => {
    const hit = bindings.find(
      (b) => b.sheet === sheet && b.startRow === range.startRow && b.startCol === range.startCol && b.endRow === range.endRow && b.endCol === range.endCol,
    );
    if (hit) return hit;
    const fields = readHeaders(sheet, range.startRow, range.startCol, range.endCol);
    const b = migrateBinding({
      id: nextBuilderId('b'),
      name: sheet,
      sheet,
      ...range,
      headerRow: range.startRow,
      fields: fields.length > 0 ? fields : Array.from({ length: range.endCol - range.startCol + 1 }, (_, i) => `Column ${i + 1}`),
    });
    setBindings((prev) => [...prev, b]);
    return b;
  };

  const moveVisual = (id: string, dir: -1 | 1) => {
    setVisuals((prev) => {
      const i = prev.findIndex((v) => v.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const addChart = () => {
    const pick = charts.find((c) => String(c.id) === chartPick);
    if (!pick) return;
    const b = ensureBinding(pick.spec.range.sheet, pick.spec.range);
    const chart: ChartSpec = JSON.parse(JSON.stringify(pick.spec)) as ChartSpec;
    setVisuals((prev) => [
      ...prev,
      { id: nextBuilderId('v'), title: pick.title || kindLabel(chart.kind), bindingId: b.id, kind: 'chart', chart },
    ]);
    setChartPick('');
  };

  const addPivot = () => {
    const pick = pivots.find((p) => String(p.id) === pivotPick);
    if (!pick) return;
    const b = ensureBinding(pick.sourceSheet, pick.sourceRange);
    const pivot: PivotSpec = JSON.parse(JSON.stringify(pick.spec)) as PivotSpec;
    setVisuals((prev) => [...prev, { id: nextBuilderId('v'), title: pick.title, bindingId: b.id, kind: 'pivot', pivot }]);
    setPivotPick('');
  };

  const addKpi = () => {
    const b = bindingById.get(kpiBinding);
    if (!b || !kpiField) return;
    const thresholds: KpiSpec['thresholds'] = [];
    const goodAt = Number(kpiGoodAt);
    const warnAt = Number(kpiWarnAt);
    if (Number.isFinite(goodAt) && kpiGoodAt.trim() !== '') thresholds.push({ value: goodAt, status: 'good' });
    if (Number.isFinite(warnAt) && kpiWarnAt.trim() !== '') thresholds.push({ value: warnAt, status: 'warn' });
    const target = kpiTarget.trim() === '' ? null : Number(kpiTarget);
    const kpi = makeKpiSpec({
      field: kpiField,
      aggregation: kpiAgg,
      label: kpiLabel.trim() || kpiField,
      target: Number.isFinite(target) ? target : null,
      thresholds,
    });
    setVisuals((prev) => [...prev, { id: nextBuilderId('v'), title: kpi.label, bindingId: b.id, kind: 'kpi', kpi }]);
    setKpiField('');
    setKpiLabel('');
    setKpiTarget('');
    setKpiGoodAt('');
    setKpiWarnAt('');
  };

  const addTable = () => {
    const b = bindingById.get(tblBinding);
    if (!b || tblFields.length === 0) return;
    setVisuals((prev) => [
      ...prev,
      { id: nextBuilderId('v'), title: 'Table', bindingId: b.id, kind: 'table', fields: [...tblFields], maxRows: 50 },
    ]);
    setTblFields([]);
  };

  const addSlicer = () => {
    if (!slicerField) return;
    setSlicers((prev) => [...prev, makeReportSlicer({ id: nextBuilderId('s'), field: slicerField })]);
    setSlicerField('');
  };

  const addFilter = () => {
    if (!fltField) return;
    const value: string | number = fltValue.trim() !== '' && !Number.isNaN(Number(fltValue)) ? Number(fltValue) : fltValue;
    setFilters((prev) => [...prev, { id: nextBuilderId('f'), field: fltField, op: fltOp, value }]);
    setFltField('');
    setFltValue('');
  };

  const save = () => {
    // Preserve existing layout cells for kept visuals; append new ones.
    const keptCells = new Map<string, ReportLayoutCell>();
    if (editing) {
      for (const c of editing.layout.cells) keptCells.set(c.visualId, c);
    }
    const cells: ReportLayoutCell[] = [];
    let nextRow = 0;
    for (const v of visuals) {
      const kept = keptCells.get(v.id);
      if (kept) {
        cells.push(kept);
        nextRow = Math.max(nextRow, kept.row + kept.rowSpan);
      } else {
        cells.push({ visualId: v.id, row: nextRow, col: 0, rowSpan: 1, colSpan: Math.min(2, columns) });
        nextRow += 1;
      }
    }
    const spec = makeReportSpec({
      ...(editing ? { id: editing.id, dataAsOf: editing.dataAsOf } : {}),
      name: name.trim() || 'Untitled report',
      bindings,
      visuals,
      slicers,
      filters,
      layout: { columns, cells },
      refresh:
        refreshMode === 'scheduled'
          ? { mode: 'scheduled', schedule: { kind: schedKind, time: schedTime } }
          : { mode: refreshMode, schedule: null },
    });
    const errs = validateReportSpec(spec);
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);
    onSave(spec);
  };

  const fieldCtl = '1px solid #bbb';
  const section: React.CSSProperties = { borderTop: '1px solid #eee', padding: '10px 0' };

  return (
    <A11yDialog title={<>{editing ? 'Edit report' : 'New report'}</>} width={760} onClose={onClose}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button type="button" onClick={save}>Save</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '0 14px 14px', fontSize: 13 }}>
          {errors.length > 0 && (
            <div style={{ background: '#fdecea', border: '1px solid #e0a3a3', borderRadius: 6, padding: 8, marginTop: 10 }}>
              <strong>Cannot save:</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ padding: '10px 0' }}>
            <label>
              Report name{' '}
              <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 280, border: fieldCtl }} />
            </label>
            <label style={{ marginLeft: 16 }}>
              Layout columns{' '}
              <input
                type="number"
                min={1}
                max={4}
                value={columns}
                onChange={(e) => setColumns(Math.min(4, Math.max(1, Number(e.target.value) || 2)))}
                style={{ width: 48, border: fieldCtl }}
              />
            </label>
          </div>

          <div style={section}>
            <h4 style={{ margin: '0 0 8px' }}>Tables ({bindings.length})</h4>
            {bindings.map((b) => (
              <div key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                <span style={{ flex: 1 }}>
                  {b.name}{' '}
                  <span style={{ fontSize: 11, color: '#888' }}>
                    {b.sheet}!R{b.startRow + 1}C{b.startCol + 1}:R{b.endRow + 1}C{b.endCol + 1}
                  </span>
                </span>
                <label style={{ fontSize: 12 }}>
                  ETL pipeline{' '}
                  <select
                    value={b.etlRecipeId ?? ''}
                    onChange={(e) =>
                      setBindings((prev) =>
                        prev.map((x) =>
                          x.id === b.id
                            ? { ...x, etlRecipeId: e.target.value === '' ? undefined : e.target.value }
                            : x,
                        ),
                      )
                    }
                    style={{ border: fieldCtl }}
                    title="Pipeline that reloads this table on report refresh (design §6)"
                  >
                    <option value="">— none —</option>
                    {(etlRecipes ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
            {bindings.length === 0 && <p style={{ color: '#888' }}>No tables yet — add a visual below.</p>}
            <p style={{ fontSize: 11, color: '#888', margin: '4px 0 0' }}>
              An ETL-backed table is reloaded through its pipeline on every report refresh
              (manual, on-open, and scheduled) — design §6.
            </p>
          </div>

          <div style={section}>
            <h4 style={{ margin: '0 0 8px' }}>Visuals ({visuals.length})</h4>
            {visuals.map((v, i) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <span style={{ fontSize: 11, background: '#eef2f7', borderRadius: 4, padding: '1px 6px' }}>{KIND_LABELS[v.kind]}</span>
                <span style={{ flex: 1 }}>{v.title}</span>
                <button type="button" onClick={() => moveVisual(v.id, -1)} disabled={i === 0} title="Move up">↑</button>
                <button type="button" onClick={() => moveVisual(v.id, 1)} disabled={i === visuals.length - 1} title="Move down">↓</button>
                <button type="button" onClick={() => setVisuals((prev) => prev.filter((x) => x.id !== v.id))}>Remove</button>
              </div>
            ))}
            {visuals.length === 0 && <p style={{ color: '#888' }}>No visuals yet — add one below.</p>}

            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <label>
                Chart{' '}
                <select value={chartPick} onChange={(e) => setChartPick(e.target.value)} style={{ border: fieldCtl }}>
                  <option value="">— pick a chart —</option>
                  {charts.map((c) => (
                    <option key={c.id} value={c.id}>{c.title} ({kindLabel(c.spec.kind)})</option>
                  ))}
                </select>{' '}
                <button type="button" onClick={addChart} disabled={!chartPick}>Add</button>
              </label>
              <label>
                PivotTable{' '}
                <select value={pivotPick} onChange={(e) => setPivotPick(e.target.value)} style={{ border: fieldCtl }}>
                  <option value="">— pick a PivotTable —</option>
                  {pivots.map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>{' '}
                <button type="button" onClick={addPivot} disabled={!pivotPick}>Add</button>
              </label>
            </div>

            <fieldset style={{ marginTop: 8 }}>
              <legend>Add KPI card</legend>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                <label>
                  Table<br />
                  <select value={kpiBinding} onChange={(e) => { setKpiBinding(e.target.value); setKpiField(''); }} style={{ border: fieldCtl }}>
                    <option value="">—</option>
                    {bindings.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Field<br />
                  <select value={kpiField} onChange={(e) => setKpiField(e.target.value)} style={{ border: fieldCtl }}>
                    <option value="">—</option>
                    {(bindingById.get(kpiBinding)?.fields ?? []).map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Aggregation<br />
                  <select value={kpiAgg} onChange={(e) => setKpiAgg(e.target.value as KpiSpec['aggregation'])} style={{ border: fieldCtl }}>
                    {(['sum', 'average', 'count', 'countnums', 'max', 'min'] as const).map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Label<br />
                  <input value={kpiLabel} onChange={(e) => setKpiLabel(e.target.value)} placeholder={kpiField || 'Label'} style={{ width: 120, border: fieldCtl }} />
                </label>
                <label>
                  Target<br />
                  <input value={kpiTarget} onChange={(e) => setKpiTarget(e.target.value)} placeholder="optional" style={{ width: 90, border: fieldCtl }} />
                </label>
                <label>
                  Good ≥<br />
                  <input value={kpiGoodAt} onChange={(e) => setKpiGoodAt(e.target.value)} placeholder="optional" style={{ width: 80, border: fieldCtl }} />
                </label>
                <label>
                  Warn ≥<br />
                  <input value={kpiWarnAt} onChange={(e) => setKpiWarnAt(e.target.value)} placeholder="optional" style={{ width: 80, border: fieldCtl }} />
                </label>
                <button type="button" onClick={addKpi} disabled={!kpiBinding || !kpiField}>Add KPI</button>
              </div>
            </fieldset>

            <fieldset style={{ marginTop: 8 }}>
              <legend>Add table</legend>
              <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
                <label>
                  Table<br />
                  <select value={tblBinding} onChange={(e) => { setTblBinding(e.target.value); setTblFields([]); }} style={{ border: fieldCtl }}>
                    <option value="">—</option>
                    {bindings.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </label>
                <div>
                  Fields<br />
                  {(bindingById.get(tblBinding)?.fields ?? []).map((f) => (
                    <label key={f} style={{ marginRight: 8, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={tblFields.includes(f)}
                        onChange={(e) =>
                          setTblFields((prev) => (e.target.checked ? [...prev, f] : prev.filter((x) => x !== f)))
                        }
                      />{' '}
                      {f}
                    </label>
                  ))}
                </div>
                <button type="button" onClick={addTable} disabled={!tblBinding || tblFields.length === 0}>Add table</button>
              </div>
            </fieldset>
          </div>

          <div style={section}>
            <h4 style={{ margin: '0 0 8px' }}>Slicers ({slicers.length})</h4>
            {slicers.map((s) => (
              <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                <span>{s.field}</span>
                <span style={{ fontSize: 11, color: '#888' }}>
                  filters every visual whose table includes this field
                </span>
                <button type="button" onClick={() => setSlicers((prev) => prev.filter((x) => x.id !== s.id))}>Remove</button>
              </div>
            ))}
            <div style={{ marginTop: 6 }}>
              <select value={slicerField} onChange={(e) => setSlicerField(e.target.value)} style={{ border: fieldCtl }}>
                <option value="">— pick a field —</option>
                {allFields.filter((f) => !slicers.some((s) => s.field === f)).map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>{' '}
              <button type="button" onClick={addSlicer} disabled={!slicerField}>Add slicer</button>
            </div>
          </div>

          <div style={section}>
            <h4 style={{ margin: '0 0 8px' }}>Filters ({filters.length})</h4>
            {filters.map((f) => (
              <div key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                <span>{f.field} {REPORT_FILTER_OPS.find((o) => o.id === f.op)?.label} {String(f.value)}</span>
                <button type="button" onClick={() => setFilters((prev) => prev.filter((x) => x.id !== f.id))}>Remove</button>
              </div>
            ))}
            <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
              <label>
                Field<br />
                <select value={fltField} onChange={(e) => setFltField(e.target.value)} style={{ border: fieldCtl }}>
                  <option value="">—</option>
                  {allFields.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </label>
              <label>
                Op<br />
                <select value={fltOp} onChange={(e) => setFltOp(e.target.value as ReportFilterOp)} style={{ border: fieldCtl }}>
                  {REPORT_FILTER_OPS.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Value<br />
                <input value={fltValue} onChange={(e) => setFltValue(e.target.value)} style={{ width: 120, border: fieldCtl }} />
              </label>
              <button type="button" onClick={addFilter} disabled={!fltField}>Add filter</button>
            </div>
          </div>

          <div style={section}>
            <h4 style={{ margin: '0 0 8px' }}>Refresh</h4>
            <label style={{ marginRight: 12 }}>
              <input type="radio" checked={refreshMode === 'manual'} onChange={() => setRefreshMode('manual')} /> Manual
            </label>
            <label style={{ marginRight: 12 }}>
              <input type="radio" checked={refreshMode === 'onOpen'} onChange={() => setRefreshMode('onOpen')} /> On open
            </label>
            <label>
              <input type="radio" checked={refreshMode === 'scheduled'} onChange={() => setRefreshMode('scheduled')} /> Scheduled
            </label>
            {refreshMode === 'scheduled' && (
              <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                <select value={schedKind} onChange={(e) => setSchedKind(e.target.value as 'hourly' | 'daily' | 'weekly')} style={{ border: fieldCtl }}>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
                {schedKind !== 'hourly' && (
                  <label>
                    at{' '}
                    <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} style={{ border: fieldCtl }} />
                  </label>
                )}
                <span style={{ fontSize: 11, color: '#888' }}>
                  Stored on the spec — the host decides how to honor it (no scheduler in v1).
                </span>
              </div>
            )}
          </div>
        </div>
    </A11yDialog>
  );
}
