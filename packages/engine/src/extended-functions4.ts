/**
 * Extended Excel-compatibility functions, batch 4.
 * Legacy aliases, matrix ops, regex, AGGREGATE, AREAS.
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
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { Ast, CellRangeAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import type { SimpleCellAddress } from 'hyperformula/typings/Cell.js';
import { isRowHidden } from './hidden-rows.js';

/**
 * True when the cell at `addr` holds a formula whose outermost call is
 * SUBTOTAL or AGGREGATE. Used by AGGREGATE's `options` to ignore nested
 * subtotal/aggregate cells (Excel options 0, 1, 2, 3, 6, 7).
 */
function isNestedSubtotalOrAggregate(
  graph: {
    getCell(address: SimpleCellAddress): unknown;
    lazilyTransformingAstService: unknown;
  },
  addr: SimpleCellAddress,
): boolean {
  try {
    const vertex = graph.getCell(addr) as unknown as
      | { getFormula?: (svc: unknown) => Ast }
      | undefined;
    const getFormula = vertex?.getFormula;
    if (typeof getFormula !== 'function') return false;
    const formula = getFormula.call(vertex, graph.lazilyTransformingAstService);
    const rec = formula as unknown as Record<string, unknown>;
    if (rec['type'] !== 'FUNCTION_CALL') return false;
    const name = String(
      (rec as unknown as { procedureName?: unknown }).procedureName ?? '',
    ).toUpperCase();
    return name === 'SUBTOTAL' || name === 'AGGREGATE';
  } catch {
    return false;
  }
}

/** Unwrap PARENTHESIS nodes around an AST argument. */
function unwrapParens(node: Ast): Ast {
  let cur: Ast = node;
  for (let depth = 0; depth < 10; depth++) {
    const rec = cur as unknown as Record<string, unknown>;
    // AstNodeType.PARENTHESIS serializes as "PARENTHESES".
    if (rec['type'] !== 'PARENTHESES') return cur;
    cur = (rec as unknown as { expression: Ast }).expression;
  }
  return cur;
}

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

/** Matrix determinant via LU decomposition. */
function determinant(m: number[][]): number {
  const n = m.length;
  if (n === 1) return m[0][0];
  if (n === 2) return m[0][0] * m[1][1] - m[0][1] * m[1][0];
  // Gaussian elimination
  const a = m.map(r => [...r]);
  let det = 1;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    }
    if (Math.abs(a[pivot][i]) < 1e-12) return 0;
    if (pivot !== i) { [a[i], a[pivot]] = [a[pivot], a[i]]; det *= -1; }
    det *= a[i][i];
    for (let r = i + 1; r < n; r++) {
      const f = a[r][i] / a[i][i];
      for (let c = i; c < n; c++) a[r][c] -= f * a[i][c];
    }
  }
  return det;
}

/**
 * Wrap a 2D array as a range value (dynamic-array spill convention).
 * SimpleRangeValue is what nested functions (SUM, INDEX, MMULT, …) consume;
 * a bare JS array is not coerced by HyperFormula in argument position.
 */
function asValue(arr: InterpreterValue[][]): InterpreterValue {
  return SimpleRangeValue.onlyValues(arr as never);
}

/**
 * Matrix inverse via Gauss–Jordan elimination with partial pivoting on the
 * augmented matrix [A | I]. Returns null when A is (numerically) singular.
 */
