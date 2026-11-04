/**
 * XLSX storage adapter (SheetJS community edition).
 *
 * Honest limitations (also documented in the package README):
 * - `preservesUnknownParts` is false: SheetJS rebuilds the OOXML package from
 *   its own object model on write, so anything it does not understand
 *   (custom XML parts, embedded objects, unknown extensions) is dropped
 *   rather than preserved byte-for-byte — EXCEPT the VBA macro project
 *   (xl/vbaProject.bin), which this adapter preserves opaquely as a
 *   non-executable hint (see macroProject.ts). The `original` parameter of
 *   `write()` is therefore used only to no effect beyond that hint path.
 * - SheetJS does not calculate formulas. Formula cells are written with a
 *   placeholder cached value (0) and real formula text; a conforming reader
 *   (Excel, or this adapter feeding the Icecream engine) recalculates.
 * - Error cells (e.g. #DIV/0!) cannot be represented as CellInput, so they
 *   read back as null.
 * - Password-protected workbooks are not supported (supportsEncryption: false).
 */
import * as XLSX from 'xlsx';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { restoreXlcnHiddenFlags } from './streamingSave.js';
import { zipSyncStable } from './zipStable.js';
import {
  attachTablesToSheets,
  injectTables,
  readTables,
  restoreStructuredRefs,
  rewriteStructuredRefs,
  type SheetDataWithTables,
  type TableDef,
} from './tables.js';
import { rewriteDefinedNames, isEngineBindableName, type DefinedNameInfo } from './names.js';
import { rewriteOffsetLiterals } from './offset.js';
import type {
  AdapterCapabilities,
  CellInput,
  DefinedName,
  SheetData,
  StorageAdapter,
  WorkbookData,
} from '@icecream-sheets/engine';
import {
  MACRO_PROJECT_KEY,
  MACRO_PROJECT_PRESENT_KEY,
  base64ToU8,
  extractMacroProject,
  injectMacroProject,
  u8ToBase64,
} from './macroProject.js';
import {
  PAGE_BREAKS_META_PREFIX,
  injectSheetPageBreaks,
  readSheetPageBreaks,
  type SheetPageBreaks,
} from './pageBreaksXml.js';
import {
  PAGE_SETUP_APP_META_PREFIX,
  PRINT_TITLES_APP_META_PREFIX,
  injectSheetPageSetup,
  mergeSheetPageSetup,
  readSheetPageSetup,
  sheetPageSetupToAppModel,
  sheetPageSetupToAppTitles,
  type SheetPageSetup,
} from './pageSetupXml.js';
import { CHARTS_METADATA_KEY, readCharts } from './charts.js';
import {
  SMARTART_METADATA_KEY,
  SMARTART_PARTS_METADATA_KEY,
  injectSmartArtParts,
  readSmartArt,
} from './smartart.js';
import {
  EXTERNAL_LINKS_METADATA_KEY,
  externalLinksFromJson,
  externalLinksToJson,
  readExternalLinks,
  writeExternalLinks,
} from './externalLinks.js';
import {
  PIVOT_PARTS_METADATA_KEY,
  PIVOT_TABLES_METADATA_KEY,
  injectPivotParts,
  readPivotTables,
} from './pivotTables.js';
import { CONNECTIONS_METADATA_KEY, readConnections } from './connections.js';
import {
  MODEL_PARTS_METADATA_KEY,
  captureModelParts,
  injectModelParts,
} from './modelParts.js';
import {
  SLICER_PARTS_METADATA_KEY,
  SLICERS_TIMELINES_METADATA_KEY,
  injectSlicerTimelineParts,
  readSlicersTimelines,
  slicersTimelinesModelOf,
} from './slicersTimelines.js';
import { applyNativeProtection, injectNativeProtection } from './protectionXml.js';
import { applyNativeStyles, injectCellStyles } from './stylesXml.js';
import {
  decodeRef,
  recoverSheetFormulas,
  sheetPartPaths,
  type ZipLike,
} from './formulaRecovery.js';
import { GENERAL_FORMAT_CODE, cellFormatCode } from './numfmt.js';
import { parseSharedStrings, setBuiltinFormatTable } from './fastSheetParse.js';
import { prefixFutureFunctionsInPackage, stripFuturePrefixes } from './futureFunctions.js';
import { attachNativeSheetFeatures, injectNativeSheetFeatures } from './nativeSheetFeatures.js';
import {
  THREADED_COMMENTS_METADATA_KEY,
  attachThreadedComments,
  injectThreadedComments,
  readThreadedComments,
  threadedCommentsForWrite,
} from './threadedComments.js';
import { attachNativeDrawings, injectNativeDrawings, seedNativeDrawingDisplayModels } from './drawings.js';
import {
  METADATA_REL_TYPE,
  RICH_VALUES_METADATA_KEY,
  RICH_VALUE_PARTS_METADATA_KEY,
  injectRichValueParts,
  readRichValues,
  richValuesModelOf,
  type RichValueRawParts,
  type RichValuesModel,
} from './richValues.js';
import {
  SPILL_METADATA_KEY_PREFIX,
  applySpillsToSheetXml,
  parseSheetSpills,
  type SheetSpills,
  type SpillRange,
} from './spillMetadata.js';

// Wire SheetJS's SSF built-in numFmt table into the fast sheet parser:
// both paths resolve built-in format ids through the identical table.
try {
  const ssfNs = XLSX as unknown as {
    SSF?: { _table?: Record<number, string> };
    default?: { SSF?: { _table?: Record<number, string> } };
  };
  const table = ssfNs.SSF?._table ?? ssfNs.default?.SSF?._table;
  if (table) setBuiltinFormatTable({ ...table });
} catch {
  // Fast parse keeps its General-only fallback table; SheetJS path unaffected.
}

/**
 * Unzip an XLSX package once into a path → bytes record (the shared input
 * every zip-level stage and the fast sheet parser work from). Undefined
 * when the bytes are not a readable ZIP package.
 */
export function unzipPackage(buffer: Uint8Array): ZipLike | undefined {
  try {
    const unzipped = unzipSync(buffer.slice());
    const out: ZipLike = {};
    for (const [path, data] of Object.entries(unzipped)) out[path] = data as Uint8Array;
    return out;
  } catch {
    return undefined;
  }
}

const METADATA_PREFIX = 'xlsx.pageSetup.';

/** A formula that is exactly a defined-name reference, e.g. `=Global4`. */
const BARE_NAME_REF_RE = /^\s*=\s*[A-Za-z_][A-Za-z0-9_.]*\s*$/;
/** A formula that is exactly an inlined array constant, e.g. `={1,2,3;4,5,6}`. */
const ARRAY_CONST_FORMULA_RE = /^=\{[\s\S]*\}$/;

/**
 * Expand inlined array-constant formulas whose spill area is blocked.
 *
 * When defined-name rewriting inlines an array constant for a bare name
 * reference (`=Global4` -> `={1,2,3;4,5,6}`), the engine treats it as a
 * dynamic spill. Legacy files (e.g. ClosedXML's named-ranges-global) carry
 * occupied cells across the spill area with per-cell cached values instead
 * of #SPILL! — so when any cell of the spill area other than the origin is
 * occupied, write each constant element as an individual static value
 * (matching the file's cached values) rather than leaving a spill formula
 * that errors. When the area is free the formula is left alone and the
 * engine spills naturally.
 */
function expandBlockedArrayConsts(
  rows: CellInput[][],
  cells: Array<{ r: number; c: number; constText: string }>,
): void {
  for (const { r, c, constText } of cells) {
    const matrix = parseArrayConstant(constText);
    if (!matrix || matrix.length === 0) continue;
    const nRows = matrix.length;
    const nCols = Math.max(...matrix.map((row) => row.length));
    if (nCols === 0) continue;
    let blocked = false;
    for (let dr = 0; dr < nRows && !blocked; dr++) {
      for (let dc = 0; dc < nCols && !blocked; dc++) {
        if (dr === 0 && dc === 0) continue;
        const cur: CellInput | undefined = rows[r + dr]?.[c + dc];
        if (cur !== null && cur !== undefined && cur !== '') blocked = true;
      }
    }
    if (!blocked) continue;
    for (let dr = 0; dr < nRows; dr++) {
      while (rows.length <= r + dr) rows.push([]);
      const row = rows[r + dr]!;
      while (row.length <= c + nCols - 1) row.push(null);
      const mrow = matrix[dr]!;
      for (let dc = 0; dc < nCols; dc++) {
        row[c + dc] = mrow[dc] === undefined ? null : mrow[dc]!;
      }
    }
  }
}

/**
 * Parse an Excel array constant (`{1,2,3;4,5,6}`) into rows of cell inputs.
 * Returns null when the text is not a well-formed constant. Quoted strings
 * (with `""` escapes), TRUE/FALSE, numbers and error literals are mapped to
 * their CellInput forms; a string element starting with '=' is given the
 * apostrophe escape so the engine keeps it as text.
 */
function parseArrayConstant(text: string): CellInput[][] | null {
  if (text.length < 2 || text[0] !== '{' || text[text.length - 1] !== '}') return null;
  const inner = text.slice(1, -1);
  const rows: CellInput[][] = [];
  let cur: CellInput[] = [];
  let token = '';
  let tokenQuoted = false;
  let inStr = false;
  let valid = true;
  const pushToken = (): void => {
    if (tokenQuoted) {
      const s = token;
      cur.push(s.startsWith('=') && s.length > 1 ? `'${s}` : s);
    } else {
      const t = token.trim();
      if (/^(true|false)$/i.test(t)) {
        cur.push(t.toLowerCase() === 'true');
      } else if (t !== '' && ERROR_CELL_LITERALS.has(t.toUpperCase())) {
        cur.push(t.toUpperCase());
      } else if (t !== '' && t !== '.' && t !== '-' && t !== '+' && !Number.isNaN(Number(t))) {
        const n = Number(t);
        cur.push(Number.isFinite(n) ? n : null);
      } else if (t === '') {
        cur.push(null);
      } else {
        valid = false; // unparseable element: not a well-formed constant
      }
    }
    token = '';
    tokenQuoted = false;
  };
  for (let i = 0; i < inner.length && valid; i++) {
    const ch = inner[i]!;
    if (inStr) {
      if (ch === '"') {
        if (inner[i + 1] === '"') {
          token += '"';
          i++;
        } else {
          inStr = false;
        }
      } else {
        token += ch;
      }
    } else if (ch === '"') {
      inStr = true;
      tokenQuoted = true;
    } else if (ch === ',') {
      pushToken();
    } else if (ch === ';') {
      pushToken();
      rows.push(cur);
      cur = [];
    } else {
      token += ch;
    }
  }
  if (inStr) return null; // unterminated string
  pushToken();
  rows.push(cur);
  return valid ? rows : null;
}
/**
 * App-owned metadata keys (pictures, page setup, …) are carried inside the
 * XLSX package via document custom properties, so they round-trip through
 * real Excel files. Key mapping: metadata `icecream.foo` ↔ custom property
 * `IcecreamSheets.Meta.icecream.foo`. Values are JSON strings.
 */
