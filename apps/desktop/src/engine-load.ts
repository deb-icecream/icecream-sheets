/**
 * Desktop engine/view separation (Cycle 10, platform-shell.md §1):
 * workbook loading runs in the MAIN process, never on the renderer's UI
 * thread.
 *
 * The user's directive is thread separation, not a new process: the
 * Electron desktop is one Node.js process for our purposes, and the
 * sanctioned path is the existing main process via the IPC bridge
 * (window.icecream.engine). This module is the main side of the
 * `engine:load` channel: it parses file bytes with the storage adapters
 * and builds the EngineWorkbook that becomes the main-process host's
 * workbook — the same open fidelity the renderer used to do in-process
 * (apps/web openXlsxBuffer), moved off the UI thread.
 *
 * Fidelity notes (mirrors the renderer's open flow exactly):
 *  - Adapter registry: xlsx/xlsb/csv/tsv/ods/html, same as the web app's
 *    adapters.ts (the engine core never imports a concrete adapter).
 *  - Engine-side registry wiring runs here BEFORE the workbook is built:
 *    imported pivot tables register into the GETPIVOTDATA registry and as
 *    OLAP cubes (CUBE* functions), then data-model cubes rebuild from
 *    worksheet ranges. These registries are process-global in the engine
 *    package, so they must be wired in the process that owns the engine.
 *  - The EngineWorkbook is constructed with the same options the
 *    renderer's workbookFromData() used (defined names, external links,
 *    imported-pivot layouts for GETPIVOTDATA's rendered-grid fallback).
 *  - The cell grids never cross IPC. The renderer gets sheet summaries
 *    (UI hints: formats, dimensions, per-column non-empty counts) plus
 *    the adapter metadata verbatim, so it hydrates charts, pivots,
 *    protection flags, pictures, page setup, SmartArt, etc. exactly as
 *    before. See EngineLoadResult in @icecream-sheets/engine.
 *
 * The xlsx/csv/ods/xlsb adapters and the service package ship as ESM;
 * the desktop main compiles to CJS, so they are loaded with dynamic
 * import() (cached). @icecream-sheets/engine is CJS and imported
 * statically.
 */

import {
  EngineWorkbook,
  cubeFromPivot,
  defaultAdapters,
  registerCube,
  registerPivot,
  unregisterCube,
  unregisterPivot,
  type CellInput,
  type CellStyle,
  type EngineLoadResult,
  type EngineLoadSheetSummary,
  type ImportedPivotInfo,
  type SheetData,
  type StorageAdapter,
  type WorkbookData,
} from '@icecream-sheets/engine';

/** Lazily-loaded ESM dependencies (cached for the app lifetime). */
interface LoadDeps {
  xlsxAdapter: StorageAdapter;
  xlsbAdapter: StorageAdapter;
  csvAdapter: StorageAdapter;
  tsvAdapter: StorageAdapter;
  odsAdapter: StorageAdapter;
  htmlAdapter: StorageAdapter;
  externalLinksFromMetadata: (metadata: Record<string, unknown>) => import('@icecream-sheets/engine').ExternalLink[];
  PIVOT_TABLES_METADATA_KEY: string;
  registerDataModelCubes: (data: WorkbookData) => string[];
  importedPivotsFromMetadata: (value: unknown) => import('@icecream-sheets/xlsx-adapter').ImportedPivotTable[];
  buildImportedPivotResult: (t: import('@icecream-sheets/xlsx-adapter').ImportedPivotTable) => import('@icecream-sheets/service').PivotResult | null;
  importedPivotMatrix: (result: import('@icecream-sheets/service').PivotResult, dataOnRows: boolean) => (string | number | null)[][];
}

let depsPromise: Promise<LoadDeps> | null = null;

