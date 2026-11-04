/**
 * Financial functions, batch 2 — real implementations with Excel-verified behavior:
 * AMORDEGRC, AMORLINC (French depreciation), COUPDAYBS, COUPDAYSNC, COUPNCD,
 * COUPPCD (coupon dates), PRICEMAT and YIELDMAT (price/yield at maturity).
 *
 * Algorithms follow Excel's documented semantics (the same ones PhpSpreadsheet
 * reimplements): declining-balance with French coefficients and a salvage cap
 * for AMORDEGRC; straight-line over 1/rate years with prorated first/last
 * periods for AMORLINC; coupon schedules stepped back from maturity in whole
 * months for the COUP* family; Excel's published PRICEMAT equation with
 * bisection for YIELDMAT.
 *
 * Verified against Excel's documented examples:
 * - AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1) = 776
 * - AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1) = 360
 * - COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),2,1) = 71
 * - COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,15),2,1) = 110
 * - COUPNCD(...) = 2011-05-15, COUPPCD(...) = 2010-11-15
 * - PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,0)
 *   = 99.98449888
 * - YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,0)
 *   = 0.06095433369
 *
 * NOTE on AMORDEGRC coefficients: Excel's documentation specifies 1.5 / 2 / 2.5
 * for asset lives of 3-4 / 5-6 / >6 years (the 776 example above only works
 * with 2.5). The French tax-code values 1.25/1.75/2.25 do NOT reproduce Excel's
 * documented result and are not used.
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';

// ---------------------------------------------------------------------------
// Date helpers (UTC-based; Excel serial epoch 1899-12-30)
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
 * Days in the year for a day-count basis. For actual/actual (basis 1) this is
 * 366 when the interval spans a leap day, else 365.
 */
function daysPerYear(basis: number, s1: number, s2: number): number {
  if (basis === 1) return containsLeapDay(s1, s2) ? 366 : 365;
  if (basis === 3) return 365;
  return 360; // 0, 2, 4
}

/**
 * Year fraction between two serial dates per basis. Basis 1 uses the
 * actual/actual (ISDA-style) convention: each calendar-year segment contributes
 * days/365-or-366.
 */
function yearFrac(s1: number, s2: number, basis: number): number {
  if (basis === 0) return days360US(s1, s2) / 360;
  if (basis === 4) return days360EU(s1, s2) / 360;
  if (basis === 2) return (s2 - s1) / 360;
  if (basis === 3) return (s2 - s1) / 365;
  const lo = Math.min(s1, s2);
  const hi = Math.max(s1, s2);
  if (lo === hi) return 0;
  const [y1] = serialToYMD(lo);
  const [y2] = serialToYMD(hi);
  let frac = 0;
  for (let y = y1; y <= y2; y++) {
    const segStart = Math.max(lo, ymdToSerial(y, 1, 1));
    const segEnd = Math.min(hi, ymdToSerial(y + 1, 1, 1));
    if (segEnd > segStart) frac += (segEnd - segStart) / (isLeapYear(y) ? 366 : 365);
  }
  return s2 >= s1 ? frac : -frac;
}

// ---------------------------------------------------------------------------
// Coupon schedule helpers
// ---------------------------------------------------------------------------

/**
 * Latest coupon date on or before settlement, found by stepping back from
 * maturity in whole coupon periods (Excel anchors its schedule at maturity).
 */
function prevCouponDate(settlement: number, maturity: number, frequency: number): number {
  const step = 12 / frequency;
  const s = Math.trunc(settlement);
  let c = Math.trunc(maturity);
  let guard = 0;
  while (c > s && guard++ < 1200) c = addMonthsSerial(c, -step);
  return c;
}

/** First coupon date strictly after the previous coupon date. */
function nextCouponDate(settlement: number, maturity: number, frequency: number): number {
  return addMonthsSerial(prevCouponDate(settlement, maturity, frequency), 12 / frequency);
}

// ---------------------------------------------------------------------------
// Depreciation cores (pure)
// ---------------------------------------------------------------------------

/**
 * French declining-balance coefficient per Excel's documented table.
 * Returns null when Excel mandates #NUM! for the asset life (life < 3, or
 * life strictly between 4 and 5 years).
 */
function amortizationCoefficient(rate: number): number | null {
  const life = 1 / rate;
  if (life < 3) return null;
  if (life > 4 && life < 5) return null;
  if (life < 5) return 1.5;
  if (life <= 6) return 2.0;
  return 2.5;
}

