/**
 * Defined-names extras (Formulas > Defined Names):
 * - validateDefineName: name/scope/refers-to validation for Define Name…
 * - parseRefersTo: parse "=Sheet1!$A$1:$A$10" / "=$A$1" into coordinates
 * - applyNamesToFormula: Apply Names… — rewrite A1 references in formulas
 *   to their defined names (the inverse of names.substituteNames)
 * - createNamesFromSelection: Create from Selection — turn top-row / left-
 *   column labels into names over the adjacent data ranges
 *
 * Name-validation helpers are mirrored here (instead of importing
 * features/names.ts) so this module never pulls in the engine bundle —
 * features/names.ts imports colLabel from the web engine layer, whose
 * package dist is not vitest-resolvable in this repo state. The mirrors
 * are byte-for-byte logic copies of names.ts; see the note on each.
 */

export interface NamedRange {
  name: string;
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// --- Mirrors of features/names.ts (kept in sync; see module note) ---

const A1_CELL_REF = /^[A-Za-z]{1,3}[0-9]+$/;
const R1C1_CELL_REF = /^[Rr][0-9]+[Cc][0-9]+$/;

/** Mirror of names.isValidName. */
function isValidName(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return false;
  if (A1_CELL_REF.test(name)) return false;
  if (R1C1_CELL_REF.test(name)) return false;
  return true;
}

/** Mirror of names.quoteSheet. */
function quoteSheet(sheet: string): string {
  if (sheet.includes(' ') || sheet.includes("'")) {
    return `'${sheet.replace(/'/g, "''")}'`;
  }
  return sheet;
}

function colLabel(c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Mirror of names.a1Range. */
function a1Range(n: NamedRange): string {
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
  return index - 1;
}

const A1_PART = '\\$?([A-Za-z]{1,3})\\$?([0-9]+)';
const A1_REF_RE = new RegExp(`^${A1_PART}(?::${A1_PART})?$`);

/** Mirror of names.parseA1Ref. */
function parseA1Ref(text: string): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
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

// --- End mirrors ---

export interface DefineNameInput {
  name: string;
  /** 'workbook' or a sheet name for sheet-scoped names. */
  scope: string;
  /** e.g. "=Sheet1!$A$1:$A$10" or "=A1:A10". */
  refersTo: string;
}

export type DefineNameError =
  | { kind: 'name'; message: string }
  | { kind: 'refersTo'; message: string };

export function validateDefineName(
  input: DefineNameInput,
  existing: NamedRange[],
): { ok: true } | { ok: false; error: DefineNameError } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: { kind: 'name', message: 'Enter a name.' } };
  if (!isValidName(name)) {
    return {
      ok: false,
      error: {
        kind: 'name',
        message: `"${name}" is not a valid name: use letters, digits, underscores or dots, and avoid cell references like A1.`,
      },
    };
  }
  const clash = existing.some(
    (n) => n.name.toLowerCase() === name.toLowerCase() && scopeOf(n) === input.scope,
  );
  if (clash) {
    return { ok: false, error: { kind: 'name', message: `The name "${name}" is already defined in this scope.` } };
  }
  if (!parseRefersTo(input.refersTo)) {
    return {
      ok: false,
      error: {
        kind: 'refersTo',
        message: 'Refers to must be a cell or range reference like =Sheet1!$A$1:$A$10.',
      },
    };
  }
  return { ok: true };
}

/** Scope key for a NamedRange: sheet-scoped names carry `sheet!name`. */
export function scopeOf(n: NamedRange): string {
  const bang = n.name.indexOf('!');
  if (bang > 0) return n.name.slice(0, bang);
  return 'workbook';
}

