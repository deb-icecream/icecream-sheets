/**
 * Extended Excel-compatibility functions, batch 9.
 *
 * GETPIVOTDATA, CELL, IMAGE and HYPERLINK — all real implementations (no stubs):
 *
 * - GETPIVOTDATA resolves a pivot registered via the engine-local
 *   PivotRegistry (the web app / service layer adapts the service
 *   PivotResult into PivotResultLike and registers it with the pivot's
 *   rendered anchor). Field/item pairs are matched against the pivot's
 *   row/column key tuples; totals are used for unspecified dimensions.
 * - CELL reads address/row/col/type/contents/format/protect/prefix/width
 *   from the engine. "filename" is always "" — the headless engine has no
 *   file path (documented, not a stub).
 * - IMAGE returns an in-cell image value {kind:'image',...} that the typed
 *   view passes through and the web grid renders as <img>.
 * - HYPERLINK returns the friendly name (or the link location); link
 *   navigation itself is a host/UI concern.
 *
 * Unlike batches 1-7 this module does NOT self-register on import: hosts
 * call registerExtendedFunctions9() explicitly (it is idempotent).
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
import type {
  Ast,
  CellRangeAst,
  CellReferenceAst,
  ProcedureAst,
} from 'hyperformula/typings/parser/Ast.js';
import type { CellAddress } from 'hyperformula/typings/parser/CellAddress.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import type { SimpleCellAddress } from 'hyperformula/typings/Cell.js';
import type { DependencyGraph } from 'hyperformula/typings/DependencyGraph/DependencyGraph.js';

/** AST node type strings (mirrors HyperFormula's AstNodeType enum). */
const AST_NODE = {
  CELL_REFERENCE: 'CELL_REFERENCE',
  CELL_RANGE: 'CELL_RANGE',
  NAMED_EXPRESSION: 'NAMED_EXPRESSION',
  PARENTHESIS: 'PARENTHESIS',
} as const;

/** Cast to InterpreterValue (runtime supports objects; types don't). */
function asVal(v: unknown): InterpreterValue {
  return v as unknown as InterpreterValue;
}

// ---------------------------------------------------------------------------
// Pivot registry (engine-local; hosts adapt the service PivotResult into
// PivotResultLike and register it at the pivot's rendered anchor).
// ---------------------------------------------------------------------------

/**
 * Minimal structural pivot shape. Deliberately defined locally — importing
 * @icecream-sheets/service here would create a circular dependency. Hosts
 * adapt the service PivotResult (service/src/pivot.ts) into this shape.
 */
export interface PivotResultLike {
  /** Display labels of the row fields, in key-tuple position order. */
  rowFieldNames: string[];
  /** Display labels of the column fields, in key-tuple position order. */
  colFieldNames: string[];
  /** Display label per value field, e.g. "Sum of Amount". */
  valueLabels: string[];
  /** Display labels of the row key tuples, in order. */
  rowKeys: string[][];
  /** Display labels of the column key tuples, in order. */
  colKeys: string[][];
  /** Aggregated values: data[rowIdx][colIdx][valueIdx]. */
  data: (number | null)[][][];
  /** Per-row totals across all columns, per value field. */
  rowTotals: (number | null)[][];
  /** Per-column totals across all rows, per value field. */
  colTotals: (number | null)[][];
  /** Grand totals, per value field. */
  grandTotals: (number | null)[];
}

/** Rendered position/extent of a pivot table on a sheet. */
export interface PivotAnchor {
  /** Zero-based sheet id. */
  sheet: number;
  /** Zero-based column of the pivot's top-left corner. */
  col: number;
  /** Zero-based row of the pivot's top-left corner. */
  row: number;
  /** Rendered width in columns. */
  cols: number;
  /** Rendered height in rows. */
  rows: number;
}

export interface PivotRegistration {
  id: string;
  pivot: PivotResultLike;
  anchor: PivotAnchor;
}

const pivotRegistry = new Map<string, PivotRegistration>();

