/**
 * Remote engine host: the web app's EngineHost API backed by the API
 * gateway (spec a/b/c). Enabled when the app is built with
 * VITE_GATEWAY_URL.
 *
 * Every operation goes web app → gateway (JWT auth + rate limiting) →
 * engine service → engine. The gateway is the auth point; the engine
 * service is the enforcement point (authorize() on every access).
 *
 * Transport (Cycle 10, Phase 3): EVERYTHING is async. There is no
 * synchronous network call left in this module (the Phase 2 sync-XHR
 * transitional bridge is gone — sync XHR froze the tab for ~40s on a
 * P95 open and is now deleted from GatewayClient):
 *
 *  - VIEW (render-time reads): served by RemoteView's read-through cache.
 *    Misses queue into RangeReadBatcher / UsedRangeDeduper (bulkReads.ts)
 *    which coalesce a render storm into a few bulk range reads — Phase 2
 *    measured ~548 range + ~566 usedRange reads on a P95 first paint;
 *    the batcher merges those into O(few) transport calls regardless of
 *    which component (Grid/FormulaBar/Ribbon/undo — all read through
 *    getView()) issued them. Misses fail soft (loading state, never wrong
 *    data) and a repaint tick fires when values land.
 *  - MUTATION (edits): commitCell's setCell/setFormula flow through
 *    executeRoutedAsync → routedEdit.ts — measureCalcChain + the pure
 *    routeRecalc policy (mirror precondition enforced: the local mirror
 *    is never consulted when the mode is 'no-mirror'), optimistic display
 *    per HYBRID-CONSISTENCY.md §7, write-through ops, server-wins acks,
 *    visible rollback on rejection.
 *
 * SYNC-SIGNATURE / ASYNC-RUNTIME: overrides keep the base class's
 * synchronous signatures (same convention as ipcEngine.ts) but execute()
 * returns a Promise at runtime. Await-capable callers (App commit path)
 * must `await` it; awaiting a genuine sync value is a no-op so one call
 * site serves every host type.
 */
import {
  Authorizer,
  ENGINE_PROTOCOL_VERSION,
  EngineHost,
  TypedView,
  allowAllPolicy,
  type AuthContext,
  type CellRef,
  type EngineCommand,
  type EngineEvent,
  type EngineEventListener,
  type CommandResult,
  type HybridRecalcConfig,
  type RangeRef,
  type TypedCell,
  type TypedValue,
  type WorkbookSnapshot,
} from '@icecream-sheets/engine';
import { GatewayClient } from './gatewayClient';
import {
  GatewayEngineTransport,
  mergeLoadChunks,
  streamedCellsFromChunk,
  type AsyncEngineTransport,
  type EngineCellRead,
  type EngineLoadResult,
  type EngineRangeRead,
  type ProgressiveLoadChunk,
} from './engineTransport';
import {
  RangeReadBatcher,
  UsedRangeDeduper,
  cellFromBulk,
  mergeRangesForBulkRead,
  type RangeReadResult,
} from './bulkReads';
import {
  OptimisticEditSession,
  executeRoutedEdit,
  refKey,
  resolveHybridThresholds,
  type RoutedEditOutcome,
} from './routedEdit';
import { getFirstPageReport, markFirstPagePainted, markFirstValuesArrived } from './firstPagePerf';
import { SignedEngineTransport } from './signedEngineTransport';
import { EditInFlightTracker } from './saveInterlock';
import type {
  CollabTransport,
  DeltaCell,
  DeltaOrigin,
  SessionEventData,
} from './collabTransport';

/** The engine's empty-cell value (TypedValue null kind). */
const EMPTY: TypedValue = { kind: 'null', value: null };

function saneCell(ref: CellRef): CellRef {
  return {
    sheet: ref.sheet,
    row: Number.isInteger(ref.row) ? ref.row : 0,
    col: Number.isInteger(ref.col) ? ref.col : 0,
  };
}

function saneRange(range: RangeRef): RangeRef {
  const startRow = Number.isInteger(range.startRow) ? range.startRow : 0;
  const startCol = Number.isInteger(range.startCol) ? range.startCol : 0;
  const endRow = Number.isInteger(range.endRow) ? range.endRow : startRow;
  const endCol = Number.isInteger(range.endCol) ? range.endCol : startCol;
  return { sheet: range.sheet, startRow, startCol, endRow, endCol };
}

/** The engine's "this sheet doesn't exist" error — mid-swap/open noise. */
export function isUnknownSheetError(e: unknown): boolean {
  return e instanceof Error && /Unknown sheet/.test(e.message);
}

interface RemoteViewOpts {
  /** Repaint tick (host emits it after values land). */
  notify: () => void;
  /** The routed-edit session: optimistic display rides over the cache. */
  session: () => OptimisticEditSession;
  /** The first sheet's name while an open is hydrating (first-page mark). */
  firstSheetName: () => string | null;
  /**
   * Read gate (Phase 2 fix): false until the host is bound to a server
   * session (handshake opened one, a load introduced/completed one, a
   * reset completed, a rehydrate verified one). While false, NO view
   * fetch may touch the network — there is no session to read from,
   * and in signed mode every such call 401s (the boot storm).
   */
  readsAllowed: () => boolean;
}

/**
 * TypedView backed by the async transport, with a read-through cache.
 *
 * The grid's render-path reads populate the cache; per-cell reads are
 * served from it instead of one round-trip per cell, and the first-paint
 * storm collapses through the batcher: many small overlapping range
 * requests issued in the same tick become a few bulk transport reads
 * (Phase 2: ~1,100 small reads ≈ 5.7s max task on P95).
 *
 * Render-path reads NEVER throw and NEVER touch the network
 * synchronously: a miss queues a batched fetch and returns the
 * cached/empty region immediately (loading state). Await-capable callers
 * use the *Async methods. A failed key backs off 2s so a render storm
 * can't hammer the gateway with doomed retries.
 */
/**
 * Windowed-retention activation (Cycle 10 closure W16): when a single
 * open streams more cells than this, the view cache switches to a
 * bounded window (see setWindowedRetention). Measured basis: full
 * retention of a 1.8 M-cell open costs ~450 MB of tab heap and works;
 * 6.5 M cells costs >1.6 GB and the renderer dies mid-ingest
 * (perf-evaluation.md §7 defect 5). The bound sits between the two.
 */
export const WINDOWED_RETENTION_CELL_THRESHOLD = 2_500_000;
/** Cells kept in the view cache once windowed retention is active. */
export const WINDOWED_CACHE_CAP = 300_000;

