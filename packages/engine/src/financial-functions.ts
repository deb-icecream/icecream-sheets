/**
 * Extended Excel-compatibility functions, batch 6.
 * Financial bond/securities functions: PRICE, YIELD, DURATION, MDURATION,
 * ACCRINT, DISC, INTRATE, RECEIVED, COUPNUM, VDB.
 *
 * Day-count conventions follow the house helpers in
 * financial-functions2.ts / financial-functions3.ts (UTC-based serial
 * math, US NASD 30/360 for basis 0, European 30/360 for basis 4,
 * actual day counts for bases 1/2/3; days-per-year B is 360 for bases
 * 0/2/4, 365 for basis 3, and 365/366 for basis 1 depending on whether
 * the interval spans a Feb 29).
 *
 * Bond math follows Microsoft's documented formulas:
 * - PRICE / DURATION / MDURATION / YIELD are built on the coupon
 *   schedule anchored at maturity: N = coupons in (settlement,
 *   maturity], E = days in the coupon period containing settlement,
 *   A = days from that period's start to settlement, DSC = days from
 *   settlement to the next coupon. PRICE discounts each cash flow at
 *   (1 + yld/frequency)^((k-1) + DSC/E) and subtracts accrued interest
 *   C x A/E (C = 100 x rate/frequency); for N = 1 Microsoft's
 *   simple-interest form (redemption + C) / (1 + (yld/frequency) x
 *   (E-A)/E) - C x A/E is used instead. DURATION is the Macaulay
 *   duration (PV-weighted average time, in years, over the same
 *   schedule); MDURATION = DURATION / (1 + yld/frequency). YIELD
 *   inverts PRICE (closed form for N = 1, bisection otherwise).
 * - ACCRINT = par x rate/frequency x SUM(Ai/NLi) over quasi-coupon
 *   periods (the odd first period [issue, first_interest) is split by
 *   stepping back in whole coupon periods from first_interest, then
 *   regular periods continue forward from first_interest). Ai is the
 *   accrued-day count of a period up to settlement (per-basis day
 *   count); NLi is the period's normal length as in COUPDAYS (the
 *   period's own day count for bases 0/1/4, 360/frequency for basis 2,
 *   365/frequency for basis 3). calc_method TRUE (default) accrues from
 *   issue; FALSE accrues from first_interest, which only differs when
 *   settlement is later than first_interest.
 * - DISC / INTRATE / RECEIVED use Microsoft's documented DIM/B
 *   formulas with DIM = daysBetween(settlement, maturity, basis) and
 *   B = daysPerYear(basis, settlement, maturity).
 * - VDB is Excel's variable declining balance: each whole period
 *   depreciates max(declining balance book x factor/life, straight
 *   line (book - salvage)/remaining life) unless no_switch is set, in
 *   which case the declining-balance amount is always used; a period's
 *   depreciation never takes the book value below salvage, and
 *   fractional start/end periods prorate the whole-period amounts by
 *   overlap.
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

// ---------------------------------------------------------------------------
// Date helpers (UTC-based; Excel serial epoch 1899-12-30) — same
// conventions as financial-functions2.ts / financial-functions3.ts.
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

// ---------------------------------------------------------------------------
// Coupon schedule (anchored at maturity, like financial-functions2.ts)
// ---------------------------------------------------------------------------

interface CouponSchedule {
  /** Number of coupon dates in (settlement, maturity]. */
  n: number;
  /** Days in the coupon period in which settlement falls (COUPDAYS). */
  e: number;
  /** Days from the start of that period to settlement (COUPDAYBS). */
  a: number;
  /** Days from settlement to the next coupon date (COUPDAYSNC). */
  dsc: number;
}

function couponSchedule(
  settle: number, mat: number, freq: number, basis: number,
): CouponSchedule {
  const step = 12 / freq;
  let next = mat;
  let prev = mat;
  let n = 0;
  for (let k = 0; k <= 10000; k++) {
    const d = addMonthsSerial(mat, -k * step);
    if (d > settle) {
      next = d;
      n++;
    } else {
      prev = d;
      break;
    }
  }
  return {
    n,
    e: normalPeriodLength(prev, next, freq, basis),
    a: daysBetween(prev, settle, basis),
    dsc: daysBetween(settle, next, basis),
  };
}