function matrixInverse(m: number[][]): number[][] | null {
  const n = m.length;
  let scale = 0;
  for (const row of m) for (const v of row) scale = Math.max(scale, Math.abs(v));
  if (scale === 0) return null;
  const tol = 1e-12 * scale;
  // Augmented rows: [A | I]
  const a: number[][] = m.map((row, i) => {
    const out = [...row];
    for (let j = 0; j < n; j++) out.push(i === j ? 1 : 0);
    return out;
  });
  for (let col = 0; col < n; col++) {
    // Partial pivoting: largest magnitude entry in this column at/below col.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) <= tol) return null; // singular
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const piv = a[col]![col]!;
    for (let c = col; c < 2 * n; c++) a[col]![c]! /= piv;
    // Eliminate this column from every other row.
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      if (f === 0) continue;
      for (let c = col; c < 2 * n; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map(row => row.slice(n));
}

/** PERCENTILE.INC: interpolates between closest ranks. s must be sorted ascending. */
function percentileInc(s: number[], k: number): number {
  const n = s.length;
  if (n === 0) return NaN;
  if (n === 1) return s[0]!;
  const rank = k * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo]!;
  const d = rank - lo;
  return s[lo]! * (1 - d) + s[hi]! * d;
}

/** PERCENTILE.EXC: rank = k*(n+1). s must be sorted ascending. */
function percentileExc(s: number[], k: number): number | null {
  const n = s.length;
  const rank = k * (n + 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo < 1 || hi > n) return null; // #NUM! in Excel
  if (lo === hi) return s[lo - 1]!;
  const d = rank - lo;
  return s[lo - 1]! * (1 - d) + s[hi - 1]! * d;
}

export class ExtendedPlugin4 extends FunctionPlugin {
  public static implementedFunctions = {
    // Legacy aliases (same as modern equivalents)
    MODE: { method: 'modeAlias', parameters: [
      { argumentType: FunctionArgumentType.ANY },
    ], repeatLastArgs: 1 },
    PERCENTILE: { method: 'percentileAlias', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    QUARTILE: { method: 'quartileAlias', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    RANK: { method: 'rankAlias', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    PERCENTRANK: { method: 'percentrankAlias', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    FORECAST: { method: 'forecastAlias', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    // Matrix
    MDETERM: { method: 'mdeterm', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    MINVERSE: { method: 'minverse', arraySizeMethod: 'minverseArraySize', vectorizationForbidden: true, parameters: [
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    MUNIT: { method: 'munit', arraySizeMethod: 'munitArraySize', vectorizationForbidden: true, parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    // Regex (modern)
    REGEXTEST: { method: 'regextest', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    REGEXEXTRACT: { method: 'regexextract', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    REGEXREPLACE: { method: 'regexreplace', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    // Misc
    AREAS: { method: 'areas', parameters: [
      { argumentType: FunctionArgumentType.ANY },
    ], repeatLastArgs: 1 },
    AGGREGATE: { method: 'aggregate', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.ANY },
    ], repeatLastArgs: 1 },
  };

  // Legacy aliases delegate to modern implementations via re-dispatch.
  // Simpler: implement directly with same logic.
  public modeAlias(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('MODE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const flat: number[] = [];
        for (const a of args) {
          for (const v of flatten(a)) if (typeof v === 'number') flat.push(v);
        }
        if (flat.length === 0) return new CellError(ErrorType.NA, 'No values.');
        const counts = new Map<number, number>();
        for (const v of flat) counts.set(v, (counts.get(v) ?? 0) + 1);
        let best = flat[0], bestCount = 0;
        for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
        if (bestCount < 2) return new CellError(ErrorType.NA, 'No mode.');
        return best;
      });
  }

  public percentileAlias(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERCENTILE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = flatten(args[0]).filter((v): v is number => typeof v === 'number');
        const k = Number(args[1] === EmptyValue ? 0 : args[1]);
        if (vals.length === 0) return new CellError(ErrorType.NUM, 'No values.');
        const s = [...vals].sort((a, b) => a - b);
        const rank = k * (s.length - 1) + 1;
        const lo = Math.floor(rank) - 1, hi = Math.ceil(rank) - 1;
        if (lo === hi) return s[lo];
        const frac = rank - Math.floor(rank);
        return s[lo] + frac * (s[hi] - s[lo]);
      });
  }

  public quartileAlias(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('QUARTILE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = flatten(args[0]).filter((v): v is number => typeof v === 'number');
        const q = Math.trunc(Number(args[1] === EmptyValue ? 0 : args[1]));
        if (q < 0 || q > 4) return new CellError(ErrorType.NUM, 'Quart out of range.');
        if (vals.length === 0) return new CellError(ErrorType.NUM, 'No values.');
        const s = [...vals].sort((a, b) => a - b);
        const rank = (q / 4) * (s.length - 1) + 1;
        const lo = Math.floor(rank) - 1, hi = Math.ceil(rank) - 1;
        if (lo === hi) return s[lo];
        const frac = rank - Math.floor(rank);
        return s[lo] + frac * (s[hi] - s[lo]);
      });
  }

  public rankAlias(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('RANK'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const num = Number(args[0] === EmptyValue ? 0 : args[0]);
        const vals = flatten(args[1]).filter((v): v is number => typeof v === 'number');
        const order = args[2] === undefined || args[2] === EmptyValue || Number(args[2]) === 0 ? 0 : 1;
        let rank = 1;
        for (const v of vals) if (order === 0 ? v > num : v < num) rank++;
        return rank;
      });
  }

  public percentrankAlias(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERCENTRANK'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = flatten(args[0]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
        const x = Number(args[1] === EmptyValue ? 0 : args[1]);
        if (vals.length === 0) return new CellError(ErrorType.NA, 'No values.');
        let rank = 0;
        for (const v of vals) {
          if (v < x) rank++;
          else if (v === x) { rank += 0.5; break; }
          else break;
        }
        return rank / (vals.length - 1);
      });
  }

  public forecastAlias(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('FORECAST'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const x = Number(args[0] === EmptyValue ? 0 : args[0]);
        const yVals = flatten(args[1]).filter((v): v is number => typeof v === 'number');
        const xVals = flatten(args[2]).filter((v): v is number => typeof v === 'number');
        if (yVals.length !== xVals.length || yVals.length === 0) {
          return new CellError(ErrorType.NA, 'Mismatched.');
        }
        const n = yVals.length;
        const mx = yVals.reduce((a, b) => a + b, 0) / n;
        // Note: Excel FORECAST(x, known_y, known_x) — args[1] is y, args[2] is x
        const my = xVals.reduce((a, b) => a + b, 0) / n;
        // Actually: known_y = args[1], known_x = args[2]
        const ky = yVals, kx = xVals;
        const mkx = kx.reduce((a, b) => a + b, 0) / n;
        const mky = ky.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
          num += (kx[i] - mkx) * (ky[i] - mky);
          den += (kx[i] - mkx) ** 2;
        }
        if (den === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'No variance.');
        return mky + (num / den) * (x - mkx);
      });
  }

  public mdeterm(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('MDETERM'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m2d = to2D(args[0]);
        const n = m2d.length;
        if (n === 0 || m2d.some(r => r.length !== n)) {
          return new CellError(ErrorType.VALUE, 'Not square.');
        }
        const m: number[][] = m2d.map(r => r.map(v => typeof v === 'number' ? v : 0));
        return determinant(m);
      });
  }

  /**
   * Predicted MINVERSE result size: the inverse has the input's shape.
   * (arraySizeMethod — without a predicted size the call lands in a
   * scalar vertex and the anchor cell exports #VALUE!; see the
   * asRangeValue note in extended-functions7.ts.)
   */
  public minverseArraySize(ast: ProcedureAst, state: InterpreterState): ArraySize {
    if (ast.args.length !== 1) return ArraySize.error();
    const s = this.arraySizeForAst(ast.args[0]!, state);
    if (s.width <= 0 || s.height <= 0) return ArraySize.error();
    return new ArraySize(s.width, s.height);
  }

  /**
   * Predicted MUNIT result size: dimension × dimension when the
   * dimension is a numeric literal. A dimension taken from a reference
   * cannot be predicted at graph-build time; fall back to scalar (the
   * function still evaluates correctly in nested positions).
   */
  public munitArraySize(ast: ProcedureAst, state: InterpreterState): ArraySize {
    if (ast.args.length !== 1) return ArraySize.error();
    const arg = ast.args[0] as unknown as { type?: string; value?: unknown };
    if (arg.type === 'NUMBER') {
      const n = Math.trunc(Number(arg.value));
      if (Number.isFinite(n) && n >= 1) return new ArraySize(n, n);
    }
    return new ArraySize(1, 1);
  }

  public minverse(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('MINVERSE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        // Microsoft MINVERSE: the array must be square (#VALUE! otherwise),
        // every cell must be numeric (empty / text cells → #VALUE!), and a
        // matrix that cannot be inverted (determinant zero) → #NUM!.
        // The result is the full inverse, spilling as a dynamic array.
        const m2d = to2D(args[0]);
        const n = m2d.length;
        if (n === 0 || m2d.some(r => r.length !== n)) {
          return new CellError(ErrorType.VALUE, 'Not square.');
        }
        for (const row of m2d) {
          for (const v of row) {
            if (v instanceof CellError) return v;
            if (typeof v !== 'number') {
              return new CellError(ErrorType.VALUE, 'Array must contain only numbers.');
            }
          }
        }
        const m = m2d as unknown as number[][];
        const inv = matrixInverse(m);
        if (inv === null) return new CellError(ErrorType.NUM, 'Singular matrix.');
        if (n === 1) return inv[0]![0]!; // 1×1: scalar, as with MODE.MULT
        return asValue(inv as unknown as InterpreterValue[][]);
      });
  }

  public munit(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('MUNIT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        // Microsoft MUNIT(dimension): dimension is an integer > 0 (values
        // are truncated to an integer, as with Excel's other integer
        // arguments); dimension <= 0 (or non-numeric) → #VALUE!.
        // Returns the dimension × dimension identity matrix, spilling.
        const raw = args[0];
        if (raw instanceof CellError) return raw;
        const n = Math.trunc(Number(raw === EmptyValue || raw === undefined ? 0 : raw));
        if (!Number.isFinite(n) || n < 1) {
          return new CellError(ErrorType.VALUE, 'Invalid dimension.');
        }
        if (n === 1) return 1; // 1×1 identity is the scalar 1
        const out: InterpreterValue[][] = [];
        for (let r = 0; r < n; r++) {
          const row: InterpreterValue[] = [];
          for (let c = 0; c < n; c++) row.push(r === c ? 1 : 0);
          out.push(row);
        }
        return asValue(out);
      });
  }

  public regextest(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('REGEXTEST'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [textArg, patternArg] = args;
        if (textArg instanceof CellError) return textArg;
        try {
          const re = new RegExp(String(patternArg));
          return re.test(String(textArg === EmptyValue ? '' : textArg));
        } catch {
          return new CellError(ErrorType.VALUE, 'Invalid regex.');
        }
      });
  }

  public regexextract(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('REGEXEXTRACT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [textArg, patternArg, groupArg] = args;
        if (textArg instanceof CellError) return textArg;
        try {
          const re = new RegExp(String(patternArg));
          const m = re.exec(String(textArg === EmptyValue ? '' : textArg));
          if (!m) return new CellError(ErrorType.NA, 'No match.');
          const g = groupArg === undefined || groupArg === EmptyValue ? 0 : Math.trunc(Number(groupArg));
          return m[g] ?? '';
        } catch {
          return new CellError(ErrorType.VALUE, 'Invalid regex.');
        }
      });
  }

  public regexreplace(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('REGEXREPLACE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [textArg, patternArg, replArg] = args;
        if (textArg instanceof CellError) return textArg;
        try {
          const re = new RegExp(String(patternArg), 'g');
          return String(textArg === EmptyValue ? '' : textArg).replace(re, String(replArg ?? ''));
        } catch {
          return new CellError(ErrorType.VALUE, 'Invalid regex.');
        }
      });
  }

  public areas(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('AREAS'),
      (...args: InterpreterValue[]): InterpreterValue => {
        // Without reference parsing, count comma-separated args as areas.
        // A single range arg = 1 area.
        return args.length;
      });
  }

  public aggregate(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const graph = this.dependencyGraph;
    return this.runFunction(ast.args, state, this.metadata('AGGREGATE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const fnNum = Math.trunc(Number(args[0] === EmptyValue ? 0 : args[0]));
        if (!Number.isFinite(fnNum) || fnNum < 1 || fnNum > 19) {
          return new CellError(ErrorType.VALUE, 'Invalid function_num.');
        }
        // Excel options: 0 = ignore nested SUBTOTAL/AGGREGATE;
        // 1 = + hidden rows; 2 = + errors; 3 = 1+2; 4 = ignore nothing;
        // 5 = hidden rows only; 6 = errors only; 7 = hidden rows + errors.
        // (Only options 0-3 ignore nested SUBTOTAL/AGGREGATE calls.)
        // Hidden rows come from the workbook's hidden-row registry
        // (hidden-rows.ts), fed by EngineWorkbookOptions.hiddenRows.
        const options = args[1] === undefined || args[1] === EmptyValue
          ? 0 : Math.trunc(Number(args[1]));
        if (!Number.isFinite(options) || options < 0 || options > 7) {
          return new CellError(ErrorType.VALUE, 'Invalid options.');
        }
        const ignoreNested = options === 0 || options === 1 || options === 2 ||
          options === 3;
        const ignoreErrors = options === 2 || options === 3 || options === 6 || options === 7;
        const ignoreHiddenRows = options === 1 || options === 3 || options === 5 || options === 7;
        // For functions 14-19 (LARGE, SMALL, PERCENTILE, QUARTILE), the last
        // arg is k (if 4+ args). Data is args[2..n-1], k is args[n].
        let kArg: InterpreterValue | undefined;
        let dataEnd = args.length;
        if (fnNum >= 14 && fnNum <= 19 && args.length > 3) {
          kArg = args[args.length - 1];
          dataEnd = args.length - 1;
        }
        // Nested SUBTOTAL/AGGREGATE exclusion is decided from the UNEVALUATED
        // AST: a data arg that IS a SUBTOTAL/AGGREGATE call is dropped whole;
        // for range args, individual cells whose formula is SUBTOTAL/AGGREGATE
        // are dropped (their values would double-count the detail rows).
        const excludedCells = new Set<string>(); // `${sheet}:${row}:${col}`
        const skippedArgs = new Set<number>();
        if (ignoreNested) {
          for (let j = 2; j < dataEnd; j++) {
            if (j >= ast.args.length) break;
            const node = unwrapParens(ast.args[j]!);
            const t = (node as unknown as Record<string, unknown>)['type'];
            if (t === 'FUNCTION_CALL') {
              const name = String(
                (node as unknown as { procedureName?: unknown }).procedureName ?? '',
              ).toUpperCase();
              if (name === 'SUBTOTAL' || name === 'AGGREGATE') skippedArgs.add(j);
            } else if (t === 'CELL_REFERENCE') {
              const ref = (node as unknown as {
                reference: { toSimpleCellAddress(base: SimpleCellAddress): SimpleCellAddress };
              }).reference;
              const addr = ref.toSimpleCellAddress(state.formulaAddress);
              if (isNestedSubtotalOrAggregate(graph, addr)) skippedArgs.add(j);
            } else if (t === 'CELL_RANGE') {
              const range = node as unknown as CellRangeAst;
              const start = range.start.toSimpleCellAddress(state.formulaAddress);
              const end = range.end.toSimpleCellAddress(state.formulaAddress);
              for (let r = start.row; r <= end.row; r++) {
                for (let c = start.col; c <= end.col; c++) {
                  if (isNestedSubtotalOrAggregate(graph, { sheet: start.sheet, row: r, col: c })) {
                    excludedCells.add(`${start.sheet}:${r}:${c}`);
                  }
                }
              }
            }
          }
        }
        const flat: number[] = [];
        let firstError: CellError | undefined;
        const pushValue = (v: InterpreterValue): void => {
          if (v instanceof CellError) {
            if (ignoreErrors) return;
            if (firstError === undefined) firstError = v;
            return;
          }
          if (typeof v === 'number') flat.push(v);
        };
        for (let j = 2; j < dataEnd; j++) {
          if (skippedArgs.has(j)) continue;
          const astArg = j < ast.args.length ? ast.args[j] : undefined;
          const node = astArg === undefined ? undefined : unwrapParens(astArg);
          const t = node === undefined
            ? undefined
            : (node as unknown as Record<string, unknown>)['type'];
          if (t === 'CELL_RANGE' && node !== undefined) {
            // Align evaluated 2-D values with range cells for exclusion.
            const range = node as unknown as CellRangeAst;
            const start = range.start.toSimpleCellAddress(state.formulaAddress);
            const data = to2D(args[j]);
            for (let r = 0; r < data.length; r++) {
              // Options 1/3/5/7: cells on hidden rows are excluded.
              if (ignoreHiddenRows &&
                isRowHidden(this.dependencyGraph, start.sheet, start.row + r)) continue;
              const row = data[r]!;
              for (let c = 0; c < row.length; c++) {
                if (excludedCells.has(`${start.sheet}:${start.row + r}:${start.col + c}`)) continue;
                pushValue(row[c]!);
              }
            }
          } else {
            // A lone cell reference on a hidden row is excluded too: like
            // SUBTOTAL's 101-111 family, Excel checks each reference's row
            // visibility, not just the rows inside range arguments.
            if (ignoreHiddenRows && t === 'CELL_REFERENCE' && node !== undefined) {
              const ref = (node as unknown as {
                reference: { toSimpleCellAddress(base: SimpleCellAddress): SimpleCellAddress };
              }).reference;
              const addr = ref.toSimpleCellAddress(state.formulaAddress);
              if (isRowHidden(this.dependencyGraph, addr.sheet, addr.row)) continue;
            }
            for (const v of flatten(args[j])) pushValue(v);
          }
        }
        // Errors propagate unless the options say to ignore them.
        if (firstError !== undefined) return firstError;
        if (flat.length === 0) return new CellError(ErrorType.NUM, 'No values.');
        const s = [...flat].sort((a, b) => a - b);
        const getK = (): number => (kArg === undefined || kArg === EmptyValue ? 0 : Number(kArg));
        switch (fnNum) {
          case 1: return flat.reduce((a, b) => a + b, 0) / flat.length; // AVERAGE
          case 2: return flat.length; // COUNT
          case 3: return flat.length; // COUNTA (simplified)
          case 4: return Math.max(...flat); // MAX
          case 5: return Math.min(...flat); // MIN
          case 6: return flat.reduce((a, b) => a * b, 1); // PRODUCT
          case 7: { // STDEV.S
            const m = flat.reduce((a, b) => a + b, 0) / flat.length;
            return Math.sqrt(flat.reduce((a, b) => a + (b - m) ** 2, 0) / (flat.length - 1));
          }
          case 8: { // STDEV.P
            const m = flat.reduce((a, b) => a + b, 0) / flat.length;
            return Math.sqrt(flat.reduce((a, b) => a + (b - m) ** 2, 0) / flat.length);
          }
          case 9: return flat.reduce((a, b) => a + b, 0); // SUM
          case 10: { // VAR.S
            const m = flat.reduce((a, b) => a + b, 0) / flat.length;
            return flat.reduce((a, b) => a + (b - m) ** 2, 0) / (flat.length - 1);
          }
          case 11: { // VAR.P
            const m = flat.reduce((a, b) => a + b, 0) / flat.length;
            return flat.reduce((a, b) => a + (b - m) ** 2, 0) / flat.length;
          }
          case 12: { // MEDIAN
            const mid = Math.floor(s.length / 2);
            return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
          }
          case 13: { // MODE.SNGL
            const counts = new Map<number, number>();
            for (const v of flat) counts.set(v, (counts.get(v) ?? 0) + 1);
            let best = flat[0], bc = 0;
            for (const [v, c] of counts) if (c > bc) { best = v; bc = c; }
            return best;
          }
          case 14: { // LARGE
            const k = Math.trunc(getK()) || 1;
            if (k < 1 || k > s.length) return new CellError(ErrorType.NUM, 'k out of range.');
            return s[s.length - k];
          }
          case 15: { // SMALL
            const k = Math.trunc(getK()) || 1;
            if (k < 1 || k > s.length) return new CellError(ErrorType.NUM, 'k out of range.');
            return s[k - 1];
          }
          case 16: { // PERCENTILE.INC
            const k = getK();
            if (k < 0 || k > 1) return new CellError(ErrorType.NUM, 'k out of range.');
            return percentileInc(s, k);
          }
          case 17: { // QUARTILE.INC
            const q = Math.trunc(getK());
            if (q < 0 || q > 4) return new CellError(ErrorType.NUM, 'quart out of range.');
            return percentileInc(s, q / 4);
          }
          case 18: { // PERCENTILE.EXC
            const k = getK();
            if (k <= 0 || k >= 1) return new CellError(ErrorType.NUM, 'k out of range.');
            const r = percentileExc(s, k);
            if (r === null) return new CellError(ErrorType.NUM, 'k out of range.');
            return r;
          }
          case 19: { // QUARTILE.EXC
            const q = Math.trunc(getK());
            if (q < 0 || q > 4) return new CellError(ErrorType.NUM, 'quart out of range.');
            const r = percentileExc(s, q / 4);
            if (r === null) return new CellError(ErrorType.NUM, 'quart out of range.');
            return r;
          }
          default:
            return new CellError(ErrorType.VALUE, 'Invalid function_num.');
        }
      });
  }
}

export function registerExtendedFunctions4(): void {
  if (HyperFormula.getFunctionPlugin('MDETERM') !== undefined) return;
  const names = {
    MODE: 'MODE', PERCENTILE: 'PERCENTILE', QUARTILE: 'QUARTILE',
    RANK: 'RANK', PERCENTRANK: 'PERCENTRANK', FORECAST: 'FORECAST',
    MDETERM: 'MDETERM', MINVERSE: 'MINVERSE', MUNIT: 'MUNIT',
    REGEXTEST: 'REGEXTEST', REGEXEXTRACT: 'REGEXEXTRACT', REGEXREPLACE: 'REGEXREPLACE',
    AREAS: 'AREAS', AGGREGATE: 'AGGREGATE',
  };
  HyperFormula.registerFunctionPlugin(ExtendedPlugin4, { enGB: names, enUS: names });
}

registerExtendedFunctions4();
