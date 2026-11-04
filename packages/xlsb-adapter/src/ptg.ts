/**
 * Formula Ptg (parse token) compiler/decompiler for .xlsb.
 *
 * BIFF12 stores formulas as token streams (the same Ptg set as BIFF8):
 * operands are pushed, operators pop their operands and push results
 * (RPN). This module compiles a useful subset of A1-style formula text
 * to tokens and decompiles tokens back to text.
 *
 * Supported: numeric/string/boolean/error constants, same-sheet cell and
 * area references (absolute or relative — absoluteness is not preserved,
 * see below), arithmetic (+ - * / ^), comparisons, & concatenation,
 * unary minus, % postfix, parentheses, and function calls for the FTAB
 * subset below (emitted as PtgFuncVar).
 *
 * Honest limitations (also in README.md):
 * - Cross-sheet references (Sheet2!A1), 3D references, defined names,
 *   structured references, and array constants are NOT supported: the
 *   writer throws XlsbFormulaError naming the construct instead of
 *   silently dropping it.
 * - $ absoluteness is not preserved (refs are stored relative-form); the
 *   decompiler emits plain A1 addresses. Values and layout round-trip;
 *   $ markers do not.
 * - Functions outside FTAB (e.g. XLOOKUP, which Excel stores via _xlfn
 *   name records) throw on write.
 */

import { Writer, Reader, errorCode, errorText } from './biff12.js';

export class XlsbFormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsbFormulaError';
  }
}

// -- Ptg token ids --------------------------------------------------------------

const P = {
  Add: 0x03, Sub: 0x04, Mul: 0x05, Div: 0x06, Power: 0x07, Concat: 0x08,
  Lt: 0x09, Le: 0x0a, Eq: 0x0b, Ge: 0x0c, Gt: 0x0d, Ne: 0x0e,
  Uminus: 0x13, Percent: 0x14, Paren: 0x15, MissArg: 0x16,
  Str: 0x17, Err: 0x1c, Bool: 0x1d, Int: 0x1e, Num: 0x1f,
  FuncVar: 0x22, Ref: 0x24, Area: 0x25, Ref3d: 0x3a, Area3d: 0x3b,
} as const;

// -- Function table (Ftab index -> name; subset of MS-XLS Ftab) ------------------

