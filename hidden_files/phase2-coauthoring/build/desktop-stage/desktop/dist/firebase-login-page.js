"use strict";
/**
 * Login-window page (Cycle 9: Firebase Google login — desktop).
 *
 * Generates the HTML for the dedicated sign-in BrowserWindow. The page:
 *  - loads the Firebase JS SDK (compat build, pinned version) from the
 *    Google CDN — sign-in inherently needs network (Google OAuth), so a
 *    CDN load failure surfaces as the network-failure state;
 *  - offers Google as the ONLY provider (no username/password anywhere);
 *  - runs signInWithPopup, then hands the Firebase ID token to the main
 *    process via window.icecreamDesktop.auth.loginWithFirebase() — the main
 *    process exchanges it for the gateway JWT and stores it in safeStorage.
 *    The renderer (and this page) never sees the gateway JWT.
 *
 * The error-code → message table is shared with the page: the page
 * serializes FIREBASE_ERROR_MESSAGES, and tests assert on the same table,
 * so the mapping is covered without a browser.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIREBASE_ERROR_MESSAGES = exports.FIREBASE_SDK_VERSION = void 0;
exports.firebaseErrorMessage = firebaseErrorMessage;
exports.buildLoginPage = buildLoginPage;
/** Pinned Firebase JS SDK (compat builds: namespaced API, no bundler). */
exports.FIREBASE_SDK_VERSION = '10.14.1';
/**
 * Firebase Auth error codes → user-facing messages. Google provider only;
 * every code here is reachable from the signInWithPopup Google flow.
 */
exports.FIREBASE_ERROR_MESSAGES = {
    'auth/popup-blocked': 'The Google sign-in popup was blocked. Allow popups for this window and try again.',
    'auth/popup-closed-by-user': 'Sign-in was cancelled before completing.',
    'auth/cancelled-popup-request': 'Sign-in was cancelled before completing.',
    'auth/network-request-failed': 'Could not reach Google sign-in (network failure). Check your connection and try again.',
    'auth/unauthorized-domain': 'This app is not authorized for Google sign-in. (Firebase console → Authentication → Settings → Authorized domains must include 127.0.0.1.)',
    'auth/operation-not-allowed': 'Google sign-in is not enabled for this Firebase project. Enable it in the Firebase console → Authentication → Sign-in method.',
    'auth/internal-error': 'Google sign-in hit an internal error. Please try again.',
    'auth/too-many-requests': 'Too many sign-in attempts — Google temporarily blocked this device. Try again later.',
};
function firebaseErrorMessage(code) {
    if (code && exports.FIREBASE_ERROR_MESSAGES[code])
        return exports.FIREBASE_ERROR_MESSAGES[code];
    return `Google sign-in failed${code ? ` (${code})` : ''}. Please try again.`;
}
/** Escape a JSON payload for embedding inside a <script> block. */
function jsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}
/**
 * Build the login window's HTML. Served over the loopback login server so
 * the page has a real origin for Firebase's popup flow.
 */
function buildLoginPage(opts) {
    const { config, configError } = opts;
    const hasConfig = config !== null;
    // Google "G" mark (official multi-color paths, inline SVG).
    const googleG = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>`;
    const clientScript = hasConfig
        ? `var CONFIG = ${jsonForScript(config)};
  firebase.initializeApp(CONFIG);
  btn.addEventListener('click', function () {
    btn.disabled = true;
    if (errEl) errEl.textContent = '';
    setStatus('Opening Google sign-in\\u2026');
    var provider = new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithPopup(provider).then(function (result) {
      setStatus('Exchanging sign-in with the gateway\\u2026');
      return result.user.getIdToken().then(function (idToken) {
        return window.icecreamDesktop.auth.loginWithFirebase(idToken);
      });
    }).then(function (r) {
      if (r && r.loggedIn) {
        setStatus('Signed in. This window will close.');
        // The main process closes this window after the menu refreshes.
      } else {
        btn.disabled = false;
        showError((r && r.error) || 'Sign-in failed. Please try again.');
      }
    }).catch(function (e) {
      btn.disabled = false;
      showError(mapError(e));
    });
  });`
        : `// No Firebase config: the page shows the not-configured error above.`;
    return `<!doctype html><html><head><meta charset="utf-8">
<title>Sign in to Icecream Sheets</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:28px 24px;color:#1e293b;background:#fff}
h2{font-size:17px;margin:0 0 8px;font-weight:600}
p{font-size:13px;color:#64748b;line-height:1.55;margin:0 0 12px}
.google-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;box-sizing:border-box;padding:10px;font-size:14px;font-weight:500;cursor:pointer;background:#fff;color:#1f2937;border:1px solid #d1d5db;border-radius:6px}
.google-btn:hover:not(:disabled){background:#f9fafb;border-color:#9ca3af}
.google-btn:disabled{opacity:.55;cursor:default}
.err{color:#b91c1c;font-size:13px;min-height:20px;margin:12px 0 0;white-space:pre-wrap}
.status{color:#64748b;font-size:13px;min-height:20px;margin:12px 0 0}
.note{margin-top:16px;font-size:12px;color:#94a3b8}
code{font-size:12px;background:#f1f5f9;padding:1px 4px;border-radius:4px}
</style></head>
<body>
<h2>Sign in to Icecream Sheets</h2>
<p>Remote services (AI agent, ETL runner, vault) go through the API gateway
and need a Google sign-in. The local engine and your spreadsheets keep
working fully offline either way.</p>
${hasConfig
        ? `<button class="google-btn" id="googleBtn">${googleG}<span>Sign in with Google</span></button>
<p class="status" id="status"></p>`
        : `<p class="err" id="err">${escapeHtml(configError ?? 'Firebase Auth is not configured.')}</p>`}
<p class="err" id="err"${hasConfig ? '' : ' style="display:none"'}></p>
${hasConfig ? '' : `<p class="note">Ask your administrator for the Firebase project config, then set it via the <code>ICECREAM_FIREBASE_CONFIG</code> environment variable and reopen this window.</p>`}
<script src="https://www.gstatic.com/firebasejs/${exports.FIREBASE_SDK_VERSION}/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/${exports.FIREBASE_SDK_VERSION}/firebase-auth-compat.js"></script>
<script>
(function () {
  var errEl = document.getElementById('err');
  var statusEl = document.getElementById('status');
  var btn = document.getElementById('googleBtn');
  var ERROR_MESSAGES = ${jsonForScript(exports.FIREBASE_ERROR_MESSAGES)};
  function showError(msg) { if (errEl) { errEl.textContent = msg; } if (statusEl) { statusEl.textContent = ''; } }
  function setStatus(msg) { if (statusEl) { statusEl.textContent = msg; } }
  function mapError(e) {
    var code = e && e.code;
    if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
    return 'Google sign-in failed' + (code ? ' (' + code + ')' : '') + '. Please try again.';
  }
  ${hasConfig ? '' : 'return;'}
  if (typeof firebase === 'undefined' || !firebase.auth) {
    showError('Could not load Google\\u2019s sign-in libraries (network failure). Check your connection and reopen this window.');
    if (btn) btn.disabled = true;
    return;
  }
  ${clientScript}
})();
</script>
</body></html>`;
}
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
//# sourceMappingURL=firebase-login-page.js.map