const APP_META_PREFIX = 'icecream.';
const CUSTPROP_PREFIX = 'IcecreamSheets.Meta.';

/** Inputs assembleFromParsedSheets needs beyond the parsed sheets. */
export interface AssembleOptions {
  definedNames: DefinedName[];
  nameInfos: DefinedNameInfo[];
  /** SheetJS Custprops object, or the fast path's raw-XML equivalent. */
  custProps?: unknown;
  sheetNames: string[];
  /** Fast path: formulas were already recovered during the sheet parse. */
  skipFormulaRecovery: boolean;
  /** Pre-unzipped package (unzipPackage) — avoids a second unzip here. */
  sharedZip?: ZipLike;
  /**
   * Precomputed zip-level metadata (XlsxAdapter.extractZipMetadata) — the
   * streaming path extracts it before parsing sheets (it is the stream's
   * first chunk) and hands it in so it is not computed twice.
   */
  metadata?: Record<string, unknown>;
}

export class XlsxAdapter implements StorageAdapter {
  readonly name = 'xlsx';

  readonly capabilities: AdapterCapabilities = {
    readable: true,
    writable: true,
    transactional: false,
    // SheetJS parses the workbook into its own model and re-serializes from
    // scratch on write; unknown OOXML parts cannot survive the round-trip.
    preservesUnknownParts: false,
    supportsEncryption: false,
  };

