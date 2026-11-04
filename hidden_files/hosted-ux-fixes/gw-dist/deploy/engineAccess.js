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
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveParallelCellThreshold } from '@icecream-sheets/engine';
/** ENGINE_ACCESS_MODE: 'signed' enables the production access pattern. */
export function engineAccessMode(env = process.env) {
    return (env.ENGINE_ACCESS_MODE ?? '').trim().toLowerCase() === 'signed' ? 'signed' : 'proxy';
}
/** ENGINE_ACCESS_SECRET: the shared HMAC secret (Secret Manager in prod). */
export function engineAccessSecret(env = process.env) {
    const s = (env.ENGINE_ACCESS_SECRET ?? '').trim();
    return s.length > 0 ? s : null;
}
/** ENGINE_ACCESS_TTL_SECONDS: token lifetime, minutes by design. Default 600 (10 min). */
export function engineAccessTtlSeconds(env = process.env) {
    const n = Number(env.ENGINE_ACCESS_TTL_SECONDS ?? '600');
    return Number.isFinite(n) && n >= 30 && n <= 3600 ? Math.floor(n) : 600;
}
/** Per-session request-rate cap enforced BY THE ENGINE after connect. */
export function engineSessionRateLimit(env = process.env) {
    const points = Number(env.ENGINE_SESSION_RATE_POINTS ?? '5000');
    const perSeconds = Number(env.ENGINE_SESSION_RATE_WINDOW ?? '60');
    return {
        points: Number.isFinite(points) && points >= 1 ? Math.floor(points) : 5000,
        perSeconds: Number.isFinite(perSeconds) && perSeconds > 0 ? perSeconds : 60,
    };
}
/** IDLE_TIMEOUT_MS: the idle rule's threshold (doc §Idle rule). Default 10 min. */
export function idleTimeoutMs(env = process.env) {
    const n = Number(env.IDLE_TIMEOUT_MS ?? '600000');
    return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 600_000;
}
/** SESSION_SWEEPER_MS: engine backstop sweep interval. Default 30 s. */
export function sessionSweeperMs(env = process.env) {
    const n = Number(env.SESSION_SWEEPER_MS ?? '30000');
    return Number.isFinite(n) && n >= 250 ? Math.floor(n) : 30_000;
}
/**
 * SESSION_LIFECYCLE=on enables the server-side idle backstop (sweeper
 * that checkpoints + evicts sessions idle past IDLE_TIMEOUT_MS even when
 * the client vanished). Default OFF so today's local topology — where a
 * sibling worker may hold a workbook open through long server-side
 * builds with no client requests — is never evicted from under anyone.
 * Production sets it on; the client-driven release/rehydrate endpoints
 * work regardless (they are explicit calls, not the backstop).
 */
export function sessionLifecycleEnabled(env = process.env) {
    return (env.SESSION_LIFECYCLE ?? '').trim().toLowerCase() === 'on';
}
/**
 * JOURNAL_SEGMENT_MAX_OPS: the op-journal segment cap (default 200).
 * Executed ops buffer in the engine's memory and persist as ONE store
 * write per segment (Firestore free-quota constraint — 20k writes/day;
 * see sessionStore.ts). Checkpoint triggers always flush the pending
 * segment first; the cap bounds the crash-loss window between flushes.
 */
export function journalSegmentMaxOps(env = process.env) {
    const n = Number(env.JOURNAL_SEGMENT_MAX_OPS ?? '200');
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 200;
}
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
export function saveWorkerHeapMb(env = process.env) {
    const n = Number(env.SAVE_WORKER_HEAP_MB ?? '3072');
    return Number.isFinite(n) && n >= 48 && n <= 8192 ? Math.floor(n) : 3072;
}
/** SAVE_WORKER_TIMEOUT_MS: hard wall for one worker save. Default 570 s (gateway class). */
export function saveWorkerTimeoutMs(env = process.env) {
    const n = Number(env.SAVE_WORKER_TIMEOUT_MS ?? '570000');
    return Number.isFinite(n) && n >= 5000 && n <= 590000 ? Math.floor(n) : 570_000;
}
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
export function autosaveCheckpointSettleMs(env = process.env) {
    const n = Number(env.AUTOSAVE_CHECKPOINT_SETTLE_MS ?? '1500');
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1500;
}
/**
 * SSE_HEARTBEAT_MS: the GET /deltas SSE heartbeat cadence (a `: heartbeat`
 * comment frame — ignored by EventSource, keeps proxies awake). Default
 * 15 s, the cadence the handler has always used.
 */
