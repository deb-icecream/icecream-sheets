/**
 * Tests for the offline op log (packages/engine/src/oplog.ts):
 * append/replay round-trip, serialize/deserialize, conflict detection,
 * and replay idempotency.
 */
import { describe, expect, it } from 'vitest';
import { OpLog, replay, detectConflicts, type Op } from '../src/oplog';

function setCell(sheet: string, row: number, col: number, value: unknown, seqTs?: number): Op {
  return {
    seq: 0,
    ts: seqTs ?? 1000,
    principal: 'user',
    kind: 'setCell',
    payload: { sheet, row, col, value },
  };
}

describe('OpLog.append', () => {
  it('assigns monotonic seq numbers starting at 1', () => {
    const log = new OpLog();
    const a = log.append({ principal: 'user', kind: 'setCell', payload: { sheet: 'S', row: 0, col: 0, value: 1 } });
    const b = log.append({ principal: 'user', kind: 'setCell', payload: { sheet: 'S', row: 0, col: 1, value: 2 } });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(log.lastSeq()).toBe(2);
  });

  it('honors an explicit ts and defaults to Date.now()', () => {
    const log = new OpLog();
    const a = log.append({ principal: 'u', kind: 'setCell', payload: {}, ts: 42 });
    const b = log.append({ principal: 'u', kind: 'setCell', payload: {} });
    expect(a.ts).toBe(42);
    expect(b.ts).toBeGreaterThan(0);
  });

  it('since() returns only ops after the given seq', () => {
    const log = new OpLog();
    log.append({ principal: 'u', kind: 'setCell', payload: { sheet: 'S', row: 0, col: 0 } });
    log.append({ principal: 'u', kind: 'setCell', payload: { sheet: 'S', row: 0, col: 1 } });
    expect(log.since(1).map((o) => o.seq)).toEqual([2]);
  });
});

describe('serialize/deserialize round-trip', () => {
  it('preserves ops, order and nextSeq', () => {
    const log = new OpLog();
    log.append({ principal: 'alice', kind: 'setCell', payload: { sheet: 'S', row: 1, col: 2, value: 'x' }, ts: 7 });
    log.append({ principal: 'bob', kind: 'insertRow', payload: { sheet: 'S', at: 3, count: 1 }, ts: 8 });
    const raw = log.serialize();
    const back = OpLog.deserialize(raw);
    expect(back.all()).toEqual(log.all());
    const c = back.append({ principal: 'u', kind: 'clearCell', payload: {} });
    expect(c.seq).toBe(3);
  });

  it('returns an empty log for corrupt payloads', () => {
    expect(OpLog.deserialize('not json').length).toBe(0);
    expect(OpLog.deserialize('{"ops":"nope"}').length).toBe(0);
    expect(OpLog.deserialize('[]').length).toBe(0);
  });

  it('drops malformed op entries', () => {
    const back = OpLog.deserialize(JSON.stringify({ version: 1, nextSeq: 5, ops: [{ seq: 1 }, { bogus: true }] }));
    expect(back.length).toBe(0);
    expect(back.lastSeq()).toBe(4);
  });
});

describe('replay', () => {
  it('applies ops in seq order', () => {
    const log = new OpLog();
    log.append({ principal: 'u', kind: 'setCell', payload: { sheet: 'S', row: 0, col: 1, value: 'b' } });
    log.append({ principal: 'u', kind: 'setCell', payload: { sheet: 'S', row: 0, col: 0, value: 'a' } });
    // Swap internal order to prove replay sorts by seq.
    const ops = log.all().reverse();
    const seen: Op[] = [];
    const res = replay(ops, (op) => void seen.push(op));
    expect(res.applied).toBe(2);
    expect(seen.map((o) => o.seq)).toEqual([1, 2]);
  });

  it('is idempotent across repeated replays (appliedSeqs)', () => {
    const log = new OpLog();
    log.append({ principal: 'u', kind: 'setCell', payload: { sheet: 'S', row: 0, col: 0, value: 1 } });
    const appliedSeqs = new Set<number>();
    let calls = 0;
    const r1 = log.replayInto(() => void calls++, appliedSeqs);
    const r2 = log.replayInto(() => void calls++, appliedSeqs);
    expect(r1.applied).toBe(1);
    expect(r2.applied).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(calls).toBe(1);
  });

  it('dedupes duplicate seqs within one batch', () => {
    const op = setCell('S', 0, 0, 1);
    const res = replay([{ ...op, seq: 1 }, { ...op, seq: 1 }], () => undefined);
    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(1);
  });
});

describe('detectConflicts', () => {
  const base = (seq: number, sheet = 'Sheet1'): Op => ({
    ...setCell(sheet, 0, 0, 'v'),
    seq,
    ts: seq,
  });

  it('flags same-cell changes on both sides since baseSeq', () => {
    const local = [base(11), { ...setCell('Sheet1', 1, 1, 'mine'), seq: 12, ts: 12 }];
    const remote = [{ ...setCell('Sheet1', 1, 1, 'theirs'), seq: 21, ts: 21, principal: 'peer' }];
    const conflicts = detectConflicts(local, remote, 10);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].target).toBe('Sheet1!B2');
    expect(conflicts[0].local.payload['value']).toBe('mine');
    expect(conflicts[0].remote.payload['value']).toBe('theirs');
  });

  it('ignores ops at or before baseSeq', () => {
    const local = [{ ...setCell('Sheet1', 0, 0, 'old'), seq: 10, ts: 10 }];
    const remote = [{ ...setCell('Sheet1', 0, 0, 'new'), seq: 11, ts: 11, principal: 'peer' }];
    expect(detectConflicts(local, remote, 10)).toHaveLength(0);
  });

  it('ignores different cells and non-cell ops', () => {
    const local = [{ ...setCell('Sheet1', 0, 0, 'a'), seq: 11, ts: 11 }];
    const remote = [
      { ...setCell('Sheet1', 5, 5, 'b'), seq: 12, ts: 12, principal: 'peer' },
      { seq: 13, ts: 13, principal: 'peer', kind: 'insertRow', payload: { sheet: 'Sheet1', at: 0, count: 1 } },
    ];
    expect(detectConflicts(local, remote, 10)).toHaveLength(0);
  });

  it('uses the last local write per cell', () => {
    const local = [
      { ...setCell('Sheet1', 0, 0, 'first'), seq: 11, ts: 11 },
      { ...setCell('Sheet1', 0, 0, 'second'), seq: 12, ts: 12 },
    ];
    const remote = [{ ...setCell('Sheet1', 0, 0, 'theirs'), seq: 21, ts: 21, principal: 'peer' }];
    const conflicts = detectConflicts(local, remote, 10);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].local.payload['value']).toBe('second');
  });
});
