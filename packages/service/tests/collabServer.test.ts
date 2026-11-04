/**
 * Tests for the collaboration server (collabServer.ts): sequencing,
 * OT rebasing, vector clocks, conflict reporting, presence.
 */
import { describe, expect, it } from 'vitest';
import { CollabSession, ops, type CollabOp } from '@icecream-sheets/engine';
import {
  CollabServer,
  clockDominates,
  type ServerOp,
} from '../src/collabServer.js';

function submitOk(server: CollabServer, doc: string, client: string, op: CollabOp): ServerOp {
  const res = server.submit(doc, client, op);
  if (!res.ok) throw new Error(`submit failed: ${res.reason}: ${res.message}`);
  return res.record;
}

describe('CollabServer sequencing', () => {
  it('sequences ops from multiple clients into one log', () => {
    const server = new CollabServer();
    server.join('doc1', 'A', 'alice');
    server.join('doc1', 'B', 'bob');
    const r1 = submitOk(server, 'doc1', 'A', ops.setCell('A', 0, 'S', 0, 0, 'a1'));
    const r2 = submitOk(server, 'doc1', 'B', ops.setCell('B', 1, 'S', 1, 1, 'b2'));
    expect(r1.serverSeq).toBe(1);
    expect(r2.serverSeq).toBe(2);
    expect(server.getDocument('doc1')!.revision()).toBe(2);
    // Broadcast hook fires per sequenced op.
    const seen: ServerOp[] = [];
    const s2 = new CollabServer({ onBroadcast: (_doc, rec) => seen.push(rec) });
    s2.join('d', 'A', 'alice');
    submitOk(s2, 'd', 'A', ops.setCell('A', 0, 'S', 0, 0, 1));
    expect(seen.length).toBe(1);
    expect(seen[0].principal).toBe('alice');
  });

  it('rebases a stale op against concurrent structural ops', () => {
    const server = new CollabServer();
    server.join('doc', 'A', 'alice');
    server.join('doc', 'B', 'bob');
    // A inserts a row at the top (seq 1).
    submitOk(server, 'doc', 'A', ops.insertRows('A', 0, 'S', 0, 1));
    // B authored a cell edit at row 5 against revision 0 (has not seen the insert).
    const r = submitOk(server, 'doc', 'B', ops.setCell('B', 0, 'S', 5, 2, 'x'));
    expect(r.op.params['row']).toBe(6); // shifted past the insert
    expect(r.concurrentWith).toEqual([1]);
    expect(r.op.baseRevision).toBe(1); // rewritten to the server revision
  });

  it('resolves concurrent same-cell writes last-writer-wins and reports the conflict', () => {
    const server = new CollabServer();
    server.join('doc', 'A', 'alice');
    server.join('doc', 'B', 'bob');
    submitOk(server, 'doc', 'A', ops.setCell('A', 0, 'S', 3, 3, 'from-a'));
    const r2 = submitOk(server, 'doc', 'B', ops.setCell('B', 0, 'S', 3, 3, 'from-b'));
    expect(r2.op.params['value']).toBe('from-b'); // no transform for same-cell sets
    const conflicts = server.getDocument('doc')!.findConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].cell).toBe('S!3:3');
    expect(conflicts[0].winner.serverSeq).toBe(2);
    expect(conflicts[0].loser.serverSeq).toBe(1);
  });

  it('rejects ops made obsolete by a concurrent delete', () => {
    const server = new CollabServer();
    server.join('doc', 'A', 'alice');
    server.join('doc', 'B', 'bob');
    submitOk(server, 'doc', 'A', ops.deleteRows('A', 0, 'S', 0, 2));
    const res = server.submit('doc', 'B', ops.setCell('B', 0, 'S', 1, 0, 'x'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('obsolete');
  });

  it('validates submissions', () => {
    const server = new CollabServer();
    server.join('doc', 'A', 'alice');
    // Unknown client.
    const r1 = server.submit('doc', 'ZZ', ops.setCell('ZZ', 0, 'S', 0, 0, 1));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('unknown-client');
    // Unknown document.
    const r2 = server.submit('nope', 'A', ops.setCell('A', 0, 'S', 0, 0, 1));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('unknown-document');
    // Bad op type.
    const r3 = server.submit('doc', 'A', { id: 'x', type: 'nonsense', baseRevision: 0, params: {} } as never);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe('invalid-op');
    // baseRevision ahead of the server.
    const r4 = server.submit('doc', 'A', ops.setCell('A', 99, 'S', 0, 0, 1));
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.reason).toBe('stale-base');
  });
});

