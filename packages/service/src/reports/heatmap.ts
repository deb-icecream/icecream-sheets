/**
 * Heatmap matrix visual — native reports & dashboards.
 *
 * RESOLVED 2026-10-18: Excel has no native heatmap chart type (it is done
 * via conditional formatting), but data analysis needs it for correlation
 * matrices. Resolution: a first-class matrix visual in the reports
 * component — NOT a chart kind. A color-scaled matrix with row/col labels,
 * backed by the chart color-scale logic (lerpColor).
 *
 * Service-layer, pure and headless: builds the colored matrix model from
 * plain records. The web UI renders it as a grid of colored cells.
 */

import { lerpColor } from '../chartModel.js';

/** Current version of the serialized HeatmapSpec. Bump when the shape changes. */
export const HEATMAP_SPEC_VERSION = 1 as const;

export interface HeatmapSpec {
  version: number;
  /** Row labels (e.g. variable names in a correlation matrix). */
  rowLabels: string[];
  /** Column labels. */
  colLabels: string[];
  /** values[r][c]; null = no data (rendered with the no-data color). */
  values: (number | null)[][];
  /** Color for the minimum value (sequential) or negative extreme (diverging). */
  lowColor: string;
  /** Optional midpoint color (diverging scales, e.g. correlation -1..1). */
  midColor?: string;
  /** Color for the maximum value. */
  highColor: string;
  /** Render numeric values inside cells. Defaults to true. */
  showValues: boolean;
  /** Treat the scale as diverging around `center` (default 0 when midColor set). */
  center?: number;
}

export interface HeatmapCell {
  row: number;
  col: number;
  value: number | null;
  /** Lowercase #rrggbb. */
  color: string;
}

export interface BuiltHeatmap {
  rowLabels: string[];
  colLabels: string[];
  cells: HeatmapCell[];
  min: number;
  max: number;
}

export const HEATMAP_NO_DATA_COLOR = '#f3f4f6';

function isHexColor(s: string): boolean {
  return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(s);
}

/** Normalize a partial spec, filling defaults. Never throws. */
export function makeHeatmapSpec(partial: Partial<HeatmapSpec>): HeatmapSpec {
  const rowLabels = Array.isArray(partial.rowLabels)
    ? partial.rowLabels.filter((l): l is string => typeof l === 'string')
    : [];
  const colLabels = Array.isArray(partial.colLabels)
    ? partial.colLabels.filter((l): l is string => typeof l === 'string')
    : [];
  const values = Array.isArray(partial.values)
    ? partial.values.map((row) =>
        Array.isArray(row)
          ? row.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
          : [],
      )
    : [];
  return {
    version: HEATMAP_SPEC_VERSION,
    rowLabels,
    colLabels,
    values,
    lowColor: typeof partial.lowColor === 'string' && isHexColor(partial.lowColor) ? partial.lowColor : '#dbeafe',
    midColor: typeof partial.midColor === 'string' && isHexColor(partial.midColor) ? partial.midColor : undefined,
    highColor: typeof partial.highColor === 'string' && isHexColor(partial.highColor) ? partial.highColor : '#1e40af',
    showValues: partial.showValues !== false,
    center: typeof partial.center === 'number' && Number.isFinite(partial.center) ? partial.center : undefined,
  };
}

/** Scale a value to [0,1] honoring diverging (mid/center) or sequential mode. */
function scaleValue(v: number, min: number, max: number, spec: HeatmapSpec): number {
  if (spec.midColor !== undefined) {
    const center = spec.center ?? 0;
    if (v >= center) {
      const denom = max - center || 1;
      return 0.5 + 0.5 * Math.min(1, (v - center) / denom);
    }
    const denom = center - min || 1;
    return 0.5 - 0.5 * Math.min(1, (center - v) / denom);
  }
  const denom = max - min || 1;
  return Math.min(1, Math.max(0, (v - min) / denom));
}

