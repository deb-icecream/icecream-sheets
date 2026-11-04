/**
 * Lambda and dynamic-array helper functions for HyperFormula.
 *
 * Implements Excel's LET/LAMBDA family via AST substitution:
 *
 * - LET(name1, value1, ..., calc): evaluates each value, then substitutes
 *   NamedExpression references in `calc` with literal ASTs built from the
 *   evaluated values, and evaluates the result.
 * - LAMBDA(param1, ..., calc): captures parameter names + calc AST in a
 *   LambdaValue. Applying it (via MAP/REDUCE/...) substitutes the params
 *   and evaluates.
 * - MAP/REDUCE/SCAN/BYCOL/BYROW/MAKEARRAY: iterate and apply lambdas.
 * - ISOMITTED: resolved at lambda-application time — applyLambdaValue knows
 *   which parameters were actually supplied, rewrites ISOMITTED(param) in
 *   the body to a TRUE/FALSE literal, and binds unsupplied trailing
 *   parameters to an empty value (Excel's omitted-argument semantics).
 *   Outside a lambda application ISOMITTED falls back to an empty check.
 * - SINGLE: simplified shim.
 *
 * Limitations vs Excel:
 * - Lambdas are values only inside MAP/REDUCE/etc.; a bare =LAMBDA() in a
 *   cell returns an opaque value (Excel shows #CALC! too).
 * - Only scalar/array values can be substituted; volatile or ref-returning
 *   bodies may not round-trip perfectly.
 * - Recursion depth is capped to avoid runaway evaluation.
 *
 * Importing this module registers the plugin (side-effectful).
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
import type { ProcedureAst, Ast, NumberAst, StringAst, NamedExpressionAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { to2DArray, type ArrayResult } from './dynamic-arrays.js';

/** AST node type strings (mirrors HyperFormula's AstNodeType enum). */
const AstNodeType = {
  EMPTY: 'EMPTY',
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  FUNCTION_CALL: 'FUNCTION_CALL',
  NAMED_EXPRESSION: 'NAMED_EXPRESSION',
  ARRAY: 'ARRAY',
  ERROR: 'ERROR',
} as const;

/** Cast to InterpreterValue (runtime supports arrays/objects; types don't). */
function asVal(v: unknown): InterpreterValue {
  return v as unknown as InterpreterValue;
}

/** A captured lambda: parameter names + unevaluated calculation AST. */
export class LambdaValue {
  public readonly params: string[];
  public readonly calc: Ast;
  constructor(params: string[], calc: Ast) {
    this.params = params;
    this.calc = calc;
  }
}

const MAX_LAMBDA_DEPTH = 50;

/** Minimal interpreter surface needed to apply a captured lambda. */
export interface LambdaInterpreter {
  evaluateAst(ast: Ast, state: InterpreterState): InterpreterValue;
}

/**
 * Apply a captured LambdaValue to evaluated argument values: substitute the
 * parameters with literal ASTs and evaluate the body. Shared by the
 * LET/LAMBDA plugin and the named-function dispatch plugin
 * (named-function-plugin.ts) so both evaluate user lambdas identically.
 */
export function applyLambdaValue(
  lambda: LambdaValue,
  argValues: InterpreterValue[],
  interpreter: LambdaInterpreter,
  state: InterpreterState,
  depth: number,
): InterpreterValue {
  if (depth > MAX_LAMBDA_DEPTH) {
    return new CellError(ErrorType.VALUE, 'Lambda recursion limit.');
  }
  const bindings = new Map<string, Ast>();
  const paramNames = new Set<string>();
  const omitted = new Set<string>();
  for (let i = 0; i < lambda.params.length; i++) {
    const key = lambda.params[i]!.toLowerCase();
    paramNames.add(key);
    if (i < argValues.length) {
      bindings.set(key, valueToAst(argValues[i]!));
    } else {
      // Trailing parameter not supplied at the call site (D25): Excel
      // treats it as OMITTED — ISOMITTED(param) on it is TRUE, and in any
      // other position it behaves like an empty cell (coerces to 0 / "").
      // This engine has no [optional]-bracket parameter syntax, so any
      // trailing parameter may be omitted — exactly like Microsoft's
      // ISOMITTED example LAMBDA(x,y,IF(ISOMITTED(y),…))(1,). A parameter
      // that WAS supplied counts as supplied even when its value is empty
      // (e.g. a reference to an empty cell) or an error: ISOMITTED is
      // FALSE for it, per Microsoft's ISOMITTED page.
      omitted.add(key);
      bindings.set(key, { type: AstNodeType.EMPTY } as Ast);
    }
  }
  const body = substitute(lambda.calc, bindings, paramNames, omitted);
  try {
    return interpreter.evaluateAst(body, state);
  } catch {
    return new CellError(ErrorType.VALUE, 'Lambda evaluation failed.');
  }
}

