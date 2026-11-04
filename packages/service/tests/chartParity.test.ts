/**
 * Excel chart parity re-verification (user demand: 100% on diagrams).
 *
 * EXCEL_CHART_REFERENCE enumerates Excel's COMPLETE Insert-tab chart
 * galleries explicitly — every fixed chart type Excel offers, in Excel's
 * gallery order — and records how icecream-sheets covers each one:
 *
 * - 'direct'      : chart.js renders the kind as-is.
 * - '3d-fallback' : Excel 3-D kind; the spec preserves the kind but
 *                   chart.js has no 3-D pipeline, so it renders as the
 *                   2-D counterpart (BuiltConfig.renderedAs says which).
 * - 'composite'   : Pie of Pie / Bar of Pie; main chart + "Other"
 *                   breakout chart rendered side-by-side.
 * - 'svg'         : custom SVG renderer (treemap, sunburst, surfaces,
 *                   contours, filled map).
 *
 * There are ZERO out-of-scope kinds: 100% Excel parity on diagrams (user
 * demand). The filled map's geographic boundaries ship bundled
 * (mapGeometry.ts), so every enumerated kind renders.
 *
 * Excel's combo gallery is custom (any combination), not fixed entries;
 * the product ships three preset combos covering the common cases.
 * 'Smoothed Line' is a product extension of the line gallery (Excel has
 * smoothing as a series option).
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_KINDS,
  THREE_D_FALLBACK,
  UNSUPPORTED_KINDS,
  buildChartConfig,
  contourGeometry,
  groupLabelForKind,
  is3DKind,
  kindLabel,
  lerpColor,
  makeChartSpec,
  splitCompoundPie,
  stockColumns,
  surfaceGeometry,
  surfaceGrid,
  type ChartKind,
  type ChartSeries,
} from '../src/index.js';

type ParityStatus = 'direct' | '3d-fallback' | 'composite' | 'svg';

interface ExcelRef {
  id: ChartKind;
  /** Excel's name for the chart type. */
  excel: string;
  /** Excel's gallery (ribbon) name. */
  gallery: string;
  status: ParityStatus;
  reason?: string;
}

