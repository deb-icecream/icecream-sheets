/**
 * Automation surface — trigger management HTTP API (triggers program;
 * design-docs/automation-lane.md §§1/3; contract in
 * hidden_files/triggers/REPORT.md).
 *
 * Mounted by the service package behind /api/automation (gateway family
 * route). The gateway proxy sets x-principal from the verified JWT;
 * this surface is only reachable through that authenticated proxy, so
 * a missing principal header is a 401 (fail closed). Authorization is
 * the registry rule implemented by TriggerSupervisor.authorizeFile:
 * the file's creator and its editor participants may mutate; viewer
 * participants are read-only; a file with no registry record is a 404.
 *
 * Routes (paths arrive prefix-stripped by the package dispatcher):
 *   GET    /triggers?fileId=            → { ok, events, triggers }
 *   POST   /triggers                    { fileId, spec } → { ok, trigger }
 *   POST   /triggers/:id/enabled        { fileId, enabled } → { ok, trigger }
 *   POST   /triggers/:id/grant          { fileId } → { ok, trigger }
 *   DELETE /triggers/:id?fileId=        → { ok }
 *   POST   /tick                        → { ok, ...tick summary }
 *     (Scope update 2: the Cloud Scheduler waker. Authenticated ONLY
 *     by the scheduler's OIDC token — verified audience + service
 *     account identity; no x-principal. Fail closed when the tick
 *     auth is not configured.)
 * A null supervisor or a prod-broken one answers 503 on every route —
 * never a silent local/in-memory fallback.
 */
import type { RequestListener } from 'node:http';
import type { TriggerSupervisor } from './triggerSupervisor.js';
import { type TickAuthEnv } from './tickAuth.js';
/** Events the hosted runtime can fire in this topology (REPORT.md). */
export declare const AUTOMATION_EVENT_CAPABILITIES: readonly ["onOpen", "onEdit", "onInterval", "onAtTime"];
export interface AutomationServiceDeps {
    supervisor: TriggerSupervisor | null;
    /** Env for the tick endpoint's OIDC config. Default process.env. */
    env?: NodeJS.ProcessEnv;
    /**
     * Tick authorization override (tests): return true for an
     * authorized scheduler call. Default: real OIDC verification
     * against the env config (tickAuth.ts).
     */
    tickAuthorize?: (authorization: string | undefined) => Promise<boolean>;
    /** Tick auth config override (tests); null = not configured. */
    tickAuth?: TickAuthEnv | null;
}
export declare function createAutomationListener(deps: AutomationServiceDeps): RequestListener;
