/**
 * Firebase Google sign-in state machine (Cycle 9, Phase 1 — web login).
 *
 * States: logged-out → logging-in → logged-in → logged-out, plus an
 * `error` state carrying a code + human-readable message (popup blocked,
 * network failure, missing config, gateway exchange failure, …).
 * Retrying from `error` is always allowed.
 *
 * Flow: Firebase signInWithPopup (Google provider only) → fresh Firebase
 * ID token → exchanged at the gateway's POST /auth/firebase for the
 * gateway JWT (identity then flows to every /api/* call as the
 * `user:<uid>` principal; the gateway verifies the Firebase token's
 * RS256 signature itself — it never trusts the client).
 *
 * The Firebase SDK is behind the FirebasePort interface so unit tests
 * inject a fake and never hit real Firebase.
 */

import type { FirebasePort, PortUser } from './firebasePort';

export type FirebaseAuthStatus = 'logged-out' | 'logging-in' | 'logged-in' | 'error';

export interface FirebaseAuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface AuthErrorInfo {
  /** Stable machine code: config-missing, popup-blocked, popup-closed, network, unauthorized-domain, provider-disabled, exchange-failed, signout-failed, unknown. */
  code: string;
  message: string;
}

export type FirebaseAuthState =
  | { status: 'logged-out' }
  | { status: 'logging-in' }
  | { status: 'logged-in'; user: FirebaseAuthUser }
  | { status: 'error'; error: AuthErrorInfo };

/** The gateway side of the exchange: POST /auth/firebase → gateway JWT. */
export interface GatewayTokenExchange {
  loginWithFirebaseIdToken(idToken: string): Promise<void>;
  logout(): void;
}

type Listener = (state: FirebaseAuthState) => void;

/**
 * Max wait for the SDK's first auth-state emission during boot restore.
 * The real SDK always emits once its persisted-session restore settles
 * (normally well under a second — a local IndexedDB read); this ceiling
 * only fires for a port that never emits, where the synchronous
 * snapshot is the best answer available.
 */
const RESTORE_EMISSION_TIMEOUT_MS = 5000;

