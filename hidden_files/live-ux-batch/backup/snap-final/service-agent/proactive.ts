/**
 * Proactive event subscriptions (design-docs/ai-agent.md §6).
 *
 * Proactivity rides on engine event subscriptions: cell and range changes,
 * collaborator edits and recalculation completion. A fired subscription
 * wakes the agent with context and the agent decides whether anything
 * deserves the user's attention. Proactive pings are rate-limited and the
 * user can mute categories or the whole thing.
 *
 * The ProactiveWatcher owns that loop: it subscribes through the MCP
 * subscription tools (via injected subscribe/poll/unsubscribe — the agent
 * service wires these to AgentRuntime.watch/pollWatch/unwatch, so every
 * event still crosses the MCP protocol boundary), batches rapid events
 * into one wake, rate-limits pings per watch session, applies the user's
 * persisted mute config (whole-thing + per-category), and hands each
 * surviving batch to the decider — the "agent decides whether anything
 * deserves the user's attention" hook. The default decider summarizes the
 * batch deterministically; a model-backed decider can be injected.
 *
 * Surviving wakes queue per watch session and are drained with
 * pollWakes() (the agent service exposes this over HTTP; the web client
 * polls it).
 */

import type { Persistence } from '../metadataStore.js';

/** Event types the agent can subscribe to (mirrors the MCP subscription schema). */
export type ProactiveEventType =
  | 'cells_changed'
  | 'recalc_complete'
  | 'sheet_added'
  | 'sheet_removed';

export const PROACTIVE_EVENT_TYPES: readonly ProactiveEventType[] = [
  'cells_changed',
  'recalc_complete',
  'sheet_added',
  'sheet_removed',
];

export function isProactiveEventType(t: string): t is ProactiveEventType {
  return (PROACTIVE_EVENT_TYPES as readonly string[]).includes(t);
}

/** One buffered engine event (shape mirrors the MCP poll_events records). */
export interface ProactiveEvent {
  seq: number;
  ts: number;
  type: ProactiveEventType;
  detail: Record<string, unknown>;
}

/**
 * User mute config (ai-agent.md §6: "the user can mute categories or the
 * whole thing"). Per user, persisted in the service metadata store.
 */
export interface ProactiveMuteConfig {
  /** Mute everything, regardless of per-category flags. */
  mutedAll: boolean;
  /** Per-category mute; every category present, default false. */
  muted: Record<ProactiveEventType, boolean>;
}

export function defaultMuteConfig(): ProactiveMuteConfig {
  return {
    mutedAll: false,
    muted: {
      cells_changed: false,
      recalc_complete: false,
      sheet_added: false,
      sheet_removed: false,
    },
  };
}

export interface ProactiveWatchRequest {
  events: ProactiveEventType[];
  sheet?: string;
}

/** The context a fired subscription hands to the agent. */
export interface ProactiveContext {
  watchId: string;
  principal: string;
  sheet?: string;
  events: ProactiveEvent[];
  categories: ProactiveEventType[];
}

/** The agent's verdict on a batch: notify (with a message) or stay silent. */
export interface ProactiveDecision {
  notify: boolean;
  message: string;
}

export type ProactiveDecider = (ctx: ProactiveContext) => Promise<ProactiveDecision>;

/** A wake the agent decided deserves the user's attention. */
export interface ProactiveWake {
  watchId: string;
  ts: number;
  categories: ProactiveEventType[];
  summary: string;
  /** The batched events behind this wake (oldest first). */
  events: ProactiveEvent[];
  /** Human-readable context string handed to the agent. */
  context: string;
}

