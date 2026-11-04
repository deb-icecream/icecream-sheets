/**
 * Dynamic-array spill metadata (OOXML #69 item 3, audit §9.3).
 *
 * What Excel actually stores — and what this module models, nothing more:
 *
 * - A spill / array formula lives on its ANCHOR cell as
 *   `<f t="array" ref="A1:C3">FORMULA</f>`. `ref` is the stored spill
 *   extent (the range Excel last calculated into). Member cells of the
 *   extent carry cached `<v>` / `<is>` values only, never an `<f>`.
 * - OOXML stores NO separate "dynamic vs legacy-CSE" bit. A legacy
 *   Ctrl+Shift+Enter array formula and a modern dynamic-array formula
 *   (FILTER / SORT / SEQUENCE / ...) are stored identically: anchor
 *   `<f t="array" ref="...">` + cached member values. `kind` here is
 *   therefore a SEMANTIC classification (does the formula call a function
 *   that inherently returns a variable-size array?), not a stored flag —
 *   and parse → write → re-parse is an identity on formula + ref +
 *   cached values regardless of `kind`.
 * - The spill operator is `A1#` (optionally sheet-qualified and/or
 *   `$`-absolute): a formula elsewhere that references the WHOLE spill
 *   range of anchor A1. Those occurrences are parsed separately as
 *   `SpillRef` records, because they are references TO a spill, not
 *   spills themselves.
 *
 * What this module does NOT do (Phase 2 / follow-up, see REPORT.md):
 * it does not wire into `adapter.ts` / the fast sheet parser, does not
 * change what the engine calculates, and does not implement `#SPILL!`
 * blocking semantics. The engine today emulates spills by writing static
 * neighbour values (`packages/engine/src/dynamic-arrays.ts`
 * `toSpillWrites`); turning a parsed `SpillRange` into live engine
 * behaviour is the follow-up spec, not this module.
 *
 * Never throws: a missing/corrupt part or cell yields fewer entries,
 * never an error. Parse is best-effort per cell; write returns the input
 * XML unchanged for the spill it cannot apply.
 */

import { escapeXmlAttr, escapeXmlText, parseAttrRecord, unescapeXmlText } from './nativeXmlUtil.js';

// ---------------------------------------------------------------------------
// A1 helpers (local, so this module stays self-contained and browser-safe).
// Rows/cols are 0-based everywhere in the model; A1 refs are 1-based text.
// ---------------------------------------------------------------------------

