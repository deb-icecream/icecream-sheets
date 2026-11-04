/**
 * IPC-backed engine host for the desktop renderer (Cycle 10 — desktop
 * engine/view separation, platform-shell.md §1).
 *
 * The user's workbook lives in the Electron MAIN process's EngineHost.
 * This adapter is the renderer's client of that host over the
 * window.icecream IPC bridge (Promise-based invoke/handle — the same
 * bridge the shell has shipped since Cycle 8). The renderer holds NO
 * workbook: no parse, no EngineWorkbook build, no HyperFormula calc on
 * the UI thread, ever. The desktop stays fully offline-capable — the
 * engine is local (main process); no services are involved.
 *
 * ---------------------------------------------------------------------------
 * SYNC-READ / ASYNC-WRITE CONTRACT — READ BEFORE CALLING (Cycle 10 fix)
 * ---------------------------------------------------------------------------
 * READ overrides (readCell / readRange / readSheet / getUsedRange /
 * snapshot, and every IpcView read) are GENUINELY SYNCHRONOUS, exactly
 * like RemoteEngineHost/RemoteView (the gateway host): they serve the
 * adapter's read-through cache and NEVER return a Promise. The UI
 * (FormulaBar, Grid, Ribbon, features) reads synchronously through
 * getView()/readRange() — an earlier revision returned Promises cast to
 * the sync types, so consumers read `.value` off a Promise (undefined),
 * formatDisplay(undefined) threw in a mount effect, and the whole React
 * tree unmounted (blank white window, packaged and dev).
 *
 * On a cache MISS a read returns the null placeholder
 * ({kind:'null',value:null} — a range miss returns a correctly-shaped
 * matrix of placeholders; usedRange/snapshot misses return null / a
 * name-only snapshot) and queues ONE deduped background IPC fetch. When
 * the fetch lands it populates the cache and fires the adapter's scoped
 * event mechanism (emitLocal cellsChanged for exactly the filled refs;
 * a recalcComplete repaint tick for used-range/snapshot fills) so the
 * grid repaints with the real values. Await-capable callers use the
 * explicit *Async methods (readCellAsync / readRangeAsync /
 * getUsedRangeAsync / snapshotAsync), which await the same fills.
 *
 * WRITE/execute paths stay async at runtime (execute() returns a
 * Promise cast to CommandResult, as before): an IPC round-trip for a
 * mutation is inherently async, edit call sites already await/settle
 * it, and the optimistic overlay covers the edited cell meanwhile.
 * `ipcRenderer.sendSync` remains forbidden by design: it would block
 * the UI thread exactly like the old in-process engine did.
 *
 * ---------------------------------------------------------------------------
 * DISPLAY IS PROGRESSIVE; RE-RENDERING IS SCOPED (user's design line)
 * ---------------------------------------------------------------------------
 * The renderer streams values from the main-process engine and renders
 * progressively: viewport reads first (readRange on the visible region),
 * the rest as it arrives. A cell the adapter has not received yet is
 * UNLOADED — the render layer shows a loading state for it and never
 * presents stale/empty data as final (see the value cache below: it can
 * distinguish "loaded empty" from "not loaded yet" via hasCell()).
 * Engine events carry the exact refs that changed; subscribers receive
 * them untouched so painting stays scoped to the affected cells/visuals —
 * the adapter never synthesizes workbook-wide invalidations or repaints.
 *
 * OPTIMISTIC DISPLAY: when an edit is routed to the main-process engine
 * (setCell/setFormula via execute), the edited cell's display value is
 * recorded in the optimistic overlay BEFORE the IPC round-trip and a
 * scoped cellsChanged event is emitted locally, so the typed cell shows
 * the user's input immediately. Downstream results fill in when the
 * engine replies (its events invalidate exactly the affected refs). The
 * engine owns the true values: the overlay clears when the engine
 * confirms the change (a cellsChanged event naming the cell — emitted
 * from inside the mutation itself — or a recalcComplete), and a
 * denied/failed edit drops the overlay back to the last-known engine
 * value.
 *
 * MUTATION GATING lives in the app, not here: edit/save/autosave/export
 * stay disabled until the workbook is 100% loaded (see App.tsx).
 */

import {
  Authorizer,
  ENGINE_PROTOCOL_VERSION,
  EngineHost,
  TypedView,
  allowAllPolicy,
  type AuthContext,
  type CellInput,
  type CellRef,
  type CommandResult,
  type EngineCommand,
  type EngineEvent,
  type EngineEventListener,
  type EngineLoadResult,
  type RangeRef,
  type TypedCell,
  type TypedValue,
  type WorkbookSnapshot,
  type WorkerBackendFactory,
} from '@icecream-sheets/engine';
import { EditInFlightTracker } from './saveInterlock';

/** The engine's empty-cell value: the placeholder served on a cache miss. */
const EMPTY: TypedValue = { kind: 'null', value: null };

/**
 * One cell's post-edit state on an execute reply (issue #58): the
 * main-process dispatch attaches the edited cell's and its dependents'
 * fresh values so the edit completes in ONE roundtrip — this adapter
 * seeds its caches from them instead of re-fetching after every edit.
 * Mirrors DesktopEditReplyValue in apps/desktop/src/engine-ipc.ts.
 */
export interface IpcExecuteReplyValue {
  ref: CellRef;
  value: TypedValue;
  /** Only on the edited cell's entry: its formula state is authoritative. */
  formulaKnown?: boolean;
  formula?: string;
}

/** The bridge's execute reply: a CommandResult plus optional reply values. */
export type IpcExecuteReply = CommandResult & {
  values?: IpcExecuteReplyValue[];
};

