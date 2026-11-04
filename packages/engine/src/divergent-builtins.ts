/**
 * Excel-divergent HyperFormula built-ins.
 *
 * Some HyperFormula built-ins are "protected": FunctionRegistry refuses to
 * (un)register them, so they cannot be overridden with registerFunctionPlugin.
 * Where a protected built-in observably diverges from Excel in real workbooks,
 * this module reroutes calls through an engine-owned implementation using the
 * same transparent parse-time rewrite as the named-function dispatcher
 * (named-function-plugin.ts):
 *
 *   setFormula:     CEILING(a,b)  →  ICECEILING(a,b)
 *   getFormula/etc: ICECEILING(a,b)  →  CEILING(a,b)
 *
 * Divergences fixed here:
 * - CEILING: HyperFormula returns #DIV/0! when significance is 0; Excel
 *   returns 0 (verified against real workbooks: CEILING(23.5,0) evaluates to 0
 *   and the file's own check formulas assert it). Note FLOOR(x,0) IS #DIV/0!
 *   in Excel (the file's checks assert that too), so FLOOR is left alone.
 * - WORKDAY.INTL: HyperFormula returns #VALUE! when the weekend argument is
 *   omitted/empty and #NUM! for weekend=0; Excel treats omitted, empty, and 0
 *   all as weekend code 1 (Saturday/Sunday). The engine reroutes WORKDAY.INTL
 *   through an Excel-faithful implementation (numeric codes 1-7 and 11-17,
 *   7-char "0000011" mask strings, optional holidays range).
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

/** Rerouted built-in: lowercase name → internal dispatcher token. */
const DIVERGENT: Array<{ name: string; display: string; token: string }> = [
  { name: 'ceiling', display: 'CEILING', token: 'ICECEILING' },
  { name: 'workday.intl', display: 'WORKDAY.INTL', token: 'ICEWORKDAYINTL' },
];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_.]/;

/**
 * Rewrite calls to divergent built-ins into internal dispatch form:
 * `CEILING(a,b)` → `ICECEILING(a,b)`.
 *
 * Lexical scan: case-insensitive with word boundaries, skips double-quoted
 * string literals, and requires an opening paren (after optional whitespace)
 * so `CEILING.MATH(` and bare references never match.
 */
export function rewriteDivergentBuiltinCalls(formula: string): string {
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
      const hit = DIVERGENT.find((d) => d.name === ident.toLowerCase());
      if (hit !== undefined) {
        let k = j;
        while (k < n && (formula[k] === ' ' || formula[k] === '\t')) k++;
        if (formula[k] === '(') {
          out += `${hit.token}(`;
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

/**
 * Reverse rewriteDivergentBuiltinCalls: `ICECEILING(a,b)` → `CEILING(a,b)`.
 * Used by getFormula/getSerialized so the UI, snapshots and XLSX export see
 * the user's original text.
 */
export function unrewriteDivergentBuiltinCalls(formula: string): string {
  let out = formula;
  for (const d of DIVERGENT) {
    // Word-boundary safe: the token contains no identifier chars at the edges
    // that could collide, but require the opening paren anyway.
    out = out.split(`${d.token}(`).join(`${d.display}(`);
  }
  return out;
}

/** True when the formula text contains divergent-builtin dispatch calls. */
export function hasDivergentBuiltinCalls(formula: string): boolean {
  return DIVERGENT.some((d) => formula.includes(`${d.token}(`));
}

export class DivergentBuiltinsPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    ICECEILING: {
      method: 'iceCeiling',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    ICEWORKDAYINTL: {
      method: 'iceWorkdayIntl',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
      ],
    },
  };

  /**
   * Excel's CEILING: identical to HyperFormula's except significance 0
   * returns 0 (HyperFormula: #DIV/0!). Rounds away from zero to the nearest
   * multiple of significance; mixed signs (positive number, negative
   * significance) are #NUM!.
   */
  public iceCeiling(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('ICECEILING'),
      (value: InterpreterValue, significance: InterpreterValue): InterpreterValue => {
        const v = value as number;
        const s = significance as number;
        if (v === 0) return 0;
        // Excel divergence: CEILING(x, 0) = 0 (HyperFormula: #DIV/0!).
        if (s === 0) return 0;
        if (v > 0 && s < 0) {
          return new CellError(ErrorType.NUM, 'CEILING: number and significance have different signs.');
        }
        return Math.ceil(v / s) * s;
      },
    );
  }

  /**
   * Excel's WORKDAY.INTL: the serial date that is `days` workdays from
   * `start`. Excel treats an omitted, empty, or 0 weekend argument as code 1
   * (Saturday/Sunday); HyperFormula returns #VALUE!/#NUM! for those cases.
   *
   * Weekend codes: 1=Sat/Sun (default), 2=Sun/Mon, 3=Mon/Tue, 4=Tue/Wed,
   * 5=Wed/Thu, 6=Thu/Fri, 7=Fri/Sat, 11-17=single day Sun..Sat, or a 7-char
   * "0"/"1" mask starting Monday ("0000011" = Sat/Sun). Holidays is an
   * optional range/array of serial dates skipped like weekends. Fractional
   * days are truncated toward zero; negative days walk backwards.
   */
  public iceWorkdayIntl(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('ICEWORKDAYINTL'),
      (
        start: InterpreterValue,
        days: InterpreterValue,
        weekend?: InterpreterValue,
        holidays?: InterpreterValue,
      ): InterpreterValue => {
        const startNum = start as number;
        const daysNum = days as number;
        if (!Number.isFinite(startNum) || !Number.isFinite(daysNum) || startNum < 0) {
          return new CellError(ErrorType.VALUE, 'WORKDAY.INTL: start_date must be a valid date serial.');
        }
        const weekendSet = parseWeekendArg(weekend);
        if (weekendSet === null) {
          return new CellError(ErrorType.NUM, 'WORKDAY.INTL: weekend code not recognized.');
        }
        const holidaySet = new Set<number>();
        if (holidays !== undefined && holidays !== null) {
          for (const h of flattenScalars(holidays)) {
            if (typeof h === 'number' && Number.isFinite(h)) holidaySet.add(Math.trunc(h));
          }
        }
        // Serial % 7: 0=Sat, 1=Sun, 2=Mon, 3=Tue, 4=Wed, 5=Thu, 6=Fri
        // (serial 1 = 1900-01-01, which Excel treats as a Sunday).
        const isWorkday = (serial: number): boolean => {
          const dow = ((Math.trunc(serial) % 7) + 7) % 7;
          return !weekendSet.has(dow) && !holidaySet.has(Math.trunc(serial));
        };
        let remaining = Math.trunc(daysNum);
        let cursor = Math.trunc(startNum);
        const step = remaining >= 0 ? 1 : -1;
        while (remaining !== 0) {
          cursor += step;
          if (isWorkday(cursor)) remaining -= step;
        }
        return cursor;
      },
    );
  }
}

