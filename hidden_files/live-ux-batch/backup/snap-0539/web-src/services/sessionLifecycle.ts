/**
 * Idle session lifecycle (design-docs/deployment-architecture.md,
 * §Idle rule — the user's ruling, implemented exactly):
 *
 *   1. Idle = no user activity for IDLE_TIMEOUT_MS (default 10 min),
 *      measured HERE, at the client. Scrolling counts as activity; so
 *      do mouse, keyboard and cell navigation (selection changes ride
 *      the same DOM/keyboard events; the grid's scroll container emits
 *      real scroll events).
 *   2. At the timeout the client asks the engine to release the
 *      session: the engine checkpoints (snapshot + journal flush) and
 *      EVICTS the workbook; this controller enters DISCONNECTED.
 *   3. While disconnected, editing is blocked — App reuses the
 *      workbookLoaded gate family (a released session behaves like
 *      not-loaded for edit/save) plus a visible "Disconnected — idle"
 *      status with a Reconnect affordance in the StatusBar.
 *   4. The user's next activity (or the Reconnect button) rehydrates:
 *      the engine rebuilds from snapshot + journal, VERIFIES the state
 *      checksum, and only then does this controller report 'connected'
 *      and App unlock editing. checksumVerified !== true is a hard
 *      error state — never a silent unlock (HYBRID-CONSISTENCY §6:
 *      server state at a rev is the only confirmed state).
 *   5. Tab close releases immediately: a pagehide beacon, no 10-minute
 *      wait.
 *   6. A heartbeat (default every 30 s) posts activity to the engine
 *      session; the server's own last-request timestamp + sweeper are
 *      the backstop for a vanished client.
 *
 * CONFIG (all behind env so the default local topology is unchanged):
 *   VITE_SESSION_LIFECYCLE=on   master switch (default OFF — a shared
 *                               local stack must never idle-evict a
 *                               workbook out from under a long perf
 *                               run; production builds set it on)
 *   VITE_IDLE_TIMEOUT_MS        default 600000 (10 min)
 *   VITE_HEARTBEAT_MS           default 30000
 *
 * DESKTOP SEAM: the desktop renderer is this same web app. The
 * controller is created ONLY when the app drives a REMOTE (gateway)
 * host — see shouldRunSessionLifecycle. Desktop-local mode runs the
 * engine over IPC in the main process: there is no server session,
 * nothing to release or rehydrate, and the lifecycle NEVER engages
 * there (no disconnects on desktop-local, by construction).
 */
/// <reference types="vite/client" />
import type { EngineRehydrateResult, EngineSessionStatus } from './gatewayClient';

/** The lifecycle surface a transport must expose (both transports do). */
export interface SessionLifecycleTransport {
  sessionStatus(): Promise<EngineSessionStatus>;
  sessionHeartbeat(sessionId: string): Promise<unknown>;
  sessionRelease(
    sessionId: string,
    reason: string,
  ): Promise<{ ok: true; revision: number; checksum: string | null }>;
  sessionRehydrate(sessionId: string): Promise<EngineRehydrateResult>;
  /** Fire-and-forget tab-close release; true when dispatched. */
  releaseBeacon(sessionId: string, reason: string): boolean;
}

/** Duck-type guard: a transport with the full lifecycle surface. */
export function lifecycleTransportOf(t: unknown): SessionLifecycleTransport | null {
  if (t !== null && typeof t === 'object') {
    const c = t as Partial<SessionLifecycleTransport>;
    if (
      typeof c.sessionStatus === 'function' &&
      typeof c.sessionHeartbeat === 'function' &&
      typeof c.sessionRelease === 'function' &&
      typeof c.sessionRehydrate === 'function' &&
      typeof c.releaseBeacon === 'function'
    ) {
      return c as SessionLifecycleTransport;
    }
  }
  return null;
}

export interface SessionLifecycleConfig {
  enabled: boolean;
  idleTimeoutMs: number;
  heartbeatMs: number;
}

