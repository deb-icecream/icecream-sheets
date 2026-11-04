/**
 * Phase-2 function-coverage tests: living/modern STATISTICAL functions
 * that previously had no gold or unit coverage (see
 * hidden_files/function-coverage/TEST-COVERAGE-AUDIT.md).
 *
 * Expected values are computed independently in plain JS — sample
 * moments, least-squares fits, and distribution p-values via a
 * Numerical-Recipes regularized incomplete beta implemented below
 * (validated against Microsoft's documented BETADIST value
 * 0.685470581 and the T.TEST worked example 0.196016).
 *
 * Engine disagreements with documented behavior were recorded as FOUND
 * DEFECTS D11–D14 / D17 in the audit file; all were fixed in Phase 2
 * (2026-10-21) and promoted from it.fails to plain `it`.
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook, type TypedValue } from '../src/index.js';

function evalMap(formulas: string[]): (formula: string) => TypedValue {
  const wb = new EngineWorkbook({ S: formulas.map((f) => [f]) });
  const map = new Map(
    formulas.map((f, i) => [f, wb.getValue({ sheet: 'S', row: i, col: 0 })] as const),
  );
  return (f) => {
    const v = map.get(f);
    if (!v) throw new Error(`formula not in batch: ${f}`);
    return v;
  };
}
function num(v: TypedValue): number {
  if (v.kind !== 'number') throw new Error(`expected number, got ${JSON.stringify(v)}`);
  return v.value as number;
}
function errCode(v: TypedValue): string {
  if (v.kind !== 'error') throw new Error(`expected error, got ${JSON.stringify(v)}`);
  return v.code;
}

// ---- Independent distribution math (Numerical Recipes) -------------------
function lgamma(z: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0]!;
  for (let i = 1; i < 9; i++) x += c[i]! / (z + i);
  const t = z + 7.5;
  return 0.9189385332046727 + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let cc = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    cc = 1 + aa / cc;
    if (Math.abs(cc) < FPMIN) cc = FPMIN;
    d = 1 / d;
    h *= d * cc;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    cc = 1 + aa / cc;
    if (Math.abs(cc) < FPMIN) cc = FPMIN;
    d = 1 / d;
    const del = d * cc;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
/** Regularized incomplete beta I_x(a, b). */
function betainc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-tailed p for a t statistic with df degrees of freedom. */
function tPValueTwoTailed(t: number, df: number): number {
  return betainc(df / (df + t * t), df / 2, 0.5);
}
/** Excel F.TEST: two-tailed p for F = var1/var2 with (d1, d2) df. */
function fTestPValue(var1: number, n1: number, var2: number, n2: number): number {
  const f = var1 / var2;
  const d1 = n1 - 1;
  const d2 = n2 - 1;
  const cdf = betainc((d1 * f) / (d1 * f + d2), d1 / 2, d2 / 2);
  return 2 * Math.min(cdf, 1 - cdf);
}
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sampleVar(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}
/** Least-squares fit y = intercept + slope x. */
function linFit(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let sst = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    sst += (ys[i]! - my) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssr = 0;
  for (let i = 0; i < xs.length; i++) {
    const fit = intercept + slope * xs[i]!;
    ssr += (ys[i]! - fit) ** 2;
  }
  return { slope, intercept, r2: 1 - ssr / sst };
}

// ---------------------------------------------------------------- moments
describe('STDEV.P / STDEV.S / VAR.P / VAR.S', () => {
  // Classic textbook dataset (population sd is exactly 2).
  const data = [2, 4, 4, 4, 5, 5, 7, 9];
  const arr = `{${data.join(',')}}`;
  const ev = evalMap([
    `=STDEV.P(${arr})`, `=STDEV.S(${arr})`, `=VAR.P(${arr})`, `=VAR.S(${arr})`,
    '=STDEV.P({5})', '=VAR.S({5})',
  ]);
  const m = mean(data);
  const ss = data.reduce((a, b) => a + (b - m) ** 2, 0); // 32
  it('STDEV.P divides by n', () => {
    expect(num(ev(`=STDEV.P(${arr})`))).toBeCloseTo(Math.sqrt(ss / data.length), 12);
  });
  it('STDEV.S divides by n-1', () => {
    expect(num(ev(`=STDEV.S(${arr})`))).toBeCloseTo(Math.sqrt(ss / (data.length - 1)), 12);
  });
  it('VAR.P divides by n', () => {
    expect(num(ev(`=VAR.P(${arr})`))).toBeCloseTo(ss / data.length, 12);
  });
  it('VAR.S divides by n-1', () => {
    expect(num(ev(`=VAR.S(${arr})`))).toBeCloseTo(ss / (data.length - 1), 12);
  });
  it('STDEV.P of a single value is 0; VAR.S of a single value is #DIV/0!', () => {
    expect(num(ev('=STDEV.P({5})'))).toBe(0);
    expect(errCode(ev('=VAR.S({5})'))).toBe('#DIV/0!');
  });
});

