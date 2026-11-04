/**
 * HyperFormula FunctionPlugin registering `ICEEVAL(code, ...args)`.
 *
 * `=ICEEVAL("arg1 * 2", 21)` runs the JavaScript sandbox synchronously with
 * `{ arg1: 21 }` and returns 42. The first argument must be code text; the
 * remaining scalar arguments are exposed to the script as `arg1`, `arg2`, ...
 *
 * Sandbox failures (timeout, ReferenceError, ...) do NOT throw out of the
 * evaluator — they surface as `#VALUE!` cell errors, so a bad script can
 * never crash recalculation.
 *
 * Registration is global to the HyperFormula module (that's how HyperFormula
 * plugins work): importing this module registers the plugin exactly once via
 * `registerIceCreamFunctions()`. Import order matters only in that the import
 * must happen before a HyperFormula instance is *created*.
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
// Deep type imports need explicit `.js` suffixes: under moduleResolution
// NodeNext, extensionless subpaths of a package without an "exports" map do
// not resolve, but `./X.js` maps to `./X.d.ts` for type-only imports.
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { runJavaScript } from './sandbox/javascript.js';

/** CPU budget for a single ICEEVAL call inside recalculation. Kept small so
 *  one cell cannot stall the whole sheet. */
const ICEEVAL_TIMEOUT_MS = 1000;

/** Coerce an already-evaluated scalar argument into a plain JSON-ish value
 *  for the sandbox. RichNumber (date/currency/percent) unwraps to its raw
 *  number via `.val`. */
function toSandboxInput(value: InterpreterValue): unknown {
  if (
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value === EmptyValue) {
    return null;
  }
  if (value instanceof CellError) {
    // Unreachable in practice: runFunction propagates argument errors before
    // the implementation runs. Map defensively to null.
    return null;
  }
  if (typeof value === 'object' && value !== null && 'val' in value) {
    const raw = (value as { val: unknown }).val;
    if (typeof raw === 'number') {
      return raw;
    }
  }
  return null;
}

/** Map a sandbox result back to something HyperFormula can store in a cell.
 *  Only finite numbers, strings, booleans and null survive; everything else
 *  (objects, arrays, undefined, NaN, Infinity) becomes #VALUE!. */
function toInterpreterValue(value: unknown): InterpreterValue {
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : new CellError(ErrorType.VALUE, 'ICEEVAL: result is not a finite number');
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (value === null || value === undefined) {
    return EmptyValue;
  }
  return new CellError(ErrorType.VALUE, 'ICEEVAL: result must be a number, string, boolean or null');
}

export class IceCreamFunctionsPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    ICEEVAL: {
      method: 'iceEval',
      parameters: [
        { argumentType: FunctionArgumentType.STRING },
        { argumentType: FunctionArgumentType.SCALAR },
      ],
      // The trailing SCALAR argument may repeat: ICEEVAL(code, a1, a2, ...).
      repeatLastArgs: 1,
    },
  };

  public iceEval(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('ICEEVAL'),
      (code: InterpreterValue, ...rest: InterpreterValue[]): InterpreterValue => {
        if (typeof code !== 'string') {
          return new CellError(ErrorType.VALUE, 'ICEEVAL: first argument must be code text');
        }
        const args: Record<string, unknown> = {};
        rest.forEach((v, i) => {
          args[`arg${i + 1}`] = toSandboxInput(v);
        });
        const outcome = runJavaScript(code, args, { timeoutMs: ICEEVAL_TIMEOUT_MS });
        if ('error' in outcome) {
          return new CellError(ErrorType.VALUE, `ICEEVAL: ${outcome.error}`);
        }
        return toInterpreterValue(outcome.value);
      },
    );
  }
}

/**
 * Register the plugin with HyperFormula. Idempotent: safe to call multiple
 * times (e.g. from both src and dist copies in tests).
 *
 * NOTE (HyperFormula API friction): registering the plugin class is NOT
 * enough — the interpreter's `getFunction()` also requires
 * `translationPackage.isFunctionTranslated(id)`, so the function id must be
 * added to at least one language pack. Without the `enUS` translation below,
 * formulas fail with `#NAME? Function name ICEEVAL not recognized`, even
 * though `HyperFormula.getFunctionPlugin('ICEEVAL')` reports it registered.
 * `loadTranslations` silently skips language codes that are not registered,
 * and this HyperFormula build registers `enGB` by default (not `enUS`), so
 * the translation MUST target `enGB` (enUS is included harmlessly in case a
 * future engine config registers it).
 */
export function registerIceCreamFunctions(): void {
  if (HyperFormula.getFunctionPlugin('ICEEVAL') !== undefined) {
    return;
  }
  HyperFormula.registerFunctionPlugin(IceCreamFunctionsPlugin, {
    enGB: { ICEEVAL: 'ICEEVAL' },
    enUS: { ICEEVAL: 'ICEEVAL' },
  });
}

// Side-effectful import, as required: merely importing this module makes
// ICEEVAL available to subsequently created HyperFormula instances.
registerIceCreamFunctions();