/** 0-based column index → letters, e.g. 0 → "A", 27 → "AB". */
export function colLetters(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Letters → 0-based column index, or null when not letters. */
export function lettersToCol(letters: string): number | null {
  if (!/^[A-Za-z]+$/.test(letters)) return null;
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

/** 0-based (row, col) → A1 ref, e.g. (0, 0) → "A1". */
export function a1Ref(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`;
}

/** Parse an A1 ref (optional `$`s, optional sheet prefix) → 0-based coords. */
export function parseA1Ref(ref: string): { row: number; col: number } | null {
  if (typeof ref !== 'string') return null;
  let text = ref.trim();
  // Strip a sheet prefix: 'Sheet 1'!A1 or Sheet1!A1 (last '!' wins).
  const bang = text.lastIndexOf('!');
  if (bang !== -1) text = text.slice(bang + 1);
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(text);
  if (!m) return null;
  const col = lettersToCol(m[1] as string);
  const row = Number(m[2]) - 1;
  if (col === null || !Number.isInteger(row) || row < 0 || col < 0 || col > 16383 || row > 1048575) return null;
  return { row, col };
}

/** Parse an A1 range ("A1:C3" or a single "A1") → 0-based inclusive bounds. */
export function parseRangeRef(ref: string): { sr: number; sc: number; er: number; ec: number } | null {
  if (typeof ref !== 'string') return null;
  const parts = ref.split(':');
  if (parts.length === 1) {
    const one = parseA1Ref(parts[0] as string);
    return one ? { sr: one.row, sc: one.col, er: one.row, ec: one.col } : null;
  }
  if (parts.length !== 2) return null;
  const a = parseA1Ref(parts[0] as string);
  const b = parseA1Ref(parts[1] as string);
  if (!a || !b) return null;
  return {
    sr: Math.min(a.row, b.row),
    sc: Math.min(a.col, b.col),
    er: Math.max(a.row, b.row),
    ec: Math.max(a.col, b.col),
  };
}

/** Normalised range text for bounds: single cell → "A1", else "A1:C3". */
export function rangeRefText(sr: number, sc: number, er: number, ec: number): string {
  const a = a1Ref(sr, sc);
  return sr === er && sc === ec ? a : `${a}:${a1Ref(er, ec)}`;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** A cached spill-member value: number, string (incl. error literals and
 *  formula-string results), boolean, or null when the file stored no
 *  cached value for that member. */
export type SpillCachedValue = number | string | boolean | null;

/** Semantic classification — see the header: NOT a stored OOXML flag. */
export type SpillKind = 'dynamic' | 'legacy';

export interface SpillCellRef {
  row: number;
  col: number;
  /** A1 text, e.g. "B2". */
  ref: string;
}

/**
 * One spill range as stored in the file: the anchor formula plus the
 * stored extent plus the file's cached values for every cell of the
 * extent (anchor first, row-major). `cachedValues` is always exactly
 * (endRow - startRow + 1) × (endCol - startCol + 1); a member the file
 * did not store a value for is null, never omitted.
 */
export interface SpillRange {
  anchor: SpillCellRef;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Stored extent text, e.g. "A1:C3" (single cell: "A1"). */
  ref: string;
  /** Formula text as stored in `<f>`, WITHOUT a leading `=`. */
  formula: string;
  kind: SpillKind;
  cachedValues: SpillCachedValue[][];
}

/** One occurrence of the spill operator (`A1#`) inside some formula. */
export interface SpillRef {
  /** The anchor whose spill range is referenced. */
  anchor: SpillCellRef;
  /** Sheet qualifier as written (unquoted), when the ref had one. */
  sheet?: string;
  /** The matched text as written, e.g. "'Data'!$A$1#". */
  text: string;
  /** Referencing cell (0-based), or -1 when parsed from a bare formula. */
  fromRow: number;
  fromCol: number;
}

export interface SheetSpills {
  spills: SpillRange[];
  spillRefs: SpillRef[];
}

/** Proposed Phase 2 metadata key prefix (`xlsx.spill.<sheetName>`); this
 *  module itself writes nothing to workbook metadata — the key is only
 *  named here so the Phase 2 wiring spec has one stable name to use. */
export const SPILL_METADATA_KEY_PREFIX = 'xlsx.spill.';

// ---------------------------------------------------------------------------
// Dynamic-array classification
// ---------------------------------------------------------------------------

/**
 * Functions introduced with / inherently returning variable-size dynamic
 * arrays. Any call to one of these (at any nesting depth, e.g.
 * `SUM(FILTER(...))` — the FILTER still spills) classifies the formula
 * as dynamic. Classic array functions (MMULT, TRANSPOSE, SUMPRODUCT,
 * FREQUENCY, ...) are deliberately NOT in this set: they predate dynamic
 * arrays and their stored form is identical, so they classify legacy —
 * with zero fidelity loss, since formula + ref round-trip exactly either
 * way. XLOOKUP is included: unlike VLOOKUP it returns a whole array
 * when its return range has multiple columns/rows.
 */
export const DYNAMIC_ARRAY_FUNCTIONS: readonly string[] = [
  'CHOOSEROWS',
  'CHOOSECOLS',
  'DROP',
  'EXPAND',
  'FILTER',
  'HSTACK',
  'RANDARRAY',
  'SEQUENCE',
  'SORT',
  'SORTBY',
  'TAKE',
  'TEXTAFTER',
  'TEXTBEFORE',
  'TEXTSPLIT',
  'TOCOL',
  'TOROW',
  'UNIQUE',
  'VSTACK',
  'WRAPCOLS',
  'WRAPROWS',
  'XLOOKUP',
];

/** Strip `_xlfn.` / `_xlws.` / `_xlpm.` future-function prefixes, as the
 *  fast sheet parser does, so classification sees bare function names. */
export function stripFutureFunctionPrefixes(formula: string): string {
  return formula.replace(/_xlfn\.(?:_xlws\.|_xlpm\.)?/g, '').replace(/_xlws\./g, '');
}

/**
 * Function names called by a formula (outside string literals and
 * single-quoted sheet names), upper-cased. A name counts only when
 * immediately followed by `(` (allowing whitespace).
 */
export function calledFunctions(formula: string): string[] {
  const out: string[] = [];
  const text = stripFutureFunctionPrefixes(formula);
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      // Double-quoted string literal: skip, honouring "" escapes.
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "'") {
      // Single-quoted sheet name: skip, honouring '' escapes.
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_.]/.test(text[j] as string)) j++;
      const name = text.slice(i, j);
      let k = j;
      while (k < text.length && /\s/.test(text[k] as string)) k++;
      if (text[k] === '(' && name !== '') out.push(name.toUpperCase());
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** True when the formula calls any function in DYNAMIC_ARRAY_FUNCTIONS. */
export function isDynamicArrayFormula(formula: string): boolean {
  if (typeof formula !== 'string' || formula === '') return false;
  const called = new Set(calledFunctions(formula));
  return DYNAMIC_ARRAY_FUNCTIONS.some((fn) => called.has(fn));
}

// ---------------------------------------------------------------------------
// Spill-operator (`#`) references
// ---------------------------------------------------------------------------

const SPILL_REF_RE =
  /(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!)?\$?([A-Za-z]{1,3})\$?(\d+)#/g;

/**
 * All spill-operator references in a formula. `fromRow`/`fromCol` name
 * the referencing cell, or -1 when the formula was parsed standalone.
 * String literals are blanked first so a `"A1#"` inside a literal is
 * never mistaken for a spill reference. Never throws.
 */
export function parseSpillRefsFromFormula(
  formula: string,
  fromRow = -1,
  fromCol = -1,
): SpillRef[] {
  const out: SpillRef[] = [];
  if (typeof formula !== 'string' || formula === '') return out;
  try {
    // Blank double-quoted literals (keep length so offsets stay stable,
    // though only the matched text is reported).
    let scrubbed = '';
    let inStr = false;
    for (let i = 0; i < formula.length; i++) {
      const ch = formula[i] as string;
      if (inStr) {
        if (ch === '"') {
          if (formula[i + 1] === '"') { scrubbed += '  '; i++; continue; }
          inStr = false;
        }
        scrubbed += ' ';
        continue;
      }
      if (ch === '"') { inStr = true; scrubbed += ' '; continue; }
      scrubbed += ch;
    }
    // The sheet prefix is optional in the regex, so a match must not
    // start in the middle of a longer name (e.g. the `OA1#` tail of
    // `FOOA1#` is not a ref): the char before the match must not be a
    // name char, `$`, or `.`.
    SPILL_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPILL_REF_RE.exec(scrubbed)) !== null) {
      const start = m.index;
      const prev = start > 0 ? (scrubbed[start - 1] as string) : '';
      if (/[A-Za-z0-9_.$]/.test(prev)) continue;
      const raw = m[0];
      const sheetGroup = m[1] !== undefined ? m[1] : m[2];
      const col = lettersToCol(m[3] as string);
      const row = Number(m[4]) - 1;
      if (col === null || !Number.isInteger(row) || row < 0 || col < 0) continue;
      const sheet = sheetGroup !== undefined
        ? (m[1] !== undefined ? sheetGroup.replace(/''/g, "'") : sheetGroup)
        : undefined;
      out.push({
        anchor: { row, col, ref: a1Ref(row, col) },
        ...(sheet !== undefined ? { sheet } : {}),
        text: formula.slice(start, start + raw.length),
        fromRow,
        fromCol,
      });
    }
    return out;
  } catch {
    return out;
  }
}

