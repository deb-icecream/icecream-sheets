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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createEngineListener, type EngineServiceDeps } from '../services/engineSvc.js';
import { createAutomationListener } from '../services/automationSvc.js';
import { TriggerSupervisor } from '../services/triggerSupervisor.js';
import { createFileRegistry, type FileRegistry } from '../deploy/fileRegistry.js';
import { installServerEngineGuards } from '../services/serverEngineGuards.js';
import {
  createSessionStores,
  loadProdClients,
  prodSessionConfig,
  sessionStoreProvider,
  type SessionStores,
  type StorageLike,
} from '../deploy/sessionStore.js';

const port = Number(process.env.PORT ?? '8101');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';

let sessionStores: SessionStores | undefined;
let engineFileRegistry: FileRegistry | undefined;
if (sessionStoreProvider() === 'prod') {
  sessionStores = await createSessionStores();
  console.log('[engine] session store: prod (Firestore registry/journal + Cloud Storage snapshots)');
  // File registry (§9 ownership + section-4 grants): the SAME
  // Firestore the session stores use. It must be built WITH a client
  // and injected — createFileRegistry(process.env) without one throws
  // in prod mode, which silently disabled the engine's ownership
  // heartbeats and per-request ACL re-derivation (engineSvc's lazy
  // fallback) and the trigger supervisor's registry (the batch-2
  // live-proof registry failure family). A failure here is a startup
  // failure, like the session stores — never a silent degrade.
  const { db } = await loadProdClients(prodSessionConfig());
  engineFileRegistry = createFileRegistry(process.env, { firestoreDb: db });
  console.log('[engine] file registry: prod (Firestore — ownership heartbeat + grants)');
}

/**
 * Build the prod upload-object reader for /load/storage-ref (product
 * layer CONTRACT.md). Mirrors sessionStore.loadProdClients' posture:
 * the official client is an optional dependency loaded by dynamic
 * import only in prod mode, and any missing config/package is a
 * startup failure — never a silent fall back to local storage.
 */
async function createProdUploadObjects(): Promise<NonNullable<EngineServiceDeps['uploadObjects']>> {
  const bucket = (process.env.UPLOAD_BUCKET ?? '').trim() || 'icecream-uploads';
  const projectId = (process.env.GCP_PROJECT_ID ?? process.env.FIREBASE_PROJECT_ID ?? '').trim();
  if (!projectId) {
    throw new Error(
      'UPLOAD_STORE=prod requires GCP_PROJECT_ID to be set — refusing to start with a half-configured production upload store (fail closed)',
    );
  }
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  let StorageCtor: unknown;
  try {
    ({ Storage: StorageCtor } = await dynamicImport('@google-cloud/storage'));
  } catch {
    throw new Error(
      'UPLOAD_STORE=prod requires the @google-cloud/storage package (not installed) — install it or use UPLOAD_STORE=local (fail closed)',
    );
  }
  const storage = new (StorageCtor as new (o: Record<string, unknown>) => StorageLike)({
    projectId,
  });
  return {
    bucket,
    get: async (object: string) => {
      try {
        const [bytes] = await storage.bucket(bucket).file(object).download();
        return new Uint8Array(bytes);
      } catch {
        return null; // no such object → the route answers 404
      }
    },
  };
}

let uploadObjects: EngineServiceDeps['uploadObjects'];
if ((process.env.UPLOAD_STORE ?? '').trim().toLowerCase() === 'prod') {
  uploadObjects = await createProdUploadObjects();
  console.log(`[engine] upload store: prod (Cloud Storage bucket ${uploadObjects.bucket})`);
}

// F-11 (security pass): this bin is the SERVER engine host — before it
// serves anything, deny the batch-11 code-exec / network formula
// functions (PY, WEBSERVICE/IMPORT*, STOCKHISTORY/GOOGLEFINANCE live
// fetch) whose engine defaults spawn python3/curl from file-borne
// formulas. Local/desktop hosts never install these guards.
installServerEngineGuards();
console.log(
  '[engine] server guards installed (F-11): PY, WEBSERVICE/IMPORT* and live market-data fetch are disabled in this host',
);

// Trigger hosting (triggers program): the supervisor lives HERE,
// in the engine process — the engine reports its live session through
// sessionHooks and the supervisor attaches the trigger runtime to the
// session's own EngineHost (writes go through the sequenced op
// composition). The automation management surface is mounted on the
// same port under /api/automation (the gateway owner-routes live
// files here; closed-file CRUD is served by the service package's own
// supervisor against the same store). Construction failure leaves
// the surface fail-closed (503) and never breaks the engine.
let triggerSupervisor: TriggerSupervisor | null = null;
try {
  const engineRegistry = engineFileRegistry ?? createFileRegistry(process.env);
  triggerSupervisor = new TriggerSupervisor({
    registry: engineRegistry,
    // Scheduler tick parity: the engine-bin surface also serves
    // /tick; self-opens target this engine itself. (The production
    // scheduler job targets the SERVICE package's endpoint.)
    claimRegistry: engineRegistry,
    engineBaseUrl: `http://127.0.0.1:${port}`,
  });
  triggerSupervisor.start();
  console.log('[engine] trigger supervisor started (automation surface at /api/automation)');
} catch (e) {
  console.error(
    `[engine] trigger supervisor failed to start: ${e instanceof Error ? e.message : String(e)} — automation surface fail-closed`,
  );
  triggerSupervisor = null;
}
const automationListener = createAutomationListener({ supervisor: triggerSupervisor });
const engineListener = createEngineListener({
    ...(sessionStores ? { sessionStores } : {}),
    ...(engineFileRegistry ? { fileRegistry: engineFileRegistry } : {}),
    ...(uploadObjects ? { uploadObjects } : {}),
    sessionHooks: {
      onSessionReady: (handle) => {
        void triggerSupervisor?.noteSessionReady(handle);
      },
      onSessionClosed: (sessionId) => {
        void triggerSupervisor?.noteSessionClosed(sessionId);
      },
    },
  });

const server = http.createServer(
  (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (url === '/api/automation' || url.startsWith('/api/automation/')) {
      req.url = url.slice('/api/automation'.length) || '/';
      return automationListener(req, res);
    }
    return engineListener(req, res);
  },
);
// Node's default requestTimeout (300s) would sever a /read pended on a
// long workbook build (engineSvc's build gate waits up to the 600s
// load class, W20) and the longest /load/stream opens. Raise it past
// that class; headersTimeout keeps its default (request HEADERS still
// arrive promptly — the wait is on the response side).
server.requestTimeout = 660_000;
server.listen(port, host, () => {
  console.log(`[engine] listening on ${host}:${port}`);
});