/**
 * Parse WORKDAY.INTL's weekend argument into a set of serial%7 day codes
 * (0=Sat..6=Fri). Returns null for an unrecognized code. Omitted, empty, or 0
 * all mean Saturday/Sunday (Excel default).
 */
function parseWeekendArg(weekend: InterpreterValue | undefined): Set<number> | null {
  // Omitted / empty / 0 → Saturday+Sunday.
  if (
    weekend === undefined ||
    weekend === null ||
    weekend === EmptyValue ||
    weekend === '' ||
    (typeof weekend === 'number' && weekend === 0) ||
    (typeof weekend === 'boolean' && weekend === false)
  ) {
    return new Set([0, 1]);
  }
  if (typeof weekend === 'number' && Number.isFinite(weekend)) {
    const code = Math.trunc(weekend);
    // 1-7: two-day weekends; 11-17: single days Sun..Sat.
    const twoDay: Record<number, [number, number]> = {
      1: [0, 1], 2: [1, 2], 3: [2, 3], 4: [3, 4], 5: [4, 5], 6: [5, 6], 7: [6, 0],
    };
    if (twoDay[code] !== undefined) return new Set(twoDay[code]!);
    if (code >= 11 && code <= 17) {
      // 11=Sunday … 17=Saturday → serial%7 codes 1..0.
      return new Set([code === 17 ? 0 : code - 10]);
    }
    return null;
  }
  if (typeof weekend === 'string') {
    const mask = weekend.trim();
    if (/^[01]{7}$/.test(mask)) {
      // 7-char mask starting Monday: index 0=Mon … 6=Sun.
      // serial%7 codes are 0=Sat,1=Sun,2=Mon..6=Fri, so index i → (i+2)%7.
      const set = new Set<number>();
      for (let i = 0; i < 7; i++) {
        if (mask[i] === '1') set.add((i + 2) % 7);
      }
      return set;
    }
    return null;
  }
  return null;
}

/** Flatten a scalar or 1-D/2-D array argument into its leaf values. */
function flattenScalars(value: InterpreterValue): InterpreterValue[] {
  if (value instanceof SimpleRangeValue) {
    return flattenScalars(value.data as unknown as InterpreterValue);
  }
  if (Array.isArray(value)) {
    const out: InterpreterValue[] = [];
    for (const row of value) {
      if (Array.isArray(row)) out.push(...row);
      else out.push(row as InterpreterValue);
    }
    return out;
  }
  return [value];
}

export function registerDivergentBuiltins(): void {
  if (HyperFormula.getFunctionPlugin('ICECEILING') !== undefined) return;
  const names = { ICECEILING: 'ICECEILING', ICEWORKDAYINTL: 'ICEWORKDAYINTL' };
  HyperFormula.registerFunctionPlugin(DivergentBuiltinsPlugin, { enGB: names, enUS: names });
}

// Self-register on import (like named-function-plugin.ts): workbook.ts imports
// the rewrite helpers directly, so the plugin must exist whenever workbook
// code runs, regardless of plugins.ts import order.
registerDivergentBuiltins();
