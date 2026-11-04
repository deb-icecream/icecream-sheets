/**
 * Event runtime for the automation lane (design-docs/automation-lane.md §3).
 *
 * Node-only (it executes scripts through the vm/child_process sandbox).
 * Fires onOpen, onEdit, onSelectionChange and timed triggers inside the
 * sandbox. Handlers receive a frozen event object and mutate only through
 * the permissioned automation API — there is no privileged scripting path.
 *
 * Grant discipline (§1): a trigger runs as the principal
 * `automation:<trigger-name>`. Before running, the runtime requires the
 * user to have granted every permission the trigger declares (via
 * grantTriggerPermissions()); otherwise the run is refused.
 *
 * Execution is synchronous and single-writer: the engine, the JS vm and
 * the Python child all run to completion before the next trigger fires,
 * so adapters without transaction support (automation-lane.md §5) never
 * see interleaved writes.
 */

import { EngineHost, type CellRef } from '@icecream-sheets/engine';
import type { MetadataStore } from '../metadataStore.js';
import { AutomationApi, type DeclaredPermission } from './api.js';
import {
  createBridgeHandler,
  runJavaScriptAutomation,
  runPythonAutomation,
  type AutomationSandboxResult,
} from './sandbox.js';
import {
  TRIGGER_SPEC_VERSION,
  createTriggerSpec,
  validateTriggerSpec,
  type TriggerEvent,
  type TriggerSpec,
  type TriggerSpecInit,
} from './triggerSpecs.js';

export interface TriggerRuntimeOptions {
  /**
   * Identity the runtime itself acts as when managing triggers.
   * Trigger scripts run as `automation:<trigger-name>` regardless.
   */
  principal?: string;
  /** Clock for timed triggers (injectable for tests). Defaults to Date. */
  now?: () => Date;
  /**
   * The runtime's workbook identity. The constructor's cellsChanged
   * handler passes it to fireEdit, and fireOpen/fireEdit/
   * fireSelectionChange default their workbookId parameter to it when
   * the caller omits it. Without it, workbook-scoped specs never fire
   * from engine events.
   */
  workbookId?: string;
  /**
   * Observer invoked with EVERY run outcome (runMatching and tick
   * paths, including subscription-driven fires and grant refusals).
   * Exception-safe: a throwing observer never breaks firing or the
   * engine event fan-out.
   */
  onRunReport?: (report: RunReport) => void;
}

export interface RunReport {
  triggerId: string;
  name: string;
  ok: boolean;
  error?: string;
  /** Messages the script queued via api.notify(). */
  notifications: string[];
  durationMs: number;
}

interface TimerEvent {
  type: 'timer';
  at: string;
}

/** Principal a trigger's scripts run as. Stable per trigger name. */
export function triggerPrincipal(spec: Pick<TriggerSpec, 'name'>): string {
  return `automation:${spec.name}`;
}

export class TriggerRuntime {
  private readonly host: EngineHost;
  private readonly store: MetadataStore<TriggerSpec>;
  private readonly principal: string;
  private readonly now: () => Date;
  private readonly workbookId: string | undefined;
  private readonly onRunReport: ((report: RunReport) => void) | undefined;
  /** One AutomationApi per principal: carries the recorded user grants. */
  private readonly apis = new Map<string, AutomationApi>();
  private readonly unsubscribe: () => void;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Re-entrancy guard: while a trigger script is running, engine events
   * caused by its own writes do NOT re-fire triggers (the Excel
   * Application.EnableEvents=false semantics). Without this, a trigger
   * that writes cells would recurse forever. The writes still land.
   */
  private firingDepth = 0;

  constructor(host: EngineHost, store: MetadataStore<TriggerSpec>, opts: TriggerRuntimeOptions = {}) {
    this.host = host;
    this.store = store;
    this.principal = opts.principal ?? 'user';
    this.now = opts.now ?? (() => new Date());
    this.workbookId = opts.workbookId;
    this.onRunReport = opts.onRunReport;
    // onEdit: the engine's cellsChanged event drives edit triggers.
    this.unsubscribe = this.host.subscribe((event) => {
      if (event.type === 'cellsChanged') {
        if (this.firingDepth > 0) return;
        for (const report of this.fireEdit(event.refs, this.workbookId)) {
          if (!report.ok) {
            // A failing trigger must never break the engine event fan-out.
            void report;
          }
        }
      }
    });
  }