/** Minimal shape of the preload bridge (window.icecream, preload.ts). */
export interface IpcEngineBridge {
  execute(command: EngineCommand): Promise<IpcExecuteReply>;
  /** The gateway's cell-read shape: value + formula when readable. */
  readCell(ref: CellRef): Promise<{ value: TypedValue; formula?: string }>;
  readRange(range: RangeRef): Promise<TypedValue[][]>;
  usedRange(sheet: string): Promise<RangeRef | null>;
  snapshot(): Promise<WorkbookSnapshot>;
  protocolVersion(): Promise<number>;
  load(bytes: Uint8Array, filename: string): Promise<EngineLoadResult>;
  newWorkbook(): Promise<void>;
  setProtection(state: Record<string, unknown>): Promise<void>;
  onEngineEvent(cb: (event: EngineEvent) => void): () => void;
}

/** How the adapter finds its bridge (injectable for tests). */
export type IpcBridgeProvider = () => IpcEngineBridge | null;

function defaultBridge(): IpcEngineBridge | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as unknown as { icecream?: IpcEngineBridge }).icecream ?? null
  );
}

/** Bound on one IPC call: fail the op instead of hanging the UI forever. */
export const IPC_CALL_TIMEOUT_MS = 30_000;

/**
 * Bound on the bulk `load` call only. A workbook load's duration scales
 * with file size — a P95-class workbook (1.8M cells) takes well over the
 * 30s interactive bound just to parse + build in the main process, so the
 * interactive timeout made such files unopenable on desktop (the load was
 * abandoned at 30s while the main process finished it moments later).
 * Loads get their own generous-but-finite bound: a genuinely dead main
 * process still fails the open instead of hanging the UI forever.
 */
export const IPC_LOAD_TIMEOUT_MS = 600_000;

/** One optimistic (unconfirmed) edit awaiting the engine's reply. */
interface OptimisticEntry {
  /** Display value for the edited cell (formula edits keep the formula). */
  value: TypedValue;
  formula?: string;
}

function cellKey(ref: CellRef): string {
  return `${ref.sheet}${ref.row},${ref.col}`;
}

function rangeKey(range: RangeRef): string {
  return `${range.sheet}:${range.startRow},${range.startCol}-${range.endRow},${range.endCol}`;
}

function inputToTypedValue(value: CellInput): TypedValue {
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'string') return { kind: 'string', value };
  return { kind: 'null', value: null };
}

export class IpcEngineHost extends EngineHost {
  private readonly bridgeProvider: IpcBridgeProvider;
  private readonly timeoutMs: number;
  /** Client-side stub: the main-process host is the enforcement point. */
  private readonly stubAuthorizer = new Authorizer(allowAllPolicy());
  private readonly ipcListeners = new Set<EngineEventListener>();
  private readonly ipcView: IpcView;
  private offBridgeEvents: (() => void) | null = null;
  private disposed = false;
  /**
   * Save-interlock tracker (Cycle 10 closure, additive): counts every
   * execute() until its IPC round-trip settles, so the desktop autosave
   * / manual-save paths can DEFER while an edit is in flight instead of
   * serializing the optimistic / pre-edit state. See saveInterlock.ts.
   */
  private readonly editFlight = new EditInFlightTracker();

  // -- Progressive display state -------------------------------------------
  /** Sheet names, kept live from load results + engine events. */
  private sheetNameCache: string[] | null = null;
  /**
   * Last-known engine values (the progressive cache). A ref ABSENT here
   * is UNLOADED, not empty — the render layer shows a loading state for
   * it. Entries invalidate exactly when engine events name them.
   */
  private readonly valueCache = new Map<string, TypedValue>();
  /** Formulas learned alongside values (formula bar / editor seeding). */
  private readonly formulaCache = new Map<string, string>();
  /**
   * Cells whose FORMULA STATE is authoritatively known (issue #43): a
   * single-cell bridge read has settled for the cell, so formulaCache
   * either holds its formula or the cell provably has none. The bulk
   * readRange bridge returns VALUES ONLY, so a value-cache hit alone
   * proves nothing about the formula — before this set existed, a cell
   * filled by a bulk read never got a single-cell fetch (those queue
   * only on value misses), formulaCache stayed empty, and the formula
   * bar showed the computed value instead of the formula for every
   * formula cell in desktop-local mode. Entries invalidate with the
   * caches (engine cellsChanged / progressive reset).
   */
  private readonly formulaResolved = new Set<string>();
  /** Optimistic (unconfirmed) user input, per edited cell. */
  private readonly optimistic = new Map<string, OptimisticEntry>();
  /** Used-range cache per sheet (refreshed via engine:usedRange). */
  private readonly usedRangeCache = new Map<string, RangeRef | null>();
  /**
   * Per-cell mutation epochs (Cycle 10 closure, defect D2): bumped every
   * time a cell is mutated through execute() or invalidated by an engine
   * cellsChanged event. A background fill captures the epoch when it is
   * QUEUED and drops its result if the epoch moved before it landed —
   * otherwise a fill whose IPC read was issued before an edit (or before
   * an undo's restore edit) could land afterwards and resurrect the
   * pre-edit value in the cache, leaving the grid showing the stale
   * value even though the main-process engine holds the new one.
   */
  private readonly cellEpochs = new Map<string, number>();
  // -- Sync-read fill machinery (mirrors RemoteView's read-through cache) --
  /** Last async-fetched snapshot; snapshot() is a sync cache read. */
  private cachedSnapshot: WorkbookSnapshot | null = null;
  private snapshotInFlight: Promise<WorkbookSnapshot> | null = null;
  /** Deduped background fills, by cell/range key. */
  private readonly pendingCellFetches = new Map<string, Promise<void>>();
  private readonly pendingRangeFetches = new Map<string, Promise<void>>();
  private readonly usedRangeInFlight = new Map<string, Promise<RangeRef | null>>();
  /** Bumped on every workbook reset: stale fills from the old workbook drop. */
  private fillGeneration = 0;
  // -- Fill-notification coalescing (Cycle 10 closure) ----------------------
  // A fill landing used to emit its scoped event immediately, so an open
  // that queued dozens of viewport/feature fills forced one FULL App
  // render per fill — a burst of ~70–105 ms tasks queued back-to-back
  // whose sum was the worst renderer stall of the open (the gateway
  // host's poll coalescing fixed the same class there). Fill-originated
  // notifications now merge into ONE delivery per animation frame:
  // cellsChanged refs union, recalcComplete collapses to a single tick.
  // Optimistic-edit emits and main→renderer engine events stay
  // immediate (they are single, user-paced, and order-sensitive); a
  // pending fill batch flushes before any immediate emit so subscribers
  // never see events out of order.
  private pendingFillRefs = new Map<string, CellRef>();
  private pendingFillRecalc = false;
  private fillFlushHandle: ReturnType<typeof setTimeout> | number | null = null;

