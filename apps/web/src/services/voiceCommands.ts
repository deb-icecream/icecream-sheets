/**
 * Voice-tolerant command palette — matcher, grammar, and command catalog.
 *
 * The palette treats mangled dictated text as a normal input mode: raw
 * text (typed or dictated) is normalized, fuzzy-matched against the
 * engine's function catalog (ALL_FUNCTIONS — exactly the functions the
 * engine can evaluate) plus a small set of sheet commands, and resolved
 * to AT MOST one concrete command. Nothing here executes anything: a
 * resolution only DESCRIBES the single MCP tool call that would run.
 * The palette UI shows the resolution and executes it through the
 * product's MCP tool layer (McpCallFn) only after the user confirms.
 *
 * Every offered command maps to exactly one real MCP tool call:
 *   insert formula → set_formulas   (packages/mcp-server)
 *   write value    → write_cells
 *   read cells     → read_cells
 *   recalculate    → recalculate
 * Commands with no MCP execution path are never offered (no stubs).
 */

import { ALL_FUNCTIONS, type FunctionInfo } from '../features/functions';

/** The active cell a formula/value command applies to. */
export interface VoiceTarget {
  sheet: string;
  row: number; // 0-based
  col: number; // 0-based
}

/** One MCP tool call, as executed through McpCallFn. */
export interface VoiceToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export type VoiceCommandKind = 'formula' | 'write' | 'read' | 'recalculate';

export interface VoiceAlternate {
  /** Canonical function name the alternate would use. */
  name: string;
  score: number;
}

export interface VoiceResolution {
  kind: VoiceCommandKind;
  /** Canonical display name, e.g. 'SUMIF', 'Write value', 'Read cells'. */
  name: string;
  /** Match confidence 0..1 (name-match quality, not parse quality). */
  score: number;
  /** Human preview of what will happen and where. */
  actionLabel: string;
  /** Formula text for kind 'formula' (editable in the UI before confirming). */
  formula?: string;
  /** True when the parse fully specified the command. */
  executable: boolean;
  /** When not executable, what is missing (shown to the user). */
  missing?: string;
  /** The MCP call for non-formula kinds, and for complete formula parses. */
  call: VoiceToolCall | null;
  /** Close alternative function matches (formula kind only). */
  alternates: VoiceAlternate[];
}

export interface VoiceResolveOptions {
  /** Principal stamped on tool calls (the agent's web principal). */
  principal?: string;
  /** Force this function name (the user picked an alternate). */
  forceFunction?: string;
}

const DEFAULT_PRINCIPAL = 'web-user';

// ---------------------------------------------------------------------------
// A1 helpers
// ---------------------------------------------------------------------------

export function colToLetters(col: number): string {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function toA1(row: number, col: number): string {
  return `${colToLetters(col)}${row + 1}`;
}

const REF_RE = /^([A-Za-z]{1,3})(\d{1,7})$/;

export function parseA1(text: string): { row: number; col: number } | null {
  const m = REF_RE.exec(text.trim());
  if (!m) return null;
  const row = Number(m[2]) - 1;
  if (row < 0) return null;
  return { row, col: lettersToCol(m[1]) };
}

function rangeLabel(sheet: string, a: { row: number; col: number }, b?: { row: number; col: number }): string {
  return b ? `${sheet}!${toA1(a.row, a.col)}:${toA1(b.row, b.col)}` : `${sheet}!${toA1(a.row, a.col)}`;
}

// ---------------------------------------------------------------------------
// Normalization: case/punctuation, spoken numbers, cell-ref joining
// ---------------------------------------------------------------------------

const SMALL_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

function isNumberWord(t: string): boolean {
  return t in SMALL_NUMBERS || t in TENS || t === 'hundred' || t === 'thousand';
}

/** Convert runs of number words ("twenty five", "one hundred five") to digits. */
function convertNumberWords(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isNumberWord(tokens[i])) {
      out.push(tokens[i]);
      i += 1;
      continue;
    }
    // A run of number words must contain at least one unit/tens word to
    // count as a number ("hundred" alone is not a number).
    let j = i;
    let total = 0;
    let current = 0;
    let sawValue = false;
    while (j < tokens.length && isNumberWord(tokens[j])) {
      const t = tokens[j];
      if (t in SMALL_NUMBERS) {
        current += SMALL_NUMBERS[t];
        sawValue = true;
      } else if (t in TENS) {
        current += TENS[t];
        sawValue = true;
      } else if (t === 'hundred') {
        current = (current === 0 ? 1 : current) * 100;
      } else if (t === 'thousand') {
        total += (current === 0 ? 1 : current) * 1000;
        current = 0;
      }
      j += 1;
    }
    if (!sawValue) {
      out.push(tokens[i]);
      i += 1;
      continue;
    }
    out.push(String(total + current));
    i = j;
  }
  return out;
}

