/**
 * Login-window page tests (Cycle 9: desktop login).
 *
 * The page is generated HTML; these tests pin its security-relevant
 * properties: Google is the ONLY provider (no username/password fields),
 * the Firebase SDK is pinned, the config is embedded safely, and the
 * error table from the module is the one the page uses.
 */
import { describe, expect, it } from 'vitest';
import {
  FIREBASE_ERROR_MESSAGES,
  FIREBASE_SDK_VERSION,
  buildLoginPage,
  firebaseErrorMessage,
} from '../src/firebase-login-page.js';

const CONFIG = {
  apiKey: 'AIza-test-key',
  authDomain: 'demo.firebaseapp.com',
  projectId: 'demo-project',
};

describe('firebaseErrorMessage', () => {
  it('maps every known popup/network/config failure to a user-facing message', () => {
    expect(firebaseErrorMessage('auth/popup-blocked')).toMatch(/popup was blocked/i);
    expect(firebaseErrorMessage('auth/popup-closed-by-user')).toMatch(/cancelled/i);
    expect(firebaseErrorMessage('auth/network-request-failed')).toMatch(/network failure/i);
    expect(firebaseErrorMessage('auth/unauthorized-domain')).toMatch(/authorized/i);
    // Issue #53: the copy names localhost (the authorized domain the
    // login page is actually served from), never 127.0.0.1.
    expect(firebaseErrorMessage('auth/unauthorized-domain')).toMatch(/localhost/);
    expect(firebaseErrorMessage('auth/unauthorized-domain')).not.toMatch(/127\.0\.0\.1/);
    expect(firebaseErrorMessage('auth/operation-not-allowed')).toMatch(/not enabled/i);
  });

  it('falls back gracefully for unknown codes', () => {
    expect(firebaseErrorMessage('auth/weird')).toMatch(/auth\/weird/);
    expect(firebaseErrorMessage(undefined)).toMatch(/Google sign-in failed/);
  });

  it('the module table and the page agree (single source of truth)', () => {
    const html = buildLoginPage({ config: CONFIG });
    for (const [code, message] of Object.entries(FIREBASE_ERROR_MESSAGES)) {
      expect(html).toContain(code);
      // The message text (or its JSON-escaped form) is embedded.
      expect(html).toContain(message.slice(0, 20));
    }
  });
});

describe('buildLoginPage', () => {
  it('offers Google sign-in only — no username/password fields anywhere', () => {
    const html = buildLoginPage({ config: CONFIG }).toLowerCase();
    expect(html).toContain('sign in with google');
    expect(html).toContain('googleauthprovider');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('username');
    // No user-id text box (the old local-dev login form is gone from the UI).
    expect(html).not.toContain('placeholder="user id');
  });

  it('pins the Firebase SDK version and loads auth compat', () => {
    const html = buildLoginPage({ config: CONFIG });
    expect(html).toContain(`firebasejs/${FIREBASE_SDK_VERSION}/firebase-app-compat.js`);
    expect(html).toContain(`firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth-compat.js`);
  });

  it('embeds the config and hands the ID token to the main process over IPC', () => {
    const html = buildLoginPage({ config: CONFIG });
    expect(html).toContain('demo-project');
    expect(html).toContain('demo.firebaseapp.com');
    expect(html).toContain('getIdToken');
    expect(html).toContain('window.icecreamDesktop.auth.loginWithFirebase');
    // The gateway JWT is never touched here — only the Firebase ID token.
    expect(html).not.toContain('safeStorage');
  });

  it('reports an abandoned popup to the main process so the login cannot stick (#80)', () => {
    const html = buildLoginPage({ config: CONFIG });
    // The page's signInWithPopup rejection path must notify main via the
    // preload bridge for BOTH abandonment codes…
    expect(html).toContain('window.icecreamDesktop');
    expect(html).toContain('loginCancelled');
    expect(html).toContain("'auth/popup-closed-by-user'");
    expect(html).toContain("'auth/cancelled-popup-request'");
  });

  it('escapes config values so they cannot break out of the script block', () => {
    const evil = {
      apiKey: 'x',
      authDomain: 'demo.firebaseapp.com',
      projectId: 'demo-project',
    };
    const html = buildLoginPage({
      config: { ...evil, apiKey: 'AIza</script><script>alert(1)</script>' },
    });
    expect(html).not.toContain('</script><script>alert(1)');
  });

  it('renders the clear not-configured error with no sign-in button when config is missing', () => {
    const msg =
      'Firebase Auth is not configured. Set the ICECREAM_FIREBASE_CONFIG environment variable (JSON).';
    const html = buildLoginPage({ config: null, configError: msg });
    expect(html).toContain('Firebase Auth is not configured');
    expect(html).not.toContain('id="googleBtn"');
    expect(html).not.toContain('signInWithPopup');
  });

  it('escapes the config error message as HTML', () => {
    const html = buildLoginPage({
      config: null,
      configError: 'bad <img src=x onerror=alert(1)> config',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