  read(buffer: Uint8Array): WorkbookData {
    // SheetJS is lenient with garbage input, so validate the container
    // signature ourselves: a genuine .xlsx is always a ZIP package
    // (PK\x03\x04); a legacy .xls is an OLE2 compound file
    // (D0 CF 11 E0) whose BIFF workbook SheetJS parses through the same
    // read — .xls support (sweep finding F-2) is exactly this second
    // signature; everything else is rejected as before.
    const isZip =
      buffer.length >= 4 &&
      buffer[0] === 0x50 && // 'P'
      buffer[1] === 0x4b && // 'K'
      buffer[2] === 0x03 &&
      buffer[3] === 0x04;
    const isOle2 =
      buffer.length >= 4 &&
      buffer[0] === 0xd0 &&
      buffer[1] === 0xcf &&
      buffer[2] === 0x11 &&
      buffer[3] === 0xe0;
    if (!isZip && !isOle2) {
      throw new Error(
        'XlsxAdapter.read: not a readable spreadsheet package (missing ZIP or OLE2 signature)',
      );
    }
    let wb: XLSX.WorkBook;
    try {
      // .slice() copies so the caller's bytes are never mutated. Uint8Array
      // with type:'array' is the browser-safe path — Node's Buffer does not
      // exist in the browser bundle (this broke file-open in the web app).
      // cellNF:true resolves each cell's style index through xl/styles.xml
      // (built-in numFmtIds 0-163 plus custom <numFmt> entries via <cellXfs>)
      // into cell.z — the Excel number format code (see numfmt.ts). Without
      // it, imported files lose all number formatting (raw floats render).
      // cellStyles:true is required for SheetJS to parse !cols/!rows
      // (column widths, row heights, hidden flags).
      wb = XLSX.read(buffer.slice(), { type: 'array', cellNF: true, cellStyles: true });
    } catch (error) {
      throw new Error(
        `XlsxAdapter.read: not a readable XLSX package (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    const sheets: SheetData[] = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      if (!ws) throw new Error(`XlsxAdapter.read: sheet "${name}" missing from workbook`);
      const { rows, formats, colWidths, rowHeights, hiddenCols, hiddenRows } = worksheetToRows(ws);
      const sheet: SheetData = { name, rows };
      // Only carry formats when at least one cell has a non-General format;
      // the web UI seeds its format store from this (numfmt.ts).
      if (Object.keys(formats).length > 0) sheet.formats = formats;
      // Column/row dimensions are pure UI hints; the web UI seeds its
      // colWidths/rowHeights maps from these on file open.
      if (colWidths) sheet.colWidths = colWidths;
      if (rowHeights) sheet.rowHeights = rowHeights;
      if (hiddenCols) sheet.hiddenCols = hiddenCols;
      if (hiddenRows) sheet.hiddenRows = hiddenRows;
      return sheet;
    });

    // Defined names (named ranges): SheetJS exposes them via Workbook.Names.
    // Without these, every =MyName formula is #NAME?. They are registered
    // as HyperFormula named expressions by the engine, which resolves a
    // name to its identity at parse time and tracks it through structural
    // changes (design-docs/named-ranges-and-named-functions.md §5).
    const definedNames: DefinedName[] = [];
    const nameInfos: DefinedNameInfo[] = [];
    const wbNames = (wb.Workbook as unknown as { Names?: unknown })?.Names;
    if (Array.isArray(wbNames)) {
      for (const n of wbNames as Array<{ Name?: unknown; Ref?: unknown; Sheet?: unknown }>) {
        if (typeof n.Name !== 'string' || typeof n.Ref !== 'string') continue;
        // Skip print areas/titles — they're not formula names.
        if (n.Name.startsWith('_xlnm.')) continue;
        // Dangling names (#REF!) are kept: the service import marks them
        // dangling and the engine binds =#REF!, so formulas show #REF!
        // (never silently rebound — §1).
        // SheetJS does NOT strip _xlfn storage prefixes from defined
        // names (it does for cell formulas) — strip here so a LAMBDA
        // name reaches the engine bare (audit §9.4).
        const bareRef = stripFuturePrefixes(n.Ref);
        definedNames.push({
          name: n.Name,
          ref: bareRef,
          sheet: typeof n.Sheet === 'number' ? n.Sheet : undefined,
        });
        nameInfos.push({
          name: n.Name,
          ref: bareRef,
          sheet: typeof n.Sheet === 'number' ? n.Sheet : undefined,
        });
      }
    }
    const custProps: unknown = (wb as unknown as { Custprops?: unknown }).Custprops;
    return this.assembleFromParsedSheets(buffer, sheets, {
      definedNames,
      nameInfos,
      custProps,
      sheetNames: wb.SheetNames,
      skipFormulaRecovery: false,
    });
  }

  /**
   * Shared post-parse assembly for both read paths: everything that turns
   * per-sheet rows into a complete WorkbookData — formula recovery
   * (SheetJS path only; the fast parser recovers inline), structured-ref
   * rewrites, all zip-level metadata families, defined-name rewrites and
   * the OFFSET rewrite. Extracted so the fast parallel parse
   * (fastSheetParse.ts, driven from the gateway engine service) produces
   * identical WorkbookData to the SheetJS read.
   */
  assembleFromParsedSheets(buffer: Uint8Array, sheets: SheetData[], opts: AssembleOptions): WorkbookData {
    const definedNames = opts.definedNames;
    const nameInfos = opts.nameInfos;
    const custProps = opts.custProps;
    // Structured table references: SheetJS drops table definitions, so read
    // them from the raw ZIP and rewrite Table[Column] syntax into A1 ranges.
    // Without this, every structured reference is a #ERROR (parse failure).
    //
    // Formula recovery (formulaRecovery.ts): SheetJS CE drops formula cells
    // that have no cached <v> value and cannot resolve shared formulas
    // (t="shared" slaves), and it trusts a sometimes-stale <dimension>.
    // Recover formula text + the true used range from the raw worksheet XML
    // BEFORE the rewrites below so recovered formulas get the same
    // structured-ref / defined-name / OFFSET treatment. Best-effort: any
    // failure keeps the SheetJS-only behavior.
    // Perf (2026-10-19): unzip the package ONCE and share the entries
    // across every metadata stage below (formula recovery, tables, charts,
    // pivots, SmartArt, page setup/breaks, protection, links, connections,
    // macro project). The old code unzipped the same bytes ~8 times.
    let sharedZip: ZipLike | undefined = opts.sharedZip;
    if (sharedZip === undefined) {
      try {
        const unzipped = unzipSync(buffer.slice());
        sharedZip = {};
        for (const [path, data] of Object.entries(unzipped)) sharedZip[path] = data as Uint8Array;
      } catch {
        // Best-effort: a corrupt package still yields the SheetJS parse above.
        sharedZip = undefined;
      }
    }
    try {
      const zipLike = opts.skipFormulaRecovery ? undefined : sharedZip;
      if (zipLike === undefined) throw new Error('no zip');
      const parts = sheetPartPaths(zipLike);
      if (parts.size > 0) {
        const decoder = new TextDecoder();
        for (const sheet of sheets) {
          const path = parts.get(sheet.name);
          const raw = path ? zipLike[path] : undefined;
          if (!raw) continue;
          const hasCell = (ref: string): boolean => {
            const rc = decodeRef(ref);
            if (!rc) return true; // unparseable ref: don't touch
            const v = sheet.rows[rc.r]?.[rc.c];
            return v !== null && v !== undefined && v !== '';
          };
          const { formulas, maxRow, maxCol } = recoverSheetFormulas(decoder.decode(raw), hasCell);
          while (sheet.rows.length <= maxRow) sheet.rows.push([]);
          for (const row of sheet.rows) {
            while (row.length <= maxCol) row.push(null);
          }
          for (const [ref, text] of formulas) {
            const rc = decodeRef(ref);
            const row = rc ? sheet.rows[rc.r] : undefined;
            if (!rc || !row) continue;
            if (row[rc.c] === null || row[rc.c] === undefined || row[rc.c] === '') {
              row[rc.c] = `=${text}`;
            }
          }
        }
      }
    } catch {
      // Best-effort: formula recovery must never break the open.
    }
    let tables: TableDef[] = [];
    try {
      const zipLike = sharedZip;
      if (zipLike === undefined) throw new Error('no zip');
      tables = readTables(zipLike, opts.sheetNames);
    } catch {
      // Table extraction is best-effort; the workbook still loads.
    }
    if (tables.length > 0) {
      for (const sheet of sheets) {
        for (let r = 0; r < sheet.rows.length; r++) {
          const row = sheet.rows[r];
          if (!row) continue;
          for (let c = 0; c < row.length; c++) {
            const v = row[c];
            if (typeof v === 'string' && v.startsWith('=') && v.includes('[')) {
              row[c] = rewriteStructuredRefs(v, r, tables);
            }
          }
        }
      }
      // Full table definitions (audit §11): attach them to their sheet
      // objects as the optional `tables` field so the classic write path
      // can re-emit real xl/tables/tableN.xml parts (tables.ts). The
      // structured-ref rewrite above is unchanged.
      attachTablesToSheets(sheets, tables);
    }

    // Zip-level metadata extraction is shared with the streaming load
    // path (gateway engine service): the metadata chunk of a /load/stream
    // response is exactly this record, computed before any sheet parses.
    const metadata = opts.metadata ?? XlsxAdapter.extractZipMetadata(buffer, sharedZip, custProps);

    // Narrow fallback rewrite: HyperFormula rejects defined names matching
    // its A1/R1C1 heuristics ([A-Za-z]+[0-9]+, e.g. "Global1") even though
    // Excel allows them. Only THOSE names are rewritten to A1 in formulas
    // (otherwise the file's formulas would be #NAME?); every bindable name
    // keeps its identity so the engine tracks it through structural changes
    // and redefinitions (§5 — no baked-in addresses).
    const unbindable = nameInfos.filter((ni) => !isEngineBindableName(ni.name));
    if (unbindable.length > 0) {
      for (let si = 0; si < sheets.length; si++) {
        const sheet = sheets[si]!;
        // Cells where a bare defined-name reference was inlined to an array
        // constant (e.g. =Global4 -> ={1,2,3;4,5,6}): when the spill area is
        // blocked by occupied cells the engine reports #SPILL!, but the
        // source file carries per-cell cached values — expand the constant
        // into individual values instead (see expandBlockedArrayConsts).
        const inlinedConsts: Array<{ r: number; c: number; constText: string }> = [];
        for (let r = 0; r < sheet.rows.length; r++) {
          const row = sheet.rows[r];
          if (!row) continue;
          for (let c = 0; c < row.length; c++) {
            const v = row[c];
            if (typeof v === 'string' && v.startsWith('=')) {
              const wasBareName = BARE_NAME_REF_RE.test(v);
              const rewritten = rewriteDefinedNames(v, sheet.name, si, opts.sheetNames, unbindable);
              row[c] = rewritten;
              if (wasBareName && ARRAY_CONST_FORMULA_RE.test(rewritten)) {
                inlinedConsts.push({ r, c, constText: rewritten.slice(1) });
              }
            }
          }
        }
        if (inlinedConsts.length > 0) expandBlockedArrayConsts(sheet.rows, inlinedConsts);
      }
    }
    // Native cell styles (fonts/fills/borders/alignment in xl/styles.xml):
    // SheetJS CE surfaces only the number format code (cell.z), so parse
    // the full style model from the package into SheetData.styles — the
    // UI seeds its format store from it and the write path re-emits it
    // (stylesXml.ts, defect D4). Best-effort like every zip-level stage.
    try {
      applyNativeStyles(sheets, sharedZip, buffer);
    } catch {
      // keep the SheetJS-only behavior
    }
    // Native worksheet features (mergeCells, autoFilter/sortState,
    // dataValidations, conditionalFormatting, sparklines — audit §§4.3,
    // 5.1, 6.1, 14.3, 14.4): SheetJS drops all of them, so parse the
    // worksheet parts directly onto the sheet objects as optional
    // fields. Runs for BOTH read paths (this assembly is their shared
    // funnel). Best-effort.
    try {
      attachNativeSheetFeatures(sheets, sharedZip);
    } catch {
      // keep the SheetJS-only behavior
    }
    // Threaded comments + persons (audit §3.2; [MS-XLSX] §2.6.203–205):
    // threads attach onto the sheet objects as an optional field, and
    // the workbook model (persons + threads) is carried in metadata —
    // extractZipMetadata already filled the key; backfill it here when
    // a caller handed in precomputed metadata without it.
    try {
      const threaded = attachThreadedComments(sheets, sharedZip);
      if (threaded && metadata[THREADED_COMMENTS_METADATA_KEY] === undefined) {
        metadata[THREADED_COMMENTS_METADATA_KEY] = JSON.stringify(threaded);
      }
    } catch {
      // keep the SheetJS-only behavior
    }
    // Native pictures & shapes in drawings (audit §13.2): SheetJS drops
    // drawing parts, so parse xdr:pic / xdr:sp from the package onto the
    // sheet objects as optional fields (nativePictures / nativeShapes /
    // nativeDrawingsRaw — drawings.ts). Runs for BOTH read paths (this
    // assembly is their shared funnel). Best-effort.
    try {
      attachNativeDrawings(sheets, sharedZip);
    } catch {
      // keep the SheetJS-only behavior
    }
    // Display models for those drawings (File-2 defect D1): seed the
    // app-owned `icecream.pictures` / `icecream.textboxes` metadata the
    // web app hydrates its overlays from, when the file carries no
    // app-owned value of its own. Without this, imported pictures and
    // text shapes parse onto the sheet objects but reach no renderer.
    try {
      seedNativeDrawingDisplayModels(sheets, metadata);
    } catch {
      // keep the SheetJS-only behavior
    }
    // OFFSET with cell-ref args (e.g. =OFFSET(N43,$E$9,0)): HyperFormula
    // requires static numbers, but Excel allows cell refs. Substitute literal
    // values at load time. Independent of defined-name rewriting.
    for (const sheet of sheets) {
      for (let r = 0; r < sheet.rows.length; r++) {
        const row = sheet.rows[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (typeof v === 'string' && v.startsWith('=') && /OFFSET\s*\(/i.test(v)) {
            const grid = sheet.rows;
            row[c] = rewriteOffsetLiterals(v, (rr, cc) => grid[rr]?.[cc]);
          }
        }
      }
    }

    return { sheets, metadata, definedNames };
  }

  /**
   * All zip-level metadata families for a workbook, in the exact order
   * and with the exact precedence the read path has always used. Depends
   * only on the package bytes — never on parsed rows — so the streaming
   * load path can emit it as the first chunk before any sheet is parsed.
   */
  static extractZipMetadata(
    buffer: Uint8Array,
    sharedZip: ZipLike | undefined,
    custProps: unknown,
  ): Record<string, unknown> {
    // Native page-setup round-trip (design-docs/print-and-page-layout.md §5):
    // SheetJS CE only surfaces ws['!pageSetup'] (orientation, paper size,
    // scale, fit-to-page) and drops <pageMargins>, <headerFooter>, and the
    // _xlnm.Print_Area / _xlnm.Print_Titles defined names entirely. Parse
    // the package directly so all of it survives. Native settings also
    // seed the app-owned `icecream.pagesetup.<sheet>` /
    // `icecream.printtitles.<sheet>` models so the Page Setup dialog shows
    // the file's real settings on open; app-owned custom properties
    // restored below still win (the user's own edits beat file defaults).
    const metadata: Record<string, unknown> = {};
    try {
      for (const [name, setup] of readSheetPageSetup(buffer, sharedZip)) {
        // JSON round-trip gives a plain deep copy and drops undefined fields.
        metadata[`${METADATA_PREFIX}${name}`] = JSON.parse(JSON.stringify(setup)) as unknown;
        metadata[`${PAGE_SETUP_APP_META_PREFIX}${name}`] = sheetPageSetupToAppModel(setup);
        const titles = sheetPageSetupToAppTitles(setup);
        if (titles !== null) metadata[`${PRINT_TITLES_APP_META_PREFIX}${name}`] = titles;
      }
    } catch {
      // Best-effort: page setup must never break the open.
    }
    // Restore app-owned metadata (pictures, page setup, …) from custom properties.
    if (custProps !== undefined && custProps !== null && typeof custProps === 'object') {
      for (const [prop, value] of Object.entries(custProps as Record<string, unknown>)) {
        if (prop.startsWith(CUSTPROP_PREFIX) && typeof value === 'string') {
          const key = prop.slice(CUSTPROP_PREFIX.length);
          if (key.startsWith(APP_META_PREFIX)) {
            try {
              metadata[key] = JSON.parse(value) as unknown;
            } catch {
              // Corrupt custom property: skip rather than failing the open.
            }
          }
        }
      }
    }
    // Native page-break round-trip (design-docs/print-and-page-layout.md §5):
    // SheetJS CE ignores <rowBreaks>/<colBreaks>, so parse the worksheet XML
    // directly. Native breaks win over the custom-property hint (an
    // Excel-edited file may have newer breaks than the stored metadata).
    try {
      for (const [name, breaks] of readSheetPageBreaks(buffer, sharedZip)) {
        metadata[`${PAGE_BREAKS_META_PREFIX}${name}`] = { rows: [...breaks.rows], cols: [...breaks.cols] };
      }
    } catch {
      // Best-effort: page breaks must never break the open.
    }
    // Native drawingML chart import (SheetJS CE drops charts): parse the
    // drawing/chart parts directly and carry the imported charts through
    // metadata so the web app can render them as chart overlays. Native
    // charts win when present (an Excel-edited file may have newer charts
    // than the stored metadata); otherwise the custom-property hint is kept
    // so charts — and their trendlines — survive an app save, which drops
    // drawing parts via SheetJS.
    try {
      const zipLike = sharedZip;
      if (zipLike === undefined) throw new Error('no zip');
      const native = readCharts(zipLike);
      if (native.length > 0) {
        metadata[CHARTS_METADATA_KEY] = JSON.stringify(native);
      } else if (metadata[CHARTS_METADATA_KEY] === undefined) {
        metadata[CHARTS_METADATA_KEY] = '[]';
      }
    } catch {
      // Best-effort: chart import must never break the open.
    }
    // Workbook connections (#114): the data-model connection (and the
    // worksheet range connections feeding it) are zip-level facts like
    // the pivots below — the fast /load path never runs the full read,
    // so without this the server-side model builder has no connections
    // to gate on and every OLAP query 404s. Best-effort, same pattern.
    try {
      if (sharedZip !== undefined) {
        const connections = readConnections(buffer, sharedZip);
        if (connections.length > 0) {
          metadata[CONNECTIONS_METADATA_KEY] = JSON.stringify(connections);
        }
      }
    } catch {
      // Best-effort: connections must never break the open.
    }
    // Native pivot table import (SheetJS CE drops pivotCache/pivotTable
    // parts): parse the caches + table definitions directly and carry the
    // imported pivots through metadata so the web app can compute their
    // layout via the service pivot component and render them. The raw part
    // bytes are stashed under a separate (non-`icecream.`) key so the write
    // path can re-inject them byte-for-byte without duplicating base64 bulk
    // into custom properties.
    try {
      const zipLike = sharedZip;
      if (zipLike === undefined) throw new Error('no zip');
      const { tables: pivotTables, rawParts } = readPivotTables(zipLike);
      metadata[PIVOT_TABLES_METADATA_KEY] = JSON.stringify(pivotTables);
      if (Object.keys(rawParts.parts).length > 0) {
        metadata[PIVOT_PARTS_METADATA_KEY] = rawParts;
      }
    } catch {
      // Best-effort: pivot import must never break the open.
    }
    // Native slicer + timeline import (audit §§4.1–4.2, §7.4; SheetJS CE
    // drops slicerCaches/slicers/timelineCaches/timelines parts): parse the
    // caches, per-sheet views, pivot linkage, and drawing references into
    // the typed model and carry it through metadata; the raw part bytes go
    // under a non-`icecream.` key as the write path's fallback.
    try {
      const zipLike = sharedZip;
      if (zipLike === undefined) throw new Error('no zip');
      const stResult = readSlicersTimelines(zipLike);
      metadata[SLICERS_TIMELINES_METADATA_KEY] = JSON.stringify(slicersTimelinesModelOf(stResult));
      if (Object.keys(stResult.rawParts.parts).length > 0) {
        metadata[SLICER_PARTS_METADATA_KEY] = stResult.rawParts;
      }
    } catch {
      // Best-effort: slicer/timeline import must never break the open.
    }
    // Native rich values / linked data types (audit §9.2, Phase E piece B):
    // parse xl/metadata.xml + xl/richData/* + worksheet vm refs into the
    // typed model and carry it through metadata as a JSON string (same
    // shape as the slicer model above); raw part bytes under the
    // non-`icecream.` key so the write path can fall back to them.
    // Shared-string fallback resolution (piece B residual R5): a cellRef
    // with t="s" carries the raw shared-string INDEX as its cachedValue
    // from the parser; resolve it here, where the table is at hand, so
    // the model the app sees carries the real fallback string.
    try {
      const zipLike = sharedZip;
      if (zipLike === undefined) throw new Error('no zip');
      const rvResult = readRichValues(zipLike as Record<string, Uint8Array>);
      const model = richValuesModelOf(rvResult);
      const ssRaw = zipLike['xl/sharedStrings.xml'];
      if (ssRaw) {
        try {
          const table = parseSharedStrings(new TextDecoder().decode(ssRaw));
          for (const ref of model.cellRefs) {
            if (ref.cellType === 's' && ref.cachedValue !== undefined) {
              const idx = Number(ref.cachedValue);
              if (Number.isInteger(idx) && table[idx] !== undefined) ref.cachedValue = table[idx];
            }
          }
        } catch {
          // Unresolved shared-string fallbacks keep their index text.
        }
      }
      const hasRich =
        model.metadata.types.length > 0 ||
        model.metadata.futureMetadata.length > 0 ||
        model.metadata.valueMetadata.length > 0 ||
        model.cellRefs.length > 0;
      if (hasRich) {
        metadata[RICH_VALUES_METADATA_KEY] = JSON.stringify(model);
      }
      if (Object.keys(rvResult.rawParts.parts).length > 0) {
        metadata[RICH_VALUE_PARTS_METADATA_KEY] = rvResult.rawParts;
      }
    } catch {
      // Best-effort: rich-value import must never break the open.
    }
    // Dynamic-array spill metadata (audit §9.3, Phase E piece C): parse
    // each worksheet's <f t="array"> anchors into typed SpillRanges and
    // carry them per sheet under `xlsx.spill.<sheetName>` (JSON string).
    // Shared strings are passed so t="s" cached member values resolve.
    try {
      const zipLike = sharedZip;
      if (zipLike === undefined) throw new Error('no zip');
      const decoder = new TextDecoder();
      let sharedStrings: string[] | undefined;
      const ssRaw = zipLike['xl/sharedStrings.xml'];
      if (ssRaw) {
        try {
          sharedStrings = parseSharedStrings(decoder.decode(ssRaw));
        } catch {
          sharedStrings = undefined;
        }
      }
      const parts = sheetPartPaths(zipLike);
      for (const [sheetName, path] of parts) {
        const raw = zipLike[path];
        if (!raw) continue;
        const parsed: SheetSpills = parseSheetSpills(decoder.decode(raw), { sharedStrings });
        if (parsed.spills.length > 0 || parsed.spillRefs.length > 0) {
          metadata[`${SPILL_METADATA_KEY_PREFIX}${sheetName}`] = JSON.stringify(parsed);
        }
      }
    } catch {
      // Best-effort: spill import must never break the open.
    }
    // Native SmartArt (drawingML diagram) import (SheetJS CE drops diagrams):
    // parse the diagram parts directly and carry the imported diagrams
    // through metadata so the web app can render them as overlays. The raw
    // part bytes are stashed under a separate (non-`icecream.`) key so the
    // write path can re-emit them byte-for-byte.
    try {
      const zipLike = sharedZip;
      if (zipLike === undefined) throw new Error('no zip');
      const { diagrams, rawParts } = readSmartArt(zipLike);
      metadata[SMARTART_METADATA_KEY] = JSON.stringify(diagrams);
      if (Object.keys(rawParts.parts).length > 0) {
        metadata[SMARTART_PARTS_METADATA_KEY] = rawParts;
      }
    } catch {
      // Best-effort: SmartArt import must never break the open.
    }
    // Macro project preservation (design-docs/automation-lane.md §6): stash
    // the raw vbaProject.bin bytes as an opaque, non-executable hint so a
    // .xlsm survives the round-trip. The bytes are never parsed or executed.
    const macroProject = extractMacroProject(buffer, sharedZip);
    if (macroProject !== null) {
      metadata[MACRO_PROJECT_PRESENT_KEY] = true;
      metadata[MACRO_PROJECT_KEY] = u8ToBase64(macroProject);
    }
    // External workbook links (xl/externalLinks/*.xml): parse the target
    // workbook names, sheet names, and cached values (sheetDataSet) into
    // metadata. The engine binds [N]Sheet!Ref formulas to the ICEEXTREF
    // dispatcher and resolves through this table (cached values when the
    // referenced file is unavailable, #REF! with no cached value).
    // Best-effort: link metadata must never break the open.
    try {
      const links = readExternalLinks(buffer, sharedZip);
      if (links.length > 0) metadata[EXTERNAL_LINKS_METADATA_KEY] = externalLinksToJson(links);
    } catch {
      // keep the SheetJS-only behavior
    }

    // Workbook connections (xl/connections.xml): data-model connection
    // names (the first argument of the CUBE* functions) and the worksheet
    // ranges that feed them, so the host can rebuild local OLAP cubes for
    // CUBEVALUE/CUBEMEMBER formulas (the model itself is not in the file).
    // Best-effort: connection metadata must never break the open.
    try {
      const connections = readConnections(buffer, sharedZip);
      if (connections.length > 0) {
        metadata[CONNECTIONS_METADATA_KEY] = JSON.stringify(connections);
      }
    } catch {
      // keep the SheetJS-only behavior
    }

    // Data-model parts (#114 save constraint): capture the original
    // connections.xml + xl/model/* bytes (plus their workbook rels and
    // content-type overrides) so the write path can re-inject them
    // verbatim — SheetJS would otherwise drop the file's data model
    // on save. Best-effort: must never break the open.
    try {
      const modelParts = captureModelParts(sharedZip as Record<string, Uint8Array>);
      if (modelParts) {
        metadata[MODEL_PARTS_METADATA_KEY] = JSON.stringify(modelParts);
      }
    } catch {
      // keep the SheetJS-only behavior
    }

    // Threaded comments + persons (audit §3.2; [MS-XLSX] §2.6.203–205):
    // SheetJS CE drops both part families, so parse them directly and
    // carry the workbook model (persons + per-sheet threads) in metadata.
    // The per-sheet fields are attached in assembleFromParsedSheets.
    try {
      const zipLike = sharedZip;
      if (zipLike === undefined) throw new Error('no zip');
      const threaded = readThreadedComments(zipLike);
      if (threaded.persons.length > 0 || threaded.sheets.length > 0) {
        metadata[THREADED_COMMENTS_METADATA_KEY] = JSON.stringify(threaded);
      }
    } catch {
      // Best-effort: threaded comments must never break the open.
    }

    // Native protection round-trip (design §5): SheetJS CE drops
    // <sheetProtection>, <workbookProtection> and cell-xf locked/hidden
    // flags, so parse them from the raw package (see protectionXml.ts).
    // Native XML wins over the custom-property hint when both are present
    // (an Excel-edited file may be newer than the stored metadata).
    try {
      applyNativeProtection(buffer, metadata, sharedZip);
    } catch {
      // Best-effort: protection hints must never break the open.
    }
    return metadata;
  }

  /**
   * Serialize workbook data to XLSX bytes.
   *
   * `original` is accepted per the StorageAdapter contract but intentionally
   * unused: SheetJS rebuilds the OOXML package from its own object model, so
   * unknown parts of an original file cannot be preserved byte-for-byte
   * (see preservesUnknownParts: false) — except the VBA macro project hint,
   * which is re-injected from metadata (see macroProject.ts).
   */
  write(data: WorkbookData, _original?: Uint8Array): Uint8Array {
    // Item B: structured references were rewritten to A1 ranges at
    // import (the engine cannot parse the structured syntax), so the
    // model only carries A1 forms. Restore them at this serialization
    // boundary from the workbook's table definitions (gathered from
    // every sheet's `tables` field — a formula on one sheet may
    // reference a table on another). No input mutation: only sheets
    // whose formulas actually change get a copied rows array.
    const allTables: TableDef[] = [];
    for (const s of data.sheets) {
      const t = (s as SheetDataWithTables).tables;
      if (t && t.length > 0) allTables.push(...t);
    }
    let effectiveSheets = data.sheets;
    if (allTables.length > 0) {
      effectiveSheets = data.sheets.map((sheet) => {
        let sheetChanged = false;
        const rows = sheet.rows.map((row, r) => {
          let rowChanged = false;
          const newRow = row.map((cell) => {
            if (typeof cell === 'string' && cell.startsWith('=') && cell.includes('$')) {
              const restored = restoreStructuredRefs(cell, r, sheet.name, allTables);
              if (restored !== cell) rowChanged = true;
              return restored;
            }
            return cell;
          });
          if (rowChanged) sheetChanged = true;
          return rowChanged ? newRow : row;
        });
        return sheetChanged ? { ...sheet, rows } : sheet;
      });
    }
    const wb = XLSX.utils.book_new();
    for (const sheet of effectiveSheets) {
      const ws = rowsToWorksheet(sheet.rows, sheet);
      XLSX.utils.book_append_sheet(wb, ws, sheet.name);
    }
    // Persist app-owned metadata (pictures, page setup, …) as custom
    // properties so they survive the round trip through real .xlsx files.
    const custProps: Record<string, string> = {};
    for (const [key, value] of Object.entries(data.metadata)) {
      if (key.startsWith(APP_META_PREFIX) && value !== undefined) {
        try {
          custProps[`${CUSTPROP_PREFIX}${key}`] = JSON.stringify(value);
        } catch {
          // Unserializable metadata: skip rather than failing the save.
        }
      }
    }
    if (Object.keys(custProps).length > 0) {
      (wb as unknown as { Custprops?: Record<string, string> }).Custprops = custProps;
    }
    // Mirror defined names into the file's defined-names table (§3: the
    // service metadata store is the source of truth; the file carries a
    // mirror so workbooks round-trip through Excel with names intact).
    // LAMBDA refs ride along as defined names holding LAMBDA expressions.
    if (data.definedNames && data.definedNames.length > 0) {
      const names = data.definedNames
        .filter(
          (dn) =>
            typeof dn.name === 'string' &&
            typeof dn.ref === 'string' &&
            // ITEM A classic parity: an `_xlcn.*` connection name whose
            // ref degraded to `#ERROR!` in the live engine table (its
            // structured ref `tblBS[]` is not formula-parseable) must
            // never be written back as `#ERROR!`. This path has no
            // source package to restore the original ref from, and it
            // drops connections.xml anyway, so the degraded bookkeeping
            // entry is omitted; verbatim `_xlcn.*` entries are kept and
            // get their hidden flag back below (restoreXlcnHiddenFlags).
            !(
              dn.name.toLowerCase().startsWith('_xlcn.') &&
              (dn.ref.startsWith('=') ? dn.ref.slice(1) : dn.ref) === '#ERROR!'
            ),
        )
        .map((dn) => ({
          Name: dn.name,
          // SheetJS stores the formula without a leading '='.
          Ref: dn.ref.startsWith('=') ? dn.ref.slice(1) : dn.ref,
          ...(typeof dn.sheet === 'number' ? { Sheet: dn.sheet } : {}),
        }));
      const book = (wb as unknown as { Workbook?: { Names?: unknown } }).Workbook ?? {};
      (wb as unknown as { Workbook?: unknown }).Workbook = { ...book, Names: names };
    }
    // type:'array' is browser-safe ('buffer' is Node-only); Uint8Array works everywhere.
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    let bytes: Uint8Array = new Uint8Array(out as unknown as ArrayLike<number>);
    // Native page-setup round-trip (design-docs/print-and-page-layout.md §5):
    // merge each sheet's original native settings with the app-owned Page
    // Setup dialog values (`icecream.pagesetup.<sheet>`), then inject
    // <pageMargins>/<pageSetup>/<headerFooter> and the _xlnm print defined
    // names directly into the package (SheetJS CE would drop them). Runs
    // before the page-break injection so breaks land after the setup
    // elements per schema order. Never fails the save — a hint must not
    // break one.
    try {
      const setupMap = new Map<string, SheetPageSetup>();
      for (const sheet of data.sheets) {
        const merged = mergeSheetPageSetup(
          data.metadata[`${METADATA_PREFIX}${sheet.name}`],
          data.metadata[`${PAGE_SETUP_APP_META_PREFIX}${sheet.name}`],
          data.metadata[`${PRINT_TITLES_APP_META_PREFIX}${sheet.name}`],
          sheet.name,
        );
        if (merged !== null) setupMap.set(sheet.name, merged);
      }
      bytes = injectSheetPageSetup(bytes, setupMap);
    } catch {
      // keep the SheetJS bytes
    }
    // Native protection round-trip (design §5): mirror the protection state
    // into real <sheetProtection> / <workbookProtection> elements and
    // cell-xf locked/hidden flags so Excel honors them (SheetJS CE would
    // drop them). Passwords are never written (design §4) — only the
    // protection STATE travels. Never fails the save — a hint must not
    // break one.
    try {
      bytes = injectNativeProtection(bytes, data);
    } catch {
      // keep the SheetJS bytes
    }
    // Native cell styles (defect D4): SheetJS CE writes number formats
    // (cell.z) but drops fonts/fills/borders/alignment entirely, so the
    // resolved per-cell styles from the UI format store are injected at
    // the OOXML level (stylesXml.ts). Runs after protection injection:
    // the xf cloning preserves each cell's <protection> child. Never
    // fails the save — a hint must not break one.
    try {
      const styleTargets = new Map<string, Record<string, import('@icecream-sheets/engine').CellStyle>>();
      for (const sheet of data.sheets) {
        if (sheet.styles && Object.keys(sheet.styles).length > 0) {
          styleTargets.set(sheet.name, sheet.styles);
        }
      }
      if (styleTargets.size > 0) bytes = injectCellStyles(bytes, styleTargets);
    } catch {
      // keep the pre-styles bytes
    }
    // Native worksheet-feature round-trip (audit §§4.3, 5.1, 6.1, 14.3,
    // 14.4): write <mergeCells>, <autoFilter>/<sortState>,
    // <dataValidations> and <conditionalFormatting> (+ styles.xml
    // <dxfs>) and the x14 sparkline extension in <extLst> from the
    // sheets' optional native fields — SheetJS CE would drop every one
    // of them. Runs after protection injection so the blocks land after
    // <sheetProtection> per CT_Worksheet order.
    // Never fails the save — a hint must not break one.
    try {
      bytes = injectNativeSheetFeatures(bytes, data.sheets);
    } catch {
      // keep the pre-features bytes
    }
    // Native table (ListObject) write (audit §11): emit real
    // xl/tables/tableN.xml parts + <tableParts> + sheet rels + content
    // types from the sheets' optional `tables` field (tables.ts) —
    // SheetJS CE would otherwise drop every table definition on save.
    // Never fails the save — a hint must not break one.
    try {
      bytes = injectTables(bytes, data.sheets);
    } catch {
      // keep the pre-tables bytes
    }
    // Threaded comments + persons round-trip (audit §3.2): regenerate
    // xl/persons/person.xml + xl/threadedComments/threadedCommentN.xml
    // from the model (per-sheet fields authoritative, persons from the
    // metadata model), with worksheet/workbook rels, content types and
    // the worksheet extLst x18at:threadedComments reference. A workbook
    // with no threaded-comments model is left untouched. Never fails
    // the save.
    try {
      const threadedModel = threadedCommentsForWrite(data);
      if (threadedModel) bytes = injectThreadedComments(bytes, threadedModel);
    } catch {
      // keep the pre-threaded-comments bytes
    }
    // Native page-break round-trip (design-docs/print-and-page-layout.md §5):
    // inject <rowBreaks>/<colBreaks> into the worksheet XML so manual breaks
    // survive as real Excel page breaks (SheetJS CE would drop them).
    // Never fails the save — a hint must not break one.
    try {
      const breakMap = new Map<string, SheetPageBreaks>();
      for (const [key, value] of Object.entries(data.metadata)) {
        if (!key.startsWith(PAGE_BREAKS_META_PREFIX)) continue;
        const sheet = key.slice(PAGE_BREAKS_META_PREFIX.length);
        const clean = cleanBreaks(value);
        if (clean && (clean.rows.length > 0 || clean.cols.length > 0)) {
          breakMap.set(sheet, clean);
        }
      }
      bytes = injectSheetPageBreaks(bytes, breakMap);
    } catch {
      // keep the SheetJS bytes
    }
    // Native pivot table round-trip: re-inject the original pivot parts
    // byte-for-byte (SheetJS CE would otherwise drop every pivot on save).
    // Never fails the save — a hint must not break one.
    try {
      bytes = injectPivotParts(bytes, data.metadata[PIVOT_PARTS_METADATA_KEY]);
    } catch {
      // keep the pre-pivot bytes
    }
    // Data-model part round-trip (#114): re-inject the original
    // connections.xml + xl/model/* bytes with their workbook rels and
    // content-type overrides, verbatim. Never fails the save.
    try {
      bytes = injectModelParts(bytes, data.metadata[MODEL_PARTS_METADATA_KEY]);
    } catch {
      // keep the pre-model bytes
    }
    // Native SmartArt round-trip: re-emit the original diagram parts
    // byte-for-byte (SheetJS CE would otherwise drop every diagram on save).
    // Never fails the save — a hint must not break one.
    try {
      bytes = injectSmartArtParts(bytes, data.metadata[SMARTART_PARTS_METADATA_KEY]);
    } catch {
      // keep the pre-SmartArt bytes
    }
    // Native slicer + timeline round-trip: regenerate the slicer/timeline
    // parts from the typed model (or re-inject the raw bytes when no model
    // is present) and wire workbook/sheet relationships, the workbook
    // slicer-cache registry, and content types. Never fails the save.
    try {
      bytes = injectSlicerTimelineParts(
        bytes,
        data.metadata[SLICERS_TIMELINES_METADATA_KEY],
        data.metadata[SLICER_PARTS_METADATA_KEY],
      );
    } catch {
      // keep the pre-slicer bytes
    }
    // Native rich-value round-trip (audit §9.2, Phase E piece B): emit
    // the metadata + rich-data parts from the model and stamp each rich
    // cell's vm attribute (+ cached <v> fallback when the written cell
    // has none) back into its worksheet XML. SheetJS CE would otherwise
    // drop every rich value on save. Never fails the save.
    try {
      bytes = injectRichValues(
        bytes,
        data.metadata[RICH_VALUES_METADATA_KEY],
        data.metadata[RICH_VALUE_PARTS_METADATA_KEY],
      );
    } catch {
      // keep the pre-rich-value bytes
    }
    // Dynamic-array spill round-trip (audit §9.3, Phase E piece C):
    // restore each stored spill's <f t="array" ref="..."> anchor (and
    // its cached member values) into its worksheet XML. Guards inside
    // injectSpills skip spills whose anchor formula was edited away or
    // whose extent now holds user-entered content, so a save never
    // resurrects a deleted formula or overwrites a blocking edit.
    // Never fails the save.
    try {
      bytes = injectSpills(bytes, data.sheets, data.metadata);
    } catch {
      // keep the pre-spill bytes
    }
    // Native pictures & shapes round-trip (audit §13.2): sheets whose
    // import stashed the original drawing (nativeDrawingsRaw) get it
    // back byte-for-byte with its media parts; sheets carrying authored
    // model pictures/shapes get a real drawing + media parts authored
    // (drawings.ts). Runs after SmartArt: if that injector already
    // created a drawing part for the sheet, the drawings injector
    // appends to it instead of creating a second one. Never fails the
    // save — a hint must not break one.
    try {
      bytes = injectNativeDrawings(bytes, data.sheets);
    } catch {
      // keep the pre-drawings bytes
    }
    // External link round-trip: regenerate the externalLink parts (plus
    // rels, content types, and workbook.xml <externalReferences>) from the
    // parsed link records so [N]Sheet!Ref formulas keep resolving in Excel.
    // Never fails the save — a hint must not break one.
    try {
      const links = externalLinksFromJson(data.metadata[EXTERNAL_LINKS_METADATA_KEY]);
      if (links.length > 0) bytes = writeExternalLinks(bytes, links);
    } catch {
      // keep the SheetJS bytes
    }
    // Future-function storage prefixes (audit §9.4): SheetJS writes
    // formula text bare; Excel stores post-2007 functions _xlfn-prefixed
    // (and LAMBDA params _xlfn._xlpm-prefixed). Rewrite the <f> and
    // <definedName> bodies in the finished package. Never fails the save.
    try {
      bytes = prefixFutureFunctionsInPackage(
        bytes,
        (data.definedNames ?? []).map((dn) => dn.name),
      );
    } catch {
      // keep the pre-prefix bytes
    }
    // ITEM A classic parity: SheetJS drops the `hidden="1"` attribute
    // of `_xlcn.*` connection defined names; restore it in the finished
    // package. Never fails the save — a hint must not break one.
    try {
      bytes = injectXlcnHiddenFlags(bytes);
    } catch {
      // keep the pre-restore bytes
    }
    // Macro project preservation: re-inject the opaque vbaProject.bin hint
    // captured on read. Never fails the save — a hint must not break one.
    const macroB64 = data.metadata[MACRO_PROJECT_KEY];
    if (typeof macroB64 === 'string' && macroB64.length > 0) {
      try {
        return injectMacroProject(bytes, base64ToU8(macroB64));
      } catch {
        return bytes;
      }
    }
    return bytes;
  }
}

