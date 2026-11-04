/**
 * Tests for the collaboration bridge (track 10): local edits flow through
 * the CollabSession OT pipeline (transform + revision log) before reaching
 * the engine host; presence heartbeats advertise collaborators; remote ops
 * apply through the real receive path.
 */
import { describe, expect, it, vi } from 'vitest';
import { EngineHost, ops } from '@icecream-sheets/engine';
import { CollabBridge } from './collab';

function attached(): { bridge: CollabBridge; host: EngineHost; notified: () => number } {
  const host = new EngineHost();
  const bridge = new CollabBridge({ clientId: 'web-test', principal: 'Tester' });
  let n = 0;
  bridge.attach(host, () => {
    n++;
  });
  return { bridge, host, notified: () => n };
}

describe('CollabBridge', () => {
  it('routes cell edits through the OT pipeline into the host', () => {
    const { bridge, host } = attached();
    const res = bridge.applySetCell({ sheet: 'Sheet1', row: 0, col: 0 }, 42);
    expect(res.ok).toBe(true);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({ kind: 'number', value: 42 });
    // The edit went through the session: revision bumped, log has the op.
    expect(bridge.revision()).toBe(1);
    const changes = bridge.changes();
    expect(changes).toHaveLength(1);
    expect(changes[0].op.type).toBe('cell.set');
    expect(changes[0].principal).toBe('Tester');
    expect(changes[0].revision).toBe(1);
  });

  it('routes formula edits through the pipeline', () => {
    const { bridge, host } = attached();
    bridge.applySetCell({ sheet: 'Sheet1', row: 0, col: 0 }, 10);
    bridge.applySetCell({ sheet: 'Sheet1', row: 1, col: 0 }, 20);
    const res = bridge.applySetFormula({ sheet: 'Sheet1', row: 2, col: 0 }, '=SUM(A1:A2)');
    expect(res.ok).toBe(true);
    expect(host.readCell({ sheet: 'Sheet1', row: 2, col: 0 })).toEqual({ kind: 'number', value: 30 });
    expect(bridge.revision()).toBe(3);
  });

  it('notifies the UI on every applied edit', () => {
    const { bridge, notified } = attached();
    const before = notified();
    bridge.applySetCell({ sheet: 'Sheet1', row: 0, col: 0 }, 1);
    expect(notified()).toBeGreaterThan(before);
  });

  it('rebases stale remote ops against local edits', () => {
    const { bridge, host } = attached();
    // Local edit lands first (revision 1).
    bridge.applySetCell({ sheet: 'Sheet1', row: 0, col: 0 }, 'local');
    // A remote op authored at revision 0 (before seeing the local edit)
    // targets the same cell: last-writer-wins, applied at revision 2.
    const staleRemote = ops.setCell('peer-1', 0, 'Sheet1', 0, 0, 'remote');
    const applied = bridge.applyRemote(staleRemote, 'Peer');
    expect(applied).not.toBeNull();
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({ kind: 'string', value: 'remote' });
    expect(bridge.revision()).toBe(2);
    // Both ops are in the log, in order.
    const principals = bridge.changes().map((c) => c.principal);
    expect(principals).toEqual(['Tester', 'Peer']);
  });

  it('applies remote ops through the real receive path', () => {
    const { bridge, host } = attached();
    const op = ops.setCell('peer-1', bridge.revision(), 'Sheet1', 2, 3, 'remote-value');
    const applied = bridge.applyRemote(op, 'Peer');
    expect(applied).not.toBeNull();
    expect(host.readCell({ sheet: 'Sheet1', row: 2, col: 3 })).toEqual({ kind: 'string', value: 'remote-value' });
    expect(bridge.changes().some((c) => c.principal === 'Peer')).toBe(true);
  });

  it('tracks presence via heartbeats', () => {
    const { bridge } = attached();
    // Self is present after attach.
    let people = bridge.collaborators();
    expect(people.some((p) => p.principal === 'Tester')).toBe(true);
    // Heartbeat updates the selection.
    bridge.heartbeatSelf('Sheet1', 4, 2);
    people = bridge.collaborators();
    const me = people.find((p) => p.principal === 'Tester')!;
    expect(me.selection).toEqual({ row: 4, col: 2 });
    expect(me.sheet).toBe('Sheet1');
  });

  it('starts a fresh revision log when re-attached to a new host', () => {
    const { bridge } = attached();
    bridge.applySetCell({ sheet: 'Sheet1', row: 0, col: 0 }, 1);
    expect(bridge.revision()).toBe(1);
    bridge.attach(new EngineHost(), () => {});
    expect(bridge.revision()).toBe(0);
    expect(bridge.changes()).toHaveLength(0);
  });

  it('propagates the engine command result', () => {
    const { bridge } = attached();
    const res = bridge.applySetCell({ sheet: 'Sheet1', row: 0, col: 0 }, 'x');
    expect(res.ok).toBe(true);
    expect(bridge.revision()).toBe(1);
  });
});

