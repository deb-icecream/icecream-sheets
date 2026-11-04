/**
 * Direct HyperFormula built-in overrides (registration-proven on HF 2.7.1 —
 * these function ids are NOT protected, so a later registerFunctionPlugin
 * call replaces the built-in; verified by evaluation probe).
 *
 * Fixed here (all verified against Excel cached values from real workbooks):
 * - BETA.DIST: upstream HyperFormula bug — returned exactly 5x the correct
 *   PDF (0.334444210966379 vs Excel's 0.06688884219206157). Reimplemented via
 *   the gamma-function relation.
 * - BETA.INV (Cycle 7): HyperFormula's jstat ibetainv runs Newton at EPS=1e-8
 *   with 10 iterations → 2.2M ulp error (e.g. BETA.INV(0.5,10,7)).
 *   Reimplemented on the bisection inverse of the high-precision
 *   regularized-incomplete-beta core.
 * - FLOOR.MATH: HyperFormula ignores the mode argument; Excel rounds
 *   negative numbers toward zero when mode is nonzero
 *   (FLOOR.MATH(-23.5,1,-1) = -23, not -24).
 * - T.INV / T.INV.2T / F.DIST.RT / CONFIDENCE.T: HyperFormula's
 *   approximations drift from Excel by 1e-5…1e-9; reimplemented on a
 *   high-precision regularized-incomplete-beta core (continued fraction +
 *   bisection inverse) matching Excel to ~1e-13.
 * - Cycle 5, Phase 2 (jstat precision): jstat, bundled inside HyperFormula,
 *   deliberately rounds binomial.cdf to 1e-10 (8.7M ulp error on
 *   BINOM.DIST), runs its inverse-beta Newton loop at EPS=1e-8 with 10
 *   iterations (2.4M ulp on F.INV.RT), and computes right tails as 1-cdf
 *   (12.6M ulp on CHISQ.TEST). Reimplemented on the same high-precision
 *   beta/gamma core: BINOM.DIST, BINOM.INV, F.DIST, F.INV, F.INV.RT,
 *   CHISQ.DIST, CHISQ.DIST.RT, CHISQ.INV, CHISQ.INV.RT, CHISQ.TEST, F.TEST —
 *   all matching Excel/scipy to ~10 ulp.
 *
 * - INT / MOD (function-coverage Phase 2, 2026-10-21): HyperFormula's INT
 *   truncates toward zero and its MOD is the JS remainder (sign of the
 *   dividend). Excel's INT rounds DOWN toward −∞ (INT(-7.1) = -8) and
 *   Excel's MOD follows the sign of the DIVISOR (MOD(-10,3) = 2,
 *   MOD(10,-3) = -2) per its documented definition MOD(n,d) = n − d·INT(n/d).
 *   These were the last 2 mismatches in the 421-case gold corpus.
 * - CEILING.MATH (Phase-2 coverage D21): HyperFormula flips the rounding
 *   direction only when mode === 1 exactly; Excel rounds negative numbers
 *   away from zero for ANY nonzero mode (CEILING.MATH(-5.5,2,-1) = -6,
 *   not -4). Only CEILING.MATH is taken over — CEILING / CEILING.PRECISE
 *   stay on the built-in (FLOOR.MATH is already overridden above).
 * - PERCENTRANK (legacy, D18): the legacy implementation in
 *   extended-functions4.ts used a mid-rank convention (+0.5 for exact
 *   matches, no interpolation); Excel's legacy PERCENTRANK is exactly
 *   PERCENTRANK.INC — (rank−1)/(n−1) with linear interpolation and the
 *   significance argument (default 3) applied as decimal rounding.
 * - BETADIST (legacy, D19): upstream it is only an ALIAS of BETA.DIST, so
 *   the legacy signature BETADIST(x, alpha, beta, [A], [B]) was misread
 *   as BETA.DIST's (x, alpha, beta, cumulative, [A], [B]) — the 5-arg
 *   form gave #NUM! and the 3-arg form #N/A. Reimplemented as the
 *   cumulative beta distribution on [A, B] over the beta core below.
 *
 * Unlike divergent-builtins.ts (which rewrites formula text because it
 * assumed protection), these overrides need no text rewriting: the formula
 * stays `=BETA.DIST(...)` and evaluates through this plugin.
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
  SimpleRangeValue,
  type ImplementedFunctions,
  type SimpleCellAddress,
} from 'hyperformula';
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type {
  Ast,
  CellRangeAst,
  ColumnRangeAst,
  RowRangeAst,
} from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { Interpreter } from 'hyperformula/typings/interpreter/Interpreter.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { AbsoluteCellRange } from 'hyperformula/commonjs/AbsoluteCellRange.js';
import { format as hfFormat } from 'hyperformula/commonjs/format/format.js';
import { getRawValue } from 'hyperformula/commonjs/interpreter/InterpreterValue.js';
// PERCENTRANK's original plugin (ExtendedPlugin4) must be registered before
// PercentrankOverridePlugin below reads its implementedFunctions metadata —
// but this module is otherwise reached (via extended-functions2, which
// imports the erf helpers) BEFORE extended-functions4 in plugins.ts order,
// so a top-level getFunctionPlugin('PERCENTRANK') here would see nothing.
// extended-functions4 imports nothing from this module, so importing it
// here is acyclic and makes the registration order deterministic.
import './extended-functions4.js';

// ---------------------------------------------------------------------------
// High-precision special functions
// ---------------------------------------------------------------------------

const SQRT_PI = Math.sqrt(Math.PI);

/**
 * ln(Γ(x)) via the Lanczos approximation (g=7, 9 coefficients).
 * Accurate to ~1e-15 for x > 0; reflection extends it below 0.5.
 */
function gammaLn(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Γ(x)·Γ(1−x) = π/sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaLn(1 - x);
  }
  const z = x - 1;
  let a = c[0]!;
  for (let i = 1; i < 9; i++) a += c[i]! / (z + i);
  const t = z + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (z + 0.5) * Math.log(t) -
    t +
    Math.log(a)
  );
}

/**
 * Continued fraction for the incomplete beta function
 * (Numerical Recipes `betacf`). Converges to ~1e-14.
 */
function betaCF(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    let del = c * d;
    h *= del;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    del = c * d;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/**
 * ln B(a,b) without the catastrophic cancellation of
 * gammaLn(a)+gammaLn(b)−gammaLn(a+b) for large arguments (the two ~360-size
 * terms cancel down to ~−9 for binomial-scale inputs, amplifying gammaLn's
 * error ~40x). When one argument is a positive integer, pairing the
 * factorial terms as Σ ln(i/(z+i−1)) keeps every summand the same sign —
 * no large-number subtraction anywhere.
 */
function lbeta(a: number, b: number): number {
  const MAXSUM = 100000;
  if (Number.isInteger(b) && b >= 1 && b <= MAXSUM) {
    // ln B(a,b) = Σ_{i=1}^{b-1} ln(i/(a+i-1)) − ln(a+b−1)
    let s = 0;
    for (let i = 1; i < b; i++) s += Math.log(i / (a + i - 1));
    return s - Math.log(a + b - 1);
  }
  if (Number.isInteger(a) && a >= 1 && a <= MAXSUM) {
    let s = 0;
    for (let i = 1; i < a; i++) s += Math.log(i / (b + i - 1));
    return s - Math.log(a + b - 1);
  }
  return gammaLn(a) + gammaLn(b) - gammaLn(a + b);
}

/**
 * ln(C(n,k)) for non-negative integers via a direct log-sum — no gammaLn
 * cancellation (same ~40x amplification issue as lbeta above).
 */
function lnChoose(n: number, k: number): number {
  const kk = Math.min(k, n - k);
  let s = 0;
  for (let i = 1; i <= kk; i++) s += Math.log((n - kk + i) / i);
  return s;
}

/**
 * Exact C(n,k) as a double (≤1 ulp) via BigInt, for 0 ≤ k ≤ n ≤ 1024.
 * Returns NaN when unavailable (non-integers, n > 1024, overflow).
 * The recurrence C(n,j+1) = C(n,j)·(n−j)/(j+1) is exact in BigInt at
 * every step — unlike the floating-point recurrence, error does not
 * accumulate with j.
 */
function chooseExact(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n || n > 1024) {
    return NaN;
  }
  const kk = Math.min(k, n - k);
  let c = 1n;
  const bn = BigInt(n);
  for (let i = 0; i < kk; i++) c = (c * (bn - BigInt(i))) / BigInt(i + 1);
  const v = Number(c);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Exact 1/B(a,b) = (a+b−1)·C(a+b−2, a−1) via BigInt (≤2 ulp), or NaN.
 * Lets the beta front factor skip logarithms entirely.
 */
function invBetaExact(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) return NaN;
  const c = chooseExact(a + b - 2, a - 1);
  if (Number.isNaN(c)) return NaN;
  const invB = (a + b - 1) * c;
  return Number.isFinite(invB) && invB > 0 ? invB : NaN;
}

/**
 * bt = x^a·(1−x)^b / B(a,b), the beta continued-fraction front factor,
 * to ~few ulp. Three tiers: (1) exact 1/B via BigInt — no logarithms,
 * correctly-rounded powers; (2) correctly-rounded powers over exp(lb);
 * (3) pure log domain for the under/overflow regime.
 */
function betaBt(x: number, a: number, b: number): number {
  const px = Math.pow(x, a);
  const qx = Math.pow(1 - x, b);
  const invB = invBetaExact(a, b);
  if (!Number.isNaN(invB) && px > 0 && qx > 0) {
    const bt = px * qx * invB;
    if (Number.isFinite(bt)) return bt;
  }
  const lb = lbeta(a, b);
  const elb = Math.exp(lb);
  if (px > 0 && qx > 0 && elb > 0 && Number.isFinite(px) && Number.isFinite(qx) && Number.isFinite(elb)) {
    return (px * qx) / elb;
  }
  return Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lb);
}

/**
 * Regularized incomplete beta I_x(a, b) for 0 ≤ x ≤ 1, a > 0, b > 0.
 * Uses the continued fraction on the side that converges faster.
 */
export function betaRegularized(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = betaBt(x, a, b);
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaCF(a, b, x)) / a;
  }
  return 1 - (bt * betaCF(b, a, 1 - x)) / b;
}

/**
 * Inverse regularized incomplete beta: the x with I_x(a,b) = p.
 * I_x is monotone in x, so bisection converges robustly to ~1e-16.
 */
