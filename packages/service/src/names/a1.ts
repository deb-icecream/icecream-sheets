/**
 * A1 reference helpers for the names module (browser-safe, dependency-free).
 *
 * The service layer cannot import the web app's features/names.ts, and
 * access.ts keeps its A1 helpers private — so the small set needed here
 * (parse, absolute-format for HyperFormula, defined-name ref parsing) lives
 * in this module with its own tests.
 */
import type { NameRangeRef } from './types.js';

export function colIndexToLetters(n: number): string {
  let s = '';
  let v = n + 1; // 0-based index -> 1-based
  while (v > 0) {
    const r = (v - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

export function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const v = ch.charCodeAt(0) - 64;
    if (v < 1 || v > 26) throw new Error(`names: bad column letters '${letters}'`);
    n = n * 26 + v;
  }
  return n - 1;
}

/** Quote a sheet name for formula use ('My Sheet'!A1). */
export function quoteSheetName(sheet: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet)) return sheet;
  return `'${sheet.replace(/'/g, "''")}'`;
}

/** Strip Excel-style single quotes around a sheet name. */
export function unquoteSheetName(sheet: string): string {
  const t = sheet.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;

function parseCell(a1: string): { row: number; col: number } {
  const m = CELL_RE.exec(a1.trim());
  if (!m) throw new Error(`names: bad A1 cell ref '${a1}'`);
  const row = parseInt(m[2]!, 10) - 1;
  const col = colLettersToIndex(m[1]!);
  if (row < 0 || row > 1048575 || col < 0 || col > 16383) {
    throw new Error(`names: A1 ref out of grid '${a1}'`);
  }
  return { row, col };
}

/**
 * Parse 'A1' / '$B$12' / 'A1:B2' (0-based). Returns null for invalid syntax
 * or out-of-grid coordinates. Inverted ranges normalize.
 */
export function parseA1Range(text: string): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
  const trimmed = text.trim().replace(/\s+/g, '');
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(':');
  if (parts.length > 2) return null;
  try {
    const a = parseCell(parts[0]!);
    const b = parts.length === 2 ? parseCell(parts[1]!) : a;
    return {
      startRow: Math.min(a.row, b.row),
      startCol: Math.min(a.col, b.col),
      endRow: Math.max(a.row, b.row),
      endCol: Math.max(a.col, b.col),
    };
  } catch {
    return null;
  }
}

/**
 * Format a range ref as an absolute HyperFormula named-expression formula,
 * e.g. `=Sheet1!$A$1:$B$10`. Sheet names are quoted when needed.
 */
export function formatAbsoluteRef(ref: NameRangeRef): string {
  const cell = (row: number, col: number): string => `$${colIndexToLetters(col)}$${row + 1}`;
  const tl = cell(ref.startRow, ref.startCol);
  const range =
    ref.startRow === ref.endRow && ref.startCol === ref.endCol
      ? tl
      : `${tl}:${cell(ref.endRow, ref.endCol)}`;
  return `=${quoteSheetName(ref.sheet)}!${range}`;
}

/**
 * Parse a defined-name ref formula back into a range ref:
 * `=Sheet1!$A$1:$B$2`, `='My Sheet'!$A$1`, `#REF!` (→ null = dangling).
 * Returns null for dangling/unparseable refs; the caller decides whether
 * null means dangling (range def) or not-a-range (function def).
 */
export function parseDefinedNameRef(formula: string): NameRangeRef | null {
  let text = formula.trim();
  if (text.startsWith('=')) text = text.slice(1).trim();
  if (text === '' || /#REF!/i.test(text)) return null;
  // Split off an optional sheet qualifier: 'Sheet'!A1 or Sheet!A1:B2.
  // The sheet part may be quoted and contain '!'.
  let sheet = '';
  let rest = text;
  const bang = findRefBang(text);
  if (bang >= 0) {
    sheet = unquoteSheetName(text.slice(0, bang));
    rest = text.slice(bang + 1);
  }
  const parsed = parseA1Range(rest);
  if (!parsed) return null;
  return { sheet, ...parsed };
}

/**
 * Find the '!' separating sheet qualifier from cell ref, skipping quoted
 * sheet names ('O''Brien'!A1) and string content (not expected in refs, but
 * be conservative).
 */
function findRefBang(text: string): number {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") {
      if (text[i + 1] === "'") {
        i++; // escaped quote inside quoted name
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === '!' && !inQuotes) return i;
  }
  return -1;
}

/** Sheet-qualified A1 target for authorize(), e.g. `Sheet1!A1:B2`. */
export function refToTarget(ref: NameRangeRef): string {
  const cell = (row: number, col: number): string => `${colIndexToLetters(col)}${row + 1}`;
  const tl = cell(ref.startRow, ref.startCol);
  const range =
    ref.startRow === ref.endRow && ref.startCol === ref.endCol
      ? tl
      : `${tl}:${cell(ref.endRow, ref.endCol)}`;
  return `${ref.sheet}!${range}`;
}
