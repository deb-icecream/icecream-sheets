/**
 * System-browser sign-in flow tests (Issue #78).
 *
 * The flow is exercised with a REAL DesktopAuthState and the REAL
 * shared completion routine (completeFirebaseLogin from auth-ipc.ts,
 * with the gateway exchange stubbed) — so these tests pin that the
 * browser return path lands in exactly the completion path the embedded
 * window uses, under the auth machine's ownership rules (#83: the
 * window owns the begin; completions join).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/icecream-browser-login-test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Uint8Array) => Buffer.from(b).toString('utf8'),
  },
}));

const { BrowserLoginFlow, BROWSER_LOGIN_TIMEOUT_MESSAGE } = await import('../src/browser-login.js');
const { completeFirebaseLogin } = await import('../src/auth-ipc.js');
const { DesktopAuthState } = await import('../src/auth-state.js');

/** Deterministic nonce source: distinct bytes per call. */
function makeRandom() {
  let counter = 0;
  return (n: number) => {
    counter += 1;
    return Buffer.alloc(n, counter);
  };
}

/** Manual timer capture: the test fires the timeout when it chooses. */
function makeTimers() {
  let pending: (() => void) | null = null;
  let cleared = false;
  return {
    setTimer: (fn: () => void) => {
      pending = fn;
      cleared = false;
      return { fn };
    },
    clearTimer: () => {
      cleared = true;
      pending = null;
    },
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get cleared() {
      return cleared;
    },
    get armed() {
      return pending !== null;
    },
  };
}

