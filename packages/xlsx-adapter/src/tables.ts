/**
 * Excel Table (ListObject) support — ISO/IEC 29500 §18.5.1 (`<table>`,
 * CT_Table / CT_TableColumn / CT_TableStyleInfo).
 *
 * SheetJS parses cell values/formulas but drops Table definitions
 * (xl/tables/*.xml). This module reads them directly from the ZIP package
 * via fflate and rewrites structured references (e.g. `tbl[Column]`,
 * `tbl[[#This Row],[Column]]`) into plain A1 ranges before formulas reach
 * the engine, which cannot parse the structured syntax.
 *
 * FULL DEFINITION MODEL (OOXML wave-2 slice B, audit §11): the parser
 * captures the complete table definition — per-column
 * `totalsRowFunction` / `totalsRowLabel` / `calculatedColumnFormula`
 * (plus `totalsRowFormula`, the custom totals function's formula),
 * `<tableStyleInfo>` (style name + first/last/row/column stripe flags),
 * and the table's own `<autoFilter>` (same model as the worksheet-level
 * filter, autoFilterXml.ts) — and `injectTables()` writes real
 * `xl/tables/tableN.xml` parts back on the classic save path: worksheet
 * `<tableParts>`, sheet `.rels` entries, and `[Content_Types].xml`
 * overrides. Imported definitions round-trip value-identically;
 * model-authored definitions serialize to valid SpreadsheetML.
 *
 * MODEL PLACEMENT (nativeSheetFeatures precedent): a sheet object may
 * carry its tables as the OPTIONAL `tables` field
 * (`SheetDataWithTables`). The classic read funnel
 * (`assembleFromParsedSheets`) attaches the field only when the file
 * actually carries tables for that sheet; consumers that never read it
 * are unaffected.
 *
 * Supported forms (all case-insensitive on table/column names):
 *   T[Column]                  -> Sheet!$C$2:$C$10   (data rows of column)
 *   T[[#This Row],[Column]]    -> Sheet!$C$5         (this-row cell; needs formula row)
 *   T[@Column]                 -> Sheet!$C$5         (implicit this-row)
 *   T[#Headers]                -> Sheet!$A$1:$E$1
 *   T[#Data]                   -> Sheet!$A$2:$E$10
 *   T[#Totals]                 -> Sheet!$A$11:$E$11   (if totals row shown)
 *   T[]                        -> Sheet!$A$2:$E$10   (whole data body)
 *   T[[#Totals],[Column]]      -> Sheet!$C$11
 *   T[[#Headers],[Column]]     -> Sheet!$C$1
 */

import { unzipSync } from 'fflate';
import type { SheetData } from '@icecream-sheets/engine';
import { sheetPartPaths } from './formulaRecovery.js';
import { zipSyncStable } from './zipStable.js';
import {
  autoFilterToXml,
  parseAutoFilter,
  type NativeAutoFilter,
} from './autoFilterXml.js';
import {
  boolAttrValue,
  escapeXmlAttr,
  escapeXmlText,
  findBlock,
  numAttrValue,
  parseAttrRecord,
  splitTopElements,
  stripBlocks,
  unescapeXmlText,
} from './nativeXmlUtil.js';

export type { NativeAutoFilter };

/**
 * ST_TotalsRowFunction (§18.18.?? — the `<tableColumn>` totals aggregation):
 * the string enumeration Excel writes in `totalsRowFunction`. The value
 * is carried VERBATIM: a producer that (non-standardly) writes a numeric
 * SUBTOTAL function code (101–111) round-trips unchanged too — use
 * `totalsRowFunctionForSubtotalCode` / `subtotalCodeForTotalsRowFunction`
 * to translate between the two vocabularies.
 */
export type TotalsRowFunction =
  | 'none'
  | 'average'
  | 'count'
  | 'countNums'
  | 'max'
  | 'min'
  | 'sum'
  | 'stdDev'
  | 'var'
  | 'custom'
  | (string & {});

/**
 * SUBTOTAL function codes (101–111, the aggregates that ignore hidden
 * rows) for the ST_TotalsRowFunction values that have one. `count`
 * (COUNTA) is 103 and `countNums` (COUNT) is 102. SUBTOTAL 106 (PRODUCT),
 * 108 (STDEV.P) and 111 (VAR.P) have NO ST_TotalsRowFunction equivalent —
 * Excel expresses those totals as `custom` with a `<totalsRowFormula>`.
 */
export const TOTALS_ROW_SUBTOTAL_CODES: Readonly<Record<string, number>> = {
  average: 101,
  countNums: 102,
  count: 103,
  max: 104,
  min: 105,
  stdDev: 107,
  sum: 109,
  var: 110,
};

/** ST_TotalsRowFunction for a SUBTOTAL code 101–111 (undefined: no equivalent). */
export function totalsRowFunctionForSubtotalCode(code: number): string | undefined {
  for (const [fn, c] of Object.entries(TOTALS_ROW_SUBTOTAL_CODES)) {
    if (c === code) return fn;
  }
  return undefined;
}

/** SUBTOTAL code for an ST_TotalsRowFunction value (undefined: none / custom / unknown). */
export function subtotalCodeForTotalsRowFunction(fn: string): number | undefined {
  return TOTALS_ROW_SUBTOTAL_CODES[fn];
}

