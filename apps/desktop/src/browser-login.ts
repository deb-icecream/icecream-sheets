/**
 * System-browser sign-in flow (Issue #78: desktop sign-in must surface
 * the Google ACCOUNT CHOOSER, not the email-first form).
 *
 * The embedded login window is a fresh browsing context with no Google
 * session, so Google serves its typed-email flow there; the chooser only
 * appears in a context that already holds a Google session — the user's
 * DEFAULT BROWSER. This module owns the browser half of the flow:
 *
 *   1. main opens the login window (the single begin owner, #83) and
 *      starts this flow; the flow mints a single-use NONCE bound to the
 *      attempt and hands main the browser URL.
 *   2. main opens that URL in the system browser (shell.openExternal).
 *      The URL is the EXISTING loopback login page (#53) carrying the
 *      nonce as a query parameter; the login server serves it the
 *      browser-mode page variant (the nonce is baked into that variant
 *      only — the embedded window's page never contains it).
 *   3. The browser page runs the same Firebase Google popup — in the
 *      browser's cookie context, so the user gets the account chooser —
 *      and POSTs the resulting Firebase ID token back to the login
 *      server's /auth/complete route with the nonce.
 *   4. handleComplete() verifies + BURNS the nonce, then runs the token
 *      through completeFirebaseLogin() (auth-ipc.ts) — the exact same
 *      completion routine the embedded window's IPC uses. There is no
 *      second exchange path.
 *
 * Abandonment can never wedge sign-in (#80's lesson, applied to the new
 * surface). Three independent paths free the attempt, all through the
 * state machine's existing failLogin():
 *  - the browser page reports the user abandoned the Google popup
 *    (/auth/cancel route → handleCancel);
 *  - the bounded wait expires (default 5 minutes → timeout);
 *  - main cancels the flow when the login window closes.
 * failLogin() no-ops unless a login is in flight, so a late cancel can
 * never knock out a completed session, and a completed flow ignores
 * cancel() entirely.
 *
 * Nonce discipline: 256 bits from crypto.randomBytes, minted per
 * attempt, compared exactly, and consumed BEFORE the token exchange
 * runs — a completion attempt (success or failure) can never be
 * replayed. A wrong nonce is rejected WITHOUT disarming the flow, so a
 * stray local POST cannot kill the user's real attempt. The exchanged
 * credential is still validated by the gateway (signature, project,
 * expiry) before any JWT is minted, exactly as in the embedded flow.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';
import type { DesktopAuthState } from './auth-state';
import { humanAuthError, type FirebaseLoginResult } from './auth-ipc';

/** Default bounded wait for the user to finish in the browser: 5 minutes. */
export const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** The login page reports the user closed/cancelled the Google popup. */
export const BROWSER_LOGIN_CANCELLED_MESSAGE = 'Sign-in was cancelled before completing.';

/** The bounded wait ran out before the browser returned a credential. */
export const BROWSER_LOGIN_TIMEOUT_MESSAGE = 'Sign-in timed out before completing. Please try again.';

export interface BrowserLoginCompleteRequest {
  flow: unknown;
  idToken: unknown;
}

export type BrowserLoginCompleteOutcome =
  | { ok: true; principal: string | null }
  | {
      ok: false;
      /** no-flow: nothing pending (replay / already settled). bad-nonce: wrong flow id. exchange: the shared completion routine refused/failed. */
      reason: 'no-flow' | 'bad-nonce' | 'exchange';
      error: string;
    };

export interface BrowserLoginFlowDeps {
  /** The shared auth state machine (main.ts owns the instance). */
  authState: DesktopAuthState;
  /**
   * The shared Firebase completion routine (completeFirebaseLogin from
   * auth-ipc.ts, pre-bound by main with its rebuildMenu/exchange deps).
   */
  completeLogin: (idToken: string) => Promise<FirebaseLoginResult>;
  /** Bounded wait before the attempt frees itself. Default 5 minutes. */
  timeoutMs?: number;
  /** Injected for tests. Defaults to crypto.randomBytes. */
  randomBytes?: (n: number) => Buffer;
  /** Injected for tests. Defaults to the global timers. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class BrowserLoginFlow {
  private readonly deps: BrowserLoginFlowDeps;
  private pendingNonce: string | null = null;
  private timer: unknown = null;

  constructor(deps: BrowserLoginFlowDeps) {
    this.deps = deps;
  }

  /** The nonce of the in-flight attempt, or null when none is pending. */
  get pendingFlow(): string | null {
    return this.pendingNonce;
  }