/** Validate an `icecream.pagebreaks.<sheet>` metadata value. */
function cleanBreaks(value: unknown): SheetPageBreaks | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const numList = (x: unknown): number[] =>
    Array.isArray(x)
      ? [...new Set(x.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0))].sort((a, b) => a - b)
      : [];
  return { rows: numList(v.rows), cols: numList(v.cols) };
}

/** Coerce an `icecream.richValues` metadata value (JSON string or object) to a model, or null. */
function coerceRichValuesModel(value: unknown): RichValuesModel | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const m = parsed as Partial<RichValuesModel>;
    if (!m.metadata || typeof m.metadata !== 'object') return null;
    if (!Array.isArray(m.structures) || !Array.isArray(m.values) || !Array.isArray(m.cellRefs)) return null;
    return m as RichValuesModel;
  } catch {
    return null;
  }
}

/** Coerce an `xlsx.spill.<sheet>` metadata value (JSON string or object) to a SheetSpills, or null. */
function coerceSheetSpills(value: unknown): SheetSpills | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const s = parsed as Partial<SheetSpills>;
    if (!Array.isArray(s.spills)) return null;
    return { spills: s.spills as SpillRange[], spillRefs: Array.isArray(s.spillRefs) ? s.spillRefs : [] };
  } catch {
    return null;
  }
}

function unescapeRichXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRichXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Stamp one rich-value cell's vm attribute into worksheet XML. Returns the
 * new XML, or null when the cell is absent or its written value no longer
 * matches the model's cached fallback (the cell was edited in-session, so
 * its rich binding is honestly dropped rather than stamped onto new data).
 * For t="s" cells the written <v> shared-string index is left untouched —
 * only the vm attribute is added — and the comparison resolves the index
 * through the written package's shared-string table.
 */
function stampRichCellVm(
  xml: string,
  ref: string,
  vm: number,
  cachedValue: string | undefined,
  sharedStrings: readonly string[] | undefined,
): string | null {
  const tagRe = /<c\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[0]!;
    const rMatch = /(?:^|\s)r="([^"]*)"/.exec(tag);
    if (!rMatch || rMatch[1] !== ref) continue;
    const selfClosing = tag.endsWith('/>');
    const bodyStart = m.index + tag.length;
    let bodyEnd = bodyStart;
    if (!selfClosing) {
      bodyEnd = xml.indexOf('</c>', bodyStart);
      if (bodyEnd === -1) return null;
    }
    const body = selfClosing ? '' : xml.slice(bodyStart, bodyEnd);
    const tMatch = /(?:^|\s)t="([^"]*)"/.exec(tag);
    const t = tMatch?.[1] ?? '';
    const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
    if (cachedValue !== undefined) {
      if (vMatch) {
        const rawV = unescapeRichXml(vMatch[1]!);
        let written: string | undefined;
        if (t === 's') {
          const idx = Number(rawV);
          written = Number.isInteger(idx) ? sharedStrings?.[idx] : undefined;
          if (written === undefined) return null;
        } else {
          written = rawV;
        }
        if (written !== cachedValue) {
          const wn = Number(written);
          const cn = Number(cachedValue);
          if (!(Number.isFinite(wn) && Number.isFinite(cn) && wn === cn)) return null;
        }
      } else if (t === 's') {
        // No <v> to resolve: cannot verify the string, so do not stamp.
        return null;
      }
    }
    const attrs = tag
      .slice(2, selfClosing ? -2 : -1)
      .replace(/\s+vm="[^"]*"/, '');
    const newTag = `<c${attrs} vm="${vm}">`;
    let newBody = body;
    if (!vMatch && cachedValue !== undefined && t !== 's') {
      newBody = `${body}<v>${escapeRichXml(cachedValue)}</v>`;
    }
    const end = selfClosing ? bodyStart : bodyEnd + 4;
    return xml.slice(0, m.index) + newTag + newBody + '</c>' + xml.slice(end);
  }
  return null;
}