/** One `<tableColumn>` of a table definition (§18.5.1.3). */
export interface TableColumnDef {
  /** `<tableColumn id>` — unique within the table, 1-based in Excel files. */
  id?: number;
  /** Column name (control characters decoded from `_xHHHH_` escapes). */
  name: string;
  /** `totalsRowFunction` attribute, verbatim (see TotalsRowFunction). */
  totalsRowFunction?: string;
  /** `totalsRowLabel` attribute — the label shown in the totals row. */
  totalsRowLabel?: string;
  /**
   * `<calculatedColumnFormula>` element text: the column's single
   * calculated formula (structured-ref syntax, no leading '='), applied
   * to every data row of the column.
   */
  calculatedColumnFormula?: string;
  /** `<totalsRowFormula>` element text (the `custom` totals function). */
  totalsRowFormula?: string;
  /** `headerRowCellStyle` / `dataCellStyle` / `totalsRowCellStyle` (named styles). */
  headerRowCellStyle?: string;
  dataCellStyle?: string;
  totalsRowCellStyle?: string;
  /** `uniqueName` attribute, when the producer wrote one. */
  uniqueName?: string;
}

/** `<tableStyleInfo>` (§18.5.1.3): table style name + stripe/banding flags. */
export interface TableStyleInfo {
  /** Style name, e.g. 'TableStyleMedium2'. */
  name?: string;
  showFirstColumn?: boolean;
  showLastColumn?: boolean;
  showRowStripes?: boolean;
  showColumnStripes?: boolean;
}

export interface TableDef {
  name: string;
  sheet: string;
  /** 0-based inclusive bounds of the full table ref (header + data + totals). */
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  columns: string[];
  headerRow: boolean;
  totalsRow: boolean;
  /** `<table id>` — unique across the workbook when present. */
  id?: number;
  /** The `displayName` attribute when present (else `name` came from `name`). */
  displayName?: string;
  /** The `name` attribute when it differs from the display name. */
  internalName?: string;
  /** Canonical A1 ref of the table, e.g. 'A1:D11' (normalized from the source). */
  ref?: string;
  /** `headerRowCount` attribute when present (0 or 1 in practice). */
  headerRowCount?: number;
  /** `totalsRowCount` attribute when present (0 or 1). */
  totalsRowCount?: number;
  /** `tableType` attribute (worksheet | queryTable | xml) when present. */
  tableType?: string;
  /** Per-column definitions, parallel to `columns`. */
  columnDetails?: TableColumnDef[];
  /** `<tableStyleInfo>` when the part carries one. */
  tableStyleInfo?: TableStyleInfo;
  /** The table's own `<autoFilter>` when the part carries one. */
  autoFilter?: NativeAutoFilter;
}

/** The optional table fields a sheet object may carry. */
export interface TableSheetFields {
  tables?: TableDef[];
}

/** SheetData plus the adapter's table extension field. */
export type SheetDataWithTables = SheetData & TableSheetFields;

interface ZipLike {
  [path: string]: Uint8Array;
}

/**
 * Read table definitions from a raw XLSX package.
 * `unzip` is fflate's unzipSync result (path -> bytes).
 */