/** Tokenize raw dictated/typed text into normalized word tokens. */
export function tokenizeVoiceInput(raw: string): string[] {
  const cleaned = raw
    .toLowerCase()
    .replace(/["“”]/g, ' ')
    // ':' survives: typed ranges (B2:B20) need it.
    .replace(/[.,;!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  let tokens = cleaned.split(' ');
  tokens = convertNumberWords(tokens);
  // Join split cell refs: "b 2" → "b2" (dictation often separates them).
  // Grammar words are never column letters: "to 25" must stay two tokens.
  const NEVER_JOIN = new Set([
    'to', 'of', 'if', 'is', 'in', 'on', 'or', 'an', 'do', 'go', 'no', 'so',
    'up', 'at', 'by', 'be', 'as', 'than', 'then', 'from', 'into', 'over',
    'equal', 'greater', 'less', 'more', 'most', 'least', 'column', 'row',
    'sum', 'set', 'put', 'read', 'show', 'what', 'type', 'enter', 'write',
    // Dictation fillers are never column letters either: "uh 1" must not
    // fuse into the garbage token "uh1" (#41).
    'uh', 'um', 'erm', 'okay', 'ok',
  ]);
  const joined: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (
      /^[a-z]{1,3}$/.test(t) &&
      !NEVER_JOIN.has(t) &&
      next !== undefined &&
      /^\d+$/.test(next)
    ) {
      joined.push(t + next);
      i += 1;
    } else {
      joined.push(t);
    }
  }
  return joined;
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Similarity: squashed Levenshtein + token overlap + phonetic skeleton
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function levSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

/** Crude phonetic skeleton: collapse doubles, drop vowels after the first char. */
function phoneticSkeleton(s: string): string {
  const q = squash(s);
  if (!q) return '';
  let out = q[0];
  for (let i = 1; i < q.length; i += 1) {
    const ch = q[i];
    if ('aeiou'.includes(ch)) continue;
    if (ch === out[out.length - 1]) continue;
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Alias layer — real dictation mangles (brief + the user's dictation history)
// ---------------------------------------------------------------------------

/** Sentinel for the INDEX/MATCH combination pattern. */
export const INDEX_MATCH = 'INDEX+MATCH';

const CATALOG_NAMES = new Set(ALL_FUNCTIONS.map((f) => f.name));

const RAW_ALIASES: { phrases: string[]; fn: string }[] = [
  { phrases: ['some if', 'sum if'], fn: 'SUMIF' },
  { phrases: ['some ifs', 'sum ifs'], fn: 'SUMIFS' },
  { phrases: ['count if'], fn: 'COUNTIF' },
  { phrases: ['count ifs'], fn: 'COUNTIFS' },
  { phrases: ['average if'], fn: 'AVERAGEIF' },
  { phrases: ['average ifs'], fn: 'AVERAGEIFS' },
  { phrases: ['max ifs'], fn: 'MAXIFS' },
  { phrases: ['min ifs'], fn: 'MINIFS' },
  { phrases: ['some product', 'sum product'], fn: 'SUMPRODUCT' },
  { phrases: ['some'], fn: 'SUM' },
  { phrases: ['vee look up', 'v look up', 'vee lookup', 'vertical look up', 'look up', 'lookup'], fn: 'VLOOKUP' },
  { phrases: ['ex look up', 'x look up', 'ex lookup'], fn: 'XLOOKUP' },
  { phrases: ['h look up', 'horizontal look up'], fn: 'HLOOKUP' },
  { phrases: ['index match'], fn: INDEX_MATCH },
  { phrases: ['if error'], fn: 'IFERROR' },
  { phrases: ['if s'], fn: 'IFS' },
  { phrases: ['text join'], fn: 'TEXTJOIN' },
  { phrases: ['text split'], fn: 'TEXTSPLIT' },
  { phrases: ['e date'], fn: 'EDATE' },
  { phrases: ['e o month', 'end of month'], fn: 'EOMONTH' },
  { phrases: ['round up'], fn: 'ROUNDUP' },
  { phrases: ['round down'], fn: 'ROUNDDOWN' },
  { phrases: ['square root'], fn: 'SQRT' },
  { phrases: ['standard deviation'], fn: 'STDEV.S' },
  { phrases: ['con cat'], fn: 'CONCAT' },
  { phrases: ['to day'], fn: 'TODAY' },
  { phrases: ['date value'], fn: 'DATEVALUE' },
  { phrases: ['time value'], fn: 'TIMEVALUE' },
  { phrases: ['week day'], fn: 'WEEKDAY' },
  { phrases: ['network days'], fn: 'NETWORKDAYS' },
  { phrases: ['date dif'], fn: 'DATEDIF' },
  { phrases: ['natural log'], fn: 'LN' },
  { phrases: ['v stack'], fn: 'VSTACK' },
  { phrases: ['h stack'], fn: 'HSTACK' },
  { phrases: ['to col'], fn: 'TOCOL' },
  { phrases: ['to row'], fn: 'TOROW' },
];

/** Aliases whose target the engine actually evaluates (guards staleness). */
export const VOICE_ALIASES = RAW_ALIASES.filter(
  (a) => a.fn === INDEX_MATCH || CATALOG_NAMES.has(a.fn),
).map((a) => ({ ...a, tokens: a.phrases.map((p) => p.split(' ')) }));

// ---------------------------------------------------------------------------
// Function families (grammar coverage)
// ---------------------------------------------------------------------------

/** Functions whose dictated form is FN(range[, range...]). */
const RANGE_AGGREGATES = new Set([
  'SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'COUNTBLANK', 'MAX', 'MIN', 'MEDIAN',
  'PRODUCT', 'SUMPRODUCT', 'LARGE', 'SMALL',
]);

/** FN(range, criteria[, sumRange]) family. */
const IF_FAMILY = new Set(['SUMIF', 'AVERAGEIF']);
const COUNT_IF_FAMILY = new Set(['COUNTIF']);

const FUNCTION_BY_NAME = new Map<string, FunctionInfo>(ALL_FUNCTIONS.map((f) => [f.name, f]));

/** Build a formula skeleton from a catalog signature, e.g. '=SUM(number1, number2)'. */
export function skeletonFormula(info: FunctionInfo): string {
  const { signature, name } = info;
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close <= open) return `=${name}()`;
  const inner = signature.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  const cleaned = parts.map((p) => p.trim()).filter((p) => p && p !== '…' && p !== '...');
  const required = cleaned.filter((p) => !p.startsWith('['));
  const chosen = (required.length > 0 ? required : cleaned.map((p) => p.replace(/^\[|\]$/g, '')));
  return `=${name}(${chosen.join(', ')})`;
}

/** Light structural check for a user-edited formula (the engine validates for real). */
export function validateFormulaText(formula: string): string | null {
  const f = formula.trim();
  if (!f.startsWith('=')) return 'Formula must start with "=".';
  if (f.length < 2) return 'Formula is empty.';
  let depth = 0;
  for (const ch of f) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) return 'Parentheses are unbalanced.';
  }
  if (depth !== 0) return 'Parentheses are unbalanced.';
  // Angle-bracket placeholders like <range> are signature leftovers.
  if (/<[a-z_][a-z_ ]*>/i.test(f)) return 'Replace the <placeholder> arguments first.';
  return null;
}

/** Build the set_formulas MCP call for a formula at the target cell. */
export function buildFormulaCall(target: VoiceTarget, formula: string, principal: string = DEFAULT_PRINCIPAL): VoiceToolCall {
  return {
    tool: 'set_formulas',
    args: {
      formulas: [{ sheet: target.sheet, row: target.row, col: target.col, formula: formula.trim() }],
      principal,
    },
  };
}

// ---------------------------------------------------------------------------
// Range / criteria extraction from remainder tokens
// ---------------------------------------------------------------------------

interface RangeHit {
  /** A1 text as used inside a formula, e.g. 'B2:B20' or 'B:B'. */
  text: string;
  /** Inclusive numeric bounds (present unless the range is a whole column/row). */
  a?: { row: number; col: number };
  b?: { row: number; col: number };
  /** Index just past the consumed tokens. */
  next: number;
}

function refAt(tokens: string[], i: number): { row: number; col: number } | null {
  const t = tokens[i];
  if (!t) return null;
  if (t.includes(':')) return null;
  return parseA1(t);
}

/** Try to read a range starting at tokens[i]. Returns null when none starts there. */
function rangeAt(tokens: string[], i: number): RangeHit | null {
  const t = tokens[i];
  if (!t) return null;
  // Typed range token: "b2:b20"
  if (t.includes(':')) {
    const [lhs, rhs] = t.split(':');
    const a = parseA1(lhs);
    const b = parseA1(rhs);
    if (a && b) return { text: `${toA1(a.row, a.col)}:${toA1(b.row, b.col)}`, a, b, next: i + 1 };
    if (/^[a-z]{1,3}$/.test(lhs) && /^[a-z]{1,3}$/.test(rhs)) {
      return { text: `${lhs.toUpperCase()}:${rhs.toUpperCase()}`, next: i + 1 };
    }
    return null;
  }
  // "column b" / "col b"
  if ((t === 'column' || t === 'col') && /^[a-z]{1,3}$/.test(tokens[i + 1] ?? '')) {
    const letters = (tokens[i + 1] as string).toUpperCase();
    return { text: `${letters}:${letters}`, next: i + 2 };
  }
  // "row 3"
  if (t === 'row' && /^\d+$/.test(tokens[i + 1] ?? '')) {
    const n = tokens[i + 1] as string;
    return { text: `${n}:${n}`, next: i + 2 };
  }
  const a = refAt(tokens, i);
  if (!a) return null;
  // "b2 to b20" / "b2 through b20"
  const sep = tokens[i + 1];
  if (sep === 'to' || sep === 'through' || sep === '-') {
    const b = refAt(tokens, i + 2);
    if (b) return { text: `${toA1(a.row, a.col)}:${toA1(b.row, b.col)}`, a, b, next: i + 3 };
  }
  // single cell as a one-cell range
  return { text: toA1(a.row, a.col), a, b: a, next: i + 1 };
}

/** Find the first range at or after index `from`. */
function findRange(tokens: string[], from: number): { hit: RangeHit; start: number } | null {
  for (let i = from; i < tokens.length; i += 1) {
    const hit = rangeAt(tokens, i);
    if (hit) return { hit, start: i };
  }
  return null;
}

const COMPARATORS: { phrases: string[]; op: string }[] = [
  { phrases: ['greater', 'than', 'or', 'equal', 'to'], op: '>=' },
  { phrases: ['less', 'than', 'or', 'equal', 'to'], op: '<=' },
  { phrases: ['greater', 'than'], op: '>' },
  { phrases: ['more', 'than'], op: '>' },
  { phrases: ['less', 'than'], op: '<' },
  { phrases: ['at', 'least'], op: '>=' },
  { phrases: ['at', 'most'], op: '<=' },
  { phrases: ['not', 'equal', 'to'], op: '<>' },
  { phrases: ['equal', 'to'], op: '=' },
  { phrases: ['equals'], op: '=' },
  { phrases: ['is'], op: '=' },
];

/** Parse a criteria phrase from tokens: returns the formula criteria string. */
function parseCriteria(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const joined = tokens.join(' ');
  // Already-quoted criteria (typed input)
  const quoted = /^"([^"]*)"$/.exec(joined.trim());
  if (quoted) return `"${quoted[1]}"`;
  for (const c of COMPARATORS) {
    if (tokens.length > c.phrases.length && c.phrases.every((p, k) => tokens[k] === p)) {
      const value = tokens.slice(c.phrases.length).join(' ');
      if (!value) return null;
      return c.op === '=' ? `"${value}"` : `"${c.op}${value}"`;
    }
  }
  // Bare value: number or text equality.
  return `"${joined}"`;
}

// ---------------------------------------------------------------------------
// Function matching
// ---------------------------------------------------------------------------

interface FunctionMatch {
  fn: string; // catalog name or INDEX_MATCH
  score: number;
  /** Tokens consumed by the function phrase. */
  span: number;
}

function scoreFunctionPhrase(phraseTokens: string[], info: FunctionInfo): number {
  const phraseSquash = squash(phraseTokens.join(' '));
  const nameSquash = squash(info.name);
  if (!phraseSquash) return 0;
  if (phraseSquash === nameSquash) return 1;
  let best = levSimilarity(phraseSquash, nameSquash);
  if (phoneticSkeleton(phraseSquash) === phoneticSkeleton(nameSquash)) {
    best = Math.max(best, 0.86);
  }
  // Token containment: "sum" inside "sumif" utterances like "some if" squash;
  // a prefix relationship on squashed forms is a strong dictation signal.
  if (nameSquash.startsWith(phraseSquash) || phraseSquash.startsWith(nameSquash)) {
    best = Math.max(best, 0.8);
  }
  return best;
}

function matchFunction(tokens: string[], forceFunction?: string): { best: FunctionMatch; alternates: VoiceAlternate[] } | null {
  if (tokens.length === 0) return null;
  if (forceFunction) {
    // Span = what the unforced best match would have consumed.
    const unforced = matchFunction(tokens);
    return {
      best: { fn: forceFunction, score: unforced?.best.score ?? 0.9, span: unforced?.best.span ?? 1 },
      alternates: [],
    };
  }
  const candidates: FunctionMatch[] = [];
  // Alias pass: known dictation mangles.
  for (const alias of VOICE_ALIASES) {
    for (const phrase of alias.tokens) {
      if (phrase.length <= tokens.length && phrase.every((p, k) => tokens[k] === p)) {
        candidates.push({ fn: alias.fn, score: 0.97, span: phrase.length });
      }
    }
  }
  // Generic pass: spans of 1..3 leading tokens against the whole catalog.
  for (let span = 1; span <= Math.min(3, tokens.length); span += 1) {
    const phrase = tokens.slice(0, span);
    for (const info of ALL_FUNCTIONS) {
      const s = scoreFunctionPhrase(phrase, info);
      if (s >= 0.6) candidates.push({ fn: info.name, score: s, span });
    }
  }
  if (candidates.length === 0) return null;
  // More dictated words = more specific intent: on near-ties the longer
  // span wins ("count if" → COUNTIF, not COUNT; "text join" → TEXTJOIN).
  const effective = (c: FunctionMatch) => c.score + 0.03 * (c.span - 1);
  candidates.sort(
    (a, b) => effective(b) - effective(a) || b.span - a.span || b.score - a.score,
  );
  const best = candidates[0];
  if (best.score < 0.6) return null;
  const scored = candidates;
  const altByName = new Map<string, number>();
  for (const s of scored) {
    if (s.fn === best.fn) continue;
    altByName.set(s.fn, Math.max(altByName.get(s.fn) ?? 0, s.score));
  }
  const alternates = [...altByName.entries()]
    .filter(([, s]) => s >= best.score - 0.12)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, score]) => ({ name, score }));
  return { best, alternates };
}

