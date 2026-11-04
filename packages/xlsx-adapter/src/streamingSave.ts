/**
 * Streaming XLSX save writer (W21 — P95 save fix).
 *
 * The old save path materialized the whole workbook THREE times over in
 * the engine process (sparse snapshot → dense WorkbookData grids →
 * SheetJS model → zip, plus one unzip/re-zip per native-XML injection).
 * At P95 scale that transient (~+3.4 GB over the engine's plateau) got
 * the engine SIGKILLed by the host mid-save in the browser flow (W21a
 * bisect). This module is the serializer half of the fix, designed to
 * run inside a separate save-worker process (gateway saveWorkerCore):
 *
 * - VERBATIM PART COPY: the output package is built from the SOURCE
 *   package's parts. Parts the save did not touch (unmodified sheets,
 *   charts, media, drawings, pivot parts, sharedStrings, theme, …) are
 *   copied byte-for-byte — they are never re-serialized, so their
 *   content (and any part this adapter does not understand) survives
 *   exactly, and the memory cost of copying is one part at a time.
 * - GLOBAL PARTS ARE APPEND-ONLY: sharedStrings.xml is NEVER modified
 *   (re-serialized sheets write strings as inlineStr, so no new shared
 *   strings are ever needed), and styles.xml changes go through
 *   stylesXml.createStreamingStyles, which only APPENDS fonts/fills/
 *   borders/numFmts/cellXfs — original entries keep their indices, so
 *   verbatim sheets' `s="…"` references stay valid.
 * - STREAMING SHEET WRITER: a changed sheet is generated row-by-row
 *   from the rebuilt workbook state (cells arrive sorted, one row is
 *   materialized at a time) inside the source sheet's own head/tail
 *   (sheetPr, sheetViews, cols when untouched, page setup, breaks —
 *   everything outside <sheetData> is the source's bytes).
 * - STREAMING ZIP: parts are pushed through fflate's streaming Zip
 *   (ZipDeflate per part, chunks fed incrementally) into a caller sink;
 *   neither a whole sheet's XML nor the whole zip is ever materialized
 *   by this module (verbatim parts are fed in 1 MiB slices).
 *
 * Workbook-global surgery that CAN be forced by a change, honestly:
 * - xl/workbook.xml is regenerated (string surgery on the small part)
 *   only when the defined-names table differs from the source's;
 *   `_xlnm.*` elements (print areas/titles) and `_xlcn.*` elements
 *   (connection bookkeeping) are preserved verbatim.
 * - docProps/custom.xml is regenerated only when the app-owned
 *   (`icecream.*`) metadata differs; other producers' custom
 *   properties are preserved verbatim.
 * - xl/calcChain.xml is DROPPED when any sheet changed (a stale calc
 *   chain is invalid; Excel rebuilds it — the old SheetJS path dropped
 *   it on every save) and its [Content_Types].xml override is removed.
 */
import { Zip, ZipDeflate } from 'fflate';
import type { CellInput, CellStyle, DefinedName, TypedValue } from '@icecream-sheets/engine';
import { parseCustomProperties, parseDefinedNames } from './fastSheetParse.js';
import { prefixFutureFunctions, stripFuturePrefixes } from './futureFunctions.js';
import {
  nativeFeaturesBlockXml,
  spliceNativeFeaturesBlock,
  type NativeSheetFeatureFields,
} from './nativeSheetFeatures.js';
import { spliceSparklineGroups } from './sparklinesXml.js';
import type { CfRule } from './conditionalFormattingXml.js';
import { restoreStructuredRefs, type TableDef } from './tables.js';
import { ZIP_STABLE_MTIME } from './zipStable.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;');
}