/**
 * Normal length in days of a coupon / quasi-coupon period — the E of
 * PRICE/DURATION and the NLi of ACCRINT, i.e. Excel's COUPDAYS value
 * for the period. For bases 0 and 4 it is the period's own 30/360 day
 * count, and for basis 1 its actual day count; for basis 2 it is
 * 360/frequency and for basis 3 it is 365/frequency (documented
 * COUPDAYS example: a 181-actual-day semiannual period returns 182.5
 * under basis 3), while accrued-day counts (A, DSC, Ai) always use the
 * per-basis day count of the actual dates.
 */
function normalPeriodLength(
  start: number, end: number, freq: number, basis: number,
): number {
  if (basis === 2) return 360 / freq;
  if (basis === 3) return 365 / freq;
  return daysBetween(start, end, basis);
}

/** Number of coupon periods between settlement and maturity. */
function coupNum(settle: number, mat: number, freq: number): number {
  return couponSchedule(settle, mat, freq, 0).n;
}

// ---------------------------------------------------------------------------
// Bond cores (pure)
// ---------------------------------------------------------------------------

/** PRICE core: Microsoft's documented formula over the coupon schedule. */
function bondPriceCore(
  settle: number, mat: number, rate: number, yld: number,
  redemption: number, freq: number, basis: number,
): number {
  const { n, e, a, dsc } = couponSchedule(settle, mat, freq, basis);
  const coupon = (100 * rate) / freq;
  const accrued = coupon * (a / e);
  if (n === 1) {
    // One coupon period or less: simple interest, DSR = E - A.
    return (redemption + coupon) / (1 + (yld / freq) * ((e - a) / e)) - accrued;
  }
  const w = dsc / e;
  let dirty = 0;
  for (let k = 1; k <= n; k++) {
    dirty += coupon / Math.pow(1 + yld / freq, k - 1 + w);
  }
  dirty += redemption / Math.pow(1 + yld / freq, n - 1 + w);
  return dirty - accrued;
}

/** DURATION core: Macaulay duration in years over the coupon schedule. */
function durationCore(
  settle: number, mat: number, couponRate: number, yld: number,
  freq: number, basis: number,
): number {
  const { n, e, dsc } = couponSchedule(settle, mat, freq, basis);
  const w = dsc / e;
  if (n === 1) {
    // A single cash flow at maturity: duration is its time, in years.
    return w / freq;
  }
  const coupon = (100 * couponRate) / freq;
  let num = 0;
  let den = 0;
  for (let k = 1; k <= n; k++) {
    const pv = coupon / Math.pow(1 + yld / freq, k - 1 + w);
    num += ((k - 1 + w) / freq) * pv;
    den += pv;
  }
  const pvRed = 100 / Math.pow(1 + yld / freq, n - 1 + w);
  num += ((n - 1 + w) / freq) * pvRed;
  den += pvRed;
  return num / den;
}