function colorFor(t: number, spec: HeatmapSpec): string {
  if (spec.midColor !== undefined) {
    return t < 0.5
      ? lerpColor(spec.lowColor, spec.midColor, t * 2)
      : lerpColor(spec.midColor, spec.highColor, (t - 0.5) * 2);
  }
  return lerpColor(spec.lowColor, spec.highColor, t);
}

/** Build the colored matrix model from a spec. Pure. */
export function buildHeatmap(spec: HeatmapSpec): BuiltHeatmap {
  const s = makeHeatmapSpec(spec);
  let min = Infinity;
  let max = -Infinity;
  for (const row of s.values) {
    for (const v of row) {
      if (v !== null) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }
  const cells: HeatmapCell[] = [];
  for (let r = 0; r < s.values.length; r++) {
    const row = s.values[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const v = row[c] ?? null;
      cells.push({
        row: r,
        col: c,
        value: v,
        color: v === null ? HEATMAP_NO_DATA_COLOR : colorFor(scaleValue(v, min, max, s), s),
      });
    }
  }
  return { rowLabels: s.rowLabels, colLabels: s.colLabels, cells, min, max };
}

/**
 * Pivot flat records into a heatmap matrix: distinct rowField values become
 * rows, distinct colField values become columns, valueField is aggregated
 * (mean) per cell. The classic use case is a correlation matrix, where the
 * caller pre-computes pairwise correlations into records.
 */
export function heatmapFromRecords(
  records: Array<Record<string, unknown>>,
  rowField: string,
  colField: string,
  valueField: string,
  opts?: Partial<HeatmapSpec>,
): HeatmapSpec {
  const rowSet = new Map<string, number>();
  const colSet = new Map<string, number>();
  const buckets = new Map<string, number[]>();
  for (const rec of records) {
    const r = rec[rowField];
    const c = rec[colField];
    const v = rec[valueField];
    if (typeof r !== 'string' && typeof r !== 'number') continue;
    if (typeof c !== 'string' && typeof c !== 'number') continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const rs = String(r);
    const cs = String(c);
    if (!rowSet.has(rs)) rowSet.set(rs, rowSet.size);
    if (!colSet.has(cs)) colSet.set(cs, colSet.size);
    const key = `${rs}|~|${cs}`;
    const arr = buckets.get(key);
    if (arr) arr.push(v);
    else buckets.set(key, [v]);
  }
  const rowLabels = [...rowSet.keys()];
  const colLabels = [...colSet.keys()];
  const values: (number | null)[][] = rowLabels.map((rs) =>
    colLabels.map((cs) => {
      const arr = buckets.get(`${rs}|~|${cs}`);
      if (!arr || arr.length === 0) return null;
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    }),
  );
  return makeHeatmapSpec({ ...opts, rowLabels, colLabels, values });
}

/**
 * Pearson correlation matrix for numeric fields — the primary data-analysis
 * use case. Returns a HeatmapSpec with diverging scale centered at 0.
 */
export function correlationHeatmap(
  records: Array<Record<string, unknown>>,
  fields: string[],
  opts?: Partial<HeatmapSpec>,
): HeatmapSpec {
  const cols = fields.map((f) =>
    records.map((r) => r[f]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
  );
  const corr = (a: number[], b: number[]): number | null => {
    const n = Math.min(a.length, b.length);
    if (n < 2) return null;
    const xs = a.slice(0, n);
    const ys = b.slice(0, n);
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      dx += (xs[i]! - mx) ** 2;
      dy += (ys[i]! - my) ** 2;
    }
    const denom = Math.sqrt(dx * dy);
    return denom === 0 ? null : num / denom;
  };
  const values = fields.map((_, i) => fields.map((_, j) => corr(cols[i]!, cols[j]!)));
  return makeHeatmapSpec({
    rowLabels: fields,
    colLabels: fields,
    values,
    lowColor: '#1e40af',
    midColor: '#ffffff',
    highColor: '#b91c1c',
    center: 0,
    ...opts,
  });
}
