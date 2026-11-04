/**
 * Solver component — Excel Solver parity (track 7, data-tools).
 *
 * SERVICE-LAYER component, not engine core. Like pivot.ts, this module is
 * pure: it never touches the engine or storage directly. The caller supplies
 * an `evaluate` callback that sets variable cells and returns the objective
 * and constraint values (the web UI implements it over TypedView +
 * host.execute, subject to authorize()).
 *
 * Method: Nelder-Mead simplex ("GRG Nonlinear" class) on a penalty-augmented
 * objective. Constraints are folded in as quadratic penalties; integer/binary
 * variables are rounded during evaluation with a final snap pass. Nelder-Mead
 * needs no gradients, so it handles the non-smooth penalty cusp at active
 * constraint boundaries without stalling.
 */

export const SOLVER_SPEC_VERSION = 1 as const;

export type SolverObjective = 'max' | 'min' | 'value';

export type SolverConstraintOp = '<=' | '>=' | '=' | 'int' | 'bin';

export interface SolverConstraint {
  /** A1 reference of the left-hand-side cell. */
  cell: string;
  op: SolverConstraintOp;
  /** Right-hand side value (ignored for int/bin). */
  rhs: number;
}

export interface SolverSpec {
  version: typeof SOLVER_SPEC_VERSION;
  /** A1 reference of the objective cell. */
  objectiveCell: string;
  objective: SolverObjective;
  /** Required when objective === 'value'. */
  targetValue?: number;
  /** A1 references of the changing (variable) cells. */
  variableCells: string[];
  constraints: SolverConstraint[];
}

export interface SolverOptions {
  maxIterations?: number;
  /** Convergence tolerance on the augmented objective. */
  tolerance?: number;
  /** Finite-difference step for numerical gradients. */
  epsilon?: number;
  /** Penalty weight for constraint violations. */
  penalty?: number;
}

export interface SolverResult {
  converged: boolean;
  iterations: number;
  /** Objective value at the solution. */
  objectiveValue: number;
  /** Variable cell A1 -> solved value. */
  values: Record<string, number>;
  /** Max constraint violation at the solution (0 = feasible). */
  maxViolation: number;
  message: string;
}

/**
 * Evaluate the workbook at a candidate point.
 * @param vars variable cell A1 -> value
 * @returns objective cell value and LHS values of each constraint, in order
 */
export type SolverEvaluator = (vars: Record<string, number>) => {
  objective: number;
  constraintValues: number[];
};

const DEFAULTS: Required<SolverOptions> = {
  maxIterations: 500,
  tolerance: 1e-7,
  epsilon: 1e-6,
  penalty: 1e4,
};

function violation(op: SolverConstraintOp, lhs: number, rhs: number): number {
  switch (op) {
    case '<=':
      return Math.max(0, lhs - rhs);
    case '>=':
      return Math.max(0, rhs - lhs);
    case '=':
      return Math.abs(lhs - rhs);
    case 'int':
      return Math.abs(lhs - Math.round(lhs));
    case 'bin':
      return Math.min(Math.abs(lhs), Math.abs(lhs - 1));
  }
}

/** Snap int/bin variables to their feasible values. */
function snapVars(spec: SolverSpec, vars: Record<string, number>): Record<string, number> {
  const out = { ...vars };
  const constrained = new Map<string, SolverConstraintOp>();
  for (const c of spec.constraints) {
    if (c.op === 'int' || c.op === 'bin') constrained.set(c.cell, c.op);
  }
  for (const cell of spec.variableCells) {
    const op = constrained.get(cell);
    if (op === 'int') out[cell] = Math.round(out[cell] ?? 0);
    else if (op === 'bin') out[cell] = (out[cell] ?? 0) >= 0.5 ? 1 : 0;
  }
  return out;
}

function objectiveSign(spec: SolverSpec): number {
  // We always MINIMIZE the augmented objective.
  return spec.objective === 'max' ? -1 : 1;
}

