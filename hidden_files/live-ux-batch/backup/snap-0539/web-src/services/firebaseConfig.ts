/**
 * Firebase project configuration seam (Cycle 9, Phase 1 — web login).
 *
 * The Firebase project config (apiKey, authDomain, projectId, …) is NOT
 * available yet, so nothing is hardcoded here. The web app reads the
 * config from Vite env vars at build time:
 *
 *   VITE_FIREBASE_API_KEY        Firebase web API key
 *   VITE_FIREBASE_AUTH_DOMAIN    e.g. my-project.firebaseapp.com
 *   VITE_FIREBASE_PROJECT_ID     e.g. my-project
 *   VITE_FIREBASE_APP_ID         Firebase web app id ("1:…:web:…")
 *   VITE_FIREBASE_MEASUREMENT_ID (optional)
 *
 * Google provider ONLY (GoogleAuthProvider) — no username/password.
 * When any required value is missing, getFirebaseConfig() returns null
 * and firebaseConfigError() explains exactly what to set, so the UI can
 * fail with a clear message instead of a cryptic SDK error.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  /** Optional; only used if the project has Analytics enabled. */
  measurementId?: string;
}

export type EnvLike = Record<string, string | undefined>;

/** Required env var names, in the order they appear in the docs. */
export const REQUIRED_FIREBASE_ENV_VARS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

/** One-time setup instructions shown when the config is missing. */
export const FIREBASE_SETUP_INSTRUCTIONS =
  'Firebase Google sign-in is not configured. Create a Firebase project, ' +
  'enable the Google sign-in provider, register this web app, then set ' +
  'VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID ' +
  'and VITE_FIREBASE_APP_ID (see apps/web/.env.example) and rebuild.';

function readEnv(): EnvLike {
  try {
    const env = (import.meta as unknown as { env?: EnvLike }).env;
    if (env) return env;
  } catch {
    // ignore — non-Vite runtimes (tests) pass their env explicitly.
  }
  return {};
}

/**
 * The Firebase web config, or null when it is incomplete. Never returns a
 * half-filled config — partial keys are worse than none.
 */
export function getFirebaseConfig(env: EnvLike = readEnv()): FirebaseWebConfig | null {
  const apiKey = env['VITE_FIREBASE_API_KEY']?.trim();
  const authDomain = env['VITE_FIREBASE_AUTH_DOMAIN']?.trim();
  const projectId = env['VITE_FIREBASE_PROJECT_ID']?.trim();
  const appId = env['VITE_FIREBASE_APP_ID']?.trim();
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  const measurementId = env['VITE_FIREBASE_MEASUREMENT_ID']?.trim();
  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    ...(measurementId ? { measurementId } : {}),
  };
}

/**
 * Human-readable reason the config is missing, or null when complete.
 * Lists exactly which env vars are unset so the fix is obvious.
 */
export function firebaseConfigError(env: EnvLike = readEnv()): string | null {
  const missing = REQUIRED_FIREBASE_ENV_VARS.filter((k) => !env[k]?.trim());
  if (missing.length === 0) return null;
  return (
    `${FIREBASE_SETUP_INSTRUCTIONS} ` +
    `Missing: ${missing.join(', ')}.`
  );
}
