/**
 * GROUPBY and PIVOTBY dynamic-array functions (Microsoft 365, 2024).
 *
 * Implemented to the Microsoft Support specifications ("GROUPBY function",
 * "PIVOTBY function"):
 *
 *   GROUPBY(row_fields, values, function, [field_headers], [total_depth],
 *           [sort_order], [filter_array], [field_relationship])
 *   PIVOTBY(row_fields, col_fields, values, function, [field_headers],
 *           [row_total_depth], [row_sort_order], [col_total_depth],
 *           [col_sort_order], [filter_array], [relative_to])
 *
 * Semantics implemented in full:
 * - Grouping by distinct combinations of one or more row fields (and, for
 *   PIVOTBY, column fields), aggregating `values` per group. Multiple value
 *   columns produce multiple aggregations; a vector of functions (HSTACK for
 *   column-wise layout, VSTACK for row-wise layout) produces multiple
 *   aggregations per value column.
 * - The `function` argument is an eta-reduced lambda (a bare function name
 *   such as SUM, AVERAGE, COUNT, COUNTA, MAX, MIN, PRODUCT, PERCENTOF), an
 *   explicit LAMBDA (one argument = the group's values; two arguments = the
 *   group's values and a "total set" of values), or a vector of those.
 *   A bare function name reaches the plugin as a NAMED_EXPRESSION AST node
 *   (verified against HyperFormula's parser); it is never evaluated as a
 *   name — it is turned back into a function call over the group's values.
 *   PERCENTOF(subset, totalset) is SUM(subset)/SUM(totalset).
 * - field_headers: 0 = no headers; 1 = headers present, don't show;
 *   2 = no headers, but generate ("Row Field n" / "Column Field n" /
 *   "Value n"); 3 = headers present and show; omitted = automatic detection
 *   (a text first row over a numeric second row is treated as headers and
 *   not shown, matching Excel's automatic mode).
 * - total_depth (and row_/col_total_depth): 0 = no totals; 1 = grand
 *   totals; 2 = grand totals and subtotals; -1 / -2 = the same at the top.
 *   Omitted = grand totals (Excel's automatic behaviour). |depth| may not
 *   exceed the number of fields; subtotals require at least 2 fields.
 * - sort_order: a signed column number (columns are the row fields followed
 *   by the aggregated value columns), or a vector of such numbers when
 *   sorting by row fields only. Positive = ascending, negative =
 *   descending. Sorting is hierarchical: a value column sorts parent groups
 *   by their subtotal. The default is ascending by each field in order.
 * - filter_array: a column-oriented Boolean array, one entry per source row
 *   (it may include the header row's entry when the data ranges do).
 * - field_relationship (GROUPBY): 0 = hierarchy (default; later fields sort
 *   within earlier ones, subtotals supported); 1 = table (each field sorts
 *   independently; subtotals are not supported and return #VALUE!).
 * - relative_to (PIVOTBY) selects the total set passed as the second
 *   argument of a two-argument aggregation: 0 = column totals (default),
 *   1 = row totals, 2 = grand totals, 3 = parent column total,
 *   4 = parent row total.
 *
 * Results are returned as 2D arrays and spill exactly like FILTER/SORT
 * (see dynamic-arrays.ts). Importing this module registers the plugin.
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
import type { Ast, ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { to2DArray, type ArrayResult } from './dynamic-arrays.js';
import { LambdaValue, applyLambdaValue } from './lambda-functions.js';

type Val = InterpreterValue;

/** EMPTY, typed as an interpreter value (the package's main export
 * types it as a plain symbol, which does not assign to InterpreterValue). */
const EMPTY: Val = EmptyValue as unknown as Val;

function valueErr(message: string): CellError {
  return new CellError(ErrorType.VALUE, message);
}

function asValue(arr: ArrayResult): InterpreterValue {
  return arr as unknown as InterpreterValue;
}

/** Excel-like comparison: numbers < strings < booleans; blanks/errors last. */
function compareValues(a: Val, b: Val): number {
  if (a instanceof CellError) return b instanceof CellError ? 0 : 1;
  if (b instanceof CellError) return -1;
  if (a === EMPTY) return b === EMPTY ? 0 : 1;
  if (b === EMPTY) return -1;
  const rank = (v: Val): number =>
    typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    return al < bl ? -1 : al > bl ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return 0;
}

/** Grouping equality: case-insensitive strings, like UNIQUE. */
function keyOf(v: Val): string {
  if (v === EMPTY) return 'e:';
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'string') return `s:${v.toLowerCase()}`;
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  return `x:${String(v)}`;
}

function tupleKey(key: Val[]): string {
  return key.map(keyOf).join('');
}

function prefixMatches(key: Val[], prefix: Val[]): boolean {
  if (prefix.length > key.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (keyOf(key[i]!) !== keyOf(prefix[i]!)) return false;
  }
  return true;
}