export interface ProactiveWatcherDeps {
  /** Create an MCP event subscription; resolves with the subscription id. */
  subscribe: (events: ProactiveEventType[], sheet?: string) => Promise<string>;
  /** Drain buffered events for a subscription (oldest first). */
  poll: (subscriptionId: string, maxEvents?: number) => Promise<ProactiveEvent[]>;
  /** Remove a subscription. */
  unsubscribe: (subscriptionId: string) => Promise<void>;
  /**
   * The "agent decides" hook (§6). Defaults to a deterministic summarizer
   * (notify with a plain-language summary). Inject a model-backed decider
   * to let the configured model backend judge each batch.
   */
  decide?: ProactiveDecider;
  /** Where per-user mute configs persist. Defaults to in-memory. */
  mutePersistence?: Persistence;
  /** Clock; injectable for tests. */
  now?: () => number;
}

export interface ProactiveWatcherOptions {
  /** How often each session polls its subscription. Default 2000ms. */
  pollIntervalMs?: number;
  /** Rapid events inside this window batch into one wake. Default 1500ms. */
  batchWindowMs?: number;
  /** Minimum gap between two pings of the same session. Default 30_000ms. */
  minPingIntervalMs?: number;
  /** Hard cap: pings per rolling hour per session. Default 20. */
  maxPingsPerHour?: number;
  /** Max buffered events per session before oldest are dropped. Default 500. */
  maxBufferedEvents?: number;
}

const MUTE_STORAGE_KEY = 'icecream-sheets.agent.proactive-mute.v1';
const MUTE_VERSION = 1;

interface StoredMute {
  version: number;
  users: Record<string, ProactiveMuteConfig>;
}

interface WatchSession {
  watchId: string;
  principal: string;
  subscriptionId: string;
  sheet?: string;
  timer: ReturnType<typeof setInterval>;
  buffer: ProactiveEvent[];
  batchStartAt: number | null;
  wakes: ProactiveWake[];
  lastPingAt: number;
  pingTimes: number[];
}

let watchSeq = 1;

export class ProactiveWatcher {
  private readonly deps: Required<Pick<ProactiveWatcherDeps, 'subscribe' | 'poll' | 'unsubscribe' | 'decide'>> &
    Pick<ProactiveWatcherDeps, 'mutePersistence'>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly batchWindowMs: number;
  private readonly minPingIntervalMs: number;
  private readonly maxPingsPerHour: number;
  private readonly maxBufferedEvents: number;
  private readonly sessions = new Map<string, WatchSession>();
  private muteCache: StoredMute | null = null;

  constructor(deps: ProactiveWatcherDeps, opts: ProactiveWatcherOptions = {}) {
    this.deps = {
      subscribe: deps.subscribe,
      poll: deps.poll,
      unsubscribe: deps.unsubscribe,
      decide: deps.decide ?? defaultDecider,
      mutePersistence: deps.mutePersistence,
    };
    this.now = deps.now ?? Date.now;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.batchWindowMs = opts.batchWindowMs ?? 1500;
    this.minPingIntervalMs = opts.minPingIntervalMs ?? 30_000;
    this.maxPingsPerHour = opts.maxPingsPerHour ?? 20;
    this.maxBufferedEvents = opts.maxBufferedEvents ?? 500;
  }

  /**
   * Start watching: subscribe through the MCP subscription tools and begin
   * the poll loop. Resolves with a watch id the client uses to drain wakes.
   */
  async startWatch(principal: string, req: ProactiveWatchRequest): Promise<string> {
    if (!principal) throw new Error('proactive: principal is required');
    const events = req.events.filter(isProactiveEventType);
    if (events.length === 0) throw new Error('proactive: at least one valid event type is required');
    const subscriptionId = await this.deps.subscribe(events, req.sheet);
    const watchId = `watch-${watchSeq++}-${Math.random().toString(36).slice(2, 8)}`;
    const session: WatchSession = {
      watchId,
      principal,
      subscriptionId,
      sheet: req.sheet,
      timer: setInterval(() => void this.pollOnce(watchId).catch(() => undefined), this.pollIntervalMs),
      buffer: [],
      batchStartAt: null,
      wakes: [],
      lastPingAt: 0,
      pingTimes: [],
    };
    // An unref'd timer must not keep a server process alive on its own.
    const t = session.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
    this.sessions.set(watchId, session);
    return watchId;
  }

