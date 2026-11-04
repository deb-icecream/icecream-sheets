/**
 * Collaboration foundation (track 10).
 *
 * v1 scope (per task brief): the DATA STRUCTURES for real-time
 * collaboration. Full real-time sync (transport, conflict UI) is v2.
 *
 * - Operational transform for cell edits: operations carry a revision;
 *   `transform()` rebases a concurrent operation against another so two
 *   clients converging on the same revision log reach the same state.
 * - Presence: collaborators' sheet + selection, with heartbeat expiry.
 * - Change tracking: every applied op is logged with principal + timestamp
 *   (feeds the design's audit requirements and a future "show changes" UI).
 *
 * Operation model: ops are plain JSON (serializable for a future transport).
 * Addressing is by sheet name + row/col (stable across concurrent edits
 * because row/col insert/delete ops shift addresses deterministically).
 */

export type CollabOpType =
  | 'cell.set' // { sheet, row, col, value }
  | 'cell.clear' // { sheet, row, col }
  | 'rows.insert' // { sheet, at, count }
  | 'rows.delete' // { sheet, at, count }
  | 'cols.insert' // { sheet, at, count }
  | 'cols.delete' // { sheet, at, count }
  | 'sheet.add' // { name }
  | 'sheet.delete' // { name }
  | 'sheet.rename'; // { from, to }

export interface CollabOp {
  /** Unique op id (client-generated, e.g. `${clientId}:${seq}`). */
  id: string;
  type: CollabOpType;
  /** Revision this op was based on (log length at authoring time). */
  baseRevision: number;
  params: Record<string, unknown>;
}

export interface ChangeRecord {
  op: CollabOp;
  principal: string;
  at: string;
  /** Revision AFTER applying (1-based). */
  revision: number;
}

export interface Presence {
  principal: string;
  /** Display color for the cursor/selection. */
  color: string;
  sheet: string;
  selection: { row: number; col: number };
  updatedAt: number;
}

const PRESENCE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Operational transform
// ---------------------------------------------------------------------------

/**
 * Shift a row/col index past an insert/delete at `at`.
 * Inserts at <= idx shift idx right; deletes remove [at, at+count).
 */
function shiftIndex(idx: number, at: number, count: number, isInsert: boolean): number | null {
  if (isInsert) {
    return idx >= at ? idx + count : idx;
  }
  if (idx >= at && idx < at + count) return null; // deleted
  return idx >= at + count ? idx - count : idx;
}

function shiftPoint(
  sheet: string,
  row: number,
  col: number,
  op: CollabOp,
): { row: number; col: number } | null {
  const p = op.params;
  switch (op.type) {
    case 'rows.insert':
    case 'rows.delete':
      if (p['sheet'] !== sheet) return { row, col };
      {
        const r = shiftIndex(row, p['at'] as number, p['count'] as number, op.type === 'rows.insert');
        return r === null ? null : { row: r, col };
      }
    case 'cols.insert':
    case 'cols.delete':
      if (p['sheet'] !== sheet) return { row, col };
      {
        const c = shiftIndex(col, p['at'] as number, p['count'] as number, op.type === 'cols.insert');
        return c === null ? null : { row, col: c };
      }
    default:
      return { row, col };
  }
}

/**
 * Transform `op` against an already-applied `against` op.
 * Returns the rebased op, or null when `op` is made obsolete
 * (e.g. it edited a cell in a deleted row).
 *
 * Only structural ops (row/col insert/delete) shift addresses; two
 * cell.set ops on the same cell are last-writer-wins (no transform needed).
 */
export function transform(op: CollabOp, against: CollabOp): CollabOp | null {
  // Sheet renames rewrite the sheet address.
  if (against.type === 'sheet.rename' && op.params['sheet'] === against.params['from']) {
    return { ...op, params: { ...op.params, sheet: against.params['to'] } };
  }
  // Ops on a deleted sheet are obsolete.
  if (against.type === 'sheet.delete' && op.params['sheet'] === against.params['name']) {
    return null;
  }
  const structural: CollabOpType[] = ['rows.insert', 'rows.delete', 'cols.insert', 'cols.delete'];
  if (!structural.includes(against.type)) return op;

  const p = op.params;
  const singlePoint: CollabOpType[] = ['cell.set', 'cell.clear'];
  if (singlePoint.includes(op.type)) {
    const shifted = shiftPoint(
      p['sheet'] as string,
      p['row'] as number,
      p['col'] as number,
      against,
    );
    if (!shifted) return null;
    return { ...op, params: { ...p, row: shifted.row, col: shifted.col } };
  }
  // Structural vs structural: shift the `at` index.
  if (structural.includes(op.type) && p['sheet'] === against.params['sheet']) {
    if (
      (op.type === 'rows.insert' || op.type === 'rows.delete') &&
      (against.type === 'rows.insert' || against.type === 'rows.delete')
    ) {
      const at = shiftIndex(
        p['at'] as number,
        against.params['at'] as number,
        against.params['count'] as number,
        against.type === 'rows.insert',
      );
      if (at === null) return null;
      return { ...op, params: { ...p, at } };
    }
    if (
      (op.type === 'cols.insert' || op.type === 'cols.delete') &&
      (against.type === 'cols.insert' || against.type === 'cols.delete')
    ) {
      const at = shiftIndex(
        p['at'] as number,
        against.params['at'] as number,
        against.params['count'] as number,
        against.type === 'cols.insert',
      );
      if (at === null) return null;
      return { ...op, params: { ...p, at } };
    }
  }
  return op;
}