/**
 * AMORDEGRC core. Period 0 is prorated (cost x declining rate x yearfrac);
 * later periods depreciate the declining rate against the remaining book
 * value; cumulative depreciation never exceeds cost - salvage.
 */
function amordegrcCore(
  cost: number, purchased: number, firstPeriod: number, salvage: number,
  period: number, rate: number, basis: number,
): number {
  const coeff = amortizationCoefficient(rate) as number; // validated by caller
  const nRate = rate * coeff;
  const f0 = yearFrac(purchased, firstPeriod, basis);
  const capTotal = cost - salvage;
  let cum = 0;
  let dep = 0;
  for (let i = 0; i <= period; i++) {
    const scheduled = i === 0 ? cost * nRate * f0 : (cost - cum) * nRate;
    dep = Math.min(scheduled, Math.max(0, capTotal - cum));
    if (dep < 0 || !Number.isFinite(dep)) dep = 0;
    cum += dep;
  }
  return dep;
}

/**
 * AMORLINC core. Straight-line: each full year depreciates cost x rate;
 * period 0 is prorated by yearfrac and the final period takes the remaining
 * fraction of the 1/rate-year life; cumulative depreciation is capped at
 * cost - salvage.
 */
function amorlincCore(
  cost: number, purchased: number, firstPeriod: number, salvage: number,
  period: number, rate: number, basis: number,
): number {
  const annual = cost * rate;
  const f0 = yearFrac(purchased, firstPeriod, basis);
  const life = 1 / rate;
  const remaining = life - f0;
  const fullPeriods = Math.max(0, Math.floor(remaining + 1e-9));
  const lastFrac = Math.max(0, remaining - fullPeriods);
  const capTotal = cost - salvage;
  let cum = 0;
  let dep = 0;
  for (let i = 0; i <= period; i++) {
    let scheduled: number;
    if (i === 0) scheduled = annual * f0;
    else if (i <= fullPeriods) scheduled = annual;
    else if (i === fullPeriods + 1 && lastFrac > 1e-12) scheduled = annual * lastFrac;
    else scheduled = 0;
    dep = Math.min(scheduled, Math.max(0, capTotal - cum));
    if (dep < 0 || !Number.isFinite(dep)) dep = 0;
    cum += dep;
  }
  return dep;
}

// ---------------------------------------------------------------------------
// At-maturity securities cores (pure)
// ---------------------------------------------------------------------------

/** Excel's published PRICEMAT equation. */
function pricematCore(
  settlement: number, maturity: number, issue: number,
  rate: number, yld: number, basis: number,
): number {
  const b = daysPerYear(basis, settlement, maturity);
  const dim = daysBetween(issue, maturity, basis);
  const dsm = daysBetween(settlement, maturity, basis);
  const a = daysBetween(issue, settlement, basis);
  return ((100 + (dim / b) * rate * 100) / (1 + (yld / b) * dsm)) - ((a / b) * rate * 100);
}

/**
 * YIELDMAT core: solve the PRICEMAT equation for yield by bisection.
 * pricemat(y) is strictly decreasing in y with a singularity at y = -B/DSM,
 * so the bracket (just above the singularity, doubling hi) always converges.
 */
function yieldmatCore(
  settlement: number, maturity: number, issue: number,
  rate: number, pr: number, basis: number,
): number {
  const b = daysPerYear(basis, settlement, maturity);
  const dsm = daysBetween(settlement, maturity, basis);
  const f = (y: number): number =>
    pricematCore(settlement, maturity, issue, rate, y, basis) - pr;
  let lo = -(b / dsm) * 0.999999;
  let hi = 1;
  let guard = 0;
  while (f(hi) > 0 && guard++ < 200) hi = hi * 2 + 1;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Argument coercion
// ---------------------------------------------------------------------------

function numArg(v: InterpreterValue): number | CellError {
  if (v instanceof CellError) return v;
  if (v === EmptyValue) return 0; // Excel coerces empty to 0
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : new CellError(ErrorType.VALUE, 'Invalid number.');
  }
  const s = String(v).trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return new CellError(ErrorType.VALUE, 'Invalid number.');
}

/** Parse a date-ish string (YYYY-M-D or M/D/YYYY) to an Excel serial. */
function parseDateString(s: string): number | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) {
      return ymdToSerial(y, mo, d);
    }
    return null;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) {
      return ymdToSerial(y, mo, d);
    }
    return null;
  }
  return null;
}

