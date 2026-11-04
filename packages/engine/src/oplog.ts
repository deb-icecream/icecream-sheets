/**
 * Offline operation log (op log) with replay and conflict detection.
 *
 * Complements collaboration.ts (real-time OT): the OpLog is the
 * durability story for offline edits. While the client is offline,
 * every mutation is appended here. On reconnect the queued ops can be
 * replayed into a fresh engine (or flushed to a peer), and
 * detectConflicts() finds ops that touched the same cell on both sides
 * of a partition so the UI can offer keep-mine / keep-theirs / keep-both.
 *
 * Ops are plain JSON: seq is the log-local monotonic sequence number,
 * ts is a wall-clock timestamp, principal identifies the author.
 */

export type OpKind =
  | 'setCell'
  | 'clearCell'
  | 'setFormula'
  | 'insertRow'
  | 'deleteRow'
  | 'insertCol'
  | 'deleteCol'
  | 'addSheet'
  | 'deleteSheet'
  | 'renameSheet'
  | 'duplicateSheet'
  | 'moveSheet';

export interface Op {
  /** Monotonic sequence within the owning log (assigned by OpLog.append). */
  seq: number;
  /** Wall-clock timestamp (ms since epoch) when the op was recorded. */
  ts: number;
  /** Who made the change (e.g. 'user', 'mcp:client'). */
  principal: string;
  kind: OpKind;
  /** Kind-specific address + value:
   *  setCell/clearCell/setFormula: { sheet, row, col, value?, formula? }
   *  insertRow/deleteRow/insertCol/deleteCol: { sheet, at, count }
   *  addSheet/deleteSheet: { name }
   *  renameSheet: { from, to }
   *  duplicateSheet: { name, newName }
   *  moveSheet: { name, toIndex }
   */
  payload: Record<string, unknown>;
}

export type OpInput = Omit<Op, 'seq' | 'ts'> & { ts?: number };

/** Apply one op to a target engine/view. */
export type OpApplier = (op: Op) => void;

function isOp(o: unknown): o is Op {
  if (typeof o !== 'object' || o === null) return false;
  const x = o as Record<string, unknown>;
  return (
    typeof x['seq'] === 'number' &&
    typeof x['ts'] === 'number' &&
    typeof x['principal'] === 'string' &&
    typeof x['kind'] === 'string' &&
    typeof x['payload'] === 'object' &&
    x['payload'] !== null
  );
}

export class OpLog {
  private ops: Op[] = [];
  private nextSeq: number;

  constructor(startSeq = 1) {
    this.nextSeq = startSeq;
  }

  /** Append an op; assigns seq (and ts when omitted). Returns the recorded op. */
  append(input: OpInput): Op {
    const op: Op = {
      seq: this.nextSeq++,
      ts: input.ts ?? Date.now(),
      principal: input.principal,
      kind: input.kind,
      payload: { ...input.payload },
    };
    this.ops.push(op);
    return op;
  }

  /** All recorded ops in seq order. */
  all(): Op[] {
    return [...this.ops];
  }

  /** Ops with seq greater than `since` (the "pending" set). */
  since(sinceSeq: number): Op[] {
    return this.ops.filter((o) => o.seq > sinceSeq);
  }

  get length(): number {
    return this.ops.length;
  }

  /** Last assigned sequence number (0 when empty). */
  lastSeq(): number {
    return this.nextSeq - 1;
  }

  clear(): void {
    this.ops = [];
  }

  /** JSON serialization (for localStorage / transport). */
  serialize(): string {
    return JSON.stringify({ version: 1, nextSeq: this.nextSeq, ops: this.ops });
  }

  /** Deserialize; corrupt payloads yield an empty log (never throw). */
  static deserialize(json: string): OpLog {
    const log = new OpLog();
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return log;
    }
    if (typeof parsed !== 'object' || parsed === null) return log;
    const p = parsed as Record<string, unknown>;
    if (!Array.isArray(p['ops'])) return log;
    const ops = (p['ops'] as unknown[]).filter(isOp).sort((a, b) => a.seq - b.seq);
    log.ops = ops;
    const nextSeq = typeof p['nextSeq'] === 'number' ? p['nextSeq'] : 1;
    log.nextSeq = Math.max(nextSeq, ops.length === 0 ? 1 : ops[ops.length - 1].seq + 1);
    return log;
  }

  /**
   * Replay ops into an applier in seq order. Deduplicates by seq within
   * the batch and skips any seq already present in `appliedSeqs`, so
   * replaying the same log twice is a no-op (idempotent).
   */
  replayInto(applier: OpApplier, appliedSeqs: Set<number> = new Set()): { applied: number; skipped: number } {
    let applied = 0;
    let skipped = 0;
    const seen = new Set<number>();
    for (const op of [...this.ops].sort((a, b) => a.seq - b.seq)) {
      if (seen.has(op.seq) || appliedSeqs.has(op.seq)) {
        skipped++;
        continue;
      }
      seen.add(op.seq);
      applier(op);
      appliedSeqs.add(op.seq);
      applied++;
    }
    return { applied, skipped };
  }
}

/** Standalone replay over a raw op array (same idempotency guarantees). */
export function replay(
  ops: Op[],
  applier: OpApplier,
  appliedSeqs: Set<number> = new Set(),
): { applied: number; skipped: number } {
  const log = new OpLog();
  for (const op of ops) {
    // Re-record preserving original seq/ts (bypasses append's assignment).
    (log as unknown as { ops: Op[] }).ops.push({ ...op, payload: { ...op.payload } });
  }
  return log.replayInto(applier, appliedSeqs);
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export interface OpConflict {
  /** Cell address both sides changed, e.g. "Sheet1!B4". */
  target: string;
  local: Op;
  remote: Op;
}

const CELL_OPS: OpKind[] = ['setCell', 'clearCell', 'setFormula'];

function cellKey(op: Op): string | null {
  if (!CELL_OPS.includes(op.kind)) return null;
  const p = op.payload;
  if (typeof p['sheet'] !== 'string' || typeof p['row'] !== 'number' || typeof p['col'] !== 'number') return null;
  return `${p['sheet']}:${p['row']}:${p['col']}`;
}

function colLabel(col: number): string {
  let s = '';
  let c = col;
  do {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return s;
}

/**
 * Find ops that changed the same cell on both sides since a shared base.
 * Only cell-addressing ops conflict; structural ops (row/col insert/delete)
 * are resolved by the OT layer in collaboration.ts, not here.
 */
export function detectConflicts(
  localOps: Op[],
  remoteOps: Op[],
  baseSeq: number,
): OpConflict[] {
  const local = new Map<string, Op>();
  for (const op of localOps) {
    if (op.seq <= baseSeq) continue;
    const key = cellKey(op);
    if (key) local.set(key, op); // last local write wins per cell
  }
  const conflicts: OpConflict[] = [];
  const seen = new Set<string>();
  for (const op of remoteOps) {
    if (op.seq <= baseSeq) continue;
    const key = cellKey(op);
    if (!key) continue;
    const mine = local.get(key);
    if (mine && !seen.has(key)) {
      seen.add(key);
      const p = mine.payload;
      conflicts.push({
        target: `${p['sheet']}!${colLabel(p['col'] as number)}${(p['row'] as number) + 1}`,
        local: mine,
        remote: op,
      });
    }
  }
  return conflicts;
}