// ---------------------------------------------------------------------------
// Command grammars
// ---------------------------------------------------------------------------

const FILLER = new Set(['insert', 'add', 'use', 'calculate', 'compute', 'get', 'find', 'give', 'me', 'a', 'an', 'the', 'please', 'formula']);

function stripFillers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && FILLER.has(tokens[i])) i += 1;
  return tokens.slice(i);
}

/**
 * Conversational discourse markers (#41): throat-clearing that real
 * dictation wraps around the actual command — "Okay, uh, …, can you do
 * that?" These tokens are never command content at the EDGES of an
 * utterance, and uh/um/okay are never content anywhere. Before this
 * stripping existed, the fuzzy function matcher scored the NOISE
 * ("okay uh to…") and crowned TODAY() at the 0.6 floor for a fill
 * request — a confident wrong match. Stripping runs only on the
 * function-match path; the verb grammars (set/read/recalc/fill) see
 * the raw tokens and are unaffected.
 */
const DISCOURSE = new Set([
  'okay', 'ok', 'uh', 'um', 'erm', 'hmm', 'well', 'just', 'like',
  'actually', 'basically', 'please', 'can', 'could', 'would', 'you',
  'i', 'me',
]);
const DISCOURSE_ANYWHERE = new Set(['uh', 'um', 'erm', 'okay', 'ok']);