  /** Drain queued wakes for a session (oldest first). Unknown id → []. */
  pollWakes(watchId: string): ProactiveWake[] {
    const s = this.sessions.get(watchId);
    if (!s) return [];
    const out = s.wakes;
    s.wakes = [];
    return out;
  }

  /** Stop a session: clear the poll timer and remove the MCP subscription. */
  async stopWatch(watchId: string): Promise<boolean> {
    const s = this.sessions.get(watchId);
    if (!s) return false;
    this.sessions.delete(watchId);
    clearInterval(s.timer);
    await this.deps.unsubscribe(s.subscriptionId).catch(() => undefined);
    return true;
  }

  /** Stop every session. */
  async close(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.stopWatch(id);
  }

  /** One poll tick for a session: buffer events, flush due batches. Exposed for tests. */
  async pollOnce(watchId: string): Promise<void> {
    const s = this.sessions.get(watchId);
    if (!s) return;
    const events = await this.deps.poll(s.subscriptionId, 100).catch(() => [] as ProactiveEvent[]);
    const now = this.now();
    for (const e of events) {
      if (!isProactiveEventType(e.type)) continue;
      if (s.batchStartAt === null) s.batchStartAt = e.ts || now;
      s.buffer.push(e);
    }
    if (s.buffer.length > this.maxBufferedEvents) {
      s.buffer = s.buffer.slice(s.buffer.length - this.maxBufferedEvents);
    }
    if (s.buffer.length === 0 || s.batchStartAt === null) return;
    if (now - s.batchStartAt < this.batchWindowMs) return; // still batching rapid events
    await this.flush(s, now);
  }

  // -- mute (ai-agent.md §6: whole-thing toggle + per-category, per user, persisted) --

  /** The user's mute config (defaults when never set). */
  getMuteConfig(principal: string): ProactiveMuteConfig {
    const stored = this.loadMute().users[principal];
    return stored ? { mutedAll: stored.mutedAll, muted: { ...stored.muted } } : defaultMuteConfig();
  }

  /**
   * Patch the user's mute config (partial). Persists write-through to the
   * service metadata store. Returns the full resulting config.
   */
  setMuteConfig(
    principal: string,
    patch: { mutedAll?: boolean; muted?: Partial<Record<ProactiveEventType, boolean>> },
  ): ProactiveMuteConfig {
    const current = this.getMuteConfig(principal);
    const next: ProactiveMuteConfig = {
      mutedAll: patch.mutedAll ?? current.mutedAll,
      muted: { ...current.muted, ...patch.muted },
    };
    const stored = this.loadMute();
    stored.users[principal] = next;
    this.saveMute(stored);
    return { mutedAll: next.mutedAll, muted: { ...next.muted } };
  }

  // -- internals -----------------------------------------------------------

  /** Flush one batch: mute-filter, rate-limit, decide, enqueue wake. */
  private async flush(s: WatchSession, now: number): Promise<void> {
    const batch = s.buffer;
    s.buffer = [];
    s.batchStartAt = null;
    if (batch.length === 0) return;

    // Mute: whole-thing first, then per-category.
    const mute = this.getMuteConfig(s.principal);
    if (mute.mutedAll) return;
    const kept = batch.filter((e) => !mute.muted[e.type]);
    if (kept.length === 0) return;

    // Rate limiting: minimum gap between pings; hard hourly cap.
    if (now - s.lastPingAt < this.minPingIntervalMs) {
      // Don't spam: re-buffer so the events join the NEXT wake instead of
      // being dropped or pinged immediately.
      s.buffer = [...kept, ...s.buffer];
      if (s.batchStartAt === null) s.batchStartAt = now;
      return;
    }
    const hourAgo = now - 3_600_000;
    s.pingTimes = s.pingTimes.filter((t) => t > hourAgo);
    if (s.pingTimes.length >= this.maxPingsPerHour) return; // drop: hard cap hit

    const categories = [...new Set(kept.map((e) => e.type))];
    const context = buildContext(s.principal, s.sheet, kept);
    let decision: ProactiveDecision;
    try {
      decision = await this.deps.decide({
        watchId: s.watchId,
        principal: s.principal,
        sheet: s.sheet,
        events: kept,
        categories,
      });
    } catch {
      decision = { notify: true, message: summarizeBatch(s.sheet, kept) };
    }
    if (!decision.notify) return; // the agent decided this deserves no attention
    s.lastPingAt = now;
    s.pingTimes.push(now);
    s.wakes.push({
      watchId: s.watchId,
      ts: now,
      categories,
      summary: decision.message || summarizeBatch(s.sheet, kept),
      events: kept,
      context,
    });
  }

