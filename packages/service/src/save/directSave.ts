/**
 * Direct streaming save serializer (SAVE SERIALIZATION INVARIANT,
 * 2026-10-21): serialization is ALWAYS a one-pass streaming pass over
 * the LIVE authoritative engine model — no rebuild, no re-parse, no
 * replay, no checksum. The caller (gateway engine service, desktop
 * main process) feeds this module the live model's bulk readback for
 * the requesting principal plus the retained source package, and this
 * module writes the .xlsx:
 *
 * - VERBATIM PATH (the designed path): parts the save did not touch
 *   are copied byte-for-byte from the source package; changed sheets
 *   are generated row-by-row (streamingSave.ts) with append-only
 *   styles handling; the zip is streamed to the output file through
 *   fflate's streaming Zip. Changed sheets are generated to temp
 *   files first (mkdtempSync) and verbatim parts are fed to the zip
 *   in 1 MiB slices, so the serializer's peak is bounded by one sheet
 *   + one part, never the whole package.
 * - STRUCTURAL OPS, PER TYPE: row/col insert/delete (sheet set
 *   unchanged) stay on the verbatim path with EVERY sheet
 *   regenerated from the bulk (an address shift invalidates per-cell
 *   reuse; non-sheet parts still copy verbatim). The ADAPTER
 *   FALLBACK remains only for a changed sheet-name set (sheet
 *   add/delete/rename/move), another structural op the verbatim
 *   planner cannot handle (e.g. setCalculationMode), or verbatim
 *   planning itself failing: the grouped cells are converted to
 *   dense WorkbookData by the small local converter below and
 *   written with the classic XlsxAdapter, and the result carries
 *   `fallbackReason` saying which case fired.
 *
 * This module is the serializer half of the W21 save worker
 * (packages/gateway/src/services/saveWorkerCore.ts phase 3), extracted
 * so the live engine can feed it directly; the worker now calls it
 * too (over its rebuilt, checksum-verified bulk) as a non-ordinary
 * fallback path.
 *
 * EXCEL SAVE SEQUENCE (callers' contract): callers pass a TEMPORARY
 * file as `outPath`, run verifyXlsxPackage() on it, and only then
 * atomically replace the destination / stream it to the client. A
 * failure anywhere in here therefore never touches the original.
 *
 * TEST-ONLY FAULT INJECTION: when the environment variable
 * ICECREAM_SAVE_FAULT_INJECT === 'midwrite', serializeLiveWorkbook
 * throws Error('injected save fault (midwrite)') genuinely mid-write
 * — on the verbatim path, immediately after the first regenerated
 * sheet's chunks have been fed into the output file; on the adapter
 * fallback, after a partial write of the output. The output file is
 * left partial/abandoned. Default off; no behavior change otherwise.
 * It exists to prove the callers' temp-then-replace sequence leaves
 * the destination byte-identical on a mid-save failure.
 *
 * Node-only (node:fs): exported from
 * '@icecream-sheets/service/save-node', never from the browser-safe
 * main entry.
 */
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CellInput,
  CellRef,
  CellStyle,
  DefinedName,
  TypedValue,
  WorkbookData,
} from '@icecream-sheets/engine';
import {
  MINIMAL_STYLES_XML,
  XlsxAdapter,
  attachTablesToSheets,
  authorChartParts,
  createStreamingStyles,
  definedNamesEqual,
  ensureContentTypeOverride,
  formulaRecoverySheetPartPaths,
  injectChartParts,
  mergeCustomPropsXml,
  readTables,
  reanchorNativeChartParts,
  regenerateWorkbookXml,
  removeContentTypeOverride,
  sheetXmlChunks,
  streamZipToSink,
  synthesizeContentTypes,
  synthesizeRootRels,
  synthesizeWorkbookRels,
  synthesizeWorkbookXml,
  tablesBySheet,
  textChunks,
  unzipPackage,
  verbatimChunks,
  type ChartAuthorSpec,
  type ChartCellResolver,
  type MovedNativeChart,
  type StreamSaveCell,
  type TableDef,
  type ZipEntrySource,
} from '@icecream-sheets/xlsx-adapter';
import type { ChartSpec } from '../chartModel.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Per-sheet client-reported save state (presentation overlays). */
export interface DirectSaveSheetMeta {
  name: string;
  /** True when the client reported this sheet in its session styles. */
  clientStyles: boolean;
  /** The client's per-cell styles ("row:col" -> CellStyle), when reported. */
  styles?: Record<string, CellStyle>;
  /** True when the client reported this sheet's dims overlay. */
  clientDims: boolean;
  /** The client's dims overlay for the sheet, when reported. */
  dims?: {
    colWidths?: Record<string, number>;
    rowHeights?: Record<string, number>;
    hiddenCols?: number[];
    hiddenRows?: number[];
  };
}

/** Per-sheet presentation state parsed from the source package. */
export interface DirectSaveParsedSheet {
  styles?: Record<string, CellStyle>;
  formats?: Record<string, string>;
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  hiddenCols?: number[];
  hiddenRows?: number[];
}

