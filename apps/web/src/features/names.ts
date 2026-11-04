/**
 * Named ranges: workbook-level names that refer to a cell range on a sheet.
 *
 * Names are UI-layer state (like formatting rules). substituteNames rewrites
 * formulas entered by the user so the engine sees plain A1 references.
 */
import { colLabel } from '../engine';

export interface NamedRange {
  name: string;
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// Matches A1-style cell references, e.g. A1, Z99, XFD1048576.
const A1_CELL_REF = /^[A-Za-z]{1,3}[0-9]+$/;
// Matches R1C1-style references, e.g. R1C1, R12C5.
const R1C1_CELL_REF = /^[Rr][0-9]+[Cc][0-9]+$/;

/**
 * True when the name is a legal Excel name: starts with a letter or
 * underscore, continues with letters/digits/underscores/dots, and does not
 * look like a cell reference (A1, XFD1048576, R1C1, ...).
 */
export function isValidName(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return false;
  if (A1_CELL_REF.test(name)) return false;
  if (R1C1_CELL_REF.test(name)) return false;
  return true;
}

/** Quote a sheet name for use in a formula when it needs quoting. */
export function quoteSheet(sheet: string): string {
  if (sheet.includes(' ') || sheet.includes("'")) {
    return `'${sheet.replace(/'/g, "''")}'`;
  }
  return sheet;
}

/** A1 reference for a named range, always sheet-qualified: Sheet1!A1:A10. */
export function a1Range(n: NamedRange): string {
  const tl = `${colLabel(n.startCol)}${n.startRow + 1}`;
  const br = `${colLabel(n.endCol)}${n.endRow + 1}`;
  const ref = n.startRow === n.endRow && n.startCol === n.endCol ? tl : `${tl}:${br}`;
  return `${quoteSheet(n.sheet)}!${ref}`;
}

function colLettersToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1; // 1-based letters -> 0-based index
}

const A1_PART = '\\$?([A-Za-z]{1,3})\\$?([0-9]+)';
const A1_REF_RE = new RegExp(`^${A1_PART}(?::${A1_PART})?$`);

/**
 * Parse an A1 range like "A1", "A1:B10", or "$A$1:$B$10" into 0-based
 * coordinates. Returns null for invalid syntax, zero/negative rows, or
 * coordinates beyond Excel's 1048576x16384 grid. Inverted ranges (B2:A1)
 * are normalized.
 */
export function parseA1Ref(
  text: string,
): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
  const trimmed = text.trim().replace(/\s+/g, '');
  const m = A1_REF_RE.exec(trimmed);
  if (!m) return null;

  const startCol = colLettersToIndex(m[1]);
  const startRow = Number(m[2]) - 1;
  const endCol = m[3] !== undefined ? colLettersToIndex(m[3]) : startCol;
  const endRow = m[4] !== undefined ? Number(m[4]) - 1 : startRow;

  if (startRow < 0 || endRow < 0) return null;
  if (startRow > 1048575 || endRow > 1048575) return null;
  if (startCol < 0 || startCol > 16383 || endCol < 0 || endCol > 16383) return null;

  return {
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace whole-word occurrences of each named range in a formula with the
 * range's sheet-qualified A1 reference, e.g. `=SUM(Sales)` becomes
 * `=SUM(Sheet1!A1:A10)`.
 *
 * Replacement is single-pass (longest names first), so a name can never
 * match inside another name's substituted reference. Matching is
 * case-sensitive. Names are not substituted inside double-quoted string
 * literals — keep formulas' string constants quoted carefully.
 */
export function substituteNames(formula: string, names: NamedRange[]): string {
  const valid = names.filter((n) => isValidName(n.name));
  if (valid.length === 0) return formula;
  const byName = new Map(valid.map((n) => [n.name, n]));
  const pattern = valid
    .map((n) => escapeRegExp(n.name))
    .sort((a, b) => b.length - a.length)
    .join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_.])(?:${pattern})(?![A-Za-z0-9_.])`, 'g');
  return formula.replace(re, (match) => {
    const n = byName.get(match);
    return n ? a1Range(n) : match;
  });
}
