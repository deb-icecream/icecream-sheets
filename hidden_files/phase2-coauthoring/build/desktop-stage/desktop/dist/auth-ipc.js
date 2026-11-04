"use strict";
/**
 * Auth IPC wiring (Cycle 9: Firebase Google login — desktop).
 *
 * Registers the auth:* IPC channels against an injected ipcMain-like object
 * so the wiring is unit-testable without booting Electron:
 *
 *   auth:login             (userId) — LOCAL-DEV ONLY, unchanged behavior
 *   auth:loginWithFirebase (idToken) — Google sign-in exchange (Cycle 9)
 *   auth:logout            — drop the token, back to logged-out
 *   auth:status            — current { loggedIn, principal }
 *   auth:openLoginWindow   — open the Firebase login window (main.ts owns it)
 *
 * Every transition runs through the DesktopAuthState machine
 * (logged-out → logging-in → logged-in → logged-out) and notifies the main
 * window via 'auth:changed' so the UI can react without polling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAuthIpc = registerAuthIpc;
const auth_state_1 = require("./auth-state");
const firebase_auth_1 = require("./firebase-auth");
const services_1 = require("./services");
function toErrorResult(error) {
    return {
        loggedIn: false,
        principal: null,
        error: error instanceof Error ? error.message : String(error),
    };
}
function registerAuthIpc(ipcMain, deps) {
    const statusFn = deps.statusFn ?? services_1.status;
    const authState = deps.authState ?? new auth_state_1.DesktopAuthState({ loggedIn: statusFn().loggedIn, principal: statusFn().principal });
    const notify = () => {
        deps.notifyRenderer('auth:changed', authState.snapshot());
    };
    authState.onChange(() => notify());
    const loginFn = deps.loginFn ?? services_1.login;
    const logoutFn = deps.logoutFn ?? services_1.logout;
    const exchangeFn = deps.loginWithFirebaseFn ?? firebase_auth_1.loginWithFirebase;
    // Local-dev userId login (pre-existing behavior; the gateway endpoint is
    // LOCAL-DEV ONLY). Kept for local development and tests — the login
    // WINDOW offers Google sign-in only.
    ipcMain.handle('auth:login', async (_event, userId) => {
        try {
            if (typeof userId !== 'string')
                throw new Error('user id must be a string');
            authState.beginLogin();
            const s = await loginFn(String(userId));
            authState.completeLogin(s.principal);
            deps.rebuildMenu();
            return { loggedIn: s.loggedIn, principal: s.principal };
        }
        catch (error) {
            authState.failLogin(error instanceof Error ? error.message : String(error));
            return toErrorResult(error);
        }
    });
    // Cycle 9: Firebase Google sign-in. The login window completes the Google
    // flow and hands over the Firebase ID token; the main process exchanges
    // it for the gateway JWT (stored in safeStorage, never shown to the
    // renderer) and closes the window on success.
    ipcMain.handle('auth:loginWithFirebase', async (_event, idToken) => {
        try {
            if (typeof idToken !== 'string')
                throw new Error('expected a Firebase ID token string');
            authState.beginLogin();
            const s = await exchangeFn(idToken);
            authState.completeLogin(s.principal);
            deps.rebuildMenu();
            return { loggedIn: s.loggedIn, principal: s.principal };
        }
        catch (error) {
            authState.failLogin(error instanceof Error ? error.message : String(error));
            return toErrorResult(error);
        }
    });
    ipcMain.handle('auth:logout', () => {
        logoutFn();
        authState.logout();
        deps.rebuildMenu();
    });
    ipcMain.handle('auth:status', () => statusFn());
    ipcMain.handle('auth:openLoginWindow', () => {
        deps.openLoginWindow();
    });
    return { authState };
}
//# sourceMappingURL=auth-ipc.js.map