/** One cell of the live model's bulk readback. */
export interface DirectSaveCell {
  ref: CellRef;
  input: CellInput;
  value: TypedValue;
}

export interface DirectSaveResult {
  /** 'verbatim' = streaming verbatim/streaming-writer path; 'adapter-fallback' = classic XlsxAdapter write. */
  mode: 'verbatim' | 'adapter-fallback';
  /**
   * Why the adapter fallback ran (mode 'adapter-fallback' only):
   * 'sheet-set-changed' (live sheet-name set differs from the source —
   * sheet add/delete/rename/move), 'structural-op:<cmd>' (an op the
   * verbatim planner cannot handle, e.g. setCalculationMode), or
   * 'verbatim-failed' (verbatim planning itself threw). Absent on the
   * verbatim path — including row/col structural ops, which stay
   * verbatim with every sheet regenerated (see ROWCOL_OPS).
   */
  fallbackReason?: string;
  bytes: number;
  changedSheets: string[];
  verbatimParts: number;
  regeneratedParts: string[];
  droppedParts: string[];
  serializeMs: number;
}

export interface DirectSaveInput {
  /** Bulk readback of the live model, for the requesting principal. */
  bulk: DirectSaveCell[];
  /** Live sheet names, in workbook order. */
  sheetNames: string[];
  /** Final merged defined-names table for the saved file. */
  definedNames: DefinedName[];
  /** Final merged workbook metadata (source + protection + client extras). */
  metadata: Record<string, unknown>;
  /** Retained source .xlsx bytes; null = blank (never-loaded) workbook. */
  sourceBytes: Uint8Array | null;
  /**
   * Per-sheet presentation records parsed from the source package,
   * keyed by sheet name. In the worker/live feed this map carries one
   * entry per SOURCE sheet (its keys are the source sheet-name set
   * the verbatim-vs-adapter decision compares against).
   */
  parsedSheets: Map<string, DirectSaveParsedSheet>;
  /** Per-sheet client-reported presentation overlays. */
  sheets: DirectSaveSheetMeta[];
  /** Executed mutating ops since the source was loaded, in order. */
  ops: Array<{ cmd: string; ref?: CellRef }>;
  /**
   * Native charts authored this session (FIX-G trace §4.1d): specs the
   * save must materialize as REAL xl/charts/chartN.xml parts. Verbatim
   * path: authorChartParts runs over the source files map, anchor
   * sheets are forced into the changed set, and their regenerated XML
   * gains the <drawing> element. Adapter fallback: injectChartParts
   * runs over the adapter's output bytes. Absent/empty = today's
   * behavior, byte-identical. Caches are computed from the bulk.
   */
  charts?: ChartSpec[];
  /**
   * Imported native charts the user moved this session (#125): pairs of
   * original → new anchors. The verbatim path rewrites the matching
   * twoCellAnchor in the source package's drawing parts (see
   * reanchorNativeChartParts) so the moved position survives the save;
   * without this the drawing parts copy verbatim and reopen restores
   * the original position. Absent/empty = today's behavior.
   */
  movedNativeCharts?: MovedNativeChart[];
  /** Output path (callers pass a temp file; see the header contract). */
  outPath: string;
  log?: (m: string) => void;
}

/**
 * Mutating engine commands the save journal captures — the same list
 * as the gateway's SAVE_MUTATING_OPS in engineSvc.ts. Exported so the
 * live hosts journal exactly the ops this serializer's planner and
 * the worker replay both understand.
 */
export const DIRECT_SAVE_MUTATING_OPS: ReadonlySet<string> = new Set([
  'setCell',
  'setFormula',
  'addSheet',
  'deleteSheet',
  'renameSheet',
  'duplicateSheet',
  'moveSheet',
  'defineName',
  'deleteName',
  'renameName',
  'updateNameRefersTo',
  'defineFunction',
  'updateFunction',
  'rollbackFunction',
  'deleteFunction',
  'insertRows',
  'deleteRows',
  'insertCols',
  'deleteCols',
  'setCalculationMode',
]);

/** Ops that only touch cell contents (the verbatim planner's domain). */
const CELL_OPS: ReadonlySet<string> = new Set(['setCell', 'setFormula']);
/** Ops that only touch the defined-names table (workbook.xml surgery). */
const NAME_OPS: ReadonlySet<string> = new Set([
  'defineName',
  'deleteName',
  'renameName',
  'updateNameRefersTo',
  'defineFunction',
  'updateFunction',
  'rollbackFunction',
  'deleteFunction',
]);
/**
 * Row/col structural ops (sheet SET unchanged). These do NOT force the
 * adapter fallback: the provided bulk already carries post-shift
 * addresses, so the save stays on the verbatim/streaming path — but
 * an address shift invalidates per-cell reuse (address collapsing)
 * across the whole workbook, so EVERY sheet is regenerated from the
 * bulk. Non-sheet parts are still copied verbatim.
 */
const ROWCOL_OPS: ReadonlySet<string> = new Set([
  'insertRows',
  'deleteRows',
  'insertCols',
  'deleteCols',
]);

// ---------------------------------------------------------------------------
// Test-only fault injection (see header)
// ---------------------------------------------------------------------------