/** YIELD core: invert PRICE (closed form for N = 1, bisection otherwise). */
function yieldCore(
  settle: number, mat: number, rate: number, pr: number,
  redemption: number, freq: number, basis: number,
): number {
  const { n, e, a, dsc } = couponSchedule(settle, mat, freq, basis);
  const coupon = (100 * rate) / freq;
  if (n === 1) {
    // Microsoft's documented one-period YIELD formula.
    const accrued = coupon * (a / e);
    return ((redemption + coupon) / (pr + accrued) - 1) * freq * (e / dsc);
  }
  const f = (y: number): number =>
    bondPriceCore(settle, mat, rate, y, redemption, freq, basis) - pr;
  // price(y) is strictly decreasing with a singularity at y = -frequency.
  let lo = -freq * 0.999999;
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

/**
 * ACCRINT core: par x rate/frequency x SUM(Ai/NLi) over quasi-coupon
 * periods. The odd first period is split by stepping back in whole
 * coupon periods from first_interest (anchored at first_interest);
 * regular periods then step forward from first_interest. Accrual runs
 * from issue, or from first_interest when calc_method is FALSE and
 * settlement is later than first_interest.
 */
function accrintCore(
  issue: number, first: number, settle: number, rate: number, par: number,
  freq: number, basis: number, calcMethod: boolean,
): number {
  const accrualStart = !calcMethod && settle > first ? first : issue;
  const step = 12 / freq;
  const intervals: Array<{ start: number; end: number }> = [];
  for (let k = 1; k <= 1200; k++) {
    const start = addMonthsSerial(first, -k * step);
    intervals.unshift({ start, end: addMonthsSerial(first, -(k - 1) * step) });
    if (start <= accrualStart) break;
  }
  for (let k = 0; k < 1200; k++) {
    const start = addMonthsSerial(first, k * step);
    if (start >= settle) break;
    intervals.push({ start, end: addMonthsSerial(first, (k + 1) * step) });
  }
  let sum = 0;
  for (const { start, end } of intervals) {
    if (end <= accrualStart || start >= settle) continue;
    const nl = normalPeriodLength(start, end, freq, basis);
    if (nl === 0) continue;
    const ai = daysBetween(
      Math.max(start, accrualStart), Math.min(end, settle), basis);
    sum += ai / nl;
  }
  return (par * rate / freq) * sum;
}

/**
 * VDB core: variable declining balance with switch to straight line.
 * Each whole period p depreciates on the opening book value: declining
 * balance book x factor/life, or straight line (book - salvage) /
 * remaining life when that is larger (never when no_switch is set);
 * depreciation is capped so the book value never drops below salvage.
 * The amount returned for [startPeriod, endPeriod] prorates each whole
 * period's depreciation by its overlap with the requested interval.
 */
function vdbCore(
  cost: number, salvage: number, life: number,
  startPeriod: number, endPeriod: number, factor: number, noSwitch: boolean,
): number {
  let book = cost;
  let total = 0;
  const lastPeriod = Math.ceil(endPeriod);
  for (let p = 1; p <= lastPeriod; p++) {
    if (p - 1 >= life) break;
    const remainingLife = life - (p - 1);
    const declining = (book * factor) / life;
    const straight = (book - salvage) / remainingLife;
    let dep = noSwitch ? declining : Math.max(declining, straight);
    dep = Math.min(dep, book - salvage);
    if (dep < 0 || !Number.isFinite(dep)) dep = 0;
    const overlap = Math.max(
      0, Math.min(endPeriod, p) - Math.max(startPeriod, p - 1));
    total += dep * overlap;
    book -= dep;
    // Once the book value reaches salvage, every later period's
    // depreciation is capped to 0 by the (book - salvage) cap above.
  }
  return total;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class FinancialPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    PRICE: { method: 'price', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    YIELD: { method: 'yield', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    DURATION: { method: 'duration', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    MDURATION: { method: 'mduration', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    ACCRINT: { method: 'accrint', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    DISC: { method: 'disc', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    INTRATE: { method: 'intrate', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    RECEIVED: { method: 'received', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    COUPNUM: { method: 'coupnum', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    VDB: { method: 'vdb', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
  };

  private getArgs(args: InterpreterValue[]): (number | CellError)[] {
    return args.map(a => {
      if (a instanceof CellError) return a;
      const n = Number(a === EmptyValue ? NaN : a);
      return Number.isNaN(n) ? new CellError(ErrorType.VALUE, 'Invalid number.') : n;
    });
  }

  /** First CellError among the values, or null when all are numbers. */
  private firstError(vals: (number | CellError | undefined)[]): CellError | null {
    for (const v of vals) if (v instanceof CellError) return v;
    return null;
  }

  /** Optional basis argument: defaults to 0, truncated, range-checked by callers. */
  private basisOf(v: number | CellError | undefined): number {
    return v === undefined || v instanceof CellError ? 0 : Math.trunc(v as number);
  }

  private validFreqBasis(freq: number, basis: number): CellError | null {
    if (freq !== 1 && freq !== 2 && freq !== 4) {
      return new CellError(ErrorType.NUM, 'Frequency must be 1, 2 or 4.');
    }
    if (basis < 0 || basis > 4) {
      return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
    }
    return null;
  }

  public price(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PRICE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settle, mat, rate, yld, redemption, freq, basisA] = this.getArgs(args);
        const err = this.firstError([settle, mat, rate, yld, redemption, freq]);
        if (err) return err;
        const basis = this.basisOf(basisA);
        const s = settle as number, m = mat as number, r = rate as number;
        const y = yld as number, red = redemption as number, f = Math.trunc(freq as number);
        const fbErr = this.validFreqBasis(f, basis);
        if (fbErr) return fbErr;
        if (s >= m) return new CellError(ErrorType.NUM, 'Settle >= maturity.');
        if (r < 0 || y < 0) return new CellError(ErrorType.NUM, 'Rate and yield must be >= 0.');
        if (red <= 0) return new CellError(ErrorType.NUM, 'Redemption must be > 0.');
        const result = bondPriceCore(s, m, r, y, red, f, basis);
        return Number.isFinite(result)
          ? result
          : new CellError(ErrorType.NUM, 'PRICE did not converge to a finite price.');
      });
  }

  public yield(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('YIELD'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settle, mat, rate, pr, redemption, freq, basisA] = this.getArgs(args);
        const err = this.firstError([settle, mat, rate, pr, redemption, freq]);
        if (err) return err;
        const basis = this.basisOf(basisA);
        const s = settle as number, m = mat as number, r = rate as number;
        const p = pr as number, red = redemption as number, f = Math.trunc(freq as number);
        const fbErr = this.validFreqBasis(f, basis);
        if (fbErr) return fbErr;
        if (s >= m) return new CellError(ErrorType.NUM, 'Settle >= maturity.');
        if (r < 0) return new CellError(ErrorType.NUM, 'Rate must be >= 0.');
        if (p <= 0 || red <= 0) {
          return new CellError(ErrorType.NUM, 'Price and redemption must be > 0.');
        }
        const result = yieldCore(s, m, r, p, red, f, basis);
        return Number.isFinite(result)
          ? result
          : new CellError(ErrorType.NUM, 'YIELD did not converge.');
      });
  }

  public duration(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('DURATION'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settle, mat, coupon, yld, freq, basisA] = this.getArgs(args);
        const err = this.firstError([settle, mat, coupon, yld, freq]);
        if (err) return err;
        const basis = this.basisOf(basisA);
        const s = settle as number, m = mat as number, c = coupon as number;
        const y = yld as number, f = Math.trunc(freq as number);
        const fbErr = this.validFreqBasis(f, basis);
        if (fbErr) return fbErr;
        if (s >= m) return new CellError(ErrorType.NUM, 'Settle >= maturity.');
        if (c < 0 || y < 0) return new CellError(ErrorType.NUM, 'Coupon and yield must be >= 0.');
        const result = durationCore(s, m, c, y, f, basis);
        return Number.isFinite(result)
          ? result
          : new CellError(ErrorType.NUM, 'DURATION is undefined for these arguments.');
      });
  }

  public mduration(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('MDURATION'),
      (...args: InterpreterValue[]): InterpreterValue => {
        // MDURATION = DURATION / (1 + yld/frequency), over the same schedule.
        const [settle, mat, coupon, yld, freq, basisA] = this.getArgs(args);
        const err = this.firstError([settle, mat, coupon, yld, freq]);
        if (err) return err;
        const basis = this.basisOf(basisA);
        const s = settle as number, m = mat as number, c = coupon as number;
        const y = yld as number, f = Math.trunc(freq as number);
        const fbErr = this.validFreqBasis(f, basis);
        if (fbErr) return fbErr;
        if (s >= m) return new CellError(ErrorType.NUM, 'Settle >= maturity.');
        if (c < 0 || y < 0) return new CellError(ErrorType.NUM, 'Coupon and yield must be >= 0.');
        const result = durationCore(s, m, c, y, f, basis) / (1 + y / f);
        return Number.isFinite(result)
          ? result
          : new CellError(ErrorType.NUM, 'MDURATION is undefined for these arguments.');
      });
  }

  public accrint(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ACCRINT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [issue, first, settle, rate, par, freq, basisA, calcA] = this.getArgs(args);
        const err = this.firstError([issue, first, settle, rate, par, freq]);
        if (err) return err;
        const basis = this.basisOf(basisA);
        const iss = issue as number, fst = first as number, s = settle as number;
        const r = rate as number, p = par as number, f = Math.trunc(freq as number);
        const fbErr = this.validFreqBasis(f, basis);
        if (fbErr) return fbErr;
        if (iss >= s) return new CellError(ErrorType.NUM, 'Issue must be before settlement.');
        if (r <= 0) return new CellError(ErrorType.NUM, 'Rate must be > 0.');
        if (p <= 0) return new CellError(ErrorType.NUM, 'Par must be > 0.');
        // calc_method: TRUE (default) accrues from issue; FALSE accrues
        // from first_interest when settlement is past first_interest.
        const calcMethod = calcA === undefined || calcA instanceof CellError
          ? true
          : (calcA as number) !== 0;
        const result = accrintCore(iss, fst, s, r, p, f, basis, calcMethod);
        return Number.isFinite(result)
          ? result
          : new CellError(ErrorType.NUM, 'ACCRINT is undefined for these arguments.');
      });
  }

  public disc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('DISC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settle, mat, pr, redemption, basisA] = this.getArgs(args);
        if (settle instanceof CellError) return settle;
        const basis = basisA === undefined || basisA instanceof CellError ? 0 : basisA as number;
        const s = settle as number, m = mat as number;
        const price = pr as number, red = redemption as number;
        const days = daysBetween(s, m, basis);
        const dpy = daysPerYear(basis, s, m);
        if (days === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'Invalid.');
        return ((red - price) / red) * (dpy / days);
      });
  }

  public intrate(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('INTRATE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settle, mat, invest, redemption, basisA] = this.getArgs(args);
        if (settle instanceof CellError) return settle;
        const basis = basisA === undefined || basisA instanceof CellError ? 0 : basisA as number;
        const s = settle as number, m = mat as number;
        const inv = invest as number, red = redemption as number;
        const days = daysBetween(s, m, basis);
        const dpy = daysPerYear(basis, s, m);
        if (inv === 0 || days === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'Invalid.');
        return ((red - inv) / inv) * (dpy / days);
      });
  }

  public received(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('RECEIVED'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settle, mat, invest, discount, basisA] = this.getArgs(args);
        if (settle instanceof CellError) return settle;
        const basis = basisA === undefined || basisA instanceof CellError ? 0 : basisA as number;
        const s = settle as number, m = mat as number;
        const inv = invest as number, d = discount as number;
        const days = daysBetween(s, m, basis);
        const dpy = daysPerYear(basis, s, m);
        return inv / (1 - d * (days / dpy));
      });
  }

  public coupnum(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('COUPNUM'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [settle, mat, freq] = this.getArgs(args);
        const err = this.firstError([settle, mat, freq]);
        if (err) return err;
        const s = settle as number, m = mat as number, f = Math.trunc(freq as number);
        if (f !== 1 && f !== 2 && f !== 4) {
          return new CellError(ErrorType.NUM, 'Frequency must be 1, 2 or 4.');
        }
        if (s >= m) return new CellError(ErrorType.NUM, 'Settle >= maturity.');
        return coupNum(s, m, f);
      });
  }

  public vdb(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('VDB'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [cost, salvage, life, start, end, factorA, noSwitchA] = this.getArgs(args);
        const err = this.firstError([cost, salvage, life, start, end]);
        if (err) return err;
        const c = cost as number, sal = salvage as number, l = life as number;
        const s = start as number, e = end as number;
        const factor = factorA === undefined || factorA instanceof CellError ? 2 : factorA as number;
        const noSwitch = noSwitchA === undefined || noSwitchA instanceof CellError
          ? false
          : (noSwitchA as number) !== 0;
        if (c < 0 || sal < 0 || sal > c) {
          return new CellError(ErrorType.NUM, 'Salvage must be between 0 and cost.');
        }
        if (l <= 0 || s < 0 || e < 0 || factor <= 0) {
          return new CellError(ErrorType.NUM, 'Life, periods and factor must be positive.');
        }
        return vdbCore(c, sal, l, s, e, factor, noSwitch);
      });
  }
}

export function registerFinancialFunctions(): void {
  if (HyperFormula.getFunctionPlugin('PRICE') !== undefined) return;
  const names = {
    PRICE: 'PRICE', YIELD: 'YIELD', DURATION: 'DURATION', MDURATION: 'MDURATION',
    ACCRINT: 'ACCRINT', DISC: 'DISC', INTRATE: 'INTRATE', RECEIVED: 'RECEIVED',
    COUPNUM: 'COUPNUM', VDB: 'VDB',
  };
  HyperFormula.registerFunctionPlugin(FinancialPlugin, { enGB: names, enUS: names });
}

registerFinancialFunctions();
