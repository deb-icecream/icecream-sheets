/**
 * Firebase auth state machine + gateway token-exchange tests
 * (Cycle 9, Phase 1 — web login).
 *
 * Firebase is fully mocked: a fake FirebasePort stands in for the SDK, and
 * fetch is stubbed for the GatewayClient exchange. No test hits real
 * Firebase or a real gateway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FirebaseAuthService,
  classifyAuthError,
  type FirebaseAuthState,
} from './firebaseAuth';
import type { FirebasePort, PortUser } from './firebasePort';
import { GatewayAuthError, GatewayClient } from './gatewayClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function fakeUser(overrides: Partial<PortUser> = {}): PortUser {
  return {
    uid: 'firebase-uid-1',
    email: 'user@example.com',
    displayName: 'Test User',
    photoURL: 'https://example.com/pic.png',
    getIdToken: () => Promise.resolve('fake-id-token'),
    ...overrides,
  };
}

interface PopupOutcome {
  kind: 'user';
  user: PortUser;
}

class FakePort implements FirebasePort {
  configured = true;
  popup: PopupOutcome | { kind: 'error'; code: string; message: string } = {
    kind: 'user',
    user: fakeUser(),
  };
  signOutError: { code: string; message: string } | null = null;
  currentUser: PortUser | null = null;
  popupCalls = 0;
  signOutCalls = 0;
  /** deleteUser outcomes consumed in order; empty queue = success. */
  deleteOutcomes: Array<{ code: string; message: string }> = [];
  reauthError: { code: string; message: string } | null = null;
  deleteCalls = 0;
  reauthCalls = 0;
  listeners = new Set<(u: PortUser | null) => void>();

  isConfigured(): boolean {
    return this.configured;
  }
  configError(): string | null {
    return this.configured ? null : 'Firebase Google sign-in is not configured. Missing: VITE_FIREBASE_API_KEY.';
  }
  async signInWithGooglePopup(): Promise<PortUser> {
    this.popupCalls++;
    // Let the logging-in state become observable before settling.
    await new Promise((r) => setTimeout(r, 5));
    if (this.popup.kind === 'error') {
      const e = new Error(this.popup.message) as Error & { code: string };
      e.code = this.popup.code;
      throw e;
    }
    return this.popup.user;
  }
  async signOut(): Promise<void> {
    this.signOutCalls++;
    if (this.signOutError) {
      const e = new Error(this.signOutError.message) as Error & { code: string };
      e.code = this.signOutError.code;
      throw e;
    }
  }
  async deleteCurrentUser(): Promise<void> {
    this.deleteCalls++;
    const failure = this.deleteOutcomes.shift();
    if (failure) {
      const e = new Error(failure.message) as Error & { code: string };
      e.code = failure.code;
      throw e;
    }
    this.currentUser = null;
  }
  async reauthenticateCurrentUserWithGoogle(): Promise<void> {
    this.reauthCalls++;
    if (this.reauthError) {
      const e = new Error(this.reauthError.message) as Error & { code: string };
      e.code = this.reauthError.code;
      throw e;
    }
  }
  getCurrentUser(): PortUser | null {
    return this.currentUser;
  }
  /**
   * Mirrors the real SDK: subscribing schedules ONE asynchronous
   * emission carrying the then-current user — the SDK's "persisted
   * session restore has settled" signal. Tests that drive the restore
   * race by hand set autoEmit = false and use emit() instead.
   */
  autoEmit = true;
  onAuthStateChanged(cb: (u: PortUser | null) => void): () => void {
    this.listeners.add(cb);
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (this.autoEmit) {
      timer = setTimeout(() => {
        if (this.listeners.has(cb)) cb(this.currentUser);
      }, 0);
    }
    return () => {
      if (timer) clearTimeout(timer);
      this.listeners.delete(cb);
    };
  }
  /** Push an auth-state emission to all current listeners. */
  emit(user: PortUser | null): void {
    this.currentUser = user;
    for (const cb of [...this.listeners]) cb(user);
  }
}