/** Convert an evaluated value into a literal AST for substitution. */
function valueToAst(value: InterpreterValue): Ast {
  if (value instanceof CellError) {
    return { type: AstNodeType.ERROR, error: value } as Ast;
  }
  if (value === EmptyValue) {
    return { type: AstNodeType.EMPTY } as Ast;
  }
  if (typeof value === 'number') {
    return { type: AstNodeType.NUMBER, value } as NumberAst as Ast;
  }
  if (typeof value === 'string') {
    return { type: AstNodeType.STRING, value } as StringAst as Ast;
  }
  if (typeof value === 'boolean') {
    return {
      type: AstNodeType.FUNCTION_CALL,
      procedureName: value ? 'TRUE' : 'FALSE',
      args: [],
    } as Ast;
  }
  if (value instanceof SimpleRangeValue) {
    return valueToAst(value.data as unknown as InterpreterValue);
  }
  if (Array.isArray(value)) {
    const m = to2DArray(value);
    return {
      type: AstNodeType.ARRAY,
      args: m.map((row) => row.map((v) => valueToAst(v))),
    } as Ast;
  }
  if (value instanceof LambdaValue) {
    // Lambdas as values: re-emit as opaque error (shouldn't normally happen).
    return { type: AstNodeType.ERROR, error: new CellError(ErrorType.VALUE, 'Nested lambda.') } as Ast;
  }
  return { type: AstNodeType.EMPTY } as Ast;
}

/** TRUE()/FALSE() literal AST, same shape valueToAst emits for booleans. */
function boolLiteralAst(v: boolean): Ast {
  return {
    type: AstNodeType.FUNCTION_CALL,
    procedureName: v ? 'TRUE' : 'FALSE',
    args: [],
  } as Ast;
}

/**
 * Recursively substitute NamedExpression nodes whose name (case-insensitive)
 * appears in `bindings` with the bound AST (deep-cloned).
 *
 * ISOMITTED handling (D25): when `paramNames`/`omitted` are supplied (the
 * lambda-application path in applyLambdaValue), an ISOMITTED(param) call
 * whose single argument names one of the lambda's parameters is rewritten
 * here to a TRUE/FALSE literal — TRUE iff the parameter was not supplied
 * at the call site. Resolving it at substitution time (rather than in
 * isomittedFn) is what distinguishes "argument omitted" from "argument
 * supplied with an empty value": a supplied empty cell substitutes to an
 * EMPTY node, which the isomittedFn fallback would misread as omitted.
 * ISOMITTED of anything else (non-parameter, non-identifier argument) is
 * left untouched and falls back to isomittedFn's empty check.
 */
