/**
 * Extended Excel-compatibility functions, batch 8.
 *
 * Real implementations (no stubs):
 * - FORECAST.ETS / FORECAST.ETS.CONFINT / FORECAST.ETS.SEASONALITY /
 *   FORECAST.ETS.STAT — ETS(AAA) additive Holt-Winters forecasting with
 *   duplicate-timeline aggregation, missing-point completion, automatic
 *   seasonality detection (autocorrelation of the detrended series), and
 *   smoothing-parameter optimization.
 * - FREQUENCY — spilling histogram of values across ascending bins.
 * - MODE.MULT — spilling vertical array of all modes.
 * - LENB — byte length (chars with code > 255 count double).
 * - TRIMRANGE — trims trailing empty rows/columns; spilling result.
 * - T — returns the value if it is text, otherwise "".
 *
 * Array results are returned as 2D InterpreterValue arrays following the
 * dynamic-arrays.ts convention: the anchor cell holds the array and the host
 * writes the neighbouring cells with the exported `spill()` helper
 * (re-exported here for convenience).
 *
 * ETS(AAA) design notes (documented approximations vs. Excel):
 * - Optimization: Excel uses a proprietary optimizer; here alpha, beta and
 *   gamma are chosen by a coarse grid search over {0.1, 0.2, ..., 0.9}
 *   minimizing the in-sample sum of squared one-step errors.
 * - Confidence interval: additive-ETS prediction-interval approximation
 *   sigma_h = RMSE * sqrt(1 + (h-1) * alpha^2); the returned half-width is
 *   z((1 + confidence_level) / 2) * sigma_h with z from Acklam's inverse
 *   normal CDF approximation. Excel's exact interval accounts for all
 *   smoothing parameters and the seasonal pattern; this is a documented
 *   simplification.
 * - Timeline cleaning: duplicate time stamps are aggregated (aggregation
 *   arg: 0=average (default), 1=sum, 2=count, 3=counta, 4=max, 5=median,
 *   6=min); missing lattice points (<= 30% of the expected lattice) are
 *   filled with zeros (data_completion=0) or by linear interpolation
 *   between the surrounding known points (data_completion=1, default —
 *   this generalizes Excel's "average of neighbours" to consecutive gaps);
 *   more than 30% missing returns #N/A.
 * - Errors: #N/A when the timeline is too short (< 3 points non-seasonal,
 *   < 2 full seasons when seasonal), mismatched range sizes, non-numeric
 *   timeline or > 30% missing points; #NUM! for invalid seasonality
 *   (non-integer or outside 0..8760), data_completion, aggregation,
 *   statistic_type, confidence_level, or a target_date before the end of
 *   the timeline.
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
  SimpleRangeValue,
} from 'hyperformula';
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { spill, to2DArray } from './dynamic-arrays.js';

export { spill, to2DArray };

/** A computed 2D array result. */
type ArrayResult = InterpreterValue[][];

/** Cast a 2D array to InterpreterValue (runtime supports it; types don't). */
function asValue(arr: ArrayResult): InterpreterValue {
  return arr as unknown as InterpreterValue;
}

/** Flatten a scalar / 2D array / SimpleRangeValue into a 1D list. */
function flattenValues(value: InterpreterValue): InterpreterValue[] {
  if (value instanceof SimpleRangeValue) {
    return flattenValues(value.data as unknown as InterpreterValue);
  }
  if (Array.isArray(value)) {
    const out: InterpreterValue[] = [];
    for (const row of value) {
      if (Array.isArray(row)) out.push(...row);
      else out.push(row);
    }
    return out;
  }
  return [value];
}

/** First CellError found in an array-ish value, or null. */
function firstError(value: InterpreterValue): CellError | null {
  for (const v of flattenValues(value)) {
    if (v instanceof CellError) return v;
  }
  return null;
}

/** Numeric elements of a value (non-numeric, non-finite entries are dropped). */
function numericList(value: InterpreterValue): number[] {
  const out: number[] = [];
  for (const v of flattenValues(value)) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Scalar numeric arg with default; EmptyValue/undefined -> default; error propagates. */
function numScalar(
  v: InterpreterValue | undefined,
  dflt: number,
): number | CellError {
  if (v === undefined || v === EmptyValue) return dflt;
  if (v instanceof CellError) return v;
  const n = Number(v);
  return Number.isNaN(n) ? new CellError(ErrorType.VALUE, 'Expected a number.') : n;
}

function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Least-squares linear regression: returns {slope, intercept}. */
function linreg(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: my - slope * mx };
}

