/**
 * Future-function (`_xlfn.`) serialization for formulas (audit §9.4).
 *
 * OOXML (ISO/IEC 29500 §18.2.6 + [MS-XLSX] future-function list) stores
 * every function that did not exist in the original Excel 2007 function
 * set prefixed with `_xlfn.` — Excel itself writes e.g.
 * `<f>_xlfn.IFNA(A1,0)</f>`, and strict readers expect that form. Dynamic
 * -array functions are written by current Excel builds as
 * `_xlfn._xlws.FILTER(...)`; LAMBDA parameters travel as
 * `_xlfn._xlpm.<name>`. On IMPORT both this adapter's fast parser
 * (fastSheetParse.ts) and SheetJS strip those prefixes, because the
 * engine works with bare names. The missing half was the WRITE side:
 * formulas were emitted bare. This module is that half.
 *
 * - `prefixFutureFunctions(formula, opts?)` rewrites a bare formula (no
 *   leading '=') for storage: every call to a future function gets
 *   `_xlfn.`, and identifiers bound as LAMBDA parameters get
 *   `_xlfn._xlpm.`. It is a real tokenizer, not a regex over the text:
 *   string literals, quoted sheet names, bracketed structured/external
 *   references, numbers and already-prefixed names are never touched,
 *   and a name is only prefixed when it is actually CALLED (followed by
 *   `(`) — a defined name or sheet name that happens to spell like a
 *   function survives verbatim. Names listed in `opts.definedNames`
 *   (workbook/sheet defined names, e.g. a user LAMBDA called `TEXTJOIN`)
 *   are never prefixed: a call to a defined name is a name reference in
 *   OOXML, not a future function.
 * - `stripFuturePrefixes(formula)` is the import-side inverse: it removes
 *   `_xlfn.`, `_xlfn._xlws.` and `_xlfn._xlpm.` prefixes (used by the
 *   native-feature parsers for CF/DV formulas; the cell-formula paths
 *   strip inline in fastSheetParse / SheetJS).
 *
 * The function set is the [MS-XLSX] future-function list (Excel
 * 2010/2013 additions, as published in Microsoft's future-function
 * documentation and mirrored by WriteXLSX) UNION the post-2013
 * functions (Excel 2016 text/logical additions, the Microsoft 365
 * dynamic-array / LAMBDA / text / array-reshaping families, and the
 * linked-data-type functions). All of them are stored by Excel with an
 * `_xlfn.` prefix (dynamic-array functions additionally carry the
 * `_xlws.` worksheet-scope marker in current builds; the plain
 * `_xlfn.` form written here is the form Excel 2019/early-365 wrote and
 * every conforming reader accepts — see the module test).
 */
import { unzipSync } from 'fflate';
import { zipSyncStable } from './zipStable.js';
import { sheetPartPaths } from './formulaRecovery.js';