function midwriteFaultEnabled(): boolean {
  return process.env.ICECREAM_SAVE_FAULT_INJECT === 'midwrite';
}

/** Yield every chunk, then throw — the throw lands genuinely mid-write. */
function* throwAfterChunks(chunks: Iterable<Uint8Array>): Generator<Uint8Array> {
  yield* chunks;
  throw new Error('injected save fault (midwrite)');
}

// ---------------------------------------------------------------------------
// Package verification (cheap structural integrity check for callers)
// ---------------------------------------------------------------------------

/**
 * Verify a completed .xlsx file is a structurally sound package:
 * it unzips, and it carries [Content_Types].xml, xl/workbook.xml and
 * at least one xl/worksheets/*.xml part. Throws on any failure.
 * Callers run this on the temp file BEFORE the atomic replace /
 * streaming it out (Excel save sequence step 3). This is deliberately
 * a cheap structural check — full parse-back is a validation-run
 * property, not a per-save cost.
 */
export function verifyXlsxPackage(path: string): { ok: true; parts: number } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new Error(
      `verifyXlsxPackage: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const files = unzipPackage(new Uint8Array(bytes));
  if (!files || Object.keys(files).length === 0) {
    throw new Error(`verifyXlsxPackage: ${path} is not a readable zip package`);
  }
  const names = Object.keys(files);
  if (!names.includes('[Content_Types].xml')) {
    throw new Error(`verifyXlsxPackage: ${path} is missing [Content_Types].xml`);
  }
  if (!names.includes('xl/workbook.xml')) {
    throw new Error(`verifyXlsxPackage: ${path} is missing xl/workbook.xml`);
  }
  if (!names.some((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))) {
    throw new Error(`verifyXlsxPackage: ${path} has no xl/worksheets/*.xml part`);
  }
  return { ok: true, parts: names.length };
}

// ---------------------------------------------------------------------------
// Resolved presentation (ported from saveWorkerCore.ts phase 3)
// ---------------------------------------------------------------------------

/** Per-sheet presentation state resolved for serialization. */
interface ResolvedSheet {
  styles: Record<string, CellStyle>;
  formats: Record<string, string>;
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  hiddenCols?: number[];
  hiddenRows?: number[];
  dimsAuthoritative: boolean;
  /** Client-reported styles/dims differ from the source's: regenerate. */
  presentationChanged: boolean;
}

function canonicalStyleJson(style: object | undefined): string {
  if (!style) return '';
  const rec = style as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(rec).sort()) {
    if (k === 'numberFormatCode') continue;
    if (rec[k] !== undefined) rest[k] = rec[k];
  }
  return JSON.stringify(rest);
}

/**
 * True when the client's reported styles for a sheet resolve to
 * anything different from the source file's own styles/formats. The
 * comparison is per cell over the union of keys, on the RESOLVED
 * (style, format code) pair: a client entry {numberFormatCode: X}
 * equals a source formats entry X with no style record.
 */
function clientStylesDiffer(
  client: Record<string, CellStyle>,
  parsed: DirectSaveParsedSheet,
): boolean {
  const pStyles = parsed.styles ?? {};
  const pFormats = parsed.formats ?? {};
  const keys = new Set([...Object.keys(client), ...Object.keys(pStyles), ...Object.keys(pFormats)]);
  for (const key of keys) {
    const cs = client[key];
    const ps = pStyles[key];
    const cCode = cs?.numberFormatCode;
    const pCode = ps?.numberFormatCode ?? pFormats[key];
    if (cCode !== pCode) return true;
    if (canonicalStyleJson(cs) !== canonicalStyleJson(ps)) return true;
  }
  return false;
}

function dimsEqual(
  a: { colWidths?: Record<string, number>; rowHeights?: Record<string, number>; hiddenCols?: number[]; hiddenRows?: number[] },
  b: typeof a,
): boolean {
  return (
    JSON.stringify(a.colWidths ?? {}) === JSON.stringify(b.colWidths ?? {}) &&
    JSON.stringify(a.rowHeights ?? {}) === JSON.stringify(b.rowHeights ?? {}) &&
    JSON.stringify(a.hiddenCols ?? []) === JSON.stringify(b.hiddenCols ?? []) &&
    JSON.stringify(a.hiddenRows ?? []) === JSON.stringify(b.hiddenRows ?? [])
  );
}

function* fileChunks(path: string): Generator<Uint8Array> {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      yield new Uint8Array(buf.buffer, buf.byteOffset, n).slice();
    }
  } finally {
    closeSync(fd);
  }
}

const decoder = new TextDecoder();

type SerializePartial = Omit<DirectSaveResult, 'bytes' | 'serializeMs'>;

/**
 * Chart-cache resolver over the serializer's grouped bulk readback:
 * the chart author computes each part's strCache/numCache from these
 * live values, so first paint (Excel and our own importer, which read
 * the caches) is correct before any recalc.
 */
