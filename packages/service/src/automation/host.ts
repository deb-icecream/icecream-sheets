/**
 * SessionTriggerHost — shared hosting core for the automation trigger
 * runtime (design-docs/automation-lane.md §1, §3, §5).
 *
 * Used by both hosted topologies:
 *  - gateway/service mode: a supervisor attaches one host per live file
 *    session (over a NodeRemoteEngineHost);
 *  - desktop local mode: Electron main attaches it to its in-process
 *    EngineHost.
 *
 * Responsibilities:
 *  - Per-scope trigger store: persistence keys are prefixed with
 *    `${scope}::`, so multiple workbooks/files sharing one Persistence
 *    never see each other's specs or grants.
 *  - Durable grant records (§1 consent): the runtime's grant ledger is
 *    in-memory per AutomationApi, so hosting persists grants here and
 *    re-applies them on every attach — "grant once" survives sessions.
 *  - Last-run tracking from the runtime's onRunReport observer.
 *  - Management API (list/create/remove/setEnabled/grant) that works
 *    whether or not a live engine is attached.
 */

import type { EngineHost } from '@icecream-sheets/engine';
import {
  type MetadataStore,
  type Persistence,
} from '../metadataStore.js';
import { TriggerRuntime, type RunReport } from './runtime.js';
import {
  createTriggerSpec,
  createTriggerStore,
  type TriggerSpec,
  type TriggerSpecInit,
} from './triggerSpecs.js';

/** Persistence key (inside the scoped persistence) for grant records. */
export const TRIGGER_GRANTS_KEY = 'icecream-sheets.trigger-grants.v1';

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

function scopedPersistence(base: Persistence, scope: string): Persistence {
  const prefix = `${scope}::`;
  return {
    load: (key: string) => base.load(`${prefix}${key}`),
    save: (key: string, value: string) => base.save(`${prefix}${key}`, value),
    clear: (key: string) => base.clear(`${prefix}${key}`),
  };
}

export class SessionTriggerHost {
  private readonly persistence: Persistence;
  private readonly scoped: Persistence;
  private readonly scope: string;
  private readonly principal: string | undefined;
  private readonly pollMs: number | undefined;
  private readonly nowFn: () => Date;
  private readonly store: MetadataStore<TriggerSpec>;
  private runtime: TriggerRuntime | null = null;
  private readonly lastRuns = new Map<string, TriggerLastRun>();

  constructor(opts: SessionTriggerHostOptions) {
    if (!opts.persistence) throw new Error('SessionTriggerHost requires persistence');
    if (typeof opts.scope !== 'string' || opts.scope.length === 0) {
      throw new Error('SessionTriggerHost requires a non-empty scope');
    }
    this.persistence = opts.persistence;
    this.scope = opts.scope;
    this.principal = opts.principal;
    this.pollMs = opts.pollMs;
    this.nowFn = opts.now ?? (() => new Date());
    this.scoped = scopedPersistence(opts.persistence, opts.scope);
    this.store = createTriggerStore(this.scoped);
  }

  /** The scope (workbook identity) this host serves. */
  get scopeId(): string {
    return this.scope;
  }

  /** Whether a live runtime is currently attached. */
  get attached(): boolean {
    return this.runtime !== null;
  }

  /** The underlying trigger store (shared with the attached runtime). */
  get triggerStore(): MetadataStore<TriggerSpec> {
    return this.store;
  }

