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
import { createGateway, listen as listenGateway, type GatewayOptions } from './gateway.js';
export { ENGINE_UPSTREAM_TIMEOUT_MS, SERVICE_FAMILY_ROUTE_PREFIXES, serviceCombinedEnabled, } from './gateway.js';
export { createGateway, listenGateway };
export type { GatewayOptions };
export { engineAccessMode, engineAccessSecret, engineAccessTtlSeconds, engineSessionRateLimit, engineTierUrls, idleTimeoutMs, isSessionId, issueEngineAccessToken, journalSegmentMaxOps, newSessionId, selectEngineTier, sessionLifecycleEnabled, sessionSweeperMs, snapshotEveryMs, snapshotEveryOps, verifyEngineAccessToken, EngineAccessError, type EngineAccessClaims, type EngineAccessErrorReason, type EngineAccessMode, type EngineAccessRole, type EngineTier, type EngineTierUrls, } from './deploy/engineAccess.js';
export { createFileRegistry, createLocalFileRegistry, fileRegistryDir, fileRegistryProvider, isLiveOwner, ownershipHeartbeatMs, ownershipLeaseMs, FirestoreFileRegistry, LocalFileRegistry, MemoryFileRegistry, type FileRegistry, type FileRegistryRecord, } from './deploy/fileRegistry.js';
export { cmdToCollabOp, collabOpToCmd, presenceColorFor, retentionPruneUpto, segmentPrunable, PRESENCE_COLORS, type DeltaCell, type DeltaLogEntry, type DeltaOrigin, } from './services/engineSvc.js';
export { createLocalSessionStores, createSessionStores, prodSessionConfig, sessionDataDir, sessionStoreProvider, FirestoreSessionStores, LocalSessionStores, MemorySessionStores, opsFromSegments, wrapFirestore, type FirestoreLike, type JournalEntry, type JournalSegment, type OpJournal, type ProdSessionConfig, type SessionRecord, type SessionRegistry, type SessionStatus, type SessionStores, type SnapshotStore, type StorageLike, type StoredSnapshot, } from './deploy/sessionStore.js';
export { createBuiltAppStore, builtAppDocId, builtAppStoreDir, builtAppStoreProvider, FirestoreBuiltAppStore, LocalBuiltAppStore, MemoryBuiltAppStore, BUILT_APPS_COLLECTION, type BuiltAppRecord, type BuiltAppStore, } from './deploy/builtAppStore.js';
export { createRateLimiter } from './rateLimit.js';
export type { RateLimiter, RateLimiterOptions, RateLimitResult } from './rateLimit.js';
export { createEngineListener } from './services/engineSvc.js';
export { createVaultListener } from './services/vaultSvc.js';
export { createMetaListener } from './services/metaSvc.js';
export { createEtlListener } from './services/etlSvc.js';
export { createAgentListener } from './services/agentSvc.js';
export { NodeRemoteEngineHost, REMOTE_MUTATING_OPS, type NodeRemoteEngineHostOptions, type RemoteEngineFetch, type RemoteEngineFetchInit, type RemoteEngineFetchResponse, } from './services/remoteEngineHost.js';
export { createAgentSessionResolver, pickActiveSession, readLocalRegistryRecords, recordMatchesPrincipal, participantPrincipals, type AgentSessionRecord, type AgentSessionResolverOptions, type ResolvedAgentSession, } from './services/agentSessionResolver.js';
export { createAddonListener } from './services/addonSvc.js';
export { createServicePackageListener, productionAddonDeps, SERVICE_PACKAGE_SERVICES, type ServicePackageDeps, type ServicePackageService, } from './services/servicePackage.js';
export { createDelegatingAddonAuthorizer, createEngineServiceBinding, createProductionAddonResolveBinding, type AddonAuthRecord, type EngineServiceBindingOptions, type ProductionAddonBindingOptions, } from './services/addonEngineBinding.js';
export type { AddonServiceDeps } from './services/addonSvc.js';
export { filePersistence, gatewayDataDir, persistenceFileFor, GATEWAY_DATA_DIR_ENV, } from './filePersistence.js';
export * from './httpUtils.js';
export declare const DEFAULT_PORTS: {
    readonly gateway: 8100;
    readonly engine: 8101;
    readonly vault: 8102;
    readonly meta: 8103;
    readonly etl: 8104;
    readonly agent: 8105;
    readonly mcp: 8106;
    readonly addons: 8107;
};
export interface StartAllOptions {
    /** Base host for every service. Default '127.0.0.1'. */
    host?: string;
    /** Port overrides. */
    ports?: Partial<typeof DEFAULT_PORTS>;
    /**
     * Gateway JWT secret. Falls back to the AUTH_SECRET env var;
     * startAllLocal THROWS when neither is set (F-16, security pass —
     * fail closed; no built-in default exists).
     */
    authSecret?: string;
    /**
     * Serve the local-dev POST /auth/login (F-1, security pass).
     * Default: ALLOW_DEV_LOGIN==='1'. Off → the route answers 404.
     */
    devLoginEnabled?: boolean;
    /** Gateway rate limit. Default 600 points / 60s. */
    rateLimit?: {
        points: number;
        perSeconds: number;
    };
    /** Signed engine access issuance (see GatewayOptions.engineAccess). */
    engineAccess?: GatewayOptions['engineAccess'];
    /** Combined service-package proxy mode (see GatewayOptions.serviceCombined). Default off. */
    serviceCombined?: boolean;
}
export interface StartedServices {
    servers: Record<string, http.Server>;
    /** Stop everything. */
    close(): Promise<void>;
}
/**
 * Start the whole local topology in-process (for end-to-end tests and local
 * dev without six terminals). Equivalent to running each dist/bin/*.js with
 * its default PORT.
 */
export declare function startAllLocal(opts?: StartAllOptions): Promise<StartedServices>;
