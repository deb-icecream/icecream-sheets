/**
 * Signed-URL engine access (design-docs/deployment-architecture.md,
 * "Engine access pattern: gateway-issued signed URL, direct connection").
 *
 * PRODUCTION PATTERN, behind config: ENGINE_ACCESS_MODE=proxy|signed
 * (default `proxy` — today's topology, where the gateway proxies every
 * engine call and validates each one). In `signed` mode:
 *
 *   1. The client asks the GATEWAY (POST /api/engine/access) — the
 *      gateway runs its full checks (JWT auth + per-principal rate
 *      limiting) and, on success, returns a short-lived signed token +
 *      the tier-appropriate DIRECT engine base URL.
 *   2. The client then talks DIRECTLY to the engine service with that
 *      token — loads, the NDJSON stream, edits and saves never pass
 *      through the gateway (removing the gateway-proxy timeout /
 *      body-buffering failure class on long saves).
 *   3. The engine validates the token ITSELF on every route and refuses
 *      everything else with 401 — the same self-authentication pattern
 *      as MCP's direct ingress. The gateway rate-limits ISSUANCE; the
 *      engine enforces its own per-session rate cap after connect.
 *
 * TOKEN FORMAT (v1, documented here — the only spec):
 *
 *   token     = base64url(payloadJson) "." base64url(signature)
 *   signature = HMAC-SHA256(secret, base64url(payloadJson))
 *   payload   = { v: 1, sub: <principal>, sid: <sessionId>,
 *                 tier: 'standard' | 'xl', iat: <unix s>, exp: <unix s> }
 *
 * The secret is shared between gateway (issuer) and engine (verifier)
 * via the ENGINE_ACCESS_SECRET env var (Secret Manager in production;
 * a plain env var locally). The token is scoped to ONE principal + ONE
 * session and lives for minutes (ENGINE_ACCESS_TTL_SECONDS, default
 * 600). A leaked token is nearly worthless: wrong session, wrong
 * principal, or a few minutes later, it is refused.
 *
 * PRESENTATION: the client sends the token as
 * `Authorization: Bearer <token>` on every direct engine call (fetch
 * supports headers on ALL engine calls, including the NDJSON load
 * stream). The one exception is the tab-close release BEACON:
 * navigator.sendBeacon cannot set headers, so the engine ALSO accepts
 * the token as the `?access_token=` query parameter. Both forms are
 * verified identically.
 *
 * TIER ROUTING (doc: engine tiers routed at open time by cell count):
 * the issuance endpoint returns ENGINE_URL_STANDARD or ENGINE_URL_XL
 * depending on the workbook's cell count vs the existing MT cell-count
 * threshold (ICECREAM_MT_CELL_COUNT_THRESHOLD, via the engine's
 * resolveParallelCellThreshold). Locally both URLs point at the one
 * engine service — production wiring is a config change only.
 */
export type EngineAccessMode = 'proxy' | 'signed';
/** ENGINE_ACCESS_MODE: 'signed' enables the production access pattern. */
export declare function engineAccessMode(env?: NodeJS.ProcessEnv): EngineAccessMode;
/** ENGINE_ACCESS_SECRET: the shared HMAC secret (Secret Manager in prod). */
export declare function engineAccessSecret(env?: NodeJS.ProcessEnv): string | null;
/** ENGINE_ACCESS_TTL_SECONDS: token lifetime, minutes by design. Default 600 (10 min). */
export declare function engineAccessTtlSeconds(env?: NodeJS.ProcessEnv): number;
/** Per-session request-rate cap enforced BY THE ENGINE after connect. */
export declare function engineSessionRateLimit(env?: NodeJS.ProcessEnv): {
    points: number;
    perSeconds: number;
};
/** IDLE_TIMEOUT_MS: the idle rule's threshold (doc §Idle rule). Default 10 min. */
export declare function idleTimeoutMs(env?: NodeJS.ProcessEnv): number;
/** SESSION_SWEEPER_MS: engine backstop sweep interval. Default 30 s. */
export declare function sessionSweeperMs(env?: NodeJS.ProcessEnv): number;
/**
 * SESSION_LIFECYCLE=on enables the server-side idle backstop (sweeper
 * that checkpoints + evicts sessions idle past IDLE_TIMEOUT_MS even when
 * the client vanished). Default OFF so today's local topology — where a
 * sibling worker may hold a workbook open through long server-side
 * builds with no client requests — is never evicted from under anyone.
 * Production sets it on; the client-driven release/rehydrate endpoints
 * work regardless (they are explicit calls, not the backstop).
 */
