/**
 * ETL service: recipe execution behind HTTP.
 *
 * Runs runRecipe() (packages/service/src/etl/runner.ts) with minimal local
 * deps:
 * - fetchText: global fetch (node 20+).
 * - connectors: an EMPTY ConnectorRegistry — connector-backed sources fail
 *   closed with "unknown connector". PROD WIRES THE REAL CONNECTORS HERE
 *   (the connector registry from packages/service/src/connectors/, with the
 *   credential vault seam), never in this local stub.
 * - vault: fail-closed credential resolver — credentialRef sources need the
 *   real vault service in prod.
 * - writer: in-memory atomic table writer (per targetKey).
 * - versions: in-memory VersionStore (retention for failed-run recovery).
 * - runCode: absent — `custom` transform steps fail closed, per the runner.
 * - checkPermission: absent locally. Prod enforces design-docs/etl-pipeline.md
 *   §6 here: read on the credential + write on the target, via the host's
 *   checkPermission callback.
 *
 * Endpoints:
 * - GET  /health
 * - POST /run { recipe: EtlRecipe } → the RunRecord as JSON
 */
import { ConnectorRegistry, KeyManager, createVersionStore, memoryPersistence, runRecipe, } from '@icecream-sheets/service';
import { handlePreflight, readBody, sendError, sendJson } from '../httpUtils.js';
/** In-memory table writer: atomic swap per target key. */
function createMemoryWriter() {
    const tables = new Map();
    const keyOf = (t) => t.kind === 'workbook-table'
        ? `workbook:${t.workbookId}:${t.sheetName}:${t.tableName}`
        : `adapter:${t.adapterId}`;
    return {
        tables,
        async writeAtomic(target, table) {
            // In-memory: the swap is a single Map.set — atomic by construction.
            tables.set(keyOf(target), table);
        },
        async readCurrent(target) {
            return tables.get(keyOf(target)) ?? null;
        },
    };
}
const writer = createMemoryWriter();
/**
 * Retained versions, encrypted at rest (§3). The store build is async
 * (WebCrypto key generation); the promise is awaited per request.
 */
const etlPersistence = memoryPersistence();
const versionsReady = createVersionStore(etlPersistence, new KeyManager(etlPersistence));
// Empty registry: connector-backed sources fail closed until prod wires the
// real connectors (see header comment).
const connectors = new ConnectorRegistry();
export function createEtlListener() {
    return async (req, res) => {
        if (handlePreflight(req, res))
            return;
        const url = new URL(req.url ?? '/', 'http://etl');
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        try {
            if (path === '/health' && method === 'GET') {
                return sendJson(res, 200, { ok: true, service: 'etl' });
            }
            if (path === '/run' && method === 'POST') {
                const body = (await readBody(req));
                if (!body || typeof body.recipe !== 'object' || body.recipe === null) {
                    return sendError(res, 400, '{ recipe: EtlRecipe } required');
                }
                let record;
                try {
                    record = await runRecipe(body.recipe, {
                        fetchText: async (u) => {
                            const r = await fetch(u);
                            if (!r.ok)
                                throw new Error(`fetch ${u}: HTTP ${r.status}`);
                            return r.text();
                        },
                        connectors,
                        // Fail closed: no credential resolver is wired locally. Prod
                        // resolves credentialRefs against the vault service.
                        vault: {
                            resolveCredential: async () => {
                                throw new Error('etl: credentialRef sources need the vault service (not wired in local dev)');
                            },
                        },
                        writer,
                        versions: await versionsReady,
                    });
                }
                catch (e) {
                    // Invalid recipe or denied permission: the runner throws.
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
                return sendJson(res, 200, record);
            }
            return sendError(res, 404, `not found: ${path}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return sendError(res, 500, `etl error: ${msg}`);
        }
    };
}
