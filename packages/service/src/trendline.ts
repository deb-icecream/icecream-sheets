/**
 * Trendlines for charts (Excel parity: Format Trendline).
 *
 * Pure math — no DOM, no chart.js dependency. The fitting functions take a
 * numeric series (nulls are treated as gaps and skipped during fitting) and
 * return a fitted value per point. `trendlineDatasets` converts specs into
 * extra ChartSeries datasets that the UI appends to a built chart config as
 * dashed overlay line datasets.
 *
 * Supported types: linear, exponential, logarithmic, polynomial (order 2-6),
 * power, moving average (configurable period). Forecast forward/backward N
 * periods, a custom intercept ("Set Intercept"), the fitted equation and
 * R-squared are all supported, matching Excel's Format Trendline pane.
 *
 * X numbering: Excel numbers trendline x values 1..n along a category axis,
 * so fitting uses x = index + 1. This makes the displayed equations match
 * Excel exactly (and is what makes logarithmic/power fits possible at all —
 * a 0-based x would put the first point at ln(0)).
 */

import type {
  BuiltConfig,
  ChartSeries,
  ChartSpec,
} from './chartModel.js';

export type TrendlineType =
  | 'linear'
  | 'exponential'
  | 'logarithmic'
  | 'polynomial'
  | 'power'
  | 'movingAverage';

/** Versioned, serializable trendline spec. Stored on ChartSpec.trendlines. */
export interface TrendlineSpec {
  type: TrendlineType;
  /** Index into the chart's datasets (default 0). */
  seriesIndex?: number;
  /** Moving-average window (default 2). */
  period?: number;
  /** Polynomial order 2-6 (default 2). */
  order?: number;
  /** Legend label override; defaults to "<type> (<series label>)". */
  label?: string;
  /** CSS color override; defaults to a shade of the series color. */
  color?: string;
  /**
   * Custom y-intercept (Excel: "Set Intercept"). The curve is forced through
   * y = intercept at x = 0 and the remaining parameter(s) are refit by
   * least squares. null/undefined = fit the intercept normally. Ignored for
   * movingAverage.
   */
  intercept?: number | null;
  /** Forecast forward N periods (Excel: Forecast > Forward). Default 0. */
  forward?: number;
  /** Forecast backward N periods (Excel: Forecast > Backward). Default 0. */
  backward?: number;
  /** Append the fitted equation to the legend label (Excel: Display Equation). */
  displayEquation?: boolean;
  /** Append R² to the legend label (Excel: Display R-squared value). */
  displayRSquared?: boolean;
}

export const TRENDLINE_TYPES: { id: TrendlineType; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'exponential', label: 'Exponential' },
  { id: 'logarithmic', label: 'Logarithmic' },
  { id: 'polynomial', label: 'Polynomial' },
  { id: 'power', label: 'Power' },
  { id: 'movingAverage', label: 'Moving Average' },
];

export function trendlineLabel(type: TrendlineType): string {
  return TRENDLINE_TYPES.find((t) => t.id === type)?.label ?? type;
}

/** Points usable for fitting: numeric (x, y) pairs, skipping gaps. x is 1-based. */
function numericPairs(values: (number | null)[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ x: i + 1, y: v });
  });
  return out;
}

/** Excel-style coefficient formatting: up to 5 significant digits, trimmed. */
export function formatTrendCoef(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Object.is(n, -0)) n = 0;
  return String(Number(n.toPrecision(5)));
}

type Fitter = (x: number) => number;

interface FittedModel {
  eval: Fitter;
  /** Excel-style equation, or null when Excel shows none (moving average). */
  equation: string | null;
}

/**
 * Fit a trendline model to numeric points. Returns the evaluator plus the
 * display equation, or null when the fit is impossible (too few points,
 * non-positive values for log-domain fits, singular system).
 */