/** Biased autocorrelation of x at the given lag. */
function autocorr(x: number[], lag: number): number {
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i]! - mean;
    den += d * d;
  }
  if (den === 0) return 0;
  let num = 0;
  for (let i = lag; i < n; i++) {
    num += (x[i]! - mean) * (x[i - lag]! - mean);
  }
  return num / den;
}

/**
 * Detect the seasonal period via autocorrelation of the detrended series.
 * Returns the lag with the highest autocorrelation, or 0 when no seasonal
 * pattern is found (best correlation below 0.3) or there is not enough data.
 */
export function detectSeasonality(values: number[]): number {
  const n = values.length;
  if (n < 8) return 0;
  // Detrend with a least-squares line so trend does not masquerade as seasonality.
  const xs = values.map((_, i) => i);
  const { slope, intercept } = linreg(xs, values);
  const resid = values.map((y, i) => y - (intercept + slope * i));
  const maxLag = Math.min(120, Math.floor(n / 2));
  let bestLag = 0;
  let bestCorr = 0.3; // minimum correlation to accept a seasonal pattern
  for (let lag = 2; lag <= maxLag; lag++) {
    if (n < 2 * lag) continue; // need at least two full cycles
    const c = autocorr(resid, lag);
    if (c > bestCorr) {
      bestCorr = c;
      bestLag = lag;
    }
  }
  return bestLag;
}

/** Aggregation of duplicate timeline values. Modes: 0=avg 1=sum 2=count 3=counta 4=max 5=median 6=min. */
function aggregateValues(group: number[], mode: number): number {
  switch (mode) {
    case 0:
      return group.reduce((a, b) => a + b, 0) / group.length;
    case 1:
      return group.reduce((a, b) => a + b, 0);
    case 2:
    case 3:
      return group.length;
    case 4:
      return Math.max(...group);
    case 5: {
      const s = [...group].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
    }
    case 6:
      return Math.min(...group);
    default:
      return group[0]!;
  }
}

interface EtsSeries {
  values: number[];
  timeline: number[];
  step: number;
}

/**
 * Clean the (values, timeline) pair: drop non-numeric values, require equal
 * range sizes, sort by timeline, aggregate duplicates, validate a constant
 * step and fill missing lattice points.
 */