describe('CollabServer vector clocks and catch-up', () => {
  it('tracks per-author clocks and serves unseen ops', () => {
    const server = new CollabServer();
    server.join('doc', 'A', 'alice');
    server.join('doc', 'B', 'bob');
    submitOk(server, 'doc', 'A', ops.setCell('A', 0, 'S', 0, 0, 1));
    submitOk(server, 'doc', 'A', ops.setCell('A', 1, 'S', 0, 1, 2));
    submitOk(server, 'doc', 'B', ops.setCell('B', 2, 'S', 1, 0, 3));
    const doc = server.getDocument('doc')!;
    const clockB = doc.clockOf('B')!;
    // B has seen both of A's ops (based on revision 2) plus its own.
    expect(clockB).toMatchObject({ A: 2, B: 1 });
    // A fresh client that saw nothing gets everything.
    expect(doc.opsSinceClock({})).toHaveLength(3);
    // A client that saw A's 2 ops but not B's gets only B's.
    expect(doc.opsSinceClock({ A: 2 }).map((r) => r.serverSeq)).toEqual([3]);
    // opsSince by revision works too.
    expect(doc.opsSince(2).map((r) => r.serverSeq)).toEqual([3]);
  });

  it('clockDominates compares causality', () => {
    expect(clockDominates({ A: 2, B: 1 }, { A: 1 })).toBe(true);
    expect(clockDominates({ A: 1 }, { A: 2 })).toBe(false);
    expect(clockDominates({}, {})).toBe(true);
  });
});

describe('CollabServer convergence with engine sessions', () => {
  it('two engine CollabSessions converge through the server', () => {
    const delivered: { to: string; op: ServerOp }[] = [];
    const server = new CollabServer({
      onBroadcast: (_doc, rec) => {
        // In-memory transport: echo the sequenced op to every joined client
        // (including the originator — clients apply only sequenced ops).
        for (const other of ['A', 'B']) delivered.push({ to: other, op: rec });
      },
    });
    server.join('doc', 'A', 'alice');
    server.join('doc', 'B', 'bob');
    const sessA = new CollabSession();
    const sessB = new CollabSession();
    const sessions: Record<string, CollabSession> = { A: sessA, B: sessB };
    const flush = (): void => {
      for (const d of delivered.splice(0)) {
        sessions[d.to].applyRemote(d.op.op, d.op.principal);
      }
    };

    // A and B submit concurrently (neither has seen the other's op).
    submitOk(server, 'doc', 'A', ops.setCell('A', 0, 'S', 0, 0, 'a'));
    submitOk(server, 'doc', 'B', ops.setCell('B', 0, 'S', 0, 1, 'b'));
    flush();
    // Structural concurrency: A inserts a row; B (stale) edits below it.
    submitOk(server, 'doc', 'A', ops.insertRows('A', 2, 'S', 0, 1));
    const rB = submitOk(server, 'doc', 'B', ops.setCell('B', 2, 'S', 4, 0, 'moved'));
    expect(rB.op.params['row']).toBe(5);
    flush();

    for (const s of [sessA, sessB]) {
      expect(s.revision()).toBe(4);
    }
    const opsA = sessA.changes().map((c) => JSON.stringify(c.op.params));
    const opsB = sessB.changes().map((c) => JSON.stringify(c.op.params));
    expect(opsA).toEqual(opsB);
    // The moved cell edit landed at row 5 in both sessions.
    expect(opsA[3]).toContain('"row":5');
  });
});

describe('CollabServer presence', () => {
  it('tracks heartbeats with expiry', () => {
    const server = new CollabServer();
    server.join('doc', 'A', 'alice');
    server.heartbeat('doc', { principal: 'alice', color: '#f00', sheet: 'S', selection: { row: 1, col: 1 } });
    expect(server.collaborators('doc').length).toBe(1);
    // Expired after the TTL.
    expect(server.collaborators('doc', Date.now() + 60_000).length).toBe(0);
    server.leave('doc', 'A');
    expect(server.getDocument('doc')!.hasClient('A')).toBe(false);
  });
});

describe('CollabServer documents', () => {
  it('isolates documents and reports stats', () => {
    const server = new CollabServer();
    server.join('d1', 'A', 'alice');
    server.join('d2', 'A', 'alice');
    submitOk(server, 'd1', 'A', ops.setCell('A', 0, 'S', 0, 0, 1));
    expect(server.getDocument('d1')!.revision()).toBe(1);
    expect(server.getDocument('d2')!.revision()).toBe(0);
    expect(server.documentIds().sort()).toEqual(['d1', 'd2']);
    const stats = server.getDocument('d1')!.stats();
    expect(stats).toMatchObject({ docId: 'd1', revision: 1, clients: 1, opsByClient: { A: 1 } });
    expect(server.dropDocument('d2')).toBe(true);
    expect(server.documentIds()).toEqual(['d1']);
  });
});