function fitModel(spec: TrendlineSpec, pts: { x: number; y: number }[]): FittedModel | null {
  const fixed = spec.intercept ?? null;
  switch (spec.type) {
    case 'linear': {
      let slope: number;
      let intercept: number;
      if (fixed !== null && Number.isFinite(fixed)) {
        intercept = fixed;
        slope = sumOver(pts, (p) => p.x * (p.y - intercept)) / sumOver(pts, (p) => p.x * p.x);
        if (!Number.isFinite(slope)) return null;
      } else {
        ({ slope, intercept } = leastSquares(pts.map((p) => [p.x, p.y])));
      }
      return {
        eval: (x) => slope * x + intercept,
        equation: linearEquation(slope, intercept),
      };
    }
    case 'exponential': {
      // y = a * e^(b x)
      if (pts.some((p) => p.y <= 0)) return null;
      let a: number;
      let b: number;
      if (fixed !== null && Number.isFinite(fixed) && fixed > 0) {
        a = fixed;
        const sxx = sumOver(pts, (p) => p.x * p.x);
        if (sxx === 0) return null;
        b = sumOver(pts, (p) => p.x * Math.log(p.y / a)) / sxx;
      } else {
        const { slope, intercept } = leastSquares(pts.map((p) => [p.x, Math.log(p.y)]));
        b = slope;
        a = Math.exp(intercept);
      }
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return {
        eval: (x) => a * Math.exp(b * x),
        equation: `y = ${formatTrendCoef(a)}e^{${formatTrendCoef(b)}x}`,
      };
    }
    case 'logarithmic': {
      // y = a * ln(x) + b
      if (pts.some((p) => p.x <= 0)) return null;
      let a: number;
      let b: number;
      if (fixed !== null && Number.isFinite(fixed)) {
        b = fixed;
        const sll = sumOver(pts, (p) => Math.pow(Math.log(p.x), 2));
        if (sll === 0) return null;
        a = sumOver(pts, (p) => Math.log(p.x) * (p.y - b)) / sll;
      } else {
        ({ slope: a, intercept: b } = leastSquares(pts.map((p) => [Math.log(p.x), p.y])));
      }
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return {
        eval: (x) => (x <= 0 ? NaN : a * Math.log(x) + b),
        equation: `y = ${formatTrendCoef(a)}ln(x)${signedTerm(b)}`,
      };
    }
    case 'power': {
      // y = a * x^b
      if (pts.some((p) => p.x <= 0 || p.y <= 0)) return null;
      let a: number;
      let b: number;
      if (fixed !== null && Number.isFinite(fixed) && fixed > 0) {
        a = fixed;
        const sll = sumOver(pts, (p) => Math.pow(Math.log(p.x), 2));
        if (sll === 0) return null;
        b = sumOver(pts, (p) => Math.log(p.x) * Math.log(p.y / a)) / sll;
      } else {
        const { slope, intercept } = leastSquares(pts.map((p) => [Math.log(p.x), Math.log(p.y)]));
        b = slope;
        a = Math.exp(intercept);
      }
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return {
        eval: (x) => (x <= 0 ? NaN : a * Math.pow(x, b)),
        equation: `y = ${formatTrendCoef(a)}x^{${formatTrendCoef(b)}}`,
      };
    }
    case 'polynomial': {
      const order = Math.min(6, Math.max(2, Math.round(spec.order ?? 2)));
      const coeffs = polyfit(
        pts.map((p) => p.x),
        pts.map((p) => p.y),
        order,
        fixed !== null && Number.isFinite(fixed) ? fixed : undefined,
      );
      if (!coeffs) return null;
      return {
        eval: (x) => coeffs.reduce((acc, c, i) => acc + c * Math.pow(x, i), 0),
        equation: polynomialEquation(coeffs),
      };
    }
    case 'movingAverage': {
      const period = Math.min(
        pts.length,
        Math.max(2, Math.round(spec.period ?? 2)),
      );
      const byX = new Map(pts.map((p) => [p.x, p.y]));
      return {
        eval: (x) => {
          let sum = 0;
          let n = 0;
          for (let k = Math.max(1, Math.ceil(x) - period + 1); k <= Math.floor(x); k++) {
            const v = byX.get(k);
            if (v !== undefined) {
              sum += v;
              n++;
            }
          }
          return n > 0 ? sum / n : NaN;
        },
        // Excel shows no equation for moving average.
        equation: null,
      };
    }
    default:
      return null;
  }
}

