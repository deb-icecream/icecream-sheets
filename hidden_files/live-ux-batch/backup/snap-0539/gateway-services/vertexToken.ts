/**
 * GCP OAuth2 access-token providers for Vertex AI calls from service
 * processes (used by the agent service's dictation route).
 *
 * Two sources, tried in order:
 * 1. A service-account key file (GOOGLE_APPLICATION_CREDENTIALS) — the
 *    local-dev path: the key's private key signs a JWT that is
 *    exchanged at the OAuth2 token endpoint (standard service-account
 *    flow; the key never leaves the process and is never logged).
 * 2. The GCE/Cloud Run metadata server — the deployed path, where the
 *    service runs under its attached service account.
 *
 * Both cache until shortly before expiry and fail SOFT (return null)
 * so callers can surface one clear "credentials not configured" error.
 */

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const REFRESH_SKEW_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

type FetchImpl = typeof fetch;

interface ServiceAccountKey {
  client_email?: string;
  private_key?: string;
}

/** Token provider backed by a service-account key file (JWT exchange). */
export function createServiceAccountTokenProvider(
  keyFilePath: string,
  fetchImpl: FetchImpl = fetch,
): () => Promise<string | null> {
  let cached: CachedToken | null = null;
  let keyPromise: Promise<ServiceAccountKey | null> | null = null;
  const loadKey = (): Promise<ServiceAccountKey | null> => {
    if (!keyPromise) {
      keyPromise = readFile(keyFilePath, 'utf8')
        .then((text) => JSON.parse(text) as ServiceAccountKey)
        .catch(() => null);
    }
    return keyPromise;
  };
  return async () => {
    if (cached && cached.expiresAtMs - Date.now() > REFRESH_SKEW_MS) return cached.token;
    const key = await loadKey();
    if (!key?.client_email || !key?.private_key) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const unsigned =
      `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
      base64url(
        JSON.stringify({
          iss: key.client_email,
          scope: CLOUD_PLATFORM_SCOPE,
          aud: TOKEN_URL,
          iat: nowSec,
          exp: nowSec + 3600,
        }),
      );
    let assertion: string;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(unsigned);
      assertion = `${unsigned}.${base64url(signer.sign(key.private_key))}`;
    } catch {
      return null;
    }
    let res: Response;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number }
      | null;
    if (!json?.access_token) return null;
    cached = {
      token: json.access_token,
      expiresAtMs: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  };
}

/** Token provider backed by the GCE/Cloud Run metadata server. */
export function createMetadataTokenProvider(
  fetchImpl: FetchImpl = fetch,
): () => Promise<string | null> {
  let cached: CachedToken | null = null;
  return async () => {
    if (cached && cached.expiresAtMs - Date.now() > REFRESH_SKEW_MS) return cached.token;
    let res: Response;
    try {
      res = await fetchImpl(METADATA_TOKEN_URL, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number }
      | null;
    if (!json?.access_token) return null;
    cached = {
      token: json.access_token,
      expiresAtMs: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  };
}

/**
 * The environment chain: service-account key file when
 * GOOGLE_APPLICATION_CREDENTIALS is set (local dev), else the metadata
 * server (deployed). Returns null when neither yields a token.
 */
export function createGcpAccessTokenProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchImpl = fetch,
): () => Promise<string | null> {
  const fromKeyFile = env.GOOGLE_APPLICATION_CREDENTIALS
    ? createServiceAccountTokenProvider(env.GOOGLE_APPLICATION_CREDENTIALS, fetchImpl)
    : null;
  const fromMetadata = createMetadataTokenProvider(fetchImpl);
  return async () => {
    if (fromKeyFile) {
      const token = await fromKeyFile();
      if (token) return token;
    }
    return fromMetadata();
  };
}