// ---------------------------------------------------------------------------
// Sheet-XML parsing
// ---------------------------------------------------------------------------

const EXCEL_ERROR_LITERALS = new Set([
  '#DIV/0!',
  '#GETTING_DATA',
  '#N/A',
  '#NAME?',
  '#NULL!',
  '#NUM!',
  '#REF!',
  '#VALUE!',
]);

interface RawCell {
  row: number;
  col: number;
  type: string;
  formulaText: string | null;
  formulaType: string;
  formulaRef: string | null;
  cached: SpillCachedValue;
}

/** Concatenate `<t>` runs of an `<is>` inline-string body. */
function inlineStrText(body: string): string {
  const start = body.indexOf('<is');
  const end = body.indexOf('</is>');
  if (start === -1 || end === -1) return '';
  const inner = body.slice(start, end + 5);
  const runs: string[] = [];
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) runs.push(unescapeXmlText(m[1] as string));
  return runs.join('');
}

/** `<v>` text of a cell body, or null when absent. */
function valueText(body: string): string | null {
  const m = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body);
  return m ? unescapeXmlText(m[1] as string) : null;
}

/** Cached value of a cell body under its `t` attribute. */
function cachedFromBody(
  type: string,
  body: string,
  sharedStrings?: readonly string[],
): SpillCachedValue {
  if (type === 'inlineStr') return inlineStrText(body);
  const raw = valueText(body);
  if (raw === null) return null;
  if (type === 's') {
    if (!sharedStrings) return null;
    const idx = Number(raw);
    const str = Number.isInteger(idx) ? sharedStrings[idx] : undefined;
    return str === undefined ? null : str;
  }
  if (type === 'b') return raw === '1' || raw.toLowerCase() === 'true';
  if (type === 'e' || type === 'str') return raw;
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) ? n : null;
}

