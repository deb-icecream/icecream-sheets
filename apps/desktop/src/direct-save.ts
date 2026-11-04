/**
 * Desktop direct-streaming save (direct-save pass — SAVE SERIALIZATION
 * INVARIANT): whole-workbook .xlsx saves serialize from the MAIN
 * process's LIVE EngineHost through the SAME shared streaming serializer
 * the web/gateway path uses (@icecream-sheets/service/save-node
 * serializeLiveWorkbook) — no fork, and no renderer snapshot
 * (snapshot→dense→SheetJS) anywhere on this path.
 *
 * This module holds:
 *  - the save-op journal: every successful mutating engine command since
 *    the current workbook was loaded, in execution order (the serializer
 *    decides from it which sheets changed and whether the verbatim
 *    planner can reason about the save);
 *  - serializeDesktopWorkbook(): assembles the serializer input from the
 *    live host (bulk readback, live defined names, sheet names), the
 *    retained save base (./engine-load: source bytes, parsed per-sheet
 *    presentation, adapter metadata) and the renderer's session extras
 *    (the buildServerSaveExtras shape: extraMetadata / definedNames /
 *    sheetDims / sheetStyles), forwarding client styles/dims in exactly
 *    the gateway buildSaveHandoff shape;
 *  - saveToDestinationAtomically(): the Excel save sequence (user
 *    directive, 2026-10-21) — serialize to a temp file IN THE
 *    DESTINATION'S DIRECTORY, verify the finished package, then
 *    atomically rename over the destination. Any failure before the
 *    rename leaves a pre-existing destination byte-identical.
 *
 * The service package ships as ESM and desktop main compiles to CJS, so
 * save-node is loaded with dynamic import() (cached), exactly like
 * engine-load.ts loads the adapters/service.
 */

import { renameSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type {
  CellRef,
  CellStyle,
  DefinedName,
  EngineHost,
} from '@icecream-sheets/engine';
import { getDesktopSaveBase } from './engine-load';

// ---------------------------------------------------------------------------
// Shared serializer contract (@icecream-sheets/service/save-node)
// ---------------------------------------------------------------------------

/** One bulk-readback cell (the EngineHost.bulkReadback element shape). */
export interface LiveBulkCell {
  ref: CellRef;
  input: unknown;
  value: unknown;
}

/** Per-sheet client-reported save state (the gateway SaveWorkerSheetMeta shape). */
export interface LiveSaveSheetMeta {
  name: string;
  clientStyles: boolean;
  styles?: Record<string, CellStyle>;
  clientDims: boolean;
  dims?: {
    colWidths?: Record<string, number>;
    rowHeights?: Record<string, number>;
    hiddenCols?: number[];
    hiddenRows?: number[];
  };
}

export interface SerializeLiveWorkbookInput {
  bulk: Array<{ ref: CellRef; input: unknown; value: unknown }>;
  sheetNames: string[];
  definedNames: DefinedName[];
  metadata: Record<string, unknown>;
  sourceBytes: Uint8Array | null;
  parsedSheets: Map<
    string,
    {
      styles?: Record<string, CellStyle>;
      formats?: Record<string, string>;
      colWidths?: Record<string, number>;
      rowHeights?: Record<string, number>;
      hiddenCols?: number[];
      hiddenRows?: number[];
    }
  >;
  sheets: LiveSaveSheetMeta[];
  ops: Array<{ cmd: string; ref?: CellRef }>;
  outPath: string;
  log?: (m: string) => void;
}

export interface SerializeLiveWorkbookResult {
  mode: 'verbatim' | 'adapter-fallback';
  bytes: number;
  changedSheets: string[];
  verbatimParts: number;
  regeneratedParts: string[];
  droppedParts: string[];
  serializeMs: number;
}

/** The save-node module shape this file codes against. */
export interface SaveNodeModule {
  serializeLiveWorkbook: (
    input: SerializeLiveWorkbookInput,
  ) => Promise<SerializeLiveWorkbookResult> | SerializeLiveWorkbookResult;
  DIRECT_SAVE_MUTATING_OPS: ReadonlySet<string>;
  verifyXlsxPackage: (filePath: string) => unknown;
}

let saveNodePromise: Promise<SaveNodeModule> | null = null;

/**
 * Load @icecream-sheets/service/save-node once (cached). The specifier
 * is held in a variable so this CJS build does not statically resolve a
 * node-only ESM subpath at compile time; the runtime import is the same
 * dynamic-import pattern engine-load.ts uses for the service package.
 * Exported for tests.
 */
export function loadSaveNode(): Promise<SaveNodeModule> {
  if (!saveNodePromise) {
    const specifier = '@icecream-sheets/service/save-node';
    saveNodePromise = import(specifier).then(
      (m) => m as unknown as SaveNodeModule,
      (e: unknown) => {
        // Never cache a failure: a later save may run after the service
        // build exists (dev reload), and must not inherit a stale miss.
        saveNodePromise = null;
        throw e;
      },
    );
  }
  return saveNodePromise;
}

// ---------------------------------------------------------------------------
// Save-op journal
// ---------------------------------------------------------------------------

/** One journaled save op (the serializer's op shape: cmd + optional cell ref). */
export interface DesktopSaveOp {
  cmd: string;
  ref?: CellRef;
}

let saveOps: DesktopSaveOp[] = [];

/** Journal one successful mutating command (called from engine-ipc). */
export function noteDesktopSaveOp(op: DesktopSaveOp): void {
  saveOps.push(op.ref ? { cmd: op.cmd, ref: { ...op.ref } } : { cmd: op.cmd });
  // Continuous checkpointing (Addendum 3): every journaled op (re)arms
  // the settle timer / may force an immediate flush at the op cap.
  onOpsJournaled();
}

/** Drop the journal (load / new workbook: a fresh replay base begins). */
export function clearDesktopSaveOps(): void {
  saveOps = [];
  // The storage watermark counts journal positions: a fresh journal
  // restarts it, and any armed checkpoint timer is moot.
  storageRevision = 0;
  // Session extras are per-workbook state (Addendum 6): a fresh load
  // starts clean and the renderer re-syncs its extras for the new
  // workbook — stale extras must never leak into its first checkpoint.
  pendingExtras = {};
  pendingExtrasCanonical = '{}';
  extrasDirty = false;
  extrasVersionAtLastSerialize = null;
  if (checkpointTimer) {
    clearTimeout(checkpointTimer);
    checkpointTimer = null;
  }
}

/** A copy of the current journal (tests/diagnostics; the save path copies too). */
export function getDesktopSaveOps(): DesktopSaveOp[] {
  return saveOps.map((op) => (op.ref ? { cmd: op.cmd, ref: { ...op.ref } } : { cmd: op.cmd }));
}

/**
 * The mutating-command set for journaling: DIRECT_SAVE_MUTATING_OPS from
 * the shared save-node module, loaded lazily and cached. When the module
 * cannot be loaded (service build absent), a local mirror of the same set
 * (the gateway engine service's SAVE_MUTATING_OPS list — every
 * EngineCommand verb that mutates workbook state) keeps journaling
 * correct; the serializer load itself still fails closed at save time.
 */
const FALLBACK_MUTATING_OPS: ReadonlySet<string> = new Set([
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

/**
 * Op classes for checkpoint batches (Addendum 5 — mirrors the gateway's
 * CHECKPOINT_CELL_OPS / CHECKPOINT_NAME_OPS and the shared serializer's
 * planner classes in service/save/directSave.ts): cell ops touch
 * contents only; name ops touch the defined-names table (workbook.xml);
 * anything else mutating is STRUCTURAL.
 */
export const CHECKPOINT_CELL_OPS: ReadonlySet<string> = new Set([
  'setCell',
  'setFormula',
]);
export const CHECKPOINT_NAME_OPS: ReadonlySet<string> = new Set([
  'defineName',
  'deleteName',
  'renameName',
  'updateNameRefersTo',
  'defineFunction',
  'updateFunction',
  'rollbackFunction',
  'deleteFunction',
]);
/** Structural ops that shift cell addresses (rows/cols inserted/deleted). */
export const ROW_COL_STRUCTURAL_OPS: ReadonlySet<string> = new Set([
  'insertRows',
  'deleteRows',
  'insertCols',
  'deleteCols',
]);
/** Structural ops that change the sheet set itself. */
export const SHEET_SET_STRUCTURAL_OPS: ReadonlySet<string> = new Set([
  'addSheet',
  'deleteSheet',
  'renameSheet',
  'duplicateSheet',
  'moveSheet',
]);

/**
 * True when `cmd` is a structural mutating op for barrier purposes
 * (Addendum 5): a mutating op that is neither a cell op nor a name op.
 * Structural ops are the batch boundary — see
 * flushCheckpointBeforeStructuralOp.
 */
export function isStructuralBarrierOp(cmd: string): boolean {
  return (
    FALLBACK_MUTATING_OPS.has(cmd) &&
    !CHECKPOINT_CELL_OPS.has(cmd) &&
    !CHECKPOINT_NAME_OPS.has(cmd)
  );
}

export interface CheckpointBatchNote {
  /** Any structural op in the batch. */
  structural: boolean;
  /** Any insert/delete rows/cols op (address-shifting). */
  rowColStructural: boolean;
  /**
   * Why an adapter-fallback materialization of this batch is expected,
   * or null when the batch is verbatim-shaped (cells/names/row-col
   * only). Sheet-set changes and calculation-mode changes force
   * adapter-fallback in the shared serializer; the reason is surfaced
   * in the checkpoint log, never silent (Addendum 5).
   */
  fallbackReason: 'sheet-set-change' | 'calculation-mode-change' | 'structural-op' | null;
}

/** Classify one checkpoint batch (a journal slice) for logging/reporting. */
export function checkpointBatchNote(
  ops: readonly DesktopSaveOp[],
): CheckpointBatchNote {
  let structural = false;
  let rowColStructural = false;
  let fallbackReason: CheckpointBatchNote['fallbackReason'] = null;
  for (const op of ops) {
    if (ROW_COL_STRUCTURAL_OPS.has(op.cmd)) {
      structural = true;
      rowColStructural = true;
    } else if (SHEET_SET_STRUCTURAL_OPS.has(op.cmd)) {
      structural = true;
      fallbackReason = 'sheet-set-change';
    } else if (op.cmd === 'setCalculationMode') {
      structural = true;
      if (fallbackReason === null) fallbackReason = 'calculation-mode-change';
    } else if (isStructuralBarrierOp(op.cmd)) {
      structural = true;
      if (fallbackReason === null) fallbackReason = 'structural-op';
    }
  }
  return { structural, rowColStructural, fallbackReason };
}

let mutatingOpsCache: ReadonlySet<string> | null = null;

export async function loadDirectSaveMutatingOps(): Promise<ReadonlySet<string>> {
  if (mutatingOpsCache) return mutatingOpsCache;
  try {
    const mod = await loadSaveNode();
    const set = mod.DIRECT_SAVE_MUTATING_OPS;
    if (set && typeof (set as ReadonlySet<string>).has === 'function') {
      mutatingOpsCache = set;
      return set;
    }
  } catch {
    // Fall through to the mirror set (see above).
  }
  return FALLBACK_MUTATING_OPS;
}

// ---------------------------------------------------------------------------
// Defined-name merge (defect E1 rule)
// ---------------------------------------------------------------------------

/**
 * Merge defined-name lists for a save: keyed by scope (sheet index;
 * undefined = workbook) + case-insensitive name, EARLIER lists win,
 * later lists contribute only names the earlier ones lack; malformed
 * entries are dropped. Neither the engine nor the service package
 * exports this helper (the existing copies live in packages/gateway
 * engineSvc.ts and apps/web io.ts — neither is importable from the
 * desktop main process: gateway is not a desktop dependency and the web
 * app is renderer code), so the exact semantics are mirrored here and
 * pinned by the direct-save tests.
 */
export function mergeDefinedNames(
  ...lists: Array<readonly DefinedName[] | undefined>
): DefinedName[] {
  const out: DefinedName[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const dn of list ?? []) {
      if (!dn || typeof dn.name !== 'string' || typeof dn.ref !== 'string') continue;
      const key = `${dn.sheet ?? ''}\0${dn.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        dn.sheet !== undefined
          ? { name: dn.name, ref: dn.ref, sheet: dn.sheet }
          : { name: dn.name, ref: dn.ref },
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session-extras handling (the renderer's buildServerSaveExtras shape)
// ---------------------------------------------------------------------------

/** The session extras the renderer sends with engine:saveXlsxDirect. */
export interface DesktopSaveExtras {
  extraMetadata?: unknown;
  definedNames?: unknown;
  sheetDims?: unknown;
  sheetStyles?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the client-supplied sheetStyles extra into per-sheet CellStyle
 * records (mirrors the gateway's sanitizeSheetStyles): anything malformed
 * is dropped entry by entry — a corrupt style hint must never fail the
 * save, and the serializer re-validates every field it consumes. Returns
 * null when the extra is absent or not an object at all.
 */
export function sanitizeDesktopSheetStyles(
  raw: unknown,
): Record<string, Record<string, CellStyle>> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, Record<string, CellStyle>> = {};
  for (const [sheet, perCell] of Object.entries(raw)) {
    if (!isRecord(perCell)) continue;
    const styles: Record<string, CellStyle> = {};
    for (const [key, style] of Object.entries(perCell)) {
      if (!/^\d+:\d+$/.test(key)) continue;
      if (!isRecord(style)) continue;
      styles[key] = style as CellStyle;
    }
    out[sheet] = styles;
  }
  return out;
}

/**
 * Build the per-sheet client-state metas in the gateway buildSaveHandoff
 * forwarding shape: ONLY what the client reported is forwarded
 * (clientStyles/clientDims flags + the reported records); the serializer
 * compares them against its own parse of the source (here: the retained
 * parsedSheets) and decides per sheet whether anything actually changed.
 */
export function buildDesktopSheetMetas(
  sheetNames: string[],
  extras: DesktopSaveExtras,
): LiveSaveSheetMeta[] {
  const clientDims = isRecord(extras.sheetDims)
    ? (extras.sheetDims as Record<string, Record<string, unknown>>)
    : {};
  const clientStyles = sanitizeDesktopSheetStyles(extras.sheetStyles);
  const sheets: LiveSaveSheetMeta[] = [];
  for (const name of sheetNames) {
    const meta: LiveSaveSheetMeta = { name, clientStyles: false, clientDims: false };
    if (clientStyles && Object.prototype.hasOwnProperty.call(clientStyles, name)) {
      meta.clientStyles = true;
      const styles = clientStyles[name] as Record<string, CellStyle>;
      if (Object.keys(styles).length > 0) meta.styles = styles;
    }
    const over = clientDims[name];
    if (over && typeof over === 'object') {
      meta.clientDims = true;
      const dims: NonNullable<LiveSaveSheetMeta['dims']> = {};
      if (over.colWidths && typeof over.colWidths === 'object') {
        dims.colWidths = over.colWidths as Record<string, number>;
      }
      if (over.rowHeights && typeof over.rowHeights === 'object') {
        dims.rowHeights = over.rowHeights as Record<string, number>;
      }
      if (Array.isArray(over.hiddenCols)) dims.hiddenCols = over.hiddenCols as number[];
      if (Array.isArray(over.hiddenRows)) dims.hiddenRows = over.hiddenRows as number[];
      meta.dims = dims;
    }
    sheets.push(meta);
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// Save pin + copy-on-write stash (Addendum 4): a save pins the live model
// at a revision and reads it back SHEET BY SHEET under the pin, yielding
// to the event loop between sheets so renderer IPC executes arriving
// DURING the read are served concurrently — the engine stashes their
// writes copy-on-write (bounded by the pin's stash cap) or rejects
// un-stashable/structural ops with SavePinOverflowError (the op is NOT
// applied; engine-ipc queues and retries it after the pin releases).
// Ops landing during the read therefore never interleave into the
// pinned state being serialized: they belong to the next revision (and,
// for checkpoints, the next batch).
//
// The pin API is worker E's engine addition (host.beginSavePin /
// bulkReadbackSheetPinned / releaseSavePin / savePinStashCells,
// SavePinOverflowError exported from '@icecream-sheets/engine'). It is
// FEATURE-DETECTED here: a host without the pin methods (engine build
// predating E's landing) falls back to the single bulkReadback() pass,
// and the same code uses the pin unchanged once the engine is rebuilt
// with the API present.
// ---------------------------------------------------------------------------

/** A save-pin handle (worker E's declared shape). */
export interface DesktopSavePin {
  id: string;
  rev: number;
}

/** The pin-capable host surface (worker E's declared signatures). */
export interface SavePinHost {
  beginSavePin(opts?: { stashCapCells?: number }): DesktopSavePin;
  bulkReadbackSheetPinned(
    pin: DesktopSavePin,
    sheet: string,
    auth?: unknown,
  ): Array<{ ref: CellRef; input: unknown; value: unknown }>;
  releaseSavePin(pin: DesktopSavePin): void;
  savePinStashCells?(pin: DesktopSavePin): number;
}

/**
 * The host's pin API when the engine build provides it, else null.
 * All three core methods must be present — a partial API is treated as
 * absent rather than half-used.
 */
export function savePinHostOf(host: EngineHost): SavePinHost | null {
  const candidate = host as unknown as Partial<SavePinHost>;
  if (
    typeof candidate.beginSavePin === 'function' &&
    typeof candidate.bulkReadbackSheetPinned === 'function' &&
    typeof candidate.releaseSavePin === 'function'
  ) {
    return candidate as SavePinHost;
  }
  return null;
}

/**
 * True when `error` is the engine's SavePinOverflowError (exported from
 * '@icecream-sheets/engine' by worker E): matched by error name /
 * constructor name so the check works before the class exists in the
 * engine build this code compiles against, and across any realm the
 * error crosses.
 */
export function isSavePinOverflowError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'SavePinOverflowError') return true;
  const ctorName = (error as { constructor?: { name?: unknown } }).constructor
    ?.name;
  return ctorName === 'SavePinOverflowError';
}

export interface PinnedBulkAssembly {
  bulk: LiveBulkCell[];
  /** True when the pinned sheet-by-sheet path ran (false = fallback). */
  pinUsed: boolean;
  /** The pinned revision, when a pin was used. */
  pinRev?: number;
  /** Cells the engine held in the pin's CoW stash at release, when reported. */
  stashCells?: number;
}

/**
 * Assemble the serializer's bulk readback. With a pin-capable host:
 * begin the pin, read each sheet under it in order, await a
 * setImmediate between sheets (so IPC executes from the renderer that
 * arrive during the read actually run — the entire point of the pin),
 * then release the pin IMMEDIATELY after assembly, before any
 * serialization work. The pin is released on read errors too. Without
 * the pin API: the pre-Addendum-4 single bulkReadback() pass.
 */
export async function assembleBulkReadbackPinned(
  host: EngineHost,
  sheetNames: string[],
  opts: {
    auth?: unknown;
    stashCapCells?: number;
    yieldBetweenSheets?: () => Promise<void>;
  } = {},
): Promise<PinnedBulkAssembly> {
  const pinHost = savePinHostOf(host);
  if (!pinHost) {
    return { bulk: host.bulkReadback() as LiveBulkCell[], pinUsed: false };
  }
  const pin = pinHost.beginSavePin(
    opts.stashCapCells !== undefined
      ? { stashCapCells: opts.stashCapCells }
      : undefined,
  );
  const doYield =
    opts.yieldBetweenSheets ??
    (() => new Promise<void>((resolve) => setImmediate(resolve)));
  try {
    const bulk: LiveBulkCell[] = [];
    for (let i = 0; i < sheetNames.length; i++) {
      const cells = pinHost.bulkReadbackSheetPinned(pin, sheetNames[i]!, opts.auth) as LiveBulkCell[];
      // Issue #49: append in a loop, NEVER spread — spreading one
      // sheet's readback as call arguments hits V8's argument-count
      // limit (~10⁵–10⁶) and throws "Maximum call stack size exceeded"
      // on every checkpoint of a large workbook (p95's first sheet
      // alone returns 720,016 cells), so the batch never flushed.
      for (let j = 0; j < cells.length; j++) bulk.push(cells[j]!);
      // Yield between sheets (never after the last): renderer IPC
      // executes queued behind this read get their turn while the pin
      // holds the serialized state stable.
      if (i < sheetNames.length - 1) await doYield();
    }
    const stashCells =
      typeof pinHost.savePinStashCells === 'function'
        ? pinHost.savePinStashCells(pin)
        : undefined;
    return { bulk, pinUsed: true, pinRev: pin.rev, stashCells };
  } finally {
    // Released right after assembly — success or read failure alike —
    // so queued executes (engine-ipc's overflow retry) proceed.
    pinHost.releaseSavePin(pin);
  }
}

// ---------------------------------------------------------------------------
// Serialize the live workbook
// ---------------------------------------------------------------------------

/**
 * Serialize the host's LIVE workbook to `outPath` through the shared
 * streaming serializer. The host is read directly (bulk readback in the
 * desktop's single-user owner context — the local user is the workbook
 * owner, so the default principal's view IS the owner view), never via a
 * renderer snapshot. The readback runs under a save pin when the engine
 * provides one (Addendum 4, see assembleBulkReadbackPinned).
 */
export async function serializeDesktopWorkbook(
  host: EngineHost,
  extras: DesktopSaveExtras | undefined,
  outPath: string,
  log: (m: string) => void = () => undefined,
): Promise<SerializeLiveWorkbookResult> {
  // Extras source (Addendum 6): an explicitly passed extras payload is
  // the freshest client state — fold it into the pending store and use
  // it. No payload (the scheduler path passes the pending store
  // itself) → serialize with the pending synced extras.
  if (extras !== undefined) setPendingSessionExtras(extras);
  const effectiveExtras = extras !== undefined ? extras : pendingExtras;
  extras = effectiveExtras;
  extrasVersionAtLastSerialize = extrasVersion;
  const base = getDesktopSaveBase();
  // Metadata merge (later wins): the loaded file's adapter metadata ←
  // the renderer's session extras (UI-only state the engine never held:
  // chart specs, pictures, page-setup dialog edits, …).
  const metadata: Record<string, unknown> = { ...base.metadata };
  if (isRecord(extras.extraMetadata)) {
    Object.assign(metadata, extras.extraMetadata);
  }
  // Defect E1: the host's LIVE defined names merged UNDER the client's
  // session extras (Name-Manager store definitions the engine never
  // held) — an extras list can add names, never zero the live table.
  const definedNames = mergeDefinedNames(
    host.getDefinedNames(),
    Array.isArray(extras.definedNames) ? (extras.definedNames as DefinedName[]) : undefined,
  );
  const sheetNames = host.sheetNames();
  const sheets = buildDesktopSheetMetas(sheetNames, extras);
  // Addendum 4: pinned sheet-by-sheet assembly (pin released before
  // serialization starts); falls back to one bulkReadback() pass when
  // the engine build has no pin API.
  const assembly = await assembleBulkReadbackPinned(host, sheetNames);
  const bulk = assembly.bulk;
  if (assembly.pinUsed) {
    log(
      `[direct-save] save pin rev ${assembly.pinRev ?? '?'}: assembled ${bulk.length} cell(s) sheet-by-sheet` +
        (assembly.stashCells !== undefined
          ? ` (CoW stash at release: ${assembly.stashCells} cell(s))`
          : ''),
    );
  }
  const mod = await loadSaveNode();
  if (typeof mod.serializeLiveWorkbook !== 'function') {
    throw new Error('direct save: @icecream-sheets/service/save-node has no serializeLiveWorkbook export');
  }
  return mod.serializeLiveWorkbook({
    bulk: bulk as SerializeLiveWorkbookInput['bulk'],
    sheetNames,
    definedNames,
    metadata,
    sourceBytes: base.sourceBytes,
    parsedSheets: base.parsedSheets,
    sheets,
    ops: getDesktopSaveOps(),
    outPath,
    log,
  });
}

// ---------------------------------------------------------------------------
// Excel save sequence: temp in destination dir → verify → atomic replace
// ---------------------------------------------------------------------------

/**
 * The temp path for a destination: a sibling IN THE DESTINATION'S
 * DIRECTORY (`.<name>.icecream-tmp-<pid>`), so the final rename is a
 * same-filesystem atomic replace — never a cross-device copy over the
 * original.
 */
export function tempPathForDestination(destPath: string): string {
  const resolved = path.resolve(destPath);
  return path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.icecream-tmp-${process.pid}`,
  );
}

/** Run a verifyXlsxPackage-shaped check, normalizing its result forms. */
function runVerifyResult(check: unknown, tempPath: string): void {
  if (check === false) {
    throw new Error(`direct save: package verification failed for ${tempPath}`);
  }
  if (isRecord(check) && check.ok === false) {
    throw new Error(
      `direct save: package verification failed for ${tempPath}: ${typeof check.error === 'string' ? check.error : 'unreadable package'}`,
    );
  }
}

/**
 * Default verification: the shared save-node verifyXlsxPackage export.
 * Fail closed — a temp package that cannot be verified NEVER replaces
 * the destination.
 */
async function verifyWithSaveNode(tempPath: string): Promise<void> {
  const mod = await loadSaveNode();
  if (typeof mod.verifyXlsxPackage !== 'function') {
    throw new Error('direct save: @icecream-sheets/service/save-node has no verifyXlsxPackage export');
  }
  runVerifyResult(mod.verifyXlsxPackage(tempPath), tempPath);
}

export interface AtomicSaveOptions {
  /**
   * Verification override (tests). Default: verifyXlsxPackage from the
   * shared save-node module. An override may return false / {ok:false}
   * or throw to fail the save.
   */
  verify?: (tempPath: string) => unknown;
}

/**
 * The Excel save sequence as one helper (user directive, 2026-10-21):
 * serialize to a temp file in the destination's directory, verify the
 * completed package, then atomically rename over the destination. On ANY
 * failure (serialize throw — including the shared serializer's
 * ICECREAM_SAVE_FAULT_INJECT=midwrite fault — or a verify failure) the
 * temp is deleted and the error propagates; a pre-existing destination
 * file remains byte-identical and the session stays usable.
 */
export async function saveToDestinationAtomically<R>(
  serializeFn: (tempPath: string) => Promise<R> | R,
  destPath: string,
  options: AtomicSaveOptions = {},
): Promise<R> {
  const dest = path.resolve(destPath);
  const tempPath = tempPathForDestination(dest);
  try {
    const result = await serializeFn(tempPath);
    if (options.verify) {
      runVerifyResult(await options.verify(tempPath), tempPath);
    } else {
      await verifyWithSaveNode(tempPath);
    }
    renameSync(tempPath, dest);
    return result;
  } catch (e) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Temp cleanup is best-effort; the save error itself propagates.
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Continuous batch checkpointing (Addendum 3 — AutoSave sync model,
// single author): journaled ops accumulate in batches; a settle timer
// (default 1500 ms, re-armed per op) or an op cap (default 200 pending
// ops) flushes the batch to the workbook's known destination through
// the SAME Addendum-1 sequence (temp-in-dir → verify → atomic rename).
// Revisions are journal positions: liveRevision = ops applied since
// load; storageRevision = the journal cut the last successful
// checkpoint/save covered. Ops landing during an in-flight checkpoint
// sit past its cut and form the next batch — never lost, never
// double-counted as stored. No known destination → no background
// writes at all (offline changes nothing: the destination is local).
// ---------------------------------------------------------------------------

/** Checkpoint scheduler defaults (Addendum 3). */
export const CHECKPOINT_SETTLE_MS = 1500;
export const CHECKPOINT_MAX_PENDING_OPS = 200;

/**
 * Resolve the checkpoint settle delay from the environment
 * (ICECREAM_AUTOSAVE_SETTLE_MS; default CHECKPOINT_SETTLE_MS).
 * Unset, non-numeric, or non-positive values fall back to the default —
 * a misconfigured env must never disable or hot-loop checkpointing.
 */
export function resolveAutosaveSettleMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env.ICECREAM_AUTOSAVE_SETTLE_MS;
  if (raw === undefined || raw.trim() === '') return CHECKPOINT_SETTLE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return CHECKPOINT_SETTLE_MS;
  return Math.floor(parsed);
}

export interface DesktopCheckpointConfig {
  /** The live main-process host (null until the shell wires it). */
  getHost: () => EngineHost | null;
  /** Settle debounce after the last journaled op (default 1500 ms). */
  settleMs?: number;
  /** Force a flush at this many pending ops (default 200). */
  maxPendingOps?: number;
  /** Serializer override (tests); default serializeDesktopWorkbook. */
  serializeFn?: (
    host: EngineHost,
    extras: DesktopSaveExtras,
    outPath: string,
  ) => Promise<SerializeLiveWorkbookResult>;
  /** Verify override (tests); default verifyXlsxPackage via save-node. */
  verifyFn?: (tempPath: string) => unknown;
  log?: (m: string) => void;
}

/** The engine:autosaveFlush response shape. */
export interface DesktopFlushResult {
  /** Journal cut covered by storage (the local file) after the flush. */
  storageRevision: number;
  /** Total journaled ops applied to the live model. */
  liveRevision: number;
  /** True when storage covers every live op (storageRevision === liveRevision). */
  caughtUp: boolean;
  /** Ops this flush wrote (0 when already caught up / no destination). */
  flushedOps: number;
}

let checkpointConfig: DesktopCheckpointConfig | null = null;
let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
let checkpointInFlight: Promise<DesktopFlushResult> | null = null;
/** The last confirmed destination path (the autosave target), or null. */
let autosaveTargetPath: string | null = null;
/** Journal cut covered by the last successful checkpoint/save. */
let storageRevision = 0;

// ---------------------------------------------------------------------------
// Session extras store + save-status counters (Addendum 6): the
// renderer's session extras (styles / dims / name extras / metadata)
// sync to main as they CHANGE (engine:sessionExtras), independently of
// any save. Main-side checkpoints serialize with these pending extras,
// so a checkpoint is never missing the latest client state. extrasDirty
// is set only when the payload actually changes (canonical comparison);
// a successful checkpoint/save that serialized the current extras
// version clears it. A flush check with storageRevision ===
// liveRevision && !extrasDirty is a STRICT NO-OP: zero writes, no temp
// file — counted in noopSkips. flushes counts real checkpoint writes.
// ---------------------------------------------------------------------------

/** The pending session extras main serializes with (freshest synced). */
let pendingExtras: DesktopSaveExtras = {};
/** Canonical form of the empty extras — so an empty payload is never a "change". */
let pendingExtrasCanonical = '{}';
let extrasVersion = 0;
let extrasDirty = false;
/**
 * #103 extras baselining: the canonical extras of the LOADED workbook
 * (or of the last successful serialize — the durable state). The first
 * sync after a load/new carries the loaded state, not a user change,
 * so it baselines instead of marking dirt; only a sync DIFFERING from
 * the baseline is dirt. Without this, every pristine quit fired the
 * guard: the first sync always differed from the '{}' initial and was
 * never consumed (no local destination, no serialize). Null = no
 * baseline yet (fresh load/new/reset — the next sync baselines).
 */
let extrasBaselineCanonical: string | null = null;
/**
 * #103 server-hosted workbook flag (renderer-reported via
 * engine:sessionExtras). Main's journal is not the durability
 * authority for server files — the server copy + the renderer's
 * durable collab queue own them — so the quit flush must never report
 * their extras as uncovered local work.
 */
let serverHostedWorkbook = false;

export function setServerHostedWorkbook(value: boolean): void {
  serverHostedWorkbook = value;
}

export function isServerHostedWorkbook(): boolean {
  return serverHostedWorkbook;
}
/** Extras version captured by the most recent serialize call. */
let extrasVersionAtLastSerialize: number | null = null;
/** Successful checkpoint writes performed by flushDesktopCheckpoint. */
let checkpointFlushes = 0;
/** Flush checks / manual saves that were strict no-ops (zero writes). */
let checkpointNoopSkips = 0;

/** Canonical (key-order-insensitive) serialization for extras comparison. */
function canonicalExtrasJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalExtrasJson(v)).join(',')}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalExtrasJson(rec[k])}`)
    .join(',')}}`;
}

