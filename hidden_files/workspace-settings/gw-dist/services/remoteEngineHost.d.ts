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
import { Authorizer, ENGINE_PROTOCOL_VERSION, EngineHost, TypedView, type AuthContext, type CellRef, type CommandResult, type AsyncCommandResult, type EngineCommand, type EngineEventListener, type RangeRef, type TypedCell, type TypedValue, type WorkbookSnapshot } from '@icecream-sheets/engine';
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
export type RemoteEngineFetch = (url: string, init: RemoteEngineFetchInit) => Promise<RemoteEngineFetchResponse>;
/**
 * Mutating commands: the engine service's SAVE_MUTATING_OPS set
 * (engineSvc.ts) — exactly the commands the sequencer assigns a
 * revision to. Mirrored here (the gateway services share a package but
 * engineSvc does not export its set); pinned by the remote-host tests.
 */
export declare const REMOTE_MUTATING_OPS: ReadonlySet<string>;
export interface NodeRemoteEngineHostOptions {
    /** Owning engine instance base URL (the registry record's ownerEndpoint). */
    engineUrl: string;
    /** The user the agent acts as ('user:<id>'). */
    principal: string;
    sessionId: string;
    fileId: string;
    /** /ops envelope client id. Default `agent:<principal>`. */
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
}
export declare class NodeRemoteEngineHost extends EngineHost {
    private readonly engineUrl;
    private readonly principal;
    private readonly sessionId;
    private readonly fileId;
    private readonly clientId;
    private readonly getAccessToken;
    private readonly fetchFn;
    private readonly pollMs;
    /** Client-side stub: the engine service is the enforcement point. */
    private readonly stubAuthorizer;
    private readonly remoteView;
    private readonly remoteListeners;
    /** Last revision seen (null = not yet known; /session/status seeds it). */
    private knownRevision;
    private clientSeq;
    private sheetNameCache;
    private cellCache;
    private usedRangeCache;
    private readonly fillsInFlight;
    private lastSeq;
    private pollTimer;
    private pollInFlight;
    private disposed;
    constructor(opts: NodeRemoteEngineHostOptions);
    get boundSessionId(): string;
    get boundFileId(): string;
    get boundClientId(): string;
    /** Last-seen session revision (null until the first /ops or status read). */
    get lastKnownRevision(): number | null;
    private request;
    private requestJson;
    /** Seed the last-seen revision from /session/status (once, lazily). */
    private ensureRevision;
    /** Public revision probe (also refreshes the seed after a rejection). */
    refreshRevision(): Promise<number>;
    execute(command: EngineCommand): CommandResult;
    executeAsync(command: EngineCommand): Promise<AsyncCommandResult>;
    private executeRemote;
    private invalidateReadCaches;
    readCell(ref: CellRef, _auth?: AuthContext): TypedValue;
    /** Async one-cell read (the runtime form of readCell). */
    readCellAsync(ref: CellRef): Promise<TypedValue>;
    private readCellRemote;
    readRange(range: RangeRef, _auth?: AuthContext): TypedValue[][];
    readRangeAsync(range: RangeRef): Promise<TypedValue[][]>;
    private readRangeRemote;
    readSheet(sheet: string, _auth?: AuthContext): TypedValue[][];
    private readSheetRemote;
    getUsedRange(sheet: string): RangeRef | null;
    usedRangeAsync(sheet: string): Promise<RangeRef | null>;
    private usedRangeRemote;
    snapshot(): WorkbookSnapshot;
    /** Async snapshot: the permission-filtered GET /snapshot payload. */
    snapshotAsync(): Promise<WorkbookSnapshot>;
    sheetNames(): string[];
    /** Refresh the sheet-name cache from GET /sheets (names only, cheap). */
    refreshSheetNames(): Promise<string[]>;
    currentRevision(): number;
    getView(): TypedView;
    getAuthorizer(): Authorizer;
    setHiddenCheck(): void;
    /** Cached cell for the view (undefined = never read through this host). */
    cachedCell(ref: CellRef): TypedCell | undefined;
    cachedUsedRange(sheet: string): RangeRef | null | undefined;
    /** Fire-and-forget background fill for view reads (deduped per key). */
    backgroundFill(key: string, fill: () => Promise<unknown>): void;
    subscribe(listener: EngineEventListener): () => void;
    private startPolling;
    private stopPolling;
    private poll;
    dispose(): void;
}
export { ENGINE_PROTOCOL_VERSION };
