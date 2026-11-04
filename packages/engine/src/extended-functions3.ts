/**
 * Extended Excel-compatibility functions, batch 3.
 * Financial: IRR, XIRR (iterative solvers)
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
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
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

/** Newton-Raphson solver for IRR. */
function solveIRR(
  values: number[],
  guess: number,
): number | CellError {
  // Must have at least one positive and one negative
  const hasPos = values.some(v => v > 0);
  const hasNeg = values.some(v => v < 0);
  if (!hasPos || !hasNeg) {
    return new CellError(ErrorType.NUM, 'Need positive and negative values.');
  }
  let r = guess;
  for (let i = 0; i < 100; i++) {
    let npv = 0, dNpv = 0;
    for (let t = 0; t < values.length; t++) {
      const df = Math.pow(1 + r, t);
      npv += values[t] / df;
      if (t > 0) dNpv -= (t * values[t]) / (df * (1 + r));
    }
    if (Math.abs(npv) < 1e-10) return r;
    if (Math.abs(dNpv) < 1e-12) break;
    const newR = r - npv / dNpv;
    if (Math.abs(newR - r) < 1e-10) return newR;
    r = newR;
    if (r < -0.999999) r = -0.999999; // avoid divergence
  }
  return new CellError(ErrorType.NUM, 'Did not converge.');
}

export class ExtendedPlugin3 extends FunctionPlugin {
  public static implementedFunctions = {
    IRR: { method: 'irr', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    XIRR: { method: 'xirr', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
  };

  public irr(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('IRR'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = flatten(args[0]).filter((v): v is number => typeof v === 'number');
        const guess = args[1] === undefined || args[1] === EmptyValue ? 0.1 : Number(args[1]);
        if (vals.length === 0) return new CellError(ErrorType.NUM, 'No values.');
        return solveIRR(vals, guess);
      });
  }

  public xirr(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('XIRR'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = flatten(args[0]).filter((v): v is number => typeof v === 'number');
        const dateArgs = flatten(args[1]);
        const guess = args[2] === undefined || args[2] === EmptyValue ? 0.1 : Number(args[2]);
        if (vals.length !== dateArgs.length || vals.length === 0) {
          return new CellError(ErrorType.NUM, 'Mismatched ranges.');
        }
        const dates = dateArgs.map(d => Number(d === EmptyValue ? NaN : d));
        if (dates.some(isNaN)) return new CellError(ErrorType.VALUE, 'Invalid dates.');
        const d0 = dates[0];
        // XIRR: solve sum(vals[i] / (1+r)^((dates[i]-d0)/365)) = 0
        const hasPos = vals.some(v => v > 0);
        const hasNeg = vals.some(v => v < 0);
        if (!hasPos || !hasNeg) {
          return new CellError(ErrorType.NUM, 'Need positive and negative values.');
        }
        let r = guess;
        for (let i = 0; i < 100; i++) {
          let npv = 0, dNpv = 0;
          for (let j = 0; j < vals.length; j++) {
            const t = (dates[j] - d0) / 365;
            const df = Math.pow(1 + r, t);
            npv += vals[j] / df;
            dNpv -= (t * vals[j]) / (df * (1 + r));
          }
          if (Math.abs(npv) < 1e-10) return r;
          if (Math.abs(dNpv) < 1e-12) break;
          const newR = r - npv / dNpv;
          if (Math.abs(newR - r) < 1e-10) return newR;
          r = newR;
          if (r < -0.999999) r = -0.999999;
        }
        return new CellError(ErrorType.NUM, 'Did not converge.');
      });
  }
}

export function registerExtendedFunctions3(): void {
  if (HyperFormula.getFunctionPlugin('IRR') !== undefined) return;
  const names = { IRR: 'IRR', XIRR: 'XIRR' };
  HyperFormula.registerFunctionPlugin(ExtendedPlugin3, { enGB: names, enUS: names });
}

registerExtendedFunctions3();
