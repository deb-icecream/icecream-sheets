/**
 * API gateway: the single entry point in front of every icecream-sheets
 * service.
 *
 * - POST /auth/login  (LOCAL-DEV ONLY: accepts { userId }, issues a JWT.
 *   Gated behind GatewayOptions.devLoginEnabled (F-1, security pass):
 *   the route answers 404 unless a launcher explicitly opts in — the
 *   shipped bin wires it from ALLOW_DEV_LOGIN==='1', default OFF.
 *   Production identity is the real IdP (Firebase, below); NEVER accept
 *   arbitrary userIds in prod.)
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
import http, { type RequestListener } from 'node:http';
import { type RateLimiter } from './rateLimit.js';
import { type EngineTierUrls } from './deploy/engineAccess.js';
import { type FileRegistry } from './deploy/fileRegistry.js';
import { type UserFileCatalog, type UserSettingsStore, type UserTierStore } from './deploy/userStore.js';
import { type UploadObjectStore } from './deploy/uploadStore.js';
import { type AppShareStore } from './deploy/shareStore.js';
import { type BuiltAppStore } from './deploy/builtAppStore.js';
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
export declare const ENGINE_UPSTREAM_TIMEOUT_MS = 600000;
/**
 * Upstream timeout for POST /api/agent/message (~4.5min). An agent turn
 * can park on a human-in-the-loop ask for up to the agent service's
 * 4-minute HITL wait (agentSvc AGENT_HITL_TIMEOUT_MS, by design), so
 * the 30s default killed every parked turn at the proxy with a 502
 * (probe D4, reproduced 5×). 270s covers the 4-minute park plus the
 * turn's own tool work; the gateway server's requestTimeout (660s in
 * bin/gateway.ts) already sits above this class.
 */
