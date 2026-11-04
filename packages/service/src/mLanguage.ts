/**
 * Power Query M-language translator (ecosystem gap).
 *
 * Translates a useful subset of the Power Query M formula language into an
 * equivalent ETL pipeline recipe (see ./etl/recipe.ts). Power Query is the
 * data-shaping language of Excel/Power BI; this lets users paste an M query
 * (e.g. copied from Excel's Advanced Editor) and get a runnable, editable
 * icecream-sheets ETL recipe instead of re-authoring the steps by hand.
 *
 * Coverage (documented; anything else produces a warning or a clear error):
 * - Query shape: `let step = expr, ... in finalStep`
 * - Sources: Csv.Document / Json.Document over Web.Contents(url);
 *   Table.FromRecords / #table literals (as csv-text sources);
 *   File.Contents (warning + empty csv-text placeholder the user fills in).
 * - Transforms: SelectRows (each-comparisons), TransformColumns /
 *   TransformColumnTypes (type conversions, Text.Trim, arithmetic via a
 *   generated `custom` javascript step), RenameColumns, RemoveColumns,
 *   SelectColumns, ReorderColumns, Sort, Group (List.Sum/Average/Count/Min/
 *   Max/Median), Combine (multi-recipe append), NestedJoin/Join (multi-recipe
 *   join), FillDown, Distinct, PromoteHeaders (folds into csv hasHeader),
 *   Unpivot, Pivot, SplitColumn (delimiter), MergeColumns, AddColumn,
 *   DuplicateColumn, ReplaceValue, Buffer (pass-through).
 * - `each` lambdas, `(x) => expr` lambdas, if/then/else, and/or/not,
 *   comparisons, arithmetic, string/number/boolean/null literals,
 *   #date(y,m,d) literals, lists, records, field access `[col]`.
 *
 * Anything the translator cannot represent is reported in `warnings`
 * (per-step, non-fatal) — an unsupported *source* is fatal because the
 * recipe cannot run without one.
 */

import {
  ETL_RECIPE_VERSION,
  defaultFailurePolicy,
  type Aggregation,
  type ConvertTarget,
  type EtlRecipe,
  type EtlSource,
  type FilterOperator,
  type JoinHow,
  type SortDir,
  type TransformNode,
  type TransformOp,
} from './etl/recipe.js';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'ident' | 'qident' | 'string' | 'number'
  | 'lparen' | 'rparen' | 'lbrace' | 'rbrace' | 'lbrack' | 'rbrack'
  | 'comma' | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'plus' | 'minus' | 'star' | 'slash' | 'amp'
  | 'arrow' | 'eof';

interface Token { kind: TokenKind; text: string; pos: number; }

const KEYWORDS = new Set([
  'let', 'in', 'each', 'if', 'then', 'else', 'and', 'or', 'not',
  'true', 'false', 'null', 'as', 'type', 'section', 'shared',
  'otherwise', 'try', 'meta',
]);

function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = src.length;
  const push = (kind: TokenKind, text: string, pos: number): void => { toks.push({ kind, text, pos }); };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\uFEFF') { i++; continue; }
    // Line comments.
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    // Quoted identifier #"...".
    if (c === '#' && src[i + 1] === '"') {
      const start = i; i += 2;
      let name = '';
      while (i < n && src[i] !== '"') { name += src[i]; i++; }
      if (i >= n) throw new MParseError('unterminated quoted identifier', start);
      i++; // closing quote
      push('qident', name, start);
      continue;
    }
    // #date/#time/#datetime literals and #table/#sections intrinsics.
    if (c === '#') {
      const m = /^#(date|time|datetime|table|sections|shared)\b/.exec(src.slice(i));
      if (m) { push('ident', `#${m[1]}`, i); i += m[0].length; continue; }
      // Lone # (used in #table etc. already handled) — treat as ident char.
      push('ident', '#', i); i++; continue;
    }
    // String literal with M escapes: #" ## #n #r #t #(XXXX).
    if (c === '"') {
      const start = i; i++;
      let s = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '#' && i + 1 < n) {
          const e = src[i + 1];
          if (e === '"') { s += '"'; i += 2; continue; }
          if (e === '#') { s += '#'; i += 2; continue; }
          if (e === 'n') { s += '\n'; i += 2; continue; }
          if (e === 'r') { s += '\r'; i += 2; continue; }
          if (e === 't') { s += '\t'; i += 2; continue; }
          if (e === '(') {
            const close = src.indexOf(')', i + 2);
            if (close > 0) {
              const hex = src.slice(i + 2, close);
              const cp = parseInt(hex, 16);
              if (Number.isFinite(cp)) { s += String.fromCodePoint(cp); i = close + 1; continue; }
            }
          }
        }
        s += src[i]; i++;
      }
      if (i >= n) throw new MParseError('unterminated string literal', start);
      i++;
      push('string', s, start);
      continue;
    }
    // Number.
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (m) { push('number', m[0].replace(/_/g, ''), i); i += m[0].length; continue; }
    }
    // Identifier (letters, digits, _, ., and also allow unicode letters).
    if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(src.slice(i));
      if (m) { push('ident', m[0], i); i += m[0].length; continue; }
    }
    // Multi-char operators.
    const two = src.slice(i, i + 2);
    if (two === '=>') { push('arrow', two, i); i += 2; continue; }
    if (two === '<>') { push('neq', two, i); i += 2; continue; }
    if (two === '<=') { push('lte', two, i); i += 2; continue; }
    if (two === '>=') { push('gte', two, i); i += 2; continue; }
    const one: Record<string, TokenKind> = {
      '(': 'lparen', ')': 'rparen', '{': 'lbrace', '}': 'rbrace',
      '[': 'lbrack', ']': 'rbrack', ',': 'comma', '=': 'eq',
      '<': 'lt', '>': 'gt', '+': 'plus', '-': 'minus',
      '*': 'star', '/': 'slash', '&': 'amp',
    };
    const k = one[c];
    if (k) { push(k, c, i); i++; continue; }
    throw new MParseError(`unexpected character "${c}"`, i);
  }
  push('eof', '', n);
  return toks;
}

export class MParseError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`M parse error at offset ${pos}: ${message}`);
    this.name = 'MParseError';
    this.pos = pos;
  }
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type MAst =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'date'; y: number; m: number; d: number }
  | { kind: 'name'; name: string }
  | { kind: 'field'; name: string } // [col] — field of the implicit record
  | { kind: 'call'; fn: string; args: MAst[] }
  | { kind: 'lambda'; params: string[]; body: MAst }
  | { kind: 'each'; body: MAst }
  | { kind: 'list'; items: MAst[] }
  | { kind: 'record'; fields: { name: string; value: MAst }[] }
  | { kind: 'table'; columns: string[]; rows: MAst[][] } // #table literal
  | { kind: 'unary'; op: 'not' | 'neg'; expr: MAst }
  | { kind: 'binary'; op: string; left: MAst; right: MAst }
  | { kind: 'if'; cond: MAst; then: MAst; else: MAst }
  | { kind: 'index'; target: MAst; index: MAst } // expr{...}
  | { kind: 'fieldAccess'; target: MAst; field: string }; // expr[field]

export interface MStep { name: string; expr: MAst; }
export interface MQuery { steps: MStep[]; final: MAst; }