export function betaRegularizedInv(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (betaRegularized(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * erfc(x) for x ≥ 0. Maclaurin series for x ≤ 2 (no cancellation there:
 * erfc(2) ≈ 0.0047); the Laplace continued fraction above 2, where the
 * series would catastrophically cancel.
 */
function erfcPositive(x: number): number {
  if (x <= 2) {
    const x2 = x * x;
    let term = x;
    let sum = x;
    for (let n = 1; n < 200; n++) {
      term *= (-x2 * (2 * n - 1)) / (n * (2 * n + 1));
      const prev = sum;
      sum += term;
      if (sum === prev) break;
    }
    return 1 - (2 / SQRT_PI) * sum;
  }
  // Laplace continued fraction via Lentz's algorithm:
  // erfc(x) = e^(−x²)/(x√π) / [1 + a₁/(1 + a₂/(1 + …))], aⱼ = j/(2x²).
  const x2 = x * x;
  const FPMIN = 1e-300;
  const EPS = 1e-15;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let j = 1; j <= 500; j++) {
    const aj = j / (2 * x2);
    d = 1 + aj * d;
    if (d === 0) d = FPMIN;
    d = 1 / d;
    c = 1 + aj / c;
    if (c === 0) c = FPMIN;
    const cd = c * d;
    f *= cd;
    if (Math.abs(cd - 1) < EPS) break;
  }
  return Math.exp(-x2) / (x * SQRT_PI) / f;
}

/** erf(x) to ~1e-15. */
export function erfHighPrecision(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : x < 0 ? -1 : NaN;
  return x >= 0 ? 1 - erfcPositive(x) : erfcPositive(-x) - 1;
}

/** erfc(x) to ~1e-15. */
export function erfcHighPrecision(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 0 : x < 0 ? 2 : NaN;
  return x >= 0 ? erfcPositive(x) : 2 - erfcPositive(-x);
}

/**
 * Inverse of the left-tailed Student-t CDF with df degrees of freedom.
 * Via the beta relation: t = ±√(df·(1−x)/x), x = I⁻¹_{2·min(p,1−p)}(df/2, ½).
 */
function studentTInv(p: number, df: number): number {
  const x = betaRegularizedInv(2 * Math.min(p, 1 - p), df / 2, 0.5);
  const t = Math.sqrt((df * (1 - x)) / x);
  return p < 0.5 ? -t : t;
}

/**
 * Excel's FLOOR.MATH: rounds down to a multiple of significance.
 * - significance 0 → 0 (Excel, unlike FLOOR).
 * - The significance sign is ignored (FLOOR.MATH(23.5,-1) = 23 — verified
 *   against Excel's cached values); only its magnitude matters.
 * - mode matters only for negative numbers: 0/omitted rounds away from
 *   zero (toward −∞); any nonzero mode rounds toward zero.
 */
function floorMath(number: number, significance: number, mode: number): number {
  if (significance === 0) return 0;
  const s = Math.abs(significance);
  const m = number / s;
  let k: number;
  if (number < 0) {
    k = mode === 0 ? Math.floor(m) : Math.ceil(m);
  } else {
    k = Math.floor(m);
  }
  return k * s;
}

/**
 * Excel's CEILING.MATH: rounds up to a multiple of significance.
 * - significance 0 → 0 (Excel, like FLOOR.MATH above).
 * - The significance sign is ignored; only its magnitude matters.
 * - mode matters only for negative numbers: 0/omitted rounds toward zero;
 *   ANY nonzero mode rounds away from zero (toward −∞). HyperFormula's
 *   built-in flips direction only when mode === 1 exactly (D21), so
 *   CEILING.MATH(-5.5, 2, -1) gave -4 instead of Excel's -6.
 */
function ceilingMath(number: number, significance: number, mode: number): number {
  if (significance === 0) return 0;
  const s = Math.abs(significance);
  const m = number / s;
  let k: number;
  if (number < 0) {
    k = mode === 0 ? Math.ceil(m) : Math.floor(m);
  } else {
    k = Math.ceil(m);
  }
  return k * s;
}

/** Excel-style truthiness for the BETA.DIST cumulative flag. */
function coerceCumulative(v: InterpreterValue): boolean | CellError {
  if (v instanceof CellError) return v;
  if (v === EmptyValue) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return new CellError(ErrorType.VALUE, 'BETA.DIST: cumulative must be logical.');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class HfOverridesPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    'BETA.DIST': {
      method: 'betaDist',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
      ],
    },
    'BETA.INV': {
      method: 'betaInv',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
      ],
    },
    'FLOOR.MATH': {
      method: 'floorMath',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
      ],
    },
    'T.INV': {
      method: 'tInv',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'T.INV.2T': {
      method: 'tInv2T',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'F.DIST.RT': {
      method: 'fDistRt',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'CONFIDENCE.T': {
      method: 'confidenceT',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
  };

  public betaDist(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('BETA.DIST'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [xArg, aArg, bArg, cumArg, aBoundArg, bBoundArg] = args;
        for (const a of [xArg, aArg, bArg]) {
          if (a instanceof CellError) return a;
        }
        const x = Number(xArg === EmptyValue ? 0 : xArg);
        const alpha = Number(aArg === EmptyValue ? 0 : aArg);
        const beta = Number(bArg === EmptyValue ? 0 : bArg);
        const cum = coerceCumulative(cumArg);
        if (cum instanceof CellError) return cum;
        const A = aBoundArg === undefined || aBoundArg === EmptyValue ? 0 : Number(aBoundArg);
        const B = bBoundArg === undefined || bBoundArg === EmptyValue ? 1 : Number(bBoundArg);
        if (![x, alpha, beta, A, B].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'BETA.DIST: non-numeric argument.');
        }
        if (alpha <= 0 || beta <= 0 || A >= B || x < A || x > B) {
          return new CellError(ErrorType.NUM, 'BETA.DIST: argument out of range.');
        }
        if (!cum) {
          // PDF via the gamma-function relation (this is what HyperFormula
          // gets wrong by exactly 5x upstream).
          const lbeta = gammaLn(alpha) + gammaLn(beta) - gammaLn(alpha + beta);
          return Math.exp(
            (alpha - 1) * Math.log(x - A) +
            (beta - 1) * Math.log(B - x) -
            lbeta -
            (alpha + beta - 1) * Math.log(B - A),
          );
        }
        // CDF: I_((x−A)/(B−A))(α, β).
        return betaRegularized((x - A) / (B - A), alpha, beta);
      });
  }

  public betaInv(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('BETA.INV'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [pArg, aArg, bArg, aBoundArg, bBoundArg] = args;
        for (const a of [pArg, aArg, bArg]) {
          if (a instanceof CellError) return a;
        }
        const p = Number(pArg === EmptyValue ? 0 : pArg);
        const alpha = Number(aArg === EmptyValue ? 0 : aArg);
        const beta = Number(bArg === EmptyValue ? 0 : bArg);
        const A = aBoundArg === undefined || aBoundArg === EmptyValue ? 0 : Number(aBoundArg);
        const B = bBoundArg === undefined || bBoundArg === EmptyValue ? 1 : Number(bBoundArg);
        if (![p, alpha, beta, A, B].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'BETA.INV: non-numeric argument.');
        }
        // Excel: probability must be in (0, 1]; alpha, beta > 0; A < B.
        if (p <= 0 || p > 1 || alpha <= 0 || beta <= 0 || A >= B) {
          return new CellError(ErrorType.NUM, 'BETA.INV: argument out of range.');
        }
        // Inverse CDF scaled to [A, B].
        return betaRegularizedInv(p, alpha, beta) * (B - A) + A;
      });
  }

  public floorMath(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('FLOOR.MATH'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [numArg, sigArg, modeArg] = args;
        if (numArg instanceof CellError) return numArg;
        if (sigArg instanceof CellError) return sigArg;
        const number = Number(numArg === EmptyValue ? 0 : numArg);
        const significance = sigArg === undefined || sigArg === EmptyValue ? 1 : Number(sigArg);
        const mode = modeArg === undefined || modeArg === EmptyValue ? 0 : Number(modeArg);
        if (![number, significance, mode].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'FLOOR.MATH: non-numeric argument.');
        }
        return floorMath(number, significance, mode);
      });
  }

  public tInv(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('T.INV'),
      (pArg: InterpreterValue, dfArg: InterpreterValue): InterpreterValue => {
        if (pArg instanceof CellError) return pArg;
        if (dfArg instanceof CellError) return dfArg;
        const p = Number(pArg === EmptyValue ? 0 : pArg);
        const df = Math.trunc(Number(dfArg === EmptyValue ? 0 : dfArg));
        if (!Number.isFinite(p) || !Number.isFinite(df)) {
          return new CellError(ErrorType.VALUE, 'T.INV: non-numeric argument.');
        }
        if (p <= 0 || p >= 1 || df < 1) {
          return new CellError(ErrorType.NUM, 'T.INV: argument out of range.');
        }
        return studentTInv(p, df);
      });
  }

  public tInv2T(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('T.INV.2T'),
      (pArg: InterpreterValue, dfArg: InterpreterValue): InterpreterValue => {
        if (pArg instanceof CellError) return pArg;
        if (dfArg instanceof CellError) return dfArg;
        const p = Number(pArg === EmptyValue ? 0 : pArg);
        const df = Math.trunc(Number(dfArg === EmptyValue ? 0 : dfArg));
        if (!Number.isFinite(p) || !Number.isFinite(df)) {
          return new CellError(ErrorType.VALUE, 'T.INV.2T: non-numeric argument.');
        }
        if (p <= 0 || p > 1 || df < 1) {
          return new CellError(ErrorType.NUM, 'T.INV.2T: argument out of range.');
        }
        // Two-tailed inverse: the t with P(|T| > t) = p.
        return studentTInv(1 - p / 2, df);
      });
  }

  public fDistRt(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('F.DIST.RT'),
      (xArg: InterpreterValue, d1Arg: InterpreterValue, d2Arg: InterpreterValue): InterpreterValue => {
        for (const a of [xArg, d1Arg, d2Arg]) {
          if (a instanceof CellError) return a;
        }
        const x = Number(xArg === EmptyValue ? 0 : xArg);
        const d1 = Math.trunc(Number(d1Arg === EmptyValue ? 0 : d1Arg));
        const d2 = Math.trunc(Number(d2Arg === EmptyValue ? 0 : d2Arg));
        if (![x, d1, d2].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'F.DIST.RT: non-numeric argument.');
        }
        if (x < 0 || d1 < 1 || d2 < 1) {
          return new CellError(ErrorType.NUM, 'F.DIST.RT: argument out of range.');
        }
        // Right-tailed F CDF: I_{d2/(d2+d1·x)}(d2/2, d1/2).
        return betaRegularized(d2 / (d2 + d1 * x), d2 / 2, d1 / 2);
      });
  }

  public confidenceT(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('CONFIDENCE.T'),
      (aArg: InterpreterValue, sdArg: InterpreterValue, nArg: InterpreterValue): InterpreterValue => {
        for (const a of [aArg, sdArg, nArg]) {
          if (a instanceof CellError) return a;
        }
        const alpha = Number(aArg === EmptyValue ? 0 : aArg);
        const sd = Number(sdArg === EmptyValue ? 0 : sdArg);
        const n = Math.trunc(Number(nArg === EmptyValue ? 0 : nArg));
        if (![alpha, sd, n].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'CONFIDENCE.T: non-numeric argument.');
        }
        if (alpha <= 0 || alpha >= 1 || sd <= 0 || n < 1) {
          return new CellError(ErrorType.NUM, 'CONFIDENCE.T: argument out of range.');
        }
        return (studentTInv(1 - alpha / 2, n - 1) * sd) / Math.sqrt(n);
      });
  }
}

