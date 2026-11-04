/**
 * Fast worksheet-XML parser — the sheet-level split point for server-side
 * parallel parse + progressive streaming (Cycle 10 Phase 4).
 *
 * SheetJS's `XLSX.read` is a single monolithic call: it unzips the package
 * and parses every sheet, the shared-string table and the style table on
 * one thread, so a workbook's sheets can never be fanned out from it.
 * The ZIP parts, however, ARE independent: after one unzip, each
 * `xl/worksheets/sheetN.xml` can be parsed on its own — in parallel worker
 * threads on the server — given only the two shared inputs every sheet
 * needs (the shared-string table and the style-index → format-code map).
 * This module is that per-sheet parser. It is pure and runtime-agnostic
 * (no Node imports) so the exact same function runs on the main thread
 * for a single-sheet workbook and inside `node:worker_threads` workers
 * for multi-sheet workbooks — the code path is identical either way.
 *
 * Streaming: with `opts.onChunk`, dense row chunks are emitted DURING the
 * scan — the first chunk (the visible window) leaves as soon as its rows
 * are parsed, long before the rest of the sheet. This is safe because
 * worksheet cells arrive in document (row-major) order and the two
 * constructs that rewrite earlier cells are resolved at encounter time:
 * shared-formula slaves translate from their master (which precedes them
 * in the shared range), and legacy array-formula members are nulled when
 * met (their anchor precedes them). If a hand-written file violates
 * document order (a slave whose master has not appeared yet), chunking
 * for that sheet is abandoned (`chunkingBroken`) and the caller falls
 * back to the authoritative whole-sheet result — chunks already emitted
 * are always a correct prefix.
 *
 * Output equals the `SheetData` shape `worksheetToRows` in adapter.ts
 * produces from a SheetJS worksheet (dense A1-based rows, per-cell
 * format codes, dimension hints), validated by differential tests
 * against the SheetJS path over the real-world corpus. Anything this
 * parser does not understand throws `FastParseUnsupported`, and the
 * caller falls back to the SheetJS read — correctness never depends on
 * the fast path succeeding.
 */
import type { CellInput, SheetData } from '@icecream-sheets/engine';
import { decodeRef, translateSharedFormula } from './formulaRecovery.js';
import { stripFuturePrefixes } from './futureFunctions.js';
import { GENERAL_FORMAT_CODE } from './numfmt.js';
import {
  a1Ref as spillA1Ref,
  isDynamicArrayFormula,
  parseSpillRefsFromFormula,
  rangeRefText as spillRangeRefText,
  type SheetSpills,
  type SpillCachedValue,
  type SpillRange,
  type SpillRef,
} from './spillMetadata.js';

/** Raised for any construct the fast parser does not model. Caller falls back. */
export class FastParseUnsupported extends Error {
  constructor(reason: string) {
    super(`fast sheet parse unsupported: ${reason}`);
    this.name = 'FastParseUnsupported';
  }
}

/* ------------------------------------------------------------------ */
/* XML text helpers                                                    */
/* ------------------------------------------------------------------ */

const ENTITY_MAP: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

/** Single-pass XML entity decode (named + decimal + hex numeric refs). */
export function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    return ENTITY_MAP[body] ?? whole;
  });
}

/**
 * Extract the text of an element body: CDATA verbatim, otherwise
 * entity-decoded with XML §2.11 end-of-line handling applied first:
 * a literal CR LF or lone CR in the source becomes LF. This mirrors
 * the formula path below (which already normalizes the same way) and
 * SheetJS's own parser, so the fast path and the SheetJS path produce
 * identical strings for the same bytes. Without it, a shared string
 * ending in a literal CR LF (as Excel writes multi-line cell text)
 * parses to "…\r\n" here but "…\n" via SheetJS — and the rehydrate
 * checksum then mismatches the checkpoint checksum for a file that
 * was never edited (issue #113). Normalization runs BEFORE entity
 * decoding, so a character reference (&#13;) still yields a real CR,
 * exactly as the XML spec requires. CDATA keeps its verbatim return:
 * Excel never emits CDATA in shared strings, and its line endings
 * are out of this fix's scope.
 */
function elementText(raw: string): string {
  if (raw.startsWith('<![CDATA[') && raw.endsWith(']]>')) return raw.slice(9, -3);
  return decodeXmlEntities(raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}

/**
 * Parse a tag's attribute text into a plain record in ONE pass — the
 * cell scan runs this per cell, so per-attribute regex construction
 * (millions of RegExp objects on a big sheet) is not acceptable.
 */
function parseAttrs(attrText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) out[m[1] as string] = decodeXmlEntities(m[2] as string);
  if (Object.keys(out).length === 0 && attrText.includes("'")) {
    const reSq = /([A-Za-z_:][\w:.-]*)\s*=\s*'([^']*)'/g;
    while ((m = reSq.exec(attrText)) !== null) out[m[1] as string] = decodeXmlEntities(m[2] as string);
  }
  return out;
}