/** 0-based column index -> Excel letters. */
export function colLetters(c: number): string {
  let s = '';
  let n = c;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** 0-based (row, col) -> A1 ref. */
export function a1Ref(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`;
}

/** OOXML error literals that travel as plain strings in CellInput form. */
export const ERROR_CELL_LITERALS: ReadonlySet<string> = new Set([
  '#DIV/0!',
  '#N/A',
  '#NAME?',
  '#NULL!',
  '#NUM!',
  '#REF!',
  '#VALUE!',
]);

// ---------------------------------------------------------------------------
// Worksheet XML: split the source part into head (<sheetData> inclusive)
// and tail (</sheetData> onward) so only the row payload is regenerated.
// ---------------------------------------------------------------------------

export function splitSheetXml(xml: string): { head: string; tail: string } {
  const selfClosed = /<sheetData\b[^>]*?\/>/.exec(xml);
  if (selfClosed) {
    const head = `${xml.slice(0, selfClosed.index)}<sheetData>`;
    const tail = `</sheetData>${xml.slice(selfClosed.index + selfClosed[0].length)}`;
    return { head, tail };
  }
  const open = /<sheetData\b[^>]*?>/.exec(xml);
  if (!open) throw new Error('splitSheetXml: no <sheetData> in worksheet part');
  const headEnd = open.index + open[0].length;
  const closeIdx = xml.indexOf('</sheetData>', headEnd);
  if (closeIdx < 0) throw new Error('splitSheetXml: no </sheetData> in worksheet part');
  return { head: xml.slice(0, headEnd), tail: xml.slice(closeIdx) };
}

/** Point the head's <dimension> at a new used range (inserted if absent). */
export function updateDimension(head: string, maxRow: number, maxCol: number): string {
  const ref = maxRow < 0 || maxCol < 0 ? 'A1' : `A1:${a1Ref(maxRow, maxCol)}`;
  if (/<dimension\b[^>]*\bref\s*=\s*"[^"]*"/.test(head)) {
    return head.replace(
      /(<dimension\b[^>]*\bref\s*=\s*")[^"]*(")/,
      (_m, pre: string, post: string) => `${pre}${ref}${post}`,
    );
  }
  const dim = `<dimension ref="${ref}"/>`;
  for (const anchor of ['<sheetViews', '<sheetFormatPr', '<cols', '<sheetData']) {
    const idx = head.indexOf(anchor);
    if (idx >= 0) return head.slice(0, idx) + dim + head.slice(idx);
  }
  return head.replace(/<sheetData/, `${dim}<sheetData`);
}

/** Replace the head's <cols> block with generated column definitions. */
export function replaceCols(
  head: string,
  colWidths: Record<string, number> | undefined,
  hiddenCols: number[] | undefined,
): string {
  const widths = colWidths ?? {};
  const hidden = new Set(hiddenCols ?? []);
  const idxs = [...new Set([...Object.keys(widths).map(Number), ...hidden])]
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
  let cols = '';
  if (idxs.length > 0) {
    const parts: string[] = [];
    for (const c of idxs) {
      const px = widths[String(c)];
      const attrs: string[] = [];
      if (typeof px === 'number' && px > 0) {
        attrs.push(`width="${Math.max(1, (px - 5) / 7)}"`, 'customWidth="1"');
      }
      if (hidden.has(c)) attrs.push('hidden="1"');
      parts.push(`<col min="${c + 1}" max="${c + 1}" ${attrs.join(' ')}/>`);
    }
    cols = `<cols>${parts.join('')}</cols>`;
  }
  const stripped = head.replace(/<cols>[\s\S]*?<\/cols>/, '');
  if (!cols) return stripped;
  const at = stripped.indexOf('<sheetData');
  return at >= 0 ? stripped.slice(0, at) + cols + stripped.slice(at) : stripped + cols;
}

// ---------------------------------------------------------------------------
// Row-by-row sheet generation
// ---------------------------------------------------------------------------

/** One cell to emit in a re-serialized sheet. */
export interface StreamSaveCell {
  row: number;
  col: number;
  /** Raw input: literal or '=formula'; null for a styled-but-empty cell. */
  input: CellInput;
  /** Cached (computed) value from the rebuilt engine, for formula cells. */
  value?: TypedValue;
  style?: CellStyle;
  formatCode?: string;
}

export interface SheetGenOptions {
  /** Source worksheet XML for head/tail reuse; null = synthesize a bare sheet. */
  sourceXml: string | null;
  /** Cells sorted by (row, col); styled-empty cells included with input null. */
  cells: StreamSaveCell[];
  /** Resolve the xf index for a cell's style/format (append-only styles). */
  xfFor: (style: CellStyle | undefined, formatCode: string | undefined) => number;
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  hiddenCols?: number[];
  hiddenRows?: number[];
  /** True when colWidths/hiddenCols are authoritative (replace source <cols>). */
  dimsAuthoritative?: boolean;
  /**
   * Replacement native worksheet features (merges, autoFilter, sortState,
   * dataValidations, conditionalFormatting, sparklineGroups) for this
   * sheet. When undefined, a source sheet's own blocks survive verbatim
   * in its tail (the streaming path's preservation behavior). When
   * provided, the source blocks are stripped and this model is spliced
   * in after `</sheetData>` in CT_Worksheet order (sparklineGroups are
   * spliced into the tail's <extLst> instead). `cfDxfIdFor` resolves CF
   * dxf indices against the caller's styles (append-only); without it a
   * rule's own recorded dxfId is reused.
   */
  nativeFeatures?: NativeSheetFeatureFields;
  cfDxfIdFor?: (rule: CfRule) => number | undefined;
  /**
   * Relationship id of a NEW drawing part for this sheet (native chart
   * authoring, FIX-G trace §4.1d): when set and the source tail carries
   * no <drawing> element, one is emitted at the head of the tail
   * (immediately after </sheetData>). When the tail already has a
   * <drawing> element it is left untouched — never duplicated.
   */
  drawingRid?: string;
  /**
   * Item B: table definitions for structured-reference restoration.
   * The live model only carries the A1 forms import produced, so a
   * regenerated sheet would otherwise persist A1 expansions where the
   * source file carried `Sales[Qty]` etc. When provided (with
   * `sheetName`), formula cells are passed through
   * restoreStructuredRefs inside cellXml before future-function
   * prefixing. Should carry every table in the workbook — qualified
   * references match by the sheet they name, not the formula's sheet.
   */
  structuredRefTables?: readonly TableDef[];
  /** Name of the sheet being generated (the unqualified-ref sheet). */
  sheetName?: string;
}

function cachedValueXml(cell: StreamSaveCell): { tAttr: string; vXml: string } {
  const v = cell.value;
  if (!v) return { tAttr: '', vXml: '<v></v>' };
  switch (v.kind) {
    case 'number':
      return { tAttr: '', vXml: `<v>${String(v.value)}</v>` };
    case 'string':
      return { tAttr: ' t="str"', vXml: `<v>${escapeXmlText(String(v.value))}</v>` };
    case 'boolean':
      return { tAttr: ' t="b"', vXml: `<v>${v.value ? '1' : '0'}</v>` };
    case 'error':
      return { tAttr: ' t="e"', vXml: `<v>${escapeXmlText(v.code)}</v>` };
    default:
      return { tAttr: '', vXml: '<v></v>' };
  }
}

function cellXml(
  cell: StreamSaveCell,
  xf: number,
  structuredRefTables?: readonly TableDef[],
  sheetName?: string,
): string {
  const ref = a1Ref(cell.row, cell.col);
  const s = xf > 0 ? ` s="${xf}"` : '';
  const input = cell.input;
  // Item G: a literal empty string is a real cell value (Excel treats it as
  // a present-but-empty string, not a blank), so it serializes as an empty
  // inline-string cell — distinct from an absent cell (null/undefined),
  // which serializes as the bare <c/> element. '' falls through to the
  // text path below, which emits <c r=".." t="inlineStr"><is><t></t></is></c>.
  if (input === null || input === undefined) {
    return `<c r="${ref}"${s}/>`;
  }
  if (typeof input === 'number') {
    return Number.isFinite(input)
      ? `<c r="${ref}"${s}><v>${String(input)}</v></c>`
      : `<c r="${ref}"${s} t="inlineStr"><is><t>${String(input)}</t></is></c>`;
  }
  if (typeof input === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${input ? '1' : '0'}</v></c>`;
  }
  // String inputs: formula, error literal, apostrophe-escaped text, or text.
  if (input.startsWith('=') && input.length > 1) {
    const { tAttr, vXml } = cachedValueXml(cell);
    // Item B: restore structured references from the A1 forms the
    // engine carries, BEFORE future-function prefixing (whose
    // tokenizer treats bracketed references as opaque, so the
    // restored structured syntax survives it verbatim).
    let formulaBody = input.slice(1);
    if (structuredRefTables && structuredRefTables.length > 0 && sheetName) {
      formulaBody = restoreStructuredRefs(formulaBody, cell.row, sheetName, structuredRefTables);
    }
    // Future functions are stored _xlfn-prefixed (audit §9.4); the
    // engine's bare names are rewritten at this serialization boundary.
    const stored = prefixFutureFunctions(formulaBody);
    return `<c r="${ref}"${s}${tAttr}><f>${escapeXmlText(stored)}</f>${vXml}</c>`;
  }
  if (ERROR_CELL_LITERALS.has(input)) {
    return `<c r="${ref}"${s} t="e"><v>${input}</v></c>`;
  }
  const text = input.startsWith("'=") ? input.slice(1) : input;
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t${preserve}>${escapeXmlText(text)}</t></is></c>`;
}

const CHUNK_FLUSH = 256 * 1024;

/**
 * Generate a worksheet part as string chunks: source head (dimension
 * updated, cols replaced only when dims are authoritative) + one <row>
 * per row that carries cells or row dims + source tail. Only one row
 * (plus the current output chunk) is materialized at a time.
 */
export function* sheetXmlChunks(opts: SheetGenOptions): Generator<string> {
  const cells = opts.cells;
  let maxRow = -1;
  let maxCol = -1;
  for (const c of cells) {
    if (c.row > maxRow) maxRow = c.row;
    if (c.col > maxCol) maxCol = c.col;
  }
  for (const k of Object.keys(opts.rowHeights ?? {})) {
    const r = Number(k);
    if (Number.isInteger(r) && r > maxRow) maxRow = r;
  }
  for (const r of opts.hiddenRows ?? []) if (r > maxRow) maxRow = r;

  let head: string;
  let tail: string;
  if (opts.sourceXml !== null) {
    const split = splitSheetXml(opts.sourceXml);
    head = split.head;
    tail = split.tail;
  } else {
    head =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><sheetData>';
    tail = '</sheetData></worksheet>';
  }
  head = updateDimension(head, maxRow, maxCol);
  if (opts.dimsAuthoritative) head = replaceCols(head, opts.colWidths, opts.hiddenCols);
  if (opts.nativeFeatures !== undefined) {
    // The feature blocks live in the tail (everything from </sheetData>
    // on); splice the replacement model into it.
    const block = nativeFeaturesBlockXml(
      opts.nativeFeatures,
      opts.cfDxfIdFor ?? ((rule) => rule.dxfId),
    );
    tail = spliceNativeFeaturesBlock(tail, block);
    // Sparklines live in the tail's <extLst>: a provided sparklineGroups
    // field (even empty) replaces the source extension; an absent field
    // leaves the source <extLst> untouched in the verbatim tail.
    if (opts.nativeFeatures.sparklineGroups !== undefined) {
      tail = spliceSparklineGroups(tail, opts.nativeFeatures.sparklineGroups);
    }
  }
  if (opts.drawingRid && !/<drawing\b/.test(tail)) {
    tail = tail.replace('</sheetData>', `</sheetData><drawing r:id="${opts.drawingRid}"/>`);
  }
  yield head;

  const rowHeights = opts.rowHeights ?? {};
  const hiddenRows = new Set(opts.hiddenRows ?? []);
  let buf = '';
  let i = 0;
  // Rows to emit: every row with cells, plus rows carrying only dims.
  const dimOnlyRows = new Set<number>();
  for (const k of Object.keys(rowHeights)) dimOnlyRows.add(Number(k));
  for (const r of hiddenRows) dimOnlyRows.add(r);
  let nextDimRow = [...dimOnlyRows].sort((a, b) => a - b);
  let dimIdx = 0;
  const emitRow = (r: number, rowCells: StreamSaveCell[]): void => {
    const attrs: string[] = [`r="${r + 1}"`];
    const px = rowHeights[String(r)];
    if (typeof px === 'number' && px > 0) attrs.push(`ht="${px * 0.75}"`, 'customHeight="1"');
    if (hiddenRows.has(r)) attrs.push('hidden="1"');
    let xml = `<row ${attrs.join(' ')}>`;
    for (const cell of rowCells) {
      xml += cellXml(cell, opts.xfFor(cell.style, cell.formatCode), opts.structuredRefTables, opts.sheetName);
    }
    xml += '</row>';
    buf += xml;
  };
  while (i < cells.length || dimIdx < nextDimRow.length) {
    const nextCellRow = i < cells.length ? (cells[i] as StreamSaveCell).row : Infinity;
    const nextDim = dimIdx < nextDimRow.length ? (nextDimRow[dimIdx] as number) : Infinity;
    const r = Math.min(nextCellRow, nextDim);
    const rowCells: StreamSaveCell[] = [];
    while (i < cells.length && (cells[i] as StreamSaveCell).row === r) {
      rowCells.push(cells[i] as StreamSaveCell);
      i++;
    }
    if (nextDim === r) dimIdx++;
    emitRow(r, rowCells);
    if (buf.length >= CHUNK_FLUSH) {
      yield buf;
      buf = '';
    }
  }
  void nextDimRow;
  if (buf) yield buf;
  yield tail;
}

// ---------------------------------------------------------------------------
// workbook.xml defined names (regenerated only when the table changed)
// ---------------------------------------------------------------------------

/**
 * Bookkeeping defined names that are NOT formula names: `_xlnm.*`
 * (print areas/titles) and `_xlcn.*` (workbook-connection bookkeeping,
 * whose refs are structured table refs like `tblBS[]` that the formula
 * engine cannot parse — the live table degrades them to `#ERROR!`).
 * They are preserved verbatim from the source part on regeneration and
 * excluded from the desired-table comparison / re-emission, so they
 * never duplicate or degrade.
 */
export function isVerbatimPreservedDefinedName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('_xlnm.') || lower.startsWith('_xlcn.');
}

