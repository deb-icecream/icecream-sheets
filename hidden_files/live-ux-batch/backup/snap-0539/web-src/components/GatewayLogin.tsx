/**
 * Gateway login gate (spec a/c).
 *
 * Shown when the app runs in gateway mode (VITE_GATEWAY_URL) without a
 * valid JWT. The gateway mints the token (local-dev /auth/login; production
 * uses the real IdP). No token → no engine or service access: the gateway
 * returns 401 for every /api/* call.
 *
 * Cycle 9, Phase 1: when a FirebaseAuthService is provided, the gate
 * offers "Sign in with Google" (Firebase signInWithPopup, Google provider
 * only → Firebase ID token → gateway JWT via POST /auth/firebase)
 * alongside the local-dev user-ID box. A missing Firebase config surfaces
 * as a clear error, not a silent dead button.
 *
 * Production login surface (user ruling, 2026-10-22): the deployed web
 * app has exactly ONE sign-in — "Sign in with Google". The user-ID box is
 * a local-testing affordance only and renders solely in dev builds or
 * when the gateway URL is localhost (devLoginEnabled below); a
 * production bundle must never render it. (The gateway independently
 * 404s POST /auth/login in production posture — F-1.)
 *
 * One click (user ruling, 2026-10-22): in the production flavor there
 * is no intermediate dialog at all. The landing page's button fires
 * Firebase sign-in directly (wired in App.tsx via isDevLoginEnabled),
 * and a deep link that lands on this gate gets a plain sign-in screen
 * with the single Google button — never the A11yDialog. The dialog
 * below renders only where dev login is enabled.
 */
import { useEffect, useState } from 'react';
import { GatewayClient } from '../services/gatewayClient';
import { FirebaseAuthService, type FirebaseAuthState } from '../services/firebaseAuth';
import A11yDialog from './A11yDialog';

/** Local-testing sign-in is available only in dev builds / localhost. */
function isLocalhostGateway(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * The ONE gating condition for the sign-in surface (user rulings,
 * 2026-10-22): the dev user-ID login exists only in dev builds or
 * against a localhost gateway. Everywhere else the build is the
 * production flavor and sign-in is a single click straight to Google.
 * App.tsx uses this same predicate to wire the landing page's button
 * directly to Firebase, so the surfaces can never drift apart.
 */
export function isDevLoginEnabled(client: GatewayClient): boolean {
  return import.meta.env.DEV || isLocalhostGateway(client.baseUrl);
}

interface GatewayLoginProps {
  client: GatewayClient;
  onLoggedIn: () => void;
  /** When present, the gate offers Firebase Google sign-in. */
  firebaseAuth?: FirebaseAuthService | null;
}

export function GatewayLogin({ client, onLoggedIn, firebaseAuth }: GatewayLoginProps) {
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fbState, setFbState] = useState<FirebaseAuthState | null>(
    () => firebaseAuth?.current ?? null,
  );

  useEffect(() => firebaseAuth?.subscribe(setFbState), [firebaseAuth]);

  const submit = async () => {
    const id = userId.trim();
    if (!id || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.login(id);
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const devLoginEnabled = isDevLoginEnabled(client);
  const googleBusy = fbState?.status === 'logging-in';
  const googleError = fbState?.status === 'error' ? fbState.error.message : null;

  const signInWithGoogle = async () => {
    if (!firebaseAuth || googleBusy) return;
    await firebaseAuth.signInWithGoogle();
    if (firebaseAuth.current.status === 'logged-in') onLoggedIn();
  };

  // Production flavor (user ruling, 2026-10-22): NO dialog. The gate is
  // a plain sign-in screen whose single button fires Google sign-in
  // directly on click. (From the landing page, production never reaches
  // this component at all — App wires the landing button straight to
  // Firebase. This screen serves deep links, where the gate is the
  // first thing rendered, so the click here IS the user's one click.)
  if (!devLoginEnabled) {
    return (
      <div className="signin-screen">
        <h1 className="signin-screen-title">Sign in to Icecream Sheets</h1>
        <p className="dialog-hint">
          Sign in with your Google account to open your workspace.
        </p>
        <div className="dialog-actions signin-screen-actions">
          <button
            onClick={() => void signInWithGoogle()}
            disabled={googleBusy || !firebaseAuth}
            className="primary"
          >
            {googleBusy ? 'Signing in with Google…' : 'Sign in with Google'}
          </button>
        </div>
        {googleError && <p className="dialog-error">{googleError}</p>}
        {!firebaseAuth && (
          <p className="dialog-error">
            Google sign-in is not configured for this build.
          </p>
        )}
      </div>
    );
  }

  return (
    <A11yDialog title="Sign in to Icecream Sheets">
        <p className="dialog-hint">
          This workspace connects through the API gateway. Sign in to reach
          the engine and AI services — every request carries your identity
          and is rate-limited per user.
        </p>
        {firebaseAuth && (
          <>
            <div className="dialog-actions" style={{ marginBottom: 4 }}>
              <button
                onClick={() => void signInWithGoogle()}
                disabled={googleBusy}
                className="primary"
              >
                {googleBusy ? 'Signing in with Google…' : 'Sign in with Google'}
              </button>
            </div>
            {googleError && <p className="dialog-error">{googleError}</p>}
            {devLoginEnabled && (
              <p className="dialog-hint" style={{ textAlign: 'center', margin: '8px 0' }}>
                — or —
              </p>
            )}
          </>
        )}
        {devLoginEnabled && (<>
        <label className="dialog-field">
          User ID <span className="dialog-hint" style={{ fontWeight: 400 }}>(local dev)</span>
          <input
            type="text"
            value={userId}
            autoFocus={!firebaseAuth}
            placeholder="e.g. debajyoti"
            onChange={(e) => setUserId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </label>
        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-actions">
          <button onClick={() => void submit()} disabled={busy || !userId.trim()} className="primary">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        </>)}
    </A11yDialog>
  );
}