describe('COVARIANCE.P / COVARIANCE.S', () => {
  const xs = [2, 4, 6];
  const ys = [3, 5, 7];
  const ev = evalMap([
    '=COVARIANCE.P({2,4,6},{3,5,7})', '=COVARIANCE.S({2,4,6},{3,5,7})',
    '=COVARIANCE.S({1,2},{3})',
  ]);
  const mx = mean(xs);
  const my = mean(ys);
  const cross = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0); // 8
  it('COVARIANCE.P divides by n', () => {
    expect(num(ev('=COVARIANCE.P({2,4,6},{3,5,7})'))).toBeCloseTo(cross / xs.length, 12);
  });
  it('COVARIANCE.S divides by n-1', () => {
    expect(num(ev('=COVARIANCE.S({2,4,6},{3,5,7})'))).toBeCloseTo(cross / (xs.length - 1), 12);
  });
  it('mismatched lengths return #N/A (Microsoft contract)', () => {
    expect(errCode(ev('=COVARIANCE.S({1,2},{3})'))).toBe('#N/A');
  });
});

// ---------------------------------------------------------------- exclusive percentiles
/** Excel PERCENTILE.EXC: position k(n+1) in the sorted array, interpolated. */
function percentileExc(sorted: number[], k: number): number {
  const pos = k * (sorted.length + 1); // 1-based
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return sorted[lo - 1]! + frac * (sorted[lo]! - sorted[lo - 1]!);
}
describe('PERCENTILE.EXC / QUARTILE.EXC / PERCENTRANK.EXC', () => {
  const ev = evalMap([
    '=PERCENTILE.EXC({1,2,3,4},0.25)', '=PERCENTILE.EXC({1,2,3,4},0.5)',
    '=PERCENTILE.EXC({1,2,3,4},0.8)', '=PERCENTILE.EXC({1,2,3,4},0.05)',
    '=QUARTILE.EXC({1,2,3,4,5,6,7,8,9,10,11,12},1)',
    '=QUARTILE.EXC({1,2,3,4},0)',
    '=PERCENTRANK.EXC({10,20,30,40},20)', '=PERCENTRANK.EXC({10,20,30,40},25)',
    '=PERCENTRANK.EXC({10,20,30,40},40)',
  ]);
  it('PERCENTILE.EXC interpolates at k(n+1)', () => {
    expect(num(ev('=PERCENTILE.EXC({1,2,3,4},0.25)'))).toBeCloseTo(percentileExc([1, 2, 3, 4], 0.25), 12);
    expect(num(ev('=PERCENTILE.EXC({1,2,3,4},0.5)'))).toBeCloseTo(percentileExc([1, 2, 3, 4], 0.5), 12);
  });
  it('PERCENTILE.EXC accepts the boundary k = n/(n+1)', () => {
    expect(num(ev('=PERCENTILE.EXC({1,2,3,4},0.8)'))).toBeCloseTo(4, 12);
  });
  it('PERCENTILE.EXC below 1/(n+1) returns #NUM! (Microsoft contract)', () => {
    expect(errCode(ev('=PERCENTILE.EXC({1,2,3,4},0.05)'))).toBe('#NUM!');
  });
  it('QUARTILE.EXC is PERCENTILE.EXC at quart/4', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(num(ev('=QUARTILE.EXC({1,2,3,4,5,6,7,8,9,10,11,12},1)')))
      .toBeCloseTo(percentileExc(data, 0.25), 12);
  });
  it('QUARTILE.EXC with quart 0 returns #NUM! (Microsoft contract)', () => {
    expect(errCode(ev('=QUARTILE.EXC({1,2,3,4},0)'))).toBe('#NUM!');
  });
  // Excel PERCENTRANK.EXC: exact matches return rank/(n+1) with the
  // 1-based rank, i.e. the inverse of PERCENTILE.EXC — for
  // {10,20,30,40}: 20 -> 2/5 = 0.4, 25 -> 0.5, 40 -> 4/5 = 0.8.
  it('PERCENTRANK.EXC exact match returns rank/(n+1) = 0.4', () => {
    expect(num(ev('=PERCENTRANK.EXC({10,20,30,40},20)'))).toBeCloseTo(0.4, 9);
  });
  it('PERCENTRANK.EXC interpolates (25 -> 0.5)', () => {
    expect(num(ev('=PERCENTRANK.EXC({10,20,30,40},25)'))).toBeCloseTo(0.5, 9);
  });
  it('PERCENTRANK.EXC of the maximum returns n/(n+1) = 0.8', () => {
    expect(num(ev('=PERCENTRANK.EXC({10,20,30,40},40)'))).toBeCloseTo(0.8, 9);
  });
});