/** [MS-XLSX] future functions (Excel 2010/2013) + Excel 2016 additions. */
const MS_FUTURE_FUNCTIONS: readonly string[] = [
  'ACOT', 'ACOTH', 'AGGREGATE', 'ARABIC', 'BASE', 'BETA.DIST', 'BETA.INV',
  'BINOM.DIST', 'BINOM.DIST.RANGE', 'BINOM.INV', 'BITAND', 'BITLSHIFT',
  'BITOR', 'BITRSHIFT', 'BITXOR', 'CEILING.MATH', 'CEILING.PRECISE',
  'CHISQ.DIST', 'CHISQ.DIST.RT', 'CHISQ.INV', 'CHISQ.INV.RT', 'CHISQ.TEST',
  'COMBINA', 'CONFIDENCE.NORM', 'CONFIDENCE.T', 'COT', 'COTH',
  'COVARIANCE.P', 'COVARIANCE.S', 'CSC', 'CSCH', 'DAYS', 'DECIMAL',
  'ERF.PRECISE', 'ERFC.PRECISE', 'EXPON.DIST', 'F.DIST', 'F.DIST.RT',
  'F.INV', 'F.INV.RT', 'F.TEST', 'FILTERXML', 'FLOOR.MATH', 'FLOOR.PRECISE',
  'FORECAST.ETS', 'FORECAST.ETS.CONFINT', 'FORECAST.ETS.SEASONALITY',
  'FORECAST.ETS.STAT', 'FORECAST.LINEAR', 'FORMULATEXT', 'GAMMA',
  'GAMMA.DIST', 'GAMMA.INV', 'GAMMALN.PRECISE', 'GAUSS', 'HYPGEOM.DIST',
  'IFNA', 'IMCOSH', 'IMCOT', 'IMCSC', 'IMCSCH', 'IMSEC', 'IMSECH', 'IMSINH',
  'IMTAN', 'ISFORMULA', 'ISOWEEKNUM', 'LOGNORM.DIST', 'LOGNORM.INV',
  'MODE.MULT', 'MODE.SNGL', 'MUNIT', 'NEGBINOM.DIST', 'NORM.DIST',
  'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'NUMBERVALUE', 'PDURATION',
  'PERCENTILE.EXC', 'PERCENTILE.INC', 'PERCENTRANK.EXC', 'PERCENTRANK.INC',
  'PERMUTATIONA', 'PHI', 'POISSON.DIST', 'QUARTILE.EXC', 'QUARTILE.INC',
  'QUERYSTRING', 'RANK.AVG', 'RANK.EQ', 'RRI', 'SEC', 'SECH', 'SHEET',
  'SHEETS', 'SKEW.P', 'STDEV.P', 'STDEV.S', 'T.DIST', 'T.DIST.2T',
  'T.DIST.RT', 'T.INV', 'T.INV.2T', 'T.TEST', 'UNICHAR', 'UNICODE',
  'VAR.P', 'VAR.S', 'WEBSERVICE', 'WEIBULL.DIST', 'XOR', 'Z.TEST',
  // Excel 2016 (also future functions; stored _xlfn-prefixed).
  'IFS', 'SWITCH', 'TEXTJOIN', 'CONCAT', 'MAXIFS', 'MINIFS',
];

/** Microsoft 365 / Excel 2019+ functions (stored `_xlfn.`-prefixed). */
const M365_FUNCTIONS: readonly string[] = [
  'XLOOKUP', 'XMATCH', 'FILTER', 'SORT', 'SORTBY', 'UNIQUE', 'SEQUENCE',
  'RANDARRAY', 'SINGLE', 'LET', 'LAMBDA', 'MAP', 'REDUCE', 'SCAN', 'BYROW',
  'BYCOL', 'MAKEARRAY', 'ISOMITTED', 'GROUPBY', 'PIVOTBY', 'PERCENTOF',
  'TRIMRANGE', 'TEXTBEFORE', 'TEXTAFTER', 'TEXTSPLIT', 'VSTACK', 'HSTACK',
  'TAKE', 'DROP', 'EXPAND', 'TOCOL', 'TOROW', 'WRAPROWS', 'WRAPCOLS',
  'CHOOSECOLS', 'CHOOSEROWS', 'ARRAYTOTEXT', 'VALUETOTEXT', 'REGEXTEST',
  'REGEXEXTRACT', 'REGEXREPLACE', 'IMAGE', 'FIELDVALUE', 'STOCKHISTORY',
  'TRANSLATE', 'DETECTLANGUAGE',
];

/** Every function name Excel stores with an `_xlfn.` prefix (uppercase). */
export const FUTURE_FUNCTIONS: ReadonlySet<string> = new Set([
  ...MS_FUTURE_FUNCTIONS,
  ...M365_FUNCTIONS,
]);

export interface PrefixOptions {
  /**
   * Defined names in scope (any case). A call whose name matches one of
   * these is a defined-name invocation (e.g. a LAMBDA stored in a name),
   * never a future function, and is left bare.
   */
  definedNames?: ReadonlySet<string> | readonly string[];
}

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

type TokenKind = 'ident' | 'number' | 'string' | 'quoted' | 'bracket' | 'op';

