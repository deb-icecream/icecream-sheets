/**
 * Deterministic inference — autocomplete (design-docs/deterministic-inference.md §5).
 *
 * Cell value autocomplete from column history/patterns; formula
 * autocomplete for function names and range references. Suggestions only —
 * nothing is inserted without the user picking one.
 *
 * All ranking is deterministic: frequency then alphabetical, no
 * randomness, no cross-workbook learning (out of scope for v1).
 */

import { FUNCTION_CATALOG, type FunctionCatalogEntry } from './functions.generated.js';

export interface ValueSuggestion {
  /** The completed value. */
  text: string;
  /** How many times it appears in the column history. */
  count: number;
}

export interface AutocompleteOptions {
  /** Max suggestions returned. Default 8. */
  max?: number;
}

/**
 * Cell value autocomplete from column history. `values` are the display
 * strings of the column's cells (the caller reads them through the typed
 * view, so denied cells are already excluded). Prefix matching is
 * case-insensitive; ranking is by frequency, then alphabetically for full
 * determinism.
 */
export function suggestCellValues(
  values: readonly string[],
  prefix: string,
  opts: AutocompleteOptions = {},
): ValueSuggestion[] {
  const max = opts.max ?? 8;
  const p = prefix.toLowerCase();
  const counts = new Map<string, { text: string; count: number }>();
  for (const v of values) {
    if (v === '') continue;
    if (!v.toLowerCase().startsWith(p)) continue;
    // Skip the exact already-typed value: nothing to complete.
    if (v.toLowerCase() === p) continue;
    const key = v.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { text: v, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || compareText(a.text, b.text))
    .slice(0, max);
}

function compareText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface FunctionSuggestion {
  name: string;
  category: string;
  signature: string;
}

/**
 * Formula autocomplete for function names. Matches the catalog generated
 * from the engine's registered plugins (functions.generated.ts), so every
 * suggestion is a function the engine can actually evaluate. Prefix
 * matching only (Excel-style); exact match ranks first, then alphabetical.
 */
export function suggestFunctions(
  prefix: string,
  opts: AutocompleteOptions = {},
): FunctionSuggestion[] {
  const max = opts.max ?? 8;
  const p = prefix.trim().toUpperCase();
  if (p === '') return [];
  const matches: FunctionCatalogEntry[] = [];
  for (const fn of FUNCTION_CATALOG) {
    if (fn.name.startsWith(p)) matches.push(fn);
  }
  matches.sort((a, b) => {
    const ae = a.name === p ? 0 : 1;
    const be = b.name === p ? 0 : 1;
    if (ae !== be) return ae - be;
    return a.name < b.name ? -1 : 1;
  });
  return matches.slice(0, max).map((f) => ({ name: f.name, category: f.category, signature: f.signature }));
}

export interface RangeColumnInfo {
  /** Column letters, e.g. 'B'. */
  letter: string;
  /** Header display text (may be ''). */
  header: string;
  /** 1-based first data row (below the header). */
  firstDataRow: number;
  /** 1-based last data row. */
  lastDataRow: number;
}

export interface RangeSuggestion {
  /** A1 range text to insert, e.g. 'B2:B41'. */
  ref: string;
  /** Human label, e.g. 'B2:B41 — Amount'. */
  label: string;
}

/**
 * Formula autocomplete for range references. Given the used columns of the
 * sheet, suggests bounded data ranges ('B2:B41') labeled by header.
 * Deterministic: columns in sheet order, prefix filters on column letters
 * or header text.
 */
export function suggestRangeRefs(
  prefix: string,
  columns: readonly RangeColumnInfo[],
  opts: AutocompleteOptions = {},
): RangeSuggestion[] {
  const max = opts.max ?? 8;
  const p = prefix.trim().toUpperCase();
  const out: RangeSuggestion[] = [];
  // A typed cell reference ('A1', 'BC12') matches its column even though
  // the column letter alone is a strict prefix of what was typed.
  const typedCellRef = /^[A-Z]{1,3}[0-9]/.test(p);
  for (const c of columns) {
    if (c.lastDataRow < c.firstDataRow) continue;
    const ref = `${c.letter}${c.firstDataRow}:${c.letter}${c.lastDataRow}`;
    if (
      p !== '' &&
      !c.letter.startsWith(p) &&
      !(typedCellRef && p.startsWith(c.letter)) &&
      !c.header.toUpperCase().startsWith(p)
    )
      continue;
    const label = c.header ? `${ref} — ${c.header}` : ref;
    out.push({ ref, label });
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// Formula-draft token analysis
// ---------------------------------------------------------------------------

export type FormulaCompletionKind = 'function' | 'range';

export interface FormulaCompletionRequest {
  kind: FormulaCompletionKind;
  /** The partial token under the caret. */
  prefix: string;
}

/**
 * Inspect the formula draft at the caret and decide what kind of
 * completion applies, if any. Returns null when the caret is not in a
 * completable position (e.g. inside a string literal, after a complete
 * reference, or mid-identifier).
 *
 * - Function completion: the token is a bare identifier immediately after
 *   '=', '(', ',', or an operator (not preceded by '!' or part of a
 *   longer token).
 * - Range completion: the token looks like a cell/column reference
 *   ([A-Z]{1,3}[0-9]*) in an argument position.
 */
export function completionAtCaret(draft: string, caret: number): FormulaCompletionRequest | null {
  // Formula completion only applies to formula drafts. Plain-text entry
  // (cell values) uses suggestCellValues() instead.
  if (!draft.startsWith('=')) return null;
  const pos = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, pos);
  if (isInsideStringLiteral(before)) return null;
  const tokenMatch = before.match(/[A-Za-z_][A-Za-z0-9_.]*$/);
  if (!tokenMatch) return null;
  const token = tokenMatch[0];
  const tokenStart = pos - token.length;
  const prev = tokenStart > 0 ? before[tokenStart - 1] : '';
  // Part of a sheet-qualified or longer reference: no completion.
  if (prev === '!' || prev === "'" || prev === '.' || prev === '$') return null;
  // Must be in an argument/start position.
  if (!/^[=(,+\-*/^&<>:;{\s]$/.test(prev) && prev !== '') return null;
  const upper = token.toUpperCase();
  if (/^[A-Z]{1,3}[0-9]+$/.test(upper)) {
    return { kind: 'range', prefix: upper };
  }
  // Bare letters are ambiguous (column letters vs function names like IF):
  // report function completion; autocompleteFormula() adds range
  // candidates too when the prefix is short.
  return { kind: 'function', prefix: upper };
}

/** True when `before` (text left of the caret) ends inside an open string literal. */
function isInsideStringLiteral(before: string): boolean {
  let inString = false;
  for (const ch of before) {
    if (ch === '"') inString = !inString;
  }
  return inString;
}

/**
 * One-call formula autocomplete for the UI: given the draft and caret,
 * return the completion kind plus the suggestions. `columns` feeds range
 * completion; pass [] when the sheet has no used range.
 */
export function autocompleteFormula(
  draft: string,
  caret: number,
  columns: readonly RangeColumnInfo[],
  opts: AutocompleteOptions = {},
): { kind: FormulaCompletionKind; prefix: string; functions: FunctionSuggestion[]; ranges: RangeSuggestion[] } | null {
  const req = completionAtCaret(draft, caret);
  if (!req) return null;
  if (req.kind === 'function') {
    const functions = suggestFunctions(req.prefix, opts);
    // Bare-letter prefixes are ambiguous between column letters and
    // function names: offer range candidates alongside when short.
    const ranges =
      /^[A-Z]{1,3}$/.test(req.prefix) && req.prefix.length <= 3
        ? suggestRangeRefs(req.prefix, columns, opts)
        : [];
    return { kind: 'function', prefix: req.prefix, functions, ranges };
  }
  return { kind: 'range', prefix: req.prefix, functions: [], ranges: suggestRangeRefs(req.prefix, columns, opts) };
}

/**
 * Build RangeColumnInfo[] for a sheet from its used-range grid. The caller
 * reads the used range through the typed view; denied cells are skipped
 * (their columns simply contribute less data).
 */
export function rangeColumnsFromGrid(
  grid: { value: string | number | boolean | null; denied: boolean }[][],
  startRow: number,
  startCol: number,
  opts: { headerRow?: number } = {},
): RangeColumnInfo[] {
  const headerRow = opts.headerRow ?? 0;
  if (grid.length === 0) return [];
  const colCount = Math.max(...grid.map((r) => r.length));
  const out: RangeColumnInfo[] = [];
  for (let c = 0; c < colCount; c++) {
    const headerCell = grid[headerRow]?.[c];
    const header = headerCell && !headerCell.denied && typeof headerCell.value === 'string' ? headerCell.value : '';
    let first = -1;
    let last = -1;
    for (let r = headerRow + 1; r < grid.length; r++) {
      const cell = grid[r]?.[c];
      if (!cell || cell.denied) continue;
      if (cell.value !== null && cell.value !== undefined && cell.value !== '') {
        if (first < 0) first = r;
        last = r;
      }
    }
    if (first < 0) continue;
    out.push({
      letter: colLetters(startCol + c),
      header,
      firstDataRow: startRow + first + 1,
      lastDataRow: startRow + last + 1,
    });
  }
  return out;
}

function colLetters(col: number): string {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
