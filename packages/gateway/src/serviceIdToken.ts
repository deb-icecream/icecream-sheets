/**
 * Google ID-token provider for the gateway's service-family proxy.
 *
 * Production topology (deploy/deploy.sh step 7b): the combined
 * service-package Cloud Run service (`icecream-sheet-service`) grants
 * `roles/run.invoker` ONLY to the gateway's service account. Cloud Run
 * enforces that at the platform layer, BEFORE the request reaches the
 * service container: the caller must present a Google-issued ID token
 * (OIDC) whose audience is the target service's URL in
 * `Authorization: Bearer <id-token>`. Without one, Cloud Run answers
 * its own platform 401 HTML and the service never sees the request —
 * the deployed-stack failure this module fixes (deploy follow-up
 * Leg 1: POST /api/agent/message with a valid gateway JWT returned
 * Cloud Run's 401).
 *
 * Tokens come from the Cloud Run / GCE metadata server identity
 * endpoint for the gateway's attached service account:
 *
 *   GET http://metadata.google.internal/computeMetadata/v1/instance/
 *       service-accounts/default/identity?audience=<url>&format=full
 *   Header: Metadata-Flavor: Google
 *   → the raw ID token (a JWT) as the response body.
 *
 * ID tokens live 1h. They are cached in memory per audience and
 * refreshed shortly before expiry (the JWT's own `exp` claim governs;
 * an undecodable token falls back to a 1h lifetime).
 *
 * FAIL SOFT, by design: when the metadata server is absent (local
 * dev — every upstream is plain http on 127.0.0.1 and unauthenticated)
 * or errors, the provider returns null and the gateway proxies the
 * request EXACTLY as it did before this module existed (no
 * Authorization replacement). A short negative cache keeps a missing
 * metadata server from adding a failed lookup to every proxied
 * request in local dev; a transient prod failure therefore also
 * retries within ~30s rather than pinning the outage for an hour.
 *
 * This is NOT the Vertex access-token flow (services/vertexToken.ts):
 * that mints OAuth2 ACCESS tokens for Google APIs. This mints OIDC
 * ID tokens whose sole consumer is Cloud Run's platform invoker
 * check on the service-family upstreams.
 */

/** Default metadata server base (Cloud Run / GCE link-local name). */
export const METADATA_SERVER_BASE_URL = 'http://metadata.google.internal';

/** Refresh a cached token once it is within this window of expiry. */
export const ID_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

/** How long a failed lookup is remembered before retrying. */
export const ID_TOKEN_NEGATIVE_CACHE_MS = 30_000;

/** Metadata lookups must never stall a proxied request for long. */
export const ID_TOKEN_FETCH_TIMEOUT_MS = 2_000;

/** Fallback lifetime when a token's `exp` claim cannot be decoded. */
const ID_TOKEN_FALLBACK_LIFETIME_MS = 3_600_000;

/**
 * A service ID-token provider: given an audience (the target
 * service's URL), resolve a Google ID token for it, or null when no
 * token is available (metadata server absent / errored).
 */
export type ServiceIdTokenProvider = (audience: string) => Promise<string | null>;

export interface MetadataIdTokenProviderOptions {
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Metadata server base URL. Default METADATA_SERVER_BASE_URL. */
  metadataBaseUrl?: string;
  /** Clock override (tests). Default Date.now(). */
  nowMs?: () => number;
  /** Refresh skew override (tests). Default ID_TOKEN_REFRESH_SKEW_MS. */
  refreshSkewMs?: number;
  /** Negative-cache TTL override (tests). Default ID_TOKEN_NEGATIVE_CACHE_MS. */
  negativeCacheMs?: number;
}

interface CachedIdToken {
  token: string;
  expiresAtMs: number;
}

/**
 * The expiry (ms since epoch) encoded in a JWT's `exp` claim, or null
 * when the token is not a decodable JWT with a numeric `exp`. No
 * signature verification: the token comes straight from the metadata
 * server over the platform link, and Cloud Run verifies it on
 * receipt — here the claim is only a cache-refresh hint.
 */
export function idTokenExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** The metadata identity-endpoint URL for one audience. */
export function metadataIdentityUrl(audience: string, metadataBaseUrl: string = METADATA_SERVER_BASE_URL): string {
  const base = metadataBaseUrl.replace(/\/+$/, '');
  return (
    `${base}/computeMetadata/v1/instance/service-accounts/default/identity` +
    `?audience=${encodeURIComponent(audience)}&format=full`
  );
}

/**
 * ID-token provider backed by the metadata server, with per-audience
 * in-memory caching, in-flight request dedup, refresh-before-expiry,
 * and fail-soft nulls (see the module header).
 */
export function createMetadataIdTokenProvider(
  opts: MetadataIdTokenProviderOptions = {},
): ServiceIdTokenProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const metadataBaseUrl = opts.metadataBaseUrl ?? METADATA_SERVER_BASE_URL;
  const nowMs = opts.nowMs ?? Date.now;
  const refreshSkewMs = opts.refreshSkewMs ?? ID_TOKEN_REFRESH_SKEW_MS;
  const negativeCacheMs = opts.negativeCacheMs ?? ID_TOKEN_NEGATIVE_CACHE_MS;

  const cache = new Map<string, CachedIdToken>();
  const failedUntilMs = new Map<string, number>();
  const inFlight = new Map<string, Promise<string | null>>();

  const fetchToken = async (audience: string): Promise<string | null> => {
    let res: Response;
    try {
      res = await fetchImpl(metadataIdentityUrl(audience, metadataBaseUrl), {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(ID_TOKEN_FETCH_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let token: string;
    try {
      token = (await res.text()).trim();
    } catch {
      return null;
    }
    if (!token) return null;
    cache.set(audience, {
      token,
      expiresAtMs: idTokenExpiryMs(token) ?? nowMs() + ID_TOKEN_FALLBACK_LIFETIME_MS,
    });
    failedUntilMs.delete(audience);
    return token;
  };

  return async (audience: string): Promise<string | null> => {
    if (!audience) return null;
    const cached = cache.get(audience);
    if (cached && cached.expiresAtMs - nowMs() > refreshSkewMs) return cached.token;
    const failedUntil = failedUntilMs.get(audience);
    if (failedUntil !== undefined && failedUntil > nowMs()) return null;
    let pending = inFlight.get(audience);
    if (!pending) {
      pending = fetchToken(audience)
        .catch(() => null)
        .then((token) => {
          inFlight.delete(audience);
          if (token === null) failedUntilMs.set(audience, nowMs() + negativeCacheMs);
          return token;
        });
      inFlight.set(audience, pending);
    }
    return pending;
  };
}