function substitute(
  ast: Ast,
  bindings: Map<string, Ast>,
  paramNames: ReadonlySet<string> = new Set(),
  omitted: ReadonlySet<string> = new Set(),
): Ast {
  if (!ast || typeof ast !== 'object') return ast;
  const node = ast as unknown as Record<string, unknown>;
  if (node['type'] === AstNodeType.FUNCTION_CALL) {
    const proc = String(node['procedureName'] ?? '').toUpperCase();
    if (proc === 'ISOMITTED') {
      const callArgs = node['args'];
      if (Array.isArray(callArgs) && callArgs.length === 1 && isAst(callArgs[0])) {
        const argName = nameFromAst(callArgs[0] as Ast)?.toLowerCase();
        if (argName !== undefined && paramNames.has(argName)) {
          return boolLiteralAst(omitted.has(argName));
        }
      }
    }
    if (proc === 'LAMBDA') {
      // A nested LAMBDA's own parameters shadow the outer ones: strip
      // them from the ISOMITTED context before recursing into its calc
      // (the last argument), so an inner ISOMITTED resolves against the
      // inner application, not this one.
      const callArgs = node['args'];
      if (Array.isArray(callArgs) && callArgs.length >= 1) {
        const innerParams = new Set<string>();
        for (let i = 0; i < callArgs.length - 1; i++) {
          if (isAst(callArgs[i])) {
            const n = nameFromAst(callArgs[i] as Ast)?.toLowerCase();
            if (n !== undefined) innerParams.add(n);
          }
        }
        if (innerParams.size > 0) {
          const outerParams = new Set([...paramNames].filter((p) => !innerParams.has(p)));
          const outerOmitted = new Set([...omitted].filter((p) => !innerParams.has(p)));
          const out: Record<string, unknown> = { ...node };
          out['args'] = callArgs.map((c, idx) =>
            idx === callArgs.length - 1 && isAst(c)
              ? substitute(c as Ast, bindings, outerParams, outerOmitted)
              : isAst(c)
                ? substitute(c as Ast, bindings, paramNames, omitted)
                : c,
          );
          return out as unknown as Ast;
        }
      }
    }
  }
  if (node['type'] === AstNodeType.NAMED_EXPRESSION) {
    const name = String((node as unknown as NamedExpressionAst).expressionName ?? '').toLowerCase();
    const bound = bindings.get(name);
    if (bound) return deepCloneAst(bound);
    return ast;
  }
  // Recurse into known child positions.
  const out: Record<string, unknown> = { ...node };
  for (const key of ['args', 'left', 'right', 'value', 'expression']) {
    const child = node[key];
    if (Array.isArray(child)) {
      out[key] = child.map((c) =>
        Array.isArray(c)
          ? c.map((g) => (isAst(g) ? substitute(g as Ast, bindings, paramNames, omitted) : g))
          : isAst(c)
            ? substitute(c as Ast, bindings, paramNames, omitted)
            : c,
      );
    } else if (isAst(child)) {
      out[key] = substitute(child as Ast, bindings, paramNames, omitted);
    }
  }
  return out as unknown as Ast;
}

function isAst(v: unknown): boolean {
  return !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['type'] === 'string';
}

function deepCloneAst(ast: Ast): Ast {
  return JSON.parse(JSON.stringify(ast)) as Ast;
}

/** Extract a parameter/name string from an AST arg. */
function nameFromAst(a: Ast): string | null {
  const t = (a as unknown as { type: string }).type;
  if (t === AstNodeType.STRING) return (a as unknown as StringAst).value;
  if (t === AstNodeType.NAMED_EXPRESSION) {
    return (a as unknown as NamedExpressionAst).expressionName;
  }
  return null;
}