/**
 * Concatenate all `<t>` run texts inside a fragment (shared-string item or
 * inline string), skipping phonetic-guide runs (`<rPh>…</rPh>`), exactly
 * like SheetJS's rich-text flattening.
 */
function concatTextRuns(fragment: string): string {
  const noPhonetic = fragment.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = tRe.exec(noPhonetic)) !== null) out += elementText(m[1] as string);
  if (out === '' && !/<t\b/.test(noPhonetic)) {
    const bare = noPhonetic.replace(/<[^>]+>/g, '');
    if (bare.trim() !== '') out = elementText(bare);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Shared inputs                                                       */
/* ------------------------------------------------------------------ */

/** Parse xl/sharedStrings.xml into the plain string table. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) out.push(concatTextRuns(m[1] as string));
  return out;
}

/**
 * Parse xl/styles.xml into a per-style-index format-code table:
 * `cellXfs[i]` → numFmtId → code, where the code for a built-in id comes
 * from the same SSF table SheetJS resolves `cell.z` through, and custom
 * ids come from the file's own `<numFmts>` entries. General is kept as
 * 'General' (callers skip it, mirroring cellFormatCode).
 */
export function parseStyleFormatCodes(stylesXml: string, builtinTable: Record<number, string>): string[] {
  const custom = new Map<number, string>();
  // Scope to the canonical <numFmts> block: styles.xml also carries <numFmt>
  // elements inside <dxfs> (conditional-formatting variants that REUSE the
  // same ids with different format codes). SheetJS ignores those when
  // resolving cell formats; scanning the whole document would let dxf
  // entries overwrite the real table.
  const nfBlock = /<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/.exec(stylesXml);
  const nfRe = /<numFmt\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  if (nfBlock) {
    while ((m = nfRe.exec(nfBlock[1] as string)) !== null) {
      const a = parseAttrs(m[1] as string);
      if (a.numFmtId !== undefined && a.formatCode !== undefined) custom.set(Number(a.numFmtId), a.formatCode);
    }
  }
  const codes: string[] = [];
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!xfs) return codes;
  const xfRe = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
  while ((m = xfRe.exec(xfs[1] as string)) !== null) {
    const a = parseAttrs(m[1] as string);
    const id = a.numFmtId === undefined ? 0 : Number(a.numFmtId);
    codes.push(custom.get(id) ?? builtinTable[id] ?? GENERAL_FORMAT_CODE);
  }
  return codes;
}

/**
 * The built-in numFmtId → format-code table. Resolved from SheetJS's SSF
 * module — the identical table `XLSX.read(..., {cellNF:true})` resolves
 * `cell.z` through, so fast-parse formats can never disagree with the
 * SheetJS path about what a built-in id means.
 */
export function builtinFormatTable(): Record<number, string> {
  return BUILTIN_FORMAT_TABLE;
}
let BUILTIN_FORMAT_TABLE: Record<number, string> = { 0: GENERAL_FORMAT_CODE };

/** Inject the SSF table (adapter.ts wires this from the xlsx module at load). */
export function setBuiltinFormatTable(table: Record<number, string>): void {
  BUILTIN_FORMAT_TABLE = table;
}

/* ------------------------------------------------------------------ */
/* Workbook structure                                                  */
/* ------------------------------------------------------------------ */

export interface WorkbookSheetPart {
  name: string;
  /** Zip path of the worksheet part; null for chartsheets (no cell data). */
  path: string | null;
  /** Relationship type suffix ('worksheet' | 'chartsheet' | other). */
  kind: string;
}

/** Sheet names in workbook order + their part paths, from workbook.xml + rels. */
export function parseWorkbookSheetParts(workbookXml: string, relsXml: string): WorkbookSheetPart[] {
  const targetByRid = new Map<string, { target: string; kind: string }>();
  for (const tag of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const a = parseAttrs(tag);
    if (!a.Id || !a.Target) continue;
    const kind = (a.Type ?? '').split('/').pop() ?? '';
    let path = a.Target;
    if (path.startsWith('/')) path = path.slice(1);
    else if (!path.startsWith('xl/')) path = `xl/${path}`;
    targetByRid.set(a.Id, { target: path, kind });
  }
  const out: WorkbookSheetPart[] = [];
  for (const tag of workbookXml.match(/<sheet\b[^>]*>/g) ?? []) {
    const a = parseAttrs(tag);
    if (!a.name || !a['r:id']) continue;
    const rel = targetByRid.get(a['r:id']);
    if (!rel) continue;
    out.push({ name: a.name, path: rel.kind === 'worksheet' ? rel.target : null, kind: rel.kind });
  }
  return out;
}

export interface FastDefinedName {
  name: string;
  ref: string;
  sheet?: number;
}