export function sseHeartbeatMs(env = process.env) {
    const n = Number(env.SSE_HEARTBEAT_MS ?? '15000');
    return Number.isFinite(n) && n >= 50 ? Math.floor(n) : 15_000;
}
/**
 * SSE_REAP_TIMEOUT_MS: disconnect reaping for GET /deltas (deploy
 * follow-up leg 6). A subscriber whose writes have not flushed
 * successfully for this long is on a dead or half-open socket — its
 * 'close' event may never be delivered (the Cloud Run case that pinned
 * every engine-standard instance behind killed curl clients) — so the
 * heartbeat reaps it: subscription removed, response ended, request
 * slot freed. Default 45 s (three heartbeats).
 */
export function sseReapTimeoutMs(env = process.env) {
    const n = Number(env.SSE_REAP_TIMEOUT_MS ?? '45000');
    return Number.isFinite(n) && n >= 100 ? Math.floor(n) : 45_000;
}
/**
 * STREAM_WRITE_TIMEOUT_MS: bounds POST /load/stream's awaited flushes
 * and its pre-data-done idle window (leg 6). If no write flushes
 * successfully within this window the client is gone or half-open and
 * the stream is torn down instead of parking the handler — and the
 * W20 build gate — on a dead socket. Default 30 s.
 */
