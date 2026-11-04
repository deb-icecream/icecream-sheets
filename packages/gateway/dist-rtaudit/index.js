/**
 * @icecream-sheets/gateway — API gateway + local backend services.
 *
 * Topology (local dev): gateway :8100 in front of engine :8101, vault :8102,
 * meta :8103, etl :8104, agent :8105, addons :8107.
 *
 * MCP is deliberately NOT routed through this gateway (user's deployment
 * ruling): the MCP server has its own direct ingress on :8106, authenticates
 * itself per the MCP spec, and enforces its own (much higher) rate-limit
 * tier. The gateway never validates MCP users.
 */
import http from 'node:http';
import { createGateway, listen as listenGateway, } from './gateway.js';
export { SERVICE_FAMILY_ROUTE_PREFIXES, serviceCombinedEnabled } from './gateway.js';
import { createEngineListener } from './services/engineSvc.js';
import { createVaultListener } from './services/vaultSvc.js';
import { createMetaListener } from './services/metaSvc.js';
import { createEtlListener } from './services/etlSvc.js';
import { createAgentListener } from './services/agentSvc.js';
import { createAddonListener } from './services/addonSvc.js';
import { createDelegatingAddonAuthorizer, createEngineServiceBinding, } from './services/addonEngineBinding.js';
export { createGateway, listenGateway };
export { engineAccessMode, engineAccessSecret, engineAccessTtlSeconds, engineSessionRateLimit, engineTierUrls, idleTimeoutMs, isSessionId, issueEngineAccessToken, journalSegmentMaxOps, newSessionId, selectEngineTier, sessionLifecycleEnabled, sessionSweeperMs, snapshotEveryMs, snapshotEveryOps, verifyEngineAccessToken, EngineAccessError, } from './deploy/engineAccess.js';
export { createFileRegistry, createLocalFileRegistry, fileRegistryDir, fileRegistryProvider, isLiveOwner, ownershipHeartbeatMs, ownershipLeaseMs, FirestoreFileRegistry, LocalFileRegistry, MemoryFileRegistry, } from './deploy/fileRegistry.js';
export { cmdToCollabOp, collabOpToCmd, presenceColorFor, retentionPruneUpto, segmentPrunable, PRESENCE_COLORS, } from './services/engineSvc.js';
export { createLocalSessionStores, createSessionStores, prodSessionConfig, sessionDataDir, sessionStoreProvider, FirestoreSessionStores, LocalSessionStores, MemorySessionStores, opsFromSegments, wrapFirestore, } from './deploy/sessionStore.js';
export { createRateLimiter } from './rateLimit.js';
export { createEngineListener } from './services/engineSvc.js';
export { createVaultListener } from './services/vaultSvc.js';
export { createMetaListener } from './services/metaSvc.js';
export { createEtlListener } from './services/etlSvc.js';
export { createAgentListener } from './services/agentSvc.js';
export { NodeRemoteEngineHost, REMOTE_MUTATING_OPS, } from './services/remoteEngineHost.js';
export { createAgentSessionResolver, pickActiveSession, readLocalRegistryRecords, recordMatchesPrincipal, participantPrincipals, } from './services/agentSessionResolver.js';
export { createAddonListener } from './services/addonSvc.js';
export { createServicePackageListener, productionAddonDeps, SERVICE_PACKAGE_SERVICES, } from './services/servicePackage.js';
export { createDelegatingAddonAuthorizer, createEngineServiceBinding, } from './services/addonEngineBinding.js';
export { filePersistence, gatewayDataDir, persistenceFileFor, GATEWAY_DATA_DIR_ENV, } from './filePersistence.js';
export * from './httpUtils.js';
export const DEFAULT_PORTS = {
    gateway: 8100,
    engine: 8101,
    vault: 8102,
    meta: 8103,
    etl: 8104,
    agent: 8105,
    mcp: 8106,
    addons: 8107,
};
/**
 * Start the whole local topology in-process (for end-to-end tests and local
 * dev without six terminals). Equivalent to running each dist/bin/*.js with
 * its default PORT.
 */
export async function startAllLocal(opts = {}) {
    const host = opts.host ?? '127.0.0.1';
    const ports = { ...DEFAULT_PORTS, ...(opts.ports ?? {}) };
    const servers = {};
    async function start(name, port, listener) {
        servers[name] = await new Promise((resolve, reject) => {
            const s = http.createServer(listener);
            s.once('error', reject);
            s.listen(port, host, () => resolve(s));
        });
        console.log(`[${name}] listening on ${host}:${port}`);
    }
    await start('engine', ports.engine, createEngineListener());
    await start('vault', ports.vault, createVaultListener());
    await start('meta', ports.meta, createMetaListener());
    await start('etl', ports.etl, createEtlListener());
    await start('agent', ports.agent, createAgentListener());
    // Add-on production binding (§5): /run resolves against the engine
    // service's open workbook with the real principal + permission checks.
    const engineBaseUrl = `http://${host}:${ports.engine}`;
    await start('addons', ports.addons, createAddonListener({
        authorizer: createDelegatingAddonAuthorizer(),
        resolveBinding: (documentId, reqCtx) => createEngineServiceBinding({
            engineBaseUrl,
            documentId,
            principal: reqCtx.principal,
            authorization: reqCtx.authorization,
        }),
    }));
    await start('gateway', ports.gateway, createGateway({
        authSecret: opts.authSecret ?? 'local-dev-secret',
        routes: {
            '/api/engine': `http://${host}:${ports.engine}`,
            '/api/vault': `http://${host}:${ports.vault}`,
            '/api/meta': `http://${host}:${ports.meta}`,
            '/api/etl': `http://${host}:${ports.etl}`,
            '/api/agent': `http://${host}:${ports.agent}`,
            '/api/addons': `http://${host}:${ports.addons}`,
        },
        rateLimit: opts.rateLimit ?? { points: 600, perSeconds: 60 },
        ...(opts.serviceCombined ? { serviceCombined: true } : {}),
        ...(opts.engineAccess ? { engineAccess: opts.engineAccess } : {}),
    }));
    return {
        servers,
        close: async () => {
            await Promise.all(Object.values(servers).map((s) => new Promise((resolve) => s.close(() => resolve()))));
        },
    };
}