function chartResolverFromGrouped(grouped: Map<string, StreamSaveCell[]>): ChartCellResolver {
  const bySheet = new Map<string, Map<string, StreamSaveCell>>();
  for (const [sheet, cells] of grouped) {
    const m = new Map<string, StreamSaveCell>();
    for (const c of cells) m.set(`${c.row}:${c.col}`, c);
    bySheet.set(sheet, m);
  }
  return (sheet, row, col) => {
    const cell = bySheet.get(sheet)?.get(`${row}:${col}`);
    if (!cell) return { text: '', num: null };
    const v = cell.value;
    if (v) {
      if (v.kind === 'number') return { text: '', num: typeof v.value === 'number' ? v.value : null };
      if (v.kind === 'string') return { text: String(v.value), num: null };
      if (v.kind === 'boolean') return { text: String(v.value), num: null };
    }
    if (typeof cell.input === 'string' && !cell.input.startsWith('=')) return { text: cell.input, num: null };
    if (typeof cell.input === 'number') return { text: '', num: cell.input };
    return { text: '', num: null };
  };
}

function authorSpecsOf(charts: ChartSpec[] | undefined): ChartAuthorSpec[] {
  return (charts ?? []) as unknown as ChartAuthorSpec[];
}

// ---------------------------------------------------------------------------
// serializeLiveWorkbook
// ---------------------------------------------------------------------------

export function serializeLiveWorkbook(input: DirectSaveInput): DirectSaveResult {
  const log = input.log ?? ((): void => undefined);
  const tSerialize = performance.now();

  // Group the bulk readback by sheet. Cells hidden from the
  // requesting principal arrive as #PERM! error values in the
  // readback: they are dropped here, never leaked into the file
  // (the protection model's per-subject filtered view).
  const grouped = new Map<string, StreamSaveCell[]>();
  for (const cell of input.bulk) {
    const v = cell.value as TypedValue;
    if (v.kind === 'error' && v.code === '#PERM!') continue; // hidden from this principal: dropped, never leaked
    const ref = cell.ref as CellRef;
    let arr = grouped.get(ref.sheet);
    if (!arr) {
      arr = [];
      grouped.set(ref.sheet, arr);
    }
    arr.push({ row: ref.row, col: ref.col, input: cell.input, value: v });
  }
  for (const arr of grouped.values()) arr.sort((a, b) => a.row - b.row || a.col - b.col);

  const sheetNames = input.sheetNames;
  const metaByName = new Map(input.sheets.map((s) => [s.name, s]));
  // Resolve each sheet's presentation state: the client's reported
  // styles/dims are authoritative WHEN REPORTED (the D4 rule), the
  // source's own records otherwise — and "reported" only means
  // "changed" when the resolved values actually differ from the
  // source's, which is what keeps an unedited save fully verbatim
  // even though the browser reports every sheet.
  const resolvedByName = new Map<string, ResolvedSheet>();
  for (const name of sheetNames) {
    const sheetMeta = metaByName.get(name);
    const parsed = input.parsedSheets.get(name) ?? {};
    let styles: Record<string, CellStyle> = parsed.styles ?? {};
    let formats: Record<string, string> = parsed.formats ?? {};
    let presentationChanged = false;
    if (sheetMeta?.clientStyles) {
      const client = sheetMeta.styles ?? {};
      if (clientStylesDiffer(client, parsed)) presentationChanged = true;
      styles = client;
      formats = {};
      for (const [key, style] of Object.entries(client)) {
        if (style.numberFormatCode) formats[key] = style.numberFormatCode;
      }
    }
    const baseDims = {
      colWidths: parsed.colWidths,
      rowHeights: parsed.rowHeights,
      hiddenCols: parsed.hiddenCols,
      hiddenRows: parsed.hiddenRows,
    };
    let dims = baseDims;
    let dimsAuthoritative = false;
    if (sheetMeta?.clientDims && sheetMeta.dims) {
      dimsAuthoritative = true;
      dims = {
        colWidths: sheetMeta.dims.colWidths ?? baseDims.colWidths,
        rowHeights: sheetMeta.dims.rowHeights ?? baseDims.rowHeights,
        hiddenCols: sheetMeta.dims.hiddenCols ?? baseDims.hiddenCols,
        hiddenRows: sheetMeta.dims.hiddenRows ?? baseDims.hiddenRows,
      };
      if (!dimsEqual(dims, baseDims)) presentationChanged = true;
    }
    resolvedByName.set(name, {
      styles,
      formats,
      ...dims,
      dimsAuthoritative,
      presentationChanged,
    });
  }

  // Verbatim eligibility, per op type (Addendum 5):
  // - row/col structural ops (ROWCOL_OPS, sheet set unchanged) stay
  //   verbatim with ALL sheets regenerated — an address shift makes
  //   per-cell reuse invalid, but the bulk already carries post-shift
  //   addresses, so no adapter round-trip is needed;
  // - the adapter fallback remains ONLY for a changed sheet-name set
  //   (sheet add/delete/rename/move) or another structural op the
  //   verbatim planner cannot handle (not a cell op, not a name op,
  //   not a row/col op — e.g. setCalculationMode).
  const rowColStructural = input.ops.some((op) => ROWCOL_OPS.has(op.cmd));
  const unhandledStructuralOp = input.ops.find(
    (op) => !CELL_OPS.has(op.cmd) && !NAME_OPS.has(op.cmd) && !ROWCOL_OPS.has(op.cmd),
  );
  const sourceSheetNames = [...input.parsedSheets.keys()];
  const sameSheets =
    !input.sourceBytes ||
    (sheetNames.length === sourceSheetNames.length &&
      sheetNames.every((n, i) => n === sourceSheetNames[i]));
  let fallbackReason: string | undefined;
  if (input.sourceBytes && !sameSheets) fallbackReason = 'sheet-set-changed';
  else if (input.sourceBytes && unhandledStructuralOp) {
    fallbackReason = `structural-op:${unhandledStructuralOp.cmd}`;
  }
  let partial: SerializePartial;
  if (fallbackReason !== undefined) {
    log(`[direct-save] verbatim-ineligible (${fallbackReason}) -> adapter fallback`);
    partial = serializeViaAdapter(input, grouped, sheetNames, resolvedByName, fallbackReason);
  } else if ((input.charts?.length ?? 0) > 0 && !input.sourceBytes) {
    // Native chart authoring needs a source package to operate on
    // (blank never-loaded workbooks have no package parts yet); route
    // through the adapter fallback, whose output bytes CAN be
    // injected, instead of silently dropping the charts.
    log('[direct-save] session charts with no source package -> adapter fallback (chart injection)');
    partial = serializeViaAdapter(input, grouped, sheetNames, resolvedByName, 'charts-no-source-package');
  } else {
    if (rowColStructural) {
      log('[direct-save] row/col structural op -> verbatim, all sheets regenerated (address shift invalidates per-cell reuse)');
    }
    try {
      partial = serializeVerbatim(input, grouped, sheetNames, resolvedByName, rowColStructural);
    } catch (e) {
      // The fault-injection hook must surface as a save failure, not
      // be swallowed by the fallback retry below.
      if (midwriteFaultEnabled() && e instanceof Error && e.message === 'injected save fault (midwrite)') {
        throw e;
      }
      // A verbatim-planning failure (unparseable styles, a chartsheet
      // in the changed set, ...) must not lose the save: the adapter
      // fallback runs over the same provided readback.
      log(`[direct-save] verbatim path failed (${e instanceof Error ? e.message : String(e)}) -> adapter fallback`);
      partial = serializeViaAdapter(input, grouped, sheetNames, resolvedByName, 'verbatim-failed');
    }
  }
  const serializeMs = Math.round(performance.now() - tSerialize);
  return {
    ...partial,
    bytes: statSync(input.outPath).size,
    serializeMs,
  };
}

