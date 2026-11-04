/**
 * Extended Excel-compatibility functions, batch 2.
 *
 * Database (5): DSTDEV, DSTDEVP, DVAR, DVARP, DGET
 * Text: NUMBERVALUE, ARRAYTOTEXT, VALUETOTEXT, TEXTBEFORE, TEXTAFTER
 * Math: ERF.PRECISE, ERFC.PRECISE, ECMA.CEILING
 * Stats: MODE.SNGL, RANK.AVG, PERCENTILE.INC/EXC, QUARTILE.INC/EXC,
 *        PERCENTRANK.INC/EXC, TRIMMEAN, KURT, PROB, FORECAST.LINEAR, INTERCEPT
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
import { erfHighPrecision, erfcHighPrecision } from './hf-overrides.js';

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

function numbers(vals: InterpreterValue[]): number[] {
  return vals.filter((v): v is number => typeof v === 'number');
}

function mean(vals: number[]): number {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Percentile (inclusive or exclusive). */
function percentile(vals: number[], k: number, exclusive: boolean): number | CellError {
  if (vals.length === 0) return new CellError(ErrorType.NUM, 'No values.');
  if (k < 0 || k > 1) return new CellError(ErrorType.NUM, 'k out of range.');
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  let rank: number;
  if (exclusive) {
    if (k <= 0 || k >= 1) return new CellError(ErrorType.NUM, 'k out of range (exclusive).');
    rank = k * (n + 1);
  } else {
    rank = k * (n - 1) + 1;
  }
  const lo = Math.floor(rank) - 1;
  const hi = Math.ceil(rank) - 1;
  if (lo === hi) return s[lo];
  const frac = rank - Math.floor(rank);
  return s[lo] + frac * (s[hi] - s[lo]);
}

