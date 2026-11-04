/**
 * Collaboration server (service layer): the server-sequenced real-time path.
 *
 * The engine (`@icecream-sheets/engine` collaboration.ts) provides the OT
 * substrate: `CollabOp` addressing, `transform()` rebasing, and the
 * client-side `CollabSession`. This module wires the *service* path the
 * TODO called out as missing: a server that sequences operations from
 * multiple clients into one authoritative, totally-ordered operation log.
 *
 * Model (server-authoritative, no optimistic concurrency):
 * - Clients submit ops with `baseRevision` = the server revision the op was
 *   authored against. The server rebases the op against every log entry
 *   since that revision using the engine's OT `transform()`, assigns the
 *   next server sequence number, appends it to the authoritative log, and
 *   broadcasts it. Clients apply sequenced ops in order (the engine's
 *   `CollabSession.applyRemote`); `opsSince` / `opsSinceClock` cover
 *   catch-up after a missed broadcast.
 * - The sequenced op's `baseRevision` is rewritten to the server revision
 *   at sequencing time, so recipients never re-transform against ops the
 *   server already rebased against.
 * - Vector clocks: each record carries the submitter's clock
 *   (`clock[author]` = number of that author's ops the submitter had seen)
 *   plus `authorSeq` (the op's index within its author's ops). Clients sync
 *   with `opsSinceClock`, which returns exactly the ops their clock does
 *   not dominate. `concurrentWith` lists the server seqs the op was
 *   concurrent with (transformed against) — the audit trail for conflicts.
 *
 * Conflict resolution (documented, deterministic):
 * - Structural vs point ops (row/col insert/delete vs cell edits): OT
 *   address rebasing via the engine's `transform()` — both orders converge.
 * - Concurrent `cell.set` on the same cell: last-writer-wins by server
 *   sequence. The losing op stays in the log (audit) and is flagged via
 *   `concurrentWith`; use `findConflicts()` to surface them.
 * - Ops made obsolete by a concurrent structural op (edit in a deleted
 *   row/sheet): rejected at submit with reason `obsolete` — the client
 *   refreshes from the log and retries against the new revision.
 *
 * Transport is deliberately out of scope: the server emits sequenced ops
 * through `onBroadcast(docId, record)` and hosts deliver them (WebSocket,
 * MCP stream, in-process call). Presence heartbeats are relayed the same
 * way.
 */

import {
  transform,
  type CollabOp,
  type CollabOpType,
  type Presence,
} from '@icecream-sheets/engine';

/** Vector clock: author clientId -> number of that author's ops seen. */
export type VectorClock = Record<string, number>;

/** One sequenced entry in the authoritative log. */
export interface ServerOp {
  /** The op as sequenced (rebased; baseRevision = server revision at sequencing). */
  op: CollabOp;
  principal: string;
  clientId: string;
  /** 1-based position in the authoritative log (the total order). */
  serverSeq: number;
  /** The op's index within its author's submitted ops (1-based). */
  authorSeq: number;
  serverTime: string;
  /** Server seqs this op was concurrent with (transformed against). */
  concurrentWith: number[];
  /** The submitter's vector clock at submit time. */
  clock: VectorClock;
}

export type SubmitRejectionReason =
  | 'unknown-document'
  | 'unknown-client'
  | 'invalid-op'
  | 'stale-base'
  | 'obsolete';

export type SubmitResult =
  | { ok: true; record: ServerOp }
  | { ok: false; reason: SubmitRejectionReason; message: string };

export interface CollabServerOptions {
  /** Called for every sequenced op; the host delivers it to clients. */
  onBroadcast?: (docId: string, record: ServerOp) => void;
  /** Max ops retained per document log (0 = unbounded). Defaults to 0. */
  historyLimit?: number;
}

const KNOWN_OPS: ReadonlySet<string> = new Set<string>([
  'cell.set',
  'cell.clear',
  'rows.insert',
  'rows.delete',
  'cols.insert',
  'cols.delete',
  'sheet.add',
  'sheet.delete',
  'sheet.rename',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateOp(op: CollabOp): string | null {
  if (!isRecord(op)) return 'op must be an object';
  if (typeof op['id'] !== 'string' || op['id'].length === 0) return 'op.id is required';
  if (!KNOWN_OPS.has(op['type'] as string)) return `unknown op type "${String(op['type'])}"`;
  if (!Number.isInteger(op['baseRevision']) || (op['baseRevision'] as number) < 0) {
    return 'op.baseRevision must be a non-negative integer';
  }
  if (!isRecord(op['params'])) return 'op.params must be an object';
  return null;
}

function mergeClock(base: VectorClock, extra?: VectorClock): VectorClock {
  const out: VectorClock = { ...base };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) out[k] = Math.max(out[k] ?? 0, v);
  }
  return out;
}