// ---------------------------------------------------------------------------
// SUBTOTAL: ignore nested SUBTOTAL/AGGREGATE (Excel semantics)
// ---------------------------------------------------------------------------

/**
 * Excel's SUBTOTAL ignores nested SUBTOTAL and AGGREGATE results inside its
 * range arguments (documented "to avoid double-counting"). HyperFormula's
 * built-in SUBTOTAL has no such exclusion, which additionally breaks the
 * classic totals-row idiom `=SUBTOTAL(103,K2:K7)` placed in K7 itself: the
 * static dependency graph sees a self-cycle and poisons the cell with
 * #CYCLE!. With the nested exclusion the self cell is skipped, so the
 * engine's lazy re-evaluation fixpoint (workbook.ts resolveFalseCycles)
 * resolves it to the Excel value (5 for COUNTA(K2:K6)).
 *
 * SUBTOTAL is not a protected built-in (registration-proven on HF 2.7.1),
 * so this subclasses the original NumericAggregationPlugin and overrides
 * only `subtotal`. When no nested SUBTOTAL/AGGREGATE cell is found in any
 * range/reference argument the call delegates to the original
 * implementation — zero behavior change for the common case. Only the
 * nested case aggregates manually (Excel-faithful, skipping nested cells).
 *
 * Known limitation (same as the built-in): function numbers 101–111 behave
 * like 1–11; manually-hidden rows are not filtered because the engine does
 * not track row visibility.
 */
const OrigSubtotalPlugin = HyperFormula.getFunctionPlugin('SUBTOTAL') as unknown as {
  new (...args: never[]): FunctionPlugin;
  implementedFunctions: ImplementedFunctions;
};
const origSubtotalMethod = (
  OrigSubtotalPlugin as unknown as {
    prototype: { subtotal(a: ProcedureAst, s: InterpreterState): InterpreterValue };
  }
).prototype.subtotal;

/** Canonical procedure names excluded from SUBTOTAL ranges (Excel rule). */
const NESTED_AGGREGATORS = new Set(['SUBTOTAL', 'AGGREGATE']);

/** Valid SUBTOTAL function numbers (101–111 ≡ 1–11 here; see note above). */
const SUBTOTAL_FUNCTIONS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
]);

/** Loose AST view: avoids nominal-enum comparison issues across builds. */
interface LooseAst {
  type: string;
  reference?: { toSimpleCellAddress(base: SimpleCellAddress): SimpleCellAddress };
}

/** True when the cell's formula contains a SUBTOTAL/AGGREGATE call. */
function cellFormulaHasNestedAggregator(
  dg: {
    getCell(a: SimpleCellAddress): unknown;
    lazilyTransformingAstService: unknown;
  },
  addr: SimpleCellAddress,
): boolean {
  const vertex = dg.getCell(addr) as
    | { getFormula?: (service: unknown) => Ast }
    | undefined;
  if (!vertex || typeof vertex.getFormula !== 'function') return false;
  let ast: Ast;
  try {
    ast = vertex.getFormula(dg.lazilyTransformingAstService);
  } catch {
    return false;
  }
  // Generic AST walk (child field names differ per node kind): any FUNCTION_CALL
  // node whose canonical name is SUBTOTAL/AGGREGATE marks the cell nested.
  // The procedureName is canonical English regardless of formula locale.
  const seen = new Set<unknown>();
  const stack: unknown[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    if (rec['type'] === 'FUNCTION_CALL') {
      const name = String(rec['procedureName'] ?? '').toUpperCase();
      if (NESTED_AGGREGATORS.has(name)) return true;
    }
    for (const v of Object.values(rec)) {
      if (Array.isArray(v)) {
        for (const e of v) stack.push(e);
      } else if (v !== null && typeof v === 'object') {
        stack.push(v);
      }
    }
  }
  return false;
}

interface SubtotalInput {
  value: InterpreterValue;
  /**
   * False for direct scalar arguments. Excel coerces text/booleans passed
   * directly (SUM(TRUE)=1, SUBTOTAL(9,"x")=#VALUE!) but ignores text and
   * logicals inside ranges for the numeric aggregations.
   */
  fromRange: boolean;
}

function subtotalVariance(xs: number[], sample: boolean): number {
  const n = xs.length;
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= n;
  let s = 0;
  for (const x of xs) {
    const d = x - mean;
    s += d * d;
  }
  return s / (sample ? n - 1 : n);
}

/** Excel-faithful aggregation over the non-nested inputs. */
function aggregateSubtotal(fn: number, inputs: SubtotalInput[]): InterpreterValue {
  const numbers: number[] = [];
  let countA = 0;
  for (const { value, fromRange } of inputs) {
    if (value instanceof CellError) return value; // Excel propagates errors
    if (value === EmptyValue) continue;
    if (typeof value === 'number') {
      numbers.push(value);
      countA++;
    } else if (typeof value === 'boolean') {
      countA++;
      if (!fromRange) numbers.push(value ? 1 : 0);
    } else if (typeof value === 'string') {
      if (fn === 3 || fn === 103) {
        countA++;
      } else if (!fromRange) {
        return new CellError(ErrorType.VALUE, 'SUBTOTAL: text in direct argument.');
      }
      // Text inside ranges is ignored by the numeric aggregations.
    }
  }
  const div0 = (): CellError =>
    new CellError(ErrorType.DIV_BY_ZERO, 'SUBTOTAL: division by zero.');
  switch (fn) {
    case 1:
    case 101: {
      if (numbers.length === 0) return div0();
      let s = 0;
      for (const n of numbers) s += n;
      return s / numbers.length;
    }
    case 2:
    case 102:
      return numbers.length;
    case 3:
    case 103:
      return countA;
    case 4:
    case 104: {
      if (numbers.length === 0) return 0;
      let m = numbers[0]!;
      for (const n of numbers) if (n > m) m = n;
      return m;
    }
    case 5:
    case 105: {
      if (numbers.length === 0) return 0;
      let m = numbers[0]!;
      for (const n of numbers) if (n < m) m = n;
      return m;
    }
    case 6:
    case 106: {
      let p = 1;
      for (const n of numbers) p *= n;
      return p;
    }
    case 7:
    case 107:
      if (numbers.length < 2) return div0();
      return Math.sqrt(subtotalVariance(numbers, true));
    case 8:
    case 108:
      if (numbers.length < 1) return div0();
      return Math.sqrt(subtotalVariance(numbers, false));
    case 9:
    case 109: {
      let s = 0;
      for (const n of numbers) s += n;
      return s;
    }
    case 10:
    case 110:
      if (numbers.length < 2) return div0();
      return subtotalVariance(numbers, true);
    case 11:
    case 111:
      if (numbers.length < 1) return div0();
      return subtotalVariance(numbers, false);
    default:
      return new CellError(ErrorType.VALUE, 'SUBTOTAL: invalid function number.');
  }
}

