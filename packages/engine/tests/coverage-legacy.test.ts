/**
 * Phase-2 function-coverage tests: LEGACY-COMPATIBILITY functions (the
 * 41-name Compatibility layer) that previously had no gold or unit
 * coverage — BETADIST, CHITEST, FTEST, PERCENTRANK, QUARTILE, STDEV,
 * TTEST, VAR. Per the 2026-10-21 user ruling these functions are KEPT
 * and must be tested like everything else (see
 * hidden_files/function-coverage/TEST-COVERAGE-AUDIT.md).
 *
 * Expected values are computed independently in plain JS (sample
 * moments, percentile interpolation per Microsoft's documented
 * PERCENTRANK/QUARTILE definitions, and distribution p-values via a
 * Numerical-Recipes regularized incomplete beta — validated against
 * Microsoft's documented BETADIST(2,8,10,1,3) = 0.685470581).
 *
 * Engine disagreements are it(...) cases recorded as FOUND
 * DEFECTS D18 / D19 in the audit file.
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

// ---- Independent distribution math (Numerical Recipes; same as coverage-stats)
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
function betainc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sampleVar(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}
function fTestPValue(var1: number, n1: number, var2: number, n2: number): number {
  const f = var1 / var2;
  const d1 = n1 - 1;
  const d2 = n2 - 1;
  const cdf = betainc((d1 * f) / (d1 * f + d2), d1 / 2, d2 / 2);
  return 2 * Math.min(cdf, 1 - cdf);
}

// ---------------------------------------------------------------- BETADIST
describe('BETADIST (legacy)', () => {
  const ev = evalMap(['=BETADIST(2,8,10,1,3)', '=BETADIST(0.5,8,10)']);
  // Microsoft Support, BETADIST function: =BETADIST(2,8,10,1,3) returns
  // 0.685470581 — the beta CDF at (2-1)/(3-1) = 0.5 with alpha 8, beta 10.
  it('matches the Microsoft example (0.685470581)', () => {
    expect(betainc(0.5, 8, 10)).toBeCloseTo(0.685470581, 8); // helper sanity
    expect(num(ev('=BETADIST(2,8,10,1,3)'))).toBeCloseTo(betainc(0.5, 8, 10), 9);
  });
  it('three-argument form uses A = 0, B = 1', () => {
    expect(num(ev('=BETADIST(0.5,8,10)'))).toBeCloseTo(betainc(0.5, 8, 10), 9);
  });
});

// ---------------------------------------------------------------- CHITEST / FTEST / TTEST
describe('CHITEST, FTEST, TTEST (legacy aliases of the .TEST functions)', () => {
  const ev = evalMap([
    '=CHITEST({15,5;10,10;5,15},{10,10;10,10;10,10})',
    '=FTEST({1,2,3},{4,5,6})',
    '=FTEST({1,2,3},{1,10,100})',
    '=TTEST({3,4,5,8,9,1,2,4,5},{6,19,3,2,14,4,5,17,1},2,1)',
    '=TTEST({1,2,3},{1,2,3},2,2)',
  ]);
  it('CHITEST: chi2 = 10 on 2 df, survival exp(-chi2/2)', () => {
    expect(num(ev('=CHITEST({15,5;10,10;5,15},{10,10;10,10;10,10})')))
      .toBeCloseTo(Math.exp(-5), 9);
  });
  it('FTEST of equal-variance samples is 1 (F = 1)', () => {
    expect(num(ev('=FTEST({1,2,3},{4,5,6})'))).toBeCloseTo(1, 9);
  });
  it('FTEST matches the independent incomplete-beta computation', () => {
    const expected = fTestPValue(sampleVar([1, 2, 3]), 3, sampleVar([1, 10, 100]), 3);
    expect(num(ev('=FTEST({1,2,3},{1,10,100})'))).toBeCloseTo(expected, 9);
  });
  // Same data as the Microsoft T.TEST worked example (paired, two-tailed).
  it('TTEST matches the Microsoft T.TEST example data (0.196016)', () => {
    const a = [3, 4, 5, 8, 9, 1, 2, 4, 5];
    const b = [6, 19, 3, 2, 14, 4, 5, 17, 1];
    const diffs = a.map((x, i) => x - b[i]!);
    const md = mean(diffs);
    const t = md / (Math.sqrt(sampleVar(diffs)) / Math.sqrt(diffs.length));
    const expected = betainc(
      (diffs.length - 1) / (diffs.length - 1 + t * t),
      (diffs.length - 1) / 2,
      0.5,
    );
    expect(expected).toBeCloseTo(0.196016, 5);
    expect(num(ev('=TTEST({3,4,5,8,9,1,2,4,5},{6,19,3,2,14,4,5,17,1},2,1)')))
      .toBeCloseTo(expected, 9);
  });
  it('TTEST of identical samples (type 2) is 1 (t = 0)', () => {
    expect(num(ev('=TTEST({1,2,3},{1,2,3},2,2)'))).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------- PERCENTRANK / QUARTILE / STDEV / VAR
describe('PERCENTRANK, QUARTILE, STDEV, VAR (legacy)', () => {
  const data = [2, 4, 4, 4, 5, 5, 7, 9];
  const arr = `{${data.join(',')}}`;
  const ev = evalMap([
    '=PERCENTRANK({10,20,30,40},30)',
    '=PERCENTRANK({13,12,11,8,4,3,2,1,1,1},4)',
    '=QUARTILE({1,2,3,4,5,6,7,8},1)',
    '=QUARTILE({1,2,3,4,5,6,7,8},2)',
    `=STDEV(${arr})`,
    `=VAR(${arr})`,
  ]);
  // Microsoft documents PERCENTRANK (inclusive) as: exact matches land
  // on (rank - 1) / (n - 1) with the 1-based rank; non-matches
  // interpolate. For {10,20,30,40} and x = 30 that is 2/3 -> 0.667.
  it('PERCENTRANK exact match is (rank-1)/(n-1) = 0.667', () => {
    expect(num(ev('=PERCENTRANK({10,20,30,40},30)'))).toBeCloseTo(2 / 3, 3);
  });
  it('PERCENTRANK on the 10-value dataset (x = 4 -> 5/9)', () => {
    // Sorted {1,1,1,2,3,4,8,11,12,13}: five values below 4, so
    // (6 - 1) / (10 - 1) = 5/9.
    expect(num(ev('=PERCENTRANK({13,12,11,8,4,3,2,1,1,1},4)'))).toBeCloseTo(5 / 9, 3);
  });
  // QUARTILE (inclusive): position 1 + k(n-1) in the sorted array.
  it('QUARTILE quart 1 interpolates at 1 + 0.25(n-1)', () => {
    // {1..8}: position 2.75 -> 2 + 0.75 x (3 - 2) = 2.75.
    expect(num(ev('=QUARTILE({1,2,3,4,5,6,7,8},1)'))).toBeCloseTo(2.75, 12);
  });
  it('QUARTILE quart 2 is the median', () => {
    expect(num(ev('=QUARTILE({1,2,3,4,5,6,7,8},2)'))).toBeCloseTo(4.5, 12);
  });
  it('STDEV is the sample standard deviation (n-1)', () => {
    expect(num(ev(`=STDEV(${arr})`))).toBeCloseTo(Math.sqrt(sampleVar(data)), 12);
  });
  it('VAR is the sample variance (n-1)', () => {
    expect(num(ev(`=VAR(${arr})`))).toBeCloseTo(sampleVar(data), 12);
  });
});
