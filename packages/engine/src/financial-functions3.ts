/**
 * Financial functions, batch 3 — odd-period bond functions with real
 * implementations following Microsoft's documented quasi-coupon algorithms
 * (OOXML ISO/IEC 29500-1 §18.17.7.241–244 and the Microsoft Support pages
 * for ODDFPRICE / ODDFYIELD / ODDLPRICE / ODDLYIELD):
 *
 * - ODDFPRICE / ODDFYIELD (odd first coupon): the odd first period
 *   [issue, first_coupon) is split into quasi-coupon periods by stepping
 *   back in whole coupon periods from first_coupon (anchored at
 *   first_coupon, so month-end dates do not drift). For the ith quasi
 *   period, DCi is the number of days counted in it (from issue for
 *   i = 1, the full period otherwise) and NLi its normal length, both per
 *   the day-count basis. The first coupon pays
 *   (100 x rate / frequency) x SUM(DCi / NLi); accrued interest is
 *   (100 x rate / frequency) x SUM(Ai / NLi), where Ai is the accrued-day
 *   count of the ith quasi period up to settlement. Cash flows are
 *   discounted at (1 + yld/frequency)^t, where t is measured in coupon
 *   periods from settlement as SUM(segment days / segment normal length)
 *   over the period segments between settlement and the cash-flow date
 *   (this is exactly Microsoft's Nq + DSC/E exponent, segment by
 *   segment). ODDFYIELD inverts ODDFPRICE by bisection (price is strictly
 *   decreasing in yield; Microsoft documents a Newton iteration — the
 *   root is the same).
 * - ODDLPRICE / ODDLYIELD (odd last coupon): the odd last period
 *   [last_interest, maturity) is split into quasi-coupon periods stepping
 *   forward from last_interest. Microsoft's published equation is
 *     price = (redemption + C x SUM(DCi/NLi))
 *             / (1 + (yld/frequency) x SUM(DSCi/NLi))
 *             - C x SUM(Ai/NLi)
 *   where C = 100 x rate / frequency, DCi is the day count of the ith
 *   quasi period clipped at maturity, DSCi the day count of the part of
 *   the ith quasi period at or after settlement (clipped at maturity),
 *   and Ai the accrued days of the ith quasi period up to settlement.
 *   ODDLYIELD is the closed-form inversion of that equation (the form
 *   Microsoft publishes for ODDLYIELD).
 *
 * Verified against Microsoft's documented examples:
 * - ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),
 *     DATE(2009,3,1),0.0785,0.0625,100,2,1) = 113.5977
 *     (full precision 113.59771747)
 * - ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),
 *     DATE(2009,3,1),0.0575,84.50,100,2,0) = 0.0772455415972989
 * - ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),
 *     0.0375,0.0405,100,2,0) = 99.8782860147213
 * - ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),
 *     0.0375,99.875,100,2,0) = 0.04519 (full precision 0.04519223563)
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
// Date helpers (UTC-based; Excel serial epoch 1899-12-30) — same
// conventions as financial-functions2.ts.
// ---------------------------------------------------------------------------

type YMD = [number, number, number];

function serialToYMD(serial: number): YMD {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

function ymdToSerial(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / 86400000 + 25569);
}

function isLastDayOfFeb(y: number, m: number, d: number): boolean {
  return m === 2 && d === daysInMonth(y, m);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
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

// ---------------------------------------------------------------------------
// Quasi-coupon schedule helpers
// ---------------------------------------------------------------------------

interface DateInterval {
  start: number;
  end: number;
}

/**
 * Quasi-coupon periods that make up the odd first period
 * [issue, firstCoupon): whole coupon periods stepped back from
 * firstCoupon, each anchored at firstCoupon (addMonthsSerial from the
 * anchor, never chained, so a 31st anchor does not drift to the 30th).
 * The earliest period starts on or before issue.
 */
function oddFirstIntervals(issue: number, firstCoupon: number, frequency: number): DateInterval[] {
  const step = 12 / frequency;
  const intervals: DateInterval[] = [];
  for (let k = 1; k <= 1200; k++) {
    const start = addMonthsSerial(firstCoupon, -k * step);
    intervals.unshift({ start, end: addMonthsSerial(firstCoupon, -(k - 1) * step) });
    if (start <= issue) break;
  }
  return intervals;
}

