/**
 * Cloud Scheduler OIDC verification for the trigger tick endpoint
 * (triggers program, Scope update 2 — design: hidden_files/triggers/
 * BRIEF.md "Scope update 2").
 *
 * The tick endpoint accepts ONLY a Google-issued OIDC ID token
 * presented by the Cloud Scheduler job's service account:
 *  - RS256 signature verified against Google's JWKS (cached);
 *  - issuer is Google; token not expired;
 *  - audience equals TRIGGER_TICK_AUDIENCE (the tick endpoint's URL —
 *    the audience the scheduler job is created with);
 *  - the token's email equals TRIGGER_TICK_SA_EMAIL (the dedicated
 *    scheduler service account) and is verified.
 * Anything else — missing config, missing/malformed token, bad
 * signature, wrong audience or identity — is refused (fail closed).
 * TRIGGER_TICK_JWKS_URL overrides the JWKS endpoint (tests use a
 * local stand-in IdP; production uses the Google default).
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

export const DEFAULT_TICK_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const JWKS_CACHE_MS = 10 * 60 * 1000;

export interface TickAuthEnv {
  audience: string;
  saEmail: string;
  jwksUrl: string;
}

/** Read the tick auth config; null when not (fully) configured. */
export function tickAuthConfig(env: NodeJS.ProcessEnv): TickAuthEnv | null {
  const audience = (env.TRIGGER_TICK_AUDIENCE ?? '').trim();
  const saEmail = (env.TRIGGER_TICK_SA_EMAIL ?? '').trim();
  if (!audience || !saEmail) return null;
  const jwksUrl = (env.TRIGGER_TICK_JWKS_URL ?? '').trim() || DEFAULT_TICK_JWKS_URL;
  return { audience, saEmail, jwksUrl };
}

interface JwksCache {
  url: string;
  at: number;
  keys: Map<string, KeyObject>;
}
let jwksCache: JwksCache | null = null;

async function loadKey(
  jwksUrl: string,
  kid: string,
  fetchFn: typeof fetch,
): Promise<KeyObject | null> {
  const now = Date.now();
  if (jwksCache && jwksCache.url === jwksUrl && now - jwksCache.at < JWKS_CACHE_MS) {
    const hit = jwksCache.keys.get(kid);
    if (hit) return hit;
  }
  const res = await fetchFn(jwksUrl);
  if (!res.ok) return null;
  const body = (await res.json()) as { keys?: Record<string, unknown>[] };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    const kidValue = jwk.kid;
    if (typeof kidValue !== 'string') continue;
    try {
      keys.set(
        kidValue,
        createPublicKey({ key: jwk as never, format: 'jwk' }),
      );
    } catch {
      // Skip unusable keys; verification fails closed below.
    }
  }
  jwksCache = { url: jwksUrl, at: now, keys };
  return keys.get(kid) ?? null;
}

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * Verify a Scheduler OIDC Authorization header against the config.
 * Returns true only for a fully valid token from the configured
 * scheduler service account. Never throws.
 */
export async function verifySchedulerOidc(
  authorization: string | undefined,
  config: TickAuthEnv,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    if (!authorization || !authorization.startsWith('Bearer ')) return false;
    const token = authorization.slice('Bearer '.length).trim();
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = b64urlJson(parts[0]!);
    const claims = b64urlJson(parts[1]!);
    if (!header || !claims) return false;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
    const key = await loadKey(config.jwksUrl, header.kid, fetchFn);
    if (!key) return false;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (!verifier.verify(key, signature)) return false;
    const iss = claims.iss;
    if (typeof iss !== 'string' || !GOOGLE_ISSUERS.has(iss)) return false;
    const exp = claims.exp;
    if (typeof exp !== 'number' || exp * 1000 <= nowMs - 60_000) return false;
    if (claims.aud !== config.audience) return false;
    if (claims.email !== config.saEmail) return false;
    if (claims.email_verified !== true) return false;
    return true;
  } catch {
    return false;
  }
}