/**
 * Store the renderer's latest session extras (engine:sessionExtras
 * sync, and the extras riding on save/flush calls). Marks extrasDirty
 * ONLY when the payload actually changed, and arms the settle timer so
 * main checkpoints the extras change on its own cadence — the sync is
 * state, never a save trigger in the renderer.
 */
export function setPendingSessionExtras(extras: DesktopSaveExtras): void {
  if (!extras || typeof extras !== 'object') return;
  const canonical = canonicalExtrasJson(extras);
  if (canonical === pendingExtrasCanonical) return;
  pendingExtras = extras;
  pendingExtrasCanonical = canonical;
  extrasVersion++;
  if (extrasBaselineCanonical === null) {
    // First sync after a load/new/reset: this IS the loaded state, not
    // a change — baseline it instead of marking dirt (#103).
    extrasBaselineCanonical = canonical;
    extrasDirty = false;
  } else {
    // Dirt = differs from the durable baseline (loaded state, or the
    // last successfully serialized state). Returning exactly to the
    // baseline (e.g. undone) is clean — there is nothing to lose.
    extrasDirty = canonical !== extrasBaselineCanonical;
  }
  if (checkpointConfig && autosaveTargetPath) armCheckpointTimer();
}

/** Compat alias: save/flush calls fold their extras into the same store. */
export function setLastSaveExtras(extras: DesktopSaveExtras): void {
  setPendingSessionExtras(extras);
}

