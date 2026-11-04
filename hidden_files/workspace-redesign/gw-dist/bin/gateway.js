#!/usr/bin/env node
/**
 * Gateway runner. PORT env, default 8100.
 * Usage: PORT=8100 node dist/bin/gateway.js
 *
 * Route table: env overrides or defaults to the local service ports.
 *   ENGINE_URL, VAULT_URL, META_URL, ETL_URL, AGENT_URL, ADDONS_URL
 *
 * SERVICE_COMBINED=on: the five service-family upstreams are the ONE
 * combined service-package runner (production) — service-family paths
 * are forwarded with the full '/api/<name>' prefix preserved. Default
 * off: per-bin upstreams, prefix stripped (local topology).
 * (The addons route was missing here — startAllLocal had it — so every
 * gateway-mode /api/addons/* call 404'd at the gateway: "no backend route
 * for /api/addons/catalog". The add-on service itself runs on :8107.)
 *
 * NOTE (2026-10-18, user's architecture decision): MCP is NOT behind the
 * gateway. MCP has its own direct ingress with MCP-native auth and its own
 * high rate-limit tier. The gateway does not route MCP traffic.
 *
 * AUTH_SECRET: REQUIRED — the bin exits 1 when it is unset (F-16,
 * security pass; no default exists). It signs the gateway JWTs;
 * production injects it from Secret Manager, local launchers set
 * it explicitly.
 *
 * ALLOW_DEV_LOGIN=1: explicitly enables the local-dev POST
 * /auth/login (F-1; default OFF — the route answers 404). Local
 * development ONLY: the endpoint mints a JWT for any userId the
 * caller names, with no credential check.
 *
 * FIREBASE_PROJECT_ID: enables POST /auth/firebase (Firebase Google
 * sign-in → gateway JWT). Without it the endpoint returns 503.
 */
