/**
 * Trigger supervisor (triggers program, design-docs/automation-lane.md
 * §3 + hidden_files/triggers/REPORT.md "HOSTING DESIGN" as corrected
 * by the "PIVOT — hosting point corrected" section).
 *
 * Hosts one TriggerRuntime per LIVE workbook session, attached to the
 * session's OWN in-process EngineHost: the engine service reports its
 * session through EngineSessionHooks (engineSvc), and this supervisor
 * — constructed in the same process as the engine listener (the
 * engine bin; the service package for detached CRUD) — wraps the
 * session host in a SessionSubmitHost so script writes go through the
 * engine's sequenced op composition (journal + revision + broadcast)
 * while reads and events stay synchronous and exact.
 *
 * A supervisor that never sees a session (e.g. the one in the service
 * package) still serves full management CRUD against the shared
 * store; only the session-owning process attaches and runs triggers.
 * Attached hosts periodically refreshFromStore() so management
 * changes made through another process are picked up while a session
 * is live.
 *
 * onOpen fires ONCE per (fileId, sessionId): the fired record
 * persists in the entry's own persistence under a dedicated key, so a
 * supervisor restart does not re-fire onOpen for a session it already
 * greeted.
 *
 * Persistence is provider-based: file-backed by default; with
 * TRIGGER_STORE=prod the provider is the Firestore write-through
 * bundle (@icecream-sheets/service/automation-firestore-node) and ANY
 * construction failure marks the supervisor prod-broken — the surface
 * 503s and NOTHING falls back to local or in-memory storage.
 */
import { join } from 'node:path';
import type { EngineHost } from '@icecream-sheets/engine';
import type { Persistence, TriggerSpecInit } from '@icecream-sheets/service';
import {
  SessionTriggerHost,
  type TriggerStatus,
} from '@icecream-sheets/service/automation-node';
import {
  isLiveOwner,
  type FileRegistry,
  type FileRegistryRecord,
} from '../deploy/fileRegistry.js';
import { engineAccessSecret, issueEngineAccessToken } from '../deploy/engineAccess.js';
import { filePersistence, gatewayDataDir } from '../filePersistence.js';
import {
  participantPrincipals,
  participantRole,
  readLocalRegistryRecords,
  type AgentSessionRecord,
} from './agentSessionResolver.js';
import type { EngineSessionHandle } from './engineSvc.js';
import { SessionSubmitHost } from './sessionSubmitHost.js';

/** Key suffix (inside an entry's scope) holding the onOpen-fired record. */
export const OPEN_FIRED_KEY_SUFFIX = 'icecream-sheets.trigger-open-fired.v1';

export function openFiredKeyFor(fileId: string): string {
  return `${fileId}::${OPEN_FIRED_KEY_SUFFIX}`;
}

export interface TriggerScopeHandle {
  persistence: Persistence;
  flush(): Promise<void>;
  /** Re-hydrate from the backing store (Firestore provider); absent
   *  for providers whose loads are already fresh (file provider). */
  refresh?: () => Promise<void>;
}

export interface TriggerPersistenceProvider {
  forScope(scope: string, extraKeys: string[]): Promise<TriggerScopeHandle>;
}