// ---------------------------------------------------------------- hypothesis tests
describe('CHISQ.TEST / F.TEST / T.TEST', () => {
  const ev = evalMap([
    '=CHISQ.TEST({15,5;10,10;5,15},{10,10;10,10;10,10})',
    '=CHISQ.TEST({10,10;10,10},{10,10;10,10})',
    '=F.TEST({1,2,3},{4,5,6})',
    '=F.TEST({1,2,3},{1,10,100})',
    '=T.TEST({3,4,5,8,9,1,2,4,5},{6,19,3,2,14,4,5,17,1},2,1)',
    '=T.TEST({1,2,3},{1,2,3},2,2)',
    '=T.TEST({1,2,3},{4,5,6},3,1)',
  ]);
  it('CHISQ.TEST: chi2 = 10 on 2 df, whose survival is exp(-chi2/2)', () => {
    // chi2 = sum (a-e)^2/e over the 3x2 table = (25+25+0+0+25+25)/10 = 10;
    // for df = 2 the chi-square survival function is exactly e^(-x/2).
    expect(num(ev('=CHISQ.TEST({15,5;10,10;5,15},{10,10;10,10;10,10})')))
      .toBeCloseTo(Math.exp(-5), 9);
  });
  it('CHISQ.TEST of identical ranges is 1 (chi2 = 0)', () => {
    expect(num(ev('=CHISQ.TEST({10,10;10,10},{10,10;10,10})'))).toBeCloseTo(1, 12);
  });
  it('F.TEST of equal-variance samples is 1 (F = 1)', () => {
    expect(num(ev('=F.TEST({1,2,3},{4,5,6})'))).toBeCloseTo(1, 9);
  });
  it('F.TEST matches the independent incomplete-beta computation', () => {
    const expected = fTestPValue(sampleVar([1, 2, 3]), 3, sampleVar([1, 10, 100]), 3);
    expect(num(ev('=F.TEST({1,2,3},{1,10,100})'))).toBeCloseTo(expected, 9);
  });
  // Microsoft Support, T.TEST function: paired two-tailed test on
  // {3,4,5,8,9,1,2,4,5} vs {6,19,3,2,14,4,5,17,1} -> 0.196016.
  it('T.TEST matches the Microsoft example (paired, two-tailed)', () => {
    const a = [3, 4, 5, 8, 9, 1, 2, 4, 5];
    const b = [6, 19, 3, 2, 14, 4, 5, 17, 1];
    const diffs = a.map((x, i) => x - b[i]!);
    const md = mean(diffs);
    const t = md / (Math.sqrt(sampleVar(diffs)) / Math.sqrt(diffs.length));
    const expected = tPValueTwoTailed(t, diffs.length - 1);
    expect(expected).toBeCloseTo(0.196016, 5); // the documented value
    expect(num(ev('=T.TEST({3,4,5,8,9,1,2,4,5},{6,19,3,2,14,4,5,17,1},2,1)')))
      .toBeCloseTo(expected, 9);
  });
  it('T.TEST of identical samples (type 2) is 1 (t = 0)', () => {
    expect(num(ev('=T.TEST({1,2,3},{1,2,3},2,2)'))).toBeCloseTo(1, 9);
  });
  it('T.TEST with tails other than 1 or 2 returns #NUM! (Microsoft contract)', () => {
    expect(errCode(ev('=T.TEST({1,2,3},{4,5,6},3,1)'))).toBe('#NUM!');
  });
});

// ---------------------------------------------------------------- GAMMALN.PRECISE
describe('GAMMALN.PRECISE', () => {
  const ev = evalMap(['=GAMMALN.PRECISE(2.5)', '=GAMMALN.PRECISE(5)']);
  it('GAMMALN.PRECISE(2.5) = ln(3 sqrt(pi) / 4) exactly', () => {
    // Gamma(5/2) = 3 sqrt(pi)/4 in closed form.
    expect(num(ev('=GAMMALN.PRECISE(2.5)'))).toBeCloseTo(Math.log((3 * Math.sqrt(Math.PI)) / 4), 12);
  });
  it('GAMMALN.PRECISE(5) = ln(4!) = ln 24', () => {
    expect(num(ev('=GAMMALN.PRECISE(5)'))).toBeCloseTo(Math.log(24), 12);
  });
});