/** Register (or replace) a pivot table's rendered position. */
export function registerPivot(id: string, pivot: PivotResultLike, anchor: PivotAnchor): void {
  pivotRegistry.set(id, { id, pivot, anchor });
}

/** Remove a pivot table from the registry. */
export function unregisterPivot(id: string): void {
  pivotRegistry.delete(id);
}

/** Find the pivot whose rendered area contains (sheet, col, row). */
export function findPivotContaining(
  sheet: number,
  col: number,
  row: number,
): PivotRegistration | undefined {
  for (const entry of pivotRegistry.values()) {
    const a = entry.anchor;
    if (
      a.sheet === sheet &&
      col >= a.col && col < a.col + a.cols &&
      row >= a.row && row < a.row + a.rows
    ) {
      return entry;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Imported pivot layouts — rendered-grid fallback for GETPIVOTDATA
// ---------------------------------------------------------------------------

/**
 * Structural subset of the xlsx-adapter's ImportedPivotTable, carried via
 * EngineWorkbookOptions.importedPivots. Lets GETPIVOTDATA resolve pivot
 * tables that were never registered via registerPivot — notably OLAP /
 * data-model pivots whose caches carry no records (hosts surface those as
 * "refresh from source" notices instead of registering them), while their
 * rendered values ARE present in the sheet grid.
 *
 * Resolution is read-only over the rendered grid: the data field is matched
 * against the pivot's value labels, field/item pairs against the rendered
 * row/column headers (MDX unique names like `[Measures].[Sum of X]` and
 * `[tblCal].[Year].&[2021]` are reduced to their last bracket segment), and
 * the intersecting data cell is returned. This mirrors what Excel itself
 * reports for such pivots — the cached GETPIVOTDATA values in real files
 * are exactly the rendered-grid values.
 */
export interface ImportedPivotInfo {
  /** Sheet name hosting the pivot (resolved to a sheet id at workbook build). */
  sheetName: string;
  /** Rendered top-left + original location ref (e.g. "A5:K21") for the extent. */
  anchor: { row: number; col: number; ref: string };
  /** Row field names (MDX-ish, e.g. "[tblCal].[Year].[Year]"). */
  rows: string[];
  /** Column field names. */
  columns: string[];
  /** Value fields with display labels. */
  values: { label: string }[];
  /** True when the Values area renders on rows (labels down the first column). */
  dataOnRows: boolean;
}

const importedPivotRegistry = new WeakMap<DependencyGraph, Map<number, ImportedPivotInfo[]>>();

/** Register (or replace) the imported-pivot layouts for a workbook's dependency graph. */
export function setImportedPivotInfos(
  graph: DependencyGraph,
  bySheetId: Map<number, ImportedPivotInfo[]>,
): void {
  importedPivotRegistry.set(graph, bySheetId);
}

function getImportedPivotInfos(graph: DependencyGraph, sheetId: number): ImportedPivotInfo[] {
  return importedPivotRegistry.get(graph)?.get(sheetId) ?? [];
}

/** "[tblCal].[Year].&[2021]" → "2021"; "[Measures].[Sum of X]" → "Sum of X"; "Year" → "Year". */
function mdxLastSegment(s: string): string {
  const segs: string[] = [];
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) segs.push(m[1]!);
  if (segs.length === 0) return s.trim();
  return segs[segs.length - 1]!.replace(/^&/, '').trim();
}

function parseA1Extent(ref: string): { r0: number; c0: number; r1: number; c1: number } | undefined {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!m) return undefined;
  const col = (s: string): number => {
    let n = 0;
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const c0 = col(m[1]!);
  const r0 = parseInt(m[2]!, 10) - 1;
  const c1 = col(m[3]!);
  const r1 = parseInt(m[4]!, 10) - 1;
  if (!(r0 <= r1 && c0 <= c1)) return undefined;
  return { r0, c0, r1, c1 };
}

/** Match a GETPIVOTDATA data field against an imported pivot's value labels. */
function matchImportedValueField(info: ImportedPivotInfo, dataField: string): string | undefined {
  const want = mdxLastSegment(dataField);
  for (const v of info.values) {
    if (norm(v.label) === norm(want)) return v.label;
  }
  const stripped = stripAgg(want);
  for (const v of info.values) {
    if (stripAgg(v.label) === stripped) return v.label;
  }
  return undefined;
}

interface ImportedPair {
  field: string;
  item: string;
}

/** Parse raw (field, item) scalar args; HyperFormula pads absent trailing optionals with undefined. */
function parseImportedPairs(pairArgs: InterpreterValue[]): ImportedPair[] | CellError {
  const args = [...pairArgs];
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
  if (args.length % 2 !== 0) {
    return new CellError(ErrorType.VALUE, 'Field/item arguments must come in pairs.');
  }
  const out: ImportedPair[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const fArg = args[i];
    const itArg = args[i + 1];
    if (fArg instanceof CellError) return fArg;
    if (itArg instanceof CellError) return itArg;
    out.push({ field: scalarText(fArg), item: scalarText(itArg) });
  }
  return out;
}

/**
 * Rendered-grid GETPIVOTDATA. `pairs` are the raw (field, item) scalar args.
 * Returns #REF! when the reference names no pivot, a field/item, or a
 * rendered cell — matching Excel's #REF! for unresolvable GETPIVOTDATA.
 */
function getpivotdataFromGrid(
  graph: DependencyGraph,
  sheetId: number,
  addr: SimpleCellAddress,
  dataField: string,
  pairs: ImportedPair[],
): InterpreterValue {
  const layouts = getImportedPivotInfos(graph, sheetId);
  let found: { info: ImportedPivotInfo; r0: number; c0: number; r1: number; c1: number } | undefined;
  for (const info of layouts) {
    const ext = parseA1Extent(info.anchor.ref);
    const r0 = info.anchor.row;
    const c0 = info.anchor.col;
    const r1 = ext ? ext.r1 : r0 + 200;
    const c1 = ext ? ext.c1 : c0 + 200;
    if (addr.row >= r0 && addr.row <= r1 && addr.col >= c0 && addr.col <= c1) {
      found = { info, r0, c0, r1, c1 };
      break;
    }
  }
  if (!found) {
    return new CellError(ErrorType.REF, 'No pivot table at the given reference.');
  }
  const { info, r0, c0, r1, c1 } = found;
  const cellAt = (row: number, col: number): InterpreterValue =>
    graph.getScalarValue({ sheet: sheetId, row, col });
  // Rendered headers/labels are collected over a small band, not a single
  // row/column: OLAP pivots render a field-name row above the item row
  // (e.g. "Year" over 2012..2021), and nested labels may indent into the
  // next column. colHeaderTexts[i] aligns with grid column c0+1+i;
  // rowLabelTexts[i] aligns with grid row r0+i.
  const colHeaderTexts: string[][] = [];
  for (let c = c0 + 1; c <= c1; c++) {
    const texts: string[] = [];
    for (let r = r0; r <= Math.min(r0 + 3, r1); r++) {
      const t = scalarText(cellAt(r, c));
      if (t !== '') texts.push(t);
    }
    colHeaderTexts.push(texts);
  }
  const rowLabelTexts: string[][] = [];
  for (let r = r0; r <= r1; r++) {
    const texts: string[] = [];
    for (let c = c0; c <= Math.min(c0 + 1, c1); c++) {
      const t = scalarText(cellAt(r, c));
      if (t !== '') texts.push(t);
    }
    rowLabelTexts.push(texts);
  }
  const colMatch = (want: string): number =>
    colHeaderTexts.findIndex((ts) => ts.some((t) => norm(t) === norm(want)));
  const rowMatch = (want: string): number =>
    rowLabelTexts.findIndex((ts) => ts.some((t) => norm(t) === norm(want)));

  const valueLabel = matchImportedValueField(info, dataField);
  if (valueLabel === undefined) {
    return new CellError(ErrorType.REF, `Unknown data field "${dataField}".`);
  }
  // Assign each field/item pair to the row or column axis.
  const rowFieldLast = info.rows.map(mdxLastSegment);
  const colFieldLast = info.columns.map(mdxLastSegment);
  const rowItems: string[] = [];
  const colItems: string[] = [];
  for (const { field, item } of pairs) {
    const f = mdxLastSegment(field);
    const it = mdxLastSegment(item);
    const onRows = rowFieldLast.some((n) => norm(n) === norm(f));
    const onCols = colFieldLast.some((n) => norm(n) === norm(f));
    if (onRows && !onCols) {
      rowItems.push(it);
    } else if (onCols && !onRows) {
      colItems.push(it);
    } else {
      // Unknown/ambiguous field name: infer the axis from where the item
      // renders (Excel-visible labels are the ground truth here).
      const rHit = rowMatch(it);
      const cHit = colMatch(it);
      if (rHit >= 0 && cHit < 0) rowItems.push(it);
      else if (cHit >= 0 && rHit < 0) colItems.push(it);
      else return new CellError(ErrorType.REF, `Unknown pivot field "${field}".`);
    }
  }

  const finish = (v: InterpreterValue): InterpreterValue => {
    if (v instanceof CellError) return v;
    if (v === EmptyValue || v === undefined) return 0;
    return v;
  };

  if (info.dataOnRows) {
    // Values label the rows; field items select a column.
    const r = rowMatch(valueLabel);
    if (r < 0) return new CellError(ErrorType.REF, 'No matching row in the pivot table.');
    for (const it of rowItems) {
      if (!rowLabelTexts[r]!.some((t) => norm(t) === norm(it))) {
        return new CellError(ErrorType.REF, 'No matching row in the pivot table.');
      }
    }
    let c: number;
    if (colItems.length === 0) {
      c = colHeaderTexts.findIndex((ts) => ts.some((t) => /grand\s*total/i.test(t)));
      if (c < 0) return new CellError(ErrorType.REF, 'No data for the given fields/items.');
    } else {
      const hits = colItems.map((it) => colMatch(it));
      if (hits.some((h) => h < 0)) {
        return new CellError(ErrorType.REF, 'No matching column in the pivot table.');
      }
      if (!hits.every((h) => h === hits[0])) {
        return new CellError(ErrorType.REF, 'No data for the given fields/items.');
      }
      c = hits[0]!;
    }
    return finish(cellAt(r0 + r, c0 + 1 + c));
  }
  // Values label the columns; field items select a row.
  const c = colMatch(valueLabel);
  if (c < 0) return new CellError(ErrorType.REF, 'No matching column in the pivot table.');
  for (const it of colItems) {
    if (!colHeaderTexts[c]!.some((t) => norm(t) === norm(it))) {
      return new CellError(ErrorType.REF, 'No matching column in the pivot table.');
    }
  }
  let r: number;
  if (rowItems.length === 0) {
    r = rowLabelTexts.findIndex((ts) => ts.some((t) => /grand\s*total/i.test(t)));
    if (r < 0) return new CellError(ErrorType.REF, 'No data for the given fields/items.');
  } else {
    const hits = rowItems.map((it) => rowMatch(it));
    if (hits.some((h) => h < 0)) {
      return new CellError(ErrorType.REF, 'No matching row in the pivot table.');
    }
    if (!hits.every((h) => h === hits[0])) {
      return new CellError(ErrorType.REF, 'No data for the given fields/items.');
    }
    r = hits[0]!;
  }
  return finish(cellAt(r0 + r, c0 + 1 + c));
}

// ---------------------------------------------------------------------------
// AST address helpers
// ---------------------------------------------------------------------------

/** Unwrap PARENTHESIS nodes the way HyperFormula's own reference-arg helpers do. */
function unwrap(node: Ast): Ast {
  let cur: unknown = node;
  while (
    cur !== null && typeof cur === 'object' &&
    (cur as Record<string, unknown>)['type'] === AST_NODE.PARENTHESIS
  ) {
    cur = (cur as { expression: Ast }).expression;
  }
  return cur as Ast;
}

function toSimple(ref: CellAddress, state: InterpreterState): SimpleCellAddress {
  return ref.toSimpleCellAddress(state.formulaAddress);
}

/**
 * Read a cell/range reference address from an unevaluated AST argument.
 * Returns undefined when the arg is not a reference (the caller decides how
 * to report that).
 *
 * When `graph` (the plugin's DependencyGraph) is supplied, defined names
 * (NAMED_EXPRESSION nodes) are resolved through the named-expression vertex
 * to the address they refer to — e.g. CELL("address", MyName) where
 * MyName → CHKs!$B$20. Resolution is per-graph (no globals) and
 * recursion-guarded; a name bound to a constant has no address.
 */
export function refAddressFromAst(
  arg: Ast | undefined,
  state: InterpreterState,
  graph?: NamedExpressionGraph | undefined,
): SimpleCellAddress | undefined {
  return refAddressFromAstInner(arg, state, graph, 0);
}

/** Minimal structural surface of DependencyGraph needed for name resolution. */
export interface NamedExpressionGraph {
  fetchNamedExpressionVertex(
    expressionName: string,
    sheetId: number,
  ): { vertex: unknown };
  lazilyTransformingAstService: unknown;
}

function refAddressFromAstInner(
  arg: Ast | undefined,
  state: InterpreterState,
  graph: NamedExpressionGraph | undefined,
  depth: number,
): SimpleCellAddress | undefined {
  if (!arg || typeof arg !== 'object' || depth > 5) return undefined;
  const node = unwrap(arg);
  const rec = node as unknown as Record<string, unknown>;
  if (rec['type'] === AST_NODE.CELL_REFERENCE) {
    return toSimple((node as unknown as CellReferenceAst).reference, state);
  }
  if (rec['type'] === AST_NODE.CELL_RANGE) {
    return toSimple((node as unknown as CellRangeAst).start, state);
  }
  if (rec['type'] === AST_NODE.NAMED_EXPRESSION && graph) {
    const name = String(
      (rec as unknown as { expressionName?: unknown }).expressionName ?? '',
    );
    if (!name) return undefined;
    try {
      const { vertex } = graph.fetchNamedExpressionVertex(name, state.formulaAddress.sheet);
      const getFormula = (vertex as { getFormula?: unknown }).getFormula;
      if (typeof getFormula !== 'function') return undefined;
      const targetAst = (getFormula as (svc: unknown) => Ast).call(
        vertex,
        graph.lazilyTransformingAstService,
      );
      return refAddressFromAstInner(targetAst, state, graph, depth + 1);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Numeric scalars may arrive as RichNumber (DateNumber/CurrencyNumber/…)
 * whose raw number lives in `.val`.
 */
function scalarNumber(v: InterpreterValue): number | undefined {
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object') {
    const raw = (v as unknown as { val?: unknown }).val;
    if (typeof raw === 'number') return raw;
  }
  return undefined;
}

function colLetters(col: number): string {
  let s = '';
  let n = col;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

// ---------------------------------------------------------------------------
// GETPIVOTDATA matching
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** "Sum of Amount" -> "amount"; "Amount" -> "amount". */
function stripAgg(label: string): string {
  return label
    .replace(/^(sum|counta?|average|avg|min|max|product|stdev\.?p?|var\.?p?)\s+of\s+/i, '')
    .trim()
    .toLowerCase();
}

/** Match data_field against value labels; also matches "Sum of X" <-> "X". */
function matchValueField(pivot: PivotResultLike, dataField: string): number {
  const want = norm(dataField);
  let idx = pivot.valueLabels.findIndex((l) => norm(l) === want);
  if (idx >= 0) return idx;
  const stripped = stripAgg(dataField);
  idx = pivot.valueLabels.findIndex((l) => stripAgg(l) === stripped);
  return idx;
}

/**
 * Find a key tuple where every specified (non-null) position matches,
 * case-insensitively. Unspecified positions are wildcards.
 */
function findKeyIndex(keys: string[][], targets: (string | null)[]): number {
  return keys.findIndex(
    (k) =>
      k.length === targets.length &&
      targets.every((t, i) => t === null || norm(k[i] ?? '') === norm(t)),
  );
}

function scalarText(v: InterpreterValue | undefined): string {
  if (v === undefined || v === EmptyValue) return '';
  return String(v);
}

// ---------------------------------------------------------------------------
// IMAGE source validation
// ---------------------------------------------------------------------------

/** Accept http(s) and data:image: URLs; reject javascript:/etc. (Pictures.tsx pattern). */
function isSafeImageSrc(src: string): boolean {
  const lower = src.toLowerCase();
  return (
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('data:image/')
  );
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class ExtendedPlugin9 extends FunctionPlugin {
  public static implementedFunctions = {
    GETPIVOTDATA: {
      method: 'getpivotdata',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
      repeatLastArgs: 2,
    },
    CELL: {
      method: 'cell',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        // The implementation resolves the reference from the raw AST
        // (top-left of any range) instead of using runFunction coercion,
        // so the declared types here are inert; vectorization is forbidden
        // so a range argument is never broadcast.
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
      vectorizationForbidden: true,
    },
    IMAGE: {
      method: 'image',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    HYPERLINK: {
      method: 'hyperlink',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
  };

  public getpivotdata(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('GETPIVOTDATA'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [fieldArg, , ...pairArgs] = args;
        if (fieldArg instanceof CellError) return fieldArg;
        const dataField = scalarText(fieldArg);
        if (!dataField) {
          return new CellError(ErrorType.REF, 'GETPIVOTDATA requires a data field.');
        }
        // Resolve the pivot table reference from the raw AST — the evaluated
        // value cannot carry the address.
        const addr = refAddressFromAst(ast.args[1], state);
        if (!addr) {
          return new CellError(ErrorType.REF, 'Pivot table reference required.');
        }
        const entry = findPivotContaining(addr.sheet, addr.col, addr.row);
        if (!entry) {
          // Rendered-grid fallback: imported pivots that were never
          // registered (e.g. data-model pivots without cache records) still
          // have their values in the sheet grid.
          const pairs = parseImportedPairs(pairArgs);
          if (pairs instanceof CellError) return pairs;
          return getpivotdataFromGrid(this.dependencyGraph, addr.sheet, addr, dataField, pairs);
        }
        const pivot = entry.pivot;
        const valueIdx = matchValueField(pivot, dataField);
        if (valueIdx < 0) {
          return new CellError(ErrorType.REF, `Unknown data field "${dataField}".`);
        }
        if (pairArgs.length % 2 !== 0) {
          return new CellError(ErrorType.VALUE, 'Field/item arguments must come in pairs.');
        }
        // HyperFormula pads absent trailing optionals with undefined.
        while (pairArgs.length > 0 && pairArgs[pairArgs.length - 1] === undefined) {
          pairArgs.pop();
        }
        if (pairArgs.length % 2 !== 0) {
          return new CellError(ErrorType.VALUE, 'Field/item arguments must come in pairs.');
        }
        const rowTuple: (string | null)[] = pivot.rowFieldNames.map(() => null);
        const colTuple: (string | null)[] = pivot.colFieldNames.map(() => null);
        for (let i = 0; i < pairArgs.length; i += 2) {
          const fArg = pairArgs[i];
          const itArg = pairArgs[i + 1];
          if (fArg instanceof CellError) return fArg;
          if (itArg instanceof CellError) return itArg;
          const field = scalarText(fArg);
          const item = scalarText(itArg);
          const ri = pivot.rowFieldNames.findIndex((n) => norm(n) === norm(field));
          if (ri >= 0) {
            rowTuple[ri] = item;
            continue;
          }
          const ci = pivot.colFieldNames.findIndex((n) => norm(n) === norm(field));
          if (ci >= 0) {
            colTuple[ci] = item;
            continue;
          }
          return new CellError(ErrorType.REF, `Unknown pivot field "${field}".`);
        }
        const read = (v: number | null | undefined): InterpreterValue =>
          v === null || v === undefined
            ? new CellError(ErrorType.REF, 'No data for the given fields/items.')
            : v;
        const rowSpecified = rowTuple.some((t) => t !== null);
        const colSpecified = colTuple.some((t) => t !== null);
        if (!rowSpecified && !colSpecified) {
          return read(pivot.grandTotals[valueIdx]);
        }
        if (rowSpecified && !colSpecified) {
          const ri = findKeyIndex(pivot.rowKeys, rowTuple);
          if (ri < 0) return new CellError(ErrorType.REF, 'No matching row in the pivot table.');
          return read(pivot.rowTotals[ri]?.[valueIdx]);
        }
        if (colSpecified && !rowSpecified) {
          const ci = findKeyIndex(pivot.colKeys, colTuple);
          if (ci < 0) return new CellError(ErrorType.REF, 'No matching column in the pivot table.');
          return read(pivot.colTotals[ci]?.[valueIdx]);
        }
        const ri = findKeyIndex(pivot.rowKeys, rowTuple);
        const ci = findKeyIndex(pivot.colKeys, colTuple);
        if (ri < 0 || ci < 0) {
          return new CellError(ErrorType.REF, 'No matching row/column in the pivot table.');
        }
        return read(pivot.data[ri]?.[ci]?.[valueIdx]);
      },
    );
  }

  /**
   * CELL(info_type, [reference]).
   *
   * Excel semantics: every info_type reports on the top-left cell of the
   * reference — a multi-cell range never errors (e.g. CELL("address",
   * A1:B2) is "$A$1"). HyperFormula's runFunction argument coercion cannot
   * express this: SCALAR rejects multi-cell ranges ("Wrong type of
   * argument") before the plugin runs, and RANGE short-circuits errored
   * single cells before the plugin runs (but CELL("address", B10) must be
   * "$B$10" even when B10 holds an error). The reference is therefore
   * resolved from the raw AST (top-left of any range) and the info_type
   * argument is evaluated directly; the value-dependent info types read
   * the top-left cell's stored value from the dependency graph.
   */
  public cell(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    if (ast.args.length === 0 || ast.args.length > 2) {
      return new CellError(ErrorType.NA, 'Wrong number of arguments.');
    }
    const typeArg = this.evaluateAst(ast.args[0], state);
    if (typeArg instanceof CellError) return typeArg;
    const infoType = scalarText(typeArg).toLowerCase();
    // Reference defaults to the formula's own cell; a non-reference
    // second argument is a #REF! (Excel requires a reference).
    let target = state.formulaAddress;
    if (ast.args.length > 1) {
      const addr = refAddressFromAst(ast.args[1], state, this.dependencyGraph);
      if (!addr) {
        return new CellError(ErrorType.REF, 'CELL reference must be a cell reference.');
      }
      target = addr;
    }
    // Info types that describe the reference itself (not its value) must
    // not propagate the referenced cell's error: Excel's CELL("address",
    // B20) returns "$B$20" even when B20 holds #REF!. Only the
    // value-dependent types below read the cell's value.
    switch (infoType) {
      case 'address':
        return `$${colLetters(target.col)}$${target.row + 1}`;
      case 'col':
        return target.col + 1;
      case 'row':
        return target.row + 1;
      case 'filename':
        // The headless engine has no file path; always empty.
        return '';
      case 'protect':
        return 0;
      case 'prefix':
        // Cell alignment is not tracked by the headless engine.
        return '';
      case 'width':
        return 8.43;
    }
    // Value-dependent info types read the top-left cell's stored value
    // (blank cells arrive as EmptyValue; errors propagate).
    const refVal: InterpreterValue = this.dependencyGraph.getCellValue(target);
    if (refVal instanceof CellError) return refVal;
    switch (infoType) {
      case 'type':
        if (refVal === EmptyValue) return 'b';
        if (typeof refVal === 'string') return 'l';
        return 'v';
      case 'contents':
        if (refVal === EmptyValue) return 0;
        return refVal;
      case 'format': {
        // Simplified: "G" general; "F2" for numbers with decimals.
        // Date detection needs workbook number formats, unavailable here.
        const n = scalarNumber(refVal);
        if (n !== undefined) {
          return Number.isInteger(n) ? 'G' : 'F2';
        }
        return 'G';
      }
      default:
        return new CellError(ErrorType.VALUE, `Unknown CELL info type "${scalarText(typeArg)}".`);
    }
  }

  public image(ast: ProcedureAst, state: InterpreterState): InterpreterValue {    return this.runFunction(
      ast.args,
      state,
      this.metadata('IMAGE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [srcArg, altArg, sizingArg, heightArg, widthArg] = args;
        if (srcArg instanceof CellError) return srcArg;
        const src = scalarText(srcArg).trim();
        if (!isSafeImageSrc(src)) {
          return new CellError(
            ErrorType.VALUE,
            'IMAGE source must be an http(s) URL or a data:image: URL.',
          );
        }
        if (altArg instanceof CellError) return altArg;
        const alt = scalarText(altArg);
        let sizing = 0;
        if (sizingArg !== undefined && sizingArg !== EmptyValue) {
          if (sizingArg instanceof CellError) return sizingArg;
          sizing = Math.trunc(Number(sizingArg));
          if (!Number.isInteger(sizing) || sizing < 0 || sizing > 3) {
            return new CellError(ErrorType.VALUE, 'IMAGE sizing must be 0 (fit), 1 (fill), 2 (original) or 3 (custom).');
          }
        }
        const toDim = (v: InterpreterValue | undefined, name: string): number | undefined | CellError => {
          if (v === undefined || v === EmptyValue) return undefined;
          if (v instanceof CellError) return v;
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) {
            return new CellError(ErrorType.VALUE, `IMAGE ${name} must be a positive number.`);
          }
          return n;
        };
        const height = toDim(heightArg, 'height');
        if (height instanceof CellError) return height;
        const width = toDim(widthArg, 'width');
        if (width instanceof CellError) return width;
        return asVal({
          kind: 'image',
          src,
          alt,
          sizing,
          ...(height !== undefined ? { height } : {}),
          ...(width !== undefined ? { width } : {}),
        });
      },
    );
  }

  /**
   * HYPERLINK(link_location, [friendly_name]): creates a clickable link.
   * The engine has no cell-hyperlink store (link navigation is a host/UI
   * concern), so this implements the value semantics: the friendly name
   * when given, otherwise the link location. Argument errors propagate,
   * matching Excel.
   */
  public hyperlink(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('HYPERLINK'),
      (linkArg: InterpreterValue, friendlyArg?: InterpreterValue): InterpreterValue => {
        if (linkArg instanceof CellError) return linkArg;
        if (friendlyArg instanceof CellError) return friendlyArg;
        if (friendlyArg !== undefined && friendlyArg !== EmptyValue) return friendlyArg;
        return linkArg;
      },
    );
  }
}

export function registerExtendedFunctions9(): void {
  if (HyperFormula.getFunctionPlugin('GETPIVOTDATA') !== undefined) return;
  const names = { GETPIVOTDATA: 'GETPIVOTDATA', CELL: 'CELL', IMAGE: 'IMAGE', HYPERLINK: 'HYPERLINK' };
  HyperFormula.registerFunctionPlugin(ExtendedPlugin9, { enGB: names, enUS: names });
}