import http from 'node:http';
import { createGateway, serviceCombinedEnabled } from '../gateway.js';
import { engineAccessMode, engineAccessSecret, engineAccessTtlSeconds, engineTierUrls, } from '../deploy/engineAccess.js';
import { createUserFileCatalog, createUserSettingsStore, createUserTierStore, } from '../deploy/userStore.js';
import { createUploadObjectStore, uploadStoreProvider } from '../deploy/uploadStore.js';
import { createProdAppShareStore, shareStoreProvider } from '../deploy/shareStore.js';
const port = Number(process.env.PORT ?? '8100');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';
// F-16 (security pass, High): NO default auth secret. AUTH_SECRET signs
// every gateway JWT (and, by fallback, the upload staging tokens); a
// publicly known fallback value would make every token forgeable, so
// the bin FAILS CLOSED — exit 1 — when it is unset, mirroring the MCP
// runner's posture. Local launchers set AUTH_SECRET explicitly.
const authSecret = process.env.AUTH_SECRET;
if (!authSecret) {
    console.error('[gateway] FATAL: AUTH_SECRET is not set — refusing to start (fail closed). Set AUTH_SECRET (Secret Manager in production; any explicit value for local dev).');
    process.exit(1);
}
// F-1 (security pass, Critical): the local-dev POST /auth/login (mints a
// JWT for ANY caller-named userId, no credential check) is served ONLY
// when ALLOW_DEV_LOGIN=1 is explicitly set. Default OFF.
const devLoginEnabled = process.env.ALLOW_DEV_LOGIN === '1';
if (devLoginEnabled) {
    console.warn('[gateway] WARNING: ALLOW_DEV_LOGIN=1 — POST /auth/login is ENABLED and mints a JWT for ANY caller-named userId with no credential check. Local development ONLY; never set this in production.');
}
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
if (!firebaseProjectId) {
    console.warn('[gateway] Firebase Google sign-in disabled — set FIREBASE_PROJECT_ID to enable /auth/firebase');
}
const routes = {
    '/api/engine': process.env.ENGINE_URL ?? 'http://127.0.0.1:8101',
    '/api/vault': process.env.VAULT_URL ?? 'http://127.0.0.1:8102',
    '/api/meta': process.env.META_URL ?? 'http://127.0.0.1:8103',
    '/api/etl': process.env.ETL_URL ?? 'http://127.0.0.1:8104',
    '/api/agent': process.env.AGENT_URL ?? 'http://127.0.0.1:8105',
    '/api/addons': process.env.ADDONS_URL ?? 'http://127.0.0.1:8107',
    '/api/connectors': process.env.CONNECTOR_URL ?? 'http://127.0.0.1:8108',
    // Automation (triggers): the default target is the service package
    // (detached CRUD over the shared store); the gateway owner-routes
    // requests naming a file with a LIVE session to the owning engine
    // instance instead (see gateway.ts).
    '/api/automation': process.env.AUTOMATION_URL ?? 'http://127.0.0.1:8108',
};
// Signed engine access (ENGINE_ACCESS_MODE=signed): the gateway issues
// tokens; without a shared secret it fails closed (endpoint 501, engine
// refuses unsigned traffic) rather than issuing unverifiable tokens.
let engineAccess;
if (engineAccessMode() === 'signed') {
    const secret = engineAccessSecret();
    if (!secret) {
        console.error('[gateway] ENGINE_ACCESS_MODE=signed but ENGINE_ACCESS_SECRET is unset — signed issuance DISABLED (fail closed)');
    }
    else {
        engineAccess = {
            secret,
            ttlSeconds: engineAccessTtlSeconds(),
            tiers: engineTierUrls(process.env, routes['/api/engine']),
        };
        console.log(`[gateway] signed engine access enabled (ttl=${engineAccess.ttlSeconds}s, standard=${engineAccess.tiers.standard}, xl=${engineAccess.tiers.xl})`);
    }
}
// SERVICE_COMBINED=on (production): the five *_URL upstreams all point
// at the ONE combined service-package runner, which dispatches on the
// '/api/<name>' prefix — so service-family paths are proxied with the
// full path preserved. Unset/off (local per-bin topology, the default):
// the prefix is stripped exactly as before. See gateway.ts.
const serviceCombined = serviceCombinedEnabled();
if (serviceCombined) {
    console.log('[gateway] SERVICE_COMBINED=on — service-family routes (vault, meta, etl, agent, addons) proxied with full /api/<name> path preserved');
}
// Product layer (CONTRACT.md): tier store + file catalog + upload
// object store, all env-driven local adapters by default. A prod-mode
// construction failure leaves the opts empty — createGateway retries
// the defaults, remembers the failure, and serves the product
// endpoints as 503 fail-closed while every other route stays up.
let productOpts = {};
let productStatus = 'unavailable (construction failed — product endpoints fail closed 503)';
const uploadPublicBaseUrl = (process.env.GATEWAY_PUBLIC_URL ?? '').trim() || `http://127.0.0.1:${port}`;
const uploadTokenSecret = engineAccessSecret() ?? authSecret;
try {
    productOpts = {
        userTierStore: createUserTierStore(process.env),
        userSettingsStore: createUserSettingsStore(process.env),
        userFileCatalog: createUserFileCatalog(process.env),
        // In prod mode the upload store is constructed asynchronously below
        // (it needs a Cloud Storage client); constructing it here would
        // throw (fail closed) and take the sibling stores down with it.
        ...(uploadStoreProvider(process.env) === 'prod'
            ? {}
            : {
                uploadStore: createUploadObjectStore(process.env, {
                    publicBaseUrl: uploadPublicBaseUrl,
                    tokenSecret: uploadTokenSecret,
                }),
            }),
        uploadTokenSecret,
        uploadPublicBaseUrl,
    };
    productStatus = `enabled (public base ${uploadPublicBaseUrl})`;
}
catch (e) {
    console.error(`[gateway] product layer store construction failed: ${e instanceof Error ? e.message : String(e)}`);
}
console.log(`[gateway] product layer: ${productStatus}`);
// App shares (SHARE_STORE=prod): the Firestore-backed store loads its
// client asynchronously (the bin/engine.ts session-store posture), so
// it is built here and injected. A construction failure leaves the
// opt unset — createGateway's own construction attempt then fails
// closed and /api/shares serves 503 while every other route stays up.
if (shareStoreProvider() === 'prod') {
    try {
        productOpts = { ...productOpts, appShareStore: await createProdAppShareStore(process.env) };
        console.log('[gateway] app share store: prod (Firestore)');
    }
    catch (e) {
        console.error(`[gateway] app share store unavailable: ${e instanceof Error ? e.message : String(e)} — /api/shares will fail closed (503)`);
    }
}
/**
 * Build the Cloud Storage client for the prod upload store. Mirrors
 * bin/engine.ts's posture: the official client is loaded by dynamic
 * import only in prod mode; missing config/package is a construction
 * failure (fail closed), never a silent fall back to local storage.
 */
