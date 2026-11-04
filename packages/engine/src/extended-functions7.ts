/**
 * Extended Excel-compatibility functions, batch 7.
 * CONVERT, INFO, ASC, DBCS, JIS, BAHTTEXT, PHONETIC,
 * LINEST, LOGEST, PERCENTOF, COUPDAYS, COUPDAYBS, COUPDAYSNC,
 * COUPNCD, COUPPCD, PRICEDISC, YIELDDISC, PRICEMAT, YIELDMAT, ACCRINTM.
 *
 * Financial day-count / coupon-schedule helpers are reimplemented locally
 * (the copies in financial-functions.ts / financial-functions3.ts are
 * module-private): US NASD 30/360 for basis 0, European 30/360 for basis 4,
 * actual day counts for bases 1/2/3; days-per-year B is 360 for bases
 * 0/2/4, 365 for basis 3, and 365/366 for basis 1 depending on whether the
 * interval spans a Feb 29 — Microsoft's documented conventions.
 *
 * LINEST / LOGEST implement Microsoft's documented multiple-regression
 * output: coefficients in reverse variable order followed by the constant,
 * and (with stats = TRUE) the standard-error row, R² / standard-error-of-y
 * row, F / degrees-of-freedom row and SSreg / SSresid row, padded with
 * #N/A. LOGEST fits y = b·m₁^x₁···mₚ^xₚ by running the same regression on
 * ln(y) and exponentiating the coefficient row.
 *
 * BAHTTEXT verbalizes a number in Thai per Microsoft's documented
 * behaviour: Thai digit/place words with ล้าน grouping, เอ็ด for a
 * non-leading 1 in the units place, ยี่สิบ for 20, บาทถ้วน for whole
 * amounts, a two-digit สตางค์ reading for the fractional part, ลบ for
 * negatives, and rounding to two decimals.
 */