export declare function sessionLifecycleEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * JOURNAL_SEGMENT_MAX_OPS: the op-journal segment cap (default 200).
 * Executed ops buffer in the engine's memory and persist as ONE store
 * write per segment (Firestore free-quota constraint — 20k writes/day;
 * see sessionStore.ts). Checkpoint triggers always flush the pending
 * segment first; the cap bounds the crash-loss window between flushes.
 */
export declare function journalSegmentMaxOps(env?: NodeJS.ProcessEnv): number;
/**
 * SAVE_WORKER_HEAP_MB: the save worker's V8 old-space cap
 * (--max-old-space-size) for the W21 worker-isolated serialization.
 * The worker's SERIALIZATION working set is streamed by design (row-
 * by-row sheet generation, verbatim part copy, streaming zip), so this
 * budget exists for the checksum-verified REBUILD (source parse +
 * engine graph), not for the write itself. Default 3072 — chosen so
 * engine plateau (~1.7 GB at P95) + worker peak + browser + services
 * fit the 7.7 GiB dev VM with the virtio-balloon variance the W21a
 * bisect measured (up to ~4.95 GB silently reclaimed while idle; the
 * balloon deflates under real pressure). Clamp [48, 8192]: the low end
 * exists so the failure mode is provable (an absurdly low budget kills
 * the WORKER, the save errors, and the session survives).
 */
export declare function saveWorkerHeapMb(env?: NodeJS.ProcessEnv): number;
/** SAVE_WORKER_TIMEOUT_MS: hard wall for one worker save. Default 570 s (gateway class). */
export declare function saveWorkerTimeoutMs(env?: NodeJS.ProcessEnv): number;
/**
 * AUTOSAVE_CHECKPOINT_SETTLE_MS: the AutoSave batched-checkpoint
 * scheduler's settle window (Microsoft 365 AutoSave sync model,
 * single-author). After an executed op, the scheduler (re)arms a timer
 * of this length; when it fires with ops pending, the pending batch is
 * checkpointed into the session's stored copy. Default 1500 ms.
 * 0 disables the settle timer (checkpoints then happen only at the
 * journal-segment cap, on flush — /library-save or /download — and at
 * the deployment lifecycle points).
 */
export declare function autosaveCheckpointSettleMs(env?: NodeJS.ProcessEnv): number;
/**
 * SSE_HEARTBEAT_MS: the GET /deltas SSE heartbeat cadence (a `: heartbeat`
 * comment frame — ignored by EventSource, keeps proxies awake). Default
 * 15 s, the cadence the handler has always used.
 */
export declare function sseHeartbeatMs(env?: NodeJS.ProcessEnv): number;
/**
 * SSE_REAP_TIMEOUT_MS: disconnect reaping for GET /deltas (deploy
 * follow-up leg 6). A subscriber whose writes have not flushed
 * successfully for this long is on a dead or half-open socket — its
 * 'close' event may never be delivered (the Cloud Run case that pinned
 * every engine-standard instance behind killed curl clients) — so the
 * heartbeat reaps it: subscription removed, response ended, request
 * slot freed. Default 45 s (three heartbeats).
 */
export declare function sseReapTimeoutMs(env?: NodeJS.ProcessEnv): number;
/**
 * STREAM_WRITE_TIMEOUT_MS: bounds POST /load/stream's awaited flushes
 * and its pre-data-done idle window (leg 6). If no write flushes
 * successfully within this window the client is gone or half-open and
 * the stream is torn down instead of parking the handler — and the
 * W20 build gate — on a dead socket. Default 30 s.
 */