  private loadMute(): StoredMute {
    if (this.muteCache) return this.muteCache;
    const p = this.deps.mutePersistence;
    let users: Record<string, ProactiveMuteConfig> = {};
    if (p) {
      try {
        const raw = p.load(MUTE_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<StoredMute>;
          if (parsed && parsed.version === MUTE_VERSION && typeof parsed.users === 'object' && parsed.users !== null) {
            users = parsed.users as Record<string, ProactiveMuteConfig>;
          }
        }
      } catch {
        users = {};
      }
    }
    this.muteCache = { version: MUTE_VERSION, users };
    return this.muteCache;
  }

  private saveMute(stored: StoredMute): void {
    this.muteCache = stored;
    this.deps.mutePersistence?.save(MUTE_STORAGE_KEY, JSON.stringify(stored));
  }
}

/**
 * The default "agent decides" implementation: deterministic, dependency-free
 * (consistent with the shipped heuristic backend — tools and behavior do not
 * change with the model). Every surviving batch notifies with a
 * plain-language summary; inject a model-backed decider for LLM judgment.
 */
async function defaultDecider(ctx: ProactiveContext): Promise<ProactiveDecision> {
  return { notify: true, message: summarizeBatch(ctx.sheet, ctx.events) };
}

/** Plain-language summary of a batch, e.g. "3 cell changes, recalculation finished on Sheet1". */
export function summarizeBatch(sheet: string | undefined, events: ProactiveEvent[]): string {
  const counts = new Map<ProactiveEventType, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const bits: string[] = [];
  const cells = counts.get('cells_changed') ?? 0;
  const recalcs = counts.get('recalc_complete') ?? 0;
  const added = counts.get('sheet_added') ?? 0;
  const removed = counts.get('sheet_removed') ?? 0;
  if (cells > 0) bits.push(`${cells} cell change${cells === 1 ? '' : 's'}`);
  if (recalcs > 0) bits.push(recalcs === 1 ? 'recalculation finished' : `${recalcs} recalculations finished`);
  if (added > 0) bits.push(`${added} sheet${added === 1 ? '' : 's'} added`);
  if (removed > 0) bits.push(`${removed} sheet${removed === 1 ? '' : 's'} removed`);
  const where = sheet ? ` on ${sheet}` : '';
  return `Heads up: ${bits.join(', ') || 'activity'}${where}.`;
}

/**
 * The context a fired subscription hands to the agent: what happened,
 * where, and a sample of the raw detail so the agent can decide with
 * specifics rather than bare counts.
 */
export function buildContext(
  principal: string,
  sheet: string | undefined,
  events: ProactiveEvent[],
): string {
  const lines = [
    `Proactive wake for ${principal}.`,
    summarizeBatch(sheet, events),
    `Batch of ${events.length} event(s), oldest first:`,
  ];
  for (const e of events.slice(0, 10)) {
    lines.push(`- ${e.type} @ ${new Date(e.ts).toISOString()}: ${JSON.stringify(e.detail).slice(0, 300)}`);
  }
  if (events.length > 10) lines.push(`… and ${events.length - 10} more.`);
  lines.push('Decide whether this deserves the user\'s attention.');
  return lines.join('\n');
}
