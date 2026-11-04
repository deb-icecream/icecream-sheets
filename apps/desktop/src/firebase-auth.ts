/**
 * Firebase → gateway token exchange (Cycle 9: Firebase Google login — desktop).
 *
 * After the login window completes Google sign-in, it hands the Firebase ID
 * token to the main process over IPC. This module exchanges that ID token
 * for the gateway JWT via POST /auth/firebase, then stores the JWT through
 * the SAME encrypted path as the local-dev login (services.saveToken) —
 * so the existing auth:status() plumbing, menu gating and serviceCall()
 * fail-closed behavior work unchanged. Logged-in desktop gets exactly the
 * same service access as logged-in web.
 *
 * The Firebase ID token itself is never persisted: it is exchanged
 * immediately and dropped.
 */

import {
  gatewayUrl,
  saveToken,
  status,
  type AuthStatus,
} from './services';

export interface FirebaseExchangeDeps {
  /** Defaults to the global fetch. Inject a fake in tests. */
  fetchFn?: typeof fetch;
  /** Defaults to gatewayUrl(). */
  gatewayBaseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Exchange a Firebase ID token for the gateway JWT and persist it.
 * Throws with a user-facing message on every failure mode:
 *  - empty/invalid ID token
 *  - network failure reaching the gateway
 *  - 400: the gateway rejected the Firebase token (bad signature, expired,
 *    wrong project)
 *  - 503: Firebase Auth is not configured on the gateway
 *  - 429: rate limited
 */
export async function loginWithFirebase(
  idToken: string,
  deps: FirebaseExchangeDeps = {},
): Promise<AuthStatus> {
  const token = typeof idToken === 'string' ? idToken.trim() : '';
  if (!token) throw new Error('sign-in failed: no Firebase credential was produced');
  if (token.split('.').length !== 3) {
    throw new Error('sign-in failed: the Firebase credential is malformed');
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const base = (deps.gatewayBaseUrl ?? gatewayUrl()).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetchFn(`${base}/auth/firebase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });
  } catch (err) {
    throw new Error(
      `sign-in failed: could not reach the gateway at ${base} (network failure): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  if (res.status === 503) {
    throw new Error(
      'sign-in failed: Firebase Auth is not configured on the gateway ' +
        '(the gateway needs its Firebase project id — set FIREBASE_PROJECT_ID where the gateway runs)',
    );
  }
  if (res.status === 429) {
    throw new Error('sign-in failed: rate limited by the gateway — try again shortly');
  }
  if (res.status === 400 || res.status === 401) {
    let detail = '';
    try {
      const body = (await res.json()) as unknown;
      if (isRecord(body) && typeof body['error'] === 'string') detail = `: ${body['error']}`;
    } catch {
      // Ignore body parse failures — the status already says enough.
    }
    throw new Error(
      `sign-in failed: the gateway rejected the Google sign-in${detail} — please sign in again`,
    );
  }
  if (!res.ok) {
    throw new Error(`sign-in failed: gateway returned ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('sign-in failed: the gateway returned an unreadable response');
  }
  const jwt = isRecord(body) && typeof body['token'] === 'string' ? body['token'] : null;
  if (!jwt) throw new Error('sign-in failed: the gateway returned no token');

  saveToken(jwt);
  return status();
}
