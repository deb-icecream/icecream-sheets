/**
 * Excel's intersection (space) operator.
 *
 * HyperFormula 2.7 has no intersection operator: its grammar rejects the
 * space between two references (`=A1:B2 C3:D4`) with a parse error
 * (ErrorType.ERROR), which the engine's HF_ERROR_MAP turns into the typed
 * view's '#ERROR'. Excel instead evaluates the space as the geometric
 * intersection of the two ranges and yields #NULL! — its own distinct
 * error — when they do not overlap. #NULL! is already a member of the
 * engine's ErrorCode union (types.ts); it must surface distinctly, never
 * as #ERROR.
 *
 * No design doc covers error handling or reference operators (checked
 * 2026-10-19); the authority here is Excel semantics plus this repo's
 * established transparent-rewrite pattern (divergent-builtins.ts,
 * named-function-plugin.ts):
 *
 *   setCell:    `A1:B2 C3:D4`  →  `ICEINTERSECT(A1:B2,C3:D4)`
 *   getFormula: `ICEINTERSECT(A1:B2,C3:D4)`  →  `A1:B2 C3:D4`
 *
 * The rewrite is a lexical scan (string/array-literal aware, recursive
 * into parenthesized groups so `=SUM(A1 B2)` works) that wraps maximal
 * runs of reference-operands separated by whitespace into n-ary
 * ICEINTERSECT calls. Only genuine reference atoms qualify (cell, range,
 * column/row range, sheet-qualified, parenthesized, call results); spaces
 * around other operators, inside strings, or inside array constants are
 * never touched. Chained intersections are left-associative by
 * construction (`A1 B2 C3` → one n-ary call), and intersection binds
 * tighter than union, matching Excel (`A1,B2 C3` → `A1,ICEINTERSECT(B2,C3)`).
 *
 * The ICEINTERSECT dispatcher (IntersectionPlugin, below) intersects the
 * operands' absolute ranges with AbsoluteCellRange.intersectionWith —
 * which already returns undefined for cross-sheet and non-overlapping
 * ranges — and returns the overlapping values, or a #NULL! CellError for
 * the empty case. HyperFormula's ErrorType enum has no NULL member
 * (upstream gap), so the error's `type` string is assigned 'NULL'
 * directly; workbook.ts's HF_ERROR_MAP translates it back to the '#NULL!'
 * typed-view code, and localization.ts registers the NULL error literal in
 * every locale pack so the value exporter never throws
 * MissingTranslationError for it.
 *
 * Known limitations (documented, not silent):
 * - Operands whose address cannot be derived (named expressions, array
 *   constants, scalar sub-expressions like `(A1+1)`) yield #VALUE!, which
 *   is Excel's error for non-reference intersection operands.
 * - `=5 5` (pure numbers) is left for HyperFormula to reject as before;
 *   Excel yields #NULL! there, but the rewrite conservatively requires
 *   reference-shaped operands.
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
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { AbsoluteCellRange } from 'hyperformula/commonjs/AbsoluteCellRange.js';
import type {
  Ast,
  CellRangeAst,
  ColumnRangeAst,
  ProcedureAst,
  RowRangeAst,
} from 'hyperformula/typings/parser/Ast.js';
import type { SimpleCellAddress } from 'hyperformula/typings/Cell.js';

/** Internal dispatch token. Never user-visible (un-rewritten on read). */
export const INTERSECT_TOKEN = 'ICEINTERSECT';

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

function isWs(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\f' ||
    ch === '\v'
  );
}

function skipWsFwd(s: string, i: number): number {
  while (i < s.length && isWs(s[i]!)) i++;
  return i;
}

function skipWsBack(s: string, i: number): number {
  while (i >= 0 && isWs(s[i]!)) i--;
  return i;
}