export class SubtotalOverridePlugin extends (OrigSubtotalPlugin as unknown as new (
  interpreter: Interpreter,
) => FunctionPlugin) {
  public static implementedFunctions: ImplementedFunctions = {
    SUBTOTAL: OrigSubtotalPlugin.implementedFunctions['SUBTOTAL']!,
  };
  /**
   * Shadow the base plugin's aliases (VAR, STDEV, ...): those ids stay
   * registered on the original NumericAggregationPlugin; only SUBTOTAL
   * moves to this class.
   */
  public static aliases: Record<string, string> = {};

  public subtotal(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    if (ast.args.length < 2) {
      return new CellError(ErrorType.NA, 'SUBTOTAL: wrong number of arguments.');
    }
    const fnValue = this.coerceToType(
      this.evaluateAst(ast.args[0]!, state),
      { argumentType: FunctionArgumentType.NUMBER },
      state,
    );
    if (typeof fnValue !== 'number' || !SUBTOTAL_FUNCTIONS.has(fnValue)) {
      // Mirrors the built-in: anything that is not a valid function number
      // falls through its switch to #VALUE!.
      return new CellError(ErrorType.VALUE, 'SUBTOTAL: invalid function number.');
    }
    if (!this.subtotalHasNested(ast, state)) {
      return origSubtotalMethod.call(this, ast, state);
    }
    const inputs = this.collectSubtotalInputs(ast, state);
    if (inputs === undefined) {
      return new CellError(ErrorType.REF, 'SUBTOTAL: range spans multiple sheets.');
    }
    return aggregateSubtotal(fnValue, inputs);
  }

  /** True when any range/reference argument contains a nested SUBTOTAL/AGGREGATE cell. */
  private subtotalHasNested(ast: ProcedureAst, state: InterpreterState): boolean {
    const dg = this.interpreter.dependencyGraph;
    const base = state.formulaAddress;
    for (let i = 1; i < ast.args.length; i++) {
      const arg = ast.args[i] as unknown as LooseAst;
      if (arg.type === 'CELL_REFERENCE' && arg.reference) {
        if (
          cellFormulaHasNestedAggregator(dg, arg.reference.toSimpleCellAddress(base))
        ) {
          return true;
        }
      } else if (
        arg.type === 'CELL_RANGE' ||
        arg.type === 'COLUMN_RANGE' ||
        arg.type === 'ROW_RANGE'
      ) {
        let range: AbsoluteCellRange;
        try {
          range = AbsoluteCellRange.fromAst(
            ast.args[i] as unknown as CellRangeAst | ColumnRangeAst | RowRangeAst,
            base,
          );
        } catch {
          continue; // exotic range: handled (as #REF!) by the manual path
        }
        for (const addr of range.addresses(dg)) {
          if (cellFormulaHasNestedAggregator(dg, addr)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Collect per-cell values for the manual (nested) path, skipping nested
   * SUBTOTAL/AGGREGATE cells. Returns undefined for multi-sheet ranges
   * (mirrors the built-in #REF!).
   */
  private collectSubtotalInputs(
    ast: ProcedureAst,
    state: InterpreterState,
  ): SubtotalInput[] | undefined {
    const dg = this.interpreter.dependencyGraph;
    const base = state.formulaAddress;
    const out: SubtotalInput[] = [];
    for (let i = 1; i < ast.args.length; i++) {
      const arg = ast.args[i] as unknown as LooseAst;
      if (arg.type === 'CELL_REFERENCE' && arg.reference) {
        const addr = arg.reference.toSimpleCellAddress(base);
        if (cellFormulaHasNestedAggregator(dg, addr)) continue;
        out.push({ value: dg.getScalarValue(addr), fromRange: true });
      } else if (
        arg.type === 'CELL_RANGE' ||
        arg.type === 'COLUMN_RANGE' ||
        arg.type === 'ROW_RANGE'
      ) {
        let range: AbsoluteCellRange;
        try {
          range = AbsoluteCellRange.fromAst(
            ast.args[i] as unknown as CellRangeAst | ColumnRangeAst | RowRangeAst,
            base,
          );
        } catch {
          return undefined;
        }
        for (const addr of range.addresses(dg)) {
          if (cellFormulaHasNestedAggregator(dg, addr)) continue;
          out.push({ value: dg.getScalarValue(addr), fromRange: true });
        }
      } else {
        const v = this.evaluateAst(ast.args[i]!, state);
        if (v instanceof SimpleRangeValue) {
          const corner: SimpleCellAddress = { sheet: base.sheet, col: 0, row: 0 };
          for (const [sv] of v.entriesFromTopLeftCorner(corner)) {
            out.push({ value: sv, fromRange: true });
          }
        } else {
          out.push({ value: v, fromRange: false });
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// AND / OR / XOR: Excel ignores empty cells and text inside ranges
// ---------------------------------------------------------------------------

/**
 * Root cause (Cycle-3 formula audit, R2): HyperFormula's
 * coerceScalarToBoolean maps EmptyValue → false, so `=AND(A1:A4)` with
 * A1=TRUE and A2:A4 empty returned FALSE while Excel returns TRUE.
 *
 * Excel semantics implemented here:
 * - Empty cells (and text) inside range/reference arguments are ignored.
 * - Booleans count as-is; numbers count (0 → false, nonzero → true).
 * - Text passed as a direct scalar argument → #VALUE! (Excel rule).
 * - Errors propagate (first error in argument order wins).
 * - No arguments → #VALUE!; a range of all empties → AND=TRUE, OR=FALSE,
 *   XOR=FALSE.
 *
 * NOT is intentionally left on the built-in: its single-argument BOOLEAN
 * coercion already matches Excel (empty → FALSE → NOT=TRUE; text →
 * #VALUE!).
 */
const OrigBooleanPlugin = HyperFormula.getFunctionPlugin('AND') as unknown as {
  new (...args: never[]): FunctionPlugin;
  implementedFunctions: ImplementedFunctions;
};

interface LogicalInput {
  value: InterpreterValue;
  /**
   * False for direct scalar arguments. Excel ignores text/empties inside
   * ranges but #VALUE!s on text passed directly.
   */
  fromRange: boolean;
}

/**
 * Excel truthiness of one logical input. Returns undefined for inputs Excel
 * ignores (empty cells, text inside ranges), a CellError for inputs Excel
 * propagates (errors, direct text), otherwise the boolean value.
 */
function logicalTruthiness(
  value: InterpreterValue,
  fromRange: boolean,
): boolean | undefined | CellError {
  if (value instanceof CellError) return value;
  if (value === EmptyValue || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const raw = getRawValue(value);
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    if (fromRange) return undefined; // Excel ignores text inside ranges
    return new CellError(ErrorType.VALUE, 'AND/OR/XOR: text in direct argument.');
  }
  return undefined;
}

export class LogicalOverridePlugin extends (OrigBooleanPlugin as unknown as new (
  interpreter: Interpreter,
) => FunctionPlugin) {
  public static implementedFunctions: ImplementedFunctions = {
    AND: OrigBooleanPlugin.implementedFunctions['AND']!,
    OR: OrigBooleanPlugin.implementedFunctions['OR']!,
    XOR: OrigBooleanPlugin.implementedFunctions['XOR']!,
  };
  /**
   * Shadow the base plugin's aliases (none today): those ids stay
   * registered on the original BooleanPlugin; only AND/OR/XOR move to
   * this class.
   */
  public static aliases: Record<string, string> = {};

  /** Collect per-cell values, tracking range-vs-scalar provenance. */
  private collectLogicalInputs(
    ast: ProcedureAst,
    state: InterpreterState,
  ): LogicalInput[] | undefined {
    const dg = this.interpreter.dependencyGraph;
    const base = state.formulaAddress;
    const out: LogicalInput[] = [];
    for (let i = 0; i < ast.args.length; i++) {
      const arg = ast.args[i] as unknown as LooseAst;
      if (arg.type === 'CELL_REFERENCE' && arg.reference) {
        const addr = arg.reference.toSimpleCellAddress(base);
        out.push({ value: dg.getScalarValue(addr), fromRange: true });
      } else if (
        arg.type === 'CELL_RANGE' ||
        arg.type === 'COLUMN_RANGE' ||
        arg.type === 'ROW_RANGE'
      ) {
        let range: AbsoluteCellRange;
        try {
          range = AbsoluteCellRange.fromAst(
            ast.args[i] as unknown as CellRangeAst | ColumnRangeAst | RowRangeAst,
            base,
          );
        } catch {
          return undefined;
        }
        for (const addr of range.addresses(dg)) {
          out.push({ value: dg.getScalarValue(addr), fromRange: true });
        }
      } else {
        const v = this.evaluateAst(ast.args[i]!, state);
        if (v instanceof SimpleRangeValue) {
          const corner: SimpleCellAddress = { sheet: base.sheet, col: 0, row: 0 };
          for (const [sv] of v.entriesFromTopLeftCorner(corner)) {
            out.push({ value: sv, fromRange: false });
          }
        } else {
          out.push({ value: v, fromRange: false });
        }
      }
    }
    return out;
  }

  private logicalInputsOrError(
    ast: ProcedureAst,
    state: InterpreterState,
    fn: string,
  ): LogicalInput[] | CellError {
    if (ast.args.length === 0) {
      return new CellError(ErrorType.VALUE, `${fn}: wrong number of arguments.`);
    }
    const inputs = this.collectLogicalInputs(ast, state);
    if (inputs === undefined) {
      return new CellError(ErrorType.REF, `${fn}: range spans multiple sheets.`);
    }
    return inputs;
  }

  public and(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const inputs = this.logicalInputsOrError(ast, state, 'AND');
    if (inputs instanceof CellError) return inputs;
    // Excel propagates errors even when the outcome is already decided
    // (OR(TRUE,#DIV/0!) → #DIV/0!), so scan for errors before short-circuiting.
    for (const { value } of inputs) {
      if (value instanceof CellError) return value;
    }
    for (const { value, fromRange } of inputs) {
      const t = logicalTruthiness(value, fromRange);
      if (t instanceof CellError) return t;
      if (t === undefined) continue;
      if (!t) return false;
    }
    return true;
  }

  public or(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const inputs = this.logicalInputsOrError(ast, state, 'OR');
    if (inputs instanceof CellError) return inputs;
    for (const { value } of inputs) {
      if (value instanceof CellError) return value;
    }
    for (const { value, fromRange } of inputs) {
      const t = logicalTruthiness(value, fromRange);
      if (t instanceof CellError) return t;
      if (t === undefined) continue;
      if (t) return true;
    }
    return false;
  }

  public xor(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const inputs = this.logicalInputsOrError(ast, state, 'XOR');
    if (inputs instanceof CellError) return inputs;
    for (const { value } of inputs) {
      if (value instanceof CellError) return value;
    }
    let count = 0;
    for (const { value, fromRange } of inputs) {
      const t = logicalTruthiness(value, fromRange);
      if (t instanceof CellError) return t;
      if (t === undefined) continue;
      if (t) count++;
    }
    return count % 2 === 1;
  }
}

// ---------------------------------------------------------------------------
// ROUND / ROUNDUP / ROUNDDOWN: correctly-rounded decimal rounding
// ---------------------------------------------------------------------------

/**
 * Root cause (Cycle-8 formula audit): HyperFormula's RoundingPlugin computes
 * ROUND via Math.round(x * 10^n) / 10^n. The ×10^n scaling is not exact in
 * binary floating point, so values near a rounding boundary round the wrong
 * way: ROUND(939.0138241923366,12) returned 939.01382419233698 instead of
 * 939.013824192337, and ROUND(939.0138241923374,12) returned
 * 939.01382419233801 instead of 939.013824192337 — flipping
 * ROUND(a,12)=ROUND(b,12) comparisons vs Excel (3 audit mismatches in
 * closedxml-xlsx-functions-excel-2010.xlsx: D6, D28, and E2 via D2/B2/L44).
 *
 * Excel rounds the decimal representation half away from zero. This override
 * extracts the EXACT decimal expansion of the double (BigInt over the
 * IEEE-754 bits — no floating-point error anywhere in the computation) and
 * rounds the digit string at the requested position: half away from zero
 * (ROUND), away from zero (ROUNDUP), toward zero (ROUNDDOWN).
 */
function exactDecimalParts(x: number): { digits: string; point: number } {
  // Value = 0.digits × 10^point, digits has no leading zeros (x ≠ 0).
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (expBits === 0) {
    e = -1074; // subnormal: value = mant × 2^-1074
  } else {
    mant |= 1n << 52n;
    e = expBits - 1075; // value = mant × 2^e
  }
  if (e >= 0) {
    const digits = (mant << BigInt(e)).toString();
    return { digits, point: digits.length };
  }
  // x = mant × 5^-e × 10^e
  const digits = (mant * 5n ** BigInt(-e)).toString();
  return { digits, point: digits.length + e };
}

type DecimalRoundMode = 'halfAway' | 'away' | 'toward';

/**
 * Round x to `digits` decimal places (negative digits round left of the
 * point, as in Excel). Returns a CellError only on overflow to Infinity.
 */
function decimalRound(
  x: number,
  digits: number,
  mode: DecimalRoundMode,
): number | CellError {
  if (x === 0 || !Number.isFinite(x)) return x;
  const d = Math.trunc(Number(digits));
  if (!Number.isFinite(d)) return new CellError(ErrorType.VALUE, 'ROUND: invalid digits.');
  const neg = x < 0;
  const { digits: dig, point } = exactDecimalParts(neg ? -x : x);
  // Rounding to d decimals keeps the integer K = round(value × 10^d);
  // result = K × 10^-d. The digit cut falls after dig[point + d).
  const cut = point + d;
  if (cut >= dig.length) return x; // nothing would be dropped
  let kept: string;
  let roundUp: boolean;
  if (cut <= 0) {
    kept = '0';
    const dropped = dig;
    // cut < 0: value × 10^d = 0.digits × 10^cut < 0.1 < 0.5, so half-away
    // never rounds up; only cut == 0 puts a digit adjacent to the cut.
    roundUp =
      mode === 'toward' ? false : mode === 'away' ? /[1-9]/.test(dropped) : cut === 0 && dropped[0]! >= '5';
  } else {
    kept = dig.slice(0, cut);
    const dropped = dig.slice(cut);
    roundUp =
      mode === 'toward'
        ? false
        : mode === 'away'
          ? /[1-9]/.test(dropped)
          : dropped[0]! >= '5'; // exact expansion: '5…' is always ≥ half
  }
  if (roundUp) kept = (BigInt(kept) + 1n).toString();
  const v = parseFloat(kept + 'e' + String(-d));
  if (!Number.isFinite(v)) {
    return new CellError(ErrorType.NUM, 'ROUND: result overflow.');
  }
  return neg ? -v : v;
}

const OrigRoundingPlugin = HyperFormula.getFunctionPlugin('ROUND') as unknown as {
  new (...args: never[]): FunctionPlugin;
  implementedFunctions: ImplementedFunctions;
};

/**
 * Standalone (does NOT extend the built-in RoundingPlugin): HyperFormula's
 * plugin initializer reuses the first-created instance for every
 * instanceof-matching class, and ROUND/ROUNDUP/ROUNDDOWN sort before their
 * siblings (INT, EVEN, CEILING.*, …) in the built-in registration order —
 * so an extending subclass instance would also serve the untouched
 * siblings, whose inherited methods call this.metadata('CEILING.PRECISE')
 * and throw. A standalone FunctionPlugin subclass has no instanceof
 * relationship with RoundingPlugin, so the siblings keep their own
 * instance and the override is strictly scoped to the three functions.
 */
export class RoundingOverridePlugin extends FunctionPlugin {
  public static implementedFunctions: ImplementedFunctions = {
    ROUND: OrigRoundingPlugin.implementedFunctions['ROUND']!,
    ROUNDUP: OrigRoundingPlugin.implementedFunctions['ROUNDUP']!,
    ROUNDDOWN: OrigRoundingPlugin.implementedFunctions['ROUNDDOWN']!,
  };
  public static aliases: Record<string, string> = {};

  public round(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('ROUND'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [nArg, pArg] = args;
        if (nArg instanceof CellError) return nArg;
        if (pArg instanceof CellError) return pArg;
        return decimalRound(Number(nArg), Number(pArg ?? 0), 'halfAway');
      },
    );
  }

  public roundup(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('ROUNDUP'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [nArg, pArg] = args;
        if (nArg instanceof CellError) return nArg;
        if (pArg instanceof CellError) return pArg;
        return decimalRound(Number(nArg), Number(pArg ?? 0), 'away');
      },
    );
  }

  public rounddown(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('ROUNDDOWN'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [nArg, pArg] = args;
        if (nArg instanceof CellError) return nArg;
        if (pArg instanceof CellError) return pArg;
        return decimalRound(Number(nArg), Number(pArg ?? 0), 'toward');
      },
    );
  }
}

/**
 * CEILING.MATH only (D21): HyperFormula's RoundingPlugin flips the
 * negative-number direction only when mode === 1 exactly, so any other
 * nonzero mode (-1, 2, …) wrongly rounds toward zero. Standalone, like
 * RoundingOverridePlugin above: extending RoundingPlugin would drag the
 * untouched siblings (CEILING, CEILING.PRECISE, FLOOR.*, …) onto this
 * instance — they stay on the built-in. Metadata (method `ceilingmath`,
 * significance defaultValue 1, mode defaultValue 0) is copied verbatim
 * from the original plugin class.
 */
export class CeilingMathOverridePlugin extends FunctionPlugin {
  // Literal metadata (identical to RoundingPlugin's, verified at
  // runtime) — capturing it from OrigRoundingPlugin breaks if this
  // module is evaluated twice in one process (the second evaluation
  // resolves 'ROUND' to RoundingOverridePlugin, which does not declare
  // CEILING.MATH). See IntModOverridePlugin.
  public static implementedFunctions: ImplementedFunctions = {
    'CEILING.MATH': {
      method: 'ceilingmath',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER, defaultValue: 1 },
        { argumentType: FunctionArgumentType.NUMBER, defaultValue: 0 },
      ],
    },
  };
  public static aliases: Record<string, string> = {};

  public ceilingmath(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CEILING.MATH'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [numArg, sigArg, modeArg] = args;
        if (numArg instanceof CellError) return numArg;
        if (sigArg instanceof CellError) return sigArg;
        if (modeArg instanceof CellError) return modeArg;
        const number = Number(numArg === EmptyValue ? 0 : numArg);
        const significance = sigArg === undefined || sigArg === EmptyValue ? 1 : Number(sigArg);
        const mode = modeArg === undefined || modeArg === EmptyValue ? 0 : Number(modeArg);
        if (![number, significance, mode].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'CEILING.MATH: non-numeric argument.');
        }
        return ceilingMath(number, significance, mode);
      },
    );
  }
}

// ---------------------------------------------------------------------------
// TEXT: Excel's % / ‰ format specifiers scale the value
// ---------------------------------------------------------------------------

/**
 * Root cause (Cycle-3 formula audit, R3): HyperFormula's number formatter
 * appends `%` as literal text without the ×100 scaling Excel's `%` format
 * specifier requires, so TEXT(0.0689,"0.0%") gave "0.1%" instead of "6.9%".
 *
 * Excel scales the value ×100 per `%` (×1000 per `‰`, per-mille) found in
 * the applicable format section, before formatting. Quoted literals ("…")
 * and backslash escapes are literal text and do not scale; in a 4-section
 * format (positive;negative;zero;text) the text section's `%` is literal.
 */
function percentScaleFactor(value: number, formatArg: string): number {
  // Strip quoted literals and backslash escapes.
  let stripped = '';
  let inQuote = false;
  for (let i = 0; i < formatArg.length; i++) {
    const ch = formatArg[i]!;
    if (ch === '\\' && i + 1 < formatArg.length) {
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote) stripped += ch;
  }
  const sections = stripped.split(';');
  const numericSections = sections.length >= 4 ? sections.slice(0, 3) : sections;
  const idx = value > 0 ? 0 : value < 0 ? 1 : 2;
  const section = numericSections[Math.min(idx, numericSections.length - 1)] ?? '';
  let factor = 1;
  for (const ch of section) {
    if (ch === '%') factor *= 100;
    else if (ch === '‰') factor *= 1000;
  }
  return factor;
}

const OrigDateTimePlugin = HyperFormula.getFunctionPlugin('TEXT') as unknown as {
  new (...args: never[]): FunctionPlugin;
  implementedFunctions: ImplementedFunctions;
};

export class TextOverridePlugin extends (OrigDateTimePlugin as unknown as new (
  interpreter: Interpreter,
) => FunctionPlugin) {
  public static implementedFunctions: ImplementedFunctions = {
    TEXT: OrigDateTimePlugin.implementedFunctions['TEXT']!,
  };
  /**
   * Shadow the base plugin's aliases (none today): those ids stay
   * registered on the original DateTimePlugin; only TEXT moves to this
   * class.
   */
  public static aliases: Record<string, string> = {};

  public text(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('TEXT'),
      (numberRepresentation, formatArg) => {
        const scaled =
          typeof numberRepresentation === 'number'
            ? numberRepresentation * percentScaleFactor(numberRepresentation, formatArg)
            : numberRepresentation;
        return hfFormat(scaled, formatArg, this.config, this.dateTimeHelper);
      },
    );
  }
}

// ---------------------------------------------------------------------------
// High-precision gamma / binomial / F / chi-square core
// (Cycle 5, Phase 2 — replaces jstat's ~1e-9 paths)
//
// Root causes found in HyperFormula's bundled jstat
// (node_modules/hyperformula/commonjs/interpreter/plugin/3rdparty/jstat/jstat.js):
// - binomial.cdf rounds its result to 1e-10 on purpose
//   (`Math.round((1-betacdf)/eps)*eps`, eps=1e-10) → BINOM.DIST cumulative
//   was 8,775,521 ulp off scipy.
// - ibetainv runs Newton at EPS=1e-8 with at most 10 iterations → F.INV.RT
//   was 2,384,951 ulp off.
// - right tails computed as `1 - cdf` → catastrophic cancellation near 1:
//   CHISQ.TEST was 12,575,635 ulp off, F.TEST 91,903 ulp off.
//
// Replacements below evaluate the regularized incomplete beta/gamma
// functions directly (continued fraction at 3e-14/1e-15 tolerance, no
// rounding, no 1-… cancellation), matching scipy/Excel to ~10 ulp.
// ---------------------------------------------------------------------------

/**
 * Exact 1/Γ(a) (≤4 ulp) for integer or half-integer a with a ≤ 171/61.5,
 * via BigInt factorials — no log-gamma cancellation. Returns undefined
 * otherwise (caller falls back to exp(−gammaLn(a))).
 * Covers every chi-square df (a = df/2) encountered in practice.
 */
function invGammaHalfInteger(a: number): number | undefined {
  const n2 = 2 * a;
  if (!Number.isInteger(n2) || n2 < 1) return undefined;
  if (n2 % 2 === 0) {
    const m = n2 / 2; // a = m, a positive integer: 1/Γ(m) = 1/(m−1)!
    if (m > 171) return undefined;
    let f = 1n;
    for (let i = 2n; i <= BigInt(m - 1); i++) f *= i;
    return 1 / Number(f);
  }
  const m = (n2 - 1) / 2; // a = m + 1/2: 1/Γ(m+½) = 4^m·m!/((2m)!·√π)
  if (m > 30) return undefined;
  let num = 1n;
  let den = 1n;
  for (let i = 1; i <= m; i++) {
    num *= BigInt(4 * i);
    den *= BigInt((2 * i - 1) * (2 * i));
  }
  return Number(num) / Number(den) / Math.sqrt(Math.PI);
}

/**
 * The incomplete-gamma front factor x^a·e^{−x}/Γ(a) to ~few ulp.
 * Uses the exact 1/Γ(a) when a is integer/half-integer (no log-domain
 * error); otherwise the log-domain form.
 */
function gammaFactor(a: number, x: number): number {
  const invG = invGammaHalfInteger(a);
  if (invG !== undefined) {
    return Math.pow(x, a) * Math.exp(-x) * invG;
  }
  return Math.exp(-x + a * Math.log(x) - gammaLn(a));
}

/**
 * Regularized lower incomplete gamma P(a, x) = γ(a,x)/Γ(a), a > 0, x ≥ 0.
 * Series expansion for x < a+1, continued fraction otherwise
 * (Numerical Recipes gser/gcf). Accurate to ~1e-14.
 */
export function gammaP(a: number, x: number): number {
  if (!(a > 0)) return NaN;
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n <= 1000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return sum * gammaFactor(a, x);
  }
  return 1 - gammaQ(a, x);
}

/**
 * Regularized upper incomplete gamma Q(a, x) = Γ(a,x)/Γ(a), a > 0, x ≥ 0.
 * Computed directly (no 1-P cancellation): continued fraction for
 * x ≥ a+1, complement of the series below that.
 */
export function gammaQ(a: number, x: number): number {
  if (!(a > 0)) return NaN;
  if (x <= 0) return 1;
  if (x < a + 1) {
    return 1 - gammaP(a, x);
  }
  const FPMIN = 1e-300;
  const EPS = 1e-15;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    const cd = c * d;
    h *= cd;
    if (Math.abs(cd - 1) < EPS) break;
  }
  return gammaFactor(a, x) * h;
}