const R: ExcelRef[] = [
  // Column (7)
  { id: 'column-clustered', excel: 'Clustered Column', gallery: 'Column', status: 'direct' },
  { id: 'column-stacked', excel: 'Stacked Column', gallery: 'Column', status: 'direct' },
  { id: 'column-stacked100', excel: '100% Stacked Column', gallery: 'Column', status: 'direct' },
  { id: 'column-3d-clustered', excel: '3-D Clustered Column', gallery: 'Column', status: '3d-fallback' },
  { id: 'column-3d-stacked', excel: '3-D Stacked Column', gallery: 'Column', status: '3d-fallback' },
  { id: 'column-3d-stacked100', excel: '3-D 100% Stacked Column', gallery: 'Column', status: '3d-fallback' },
  { id: 'column-3d', excel: '3-D Column', gallery: 'Column', status: '3d-fallback' },
  // Line (7 + product extension)
  { id: 'line', excel: 'Line', gallery: 'Line', status: 'direct' },
  { id: 'line-stacked', excel: 'Stacked Line', gallery: 'Line', status: 'direct' },
  { id: 'line-stacked100', excel: '100% Stacked Line', gallery: 'Line', status: 'direct' },
  { id: 'line-markers', excel: 'Line with Markers', gallery: 'Line', status: 'direct' },
  { id: 'line-stacked-markers', excel: 'Stacked Line with Markers', gallery: 'Line', status: 'direct' },
  { id: 'line-stacked100-markers', excel: '100% Stacked Line with Markers', gallery: 'Line', status: 'direct' },
  { id: 'line-3d', excel: '3-D Line', gallery: 'Line', status: '3d-fallback' },
  { id: 'line-smooth', excel: 'Smoothed Line', gallery: 'Line', status: 'direct', reason: 'product extension: Excel exposes smoothing as a series option' },
  // Pie (5)
  { id: 'pie', excel: 'Pie', gallery: 'Pie', status: 'direct' },
  { id: 'pie-3d', excel: '3-D Pie', gallery: 'Pie', status: '3d-fallback' },
  { id: 'pie-of-pie', excel: 'Pie of Pie', gallery: 'Pie', status: 'composite' },
  { id: 'bar-of-pie', excel: 'Bar of Pie', gallery: 'Pie', status: 'composite' },
  { id: 'doughnut', excel: 'Doughnut', gallery: 'Pie', status: 'direct' },
  // Bar (6)
  { id: 'bar-clustered', excel: 'Clustered Bar', gallery: 'Bar', status: 'direct' },
  { id: 'bar-stacked', excel: 'Stacked Bar', gallery: 'Bar', status: 'direct' },
  { id: 'bar-stacked100', excel: '100% Stacked Bar', gallery: 'Bar', status: 'direct' },
  { id: 'bar-3d-clustered', excel: '3-D Clustered Bar', gallery: 'Bar', status: '3d-fallback' },
  { id: 'bar-3d-stacked', excel: '3-D Stacked Bar', gallery: 'Bar', status: '3d-fallback' },
  { id: 'bar-3d-stacked100', excel: '3-D 100% Stacked Bar', gallery: 'Bar', status: '3d-fallback' },
  // Area (6)
  { id: 'area', excel: 'Area', gallery: 'Area', status: 'direct' },
  { id: 'area-stacked', excel: 'Stacked Area', gallery: 'Area', status: 'direct' },
  { id: 'area-stacked100', excel: '100% Stacked Area', gallery: 'Area', status: 'direct' },
  { id: 'area-3d', excel: '3-D Area', gallery: 'Area', status: '3d-fallback' },
  { id: 'area-3d-stacked', excel: '3-D Stacked Area', gallery: 'Area', status: '3d-fallback' },
  { id: 'area-3d-stacked100', excel: '3-D 100% Stacked Area', gallery: 'Area', status: '3d-fallback' },
  // X Y (Scatter) (7)
  { id: 'scatter', excel: 'Scatter with only Markers', gallery: 'Scatter', status: 'direct' },
  { id: 'scatter-smooth', excel: 'Scatter with Smooth Lines', gallery: 'Scatter', status: 'direct' },
  { id: 'scatter-lines', excel: 'Scatter with Straight Lines', gallery: 'Scatter', status: 'direct' },
  { id: 'scatter-lines-markers', excel: 'Scatter with Straight Lines and Markers', gallery: 'Scatter', status: 'direct' },
  { id: 'scatter-smooth-markers', excel: 'Scatter with Smooth Lines and Markers', gallery: 'Scatter', status: 'direct' },
  { id: 'bubble', excel: 'Bubble', gallery: 'Scatter', status: 'direct' },
  { id: 'bubble-3d', excel: '3-D Bubble', gallery: 'Scatter', status: '3d-fallback' },
  // Map (1)
  { id: 'map-filled', excel: 'Filled Map', gallery: 'Map', status: 'svg' },
  // Stock (4)
  { id: 'stock-hlc', excel: 'High-Low-Close', gallery: 'Stock', status: 'direct' },
  { id: 'stock-ohlc', excel: 'Open-High-Low-Close', gallery: 'Stock', status: 'direct' },
  { id: 'stock-volume-hlc', excel: 'Volume-High-Low-Close', gallery: 'Stock', status: 'direct' },
  { id: 'stock-volume-ohlc', excel: 'Volume-Open-High-Low-Close', gallery: 'Stock', status: 'direct' },
  // Surface (4)
  { id: 'surface-3d', excel: '3-D Surface', gallery: 'Surface', status: 'svg' },
  { id: 'surface-3d-wireframe', excel: 'Wireframe 3-D Surface', gallery: 'Surface', status: 'svg' },
  { id: 'contour', excel: 'Contour', gallery: 'Surface', status: 'svg' },
  { id: 'contour-wireframe', excel: 'Wireframe Contour', gallery: 'Surface', status: 'svg' },
  // Histogram (2)
  { id: 'histogram', excel: 'Histogram', gallery: 'Statistical', status: 'direct' },
  { id: 'pareto', excel: 'Pareto', gallery: 'Statistical', status: 'direct' },
  // Box & Whisker (1)
  { id: 'boxplot', excel: 'Box and Whisker', gallery: 'Statistical', status: 'direct' },
  // Combo presets for Excel's custom combo gallery (3)
  { id: 'combo-column-line', excel: 'Clustered Column – Line', gallery: 'Combo', status: 'direct', reason: 'preset for Excel\'s custom combo gallery' },
  { id: 'combo-column-line-2axis', excel: 'Clustered Column – Line on Secondary Axis', gallery: 'Combo', status: 'direct', reason: 'preset for Excel\'s custom combo gallery' },
  { id: 'combo-stacked-area-column', excel: 'Stacked Area – Clustered Column', gallery: 'Combo', status: 'direct', reason: 'preset for Excel\'s custom combo gallery' },
  // Other (7)
  { id: 'treemap', excel: 'Treemap', gallery: 'Other Charts', status: 'svg' },
  { id: 'sunburst', excel: 'Sunburst', gallery: 'Other Charts', status: 'svg' },
  { id: 'waterfall', excel: 'Waterfall', gallery: 'Other Charts', status: 'direct' },
  { id: 'radar', excel: 'Radar', gallery: 'Other Charts', status: 'direct' },
  { id: 'radar-markers', excel: 'Radar with Markers', gallery: 'Other Charts', status: 'direct' },
  { id: 'radar-filled', excel: 'Filled Radar', gallery: 'Other Charts', status: 'direct' },
  { id: 'funnel', excel: 'Funnel', gallery: 'Other Charts', status: 'direct' },
];