/** Convert an evaluated value into a literal AST (mirrors lambda-functions). */
function valueToAst(value: Val): Ast {
  if (value instanceof CellError) {
    return { type: 'ERROR', error: value } as unknown as Ast;
  }
  if (value === EMPTY) return { type: 'EMPTY' } as unknown as Ast;
  if (typeof value === 'number') return { type: 'NUMBER', value } as unknown as Ast;
  if (typeof value === 'string') return { type: 'STRING', value } as unknown as Ast;
  if (typeof value === 'boolean') {
    return {
      type: 'FUNCTION_CALL',
      procedureName: value ? 'TRUE' : 'FALSE',
      args: [],
    } as unknown as Ast;
  }
  if (value instanceof SimpleRangeValue) {
    return valueToAst(value.data as unknown as Val);
  }
  if (Array.isArray(value)) {
    const m = to2DArray(value as unknown as Val);
    return {
      type: 'ARRAY',
      args: m.map((row) => row.map((v) => valueToAst(v))),
    } as unknown as Ast;
  }
  return { type: 'EMPTY' } as unknown as Ast;
}

/** A column-vector array AST: {v1; v2; ...}. */
function columnArrayAst(values: Val[]): Ast {
  return {
    type: 'ARRAY',
    args: values.map((v) => [valueToAst(v)]),
  } as unknown as Ast;
}

/** A column-vector interpreter value (what a LAMBDA parameter receives). */
function columnValue(values: Val[]): Val {
  return values.map((v) => [v]) as unknown as Val;
}

function sumNumbers(values: Val[]): number {
  let s = 0;
  for (const v of values) if (typeof v === 'number') s += v;
  return s;
}

/** One aggregation: an eta-reduced function name or a user LAMBDA. */
interface Aggregator {
  label: string;
  /** True when the aggregation consumes a second (total set) argument. */
  twoArg: boolean;
  invoke: (subset: Val[], totalset: Val[], state: InterpreterState) => Val;
}

interface ParsedFunctions {
  list: Aggregator[];
  /** 'cols' = one output column per function; 'rows' = one row per function. */
  orientation: 'cols' | 'rows';
}

/** A node in a grouping hierarchy (one field level). */
interface GroupNode {
  value: Val;
  prefix: Val[];
  children: GroupNode[];
  /** Source-row indices of every record under this node. */
  allRows: number[];
}

/** A flattened output slot: a detail group, a subtotal, or the grand total. */
interface Slot {
  kind: 'detail' | 'subtotal' | 'grand';
  /** Grouping prefix this slot aggregates (full key for detail slots). */
  prefix: Val[];
  /** Depth of the prefix (0 for the grand total). */
  level: number;
}

interface PreparedData {
  rowKeys: Val[][];
  colKeys: Val[][];
  vals: Val[][];
  rowCount: number;
  rowFieldCount: number;
  colFieldCount: number;
  valueCount: number;
  showHeaders: boolean;
  rowHeaders: Val[];
  colHeaders: Val[];
  valHeaders: Val[];
}