/** Inverse of P(a, ·) for 0 < p ≤ ½: bisection on the series side (x < a+1 there, so no 1−Q subtraction inside the loop). */
function gammaPInvSmall(p: number, a: number): number {
  let lo = 0;
  let hi = Math.max(1, a);
  while (gammaP(a, hi) < p) {
    lo = hi;
    hi *= 2;
    if (!Number.isFinite(hi)) return Infinity;
  }
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (gammaP(a, mid) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Inverse of Q(a, ·) for 0 < q ≤ ½: bisection on the CF side. */
function gammaQInvSmall(q: number, a: number): number {
  let lo = 0;
  let hi = Math.max(1, a);
  while (gammaQ(a, hi) > q) {
    lo = hi;
    hi *= 2;
    if (!Number.isFinite(hi)) return Infinity;
  }
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (gammaQ(a, mid) > q) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Inverse of P(a, ·): the x with gammaP(a, x) = p. Always inverts the
 * smaller tail (P for p ≤ ½, Q for p > ½): bisecting Q near 1 cannot
 * resolve x — doubles near 1 are 2^-52 apart while the root needs the
 * 1−p tail (measured 823 ulp on CHISQ.INV.RT(0.999,1) before the split).
 */
export function gammaPInv(p: number, a: number): number {
  if (!(a > 0)) return NaN;
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  return p <= 0.5 ? gammaPInvSmall(p, a) : gammaQInvSmall(1 - p, a);
}

/**
 * Inverse of Q(a, ·): the x with gammaQ(a, x) = p. Same small-tail
 * discipline as gammaPInv.
 */
export function gammaQInv(p: number, a: number): number {
  if (!(a > 0)) return NaN;
  if (p <= 0) return Infinity;
  if (p >= 1) return 0;
  return p <= 0.5 ? gammaQInvSmall(p, a) : gammaPInvSmall(1 - p, a);
}

/**
 * Binomial CDF P(X ≤ k) for X ~ Binomial(n, p), k integer.
 * Via the regularized-incomplete-beta identity P(X ≤ k) = I_{1-p}(n-k, k+1),
 * evaluated on the side that avoids the 1-… cancellation jstat's rounding
 * made necessary. (jstat's `Math.round(·/1e-10)*1e-10` is the 8.7M-ulp
 * BINOM.DIST error.)
 */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (!(p >= 0) || !(p <= 1) || !(n > 0)) return NaN;
  // For small k, direct summation of the binomial PMF is more accurate than
  // the incomplete-beta continued fraction (which amplifies error for
  // extreme parameters). Sum smallest terms first for accuracy.
  if (k <= 10) {
    const q = 1 - p;
    let sum = 0;
    for (let i = k; i >= 0; i--) {
      const c = chooseExact(n, i);
      if (!Number.isNaN(c)) {
        sum += c * Math.pow(p, i) * Math.pow(q, n - i);
      } else {
        // chooseExact failed (huge n); fall back to beta.
        return betaRegularized(1 - p, n - k, k + 1);
      }
    }
    return sum;
  }
  return betaRegularized(1 - p, n - k, k + 1);
}

/**
 * Binomial PMF P(X = k), evaluated in the log domain via ln Γ so it stays
 * accurate (and finite) where jstat's factorial-based combination overflows
 * or rounds. Edge semantics match jstat/Excel.
 */
export function binomialPdf(k: number, n: number, p: number): number {
  if (p === 0 || p === 1) return n * p === k ? 1 : 0;
  if (k < 0 || k > n || !(n > 0)) return 0;
  const q = 1 - p;
  const c = chooseExact(n, k);
  if (!Number.isNaN(c)) {
    // Exact binomial coefficient (~5 ulp total, no log-domain error).
    // Grouped as C·(pq)^min·(rest) so the powers stay representable:
    // C·p^k·q^m would underflow intermediately e.g. for (166,500,0.9).
    const m = n - k;
    let term: number;
    if (k <= m) {
      term = (c * Math.pow(p * q, k)) * Math.pow(q, m - k);
    } else {
      term = (c * Math.pow(p * q, m)) * Math.pow(p, k - m);
    }
    if (term > 0 && Number.isFinite(term)) return term;
    // Intermediate underflow with a representable true value (rare):
    // fall through to the log domain.
  }
  const lchoose =
    Number.isInteger(k) && Number.isInteger(n)
      ? lnChoose(n, k)
      : gammaLn(n + 1) - gammaLn(k + 1) - gammaLn(n - k + 1);
  return Math.exp(lchoose + k * Math.log(p) + (n - k) * Math.log(q));
}

/** Left-tailed F CDF P(F(d1,d2) ≤ x). */
export function fDistCdf(x: number, d1: number, d2: number): number {
  if (x <= 0) return 0;
  return betaRegularized((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2);
}

/** F density, log-domain (R's df.c formulation). Edge cases match jstat. */
export function fDistPdf(x: number, d1: number, d2: number): number {
  if (x < 0) return 0;
  if (x === 0) {
    if (d1 < 2) return Infinity;
    if (d1 === 2) return 1;
    return 0;
  }
  const lb = lbeta(d1 / 2, d2 / 2);
  const r = d1 / d2;
  return Math.exp(
    -lb +
      (d1 / 2) * Math.log(r) +
      (d1 / 2 - 1) * Math.log(x) -
      ((d1 + d2) / 2) * Math.log(1 + r * x),
  );
}

/**
 * Inverse left-tailed F CDF. Inverts on whichever side keeps the working
 * variable small: x = I⁻¹_p(d1/2, d2/2) for p ≤ ½, else u = I⁻¹_{1−p}(d2/2,
 * d1/2). Computing 1−x (or 1−u) from a bisection result near 1 would lose
 * ~11 digits to cancellation (measured 222,983 ulp at F.INV(0.999,1,1)
 * before the split) — the small-side formulation has no such subtraction.
 */
export function fInv(p: number, d1: number, d2: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  if (p <= 0.5) {
    const x = betaRegularizedInv(p, d1 / 2, d2 / 2);
    return (d2 / d1) * (x / (1 - x));
  }
  const u = betaRegularizedInv(1 - p, d2 / 2, d1 / 2);
  return (d2 / d1) * ((1 - u) / u);
}

/**
 * Inverse right-tailed F CDF. Same small-side discipline as fInv:
 * for p ≤ ½ invert I_u(d2/2, d1/2) = p with u small; for p > ½ invert the
 * left tail 1−p with x small. Never forms 1−p for p near 1 in the working
 * variable (jstat's centralF.inv(1−p) did, on top of its EPS=1e-8 Newton).
 */
export function fInvRt(p: number, d1: number, d2: number): number {
  if (p <= 0) return Infinity;
  if (p >= 1) return 0;
  if (p <= 0.5) {
    const u = betaRegularizedInv(p, d2 / 2, d1 / 2);
    return (d2 / d1) * ((1 - u) / u);
  }
  const x = betaRegularizedInv(1 - p, d1 / 2, d2 / 2);
  return (d2 / d1) * (x / (1 - x));
}

/** Left-tailed chi-square CDF. */
export function chiSquareCdf(x: number, df: number): number {
  return gammaP(df / 2, x / 2);
}

/** Right-tailed chi-square CDF, computed directly (no 1-cdf cancellation). */
export function chiSquareCdfRt(x: number, df: number): number {
  return gammaQ(df / 2, x / 2);
}

/** Chi-square density, log-domain (same formula as jstat, kept exact). */
export function chiSquarePdf(x: number, df: number): number {
  if (x < 0) return 0;
  if (x === 0) {
    if (df < 2) return Infinity;
    if (df === 2) return 0.5;
    return 0;
  }
  const a = df / 2;
  return Math.exp((a - 1) * Math.log(x) - x / 2 - a * Math.log(2) - gammaLn(a));
}

/** Inverse left-tailed chi-square CDF. */
export function chiSquareInv(p: number, df: number): number {
  return 2 * gammaPInv(p, df / 2);
}

/** Inverse right-tailed chi-square CDF. */
export function chiSquareInvRt(p: number, df: number): number {
  return 2 * gammaQInv(p, df / 2);
}

/** Sample variance with jstat's exact summation order (backward loop). */
function varianceSample(xs: number[]): number {
  let sum = 0;
  let i = xs.length;
  while (--i >= 0) sum += xs[i]!;
  const mean = sum / xs.length;
  let s = 0;
  i = xs.length;
  while (--i >= 0) {
    const d = xs[i]! - mean;
    s += d * d;
  }
  return s / (xs.length - 1);
}

/**
 * Two-tailed F-test p-value 2·min(P(F ≤ r), P(F > r)). Whichever tail is
 * smaller is evaluated directly through the beta core — no 1-v
 * cancellation (jstat's `2*min(v, 1-v)` on the rounded cdf was 92k ulp off).
 */
export function fTestTwoTailed(r: number, d1: number, d2: number): number {
  const w = (d1 * r) / (d1 * r + d2);
  const left = betaRegularized(w, d1 / 2, d2 / 2);
  if (left <= 0.5) return 2 * left;
  return 2 * betaRegularized(1 - w, d2 / 2, d1 / 2);
}

// ---------------------------------------------------------------------------
// StatisticalPlugin overrides (BINOM.DIST, BINOM.INV, F.*, CHISQ.*)
// ---------------------------------------------------------------------------

const OrigStatisticalPlugin = HyperFormula.getFunctionPlugin('BINOM.DIST') as unknown as {
  new (...args: never[]): FunctionPlugin;
  implementedFunctions: ImplementedFunctions;
};

/**
 * Subclasses HyperFormula's StatisticalPlugin and overrides only the
 * jstat-precision-broken methods. Argument metadata (types, bounds) is
 * inherited verbatim from the original, so coercion and error behavior are
 * unchanged — only the numerics move to the high-precision core above.
 * Aliases (NEGBINOMDIST, TINV, …) stay on the original plugin.
 */
export class StatisticalPrecisionPlugin extends (OrigStatisticalPlugin as unknown as new (
  interpreter: Interpreter,
) => FunctionPlugin) {
  public static implementedFunctions: ImplementedFunctions = {
    'BINOM.DIST': OrigStatisticalPlugin.implementedFunctions['BINOM.DIST']!,
    'BINOM.INV': OrigStatisticalPlugin.implementedFunctions['BINOM.INV']!,
    'F.DIST': OrigStatisticalPlugin.implementedFunctions['F.DIST']!,
    'F.INV': OrigStatisticalPlugin.implementedFunctions['F.INV']!,
    'F.INV.RT': OrigStatisticalPlugin.implementedFunctions['F.INV.RT']!,
    'CHISQ.DIST': OrigStatisticalPlugin.implementedFunctions['CHISQ.DIST']!,
    'CHISQ.DIST.RT': OrigStatisticalPlugin.implementedFunctions['CHISQ.DIST.RT']!,
    'CHISQ.INV': OrigStatisticalPlugin.implementedFunctions['CHISQ.INV']!,
    'CHISQ.INV.RT': OrigStatisticalPlugin.implementedFunctions['CHISQ.INV.RT']!,
  };
  public static aliases: Record<string, string> = {};

  public binomialdist(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('BINOM.DIST'),
      (
        succArg: InterpreterValue,
        trialsArg: InterpreterValue,
        probArg: InterpreterValue,
        cumulativeArg: InterpreterValue,
      ): InterpreterValue => {
        for (const a of [succArg, trialsArg, probArg]) {
          if (a instanceof CellError) return a;
        }
        const succ = Number(succArg);
        const trials = Number(trialsArg);
        const prob = Number(probArg);
        if (succ > trials) {
          return new CellError(ErrorType.NUM, 'BINOM.DIST: number_s > trials.');
        }
        const k = Math.trunc(succ);
        const n = Math.trunc(trials);
        if (cumulativeArg) {
          return binomialCdf(k, n, prob);
        }
        return binomialPdf(k, n, prob);
      });
  }

  public binomialinv(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('BINOM.INV'),
      (
        trialsArg: InterpreterValue,
        probArg: InterpreterValue,
        alphaArg: InterpreterValue,
      ): InterpreterValue => {
        for (const a of [trialsArg, probArg, alphaArg]) {
          if (a instanceof CellError) return a;
        }
        const trials = Math.trunc(Number(trialsArg));
        const prob = Number(probArg);
        const alpha = Number(alphaArg);
        let lower = -1;
        let upper = trials;
        while (upper > lower + 1) {
          const mid = Math.trunc((lower + upper) / 2);
          if (binomialCdf(mid, trials, prob) >= alpha) {
            upper = mid;
          } else {
            lower = mid;
          }
        }
        return upper;
      });
  }

  public fdist(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('F.DIST'),
      (
        xArg: InterpreterValue,
        d1Arg: InterpreterValue,
        d2Arg: InterpreterValue,
        cumulativeArg: InterpreterValue,
      ): InterpreterValue => {
        for (const a of [xArg, d1Arg, d2Arg]) {
          if (a instanceof CellError) return a;
        }
        const x = Number(xArg);
        const d1 = Math.trunc(Number(d1Arg));
        const d2 = Math.trunc(Number(d2Arg));
        if (cumulativeArg) {
          return fDistCdf(x, d1, d2);
        }
        return fDistPdf(x, d1, d2);
      });
  }

  public finv(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('F.INV'),
      (pArg: InterpreterValue, d1Arg: InterpreterValue, d2Arg: InterpreterValue): InterpreterValue => {
        for (const a of [pArg, d1Arg, d2Arg]) {
          if (a instanceof CellError) return a;
        }
        return fInv(Number(pArg), Math.trunc(Number(d1Arg)), Math.trunc(Number(d2Arg)));
      });
  }

  public finvrt(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('F.INV.RT'),
      (pArg: InterpreterValue, d1Arg: InterpreterValue, d2Arg: InterpreterValue): InterpreterValue => {
        for (const a of [pArg, d1Arg, d2Arg]) {
          if (a instanceof CellError) return a;
        }
        return fInvRt(Number(pArg), Math.trunc(Number(d1Arg)), Math.trunc(Number(d2Arg)));
      });
  }

  public chisqdist(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('CHISQ.DIST'),
      (
        xArg: InterpreterValue,
        degArg: InterpreterValue,
        cumulativeArg: InterpreterValue,
      ): InterpreterValue => {
        for (const a of [xArg, degArg]) {
          if (a instanceof CellError) return a;
        }
        const x = Number(xArg);
        const deg = Math.trunc(Number(degArg));
        if (cumulativeArg) {
          return chiSquareCdf(x, deg);
        }
        return chiSquarePdf(x, deg);
      });
  }

  public chisqdistrt(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('CHISQ.DIST.RT'),
      (xArg: InterpreterValue, degArg: InterpreterValue): InterpreterValue => {
        for (const a of [xArg, degArg]) {
          if (a instanceof CellError) return a;
        }
        return chiSquareCdfRt(Number(xArg), Math.trunc(Number(degArg)));
      });
  }

  public chisqinv(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('CHISQ.INV'),
      (pArg: InterpreterValue, degArg: InterpreterValue): InterpreterValue => {
        for (const a of [pArg, degArg]) {
          if (a instanceof CellError) return a;
        }
        return chiSquareInv(Number(pArg), Math.trunc(Number(degArg)));
      });
  }

  public chisqinvrt(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('CHISQ.INV.RT'),
      (pArg: InterpreterValue, degArg: InterpreterValue): InterpreterValue => {
        for (const a of [pArg, degArg]) {
          if (a instanceof CellError) return a;
        }
        return chiSquareInvRt(Number(pArg), Math.trunc(Number(degArg)));
      });
  }
}