/** Scan one worksheet XML string into raw cells (document order). */
function scanCells(xml: string, sharedStrings?: readonly string[]): RawCell[] {
  const cells: RawCell[] = [];
  const cellRe = /<c\b([^>]*)>/g;
  let cm: RegExpExecArray | null;
  while ((cm = cellRe.exec(xml)) !== null) {
    try {
      const attrText = cm[1] as string;
      const selfClosing = attrText.endsWith('/');
      const a = parseAttrRecord(attrText);
      if (!a.r) continue;
      const rc = parseA1Ref(a.r);
      if (!rc) continue;
      if (selfClosing) {
        cells.push({
          row: rc.row, col: rc.col, type: a.t ?? '',
          formulaText: null, formulaType: '', formulaRef: null, cached: null,
        });
        continue;
      }
      const closeIdx = xml.indexOf('</c>', cellRe.lastIndex);
      if (closeIdx === -1) break;
      const body = xml.slice(cellRe.lastIndex, closeIdx);
      cellRe.lastIndex = closeIdx + 4;
      let formulaText: string | null = null;
      let formulaType = '';
      let formulaRef: string | null = null;
      const fi = body.indexOf('<f');
      if (fi !== -1 && (body[fi + 2] === ' ' || body[fi + 2] === '>' || body[fi + 2] === '/')) {
        const fGt = body.indexOf('>', fi);
        if (fGt !== -1) {
          const fAttrText = body.slice(fi + 2, fGt);
          const fSelfClosing = fAttrText.endsWith('/');
          const fa = parseAttrRecord(fAttrText);
          formulaType = fa.t ?? '';
          formulaRef = fa.ref ?? null;
          if (!fSelfClosing) {
            const fClose = body.indexOf('</f>', fGt);
            if (fClose !== -1) {
              formulaText = unescapeXmlText(body.slice(fGt + 1, fClose))
                .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
              formulaText = stripFutureFunctionPrefixes(formulaText);
            }
          }
        }
      }
      cells.push({
        row: rc.row, col: rc.col, type: a.t ?? '',
        formulaText, formulaType, formulaRef,
        cached: cachedFromBody(a.t ?? '', body, sharedStrings),
      });
    } catch {
      continue; // One corrupt cell never aborts the sheet.
    }
  }
  return cells;
}

export interface ParseSheetSpillsOptions {
  /** Shared-string table, when the caller has one: only then can `t="s"`
   *  cached member values resolve to text (otherwise they read as null). */
  sharedStrings?: readonly string[];
}

/**
 * Parse every spill range (`<f t="array">` anchor) and every spill-operator
 * reference in one worksheet XML string. Never throws; corrupt cells are
 * skipped, corrupt input yields an empty result.
 */
