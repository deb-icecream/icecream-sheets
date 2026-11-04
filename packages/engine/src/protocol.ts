/**
 * Versioned engine protocol: commands, snapshots, subscriptions.
 * The grid UI, MCP server and automation lane are clients of this protocol;
 * nothing reaches past it into HyperFormula directly.
 */
import { Authorizer, type AuthContext } from './permissions.js';
import { parseA1CellRef, parseA1RangeRef } from './protection.js';
import {
  ENGINE_PROTOCOL_VERSION,
  err,
  toA1,
  type CellRef,
  type RangeRef,
  type TypedValue,
  type WorkbookSnapshot,
} from './types.js';

/**
 * Decides whether a cell is hidden from a principal (face e of the
 * protection model). The service boundary installs this from the
 * ProtectionManager (hidden ranges + exempt principals). Kept as a hook —
 * rather than a policy call — so the transitive formula-leak scan below
 * doesn't spam the audit log with one entry per precedent.
 */
export type HiddenCheck = (ref: CellRef, principal: string) => boolean;

/** Permission-denied value (face c/e): never a fake empty, never a leak. */
function permDenied(what: string) {
  return err('#PERM!', what);
}
import { isVolatileFormula } from './volatile.js';
import { TypedView } from './view.js';
import { EngineWorkbook, type CalculationMode, type CellInput } from './workbook.js';
import type { SupportedLocale } from './localization.js';
import type {
  ParallelRecalcOptions,
  ParallelRecalcStats,
  WorkerBackendFactory,
} from './parallel/index.js';
import type {
  CalcChainMeasurement,
  HybridRecalcConfig,
  MeasureCalcChainOptions,
  MirrorMode,
  RecalcRouteContext,
  RecalcRouteDecision,
} from './calc-chain.js';
import type { NameScope } from './names.js';
import type { DefineFunctionInput, NamedFunctionSignature, NamedFunctionLanguage } from './names-functions.js';

/**
 * Ambient auth context for name/function permission hooks. Command
 * execution and cell reads run inside withHostAuth(); the registries'
 * authorize hooks (which take no auth parameter) resolve the principal
 * from here. Synchronous only — never crosses an await.
 */
let activeHostAuth: AuthContext | undefined;

export function withHostAuth<T>(auth: AuthContext, fn: () => T): T {
  const prev = activeHostAuth;
  activeHostAuth = auth;
  try {
    return fn();
  } finally {
    activeHostAuth = prev;
  }
}

export type EngineCommand =
  | { cmd: 'setCell'; ref: CellRef; value: CellInput; auth?: AuthContext }
  | { cmd: 'setFormula'; ref: CellRef; formula: string; auth?: AuthContext }
  | { cmd: 'addSheet'; name: string; auth?: AuthContext }
  | { cmd: 'deleteSheet'; name: string; auth?: AuthContext }
  | { cmd: 'renameSheet'; name: string; newName: string; auth?: AuthContext }
  | { cmd: 'duplicateSheet'; name: string; newName?: string; auth?: AuthContext }
  | { cmd: 'moveSheet'; name: string; toIndex: number; auth?: AuthContext }
  | { cmd: 'setCalculationMode'; mode: CalculationMode; auth?: AuthContext }
  | { cmd: 'recalculate'; auth?: AuthContext }
  | { cmd: 'setParallelRecalcOptions'; options: ParallelRecalcOptions; auth?: AuthContext }
  | { cmd: 'recalculateParallel'; auth?: AuthContext }
  | { cmd: 'defineName'; name: string; refersTo: string; scope?: NameScope; auth?: AuthContext }
  | { cmd: 'deleteName'; id: string; auth?: AuthContext }
  | { cmd: 'renameName'; id: string; newName: string; auth?: AuthContext }
  | { cmd: 'updateNameRefersTo'; id: string; refersTo: string; auth?: AuthContext }
  | { cmd: 'defineFunction'; input: DefineFunctionInput; auth?: AuthContext }
  | { cmd: 'updateFunction'; id: string; patch: { source?: string; signature?: NamedFunctionSignature; language?: NamedFunctionLanguage }; auth?: AuthContext }
  | { cmd: 'rollbackFunction'; id: string; version: number; auth?: AuthContext }
  | { cmd: 'deleteFunction'; id: string; auth?: AuthContext }
  | { cmd: 'insertRows'; sheet: string; row: number; count?: number; auth?: AuthContext }
  | { cmd: 'deleteRows'; sheet: string; row: number; count?: number; auth?: AuthContext }
  | { cmd: 'insertCols'; sheet: string; col: number; count?: number; auth?: AuthContext }
  | { cmd: 'deleteCols'; sheet: string; col: number; count?: number; auth?: AuthContext };

export type CommandResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

export type AsyncCommandResult = CommandResult | { ok: true; stats: ParallelRecalcStats };

export type EngineEvent =
  | { type: 'cellsChanged'; refs: CellRef[] }
  | { type: 'recalcComplete' }
  | { type: 'sheetAdded'; name: string }
  | { type: 'sheetRemoved'; name: string };

export type EngineEventListener = (event: EngineEvent) => void;

/**
 * Main→renderer engine forwarding (desktop MCP parity, platform-shell.md §8).
 *
 * The desktop main process cannot run the user's workbook (it lives in the
 * renderer's EngineHost), so the desktop MCP ingress's EngineHost forwards
 * each protocol op to the renderer over IPC and awaits the reply. Every
 * payload and every result is structured-cloneable; AuthContext is
 * { principal, grants? } — no secrets cross this boundary.
 */
export type EngineForwardPayload =
  | { op: 'execute'; command: EngineCommand }
  | { op: 'executeAsync'; command: EngineCommand }
  | { op: 'readCell'; ref: CellRef; auth?: AuthContext }
  | { op: 'readRange'; range: RangeRef; auth?: AuthContext }
  | { op: 'readSheet'; sheet: string; auth?: AuthContext }
  | { op: 'snapshot' }
  | { op: 'usedRange'; sheet: string };

/**
 * Desktop engine/view separation (Cycle 10, platform-shell.md §1): the
 * renderer's workbook lives in the main-process engine host; opens travel
 * through the `engine:load` IPC channel. The contract below is what main
 * returns to the renderer after parsing (storage adapter) + building
 * (EngineWorkbook) — the cell grids themselves never cross IPC. Sheet
 * summaries carry the UI hints the renderer needs to hydrate its state
 * (formats, dimensions, per-column non-empty counts for dynamic chart
 * name resolution); `metadata` is the adapter's WorkbookData.metadata
 * verbatim so the renderer hydrates charts, pivots, protection flags,
 * pictures, page setup, SmartArt, etc. exactly as it did when parsing
 * locally. Everything here is structured-cloneable.
 */
