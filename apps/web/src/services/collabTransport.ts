/**
 * Collab transport (Phase 2 co-authoring, revision-model doc §§7–9).
 *
 * The web client's half of the fixed Phase 2 contract
 * (hidden_files/phase2-coauthoring/CONTRACT.md):
 *
 *  - JOIN HANDSHAKE (§9): gatewayClient.openFile(fileId?) returns
 *    connection info ONLY (owner engineUrl, sessionId, signed token,
 *    role, current revision). The client then connects DIRECTLY to the
 *    owner engine. Engine endpoints are LEASED: every reconnect re-runs
 *    openFile() and never reuses a stale engineUrl/token.
 *  - SSE DELTA CHANNEL (§8, ALWAYS ON): GET {engineUrl}/deltas streams
 *    hello / delta / status / presence / session events for EVERY
 *    service session from open — single-user included. There is no
 *    polling fallback (RemoteEngineHost's /events poll is gated off
 *    while this transport is live).
 *  - CONFIRMED vs PROVISIONAL (§8): deltas apply to the CONFIRMED layer
 *    only, strictly in revision order (gap → hold + journal catch-up
 *    via GET /revisions; 409 before-retention → full re-stream of the
 *    confirmed layer). A cell with a provisional (unacked own) edit
 *    keeps displaying the provisional value — the host's view overlays
 *    optimistic values over the confirmed cache — until the delta for
 *    its own op arrives and acks it.
 *  - DURABLE OUTBOUND QUEUE (§§1/7): every op submitted here is
 *    persisted per-file in localStorage until the server acks it.
 *    Resync/reload NEVER clears it. On visible rejection the entry
 *    moves to a retained per-file `rejected` list (input preserved,
 *    surfaced in the UI) — never silently dropped.
 *  - PRESENCE (§8): ephemeral signal via POST /presence (+ 10s
 *    heartbeat, sendBeacon leave on pagehide). Never a revision.
 *
 * Everything external (storage, EventSource, fetch, the gateway client,
 * the host adapter) is injectable so the sequencing/queue logic is
 * unit-testable without a live stack.
 */
import type {
  CellRef,
  CollabOp,
  CommandResult,
  EngineCommand,
  TypedValue,
} from '@icecream-sheets/engine';
import { clientInstanceId } from './clientInstance';
import type {
  EngineLibrarySavePayload,
  EngineLibrarySaveResult,
  EngineOpenResult,
  GatewayClient,
} from './gatewayClient';
import type { ChartSpec } from '@icecream-sheets/service';
import {
  mergeLoadChunks,
  streamProgressPct,
  type EngineLoadResult,
  type ProgressiveLoadChunk,
  type RawStreamChunk,
} from './engineTransport';

// ---------------------------------------------------------------------------
// Contract wire shapes
// ---------------------------------------------------------------------------

/** One changed cell in a delta (value omitted for hidden cells). */
export interface DeltaCell {
  sheet: string;
  row: number;
  col: number;
  value?: TypedValue;
  formula?: string;
  /** True when the cell is hidden from THIS recipient: clear, never show. */
  hidden?: boolean;
}

export interface DeltaOrigin {
  clientId: string | null;
  clientSeq?: number;
  principal?: string;
}

export interface DeltaEventData {
  revision: number;
  origin: DeltaOrigin;
  cells: DeltaCell[];
}

export interface HelloEventData {
  revision: number;
  storedRevision: number;
  fileId: string;
}

export interface StatusEventData {
  revision: number;
  storedRevision: number;
  saving: boolean;
  /** #105: byte length of the last committed checkpoint's serialized snapshot (absent on older engines, 0 until the first checkpoint). */
  storedBytes?: number;
}

export interface PresenceParticipant {
  principal: string;
  /**
   * Display name (workspace-settings brief): the participant's
   * settings display name (provider name as fallback), carried on the
   * presence payload. Absent from older engines — renderers fall back
   * to the principal.
   */
  name?: string;
  color: string;
  sheet: string;
  row: number;
  col: number;
  editing?: boolean;
}

export interface PresenceEventData {
  participants: PresenceParticipant[];
}

export interface SessionEventData {
  kind: 'structure' | 'load' | 'reset' | 'release' | 'fenced' | string;
  [key: string]: unknown;
}

/** One journal catch-up entry from GET /revisions. */
export interface RevisionEntry {
  revision: number;
  origin: DeltaOrigin;
  op?: unknown;
  cells: DeltaCell[];
}

export type CollabConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** A durable outbound-queue entry: removed ONLY on server ack. */
export interface QueuedOp {
  clientSeq: number;
  cmd: EngineCommand;
  baseRev: number;
  enqueuedAt: number;
}

/** A visibly rejected op: retained locally with its input intact. */
export interface RejectedOp extends QueuedOp {
  reason: string;
  rejectedAt: number;
}

// ---------------------------------------------------------------------------
// Host adapter (implemented by RemoteEngineHost; faked in tests)
// ---------------------------------------------------------------------------

export interface CollabHostAdapter {
  /** Apply delta cells to the CONFIRMED layer (mirror + read caches). */
  applyDeltaCells(cells: DeltaCell[], meta: { revision: number; origin: DeltaOrigin }): void;
  /** Feed an SSE `session` event to the handlers the poll loop used. */
  applySessionEvent(event: SessionEventData): void;
  /**
   * Full re-stream of current state (before-retention resync): replaces
   * ONLY the confirmed layer — the durable queue is never touched.
   * Returns the revision the re-stream landed at, when known.
   */
  resync(): Promise<number | void>;
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: { data?: string }) => void): void;
  close(): void;
  onerror: ((ev: unknown) => void) | null;
}

export interface CollabTransportDeps {
  gateway: Pick<GatewayClient, 'openFile'>;
  host: CollabHostAdapter;
  /** This client's principal (presence display); defaults to 'You'. */
  principal?: string;
  /**
   * This client's presence display name, read live at every presence
   * post (workspace-settings brief: the settings display name is the
   * source). Null/absent → the presence payload carries no name and
   * peers fall back to the principal.
   */
  presenceDisplayName?: () => string | null;
  storage?: StorageLike;
  eventSourceFactory?: (url: string) => EventSourceLike;
  fetchFn?: typeof fetch;
  sendBeaconFn?: (url: string, data: Blob) => boolean;
  /**
   * Issue #88: per-attempt bound for a reconnect's gateway lookup
   * (default 20 s). The lookup is a bare fetch with no timeout of its
   * own; an unbounded attempt that hangs stalls the whole reconnect
   * machinery (no settle → no catch → no next backoff). Tests inject
   * a short bound.
   */
  reconnectAttemptTimeoutMs?: number;
  /** Callbacks (App wiring). */
  onStateChange?: (state: CollabConnectionState) => void;
  onStatus?: (status: StatusEventData) => void;
  onParticipants?: (participants: PresenceParticipant[]) => void;
  /**
   * FIX-G (trace §4.1e): the engine session's native chart list,
   * delivered by the SSE `session {kind:'charts'}` event (broadcast on
   * every accepted chart + echoed on subscribe). Carries the FULL
   * session chart-spec list; the App merges by spec id.
   */
  onCharts?: (charts: ChartSpec[]) => void;
  /**
   * Per-user open cap (§9A): the server detached THIS client from
   * the session (the user crossed the simultaneous-open limit and
   * this was their least recently used open file). The transport
   * has already torn itself down WITHOUT reconnecting by the time
   * this fires; the App closes the file's view SILENTLY — no
   * prompt, no notice, no error surface of any kind.
   */
  onDetached?: () => void;
  /** Every applied delta (bridge revision-log feed). */
  onDelta?: (delta: DeltaEventData) => void;
  /** An own op was acked by its delta (provisional state may clear). */
  onAck?: (entry: QueuedOp, delta: DeltaEventData) => void;
  /** An op was visibly rejected; the input is retained in `rejected`. */
  onRejected?: (entry: RejectedOp) => void;
  /** Full re-stream happened (confirmed layer replaced). */
  onResync?: () => void;
  /**
   * The join handshake completed (initial connect AND every reconnect —
   * endpoints/session are leased, §9, so this can fire again with a new
   * owner session). RemoteEngineHost uses it to scope the signed engine
   * transport's grants to the opened session: without it, host reads in
   * signed mode mint grants for a fresh random session and the engine
   * refuses them (wrong-session).
   */
  onOpen?: (opened: EngineOpenResult) => void;
}