/** The pending session extras (the scheduler's serialize source). */
export function getPendingSessionExtras(): DesktopSaveExtras {
  return pendingExtras;
}

/** True when synced extras changed since the last successful serialize. */
export function isSessionExtrasDirty(): boolean {
  return extrasDirty;
}

/** Monotonic extras version (increments only on an actual change). */
export function getSessionExtrasVersion(): number {
  return extrasVersion;
}

/**
 * Clear extrasDirty when a successful serialize consumed extras up to
 * `version` and no newer extras change has landed since. Used by the
 * checkpoint flush (its own cut version — valid for ANY serializeFn,
 * injected fakes included) and by the manual-save path via
 * consumeSerializedSessionExtras.
 */
export function consumeSessionExtrasUpTo(version: number): void {
  if (version === extrasVersion) {
    extrasDirty = false;
    // The consumed state is now durable — it becomes the baseline, so
    // a later return to exactly this state is clean, not dirt (#103).
    extrasBaselineCanonical = pendingExtrasCanonical;
  }
}

/**
 * Clear extrasDirty when the last serialize consumed the CURRENT
 * extras version (a successful checkpoint flush or manual save). An
 * extras change that landed during the serialize keeps the dirty flag.
 */
export function consumeSerializedSessionExtras(): void {
  if (extrasVersionAtLastSerialize !== null) {
    consumeSessionExtrasUpTo(extrasVersionAtLastSerialize);
  }
}