function stripDiscourse(tokens: string[]): string[] {
  let t = tokens.slice();
  // Leading run: discourse singles + the "one thing" throat-clearing
  // bigram (the owner's "to one thing" = "do one thing").
  let i = 0;
  while (i < t.length) {
    if (t[i] === 'one' && t[i + 1] === 'thing') {
      i += 2;
      continue;
    }
    if (DISCOURSE.has(t[i]) || t[i] === 'thing') {
      i += 1;
      continue;
    }
    break;
  }
  t = t.slice(i);
  // Trailing run: "…can you do that", "…please", "…for me".
  let j = t.length;
  while (
    j > 0 &&
    (DISCOURSE.has(t[j - 1]) || t[j - 1] === 'do' || t[j - 1] === 'that' || t[j - 1] === 'thing')
  ) {
    j -= 1;
  }
  t = t.slice(0, j);
  // Interior: pure hesitation sounds carry no content anywhere.
  return t.filter((tok) => !DISCOURSE_ANYWHERE.has(tok));
}

function formulaResolution(
  fn: string,
  score: number,
  target: VoiceTarget,
  principal: string,
  formula: string | null,
  missing: string | undefined,
  alternates: VoiceAlternate[],
): VoiceResolution {
  const label = `Insert formula in ${target.sheet}!${toA1(target.row, target.col)}`;
  return {
    kind: 'formula',
    name: fn === INDEX_MATCH ? 'INDEX + MATCH' : fn,
    score,
    actionLabel: label,
    formula: formula ?? undefined,
    executable: formula !== null && !missing,
    missing,
    call: formula !== null && !missing ? buildFormulaCall(target, formula, principal) : null,
    alternates,
  };
}

