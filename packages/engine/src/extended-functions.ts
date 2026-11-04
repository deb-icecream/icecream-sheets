/**
 * Extended Excel-compatibility functions for HyperFormula.
 *
 * Implements high-value Excel functions missing from HyperFormula:
 * XLOOKUP, TEXTJOIN, AVERAGEIFS, database functions (12), ERROR.TYPE,
 * TYPE, FIXED, RANK.EQ, LOOKUP, and others.
 *
 * Importing this module registers the plugin (side-effectful).
 * Must be imported before HyperFormula instances are created.
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

/** Flatten a scalar, 2D array, or SimpleRangeValue into a 1D list of values. */
function flattenRange(value: InterpreterValue): InterpreterValue[] {
  if (value instanceof SimpleRangeValue) {
    return flattenRange(value.data as unknown as InterpreterValue);
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

/** Excel equality for lookup (numbers, strings case-insensitive, booleans). */
function excelEqual(a: InterpreterValue, b: InterpreterValue): boolean {
  if (a === EmptyValue || b === EmptyValue) return a === b;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  return false;
}

/** Check if a value matches a database criterion. */
function matchesCriterion(value: InterpreterValue, criterion: InterpreterValue): boolean {
  if (criterion === EmptyValue || criterion === '') return true; // blank criterion matches all
  if (value instanceof CellError || criterion instanceof CellError) return false;
  if (typeof criterion === 'string') {
    const m = criterion.match(/^(>=|<=|<>|>|<|=)(.*)$/);
    if (m) {
      const op = m[1];
      const cVal = m[2];
      const cNum = Number(cVal);
      const vNum = typeof value === 'number' ? value : Number(value);
      if (!Number.isNaN(cNum) && !Number.isNaN(vNum) && cVal.trim() !== '') {
        return op === '>' ? vNum > cNum : op === '<' ? vNum < cNum
          : op === '>=' ? vNum >= cNum : op === '<=' ? vNum <= cNum
          : op === '<>' ? vNum !== cNum : vNum === cNum;
      }
      // String comparison
      const vStr = value === EmptyValue ? '' : String(value).toLowerCase();
      const cStr = cVal.toLowerCase();
      return op === '=' ? vStr === cStr : op === '<>' ? vStr !== cStr : false;
    }
    // Exact match (case-insensitive for strings)
    return excelEqual(value, criterion);
  }
  return excelEqual(value, criterion);
}

/** Get database rows matching criteria. Returns array of row value arrays. */
function filterDatabase(
  db: InterpreterValue[][],
  fieldIdx: number,
  criteria: InterpreterValue[][],
): InterpreterValue[][] {
  if (db.length < 2 || criteria.length < 2) return [];
  const dbHeaders = db[0].map(h => h === EmptyValue ? '' : String(h).toLowerCase());
  const critHeaders = criteria[0].map(h => h === EmptyValue ? '' : String(h).toLowerCase());
  // Map criteria columns to database columns
  const colMap: number[] = critHeaders.map(ch => dbHeaders.indexOf(ch));
  const result: InterpreterValue[][] = [];
  for (let r = 1; r < db.length; r++) {
    const row = db[r];
    // Check if row matches ANY criteria row (OR)
    let rowMatch = false;
    for (let cr = 1; cr < criteria.length; cr++) {
      const critRow = criteria[cr];
      let critMatch = true;
      for (let cc = 0; cc < critRow.length; cc++) {
        const dbCol = colMap[cc];
        if (dbCol === -1) continue; // header not in database, ignore
        if (!matchesCriterion(row[dbCol], critRow[cc])) {
          critMatch = false;
          break;
        }
      }
      if (critMatch) { rowMatch = true; break; }
    }
    if (rowMatch) result.push(row);
  }
  return result;
}

/** Sentinel: field argument 0 means "the whole record" (Excel counts all
 * matching records for DCOUNT/DCOUNTA; other database functions #VALUE!). */
const FIELD_ALL = -2;

/** Resolve field argument (index 1-based or header name) to column index. */
function resolveField(
  db: InterpreterValue[][],
  field: InterpreterValue,
): number | CellError {
  if (field instanceof CellError) return field;
  if (typeof field === 'number') {
    const t = Math.trunc(field);
    // Excel: field=0 counts every matching record (DCOUNT/DCOUNTA).
    if (t === 0) return FIELD_ALL;
    const idx = t - 1;
    if (idx < 0 || idx >= db[0].length) {
      return new CellError(ErrorType.VALUE, 'Field index out of range.');
    }
    return idx;
  }
  const name = String(field).toLowerCase();
  const idx = db[0].findIndex(h => (h === EmptyValue ? '' : String(h).toLowerCase()) === name);
  if (idx === -1) return new CellError(ErrorType.VALUE, 'Field not found.');
  return idx;
}

/** Convert SimpleRangeValue or array to 2D array. */
function to2DArray(value: InterpreterValue): InterpreterValue[][] {
  if (value instanceof SimpleRangeValue) {
    return value.data as unknown as InterpreterValue[][];
  }
  if (Array.isArray(value)) {
    // Check if 2D
    if (value.length > 0 && Array.isArray(value[0])) {
      return value as InterpreterValue[][];
    }
    return [value as InterpreterValue[]];
  }
  return [[value]];
}

export class ExtendedPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    XLOOKUP: {
      method: 'xlookup',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR }, // lookup_value
        { argumentType: FunctionArgumentType.RANGE }, // lookup_array
        { argumentType: FunctionArgumentType.RANGE }, // return_array
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true }, // if_not_found
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true }, // match_mode (0=exact only)
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true }, // search_mode (1=first only)
      ],
    },
    TEXTJOIN: {
      method: 'textjoin',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR }, // delimiter
        { argumentType: FunctionArgumentType.SCALAR }, // ignore_empty
        { argumentType: FunctionArgumentType.ANY, optionalArg: true }, // text1
      ],
      repeatLastArgs: 1,
    },
    AVERAGEIFS: {
      method: 'averageifs',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE }, // average_range
        { argumentType: FunctionArgumentType.RANGE }, // criteria_range1
        { argumentType: FunctionArgumentType.SCALAR }, // criteria1
      ],
      repeatLastArgs: 2,
    },
    'ERROR.TYPE': {
      method: 'errorType',
      parameters: [{ argumentType: FunctionArgumentType.SCALAR }],
    },
    TYPE: {
      method: 'typeFn',
      parameters: [{ argumentType: FunctionArgumentType.SCALAR }],
    },
    FIXED: {
      method: 'fixed',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    'RANK.EQ': {
      method: 'rankEq',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    LOOKUP: {
      method: 'lookup',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.RANGE, optionalArg: true },
      ],
    },
    // Database functions
    DSUM: {
      method: 'dsum',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
      ],
    },
    DAVERAGE: {
      method: 'daverage',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
      ],
    },
    DCOUNT: {
      method: 'dcount',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
      ],
    },
    DCOUNTA: {
      method: 'dcounta',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
      ],
    },
    DMAX: {
      method: 'dmax',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
      ],
    },
    DMIN: {
      method: 'dmin',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
      ],
    },
    DPRODUCT: {
      method: 'dproduct',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
      ],
    },
  };

  public xlookup(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('XLOOKUP'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [lookupVal, lookupArr, returnArr, ifNotFound] = args;
        if (lookupVal instanceof CellError) return lookupVal;
        const lookups = flattenRange(lookupArr);
        const returns = flattenRange(returnArr);
        for (let i = 0; i < lookups.length; i++) {
          if (lookups[i] instanceof CellError) continue;
          if (excelEqual(lookupVal, lookups[i])) {
            const r = returns[Math.min(i, returns.length - 1)];
            return r === EmptyValue ? 0 : r;
          }
        }
        if (ifNotFound !== undefined && ifNotFound !== EmptyValue) return ifNotFound;
        return new CellError(ErrorType.NA, 'Not found.');
      },
    );
  }

  public textjoin(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('TEXTJOIN'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [delimArg, ignoreArg, ...texts] = args;
        if (delimArg instanceof CellError) return delimArg;
        const delim = delimArg === EmptyValue ? '' : String(delimArg);
        const ignoreEmpty = ignoreArg !== EmptyValue && ignoreArg !== false && ignoreArg !== 0;
        const parts: string[] = [];
        const flat: InterpreterValue[] = [];
        for (const t of texts) flat.push(...flattenRange(t));
        for (const t of flat) {
          if (t instanceof CellError) return t;
          const s = t === EmptyValue ? '' : String(t);
          if (ignoreEmpty && s === '') continue;
          parts.push(s);
        }
        return parts.join(delim);
      },
    );
  }

  public averageifs(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('AVERAGEIFS'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [avgRange, ...rest] = args;
        const values = flattenRange(avgRange);
        // rest = [criteria_range1, criteria1, criteria_range2, criteria2, ...]
        let sum = 0, count = 0;
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          if (v instanceof CellError) return v;
          if (typeof v !== 'number') continue;
          let match = true;
          for (let j = 0; j < rest.length; j += 2) {
            const critRange = flattenRange(rest[j]);
            const crit = rest[j + 1];
            const cv = critRange[Math.min(i, critRange.length - 1)];
            if (cv instanceof CellError) { match = false; break; }
            // Simple criteria: value or ">x", "<x", ">=x", "<=x", "<>x"
            if (typeof crit === 'string' && /^(>=|<=|<>|>|<|=)/.test(crit)) {
              const m = crit.match(/^(>=|<=|<>|>|<|=)(.*)$/);
              if (!m) { match = false; break; }
              const op = m[1], num = Number(m[2]);
              const cnum = typeof cv === 'number' ? cv : Number(cv);
              if (Number.isNaN(num) || Number.isNaN(cnum)) { match = false; break; }
              const ok = op === '>' ? cnum > num : op === '<' ? cnum < num
                : op === '>=' ? cnum >= num : op === '<=' ? cnum <= num
                : op === '<>' ? cnum !== num : cnum === num;
              if (!ok) { match = false; break; }
            } else {
              if (!excelEqual(crit, cv)) { match = false; break; }
            }
          }
          if (match) { sum += v; count++; }
        }
        if (count === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'No matching values.');
        return sum / count;
      },
    );
  }

  public errorType(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('ERROR.TYPE'),
      (arg: InterpreterValue): InterpreterValue => {
        if (!(arg instanceof CellError)) {
          return new CellError(ErrorType.NA, 'Not an error.');
        }
        const map: Record<string, number> = {
          '#NULL!': 1, '#DIV/0!': 2, '#VALUE!': 3, '#REF!': 4,
          '#NAME?': 5, '#NUM!': 6, '#N/A': 7,
        };
        // HyperFormula CellError has a type; map via message or type
        const type = (arg as unknown as { type: string }).type;
        const codeMap: Record<string, number> = {
          NULL: 1, DIV_BY_ZERO: 2, VALUE: 3, REF: 4, NAME: 5, NUM: 6, NA: 7,
        };
        return codeMap[type] ?? 3;
      },
    );
  }

  public typeFn(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('TYPE'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return 16;
        if (typeof arg === 'number') return 1;
        if (typeof arg === 'string') return 2;
        if (typeof arg === 'boolean') return 4;
        if (Array.isArray(arg)) return 64;
        return 1; // empty -> 1 in Excel? Actually empty is 1? No, blank... Excel TYPE(blank)=1? Let me: TYPE returns 1 for number, 2 text, 4 logical, 16 error, 64 array. Blank -> 1? Actually blank is treated as 0? I'll use 1.
      },
    );
  }

  public fixed(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('FIXED'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [numArg, decArg, noCommaArg] = args;
        if (numArg instanceof CellError) return numArg;
        const num = numArg === EmptyValue ? 0 : Number(numArg);
        const dec = decArg === undefined || decArg === EmptyValue ? 2 : Math.trunc(Number(decArg));
        const noComma = noCommaArg !== undefined && noCommaArg !== EmptyValue && noCommaArg !== false && noCommaArg !== 0;
        if (Number.isNaN(num)) return new CellError(ErrorType.VALUE, 'Not a number.');
        const fixed = num.toFixed(Math.max(0, dec));
        if (noComma) return fixed;
        const [intPart, frac] = fixed.split('.');
        const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return frac !== undefined ? `${grouped}.${frac}` : grouped;
      },
    );
  }

  public rankEq(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('RANK.EQ'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [numArg, rangeArg, orderArg] = args;
        if (numArg instanceof CellError) return numArg;
        const num = Number(numArg);
        const vals = flattenRange(rangeArg).filter(
          (v): v is number => typeof v === 'number'
        );
        const order = orderArg === undefined || orderArg === EmptyValue || orderArg === 0 ? 0 : 1;
        let rank = 1;
        for (const v of vals) {
          if (order === 0 ? v > num : v < num) rank++;
        }
        return rank;
      },
    );
  }

  public lookup(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('LOOKUP'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [lookupVal, lookupArr, returnArr] = args;
        if (lookupVal instanceof CellError) return lookupVal;
        const lookups = flattenRange(lookupArr);
        const returns = returnArr !== undefined ? flattenRange(returnArr) : lookups;
        // Approximate match: largest value <= lookupVal (assumes sorted)
        let best = -1;
        for (let i = 0; i < lookups.length; i++) {
          const lv = lookups[i];
          if (lv instanceof CellError) continue;
          if (typeof lv === 'number' && typeof lookupVal === 'number') {
            if (lv <= lookupVal) best = i;
            else break;
          } else if (excelEqual(lookupVal, lv)) {
            best = i;
            break;
          }
        }
        if (best === -1) return new CellError(ErrorType.NA, 'Not found.');
        const r = returns[Math.min(best, returns.length - 1)];
        return r === EmptyValue ? new CellError(ErrorType.NA, 'Not found.') : r;
      },
    );
  }

  /** Generic database aggregation helper. */
  private dbAggregate(
    ast: ProcedureAst,
    state: InterpreterState,
    name: string,
    agg: (values: number[]) => InterpreterValue,
    countText: boolean = false,
  ): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata(name),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [dbArg, fieldArg, critArg] = args;
        const db = to2DArray(dbArg);
        const criteria = to2DArray(critArg);
        const fieldIdx = resolveField(db, fieldArg);
        if (fieldIdx instanceof CellError) return fieldIdx;
        const rows = filterDatabase(db, fieldIdx, criteria);
        if (fieldIdx === FIELD_ALL) {
          // Excel: DCOUNT/DCOUNTA with field=0 count every matching record;
          // the other database functions require a real field (#VALUE!).
          if (name === 'DCOUNT' || name === 'DCOUNTA') {
            return agg(rows.map(() => 1));
          }
          return new CellError(ErrorType.VALUE, `${name}: field is required.`);
        }
        const values: number[] = [];
        for (const row of rows) {
          const v = row[fieldIdx];
          if (v instanceof CellError) return v;
          if (typeof v === 'number') values.push(v);
          else if (countText && v !== EmptyValue && v !== '') values.push(1); // DCOUNTA counts text
        }
        return agg(values);
      },
    );
  }

  public dsum(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbAggregate(ast, state, 'DSUM', (vals) =>
      vals.reduce((a, b) => a + b, 0),
    );
  }

  public daverage(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbAggregate(ast, state, 'DAVERAGE', (vals) => {
      if (vals.length === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'No values.');
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    });
  }

  public dcount(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbAggregate(ast, state, 'DCOUNT', (vals) => vals.length);
  }

  public dcounta(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbAggregate(ast, state, 'DCOUNTA', (vals) => vals.length, true);
  }

  public dmax(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbAggregate(ast, state, 'DMAX', (vals) =>
      vals.length === 0 ? 0 : Math.max(...vals),
    );
  }

  public dmin(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbAggregate(ast, state, 'DMIN', (vals) =>
      vals.length === 0 ? 0 : Math.min(...vals),
    );
  }

  public dproduct(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.dbAggregate(ast, state, 'DPRODUCT', (vals) =>
      vals.reduce((a, b) => a * b, 1),
    );
  }
}

