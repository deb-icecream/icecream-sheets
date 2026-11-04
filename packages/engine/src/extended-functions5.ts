/**
 * Extended Excel-compatibility functions, batch 5.
 * PERMUT, PERMUTATIONA, BINOM.DIST.RANGE, GROWTH, TREND, INDIRECT
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

function flatten(value: InterpreterValue): InterpreterValue[] {
  if (value instanceof SimpleRangeValue) {
    return flatten(value.data as unknown as InterpreterValue);
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

function to2D(value: InterpreterValue): InterpreterValue[][] {
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
 * Wrap a 2D array as a range value (dynamic-array spill convention).
 * SimpleRangeValue is what nested functions (SUM, INDEX, …) consume;
 * a bare JS array is not coerced by HyperFormula in argument position.
 */
function asValue(arr: InterpreterValue[][]): InterpreterValue {
  return SimpleRangeValue.onlyValues(arr as never);
}

/** True when an optional argument was omitted or supplied empty. */
function isOmitted(value: InterpreterValue | undefined): boolean {
  if (value === undefined || value === EmptyValue) return true;
  if (value instanceof SimpleRangeValue) return flatten(value).length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Parse a logical const argument (TRUE/FALSE, numbers, "TRUE"/"FALSE"). */
function parseConst(value: InterpreterValue | undefined): boolean | CellError {
  if (value === undefined || value === EmptyValue) return true;
  if (value instanceof CellError) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return new CellError(ErrorType.VALUE, 'const must be a logical value.');
}

/**
 * Solve the least-squares problem min |D·beta − y| via the normal equations
 * (DᵀD)·beta = Dᵀy, solved by Gauss–Jordan elimination with partial
 * pivoting. Returns null when the system is singular (collinear variables /
 * no variance), matching Excel's degenerate-fit behaviour.
 */
function solveLeastSquares(design: number[][], y: number[]): number[] | null {
  const m = design[0]!.length;
  // Build the augmented normal-equations matrix [DᵀD | Dᵀy].
  const a: number[][] = [];
  for (let i = 0; i < m; i++) {
    const row = new Array<number>(m + 1).fill(0);
    for (let k = 0; k < design.length; k++) {
      for (let j = 0; j < m; j++) row[j]! += design[k]![i]! * design[k]![j]!;
      row[m]! += design[k]![i]! * y[k]!;
    }
    a.push(row);
  }
  let scale = 0;
  for (const row of a) for (let j = 0; j < m; j++) scale = Math.max(scale, Math.abs(row[j]!));
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
    for (let c = col; c <= m; c++) a[col]![c]! /= piv;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= m; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map(row => row[m]!);
}

interface RegressionInput {
  /** Dependent values, one per (retained) observation. */
  y: number[];
  /** Independent variables: one row per observation, p columns. */
  x: number[][];
  /** Orientation of known_y's: 'col' (n×1) or 'row' (1×n). */
  orientation: 'row' | 'col';
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
  const y2d = to2D(yArg);
  const yRows = y2d.length;
  const yCols = y2d[0]?.length ?? 0;
  if (yRows === 0 || yCols === 0) return new CellError(ErrorType.NUM, 'No values.');
  const orientation: 'row' | 'col' = yRows === 1 && yCols > 1 ? 'row' : 'col';
  const n = orientation === 'row' ? yCols : yRows;
  const yRaw: InterpreterValue[] = orientation === 'row'
    ? [...y2d[0]!]
    : y2d.map(r => r[0]!);

  let xRaw: InterpreterValue[][];
  if (isOmitted(xArg)) {
    xRaw = yRaw.map((_, i) => [i + 1]);
  } else {
    const x2d = to2D(xArg!);
    const xRows = x2d.length;
    const xCols = x2d[0]?.length ?? 0;
    if (yRows > 1 && yCols > 1) {
      // Single variable, arbitrary equal shapes: flatten both row-major.
      if (xRows * xCols !== yRows * yCols) {
        return new CellError(ErrorType.NA, 'known_y\'s and known_x\'s have different sizes.');
      }
      xRaw = flatten(xArg!).map(v => [v]);
      // yRaw for a non-vector y is the row-major flattening.
      yRaw.length = 0;
      yRaw.push(...flatten(yArg));
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
  return { y, x, orientation };
}

/**
 * Predicted result size for TREND / GROWTH (arraySizeMethod), mirroring
 * trendGrowth's output shapes: no new_x's → one prediction per known
 * observation in known_y's orientation; one variable → shaped exactly
 * like new_x's; several variables → one prediction per new_x observation
 * (a lone observation set predicts a scalar).
 */
function trendGrowthArraySize(
  sizeOf: (a: Ast) => ArraySize,
  ast: ProcedureAst,
): ArraySize {
  if (ast.args.length < 1 || ast.args.length > 4) return ArraySize.error();
  const ySize = sizeOf(ast.args[0]!);
  if (ySize.width <= 0 || ySize.height <= 0) return ArraySize.error();
  const rowOriented = ySize.height === 1 && ySize.width > 1;
  const n = rowOriented ? ySize.width : ySize.height;
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
  if (ast.args[2] === undefined) {
    return rowOriented ? new ArraySize(n, 1) : new ArraySize(1, n);
  }
  const nx = sizeOf(ast.args[2]);
  if (nx.width <= 0 || nx.height <= 0) return ArraySize.error();
  if (p === 1) return new ArraySize(nx.width, nx.height);
  if (nx.width * nx.height === p && (nx.width === 1 || nx.height === 1)) {
    return new ArraySize(1, 1);
  }
  return rowOriented ? new ArraySize(nx.width, 1) : new ArraySize(1, nx.height);
}

/**
 * Shared TREND (exponential=false) / GROWTH (exponential=true) evaluation:
 * least-squares fit of the known data — linear for TREND, log-linear
 * (y = b·m₁ˣ¹···mₚˣᵖ) for GROWTH — evaluated at new_x's (default: the
 * known_x's). const=FALSE forces the intercept to 0 (b = 1 for GROWTH).
 */
function trendGrowth(
  args: InterpreterValue[],
  exponential: boolean,
): InterpreterValue {
  const input = regressionInput(args[0]!, args[1]);
  if (input instanceof CellError) return input;
  const constFlag = parseConst(args[3]);
  if (constFlag instanceof CellError) return constFlag;
  const { y, x, orientation } = input;
  const p = x[0]!.length;

  // GROWTH: every known_y must be positive (Microsoft: #NUM! otherwise).
  if (exponential && y.some(v => v <= 0)) {
    return new CellError(ErrorType.NUM, 'known_y\'s must be positive for GROWTH.');
  }
  const target = exponential ? y.map(v => Math.log(v)) : [...y];
  const design = x.map(row => (constFlag ? [...row, 1] : [...row]));
  const beta = solveLeastSquares(design, target);
  if (beta === null) {
    return new CellError(ErrorType.DIV_BY_ZERO, 'No variance in known_x\'s.');
  }
  const predict = (obs: number[]): number => {
    const d = constFlag ? [...obs, 1] : [...obs];
    let s = 0;
    for (let j = 0; j < d.length; j++) s += d[j]! * beta[j]!;
    return exponential ? Math.exp(s) : s;
  };

  // Resolve new_x's into observations.
  const newArg = args[2];
  if (isOmitted(newArg)) {
    const preds = x.map(obs => predict(obs));
    if (preds.length === 1) return preds[0]!;
    return orientation === 'col'
      ? asValue(preds.map(v => [v as InterpreterValue]))
      : asValue([preds as InterpreterValue[]]);
  }
  const nx2d = to2D(newArg!);
  const nxRows = nx2d.length;
  const nxCols = nx2d[0]?.length ?? 0;
  const nxCell = (r: number, c: number): number | CellError => {
    const v = nx2d[r]![c]!;
    if (v instanceof CellError) return v;
    if (typeof v !== 'number') {
      return new CellError(ErrorType.VALUE, 'new_x\'s must be numeric.');
    }
    return v;
  };
  if (p === 1) {
    // One prediction per supplied new x, shaped exactly like new_x's.
    const out: InterpreterValue[][] = [];
    for (let r = 0; r < nxRows; r++) {
      const row: InterpreterValue[] = [];
      for (let c = 0; c < nxCols; c++) {
        const v = nxCell(r, c);
        if (v instanceof CellError) return v;
        row.push(predict([v]));
      }
      out.push(row);
    }
    if (nxRows === 1 && nxCols === 1) return out[0]![0]!;
    return asValue(out);
  }
  // Multiple variables: new_x's must carry one variable set per observation,
  // laid out like known_x's (columns for column-y, rows for row-y).
  let obsList: number[][] = [];
  const singleObs = nxRows * nxCols === p && (nxRows === 1 || nxCols === 1);
  if (singleObs) {
    const obs: number[] = [];
    for (const v of flatten(newArg!)) {
      if (v instanceof CellError) return v;
      if (typeof v !== 'number') {
        return new CellError(ErrorType.VALUE, 'new_x\'s must be numeric.');
      }
      obs.push(v);
    }
    obsList = [obs];
  } else if (orientation === 'col') {
    if (nxCols !== p) {
      return new CellError(ErrorType.NA, 'new_x\'s must have the same number of columns as known_x\'s.');
    }
    for (let r = 0; r < nxRows; r++) {
      const obs: number[] = [];
      for (let c = 0; c < nxCols; c++) {
        const v = nxCell(r, c);
        if (v instanceof CellError) return v;
        obs.push(v);
      }
      obsList.push(obs);
    }
  } else {
    if (nxRows !== p) {
      return new CellError(ErrorType.NA, 'new_x\'s must have the same number of rows as known_x\'s.');
    }
    for (let c = 0; c < nxCols; c++) {
      const obs: number[] = [];
      for (let r = 0; r < nxRows; r++) {
        const v = nxCell(r, c);
        if (v instanceof CellError) return v;
        obs.push(v);
      }
      obsList.push(obs);
    }
  }
  const preds = obsList.map(obs => predict(obs));
  if (preds.length === 1) return preds[0]!;
  return orientation === 'col'
    ? asValue(preds.map(v => [v as InterpreterValue]))
    : asValue([preds as InterpreterValue[]]);
}

function fact(n: number): number {
  if (n < 0 || !Number.isInteger(n)) return NaN;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

type IndirectTarget =
  | { kind: 'cell'; sheet: number; col: number; row: number }
  | { kind: 'range'; sheet: number; startCol: number; startRow: number; endCol: number; endRow: number };

function colLabelToIndex(label: string): number | undefined {
  if (!/^[A-Za-z]{1,3}$/.test(label)) return undefined;
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseA1Cell(token: string): { col: number; row: number } | undefined {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(token.trim());
  if (!m) return undefined;
  const col = colLabelToIndex(m[1]!);
  const row = parseInt(m[2]!, 10) - 1;
  if (col === undefined || row < 0 || row > 1048575 || col > 16383) return undefined;
  return { col, row };
}

function parseR1C1Cell(token: string, base: { col: number; row: number }): { col: number; row: number } | undefined {
  // Absolute R1C1, or relative R[1]C[-2] (brackets required for offsets).
  const m = /^R(\[(-?\d+)\]|(\d+))?C(\[(-?\d+)\]|(\d+))?$/.exec(token.trim());
  if (!m) return undefined;
  let row = base.row;
  let col = base.col;
  if (m[1] !== undefined) row = m[2] !== undefined ? base.row + parseInt(m[2]!, 10) : parseInt(m[3]!, 10) - 1;
  if (m[4] !== undefined) col = m[5] !== undefined ? base.col + parseInt(m[5]!, 10) : parseInt(m[6]!, 10) - 1;
  if (row < 0 || row > 1048575 || col < 0 || col > 16383) return undefined;
  return { col, row };
}

/**
 * Parse an INDIRECT reference string into a sheet-local target.
 * Handles 'Sheet Name'!A1, Sheet!A1:B2, A1, A1:B2 (A1 mode) and the R1C1
 * equivalents when a1=false. Returns undefined when unresolvable (#REF!).
 */
function parseIndirectRef(
  refText: string,
  a1: boolean,
  contextSheet: number,
  sheetIdFor: (name: string) => number | undefined,
): IndirectTarget | undefined {
  let sheet = contextSheet;
  let body = refText;
  const sheetM = /^(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!(.*)$/.exec(refText);
  if (sheetM) {
    const name = sheetM[1] !== undefined ? sheetM[1]!.replace(/''/g, "'") : sheetM[2]!;
    const id = sheetIdFor(name);
    if (id === undefined) return undefined;
    sheet = id;
    body = sheetM[3]!;
  }
  const base = { col: 0, row: 0 };
  const parseCell = (t: string) => (a1 ? parseA1Cell(t) : parseR1C1Cell(t, base));
  const rangeM = /^([^:]+):([^:]+)$/.exec(body);
  if (rangeM) {
    const s = parseCell(rangeM[1]!);
    const e = parseCell(rangeM[2]!);
    if (!s || !e) return undefined;
    return {
      kind: 'range', sheet,
      startCol: Math.min(s.col, e.col), startRow: Math.min(s.row, e.row),
      endCol: Math.max(s.col, e.col), endRow: Math.max(s.row, e.row),
    };
  }
  const c = parseCell(body);
  if (!c) return undefined;
  return { kind: 'cell', sheet, col: c.col, row: c.row };
}

function coerceToBoolean(v: InterpreterValue): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return undefined;
}

function scalarText(v: InterpreterValue): string {
  if (v === EmptyValue) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return '';
}

export class ExtendedPlugin5 extends FunctionPlugin {
  public static implementedFunctions = {
    PERMUT: { method: 'permut', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    PERMUTATIONA: { method: 'permutationa', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    'BINOM.DIST.RANGE': { method: 'binomDistRange', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    GROWTH: { method: 'growth', arraySizeMethod: 'growthArraySize', vectorizationForbidden: true, parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE, optionalArg: true },
      { argumentType: FunctionArgumentType.ANY, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    TREND: { method: 'trend', arraySizeMethod: 'trendArraySize', vectorizationForbidden: true, parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE, optionalArg: true },
      { argumentType: FunctionArgumentType.ANY, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    INDIRECT: { method: 'indirect', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
  };

  public permut(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERMUT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const n = Math.trunc(Number(args[0] === EmptyValue ? 0 : args[0]));
        const k = Math.trunc(Number(args[1] === EmptyValue ? 0 : args[1]));
        if (n < 0 || k < 0 || k > n) return new CellError(ErrorType.NUM, 'Invalid args.');
        return fact(n) / fact(n - k);
      });
  }

  public permutationa(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERMUTATIONA'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const n = Math.trunc(Number(args[0] === EmptyValue ? 0 : args[0]));
        const k = Math.trunc(Number(args[1] === EmptyValue ? 0 : args[1]));
        if (n < 0 || k < 0) return new CellError(ErrorType.NUM, 'Invalid args.');
        return Math.pow(n, k);
      });
  }

  public binomDistRange(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('BINOM.DIST.RANGE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const trials = Math.trunc(Number(args[0] === EmptyValue ? 0 : args[0]));
        const p = Number(args[1] === EmptyValue ? 0 : args[1]);
        const s1 = Math.trunc(Number(args[2] === EmptyValue ? 0 : args[2]));
        const s2 = args[3] === undefined || args[3] === EmptyValue ? s1 : Math.trunc(Number(args[3]));
        if (p < 0 || p > 1) return new CellError(ErrorType.NUM, 'p out of range.');
        let prob = 0;
        for (let k = s1; k <= s2; k++) {
          if (k < 0 || k > trials) continue;
          const comb = fact(trials) / (fact(k) * fact(trials - k));
          prob += comb * Math.pow(p, k) * Math.pow(1 - p, trials - k);
        }
        return prob;
      });
  }

  public growthArraySize(ast: ProcedureAst, state: InterpreterState): ArraySize {
    return trendGrowthArraySize((a) => this.arraySizeForAst(a, state), ast);
  }

  public trendArraySize(ast: ProcedureAst, state: InterpreterState): ArraySize {
    return trendGrowthArraySize((a) => this.arraySizeForAst(a, state), ast);
  }

  public growth(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('GROWTH'),
      (...args: InterpreterValue[]): InterpreterValue => trendGrowth(args, true));
  }

  public trend(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('TREND'),
      (...args: InterpreterValue[]): InterpreterValue => trendGrowth(args, false));
  }

  public indirect(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('INDIRECT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        // Excel INDIRECT: resolve refText at evaluation time (volatile, so it
        // recalculates every cycle and never goes stale). Supports A1 and R1C1
        // (a1=false), single cells and ranges, with optional 'Sheet'! prefix.
        const [refArg, a1Arg] = args;
        if (refArg instanceof CellError) return refArg;
        if (a1Arg instanceof CellError) return a1Arg;
        const refText = scalarText(refArg).trim();
        if (!refText) return new CellError(ErrorType.REF, 'Empty INDIRECT reference.');
        let a1 = true;
        if (a1Arg !== undefined && a1Arg !== EmptyValue) {
          const b = coerceToBoolean(a1Arg);
          if (b === undefined) return new CellError(ErrorType.VALUE, 'INDIRECT a1 must be logical.');
          a1 = b;
        }
        const sheetIdFor = (name: string): number | undefined => {
          try {
            return this.dependencyGraph.sheetMapping.fetch(name);
          } catch {
            return undefined;
          }
        };
        const parsed = parseIndirectRef(refText, a1, state.formulaAddress.sheet, sheetIdFor);
        if (!parsed) return new CellError(ErrorType.REF, `Cannot resolve INDIRECT("${refText}").`);
        if (parsed.kind === 'cell') {
          return this.dependencyGraph.getCellValue({ sheet: parsed.sheet, col: parsed.col, row: parsed.row });
        }
        const data: InterpreterValue[][] = [];
        for (let r = parsed.startRow; r <= parsed.endRow; r++) {
          const row: InterpreterValue[] = [];
          for (let c = parsed.startCol; c <= parsed.endCol; c++) {
            row.push(this.dependencyGraph.getCellValue({ sheet: parsed.sheet, col: c, row: r }));
          }
          data.push(row);
        }
        return SimpleRangeValue.onlyValues(data as never);
      });
  }
}

export function registerExtendedFunctions5(): void {
  if (HyperFormula.getFunctionPlugin('PERMUT') !== undefined) return;
  const names = {
    PERMUT: 'PERMUT', PERMUTATIONA: 'PERMUTATIONA',
    'BINOM.DIST.RANGE': 'BINOM.DIST.RANGE',
    GROWTH: 'GROWTH', TREND: 'TREND', INDIRECT: 'INDIRECT',
  };
  HyperFormula.registerFunctionPlugin(ExtendedPlugin5, { enGB: names, enUS: names });
}

registerExtendedFunctions5();