function resolveFunctionCommand(
  tokens: string[],
  target: VoiceTarget,
  principal: string,
  forceFunction?: string,
): VoiceResolution | null {
  const match = matchFunction(tokens, forceFunction);
  if (!match) return null;
  const { best, alternates } = match;
  const rest = tokens.slice(best.span);
  const fn = best.fn;

  if (fn === INDEX_MATCH) {
    const formula = '=INDEX(return_range, MATCH(lookup_value, lookup_range, 0))';
    return formulaResolution(fn, best.score, target, principal, formula,
      'Replace return_range, lookup_value, and lookup_range with your ranges and value, then run.',
      alternates);
  }

  const info = FUNCTION_BY_NAME.get(fn);
  if (!info) return null;

  if (RANGE_AGGREGATES.has(fn)) {
    // Collect one or more ranges ("... and <range>" appends).
    const ranges: string[] = [];
    let idx = 0;
    // Skip a leading "of".
    if (rest[0] === 'of') idx = 1;
    let cursor = idx;
    for (;;) {
      const found = findRange(rest, cursor);
      if (!found) break;
      ranges.push(found.hit.text);
      cursor = found.hit.next;
      if (rest[cursor] === 'and') {
        cursor += 1;
        continue;
      }
      break;
    }
    if (ranges.length > 0) {
      const formula = `=${fn}(${ranges.join(', ')})`;
      return formulaResolution(fn, best.score, target, principal, formula, undefined, alternates);
    }
    return formulaResolution(fn, best.score, target, principal, skeletonFormula(info),
      `Say or type the range — e.g. "${fn.toLowerCase()} of B2 to B20" — or edit the formula below.`,
      alternates);
  }

  if (IF_FAMILY.has(fn) || COUNT_IF_FAMILY.has(fn)) {
    let cursor = rest[0] === 'of' ? 1 : 0;
    const found = findRange(rest, cursor);
    if (!found) {
      return formulaResolution(fn, best.score, target, principal, skeletonFormula(info),
        `Say or type the range and condition — e.g. "${fn.toLowerCase()} B2 to B20 greater than 10" — or edit the formula below.`,
        alternates);
    }
    const criteriaTokens = rest.slice(found.hit.next);
    // For SUMIF/AVERAGEIF an optional second range (sum range) may follow the criteria.
    let sumRange: RangeHit | null = null;
    let criteriaEnd = criteriaTokens.length;
    if (IF_FAMILY.has(fn)) {
      for (let i = 1; i < criteriaTokens.length; i += 1) {
        const hit = rangeAt(criteriaTokens, i);
        if (hit && hit.next === criteriaTokens.length) {
          sumRange = hit;
          criteriaEnd = i;
          break;
        }
      }
    }
    const criteria = parseCriteria(criteriaTokens.slice(0, criteriaEnd));
    if (!criteria) {
      return formulaResolution(fn, best.score, target, principal, skeletonFormula(info),
        'Add the condition — e.g. "greater than 10" — or edit the formula below.',
        alternates);
    }
    const formula = sumRange
      ? `=${fn}(${found.hit.text}, ${criteria}, ${sumRange.text})`
      : `=${fn}(${found.hit.text}, ${criteria})`;
    return formulaResolution(fn, best.score, target, principal, formula, undefined, alternates);
  }

  // Any other catalog function: skeleton the user completes in the preview.
  return formulaResolution(fn, best.score, target, principal, skeletonFormula(info),
    'Complete the arguments in the formula below, then run.',
    alternates);
}