function fakeExchange() {
  return {
    loginWithFirebaseIdToken: vi.fn((_idToken: string): Promise<void> => Promise.resolve()),
    logout: vi.fn((): void => {}),
  };
}

function trackStates(svc: FirebaseAuthService): FirebaseAuthState[] {
  const seen: FirebaseAuthState[] = [svc.current];
  svc.subscribe((s) => seen.push(s));
  return seen;
}

// ---------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------

describe('FirebaseAuthService state machine', () => {
  it('logged-out → logging-in → logged-in on Google sign-in success', async () => {
    const port = new FakePort();
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    const seen = trackStates(svc);

    await svc.signInWithGoogle();

    expect(seen.map((s) => s.status)).toEqual(['logged-out', 'logging-in', 'logged-in']);
    const st = svc.current;
    expect(st.status).toBe('logged-in');
    if (st.status === 'logged-in') {
      expect(st.user.uid).toBe('firebase-uid-1');
      expect(st.user.displayName).toBe('Test User');
      expect(st.user.email).toBe('user@example.com');
    }
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledTimes(1);
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledWith('fake-id-token');
    expect(exchange.logout).not.toHaveBeenCalled();
  });

  it('ignores a second sign-in while one is in flight', async () => {
    const port = new FakePort();
    const svc = new FirebaseAuthService(port, fakeExchange());
    const p1 = svc.signInWithGoogle();
    const p2 = svc.signInWithGoogle();
    await Promise.all([p1, p2]);
    expect(port.popupCalls).toBe(1);
    expect(svc.current.status).toBe('logged-in');
  });

  it('popup blocked → error state with a friendly message; fail-closed on the gateway token', async () => {
    const port = new FakePort();
    port.popup = { kind: 'error', code: 'auth/popup-blocked', message: 'popup blocked by browser' };
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);

    await svc.signInWithGoogle();

    const st = svc.current;
    expect(st.status).toBe('error');
    if (st.status === 'error') {
      expect(st.error.code).toBe('popup-blocked');
      expect(st.error.message).toMatch(/popup/i);
    }
    // Fail closed: any half-set gateway token is cleared.
    expect(exchange.logout).toHaveBeenCalled();
  });

  it('maps common Firebase failures to stable codes', async () => {
    const cases: [string, string][] = [
      ['auth/popup-closed-by-user', 'popup-closed'],
      ['auth/cancelled-popup-request', 'popup-closed'],
      ['auth/network-request-failed', 'network'],
      ['auth/unauthorized-domain', 'unauthorized-domain'],
      ['auth/operation-not-allowed', 'provider-disabled'],
    ];
    for (const [sdkCode, want] of cases) {
      const port = new FakePort();
      port.popup = { kind: 'error', code: sdkCode, message: 'boom' };
      const svc = new FirebaseAuthService(port, fakeExchange());
      await svc.signInWithGoogle();
      const st = svc.current;
      expect(st.status).toBe('error');
      if (st.status === 'error') expect(st.error.code).toBe(want);
    }
  });

  it('missing Firebase config → config-missing error naming the setup', async () => {
    const port = new FakePort();
    port.configured = false;
    const svc = new FirebaseAuthService(port, fakeExchange());
    await svc.signInWithGoogle();
    const st = svc.current;
    expect(st.status).toBe('error');
    if (st.status === 'error') {
      expect(st.error.code).toBe('config-missing');
      expect(st.error.message).toMatch(/VITE_FIREBASE/);
    }
  });

  it('gateway exchange failure → error state and the gateway token is cleared', async () => {
    const port = new FakePort();
    const exchange = fakeExchange();
    exchange.loginWithFirebaseIdToken.mockRejectedValueOnce(
      new GatewayAuthError('firebase login is not configured on the gateway'),
    );
    const svc = new FirebaseAuthService(port, exchange);
    await svc.signInWithGoogle();
    const st = svc.current;
    expect(st.status).toBe('error');
    if (st.status === 'error') {
      expect(st.error.message).toMatch(/gateway/);
    }
    expect(exchange.logout).toHaveBeenCalled();
  });

  it('retry from the error state works', async () => {
    const port = new FakePort();
    port.popup = { kind: 'error', code: 'auth/popup-blocked', message: 'blocked' };
    const svc = new FirebaseAuthService(port, fakeExchange());
    await svc.signInWithGoogle();
    expect(svc.current.status).toBe('error');
    port.popup = { kind: 'user', user: fakeUser() };
    await svc.signInWithGoogle();
    expect(svc.current.status).toBe('logged-in');
  });

  it('logged-in → logged-out on signOut; gateway + Firebase sessions both cleared', async () => {
    const port = new FakePort();
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    await svc.signInWithGoogle();
    expect(svc.current.status).toBe('logged-in');

    await svc.signOut();

    expect(svc.current).toEqual({ status: 'logged-out' });
    expect(exchange.logout).toHaveBeenCalled();
    expect(port.signOutCalls).toBe(1);
  });

  it('Firebase signOut failure → error state, but the gateway token is still cleared', async () => {
    const port = new FakePort();
    port.signOutError = { code: 'auth/network-request-failed', message: 'offline' };
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    await svc.signInWithGoogle();
    await svc.signOut();
    const st = svc.current;
    expect(st.status).toBe('error');
    expect(exchange.logout).toHaveBeenCalled();
  });

  it('restoreSession is a silent no-op with no persisted Firebase user', async () => {
    const port = new FakePort();
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    await svc.restoreSession();
    expect(svc.current).toEqual({ status: 'logged-out' });
    expect(exchange.loginWithFirebaseIdToken).not.toHaveBeenCalled();
  });

  it('restoreSession exchanges a persisted Firebase user for a gateway JWT', async () => {
    const port = new FakePort();
    port.currentUser = fakeUser({ uid: 'restored-uid' });
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    const seen = trackStates(svc);
    await svc.restoreSession();
    expect(seen.map((s) => s.status)).toEqual(['logged-out', 'logging-in', 'logged-in']);
    const st = svc.current;
    expect(st.status).toBe('logged-in');
    if (st.status === 'logged-in') expect(st.user.uid).toBe('restored-uid');
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledWith('fake-id-token');
  });

  it('restoreSession failure → error state with the gateway token cleared', async () => {
    const port = new FakePort();
    port.currentUser = fakeUser();
    const exchange = fakeExchange();
    exchange.loginWithFirebaseIdToken.mockRejectedValueOnce(new Error('gateway down'));
    const svc = new FirebaseAuthService(port, exchange);
    await svc.restoreSession();
    expect(svc.current.status).toBe('error');
    expect(exchange.logout).toHaveBeenCalled();
  });

  it('a stale in-flight sign-in cannot clobber a newer signOut', async () => {
    const port = new FakePort();
    const svc = new FirebaseAuthService(port, fakeExchange());
    const p = svc.signInWithGoogle(); // in flight (5ms popup delay)
    await svc.signOut(); // newer op wins
    await p;
    expect(svc.current).toEqual({ status: 'logged-out' });
  });

  it('listeners can unsubscribe', async () => {
    const port = new FakePort();
    const svc = new FirebaseAuthService(port, fakeExchange());
    let calls = 0;
    const unsub = svc.subscribe(() => calls++);
    unsub();
    await svc.signInWithGoogle();
    expect(calls).toBe(0);
  });
});