/** name (upper) -> ftab index. */
export const FTAB: Record<string, number> = {
  COUNT: 0, IF: 1, ISNA: 2, ISERROR: 3, SUM: 4, AVERAGE: 5, MIN: 6, MAX: 7,
  ROW: 8, COLUMN: 9, NA: 10, NPV: 11, STDEV: 12, DOLLAR: 13, FIXED: 14,
  SIN: 15, COS: 16, TAN: 17, ATAN: 18, PI: 19, SQRT: 20, EXP: 21, LN: 22,
  LOG10: 23, ABS: 24, INT: 25, SIGN: 26, ROUND: 27, LOOKUP: 28, INDEX: 29,
  REPT: 30, MID: 31, LEN: 32, VALUE: 33, TRUE: 34, FALSE: 35, AND: 36,
  OR: 37, NOT: 38, MOD: 39, DCOUNT: 40, DSUM: 41, DAVERAGE: 42, DMIN: 43,
  DMAX: 44, DSTDEV: 45, VAR: 46, DVAR: 47, TEXT: 48, LINEST: 49, TREND: 50,
  LOGEST: 51, GROWTH: 52, PV: 56, FV: 57, NPER: 58, PMT: 59, RATE: 60,
  MIRR: 61, IRR: 62, RAND: 63, MATCH: 64, DATE: 65, TIME: 66, DAY: 67,
  MONTH: 68, YEAR: 69, WEEKDAY: 70, HOUR: 71, MINUTE: 72, SECOND: 73,
  NOW: 74, AREAS: 75, ROWS: 76, COLUMNS: 77, OFFSET: 78, TYPE: 86,
  ATAN2: 97, ASIN: 98, ACOS: 99, CHOOSE: 100, HLOOKUP: 101, VLOOKUP: 102,
  LOG: 109, CHAR: 111, LOWER: 112, UPPER: 113, PROPER: 114, LEFT: 115,
  RIGHT: 116, EXACT: 117, TRIM: 118, REPLACE: 119, SUBSTITUTE: 120,
  CODE: 121, FIND: 124, CELL: 125, ISERR: 126, ISTEXT: 127, ISNUMBER: 128,
  ISBLANK: 129, T: 130, N: 131, DATEVALUE: 140, TIMEVALUE: 141, SLN: 142,
  SYD: 143, DDB: 144, INDIRECT: 148, CLEAN: 161, MDETERM: 162,
  MINVERSE: 163, MMULT: 164, IPMT: 166, PPMT: 167, COUNTA: 168,
  PRODUCT: 183, FACT: 184, DPRODUCT: 185, ISNONTEXT: 186, STDEVP: 187,
  VARP: 188, DSTDEVP: 189, DVARP: 190, TRUNC: 191, ISLOGICAL: 192,
  DCOUNTA: 193, ROUNDUP: 194, ROUNDDOWN: 195, RANK: 196, ADDRESS: 197,
  DAYS360: 198, TODAY: 199, VDB: 200, MEDIAN: 201, SUMPRODUCT: 202,
  SINH: 203, COSH: 204, TANH: 205, ASINH: 206, ACOSH: 207, ATANH: 208,
  DGET: 209, INFO: 210, DB: 211, FREQUENCY: 212, AVEDEV: 213,
  BETADIST: 214, GAMMALN: 215, BETAINV: 216, BINOMDIST: 217, CHIDIST: 218,
  CHIINV: 219, COMBIN: 220, CONFIDENCE: 221, CRITBINOM: 222, EVEN: 223,
  EXPONDIST: 224, FDIST: 225, FINV: 226, FISHER: 227, FISHERINV: 228,
  FLOOR: 229, GAMMADIST: 230, GAMMAINV: 231, CEILING: 232, HYPGEOMDIST: 233,
  LOGNORMDIST: 234, LOGINV: 235, NEGBINOMDIST: 236, NORMDIST: 237,
  NORMSDIST: 238, NORMINV: 239, NORMSINV: 240, STANDARDIZE: 241, ODD: 242,
  PERMUT: 243, POISSON: 244, TDIST: 245, WEIBULL: 246, SUMXMY2: 247,
  SUMX2MY2: 248, SUMX2PY2: 249, CHITEST: 250, CORREL: 251, COVAR: 252,
  FORECAST: 253, FTEST: 254, INTERCEPT: 255, PEARSON: 256, RSQ: 257,
  STEYX: 258, SLOPE: 259, TTEST: 260, PROB: 261, DEVSQ: 262, GEOMEAN: 263,
  HARMEAN: 264, SUMSQ: 265, KURT: 266, SKEW: 267, ZTEST: 268, LARGE: 269,
  SMALL: 270, QUARTILE: 271, PERCENTILE: 272, PERCENTRANK: 273, MODE: 274,
  TRIMMEAN: 275, TINV: 276, CONCATENATE: 277, POWER: 278, RADIANS: 279,
  DEGREES: 280, SUBTOTAL: 281, SUMIF: 282, COUNTIF: 283, COUNTBLANK: 284,
  ROMAN: 285, ISPMT: 286,
};

const FTAB_BY_INDEX: Record<number, string> = {};
for (const [name, idx] of Object.entries(FTAB)) FTAB_BY_INDEX[idx] = name;

