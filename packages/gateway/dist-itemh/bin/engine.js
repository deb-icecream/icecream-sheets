#!/usr/bin/env node
/**
 * Engine service runner. PORT env, default 8101.
 * Usage: PORT=8101 node dist/bin/engine.js
 *
 * Deployment env (design-docs/deployment-architecture.md):
 *   ENGINE_ACCESS_MODE=signed + ENGINE_ACCESS_SECRET — require
 *     gateway-issued signed tokens on every route (direct connection).
 *   SESSION_STORE=local|prod — session registry/journal/snapshot
 *     provider; prod (Firestore + Cloud Storage) is constructed here
 *     and FAILS CLOSED at startup when its config/credentials are
 *     absent (createSessionStores throws → non-zero exit).
 *   SESSION_LIFECYCLE=on + IDLE_TIMEOUT_MS — idle backstop sweeper.
 *   UPLOAD_STORE=prod — product layer: POST /load/storage-ref resolves
 *     workbook bytes from Cloud Storage (bucket UPLOAD_BUCKET, default
 *     'icecream-uploads') via the reader constructed here; construction
 *     FAILS CLOSED at startup like the session stores (missing project
 *     config or the @google-cloud/storage package → non-zero exit).
 *     Any other value leaves the engine on its local upload-store dir
 *     reader (UPLOAD_STORE_DIR, default <sessionDataDir>/uploads).
 */
import http from 'node:http';
import { createEngineListener } from '../services/engineSvc.js';
import { createSessionStores, sessionStoreProvider, } from '../deploy/sessionStore.js';
const port = Number(process.env.PORT ?? '8101');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';
let sessionStores;
if (sessionStoreProvider() === 'prod') {
    sessionStores = await createSessionStores();
    console.log('[engine] session store: prod (Firestore registry/journal + Cloud Storage snapshots)');
}
/**
 * Build the prod upload-object reader for /load/storage-ref (product
 * layer CONTRACT.md). Mirrors sessionStore.loadProdClients' posture:
 * the official client is an optional dependency loaded by dynamic
 * import only in prod mode, and any missing config/package is a
 * startup failure — never a silent fall back to local storage.
 */
async function createProdUploadObjects() {
    const bucket = (process.env.UPLOAD_BUCKET ?? '').trim() || 'icecream-uploads';
    const projectId = (process.env.GCP_PROJECT_ID ?? process.env.FIREBASE_PROJECT_ID ?? '').trim();
    if (!projectId) {
        throw new Error('UPLOAD_STORE=prod requires GCP_PROJECT_ID to be set — refusing to start with a half-configured production upload store (fail closed)');
    }
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    let StorageCtor;
    try {
        ({ Storage: StorageCtor } = await dynamicImport('@google-cloud/storage'));
    }
    catch {
        throw new Error('UPLOAD_STORE=prod requires the @google-cloud/storage package (not installed) — install it or use UPLOAD_STORE=local (fail closed)');
    }
    const storage = new StorageCtor({
        projectId,
    });
    return {
        bucket,
        get: async (object) => {
            try {
                const [bytes] = await storage.bucket(bucket).file(object).download();
                return new Uint8Array(bytes);
            }
            catch {
                return null; // no such object → the route answers 404
            }
        },
    };
}
let uploadObjects;
if ((process.env.UPLOAD_STORE ?? '').trim().toLowerCase() === 'prod') {
    uploadObjects = await createProdUploadObjects();
    console.log(`[engine] upload store: prod (Cloud Storage bucket ${uploadObjects.bucket})`);
}
const server = http.createServer(createEngineListener({
    ...(sessionStores ? { sessionStores } : {}),
    ...(uploadObjects ? { uploadObjects } : {}),
}));
// Node's default requestTimeout (300s) would sever a /read pended on a
// long workbook build (engineSvc's build gate waits up to the 600s
// load class, W20) and the longest /load/stream opens. Raise it past
// that class; headersTimeout keeps its default (request HEADERS still
// arrive promptly — the wait is on the response side).
server.requestTimeout = 660_000;
server.listen(port, host, () => {
    console.log(`[engine] listening on ${host}:${port}`);
});