// ---------------------------------------------------------------------------
// Verbatim + streaming path (ported from saveWorkerCore.ts)
// ---------------------------------------------------------------------------

function serializeVerbatim(
  input: DirectSaveInput,
  grouped: Map<string, StreamSaveCell[]>,
  sheetNames: string[],
  resolvedByName: Map<string, ResolvedSheet>,
  forceAllChanged: boolean,
): SerializePartial {
  const sourceBytes = input.sourceBytes;
  const files: Record<string, Uint8Array> = sourceBytes ? (unzipPackage(sourceBytes) ?? {}) : {};
  if (sourceBytes && Object.keys(files).length === 0) throw new Error('source package unreadable');
  const partsBySheet = sourceBytes ? formulaRecoverySheetPartPaths(files) : new Map<string, string>();

  // Item B: table definitions retained in the source package, for
  // structured-reference restoration on regenerated sheets. The bulk
  // readback only carries the A1 forms import produced; without this,
  // a changed sheet's formulas persist as A1 expansions while its
  // table parts survive verbatim. tablesBySheet groups them per
  // owning sheet; each regenerated sheet receives the FULL set
  // because restoreStructuredRefs matches qualified references by
  // the sheet they name (a formula on Calc may reference Data's
  // table). Best-effort: no tables -> today's A1 behavior.
  let structuredRefTables: TableDef[] = [];
  if (sourceBytes) {
    try {
      const tablesBySheetMap = tablesBySheet(readTables(files, sheetNames));
      structuredRefTables = [...tablesBySheetMap.values()].flat();
    } catch {
      structuredRefTables = [];
    }
  }

  // FIX-G native chart authoring (trace §4.1d, verbatim path): author
  // the session charts into the source files map BEFORE the changed
  // set is derived. authorChartParts mutates the map in place — new
  // chart parts, merged/new drawing parts + rels, sheet rels, the
  // sheet's <drawing> element for newly-drawn sheets, and the
  // [Content_Types].xml overrides — so the assembly loop below copies
  // the authored parts exactly like any other package part. Its dedup
  // rule makes repeat saves non-duplicating.
  const chartSpecs = authorSpecsOf(input.charts);
  let chartDrawingRids = new Map<string, string>();
  if (chartSpecs.length > 0 && sourceBytes) {
    const authored = authorChartParts(files, chartSpecs, {
      resolveCell: chartResolverFromGrouped(grouped),
    });
    chartDrawingRids = authored.drawingRidBySheet;
  }

  // #125 moved-native-chart re-anchor (verbatim path): rewrite the
  // moved charts' twoCellAnchors in the source package's drawing parts
  // BEFORE the changed set is derived. Drawing parts copy verbatim
  // from this map, so the rewritten anchors ride along with no
  // changed-set change (the sheet XML <drawing> element is unchanged).
  // Fail-safe by construction: reanchorNativeChartParts never throws
  // and skips unmatchable pairs, leaving the original position.
  if ((input.movedNativeCharts?.length ?? 0) > 0 && sourceBytes) {
    const reanchored = reanchorNativeChartParts(files, input.movedNativeCharts ?? []);
    input.log?.(
      `[direct-save] native re-anchor: rewritten=${reanchored.rewritten} skipped=${reanchored.skipped.length} ${JSON.stringify(reanchored.skipped).slice(0, 300)}`,
    );
  }

  // Changed set: sheets touched by cell ops + sheets whose resolved
  // presentation actually differs from the source's + sheets with no
  // source part (handled in the loop below). A row/col structural op
  // forces EVERY sheet changed: addresses shifted, so no sheet's
  // cells can be reused per-cell — each regenerates from the bulk
  // (non-sheet parts still copy verbatim).
  const changed = new Set<string>();
  if (forceAllChanged) {
    for (const name of sheetNames) changed.add(name);
  }
  for (const op of input.ops) {
    if (CELL_OPS.has(op.cmd)) {
      const ref = op.ref;
      if (ref?.sheet) changed.add(ref.sheet);
    }
  }
  for (const [name, resolved] of resolvedByName) {
    if (resolved.presentationChanged) changed.add(name);
  }
  // Chart anchor sheets are forced changed (trace §4.1d): their
  // regenerated XML is what carries the <drawing> element for a sheet
  // that gained its first drawing part this save.
  for (const spec of chartSpecs) {
    if (spec.range?.sheet) changed.add(spec.range.sheet);
  }

  const stylesText = files['xl/styles.xml'] ? decoder.decode(files['xl/styles.xml']) : MINIMAL_STYLES_XML;
  const resolver = createStreamingStyles(stylesText);

  const tmp = mkdtempSync(join(tmpdir(), 'icecream-savegen-'));
  const generated = new Map<string, { kind: 'file'; path: string } | { kind: 'text'; text: string }>();
  const changedSheets: string[] = [];
  try {
    sheetNames.forEach((name, idx) => {
      const partPath = partsBySheet.get(name);
      if (!changed.has(name) && partPath && files[partPath]) return; // verbatim
      const meta = resolvedByName.get(name);
      const cells = [...(grouped.get(name) ?? [])];
      const stylesRec = meta?.styles ?? {};
      const formatsRec = meta?.formats ?? {};
      const present = new Set(cells.map((c) => `${c.row}:${c.col}`));
      for (const c of cells) {
        const key = `${c.row}:${c.col}`;
        if (stylesRec[key]) c.style = stylesRec[key];
        if (formatsRec[key]) c.formatCode = formatsRec[key];
      }
      // Formatted-but-empty cells materialize as empty styled <c>
      // elements (what Excel does; never a phantom value).
      for (const key of new Set([...Object.keys(stylesRec), ...Object.keys(formatsRec)])) {
        if (present.has(key)) continue;
        const [r, c] = key.split(':').map(Number);
        if (Number.isInteger(r) && Number.isInteger(c)) {
          cells.push({ row: r as number, col: c as number, input: null, style: stylesRec[key], formatCode: formatsRec[key] });
        }
      }
      cells.sort((a, b) => a.row - b.row || a.col - b.col);
      const sourceXml = partPath && files[partPath] ? decoder.decode(files[partPath]) : null;
      const tmpFile = join(tmp, `sheet-${idx}.xml`);
      const fd = openSync(tmpFile, 'w');
      try {
        for (const chunk of sheetXmlChunks({
          sourceXml,
          cells,
          xfFor: (s, f) => resolver.xfFor(s, f),
          colWidths: meta?.colWidths,
          rowHeights: meta?.rowHeights,
          hiddenCols: meta?.hiddenCols,
          hiddenRows: meta?.hiddenRows,
          dimsAuthoritative: meta?.dimsAuthoritative ?? false,
          drawingRid: chartDrawingRids.get(name),
          structuredRefTables: structuredRefTables.length > 0 ? structuredRefTables : undefined,
          sheetName: name,
        })) {
          writeSync(fd, Buffer.from(chunk, 'utf8'));
        }
      } finally {
        closeSync(fd);
      }
      generated.set(partPath ?? `xl/worksheets/sheet${idx + 1}.xml`, { kind: 'file', path: tmpFile });
      changedSheets.push(name);
    });

    const stylesGenerated = resolver.dirty ? resolver.toXml() : null;
    const wbPath = 'xl/workbook.xml';
    let workbookGenerated: string | null = null;
    if (sourceBytes) {
      const wbXml = files[wbPath] ? decoder.decode(files[wbPath]) : '';
      if (!wbXml || !definedNamesEqual(wbXml, input.definedNames)) {
        workbookGenerated = wbXml ? regenerateWorkbookXml(wbXml, input.definedNames) : synthesizeWorkbookXml(sheetNames, input.definedNames);
      }
    } else {
      workbookGenerated = synthesizeWorkbookXml(sheetNames, input.definedNames);
    }
    const customPath = 'docProps/custom.xml';
    const customSrc = files[customPath] ? decoder.decode(files[customPath]) : null;
    const customMerged = mergeCustomPropsXml(customSrc, input.metadata);
    const customGenerated = customMerged.changed ? customMerged.xml : null;

    const dropCalc = changedSheets.length > 0 && 'xl/calcChain.xml' in files;
    const ctPath = '[Content_Types].xml';
    let ctGenerated: string | null = null;
    if (!sourceBytes) {
      ctGenerated = synthesizeContentTypes(sheetNames.length, customGenerated !== null);
    } else if (files[ctPath]) {
      let ct = decoder.decode(files[ctPath]);
      const before = ct;
      if (dropCalc) ct = removeContentTypeOverride(ct, '/xl/calcChain.xml');
      if (customGenerated !== null && !files[customPath]) {
        ct = ensureContentTypeOverride(ct, '/docProps/custom.xml', 'application/vnd.openxmlformats-officedocument.custom-properties+xml');
      }
      if (stylesGenerated !== null && !files['xl/styles.xml']) {
        ct = ensureContentTypeOverride(ct, '/xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml');
      }
      if (ct !== before) ctGenerated = ct;
    }

    // Assemble in source order; generated/additional parts substituted
    // or appended. Everything not named here is copied byte-for-byte.
    const entries: ZipEntrySource[] = [];
    const regeneratedParts: string[] = [];
    const droppedParts: string[] = [];
    let verbatimParts = 0;
    const seen = new Set<string>();
    // Test-only fault injection: the FIRST regenerated sheet entry
    // fed to the zip throws after its chunks — genuinely mid-write.
    let faultPending = midwriteFaultEnabled();
    const pushText = (name: string, text: string): void => {
      entries.push({ name, chunks: () => textChunks(text) });
      regeneratedParts.push(name);
      seen.add(name);
    };
    const pushGenerated = (name: string): void => {
      const gen = generated.get(name) as { kind: 'file'; path: string };
      if (faultPending) {
        faultPending = false;
        entries.push({ name, chunks: () => throwAfterChunks(fileChunks(gen.path)) });
      } else {
        entries.push({ name, chunks: () => fileChunks(gen.path) });
      }
      regeneratedParts.push(name);
      seen.add(name);
    };
    if (sourceBytes) {
      for (const name of Object.keys(files)) {
        if (dropCalc && name === 'xl/calcChain.xml') {
          droppedParts.push(name);
          continue;
        }
        if (generated.has(name)) {
          pushGenerated(name);
          continue;
        }
        if (name === 'xl/styles.xml' && stylesGenerated !== null) {
          pushText(name, stylesGenerated);
          continue;
        }
        if (name === wbPath && workbookGenerated !== null) {
          pushText(name, workbookGenerated);
          continue;
        }
        if (name === customPath && customGenerated !== null) {
          pushText(name, customGenerated);
          continue;
        }
        if (name === ctPath && ctGenerated !== null) {
          pushText(name, ctGenerated);
          continue;
        }
        entries.push({ name, chunks: () => verbatimChunks(files[name] as Uint8Array) });
        verbatimParts++;
        seen.add(name);
      }
      for (const name of generated.keys()) if (!seen.has(name)) pushGenerated(name);
      if (workbookGenerated !== null && !seen.has(wbPath)) pushText(wbPath, workbookGenerated);
      if (stylesGenerated !== null && !seen.has('xl/styles.xml')) pushText('xl/styles.xml', stylesGenerated);
      if (customGenerated !== null && !seen.has(customPath)) pushText(customPath, customGenerated);
      if (ctGenerated !== null && !seen.has(ctPath)) pushText(ctPath, ctGenerated);
    } else {
      pushText(ctPath, ctGenerated as string);
      entries.push({ name: '_rels/.rels', chunks: () => textChunks(synthesizeRootRels()) });
      pushText(wbPath, workbookGenerated as string);
      entries.push({
        name: 'xl/_rels/workbook.xml.rels',
        chunks: () => textChunks(synthesizeWorkbookRels(sheetNames.length)),
      });
      if (stylesGenerated !== null) pushText('xl/styles.xml', stylesGenerated);
      else {
        entries.push({ name: 'xl/styles.xml', chunks: () => textChunks(stylesText) });
        seen.add('xl/styles.xml');
      }
      for (const name of generated.keys()) pushGenerated(name);
      if (customGenerated !== null) pushText(customPath, customGenerated);
    }

    const outFd = openSync(input.outPath, 'w');
    try {
      streamZipToSink(entries, (chunk) => {
        writeSync(outFd, chunk);
      });
    } finally {
      closeSync(outFd);
    }
    return { mode: 'verbatim', changedSheets, verbatimParts, regeneratedParts, droppedParts };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Generated-sheet temp files are scratch; cleanup is best-effort.
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter fallback: classic SheetJS write over the provided readback —
// used only for a changed sheet-name set, a structural op the
// verbatim planner cannot handle (see fallbackReason), or when the
// source package defeats verbatim planning. Row/col structural ops
// never land here (they stay verbatim, all sheets regenerated).
// ---------------------------------------------------------------------------

/**
 * ADAPTER FALLBACK ONLY — grouped-cells → dense WorkbookData
 * conversion, equivalent to engineSvc.snapshotToWorkbookData: dense
 * row arrays sized by the max row/col present in the grouped cells,
 * null-filled, with each cell's input placed at its (row, col). The
 * verbatim path never touches this; it exists so the fallback can
 * hand XlsxAdapter the dense grids it requires.
 */
function groupedToWorkbookData(
  grouped: Map<string, StreamSaveCell[]>,
  sheetNames: string[],
  metadata: Record<string, unknown>,
  definedNames: DefinedName[],
): WorkbookData {
  const sheets = sheetNames.map((name) => {
    const cells = grouped.get(name) ?? [];
    let maxRow = -1;
    let maxCol = -1;
    for (const cell of cells) {
      if (cell.row > maxRow) maxRow = cell.row;
      if (cell.col > maxCol) maxCol = cell.col;
    }
    const rows: CellInput[][] = [];
    for (let r = 0; r <= maxRow; r++) {
      const row: CellInput[] = [];
      for (let c = 0; c <= maxCol; c++) row.push(null);
      rows.push(row);
    }
    for (const cell of cells) {
      const target = rows[cell.row];
      if (target) target[cell.col] = cell.input;
    }
    return { name, rows };
  });
  return { sheets, metadata: { ...metadata }, definedNames };
}

function serializeViaAdapter(
  input: DirectSaveInput,
  grouped: Map<string, StreamSaveCell[]>,
  sheetNames: string[],
  resolvedByName: Map<string, ResolvedSheet>,
  fallbackReason: string,
): SerializePartial {
  const wbData = groupedToWorkbookData(grouped, sheetNames, input.metadata, input.definedNames);
  for (const sheet of wbData.sheets) {
    const meta = resolvedByName.get(sheet.name);
    if (!meta) continue;
    if (meta.colWidths && Object.keys(meta.colWidths).length > 0) sheet.colWidths = meta.colWidths;
    if (meta.rowHeights && Object.keys(meta.rowHeights).length > 0) sheet.rowHeights = meta.rowHeights;
    if (meta.hiddenCols && meta.hiddenCols.length > 0) sheet.hiddenCols = meta.hiddenCols;
    if (meta.hiddenRows && meta.hiddenRows.length > 0) sheet.hiddenRows = meta.hiddenRows;
    if (Object.keys(meta.styles).length > 0) {
      sheet.styles = meta.styles;
      if (Object.keys(meta.formats).length > 0) sheet.formats = meta.formats;
    } else if (Object.keys(meta.formats).length > 0) {
      sheet.formats = meta.formats;
    }
  }
  // Item B (adapter fallback): groupedToWorkbookData drops the table
  // definitions the classic write needs — without them the fallback
  // loses even the xl/tables parts (not just the structured refs).
  // Derive them from the retained source package (source sheet names
  // from the parsedSheets keys, which are the source's name set) and
  // attach them to their sheets: XlsxAdapter.write then re-emits the
  // table parts AND restores structured refs in formulas. Sheets
  // renamed since the source keep no tables (attach matches by the
  // table's own sheet name) — graceful, as before for other features.
  if (input.sourceBytes) {
    try {
      const srcFiles = unzipPackage(input.sourceBytes);
      if (srcFiles) {
        const srcTables = readTables(srcFiles, [...input.parsedSheets.keys()]);
        if (srcTables.length > 0) attachTablesToSheets(wbData.sheets, srcTables);
      }
    } catch {
      // Best-effort: table attachment must never break the fallback save.
    }
  }
  let bytes = new XlsxAdapter().write(wbData);
  // FIX-G native chart authoring (trace §4.1d, adapter-fallback path):
  // the classic adapter drops drawing/chart parts, so session charts
  // are injected into its output bytes. The fallback package carries
  // no imported parts, so the dedup rule is trivially satisfied.
  const chartSpecs = authorSpecsOf(input.charts);
  if (chartSpecs.length > 0) {
    bytes = injectChartParts(bytes, chartSpecs, { resolveCell: chartResolverFromGrouped(grouped) });
  }
  if (midwriteFaultEnabled()) {
    // Test-only fault injection (adapter path): a partial write,
    // then the throw — the output is abandoned mid-save.
    writeFileSync(input.outPath, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
    throw new Error('injected save fault (midwrite)');
  }
  writeFileSync(input.outPath, bytes);
  return {
    mode: 'adapter-fallback',
    fallbackReason,
    changedSheets: [...sheetNames],
    verbatimParts: 0,
    regeneratedParts: ['(whole package via XlsxAdapter fallback)'],
    droppedParts: [],
  };
}