const RICH_CONTENT_TYPE_BY_PATH = (path: string): string => {
  if (/(^|\/)metadata\.xml$/i.test(path)) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml';
  }
  if (/Structure\.xml$/i.test(path)) return 'application/vnd.ms-excel.richValueStructure';
  if (/Types\.xml$/i.test(path)) return 'application/vnd.ms-excel.richValueTypes';
  return 'application/vnd.ms-excel.richValue';
};

/**
 * Bytes-level rich-value write: model parts + vm stamping, or — when no
 * model is present — byte-for-byte restoration of the raw parts captured
 * on load (the pivot/slicer fallback pattern). Never throws; a failure
 * returns the input bytes unchanged.
 */
function injectRichValues(
  packageBytes: Uint8Array,
  modelUnknown: unknown,
  rawPartsUnknown: unknown,
): Uint8Array {
  const model = coerceRichValuesModel(modelUnknown);
  let rawParts: RichValueRawParts | null = null;
  if (!model && rawPartsUnknown && typeof rawPartsUnknown === 'object' && !Array.isArray(rawPartsUnknown)) {
    const rp = rawPartsUnknown as Partial<RichValueRawParts>;
    if (rp.parts && typeof rp.parts === 'object') rawParts = rp as RichValueRawParts;
  }
  if (!model && !rawParts) return packageBytes;
  try {
    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let touched = false;
    if (model) {
      const written = injectRichValueParts(files, model);
      if (written.length > 0) touched = true;
      const parts = sheetPartPaths(files as unknown as ZipLike);
      let sharedStrings: string[] | undefined;
      const ssRaw = files['xl/sharedStrings.xml'];
      if (ssRaw) {
        try {
          sharedStrings = parseSharedStrings(decoder.decode(ssRaw));
        } catch {
          sharedStrings = undefined;
        }
      }
      for (const ref of model.cellRefs) {
        const path = parts.get(ref.sheetName);
        if (!path || !files[path]) continue;
        const xml = decoder.decode(files[path]!);
        const stamped = stampRichCellVm(xml, ref.ref, ref.vm, ref.cachedValue, sharedStrings);
        if (stamped !== null && stamped !== xml) {
          files[path] = encoder.encode(stamped);
          touched = true;
        }
      }
    } else if (rawParts) {
      for (const [path, b64] of Object.entries(rawParts.parts)) {
        if (typeof b64 !== 'string' || b64.length === 0) continue;
        try {
          files[path] = base64ToU8(b64);
          touched = true;
        } catch {
          continue;
        }
        // Content-type override for the restored part.
        const ctRaw = files['[Content_Types].xml'];
        if (ctRaw) {
          const ctXml = decoder.decode(ctRaw);
          if (!ctXml.includes(`PartName="/${path}"`) && ctXml.includes('</Types>')) {
            files['[Content_Types].xml'] = encoder.encode(
              ctXml.replace(
                '</Types>',
                `<Override PartName="/${path}" ContentType="${RICH_CONTENT_TYPE_BY_PATH(path)}"/></Types>`,
              ),
            );
          }
        }
      }
      // Workbook metadata relationship for a restored metadata part.
      const metaPath = Object.keys(rawParts.parts).find((p) => /(^|\/)metadata\.xml$/i.test(p));
      const relsRaw = metaPath ? files['xl/_rels/workbook.xml.rels'] : undefined;
      if (metaPath && relsRaw) {
        const relsXml = decoder.decode(relsRaw);
        if (!relsXml.includes(METADATA_REL_TYPE) && relsXml.includes('</Relationships>')) {
          const used = new Set<string>();
          for (const mm of relsXml.match(/Id="([^"]*)"/g) ?? []) {
            const id = /^Id="([^"]*)"$/.exec(mm)?.[1];
            if (id) used.add(id);
          }
          let n = 1;
          while (used.has(`rId${n}`)) n += 1;
          const target = metaPath.startsWith('xl/') ? metaPath.slice(3) : metaPath;
          files['xl/_rels/workbook.xml.rels'] = encoder.encode(
            relsXml.replace(
              '</Relationships>',
              `<Relationship Id="rId${n}" Type="${METADATA_REL_TYPE}" Target="${target}"/></Relationships>`,
            ),
          );
        }
      }
    }
    return touched ? zipSyncStable(files) : packageBytes;
  } catch {
    return packageBytes;
  }
}