function prepareEtsSeries(
  valuesArg: InterpreterValue,
  timelineArg: InterpreterValue,
  dataCompletion: number,
  aggregation: number,
): EtsSeries | CellError {
  const vFlat = flattenValues(valuesArg);
  const tFlat = flattenValues(timelineArg);
  if (vFlat.length !== tFlat.length) {
    return new CellError(ErrorType.NA, 'Values and timeline must be the same size.');
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < vFlat.length; i++) {
    const v = vFlat[i]!;
    const t = tFlat[i]!;
    if (v instanceof CellError) return v;
    if (t instanceof CellError) return t;
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      return new CellError(ErrorType.NA, 'Timeline must contain dates/numbers.');
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) continue; // ignore non-numeric values
    pairs.push([t, v]);
  }
  if (pairs.length < 3) {
    return new CellError(ErrorType.NA, 'At least 3 data points are required.');
  }
  pairs.sort((a, b) => a[0] - b[0]);
  // Aggregate duplicates.
  const EPS = 1e-9;
  const agg: Array<[number, number]> = [];
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && Math.abs(pairs[j + 1]![0] - pairs[i]![0]) < EPS) j++;
    const group = pairs.slice(i, j + 1).map((p) => p[1]);
    agg.push([pairs[i]![0], aggregateValues(group, aggregation)]);
    i = j + 1;
  }
  // Strictly increasing check.
  for (let k = 1; k < agg.length; k++) {
    if (agg[k]![0] - agg[k - 1]![0] < EPS) {
      return new CellError(ErrorType.NA, 'Timeline must be increasing.');
    }
  }
  // Constant step: the step is the median of the observed diffs; every diff
  // must be an integer multiple of it.
  const diffs = agg.slice(1).map((p, k) => p[0] - agg[k]![0]);
  const step = median(diffs);
  if (!(step > 0)) {
    return new CellError(ErrorType.NA, 'Timeline step must be positive.');
  }
  const stepEps = 1e-6 * Math.max(1, Math.abs(step));
  for (const d of diffs) {
    const mult = Math.round(d / step);
    if (mult < 1 || Math.abs(d - mult * step) > stepEps) {
      return new CellError(ErrorType.NA, 'Timeline requires a constant step.');
    }
  }
  // Fill missing lattice points (Excel allows up to 30% missing).
  const t0 = agg[0]![0];
  const tN = agg[agg.length - 1]![0];
  const expectedCount = Math.round((tN - t0) / step) + 1;
  const missing = expectedCount - agg.length;
  if (missing > 0 && missing / expectedCount > 0.3) {
    return new CellError(ErrorType.NA, 'Too many missing timeline points.');
  }
  const known = new Map<number, number>();
  for (const [t, v] of agg) known.set(Math.round((t - t0) / step), v);
  const values: number[] = [];
  const timeline: number[] = [];
  for (let k = 0; k < expectedCount; k++) {
    timeline.push(t0 + k * step);
    if (known.has(k)) {
      values.push(known.get(k)!);
      continue;
    }
    if (dataCompletion === 0) {
      values.push(0);
      continue;
    }
    // Linear interpolation between the surrounding known points (for a
    // single gap this is exactly the average of the neighbours).
    let a = k - 1;
    while (a >= 0 && !known.has(a)) a--;
    let b = k + 1;
    while (b < expectedCount && !known.has(b)) b++;
    const va = a >= 0 ? known.get(a)! : known.get(b)!;
    const vb = b < expectedCount ? known.get(b)! : known.get(a)!;
    values.push(b === a ? va : va + ((vb - va) * (k - a)) / (b - a));
  }
  return { values, timeline, step };
}

interface EtsFit {
  alpha: number;
  beta: number;
  gamma: number;
  level: number;
  trend: number;
  seasonal: number[];
  sse: number;
  rmse: number;
  mae: number;
  m: number;
  n: number;
}

const PARAM_GRID = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * One ETS(AAA) (additive Holt-Winters) pass with fixed smoothing parameters.
 * Uses one-step-ahead forecast errors: e_t = y_t - (l_{t-1} + b_{t-1} + s_{t-m}).
 */
function runHoltWinters(
  y: number[],
  m: number,
  alpha: number,
  beta: number,
  gamma: number,
): EtsFit {
  const n = y.length;
  let l: number;
  let b: number;
  const s = new Array<number>(m).fill(0);
  if (m === 1) {
    l = y[0]!;
    b = n > 1 ? (y[n - 1]! - y[0]!) / (n - 1) : 0;
  } else {
    const first = y.slice(0, m);
    const mean1 = first.reduce((a, x) => a + x, 0) / m;
    l = mean1;
    if (n >= 2 * m) {
      const second = y.slice(m, 2 * m);
      const mean2 = second.reduce((a, x) => a + x, 0) / m;
      b = (mean2 - mean1) / m;
    } else {
      b = (y[n - 1]! - y[0]!) / (n - 1);
    }
    let sMean = 0;
    for (let j = 0; j < m; j++) {
      s[j] = y[j]! - mean1;
      sMean += s[j]!;
    }
    sMean /= m;
    for (let j = 0; j < m; j++) s[j]! -= sMean; // center seasonal initials
  }
  let sse = 0;
  let sae = 0;
  for (let t = 1; t <= n; t++) {
    const yt = y[t - 1]!;
    const idx = mod(t - 1, m); // buffer slot of s_{t-m}
    const seas = m === 1 ? 0 : s[idx]!;
    const yhat = l + b + seas;
    const e = yt - yhat;
    sse += e * e;
    sae += Math.abs(e);
    const lNew = alpha * (yt - seas) + (1 - alpha) * (l + b);
    const bNew = beta * (lNew - l) + (1 - beta) * b;
    if (m > 1) {
      s[idx] = gamma * (yt - l - b) + (1 - gamma) * seas;
    }
    l = lNew;
    b = bNew;
  }
  return {
    alpha,
    beta,
    gamma: m === 1 ? 0 : gamma,
    level: l,
    trend: b,
    seasonal: s,
    sse,
    rmse: Math.sqrt(sse / n),
    mae: sae / n,
    m,
    n,
  };
}