export class GroupByPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    GROUPBY: {
      method: 'groupby',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
      ],
    },
    PIVOTBY: {
      method: 'pivotby',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
        { argumentType: FunctionArgumentType.ANY, optionalArg: true },
      ],
    },
  };

  // -------------------------------------------------------------------------
  // Argument evaluation helpers (arguments are evaluated manually because
  // the `function` argument must be inspected as an AST, never evaluated
  // as a value: a bare SUM arrives as a NAMED_EXPRESSION).
  // -------------------------------------------------------------------------

  private evalArg(ast: Ast | undefined, state: InterpreterState): Val {
    if (ast === undefined) return EMPTY;
    try {
      return this.interpreter.evaluateAst(ast, state);
    } catch {
      return valueErr('Argument evaluation failed.');
    }
  }

  /**
   * Evaluate an argument in array context (arraysFlag set): GROUPBY /
   * PIVOTBY data arguments are array-valued in Excel, so elementwise
   * expressions over ranges (A2:A6<>"West", MONTH(A2:A6), ...) must
   * vectorize instead of implicit-intersecting against the formula cell.
   */
  private evalArrayArg(ast: Ast, state: InterpreterState): Val {
    const arrayState = Object.assign(
      Object.create(Object.getPrototypeOf(state)) as InterpreterState,
      state,
      { arraysFlag: true },
    );
    try {
      return this.interpreter.evaluateAst(ast, arrayState);
    } catch {
      return valueErr('Argument evaluation failed.');
    }
  }

  /** Evaluate an optional numeric argument; undefined AST = use default. */
  private numArg(
    ast: Ast | undefined,
    state: InterpreterState,
    dflt: number,
  ): number | CellError {
    if (ast === undefined) return dflt;
    const v = this.evalArg(ast, state);
    if (v === EMPTY || v === undefined) return dflt;
    if (v instanceof CellError) return v;
    const n = Number(v);
    if (!Number.isFinite(n)) return valueErr('Expected a number.');
    return Math.trunc(n);
  }

  /** Evaluate a sort_order argument into a list of signed column numbers. */
  private sortArg(
    ast: Ast | undefined,
    state: InterpreterState,
  ): number[] | CellError | undefined {
    if (ast === undefined) return undefined;
    const v = this.evalArg(ast, state);
    if (v === EMPTY || v === undefined) return undefined;
    if (v instanceof CellError) return v;
    const flat: Val[] = [];
    for (const row of to2DArray(v)) for (const c of row) flat.push(c);
    const out: number[] = [];
    for (const item of flat) {
      if (item === EMPTY) continue;
      const n = Number(item);
      if (!Number.isFinite(n) || Math.trunc(n) === 0 || Math.trunc(n) !== n) {
        return valueErr('sort_order entries must be non-zero integers.');
      }
      out.push(Math.trunc(n));
    }
    return out.length === 0 ? undefined : out;
  }

  // -------------------------------------------------------------------------
  // The `function` argument
  // -------------------------------------------------------------------------

  private etaAggregator(name: string): Aggregator {
    const upper = name.toUpperCase();
    if (upper === 'PERCENTOF') {
      return {
        label: upper,
        twoArg: true,
        invoke: (subset, totalset) => {
          const denom = sumNumbers(totalset);
          if (denom === 0) {
            return new CellError(ErrorType.DIV_BY_ZERO, 'PERCENTOF: total set sums to zero.');
          }
          return sumNumbers(subset) / denom;
        },
      };
    }
    return {
      label: upper,
      twoArg: false,
      invoke: (subset, _totalset, state) => {
        const call = {
          type: 'FUNCTION_CALL',
          procedureName: upper,
          args: [columnArrayAst(subset)],
        } as unknown as Ast;
        let result: Val;
        try {
          result = this.interpreter.evaluateAst(call, state);
        } catch {
          return valueErr(`Aggregation ${upper} failed.`);
        }
        if (Array.isArray(result) || result instanceof SimpleRangeValue) {
          const m = to2DArray(result);
          return m[0]?.[0] ?? EMPTY;
        }
        return result;
      },
    };
  }

  private lambdaAggregator(lambda: LambdaValue): Aggregator {
    return {
      label: 'LAMBDA',
      twoArg: lambda.params.length >= 2,
      invoke: (subset, totalset, state) => {
        const args: Val[] = lambda.params.length >= 2
          ? [columnValue(subset), columnValue(totalset)]
          : [columnValue(subset)];
        return applyLambdaValue(lambda, args, this.interpreter, state, 0);
      },
    };
  }

  /** Parse one function element: a bare name or a LAMBDA(...) call. */
  private parseFunctionElement(ast: Ast, state: InterpreterState): Aggregator | CellError {
    const node = ast as unknown as { type: string; expressionName?: string; procedureName?: string };
    if (node.type === 'NAMED_EXPRESSION') {
      // Eta-reduced lambda: a bare function name (SUM, AVERAGE, ...).
      return this.etaAggregator(String(node.expressionName ?? ''));
    }
    if (node.type === 'FUNCTION_CALL' && String(node.procedureName).toUpperCase() === 'LAMBDA') {
      const v = this.evalArg(ast, state);
      if (v instanceof LambdaValue) return this.lambdaAggregator(v);
      if (v instanceof CellError) return v;
      return valueErr('Invalid LAMBDA in function argument.');
    }
    // Anything else (a named function returning a LAMBDA, a LET, ...):
    // evaluate it and accept a LAMBDA value.
    const v = this.evalArg(ast, state);
    if (v instanceof LambdaValue) return this.lambdaAggregator(v);
    if (v instanceof CellError) return v;
    return valueErr('The function argument must be a function name or a LAMBDA.');
  }

  /** Parse the whole `function` argument, including HSTACK/VSTACK vectors. */
  private parseFunctions(ast: Ast, state: InterpreterState): ParsedFunctions | CellError {
    const node = ast as unknown as { type: string; procedureName?: string; args?: Ast[] };
    if (node.type === 'FUNCTION_CALL') {
      const proc = String(node.procedureName).toUpperCase();
      const args = node.args ?? [];
      if (proc === 'HSTACK') {
        const list: Aggregator[] = [];
        for (const a of args) {
          const el = this.parseFunctionElement(a, state);
          if (el instanceof CellError) return el;
          list.push(el);
        }
        if (list.length === 0) return valueErr('Empty function vector.');
        return { list, orientation: 'cols' };
      }
      if (proc === 'VSTACK') {
        // VSTACK(HSTACK(f1, f2, ...), {"Label1", "Label2", ...}) supplies
        // custom calculation labels for a column-wise vector.
        if (args.length === 2) {
          const second = args[1] as unknown as { type: string };
          const first = args[0] as unknown as { type: string; procedureName?: string };
          if (
            second.type === 'ARRAY' &&
            first.type === 'FUNCTION_CALL' &&
            String(first.procedureName).toUpperCase() === 'HSTACK'
          ) {
            const inner = this.parseFunctions(args[0]!, state);
            if (inner instanceof CellError) return inner;
            const labelValue = this.evalArg(args[1]!, state);
            if (labelValue instanceof CellError) return labelValue;
            const labels: Val[] = [];
            for (const row of to2DArray(labelValue)) for (const c of row) labels.push(c);
            if (labels.length !== inner.list.length) {
              return valueErr('Custom labels must match the number of functions.');
            }
            labels.forEach((label, i) => {
              inner.list[i]!.label = String(label);
            });
            return inner;
          }
        }
        const list: Aggregator[] = [];
        for (const a of args) {
          const el = this.parseFunctionElement(a, state);
          if (el instanceof CellError) return el;
          list.push(el);
        }
        if (list.length === 0) return valueErr('Empty function vector.');
        return { list, orientation: 'rows' };
      }
    }
    const single = this.parseFunctionElement(ast, state);
    if (single instanceof CellError) return single;
    return { list: [single], orientation: 'cols' };
  }

  // -------------------------------------------------------------------------
  // Input preparation: headers, filtering, alignment checks
  // -------------------------------------------------------------------------

  private prepare(
    rowAst: Ast | undefined,
    colAst: Ast | undefined,
    valuesAst: Ast,
    filterAst: Ast | undefined,
    fieldHeaders: number | undefined,
    state: InterpreterState,
  ): PreparedData | CellError {
    const emptyArg = (a: Ast | undefined): boolean =>
      a === undefined || (a as unknown as { type: string }).type === 'EMPTY';
    const rowM: ArrayResult = emptyArg(rowAst) ? [] : to2DArray(this.evalArrayArg(rowAst!, state));
    const colM: ArrayResult = emptyArg(colAst) ? [] : to2DArray(this.evalArrayArg(colAst!, state));
    const valM: ArrayResult = to2DArray(this.evalArrayArg(valuesAst, state));
    for (const m of [rowM, colM, valM]) {
      for (const row of m) {
        for (const v of row) if (v instanceof CellError) return v;
      }
    }
    if (valM.length === 0 || (valM[0]?.length ?? 0) === 0) {
      return valueErr('values must not be empty.');
    }
    const rawRows = valM.length;
    if (rowM.length !== 0 && rowM.length !== rawRows) {
      return valueErr('row_fields and values must have the same number of rows.');
    }
    if (colM.length !== 0 && colM.length !== rawRows) {
      return valueErr('col_fields and values must have the same number of rows.');
    }
    const R = rowM.length === 0 ? 0 : (rowM[0]?.length ?? 0);
    const C = colM.length === 0 ? 0 : (colM[0]?.length ?? 0);
    const V = valM[0]?.length ?? 0;

    // field_headers resolution.
    let hasHeaders = false;
    let showHeaders = false;
    let generated = false;
    if (fieldHeaders === undefined) {
      // Automatic: a text first row over a numeric second row is a header.
      hasHeaders = this.detectHeaders([rowM, colM, valM], rawRows);
      showHeaders = false;
    } else if (fieldHeaders === 0) {
      hasHeaders = false;
    } else if (fieldHeaders === 1) {
      hasHeaders = true;
    } else if (fieldHeaders === 2) {
      hasHeaders = false;
      showHeaders = true;
      generated = true;
    } else if (fieldHeaders === 3) {
      hasHeaders = true;
      showHeaders = true;
    } else {
      return valueErr('field_headers must be 0, 1, 2 or 3.');
    }

    const headerOf = (m: ArrayResult, width: number, kind: 'Row' | 'Column' | 'Value'): Val[] => {
      if (generated) {
        return Array.from({ length: width }, (_, i) =>
          kind === 'Value' ? `Value ${i + 1}` : `${kind} Field ${i + 1}`,
        );
      }
      if (hasHeaders && m.length > 0) return (m[0] ?? []).slice(0, width);
      return Array.from({ length: width }, () => EMPTY);
    };
    const rowHeaders = headerOf(rowM, R, 'Row');
    const colHeaders = headerOf(colM, C, 'Column');
    const valHeaders = headerOf(valM, V, 'Value');

    const strip = (m: ArrayResult): ArrayResult => (hasHeaders ? m.slice(1) : m);
    const rowData = strip(rowM);
    const colData = strip(colM);
    const valData = strip(valM);
    const dataRows = valData.length;

    // filter_array: one Boolean per source row (the header row's entry, if
    // present, is included when the array spans the raw ranges).
    let keep: boolean[] | undefined;
    if (filterAst !== undefined && !emptyArg(filterAst)) {
      const fv = this.evalArrayArg(filterAst, state);
      if (fv instanceof CellError) return fv;
      const flat: Val[] = [];
      for (const row of to2DArray(fv)) for (const c of row) flat.push(c);
      let mask: Val[];
      if (flat.length === rawRows) {
        mask = hasHeaders ? flat.slice(1) : flat;
      } else if (flat.length === dataRows) {
        mask = flat;
      } else {
        return valueErr('filter_array must have one entry per row of data.');
      }
      keep = mask.map((v) => v === true || (typeof v === 'number' && v !== 0));
    }

    const rowKeys: Val[][] = [];
    const colKeys: Val[][] = [];
    const vals: Val[][] = [];
    for (let i = 0; i < dataRows; i++) {
      if (keep !== undefined && !keep[i]) continue;
      rowKeys.push(R === 0 ? [] : (rowData[i] ?? []).slice(0, R));
      colKeys.push(C === 0 ? [] : (colData[i] ?? []).slice(0, C));
      vals.push((valData[i] ?? []).slice(0, V));
    }
    return {
      rowKeys,
      colKeys,
      vals,
      rowCount: vals.length,
      rowFieldCount: R,
      colFieldCount: C,
      valueCount: V,
      showHeaders,
      rowHeaders,
      colHeaders,
      valHeaders,
    };
  }

  private detectHeaders(mats: ArrayResult[], rawRows: number): boolean {
    if (rawRows < 2) return false;
    for (const m of mats) {
      if (m.length < 2) continue;
      const width = m[0]?.length ?? 0;
      for (let c = 0; c < width; c++) {
        if (typeof m[0]?.[c] === 'string' && typeof m[1]?.[c] === 'number') return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Grouping trees, sorting, and slot flattening
  // -------------------------------------------------------------------------

  private buildTree(keys: Val[][], fieldCount: number): GroupNode[] {
    const build = (indices: number[], level: number, prefix: Val[]): GroupNode[] => {
      const byKey = new Map<string, { value: Val; rows: number[] }>();
      for (const i of indices) {
        const v = keys[i]?.[level] ?? EMPTY;
        const k = keyOf(v);
        let entry = byKey.get(k);
        if (entry === undefined) {
          entry = { value: v, rows: [] };
          byKey.set(k, entry);
        }
        entry.rows.push(i);
      }
      const nodes: GroupNode[] = [];
      for (const entry of byKey.values()) {
        const nodePrefix: Val[] = [...prefix, entry.value];
        nodes.push({
          value: entry.value,
          prefix: nodePrefix,
          children: level + 1 < fieldCount ? build(entry.rows, level + 1, nodePrefix) : [],
          allRows: entry.rows,
        });
      }
      return nodes;
    };
    if (fieldCount === 0) return [];
    return build(
      keys.map((_, i) => i),
      0,
      [],
    );
  }

  /**
   * Sort a grouping tree. `aggCompare(node, aggIndex)` supplies the
   * aggregated value of an output column for a node (used when sort_order
   * references a value column: parent groups sort by their subtotal).
   * Sort keys are 1-based output columns: fields first, then aggregations.
   */
  private sortTree(
    nodes: GroupNode[],
    level: number,
    fieldCount: number,
    sortKeys: number[] | undefined,
    aggCount: number,
    aggCompare: (node: GroupNode, aggIndex: number) => Val,
  ): void {
    const comparator = (a: GroupNode, b: GroupNode): number => {
      if (sortKeys !== undefined) {
        for (const key of sortKeys) {
          const col = Math.abs(key);
          const dir = key < 0 ? -1 : 1;
          if (col <= fieldCount) {
            if (col - 1 === level) {
              const cmp = compareValues(a.value, b.value);
              if (cmp !== 0) return dir * cmp;
            }
            // Shallower/deeper field keys do not order this level.
          } else if (col - fieldCount - 1 < aggCount) {
            const cmp = compareValues(
              aggCompare(a, col - fieldCount - 1),
              aggCompare(b, col - fieldCount - 1),
            );
            if (cmp !== 0) return dir * cmp;
          }
        }
      }
      return compareValues(a.value, b.value);
    };
    nodes.sort(comparator);
    for (const node of nodes) {
      if (node.children.length > 0) {
        this.sortTree(node.children, level + 1, fieldCount, sortKeys, aggCount, aggCompare);
      }
    }
  }

  /** Flatten a sorted tree into output slots honouring total_depth. */
  private flattenTree(nodes: GroupNode[], depth: number, fieldCount: number): Slot[] {
    const abs = Math.abs(depth);
    const atTop = depth < 0;
    const slots: Slot[] = [];
    const grand: Slot = { kind: 'grand', prefix: [], level: 0 };
    if (abs >= 1 && atTop) slots.push(grand);
    const walk = (list: GroupNode[], level: number): void => {
      for (const node of list) {
        const subtotal =
          abs >= level + 2 && level < fieldCount - 1
            ? ({ kind: 'subtotal', prefix: node.prefix, level: level + 1 } as Slot)
            : undefined;
        if (subtotal !== undefined && atTop) slots.push(subtotal);
        if (node.children.length > 0) {
          walk(node.children, level + 1);
        } else {
          slots.push({ kind: 'detail', prefix: node.prefix, level: fieldCount });
        }
        if (subtotal !== undefined && !atTop) slots.push(subtotal);
      }
    };
    walk(nodes, 0);
    if (abs >= 1 && !atTop) slots.push(grand);
    return slots;
  }

  /** Label cells for a slot: key values, with "Total" marking total rows. */
  private slotLabels(slot: Slot, fieldCount: number): Val[] {
    const out: Val[] = [];
    for (let i = 0; i < fieldCount; i++) {
      if (slot.kind === 'detail') out.push(slot.prefix[i] ?? EMPTY);
      else if (slot.kind === 'grand') out.push(i === 0 ? 'Total' : EMPTY);
      else out.push(i < slot.level ? (slot.prefix[i] ?? EMPTY) : i === slot.level ? 'Total' : EMPTY);
    }
    return out;
  }

  private validateDepth(depth: number, fieldCount: number): CellError | undefined {
    if (Math.abs(depth) > Math.max(fieldCount, 0) && depth !== 0) {
      // Grand totals alone (depth 1) are always legal; deeper totals need
      // enough fields to subtotal.
      if (Math.abs(depth) > 1) {
        return valueErr('total_depth exceeds the number of fields.');
      }
    }
    if (Math.abs(depth) >= 2 && fieldCount < 2) {
      return valueErr('Subtotals require at least two fields.');
    }
    return undefined;
  }

  private validateSort(
    sortKeys: number[] | undefined,
    fieldCount: number,
    aggCount: number,
  ): CellError | undefined {
    if (sortKeys === undefined) return undefined;
    for (const key of sortKeys) {
      if (Math.abs(key) > fieldCount + aggCount) {
        return valueErr('sort_order column is out of range.');
      }
    }
    if (sortKeys.length > 1) {
      for (const key of sortKeys) {
        if (Math.abs(key) > fieldCount) {
          return valueErr('A sort_order vector may only reference field columns.');
        }
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // GROUPBY
  // -------------------------------------------------------------------------

  public groupby(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length < 3) {
      return new CellError(ErrorType.NA, 'GROUPBY needs row_fields, values and function.');
    }
    const fieldHeaders = this.numArg(args[3], state, Number.NaN);
    if (fieldHeaders instanceof CellError) return fieldHeaders;
    const totalDepthRaw = this.numArg(args[4], state, 1);
    if (totalDepthRaw instanceof CellError) return totalDepthRaw;
    const sortKeys = this.sortArg(args[5], state);
    if (sortKeys instanceof CellError) return sortKeys;
    const relationshipRaw = this.numArg(args[7], state, 0);
    if (relationshipRaw instanceof CellError) return relationshipRaw;
    if (relationshipRaw !== 0 && relationshipRaw !== 1) {
      return valueErr('field_relationship must be 0 (hierarchy) or 1 (table).');
    }
    const fns = this.parseFunctions(args[2]!, state);
    if (fns instanceof CellError) return fns;

    const data = this.prepare(
      args[0],
      undefined,
      args[1]!,
      args[6],
      Number.isNaN(fieldHeaders) ? undefined : fieldHeaders,
      state,
    );
    if (data instanceof CellError) return data;
    const R = data.rowFieldCount;
    if (R === 0) return valueErr('GROUPBY requires row_fields.');
    const depthErr = this.validateDepth(totalDepthRaw, R);
    if (depthErr !== undefined) return depthErr;
    if (relationshipRaw === 1 && Math.abs(totalDepthRaw) >= 2) {
      return valueErr('Subtotals are not supported when field_relationship is Table.');
    }

    // Aggregation columns: (value column x function), value-major.
    const aggCols: Array<{ valCol: number; agg: Aggregator }> = [];
    if (fns.orientation === 'cols') {
      for (let v = 0; v < data.valueCount; v++) {
        for (const agg of fns.list) aggCols.push({ valCol: v, agg });
      }
    } else {
      for (let v = 0; v < data.valueCount; v++) aggCols.push({ valCol: v, agg: fns.list[0]! });
    }
    const sortErr = this.validateSort(sortKeys, R, aggCols.length);
    if (sortErr !== undefined) return sortErr;

    const allIndices = data.vals.map((_, i) => i);
    const aggregate = (indices: number[], valCol: number, agg: Aggregator): Val => {
      const subset = indices.map((i) => data.vals[i]?.[valCol] ?? EMPTY);
      const totalset = allIndices.map((i) => data.vals[i]?.[valCol] ?? EMPTY);
      return agg.invoke(subset, totalset, state);
    };

    // Build and order the output rows.
    interface OutRow {
      labels: Val[];
      indices: number[];
    }
    const outRows: OutRow[] = [];
    if (relationshipRaw === 1) {
      // Table mode: leaf groups sorted flat by the sort keys (each field
      // sorts independently of the hierarchy).
      const leaves = new Map<string, { key: Val[]; indices: number[] }>();
      data.rowKeys.forEach((key, i) => {
        const k = tupleKey(key);
        let leaf = leaves.get(k);
        if (leaf === undefined) {
          leaf = { key, indices: [] };
          leaves.set(k, leaf);
        }
        leaf.indices.push(i);
      });
      const leafList = [...leaves.values()];
      const leafAgg = (leaf: { key: Val[]; indices: number[] }, aggIndex: number): Val => {
        const col = aggCols[aggIndex]!;
        return aggregate(leaf.indices, col.valCol, col.agg);
      };
      leafList.sort((a, b) => {
        if (sortKeys !== undefined) {
          for (const key of sortKeys) {
            const col = Math.abs(key);
            const dir = key < 0 ? -1 : 1;
            const cmp =
              col <= R
                ? compareValues(a.key[col - 1]!, b.key[col - 1]!)
                : compareValues(leafAgg(a, col - R - 1), leafAgg(b, col - R - 1));
            if (cmp !== 0) return dir * cmp;
          }
          return 0;
        }
        for (let f = 0; f < R; f++) {
          const cmp = compareValues(a.key[f]!, b.key[f]!);
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
      const grand: OutRow = { labels: this.slotLabels({ kind: 'grand', prefix: [], level: 0 }, R), indices: allIndices };
      if (totalDepthRaw <= -1) outRows.push(grand);
      for (const leaf of leafList) outRows.push({ labels: leaf.key, indices: leaf.indices });
      if (totalDepthRaw >= 1) outRows.push(grand);
    } else {
      const tree = this.buildTree(data.rowKeys, R);
      this.sortTree(tree, 0, R, sortKeys, aggCols.length, (node, aggIndex) => {
        const col = aggCols[aggIndex]!;
        return aggregate(node.allRows, col.valCol, col.agg);
      });
      const slots = this.flattenTree(tree, totalDepthRaw, R);
      for (const slot of slots) {
        const indices =
          slot.kind === 'grand'
            ? allIndices
            : allIndices.filter((i) => prefixMatches(data.rowKeys[i]!, slot.prefix));
        outRows.push({ labels: this.slotLabels(slot, R), indices });
      }
    }

    // Assemble the result grid.
    const out: ArrayResult = [];
    const multiFunc = fns.list.length > 1;
    if (data.showHeaders && multiFunc && data.valueCount > 1 && fns.orientation === 'cols') {
      const top: Val[] = [
        ...Array.from({ length: R }, () => EMPTY),
        ...aggCols.map((c) => data.valHeaders[c.valCol] ?? EMPTY),
      ];
      const bottom: Val[] = [
        ...data.rowHeaders,
        ...aggCols.map((c) => c.agg.label),
      ];
      out.push(top, bottom);
    } else if (data.showHeaders || (multiFunc && fns.orientation === 'cols')) {
      const header: Val[] = [
        ...(data.showHeaders ? data.rowHeaders : Array.from({ length: R }, () => EMPTY)),
        ...aggCols.map((c) =>
          multiFunc && fns.orientation === 'cols'
            ? c.agg.label
            : (data.valHeaders[c.valCol] ?? EMPTY),
        ),
      ];
      out.push(header);
    }
    for (const row of outRows) {
      if (fns.orientation === 'rows') {
        fns.list.forEach((agg, fi) => {
          const values = aggCols.map((c) => aggregate(row.indices, c.valCol, agg));
          out.push([...(fi === 0 ? row.labels : row.labels.map(() => EMPTY)), ...values]);
        });
      } else {
        const values = aggCols.map((c) => aggregate(row.indices, c.valCol, c.agg));
        out.push([...row.labels, ...values]);
      }
    }
    if (out.length === 0) return valueErr('GROUPBY produced no rows.');
    return asValue(out);
  }

  // -------------------------------------------------------------------------
  // PIVOTBY
  // -------------------------------------------------------------------------

  public pivotby(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    const args = ast.args;
    if (args.length < 4) {
      return new CellError(ErrorType.NA, 'PIVOTBY needs row_fields, col_fields, values and function.');
    }
    const fieldHeaders = this.numArg(args[4], state, Number.NaN);
    if (fieldHeaders instanceof CellError) return fieldHeaders;
    const rowDepthRaw = this.numArg(args[5], state, 1);
    if (rowDepthRaw instanceof CellError) return rowDepthRaw;
    const rowSort = this.sortArg(args[6], state);
    if (rowSort instanceof CellError) return rowSort;
    const colDepthRaw = this.numArg(args[7], state, 1);
    if (colDepthRaw instanceof CellError) return colDepthRaw;
    const colSort = this.sortArg(args[8], state);
    if (colSort instanceof CellError) return colSort;
    const relativeToRaw = this.numArg(args[10], state, 0);
    if (relativeToRaw instanceof CellError) return relativeToRaw;
    if (relativeToRaw < 0 || relativeToRaw > 4) {
      return valueErr('relative_to must be between 0 and 4.');
    }
    const fns = this.parseFunctions(args[3]!, state);
    if (fns instanceof CellError) return fns;

    const data = this.prepare(
      args[0],
      args[1],
      args[2]!,
      args[9],
      Number.isNaN(fieldHeaders) ? undefined : fieldHeaders,
      state,
    );
    if (data instanceof CellError) return data;
    const R = data.rowFieldCount;
    const C = data.colFieldCount;
    if (R === 0 && C === 0) {
      return valueErr('PIVOTBY requires row_fields and/or col_fields.');
    }
    const rowDepth = R === 0 ? 0 : rowDepthRaw;
    const colDepth = C === 0 ? 0 : colDepthRaw;
    const rdErr = this.validateDepth(rowDepth, R);
    if (rdErr !== undefined) return rdErr;
    const cdErr = this.validateDepth(colDepth, C);
    if (cdErr !== undefined) return cdErr;

    const aggCols: Array<{ valCol: number; agg: Aggregator }> = [];
    if (fns.orientation === 'cols') {
      for (let v = 0; v < data.valueCount; v++) {
        for (const agg of fns.list) aggCols.push({ valCol: v, agg });
      }
    } else {
      for (let v = 0; v < data.valueCount; v++) aggCols.push({ valCol: v, agg: fns.list[0]! });
    }
    const rsErr = this.validateSort(rowSort, R, aggCols.length);
    if (rsErr !== undefined) return rsErr;
    const csErr = this.validateSort(colSort, C, aggCols.length);
    if (csErr !== undefined) return csErr;

    const allIndices = data.vals.map((_, i) => i);
    const matching = (rowPrefix: Val[], colPrefix: Val[]): number[] =>
      allIndices.filter(
        (i) =>
          prefixMatches(data.rowKeys[i]!, rowPrefix) &&
          prefixMatches(data.colKeys[i]!, colPrefix),
      );
    /** The total set for a cell, per relative_to. */
    const totalsetFor = (rowPrefix: Val[], colPrefix: Val[], valCol: number): Val[] => {
      let indices: number[];
      switch (relativeToRaw) {
        case 1:
          indices = matching(rowPrefix, []);
          break;
        case 2:
          indices = allIndices;
          break;
        case 3:
          indices = matching(rowPrefix, colPrefix.slice(0, Math.max(0, colPrefix.length - 1)));
          break;
        case 4:
          indices = matching(rowPrefix.slice(0, Math.max(0, rowPrefix.length - 1)), colPrefix);
          break;
        default:
          indices = matching([], colPrefix);
          break;
      }
      return indices.map((i) => data.vals[i]?.[valCol] ?? EMPTY);
    };
    const aggregateCell = (
      rowPrefix: Val[],
      colPrefix: Val[],
      valCol: number,
      agg: Aggregator,
    ): Val => {
      const indices = matching(rowPrefix, colPrefix);
      // A row/column combination with no source rows is blank (Excel
      // behaviour for missing combinations), not zero.
      if (indices.length === 0) return EMPTY;
      const subset = indices.map((i) => data.vals[i]?.[valCol] ?? EMPTY);
      return agg.invoke(subset, totalsetFor(rowPrefix, colPrefix, valCol), state);
    };

    // Row and column slots.
    let rowSlots: Slot[];
    if (R === 0) {
      rowSlots = [{ kind: 'detail', prefix: [], level: 0 }];
    } else {
      const rowTree = this.buildTree(data.rowKeys, R);
      this.sortTree(rowTree, 0, R, rowSort, aggCols.length, (node, aggIndex) => {
        const col = aggCols[aggIndex]!;
        return aggregateCell(node.prefix, [], col.valCol, col.agg);
      });
      rowSlots = this.flattenTree(rowTree, rowDepth, R);
    }
    let colSlots: Slot[];
    if (C === 0) {
      colSlots = [{ kind: 'detail', prefix: [], level: 0 }];
    } else {
      const colTree = this.buildTree(data.colKeys, C);
      this.sortTree(colTree, 0, C, colSort, aggCols.length, (node, aggIndex) => {
        const col = aggCols[aggIndex]!;
        return aggregateCell([], node.prefix, col.valCol, col.agg);
      });
      colSlots = this.flattenTree(colTree, colDepth, C);
    }

    // Header rows: one per column-field level, then the aggregation header
    // row(s) when field headers are shown or multiple functions are used.
    const out: ArrayResult = [];
    const multiFunc = fns.list.length > 1;
    const showAggHeader = data.showHeaders || (multiFunc && fns.orientation === 'cols');
    for (let l = 0; l < C; l++) {
      const headerRow: Val[] = [];
      for (let c = 0; c < R; c++) {
        headerRow.push(data.showHeaders && c === R - 1 ? (data.colHeaders[l] ?? EMPTY) : EMPTY);
      }
      for (const slot of colSlots) {
        aggCols.forEach((_, ai) => {
          headerRow.push(ai === 0 ? this.slotLabels(slot, C)[l]! : EMPTY);
        });
      }
      out.push(headerRow);
    }
    if (showAggHeader) {
      if (data.showHeaders && multiFunc && data.valueCount > 1 && fns.orientation === 'cols') {
        out.push([
          ...Array.from({ length: R }, () => EMPTY),
          ...colSlots.flatMap(() => aggCols.map((c) => data.valHeaders[c.valCol] ?? EMPTY)),
        ]);
        out.push([
          ...data.rowHeaders,
          ...colSlots.flatMap(() => aggCols.map((c) => c.agg.label)),
        ]);
      } else {
        out.push([
          ...(data.showHeaders ? data.rowHeaders : Array.from({ length: R }, () => EMPTY)),
          ...colSlots.flatMap(() =>
            aggCols.map((c) =>
              multiFunc && fns.orientation === 'cols'
                ? c.agg.label
                : (data.valHeaders[c.valCol] ?? EMPTY),
            ),
          ),
        ]);
      }
    }

    // Data rows. A row-wise function vector expands each row slot into one
    // row per function.
    for (const rowSlot of rowSlots) {
      const rowLabel = R === 0 ? [] : this.slotLabels(rowSlot, R);
      if (fns.orientation === 'rows') {
        fns.list.forEach((agg, fi) => {
          const cells: Val[] = [];
          for (const colSlot of colSlots) {
            for (const c of aggCols) {
              cells.push(aggregateCell(rowSlot.prefix, colSlot.prefix, c.valCol, agg));
            }
          }
          out.push([...(fi === 0 ? rowLabel : rowLabel.map(() => EMPTY)), ...cells]);
        });
      } else {
        const cells: Val[] = [];
        for (const colSlot of colSlots) {
          for (const c of aggCols) {
            cells.push(aggregateCell(rowSlot.prefix, colSlot.prefix, c.valCol, c.agg));
          }
        }
        out.push([...rowLabel, ...cells]);
      }
    }
    if (out.length === 0) return valueErr('PIVOTBY produced no rows.');
    return asValue(out);
  }
}

export function registerGroupByFunctions(): void {
  if (HyperFormula.getFunctionPlugin('GROUPBY') !== undefined) return;
  const names = { GROUPBY: 'GROUPBY', PIVOTBY: 'PIVOTBY' };
  HyperFormula.registerFunctionPlugin(GroupByPlugin, { enGB: names, enUS: names });
}

registerGroupByFunctions();