// ---------------------------------------------------------------------------
// Parser (recursive descent over the token stream)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token { return this.toks[this.pos]; }
  private next(): Token { return this.toks[this.pos++]; }
  private eof(): boolean { return this.peek().kind === 'eof'; }

  private expect(kind: TokenKind, what: string): Token {
    const t = this.next();
    if (t.kind !== kind) throw new MParseError(`expected ${what}, found "${t.text}"`, t.pos);
    return t;
  }

  private matchText(word: string): boolean {
    const t = this.peek();
    return t.kind === 'ident' && t.text.toLowerCase() === word;
  }

  private consumeWord(word: string): void {
    const t = this.next();
    if (t.kind !== 'ident' || t.text.toLowerCase() !== word) {
      throw new MParseError(`expected "${word}", found "${t.text}"`, t.pos);
    }
  }

  parseQuery(): MQuery {
    const steps: MStep[] = [];
    if (this.matchText('let')) {
      this.next();
      for (;;) {
        const nameTok = this.next();
        if (nameTok.kind !== 'ident' && nameTok.kind !== 'qident' && nameTok.kind !== 'string') {
          throw new MParseError(`expected step name, found "${nameTok.text}"`, nameTok.pos);
        }
        this.expect('eq', '"="');
        const expr = this.parseExpr();
        steps.push({ name: nameTok.text, expr });
        if (this.peek().kind === 'comma') { this.next(); continue; }
        break;
      }
      this.consumeWord('in');
    }
    const final = this.parseExpr();
    if (!this.eof()) {
      const t = this.peek();
      throw new MParseError(`unexpected trailing input "${t.text}"`, t.pos);
    }
    return { steps, final };
  }

  private parseExpr(): MAst { return this.parseIf(); }

  private parseIf(): MAst {
    if (this.matchText('if')) {
      this.next();
      const cond = this.parseExpr();
      this.consumeWord('then');
      const then = this.parseExpr();
      this.consumeWord('else');
      const els = this.parseExpr();
      return { kind: 'if', cond, then, else: els };
    }
    return this.parseOr();
  }

  private parseOr(): MAst {
    let left = this.parseAnd();
    while (this.matchText('or')) { this.next(); left = { kind: 'binary', op: 'or', left, right: this.parseAnd() }; }
    return left;
  }

  private parseAnd(): MAst {
    let left = this.parseNot();
    while (this.matchText('and')) { this.next(); left = { kind: 'binary', op: 'and', left, right: this.parseNot() }; }
    return left;
  }

  private parseNot(): MAst {
    if (this.matchText('not')) { this.next(); return { kind: 'unary', op: 'not', expr: this.parseNot() }; }
    return this.parseComparison();
  }

  private parseComparison(): MAst {
    let left = this.parseConcat();
    for (;;) {
      const t = this.peek();
      const op = t.kind === 'eq' ? '=' : t.kind === 'neq' ? '<>' : t.kind === 'lt' ? '<'
        : t.kind === 'lte' ? '<=' : t.kind === 'gt' ? '>' : t.kind === 'gte' ? '>=' : null;
      if (!op) return left;
      this.next();
      left = { kind: 'binary', op, left, right: this.parseConcat() };
    }
  }

  private parseConcat(): MAst {
    let left = this.parseAdd();
    while (this.peek().kind === 'amp') { this.next(); left = { kind: 'binary', op: '&', left, right: this.parseAdd() }; }
    return left;
  }

  private parseAdd(): MAst {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'plus' && t.kind !== 'minus') return left;
      this.next();
      left = { kind: 'binary', op: t.text, left, right: this.parseMul() };
    }
  }

  private parseMul(): MAst {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'star' && t.kind !== 'slash') return left;
      this.next();
      left = { kind: 'binary', op: t.text, left, right: this.parseUnary() };
    }
  }

  private parseUnary(): MAst {
    const t = this.peek();
    if (t.kind === 'minus') { this.next(); return { kind: 'unary', op: 'neg', expr: this.parseUnary() }; }
    if (t.kind === 'plus') { this.next(); return this.parseUnary(); }
    return this.parsePostfix();
  }

  private parsePostfix(): MAst {
    let expr = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'lparen' && expr.kind === 'name') {
        this.next();
        const args: MAst[] = [];
        if (this.peek().kind !== 'rparen') {
          for (;;) {
            args.push(this.parseExpr());
            if (this.peek().kind === 'comma') { this.next(); continue; }
            break;
          }
        }
        this.expect('rparen', '")"');
        expr = { kind: 'call', fn: expr.name, args };
        continue;
      }
      if (t.kind === 'lbrack' && expr.kind !== 'field') {
        // expr[field] field access.
        this.next();
        const f = this.next();
        if (f.kind !== 'ident' && f.kind !== 'qident' && f.kind !== 'string') {
          throw new MParseError(`expected field name, found "${f.text}"`, f.pos);
        }
        this.expect('rbrack', '"]"');
        expr = { kind: 'fieldAccess', target: expr, field: f.text };
        continue;
      }
      if (t.kind === 'lbrace') {
        this.next();
        const index = this.parseExpr();
        this.expect('rbrace', '"}"');
        expr = { kind: 'index', target: expr, index };
        continue;
      }
      return expr;
    }
  }

  private parsePrimary(): MAst {
    const t = this.next();
    switch (t.kind) {
      case 'string': return { kind: 'literal', value: t.text };
      case 'number': return { kind: 'literal', value: Number(t.text) };
      case 'qident': return { kind: 'name', name: t.text };
      case 'ident': {
        const low = t.text.toLowerCase();
        if (low === 'true') return { kind: 'literal', value: true };
        if (low === 'false') return { kind: 'literal', value: false };
        if (low === 'null') return { kind: 'literal', value: null };
        if (low === 'each') return { kind: 'each', body: this.parseExpr() };
        // `type <name>` type expressions, e.g. `type text`, `type number`.
        if (low === 'type' && this.peek().kind === 'ident') {
          const tn = this.next();
          return { kind: 'name', name: `type ${tn.text}` };
        }
        if (t.text === '#date' || t.text === '#time' || t.text === '#datetime') {
          this.expect('lparen', '"("');
          const parts: number[] = [];
          for (;;) {
            const p = this.expect('number', 'number');
            parts.push(Number(p.text));
            if (this.peek().kind === 'comma') { this.next(); continue; }
            break;
          }
          this.expect('rparen', '")"');
          if (t.text === '#date' && parts.length >= 3) {
            return { kind: 'date', y: parts[0], m: parts[1], d: parts[2] };
          }
          return { kind: 'literal', value: null }; // time/datetime not needed for filters
        }
        if (t.text === '#table') {
          return this.parseTableLiteral(t.pos);
        }
        // Lambda: (x, y) => expr — detected when ident is followed by , or ).
        // We already consumed one ident; check for lambda form.
        if (this.peek().kind === 'comma' || this.peek().kind === 'rparen') {
          // This path is only reachable if parsePrimary was called in a lambda-ish
          // context; real lambda parsing happens in parseLambda. Treat as name.
          return { kind: 'name', name: t.text };
        }
        return { kind: 'name', name: t.text };
      }
      case 'lbrack': {
        // [col] field ref, or record [a=1, b=2].
        const next = this.peek();
        if ((next.kind === 'ident' || next.kind === 'qident' || next.kind === 'string')) {
          const saved = this.pos;
          const f = this.next();
          if (this.peek().kind === 'rbrack') {
            this.next();
            return { kind: 'field', name: f.text };
          }
          if (this.peek().kind === 'eq') {
            this.pos = saved;
            return this.parseRecord();
          }
          throw new MParseError(`unexpected token "${this.peek().text}" in brackets`, this.peek().pos);
        }
        return this.parseRecord();
      }
      case 'lbrace': {
        const items: MAst[] = [];
        if (this.peek().kind !== 'rbrace') {
          for (;;) {
            items.push(this.parseExpr());
            if (this.peek().kind === 'comma') { this.next(); continue; }
            break;
          }
        }
        this.expect('rbrace', '"}"');
        return { kind: 'list', items };
      }
      case 'lparen': {
        // Lambda or parenthesized expr.
        const saved = this.pos;
        const params = this.tryParseLambdaParams();
        if (params) {
          this.expect('arrow', '"=>"');
          return { kind: 'lambda', params, body: this.parseExpr() };
        }
        this.pos = saved;
        const e = this.parseExpr();
        this.expect('rparen', '")"');
        return e;
      }
      default:
        throw new MParseError(`unexpected token "${t.text}"`, t.pos);
    }
  }

  private tryParseLambdaParams(): string[] | null {
    const params: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'ident' && t.kind !== 'qident') return null;
      // `as type` annotations are not supported — bail to parenthesized expr.
      params.push(t.text);
      this.next();
      if (this.peek().kind === 'comma') { this.next(); continue; }
      if (this.peek().kind === 'rparen') { this.next(); return this.peek().kind === 'arrow' ? params : null; }
      return null;
    }
  }

  private parseRecord(): { kind: 'record'; fields: { name: string; value: MAst }[] } {
    const fields: { name: string; value: MAst }[] = [];
    if (this.peek().kind !== 'rbrack') {
      for (;;) {
        const f = this.next();
        if (f.kind !== 'ident' && f.kind !== 'qident' && f.kind !== 'string') {
          throw new MParseError(`expected record field name, found "${f.text}"`, f.pos);
        }
        this.expect('eq', '"="');
        fields.push({ name: f.text, value: this.parseExpr() });
        if (this.peek().kind === 'comma') { this.next(); continue; }
        break;
      }
    }
    this.expect('rbrack', '"]"');
    return { kind: 'record', fields };
  }

  private parseTableLiteral(pos: number): MAst {
    // #table(columns, rows) or #table(rowCount, columns, rows)
    this.expect('lparen', '"("');
    const first = this.parseExpr();
    this.expect('comma', '","');
    let columns: MAst;
    let rows: MAst;
    if (this.peek().kind !== 'rparen' && this.isTableRowsNext()) {
      columns = first;
      rows = this.parseExpr();
    } else {
      // #table(n, columns, rows)
      columns = this.parseExpr();
      this.expect('comma', '","');
      rows = this.parseExpr();
    }
    this.expect('rparen', '")"');
    if (columns.kind !== 'list' || rows.kind !== 'list') {
      throw new MParseError('#table expects list arguments', pos);
    }
    const cols: string[] = columns.items.map((c) => {
      if (c.kind === 'literal' && typeof c.value === 'string') return c.value;
      throw new MParseError('#table column names must be strings', pos);
    });
    const rowLists: MAst[][] = rows.items.map((r) => {
      if (r.kind !== 'list') throw new MParseError('#table rows must be lists', pos);
      return r.items;
    });
    return { kind: 'table', columns: cols, rows: rowLists };
  }

  private isTableRowsNext(): boolean {
    // Heuristic: if the next expr starts with '{' followed by '{' or a value,
    // it's the rows list. We peek two tokens: lbrace then lbrace/number/string.
    const a = this.toks[this.pos];
    const b = this.toks[this.pos + 1];
    if (!a || a.kind !== 'lbrace') return false;
    return !!b && (b.kind === 'lbrace' || b.kind === 'number' || b.kind === 'string');
  }
}

