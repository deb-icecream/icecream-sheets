/**
 * Dynamic array functions for HyperFormula (Excel spill compatibility).
 *
 * HyperFormula 2.x has no native spill-range support, so this plugin takes a
 * pragmatic approach:
 *
 * 1. Each function computes and returns a 2D array (InterpreterValue[][]).
 *    HyperFormula's getCellValue returns the array as-is from the anchor cell.
 * 2. The exported `spill()` helper lets EngineWorkbook (or a UI layer) write
 *    the array's elements into adjacent cells, emulating Excel's spill.
 *    The anchor cell keeps the formula; neighbours receive static values.
 * 3. `toSpillWrites()` converts an array result into (row, col, value) writes
 *    relative to an anchor, for hosts that batch mutations.
 *
 * Phase E (issue #69 item 3) #SPILL! semantics — what this module now
 * guarantees, and what it deliberately does not:
 *
 * - BLOCKED: when any non-anchor cell of the new extent holds entered
 *   content, the spill yields #SPILL! (CellError SPILL) at the anchor and
 *   writes NO static neighbour values. `checkedSpillWrites()` is the
 *   occupancy-checked form of `toSpillWrites()`; `spill()` applies it.
 * - LIVE / RESIZABLE (replayable, not stateful): this module holds no
 *   spill state. A host that wants live spills replays `spill()` after
 *   every recalc with the anchor's fresh computed array and the extent
 *   it last wrote (`previousExtent`). Replay is idempotent: cells of
 *   the previous extent are never treated as blockers of their own
 *   spill, members that fall outside a shrunken new extent are cleared,
 *   and a newly blocked spill clears its previous members and yields
 *   #SPILL!. Without `previousExtent`, a replay over its own previous
 *   static writes self-blocks — that parameter is the liveness contract.
 * - NOT here (host step, still open): no EngineWorkbook/view code calls
 *   `spill()` for ordinary dynamic-array formulas today — the live app
 *   shows the anchor's top-left value only (workbook.ts toTypedValue).
 *   Wiring replay into the recalc path is a workbook-level change, out
 *   of this module's scope; until it lands, these helpers are the
 *   semantics, exercised by the IMPORT/FILTERXML host paths and by hosts
 *   that replay them.
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

/** A computed 2D array result. */
export type ArrayResult = InterpreterValue[][];

/** Convert a scalar / 2D array / SimpleRangeValue into a 2D array. */
export function to2DArray(value: InterpreterValue): ArrayResult {
  if (value instanceof SimpleRangeValue) {
    return to2DArray(value.data as unknown as InterpreterValue);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (Array.isArray(value[0])) {
      return value as ArrayResult;
    }
    return [value as InterpreterValue[]];
  }
  return [[value]];
}

/** Flatten a 2D array row-major. */
function flatten2D(m: ArrayResult): InterpreterValue[] {
  const out: InterpreterValue[] = [];
  for (const row of m) for (const v of row) out.push(v);
  return out;
}

/** Excel-like comparison: numbers < strings < booleans; errors sort last. */
function compareValues(a: InterpreterValue, b: InterpreterValue): number {
  if (a instanceof CellError) return b instanceof CellError ? 0 : 1;
  if (b instanceof CellError) return -1;
  if (a === EmptyValue) return b === EmptyValue ? 0 : 1;
  if (b === EmptyValue) return -1;
  const rank = (v: InterpreterValue): number =>
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
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  return 0;
}