/** Normalize a formula for comparison: strip _xlfn./_xlws./_xlpm. storage prefixes, trim. */
function normalizeSpillFormula(text: string): string {
  return text.replace(/_xlfn\.(?:_xlws\.|_xlpm\.)?/g, '').replace(/_xlws\./g, '').trim();
}

/** Live-row value vs stored spill cached value, with numeric-string tolerance. */
function spillCachedMatches(live: unknown, cached: unknown): boolean {
  if (live === cached) return true;
  if (typeof live === 'number' && typeof cached === 'string') return live === Number(cached);
  if (typeof live === 'string' && typeof cached === 'number') return Number(live) === cached;
  return false;
}

/**
 * Bytes-level spill write: restore stored spills per sheet, guarded so a
 * save never resurrects an edited-away anchor formula or overwrites a
 * user-entered (blocking) extent cell with a stale cached value. A spill
 * whose anchor still holds the stored formula and whose non-anchor extent
 * cells are empty-or-equal-to-cached is applied verbatim. Never throws.
 */
function injectSpills(
  packageBytes: Uint8Array,
  sheets: readonly SheetData[],
  metadata: Record<string, unknown>,
): Uint8Array {
  try {
    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;
    const parts = sheetPartPaths(files as unknown as ZipLike);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let touched = false;
    for (const sheet of sheets) {
      const parsed = coerceSheetSpills(metadata[`${SPILL_METADATA_KEY_PREFIX}${sheet.name}`]);
      if (!parsed || parsed.spills.length === 0) continue;
      const path = parts.get(sheet.name);
      if (!path || !files[path]) continue;
      let xml = decoder.decode(files[path]!);
      const original = xml;
      for (const spill of parsed.spills) {
        const anchorVal = sheet.rows[spill.anchor.row]?.[spill.anchor.col];
        if (typeof anchorVal !== 'string' || !anchorVal.startsWith('=')) continue;
        if (normalizeSpillFormula(anchorVal.slice(1)) !== normalizeSpillFormula(spill.formula)) continue;
        let blocked = false;
        for (let r = spill.startRow; r <= spill.endRow && !blocked; r++) {
          for (let c = spill.startCol; c <= spill.endCol; c++) {
            if (r === spill.anchor.row && c === spill.anchor.col) continue;
            const live = sheet.rows[r]?.[c];
            if (live === null || live === undefined || live === '') continue;
            const cached = spill.cachedValues[r - spill.startRow]?.[c - spill.startCol] ?? null;
            if (!spillCachedMatches(live, cached)) {
              blocked = true;
              break;
            }
          }
        }
        if (blocked) continue;
        xml = applySpillsToSheetXml(xml, [spill]);
      }
      if (xml !== original) {
        files[path] = encoder.encode(xml);
        touched = true;
      }
    }
    return touched ? zipSyncStable(files) : packageBytes;
  } catch {
    return packageBytes;
  }
}

function worksheetToRows(ws: XLSX.WorkSheet): {
  rows: CellInput[][];
  formats: Record<string, string>;
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  hiddenCols?: number[];
  hiddenRows?: number[];
} {
  // <dimension> is sometimes STALE (smaller than the real <c> content — seen
  // in excelize/xlsx-populate output), so the range is the UNION of !ref and
  // every cell key SheetJS actually parsed; trusting !ref alone silently
  // drops parsed cells outside the dimension.
  let startRow = 0;
  let startCol = 0;
  let endRow = -1;
  let endCol = -1;
  const ref = ws['!ref'];
  if (ref) {
    try {
      const range = XLSX.utils.decode_range(ref);
      startRow = range.s.r;
      startCol = range.s.c;
      endRow = range.e.r;
      endCol = range.e.c;
    } catch {
      // Corrupt !ref: fall through to the key scan below.
    }
  }
  for (const key of Object.keys(ws)) {
    if (key.charCodeAt(0) === 33) continue; // '!' properties, not cells
    let rc: { r: number; c: number };
    try {
      rc = XLSX.utils.decode_cell(key);
    } catch {
      continue;
    }
    if (rc.r > endRow) endRow = rc.r;
    if (rc.c > endCol) endCol = rc.c;
  }
  // A sheet can carry dimensions (column widths, row heights, hidden flags)
  // without any value cells (e.g. a layout sheet whose <c> elements are all
  // style-only). Dimensions must still be extracted — the early return must
  // not drop them, or they are silently lost on the next save.
  if (endRow < 0 || endCol < 0) return { rows: [], formats: {}, ...worksheetDimensions(ws) };
  // The engine (HyperFormula.buildFromSheets) treats array indices as
  // absolute 0-based positions (index 0 = column A / row 1), so the output
  // must ALWAYS be A1-based — even when the sheet's !ref starts elsewhere
  // (e.g. B1:Q40). Emitting ref-based arrays would shift every cell left/up.
  //
  // Perf (2026-10-19): the old code ran a dense endRow×endCol double loop
  // calling XLSX.utils.encode_cell + a hash lookup per grid position —
  // ~26s for a 60k×12 sheet. This version preallocates the dense grid with
  // native fill and makes ONE pass over SheetJS's parsed cell keys (A1
  // strings), decoding each key once. Same output, ~6x faster on P95.
  const rows: CellInput[][] = [];
  for (let r = 0; r <= endRow; r++) rows.push(new Array<CellInput>(endCol + 1).fill(null));
  // Excel number format code per cell ("row:col" -> format code), for cells
  // with a non-General format. Only recorded for cells that carry a value;
  // an empty cell's format has nothing to render.
  const formats: Record<string, string> = {};
  for (const key of Object.keys(ws)) {
    if (key.charCodeAt(0) === 33) continue; // '!' properties, not cells
    let r: number;
    let c: number;
    try {
      const rc = XLSX.utils.decode_cell(key);
      r = rc.r;
      c = rc.c;
    } catch {
      continue;
    }
    // Same "inside !ref" rule as the old dense loop: cells above/left of a
    // (possibly stale) !ref stay null.
    if (r < startRow || c < startCol || r > endRow || c > endCol) continue;
    const cell = ws[key] as XLSX.CellObject | undefined;
    let input = cellToInput(cell);
    // Legacy CSE array formulas (t="array"): SheetJS exposes the array
    // range as cell.F on the anchor (which also has f) and on every
    // member cell (f absent — only a cached <v>). Importing members as
    // occupied cells would block the anchor's dynamic spill (#SPILL!),
    // so members are left empty for the anchor to spill into, exactly as
    // Excel displays them. Only when the anchor actually holds a formula:
    // a member whose anchor was dropped (or a dataTable range) keeps its
    // cached value rather than silently losing data.
    if (cell && typeof cell.F === 'string' && cell.F !== '' && !(typeof cell.f === 'string' && cell.f !== '')) {
      if (arrayAnchorHasFormula(ws, cell.F)) input = null;
    }
    rows[r]![c] = input;
    if (input !== null) {
      const code = cellFormatCode(cell);
      if (code !== undefined && code !== GENERAL_FORMAT_CODE) formats[`${r}:${c}`] = code;
    }
  }
  return { rows, formats, ...worksheetDimensions(ws) };
}

/**
 * Extract column widths, row heights, and hidden flags from a SheetJS
 * worksheet (!cols / !rows). Pure UI hints: stored on the column/row, never
 * per-cell. Widths/heights are in pixels for the grid.
 *
 * Entries are capped at 1000 columns / 5000 rows: a file with
 * `<col min="1" max="16384">` (whole-sheet default) would otherwise produce
 * 16k entries that SheetJS cannot write back (fidelity loss). Real
 * customizations never exceed these bounds.
 */
function worksheetDimensions(
  ws: XLSX.WorkSheet,
): {
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  hiddenCols?: number[];
  hiddenRows?: number[];
} {
  const out: {
    colWidths?: Record<string, number>;
    rowHeights?: Record<string, number>;
    hiddenCols?: number[];
    hiddenRows?: number[];
  } = {};

  const cols = ws['!cols'] as Array<{ wch?: number; wpx?: number; width?: number; hidden?: boolean } | undefined> | undefined;
  if (cols) {
    const widths: Record<string, number> = {};
    const hidden: number[] = [];
    cols.forEach((c, i) => {
      if (!c || i >= 1000) return;
      // wpx is pixels (SheetJS-calculated); fall back to wch conversion.
      const px = typeof c.wpx === 'number' && c.wpx > 0
        ? Math.round(c.wpx)
        : typeof c.wch === 'number' && c.wch > 0
          ? Math.round(c.wch * 7 + 5)
          : 0;
      if (px > 0) widths[String(i)] = px;
      if (c.hidden) hidden.push(i);
    });
    if (Object.keys(widths).length > 0) out.colWidths = widths;
    if (hidden.length > 0) out.hiddenCols = hidden;
  }

  const rows = ws['!rows'] as Array<{ hpt?: number; hpx?: number; hidden?: boolean } | undefined> | undefined;
  if (rows) {
    const heights: Record<string, number> = {};
    const hidden: number[] = [];
    rows.forEach((r, i) => {
      if (!r || i >= 5000) return;
      // rowHeights are CSS pixels (serializer: ht = px * 0.75). The
      // file's source unit is POINTS: prefer hpt and convert
      // (1pt = 4/3 px). SheetJS's hpx is pt * PPI/96 with PPI = 96 by
      // default, i.e. numerically points, NOT CSS px — trusting it
      // made height-carrying rows 25% too short (sweep F-9).
      const px = typeof r.hpt === 'number' && r.hpt > 0
        ? Math.round(r.hpt * 4 / 3)
        : typeof r.hpx === 'number' && r.hpx > 0
          ? Math.round(r.hpx)
          : 0;
      if (px > 0) heights[String(i)] = px;
      if (r.hidden) hidden.push(i);
    });
    if (Object.keys(heights).length > 0) out.rowHeights = heights;
    if (hidden.length > 0) out.hiddenRows = hidden;
  }

  return out;
}

