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
import {
  createGateway,
  listen as listenGateway,
  type GatewayOptions,
} from './gateway.js';

export {
  ENGINE_UPSTREAM_TIMEOUT_MS,
  SERVICE_FAMILY_ROUTE_PREFIXES,
  serviceCombinedEnabled,
} from './gateway.js';
export {
  createMetadataIdTokenProvider,
  idTokenExpiryMs,
  metadataIdentityUrl,
  METADATA_SERVER_BASE_URL,
  type MetadataIdTokenProviderOptions,
  type ServiceIdTokenProvider,
} from './serviceIdToken.js';
import { createEngineListener } from './services/engineSvc.js';
import { createVaultListener } from './services/vaultSvc.js';
import { createMetaListener } from './services/metaSvc.js';
import { createEtlListener } from './services/etlSvc.js';
import { createAgentListener } from './services/agentSvc.js';
import { createAddonListener } from './services/addonSvc.js';
import { createAutomationListener } from './services/automationSvc.js';
import { TriggerSupervisor } from './services/triggerSupervisor.js';
import { createFileRegistry } from './deploy/fileRegistry.js';
import {
  createDelegatingAddonAuthorizer,
  createEngineServiceBinding,
  createProductionAddonResolveBinding,
} from './services/addonEngineBinding.js';