function sumOver<T>(arr: T[], fn: (t: T) => number): number {
  let s = 0;
  for (const t of arr) s += fn(t);
  return s;
}

/** "+ 1.1" / "- 1.1" / "" for a trailing constant term. */
function signedTerm(c: number): string {
  const f = formatTrendCoef(c);
  if (c === 0 || f === '0') return '';
  return c < 0 ? ` - ${formatTrendCoef(-c)}` : ` + ${f}`;
}

function linearEquation(slope: number, intercept: number): string {
  const m = formatTrendCoef(slope);
  const mx = slope === 1 ? 'x' : slope === -1 ? '-x' : `${m}x`;
  return `y = ${mx}${signedTerm(intercept)}`;
}

function polynomialEquation(coeffs: number[]): string {
  const terms: string[] = [];
  for (let i = coeffs.length - 1; i >= 0; i--) {
    const c = coeffs[i];
    if (!Number.isFinite(c) || c === 0) continue;
    const mag = Math.abs(c);
    const coef = formatTrendCoef(mag);
    let body: string;
    if (i === 0) body = coef;
    else if (i === 1) body = mag === 1 ? 'x' : `${coef}x`;
    else body = mag === 1 ? `x^{${i}}` : `${coef}x^{${i}}`;
    if (terms.length === 0) body = (c < 0 ? '-' : '') + body;
    else body = (c < 0 ? ' - ' : ' + ') + body;
    terms.push(body);
  }
  return `y = ${terms.length > 0 ? terms.join('') : '0'}`;
}

/**
 * Fit a trendline to a series and return one fitted value per input index.
 * Positions that cannot be fitted (no numeric points, or log/exp/power with
 * non-positive values) yield null.
 */
export function fitTrendline(values: (number | null)[], spec: TrendlineSpec): (number | null)[] {
  const pts = numericPairs(values);
  if (pts.length < 2) return values.map(() => null);
  const model = fitModel(spec, pts);
  if (!model) return values.map(() => null);
  return values.map((_, i) => {
    const y = model.eval(i + 1);
    return Number.isFinite(y) ? y : null;
  });
}

/**
 * Fit a trendline and extend it with forecast periods (Excel: Forecast >
 * Forward/Backward). Returns the extended value array plus `offset`: the
 * number of leading forecast values, so data[offset + i] is the fitted
 * value for input index i.
 *
 * Moving-average forecasts extend flat from the first/last fitted value
 * (matching Excel, which has no curve to extrapolate there).
 */
export function forecastTrendline(
  values: (number | null)[],
  spec: TrendlineSpec,
): { data: (number | null)[]; offset: number } {
  const base = fitTrendline(values, spec);
  const backward = Math.max(0, Math.floor(spec.backward ?? 0));
  const forward = Math.max(0, Math.floor(spec.forward ?? 0));
  if (backward === 0 && forward === 0) return { data: base, offset: 0 };
  const pts = numericPairs(values);
  const model = pts.length >= 2 ? fitModel(spec, pts) : null;
  const at = (idx: number): number | null => {
    // idx is a 0-based input index; model x is 1-based.
    if (idx >= 0 && idx < base.length) return base[idx];
    if (!model) return null;
    if (spec.type === 'movingAverage') {
      // Flat extension from the nearest fitted value.
      if (idx < 0) {
        for (const v of base) if (v !== null) return v;
        return null;
      }
      for (let j = base.length - 1; j >= 0; j--) if (base[j] !== null) return base[j];
      return null;
    }
    const y = model.eval(idx + 1);
    return Number.isFinite(y) ? y : null;
  };
  const data: (number | null)[] = [];
  for (let i = -backward; i < values.length + forward; i++) data.push(at(i));
  return { data, offset: backward };
}