/** Defined names from workbook.xml `<definedNames>` (SheetJS Workbook.Names shape). */
export function parseDefinedNames(workbookXml: string): FastDefinedName[] {
  const out: FastDefinedName[] = [];
  const block = /<definedNames\b[^>]*>([\s\S]*?)<\/definedNames>/.exec(workbookXml);
  if (!block) return out;
  const dnRe = /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g;
  let m: RegExpExecArray | null;
  while ((m = dnRe.exec(block[1] as string)) !== null) {
    const a = parseAttrs(m[1] as string);
    if (!a.name) continue;
    // Defined-name refs are formulas too: strip _xlfn storage prefixes
    // (a LAMBDA name must reach the engine as LAMBDA(x,…) bare).
    const entry: FastDefinedName = { name: a.name, ref: stripFuturePrefixes(elementText((m[2] as string).trim())) };
    if (a.localSheetId !== undefined && Number.isInteger(Number(a.localSheetId))) entry.sheet = Number(a.localSheetId);
    out.push(entry);
  }
  return out;
}

/**
 * Decode OOXML `_xHHHH_` escapes (HHHH = hex UTF-16 code unit). SheetJS
 * escapes characters that cannot appear raw in a custom-property value
 * this way on write (notably `"` → `_x0022_`) and decodes them on read
 * (its unescapexml applies the same regex); Excel uses the same
 * convention. Without this decode, JSON-carried app metadata arrives
 * still-escaped, JSON.parse in extractZipMetadata fails, and the
 * property is silently dropped — the fast parse lost e.g.
 * `icecream.pagesetup.<sheet>` values the SheetJS read preserves.
 * Single pass: `_x005F_` (an escaped underscore) decodes first and the
 * following text is not re-scanned, so a literal `_x0022_` in the source
 * value survives as-is.
 */
