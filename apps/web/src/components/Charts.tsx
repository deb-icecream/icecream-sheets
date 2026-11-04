/**
 * Chart overlay rendering for the grid.
 *
 * - ChartOverlay: draggable / resizable floating chart bound to a ChartSpec.
 *   Data is re-extracted through the CellReader on every `version` tick, so
 *   the chart updates live when source cells change.
 * - TreemapSvg / SunburstSvg / ContourSvg / SurfaceSvg / FilledMapSvg:
 *   custom SVG renderers for the kinds that chart.js does not cover
 *   natively (no extra dependencies).
 *
 * The overlay owns no engine access; the parent passes a CellReader wired to
 * the typed computational view (design-docs/native-reports-and-dashboards.md).
 */
import { useMemo, useRef } from 'react';
import ChartCanvas from './ChartCanvas';
import {
  addTrendlinesToConfig,
  buildChartConfig,
  buildMapSvg,
  colorFor,
  contourGeometry,
  extractSeries,
  extractSeriesFromRanges,
  kindLabel,
  mapSeriesToCountries,
  surfaceGeometry,
  surfaceGrid,
  type BuiltConfig,
  type CellReader,
  type ChartSeries,
  type ChartSpec,
  type SheetCellReader,
} from '@icecream-sheets/service';

/* ------------------------------------------------------------------ */
/* Treemap (squarified)                                                */
/* ------------------------------------------------------------------ */

interface TreemapRect {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  value: number;
  color: string;
}

function squarify(
  items: { label: string; value: number; color: string }[],
  x: number,
  y: number,
  w: number,
  h: number,
): TreemapRect[] {
  const total = items.reduce((s, it) => s + it.value, 0);
  if (total <= 0 || w <= 0 || h <= 0) return [];
  const scaled = items.map((it) => ({ ...it, area: (it.value / total) * w * h }));
  const rects: TreemapRect[] = [];
  let row: typeof scaled = [];
  let cx = x;
  let cy = y;
  let cw = w;
  let ch = h;

  const worst = (r: typeof scaled, side: number): number => {
    const s = r.reduce((a, b) => a + b.area, 0);
    const mx = Math.max(...r.map((b) => b.area));
    const mn = Math.min(...r.map((b) => b.area));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };

  const layoutRow = () => {
    if (row.length === 0) return;
    const horizontal = cw >= ch;
    const rowArea = row.reduce((a, b) => a + b.area, 0);
    if (horizontal) {
      const rowH = rowArea / cw;
      let rx = cx;
      for (const b of row) {
        const bw = b.area / rowH;
        rects.push({ x: rx, y: cy, w: bw, h: rowH, label: b.label, value: b.value, color: b.color });
        rx += bw;
      }
      cy += rowH;
      ch -= rowH;
    } else {
      const colW = rowArea / ch;
      let ry = cy;
      for (const b of row) {
        const bh = b.area / colW;
        rects.push({ x: cx, y: ry, w: colW, h: bh, label: b.label, value: b.value, color: b.color });
        ry += bh;
      }
      cx += colW;
      cw -= colW;
    }
    row = [];
  };

  for (const b of scaled) {
    const side = Math.min(cw, ch);
    if (row.length === 0 || worst([...row, b], side) <= worst(row, side)) {
      row.push(b);
    } else {
      layoutRow();
      row.push(b);
    }
  }
  layoutRow();
  return rects;
}