  /** Stop the engine subscription and any polling timer. */
  dispose(): void {
    this.endPolling();
    this.unsubscribe();
    this.apis.clear();
  }

  // ------------------------------------------------------------------
  // Trigger management
  // ------------------------------------------------------------------

  list(): TriggerSpec[] {
    return this.store.all();
  }

  get(id: string): TriggerSpec | undefined {
    return this.store.all().find((t) => t.id === id);
  }

  /** Validate, persist and return a new trigger. */
  addTrigger(init: TriggerSpecInit): TriggerSpec {
    const spec = createTriggerSpec(init);
    this.store.add(spec);
    return spec;
  }

  /** Remove a trigger. Returns true when one was removed. */
  removeTrigger(id: string): boolean {
    return this.store.remove((t) => t.id === id) > 0;
  }

  setEnabled(id: string, enabled: boolean): void {
    const specs = this.store.all();
    const spec = specs.find((t) => t.id === id);
    if (!spec) throw new Error(`unknown trigger: ${id}`);
    this.store.saveAll(
      specs.map((t) =>
        t.id === id ? { ...t, enabled, updatedAt: this.now().toISOString() } : t,
      ),
    );
  }

  /**
   * Record the user's once-per-script permission grant (§1). After this,
   * the trigger may run; before it, runs are refused.
   */
  grantTriggerPermissions(id: string, grantedBy?: string): void {
    const spec = this.get(id);
    if (!spec) throw new Error(`unknown trigger: ${id}`);
    this.apiFor(triggerPrincipal(spec)).grantPermissions(
      triggerPrincipal(spec),
      spec.permissions,
      grantedBy ?? this.principal,
    );
  }

  // ------------------------------------------------------------------
  // Firing
  // ------------------------------------------------------------------

  /** Fire onOpen triggers (call when a workbook is opened). */
  fireOpen(workbookId?: string): RunReport[] {
    const effectiveWorkbookId = workbookId ?? this.workbookId;
    return this.runMatching('onOpen', effectiveWorkbookId, () => ({
      type: 'open',
      at: this.now().toISOString(),
      ...(effectiveWorkbookId !== undefined ? { workbookId: effectiveWorkbookId } : {}),
    }));
  }

  /** Fire onSelectionChange triggers for a new selection anchor. */
  fireSelectionChange(ref: CellRef, workbookId?: string): RunReport[] {
    const effectiveWorkbookId = workbookId ?? this.workbookId;
    return this.runMatching(
      'onSelectionChange',
      effectiveWorkbookId,
      () => ({ type: 'selection-change', ref: { ...ref }, at: this.now().toISOString() }),
      (spec) => this.scopeMatches(spec, ref.sheet, ref),
    );
  }

  /** Fire onEdit triggers for changed cells (also wired to the engine event). */
  fireEdit(refs: CellRef[], workbookId?: string): RunReport[] {
    const effectiveWorkbookId = workbookId ?? this.workbookId;
    const sheets = new Set(refs.map((r) => r.sheet));
    return this.runMatching(
      'onEdit',
      effectiveWorkbookId,
      () => ({
        type: 'edit',
        refs: refs.map((r) => ({ ...r })),
        at: this.now().toISOString(),
      }),
      (spec) => {
        if (spec.sheet !== undefined && !sheets.has(spec.sheet)) return false;
        if (spec.range !== undefined) {
          return refs.some((r) => this.refInRange(r, spec.range!));
        }
        return true;
      },
    );
  }