/** Parse M source text into a query AST. Throws MParseError on syntax errors. */
export function parseM(src: string): MQuery {
  return new Parser(lex(src)).parseQuery();
}

// ---------------------------------------------------------------------------
// Translation to ETL recipes
// ---------------------------------------------------------------------------

export interface MWarning {
  code: string;
  message: string;
  step?: string;
}

export interface MTranslateOptions {
  /** Base id for generated recipes/nodes. Defaults to 'm'. */
  idPrefix?: string;
  /** Owner recorded on generated recipes. Defaults to 'm-translator'. */
  owner?: string;
  /** Include a load node targeting a workbook table. Defaults to true. */
  includeLoad?: boolean;
}

export interface MTranslateResult {
  /** Main recipe first, then one sub-recipe per branched table reference. */
  recipes: EtlRecipe[];
  warnings: MWarning[];
}

interface Ctx {
  warnings: MWarning[];
  idPrefix: string;
  owner: string;
  includeLoad: boolean;
  seq: number;
  /** step name -> compiled node id (main recipe). */
  nodeByStep: Map<string, string>;
  /** step name -> step AST. */
  stepByName: Map<string, MStep>;
  /** step name -> sub-recipe id (for branched references). */
  subRecipeByStep: Map<string, string>;
  subRecipes: EtlRecipe[];
  /** step name -> known column list (best effort, null when unknown). */
  columnsByStep: Map<string, string[] | null>;
  /** step name -> source node id for branch extraction. */
  sourceStep: string | null;
}

function nid(ctx: Ctx, base: string): string {
  ctx.seq += 1;
  return `${ctx.idPrefix}-${base}-${ctx.seq}`;
}

function warn(ctx: Ctx, code: string, message: string, step?: string): void {
  ctx.warnings.push({ code, message, step });
}

/** Normalize an M function name: strip library prefix, lowercase. */
function fnName(full: string): string {
  const dot = full.lastIndexOf('.');
  return (dot >= 0 ? full.slice(dot + 1) : full).toLowerCase();
}

function fnLib(full: string): string {
  const dot = full.lastIndexOf('.');
  return dot >= 0 ? full.slice(0, dot).toLowerCase() : '';
}

// -- Small AST helpers -------------------------------------------------------

function asLiteral(e: MAst): string | number | boolean | null | undefined {
  if (e.kind === 'literal') return e.value;
  if (e.kind === 'date') {
    const mm = String(e.m).padStart(2, '0');
    const dd = String(e.d).padStart(2, '0');
    return `${e.y}-${mm}-${dd}`;
  }
  return undefined;
}

function asStringList(e: MAst): string[] | null {
  if (e.kind !== 'list') return null;
  const out: string[] = [];
  for (const it of e.items) {
    const v = asLiteral(it);
    if (typeof v !== 'string') return null;
    out.push(v);
  }
  return out;
}

/** Unwrap `each body` / `(x) => body` / `(_) => body` to the body. */
function lambdaBody(e: MAst): MAst | null {
  if (e.kind === 'each') return e.body;
  if (e.kind === 'lambda') return e.body;
  return null;
}

/** Extract the column name a field-ref expression denotes, if any. */
function fieldName(e: MAst): string | null {
  if (e.kind === 'field') return e.name;
  if (e.kind === 'fieldAccess') {
    const t = e.target;
    if (t.kind === 'name' && (t.name === '_' || t.name.toLowerCase() === 'r' || t.name.toLowerCase() === 'row')) {
      return e.field;
    }
  }
  return null;
}

// -- M expression -> JavaScript (for `custom` steps) --------------------------

function mToJs(e: MAst, colVar: string): string | null {
  // colVar is the JS expression for the current column value (`_`).
  switch (e.kind) {
    case 'literal':
      return JSON.stringify(e.value);
    case 'date': {
      const mm = String(e.m).padStart(2, '0');
      const dd = String(e.d).padStart(2, '0');
      return JSON.stringify(`${e.y}-${mm}-${dd}`);
    }
    case 'field':
      return `r[${JSON.stringify(e.name)}]`;
    case 'name':
      if (e.name === '_') return colVar;
      return null;
    case 'fieldAccess': {
      const t = mToJs(e.target, colVar);
      if (t === null) return null;
      return `${t}[${JSON.stringify(e.field)}]`;
    }
    case 'unary': {
      const x = mToJs(e.expr, colVar);
      if (x === null) return null;
      return e.op === 'not' ? `!(${x})` : `-(${x})`;
    }
    case 'binary': {
      const l = mToJs(e.left, colVar);
      const r = mToJs(e.right, colVar);
      if (l === null || r === null) return null;
      const op = e.op === '=' ? '===' : e.op === '<>' ? '!==' : e.op === '&' ? '+' : e.op === 'and' ? '&&' : e.op === 'or' ? '||' : e.op;
      if (!['+', '-', '*', '/', '===', '!==', '<', '<=', '>', '>=', '&&', '||'].includes(op)) return null;
      return `(${l} ${op} ${r})`;
    }
    case 'if': {
      const c = mToJs(e.cond, colVar);
      const t = mToJs(e.then, colVar);
      const e2 = mToJs(e.else, colVar);
      if (c === null || t === null || e2 === null) return null;
      return `(${c} ? ${t} : ${e2})`;
    }
    case 'call': {
      const lib = fnLib(e.fn);
      const name = fnName(e.fn);
      const args = e.args.map((a) => mToJs(a, colVar));
      if (args.some((a) => a === null)) return null;
      const A = args as string[];
      if (lib === 'text' || name.startsWith('text.')) {
        if (name === 'trim' && A.length === 1) return `String(${A[0]} ?? '').trim()`;
        if (name === 'upper' && A.length === 1) return `String(${A[0]} ?? '').toUpperCase()`;
        if (name === 'lower' && A.length === 1) return `String(${A[0]} ?? '').toLowerCase()`;
        if (name === 'from' && A.length === 1) return `String(${A[0]} ?? '')`;
        if (name === 'length' && A.length === 1) return `String(${A[0]} ?? '').length`;
        if ((name === 'start' || name === 'end') && A.length === 2) {
          return name === 'start'
            ? `String(${A[0]} ?? '').slice(0, ${A[1]})`
            : `String(${A[0]} ?? '').slice(-(${A[1]}))`;
        }
        if (name === 'replace' && A.length === 3) {
          return `String(${A[0]} ?? '').split(${A[1]}).join(${A[2]})`;
        }
        return null;
      }
      if (lib === 'number' || name.startsWith('number.')) {
        if (name === 'from' && A.length === 1) return `Number(${A[0]})`;
        if (name === 'abs' && A.length === 1) return `Math.abs(${A[0]})`;
        if (name === 'round' && A.length <= 2) {
          return A.length === 2
            ? `(Math.round((${A[0]}) * 10 ** (${A[1]})) / 10 ** (${A[1]}))`
            : `Math.round(${A[0]})`;
        }
        return null;
      }
      if ((lib === 'int64' || lib === 'double' || lib === 'decimal') && name === 'from' && A.length === 1) {
        return `Number(${A[0]})`;
      }
      if (lib === 'logical' && name === 'from' && A.length === 1) {
        return `Boolean(${A[0]})`;
      }
      if ((lib === 'date' || lib === 'datetime') && name === 'from' && A.length === 1) return `${A[0]}`;
      return null;
    }
    default:
      return null;
  }
}