// ---------------------------------------------------------------------------
// StatisticalAggregationPlugin overrides (CHISQ.TEST, F.TEST)
// ---------------------------------------------------------------------------

const OrigStatAggPlugin = HyperFormula.getFunctionPlugin('F.TEST') as unknown as {
  new (...args: never[]): FunctionPlugin;
  implementedFunctions: ImplementedFunctions;
};

/**
 * Replicates upstream's module-private parseTwoArrays (not exported):
 * walks both ranges in lockstep, propagates the first error, and keeps
 * only positions where both sides are extended numbers (plain numbers or
 * RichNumber, unwrapped via getRawValue — text, booleans and empties are
 * skipped, exactly like upstream's isExtendedNumber gate).
 */
function parseTwoRanges(
  dataX: SimpleRangeValue,
  dataY: SimpleRangeValue,
): [number[], number[]] | CellError {
  const xit = dataX.iterateValuesFromTopLeftCorner();
  const yit = dataY.iterateValuesFromTopLeftCorner();
  const arrX: number[] = [];
  const arrY: number[] = [];
  for (;;) {
    const x = xit.next();
    const y = yit.next();
    if (x.done || y.done) break;
    const xval = x.value;
    const yval = y.value;
    if (xval instanceof CellError) return xval;
    if (yval instanceof CellError) return yval;
    const rx = getRawValue(xval);
    const ry = getRawValue(yval);
    if (typeof rx === 'number' && typeof ry === 'number') {
      arrX.push(rx);
      arrY.push(ry);
    }
  }
  return [arrX, arrY];
}