export class LambdaPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    LET: {
      method: 'letFn',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 1,
    },
    LAMBDA: {
      method: 'lambdaFn',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 1,
    },
    MAP: {
      method: 'mapFn',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
      ],
      repeatLastArgs: 1,
    },
    REDUCE: {
      method: 'reduceFn',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
      ],
    },
    SCAN: {
      method: 'scanFn',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
      ],
    },
    BYROW: {
      method: 'byrowFn',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
      ],
    },
    BYCOL: {
      method: 'bycolFn',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
      ],
    },
    MAKEARRAY: {
      method: 'makearrayFn',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.ANY },
      ],
    },
    ISOMITTED: {
      method: 'isomittedFn',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
    },
    SINGLE: {
      method: 'singleFn',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
    },
  };

  /** Apply a LambdaValue to argument values. Returns the evaluated result. */
  private applyLambda(
    lambda: LambdaValue,
    argValues: InterpreterValue[],
    state: InterpreterState,
    depth: number,
  ): InterpreterValue {
    return applyLambdaValue(lambda, argValues, this.interpreter, state, depth);
  }

  /** Resolve an arg to a LambdaValue (evaluating LAMBDA() if needed). */
  private resolveLambda(
    argAst: Ast,
    state: InterpreterState,
  ): LambdaValue | CellError {
    const v = this.interpreter.evaluateAst(argAst, state);
    if (v instanceof CellError) return v;
    if (v instanceof LambdaValue) return v;
    return new CellError(ErrorType.VALUE, 'Expected a LAMBDA.');
  }

  public letFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    // LET requires odd arg count >= 3: name/value pairs + calc.
    if (args.length < 3 || args.length % 2 === 0) {
      return new CellError(ErrorType.NA, 'LET needs name/value pairs and a calculation.');
    }
    const bindings = new Map<string, Ast>();
    for (let i = 0; i < args.length - 1; i += 2) {
      const name = nameFromAst(args[i]!);
      if (!name) {
        return new CellError(ErrorType.VALUE, 'LET names must be identifiers.');
      }
      let val: InterpreterValue;
      try {
        val = this.interpreter.evaluateAst(args[i + 1]!, state);
      } catch {
        return new CellError(ErrorType.VALUE, 'LET value failed.');
      }
      if (val instanceof CellError) return val;
      bindings.set(name.toLowerCase(), valueToAst(val));
    }
    const calc = substitute(args[args.length - 1]!, bindings);
    try {
      return this.interpreter.evaluateAst(calc, state);
    } catch {
      return new CellError(ErrorType.VALUE, 'LET calculation failed.');
    }
  }

  public lambdaFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length < 1) {
      return new CellError(ErrorType.NA, 'LAMBDA needs a calculation.');
    }
    const params: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      const name = nameFromAst(args[i]!);
      if (!name) {
        return new CellError(ErrorType.VALUE, 'LAMBDA params must be identifiers.');
      }
      params.push(name);
    }
    // Deep-clone the calc AST so later substitution doesn't mutate the cache.
    return asVal(new LambdaValue(params, deepCloneAst(args[args.length - 1]!)));
  }

  public mapFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length < 2) {
      return new CellError(ErrorType.NA, 'MAP needs an array and a LAMBDA.');
    }
    // Evaluate all array args first; last arg is the lambda.
    const arrays: ArrayResult[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      let v: InterpreterValue;
      try {
        v = this.interpreter.evaluateAst(args[i]!, state);
      } catch {
        return new CellError(ErrorType.VALUE, 'MAP array failed.');
      }
      if (v instanceof CellError) return v;
      arrays.push(to2DArray(v));
    }
    const lambda = this.resolveLambda(args[args.length - 1]!, state);
    if (lambda instanceof CellError) return lambda;
    // All arrays must have the same shape (Excel broadcasts scalars; we
    // require equal shapes for simplicity).
    const rows = arrays[0]!.length;
    const cols = arrays[0]![0]!.length;
    const out: ArrayResult = [];
    for (let r = 0; r < rows; r++) {
      const row: InterpreterValue[] = [];
      for (let c = 0; c < cols; c++) {
        const vals = arrays.map((m) => m[r]?.[c] ?? EmptyValue);
        const res = this.applyLambda(lambda, vals, state, 0);
        if (res instanceof CellError) return res;
        row.push(res);
      }
      out.push(row);
    }
    return asVal(out);
  }

  public reduceFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length !== 3) {
      return new CellError(ErrorType.NA, 'REDUCE needs initial_value, array, LAMBDA.');
    }
    let acc: InterpreterValue;
    let arrV: InterpreterValue;
    try {
      acc = this.interpreter.evaluateAst(args[0]!, state);
      arrV = this.interpreter.evaluateAst(args[1]!, state);
    } catch {
      return new CellError(ErrorType.VALUE, 'REDUCE arguments failed.');
    }
    if (acc instanceof CellError) return acc;
    if (arrV instanceof CellError) return arrV;
    const lambda = this.resolveLambda(args[2]!, state);
    if (lambda instanceof CellError) return lambda;
    const flat: InterpreterValue[] = [];
    for (const row of to2DArray(arrV)) for (const v of row) flat.push(v);
    for (const v of flat) {
      const res = this.applyLambda(lambda, [acc, v], state, 0);
      if (res instanceof CellError) return res;
      acc = res;
    }
    return acc;
  }

  public scanFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length !== 3) {
      return new CellError(ErrorType.NA, 'SCAN needs initial_value, array, LAMBDA.');
    }
    let acc: InterpreterValue;
    let arrV: InterpreterValue;
    try {
      acc = this.interpreter.evaluateAst(args[0]!, state);
      arrV = this.interpreter.evaluateAst(args[1]!, state);
    } catch {
      return new CellError(ErrorType.VALUE, 'SCAN arguments failed.');
    }
    if (acc instanceof CellError) return acc;
    if (arrV instanceof CellError) return arrV;
    const lambda = this.resolveLambda(args[2]!, state);
    if (lambda instanceof CellError) return lambda;
    const m = to2DArray(arrV);
    const out: ArrayResult = [];
    for (const row of m) {
      const orow: InterpreterValue[] = [];
      for (const v of row) {
        const res = this.applyLambda(lambda, [acc, v], state, 0);
        if (res instanceof CellError) return res;
        acc = res;
        orow.push(acc);
      }
      out.push(orow);
    }
    return asVal(out);
  }

  public byrowFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length !== 2) {
      return new CellError(ErrorType.NA, 'BYROW needs an array and a LAMBDA.');
    }
    let arrV: InterpreterValue;
    try {
      arrV = this.interpreter.evaluateAst(args[0]!, state);
    } catch {
      return new CellError(ErrorType.VALUE, 'BYROW array failed.');
    }
    if (arrV instanceof CellError) return arrV;
    const lambda = this.resolveLambda(args[1]!, state);
    if (lambda instanceof CellError) return lambda;
    const m = to2DArray(arrV);
    return asVal(
      m.map((row) => {
        const res = this.applyLambda(lambda, [row as unknown as InterpreterValue], state, 0);
        return [res];
      }),
    );
  }

  public bycolFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length !== 2) {
      return new CellError(ErrorType.NA, 'BYCOL needs an array and a LAMBDA.');
    }
    let arrV: InterpreterValue;
    try {
      arrV = this.interpreter.evaluateAst(args[0]!, state);
    } catch {
      return new CellError(ErrorType.VALUE, 'BYCOL array failed.');
    }
    if (arrV instanceof CellError) return arrV;
    const lambda = this.resolveLambda(args[1]!, state);
    if (lambda instanceof CellError) return lambda;
    const m = to2DArray(arrV);
    const cols = m[0]?.length ?? 0;
    const out: InterpreterValue[] = [];
    for (let c = 0; c < cols; c++) {
      const col = m.map((row) => row[c]!);
      const res = this.applyLambda(lambda, [col as unknown as InterpreterValue], state, 0);
      if (res instanceof CellError) return res;
      out.push(res);
    }
    return asVal([out]);
  }

  public makearrayFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length !== 3) {
      return new CellError(ErrorType.NA, 'MAKEARRAY needs rows, cols, LAMBDA.');
    }
    let rowsV: InterpreterValue;
    let colsV: InterpreterValue;
    try {
      rowsV = this.interpreter.evaluateAst(args[0]!, state);
      colsV = this.interpreter.evaluateAst(args[1]!, state);
    } catch {
      return new CellError(ErrorType.VALUE, 'MAKEARRAY dimensions failed.');
    }
    const rows = Math.trunc(Number(rowsV === EmptyValue ? 0 : rowsV));
    const cols = Math.trunc(Number(colsV === EmptyValue ? 0 : colsV));
    if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) {
      return new CellError(ErrorType.VALUE, 'Invalid MAKEARRAY dimensions.');
    }
    const lambda = this.resolveLambda(args[2]!, state);
    if (lambda instanceof CellError) return lambda;
    const out: ArrayResult = [];
    for (let r = 1; r <= rows; r++) {
      const row: InterpreterValue[] = [];
      for (let c = 1; c <= cols; c++) {
        const res = this.applyLambda(lambda, [r, c], state, 0);
        if (res instanceof CellError) return res;
        row.push(res);
      }
      out.push(row);
    }
    return asVal(out);
  }

  public isomittedFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    // Fallback only: ISOMITTED(param) inside a lambda body is rewritten
    // to a TRUE/FALSE literal at application time (see substitute), so
    // this runs only for ISOMITTED used outside a lambda application (or
    // of a non-parameter argument), where "omitted" degrades to an
    // empty-value check.
    const args = ast.args;
    if (args.length !== 1) {
      return new CellError(ErrorType.NA, 'ISOMITTED needs one argument.');
    }
    let v: InterpreterValue;
    try {
      v = this.interpreter.evaluateAst(args[0]!, state);
    } catch {
      return true; // treat unevaluable as omitted
    }
    return v === EmptyValue;
  }

  public singleFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    // SINGLE: implicit intersection — return the top-left value of an array,
    // or the scalar itself.
    const args = ast.args;
    if (args.length !== 1) {
      return new CellError(ErrorType.NA, 'SINGLE needs one argument.');
    }
    let v: InterpreterValue;
    try {
      v = this.interpreter.evaluateAst(args[0]!, state);
    } catch {
      return new CellError(ErrorType.VALUE, 'SINGLE argument failed.');
    }
    if (v instanceof CellError) return v;
    const m = to2DArray(v);
    return m[0]?.[0] ?? EmptyValue;
  }
}

export function registerLambdaFunctions(): void {
  if (HyperFormula.getFunctionPlugin('LET') !== undefined) return;
  const names = {
    LET: 'LET',
    LAMBDA: 'LAMBDA',
    MAP: 'MAP',
    REDUCE: 'REDUCE',
    SCAN: 'SCAN',
    BYROW: 'BYROW',
    BYCOL: 'BYCOL',
    MAKEARRAY: 'MAKEARRAY',
    ISOMITTED: 'ISOMITTED',
    SINGLE: 'SINGLE',
  };
  HyperFormula.registerFunctionPlugin(LambdaPlugin, { enGB: names, enUS: names });
}

registerLambdaFunctions();
