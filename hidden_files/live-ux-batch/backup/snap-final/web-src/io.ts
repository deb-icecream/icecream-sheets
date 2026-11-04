/**
 * Pure I/O conversion logic between the engine's WorkbookSnapshot and the
 * storage layer's WorkbookData. Headless and UI-free so it can be unit
 * tested with node/vitest (no browser needed).
 */
import {
  EngineHost,
  EngineWorkbook,
  type CellInput,
  type CellRef,
  type CellStyle,
  type DefinedName,
  type ExternalLink,
  type ImportedPivotInfo,
  type SheetData,
  type WorkbookData,
  type WorkbookSnapshot,
} from '@icecream-sheets/engine';
import { externalLinksFromMetadata, PIVOT_TABLES_METADATA_KEY } from '@icecream-sheets/xlsx-adapter';
import {
  expandFormatStore,
  importCellFormats,
  numberFormatToCode,
  type CellFormat,
  type FormatStore,
} from './features/formatting';
import { importedPivotsFromMetadata } from '@icecream-sheets/service';

/**
 * Convert adapter WorkbookData (row-major grids) into the
 * Record<string, CellInput[][]> shape the EngineWorkbook constructor takes.
 */
export function workbookDataToInitial(data: WorkbookData): Record<string, CellInput[][]> {
  const initial: Record<string, CellInput[][]> = {};
  for (const sheet of data.sheets) {
    initial[sheet.name] = sheet.rows.map((row) => [...row]);
  }
  return initial;
}

/**
 * Pull validated external-workbook links out of adapter metadata.
 * Exported so hosts can carry the link table into saves as well.
 */
export function externalLinksFromWorkbookData(data: WorkbookData): ExternalLink[] {
  return externalLinksFromMetadata(data.metadata);
}

/**
 * Pull imported pivot table layouts out of adapter metadata.
 * Fed to the engine so GETPIVOTDATA's rendered-grid fallback can resolve
 * pivots that were never registered (e.g. data-model pivots without
 * cache records).
 */
export function importedPivotsFromWorkbookData(data: WorkbookData): ImportedPivotInfo[] {
  return importedPivotsFromMetadata(data.metadata?.[PIVOT_TABLES_METADATA_KEY]);
}

/**
 * Build a workbook populated from adapter data. Used by "Open .xlsx".
 */
export function workbookFromData(data: WorkbookData): EngineWorkbook {
  return new EngineWorkbook(workbookDataToInitial(data), {
    definedNames: data.definedNames,
    externalLinks: externalLinksFromWorkbookData(data),
    importedPivots: importedPivotsFromWorkbookData(data),
  });
}

/**
 * Build a fresh EngineHost whose workbook is populated from adapter data.
 */
export function createHostFromWorkbookData(data: WorkbookData): EngineHost {
  return new EngineHost(workbookFromData(data));
}

/**
 * Convert an engine WorkbookSnapshot (sparse cell list) into adapter
 * WorkbookData (dense row-major grids). Used by "Download .xlsx".
 *
 * extraMetadata carries app-owned keys into the file (protection flags via
 * ProtectionManager.toMetadata(), pictures, page setup, …). The xlsx-adapter
 * persists `icecream.*` keys as custom properties (design §5: hints only).
 */
/**
 * Merge two defined-name lists into one save list (defect E1). Keyed by
 * scope (sheet index; undefined = workbook) + case-insensitive name —
 * `primary` wins on a key collision, `secondary` contributes only names
 * the primary lacks. Malformed entries (non-string name/ref) are dropped
 * rather than failing the save. Used to compose the engine's live names
 * (primary: imported names, engine-defined names, LAMBDA functions — the
 * snapshot carries them) with the client name store's exports (secondary:
 * names defined through the Name Manager, which live only in the store).
 * Neither source alone is complete; emitting only the store's list was
 * the E1 defect (the store is never populated on open, so saves emitted
 * ZERO names while formulas still referenced them).
 */