class RemoteView extends TypedView {
  private readonly cellCache = new Map<string, TypedCell>();
  /**
   * Cells whose FORMULA STATE is authoritatively known (issue #43): an
   * authoritative bulk read (seedBulk), an explicit formula seed, or an
   * SSE delta settled the cell, so its cached entry either carries the
   * formula or the cell provably has none. Stream seeds deliberately do
   * NOT mark a cell (the progressive stream is a values-first paint
   * payload), and a cache hit alone therefore proves nothing about the
   * formula — readCellAsync falls through to a one-cell authoritative
   * read for unmarked cells instead of trusting the cache. Cleared with
   * the cache; evictions drop their entry.
   */
  private readonly formulaResolved = new Set<string>();
  /**
   * Formula cells saved WITHOUT cached values (stream marks them
   * `pending`): nothing real to paint until the engine calc lands. They
   * are NEVER seeded as values — a pending cell reads as unloaded
   * (loading state), never as a final-looking blank/0. A live value
   * arriving for the ref clears the mark.
   *
   * W16: stored per sheet as PACKED numeric keys (row * 16384 + col)
   * instead of one "sheet:row:col" string per cell — at P99's ~1.7 M
   * pending cells the string set alone cost ~150 MB of tab heap.
   */
  private readonly pendingCalc = new Map<string, Set<number>>();
  /**
   * Bounded streamed-cell retention (W16): for no-mirror workbooks the
   * client is a renderer and the server is the source of truth, so the
   * pushed-cell cache does not need to hold the whole workbook — a
   * windowed cache with FIFO eviction suffices, because an evicted
   * cell is simply a cache miss on next render and re-reads through
   * the existing batched read path (readCell/readRange queue a bulk
   * fetch and repaint on land). Mirror workbooks never enable this:
   * they keep full retention exactly as before.
   */
  private windowedRetention = false;
  private cacheCap = WINDOWED_CACHE_CAP;
  private readonly batcher: RangeReadBatcher;
  private readonly usedRanges: UsedRangeDeduper;
  private static readonly FAIL_BACKOFF_MS = 2000;
  private readonly failAt = new Map<string, number>();
  private firstValuesMarked = false;
  /**
   * Global failure breaker (Phase 2 fix, completes Worker F's F3): the
   * per-key backoff cannot bound a failure storm on its own — a render
   * walk keeps minting FRESH keys (new rows/cols/sheets), each allowed
   * one doomed fetch (8,195 requests in ~65 s in the unbound boot
   * state). Any view-fetch failure now suppresses ALL view fetches for
   * an exponential window (500 ms doubling to a 15 s cap); a success —
   * or the host reporting the read gate lifted — resets it. Combined
   * with the gate, the unbound state produces ZERO requests, and a
   * dead engine mid-session produces ~1 batch per window.
   */
  private failStreak = 0;
  private downUntil = 0;
  /**
   * One-shot timer armed for when the breaker window elapses (File-2
   * defect D2): without it, nothing re-renders when the breaker lifts —
   * notify only fires when a fetch SETTLES, and no fetch can be queued
   * while the breaker is down — so a sheet first rendered inside the
   * window (e.g. during the post-open checkpoint, when superseded-
   * workbook reads return the engine's item-H 404/409 "absent"
   * contract answers) stayed blank for the whole visit. On lift we
   * nudge the render path once; reads still missing re-queue through
   * the normal paths.
   */
  private liftTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly transport: AsyncEngineTransport,
    private readonly opts: RemoteViewOpts,
  ) {
    // The local workbook is never used; every method is overridden.
    super(undefined as never);
    this.batcher = new RangeReadBatcher(
      (range) => {
        if (!this.opts.readsAllowed() || this.transportDown()) {
          // Gated (no session bound yet) or backing off: fail soft with
          // an empty result — the region stays in the loading state and
          // a later read re-queues once reads are allowed again.
          return Promise.resolve({ values: [], formulas: [] });
        }
        return this.transport.readRange(saneRange(range)).then(
          (r) => {
            this.noteFetchOk();
            return { values: r.values, formulas: r.formulas };
          },
          (e: unknown) => {
            this.noteFetchFailed();
            throw e;
          },
        );
      },
      (range, result) => this.seedBulk(range, result),
      () => this.opts.notify(),
    );
    this.usedRanges = new UsedRangeDeduper((sheet) => {
      if (!this.opts.readsAllowed() || this.transportDown()) {
        // REJECT, never resolve null: the deduper caches settled results,
        // and a gated/down non-answer cached as "no used range" would
        // pin the sheet blank until invalidation (File-2 defect D2).
        // The rejection is not cached (see UsedRangeDeduper.get), so a
        // later read retries for real.
        return Promise.reject(new Error('used-range read gated'));
      }
      return this.transport.usedRange(sheet).then(
        (r) => {
          this.noteFetchOk();
          return r;
        },
        () => {
          this.noteFetchFailed();
          return null;
        },
      );
    });
  }

  /** True while the global failure breaker is suppressing fetches. */
  private transportDown(): boolean {
    return Date.now() < this.downUntil;
  }

  private noteFetchOk(): void {
    this.failStreak = 0;
    this.downUntil = 0;
    if (this.liftTimer !== null) {
      clearTimeout(this.liftTimer);
      this.liftTimer = null;
      // A success while a lift is pending proves reads flow again —
      // but the render the lift was guarding is still owed: a sheet
      // first rendered inside the breaker window queued nothing (or
      // had its seed wiped by a session 'load' event), and this
      // success may be an unrelated in-flight fetch whose own settle
      // path does not re-render it. Fire the lift NOW instead of
      // disarming it silently (Wave-C W5: in join bursts an
      // interleaved success otherwise left the active sheet blank
      // for the whole visit; only a tab switch revived it). The
      // notify is an idempotent repaint tick.
      try {
        this.opts.notify();
      } catch {
        // A listener error must not break the fetch path.
      }
    }
  }

  private noteFetchFailed(): void {
    this.failStreak++;
    const windowMs = Math.min(500 * 2 ** Math.min(this.failStreak - 1, 5), 15_000);
    this.downUntil = Date.now() + windowMs;
    this.scheduleLiftNotify();
  }

  /** Arm the one-shot breaker-lift nudge (see {@link liftTimer}). */
  private scheduleLiftNotify(): void {
    if (this.liftTimer !== null) return;
    const delay = Math.max(0, this.downUntil - Date.now());
    this.liftTimer = setTimeout(() => {
      this.liftTimer = null;
      if (this.transportDown()) {
        // A later failure extended the window; wait the remainder out.
        this.scheduleLiftNotify();
        return;
      }
      try {
        this.opts.notify();
      } catch {
        // A listener error must not break the retry chain.
      }
    }, delay);
  }

  /**
   * The host bound a session (or a load is starting): clear every
   * failure suppression so post-bind reads flow immediately.
   */
  noteGateLifted(): void {
    this.failAt.clear();
    this.noteFetchOk();
  }

  /** Fetch suppression snapshot (diagnostics + request-count proofs). */
  fetchGateStats(): { failStreak: number; downUntil: number; readsAllowed: boolean } {
    return {
      failStreak: this.failStreak,
      downUntil: this.downUntil,
      readsAllowed: this.opts.readsAllowed(),
    };
  }

  /** Transport-layer read accounting (Phase 4: count first-paint reads). */
  viewportReadStats(): { requestedReads: number; transportCalls: number; usedRangeTransportCalls: number } {
    return {
      requestedReads: this.batcher.stats.requestedReads,
      transportCalls: this.batcher.stats.transportCalls,
      usedRangeTransportCalls: this.usedRanges.transportCalls + this.batcher.stats.usedRangeTransportCalls,
    };
  }

  /** Queue a bulk read for a viewport (with a small scroll margin). */
  prefetchViewport(sheet: string, range: RangeRef, marginRows = 8): void {
    if (!this.opts.readsAllowed() || this.transportDown()) return;
    const used = this.usedRanges.cached(sheet) ?? undefined;
    const startRow = Math.max(0, range.startRow - marginRows);
    const endRow = used ? Math.min(used.endRow, range.endRow + marginRows) : range.endRow + marginRows;
    this.batcher.queueRange({ sheet, startRow, startCol: range.startCol, endRow, endCol: range.endCol });
  }

  /** Await until all queued/in-flight fetches settle (tests, harness). */
  whenReadsIdle(): Promise<void> {
    return this.batcher.whenIdle();
  }

  /** Reset the first-page mark for a new open (re-arms firstValues marking). */
  resetFirstPageMarks(): void {
    this.firstValuesMarked = false;
  }

  clearCache(): void {
    this.cellCache.clear();
    this.formulaResolved.clear();
    this.pendingCalc.clear();
    this.usedRanges.invalidate();
  }

  evict(ref: CellRef): void {
    this.cellCache.delete(refKey(ref));
    this.formulaResolved.delete(refKey(ref));
  }

  /** Pack a cell position into one number (Excel column bound 16384). */
  private static packedKey(row: number, col: number): number {
    return row * 16384 + col;
  }

  /**
   * Copy of the pending-calc marks (W16): the host preserves them
   * across the terminal reset of a streamed load. That reset wipes the
   * view cache (stale previous-workbook state must not linger), and the
   * App's terminal re-seed used to restore the marks from the retained
   * accumulation — but a dropped accumulation (W16 bound) carries no
   * cells to re-seed from, and a pending cell must never degrade to a
   * final-looking blank just because its mark was lost.
   */
  snapshotPending(): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    for (const [sheet, set] of this.pendingCalc) out.set(sheet, new Set(set));
    return out;
  }

  /** Replace the pending-calc marks with a snapshotPending() copy. */
  restorePending(marks: Map<string, Set<number>>): void {
    this.pendingCalc.clear();
    for (const [sheet, set] of marks) this.pendingCalc.set(sheet, new Set(set));
  }

  private pendingAdd(sheet: string, row: number, col: number): void {
    let set = this.pendingCalc.get(sheet);
    if (!set) {
      set = new Set<number>();
      this.pendingCalc.set(sheet, set);
    }
    set.add(RemoteView.packedKey(row, col));
  }

  private pendingDelete(sheet: string, row: number, col: number): void {
    this.pendingCalc.get(sheet)?.delete(RemoteView.packedKey(row, col));
  }

  /**
   * Enable/disable windowed retention (see the field note). Enabling
   * trims the cache to the cap immediately; disabling restores full
   * retention for subsequent seeds (already-evicted cells re-read on
   * demand either way).
   */
  setWindowedRetention(on: boolean, cap = WINDOWED_CACHE_CAP): void {
    this.windowedRetention = on;
    this.cacheCap = cap;
    if (on) this.trimCache();
  }

  isWindowedRetention(): boolean {
    return this.windowedRetention;
  }

  cachedCellCount(): number {
    return this.cellCache.size;
  }

  /** Insert into the view cache (LRU-refresh + windowed eviction). */
  private cacheSet(key: string, cell: TypedCell): void {
    if (this.cellCache.has(key)) this.cellCache.delete(key);
    this.cellCache.set(key, cell);
    if (this.windowedRetention) this.trimCache();
  }

  private trimCache(): void {
    if (this.cellCache.size <= this.cacheCap) return;
    for (const k of this.cellCache.keys()) {
      this.cellCache.delete(k);
      if (this.cellCache.size <= this.cacheCap) break;
    }
  }

  /** Seed one authoritative cell (server acks, optimistic confirmations). */
  seedCell(ref: CellRef, value: TypedValue, formula?: string): void {
    const key = refKey(ref);
    this.pendingDelete(ref.sheet, ref.row, ref.col);
    const prev = this.cellCache.get(key);
    this.cacheSet(key, {
      ref,
      value,
      formula: formula ?? prev?.formula,
    });
    // An explicit formula in an authoritative seed settles the cell's
    // formula state (issue #43); a value-only seed preserves whatever
    // was known and settles nothing.
    if (formula !== undefined) this.formulaResolved.add(key);
  }

  /** TRUE while a cell's real value awaits the engine calc (see above). */
  isPendingCalc(ref: CellRef): boolean {
    return this.pendingCalc.get(ref.sheet)?.has(RemoteView.packedKey(ref.row, ref.col)) ?? false;
  }

  pendingCalcCount(): number {
    let n = 0;
    for (const set of this.pendingCalc.values()) n += set.size;
    return n;
  }

  /**
   * Seed PUSHED stored values from the progressive load stream
   * (the file's own cached values — first paint consumes these, no
   * engine build and no pull reads required). Also stamps the
   * first-values perf mark when the first sheet's data lands.
   */
  seedStreamed(
    sheet: string,
    cells: Array<{ row: number; col: number; value: TypedValue; formula?: string; pending?: boolean }>,
  ): void {
    for (const c of cells) {
      if (c.pending) {
        // Display-before-graph caveat: formula without a cached value —
        // mark pending, paint NOTHING as final. The loading state is the
        // honest representation until the calc lands.
        this.pendingAdd(sheet, c.row, c.col);
        continue;
      }
      this.seedCell({ sheet, row: c.row, col: c.col }, c.value, c.formula);
    }
    const first = this.opts.firstSheetName();
    if (first && sheet === first && !this.firstValuesMarked) {
      this.firstValuesMarked = true;
      markFirstValuesArrived();
    }
  }

  private seedBulk(range: RangeRef, result: RangeReadResult): void {
    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const cell = cellFromBulk(range, result, r, c);
        if (cell) {
          // A live read is real data: any pending-calc mark for the cell
          // is settled by definition.
          this.pendingDelete(cell.ref.sheet, cell.ref.row, cell.ref.col);
          this.cacheSet(refKey(cell.ref), cell);
          // The bulk payload is authoritative for formulas too (it
          // carries a formulas array): present or provably absent.
          this.formulaResolved.add(refKey(cell.ref));
        }
      }
    }
    const first = this.opts.firstSheetName();
    if (first && range.sheet === first && !this.firstValuesMarked) {
      this.firstValuesMarked = true;
      markFirstValuesArrived();
    }
  }

  private backingOff(key: string): boolean {
    const last = this.failAt.get(key);
    return last !== undefined && Date.now() - last < RemoteView.FAIL_BACKOFF_MS;
  }

  private markFailed(key: string): void {
    this.failAt.set(key, Date.now());
  }

  override readCell(ref: CellRef): TypedCell {
    const key = refKey(ref);
    const optimistic = this.opts.session().optimisticValue(ref);
    if (optimistic) return { ref, value: optimistic };
    const cached = this.cellCache.get(key);
    if (cached) return cached;
    if (this.opts.readsAllowed() && !this.transportDown() && !this.backingOff(`cell:${key}`)) {
      // Row-band prefetch: render scans walk row-major — one bulk read
      // for the row band instead of one per cell. Concurrent misses in
      // the same tick coalesce in the batcher anyway.
      const used = this.usedRanges.cached(ref.sheet);
      if (used && ref.col >= used.startCol && ref.col <= used.endCol) {
        this.batcher.queueRange({
          sheet: ref.sheet,
          startRow: ref.row,
          startCol: used.startCol,
          endRow: ref.row,
          endCol: used.endCol,
        });
      } else {
        this.batcher.queueRange({ sheet: ref.sheet, startRow: ref.row, startCol: ref.col, endRow: ref.row, endCol: ref.col });
        this.usedRanges.warm(ref.sheet);
      }
    }
    return { ref, value: EMPTY };
  }

  override readRange(range: RangeRef): TypedCell[][] {
    const r = saneRange(range);
    const rows: TypedCell[][] = [];
    let missing = false;
    for (let row = r.startRow; row <= r.endRow; row++) {
      const out: TypedCell[] = [];
      for (let col = r.startCol; col <= r.endCol; col++) {
        const ref = { sheet: r.sheet, row, col };
        const optimistic = this.opts.session().optimisticValue(ref);
        const cached = optimistic ? { ref, value: optimistic } : this.cellCache.get(refKey(ref));
        if (!cached) missing = true;
        out.push(cached ?? { ref, value: EMPTY });
      }
      rows.push(out);
    }
    // One bulk fetch for the whole requested region (coalesced with any
    // other queued ranges this tick); a repaint tick lands when it fills.
    if (
      missing &&
      this.opts.readsAllowed() &&
      !this.transportDown() &&
      !this.backingOff(`range:${r.sheet}:${r.startRow}`)
    ) {
      this.batcher.queueRange(r);
    }
    return rows;
  }

  override readRangeValues(range: RangeRef): TypedValue[][] {
    return this.readRange(range).map((row) => row.map((cell) => cell.value));
  }

  override usedRange(sheet: string): RangeRef | null {
    const cached = this.usedRanges.cached(sheet);
    if (cached !== undefined) return cached;
    if (this.opts.readsAllowed() && !this.transportDown()) this.usedRanges.warm(sheet);
    return null;
  }

  override readSheet(sheet: string): TypedValue[][] {
    const used = this.usedRanges.cached(sheet);
    if (!used) {
      this.usedRanges.warm(sheet);
      return [];
    }
    return this.readRangeValues(used);
  }

  // -- await-capable surface -----------------------------------------------

  /** Async one-cell read (batched through the same bulk pipeline). */
  async readCellAsync(ref: CellRef): Promise<EngineCellRead> {
    const cell = this.readCell(ref);
    // Issue #43: a cached VALUE is not proof about the formula — a
    // stream-seeded cell may carry no formula in cache simply because
    // the stream never shipped it. Only a resolved cell may answer
    // from cache; anything else falls through to the authoritative
    // one-cell bulk read (whose payload settles the formula state).
    const optimistic = this.opts.session().optimisticValue(ref);
    if (optimistic) return { value: cell.value, ...(cell.formula ? { formula: cell.formula } : {}) };
    if (cell.value !== EMPTY && this.formulaResolved.has(refKey(ref))) {
      return { value: cell.value, ...(cell.formula ? { formula: cell.formula } : {}) };
    }
    // NOTE: a proper 1-cell RangeRef — this call site previously passed
    // saneCell(ref) cast to RangeRef, whose missing startRow/endRow
    // bounds silently no-oped the batcher's sink seeding (seedBulk
    // loops over the range bounds) and broke its merge/re-slice math.
    const cellRange: RangeRef = {
      sheet: ref.sheet, startRow: ref.row, startCol: ref.col, endRow: ref.row, endCol: ref.col,
    };
    const res = await this.batcher.readRangeNow(cellRange).catch(() => null);
    const got = res ? cellFromBulk(cellRange, res, ref.row, ref.col) : undefined;
    return got ? { value: got.value, ...(got.formula ? { formula: got.formula } : {}) } : { value: cell.value };
  }

  /** Async range read (one merged bulk fetch). */
  async readRangeAsync(range: RangeRef): Promise<EngineRangeRead> {
    const res = await this.batcher.readRangeNow(saneRange(range));
    return res;
  }

  /** Async used-range (deduped: concurrent callers share one request). */
  usedRangeAsync(sheet: string): Promise<RangeRef | null> {
    // The fetcher rejects while gated/down so the deduper never caches
    // a non-answer; this public contract still resolves null on failure.
    return this.usedRanges.get(sheet).catch(() => null);
  }
}