/**
 * Fit ETS(AAA) by coarse grid search over the smoothing parameters,
 * minimizing the in-sample sum of squared one-step errors.
 * (Excel uses a proprietary optimizer; this is the documented substitute.)
 */
export function fitEtsAAA(y: number[], m: number): EtsFit {
  let best: EtsFit | null = null;
  for (const alpha of PARAM_GRID) {
    for (const beta of PARAM_GRID) {
      if (m === 1) {
        const f = runHoltWinters(y, m, alpha, beta, 0);
        if (best === null || f.sse < best.sse) best = f;
      } else {
        for (const gamma of PARAM_GRID) {
          const f = runHoltWinters(y, m, alpha, beta, gamma);
          if (best === null || f.sse < best.sse) best = f;
        }
      }
    }
  }
  return best!;
}

/** h-step-ahead additive ETS forecast. */
export function etsForecast(fit: EtsFit, h: number): number {
  const seas = fit.m === 1 ? 0 : fit.seasonal[mod(fit.n + h - 1 - fit.m, fit.m)]!;
  return fit.level + h * fit.trend + seas;
}

/**
 * Acklam's approximation of the inverse standard normal CDF.
 * Accurate to ~1e-9; used for confidence-interval z-scores.
 */
function normInv(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

interface EtsArgs {
  series: EtsSeries;
  m: number;
  fit: EtsFit;
  h: number;
}

/**
 * Shared preparation for the FORECAST.ETS family: validates the optional
 * args, cleans the series, resolves the seasonal period and fits the model.
 */
function prepareEts(
  valuesArg: InterpreterValue,
  timelineArg: InterpreterValue,
  targetArg: InterpreterValue | undefined,
  seasonalityArg: InterpreterValue | undefined,
  dataCompletionArg: InterpreterValue | undefined,
  aggregationArg: InterpreterValue | undefined,
): EtsArgs | CellError {
  if (targetArg instanceof CellError) return targetArg;
  const target = Number(targetArg === undefined || targetArg === EmptyValue ? NaN : targetArg);
  if (!Number.isFinite(target)) {
    return new CellError(ErrorType.VALUE, 'target_date must be a number.');
  }
  const seasonality = numScalar(seasonalityArg, 1);
  if (seasonality instanceof CellError) return seasonality;
  const dataCompletion = numScalar(dataCompletionArg, 1);
  if (dataCompletion instanceof CellError) return dataCompletion;
  const aggregation = numScalar(aggregationArg, 0);
  if (aggregation instanceof CellError) return aggregation;
  if (
    !Number.isInteger(seasonality) ||
    seasonality < 0 ||
    seasonality > 8760
  ) {
    return new CellError(ErrorType.NUM, 'seasonality must be an integer 0..8760.');
  }
  if (dataCompletion !== 0 && dataCompletion !== 1) {
    return new CellError(ErrorType.NUM, 'data_completion must be 0 or 1.');
  }
  if (!Number.isInteger(aggregation) || aggregation < 0 || aggregation > 6) {
    return new CellError(ErrorType.NUM, 'aggregation must be an integer 0..6.');
  }
  const series = prepareEtsSeries(valuesArg, timelineArg, dataCompletion, aggregation);
  if (series instanceof CellError) return series;
  let m: number;
  if (seasonality === 0) {
    m = 1;
  } else if (seasonality === 1) {
    const detected = detectSeasonality(series.values);
    m = detected === 0 ? 1 : detected;
  } else {
    m = seasonality;
  }
  if (m > 1 && series.values.length < 2 * m) {
    return new CellError(ErrorType.NA, 'Not enough data for the seasonal period.');
  }
  const fit = fitEtsAAA(series.values, m);
  const h = Math.round((target - series.timeline[series.timeline.length - 1]!) / series.step);
  if (h < 1) {
    return new CellError(ErrorType.NUM, 'target_date must be after the timeline.');
  }
  return { series, m, fit, h };
}

export class ExtendedPlugin8 extends FunctionPlugin {
  public static implementedFunctions = {
    'FORECAST.ETS': {
      method: 'forecastEts',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    'FORECAST.ETS.CONFINT': {
      method: 'forecastEtsConfint',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    'FORECAST.ETS.SEASONALITY': {
      method: 'forecastEtsSeasonality',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    'FORECAST.ETS.STAT': {
      method: 'forecastEtsStat',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    FREQUENCY: {
      method: 'frequency',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
      ],
    },
    'MODE.MULT': {
      method: 'modeMult',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
    },
    LENB: {
      method: 'lenb',
      parameters: [{ argumentType: FunctionArgumentType.SCALAR }],
    },
    TRIMRANGE: {
      method: 'trimrange',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
    },
    // NOTE: T() is intentionally NOT registered here — HyperFormula ships a
    // built-in T (verified: =T("x") -> "x"). Registering ours would throw a
    // duplicate-registration error.
  };

  public forecastEts(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('FORECAST.ETS'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [targetArg, valuesArg, timelineArg, seasonalityArg, dataCompletionArg, aggregationArg] =
          args;
        const prep = prepareEts(
          valuesArg!,
          timelineArg!,
          targetArg,
          seasonalityArg,
          dataCompletionArg,
          aggregationArg,
        );
        if (prep instanceof CellError) return prep;
        return etsForecast(prep.fit, prep.h);
      },
    );
  }

  public forecastEtsConfint(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('FORECAST.ETS.CONFINT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [
          targetArg,
          valuesArg,
          timelineArg,
          confidenceArg,
          seasonalityArg,
          dataCompletionArg,
          aggregationArg,
        ] = args;
        const confidence = numScalar(confidenceArg, 0.95);
        if (confidence instanceof CellError) return confidence;
        if (!(confidence > 0) || !(confidence < 1)) {
          return new CellError(ErrorType.NUM, 'confidence_level must be between 0 and 1.');
        }
        const prep = prepareEts(
          valuesArg!,
          timelineArg!,
          targetArg,
          seasonalityArg,
          dataCompletionArg,
          aggregationArg,
        );
        if (prep instanceof CellError) return prep;
        // Additive-ETS prediction-interval approximation:
        // sigma_h = RMSE * sqrt(1 + (h-1) * alpha^2); half-width = z * sigma_h.
        const z = normInv((1 + confidence) / 2);
        const sigmaH = prep.fit.rmse * Math.sqrt(1 + (prep.h - 1) * prep.fit.alpha ** 2);
        return z * sigmaH;
      },
    );
  }

  public forecastEtsSeasonality(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('FORECAST.ETS.SEASONALITY'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [valuesArg, timelineArg, dataCompletionArg, aggregationArg] = args;
        const dataCompletion = numScalar(dataCompletionArg, 1);
        if (dataCompletion instanceof CellError) return dataCompletion;
        const aggregation = numScalar(aggregationArg, 0);
        if (aggregation instanceof CellError) return aggregation;
        if (dataCompletion !== 0 && dataCompletion !== 1) {
          return new CellError(ErrorType.NUM, 'data_completion must be 0 or 1.');
        }
        if (!Number.isInteger(aggregation) || aggregation < 0 || aggregation > 6) {
          return new CellError(ErrorType.NUM, 'aggregation must be an integer 0..6.');
        }
        const series = prepareEtsSeries(valuesArg!, timelineArg!, dataCompletion, aggregation);
        if (series instanceof CellError) return series;
        return detectSeasonality(series.values);
      },
    );
  }

  public forecastEtsStat(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('FORECAST.ETS.STAT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [
          valuesArg,
          timelineArg,
          statTypeArg,
          seasonalityArg,
          dataCompletionArg,
          aggregationArg,
        ] = args;
        const statType = numScalar(statTypeArg, 1);
        if (statType instanceof CellError) return statType;
        if (!Number.isInteger(statType) || statType < 1 || statType > 7) {
          return new CellError(ErrorType.NUM, 'statistic_type must be an integer 1..7.');
        }
        // FORECAST.ETS.STAT has no target_date; use a point just past the end
        // of the timeline as the (dummy) target so the shared preparation
        // (validation, cleaning, seasonality resolution, fit) can run. h is unused.
        const timelineNums = numericList(timelineArg!);
        const target =
          timelineNums.length > 0 ? timelineNums[timelineNums.length - 1]! + 1 : NaN;
        const prep = prepareEts(
          valuesArg!,
          timelineArg!,
          target as unknown as InterpreterValue,
          seasonalityArg,
          dataCompletionArg,
          aggregationArg,
        );
        if (prep instanceof CellError) return prep;
        const fit = prep.fit;
        switch (statType) {
          case 1:
            return fit.alpha;
          case 2:
            return fit.beta;
          case 3:
            return fit.gamma;
          case 4: {
            // MASE = MAE / MAE of the naive (random-walk) forecast.
            const y = prep.series.values;
            let naive = 0;
            for (let i = 1; i < y.length; i++) naive += Math.abs(y[i]! - y[i - 1]!);
            naive /= y.length - 1;
            if (naive === 0) {
              return new CellError(ErrorType.DIV_BY_ZERO, 'Naive MAE is zero.');
            }
            return fit.mae / naive;
          }
          case 5: {
            // SMAPE = mean(2|e| / (|y| + |yhat|)) * 100, one-step errors.
            const errs = oneStepErrors(prep.series.values, fit);
            let sum = 0;
            let cnt = 0;
            for (const { e, y: yv, yhat } of errs) {
              const den = Math.abs(yv) + Math.abs(yhat);
              if (den === 0) continue;
              sum += (2 * Math.abs(e)) / den;
              cnt++;
            }
            if (cnt === 0) return 0;
            return (100 * sum) / cnt;
          }
          case 6:
            return fit.mae;
          case 7:
            return fit.rmse;
          default:
            return new CellError(ErrorType.NUM, 'statistic_type must be an integer 1..7.');
        }
      },
    );
  }

  public frequency(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('FREQUENCY'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [dataArg, binsArg] = args;
        const dataErr = firstError(dataArg!);
        if (dataErr) return dataErr;
        const binsErr = firstError(binsArg!);
        if (binsErr) return binsErr;
        const data = numericList(dataArg!); // text/logicals/empty ignored, like Excel
        const bins = numericList(binsArg!);
        for (let i = 1; i < bins.length; i++) {
          if (!(bins[i]! > bins[i - 1]!)) {
            return new CellError(ErrorType.VALUE, 'bins_array must be ascending.');
          }
        }
        const counts: number[] = new Array(bins.length + 1).fill(0);
        for (const x of data) {
          let placed = false;
          for (let i = 0; i < bins.length; i++) {
            if (x <= bins[i]!) {
              counts[i]!++;
              placed = true;
              break;
            }
          }
          if (!placed) counts[bins.length]!++; // overflow bin
        }
        // Spilling vertical array: one row per bin plus the overflow bin.
        return asValue(counts.map((c) => [c] as InterpreterValue[]));
      },
    );
  }

  public modeMult(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('MODE.MULT'),
      (rangeArg: InterpreterValue): InterpreterValue => {
        const err = firstError(rangeArg);
        if (err) return err;
        const nums = numericList(rangeArg); // text/logicals/empty ignored, like Excel
        const freq = new Map<number, number>();
        const order: number[] = [];
        for (const v of nums) {
          if (!freq.has(v)) {
            freq.set(v, 0);
            order.push(v);
          }
          freq.set(v, freq.get(v)! + 1);
        }
        let maxFreq = 0;
        for (const f of freq.values()) maxFreq = Math.max(maxFreq, f);
        if (maxFreq < 2) {
          return new CellError(ErrorType.NA, 'No value repeats.');
        }
        const modes = order.filter((v) => freq.get(v) === maxFreq);
        // Single mode: return the scalar directly. A 1x1 array result is not
        // intersected by HyperFormula when referenced in scalar context
        // (e.g. =ROUND(A2,12) where A2 holds =MODE.MULT(...)), yielding
        // #VALUE!; Excel's implicit intersection returns the scalar. The grid
        // display is identical (1x1 array renders as its value).
        if (modes.length === 1) return modes[0] as InterpreterValue;
        return asValue(modes.map((v) => [v] as InterpreterValue[]));
      },
    );
  }

  public lenb(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('LENB'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const s = String(arg === EmptyValue ? '' : arg);
        let bytes = 0;
        for (let i = 0; i < s.length; i++) {
          bytes += s.charCodeAt(i)! > 255 ? 2 : 1;
        }
        return bytes;
      },
    );
  }

  public trimrange(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('TRIMRANGE'),
      (rangeArg: InterpreterValue): InterpreterValue => {
        const m = to2DArray(rangeArg);
        if (m.length === 0 || (m[0]?.length ?? 0) === 0) {
          return new CellError(ErrorType.VALUE, 'Empty range.');
        }
        let lastRow = -1;
        let lastCol = -1;
        for (let r = 0; r < m.length; r++) {
          for (let c = 0; c < m[r]!.length; c++) {
            if (m[r]![c] !== EmptyValue) {
              if (r > lastRow) lastRow = r;
              if (c > lastCol) lastCol = c;
            }
          }
        }
        if (lastRow < 0) {
          return new CellError(ErrorType.VALUE, 'Range is entirely empty.');
        }
        const out: ArrayResult = [];
        for (let r = 0; r <= lastRow; r++) {
          out.push(m[r]!.slice(0, lastCol + 1));
        }
        return asValue(out);
      },
    );
  }

  public t(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('T'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        return typeof arg === 'string' ? arg : '';
      },
    );
  }
}