export interface EngineLoadSheetSummary {
  name: string;
  /** Excel number format code per cell, keyed "row:col" (UI hint). */
  formats?: Record<string, string>;
  /** Full per-cell styles keyed "row:col" (UI hint; see SheetData.styles). */
  styles?: Record<string, import('./storage.js').CellStyle>;
  /** Column widths in px, keyed by 0-based index (UI hint). */
  colWidths?: Record<string, number>;
  /** Row heights in px, keyed by 0-based index (UI hint). */
  rowHeights?: Record<string, number>;
  /** Hidden columns / rows (0-based indices; UI hints). */
  hiddenCols?: number[];
  hiddenRows?: number[];
  /**
   * Non-empty cell count per column (index-aligned, up to the used range).
   * Feeds the renderer's chartNameCtx.countNonEmpty for dynamic
   * (OFFSET/COUNTA) chart series name resolution without pulling rows.
   */
  colNonEmpty?: number[];
}

export interface EngineLoadResult {
  sheets: EngineLoadSheetSummary[];
  metadata: Record<string, unknown>;
  definedNames?: import('./storage.js').DefinedName[];
}

const DEFAULT_AUTH: AuthContext = { principal: 'user' };

// ---------------------------------------------------------------------------
// Save pins (save-consistency fix): pin + copy-on-write stash
// ---------------------------------------------------------------------------

/**
 * A save pin: a handle to one pinned revision of the live workbook.
 * Created by EngineHost.beginSavePin(), consumed by
 * bulkReadbackSheetPinned(), discarded by releaseSavePin(). `rev` is
 * the host revision at pin time (see EngineHost.currentRevision()).
 */
export interface SavePin {
  id: string;
  rev: number;
}

/**
 * Thrown when an op cannot be applied while a save pin is active:
 * either stashing its pre-state would exceed the pin's stash cap, or
 * the op is structural / name-table / recalc-wide and the stash cannot
 * represent it. The op is NOT applied; callers queue it and retry
 * after releaseSavePin(). Deliberately NOT folded into CommandResult:
 * a serializer-consistency failure must never look like an ordinary
 * command denial.
 */
export class SavePinOverflowError extends Error {
  constructor(message = 'save pin overflow') {
    super(message);
    this.name = 'SavePinOverflowError';
    Object.setPrototypeOf(this, SavePinOverflowError.prototype);
  }
}

/** Default per-pin stash cap, in cells (beginSavePin opts override). */
export const DEFAULT_SAVE_PIN_STASH_CAP_CELLS = 100_000;

/**
 * The mutating-command set for host revision accounting: identical to
 * DIRECT_SAVE_MUTATING_OPS in @icecream-sheets/service/save-node (the
 * save journal's op set). The engine package cannot import the service
 * package (dependency direction), so the list is mirrored here and
 * pinned by the savePin tests.
 */