export interface TriggerSupervisorDeps {
  /** Record source override (tests). Wins over registry / local file. */
  records?: Iterable<AgentSessionRecord> | (() => Iterable<AgentSessionRecord> | Promise<Iterable<AgentSessionRecord>>);
  /** Prod registry (Firestore-backed) enumerated via listAll(). */
  registry?: FileRegistry;
  /** Persistence provider override (tests). Default: env-selected. */
  persistenceProvider?: TriggerPersistenceProvider;
  env?: NodeJS.ProcessEnv;
  /** Cross-process store refresh cadence for attached hosts. Default 2000 ms. */
  refreshMs?: number;
  nowMs?: () => number;
  /** Log sink (tests). Default console.log with a [triggers] prefix. */
  log?: (msg: string) => void;
  /**
   * Scheduler tick (Scope update 2): the CAS-capable registry the
   * tick claims closed files through before self-opening a session.
   * Without it the tick still scans and reports, but self-open is
   * unavailable (recorded as a per-trigger failure — loud, not silent).
   */
  claimRegistry?: FileRegistry;
  /** Engine base URL the tick self-opens closed files on. */
  engineBaseUrl?: string;
  /**
   * The instance id of that engine (ENGINE_INSTANCE_ID; default
   * 'engine-1' in engineSvc). The tick's registry CAS names this
   * owner — falling back to the file record's existing ownerInstance
   * when unset (the normal case: the last engine to own the file is
   * the one the tick re-opens it on).
   */
  engineInstanceId?: string;
  /** Fetch override for the tick's engine calls (tests). */
  tickFetch?: typeof fetch;
  /** How long the tick waits for a self-opened session's due triggers to fire. Default 30 s. */
  selfOpenTimeoutMs?: number;
  /** Poll cadence while waiting for a self-opened fire. Default 500 ms. */
  selfOpenPollMs?: number;
}

/** One scheduler tick's outcome (Scope update 2). */
export interface TriggerTickSummary {
  scanned: number;
  fired: string[];
  skippedLive: string[];
  failures: { fileId: string; error: string }[];
  alreadyRunning?: boolean;
}

interface SupervisorEntry {
  host: SessionTriggerHost;
  persistence: Persistence;
  flush: () => Promise<void>;
  refresh: (() => Promise<void>) | undefined;
  attachedSessionId: string | null;
  attachedHost: EngineHost | null;
  submitHost: SessionSubmitHost | null;
}

/**
 * The runtime's timed-due math (TriggerRuntime.tick), mirrored over
 * status-shaped specs so the scheduler tick can find due triggers on
 * files with no attached runtime: onInterval is due when intervalMs
 * elapsed since lastFiredAt (never fired = due); onAtTime is due once
 * when its time has passed and it has never fired.
 */
export function dueTimedSpecs(specs: TriggerStatus[], nowMs: number): TriggerStatus[] {
  return specs.filter((spec) => {
    if (!spec.enabled) return false;
    if (spec.event === 'onInterval' && typeof spec.intervalMs === 'number') {
      const last =
        spec.lastFiredAt !== undefined ? Date.parse(spec.lastFiredAt) : Number.NaN;
      return Number.isNaN(last) || nowMs - last >= spec.intervalMs;
    }
    if (spec.event === 'onAtTime' && spec.lastFiredAt === undefined) {
      return typeof spec.atTimeIso === 'string' && Date.parse(spec.atTimeIso) <= nowMs;
    }
    return false;
  });
}

export class TriggerSupervisor {
  private readonly deps: TriggerSupervisorDeps;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (msg: string) => void;
  private readonly entries = new Map<string, SupervisorEntry>();
  private provider: TriggerPersistenceProvider | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Set when TRIGGER_STORE=prod wiring failed; the surface 503s. */
  prodBrokenReason: string | null = null;