/** Count a strict no-op save check (zero writes; also the manual-save skip). */
export function noteCheckpointNoopSkip(): void {
  checkpointNoopSkips++;
}

/** The engine:saveStatus shape (Addendum 6): cheap, no side effects. */
export interface DesktopSaveStatus {
  liveRevision: number;
  storageRevision: number;
  extrasDirty: boolean;
  /** Successful checkpoint writes so far. */
  flushes: number;
  /** Strict no-op save checks so far (zero writes each). */
  noopSkips: number;
  targetPath: string | null;
  pendingOps: number;
}

export function getSaveStatus(): DesktopSaveStatus {
  return {
    liveRevision: saveOps.length,
    storageRevision,
    extrasDirty,
    flushes: checkpointFlushes,
    noopSkips: checkpointNoopSkips,
    targetPath: autosaveTargetPath,
    pendingOps: getPendingSaveOps(),
  };
}

/** Wire the scheduler (main.ts registerIpc; once). */
export function configureDesktopCheckpoints(config: DesktopCheckpointConfig): void {
  checkpointConfig = config;
}

/** The current autosave target (last confirmed destination), or null. */
export function getAutosaveTarget(): string | null {
  return autosaveTargetPath;
}

/**
 * Record a confirmed destination as the autosave target (called by the
 * save handlers in main.ts after a successful save, and by
 * noteDesktopLoadForAutosave for path opens). Pending ops arm the
 * settle timer: checkpointing starts as soon as a destination exists.
 */
