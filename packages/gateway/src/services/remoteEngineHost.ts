/**
 * Node RemoteEngineHost (FIX-B / F1): an EngineHost whose workbook lives
 * in the ENGINE SERVICE, reached over its HTTP API — the Node-side
 * counterpart of the web client's RemoteEngineHost
 * (apps/web/src/services/remoteEngine.ts) + SignedEngineTransport.
 *
 * Why here (packages/gateway/src/services): the import graph stays
 * acyclic. @icecream-sheets/engine is the protocol layer and must not
 * learn HTTP sessions or token signing; @icecream-sheets/mcp-server's
 * createServer accepts any EngineHost but cannot import the gateway
 * (the gateway depends on IT). The gateway package already owns the
 * engine service, the session registry and the engine-access signer —
 * so the host that binds them together lives with them, and agentSvc
 * hands it to createServer(host) exactly like the web app hands its
 * host to its local createServer.
 *
 * Discipline (mirrors the web client's collab transport):
 * - Every request carries a FRESH token from getAccessToken() as
 *   `Authorization: Bearer …` (the callback re-mints per need; a 401 is
 *   retried exactly once with a newly minted token). With no token
 *   (proxy-mode engines) the principal rides as `x-principal`, exactly
 *   like the gateway proxy stamps it. The engine service is the
 *   enforcement point: in signed mode it REPLACES identity with the
 *   token's claims (sub/sid/fid/role), so the agent acts AS THE USER
 *   (ai-agent.md §3) — a command's client-supplied `auth` is stripped
 *   here and never trusted.
 * - Mutating commands go through POST /ops with the Phase 2 envelope
 *   { clientId, clientSeq, baseRev }: clientSeq increments per op
 *   (the engine's idempotency key is clientId:clientSeq), baseRev is
 *   the last revision this host has SEEN (seeded from the registry /
 *   /session/status, advanced by every /ops ack) — never refreshed
 *   mid-flight, so a stale base is rebased by the sequencer (§7),
 *   exactly like the web transport. A visible rejection returns
 *   { ok:false }; a 409 before-retention updates the known revision
 *   and surfaces as an error for the NEXT op to build on.
 * - Non-mutating commands (recalculate, setParallelRecalcOptions, …)
 *   go through POST /execute, which assigns no revision.
 * - Reads go through POST /read ({kind:'cell'|'range'|'sheet'|
 *   'usedrange'}); snapshot through GET /snapshot; sheet names through
 *   GET /sheets.
 * - Like the web/IPC hosts, the async work hides behind the base
 *   class's synchronous signatures: execute()/readCell()/… return
 *   Promises at runtime (cast), and every in-repo caller of this host
 *   (the MCP tools) awaits them.
 * - subscribe() rides the engine's GET /events ring buffer on a poll
 *   (the legacy channel the web host used before SSE): engine events
 *   for ALL session activity — including the user's own grid edits —
 *   reach MCP subscriptions. Poll failures are swallowed (a dead
 *   engine must not crash the agent loop); the timer is unref'd and
 *   stops when the last listener leaves.
 */

import {
  Authorizer,
  ENGINE_PROTOCOL_VERSION,
  EngineHost,
  TypedView,
  allowAllPolicy,
  type AuthContext,
  type CellRef,
  type CommandResult,
  type AsyncCommandResult,
  type EngineCommand,
  type EngineEvent,
  type EngineEventListener,
  type RangeRef,
  type TypedCell,
  type TypedValue,
  type WorkbookSnapshot,
} from '@icecream-sheets/engine';

/** Minimal fetch surface (injectable for tests; defaults to global fetch). */
export interface RemoteEngineFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export interface RemoteEngineFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type RemoteEngineFetch = (
  url: string,
  init: RemoteEngineFetchInit,
) => Promise<RemoteEngineFetchResponse>;

const defaultFetch: RemoteEngineFetch = (url, init) =>
  fetch(url, init) as Promise<RemoteEngineFetchResponse>;

/**
 * Mutating commands: the engine service's SAVE_MUTATING_OPS set
 * (engineSvc.ts) — exactly the commands the sequencer assigns a
 * revision to. Mirrored here (the gateway services share a package but
 * engineSvc does not export its set); pinned by the remote-host tests.
 */