/** Dynamic-import the ESM adapter/service packages (once). */
async function loadDeps(): Promise<LoadDeps> {
  if (!depsPromise) {
    depsPromise = (async (): Promise<LoadDeps> => {
      const [xlsx, csv, ods, xlsb, service] = await Promise.all([
        import('@icecream-sheets/xlsx-adapter'),
        import('@icecream-sheets/csv-adapter'),
        import('@icecream-sheets/ods-adapter'),
        import('@icecream-sheets/xlsb-adapter'),
        import('@icecream-sheets/service'),
      ]);
      const { HtmlAdapter } = await import('@icecream-sheets/engine');
      return {
        xlsxAdapter: new xlsx.XlsxAdapter(),
        xlsbAdapter: new xlsb.XlsbAdapter(),
        csvAdapter: new csv.CsvAdapter(),
        tsvAdapter: new csv.TsvAdapter(),
        odsAdapter: new ods.OdsAdapter(),
        htmlAdapter: new HtmlAdapter(),
        externalLinksFromMetadata: xlsx.externalLinksFromMetadata,
        PIVOT_TABLES_METADATA_KEY: xlsx.PIVOT_TABLES_METADATA_KEY,
        registerDataModelCubes: service.registerDataModelCubes,
        importedPivotsFromMetadata: service.importedPivotsFromMetadata,
        buildImportedPivotResult: service.buildImportedPivotResult,
        importedPivotMatrix: service.importedPivotMatrix,
      };
    })();
  }
  return depsPromise;
}

let adaptersRegistered = false;

/**
 * Register the storage adapters into the engine's default registry
 * (mirrors apps/web/src/adapters.ts — same set, same fallback).
 * Idempotent.
 */
export async function registerDesktopAdapters(): Promise<void> {
  const d = await loadDeps();
  if (adaptersRegistered) return;
  adaptersRegistered = true;
  const regs = [
    { adapter: d.xlsxAdapter, extensions: ['xlsx', 'xlsm', 'xltx', 'xltm'] },
    { adapter: d.csvAdapter, extensions: ['csv'] },
    { adapter: d.tsvAdapter, extensions: ['tsv'] },
    { adapter: d.odsAdapter, extensions: ['ods'] },
    { adapter: d.xlsbAdapter, extensions: ['xlsb'] },
    { adapter: d.htmlAdapter, extensions: ['html', 'htm'] },
  ] as const;
  for (const { adapter, extensions } of regs) {
    if (!defaultAdapters.forName(adapter.name)) {
      defaultAdapters.register({ adapter, extensions: [...extensions], mimeTypes: [] });
    }
  }
}

/** Resolve the adapter for a filename (xlsx fallback, like the web app). */
export async function adapterForFilename(filename: string): Promise<StorageAdapter> {
  await registerDesktopAdapters();
  const d = await loadDeps();
  return defaultAdapters.forFilename(filename) ?? d.xlsxAdapter;
}

// ---------------------------------------------------------------------------
// Engine-global registry state (process-local, like the renderer's used to
// be). Unregistered when the next workbook loads so opens never leak
// stale registrations.
// ---------------------------------------------------------------------------

/** Registry keys of this file's imported pivots (`xlsx:<name>#<i>`). */
let importedPivotKeys: string[] = [];
/** Connection names of this file's data-model cubes. */
let cubeDataModelKeys: string[] = [];

/**
 * Wire the engine-global registries for one parsed workbook. Runs BEFORE
 * the EngineWorkbook is built: the engine caches evaluated cells, so a
 * cube/pivot registered after the first read would leave #NAME? stuck.
 * Mirrors the engine-side half of the renderer's openXlsxBuffer. Never
 * throws: registry wiring must never break the open.
 */
