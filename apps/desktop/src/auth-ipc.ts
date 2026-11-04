/**
 * Auth IPC wiring (Cycle 9: Firebase Google login — desktop).
 *
 * Registers the auth:* IPC channels against an injected ipcMain-like object
 * so the wiring is unit-testable without booting Electron:
 *
 *   auth:login             (userId) — LOCAL-DEV ONLY, unchanged behavior
 *   auth:loginWithFirebase (idToken) — Google sign-in exchange (Cycle 9)
 *   auth:loginCancelled    — the login page reports the user abandoned
 *                            the Google popup (closed / cancelled), so an
 *                            in-flight login is failed back to logged-out
 *                            instead of leaking at 'logging-in' (#80)
 *   auth:logout            — drop the token, back to logged-out
 *   auth:status            — current { loggedIn, principal }
 *   auth:openLoginWindow   — open the Firebase login window (main.ts owns it)
 *
 * Every transition runs through the DesktopAuthState machine
 * (logged-out → logging-in → logged-in → logged-out) and notifies the main
 * window via 'auth:changed' so the UI can react without polling.
 *
 * Begin-transition ownership (#83): exactly ONE beginLogin per flow.
 * openLoginWindow() (main.ts) owns it for the window flow — it marks the
 * flow in-flight when the window opens. The handlers below call
 * beginOrJoinLogin(): from 'logged-out' they begin (windowless flows),
 * from 'logging-in' they JOIN the flow the window opened instead of
 * throwing 'auth: a login is already in progress' at a healthy sign-in.
 *
 * The Firebase completion itself lives in completeFirebaseLogin() below
 * and is shared verbatim with the system-browser sign-in flow (#78):
 * the browser page returns its ID token through the loopback login
 * server (browser-login.ts), never through a second exchange path.
 *
 * Errors crossing this boundary are humanized (humanAuthError): the raw
 * 'auth:'-prefixed internal strings the state machine throws with are
 * for logs and tests, never for the UI.
 */

import { DesktopAuthState } from './auth-state';
import { loginWithFirebase } from './firebase-auth';
import { login, logout, status } from './services';

export interface AuthIpcMain {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface AuthIpcDeps {
  /** Rebuild the native menu (Account → reflects live status). */
  rebuildMenu: () => void;
  /** Notify the main window renderer of an auth transition. */
  notifyRenderer: (channel: string, snapshot: unknown) => void;
  /** Open the Firebase login window (implemented in main.ts). */
  openLoginWindow: () => void;
  /**
   * The shared auth state machine. main.ts creates one from the persisted
   * token at startup (status()) so a relaunch restores the logged-in phase.
   */
  authState?: DesktopAuthState;
  /** Injected for tests. */
  loginFn?: typeof login;
  logoutFn?: typeof logout;
  statusFn?: typeof status;
  loginWithFirebaseFn?: typeof loginWithFirebase;
}

export interface AuthIpc {
  authState: DesktopAuthState;
}

/**
 * Turn an internal auth error into the message a person sees. The state
 * machine throws raw 'auth:'-prefixed strings (they read well in logs and
 * tests); those must never reach the UI (acceptance: no raw 'auth:' error
 * is ever shown). Known guard messages get a sentence a person would say;
 * anything else passes through with the prefix stripped.
 */
export function humanAuthError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const msg = raw.replace(/^auth:\s*/, '');
  if (msg === 'a login is already in progress') {
    return 'A sign-in is already in progress — finish it in the sign-in window, or close that window and try again.';
  }
  if (msg === 'already logged in — log out first') {
    return 'You are already signed in.';
  }
  if (msg === 'completeLogin() with no login in flight') {
    return 'Sign-in could not be completed. Please try again.';
  }
  return msg;
}

function toErrorResult(error: unknown): { loggedIn: false; principal: null; error: string } {
  return {
    loggedIn: false,
    principal: null,
    error: humanAuthError(error),
  };
}

export interface FirebaseLoginResult {
  loggedIn: boolean;
  principal: string | null;
  error?: string;
}

export interface PerformLogoutDeps {
  /** Rebuild the native menu (Account → reflects live status). */
  rebuildMenu: () => void;
  /** Notify the main window renderer of an auth transition. */
  notifyRenderer: (channel: string, snapshot: unknown) => void;
  /** Injected for tests. Defaults to the real token drop. */
  logoutFn?: typeof logout;
}

/**
 * THE full sign-out (#102: one routine, every sign-out path).
 *
 * The native Account menu used to call services.logout() directly —
 * dropping the token file but leaving the state machine 'logged-in'.
 * Every later openLoginWindow() then hit its `phase === 'logged-in'`
 * early return and silently did nothing: no window, no tab, no error,
 * until an app restart. A sign-out must move ALL of the session's
 * truths together: token file, state machine, menu, renderer snapshot.
 * Both the auth:logout IPC handler and main's Account menu call this.
 * The explicit notify duplicates the authState.onChange subscription's
 * own notify with the identical snapshot — harmless, and it guarantees
 * the renderer learns even for a machine with no subscription attached.
 */