// ---------------------------------------------------------------- regression family
describe('LINEST / LOGEST / TREND / GROWTH', () => {
  const xs = [1, 2, 3, 4];
  const ys = [2, 4, 5, 7];
  const fit = linFit(xs, ys); // slope 1.6, intercept 0.5
  const ev = evalMap([
    '=INDEX(LINEST({2,4,5,7},{1,2,3,4}),1,1)',
    '=INDEX(LINEST({2,4,5,7},{1,2,3,4}),1,2)',
    '=INDEX(LINEST({2,4,5,7},{1,2,3,4},TRUE,TRUE),3,1)',
    '=INDEX(LOGEST({2,4,8,16},{1,2,3,4}),1,1)',
    '=INDEX(LOGEST({2,4,8,16},{1,2,3,4}),1,2)',
    '=TREND({2,4,5,7},{1,2,3,4},5)',
    '=SUM(TREND({2,4,5,7},{1,2,3,4},{5,6}))',
    '=TREND({2,4,5},{1,2,3,4},5)',
    '=GROWTH({2,4,8,16},{1,2,3,4},5)',
    '=SUM(GROWTH({2,4,8,16},{1,2,3,4},{5,6}))',
    '=GROWTH({2,4,8},{1,2},5)',
  ]);
  // Microsoft documents LINEST as returning the regression array:
  // row 1 = {slope, intercept}, and with stats=TRUE row 3 col 1 = R^2.
  it('LINEST returns the least-squares slope', () => {
    expect(num(ev('=INDEX(LINEST({2,4,5,7},{1,2,3,4}),1,1)'))).toBeCloseTo(fit.slope, 9);
  });
  it('LINEST returns the least-squares intercept', () => {
    expect(num(ev('=INDEX(LINEST({2,4,5,7},{1,2,3,4}),1,2)'))).toBeCloseTo(fit.intercept, 9);
  });
  it('LINEST with stats returns R^2', () => {
    expect(num(ev('=INDEX(LINEST({2,4,5,7},{1,2,3,4},TRUE,TRUE),3,1)'))).toBeCloseTo(fit.r2, 9);
  });
  // LOGEST fits y = b x m^x: for y = 2^x the fit is exact, m = 2, b = 1.
  it('LOGEST returns m = 2 for y = 2^x', () => {
    const logFit = linFit(xs, [2, 4, 8, 16].map(Math.log));
    expect(num(ev('=INDEX(LOGEST({2,4,8,16},{1,2,3,4}),1,1)')))
      .toBeCloseTo(Math.exp(logFit.slope), 9);
  });
  it('LOGEST returns b = 1 for y = 2^x', () => {
    const logFit = linFit(xs, [2, 4, 8, 16].map(Math.log));
    expect(num(ev('=INDEX(LOGEST({2,4,8,16},{1,2,3,4}),1,2)')))
      .toBeCloseTo(Math.exp(logFit.intercept), 9);
  });
  // TREND evaluates the fitted line AT the new x values (Microsoft).
  it('TREND predicts at the requested new x (8.5 at x = 5)', () => {
    expect(num(ev('=TREND({2,4,5,7},{1,2,3,4},5)')))
      .toBeCloseTo(fit.intercept + fit.slope * 5, 9);
  });
  it('TREND returns one value per new x', () => {
    const expected = fit.intercept + fit.slope * 5 + (fit.intercept + fit.slope * 6);
    expect(num(ev('=SUM(TREND({2,4,5,7},{1,2,3,4},{5,6}))'))).toBeCloseTo(expected, 9);
  });
  it('TREND with mismatched known lengths returns #N/A', () => {
    expect(errCode(ev('=TREND({2,4,5},{1,2,3,4},5)'))).toBe('#N/A');
  });
  // GROWTH evaluates the fitted exponential at the new x values.
  it('GROWTH predicts 32 at x = 5 for y = 2^x', () => {
    expect(num(ev('=GROWTH({2,4,8,16},{1,2,3,4},5)'))).toBeCloseTo(32, 9);
  });
  it('GROWTH returns one value per new x (32 + 64)', () => {
    expect(num(ev('=SUM(GROWTH({2,4,8,16},{1,2,3,4},{5,6}))'))).toBeCloseTo(96, 9);
  });
  it('GROWTH with mismatched known lengths returns #N/A', () => {
    expect(errCode(ev('=GROWTH({2,4,8},{1,2},5)'))).toBe('#N/A');
  });
});