export function TreemapSvg({
  labels,
  values,
  width,
  height,
  title,
}: {
  labels: string[];
  values: number[];
  width: number;
  height: number;
  title: string;
}) {
  const rects = useMemo(() => {
    const items = labels.map((label, i) => ({
      label,
      value: Math.max(0, values[i] ?? 0),
      color: colorFor(i),
    }));
    return squarify(items, 0, 0, width, height - 28);
  }, [labels, values, width, height]);
  return (
    <svg width={width} height={height} role="img" aria-label={title}>
      {title && (
        <text x={width / 2} y={16} textAnchor="middle" fontSize={13} fontWeight="bold">
          {title}
        </text>
      )}
      <g transform="translate(0,28)">
        {rects.map((r, i) => (
          <g key={i}>
            <rect x={r.x + 1} y={r.y + 1} width={Math.max(0, r.w - 2)} height={Math.max(0, r.h - 2)} fill={r.color} stroke="#fff" strokeWidth={1} />
            {r.w > 34 && r.h > 18 && (
              <text x={r.x + r.w / 2} y={r.y + r.h / 2} textAnchor="middle" fontSize={11} fill="#fff">
                {r.label}
              </text>
            )}
          </g>
        ))}
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Sunburst                                                            */
/* ------------------------------------------------------------------ */

export function SunburstSvg({
  labels,
  values,
  width,
  height,
  title,
}: {
  labels: string[];
  values: number[];
  width: number;
  height: number;
  title: string;
}) {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  const cx = width / 2;
  const cy = (height + 28) / 2;
  const outer = Math.max(10, Math.min(width, height - 28) / 2 - 6);
  const inner = outer * 0.45;
  let angle = -Math.PI / 2;
  const polar = (r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  return (
    <svg width={width} height={height} role="img" aria-label={title}>
      {title && (
        <text x={width / 2} y={16} textAnchor="middle" fontSize={13} fontWeight="bold">
          {title}
        </text>
      )}
      {total > 0 &&
        labels.map((label, i) => {
          const v = Math.max(0, values[i] ?? 0);
          const frac = v / total;
          if (frac <= 0) return null;
          const a0 = angle;
          const a1 = angle + frac * Math.PI * 2;
          angle = a1;
          const [x0, y0] = polar(inner, a0);
          const [x1, y1] = polar(outer, a0);
          const [x2, y2] = polar(outer, a1);
          const [x3, y3] = polar(inner, a1);
          const large = frac > 0.5 ? 1 : 0;
          const mid = (a0 + a1) / 2;
          const [lx, ly] = polar((inner + outer) / 2, mid);
          return (
            <g key={i}>
              <path
                d={`M ${x0} ${y0} L ${x1} ${y1} A ${outer} ${outer} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${large} 0 ${x0} ${y0} Z`}
                fill={colorFor(i)}
                stroke="#fff"
                strokeWidth={1.5}
              />
              {frac > 0.06 && (
                <text x={lx} y={ly} textAnchor="middle" fontSize={11} fill="#fff">
                  {label}
                </text>
              )}
            </g>
          );
        })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Contour (marching squares)                                          */
/* ------------------------------------------------------------------ */

export function ContourSvg({
  series,
  width,
  height,
  title,
  wireframe,
}: {
  series: import('@icecream-sheets/service').ChartSeries;
  width: number;
  height: number;
  title: string;
  wireframe: boolean;
}) {
  const geom = useMemo(
    () => contourGeometry(surfaceGrid(series), width, height - 28, 8),
    [series, width, height],
  );
  return (
    <svg width={width} height={height} role="img" aria-label={title}>
      {title && (
        <text x={width / 2} y={16} textAnchor="middle" fontSize={13} fontWeight="bold">
          {title}
        </text>
      )}
      <g transform="translate(0,28)">
        {!wireframe &&
          geom.bands.map((b, i) => (
            <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} />
          ))}
        {geom.levels.map((lv, i) => (
          <g key={i} stroke={lv.color} strokeWidth={1} fill="none">
            {lv.segments.map((s, j) => (
              <line key={j} x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} />
            ))}
          </g>
        ))}
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 3-D Surface (oblique projection)                                    */
/* ------------------------------------------------------------------ */

export function SurfaceSvg({
  series,
  width,
  height,
  title,
  wireframe,
}: {
  series: import('@icecream-sheets/service').ChartSeries;
  width: number;
  height: number;
  title: string;
  wireframe: boolean;
}) {
  const geom = useMemo(
    () => surfaceGeometry(surfaceGrid(series), width, height - 28, !wireframe),
    [series, width, height, wireframe],
  );
  return (
    <svg width={width} height={height} role="img" aria-label={title}>
      {title && (
        <text x={width / 2} y={16} textAnchor="middle" fontSize={13} fontWeight="bold">
          {title}
        </text>
      )}
      <g transform="translate(0,28)">
        {!wireframe &&
          geom.quads.map((q, i) => (
            <polygon
              key={i}
              points={q.pts.map((p) => `${p.x},${p.y}`).join(' ')}
              fill={q.fill}
              stroke="#ffffff"
              strokeWidth={0.5}
            />
          ))}
        <g stroke={wireframe ? '#4F81BD' : '#33333355'} strokeWidth={1} fill="none">
          {geom.lines.map((l, i) => (
            <line key={i} x1={l[0].x} y1={l[0].y} x2={l[1].x} y2={l[1].y} />
          ))}
        </g>
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Filled Map (choropleth)                                             */
/* ------------------------------------------------------------------ */

/**
 * Filled Map renderer. The SVG string is produced by the service-layer
 * buildMapSvg (bundled world boundaries, XML-escaped labels), so this
 * component only injects it. Unmatched geography labels are surfaced as a
 * warning line under the map instead of being silently dropped.
 */
export function FilledMapSvg({
  series,
  width,
  height,
  title,
}: {
  series: import('@icecream-sheets/service').ChartSeries;
  width: number;
  height: number;
  title: string;
}) {
  const { svg, unmatched } = useMemo(() => {
    const data = mapSeriesToCountries(series);
    return {
      svg: buildMapSvg(data, { width, height: height - (data.unmatched.length > 0 ? 22 : 0), title }),
      unmatched: data.unmatched,
    };
  }, [series, width, height, title]);
  return (
    <div style={{ width, height }}>
      {/* buildMapSvg output is service-generated with escaped labels */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {unmatched.length > 0 && (
        <div style={{ fontSize: 10, color: '#a00', padding: '2px 8px' }} title={unmatched.join(', ')}>
          Unmatched {unmatched.length === 1 ? 'region' : 'regions'}: {unmatched.slice(0, 3).join(', ')}
          {unmatched.length > 3 ? ` (+${unmatched.length - 3} more)` : ''}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ChartOverlay                                                        */
/* ------------------------------------------------------------------ */

interface ChartOverlayProps {
  spec: ChartSpec;
  read: CellReader;
  /**
   * Sheet-aware cell reader. When spec.seriesRanges is present (imported
   * charts), series are built directly from their per-series ranges via
   * extractSeriesFromRanges, which may span sheets — it needs this reader.
   * Falls back to wrapping `read` (single-sheet) when absent.
   */
  readAt?: SheetCellReader;
  version: number;
  /**
   * PivotCharts: when spec.pivot is set, series come from the live pivot
   * result via this callback instead of the cell range. pivotVersion bumps
   * on pivot refresh so the chart re-derives (stays in sync).
   */
  getPivotSeries?: (spec: ChartSpec) => ChartSeries | null;
  pivotVersion?: number;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  onEdit: () => void;
}

/** Floating, draggable, resizable chart bound live to its range. */
export function ChartOverlay({
  spec,
  read,
  readAt,
  version,
  getPivotSeries,
  pivotVersion,
  onClose,
  onMove,
  onResize,
  onEdit,
}: ChartOverlayProps) {
  const drag = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const resize = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const { built, svgLabels, svgValues, svgSeries, buildError } = useMemo(() => {
    void version; // re-extract whenever the grid ticks
    void pivotVersion; // re-derive when a bound pivot refreshes
    let series: ChartSeries;
    let missingPivot = false;
    if (spec.seriesRanges && spec.seriesRanges.length > 0 && !spec.pivot) {
      // Imported charts: build directly from per-series ranges (bypasses
      // extractSeries — unioning non-contiguous ranges misreads the sheet).
      series = extractSeriesFromRanges(
        readAt ?? ((sheet: string, row: number, col: number) => read(row, col)),
        spec.seriesRanges,
      );
    } else if (spec.pivot) {
      const pivotSeries = getPivotSeries?.(spec) ?? null;
      if (pivotSeries) {
        // Live pivot data wins: the chart stays in sync on pivot
        // refresh / slicer changes.
        series = pivotSeries;
      } else if (spec.seriesRanges && spec.seriesRanges.length > 0) {
        // The bound pivot has no computed data (e.g. its cache was saved
        // with saveData="0"): fall back to the chart's own cached series
        // formulas instead of an error — the file's data still renders.
        series = extractSeriesFromRanges(
          readAt ?? ((sheet: string, row: number, col: number) => read(row, col)),
          spec.seriesRanges,
        );
      } else {
        missingPivot = true;
        series = { labels: [], datasets: [] };
      }
    } else {
      series = extractSeries(read, spec.range);
    }
    // Progressive display (Cycle 10): live values always win, but when the
    // live read produced NO data at all (engine not ready / range not yet
    // calculated / pivot cache empty), paint from the chart part's own
    // cached points — exactly what Excel shows before recalc — instead of
    // an empty chart. The next tick with live data re-renders live.
    if (
      spec.cachedSeries &&
      series.datasets.every((d) => d.data.every((v) => v === null || v === undefined))
    ) {
      series = spec.cachedSeries;
    }
    const first = series.datasets[0];
    try {
      if (missingPivot) throw new Error('The pivot table this chart is bound to is unavailable — it was deleted, or its data has not been computed yet (refresh the pivot to populate it).');
      const b: BuiltConfig = buildChartConfig(spec, series);
      // Trendlines (Excel: Format Trendline): dashed overlay datasets.
      addTrendlinesToConfig(b, series, spec);
      return {
        built: b,
        svgLabels: series.labels,
        svgValues: (first?.data ?? []).map((v) => (typeof v === 'number' ? v : 0)),
        svgSeries: series,
        buildError: null as string | null,
      };
    } catch (e) {
      return {
        built: null as BuiltConfig | null,
        svgLabels: series.labels,
        svgValues: [] as number[],
        svgSeries: series,
        buildError: e instanceof Error ? e.message : String(e),
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, read, version, pivotVersion]);

  const bodyW = Math.max(200, spec.w - 16);
  const bodyH = Math.max(120, spec.h - 44);
  const svgKind = built?.svg ?? null;

  return (
    <div
      style={{
        position: 'absolute',
        left: spec.x,
        top: spec.y,
        width: spec.w,
        height: spec.h,
        background: '#fff',
        border: '1px solid #aaa',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          background: '#f3f3f3',
          borderBottom: '1px solid #ddd',
          cursor: 'move',
          userSelect: 'none',
        }}
        onMouseDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, sx: spec.x, sy: spec.y };
        }}
        onMouseMove={(e) => {
          if (drag.current) {
            onMove(
              drag.current.sx + (e.clientX - drag.current.x),
              drag.current.sy + (e.clientY - drag.current.y),
            );
          }
        }}
        onMouseUp={() => {
          drag.current = null;
        }}
        onMouseLeave={() => {
          drag.current = null;
        }}
      >
        <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
          {spec.title}
        </strong>
        <button type="button" onClick={onEdit} title="Edit chart" style={{ fontSize: 12 }}>
          ✎
        </button>
        <button type="button" onClick={onClose} title="Remove chart" style={{ fontSize: 12 }}>
          ✕
        </button>
      </div>
      <div style={{ flex: 1, padding: 8, overflow: 'hidden' }}>
        {buildError ? (
          <div style={{ fontSize: 12, color: '#a00', padding: 8 }}>{buildError}</div>
        ) : svgKind === 'treemap' ? (
          <TreemapSvg labels={svgLabels} values={svgValues} width={bodyW} height={bodyH} title="" />
        ) : svgKind === 'sunburst' ? (
          <SunburstSvg labels={svgLabels} values={svgValues} width={bodyW} height={bodyH} title="" />
        ) : svgKind === 'contour' ? (
          <ContourSvg
            series={svgSeries}
            width={bodyW}
            height={bodyH}
            title=""
            wireframe={spec.kind === 'contour-wireframe'}
          />
        ) : svgKind === 'surface' ? (
          <SurfaceSvg
            series={svgSeries}
            width={bodyW}
            height={bodyH}
            title=""
            wireframe={spec.kind === 'surface-3d-wireframe'}
          />
        ) : svgKind === 'map' ? (
          <FilledMapSvg series={svgSeries} width={bodyW} height={bodyH} title="" />
        ) : built?.detail ? (
          <div style={{ display: 'flex', gap: 8, height: '100%' }}>
            <div style={{ flex: 3 }}>
              <ChartCanvas config={built.config} width={Math.floor(bodyW * 0.62)} height={bodyH} title={spec.title} />
            </div>
            <div style={{ flex: 2 }}>
              <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>{built.detail.title}</div>
              <ChartCanvas
                config={built.detail.config}
                width={Math.floor(bodyW * 0.34)}
                height={bodyH - 20}
                title={built.detail.title}
              />
            </div>
          </div>
        ) : (
          <ChartCanvas config={built!.config} width={bodyW} height={bodyH} title={spec.title} />
        )}
        {built?.renderedAs && (
          <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>
            {kindLabel(spec.kind)} renders as {kindLabel(built.renderedAs)} in v1 (no 3-D pipeline).
          </div>
        )}
      </div>
      <div
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: 'nwse-resize',
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          resize.current = { x: e.clientX, y: e.clientY, w: spec.w, h: spec.h };
          const move = (ev: MouseEvent) => {
            if (!resize.current) return;
            onResize(
              Math.max(220, resize.current.w + (ev.clientX - resize.current.x)),
              Math.max(160, resize.current.h + (ev.clientY - resize.current.y)),
            );
          };
          const up = () => {
            resize.current = null;
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
      >
        <svg width={16} height={16}>
          <path d="M 2 14 L 14 2 M 6 14 L 14 6 M 10 14 L 14 10" stroke="#888" strokeWidth={1.5} />
        </svg>
      </div>
    </div>
  );
}
