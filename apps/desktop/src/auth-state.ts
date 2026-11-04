/**
 * Desktop auth state machine (Cycle 9: Firebase Google login).
 *
 *   logged-out → logging-in → logged-in → logged-out
 *                         ↘ (failure/cancel) → logged-out
 *
 * The machine owns the LOGIN FLOW phase only. The persisted credential (the
 * gateway JWT in safeStorage) is still read by services.status(); this
 * machine tracks the in-flight transition and notifies subscribers so the
 * UI (menu, agent gate) can react without polling.
 *
 * Failure modes it models explicitly:
 *  - popup-blocked / user closed the popup  → failLogin('…') → logged-out
 *  - network failure (Google unreachable, gateway unreachable) → logged-out
 *  - missing Firebase config (fail closed before any network) → logged-out
 *
 * Illegal transitions throw — a second beginLogin() while logging-in, or a
 * completeLogin() when nothing is in flight, is a programming bug, not a
 * state to silently absorb.
 */

export type AuthPhase = 'logged-out' | 'logging-in' | 'logged-in';

export interface AuthSnapshot {
  phase: AuthPhase;
  /** Gateway principal (e.g. the Google account email) once logged in. */
  principal: string | null;
  /** Last login failure message; cleared on the next beginLogin(). */
  error: string | null;
}

export type AuthChangeListener = (snapshot: AuthSnapshot) => void;

export class DesktopAuthState {
  private phase: AuthPhase;
  private principal: string | null;
  private error: string | null;
  private listeners = new Set<AuthChangeListener>();

  constructor(initial?: { loggedIn: boolean; principal: string | null }) {
    this.phase = initial?.loggedIn ? 'logged-in' : 'logged-out';
    this.principal = initial?.principal ?? null;
    this.error = null;
  }

  /** Current snapshot (immutable copy). */
  snapshot(): AuthSnapshot {
    return { phase: this.phase, principal: this.principal, error: this.error };
  }

  /** Subscribe to transitions. Returns an unsubscribe function. */
  onChange(listener: AuthChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const l of [...this.listeners]) {
      try {
        l(s);
      } catch {
        // A throwing listener must not break the machine or other listeners.
      }
    }
  }

  /** logged-out → logging-in. Clears any previous error. */
  beginLogin(): void {
    if (this.phase === 'logging-in') {
      throw new Error('auth: a login is already in progress');
    }
    if (this.phase === 'logged-in') {
      throw new Error('auth: already logged in — log out first');
    }
    this.phase = 'logging-in';
    this.error = null;
    this.emit();
  }

  /**
   * Begin the login flow — or JOIN the one already in flight (#83).
   *
   * The window flow has exactly ONE owner of the begin transition:
   * openLoginWindow() in main.ts marks the flow in-flight when the window
   * opens. The completion handlers in auth-ipc.ts are NOT owners — when
   * the phase is already 'logging-in' they are completing that same flow,
   * so they join it instead of beginning again (a second beginLogin()
   * there threw 'auth: a login is already in progress' in a perfectly
   * healthy sign-in). From 'logged-out' this behaves exactly like
   * beginLogin() (flows that have no window-open step — the local-dev
   * IPC login, direct IPC calls — begin here). From 'logged-in' it
   * throws, like beginLogin(): a new login over a live session is a
   * programming bug, and callers convert the throw to a handled result.
   */
  beginOrJoinLogin(): void {
    if (this.phase === 'logging-in') return; // join the in-flight flow
    this.beginLogin();
  }

  /** logging-in → logged-in. Principal comes from the exchanged gateway JWT. */
  completeLogin(principal: string | null): void {
    if (this.phase !== 'logging-in') {
      throw new Error('auth: completeLogin() with no login in flight');
    }
    this.phase = 'logged-in';
    this.principal = principal;
    this.error = null;
    this.emit();
  }

  /**
   * logging-in → logged-out. Records the failure reason (popup blocked,
   * network failure, missing config, user cancelled, …) for the UI.
   * A failLogin() with nothing in flight is a no-op when already
   * logged-out (e.g. a late popup-close event after a successful login
   * raced it) — it must never knock a logged-in session out.
   */
  failLogin(error: string): void {
    if (this.phase !== 'logging-in') return;
    this.phase = 'logged-out';
    this.principal = null;
    this.error = error;
    this.emit();
  }

  /** Any phase → logged-out (explicit sign-out; drops the error too). */
  logout(): void {
    const changed = this.phase !== 'logged-out' || this.error !== null;
    this.phase = 'logged-out';
    this.principal = null;
    this.error = null;
    if (changed) this.emit();
  }
}