function decodeControlEscapes(s: string): string {
  if (!s.includes('_x')) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** Custom document properties (docProps/custom.xml) as a flat string record. */
export function parseCustomProperties(customXml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const propRe = /<property\b([^>]*)>([\s\S]*?)<\/property>/g;
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(customXml)) !== null) {
    const a = parseAttrs(m[1] as string);
    if (!a.name) continue;
    const vt = /<vt:[a-zA-Z0-9]+\b[^>]*>([\s\S]*?)<\/vt:[a-zA-Z0-9]+>/.exec(m[2] as string);
    if (vt) out[a.name] = decodeControlEscapes(elementText(vt[1] as string));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Dimension hints (raw — MDW conversion happens once, in order)       */
/* ------------------------------------------------------------------ */

export interface RawColDef {
  min: number; // 0-based first column
  max: number; // 0-based last column
  width: number | null;
  hidden: boolean;
}

export interface RawRowDef {
  index: number; // 0-based
  heightPt: number | null;
  hidden: boolean;
}

export interface FastSheetResult {
  rows: CellInput[][];
  formats: Record<string, string>;
  rawCols: RawColDef[];
  rawRows: RawRowDef[];
  /** True when in-scan chunking had to be abandoned (see header). */
  chunkingBroken: boolean;
  /**
   * Cached-value display rows (only when opts.display): for a formula
   * cell, the file's own cached result — what Excel would paint before
   * recalculating; for a value cell, the value itself. Formula cells
   * whose file carries NO cached result are null here and listed in
   * pendingCalc — never presented as a final blank/0.
   */
  displayRows: CellInput[][] | null;
  /** "row:col" refs of formula cells with no cached value in the file. */
  pendingCalc: string[];
  /** Count of non-empty input cells (load-progress numerator). */
  cellCount: number;
  /**
   * Spill ranges found in this sheet (Phase E piece C mirror): one entry
   * per <f t="array"> anchor — anchor formula, stored extent, cached
   * values (members recorded at encounter, before the member-nulling
   * below) — plus every `A1#` spill-operator reference in a formula.
   * The row grid still nulls members (the engine must not see them as
   * static inputs); this field is how the caller recovers the spill
   * model the rows deliberately drop, e.g. to stash it under
   * `xlsx.spill.<sheetName>` metadata. Members that precede their anchor
   * in document order (malformed files) read null: the nulling logic
   * itself assumes anchor-precedes-member (see the module header).
   */
  spills: SheetSpills;
}

/** One streamed row chunk: dense rows for [startRow, startRow+rows.length). */
export interface SheetRowChunk {
  startRow: number;
  rows: CellInput[][];
  /** Cached-value display rows for this chunk (null when display off). */
  displayRows: CellInput[][] | null;
  /** Format codes for cells in this chunk only ("row:col" → code). */
  formats: Record<string, string>;
  /** Formula cells in this chunk with no cached value ("row:col"). */
  pendingCalc: string[];
  /** Non-empty input cells in this chunk (progress numerator). */
  cellCount: number;
}

export interface ParseWorksheetOptions {
  /** Rows in the first emitted chunk (the visible window). Default 128. */
  firstChunkRows?: number;
  /** Rows in subsequent chunks. Default 4096. */
  chunkRows?: number;
  /** Called synchronously as row chunks complete during the scan. */
  onChunk?: (chunk: SheetRowChunk) => void;
  /** Also produce cached-value display rows + pendingCalc (streaming). */
  display?: boolean;
}

/* SheetJS MDW machinery (xlsx.mjs §18.3.1.13), replicated so the pixel
 * widths computed here match `worksheetDimensions` exactly. MDW is a
 * workbook-global that starts at DEF_MDW and is re-fit on the first
 * width-bearing <col> of each sheet (parse_ws_xml_cols' seencol flag). */
const DEF_MDW = 6;
const MAX_MDW = 15;
const MIN_MDW = 1;

export interface DimensionContext {
  mdw: number;
}
export function newDimensionContext(): DimensionContext {
  return { mdw: DEF_MDW };
}

function width2px(width: number, mdw: number): number {
  return Math.floor((width + Math.round(128 / mdw) / 256) * mdw);
}
function px2char(px: number, mdw: number): number {
  return Math.floor(((px - 5) / mdw) * 100 + 0.5) / 100;
}
function char2width(chr: number, mdw: number): number {
  return Math.round(((chr * mdw + 5) / mdw) * 256) / 256;
}
function cycleWidth(w: number, mdw: number): number {
  return char2width(px2char(width2px(w, mdw), mdw), mdw);
}
function findMdwColw(collw: number, current: number): number {
  let delta = Math.abs(collw - cycleWidth(collw, current));
  let best = current;
  if (delta > 0.005) {
    for (let cand = MIN_MDW; cand < MAX_MDW; cand++) {
      const d = Math.abs(collw - cycleWidth(collw, cand));
      if (d <= delta) {
        delta = d;
        best = cand;
      }
    }
  }
  return best;
}

/**
 * Convert one sheet's raw col/row defs into SheetData dimension hints,
 * replicating SheetJS `parse_ws_xml_cols` + adapter `worksheetDimensions`
 * (including its 1000-column / 5000-row caps and rounding). Sheets must
 * be converted in workbook order — MDW state carries across sheets,
 * exactly as it does inside one SheetJS read.
 */
export function convertDimensions(
  rawCols: RawColDef[],
  rawRows: RawRowDef[],
  ctx: DimensionContext,
): Pick<SheetData, 'colWidths' | 'rowHeights' | 'hiddenCols' | 'hiddenRows'> {
  let mdw = ctx.mdw;
  const cols: Array<{ wpx?: number; wch?: number; hidden?: boolean } | undefined> = [];
  let seencol = false;
  for (const def of rawCols) {
    const entry: { wpx?: number; wch?: number; hidden?: boolean } = {};
    if (def.width !== null && def.width !== 0 && !Number.isNaN(def.width)) {
      if (!seencol) {
        seencol = true;
        mdw = findMdwColw(def.width, mdw);
      }
      entry.wpx = width2px(def.width, mdw);
      entry.wch = px2char(entry.wpx, mdw);
    }
    if (def.hidden) entry.hidden = true;
    for (let i = def.min; i <= def.max; i++) cols[i] = { ...entry };
  }
  ctx.mdw = mdw;

  // Structural (not via SheetData) so this stays well-typed regardless of
  // the state of the engine dist import.
  const out: {
    colWidths?: Record<string, number>;
    rowHeights?: Record<string, number>;
    hiddenCols?: number[];
    hiddenRows?: number[];
  } = {};
  const widths: Record<string, number> = {};
  const hiddenCols: number[] = [];
  cols.forEach((c, i) => {
    if (!c || i >= 1000) return;
    const px =
      typeof c.wpx === 'number' && c.wpx > 0
        ? Math.round(c.wpx)
        : typeof c.wch === 'number' && c.wch > 0
          ? Math.round(c.wch * 7 + 5)
          : 0;
    if (px > 0) widths[String(i)] = px;
    if (c.hidden) hiddenCols.push(i);
  });
  if (Object.keys(widths).length > 0) out.colWidths = widths;
  if (hiddenCols.length > 0) out.hiddenCols = hiddenCols;

  const heights: Record<string, number> = {};
  const hiddenRows: number[] = [];
  for (const def of rawRows) {
    if (def.index >= 5000) continue;
    // rowHeights are CSS pixels everywhere downstream (the serializer
    // writes ht = px * 0.75), but the XML `ht` attribute is POINTS —
    // convert (1pt = 4/3 px at 96dpi). Storing the raw point value
    // made every height-carrying row 25% too short and clipped its
    // text, most visibly in the frozen top row (sweep F-9).
    if (def.heightPt !== null && def.heightPt > 0) heights[String(def.index)] = Math.round(def.heightPt * 4 / 3);
    if (def.hidden) hiddenRows.push(def.index);
  }
  if (Object.keys(heights).length > 0) out.rowHeights = heights;
  if (hiddenRows.length > 0) out.hiddenRows = hiddenRows;
  return out;
}

/* ------------------------------------------------------------------ */
/* The per-sheet parser                                                */
/* ------------------------------------------------------------------ */

interface PendingSharedSlave {
  r: number;
  c: number;
  si: string;
  styleIdx: number | null;
  cached: { has: boolean; value: CellInput };
}

/** Extract a cell's `<v>` text (indexOf-based; cell bodies are tiny). */
function valueText(body: string): string | null {
  const vi = body.indexOf('<v');
  if (vi === -1) return null;
  const gt = body.indexOf('>', vi);
  if (gt === -1) return null;
  if (body[gt - 1] === '/') return null; // self-closing <v/>: no value
  const close = body.indexOf('</v>', gt);
  if (close === -1) return null;
  return elementText(body.slice(gt + 1, close).trim());
}

/**
 * Parse one worksheet's XML into dense rows + formats + raw dimension
 * defs. Equivalent to adapter.ts `worksheetToRows` fed by SheetJS, plus
 * the formula-recovery pass (formulas without cached values and shared
 * -formula slaves are recovered inline — recovery is therefore skipped
 * by callers of this parser).
 */
export function parseWorksheetXml(
  xml: string,
  sharedStrings: readonly string[],
  styleFormatCodes: readonly string[],
  opts: ParseWorksheetOptions = {},
): FastSheetResult {
  let maxRow = -1;
  let maxCol = -1;

  const dim = /<dimension\b[^>]*\bref\s*=\s*"([^"]*)"/.exec(xml);
  if (dim) {
    for (const p of (dim[1] as string).split(':')) {
      const rc = decodeRef(p);
      if (rc) {
        if (rc.r > maxRow) maxRow = rc.r;
        if (rc.c > maxCol) maxCol = rc.c;
      }
    }
  }

  // <cols> section.
  const rawCols: RawColDef[] = [];
  const colsBlock = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml);
  if (colsBlock) {
    const colRe = /<col\b([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = colRe.exec(colsBlock[1] as string)) !== null) {
      const a = parseAttrs(m[1] as string);
      if (a.min === undefined || a.max === undefined) continue;
      rawCols.push({
        min: Number(a.min) - 1,
        max: Number(a.max) - 1,
        width: a.width === undefined ? null : Number(a.width),
        hidden: a.hidden === '1' || a.hidden === 'true',
      });
    }
  }

  // <row> defs (heights / hidden).
  const rawRows: RawRowDef[] = [];
  const rowTagRe = /<row\b([^>]*?)(?:\/>|>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowTagRe.exec(xml)) !== null) {
    const a = parseAttrs(rm[1] as string);
    if (a.r === undefined) continue;
    rawRows.push({
      index: Number(a.r) - 1,
      heightPt: a.ht === undefined ? null : Number(a.ht),
      hidden: a.hidden === '1' || a.hidden === 'true',
    });
  }

  // Dense rows, preallocated from <dimension> (the common case: writers
  // emit an accurate dimension, so cells write straight into place with
  // no sparse-map overhead). Stale dimensions extend on demand.
  const wantDisplay = opts.display === true;
  let colCount = maxCol + 1;
  const rows: CellInput[][] = [];
  const displayRows: CellInput[][] = [];
  const ensureRows = (r: number, c: number): void => {
    if (c >= colCount) {
      const next = c + 1;
      for (const row of rows) while (row.length < next) row.push(null);
      if (wantDisplay) for (const row of displayRows) while (row.length < next) row.push(null);
      colCount = next;
    }
    while (rows.length <= r) {
      rows.push(new Array<CellInput>(colCount).fill(null));
      if (wantDisplay) displayRows.push(new Array<CellInput>(colCount).fill(null));
    }
  };
  if (maxRow >= 0 && colCount > 0 && (maxRow + 1) * colCount <= 100_000_000) {
    for (let r = 0; r <= maxRow; r++) {
      rows.push(new Array<CellInput>(colCount).fill(null));
      if (wantDisplay) displayRows.push(new Array<CellInput>(colCount).fill(null));
    }
  }

  const formats: Record<string, string> = {};
  const masters = new Map<string, { row: number; col: number; text: string }>();
  const deferredSlaves: PendingSharedSlave[] = [];
  const arrayRanges: Array<{ sr: number; sc: number; er: number; ec: number; anchorR: number; anchorC: number }> = [];
  // Spill model collected during the scan (see FastSheetResult.spills).
  const spillRanges: SpillRange[] = [];
  const spillRefs: SpillRef[] = [];
  const toSpillCached = (v: CellInput | undefined): SpillCachedValue =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
  const recordSpillCell = (r: number, c: number, cached: SpillCachedValue): void => {
    for (const s of spillRanges) {
      if (r >= s.startRow && r <= s.endRow && c >= s.startCol && c <= s.endCol) {
        const row = s.cachedValues[r - s.startRow];
        if (row) row[c - s.startCol] = cached;
      }
    }
  };
  const collectSpillRefs = (formulaText: string, r: number, c: number): void => {
    try {
      spillRefs.push(...parseSpillRefsFromFormula(formulaText, r, c));
    } catch {
      // Spill-ref scanning must never break the sheet parse.
    }
  };

  // Chunked emission state.
  const onChunk = opts.onChunk;
  const firstChunkRows = opts.firstChunkRows ?? 128;
  const chunkRows = opts.chunkRows ?? 4096;
  let chunkingBroken = false;
  let chunkStart = 0;
  let chunkLimit = firstChunkRows;
  let chunkFormats: Record<string, string> = {};
  let chunkPending: string[] = [];
  let chunkCellCount = 0;
  let cellCount = 0;
  const pendingCalc: string[] = [];
  const flushChunk = (uptoRowExclusive: number): void => {
    if (!onChunk || chunkingBroken) return;
    if (uptoRowExclusive <= chunkStart) return;
    const slice = rows.slice(chunkStart, uptoRowExclusive);
    const displaySlice = wantDisplay ? displayRows.slice(chunkStart, uptoRowExclusive) : null;
    const fmts = chunkFormats;
    const pend = chunkPending;
    const cc = chunkCellCount;
    chunkFormats = {};
    chunkPending = [];
    chunkCellCount = 0;
    const start = chunkStart;
    chunkStart = uptoRowExclusive;
    chunkLimit = chunkStart + chunkRows;
    onChunk({ startRow: start, rows: slice, displayRows: displaySlice, formats: fmts, pendingCalc: pend, cellCount: cc });
  };

  const setCell = (
    r: number,
    c: number,
    input: CellInput,
    styleIdx: number | null,
    display: CellInput | undefined = undefined,
    pending = false,
  ): void => {
    ensureRows(r, c);
    const prev = (rows[r] as CellInput[])[c];
    (rows[r] as CellInput[])[c] = input;
    if (input !== null && (prev === null || prev === undefined)) {
      cellCount++;
      if (r >= chunkStart) chunkCellCount++;
    }
    if (wantDisplay) {
      (displayRows[r] as CellInput[])[c] = pending ? null : display === undefined ? input : display;
      if (pending) {
        pendingCalc.push(`${r}:${c}`);
        if (r >= chunkStart) chunkPending.push(`${r}:${c}`);
      }
    }
    if (input !== null && styleIdx !== null) {
      const code = styleFormatCodes[styleIdx];
      // "GENERAL" (ClosedXML spelling) is the same default as "General".
      if (code !== undefined && code.toLowerCase() !== 'general' && code !== GENERAL_FORMAT_CODE) {
        formats[`${r}:${c}`] = code;
        if (r >= chunkStart) chunkFormats[`${r}:${c}`] = code;
      }
    }
  };

  /**
   * The file-cached result of a formula cell, from its own body + type:
   * what Excel last calculated and stored. `has:false` when the writer
   * stored no cached value (e.g. openpyxl) — the cell is pending-calc.
   */
  const cachedFromBody = (cellType: string, body: string): { has: boolean; value: CellInput } => {
    if (cellType === 'inlineStr') {
      const isStart = body.indexOf('<is');
      const isEnd = body.indexOf('</is>');
      if (isStart !== -1 && isEnd !== -1) return { has: true, value: concatTextRuns(body.slice(isStart, isEnd + 5)) };
      return { has: false, value: null };
    }
    const raw = valueText(body);
    if (raw === null) return { has: false, value: null };
    if (cellType === 's') {
      const idx = Number(raw);
      const str = Number.isInteger(idx) ? sharedStrings[idx] : undefined;
      return str === undefined ? { has: false, value: null } : { has: true, value: str };
    }
    if (cellType === 'b') return { has: true, value: raw === '1' || raw.toLowerCase() === 'true' };
    if (cellType === 'e' || cellType === 'str') return { has: true, value: raw };
    const n = Number(raw);
    return raw !== '' && Number.isFinite(n) ? { has: true, value: n } : { has: false, value: null };
  };

  const cellRe = /<c\b([^>]*)>/g;
  let cm: RegExpExecArray | null;
  while ((cm = cellRe.exec(xml)) !== null) {
    const attrText = cm[1] as string;
    const selfClosing = attrText.endsWith('/');
    const a = parseAttrs(attrText);
    if (!a.r) throw new FastParseUnsupported('cell without r attribute');
    const rc = decodeRef(a.r);
    if (!rc) continue;
    if (rc.r > maxRow) maxRow = rc.r;
    if (rc.c > maxCol) maxCol = rc.c;
    // A new row beyond the current chunk limit completes that chunk.
    if (onChunk && !chunkingBroken && rc.r >= chunkLimit) flushChunk(rc.r);
    if (selfClosing) continue;
    const closeIdx = xml.indexOf('</c>', cellRe.lastIndex);
    if (closeIdx === -1) break;
    const body = xml.slice(cellRe.lastIndex, closeIdx);
    cellRe.lastIndex = closeIdx + 4;

    const t = a.t ?? '';
    const styleIdx = a.s === undefined ? null : Number(a.s);

    let input: CellInput = null;
    let handled = false;
    const fi = body.indexOf('<f');
    if (fi !== -1 && (body[fi + 2] === ' ' || body[fi + 2] === '>' || body[fi + 2] === '/')) {
      const fGt = body.indexOf('>', fi);
      if (fGt !== -1) {
        const fAttrText = body.slice(fi + 2, fGt);
        const fSelfClosing = fAttrText.endsWith('/');
        const fa = parseAttrs(fAttrText);
        let fText = '';
        if (!fSelfClosing) {
          const fClose = body.indexOf('</f>', fGt);
          // SheetJS parity: formula text is NOT trimmed (a leading space
          // after <f> survives into cell.f), but line endings are
          // normalized CRLF/CR → LF, and the `_xlfn.` future-function
          // prefix is stripped (SheetJS _xlfn(): replace(/_xlfn\./g,'')).
          // `_xlfn.` future-function prefixes are stripped — including
          // the `_xlfn._xlws.` dynamic-array form and `_xlfn._xlpm.`
          // LAMBDA-parameter form (audit §9.4: the engine works with
          // bare names and bare parameter names; the write side
          // re-adds the prefixes, see futureFunctions.ts).
          if (fClose !== -1) fText = elementText(body.slice(fGt + 1, fClose)).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/_xlfn\.(?:_xlws\.|_xlpm\.)?/g, '').replace(/_xlws\./g, '');
          // Spill-operator references ride the stored formula text (the
          // adapter path scans the same text per cell; shared-formula
          // slaves carry no text of their own, so their refs are covered
          // via the master's text, not re-recorded per slave).
          if (fText !== '') collectSpillRefs(fText, rc.r, rc.c);
        }
        const fType = fa.t ?? '';
        let formulaCached: { has: boolean; value: CellInput } | null = null;
        if (fType === 'shared') {
          if (fText !== '' && fa.si !== undefined) {
            masters.set(fa.si, { row: rc.r, col: rc.c, text: fText });
            input = `=${fText}`;
            formulaCached = cachedFromBody(t, body);
            handled = true;
          } else if (fa.si !== undefined) {
            const master = masters.get(fa.si);
            if (master) {
              input = `=${translateSharedFormula(master.text, rc.r - master.row, rc.c - master.col)}`;
              formulaCached = cachedFromBody(t, body);
            } else {
              // Master not seen yet (hand-written order violation):
              // defer, and stop streaming this sheet (see header).
              deferredSlaves.push({ r: rc.r, c: rc.c, si: fa.si, styleIdx, cached: cachedFromBody(t, body) });
              chunkingBroken = true;
              input = null;
            }
            handled = true;
          }
        } else if (fType === 'array') {
          if (fText !== '') {
            input = `=${fText}`;
            formulaCached = cachedFromBody(t, body);
            handled = true;
            if (fa.ref) {
              const parts = fa.ref.split(':');
              const aa = decodeRef(parts[0] as string);
              const bb = decodeRef(parts[parts.length - 1] as string);
              if (aa && bb) {
                arrayRanges.push({ sr: aa.r, sc: aa.c, er: bb.r, ec: bb.c, anchorR: rc.r, anchorC: rc.c });
                // Spill model (Phase E piece C mirror): the anchor's
                // formula + stored extent + cached values. Members are
                // filled in by recordSpillCell as they are encountered
                // below; the anchor's own cached value is known now.
                const matrix: SpillCachedValue[][] = [];
                for (let rr = aa.r; rr <= bb.r; rr++) matrix.push(new Array<SpillCachedValue>(bb.c - aa.c + 1).fill(null));
                const spill: SpillRange = {
                  anchor: { row: rc.r, col: rc.c, ref: spillA1Ref(rc.r, rc.c) },
                  startRow: aa.r,
                  startCol: aa.c,
                  endRow: bb.r,
                  endCol: bb.c,
                  ref: spillRangeRefText(aa.r, aa.c, bb.r, bb.c),
                  formula: fText,
                  kind: isDynamicArrayFormula(fText) ? 'dynamic' : 'legacy',
                  cachedValues: matrix,
                };
                spillRanges.push(spill);
                const ar = rc.r - aa.r;
                const ac = rc.c - aa.c;
                if (ar >= 0 && ar < matrix.length && ac >= 0 && ac < (matrix[ar]?.length ?? 0)) {
                  matrix[ar]![ac] = toSpillCached(formulaCached.has ? formulaCached.value : null);
                }
              }
            }
          }
        } else if (fType === '') {
          if (fText !== '') {
            input = `=${fText}`;
            formulaCached = cachedFromBody(t, body);
            handled = true;
          }
        } else {
          throw new FastParseUnsupported(`formula type "${fType}"`);
        }
        if (handled) {
          const cached = formulaCached ?? { has: false, value: null };
          setCell(rc.r, rc.c, input, styleIdx, cached.has ? cached.value : undefined, !cached.has);
          continue;
        }
        // Empty non-shared <f/> with a cached <v> (e.g. dataTable):
        // fall through and take the cached value, like SheetJS does.
      }
    }

    if (t === 's') {
      const raw = valueText(body);
      const idx = raw === null ? NaN : Number(raw);
      const str = Number.isInteger(idx) ? sharedStrings[idx] : undefined;
      if (str === undefined) throw new FastParseUnsupported('shared string index out of range');
      input = str.startsWith('=') && str.length > 1 ? `'${str}` : str;
    } else if (t === 'inlineStr') {
      const isStart = body.indexOf('<is');
      const isEnd = body.indexOf('</is>');
      const str = isStart !== -1 && isEnd !== -1 ? concatTextRuns(body.slice(isStart, isEnd + 5)) : '';
      input = str.startsWith('=') && str.length > 1 ? `'${str}` : str;
    } else if (t === 'b') {
      const raw = valueText(body) ?? '';
      input = raw === '1' || raw.toLowerCase() === 'true';
    } else if (t === 'e') {
      const raw = valueText(body) ?? '';
      input = raw !== '' ? raw : null;
    } else if (t === '' || t === 'n' || t === 'str') {
      const raw = valueText(body);
      if (raw !== null) {
        if (t === 'str') {
          input = raw.startsWith('=') && raw.length > 1 ? `'${raw}` : raw;
        } else {
          const n = Number(raw);
          input = raw !== '' && Number.isFinite(n) ? n : null;
        }
      }
    } else if (t === 'd') {
      throw new FastParseUnsupported('ISO date cell type t="d"');
    } else {
      throw new FastParseUnsupported(`cell type "${t}"`);
    }
    // Legacy array-formula member: nulled at encounter (anchor precedes
    // it) so an already-planned chunk never carries its cached value.
    // The spill model keeps the member's cached value (recorded first):
    // the rows drop it, the spills field preserves it.
    if (spillRanges.length > 0) {
      const cc = cachedFromBody(t, body);
      recordSpillCell(rc.r, rc.c, toSpillCached(cc.has ? cc.value : null));
    }
    if (input !== null && arrayRanges.length > 0) {
      for (const range of arrayRanges) {
        if (rc.r >= range.sr && rc.r <= range.er && rc.c >= range.sc && rc.c <= range.ec && !(rc.r === range.anchorR && rc.c === range.anchorC)) {
          input = null;
          break;
        }
      }
    }
    setCell(rc.r, rc.c, input, styleIdx);
  }

  // Deferred shared-formula slaves (order-violating files only).
  for (const slave of deferredSlaves) {
    const master = masters.get(slave.si);
    if (!master) throw new FastParseUnsupported(`shared formula si=${slave.si} has no master`);
    setCell(
      slave.r,
      slave.c,
      `=${translateSharedFormula(master.text, slave.r - master.row, slave.c - master.col)}`,
      slave.styleIdx,
      slave.cached.has ? slave.cached.value : undefined,
      !slave.cached.has,
    );
    if (spillRanges.length > 0) {
      recordSpillCell(slave.r, slave.c, toSpillCached(slave.cached.has ? slave.cached.value : null));
    }
  }

  // Final rows may be shorter than colCount when the dimension lied low
  // and ensureRows extended only some rows — normalize every row.
  for (const row of rows) while (row.length < colCount) row.push(null);
  if (wantDisplay) for (const row of displayRows) while (row.length < colCount) row.push(null);
  // Rows beyond the preallocation that were only ever dimension padding
  // when maxRow came from <dimension> but no cells reached it: rows.length
  // already equals maxRow+1 in that case; if cells stopped early and no
  // dimension existed, rows.length is exactly the last touched row + 1,
  // matching SheetJS's key-union range.
  if (onChunk && !chunkingBroken) flushChunk(rows.length);

  return {
    rows,
    formats,
    rawCols,
    rawRows,
    chunkingBroken,
    displayRows: wantDisplay ? displayRows : null,
    pendingCalc,
    cellCount,
    spills: { spills: spillRanges, spillRefs },
  };
}