  constructor(bridgeProvider: IpcBridgeProvider = defaultBridge, timeoutMs = IPC_CALL_TIMEOUT_MS) {
    // The local workbook is never used; every public method is
    // overridden. deferWorkbook (issue #58) keeps the superclass from
    // building its dead stub HyperFormula in the renderer at all: the
    // workbook — and its TypedView — materialize lazily only if some
    // un-overridden base accessor is ever reached.
    super(undefined, undefined, { deferWorkbook: true });
    this.bridgeProvider = bridgeProvider;
    this.timeoutMs = timeoutMs;
    this.ipcView = new IpcView(this);
    // The bridge may appear later (preload race): tolerate absence here
    // and fail loudly on the first actual op (bridge()).
    const bridge = this.bridgeProvider();
    if (bridge) {
      this.offBridgeEvents = bridge.onEngineEvent((event) => this.onEngineEvent(event));
      // Learn the initial workbook's shape progressively (blank Sheet1 on
      // a fresh launch, or the workbook restored by a reload).
      void this.refreshSheetNames().catch(() => undefined);
    }
  }

  private bridge(): IpcEngineBridge {
    const b = this.bridgeProvider();
    if (!b) throw new Error('IpcEngineHost: window.icecream bridge is not available (not running on desktop)');
    return b;
  }