/**
 * R-squared of the fitted trendline over the numeric points
 * (Excel: "Display R-squared value"). Returns null for moving average
 * (Excel disables R² there) and when the fit is impossible.
 */
export function trendlineRSquared(values: (number | null)[], spec: TrendlineSpec): number | null {
  if (spec.type === 'movingAverage') return null;
  const pts = numericPairs(values);
  if (pts.length < 2) return null;
  const model = fitModel(spec, pts);
  if (!model) return null;
  const mean = sumOver(pts, (p) => p.y) / pts.length;
  let ssTot = 0;
  let ssRes = 0;
  for (const p of pts) {
    const f = model.eval(p.x);
    if (!Number.isFinite(f)) return null;
    ssTot += Math.pow(p.y - mean, 2);
    ssRes += Math.pow(p.y - f, 2);
  }
  if (ssTot === 0) return ssRes === 0 ? 1 : 0;
  return Math.max(0, Math.min(1, 1 - ssRes / ssTot));
}

/**
 * Excel-style fitted equation (e.g. "y = 2.3x + 1.1"), or null when Excel
 * shows none (moving average) or the fit is impossible.
 */
export function trendlineEquation(values: (number | null)[], spec: TrendlineSpec): string | null {
  const pts = numericPairs(values);
  if (pts.length < 2) return null;
  return fitModel(spec, pts)?.equation ?? null;
}

function leastSquares(pairs: [number, number][]): { slope: number; intercept: number } {
  const n = pairs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

/**
 * Least-squares polynomial fit via the normal equations + Gauss-Jordan
 * elimination. Returns coefficients c[0..order] (ascending powers), or
 * null when the system is singular. When `fixedC0` is given, the constant
 * term is pinned to it ("Set Intercept") and only c[1..order] are solved.
 */
function polyfit(xs: number[], ys: number[], order: number, fixedC0?: number): number[] | null {
  const m = order + 1;
  const adjYs = fixedC0 === undefined ? ys : ys.map((y) => y - fixedC0);
  const start = fixedC0 === undefined ? 0 : 1;
  const n = m - start;
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < xs.length; k++) s += Math.pow(xs[k], i + j + 2 * start);
      a[i][j] = s;
    }
    let s = 0;
    for (let k = 0; k < xs.length; k++) s += adjYs[k] * Math.pow(xs[k], i + start);
    b[i] = s;
  }
  // Augment and eliminate.
  const aug = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
    }
    if (Math.abs(aug[pivot][col]) < 1e-12) return null;
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    const div = aug[col][col];
    for (let j = col; j <= n; j++) aug[col][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      for (let j = col; j <= n; j++) aug[r][j] -= factor * aug[col][j];
    }
  }
  const solved = aug.map((row) => row[n]);
  if (fixedC0 === undefined) return solved;
  return [fixedC0, ...solved];
}

export interface TrendlineDataset {
  label: string;
  /** Extended values (includes forecast); data[offset + i] is the fit for input index i. */
  data: (number | null)[];
  /** Number of leading forecast values (spec.backward). */
  offset: number;
  color: string;
  /** Index into the chart's datasets this trendline was fitted on. */
  seriesIndex: number;
  /** Fitted equation, present when spec.displayEquation and the type has one. */
  equation?: string;
  /** R-squared, present when spec.displayRSquared and the type supports it. */
  rSquared?: number | null;
}

/**
 * Convert trendline specs into extra chart datasets. The UI appends these
 * to the built chart.js config (as dashed line overlays) after
 * buildChartConfig, so every chart kind that renders on cartesian axes can
 * carry trendlines without the service knowing chart.js dataset shapes.
 *
 * The label carries the equation and/or R² when displayEquation /
 * displayRSquared are set (Excel renders them as chart text labels; on a
 * Chart.js canvas the legend entry is the carrier).
 */