export declare const AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS = 270000;
export interface GatewayOptions {
    /** HMAC secret for the local-dev JWTs. */
    authSecret: string | Uint8Array;
    /** Route table: '/api/<name>' → backend base URL (e.g. 'http://127.0.0.1:8101'). */
    routes: Record<string, string>;
    /** Token-bucket config, applied per principal. */
    rateLimit: {
        points: number;
        perSeconds: number;
    };
    /** JWT lifetime for /auth/login. Default 12h. */
    loginTtlSeconds?: number;
    /**
     * F-1 (security pass, Critical): POST /auth/login mints a gateway JWT
     * for ANY caller-named userId with NO credential check — full account
     * impersonation if served in production. The route is served ONLY
     * when this is explicitly true; default FALSE → the route answers
     * 404, indistinguishable from an unknown route. The shipped bin
     * (bin/gateway.ts) wires it from ALLOW_DEV_LOGIN==='1' (default OFF)
     * and warns loudly when on; local launchers opt in explicitly.
     */
    devLoginEnabled?: boolean;
    /**
     * Firebase project id (FIREBASE_PROJECT_ID). When set, POST
     * /auth/firebase exchanges verified Firebase ID tokens for gateway
     * JWTs. When unset, /auth/firebase returns 503.
     */
    firebaseProjectId?: string;
    /** Ring-buffer size for the request audit log. Default 500. */
    auditSize?: number;
    /**
     * Signed engine access (deployment-architecture.md §Engine access
     * pattern): when present, POST /api/engine/access issues short-lived
     * HMAC-signed engine tokens after the gateway's auth + rate limiting,
     * and the client connects DIRECTLY to the returned engine URL. When
     * absent the endpoint answers 501 and all engine traffic keeps using
     * the proxy routes (ENGINE_ACCESS_MODE=proxy, today's default).
     */
    engineAccess?: {
        /** Shared HMAC secret (ENGINE_ACCESS_SECRET; Secret Manager in prod). */
        secret: string;
        /** Token lifetime in seconds. Default 600 (10 min). */
        ttlSeconds?: number;
        /** Tier → direct engine base URL (ENGINE_URL_STANDARD / _XL). */
        tiers: EngineTierUrls;
    };
    /**
     * Storage download signing (save/download separation, 2026-10-21):
     * POST /api/storage/sign issues a short-lived HMAC token for one
     * library-store entry and returns a DIRECT engine-service URL — the
     * gateway signs, it never proxies the file bytes. `secret` is the
     * engine signing secret (ENGINE_ACCESS_SECRET; falls back to
     * engineAccess.secret). When no secret is configured the endpoint
     * answers 501 (fail closed — no unsigned fallback). `publicUrl` is
     * ENGINE_PUBLIC_URL: the engine service's directly-reachable origin;
     * when absent, the tier-standard engine URL, else the configured
     * '/api/engine' upstream origin, is used.
     */
    storageSign?: {
        secret?: string;
        publicUrl?: string;
        /** Token lifetime in seconds. Default 120. */
        ttlSeconds?: number;
    };
    /**
     * Combined service-package upstreams (SERVICE_COMBINED=on in
     * production; W19). When true, service-family routes
     * (SERVICE_FAMILY_ROUTE_PREFIXES: vault, meta, etl, agent, addons)
     * are proxied with the FULL path preserved — `/api/vault/store`
     * reaches the upstream as `/api/vault/store` — because the combined
     * runner (services/servicePackage.ts) dispatches on the
     * `/api/<name>` prefix; a stripped bare path would 404 there, and
     * bare-path dispatch inside the combined process would be ambiguous
     * anyway (etl and addons both serve a bare POST /run).
     *
     * When false/absent (the default — today's local per-bin topology,
     * where each bin serves bare paths), the matched route prefix is
     * stripped exactly as before, for every route. The flag never
     * affects non-service-family routes (e.g. /api/engine keeps the
     * strip behavior in both modes).
     */
    serviceCombined?: boolean;
    /**
     * Phase 2 session ownership registry (design doc §9) for
     * POST /api/engine/open. Default: createFileRegistry(process.env)
     * (local FS adapter under FILE_REGISTRY_DIR; prod construction
     * failures are remembered and surface as 503 fail-closed at open
     * time, never as a silently-local registry).
     */
    fileRegistry?: FileRegistry;
    /**
     * Phase 2 engine instance map (ENGINE_INSTANCES env, instanceId →
     * baseUrl) used to pick the claim target on a first open. Default:
     * the single configured tier URL under ENGINE_INSTANCE_ID
     * (default 'engine-1').
     */
    engineInstances?: Record<string, string>;
    /** This deployment's preferred engine instance id (claim target). */
    engineInstanceId?: string;
    /** Ownership lease TTL for claims (OWNERSHIP_LEASE_MS). */
    ownershipLeaseMs?: number;
    /**
     * Product layer (CONTRACT.md §Tiers/§File catalog/§Upload object
     * store): per-user tier store. Default: createUserTierStore(
     * process.env) (local adapter under USER_STORE_DIR). A prod-mode
     * construction failure is remembered and makes the product
     * endpoints fail closed (503); other routes are unaffected.
     */
    userTierStore?: UserTierStore;
    /** Product layer: per-user file catalog. Same defaulting posture. */
    userFileCatalog?: UserFileCatalog;
    /** Product layer: upload object store. Same defaulting posture. */
    uploadStore?: UploadObjectStore;
    /**
     * HMAC secret for upload staging tokens (the ENGINE_ACCESS_SECRET
     * storage-sign secret path). Default: storageSign/engineAccess
     * secret, else ENGINE_ACCESS_SECRET env, else the gateway auth
     * secret (local-dev fallback so staging works out of the box).
     */
    uploadTokenSecret?: string;
    /**
     * Public base URL the upload staging URLs are built on
     * (GATEWAY_PUBLIC_URL; the bin sets it from the listen port).
     * Synced onto the upload store when provided.
     */
    uploadPublicBaseUrl?: string;
    /**
     * App-gallery share store (app + data snapshot shares). Default:
     * createAppShareStore(process.env) (local adapter). A prod-mode
     * construction failure makes /api/shares fail closed (503); other
     * routes are unaffected.
     */
    appShareStore?: AppShareStore;
    /**
     * Workspace settings store (per-user profile + Icecream Office app
     * settings; hidden_files/workspace-settings/BRIEF.md). Default:
     * createUserSettingsStore(process.env) (local adapter under
     * USER_STORE_DIR). A prod-mode construction failure makes
     * /api/settings + DELETE /api/account fail closed (503); other
     * routes are unaffected.
     */
    userSettingsStore?: UserSettingsStore;
    /**
     * W4 built-app store (UI-built AppSpecs, keyed by owner + file).
     * Default: createBuiltAppStore(process.env) (local adapter under
     * BUILT_APP_STORE_DIR / the session data dir). A prod-mode
     * construction failure makes /api/built-apps fail closed (503);
     * other routes are unaffected.
     */
    builtAppStore?: BuiltAppStore;
}
/** Parse the ENGINE_INSTANCES env JSON map (instanceId → baseUrl). */
export declare function parseEngineInstances(raw: string | undefined): Record<string, string>;
/**
 * The service-family route prefixes served by the combined
 * service-package runner in production (vault, meta, etl, agent,
 * addons). `/api/addons` is a service-family route like the other
 * four — it is the addons bin's surface, not an engine route.
 */
export declare const SERVICE_FAMILY_ROUTE_PREFIXES: readonly ["/api/vault", "/api/meta", "/api/etl", "/api/agent", "/api/addons", "/api/connectors", "/api/automation"];
/**
 * SERVICE_COMBINED env parsing for the gateway bin: 'on' (the value
 * deploy/services/gateway.yaml sets), 'true' and '1' also enable it;
 * anything else (including unset) is OFF, so the default local
 * per-bin topology keeps its byte-identical strip behavior.
 */
export declare function serviceCombinedEnabled(env?: NodeJS.ProcessEnv): boolean;
export interface AuditEntry {
    ts: string;
    method: string;
    path: string;
    principal: string;
    status: number;
    durationMs: number;
}
export interface GatewayListener extends RequestListener {
    /** In-memory request audit log (ring buffer, newest last). For tests. */
    auditLog: AuditEntry[];
    /** The rate limiter (for tests / status). */
    limiter: RateLimiter;
}
export declare function createGateway(opts: GatewayOptions): GatewayListener;
/** Start a gateway on `port` (helper for tests and startAllLocal). */
export declare function listen(listener: GatewayListener, port: number, host?: string): Promise<http.Server>;