  get isPending(): boolean {
    return this.pendingNonce !== null;
  }

  /**
   * Arm a fresh attempt: mint its nonce and start the bounded wait.
   * Starting a new attempt supersedes (silently disarms) any previous
   * one — main only starts a flow when it opens the login window, which
   * itself joins rather than duplicates an in-flight login (#83).
   * Returns the nonce to bind into the browser URL + page.
   */
  start(): string {
    this.disarm();
    const rand = this.deps.randomBytes ?? nodeRandomBytes;
    const nonce = rand(32).toString('base64url');
    this.pendingNonce = nonce;
    const timeoutMs = this.deps.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS;
    const setTimer =
      this.deps.setTimer ??
      ((fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        // The wait must never keep the app process alive on its own.
        (t as { unref?: () => void }).unref?.();
        return t;
      });
    this.timer = setTimer(() => {
      if (this.pendingNonce !== nonce) return; // superseded / settled
      this.disarm();
      this.deps.authState.failLogin(BROWSER_LOGIN_TIMEOUT_MESSAGE);
    }, timeoutMs);
    return nonce;
  }

  /** The system-browser URL: the login page origin + the flow nonce. */
  browserUrl(origin: string): string {
    if (this.pendingNonce === null) {
      throw new Error('browser login: no flow in progress — call start() first');
    }
    const base = origin.replace(/\/+$/, '');
    return `${base}/login?flow=${encodeURIComponent(this.pendingNonce)}`;
  }

  /**
   * The /auth/complete route: the browser page returns its Firebase ID
   * token. A matching nonce is BURNED before the exchange runs, so the
   * attempt settles exactly once whatever the outcome. The token then
   * goes through the shared completion routine — the same one the
   * embedded window's auth:loginWithFirebase IPC runs.
   */
  async handleComplete(req: BrowserLoginCompleteRequest): Promise<BrowserLoginCompleteOutcome> {
    if (this.pendingNonce === null) {
      return { ok: false, reason: 'no-flow', error: 'No sign-in is in progress.' };
    }
    if (typeof req.flow !== 'string' || req.flow !== this.pendingNonce) {
      // Rejected WITHOUT disarming: the real browser attempt may still
      // be in flight; a stray or forged POST must not cancel it.
      return { ok: false, reason: 'bad-nonce', error: 'This sign-in link is not the current one.' };
    }
    if (typeof req.idToken !== 'string' || req.idToken.length === 0) {
      return { ok: false, reason: 'bad-nonce', error: 'No credential was returned.' };
    }
    const idToken = req.idToken;
    this.disarm(); // single-use: burn before the exchange, success or failure
    const result = await this.deps.completeLogin(idToken);
    if (result.loggedIn) {
      return { ok: true, principal: result.principal };
    }
    return {
      ok: false,
      reason: 'exchange',
      error: result.error ?? 'Sign-in failed. Please try again.',
    };
  }

  /**
   * The /auth/cancel route: the browser page's signInWithPopup rejected
   * as abandoned (user closed the popup / a second request superseded
   * it) — the exact signal, from the page whose promise rejected. Frees
   * the attempt via failLogin so the next sign-in starts fresh (#80).
   * A mismatched nonce is ignored (it is not this attempt's page).
   */
  handleCancel(req: { flow: unknown }): void {
    if (this.pendingNonce === null) return;
    if (typeof req.flow !== 'string' || req.flow !== this.pendingNonce) return;
    this.cancel(BROWSER_LOGIN_CANCELLED_MESSAGE);
  }

  /**
   * main-side teardown (the login window closed, a new window supersedes
   * this flow): disarm and fail any in-flight login. No-op once the
   * attempt has settled — in particular after a successful completion,
   * where failLogin must never run against a live session.
   */
  cancel(message: string): void {
    if (this.pendingNonce === null) return;
    this.disarm();
    this.deps.authState.failLogin(message);
  }

  private disarm(): void {
    this.pendingNonce = null;
    if (this.timer !== null) {
      const clear = this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as never));
      try {
        clear(this.timer);
      } catch {
        // A timer that cannot be cleared is harmless: its callback
        // re-checks the nonce and no-ops once the flow has settled.
      }
      this.timer = null;
    }
  }
}

/**
 * Humanize an unexpected throw from the completion callback into the
 * message the browser page may show. completeFirebaseLogin already
 * returns humanized results instead of throwing; this is belt-and-braces
 * for the route boundary so no raw internal string can reach the page.
 */
export function browserCompleteErrorMessage(error: unknown): string {
  return humanAuthError(error);
}