/** Deep equality for UNIQUE (case-insensitive strings). */
function valuesEqual(a: InterpreterValue, b: InterpreterValue): boolean {
  if (a instanceof CellError || b instanceof CellError) return false;
  if (a === EmptyValue || b === EmptyValue) return a === b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function rowsEqual(r1: InterpreterValue[], r2: InterpreterValue[]): boolean {
  if (r1.length !== r2.length) return false;
  return r1.every((v, i) => valuesEqual(v, r2[i]!));
}

/** Cast a 2D array to InterpreterValue (runtime supports it; types don't). */
function asValue(arr: ArrayResult): InterpreterValue {
  return arr as unknown as InterpreterValue;
}


/**
 * Compute spill writes for an array result anchored at (anchorRow, anchorCol).
 * Returns [row, col, value] tuples for every element EXCEPT the anchor cell
 * itself (which keeps the formula). A host applies these via setCell.
 * Unchecked: callers that need #SPILL! semantics must use
 * `checkedSpillWrites()` (or `spill()`) instead — this function cannot
 * distinguish a blocked extent from an empty one.
 */
export function toSpillWrites(
  anchorRow: number,
  anchorCol: number,
  values: ArrayResult,
): Array<[number, number, InterpreterValue]> {
  const writes: Array<[number, number, InterpreterValue]> = [];
  for (let r = 0; r < values.length; r++) {
    const row = values[r]!;
    for (let c = 0; c < row.length; c++) {
      if (r === 0 && c === 0) continue; // anchor keeps the formula
      writes.push([anchorRow + r, anchorCol + c, row[c]!]);
    }
  }
  return writes;
}

/** An extent rectangle, inclusive, 0-based (same convention as SpillRange). */
export interface SpillExtent {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Extent of an array result anchored at (anchorRow, anchorCol). */
export function spillExtentOf(
  anchorRow: number,
  anchorCol: number,
  values: ArrayResult,
): SpillExtent {
  const rows = values.length;
  const cols = rows > 0 ? Math.max(...values.map((row) => row.length)) : 0;
  return {
    startRow: anchorRow,
    startCol: anchorCol,
    endRow: anchorRow + rows - 1,
    endCol: anchorCol + cols - 1,
  };
}

function inExtent(extent: SpillExtent, row: number, col: number): boolean {
  return row >= extent.startRow && row <= extent.endRow && col >= extent.startCol && col <= extent.endCol;
}

/**
 * Occupancy-checked spill writes (Phase E #SPILL! semantics).
 *
 * - Every non-anchor cell of the new extent is tested with `isOccupied`.
 *   Cells inside `previousExtent` are skipped: they are this spill's own
 *   previous outputs, not blockers, which is what makes replay
 *   idempotent instead of self-blocking.
 * - Blocked: returns `{ error: CellError(SPILL) }` and NO writes — the
 *   caller must not write static neighbours, and (via `spill()`) must
 *   clear the previous extent's members so stale outputs disappear
 *   with the #SPILL! exactly as Excel does.
 * - Unblocked: returns `{ writes }` identical to `toSpillWrites()`.
 */
export function checkedSpillWrites(
  anchorRow: number,
  anchorCol: number,
  values: ArrayResult,
  isOccupied: (row: number, col: number) => boolean,
  previousExtent?: SpillExtent,
): { writes: Array<[number, number, InterpreterValue]> } | { error: CellError } {
  if (values.length === 0 || values[0]!.length === 0) {
    return { writes: [] };
  }
  for (let r = 0; r < values.length; r++) {
    const row = values[r]!;
    for (let c = 0; c < row.length; c++) {
      if (r === 0 && c === 0) continue; // anchor keeps the formula
      const rr = anchorRow + r;
      const cc = anchorCol + c;
      if (previousExtent && inExtent(previousExtent, rr, cc)) continue;
      if (isOccupied(rr, cc)) {
        return { error: new CellError(ErrorType.SPILL, 'Spill range blocked.') };
      }
    }
  }
  return { writes: toSpillWrites(anchorRow, anchorCol, values) };
}

/**
 * Spill an array result into a workbook-like host.
 * `setCell(row, col, value)` writes a static value; `getCell(row, col)`
 * reads the current raw content (used for #SPILL! detection).
 * Returns 'ok' or a CellError (#SPILL! when blocked).
 *
 * `previousExtent` (Phase E live/resize contract): the extent this spill
 * last wrote, as tracked by the host. Its cells are never blockers of
 * their own spill, so replay after a recalc is idempotent; members that
 * fall outside the new (possibly resized) extent are cleared, and when
 * the spill is newly blocked its previous members are cleared too, so
 * stale outputs disappear with the #SPILL! exactly as Excel does.
 * CONTRACT: the host MUST remove any cell the user has since edited
 * from `previousExtent` (or drop `previousExtent` entirely) before
 * replaying — cells still listed there are treated as spill outputs
 * and may be cleared. Callers without extent tracking omit it and get
 * the original behaviour (blocked → #SPILL!, nothing written, nothing
 * cleared).
 */
export function spill(
  anchorRow: number,
  anchorCol: number,
  values: ArrayResult,
  setCell: (row: number, col: number, value: InterpreterValue) => void,
  getCell?: (row: number, col: number) => InterpreterValue | undefined,
  previousExtent?: SpillExtent,
): CellError | 'ok' {
  const clearStaleMembers = (written: Set<string>): void => {
    if (!previousExtent) return;
    for (let r = previousExtent.startRow; r <= previousExtent.endRow; r++) {
      for (let c = previousExtent.startCol; c <= previousExtent.endCol; c++) {
        if (r === anchorRow && c === anchorCol) continue;
        if (written.has(`${r}:${c}`)) continue;
        setCell(r, c, null as unknown as InterpreterValue);
      }
    }
  };
  if (values.length === 0 || values[0]!.length === 0) {
    // Spill disappeared (resized to nothing): clear previous outputs.
    clearStaleMembers(new Set());
    return 'ok';
  }
  const written = new Set<string>();
  if (getCell) {
    const checked = checkedSpillWrites(
      anchorRow,
      anchorCol,
      values,
      (r, c) => {
        const cur = getCell(r, c);
        return cur !== undefined && cur !== EmptyValue && cur !== null && cur !== '';
      },
      previousExtent,
    );
    if ('error' in checked) {
      // Blocked: yield #SPILL!, write NO static neighbours, and clear
      // previous outputs (under the previousExtent contract above).
      clearStaleMembers(written);
      return checked.error;
    }
    for (const [r, c, v] of checked.writes) {
      written.add(`${r}:${c}`);
      setCell(r, c, v === EmptyValue ? null as unknown as InterpreterValue : v);
    }
  } else {
    for (const [r, c, v] of toSpillWrites(anchorRow, anchorCol, values)) {
      written.add(`${r}:${c}`);
      setCell(r, c, v === EmptyValue ? null as unknown as InterpreterValue : v);
    }
  }
  // Resize: clear previous members the new result no longer covers
  // (shrunken extent, or ragged rows that no longer reach a column).
  clearStaleMembers(written);
  return 'ok';
}

export class DynamicArrayPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    SEQUENCE: {
      method: 'sequence',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    RANDARRAY: {
      method: 'randarray',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    SORT: {
      method: 'sort',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    SORTBY: {
      method: 'sortby',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 2,
    },
    UNIQUE: {
      method: 'unique',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    DROP: {
      method: 'drop',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    TAKE: {
      method: 'take',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    EXPAND: {
      method: 'expand',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    HSTACK: {
      method: 'hstack',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 1,
    },
    VSTACK: {
      method: 'vstack',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 1,
    },
    TOCOL: {
      method: 'tocol',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    TOROW: {
      method: 'torow',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    WRAPCOLS: {
      method: 'wrapcols',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    WRAPROWS: {
      method: 'wraprows',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    CHOOSECOLS: {
      method: 'choosecols',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 1,
    },
    CHOOSEROWS: {
      method: 'chooserows',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 1,
    },
    TEXTSPLIT: {
      method: 'textsplit',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
    XMATCH: {
      method: 'xmatch',
      parameters: [
        { argumentType: FunctionArgumentType.SCALAR },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
        { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      ],
    },
  };

  private numArg(v: InterpreterValue | undefined, dflt: number): number {
    if (v === undefined || v === EmptyValue) return dflt;
    if (v instanceof CellError) return dflt;
    const n = Number(v);
    return Number.isNaN(n) ? dflt : n;
  }

  public sequence(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('SEQUENCE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const rows = Math.trunc(this.numArg(args[0], 1));
        const cols = Math.trunc(this.numArg(args[1], 1));
        const start = this.numArg(args[2], 1);
        const step = this.numArg(args[3], 1);
        if (rows < 1 || cols < 1 || rows > 10000 || cols > 10000) {
          return new CellError(ErrorType.VALUE, 'Invalid dimensions.');
        }
        const out: ArrayResult = [];
        let v = start;
        for (let r = 0; r < rows; r++) {
          const row: InterpreterValue[] = [];
          for (let c = 0; c < cols; c++) {
            row.push(v);
            v += step;
          }
          out.push(row);
        }
        return asValue(out);
      },
    );
  }

  public randarray(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('RANDARRAY'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const rows = Math.trunc(this.numArg(args[0], 1));
        const cols = Math.trunc(this.numArg(args[1], 1));
        const min = this.numArg(args[2], 0);
        const max = this.numArg(args[3], 1);
        const whole = this.numArg(args[4], 0) !== 0;
        if (rows < 1 || cols < 1 || min >= max) {
          return new CellError(ErrorType.VALUE, 'Invalid arguments.');
        }
        const out: ArrayResult = [];
        for (let r = 0; r < rows; r++) {
          const row: InterpreterValue[] = [];
          for (let c = 0; c < cols; c++) {
            const v = min + Math.random() * (max - min);
            row.push(whole ? Math.floor(v) : v);
          }
          out.push(row);
        }
        return asValue(out);
      },
    );
  }

  public sort(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('SORT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!);
        const sortIndex = Math.trunc(this.numArg(args[1], 1));
        const sortOrder = this.numArg(args[2], 1) >= 0 ? 1 : -1;
        const byCol = this.numArg(args[3], 0) !== 0;
        if (m.length === 0) return asValue(m);
        // Single row/column: sort elements within (Excel 1D behavior).
        if (!byCol && m.length === 1) {
          const row = [...m[0]!];
          row.sort((a, b) => sortOrder * compareValues(a, b));
          return asValue([row]);
        }
        if (byCol && (m[0]?.length ?? 0) === 1) {
          const col = m.map((r) => r[0]!);
          col.sort((a, b) => sortOrder * compareValues(a, b));
          return asValue(col.map((v) => [v]));
        }
        const rows = m.map((r) => [...r]);
        if (byCol) {
          // Sort columns by the sortIndex-th row.
          const keyRow = sortIndex - 1;
          const order = rows[0]!.map((_, c) => c);
          order.sort((ca, cb) => {
            const va = rows[keyRow]?.[ca];
            const vb = rows[keyRow]?.[cb];
            return sortOrder * compareValues(va, vb);
          });
          return asValue(rows.map((r) => order.map((c) => r[c]!)));
        }
        const keyCol = sortIndex - 1;
        rows.sort((ra, rb) => sortOrder * compareValues(ra[keyCol], rb[keyCol]));
        return asValue(rows);
      },
    );
  }

  public sortby(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('SORTBY'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!).map((r) => [...r]);
        // Remaining args come in (by_array, [sort_order]) pairs; sort_order
        // defaults to 1 (ascending) when omitted.
        const keys: Array<{ vals: InterpreterValue[]; order: number }> = [];
        for (let i = 1; i < args.length; i += 2) {
          const by = flatten2D(to2DArray(args[i]!));
          const orderArg = i + 1 < args.length ? args[i + 1] : undefined;
          const order = this.numArg(orderArg, 1) >= 0 ? 1 : -1;
          keys.push({ vals: by, order });
        }
        if (keys.length === 0) return asValue(m);
        // Single row: sort elements within the row by the keys.
        if (m.length === 1) {
          const row = m[0]!;
          const idx = row.map((_, i) => i);
          idx.sort((a, b) => {
            for (const k of keys) {
              const cmp = k.order * compareValues(k.vals[a], k.vals[b]);
              if (cmp !== 0) return cmp;
            }
            return 0;
          });
          return asValue([idx.map((i) => row[i]!)]);
        }
        const idx = m.map((_, i) => i);
        idx.sort((a, b) => {
          for (const k of keys) {
            const cmp = k.order * compareValues(k.vals[a], k.vals[b]);
            if (cmp !== 0) return cmp;
          }
          return 0;
        });
        return asValue(idx.map((i) => m[i]!));
      },
    );
  }

  public unique(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('UNIQUE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!);
        const byCol = this.numArg(args[1], 0) !== 0;
        const exactlyOnce = this.numArg(args[2], 0) !== 0;
        if (m.length === 0) return asValue(m);
        // Single row: dedupe elements within (Excel 1D behavior).
        if (!byCol && m.length === 1) {
          const row = m[0]!;
          const counts = row.map((v) => row.filter((o) => valuesEqual(v, o)).length);
          const keep = row.filter((v, i) =>
            exactlyOnce ? counts[i] === 1 : row.findIndex((o) => valuesEqual(o, v)) === i,
          );
          return asValue([keep]);
        }
        // Single column with byCol: dedupe elements within.
        if (byCol && (m[0]?.length ?? 0) === 1) {
          const col = m.map((r) => r[0]!);
          const counts = col.map((v) => col.filter((o) => valuesEqual(v, o)).length);
          const keep = col.filter((v, i) =>
            exactlyOnce ? counts[i] === 1 : col.findIndex((o) => valuesEqual(o, v)) === i,
          );
          return asValue(keep.map((v) => [v]));
        }
        if (byCol) {
          // Unique columns.
          const cols: InterpreterValue[][] = m[0]!.map((_, c) => m.map((r) => r[c]!));
          const counts = cols.map(
            (col) => cols.filter((o) => rowsEqual(col, o)).length,
          );
          const keep = cols.filter((_, i) =>
            exactlyOnce ? counts[i] === 1 : cols.findIndex((o) => rowsEqual(o, cols[i]!)) === i,
          );
          return asValue(m.map((_, r) => keep.map((col) => col[r]!)));
        }
        const counts = m.map((row) => m.filter((o) => rowsEqual(row, o)).length);
        return asValue(
          m.filter((row, i) =>
            exactlyOnce ? counts[i] === 1 : m.findIndex((o) => rowsEqual(o, row)) === i,
          ),
        );
      },
    );
  }

  public drop(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('DROP'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!);
        const rows = Math.trunc(this.numArg(args[1], 0));
        const cols = Math.trunc(this.numArg(args[2], 0));
        let out = m;
        if (rows > 0) out = out.slice(rows);
        else if (rows < 0) out = out.slice(0, rows);
        if (cols > 0) out = out.map((r) => r.slice(cols));
        else if (cols < 0) out = out.map((r) => r.slice(0, cols));
        if (out.length === 0 || out[0]!.length === 0) {
          return new CellError(ErrorType.VALUE, 'Empty array.');
        }
        return asValue(out);
      },
    );
  }

  public take(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('TAKE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!);
        const rows = Math.trunc(this.numArg(args[1], 0));
        const cols = Math.trunc(this.numArg(args[2], m[0]?.length ?? 0));
        if (rows === 0 || cols === 0) {
          return new CellError(ErrorType.VALUE, 'Empty array.');
        }
        let out = m;
        if (rows > 0) out = out.slice(0, rows);
        else if (rows < 0) out = out.slice(rows);
        if (cols > 0) out = out.map((r) => r.slice(0, cols));
        else if (cols < 0) out = out.map((r) => r.slice(cols));
        return asValue(out);
      },
    );
  }

  public expand(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('EXPAND'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!);
        const rows = Math.trunc(this.numArg(args[1], m.length));
        const cols = Math.trunc(this.numArg(args[2], m[0]?.length ?? 0));
        const pad = args[3] === undefined || args[3] === EmptyValue ? '#N/A' : args[3]!;
        const padVal: InterpreterValue =
          pad === '#N/A' ? new CellError(ErrorType.NA, 'No value.') : pad;
        if (rows < m.length || cols < (m[0]?.length ?? 0)) {
          return new CellError(ErrorType.VALUE, 'Cannot shrink with EXPAND.');
        }
        const out: ArrayResult = [];
        for (let r = 0; r < rows; r++) {
          const row: InterpreterValue[] = [];
          for (let c = 0; c < cols; c++) {
            row.push(r < m.length && c < (m[r]?.length ?? 0) ? m[r]![c]! : padVal);
          }
          out.push(row);
        }
        return asValue(out);
      },
    );
  }

  public hstack(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('HSTACK'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const ms = args.map((a) => to2DArray(a));
        const maxRows = Math.max(...ms.map((m) => m.length), 0);
        const out: ArrayResult = [];
        for (let r = 0; r < maxRows; r++) {
          const row: InterpreterValue[] = [];
          for (const m of ms) {
            const src = m[r] ?? [];
            const width = m[0]?.length ?? 0;
            for (let c = 0; c < width; c++) {
              row.push(src[c] ?? new CellError(ErrorType.NA, 'No value.'));
            }
          }
          out.push(row);
        }
        return asValue(out);
      },
    );
  }

  public vstack(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('VSTACK'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const ms = args.map((a) => to2DArray(a));
        const maxCols = Math.max(...ms.map((m) => m[0]?.length ?? 0), 0);
        const out: ArrayResult = [];
        for (const m of ms) {
          for (const src of m) {
            const row: InterpreterValue[] = [...src];
            while (row.length < maxCols) row.push(new CellError(ErrorType.NA, 'No value.'));
            out.push(row);
          }
        }
        return asValue(out);
      },
    );
  }

  public tocol(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('TOCOL'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!);
        const ignore = Math.trunc(this.numArg(args[1], 0));
        const scanByCol = this.numArg(args[2], 0) !== 0;
        let vals: InterpreterValue[];
        if (scanByCol) {
          vals = [];
          const cols = m[0]?.length ?? 0;
          for (let c = 0; c < cols; c++) for (let r = 0; r < m.length; r++) vals.push(m[r]![c]!);
        } else {
          vals = flatten2D(m);
        }
        const filtered = vals.filter((v) => {
          if (ignore === 1 && (v === EmptyValue || v === '')) return false;
          if (ignore === 2 && v instanceof CellError) return false;
          if (ignore === 3 && (v === EmptyValue || v === '' || v instanceof CellError)) return false;
          return true;
        });
        return asValue(filtered.map((v) => [v]));
      },
    );
  }

  public torow(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('TOROW'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!);
        const ignore = Math.trunc(this.numArg(args[1], 0));
        const scanByCol = this.numArg(args[2], 0) !== 0;
        let vals: InterpreterValue[];
        if (scanByCol) {
          vals = [];
          const cols = m[0]?.length ?? 0;
          for (let c = 0; c < cols; c++) for (let r = 0; r < m.length; r++) vals.push(m[r]![c]!);
        } else {
          vals = flatten2D(m);
        }
        const filtered = vals.filter((v) => {
          if (ignore === 1 && (v === EmptyValue || v === '')) return false;
          if (ignore === 2 && v instanceof CellError) return false;
          if (ignore === 3 && (v === EmptyValue || v === '' || v instanceof CellError)) return false;
          return true;
        });
        return asValue([filtered]);
      },
    );
  }

  public wrapcols(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('WRAPCOLS'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = flatten2D(to2DArray(args[0]!));
        const wrap = Math.trunc(this.numArg(args[1], 1));
        const pad: InterpreterValue =
          args[2] === undefined || args[2] === EmptyValue
            ? new CellError(ErrorType.NA, 'No value.')
            : args[2]!;
        if (wrap < 1) return new CellError(ErrorType.VALUE, 'Invalid wrap count.');
        const cols = Math.ceil(vals.length / wrap);
        const out: ArrayResult = [];
        for (let r = 0; r < wrap; r++) {
          const row: InterpreterValue[] = [];
          for (let c = 0; c < cols; c++) {
            const i = c * wrap + r;
            row.push(i < vals.length ? vals[i]! : pad);
          }
          out.push(row);
        }
        return asValue(out);
      },
    );
  }

  public wraprows(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('WRAPROWS'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const vals = flatten2D(to2DArray(args[0]!));
        const wrap = Math.trunc(this.numArg(args[1], 1));
        const pad: InterpreterValue =
          args[2] === undefined || args[2] === EmptyValue
            ? new CellError(ErrorType.NA, 'No value.')
            : args[2]!;
        if (wrap < 1) return new CellError(ErrorType.VALUE, 'Invalid wrap count.');
        const out: ArrayResult = [];
        for (let i = 0; i < vals.length; i += wrap) {
          const row: InterpreterValue[] = [];
          for (let c = 0; c < wrap; c++) {
            row.push(i + c < vals.length ? vals[i + c]! : pad);
          }
          out.push(row);
        }
        return asValue(out);
      },
    );
  }

  public choosecols(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CHOOSECOLS'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!);
        const width = m[0]?.length ?? 0;
        const picks: number[] = [];
        for (let i = 1; i < args.length; i++) {
          const n = Math.trunc(this.numArg(args[i], 0));
          if (n === 0 || Math.abs(n) > width) {
            return new CellError(ErrorType.VALUE, 'Column out of range.');
          }
          picks.push(n > 0 ? n - 1 : width + n);
        }
        return asValue(m.map((row) => picks.map((c) => row[c]!)));
      },
    );
  }

  public chooserows(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CHOOSEROWS'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const m = to2DArray(args[0]!);
        const picks: number[] = [];
        for (let i = 1; i < args.length; i++) {
          const n = Math.trunc(this.numArg(args[i], 0));
          if (n === 0 || Math.abs(n) > m.length) {
            return new CellError(ErrorType.VALUE, 'Row out of range.');
          }
          picks.push(n > 0 ? n - 1 : m.length + n);
        }
        return asValue(picks.map((r) => [...m[r]!]));
      },
    );
  }

  public textsplit(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('TEXTSPLIT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const text = args[0] instanceof CellError ? args[0] : String(args[0] === EmptyValue ? '' : args[0]);
        if (text instanceof CellError) return text;
        const colDelim = args[1] === undefined || args[1] === EmptyValue ? null : String(args[1]);
        const rowDelim = args[2] === undefined || args[2] === EmptyValue ? null : String(args[2]);
        const ignoreEmpty = args[3] !== undefined && args[3] !== EmptyValue && this.numArg(args[3], 0) !== 0;
        // match_mode / pad_with simplified: pad_with supported.
        const pad: InterpreterValue =
          args[5] === undefined || args[5] === EmptyValue
            ? new CellError(ErrorType.NA, 'No value.')
            : args[5]!;
        const t = text as string;
        const rows = rowDelim !== null ? t.split(rowDelim) : [t];
        const grid = rows.map((r) => (colDelim !== null ? r.split(colDelim) : [r]));
        const filtered = ignoreEmpty ? grid.map((r) => r.filter((s) => s !== '')) : grid;
        const maxCols = Math.max(...filtered.map((r) => r.length), 0);
        return asValue(
          filtered.map((r) => {
            const row: InterpreterValue[] = r.map((s) => s as InterpreterValue);
            while (row.length < maxCols) row.push(pad);
            return row;
          }),
        );
      },
    );
  }

  public xmatch(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('XMATCH'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const lookup = args[0]!;
        if (lookup instanceof CellError) return lookup;
        const arr = flatten2D(to2DArray(args[1]!));
        const matchMode = Math.trunc(this.numArg(args[2], 0));
        // search_mode simplified: 1 = first-to-last only.
        if (matchMode === 0) {
          for (let i = 0; i < arr.length; i++) {
            if (valuesEqual(lookup, arr[i]!)) return i + 1;
          }
          return new CellError(ErrorType.NA, 'No match.');
        }
        if (matchMode === -1 || matchMode === 1) {
          // Exact-or-next-smaller / larger: numeric only, simplified.
          if (typeof lookup !== 'number') {
            return new CellError(ErrorType.VALUE, 'Numeric lookup required.');
          }
          let best = -1;
          let bestVal = matchMode === -1 ? -Infinity : Infinity;
          for (let i = 0; i < arr.length; i++) {
            const v = arr[i]!;
            if (typeof v !== 'number') continue;
            if (matchMode === -1 && v <= lookup && v > bestVal) {
              bestVal = v;
              best = i;
            }
            if (matchMode === 1 && v >= lookup && v < bestVal) {
              bestVal = v;
              best = i;
            }
          }
          return best === -1 ? new CellError(ErrorType.NA, 'No match.') : best + 1;
        }
        return new CellError(ErrorType.VALUE, 'Unsupported match_mode.');
      },
    );
  }
}

export function registerDynamicArrays(): void {
  if (HyperFormula.getFunctionPlugin('SEQUENCE') !== undefined) return;
  const names = {
    SEQUENCE: 'SEQUENCE',
    RANDARRAY: 'RANDARRAY',
    SORT: 'SORT',
    SORTBY: 'SORTBY',
    UNIQUE: 'UNIQUE',
    DROP: 'DROP',
    TAKE: 'TAKE',
    EXPAND: 'EXPAND',
    HSTACK: 'HSTACK',
    VSTACK: 'VSTACK',
    TOCOL: 'TOCOL',
    TOROW: 'TOROW',
    WRAPCOLS: 'WRAPCOLS',
    WRAPROWS: 'WRAPROWS',
    CHOOSECOLS: 'CHOOSECOLS',
    CHOOSEROWS: 'CHOOSEROWS',
    TEXTSPLIT: 'TEXTSPLIT',
    XMATCH: 'XMATCH',
  };
  HyperFormula.registerFunctionPlugin(DynamicArrayPlugin, { enGB: names, enUS: names });
}

registerDynamicArrays();
