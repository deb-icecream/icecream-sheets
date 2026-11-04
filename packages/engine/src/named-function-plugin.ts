/**
 * Named-function call dispatch for the engine.
 *
 * Design-docs/named-ranges-and-named-functions.md §6–§7: a named function
 * binds a name to user logic compiled to a LAMBDA expression, versioned in
 * the service registry. HyperFormula cannot parse `=DOUBLE(21)` when DOUBLE
 * is only a named expression ("Function name DOUBLE not recognized"), and
 * its plugin registry is static/global — so per-workbook user functions
 * cannot be registered as real functions.
 *
 * Instead, one permanently-registered dispatcher, ICENAMEDFUNC, resolves the
 * call at EVALUATION time: EngineWorkbook rewrites `DOUBLE(21)` to
 * `ICENAMEDFUNC("DOUBLE",21)` when the formula is set, and ICENAMEDFUNC looks up
 * the CURRENT LAMBDA named expression by name and applies it with the
 * shared applyLambdaValue machinery. Because resolution happens per
 * evaluation (not per formula edit), updating a function to a new version
 * changes every call site with no formula edits (§7: "Formulas always
 * evaluate against the current version").
 *
 * The rewrite is transparent: getFormula/getSerialized reverse it, so the
 * UI, snapshots and XLSX export always see the user's `=DOUBLE(21)` text.
 * (Stored-vs-display divergence is an established engine pattern — formula
 * locales do the same. See workbook.ts setFormulaLanguage.)
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
import type { ProcedureAst, Ast } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { LambdaValue, applyLambdaValue } from './lambda-functions.js';
import {
  getFunctionCallContext,
  interpreterToJs,
  invokeRunner,
} from './names-functions.js';
import { PERM_DENIED_SENTINEL } from './perm-error.js';

/** The hidden dispatcher function. Reserved: rejected as a user name. */
export const NAMEDFUNC_DISPATCH = 'ICENAMEDFUNC';

/** AST node type strings (mirrors HyperFormula's AstNodeType enum). */
const NAMED_EXPRESSION_NODE = 'NAMED_EXPRESSION';

function asVal(v: unknown): InterpreterValue {
  return v as unknown as InterpreterValue;
}

function scalarToString(v: InterpreterValue): string | null {
  if (typeof v === 'string') return v;
  return null;
}

export class NamedFunctionPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    [NAMEDFUNC_DISPATCH]: {
      method: 'callNamed',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 1,
    },
  };

  /**
   * ICENAMEDFUNC("Name", arg1, ...): resolve the named expression `Name`
   * (which must hold a LAMBDA) and apply it to the evaluated arguments.
   */
  public callNamed(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length < 1) {
      return new CellError(ErrorType.NA, 'ICENAMEDFUNC needs a function name.');
    }
    let nameVal: InterpreterValue;
    try {
      nameVal = this.interpreter.evaluateAst(args[0]!, state);
    } catch {
      return new CellError(ErrorType.VALUE, 'ICENAMEDFUNC name failed.');
    }
    if (nameVal instanceof CellError) return nameVal;
    const name = scalarToString(nameVal);
    if (name === null || name.length === 0) {
      return new CellError(ErrorType.VALUE, 'ICENAMEDFUNC name must be text.');
    }
    // Registry-defined functions (design §7: JavaScript/TypeScript/Python —
    // and any non-LAMBDA body) resolve through the ambient call context's
    // registry, which the workbook installs around evaluation. The CURRENT
    // version's runner is used, so updates need no formula edits.
    const fnCtx = getFunctionCallContext();
    const registry = fnCtx?.registry;
    const entry = registry?.runnerFor(name.toUpperCase());
    if (entry && registry) {
      // Using a function requires function.read (§7): denied use becomes
      // the #PERM! value via the permission sentinel (HyperFormula has no
      // permission error type; the workbook maps the sentinel).
      if (!registry.checkRead(entry.def.id, fnCtx?.auth)) {
        return new CellError(
          ErrorType.VALUE,
          `${PERM_DENIED_SENTINEL}function.read denied for "${entry.def.name}".`,
        );
      }
      const jsArgs: unknown[] = [];
      for (let i = 1; i < args.length; i++) {
        let v: InterpreterValue;
        try {
          v = this.interpreter.evaluateAst(args[i]!, state);
        } catch {
          return new CellError(ErrorType.VALUE, 'ICENAMEDFUNC argument failed.');
        }
        if (v instanceof CellError) return v;
        jsArgs.push(v === null ? null : interpreterToJs(v));
      }
      return invokeRunner(entry, jsArgs);
    }
    // Resolve the current LAMBDA through the named-expression table: this
    // is per-HyperFormula-instance state, so version updates are picked up
    // without touching any formula.
    let lambdaVal: InterpreterValue;
    try {
      const nameAst = {
        type: NAMED_EXPRESSION_NODE,
        expressionName: name,
      } as unknown as Ast;
      lambdaVal = this.interpreter.evaluateAst(nameAst, state);
    } catch {
      return new CellError(ErrorType.NAME, `Unknown named function "${name}".`);
    }
    if (lambdaVal instanceof CellError) return lambdaVal;
    if (lambdaVal === EmptyValue) {
      return new CellError(ErrorType.NAME, `Unknown named function "${name}".`);
    }
    if (!(lambdaVal instanceof LambdaValue)) {
      // The name exists but holds no LAMBDA (e.g. a plain named range, or a
      // function whose body needs the service runtime and was bound empty).
      return new CellError(
        ErrorType.VALUE,
        `"${name}" is not a callable named function.`,
      );
    }
    const argValues: InterpreterValue[] = [];
    for (let i = 1; i < args.length; i++) {
      let v: InterpreterValue;
      try {
        v = this.interpreter.evaluateAst(args[i]!, state);
      } catch {
        return new CellError(ErrorType.VALUE, 'ICENAMEDFUNC argument failed.');
      }
      if (v instanceof CellError) return v;
      argValues.push(v);
    }
    // TEMP DEBUG removed — apply directly.
    return applyLambdaValue(lambdaVal, argValues, this.interpreter, state, 0);
  }
}