export interface ParsedRefersTo {
  /** Sheet name, or null when the reference is unqualified. */
  sheet: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Parse a Refers-To value: optional leading "=", optional sheet qualifier
 * (quoted or bare), then an A1 cell or range.
 */
export function parseRefersTo(refersTo: string): ParsedRefersTo | null {
  let text = refersTo.trim();
  if (text.startsWith('=')) text = text.slice(1).trim();
  let sheet: string | null = null;
  const bang = text.lastIndexOf('!');
  if (bang >= 0) {
    const sheetPart = text.slice(0, bang).trim();
    if (sheetPart.startsWith("'") && sheetPart.endsWith("'") && sheetPart.length >= 2) {
      sheet = sheetPart.slice(1, -1).replace(/''/g, "'");
    } else {
      sheet = sheetPart;
    }
    text = text.slice(bang + 1).trim();
  }
  const range = parseA1Ref(text);
  if (!range) return null;
  return { sheet, ...range };
}

export function refersToToNamedRange(name: string, scope: string, refersTo: string, defaultSheet: string): NamedRange | null {
  const parsed = parseRefersTo(refersTo);
  if (!parsed) return null;
  const sheet = parsed.sheet ?? defaultSheet;
  const scopedName = scope === 'workbook' ? name : `${scope}!${name}`;
  return {
    name: scopedName,
    sheet,
    startRow: parsed.startRow,
    startCol: parsed.startCol,
    endRow: parsed.endRow,
    endCol: parsed.endCol,
  };
}

// ---------------------------------------------------------------------------
// Apply Names…: rewrite A1 references in a formula to defined names
// ---------------------------------------------------------------------------

/** Split a formula into code vs double-quoted string-literal segments. */
function splitLiterals(formula: string): { text: string; literal: boolean }[] {
  const out: { text: string; literal: boolean }[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < formula.length; i++) {
    const ch = formula[i];
    if (ch === '"') {
      if (inStr && formula[i + 1] === '"') {
        cur += '""';
        i++;
        continue;
      }
      out.push({ text: cur, literal: inStr });
      cur = '"';
      inStr = !inStr;
      if (!inStr) {
        out.push({ text: cur, literal: true });
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  out.push({ text: cur, literal: inStr });
  return out.filter((s) => s.text.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All A1 spellings of a range that can appear in a formula. */
function refSpellings(n: NamedRange): string[] {
  const spellings = new Set<string>();
  const abs = (col: number, row: number) => `$${colLabel(col)}$${row + 1}`;
  const tl = `${colLabel(n.startCol)}${n.startRow + 1}`;
  const br = `${colLabel(n.endCol)}${n.endRow + 1}`;
  const range = n.startRow === n.endRow && n.startCol === n.endCol ? tl : `${tl}:${br}`;
  const absRange =
    n.startRow === n.endRow && n.startCol === n.endCol
      ? abs(n.startCol, n.startRow)
      : `${abs(n.startCol, n.startRow)}:${abs(n.endCol, n.endRow)}`;
  spellings.add(range);
  spellings.add(absRange);
  spellings.add(`${quoteSheet(n.sheet)}!${range}`);
  spellings.add(`${quoteSheet(n.sheet)}!${absRange}`);
  // Mixed $ forms people actually type.
  spellings.add(`$${tl}:${br}`);
  spellings.add(`${tl}:$${br}`);
  return [...spellings];
}

/**
 * Apply Names: replace A1 references in `formula` with their defined
 * names. Only whole-token matches outside string literals are replaced;
 * names whose reference does not appear are untouched.
 */
export function applyNamesToFormula(formula: string, names: NamedRange[]): string {
  const valid = names.filter((n) => isValidName(n.name.replace(/^[^!]*!/, '')));
  if (valid.length === 0) return formula;
  const pairs: { pattern: string; name: string }[] = [];
  for (const n of valid) {
    const display = n.name.includes('!') ? n.name.split('!').slice(1).join('!') : n.name;
    for (const spelling of refSpellings(n)) pairs.push({ pattern: spelling, name: display });
  }
  // Longest patterns first so "A1:A10" wins over "A1".
  pairs.sort((a, b) => b.pattern.length - a.pattern.length);
  const pattern = pairs.map((p) => escapeRegExp(p.pattern)).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_.$!])(?:${pattern})(?![A-Za-z0-9_(])`, 'g');
  const byPattern = new Map(pairs.map((p) => [p.pattern, p.name]));
  return splitLiterals(formula)
    .map((seg) =>
      seg.literal
        ? seg.text
        : seg.text.replace(re, (m) => byPattern.get(m) ?? m),
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Create from Selection
// ---------------------------------------------------------------------------

export interface SelectionLabel {
  /** Header text, e.g. "Total Sales". */
  label: string;
  /** The data range the label describes (excluding the label cell). */
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Sanitize a header label into a legal defined name. */
export function labelToName(label: string): string {
  let name = label
    .trim()
    .replace(/["']/g, '')
    .replace(/[^A-Za-z0-9_.]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) name = 'Name';
  if (/^[0-9]/.test(name)) name = `_${name}`;
  if (!isValidName(name)) name = `_${name}`;
  return name;
}

/**
 * Create from Selection: turn header labels into names over the adjacent
 * data ranges. The App supplies one SelectionLabel per header cell
 * (top-row headers → the column below; left-column headers → the row to
 * the right). Duplicate names are suffixed (_2, _3, …).
 */
export function createNamesFromSelection(sheet: string, labels: SelectionLabel[]): NamedRange[] {
  const used = new Set<string>();
  const out: NamedRange[] = [];
  for (const l of labels) {
    let name = labelToName(l.label);
    let candidate = name;
    let i = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${name}_${i++}`;
    used.add(candidate.toLowerCase());
    out.push({
      name: candidate,
      sheet,
      startRow: l.startRow,
      startCol: l.startCol,
      endRow: l.endRow,
      endCol: l.endCol,
    });
  }
  return out;
}

/** Re-export for consumers that only import this module. */
export { a1Range };
