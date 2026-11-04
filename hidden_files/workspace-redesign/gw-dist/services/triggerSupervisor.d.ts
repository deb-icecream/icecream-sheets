import type { EngineHost } from '@icecream-sheets/engine';
import type { Persistence, TriggerSpecInit } from '@icecream-sheets/service';
import { SessionTriggerHost, type TriggerStatus } from '@icecream-sheets/service/automation-node';
import { type FileRegistry } from '../deploy/fileRegistry.js';
import { type AgentSessionRecord } from './agentSessionResolver.js';
import type { EngineSessionHandle } from './engineSvc.js';
import { SessionSubmitHost } from './sessionSubmitHost.js';
/** Key suffix (inside an entry's scope) holding the onOpen-fired record. */
export declare const OPEN_FIRED_KEY_SUFFIX = "icecream-sheets.trigger-open-fired.v1";
export declare function openFiredKeyFor(fileId: string): string;
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
    failures: {
        fileId: string;
        error: string;
    }[];
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
export declare function dueTimedSpecs(specs: TriggerStatus[], nowMs: number): TriggerStatus[];
export declare class TriggerSupervisor {
    private readonly deps;
    private readonly env;
    private readonly log;
    private readonly entries;
    private provider;
    private timer;
    /** Set when TRIGGER_STORE=prod wiring failed; the surface 503s. */
    prodBrokenReason: string | null;
    constructor(deps?: TriggerSupervisorDeps);
    start(): void;
    stop(): Promise<void>;
    /**
     * Pick up management changes written through OTHER processes
     * sharing the store (the engine process's attached hosts refresh;
     * detached entries need nothing — their store reads are demand
     * driven, and the provider refresh keeps the facade current).
     */
    private refreshAttached;
    /**
     * The engine reported a live session (hooks). Attach this file's
     * runtime to the session's own host (via the sequenced-submit
     * wrapper) and fire onOpen once per (fileId, sessionId). A handle
     * without a fileId cannot be keyed to a trigger scope and is
     * ignored (the session binds its file before use in production
     * flows; a later ready for the same session carries it).
     */
    noteSessionReady(handle: EngineSessionHandle): Promise<void>;
    /** The engine reported a session closed (release / fence / replace). */
    noteSessionClosed(sessionId: string): Promise<void>;
    private detachEntry;
    private readFiredSession;
    private writeFiredSession;
    /** The session this file's runtime is currently attached to (ops/tests). */
    attachedSessionFor(fileId: string): string | null;
    private tickInFlight;
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
    tick(): Promise<TriggerTickSummary>;
    private tickInner;
    /**
     * Probe the recorded owner engine's /session/status for the file's
     * recorded session. Returns true (a live session holds the file),
     * false (proven gone/released — self-open is safe to attempt), or
     * null (unknown — the caller must treat the file as live).
     */
    private probeSessionLive;
    private selfOpenAndFire;
    ensureEntry(fileId: string): Promise<SupervisorEntry>;
    listForFile(fileId: string): Promise<TriggerStatus[]>;
    createForFile(fileId: string, init: TriggerSpecInit): Promise<TriggerStatus>;
    removeForFile(fileId: string, id: string): Promise<boolean>;
    setEnabledForFile(fileId: string, id: string, enabled: boolean): Promise<TriggerStatus>;
    grantForFile(fileId: string, id: string, grantedBy: string): Promise<TriggerStatus>;
    /**
     * The caller's standing on a file, from its MOST RECENT registry
     * record (live or not): creator → 'editor'; participant → their
     * recorded role, role-less → 'viewer' (the resolver fail-safe);
     * no record / not matched → null.
     */
    authorizeFile(principal: string, fileId: string): Promise<'editor' | 'viewer' | null>;
    /** True when the file has ANY registry record (live or not). */
    fileKnown(fileId: string): Promise<boolean>;
    private loadRecords;
    private resolveProvider;
}
export {};