function baseObjective(spec: SolverSpec, raw: number): number {
  if (spec.objective === 'value') return Math.abs(raw - (spec.targetValue ?? 0));
  return objectiveSign(spec) * raw;
}

/**
 * Solve the spec via Nelder-Mead simplex on the penalty-augmented objective.
 * The evaluator is called with plain variable assignments; integer/binary
 * variables are pre-rounded before each call.
 */
export function solve(
  spec: SolverSpec,
  initial: Record<string, number>,
  evaluate: SolverEvaluator,
  options: SolverOptions = {},
): SolverResult {
  const o = { ...DEFAULTS, ...options };
  const cells = spec.variableCells;
  const n = cells.length;
  if (n === 0) {
    return {
      converged: false,
      iterations: 0,
      objectiveValue: NaN,
      values: {},
      maxViolation: NaN,
      message: 'Solver: no variable cells specified.',
    };
  }

  const start: number[] = cells.map((c) => initial[c] ?? 0);

  const evalAugmented = (x: number[]): { aug: number; maxViol: number; obj: number } => {
    const vars: Record<string, number> = {};
    for (let i = 0; i < n; i++) vars[cells[i]!] = x[i]!;
    const snapped = snapVars(spec, vars);
    let obj: number;
    let cvals: number[];
    try {
      const r = evaluate(snapped);
      obj = r.objective;
      cvals = r.constraintValues;
    } catch {
      return { aug: Infinity, maxViol: Infinity, obj: NaN };
    }
    if (!Number.isFinite(obj)) return { aug: Infinity, maxViol: Infinity, obj };
    let penalty = 0;
    let maxViol = 0;
    for (let i = 0; i < spec.constraints.length; i++) {
      const c = spec.constraints[i]!;
      const lhs = cvals[i] ?? NaN;
      if (!Number.isFinite(lhs)) return { aug: Infinity, maxViol: Infinity, obj };
      const viol = violation(c.op, lhs, c.rhs);
      maxViol = Math.max(maxViol, viol);
      penalty += viol * viol;
    }
    return { aug: baseObjective(spec, obj) + o.penalty * penalty, maxViol, obj };
  };

  // Initialize simplex: start point + one step per axis.
  const step0 = (v: number): number => {
    const s = o.epsilon * 200 * (1 + Math.abs(v));
    return Math.max(s, 1e-4);
  };
  const simplex: number[][] = [start.slice()];
  for (let i = 0; i < n; i++) {
    const p = start.slice();
    p[i] = p[i]! + step0(p[i]!);
    simplex.push(p);
  }
  const fvals: { aug: number; maxViol: number; obj: number }[] = simplex.map(evalAugmented);

  const ALPHA = 1; // reflection
  const GAMMA = 2; // expansion
  const RHO = 0.5; // contraction
  const SIGMA = 0.5; // shrink

  const centroid = (idx: number[]): number[] => {
    const c = new Array<number>(n).fill(0);
    for (const j of idx) for (let i = 0; i < n; i++) c[i]! += simplex[j]![i]!;
    for (let i = 0; i < n; i++) c[i]! /= idx.length;
    return c;
  };

  let iterations = 0;
  let converged = false;
  const order = (fv: { aug: number }[]): number[] =>
    fv.map((_, i) => i).sort((a, b) => fv[a]!.aug - fv[b]!.aug);

  for (let iter = 0; iter < o.maxIterations; iter++) {
    iterations = iter + 1;
    const idx = order(fvals);
    const best = idx[0]!;
    const worst = idx[n]!;
    const secondWorst = idx[n - 1]!;

    // Convergence: simplex diameter and function spread small.
    let maxDist = 0;
    for (let j = 1; j <= n; j++) {
      let d = 0;
      for (let i = 0; i < n; i++) d += (simplex[idx[j]!]![i]! - simplex[best]![i]!) ** 2;
      maxDist = Math.max(maxDist, Math.sqrt(d));
    }
    const fSpread = Math.abs(fvals[worst]!.aug - fvals[best]!.aug);
    if (maxDist < o.tolerance * (1 + Math.abs(simplex[best]![0] ?? 0)) && fSpread < o.tolerance * (1 + Math.abs(fvals[best]!.aug))) {
      converged = true;
      break;
    }

    const cent = centroid(idx.slice(0, n)); // exclude worst
    const reflected = cent.map((c, i) => c + ALPHA * (c - simplex[worst]![i]!));
    const fRef = evalAugmented(reflected);

    if (fRef.aug < fvals[best]!.aug) {
      // Expansion.
      const expanded = cent.map((c, i) => c + GAMMA * (reflected[i]! - c));
      const fExp = evalAugmented(expanded);
      if (fExp.aug < fRef.aug) {
        simplex[worst] = expanded;
        fvals[worst] = fExp;
      } else {
        simplex[worst] = reflected;
        fvals[worst] = fRef;
      }
    } else if (fRef.aug < fvals[secondWorst]!.aug) {
      simplex[worst] = reflected;
      fvals[worst] = fRef;
    } else {
      // Contraction.
      let contracted: number[];
      if (fRef.aug < fvals[worst]!.aug) {
        contracted = cent.map((c, i) => c + RHO * (reflected[i]! - c)); // outside
      } else {
        contracted = cent.map((c, i) => c + RHO * (simplex[worst]![i]! - c)); // inside
      }
      const fCon = evalAugmented(contracted);
      if (fCon.aug < Math.min(fRef.aug, fvals[worst]!.aug)) {
        simplex[worst] = contracted;
        fvals[worst] = fCon;
      } else {
        // Shrink toward best.
        for (let j = 1; j <= n; j++) {
          const jj = idx[j]!;
          simplex[jj] = simplex[best]!.map((b, i) => b + SIGMA * (simplex[jj]![i]! - b));
          fvals[jj] = evalAugmented(simplex[jj]!);
        }
      }
    }
  }

  const idx = order(fvals);
  const bestPt = simplex[idx[0]!]!;
  const finalVars: Record<string, number> = {};
  for (let i = 0; i < n; i++) finalVars[cells[i]!] = bestPt[i]!;
  const snappedFinal = snapVars(spec, finalVars);
  const finalEval = evalAugmented(cells.map((c) => snappedFinal[c] ?? 0));
  return {
    converged,
    iterations,
    objectiveValue: finalEval.obj,
    values: snappedFinal,
    maxViolation: finalEval.maxViol,
    message: converged
      ? `Solver found a solution after ${iterations} iterations.`
      : `Solver stopped after ${iterations} iterations without full convergence.`,
  };
}