function envNum(env: Record<string, string | undefined> | undefined, key: string, dflt: number): number {
  const n = Number(env?.[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** Resolve the lifecycle config from the Vite env. */
export function resolveSessionLifecycleConfig(
  env?: Record<string, string | undefined>,
): SessionLifecycleConfig {
  const e =
    env ??
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ??
    {};
  return {
    enabled: (e['VITE_SESSION_LIFECYCLE'] ?? '').toLowerCase() === 'on',
    idleTimeoutMs: envNum(e, 'VITE_IDLE_TIMEOUT_MS', 600_000),
    heartbeatMs: envNum(e, 'VITE_HEARTBEAT_MS', 30_000),
  };
}

/**
 * The desktop seam, as a pure decision: the lifecycle runs iff the app
 * is driving a remote/gateway host (isGatewayMode). Desktop-local uses
 * the IPC host — isGatewayMode is false there — so local desktop is
 * structurally unaffected; a desktop build in a gateway/remote mode
 * gets the lifecycle like any web client.
 */
export function shouldRunSessionLifecycle(opts: {
  configEnabled: boolean;
  gatewayMode: boolean;
}): boolean {
  return opts.configEnabled && opts.gatewayMode;
}

// ---------------------------------------------------------------------------
// Activity tracker
// ---------------------------------------------------------------------------

/** Events that count as user activity (doc §Idle rule 1). */
export const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'keydown',
  'scroll',
  'wheel',
  'touchstart',
  'pointerdown',
] as const;

export interface ActivityTarget {
  addEventListener(type: string, listener: () => void, opts?: unknown): void;
  removeEventListener(type: string, listener: () => void, opts?: unknown): void;
}

/**
 * Tracks the last-activity timestamp from DOM activity. Notifications
 * are throttled (activity is a stream; the controller only needs to
 * know "something happened recently" + wake-on-activity when idle).
 */
export class ActivityTracker {
  private lastActivityMs: number;
  private lastNotifiedMs = 0;
  private readonly listeners = new Set<(atMs: number) => void>();
  private readonly handler = (): void => this.record();
  private disposed = false;

  constructor(
    private readonly target: ActivityTarget,
    nowMs: number = Date.now(),
  ) {
    this.lastActivityMs = nowMs;
    for (const type of ACTIVITY_EVENTS) {
      this.target.addEventListener(type, this.handler, { passive: true, capture: true });
    }
  }

  /** Record activity (also callable directly, e.g. cell navigation). */
  record(nowMs: number = Date.now()): void {
    if (this.disposed) return;
    this.lastActivityMs = nowMs;
    if (nowMs - this.lastNotifiedMs >= 1000) {
      this.lastNotifiedMs = nowMs;
      for (const l of [...this.listeners]) {
        try {
          l(nowMs);
        } catch {
          // A failing listener must not break input handling.
        }
      }
    }
  }

  lastActivity(): number {
    return this.lastActivityMs;
  }

  onActivity(listener: (atMs: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const type of ACTIVITY_EVENTS) {
      this.target.removeEventListener(type, this.handler, { passive: true, capture: true });
    }
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Idle session controller
// ---------------------------------------------------------------------------

export type SessionConnectionState = 'connected' | 'disconnected' | 'reconnecting' | 'error';

export interface SessionStateChange {
  state: SessionConnectionState;
  sessionId: string | null;
  /** Set in the 'error' state (e.g. checksum mismatch on rehydrate). */
  error?: string;
  /** The verified checksum after a successful reconnect. */
  checksum?: string | null;
}

export interface IdleControllerDeps {
  transport: SessionLifecycleTransport;
  config: SessionLifecycleConfig;
  /** Activity target (window in the app; a fake in tests). */
  activityTarget: ActivityTarget;
  /** pagehide target (window in the app; a fake in tests). */
  pageHideTarget?: ActivityTarget;
  onStateChange(change: SessionStateChange): void;
  /** Clock injection for tests. */
  now?: () => number;
}

export class IdleSessionController {
  private readonly tracker: ActivityTracker;
  private readonly now: () => number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private state: SessionConnectionState = 'connected';
  private disposed = false;
  private reconnectInFlight: Promise<void> | null = null;
  private readonly onPageHide = (): void => this.beaconRelease();

  constructor(private readonly deps: IdleControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.tracker = new ActivityTracker(deps.activityTarget, this.now());
    this.tracker.onActivity(() => {
      // Activity while disconnected IS the reconnect trigger (rule 4).
      if (this.state === 'disconnected') void this.reconnect();
    });
    deps.pageHideTarget?.addEventListener('pagehide', this.onPageHide);
  }

  get connectionState(): SessionConnectionState {
    return this.state;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Adopt a session id (the load response carries it). */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  /**
   * Begin heartbeating + idle watching. Until a session id is known
   * (adopted via setSessionId, or learned from /session/status), the
   * heartbeat tick polls status to discover it — the engine introduces
   * the session at load, possibly after this controller starts.
   */
  start(): void {
    if (this.heartbeatTimer) return;
    const tickMs = Math.max(250, Math.min(this.deps.config.heartbeatMs, 5000));
    this.heartbeatTimer = setInterval(() => {
      void this.tick();
    }, tickMs);
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!this.sessionId) {
        const status = await this.deps.transport.sessionStatus();
        if (status.sessionId) this.sessionId = status.sessionId;
        if (status.status === 'released' && this.sessionId && this.state === 'connected') {
          this.setState('disconnected');
        }
        return;
      }
      if (this.state !== 'connected') return;
      // Idle check first: past the timeout, release instead of pinging.
      if (this.now() - this.tracker.lastActivity() >= this.deps.config.idleTimeoutMs) {
        await this.disconnect('idle');
        return;
      }
      await this.deps.transport.sessionHeartbeat(this.sessionId);
    } catch {
      // A failed heartbeat is not a disconnect: the server backstop
      // (last-request timestamp + sweeper) covers a truly gone server,
      // and the next tick retries. Never flap the UI on one failure.
    }
  }

  /** Idle timeout reached: checkpoint + evict server-side, then lock. */
  async disconnect(reason: string): Promise<void> {
    if (this.state !== 'connected' || !this.sessionId) return;
    const sessionId = this.sessionId;
    try {
      await this.deps.transport.sessionRelease(sessionId, reason);
    } catch (e) {
      // Release failed: surface it, but still lock locally — the
      // server session may already be gone, and editing against a
      // possibly-evicted workbook is exactly what the gate prevents.
      this.setState('error', e instanceof Error ? e.message : String(e));
      return;
    }
    this.setState('disconnected');
  }

  /**
   * Reconnect (rule 4): rehydrate + checksum-verify server-side; the
   * controller reports 'connected' ONLY when the engine answers
   * ok && checksumVerified. A mismatch lands in 'error' and editing
   * stays locked — never a silent unlock.
   */
  reconnect(): Promise<void> {
    if (this.reconnectInFlight) return this.reconnectInFlight;
    if (!this.sessionId) return Promise.resolve();
    const sessionId = this.sessionId;
    this.setState('reconnecting');
    this.reconnectInFlight = (async () => {
      try {
        const result = await this.deps.transport.sessionRehydrate(sessionId);
        if (result.ok && result.checksumVerified) {
          this.tracker.record(this.now());
          this.setState('connected', undefined, result.checksum);
        } else {
          this.setState(
            'error',
            result.error ??
              'Session rehydrate failed checksum verification — editing stays locked.',
          );
        }
      } catch (e) {
        this.setState('error', e instanceof Error ? e.message : String(e));
      } finally {
        this.reconnectInFlight = null;
      }
    })();
    return this.reconnectInFlight;
  }

  /** Tab close (rule 5): beacon release, immediate, fire-and-forget. */
  beaconRelease(): void {
    if (!this.sessionId) return;
    this.deps.transport.releaseBeacon(this.sessionId, 'tab-close');
  }

  private setState(
    state: SessionConnectionState,
    error?: string,
    checksum?: string | null,
  ): void {
    this.state = state;
    this.deps.onStateChange({
      state,
      sessionId: this.sessionId,
      ...(error ? { error } : {}),
      ...(checksum !== undefined ? { checksum } : {}),
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.tracker.dispose();
    this.deps.pageHideTarget?.removeEventListener('pagehide', this.onPageHide);
  }
}
