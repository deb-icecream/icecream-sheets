/**
 * Forecast Sheet (Data > Forecast > Forecast Sheet).
 *
 * Uses the ENGINE's FORECAST.ETS family (packages/engine/src/
 * extended-functions8.ts — ETS(AAA) additive Holt-Winters):
 *   =FORECAST.ETS(target_date, values, timeline, [seasonality], [data_completion], [aggregation])
 *   =FORECAST.ETS.CONFINT(...)  → confidence interval half-width
 * The dialog creates a new sheet with the timeline extended by N periods,
 * actuals, forecast formulas, and lower/upper bound formulas
 * (forecast ∓ CONFINT), then reads the computed values back through the
 * host. This module holds the pure parts: timeline extension, sheet
 * layout, and formula building. Seasonality detection itself runs in the
 * engine (FORECAST.ETS.SEASONALITY).
 */

export interface ForecastInput {
  /** Timeline labels (dates or numbers), ascending. */
  timeline: (string | number)[];
  /** Historical values, same length as timeline. */
  values: number[];
  /** Periods to forecast. */
  periods: number;
  /** Confidence level 0–1 (default 0.95). */
  confidence?: number;
  /** Seasonality: 0 = auto, 1 = none, N = manual length. */
  seasonality?: number;
}

export interface ForecastSheetSpec {
  /** New sheet name. */
  name: string;
  /** Extended timeline (history + forecast periods). */
  timeline: (string | number)[];
  /** Actuals (blank for forecast rows). */
  actuals: (number | '')[];
  /** Per forecast row: the three formulas to write. */
  formulas: { forecast: string; lower: string; upper: string }[];
}

const MS_PER_DAY = 86_400_000;

function isDateLike(v: string | number): boolean {
  if (typeof v === 'number') return false;
  return !Number.isNaN(Date.parse(v));
}

/**
 * Extend a timeline by `periods` steps. Date-like timelines advance by
 * the median observed step (rounded to whole days); numeric timelines
 * advance by the median numeric step.
 */
export function extendTimeline(timeline: (string | number)[], periods: number): (string | number)[] {
  if (timeline.length === 0 || periods <= 0) return [...timeline];
  const out = [...timeline];
  const dateLike = timeline.every(isDateLike);
  if (dateLike) {
    const ms = (timeline as string[]).map((d) => Date.parse(d));
    const steps: number[] = [];
    for (let i = 1; i < ms.length; i++) steps.push(ms[i] - ms[i - 1]);
    steps.sort((a, b) => a - b);
    const stepDays = Math.max(1, Math.round((steps[Math.floor(steps.length / 2)] ?? MS_PER_DAY) / MS_PER_DAY));
    let last = ms[ms.length - 1];
    for (let i = 0; i < periods; i++) {
      last += stepDays * MS_PER_DAY;
      out.push(new Date(last).toISOString().slice(0, 10));
    }
  } else {
    const nums = timeline.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
    const steps: number[] = [];
    for (let i = 1; i < nums.length; i++) steps.push(nums[i] - nums[i - 1]);
    steps.sort((a, b) => a - b);
    const step = steps.length > 0 ? steps[Math.floor(steps.length / 2)] : 1;
    let last = nums.length > 0 ? nums[nums.length - 1] : 0;
    for (let i = 0; i < periods; i++) {
      last += step;
      out.push(Math.round(last * 1e10) / 1e10);
    }
  }
  return out;
}

/** Column letter for a 0-based index. */
function colLetter(i: number): string {
  let n = i;
  let s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/**
 * Build the forecast sheet spec. Layout:
 *   A: Timeline | B: Actuals | C: Forecast | D: Lower bound | E: Upper bound
 * Formulas reference the history block absolutely; the target date is the
 * row's own timeline cell. Bounds = forecast ∓ FORECAST.ETS.CONFINT.
 */
export function buildForecastSheetSpec(input: ForecastInput, name: string): ForecastSheetSpec {
  const { timeline, values, periods } = input;
  if (timeline.length !== values.length) throw new Error('Forecast: timeline and values must have equal length.');
  if (timeline.length < 3) throw new Error('Forecast: need at least 3 historical points.');
  if (periods < 1) throw new Error('Forecast: periods must be ≥ 1.');
  const confidence = input.confidence ?? 0.95;
  if (!(confidence > 0 && confidence < 1)) throw new Error('Forecast: confidence must be between 0 and 1.');
  const seasonality = input.seasonality ?? 0;

  const history = timeline.length;
  const fullTimeline = extendTimeline(timeline, periods);
  const valuesRef = `$B$2:$B$${history + 1}`;
  const timelineRef = `$A$2:$A$${history + 1}`;
  const seasArg = seasonality === 0 ? '' : `,${seasonality}`;

  const formulas: ForecastSheetSpec['formulas'] = [];
  for (let i = 0; i < periods; i++) {
    const excelRow = history + 2 + i; // 1-based, + header
    const target = `$A$${excelRow}`;
    const f = `=FORECAST.ETS(${target},${valuesRef},${timelineRef}${seasArg})`;
    const ci = `=FORECAST.ETS.CONFINT(${target},${valuesRef},${timelineRef},${confidence}${seasArg})`;
    formulas.push({
      forecast: f,
      lower: `=${colLetter(2)}${excelRow}-${ci}`,
      upper: `=${colLetter(2)}${excelRow}+${ci}`,
    });
  }
  return {
    name,
    timeline: fullTimeline,
    actuals: [...values, ...Array<string | number>(periods).fill('')] as (number | '')[],
    formulas,
  };
}

/** Default forecast sheet name, unique against existing sheets. */
export function forecastSheetName(base: string, existing: string[]): string {
  let name = `Forecast_${base}`;
  let i = 2;
  while (existing.includes(name)) name = `Forecast_${base}_${i++}`;
  return name;
}