  /** The attached runtime, if any (for tests / supervisors). */
  get currentRuntime(): TriggerRuntime | null {
    return this.runtime;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  attach(host: EngineHost): void {
    this.detach();
    const runtime = new TriggerRuntime(host, this.store, {
      principal: this.principal,
      workbookId: this.scope,
      now: this.nowFn,
      onRunReport: (report: RunReport) => this.trackRun(report),
    });
    this.runtime = runtime;
    // Re-apply persisted grants: records are the durable truth; the
    // runtime ledger is re-derived at attach.
    for (const record of this.loadGrants()) {
      try {
        runtime.grantTriggerPermissions(record.triggerId, record.grantedBy);
      } catch {
        // Grant for a since-deleted trigger: records are pruned on
        // remove(), so this is defensive only — never fail attach.
      }
    }
    runtime.beginPolling(this.pollMs ?? 1000);
  }

  detach(): void {
    if (this.runtime) {
      this.runtime.dispose();
      this.runtime = null;
    }
  }

  /** Fire onOpen triggers for this scope. No-op ([]) when detached. */
  fireOpen(): RunReport[] {
    return this.runtime?.fireOpen(this.scope) ?? [];
  }

  // ------------------------------------------------------------------
  // Grant records (durable §1 consent)
  // ------------------------------------------------------------------

  private loadGrants(): TriggerGrantRecord[] {
    const raw = this.scoped.load(TRIGGER_GRANTS_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (r): r is TriggerGrantRecord =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as TriggerGrantRecord).triggerId === 'string' &&
          typeof (r as TriggerGrantRecord).grantedBy === 'string' &&
          typeof (r as TriggerGrantRecord).at === 'string',
      );
    } catch {
      return [];
    }
  }

  private saveGrants(records: TriggerGrantRecord[]): void {
    this.scoped.save(TRIGGER_GRANTS_KEY, JSON.stringify(records));
  }

  /**
   * Record the user's grant for a trigger. Unknown id → throw (mirrors
   * the runtime). Upserts the durable record, persists it, and applies
   * it to the attached runtime when present.
   */
  grant(id: string, grantedBy: string): void {
    const spec = this.store.all().find((t) => t.id === id);
    if (!spec) throw new Error(`unknown trigger: ${id}`);
    const records = this.loadGrants().filter((r) => r.triggerId !== id);
    records.push({ triggerId: id, grantedBy, at: this.nowFn().toISOString() });
    this.saveGrants(records);
    if (this.runtime) {
      this.runtime.grantTriggerPermissions(id, grantedBy);
    }
  }

  /** All durable grant records for this scope. */
  grantRecords(): TriggerGrantRecord[] {
    return this.loadGrants();
  }

  /**
   * Whether a trigger has a durable grant record. Reads records only —
   * records are the durable truth; the runtime ledger is re-derived.
   */
  isGranted(specOrId: string | TriggerSpec): boolean {
    const id = typeof specOrId === 'string' ? specOrId : specOrId.id;
    return this.loadGrants().some((r) => r.triggerId === id);
  }

  // ------------------------------------------------------------------
  // Management (attached or detached; persists via the store)
  // ------------------------------------------------------------------

  list(): TriggerStatus[] {
    return this.store.all().map((spec) => this.statusOf(spec));
  }

  create(init: TriggerSpecInit): TriggerStatus {
    const withScope: TriggerSpecInit =
      init.workbookId === undefined ? { ...init, workbookId: this.scope } : init;
    const spec = createTriggerSpec(withScope);
    this.store.add(spec);
    return this.statusOf(spec);
  }

  remove(id: string): boolean {
    const removed = this.store.remove((t) => t.id === id) > 0;
    // Drop its grant records and last-run either way (prune orphans).
    const records = this.loadGrants();
    const kept = records.filter((r) => r.triggerId !== id);
    if (kept.length !== records.length) this.saveGrants(kept);
    this.lastRuns.delete(id);
    return removed;
  }

  setEnabled(id: string, enabled: boolean): void {
    if (this.runtime) {
      this.runtime.setEnabled(id, enabled);
      return;
    }
    const specs = this.store.all();
    const spec = specs.find((t) => t.id === id);
    if (!spec) throw new Error(`unknown trigger: ${id}`);
    this.store.saveAll(
      specs.map((t) =>
        t.id === id ? { ...t, enabled, updatedAt: this.nowFn().toISOString() } : t,
      ),
    );
  }

  // ------------------------------------------------------------------
  // Last-run tracking
  // ------------------------------------------------------------------

  private trackRun(report: RunReport): void {
    const entry: TriggerLastRun = {
      ok: report.ok,
      ...(report.error !== undefined ? { error: report.error } : {}),
      durationMs: report.durationMs,
      at: this.nowFn().toISOString(),
    };
    this.lastRuns.set(report.triggerId, entry);
  }

  /** Last-run entry for a trigger, or null when it has never run. */
  lastRunFor(id: string): TriggerLastRun | null {
    return this.lastRuns.get(id) ?? null;
  }

  /**
   * Correct a trigger's last-run record after the fact: hosted
   * topologies where script writes are submitted asynchronously
   * (sequenced by the session owner) can only learn an engine-level
   * rejection after the run's synchronous report said ok. The
   * supervisor calls this when such a late failure lands; it never
   * resurrects a deleted trigger's entry (remove() prunes lastRuns,
   * and a failure for an unknown id is ignored).
   */
  noteLateRunFailure(id: string, error: string): void {
    const existing = this.lastRuns.get(id);
    if (!existing) return;
    this.lastRuns.set(id, {
      ok: false,
      error,
      durationMs: existing.durationMs,
      at: this.nowFn().toISOString(),
    });
  }

  /**
   * Record a run failure for a trigger whether or not a run report
   * exists yet — used by the scheduler tick's self-session path,
   * where a failed self-open means no runtime ever ran the trigger
   * but the failure must still be visible as its lastRun.
   */
  recordRunFailure(id: string, error: string): void {
    const existing = this.lastRuns.get(id);
    this.lastRuns.set(id, {
      ok: false,
      error,
      durationMs: existing?.durationMs ?? 0,
      at: this.nowFn().toISOString(),
    });
  }

  /**
   * Re-read specs + grant records from persistence (the store's cache
   * is invalidated; grants are re-applied to the attached runtime).
   * Lets a hosting supervisor pick up management changes made through
   * ANOTHER process sharing the same store (e.g. CRUD served by the
   * service package while the session lives on an engine instance).
   * Local single-process hosts never need it.
   */
  refreshFromStore(): void {
    this.store.invalidate();
    if (this.runtime) {
      for (const record of this.loadGrants()) {
        try {
          this.runtime.grantTriggerPermissions(record.triggerId, record.grantedBy);
        } catch {
          // Grant for a since-deleted trigger; records are pruned on
          // remove() — defensive only.
        }
      }
    }
  }

  private statusOf(spec: TriggerSpec): TriggerStatus {
    return {
      ...spec,
      granted: this.isGranted(spec.id),
      lastRun: this.lastRuns.get(spec.id) ?? null,
    };
  }
}