// -- A1 helpers ------------------------------------------------------------------

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToCol(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Parse an A1 cell ref (optionally $-prefixed). Returns null when not a ref. */
function parseCellRef(text: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(text);
  if (!m) return null;
  const col = colToIndex(m[1]);
  const row = parseInt(m[2], 10) - 1;
  if (col > 16383 || row > 1048575) return null;
  return { row, col };
}

// -- Formula text tokenizer -------------------------------------------------------

type FToken =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'err'; value: string }
  | { kind: 'ref'; row: number; col: number }
  | { kind: 'area'; r1: number; c1: number; r2: number; c2: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' } | { kind: 'rparen' } | { kind: 'comma' };

const ERRORS = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA'];

function tokenizeFormula(src: string): FToken[] {
  const toks: FToken[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= n) throw new XlsbFormulaError('unterminated string in formula');
        if (src[i] === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
          break; // closing quote
        }
        s += src[i++];
      }
      i++; // closing quote
      toks.push({ kind: 'str', value: s });
      continue;
    }
    if (c === '#') {
      const m = /^(#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA))/.exec(src.slice(i));
      if (!m) throw new XlsbFormulaError(`bad error literal in formula at offset ${i}`);
      toks.push({ kind: 'err', value: m[1] });
      i += m[1].length;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|^\.[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new XlsbFormulaError(`bad number in formula at offset ${i}`);
      toks.push({ kind: 'num', value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      // Function names that look like cell refs (LOG10) must win over refs.
      const mWord = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
      const wordUpper = mWord ? mWord[0].toUpperCase() : '';
      const m = /^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}(?![A-Za-z0-9_])/i.exec(src.slice(i));
      // Check for range: ref:ref
      if (m && !(wordUpper in FTAB)) {
        const after = src.slice(i + m[0].length);
        const m2 = /^:(\$?[A-Za-z]{1,3}\$?[0-9]{1,7})(?![A-Za-z0-9_])/.exec(after);
        if (m2) {
          const a = parseCellRef(m[0])!;
          const b = parseCellRef(m2[1])!;
          toks.push({
            kind: 'area',
            r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col),
            r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col),
          });
          i += m[0].length + m2[0].length;
          continue;
        }
        // A ref-looking word followed by '(' is a function call, not a ref.
        const rest = src.slice(i + m[0].length).trimStart();
        if (rest[0] !== '(') {
          const r = parseCellRef(m[0])!;
          toks.push({ kind: 'ref', row: r.row, col: r.col });
          i += m[0].length;
          continue;
        }
      }
      const mName = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
      if (!mName) throw new XlsbFormulaError(`bad token in formula at offset ${i}`);
      const word = mName[0].toUpperCase();
      // Sheet-qualified ref (Sheet1!A1) — not supported.
      if (src[i + mName[0].length] === '!') {
        throw new XlsbFormulaError(`cross-sheet references are not supported in .xlsb formulas ("${mName[0]}!...")`);
      }
      const afterWord = src.slice(i + mName[0].length).trimStart();
      if ((word === 'TRUE' || word === 'FALSE') && afterWord[0] !== '(') {
        toks.push({ kind: 'bool', value: word === 'TRUE' });
      } else {
        toks.push({ kind: 'name', value: word });
      }
      i += mName[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') { toks.push({ kind: 'op', value: two }); i += 2; continue; }
    if ('+-*/^&=<>%(),'.includes(c)) {
      if (c === '(') toks.push({ kind: 'lparen' });
      else if (c === ')') toks.push({ kind: 'rparen' });
      else if (c === ',') toks.push({ kind: 'comma' });
      else toks.push({ kind: 'op', value: c });
      i++;
      continue;
    }
    throw new XlsbFormulaError(`unexpected character "${c}" in formula`);
  }
  return toks;
}

// -- Shunting-yard to RPN ------------------------------------------------------------

type Rpn =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'err'; value: string }
  | { kind: 'ref'; row: number; col: number }
  | { kind: 'area'; r1: number; c1: number; r2: number; c2: number }
  | { kind: 'op'; value: string; unary?: boolean }
  | { kind: 'call'; name: string; argc: number }
  | { kind: 'missarg' };

const PRECEDENCE: Record<string, number> = {
  '=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1,
  '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5, 'u-': 6, '%': 7,
};