  /** Race one bridge call against the IPC timeout (fail, never hang). */
  private async call<T>(what: string, p: Promise<T>, timeoutMs: number = this.timeoutMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`ipcEngine: ${what} timed out after ${timeoutMs}ms (main-process engine unreachable)`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -- Open / New (desktop flows; the workbook moves in the main process) --

  /**
   * Open a workbook through the engine:load IPC channel: the main
   * process parses + builds; this adapter resets its progressive state
   * and adopts the returned sheet summaries. Resolves with the load
   * result (sheet summaries + adapter metadata for UI hydration).
   */
  async loadIpc(bytes: Uint8Array, filename: string): Promise<EngineLoadResult> {
    // Bytes cross IPC as a Uint8Array (binary structured clone). The old
    // Array.from(bytes) materialized one JS number per byte on the UI
    // thread and Electron then cloned that array element-by-element —
    // together the single worst renderer task of a P75 open (~130 ms
    // profiled: loadIpc self + invoke serialization). Passing the typed
    // array through makes the transfer a memcpy, not a per-byte walk.
    const result = await this.call('load', this.bridge().load(bytes, filename), IPC_LOAD_TIMEOUT_MS);
    this.resetProgressiveState();
    this.sheetNameCache = result.sheets.map((s) => s.name);
    return result;
  }

  /** Reset to a blank workbook through engine:new. */
  async newIpc(): Promise<void> {
    await this.call('newWorkbook', this.bridge().newWorkbook());
    this.resetProgressiveState();
    this.sheetNameCache = ['Sheet1'];
  }

  /** Push protection state to the main-process host (engine:protection). */
  async setProtectionIpc(state: Record<string, unknown>): Promise<void> {
    await this.call('setProtection', this.bridge().setProtection(state));
  }

  private resetProgressiveState(): void {
    this.fillGeneration++;
    this.cancelFillFlush();
    this.pendingFillRefs.clear();
    this.pendingFillRecalc = false;
    this.valueCache.clear();
    this.formulaCache.clear();
    this.formulaResolved.clear();
    this.optimistic.clear();
    this.usedRangeCache.clear();
    this.cellEpochs.clear();
    this.cachedSnapshot = null;
    this.snapshotInFlight = null;
    this.pendingCellFetches.clear();
    this.pendingRangeFetches.clear();
    this.usedRangeInFlight.clear();
  }

  /** Refresh the sheet-name cache from the main-process host. */
  async refreshSheetNames(): Promise<string[]> {
    const snap = await this.snapshotAsync();
    return [...(this.sheetNameCache ?? snap.sheets.map((s) => s.name))];
  }

  // -- Optimistic display (progressive contract) ---------------------------

  /**
   * Record an edit's display value before its IPC round-trip and paint it
   * immediately (scoped cellsChanged for exactly the edited ref).
   */
  private setOptimistic(command: EngineCommand): void {
    if (command.cmd === 'setCell') {
      this.optimistic.set(cellKey(command.ref), { value: inputToTypedValue(command.value) });
      this.emitLocal({ type: 'cellsChanged', refs: [command.ref] });
    } else if (command.cmd === 'setFormula') {
      // The typed formula shows immediately (formula bar); the cell's
      // value is unknown until calc replies — keep the formula overlay so
      // the render layer can mark the value as pending, never stale-final.
      this.optimistic.set(cellKey(command.ref), {
        value: this.valueCache.get(cellKey(command.ref)) ?? { kind: 'null', value: null },
        formula: command.formula,
      });
      this.emitLocal({ type: 'cellsChanged', refs: [command.ref] });
    }
  }

  /** Drop one cell's optimistic overlay (engine replied / edit failed). */
  private clearOptimistic(ref: CellRef): void {
    this.optimistic.delete(cellKey(ref));
  }

  /** The optimistic entry for a cell, if the engine hasn't confirmed yet. */
  optimisticEntry(ref: CellRef): OptimisticEntry | undefined {
    return this.optimistic.get(cellKey(ref));
  }

  /** The last formula learned for a cell (via readCell), if any. */
  cachedFormula(ref: CellRef): string | undefined {
    return this.formulaCache.get(cellKey(ref));
  }

  /**
   * True when the cell's value has been received from the engine (loaded)
   * — false means UNLOADED: the render layer shows a loading state and
   * must not treat the cell as empty/final.
   */
  hasCell(ref: CellRef): boolean {
    const k = cellKey(ref);
    return this.valueCache.has(k) || this.optimistic.has(k);
  }

  // -- Protocol ops (async runtime — see the contract note) ----------------

  // -- Save interlock (Cycle 10 closure) ------------------------------------
  // While an edit's IPC round-trip is unsettled, the workbook holds
  // optimistic / pre-edit state: autosave and manual save must DEFER
  // (never serialize, never mark clean) until it settles.

  /** True while any execute() round-trip is unsettled. */
  hasInFlightEdits(): boolean {
    return this.editFlight.hasInFlightEdits();
  }

  /** Number of execute() round-trips currently in flight. */
  get editInFlightCount(): number {
    return this.editFlight.pendingCount;
  }

  /** Notify `listener` whenever the in-flight count changes. */
  subscribeEditFlight(listener: () => void): () => void {
    return this.editFlight.subscribe(listener);
  }

  /** Resolves once no edit is in flight (immediately when idle). */
  async whenEditsSettle(): Promise<void> {
    // Loop: an edit beginning while a prior batch settles must also be
    // awaited — a save may only proceed at a genuinely idle moment.
    while (this.editFlight.hasInFlightEdits()) {
      await this.editFlight.whenEditsSettle();
    }
  }

  override execute(command: EngineCommand): CommandResult {
    // Any fill queued before this mutation is stale for the edited cell:
    // bump its epoch so the fill drops its result when it lands (D2).
    if (command.cmd === 'setCell' || command.cmd === 'setFormula') {
      const k = cellKey(command.ref);
      this.cellEpochs.set(k, (this.cellEpochs.get(k) ?? 0) + 1);
    }
    this.setOptimistic(command);
    // Save interlock: this execute counts as in flight until its IPC
    // round-trip settles (success, denial, or transport failure alike).
    const endEditFlight = this.editFlight.beginEdit();
    let result: Promise<CommandResult>;
    try {
      result = this.call('execute', this.bridge().execute(command)).then(
        (res) => {
          if (res.ok) {
            // Issue #58: seed the caches from the reply's post-edit
            // values (no re-fetch) and patch the cached snapshot in
            // place for the edited cell. Only when neither applies
            // does a settled mutation invalidate the pulled snapshot
            // (the main-process engine is the source of truth at save
            // time; ensureSaveSnapshot re-pulls via snapshotAsync()).
            let patched = false;
            if (command.cmd === 'setCell' || command.cmd === 'setFormula') {
              const editedEntry = this.seedFromReply(res, command);
              if (editedEntry) patched = this.patchSnapshotForEdit(command, editedEntry);
            }
            if (!patched) this.cachedSnapshot = null;
          }
          if (!res.ok) {
            // Denied/failed edit: the engine's value stands — drop the
            // optimistic display for the edited cell.
            if (command.cmd === 'setCell' || command.cmd === 'setFormula') {
              this.clearOptimistic(command.ref);
            }
          }
          return res;
        },
        (err: unknown) => {
          if (command.cmd === 'setCell' || command.cmd === 'setFormula') {
            this.clearOptimistic(command.ref);
          }
          throw err;
        },
      );
    } catch (e) {
      // Synchronous failure (e.g. bridge missing): nothing is in flight.
      endEditFlight();
      throw e;
    }
    void result.then(endEditFlight, endEditFlight);
    return result as unknown as CommandResult;
  }

  override async executeAsync(command: EngineCommand): Promise<import('@icecream-sheets/engine').AsyncCommandResult> {
    // The main-process dispatch routes explicit recalcs through its worker
    // pool per the shape rule (see engine-ipc.ts); the reply is a
    // CommandResult (stats ride in `data`), a valid AsyncCommandResult.
    // Everything else shares execute()'s optimistic + failure handling.
    return this.execute(command);
  }

  // -- Synchronous cache reads (RemoteView semantics) -----------------------
  //
  // Every read below returns a REAL value synchronously: optimistic
  // overlay first, then the progressive cache, then the EMPTY
  // placeholder on a miss — with a deduped background IPC fill queued
  // behind the miss. Fills populate the cache and fire emitLocal
  // cellsChanged for exactly the filled refs (used-range/snapshot fills
  // fire a recalcComplete repaint tick), so subscribers repaint scoped
  // to what actually arrived. Fills NEVER throw into a render: a failed
  // or timed-out fill simply leaves the cell unloaded, and the next
  // read re-queues it.

  private hasBridge(): boolean {
    try {
      return this.bridgeProvider() !== null;
    } catch {
      return false;
    }
  }

  /**
   * Re-issue a fill for one cell once a stale fill settles (defect E3).
   * Called from a fill whose payload the mutation-epoch guard dropped:
   * the stale value stays dropped (W8 root cause 3 protection intact),
   * but the cell must not be left unloaded with no fill queued — after
   * the stale promise settles (its dedupe entry is gone by then), queue
   * a fresh fill unless the cell has since loaded or an optimistic edit
   * owns its display. The fresh fill captures the CURRENT epoch, so it
   * lands normally unless another mutation intervenes (finite chain).
   */
  private requeueCellAfter(settled: Promise<void>, ref: CellRef, gen: number): void {
    void settled.then(
      () => {
        if (this.disposed || gen !== this.fillGeneration) return;
        const k = cellKey(ref);
        if (this.valueCache.has(k) || this.optimistic.has(k)) return;
        if (this.pendingCellFetches.has(k)) return;
        void this.queueCellFetch(ref);
      },
      () => undefined,
    );
  }

  /** Queue (deduped) the background IPC fill for one cell. */
  private queueCellFetch(ref: CellRef): Promise<void> {
    const k = cellKey(ref);
    const existing = this.pendingCellFetches.get(k);
    if (existing) return existing;
    if (this.disposed || !this.hasBridge()) return Promise.resolve();
    const gen = this.fillGeneration;
    const epoch = this.cellEpochs.get(k) ?? 0;
    let p: Promise<void>;
    p = this.call('readCell', this.bridge().readCell(ref))
      .then((r) => {
        if (this.disposed || gen !== this.fillGeneration) return;
        // Stale fill: the cell was mutated/invalidated after this read
        // was issued — its payload predates the mutation (D2 guard).
        // The stale value is DROPPED (never written to the cache), but
        // the drop must not be terminal: once this fetch settles, queue
        // a fresh fill so the post-mutation value still streams in.
        // Without the re-issue a pre-edit fill landing late left the
        // cell unloaded with nothing queued to heal it (defect E3).
        if ((this.cellEpochs.get(k) ?? 0) !== epoch) {
          this.requeueCellAfter(p, ref, gen);
          return;
        }
        this.valueCache.set(k, r.value);
        if (r.formula !== undefined) this.formulaCache.set(k, r.formula);
        else this.formulaCache.delete(k);
        // A settled single-cell read is authoritative for the cell's
        // formula state (issue #43) — present or provably absent.
        this.formulaResolved.add(k);
        this.emitFill({ type: 'cellsChanged', refs: [ref] });
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.pendingCellFetches.get(k) === p) this.pendingCellFetches.delete(k);
      });
    this.pendingCellFetches.set(k, p);
    return p;
  }