export class RemoteEngineHost extends EngineHost {
  private readonly client: GatewayClient;
  private readonly transport: AsyncEngineTransport;
  private readonly remoteView: RemoteView;
  /** Client-side stub: the gateway/service is the enforcement point. */
  private readonly stubAuthorizer = new Authorizer(allowAllPolicy());
  private readonly remoteListeners = new Set<EngineEventListener>();
  private lastSeq = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private disposed = false;
  private opening = false;
  /**
   * Read gate (Phase 2 fix, completes Worker F's F3 residual (a)):
   * until this host is BOUND to a server session, render-path reads,
   * sheet-name refreshes and the /events poll must NOT touch the
   * network. Bound means: a join handshake opened a session for this
   * host (attachCollabTransport's onOpen), a load completed through
   * this host (the load introduces the session in Phase 1 flows), a
   * reset completed, a resync landed, or the idle lifecycle verified a
   * rehydrate (App calls markSessionBound). While a load/reset is IN
   * FLIGHT the gate is open — reads-during-build are a Phase 1 feature
   * (the engine pends them behind its build gate) and the load itself
   * introduces the session they read from. Pre-fix, the unbound boot
   * state stormed the gateway proxy with /sheets + /read calls that
   * could only 401 (8,195 requests in ~65 s in the §10 leg-(a) trace).
   */
  private sessionBound = false;
  private resetting = false;
  /**
   * Phase 2 collab transport (SSE deltas, always on — doc §8). While a
   * transport is attached, structure/session events arrive as SSE
   * `session` events and cell updates as SSE deltas: the /events polling
   * loop MUST NOT run (no polling fallback for service sessions).
   */
  private collabTransport: CollabTransport | null = null;
  private readonly pollMs: number;