function normalizeNames(
  names: readonly DefinedName[],
): Array<{ name: string; ref: string; sheet?: number }> {
  return names
    .filter(
      (n) =>
        n &&
        typeof n.name === 'string' &&
        typeof n.ref === 'string' &&
        !isVerbatimPreservedDefinedName(n.name),
    )
    .map((n) => ({
      name: n.name,
      // Compare/store in bare form: a source part's refs carry _xlfn
      // storage prefixes, the desired table carries engine-bare refs.
      ref: stripFuturePrefixes(n.ref.startsWith('=') ? n.ref.slice(1) : n.ref),
      ...(typeof n.sheet === 'number' ? { sheet: n.sheet } : {}),
    }))
    .sort((a, b) => {
      const ka = `${a.sheet ?? ''}\0${a.name.toLowerCase()}`;
      const kb = `${b.sheet ?? ''}\0${b.name.toLowerCase()}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

/** True when the desired defined-names table equals the source part's. */
export function definedNamesEqual(workbookXml: string, desired: readonly DefinedName[]): boolean {
  const existing = normalizeNames(parseDefinedNames(workbookXml));
  const want = normalizeNames(desired);
  if (existing.length !== want.length) return false;
  return existing.every(
    (e, i) => e.name === want[i]!.name && e.ref === want[i]!.ref && e.sheet === want[i]!.sheet,
  );
}

function definedNamesBlock(names: readonly DefinedName[], preservedVerbatim: string[]): string {
  const els = [...preservedVerbatim];
  const normalized = normalizeNames(names);
  // Defined-name refs that are formulas (notably LAMBDA definitions) are
  // stored _xlfn-prefixed; calls to sibling defined names stay bare.
  const skip = normalized.map((n) => n.name);
  for (const n of normalized) {
    const sheetAttr = n.sheet !== undefined ? ` localSheetId="${n.sheet}"` : '';
    els.push(
      `<definedName name="${escapeXmlAttr(n.name)}"${sheetAttr}>${escapeXmlText(prefixFutureFunctions(n.ref, { definedNames: skip }))}</definedName>`,
    );
  }
  return els.length > 0 ? `<definedNames>${els.join('')}</definedNames>` : '<definedNames/>';
}

/**
 * Rewrite xl/workbook.xml with a new defined-names table, preserving
 * the source's `_xlnm.*` elements (print areas/titles — not formula
 * names) and `_xlcn.*` elements (connection bookkeeping — not formula
 * names) verbatim and leaving every other byte of the part untouched.
 * `_xlcn.*` entries in `desired` are ignored (normalizeNames excludes
 * them): the verbatim source element is the only copy emitted, so a
 * degraded `#ERROR!` live ref can never be written.
 */
export function regenerateWorkbookXml(workbookXml: string, desired: readonly DefinedName[]): string {
  const preserved: string[] = [];
  const blockRe = /<definedNames\b[^>]*>([\s\S]*?)<\/definedNames>|<definedNames\b[^>]*?\/>/;
  const block = blockRe.exec(workbookXml);
  if (block && block[1]) {
    for (const el of block[1].match(/<definedName\b[^>]*>[\s\S]*?<\/definedName>/g) ?? []) {
      const name = /\bname\s*=\s*"([^"]*)"/.exec(el)?.[1];
      if (name && isVerbatimPreservedDefinedName(name)) preserved.push(el);
    }
  }
  const replacement = definedNamesBlock(desired, preserved);
  // Replacer FUNCTION: A1 refs contain `$1`-style sequences that
  // String.replace would otherwise read as capture-group references.
  if (block) return workbookXml.replace(blockRe, () => replacement);
  const calcIdx = workbookXml.indexOf('<calcPr');
  if (calcIdx >= 0) return workbookXml.slice(0, calcIdx) + replacement + workbookXml.slice(calcIdx);
  return workbookXml.replace('</workbook>', `${replacement}</workbook>`);
}

/**
 * Classic-write parity helper: SheetJS emits `_xlcn.*` defined names
 * without their `hidden="1"` attribute. Add it back to every `_xlcn.*`
 * element that lacks a hidden attribute (other bookkeeping/formula
 * names are untouched). Used by adapter.write, which has no source
 * package to preserve verbatim from.
 */
export function restoreXlcnHiddenFlags(workbookXml: string): string {
  return workbookXml.replace(/<definedName\b[^>]*>/g, (tag) => {
    const name = /\bname\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (!name || !name.toLowerCase().startsWith('_xlcn.')) return tag;
    if (/\bhidden\s*=/.test(tag)) return tag;
    return tag.replace(/\/?>$/, (end) => ` hidden="1"${end}`);
  });
}

/** A minimal xl/workbook.xml for a workbook with no source package. */
export function synthesizeWorkbookXml(sheetNames: string[], desired: readonly DefinedName[]): string {
  const sheets = sheetNames
    .map(
      (name, i) =>
        `<sheet name="${escapeXmlAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets>${definedNamesBlock(desired, [])}` +
    '<calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>'
  );
}

// ---------------------------------------------------------------------------
// docProps/custom.xml (app-owned metadata; regenerated only on change)
// ---------------------------------------------------------------------------

export const APP_META_PREFIX = 'icecream.';
export const CUSTPROP_PREFIX = 'IcecreamSheets.Meta.';
const CUSTOM_FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';

/**
 * Escape a custom-property value the way SheetJS writes it (and both
 * readers decode): literal `_xHHHH_` sequences are protected by
 * escaping their underscore first, `"` travels as `_x0022_`, and the
 * XML metacharacters are entity-escaped.
 */
export function escapeCustomPropValue(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '_x0022_');
}