function resolveWriteCommand(tokens: string[], target: VoiceTarget, principal: string): VoiceResolution | null {
  const verb = tokens[0];
  if (!['set', 'put', 'write', 'type', 'enter'].includes(verb)) return null;
  const refIdx = tokens.findIndex((t, i) => i > 0 && parseA1(t) !== null && !t.includes(':'));
  if (refIdx < 0) return null;
  const ref = parseA1(tokens[refIdx]) as { row: number; col: number };
  let valueTokens = tokens.slice(refIdx + 1);
  if (valueTokens[0] === 'to' || valueTokens[0] === '=') valueTokens = valueTokens.slice(1);
  const sheet = target.sheet;
  const labelRef = `${sheet}!${toA1(ref.row, ref.col)}`;
  if (valueTokens.length === 0) {
    return {
      kind: 'write', name: 'Write value', score: 0.9,
      actionLabel: `Set ${labelRef} to …`,
      executable: false, missing: 'Say or type the value — e.g. "set B3 to 42".',
      call: null, alternates: [],
    };
  }
  const rawValue = valueTokens.join(' ');
  // A formula value routes to set_formulas (write_cells would also accept
  // it, but the dedicated tool keeps the audit trail precise).
  if (rawValue.startsWith('=')) {
    return {
      kind: 'formula', name: 'Formula', score: 0.9,
      actionLabel: `Insert formula in ${labelRef}`,
      formula: rawValue, executable: true,
      call: buildFormulaCall({ sheet, row: ref.row, col: ref.col }, rawValue, principal),
      alternates: [],
    };
  }
  const numeric = /^-?\d+(\.\d+)?$/.test(rawValue) ? Number(rawValue) : null;
  const value: string | number | boolean =
    numeric !== null ? numeric : rawValue === 'true' ? true : rawValue === 'false' ? false : rawValue;
  return {
    kind: 'write', name: 'Write value', score: 0.95,
    actionLabel: `Set ${labelRef} to ${typeof value === 'string' ? `"${value}"` : String(value)}`,
    executable: true,
    call: {
      tool: 'write_cells',
      args: { cells: [{ sheet, row: ref.row, col: ref.col, value }], principal },
    },
    alternates: [],
  };
}