export function mergeDefinedNames(
  primary: readonly DefinedName[] | undefined,
  secondary: readonly DefinedName[] | undefined,
): DefinedName[] {
  const out: DefinedName[] = [];
  const seen = new Set<string>();
  for (const list of [primary, secondary]) {
    for (const dn of list ?? []) {
      if (!dn || typeof dn.name !== 'string' || typeof dn.ref !== 'string') continue;
      const key = `${dn.sheet ?? ''}\0${dn.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dn.sheet !== undefined ? { name: dn.name, ref: dn.ref, sheet: dn.sheet } : { name: dn.name, ref: dn.ref });
    }
  }
  return out;
}

export function snapshotToWorkbookData(
  snap: WorkbookSnapshot,
  extraMetadata: Record<string, unknown> = {},
  definedNames?: DefinedName[],
): WorkbookData {
  const sheets: SheetData[] = snap.sheets.map((sheet) => {
    let maxRow = -1;
    let maxCol = -1;
    for (const cell of sheet.cells) {
      if (cell.ref.row > maxRow) maxRow = cell.ref.row;
      if (cell.ref.col > maxCol) maxCol = cell.ref.col;
    }
    const rows: CellInput[][] = [];
    for (let r = 0; r <= maxRow; r++) {
      const row: CellInput[] = [];
      for (let c = 0; c <= maxCol; c++) row.push(null);
      rows.push(row);
    }
    for (const cell of sheet.cells) {
      const target = rows[cell.ref.row];
      if (target) target[cell.ref.col] = cell.input;
    }
    return { name: sheet.name, rows };
  });
  // Defined names (§3): the engine's live refers-to (tracks structural
  // edits) is what Excel persists. LAMBDA named functions ride along as
  // defined names holding LAMBDA expressions (best-effort per §7).
  // Defect E1: when the caller passes no explicit list, the SNAPSHOT's
  // names are the default — an explicit empty list from an unpopulated
  // name store must never silently zero the file's defined-names table.
  return {
    sheets,
    metadata: { ...extraMetadata },
    definedNames: definedNames ?? snap.definedNames,
  };
}

/**
 * Permission-filtered snapshot (design §6: downloads respect permissions —
 * a user who cannot read a range gets a file without that data).
 * Cells failing `isDenied` are dropped from the snapshot entirely.
 */
export function snapshotFiltered(
  snap: WorkbookSnapshot,
  isDenied: (ref: CellRef) => boolean,
): WorkbookSnapshot {
  return {
    protocolVersion: snap.protocolVersion,
    sheets: snap.sheets.map((sheet) => ({
      name: sheet.name,
      cells: sheet.cells.filter((cell) => !isDenied(cell.ref)),
    })),
    // Defect E1: filtering cells for permissions must not strip the
    // defined-names table — the filtered snapshot feeds save directly.
    ...(snap.definedNames ? { definedNames: snap.definedNames } : {}),
  };
}

/**
 * Sanitize a string into a valid Excel sheet name: at most 31 characters,
 * none of []:*?/\ or backslash, non-empty. Falls back to `fallback` when
 * nothing survives (e.g. the name was only illegal characters).
 */
export function sanitizeSheetName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, '')
    .trim()
    .slice(0, 31);
  return cleaned === '' ? fallback : cleaned;
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

/** Quote a sheet name for an A1 reference (defined-name refers-to). */
function quoteSheetName(name: string): string {
  if (name.includes(' ') || name.includes("'")) {
    return `'${name.replace(/'/g, "''")}'`;
  }
  return name;
}

function absA1Range(startRow: number, startCol: number, endRow: number, endCol: number): string {
  const tl = `$${colLabel(startCol)}$${startRow + 1}`;
  const br = `$${colLabel(endCol)}$${endRow + 1}`;
  return startRow === endRow && startCol === endCol ? tl : `${tl}:${br}`;
}