  /** Queue (deduped) the background IPC fill for one range. */
  private queueRangeFetch(range: RangeRef): Promise<void> {
    const k = rangeKey(range);
    const existing = this.pendingRangeFetches.get(k);
    if (existing) return existing;
    if (this.disposed || !this.hasBridge()) return Promise.resolve();
    const gen = this.fillGeneration;
    // Per-cell epochs at queue time (D2 stale-fill guard, as readCell).
    const epochs = new Map<string, number>();
    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const key = cellKey({ sheet: range.sheet, row: r, col: c });
        epochs.set(key, this.cellEpochs.get(key) ?? 0);
      }
    }
    let p: Promise<void>;
    p = this.call('readRange', this.bridge().readRange(range))
      .then((values) => {
        if (this.disposed || gen !== this.fillGeneration) return;
        const refs: CellRef[] = [];
        const dropped: CellRef[] = [];
        for (let r = 0; r < values.length; r++) {
          const row = values[r]!;
          for (let c = 0; c < row.length; c++) {
            const ref = { sheet: range.sheet, row: range.startRow + r, col: range.startCol + c };
            const key = cellKey(ref);
            if ((this.cellEpochs.get(key) ?? 0) !== (epochs.get(key) ?? 0)) {
              // Stale for this cell (D2 guard): its payload predates a
              // mutation — dropped, but re-filled individually below
              // (defect E3: a dropped edited cell was never re-issued).
              dropped.push(ref);
              continue;
            }
            this.valueCache.set(key, row[c]!);
            refs.push(ref);
          }
        }
        if (refs.length > 0) this.emitFill({ type: 'cellsChanged', refs });
        for (const ref of dropped) this.requeueCellAfter(p, ref, gen);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.pendingRangeFetches.get(k) === p) this.pendingRangeFetches.delete(k);
      });
    this.pendingRangeFetches.set(k, p);
    return p;
  }

  override readCell(ref: CellRef, _auth?: AuthContext): TypedValue {
    const k = cellKey(ref);
    const opt = this.optimistic.get(k);
    if (opt) return opt.value;
    const cached = this.valueCache.get(k);
    if (cached) return cached;
    void this.queueCellFetch(ref);
    return EMPTY;
  }

  /** Async one-cell read for await-capable flows (awaits the fill). */
  async readCellAsync(ref: CellRef): Promise<{ value: TypedValue; formula?: string }> {
    const k = cellKey(ref);
    const opt = this.optimistic.get(k);
    if (opt) return { value: opt.value, ...(opt.formula ? { formula: opt.formula } : {}) };
    // Issue #43: a value-cache hit is NOT enough — bulk fills carry no
    // formulas, so unless a single-cell read has already resolved this
    // cell's formula state, fetch it now (deduped; later calls are
    // cache-cheap until the cell is invalidated).
    if (!this.valueCache.has(k) || !this.formulaResolved.has(k)) await this.queueCellFetch(ref);
    const formula = this.formulaCache.get(k);
    return { value: this.valueCache.get(k) ?? EMPTY, ...(formula !== undefined ? { formula } : {}) };
  }

  /** Build a range matrix purely from overlay+cache (no queueing). */
  private buildRangeValues(range: RangeRef): { values: TypedValue[][]; missing: boolean } {
    let missing = false;
    const values: TypedValue[][] = [];
    for (let r = range.startRow; r <= range.endRow; r++) {
      const row: TypedValue[] = [];
      for (let c = range.startCol; c <= range.endCol; c++) {
        const ref = { sheet: range.sheet, row: r, col: c };
        const opt = this.optimistic.get(cellKey(ref));
        if (opt) {
          row.push(opt.value);
          continue;
        }
        const cached = this.valueCache.get(cellKey(ref));
        if (cached) row.push(cached);
        else {
          missing = true;
          row.push(EMPTY);
        }
      }
      values.push(row);
    }
    return { values, missing };
  }

  override readRange(range: RangeRef, _auth?: AuthContext): TypedValue[][] {
    const { values, missing } = this.buildRangeValues(range);
    if (missing) void this.queueRangeFetch(range);
    return values;
  }

  /** Async range read for await-capable flows (awaits the fill). */
  async readRangeAsync(range: RangeRef): Promise<TypedValue[][]> {
    const first = this.buildRangeValues(range);
    if (!first.missing) return first.values;
    await this.queueRangeFetch(range);
    return this.buildRangeValues(range).values;
  }

  override readSheet(sheet: string, _auth?: AuthContext): TypedValue[][] {
    const used = this.getUsedRange(sheet);
    if (!used) return [];
    return this.readRange(used);
  }

  /** Async whole-sheet read for await-capable flows. */
  async readSheetAsync(sheet: string): Promise<TypedValue[][]> {
    const used = await this.getUsedRangeAsync(sheet);
    if (!used) return [];
    return this.readRangeAsync(used);
  }

  override getUsedRange(sheet: string): RangeRef | null {
    const cached = this.usedRangeCache.get(sheet);
    if (cached !== undefined) return cached;
    // Miss: queue the deduped fill; its landing fires a repaint tick.
    void this.getUsedRangeAsync(sheet)
      .then(() => {
        if (!this.disposed) this.emitFill({ type: 'recalcComplete' });
      })
      .catch(() => undefined);
    return null;
  }

  /** Async used-range (deduped: concurrent callers share one IPC call). */
  async getUsedRangeAsync(sheet: string): Promise<RangeRef | null> {
    const cached = this.usedRangeCache.get(sheet);
    if (cached !== undefined) return cached;
    const inFlight = this.usedRangeInFlight.get(sheet);
    if (inFlight) return inFlight;
    const gen = this.fillGeneration;
    const p: Promise<RangeRef | null> = this.call('usedRange', this.bridge().usedRange(sheet))
      .then((used) => {
        if (!this.disposed && gen === this.fillGeneration) this.usedRangeCache.set(sheet, used);
        return used;
      })
      .finally(() => {
        if (this.usedRangeInFlight.get(sheet) === p) this.usedRangeInFlight.delete(sheet);
      });
    this.usedRangeInFlight.set(sheet, p);
    return p;
  }

  /**
   * Snapshot: a SYNC cache read (RemoteEngineHost semantics). Returns
   * the last async-pulled snapshot, or a name-only fallback while the
   * first pull is in flight. Await-capable save flows MUST await
   * snapshotAsync() first (App's ensureSaveSnapshot does) — serializing
   * the name-only fallback would write every sheet back empty.
   * Snapshot cells are raw INPUTS, not values; values still stream
   * through readCell/readRange.
   */
  override snapshot(): WorkbookSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    void this.snapshotAsync()
      .then(() => {
        if (!this.disposed) this.emitFill({ type: 'recalcComplete' });
      })
      .catch(() => undefined);
    return {
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      sheets: (this.sheetNameCache ?? []).map((name) => ({ name, cells: [] })),
    };
  }

  /** Async snapshot (deduped, cached until a mutation/event invalidates). */
  async snapshotAsync(): Promise<WorkbookSnapshot> {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    if (this.snapshotInFlight) return this.snapshotInFlight;
    const gen = this.fillGeneration;
    const p: Promise<WorkbookSnapshot> = this.call('snapshot', this.bridge().snapshot())
      .then((snap) => {
        if (!this.disposed && gen === this.fillGeneration) {
          this.cachedSnapshot = snap;
          this.sheetNameCache = snap.sheets.map((s) => s.name);
        }
        return snap;
      })
      .finally(() => {
        if (this.snapshotInFlight === p) this.snapshotInFlight = null;
      });
    this.snapshotInFlight = p;
    return p;
  }

  /** Await until all queued background fills settle (tests + harness). */
  async whenReadsIdle(): Promise<void> {
    await Promise.all([
      ...this.pendingCellFetches.values(),
      ...this.pendingRangeFetches.values(),
      ...this.usedRangeInFlight.values(),
    ]);
    // Fill notifications are frame-coalesced; an idle reader is a
    // delivery point — flush synchronously so awaiters observe the
    // same events a painted frame would have delivered.
    this.flushFillEvents();
  }

  override sheetNames(): string[] {
    return this.sheetNameCache ? [...this.sheetNameCache] : [];
  }

  override getView(): TypedView {
    return this.ipcView;
  }

  override getAuthorizer(): Authorizer {
    // Compatibility stub: enforcement happens in the main-process host
    // (authorize() on every op + the synced protection policy).
    return this.stubAuthorizer;
  }

  override setHiddenCheck(): void {
    // No-op: hidden-cell enforcement lives in the main-process host.
  }

  override setWorkerBackendFactory(_factory: WorkerBackendFactory): void {
    // No-op (issue #58): the parallel-recalc worker pool lives in the
    // MAIN-process host (options reach it via the setParallelRecalcOptions
    // command over this bridge). The base implementation would touch
    // this.workbook — materializing the deferred local workbook this
    // adapter deliberately never builds.
  }

  // -- Execute-reply seeding (issue #58: one roundtrip per edit) -----------

  /**
   * Seed the progressive caches from an execute reply's values: the
   * main-process dispatch already computed the edited cell and its
   * dependents, so their fresh values/formula states are authoritative
   * — no readCell/readRange re-fetch follows the edit. Returns the
   * edited cell's reply entry (for the snapshot patch), or undefined
   * when the reply carried no values (older main build, or the change
   * set exceeded the reply cap — the event/fill path then applies,
   * exactly as before this change).
   */
  private seedFromReply(
    res: IpcExecuteReply,
    command: EngineCommand,
  ): IpcExecuteReplyValue | undefined {
    const values = res.values;
    if (!values || values.length === 0) return undefined;
    const filled: CellRef[] = [];
    let editedEntry: IpcExecuteReplyValue | undefined;
    for (const entry of values) {
      const k = cellKey(entry.ref);
      this.valueCache.set(k, entry.value);
      if (entry.formulaKnown) {
        // The edited cell's formula state was read back authoritatively
        // in main (issue #43 machinery): present, or provably absent.
        if (entry.formula !== undefined) this.formulaCache.set(k, entry.formula);
        else this.formulaCache.delete(k);
        this.formulaResolved.add(k);
      }
      // The engine confirmed this cell: the optimistic overlay (if any)
      // is superseded, and any fill still in flight for it is stale —
      // bump its epoch so the fill drops its payload (and its requeue
      // check then sees the seeded cache entry and stays quiet).
      this.optimistic.delete(k);
      this.cellEpochs.set(k, (this.cellEpochs.get(k) ?? 0) + 1);
      this.usedRangeCache.delete(entry.ref.sheet);
      filled.push(entry.ref);
      if (
        (command.cmd === 'setCell' || command.cmd === 'setFormula') &&
        k === cellKey(command.ref)
      ) {
        editedEntry = entry;
      }
    }
    // User-paced, order-sensitive — same immediate delivery as the
    // optimistic emit (the grid repaints the confirmed values now,
    // without waiting for the main→renderer event to invalidate and a
    // background fill to re-stream them).
    if (filled.length > 0) this.emitLocal({ type: 'cellsChanged', refs: filled });
    return editedEntry;
  }

  /**
   * Apply a settled cell edit to the cached snapshot IN PLACE instead
   * of discarding the whole snapshot (issue #58): the edit's input is
   * known exactly — the command's literal for setCell, the reply's
   * normalized formula for setFormula — so the patched snapshot equals
   * what a re-pull would return for the edited cell, and every other
   * cell's pulled state stands. Returns false when there is nothing
   * safe to patch (no cached snapshot, sheet unknown, or a setFormula
   * whose reply carried no formula) — the caller then falls back to
   * invalidating the snapshot, today's behavior.
   */
  private patchSnapshotForEdit(
    command: Extract<EngineCommand, { cmd: 'setCell' } | { cmd: 'setFormula' }>,
    editedEntry: IpcExecuteReplyValue,
  ): boolean {
    const snap = this.cachedSnapshot;
    if (!snap) return false;
    const sheet = snap.sheets.find((s) => s.name === command.ref.sheet);
    if (!sheet) return false;
    const { row, col } = command.ref;
    const at = sheet.cells.findIndex((c) => c.ref.row === row && c.ref.col === col);
    if (command.cmd === 'setCell' && command.value === null) {
      // Clearing a cell removes it from the engine's input table: a
      // fresh snapshot would not list it.
      if (at >= 0) sheet.cells.splice(at, 1);
      return true;
    }
    if (command.cmd === 'setFormula' && editedEntry.formula === undefined) return false;
    const input: CellInput =
      command.cmd === 'setCell' ? command.value : (editedEntry.formula as CellInput);
    if (at >= 0) {
      sheet.cells[at] = { ref: command.ref, input };
    } else {
      // Keep the sheet's cells in (row, col) order, as a fresh pull is.
      let pos = sheet.cells.length;
      for (let i = 0; i < sheet.cells.length; i++) {
        const c = sheet.cells[i]!.ref;
        if (c.row > row || (c.row === row && c.col > col)) {
          pos = i;
          break;
        }
      }
      sheet.cells.splice(pos, 0, { ref: command.ref, input });
    }
    return true;
  }

  override subscribe(listener: EngineEventListener): () => void {
    this.ipcListeners.add(listener);
    return () => {
      this.ipcListeners.delete(listener);
    };
  }

  override dispose(): void {
    this.disposed = true;
    if (this.offBridgeEvents) this.offBridgeEvents();
    this.offBridgeEvents = null;
    this.ipcListeners.clear();
    this.resetProgressiveState();
  }

  // -- Event intake (main → renderer) ---------------------------------------

  /**
   * One engine event from the main-process host. Fans out untouched to
   * subscribers (scoped repaints) and maintains the progressive caches:
   * invalidation is scoped to exactly the refs an event carries.
   */
  private onEngineEvent(event: EngineEvent): void {
    if (this.disposed) return;
    // Any externally-driven change makes a pulled snapshot stale.
    if (event.type === 'cellsChanged' || event.type === 'sheetAdded' || event.type === 'sheetRemoved') {
      this.cachedSnapshot = null;
    }
    switch (event.type) {
      case 'cellsChanged': {
        for (const ref of event.refs) {
          // The engine's value now owns this cell: drop the cached value
          // (it re-streams on demand). A bridge cellsChanged naming a
          // cell is also the engine's CONFIRMATION of any optimistic
          // entry for it: the main-process host emits the event from
          // inside the mutation itself (EngineWorkbook.onValuesChanged
          // fires synchronously within execute), so by the time the
          // event crosses IPC the engine already holds the new value.
          // The optimistic entry must therefore clear HERE — an ordinary
          // setCell/setFormula execute emits cellsChanged ONLY (no
          // recalcComplete follows; that event is reserved for explicit
          // recalcs / workbook swaps), so waiting for recalcComplete
          // pinned a formula→formula edit's display to the overlay's
          // pre-edit value forever: reads served the overlay, never
          // queued a fill, and the grid never refreshed (defect E3,
          // W10 R2 formula leg). Literal edits masked it — their
          // overlay value IS the new value. Clearing before emitLocal
          // means the repaint this event triggers reads a cache miss
          // and queues the post-edit fill.
          const k = cellKey(ref);
          this.valueCache.delete(k);
          this.formulaCache.delete(k);
          this.formulaResolved.delete(k);
          this.optimistic.delete(k);
          // Fills issued before this change are stale for this cell (D2).
          this.cellEpochs.set(k, (this.cellEpochs.get(k) ?? 0) + 1);
          this.usedRangeCache.delete(ref.sheet);
        }
        break;
      }
      case 'recalcComplete': {
        // Calc finished: unconfirmed edits are settled by definition —
        // clear the optimistic overlay wholesale (the engine owns the
        // true values). Cached VALUES stay: cellsChanged events already
        // invalidated exactly what changed; nothing else is repainted.
        this.optimistic.clear();
        break;
      }
      case 'sheetAdded': {
        if (this.sheetNameCache && !this.sheetNameCache.includes(event.name)) {
          this.sheetNameCache = [...this.sheetNameCache, event.name];
        }
        break;
      }
      case 'sheetRemoved': {
        if (this.sheetNameCache) {
          this.sheetNameCache = this.sheetNameCache.filter((n) => n !== event.name);
        }
        this.usedRangeCache.delete(event.name);
        break;
      }
    }
    this.emitLocal(event);
  }

  private emitLocal(event: EngineEvent): void {
    // Immediate emits (optimistic edits, main→renderer events) keep
    // their order relative to any coalesced fill batch queued before
    // them: the batch is delivered first.
    this.flushFillEvents();
    this.deliverLocal(event);
  }

  private deliverLocal(event: EngineEvent): void {
    for (const l of [...this.ipcListeners]) {
      try {
        l(event);
      } catch {
        // A failing listener must not break the host.
      }
    }
  }

  /**
   * Queue a fill-originated notification for frame-coalesced delivery
   * (see the coalescing note on the pending-state fields). cellsChanged
   * refs merge by cell; recalcComplete collapses to one tick. The first
   * queued event schedules the flush on the next animation frame (or a
   * 0 ms timer where rAF is unavailable, e.g. a hidden window).
   */
  private emitFill(event: EngineEvent): void {
    if (this.disposed) return;
    if (event.type === 'cellsChanged') {
      for (const ref of event.refs) this.pendingFillRefs.set(cellKey(ref), ref);
    } else if (event.type === 'recalcComplete') {
      this.pendingFillRecalc = true;
    } else {
      this.deliverLocal(event);
      return;
    }
    if (this.fillFlushHandle !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      this.fillFlushHandle = requestAnimationFrame(() => {
        this.fillFlushHandle = null;
        this.flushFillEvents();
      });
    } else {
      this.fillFlushHandle = setTimeout(() => {
        this.fillFlushHandle = null;
        this.flushFillEvents();
      }, 0);
    }
  }

  /** Deliver the coalesced fill batch now (frame, idle, or pre-immediate). */
  private flushFillEvents(): void {
    this.cancelFillFlush();
    if (this.pendingFillRefs.size > 0) {
      const refs = [...this.pendingFillRefs.values()];
      this.pendingFillRefs.clear();
      this.deliverLocal({ type: 'cellsChanged', refs });
    }
    if (this.pendingFillRecalc) {
      this.pendingFillRecalc = false;
      this.deliverLocal({ type: 'recalcComplete' });
    }
  }

  private cancelFillFlush(): void {
    if (this.fillFlushHandle === null) return;
    if (typeof cancelAnimationFrame === 'function' && typeof requestAnimationFrame === 'function') {
      cancelAnimationFrame(this.fillFlushHandle as number);
    } else {
      clearTimeout(this.fillFlushHandle as ReturnType<typeof setTimeout>);
    }
    this.fillFlushHandle = null;
  }
}