/**
 * True when any cell of a SheetJS array range (cell.F, e.g. "G5:G6") holds
 * its own formula text — i.e. the range is a genuine legacy array formula
 * whose anchor survived the parse, so member cells may be left empty for
 * the anchor's spill.
 */
function arrayAnchorHasFormula(ws: XLSX.WorkSheet, fRange: string): boolean {
  let range: XLSX.Range;
  try {
    range = XLSX.utils.decode_range(fRange);
  } catch {
    return false;
  }
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.f === 'string' && cell.f !== '') return true;
    }
  }
  return false;
}

/**
 * OOXML ST_CellType error literals. A cell with t="e" is an Excel error
 * literal (e.g. a #REF! left behind by a deleted reference). It is preserved
 * as its display string: HyperFormula's content parser turns these strings
 * back into real error cells on set, and the engine displays them like any
 * other error value — so they survive import, display, and export instead
 * of collapsing to blank.
 *
 * Edge case: a genuine TEXT cell containing exactly one of these strings
 * (typed with Excel's apostrophe escape, stored as t="s") round-trips as an
 * error cell on write — the CellInput string form cannot distinguish the
 * two. This is vanishingly rare and matches what Excel does when the same
 * text is typed without the escape.
 */
export const ERROR_CELL_LITERALS: ReadonlySet<string> = new Set([
  '#DIV/0!',
  '#N/A',
  '#NAME?',
  '#NULL!',
  '#NUM!',
  '#REF!',
  '#VALUE!',
]);

/**
 * BIFF error codes for t="e" cells (MS-XLSB 2.5.97.2). SheetJS's writer
 * expects the numeric code in cell.v and serializes the display string
 * itself; on read it normalizes cell.v back to the numeric code (cell.w
 * carries the display string).
 */
const ERROR_LITERAL_CODES: Record<string, number> = {
  '#NULL!': 0x00,
  '#DIV/0!': 0x07,
  '#VALUE!': 0x0f,
  '#REF!': 0x17,
  '#NAME?': 0x1d,
  '#NUM!': 0x24,
  '#N/A': 0x2a,
};

const ERROR_CODE_LITERALS: Record<number, string> = Object.fromEntries(
  Object.entries(ERROR_LITERAL_CODES).map(([literal, code]) => [code, literal]),
);

function cellToInput(cell: XLSX.CellObject | undefined): CellInput {
  if (!cell) return null;
  // Formula cells keep their formula text; the '=' prefix is our convention
  // for "this is a formula" (matches CellInput). The <f> element is the
  // authority — a TEXT cell (t="s"/"str"/"inlineStr") whose content happens
  // to start with '=' is NOT a formula (Excel displays it as-is).
  if (typeof cell.f === 'string' && cell.f !== '') return `=${cell.f}`;
  // Error cells (t === 'e'): preserve the error literal (e.g. #REF!) as its
  // display string instead of dropping it to null. SheetJS normalizes v to
  // the numeric BIFF code on read; accept a raw string too (other producers).
  if (cell.t === 'e') {
    const v: unknown = cell.v;
    if (typeof v === 'number') return ERROR_CODE_LITERALS[v] ?? null;
    if (typeof v === 'string' && v !== '') return v;
    return null;
  }
  const v: unknown = cell.v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // Text without a formula element: a leading '=' is literal text. Escape
    // it with the Excel apostrophe prefix so the engine stores it as text
    // instead of parsing it as a formula (same convention as the engine's
    // own setCell for a lone "=").
    if (v.startsWith('=') && v.length > 1) return `'${v}`;
    return v;
  }
  if (typeof v === 'boolean') return v;
  return null;
}

function rowsToWorksheet(rows: CellInput[][], sheet?: SheetData): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  let maxCol = -1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = inputToCell(row[c]);
      if (cell) {
        ws[XLSX.utils.encode_cell({ r, c })] = cell;
        if (c > maxCol) maxCol = c;
      }
    }
  }
  if (rows.length > 0 && maxCol >= 0) {
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: maxCol } });
  } else if (
    sheet &&
    (Object.keys(sheet.rowHeights ?? {}).length > 0 || (sheet.hiddenRows ?? []).length > 0)
  ) {
    // No value cells, but rows carry custom heights / hidden flags.
    // SheetJS only serializes !rows (the <row> elements) when !ref is set —
    // without a range the heights are silently dropped on save. Point the
    // range at the last customized row so the <row> elements are emitted.
    const lastRow = Math.max(
      rows.length - 1,
      ...Object.keys(sheet.rowHeights ?? {}).map(Number),
      ...(sheet.hiddenRows ?? []),
      0,
    );
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: 0 } });
  }
  // Write per-cell number formats (UI hint, separate from values). The
  // format code goes on cell.z; SheetJS serializes it into styles.xml as
  // <numFmt> entries so formats survive the save round-trip.
  if (sheet?.formats) {
    for (const [key, code] of Object.entries(sheet.formats)) {
      if (typeof code !== 'string' || code === '' || code === 'General') continue;
      const [rStr, cStr] = key.split(':');
      const r = Number(rStr);
      const c = Number(cStr);
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) continue;
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (cell) {
        cell.z = code;
      } else if (sheet?.styles?.[key]) {
        // The styles injection (stylesXml.ts) owns this cell: it
        // materializes an EMPTY styled <c> for it. Creating SheetJS's
        // placeholder {v: 0} here would persist a phantom 0 value.
        continue;
      } else {
        // A format on an empty cell still needs a cell object to carry it.
        ws[addr] = { t: 'n', v: 0, z: code };
      }
    }
  }
  // Write column widths / row heights / hidden flags (UI hints, stored on
  // the column/row). Pixels → SheetJS units: wch ≈ (px - 5) / 7, hpt = px * 3/4.
  // For columns we set wpx too (SheetJS converts it with real MDW math).
  // For rows we must NOT set hpx: SheetJS's sheet writer prefers hpx
  // over hpt and derives the emitted ht via px2pt at PPI 96 — an
  // identity — so any hpx we set is written into the file AS POINTS,
  // inflating every custom row height by 4/3 on each save (sweep F-9).
  if (sheet) {
    if (sheet.colWidths || sheet.hiddenCols) {
      const cols: Array<{ wch?: number; wpx?: number; hidden?: boolean }> = [];
      const widths = sheet.colWidths ?? {};
      const hidden = new Set(sheet.hiddenCols ?? []);
      const maxC = Math.max(maxCol, ...Object.keys(widths).map(Number), ...hidden, -1);
      for (let c = 0; c <= maxC; c++) {
        const entry: { wch?: number; wpx?: number; hidden?: boolean } = {};
        const px = widths[String(c)];
        if (typeof px === 'number' && px > 0) {
          entry.wpx = Math.round(px);
          entry.wch = Math.max(1, (px - 5) / 7);
        }
        if (hidden.has(c)) entry.hidden = true;
        if (entry.wpx !== undefined || entry.hidden) cols[c] = entry;
      }
      if (cols.length > 0) ws['!cols'] = cols;
    }
    if (sheet.rowHeights || sheet.hiddenRows) {
      const srows: Array<{ hpt?: number; hpx?: number; hidden?: boolean }> = [];
      const heights = sheet.rowHeights ?? {};
      const hidden = new Set(sheet.hiddenRows ?? []);
      const maxR = Math.max(rows.length - 1, ...Object.keys(heights).map(Number), ...hidden, -1);
      for (let r = 0; r <= maxR; r++) {
        const entry: { hpt?: number; hpx?: number; hidden?: boolean } = {};
        const px = heights[String(r)];
        if (typeof px === 'number' && px > 0) {
          entry.hpt = px * 3 / 4;
        }
        if (hidden.has(r)) entry.hidden = true;
        if (entry.hpt !== undefined || entry.hidden) srows[r] = entry;
      }
      if (srows.length > 0) ws['!rows'] = srows;
    }
  }
  return ws;
}

/**
 * ITEM A classic parity: restore `hidden="1"` on `_xlcn.*` defined
 * names in a finished package's xl/workbook.xml (SheetJS drops the
 * attribute). Returns the input bytes untouched when nothing changes.
 */
function injectXlcnHiddenFlags(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes.slice()) as Record<string, Uint8Array>;
  const wbPart = files['xl/workbook.xml'];
  if (!wbPart) return bytes;
  const xml = strFromU8(wbPart);
  const fixed = restoreXlcnHiddenFlags(xml);
  if (fixed === xml) return bytes;
  files['xl/workbook.xml'] = strToU8(fixed);
  return zipSyncStable(files);
}

function inputToCell(input: CellInput): XLSX.CellObject | undefined {
  if (input === null) return undefined;
  if (typeof input === 'string') {
    // Empty strings round-trip as empty shared-string cells (t='s', v='').
    // They are NOT blank: ISBLANK("") is FALSE in Excel. Dropping them
    // would be data loss on save (fidelity requirement).
    if (input === '') return { t: 's', v: '' };
    if (input.startsWith('=') && input.length > 1) {
      // SheetJS does not calculate: cached value is a placeholder; any
      // conforming reader recalculates from the formula text.
      const cell: XLSX.CellObject = { t: 'n', v: 0, f: input.slice(1) };
      return cell;
    }
    // Excel error literals round-trip as error cells (t === 'e'). SheetJS's
    // writer takes the numeric BIFF error code in v and serializes the
    // display string itself.
    if (ERROR_CELL_LITERALS.has(input)) {
      const errCell: XLSX.CellObject = { t: 'e', v: ERROR_LITERAL_CODES[input] };
      return errCell;
    }
    // Reverse the apostrophe escape (see cellToInput and the engine's
    // setCell): "'=A*B" means the literal text "=A*B". In OOXML the
    // apostrophe is an entry affordance and is never stored — writing it
    // would display a stray apostrophe in Excel. A doubled "''=..." (the
    // user wants a visible apostrophe) keeps one.
    let text = input;
    if (text.startsWith("'") && text.slice(1).startsWith('=')) text = text.slice(1);
    const strCell: XLSX.CellObject = { t: 's', v: text };
    return strCell;
  }
  if (typeof input === 'number') {
    const numCell: XLSX.CellObject = { t: 'n', v: input };
    return numCell;
  }
  const boolCell: XLSX.CellObject = { t: 'b', v: input };
  return boolCell;
}