function customJsStep(code: string): TransformOp {
  return { op: 'custom', language: 'javascript', code };
}

// -- Source compilation ------------------------------------------------------

function compileSource(ctx: Ctx, step: MStep): EtlSource {
  const e = step.expr;
  // Table.FromRecords / #table -> csv-text source.
  const csv = tableLiteralToCsv(e);
  if (csv) return { type: 'csv-text', text: csv.text, hasHeader: true };
  if (e.kind === 'call') {
    const lib = fnLib(e.fn);
    const name = fnName(e.fn);
    if (lib === 'csv' && name === 'document') return csvDocumentSource(ctx, step, e);
    if (lib === 'json' && name === 'document') return jsonDocumentSource(ctx, step, e);
    if (lib === 'web' && name === 'contents' && e.args.length >= 1) {
      const url = asLiteral(e.args[0]);
      if (typeof url === 'string') {
        warn(ctx, 'source-unwrapped-web-contents', 'Web.Contents used without Csv/Json.Document; assuming JSON.', step.name);
        return { type: 'url', url, format: 'json' };
      }
    }
    if (lib === 'odata' && name === 'feed' && e.args.length >= 1) {
      const url = asLiteral(e.args[0]);
      if (typeof url === 'string') {
        warn(ctx, 'source-odata', 'OData.Feed mapped to a JSON url source; XML feeds are not supported.', step.name);
        return { type: 'url', url, format: 'json' };
      }
    }
    if (lib === 'excel' && name === 'workbook') {
      throw new MTranslateError(`step "${step.name}": Excel.Workbook has no ETL source equivalent (binary workbook parsing is not a pipeline source).`);
    }
  }
  throw new MTranslateError(
    `step "${step.name}": unsupported source expression. Supported sources: Csv/Json.Document over Web.Contents(url), Table.FromRecords / #table literals.`,
  );
}

function webContentsUrl(e: MAst): string | null {
  if (e.kind === 'call' && fnLib(e.fn) === 'web' && fnName(e.fn) === 'contents' && e.args.length >= 1) {
    const url = asLiteral(e.args[0]);
    return typeof url === 'string' ? url : null;
  }
  return null;
}

function csvDocumentSource(ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>): EtlSource {
  const inner = e.args[0];
  const url = webContentsUrl(inner);
  if (url) return { type: 'url', url, format: 'csv' };
  if (inner.kind === 'call' && fnLib(inner.fn) === 'file' && fnName(inner.fn) === 'contents') {
    const p = asLiteral(inner.args[0]);
    warn(
      ctx,
      'source-file-contents',
      `File.Contents(${JSON.stringify(p ?? '?')}) cannot fetch file bytes in a pipeline; ` +
        'emitted an empty csv-text source — paste the file content into the source node.',
      step.name,
    );
    return { type: 'csv-text', text: '', hasHeader: true };
  }
  throw new MTranslateError(`step "${step.name}": Csv.Document needs Web.Contents(url) or File.Contents(path).`);
}

function jsonDocumentSource(ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>): EtlSource {
  const inner = e.args[0];
  const url = webContentsUrl(inner);
  if (url) return { type: 'url', url, format: 'json' };
  throw new MTranslateError(`step "${step.name}": Json.Document needs Web.Contents(url) as a pipeline source.`);
}

export class MTranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MTranslateError';
  }
}