/**
 * Merge the app-owned metadata into docProps/custom.xml. Returns
 * { xml: null } when the source part already carries exactly the
 * desired icecream.* properties (the caller then copies it verbatim,
 * or omits it when the source had none and none are desired).
 * Non-IcecreamSheets properties from other producers are preserved.
 */
export function mergeCustomPropsXml(
  sourceXml: string | null,
  metadata: Record<string, unknown>,
): { xml: string | null; changed: boolean } {
  const desired = new Map<string, string>();
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(APP_META_PREFIX) || value === undefined) continue;
    try {
      desired.set(`${CUSTPROP_PREFIX}${key}`, JSON.stringify(value));
    } catch {
      // Unserializable metadata is skipped, exactly like the old write.
    }
  }
  const existingProps: Array<{ name: string; raw: string }> = [];
  if (sourceXml) {
    for (const raw of sourceXml.match(/<property\b[^>]*>[\s\S]*?<\/property>/g) ?? []) {
      const name = /\bname\s*=\s*"([^"]*)"/.exec(raw)?.[1];
      if (name) existingProps.push({ name, raw });
    }
  }
  const existingOurs = new Map<string, string>();
  if (sourceXml) {
    const flat = parseCustomProperties(sourceXml);
    for (const [name, value] of Object.entries(flat)) {
      if (name.startsWith(CUSTPROP_PREFIX)) existingOurs.set(name, String(value));
    }
  }
  let changed = existingOurs.size !== desired.size;
  if (!changed) {
    for (const [name, json] of desired) {
      if (existingOurs.get(name) !== json) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return { xml: null, changed: false };
  const kept = existingProps.filter((p) => !p.name.startsWith(CUSTPROP_PREFIX));
  let pid = 2;
  const parts: string[] = [];
  for (const p of kept) {
    parts.push(p.raw.replace(/\bpid\s*=\s*"[^"]*"/, `pid="${pid++}"`));
  }
  for (const [name, json] of desired) {
    parts.push(
      `<property fmtID="${CUSTOM_FMTID}" pid="${pid++}" name="${escapeXmlAttr(name)}">` +
        `<vt:lpwstr>${escapeCustomPropValue(json)}</vt:lpwstr></property>`,
    );
  }
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    parts.join('') +
    '</Properties>';
  return { xml, changed: true };
}

// ---------------------------------------------------------------------------
// Blank-package synthesis (a workbook created in-session, no source file)
// ---------------------------------------------------------------------------

export const MINIMAL_STYLES_XML =
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

export function synthesizeContentTypes(sheetCount: number, hasCustomProps: boolean): string {
  const sheets = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets +
    (hasCustomProps
      ? '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>'
      : '') +
    '</Types>'
  );
}

export function synthesizeRootRels(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'
  );
}