export class StatisticalAggPrecisionPlugin extends (OrigStatAggPlugin as unknown as new (
  interpreter: Interpreter,
) => FunctionPlugin) {
  public static implementedFunctions: ImplementedFunctions = {
    'F.TEST': OrigStatAggPlugin.implementedFunctions['F.TEST']!,
    'CHISQ.TEST': OrigStatAggPlugin.implementedFunctions['CHISQ.TEST']!,
  };
  public static aliases: Record<string, string> = {};

  public ftest(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('F.TEST'),
      (dataX: SimpleRangeValue, dataY: SimpleRangeValue): InterpreterValue => {
        const arrX = this.arithmeticHelper.manyToExactNumbers(dataX.valuesFromTopLeftCorner());
        const arrY = this.arithmeticHelper.manyToExactNumbers(dataY.valuesFromTopLeftCorner());
        if (arrX instanceof CellError) return arrX;
        if (arrY instanceof CellError) return arrY;
        if (arrX.length <= 1 || arrY.length <= 1) {
          return new CellError(ErrorType.DIV_BY_ZERO, 'F.TEST: need at least two values.');
        }
        const vx = varianceSample(arrX);
        const vy = varianceSample(arrY);
        if (vx === 0 || vy === 0) {
          return new CellError(ErrorType.DIV_BY_ZERO, 'F.TEST: zero variance.');
        }
        return fTestTwoTailed(vx / vy, arrX.length - 1, arrY.length - 1);
      });
  }

  public chisqtest(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('CHISQ.TEST'),
      (dataX: SimpleRangeValue, dataY: SimpleRangeValue): InterpreterValue => {
        const r = dataX.height();
        const c = dataX.width();
        if (dataY.height() !== r || dataY.width() !== c) {
          return new CellError(ErrorType.NA, 'CHISQ.TEST: ranges must be the same size.');
        }
        const ret = parseTwoRanges(dataX, dataY);
        if (ret instanceof CellError) return ret;
        if (ret[0].length <= 1) {
          return new CellError(ErrorType.DIV_BY_ZERO, 'CHISQ.TEST: need at least two values.');
        }
        let sum = 0;
        for (let i = 0; i < ret[0].length; i++) {
          if (ret[1][i] === 0) {
            return new CellError(ErrorType.DIV_BY_ZERO, 'CHISQ.TEST: expected value is zero.');
          }
          sum += Math.pow(ret[0][i]! - ret[1][i]!, 2) / ret[1][i]!;
        }
        if (sum < 0) {
          return new CellError(ErrorType.NUM, 'CHISQ.TEST: negative statistic.');
        }
        return chiSquareCdfRt(sum, r > 1 && c > 1 ? (r - 1) * (c - 1) : r * c - 1);
      });
  }
}

// ---------------------------------------------------------------------------
// INT / MOD: Excel floor semantics (function-coverage Phase 2)
// ---------------------------------------------------------------------------

/**
 * Standalone (does NOT extend RoundingPlugin / ModuloPlugin): only INT and
 * MOD move to this class; the originals keep serving ROUND's siblings
 * (EVEN/ODD/CEILING/FLOOR/TRUNC — ROUND itself is already overridden above)
 * exactly like the RoundingOverridePlugin split. (INT's method name in
 * HyperFormula is `intFunc`.)
 */
