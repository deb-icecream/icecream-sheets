/**
 * Firebase Auth port (Cycle 9, Phase 1 — web login).
 *
 * Thin wrapper over the Firebase JS SDK with two implementations:
 *  - the real one (createFirebasePort), which lazy-loads `firebase/app`
 *    and `firebase/auth` via dynamic import, uses signInWithPopup with
 *    GoogleAuthProvider ONLY (no username/password), and keeps the
 *    browser-local session persistence the SDK provides;
 *  - the unconfigured stub, returned when the Firebase project config is
 *    missing — every call fails with a clear config-missing error instead
 *    of a cryptic SDK failure.
 *
 * The auth state machine (firebaseAuth.ts) depends on this interface, so
 * unit tests inject a fake and never hit real Firebase.
 */

import { firebaseConfigError, getFirebaseConfig, type FirebaseWebConfig } from './firebaseConfig';

export interface PortUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  /** Fresh Firebase ID token for the gateway exchange. */
  getIdToken(): Promise<string>;
}

export interface FirebasePort {
  /** True when a complete Firebase config is present. */
  isConfigured(): boolean;
  /** Clear setup message when !isConfigured(), else null. */
  configError(): string | null;
  /** Google sign-in popup. Rejects with Firebase-style { code, message }. */
  signInWithGooglePopup(): Promise<PortUser>;
  /**
   * Delete the currently signed-in Firebase user (the SDK's
   * deleteUser). Rejects with { code: 'auth/requires-recent-login' }
   * when the session is too old — the caller re-authenticates and
   * retries once.
   */
  deleteCurrentUser(): Promise<void>;
  /** Re-authenticate the current user via the Google popup. */
  reauthenticateCurrentUserWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  /** Restored session user (SDK persistence), or null. */
  getCurrentUser(): PortUser | null;
  onAuthStateChanged(cb: (user: PortUser | null) => void): () => void;
}

export class FirebaseNotConfiguredError extends Error {
  readonly code = 'config-missing';
  constructor(message: string) {
    super(message);
    this.name = 'FirebaseNotConfiguredError';
  }
}

/** Unconfigured stub: config seam reports the problem, every op fails loudly. */
export function createUnconfiguredPort(): FirebasePort {
  const err = (): FirebaseNotConfiguredError =>
    new FirebaseNotConfiguredError(
      firebaseConfigError() ?? 'Firebase is not configured.',
    );
  return {
    isConfigured: () => false,
    configError: () => firebaseConfigError() ?? 'Firebase is not configured.',
    signInWithGooglePopup: () => Promise.reject(err()),
    deleteCurrentUser: () => Promise.reject(err()),
    reauthenticateCurrentUserWithGoogle: () => Promise.reject(err()),
    signOut: () => Promise.reject(err()),
    getCurrentUser: () => null,
    onAuthStateChanged: () => () => {},
  };
}

/**
 * Real port. Resolves the config first (fails over to the unconfigured
 * stub — never a half-configured SDK), then lazy-loads the Firebase JS
 * SDK. Google provider only.
 */
export async function createFirebasePort(): Promise<FirebasePort> {
  const config: FirebaseWebConfig | null = getFirebaseConfig();
  if (!config) return createUnconfiguredPort();

  const { initializeApp, getApps } = await import('firebase/app');
  const {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut: fbSignOut,
    onAuthStateChanged: fbOnAuthStateChanged,
    deleteUser,
    reauthenticateWithPopup,
  } = await import('firebase/auth');

  const app = getApps().length > 0 ? getApps()[0]! : initializeApp(config);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  // Request the basic profile scopes; signInWithPopup defaults to these,
  // but being explicit keeps the Google-only intent visible.
  provider.addScope('profile');
  provider.addScope('email');

  const wrap = (u: {
    uid: string;
    email: string | null;
    displayName: string | null;
    photoURL: string | null;
    getIdToken: (forceRefresh?: boolean) => Promise<string>;
  }): PortUser => ({
    uid: u.uid,
    email: u.email,
    displayName: u.displayName,
    photoURL: u.photoURL,
    getIdToken: () => u.getIdToken(),
  });

  return {
    isConfigured: () => true,
    configError: () => null,
    signInWithGooglePopup: async () => {
      const cred = await signInWithPopup(auth, provider);
      return wrap(cred.user);
    },
    deleteCurrentUser: async () => {
      const user = auth.currentUser;
      if (!user) {
        throw { code: 'auth/no-current-user', message: 'No Firebase user is signed in.' };
      }
      await deleteUser(user);
    },
    reauthenticateCurrentUserWithGoogle: async () => {
      const user = auth.currentUser;
      if (!user) {
        throw { code: 'auth/no-current-user', message: 'No Firebase user is signed in.' };
      }
      await reauthenticateWithPopup(user, provider);
    },
    signOut: () => fbSignOut(auth),
    getCurrentUser: () => (auth.currentUser ? wrap(auth.currentUser) : null),
    onAuthStateChanged: (cb) => fbOnAuthStateChanged(auth, (u) => cb(u ? wrap(u) : null)),
  };
}