describe('CollabBridge — Phase 2 transport wiring', () => {
  it('broadcasts local ops through the wired transport handler (onBroadcast → /ops submit)', () => {
    const host = new EngineHost();
    const submitted: string[] = [];
    // Stand-in for CollabTransport.submitBridgeOp (the App wiring).
    const fakeTransport = {
      submitBridgeOp: (op: { type: string }) => {
        submitted.push(op.type);
        return true;
      },
    };
    const bridge = new CollabBridge({ clientId: 'web-phase2', principal: 'Tester' });
    bridge.attach(host, () => {});
    bridge.setBroadcastHandler((op) => {
      fakeTransport.submitBridgeOp(op);
    });
    const res = bridge.applySetCell({ sheet: 'Sheet1', row: 0, col: 0 }, 7);
    expect(res.ok).toBe(true);
    expect(submitted).toEqual(['cell.set']);
    // Re-attach (new document) must NOT drop the broadcast wiring:
    // attach() recreates the CollabSession, and the handler survives.
    bridge.attach(new EngineHost(), () => {});
    bridge.applySetCell({ sheet: 'Sheet1', row: 1, col: 0 }, 8);
    expect(submitted).toEqual(['cell.set', 'cell.set']);
  });

  it('ingests remote deltas into the revision log without executing or re-broadcasting', () => {
    const host = new EngineHost();
    const broadcast = vi.fn();
    const bridge = new CollabBridge({
      clientId: 'web-phase2',
      principal: 'Tester',
      onBroadcast: broadcast,
    });
    bridge.attach(host, () => {});
    const op = ops.setCell('peer-9', 0, 'Sheet1', 3, 3, 'from-delta');
    const applied = bridge.ingestRemoteDelta(op, 'Peer');
    expect(applied).not.toBeNull();
    // Logged for the changes UI…
    expect(bridge.changes().some((c) => c.principal === 'Peer')).toBe(true);
    // …but NOT executed on the host (the transport already applied the
    // delta's cells to the confirmed layer)…
    expect(host.readCell({ sheet: 'Sheet1', row: 3, col: 3 })).toEqual({ kind: 'null', value: null });
    // …and NOT re-broadcast (no echo loop).
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('merges transport presence into collaborators and forwards self heartbeats out', () => {
    const host = new EngineHost();
    const sent: Array<{ sheet: string; row: number; col: number }> = [];
    const bridge = new CollabBridge({ clientId: 'web-phase2', principal: 'Tester' });
    bridge.attach(host, () => {});
    bridge.setPresenceSendHandler((sheet, row, col) => {
      sent.push({ sheet, row, col });
    });
    bridge.heartbeatSelf('Sheet1', 2, 5);
    expect(sent).toEqual([{ sheet: 'Sheet1', row: 2, col: 5 }]);
    bridge.setRemoteParticipants([
      { principal: 'Peer', color: '#dc2626', sheet: 'Sheet1', row: 4, col: 1 },
      // Self reported by the server must not duplicate the local entry.
      { principal: 'Tester', color: '#2563eb', sheet: 'Sheet1', row: 2, col: 5 },
    ]);
    const people = bridge.collaborators();
    expect(people.filter((p) => p.principal === 'Tester')).toHaveLength(1);
    const peer = people.find((p) => p.principal === 'Peer');
    expect(peer?.selection).toEqual({ row: 4, col: 1 });
    expect(peer?.color).toBe('#dc2626');
  });
});

describe('CollabBridge collaborators roster names (#8 residual)', () => {
  it('stamps display names from presence payloads and the self provider', () => {
    const host = new EngineHost();
    const bridge = new CollabBridge({ clientId: 'web-roster', principal: 'user:me-id' });
    bridge.attach(host, () => {});
    bridge.setSelfDisplayNameProvider(() => 'Me Myself');
    bridge.heartbeatSelf('Sheet1', 0, 0);
    bridge.setRemoteParticipants([
      { principal: 'user:peer-id', name: 'Peer Name', color: '#dc2626', sheet: 'Sheet1', row: 1, col: 1 },
      { principal: 'user:anon-id', color: '#16a34a', sheet: 'Sheet1', row: 2, col: 2 },
    ]);
    const people = bridge.collaborators();
    const self = people.find((p) => p.principal === 'user:me-id');
    expect(self?.isSelf).toBe(true);
    expect(self?.name).toBe('Me Myself');
    const peer = people.find((p) => p.principal === 'user:peer-id');
    expect(peer?.isSelf).toBe(false);
    expect(peer?.name).toBe('Peer Name');
    // No payload name: the entry carries none — renderers fall back to a
    // neutral label via participantDisplayName, never the raw principal.
    const anon = people.find((p) => p.principal === 'user:anon-id');
    expect(anon?.name).toBeUndefined();
  });
});