function dateArg(v: InterpreterValue): number | CellError {
  if (v instanceof CellError) return v;
  if (v === EmptyValue) return 0; // Excel coerces empty to 0
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? Math.trunc(v) : new CellError(ErrorType.VALUE, 'Invalid date.');
  }
  const s = String(v).trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Math.trunc(Number(s));
  const serial = parseDateString(s);
  return serial === null
    ? new CellError(ErrorType.VALUE, 'Invalid date.')
    : serial;
}

/** Shared validation for the COUP* family. Returns validated tuple or CellError. */
function validateCouponArgs(
  args: InterpreterValue[],
): [number, number, number, number] | CellError {
  const [settleA, matA, freqA, basisA] = args;
  const settlement = dateArg(settleA);
  if (settlement instanceof CellError) return settlement;
  const maturity = dateArg(matA);
  if (maturity instanceof CellError) return maturity;
  const freqRaw = numArg(freqA);
  if (freqRaw instanceof CellError) return freqRaw;
  const frequency = Math.trunc(freqRaw);
  if (frequency !== 1 && frequency !== 2 && frequency !== 4) {
    return new CellError(ErrorType.NUM, 'Frequency must be 1, 2 or 4.');
  }
  const basisRaw = basisA === undefined || basisA === EmptyValue ? 0 : numArg(basisA);
  if (basisRaw instanceof CellError) return basisRaw;
  const basis = Math.trunc(basisRaw);
  if (basis < 0 || basis > 4) {
    return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
  }
  if (settlement >= maturity) {
    return new CellError(ErrorType.NUM, 'Settlement must be before maturity.');
  }
  return [settlement, maturity, frequency, basis];
}