export const REMOTE_MUTATING_OPS: ReadonlySet<string> = new Set([
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

const EMPTY: TypedValue = { kind: 'null', value: null };

/** Per-process host instance counter (part of the /ops clientId nonce). */
let hostInstanceSeq = 0;

export interface NodeRemoteEngineHostOptions {
  /** Owning engine instance base URL (the registry record's ownerEndpoint). */
  engineUrl: string;
  /** The user the agent acts as ('user:<id>'). */
  principal: string;
  sessionId: string;
  fileId: string;
  /** /ops envelope client id base. Default `agent:<principal>`. The host
   * appends a per-instance nonce before use: the engine session dedups
   * ops by (clientId, clientSeq) for the life of the session, and
   * clientSeq restarts at 0 for every host instance — two instances
   * sharing one bare clientId would replay each other's cached /ops
   * results and silently drop real ops (case-7 fix, 2026-10-22). */
  clientId?: string;
  /**
   * Mint a fresh engine-access token for THIS session/principal, or
   * null when no signer is configured (proxy-mode engines then take
   * the x-principal header). Called on EVERY request — tokens are
   * short-lived by design and re-minted per need, never cached here.
   */
  getAccessToken: () => string | null | Promise<string | null>;
  /** Fetch override (tests). Default: global fetch. */
  fetchFn?: RemoteEngineFetch;
  /** Seed for the last-seen revision (registry currentRevision). */
  initialRevision?: number;
  /** /events poll cadence for subscribe(). Default 1500 ms (web legacy). */
  pollMs?: number;
  /**
   * #99 v2 (owner correction 2026-10-23): called when an engine call
   * proves the bound link dead — the ONLY signal that refreshes it.
   * 'unreachable' = fetch throw (engine down/moved); 'unauthorized' =
   * 401 AFTER the re-mint retry (the session/token itself is refused);
   * 'forbidden' = 403 (grant changed or action refused for this role);
   * 'not-found' = 404 (session absent). NOT called for 400/409/5xx:
   * request/transient failures leave the link itself valid. The
   * callback must never throw (it is invoked defensively); the agent
   * service uses it to mark the cached link stale so the NEXT turn
   * refreshes via exactly one registry lookup. The current turn is
   * unaffected — its failure surfaces honestly through the tool call.
   */
  onLinkRefusal?: (
    kind: 'unreachable' | 'unauthorized' | 'forbidden' | 'not-found',
  ) => void;
  /**
   * #99 v2 refinement (owner 2026-10-23 23:14) — PRIMARY GATE: when
   * true, this host refuses every mutating command BEFORE any engine
   * contact. EngineCommand is all mutations (reads travel through
   * readCell/readRange/readSheet/snapshot, never execute()), so the
   * gate covers the whole tool-write surface while reads pass
   * untouched. The agent service sets this from the user's resolved
   * role on the file (viewer => read-only); the engine's own per-call
   * token verification (#104) stays behind it as the secondary gate.
   * A capability refusal is NOT a link refusal: onLinkRefusal is never
   * invoked, so the bound link stays valid for later reads.
   */
  readOnly?: boolean;
}

interface CellReadPayload {
  value: TypedValue;
  formula?: string;
}

export class NodeRemoteEngineHost extends EngineHost {
  private readonly engineUrl: string;
  private readonly principal: string;
  private readonly sessionId: string;
  private readonly fileId: string;
  private readonly clientId: string;
  private readonly getAccessToken: NodeRemoteEngineHostOptions['getAccessToken'];
  private readonly fetchFn: RemoteEngineFetch;
  private readonly pollMs: number;
  private readonly onLinkRefusal: NodeRemoteEngineHostOptions['onLinkRefusal'];
  private readonly readOnly: boolean;
  /** Client-side stub: the engine service is the enforcement point. */
  private readonly stubAuthorizer = new Authorizer(allowAllPolicy());
  private readonly remoteView: NodeRemoteView;
  private readonly remoteListeners = new Set<EngineEventListener>();

  /** Last revision seen (null = not yet known; /session/status seeds it). */
  private knownRevision: number | null;
  private clientSeq = 0;
  private sheetNameCache: string[] | null = null;
  /** The one in-flight GET /sheets request, shared by every caller. */
  private sheetNamesFetch: Promise<string[]> | null = null;
  private cellCache = new Map<string, TypedCell>();
  private usedRangeCache = new Map<string, RangeRef | null>();
  private readonly fillsInFlight = new Set<string>();

  private lastSeq = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private disposed = false;

  constructor(opts: NodeRemoteEngineHostOptions) {
    // The local workbook is never used; every public method is overridden.
    super();
    this.engineUrl = opts.engineUrl.replace(/\/+$/, '');
    this.principal = opts.principal;
    this.sessionId = opts.sessionId;
    this.fileId = opts.fileId;
    this.clientId = `${opts.clientId ?? `agent:${opts.principal}`}:${(++hostInstanceSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.getAccessToken = opts.getAccessToken;
    this.fetchFn = opts.fetchFn ?? defaultFetch;
    this.pollMs = opts.pollMs ?? 1500;
    this.onLinkRefusal = opts.onLinkRefusal;
    this.readOnly = opts.readOnly ?? false;
    this.knownRevision =
      typeof opts.initialRevision === 'number' && Number.isFinite(opts.initialRevision)
        ? Math.max(0, Math.floor(opts.initialRevision))
        : null;
    this.remoteView = new NodeRemoteView(this);
  }

  get boundSessionId(): string {
    return this.sessionId;
  }
  get boundFileId(): string {
    return this.fileId;
  }
  get boundClientId(): string {
    return this.clientId;
  }
  /** Last-seen session revision (null until the first /ops or status read). */
  get lastKnownRevision(): number | null {
    return this.knownRevision;
  }

  // -- transport -------------------------------------------------------------

  /** Report a dead link to the owner of this host (defensive: never throws). */
  private reportLinkRefusal(
    kind: 'unreachable' | 'unauthorized' | 'forbidden' | 'not-found',
  ): void {
    try {
      this.onLinkRefusal?.(kind);
    } catch {
      // A callback bug must never mask the engine failure itself.
    }
  }

  private async request(
    path: string,
    init: { method: string; body?: unknown },
    retried = false,
  ): Promise<RemoteEngineFetchResponse> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    else headers['x-principal'] = this.principal;
    let res: RemoteEngineFetchResponse;
    try {
      res = await this.fetchFn(`${this.engineUrl}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (e) {
      // Engine unreachable (down, moved, refused connection): the
      // bound link is dead — #99 v2 refreshes it on the next turn.
      this.reportLinkRefusal('unreachable');
      throw e;
    }
    if (res.status === 401 && !retried) {
      // Stale/expired token: re-mint (the callback mints fresh per call)
      // and retry exactly once — the signed transport's discipline.
      return this.request(path, init, true);
    }
    if (res.status === 401 && retried) {
      // A 401 AFTER the re-mint retry means the session/token itself
      // is refused (released, moved, grant gone) — the link is dead.
      this.reportLinkRefusal('unauthorized');
    }
    return res;
  }

  private async requestJson<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) {
      // 403/404 prove the link dead (grant changed, session absent);
      // 400/409/5xx are request/transient failures — the link stands.
      if (res.status === 403) this.reportLinkRefusal('forbidden');
      else if (res.status === 404) this.reportLinkRefusal('not-found');
      const text = await res.text().catch(() => '');
      throw new Error(`remote engine ${init.method} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /** Seed the last-seen revision from /session/status (once, lazily). */
  private async ensureRevision(): Promise<number> {
    if (this.knownRevision !== null) return this.knownRevision;
    try {
      const status = await this.requestJson<{ revision?: unknown }>('/session/status', {
        method: 'GET',
      });
      this.knownRevision =
        typeof status.revision === 'number' && Number.isFinite(status.revision)
          ? Math.max(0, Math.floor(status.revision))
          : 0;
    } catch {
      // Status unreachable: base 0 — the sequencer rebases or visibly
      // rejects; the known revision is re-seeded by the /ops response.
      this.knownRevision = 0;
    }
    return this.knownRevision;
  }

  /** Public revision probe (also refreshes the seed after a rejection). */
  async refreshRevision(): Promise<number> {
    this.knownRevision = null;
    return this.ensureRevision();
  }

  // -- execute -----------------------------------------------------------------

  override execute(command: EngineCommand): CommandResult {
    // #99 v2 refinement — PRIMARY GATE: a read-only host refuses
    // every command BEFORE any engine contact (no fetch, no /ops, no
    // token use beyond what the caller already holds). The rejection
    // is a Promise per the async-runtime convention below: MCP tool
    // handlers await it and surface it as a tool error, never
    // 'Done.'. Reads never reach here (see the readOnly option doc).
    if (this.readOnly) {
      return Promise.reject(
        new Error(
          'refused: this workbook is read-only for the current user; writes are not permitted',
        ),
      ) as unknown as CommandResult;
    }
    // Async runtime (web/IPC host convention): the Promise is the honest
    // result; MCP tool handlers await it.
    return this.executeRemote(command) as unknown as CommandResult;
  }

  override async executeAsync(command: EngineCommand): Promise<AsyncCommandResult> {
    // Same primary gate as execute(): a read-only host never starts a
    // recalculation either (it mutates cached engine state).
    if (this.readOnly) {
      throw new Error(
        'refused: this workbook is read-only for the current user; writes are not permitted',
      );
    }
    // The SERVER decides how recalc runs (its own routing dispatch);
    // recalculateParallel is an ordinary /execute for the remote host.
    return this.executeRemote(command);
  }

  private async executeRemote(command: EngineCommand): Promise<CommandResult> {
    // Strip any client-supplied auth: identity comes from the token
    // (signed mode) or the x-principal header (proxy mode) — the engine
    // stamps it, never the caller.
    const { auth: _stripped, ...rest } = command as EngineCommand & { auth?: unknown };
    const cmd = rest as EngineCommand;

    if (REMOTE_MUTATING_OPS.has(cmd.cmd)) {
      return this.submitMutatingOp(cmd, false);
    }

    // Non-mutating: /execute assigns no revision and returns the
    // CommandResult shape directly.
    const res = await this.request('/execute', { method: 'POST', body: { cmd } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`remote engine /execute failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const payload = (await res.json().catch(() => null)) as CommandResult | null;
    if (!payload || typeof payload.ok !== 'boolean') {
      throw new Error('remote engine /execute returned a malformed result');
    }
    if (payload.ok) this.invalidateReadCaches();
    return payload;
  }

  /**
   * One mutating op through the /ops sequencer envelope.
   *
   * before-retention recovery (case-7 fix, 2026-10-22): the host's
   * revision seed goes stale whenever another client advances the
   * session and checkpoints prune the journal past it — the engine
   * then rejects with 409 before-retention. That is a SYNC problem,
   * not a semantic rejection: resync the seed (the rejection payload
   * carries the current revision; /session/status refresh otherwise)
   * and retry the op ONCE with a fresh clientSeq — the same
   * refresh-and-retry-once discipline as the 401 path. Every other
   * rejection (viewer role, obsolete, …) is terminal and visible.
   * Without this, the first op of any multi-op tool call (e.g.
   * open_data_source's addSheet) died on a stale seed and the whole
   * tool aborted.
   */
  private async submitMutatingOp(
    cmd: EngineCommand,
    retriedAfterResync: boolean,
  ): Promise<CommandResult> {
    const baseRev = await this.ensureRevision();
    const clientSeq = ++this.clientSeq;
    const res = await this.request('/ops', {
      method: 'POST',
      body: { clientId: this.clientId, clientSeq, baseRev, cmd },
    });
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      revision?: number;
      ack?: unknown;
      rejected?: boolean;
      reason?: string;
      error?: string;
    } | null;
    let adoptedRevision = false;
    if (payload && typeof payload.revision === 'number' && Number.isFinite(payload.revision)) {
      // Acks AND rejections both carry the sequencer's current
      // revision: the next op builds on it either way.
      this.knownRevision = Math.max(0, Math.floor(payload.revision));
      adoptedRevision = true;
    }
    if (res.ok && payload?.ok === true) {
      this.invalidateReadCaches();
      return {
        ok: true,
        data: {
          revision: payload.revision ?? this.knownRevision ?? baseRev + 1,
          ...(payload.ack !== undefined ? { ack: payload.ack } : {}),
        },
      };
    }
    if (payload && payload.ok === false) {
      if (payload.reason === 'before-retention' && !retriedAfterResync) {
        if (!adoptedRevision) await this.refreshRevision();
        return this.submitMutatingOp(cmd, true);
      }
      // Visible rejection (viewer role, obsolete, …): a CommandResult
      // failure, never a silent drop.
      return {
        ok: false,
        error: payload.reason ?? payload.error ?? `op rejected by engine (HTTP ${res.status})`,
      };
    }
    const text = await res.text().catch(() => '');
    throw new Error(`remote engine /ops failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  private invalidateReadCaches(): void {
    this.cellCache.clear();
    this.usedRangeCache.clear();
  }

  // -- reads -------------------------------------------------------------------

  override readCell(ref: CellRef, _auth?: AuthContext): TypedValue {
    return this.readCellRemote(ref) as unknown as TypedValue;
  }

  /** Async one-cell read (the runtime form of readCell). */
  async readCellAsync(ref: CellRef): Promise<TypedValue> {
    return this.readCellRemote(ref);
  }

  private async readCellRemote(ref: CellRef): Promise<TypedValue> {
    const payload = await this.requestJson<CellReadPayload>('/read', {
      method: 'POST',
      body: { kind: 'cell', ref },
    });
    this.cellCache.set(cellKey(ref), {
      ref,
      value: payload.value,
      ...(payload.formula !== undefined ? { formula: payload.formula } : {}),
    });
    return payload.value;
  }

  override readRange(range: RangeRef, _auth?: AuthContext): TypedValue[][] {
    return this.readRangeRemote(range) as unknown as TypedValue[][];
  }

  async readRangeAsync(range: RangeRef): Promise<TypedValue[][]> {
    return this.readRangeRemote(range);
  }

  private async readRangeRemote(range: RangeRef): Promise<TypedValue[][]> {
    const payload = await this.requestJson<{
      values: TypedValue[][];
      formulas: (string | null)[][];
    }>('/read', { method: 'POST', body: { kind: 'range', range } });
    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const value = payload.values[r - range.startRow]?.[c - range.startCol];
        if (value === undefined) continue;
        const formula = payload.formulas?.[r - range.startRow]?.[c - range.startCol];
        const ref = { sheet: range.sheet, row: r, col: c };
        this.cellCache.set(cellKey(ref), {
          ref,
          value,
          ...(typeof formula === 'string' ? { formula } : {}),
        });
      }
    }
    return payload.values;
  }

  override readSheet(sheet: string, _auth?: AuthContext): TypedValue[][] {
    return this.readSheetRemote(sheet) as unknown as TypedValue[][];
  }

  private async readSheetRemote(sheet: string): Promise<TypedValue[][]> {
    const payload = await this.requestJson<{ values: TypedValue[][] }>('/read', {
      method: 'POST',
      body: { kind: 'sheet', sheet },
    });
    return payload.values;
  }

  override getUsedRange(sheet: string): RangeRef | null {
    return this.usedRangeRemote(sheet) as unknown as RangeRef | null;
  }

  async usedRangeAsync(sheet: string): Promise<RangeRef | null> {
    return this.usedRangeRemote(sheet);
  }

  private async usedRangeRemote(sheet: string): Promise<RangeRef | null> {
    const payload = await this.requestJson<{ range: RangeRef | null }>('/read', {
      method: 'POST',
      body: { kind: 'usedrange', sheet },
    });
    const range = payload.range ?? null;
    this.usedRangeCache.set(sheet, range);
    return range;
  }

  override snapshot(): WorkbookSnapshot {
    return this.snapshotAsync() as unknown as WorkbookSnapshot;
  }

  /** Async snapshot: the permission-filtered GET /snapshot payload. */
  async snapshotAsync(): Promise<WorkbookSnapshot> {
    const snap = await this.requestJson<WorkbookSnapshot>('/snapshot', { method: 'GET' });
    this.sheetNameCache = snap.sheets.map((s) => s.name);
    return snap;
  }

  override sheetNames(): string[] {
    if (this.sheetNameCache) return [...this.sheetNameCache];
    void this.refreshSheetNames().catch(() => undefined);
    return [];
  }

  /**
   * Awaited sheet names (W1 — first-turn sheet-context failure): the
   * SYNC sheetNames() above is cache-only by contract (the base class
   * signature is synchronous), so on a fresh host it hands the caller
   * `[]` while a background fetch warms the cache — and once warm it
   * never notices grid-side renames/adds. A caller that AWAITS the
   * sheet list to make an authoritative decision (MCP create_chart
   * validating its target sheet) must use this instead: it performs
   * a FRESH GET /sheets, updates the cache, and returns the engine's
   * current list — never a cold or stale cache view. Concurrent
   * callers (including the background warm-up a sync call kicked
   * off) share the one in-flight request.
   */
  async sheetNamesAsync(): Promise<string[]> {
    return this.refreshSheetNames();
  }

  /** Refresh the sheet-name cache from GET /sheets (names only, cheap). */
  async refreshSheetNames(): Promise<string[]> {
    if (this.sheetNamesFetch) return this.sheetNamesFetch;
    const fetchPromise = (async (): Promise<string[]> => {
      const payload = await this.requestJson<{ sheets: string[] }>('/sheets', { method: 'GET' });
      this.sheetNameCache = [...payload.sheets];
      return [...this.sheetNameCache];
    })();
    this.sheetNamesFetch = fetchPromise;
    try {
      return await fetchPromise;
    } finally {
      if (this.sheetNamesFetch === fetchPromise) this.sheetNamesFetch = null;
    }
  }

  override currentRevision(): number {
    return this.knownRevision ?? 0;
  }

  // -- view (cache-only, web RemoteView semantics) ------------------------------

  override getView(): TypedView {
    return this.remoteView;
  }

  override getAuthorizer(): Authorizer {
    return this.stubAuthorizer;
  }

  override setHiddenCheck(): void {
    // No-op: hidden-cell enforcement lives in the engine service.
  }

  /** Cached cell for the view (undefined = never read through this host). */
  cachedCell(ref: CellRef): TypedCell | undefined {
    return this.cellCache.get(cellKey(ref));
  }

  cachedUsedRange(sheet: string): RangeRef | null | undefined {
    return this.usedRangeCache.get(sheet);
  }

  /** Fire-and-forget background fill for view reads (deduped per key). */
  backgroundFill(key: string, fill: () => Promise<unknown>): void {
    if (this.disposed || this.fillsInFlight.has(key)) return;
    this.fillsInFlight.add(key);
    void fill()
      .catch(() => undefined)
      .finally(() => this.fillsInFlight.delete(key));
  }

  // -- subscriptions: /events poll ----------------------------------------------

  override subscribe(listener: EngineEventListener): () => void {
    this.remoteListeners.add(listener);
    this.startPolling();
    return () => {
      this.remoteListeners.delete(listener);
      if (this.remoteListeners.size === 0) this.stopPolling();
    };
  }

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
    (this.pollTimer as { unref?: () => void }).unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const payload = await this.requestJson<{
        events: Array<{ seq: number; event: EngineEvent }>;
      }>(`/events?since=${this.lastSeq}`, { method: 'GET' });
      for (const { seq, event } of payload.events ?? []) {
        if (seq > this.lastSeq) this.lastSeq = seq;
        for (const l of [...this.remoteListeners]) {
          try {
            l(event);
          } catch {
            // A failing listener must not break the host.
          }
        }
      }
    } catch {
      // Poll failures are transient by definition (engine restart,
      // token rotation): the next tick retries.
    } finally {
      this.pollInFlight = false;
    }
  }

  override dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.remoteListeners.clear();
    super.dispose();
  }
}

function cellKey(ref: CellRef): string {
  return `${ref.sheet}\0${ref.row}\0${ref.col}`;
}

/**
 * Cache-only TypedView: render-style reads serve what the host's async
 * reads have already fetched and queue a background fill otherwise —
 * the web RemoteView's contract, minus the grid's repaint machinery
 * (the MCP tools use the host's awaited reads, not the view).
 */
class NodeRemoteView extends TypedView {
  constructor(private readonly host: NodeRemoteEngineHost) {
    // The local workbook is never used; every method is overridden.
    super(undefined as never);
  }

  override readCell(ref: CellRef): TypedCell {
    const cached = this.host.cachedCell(ref);
    if (cached) return cached;
    this.host.backgroundFill(`cell:${cellKey(ref)}`, async () => {
      await this.host.readCellAsync(ref);
    });
    return { ref, value: EMPTY };
  }

  override readRange(range: RangeRef): TypedCell[][] {
    const rows: TypedCell[][] = [];
    let missing = false;
    for (let r = range.startRow; r <= range.endRow; r++) {
      const row: TypedCell[] = [];
      for (let c = range.startCol; c <= range.endCol; c++) {
        const ref = { sheet: range.sheet, row: r, col: c };
        const cached = this.host.cachedCell(ref);
        if (!cached) missing = true;
        row.push(cached ?? { ref, value: EMPTY });
      }
      rows.push(row);
    }
    if (missing) {
      this.host.backgroundFill(
        `range:${range.sheet}:${range.startRow}:${range.startCol}:${range.endRow}:${range.endCol}`,
        async () => {
          await this.host.readRangeAsync(range);
        },
      );
    }
    return rows;
  }

  override readRangeValues(range: RangeRef): TypedValue[][] {
    return this.readRange(range).map((row) => row.map((cell) => cell.value));
  }

  override usedRange(sheet: string): RangeRef | null {
    const cached = this.host.cachedUsedRange(sheet);
    if (cached !== undefined) return cached;
    this.host.backgroundFill(`used:${sheet}`, async () => {
      await this.host.usedRangeAsync(sheet);
    });
    return null;
  }

  override readSheet(sheet: string): TypedValue[][] {
    const used = this.usedRange(sheet);
    if (!used) return [];
    return this.readRangeValues(used);
  }
}

// Re-exported so consumers can assert the protocol version they speak.
export { ENGINE_PROTOCOL_VERSION };
