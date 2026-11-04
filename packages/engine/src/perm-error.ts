/**
 * Permission-denied error value for the formula layer.
 *
 * Design-docs/named-ranges-and-named-functions.md §5: "Referencing a name
 * the user cannot read evaluates to a permission error value, matching the
 * permission model." HyperFormula has no PERM error type, so the hidden
 * ICEPERMDENIED() function returns a VALUE error carrying a sentinel message;
 * EngineWorkbook.toTypedValue maps the sentinel to the typed-view '#PERM!'
 * code (the same value EngineHost.readCell returns for denied reads).
 *
 * ICEPERMDENIED is intentionally undocumented in the function list and takes
 * no arguments; it exists only as a binding target for unreadable names.
 */
import {
  CellError,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';

/** Sentinel prefix: toTypedValue maps errors carrying it to '#PERM!'. */
export const PERM_DENIED_SENTINEL = '__icecream_perm__';

/** The hidden dispatch function name. Reserved: rejected as a user name. */
export const PERM_DENIED_FUNCTION = 'ICEPERMDENIED';

export class PermDeniedPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    [PERM_DENIED_FUNCTION]: {
      method: 'permDenied',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 1,
    },
  };

  public permDenied(_ast: ProcedureAst, _state: InterpreterState): InterpreterValue {
    return new CellError(
      ErrorType.VALUE,
      `${PERM_DENIED_SENTINEL}permission denied`,
    ) as unknown as InterpreterValue;
  }
}

export function registerPermDenied(): void {
  if (HyperFormula.getFunctionPlugin(PERM_DENIED_FUNCTION) !== undefined) return;
  const names = { [PERM_DENIED_FUNCTION]: PERM_DENIED_FUNCTION };
  HyperFormula.registerFunctionPlugin(PermDeniedPlugin, { enGB: names, enUS: names });
}

registerPermDenied();
