/**
 * MCP event subscriptions (track 28).
 *
 * The MCP stdio transport is request/response, so true server push is not
 * possible: clients `subscribe` to engine event types, the server buffers
 * matching events per subscription, and clients drain them with `poll_events`.
 * This is the mechanism the AI Agent's proactive subscriptions (§6 of
 * design-docs/ai-agent.md) ride on.
 *
 * Engine events are sourced from EngineHost.subscribe(); nothing here reaches
 * past the versioned protocol into the engine internals.
 */
import type { CellRef, EngineEvent, EngineHost } from '@icecream-sheets/engine';

export type SubscriptionEventType =
  | 'cells_changed'
  | 'recalc_complete'
  | 'sheet_added'
  | 'sheet_removed';

export const SUBSCRIPTION_EVENT_TYPES: readonly SubscriptionEventType[] = [
  'cells_changed',
  'recalc_complete',
  'sheet_added',
  'sheet_removed',
] as const;

export function isSubscriptionEventType(t: string): t is SubscriptionEventType {
  return (SUBSCRIPTION_EVENT_TYPES as readonly string[]).includes(t);
}

/** Optional filter. Currently only cells_changed supports filtering. */
export interface SubscriptionFilter {
  /** Only deliver cells_changed events touching this sheet. */
  sheet?: string;
}

export interface BufferedEvent {
  seq: number;
  ts: number;
  type: SubscriptionEventType;
  detail: Record<string, unknown>;
}

export interface SubscriptionInfo {
  id: string;
  events: SubscriptionEventType[];
  filter: SubscriptionFilter;
  principal: string;
  createdAt: number;
  buffered: number;
}

interface Subscription {
  id: string;
  events: Set<SubscriptionEventType>;
  filter: SubscriptionFilter;
  principal: string;
  createdAt: number;
  buffer: BufferedEvent[];
}

/** Hard cap on buffered events per subscription (oldest dropped first). */
export const MAX_BUFFERED_EVENTS = 500;

function cellRefToA1(ref: CellRef): string {
  let col = '';
  let n = ref.col;
  do {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${ref.sheet}!${col}${ref.row + 1}`;
}

export class SubscriptionManager {
  private subs = new Map<string, Subscription>();
  private subSeq = 1;
  private eventSeq = 1;
  private detach: (() => void) | null = null;
  private attached = false;

  /**
   * Hook engine events. Idempotent: attaching the same manager twice is a
   * no-op, attaching a different host re-hooks.
   */
  attach(host: EngineHost): void {
    if (this.attached) return;
    this.detach = host.subscribe((event: EngineEvent) => this.route(event));
    this.attached = true;
  }

  /** Detach from the engine. Buffered events are kept. */
  detachHost(): void {
    this.detach?.();
    this.detach = null;
    this.attached = false;
  }

  subscribe(
    events: SubscriptionEventType[],
    filter: SubscriptionFilter = {},
    principal = 'mcp-client',
  ): string {
    const id = `sub_${this.subSeq++}`;
    this.subs.set(id, {
      id,
      events: new Set(events),
      filter: { ...filter },
      principal,
      createdAt: Date.now(),
      buffer: [],
    });
    return id;
  }

  unsubscribe(id: string): boolean {
    return this.subs.delete(id);
  }

  list(): SubscriptionInfo[] {
    return [...this.subs.values()].map((s) => ({
      id: s.id,
      events: [...s.events],
      filter: { ...s.filter },
      principal: s.principal,
      createdAt: s.createdAt,
      buffered: s.buffer.length,
    }));
  }

  /**
   * Drain buffered events for a subscription (oldest first).
   * Returns null when the subscription id is unknown.
   */
  poll(id: string, maxEvents = 100): BufferedEvent[] | null {
    const sub = this.subs.get(id);
    if (!sub) return null;
    const n = Math.min(Math.max(1, maxEvents), MAX_BUFFERED_EVENTS);
    return sub.buffer.splice(0, n);
  }

  private route(event: EngineEvent): void {
    let type: SubscriptionEventType;
    let detail: Record<string, unknown>;
    switch (event.type) {
      case 'cellsChanged':
        type = 'cells_changed';
        detail = { refs: event.refs.map(cellRefToA1) };
        break;
      case 'recalcComplete':
        type = 'recalc_complete';
        detail = {};
        break;
      case 'sheetAdded':
        type = 'sheet_added';
        detail = { name: event.name };
        break;
      case 'sheetRemoved':
        type = 'sheet_removed';
        detail = { name: event.name };
        break;
      default:
        return;
    }
    for (const sub of this.subs.values()) {
      if (!sub.events.has(type)) continue;
      if (type === 'cells_changed' && sub.filter.sheet) {
        const refs = (event as { refs?: CellRef[] }).refs ?? [];
        if (!refs.some((r) => r.sheet === sub.filter.sheet)) continue;
      }
      sub.buffer.push({
        seq: this.eventSeq++,
        ts: Date.now(),
        type,
        detail,
      });
      while (sub.buffer.length > MAX_BUFFERED_EVENTS) sub.buffer.shift();
    }
  }
}
