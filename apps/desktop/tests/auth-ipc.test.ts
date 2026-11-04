/**
 * Auth IPC wiring tests (Cycle 9: desktop login).
 *
 * The wiring is exercised against a fake ipcMain with injected service
 * fns — no Electron boot needed. Firebase is mocked at the exchange
 * function boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/icecream-auth-ipc-test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Uint8Array) => Buffer.from(b).toString('utf8'),
  },
}));

const { registerAuthIpc } = await import('../src/auth-ipc.js');
const { DesktopAuthState } = await import('../src/auth-state.js');

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function makeIpc() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  };
  return { ipcMain, handlers };
}

describe('registerAuthIpc', () => {
  let ipc: ReturnType<typeof makeIpc>;
  let deps: {
    rebuildMenu: ReturnType<typeof vi.fn>;
    notifyRenderer: ReturnType<typeof vi.fn>;
    openLoginWindow: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    ipc = makeIpc();
    deps = {
      rebuildMenu: vi.fn(),
      notifyRenderer: vi.fn(),
      openLoginWindow: vi.fn(),
    };
  });

  function phases(): string[] {
    return deps.notifyRenderer.mock.calls.map(
      (c) => (c[1] as { phase: string }).phase,
    );
  }

  it('auth:loginWithFirebase walks the state machine and rebuilds the menu', async () => {
    const exchangeFn = vi.fn(async () => ({ loggedIn: true, principal: 'user:uid-1' }));
    const { authState } = registerAuthIpc(ipc.ipcMain, {
      ...deps,
      authState: new DesktopAuthState(),
      loginWithFirebaseFn: exchangeFn as never,
    });

    const handler = ipc.handlers.get('auth:loginWithFirebase')!;
    const result = (await handler({}, 'fake.firebase.id-token')) as {
      loggedIn: boolean;
      principal: string | null;
    };

    expect(exchangeFn).toHaveBeenCalledWith('fake.firebase.id-token');
    expect(result).toEqual({ loggedIn: true, principal: 'user:uid-1' });
    expect(authState.snapshot().phase).toBe('logged-in');
    expect(deps.rebuildMenu).toHaveBeenCalledTimes(1);
    // Renderer saw the transition without polling.
    expect(deps.notifyRenderer).toHaveBeenCalledWith(
      'auth:changed',
      expect.objectContaining({ phase: 'logging-in' }),
    );
    expect(phases()).toContain('logged-in');
  });

  it('auth:loginWithFirebase failure returns the error and leaves logged-out', async () => {
    const exchangeFn = vi.fn(async () => {
      throw new Error('sign-in failed: the gateway rejected the Google sign-in — please sign in again');
    });
    const { authState } = registerAuthIpc(ipc.ipcMain, {
      ...deps,
      authState: new DesktopAuthState(),
      loginWithFirebaseFn: exchangeFn as never,
    });

    const handler = ipc.handlers.get('auth:loginWithFirebase')!;
    const result = (await handler({}, 'bad.token.here')) as {
      loggedIn: boolean;
      principal: string | null;
      error?: string;
    };

    expect(result.loggedIn).toBe(false);
    expect(result.principal).toBeNull();
    expect(result.error).toMatch(/gateway rejected/);
    expect(authState.snapshot()).toEqual({
      phase: 'logged-out',
      principal: null,
      error: expect.stringContaining('gateway rejected'),
    });
    expect(deps.rebuildMenu).not.toHaveBeenCalled();
  });

  it('auth:loginWithFirebase rejects a non-string token without starting login', async () => {
    const exchangeFn = vi.fn();
    const { authState } = registerAuthIpc(ipc.ipcMain, {
      ...deps,
      authState: new DesktopAuthState(),
      loginWithFirebaseFn: exchangeFn as never,
    });
    const handler = ipc.handlers.get('auth:loginWithFirebase')!;
    const result = (await handler({}, 42)) as { loggedIn: boolean; error?: string };
    expect(result.loggedIn).toBe(false);
    expect(result.error).toMatch(/ID token string/);
    expect(exchangeFn).not.toHaveBeenCalled();
    expect(authState.snapshot().phase).toBe('logged-out');
  });

  it('#83 regression: exchange handler JOINS the flow the login window already began', async () => {
    // openLoginWindow() owns the begin transition: by the time the page
    // hands over the Firebase token, the phase is already 'logging-in'.
    // The handler must complete that flow — before the fix it called
    // beginLogin() again and threw 'auth: a login is already in
    // progress' at a perfectly healthy sign-in.
    const exchangeFn = vi.fn(async () => ({ loggedIn: true, principal: 'user:uid-1' }));
    const authState = new DesktopAuthState();
    registerAuthIpc(ipc.ipcMain, {
      ...deps,
      authState,
      loginWithFirebaseFn: exchangeFn as never,
    });
    authState.beginLogin(); // the window opened

    const handler = ipc.handlers.get('auth:loginWithFirebase')!;
    const result = (await handler({}, 'fake.firebase.id-token')) as {
      loggedIn: boolean;
      principal: string | null;
      error?: string;
    };

    expect(exchangeFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ loggedIn: true, principal: 'user:uid-1' });
    expect(authState.snapshot().phase).toBe('logged-in');
    // No spurious failure transition in between: phases went straight
    // logging-in → logged-in, never a bogus logged-out with an error.
    expect(phases()).toEqual(['logging-in', 'logged-in']);
  });

  it('#80 regression: page-reported popup abandonment frees the state for a fresh sign-in', async () => {
    const exchangeFn = vi.fn(async () => ({ loggedIn: true, principal: 'user:uid-2' }));
    const authState = new DesktopAuthState();
    registerAuthIpc(ipc.ipcMain, {
      ...deps,
      authState,
      loginWithFirebaseFn: exchangeFn as never,
    });
    authState.beginLogin(); // the window opened…
    // …the user closed the Google popup; the page reports it.
    await ipc.handlers.get('auth:loginCancelled')!({});
    expect(authState.snapshot()).toEqual({
      phase: 'logged-out',
      principal: null,
      error: 'Sign-in was cancelled before completing.',
    });
    // A fresh sign-in starts immediately — no restart, no stuck state.
    const handler = ipc.handlers.get('auth:loginWithFirebase')!;
    const result = (await handler({}, 'fresh.token')) as { loggedIn: boolean };
    expect(result.loggedIn).toBe(true);
    expect(authState.snapshot().phase).toBe('logged-in');
  });

  it('auth:loginCancelled never knocks out a live session', async () => {
    const authState = new DesktopAuthState();
    registerAuthIpc(ipc.ipcMain, { ...deps, authState });
    authState.beginLogin();
    authState.completeLogin('user:uid-1');
    await ipc.handlers.get('auth:loginCancelled')!({});
    expect(authState.snapshot()).toEqual({
      phase: 'logged-in',
      principal: 'user:uid-1',
      error: null,
    });
  });

  it('no raw auth: error ever reaches the caller (acceptance: human messages only)', async () => {
    // Already signed in; a stray exchange attempt makes the machine
    // throw its raw guard error — the IPC boundary must humanize it.
    const authState = new DesktopAuthState({ loggedIn: true, principal: 'user:uid-1' });
    registerAuthIpc(ipc.ipcMain, {
      ...deps,
      authState,
      loginWithFirebaseFn: vi.fn() as never,
    });
    const handler = ipc.handlers.get('auth:loginWithFirebase')!;
    const result = (await handler({}, 'tok')) as {
      loggedIn: boolean;
      error?: string;
    };
    expect(result.loggedIn).toBe(false);
    expect(result.error).toBe('You are already signed in.');
    expect(result.error).not.toMatch(/^auth:/);
    // The live session is untouched and no raw string was recorded.
    expect(authState.snapshot().phase).toBe('logged-in');
    expect(authState.snapshot().error).toBeNull();
  });

  it('auth:logout drops the session, resets the machine, rebuilds the menu', async () => {
    const logoutFn = vi.fn();
    const authState = new DesktopAuthState();
    authState.beginLogin();
    authState.completeLogin('user:uid-1');
    registerAuthIpc(ipc.ipcMain, {
      ...deps,
      authState,
      logoutFn: logoutFn as never,
      statusFn: (() => ({ loggedIn: true, principal: 'user:uid-1' })) as never,
    });

    const handler = ipc.handlers.get('auth:logout')!;
    await handler({});
    expect(logoutFn).toHaveBeenCalledTimes(1);
    expect(authState.snapshot().phase).toBe('logged-out');
    expect(deps.rebuildMenu).toHaveBeenCalledTimes(1);
  });

  it('auth:status delegates to the status fn; auth:openLoginWindow delegates to main', async () => {
    registerAuthIpc(ipc.ipcMain, {
      ...deps,
      statusFn: (() => ({ loggedIn: true, principal: 'user:uid-9' })) as never,
    });
    const statusResult = (await ipc.handlers.get('auth:status')!({})) as {
      loggedIn: boolean;
    };
    expect(statusResult).toEqual({ loggedIn: true, principal: 'user:uid-9' });
    await ipc.handlers.get('auth:openLoginWindow')!({});
    expect(deps.openLoginWindow).toHaveBeenCalledTimes(1);
  });

  it('the local-dev auth:login path still works through the machine', async () => {
    const loginFn = vi.fn(async () => ({ loggedIn: true, principal: 'user:dev' }));
    const { authState } = registerAuthIpc(ipc.ipcMain, {
      ...deps,
      authState: new DesktopAuthState(),
      loginFn: loginFn as never,
    });
    const handler = ipc.handlers.get('auth:login')!;
    const result = (await handler({}, 'dev')) as { loggedIn: boolean; principal: string | null };
    expect(result).toEqual({ loggedIn: true, principal: 'user:dev' });
    expect(authState.snapshot().phase).toBe('logged-in');
  });
});

describe('performLogout (#102: one routine, every sign-out path)', () => {
  it('clears the token, logs the machine out, rebuilds the menu, notifies the renderer', async () => {
    const { performLogout } = await import('../src/auth-ipc.js');
    const machine = new DesktopAuthState({ loggedIn: true, principal: 'user:uid-1' });
    const logoutFn = vi.fn();
    const rebuildMenu = vi.fn();
    const notifyRenderer = vi.fn();
    performLogout(machine, { rebuildMenu, notifyRenderer, logoutFn });
    expect(logoutFn).toHaveBeenCalledTimes(1);
    expect(machine.snapshot()).toEqual({ phase: 'logged-out', principal: null, error: null });
    expect(rebuildMenu).toHaveBeenCalledTimes(1);
    expect(notifyRenderer).toHaveBeenCalledWith(
      'auth:changed',
      expect.objectContaining({ phase: 'logged-out' }),
    );
  });

  it('auth:logout handler routes through performLogout (machine ends logged-out)', async () => {
    const localIpc = makeIpc();
    const rebuildMenu = vi.fn();
    const notifyRenderer = vi.fn();
    const logoutFn = vi.fn();
    const { authState } = registerAuthIpc(localIpc.ipcMain, {
      rebuildMenu,
      notifyRenderer,
      openLoginWindow: vi.fn(),
      authState: new DesktopAuthState({ loggedIn: true, principal: 'user:uid-1' }),
      logoutFn: logoutFn as never,
    });
    const handler = localIpc.handlers.get('auth:logout')!;
    handler({});
    expect(logoutFn).toHaveBeenCalledTimes(1);
    expect(authState.snapshot().phase).toBe('logged-out');
    expect(rebuildMenu).toHaveBeenCalled();
  });
});