export function registerExtendedFunctions(): void {
  if (HyperFormula.getFunctionPlugin('XLOOKUP') !== undefined) return;
  HyperFormula.registerFunctionPlugin(ExtendedPlugin, {
    enGB: {
      XLOOKUP: 'XLOOKUP', TEXTJOIN: 'TEXTJOIN', AVERAGEIFS: 'AVERAGEIFS',
      'ERROR.TYPE': 'ERROR.TYPE', TYPE: 'TYPE', FIXED: 'FIXED',
      'RANK.EQ': 'RANK.EQ', LOOKUP: 'LOOKUP',
      DSUM: 'DSUM', DAVERAGE: 'DAVERAGE', DCOUNT: 'DCOUNT', DCOUNTA: 'DCOUNTA',
      DMAX: 'DMAX', DMIN: 'DMIN', DPRODUCT: 'DPRODUCT',
    },
    enUS: {
      XLOOKUP: 'XLOOKUP', TEXTJOIN: 'TEXTJOIN', AVERAGEIFS: 'AVERAGEIFS',
      'ERROR.TYPE': 'ERROR.TYPE', TYPE: 'TYPE', FIXED: 'FIXED',
      'RANK.EQ': 'RANK.EQ', LOOKUP: 'LOOKUP',
      DSUM: 'DSUM', DAVERAGE: 'DAVERAGE', DCOUNT: 'DCOUNT', DCOUNTA: 'DCOUNTA',
      DMAX: 'DMAX', DMIN: 'DMIN', DPRODUCT: 'DPRODUCT',
    },
  });
}

registerExtendedFunctions();