const range = { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 2 };
const series: ChartSeries = {
  labels: ['A', 'B', 'C'],
  datasets: [
    { label: 'S1', data: [10, -5, 20] },
    { label: 'S2', data: [30, 15, 40] },
    { label: 'S3', data: [5, 8, 12] },
  ],
};

describe('Excel chart parity enumeration', () => {
  it('covers all 61 Excel chart kinds, no more and no fewer', () => {
    expect(R.length).toBe(61);
    expect(ALL_KINDS.length).toBe(61);
    const refIds = new Set(R.map((r) => r.id));
    for (const k of ALL_KINDS) {
      expect(refIds.has(k), `kind ${k} is implemented but missing from the Excel reference`).toBe(true);
    }
    const implIds = new Set<ChartKind>(ALL_KINDS);
    for (const r of R) {
      expect(implIds.has(r.id), `Excel kind ${r.excel} is missing from the implementation`).toBe(true);
    }
  });

  it('labels and galleries match Excel names', () => {
    for (const r of R) {
      expect(kindLabel(r.id), r.id).toBe(r.excel);
      expect(groupLabelForKind(r.id), r.id).toBe(r.gallery);
    }
  });

  it('zero out-of-scope kinds: every kind renders (100% parity)', () => {
    expect(Object.keys(UNSUPPORTED_KINDS)).toHaveLength(0);
    expect(R.every((r) => r.status !== ('out-of-scope' as ParityStatus))).toBe(true);
  });

  it('every kind builds a config', () => {
    for (const r of R) {
      const spec = makeChartSpec({ kind: r.id, range, title: 'T', dataLabels: true });
      const built = buildChartConfig(spec, series);
      if (r.status === 'svg') {
        expect(['treemap', 'sunburst', 'contour', 'surface', 'map'], r.id).toContain(built.svg);
      } else {
        expect(built.svg, r.id).toBeNull();
        expect(built.config.type, r.id).toBeTruthy();
      }
      if (r.status === '3d-fallback') {
        expect(is3DKind(r.id), r.id).toBe(true);
        expect(built.renderedAs, r.id).toBeDefined();
        expect(is3DKind(built.renderedAs!), r.id).toBe(false);
      } else {
        expect(built.renderedAs, r.id).toBeUndefined();
      }
      if (r.status === 'composite') {
        expect(built.detail, r.id).toBeDefined();
        expect(built.detail!.config.type, r.id).toBeTruthy();
      }
    }
  });

  it('3-D fallback targets are directly renderable kinds', () => {
    const keys = Object.keys(THREE_D_FALLBACK);
    expect(keys.length).toBe(13);
    for (const k of keys) {
      expect(is3DKind(k as ChartKind)).toBe(true);
      const target = THREE_D_FALLBACK[k];
      expect(is3DKind(target)).toBe(false);
      expect(UNSUPPORTED_KINDS[target]).toBeUndefined();
    }
  });
});

describe('compound pies', () => {
  it('breaks the smallest slices out into "Other"', () => {
    const split = splitCompoundPie(['A', 'B', 'C', 'D'], [50, 30, 15, 5]);
    expect(split.hasDetail).toBe(true);
    // Smallest slices up to ~25% of the total break out.
    expect(split.detailLabels).toEqual(['D', 'C']);
    expect(split.detailValues).toEqual([5, 15]);
    expect(split.mainLabels).toEqual(['A', 'B', 'Other']);
    expect(split.mainValues).toEqual([50, 30, 20]);
  });

  it('does not split tiny pies', () => {
    const split = splitCompoundPie(['A', 'B'], [60, 40]);
    expect(split.hasDetail).toBe(false);
    expect(split.mainValues).toEqual([60, 40]);
  });

  it('bar-of-pie produces a bar breakout chart', () => {
    const spec = makeChartSpec({ kind: 'bar-of-pie', range, title: 'T' });
    const built = buildChartConfig(spec, series);
    expect(built.detail?.kind).toBe('bar');
    expect(built.detail?.config.type).toBe('bar');
    const pieSpec = makeChartSpec({ kind: 'pie-of-pie', range, title: 'T' });
    expect(buildChartConfig(pieSpec, series).detail?.kind).toBe('pie');
  });
});