function toRpn(toks: FToken[]): Rpn[] {
  const out: Rpn[] = [];
  interface Frame { commas: number; hasArg: boolean; callName: string | null; }
  const stack: (FToken | { kind: 'uop'; value: string })[] = [];
  const frames: Frame[] = [];
  let prevIsOperand = false;
  let i = 0;

  const markArg = (): void => {
    if (frames.length > 0) frames[frames.length - 1].hasArg = true;
  };

  /** Pop one operator, normalizing unary markers to plain op nodes. */
  const popOp = (): Rpn => {
    const top = stack.pop() as { kind: string; value?: string };
    if (top.kind === 'uop') return { kind: 'op', value: 'u-' };
    return top as Rpn;
  };

  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === 'num' || t.kind === 'str' || t.kind === 'bool' || t.kind === 'err' ||
      t.kind === 'ref' || t.kind === 'area') {
      out.push(t as Rpn);
      markArg();
      prevIsOperand = true;
    } else if (t.kind === 'name') {
      // Function call only; bare names are unsupported (would be PtgName).
      const next = toks[i + 1];
      if (!next || next.kind !== 'lparen') {
        throw new XlsbFormulaError(`unsupported name "${t.value}" in formula (defined names are not supported in .xlsb)`);
      }
      // Consume the '(' with the call: one marker + one frame per call.
      stack.push({ kind: 'callmarker', name: t.value } as unknown as FToken);
      frames.push({ commas: 0, hasArg: false, callName: t.value });
      prevIsOperand = false;
      i += 2;
      continue;
    } else if (t.kind === 'lparen') {
      stack.push(t);
      frames.push({ commas: 0, hasArg: false, callName: null });
      prevIsOperand = false;
    } else if (t.kind === 'comma') {
      const frame = frames[frames.length - 1];
      if (!frame) throw new XlsbFormulaError('comma outside function call in formula');
      if (!frame.hasArg) {
        out.push({ kind: 'missarg' }); // omitted argument before the comma
        frame.hasArg = true;
      }
      frame.commas++;
      frame.hasArg = false;
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.kind === 'lparen' || (top as { kind: string }).kind === 'callmarker') break;
        out.push(popOp());
      }
      prevIsOperand = false;
    } else if (t.kind === 'rparen') {
      const frame = frames.pop();
      if (!frame) throw new XlsbFormulaError('mismatched parentheses in formula');
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.kind === 'lparen' || (top as { kind: string }).kind === 'callmarker') break;
        out.push(popOp());
      }
      const marker = stack.pop();
      const isCallMarker = (marker as { kind: string } | undefined)?.kind === 'callmarker';
      if (frame.callName !== null && isCallMarker) {
        const argc = frame.commas + (frame.hasArg ? 1 : 0);
        out.push({ kind: 'call', name: frame.callName, argc });
        markArg(); // the call result is an operand of the enclosing frame
      } else if (frame.callName === null && marker?.kind === 'lparen') {
        out.push({ kind: 'op', value: 'paren' });
        markArg();
      } else {
        throw new XlsbFormulaError('mismatched parentheses in formula');
      }
      prevIsOperand = true;
    } else if (t.kind === 'op') {
      const opVal = t.value;
      if ((opVal === '-' || opVal === '+') && !prevIsOperand) {
        if (opVal === '-') stack.push({ kind: 'uop', value: 'u-' });
        // unary plus: no-op
        prevIsOperand = false;
        i++;
        continue;
      }
      if (opVal === '%') {
        // Postfix percent binds to the preceding operand immediately.
        out.push({ kind: 'op', value: '%' });
        prevIsOperand = true; // `50%-2` parses the minus as binary
        i++;
        continue;
      }
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const topPrec = top.kind === 'op' ? PRECEDENCE[top.value] ?? 0
          : (top as { kind: string }).kind === 'uop' ? PRECEDENCE['u-']! : -1;
        const curPrec = PRECEDENCE[opVal] ?? 0;
        if (topPrec >= curPrec && curPrec < 5) { // ^ is right-associative
          out.push(popOp());
        } else break;
      }
      stack.push(t);
      prevIsOperand = false;
    }
    i++;
  }
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.kind === 'lparen' || (top as { kind: string }).kind === 'callmarker') {
      throw new XlsbFormulaError('mismatched parentheses in formula');
    }
    out.push(popOp());
  }
  if (frames.length > 0) throw new XlsbFormulaError('mismatched parentheses in formula');
  return out;
}