// ---------------------------------------------------------------------------
// Goal Seek: find x such that f(x) = target. Secant method with bisection
// fallback for robustness.
// ---------------------------------------------------------------------------

export interface GoalSeekOptions {
  tolerance?: number;
  maxIterations?: number;
}

export interface GoalSeekResult {
  converged: boolean;
  value: number;
  iterations: number;
  message: string;
}

export function goalSeek(
  evaluate: (x: number) => number,
  target: number,
  initialGuess: number,
  options: GoalSeekOptions = {},
): GoalSeekResult {
  const tol = options.tolerance ?? 1e-9;
  const maxIter = options.maxIterations ?? 100;
  const f = (x: number) => {
    try {
      const v = evaluate(x);
      return Number.isFinite(v) ? v - target : NaN;
    } catch {
      return NaN;
    }
  };

  let x0 = initialGuess;
  let f0 = f(x0);
  if (!Number.isFinite(f0)) return { converged: false, value: x0, iterations: 0, message: 'Goal Seek: initial guess produced an error.' };
  if (Math.abs(f0) <= tol) return { converged: true, value: x0, iterations: 0, message: 'Goal Seek: initial guess already meets the target.' };

  // Find a bracketing point by expanding the search.
  let x1 = x0 === 0 ? 1 : x0 * 1.5;
  let f1 = f(x1);
  let expand = 0;
  while ((!Number.isFinite(f1) || f0 * f1 > 0) && expand < 40) {
    x1 = x0 + (x1 - x0) * 2;
    f1 = f(x1);
    expand++;
  }

  let a = x0;
  let b = x1;
  let fa = f0;
  let fb = f1;
  const bracketed = Number.isFinite(fa) && Number.isFinite(fb) && fa * fb <= 0;

  let x = x0;
  let iterations = 0;
  for (let i = 0; i < maxIter; i++) {
    iterations = i + 1;
    // Secant step.
    let xNew: number;
    if (Number.isFinite(fa) && Number.isFinite(fb) && fb !== fa) {
      xNew = b - fb * ((b - a) / (fb - fa));
    } else {
      xNew = (a + b) / 2;
    }
    // Keep inside bracket when bracketed.
    if (bracketed && (xNew < Math.min(a, b) || xNew > Math.max(a, b))) {
      xNew = (a + b) / 2;
    }
    const fNew = f(xNew);
    if (!Number.isFinite(fNew)) {
      // Shrink towards a.
      xNew = (a + xNew) / 2;
      continue;
    }
    x = xNew;
    if (Math.abs(fNew) <= tol) {
      return { converged: true, value: x, iterations, message: `Goal Seek found a solution after ${iterations} iterations.` };
    }
    if (bracketed) {
      if (fa * fNew <= 0) {
        b = xNew;
        fb = fNew;
      } else {
        a = xNew;
        fa = fNew;
      }
    } else {
      a = b;
      fa = fb;
      b = xNew;
      fb = fNew;
    }
  }
  const residual = Math.abs(f(x));
  return {
    converged: residual <= tol * 100,
    value: x,
    iterations,
    message:
      residual <= tol * 100
        ? `Goal Seek converged approximately after ${iterations} iterations.`
        : `Goal Seek did not converge after ${iterations} iterations (residual ${residual}).`,
  };
}

