/**
 * JWT identity for the service boundary (pure WebCrypto HMAC-SHA256, no deps).
 *
 * Per design-docs/permission-model.md §5: the JWT carries identity ONLY —
 * the verified user id plus coarse slow-changing attributes (e.g.
 * displayName). Per-object permissions are NEVER in token claims: tokens
 * would bloat, go stale on revocation, and every check reads the live
 * access tree anyway.
 *
 * Fail closed: bad signature, expired, not-yet-valid, or malformed tokens
 * all throw.
 */

const te = new TextEncoder();

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// HMAC key
// ---------------------------------------------------------------------------

async function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  if (typeof secret === 'string' && secret.length === 0) {
    throw new Error('auth: secret must not be empty');
  }
  if (secret instanceof Uint8Array && secret.length === 0) {
    throw new Error('auth: secret must not be empty');
  }
  const raw = typeof secret === 'string' ? te.encode(secret) : (secret as Uint8Array);
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Verified identity claims. Identity only — never per-object permissions. */
export interface VerifiedClaims {
  /** The verified user id (JWT `sub`). */
  userId: string;
  /** Coarse, slow-changing attributes (e.g. displayName). String values only. */
  attrs: Record<string, string>;
  iat: number;
  exp: number;
}

export interface IssueOptions {
  userId: string;
  /** Coarse attributes only — never per-object permissions. */
  attrs?: Record<string, string>;
  secret: string | Uint8Array;
  /** Lifetime in seconds. */
  ttlSeconds: number;
  /** For tests: issue-at as unix seconds (defaults to now). */
  issuedAt?: number;
}

interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
}

interface JwtPayload {
  sub: string;
  attrs: Record<string, string>;
  iat: number;
  exp: number;
}

/**
 * Issue a signed JWT (header.payload.signature, base64url, HS256).
 * Claims carry identity only.
 */
export async function issueToken(opts: IssueOptions): Promise<string> {
  const { userId, secret, ttlSeconds } = opts;
  if (typeof userId !== 'string' || userId.length === 0) throw new Error('auth: userId is required');
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error('auth: ttlSeconds must be positive');
  const iat = opts.issuedAt ?? Math.floor(Date.now() / 1000);
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.attrs ?? {})) {
    if (typeof k === 'string' && typeof v === 'string') attrs[k] = v;
  }
  const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
  const payload: JwtPayload = { sub: userId, attrs, iat, exp: iat + ttlSeconds };
  const headB64 = b64urlEncode(te.encode(JSON.stringify(header)));
  const payB64 = b64urlEncode(te.encode(JSON.stringify(payload)));
  const signingInput = te.encode(`${headB64}.${payB64}`);
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, signingInput));
  return `${headB64}.${payB64}.${b64urlEncode(sig)}`;
}

export interface VerifyOptions {
  /** For tests: unix seconds to verify against (defaults to now). */
  nowSeconds?: number;
  /** Allowed clock skew for iat in the future (seconds). Default 60. */
  clockSkewSeconds?: number;
}

/**
 * Verify a JWT. Returns the identity claims. Throws (fail closed) on:
 * malformed token, wrong alg, bad signature, expired, issued-in-the-future,
 * wrong secret, or invalid claim shapes.
 */
export async function verifyToken(
  token: string,
  secret: string | Uint8Array,
  opts: VerifyOptions = {},
): Promise<VerifiedClaims> {
  if (typeof token !== 'string') throw new Error('auth: token must be a string');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new Error('auth: malformed token');
  }
  const [headB64, payB64, sigB64] = parts;

  let header: Partial<JwtHeader>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(headB64))) as Partial<JwtHeader>;
  } catch {
    throw new Error('auth: malformed token header');
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new Error('auth: unsupported token header (expected HS256 JWT)');
  }

  const key = await hmacKey(secret);
  const signingInput = te.encode(`${headB64}.${payB64}`);
  let signature: Uint8Array;
  try {
    signature = b64urlDecode(sigB64);
  } catch {
    throw new Error('auth: malformed token signature');
  }
  const ok = await globalThis.crypto.subtle.verify('HMAC', key, signature as BufferSource, signingInput);
  if (!ok) throw new Error('auth: invalid token signature');

  let payload: Partial<JwtPayload>;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payB64))) as Partial<JwtPayload>;
  } catch {
    throw new Error('auth: malformed token payload');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('auth: token missing subject');
  }
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw new Error('auth: token missing iat/exp');
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSeconds ?? 60;
  if (payload.exp <= now) throw new Error('auth: token expired');
  if (payload.iat > now + skew) throw new Error('auth: token issued in the future');

  const attrs: Record<string, string> = {};
  if (payload.attrs && typeof payload.attrs === 'object') {
    for (const [k, v] of Object.entries(payload.attrs)) {
      if (typeof v === 'string') attrs[k] = v;
    }
  }
  return { userId: payload.sub, attrs, iat: payload.iat, exp: payload.exp };
}

/**
 * Principal string for the access table from verified claims: `user:<userId>`.
 * Fails closed on ids that would make the principal ambiguous.
 */
export function principalFromToken(claims: Pick<VerifiedClaims, 'userId'>): string {
  const id = claims?.userId;
  if (typeof id !== 'string' || id.length === 0) throw new Error('auth: cannot build principal from empty user id');
  if (/[:\s]/.test(id)) throw new Error('auth: user id contains characters illegal in a principal');
  return `user:${id}`;
}