// -- Compile RPN to Ptg bytes -------------------------------------------------------------

function emitOperand(w: Writer, r: Rpn): void {
  switch (r.kind) {
    case 'num': {
      if (Number.isInteger(r.value) && r.value >= 0 && r.value <= 65535) {
        w.u8(P.Int).u16(r.value);
      } else {
        w.u8(P.Num).f64(r.value);
      }
      return;
    }
    case 'str': {
      w.u8(P.Str);
      const utf16 = new Uint8Array(r.value.length * 2);
      for (let i = 0; i < r.value.length; i++) {
        utf16[i * 2] = r.value.charCodeAt(i) & 0xff;
        utf16[i * 2 + 1] = (r.value.charCodeAt(i) >>> 8) & 0xff;
      }
      w.u16(r.value.length).bytes(utf16);
      return;
    }
    case 'bool': w.u8(P.Bool).u8(r.value ? 1 : 0); return;
    case 'err': w.u8(P.Err).u8(errorCode(r.value)); return;
    case 'ref': w.u8(P.Ref).u32(r.row).u32(r.col); return;
    case 'area': w.u8(P.Area).u32(r.r1).u32(r.r2).u32(r.c1).u32(r.c2); return;
    case 'missarg': w.u8(P.MissArg); return;
    default: throw new XlsbFormulaError(`cannot emit ${(r as Rpn).kind} as operand`);
  }
}

const OP_PTG: Record<string, number> = {
  '+': P.Add, '-': P.Sub, '*': P.Mul, '/': P.Div, '^': P.Power, '&': P.Concat,
  '<': P.Lt, '<=': P.Le, '=': P.Eq, '>=': P.Ge, '>': P.Gt, '<>': P.Ne,
  'u-': P.Uminus, '%': P.Percent, paren: P.Paren,
};

/**
 * Compile formula text (without the leading '=') to a Ptg token stream.
 * Throws XlsbFormulaError for unsupported constructs.
 */
export function compileFormula(src: string): Uint8Array {
  const text = src.startsWith('=') ? src.slice(1) : src;
  if (text.trim() === '') throw new XlsbFormulaError('empty formula');
  const rpn = toRpn(tokenizeFormula(text));
  const w = new Writer();
  for (const r of rpn) {
    if (r.kind === 'op') {
      const ptg = OP_PTG[r.value];
      if (ptg === undefined) throw new XlsbFormulaError(`unsupported operator "${r.value}"`);
      w.u8(ptg);
    } else if (r.kind === 'call') {
      const idx = FTAB[r.name];
      if (idx === undefined) {
        throw new XlsbFormulaError(`function ${r.name} is not supported in .xlsb formulas`);
      }
      w.u8(P.FuncVar).u8(r.argc).u16(idx);
    } else {
      emitOperand(w, r);
    }
  }
  return w.build();
}

// -- Decompile Ptg bytes to formula text ---------------------------------------------------

interface PtgNode { text: string; prec: number; }

function needsParen(child: PtgNode, parentPrec: number): boolean {
  return child.prec < parentPrec;
}

function binOp(op: string, prec: number, stack: PtgNode[]): void {
  const b = stack.pop();
  const a = stack.pop();
  if (!a || !b) throw new Error('xlsb: malformed formula tokens');
  const l = needsParen(a, prec) ? `(${a.text})` : a.text;
  const r = needsParen(b, prec) ? `(${b.text})` : b.text;
  stack.push({ text: `${l}${op}${r}`, prec });
}