function csvEscape(v: string | number | boolean | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Table.FromRecords / #table -> CSV text, or null when not a table literal. */
function tableLiteralToCsv(e: MAst): { text: string; columns: string[] } | null {
  let columns: string[];
  let rows: Record<string, string | number | boolean | null>[];
  if (e.kind === 'call' && fnLib(e.fn) === 'table' && fnName(e.fn) === 'fromrecords' && e.args[0]?.kind === 'list') {
    rows = [];
    const colSet: string[] = [];
    for (const item of e.args[0].items) {
      if (item.kind !== 'record') return null;
      const row: Record<string, string | number | boolean | null> = {};
      for (const f of item.fields) {
        const v = asLiteral(f.value);
        if (v === undefined) return null;
        if (!colSet.includes(f.name)) colSet.push(f.name);
        row[f.name] = v;
      }
      rows.push(row);
    }
    columns = colSet;
  } else if (e.kind === 'table') {
    columns = e.columns;
    rows = e.rows.map((r) => {
      const row: Record<string, string | number | boolean | null> = {};
      r.forEach((cell, i2) => {
        const v = asLiteral(cell);
        row[columns[i2]] = v === undefined ? null : v;
      });
      return row;
    });
  } else if (e.kind === 'call' && fnLib(e.fn) === 'table' && fnName(e.fn) === 'fromrows' && e.args[0]?.kind === 'list') {
    // Table.FromRows({{...}}, {"a","b"})
    const colsArg = e.args[1];
    const cols = colsArg ? asStringList(colsArg) : null;
    if (!cols) return null;
    columns = cols;
    rows = [];
    for (const item of e.args[0].items) {
      if (item.kind !== 'list') return null;
      const row: Record<string, string | number | boolean | null> = {};
      item.items.forEach((cell, i2) => {
        const v = asLiteral(cell);
        row[columns[i2]] = v === undefined ? null : v;
      });
      rows.push(row);
    }
  } else {
    return null;
  }
  const text = [columns.join(','), ...rows.map((r) => columns.map((c) => csvEscape(r[c] ?? null)).join(','))].join('\n');
  return { text, columns };
}

// -- Transform compilation ---------------------------------------------------

/** Result of compiling one M step: 0+ ETL transform ops. */
interface StepCompile {
  ops: TransformOp[];
  /** Known output columns after this step (null = unknown). */
  columns: string[] | null;
  /** True when the step was a no-op for the pipeline (e.g. Table.Buffer). */
  passthrough?: boolean;
}

/** Primary table argument of a Table.* call (arg 0), or null. */
function primaryTable(e: Extract<MAst, { kind: 'call' }>): MAst | null {
  return e.args[0] ?? null;
}

/** Step name referenced by an expression, if it is a bare step name. */
function stepRef(ctx: Ctx, e: MAst | null): string | null {
  if (e && e.kind === 'name' && ctx.stepByName.has(e.name)) return e.name;
  return null;
}

function compileTransform(
  ctx: Ctx,
  step: MStep,
  e: Extract<MAst, { kind: 'call' }>,
  inputColumns: string[] | null,
): StepCompile {
  const lib = fnLib(e.fn);
  const name = fnName(e.fn);
  if (lib !== 'table' && !(lib === '' && name === 'buffer')) {
    warn(ctx, 'unsupported-function', `Unsupported function ${e.fn}; step skipped.`, step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  switch (name) {
    case 'buffer':
      return { ops: [], columns: inputColumns, passthrough: true };
    case 'selectrows':
      return compileSelectRows(ctx, step, e);
    case 'transformcolumns':
    case 'transformcolumntypes':
      return compileTransformColumns(ctx, step, e, inputColumns, name === 'transformcolumntypes');
    case 'renamecolumns':
      return compileRenameColumns(ctx, step, e, inputColumns);
    case 'removecolumns':
      return compileRemoveColumns(ctx, step, e, inputColumns);
    case 'selectcolumns':
      return compileSelectColumns(ctx, step, e, 'select', inputColumns);
    case 'reordercolumns':
      return compileSelectColumns(ctx, step, e, 'reorder', inputColumns);
    case 'sort':
      return compileSort(ctx, step, e);
    case 'group':
      return compileGroup(ctx, step, e, inputColumns);
    case 'combine':
      return compileCombine(ctx, step, e);
    case 'nestedjoin':
    case 'join':
      return compileJoin(ctx, step, e, name);
    case 'filldown':
      return compileFillDown(ctx, step, e);
    case 'distinct':
      return compileDistinct(ctx, step, e, inputColumns);
    case 'promoteheaders':
      return compilePromoteHeaders(ctx, step, inputColumns);
    case 'unpivot':
    case 'unpivotedcolumns':
      return compileUnpivot(ctx, step, e, inputColumns);
    case 'pivot':
      return compilePivot(ctx, step, e, inputColumns);
    case 'splitcolumn':
      return compileSplitColumn(ctx, step, e, inputColumns);
    case 'mergecolumns':
    case 'combinecolumns':
      return compileMergeColumns(ctx, step, e, inputColumns);
    case 'addcolumn':
      return compileAddColumn(ctx, step, e, inputColumns);
    case 'duplicatecolumn':
      return compileDuplicateColumn(ctx, step, e, inputColumns);
    case 'replacevalue':
      return compileReplaceValue(ctx, step, e);
    case 'firstn':
    case 'skip':
    case 'reverseRows':
    case 'reverserows':
      warn(ctx, 'unsupported-transform', `Table.${e.fn} has no ETL equivalent; step skipped.`, step.name);
      return { ops: [], columns: inputColumns, passthrough: true };
    default:
      warn(ctx, 'unsupported-transform', `Table.${name} is not mapped to an ETL transform; step skipped.`, step.name);
      return { ops: [], columns: inputColumns, passthrough: true };
  }
}

// -- individual transform compilers ------------------------------------------

function mFilterOperator(op: string): FilterOperator | null {
  switch (op) {
    case '=': return 'eq';
    case '<>': return 'neq';
    case '>': return 'gt';
    case '>=': return 'gte';
    case '<': return 'lt';
    case '<=': return 'lte';
    default: return null;
  }
}

function compileSelectRows(ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>): StepCompile {
  const body = lambdaBody(e.args[1]);
  if (!body) {
    warn(ctx, 'selectrows-shape', 'Table.SelectRows needs an `each` predicate; step skipped.', step.name);
    return { ops: [], columns: null, passthrough: true };
  }
  // Split `and` chains into multiple filter nodes.
  const conjuncts: MAst[] = [];
  const split = (x: MAst): void => {
    if (x.kind === 'binary' && x.op === 'and') { split(x.left); split(x.right); } else conjuncts.push(x);
  };
  split(body);
  const ops: TransformOp[] = [];
  for (const c of conjuncts) {
    if (c.kind !== 'binary') {
      warn(ctx, 'selectrows-shape', `Unsupported predicate shape in Table.SelectRows; step skipped.`, step.name);
      return { ops: [], columns: null, passthrough: true };
    }
    const col = fieldName(c.left) ?? fieldName(c.right);
    const valSide = fieldName(c.left) ? c.right : c.left;
    const flipped = fieldName(c.left) ? c.op : flipOp(c.op);
    if (!col || flipped === null) {
      warn(ctx, 'selectrows-shape', 'Table.SelectRows predicate must compare [column] to a literal; step skipped.', step.name);
      return { ops: [], columns: null, passthrough: true };
    }
    const v = asLiteral(valSide);
    if (v === undefined) {
      warn(ctx, 'selectrows-shape', 'Table.SelectRows predicate must compare [column] to a literal; step skipped.', step.name);
      return { ops: [], columns: null, passthrough: true };
    }
    if (v === null) {
      if (flipped === '=') ops.push({ op: 'filter', column: col, operator: 'is-null' });
      else if (flipped === '<>') ops.push({ op: 'filter', column: col, operator: 'is-not-null' });
      else {
        warn(ctx, 'selectrows-shape', 'Null comparisons other than = / <> are not supported; step skipped.', step.name);
        return { ops: [], columns: null, passthrough: true };
      }
      continue;
    }
    const operator = mFilterOperator(flipped);
    if (!operator) {
      warn(ctx, 'selectrows-shape', `Operator "${c.op}" has no ETL filter equivalent; step skipped.`, step.name);
      return { ops: [], columns: null, passthrough: true };
    }
    ops.push({ op: 'filter', column: col, operator, value: v });
  }
  return { ops, columns: null }; // columns unchanged; caller keeps input columns
}

function flipOp(op: string): string | null {
  switch (op) {
    case '>': return '<';
    case '<': return '>';
    case '>=': return '<=';
    case '<=': return '>=';
    case '=': return '=';
    case '<>': return '<>';
    default: return null;
  }
}

function mTypeToConvert(e: MAst): ConvertTarget | null {
  if (e.kind !== 'name') return null;
  const t = e.name.toLowerCase();
  if (t === 'int64.type' || t === 'double.type' || t === 'decimal.type' || t === 'number.type' || t === 'currency.type' || t === 'type number') return 'number';
  if (t === 'text.type' || t === 'type text') return 'text';
  if (t === 'date.type' || t === 'datetime.type' || t === 'datetimezone.type' || t === 'time.type' || t === 'type date') return 'date';
  if (t === 'logical.type' || t === 'type logical') return 'boolean';
  return null;
}

function compileTransformColumns(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>,
  inputColumns: string[] | null, isTypesForm: boolean,
): StepCompile {
  const spec = e.args[1];
  if (spec?.kind !== 'list') {
    warn(ctx, 'transformcolumns-shape', 'Table.TransformColumns needs a list of {column, transform} pairs; step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const ops: TransformOp[] = [];
  for (const item of spec.items) {
    if (item.kind !== 'list' || item.items.length < 2) {
      warn(ctx, 'transformcolumns-shape', 'Skipping malformed column-transform pair.', step.name);
      continue;
    }
    const colLit = asLiteral(item.items[0]);
    if (typeof colLit !== 'string') {
      warn(ctx, 'transformcolumns-shape', 'Column-transform pair needs a string column name.', step.name);
      continue;
    }
    const t = item.items[1];
    const conv = mTypeToConvert(t);
    if (conv || isTypesForm) {
      if (conv) { ops.push({ op: 'convert', column: colLit, to: conv }); continue; }
      warn(ctx, 'transformcolumns-type', `Unknown M type for column "${colLit}"; skipped.`, step.name);
      continue;
    }
    // Function form: Text.Trim, each Number.From(_), each _ * 2, ...
    const fnBody = lambdaBody(t);
    const expr = fnBody ?? (t.kind === 'name'
      ? { kind: 'call' as const, fn: t.name, args: [{ kind: 'name' as const, name: '_' }] }
      : null);
    if (!expr) {
      warn(ctx, 'transformcolumns-shape', `Unsupported transform for column "${colLit}"; skipped.`, step.name);
      continue;
    }
    // Fast paths for well-known conversions.
    if (expr.kind === 'call') {
      const lib = fnLib(expr.fn);
      const nm = fnName(expr.fn);
      if ((lib === 'number' || lib === 'int64' || lib === 'double' || lib === 'decimal') && nm === 'from') {
        ops.push({ op: 'convert', column: colLit, to: 'number' }); continue;
      }
      if (lib === 'text' && nm === 'from') { ops.push({ op: 'convert', column: colLit, to: 'text' }); continue; }
      if (lib === 'logical' && nm === 'from') { ops.push({ op: 'convert', column: colLit, to: 'boolean' }); continue; }
      if ((lib === 'date' || lib === 'datetime') && nm === 'from') { ops.push({ op: 'convert', column: colLit, to: 'date' }); continue; }
    }
    const js = mToJs(expr, `r[${JSON.stringify(colLit)}]`);
    if (js === null) {
      warn(ctx, 'transformcolumns-expr', `Cannot translate the transform for column "${colLit}"; skipped.`, step.name);
      continue;
    }
    ops.push(customJsStep(
      `(() => {\n` +
      `  const rows = input.rows.map((r) => ({ ...r, ${JSON.stringify(colLit)}: (${js}) }));\n` +
      `  return { columns: input.columns, rows };\n` +
      `})()`,
    ));
  }
  return { ops, columns: inputColumns };
}

function compileRenameColumns(ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null): StepCompile {
  const spec = e.args[1];
  const pairs = spec?.kind === 'list' ? spec.items : null;
  if (!pairs) {
    warn(ctx, 'renamecolumns-shape', 'Table.RenameColumns needs a list of {old, new} pairs; step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const mapping: Record<string, string> = {};
  for (const p of pairs) {
    if (p.kind !== 'list' || p.items.length < 2) continue;
    const from = asLiteral(p.items[0]);
    const to = asLiteral(p.items[1]);
    if (typeof from === 'string' && typeof to === 'string') mapping[from] = to;
  }
  if (Object.keys(mapping).length === 0) {
    warn(ctx, 'renamecolumns-shape', 'Table.RenameColumns had no valid pairs; step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const columns = inputColumns ? inputColumns.map((c) => mapping[c] ?? c) : null;
  return { ops: [{ op: 'rename', mapping }], columns };
}

function compileRemoveColumns(ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null): StepCompile {
  const cols = e.args[1] ? asStringList(e.args[1]) : null;
  if (!cols) {
    warn(ctx, 'removecolumns-shape', 'Table.RemoveColumns needs a list of column names; step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  return { ops: [{ op: 'drop', columns: cols }], columns: inputColumns ? inputColumns.filter((c) => !cols.includes(c)) : null };
}

function compileSelectColumns(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, mode: 'select' | 'reorder', inputColumns: string[] | null,
): StepCompile {
  const cols = e.args[1] ? asStringList(e.args[1]) : null;
  if (!cols) {
    warn(ctx, 'selectcolumns-shape', 'Column list must be string literals; step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  if (mode === 'reorder' && inputColumns) {
    const rest = inputColumns.filter((c) => !cols.includes(c));
    const ordered = [...cols, ...rest];
    return { ops: [{ op: 'select', columns: ordered }], columns: ordered };
  }
  return { ops: [{ op: 'select', columns: cols }], columns: cols };
}

function compileSort(ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>): StepCompile {
  const spec = e.args[1];
  if (spec?.kind !== 'list') {
    warn(ctx, 'sort-shape', 'Table.Sort needs a list of {column, Order} pairs; step skipped.', step.name);
    return { ops: [], columns: null, passthrough: true };
  }
  const keys: { column: string; dir: SortDir }[] = [];
  for (const item of spec.items) {
    if (item.kind === 'list' && item.items.length >= 1) {
      const col = asLiteral(item.items[0]);
      const order = item.items[1]?.kind === 'name' ? item.items[1].name.toLowerCase() : 'order.ascending';
      if (typeof col === 'string') {
        keys.push({ column: col, dir: order.includes('descending') ? 'desc' : 'asc' });
      }
    } else if (item.kind === 'literal' && typeof item.value === 'string') {
      keys.push({ column: item.value, dir: 'asc' });
    } else if (item.kind === 'name') {
      keys.push({ column: item.name, dir: 'asc' });
    }
  }
  if (keys.length === 0) {
    warn(ctx, 'sort-shape', 'Table.Sort had no valid sort keys; step skipped.', step.name);
    return { ops: [], columns: null, passthrough: true };
  }
  return { ops: [{ op: 'sort', keys }], columns: null };
}

function compileGroup(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null,
): StepCompile {
  const keys = e.args[1] ? asStringList(e.args[1]) : null;
  const aggs = e.args[2]?.kind === 'list' ? e.args[2].items : null;
  if (!keys || !aggs) {
    warn(ctx, 'group-shape', 'Table.Group needs key columns and an aggregation list; step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const aggregations: { column: string; agg: Aggregation; as: string }[] = [];
  const outCols = [...keys];
  for (const a of aggs) {
    if (a.kind !== 'list' || a.items.length < 2) {
      warn(ctx, 'group-shape', 'Skipping malformed aggregation entry.', step.name);
      continue;
    }
    const asName = asLiteral(a.items[0]);
    const aggBody = lambdaBody(a.items[1]);
    if (typeof asName !== 'string' || !aggBody || aggBody.kind !== 'call') {
      warn(ctx, 'group-shape', 'Aggregation must be {"name", each List.X([col])}; skipped.', step.name);
      continue;
    }
    const aggName = fnName(aggBody.fn);
    const colArg = aggBody.args[0];
    const col = colArg ? fieldName(colArg) : null;
    const map: Record<string, Aggregation> = {
      sum: 'sum', average: 'avg', count: 'count', min: 'min', max: 'max', median: 'avg',
    };
    const agg = map[aggName];
    if (!agg) {
      warn(ctx, 'group-agg', `List.${aggName} has no ETL aggregation equivalent; skipped.`, step.name);
      continue;
    }
    if (aggName === 'median') warn(ctx, 'group-agg', 'List.Median approximated as average.', step.name);
    aggregations.push({ column: col ?? keys[0], agg, as: asName });
    outCols.push(asName);
  }
  if (aggregations.length === 0) {
    warn(ctx, 'group-shape', 'Table.Group had no usable aggregations; step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  return { ops: [{ op: 'group-by', keys, aggregations }], columns: outCols };
}

function compileCombine(ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>): StepCompile {
  const list = e.args[0]?.kind === 'list' ? e.args[0].items : null;
  if (!list || list.length === 0) {
    warn(ctx, 'combine-shape', 'Table.Combine needs a non-empty list of tables; step skipped.', step.name);
    return { ops: [], columns: null, passthrough: true };
  }
  const refs = list.map((t) => stepRef(ctx, t));
  if (refs.some((r) => r === null)) {
    warn(ctx, 'combine-shape', 'Table.Combine tables must be earlier let-steps; step skipped.', step.name);
    return { ops: [], columns: null, passthrough: true };
  }
  const names = refs as string[];
  // Primary = first table; the rest become sub-recipes.
  const withRef = names.slice(1).map((n) => ({ kind: 'recipe' as const, recipeId: ensureSubRecipe(ctx, n) }));
  let columns = ctx.columnsByStep.get(names[0]) ?? null;
  const ops: TransformOp[] = withRef.map((w) => ({ op: 'append', with: w }));
  return { ops, columns };
}

function compileJoin(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, joinFn: string,
): StepCompile {
  // Table.NestedJoin(t1, {k1}, t2, {k2}, "newcol", JoinKind.X) or Table.Join(t1, {k1}, t2, {k2}, JoinKind.X)
  const t1 = stepRef(ctx, e.args[0]);
  const k1 = e.args[1] ? asStringList(e.args[1]) : null;
  const t2 = stepRef(ctx, e.args[2]);
  const k2 = e.args[3] ? asStringList(e.args[3]) : null;
  const kindArg = e.args[e.args.length - 1];
  const kindName = kindArg?.kind === 'name' ? kindArg.name.toLowerCase() : 'joinkind.inner';
  const howMap: Record<string, JoinHow> = {
    'joinkind.inner': 'inner', 'inner': 'inner',
    'joinkind.leftouter': 'left', 'leftouter': 'left',
    'joinkind.rightouter': 'right', 'rightouter': 'right',
    'joinkind.fullouter': 'outer', 'fullouter': 'outer',
  };
  const how = howMap[kindName];
  if (!t1 || !t2 || !k1 || !k2 || !how) {
    warn(ctx, 'join-shape', 'Join needs table steps, key lists and a JoinKind; step skipped.', step.name);
    return { ops: [], columns: null, passthrough: true };
  }
  if (joinFn === 'nestedjoin') {
    warn(ctx, 'join-nested', 'Table.NestedJoin flattened to a plain join (nested expansion is not modeled).', step.name);
  }
  if (!k1.every((k, i) => k === k2[i])) {
    warn(ctx, 'join-keys', 'Join key names differ between sides; the ETL join requires shared names — using the left keys.', step.name);
  }
  return {
    ops: [{ op: 'join', with: { kind: 'recipe', recipeId: ensureSubRecipe(ctx, t2) }, on: k1, how }],
    columns: null,
  };
}

function compileFillDown(ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>): StepCompile {
  const cols = e.args[1] ? asStringList(e.args[1]) : null;
  if (!cols || cols.length === 0) {
    warn(ctx, 'filldown-shape', 'Table.FillDown needs a column list; step skipped.', step.name);
    return { ops: [], columns: null, passthrough: true };
  }
  return { ops: cols.map((c): TransformOp => ({ op: 'fill-down', column: c })), columns: null };
}

function compileDistinct(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null,
): StepCompile {
  const cols = e.args[1] ? (asStringList(e.args[1]) ?? undefined) : undefined;
  if (e.args[1] && !cols) {
    warn(ctx, 'distinct-shape', 'Table.Distinct key must be a column list; step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  return { ops: [{ op: 'deduplicate', columns: cols }], columns: inputColumns };
}

function compilePromoteHeaders(ctx: Ctx, step: MStep, inputColumns: string[] | null): StepCompile {
  void ctx; void step;
  // Handled by folding into the csv source (hasHeader). If we reach here the
  // source was not a csv-text we control — keep as a no-op with the note that
  // the ETL source already treats the first row as headers.
  return { ops: [], columns: inputColumns, passthrough: true };
}

function compileUnpivot(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null,
): StepCompile {
  // Table.Unpivot(t, {"a","b"}, "Attribute", "Value")
  const idCols = e.args[1] ? asStringList(e.args[1]) : null;
  const attr = asLiteral(e.args[2]);
  const val = asLiteral(e.args[3]);
  if (!idCols || typeof attr !== 'string' || typeof val !== 'string') {
    warn(ctx, 'unpivot-shape', 'Table.Unpivot needs (table, id columns, attribute name, value name); step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const valueColumns = inputColumns ? inputColumns.filter((c) => !idCols.includes(c)) : undefined;
  return {
    ops: [{ op: 'unpivot', idColumns: idCols, variableColumn: attr, valueColumn: val, valueColumns }],
    columns: [...idCols, attr, val],
  };
}

function compilePivot(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null,
): StepCompile {
  // Table.Pivot(t, pivotValues, "attributeCol", "valueCol", List.Sum)
  const attr = asLiteral(e.args[2]);
  const val = asLiteral(e.args[3]);
  const aggArg = e.args[4];
  if (typeof attr !== 'string' || typeof val !== 'string') {
    warn(ctx, 'pivot-shape', 'Table.Pivot needs (table, values, attribute column, value column); step skipped.', step.name);
    return { ops: [], columns: null, passthrough: true };
  }
  let agg: Aggregation = 'sum';
  if (aggArg?.kind === 'name' || aggArg?.kind === 'call') {
    const nm = aggArg.kind === 'name' ? aggArg.name : aggArg.fn;
    const m: Record<string, Aggregation> = { sum: 'sum', average: 'avg', count: 'count', min: 'min', max: 'max' };
    agg = m[fnName(nm)] ?? 'sum';
  }
  const index = inputColumns ? inputColumns.filter((c) => c !== attr && c !== val) : [];
  if (!inputColumns) {
    warn(ctx, 'pivot-columns', 'Table.Pivot index columns unknown (schema not tracked); using none.', step.name);
  }
  return { ops: [{ op: 'pivot', index, column: attr, value: val, agg }], columns: null };
}

function compileSplitColumn(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null,
): StepCompile {
  // Table.SplitColumn(t, "col", Splitter.SplitTextByDelimiter(","), {"a","b"})
  const col = asLiteral(e.args[1]);
  const splitter = e.args[2];
  let delimiter: string | null = null;
  if (splitter?.kind === 'call') {
    const nm = fnName(splitter.fn);
    if ((nm === 'splittextbydelimiter' || nm === 'splittextbyeachdelimiter') && splitter.args[0]) {
      const d = asLiteral(splitter.args[0]);
      if (typeof d === 'string') delimiter = d;
    }
  } else if (typeof splitter === 'string') {
    delimiter = splitter;
  }
  const intoCols = e.args[3] ? asStringList(e.args[3]) : null;
  if (typeof col !== 'string' || !delimiter || !intoCols) {
    warn(ctx, 'splitcolumn-shape', 'Table.SplitColumn needs (table, column, Splitter.SplitTextByDelimiter(d), new names); step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const columns = inputColumns
    ? [...inputColumns.filter((c) => c !== col), ...intoCols]
    : null;
  return { ops: [{ op: 'split', column: col, delimiter, into: intoCols }], columns };
}

function compileMergeColumns(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null,
): StepCompile {
  // Table.CombineColumns(t, {"a","b"}, Combiner.CombineTextByDelimiter(","), "merged")
  // or Table.MergeColumns(t, {"a","b"}, ",", "merged")
  const cols = e.args[1] ? asStringList(e.args[1]) : null;
  const combiner = e.args[2];
  const into = asLiteral(e.args[3]);
  let delimiter: string | null = null;
  if (combiner?.kind === 'call' && fnName(combiner.fn) === 'combinetextbydelimiter') {
    const d = asLiteral(combiner.args[0]);
    if (typeof d === 'string') delimiter = d;
  } else if (combiner && asLiteral(combiner) !== undefined) {
    const d = asLiteral(combiner);
    if (typeof d === 'string') delimiter = d;
  }
  if (!cols || delimiter === null || typeof into !== 'string') {
    warn(ctx, 'mergecolumns-shape', 'Table.CombineColumns needs (table, columns, delimiter, new name); step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const columns = inputColumns ? [...inputColumns.filter((c) => !cols.includes(c)), into] : null;
  return { ops: [{ op: 'merge-columns', columns: cols, delimiter, into }], columns };
}

function compileAddColumn(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null,
): StepCompile {
  // Table.AddColumn(t, "new", each [a] + [b], type number)
  const name = asLiteral(e.args[1]);
  const body = lambdaBody(e.args[2]);
  if (typeof name !== 'string' || !body) {
    warn(ctx, 'addcolumn-shape', 'Table.AddColumn needs (table, name, each expr); step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const js = mToJs(body, 'undefined');
  if (js === null) {
    warn(ctx, 'addcolumn-expr', `Cannot translate the Table.AddColumn expression for "${name}"; step skipped.`, step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const columns = inputColumns ? [...inputColumns, name] : null;
  return {
    ops: [customJsStep(
      `(() => {\n` +
      `  const rows = input.rows.map((r) => ({ ...r, ${JSON.stringify(name)}: (${js}) }));\n` +
      `  return { columns: [...input.columns, ${JSON.stringify(name)}], rows };\n` +
      `})()`,
    )],
    columns,
  };
}

function compileDuplicateColumn(
  ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>, inputColumns: string[] | null,
): StepCompile {
  const from = asLiteral(e.args[1]);
  const to = asLiteral(e.args[2]);
  if (typeof from !== 'string' || typeof to !== 'string') {
    warn(ctx, 'duplicatecolumn-shape', 'Table.DuplicateColumn needs (table, source, new name); step skipped.', step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  const columns = inputColumns ? [...inputColumns, to] : null;
  return {
    ops: [customJsStep(
      `(() => {\n` +
      `  const rows = input.rows.map((r) => ({ ...r, ${JSON.stringify(to)}: r[${JSON.stringify(from)}] }));\n` +
      `  return { columns: [...input.columns, ${JSON.stringify(to)}], rows };\n` +
      `})()`,
    )],
    columns,
  };
}

function compileReplaceValue(ctx: Ctx, step: MStep, e: Extract<MAst, { kind: 'call' }>): StepCompile {
  // Table.ReplaceValue(t, old, new, Replacer.ReplaceValue, {"col"})
  const oldV = e.args[1] ? asLiteral(e.args[1]) : undefined;
  const newV = e.args[2] ? asLiteral(e.args[2]) : undefined;
  const cols = e.args[4] ? asStringList(e.args[4]) : null;
  if (oldV === undefined || newV === undefined || !cols) {
    warn(ctx, 'replacevalue-shape', 'Table.ReplaceValue needs (table, old, new, replacer, columns); step skipped.', step.name);
    return { ops: [], columns: null, passthrough: true };
  }
  const colList = JSON.stringify(cols);
  return {
    ops: [customJsStep(
      `(() => {\n` +
      `  const cols = ${colList};\n` +
      `  const rows = input.rows.map((r) => {\n` +
      `    const nr = { ...r };\n` +
      `    for (const c of cols) { if (nr[c] === ${JSON.stringify(oldV)}) nr[c] = ${JSON.stringify(newV)}; }\n` +
      `    return nr;\n` +
      `  });\n` +
      `  return { columns: input.columns, rows };\n` +
      `})()`,
    )],
    columns: null,
  };
}

// -- Branch (sub-recipe) extraction -------------------------------------------

/**
 * Build a standalone recipe for the linear chain ending at step `name`
 * (used when Table.Combine/Join references a table that is not the chain
 * head). The branch's source is cloned so each recipe keeps exactly one
 * source node.
 */
function ensureSubRecipe(ctx: Ctx, name: string): string {
  const existing = ctx.subRecipeByStep.get(name);
  if (existing) return existing;
  const chain = linearChain(ctx, name);
  const recipeId = `${ctx.idPrefix}-branch-${ctx.subRecipeByStep.size + 1}`;
  const nodes: EtlRecipe['nodes'] = [];
  const edges: EtlRecipe['edges'] = [];
  let prev: string | null = null;
  let columns: string[] | null = null;
  for (const stepName of chain) {
    const step = ctx.stepByName.get(stepName)!;
    const nodeId = nid(ctx, `b${ctx.subRecipeByStep.size + 1}`);
    const isSource = stepName === chain[0];
    if (isSource) {
      const source = compileSource(ctx, step);
      // PromoteHeaders folding for branch sources too.
      nodes.push({ id: nodeId, kind: 'source', label: stepName, source });
      columns = sourceColumnsOf(source);
    } else {
      const compiled = compileStepOps(ctx, step, columns);
      for (const op of compiled.ops) {
        const opNodeId = nid(ctx, `b${ctx.subRecipeByStep.size + 1}`);
        const tNode: TransformNode = { id: opNodeId, kind: 'transform', label: stepName, transform: op };
        nodes.push(tNode);
        if (prev) edges.push({ from: prev, to: opNodeId });
        prev = opNodeId;
      }
      if (compiled.ops.length > 0) {
        columns = compiled.columns ?? columns;
      }
      continue;
    }
    if (prev) edges.push({ from: prev, to: nodeId });
    prev = nodeId;
    ctx.columnsByStep.set(stepName, columns);
  }
  if (prev) {
    const loadId = nid(ctx, `b${ctx.subRecipeByStep.size + 1}`);
    nodes.push({
      id: loadId,
      kind: 'load',
      label: name,
      target: { kind: 'workbook-table', workbookId: '', sheetName: name, tableName: name },
    });
    edges.push({ from: prev, to: loadId });
  }
  const recipe: EtlRecipe = {
    version: ETL_RECIPE_VERSION,
    id: recipeId,
    name: `M branch: ${name}`,
    owner: ctx.owner,
    nodes,
    edges,
    schedule: { trigger: 'manual' },
    failurePolicy: defaultFailurePolicy(),
  };
  ctx.subRecipes.push(recipe);
  ctx.subRecipeByStep.set(name, recipeId);
  return recipeId;
}

/** Linear chain of step names from the source step to `target` (inclusive). */
function linearChain(ctx: Ctx, target: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = target;
  while (cur) {
    if (seen.has(cur)) throw new MTranslateError(`circular step reference at "${cur}"`);
    seen.add(cur);
    chain.unshift(cur);
    const step = ctx.stepByName.get(cur);
    if (!step) throw new MTranslateError(`unknown step "${cur}"`);
    cur = primaryStepRef(ctx, step);
  }
  return chain;
}

/** The step referenced as the primary table input of `step`, if any. */
function primaryStepRef(ctx: Ctx, step: MStep): string | null {
  const e = step.expr;
  if (e.kind !== 'call') return null;
  const lib = fnLib(e.fn);
  if (lib === 'table' && (fnName(e.fn) === 'combine')) {
    // Combine's tables are all branches; primary = first.
    const list = e.args[0]?.kind === 'list' ? e.args[0].items : null;
    return list ? stepRef(ctx, list[0]) : null;
  }
  if (lib === 'table' && (fnName(e.fn) === 'nestedjoin' || fnName(e.fn) === 'join')) {
    return stepRef(ctx, e.args[0]);
  }
  if (lib === 'table' && fnName(e.fn) === 'fromrecords') return null;
  if (lib === 'csv' || lib === 'json' || lib === 'web' || lib === 'odata' || lib === 'excel' || lib === 'file') return null;
  const p = primaryTable(e);
  if (!p) return null;
  return stepRef(ctx, p);
}

function sourceColumnsOf(source: EtlSource): string[] | null {
  if (source.type === 'csv-text') {
    const first = source.text.split('\n')[0] ?? '';
    if (source.hasHeader === false || source.hasHeader === undefined) {
      // hasHeader defaults true.
    }
    return first.split(',').map((c) => c.trim());
  }
  return null;
}

/** Compile one step's transform ops given the incoming column list. */
function compileStepOps(ctx: Ctx, step: MStep, inputColumns: string[] | null): StepCompile {
  const e = step.expr;
  if (e.kind !== 'call') {
    warn(ctx, 'step-shape', `Step "${step.name}" is not a function call; treated as pass-through.`, step.name);
    return { ops: [], columns: inputColumns, passthrough: true };
  }
  return compileTransform(ctx, step, e, inputColumns);
}

// -- Top-level translation ----------------------------------------------------

export function translateM(src: string, opts: MTranslateOptions = {}): MTranslateResult {
  const query = parseM(src);
  const ctx: Ctx = {
    warnings: [],
    idPrefix: opts.idPrefix ?? 'm',
    owner: opts.owner ?? 'm-translator',
    includeLoad: opts.includeLoad ?? true,
    seq: 0,
    nodeByStep: new Map(),
    stepByName: new Map(query.steps.map((s) => [s.name, s])),
    subRecipeByStep: new Map(),
    subRecipes: [],
    columnsByStep: new Map(),
    sourceStep: null,
  };

  // The final expression selects the chain to compile.
  const finalName = query.final.kind === 'name' ? query.final.name : null;
  if (!finalName || !ctx.stepByName.has(finalName)) {
    throw new MTranslateError('the `in` expression must be a let-step name');
  }
  const chain = linearChain(ctx, finalName);

  const recipeId = `${ctx.idPrefix}-query`;
  const nodes: EtlRecipe['nodes'] = [];
  const edges: EtlRecipe['edges'] = [];
  let prev: string | null = null;
  let columns: string[] | null = null;
  let promoteHeaders = false;

  for (const stepName of chain) {
    const step = ctx.stepByName.get(stepName)!;
    const isSource = stepName === chain[0];
    const nodeId = nid(ctx, 'n');
    if (isSource) {
      const source = compileSource(ctx, step);
      nodes.push({ id: nodeId, kind: 'source', label: stepName, source });
      columns = sourceColumnsOf(source);
      ctx.sourceStep = stepName;
    } else {
      const e = step.expr;
      // Table.PromoteHeaders folds into the csv source's hasHeader.
      if (e.kind === 'call' && fnLib(e.fn) === 'table' && fnName(e.fn) === 'promoteheaders') {
        const srcNode = nodes[0];
        if (srcNode?.kind === 'source' && srcNode.source.type === 'csv-text') {
          srcNode.source.hasHeader = true;
          promoteHeaders = true;
          ctx.nodeByStep.set(stepName, prev!);
          ctx.columnsByStep.set(stepName, columns);
          continue;
        }
      }
      const compiled = compileStepOps(ctx, step, columns);
      if (compiled.ops.length === 0 && compiled.passthrough) {
        ctx.nodeByStep.set(stepName, prev!);
        ctx.columnsByStep.set(stepName, columns);
        continue;
      }
      for (const op of compiled.ops) {
        const tNode: TransformNode = { id: nid(ctx, 'n'), kind: 'transform', label: stepName, transform: op };
        nodes.push(tNode);
        if (prev) edges.push({ from: prev, to: tNode.id });
        prev = tNode.id;
      }
      columns = compiled.columns ?? columns;
      ctx.nodeByStep.set(stepName, prev!);
      ctx.columnsByStep.set(stepName, columns);
      continue;
    }
    if (prev) edges.push({ from: prev, to: nodeId });
    prev = nodeId;
    ctx.nodeByStep.set(stepName, nodeId);
    ctx.columnsByStep.set(stepName, columns);
  }
  void promoteHeaders;

  if (ctx.includeLoad && prev) {
    const loadId = nid(ctx, 'load');
    nodes.push({
      id: loadId,
      kind: 'load',
      label: finalName,
      target: { kind: 'workbook-table', workbookId: '', sheetName: finalName, tableName: finalName },
    });
    edges.push({ from: prev, to: loadId });
  }

  const main: EtlRecipe = {
    version: ETL_RECIPE_VERSION,
    id: recipeId,
    name: `M query: ${finalName}`,
    description: 'Translated from Power Query M by mLanguage.ts.',
    owner: ctx.owner,
    nodes,
    edges,
    schedule: { trigger: 'manual' },
    failurePolicy: defaultFailurePolicy(),
  };
  return { recipes: [main, ...ctx.subRecipes], warnings: ctx.warnings };
}
