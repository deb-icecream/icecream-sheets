/**
 * Collaboration bridge (track 10): wires the engine's CollabSession into
 * the web app's engine host.
 *
 * Every local cell edit flows through the OT pipeline: the edit becomes a
 * CollabOp, is rebased against concurrent ops via transform(), appended to
 * the session's revision log (change tracking: who changed what, when),
 * and only then executed against the engine host. Presence heartbeats
 * advertise the local user's sheet + selection.
 *
 * Phase 2: the multi-client transport EXISTS (services/collabTransport
 * .ts) — local ops broadcast out through it (POST /ops), remote deltas
 * feed ingestRemoteDelta() so the revision log + changes UI stay live,
 * and presence flows both ways (heartbeatSelf sends via the transport;
 * setRemoteParticipants receives). applyRemote() remains the direct
 * receive path for op-shaped deliveries.
 */
import {
  CollabSession,
  ops,
  type CellRef,
  type ChangeRecord,
  type CollabOp,
  type CommandResult,
  type EngineHost,
  type Presence,
} from '@icecream-sheets/engine';
import type { CellInput } from '@icecream-sheets/engine';

const PRESENCE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];

export interface CollabBridgeOptions {
  /** Stable id for this client (op ids are `${clientId}:${seq}`). */
  clientId: string;
  /** Display name shown in presence + the revision log. */
  principal: string;
  /**
   * Phase 2 transport hook: every LOCAL op the bridge applies is
   * broadcast here (the collab transport submits it via POST /ops).
   * Settable later via setBroadcastHandler (the transport is created
   * after the bridge in the app's wiring order).
   */
  onBroadcast?: (op: CollabOp, record: ChangeRecord) => void;
}

export class CollabBridge {
  private session: CollabSession;
  private host: EngineHost | null = null;
  private notify: () => void = () => {};
  private readonly clientId: string;
  private readonly principal: string;
  readonly color: string;
  /** Phase 2: local ops go out through this handler (transport submit). */
  private broadcastHandler: ((op: CollabOp, record: ChangeRecord) => void) | null = null;
  /** Phase 2: self presence goes OUT through this handler (POST /presence). */
  private presenceSendHandler: ((sheet: string, row: number, col: number) => void) | null = null;
  /** Phase 2: remote participants fed by the transport's presence events. */
  private remoteParticipants = new Map<string, Presence>();
  /** Display names carried on presence payloads, by principal (#8 residual). */
  private participantNames = new Map<string, string>();
  /**
   * The local user's last advertised presence (issue #56). The engine
   * session prunes presence after a 30 s heartbeat TTL — right for
   * REMOTE peers, wrong for self: this client IS the liveness source
   * for its own entry, and an idle user is still present. The bridge
   * remembers the last self heartbeat and collaborators() re-includes
   * it when the session has pruned it, so the roster label never
   * flickers between e.g. 'Guest (You)' and the empty-roster fallback.
   */
  private lastSelfPresence: Presence | null = null;
  /** Live provider for the LOCAL user's display name (#8 residual). */
  private selfDisplayNameProvider: (() => string | null | undefined) | null = null;
  /** True while ingesting a remote delta into the log (no re-broadcast). */
  private ingesting = false;

  constructor(opts: CollabBridgeOptions) {
    this.clientId = opts.clientId;
    this.principal = opts.principal;
    this.broadcastHandler = opts.onBroadcast ?? null;
    // Deterministic color per principal (stable across reloads).
    let h = 0;
    for (const ch of opts.principal) h = (h * 31 + ch.charCodeAt(0)) | 0;
    this.color = PRESENCE_COLORS[Math.abs(h) % PRESENCE_COLORS.length];
    this.session = this.makeSession();
  }

  private makeSession(): CollabSession {
    return new CollabSession({
      onBroadcast: (op, record) => {
        if (this.ingesting) return; // remote deltas are logged, never re-sent
        this.broadcastHandler?.(op, record);
      },
    });
  }

  /** Wire the transport's broadcast submit (Phase 2). */
  setBroadcastHandler(handler: ((op: CollabOp, record: ChangeRecord) => void) | null): void {
    this.broadcastHandler = handler;
  }

  /** Wire the transport's presence send (self heartbeat goes OUT via it). */
  setPresenceSendHandler(handler: ((sheet: string, row: number, col: number) => void) | null): void {
    this.presenceSendHandler = handler;
  }

  /** This client's stable id (the transport's persisted clientId). */
  get id(): string {
    return this.clientId;
  }

  /** Attach to the active engine host (call again after file open). */
  attach(host: EngineHost, notify: () => void): void {
    // A new document gets a fresh revision log; presence carries over.
    const presence = this.session.collaborators();
    this.session = this.makeSession();
    for (const p of presence) this.session.heartbeat(p);
    this.host = host;
    this.notify = notify;
    this.heartbeatSelf('Sheet1', 0, 0);
  }

  detach(): void {
    this.host = null;
  }

  private requireHost(): EngineHost {
    if (!this.host) throw new Error('CollabBridge: no host attached');
    return this.host;
  }

  /**
   * Apply a cell-value edit through the OT pipeline, then execute it.
   * Returns the engine command result (authorization still applies).
   */
  applySetCell(ref: CellRef, value: CellInput): CommandResult {
    const host = this.requireHost();
    const op = ops.setCell(this.clientId, this.session.revision(), ref.sheet, ref.row, ref.col, value);
    const applied = this.session.applyLocal(op, this.principal);
    if (!applied) return { ok: false, error: 'Edit made obsolete by a concurrent change' };
    const res = host.execute({ cmd: 'setCell', ref, value });
    this.notify();
    return res;
  }