function wireEngineRegistries(data: WorkbookData, d: LoadDeps): void {
  try {
    for (const key of importedPivotKeys) {
      unregisterPivot(key);
      unregisterCube(key);
    }
    importedPivotKeys = [];
    for (const key of cubeDataModelKeys) unregisterCube(key);
    cubeDataModelKeys = [];

    const pivots = d.importedPivotsFromMetadata(
      data.metadata?.[d.PIVOT_TABLES_METADATA_KEY],
    );
    const usedNames = new Set<string>();
    pivots.forEach((t, i) => {
      try {
        const result = d.buildImportedPivotResult(t);
        if (!result) return;
        const key = `xlsx:${t.name}#${i}`;
        // Pivot names are workbook-unique in Excel, but some producers
        // duplicate them — disambiguate cube names so no pivot silently
        // replaces another in the engine registries (mirrors App.tsx).
        let cubeName = t.name;
        if (usedNames.has(cubeName)) {
          let n = 2;
          cubeName = `${t.name} — ${t.sheetName}`;
          while (usedNames.has(cubeName)) {
            cubeName = `${t.name} — ${t.sheetName} (${n})`;
            n += 1;
          }
        }
        usedNames.add(cubeName);
        const matrix = d.importedPivotMatrix(result, t.dataOnRows);
        registerPivot(key, result, {
          sheet: t.sheetIndex,
          col: t.anchor.col,
          row: t.anchor.row,
          cols: Math.max(1, matrix[0]?.length ?? 1),
          rows: Math.max(1, matrix.length),
        });
        registerCube(cubeFromPivot(result, cubeName));
        importedPivotKeys.push(key);
      } catch {
        // One bad pivot must not break the open (mirrors App.tsx).
      }
    });

    // Data-model cubes (CUBE* formulas against xl/connections.xml).
    // Imported-pivot cubes registered above win: registerDataModelCubes
    // skips names that are already registered.
    cubeDataModelKeys = d.registerDataModelCubes(data);
  } catch {
    // Registry wiring must never break the open.
  }
}

// ---------------------------------------------------------------------------
// Direct-streaming save base (direct-save pass): the fidelity state the
// shared streaming serializer (service/save-node serializeLiveWorkbook)
// needs alongside the LIVE main-process engine model — the retained
// source package bytes (verbatim part source), the parsed per-sheet
// presentation records, and the adapter metadata. Retained at load time
// here because the parse result is otherwise discarded once the engine
// workbook is built; the serializer must never re-derive it from a
// renderer snapshot.
// ---------------------------------------------------------------------------

/** Per-sheet presentation state retained from the parsed WorkbookData. */
export interface DesktopParsedSheetSaveState {
  styles?: Record<string, CellStyle>;
  formats?: Record<string, string>;
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  hiddenCols?: number[];
  hiddenRows?: number[];
}

/** Save base retained for the currently loaded workbook. */
export interface DesktopSaveBase {
  /**
   * The loaded file's raw bytes — ONLY when the file was an
   * .xlsx/.xlsm-family package (the zip format the verbatim streaming
   * path copies untouched parts from). Null for csv/tsv/ods/html/xlsb
   * opens and for blank/new workbooks: the serializer then synthesizes
   * the whole package from the live model.
   */
  sourceBytes: Uint8Array | null;
  /** Per-sheet parsed presentation records, keyed by sheet name. */
  parsedSheets: Map<string, DesktopParsedSheetSaveState>;
  /** Adapter metadata of the loaded file (verbatim). */
  metadata: Record<string, unknown>;
}

const EMPTY_SAVE_BASE = (): DesktopSaveBase => ({
  sourceBytes: null,
  parsedSheets: new Map<string, DesktopParsedSheetSaveState>(),
  metadata: {},
});

let desktopSaveBase: DesktopSaveBase = EMPTY_SAVE_BASE();

/** The save base for the workbook most recently built by buildWorkbookFromBytes. */
export function getDesktopSaveBase(): DesktopSaveBase {
  return desktopSaveBase;
}

/** Drop the retained save base (blank/new workbook, or before a fresh load). */
export function resetDesktopSaveBase(): void {
  desktopSaveBase = EMPTY_SAVE_BASE();
}

/** Extensions whose bytes are an OOXML zip package (the xlsx adapter family). */
const XLSX_FAMILY_EXTENSIONS: ReadonlySet<string> = new Set(['xlsx', 'xlsm', 'xltx', 'xltm']);

function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Non-empty cell count per column (index-aligned, up to the used range). */
function columnNonEmptyCounts(sheet: SheetData): number[] {
  let maxCol = -1;
  for (const row of sheet.rows) {
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v !== null && v !== undefined && v !== '') maxCol = Math.max(maxCol, c);
    }
  }
  if (maxCol < 0) return [];
  const counts = new Array<number>(maxCol + 1).fill(0);
  for (const row of sheet.rows) {
    for (let c = 0; c <= maxCol; c++) {
      const v = row[c];
      if (v !== null && v !== undefined && v !== '') counts[c]! += 1;
    }
  }
  return counts;
}