  constructor(deps: TriggerSupervisorDeps = {}) {
    this.deps = deps;
    this.env = deps.env ?? process.env;
    this.log = deps.log ?? ((m) => console.log(`[triggers] ${m}`));
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  start(): void {
    if (this.timer !== null) return;
    const refreshMs = Math.max(250, this.deps.refreshMs ?? 2000);
    this.timer = setInterval(() => {
      void this.refreshAttached();
    }, refreshMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const entry of this.entries.values()) {
      await this.detachEntry(entry);
    }
  }

  /**
   * Pick up management changes written through OTHER processes
   * sharing the store (the engine process's attached hosts refresh;
   * detached entries need nothing — their store reads are demand
   * driven, and the provider refresh keeps the facade current).
   */
  private async refreshAttached(): Promise<void> {
    if (this.prodBrokenReason !== null) return;
    for (const entry of this.entries.values()) {
      if (entry.attachedSessionId === null) continue;
      try {
        await entry.refresh?.();
        entry.host.refreshFromStore();
      } catch (e) {
        this.log(
          `store refresh failed for ${entry.host.scopeId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Session attach / detach (driven by engineSvc session hooks)
  // ------------------------------------------------------------------

  /**
   * The engine reported a live session (hooks). Attach this file's
   * runtime to the session's own host (via the sequenced-submit
   * wrapper) and fire onOpen once per (fileId, sessionId). A handle
   * without a fileId cannot be keyed to a trigger scope and is
   * ignored (the session binds its file before use in production
   * flows; a later ready for the same session carries it).
   */
  async noteSessionReady(handle: EngineSessionHandle): Promise<void> {
    try {
      if (this.prodBrokenReason !== null) return;
      const fileId = handle.fileId;
      if (!fileId) return;
      const entry = await this.ensureEntry(fileId);
      if (entry.attachedSessionId === handle.sessionId && entry.attachedHost === handle.host) {
        return; // already attached to this session + host generation
      }
      await this.detachEntry(entry);
      const submitHost = new SessionSubmitHost(handle, {
        onLateFailure: (specName, error) => {
          for (const status of entry.host.list()) {
            if (status.name === specName) {
              entry.host.noteLateRunFailure(status.id, error);
            }
          }
        },
      });
      entry.submitHost = submitHost;
      entry.host.attach(submitHost);
      entry.attachedSessionId = handle.sessionId;
      entry.attachedHost = handle.host;
      if (this.readFiredSession(entry, fileId) !== handle.sessionId) {
        // Fire onOpen — and only record the greeting when a run
        // actually happened. Writing the marker for an attach with no
        // onOpen triggers would suppress an onOpen trigger created
        // LATER in the same session (it must fire at the next attach,
        // e.g. after an idle release + rehydrate resume).
        const reports = entry.host.fireOpen();
        if (reports.length > 0) {
          this.writeFiredSession(entry, fileId, handle.sessionId);
          await entry.flush();
        }
      }
    } catch (e) {
      if (this.prodBrokenReason !== null) {
        this.log(`prod trigger store broken: ${this.prodBrokenReason}`);
        return;
      }
      this.log(
        `attach failed for session ${handle.sessionId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** The engine reported a session closed (release / fence / replace). */
  async noteSessionClosed(sessionId: string): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.attachedSessionId === sessionId) {
        await this.detachEntry(entry);
      }
    }
  }

  private async detachEntry(entry: SupervisorEntry): Promise<void> {
    if (entry.attachedSessionId === null) return;
    try {
      await entry.submitHost?.drain();
    } catch {
      // Draining must never block a detach.
    }
    try {
      await entry.flush();
    } catch {
      // Detach proceeds; the write failure was already surfaced at
      // the mutation boundary that produced it.
    }
    entry.host.detach();
    entry.submitHost?.dispose();
    entry.submitHost = null;
    entry.attachedSessionId = null;
    entry.attachedHost = null;
  }

  private readFiredSession(entry: SupervisorEntry, fileId: string): string | null {
    try {
      const raw = entry.persistence.load(openFiredKeyFor(fileId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { sessionId?: unknown };
      return typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
    } catch {
      return null;
    }
  }

  private writeFiredSession(entry: SupervisorEntry, fileId: string, sessionId: string): void {
    entry.persistence.save(
      openFiredKeyFor(fileId),
      JSON.stringify({ sessionId, at: new Date().toISOString() }),
    );
  }

  /** The session this file's runtime is currently attached to (ops/tests). */
  attachedSessionFor(fileId: string): string | null {
    return this.entries.get(fileId)?.attachedSessionId ?? null;
  }
  // ------------------------------------------------------------------
  // Scheduler tick (Scope update 2: Cloud Scheduler waker)
  // ------------------------------------------------------------------

  private tickInFlight = false;

  /**
   * One scheduler tick: scan every known file's trigger store for DUE
   * timed triggers (the runtime's due math: onInterval due when
   * intervalMs elapsed since lastFiredAt — never-fired counts as due;
   * onAtTime due once when its time passed and it never fired). Files
   * with a live session are skipped — their attached runtime ticks
   * itself. For a closed file with due triggers, self-open a
   * programmatic session on an engine (engine /session/claim first,
   * then a registry CAS naming THE ENGINE as owner — the gateway's
   * own claim discipline, so the engine adopts the epoch instead of
   * fencing the session — with a creator-minted engine-access
   * token), let
   * the engine-side supervisor's runtime fire them (observed through
   * the shared store's persisted lastFiredAt — which is also what
   * makes a duplicate tick idempotent), then release the session so
   * the normal checkpoint persists the effects. Failures are recorded
   * on the triggers' lastRun and in the returned summary.
   */
  async tick(): Promise<TriggerTickSummary> {
    if (this.tickInFlight) {
      return { scanned: 0, fired: [], skippedLive: [], failures: [], alreadyRunning: true };
    }
    this.tickInFlight = true;
    try {
      return await this.tickInner();
    } finally {
      this.tickInFlight = false;
    }
  }

  private async tickInner(): Promise<TriggerTickSummary> {
    const summary: TriggerTickSummary = { scanned: 0, fired: [], skippedLive: [], failures: [] };
    if (this.prodBrokenReason !== null) {
      summary.failures.push({ fileId: '*', error: `prod trigger store broken: ${this.prodBrokenReason}` });
      return summary;
    }
    const records = await this.loadRecords();
    const latest = new Map<string, FileRegistryRecord>();
    for (const rec of records) {
      if (!rec || typeof rec !== 'object' || typeof rec.fileId !== 'string') continue;
      const prev = latest.get(rec.fileId);
      if (
        !prev ||
        rec.updatedAt > prev.updatedAt ||
        (rec.updatedAt === prev.updatedAt && rec.ownershipEpoch > prev.ownershipEpoch)
      ) {
        latest.set(rec.fileId, rec);
      }
    }
    const now = (this.deps.nowMs ?? Date.now)();
    for (const [fileId, rec] of latest) {
      summary.scanned += 1;
      try {
        const entry = await this.ensureEntry(fileId);
        await entry.refresh?.();
        entry.host.refreshFromStore();
        const due = dueTimedSpecs(entry.host.list(), now);
        if (due.length === 0) continue;
        if (entry.attachedSessionId !== null) {
          summary.skippedLive.push(fileId);
          continue;
        }
        if (isLiveOwner(rec, now)) {
          // The lease alone over-reports: a cleanly RELEASED session
          // leaves its lease standing until expiry (the engine's
          // release does not clear the file-registry record in this
          // topology), so probe the recorded owner's session status.
          // Only a probe that PROVES the session is gone/released
          // lets the self-open proceed; anything ambiguous skips —
          // and the CAS claim in selfOpenAndFire remains the final
          // guard against racing a real (re)open.
          const live = await this.probeSessionLive(rec);
          if (live !== false) {
            summary.skippedLive.push(fileId);
            continue;
          }
        }
        await this.selfOpenAndFire(fileId, rec, entry, due, now, summary);
      } catch (e) {
        summary.failures.push({
          fileId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return summary;
  }

  /**
   * Probe the recorded owner engine's /session/status for the file's
   * recorded session. Returns true (a live session holds the file),
   * false (proven gone/released — self-open is safe to attempt), or
   * null (unknown — the caller must treat the file as live).
   */
  private async probeSessionLive(rec: FileRegistryRecord): Promise<boolean | null> {
    const secret = engineAccessSecret(this.env);
    const base = (rec.ownerEndpoint ?? '').replace(/\/+$/, '');
    if (!secret || !base) return null;
    try {
      const token = issueEngineAccessToken({
        secret,
        principal: rec.creatorPrincipal,
        sessionId: rec.sessionId,
        fid: rec.fileId,
        role: 'editor',
        tier: 'standard',
        ttlSeconds: 60,
      }).token;
      const fetchFn = this.deps.tickFetch ?? fetch;
      const res = await fetchFn(`${base}/session/status`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 401 || res.status === 403) {
        // Wrong-session gate: the engine holds a DIFFERENT session
        // (or none) — this file's session is not live there.
        return false;
      }
      if (res.status !== 200) return null;
      const json = (await res.json().catch(() => null)) as {
        sessionId?: unknown;
        status?: unknown;
      } | null;
      if (!json) return null;
      if (json.sessionId !== rec.sessionId) return false;
      return json.status !== 'released';
    } catch {
      return null;
    }
  }

  private async selfOpenAndFire(
    fileId: string,
    rec: FileRegistryRecord,
    entry: SupervisorEntry,
    due: TriggerStatus[],
    tickStart: number,
    summary: TriggerTickSummary,
  ): Promise<void> {
    const fail = async (error: string): Promise<void> => {
      for (const spec of due) entry.host.recordRunFailure(spec.id, error);
      await entry.flush().catch(() => undefined);
      summary.failures.push({ fileId, error });
    };
    const registry = this.deps.claimRegistry ?? this.deps.registry;
    if (!registry) {
      await fail('tick self-open unavailable: no claim registry configured');
      return;
    }
    const secret = engineAccessSecret(this.env);
    if (!secret) {
      await fail('tick self-open unavailable: engine access secret not configured');
      return;
    }
    const fetchFn = this.deps.tickFetch ?? fetch;
    const sessionId = rec.sessionId;
    const epoch = rec.ownershipEpoch + 1;
    // Ownership discipline mirrors the GATEWAY's open flow exactly:
    // claim the session ON THE ENGINE first, then CAS the registry
    // record naming THE ENGINE as owner (its instance id + endpoint,
    // taken from the file's existing record — the last engine to own
    // it). Naming any other owner (e.g. the tick itself) makes the
    // engine's ownership heartbeat fence the very session the tick
    // just opened ("ownership moved to another instance"); naming the
    // engine lets it adopt the new epoch on its next heartbeat, and
    // its own release then clears the record at that epoch.
    const engineUrl = (rec.ownerEndpoint ?? this.deps.engineBaseUrl ?? '').replace(
      /\/+$/,
      '',
    );
    if (!engineUrl) {
      await fail('tick self-open unavailable: no engine base URL configured');
      return;
    }
    const ownerInstance = this.deps.engineInstanceId ?? rec.ownerInstance;
    const token = issueEngineAccessToken({
      secret,
      principal: rec.creatorPrincipal,
      sessionId,
      fid: fileId,
      role: 'editor',
      tier: 'standard',
      ttlSeconds: 120,
    }).token;
    // Resolve the serving engine's instance id from the engine
    // itself (/session/status reports it): the file's record cannot
    // be trusted for this — a record written by anything that named
    // a non-engine owner would make the CAS fence the session. The
    // status call is best-effort; fallbacks keep the old behavior.
    let resolvedInstanceId: string | null = null;
    try {
      const statusRes = await fetchFn(`${engineUrl}/session/status`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (statusRes.status === 200) {
        const sj = (await statusRes.json().catch(() => null)) as {
          instanceId?: unknown;
        } | null;
        if (typeof sj?.instanceId === 'string' && sj.instanceId.length > 0) {
          resolvedInstanceId = sj.instanceId;
        }
      }
    } catch {
      // Best effort — the claim below surfaces real engine problems.
    }
    const ownerInstanceFinal =
      this.deps.engineInstanceId ?? resolvedInstanceId ?? ownerInstance;
    const engineCall = async (path: string, body: unknown) => {
      const res = await fetchFn(`${engineUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return { status: res.status, json };
    };
    let casWon = false;
    const releaseClaim = async (): Promise<void> => {
      if (!casWon) return;
      try {
        await registry.release(fileId, sessionId, epoch);
      } catch {
        // Best effort: the short lease expires on its own.
      }
    };
    try {
      // 1. Engine claim first (rehydrates the checkpoint snapshot and
      //    attaches the engine-side supervisor, whose runtime fires
      //    the due triggers).
      const claim = await engineCall('/session/claim', { fileId, sessionId });
      if (claim.status !== 200 || claim.json?.ok !== true) {
        await fail(`tick self-open refused by the engine (status ${claim.status})`);
        return;
      }
      if (claim.json.pending === true) {
        // No checkpointed session state exists for this file (never
        // opened / never saved): there is no workbook to fire
        // against. The trigger fires via catch-up at the first real
        // open instead — recorded, not silent.
        await engineCall('/session/release', { sessionId, reason: 'trigger-tick' }).catch(
          () => undefined,
        );
        await fail('tick self-open skipped: no checkpointed session state for this file yet');
        return;
      }
      // 2. Registry CAS naming the engine as owner (see above). A
      //    lost CAS means a real claimant won the race in between:
      //    release the session just opened and treat as live.
      const claimRecord: FileRegistryRecord = {
        ...rec,
        sessionId,
        ownerInstance: ownerInstanceFinal,
        ownerEndpoint: engineUrl,
        leaseExpiry: tickStart + 60_000,
        ownershipEpoch: epoch,
        updatedAt: tickStart,
      };
      try {
        casWon = await registry.claim(claimRecord, rec.ownershipEpoch);
      } catch {
        casWon = false;
      }
      if (!casWon) {
        await engineCall('/session/release', { sessionId, reason: 'trigger-tick' }).catch(
          () => undefined,
        );
        summary.skippedLive.push(fileId);
        return;
      }
      // 3. Observe the shared store: every due spec's lastFiredAt
      //    must advance (the persisted marker is also what makes a
      //    duplicate tick idempotent).
      const deadline = Date.now() + (this.deps.selfOpenTimeoutMs ?? 30_000);
      let firedAll = false;
      while (Date.now() < deadline) {
        await entry.refresh?.();
        entry.host.refreshFromStore();
        const statuses = entry.host.list();
        firedAll = due.every((spec) => {
          const cur = statuses.find((t) => t.id === spec.id);
          return (
            cur !== undefined &&
            cur.lastFiredAt !== undefined &&
            Date.parse(cur.lastFiredAt) > tickStart - 1000
          );
        });
        if (firedAll) break;
        await new Promise((r) => setTimeout(r, this.deps.selfOpenPollMs ?? 500));
      }
      if (firedAll) {
        summary.fired.push(fileId);
      } else {
        await fail('tick: due trigger did not fire within the self-open window');
      }
    } catch (e) {
      await fail(
        `tick self-open failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      await engineCall('/session/release', { sessionId, reason: 'trigger-tick' }).catch(
        () => undefined,
      );
      await releaseClaim();
    }
  }

  // ------------------------------------------------------------------
  // Per-file entries + CRUD
  // ------------------------------------------------------------------

  async ensureEntry(fileId: string): Promise<SupervisorEntry> {
    const existing = this.entries.get(fileId);
    if (existing) return existing;
    const provider = await this.resolveProvider();
    const handle = await provider.forScope(fileId, [openFiredKeyFor(fileId)]);
    const host = new SessionTriggerHost({ persistence: handle.persistence, scope: fileId });
    const entry: SupervisorEntry = {
      host,
      persistence: handle.persistence,
      flush: handle.flush,
      refresh: handle.refresh,
      attachedSessionId: null,
      attachedHost: null,
      submitHost: null,
    };
    this.entries.set(fileId, entry);
    return entry;
  }

  async listForFile(fileId: string): Promise<TriggerStatus[]> {
    const entry = await this.ensureEntry(fileId);
    return entry.host.list();
  }

  async createForFile(fileId: string, init: TriggerSpecInit): Promise<TriggerStatus> {
    const entry = await this.ensureEntry(fileId);
    const created = entry.host.create(init);
    await entry.flush();
    return created;
  }

  async removeForFile(fileId: string, id: string): Promise<boolean> {
    const entry = await this.ensureEntry(fileId);
    const removed = entry.host.remove(id);
    await entry.flush();
    return removed;
  }

  async setEnabledForFile(fileId: string, id: string, enabled: boolean): Promise<TriggerStatus> {
    const entry = await this.ensureEntry(fileId);
    entry.host.setEnabled(id, enabled);
    await entry.flush();
    const found = entry.host.list().find((t) => t.id === id);
    if (!found) throw new Error(`unknown trigger: ${id}`);
    return found;
  }

  async grantForFile(fileId: string, id: string, grantedBy: string): Promise<TriggerStatus> {
    const entry = await this.ensureEntry(fileId);
    entry.host.grant(id, grantedBy);
    await entry.flush();
    const found = entry.host.list().find((t) => t.id === id);
    if (!found) throw new Error(`unknown trigger: ${id}`);
    return found;
  }

  // ------------------------------------------------------------------
  // Authorization (the automation surface's rule)
  // ------------------------------------------------------------------

  /**
   * The caller's standing on a file, from its MOST RECENT registry
   * record (live or not): creator → 'editor'; participant → their
   * recorded role, role-less → 'viewer' (the resolver fail-safe);
   * no record / not matched → null.
   */
  async authorizeFile(principal: string, fileId: string): Promise<'editor' | 'viewer' | null> {
    const records = await this.loadRecords();
    let latest: FileRegistryRecord | null = null;
    for (const rec of records) {
      if (!rec || typeof rec !== 'object' || rec.fileId !== fileId) continue;
      if (
        !latest ||
        rec.updatedAt > latest.updatedAt ||
        (rec.updatedAt === latest.updatedAt && rec.ownershipEpoch > latest.ownershipEpoch)
      ) {
        latest = rec;
      }
    }
    if (!latest) return null;
    if (latest.creatorPrincipal === principal) return 'editor';
    if (participantPrincipals(latest).includes(principal)) {
      return participantRole(latest, principal) ?? 'viewer';
    }
    return null;
  }

  /** True when the file has ANY registry record (live or not). */
  async fileKnown(fileId: string): Promise<boolean> {
    const records = await this.loadRecords();
    return records.some((r) => r && typeof r === 'object' && r.fileId === fileId);
  }

  // ------------------------------------------------------------------
  // Sources
  // ------------------------------------------------------------------

  private async loadRecords(): Promise<AgentSessionRecord[]> {
    if (this.deps.records !== undefined) {
      if (typeof this.deps.records === 'function') {
        return [
          ...((await (this.deps.records as () => Promise<Iterable<AgentSessionRecord>>)()) ?? []),
        ];
      }
      return [...this.deps.records];
    }
    if (this.deps.registry !== undefined) {
      return await this.deps.registry.listAll();
    }
    return readLocalRegistryRecords(this.env);
  }

  private async resolveProvider(): Promise<TriggerPersistenceProvider> {
    if (this.provider) return this.provider;
    if (this.deps.persistenceProvider) {
      this.provider = this.deps.persistenceProvider;
      return this.provider;
    }
    const prod = (this.env.TRIGGER_STORE ?? '').trim().toLowerCase() === 'prod';
    if (!prod) {
      const shared = filePersistence(join(gatewayDataDir(), 'triggers'));
      this.provider = {
        forScope: async () => ({ persistence: shared, flush: () => Promise.resolve() }),
      };
      return this.provider;
    }
    // Prod: the Firestore write-through bundle. ANY failure here is
    // fail-closed: prod-broken, never a silent local fallback.
    try {
      const mod = (await import('@icecream-sheets/service/automation-firestore-node')) as {
        createProdTriggerScopePersistence: (
          env: NodeJS.ProcessEnv,
          scope: string,
          opts?: { extraKeys?: string[] },
        ) => Promise<TriggerScopeHandle>;
      };
      if (typeof mod.createProdTriggerScopePersistence !== 'function') {
        throw new Error('automation-firestore-node did not provide createProdTriggerScopePersistence');
      }
      const env = this.env;
      this.provider = {
        forScope: async (scope: string, extraKeys: string[]) => {
          try {
            return await mod.createProdTriggerScopePersistence(env, scope, { extraKeys });
          } catch (e) {
            // A prod store failure at first use is fail-closed too:
            // mark the supervisor broken so attach stops and the
            // surface 503s — never a silent local fallback.
            this.prodBrokenReason = e instanceof Error ? e.message : String(e);
            throw e;
          }
        },
      };
      return this.provider;
    } catch (e) {
      this.prodBrokenReason = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }
}