// ---------------------------------------------------------------------------
// Data Tables: one-variable and two-variable.
// ---------------------------------------------------------------------------

export interface OneVarDataTableSpec {
  /** A1 of the input cell to vary. */
  inputCell: string;
  /** A1s of formula cells whose values are recorded. */
  formulaCells: string[];
  /** Input values down the column. */
  values: number[];
}

export interface TwoVarDataTableSpec {
  /** A1 of the row input cell. */
  rowInputCell: string;
  /** A1 of the column input cell. */
  colInputCell: string;
  formulaCells: string[];
  rowValues: number[];
  colValues: number[];
}

/**
 * Evaluate formulas for a set of inputs.
 * @param inputs variable cell A1 -> value
 * @returns formula cell A1 -> computed number
 */
export type DataTableEvaluator = (inputs: Record<string, number>) => Record<string, number>;

/** Rows: [inputValue, ...formulaResults]. */
export function computeOneVarTable(
  spec: OneVarDataTableSpec,
  evaluate: DataTableEvaluator,
): number[][] {
  return spec.values.map((v) => {
    let results: Record<string, number> = {};
    try {
      results = evaluate({ [spec.inputCell]: v });
    } catch {
      results = {};
    }
    return [v, ...spec.formulaCells.map((c) => results[c] ?? NaN)];
  });
}

/**
 * Matrix: first row is a header [corner, ...rowValues]; each subsequent row
 * is [colValue, ...results] for the FIRST formula cell. (Excel shows one
 * formula per two-variable table; extra formula cells produce extra blocks —
 * here we return one matrix per formula cell.)
 */
export function computeTwoVarTable(
  spec: TwoVarDataTableSpec,
  evaluate: DataTableEvaluator,
): number[][][] {
  return spec.formulaCells.map((formulaCell) => {
    const header = [NaN, ...spec.rowValues];
    const rows = spec.colValues.map((cv) => {
      const cells: number[] = [cv];
      for (const rv of spec.rowValues) {
        let results: Record<string, number> = {};
        try {
          results = evaluate({ [spec.rowInputCell]: rv, [spec.colInputCell]: cv });
        } catch {
          results = {};
        }
        cells.push(results[formulaCell] ?? NaN);
      }
      return cells;
    });
    return [header, ...rows];
  });
}
