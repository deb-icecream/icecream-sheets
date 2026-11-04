/**
 * Tier resolution for the voice command palette (a Pro-tier feature).
 *
 * The product layer stamps the caller's tier into OUR gateway JWT at
 * login (POST /auth/firebase and /auth/login — see the product-layer
 * contract): the claim lives in the token's `attrs` object
 * ({ sub, attrs: { tier } }) — verified against a live token in the
 * gateway-mode proof, after a first version that looked for a
 * top-level claim gated Pro users out. The palette reads the claim
 * decode-only from the stored token, the same pattern GatewayClient
 * uses for the `sub` claim (the gateway remains the verifier; this
 * only decides which UI state to render — execution still flows
 * through authorized engine paths).
 *
 * States:
 * - 'pro'        — JWT tier claim is 'pro': palette fully enabled.
 * - 'default'    — a gateway session exists and its claim is not 'pro'
 *                  (including a pre-product-layer token with no claim):
 *                  the palette renders its labeled Pro-only gate.
 * - 'standalone' — no gateway session (local web mode, desktop
 *                  logged-out): the hosted tier system is not engaged,
 *                  so the palette is enabled.
 */

export type PaletteTier = 'pro' | 'default' | 'standalone';

/** localStorage key the GatewayClient stores our JWT under. */
export const GATEWAY_TOKEN_KEY = 'icecream-sheets.gateway-token';

interface TokenStorage {
  getItem(key: string): string | null;
}

function defaultStorage(): TokenStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Decode one base64url JWT segment to JSON (decode-only, never trust). */
function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Resolve the palette tier from the stored gateway token (if any). */
export function resolvePaletteTier(storage: TokenStorage | null = defaultStorage()): PaletteTier {
  if (!storage) return 'standalone';
  let token: string | null = null;
  try {
    token = storage.getItem(GATEWAY_TOKEN_KEY);
  } catch {
    return 'standalone';
  }
  if (!token) return 'standalone';
  const payload = decodeSegment(token.split('.')[1] ?? '');
  if (!payload) return 'default'; // a session exists but is unreadable: fail closed
  // The stamped claim is attrs.tier; a top-level tier is also honored
  // so either issuance shape resolves.
  const attrs =
    payload.attrs && typeof payload.attrs === 'object'
      ? (payload.attrs as Record<string, unknown>)
      : null;
  const claim = payload.tier ?? attrs?.tier;
  return claim === 'pro' ? 'pro' : 'default';
}