import {
  ArraySize,
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
  SimpleRangeValue,
} from 'hyperformula';
import type { Ast, ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';

// Unit conversion factors to base units
const CONVERT_TABLE: Record<string, number> = {
  // Length (meters)
  'm': 1, 'km': 1000, 'cm': 0.01, 'mm': 0.001,
  'mi': 1609.344, 'yd': 0.9144, 'ft': 0.3048, 'in': 0.0254,
  // Mass (kg)
  'kg': 1, 'g': 0.001, 'lbm': 0.45359237, 'ozm': 0.028349523125,
  // Time (seconds)
  's': 1, 'sec': 1, 'min': 60, 'hr': 3600, 'day': 86400, 'yr': 31557600,
  // Pressure (Pa)
  'pa': 1, 'kpa': 1000, 'psi': 6894.757, 'atm': 101325,
  // Energy (J)
  'j': 1, 'kj': 1000, 'cal': 4.184, 'btu': 1055.056, 'wh': 3600, 'kwh': 3600000,
  // Volume (L)
  'l': 1, 'ml': 0.001, 'gal': 3.785411784, 'qt': 0.946352946,
  // Temperature handled separately
};

// ---------------------------------------------------------------------------
// Date / day-count helpers (UTC-based; Excel serial epoch 1899-12-30) —
// same conventions as financial-functions.ts / financial-functions3.ts.
// ---------------------------------------------------------------------------

type YMD = [number, number, number];

function serialToYMD(serial: number): YMD {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

function ymdToSerial(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / 86400000 + 25569);
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isLastDayOfFeb(y: number, m: number, d: number): boolean {
  return m === 2 && d === daysInMonth(y, m);
}

/** EDATE semantics: shift by whole months, clamping the day to end of month. */
function addMonthsSerial(serial: number, months: number): number {
  const [y, m, d] = serialToYMD(serial);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12 + 1;
  return ymdToSerial(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** US (NASD) 30/360 day count. */
function days360US(s1: number, s2: number): number {
  let [y1, m1, d1] = serialToYMD(Math.trunc(s1));
  let [y2, m2, d2] = serialToYMD(Math.trunc(s2));
  const d1LastFeb = isLastDayOfFeb(y1, m1, d1);
  const d2LastFeb = isLastDayOfFeb(y2, m2, d2);
  if (d1 === 31 || d1LastFeb) d1 = 30;
  if (d2LastFeb && d1LastFeb) {
    d2 = 30;
  } else if (d2 === 31) {
    if (d1 === 30) {
      d2 = 30;
    } else {
      d2 = 1;
      m2 += 1;
      if (m2 > 12) {
        m2 = 1;
        y2 += 1;
      }
    }
  }
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1);
}

/** European 30/360 day count. */
function days360EU(s1: number, s2: number): number {
  const [y1, m1, dd1] = serialToYMD(Math.trunc(s1));
  const [y2, m2, dd2] = serialToYMD(Math.trunc(s2));
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (Math.min(dd2, 30) - Math.min(dd1, 30));
}

/**
 * Days between two serial dates per day-count basis.
 * basis: 0 = US 30/360, 1 = actual/actual, 2 = actual/360, 3 = actual/365,
 * 4 = European 30/360.
 */
function daysBetween(s1: number, s2: number, basis: number): number {
  if (basis === 1 || basis === 2 || basis === 3) return Math.round(s2 - s1);
  if (basis === 4) return days360EU(s1, s2);
  return days360US(s1, s2);
}

/** True when the (s1, s2] interval contains Feb 29 of a leap year. */
function containsLeapDay(s1: number, s2: number): boolean {
  const lo = Math.min(s1, s2);
  const hi = Math.max(s1, s2);
  const [y1] = serialToYMD(lo);
  const [y2] = serialToYMD(hi);
  for (let y = y1; y <= y2; y++) {
    if (!isLeapYear(y)) continue;
    const feb29 = ymdToSerial(y, 2, 29);
    if (feb29 > lo && feb29 <= hi) return true;
  }
  return false;
}

/**
 * Days in the year (the B of Microsoft's DIM/B formulas) for a basis.
 * For actual/actual (basis 1) this is 366 when the interval spans a
 * leap day, else 365. Bases 0, 2 and 4 use 360; basis 3 uses 365.
 */
function daysPerYear(basis: number, s1: number, s2: number): number {
  if (basis === 1) return containsLeapDay(s1, s2) ? 366 : 365;
  if (basis === 3) return 365;
  return 360; // 0, 2, 4
}

/**
 * Days in the coupon period in which settlement falls (COUPDAYS' E),
 * over the coupon schedule anchored at maturity.
 */
function couponPeriodDays(
  settle: number, mat: number, freq: number, basis: number,
): number {
  const step = 12 / freq;
  let next = mat;
  let prev = mat;
  for (let k = 0; k <= 10000; k++) {
    const d = addMonthsSerial(mat, -k * step);
    if (d > settle) {
      next = d;
    } else {
      prev = d;
      break;
    }
  }
  return daysBetween(prev, next, basis);
}

/** Year fraction A/B between two serials per day-count basis. */
function yearFraction(s1: number, s2: number, basis: number): number {
  return daysBetween(s1, s2, basis) / daysPerYear(basis, s1, s2);
}

/** Truncated, range-checked basis argument (default 0); null when invalid. */
function parseBasis(v: InterpreterValue | undefined): number | null {
  if (v === undefined || v === EmptyValue) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const b = Math.trunc(n);
  return b >= 0 && b <= 4 ? b : null;
}

/** Numeric scalar argument; NaN passes through for the caller to reject. */
function numArg(v: InterpreterValue | undefined): number {
  if (v === undefined || v === EmptyValue) return NaN;
  return Number(v);
}

// ---------------------------------------------------------------------------
// Range helpers
// ---------------------------------------------------------------------------

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

function to2DValues(value: InterpreterValue): InterpreterValue[][] {
  if (value instanceof SimpleRangeValue) {
    return value.data as unknown as InterpreterValue[][];
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && Array.isArray(value[0])) return value as InterpreterValue[][];
    return [value as InterpreterValue[]];
  }
  return [[value]];
}

/**
 * Wrap a 2D array as a range value for return from an array function.
 * The function MUST also declare an `arraySizeMethod` in its metadata
 * (the HyperFormula-native mechanism, cf. MatrixPlugin's MMULT): the
 * graph builder then creates an ArrayVertex for the call, whose cells
 * export/spill individually. Without a predicted size the call lands in
 * a scalar FormulaCellVertex and the exporter refuses the range value —
 * the anchor cell reads #VALUE! ("Cell range not allowed") even though
 * nested consumers (SUM, INDEX) see the correct values. (Returning a
 * plain JS array instead — the dynamic-arrays.ts `asValue` convention —
 * fixes the anchor but breaks nested consumption, so array functions
 * with range inputs use this mechanism. Verified empirically
 * 2026-10-21, function-coverage Phase 2.)
 */
function asRangeValue(arr: InterpreterValue[][]): InterpreterValue {
  return SimpleRangeValue.onlyValues(arr as never);
}

/**
 * Predicted result size for LINEST / LOGEST (arraySizeMethod): the grid
 * is (p + 1) columns wide — p slope columns plus the constant — and
 * 1 row tall, or 5 rows with stats. p follows the same orientation
 * rules as regressionInput; a non-literal stats argument predicts the
 * full 5-row grid.
 */
function regressionArraySize(
  sizeOf: (a: Ast) => ArraySize,
  ast: ProcedureAst,
): ArraySize {
  if (ast.args.length < 1 || ast.args.length > 4) return ArraySize.error();
  const ySize = sizeOf(ast.args[0]!);
  if (ySize.width <= 0 || ySize.height <= 0) return ArraySize.error();
  const rowOriented = ySize.height === 1 && ySize.width > 1;
  let p = 1;
  if (ast.args[1] !== undefined) {
    const xSize = sizeOf(ast.args[1]);
    if (xSize.width > 0 && xSize.height > 0) {
      if (!rowOriented) {
        p = xSize.height === ySize.height ? xSize.width
          : xSize.width === ySize.height ? xSize.height
          : xSize.width;
      } else {
        p = xSize.width === ySize.width ? xSize.height
          : xSize.height === ySize.width ? xSize.width
          : xSize.height;
      }
    }
  }
  let height = 1;
  const statsArg = ast.args[3] as unknown as
    | { type?: string; value?: unknown; procedureName?: string }
    | undefined;
  if (statsArg !== undefined) {
    if (statsArg.type === 'NUMBER') {
      height = Number(statsArg.value) !== 0 ? 5 : 1;
    } else if (statsArg.procedureName === 'FALSE') {
      height = 1;
    } else {
      height = 5; // TRUE literal or any non-literal: predict the full grid
    }
  }
  return new ArraySize(p + 1, height);
}

/** True when an optional argument was omitted or supplied empty. */
function isOmittedArg(value: InterpreterValue | undefined): boolean {
  if (value === undefined || value === EmptyValue) return true;
  if (value instanceof SimpleRangeValue) return flattenValues(value).length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Parse a logical argument (TRUE/FALSE, numbers, "TRUE"/"FALSE"). */
function parseLogical(
  value: InterpreterValue | undefined, dflt: boolean,
): boolean | CellError {
  if (value === undefined || value === EmptyValue) return dflt;
  if (value instanceof CellError) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return new CellError(ErrorType.VALUE, 'Expected a logical value.');
}

// ---------------------------------------------------------------------------
// Least-squares regression (LINEST / LOGEST)
// ---------------------------------------------------------------------------

interface RegressionInput {
  /** Dependent values, one per (retained) observation. */
  y: number[];
  /** Independent variables: one row per observation, p columns. */
  x: number[][];
}

/**
 * Extract (y, X) observation pairs from the known_y's / known_x's arguments
 * following Microsoft's shape rules:
 *  - known_y's in a single column → each COLUMN of known_x's is a variable;
 *  - known_y's in a single row → each ROW of known_x's is a variable;
 *  - a single variable may use any equal-sized shapes;
 *  - known_x's omitted → {1, 2, 3, …}.
 * Non-numeric pairs are dropped (Excel ignores text/logicals in the known
 * ranges); a CellError anywhere propagates. A size mismatch is #N/A.
 */
function regressionInput(
  yArg: InterpreterValue,
  xArg: InterpreterValue | undefined,
): RegressionInput | CellError {
  const y2d = to2DValues(yArg);
  const yRows = y2d.length;
  const yCols = y2d[0]?.length ?? 0;
  if (yRows === 0 || yCols === 0) return new CellError(ErrorType.NUM, 'No values.');
  const orientation: 'row' | 'col' = yRows === 1 && yCols > 1 ? 'row' : 'col';
  const n = orientation === 'row' ? yCols : yRows;
  let yRaw: InterpreterValue[] = orientation === 'row'
    ? [...y2d[0]!]
    : y2d.map(r => r[0]!);

  let xRaw: InterpreterValue[][];
  if (isOmittedArg(xArg)) {
    xRaw = yRaw.map((_, i) => [i + 1]);
  } else {
    const x2d = to2DValues(xArg!);
    const xRows = x2d.length;
    const xCols = x2d[0]?.length ?? 0;
    if (yRows > 1 && yCols > 1) {
      // Single variable, arbitrary equal shapes: flatten both row-major.
      if (xRows * xCols !== yRows * yCols) {
        return new CellError(ErrorType.NA, 'known_y\'s and known_x\'s have different sizes.');
      }
      xRaw = flattenValues(xArg!).map(v => [v]);
      yRaw = flattenValues(yArg);
    } else if (orientation === 'col') {
      if (xRows === n) {
        xRaw = x2d.map(r => [...r]);
      } else if (xCols === n) {
        // Supplied transposed: observations are the columns.
        xRaw = x2d[0]!.map((_, c) => x2d.map(r => r[c]!));
      } else {
        return new CellError(ErrorType.NA, 'known_y\'s and known_x\'s have different sizes.');
      }
    } else {
      if (xCols === n) {
        xRaw = x2d[0]!.map((_, c) => x2d.map(r => r[c]!));
      } else if (xRows === n) {
        xRaw = x2d.map(r => [...r]);
      } else {
        return new CellError(ErrorType.NA, 'known_y\'s and known_x\'s have different sizes.');
      }
    }
  }
  if (xRaw.length !== yRaw.length) {
    return new CellError(ErrorType.NA, 'known_y\'s and known_x\'s have different sizes.');
  }
  // Pair-wise retention: propagate errors; drop pairs with non-numeric data.
  const y: number[] = [];
  const x: number[][] = [];
  for (let i = 0; i < yRaw.length; i++) {
    const yv = yRaw[i]!;
    if (yv instanceof CellError) return yv;
    const row: number[] = [];
    let ok = typeof yv === 'number';
    for (const xv of xRaw[i]!) {
      if (xv instanceof CellError) return xv;
      if (typeof xv !== 'number') { ok = false; break; }
      row.push(xv);
    }
    if (ok) { y.push(yv as number); x.push(row); }
  }
  if (y.length === 0) return new CellError(ErrorType.NUM, 'No numeric values.');
  const p = x[0]!.length;
  if (x.some(r => r.length !== p)) {
    return new CellError(ErrorType.NA, 'known_x\'s rows have different sizes.');
  }
  return { y, x };
}

/** Invert a square matrix by Gauss–Jordan elimination with partial pivoting. */
function invertMatrix(mat: number[][]): number[][] | null {
  const m = mat.length;
  const a = mat.map((row, i) => {
    const ext = new Array<number>(2 * m).fill(0);
    for (let j = 0; j < m; j++) ext[j] = row[j]!;
    ext[m + i] = 1;
    return ext;
  });
  let scale = 0;
  for (const row of mat) for (const v of row) scale = Math.max(scale, Math.abs(v));
  if (scale === 0) return null;
  const tol = 1e-12 * scale;
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) <= tol) return null;
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const piv = a[col]![col]!;
    for (let c = 0; c < 2 * m; c++) a[col]![c]! /= piv;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      if (f === 0) continue;
      for (let c = 0; c < 2 * m; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map(row => row.slice(m));
}

interface RegressionFit {
  /** Coefficients in design order: [m1, …, mp] plus intercept last (if const). */
  beta: number[];
  /** Standard errors aligned with beta; NaN entries surface as #N/A. */
  se: number[];
  r2: number;
  sey: number;
  fStat: number;
  df: number;
  ssreg: number;
  ssresid: number;
}

/**
 * Least-squares fit of target on the design matrix (x columns plus an
 * intercept column when constFlag) via the normal equations
 * (DᵀD)β = Dᵀy, with (DᵀD)⁻¹ providing the coefficient covariance.
 * Returns null when the system is singular (collinear variables).
 */
function fitRegression(
  target: number[], x: number[][], constFlag: boolean,
): RegressionFit | null {
  const n = target.length;
  const p = x[0]!.length;
  const design = x.map(row => (constFlag ? [...row, 1] : [...row]));
  const k = design[0]!.length;
  // Normal equations.
  const xtx: number[][] = [];
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) {
    const row = new Array<number>(k).fill(0);
    for (let kRow = 0; kRow < n; kRow++) {
      for (let j = 0; j < k; j++) row[j]! += design[kRow]![i]! * design[kRow]![j]!;
      xty[i]! += design[kRow]![i]! * target[kRow]!;
    }
    xtx.push(row);
  }
  const inv = invertMatrix(xtx);
  if (inv === null) return null;
  const beta = inv.map((row) => {
    let s = 0;
    for (let j = 0; j < k; j++) s += row[j]! * xty[j]!;
    return s;
  });
  if (beta.some(v => !Number.isFinite(v))) return null;

  let ssresid = 0;
  let sstotal = 0;
  const mean = constFlag ? target.reduce((a, b) => a + b, 0) / n : 0;
  for (let i = 0; i < n; i++) {
    let fitted = 0;
    for (let j = 0; j < k; j++) fitted += design[i]![j]! * beta[j]!;
    const resid = target[i]! - fitted;
    ssresid += resid * resid;
    const dev = target[i]! - mean;
    sstotal += dev * dev;
  }
  let ssreg = sstotal - ssresid;
  if (ssreg < 0 && ssreg > -1e-9 * Math.max(1, sstotal)) ssreg = 0;
  const df = n - k;
  const r2 = sstotal > 0 ? ssreg / sstotal : (ssresid === 0 ? 1 : 0);
  const se = new Array<number>(k).fill(NaN);
  let sey = NaN;
  let fStat = NaN;
  if (df > 0) {
    const sigma2 = ssresid / df;
    sey = Math.sqrt(sigma2);
    for (let j = 0; j < k; j++) {
      const v = inv[j]![j]! * sigma2;
      se[j] = v >= 0 ? Math.sqrt(v) : NaN;
    }
    const dfReg = constFlag ? k - 1 : k;
    if (dfReg > 0) {
      fStat = sigma2 > 0 ? (ssreg / dfReg) / sigma2 : (ssreg > 0 ? Infinity : NaN);
    }
  }
  return { beta, se, r2, sey, fStat, df, ssreg, ssresid };
}

/**
 * Shared LINEST (exponential=false) / LOGEST (exponential=true) evaluation.
 * Output grid per Microsoft: row 1 = {mn, …, m1, b}; with stats, row 2 the
 * standard errors (seb = #N/A when const is FALSE), row 3 = {r2, sey},
 * row 4 = {F, df}, row 5 = {ssreg, ssresid}, remaining cells #N/A.
 * For LOGEST the fit runs on ln(y): the coefficient row is exponentiated
 * (m-values and b), slope standard errors are those of ln(m), and seb is
 * b × se(ln b) (delta method); r2/sey/F/ss describe the ln(y) regression.
 */
function linestLogest(
  args: InterpreterValue[], exponential: boolean,
): InterpreterValue {
  const input = regressionInput(args[0]!, args[1]);
  if (input instanceof CellError) return input;
  const constFlag = parseLogical(args[2], true);
  if (constFlag instanceof CellError) return constFlag;
  const statsFlag = parseLogical(args[3], false);
  if (statsFlag instanceof CellError) return statsFlag;
  const { y, x } = input;
  const p = x[0]!.length;

  if (exponential && y.some(v => v <= 0)) {
    return new CellError(ErrorType.NUM, 'known_y\'s must be positive for LOGEST.');
  }
  const target = exponential ? y.map(v => Math.log(v)) : [...y];
  const fit = fitRegression(target, x, constFlag);
  if (fit === null) {
    return new CellError(ErrorType.NUM, 'The regression is singular (collinear known_x\'s).');
  }
  const width = p + 1; // slopes (reversed) + constant column
  const naCell = (): InterpreterValue => new CellError(ErrorType.NA, '#N/A');
  const cell = (v: number): InterpreterValue => (Number.isNaN(v) ? naCell() : v);

  // Design-order beta/se: [m1, …, mp, (b)]. Output order is reversed.
  const betaOut: number[] = [];
  const seOut: number[] = [];
  for (let j = p - 1; j >= 0; j--) {
    betaOut.push(exponential ? Math.exp(fit.beta[j]!) : fit.beta[j]!);
    seOut.push(fit.se[j]!);
  }
  if (constFlag) {
    const bLog = fit.beta[p]!;
    betaOut.push(exponential ? Math.exp(bLog) : bLog);
    seOut.push(exponential ? Math.exp(bLog) * fit.se[p]! : fit.se[p]!);
  } else {
    betaOut.push(exponential ? 1 : 0);
    seOut.push(NaN); // seb = #N/A when const is FALSE
  }

  const grid: InterpreterValue[][] = [
    betaOut as InterpreterValue[],
  ];
  if (statsFlag) {
    grid.push(seOut.map(v => cell(v)));
    const pad = (): InterpreterValue[] => new Array<InterpreterValue>(width - 2).fill(naCell());
    grid.push([cell(fit.r2), cell(fit.sey), ...pad()]);
    grid.push([cell(fit.fStat), fit.df as InterpreterValue, ...pad()]);
    grid.push([fit.ssreg as InterpreterValue, fit.ssresid as InterpreterValue, ...pad()]);
  }
  if (grid.length === 1 && width === 1) return grid[0]![0]!;
  return asRangeValue(grid);
}

// ---------------------------------------------------------------------------
// BAHTTEXT — Thai number verbalization
// ---------------------------------------------------------------------------

const THAI_DIGITS = [
  'ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า',
];
// Place words for positions 10^5 … 10^1 inside a six-digit ล้าน group.
const THAI_PLACES: [number, string][] = [
  [100000, 'แสน'], [10000, 'หมื่น'], [1000, 'พัน'], [100, 'ร้อย'], [10, 'สิบ'],
];

/**
 * Read one six-digit group (0–999999). A units-place 1 reads เอ็ด when it
 * is not the leading digit of the whole number — i.e. when a higher digit
 * exists in this group or in a higher ล้าน group (hasHigherContext).
 */
function thaiGroupText(group: number, hasHigherContext: boolean): string {
  let out = '';
  let higherInGroup = false;
  for (const [place, word] of THAI_PLACES) {
    const d = Math.floor(group / place) % 10;
    if (d === 0) continue;
    higherInGroup = true;
    if (place === 10) {
      if (d === 1) out += 'สิบ';
      else if (d === 2) out += 'ยี่สิบ';
      else out += THAI_DIGITS[d]! + 'สิบ';
    } else {
      out += THAI_DIGITS[d]! + word;
    }
  }
  const units = group % 10;
  if (units !== 0) {
    if (units === 1 && (higherInGroup || hasHigherContext)) out += 'เอ็ด';
    else out += THAI_DIGITS[units]!;
  }
  return out;
}

/** Read a non-negative integer, ล้าน-grouped (each higher group ×10⁶). */
function thaiIntegerText(n: number): string {
  if (n === 0) return 'ศูนย์';
  const groups: number[] = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000000);
    rest = Math.floor(rest / 1000000);
  }
  let out = '';
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi]!;
    if (g === 0) continue;
    out += thaiGroupText(g, gi < groups.length - 1);
    out += 'ล้าน'.repeat(gi);
  }
  return out;
}

