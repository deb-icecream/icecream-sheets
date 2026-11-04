/**
 * Idle session lifecycle tests (deployment-architecture.md §Idle rule):
 * activity tracking, idle release → disconnected, activity-triggered
 * reconnect that unlocks ONLY on checksum verification, mismatch keeps
 * the lock, beacon release on pagehide, and the desktop seam decision.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ActivityTracker,
  IdleSessionController,
  resolveSessionLifecycleConfig,
  shouldRunSessionLifecycle,
  type ActivityTarget,
  type SessionLifecycleTransport,
  type SessionStateChange,
} from './sessionLifecycle';
import type { EngineRehydrateResult, EngineSessionStatus } from './gatewayClient';

class FakeTarget implements ActivityTarget {
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function fakeTransport(overrides: Partial<SessionLifecycleTransport> = {}): {
  transport: SessionLifecycleTransport;
  calls: { heartbeat: string[]; release: Array<[string, string]>; beacon: Array<[string, string]> };
} {
  const calls = {
    heartbeat: [] as string[],
    release: [] as Array<[string, string]>,
    beacon: [] as Array<[string, string]>,
  };
  const transport: SessionLifecycleTransport = {
    sessionStatus: async (): Promise<EngineSessionStatus> => ({
      ok: true,
      sessionId: 'sess_1',
      status: 'active',
      revision: 3,
      lastActivityAt: 0,
      idleTimeoutMs: 1000,
      snapshotChecksum: null,
    }),
    sessionHeartbeat: async (sid) => {
      calls.heartbeat.push(sid);
      return { ok: true, lastActivityAt: 0 };
    },
    sessionRelease: async (sid, reason) => {
      calls.release.push([sid, reason]);
      return { ok: true, revision: 3, checksum: 'abc' };
    },
    sessionRehydrate: async (sid): Promise<EngineRehydrateResult> => ({
      ok: true,
      sessionId: sid,
      revision: 3,
      checksum: 'abc',
      checksumVerified: true,
      replayedOps: 0,
    }),
    releaseBeacon: (sid, reason) => {
      calls.beacon.push([sid, reason]);
      return true;
    },
    ...overrides,
  };
  return { transport, calls };
}

describe('ActivityTracker', () => {
  it('records activity from scroll/mouse/keyboard events and disposes cleanly', () => {
    const target = new FakeTarget();
    const tracker = new ActivityTracker(target, 1000);
    expect(tracker.lastActivity()).toBe(1000);
    target.fire('scroll');
    expect(tracker.lastActivity()).toBeGreaterThanOrEqual(1000);
    tracker.dispose();
    // Notification throttling, on a clean fake clock.
    const tracker2 = new ActivityTracker(new FakeTarget(), 1000);
    let notified = 0;
    tracker2.onActivity(() => notified++);
    tracker2.record(1500); // first activity notifies immediately
    expect(notified).toBe(1);
    tracker2.record(1600); // inside the 1s throttle window: no re-notify
    expect(notified).toBe(1);
    tracker2.record(2600);
    expect(tracker2.lastActivity()).toBe(2600);
    expect(notified).toBe(2);
    tracker2.dispose();
    expect(target.count('scroll')).toBe(0);
    expect(target.count('keydown')).toBe(0);
  });
});

describe('IdleSessionController', () => {
  function makeController(
    overrides: Partial<SessionLifecycleTransport> = {},
    cfg = { enabled: true, idleTimeoutMs: 1000, heartbeatMs: 250 },
  ) {
    const target = new FakeTarget();
    const pageHide = new FakeTarget();
    const { transport, calls } = fakeTransport(overrides);
    const changes: SessionStateChange[] = [];
    let nowMs = 0;
    const controller = new IdleSessionController({
      transport,
      config: cfg,
      activityTarget: target,
      pageHideTarget: pageHide,
      onStateChange: (c) => changes.push(c),
      now: () => nowMs,
    });
    return {
      controller,
      calls,
      changes,
      target,
      pageHide,
      setNow: (n: number) => {
        nowMs = n;
      },
    };
  }

  it('heartbeats the adopted session on ACTIVITY (not on a blind timer)', async () => {
    const { controller, calls, target } = makeController();
    controller.setSessionId('sess_1');
    controller.start();
    // No user activity yet: the activity-driven heartbeat must stay
    // silent even across several ticks (owner ruling 2026-10-23 — a
    // blind timer refreshing the idle clock is the defect this
    // replaces; silence is what lets the 10-minute expiry fire).
    await new Promise((r) => setTimeout(r, 320));
    expect(calls.heartbeat.length).toBe(0);
    // A user action (a click) fires the heartbeat.
    target.fire('mousedown');
    await new Promise((r) => setTimeout(r, 60));
    controller.dispose();
    expect(calls.heartbeat.length).toBeGreaterThanOrEqual(1);
    expect(calls.heartbeat[0]).toBe('sess_1');
    expect(controller.connectionState).toBe('connected');
  });

  it('leaveSession releases explicitly and immediately (signaled exit)', async () => {
    const { controller, calls } = makeController();
    controller.setSessionId('sess_1');
    await controller.leaveSession();
    expect(calls.release).toEqual([['sess_1', 'leave-to-workspace']]);
    expect(controller.connectionState).toBe('disconnected');
    controller.dispose();
  });

  it('idle timeout releases the session and enters disconnected', async () => {
    const { controller, calls, changes, setNow } = makeController();
    controller.setSessionId('sess_1');
    setNow(5000); // 5s past last activity (t=0) with a 1s timeout
    await controller.disconnect('idle');
    expect(calls.release).toEqual([['sess_1', 'idle']]);
    expect(controller.connectionState).toBe('disconnected');
    expect(changes.at(-1)).toMatchObject({ state: 'disconnected', sessionId: 'sess_1' });
    controller.dispose();
  });

  it('activity while disconnected reconnects and unlocks on checksum verification', async () => {
    const { controller, changes, target } = makeController();
    controller.setSessionId('sess_1');
    await controller.disconnect('idle');
    expect(controller.connectionState).toBe('disconnected');
    target.fire('mousemove');
    // The activity notification triggers reconnect asynchronously.
    await vi.waitFor(() => expect(controller.connectionState).toBe('connected'));
    expect(changes.at(-1)).toMatchObject({ state: 'connected', checksum: 'abc' });
    controller.dispose();
  });

  it('checksum mismatch on rehydrate NEVER unlocks: error state, still locked', async () => {
    const { controller, changes } = makeController({
      sessionRehydrate: async (sid) => ({
        ok: false,
        sessionId: sid,
        revision: 0,
        checksum: null,
        checksumVerified: false,
        replayedOps: 0,
        error: 'rehydrate checksum mismatch',
      }),
    });
    controller.setSessionId('sess_1');
    await controller.disconnect('idle');
    await controller.reconnect();
    expect(controller.connectionState).toBe('error');
    expect(changes.at(-1)).toMatchObject({ state: 'error' });
    expect(changes.at(-1)?.error).toContain('checksum mismatch');
    controller.dispose();
  });

  it('pagehide fires the beacon release immediately (tab close)', async () => {
    const { controller, calls, pageHide } = makeController();
    controller.setSessionId('sess_1');
    pageHide.fire('pagehide');
    expect(calls.beacon).toEqual([['sess_1', 'tab-close']]);
    controller.dispose();
  });

  it('a failed release surfaces an error and locks (never silently edits on)', async () => {
    const { controller } = makeController({
      sessionRelease: async () => {
        throw new Error('engine unreachable');
      },
    });
    controller.setSessionId('sess_1');
    await controller.disconnect('idle');
    expect(controller.connectionState).toBe('error');
    controller.dispose();
  });
});

describe('config + desktop seam', () => {
  it('defaults: lifecycle OFF, idle 10 min, heartbeat 30 s', () => {
    const cfg = resolveSessionLifecycleConfig({});
    expect(cfg).toEqual({ enabled: false, idleTimeoutMs: 600_000, heartbeatMs: 30_000 });
    const on = resolveSessionLifecycleConfig({
      VITE_SESSION_LIFECYCLE: 'on',
      VITE_IDLE_TIMEOUT_MS: '20000',
      VITE_HEARTBEAT_MS: '5000',
    });
    expect(on).toEqual({ enabled: true, idleTimeoutMs: 20_000, heartbeatMs: 5000 });
  });

  it('runs only for a gateway/remote host with the switch on (desktop-local unaffected)', () => {
    expect(shouldRunSessionLifecycle({ configEnabled: true, gatewayMode: true })).toBe(true);
    // Desktop-local: IPC host → gatewayMode false → never runs.
    expect(shouldRunSessionLifecycle({ configEnabled: true, gatewayMode: false })).toBe(false);
    expect(shouldRunSessionLifecycle({ configEnabled: false, gatewayMode: true })).toBe(false);
  });
});