export function recordAutosaveTarget(destPath: string): void {
  autosaveTargetPath = destPath;
  if (saveOps.length > storageRevision) onOpsJournaled();
}

/**
 * Learn the autosave target from an engine:load filename (called by
 * engine-ipc's load handler): desktop file opens carry the ABSOLUTE
 * path as the load filename (pickOpen / OS open), so the target follows
 * the opened file. A bare name (library entry, URL open) is not a local
 * destination — the target clears and background writes stop until the
 * user saves to a path.
 */
export function noteDesktopLoadForAutosave(filename: string): void {
  if (path.isAbsolute(filename)) {
    autosaveTargetPath = filename;
    // A local file just loaded: it is definitionally not server-hosted.
    serverHostedWorkbook = false;
  } else {
    autosaveTargetPath = null;
    // Bare name (library entry, URL open — incl. server-file opens):
    // the kind flag stays as last reported; the renderer's extras sync
    // (≤800 ms after load) sets it correctly. The extras baseline
    // resets either way (see below).
  }
  // #103: a new workbook replaced the old one — the old workbook's
  // extras dirt is moot (its fate was decided at open time by the
  // renderer's guards), and the next sync baselines the loaded state.
  extrasBaselineCanonical = null;
  extrasDirty = false;
}

/** Forget the autosave target (blank/new workbook contexts). */
export function clearAutosaveTarget(): void {
  autosaveTargetPath = null;
  // A blank workbook is local, never server-hosted; its extras baseline
  // resets like any other load (#103).
  serverHostedWorkbook = false;
  extrasBaselineCanonical = null;
  extrasDirty = false;
}

