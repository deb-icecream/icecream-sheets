/**
 * Save / autosave interlock with in-flight routed edits (Cycle 10 closure).
 *
 * THE GAP: App's autosave effect (and every manual-save path) was gated
 * on `workbookLoaded` / `readOnly` / `saveState` only. Local-route calc
 * is synchronous, so a timer cannot interleave mid-calc — safe by
 * construction. But a SERVER-routed edit is async: between the optimistic
 * display and the server's ack, the workbook holds provisional /
 * pre-edit state, and a save firing in that window would serialize the
 * WRONG state (and, worse, clear the dirty flag on top of it).
 *
 * THE INTERLOCK: while any routed edit is in flight (or its recalc /
 * ack processing is still pending), saves DEFER — they wait for the
 * edit to settle and then serialize the post-edit state. The dirty flag
 * is never touched by the deferral, so a deferred save is never dropped
 * and never marked clean early: the save simply happens a beat later,
 * with the settled state.
 *
 * SOURCE OF TRUTH for "in flight" (consumed, not re-invented):
 *  - Cell routed edits: `OptimisticEditSession` in routedEdit.ts — an op
 *    is pending from `begin()` (optimistic display) until `confirm()` /
 *    `reject()` (ack settled). The session now exposes `pendingCount`,
 *    `subscribePending()` and `whenSettled()` for exactly this.
 *  - Host-level executes: `RemoteEngineHost` (gateway) and
 *    `IpcEngineHost` (desktop) wrap EVERY execute — including structural
 *    and other non-cell commands, which never enter the session — in an
 *    `EditInFlightTracker` (below). Their `hasInFlightEdits()` is the
 *    union of the tracker and (gateway) the session, so the tail of ack
 *    processing after the session confirms is covered too.
 *  - The plain local `EngineHost` is synchronous: no edit is ever in
 *    flight across a tick, so it needs (and has) no signal — the duck-
 *    typed lookup below returns null for it and waits are no-ops.
 *
 * This module is deliberately host-agnostic: it duck-types the two
 * methods above so App.tsx never imports host classes just to ask
 * "may I save yet?", and unit tests can drive it with a plain tracker.
 */

/** The minimal in-flight signal a save path needs from a host. */
export interface EditFlightSource {
  /** True while any routed edit / recalc for this host is unsettled. */
  hasInFlightEdits(): boolean;
  /** Resolves once no edit is in flight (immediately when already idle). */
  whenEditsSettle(): Promise<void>;
}

/**
 * A counting in-flight tracker with settle waiters + change listeners.
 * Hosts wrap each execute with `track()` (or a `beginEdit()` handle);
 * save paths consult `hasInFlightEdits()` / `whenEditsSettle()`.
 * Begin handles are idempotent: ending twice never underflows.
 */
export class EditInFlightTracker implements EditFlightSource {
  private count = 0;
  private readonly listeners = new Set<() => void>();
  private waiters: Array<() => void> = [];

  get pendingCount(): number {
    return this.count;
  }

  hasInFlightEdits(): boolean {
    return this.count > 0;
  }

  /** Mark one edit in flight; returns its (idempotent) end handle. */
  beginEdit(): () => void {
    this.count++;
    this.notify();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.count = Math.max(0, this.count - 1);
      this.notify();
    };
  }

  /** Run async work as one in-flight edit (settles on resolve OR reject). */
  async track<T>(work: () => Promise<T>): Promise<T> {
    const end = this.beginEdit();
    try {
      return await work();
    } finally {
      end();
    }
  }

  /** Notify `listener` whenever the in-flight count changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  whenEditsSettle(): Promise<void> {
    if (this.count === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notify(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // A failing listener must not break edit execution.
      }
    }
    if (this.count === 0 && this.waiters.length > 0) {
      const ready = this.waiters;
      this.waiters = [];
      for (const resolve of ready) resolve();
    }
  }
}

/**
 * The in-flight source for a host, or null when the host has no async
 * edit path (the synchronous local EngineHost). Duck-typed on purpose:
 * any host exposing the two methods is a source.
 */
export function editFlightSourceOf(host: unknown): EditFlightSource | null {
  if (host !== null && typeof host === 'object') {
    const h = host as Partial<EditFlightSource>;
    if (typeof h.hasInFlightEdits === 'function' && typeof h.whenEditsSettle === 'function') {
      return h as EditFlightSource;
    }
  }
  return null;
}

/** Sync check used by save paths (false for hosts with no async edits). */
export function hasInFlightEdits(host: unknown): boolean {
  return editFlightSourceOf(host)?.hasInFlightEdits() ?? false;
}

/**
 * Wait until the host has no routed edit in flight. Loops because a new
 * edit can begin while a previous batch settles (the user kept typing):
 * the save must not slip into the gap between two edits — it waits for
 * a genuinely idle moment, then the caller serializes that state.
 */
export async function waitForEditsToSettle(host: unknown): Promise<void> {
  const source = editFlightSourceOf(host);
  if (!source) return;
  while (source.hasInFlightEdits()) {
    await source.whenEditsSettle();
  }
}

/**
 * Serialize only after every in-flight edit settles — the deferred-save
 * primitive both the autosave timer and the manual-save handlers ride.
 * `serialize` runs exactly once, after settle, so it always sees the
 * post-edit (server-confirmed / rolled-back) state, never the
 * provisional in-flight state.
 */
export async function serializeWhenSettled<T>(
  host: unknown,
  serialize: () => T | Promise<T>,
): Promise<T> {
  await waitForEditsToSettle(host);
  return serialize();
}
