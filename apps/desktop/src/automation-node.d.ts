/**
 * Ambient types for the `@icecream-sheets/service/automation-node` subpath.
 *
 * The desktop compiles to CJS with classic node module resolution, which
 * does not read the service package's `exports` map (the
 * `./automation-node` subpath), so tsc cannot see
 * `dist/automation/node.d.ts` on its own. The runtime import in
 * triggers.ts resolves fine through Node itself; this file only supplies
 * the types. Keep the signatures in sync with
 * packages/service/src/automation/host.ts (SessionTriggerHost) — the
 * pattern mirrors src/mcp-server-http.d.ts.
 */
declare module '@icecream-sheets/service/automation-node' {
  import type { EngineHost } from '@icecream-sheets/engine';
  import type {
    Persistence,
    TriggerSpec,
    TriggerSpecInit,
  } from '@icecream-sheets/service';

  /** Persistence key (inside the scoped persistence) for grant records. */
  export const TRIGGER_GRANTS_KEY: string;

  export interface SessionTriggerHostOptions {
    persistence: Persistence;
    scope: string;
    principal?: string;
    pollMs?: number;
    now?: () => Date;
  }

  /** Durable §1 consent record for one trigger. */
  export interface TriggerGrantRecord {
    triggerId: string;
    grantedBy: string;
    at: string;
  }

  /** Last observed run outcome for one trigger (in-memory). */
  export interface TriggerLastRun {
    ok: boolean;
    error?: string;
    durationMs: number;
    at: string;
  }

  /** Status-shaped trigger returned by list()/create(). */
  export type TriggerStatus = TriggerSpec & {
    granted: boolean;
    lastRun: TriggerLastRun | null;
  };

  export class SessionTriggerHost {
    constructor(opts: SessionTriggerHostOptions);
    /** The scope (workbook identity) this host serves. */
    get scopeId(): string;
    /** Whether a live runtime is currently attached. */
    get attached(): boolean;
    attach(host: EngineHost): void;
    detach(): void;
    /** Fire onOpen triggers for this scope. Returns run reports. */
    fireOpen(): unknown[];
    /** Record the user's grant for a trigger. Unknown id → throw. */
    grant(id: string, grantedBy: string): void;
    /** All durable grant records for this scope. */
    grantRecords(): TriggerGrantRecord[];
    /** Whether a trigger has a durable grant record. */
    isGranted(specOrId: string | TriggerSpec): boolean;
    list(): TriggerStatus[];
    create(init: TriggerSpecInit): TriggerStatus;
    remove(id: string): boolean;
    setEnabled(id: string, enabled: boolean): void;
    /** Last-run entry for a trigger, or null when it has never run. */
    lastRunFor(id: string): TriggerLastRun | null;
  }
}