export class ExtendedPlugin2 extends FunctionPlugin {
  public static implementedFunctions = {
    // Database
    DSTDEV: { method: 'dstdev', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    DSTDEVP: { method: 'dstdevp', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    DVAR: { method: 'dvar', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    DVARP: { method: 'dvarp', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    DGET: { method: 'dget', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    // Text
    NUMBERVALUE: { method: 'numbervalue', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    ARRAYTOTEXT: { method: 'arraytotext', parameters: [
      { argumentType: FunctionArgumentType.ANY },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    VALUETOTEXT: { method: 'valuetotext', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    TEXTBEFORE: { method: 'textbefore', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    TEXTAFTER: { method: 'textafter', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    // Math aliases
    'ERF.PRECISE': { method: 'erfPrecise', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    'ERFC.PRECISE': { method: 'erfcPrecise', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    'ECMA.CEILING': { method: 'ecmaCeiling', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    // Stats
    'MODE.SNGL': { method: 'modeSngl', parameters: [
      { argumentType: FunctionArgumentType.ANY },
    ], repeatLastArgs: 1 },
    'RANK.AVG': { method: 'rankAvg', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    'PERCENTILE.INC': { method: 'percentileInc', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    'PERCENTILE.EXC': { method: 'percentileExc', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    'QUARTILE.INC': { method: 'quartileInc', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    'QUARTILE.EXC': { method: 'quartileExc', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    'PERCENTRANK.INC': { method: 'percentrankInc', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    'PERCENTRANK.EXC': { method: 'percentrankExc', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    TRIMMEAN: { method: 'trimmean', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    KURT: { method: 'kurt', parameters: [
      { argumentType: FunctionArgumentType.ANY },
    ], repeatLastArgs: 1 },
    PROB: { method: 'prob', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    'FORECAST.LINEAR': { method: 'forecastLinear', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE },
    ]},
    INTERCEPT: { method: 'intercept', parameters: [
      { argumentType: FunctionArgumentType.RANGE },
      { argumentType: FunctionArgumentType.RANGE },
    ]},
  };

  // ---- Database helpers (shared logic) ----
  private dbValues(
    dbArg: InterpreterValue,
    fieldArg: InterpreterValue,
    critArg: InterpreterValue,
  ): number[] | CellError {
    const db = to2D(dbArg);
    const criteria = to2D(critArg);
    if (db.length < 2) return [];
    // Resolve field
    let fieldIdx: number;
    if (typeof fieldArg === 'number') {
      fieldIdx = Math.trunc(fieldArg) - 1;
    } else {
      const name = String(fieldArg).toLowerCase();
      fieldIdx = db[0].findIndex(h => String(h ?? '').toLowerCase() === name);
    }
    if (fieldIdx < 0 || fieldIdx >= db[0].length) {
      return new CellError(ErrorType.VALUE, 'Invalid field.');
    }
    // Simple criteria: match header names, exact or comparison
    const dbHeaders = db[0].map(h => String(h ?? '').toLowerCase());
    const critHeaders = criteria[0].map(h => String(h ?? '').toLowerCase());
    const out: number[] = [];
    for (let r = 1; r < db.length; r++) {
      let match = false;
      for (let cr = 1; cr < criteria.length; cr++) {
        let rowMatch = true;
        for (let cc = 0; cc < critHeaders.length; cc++) {
          const dbCol = dbHeaders.indexOf(critHeaders[cc]);
          if (dbCol === -1) continue;
          const critVal = criteria[cr][cc];
          const dbVal = db[r][dbCol];
          if (critVal === EmptyValue || critVal === '') continue;
          if (String(dbVal ?? '').toLowerCase() !== String(critVal ?? '').toLowerCase()) {
            // Try numeric comparison for ">x" style
            if (typeof critVal === 'string' && /^(>=|<=|<>|>|<|=)/.test(critVal)) {
              const m = critVal.match(/^(>=|<=|<>|>|<|=)(.*)$/)!;
              const cNum = Number(m[2]);
              const dNum = Number(dbVal);
              const ok = m[1] === '>' ? dNum > cNum : m[1] === '<' ? dNum < cNum
                : m[1] === '>=' ? dNum >= cNum : m[1] === '<=' ? dNum <= cNum
                : m[1] === '<>' ? dNum !== cNum : dNum === cNum;
              if (!ok) { rowMatch = false; break; }
            } else { rowMatch = false; break; }
          }
        }
        if (rowMatch) { match = true; break; }
      }
      if (match) {
        const v = db[r][fieldIdx];
        if (typeof v === 'number') out.push(v);
      }
    }
    return out;
  }

  private dbRun(
    ast: ProcedureAst, state: InterpreterState, name: string,
    fn: (vals: number[]) => InterpreterValue,
  ): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata(name),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = this.dbValues(args[0], args[1], args[2]);
        if (vals instanceof CellError) return vals;
        return fn(vals);
      });
  }

  public dstdev(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbRun(ast, state, 'DSTDEV', (vals) => {
      if (vals.length < 2) return new CellError(ErrorType.DIV_BY_ZERO, 'Need 2+ values.');
      const m = mean(vals);
      const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1);
      return Math.sqrt(v);
    });
  }

  public dstdevp(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbRun(ast, state, 'DSTDEVP', (vals) => {
      if (vals.length === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'No values.');
      const m = mean(vals);
      const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
      return Math.sqrt(v);
    });
  }

  public dvar(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbRun(ast, state, 'DVAR', (vals) => {
      if (vals.length < 2) return new CellError(ErrorType.DIV_BY_ZERO, 'Need 2+ values.');
      const m = mean(vals);
      return vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1);
    });
  }

  public dvarp(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbRun(ast, state, 'DVARP', (vals) => {
      if (vals.length === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'No values.');
      const m = mean(vals);
      return vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
    });
  }

  public dget(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('DGET'),
      (...args: InterpreterValue[]): InterpreterValue => {
        // DGET needs the actual values, not just numbers
        const db = to2D(args[0]);
        const criteria = to2D(args[2]);
        if (db.length < 2) return new CellError(ErrorType.VALUE, 'No data.');
        let fieldIdx: number;
        if (typeof args[1] === 'number') fieldIdx = Math.trunc(args[1] as number) - 1;
        else {
          const name = String(args[1]).toLowerCase();
          fieldIdx = db[0].findIndex(h => String(h ?? '').toLowerCase() === name);
        }
        if (fieldIdx < 0 || fieldIdx >= db[0].length) {
          return new CellError(ErrorType.VALUE, 'Invalid field.');
        }
        const dbHeaders = db[0].map(h => String(h ?? '').toLowerCase());
        const critHeaders = criteria[0].map(h => String(h ?? '').toLowerCase());
        const matches: InterpreterValue[] = [];
        for (let r = 1; r < db.length; r++) {
          for (let cr = 1; cr < criteria.length; cr++) {
            let rowMatch = true;
            for (let cc = 0; cc < critHeaders.length; cc++) {
              const dbCol = dbHeaders.indexOf(critHeaders[cc]);
              if (dbCol === -1) continue;
              const critVal = criteria[cr][cc];
              if (critVal === EmptyValue || critVal === '') continue;
              if (String(db[r][dbCol] ?? '').toLowerCase() !== String(critVal ?? '').toLowerCase()) {
                rowMatch = false; break;
              }
            }
            if (rowMatch) { matches.push(db[r][fieldIdx]); break; }
          }
        }
        if (matches.length === 0) return new CellError(ErrorType.VALUE, 'No match.');
        if (matches.length > 1) return new CellError(ErrorType.NUM, 'Multiple matches.');
        const v = matches[0];
        return v === EmptyValue ? 0 : (v as InterpreterValue);
      });
  }

  // ---- Text ----
  public numbervalue(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('NUMBERVALUE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [textArg, decArg, groupArg] = args;
        if (textArg instanceof CellError) return textArg;
        let s = String(textArg === EmptyValue ? '' : textArg).trim();
        const decSep = decArg === undefined || decArg === EmptyValue ? '.' : String(decArg);
        const grpSep = groupArg === undefined || groupArg === EmptyValue ? ',' : String(groupArg);
        // Remove group separators, normalize decimal
        s = s.split(grpSep).join('').replace(decSep, '.').replace(/[$\s%]/g, '');
        let mult = 1;
        if (String(textArg).trim().endsWith('%')) mult = 0.01;
        const n = Number(s);
        if (s === '' || Number.isNaN(n)) return new CellError(ErrorType.VALUE, 'Cannot convert.');
        return n * mult;
      });
  }

  public arraytotext(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ARRAYTOTEXT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [arrArg, fmtArg] = args;
        const fmt = fmtArg === undefined || fmtArg === EmptyValue ? 0 : Number(fmtArg);
        const vals = flatten(arrArg);
        const parts = vals.map(v => {
          if (v instanceof CellError) return fmt === 1 ? `"${v}"` : '';
          if (v === EmptyValue) return '';
          if (typeof v === 'string') return fmt === 1 ? `"${v}"` : v;
          if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
          return String(v);
        });
        return parts.join(',');
      });
  }

  public valuetotext(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('VALUETOTEXT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [vArg, fmtArg] = args;
        const fmt = fmtArg === undefined || fmtArg === EmptyValue ? 0 : Number(fmtArg);
        const v = vArg;
        if (v instanceof CellError) return fmt === 1 ? `"${v}"` : '';
        if (v === EmptyValue) return '';
        if (typeof v === 'string') return fmt === 1 ? `"${v}"` : v;
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        return String(v);
      });
  }

  public textbefore(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('TEXTBEFORE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [textArg, delimArg, instanceArg] = args;
        if (textArg instanceof CellError) return textArg;
        const text = String(textArg === EmptyValue ? '' : textArg);
        const delim = String(delimArg === EmptyValue ? '' : delimArg);
        const instance = instanceArg === undefined || instanceArg === EmptyValue ? 1 : Math.trunc(Number(instanceArg));
        if (delim === '') return new CellError(ErrorType.VALUE, 'Empty delimiter.');
        let idx = -1;
        let start = 0;
        const n = Math.abs(instance);
        for (let i = 0; i < n; i++) {
          idx = instance > 0 ? text.indexOf(delim, start) : text.lastIndexOf(delim, start === 0 ? undefined : start);
          if (idx === -1) return new CellError(ErrorType.NA, 'Delimiter not found.');
          start = instance > 0 ? idx + delim.length : idx - 1;
        }
        return instance > 0 ? text.slice(0, idx) : text.slice(idx + delim.length);
      });
  }

  public textafter(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('TEXTAFTER'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [textArg, delimArg, instanceArg] = args;
        if (textArg instanceof CellError) return textArg;
        const text = String(textArg === EmptyValue ? '' : textArg);
        const delim = String(delimArg === EmptyValue ? '' : delimArg);
        const instance = instanceArg === undefined || instanceArg === EmptyValue ? 1 : Math.trunc(Number(instanceArg));
        if (delim === '') return new CellError(ErrorType.VALUE, 'Empty delimiter.');
        let idx = -1;
        let start = 0;
        const n = Math.abs(instance);
        for (let i = 0; i < n; i++) {
          idx = instance > 0 ? text.indexOf(delim, start) : text.lastIndexOf(delim, start === 0 ? undefined : start);
          if (idx === -1) return new CellError(ErrorType.NA, 'Delimiter not found.');
          start = instance > 0 ? idx + delim.length : idx - 1;
        }
        return instance > 0 ? text.slice(idx + delim.length) : text.slice(0, idx);
      });
  }

  // ---- Math ----
  public erfPrecise(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ERF.PRECISE'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const x = Number(arg === EmptyValue ? 0 : arg);
        // High-precision erf (Maclaurin series / Laplace continued fraction),
        // accurate to ~1e-15 — the old Abramowitz & Stegun rational
        // approximation drifted by ~1e-7 vs Excel.
        return erfHighPrecision(x);
      });
  }

  public erfcPrecise(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ERFC.PRECISE'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const x = Number(arg === EmptyValue ? 0 : arg);
        return erfcHighPrecision(x);
      });
  }

  public ecmaCeiling(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ECMA.CEILING'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [numArg, sigArg] = args;
        if (numArg instanceof CellError) return numArg;
        const num = Number(numArg === EmptyValue ? 0 : numArg);
        const sig = sigArg === undefined || sigArg === EmptyValue ? 1 : Number(sigArg);
        if (sig === 0) return 0;
        return Math.ceil(num / sig) * sig;
      });
  }

  // ---- Stats ----
  public modeSngl(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('MODE.SNGL'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const flat: number[] = [];
        for (const a of args) flat.push(...numbers(flatten(a)));
        if (flat.length === 0) return new CellError(ErrorType.NA, 'No values.');
        const counts = new Map<number, number>();
        for (const v of flat) counts.set(v, (counts.get(v) ?? 0) + 1);
        let best = flat[0], bestCount = 0;
        for (const [v, c] of counts) {
          if (c > bestCount) { best = v; bestCount = c; }
        }
        if (bestCount < 2) return new CellError(ErrorType.NA, 'No mode.');
        return best;
      });
  }

  public rankAvg(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('RANK.AVG'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [numArg, rangeArg, orderArg] = args;
        if (numArg instanceof CellError) return numArg;
        const num = Number(numArg);
        const vals = numbers(flatten(rangeArg));
        const order = orderArg === undefined || orderArg === EmptyValue || Number(orderArg) === 0 ? 0 : 1;
        // Average rank: 1 + count(better) + (count(equal)-1)/2
        let better = 0, equal = 0;
        for (const v of vals) {
          if (order === 0 ? v > num : v < num) better++;
          else if (v === num) equal++;
        }
        return 1 + better + (equal - 1) / 2;
      });
  }

  public percentileInc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERCENTILE.INC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = numbers(flatten(args[0]));
        const k = Number(args[1] === EmptyValue ? 0 : args[1]);
        return percentile(vals, k, false);
      });
  }

  public percentileExc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERCENTILE.EXC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = numbers(flatten(args[0]));
        const k = Number(args[1] === EmptyValue ? 0 : args[1]);
        return percentile(vals, k, true);
      });
  }

  public quartileInc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('QUARTILE.INC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = numbers(flatten(args[0]));
        const q = Math.trunc(Number(args[1] === EmptyValue ? 0 : args[1]));
        if (q < 0 || q > 4) return new CellError(ErrorType.NUM, 'Quart out of range.');
        return percentile(vals, q / 4, false);
      });
  }

  public quartileExc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('QUARTILE.EXC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = numbers(flatten(args[0]));
        const q = Math.trunc(Number(args[1] === EmptyValue ? 0 : args[1]));
        if (q < 1 || q > 3) return new CellError(ErrorType.NUM, 'Quart out of range.');
        return percentile(vals, q / 4, true);
      });
  }

  public percentrankInc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERCENTRANK.INC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = numbers(flatten(args[0])).sort((a, b) => a - b);
        const x = Number(args[1] === EmptyValue ? 0 : args[1]);
        const digits = args[2] === undefined || args[2] === EmptyValue ? 3 : Math.trunc(Number(args[2]));
        if (vals.length === 0) return new CellError(ErrorType.NA, 'No values.');
        if (vals.length === 1) return new CellError(ErrorType.DIV_BY_ZERO, 'Single value.');
        if (x < vals[0]! || x > vals[vals.length - 1]!) {
          return new CellError(ErrorType.NA, 'Out of range.');
        }
        // Excel's rank: fractional position of x in the sorted array —
        // exact matches land on countLess/(n−1) (the minimum is 0, maximum 1),
        // non-matches interpolate linearly between the bracketing values.
        const n = vals.length;
        let i = 0;
        while (i < n - 1 && vals[i + 1]! < x) i++;
        const lo = vals[i]!;
        const hi = vals[i + 1]!;
        const rank = hi === lo ? i : i + (x - lo) / (hi - lo);
        return Number((rank / (n - 1)).toFixed(digits));
      });
  }

  public percentrankExc(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PERCENTRANK.EXC'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = numbers(flatten(args[0])).sort((a, b) => a - b);
        const x = Number(args[1] === EmptyValue ? 0 : args[1]);
        const digits = args[2] === undefined || args[2] === EmptyValue ? 3 : Math.trunc(Number(args[2]));
        if (vals.length === 0) return new CellError(ErrorType.NUM, 'No values.');
        if (digits < 1) return new CellError(ErrorType.NUM, 'Significance must be >= 1.');
        // Microsoft PERCENTRANK.EXC: x outside [min, max] is #N/A, but the
        // endpoints themselves are valid — the minimum's rank is 1/(n+1)
        // and the maximum's is n/(n+1) (the "exclusive" percentiles).
        if (x < vals[0]! || x > vals[vals.length - 1]!) {
          return new CellError(ErrorType.NA, 'Out of range (exclusive).');
        }
        const n = vals.length;
        if (n === 1) return Number((1 / (n + 1)).toFixed(digits));
        let i = 0;
        while (i < n - 1 && vals[i + 1]! < x) i++;
        const lo = vals[i]!;
        const hi = vals[i + 1]!;
        // Fractional 0-based position of x, as in PERCENTRANK.INC; EXC
        // converts it to a percentile with the 1-based rank over (n+1):
        // rank1 = position + 1, percentile = rank1 / (n+1). This is the
        // exact inverse of PERCENTILE.EXC (k -> position k*(n+1)).
        const rank = hi === lo ? i : i + (x - lo) / (hi - lo);
        return Number(((rank + 1) / (n + 1)).toFixed(digits));
      });
  }

  public trimmean(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('TRIMMEAN'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = numbers(flatten(args[0])).sort((a, b) => a - b);
        const pct = Number(args[1] === EmptyValue ? 0 : args[1]);
        if (pct < 0 || pct >= 1) return new CellError(ErrorType.NUM, 'Percent out of range.');
        const trim = Math.floor(vals.length * pct / 2);
        const trimmed = vals.slice(trim, vals.length - trim);
        if (trimmed.length === 0) return new CellError(ErrorType.NUM, 'Nothing left.');
        return mean(trimmed);
      });
  }

  public kurt(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('KURT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const flat: number[] = [];
        for (const a of args) flat.push(...numbers(flatten(a)));
        const n = flat.length;
        if (n < 4) return new CellError(ErrorType.DIV_BY_ZERO, 'Need 4+ values.');
        const m = mean(flat);
        const s2 = flat.reduce((a, b) => a + (b - m) ** 2, 0);
        const s4 = flat.reduce((a, b) => a + (b - m) ** 4, 0);
        if (s2 === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'No variance.');
        return (n * (n + 1) * s4) / ((n - 1) * (n - 2) * (n - 3) * (s2 / (n - 1)) ** 2)
          - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
      });
  }

  public prob(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('PROB'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const xVals = numbers(flatten(args[0]));
        const pVals = numbers(flatten(args[1]));
        const lo = Number(args[2] === EmptyValue ? 0 : args[2]);
        const hi = args[3] === undefined || args[3] === EmptyValue ? lo : Number(args[3]);
        if (xVals.length !== pVals.length) {
          return new CellError(ErrorType.NA, 'Mismatched ranges.');
        }
        const pSum = pVals.reduce((a, b) => a + b, 0);
        if (Math.abs(pSum - 1) > 1e-9) {
          return new CellError(ErrorType.NUM, 'Probabilities must sum to 1.');
        }
        let prob = 0;
        for (let i = 0; i < xVals.length; i++) {
          if (xVals[i] >= lo && xVals[i] <= hi) prob += pVals[i];
        }
        return prob;
      });
  }

  public forecastLinear(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('FORECAST.LINEAR'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const x = Number(args[0] === EmptyValue ? 0 : args[0]);
        const yVals = numbers(flatten(args[1]));
        const xVals = numbers(flatten(args[2]));
        if (yVals.length !== xVals.length || yVals.length === 0) {
          return new CellError(ErrorType.NA, 'Mismatched ranges.');
        }
        const n = yVals.length;
        const mx = mean(xVals), my = mean(yVals);
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
          num += (xVals[i] - mx) * (yVals[i] - my);
          den += (xVals[i] - mx) ** 2;
        }
        if (den === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'No variance in x.');
        const slope = num / den;
        return my + slope * (x - mx);
      });
  }

  public intercept(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('INTERCEPT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const yVals = numbers(flatten(args[0]));
        const xVals = numbers(flatten(args[1]));
        if (yVals.length !== xVals.length || yVals.length === 0) {
          return new CellError(ErrorType.NA, 'Mismatched ranges.');
        }
        const n = yVals.length;
        const mx = mean(xVals), my = mean(yVals);
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
          num += (xVals[i] - mx) * (yVals[i] - my);
          den += (xVals[i] - mx) ** 2;
        }
        if (den === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'No variance in x.');
        return my - (num / den) * mx;
      });
  }
}