export class IntModOverridePlugin extends FunctionPlugin {
  // Literal metadata (identical to the originals', verified at runtime):
  // capturing OrigRoundingPlugin.implementedFunctions here is fragile —
  // if this module is ever evaluated twice in one process (e.g. src and
  // dist graphs in one test run), the second evaluation resolves
  // getFunctionPlugin('ROUND') to RoundingOverridePlugin, which does not
  // declare INT, and registration throws "not declared in plugin".
  public static implementedFunctions: ImplementedFunctions = {
    INT: {
      method: 'intFunc',
      parameters: [{ argumentType: FunctionArgumentType.NUMBER }],
    },
    MOD: {
      method: 'mod',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
  };
  public static aliases: Record<string, string> = {};

  /** Excel INT: rounds a number down to the nearest integer (toward −∞). */
  public intFunc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('INT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [nArg] = args;
        if (nArg instanceof CellError) return nArg;
        return Math.floor(Number(nArg));
      },
    );
  }

  /** Excel MOD: number − divisor × INT(number / divisor); sign of divisor. */
  public mod(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('MOD'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [nArg, dArg] = args;
        if (nArg instanceof CellError) return nArg;
        if (dArg instanceof CellError) return dArg;
        const n = Number(nArg);
        const d = Number(dArg);
        if (d === 0) {
          return new CellError(ErrorType.DIV_BY_ZERO, 'MOD: divisor is zero.');
        }
        return n - d * Math.floor(n / d);
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Legacy compatibility overrides: PERCENTRANK (D18) and BETADIST (D19)
// ---------------------------------------------------------------------------

/** Flatten a range/array/scalar argument to its cell values (row-major). */
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

const OrigPercentrankPlugin = HyperFormula.getFunctionPlugin('PERCENTRANK') as unknown as {
  new (...args: never[]): FunctionPlugin;
  implementedFunctions: ImplementedFunctions;
};

/**
 * Legacy PERCENTRANK (D18) — Excel defines it as exactly PERCENTRANK.INC.
 * The implementation being replaced (percentrankAlias in
 * extended-functions4.ts) used a mid-rank convention: exact matches got
 * (countLess + 0.5) / (n − 1) and non-matches never interpolated, so
 * PERCENTRANK({10,20,30,40}, 30) returned 0.8333 instead of 0.667.
 * The body below mirrors the engine's verified PERCENTRANK.INC
 * (percentrankInc in extended-functions2.ts) line for line: exact matches
 * land on countLess / (n − 1), non-matches interpolate linearly between
 * the bracketing values, and the result is rounded to `significance`
 * decimal digits (default 3). Standalone FunctionPlugin with the
 * original's metadata copied verbatim (method `percentrankAlias`), so
 * only PERCENTRANK moves; the other ExtendedPlugin4 functions stay put.
 */
export class PercentrankOverridePlugin extends FunctionPlugin {
  public static implementedFunctions: ImplementedFunctions = {
    PERCENTRANK: OrigPercentrankPlugin.implementedFunctions['PERCENTRANK']!,
  };
  public static aliases: Record<string, string> = {};

  public percentrankAlias(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERCENTRANK'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = flattenValues(args[0])
          .filter((v): v is number => typeof v === 'number')
          .sort((a, b) => a - b);
        const x = Number(args[1] === EmptyValue ? 0 : args[1]);
        const digits = args[2] === undefined || args[2] === EmptyValue ? 3 : Math.trunc(Number(args[2]));
        if (vals.length === 0) return new CellError(ErrorType.NA, 'No values.');
        if (vals.length === 1) return new CellError(ErrorType.DIV_BY_ZERO, 'Single value.');
        if (x < vals[0]! || x > vals[vals.length - 1]!) {
          return new CellError(ErrorType.NA, 'Out of range.');
        }
        const n = vals.length;
        let i = 0;
        while (i < n - 1 && vals[i + 1]! < x) i++;
        const lo = vals[i]!;
        const hi = vals[i + 1]!;
        const rank = hi === lo ? i : i + (x - lo) / (hi - lo);
        return Number((rank / (n - 1)).toFixed(digits));
      });
  }
}

/**
 * Legacy BETADIST (D19) — BETADIST(x, alpha, beta, [A = 0], [B = 1]) is
 * the cumulative beta distribution on [A, B], i.e.
 * BETA.DIST(x, alpha, beta, TRUE, A, B). Upstream the name exists only as
 * an alias of BETA.DIST on StatisticalPlugin, so the legacy arguments
 * were consumed as BETA.DIST's (x, alpha, beta, cumulative, [A], [B]):
 * BETADIST(2,8,10,1,3) read its A=1 as the cumulative flag and 3 as the
 * lower bound (→ #NUM!), and BETADIST(0.5,8,10) lacked the required
 * cumulative argument (→ #N/A). Registering a real BETADIST function id
 * shadows the alias (registration-proven on HF 2.7.1); BETA.DIST itself
 * and the other StatisticalPlugin aliases (BETAINV, …) are untouched.
 * Error contract per Microsoft: non-numeric → #VALUE!; alpha ≤ 0,
 * beta ≤ 0, x < A, x > B or A = B → #NUM!.
 */
export class BetadistOverridePlugin extends FunctionPlugin {
  public static implementedFunctions: ImplementedFunctions = {
    BETADIST: {
      method: 'betadistLegacy',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
      ],
    },
  };
  public static aliases: Record<string, string> = {};

  public betadistLegacy(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('BETADIST'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [xArg, aArg, bArg, aBoundArg, bBoundArg] = args;
        for (const a of [xArg, aArg, bArg]) {
          if (a instanceof CellError) return a;
        }
        const x = Number(xArg === EmptyValue ? 0 : xArg);
        const alpha = Number(aArg === EmptyValue ? 0 : aArg);
        const beta = Number(bArg === EmptyValue ? 0 : bArg);
        const A = aBoundArg === undefined || aBoundArg === EmptyValue ? 0 : Number(aBoundArg);
        const B = bBoundArg === undefined || bBoundArg === EmptyValue ? 1 : Number(bBoundArg);
        if (![x, alpha, beta, A, B].every(Number.isFinite)) {
          return new CellError(ErrorType.VALUE, 'BETADIST: non-numeric argument.');
        }
        if (alpha <= 0 || beta <= 0 || A >= B || x < A || x > B) {
          return new CellError(ErrorType.NUM, 'BETADIST: argument out of range.');
        }
        // Cumulative beta on [A, B]: I_((x−A)/(B−A))(α, β) on the same
        // high-precision core as the BETA.DIST override above.
        return betaRegularized((x - A) / (B - A), alpha, beta);
      });
  }
}

export function registerHfOverrides(): void {  // Guard on OUR class: the built-in is already registered under this id,
  // so `!== undefined` would wrongly skip the override.
  if (HyperFormula.getFunctionPlugin('BETA.DIST') === HfOverridesPlugin) return;
  const names = {
    'BETA.DIST': 'BETA.DIST',
    'BETA.INV': 'BETA.INV',
    'FLOOR.MATH': 'FLOOR.MATH',
    'T.INV': 'T.INV',
    'T.INV.2T': 'T.INV.2T',
    'F.DIST.RT': 'F.DIST.RT',
    'CONFIDENCE.T': 'CONFIDENCE.T',
  };
  HyperFormula.registerFunctionPlugin(HfOverridesPlugin, { enGB: names, enUS: names });
  // SUBTOTAL registers with no translations: the function id is unchanged,
  // so the 7 locale packs (registerLocales) keep resolving localized names
  // such as German TEILERGEBNIS to it.
  if (HyperFormula.getFunctionPlugin('SUBTOTAL') !== SubtotalOverridePlugin) {
    HyperFormula.registerFunctionPlugin(SubtotalOverridePlugin);
  }
  // AND/OR/XOR: Excel ignores empty cells and text inside ranges (R2).
  // TEXT: % / ‰ format specifiers scale the value (R3). Same no-translation
  // registration: the function ids are unchanged, so locale packs keep
  // resolving localized names to the overrides.
  if (HyperFormula.getFunctionPlugin('AND') !== LogicalOverridePlugin) {
    HyperFormula.registerFunctionPlugin(LogicalOverridePlugin);
  }
  if (HyperFormula.getFunctionPlugin('TEXT') !== TextOverridePlugin) {
    HyperFormula.registerFunctionPlugin(TextOverridePlugin);
  }
  // ROUND/ROUNDUP/ROUNDDOWN: HyperFormula's Math.round(x * 10^n) / 10^n is
  // not correctly rounded (binary FP error in the ×10^n scaling flips
  // boundary comparisons vs Excel). Same no-translation registration.
  if (HyperFormula.getFunctionPlugin('ROUND') !== RoundingOverridePlugin) {
    HyperFormula.registerFunctionPlugin(RoundingOverridePlugin);
  }
  // Cycle 5, Phase 2 — jstat precision overrides. No translations: the
  // function ids are unchanged, so locale packs keep resolving localized
  // names to the overrides.
  if (HyperFormula.getFunctionPlugin('BINOM.DIST') !== StatisticalPrecisionPlugin) {
    HyperFormula.registerFunctionPlugin(StatisticalPrecisionPlugin);
  }
  if (HyperFormula.getFunctionPlugin('F.TEST') !== StatisticalAggPrecisionPlugin) {
    HyperFormula.registerFunctionPlugin(StatisticalAggPrecisionPlugin);
  }
  // INT / MOD: Excel floor semantics (INT(-7.1) = -8, MOD sign follows the
  // divisor). No translations: function ids unchanged, locale packs keep
  // resolving localized names to the override.
  if (HyperFormula.getFunctionPlugin('INT') !== IntModOverridePlugin) {
    HyperFormula.registerFunctionPlugin(IntModOverridePlugin);
  }
  // CEILING.MATH (D21): ANY nonzero mode rounds negative numbers away from
  // zero; the built-in only honors mode === 1. No translations: the
  // function id is unchanged, so locale packs keep resolving localized
  // names to the override.
  if (HyperFormula.getFunctionPlugin('CEILING.MATH') !== CeilingMathOverridePlugin) {
    HyperFormula.registerFunctionPlugin(CeilingMathOverridePlugin);
  }
  // Legacy PERCENTRANK = PERCENTRANK.INC (D18). Same no-translation
  // registration: the function id is unchanged.
  if (HyperFormula.getFunctionPlugin('PERCENTRANK') !== PercentrankOverridePlugin) {
    HyperFormula.registerFunctionPlugin(PercentrankOverridePlugin);
  }
  // Legacy BETADIST (D19): a real function id shadowing the StatisticalPlugin
  // alias of BETA.DIST. Registered with enGB/enUS names like
  // HfOverridesPlugin above (BETADIST exists in HyperFormula's locale
  // packs, so localized names keep resolving to this plugin).
  if (HyperFormula.getFunctionPlugin('BETADIST') !== BetadistOverridePlugin) {
    const betadistNames = { BETADIST: 'BETADIST' };
    HyperFormula.registerFunctionPlugin(BetadistOverridePlugin, {
      enGB: betadistNames,
      enUS: betadistNames,
    });
  }
}

registerHfOverrides();