/**
 * Quasi-coupon periods that make up the odd last period
 * [lastInterest, maturity): whole coupon periods stepped forward from
 * lastInterest, each anchored at lastInterest. The last period ends on
 * or after maturity.
 */
function oddLastIntervals(lastInterest: number, maturity: number, frequency: number): DateInterval[] {
  const step = 12 / frequency;
  const intervals: DateInterval[] = [];
  for (let k = 0; k < 1200; k++) {
    const start = addMonthsSerial(lastInterest, k * step);
    const end = addMonthsSerial(lastInterest, (k + 1) * step);
    intervals.push({ start, end });
    if (end >= maturity) break;
  }
  return intervals;
}

/**
 * Time from settlement to target measured in coupon periods, the
 * segment-wise way Microsoft defines it: each period segment between
 * settlement and target contributes (segment days per basis) / (normal
 * length of the period containing the segment's end). When target is a
 * period boundary this equals Nq + DSC/E with Nq the whole periods
 * between the next boundary and target and E the normal length of the
 * period in which settlement falls.
 *
 * `boundaries` must be sorted ascending, start on or before settlement,
 * and end on or after target.
 */
function periodTau(
  settlement: number, target: number, boundaries: number[], frequency: number, basis: number,
): number {
  const step = 12 / frequency;
  const intervalLength = (endIdx: number): number => {
    const end = boundaries[endIdx];
    const start = endIdx > 0 ? boundaries[endIdx - 1] : addMonthsSerial(end, -step);
    return daysBetween(start, end, basis);
  };
  let tau = 0;
  let prev = settlement;
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    if (b <= settlement || b >= target) continue;
    tau += daysBetween(prev, b, basis) / intervalLength(i);
    prev = b;
  }
  // Final segment: prev -> target, in the period ending at the first
  // boundary on or after target.
  let endIdx = boundaries.findIndex((b) => b >= target);
  if (endIdx === -1) endIdx = boundaries.length - 1;
  tau += daysBetween(prev, target, basis) / intervalLength(endIdx);
  return tau;
}

// ---------------------------------------------------------------------------
// Odd-first cores (pure)
// ---------------------------------------------------------------------------

interface OddFirstTerms {
  /** First coupon amount per $100 face: C x SUM(DCi/NLi). */
  firstCoupon: number;
  /** Accrued interest per $100 face: C x SUM(Ai/NLi). */
  accrued: number;
  /** Sorted period boundaries from the first quasi start to maturity. */
  boundaries: number[];
}

function oddFirstTerms(
  settlement: number, maturity: number, issue: number, firstCoupon: number,
  rate: number, frequency: number, basis: number,
): OddFirstTerms {
  const coupon = (100 * rate) / frequency;
  const intervals = oddFirstIntervals(issue, firstCoupon, frequency);
  let dcSum = 0;
  let aiSum = 0;
  for (const { start, end } of intervals) {
    const nl = daysBetween(start, end, basis);
    const effectiveStart = Math.max(start, issue);
    const dc = daysBetween(effectiveStart, end, basis);
    dcSum += dc / nl;
    let ai = 0;
    if (settlement > effectiveStart) {
      ai = settlement >= end ? dc : daysBetween(effectiveStart, settlement, basis);
    }
    aiSum += ai / nl;
  }
  const boundaries: number[] = [];
  for (const { start } of intervals) boundaries.push(start);
  boundaries.push(firstCoupon);
  const step = 12 / frequency;
  for (let k = 1; k <= 1200; k++) {
    const d = addMonthsSerial(firstCoupon, k * step);
    boundaries.push(d);
    if (d >= maturity) break;
  }
  return { firstCoupon: coupon * dcSum, accrued: coupon * aiSum, boundaries };
}