function resolveReadCommand(tokens: string[], target: VoiceTarget, principal: string): VoiceResolution | null {
  const joined = tokens.join(' ');
  const isRead =
    ['read', 'show', 'display'].includes(tokens[0]) ||
    joined.startsWith('what is in') ||
    joined.startsWith('whats in');
  if (!isRead) return null;
  const startIdx = joined.startsWith('what') ? 3 : 1;
  const found = findRange(tokens, startIdx);
  if (!found || !found.hit.a) {
    return {
      kind: 'read', name: 'Read cells', score: 0.85,
      actionLabel: `Read ${target.sheet}!…`,
      executable: false, missing: 'Say or type the cells — e.g. "read B2 to B5".',
      call: null, alternates: [],
    };
  }
  const a = found.hit.a;
  const b = found.hit.b ?? a;
  return {
    kind: 'read', name: 'Read cells', score: 0.95,
    actionLabel: `Read ${rangeLabel(target.sheet, a, b)}`,
    executable: true,
    call: {
      tool: 'read_cells',
      args: {
        sheet: target.sheet,
        startRow: Math.min(a.row, b.row), startCol: Math.min(a.col, b.col),
        endRow: Math.max(a.row, b.row), endCol: Math.max(a.col, b.col),
        principal,
      },
    },
    alternates: [],
  };
}

function resolveRecalculate(tokens: string[]): VoiceResolution | null {
  const words = new Set(tokens);
  if (!words.has('recalculate') && !words.has('recalc')) return null;
  const allowed = new Set(['recalculate', 'recalc', 'the', 'sheet', 'workbook', 'now', 'please', 'all', 'formulas']);
  if (!tokens.every((t) => allowed.has(t))) return null;
  return {
    kind: 'recalculate', name: 'Recalculate', score: 0.95,
    actionLabel: 'Recalculate the workbook',
    executable: true,
    call: { tool: 'recalculate', args: { principal: DEFAULT_PRINCIPAL } },
    alternates: [],
  };
}

/**
 * Fill-series grammar (#41): "fill 1 to 10", "fill A1 to A10 with 1 to
 * 10", "fill 10 down to 1". A series of consecutive integers written
 * with ONE write_cells call. The verb may be preceded by a few
 * noise tokens ("okay uh to one thing, fill uh, one to 10" — the
 * owner's verbatim utterance). Without a series the resolution is
 * offered non-executable with guidance, never dropped into the fuzzy
 * function matcher (which used to invent TODAY() for it).
 */
const FILL_NOISE_PREFIX = new Set([
  'okay', 'ok', 'uh', 'um', 'erm', 'hmm', 'well', 'to', 'one', 'thing',
  'can', 'you', 'please', 'just', 'like', 'a', 'the', 'i', 'want', 'do',
  'that',
]);
const MAX_FILL_CELLS = 1000;