export function readTables(unzip: ZipLike, sheetNames: string[]): TableDef[] {
  const tables: TableDef[] = [];
  // Map table XML path -> owning sheet via worksheet tableParts.
  // Worksheet files are xl/worksheets/sheetN.xml; order matches sheetNames.
  const tableToSheet = new Map<string, string>();
  const sheetFiles = Object.keys(unzip)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = parseInt(a.match(/sheet(\d+)\.xml/)?.[1] ?? '0', 10);
      const nb = parseInt(b.match(/sheet(\d+)\.xml/)?.[1] ?? '0', 10);
      return na - nb;
    });
  sheetFiles.forEach((path, i) => {
    const sheetName = sheetNames[i];
    if (!sheetName) return;
    const xml = textOf(unzip[path]);
    if (!xml) return;
    // <tableParts><tablePart r:id="rId2"/></tableParts> + rels map rId -> tables/tableN.xml
    const relsPath = path.replace(/\/worksheets\/sheet\d+\.xml$/, '/worksheets/_rels/') +
      path.split('/').pop()?.replace('.xml', '.xml.rels');
    const relsXml = relsPath ? textOf(unzip[relsPath]) : undefined;
    const tablePartIds = [...xml.matchAll(/<tablePart[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
    for (const id of tablePartIds) {
      let target: string | undefined;
      if (relsXml) {
        const rm = relsXml.match(
          new RegExp(`<Relationship[^>]*Id="${escapeReg(id)}"[^>]*Target="([^"]+)"`),
        );
        target = rm?.[1];
      }
      // Fallback: scan all table files if rels are missing.
      if (target) {
        const norm = target.replace(/^\.\.\//, 'xl/');
        const full = norm.startsWith('xl/') ? norm : `xl/worksheets/${norm}`;
        tableToSheet.set(full, sheetName);
      } else {
        tableToSheet.set(`__any__:${id}`, sheetName);
      }
    }
  });

  const tableFiles = Object.keys(unzip).filter((p) => /^xl\/tables\/table\d+\.xml$/i.test(p));
  for (const path of tableFiles) {
    const xml = textOf(unzip[path]);
    if (!xml) continue;
    let sheet = tableToSheet.get(path);
    if (!sheet) {
      // Fallback: first sheet whose dimension contains the table ref.
      sheet = sheetNames[0] ?? '';
    }
    const def = parseTablePartXml(xml, sheet);
    if (def) tables.push(def);
  }
  return tables;
}

/** Open tag (`<tag ...>` or `<tag .../>`) at the start of an element string. */
function openTagOf(el: string): string {
  const gt = el.indexOf('>');
  return gt < 0 ? el : el.slice(0, gt + 1);
}

/** Text of a child element (`<tag>text</tag>`) inside `el`, entity-decoded. */
function childText(el: string, tag: string): string | undefined {
  const block = findBlock(el, tag);
  if (!block) return undefined;
  const text = unescapeXmlText(block.inner).trim();
  return text === '' ? undefined : text;
}

/**
 * Parse one `xl/tables/tableN.xml` part into the full TableDef model
 * (§18.5.1). Returns null when the part lacks a usable name/ref — the
 * same skip rule the original name/ref-only parser applied.
 */
export function parseTablePartXml(xml: string, sheet: string): TableDef | null {
  const tableBlock = findBlock(xml, 'table');
  // findBlock also matches a bare self-closed <table .../>; a paired
  // block's open tag is what carries the attributes either way.
  const openTag = tableBlock ? openTagOf(tableBlock.whole) : (/^[\s\S]*?<table\b[^>]*>/.exec(xml)?.[0] ?? '');
  if (!openTag) return null;
  const attrs = parseAttrRecord(openTag);
  const displayName = attrs.displayName ? decodeControlChars(attrs.displayName) : undefined;
  const internalName = attrs.name ? decodeControlChars(attrs.name) : undefined;
  const name = displayName ?? internalName ?? '';
  const ref = attrs.ref ?? '';
  if (!name || !ref) return null;
  const bounds = parseRef(ref);
  if (!bounds) return null;

  // Per-column definitions (<tableColumns><tableColumn/></tableColumns>).
  const columnDetails: TableColumnDef[] = [];
  const colsBlock = findBlock(xml, 'tableColumns');
  if (colsBlock) {
    for (const el of splitTopElements(colsBlock.inner, 'tableColumn')) {
      const ca = parseAttrRecord(openTagOf(el));
      if (ca.name === undefined) continue;
      const col: TableColumnDef = { name: decodeControlChars(ca.name) };
      const id = numAttrValue(ca.id);
      if (id !== undefined) col.id = id;
      if (ca.totalsRowFunction !== undefined) col.totalsRowFunction = ca.totalsRowFunction;
      if (ca.totalsRowLabel !== undefined) col.totalsRowLabel = ca.totalsRowLabel;
      if (ca.uniqueName !== undefined) col.uniqueName = ca.uniqueName;
      if (ca.headerRowCellStyle !== undefined) col.headerRowCellStyle = ca.headerRowCellStyle;
      if (ca.dataCellStyle !== undefined) col.dataCellStyle = ca.dataCellStyle;
      if (ca.totalsRowCellStyle !== undefined) col.totalsRowCellStyle = ca.totalsRowCellStyle;
      const ccf = childText(el, 'calculatedColumnFormula');
      if (ccf !== undefined) col.calculatedColumnFormula = ccf;
      const trf = childText(el, 'totalsRowFormula');
      if (trf !== undefined) col.totalsRowFormula = trf;
      columnDetails.push(col);
    }
  }
  const columns = columnDetails.map((c) => c.name);

  const totalsShown = /totalsRowShown="1"/.test(xml);
  const headerShown = !/headerRowCount="0"/.test(xml);
  const def: TableDef = {
    name,
    sheet,
    startRow: bounds.sr,
    startCol: bounds.sc,
    endRow: bounds.er,
    endCol: bounds.ec,
    columns,
    headerRow: headerShown,
    totalsRow: totalsShown,
    ref: `${indexToCol(bounds.sc)}${bounds.sr + 1}:${indexToCol(bounds.ec)}${bounds.er + 1}`,
  };
  if (displayName !== undefined) def.displayName = displayName;
  if (internalName !== undefined && internalName !== name) def.internalName = internalName;
  const tableId = numAttrValue(attrs.id);
  if (tableId !== undefined) def.id = tableId;
  const hrc = numAttrValue(attrs.headerRowCount);
  if (hrc !== undefined) def.headerRowCount = hrc;
  const trc = numAttrValue(attrs.totalsRowCount);
  if (trc !== undefined) def.totalsRowCount = trc;
  if (attrs.tableType !== undefined) def.tableType = attrs.tableType;
  if (columnDetails.length > 0) def.columnDetails = columnDetails;

  // <tableStyleInfo> — style name + stripe flags (attrs present only).
  const styleBlock = findBlock(xml, 'tableStyleInfo');
  if (styleBlock) {
    const sa = styleBlock.attrs;
    const info: TableStyleInfo = {};
    if (sa.name !== undefined) info.name = sa.name;
    if (sa.showFirstColumn !== undefined) info.showFirstColumn = boolAttrValue(sa.showFirstColumn, false);
    if (sa.showLastColumn !== undefined) info.showLastColumn = boolAttrValue(sa.showLastColumn, false);
    if (sa.showRowStripes !== undefined) info.showRowStripes = boolAttrValue(sa.showRowStripes, true);
    if (sa.showColumnStripes !== undefined) info.showColumnStripes = boolAttrValue(sa.showColumnStripes, false);
    def.tableStyleInfo = info;
  }

  // The table's own <autoFilter> (a child of <table>, before
  // <tableColumns>) — same model/serializer as the worksheet filter.
  const af = parseAutoFilter(xml);
  if (af) def.autoFilter = af;
  return def;
}

function textOf(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined;
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decode OOXML control-character escapes in attribute values: `_xHHHH_`
 * where HHHH is the uppercase-hex UTF-16 code unit (e.g. `_x000a_` = LF).
 * Table column names containing line breaks are stored this way
 * (e.g. `Purchase_x000a_ price`), while formulas carry the literal
 * character — without decoding, the structured-ref rewrite never matches.
 */
function decodeControlChars(s: string): string {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * Normalize line breaks for column-name comparison: producers disagree on
 * CR+LF vs LF inside structured references (the raw XML may carry literal
 * CR+LF bytes while the table definition stores the LF-only `_x000a_`
 * escape). Excel treats them as the same column.
 */
function normalizeLineBreaks(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseRef(ref: string): { sr: number; sc: number; er: number; ec: number } | null {
  const m = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) return null;
  return {
    sc: colToIndex(m[1]!),
    sr: parseInt(m[2]!, 10) - 1,
    ec: colToIndex(m[3]!),
    er: parseInt(m[4]!, 10) - 1,
  };
}

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

function a1(sheet: string, r: number, c: number): string {
  const q = /[^A-Za-z0-9_]/.test(sheet) ? `'${sheet}'!` : `${sheet}!`;
  return `${q}$${indexToCol(c)}$${r + 1}`;
}

function a1Range(sheet: string, sr: number, sc: number, er: number, ec: number): string {
  return `${a1(sheet, sr, sc)}:${a1(sheet, er, ec)}`;
}

/**
 * Rewrite structured references in a formula to A1 ranges.
 * `formulaRow` is the 0-based row of the cell holding the formula
 * (needed for [#This Row] / [@Column]).
 */
export function rewriteStructuredRefs(
  formula: string,
  formulaRow: number,
  tables: TableDef[],
): string {
  if (!tables.length || !formula.includes('[')) return formula;
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  // Match TableName[ ... ] with balanced brackets (inner may contain [...]).
  // Table names: letters, digits, _, ., space (no brackets).
  // String literals are copied verbatim: a structured ref inside "..."
  // is display text (e.g. HYPERLINK's friendly name), not a reference.
  // The "" escape (literal quote inside a string) keeps the string open.
  let out = '';
  let i = 0;
  let inString = false;
  while (i < formula.length) {
    if (inString) {
      out += formula[i]!;
      if (formula[i] === '"') {
        if (formula[i + 1] === '"') {
          // Escaped quote: consume both, stay inside the string.
          out += '"';
          i += 2;
          continue;
        }
        inString = false;
      }
      i++;
      continue;
    }
    if (formula[i] === '"') {
      inString = true;
      out += formula[i]!;
      i++;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_. ]*/.exec(formula.slice(i));
    if (m && formula[i + m[0].length] === '[') {
      const rawName = m[0].trim();
      const t = byName.get(rawName.toLowerCase());
      const openIdx = i + m[0].length;
      // Find matching close bracket (balance nested [...]).
      let depth = 0;
      let j = openIdx;
      for (; j < formula.length; j++) {
        if (formula[j] === '[') depth++;
        else if (formula[j] === ']') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j < formula.length && t) {
        const inner = formula.slice(openIdx + 1, j);
        const replacement = resolveStructured(t, inner, formulaRow);
        if (replacement !== null) {
          out += replacement;
          i = j + 1;
          continue;
        }
      }
      // No table match or unresolvable: copy verbatim up to and including '['.
      out += formula.slice(i, openIdx + 1);
      i = openIdx + 1;
    } else {
      out += formula[i]!;
      i++;
    }
  }
  return out;
}

function resolveStructured(t: TableDef, inner: string, formulaRow: number): string | null {
  const dataStartRow = t.startRow + (t.headerRow ? 1 : 0);
  const dataEndRow = t.endRow - (t.totalsRow ? 1 : 0);
  const colIndex = (name: string): number => {
    // Column names may carry CR+LF in the formula but LF-only (via the
    // _x000a_ escape) in the table definition — normalize before comparing.
    const want = normalizeLineBreaks(name).trim().toLowerCase();
    const i = t.columns.findIndex((c) => c.trim().toLowerCase() === want);
    return i < 0 ? -1 : t.startCol + i;
  };
  const parts = inner.split(',').map((p) => p.trim());
  const spec = parts.length === 1 ? parts[0]! : parts.join(',');

  // [#This Row] with column: "T[[#This Row],[Col]]"
  const thisRowM = spec.match(/^\[#This Row\],\[(.+)\]$/i);
  if (thisRowM) {
    const ci = colIndex(thisRowM[1]!);
    if (ci < 0) return null;
    return a1(t.sheet, formulaRow, ci);
  }
  // [@Col] implicit this-row, double-bracket source form: "T[[@Col]]"
  // (the scanner strips the outer brackets, so inner is "[@Col]").
  const atM = spec.match(/^\[@(.+)\]$/);
  if (atM) {
    const ci = colIndex(atM[1]!);
    if (ci < 0) return null;
    return a1(t.sheet, formulaRow, ci);
  }
  // [@Col] implicit this-row, single-bracket source form: "T[@Col]"
  // (inner is "@Col"). Excel's preferred in-cell shorthand and the form
  // restoreStructuredRefs emits — without this branch the restored
  // formula survived a save unrewritten and the round trip changed the
  // cell's formula text (found by the successor coordinator via
  // roundtrip-fidelity on beyond-excel-bxl3way.xlsx, 2026-10-21).
  const atSingleM = spec.match(/^@(.+)$/);
  if (atSingleM) {
    const ci = colIndex(atSingleM[1]!);
    if (ci < 0) return null;
    return a1(t.sheet, formulaRow, ci);
  }
  // Special item specifiers
  const low = spec.toLowerCase();
  if (low === '#headers') {
    if (!t.headerRow) return null;
    return a1Range(t.sheet, t.startRow, t.startCol, t.startRow, t.endCol);
  }
  if (low === '#data' || spec === '') {
    return a1Range(t.sheet, dataStartRow, t.startCol, dataEndRow, t.endCol);
  }
  if (low === '#totals') {
    if (!t.totalsRow) return null;
    return a1Range(t.sheet, t.endRow, t.startCol, t.endRow, t.endCol);
  }
  if (low === '#all') {
    return a1Range(t.sheet, t.startRow, t.startCol, t.endRow, t.endCol);
  }
  // [[#Totals],[Col]] / [[#Headers],[Col]]
  const sectionM = spec.match(/^\[#(Totals|Headers)\],\[(.+)\]$/i);
  if (sectionM) {
    const ci = colIndex(sectionM[2]!);
    if (ci < 0) return null;
    const r = sectionM[1]!.toLowerCase() === 'totals' ? t.endRow : t.startRow;
    return a1(t.sheet, r, ci);
  }
  // Plain column: T[Column] -> data cells of that column
  // Also T[[Column]] (double-bracket form = same as single).
  const ci = colIndex(spec);
  if (ci >= 0) {
    return a1Range(t.sheet, dataStartRow, ci, dataEndRow, ci);
  }
  const dblM = spec.match(/^\[(.+)\]$/);
  if (dblM) {
    const ci2 = colIndex(dblM[1]!);
    if (ci2 >= 0) {
      return a1Range(t.sheet, dataStartRow, ci2, dataEndRow, ci2);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Restore (save-time inverse of rewriteStructuredRefs)                */
/* ------------------------------------------------------------------ */

interface ParsedA1Ref {
  sheet?: string;
  col: number;
  /** 0-based row. */
  row: number;
  /** Index just past the reference in the source string. */
  end: number;
  /** True only for the exact absolute form rewrite emits ($Col$Row). */
  absolute: boolean;
}

/**
 * Parse one A1 reference at `pos`: an optional sheet prefix (unquoted
 * `Data!` or quoted `'My Sheet'!`, with `''` as an escaped quote)
 * followed by `$Col$Row` (the `$`s are recorded in `absolute`; the
 * parser itself accepts relative forms so the caller can consume them
 * verbatim without re-scanning their interiors).
 */
function parseA1RefAt(s: string, pos: number): ParsedA1Ref | null {
  let p = pos;
  let sheet: string | undefined;
  if (s[p] === "'") {
    let j = p + 1;
    let name = '';
    let closed = false;
    while (j < s.length) {
      if (s[j] === "'") {
        if (s[j + 1] === "'") {
          name += "'";
          j += 2;
          continue;
        }
        closed = true;
        j++;
        break;
      }
      name += s[j]!;
      j++;
    }
    if (!closed || s[j] !== '!') return null;
    sheet = name;
    p = j + 1;
  } else {
    const sm = /^([A-Za-z0-9_]+)!/.exec(s.slice(p));
    if (sm) {
      sheet = sm[1]!;
      p += sm[0].length;
    }
  }
  const cm = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)/.exec(s.slice(p));
  if (!cm) return null;
  const end = p + cm[0].length;
  // A letter/digit/underscore right after the row means this is a
  // longer token (defined name, function name), not a cell reference.
  if (/[A-Za-z0-9_]/.test(s[end] ?? '')) return null;
  const row = parseInt(cm[4]!, 10) - 1;
  if (row < 0) return null;
  return {
    sheet,
    col: colToIndex(cm[2]!),
    row,
    end,
    absolute: cm[1] === '$' && cm[3] === '$',
  };
}

/** Escape a column name for structured-ref brackets (']' -> ']]'). */
function structuredColName(name: string): string {
  return name.replace(/]/g, ']]');
}

function restoreRangeForTable(
  t: TableDef,
  sr: number,
  sc: number,
  er: number,
  ec: number,
): string | null {
  const dataStartRow = t.startRow + (t.headerRow ? 1 : 0);
  const dataEndRow = t.endRow - (t.totalsRow ? 1 : 0);
  if (sr === t.startRow && sc === t.startCol && er === t.endRow && ec === t.endCol) {
    return `${t.name}[#All]`;
  }
  if (t.headerRow && sr === t.startRow && er === t.startRow && sc === t.startCol && ec === t.endCol) {
    return `${t.name}[#Headers]`;
  }
  if (t.totalsRow && sr === t.endRow && er === t.endRow && sc === t.startCol && ec === t.endCol) {
    return `${t.name}[#Totals]`;
  }
  if (sr === dataStartRow && er === dataEndRow && sc === t.startCol && ec === t.endCol) {
    return `${t.name}[#Data]`;
  }
  if (sr === dataStartRow && er === dataEndRow && sc === ec && sc >= t.startCol && sc <= t.endCol) {
    const colName = t.columns[sc - t.startCol];
    if (colName !== undefined) return `${t.name}[${structuredColName(colName)}]`;
  }
  return null;
}

function restoreSingleForTable(t: TableDef, row: number, col: number, formulaRow: number): string | null {
  if (col < t.startCol || col > t.endCol) return null;
  const colName = t.columns[col - t.startCol];
  if (colName === undefined) return null;
  const escaped = structuredColName(colName);
  if (t.headerRow && row === t.startRow) {
    return `${t.name}[[#Headers],[${escaped}]]`;
  }
  if (t.totalsRow && row === t.endRow) {
    return `${t.name}[[#Totals],[${escaped}]]`;
  }
  const dataStartRow = t.startRow + (t.headerRow ? 1 : 0);
  const dataEndRow = t.endRow - (t.totalsRow ? 1 : 0);
  if (row === formulaRow && row >= dataStartRow && row <= dataEndRow) {
    return `${t.name}[@${escaped}]`;
  }
  return null;
}

/**
 * Restore structured references in a formula from the A1 forms
 * {@link rewriteStructuredRefs} produced at import — the exact inverse,
 * applied at the serialization boundaries (item B). The engine only
 * ever stores the A1 form, so on save a regenerated sheet would
 * otherwise persist `Data!$B$2:Data!$B$4` where the source file carried
 * `Sales[Qty]`.
 *
 * Matching is EXACT and absolute-only: a reference (or range) restores
 * only when its sheet, rows and columns coincide precisely with a
 * table shape —
 *   whole table -> `T[#All]`; header row range -> `T[#Headers]`;
 *   totals row range -> `T[#Totals]`; data body range -> `T[#Data]`;
 *   one column's data range -> `T[Col]`; a header/totals single cell ->
 *   `T[[#Headers],[Col]]` / `T[[#Totals],[Col]]`; a data single cell
 *   on the formula's own row -> `T[@Col]`.
 * Qualified forms (`Data!$B$2:Data!$B$4`, quoted sheet names included,
 * endpoints independently qualified) and unqualified forms (assumed to
 * be on `formulaSheet`) are both recognized. Anything else — edited,
 * shifted, relative, or non-table references — is left in A1 form
 * verbatim (graceful degradation: semantically identical values).
 * String literals are never touched.
 *
 * `formula` may carry a leading '=' or not; it is preserved as given.
 * `formulaRow` is the 0-based row of the cell holding the formula
 * (needed for the `[@Col]` this-row form). `tables` should be every
 * table in the workbook: qualified references match by the sheet they
 * name, regardless of which sheet holds the formula.
 */
export function restoreStructuredRefs(
  formula: string,
  formulaRow: number,
  formulaSheet: string,
  tables: readonly TableDef[],
): string {
  if (!tables.length || !formula.includes('$')) return formula;
  let out = '';
  let i = 0;
  let inString = false;
  while (i < formula.length) {
    if (inString) {
      out += formula[i]!;
      if (formula[i] === '"') {
        if (formula[i + 1] === '"') {
          out += '"';
          i += 2;
          continue;
        }
        inString = false;
      }
      i++;
      continue;
    }
    if (formula[i] === '"') {
      inString = true;
      out += formula[i]!;
      i++;
      continue;
    }
    const prev = i > 0 ? (formula[i - 1] as string) : '';
    const atBoundary = i === 0 || !/[A-Za-z0-9_.$!]/.test(prev);
    const ch = formula[i] as string;
    if (atBoundary && (ch === '$' || ch === "'" || /[A-Za-z_]/.test(ch))) {
      const first = parseA1RefAt(formula, i);
      if (first) {
        // Range form first: a range's first endpoint alone could look
        // like a header/totals/this-row single, so the range decision
        // (restore or verbatim) always wins over the single decision.
        if (formula[first.end] === ':') {
          const second = parseA1RefAt(formula, first.end + 1);
          if (second) {
            let replacement: string | null = null;
            if (first.absolute && second.absolute) {
              const startSheet = first.sheet ?? second.sheet ?? formulaSheet;
              const endSheet = second.sheet ?? first.sheet ?? formulaSheet;
              for (const t of tables) {
                if (
                  startSheet.toLowerCase() !== t.sheet.toLowerCase() ||
                  endSheet.toLowerCase() !== t.sheet.toLowerCase()
                ) {
                  continue;
                }
                replacement = restoreRangeForTable(t, first.row, first.col, second.row, second.col);
                if (replacement !== null) break;
              }
            }
            out += replacement ?? formula.slice(i, second.end);
            i = second.end;
            continue;
          }
        }
        let replacement: string | null = null;
        if (first.absolute) {
          const effSheet = first.sheet ?? formulaSheet;
          for (const t of tables) {
            if (effSheet.toLowerCase() !== t.sheet.toLowerCase()) continue;
            replacement = restoreSingleForTable(t, first.row, first.col, formulaRow);
            if (replacement !== null) break;
          }
        }
        out += replacement ?? formula.slice(i, first.end);
        i = first.end;
        continue;
      }
    }
    out += formula[i]!;
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Serialize (§18.5.1)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Encode a name/label attribute value the way Excel stores it: literal
 * `_xHHHH_` sequences are protected as `_x005F_…` and control characters
 * become `_xHHHH_` escapes (the exact inverse of decodeControlChars).
 */
function encodeControlChars(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
    .replace(/[\u0000-\u001F\u007F]/g, (ch) =>
      `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`,
    );
}

/** Attribute value for a name/label: control-char encoded + XML escaped. */
function nameAttr(s: string): string {
  return escapeXmlAttr(encodeControlChars(s));
}

/**
 * The ref the writer emits for a table: the model's own `ref` when it
 * carries one (the model is authoritative — it is NOT recomputed from
 * the sheet's cell data), else the ref computed from the model's bounds.
 */
export function tableRefOf(t: TableDef): string {
  if (t.ref && parseRef(t.ref)) {
    return t.ref.trim().replace(/\$/g, '').toUpperCase();
  }
  return `${indexToCol(t.startCol)}${t.startRow + 1}:${indexToCol(t.endCol)}${t.endRow + 1}`;
}

function boolStr(b: boolean): string {
  return b ? '1' : '0';
}

/** Formula element text: stored without a leading '=' in OOXML. */
function formulaText(f: string): string {
  return escapeXmlText(f.startsWith('=') ? f.slice(1) : f);
}

function tableColumnToXml(col: TableColumnDef, index: number): string {
  const attrs = [`id="${col.id ?? index + 1}"`, `name="${nameAttr(col.name)}"`];
  if (col.totalsRowFunction !== undefined) {
    attrs.push(`totalsRowFunction="${escapeXmlAttr(col.totalsRowFunction)}"`);
  }
  if (col.totalsRowLabel !== undefined) {
    attrs.push(`totalsRowLabel="${nameAttr(col.totalsRowLabel)}"`);
  }
  if (col.uniqueName !== undefined) attrs.push(`uniqueName="${nameAttr(col.uniqueName)}"`);
  if (col.headerRowCellStyle !== undefined) {
    attrs.push(`headerRowCellStyle="${escapeXmlAttr(col.headerRowCellStyle)}"`);
  }
  if (col.dataCellStyle !== undefined) {
    attrs.push(`dataCellStyle="${escapeXmlAttr(col.dataCellStyle)}"`);
  }
  if (col.totalsRowCellStyle !== undefined) {
    attrs.push(`totalsRowCellStyle="${escapeXmlAttr(col.totalsRowCellStyle)}"`);
  }
  let inner = '';
  if (col.calculatedColumnFormula !== undefined) {
    inner += `<calculatedColumnFormula>${formulaText(col.calculatedColumnFormula)}</calculatedColumnFormula>`;
  }
  if (col.totalsRowFormula !== undefined) {
    inner += `<totalsRowFormula>${formulaText(col.totalsRowFormula)}</totalsRowFormula>`;
  }
  return inner === ''
    ? `<tableColumn ${attrs.join(' ')}/>`
    : `<tableColumn ${attrs.join(' ')}>${inner}</tableColumn>`;
}

function tableStyleInfoToXml(info: TableStyleInfo): string {
  const attrs: string[] = [];
  if (info.name !== undefined) attrs.push(`name="${escapeXmlAttr(info.name)}"`);
  if (info.showFirstColumn !== undefined) attrs.push(`showFirstColumn="${boolStr(info.showFirstColumn)}"`);
  if (info.showLastColumn !== undefined) attrs.push(`showLastColumn="${boolStr(info.showLastColumn)}"`);
  if (info.showRowStripes !== undefined) attrs.push(`showRowStripes="${boolStr(info.showRowStripes)}"`);
  if (info.showColumnStripes !== undefined) attrs.push(`showColumnStripes="${boolStr(info.showColumnStripes)}"`);
  return `<tableStyleInfo ${attrs.join(' ')}/>`;
}

/**
 * Serialize one table definition to a complete `xl/tables/tableN.xml`
 * part (§18.5.1 CT_Table sequence: autoFilter, tableColumns,
 * tableStyleInfo). `assignedId` is the workbook-unique `<table id>`.
 * Column definitions come from `columnDetails` when present, else from
 * the plain `columns` name list.
 */
export function tableDefToXml(t: TableDef, assignedId: number): string {
  const displayName = t.displayName ?? t.name;
  const attrs = [
    `id="${assignedId}"`,
    `name="${nameAttr(t.internalName ?? displayName)}"`,
    `displayName="${nameAttr(displayName)}"`,
    `ref="${escapeXmlAttr(tableRefOf(t))}"`,
  ];
  if (t.tableType !== undefined) attrs.push(`tableType="${escapeXmlAttr(t.tableType)}"`);
  attrs.push(`headerRowCount="${t.headerRowCount ?? (t.headerRow ? 1 : 0)}"`);
  attrs.push(`totalsRowCount="${t.totalsRowCount ?? (t.totalsRow ? 1 : 0)}"`);
  attrs.push(`totalsRowShown="${boolStr(t.totalsRow)}"`);
  let inner = '';
  if (t.autoFilter) inner += autoFilterToXml(t.autoFilter);
  const cols: TableColumnDef[] =
    t.columnDetails && t.columnDetails.length > 0
      ? t.columnDetails
      : t.columns.map((name) => ({ name }));
  inner += `<tableColumns count="${cols.length}">${cols.map((c, i) => tableColumnToXml(c, i)).join('')}</tableColumns>`;
  if (t.tableStyleInfo) inner += tableStyleInfoToXml(t.tableStyleInfo);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${attrs.join(' ')}>${inner}</table>`
  );
}

/* ------------------------------------------------------------------ */
/* Write (classic package pass)                                        */
/* ------------------------------------------------------------------ */

const TABLE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml';
const TABLE_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Fresh relationship id not already used in the rels XML. */
function freshRid(relsXml: string): string {
  const used = new Set<string>();
  for (const m of relsXml.matchAll(/\bId="([^"]*)"/g)) used.add(m[1] as string);
  let n = 1;
  while (used.has(`rId${n}`)) n += 1;
  return `rId${n}`;
}

function ensureTableContentType(files: Record<string, Uint8Array>, path: string): void {
  const ctPath = '[Content_Types].xml';
  const raw = files[ctPath];
  if (!raw) return;
  const decoder = new TextDecoder();
  let xml = decoder.decode(raw);
  if (xml.includes(`PartName="/${path}"`)) return;
  if (!xml.includes('</Types>')) return;
  xml = xml.replace(
    '</Types>',
    `<Override PartName="/${path}" ContentType="${TABLE_CONTENT_TYPE}"/></Types>`,
  );
  files[ctPath] = new TextEncoder().encode(xml);
}

/**
 * Group a workbook's sheet-carried tables by sheet name (read-path
 * helper): returns sheet name → its tables, in workbook order.
 */
export function tablesBySheet(tables: readonly TableDef[]): Map<string, TableDef[]> {
  const out = new Map<string, TableDef[]>();
  for (const t of tables) {
    const list = out.get(t.sheet) ?? [];
    list.push(t);
    out.set(t.sheet, list);
  }
  return out;
}

/**
 * Attach parsed table definitions to their sheet objects as the
 * optional `tables` field (mutates the sheets). Sheets without tables
 * are left untouched. Never throws.
 */
export function attachTablesToSheets(sheets: SheetData[], tables: readonly TableDef[]): void {
  try {
    if (tables.length === 0) return;
    const bySheet = tablesBySheet(tables);
    for (const sheet of sheets) {
      const list = bySheet.get(sheet.name);
      if (list && list.length > 0) {
        (sheet as SheetDataWithTables).tables = [...list];
      }
    }
  } catch {
    // Best-effort: table attachment must never break an open.
  }
}

/**
 * Native table write for the CLASSIC adapter path: for every sheet
 * whose model carries `tables`, emit real `xl/tables/tableN.xml`
 * parts, the worksheet `<tableParts count><tablePart r:id/></tableParts>`
 * element (last element before `</worksheet>` / `<extLst>`, per the
 * CT_Worksheet sequence §18.3.1.99), sheet `.rels` entries of type
 * `…/table`, and `[Content_Types].xml` overrides. Workbooks whose
 * model carries no tables are returned byte-identical. Table ids are
 * the model's own when unique, else the smallest free positive id.
 * Never throws — on any problem the input bytes are returned unchanged.
 */
export function injectTables(
  packageBytes: Uint8Array,
  sheets: readonly SheetData[],
): Uint8Array {
  try {
    const withTables = (sheets as readonly SheetDataWithTables[]).filter(
      (s) => s.tables && s.tables.length > 0,
    );
    if (withTables.length === 0) return packageBytes;
    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;
    const parts = sheetPartPaths(files);
    if (parts.size === 0) return packageBytes;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Part numbers already taken by existing table parts.
    const usedNums = new Set<number>();
    for (const p of Object.keys(files)) {
      const m = /^xl\/tables\/table(\d+)\.xml$/i.exec(p);
      if (m) usedNums.add(parseInt(m[1] as string, 10));
    }
    const nextPartNum = (): number => {
      let n = 1;
      while (usedNums.has(n)) n += 1;
      usedNums.add(n);
      return n;
    };
    // Workbook-unique <table id> assignment (model id wins when free).
    const usedIds = new Set<number>();
    const assignId = (t: TableDef): number => {
      if (t.id !== undefined && Number.isInteger(t.id) && t.id > 0 && !usedIds.has(t.id)) {
        usedIds.add(t.id);
        return t.id;
      }
      let n = 1;
      while (usedIds.has(n)) n += 1;
      usedIds.add(n);
      return n;
    };

    let touched = false;
    for (const sheet of withTables) {
      const sheetPath = parts.get(sheet.name);
      const sheetRaw = sheetPath ? files[sheetPath] : undefined;
      if (!sheetPath || !sheetRaw) continue;
      const dir = sheetPath.slice(0, sheetPath.lastIndexOf('/'));
      const base = sheetPath.slice(sheetPath.lastIndexOf('/') + 1);
      const relsPath = `${dir}/_rels/${base}.rels`;
      let relsXml = files[relsPath]
        ? decoder.decode(files[relsPath] as Uint8Array)
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

      const rids: string[] = [];
      for (const t of sheet.tables as TableDef[]) {
        const partPath = `xl/tables/table${nextPartNum()}.xml`;
        files[partPath] = encoder.encode(tableDefToXml(t, assignId(t)));
        ensureTableContentType(files, partPath);
        const rid = freshRid(relsXml);
        const rel =
          `<Relationship Id="${rid}" Type="${TABLE_REL_TYPE}" ` +
          `Target="../tables/${partPath.split('/').pop()}"/>`;
        relsXml = relsXml.includes('</Relationships>')
          ? relsXml.replace('</Relationships>', `${rel}</Relationships>`)
          : `${relsXml}${rel}`;
        rids.push(rid);
      }
      if (rids.length === 0) continue;
      files[relsPath] = encoder.encode(relsXml);

      // <tableParts>: replace any existing block, then insert before
      // <extLst> or </worksheet> (its CT_Worksheet position).
      let sheetXml = stripBlocks(decoder.decode(sheetRaw), 'tableParts');
      if (!sheetXml.includes('xmlns:r=')) {
        sheetXml = sheetXml.replace(
          /<worksheet\b([^>]*)>/,
          `<worksheet$1 xmlns:r="${REL_NS}">`,
        );
      }
      const block =
        `<tableParts count="${rids.length}">` +
        rids.map((r) => `<tablePart r:id="${r}"/>`).join('') +
        '</tableParts>';
      const extIdx = sheetXml.indexOf('<extLst');
      const closeIdx = sheetXml.indexOf('</worksheet>');
      const at = extIdx >= 0 ? extIdx : closeIdx >= 0 ? closeIdx : sheetXml.length;
      sheetXml = sheetXml.slice(0, at) + block + sheetXml.slice(at);
      files[sheetPath] = encoder.encode(sheetXml);
      touched = true;
    }
    return touched ? zipSyncStable(files) : packageBytes;
  } catch {
    return packageBytes;
  }
}