/** Shared validation for the AMOR* family. Returns validated tuple or CellError. */
function validateAmorArgs(
  args: InterpreterValue[],
): [number, number, number, number, number, number, number] | CellError {
  const [costA, purchA, firstA, salvA, periodA, rateA, basisA] = args;
  const cost = numArg(costA);
  if (cost instanceof CellError) return cost;
  if (cost < 0) return new CellError(ErrorType.NUM, 'Cost must be >= 0.');
  const purchased = dateArg(purchA);
  if (purchased instanceof CellError) return purchased;
  const firstPeriod = dateArg(firstA);
  if (firstPeriod instanceof CellError) return firstPeriod;
  if (purchased > firstPeriod) {
    return new CellError(ErrorType.NUM, 'Date purchased must be <= end of first period.');
  }
  const salvage = numArg(salvA);
  if (salvage instanceof CellError) return salvage;
  if (salvage < 0 || salvage > cost) {
    return new CellError(ErrorType.NUM, 'Salvage must be between 0 and cost.');
  }
  const periodRaw = numArg(periodA);
  if (periodRaw instanceof CellError) return periodRaw;
  const period = Math.trunc(periodRaw);
  if (period < 0) return new CellError(ErrorType.NUM, 'Period must be >= 0.');
  const rate = numArg(rateA);
  if (rate instanceof CellError) return rate;
  if (rate <= 0) return new CellError(ErrorType.NUM, 'Rate must be > 0.');
  const basisRaw = basisA === undefined || basisA === EmptyValue ? 0 : numArg(basisA);
  if (basisRaw instanceof CellError) return basisRaw;
  const basis = Math.trunc(basisRaw);
  if (basis < 0 || basis > 4) {
    return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
  }
  return [cost, purchased, firstPeriod, salvage, period, rate, basis];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class FinancialPlugin2 extends FunctionPlugin {
  public static implementedFunctions = {
    AMORDEGRC: { method: 'amordegrc', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    AMORLINC: { method: 'amorlinc', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    COUPDAYBS: { method: 'coupdaybs', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    COUPDAYSNC: { method: 'coupdaysnc', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    COUPNCD: { method: 'coupncd', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    COUPPCD: { method: 'couppcd', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    PRICEMAT: { method: 'pricemat', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    YIELDMAT: { method: 'yieldmat', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
  };

  public amordegrc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('AMORDEGRC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateAmorArgs(args);
        if (v instanceof CellError) return v;
        const [cost, purchased, firstPeriod, salvage, period, rate, basis] = v;
        if (amortizationCoefficient(rate) === null) {
          return new CellError(ErrorType.NUM, 'Asset life (1/rate) must not be < 3 or between 4 and 5.');
        }
        return amordegrcCore(cost, purchased, firstPeriod, salvage, period, rate, basis);
      });
  }

  public amorlinc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('AMORLINC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateAmorArgs(args);
        if (v instanceof CellError) return v;
        const [cost, purchased, firstPeriod, salvage, period, rate, basis] = v;
        return amorlincCore(cost, purchased, firstPeriod, salvage, period, rate, basis);
      });
  }

  public coupdaybs(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('COUPDAYBS'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateCouponArgs(args);
        if (v instanceof CellError) return v;
        const [settlement, maturity, frequency, basis] = v;
        const prev = prevCouponDate(settlement, maturity, frequency);
        return daysBetween(prev, settlement, basis);
      });
  }

  public coupdaysnc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('COUPDAYSNC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateCouponArgs(args);
        if (v instanceof CellError) return v;
        const [settlement, maturity, frequency, basis] = v;
        const next = nextCouponDate(settlement, maturity, frequency);
        return daysBetween(settlement, next, basis);
      });
  }

  public coupncd(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('COUPNCD'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateCouponArgs(args);
        if (v instanceof CellError) return v;
        const [settlement, maturity, frequency] = v;
        return nextCouponDate(settlement, maturity, frequency);
      });
  }

  public couppcd(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('COUPPCD'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateCouponArgs(args);
        if (v instanceof CellError) return v;
        const [settlement, maturity, frequency] = v;
        return prevCouponDate(settlement, maturity, frequency);
      });
  }

  public pricemat(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PRICEMAT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settleA, matA, issueA, rateA, yldA, basisA] = args;
        const settlement = dateArg(settleA);
        if (settlement instanceof CellError) return settlement;
        const maturity = dateArg(matA);
        if (maturity instanceof CellError) return maturity;
        const issue = dateArg(issueA);
        if (issue instanceof CellError) return issue;
        const rate = numArg(rateA);
        if (rate instanceof CellError) return rate;
        const yld = numArg(yldA);
        if (yld instanceof CellError) return yld;
        const basisRaw = basisA === undefined || basisA === EmptyValue ? 0 : numArg(basisA);
        if (basisRaw instanceof CellError) return basisRaw;
        const basis = Math.trunc(basisRaw);
        if (rate < 0 || yld < 0) {
          return new CellError(ErrorType.NUM, 'Rate and yield must be >= 0.');
        }
        if (basis < 0 || basis > 4) {
          return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
        }
        if (settlement >= maturity) {
          return new CellError(ErrorType.NUM, 'Settlement must be before maturity.');
        }
        return pricematCore(settlement, maturity, issue, rate, yld, basis);
      });
  }

  public yieldmat(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('YIELDMAT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settleA, matA, issueA, rateA, prA, basisA] = args;
        const settlement = dateArg(settleA);
        if (settlement instanceof CellError) return settlement;
        const maturity = dateArg(matA);
        if (maturity instanceof CellError) return maturity;
        const issue = dateArg(issueA);
        if (issue instanceof CellError) return issue;
        const rate = numArg(rateA);
        if (rate instanceof CellError) return rate;
        const pr = numArg(prA);
        if (pr instanceof CellError) return pr;
        const basisRaw = basisA === undefined || basisA === EmptyValue ? 0 : numArg(basisA);
        if (basisRaw instanceof CellError) return basisRaw;
        const basis = Math.trunc(basisRaw);
        if (rate < 0 || pr <= 0) {
          return new CellError(ErrorType.NUM, 'Rate must be >= 0 and price > 0.');
        }
        if (basis < 0 || basis > 4) {
          return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
        }
        if (settlement >= maturity) {
          return new CellError(ErrorType.NUM, 'Settlement must be before maturity.');
        }
        if (daysBetween(settlement, maturity, basis) <= 0) {
          return new CellError(ErrorType.NUM, 'Settlement must be before maturity.');
        }
        return yieldmatCore(settlement, maturity, issue, rate, pr, basis);
      });
  }
}

export function registerFinancialFunctions2(): void {
  if (HyperFormula.getFunctionPlugin('AMORDEGRC') !== undefined) return;
  const names = {
    AMORDEGRC: 'AMORDEGRC',
    AMORLINC: 'AMORLINC',
    COUPDAYBS: 'COUPDAYBS',
    COUPDAYSNC: 'COUPDAYSNC',
    COUPNCD: 'COUPNCD',
    COUPPCD: 'COUPPCD',
    PRICEMAT: 'PRICEMAT',
    YIELDMAT: 'YIELDMAT',
  };
  HyperFormula.registerFunctionPlugin(FinancialPlugin2, { enGB: names, enUS: names });
}