  // -- Phase 3 routing state -------------------------------------------------
  /** Local mirror engine (null when the flag says no-mirror / not built). */
  private mirror: EngineHost | null = null;
  /** The CURRENT (server) workbook's cell count; null = unknown → no-mirror. */
  private mirrorCellCount: number | null = null;
  private thresholds: HybridRecalcConfig = resolveHybridThresholds({
    env: (import.meta as unknown as { env?: Record<string, string | undefined> }).env,
  });
  private readonly session = new OptimisticEditSession();
  /**
   * Save-interlock tracker (Cycle 10 closure, additive): wraps EVERY
   * executeRoutedAsync — including structural / non-cell commands that
   * never enter the session — so save paths can ask `hasInFlightEdits()`
   * (the union of this tracker and the session) and defer until settle.
   * See services/saveInterlock.ts.
   */
  private readonly editFlight = new EditInFlightTracker();
  private mirrorInSync = true;
  private firstSheetName: string | null = null;
  /** Last async snapshot (snapshot() is sync-API; this is its cache). */
  private cachedSnapshot: WorkbookSnapshot | null = null;

  constructor(
    client: GatewayClient,
    pollMs = 1500,
    transport?: AsyncEngineTransport,
    /**
     * W16 windowed-retention tuning (tests + diagnostics): when a
     * streamed open passes `threshold` cells, the view cache keeps at
     * most `cap` of them. Defaults are the production bounds.
     */
    private readonly retention: { threshold: number; cap: number } = {
      threshold: WINDOWED_RETENTION_CELL_THRESHOLD,
      cap: WINDOWED_CACHE_CAP,
    },
  ) {
    // The local workbook is never used; every public method is overridden.
    super();
    this.client = client;
    this.pollMs = pollMs;
    this.transport = transport ?? new GatewayEngineTransport(client);
    this.remoteView = new RemoteView(this.transport, {
      notify: () => this.emitRemote({ type: 'recalcComplete' }),
      session: () => this.session,
      firstSheetName: () => this.firstSheetName,
      readsAllowed: () => this.readsAllowed(),
    });
    this.startPolling();
    void this.refreshSheetNames();
  }

  /** True when render-path network reads may fire (see sessionBound). */
  private readsAllowed(): boolean {
    return this.sessionBound || this.opening || this.resetting;
  }

  /** True once this host is bound to a live server session. */
  get isSessionBound(): boolean {
    return this.sessionBound;
  }