/** Minimal resolved-name shape for named-range download (service NamedRangeDef). */
export interface ResolvedNameRef {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Named-range download (Cycle 7, per-name download filtering): build a
 * single-sheet WorkbookData holding only the cells of a resolved defined
 * name, rebased so the range's top-left lands on A1.
 *
 * UX choice (documented): the download is a NEW single-sheet workbook whose
 * sheet is named after the defined name — not the source sheet with
 * everything else stripped — so the file visibly contains exactly what the
 * user asked for. The defined name itself rides along, rebased to the new
 * sheet, so formulas like =SUM(Sales) keep resolving in the export.
 *
 * Permissions (fail closed; workbook-protection-and-encryption.md §6 and
 * named-ranges-and-named-functions.md §4): `def` must come from the name
 * store's resolveForSubject() — unknown / denied / dangling names are
 * rejected by the caller before this runs. Per-cell, `isDenied` (the same
 * predicate the whole-workbook download uses: cells hidden from the
 * subject) drops unreadable cells — dropped, never leaked as blanks.
 *
 * Workbook-scoped extras (pictures, charts, pivots, print settings, column
 * widths, data-type metadata) are deliberately NOT carried: they are keyed
 * to the source sheet layout and would mis-map after rebasing.
 */
export function namedRangeToWorkbookData(
  snap: WorkbookSnapshot,
  def: { name: string; ref: ResolvedNameRef | null },
  isDenied: (ref: CellRef) => boolean,
): WorkbookData {
  if (!def.ref) {
    throw new Error(`Cannot download "${def.name}": it no longer refers to any cells (#REF!).`);
  }
  const { sheet, startRow, startCol, endRow, endCol } = def.ref;
  const sheetName = sanitizeSheetName(def.name, sheet);
  let maxRow = -1;
  let maxCol = -1;
  const placed: { row: number; col: number; input: CellInput }[] = [];
  const src = snap.sheets.find((s) => s.name === sheet);
  if (src) {
    for (const cell of src.cells) {
      const { row, col } = cell.ref;
      if (row < startRow || row > endRow || col < startCol || col > endCol) continue;
      if (isDenied(cell.ref)) continue;
      const r = row - startRow;
      const c = col - startCol;
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
      placed.push({ row: r, col: c, input: cell.input });
    }
  }
  const rows: CellInput[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const row: CellInput[] = [];
    for (let c = 0; c <= maxCol; c++) row.push(null);
    rows.push(row);
  }
  for (const p of placed) {
    rows[p.row][p.col] = p.input;
  }
  // Carry the defined name, rebased to the new sheet. The refers-to covers
  // the full tracked range even where denied cells were dropped, so the
  // name still denotes the same logical data.
  const definedNames: DefinedName[] = [
    {
      name: def.name,
      ref: `${quoteSheetName(sheetName)}!${absA1Range(0, 0, endRow - startRow, endCol - startCol)}`,
    },
  ];
  return { sheets: [{ name: sheetName, rows }], metadata: {}, definedNames };
}

/**
 * Convert one resolved UI CellFormat into the storage-layer CellStyle the
 * XLSX adapter serializes into xl/styles.xml (defect D4). The number
 * format category is resolved to its Excel code here (numberFormatToCode
 * mirrors the renderer's precedence: category wins over imported code).
 * Returns undefined when the format carries nothing persistable.
 */
export function cellFormatToStyle(fmt: CellFormat): CellStyle | undefined {
  const style: CellStyle = {};
  const code = numberFormatToCode(fmt);
  if (code !== undefined && code.toLowerCase() !== 'general') style.numberFormatCode = code;
  if (fmt.fontName !== undefined) style.fontName = fmt.fontName;
  if (fmt.fontSize !== undefined) style.fontSize = fmt.fontSize;
  if (fmt.bold !== undefined) style.bold = fmt.bold;
  if (fmt.italic !== undefined) style.italic = fmt.italic;
  if (fmt.underline !== undefined) style.underline = fmt.underline;
  if (fmt.strikethrough !== undefined) style.strikethrough = fmt.strikethrough;
  if (fmt.fontColor !== undefined) style.fontColor = fmt.fontColor;
  if (fmt.fillColor !== undefined) style.fillColor = fmt.fillColor;
  if (fmt.borders !== undefined) style.borders = fmt.borders;
  if (fmt.hAlign !== undefined) style.hAlign = fmt.hAlign;
  if (fmt.vAlign !== undefined) style.vAlign = fmt.vAlign;
  if (fmt.wrapText !== undefined) style.wrapText = fmt.wrapText;
  if (fmt.indent !== undefined) style.indent = fmt.indent;
  if (fmt.orientation !== undefined) style.orientation = fmt.orientation;
  if (fmt.verticalText !== undefined) style.verticalText = fmt.verticalText;
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * Inverse of cellFormatToStyle for the open path: a stored CellStyle
 * becomes a UI CellFormat. The style's number format code enters as
 * `formatCode` (rendered through the Excel format interpreter until the
 * user picks their own category — the same contract imported formats
 * have always had).
 */
export function styleToCellFormat(style: CellStyle): CellFormat {
  const fmt: CellFormat = {};
  if (style.numberFormatCode !== undefined) fmt.formatCode = style.numberFormatCode;
  if (style.fontName !== undefined) fmt.fontName = style.fontName;
  if (style.fontSize !== undefined) fmt.fontSize = style.fontSize;
  if (style.bold !== undefined) fmt.bold = style.bold;
  if (style.italic !== undefined) fmt.italic = style.italic;
  if (style.underline !== undefined) fmt.underline = style.underline;
  if (style.strikethrough !== undefined) fmt.strikethrough = style.strikethrough;
  if (style.fontColor !== undefined) fmt.fontColor = style.fontColor;
  if (style.fillColor !== undefined) fmt.fillColor = style.fillColor;
  if (style.borders !== undefined) fmt.borders = style.borders;
  if (style.hAlign !== undefined) fmt.hAlign = style.hAlign;
  if (style.vAlign !== undefined) fmt.vAlign = style.vAlign;
  if (style.wrapText !== undefined) fmt.wrapText = style.wrapText;
  if (style.indent !== undefined) fmt.indent = style.indent;
  if (style.orientation !== undefined) fmt.orientation = style.orientation;
  if (style.verticalText !== undefined) fmt.verticalText = style.verticalText;
  return fmt;
}

/**
 * The per-sheet formats + styles one FormatStore serializes to (defect
 * D4: the save path's view of the format store). Shared by the in-tab
 * save (applyFormatStoreToWorkbookData) and the gateway server-save
 * extras, so the two paths can never drift in what a save carries.
 * `endRow` bounds column-format expansion (the sheet's data extent).
 */
export function formatStoreToSheetData(
  store: FormatStore,
  sheet: string,
  endRow: number,
): { formats?: Record<string, string>; styles?: Record<string, CellStyle> } {
  const expanded = expandFormatStore(store, sheet, endRow);
  const formats: Record<string, string> = {};
  const styles: Record<string, CellStyle> = {};
  for (const [key, fmt] of expanded) {
    // FormatStore keys are "sheet:row:col"; SheetData keys are "row:col".
    const sep = key.indexOf(':');
    const rcKey = key.slice(sep + 1);
    const style = cellFormatToStyle(fmt);
    if (!style) continue;
    styles[rcKey] = style;
    if (style.numberFormatCode !== undefined) formats[rcKey] = style.numberFormatCode;
  }
  return {
    ...(Object.keys(formats).length > 0 ? { formats } : {}),
    ...(Object.keys(styles).length > 0 ? { styles } : {}),
  };
}

/**
 * Attach the UI format store's resolved per-cell formats + styles to a
 * WorkbookData about to be serialized (defect D4). This is THE missing
 * link of the D4 chain: buildDownloadBytes built WorkbookData from the
 * engine snapshot alone, so ribbon-applied formats — which live in the
 * FormatStore by design (formatting is presentation metadata, never a
 * cell property) — were dropped by every save.
 */
export function applyFormatStoreToWorkbookData(wbData: WorkbookData, store: FormatStore): void {
  for (const sheet of wbData.sheets) {
    const { formats, styles } = formatStoreToSheetData(store, sheet.name, sheet.rows.length - 1);
    if (formats) sheet.formats = formats;
    if (styles) sheet.styles = styles;
  }
}

/**
 * Convert adapter WorkbookData per-cell Excel format codes (SheetData.formats,
 * keyed "row:col") into a FormatStore seed. Imported codes render through the
 * Excel format interpreter until the user sets their own number format on the
 * cell (Grid.tsx prefers numberFormat over formatCode). Malformed keys and
 * non-string codes are skipped — a corrupt formats map must never break open.
 *
 * Full styles (SheetData.styles: fonts/fills/borders/alignment parsed
 * from xl/styles.xml) seed the same store (defect D4): without them an
 * imported bold cell rendered plain and a re-save dropped its style even
 * when the user never touched it.
 */
export function importedFormatsToStore(data: WorkbookData): FormatStore {
  // Bulk path (O(n)): the old code called the immutable setFormat() once per
  // cell — O(n²) — hanging the P95 open for 10+ minutes (2026-10-19).
  const entries: Array<{ sheet: string; row: number; col: number; format: CellFormat }> = [];
  for (const sheet of data.sheets) {
    const formats = sheet.formats;
    if (formats) {
      for (const [key, code] of Object.entries(formats)) {
        if (typeof code !== 'string' || code === '') continue;
        const sep = key.indexOf(':');
        if (sep <= 0) continue;
        const row = Number(key.slice(0, sep));
        const col = Number(key.slice(sep + 1));
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
        // Imported per-cell codes enter the cascade at cell level (most specific).
        entries.push({ sheet: sheet.name, row, col, format: { formatCode: code } });
      }
    }
    // Full styles merge over the bare code entries for the same cell
    // (importCellFormats merges later entries over earlier ones): a
    // style's numberFormatCode becomes the formatCode, its font/fill/
    // border/alignment fields ride along so imported formatting renders
    // AND survives a re-save.
    const styles = sheet.styles;
    if (styles) {
      for (const [key, style] of Object.entries(styles)) {
        if (!style || typeof style !== 'object') continue;
        const sep = key.indexOf(':');
        if (sep <= 0) continue;
        const row = Number(key.slice(0, sep));
        const col = Number(key.slice(sep + 1));
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
        entries.push({ sheet: sheet.name, row, col, format: styleToCellFormat(style) });
      }
    }
  }
  return importCellFormats(entries);
}