function makeFlow(opts?: { exchangeImpl?: () => Promise<{ loggedIn: boolean; principal: string | null }> }) {
  const authState = new DesktopAuthState();
  const timers = makeTimers();
  const exchangeFn = vi.fn(
    opts?.exchangeImpl ?? (async () => ({ loggedIn: true, principal: 'user:uid-1' })),
  );
  const rebuildMenu = vi.fn();
  const flow = new BrowserLoginFlow({
    authState,
    completeLogin: (idToken) =>
      completeFirebaseLogin(authState, idToken, {
        rebuildMenu,
        loginWithFirebaseFn: exchangeFn as never,
      }),
    timeoutMs: 60_000,
    randomBytes: makeRandom(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { flow, authState, timers, exchangeFn, rebuildMenu };
}

describe('BrowserLoginFlow', () => {
  it('browserUrl carries the minted nonce on the login page path', () => {
    const { flow } = makeFlow();
    expect(() => flow.browserUrl('http://localhost:51234')).toThrow(/no flow in progress/);
    const nonce = flow.start();
    expect(flow.pendingFlow).toBe(nonce);
    expect(flow.browserUrl('http://localhost:51234')).toBe(
      `http://localhost:51234/login?flow=${encodeURIComponent(nonce)}`,
    );
    expect(nonce.length).toBeGreaterThanOrEqual(32);
  });

  it('begin (window) → browser completion lands logged-in through the shared routine', async () => {
    const { flow, authState, exchangeFn, rebuildMenu } = makeFlow();
    authState.beginLogin(); // openLoginWindow owns the begin (#83)
    const nonce = flow.start();

    const outcome = await flow.handleComplete({ flow: nonce, idToken: 'fake.firebase.id-token' });

    expect(outcome).toEqual({ ok: true, principal: 'user:uid-1' });
    expect(exchangeFn).toHaveBeenCalledWith('fake.firebase.id-token');
    expect(rebuildMenu).toHaveBeenCalledTimes(1);
    expect(authState.snapshot()).toEqual({ phase: 'logged-in', principal: 'user:uid-1', error: null });
    expect(flow.isPending).toBe(false);
  });

  it('the nonce is single-use: a replayed completion is rejected and never re-exchanges', async () => {
    const { flow, authState, exchangeFn } = makeFlow();
    authState.beginLogin();
    const nonce = flow.start();
    await flow.handleComplete({ flow: nonce, idToken: 'fake.firebase.id-token' });

    const replay = await flow.handleComplete({ flow: nonce, idToken: 'fake.firebase.id-token' });
    expect(replay).toEqual({ ok: false, reason: 'no-flow', error: expect.any(String) });
    expect(exchangeFn).toHaveBeenCalledTimes(1);
    // The settled session is untouched by the replay.
    expect(authState.snapshot().phase).toBe('logged-in');
  });

  it('a wrong nonce is rejected WITHOUT disarming the real attempt', async () => {
    const { flow, authState, exchangeFn } = makeFlow();
    authState.beginLogin();
    const nonce = flow.start();

    const bad = await flow.handleComplete({ flow: 'forged-nonce', idToken: 'x.y.z' });
    expect(bad).toEqual({ ok: false, reason: 'bad-nonce', error: expect.any(String) });
    expect(exchangeFn).not.toHaveBeenCalled();
    expect(flow.isPending).toBe(true);
    expect(authState.snapshot().phase).toBe('logging-in');

    // The genuine browser return still completes afterwards.
    const good = await flow.handleComplete({ flow: nonce, idToken: 'fake.firebase.id-token' });
    expect(good.ok).toBe(true);
    expect(authState.snapshot().phase).toBe('logged-in');
  });

  it('a completion with no credential is refused and the attempt stays armed', async () => {
    const { flow, authState, exchangeFn } = makeFlow();
    authState.beginLogin();
    const nonce = flow.start();
    const outcome = await flow.handleComplete({ flow: nonce, idToken: '' });
    expect(outcome.ok).toBe(false);
    expect(exchangeFn).not.toHaveBeenCalled();
    expect(flow.isPending).toBe(true);
  });

  it('an exchange failure burns the nonce, frees the state, and surfaces the human error', async () => {
    const { flow, authState } = makeFlow({
      exchangeImpl: async () => {
        throw new Error('sign-in failed: the gateway rejected the Google sign-in — please sign in again');
      },
    });
    authState.beginLogin();
    const nonce = flow.start();

    const outcome = await flow.handleComplete({ flow: nonce, idToken: 'bad.token.here' });
    expect(outcome).toEqual({
      ok: false,
      reason: 'exchange',
      error: expect.stringContaining('gateway rejected'),
    });
    expect(authState.snapshot().phase).toBe('logged-out');
    expect(authState.snapshot().error).toContain('gateway rejected');
    // Burned: the same nonce cannot be retried against a new attempt.
    const replay = await flow.handleComplete({ flow: nonce, idToken: 'bad.token.here' });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('no-flow');
  });

  it('page-reported abandonment frees the attempt — a fresh sign-in works immediately (#80)', async () => {
    const { flow, authState } = makeFlow();
    authState.beginLogin(); // first attempt's window opens
    const nonce1 = flow.start();
    flow.handleCancel({ flow: nonce1 }); // user closed the Google popup in the browser
    expect(flow.isPending).toBe(false);
    expect(authState.snapshot()).toEqual({
      phase: 'logged-out',
      principal: null,
      error: 'Sign-in was cancelled before completing.',
    });

    // Second attempt: new window begin, new nonce, completion succeeds.
    authState.beginLogin();
    const nonce2 = flow.start();
    expect(nonce2).not.toBe(nonce1);
    const outcome = await flow.handleComplete({ flow: nonce2, idToken: 'fresh.token.value' });
    expect(outcome.ok).toBe(true);
    expect(authState.snapshot().phase).toBe('logged-in');
  });

  it('a cancel report carrying a foreign nonce does not free the real attempt', () => {
    const { flow, authState } = makeFlow();
    authState.beginLogin();
    flow.start();
    flow.handleCancel({ flow: 'someone-elses-nonce' });
    expect(flow.isPending).toBe(true);
    expect(authState.snapshot().phase).toBe('logging-in');
  });

  it('the bounded wait frees a never-completed attempt (timeout → logged-out → begin again)', async () => {
    const { flow, authState, timers } = makeFlow();
    authState.beginLogin();
    flow.start();
    expect(timers.armed).toBe(true);

    timers.fire(); // the user never came back from the browser

    expect(flow.isPending).toBe(false);
    expect(authState.snapshot()).toEqual({
      phase: 'logged-out',
      principal: null,
      error: BROWSER_LOGIN_TIMEOUT_MESSAGE,
    });
    // And sign-in is not wedged: a fresh attempt completes.
    authState.beginLogin();
    const nonce = flow.start();
    const outcome = await flow.handleComplete({ flow: nonce, idToken: 'fresh.token.value' });
    expect(outcome.ok).toBe(true);
  });

  it('main-side cancel (window closed) frees the attempt; cancel after completion is a no-op', async () => {
    const { flow, authState } = makeFlow();
    authState.beginLogin();
    flow.start();
    flow.cancel('Sign-in was cancelled before completing.');
    expect(flow.isPending).toBe(false);
    expect(authState.snapshot().phase).toBe('logged-out');

    // Complete a second attempt; a late window-close cancel must not
    // knock out the session it created.
    authState.beginLogin();
    const nonce = flow.start();
    await flow.handleComplete({ flow: nonce, idToken: 'fake.firebase.id-token' });
    expect(authState.snapshot().phase).toBe('logged-in');
    flow.cancel('Sign-in was cancelled before completing.');
    expect(authState.snapshot()).toEqual({ phase: 'logged-in', principal: 'user:uid-1', error: null });
  });

  it('start() supersedes a stale attempt (old nonce dies, timer re-arms)', async () => {
    const { flow, authState, exchangeFn } = makeFlow();
    authState.beginLogin();
    const nonce1 = flow.start();
    const nonce2 = flow.start();
    expect(nonce2).not.toBe(nonce1);
    const stale = await flow.handleComplete({ flow: nonce1, idToken: 'x.y.z' });
    expect(stale.ok).toBe(false);
    expect(exchangeFn).not.toHaveBeenCalled();
    const fresh = await flow.handleComplete({ flow: nonce2, idToken: 'fake.firebase.id-token' });
    expect(fresh.ok).toBe(true);
  });
});