export function synthesizeWorkbookRels(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets +
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>'
  );
}

/** Remove one part's Override from [Content_Types].xml (e.g. a dropped calcChain). */
export function removeContentTypeOverride(contentTypesXml: string, partName: string): string {
  const re = new RegExp(
    `<Override\\b[^>]*PartName\\s*=\\s*"${partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`,
  );
  return contentTypesXml.replace(re, '');
}

/** Add an Override to [Content_Types].xml when missing. */
export function ensureContentTypeOverride(
  contentTypesXml: string,
  partName: string,
  contentType: string,
): string {
  if (contentTypesXml.includes(`PartName="${partName}"`)) return contentTypesXml;
  const el = `<Override PartName="${partName}" ContentType="${contentType}"/>`;
  return contentTypesXml.replace('</Types>', `${el}</Types>`);
}

// ---------------------------------------------------------------------------
// Streaming zip assembly (fflate streaming Zip -> caller sink)
// ---------------------------------------------------------------------------

export interface ZipEntrySource {
  name: string;
  /** Chunk producer: verbatim parts yield slices; generated parts yield their stream. */
  chunks: () => Iterable<Uint8Array>;
}

const VERBATIM_SLICE = 1024 * 1024;

/** Slice a verbatim part into bounded chunks (the part itself is never copied whole). */
export function* verbatimChunks(bytes: Uint8Array): Generator<Uint8Array> {
  for (let off = 0; off < bytes.length; off += VERBATIM_SLICE) {
    yield bytes.subarray(off, Math.min(off + VERBATIM_SLICE, bytes.length));
  }
  if (bytes.length === 0) yield new Uint8Array(0);
}

/** Encode a (small, generated) text part. */
export function* textChunks(text: string): Generator<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  yield* verbatimChunks(bytes);
}

/**
 * Stream a whole package into `sink` through fflate's streaming Zip:
 * each entry is a ZipDeflate fed chunk-by-chunk (generated sheets feed
 * their row generator; verbatim parts feed slices), and compressed
 * output is handed to the sink as it is produced. Entry timestamps are
 * pinned (ZIP_STABLE_MTIME) so re-saves of unchanged state are
 * byte-stable like the adapter's other re-zip sites.
 */
export function streamZipToSink(entries: ZipEntrySource[], sink: (chunk: Uint8Array) => void): void {
  let failure: Error | null = null;
  const zip = new Zip((err, data, _final) => {
    if (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      return;
    }
    if (data && data.length > 0) sink(data);
  });
  for (const entry of entries) {
    if (failure) break;
    const file = new ZipDeflate(entry.name, { level: 6 });
    file.mtime = ZIP_STABLE_MTIME;
    zip.add(file);
    for (const chunk of entry.chunks()) {
      file.push(chunk, false);
      if (failure) break;
    }
    file.push(new Uint8Array(0), true);
  }
  zip.end();
  if (failure) throw failure;
}