/** ODDFPRICE core: discounted cash flows minus accrued interest. */
function oddFPriceCore(
  settlement: number, maturity: number, issue: number, firstCoupon: number,
  rate: number, yld: number, redemption: number, frequency: number, basis: number,
): number {
  const coupon = (100 * rate) / frequency;
  const terms = oddFirstTerms(settlement, maturity, issue, firstCoupon, rate, frequency, basis);
  const discount = (date: number): number =>
    Math.pow(1 + yld / frequency, periodTau(settlement, date, terms.boundaries, frequency, basis));
  let dirty = terms.firstCoupon / discount(firstCoupon);
  const step = 12 / frequency;
  let lastRegular = firstCoupon;
  for (let k = 1; k <= 1200; k++) {
    const d = addMonthsSerial(firstCoupon, k * step);
    lastRegular = d;
    if (d >= maturity) break;
    dirty += coupon / discount(d);
  }
  if (lastRegular === maturity) {
    dirty += (coupon + redemption) / discount(maturity);
  } else {
    // Maturity is not a regular coupon date: coupons strictly before it
    // were added above (the loop's final date is past maturity and was
    // not added); redemption is paid at maturity with no coupon.
    dirty += redemption / discount(maturity);
  }
  return dirty - terms.accrued;
}

/** ODDFYIELD core: invert ODDFPRICE by bisection. */
function oddFYieldCore(
  settlement: number, maturity: number, issue: number, firstCoupon: number,
  rate: number, pr: number, redemption: number, frequency: number, basis: number,
): number {
  const f = (y: number): number =>
    oddFPriceCore(settlement, maturity, issue, firstCoupon, rate, y, redemption, frequency, basis) - pr;
  // price(y) is strictly decreasing with a singularity at y = -frequency.
  let lo = -frequency * 0.999999;
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
// Odd-last cores (pure)
// ---------------------------------------------------------------------------

interface OddLastTerms {
  /** Final coupon amount per $100 face: C x SUM(DCi/NLi). */
  finalCoupon: number;
  /** Accrued interest per $100 face: C x SUM(Ai/NLi). */
  accrued: number;
  /** SUM(DSCi/NLi): settlement-to-maturity time in coupon periods. */
  tau: number;
}

function oddLastTerms(
  settlement: number, maturity: number, lastInterest: number,
  rate: number, frequency: number, basis: number,
): OddLastTerms {
  const coupon = (100 * rate) / frequency;
  const intervals = oddLastIntervals(lastInterest, maturity, frequency);
  let dcSum = 0;
  let aiSum = 0;
  let dscSum = 0;
  for (const { start, end } of intervals) {
    const nl = daysBetween(start, end, basis);
    const clippedEnd = Math.min(end, maturity);
    const dc = daysBetween(start, clippedEnd, basis);
    dcSum += dc / nl;
    let ai = 0;
    if (settlement > start) {
      ai = settlement >= clippedEnd ? dc : daysBetween(start, settlement, basis);
    }
    aiSum += ai / nl;
    let dsc = 0;
    if (settlement < clippedEnd) {
      dsc = settlement <= start ? dc : daysBetween(settlement, clippedEnd, basis);
    }
    dscSum += dsc / nl;
  }
  return { finalCoupon: coupon * dcSum, accrued: coupon * aiSum, tau: dscSum };
}

/** ODDLPRICE core: Microsoft's published odd-last-period equation. */
function oddLPriceCore(
  settlement: number, maturity: number, lastInterest: number,
  rate: number, yld: number, redemption: number, frequency: number, basis: number,
): number {
  const terms = oddLastTerms(settlement, maturity, lastInterest, rate, frequency, basis);
  return (redemption + terms.finalCoupon) / (1 + (yld / frequency) * terms.tau) - terms.accrued;
}

/** ODDLYIELD core: closed-form inversion of the ODDLPRICE equation. */
function oddLYieldCore(
  settlement: number, maturity: number, lastInterest: number,
  rate: number, pr: number, redemption: number, frequency: number, basis: number,
): number {
  const terms = oddLastTerms(settlement, maturity, lastInterest, rate, frequency, basis);
  return (((redemption + terms.finalCoupon) / (pr + terms.accrued)) - 1) / terms.tau * frequency;
}

// ---------------------------------------------------------------------------
// Argument coercion — same conventions as financial-functions2.ts
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

function validDate(serial: number): boolean {
  return serial >= 1;
}

function freqArg(v: InterpreterValue): number | CellError {
  const raw = numArg(v);
  if (raw instanceof CellError) return raw;
  const frequency = Math.trunc(raw);
  if (frequency !== 1 && frequency !== 2 && frequency !== 4) {
    return new CellError(ErrorType.NUM, 'Frequency must be 1, 2 or 4.');
  }
  return frequency;
}

function basisArg(v: InterpreterValue | undefined): number | CellError {
  const raw = v === undefined || v === EmptyValue ? 0 : numArg(v);
  if (raw instanceof CellError) return raw;
  const basis = Math.trunc(raw);
  if (basis < 0 || basis > 4) {
    return new CellError(ErrorType.NUM, 'Basis must be between 0 and 4.');
  }
  return basis;
}

/** Shared validation for ODDFPRICE / ODDFYIELD (rate + price-or-yield slot). */
function validateOddFirstArgs(
  args: InterpreterValue[], kind: 'price' | 'yield',
): [number, number, number, number, number, number, number, number, number] | CellError {
  const [settleA, matA, issueA, firstA, rateA, pyA, redA, freqA, basisA] = args;
  const settlement = dateArg(settleA);
  if (settlement instanceof CellError) return settlement;
  if (!validDate(settlement)) return new CellError(ErrorType.VALUE, 'Invalid settlement date.');
  const maturity = dateArg(matA);
  if (maturity instanceof CellError) return maturity;
  if (!validDate(maturity)) return new CellError(ErrorType.VALUE, 'Invalid maturity date.');
  const issue = dateArg(issueA);
  if (issue instanceof CellError) return issue;
  if (!validDate(issue)) return new CellError(ErrorType.VALUE, 'Invalid issue date.');
  const firstCoupon = dateArg(firstA);
  if (firstCoupon instanceof CellError) return firstCoupon;
  if (!validDate(firstCoupon)) return new CellError(ErrorType.VALUE, 'Invalid first coupon date.');
  const rate = numArg(rateA);
  if (rate instanceof CellError) return rate;
  const priceOrYield = numArg(pyA);
  if (priceOrYield instanceof CellError) return priceOrYield;
  const redemption = numArg(redA);
  if (redemption instanceof CellError) return redemption;
  const frequency = freqArg(freqA);
  if (frequency instanceof CellError) return frequency;
  const basis = basisArg(basisA);
  if (basis instanceof CellError) return basis;
  if (rate < 0) return new CellError(ErrorType.NUM, 'Rate must be >= 0.');
  if (kind === 'price' && priceOrYield < 0) {
    return new CellError(ErrorType.NUM, 'Yield must be >= 0.');
  }
  if (kind === 'yield' && priceOrYield <= 0) {
    return new CellError(ErrorType.NUM, 'Price must be > 0.');
  }
  if (redemption <= 0) return new CellError(ErrorType.NUM, 'Redemption must be > 0.');
  if (!(maturity > firstCoupon && firstCoupon > settlement && settlement > issue)) {
    return new CellError(
      ErrorType.NUM, 'Dates must satisfy maturity > first_coupon > settlement > issue.');
  }
  return [settlement, maturity, issue, firstCoupon, rate, priceOrYield, redemption, frequency, basis];
}

/** Shared validation for ODDLPRICE / ODDLYIELD (rate + price-or-yield slot). */
function validateOddLastArgs(
  args: InterpreterValue[], kind: 'price' | 'yield',
): [number, number, number, number, number, number, number, number] | CellError {
  const [settleA, matA, lastA, rateA, pyA, redA, freqA, basisA] = args;
  const settlement = dateArg(settleA);
  if (settlement instanceof CellError) return settlement;
  if (!validDate(settlement)) return new CellError(ErrorType.VALUE, 'Invalid settlement date.');
  const maturity = dateArg(matA);
  if (maturity instanceof CellError) return maturity;
  if (!validDate(maturity)) return new CellError(ErrorType.VALUE, 'Invalid maturity date.');
  const lastInterest = dateArg(lastA);
  if (lastInterest instanceof CellError) return lastInterest;
  if (!validDate(lastInterest)) return new CellError(ErrorType.VALUE, 'Invalid last interest date.');
  const rate = numArg(rateA);
  if (rate instanceof CellError) return rate;
  const priceOrYield = numArg(pyA);
  if (priceOrYield instanceof CellError) return priceOrYield;
  const redemption = numArg(redA);
  if (redemption instanceof CellError) return redemption;
  const frequency = freqArg(freqA);
  if (frequency instanceof CellError) return frequency;
  const basis = basisArg(basisA);
  if (basis instanceof CellError) return basis;
  if (rate < 0) return new CellError(ErrorType.NUM, 'Rate must be >= 0.');
  if (kind === 'price' && priceOrYield < 0) {
    return new CellError(ErrorType.NUM, 'Yield must be >= 0.');
  }
  if (kind === 'yield' && priceOrYield <= 0) {
    return new CellError(ErrorType.NUM, 'Price must be > 0.');
  }
  if (redemption <= 0) return new CellError(ErrorType.NUM, 'Redemption must be > 0.');
  if (!(maturity > settlement && settlement > lastInterest)) {
    return new CellError(
      ErrorType.NUM, 'Dates must satisfy maturity > settlement > last_interest.');
  }
  return [settlement, maturity, lastInterest, rate, priceOrYield, redemption, frequency, basis];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const nineScalars = [
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
];

const eightScalars = [
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR },
  { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
];

export class FinancialPlugin3 extends FunctionPlugin {
  public static implementedFunctions = {
    ODDFPRICE: { method: 'oddfprice', parameters: nineScalars },
    ODDFYIELD: { method: 'oddfyield', parameters: nineScalars },
    ODDLPRICE: { method: 'oddlprice', parameters: eightScalars },
    ODDLYIELD: { method: 'oddlyield', parameters: eightScalars },
  };

  public oddfprice(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ODDFPRICE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateOddFirstArgs(args, 'price');
        if (v instanceof CellError) return v;
        const [settlement, maturity, issue, firstCoupon, rate, yld, redemption, frequency, basis] = v;
        const result = oddFPriceCore(
          settlement, maturity, issue, firstCoupon, rate, yld, redemption, frequency, basis);
        return Number.isFinite(result)
          ? result
          : new CellError(ErrorType.NUM, 'ODDFPRICE did not converge to a finite price.');
      });
  }

  public oddfyield(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ODDFYIELD'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateOddFirstArgs(args, 'yield');
        if (v instanceof CellError) return v;
        const [settlement, maturity, issue, firstCoupon, rate, pr, redemption, frequency, basis] = v;
        const result = oddFYieldCore(
          settlement, maturity, issue, firstCoupon, rate, pr, redemption, frequency, basis);
        return Number.isFinite(result)
          ? result
          : new CellError(ErrorType.NUM, 'ODDFYIELD did not converge.');
      });
  }

  public oddlprice(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ODDLPRICE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateOddLastArgs(args, 'price');
        if (v instanceof CellError) return v;
        const [settlement, maturity, lastInterest, rate, yld, redemption, frequency, basis] = v;
        const result = oddLPriceCore(
          settlement, maturity, lastInterest, rate, yld, redemption, frequency, basis);
        return Number.isFinite(result)
          ? result
          : new CellError(ErrorType.NUM, 'ODDLPRICE did not converge to a finite price.');
      });
  }

  public oddlyield(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ODDLYIELD'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const v = validateOddLastArgs(args, 'yield');
        if (v instanceof CellError) return v;
        const [settlement, maturity, lastInterest, rate, pr, redemption, frequency, basis] = v;
        const terms = oddLastTerms(settlement, maturity, lastInterest, rate, frequency, basis);
        if (terms.tau <= 0 || pr + terms.accrued <= 0) {
          return new CellError(ErrorType.NUM, 'ODDLYIELD is undefined for these arguments.');
        }
        const result = oddLYieldCore(
          settlement, maturity, lastInterest, rate, pr, redemption, frequency, basis);
        return Number.isFinite(result)
          ? result
          : new CellError(ErrorType.NUM, 'ODDLYIELD did not converge.');
      });
  }
}

export function registerFinancialFunctions3(): void {
  if (HyperFormula.getFunctionPlugin('ODDFPRICE') !== undefined) return;
  const names = {
    ODDFPRICE: 'ODDFPRICE',
    ODDFYIELD: 'ODDFYIELD',
    ODDLPRICE: 'ODDLPRICE',
    ODDLYIELD: 'ODDLYIELD',
  };
  HyperFormula.registerFunctionPlugin(FinancialPlugin3, { enGB: names, enUS: names });
}