export function parseSheetSpills(xml: string, opts: ParseSheetSpillsOptions = {}): SheetSpills {
  const empty: SheetSpills = { spills: [], spillRefs: [] };
  if (typeof xml !== 'string' || xml === '') return empty;
  try {
    const cells = scanCells(xml, opts.sharedStrings);
    const byKey = new Map<string, RawCell>();
    for (const c of cells) byKey.set(`${c.row}:${c.col}`, c);
    const spills: SpillRange[] = [];
    const spillRefs: SpillRef[] = [];
    for (const c of cells) {
      if (c.formulaText !== null && c.formulaText !== '') {
        spillRefs.push(...parseSpillRefsFromFormula(c.formulaText, c.row, c.col));
      }
      if (c.formulaType !== 'array' || c.formulaText === null || c.formulaText === '') continue;
      const bounds = c.formulaRef ? parseRangeRef(c.formulaRef) : null;
      const sr = bounds ? bounds.sr : c.row;
      const sc = bounds ? bounds.sc : c.col;
      const er = bounds ? bounds.er : c.row;
      const ec = bounds ? bounds.ec : c.col;
      // The stored ref wins even when it does not contain the anchor
      // (corrupt file): dropping the spill would lose the formula.
      const cachedValues: SpillCachedValue[][] = [];
      for (let r = sr; r <= er; r++) {
        const rowVals: SpillCachedValue[] = [];
        for (let col = sc; col <= ec; col++) {
          rowVals.push(byKey.get(`${r}:${col}`)?.cached ?? null);
        }
        cachedValues.push(rowVals);
      }
      spills.push({
        anchor: { row: c.row, col: c.col, ref: a1Ref(c.row, c.col) },
        startRow: sr,
        startCol: sc,
        endRow: er,
        endCol: ec,
        ref: rangeRefText(sr, sc, er, ec),
        formula: c.formulaText,
        kind: isDynamicArrayFormula(c.formulaText) ? 'dynamic' : 'legacy',
        cachedValues,
      });
    }
    spills.sort((a, b) => a.anchor.row - b.anchor.row || a.anchor.col - b.anchor.col);
    return { spills, spillRefs };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** `<f t="array" ref="...">FORMULA</f>` for a spill range. */
export function spillFormulaXml(spill: SpillRange): string {
  return `<f t="array" ref="${escapeXmlAttr(spill.ref)}">${escapeXmlText(spill.formula)}</f>`;
}

/** `t` attribute for a cached value, or '' when the value needs none. */
function cachedTypeAttr(value: SpillCachedValue): string {
  if (typeof value === 'boolean') return ' t="b"';
  if (typeof value === 'string') return ` t="${EXCEL_ERROR_LITERALS.has(value) ? 'e' : 'str'}"`;
  return '';
}

/** `<v>` body for a cached value (null → ''). */
function cachedValueXml(value: SpillCachedValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return `<v>${value ? '1' : '0'}</v>`;
  if (typeof value === 'string') return `<v>${escapeXmlText(value)}</v>`;
  return `<v>${String(value)}</v>`;
}

/** Full `<c>` element for one cell of a spill (anchor or member). */
export function spillCellXml(
  spill: SpillRange,
  row: number,
  col: number,
  value: SpillCachedValue,
): string {
  const ref = a1Ref(row, col);
  if (row === spill.anchor.row && col === spill.anchor.col) {
    return `<c r="${ref}"${cachedTypeAttr(value)}>${spillFormulaXml(spill)}${cachedValueXml(value)}</c>`;
  }
  return `<c r="${ref}"${cachedTypeAttr(value)}>${cachedValueXml(value)}</c>`;
}

/**
 * Complete `<c>` elements for a spill: the anchor (formula + cached
 * anchor value) plus one member cell per NON-null cached value. Null
 * members are omitted — re-parsing the generated cells yields the same
 * cachedValues (absent member = null). The caller splices these into a
 * sheet, or uses `applySpillsToSheetXml` to do it.
 */
export function spillCellsXml(spill: SpillRange): string[] {
  const out: string[] = [];
  for (let r = spill.startRow; r <= spill.endRow; r++) {
    for (let c = spill.startCol; c <= spill.endCol; c++) {
      const v = spill.cachedValues[r - spill.startRow]?.[c - spill.startCol] ?? null;
      if (r === spill.anchor.row && c === spill.anchor.col) {
        out.push(spillCellXml(spill, r, c, v));
      } else if (v !== null) {
        out.push(spillCellXml(spill, r, c, v));
      }
    }
  }
  return out;
}

/** True when (row, col) lies inside the spill extent (anchor included). */
export function spillContains(spill: SpillRange, row: number, col: number): boolean {
  return row >= spill.startRow && row <= spill.endRow && col >= spill.startCol && col <= spill.endCol;
}

/** Number of cells in the spill extent. */
export function spillCellCount(spill: SpillRange): number {
  return (spill.endRow - spill.startRow + 1) * (spill.endCol - spill.startCol + 1);
}

/** Deep equality of two spill-range lists (order matters; both are
 *  anchor-sorted by `parseSheetSpills`). */
export function spillsEqual(a: SpillRange[], b: SpillRange[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as SpillRange;
    const y = b[i] as SpillRange;
    if (
      x.anchor.row !== y.anchor.row || x.anchor.col !== y.anchor.col ||
      x.startRow !== y.startRow || x.startCol !== y.startCol ||
      x.endRow !== y.endRow || x.endCol !== y.endCol ||
      x.ref !== y.ref || x.formula !== y.formula || x.kind !== y.kind
    ) return false;
    if (x.cachedValues.length !== y.cachedValues.length) return false;
    for (let r = 0; r < x.cachedValues.length; r++) {
      const xr = x.cachedValues[r] as SpillCachedValue[];
      const yr = y.cachedValues[r] as SpillCachedValue[];
      if (xr.length !== yr.length) return false;
      for (let c = 0; c < xr.length; c++) if (xr[c] !== yr[c]) return false;
    }
  }
  return true;
}

// --- applySpillsToSheetXml internals ---------------------------------------

interface FoundCell {
  start: number;
  end: number;
  attrs: string;
  body: string | null; // null = self-closing
}

function findCell(xml: string, ref: string): FoundCell | null {
  const re = new RegExp(`<c\\b([^>]*?\\br="${ref}"[^>]*)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrText = m[1] as string;
    // The regex already anchors on r="ref"; a cell whose r attribute
    // merely contains the text (impossible: r is a single ref) is fine.
    const start = m.index;
    const tagEnd = start + m[0].length;
    if (attrText.endsWith('/')) return { start, end: tagEnd, attrs: attrText, body: null };
    const closeIdx = xml.indexOf('</c>', tagEnd);
    if (closeIdx === -1) return null;
    return { start, end: closeIdx + 4, attrs: attrText, body: xml.slice(tagEnd, closeIdx) };
  }
  return null;
}

/** Replace the `t="..."` attribute of a `<c>` attr string, or add one. */
function setCellTypeAttr(attrs: string, value: SpillCachedValue): string {
  const stripped = attrs.replace(/\s+t="[^"]*"/, '');
  const t = cachedTypeAttr(value);
  return t === '' ? stripped : `${stripped}${t}`;
}

/** Strip any `<f>`, `<v>`, `<is>` elements from a cell body. */
function stripCellValueElements(body: string): string {
  return body
    .replace(/<f\b[^>]*>([\s\S]*?)<\/f>/g, '')
    .replace(/<f\b[^/]*\/>/g, '')
    .replace(/<v\b[^>]*>([\s\S]*?)<\/v>/g, '')
    .replace(/<is\b[^>]*>[\s\S]*?<\/is>/g, '');
}

/** Insert `cellXml` into row `row` of `xml` (column order), creating the
 *  row inside `<sheetData>` when missing. Returns null when there is no
 *  `<sheetData>` to insert into. */
function insertCellIntoSheet(xml: string, row: number, col: number, cellXml: string): string | null {
  const sheetData = xml.indexOf('<sheetData');
  if (sheetData === -1) return null;
  const sdGt = xml.indexOf('>', sheetData);
  if (sdGt === -1) return null;
  // Find the row element.
  const rowRe = new RegExp(`<row\\b([^>]*?\\br="${row + 1}"[^>]*)>`, 'g');
  const rm = rowRe.exec(xml.slice(sdGt));
  if (rm) {
    const rowStart = sdGt + rm.index;
    const rowTagEnd = rowStart + rm[0].length;
    const rowAttrs = rm[1] as string;
    if (rowAttrs.endsWith('/')) {
      // Self-closing row: expand it around the new cell.
      const open = xml.slice(0, rowTagEnd - 2).replace(/\s*\/$/, '');
      return `${open}>${cellXml}</row>${xml.slice(rowTagEnd)}`;
    }
    const rowClose = xml.indexOf('</row>', rowTagEnd);
    if (rowClose === -1) return null;
    const rowBody = xml.slice(rowTagEnd, rowClose);
    // Insert before the first cell with a larger column, else at row end.
    const cellRe = /<c\b[^>]*?\br="([A-Za-z]+[0-9]+)"[^>]*>/g;
    let insertAt = rowClose;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowBody)) !== null) {
      const rc = parseA1Ref(cm[1] as string);
      if (rc && rc.col > col) { insertAt = rowTagEnd + cm.index; break; }
    }
    return `${xml.slice(0, insertAt)}${cellXml}${xml.slice(insertAt)}`;
  }
  // No such row: create it before the first row with a larger r, else
  // before </sheetData>.
  const newRow = `<row r="${row + 1}">${cellXml}</row>`;
  const allRowRe = /<row\b[^>]*?\br="(\d+)"[^>]*>/g;
  let am: RegExpExecArray | null;
  let insertAt: number | null = null;
  const sdSlice = xml.slice(sdGt);
  while ((am = allRowRe.exec(sdSlice)) !== null) {
    if (Number(am[1]) > row + 1) { insertAt = sdGt + am.index; break; }
  }
  if (insertAt === null) {
    const sdClose = xml.indexOf('</sheetData>', sdGt);
    if (sdClose === -1) return null;
    insertAt = sdClose;
  }
  return `${xml.slice(0, insertAt)}${newRow}${xml.slice(insertAt)}`;
}

/**
 * Apply spill ranges to a worksheet XML string in place: each anchor's
 * `<f>` becomes `<f t="array" ref="...">`, and every member cell of the
 * extent is rewritten to exactly the model's cached value (null members
 * are emptied, not deleted — styles on the `<c>` tag survive). Cells
 * that do not exist yet are inserted in row/column order. Never throws:
 * a spill that cannot be applied is skipped and the other spills still
 * apply; a pathological extent (>100,000 cells) gets its anchor written
 * but its member surgery skipped, to bound the work.
 */
export function applySpillsToSheetXml(xml: string, spills: SpillRange[]): string {
  if (typeof xml !== 'string' || xml === '' || !Array.isArray(spills) || spills.length === 0) return xml;
  let out = xml;
  try {
    for (const spill of spills) {
      try {
        const anchorRef = a1Ref(spill.anchor.row, spill.anchor.col);
        const anchorVal = spill.cachedValues[spill.anchor.row - spill.startRow]?.[spill.anchor.col - spill.startCol] ?? null;
        const found = findCell(out, anchorRef);
        if (found) {
          const attrs = setCellTypeAttr(found.attrs.replace(/\s*\/$/, ''), anchorVal);
          let body = found.body ?? '';
          body = stripCellValueElements(body);
          const vXml = cachedValueXml(anchorVal);
          const newCell = `<c ${attrs.trim()}>${spillFormulaXml(spill)}${vXml}</c>`;
          // Preserve a self-closing original's tag shape only when the
          // new cell is empty (never: an anchor always has a formula).
          void body;
          out = out.slice(0, found.start) + newCell + out.slice(found.end);
        } else {
          const inserted = insertCellIntoSheet(out, spill.anchor.row, spill.anchor.col, spillCellXml(spill, spill.anchor.row, spill.anchor.col, anchorVal));
          if (inserted !== null) out = inserted;
        }
        if (spillCellCount(spill) > 100_000) continue; // Anchor done; members skipped (see header).
        for (let r = spill.startRow; r <= spill.endRow; r++) {
          for (let c = spill.startCol; c <= spill.endCol; c++) {
            if (r === spill.anchor.row && c === spill.anchor.col) continue;
            const v = spill.cachedValues[r - spill.startRow]?.[c - spill.startCol] ?? null;
            const ref = a1Ref(r, c);
            const f = findCell(out, ref);
            if (f) {
              const attrs = setCellTypeAttr(f.attrs.replace(/\s*\/$/, ''), v);
              const newCell = `<c ${attrs.trim()}>${cachedValueXml(v)}</c>`;
              out = out.slice(0, f.start) + newCell + out.slice(f.end);
            } else if (v !== null) {
              const inserted = insertCellIntoSheet(out, r, c, spillCellXml(spill, r, c, v));
              if (inserted !== null) out = inserted;
            }
          }
        }
      } catch {
        continue; // One unappliable spill never aborts the rest.
      }
    }
    return out;
  } catch {
    return xml;
  }
}