export { createGateway, listenGateway };
export type { GatewayOptions };
export {
  engineAccessMode,
  engineAccessSecret,
  engineAccessTtlSeconds,
  engineSessionRateLimit,
  engineTierUrls,
  idleTimeoutMs,
  isSessionId,
  issueEngineAccessToken,
  journalSegmentMaxOps,
  newSessionId,
  selectEngineTier,
  sessionLifecycleEnabled,
  sessionSweeperMs,
  snapshotEveryMs,
  snapshotEveryOps,
  verifyEngineAccessToken,
  EngineAccessError,
  type EngineAccessClaims,
  type EngineAccessErrorReason,
  type EngineAccessMode,
  type EngineAccessRole,
  type EngineTier,
  type EngineTierUrls,
} from './deploy/engineAccess.js';
export {
  createFileRegistry,
  createLocalFileRegistry,
  fileRegistryDir,
  fileRegistryProvider,
  isLiveOwner,
  ownershipHeartbeatMs,
  ownershipLeaseMs,
  FirestoreFileRegistry,
  LocalFileRegistry,
  MemoryFileRegistry,
  type FileRegistry,
  type FileRegistryRecord,
} from './deploy/fileRegistry.js';
export {
  cmdToCollabOp,
  collabOpToCmd,
  presenceColorFor,
  retentionPruneUpto,
  segmentPrunable,
  PRESENCE_COLORS,
  type DeltaCell,
  type DeltaLogEntry,
  type DeltaOrigin,
} from './services/engineSvc.js';
export {
  createLocalSessionStores,
  createSessionStores,
  prodSessionConfig,
  sessionDataDir,
  sessionStoreProvider,
  FirestoreSessionStores,
  LocalSessionStores,
  MemorySessionStores,
  opsFromSegments,
  wrapFirestore,
  type FirestoreLike,
  type JournalEntry,
  type JournalSegment,
  type OpJournal,
  type ProdSessionConfig,
  type SessionRecord,
  type SessionRegistry,
  type SessionStatus,
  type SessionStores,
  type SnapshotStore,
  type StorageLike,
  type StoredSnapshot,
} from './deploy/sessionStore.js';
export {
  createBuiltAppStore,
  builtAppDocId,
  builtAppStoreDir,
  builtAppStoreProvider,
  FirestoreBuiltAppStore,
  LocalBuiltAppStore,
  MemoryBuiltAppStore,
  BUILT_APPS_COLLECTION,
  type BuiltAppRecord,
  type BuiltAppStore,
} from './deploy/builtAppStore.js';
export { createRateLimiter } from './rateLimit.js';
export type { RateLimiter, RateLimiterOptions, RateLimitResult } from './rateLimit.js';
export { createEngineListener } from './services/engineSvc.js';
export { createVaultListener } from './services/vaultSvc.js';
export { createMetaListener } from './services/metaSvc.js';
export { createEtlListener } from './services/etlSvc.js';
export { createAgentListener } from './services/agentSvc.js';
export {
  NodeRemoteEngineHost,
  REMOTE_MUTATING_OPS,
  type NodeRemoteEngineHostOptions,
  type RemoteEngineFetch,
  type RemoteEngineFetchInit,
  type RemoteEngineFetchResponse,
} from './services/remoteEngineHost.js';
export {
  createAgentSessionResolver,
  pickActiveSession,
  readLocalRegistryRecords,
  recordMatchesPrincipal,
  participantPrincipals,
  type AgentSessionRecord,
  type AgentSessionResolverOptions,
  type ResolvedAgentSession,
} from './services/agentSessionResolver.js';
export { createAddonListener } from './services/addonSvc.js';
export { createAutomationListener } from './services/automationSvc.js';
export {
  createServicePackageListener,
  productionAddonDeps,
  SERVICE_PACKAGE_SERVICES,
  type ServicePackageDeps,
  type ServicePackageService,
} from './services/servicePackage.js';
export {
  createDelegatingAddonAuthorizer,
  createEngineServiceBinding,
  createProductionAddonResolveBinding,
  type AddonAuthRecord,
  type EngineServiceBindingOptions,
  type ProductionAddonBindingOptions,
} from './services/addonEngineBinding.js';
export type { AddonServiceDeps } from './services/addonSvc.js';
export {
  filePersistence,
  gatewayDataDir,
  persistenceFileFor,
  GATEWAY_DATA_DIR_ENV,
} from './filePersistence.js';
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
  automation: 8108,
} as const;

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
  rateLimit?: { points: number; perSeconds: number };
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
export async function startAllLocal(opts: StartAllOptions = {}): Promise<StartedServices> {
  const host = opts.host ?? '127.0.0.1';
  const ports = { ...DEFAULT_PORTS, ...(opts.ports ?? {}) };
  // F-16 (security pass): no default gateway secret — an explicit opt
  // or the AUTH_SECRET env, else fail closed before anything starts.
  const authSecret = opts.authSecret ?? process.env.AUTH_SECRET;
  if (!authSecret) {
    throw new Error(
      'startAllLocal: no gateway auth secret — pass opts.authSecret or set AUTH_SECRET (fail closed; there is no built-in default)',
    );
  }
  const devLoginEnabled = opts.devLoginEnabled ?? (process.env.ALLOW_DEV_LOGIN === '1');
  const servers: Record<string, http.Server> = {};

  async function start(name: string, port: number, listener: http.RequestListener): Promise<void> {
    servers[name] = await new Promise<http.Server>((resolve, reject) => {
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
  await start(
    'addons',
    ports.addons,
    createAddonListener({
      authorizer: createDelegatingAddonAuthorizer(),
      resolveBinding: (documentId, reqCtx) =>
        createEngineServiceBinding({
          engineBaseUrl,
          documentId,
          principal: reqCtx.principal,
          authorization: reqCtx.authorization,
        }),
    }),
  );
  // Automation surface (triggers program, #65): production mounts this
  // surface inside the combined service package, but startAllLocal
  // started no automation listener and the routes map below had no
  // '/api/automation' entry — the gateway answered 404 'no backend
  // route' for every automation call on the local topology. Mirror the
  // service package's construction: a TriggerSupervisor over the same
  // registry source; a construction/start failure leaves the surface
  // fail-closed (503) and never breaks the other services.
  let triggerSupervisor: TriggerSupervisor | null = null;
  try {
    triggerSupervisor = new TriggerSupervisor({
      claimRegistry: createFileRegistry(process.env),
      engineBaseUrl,
    });
    triggerSupervisor.start();
  } catch (e) {
    console.log(
      `[automation] trigger supervisor failed to start: ${e instanceof Error ? e.message : String(e)} — automation surface fail-closed`,
    );
    triggerSupervisor = null;
  }
  await start(
    'automation',
    ports.automation,
    createAutomationListener({ supervisor: triggerSupervisor }),
  );
  await start(
    'gateway',
    ports.gateway,
    createGateway({
      authSecret,
      devLoginEnabled,
      routes: {
        '/api/engine': `http://${host}:${ports.engine}`,
        '/api/vault': `http://${host}:${ports.vault}`,
        '/api/meta': `http://${host}:${ports.meta}`,
        '/api/etl': `http://${host}:${ports.etl}`,
        '/api/agent': `http://${host}:${ports.agent}`,
        '/api/addons': `http://${host}:${ports.addons}`,
        '/api/automation': `http://${host}:${ports.automation}`,
      },
      rateLimit: opts.rateLimit ?? { points: 600, perSeconds: 60 },
      ...(opts.serviceCombined ? { serviceCombined: true } : {}),
      ...(opts.engineAccess ? { engineAccess: opts.engineAccess } : {}),
    }),
  );

  return {
    servers,
    close: async () => {
      if (triggerSupervisor) {
        await triggerSupervisor.stop().catch(() => undefined);
      }
      await Promise.all(
        Object.values(servers).map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
    },
  };
}