/** Read a satang amount (1–99) as a plain two-digit Thai number. */
function thaiSatangText(satang: number): string {
  const tens = Math.floor(satang / 10);
  const units = satang % 10;
  let out = '';
  if (tens === 1) out += 'สิบ';
  else if (tens === 2) out += 'ยี่สิบ';
  else if (tens > 2) out += THAI_DIGITS[tens]! + 'สิบ';
  if (units === 1) out += tens > 0 ? 'เอ็ด' : 'หนึ่ง';
  else if (units > 1) out += THAI_DIGITS[units]!;
  return out;
}

/** Full BAHTTEXT verbalization of a finite number. */
function bahttextOf(num: number): string {
  const negative = num < 0;
  // Round to two decimals (satang), half away from zero.
  const totalSatang = Math.round(Math.abs(num) * 100 + 1e-7);
  const baht = Math.floor(totalSatang / 100);
  const satang = totalSatang % 100;
  let out = negative ? 'ลบ' : '';
  if (baht === 0 && satang === 0) return out + 'ศูนย์บาทถ้วน';
  if (baht > 0) {
    out += thaiIntegerText(baht) + 'บาท';
    if (satang === 0) return out + 'ถ้วน';
  }
  if (satang > 0) out += thaiSatangText(satang) + 'สตางค์';
  return out;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class ExtendedPlugin7 extends FunctionPlugin {
  public static implementedFunctions = {
    CONVERT: { method: 'convert', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    INFO: { method: 'info', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    ASC: { method: 'asc', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    DBCS: { method: 'dbcs', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    JIS: { method: 'jis', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    BAHTTEXT: { method: 'bahttext', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    PHONETIC: { method: 'phonetic', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    LINEST: { method: 'linest', arraySizeMethod: 'linestArraySize', vectorizationForbidden: true, parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    LOGEST: { method: 'logest', arraySizeMethod: 'logestArraySize', vectorizationForbidden: true, parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    PERCENTOF: { method: 'percentof', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    COUPDAYS: { method: 'coupdays', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    PRICEDISC: { method: 'pricedisc', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    YIELDDISC: { method: 'yielddisc', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    ACCRINTM: { method: 'accrintm', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
  };

  public convert(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('CONVERT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [numArg, fromArg, toArg] = args;
        if (numArg instanceof CellError) return numArg;
        const num = Number(numArg === EmptyValue ? 0 : numArg);
        const from = String(fromArg === EmptyValue ? '' : fromArg).toLowerCase();
        const to = String(toArg === EmptyValue ? '' : toArg).toLowerCase();
        // Temperature
        if ((from === 'c' || from === 'cel') && (to === 'f' || to === 'fah')) return num * 9/5 + 32;
        if ((from === 'f' || from === 'fah') && (to === 'c' || to === 'cel')) return (num - 32) * 5/9;
        if ((from === 'c' || from === 'cel') && to === 'k') return num + 273.15;
        const fFactor = CONVERT_TABLE[from];
        const tFactor = CONVERT_TABLE[to];
        if (fFactor === undefined || tFactor === undefined) {
          return new CellError(ErrorType.NA, 'Unsupported units.');
        }
        return num * fFactor / tFactor;
      });
  }

  public info(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('INFO'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const type = String(arg === EmptyValue ? '' : arg).toLowerCase();
        switch (type) {
          case 'directory': return '/';
          case 'numfile': return 1;
          case 'origin': return '$A$1';
          case 'osversion': return 'Linux';
          case 'recalc': return 'Automatic';
          case 'release': return '1.0';
          case 'system': return 'Linux';
          default: return new CellError(ErrorType.VALUE, 'Unknown info type.');
        }
      });
  }

  public asc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ASC'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const s = String(arg === EmptyValue ? '' : arg);
        // Convert full-width to half-width (simplified)
        return s.replace(/[\uFF01-\uFF5E]/g, ch =>
          String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
      });
  }

  public dbcs(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('DBCS'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const s = String(arg === EmptyValue ? '' : arg);
        // Convert half-width to full-width (simplified)
        return s.replace(/[\u0021-\u007E]/g, ch =>
          String.fromCharCode(ch.charCodeAt(0) + 0xFEE0)).replace(/ /g, '\u3000');
      });
  }

  public jis(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    // JIS is alias for DBCS in modern Excel
    return this.dbcs(ast, state);
  }

  public bahttext(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('BAHTTEXT'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const num = Number(arg === EmptyValue ? 0 : arg);
        if (!Number.isFinite(num)) {
          return new CellError(ErrorType.VALUE, 'BAHTTEXT requires a number.');
        }
        return bahttextOf(num);
      });
  }

  public phonetic(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PHONETIC'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        // Without furigana data, return the text as-is
        return String(arg === EmptyValue ? '' : arg);
      });
  }

  public linestArraySize(ast: ProcedureAst, state: InterpreterState): ArraySize {
    return regressionArraySize((a) => this.arraySizeForAst(a, state), ast);
  }

  public logestArraySize(ast: ProcedureAst, state: InterpreterState): ArraySize {
    return regressionArraySize((a) => this.arraySizeForAst(a, state), ast);
  }

  public linest(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('LINEST'),
      (...args: InterpreterValue[]): InterpreterValue => linestLogest(args, false));
  }

  public logest(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('LOGEST'),
      (...args: InterpreterValue[]): InterpreterValue => linestLogest(args, true));
  }

  public percentof(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERCENTOF'),
      (...args: InterpreterValue[]): InterpreterValue => {
        // PERCENTOF(data_subset, data_all) = SUM(subset) / SUM(all),
        // over ranges, arrays and scalars alike (Microsoft).
        const sumOf = (v: InterpreterValue | undefined): number | CellError => {
          if (v === undefined) return 0;
          let total = 0;
          for (const item of flattenValues(v)) {
            if (item instanceof CellError) return item;
            if (typeof item === 'number') total += item;
            else if (typeof item === 'boolean') total += item ? 1 : 0;
            else if (typeof item === 'string' && item.trim() !== '' && Number.isFinite(Number(item))) {
              total += Number(item);
            }
            // Text and empty cells in ranges are ignored, as in SUM.
          }
          return total;
        };
        const subset = sumOf(args[0]);
        if (subset instanceof CellError) return subset;
        const all = sumOf(args[1]);
        if (all instanceof CellError) return all;
        if (all === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'Divide by zero.');
        return subset / all;
      });
  }

  public coupdays(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('COUPDAYS'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settleArg, matArg, freqArg, basisArg] = args;
        for (const a of [settleArg, matArg, freqArg, basisArg]) {
          if (a instanceof CellError) return a;
        }
        const s = numArg(settleArg);
        const m = numArg(matArg);
        const freq = Math.trunc(numArg(freqArg));
        const basis = parseBasis(basisArg);
        if (!Number.isFinite(s) || !Number.isFinite(m) || !Number.isFinite(freq)) {
          return new CellError(ErrorType.VALUE, 'Invalid number.');
        }
        if (basis === null) return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
        if (freq !== 1 && freq !== 2 && freq !== 4) {
          return new CellError(ErrorType.NUM, 'Frequency must be 1, 2 or 4.');
        }
        if (s >= m) return new CellError(ErrorType.NUM, 'Settlement must be before maturity.');
        return couponPeriodDays(s, m, freq, basis);
      });
  }

  public pricedisc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PRICEDISC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settleArg, matArg, discountArg, redArg, basisArg] = args;
        for (const a of args) if (a instanceof CellError) return a;
        const s = numArg(settleArg);
        const m = numArg(matArg);
        const d = numArg(discountArg);
        const red = numArg(redArg);
        const basis = parseBasis(basisArg);
        if (![s, m, d, red].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'Invalid number.');
        }
        if (basis === null) return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
        if (s >= m) return new CellError(ErrorType.NUM, 'Settlement must be before maturity.');
        if (d <= 0) return new CellError(ErrorType.NUM, 'Discount must be > 0.');
        if (red <= 0) return new CellError(ErrorType.NUM, 'Redemption must be > 0.');
        // PRICEDISC = redemption − discount × redemption × DIM/B (Microsoft).
        return red - d * red * yearFraction(s, m, basis);
      });
  }

  public yielddisc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('YIELDDISC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settleArg, matArg, prArg, redArg, basisArg] = args;
        for (const a of args) if (a instanceof CellError) return a;
        const s = numArg(settleArg);
        const m = numArg(matArg);
        const pr = numArg(prArg);
        const red = numArg(redArg);
        const basis = parseBasis(basisArg);
        if (![s, m, pr, red].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'Invalid number.');
        }
        if (basis === null) return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
        if (s >= m) return new CellError(ErrorType.NUM, 'Settlement must be before maturity.');
        if (pr <= 0) return new CellError(ErrorType.NUM, 'Price must be > 0.');
        if (red <= 0) return new CellError(ErrorType.NUM, 'Redemption must be > 0.');
        const frac = yearFraction(s, m, basis);
        if (frac === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'Invalid.');
        // YIELDDISC = ((redemption − pr) / pr) × (B / DIM) (Microsoft).
        return ((red - pr) / pr) / frac;
      });
  }

  public accrintm(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ACCRINTM'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [issueArg, matArg, rateArg, parArg, basisArg] = args;
        for (const a of args) if (a instanceof CellError) return a;
        const iss = numArg(issueArg);
        const m = numArg(matArg);
        const r = numArg(rateArg);
        // par is optional in Microsoft's syntax, defaulting to 1000.
        const par = parArg === undefined || parArg === EmptyValue ? 1000 : numArg(parArg);
        const basis = parseBasis(basisArg);
        if (![iss, m, r, par].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'Invalid number.');
        }
        if (basis === null) return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
        if (iss >= m) return new CellError(ErrorType.NUM, 'Issue must be before maturity.');
        if (r <= 0) return new CellError(ErrorType.NUM, 'Rate must be > 0.');
        if (par <= 0) return new CellError(ErrorType.NUM, 'Par must be > 0.');
        // ACCRINTM = par × rate × A/B, A/B per the day-count basis (Microsoft).
        return par * r * yearFraction(iss, m, basis);
      });
  }
}

export function registerExtendedFunctions7(): void {
  if (HyperFormula.getFunctionPlugin('CONVERT') !== undefined) return;
  const names = {
    CONVERT: 'CONVERT', INFO: 'INFO', ASC: 'ASC', DBCS: 'DBCS', JIS: 'JIS',
    BAHTTEXT: 'BAHTTEXT', PHONETIC: 'PHONETIC', LINEST: 'LINEST', LOGEST: 'LOGEST',
    PERCENTOF: 'PERCENTOF', COUPDAYS: 'COUPDAYS', PRICEDISC: 'PRICEDISC',
    YIELDDISC: 'YIELDDISC', ACCRINTM: 'ACCRINTM',
  };
  HyperFormula.registerFunctionPlugin(ExtendedPlugin7, { enGB: names, enUS: names });
}

registerExtendedFunctions7();