function resolveFillCommand(
  tokens: string[],
  target: VoiceTarget,
  principal: string,
): VoiceResolution | null {
  let fillIdx = -1;
  for (let i = 0; i < Math.min(6, tokens.length); i += 1) {
    if (tokens[i] === 'fill') {
      fillIdx = i;
      break;
    }
    // Noise = discourse markers and stray numbers ("to ONE thing" —
    // the number word is already converted by the tokenizer). A bare
    // number before the verb has no role in any other grammar.
    if (!FILL_NOISE_PREFIX.has(tokens[i]) && !/^\d+$/.test(tokens[i])) return null;
  }
  if (fillIdx < 0) return null;
  const rest = tokens
    .slice(fillIdx + 1)
    .filter((t) => !DISCOURSE_ANYWHERE.has(t));
  const sheet = target.sheet;
  const notExecutable = (missing: string): VoiceResolution => ({
    kind: 'write',
    name: 'Fill series',
    score: 0.9,
    actionLabel: `Fill ${sheet}!${toA1(target.row, target.col)}…`,
    executable: false,
    missing,
    call: null,
    alternates: [],
  });

  // Optional explicit range FIRST ("fill a1 to a10 with …"): only a hit
  // starting at token 0 counts, so "fill 1 to 10" (numbers, no ref) is
  // never mistaken for a range.
  let cells: { row: number; col: number }[] | null = null;
  let seriesTokens = rest;
  const hit0 = rest.length > 0 ? rangeAt(rest, 0) : null;
  if (hit0 && hit0.a && hit0.b) {
    const a = hit0.a;
    const b = hit0.b;
    cells = [];
    if (a.col === b.col) {
      for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r += 1) cells.push({ row: r, col: a.col });
    } else if (a.row === b.row) {
      for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c += 1) cells.push({ row: a.row, col: c });
    } else {
      for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r += 1) {
        for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c += 1) cells.push({ row: r, col: c });
      }
    }
    seriesTokens = rest.slice(hit0.next);
    if (seriesTokens[0] === 'with' || seriesTokens[0] === 'from') seriesTokens = seriesTokens.slice(1);
  }

  // The series: "<int> to <int>" / "<int> through <int>" anywhere in the
  // remaining tokens ("with 1 to 10", "from 5 to 8", bare "1 to 10").
  let from: number | null = null;
  let to: number | null = null;
  for (let i = 0; i + 2 <= seriesTokens.length - 1; i += 1) {
    const a = seriesTokens[i];
    const sep = seriesTokens[i + 1];
    const b = seriesTokens[i + 2];
    if (/^-?\d+$/.test(a) && (sep === 'to' || sep === 'through' || sep === 'down') && /^-?\d+$/.test(b)) {
      // "10 down to 1": the separator run is "down to" — accept and let
      // the sign of (to - from) pick the direction.
      from = Number(a);
      to = Number(b);
      break;
    }
    if (/^-?\d+$/.test(a) && sep === 'down' && seriesTokens[i + 2] === 'to' && /^-?\d+$/.test(seriesTokens[i + 3] ?? '')) {
      from = Number(a);
      to = Number(seriesTokens[i + 3]);
      break;
    }
  }
  if (from === null || to === null) {
    return notExecutable('Say the numbers — e.g. "fill 1 to 10", or "fill A1 to A10 with 1 to 10".');
  }
  const count = Math.abs(to - from) + 1;
  if (count > MAX_FILL_CELLS) {
    return notExecutable(`That series is ${count} cells — the palette fills at most ${MAX_FILL_CELLS} at a time.`);
  }
  const step = to >= from ? 1 : -1;
  if (!cells) {
    // No range spoken: fill DOWN the column from the target cell.
    cells = [];
    for (let k = 0; k < count; k += 1) cells.push({ row: target.row + k, col: target.col });
  }
  const n = Math.min(count, cells.length);
  const writes = cells.slice(0, n).map((c, k) => ({
    sheet,
    row: c.row,
    col: c.col,
    value: from + step * k,
  }));
  const first = writes[0];
  const last = writes[writes.length - 1];
  return {
    kind: 'write',
    name: 'Fill series',
    score: 0.95,
    actionLabel: `Fill ${rangeLabel(sheet, first, last)} with ${from} to ${to}`,
    executable: true,
    call: { tool: 'write_cells', args: { cells: writes, principal } },
    alternates: [],
  };
}

/**
 * A match at or above this score may be presented as THE command
 * (palette preview, or the composer fast-path offer behind the mic —
 * §7.1). Below it nothing may push a best guess (#41 / design doc §7):
 * the words stay with the user / go to the agent instead.
 */
export const CONFIDENT_MATCH_SCORE = 0.85;

/**
 * Resolve raw dictated/typed text to at most one palette command.
 * Returns null when nothing matches well enough to offer.
 */
export function resolveVoiceCommand(
  rawInput: string,
  target: VoiceTarget,
  opts: VoiceResolveOptions = {},
): VoiceResolution | null {
  const principal = opts.principal ?? DEFAULT_PRINCIPAL;
  const tokens = tokenizeVoiceInput(rawInput);
  if (tokens.length === 0) return null;

  if (!opts.forceFunction) {
    const recalc = resolveRecalculate(tokens);
    if (recalc) {
      // Recalculate carries no principal option in its builder; rebuild with ours.
      if (recalc.call) recalc.call.args.principal = principal;
      return recalc;
    }
    const write = resolveWriteCommand(tokens, target, principal);
    if (write) return write;
    const read = resolveReadCommand(tokens, target, principal);
    if (read) return read;
    // Fill series (#41): its own grammar, ahead of the fuzzy function
    // matcher — a fill request must never be fuzzy-matched into a
    // function (the owner's "fill one to 10" became TODAY()).
    const fill = resolveFillCommand(tokens, target, principal);
    if (fill) return fill;
  }
  const fnTokens = stripFillers(stripDiscourse(tokens));
  return resolveFunctionCommand(fnTokens, target, principal, opts.forceFunction);
}

/** Example utterances for the palette's hint line. */
export const VOICE_EXAMPLES = [
  'some if B2 to B20 greater than 10',
  'sum of column B',
  'set C3 to 42',
  'read B2 to B5',
  'vee look up',
  'recalculate',
];