interface Token {
  kind: TokenKind;
  text: string;
  /** Index just past this token in the source. */
  end: number;
}

const IDENT_START = /[A-Za-z_$\\]/;
const IDENT_PART = /[A-Za-z0-9_.$\\]/;

/**
 * Scan one token at `i`. Identifiers may contain unicode letters (defined
 * names do); digits/`$`/`.` are identifier PARTS so `STDEV.S`, `$A$1`
 * and `A1` each scan as one token.
 */
function scanToken(s: string, i: number): Token {
  const ch = s[i] as string;
  if (ch === '"') {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '"') {
        if (s[j + 1] === '"') { j += 2; continue; }
        j++;
        break;
      }
      j++;
    }
    return { kind: 'string', text: s.slice(i, j), end: j };
  }
  if (ch === "'") {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === "'") {
        if (s[j + 1] === "'") { j += 2; continue; }
        j++;
        break;
      }
      j++;
    }
    return { kind: 'quoted', text: s.slice(i, j), end: j };
  }
  if (ch === '[') {
    // Structured reference / external-book bracket: contents are column
    // names and book names, never function calls. Brackets nest one level
    // (Table1[[#All],[Col]]) and ']' can be escaped as ']]' — scan with a
    // depth counter, treating ']]' as an escaped literal.
    let j = i + 1;
    let depth = 1;
    while (j < s.length && depth > 0) {
      if (s[j] === '[') depth++;
      else if (s[j] === ']') {
        if (s[j + 1] === ']' && depth === 1) { j += 2; continue; }
        depth--;
      }
      j++;
    }
    return { kind: 'bracket', text: s.slice(i, j), end: j };
  }
  if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
    let j = i;
    while (j < s.length && /[0-9.]/.test(s[j] as string)) j++;
    if (s[j] === 'E' || s[j] === 'e') {
      let k = j + 1;
      if (s[k] === '+' || s[k] === '-') k++;
      if (/[0-9]/.test(s[k] ?? '')) {
        while (k < s.length && /[0-9]/.test(s[k] as string)) k++;
        j = k;
      }
    }
    return { kind: 'number', text: s.slice(i, j), end: j };
  }
  if (IDENT_START.test(ch) || ch.charCodeAt(0) > 127) {
    let j = i + 1;
    while (j < s.length) {
      const c = s[j] as string;
      if (IDENT_PART.test(c) || c.charCodeAt(0) > 127) j++;
      else break;
    }
    // A trailing '.' is punctuation (e.g. member access `x.` spill or a
    // sentence dot), not part of the name — dotted function names
    // (STDEV.S) keep their INTERNAL dots only.
    let text = s.slice(i, j);
    while (text.endsWith('.') && text.length > 1) {
      text = text.slice(0, -1);
      j--;
    }
    return { kind: 'ident', text, end: j };
  }
  return { kind: 'op', text: ch, end: i + 1 };
}

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const t = scanToken(s, i);
    out.push(t);
    i = t.end;
  }
  return out;
}

/** Index of the next non-whitespace token after `i`, or -1. */
function nextMeaningful(tokens: Token[], i: number): number {
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j] as Token;
    if (t.kind === 'op' && (t.text === ' ' || t.text === '\t')) continue;
    return j;
  }
  return -1;
}

/** Index of the token matching the '(' at token index `open`, or -1. */
function matchingParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind === 'op' && t.text === '(') depth++;
    else if (t.kind === 'op' && t.text === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a token range at top-level commas; returns token-index ranges. */
function splitArgs(tokens: Token[], from: number, to: number): Array<[number, number]> {
  const args: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const t = tokens[i] as Token;
    if (t.kind !== 'op') continue;
    if (t.text === '(' || t.text === '[') depth++;
    else if (t.text === ')' || t.text === ']') depth--;
    else if (t.text === ',' && depth === 0) {
      args.push([start, i]);
      start = i + 1;
    }
  }
  args.push([start, to]);
  return args;
}