export function registerExtendedFunctions2(): void {
  if (HyperFormula.getFunctionPlugin('DSTDEV') !== undefined) return;
  const names = {
    DSTDEV: 'DSTDEV', DSTDEVP: 'DSTDEVP', DVAR: 'DVAR', DVARP: 'DVARP', DGET: 'DGET',
    NUMBERVALUE: 'NUMBERVALUE', ARRAYTOTEXT: 'ARRAYTOTEXT', VALUETOTEXT: 'VALUETOTEXT',
    TEXTBEFORE: 'TEXTBEFORE', TEXTAFTER: 'TEXTAFTER',
    'ERF.PRECISE': 'ERF.PRECISE', 'ERFC.PRECISE': 'ERFC.PRECISE', 'ECMA.CEILING': 'ECMA.CEILING',
    'MODE.SNGL': 'MODE.SNGL', 'RANK.AVG': 'RANK.AVG',
    'PERCENTILE.INC': 'PERCENTILE.INC', 'PERCENTILE.EXC': 'PERCENTILE.EXC',
    'QUARTILE.INC': 'QUARTILE.INC', 'QUARTILE.EXC': 'QUARTILE.EXC',
    'PERCENTRANK.INC': 'PERCENTRANK.INC', 'PERCENTRANK.EXC': 'PERCENTRANK.EXC',
    TRIMMEAN: 'TRIMMEAN', KURT: 'KURT', PROB: 'PROB',
    'FORECAST.LINEAR': 'FORECAST.LINEAR', INTERCEPT: 'INTERCEPT',
  };
  HyperFormula.registerFunctionPlugin(ExtendedPlugin2, { enGB: names, enUS: names });
}

registerExtendedFunctions2();