  /**
   * Fire due timed triggers. Call on a cadence (or use beginPolling()).
   * onInterval fires when intervalMs elapsed since the last fire;
   * onAtTime fires once when its timestamp passes.
   */
  tick(now?: Date): RunReport[] {
    const at = now ?? this.now();
    const reports: RunReport[] = [];
    const specs = this.store.all();
    let dirty = false;
    const next = specs.map((spec) => {
      if (!spec.enabled) return spec;
      let due = false;
      if (spec.event === 'onInterval' && typeof spec.intervalMs === 'number') {
        const last = spec.lastFiredAt !== undefined ? Date.parse(spec.lastFiredAt) : Number.NaN;
        due = Number.isNaN(last) || at.getTime() - last >= spec.intervalMs;
      } else if (spec.event === 'onAtTime' && spec.lastFiredAt === undefined) {
        due = typeof spec.atTimeIso === 'string' && Date.parse(spec.atTimeIso) <= at.getTime();
      }
      if (!due) return spec;
      const event: TimerEvent = { type: 'timer', at: at.toISOString() };
      reports.push(this.runOne(spec, event));
      dirty = true;
      return { ...spec, lastFiredAt: at.toISOString(), updatedAt: at.toISOString() };
    });
    if (dirty) this.store.saveAll(next);
    return reports;
  }

  /** Convenience: call tick() every intervalMs. The host owns the cadence. */
  beginPolling(intervalMs = 1000): void {
    this.endPolling();
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, Math.max(250, intervalMs));
  }

  endPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private runMatching(
    event: TriggerEvent,
    workbookId: string | undefined,
    makeEvent: () => unknown,
    scopeOk: (spec: TriggerSpec) => boolean = () => true,
  ): RunReport[] {
    const reports: RunReport[] = [];
    for (const spec of this.store.all()) {
      if (!spec.enabled || spec.event !== event) continue;
      if (spec.workbookId !== undefined && spec.workbookId !== workbookId) continue;
      if (!scopeOk(spec)) continue;
      reports.push(this.runOne(spec, makeEvent()));
    }
    return reports;
  }

  private scopeMatches(spec: TriggerSpec, sheet: string, ref: CellRef): boolean {
    if (spec.sheet !== undefined && spec.sheet !== sheet) return false;
    if (spec.range !== undefined && !this.refInRange(ref, spec.range)) return false;
    return true;
  }

  private refInRange(
    ref: CellRef,
    range: NonNullable<TriggerSpec['range']>,
  ): boolean {
    return (
      ref.sheet === range.sheet &&
      ref.row >= range.startRow &&
      ref.row <= range.endRow &&
      ref.col >= range.startCol &&
      ref.col <= range.endCol
    );
  }

  private apiFor(principal: string): AutomationApi {
    let api = this.apis.get(principal);
    if (!api) {
      api = new AutomationApi(this.host, { principal });
      this.apis.set(principal, api);
    }
    return api;
  }

  private runOne(spec: TriggerSpec, event: unknown): RunReport {
    const report = this.runOneInner(spec, event);
    if (this.onRunReport) {
      try {
        this.onRunReport(report);
      } catch {
        // Exception-safe: a throwing observer must never break firing
        // or the engine event fan-out.
      }
    }
    return report;
  }

  private runOneInner(spec: TriggerSpec, event: unknown): RunReport {
    const started = Date.now();
    const principal = triggerPrincipal(spec);
    const api = this.apiFor(principal);
    api.clearNotifications();
    const done = (ok: boolean, error?: string): RunReport => ({
      triggerId: spec.id,
      name: spec.name,
      ok,
      ...(error !== undefined ? { error } : {}),
      notifications: api.getNotifications(),
      durationMs: Date.now() - started,
    });

    // Grant discipline: refuse to run until the user granted the declared
    // permissions (automation-lane.md §1).
    if (!api.hasGrantsFor(principal, spec.permissions)) {
      return done(
        false,
        `trigger "${spec.name}" has not been granted its declared permissions; ` +
          `call grantTriggerPermissions() first`,
      );
    }

    // Re-entrancy guard: trigger writes must not re-fire triggers.
    this.firingDepth++;
    try {
      const handler = createBridgeHandler(api);
      let result: AutomationSandboxResult;
      try {
        result =
          spec.language === 'python'
            ? runPythonAutomation(spec.script, { handler, event })
            : runJavaScriptAutomation(spec.script, { handler, event });
      } catch (e) {
        return done(false, e instanceof Error ? e.message : String(e));
      }
      if ('error' in result) return done(false, result.error);
      return done(true);
    } finally {
      this.firingDepth--;
    }
  }
}

/** Re-exported for hosts that construct specs by hand. */
export { TRIGGER_SPEC_VERSION, createTriggerSpec, validateTriggerSpec };
export type { TriggerEvent, TriggerSpec, TriggerSpecInit, DeclaredPermission };