  /**
   * Mark this host bound to a live server session: the read gate
   * lifts, the view's failure breaker resets, and a repaint tick fires
   * so regions that rendered as loading state fetch for real. Called
   * on collab-handshake open, load/reset completion, resync, and by
   * the App after a checksum-verified idle rehydrate.
   */
  markSessionBound(): void {
    if (this.sessionBound) {
      this.remoteView.noteGateLifted();
      return;
    }
    this.sessionBound = true;
    this.remoteView.noteGateLifted();
    if (!this.disposed) this.emitRemote({ type: 'recalcComplete' });
  }

  /** Read-gate + breaker snapshot (diagnostics + storm-bound proofs). */
  readGateStats(): { bound: boolean; failStreak: number; downUntil: number; readsAllowed: boolean } {
    const view = this.remoteView.fetchGateStats();
    return { bound: this.sessionBound, failStreak: view.failStreak, downUntil: view.downUntil, readsAllowed: view.readsAllowed };
  }

  /** Start the /events polling loop (legacy/non-SSE modes only). */
  startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
  }

  /** Stop the /events polling loop (SSE live: polling is gone, doc §8). */
  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** True while a collab transport is attached (SSE is the channel). */
  get collabActive(): boolean {
    return this.collabTransport !== null;
  }

  /**
   * Attach the Phase 2 collab transport: routed edits now submit
   * through POST /ops (the transport's durable queue + envelope), SSE
   * deltas feed applyDeltaCells, and /events polling stops. Detach
   * restores the pre-Phase-2 proxied path (local mode untouched — it
   * never uses this host).
   */
  attachCollabTransport(transport: CollabTransport): void {
    this.collabTransport = transport;
    // Bridge ops authored through CollabBridge execute on THIS host —
    // they already flow through submitCommand via executeRoutedAsync,
    // so the bridge broadcast path must not submit them a second time.
    transport.bridgeSubmitEnabled = false;
    // Signed-mode scoping: the collab transport's join handshake owns
    // the session identity (§9) — every (re)open binds this host's
    // engine transport to the opened session so its grants/reads are
    // accepted by the owning engine (an unscoped grant names a fresh
    // random session and is refused as wrong-session). Proxy transport
    // has no session scope to bind.
    transport.setOnOpenHandler((opened) => {
      if (this.transport instanceof SignedEngineTransport) {
        this.transport.bindSession(opened.sessionId);
      }
      // The handshake opened a live session for this host: reads may
      // flow (the read gate lifts — see sessionBound).
      this.markSessionBound();
    });
    if (transport.sessionId) {
      if (this.transport instanceof SignedEngineTransport) {
        this.transport.bindSession(transport.sessionId);
      }
      this.markSessionBound();
    }
    this.stopPolling();
  }

  detachCollabTransport(): void {
    if (this.collabTransport) {
      this.collabTransport.bridgeSubmitEnabled = true;
      this.collabTransport.setOnOpenHandler(null);
    }
    this.collabTransport = null;
    this.startPolling();
  }

  /**
   * Apply SSE delta cells to the CONFIRMED layer (CollabHostAdapter):
   * seed the view's read cache with the authoritative post-recalc
   * values (the view overlays any provisional own edit on top, per §8)
   * and mirror them into the local mirror when one is present + in
   * sync, so later local-route measurement sees server truth.
   */
  applyDeltaCells(cells: DeltaCell[], _meta: { revision: number; origin: DeltaOrigin }): void {
    let applied = false;
    for (const cell of cells) {
      const ref: CellRef = { sheet: cell.sheet, row: cell.row, col: cell.col };
      if (cell.hidden) {
        // Hidden from this principal: clear the confirmed value — the
        // cell's real value must never linger in (or cross to) this tab.
        this.remoteView.seedCell(ref, EMPTY);
        continue;
      }
      if (cell.value) {
        this.remoteView.seedCell(ref, cell.value, cell.formula);
        applied = true;
      } else if (cell.formula) {
        this.remoteView.seedCell(ref, EMPTY, cell.formula);
        applied = true;
      } else {
        this.remoteView.evict(ref);
      }
      if (this.mirror && this.mirrorInSync) {
        try {
          if (cell.formula) {
            this.mirror.execute({ cmd: 'setFormula', ref, formula: cell.formula });
          } else if (
            cell.value &&
            (cell.value.kind === 'number' || cell.value.kind === 'string' || cell.value.kind === 'boolean')
          ) {
            this.mirror.execute({
              cmd: 'setCell',
              ref,
              value: (cell.value as { value: unknown }).value as never,
            });
          } else if (cell.value?.kind === 'null') {
            this.mirror.execute({ cmd: 'setCell', ref, value: null as never });
          }
        } catch {
          // Mirror divergence is recoverable (server wins; the mirror is
          // a disposable cache) — stop trusting it for local routing.
          this.mirrorInSync = false;
        }
      }
    }
    this.cachedSnapshot = null;
    if (applied || cells.length > 0) this.emitRemote({ type: 'recalcComplete' });
  }

  /** Feed an SSE `session` event to the handlers poll() used to serve. */
  applySessionEvent(event: SessionEventData): void {
    switch (event.kind) {
      case 'structure':
      case 'load':
        void this.refreshSheetNames();
        this.remoteView.clearCache();
        this.cachedSnapshot = null;
        this.emitRemote({ type: 'recalcComplete' });
        break;
      case 'reset':
      case 'release':
        this.cachedSnapshot = null;
        this.emitRemote({ type: 'reset' });
        break;
      default:
        this.emitRemote({ type: 'recalcComplete' });
        break;
    }
  }

  /**
   * Full re-stream of the confirmed layer (before-retention resync):
   * drop every cached view of server state and re-pull the authoritative
   * snapshot; subsequent renders re-read values through the bulk path.
   * The transport's durable outbound queue is NOT touched (§1).
   */
  async resyncToCurrentState(): Promise<void> {
    // A resync presupposes a live session (it re-streams one): the
    // read gate must be open for its own name refresh + later reads.
    this.markSessionBound();
    this.cachedSnapshot = null;
    this.snapshotInFlight = null;
    this.remoteView.clearCache();
    this.markMirrorOutOfSync();
    await this.snapshotAsync().catch(() => undefined);
    await this.refreshSheetNames();
    this.emitRemote({ type: 'reset' }, /* keepNames */ true);
  }

  /** The async transport this host runs on. */
  getTransport(): AsyncEngineTransport {
    return this.transport;
  }

  // -- async transport surface (open/reset/events/language) -------------------

  /**
   * Load an XLSX file into the remote engine (web "Open file" flow).
   * Fully async: the tab stays responsive while the server parses and
   * builds. When the transport offers a progressive stream
   * (loadXlsxProgressive), `onChunk` fires per accumulated chunk so the
   * app can hydrate + paint sheet 1 early (time-to-first-page); mutation
   * stays gated until the terminal chunk (done === true). Resolves with
   * the terminal load payload — only at 100% server-side load.
   */
  async loadXlsxAsync(
    base64: string,
    onChunk?: (accumulated: EngineLoadResult, done: boolean, chunk: ProgressiveLoadChunk) => void,
    format: 'xlsx' | 'csv' | 'xls' = 'xlsx',
  ): Promise<EngineLoadResult> {
    this.opening = true;
    // A new workbook supersedes any snapshot pulled for the previous one.
    this.cachedSnapshot = null;
    this.firstSheetName = null;
    this.remoteView.resetFirstPageMarks();
    // The load itself is a gate-lift event: clear any failure
    // suppression so reads-during-build flow from the first chunk.
    this.remoteView.noteGateLifted();
    try {
      let result: EngineLoadResult;
      // W16 windowed retention: count cells as they stream in; past
      // the threshold this open is necessarily a no-mirror workbook
      // (a mirror ships only at/below the 5,000-cell flag threshold),
      // so the view cache switches to its bounded window and the tab
      // stops accumulating the whole workbook (see RemoteView).
      let streamedCount = 0;
      const handleChunk = (
        acc: EngineLoadResult,
        done: boolean,
        chunk: ProgressiveLoadChunk,
      ): void => {
        if (acc.sheets.length > 0) this.firstSheetName = acc.sheets[0] ?? null;
        this.sheetNameCache = [...acc.sheets];
        this.lastSeq = 0;
        // Push supersedes pull for the initial data: seed THIS chunk's
        // pushed cells (display values + pending-calc marks) into the
        // view cache immediately — first paint issues ~zero pull reads
        // and never waits for the engine graph build.
        if (chunk.raw?.type === 'rows') {
          const conv = streamedCellsFromChunk(chunk.raw);
          streamedCount += conv.cells.length;
          if (
            streamedCount > this.retention.threshold &&
            !this.remoteView.isWindowedRetention()
          ) {
            this.remoteView.setWindowedRetention(true, this.retention.cap);
          }
          this.seedStreamedCells({ [conv.name]: conv.cells });
        }
        onChunk?.(acc, done, chunk);
      };
      // Phase 2 (§9 step 4): a session the join handshake opened loads
      // DIRECTLY on the owner engine with the handshake token via the
      // collab transport — never through the gateway-proxied Phase-1
      // load endpoints (the proxy forwards the gateway JWT, which the
      // signed-mode engine refuses: the §10 Scenario-1 defect). The
      // legacy transports serve only sessions no handshake opened.
      const collab = this.collabTransport;
      if (collab && collab.sessionId) {
        result = await collab.loadXlsxProgressiveDirect(base64, handleChunk, false, format);
      } else if (this.transport.loadXlsxProgressive) {
        result = await this.transport.loadXlsxProgressive(base64, handleChunk);
      } else {
        result = await this.transport.loadXlsx(base64);
        onChunk?.(result, true, { rawType: 'fallback', progressPct: 100 });
      }
      // Terminal retention decision (also covers the non-streaming
      // fallback): a mirror workbook keeps full retention; a no-mirror
      // workbook above the threshold is windowed.
      if (result.mirror) {
        this.remoteView.setWindowedRetention(false);
      } else {
        const totalCells = Object.values(result.columnCounts ?? {}).reduce(
          (n, cols) => n + cols.reduce((a, b) => a + b, 0),
          0,
        );
        if (totalCells > this.retention.threshold) {
          this.remoteView.setWindowedRetention(true, this.retention.cap);
        }
      }
      this.firstSheetName = result.sheets[0] ?? null;
      this.sheetNameCache = [...result.sheets];
      this.lastSeq = 0;
      this.mirrorInSync = true;
      // The load introduced/completed this host's session: bound.
      this.markSessionBound();
      // The reset below clears the view cache; the pending-calc marks
      // seeded during THIS load must survive it (see snapshotPending).
      const pendingMarks = this.remoteView.snapshotPending();
      this.emitRemote({ type: 'reset' }, /* keepNames */ true);
      this.remoteView.restorePending(pendingMarks);
      return result;
    } finally {
      this.opening = false;
    }
  }

  /** Reset the remote workbook (web "New workbook" flow), async. */
  async resetRemoteAsync(): Promise<void> {
    this.resetting = true;
    try {
      // Phase 2 (§9 step 4): a session the join handshake opened resets
      // DIRECTLY on the owner engine with the handshake token via the
      // collab transport — never through the legacy transport reset
      // (it mints a fresh anonymous session and resets that instead,
      // stranding the claimed session: Worker C's F6). The legacy
      // reset serves only sessions no handshake opened.
      const collab = this.collabTransport;
      if (collab && collab.sessionId) {
        await collab.resetDirect();
      } else {
        await this.transport.reset();
      }
      this.sheetNameCache = ['Sheet1'];
      this.mirror = null;
      this.mirrorCellCount = 0;
      this.mirrorInSync = true;
      this.cachedSnapshot = null;
      this.lastSeq = 0;
      // The reset introduced this host's (blank) session: bound.
      this.markSessionBound();
      this.emitRemote({ type: 'reset' });
    } finally {
      this.resetting = false;
    }
  }

  /** Async one-cell read for await-capable flows. */
  readCellAsync(ref: CellRef): Promise<EngineCellRead> {
    return this.remoteView.readCellAsync(saneCell(ref));
  }

  /** Async range read for await-capable flows (batched bulk read). */
  readRangeAsync(range: RangeRef): Promise<EngineRangeRead> {
    return this.remoteView.readRangeAsync(saneRange(range));
  }

  /** Async used-range lookup for await-capable flows (deduped). */
  usedRangeAsync(sheet: string): Promise<RangeRef | null> {
    return this.remoteView.usedRangeAsync(sheet);
  }

  /** Queue a bulk viewport read (scroll/prefetch); the grid's own reads also ride the batcher. */
  prefetchViewport(sheet: string, range: RangeRef): void {
    this.remoteView.prefetchViewport(sheet, saneRange(range));
  }

  /**
   * Seed one progressive-load accumulation's pushed cells into the view
   * and repaint — scoped to the streamed sheets (the host emits one tick;
   * only cells present in the cache change visually).
   */
  seedStreamedCells(streamed: Record<string, Array<{ row: number; col: number; value: TypedValue; formula?: string; pending?: boolean }>> | undefined): void {
    if (!streamed) return;
    let seeded = false;
    for (const [sheet, cells] of Object.entries(streamed)) {
      if (cells.length === 0) continue;
      this.remoteView.seedStreamed(sheet, cells);
      seeded = true;
    }
    if (seeded) this.emitRemote({ type: 'recalcComplete' });
  }

  /** Transport-layer read accounting for Phase 4 (requested vs actual). */
  viewportReadStats(): { requestedReads: number; transportCalls: number; usedRangeTransportCalls: number } {
    return this.remoteView.viewportReadStats();
  }

  /** Await until all queued/in-flight reads settle (tests + harness). */
  whenReadsIdle(): Promise<void> {
    return this.remoteView.whenReadsIdle();
  }

  /** Switch the server engine's formula language. */
  async setFormulaLanguageAsync(locale: string): Promise<void> {
    await this.client.engineSetLanguageAsync(locale);
  }

  // -- Phase 3: routed edits -----------------------------------------------------

  /**
   * Install the local mirror + current workbook size (called from the
   * app's open flow right after buildLocalMirror). The mirror is a
   * disposable calc target — the server stays the source of truth.
   * `thresholds` lets the app push the settings-configurable MT
   * threshold live (env override stays canonical — see
   * resolveHybridThresholds).
   */
  setLocalMirror(mirror: EngineHost | null, totalCellCount: number | null, thresholds?: HybridRecalcConfig): void {
    this.mirror = mirror;
    this.mirrorCellCount = totalCellCount;
    if (thresholds) this.thresholds = thresholds;
    this.mirrorInSync = true;
  }

  /** Live-update the hybrid thresholds (Calculation Options dialog). */
  setHybridThresholds(thresholds: HybridRecalcConfig): void {
    this.thresholds = thresholds;
  }

  getHybridThresholds(): HybridRecalcConfig {
    return { ...this.thresholds };
  }

  /** The optimistic-edit session (tests + the view's display overlay). */
  getOptimisticSession(): OptimisticEditSession {
    return this.session;
  }

  // -- Save interlock (Cycle 10 closure) ------------------------------------
  // While any routed edit is in flight, the workbook holds provisional /
  // pre-edit state: autosave and manual save must DEFER (never serialize,
  // never mark clean) until the edit settles. See saveInterlock.ts.

  /** True while any routed edit (cell, structural, other) is unsettled. */
  hasInFlightEdits(): boolean {
    return this.editFlight.hasInFlightEdits() || this.session.hasPending();
  }

  /** Number of host-level executes currently in flight. */
  get editInFlightCount(): number {
    return this.editFlight.pendingCount;
  }

  /** Notify `listener` whenever the in-flight state may have changed. */
  subscribeEditFlight(listener: () => void): () => void {
    const offTracker = this.editFlight.subscribe(listener);
    const offSession = this.session.subscribePending(listener);
    return () => {
      offTracker();
      offSession();
    };
  }

  /** Resolves once no routed edit is in flight (immediately when idle). */
  async whenEditsSettle(): Promise<void> {
    // Loop: an edit beginning while a prior batch settles must also be
    // awaited — a save may only proceed at a genuinely idle moment.
    // Each iteration awaits ONLY the sources that are actually busy
    // (their settle promises resolve exclusively at zero) — awaiting an
    // already-idle source here would spin the loop in microtasks while
    // e.g. a structural edit (tracker-busy, session-idle) is in flight.
    while (this.hasInFlightEdits()) {
      const waits: Array<Promise<void>> = [];
      if (this.editFlight.hasInFlightEdits()) waits.push(this.editFlight.whenEditsSettle());
      if (this.session.hasPending()) waits.push(this.session.whenSettled());
      if (waits.length === 0) break;
      await Promise.all(waits);
    }
  }

  /**
   * TRUE while this cell's formula awaits the engine calc (saved without
   * a cached value): the view renders its loading state — never a final
   * blank/0 (display-before-graph caveat handling).
   */
  isPendingCalc(ref: CellRef): boolean {
    return this.remoteView.isPendingCalc(ref);
  }

  /** Count of streamed cells still pending calc (StatusBar/diag). */
  pendingCalcCount(): number {
    return this.remoteView.pendingCalcCount();
  }

  /** View-cache retention state (W16 diagnostics + tests). */
  viewCacheStats(): { windowed: boolean; cachedCells: number; pendingCalc: number } {
    return {
      windowed: this.remoteView.isWindowedRetention(),
      cachedCells: this.remoteView.cachedCellCount(),
      pendingCalc: this.remoteView.pendingCalcCount(),
    };
  }

  /** Mark the mirror out of sync (broadcast gap / resync pending → server-only). */
  markMirrorOutOfSync(): void {
    this.mirrorInSync = false;
  }

  /** A snapshot resync completed: local routing may resume. */
  markMirrorInSync(): void {
    this.mirrorInSync = true;
  }

  /**
   * Route + execute ONE edit through the hybrid protocol (routedEdit.ts):
   * measure → routeRecalc (mirror precondition enforced) → local
   * provisional calc + write-through ack comparison, or server route with
   * optimistic display + ack confirmation (server wins) + visible
   * rollback on rejection. The outcome carries the decision, divergence
   * cells and ack values for the caller to surface.
   */
  executeRoutedAsync(command: EngineCommand): Promise<RoutedEditOutcome> {
    // Save interlock: the WHOLE routed execute (transport + ack-value
    // fetch + view seeding) counts as in flight, so a save deferred by
    // `whenEditsSettle()` serializes only the settled, post-edit state.
    return this.editFlight.track(() => this.executeRoutedAsyncInner(command));
  }

  private async executeRoutedAsyncInner(command: EngineCommand): Promise<RoutedEditOutcome> {
    const outcome = await executeRoutedEdit(
      {
        mirror: this.mirror,
        totalCellCount: this.mirrorCellCount,
        thresholds: this.thresholds,
        // Phase 2: with a collab transport bound to a file session,
        // EVERY mutating execute goes through POST /ops with the
        // {clientId, clientSeq, baseRev} envelope (durable queue,
        // idempotent, sequencer-ordered). Unbound (pre-open / legacy
        // proxy mode) keeps the Phase 1 proxied execute path.
        serverExecute: (cmd, opts) =>
          this.collabTransport?.fileId
            ? this.collabTransport.submitCommand(cmd)
            : this.transport.execute(cmd, opts),
        fetchAckValues: (refs) => this.fetchValuesBulk(refs),
        readConfirmedValue: (ref) => this.remoteView.readCell(ref).value,
        online: typeof navigator === 'undefined' ? true : navigator.onLine,
        mirrorInSync: this.mirrorInSync,
        session: this.session,
      },
      command,
    );
    // Feed the outcome into the view + repaint tick.
    if (command.cmd === 'setCell' || command.cmd === 'setFormula') {
      // Any snapshot pulled before this edit is stale (the server is the
      // source of truth and the ack may differ from the optimistic value).
      this.cachedSnapshot = null;
      const ref = command.ref;
      if (outcome.rolledBack) {
        // Visible rollback: drop optimistic state + refetch the server
        // value for the edited cell (never keep a phantom).
        this.remoteView.evict(ref);
        void this.remoteView.readCellAsync(ref).catch(() => undefined);
      } else if (outcome.ackValues) {
        for (const [key, value] of outcome.ackValues) {
          const parsed = key.split(':');
          this.remoteView.seedCell(
            { sheet: parsed[0]!, row: Number(parsed[1]), col: Number(parsed[2]) },
            value,
          );
        }
      } else {
        this.remoteView.evict(ref);
      }
      if ((outcome.divergedCells?.length ?? 0) > 0) {
        // Divergence is a bug signal (engines are identical) — never
        // silent: the ack values above are already seeded, and the event
        // is logged for diagnosis.
        console.warn(
          '[hybrid] server-wins divergence',
          outcome.divergedCells!.map((r) => `${r.sheet}!${r.row},${r.col}`).join(', '),
        );
      }
      this.emitRemote({ type: 'recalcComplete' });
    } else {
      // Structural / other commands: values changed server-side — clear
      // the read caches so the next read re-streams (poll also covers it).
      this.remoteView.clearCache();
      this.cachedSnapshot = null;
      this.emitRemote({ type: 'recalcComplete' });
    }
    return outcome;
  }

  /** Fetch authoritative values for refs as merged bulk range reads. */
  private async fetchValuesBulk(refs: CellRef[]): Promise<Map<string, TypedValue>> {
    const ranges: RangeRef[] = refs.map((r) => ({
      sheet: r.sheet,
      startRow: r.row,
      startCol: r.col,
      endRow: r.row,
      endCol: r.col,
    }));
    const merged = mergeRangesForBulkRead(ranges);
    const out = new Map<string, TypedValue>();
    await Promise.all(
      merged.map(async (m) => {
        try {
          const res = await this.transport.readRange(saneRange(m));
          for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
              const cell = cellFromBulk(m, res, r, c);
              if (cell) {
                out.set(refKey(cell.ref), cell.value);
                this.remoteView.seedCell(cell.ref, cell.value, cell.formula);
              }
            }
          }
        } catch {
          // Ack-value fetch is best-effort; the op itself already acked.
        }
      }),
    );
    return out;
  }

  // -- synchronous EngineHost surface (cache reads + routed execute) --------
  //
  // Mid-open fail-soft (Cycle 10): while an async open is in flight the
  // server-side workbook may already be the NEW file while the UI still
  // renders the OLD sheet name — reads for the old sheet fail soft (the
  // region simply hasn't streamed in yet).

  override execute(command: EngineCommand): CommandResult {
    // Async runtime (IpcEngineHost convention): the Promise is the honest
    // result. Callers that can await must await it.
    return this.executeRoutedAsync(command).then(
      (outcome) => outcome.result,
      (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    ) as unknown as CommandResult;
  }

  /**
   * Host-level reads are CACHE reads (never throw, never hit the network
   * synchronously): the view's read-through cache + bulk prefetch is the
   * render path; await-capable action flows use the *Async methods.
   * Errors surface through executeRoutedAsync, never through reads.
   */
  override readCell(ref: CellRef, _auth?: AuthContext): TypedValue {
    try {
      return this.remoteView.readCell(saneCell(ref)).value;
    } catch (e) {
      if (this.opening || isUnknownSheetError(e)) return EMPTY;
      return EMPTY;
    }
  }

  override readRange(range: RangeRef, _auth?: AuthContext): TypedValue[][] {
    try {
      return this.remoteView.readRangeValues(saneRange(range));
    } catch (e) {
      if (this.opening || isUnknownSheetError(e)) return [];
      return [];
    }
  }

  override readSheet(sheet: string, _auth?: AuthContext): TypedValue[][] {
    try {
      return this.remoteView.readSheet(sheet);
    } catch {
      return [];
    }
  }

  override getView(): TypedView {
    return this.remoteView;
  }

  override getAuthorizer(): Authorizer {
    return this.stubAuthorizer;
  }

  override setHiddenCheck(): void {
    // No-op: hidden-cell enforcement lives in the engine service.
  }

  /**
   * Cached sheet names (perf 2026-10-19, extended Cycle 10): kept live
   * from /load's sheets[], progressive chunks, the /sheets refresh, and
   * polled sheet-structure events. NEVER from snapshot().
   */
  private sheetNameCache: string[] | null = null;

  override sheetNames(): string[] {
    if (this.sheetNameCache) return [...this.sheetNameCache];
    void this.refreshSheetNames();
    return [];
  }

  /** Refresh the sheet-name cache from /sheets (names only, cheap). */
  async refreshSheetNames(): Promise<string[]> {
    // Read gate: no session bound yet → no /sheets call (it could only
    // 401 in signed mode); the cached names (or none) are the answer.
    if (!this.readsAllowed()) return this.sheetNameCache ?? [];
    try {
      const names = await this.transport.sheetNames();
      const changed =
        this.sheetNameCache === null ||
        names.length !== this.sheetNameCache.length ||
        names.some((n, i) => n !== this.sheetNameCache![i]);
      this.sheetNameCache = [...names];
      if (changed && !this.disposed) {
        this.emitRemote({ type: 'recalcComplete' });
      }
      return names;
    } catch {
      return this.sheetNameCache ?? [];
    }
  }

  /**
   * Snapshot: returns the last async-fetched snapshot, or an empty
   * name-only snapshot when none has been pulled yet. The cache is
   * invalidated on every mutation (routed edits, structural commands,
   * polled external changes, loads, resets), so a non-null cache is
   * current. Await-capable callers (save/download serialization) MUST
   * await snapshotAsync() first — serializing the name-only fallback
   * would write every sheet back empty.
   */
  override snapshot(): WorkbookSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    return {
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      sheets: (this.sheetNameCache ?? []).map((name) => ({ name, cells: [] })),
    };
  }

  private snapshotInFlight: Promise<WorkbookSnapshot> | null = null;

  /** Async snapshot through the transport (cached until invalidated). */
  async snapshotAsync(): Promise<WorkbookSnapshot> {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    if (!this.snapshotInFlight) {
      this.snapshotInFlight = this.transport
        .snapshot()
        .then((snap) => {
          this.cachedSnapshot = snap;
          this.sheetNameCache = snap.sheets.map((s) => s.name);
          return snap;
        })
        .finally(() => {
          this.snapshotInFlight = null;
        });
    }
    return this.snapshotInFlight;
  }

  override subscribe(listener: EngineEventListener): () => void {
    this.remoteListeners.add(listener);
    return () => {
      this.remoteListeners.delete(listener);
    };
  }

  override dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.remoteListeners.clear();
    this.mirror?.dispose();
    this.mirror = null;
  }

  private async poll(): Promise<void> {
    // §8 always-on SSE: with a collab transport attached there is NO
    // /events polling — not even a stray request (the Phase 2 scenario-4
    // traffic check looks for /events requests and must find none).
    // Read gate: no session bound yet → nothing to poll for.
    if (this.disposed || this.pollInFlight || this.collabTransport || !this.readsAllowed()) return;
    this.pollInFlight = true;
    try {
      const events = await this.transport.events(this.lastSeq);
      if (events.length === 0) return;
      let maxSeq = this.lastSeq;
      const changed = new Map<string, CellRef>();
      let recalc = false;
      const structuralEvents: EngineEvent[] = [];
      for (const { seq, event } of events) {
        if (seq > maxSeq) maxSeq = seq;
        if (event.type === 'cellsChanged') {
          for (const ref of event.refs) {
            if (changed.size < 5000) changed.set(refKey(ref), ref);
          }
        } else if (event.type === 'recalcComplete') {
          recalc = true;
        } else {
          structuralEvents.push(event);
        }
      }
      this.lastSeq = maxSeq;
      for (const event of structuralEvents) this.emitRemote(event);
      if (changed.size > 0) {
        this.emitRemote({ type: 'cellsChanged', refs: [...changed.values()] });
      }
      if (recalc) this.emitRemote({ type: 'recalcComplete' });
    } catch {
      // Poll failures must not break the UI loop.
    } finally {
      this.pollInFlight = false;
    }
  }

  private emitRemote(event: EngineEvent | { type: 'reset' }, keepNames = false): void {
    if (event.type === 'cellsChanged') {
      // Values changed outside a local routed edit (poll/other client):
      // a previously pulled snapshot no longer matches the server.
      this.cachedSnapshot = null;
      for (const ref of (event as { refs?: CellRef[] }).refs ?? []) {
        this.remoteView.evict(ref);
      }
    } else if (event.type !== 'recalcComplete') {
      this.remoteView.clearCache();
    }
    const evName = (event as { name?: unknown }).name;
    if (event.type === 'sheetAdded' && typeof evName === 'string') {
      this.sheetNameCache = [...(this.sheetNameCache ?? []), evName];
    } else if (event.type === 'sheetRemoved' && typeof evName === 'string') {
      this.sheetNameCache = (this.sheetNameCache ?? []).filter((n) => n !== evName);
    } else if (event.type === 'reset' && !keepNames) {
      this.sheetNameCache = null;
    }
    for (const l of [...this.remoteListeners]) {
      try {
        l(event as EngineEvent);
      } catch {
        // A failing listener must not break the host.
      }
    }
    // Time-to-first-page: once values have arrived and this tick has been
    // handed to the render loop, the next microtask turn is after the
    // paint for practical purposes — stamp first-page-painted then.
    const report = getFirstPageReport();
    if (report.firstValuesAt !== null && report.firstPagePaintedAt === null) {
      queueMicrotask(() => markFirstPagePainted());
    }
  }
}

// Re-export the chunk-merge helper for App's progressive hydration.
export { mergeLoadChunks };
export type { ProgressiveLoadChunk };