  /** Apply a formula edit through the OT pipeline, then execute it. */
  applySetFormula(ref: CellRef, formula: string): CommandResult {
    const host = this.requireHost();
    const op = ops.setCell(this.clientId, this.session.revision(), ref.sheet, ref.row, ref.col, formula);
    const applied = this.session.applyLocal(op, this.principal);
    if (!applied) return { ok: false, error: 'Edit made obsolete by a concurrent change' };
    const res = host.execute({ cmd: 'setFormula', ref, formula });
    this.notify();
    return res;
  }

  /**
   * Apply an op received from a remote peer: rebase against local ops,
   * append to the log, and execute the rebased op. This is the real
   * receive path — it just has no transport feeding it yet (v2).
   */
  applyRemote(op: CollabOp, principal: string): CollabOp | null {
    const host = this.requireHost();
    const applied = this.session.applyRemote(op, principal);
    if (applied) {
      executeOp(host, applied);
      this.notify();
    }
    return applied;
  }

  /**
   * Phase 2 receive path: record a server delta's op in the revision
   * log WITHOUT executing it on the host (the transport already applied
   * the delta's cells to the host's confirmed layer) and WITHOUT
   * re-broadcasting it. Keeps the changes UI's log fed from server
   * deltas, in server revision order.
   */
  ingestRemoteDelta(op: CollabOp, principal: string): CollabOp | null {
    this.ingesting = true;
    try {
      const applied = this.session.applyRemote(op, principal);
      if (applied) this.notify();
      return applied;
    } finally {
      this.ingesting = false;
    }
  }

  /**
   * Phase 2 presence receive: replace the remote-participant set with
   * the transport's latest presence event (self excluded — the local
   * session heartbeat owns self).
   */
  /** Register the local user's display-name provider (read live in collaborators()). */
  setSelfDisplayNameProvider(fn: (() => string | null | undefined) | null): void {
    this.selfDisplayNameProvider = fn;
  }

  setRemoteParticipants(
    participants: Array<{
      principal: string;
      /** Display name from the presence payload (absent on older engines). */
      name?: string;
      color: string;
      sheet: string;
      row: number;
      col: number;
    }>,
  ): void {
    this.remoteParticipants.clear();
    for (const p of participants) {
      // #8 residual: keep the payload's display name — the roster must
      // render names, never raw principals.
      if (p.name) this.participantNames.set(p.principal, p.name);
      if (p.principal === this.principal) continue;
      this.remoteParticipants.set(p.principal, {
        principal: p.principal,
        color: p.color,
        sheet: p.sheet,
        selection: { row: p.row, col: p.col },
        updatedAt: Date.now(),
      });
    }
    this.notify();
  }

  /** Advertise the local user's cursor/selection. */
  heartbeatSelf(sheet: string, row: number, col: number): void {
    this.lastSelfPresence = {
      principal: this.principal,
      color: this.color,
      sheet,
      selection: { row, col },
      updatedAt: Date.now(),
    };
    this.session.heartbeat({ principal: this.principal, color: this.color, sheet, selection: { row, col } });
    // Phase 2: in gateway mode the heartbeat also goes OUT over the
    // transport (POST /presence) so remote peers see this selection.
    this.presenceSendHandler?.(sheet, row, col);
    this.notify();
  }

  /**
   * Live collaborators, including self (expired heartbeats pruned) and
   * the remote participants fed by the transport's presence events.
   */
  collaborators(): Array<Presence & { name?: string; isSelf?: boolean }> {
    const local = this.session.collaborators();
    // Issue #56: self never expires from the LOCAL roster (see
    // lastSelfPresence) — re-include the last heartbeat when the
    // session's TTL pruning dropped it during an idle stretch.
    if (this.lastSelfPresence && !local.some((p) => p.principal === this.principal)) {
      local.push(this.lastSelfPresence);
    }
    const seen = new Set(local.map((p) => p.principal));
    const merged = [...local];
    for (const p of this.remoteParticipants.values()) {
      if (!seen.has(p.principal)) merged.push(p);
    }
    // #8 residual: stamp display names so roster renderers never fall
    // back to the raw principal. Self's name resolves live from the
    // app's display-name provider (the settings displayName chain).
    return merged.map((p) => {
      const isSelf = p.principal === this.principal;
      const name = isSelf
        ? (this.selfDisplayNameProvider?.() ?? this.participantNames.get(p.principal))
        : this.participantNames.get(p.principal);
      return { ...p, name, isSelf };
    });
  }

  /** Full revision log (who changed what, when). */
  changes(sinceRevision = 0): ChangeRecord[] {
    return this.session.changes(sinceRevision);
  }

  /** Current revision = number of applied ops. */
  revision(): number {
    return this.session.revision();
  }
}

/** Execute a rebased collab op against an engine host. */
function executeOp(host: EngineHost, op: CollabOp): void {
  const p = op.params;
  switch (op.type) {
    case 'cell.set': {
      const ref = { sheet: p['sheet'] as string, row: p['row'] as number, col: p['col'] as number };
      const value = p['value'] as CellInput;
      if (typeof value === 'string' && value.startsWith('=')) {
        host.execute({ cmd: 'setFormula', ref, formula: value });
      } else {
        host.execute({ cmd: 'setCell', ref, value });
      }
      break;
    }
    case 'cell.clear':
      host.execute({
        cmd: 'setCell',
        ref: { sheet: p['sheet'] as string, row: p['row'] as number, col: p['col'] as number },
        value: null,
      });
      break;
    case 'sheet.add':
      host.execute({ cmd: 'addSheet', name: p['name'] as string });
      break;
    default:
      // Row/col insert/delete and sheet delete/rename have no direct
      // engine-protocol command in v1; they are logged (auditable) but not
      // executed. Documented, not silent: the revision log records them.
      break;
  }
}
