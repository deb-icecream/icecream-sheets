/**
 * Firebase Google sign-in button for the app header (Cycle 9, Phase 1).
 *
 * Renders from the FirebaseAuthService state machine:
 *  - logged-out → "Sign in with Google" button
 *  - logging-in  → disabled "Signing in…" button
 *  - logged-in   → avatar (or initial), display name/email, "Sign out"
 *  - error       → the failure message + a "Try again" button
 *
 * Shown in gateway mode (VITE_GATEWAY_URL), where the gateway JWT from
 * the Firebase exchange is what unlocks the engine and services.
 */
import { useEffect, useState } from 'react';
import { FirebaseAuthService, type FirebaseAuthState } from '../services/firebaseAuth';
import { isDesktop, desktopAuthStatus } from '../services/desktopAgent';

interface FirebaseLoginButtonProps {
  /** Web Firebase state machine. Optional: the desktop branch doesn't use it. */
  auth?: FirebaseAuthService;
}

interface DesktopBridge {
  auth: {
    openLoginWindow: () => Promise<void>;
    logout: () => Promise<void>;
    status: () => Promise<{ loggedIn: boolean; principal: string | null }>;
    onAuthChanged: (cb: (snapshot: { loggedIn: boolean; principal: string | null }) => void) => () => void;
  };
}

function desktopBridge(): DesktopBridge | null {
  const w = window as unknown as { icecreamDesktop?: DesktopBridge };
  return w.icecreamDesktop ?? null;
}

const btnStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid #cbd5e1',
  background: '#ffffff',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

function GoogleG(): React.ReactElement {
  // Inline "G" mark (no external asset needed).
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.9-.1-1.5-.3-2.3H12v4.5h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.1.1 3.5 2.7.2.1c2.2-2 3.8-5 3.8-8.9z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.8-5l-.1.1-3.7 2.9v.1C3.3 21.3 7.3 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.2 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-.1-.1-3.6-2.8-.1.1C.5 8.2 0 10 0 12s.5 3.8 1.4 5.2l3.8-2.8z"
      />
      <path
        fill="#EA4335"
        d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.3 0 3.3 2.7 1.4 6.8l3.8 2.9c1-2.9 3.7-5 6.8-5z"
      />
    </svg>
  );
}

export function FirebaseLoginButton({ auth }: FirebaseLoginButtonProps): React.ReactElement {
  // Desktop branch first: the renderer is inside Electron; the login window
  // flow lives in main via window.icecreamDesktop.auth. (Cycle 9 desktop login.)
  // This branch never touches the web FirebaseAuthService.
  if (isDesktop()) {
    return <DesktopLoginButton />;
  }
  if (!auth) return <></>;
  return <WebLoginButton auth={auth} />;
}

function DesktopLoginButton(): React.ReactElement {
  const [desktopLoggedIn, setDesktopLoggedIn] = useState<boolean | null>(null);
  const [desktopPrincipal, setDesktopPrincipal] = useState<string | null>(null);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) {
      setDesktopLoggedIn(false);
      return;
    }
    let cancelled = false;
    void desktopAuthStatus().then((s) => {
      if (!cancelled) {
        setDesktopLoggedIn(s.loggedIn);
        setDesktopPrincipal(s.principal);
      }
    });
    const off = bridge.auth.onAuthChanged((snap) => {
      setDesktopLoggedIn(snap.loggedIn);
      setDesktopPrincipal(snap.principal);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const bridge = desktopBridge();
  if (desktopLoggedIn === null || !bridge) {
    return (
      <button type="button" style={{ ...btnStyle, cursor: 'wait' }} disabled aria-label="Checking sign-in status">
        <GoogleG /> Checking…
      </button>
    );
  }
  if (desktopLoggedIn) {
    const label = desktopPrincipal ?? 'Signed in';
    return (
      <span
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        aria-label={`Signed in as ${label}`}
      >
        <span style={{ fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <button
          type="button"
          style={btnStyle}
          onClick={() => void bridge.auth.logout()}
          aria-label="Sign out"
        >
          Sign out
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      style={btnStyle}
      onClick={() => void bridge.auth.openLoginWindow()}
      aria-label="Sign in with Google"
    >
      <GoogleG /> Sign in with Google
    </button>
  );
}

function WebLoginButton({ auth }: { auth: FirebaseAuthService }): React.ReactElement {
  const [state, setState] = useState<FirebaseAuthState>(auth.current);

  useEffect(() => auth.subscribe(setState), [auth]);

  const signIn = (): void => {
    void auth.signInWithGoogle();
  };
  const signOut = (): void => {
    void auth.signOut();
  };

  if (state.status === 'logged-in') {
    const { user } = state;
    const label = user.displayName || user.email || user.uid;
    const initial = (label.trim()[0] ?? '?').toUpperCase();
    return (
      <span
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        aria-label={`Signed in as ${label}`}
      >
        {user.photoURL ? (
          <img
            src={user.photoURL}
            alt=""
            width={22}
            height={22}
            referrerPolicy="no-referrer"
            style={{ borderRadius: '50%', display: 'block' }}
          />
        ) : (
          <span
            aria-hidden="true"
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: '#3b82f6',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {initial}
          </span>
        )}
        <span style={{ fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <button type="button" style={btnStyle} onClick={signOut} aria-label="Sign out">
          Sign out
        </button>
      </span>
    );
  }

  if (state.status === 'logging-in') {
    return (
      <button type="button" style={{ ...btnStyle, cursor: 'wait' }} disabled aria-label="Signing in">
        <GoogleG /> Signing in…
      </button>
    );
  }

  if (state.status === 'error') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span role="alert" style={{ fontSize: 12, color: '#b91c1c', maxWidth: 280 }}>
          {state.error.message}
        </span>
        <button type="button" style={btnStyle} onClick={signIn} aria-label="Try signing in again">
          <GoogleG /> Try again
        </button>
      </span>
    );
  }

  return (
    <button type="button" style={btnStyle} onClick={signIn} aria-label="Sign in with Google">
      <GoogleG /> Sign in with Google
    </button>
  );
}
