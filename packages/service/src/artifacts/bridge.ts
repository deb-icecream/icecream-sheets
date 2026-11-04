/**
 * Host <-> sandboxed-iframe bridge protocol (AI-generated app pattern).
 *
 * GENERATED APPS NEVER TOUCH THE ENGINE. The generated React app runs in a
 * sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`, so
 * the iframe has an opaque origin and cannot reach the parent DOM, storage,
 * or network). Its ONLY way to read or write sheet data is this message
 * bridge:
 *
 *   iframe -> host : { __icecream_bridge: 1, id, kind: 'call', tool, args }
 *   host -> iframe : { __icecream_bridge: 1, id, kind: 'result', ok, data?, error? }
 *
 * The host validates the request (tool allow-list, arg shape), executes it
 * through the REAL MCP client — the same product MCP server the AI Agent
 * uses, so authorization, per-subject filtered views and audit apply
 * identically — and posts the result back. `id` correlates requests with
 * responses (the iframe keeps a pending-promise map).
 *
 * Live binding (sheet -> app) rides on the MCP subscription tools:
 *
 *   iframe -> host : { __icecream_bridge: 1, kind: 'subscribe', subKey, events, sheet? }
 *   host -> iframe : { __icecream_bridge: 1, kind: 'event', subKey, events: [...] }
 *   iframe -> host : { __icecream_bridge: 1, kind: 'unsubscribe', subKey }
 *
 * The host holds ONE MCP subscription per unique (events, sheet) and
 * reference-counts iframe subKeys on top of it. It polls `poll_events` on
 * an interval and forwards any drained events into the iframe, where the
 * app's subscription handler re-reads and re-renders. App -> sheet writes
 * go through `write_cells`/`set_formulas` bridge calls and land in real
 * time, which in turn fires the subscription — the two-way loop.
 *
 * Allowed tools are the data-plane MCP tools only. Memory, app-builder,
 * data-source and code-execution tools are NOT exposed to generated apps:
 * an embedded app must not read another user's agent memory, manage apps,
 * open new data sources, or run arbitrary code in the service sandbox.
 *
 * This module is headless: ArtifactBridgeHost takes a `callTool` function
 * and a `postToFrame` sink, so it is fully unit-testable with a mock MCP
 * client. The web UI (ArtifactHost.tsx) wires it to a real in-memory MCP
 * client and the iframe's postMessage.
 */

/** Protocol version. Bump when the message shapes change incompatibly. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Envelope tag every bridge message carries. */
export const BRIDGE_TAG = '__icecream_bridge';

/** MCP tools a generated app may call through the bridge. */
export type BridgeToolName =
  | 'read_cells'
  | 'write_cells'
  | 'set_formulas'
  | 'get_results'
  | 'recalculate'
  | 'subscribe'
  | 'unsubscribe'
  | 'poll_events';

export const ALLOWED_BRIDGE_TOOLS: readonly BridgeToolName[] = [
  'read_cells',
  'write_cells',
  'set_formulas',
  'get_results',
  'recalculate',
  'subscribe',
  'unsubscribe',
  'poll_events',
];

/** Tools that exist on the MCP server but are deliberately NOT bridged. */
export const FORBIDDEN_BRIDGE_TOOLS: readonly string[] = [
  'memory_load',
  'memory_save',
  'memory_update',
  'appbuilder_create_spec',
  'appbuilder_update_spec',
  'appbuilder_get_spec',
  'appbuilder_list_specs',
  'appbuilder_delete_spec',
  'execute_code',
  'list_data_sources',
  'open_data_source',
  'refresh_data_source',
  'create_pivot',
  'refresh_pivot',
  'get_pivot_data',
];

// ---------------------------------------------------------------------------
// Message shapes
// ---------------------------------------------------------------------------

export interface BridgeCallRequest {
  [BRIDGE_TAG]: 1;
  id: string;
  kind: 'call';
  tool: string;
  args: Record<string, unknown>;
}