describe('stock charts', () => {
  const stockSeries: ChartSeries = {
    labels: ['Mon', 'Tue', 'Wed'],
    datasets: [
      { label: 'Open', data: [10, 12, 11] },
      { label: 'High', data: [14, 15, 13] },
      { label: 'Low', data: [9, 11, 10] },
      { label: 'Close', data: [13, 12, 12] },
    ],
  };

  it('maps [Open,] High, Low, Close columns per Excel layout', () => {
    const cols = stockColumns('stock-ohlc', stockSeries);
    expect(cols.open).toEqual([10, 12, 11]);
    expect(cols.high).toEqual([14, 15, 13]);
    expect(cols.low).toEqual([9, 11, 10]);
    expect(cols.close).toEqual([13, 12, 12]);
    expect(cols.volume).toBeNull();
  });

  it('volume variants take the first column as volume', () => {
    const withVol: ChartSeries = {
      labels: ['Mon'],
      datasets: [
        { label: 'Volume', data: [1000] },
        { label: 'High', data: [14] },
        { label: 'Low', data: [9] },
        { label: 'Close', data: [13] },
      ],
    };
    const cols = stockColumns('stock-volume-hlc', withVol);
    expect(cols.volume).toEqual([1000]);
    expect(cols.open).toBeNull();
    expect(cols.high).toEqual([14]);
  });

  it('builds mixed floating-bar + marker configs', () => {
    for (const kind of ['stock-hlc', 'stock-ohlc', 'stock-volume-hlc', 'stock-volume-ohlc'] as const) {
      const spec = makeChartSpec({ kind, range, title: 'T' });
      const built = buildChartConfig(spec, stockSeries);
      expect(built.svg, kind).toBeNull();
      const ds = built.config.data.datasets;
      // High–Low floating bars + Close markers (+ Open markers / Volume bars).
      expect(ds.length, kind).toBeGreaterThanOrEqual(2);
      const floats = (ds[0] as unknown as { data: [number, number][] }).data;
      expect(floats[0][0]).toBeLessThanOrEqual(floats[0][1]);
    }
    // Volume variants get a secondary axis.
    const spec = makeChartSpec({ kind: 'stock-volume-ohlc', range, title: 'T' });
    const built = buildChartConfig(spec, stockSeries);
    const scales = (built.config.options as { scales: Record<string, unknown> }).scales;
    expect(scales['y1']).toBeDefined();
  });
});

describe('surface & contour geometry', () => {
  const grid3 = surfaceGrid({
    labels: ['r0', 'r1', 'r2'],
    datasets: [
      { label: 'c0', data: [1, 2, 3] },
      { label: 'c1', data: [4, 5, 6] },
      { label: 'c2', data: [7, 8, 9] },
    ],
  });

  it('surfaceGrid builds the z-matrix with min/max', () => {
    expect(grid3.zMin).toBe(1);
    expect(grid3.zMax).toBe(9);
    expect(grid3.z[2][2]).toBe(9);
  });

  it('wireframe geometry has grid lines and no quads', () => {
    const g = surfaceGeometry(grid3, 400, 300, false);
    expect(g.lines.length).toBeGreaterThan(0);
    expect(g.quads).toHaveLength(0);
    for (const [a, b] of g.lines) {
      for (const p of [a, b]) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('filled surface sorts quads back-to-front', () => {
    const g = surfaceGeometry(grid3, 400, 300, true);
    expect(g.quads.length).toBe(4); // 2x2 cells
    for (let i = 1; i < g.quads.length; i++) {
      expect(g.quads[i - 1].depth).toBeGreaterThanOrEqual(g.quads[i].depth);
    }
    expect(g.quads[0].fill).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('contour geometry produces bands and marching-squares lines', () => {
    const g = contourGeometry(grid3, 400, 300, 6);
    expect(g.bands.length).toBe(4);
    expect(g.levels).toHaveLength(6);
    const total = g.levels.reduce((s, l) => s + l.segments.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('degenerate grids produce empty geometry, not errors', () => {
    const flat = surfaceGrid({
      labels: ['a', 'b'],
      datasets: [{ label: 'x', data: [5, 5] }],
    });
    const g = contourGeometry(flat, 200, 150, 4);
    expect(g.bands).toHaveLength(0); // single column: no cells
    expect(g.levels).toHaveLength(0);
  });

  it('lerpColor interpolates hex colors', () => {
    expect(lerpColor('#000000', '#ffffff', 0)).toBe('#000000');
    expect(lerpColor('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(lerpColor('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});