/** Live revision: total journaled ops applied since load. */
export function getLiveRevision(): number {
  return saveOps.length;
}

/** Storage revision: journal cut the last checkpoint/save covered. */
export function getStorageRevision(): number {
  return storageRevision;
}

/** Ops journaled but not yet covered by storage. */
export function getPendingSaveOps(): number {
  return Math.max(0, saveOps.length - storageRevision);
}

/**
 * Mark storage as covering the journal through `cut` (a successful
 * manual save serialized at least that cut of the live state).
 */
export function markStorageCovered(cut: number): void {
  storageRevision = Math.max(storageRevision, Math.min(cut, saveOps.length));
}

/**
 * Manual-save skip decision (Addendum 3): a Save whose destination IS
 * the recorded autosave target, with a suggested path (an in-place
 * save — a dialog Save As always re-serializes), nothing pending, and
 * storage already covering the live revision, is already durable: the
 * saveXlsxDirect handler skips re-serializing and reports
 * 'checkpoint-current'. The destination file must still exist (an
 * external delete defeats the skip — checked by the caller, passed in
 * as `destExists`).
 */
export function shouldSkipCheckpointCurrentSave(args: {
  suggestedPath?: string;
  destPath: string;
  destExists: boolean;
}): boolean {
  return (
    args.suggestedPath !== undefined &&
    args.destExists &&
    args.destPath === autosaveTargetPath &&
    autosaveTargetPath !== null &&
    getPendingSaveOps() === 0 &&
    storageRevision === saveOps.length &&
    // Addendum 6: unsynced extras changes mean the file is NOT current
    // even at equal revisions — the skip is a strict no-op only when
    // storage covers the live model AND the pending extras.
    !extrasDirty
  );
}

/** Scheduler status snapshot (flush responses, tests, diagnostics). */
export function getCheckpointStatus(): DesktopFlushResult & { targetPath: string | null; pendingOps: number } {
  return {
    storageRevision,
    liveRevision: saveOps.length,
    caughtUp: storageRevision === saveOps.length && !extrasDirty,
    flushedOps: 0,
    targetPath: autosaveTargetPath,
    pendingOps: getPendingSaveOps(),
  };
}

function checkpointLog(m: string): void {
  checkpointConfig?.log?.(m);
}

function armCheckpointTimer(): void {
  if (!checkpointConfig) return;
  if (checkpointTimer) clearTimeout(checkpointTimer);
  const settleMs = checkpointConfig.settleMs ?? CHECKPOINT_SETTLE_MS;
  checkpointTimer = setTimeout(() => {
    checkpointTimer = null;
    void flushDesktopCheckpoint('settle-timer');
  }, settleMs);
  checkpointTimer.unref?.();
}

/** Journal hook: (re)arm the settle timer; force a flush at the op cap. */
function onOpsJournaled(): void {
  if (!checkpointConfig || !autosaveTargetPath) return;
  const maxPending = checkpointConfig.maxPendingOps ?? CHECKPOINT_MAX_PENDING_OPS;
  if (getPendingSaveOps() >= maxPending) {
    void flushDesktopCheckpoint('op-cap');
  } else {
    armCheckpointTimer();
  }
}

/**
 * Run one checkpoint NOW (the autosaveFlush primitive; also the timer /
 * op-cap driver). Coalesces concurrent calls onto the in-flight
 * checkpoint. Never throws: a failed checkpoint logs, leaves the batch
 * pending, re-arms the settle timer, and reports caughtUp:false.
 * With no destination or nothing pending it performs NO serialization.
 */