// ---------------------------------------------------------------------------
// CollabSession: revision log + presence + change tracking
// ---------------------------------------------------------------------------

export interface CollabSessionOptions {
  /** Called when a remote op should be sent to peers (v2 transport hook). */
  onBroadcast?: (op: CollabOp, record: ChangeRecord) => void;
}

export class CollabSession {
  private log: ChangeRecord[] = [];
  private presence = new Map<string, Presence>();
  private opts: CollabSessionOptions;

  constructor(opts: CollabSessionOptions = {}) {
    this.opts = opts;
  }

  /** Current revision = number of applied ops. */
  revision(): number {
    return this.log.length;
  }

  /**
   * Apply a local op: rebase against any ops since op.baseRevision, append
   * to the log, and broadcast. Returns the rebased op (null if obsolete).
   */
  applyLocal(op: CollabOp, principal: string): CollabOp | null {
    let rebased: CollabOp | null = { ...op };
    for (let i = op.baseRevision; i < this.log.length && rebased; i++) {
      rebased = transform(rebased, this.log[i].op);
    }
    if (!rebased) return null;
    const record: ChangeRecord = {
      op: rebased,
      principal,
      at: new Date().toISOString(),
      revision: this.log.length + 1,
    };
    this.log.push(record);
    this.opts.onBroadcast?.(rebased, record);
    return rebased;
  }

  /**
   * Apply a remote op received from a peer. The op's baseRevision refers to
   * the sender's log; we rebase against our ops since then. (A v2 transport
   * would use vector clocks; v1 assumes a shared linear log via the host.)
   */
  applyRemote(op: CollabOp, principal: string): CollabOp | null {
    return this.applyLocal({ ...op }, principal);
  }

  /** Full change history (who changed what, when). */
  changes(sinceRevision = 0): ChangeRecord[] {
    return this.log.filter((r) => r.revision > sinceRevision);
  }

  /** Changes by one principal. */
  changesBy(principal: string): ChangeRecord[] {
    return this.log.filter((r) => r.principal === principal);
  }

  // -- Presence --------------------------------------------------------------

  /** Heartbeat: upsert a collaborator's cursor/selection. */
  heartbeat(p: Omit<Presence, 'updatedAt'>): void {
    this.presence.set(p.principal, { ...p, updatedAt: Date.now() });
  }

  /** Remove a collaborator (on disconnect). */
  leave(principal: string): void {
    this.presence.delete(principal);
  }

  /** Live collaborators (expired heartbeats pruned). */
  collaborators(now = Date.now()): Presence[] {
    for (const [key, p] of this.presence) {
      if (now - p.updatedAt > PRESENCE_TTL_MS) this.presence.delete(key);
    }
    return [...this.presence.values()];
  }

  /** Serialize the session for persistence / handoff. */
  snapshot(): { log: ChangeRecord[]; presence: Presence[] } {
    return { log: [...this.log], presence: this.collaborators() };
  }
}

// ---------------------------------------------------------------------------
// Op constructors (convenience)
// ---------------------------------------------------------------------------

let opSeq = 0;

function makeOp(clientId: string, type: CollabOpType, baseRevision: number, params: Record<string, unknown>): CollabOp {
  return { id: `${clientId}:${opSeq++}`, type, baseRevision, params };
}

export const ops = {
  setCell: (clientId: string, baseRevision: number, sheet: string, row: number, col: number, value: unknown): CollabOp =>
    makeOp(clientId, 'cell.set', baseRevision, { sheet, row, col, value }),
  clearCell: (clientId: string, baseRevision: number, sheet: string, row: number, col: number): CollabOp =>
    makeOp(clientId, 'cell.clear', baseRevision, { sheet, row, col }),
  insertRows: (clientId: string, baseRevision: number, sheet: string, at: number, count: number): CollabOp =>
    makeOp(clientId, 'rows.insert', baseRevision, { sheet, at, count }),
  deleteRows: (clientId: string, baseRevision: number, sheet: string, at: number, count: number): CollabOp =>
    makeOp(clientId, 'rows.delete', baseRevision, { sheet, at, count }),
  insertCols: (clientId: string, baseRevision: number, sheet: string, at: number, count: number): CollabOp =>
    makeOp(clientId, 'cols.insert', baseRevision, { sheet, at, count }),
  deleteCols: (clientId: string, baseRevision: number, sheet: string, at: number, count: number): CollabOp =>
    makeOp(clientId, 'cols.delete', baseRevision, { sheet, at, count }),
  addSheet: (clientId: string, baseRevision: number, name: string): CollabOp =>
    makeOp(clientId, 'sheet.add', baseRevision, { name }),
  deleteSheet: (clientId: string, baseRevision: number, name: string): CollabOp =>
    makeOp(clientId, 'sheet.delete', baseRevision, { name }),
  renameSheet: (clientId: string, baseRevision: number, from: string, to: string): CollabOp =>
    makeOp(clientId, 'sheet.rename', baseRevision, { from, to }),
};