export function streamWriteTimeoutMs(env = process.env) {
    const n = Number(env.STREAM_WRITE_TIMEOUT_MS ?? '30000');
    return Number.isFinite(n) && n >= 100 ? Math.floor(n) : 30_000;
}
/** SAVE_WORKER=off disables the worker save path (the in-engine path remains). */
export function saveWorkerEnabled(env = process.env) {
    return (env.SAVE_WORKER ?? '').trim().toLowerCase() !== 'off';
}
/** Periodic snapshot cadence (doc extension 3): every N journaled ops / M ms. 0 = off. */
export function snapshotEveryOps(env = process.env) {
    const n = Number(env.SNAPSHOT_EVERY_OPS ?? '0');
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
export function snapshotEveryMs(env = process.env) {
    const n = Number(env.SNAPSHOT_EVERY_MS ?? '0');
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
/** ENGINE_URL_STANDARD / ENGINE_URL_XL, falling back to the single engine route. */
export function engineTierUrls(env = process.env, fallback = 'http://127.0.0.1:8101') {
    const standard = (env.ENGINE_URL_STANDARD ?? '').trim() || fallback;
    const xl = (env.ENGINE_URL_XL ?? '').trim() || standard;
    return { standard: standard.replace(/\/+$/, ''), xl: xl.replace(/\/+$/, '') };
}
/**
 * Tier selection seam: cell count above the existing MT threshold →
 * the XL tier, else standard. Unknown cell count (issuance before the
 * file is parsed) routes standard — the client re-issues with the real
 * count once the open reports it, and the engine's own MT flag (same
 * threshold) governs recalc regardless of which URL served the calls.
 */
export function selectEngineTier(cellCount, env = process.env) {
    if (cellCount === undefined || !Number.isFinite(cellCount))
        return 'standard';
    return cellCount > resolveParallelCellThreshold(env) ? 'xl' : 'standard';
}
export class EngineAccessError extends Error {
    reason;
    constructor(reason) {
        super(`engine access token rejected: ${reason}`);
        this.reason = reason;
        this.name = 'EngineAccessError';
    }
}
function b64urlEncode(buf) {
    return Buffer.from(buf).toString('base64url');
}
function sign(payloadPart, secret) {
    return createHmac('sha256', secret).update(payloadPart, 'utf8').digest('base64url');
}
/** A fresh session id (the gateway mints one when issuance names none). */
export function newSessionId() {
    return `sess_${randomUUID()}`;
}
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export function isSessionId(x) {
    return typeof x === 'string' && SESSION_ID_RE.test(x);
}
/** Issue a signed engine-access token. `nowMs` is injectable for tests. */
export function issueEngineAccessToken(opts) {
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    const claims = {
        v: 1,
        sub: opts.principal,
        sid: opts.sessionId,
        fid: opts.fid ?? '',
        role: opts.role ?? 'editor',
        tier: opts.tier,
        iat: nowSec,
        exp: nowSec + (opts.ttlSeconds ?? 600),
    };
    const payloadPart = b64urlEncode(JSON.stringify(claims));
    return { token: `${payloadPart}.${sign(payloadPart, opts.secret)}`, claims };
}
/**
 * Verify a token: structure, HMAC signature (constant-time), expiry,
 * and — when given — the session / principal scope. Throws
 * EngineAccessError with a machine-readable reason; returns the claims
 * on success. `nowMs` is injectable for tests.
 */
export function verifyEngineAccessToken(token, secret, opts = {}) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
        throw new EngineAccessError('malformed');
    }
    const [payloadPart, sigPart] = parts;
    const expected = sign(payloadPart, secret);
    const a = Buffer.from(sigPart, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new EngineAccessError('bad-signature');
    }
    let claims;
    try {
        claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    }
    catch {
        throw new EngineAccessError('malformed');
    }
    if (!claims || claims.v !== 1 || typeof claims.sub !== 'string' || typeof claims.sid !== 'string') {
        throw new EngineAccessError('unsupported-version');
    }
    // Phase 2 claims: fid/role were added in v1 shape (no version bump).
    // Legacy tokens minted before Phase 2 carry neither field: they
    // verify as fid='' + role='editor' — valid ONLY for the
    // pre-Phase-2 session-scoped routes; the engine refuses them on
    // /ops and /deltas for a file-owned session (CONTRACT.md).
    if (claims.fid !== undefined && typeof claims.fid !== 'string') {
        throw new EngineAccessError('unsupported-version');
    }
    if (claims.role !== undefined && claims.role !== 'editor' && claims.role !== 'viewer') {
        throw new EngineAccessError('unsupported-version');
    }
    claims = { ...claims, fid: claims.fid ?? '', role: claims.role ?? 'editor' };
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    if (typeof claims.exp !== 'number' || nowSec >= claims.exp) {
        throw new EngineAccessError('expired');
    }
    if (opts.sessionId !== undefined && claims.sid !== opts.sessionId) {
        throw new EngineAccessError('wrong-session');
    }
    if (opts.principal !== undefined && claims.sub !== opts.principal) {
        throw new EngineAccessError('wrong-principal');
    }
    return claims;
}
// ---------------------------------------------------------------------------
// Storage download tokens (save/download separation, 2026-10-21)
// ---------------------------------------------------------------------------
// A /download is a SAVE: the engine serializes the live workbook and
// commits the bytes into the library store, returning only metadata.
// The client then fetches the bytes DIRECTLY from the engine service
// via a short-lived signed URL — the gateway signs, it never proxies
// the bytes. The token scheme is EXACTLY the engine-access scheme
// above (base64url(payloadJson) "." base64url(HMAC-SHA256(secret,
// payloadPart)), same ENGINE_ACCESS_SECRET), with a payload scoped to
// one store entry + one principal:
//   payload = { v: 1, entryId, principal, exp }   (exp: unix seconds)
// Default lifetime 120 s: long enough for the client's immediate
// fetch, short enough that a leaked URL is nearly worthless. The
// engine re-checks the library index entry's principal against the
// token's principal before serving, so a token can never be replayed
// against another tenant's entry.
/** Default storage-token lifetime: 120 s. */
export const STORAGE_TOKEN_TTL_SECONDS = 120;
/** Issue a signed storage download token. `nowMs` is injectable for tests. */
export function issueStorageToken(opts) {
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    const claims = {
        v: 1,
        entryId: opts.entryId,
        principal: opts.principal,
        exp: nowSec + (opts.ttlSeconds ?? STORAGE_TOKEN_TTL_SECONDS),
    };
    const payloadPart = b64urlEncode(JSON.stringify(claims));
    return { token: `${payloadPart}.${sign(payloadPart, opts.secret)}`, claims };
}
/**
 * Verify a storage token: structure, HMAC signature (constant-time),
 * expiry, and — when given — the entry scope. Throws EngineAccessError
 * with a machine-readable reason; returns the claims on success. The
 * caller (the engine's /storage route) additionally checks the claims'
 * principal against the library index entry's owner.
 */
export function verifyStorageToken(token, secret, opts = {}) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
        throw new EngineAccessError('malformed');
    }
    const [payloadPart, sigPart] = parts;
    const expected = sign(payloadPart, secret);
    const a = Buffer.from(sigPart, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new EngineAccessError('bad-signature');
    }
    let claims;
    try {
        claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    }
    catch {
        throw new EngineAccessError('malformed');
    }
    if (!claims ||
        claims.v !== 1 ||
        typeof claims.entryId !== 'string' ||
        typeof claims.principal !== 'string') {
        throw new EngineAccessError('unsupported-version');
    }
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    if (typeof claims.exp !== 'number' || nowSec >= claims.exp) {
        throw new EngineAccessError('expired');
    }
    if (opts.entryId !== undefined && claims.entryId !== opts.entryId) {
        throw new EngineAccessError('wrong-session');
    }
    return claims;
}