/**
 * Recompute the one-step forecast errors of a fitted ETS model
 * (used for SMAPE in FORECAST.ETS.STAT).
 */
function oneStepErrors(
  y: number[],
  fit: EtsFit,
): Array<{ e: number; y: number; yhat: number }> {
  const n = y.length;
  const m = fit.m;
  // Re-run the recursion capturing forecasts; simplest correct approach:
  // replay runHoltWinters' state evolution using the fitted parameters and
  // the same initialization.
  let l: number;
  let b: number;
  const s = new Array<number>(m).fill(0);
  if (m === 1) {
    l = y[0]!;
    b = n > 1 ? (y[n - 1]! - y[0]!) / (n - 1) : 0;
  } else {
    const first = y.slice(0, m);
    const mean1 = first.reduce((a, x) => a + x, 0) / m;
    l = mean1;
    if (n >= 2 * m) {
      const second = y.slice(m, 2 * m);
      const mean2 = second.reduce((a, x) => a + x, 0) / m;
      b = (mean2 - mean1) / m;
    } else {
      b = (y[n - 1]! - y[0]!) / (n - 1);
    }
    let sMean = 0;
    for (let j = 0; j < m; j++) {
      s[j] = y[j]! - mean1;
      sMean += s[j]!;
    }
    sMean /= m;
    for (let j = 0; j < m; j++) s[j]! -= sMean;
  }
  const out: Array<{ e: number; y: number; yhat: number }> = [];
  for (let t = 1; t <= n; t++) {
    const yt = y[t - 1]!;
    const idx = mod(t - 1, m);
    const seas = m === 1 ? 0 : s[idx]!;
    const yhat = l + b + seas;
    out.push({ e: yt - yhat, y: yt, yhat });
    const lNew = fit.alpha * (yt - seas) + (1 - fit.alpha) * (l + b);
    const bNew = fit.beta * (lNew - l) + (1 - fit.beta) * b;
    if (m > 1) {
      s[idx] = fit.gamma * (yt - l - b) + (1 - fit.gamma) * seas;
    }
    l = lNew;
    b = bNew;
  }
  return out;
}

export function registerExtendedFunctions8(): void {
  if (HyperFormula.getFunctionPlugin('FORECAST.ETS') !== undefined) return;
  const names = {
    'FORECAST.ETS': 'FORECAST.ETS',
    'FORECAST.ETS.CONFINT': 'FORECAST.ETS.CONFINT',
    'FORECAST.ETS.SEASONALITY': 'FORECAST.ETS.SEASONALITY',
    'FORECAST.ETS.STAT': 'FORECAST.ETS.STAT',
    FREQUENCY: 'FREQUENCY',
    'MODE.MULT': 'MODE.MULT',
    LENB: 'LENB',
    TRIMRANGE: 'TRIMRANGE',
  };
  HyperFormula.registerFunctionPlugin(ExtendedPlugin8, { enGB: names, enUS: names });
}