async function loadGatewayUploadStorage(env) {
    const projectId = (env.GCP_PROJECT_ID ?? env.GCP_PROJECT ?? env.FIREBASE_PROJECT_ID ?? '').trim();
    if (!projectId) {
        throw new Error('UPLOAD_STORE=prod requires GCP_PROJECT_ID to be set (fail closed)');
    }
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    let StorageCtor;
    try {
        ({ Storage: StorageCtor } = await dynamicImport('@google-cloud/storage'));
    }
    catch {
        throw new Error('UPLOAD_STORE=prod requires the @google-cloud/storage package (not installed) — fail closed');
    }
    return new StorageCtor({ projectId });
}
// Upload store (UPLOAD_STORE=prod): the GCS-backed store needs a Cloud
// Storage client (createUploadObjectStore fails closed without one —
// the local adapter would strand uploads on this instance's tmpfs,
// unreachable for the engines' bucket pulls). Loaded asynchronously,
// mirroring the share-store injection above and bin/engine.ts's prod
// upload reader. Construction failure leaves the local/default store
// in place ONLY when the provider is local; in prod mode the gateway's
// own construction retry fails closed (503) rather than silently
// serving a local store.
if (uploadStoreProvider(process.env) === 'prod') {
    try {
        const storage = await loadGatewayUploadStorage(process.env);
        productOpts = {
            ...productOpts,
            uploadStore: createUploadObjectStore(process.env, {
                storage,
                publicBaseUrl: uploadPublicBaseUrl,
                tokenSecret: uploadTokenSecret,
            }),
        };
        console.log('[gateway] upload store: prod (Cloud Storage signed URLs)');
    }
    catch (e) {
        console.error(`[gateway] upload store prod construction failed: ${e instanceof Error ? e.message : String(e)} — product upload endpoints will fail closed (503)`);
    }
}
const listener = createGateway({
    authSecret,
    devLoginEnabled,
    firebaseProjectId,
    routes,
    ...productOpts,
    rateLimit: {
        points: Number(process.env.RATE_LIMIT_POINTS ?? '600'),
        perSeconds: Number(process.env.RATE_LIMIT_WINDOW ?? '60'),
    },
    serviceCombined,
    ...(engineAccess ? { engineAccess } : {}),
    // Storage download signing (save/download separation): the gateway
    // signs /storage URLs with the engine signing secret whenever one is
    // configured — independent of ENGINE_ACCESS_MODE (the /storage route
    // validates the token itself). ENGINE_PUBLIC_URL is the engine's
    // directly-reachable origin for those URLs; without it the gateway
    // falls back to its configured engine upstream origin.
    storageSign: {
        secret: engineAccessSecret() ?? undefined,
        publicUrl: process.env.ENGINE_PUBLIC_URL,
    },
});
const server = http.createServer(listener);
// Node's default requestTimeout (300s) would sever the longest proxied
// engine exchanges — /load/stream opens and /read requests pended on a
// workbook build (600s upstream timeout class in gateway.ts, W20) —
// before the proxy's own timeout could govern them. Raise it past
// that class.
server.requestTimeout = 660_000;
server.listen(port, host, () => {
    console.log(`[gateway] listening on ${host}:${port}`);
});