export interface BridgeResult {
  [BRIDGE_TAG]: 1;
  id: string;
  kind: 'result';
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface BridgeSubscribe {
  [BRIDGE_TAG]: 1;
  kind: 'subscribe';
  subKey: string;
  events: string[];
  sheet?: string;
}

export interface BridgeUnsubscribe {
  [BRIDGE_TAG]: 1;
  kind: 'unsubscribe';
  subKey: string;
}

export interface BridgeEventPush {
  [BRIDGE_TAG]: 1;
  kind: 'event';
  subKey: string;
  events: { seq: number; ts: number; type: string; detail: unknown }[];
}

/** Messages the iframe may send to the host. */
export type BridgeFrameMessage = BridgeCallRequest | BridgeSubscribe | BridgeUnsubscribe;

/** Messages the host may post into the iframe. */
export type BridgeHostMessage = BridgeResult | BridgeEventPush;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when a postMessage payload is a bridge message (either direction). */
export function isBridgeMessage(v: unknown): boolean {
  return isRecord(v) && v[BRIDGE_TAG] === BRIDGE_PROTOCOL_VERSION;
}

export interface BridgeValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate an iframe->host message. Never throws. Checks the envelope,
 * the kind, and — for calls — the tool allow-list and arg shape.
 */
export function validateBridgeMessage(v: unknown): BridgeValidation {
  if (!isRecord(v)) return { ok: false, error: 'message must be an object' };
  if (v[BRIDGE_TAG] !== BRIDGE_PROTOCOL_VERSION) {
    return { ok: false, error: `bad ${BRIDGE_TAG} tag (expected ${BRIDGE_PROTOCOL_VERSION})` };
  }
  const kind = v['kind'];
  if (kind === 'call') {
    if (typeof v['id'] !== 'string' || v['id'].length === 0) {
      return { ok: false, error: 'call is missing id' };
    }
    const tool = v['tool'];
    if (typeof tool !== 'string' || tool.length === 0) {
      return { ok: false, error: 'call is missing tool' };
    }
    if (!(ALLOWED_BRIDGE_TOOLS as readonly string[]).includes(tool)) {
      return { ok: false, error: `tool "${tool}" is not available to generated apps` };
    }
    if (v['args'] !== undefined && !isRecord(v['args'])) {
      return { ok: false, error: 'call args must be an object' };
    }
    return { ok: true };
  }
  if (kind === 'subscribe') {
    if (typeof v['subKey'] !== 'string' || v['subKey'].length === 0) {
      return { ok: false, error: 'subscribe is missing subKey' };
    }
    if (!Array.isArray(v['events']) || v['events'].length === 0 || v['events'].some((e) => typeof e !== 'string')) {
      return { ok: false, error: 'subscribe events must be a non-empty string array' };
    }
    if (v['sheet'] !== undefined && typeof v['sheet'] !== 'string') {
      return { ok: false, error: 'subscribe sheet must be a string' };
    }
    return { ok: true };
  }
  if (kind === 'unsubscribe') {
    if (typeof v['subKey'] !== 'string' || v['subKey'].length === 0) {
      return { ok: false, error: 'unsubscribe is missing subKey' };
    }
    return { ok: true };
  }
  return { ok: false, error: `unknown bridge message kind ${String(kind)}` };
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * MCP call function. Takes the tool name and args, returns the PARSED
 * result payload (the host that adapts the raw MCP client unwraps the
 * content envelope and throws on tool errors — see web mcpToolClient).
 */
export type McpCallFn = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** Subscription event shape, as returned by the MCP poll_events tool. */
export interface McpEvent {
  seq: number;
  ts: number;
  type: string;
  detail: unknown;
}

export interface BridgeHostOptions {
  callTool: McpCallFn;
  /** Sink for host->iframe messages (the web UI posts to the iframe). */
  postToFrame: (msg: BridgeHostMessage) => void;
  /** Identity stamped on MCP subscription calls. */
  principal?: string;
  /** poll_events cadence in ms. */
  pollIntervalMs?: number;
  /** Max events drained per poll. */
  maxEventsPerPoll?: number;
}

interface LiveBinding {
  /** MCP subscription id. */
  mcpSubId: string;
  /** iframe subKeys reference-counted on this binding. */
  refs: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
  polling: boolean;
}

/**
 * Headless host side of the bridge. The web UI creates one per open
 * artifact, feeds it iframe messages via handleFrameMessage(), and posts
 * its output messages into the iframe.
 */
export class ArtifactBridgeHost {
  private readonly callTool: McpCallFn;
  private readonly postToFrame: (msg: BridgeHostMessage) => void;
  private readonly principal: string;
  private readonly pollIntervalMs: number;
  private readonly maxEventsPerPoll: number;
  private readonly bindings = new Map<string, LiveBinding>();
  /** In-flight subscription creations, keyed like bindings (race guard). */
  private readonly pendingBindings = new Map<string, Promise<LiveBinding | null>>();
  private disposed = false;

  constructor(opts: BridgeHostOptions) {
    this.callTool = opts.callTool;
    this.postToFrame = opts.postToFrame;
    this.principal = opts.principal ?? 'artifact-app';
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxEventsPerPoll = opts.maxEventsPerPoll ?? 50;
  }

  /**
   * Handle one iframe->host message. Validates first; invalid messages
   * get an error result posted back (for calls) or are dropped (for
   * subscribe/unsubscribe, which carry no correlation id).
   */
  handleFrameMessage(msg: unknown): void {
    if (this.disposed) return;
    const v = validateBridgeMessage(msg);
    if (!v.ok) {
      if (isRecord(msg) && msg['kind'] === 'call' && typeof msg['id'] === 'string') {
        this.postToFrame({
          [BRIDGE_TAG]: BRIDGE_PROTOCOL_VERSION,
          id: msg['id'],
          kind: 'result',
          ok: false,
          error: v.error,
        });
      }
      return;
    }
    const m = msg as BridgeFrameMessage;
    if (m.kind === 'call') void this.handleCall(m);
    else if (m.kind === 'subscribe') void this.handleSubscribe(m);
    else void this.handleUnsubscribe(m);
  }

  private async handleCall(m: BridgeCallRequest): Promise<void> {
    const respond = (ok: boolean, data?: unknown, error?: string): void => {
      this.postToFrame({
        [BRIDGE_TAG]: BRIDGE_PROTOCOL_VERSION,
        id: m.id,
        kind: 'result',
        ok,
        ...(ok ? { data } : { error }),
      });
    };
    try {
      // The bridge never forwards subscribe/unsubscribe/poll_events as
      // direct calls: subscriptions are managed through the subKey
      // protocol above so the host can fan events out to iframe handlers.
      if (m.tool === 'subscribe' || m.tool === 'unsubscribe' || m.tool === 'poll_events') {
        respond(false, undefined, `use the bridge subscription protocol for "${m.tool}", not direct calls`);
        return;
      }
      // Act as the user (ai-agent.md §3): stamp the principal so
      // authorization and per-subject filtered views apply to the
      // generated app exactly as they do to the agent.
      const data = await this.callTool(m.tool, { principal: this.principal, ...(m.args ?? {}) });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  private bindingKey(events: string[], sheet?: string): string {
    return `${[...events].sort().join(',')}|${sheet ?? ''}`;
  }

  private async handleSubscribe(m: BridgeSubscribe): Promise<void> {
    if (this.disposed) return;
    const key = this.bindingKey(m.events, m.sheet);
    const existing = this.bindings.get(key);
    if (existing) {
      existing.refs.add(m.subKey);
      return;
    }
    // Race guard: concurrent subscribes for the same (events, sheet) share
    // one in-flight MCP subscription instead of creating two.
    let pending = this.pendingBindings.get(key);
    if (!pending) {
      pending = this.createBinding(m);
      this.pendingBindings.set(key, pending);
    }
    const binding = await pending;
    this.pendingBindings.delete(key);
    if (binding && !this.disposed) binding.refs.add(m.subKey);
  }

  private async createBinding(m: BridgeSubscribe): Promise<LiveBinding | null> {
    const key = this.bindingKey(m.events, m.sheet);
    let mcpSubId: string;
    try {
      const res = (await this.callTool('subscribe', {
        events: m.events,
        ...(m.sheet ? { sheet: m.sheet } : {}),
        principal: this.principal,
      })) as { subscriptionId?: string };
      if (!res || typeof res.subscriptionId !== 'string') {
        throw new Error('subscribe returned no subscriptionId');
      }
      mcpSubId = res.subscriptionId;
    } catch {
      // Subscription failed: nothing to bind. The app keeps working;
      // it just won't get live updates until it resubscribes.
      return null;
    }
    const binding: LiveBinding = { mcpSubId, refs: new Set(), timer: null, polling: false };
    this.bindings.set(key, binding);
    binding.timer = setInterval(() => void this.pollBinding(key), this.pollIntervalMs);
    // Prime immediately so the first events arrive without waiting a tick.
    void this.pollBinding(key);
    return binding;
  }

  private async handleUnsubscribe(m: BridgeUnsubscribe): Promise<void> {
    for (const [key, binding] of this.bindings) {
      if (!binding.refs.delete(m.subKey)) continue;
      if (binding.refs.size === 0) {
        if (binding.timer) clearInterval(binding.timer);
        this.bindings.delete(key);
        try {
          await this.callTool('unsubscribe', { subscriptionId: binding.mcpSubId });
        } catch {
          /* best effort */
        }
      }
    }
  }

  private async pollBinding(key: string): Promise<void> {
    const binding = this.bindings.get(key);
    if (!binding || binding.polling || this.disposed) return;
    binding.polling = true;
    try {
      const res = (await this.callTool('poll_events', {
        subscriptionId: binding.mcpSubId,
        maxEvents: this.maxEventsPerPoll,
      })) as { events?: McpEvent[] };
      const events = Array.isArray(res?.events) ? res.events : [];
      if (events.length > 0) {
        for (const subKey of binding.refs) {
          this.postToFrame({
            [BRIDGE_TAG]: BRIDGE_PROTOCOL_VERSION,
            kind: 'event',
            subKey,
            events,
          });
        }
      }
    } catch {
      /* transient poll failure: keep the binding, retry next tick */
    } finally {
      binding.polling = false;
    }
  }

  /** Number of live MCP subscriptions (for tests/diagnostics). */
  bindingCount(): number {
    return this.bindings.size;
  }

  /** Tear down: clear poll timers and unsubscribe everything. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingBindings.clear();
    for (const [, binding] of this.bindings) {
      if (binding.timer) clearInterval(binding.timer);
      void this.callTool('unsubscribe', { subscriptionId: binding.mcpSubId }).catch(() => undefined);
    }
    this.bindings.clear();
  }
}