/**
 * TypedView backed by the IPC adapter — GENUINELY SYNCHRONOUS, mirroring
 * RemoteView: every read serves the host's read-through cache (optimistic
 * overlay → cached value/formula → EMPTY placeholder on a miss, with a
 * deduped background IPC fill queued behind the miss). This is the
 * surface FormulaBar/Grid/Ribbon/features consume; returning a Promise
 * here is what crashed the desktop boot.
 */
class IpcView extends TypedView {
  constructor(private readonly host: IpcEngineHost) {
    // The local workbook is never used; every method is overridden.
    super(undefined as never);
  }

  override readCell(ref: CellRef): TypedCell {
    const h = this.host;
    const value = h.readCell(ref);
    const formula = h.optimisticEntry(ref)?.formula ?? h.cachedFormula(ref);
    return formula !== undefined ? { ref, value, formula } : { ref, value };
  }

  override readRange(range: RangeRef): TypedCell[][] {
    const h = this.host;
    const values = h.readRange(range);
    return values.map((row, ri) =>
      row.map((value, ci) => {
        const ref = { sheet: range.sheet, row: range.startRow + ri, col: range.startCol + ci };
        const formula = h.optimisticEntry(ref)?.formula ?? h.cachedFormula(ref);
        return formula !== undefined ? { ref, value, formula } : { ref, value };
      }),
    );
  }

  override readRangeValues(range: RangeRef): TypedValue[][] {
    return this.host.readRange(range);
  }

  override usedRange(sheet: string): RangeRef | null {
    return this.host.getUsedRange(sheet);
  }

  override readSheet(sheet: string): TypedValue[][] {
    return this.host.readSheet(sheet);
  }
}
