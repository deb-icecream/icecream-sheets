/**
 * API gateway: the single entry point in front of every icecream-sheets
 * service.
 *
 * - POST /auth/login  (LOCAL-DEV ONLY: accepts { userId }, issues a JWT.
 *   Production replaces this with the real IdP; NEVER accept arbitrary
 *   userIds in prod.)
 * - POST /auth/firebase  accepts { idToken } (a Firebase ID token from
 *   Google sign-in), verifies its RS256 signature against Google's certs
 *   (aud must equal the gateway's FIREBASE_PROJECT_ID), and issues a
 *   gateway JWT for the `user:<uid>` principal. 503 when Firebase is not
 *   configured on the gateway.
 * - GET /auth/me      verifies the Bearer token and returns its claims.
 * - /api/*            JWT-required reverse proxy to the backend services.
 *   The verified userId becomes the principal `user:<userId>`, forwarded
 *   as `x-principal` (and the original Authorization header is passed
 *   through too). Rate-limited per principal → 429 + Retry-After.
 *
 * The JWT carries identity ONLY (design-docs/permission-model.md §5) —
 * per-object permissions live in the services and are checked there.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { issueToken, principalFromToken, verifyToken } from '@icecream-sheets/service';
import { verifyFirebaseIdToken } from './firebaseToken.js';
import { applyCors, bearerToken, handlePreflight, readBody, sendError, sendJson, MAX_BODY_BYTES, } from './httpUtils.js';
import { createRateLimiter } from './rateLimit.js';
import { isSessionId, issueEngineAccessToken, issueStorageToken, newSessionId, selectEngineTier, STORAGE_TOKEN_TTL_SECONDS, } from './deploy/engineAccess.js';
import { createFileRegistry, isLiveOwner, ownershipLeaseMs, } from './deploy/fileRegistry.js';
import { createUserFileCatalog, createUserTierStore, defaultFileLimit, sourceFormatForFileName, tierLimits, } from './deploy/userStore.js';
import { createUploadObjectStore, uploadObjectKey, verifyUploadToken, } from './deploy/uploadStore.js';
import { createAppShareStore, shareSummary, } from './deploy/shareStore.js';
import { validateAppSharePackage } from '@icecream-sheets/service';
import { engineAccessSecret } from './deploy/engineAccess.js';
/** Max request body for the engine file-upload endpoint (256MB). */
const LOAD_MAX_BODY_BYTES = 256 * 1024 * 1024;
/** Max request body for the engine download endpoint (32MB of session extras). */
const DOWNLOAD_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Default upstream proxy timeout (30s). */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
/**
 * Upstream timeout for ALL engine-service routes (10min) — Item D.
 *
 * The engine is the one stateful service, and legitimately long
 * operations are spread across its whole route surface, not just the
 * file endpoints: a workbook build (/load, /load/stream,
 * /load/storage-ref, /session/claim, /session/rehydrate — P99 build
 * ~249s per deployment-architecture.md), a checkpoint/save
 * (/session/release checkpoints + evicts; /download and
 * /library-save serialize or JOIN an in-flight checkpoint — P95 save
 * ~109s; a structural /ops or /execute first runs a barrier
 * checkpoint inside the sequencer and any op can queue behind an
 * in-flight save), and reads/deltas pended behind those operations.
 * Carving the long timeout out route-by-route kept drifting: /read,
 * /snapshot, /download and /library were each carved only after the
 * 30s default had already 502'd them in a gate, and /session/release,
 * /load/storage-ref, /session/rehydrate and /ops were still on the
 * 30s default (residual (o): a /download joining an in-flight P95
 * checkpoint, and the checkpoint-class calls around it, timed out at
 * the proxy while the engine completed correctly). Per the design
 * doc, proxied engine traffic is uniformly "600s-class" work, so the
 * whole '/api/engine' route gets this class; the gateway server's
 * requestTimeout (660s in bin/gateway.ts) already sits above it.
 * Stateless services keep the 30s fail-fast default (a hung one
 * should fail fast), and in signed mode the client bypasses this
 * proxy entirely (direct signed connection, engine-side 660s).
 */
export const ENGINE_UPSTREAM_TIMEOUT_MS = 600_000;
/**
 * Upstream timeout for POST /api/agent/message (~4.5min). An agent turn
 * can park on a human-in-the-loop ask for up to the agent service's
 * 4-minute HITL wait (agentSvc AGENT_HITL_TIMEOUT_MS, by design), so
 * the 30s default killed every parked turn at the proxy with a 502
 * (probe D4, reproduced 5×). 270s covers the 4-minute park plus the
 * turn's own tool work; the gateway server's requestTimeout (660s in
 * bin/gateway.ts) already sits above this class.
 */
export const AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS = 270_000;
/** Parse the ENGINE_INSTANCES env JSON map (instanceId → baseUrl). */
export function parseEngineInstances(raw) {
    if (!raw || raw.trim() === '')
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        const out = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string' && v.trim() !== '')
                out[k] = v.replace(/\/+$/, '');
        }
        return out;
    }
    catch {
        return {};
    }
}
/**
 * The service-family route prefixes served by the combined
 * service-package runner in production (vault, meta, etl, agent,
 * addons). `/api/addons` is a service-family route like the other
 * four — it is the addons bin's surface, not an engine route.
 */
export const SERVICE_FAMILY_ROUTE_PREFIXES = [
    '/api/vault',
    '/api/meta',
    '/api/etl',
    '/api/agent',
    '/api/addons',
    '/api/connectors',
];
const SERVICE_FAMILY_ROUTE_SET = new Set(SERVICE_FAMILY_ROUTE_PREFIXES);
/**
 * SERVICE_COMBINED env parsing for the gateway bin: 'on' (the value
 * deploy/services/gateway.yaml sets), 'true' and '1' also enable it;
 * anything else (including unset) is OFF, so the default local
 * per-bin topology keeps its byte-identical strip behavior.
 */