export function flushDesktopCheckpoint(reason = 'flush'): Promise<DesktopFlushResult> {
  if (checkpointInFlight) return checkpointInFlight;
  if (serverHostedWorkbook) {
    // #103: main holds no unacked service ops for a server-hosted
    // workbook (close-flush module doc) — the server copy + the
    // renderer's durable collab queue own durability. There is nothing
    // for main to cover, so the flush is a noop by definition; reporting
    // 'failed' here is what armed the quit guard on every server-file
    // quit (0/0 with dirty extras and no local destination).
    return Promise.resolve({
      storageRevision,
      liveRevision: saveOps.length,
      caughtUp: true,
      flushedOps: 0,
    });
  }
  const done = (flushedOps: number): DesktopFlushResult => ({
    storageRevision,
    liveRevision: saveOps.length,
    caughtUp: storageRevision === saveOps.length && !extrasDirty,
    flushedOps,
  });
  // STRICT NO-OP (Addendum 6): storage already covers the live
  // revision AND the pending extras → zero writes, no temp file, no
  // serialization — just the counter.
  if (getPendingSaveOps() === 0 && !extrasDirty) {
    noteCheckpointNoopSkip();
    return Promise.resolve(done(0));
  }
  const target = autosaveTargetPath;
  const config = checkpointConfig;
  if (!config || !target) {
    return Promise.resolve(done(0));
  }
  const host = config.getHost();
  if (!host) return Promise.resolve(done(0));
  // The batch cut: ops journaled up to here are this checkpoint's;
  // anything landing during the flight is past the cut (next batch).
  const cut = saveOps.length;
  const coveredBefore = storageRevision;
  // The extras cut, same principle: a successful write consumes the
  // extras as of here; a change landing during the flight stays dirty.
  const extrasVersionAtCut = extrasVersion;
  const serialize = config.serializeFn ?? serializeDesktopWorkbook;
  checkpointInFlight = (async (): Promise<DesktopFlushResult> => {
    try {
      const result = await saveToDestinationAtomically(
        (tempPath) => serialize(host, getPendingSessionExtras(), tempPath),
        target,
        config.verifyFn ? { verify: config.verifyFn } : {},
      );
      checkpointFlushes++;
      markStorageCovered(cut);
      // The pending extras were this checkpoint's extras source: a
      // successful write consumes them (unless they changed mid-flight).
      consumeSessionExtrasUpTo(extrasVersionAtCut);
      // Batch materialization reporting (Addendum 5): the serializer's
      // mode is always logged; an adapter-fallback batch carries its
      // reason (sheet-set / calculation-mode structural ops), and a
      // row/col-structural batch is noted (the shared serializer
      // regenerates ALL sheets streaming for it, keeping 'verbatim').
      const note = checkpointBatchNote(saveOps.slice(coveredBefore, cut));
      const mode = result?.mode ?? 'unknown';
      let suffix = ` mode=${mode}`;
      if (mode === 'adapter-fallback') {
        suffix += ` fallbackReason=${note.fallbackReason ?? 'verbatim-planning'}`;
      }
      if (note.rowColStructural) suffix += ' rowColStructural=all-sheets-regen';
      checkpointLog(
        `[checkpoint] ${reason}: flushed ${cut - coveredBefore} op(s) to ${target} (storage ${storageRevision}/${saveOps.length})${suffix}`,
      );
      return done(cut - coveredBefore);
    } catch (e) {
      checkpointLog(
        `[checkpoint] ${reason}: FAILED (${e instanceof Error ? e.message : String(e)}) — batch stays pending`,
      );
      // Retry on the settle cadence, never in a hot loop.
      if (autosaveTargetPath && getPendingSaveOps() > 0) armCheckpointTimer();
      return done(0);
    } finally {
      checkpointInFlight = null;
      // Ops (or extras changes) that landed during the flight form the
      // next batch.
      if (
        autosaveTargetPath &&
        (getPendingSaveOps() > 0 || extrasDirty) &&
        !checkpointTimer
      ) {
        armCheckpointTimer();
      }
    }
  })();
  return checkpointInFlight;
}

/**
 * Structural-op barrier (Addendum 5): when a structural op arrives and
 * un-checkpointed ops are pending, the pending batch is checkpointed
 * BEFORE the structural op is applied — the structural op starts a
 * fresh batch, so no batch ever straddles a structural boundary (the
 * pre-structural state materializes as its own batch, from the live
 * model at its cut, via the save pin). Cell ops and name-family ops
 * never trigger the barrier (names ride workbook.xml in the same
 * batch). Returns true when a barrier flush was triggered. The barrier
 * never blocks the op: flushDesktopCheckpoint reports failure without
 * throwing, and the batch simply stays pending.
 */
export async function flushCheckpointBeforeStructuralOp(
  cmd: string,
): Promise<boolean> {
  if (!isStructuralBarrierOp(cmd)) return false;
  const pending = getPendingSaveOps();
  if (pending === 0) return false;
  checkpointLog(
    `[checkpoint] structural barrier: flushing ${pending} pending op(s) before ${cmd} — the structural op starts a fresh batch`,
  );
  const result = await flushDesktopCheckpoint('structural-barrier');
  if (result.flushedOps === 0 && getPendingSaveOps() > 0) {
    checkpointLog(
      `[checkpoint] structural barrier: batch could not materialize before ${cmd} (no destination or checkpoint failed) — op proceeds, batch stays pending`,
    );
  }
  return true;
}

/** Test hook: reset ALL checkpoint state (config, target, revisions, timer). */
export function resetDesktopCheckpointState(): void {
  if (checkpointTimer) {
    clearTimeout(checkpointTimer);
    checkpointTimer = null;
  }
  checkpointConfig = null;
  checkpointInFlight = null;
  autosaveTargetPath = null;
  storageRevision = 0;
  pendingExtras = {};
  pendingExtrasCanonical = '{}';
  extrasVersion = 0;
  extrasDirty = false;
  extrasBaselineCanonical = null;
  serverHostedWorkbook = false;
  extrasVersionAtLastSerialize = null;
  checkpointFlushes = 0;
  checkpointNoopSkips = 0;
}