export function performLogout(
  authState: DesktopAuthState,
  deps: PerformLogoutDeps,
): void {
  const logoutFn = deps.logoutFn ?? logout;
  logoutFn();
  authState.logout();
  deps.rebuildMenu();
  deps.notifyRenderer('auth:changed', authState.snapshot());
}

export interface CompleteFirebaseLoginDeps {
  /** Rebuild the native menu (Account → reflects live status). */
  rebuildMenu: () => void;
  /** Injected for tests. Defaults to the real gateway exchange. */
  loginWithFirebaseFn?: typeof loginWithFirebase;
}

/**
 * THE completion path for a Firebase ID token (#78) — the one and only.
 *
 * Both surfaces that can produce a Google credential land here:
 *  - the embedded login window's page, via the auth:loginWithFirebase IPC;
 *  - the system-browser page, via the loopback login server's
 *    /auth/complete route (browser-login.ts).
 * Keeping a single routine means the gateway exchange, the state-machine
 * transitions and the menu rebuild can never drift apart between the two.
 *
 * Begin ownership (#83): this routine NEVER begins a flow on its own
 * authority — it calls beginOrJoinLogin(), which begins from 'logged-out'
 * (a windowless caller) and JOINS the in-flight flow the login window's
 * open already began ('logging-in'). Errors are returned as a humanized
 * result (never thrown, never a raw 'auth:' string) and recorded on the
 * machine via failLogin, which no-ops unless a login is in flight — so a
 * late or duplicate completion can never knock out a live session.
 */
export async function completeFirebaseLogin(
  authState: DesktopAuthState,
  idToken: unknown,
  deps: CompleteFirebaseLoginDeps,
): Promise<FirebaseLoginResult> {
  const exchangeFn = deps.loginWithFirebaseFn ?? loginWithFirebase;
  try {
    if (typeof idToken !== 'string') throw new Error('expected a Firebase ID token string');
    authState.beginOrJoinLogin();
    const s = await exchangeFn(idToken);
    authState.completeLogin(s.principal);
    deps.rebuildMenu();
    return { loggedIn: s.loggedIn, principal: s.principal };
  } catch (error) {
    authState.failLogin(humanAuthError(error));
    return toErrorResult(error);
  }
}

export function registerAuthIpc(ipcMain: AuthIpcMain, deps: AuthIpcDeps): AuthIpc {
  const statusFn = deps.statusFn ?? status;
  const authState =
    deps.authState ?? new DesktopAuthState({ loggedIn: statusFn().loggedIn, principal: statusFn().principal });

  const notify = (): void => {
    deps.notifyRenderer('auth:changed', authState.snapshot());
  };
  authState.onChange(() => notify());

  const loginFn = deps.loginFn ?? login;
  const logoutFn = deps.logoutFn ?? logout;

  // Local-dev userId login (pre-existing behavior; the gateway endpoint is
  // LOCAL-DEV ONLY). Kept for local development and tests — the login
  // WINDOW offers Google sign-in only.
  ipcMain.handle('auth:login', async (_event: unknown, userId: unknown) => {
    try {
      if (typeof userId !== 'string') throw new Error('user id must be a string');
      authState.beginOrJoinLogin();
      const s = await loginFn(String(userId));
      authState.completeLogin(s.principal);
      deps.rebuildMenu();
      return { loggedIn: s.loggedIn, principal: s.principal };
    } catch (error) {
      authState.failLogin(humanAuthError(error));
      return toErrorResult(error);
    }
  });

  // Cycle 9: Firebase Google sign-in. The login window completes the Google
  // flow and hands over the Firebase ID token; the main process exchanges
  // it for the gateway JWT (stored in safeStorage, never shown to the
  // renderer) and closes the window on success. The body lives in
  // completeFirebaseLogin() so the system-browser return path (#78,
  // browser-login.ts) lands in the exact same routine.
  ipcMain.handle('auth:loginWithFirebase', (_event: unknown, idToken: unknown) =>
    completeFirebaseLogin(authState, idToken, {
      rebuildMenu: deps.rebuildMenu,
      loginWithFirebaseFn: deps.loginWithFirebaseFn,
    }),
  );

  // The login page reports that the user abandoned the Google popup
  // (closed it, or a second popup request cancelled it) — the page knows
  // this exactly because its signInWithPopup promise rejected; a raw
  // popup 'closed' event in main could not distinguish abandonment from
  // the SDK closing the popup itself on success. Failing the login here
  // returns the machine to logged-out (#80: an abandoned attempt must
  // never leave the phase stuck at 'logging-in' for the life of the
  // process). failLogin no-ops when nothing is in flight, so a late or
  // stray report can never knock out a live session. The login window
  // itself closing is covered separately in main.ts ('closed' handler).
  ipcMain.handle('auth:loginCancelled', (): void => {
    authState.failLogin('Sign-in was cancelled before completing.');
  });

  ipcMain.handle('auth:logout', (): void => {
    performLogout(authState, {
      rebuildMenu: deps.rebuildMenu,
      notifyRenderer: deps.notifyRenderer,
      logoutFn,
    });
  });

  ipcMain.handle('auth:status', () => statusFn());

  ipcMain.handle('auth:openLoginWindow', (): void => {
    deps.openLoginWindow();
  });

  return { authState };
}