/** Decompile a Ptg token stream to formula text (without leading '='). */
export function decompileFormula(tokens: Uint8Array): string {
  const r = new Reader(tokens);
  const stack: PtgNode[] = [];
  while (r.remaining > 0) {
    const ptg = r.u8();
    switch (ptg) {
      case P.Num: stack.push({ text: numToText(r.f64()), prec: 8 }); break;
      case P.Int: stack.push({ text: String(r.u16()), prec: 8 }); break;
      case P.Str: {
        const cch = r.u16();
        const bytes = new Uint8Array(cch * 2);
        for (let i = 0; i < cch * 2; i++) bytes[i] = r.u8();
        const s = new TextDecoder('utf-16le').decode(bytes);
        stack.push({ text: `"${s.replace(/"/g, '""')}"`, prec: 8 });
        break;
      }
      case P.Bool: stack.push({ text: r.u8() ? 'TRUE' : 'FALSE', prec: 8 }); break;
      case P.Err: stack.push({ text: errorText(r.u8()), prec: 8 }); break;
      case P.Ref: {
        const row = r.u32();
        const col = r.u32();
        stack.push({ text: `${indexToCol(col)}${row + 1}`, prec: 8 });
        break;
      }
      case P.Area: {
        const r1 = r.u32(); const r2 = r.u32(); const c1 = r.u32(); const c2 = r.u32();
        stack.push({ text: `${indexToCol(c1)}${r1 + 1}:${indexToCol(c2)}${r2 + 1}`, prec: 8 });
        break;
      }
      case P.Add: binOp('+', 3, stack); break;
      case P.Sub: binOp('-', 3, stack); break;
      case P.Mul: binOp('*', 4, stack); break;
      case P.Div: binOp('/', 4, stack); break;
      case P.Power: binOp('^', 5, stack); break;
      case P.Concat: binOp('&', 2, stack); break;
      case P.Lt: binOp('<', 1, stack); break;
      case P.Le: binOp('<=', 1, stack); break;
      case P.Eq: binOp('=', 1, stack); break;
      case P.Ge: binOp('>=', 1, stack); break;
      case P.Gt: binOp('>', 1, stack); break;
      case P.Ne: binOp('<>', 1, stack); break;
      case P.Uminus: {
        const a = stack.pop();
        if (!a) throw new Error('xlsb: malformed formula tokens');
        stack.push({ text: `-${needsParen(a, 6) ? `(${a.text})` : a.text}`, prec: 6 });
        break;
      }
      case P.Percent: {
        const a = stack.pop();
        if (!a) throw new Error('xlsb: malformed formula tokens');
        stack.push({ text: `${needsParen(a, 7) ? `(${a.text})` : a.text}%`, prec: 7 });
        break;
      }
      case P.Paren: {
        const a = stack.pop();
        if (!a) throw new Error('xlsb: malformed formula tokens');
        stack.push({ text: `(${a.text})`, prec: 8 });
        break;
      }
      case P.MissArg: stack.push({ text: '', prec: 8 }); break;
      case P.FuncVar: {
        const argc = r.u8();
        const idx = r.u16();
        const name = FTAB_BY_INDEX[idx];
        if (!name) throw new Error(`xlsb: unknown function index ${idx} in formula`);
        const args: string[] = [];
        for (let i = 0; i < argc; i++) {
          const a = stack.pop();
          if (!a) throw new Error('xlsb: malformed formula tokens');
          args.unshift(a.text);
        }
        stack.push({ text: `${name}(${args.join(',')})`, prec: 8 });
        break;
      }
      case P.Ref3d:
      case P.Area3d:
        throw new Error('xlsb: cross-sheet references in .xlsb formulas are not supported by this adapter');
      default:
        throw new Error(`xlsb: unsupported formula token 0x${ptg.toString(16)}`);
    }
  }
  if (stack.length !== 1) throw new Error('xlsb: malformed formula tokens (stack not singular)');
  return stack[0].text;
}

function numToText(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  return String(v);
}

export { ERRORS };
