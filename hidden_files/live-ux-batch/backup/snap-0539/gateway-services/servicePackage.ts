/**
 * The service package as ONE deployable service (user's service
 * inventory, 2026-10-20): production runs the service family — vault,
 * meta, etl, agent, addons — as a SINGLE stateless Cloud Run service,
 * while local dev keeps the five separate processes (bin/vault.js etc.,
 * ports 8102–8107) untouched.
 *
 * This module mounts all five existing HTTP surfaces in one process
 * behind a prefix dispatcher on ONE port. Accepted path forms (the
 * service names are distinct first segments, so both are unambiguous):
 *
 *   /api/vault/store   → vault listener, url rewritten to /store
 *   /vault/store       → same (the form the gateway's '/api' route
 *                        delivers after stripping just '/api')
 *
 * Prefixes: /api/vault, /api/meta, /api/etl, /api/agent, /api/addons —
 * the gateway proxy table's names. Prefix dispatch is REQUIRED, not
 * cosmetic: etl and addons both serve a bare POST /run, and every
 * surface serves /health; under their prefixes nothing collides.
 * (Verified against the five listeners' route tables.)
 *
 * STATELESSNESS (the lifetime model): these services already keep any
 * durable state in the metadata store / on disk via the persistence
 * adapters — this dispatcher adds NO process state of its own, so the
 * combined service scales to zero between requests exactly like each
 * part did. The five listeners already coexist in one process today
 * (startAllLocal) — this only changes ports → prefixes.
 *
 * Gateway wiring note for production (for the deploy YAMLs): route
 * '/api' → this service (the gateway's longest-prefix match still sends
 * /api/engine/* to the engine services), or point each of the five
 * /api/<name> routes at this service AND preserve the full path — the
 * dispatcher accepts the /api/<name>/... form directly.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { createVaultListener } from './vaultSvc.js';
import { createMetaListener } from './metaSvc.js';
import { createEtlListener } from './etlSvc.js';
import { createAgentListener } from './agentSvc.js';
import { createConnectorListener } from './connectorSvc.js';
import { createAutomationListener } from './automationSvc.js';
import { createFileRegistry } from '../deploy/fileRegistry.js';
import { TriggerSupervisor } from './triggerSupervisor.js';
import { createAddonListener, type AddonServiceDeps } from './addonSvc.js';
import {
  createDelegatingAddonAuthorizer,
  createProductionAddonResolveBinding,
} from './addonEngineBinding.js';
import { applyCors, handlePreflight, sendError, sendJson } from '../httpUtils.js';
import type { FileRegistry } from '../deploy/fileRegistry.js';

export const SERVICE_PACKAGE_SERVICES = ['vault', 'meta', 'etl', 'agent', 'addons', 'connectors', 'automation'] as const;
export type ServicePackageService = (typeof SERVICE_PACKAGE_SERVICES)[number];

export interface ServicePackageDeps {
  /** Add-on service deps override (tests). Default: the production binding. */
  addonDeps?: AddonServiceDeps;
  /** Engine base URL for the add-on /run document binding. Default env/default port. */
  engineBaseUrl?: string;
  /**
   * The session ownership registry the agent + add-on session
   * resolvers enumerate (listAll) — the production wiring: in prod
   * the registry is Firestore-backed and no on-disk registry file
   * exists for the resolvers' default source. `undefined` keeps the
   * on-disk default (local topology).
   */
  fileRegistry?: FileRegistry;
  /**
   * Trigger supervisor for the automation surface (triggers program).
   * `undefined` (default) constructs + starts one against the same
   * registry source as the agent/add-on resolvers; an instance is used
   * as-is; `null` disables hosting (the surface 503s fail-closed).
   */
  triggerSupervisor?: TriggerSupervisor | null;
}

/** The production add-on deps (identical to bin/addons.ts — both use the
 * shared FIX-R3 resolver factory, so they cannot drift apart). */
export function productionAddonDeps(
  engineBaseUrl: string,
  fileRegistry?: FileRegistry,
): AddonServiceDeps {
  return {
    authorizer: createDelegatingAddonAuthorizer(),
    resolveBinding: createProductionAddonResolveBinding(engineBaseUrl, {
      ...(fileRegistry ? { fileRegistry } : {}),
    }),
  };
}

export function createServicePackageListener(deps: ServicePackageDeps = {}): RequestListener {
  const engineBaseUrl =
    deps.engineBaseUrl ?? process.env.ENGINE_SERVICE_URL ?? 'http://127.0.0.1:8101';
  // Trigger supervisor (automation surface): hosts one TriggerRuntime
  // per live workbook session. Construction/startup failures must
  // never break the other surfaces — the surface 503s instead.
  let triggerSupervisor: TriggerSupervisor | null = null;
  if (deps.triggerSupervisor !== null) {
    try {
      triggerSupervisor =
        deps.triggerSupervisor ??
        new TriggerSupervisor({
          ...(deps.fileRegistry ? { registry: deps.fileRegistry } : {}),
          // Scheduler tick (Scope update 2): CAS claims + self-opens
          // run against the package's registry and engine. When the
          // package has no registry dep, the supervisor constructs
          // one from env itself (same posture as its record source).
          claimRegistry: deps.fileRegistry ?? createFileRegistry(process.env),
          engineBaseUrl,
        });
      triggerSupervisor.start();
    } catch (e) {
      console.log(
        `[service-package] trigger supervisor failed to start: ${e instanceof Error ? e.message : String(e)} — automation surface fail-closed`,
      );
      triggerSupervisor = null;
    }
  }
  const surfaces: Record<ServicePackageService, RequestListener> = {
    vault: createVaultListener(),
    meta: createMetaListener(),
    etl: createEtlListener(),
    agent: createAgentListener({
      ...(deps.fileRegistry ? { fileRegistry: deps.fileRegistry } : {}),
    }),
    addons: createAddonListener(
      deps.addonDeps ?? productionAddonDeps(engineBaseUrl, deps.fileRegistry),
    ),
    connectors: createConnectorListener(),
    automation: createAutomationListener({ supervisor: triggerSupervisor }),
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (handlePreflight(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://service-package');
    const path = url.pathname;
    if (path === '/health' && (req.method ?? 'GET').toUpperCase() === 'GET') {
      applyCors(res);
      return sendJson(res, 200, {
        ok: true,
        service: 'service-package',
        services: [...SERVICE_PACKAGE_SERVICES],
      });
    }
    // '/api/<name>/rest' or '/<name>/rest' → surface <name>, url '/rest'.
    const m = /^\/(?:api\/)?(vault|meta|etl|agent|addons|connectors|automation)(\/.*)?$/.exec(path);
    if (!m) return sendError(res, 404, `not found: ${path}`);
    const surface = surfaces[m[1] as ServicePackageService];
    const rest = m[2] ?? '/';
    req.url = rest + url.search;
    return surface(req, res);
  };
}