export function registerNamedFunctionPlugin(): void {
  if (HyperFormula.getFunctionPlugin(NAMEDFUNC_DISPATCH) !== undefined) return;
  const names = { [NAMEDFUNC_DISPATCH]: NAMEDFUNC_DISPATCH };
  HyperFormula.registerFunctionPlugin(NamedFunctionPlugin, { enGB: names, enUS: names });
}

registerNamedFunctionPlugin();

// ---------------------------------------------------------------------------
// Formula rewriting (parse-time binding of named-function calls)
// ---------------------------------------------------------------------------

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_.]/;

/**
 * Rewrite calls to known named functions into dispatcher form:
 * `DOUBLE(21)` → `ICENAMEDFUNC("DOUBLE",21)`.
 *
 * `known` maps the lowercased function name to its display name. Matching
 * is case-insensitive with word boundaries, skips double-quoted string
 * literals, and requires an opening paren (after optional whitespace) so
 * bare references (`=DOUBLE+1`) still resolve as named expressions.
 */
export function rewriteNamedFunctionCalls(
  formula: string,
  known: Map<string, string>,
): string {
  if (known.size === 0) return formula;
  let out = '';
  let i = 0;
  const n = formula.length;
  while (i < n) {
    const ch = formula[i]!;
    // String literal: copy verbatim ("" is an escaped quote).
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = formula[i]!;
        out += c;
        i++;
        if (c === '"') {
          if (formula[i] === '"') {
            out += '"';
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(formula[j]!)) j++;
      const ident = formula.slice(i, j);
      const display = known.get(ident.toLowerCase());
      if (display !== undefined) {
        // Look ahead past whitespace for '('.
        let k = j;
        while (k < n && (formula[k] === ' ' || formula[k] === '\t')) k++;
        if (formula[k] === '(') {
          // Normalize to the defined display name (Excel-like: Excel shows
          // =Double( not =DOUBLE( for a name defined as 'Double').
          out += `${NAMEDFUNC_DISPATCH}(${JSON.stringify(display)},`;
          i = k + 1;
          continue;
        }
      }
      out += ident;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const DISPATCH_RE = /ICENAMEDFUNC\("((?:[^"\\]|\\.)*)"\s*,/g;

/**
 * Reverse rewriteNamedFunctionCalls: `ICENAMEDFUNC("DOUBLE",21)` → `DOUBLE(21)`.
 * Used by getFormula/getSerialized so the UI, snapshots and XLSX export see
 * the user's original text.
 */
export function unrewriteNamedFunctionCalls(formula: string): string {
  return formula.replace(DISPATCH_RE, (_m, quoted: string) => {
    let name: string;
    try {
      name = JSON.parse(`"${quoted}"`) as string;
    } catch {
      return _m;
    }
    return `${name}(`;
  });
}

/** True when the formula text contains dispatcher calls. */
export function hasDispatchCalls(formula: string): boolean {
  DISPATCH_RE.lastIndex = 0;
  return DISPATCH_RE.test(formula);
}