export function trendlineDatasets(
  series: ChartSeries,
  trendlines: TrendlineSpec[],
): TrendlineDataset[] {
  const out: TrendlineDataset[] = [];
  for (const tl of trendlines) {
    const si = tl.seriesIndex ?? 0;
    const ds = series.datasets[si];
    if (!ds) continue;
    const { data, offset } = forecastTrendline(ds.data, tl);
    if (data.every((v) => v === null)) continue;
    const equation = tl.displayEquation ? (trendlineEquation(ds.data, tl) ?? undefined) : undefined;
    const rSquared = tl.displayRSquared ? (trendlineRSquared(ds.data, tl) ?? undefined) : undefined;
    let label = tl.label ?? `${trendlineLabel(tl.type)} (${ds.label})`;
    if (equation) label += `  ${equation}`;
    if (rSquared !== undefined && rSquared !== null) {
      label += `  R² = ${formatTrendCoef(rSquared)}`;
    }
    out.push({
      label,
      data,
      offset,
      color: tl.color ?? '#ef4444',
      seriesIndex: si,
      equation,
      rSquared,
    });
  }
  return out;
}

/**
 * Append trendline overlays to an already-built chart config. No-op for
 * non-cartesian renders (custom SVG kinds, pies, doughnuts) and for
 * 100%-stacked kinds where an overlay line would mislead.
 *
 * Forecast periods extend the category axis: labels are padded with blanks
 * and every existing dataset is padded with nulls so the trendline's
 * forward/backward points land on the new slots.
 */
export function addTrendlinesToConfig(built: BuiltConfig, series: ChartSeries, spec: ChartSpec): void {
  const trendlines = spec.trendlines;
  if (!trendlines || trendlines.length === 0) return;
  if (built.svg !== null) return; // custom SVG kinds: no cartesian axes
  if (spec.kind.includes('pie') || spec.kind.includes('doughnut')) return;
  if (spec.kind.includes('stacked100')) return;
  const extra = trendlineDatasets(series, trendlines);
  if (extra.length === 0) return;
  const data = built.config.data as unknown as {
    labels?: unknown[];
    datasets?: Record<string, unknown>[];
  };
  const datasets = data.datasets;
  if (!Array.isArray(datasets)) return;

  const maxBack = Math.max(0, ...extra.map((t) => t.offset));
  const maxFwd = Math.max(
    0,
    ...extra.map((t) => {
      const targetLen = series.datasets[t.seriesIndex]?.data.length ?? 0;
      return t.data.length - t.offset - targetLen;
    }),
  );
  if (maxBack > 0 || maxFwd > 0) {
    if (Array.isArray(data.labels)) {
      data.labels = [
        ...new Array<string>(maxBack).fill(''),
        ...(data.labels as string[]),
        ...new Array<string>(maxFwd).fill(''),
      ];
    }
    for (const ds of datasets) {
      if (Array.isArray(ds.data)) {
        ds.data = [
          ...new Array<unknown>(maxBack).fill(null),
          ...(ds.data as unknown[]),
          ...new Array<unknown>(maxFwd).fill(null),
        ];
      }
    }
  }

  for (const tl of extra) {
    let values: (number | null)[] = tl.data;
    if (maxBack > 0 || maxFwd > 0) {
      const totalLen = Array.isArray(data.labels)
        ? data.labels.length
        : ((datasets[0]?.data as unknown[] | undefined)?.length ?? tl.data.length);
      const lead = Math.max(0, maxBack - tl.offset);
      const trail = Math.max(0, totalLen - lead - tl.data.length);
      values = [
        ...new Array<number | null>(lead).fill(null),
        ...tl.data,
        ...new Array<number | null>(trail).fill(null),
      ];
    }
    // The overlay lives on the same axis as the series it was fitted on
    // (e.g. the secondary y1 axis of a combo chart) — otherwise a
    // small-scale series' trendline would be flattened onto the primary axis.
    const targetAxis = (datasets[tl.seriesIndex] as { yAxisID?: string } | undefined)?.yAxisID;
    datasets.push({
      type: 'line',
      label: tl.label,
      data: values,
      borderColor: tl.color,
      borderDash: [6, 4],
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
      fill: false,
      tension: 0,
      ...(targetAxis !== undefined ? { yAxisID: targetAxis } : {}),
    });
  }
}