const CLIENT_ID_KEY = 'icecream.clientId';

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** The stable per-browser client id (minted once, persisted). */
export function getOrCreateClientId(storage?: StorageLike | null): string {
  const store = storage ?? defaultStorage();
  try {
    const existing = store?.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
  } catch {
    // fall through to mint
  }
  const id = `web-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
  try {
    store?.setItem(CLIENT_ID_KEY, id);
  } catch {
    // Storage unavailable: the id lives for this session only.
  }
  return id;
}

interface PersistedFileState {
  queue: QueuedOp[];
  rejected: RejectedOp[];
  clientSeq: number;
  lastAppliedRev: number | null;
}

const EMPTY_FILE_STATE: PersistedFileState = { queue: [], rejected: [], clientSeq: 0, lastAppliedRev: null };

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class CollabTransport {
  readonly clientId: string;
  private readonly gateway: CollabTransportDeps['gateway'];
  private readonly host: CollabHostAdapter;
  private readonly principal: string;
  private readonly storage: StorageLike | null;
  private readonly esFactory: (url: string) => EventSourceLike;
  private readonly fetchFn: typeof fetch;
  private readonly sendBeaconFn: ((url: string, data: Blob) => boolean) | null;
  private readonly deps: CollabTransportDeps;

  private state: CollabConnectionState = 'disconnected';
  private opened: EngineOpenResult | null = null;
  /**
   * The file whose claim THIS tab created (null when this tab has only
   * ever joined). Latched in connect(); governs the page-unload release
   * — a guest never tears down a session it does not own.
   */
  private createdFileId: string | null = null;
  private fileState: PersistedFileState = { ...EMPTY_FILE_STATE, queue: [], rejected: [] };
  private es: EventSourceLike | null = null;
  private held = new Map<number, DeltaEventData>();
  private waiters = new Map<number, { resolve: (r: CommandResult) => void }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  // Issue #88: reconnect-attempt bookkeeping. An attempt is one
  // runReconnect pass; `reconnectInFlight` lets concurrent callers JOIN
  // it instead of piling on parallel connects, and `reconnectGeneration`
  // marks attempts superseded (attempt timeout, Reconnect-now, or
  // disconnect) so a late-completing attempt stands down instead of
  // adopting state over the current one.
  private reconnectInFlight: Promise<void> | null = null;
  private reconnectGeneration = 0;
  private readonly reconnectAttemptTimeoutMs: number;
  private queueRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private queueRetryAttempt = 0;
  private intentionalClose = false;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private presenceDebounce: ReturnType<typeof setTimeout> | null = null;
  private lastPresence: { sheet: string; row: number; col: number; editing?: boolean } | null = null;
  private participants: PresenceParticipant[] = [];
  private status: StatusEventData | null = null;
  private catchingUp: Promise<void> | null = null;
  /**
   * When the attached host already submits ops through submitCommand
   * (RemoteEngineHost's routed-edit serverExecute), CollabBridge
   * broadcasts must NOT submit a second time — the host path IS the
   * /ops submission. Standalone bridge use (no host attach) submits
   * through submitBridgeOp. Set by RemoteEngineHost.attachCollabTransport.
   */
  bridgeSubmitEnabled = true;

  /**
   * Join-handshake completion handler (see CollabTransportDeps.onOpen).
   * A plain field + setter (not only a constructor dep) because the
   * host attaches AFTER construction in the App wiring — same pattern
   * as CollabBridge.setBroadcastHandler.
   */
  private onOpenHandler: ((opened: EngineOpenResult) => void) | null = null;

  setOnOpenHandler(handler: ((opened: EngineOpenResult) => void) | null): void {
    this.onOpenHandler = handler;
  }

  constructor(deps: CollabTransportDeps) {
    this.deps = deps;
    this.gateway = deps.gateway;
    this.host = deps.host;
    this.principal = deps.principal ?? 'You';
    this.storage = deps.storage ?? defaultStorage();
    this.clientId = getOrCreateClientId(this.storage);
    this.esFactory =
      deps.eventSourceFactory ??
      ((url: string) => new EventSource(url) as unknown as EventSourceLike);
    this.fetchFn = deps.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.sendBeaconFn =
      deps.sendBeaconFn ??
      (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? (url: string, data: Blob) => navigator.sendBeacon(url, data)
        : null);
    this.reconnectAttemptTimeoutMs = deps.reconnectAttemptTimeoutMs ?? 20_000;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => {
        this.leavePresence();
        this.releaseOnUnload();
      });
    }
  }

  // -- accessors ------------------------------------------------------------

  get connectionState(): CollabConnectionState {
    return this.state;
  }

  get fileId(): string | null {
    return this.opened?.fileId ?? null;
  }

  get sessionId(): string | null {
    return this.opened?.sessionId ?? null;
  }

  /** The opened session's OWNER engine endpoint (join handshake). */
  get engineUrl(): string | null {
    return this.opened?.engineUrl ?? null;
  }

  get role(): 'editor' | 'viewer' | null {
    return this.opened?.role ?? null;
  }

  /**
   * True when the opened session was JOINED (this tab is a guest of
   * someone else's claim), false when this tab's handshake CREATED it,
   * null when no session is opened. The distinction governs teardown:
   * a guest never releases a session it does not own.
   */
  get wasJoined(): boolean | null {
    return this.opened ? this.opened.joined : null;
  }

  get lastAppliedRev(): number {
    return this.fileState.lastAppliedRev ?? 0;
  }

  get queue(): readonly QueuedOp[] {
    return this.fileState.queue;
  }

  get rejected(): readonly RejectedOp[] {
    return this.fileState.rejected;
  }

  get currentParticipants(): readonly PresenceParticipant[] {
    return this.participants;
  }

  get currentStatus(): StatusEventData | null {
    return this.status;
  }

  // -- persistence ------------------------------------------------------------

  private storageKey(fileId: string): string {
    return `icecream.collab.${fileId}`;
  }

  private loadFileState(fileId: string): void {
    this.fileState = { queue: [], rejected: [], clientSeq: 0, lastAppliedRev: null };
    try {
      const raw = this.storage?.getItem(this.storageKey(fileId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedFileState>;
      this.fileState = {
        queue: Array.isArray(parsed.queue) ? parsed.queue : [],
        rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
        clientSeq: typeof parsed.clientSeq === 'number' ? parsed.clientSeq : 0,
        lastAppliedRev: typeof parsed.lastAppliedRev === 'number' ? parsed.lastAppliedRev : null,
      };
    } catch {
      // Corrupt state must not wedge the client; start clean for this file.
      this.fileState = { queue: [], rejected: [], clientSeq: 0, lastAppliedRev: null };
    }
    this.held.clear();
  }

  private persist(): void {
    if (!this.opened) return;
    try {
      this.storage?.setItem(this.storageKey(this.opened.fileId), JSON.stringify(this.fileState));
    } catch {
      // Storage full/unavailable: the in-memory queue still governs this
      // session; durability degrades, correctness does not.
    }
  }

  // -- connection lifecycle ---------------------------------------------------

  /**
   * Join handshake + SSE connect. With no fileId the gateway mints a
   * new file (create); with one, the live session is joined — the
   * response shape is identical. Resolves once the EventSource is open
   * (the hello event completes catch-up asynchronously).
   */
  async connect(
    fileId?: string,
    opts?: { isStale?: () => boolean },
  ): Promise<EngineOpenResult> {
    this.intentionalClose = false;
    this.setState(this.state === 'reconnecting' ? 'reconnecting' : 'connecting');
    const opened = await this.gateway.openFile(fileId ? { fileId } : {});
    // Issue #88: a superseded attempt (its reconnect timed out, or the
    // user forced a fresh one) must not adopt state or open a stream
    // over the current attempt's — bail before touching anything.
    if (opts?.isStale?.()) throw new Error('connect superseded');
    const sameFile = this.opened?.fileId === opened.fileId;
    this.opened = opened;
    // Claim-creation latch for the unload release (see releaseOnUnload):
    // a handshake that CREATES the claim marks this tab as the file's
    // creator; later reconnects/refreshes JOIN the live session
    // (joined=true) but must not clear the latch — the creator's
    // teardown duty survives them. Connecting to a DIFFERENT file as a
    // joiner clears it.
    if (!opened.joined) {
      this.createdFileId = opened.fileId;
    } else if (this.createdFileId !== opened.fileId) {
      this.createdFileId = null;
    }
    if (!sameFile) this.loadFileState(opened.fileId);
    // Scope the host's engine transport to THIS session before any
    // host read runs against it (signed-mode grants, see deps.onOpen).
    this.deps.onOpen?.(opened);
    this.onOpenHandler?.(opened);
    this.openEventSource();
    return opened;
  }

  /** Close the channel and stop all timers (no reconnect). */
  disconnect(): void {
    this.intentionalClose = true;
    // Issue #88: supersede any in-flight reconnect attempt — its
    // connect() bails at the staleness check and its backoff stands
    // down, so a disconnect is never undone by a late attempt.
    this.reconnectGeneration++;
    this.reconnectInFlight = null;
    this.closeEventSource();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearQueueRetry();
    this.stopPresenceTimers();
    this.setState('disconnected');
  }

  /** Force an immediate reconnect cycle (fresh gateway lookup). */
  reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    // Issue #88: supersede any in-flight attempt first — it may be the
    // hung one the user is trying to escape — so the fresh attempt is
    // the only one that can land.
    this.reconnectGeneration++;
    this.reconnectInFlight = null;
    this.closeEventSource();
    void this.runReconnect();
  }

  private setState(next: CollabConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    try {
      this.deps.onStateChange?.(next);
    } catch {
      // Listener failures must not break the transport.
    }
  }

  private closeEventSource(): void {
    if (this.es) {
      try {
        this.es.close();
      } catch {
        // already closed
      }
      this.es = null;
    }
  }

  private openEventSource(): void {
    if (!this.opened) return;
    this.closeEventSource();
    const { engineUrl, accessToken } = this.opened;
    const es = this.esFactory(`${engineUrl}/deltas?access_token=${encodeURIComponent(accessToken)}`);
    this.es = es;
    es.addEventListener('hello', (ev) => {
      const data = parseEventData<HelloEventData>(ev);
      if (data) void this.handleHello(data);
    });
    es.addEventListener('delta', (ev) => {
      const data = parseEventData<DeltaEventData>(ev);
      if (data) void this.handleDelta(data);
    });
    es.addEventListener('status', (ev) => {
      const data = parseEventData<StatusEventData>(ev);
      if (!data) return;
      this.status = data;
      try {
        this.deps.onStatus?.(data);
      } catch {
        // listener only
      }
    });
    es.addEventListener('presence', (ev) => {
      const data = parseEventData<PresenceEventData>(ev);
      if (!data) return;
      // D8 (user ruling, 2026-10-22): a client NEVER renders its own
      // presence — the engine broadcasts every participant including
      // the sender, and the echoed self-marker lags one move behind
      // the real selection (the "flag on C3 while I'm on C4" defect).
      // Filter self out here, at the single ingestion point, so every
      // consumer (grid flags, avatar row, bridge) is covered.
      this.participants = (data.participants ?? []).filter(
        (p) => p.principal !== this.deps.principal,
      );
      try {
        this.deps.onParticipants?.(this.participants);
      } catch {
        // listener only
      }
    });
    es.addEventListener('session', (ev) => {
      const data = parseEventData<SessionEventData>(ev);
      if (!data) return;
      if (data.kind === 'detached') {
        // Per-user open cap (§9A): the server detached this client
        // from the session (cap eviction). This is DEFINITIVE, not
        // a drop — the §9 auto-reconnect would rejoin and defeat
        // the cap, so the transport tears down as an intentional
        // close and the App silently closes the file's view. No
        // user-facing text exists anywhere in this flow.
        this.disconnect();
        try {
          this.deps.onDetached?.();
        } catch {
          // Listener only.
        }
        return;
      }
      if (data.kind === 'fenced') {
        // §9 fencing: this owner lost authority — drop and re-lookup.
        this.handleDrop();
        return;
      }
      if (data.kind === 'charts') {
        // FIX-G: native chart list for the App's chart store — NOT a
        // host session event (the host has no chart concept).
        const charts = Array.isArray(data.charts) ? (data.charts as ChartSpec[]) : [];
        try {
          this.deps.onCharts?.(charts);
        } catch {
          // listener only
        }
        return;
      }
      try {
        this.host.applySessionEvent(data);
      } catch {
        // Session events are advisory; a handler failure is not fatal.
      }
    });
    es.onerror = () => this.handleDrop();
  }

  /** Connection dropped: show disconnected, back off, re-lookup, resubmit. */
  private handleDrop(): void {
    if (this.intentionalClose) return;
    this.closeEventSource();
    this.clearQueueRetry();
    this.stopPresenceTimers();
    this.setState('reconnecting');
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 10_000);
    this.reconnectAttempt++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.runReconnect();
    }, delay);
  }

  private async runReconnect(): Promise<void> {
    if (this.intentionalClose) return;
    // Issue #88: join an in-flight attempt instead of piling a second
    // connect on top of it (pre-fix, every retry tick and Reconnect-now
    // click during a slow lookup started another concurrent connect).
    if (this.reconnectInFlight) return this.reconnectInFlight;
    const gen = ++this.reconnectGeneration;
    const attempt = (async (): Promise<void> => {
      // Set the moment THIS attempt's own bound expires: the attempt
      // counts as failed (the backoff below re-drives) AND its still-
      // pending connect() turns stale, so if the hung lookup ever does
      // settle it bails instead of adopting state over the retry.
      let timedOut = false;
      try {
        // NEVER reuse a stale engineUrl/token: re-run the gateway lookup —
        // after a takeover this lands on the NEW owner automatically (§9).
        // Issue #88: the attempt is TIME-BOUNDED. The lookup is a bare
        // fetch with no timeout of its own; a hung lookup previously
        // stalled the reconnect machinery forever (no settle → no catch
        // → no next backoff), which is exactly the field report behind
        // this issue: "Reconnect now did not recover in 35 s+".
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.connect(this.opened?.fileId ?? undefined, {
              isStale: () => timedOut || gen !== this.reconnectGeneration,
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(
                  new Error(
                    `reconnect attempt timed out after ${this.reconnectAttemptTimeoutMs}ms`,
                  ),
                );
              }, this.reconnectAttemptTimeoutMs);
              timer.unref?.();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch {
        // The current generation drives the backoff — including its own
        // timeout. A SUPERSEDED attempt (a Reconnect-now or disconnect
        // bumped the generation past it) stands down silently.
        if ((gen === this.reconnectGeneration || timedOut) && !this.intentionalClose) {
          this.handleDrop();
        }
      }
    })();
    this.reconnectInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this.reconnectInFlight === attempt) this.reconnectInFlight = null;
    }
  }

  // -- hello / catch-up / delta application -----------------------------------

  private async handleHello(hello: HelloEventData): Promise<void> {
    this.reconnectAttempt = 0;
    const stored = this.fileState.lastAppliedRev;
    if (stored === null) {
      // First connect for this file in this browser: the current state
      // arrived (or arrives) through the load hydration path; the delta
      // stream continues from the hello revision.
      this.fileState.lastAppliedRev = hello.revision;
      this.persist();
    } else if (stored < hello.revision) {
      await this.catchUp(stored, hello.revision);
    } else if (stored > hello.revision) {
      // Our base is ahead of this session (new session/re-owner with a
      // shorter journal): re-stream the confirmed layer.
      await this.resync(hello.revision);
    }
    this.setState('connected');
    this.startPresenceTimers();
    if (this.lastPresence) void this.postPresence(this.lastPresence);
    // Resubmit anything still queued (offline edits, lost acks) IN ORDER.
    this.clearQueueRetry();
    void this.flushQueue();
  }

  /**
   * Re-drive the durable queue after an HTTP refusal (429/5xx). A
   * refused /ops POST — the platform shedding load, a proxy error —
   * leaves the entry queued, but unlike a transport failure it never
   * drops the delta stream, so no reconnect/hello would ever flush the
   * queue again: the op stalled until the next reload (D6, 2026-10-22 —
   * the production one-edit-behind, where the platform 429'd /execute
   * under a concurrency cap). Bounded backoff, same shape as the
   * reconnect backoff; the flush itself stays strictly in order.
   */
  private scheduleQueueRetry(): void {
    if (this.intentionalClose || this.state !== 'connected') return;
    if (this.fileState.queue.length === 0) return;
    if (this.queueRetryTimer) return;
    const delay = Math.min(1000 * 2 ** this.queueRetryAttempt, 10_000);
    this.queueRetryAttempt++;
    this.queueRetryTimer = setTimeout(() => {
      this.queueRetryTimer = null;
      void this.flushQueue();
    }, delay);
  }

  private clearQueueRetry(): void {
    this.queueRetryAttempt = 0;
    if (this.queueRetryTimer) {
      clearTimeout(this.queueRetryTimer);
      this.queueRetryTimer = null;
    }
  }

  /**
   * Journal catch-up: GET /revisions?from&to, apply in order.
   * 409 before-retention → full re-stream (queue preserved, §1).
   */
  async catchUp(from: number, to: number): Promise<void> {
    if (this.catchingUp) return this.catchingUp;
    if (!this.opened || to <= from) return;
    this.catchingUp = (async () => {
      try {
        // Item L: through fetchOpenedWithRefresh, NOT raw engineFetch —
        // a stale-token 401 refreshes via the §9 lookup and retries
        // exactly once; a second 401 surfaces as the same
        // `revisions catch-up failed: 401` throw a raw 401 produced.
        // (The refresh's reconnect hello re-enters catchUp, which
        // dedupes onto this in-flight call — no recursion.)
        const res = await this.fetchOpenedWithRefresh(`/revisions?from=${from}&to=${to}`, {
          method: 'GET',
        });
        if (res.status === 409) {
          await this.resync(to);
          return;
        }
        if (!res.ok) throw new Error(`revisions catch-up failed: ${res.status}`);
        const body = (await res.json()) as { revisions?: RevisionEntry[] };
        const entries = [...(body.revisions ?? [])].sort((a, b) => a.revision - b.revision);
        for (const entry of entries) {
          if (entry.revision <= this.lastAppliedRev) continue;
          if (entry.revision !== this.lastAppliedRev + 1) {
            // Journal gap inside retention: cannot apply in order —
            // fall back to the full re-stream rather than skip.
            await this.resync(to);
            return;
          }
          this.applyDeltaNow({
            revision: entry.revision,
            origin: entry.origin ?? { clientId: null },
            cells: entry.cells ?? [],
          });
        }
        this.drainHeld();
      } finally {
        this.catchingUp = null;
      }
    })();
    return this.catchingUp;
  }

  /** Full re-stream of the CONFIRMED layer only; the queue survives. */
  private async resync(currentRevision: number): Promise<void> {
    const landed = await this.host.resync();
    this.fileState.lastAppliedRev = typeof landed === 'number' ? landed : currentRevision;
    this.held.clear();
    this.persist();
    try {
      this.deps.onResync?.();
    } catch {
      // listener only
    }
  }

  private async handleDelta(data: DeltaEventData): Promise<void> {
    if (data.revision <= this.lastAppliedRev) return; // duplicate
    if (data.revision > this.lastAppliedRev + 1) {
      // Gap: hold and fetch the missing revisions first — never skip.
      this.held.set(data.revision, data);
      await this.catchUp(this.lastAppliedRev, data.revision - 1);
      this.drainHeld();
      return;
    }
    this.applyDeltaNow(data);
    this.drainHeld();
  }

  private drainHeld(): void {
    for (;;) {
      const next = this.held.get(this.lastAppliedRev + 1);
      if (!next) break;
      this.held.delete(next.revision);
      this.applyDeltaNow(next);
    }
    // Still holding a later delta: the gap persists — fetch it again
    // (the first catch-up may have raced a concurrent one).
    if (this.held.size > 0) {
      const target = Math.min(...this.held.keys()) - 1;
      if (target > this.lastAppliedRev) {
        void this.catchUp(this.lastAppliedRev, target).then(() => this.drainHeld());
      }
    }
  }

  /** Apply one delta at exactly lastAppliedRev+1 to the confirmed layer. */
  private applyDeltaNow(data: DeltaEventData): void {
    // Confirmed layer first: the host seeds the read caches/mirror under
    // any provisional overlay, so an own cell keeps showing provisional
    // until the ack below clears it (§8).
    try {
      this.host.applyDeltaCells(data.cells ?? [], { revision: data.revision, origin: data.origin });
    } catch {
      // A host application failure must not corrupt sequencing; the
      // values remain fetchable through the host's read path.
    }
    this.fileState.lastAppliedRev = data.revision;
    this.persist();
    // Own-op ack: the delta for our op IS its ack — remove the queue
    // entry and settle its waiter (provisional state clears in the
    // routed-edit session when the waiter resolves).
    if (data.origin?.clientId === this.clientId && typeof data.origin.clientSeq === 'number') {
      this.ackQueueEntry(data.origin.clientSeq, data);
    }
    try {
      this.deps.onDelta?.(data);
    } catch {
      // listener only
    }
    void this.postDeltaAck(data.revision);
  }

  private ackQueueEntry(clientSeq: number, delta: DeltaEventData): void {
    const idx = this.fileState.queue.findIndex((e) => e.clientSeq === clientSeq);
    if (idx >= 0) {
      const [entry] = this.fileState.queue.splice(idx, 1);
      this.persist();
      try {
        this.deps.onAck?.(entry, delta);
      } catch {
        // listener only
      }
    }
    const waiter = this.waiters.get(clientSeq);
    if (waiter) {
      this.waiters.delete(clientSeq);
      waiter.resolve({ ok: true, ack: { revision: delta.revision, changedCellCount: delta.cells.length, checksum: '' } } as CommandResult);
    }
  }

  // -- ops submission -----------------------------------------------------------

  /**
   * Submit one engine command through POST /ops with the Phase 2
   * envelope { clientId, clientSeq, baseRev }. The op is durably queued
   * FIRST; the returned promise settles on the server ack (the /ops
   * response, or the op's own delta). Visible rejection resolves
   * { ok:false } (routedEdit performs the visible rollback) and retains
   * the input in the per-file rejected list.
   */
  submitCommand(cmd: EngineCommand): Promise<CommandResult> {
    if (!this.opened) {
      return Promise.resolve({ ok: false, error: 'collab transport is not connected' });
    }
    const entry: QueuedOp = {
      clientSeq: ++this.fileState.clientSeq,
      cmd,
      baseRev: this.lastAppliedRev,
      enqueuedAt: Date.now(),
    };
    this.fileState.queue.push(entry);
    this.persist();
    const promise = new Promise<CommandResult>((resolve) => {
      this.waiters.set(entry.clientSeq, { resolve });
    });
    if (this.state === 'connected') void this.postEntry(entry);
    return promise;
  }

  /** POST one queued entry; settle its waiter on ack/rejection. */
  private async postEntry(entry: QueuedOp): Promise<void> {
    if (!this.opened) return;
    // The op is submitted with its ORIGINAL baseRev — the last revision
    // the sender had seen when the op was authored (design doc §7).
    // Refreshing it to the current applied revision on resubmission
    // would defeat the sequencer's rebase: an offline op authored
    // before a concurrent structural edit must arrive with its stale
    // baseRev so the server transforms its coordinates (leg-a S6
    // failure, 2026-10-21: bob's A5 edit landed unrebased at A5 after
    // alice's row insert because the flush had refreshed baseRev past
    // the insert). Neither the content NOR the baseRev is modified.
    this.persist();
    let res: Response;
    try {
      // Item L: through fetchOpenedWithRefresh, NOT raw engineFetch —
      // a 401 from a stale handshake token (600 s TTL, SSE still open)
      // refreshes the session via the §9 gateway lookup and retries
      // exactly once, resubmitting the op UNMODIFIED (same clientSeq,
      // same authored baseRev: the refresh changes only the token).
      // A second 401 falls through to the not-acked handling below —
      // the entry stays queued, exactly as a raw 401 behaved before.
      res = await this.fetchOpenedWithRefresh('/ops', {
        method: 'POST',
        makeBody: () =>
          JSON.stringify({
            clientId: this.clientId,
            clientSeq: entry.clientSeq,
            baseRev: entry.baseRev,
            cmd: entry.cmd,
          }),
      });
    } catch {
      // Transport failure: the entry stays queued; the reconnect cycle
      // (or the next flush) resubmits it in order.
      if (this.state === 'connected') this.handleDrop();
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      rejected?: boolean;
      reason?: string;
      revision?: number;
      ack?: { revision: number; changedCellCount: number; checksum: string };
      error?: string;
    } | null;
    if (body?.rejected || (res.status === 403 && body?.ok === false)) {
      const reason = body?.reason ?? body?.error ?? `rejected (${res.status})`;
      this.moveToRejected(entry, reason);
      const waiter = this.waiters.get(entry.clientSeq);
      if (waiter) {
        this.waiters.delete(entry.clientSeq);
        waiter.resolve({ ok: false, error: reason });
      }
      return;
    }
    if (!res.ok || !body?.ok) {
      // Not an ack and not a visible rejection (429/5xx etc.): keep
      // queued AND schedule the retry — nothing else re-drives the
      // queue while the session stays connected (see scheduleQueueRetry).
      this.scheduleQueueRetry();
      return;
    }
    // Server ack (the /ops response): the entry may leave the queue.
    // (Its delta also acks it — ackQueueEntry is idempotent.)
    this.clearQueueRetry();
    const idx = this.fileState.queue.findIndex((e) => e.clientSeq === entry.clientSeq);
    if (idx >= 0) {
      this.fileState.queue.splice(idx, 1);
      this.persist();
    }
    const waiter = this.waiters.get(entry.clientSeq);
    if (waiter) {
      this.waiters.delete(entry.clientSeq);
      waiter.resolve({
        ok: true,
        ...(body.ack ? { ack: body.ack } : {}),
      } as CommandResult);
    }
  }

  private moveToRejected(entry: QueuedOp, reason: string): void {
    const idx = this.fileState.queue.findIndex((e) => e.clientSeq === entry.clientSeq);
    if (idx >= 0) this.fileState.queue.splice(idx, 1);
    const rejected: RejectedOp = { ...entry, reason, rejectedAt: Date.now() };
    this.fileState.rejected.push(rejected);
    this.persist();
    try {
      this.deps.onRejected?.(rejected);
    } catch {
      // listener only
    }
  }

  /** Remove a retained rejected op (user dismissed it in the UI). */
  clearRejected(clientSeq?: number): void {
    this.fileState.rejected =
      clientSeq === undefined
        ? []
        : this.fileState.rejected.filter((e) => e.clientSeq !== clientSeq);
    this.persist();
  }

  /** Resubmit the durable queue IN ORDER (reconnect / hello / manual). */
  async flushQueue(): Promise<void> {
    if (this.state !== 'connected') return;
    for (const entry of [...this.fileState.queue]) {
      if (!this.fileState.queue.some((e) => e.clientSeq === entry.clientSeq)) continue;
      await this.postEntry(entry);
      // Not acked and not rejected (still queued): STOP — later ops
      // must not overtake it; the next flush/reconnect retries in order.
      if (this.fileState.queue.some((e) => e.clientSeq === entry.clientSeq)) return;
      if (this.state !== 'connected') return;
    }
  }

  /**
   * CollabBridge broadcast path: a local op authored through the bridge
   * goes out via /ops. When the host already submits bridge edits
   * through submitCommand (bridgeSubmitEnabled=false) this records
   * nothing and submits nothing — no double submission.
   */
  submitBridgeOp(op: CollabOp): boolean {
    if (!this.bridgeSubmitEnabled || !this.opened) return false;
    const cmd = collabOpToCommand(op);
    if (!cmd) return false;
    void this.submitCommand(cmd);
    return true;
  }

  /**
   * Session-extras sync through the collab channel (Worker F, defect
   * F3): POST /session-extras DIRECTLY to the owning engine with this
   * transport's session-scoped token. The gateway-proxied variant
   * (GatewayClient.engineSessionExtras) targets the gateway's proxy
   * session, which does not exist for a Phase 2 file session in signed
   * mode — every such call 401s and the extras never land, leaving the
   * server's autosave flushes blind (design doc §5). Returns false when
   * the transport is not connected (caller may fall back to the proxied
   * path for legacy sessions).
   */
  async postSessionExtras(extras: unknown): Promise<boolean> {
    if (!this.opened || this.state !== 'connected') return false;
    try {
      // Item L: through fetchOpenedWithRefresh, NOT raw engineFetch —
      // a stale-token 401 refreshes via the §9 lookup and retries
      // exactly once; a second 401 (or a failed refresh) still lands in
      // the catch below and returns false, exactly as before.
      const res = await this.fetchOpenedWithRefresh('/session-extras', {
        method: 'POST',
        makeBody: () => JSON.stringify(extras ?? {}),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Live OLAP pivot query (#114, Piece 3): POST /session/olap-query
   * DIRECTLY to the owning engine with this transport's session-scoped
   * token (same direct-channel pattern as postSessionExtras — the
   * gateway-proxied variant does not exist for a Phase 2 file session
   * in signed mode). Through fetchOpenedWithRefresh, so a stale-token
   * 401 refreshes via the §9 lookup and retries once. Returns null
   * when no file session is open, the query is refused (404/409), or
   * the call fails — the caller keeps the cached pivot values.
   */
  async olapQuery(query: {
    pivotName: string;
    sheetId?: number;
    selected: string[];
  }): Promise<{
    pivotName: string;
    sheetName: string;
    anchor: { startRow: number; startCol: number; endRow: number; endCol: number };
    valueLabels: string[];
    rowKeys: string[];
    data: (number | string | null)[][];
  } | null> {
    if (!this.opened) return null;
    try {
      const res = await this.fetchOpenedWithRefresh('/session/olap-query', {
        method: 'POST',
        makeBody: () =>
          JSON.stringify({
            sessionId: this.requireOpened().sessionId,
            pivotName: query.pivotName,
            ...(query.sheetId !== undefined ? { sheetId: query.sheetId } : {}),
            selected: query.selected,
          }),
      });
      if (!res.ok) return null;
      return (await res.json()) as {
        pivotName: string;
        sheetName: string;
        anchor: { startRow: number; startCol: number; endRow: number; endCol: number };
        valueLabels: string[];
        rowKeys: string[];
        data: (number | string | null)[][];
      };
    } catch {
      return null;
    }
  }

  /**
   * Download metadata through the collab channel (same defect family
   * as F3, found in Phase 2 validation): the whole-workbook download
   * flow (doc §4: save first, then fetch bytes via a gateway-issued
   * signed URL) starts with a POST /download METADATA call. Through
   * the gateway proxy that call forwards the user's gateway JWT, which
   * the signed-mode engine refuses as a malformed access token (401) —
   * downloads were impossible for Phase 2 file sessions. Direct to the
   * owning engine with this transport's session-scoped token it
   * succeeds. Only the metadata call moves; the gateway still issues
   * the signed storage URL and the bytes still come from storage.
   * Unlike postSessionExtras this gates on `opened` only: it is a
   * user-initiated request/response, valid whenever we hold the
   * session token (SSE state is irrelevant). Returns null when no
   * file session is open (caller falls back to the proxied path).
   */
  async downloadMetadata(extras: unknown): Promise<Record<string, unknown> | null> {
    if (!this.opened) return null;
    try {
      // D2: through fetchOpenedWithRefresh, NOT raw engineFetch — the
      // handshake token's TTL (ENGINE_ACCESS_TTL_SECONDS, 600s default)
      // lapses in any long-lived session whose SSE never reconnects
      // (the connection was established pre-expiry and stays open), so
      // a stale-token 401 here must refresh the session (fresh gateway
      // lookup, §9) and retry once, exactly like the load family. On
      // the old raw call the 401 silently nulled and the caller fell
      // back to the gateway-proxied download, whose gateway JWT the
      // signed-mode engine refuses — the Download button 401'd for
      // drop-opened sessions while the session looked fully live.
      const res = await this.fetchOpenedWithRefresh('/download', {
        method: 'POST',
        makeBody: () => JSON.stringify(extras ?? {}),
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Download BYTES through the collab channel (residual (p), same F3
   * defect family as downloadMetadata): the engine's /download has two
   * response classes — whole-workbook .xlsx returns JSON metadata
   * (the save-first class, served by downloadMetadata above) while
   * named-range subsets and the non-xlsx formats (csv/tsv/ods/xlsb/
   * html) return the serialized bytes in the response body. Those
   * byte classes were left on the gateway-proxied branch, which
   * forwards the user's gateway JWT — a signed-mode engine refuses it
   * as a malformed access token, so every named-range / non-xlsx
   * export 401'd for Phase 2 file sessions. Direct to the owning
   * engine with this transport's session-scoped token they succeed
   * (design doc §9: the client connects directly to the owner and the
   * engine validates the token itself; §4: workbook bytes are never
   * proxied through the gateway in the download path). Returns null
   * when no file session is open, on any engine error, or when the
   * engine answers JSON (the metadata class — never hand JSON to the
   * user as file bytes); the caller falls back to the proxied path
   * for legacy/proxy sessions, where that path still works.
   */
  async downloadBytes(extras: unknown): Promise<Blob | null> {
    if (!this.opened) return null;
    try {
      // D2: fetchOpenedWithRefresh for the same stale-token reason as
      // downloadMetadata above — a byte export attempted after the
      // handshake token's TTL lapses must refresh + retry once instead
      // of silently falling back to the 401-broken proxied branch.
      const res = await this.fetchOpenedWithRefresh('/download', {
        method: 'POST',
        makeBody: () => JSON.stringify(extras ?? {}),
      });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) return null;
      return await res.blob();
    } catch {
      return null;
    }
  }

  // -- direct load (post-handshake load path, design doc §9 step 4) ------------

  private requireOpened(): EngineOpenResult {
    if (!this.opened) throw new Error('collab transport is not connected');
    return this.opened;
  }

  /**
   * Re-run the gateway lookup for the SAME file (fresh token — and the
   * current owner endpoint, §9: endpoints are leased, never permanent).
   * Used when the engine refuses the handshake token (401: expired
   * between handshake and load).
   */
  private async refreshOpened(): Promise<void> {
    await this.connect(this.opened?.fileId ?? undefined);
  }

  /**
   * One direct engine fetch with the CURRENT handshake token; on 401,
   * refresh the opened session once and retry exactly once (a second
   * 401 is surfaced to the caller, never looped). The body is built by
   * a factory so the retry carries the FRESH session's id/token, never
   * the stale pair.
   */
  private async fetchOpenedWithRefresh(
    path: string,
    init: { method: string; makeBody?: () => string },
    retried = false,
  ): Promise<Response> {
    const opened = this.requireOpened();
    const body = init.makeBody?.();
    const res = await this.fetchFn(`${opened.engineUrl}${path}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opened.accessToken}`,
      },
      ...(body !== undefined ? { body } : {}),
    });
    if (res.status === 401 && !retried) {
      await this.refreshOpened();
      return this.fetchOpenedWithRefresh(path, init, true);
    }
    return res;
  }

  /**
   * Load workbook bytes DIRECTLY into the opened session (§9 step 4:
   * after the join handshake the client connects directly to the owner
   * engine and presents the handshake token — the load rides that same
   * direct connection). The engine enforces body.sessionId ===
   * token.sid on /load; here the token IS the handshake token and the
   * body carries the claimed sessionId, so the rule holds by
   * construction (Worker A's curl proof: this exact call returns 200).
   *
   * The gateway-proxied Phase-1 load endpoints (/api/engine/load,
   * /api/engine/load/stream) must NOT serve a handshake-opened session:
   * the proxy forwards the caller's gateway JWT, which the signed-mode
   * engine refuses (401) — the §10 Scenario-1 defect, where the
   * workbook never loaded and the blank claimed session stayed live.
   * RemoteEngineHost prefers these direct methods whenever a collab
   * session is opened; the legacy transports keep serving sessions no
   * handshake opened (Phase 1 flows, unchanged).
   */
  async loadXlsxDirect(
    base64: string,
    format: 'xlsx' | 'csv' | 'xls' = 'xlsx',
  ): Promise<EngineLoadResult> {
    const res = await this.fetchOpenedWithRefresh('/load', {
      method: 'POST',
      makeBody: () =>
        JSON.stringify({ format, data: base64, sessionId: this.requireOpened().sessionId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`engine ${res.status}: load failed: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as EngineLoadResult;
  }

  /**
   * Load an uploaded workbook DIRECTLY on the claimed session by its
   * storage reference (shell integration): POST {engineUrl}/load/storage-ref
   * with the handshake token — the engine resolves the bytes from the
   * upload store itself, so no workbook bytes cross this client. This is
   * the first-open path for Workspace catalog uploads: the file was
   * uploaded through the gateway's staging flow (bytes in the upload
   * store, catalog record with a storageRef) and has never been loaded
   * into an engine session. The caller (App's join flow) drives it ONLY
   * on a fresh claim (joined=false, revision 0) for a record with a
   * storageRef and no stored state — a joined or rehydrated session
   * already holds the workbook and must never be reloaded under it.
   * `format` is the record's sourceFormat: 'csv' converts via the
   * engine's csv-adapter path (sourceName names the resulting sheet);
   * 'xls' parses via the engine's SheetJS/BIFF path (sweep F-2).
   */
  async loadStorageRefDirect(ref: {
    bucket?: string;
    object: string;
    format?: 'xlsx' | 'csv' | 'xls';
    sourceName?: string;
  }): Promise<EngineLoadResult> {
    const res = await this.fetchOpenedWithRefresh('/load/storage-ref', {
      method: 'POST',
      makeBody: () =>
        JSON.stringify({
          ...(ref.bucket ? { bucket: ref.bucket } : {}),
          object: ref.object,
          format: ref.format ?? 'xlsx',
          ...(ref.sourceName ? { name: ref.sourceName } : {}),
          sessionId: this.requireOpened().sessionId,
        }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`engine ${res.status}: storage-ref load failed: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as EngineLoadResult;
  }

  /**
   * Reset DIRECTLY on the claimed session with the handshake token
   * (§9 pattern, mirroring loadXlsxDirect): POST {engineUrl}/reset on
   * the owner engine — the engine's /reset route scopes by token (it
   * adopts accessClaims.sid as the session and binds state.fileId from
   * accessClaims.fid), so no body is needed. The legacy transport
   * reset must NOT serve a handshake-opened session because it mints a
   * fresh anonymous session via /api/engine/access and resets that
   * instead, stranding the new file's claim (Worker C's F6).
   * RemoteEngineHost prefers this direct method whenever a collab
   * session is opened; the legacy transports keep serving sessions no
   * handshake opened (Phase 1 flows, unchanged).
   */
  async resetDirect(): Promise<void> {
    const res = await this.fetchOpenedWithRefresh('/reset', { method: 'POST' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`engine ${res.status}: reset failed: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Progressive variant: POST {engineUrl}/load/stream (NDJSON chunks in
   * the server's schema), accumulated with mergeLoadChunks exactly like
   * the other transports, so RemoteEngineHost's chunk handling (view
   * seeding, progress, Calculating…) is identical. A stream that cannot
   * open or dies before any chunk falls back to loadXlsxDirect and
   * reports one synthetic terminal chunk; a 401 before the first chunk
   * refreshes the handshake token and retries the stream once.
   *
   * The stream endpoint itself is xlsx-only (its chunk parser is
   * ZIP-shaped), so a non-xlsx `format` ('xls', sweep F-2) fails the
   * stream attempt fast and rides the loadXlsxDirect fallback with the
   * same format — the engine's /load parses it there.
   */
  async loadXlsxProgressiveDirect(
    base64: string,
    onChunk: (accumulated: EngineLoadResult, done: boolean, chunk: ProgressiveLoadChunk) => void,
    retried = false,
    format: 'xlsx' | 'csv' | 'xls' = 'xlsx',
  ): Promise<EngineLoadResult> {
    const opened = this.requireOpened();
    let accumulated: EngineLoadResult | null = null;
    let calculating = false;
    let streamError: string | null = null;
    const emit = (raw: RawStreamChunk): EngineLoadResult => {
      accumulated = mergeLoadChunks(accumulated, raw);
      if (raw.type === 'data-done') calculating = true;
      if (raw.type === 'built') calculating = false;
      if (raw.type === 'error') streamError = raw.error;
      const progress =
        raw.type === 'data-done'
          ? { ...raw.progress, totalCells: raw.totalCells }
          : 'progress' in raw
            ? raw.progress
            : undefined;
      onChunk(accumulated, raw.type === 'built', {
        rawType: raw.type,
        progressPct: streamProgressPct(progress),
        calculating,
        ...(streamError ? { streamError } : {}),
        raw,
      });
      return accumulated;
    };
    try {
      const res = await this.fetchFn(`${opened.engineUrl}/load/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opened.accessToken}`,
        },
        body: JSON.stringify({ format, data: base64, sessionId: opened.sessionId }),
      });
      if (res.status === 401) {
        if (!retried) {
          await this.refreshOpened();
          return this.loadXlsxProgressiveDirect(base64, onChunk, true, format);
        }
        throw new Error('engine access token rejected (401)');
      }
      if (!res.ok || !res.body) throw new Error(`engine ${res.status}: load/stream unavailable`);
      // Byte-level NDJSON line splitting (same approach as the signed
      // transport: 0x0A can never appear inside a UTF-8 multibyte
      // sequence, so lines assemble exactly once per byte).
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let parts: Uint8Array[] = [];
      let partsLen = 0;
      const deliverBytes = (lineBytes: Uint8Array): void => {
        const line = decoder.decode(lineBytes);
        if (!line.trim()) return;
        try {
          emit(JSON.parse(line) as RawStreamChunk);
        } catch (e) {
          console.warn('[collab-transport] stream chunk dropped:', e);
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        let start = 0;
        for (;;) {
          const nl = value.indexOf(10, start);
          if (nl < 0) break;
          if (partsLen === 0) {
            if (nl > start) deliverBytes(value.subarray(start, nl));
          } else {
            const lineBytes = new Uint8Array(partsLen + (nl - start));
            let off = 0;
            for (const p of parts) {
              lineBytes.set(p, off);
              off += p.length;
            }
            lineBytes.set(value.subarray(start, nl), off);
            parts = [];
            partsLen = 0;
            deliverBytes(lineBytes);
          }
          start = nl + 1;
        }
        if (start < value.length) {
          const rest = value.slice(start);
          parts.push(rest);
          partsLen += rest.length;
        }
      }
      if (streamError) throw new Error(streamError);
      if (accumulated) return accumulated;
      throw new Error('load/stream ended without a terminal chunk');
    } catch (e) {
      // Issue #18: same rule as the other progressive loaders — an
      // engine-reported load failure (stream error chunk) surfaces as
      // a failure, never as the partial/empty accumulation.
      if (streamError) throw e instanceof Error ? e : new Error(streamError);
      if (accumulated) return accumulated;
      if (!retried && e instanceof Error && /401/.test(e.message)) {
        await this.refreshOpened();
        return this.loadXlsxProgressiveDirect(base64, onChunk, true, format);
      }
      // No usable stream (endpoint absent / transport failure before any
      // chunk): the direct /load response is the documented fallback.
      const full = await this.loadXlsxDirect(base64, format);
      accumulated = mergeLoadChunks(null, { type: 'built', response: full });
      onChunk(accumulated, true, { rawType: 'fallback' });
      return accumulated;
    }
  }

  /**
   * Release the opened session on the owning engine and forget it
   * locally (claim hygiene): when the CREATOR's load fails, the blank
   * claimed session must not stay live — a live blank session makes
   * the single-session engine refuse (409) every subsequent open of a
   * different file until it expires. The engine's release checkpoints
   * and clears its registry lease, so the file can be claimed cleanly
   * again. Only the creator releases — a joiner never tears down a
   * session it does not own; the caller decides via the handshake's
   * `joined` flag. Best-effort: the local session is forgotten either
   * way. Resolves with whether the engine acknowledged the release.
   */
  async releaseOpenedSession(reason: string): Promise<boolean> {
    const opened = this.opened;
    if (!opened) return false;
    let ok = false;
    try {
      // Item L: through fetchOpenedWithRefresh, NOT raw engineFetch.
      // This is a normal AWAITED call (supersede / load-failure claim
      // hygiene), not the page-unload beacon path — releaseOnUnload
      // below is the beacon, and it cannot refresh by design (fire-
      // and-forget, ?access_token= query auth; left unchanged). Here
      // a stale-token 401 refreshes via the §9 lookup and retries
      // exactly once: before this, a post-TTL release silently failed
      // (ok=false) and the blank claim stayed live on the engine,
      // 409-ing every later open of a different file until expiry —
      // the exact failure this method exists to prevent. The body
      // factory names the CURRENT session per attempt (the house
      // pattern): a refresh re-joins the same live session, so the
      // release target is unchanged; only the token is fresh.
      const res = await this.fetchOpenedWithRefresh('/session/release', {
        method: 'POST',
        makeBody: () =>
        JSON.stringify({
          sessionId: this.requireOpened().sessionId,
          reason,
          clientInstanceId: clientInstanceId(),
        }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    this.disconnect();
    // Forget the local session for THIS file. The old identity check
    // (this.opened === opened) breaks under the refresh: a 401 swaps
    // this.opened for the fresh handshake object of the same session
    // before the retry. Comparing by fileId forgets in both cases and
    // still refuses to clobber a different file's session that
    // replaced this one concurrently.
    if (this.opened?.fileId === opened.fileId) this.opened = null;
    return ok;
  }

  /**
   * Save the live session's workbook into the engine's library store
   * DIRECTLY on the claimed session, returning the stored entry.
   * This lane exists because the gateway-proxied
   * /api/engine/library-save cannot work in signed engine-access
   * mode: the gateway forwards the caller's gateway JWT verbatim and
   * the engine rejects it (401 — verified live 2026-10-22; the direct
   * call below with the session's access token returns 200). Every
   * other session call already travels this direct lane.
   */
  async librarySaveDirect(name: string): Promise<{
    id: string;
    name: string;
    sizeBytes: number;
    modifiedAt: number;
  }> {
    if (!this.opened) throw new Error('library save requires an opened session');
    const res = await this.fetchOpenedWithRefresh('/library-save', {
      method: 'POST',
      makeBody: () => JSON.stringify({ format: 'xlsx', name }),
    });
    const body = await res.text().catch(() => '');
    if (res.status !== 200) {
      throw new Error(`engine ${res.status}: library save failed: ${body.slice(0, 200)}`);
    }
    const parsed = (body ? JSON.parse(body) : null) as {
      entry?: { id: string; name: string; sizeBytes: number; modifiedAt: number };
    } | null;
    if (!parsed?.entry) throw new Error('library save returned no entry');
    return parsed.entry;
  }

  /**
   * Library save through the collab channel (the general-save sibling
   * of librarySaveDirect above): the NORMAL library save —
   * saveWorkbookToServerLibrary, i.e. Ctrl+S and the gateway autosave
   * path — carries an entry id plus the session extras
   * (buildServerSaveExtras), which librarySaveDirect's name-only shape
   * cannot express. Same defect family as F3/(p): the gateway-proxied
   * /api/engine/library-save forwards the user's gateway JWT, which
   * the signed-mode engine refuses as a malformed access token (401,
   * curl-proven by shell integration), so with a live Phase 2 file
   * session the save must go DIRECT to the owning engine with this
   * transport's session-scoped token (design doc §9; §4: a
   * client-initiated save is a signal only — the request carries
   * extras + entry id/name, never workbook bytes, and the engine
   * serializes its own live model). Like downloadMetadata this gates
   * on `opened` only (a user-initiated request/response; SSE state is
   * irrelevant) and returns null when no file session is open or the
   * engine call fails, so GatewayClient.engineLibrarySave falls back
   * to the proxied call for legacy/proxy sessions. Through
   * fetchOpenedWithRefresh for the D2 reason: a save attempted after
   * the handshake token's TTL lapses must refresh + retry once instead
   * of failing on the stale token.
   */
  async librarySave(
    payload: EngineLibrarySavePayload & { format?: string },
  ): Promise<EngineLibrarySaveResult['entry'] | null> {
    if (!this.opened) return null;
    try {
      const res = await this.fetchOpenedWithRefresh('/library-save', {
        method: 'POST',
        makeBody: () => JSON.stringify({ format: 'xlsx', ...payload }),
      });
      if (!res.ok) return null;
      const parsed = (await res.json().catch(() => null)) as {
        entry?: EngineLibrarySaveResult['entry'];
      } | null;
      return parsed?.entry ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Library-entry BYTES through the collab channel (the open sibling
   * of librarySave above): handleLibraryOpenEntry opens a
   * gateway-stored entry by fetching its stored .xlsx bytes. Through
   * the gateway proxy that fetch forwards the user's gateway JWT,
   * which the signed-mode engine refuses as a malformed access token
   * (401, curl-proven by the library-save worker) — opening a workbook
   * from the library failed for Phase 2 file sessions exactly as
   * Ctrl+S library save did. Direct to the owning engine with this
   * transport's session-scoped token it succeeds: the engine's
   * GET /library/:id is PRINCIPAL-scoped (the entry must belong to
   * the token's principal; it is not file-scoped), and the signed
   * session-scope gate (token sid === the engine's live session) is
   * satisfied by construction because this transport's opened session
   * IS that live session. Like librarySave this gates on `opened`
   * only and returns null when no file session is open or the engine
   * call fails, so GatewayClient.engineLibraryBytes falls back to the
   * proxied call for legacy/proxy sessions. (With NO session open
   * anywhere there is no token to ride and the engine gate refuses
   * library reads outright — a bytes fetch cannot precede the §9
   * handshake; see the fix report's named remaining sub-case.)
   * Through fetchOpenedWithRefresh for the D2 reason: a fetch
   * attempted after the handshake token's TTL lapses must refresh +
   * retry once instead of failing on the stale token. An engine JSON
   * answer is an error class, never workbook bytes — return null
   * rather than hand JSON to the open path as a file.
   */
  async libraryBytes(id: string): Promise<Blob | null> {
    if (!this.opened) return null;
    try {
      const res = await this.fetchOpenedWithRefresh(`/library/${encodeURIComponent(id)}`, {
        method: 'GET',
      });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) return null;
      return await res.blob();
    } catch {
      return null;
    }
  }

  /**
   * Bind the live session to the library entry it was opened from,
   * DIRECTLY on the claimed session (the open-flow sibling of
   * librarySave): handleLibraryOpenEntry calls
   * GatewayClient.engineBindLibrary after every gateway library open
   * so server AutoSave checkpoints commit into the user's entry
   * itself. The proxied /api/engine/session-bind-library forwards the
   * gateway JWT, which the signed-mode engine refuses (401) — the
   * call is fire-and-forget, so the bind silently never happened and
   * checkpoints for a library-opened workbook landed only in the
   * session-internal autosave entry. The engine handler binds its
   * CURRENT live session to an entry owned by the caller's
   * principal, so calling it over this transport — which holds
   * exactly that live session, opened by openRemoteBuffer moments
   * earlier — is semantically exact. Gates on `opened` only; returns
   * null when no file session is open or the engine call fails, so
   * the caller falls back to the proxied call for legacy/proxy
   * sessions. Through fetchOpenedWithRefresh for the D2 reason.
   */
  async bindLibrary(
    id: string,
    name?: string,
  ): Promise<{ ok: true; boundLibraryId: string } | null> {
    if (!this.opened) return null;
    try {
      const res = await this.fetchOpenedWithRefresh('/session-bind-library', {
        method: 'POST',
        makeBody: () => JSON.stringify(name !== undefined ? { id, name } : { id }),
      });
      if (!res.ok) return null;
      const parsed = (await res.json().catch(() => null)) as {
        boundLibraryId?: unknown;
      } | null;
      if (typeof parsed?.boundLibraryId !== 'string') return null;
      return { ok: true, boundLibraryId: parsed.boundLibraryId };
    } catch {
      return null;
    }
  }

  // -- presence -----------------------------------------------------------------

  /** Send presence for a selection (debounced; heartbeat re-sends). */
  sendPresence(pos: { sheet: string; row: number; col: number; editing?: boolean }): void {
    this.lastPresence = pos;
    if (this.state !== 'connected') return;
    if (this.presenceDebounce) clearTimeout(this.presenceDebounce);
    this.presenceDebounce = setTimeout(() => {
      this.presenceDebounce = null;
      if (this.lastPresence) void this.postPresence(this.lastPresence);
    }, 250);
  }

  private async postPresence(pos: { sheet: string; row: number; col: number; editing?: boolean }): Promise<void> {
    try {
      // Item L: through fetchOpenedWithRefresh, NOT raw engineFetch —
      // best-effort as before: at most one refresh + retry on a
      // stale-token 401, and any failure (incl. a failed refresh) is
      // swallowed by the catch below exactly as a failed raw send was.
      // A successful refresh also heals every later heartbeat, which
      // previously retried forever with the same stale token.
      await this.fetchOpenedWithRefresh('/presence', {
        method: 'POST',
        makeBody: () => {
          const name = this.deps.presenceDisplayName?.() ?? null;
          return JSON.stringify(
            typeof name === 'string' && name.trim().length > 0
              ? { ...pos, name: name.trim() }
              : pos,
          );
        },
      });
    } catch {
      // Presence is ephemeral: a failed send is retried by the heartbeat.
    }
  }

  /**
   * Page-unload session release (shell integration): full-page
   * navigation away from a file (a Workspace deep-link anchor, a shared
   * link) never runs the in-page supersede rule, so an attached
   * instance would stay counted on its engine — and one process hosts
   * one session, so the NEXT file's claim 409s ("engine already owns a
   * different file") until the idle rule fires. Every attached
   * instance therefore detaches itself on unload with its client
   * instance id; the engine refcount evicts the copy only when the
   * last instance detaches (addendum 2). Beacon, since the page
   * is going away: the engine accepts ?access_token= auth, and the
   * release checkpoints before it evicts, so the file reopens later
   * by rehydration (§9). Best-effort: if the beacon is lost, the
   * engine's idle eviction remains the backstop.
   */
  releaseOnUnload(): void {
    if (!this.opened || !this.sendBeaconFn) return;
    // Placement addendum 2 (owner 2026-10-23): EVERY attached instance
    // detaches on unload, not only the claim's creator — the engine
    // refcounts instances and evicts the copy only when the last one
    // detaches, so a joiner's beacon can no longer tear the session
    // down under its co-clients (the old creator-only latch existed
    // because a release used to evict unconditionally).
    try {
      const { engineUrl, accessToken, sessionId } = this.opened;
      const url = `${engineUrl}/session/release?access_token=${encodeURIComponent(accessToken)}`;
      const body = JSON.stringify({ sessionId, reason: 'page-unload', clientInstanceId: clientInstanceId() });
      this.sendBeaconFn(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    } catch {
      // best effort only
    }
  }

  /** Leave presence (pagehide): beacon, since the page is going away. */
  leavePresence(): void {
    if (!this.opened || !this.sendBeaconFn) return;
    try {
      const { engineUrl, accessToken } = this.opened;
      const url = `${engineUrl}/presence/leave?access_token=${encodeURIComponent(accessToken)}`;
      this.sendBeaconFn(url, new Blob([JSON.stringify({})], { type: 'text/plain;charset=UTF-8' }));
    } catch {
      // best effort only
    }
  }

  private startPresenceTimers(): void {
    this.stopPresenceTimers();
    this.presenceTimer = setInterval(() => {
      if (this.state === 'connected' && this.lastPresence) {
        void this.postPresence(this.lastPresence);
      }
    }, 10_000);
  }

  private stopPresenceTimers(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    if (this.presenceDebounce) clearTimeout(this.presenceDebounce);
    this.presenceDebounce = null;
  }

  // -- engine HTTP ----------------------------------------------------------------

  // Item L: the raw no-refresh engineFetch helper was retired when its
  // last six callers (postEntry, catchUp, postSessionExtras,
  // postPresence, releaseOpenedSession, postDeltaAck) moved to
  // fetchOpenedWithRefresh. Every direct engine call now goes through
  // the refresh-on-401 path — do not reintroduce a raw-token fetch.

  private async postDeltaAck(revision: number): Promise<void> {
    try {
      // Item L: through fetchOpenedWithRefresh, NOT raw engineFetch —
      // best-effort as before: at most one refresh + retry on a
      // stale-token 401; any failure (incl. a failed refresh) is
      // swallowed by the catch below exactly as before.
      await this.fetchOpenedWithRefresh('/deltas/ack', {
        method: 'POST',
        makeBody: () => JSON.stringify({ revision }),
      });
    } catch {
      // Retention input is best-effort; a missed ack only delays pruning.
    }
  }
}

function parseEventData<T>(ev: { data?: string }): T | null {
  if (!ev.data) return null;
  try {
    return JSON.parse(ev.data) as T;
  } catch {
    return null;
  }
}

/** Convert a bridge CollabOp to the engine command /ops carries. */
export function collabOpToCommand(op: CollabOp): EngineCommand | null {
  const p = op.params;
  const ref = (): CellRef => ({
    sheet: String(p['sheet'] ?? ''),
    row: Number(p['row'] ?? 0),
    col: Number(p['col'] ?? 0),
  });
  switch (op.type) {
    case 'cell.set': {
      const value = p['value'];
      if (typeof value === 'string' && value.startsWith('=')) {
        return { cmd: 'setFormula', ref: ref(), formula: value };
      }
      return { cmd: 'setCell', ref: ref(), value: (value ?? null) as never };
    }
    case 'cell.clear':
      return { cmd: 'setCell', ref: ref(), value: null as never };
    case 'sheet.add':
      return { cmd: 'addSheet', name: String(p['name'] ?? 'Sheet') };
    default:
      // Structural/sheet ops without a direct envelope mapping in this
      // client path: the bridge logs them; /ops submission covers the
      // cell + add-sheet commands the bridge authors today.
      return null;
  }
}

// Presence display-name helpers live in the dependency-free leaf
// ./presenceNames (Grid imports them; importing this module from Grid
// created a bundle initialization cycle). Re-exported here so
// existing consumers of this module's API are unaffected.
export { participantDisplayName, participantInitials } from './presenceNames';