/**
 * Collect every LAMBDA parameter name in the formula (any nesting level;
 * Excel's `_xlpm` storage prefixes every occurrence of a parameter,
 * declaration and use alike — shadowing is resolved by Excel the same
 * way, by name).
 */
function collectLambdaParams(tokens: Token[]): Set<string> {
  const params = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind !== 'ident' || t.text.toUpperCase() !== 'LAMBDA') continue;
    const open = nextMeaningful(tokens, i);
    if (open < 0 || !(tokens[open]?.kind === 'op' && tokens[open]?.text === '(')) continue;
    const close = matchingParen(tokens, open);
    if (close < 0) continue;
    const args = splitArgs(tokens, open + 1, close);
    // All arguments except the last (the body) are parameter names;
    // an optional parameter is stored as [name] in newer Excel — the
    // bracket scans as one 'bracket' token here; accept a plain ident
    // or a bracketed ident.
    for (const [a, b] of args.slice(0, -1)) {
      const meaningful = tokens.slice(a, b).filter((x) => !(x.kind === 'op' && x.text === ' '));
      if (meaningful.length !== 1) continue;
      const only = meaningful[0] as Token;
      if (only.kind === 'ident') params.add(only.text.toUpperCase());
      else if (only.kind === 'bracket') {
        const inner = only.text.slice(1, -1).trim();
        if (/^[A-Za-z_$][A-Za-z0-9_.$]*$/.test(inner)) params.add(inner.toUpperCase());
      }
    }
  }
  return params;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Rewrite a bare formula (WITHOUT a leading '=') into its OOXML storage
 * form: future-function calls gain `_xlfn.`, LAMBDA parameters gain
 * `_xlfn._xlpm.`. Already-prefixed names, string literals, quoted sheet
 * names, bracketed references, defined-name calls and plain cell/sheet
 * references pass through byte-for-byte. Function-name matching is
 * case-insensitive; the name's original casing is preserved after the
 * prefix (Excel writes uppercase, but a lowercase `_xlfn.ifna(` is the
 * same storage token).
 */
export function prefixFutureFunctions(formula: string, opts: PrefixOptions = {}): string {
  if (!formula.includes('(') && !/lambda/i.test(formula)) return formula;
  const defined = new Set<string>();
  for (const n of opts.definedNames ?? []) defined.add(n.toUpperCase());
  const tokens = tokenize(formula);
  const lambdaParams = collectLambdaParams(tokens);
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind !== 'ident') {
      out += t.text;
      continue;
    }
    const upper = t.text.toUpperCase();
    // Already-prefixed chains: `_xlfn.X`, `_xlfn._xlws.X`, `_xlpm`… the
    // scanner yields `_xlfn` as an ident followed by '.' handling — our
    // ident scanner swallows internal dots, so `_xlfn.IFNA` arrives as
    // ONE token whose upper-case starts with a known prefix. Leave any
    // token that already carries a storage prefix untouched.
    if (
      upper.startsWith('_XLFN.') || upper.startsWith('_XLWS.') ||
      upper.startsWith('_XLPM.') || upper === '_XLFN' || upper === '_XLWS' ||
      upper.startsWith('_XLL.') || upper.startsWith('ECMA.') || upper.startsWith('ISO.')
    ) {
      out += t.text;
      continue;
    }
    const nextIdx = nextMeaningful(tokens, i);
    const next = nextIdx >= 0 ? tokens[nextIdx] : undefined;
    const isCall = next?.kind === 'op' && next.text === '(';
    // Member of a dotted chain (preceded by '.'): the head token decided.
    const prevText = out.endsWith('.') ? '.' : '';
    if (prevText === '.') {
      out += t.text;
      continue;
    }
    if (isCall && FUTURE_FUNCTIONS.has(upper) && !defined.has(upper)) {
      out += `_xlfn.${t.text}`;
      continue;
    }
    if (!isCall && lambdaParams.has(upper)) {
      out += `_xlfn._xlpm.${t.text}`;
      continue;
    }
    out += t.text;
  }
  return out;
}