const SAVE_PIN_MUTATING_OPS: ReadonlySet<string> = new Set([
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

/** One stashed cell: its pin-time state, or ABSENT (did not exist at pin / pre-op). */
type SavePinStashEntry =
  | { absent: true; ref: CellRef }
  | { absent: false; ref: CellRef; input: CellInput; value: TypedValue };

interface SavePinState {
  pin: SavePin;
  stashCapCells: number;
  /** Key: `${sheet}\0${row}\0${col}`. First write wins: never overwritten. */
  stash: Map<string, SavePinStashEntry>;
}

function savePinKey(ref: CellRef): string {
  return `${ref.sheet}\0${ref.row}\0${ref.col}`;
}

/** Options for EngineHost construction. */
export interface EngineHostOptions {
  /**
   * Defer constructing the workbook until first use (issue #58): for
   * hosts whose every public method is overridden by an adapter (the
   * desktop renderer's IpcEngineHost), the default workbook would be
   * an empty, never-used engine kept alive for the app's lifetime.
   * With this flag set — and no workbook passed — the workbook (and
   * its TypedView) materialize lazily on first access instead. Hosts
   * that never set it behave exactly as before.
   */
  deferWorkbook?: boolean;
}

export class EngineHost {
  readonly protocolVersion = ENGINE_PROTOCOL_VERSION;
  private _workbook: EngineWorkbook | null = null;
  private _view: TypedView | null = null;

  /** The live workbook; materializes on first access when deferred. */
  private get workbook(): EngineWorkbook {
    if (this._workbook === null) this.installWorkbook(new EngineWorkbook());
    return this._workbook!;
  }

  private set workbook(wb: EngineWorkbook) {
    this.installWorkbook(wb);
  }

  /** The typed view over the live workbook (lazy with the workbook). */
  private get view(): TypedView {
    if (this._view === null) this._view = new TypedView(this.workbook);
    return this._view!;
  }

  private set view(v: TypedView) {
    this._view = v;
  }

  /**
   * Install a workbook as the host's live model: rebuilds the typed
   * view, re-wires the name/function authorize hook (design §4: the
   * registries' hooks resolve the principal from the ambient host
   * auth) and the value-change subscription.
   */
  private installWorkbook(workbook: EngineWorkbook): void {
    if (this.unsubscribeValues) this.unsubscribeValues();
    this._workbook = workbook;
    this._view = new TypedView(workbook);
    workbook.setNameAuthorizeHook((action, target) =>
      this.authorizer.authorize(action, target, activeHostAuth ?? DEFAULT_AUTH),
    );
    this.unsubscribeValues = workbook.onValuesChanged((refs) => {
      this.emit({ type: 'cellsChanged', refs });
    });
  }
  private authorizer: Authorizer;
  private hiddenCheck: HiddenCheck | undefined;
  /**
   * Memoized hidden-taint results, keyed `${principal} ${sheet}!${row},${col}`:
   * whether the cell's transitive precedent closure contains a cell hidden
   * from that principal. Taint depends only on the dependency graph and the
   * hidden set, both of which change only through execute()/replaceWorkbook()/
   * setHiddenCheck() — all of which clear this memo. Without it, every
   * formula-cell read re-walked the cell's whole precedent closure, so a
   * running-balance chain sheet made bulk reads O(cells × chain depth) and
   * wedged the engine service for minutes (Cycle 10 defect D3).
   */
  private hiddenTaintMemo = new Map<string, boolean>();
  /**
   * Hard bound on the taint memo (Cycle 10 closure W16): the memo is a
   * pure cache (a miss recomputes the same answer), so above this many
   * entries it is cleared rather than grown — an exhaustive read pass
   * over a P99-class workbook otherwise retains one string-keyed entry
   * per formula cell (~1.7 M entries ≈ 0.2 GB) for the workbook's life.
   * 500k entries still covers the D3 regression shape (a 150k-deep
   * chain's closure fits whole, so chain-sheet bulk reads keep their
   * O(V + E) behavior; the clear only costs re-walks on truly
   * workbook-scale read passes).
   */
  private static readonly TAINT_MEMO_LIMIT = 500_000;
  private listeners = new Set<EngineEventListener>();
  private unsubscribeValues: (() => void) | null = null;
  /**
   * Host revision: incremented once per ACCEPTED mutating execute()
   * (command in SAVE_PIN_MUTATING_OPS whose result is ok). The workbook
   * itself maintains no revision counter (checked: EngineWorkbook has
   * only the calc-chain graphVersion, which bumps on graph shape, not
   * per op), so the counter lives here at the protocol boundary — the
   * same place the gateway's session revision lives conceptually.
   * SavePin.rev snapshots it.
   */
  private revision = 0;
  /** Active save pins by pin id; each pin owns an independent stash. */
  private savePins = new Map<string, SavePinState>();
  private savePinSeq = 0;
  /** Unsubscribe for the workbook before-cell-write observer (CoW safety net). */
  private unsubscribePinObserver: (() => void) | null = null;

  constructor(workbook?: EngineWorkbook, authorizer?: Authorizer, opts?: EngineHostOptions) {
    this.authorizer = authorizer ?? new Authorizer();
    // An explicitly passed workbook always installs immediately; the
    // deferred default workbook materializes on first access instead
    // (see EngineHostOptions.deferWorkbook).
    if (workbook !== undefined || !opts?.deferWorkbook) {
      this.workbook = workbook ?? new EngineWorkbook();
    }
  }

  getView(): TypedView {
    return this.view;
  }

  // -- Hybrid recalc routing (Cycle 10 Phase 3 integration) ---------------
  // Thin delegations to the workbook so HOSTS (web local mirror, gateway
  // engine service, desktop main-process host) can route an edit through
  // the one pure policy (calc-chain.ts routeRecalc) without reaching past
  // the protocol into EngineWorkbook/HyperFormula. See
  // HYBRID-CONSISTENCY.md for the contract hosts must honor.

  /** Total used-range cell count — the MT auto-flag / mirror metric. */
  totalCellCount(): number {
    return this.workbook.totalCellCount();
  }

  /** 'mirror' when this workbook is at/below the size flag, else 'no-mirror'. */
  mirrorMode(): MirrorMode {
    return this.workbook.mirrorMode();
  }

  /** Normalized hybrid thresholds (tiny / chain length / MT cell count). */
  hybridRecalcConfig(): HybridRecalcConfig {
    return this.workbook.hybridRecalcConfig();
  }

  /** Measure one edit's affected set (shape + single-chain length). */
  measureCalcChain(ref: CellRef, opts: MeasureCalcChainOptions = {}): CalcChainMeasurement {
    return this.workbook.measureCalcChain(ref, opts);
  }

  /**
   * Cells whose computed value is volatile-tainted (volatile formula,
   * volatile defined-name reference, or a transitive dependent of
   * one) — see EngineWorkbook.getVolatileValueCells (issue #67). The
   * gateway's checkpoint/rehydrate checksum covers these by input.
   */
  getVolatileValueCells(): CellRef[] {
    return this.workbook.getVolatileValueCells();
  }

  /** Measurement-cache diagnostics (graph version, hits/misses). */
  calcChainCacheStats(): { graphVersion: number; entries: number; hits: number; misses: number } {
    return this.workbook.calcChainCacheStats();
  }

  /**
   * Route one edit: measure (O(threshold)) + apply the FINAL routing rule.
   * Mirror mode is derived from THIS workbook's size flag. Hosts that hold
   * a mirror of a DIFFERENT (server) workbook must derive the mirror mode
   * from the server workbook's cell count instead — see routedEdit.ts in
   * the web app, which never calls this on a no-mirror workbook.
   */
  routeEditRecalc(
    ref: CellRef,
    opts: { mtEnabled?: boolean; context?: RecalcRouteContext } = {},
  ): RecalcRouteDecision {
    return this.workbook.routeEditRecalc(ref, opts);
  }

  /**
   * Sheet names without serializing the workbook. Perf (2026-10-19): App
   * called host.snapshot().sheets.map(s => s.name) on EVERY render —
   * toSnapshot() unparses every formula cell (1.8M getSerialized calls for
   * P95, ~1.5s per render). This is O(sheets).
   */
  sheetNames(): string[] {
    return this.workbook.sheetNames();
  }

  /**
   * The workbook's live defined names (save semantics) without
   * serializing the workbook — the same trap as sheetNames():
   * snapshot() unparses every formula cell just to read the names
   * table. O(names).
   */
  getDefinedNames(): import('./storage.js').DefinedName[] {
    return this.workbook.getLiveDefinedNames();
  }

  getAuthorizer(): Authorizer {
    return this.authorizer;
  }

  /**
   * Swap the workbook (sheet reorder rebuild). Re-wires the typed view, the
   * name/function authorize hook and the value-change subscription so the
   * host keeps working with the new instance.
   */
  replaceWorkbook(workbook: EngineWorkbook): void {
    if (this.savePins.size > 0) {
      // A swap would orphan every stash (they describe the OLD model's
      // cells): refuse rather than serve torn pinned reads. Callers
      // release their pins first.
      throw new SavePinOverflowError(
        'replaceWorkbook while a save pin is active: release all save pins first',
      );
    }
    this.hiddenTaintMemo.clear();
    // installWorkbook (via the setter) rebuilds the view and re-wires
    // the authorize hook + value-change subscription.
    this.workbook = workbook;
    this.emit({ type: 'recalcComplete' });
  }

  /**
   * Switch the workbook's formula language (track 22). Existing formulas
   * re-render in the new locale; new formulas are parsed in it. Emits
   * recalcComplete so hosts refresh their views.
   */
  setFormulaLanguage(locale: SupportedLocale): void {
    this.workbook.setFormulaLanguage(locale);
    this.emit({ type: 'recalcComplete' });
  }

  getFormulaLanguage(): SupportedLocale {
    return this.workbook.getFormulaLanguage();
  }

  // -- save pins (pin + copy-on-write stash) -------------------------------
  //
  // A serializer (direct-streaming save) pins the CURRENT revision, then
  // reads every sheet through bulkReadbackSheetPinned() while edits keep
  // applying to the ONE live model. Consistency mechanism: copy-on-write.
  // While >= 1 pin is active, every mutating execute() first stashes the
  // pre-op state of its full changed set (edited cell(s) + all transitive
  // recalculated dependents) into EACH active pin's stash; a pinned read
  // substitutes stashed state over the live bulk, so it observes exactly
  // the pin-time state no matter what landed since. See beginSavePin().

  /** The host revision: number of accepted mutating ops so far. */
  currentRevision(): number {
    return this.revision;
  }

  /**
   * Register a save pin at the workbook's current revision.
   *
   * `stashCapCells` (default 100_000) bounds each pin's stash: an op
   * whose pre-state stash would exceed the cap of ANY active pin is not
   * applied and execute() throws SavePinOverflowError (callers queue
   * and retry after release). Multiple concurrent pins are independent:
   * each carries its own stash and its own cap.
   */
  beginSavePin(opts: { stashCapCells?: number } = {}): SavePin {
    const raw = opts.stashCapCells;
    const stashCapCells =
      typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
        ? Math.floor(raw)
        : DEFAULT_SAVE_PIN_STASH_CAP_CELLS;
    const pin: SavePin = { id: `save-pin-${++this.savePinSeq}`, rev: this.revision };
    this.savePins.set(pin.id, { pin, stashCapCells, stash: new Map() });
    if (this.savePins.size === 1) {
      // Safety net (see stashPinObserverRef): the workbook's lowest
      // cell-write funnels report every write before it lands.
      this.unsubscribePinObserver = this.workbook.onBeforeCellWrite((ref) =>
        this.stashPinObserverRef(ref),
      );
    }
    return pin;
  }

  /**
   * Discard a pin's stash. Idempotent: releasing an unknown or already
   * released pin is a no-op. After release, ordinary reads are live
   * (they always were — the stash only ever fed pinned reads), and
   * bulkReadbackSheetPinned() for the released pin throws (fail closed:
   * a serializer must not silently receive live, possibly torn, state
   * in place of the pinned revision it asked for).
   */
  releaseSavePin(pin: SavePin): void {
    const state = this.savePins.get(pin.id);
    if (!state || state.pin.rev !== pin.rev) return;
    this.savePins.delete(pin.id);
    if (this.savePins.size === 0 && this.unsubscribePinObserver) {
      this.unsubscribePinObserver();
      this.unsubscribePinObserver = null;
    }
  }

  /**
   * Current stash size of a pin, in cells (logs/tests). Contract for a
   * released or unknown pin: 0 (the stash is gone).
   */
  savePinStashCells(pin: SavePin): number {
    const state = this.savePins.get(pin.id);
    if (!state || state.pin.rev !== pin.rev) return 0;
    return state.stash.size;
  }

  private requireSavePin(pin: SavePin): SavePinState {
    const state = this.savePins.get(pin.id);
    if (!state || state.pin.rev !== pin.rev) {
      throw new Error(`Unknown or released save pin: ${pin.id}`);
    }
    return state;
  }

  /** Capture one cell's pin-time state (input + value, or ABSENT). */
  private captureSavePinEntry(ref: CellRef): SavePinStashEntry {
    const s = this.workbook.getPinnedCellState(ref);
    return s === undefined
      ? { absent: true, ref: { ...ref } }
      : { absent: false, ref: { ...ref }, input: s.input, value: s.value };
  }

  /**
   * Stash `refs` (pre-op state) into every active pin, atomically: the
   * cap of EVERY pin is pre-checked before anything is stashed or
   * applied, so an overflow leaves both the workbook and all stashes
   * untouched and the op unapplied.
   */
  private stashForActivePins(refs: CellRef[]): void {
    if (this.savePins.size === 0 || refs.length === 0) return;
    const fresh = new Map<string, CellRef>();
    for (const ref of refs) {
      const k = savePinKey(ref);
      if (!fresh.has(k)) fresh.set(k, ref);
    }
    for (const state of this.savePins.values()) {
      let add = 0;
      for (const k of fresh.keys()) if (!state.stash.has(k)) add++;
      if (state.stash.size + add > state.stashCapCells) {
        throw new SavePinOverflowError(
          `save pin ${state.pin.id} stash cap exceeded: ${state.stash.size} + ${add} > ${state.stashCapCells} cells`,
        );
      }
    }
    for (const [k, ref] of fresh) {
      let entry: SavePinStashEntry | undefined;
      for (const state of this.savePins.values()) {
        if (state.stash.has(k)) continue;
        entry ??= this.captureSavePinEntry(ref);
        state.stash.set(k, entry);
      }
    }
  }

  /**
   * Safety net behind the write funnels (EngineWorkbook.onBeforeCellWrite,
   * installed while >= 1 pin is active): ANY cell write — including direct
   * EngineWorkbook writes that bypass EngineHost.execute() — stashes the
   * write's full pre-write changed set (same enumeration as the execute
   * gate) before the write lands. For execute() ops the gate already
   * stashed that set, so this is a no-op; for direct workbook writes it
   * is the only stash, and it is what keeps even those writes from
   * tearing a pinned read. A cap overflow here throws
   * SavePinOverflowError out of the write, before that write lands.
   */
  private stashPinObserverRef(ref: CellRef): void {
    if (this.savePins.size === 0) return;
    this.stashForActivePins(this.savePinChangedSet(ref));
  }

  /**
   * The full changed set of a cell edit, computed BEFORE the op applies:
   * the edited cell plus every transitive dependent the recalc will
   * touch — the UNcapped measureCalcChain walk over the same dependency
   * graph recalc performs (range vertices followed transparently,
   * named-expression vertices traversed to their downstream cells).
   *
   * Two graph-blind spots are covered by extra suspects, stashed
   * unconditionally (stashing an unchanged cell is harmless — its
   * pin-time state IS its pre-op state):
   *  - volatile / dynamic-reference formulas (INDIRECT, OFFSET, RAND,
   *    NOW, ... — see isVolatileFormula): HyperFormula does not track
   *    INDIRECT/OFFSET precedents, and volatile cells may recalculate
   *    on any cycle, so no graph walk can enumerate them exactly.
   *  - everything else that could slip enumeration is caught at write
   *    time by the onBeforeCellWrite safety net (edited-cell funnel).
   */
  private savePinChangedSet(ref: CellRef): CellRef[] {
    const byKey = new Map<string, CellRef>();
    const add = (r: CellRef): void => {
      const k = savePinKey(r);
      if (!byKey.has(k)) byKey.set(k, r);
    };
    add(ref);
    try {
      for (const dep of this.workbook.measureCalcChain(ref).cells) add(dep);
    } catch {
      // Measurement failure (e.g. unknown sheet): the op itself will
      // fail in executeInner; the edited cell is stashed regardless.
    }
    try {
      for (const { ref: tref, input } of this.workbook.getTrackedCells()) {
        if (
          typeof input === 'string' &&
          input.length > 1 &&
          input.startsWith('=') &&
          isVolatileFormula(input)
        ) {
          add(tref);
        }
      }
    } catch {
      // Suspect scan is best-effort; the graph set above is authoritative.
    }
    return [...byKey.values()];
  }

  /**
   * The pin gate, run by execute()/executeAsync() BEFORE the op (and
   * outside executeInner's error folding, so SavePinOverflowError
   * propagates as a throw, never as { ok: false }):
   *  - setCell / setFormula: stash the full changed set (above), then
   *    the op proceeds. The stash runs before authorization too: a
   *    policy-denied op changes nothing, and its stash entries simply
   *    record pin-time state early — still correct for pinned reads.
   *  - every other mutating op in SAVE_PIN_MUTATING_OPS (structural:
   *    addSheet/deleteSheet/renameSheet/duplicateSheet/moveSheet,
   *    insertRows/deleteRows/insertCols/deleteCols; name/function
   *    table: defineName/deleteName/renameName/updateNameRefersTo,
   *    defineFunction/updateFunction/rollbackFunction/deleteFunction;
   *    setCalculationMode): throws SavePinOverflowError while any pin
   *    is active. The stash is keyed by (sheet,row,col) and cannot
   *    represent sheet/row/column topology changes; for the
   *    defined-names table the safer choice was taken too — name ops
   *    throw rather than also stashing the names table, because a
   *    name change can rebind ANY formula's value, a changed set no
   *    cell enumeration can bound. Serializers pin only across cell
   *    edits; structural/name ops queue behind the save.
   *  - recalculate / recalculateParallel: also throw while pinned (a
   *    bare recalc can move volatile/manual-mode values with no edited
   *    cell to enumerate from).
   *  - setParallelRecalcOptions: no workbook state changes; allowed.
   */
  private savePinGate(command: EngineCommand): void {
    if (this.savePins.size === 0) return;
    switch (command.cmd) {
      case 'setCell':
      case 'setFormula':
        this.stashForActivePins(this.savePinChangedSet(command.ref));
        return;
      case 'setParallelRecalcOptions':
        return;
      default:
        throw new SavePinOverflowError(
          `command ${command.cmd} cannot run while a save pin is active (pin rev ${[...this.savePins.values()].map((s) => s.pin.rev).join(',')}); release the pin and retry`,
        );
    }
  }

  /**
   * Cell refs covering the region a structural op shifted (D-NEW-1).
   * A row op moves every row at/after `at` down (insert) or up (delete);
   * a col op moves every column at/after `at` right/left. Both the pre-op
   * and post-op used ranges contribute: insert's post-op range covers the
   * widened region, delete's pre-op range additionally covers the removed
   * cells (their cache entries go stale and must be invalidated by
   * ref-scoped consumers such as the desktop IPC view). Consumers dedupe
   * overlapping refs themselves (the App subscriber only ticks).
   */
  private structuralShiftRefs(
    sheet: string,
    rowOp: boolean,
    at: number,
    usedBefore: RangeRef | null,
    usedAfter: RangeRef | null,
  ): CellRef[] {
    const refs: CellRef[] = [];
    for (const used of [usedBefore, usedAfter]) {
      if (!used) continue;
      const r0 = rowOp ? at : used.startRow;
      const c0 = rowOp ? used.startCol : at;
      for (let r = r0; r <= used.endRow; r++) {
        for (let c = c0; c <= used.endCol; c++) {
          refs.push({ sheet, row: r, col: c });
        }
      }
    }
    return refs;
  }

  /** Execute one protocol command. Mutations go through authorize(). */
  execute(command: EngineCommand): CommandResult {
    // Any command may change the dependency graph or the hidden set (cell
    // writes, structural edits, protection changes), so cached hidden-taint
    // results are invalidated wholesale. Clearing is O(1); reads rebuild.
    this.hiddenTaintMemo.clear();
    // Save-pin gate: stash-before-apply / overflow throw, BEFORE the op
    // (and before authorization — see savePinGate). SavePinOverflowError
    // propagates to the caller as a throw by design.
    this.savePinGate(command);
    const auth = command.auth ?? DEFAULT_AUTH;
    const result = withHostAuth(auth, () => this.executeInner(command, auth));
    if (result.ok && SAVE_PIN_MUTATING_OPS.has(command.cmd)) this.revision++;
    return result;
  }

  private executeInner(command: EngineCommand, auth: AuthContext): CommandResult {
    try {
      switch (command.cmd) {
        case 'setCell': {
          const target = `${command.ref.sheet}!${command.ref.col},${command.ref.row}`;
          if (!this.authorizer.authorize('cell.write', target, auth)) {
            return { ok: false, error: `Denied by policy: cell.write ${target}` };
          }
          this.workbook.setCell(command.ref, command.value);
          return { ok: true };
        }
        case 'setFormula': {
          const target = `${command.ref.sheet}!${command.ref.col},${command.ref.row}`;
          if (!this.authorizer.authorize('cell.write', target, auth)) {
            return { ok: false, error: `Denied by policy: cell.write ${target}` };
          }
          this.workbook.setFormula(command.ref, command.formula);
          return { ok: true };
        }
        case 'addSheet': {
          if (!this.authorizer.authorize('sheet.add', command.name, auth)) {
            return { ok: false, error: `Denied by policy: sheet.add ${command.name}` };
          }
          this.workbook.addSheet(command.name);
          this.emit({ type: 'sheetAdded', name: command.name });
          return { ok: true };
        }
        case 'deleteSheet': {
          if (!this.authorizer.authorize('sheet.delete', command.name, auth)) {
            return { ok: false, error: `Denied by policy: sheet.delete ${command.name}` };
          }
          this.workbook.deleteSheet(command.name);
          this.emit({ type: 'sheetRemoved', name: command.name });
          return { ok: true };
        }
        case 'renameSheet': {
          if (!this.authorizer.authorize('sheet.rename', command.name, auth)) {
            return { ok: false, error: `Denied by policy: sheet.rename ${command.name}` };
          }
          this.workbook.renameSheet(command.name, command.newName);
          return { ok: true };
        }
        case 'duplicateSheet': {
          if (!this.authorizer.authorize('sheet.duplicate', command.name, auth)) {
            return { ok: false, error: `Denied by policy: sheet.duplicate ${command.name}` };
          }
          const newName = this.workbook.duplicateSheet(command.name, command.newName);
          this.emit({ type: 'sheetAdded', name: newName });
          return { ok: true, data: { name: newName } };
        }
        case 'moveSheet': {
          if (!this.authorizer.authorize('sheet.move', command.name, auth)) {
            return { ok: false, error: `Denied by policy: sheet.move ${command.name}` };
          }
          // HyperFormula has no sheet-reorder primitive: rebuild the workbook
          // with the new tab order (formulas re-resolve by sheet name, so
          // cross-sheet references survive).
          const names = this.workbook.sheetNames();
          const from = names.indexOf(command.name);
          if (from < 0) return { ok: false, error: `Unknown sheet: ${command.name}` };
          const to = Math.max(0, Math.min(command.toIndex, names.length - 1));
          const order = [...names];
          const [moved] = order.splice(from, 1);
          order.splice(to, 0, moved);
          this.replaceWorkbook(this.workbook.withSheetOrder(order));
          return { ok: true, data: { order } };
        }
        case 'setCalculationMode': {
          if (!this.authorizer.authorize('calc.setMode', command.mode, auth)) {
            return { ok: false, error: 'Denied by policy: calc.setMode' };
          }
          this.workbook.setCalculationMode(command.mode);
          return { ok: true };
        }
        case 'recalculate': {
          this.workbook.recalculate();
          this.emit({ type: 'recalcComplete' });
          return { ok: true };
        }
        case 'setParallelRecalcOptions': {
          if (!this.authorizer.authorize('calc.setMode', 'parallel', auth)) {
            return { ok: false, error: 'Denied by policy: calc.setMode' };
          }
          this.workbook.setParallelRecalcOptions(command.options);
          return { ok: true };
        }
        case 'recalculateParallel': {
          // Sync callers use executeAsync; the sync path runs the serial
          // recalculate to preserve execute()'s synchronous contract.
          this.workbook.recalculate();
          this.emit({ type: 'recalcComplete' });
          return { ok: true };
        }
        case 'defineName': {
          if (!this.authorizer.authorize('name.define', `name:${command.name}`, auth)) {
            return { ok: false, error: `Denied by policy: name.define name:${command.name}` };
          }
          const def = this.workbook.defineNamedRange(command.name, command.refersTo, command.scope ?? 'workbook');
          return { ok: true, data: def };
        }
        case 'deleteName': {
          if (!this.authorizer.authorize('name.delete', `name:${command.id}`, auth)) {
            return { ok: false, error: `Denied by policy: name.delete name:${command.id}` };
          }
          this.workbook.deleteNamedRange(command.id);
          return { ok: true };
        }
        case 'renameName': {
          if (!this.authorizer.authorize('name.define', `name:${command.id}`, auth)) {
            return { ok: false, error: `Denied by policy: name.define name:${command.id}` };
          }
          const def = this.workbook.renameNamedRange(command.id, command.newName);
          return { ok: true, data: def };
        }
        case 'updateNameRefersTo': {
          if (!this.authorizer.authorize('name.define', `name:${command.id}`, auth)) {
            return { ok: false, error: `Denied by policy: name.define name:${command.id}` };
          }
          const def = this.workbook.updateNamedRangeRefersTo(command.id, command.refersTo);
          return { ok: true, data: def };
        }
        case 'defineFunction': {
          if (!this.authorizer.authorize('function.manage', `function:${command.input.name}`, auth)) {
            return { ok: false, error: `Denied by policy: function.manage function:${command.input.name}` };
          }
          const def = this.workbook.defineNamedFunctionDef(command.input);
          return { ok: true, data: def };
        }
        case 'updateFunction': {
          if (!this.authorizer.authorize('function.manage', `function:${command.id}`, auth)) {
            return { ok: false, error: `Denied by policy: function.manage function:${command.id}` };
          }
          const def = this.workbook.updateNamedFunctionDef(command.id, command.patch);
          return { ok: true, data: def };
        }
        case 'rollbackFunction': {
          if (!this.authorizer.authorize('function.manage', `function:${command.id}`, auth)) {
            return { ok: false, error: `Denied by policy: function.manage function:${command.id}` };
          }
          const def = this.workbook.rollbackNamedFunctionDef(command.id, command.version);
          return { ok: true, data: def };
        }
        case 'deleteFunction': {
          if (!this.authorizer.authorize('function.manage', `function:${command.id}`, auth)) {
            return { ok: false, error: `Denied by policy: function.manage function:${command.id}` };
          }
          this.workbook.deleteNamedFunctionDef(command.id);
          return { ok: true };
        }
        case 'insertRows':
        case 'deleteRows':
        case 'insertCols':
        case 'deleteCols': {
          // Structural edits (§1): names track cell identity through these.
          if (!this.authorizer.authorize('sheet.structure', command.sheet, auth)) {
            return { ok: false, error: `Denied by policy: sheet.structure ${command.sheet}` };
          }
          const count = command.count ?? 1;
          // D-NEW-1: row/column insert/delete shift cells but never fired the
          // workbook's onValuesChanged, so local/in-process subscribers saw
          // no event and the grid stayed stale until the next edit. Capture
          // the used range around the op so cellsChanged covers the shifted
          // region afterwards (the emit below).
          const usedBefore = this.getUsedRange(command.sheet);
          if (command.cmd === 'insertRows') this.workbook.insertRows(command.sheet, command.row, count);
          else if (command.cmd === 'deleteRows') this.workbook.deleteRows(command.sheet, command.row, count);
          else if (command.cmd === 'insertCols') this.workbook.insertCols(command.sheet, command.col, count);
          else this.workbook.deleteCols(command.sheet, command.col, count);
          const at = command.cmd === 'insertRows' || command.cmd === 'deleteRows' ? command.row : command.col;
          this.emit({
            type: 'cellsChanged',
            refs: this.structuralShiftRefs(
              command.sheet,
              command.cmd === 'insertRows' || command.cmd === 'deleteRows',
              at,
              usedBefore,
              this.getUsedRange(command.sheet),
            ),
          });
          return { ok: true };
        }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const unreachable: never = command;
    return { ok: false, error: `Unknown command: ${JSON.stringify(unreachable)}` };
  }

  /**
   * Async command execution. Currently serves 'recalculateParallel' — the
   * worker-pool recalculation, which is inherently asynchronous. All other
   * commands delegate to the synchronous execute().
   */
  async executeAsync(command: EngineCommand): Promise<AsyncCommandResult> {
    if (command.cmd === 'recalculateParallel') {
      // Save-pin gate (see savePinGate): a bare parallel recalc can move
      // values with no edited cell to enumerate a changed set from.
      if (this.savePins.size > 0) {
        throw new SavePinOverflowError(
          'command recalculateParallel cannot run while a save pin is active; release the pin and retry',
        );
      }
      try {
        const stats = await this.workbook.recalculateParallel();
        this.emit({ type: 'recalcComplete' });
        return { ok: true, stats };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return this.execute(command);
  }

  /** Plug in a host-specific worker factory (e.g. Web Workers on web). */
  setWorkerBackendFactory(factory: WorkerBackendFactory): void {
    this.workbook.setParallelRecalcOptions({ factory });
  }

  /**
   * Hold evaluation suspended for one host dispatch (issue #58;
   * see EngineWorkbook.suspendEvaluation). Delegates only — hosts
   * that never call it (web, gateway) are unaffected.
   */
  suspendEvaluation(): void {
    this.workbook.suspendEvaluation();
  }

  /** Release a suspendEvaluation() hold, flushing evaluation once. */
  resumeEvaluation(): void {
    this.workbook.resumeEvaluation();
  }

  /** True while a suspendEvaluation() hold is outstanding. */
  isEvaluationSuspended(): boolean {
    return this.workbook.isEvaluationSuspended();
  }

  getParallelRecalcOptions(): ParallelRecalcOptions {
    return this.workbook.getParallelRecalcOptions();
  }

  /**
   * Terminate the parallel-recalculation worker pool, if one is running.
   * Worker threads keep the process alive, so hosts that enable parallel
   * recalculation must call this on shutdown (and when replacing the
   * workbook/host) instead of relying on process teardown alone.
   */
  disposeParallelWorkers(): void {
    this.workbook.disposeParallelWorkers();
  }

  /**
   * Read one cell through authorize() (permission-model.md §4: every API
   * calls authorize; reads are no exception). A denied read returns a
   * #PERM! permission-error value — never a fake empty.
   *
   * Face e (no leak through formulas): when the cell holds a formula, its
   * transitive precedents are checked against the hidden-check hook. If any
   * precedent is hidden from this principal — including dynamic references
   * via INDIRECT("A1") — the read returns #PERM! instead of the value.
   */
  readCell(ref: CellRef, auth: AuthContext = DEFAULT_AUTH): TypedValue {
    return withHostAuth(auth, () => {
      if (!this.authorizer.authorize('cell.read', toA1(ref), auth)) {
        return permDenied(`permission denied: cell.read ${toA1(ref)}`);
      }
      if (this.hiddenCheck?.(ref, auth.principal)) {
        return permDenied(`hidden cell: ${toA1(ref)}`);
      }
      // The workbook's getValue enforces name.read / function.read for
      // names referenced by the formula (design §5) and maps denials to
      // #PERM! — auth threads through so the check sees this principal.
      const value = this.view.readCell(ref, auth).value;
      if (this.hiddenCheck && this.workbook.getFormula(ref) !== undefined) {
        if (this.formulaTouchesHidden(ref, auth.principal)) {
          return permDenied(`formula references hidden cell: ${toA1(ref)}`);
        }
      }
      return value;
    });
  }

  /**
   * Bulk readback of every non-empty cell with readCell()'s exact
   * authorization semantics, in ONE pass over the workbook's cell
   * storage (see EngineWorkbook.getBulkReadback). Per cell, in
   * readCell()'s order: authorize('cell.read') → direct hidden check →
   * the workbook value (which encodes name/function read denials) →
   * formula hidden-taint check. Denied cells carry the same #PERM!
   * values (and messages) readCell() would return; callers that filter
   * on #PERM! (snapshot, mirror) observe identical results to the
   * per-cell path at a fraction of the cost — the per-cell path
   * re-serialized every formula through HyperFormula on each of its
   * passes, this one serializes each cell once and serves
   * auth-independent values from the maintained value cache.
   */
  bulkReadback(
    auth: AuthContext = DEFAULT_AUTH,
  ): Array<{ ref: CellRef; input: CellInput; value: TypedValue }> {
    return withHostAuth(auth, () =>
      this.workbook.getBulkReadback(auth).map(({ ref, input, value, isFormula }) => {
        if (!this.authorizer.authorize('cell.read', toA1(ref), auth)) {
          return { ref, input, value: permDenied(`permission denied: cell.read ${toA1(ref)}`) };
        }
        if (this.hiddenCheck?.(ref, auth.principal)) {
          return { ref, input, value: permDenied(`hidden cell: ${toA1(ref)}`) };
        }
        if (this.hiddenCheck && isFormula) {
          if (this.formulaTouchesHidden(ref, auth.principal)) {
            return {
              ref,
              input,
              value: permDenied(`formula references hidden cell: ${toA1(ref)}`),
            };
          }
        }
        return { ref, input, value };
      }),
    );
  }

  /**
   * Pinned bulk readback of ONE sheet: the sheet's cells AS OF the pin,
   * in bulkReadback()'s order (row, then col) and with bulkReadback()'s
   * exact authorization semantics.
   *
   * Construction: start from the LIVE bulkReadback(auth) entries for
   * the sheet (which gives every unedited cell — and the whole
   * authorization pipeline — for free, from the very code path being
   * matched), then apply the pin's stash:
   *  - a live cell with a stash entry takes the stashed input + value
   *    (it changed after the pin; the stash holds its pin-time state);
   *  - a live cell whose stash entry is ABSENT was created after the
   *    pin: omitted;
   *  - a stash entry with no live counterpart (deleted after the pin)
   *    is included from the stash.
   *
   * Authorization choice (documented per the brief): the STASH is
   * principal-agnostic — entries were captured through
   * EngineWorkbook.getPinnedCellState(), which evaluates with no auth
   * (engine-internal posture), so the frozen value never encodes the
   * EDITING principal's permissions. Authorization filtering is then
   * applied per REQUESTING principal at read time, in bulkReadback()'s
   * exact order (cell.read authorize → direct hidden check →
   * workbook-level name/function denial → formula hidden-taint), with
   * one necessary adaptation: the workbook-level denial is computed
   * from the FROZEN input via formulaNameReadDenial() instead of from
   * the live cell's value (the live value's denial would describe the
   * live formula, not the pin-time one), and the hidden-taint literal
   * scan also covers the frozen formula text (INDIRECT targets).
   * Because name ops throw while a pin is active, the name/function
   * registry the denial reads is the same at pin time and read time.
   */
  /** Sheet-scoped bulk readback: bulkReadback()'s exact authorization
   * pipeline over ONE sheet's cells (see EngineWorkbook.getBulkReadback's
   * onlySheet filter — the per-cell work is sheet-local). */
  bulkReadbackSheet(
    sheet: string,
    auth: AuthContext = DEFAULT_AUTH,
  ): Array<{ ref: CellRef; input: CellInput; value: TypedValue }> {
    return withHostAuth(auth, () =>
      this.workbook.getBulkReadback(auth, sheet).map(({ ref, input, value, isFormula }) => {
        if (!this.authorizer.authorize('cell.read', toA1(ref), auth)) {
          return { ref, input, value: permDenied(`permission denied: cell.read ${toA1(ref)}`) };
        }
        if (this.hiddenCheck?.(ref, auth.principal)) {
          return { ref, input, value: permDenied(`hidden cell: ${toA1(ref)}`) };
        }
        if (this.hiddenCheck && isFormula) {
          if (this.formulaTouchesHidden(ref, auth.principal)) {
            return {
              ref,
              input,
              value: permDenied(`formula references hidden cell: ${toA1(ref)}`),
            };
          }
        }
        return { ref, input, value };
      }),
    );
  }

  bulkReadbackSheetPinned(
    pin: SavePin,
    sheet: string,
    auth: AuthContext = DEFAULT_AUTH,
  ): Array<{ ref: CellRef; input: CellInput; value: TypedValue }> {
    const state = this.requireSavePin(pin);
    return withHostAuth(auth, () => {
      const live = this.bulkReadbackSheet(sheet, auth);
      const liveKeys = new Set(live.map((e) => savePinKey(e.ref)));
      const out: Array<{ ref: CellRef; input: CellInput; value: TypedValue }> = [];
      for (const entry of live) {
        const stashed = state.stash.get(savePinKey(entry.ref));
        if (stashed === undefined) {
          out.push(entry);
        } else if (!stashed.absent) {
          out.push({
            ref: entry.ref,
            input: stashed.input,
            value: this.pinnedValueFor(entry.ref, stashed.input, stashed.value, auth),
          });
        }
        // stashed.absent: created after the pin — omit.
      }
      for (const stashed of state.stash.values()) {
        if (stashed.absent || stashed.ref.sheet !== sheet) continue;
        if (liveKeys.has(savePinKey(stashed.ref))) continue;
        // Deleted after the pin (or otherwise absent live): include
        // from the stash, authorization-filtered like any other cell.
        out.push({
          ref: { ...stashed.ref },
          input: stashed.input,
          value: this.pinnedValueFor(stashed.ref, stashed.input, stashed.value, auth),
        });
      }
      out.sort((a, b) => a.ref.row - b.ref.row || a.ref.col - b.ref.col);
      return out;
    });
  }

  /**
   * bulkReadback()'s per-cell authorization pipeline applied to a frozen
   * (pin-time) input + value. See bulkReadbackSheetPinned() for the
   * documented authorization choice.
   */
  private pinnedValueFor(
    ref: CellRef,
    input: CellInput,
    value: TypedValue,
    auth: AuthContext,
  ): TypedValue {
    if (!this.authorizer.authorize('cell.read', toA1(ref), auth)) {
      return permDenied(`permission denied: cell.read ${toA1(ref)}`);
    }
    if (this.hiddenCheck?.(ref, auth.principal)) {
      return permDenied(`hidden cell: ${toA1(ref)}`);
    }
    let out = value;
    const isFormula = typeof input === 'string' && input.length > 1 && input.startsWith('=');
    if (isFormula) {
      const denied = this.workbook.formulaNameReadDenial(input, auth);
      if (denied !== undefined) {
        out = err('#PERM!', `No read access to "${denied}".`);
      }
      if (this.hiddenCheck && this.pinnedFormulaTouchesHidden(ref, input, auth.principal)) {
        out = permDenied(`formula references hidden cell: ${toA1(ref)}`);
      }
    }
    return out;
  }

  /**
   * Hidden-taint for a frozen formula: formulaTouchesHidden() walks the
   * LIVE graph / live formula text; a pinned cell's formula may have
   * been edited or deleted since, so its INDIRECT-style string literals
   * are additionally scanned from the frozen input.
   */
  private pinnedFormulaTouchesHidden(ref: CellRef, input: CellInput, principal: string): boolean {
    if (this.formulaTouchesHidden(ref, principal)) return true;
    const hidden = this.hiddenCheck;
    if (!hidden || typeof input !== 'string') return false;
    for (const lit of extractStringLiterals(input)) {
      const range = parseA1RangeRef(lit, ref.sheet);
      if (range) {
        for (let r = range.startRow; r <= range.endRow; r++) {
          for (let c = range.startCol; c <= range.endCol; c++) {
            if (hidden({ sheet: range.sheet, row: r, col: c }, principal)) return true;
          }
        }
      } else {
        const cell = parseA1CellRef(lit, ref.sheet);
        if (cell && hidden(cell, principal)) return true;
      }
    }
    return false;
  }

  /**
   * Named-range defs with live refers-to (scope, stable id, dangling
   * state). Metadata only — values stay behind readCell's authorize().
   */
  listNamedRanges() {
    return this.workbook.listNamedRanges();
  }

  /** Named-function defs (stable id, typed signature, version history). */
  listNamedFunctionDefs() {
    return this.workbook.listNamedFunctionDefs();
  }

  /** Install the hidden-cell check (wired to ProtectionManager by the host). */
  setHiddenCheck(check: HiddenCheck | undefined): void {
    this.hiddenCheck = check;
    this.hiddenTaintMemo.clear();
  }

  /**
   * Drop cached hidden-taint results. Hosts that mutate the hidden set
   * OUTSIDE execute() (e.g. the engine service's protection routes, which
   * write the ProtectionManager directly) must call this afterwards, or a
   * cell hidden after earlier reads could keep serving values from cache.
   */
  clearHiddenTaintCache(): void {
    this.hiddenTaintMemo.clear();
  }

  /**
   * Does this cell's formula (transitively) reference a cell hidden from
   * the principal? Covers static references via the HyperFormula
   * dependency graph plus dynamic INDIRECT("A1")-style string references,
   * which HyperFormula does not track.
   */
  private formulaTouchesHidden(ref: CellRef, principal: string): boolean {
    const hidden = this.hiddenCheck;
    if (!hidden) return false;
    if (this.graphTaintsHidden(ref, principal)) return true;
    // INDIRECT("A1") / INDIRECT("Sheet2!B3:D5"): scan string literals in
    // the formula text for anything that parses as a cell/range reference.
    const formula = this.workbook.getFormula(ref);
    if (formula) {
      for (const lit of extractStringLiterals(formula)) {
        const range = parseA1RangeRef(lit, ref.sheet);
        if (range) {
          for (let r = range.startRow; r <= range.endRow; r++) {
            for (let c = range.startCol; c <= range.endCol; c++) {
              if (hidden({ sheet: range.sheet, row: r, col: c }, principal)) return true;
            }
          }
        } else {
          const cell = parseA1CellRef(lit, ref.sheet);
          if (cell && hidden(cell, principal)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Graph half of the hidden-taint question: does ref's transitive precedent
   * closure contain a cell hidden from principal? Computed as a least fixed
   * point over the unexplored closure (collect nodes + reverse edges, seed
   * cells that directly precede a hidden or already-known-tainted cell, then
   * propagate taint to dependents until stable — cycles included), memoized
   * for every visited cell so a bulk read costs O(V + E) once per workbook
   * state instead of O(closure) per cell.
   */
  private graphTaintsHidden(root: CellRef, principal: string): boolean {
    const hidden = this.hiddenCheck;
    if (!hidden) return false;
    const memo = this.hiddenTaintMemo;
    const keyOf = (r: CellRef): string => `${principal} ${r.sheet}!${r.row},${r.col}`;
    const rootKey = keyOf(root);
    const cached = memo.get(rootKey);
    if (cached !== undefined) return cached;
    const nodes = new Set<string>([rootKey]);
    const dependents = new Map<string, string[]>(); // precedent key -> dependent keys (within the explored region)
    const tainted = new Set<string>();
    const queue: CellRef[] = [root];
    while (queue.length > 0) {
      const cur = queue.pop() as CellRef;
      const curKey = keyOf(cur);
      for (const prec of this.workbook.getPrecedents(cur)) {
        const precKey = keyOf(prec);
        let deps = dependents.get(precKey);
        if (!deps) {
          deps = [];
          dependents.set(precKey, deps);
        }
        deps.push(curKey);
        if (hidden(prec, principal)) {
          tainted.add(curKey);
          continue;
        }
        const known = memo.get(precKey);
        if (known !== undefined) {
          if (known) tainted.add(curKey);
          continue; // memoized boundary: do not expand further
        }
        if (!nodes.has(precKey)) {
          nodes.add(precKey);
          queue.push(prec);
        }
      }
    }
    const worklist = [...tainted];
    while (worklist.length > 0) {
      const k = worklist.pop() as string;
      for (const dep of dependents.get(k) ?? []) {
        if (!tainted.has(dep)) {
          tainted.add(dep);
          worklist.push(dep);
        }
      }
    }
    if (memo.size + nodes.size > EngineHost.TAINT_MEMO_LIMIT) memo.clear();
    for (const k of nodes) memo.set(k, tainted.has(k));
    return tainted.has(rootKey);
  }

  /**
   * Read a range through authorize() per cell (permission-model.md §4:
   * bulk operations enforce per cell; permitted cells return, denied cells
   * are marked denied, values never leak).
   */
  readRange(range: RangeRef, auth: AuthContext = DEFAULT_AUTH): TypedValue[][] {
    const out: TypedValue[][] = [];
    for (let r = range.startRow; r <= range.endRow; r++) {
      const row: TypedValue[] = [];
      for (let c = range.startCol; c <= range.endCol; c++) {
        row.push(this.readCell({ sheet: range.sheet, row: r, col: c }, auth));
      }
      out.push(row);
    }
    return out;
  }

  /**
   * Per-subject filtered sheet read (permission-model.md §4: the
   * storage-to-view projection is built per subject, so unauthorized cells
   * never reach the caller). Denied cells come back as #PERM! values.
   */
  readSheet(sheet: string, auth: AuthContext = DEFAULT_AUTH): TypedValue[][] {
    const range = this.view.usedRange(sheet);
    if (!range) return [];
    return this.readRange(range, auth);
  }

  snapshot(): WorkbookSnapshot {
    return this.workbook.toSnapshot();
  }

  /**
   * The used range of a sheet, or null when the sheet is empty.
   * Protocol-level accessor so remote/forwarding hosts can serve it without
   * reaching past the versioned protocol into the view. Goes through
   * getView() (not the private view field) so hosts that override getView()
   * — e.g. RemoteEngineHost — are honored.
   */
  getUsedRange(sheet: string): RangeRef | null {
    return this.getView().usedRange(sheet);
  }

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: EngineEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // A failing listener must not break the engine.
      }
    }
  }

  dispose(): void {
    if (this.unsubscribeValues) {
      this.unsubscribeValues();
      this.unsubscribeValues = null;
    }
    if (this.unsubscribePinObserver) {
      this.unsubscribePinObserver();
      this.unsubscribePinObserver = null;
    }
    this.savePins.clear();
    this.listeners.clear();
  }
}

/**
 * Extract double-quoted string literals from formula text (for the
 * INDIRECT() leak scan). Handles "" escapes.
 */
function extractStringLiterals(formula: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"]|"")*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    out.push(m[1]?.replace(/""/g, '"') ?? '');
  }
  return out;
}
