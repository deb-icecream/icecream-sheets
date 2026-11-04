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
import type { RequestListener } from 'node:http';
import { type AddonServiceDeps } from './addonSvc.js';
export declare const SERVICE_PACKAGE_SERVICES: readonly ["vault", "meta", "etl", "agent", "addons", "connectors"];
export type ServicePackageService = (typeof SERVICE_PACKAGE_SERVICES)[number];
export interface ServicePackageDeps {
    /** Add-on service deps override (tests). Default: the production binding. */
    addonDeps?: AddonServiceDeps;
    /** Engine base URL for the add-on /run document binding. Default env/default port. */
    engineBaseUrl?: string;
}
/** The production add-on deps (identical to bin/addons.ts). */
export declare function productionAddonDeps(engineBaseUrl: string): AddonServiceDeps;
export declare function createServicePackageListener(deps?: ServicePackageDeps): RequestListener;
