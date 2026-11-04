/**
 * Excel-compatibility function aliases for HyperFormula.
 *
 * HyperFormula implements the legacy CONCATENATE but not the modern CONCAT
 * (both exist in Excel with identical semantics). Rather than forking the
 * calc core, we register a thin alias plugin. Importing this module
 * registers the aliases exactly once (side-effectful, like the MCP server's
 * ICEEVAL plugin); it must be imported before a HyperFormula instance is
 * created — engine/index.ts does this.
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
// Deep type imports need explicit `.js` suffixes under NodeNext (see
// mcp-server/src/engine-plugin.ts for the full explanation).
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';

/** Excel string coercion for CONCAT arguments. */
function concatCoerce(value: InterpreterValue): string {
  if (value === EmptyValue) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  return '';
}

export class ConcatAliasPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    CONCAT: {
      method: 'concatAlias',
      // optionalArg: CONCAT() with no arguments is "" in Excel.
      parameters: [{ argumentType: FunctionArgumentType.SCALAR, optionalArg: true }],
      repeatLastArgs: 1,
    },
  };

  public concatAlias(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CONCAT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        let out = '';
        for (const a of args) {
          // Argument errors propagate before we run (runFunction), but map
          // defensively: an error anywhere poisons the result, like Excel.
          if (a instanceof CellError) return a;
          out += concatCoerce(a);
        }
        return out;
      },
    );
  }
}

/**
 * Excel-compatibility functions missing from HyperFormula: VALUE and N.
 * Both are standard Excel functions (VALUE converts text to number;
 * N coerces a value to a number). Registered the same way as CONCAT.
 */
export class CompatPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    VALUE: {
      method: 'valueFn',
      parameters: [{ argumentType: FunctionArgumentType.SCALAR }],
    },
    N: {
      method: 'nFn',
      parameters: [{ argumentType: FunctionArgumentType.SCALAR }],
    },
    GESTEP: {
      method: 'gestepFn',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    DOLLAR: {
      method: 'dollarFn',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
  };

  public valueFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('VALUE'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const raw = (arg === EmptyValue ? '' : String(arg)).trim();
        let str = raw.replace(/[$,\s]/g, '');
        let mult = 1;
        if (str.endsWith('%')) {
          mult = 0.01;
          str = str.slice(0, -1);
        }
        if (str === '') return new CellError(ErrorType.VALUE, 'Cannot convert to number.');
        const n = Number(str);
        if (Number.isNaN(n)) return new CellError(ErrorType.VALUE, 'Cannot convert to number.');
        return n * mult;
      },
    );
  }

  public nFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('N'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        if (typeof arg === 'number') return arg;
        if (typeof arg === 'boolean') return arg ? 1 : 0;
        return 0; // text, empty, and dates-as-text coerce to 0 like Excel
      },
    );
  }

  public gestepFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('GESTEP'),
      (...args: InterpreterValue[]): InterpreterValue => {
        for (const a of args) if (a instanceof CellError) return a;
        const num = args[0] === EmptyValue ? 0 : Number(args[0]);
        const step = args.length < 2 || args[1] === EmptyValue ? 0 : Number(args[1]);
        if (Number.isNaN(num) || Number.isNaN(step)) {
          return new CellError(ErrorType.VALUE, 'GESTEP expects numbers.');
        }
        return num >= step ? 1 : 0;
      },
    );
  }

  public dollarFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('DOLLAR'),
      (...args: InterpreterValue[]): InterpreterValue => {
        for (const a of args) if (a instanceof CellError) return a;
        const num = args[0] === EmptyValue ? 0 : Number(args[0]);
        const dec = args.length < 2 || args[1] === EmptyValue ? 2 : Math.trunc(Number(args[1]));
        if (Number.isNaN(num) || Number.isNaN(dec)) {
          return new CellError(ErrorType.VALUE, 'DOLLAR expects numbers.');
        }
        const neg = num < 0;
        const abs = Math.abs(num).toFixed(Math.max(0, dec));
        const [intPart, fracPart] = abs.split('.');
        const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        const body = fracPart !== undefined ? `${grouped}.${fracPart}` : grouped;
        return neg ? `($${body})` : `$${body}`;
      },
    );
  }
}

/**
 * Register the alias plugin. Idempotent. NOTE: the function id must be added
 * to a translation package or the interpreter reports #NAME? even though the
 * plugin is registered (HyperFormula requires isFunctionTranslated(id)).
 * This build registers enGB by default, so enGB is mandatory; enUS is
 * included harmlessly.
 */
export function registerFunctionAliases(): void {
  if (HyperFormula.getFunctionPlugin('CONCAT') !== undefined) {
    return;
  }
  HyperFormula.registerFunctionPlugin(ConcatAliasPlugin, {
    enGB: { CONCAT: 'CONCAT' },
    enUS: { CONCAT: 'CONCAT' },
  });
  HyperFormula.registerFunctionPlugin(CompatPlugin, {
    enGB: { VALUE: 'VALUE', N: 'N', GESTEP: 'GESTEP', DOLLAR: 'DOLLAR' },
    enUS: { VALUE: 'VALUE', N: 'N', GESTEP: 'GESTEP', DOLLAR: 'DOLLAR' },
  });
}

// Side-effectful import: merely importing this module makes CONCAT available
// to subsequently created HyperFormula instances.
registerFunctionAliases();