export function serviceCombinedEnabled(env = process.env) {
    return ['on', 'true', '1'].includes((env.SERVICE_COMBINED ?? '').trim().toLowerCase());
}
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
export function createGateway(opts) {
    const { authSecret, routes } = opts;
    const loginTtlSeconds = opts.loginTtlSeconds ?? 12 * 3600;
    const auditSize = opts.auditSize ?? 500;
    const limiter = createRateLimiter(opts.rateLimit);
    const audit = [];
    // Phase 2 ownership registry (§9): resolved once. A prod-mode
    // construction failure is NOT fatal to the gateway process (other
    // routes keep working) but makes /api/engine/open fail closed 503.
    let fileRegistry = opts.fileRegistry ?? null;
    if (!fileRegistry) {
        try {
            fileRegistry = createFileRegistry(process.env);
        }
        catch (e) {
            console.error(`[gateway] file registry unavailable: ${e instanceof Error ? e.message : String(e)} — /api/engine/open will fail closed (503)`);
            fileRegistry = null;
        }
    }
    const engineInstances = opts.engineInstances ?? parseEngineInstances(process.env.ENGINE_INSTANCES);
    const engineInstanceId = (opts.engineInstanceId ?? (process.env.ENGINE_INSTANCE_ID ?? '').trim()) || 'engine-1';
    // Product layer stores (CONTRACT.md): resolved once. A prod-mode
    // construction failure is NOT fatal to the gateway process (other
    // routes keep working) but makes the product endpoints that need
    // the missing store fail closed (503) — the fileRegistry posture.
    const uploadTokenSecret = opts.uploadTokenSecret ??
        opts.storageSign?.secret ??
        opts.engineAccess?.secret ??
        engineAccessSecret(process.env) ??
        (typeof authSecret === 'string' ? authSecret : Buffer.from(authSecret).toString('utf8'));
    let userTierStore = opts.userTierStore ?? null;
    if (!userTierStore) {
        try {
            userTierStore = createUserTierStore(process.env);
        }
        catch (e) {
            console.error(`[gateway] user tier store unavailable: ${e instanceof Error ? e.message : String(e)} — product endpoints will fail closed (503)`);
            userTierStore = null;
        }
    }
    let userFileCatalog = opts.userFileCatalog ?? null;
    if (!userFileCatalog) {
        try {
            userFileCatalog = createUserFileCatalog(process.env);
        }
        catch (e) {
            console.error(`[gateway] user file catalog unavailable: ${e instanceof Error ? e.message : String(e)} — product endpoints will fail closed (503)`);
            userFileCatalog = null;
        }
    }
    let uploadStore = opts.uploadStore ?? null;
    if (!uploadStore) {
        try {
            uploadStore = createUploadObjectStore(process.env, {
                tokenSecret: uploadTokenSecret,
                ...(opts.uploadPublicBaseUrl ? { publicBaseUrl: opts.uploadPublicBaseUrl } : {}),
            });
        }
        catch (e) {
            console.error(`[gateway] upload object store unavailable: ${e instanceof Error ? e.message : String(e)} — product endpoints will fail closed (503)`);
            uploadStore = null;
        }
    }
    else {
        // Align an injected store with the gateway's staging config when
        // the caller supplied it (the bin/tests set port + secret after
        // construction): the staging URLs the store mints must verify at
        // THIS gateway.
        if (opts.uploadPublicBaseUrl)
            uploadStore.publicBaseUrl = opts.uploadPublicBaseUrl;
        if (opts.uploadTokenSecret)
            uploadStore.tokenSecret = opts.uploadTokenSecret;
    }
    let appShareStore = opts.appShareStore ?? null;
    if (!appShareStore) {
        try {
            appShareStore = createAppShareStore(process.env);
        }
        catch (e) {
            console.error(`[gateway] app share store unavailable: ${e instanceof Error ? e.message : String(e)} — /api/shares will fail closed (503)`);
            appShareStore = null;
        }
    }
    /**
     * Tier for an auth exchange: the tier-store record is the source of
     * truth at each login. Auth itself never fails on a tier-store
     * problem — an unavailable/erroring store stamps 'default' and the
     * product endpoints surface the 503.
     */
    async function resolveTierFor(userId, email) {
        if (!userTierStore)
            return 'default';
        try {
            return await userTierStore.resolveTier({ userId, ...(email ? { email } : {}) });
        }
        catch {
            return 'default';
        }
    }
    /** Tier for an already-authenticated principal (user:<userId>). */
    async function tierForPrincipal(principal) {
        const userId = principal.startsWith('user:') ? principal.slice('user:'.length) : principal;
        return resolveTierFor(userId);
    }
    /**
     * Verify a staging token against the gateway's secret, falling back
     * to the upload store's own secret when it differs (an injected
     * store may have been constructed with its minting secret before
     * the gateway's was known — the token IS the auth either way, and
     * both secrets are gateway-side configuration).
     */
    function verifyStagingToken(token, verifyOpts) {
        try {
            return verifyUploadToken(token, uploadTokenSecret, verifyOpts);
        }
        catch (e) {
            const storeSecret = uploadStore?.tokenSecret;
            if (storeSecret && storeSecret !== uploadTokenSecret) {
                return verifyUploadToken(token, storeSecret, verifyOpts);
            }
            throw e;
        }
    }
    function logAudit(method, path, principal, status, durationMs) {
        audit.push({ ts: new Date().toISOString(), method, path, principal, status, durationMs });
        if (audit.length > auditSize)
            audit.splice(0, audit.length - auditSize);
        // One line per request: cheap, greppable, no PII beyond the principal id.
        console.log(`[gateway] ${method} ${path} principal=${principal} status=${status} ${durationMs}ms`);
    }
    const handle = async (req, res) => {
        const started = Date.now();
        if (handlePreflight(req, res))
            return;
        const url = new URL(req.url ?? '/', 'http://gateway');
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const finish = (principal, status) => {
            logAudit(method, path, principal, status, Date.now() - started);
        };
        const reply = (principal, status, obj) => {
            finish(principal, status);
            sendJson(res, status, obj);
        };
        const fail = (principal, status, error) => {
            finish(principal, status);
            sendError(res, status, error);
        };
        const failExtra = (principal, status, error, extra) => {
            finish(principal, status);
            sendError(res, status, error, extra);
        };
        try {
            // -- auth endpoints -------------------------------------------------
            if (path === '/auth/login' && method === 'POST') {
                // ================================================================
                // LOCAL-DEV ONLY. This endpoint mints a signed JWT for ANY userId
                // the caller names. Production MUST replace it with the real
                // identity provider (Firebase Auth / GCP IAM) — never accept
                // arbitrary userIds in prod.
                // ================================================================
                // Rate-limit login attempts per client IP (brute-force protection).
                const clientIp = req.socket?.remoteAddress ?? 'unknown';
                const rlLogin = limiter.take(`login:${clientIp}`);
                if (!rlLogin.allowed) {
                    applyCors(res);
                    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rlLogin.retryAfterMs / 1000))));
                    return fail('anonymous', 429, 'rate limit exceeded');
                }
                let body;
                try {
                    body = await readBody(req);
                }
                catch (e) {
                    return fail('anonymous', 400, bodyError(e));
                }
                const userId = body?.userId;
                if (typeof userId !== 'string' || userId.length === 0 || /[:\s]/.test(userId)) {
                    return fail('anonymous', 400, 'userId must be a non-empty string without spaces or colons');
                }
                // Product layer: stamp the user's tier (tier-store record is
                // the source of truth at each login) into the JWT + response.
                const tier = await resolveTierFor(userId);
                const token = await issueToken({
                    userId,
                    attrs: { tier },
                    secret: authSecret,
                    ttlSeconds: loginTtlSeconds,
                });
                return reply(`user:${userId}`, 200, { ok: true, token, userId, tier, expiresIn: loginTtlSeconds });
            }
            if (path === '/auth/firebase' && method === 'POST') {
                // Firebase Google sign-in exchange (Cycle 9). The gateway verifies
                // the Firebase ID token's RS256 signature itself — the client is
                // never trusted to name its own identity — then mints a gateway JWT
                // for the user:<uid> principal, exactly like /auth/login.
                const rlFirebase = limiter.take(`firebase-login:${req.socket?.remoteAddress ?? 'unknown'}`);
                if (!rlFirebase.allowed) {
                    applyCors(res);
                    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rlFirebase.retryAfterMs / 1000))));
                    return fail('anonymous', 429, 'rate limit exceeded');
                }
                const firebaseProjectId = opts.firebaseProjectId;
                if (!firebaseProjectId) {
                    return fail('anonymous', 503, 'firebase auth is not configured on this gateway (set FIREBASE_PROJECT_ID)');
                }
                let body;
                try {
                    body = await readBody(req);
                }
                catch (e) {
                    return fail('anonymous', 400, bodyError(e));
                }
                const idToken = body?.idToken;
                if (typeof idToken !== 'string' || idToken.length === 0) {
                    return fail('anonymous', 400, 'idToken must be a non-empty string');
                }
                let fb;
                try {
                    fb = await verifyFirebaseIdToken(idToken, { projectId: firebaseProjectId });
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    return fail('anonymous', 401, `invalid firebase id token: ${msg}`);
                }
                const userId = fb.uid;
                if (/[:\s]/.test(userId)) {
                    return fail('anonymous', 401, 'invalid firebase id token: subject not usable as principal');
                }
                // Identity only (permission-model.md §5): coarse slow-changing
                // profile attrs, never per-object permissions. Product layer:
                // the tier joins them — stamped from the tier-store record
                // (a pending promotion for this email is consumed here, at
                // the record's first creation).
                const tier = await resolveTierFor(userId, fb.email);
                const attrs = { tier };
                if (fb.name)
                    attrs['name'] = fb.name;
                if (fb.email)
                    attrs['email'] = fb.email;
                const token = await issueToken({ userId, attrs, secret: authSecret, ttlSeconds: loginTtlSeconds });
                return reply(`user:${userId}`, 200, { ok: true, token, userId, tier, expiresIn: loginTtlSeconds });
            }
            if (path === '/auth/me' && method === 'GET') {
                const token = bearerToken(req);
                if (!token)
                    return fail('anonymous', 401, 'missing Authorization: Bearer token');
                try {
                    const claims = await verifyToken(token, authSecret);
                    const principal = principalFromToken(claims);
                    return reply(principal, 200, {
                        ok: true,
                        userId: claims.userId,
                        attrs: claims.attrs,
                        iat: claims.iat,
                        exp: claims.exp,
                        principal,
                    });
                }
                catch {
                    return fail('anonymous', 401, 'invalid or expired token');
                }
            }
            if (path === '/auth/__audit' && method === 'GET') {
                return reply('anonymous', 200, { ok: true, entries: [...audit] });
            }
            if (path === '/health' && method === 'GET') {
                return reply('anonymous', 200, { ok: true, service: 'gateway', routes: Object.keys(routes) });
            }
            // -- upload staging (product layer): the upload TOKEN is the auth
            //    (CONTRACT §Upload object store). These routes sit beside the
            //    /auth/* handling, BEFORE the /api JWT pipeline: a client
            //    PUTs/GETs file bytes directly against the signed staging
            //    URL the gateway issued — no gateway JWT is involved.
            if (path.startsWith('/uploads/stage/')) {
                if (!uploadStore) {
                    return fail('anonymous', 503, 'upload store unavailable');
                }
                let object;
                try {
                    object = decodeURIComponent(path.slice('/uploads/stage/'.length));
                }
                catch {
                    return fail('anonymous', 400, 'malformed staged object name');
                }
                if (object.length === 0)
                    return fail('anonymous', 400, 'missing staged object name');
                const ut = url.searchParams.get('ut');
                if (!ut)
                    return fail('anonymous', 401, 'missing upload token');
                if (method === 'PUT') {
                    let claims;
                    try {
                        claims = verifyStagingToken(ut, { op: 'put', object });
                    }
                    catch {
                        return fail('anonymous', 401, 'invalid or expired upload token');
                    }
                    const maxBytes = claims.maxBytes ?? 256 * 1024 * 1024;
                    const chunks = [];
                    let total = 0;
                    let tooLarge = false;
                    try {
                        for await (const chunk of req) {
                            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                            total += buf.length;
                            if (total > maxBytes) {
                                tooLarge = true;
                                break;
                            }
                            chunks.push(buf);
                        }
                    }
                    catch {
                        return fail(claims.principal, 400, 'failed to read upload body');
                    }
                    if (tooLarge) {
                        // Abort past the token's maxBytes: drop anything staged
                        // for this object (no partial survives) and refuse.
                        req.resume();
                        await uploadStore.delete(object).catch(() => undefined);
                        return failExtra(claims.principal, 413, `upload exceeds the ${maxBytes}-byte limit for this grant`, {
                            code: 'UPLOAD_TOO_LARGE',
                            limit: maxBytes,
                            tier: 'default',
                        });
                    }
                    await uploadStore.put(object, Buffer.concat(chunks));
                    return reply(claims.principal, 200, { ok: true, object, size: total });
                }
                if (method === 'GET') {
                    let claims;
                    try {
                        claims = verifyStagingToken(ut, { op: 'get', object });
                    }
                    catch {
                        return fail('anonymous', 401, 'invalid or expired upload token');
                    }
                    const bytes = await uploadStore.get(object);
                    if (!bytes)
                        return fail(claims.principal, 404, 'staged object not found');
                    finish(claims.principal, 200);
                    applyCors(res);
                    const baseName = object.split('/').pop() ?? 'download.xlsx';
                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        'Content-Disposition': `attachment; filename="${baseName.replace(/"/g, '')}"`,
                        'Content-Length': bytes.length,
                    });
                    res.end(bytes);
                    return;
                }
                return fail('anonymous', 404, `not found: ${path}`);
            }
            // -- /api/* : authenticated, rate-limited reverse proxy -------------
            if (!path.startsWith('/api/')) {
                return fail('anonymous', 404, `not found: ${path}`);
            }
            // Auth first (fail closed): every /api/* request needs a Bearer JWT.
            const token = bearerToken(req);
            if (!token) {
                applyCors(res);
                return fail('anonymous', 401, 'missing Authorization: Bearer token');
            }
            let principal;
            try {
                principal = principalFromToken(await verifyToken(token, authSecret));
            }
            catch {
                applyCors(res);
                return fail('anonymous', 401, 'invalid or expired token');
            }
            // Rate limit per principal.
            const rl = limiter.take(principal);
            if (!rl.allowed) {
                applyCors(res);
                res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))));
                return fail(principal, 429, 'rate limit exceeded');
            }
            // -- signed engine access issuance (deployment doc: stateful
            //    engine ONLY; stateless services stay on the proxied path) ---
            // Auth + rate limiting above have already run — issuance IS the
            // gateway's handshake. The client names the session it wants the
            // token scoped to (or gets a fresh one minted) and, when it knows
            // it, the workbook's cell count for tier selection.
            if (path === '/api/engine/access' && method === 'POST') {
                if (!opts.engineAccess) {
                    return fail(principal, 501, 'signed engine access is not enabled on this gateway (ENGINE_ACCESS_MODE is not signed)');
                }
                let body;
                try {
                    body = await readBody(req);
                }
                catch (e) {
                    return fail(principal, 400, bodyError(e));
                }
                const b = (body ?? {});
                if (b.sessionId !== undefined && !isSessionId(b.sessionId)) {
                    return fail(principal, 400, 'sessionId must match [A-Za-z0-9._:-]{1,128}');
                }
                const sessionId = isSessionId(b.sessionId) ? b.sessionId : newSessionId();
                const cellCount = typeof b.cellCount === 'number' && Number.isFinite(b.cellCount) && b.cellCount >= 0
                    ? Math.floor(b.cellCount)
                    : undefined;
                const tier = selectEngineTier(cellCount);
                const ttlSeconds = opts.engineAccess.ttlSeconds ?? 600;
                const { token, claims } = issueEngineAccessToken({
                    secret: opts.engineAccess.secret,
                    principal,
                    sessionId,
                    tier,
                    ttlSeconds,
                });
                return reply(principal, 200, {
                    ok: true,
                    accessToken: token,
                    engineUrl: opts.engineAccess.tiers[tier],
                    sessionId,
                    tier,
                    expiresAt: claims.exp * 1000,
                    expiresInSeconds: ttlSeconds,
                });
            }
            // -- Phase 2 join handshake (design doc §9) ----------------------
            // POST /api/engine/open: the client asks the GATEWAY to open a
            // file (JWT auth + per-principal rate limit have already run
            // above). The gateway reads the session ownership registry:
            //   * live owner → JOIN that session on that instance;
            //   * no record / expired lease → CLAIM: pick an engine
            //     instance, ask it to create-or-rehydrate the session for
            //     this fileId (POST {engine}/session/claim), then CAS-claim
            //     the registry record (epoch = previous+1, or 1). A CAS
            //     loser re-reads and JOINs the winner.
            //   * registry read/write throws → 503 FAIL-CLOSED, no session
            //     created anywhere.
            // The response shape is IDENTICAL for join vs create; it carries
            // connection information ONLY (endpoint, sessionId, a signed
            // token scoped { sub, sid, fid, role, exp }, current revision).
            if (path === '/api/engine/open' && method === 'POST') {
                if (!opts.engineAccess) {
                    return fail(principal, 501, 'signed engine access is not enabled on this gateway (ENGINE_ACCESS_MODE is not signed)');
                }
                if (!fileRegistry) {
                    return fail(principal, 503, 'session registry unavailable');
                }
                let body;
                try {
                    body = await readBody(req);
                }
                catch (e) {
                    return fail(principal, 400, bodyError(e));
                }
                const b = (body ?? {});
                if (b.role !== undefined && b.role !== 'editor' && b.role !== 'viewer') {
                    return fail(principal, 400, "role must be 'editor' or 'viewer'");
                }
                const requestedRole = b.role ?? 'editor';
                let fileId;
                if (b.fileId !== undefined) {
                    if (typeof b.fileId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(b.fileId)) {
                        return fail(principal, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
                    }
                    fileId = b.fileId;
                }
                else {
                    fileId = `file-${randomUUID()}`;
                }
                // Product layer catalog ownership (CONTRACT §Gateway
                // endpoints): a catalogued file opens ONLY for its owner —
                // anyone else gets the same 404 as a nonexistent file (no
                // existence leak). The owner opening stamps lastOpenedAt
                // (recents). No catalog record → unchanged Phase 2 behavior.
                if (userFileCatalog) {
                    try {
                        const catRec = await userFileCatalog.get(fileId);
                        if (catRec) {
                            if (catRec.ownerPrincipal !== principal) {
                                return fail(principal, 404, 'file not found');
                            }
                            await userFileCatalog.touchOpened(fileId).catch(() => undefined);
                        }
                    }
                    catch {
                        // Catalog read problems never block an open (the registry
                        // below remains the fail-closed authority for ownership
                        // of the live session itself).
                    }
                }
                const cellCount = typeof b.cellCount === 'number' && Number.isFinite(b.cellCount) && b.cellCount >= 0
                    ? Math.floor(b.cellCount)
                    : undefined;
                const tier = selectEngineTier(cellCount);
                const ttlSeconds = opts.engineAccess.ttlSeconds ?? 600;
                const issueFor = (sessionId, role) => issueEngineAccessToken({
                    secret: opts.engineAccess.secret,
                    principal,
                    sessionId,
                    tier,
                    fid: fileId,
                    role,
                    ttlSeconds,
                }).token;
                const openReply = (sessionId, engineUrl, role, revision, joined, ownershipEpoch) => reply(principal, 200, {
                    ok: true,
                    fileId,
                    sessionId,
                    engineUrl,
                    accessToken: issueFor(sessionId, role),
                    role,
                    revision,
                    joined,
                    ownershipEpoch,
                });
                let rec;
                try {
                    rec = await fileRegistry.lookup(fileId);
                }
                catch {
                    return fail(principal, 503, 'session registry unavailable');
                }
                if (isLiveOwner(rec) && rec) {
                    // JOIN: the response is the registered owner's endpoint +
                    // a fresh token for the EXISTING session.
                    return openReply(rec.sessionId, rec.ownerEndpoint, requestedRole, rec.currentRevision, true, rec.ownershipEpoch);
                }
                // CLAIM path: pick an instance (ENGINE_INSTANCES map; default
                // the single configured tier URL), ask it to create-or-
                // rehydrate the session, then CAS the registry record.
                const instances = Object.keys(engineInstances).length > 0
                    ? engineInstances
                    : { [engineInstanceId]: opts.engineAccess.tiers[tier] };
                const chosenId = instances[engineInstanceId] ? engineInstanceId : Object.keys(instances)[0];
                const engineUrl = instances[chosenId].replace(/\/+$/, '');
                // Reuse the expired record's sessionId when there is one: the
                // engine rehydrates that released session (snapshot + journal
                // + checksum) instead of minting a divergent one.
                const sessionId = rec?.sessionId ?? newSessionId();
                const epoch = rec ? rec.ownershipEpoch + 1 : 1;
                let claimJson = null;
                try {
                    const claimRes = await fetch(`${engineUrl}/session/claim`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${issueFor(sessionId, 'editor')}`,
                        },
                        body: JSON.stringify({ fileId, sessionId }),
                    });
                    const claimText = await claimRes.text();
                    try {
                        claimJson = JSON.parse(claimText);
                    }
                    catch {
                        claimJson = null;
                    }
                    if (!claimRes.ok) {
                        const detail = claimJson && typeof claimJson.error === 'string'
                            ? claimJson.error
                            : `HTTP ${claimRes.status}`;
                        return fail(principal, claimRes.status === 409 ? 409 : 502, `engine claim failed: ${detail}`);
                    }
                }
                catch (e) {
                    return fail(principal, 502, `engine claim failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                const engineSessionId = isSessionId(claimJson?.sessionId) ? claimJson.sessionId : sessionId;
                const claimRevision = typeof claimJson?.revision === 'number' && Number.isFinite(claimJson.revision)
                    ? Math.floor(claimJson.revision)
                    : (rec?.currentRevision ?? 0);
                let won;
                try {
                    won = await fileRegistry.claim({
                        fileId,
                        sessionId: engineSessionId,
                        ownerInstance: chosenId,
                        ownerEndpoint: engineUrl,
                        leaseExpiry: Date.now() + (opts.ownershipLeaseMs ?? ownershipLeaseMs()),
                        ownershipEpoch: epoch,
                        currentRevision: claimRevision,
                        storedRevision: rec?.storedRevision ?? 0,
                        updatedAt: Date.now(),
                        creatorPrincipal: rec?.creatorPrincipal ?? principal,
                    }, rec ? rec.ownershipEpoch : null);
                }
                catch {
                    return fail(principal, 503, 'session registry unavailable');
                }
                if (!won) {
                    // CAS race lost: re-read and JOIN the winner (never build a
                    // competing copy).
                    let winner;
                    try {
                        winner = await fileRegistry.lookup(fileId);
                    }
                    catch {
                        return fail(principal, 503, 'session registry unavailable');
                    }
                    if (winner && isLiveOwner(winner)) {
                        return openReply(winner.sessionId, winner.ownerEndpoint, requestedRole, winner.currentRevision, true, winner.ownershipEpoch);
                    }
                    return fail(principal, 409, 'ownership claim lost and no live owner found');
                }
                // The creator (first claim) is always an editor.
                return openReply(engineSessionId, engineUrl, 'editor', claimRevision, false, epoch);
            }
            // -- storage download signing (save/download separation) --------
            // A /download committed the serialized workbook into the engine's
            // library store and returned only an entryId. The client now asks
            // HERE for a signed URL (JWT auth + per-principal rate limit have
            // already run above — issuance is the gateway's handshake, exactly
            // like engine access), then fetches the bytes DIRECTLY from the
            // engine service: GET {engineOrigin}/storage/{entryId}?st={token}.
            // The gateway never proxies those bytes. The token binds
            // { entryId, principal, exp: now+120s }; the engine re-checks the
            // store index entry's owner against the token's principal before
            // serving, so a token minted for one tenant fetches nothing of
            // another's. Fail closed: no signing secret → 501, no unsigned
            // fallback (the /download metadata response is unaffected).
            if (path === '/api/storage/sign' && method === 'POST') {
                const secret = opts.storageSign?.secret ?? opts.engineAccess?.secret;
                if (!secret) {
                    return fail(principal, 501, 'storage signing is not configured on this gateway (ENGINE_ACCESS_SECRET is not set)');
                }
                let body;
                try {
                    body = await readBody(req);
                }
                catch (e) {
                    return fail(principal, 400, bodyError(e));
                }
                const entryId = body?.entryId;
                if (typeof entryId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(entryId)) {
                    return fail(principal, 400, 'entryId must match [A-Za-z0-9._-]{1,128}');
                }
                const { token: st, claims } = issueStorageToken({
                    secret,
                    entryId,
                    principal,
                    ttlSeconds: opts.storageSign?.ttlSeconds ?? STORAGE_TOKEN_TTL_SECONDS,
                });
                const origin = (opts.storageSign?.publicUrl ??
                    process.env.ENGINE_PUBLIC_URL ??
                    opts.engineAccess?.tiers.standard ??
                    routes['/api/engine'] ??
                    '').replace(/\/+$/, '');
                return reply(principal, 200, {
                    ok: true,
                    url: `${origin}/storage/${entryId}?st=${st}`,
                    expiresAt: claims.exp * 1000,
                });
            }
            // -- product layer: workspace file catalog + upload issuance ----
            // (CONTRACT §Gateway endpoints). Auth + per-principal rate limit
            // have already run above. Caps are enforced HERE, server-side:
            // at upload-grant (declared size + count) AND again at
            // complete-upload against the ACTUAL staged bytes.
            if (path === '/api/files' || path.startsWith('/api/files/')) {
                if (!userTierStore || !userFileCatalog) {
                    return fail(principal, 503, 'product layer unavailable');
                }
                const catalog = userFileCatalog;
                const seg = path.slice('/api/files'.length).split('/').filter((s) => s.length > 0);
                const tier = await tierForPrincipal(principal);
                const limits = tierLimits(tier);
                const fileNotFound = () => fail(principal, 404, 'file not found');
                const ownedRecord = async (fileId) => {
                    const rec = await catalog.get(fileId);
                    return rec && rec.ownerPrincipal === principal ? rec : null;
                };
                const tooLargeError = (size) => failExtra(principal, 413, `upload of ${size} bytes exceeds the Default tier upload limit of ${limits.uploadMaxBytes} bytes — Pro uploads are unrestricted`, { code: 'UPLOAD_TOO_LARGE', limit: limits.uploadMaxBytes, size, tier: 'default' });
                const fileLimitError = async () => {
                    const count = await catalog.countByOwner(principal);
                    failExtra(principal, 409, `file limit reached: the Default tier allows at most ${limits.fileLimit} files (you have ${count}) — Pro is unrestricted`, { code: 'FILE_LIMIT_REACHED', limit: limits.fileLimit, count, tier: 'default' });
                };
                // GET /api/files — the workspace list (recents order).
                if (seg.length === 0 && method === 'GET') {
                    const files = await catalog.listByOwner(principal);
                    return reply(principal, 200, { ok: true, tier, limits, count: files.length, files });
                }
                // POST /api/files — create a blank (in-app) file. Created
                // files count toward the Default count cap but have NO size
                // cap (they can grow to anything).
                if (seg.length === 0 && method === 'POST') {
                    let body;
                    try {
                        body = await readBody(req);
                    }
                    catch (e) {
                        return fail(principal, 400, bodyError(e));
                    }
                    const name = body?.name;
                    if (typeof name !== 'string' || name.trim().length === 0) {
                        return fail(principal, 400, 'name must be a non-empty string');
                    }
                    if (tier === 'default') {
                        const count = await catalog.countByOwner(principal);
                        if (count >= (limits.fileLimit ?? defaultFileLimit())) {
                            return fileLimitError();
                        }
                    }
                    const file = await catalog.create({
                        fileId: `file-${randomUUID()}`,
                        ownerPrincipal: principal,
                        name,
                        origin: 'created',
                    });
                    return reply(principal, 201, { ok: true, file });
                }
                // POST /api/files/upload-grant — check caps against the
                // DECLARED size + current count BEFORE issuing a staging URL.
                if (seg.length === 1 && seg[0] === 'upload-grant' && method === 'POST') {
                    if (!uploadStore)
                        return fail(principal, 503, 'upload store unavailable');
                    let body;
                    try {
                        body = await readBody(req);
                    }
                    catch (e) {
                        return fail(principal, 400, bodyError(e));
                    }
                    const b = (body ?? {});
                    if (typeof b.name !== 'string' || b.name.trim().length === 0) {
                        return fail(principal, 400, 'name must be a non-empty string');
                    }
                    const format = sourceFormatForFileName(b.name);
                    if (format === null) {
                        return fail(principal, 400, 'unsupported file type: only .xlsx and .csv files can be uploaded');
                    }
                    if (typeof b.size !== 'number' ||
                        !Number.isInteger(b.size) ||
                        b.size <= 0 ||
                        b.size > 256 * 1024 * 1024) {
                        return fail(principal, 400, 'size must be a positive integer no larger than 256 MiB');
                    }
                    const size = b.size;
                    if (tier === 'default' && size > (limits.uploadMaxBytes ?? 0)) {
                        return tooLargeError(size);
                    }
                    if (tier === 'default') {
                        const count = await catalog.countByOwner(principal);
                        if (count >= (limits.fileLimit ?? defaultFileLimit())) {
                            return fileLimitError();
                        }
                    }
                    const fileId = `file-${randomUUID()}`;
                    const object = uploadObjectKey(principal, fileId, format);
                    let grant;
                    try {
                        grant = await uploadStore.putUrl(object, { principal, maxBytes: size });
                    }
                    catch (e) {
                        return fail(principal, 503, `upload store unavailable: ${e instanceof Error ? e.message : String(e)}`);
                    }
                    // NO catalog record yet — complete-upload creates it after
                    // the bytes land and pass the actual-size re-check.
                    return reply(principal, 200, {
                        ok: true,
                        fileId,
                        object,
                        upload: { url: grant.url, expiresAt: grant.expiresAt, method: 'PUT' },
                    });
                }
                // /api/files/:fileId[/...] routes.
                if (seg.length >= 1) {
                    const fileId = seg[0];
                    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(fileId))
                        return fileNotFound();
                    if (seg.length === 1 && method === 'GET') {
                        const rec = await ownedRecord(fileId);
                        if (!rec)
                            return fileNotFound();
                        return reply(principal, 200, { ok: true, file: rec });
                    }
                    if (seg.length === 1 && method === 'PATCH') {
                        const rec = await ownedRecord(fileId);
                        if (!rec)
                            return fileNotFound();
                        let body;
                        try {
                            body = await readBody(req);
                        }
                        catch (e) {
                            return fail(principal, 400, bodyError(e));
                        }
                        const b = (body ?? {});
                        const patch = {};
                        if (b.name !== undefined) {
                            if (typeof b.name !== 'string' || b.name.trim().length === 0) {
                                return fail(principal, 400, 'name must be a non-empty string');
                            }
                            patch.name = b.name;
                        }
                        if (b.hasStoredState !== undefined) {
                            if (typeof b.hasStoredState !== 'boolean') {
                                return fail(principal, 400, 'hasStoredState must be a boolean');
                            }
                            patch.hasStoredState = b.hasStoredState;
                        }
                        if (b.libraryEntryId !== undefined) {
                            if (b.libraryEntryId !== null && typeof b.libraryEntryId !== 'string') {
                                return fail(principal, 400, 'libraryEntryId must be a string or null');
                            }
                            patch.libraryEntryId = b.libraryEntryId;
                        }
                        const updated = await catalog.update(fileId, patch);
                        if (!updated)
                            return fileNotFound();
                        return reply(principal, 200, { ok: true, file: updated });
                    }
                    if (seg.length === 1 && method === 'DELETE') {
                        const rec = await ownedRecord(fileId);
                        if (!rec)
                            return fileNotFound();
                        if (rec.storageRef && uploadStore) {
                            await uploadStore.delete(rec.storageRef.object).catch(() => undefined);
                        }
                        await catalog.remove(fileId);
                        return reply(principal, 200, { ok: true });
                    }
                    if (seg.length === 2 && seg[1] === 'complete-upload' && method === 'POST') {
                        if (!uploadStore)
                            return fail(principal, 503, 'upload store unavailable');
                        let body;
                        try {
                            body = await readBody(req);
                        }
                        catch (e) {
                            return fail(principal, 400, bodyError(e));
                        }
                        const name = body?.name;
                        if (typeof name !== 'string' || name.trim().length === 0) {
                            return fail(principal, 400, 'name must be a non-empty string');
                        }
                        const format = sourceFormatForFileName(name);
                        if (format === null) {
                            return fail(principal, 400, 'unsupported file type: only .xlsx and .csv files can be uploaded');
                        }
                        // Idempotent: an existing record for this fileId+owner
                        // IS the completed upload.
                        const existing = await ownedRecord(fileId);
                        if (existing)
                            return reply(principal, 201, { ok: true, file: existing });
                        const anyRec = await catalog.get(fileId);
                        if (anyRec)
                            return fileNotFound(); // someone else's fileId
                        const object = uploadObjectKey(principal, fileId, format);
                        const st = await uploadStore.stat(object);
                        if (!st) {
                            return failExtra(principal, 404, 'upload not found: no staged bytes for this file', {
                                code: 'UPLOAD_NOT_FOUND',
                            });
                        }
                        // ACTUAL size re-check against the CURRENT tier (the
                        // tier may have changed since the grant was issued).
                        if (tier === 'default' && st.size > (limits.uploadMaxBytes ?? 0)) {
                            await uploadStore.delete(object).catch(() => undefined);
                            return tooLargeError(st.size);
                        }
                        if (tier === 'default') {
                            const count = await catalog.countByOwner(principal);
                            if (count >= (limits.fileLimit ?? defaultFileLimit())) {
                                // No orphans: the staged bytes go too.
                                await uploadStore.delete(object).catch(() => undefined);
                                return fileLimitError();
                            }
                        }
                        const file = await catalog.create({
                            fileId,
                            ownerPrincipal: principal,
                            name,
                            origin: 'upload',
                            sourceFormat: format,
                            sizeBytes: st.size,
                            storageRef: { bucket: uploadStore.bucket, object },
                        });
                        return reply(principal, 201, { ok: true, file });
                    }
                    if (seg.length === 2 && seg[1] === 'download-grant' && method === 'POST') {
                        const rec = await ownedRecord(fileId);
                        if (!rec)
                            return fileNotFound();
                        if (rec.libraryEntryId) {
                            // Save-first bytes live in the engine library store:
                            // the same signed-URL pattern as /api/storage/sign.
                            const secret = opts.storageSign?.secret ?? opts.engineAccess?.secret;
                            if (!secret) {
                                return fail(principal, 501, 'storage signing is not configured on this gateway (ENGINE_ACCESS_SECRET is not set)');
                            }
                            const { token: st } = issueStorageToken({
                                secret,
                                entryId: rec.libraryEntryId,
                                principal,
                                ttlSeconds: opts.storageSign?.ttlSeconds ?? STORAGE_TOKEN_TTL_SECONDS,
                            });
                            const origin = (opts.storageSign?.publicUrl ??
                                process.env.ENGINE_PUBLIC_URL ??
                                opts.engineAccess?.tiers.standard ??
                                routes['/api/engine'] ??
                                '').replace(/\/+$/, '');
                            return reply(principal, 200, {
                                ok: true,
                                url: `${origin}/storage/${rec.libraryEntryId}?st=${st}`,
                            });
                        }
                        if (rec.storageRef) {
                            if (!uploadStore)
                                return fail(principal, 503, 'upload store unavailable');
                            let grant;
                            try {
                                grant = await uploadStore.getUrl(rec.storageRef.object, { principal });
                            }
                            catch (e) {
                                return fail(principal, 503, `upload store unavailable: ${e instanceof Error ? e.message : String(e)}`);
                            }
                            return reply(principal, 200, { ok: true, url: grant.url });
                        }
                        return failExtra(principal, 409, 'this file has no stored bytes yet — open it and let it save before downloading', { code: 'NO_STORED_BYTES' });
                    }
                }
                return fail(principal, 404, `not found: ${path}`);
            }
            // -- app gallery: app + data shares --------------------------------
            // (idea-app-gallery, user-confirmed share design 2026-10-21).
            // Auth + rate limit have already run: sharing requires a signed-in
            // principal. A share is the app WITH a materialized snapshot of
            // its bound data; recipients fetch the package and materialize
            // their OWN bound copies client-side — a recipient never touches
            // the owner's records. Credentials never travel: package
            // validation (service) rejects credential-shaped keys anywhere.
            if (path === '/api/shares' || path.startsWith('/api/shares/')) {
                if (!appShareStore) {
                    return fail(principal, 503, 'app sharing unavailable');
                }
                const shares = appShareStore;
                const seg = path.slice('/api/shares'.length).split('/').filter((s) => s.length > 0);
                // GET /api/shares — "shared by you" (metadata only, no packages).
                if (seg.length === 0 && method === 'GET') {
                    const mine = await shares.listByOwner(principal);
                    return reply(principal, 200, { ok: true, shares: mine.map(shareSummary) });
                }
                // POST /api/shares — create a share link for an app+data package.
                if (seg.length === 0 && method === 'POST') {
                    let body;
                    try {
                        body = await readBody(req, 16 * 1024 * 1024);
                    }
                    catch (e) {
                        return fail(principal, 400, bodyError(e));
                    }
                    const pkg = body?.package;
                    const check = validateAppSharePackage(pkg);
                    if (!check.ok) {
                        return failExtra(principal, 400, `invalid share package: ${check.errors.join('; ')}`, {
                            code: 'INVALID_SHARE_PACKAGE',
                            errors: check.errors,
                        });
                    }
                    const rec = await shares.create({
                        shareId: `share-${randomUUID()}`,
                        ownerPrincipal: principal,
                        pkg: pkg,
                    });
                    return reply(principal, 201, { ok: true, share: shareSummary(rec) });
                }
                // GET /api/shares/:shareId — a signed-in recipient fetches the
                // package. Missing OR revoked → the same 404 (no existence leak).
                if (seg.length === 1 && method === 'GET') {
                    const rec = await shares.get(seg[0]);
                    if (!rec || rec.revokedAt !== null) {
                        return fail(principal, 404, 'share not found');
                    }
                    return reply(principal, 200, { ok: true, share: shareSummary(rec), package: rec.pkg });
                }
                // DELETE /api/shares/:shareId — per-link revoke, owner only
                // (a non-owner gets the same 404 as a missing link).
                if (seg.length === 1 && method === 'DELETE') {
                    const ok = await shares.revoke(seg[0], principal);
                    if (!ok)
                        return fail(principal, 404, 'share not found');
                    return reply(principal, 200, { ok: true });
                }
                return fail(principal, 404, `not found: ${path}`);
            }
            // Route: longest '/api/<name>' prefix wins.
            const routePrefix = Object.keys(routes)
                .filter((p) => path === p || path.startsWith(p + '/'))
                .sort((a, b) => b.length - a.length)[0];
            if (!routePrefix)
                return fail(principal, 404, `no backend route for ${path}`);
            const backend = routes[routePrefix];
            // Path forwarding: strip the matched prefix (per-bin upstreams
            // serve bare paths) — EXCEPT service-family routes under
            // SERVICE_COMBINED, whose combined-runner upstream dispatches on
            // the full '/api/<name>' prefix (see GatewayOptions.serviceCombined).
            const upstreamPath = opts.serviceCombined && SERVICE_FAMILY_ROUTE_SET.has(routePrefix)
                ? path
                : path.slice(routePrefix.length) || '/';
            // Timeout class (Item D): EVERY engine route gets the 600s
            // engine upstream class (ENGINE_UPSTREAM_TIMEOUT_MS) — see the
            // constant's comment for the full rationale. The routes that
            // forced earlier per-route carve-outs are all engine routes and
            // stay covered: /load + /load/stream (P95 build ~40s of server
            // work, Cycle 10 Phase 2), GET /snapshot (P95 snapshot ~27s
            // before the first byte; the 30s default 502'd every P95 save
            // at 30,012ms, Cycle 10 finisher), /download (defect 2c: tens
            // of seconds of serialization before the first byte, and it
            // JOINS any in-flight checkpoint), /library-save + /library
            // (Cycle 10 closure, same serialization class), /read (W20:
            // reads PEND on the engine's build gate and queue behind the
            // build's synchronous event-loop block — the W18 gate's 5× 502
            // per P95 open). The checkpoint-class routes those carve-outs
            // missed — /session/release (checkpoint + evict),
            // /session/rehydrate, /load/storage-ref, /ops + /execute
            // (barrier checkpoint / save-pin queue inside the sequencer) —
            // are covered by the same route-level class instead of a new
            // enumeration that would drift again. Non-engine routes keep
            // the 30s fail-fast default below.
            const isEngineRoute = routePrefix === '/api/engine';
            // Buffer the body so it can be forwarded exactly once. The engine
            // /load endpoint carries whole file bytes (base64): it gets a
            // file-sized cap (Cycle 10, Phase 2). Every other endpoint keeps
            // the 1MB fail-closed cap, except the extras-carrying save-class
            // routes below.
            const isEngineFileLoad = path === '/api/engine/load' || path === '/api/engine/load/stream';
            // The engine download's POST body carries only small session
            // extras (client UI metadata + defined names), capped well above
            // the 1MB default but far below file size (defect 2c).
            const isEngineDownload = path === '/api/engine/download';
            // Library save (Cycle 10 closure): a small session-extras request
            // body — same body cap as the download.
            const isEngineLibrarySave = path === '/api/engine/library-save';
            // Session-extras sync carries the SAME extras payload the save
            // routes have always accepted (sheet styles expand over the used
            // range — multi-MB on P95-class workbooks), so it shares the
            // download/save body cap rather than the 1MB default.
            const isEngineSessionExtras = path === '/api/engine/session-extras';
            // Agent chat turns park on HITL asks for up to ~4 minutes by
            // design (see AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS): /message gets
            // the long timeout; every other agent route keeps the 30s
            // default (they are quick config/pending/watch calls, and a hung
            // one should still fail fast).
            const isAgentMessage = path === '/api/agent/message' && method === 'POST';
            const bodyCap = isEngineFileLoad
                ? LOAD_MAX_BODY_BYTES
                : isEngineDownload || isEngineLibrarySave || isEngineSessionExtras
                    ? DOWNLOAD_MAX_BODY_BYTES
                    : MAX_BODY_BYTES;
            let bodyBuf = null;
            try {
                const chunks = [];
                let total = 0;
                for await (const chunk of req) {
                    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                    total += buf.length;
                    if (total > bodyCap) {
                        req.resume();
                        return fail(principal, 413, `request body exceeds ${bodyCap} bytes`);
                    }
                    chunks.push(buf);
                }
                if (chunks.length > 0)
                    bodyBuf = Buffer.concat(chunks);
            }
            catch {
                return fail(principal, 400, 'failed to read request body');
            }
            await proxy(principal, backend, upstreamPath, url.search, method, req, res, bodyBuf, {
                timeoutMs: isEngineRoute
                    ? ENGINE_UPSTREAM_TIMEOUT_MS
                    : isAgentMessage
                        ? AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS
                        : DEFAULT_UPSTREAM_TIMEOUT_MS,
            });
            logAudit(method, path, principal, res.statusCode, Date.now() - started);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            try {
                fail('anonymous', 500, `gateway error: ${msg}`);
            }
            catch {
                // Response already in flight; nothing more to do.
            }
        }
    };
    const listener = Object.assign(handle, { auditLog: audit, limiter });
    return listener;
}
function bodyError(e) {
    if (e instanceof SyntaxError)
        return 'malformed JSON body';
    const msg = e instanceof Error ? e.message : String(e);
    return msg;
}
async function proxy(principal, backend, upstreamPath, search, method, req, res, bodyBuf, opts = {}) {
    const target = new URL(upstreamPath + search, backend);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || k === 'host' || k === 'content-length')
            continue;
        headers[k] = v;
    }
    headers['x-principal'] = principal; // gateway-verified identity for the service
    if (bodyBuf)
        headers['content-length'] = String(bodyBuf.length);
    await new Promise((resolve) => {
        const up = http.request(target, { method, headers, timeout: opts.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS }, (upRes) => {
            applyCors(res);
            const outHeaders = {};
            for (const [k, v] of Object.entries(upRes.headers)) {
                if (v === undefined || HOP_BY_HOP.has(k))
                    continue;
                outHeaders[k] = v;
            }
            res.writeHead(upRes.statusCode ?? 502, outHeaders);
            // Streamed, never buffered: pipe flushes chunks as the backend
            // emits them — this is what lets /api/engine/load/stream's NDJSON
            // chunks (meta → sheet rows → built) reach the browser
            // progressively (Cycle 10 Phase 4).
            upRes.pipe(res);
            upRes.on('end', () => resolve());
        });
        up.on('timeout', () => {
            up.destroy(new Error('backend timeout'));
        });
        up.on('error', () => {
            // Backend unreachable / refused: 502. The gateway never leaks the
            // backend's error text (it may carry internal detail).
            if (!res.headersSent) {
                applyCors(res);
                sendError(res, 502, 'backend unavailable');
            }
            else {
                res.end();
            }
            resolve();
        });
        if (bodyBuf)
            up.write(bodyBuf);
        up.end();
    });
}
/** Start a gateway on `port` (helper for tests and startAllLocal). */
export function listen(listener, port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const server = http.createServer(listener);
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
    });
}
