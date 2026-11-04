/**
 * Login page — browser-mode variant tests (Issue #78).
 *
 * Pins the mode separation between the two page variants the login
 * server can serve: the embedded window's page (preload-bridge IPC,
 * pinned in firebase-login-page.test.ts) and the system-browser page
 * (flow nonce, /auth/complete return, account-chooser prompt). The
 * browser page must never reference the preload bridge (it does not
 * exist there) and the embedded page must never carry the nonce or the
 * HTTP return path.
 */
import { describe, expect, it } from 'vitest';
import { buildLoginPage } from '../src/firebase-login-page.js';

const CONFIG = {
  apiKey: 'AIza-test-key',
  authDomain: 'demo.firebaseapp.com',
  projectId: 'demo-project',
};
const NONCE = 'test-flow-nonce-0123456789';

describe('buildLoginPage — browser mode (#78)', () => {
  it('carries the flow nonce and returns the token via /auth/complete, never the bridge', () => {
    const html = buildLoginPage({ config: CONFIG, browserFlow: NONCE });
    expect(html).toContain(NONCE);
    expect(html).toContain('/auth/complete');
    expect(html).toContain('getIdToken');
    // No preload bridge exists in the user's browser — the page must
    // not reference it at all.
    expect(html).not.toContain('icecreamDesktop');
    expect(html).not.toContain('loginWithFirebase');
  });

  it('forces the account chooser (prompt=select_account) in browser mode', () => {
    const html = buildLoginPage({ config: CONFIG, browserFlow: NONCE });
    expect(html).toContain('setCustomParameters');
    expect(html).toContain('select_account');
    expect(html).toContain('GoogleAuthProvider');
  });

  it('reports popup abandonment to /auth/cancel in browser mode', () => {
    const html = buildLoginPage({ config: CONFIG, browserFlow: NONCE });
    expect(html).toContain('/auth/cancel');
    expect(html).toContain("'auth/popup-closed-by-user'");
    expect(html).toContain("'auth/cancelled-popup-request'");
    expect(html).toContain('keepalive');
  });

  it('tells the user the tab has done its job on success', () => {
    const html = buildLoginPage({ config: CONFIG, browserFlow: NONCE });
    expect(html).toContain('close this tab');
    expect(html).toContain('desktop app');
  });

  it('the embedded variant carries NO nonce, NO HTTP return path, NO chooser prompt', () => {
    const html = buildLoginPage({ config: CONFIG });
    expect(html).not.toContain('/auth/complete');
    expect(html).not.toContain('/auth/cancel');
    expect(html).not.toContain('select_account');
    // …and still uses the bridge exactly as before.
    expect(html).toContain('window.icecreamDesktop.auth.loginWithFirebase');
    expect(html).toContain('loginCancelled');
  });

  it('browser mode still fails closed with no config: error shown, no button, no flow script', () => {
    const html = buildLoginPage({ config: null, configError: 'Firebase Auth is not configured.', browserFlow: NONCE });
    expect(html).toContain('Firebase Auth is not configured');
    expect(html).not.toContain('id="googleBtn"');
    expect(html).not.toContain('signInWithPopup');
    expect(html).not.toContain('/auth/complete');
  });

  it('a nonce with script-breaking characters cannot escape the script block', () => {
    const html = buildLoginPage({
      config: CONFIG,
      browserFlow: 'x</script><script>alert(1)</script>',
    });
    expect(html).not.toContain('</script><script>alert(1)');
  });
});