/** Index just past the "..." string literal starting at s[i] === '"'. */
function skipStringFwd(s: string, i: number): number {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    if (s[j] === '"') {
      if (s[j + 1] === '"') {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return n;
}

/**
 * Index just past the `'...'` single-quoted sheet name starting at s[i].
 * Excel escapes a literal quote inside as `''`. Without this, the space in
 * `'INCOME STATEMENT'!A1` would be misread as an intersection operator.
 */
function skipSingleQuotedFwd(s: string, i: number): number {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    if (s[j] === "'") {
      if (s[j + 1] === "'") {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return n;
}

/** Index just past the "{...}" array constant starting at s[i] === '{'. */
function skipBraced(s: string, i: number): number {
  const n = s.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = s[j]!;
    if (c === '"') {
      j = skipStringFwd(s, j);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return n;
}

/** Map of open-paren index → matching close-paren index (string/brace aware). */
function matchParens(s: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === '"') {
      i = skipStringFwd(s, i);
      continue;
    }
    if (c === "'") {
      i = skipSingleQuotedFwd(s, i);
      continue;
    }
    if (c === '{') {
      i = skipBraced(s, i);
      continue;
    }
    if (c === '(') stack.push(i);
    else if (c === ')') {
      const o = stack.pop();
      if (o !== undefined) pairs.set(o, i);
    }
    i++;
  }
  return pairs;
}

/** Index of the ')' matching the '(' at s[open]; -1 when unbalanced. */
function findCloseParen(s: string, open: number): number {
  const pairs = matchParens(s);
  return pairs.get(open) ?? -1;
}

// ---------------------------------------------------------------------------
// Reference atoms
// ---------------------------------------------------------------------------

const REF_CHAR = /[A-Za-z0-9_.$:!]/;
const IDENT_CHAR = /[A-Za-z0-9_.]/;
/** Looks like a cell reference (B2, $A$1) as opposed to a function name (IF). */
const CELLREF_LIKE = /^\$?[A-Za-z]{1,3}\$?[0-9]+$/;

/**
 * True when `atom` is shaped like something the intersection operator can
 * take as an operand: a cell/range/column/row reference (optionally
 * sheet-qualified or quoted-sheet-qualified), a named range, or a
 * parenthesized group / call (validated at evaluation time instead).
 */
function isValidRefAtom(atom: string): boolean {
  if (atom.length === 0) return false;
  const first = atom[0]!;
  if (first === '(') return true; // balanced by construction
  if (first === "'") return atom.includes('!');
  if (first >= '0' && first <= '9') {
    // Row range (1:2); a bare number is not a reference operand.
    return atom.includes(':');
  }
  if (!/[A-Za-z_$]/.test(first)) return false;
  if (/^\d+$/.test(atom)) return false;
  return true;
}

/**
 * [start, end) of the reference atom ending just before `end` in `s`,
 * scanning backwards; null when the text there is not a reference atom.
 * A trailing `)` balances back to its `(` and pulls in a directly-adjacent
 * (or whitespace-separated, non-cellref-looking) function name, so
 * `SUM(A1:B2)` is one atom while `B2 (C3)` stays two.
 */
function backwardAtom(s: string, end: number): [number, number] | null {
  const p = skipWsBack(s, end - 1);
  if (p < 0) return null;
  const ch = s[p]!;
  if (ch === ')') {
    const pairs = matchParens(s);
    let open = -1;
    for (const [o, c] of pairs) {
      if (c === p) {
        open = o;
        break;
      }
    }
    if (open < 0) return null;
    let nameStart = open;
    const q = skipWsBack(s, open - 1);
    if (q >= 0 && IDENT_CHAR.test(s[q]!)) {
      let r = q;
      while (r >= 0 && IDENT_CHAR.test(s[r]!)) r--;
      const name = s.slice(r + 1, q + 1);
      const hadSpace = q < open - 1;
      // `B2 (C3)` is an intersection site, not a call; `IF (A1)` is a call.
      if (!hadSpace || !CELLREF_LIKE.test(name)) nameStart = r + 1;
    }
    return [nameStart, end];
  }
  // Scan back over reference characters, hopping over quoted sheet names.
  let i = p;
  let saw = false;
  while (i >= 0) {
    const c = s[i]!;
    if (c === "'") {
      let q = i - 1;
      let ok = false;
      while (q >= 0) {
        if (s[q] === "'") {
          if (q > 0 && s[q - 1] === "'") {
            q -= 2;
            continue;
          }
          ok = true;
          break;
        }
        q--;
      }
      if (!ok) return null;
      i = q - 1;
      saw = true;
      continue;
    }
    if (REF_CHAR.test(c)) {
      i--;
      saw = true;
      continue;
    }
    break;
  }
  if (!saw) return null;
  const atom = s.slice(i + 1, end);
  return isValidRefAtom(atom) ? [i + 1, end] : null;
}

/**
 * [start, end) of the reference atom starting at `start` in `s`, scanning
 * forwards; null when the text there is not a reference atom. An identifier
 * followed by `(` (even with whitespace between) is a call atom; a
 * trailing `!` continues as a sheet qualifier.
 */
function forwardAtom(
  s: string,
  pairs: Map<number, number>,
  start: number,
): [number, number] | null {
  const n = s.length;
  if (start >= n) return null;
  const ch = s[start]!;
  if (ch === '(') {
    const m = pairs.get(start);
    return m === undefined ? null : [start, m + 1];
  }
  if (ch === "'") {
    let q = start + 1;
    while (q < n) {
      if (s[q] === "'") {
        if (s[q + 1] === "'") {
          q += 2;
          continue;
        }
        break;
      }
      q++;
    }
    if (q >= n || s[q] !== "'" || s[q + 1] !== '!') return null;
    let r = q + 2;
    while (r < n && /[A-Za-z0-9_.$:]/.test(s[r]!)) r++;
    const atom = s.slice(start, r);
    return isValidRefAtom(atom) ? [start, r] : null;
  }
  if (!/[A-Za-z_$\d]/.test(ch)) return null;
  let r = start;
  while (r < n && /[A-Za-z0-9_.$:]/.test(s[r]!)) r++;
  if (s[r] === '!') {
    r++;
    while (r < n && /[A-Za-z0-9_.$:]/.test(s[r]!)) r++;
  }
  const q = skipWsFwd(s, r);
  if (s[q] === '(') {
    const m = pairs.get(q);
    if (m === undefined) return null;
    return [start, m + 1];
  }
  const atom = s.slice(start, r);
  return isValidRefAtom(atom) ? [start, r] : null;
}

// ---------------------------------------------------------------------------
// Rewrite: `A1:B2 C3:D4` → `ICEINTERSECT(A1:B2,C3:D4)`
// ---------------------------------------------------------------------------

/**
 * Collapse whitespace around `:` when it is the range operator
 * (`A1 : B2` → `A1:B2`), so the intersection scan never mis-splits a
 * spaced range. String-literal aware; `:` is the range operator nowhere
 * else in formula text.
 */
function collapseRangeColons(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === '"') {
      const j = skipStringFwd(s, i);
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === ':') {
      let a = out.length - 1;
      while (a >= 0 && isWs(out[a]!)) a--;
      let b = i + 1;
      while (b < n && isWs(s[b]!)) b++;
      const lc = a >= 0 ? out[a]! : '';
      const rc = b < n ? s[b]! : '';
      if (/[A-Za-z0-9_$)']/.test(lc) && /[A-Za-z0-9_$(']/.test(rc)) {
        out = out.slice(0, a + 1) + ':';
        i = b;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

interface Site {
  /** Replacement text for the whole run. */
  text: string;
  /** Start of the run in the already-emitted output (left atoms live there). */
  leftStart: number;
  /** End of the run in the input (first index not consumed). */
  end: number;
}

/**
 * If the whitespace run ending at inp[wsEnd) sits between two reference
 * atoms, gather the maximal run `atom (ws atom)*` around it and build the
 * ICEINTERSECT call. Left atoms are sliced from `out` (already-emitted,
 * inner-rewritten text); right atoms from `inp`. Returns null when this is
 * not an intersection site.
 */
function intersectionSite(
  out: string,
  inp: string,
  pairsIn: Map<number, number>,
  wsEnd: number,
): Site | null {
  const left0 = backwardAtom(out, out.length);
  if (left0 === null) return null;
  const right0 = forwardAtom(inp, pairsIn, wsEnd);
  if (right0 === null) return null;
  const leftText = out.slice(left0[0], left0[1]);
  // `NAME (...)` is call syntax, not an intersection: a bare identifier that
  // is not cellref-shaped (SUM, IF — but not B2) followed by a parenthesized
  // group. The whitespace is copied through and the group still recurses.
  if (
    inp[wsEnd] === '(' &&
    /^[A-Za-z_][A-Za-z0-9_.]*$/.test(leftText) &&
    !CELLREF_LIKE.test(leftText)
  ) {
    return null;
  }

  const atoms: string[] = [];
  let lpos = left0[0];
  atoms.unshift(rewriteLevel(out.slice(left0[0], left0[1])));
  for (;;) {
    const w = skipWsBack(out, lpos - 1);
    if (w < 0 || w === lpos - 1) break;
    const la = backwardAtom(out, w + 1);
    if (la === null) break;
    atoms.unshift(rewriteLevel(out.slice(la[0], la[1])));
    lpos = la[0];
  }
  let rend = right0[1];
  atoms.push(rewriteLevel(inp.slice(right0[0], right0[1])));
  for (;;) {
    const q = skipWsFwd(inp, rend);
    if (q === rend || q >= inp.length) break;
    const ra = forwardAtom(inp, pairsIn, q);
    if (ra === null) break;
    atoms.push(rewriteLevel(inp.slice(ra[0], ra[1])));
    rend = ra[1];
  }
  return {
    text: `${INTERSECT_TOKEN}(${atoms.join(',')})`,
    leftStart: lpos,
    end: rend,
  };
}

/**
 * Rewrite one nesting level: parenthesized groups recurse (so intersections
 * inside function arguments are found), strings and array constants are
 * copied verbatim, and whitespace runs between reference atoms become
 * ICEINTERSECT calls. Idempotent.
 */
function rewriteLevel(s: string): string {
  const pairs = matchParens(s);
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === '"') {
      const j = skipStringFwd(s, i);
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === "'") {
      const j = skipSingleQuotedFwd(s, i);
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === '{') {
      const j = skipBraced(s, i);
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === '(') {
      const m = pairs.get(i);
      if (m === undefined) {
        out += c;
        i++;
        continue;
      }
      out += `(${rewriteLevel(s.slice(i + 1, m))})`;
      i = m + 1;
      continue;
    }
    if (isWs(c)) {
      const j = skipWsFwd(s, i);
      const site = intersectionSite(out, s, pairs, j);
      if (site !== null) {
        out = out.slice(0, site.leftStart) + site.text;
        i = site.end;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Rewrite Excel's intersection (space) operator into ICEINTERSECT dispatch
 * calls. Operates on the full formula text including the leading `=`.
 */
export function rewriteIntersectionOperator(formula: string): string {
  if (!/[ \t\n\r\f\v]/.test(formula)) return formula;
  return rewriteLevel(collapseRangeColons(formula));
}

/** True when the formula text contains ICEINTERSECT dispatch calls. */
export function hasIntersectionCalls(formula: string): boolean {
  return formula.includes(`${INTERSECT_TOKEN}(`);
}

// ---------------------------------------------------------------------------
// Unrewrite: `ICEINTERSECT(A1:B2,C3:D4)` → `A1:B2 C3:D4`
// ---------------------------------------------------------------------------

/** Split on top-level `,`/`;` (locale list separators), paren/brace/quote aware. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === '"') {
      i = skipStringFwd(s, i);
      continue;
    }
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if ((c === ',' || c === ';') && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(s.slice(start));
  return parts;
}

/**
 * Reverse rewriteIntersectionOperator for getFormula/getSerialized, so the
 * UI, snapshots and XLSX export see the user's original `A1:B2 C3:D4`
 * text rather than the dispatch form. Recursive for nested calls.
 */
export function unrewriteIntersectionOperator(formula: string): string {
  const needle = `${INTERSECT_TOKEN}(`;
  let out = '';
  let i = 0;
  for (;;) {
    const k = formula.indexOf(needle, i);
    if (k < 0) {
      out += formula.slice(i);
      break;
    }
    const prev = k > 0 ? formula[k - 1]! : '';
    if (/[A-Za-z0-9_.]/.test(prev)) {
      // Part of a longer identifier, not our token.
      out += formula.slice(i, k + 1);
      i = k + 1;
      continue;
    }
    const m = findCloseParen(formula, k + INTERSECT_TOKEN.length);
    if (m < 0) {
      out += formula.slice(i, k + 1);
      i = k + 1;
      continue;
    }
    const inner = formula.slice(k + INTERSECT_TOKEN.length + 1, m);
    const args = splitTopLevel(inner).map((a) => unrewriteIntersectionOperator(a));
    out += formula.slice(i, k) + args.join(' ');
    i = m + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ICEINTERSECT dispatcher
// ---------------------------------------------------------------------------

/**
 * A #NULL! error. HyperFormula's ErrorType has no NULL member (upstream
 * gap), so the type string is assigned directly; workbook.ts's
 * HF_ERROR_MAP translates 'NULL' back to the '#NULL!' typed-view code.
 */
function nullError(): CellError {
  const e = new CellError(ErrorType.VALUE, 'The intersection is empty.');
  (e as { type: string }).type = 'NULL';
  return e;
}

function valueError(): CellError {
  return new CellError(ErrorType.VALUE, 'ICEINTERSECT: operands must be references.');
}

function absolutizeCellRef(
  ref: { type: string; sheet?: number; row: number; col: number },
  base: SimpleCellAddress,
): SimpleCellAddress {
  const t = ref.type;
  const colAbs = t === 'CELL_REFERENCE_ABSOLUTE' || t === 'CELL_REFERENCE_ABSOLUTE_COL';
  const rowAbs = t === 'CELL_REFERENCE_ABSOLUTE' || t === 'CELL_REFERENCE_ABSOLUTE_ROW';
  return {
    sheet: typeof ref.sheet === 'number' ? ref.sheet : base.sheet,
    col: colAbs ? ref.col : base.col + ref.col,
    row: rowAbs ? ref.row : base.row + ref.row,
  };
}

/**
 * The absolute range an operand covers, or null when it cannot be
 * determined (named expressions, scalar sub-expressions, array constants).
 * Prefers the evaluated value's range address; falls back to absolutizing
 * the AST against the formula address.
 */
function operandRange(
  arg: Ast,
  value: InterpreterValue,
  base: SimpleCellAddress,
): AbsoluteCellRange | null {
  if (value instanceof SimpleRangeValue && value.range !== undefined) {
    return value.range;
  }
  const t = (arg as { type?: string }).type;
  if (t === 'CELL_REFERENCE') {
    const ref = (arg as unknown as { reference: { type: string; sheet?: number; row: number; col: number } })
      .reference;
    if (!ref || typeof ref.row !== 'number' || typeof ref.col !== 'number') return null;
    const addr = absolutizeCellRef(ref, base);
    return AbsoluteCellRange.fromSimpleCellAddresses(addr, addr);
  }
  if (t === 'CELL_RANGE' || t === 'COLUMN_RANGE' || t === 'ROW_RANGE') {
    try {
      return AbsoluteCellRange.fromAst(arg as CellRangeAst | ColumnRangeAst | RowRangeAst, base);
    } catch {
      return null;
    }
  }
  return null;
}

interface DataHolder {
  data: unknown[][];
  range: AbsoluteCellRange;
}

export class IntersectionPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    [INTERSECT_TOKEN]: {
      method: 'iceIntersect',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE }, // ref1
        { argumentType: FunctionArgumentType.RANGE }, // ref2
      ],
      repeatLastArgs: 1, // n-ary: ICEINTERSECT(ref1, ref2, ...)
    },
  };

  /**
   * Excel's intersection operator over 2+ range operands. Returns the
   * overlapping values as a 2-D array (the anchor cell shows the top-left
   * value, matching Excel's implicit intersection), or #NULL! when the
   * ranges do not overlap. A non-reference operand is #VALUE!, matching
   * Excel; an error operand propagates.
   */
  public iceIntersect(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata(INTERSECT_TOKEN),
      (...args: InterpreterValue[]): InterpreterValue => {
        const base = state.formulaAddress;
        let acc: AbsoluteCellRange | undefined;
        let holder: DataHolder | null = null;
        for (let k = 0; k < args.length; k++) {
          const v = args[k]!;
          if (v instanceof CellError) return v;
          const range = operandRange(ast.args[k]!, v, base);
          if (range === null) return valueError();
          if (holder === null && v instanceof SimpleRangeValue) {
            const data = v.data as unknown[][];
            if (Array.isArray(data)) holder = { data, range };
          }
          acc = acc === undefined ? range : acc.intersectionWith(range);
          if (acc === undefined) return nullError();
        }
        if (acc === undefined || holder === null) return valueError();
        // Slice the intersection's values out of the first operand's data,
        // wrapped as an ad-hoc range value (the established plugin pattern —
        // cf. INDIRECT in extended-functions5.ts) so aggregates like SUM and
        // AVERAGE consume the whole intersection. A single-cell intersection
        // returns the scalar itself, matching Excel.
        const dr = acc.start.row - holder.range.start.row;
        const dc = acc.start.col - holder.range.start.col;
        const h = acc.end.row - acc.start.row + 1;
        const w = acc.end.col - acc.start.col + 1;
        const out: InterpreterValue[][] = [];
        for (let r = 0; r < h; r++) {
          const row: InterpreterValue[] = [];
          for (let c = 0; c < w; c++) {
            let cell: unknown = holder.data[dr + r]?.[dc + c];
            // Excel shows 0 for an empty cell reached via intersection.
            if (cell === EmptyValue) cell = 0;
            row.push((cell ?? 0) as InterpreterValue);
          }
          out.push(row);
        }
        if (h === 1 && w === 1) return out[0]![0]!;
        return SimpleRangeValue.onlyValues(out as never);
      },
    );
  }
}

export function registerIntersectionOperator(): void {
  if (HyperFormula.getFunctionPlugin(INTERSECT_TOKEN) !== undefined) return;
  // The token is internal dispatch, never user-typed, so it keeps the same
  // name in every locale (unlike user-facing functions). Registering it for
  // all 7 packs means `=A1:B2 C3:D4` keeps working when the formula language
  // is e.g. deDE — references are locale-independent.
  const names = { [INTERSECT_TOKEN]: INTERSECT_TOKEN };
  HyperFormula.registerFunctionPlugin(IntersectionPlugin, {
    enGB: names,
    enUS: names,
    esES: names,
    frFR: names,
    deDE: names,
    jaJP: names,
    zhCN: names,
  });
}

// Self-register on import (same rationale as divergent-builtins.ts):
// workbook.ts imports the rewrite helpers directly, so the plugin must
// exist whenever workbook code runs, regardless of plugins.ts import order.
registerIntersectionOperator();