describe('restoreSession — the async-restore race (D1) + boot coherence', () => {
  it('waits for the SDK restore: null snapshot at call time, user emitted shortly after → logged-in, exactly one exchange', async () => {
    const port = new FakePort();
    port.autoEmit = false; // SDK has not settled yet
    port.currentUser = null; // synchronous snapshot races the restore
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    const seen = trackStates(svc);

    const p = svc.restoreSession();
    await new Promise((r) => setTimeout(r, 10));
    // Still waiting on the settle signal: no exchange, no verdict.
    expect(exchange.loginWithFirebaseIdToken).not.toHaveBeenCalled();
    expect(svc.current.status).toBe('logging-in');

    port.emit(fakeUser({ uid: 'restored-late' }));
    await p;

    expect(seen.map((s) => s.status)).toEqual(['logged-out', 'logging-in', 'logged-in']);
    const st = svc.current;
    expect(st.status).toBe('logged-in');
    if (st.status === 'logged-in') expect(st.user.uid).toBe('restored-late');
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledTimes(1);
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledWith('fake-id-token');

    // Unsubscribed after the first emission: later emissions cannot
    // re-exchange.
    port.emit(fakeUser({ uid: 'someone-else' }));
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledTimes(1);
    expect(svc.current.status).toBe('logged-in');
  });

  it('a null emission leaves it logged-out and exchanges nothing', async () => {
    const port = new FakePort();
    port.autoEmit = false;
    port.currentUser = null;
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    const p = svc.restoreSession();
    await new Promise((r) => setTimeout(r, 5));
    port.emit(null);
    await p;
    expect(svc.current).toEqual({ status: 'logged-out' });
    expect(exchange.loginWithFirebaseIdToken).not.toHaveBeenCalled();
  });

  it('no session + clearOrphanToken → the stored gateway token is cleared (no orphan half-life)', async () => {
    const port = new FakePort();
    port.autoEmit = false;
    port.currentUser = null;
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    const p = svc.restoreSession({ clearOrphanToken: true });
    await new Promise((r) => setTimeout(r, 5));
    port.emit(null);
    await p;
    expect(svc.current).toEqual({ status: 'logged-out' });
    expect(exchange.logout).toHaveBeenCalledTimes(1);
    expect(exchange.loginWithFirebaseIdToken).not.toHaveBeenCalled();
  });

  it('no session without clearOrphanToken leaves the token alone (dev-login posture)', async () => {
    const port = new FakePort();
    port.currentUser = null;
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    await svc.restoreSession();
    expect(svc.current).toEqual({ status: 'logged-out' });
    expect(exchange.logout).not.toHaveBeenCalled();
  });

  it('resolves through the timeout fallback when the port never emits', async () => {
    vi.useFakeTimers();
    try {
      const port = new FakePort();
      port.autoEmit = false;
      port.currentUser = null;
      const exchange = fakeExchange();
      const svc = new FirebaseAuthService(port, exchange);
      const p = svc.restoreSession();
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(svc.current).toEqual({ status: 'logged-out' });
      expect(exchange.loginWithFirebaseIdToken).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reauthenticateGateway — 401 coherence repair (split direction 2)', () => {
  async function signedInSvc() {
    const port = new FakePort();
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    await svc.signInWithGoogle();
    // The SDK's live session user (sign-in does not set the fake's
    // snapshot; a real SDK would hold it after the popup flow).
    port.currentUser = fakeUser();
    exchange.loginWithFirebaseIdToken.mockClear();
    exchange.logout.mockClear();
    return { port, exchange, svc };
  }

  it('live Firebase session → one silent re-exchange, resolves true, stays logged-in', async () => {
    const { exchange, svc } = await signedInSvc();
    await expect(svc.reauthenticateGateway()).resolves.toBe(true);
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledTimes(1);
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledWith('fake-id-token');
    expect(exchange.logout).not.toHaveBeenCalled();
    expect(svc.current.status).toBe('logged-in');
  });

  it('concurrent repairs single-flight to exactly one exchange', async () => {
    const { exchange, svc } = await signedInSvc();
    const results = await Promise.all([
      svc.reauthenticateGateway(),
      svc.reauthenticateGateway(),
      svc.reauthenticateGateway(),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledTimes(1);
  });

  it('Firebase session dead while the UI is signed-in → token cleared and logged-out together', async () => {
    const { port, exchange, svc } = await signedInSvc();
    port.currentUser = null; // the Firebase session ended elsewhere
    await expect(svc.reauthenticateGateway()).resolves.toBe(false);
    expect(exchange.loginWithFirebaseIdToken).not.toHaveBeenCalled();
    expect(exchange.logout).toHaveBeenCalledTimes(1);
    expect(svc.current).toEqual({ status: 'logged-out' });
  });

  it('a logged-out service never resurrects a token, even with a Firebase user present', async () => {
    const port = new FakePort();
    port.currentUser = fakeUser();
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    await expect(svc.reauthenticateGateway()).resolves.toBe(false);
    expect(exchange.loginWithFirebaseIdToken).not.toHaveBeenCalled();
    // The orphan token presented with the rejected call is cleared.
    expect(exchange.logout).toHaveBeenCalledTimes(1);
    expect(svc.current).toEqual({ status: 'logged-out' });
  });

  it('a repair superseded by signOut mid-exchange clears its fresh token again', async () => {
    const { exchange, svc } = await signedInSvc();
    let release!: () => void;
    exchange.loginWithFirebaseIdToken.mockImplementation(
      () => new Promise<void>((res) => { release = res; }),
    );
    const repair = svc.reauthenticateGateway();
    // Wait until the repair is parked inside the exchange.
    await vi.waitFor(() =>
      expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledTimes(1),
    );
    await svc.signOut(); // the newer op wins (clears the token once)
    release();
    await expect(repair).resolves.toBe(false);
    // …and the superseded repair cleared its own fresh token too.
    expect(exchange.logout).toHaveBeenCalledTimes(2);
    expect(svc.current).toEqual({ status: 'logged-out' });
  });

  it('a transient exchange failure resolves false and leaves a live session signed-in', async () => {
    const { exchange, svc } = await signedInSvc();
    exchange.loginWithFirebaseIdToken.mockRejectedValueOnce(new Error('gateway down'));
    await expect(svc.reauthenticateGateway()).resolves.toBe(false);
    expect(svc.current.status).toBe('logged-in');
  });

  it('a restore in flight owns convergence: no clear, no exchange from a 401 repair', async () => {
    const port = new FakePort();
    port.autoEmit = false; // the SDK restore has not emitted yet
    const exchange = fakeExchange();
    const svc = new FirebaseAuthService(port, exchange);
    const restore = svc.restoreSession({ clearOrphanToken: true });
    await vi.waitFor(() => expect(svc.current.status).toBe('logging-in'));
    // A proxied route 401s mid-restore (its credential type is refused
    // by design in signed mode). The repair must not read the
    // not-yet-restored null as a dead session and clear the token.
    await expect(svc.reauthenticateGateway()).resolves.toBe(false);
    expect(exchange.logout).not.toHaveBeenCalled();
    expect(exchange.loginWithFirebaseIdToken).not.toHaveBeenCalled();
    // Settle the restore: the session lands signed-in, one exchange.
    port.emit(fakeUser({ uid: 'restored' }));
    await restore;
    expect(svc.current.status).toBe('logged-in');
    expect(exchange.loginWithFirebaseIdToken).toHaveBeenCalledTimes(1);
  });
});

describe('classifyAuthError', () => {
  it('keeps the config-missing detail message intact', () => {
    const info = classifyAuthError({ code: 'config-missing', message: 'set VITE_FIREBASE_API_KEY' });
    expect(info.code).toBe('config-missing');
    expect(info.message).toMatch(/VITE_FIREBASE_API_KEY/);
  });

  it('falls back to unknown with the raw message for unrecognized failures', () => {
    const info = classifyAuthError(new Error('weird'));
    expect(info.code).toBe('unknown');
    expect(info.message).toMatch(/weird/);
  });
});

// ---------------------------------------------------------------------------
// GatewayClient Firebase exchange (token handling)
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

describe('GatewayClient.loginWithFirebaseIdToken', () => {
  it('POSTs the ID token to /auth/firebase and stores the gateway JWT', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { token: 'gateway-jwt' })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GatewayClient('http://127.0.0.1:8100/');

    await client.loginWithFirebaseIdToken('firebase-id-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8100/auth/firebase');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ idToken: 'firebase-id-token' });
    expect(client.getToken()).toBe('gateway-jwt');
    expect(client.loggedIn).toBe(true);
  });

  it('503 → clear "gateway not configured" error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(503, 'not configured'))));
    const client = new GatewayClient('http://127.0.0.1:8100');
    await expect(client.loginWithFirebaseIdToken('tok')).rejects.toThrow(GatewayAuthError);
    await expect(client.loginWithFirebaseIdToken('tok')).rejects.toThrow(/FIREBASE_PROJECT_ID/);
    expect(client.loggedIn).toBe(false);
  });

  it('401 → the ID token was rejected (no token stored)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(401, 'invalid firebase id token'))));
    const client = new GatewayClient('http://127.0.0.1:8100');
    await expect(client.loginWithFirebaseIdToken('bad')).rejects.toThrow(/rejected/);
    expect(client.getToken()).toBeNull();
  });

  it('unreachable gateway → GatewayAuthError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    const client = new GatewayClient('http://127.0.0.1:8100');
    await expect(client.loginWithFirebaseIdToken('tok')).rejects.toThrow(/cannot reach the gateway/);
  });

  it('missing ID token is rejected before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new GatewayClient('http://127.0.0.1:8100');
    await expect(client.loginWithFirebaseIdToken('')).rejects.toThrow(/missing Firebase ID token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteAccount (workspace-settings privacy flow)
// ---------------------------------------------------------------------------

describe('FirebaseAuthService.deleteAccount', () => {
  it('not-applicable when no Firebase user is signed in', async () => {
    const port = new FakePort();
    port.currentUser = null;
    const svc = new FirebaseAuthService(port, fakeExchange());
    expect(await svc.deleteAccount()).toEqual({ outcome: 'not-applicable' });
    expect(port.deleteCalls).toBe(0);
  });

  it('not-applicable when the port is unconfigured', async () => {
    const port = new FakePort();
    port.configured = false;
    port.currentUser = fakeUser();
    const svc = new FirebaseAuthService(port, fakeExchange());
    expect(await svc.deleteAccount()).toEqual({ outcome: 'not-applicable' });
    expect(port.deleteCalls).toBe(0);
  });

  it('deleted on the direct path', async () => {
    const port = new FakePort();
    port.currentUser = fakeUser();
    const svc = new FirebaseAuthService(port, fakeExchange());
    expect(await svc.deleteAccount()).toEqual({ outcome: 'deleted' });
    expect(port.deleteCalls).toBe(1);
    expect(port.reauthCalls).toBe(0);
  });

  it('requires-recent-login → re-authenticates inline and retries once', async () => {
    const port = new FakePort();
    port.currentUser = fakeUser();
    port.deleteOutcomes = [
      { code: 'auth/requires-recent-login', message: 'This operation is sensitive and requires recent authentication.' },
    ];
    const svc = new FirebaseAuthService(port, fakeExchange());
    expect(await svc.deleteAccount()).toEqual({ outcome: 'deleted' });
    expect(port.deleteCalls).toBe(2);
    expect(port.reauthCalls).toBe(1);
  });

  it('failed when the re-auth popup is dismissed', async () => {
    const port = new FakePort();
    port.currentUser = fakeUser();
    port.deleteOutcomes = [
      { code: 'auth/requires-recent-login', message: 'recent login required' },
    ];
    port.reauthError = { code: 'auth/popup-closed-by-user', message: 'The popup has been closed by the user.' };
    const svc = new FirebaseAuthService(port, fakeExchange());
    const r = await svc.deleteAccount();
    expect(r.outcome).toBe('failed');
    if (r.outcome === 'failed') expect(r.code).toBe('popup-closed');
    expect(port.deleteCalls).toBe(1);
    expect(port.reauthCalls).toBe(1);
  });

  it('failed (no re-auth attempt) on other errors', async () => {
    const port = new FakePort();
    port.currentUser = fakeUser();
    port.deleteOutcomes = [{ code: 'auth/network-request-failed', message: 'offline' }];
    const svc = new FirebaseAuthService(port, fakeExchange());
    const r = await svc.deleteAccount();
    expect(r.outcome).toBe('failed');
    if (r.outcome === 'failed') expect(r.code).toBe('network');
    expect(port.reauthCalls).toBe(0);
  });
});
