/**
 * Tests for the collaboration foundation (track 10): OT transform,
 * CollabSession revision log, presence, and change tracking.
 */
import { describe, expect, it } from 'vitest';
import { CollabSession, ops, transform } from '../src/collaboration.js';
import type { CollabOp } from '../src/collaboration.js';

function op(partial: Partial<CollabOp> & { type: CollabOp['type'] }): CollabOp {
  return { id: 't:0', baseRevision: 0, params: {}, ...partial };
}

describe('transform', () => {
  it('shifts cell.set past an inserted row', () => {
    const set = op({ type: 'cell.set', params: { sheet: 'S', row: 5, col: 0 } });
    const ins = op({ type: 'rows.insert', params: { sheet: 'S', at: 2, count: 1 } });
    const out = transform(set, ins);
    expect(out?.params['row']).toBe(6);
  });

  it('shifts cell.set past a deleted row', () => {
    const set = op({ type: 'cell.set', params: { sheet: 'S', row: 5, col: 0 } });
    const del = op({ type: 'rows.delete', params: { sheet: 'S', at: 2, count: 2 } });
    const out = transform(set, del);
    expect(out?.params['row']).toBe(3);
  });

  it('nulls cell.set inside deleted rows', () => {
    const set = op({ type: 'cell.set', params: { sheet: 'S', row: 3, col: 0 } });
    const del = op({ type: 'rows.delete', params: { sheet: 'S', at: 2, count: 2 } });
    expect(transform(set, del)).toBeNull();
  });

  it('does not shift ops on other sheets', () => {
    const set = op({ type: 'cell.set', params: { sheet: 'S', row: 5, col: 0 } });
    const ins = op({ type: 'rows.insert', params: { sheet: 'T', at: 0, count: 1 } });
    const out = transform(set, ins);
    expect(out?.params['row']).toBe(5);
  });

  it('rewrites sheet on rename', () => {
    const set = op({ type: 'cell.set', params: { sheet: 'Old', row: 0, col: 0 } });
    const ren = op({ type: 'sheet.rename', params: { from: 'Old', to: 'New' } });
    const out = transform(set, ren);
    expect(out?.params['sheet']).toBe('New');
  });

  it('nulls ops on deleted sheets', () => {
    const set = op({ type: 'cell.set', params: { sheet: 'Gone', row: 0, col: 0 } });
    const del = op({ type: 'sheet.delete', params: { name: 'Gone' } });
    expect(transform(set, del)).toBeNull();
  });

  it('shifts column inserts past column deletes', () => {
    const ins = op({ type: 'cols.insert', params: { sheet: 'S', at: 5, count: 1 } });
    const del = op({ type: 'cols.delete', params: { sheet: 'S', at: 1, count: 2 } });
    const out = transform(ins, del);
    expect(out?.params['at']).toBe(3);
  });

  it('leaves concurrent cell.set ops alone (last-writer-wins)', () => {
    const a = op({ type: 'cell.set', params: { sheet: 'S', row: 0, col: 0, value: 1 } });
    const b = op({ type: 'cell.set', params: { sheet: 'S', row: 0, col: 0, value: 2 } });
    expect(transform(a, b)).toBe(a);
  });
});

describe('CollabSession', () => {
  it('applies ops and tracks revisions', () => {
    const s = new CollabSession();
    const o1 = ops.setCell('c1', 0, 'S', 0, 0, 'a');
    const o2 = ops.setCell('c1', 1, 'S', 0, 1, 'b');
    s.applyLocal(o1, 'alice');
    s.applyLocal(o2, 'alice');
    expect(s.revision()).toBe(2);
    expect(s.changes()).toHaveLength(2);
    expect(s.changes()[0].principal).toBe('alice');
    expect(s.changes()[0].revision).toBe(1);
  });

  it('rebases stale ops against newer ones', () => {
    const s = new CollabSession();
    // Alice inserts a row at 0 (revision 1).
    s.applyLocal(ops.insertRows('a', 0, 'S', 0, 1), 'alice');
    // Bob's setCell was based on revision 0; it should shift to row 1.
    const rebased = s.applyLocal(ops.setCell('b', 0, 'S', 0, 0, 'x'), 'bob');
    expect(rebased?.params['row']).toBe(1);
    expect(s.revision()).toBe(2);
  });

  it('drops obsolete ops', () => {
    const s = new CollabSession();
    s.applyLocal(ops.deleteRows('a', 0, 'S', 0, 5), 'alice');
    const out = s.applyLocal(ops.setCell('b', 0, 'S', 2, 0, 'x'), 'bob');
    expect(out).toBeNull();
    expect(s.revision()).toBe(1);
  });

  it('broadcasts applied ops', () => {
    const seen: CollabOp[] = [];
    const s = new CollabSession({ onBroadcast: (o) => seen.push(o) });
    s.applyLocal(ops.setCell('a', 0, 'S', 0, 0, 1), 'alice');
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('cell.set');
  });

  it('filters changes by revision and principal', () => {
    const s = new CollabSession();
    s.applyLocal(ops.setCell('a', 0, 'S', 0, 0, 1), 'alice');
    s.applyLocal(ops.setCell('b', 1, 'S', 0, 1, 2), 'bob');
    expect(s.changes(1)).toHaveLength(1);
    expect(s.changesBy('bob')).toHaveLength(1);
    expect(s.changesBy('nobody')).toHaveLength(0);
  });

  it('tracks presence with expiry', () => {
    const s = new CollabSession();
    s.heartbeat({ principal: 'alice', color: '#f00', sheet: 'S', selection: { row: 1, col: 2 } });
    expect(s.collaborators()).toHaveLength(1);
    expect(s.collaborators()[0].selection).toEqual({ row: 1, col: 2 });
    // Expired heartbeat.
    expect(s.collaborators(Date.now() + 60_000)).toHaveLength(0);
    // Leave removes.
    s.heartbeat({ principal: 'bob', color: '#00f', sheet: 'S', selection: { row: 0, col: 0 } });
    s.leave('bob');
    expect(s.collaborators()).toHaveLength(0);
  });

  it('snapshots the session', () => {
    const s = new CollabSession();
    s.applyLocal(ops.setCell('a', 0, 'S', 0, 0, 1), 'alice');
    const snap = s.snapshot();
    expect(snap.log).toHaveLength(1);
    expect(snap.presence).toEqual([]);
  });
});
