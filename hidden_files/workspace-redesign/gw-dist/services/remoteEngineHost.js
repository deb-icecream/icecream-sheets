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
import { Authorizer, ENGINE_PROTOCOL_VERSION, EngineHost, TypedView, allowAllPolicy, } from '@icecream-sheets/engine';
const defaultFetch = (url, init) => fetch(url, init);
/**
 * Mutating commands: the engine service's SAVE_MUTATING_OPS set
 * (engineSvc.ts) — exactly the commands the sequencer assigns a
 * revision to. Mirrored here (the gateway services share a package but
 * engineSvc does not export its set); pinned by the remote-host tests.
 */
export const REMOTE_MUTATING_OPS = new Set([
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
const EMPTY = { kind: 'null', value: null };
export class NodeRemoteEngineHost extends EngineHost {
    engineUrl;
    principal;
    sessionId;
    fileId;
    clientId;
    getAccessToken;
    fetchFn;
    pollMs;
    /** Client-side stub: the engine service is the enforcement point. */
    stubAuthorizer = new Authorizer(allowAllPolicy());
    remoteView;
    remoteListeners = new Set();
    /** Last revision seen (null = not yet known; /session/status seeds it). */
    knownRevision;
    clientSeq = 0;
    sheetNameCache = null;
    /** The one in-flight GET /sheets request, shared by every caller. */
    sheetNamesFetch = null;
    cellCache = new Map();
    usedRangeCache = new Map();
    fillsInFlight = new Set();
    lastSeq = 0;
    pollTimer = null;
    pollInFlight = false;
    disposed = false;
    constructor(opts) {
        // The local workbook is never used; every public method is overridden.
        super();
        this.engineUrl = opts.engineUrl.replace(/\/+$/, '');
        this.principal = opts.principal;
        this.sessionId = opts.sessionId;
        this.fileId = opts.fileId;
        this.clientId = opts.clientId ?? `agent:${opts.principal}`;
        this.getAccessToken = opts.getAccessToken;
        this.fetchFn = opts.fetchFn ?? defaultFetch;
        this.pollMs = opts.pollMs ?? 1500;
        this.knownRevision =
            typeof opts.initialRevision === 'number' && Number.isFinite(opts.initialRevision)
                ? Math.max(0, Math.floor(opts.initialRevision))
                : null;
        this.remoteView = new NodeRemoteView(this);
    }
    get boundSessionId() {
        return this.sessionId;
    }
    get boundFileId() {
        return this.fileId;
    }
    get boundClientId() {
        return this.clientId;
    }
    /** Last-seen session revision (null until the first /ops or status read). */
    get lastKnownRevision() {
        return this.knownRevision;
    }
    // -- transport -------------------------------------------------------------
    async request(path, init, retried = false) {
        const token = await this.getAccessToken();
        const headers = { 'content-type': 'application/json' };
        if (token)
            headers['authorization'] = `Bearer ${token}`;
        else
            headers['x-principal'] = this.principal;
        const res = await this.fetchFn(`${this.engineUrl}${path}`, {
            method: init.method,
            headers,
            ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
        if (res.status === 401 && !retried) {
            // Stale/expired token: re-mint (the callback mints fresh per call)
            // and retry exactly once — the signed transport's discipline.
            return this.request(path, init, true);
        }
        return res;
    }
    async requestJson(path, init) {
        const res = await this.request(path, init);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`remote engine ${init.method} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        return (await res.json());
    }
    /** Seed the last-seen revision from /session/status (once, lazily). */
    async ensureRevision() {
        if (this.knownRevision !== null)
            return this.knownRevision;
        try {
            const status = await this.requestJson('/session/status', {
                method: 'GET',
            });
            this.knownRevision =
                typeof status.revision === 'number' && Number.isFinite(status.revision)
                    ? Math.max(0, Math.floor(status.revision))
                    : 0;
        }
        catch {
            // Status unreachable: base 0 — the sequencer rebases or visibly
            // rejects; the known revision is re-seeded by the /ops response.
            this.knownRevision = 0;
        }
        return this.knownRevision;
    }
    /** Public revision probe (also refreshes the seed after a rejection). */
    async refreshRevision() {
        this.knownRevision = null;
        return this.ensureRevision();
    }
    // -- execute -----------------------------------------------------------------
    execute(command) {
        // Async runtime (web/IPC host convention): the Promise is the honest
        // result; MCP tool handlers await it.
        return this.executeRemote(command);
    }
    async executeAsync(command) {
        // The SERVER decides how recalc runs (its own routing dispatch);
        // recalculateParallel is an ordinary /execute for the remote host.
        return this.executeRemote(command);
    }
    async executeRemote(command) {
        // Strip any client-supplied auth: identity comes from the token
        // (signed mode) or the x-principal header (proxy mode) — the engine
        // stamps it, never the caller.
        const { auth: _stripped, ...rest } = command;
        const cmd = rest;
        if (REMOTE_MUTATING_OPS.has(cmd.cmd)) {
            const baseRev = await this.ensureRevision();
            const clientSeq = ++this.clientSeq;
            const res = await this.request('/ops', {
                method: 'POST',
                body: { clientId: this.clientId, clientSeq, baseRev, cmd },
            });
            const payload = (await res.json().catch(() => null));
            if (payload && typeof payload.revision === 'number' && Number.isFinite(payload.revision)) {
                // Acks AND rejections both carry the sequencer's current
                // revision: the next op builds on it either way.
                this.knownRevision = Math.max(0, Math.floor(payload.revision));
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
                // Visible rejection (viewer role, obsolete, before-retention…):
                // a CommandResult failure, never a silent drop.
                return {
                    ok: false,
                    error: payload.reason ?? payload.error ?? `op rejected by engine (HTTP ${res.status})`,
                };
            }
            const text = await res.text().catch(() => '');
            throw new Error(`remote engine /ops failed: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        // Non-mutating: /execute assigns no revision and returns the
        // CommandResult shape directly.
        const res = await this.request('/execute', { method: 'POST', body: { cmd } });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`remote engine /execute failed: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        const payload = (await res.json().catch(() => null));
        if (!payload || typeof payload.ok !== 'boolean') {
            throw new Error('remote engine /execute returned a malformed result');
        }
        if (payload.ok)
            this.invalidateReadCaches();
        return payload;
    }
    invalidateReadCaches() {
        this.cellCache.clear();
        this.usedRangeCache.clear();
    }
    // -- reads -------------------------------------------------------------------
    readCell(ref, _auth) {
        return this.readCellRemote(ref);
    }
    /** Async one-cell read (the runtime form of readCell). */
    async readCellAsync(ref) {
        return this.readCellRemote(ref);
    }
    async readCellRemote(ref) {
        const payload = await this.requestJson('/read', {
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
    readRange(range, _auth) {
        return this.readRangeRemote(range);
    }
    async readRangeAsync(range) {
        return this.readRangeRemote(range);
    }
    async readRangeRemote(range) {
        const payload = await this.requestJson('/read', { method: 'POST', body: { kind: 'range', range } });
        for (let r = range.startRow; r <= range.endRow; r++) {
            for (let c = range.startCol; c <= range.endCol; c++) {
                const value = payload.values[r - range.startRow]?.[c - range.startCol];
                if (value === undefined)
                    continue;
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
    readSheet(sheet, _auth) {
        return this.readSheetRemote(sheet);
    }
    async readSheetRemote(sheet) {
        const payload = await this.requestJson('/read', {
            method: 'POST',
            body: { kind: 'sheet', sheet },
        });
        return payload.values;
    }
    getUsedRange(sheet) {
        return this.usedRangeRemote(sheet);
    }
    async usedRangeAsync(sheet) {
        return this.usedRangeRemote(sheet);
    }
    async usedRangeRemote(sheet) {
        const payload = await this.requestJson('/read', {
            method: 'POST',
            body: { kind: 'usedrange', sheet },
        });
        const range = payload.range ?? null;
        this.usedRangeCache.set(sheet, range);
        return range;
    }
    snapshot() {
        return this.snapshotAsync();
    }
    /** Async snapshot: the permission-filtered GET /snapshot payload. */
    async snapshotAsync() {
        const snap = await this.requestJson('/snapshot', { method: 'GET' });
        this.sheetNameCache = snap.sheets.map((s) => s.name);
        return snap;
    }
    sheetNames() {
        if (this.sheetNameCache)
            return [...this.sheetNameCache];
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
    async sheetNamesAsync() {
        return this.refreshSheetNames();
    }
    /** Refresh the sheet-name cache from GET /sheets (names only, cheap). */
    async refreshSheetNames() {
        if (this.sheetNamesFetch)
            return this.sheetNamesFetch;
        const fetchPromise = (async () => {
            const payload = await this.requestJson('/sheets', { method: 'GET' });
            this.sheetNameCache = [...payload.sheets];
            return [...this.sheetNameCache];
        })();
        this.sheetNamesFetch = fetchPromise;
        try {
            return await fetchPromise;
        }
        finally {
            if (this.sheetNamesFetch === fetchPromise)
                this.sheetNamesFetch = null;
        }
    }
    currentRevision() {
        return this.knownRevision ?? 0;
    }
    // -- view (cache-only, web RemoteView semantics) ------------------------------
    getView() {
        return this.remoteView;
    }
    getAuthorizer() {
        return this.stubAuthorizer;
    }
    setHiddenCheck() {
        // No-op: hidden-cell enforcement lives in the engine service.
    }
    /** Cached cell for the view (undefined = never read through this host). */
    cachedCell(ref) {
        return this.cellCache.get(cellKey(ref));
    }
    cachedUsedRange(sheet) {
        return this.usedRangeCache.get(sheet);
    }
    /** Fire-and-forget background fill for view reads (deduped per key). */
    backgroundFill(key, fill) {
        if (this.disposed || this.fillsInFlight.has(key))
            return;
        this.fillsInFlight.add(key);
        void fill()
            .catch(() => undefined)
            .finally(() => this.fillsInFlight.delete(key));
    }
    // -- subscriptions: /events poll ----------------------------------------------
    subscribe(listener) {
        this.remoteListeners.add(listener);
        this.startPolling();
        return () => {
            this.remoteListeners.delete(listener);
            if (this.remoteListeners.size === 0)
                this.stopPolling();
        };
    }
    startPolling() {
        if (this.pollTimer || this.disposed)
            return;
        this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
        this.pollTimer.unref?.();
    }
    stopPolling() {
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        this.pollTimer = null;
    }
    async poll() {
        if (this.disposed || this.pollInFlight)
            return;
        this.pollInFlight = true;
        try {
            const payload = await this.requestJson(`/events?since=${this.lastSeq}`, { method: 'GET' });
            for (const { seq, event } of payload.events ?? []) {
                if (seq > this.lastSeq)
                    this.lastSeq = seq;
                for (const l of [...this.remoteListeners]) {
                    try {
                        l(event);
                    }
                    catch {
                        // A failing listener must not break the host.
                    }
                }
            }
        }
        catch {
            // Poll failures are transient by definition (engine restart,
            // token rotation): the next tick retries.
        }
        finally {
            this.pollInFlight = false;
        }
    }
    dispose() {
        this.disposed = true;
        this.stopPolling();
        this.remoteListeners.clear();
        super.dispose();
    }
}
function cellKey(ref) {
    return `${ref.sheet}\0${ref.row}\0${ref.col}`;
}
/**
 * Cache-only TypedView: render-style reads serve what the host's async
 * reads have already fetched and queue a background fill otherwise —
 * the web RemoteView's contract, minus the grid's repaint machinery
 * (the MCP tools use the host's awaited reads, not the view).
 */
class NodeRemoteView extends TypedView {
    host;
    constructor(host) {
        // The local workbook is never used; every method is overridden.
        super(undefined);
        this.host = host;
    }
    readCell(ref) {
        const cached = this.host.cachedCell(ref);
        if (cached)
            return cached;
        this.host.backgroundFill(`cell:${cellKey(ref)}`, async () => {
            await this.host.readCellAsync(ref);
        });
        return { ref, value: EMPTY };
    }
    readRange(range) {
        const rows = [];
        let missing = false;
        for (let r = range.startRow; r <= range.endRow; r++) {
            const row = [];
            for (let c = range.startCol; c <= range.endCol; c++) {
                const ref = { sheet: range.sheet, row: r, col: c };
                const cached = this.host.cachedCell(ref);
                if (!cached)
                    missing = true;
                row.push(cached ?? { ref, value: EMPTY });
            }
            rows.push(row);
        }
        if (missing) {
            this.host.backgroundFill(`range:${range.sheet}:${range.startRow}:${range.startCol}:${range.endRow}:${range.endCol}`, async () => {
                await this.host.readRangeAsync(range);
            });
        }
        return rows;
    }
    readRangeValues(range) {
        return this.readRange(range).map((row) => row.map((cell) => cell.value));
    }
    usedRange(sheet) {
        const cached = this.host.cachedUsedRange(sheet);
        if (cached !== undefined)
            return cached;
        this.host.backgroundFill(`used:${sheet}`, async () => {
            await this.host.usedRangeAsync(sheet);
        });
        return null;
    }
    readSheet(sheet) {
        const used = this.usedRange(sheet);
        if (!used)
            return [];
        return this.readRangeValues(used);
    }
}
// Re-exported so consumers can assert the protocol version they speak.
export { ENGINE_PROTOCOL_VERSION };