function summarizeSheet(sheet: SheetData): EngineLoadSheetSummary {
  const summary: EngineLoadSheetSummary = { name: sheet.name };
  if (sheet.formats && Object.keys(sheet.formats).length > 0) summary.formats = { ...sheet.formats };
  // Full cell styles (defect D4): without these the renderer cannot seed
  // its format store with imported fonts/fills on a desktop open, and a
  // re-save would drop them.
  if (sheet.styles && Object.keys(sheet.styles).length > 0) summary.styles = { ...sheet.styles };
  if (sheet.colWidths && Object.keys(sheet.colWidths).length > 0) summary.colWidths = { ...sheet.colWidths };
  if (sheet.rowHeights && Object.keys(sheet.rowHeights).length > 0) summary.rowHeights = { ...sheet.rowHeights };
  if (sheet.hiddenCols && sheet.hiddenCols.length > 0) summary.hiddenCols = [...sheet.hiddenCols];
  if (sheet.hiddenRows && sheet.hiddenRows.length > 0) summary.hiddenRows = [...sheet.hiddenRows];
  const colNonEmpty = columnNonEmptyCounts(sheet);
  if (colNonEmpty.length > 0) summary.colNonEmpty = colNonEmpty;
  return summary;
}

/**
 * Parse file bytes and build the EngineWorkbook for the main-process host.
 *
 * Returns the workbook (installed into the host by the caller) plus the
 * IPC-safe load result for the renderer: sheet summaries, adapter
 * metadata, and defined names. The cell grids never cross IPC.
 */
export async function buildWorkbookFromBytes(
  bytes: Uint8Array,
  filename: string,
): Promise<{ workbook: EngineWorkbook; result: EngineLoadResult }> {
  const d = await loadDeps();
  const adapter = await adapterForFilename(filename);
  const data: WorkbookData = adapter.read(bytes);

  wireEngineRegistries(data, d);

  const initial: Record<string, CellInput[][]> = {};
  for (const sheet of data.sheets) {
    initial[sheet.name] = sheet.rows.map((row) => [...row]);
  }
  const workbook = new EngineWorkbook(initial, {
    definedNames: data.definedNames,
    externalLinks: d.externalLinksFromMetadata(data.metadata ?? {}),
    importedPivots: d.importedPivotsFromMetadata(
      data.metadata?.[d.PIVOT_TABLES_METADATA_KEY],
    ) as unknown as ImportedPivotInfo[],
  });

  // Retain the direct-save base from THIS parse (see DesktopSaveBase):
  // the raw package bytes for xlsx-family files only (copied — the
  // caller's buffer is not retained by reference), the per-sheet
  // presentation records, and the adapter metadata. A failed parse/build
  // throws before this point, so a failed open never clobbers the base
  // of the workbook still live in the host.
  const parsedSheets = new Map<string, DesktopParsedSheetSaveState>();
  for (const sheet of data.sheets) {
    parsedSheets.set(sheet.name, {
      ...(sheet.styles ? { styles: { ...sheet.styles } } : {}),
      ...(sheet.formats ? { formats: { ...sheet.formats } } : {}),
      ...(sheet.colWidths ? { colWidths: { ...sheet.colWidths } } : {}),
      ...(sheet.rowHeights ? { rowHeights: { ...sheet.rowHeights } } : {}),
      ...(sheet.hiddenCols ? { hiddenCols: [...sheet.hiddenCols] } : {}),
      ...(sheet.hiddenRows ? { hiddenRows: [...sheet.hiddenRows] } : {}),
    });
  }
  desktopSaveBase = {
    sourceBytes: XLSX_FAMILY_EXTENSIONS.has(fileExtension(filename)) ? bytes.slice() : null,
    parsedSheets,
    metadata: data.metadata ?? {},
  };

  const result: EngineLoadResult = {
    sheets: data.sheets.map(summarizeSheet),
    metadata: data.metadata ?? {},
    definedNames: data.definedNames,
  };
  return { workbook, result };
}