/** True when `a` dominates `b` (a has seen everything b has seen). */
export function clockDominates(a: VectorClock, b: VectorClock): boolean {
  for (const [k, v] of Object.entries(b)) {
    if ((a[k] ?? 0) < v) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// ServerDocument — one authoritative log
// ---------------------------------------------------------------------------

export interface DocumentStats {
  docId: string;
  revision: number;
  clients: number;
  opsByClient: Record<string, number>;
}

export class ServerDocument {
  readonly docId: string;
  private log: ServerOp[] = [];
  private clients = new Map<string, { principal: string; clock: VectorClock }>();
  private presence = new Map<string, Presence>();
  private authorCounts = new Map<string, number>();
  private historyLimit: number;

  constructor(docId: string, historyLimit = 0) {
    this.docId = docId;
    this.historyLimit = historyLimit;
  }

  /** Current revision = number of sequenced ops. */
  revision(): number {
    return this.log.length;
  }

  /** Register a client (idempotent). Returns the current revision + clock. */
  join(clientId: string, principal: string): { revision: number; clock: VectorClock } {
    let c = this.clients.get(clientId);
    if (!c) {
      c = { principal, clock: {} };
      this.clients.set(clientId, c);
    }
    return { revision: this.log.length, clock: { ...c.clock } };
  }

  leave(clientId: string): void {
    this.clients.delete(clientId);
    this.presence.delete(clientId);
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  principalOf(clientId: string): string | undefined {
    return this.clients.get(clientId)?.principal;
  }

  /**
   * Sequence one client op: validate, rebase against the log suffix since
   * op.baseRevision (recording concurrency), append, advance clocks.
   */
  submit(clientId: string, op: CollabOp, clientClock?: VectorClock): SubmitResult {
    const client = this.clients.get(clientId);
    if (!client) {
      return { ok: false, reason: 'unknown-client', message: `client "${clientId}" has not joined "${this.docId}"` };
    }
    const invalid = validateOp(op);
    if (invalid) return { ok: false, reason: 'invalid-op', message: invalid };
    if (op.baseRevision > this.log.length) {
      return {
        ok: false,
        reason: 'stale-base',
        message: `op.baseRevision ${op.baseRevision} is ahead of server revision ${this.log.length}`,
      };
    }

    let rebased: CollabOp | null = { ...op, params: { ...op.params } };
    const concurrentWith: number[] = [];
    for (let i = op.baseRevision; i < this.log.length && rebased; i++) {
      concurrentWith.push(this.log[i].serverSeq);
      rebased = transform(rebased, this.log[i].op);
    }
    if (!rebased) {
      return {
        ok: false,
        reason: 'obsolete',
        message: `op ${op.id} was made obsolete by a concurrent structural op; refresh and retry`,
      };
    }

    // The sequenced op is now based on the full log — recipients must not
    // re-transform it against entries the server already handled.
    rebased = { ...rebased, baseRevision: this.log.length };

    const authorSeq = (this.authorCounts.get(clientId) ?? 0) + 1;
    this.authorCounts.set(clientId, authorSeq);

    // Vector clock: for each author D, the submitter has seen the D-ops in
    // the log prefix it based this op on; plus this op for its own author.
    const clock: VectorClock = {};
    for (let i = 0; i < op.baseRevision; i++) {
      const author = this.log[i].clientId;
      clock[author] = (clock[author] ?? 0) + 1;
    }
    clock[clientId] = authorSeq;
    const merged = mergeClock(client.clock, mergeClock(clock, clientClock));
    client.clock = merged;

    const record: ServerOp = {
      op: rebased,
      principal: client.principal,
      clientId,
      serverSeq: this.log.length + 1,
      authorSeq,
      serverTime: new Date().toISOString(),
      concurrentWith,
      clock: { ...merged },
    };
    this.log.push(record);
    if (this.historyLimit > 0 && this.log.length > this.historyLimit) {
      this.log.splice(0, this.log.length - this.historyLimit);
      // NOTE: trimming rewrites serverSeq contiguity; only enable with
      // clients that resync via snapshot (documented limitation).
    }
    return { ok: true, record };
  }

  /** Log entries after `revision` (exclusive), in sequence order. */
  opsSince(revision: number): ServerOp[] {
    return this.log.filter((r) => r.serverSeq > revision);
  }

  /**
   * Entries the given vector clock has not seen: an entry counts as seen
   * when the clock dominates its author's count at that entry.
   */
  opsSinceClock(clock: VectorClock): ServerOp[] {
    return this.log.filter((r) => (clock[r.clientId] ?? 0) < r.authorSeq);
  }

  /** Full authoritative log (oldest first). */
  history(): ServerOp[] {
    return [...this.log];
  }

  /** Ops by one author, in sequence order. */
  byAuthor(clientId: string): ServerOp[] {
    return this.log.filter((r) => r.clientId === clientId);
  }

  /**
   * Conflict report: pairs of concurrent ops that wrote the same cell
   * (last-writer-wins by serverSeq; the earlier seq lost).
   */
  findConflicts(): { winner: ServerOp; loser: ServerOp; cell: string }[] {
    const out: { winner: ServerOp; loser: ServerOp; cell: string }[] = [];
    const bySeq = new Map(this.log.map((r) => [r.serverSeq, r]));
    for (const r of this.log) {
      if (r.op.type !== 'cell.set' && r.op.type !== 'cell.clear') continue;
      const cell = `${String(r.op.params['sheet'])}!${String(r.op.params['row'])}:${String(r.op.params['col'])}`;
      for (const seq of r.concurrentWith) {
        const other = bySeq.get(seq);
        if (!other) continue;
        if (other.op.type !== 'cell.set' && other.op.type !== 'cell.clear') continue;
        const otherCell = `${String(other.op.params['sheet'])}!${String(other.op.params['row'])}:${String(other.op.params['col'])}`;
        if (otherCell === cell && other.serverSeq < r.serverSeq) {
          out.push({ winner: r, loser: other, cell });
        }
      }
    }
    return out;
  }

  /** This client's current vector clock. */
  clockOf(clientId: string): VectorClock | undefined {
    const c = this.clients.get(clientId);
    return c ? { ...c.clock } : undefined;
  }

  /** Merged clock over all joined clients (what the *room* has seen). */
  roomClock(): VectorClock {
    let merged: VectorClock = {};
    for (const c of this.clients.values()) merged = mergeClock(merged, c.clock);
    return merged;
  }

  stats(): DocumentStats {
    const opsByClient: Record<string, number> = {};
    for (const [id, n] of this.authorCounts) opsByClient[id] = n;
    return { docId: this.docId, revision: this.log.length, clients: this.clients.size, opsByClient };
  }

  // -- Presence ---------------------------------------------------------------

  heartbeat(p: Omit<Presence, 'updatedAt'>): void {
    this.presence.set(p.principal, { ...p, updatedAt: Date.now() });
  }

  collaborators(now = Date.now(), ttlMs = 30_000): Presence[] {
    for (const [k, p] of this.presence) {
      if (now - p.updatedAt > ttlMs) this.presence.delete(k);
    }
    return [...this.presence.values()];
  }

  // -- Persistence --------------------------------------------------------------

  snapshot(): { docId: string; log: ServerOp[]; clocks: Record<string, VectorClock> } {
    const clocks: Record<string, VectorClock> = {};
    for (const [id, c] of this.clients) clocks[id] = { ...c.clock };
    return { docId: this.docId, log: [...this.log], clocks };
  }
}

// ---------------------------------------------------------------------------
// CollabServer — multi-document sequencing
// ---------------------------------------------------------------------------

export class CollabServer {
  private docs = new Map<string, ServerDocument>();
  private opts: CollabServerOptions;

  constructor(opts: CollabServerOptions = {}) {
    this.opts = opts;
  }

  /** Create (or return) the authoritative log for a document. */
  createDocument(docId: string): ServerDocument {
    let d = this.docs.get(docId);
    if (!d) {
      d = new ServerDocument(docId, this.opts.historyLimit ?? 0);
      this.docs.set(docId, d);
    }
    return d;
  }

  getDocument(docId: string): ServerDocument | undefined {
    return this.docs.get(docId);
  }

  documentIds(): string[] {
    return [...this.docs.keys()];
  }

  dropDocument(docId: string): boolean {
    return this.docs.delete(docId);
  }

  join(docId: string, clientId: string, principal: string): { revision: number; clock: VectorClock } {
    return this.createDocument(docId).join(clientId, principal);
  }

  leave(docId: string, clientId: string): void {
    this.docs.get(docId)?.leave(clientId);
  }

  /** Sequence one op; broadcasts the sequenced record on success. */
  submit(docId: string, clientId: string, op: CollabOp, clientClock?: VectorClock): SubmitResult {
    const doc = this.docs.get(docId);
    if (!doc) {
      return { ok: false, reason: 'unknown-document', message: `unknown document "${docId}"` };
    }
    const res = doc.submit(clientId, op, clientClock);
    if (res.ok) this.opts.onBroadcast?.(docId, res.record);
    return res;
  }

  opsSince(docId: string, revision: number): ServerOp[] {
    return this.docs.get(docId)?.opsSince(revision) ?? [];
  }

  opsSinceClock(docId: string, clock: VectorClock): ServerOp[] {
    return this.docs.get(docId)?.opsSinceClock(clock) ?? [];
  }

  heartbeat(docId: string, p: Omit<Presence, 'updatedAt'>): void {
    this.createDocument(docId).heartbeat(p);
  }

  collaborators(docId: string, now?: number): Presence[] {
    return this.docs.get(docId)?.collaborators(now) ?? [];
  }
}

export type { CollabOp, CollabOpType, Presence };