/**
 * Import-side inverse of {@link prefixFutureFunctions}: strip `_xlfn.`,
 * `_xlfn._xlws.` and `_xlfn._xlpm.` storage prefixes, yielding the bare
 * formula the engine works with. (Cell formulas are stripped inline by
 * fastSheetParse/SheetJS; this helper serves the native-feature parsers
 * and defined-name handling.)
 */
export function stripFuturePrefixes(formula: string): string {
  return formula.replace(/_xlfn\.(?:_xlws\.|_xlpm\.)?/gi, '').replace(/_xlws\./gi, '');
}

/**
 * Apply {@link prefixFutureFunctions} to every `<f>…</f>` element body
 * in a worksheet XML string (the classic adapter's post-SheetJS pass).
 * Formula text is XML-escaped in the part; the rewrite decodes entities,
 * prefixes, and re-escapes, so a formula containing `<`/`&` survives.
 * `<f>` elements with attributes (shared/array) keep their attributes.
 */
export function prefixFormulasInSheetXml(xml: string, opts: PrefixOptions = {}): string {
  return xml.replace(/<f\b([^>]*)>([\s\S]*?)<\/f>/g, (whole, attrs: string, body: string) => {
    if (body === '') return whole;
    const decoded = body
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    const prefixed = prefixFutureFunctions(decoded, opts);
    if (prefixed === decoded) return whole;
    const encoded = prefixed
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<f${attrs}>${encoded}</f>`;
  });
}

/**
 * Package-level pass (classic adapter write): rewrite every worksheet
 * part's `<f>` bodies and xl/workbook.xml's `<definedName>` bodies into
 * storage form. Returns the input bytes unchanged when nothing needed
 * prefixing. Never throws — a formula-prefix hint must not break a save.
 */
export function prefixFutureFunctionsInPackage(
  packageBytes: Uint8Array,
  definedNames: readonly string[] = [],
): Uint8Array {
  try {
    const files = unzipSync(packageBytes.slice());
    const parts = sheetPartPaths(files as unknown as Record<string, Uint8Array>);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const opts: PrefixOptions = { definedNames };
    let touched = false;
    for (const path of parts.values()) {
      const raw = files[path];
      if (!raw) continue;
      const xml = decoder.decode(raw);
      if (!xml.includes('<f')) continue;
      const out = prefixFormulasInSheetXml(xml, opts);
      if (out !== xml) {
        files[path] = encoder.encode(out);
        touched = true;
      }
    }
    const wbRaw = files['xl/workbook.xml'];
    if (wbRaw) {
      const xml = decoder.decode(wbRaw);
      if (xml.includes('<definedName')) {
        const out = prefixFormulasInWorkbookXml(xml, opts);
        if (out !== xml) {
          files['xl/workbook.xml'] = encoder.encode(out);
          touched = true;
        }
      }
    }
    return touched ? zipSyncStable(files) : packageBytes;
  } catch {
    return packageBytes;
  }
}

/**
 * Apply {@link prefixFutureFunctions} to every `<definedName>` body in a
 * workbook.xml string. Range/constant refs contain no function calls and
 * pass through unchanged; LAMBDA definitions get both the `_xlfn.LAMBDA`
 * head and `_xlfn._xlpm.` parameters Excel writes.
 */
export function prefixFormulasInWorkbookXml(xml: string, opts: PrefixOptions = {}): string {
  const names = new Set<string>(opts.definedNames ?? []);
  // The defined names themselves are in scope inside every definition.
  for (const m of xml.matchAll(/<definedName\b[^>]*\bname\s*=\s*"([^"]*)"/g)) {
    names.add((m[1] as string).toUpperCase());
  }
  return xml.replace(
    /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g,
    (whole, attrs: string, body: string) => {
      const decoded = body
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
      const prefixed = prefixFutureFunctions(decoded, { definedNames: names });
      if (prefixed === decoded) return whole;
      const encoded = prefixed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<definedName${attrs}>${encoded}</definedName>`;
    },
  );
}