export declare function streamWriteTimeoutMs(env?: NodeJS.ProcessEnv): number;
/** SAVE_WORKER=off disables the worker save path (the in-engine path remains). */
export declare function saveWorkerEnabled(env?: NodeJS.ProcessEnv): boolean;
/** Periodic snapshot cadence (doc extension 3): every N journaled ops / M ms. 0 = off. */
export declare function snapshotEveryOps(env?: NodeJS.ProcessEnv): number;
export declare function snapshotEveryMs(env?: NodeJS.ProcessEnv): number;
export type EngineTier = 'standard' | 'xl';
export interface EngineTierUrls {
    standard: string;
    xl: string;
}
/** ENGINE_URL_STANDARD / ENGINE_URL_XL, falling back to the single engine route. */
export declare function engineTierUrls(env?: NodeJS.ProcessEnv, fallback?: string): EngineTierUrls;
/**
 * Tier selection seam: cell count above the existing MT threshold →
 * the XL tier, else standard. Unknown cell count (issuance before the
 * file is parsed) routes standard — the client re-issues with the real
 * count once the open reports it, and the engine's own MT flag (same
 * threshold) governs recalc regardless of which URL served the calls.
 */
export declare function selectEngineTier(cellCount: number | undefined, env?: NodeJS.ProcessEnv): EngineTier;
/** Co-authoring role carried by Phase 2 tokens (design doc §9 step 3). */
export type EngineAccessRole = 'editor' | 'viewer';
export interface EngineAccessClaims {
    v: 1;
    /** Principal the token was issued to ('user:<id>'). */
    sub: string;
    /** Session id the token is scoped to. */
    sid: string;
    /**
     * File id the token is scoped to (Phase 2, §9 join handshake).
     * '' for legacy pre-Phase-2 session-scoped tokens: those verify
     * only for the session-scoped routes (load etc.), never for /ops
     * or /deltas on a file-owned session (see CONTRACT.md).
     */
    fid: string;
    /** Role within the session: editors may submit ops; viewers may not. */
    role: EngineAccessRole;
    tier: EngineTier;
    /** Issued-at / expiry, unix seconds. */
    iat: number;
    exp: number;
}
export type EngineAccessErrorReason = 'malformed' | 'bad-signature' | 'expired' | 'wrong-session' | 'wrong-principal' | 'unsupported-version';
export declare class EngineAccessError extends Error {
    readonly reason: EngineAccessErrorReason;
    constructor(reason: EngineAccessErrorReason);
}
/** A fresh session id (the gateway mints one when issuance names none). */
export declare function newSessionId(): string;
export declare function isSessionId(x: unknown): x is string;
/** Issue a signed engine-access token. `nowMs` is injectable for tests. */
export declare function issueEngineAccessToken(opts: {
    secret: string;
    principal: string;
    sessionId: string;
    tier: EngineTier;
    /** File scope (Phase 2). Default '' (legacy session-scoped token). */
    fid?: string;
    /** Session role (Phase 2). Default 'editor'. */
    role?: EngineAccessRole;
    ttlSeconds?: number;
    nowMs?: number;
}): {
    token: string;
    claims: EngineAccessClaims;
};
/**
 * Verify a token: structure, HMAC signature (constant-time), expiry,
 * and — when given — the session / principal scope. Throws
 * EngineAccessError with a machine-readable reason; returns the claims
 * on success. `nowMs` is injectable for tests.
 */
export declare function verifyEngineAccessToken(token: string, secret: string, opts?: {
    sessionId?: string;
    principal?: string;
    nowMs?: number;
}): EngineAccessClaims;
/** Default storage-token lifetime: 120 s. */
export declare const STORAGE_TOKEN_TTL_SECONDS = 120;
export interface StorageTokenClaims {
    v: 1;
    /** Library-store entry the token may fetch. */
    entryId: string;
    /** Principal the entry must belong to ('user:<id>'). */
    principal: string;
    /** Expiry, unix seconds. */
    exp: number;
}
/** Issue a signed storage download token. `nowMs` is injectable for tests. */
export declare function issueStorageToken(opts: {
    secret: string;
    entryId: string;
    principal: string;
    ttlSeconds?: number;
    nowMs?: number;
}): {
    token: string;
    claims: StorageTokenClaims;
};
/**
 * Verify a storage token: structure, HMAC signature (constant-time),
 * expiry, and — when given — the entry scope. Throws EngineAccessError
 * with a machine-readable reason; returns the claims on success. The
 * caller (the engine's /storage route) additionally checks the claims'
 * principal against the library index entry's owner.
 */
export declare function verifyStorageToken(token: string, secret: string, opts?: {
    entryId?: string;
    nowMs?: number;
}): StorageTokenClaims;