/** Map a Firebase / gateway / SDK failure to a stable code + friendly text. */
export function classifyAuthError(e: unknown): AuthErrorInfo {
  const raw = (e ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof raw.code === 'string' ? raw.code : '';
  const detail =
    typeof raw.message === 'string' && raw.message.length > 0
      ? raw.message
      : e instanceof Error
        ? e.message
        : String(e);
  switch (code) {
    case 'config-missing':
      return { code, message: detail };
    case 'auth/popup-blocked':
      return {
        code: 'popup-blocked',
        message:
          'The sign-in popup was blocked by your browser. Allow popups for this site and try again.',
      };
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return { code: 'popup-closed', message: 'Sign-in was cancelled before completing.' };
    case 'auth/network-request-failed':
      return {
        code: 'network',
        message: `Network error during sign-in — check your connection and try again. (${detail})`,
      };
    case 'auth/unauthorized-domain':
      return {
        code: 'unauthorized-domain',
        message:
          'This site\'s domain is not authorized for Firebase sign-in. Add it under Authentication → Settings → Authorized domains in the Firebase console.',
      };
    case 'auth/operation-not-allowed':
      return {
        code: 'provider-disabled',
        message:
          'Google sign-in is not enabled for this Firebase project. Enable it under Authentication → Sign-in method in the Firebase console.',
      };
    case 'auth/user-disabled':
      return { code: 'user-disabled', message: 'This account has been disabled.' };
    default:
      return {
        code: code || 'unknown',
        message: `Sign-in failed${detail ? `: ${detail}` : '.'}`,
      };
  }
}

export class FirebaseAuthService {
  private portPromise: Promise<FirebasePort>;
  private exchange: GatewayTokenExchange;
  private state: FirebaseAuthState = { status: 'logged-out' };
  private listeners = new Set<Listener>();
  /** Guards against stale async completions clobbering newer state. */
  private opSeq = 0;
  /** Single-flight slot for reauthenticateGateway() (401 repair waves). */
  private reauthInFlight: Promise<boolean> | null = null;

  constructor(port: FirebasePort | Promise<FirebasePort>, exchange: GatewayTokenExchange) {
    this.portPromise = Promise.resolve(port);
    this.exchange = exchange;
  }

  get current(): FirebaseAuthState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: FirebaseAuthState): void {
    this.state = next;
    for (const l of [...this.listeners]) {
      try {
        l(next);
      } catch {
        // A listener must never break the state machine.
      }
    }
  }

  /** Begin Google sign-in. Ignored while a sign-in is already in flight. */
  async signInWithGoogle(): Promise<void> {
    if (this.state.status === 'logging-in') return;
    const op = ++this.opSeq;
    this.setState({ status: 'logging-in' });
    try {
      const port = await this.portPromise;
      if (op !== this.opSeq) return;
      if (!port.isConfigured()) {
        throw { code: 'config-missing', message: port.configError() ?? 'Firebase is not configured.' };
      }
      const user: PortUser = await port.signInWithGooglePopup();
      if (op !== this.opSeq) return;
      const idToken = await user.getIdToken();
      if (op !== this.opSeq) return;
      await this.exchange.loginWithFirebaseIdToken(idToken);
      if (op !== this.opSeq) return;
      this.setState({
        status: 'logged-in',
        user: {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
        },
      });
    } catch (e) {
      if (op !== this.opSeq) return;
      // Fail closed: a failed sign-in must never leave a half-authenticated
      // gateway session behind.
      try {
        this.exchange.logout();
      } catch {
        /* best effort */
      }
      this.setState({ status: 'error', error: classifyAuthError(e) });
    }
  }

  /**
   * Delete the Firebase Auth account itself (workspace-settings
   * privacy flow). Outcomes:
   *  - 'deleted': the sign-in account is gone. (The SDK also ends the
   *    local Firebase session; the caller still signs out fully.)
   *  - 'not-applicable': no Firebase session is in play (unconfigured
   *    port, or a gateway session that did not come from Firebase —
   *    e.g. a local dev login). Nothing to delete on this leg.
   *  - 'failed': deletion was attempted and refused. On
   *    'auth/requires-recent-login' the flow re-authenticates inline
   *    (Google popup) and retries exactly once before giving up.
   * Never throws: the caller has usually already deleted the
   * server-side data and must be able to finish signing out.
   */
  async deleteAccount(): Promise<
    | { outcome: 'deleted' }
    | { outcome: 'not-applicable' }
    | { outcome: 'failed'; code: string; message: string }
  > {
    let port: FirebasePort;
    try {
      port = await this.portPromise;
    } catch {
      return { outcome: 'not-applicable' };
    }
    if (!port.isConfigured()) return { outcome: 'not-applicable' };
    let user: PortUser | null = null;
    try {
      user = port.getCurrentUser();
    } catch {
      user = null;
    }
    if (!user) return { outcome: 'not-applicable' };
    try {
      await port.deleteCurrentUser();
      return { outcome: 'deleted' };
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code !== 'auth/requires-recent-login') {
        const info = classifyAuthError(e);
        return { outcome: 'failed', code: info.code, message: info.message };
      }
      // Recent-login required: re-authenticate inline, retry once.
      try {
        await port.reauthenticateCurrentUserWithGoogle();
        await port.deleteCurrentUser();
        return { outcome: 'deleted' };
      } catch (e2) {
        const info = classifyAuthError(e2);
        return { outcome: 'failed', code: info.code, message: info.message };
      }
    }
  }

  /**
   * Sign out: clears the gateway JWT first (the app session), then the
   * Firebase session. A Firebase sign-out failure surfaces as `error`
   * (gateway token already cleared) so the user can retry.
   */
  async signOut(): Promise<void> {
    const op = ++this.opSeq;
    this.exchange.logout();
    try {
      const port = await this.portPromise;
      if (op !== this.opSeq) return;
      await port.signOut();
      if (op !== this.opSeq) return;
      this.setState({ status: 'logged-out' });
    } catch (e) {
      if (op !== this.opSeq) return;
      const info = classifyAuthError(e);
      this.setState({
        status: 'error',
        error: { code: info.code === 'unknown' ? 'signout-failed' : info.code, message: info.message },
      });
    }
  }

  /**
   * Resolve the SDK's persisted-session user. The SDK restores the
   * session ASYNCHRONOUSLY (IndexedDB): getCurrentUser() returns null
   * until the restore settles, and the first onAuthStateChanged
   * emission is the settle signal. Reading the synchronous snapshot at
   * boot raced that restore and — when it lost — left this service
   * logged-out for the whole page lifetime while the stored gateway
   * JWT kept the app working (defect D1: every fresh page load showed
   * "Sign in with Google" to a signed-in user). Fast path first: when
   * the SDK has already settled, no wait is needed.
   */
  private waitForRestoredUser(port: FirebasePort): Promise<PortUser | null> {
    const immediate = port.getCurrentUser();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      let settled = false;
      let unsub: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (u: PortUser | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unsub) {
          try {
            unsub();
          } catch {
            /* listener cleanup is best-effort */
          }
        }
        resolve(u);
      };
      timer = setTimeout(() => {
        // A port that never emits (the real SDK always does): fall back
        // to whatever the synchronous snapshot holds by now.
        finish(port.getCurrentUser());
      }, RESTORE_EMISSION_TIMEOUT_MS);
      unsub = port.onAuthStateChanged((u) => finish(u));
      if (settled) {
        // The port emitted synchronously during subscribe, before the
        // unsubscribe handle was assigned: clean it up now.
        try {
          unsub();
        } catch {
          /* best effort */
        }
      }
    });
  }

  /**
   * Boot-time restore: if the Firebase SDK persisted a user session,
   * exchange a fresh ID token for a gateway JWT, and only then report
   * logged-in — the sign-in state and the gateway token are ONE state
   * (auth coherence ruling, 2026-10-22), so a restored session always
   * lands with a fresh, valid token.
   *
   * No Firebase session: stays logged-out. With `clearOrphanToken`
   * (the Firebase posture — App passes it whenever dev login is NOT
   * enabled), any stored gateway token is cleared too: with no session
   * behind it, that token is an orphan and must not keep the app
   * half-alive while the UI claims signed-out. Where dev login IS
   * enabled, a gateway token legitimately exists with no Firebase
   * session, so the caller leaves the token alone.
   */
  async restoreSession(options?: { clearOrphanToken?: boolean }): Promise<void> {
    if (this.state.status !== 'logged-out') return;
    const op = ++this.opSeq;
    let port: FirebasePort;
    try {
      port = await this.portPromise;
    } catch {
      return;
    }
    if (op !== this.opSeq) return;
    if (!port.isConfigured()) return;
    this.setState({ status: 'logging-in' });
    const user = await this.waitForRestoredUser(port);
    if (op !== this.opSeq) return;
    if (!user) {
      if (options?.clearOrphanToken) {
        try {
          this.exchange.logout();
        } catch {
          /* best effort */
        }
      }
      this.setState({ status: 'logged-out' });
      return;
    }
    try {
      const idToken = await user.getIdToken();
      if (op !== this.opSeq) return;
      await this.exchange.loginWithFirebaseIdToken(idToken);
      if (op !== this.opSeq) return;
      this.setState({
        status: 'logged-in',
        user: {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
        },
      });
    } catch (e) {
      if (op !== this.opSeq) return;
      this.exchange.logout();
      this.setState({ status: 'error', error: classifyAuthError(e) });
    }
  }

  /**
   * Coherence repair (auth ruling, 2026-10-22): the gateway rejected
   * the stored token (401) — the mirror image of D1, where the UI
   * claims signed-in while every API call fails. Wired into
   * GatewayClient as its reauth provider; invoked on a 401.
   *
   * - Live Firebase session (this service is holding or converging to
   *   signed-in): silently re-exchange its ID token for a fresh
   *   gateway JWT — single-flight, exactly one exchange per rejection
   *   wave — and resolve true so the failed call retries once.
   * - No Firebase session: the rejected token is an orphan. Clear it,
   *   and if the service believed itself signed-in, drop to logged-out
   *   in the same motion — the two halves move together, never split.
   *   Resolves false; the 401 surfaces.
   * A service already at logged-out never (re)creates a token here:
   * boot restore owns session establishment.
   */
  async reauthenticateGateway(): Promise<boolean> {
    if (this.reauthInFlight) return this.reauthInFlight;
    const run = this.doReauthenticateGateway();
    this.reauthInFlight = run;
    try {
      return await run;
    } finally {
      if (this.reauthInFlight === run) this.reauthInFlight = null;
    }
  }

  private async doReauthenticateGateway(): Promise<boolean> {
    const op = this.opSeq;
    let port: FirebasePort;
    try {
      port = await this.portPromise;
    } catch {
      return false;
    }
    if (!port.isConfigured()) return false;
    // A restore/sign-in is in flight: it owns convergence (it will
    // exchange for the restored user, or clear an orphan token per the
    // boot posture). A mid-flight read of getCurrentUser() can be a
    // not-yet-restored null — never clear from here on it.
    if (this.state.status === 'logging-in') return false;
    const user = port.getCurrentUser();
    if (!user || this.state.status === 'logged-out') {
      try {
        this.exchange.logout();
      } catch {
        /* best effort */
      }
      if (this.state.status === 'logged-in') {
        // Converge the UI half in the same motion as the token clear.
        this.opSeq++;
        this.setState({ status: 'logged-out' });
      }
      return false;
    }
    try {
      const idToken = await user.getIdToken();
      await this.exchange.loginWithFirebaseIdToken(idToken);
    } catch {
      return false;
    }
    if (op !== this.opSeq) {
      // A newer auth op (explicit sign-in / sign-out) superseded this
      // repair while the exchange was in flight: do not leave the fresh
      // token behind as an orphan of that newer state.
      try {
        this.exchange.logout();
      } catch {
        /* best effort */
      }
      return false;
    }
    return true;
  }
}
