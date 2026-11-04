/**
 * Firebase → gateway token exchange tests (Cycle 9: desktop login).
 *
 * Firebase itself is mocked at the HTTP boundary: the exchange only ever
 * sees a Firebase ID token string and talks to the gateway's
 * POST /auth/firebase. Electron (app/safeStorage) is mocked like the other
 * desktop tests; the token lands in the same encrypted store as the
 * local-dev login.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockUserData, mockSafeStorage } = vi.hoisted(() => ({
  mockUserData: { dir: '' },
  mockSafeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Uint8Array) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData.dir;
      throw new Error(`unexpected getPath(${name})`);
    },
  },
  safeStorage: mockSafeStorage,
}));

const { loginWithFirebase } = await import('../src/firebase-auth.js');
const { loadToken, status } = await import('../src/services.js');

/** A realistic gateway JWT payload (sub = Firebase uid). */
function fakeGatewayJwt(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, iat: 1, exp: 9999999999 })}.sig`;
}

function jsonResponse(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

describe('loginWithFirebase', () => {
  beforeEach(() => {
    mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icecream-auth-test-'));
  });

  afterEach(() => {
    fs.rmSync(mockUserData.dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const ID_TOKEN = 'header.payload.signature';

  it('exchanges the Firebase ID token for a gateway JWT and persists it', async () => {
    const jwt = fakeGatewayJwt('firebase-uid-123');
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true, token: jwt, userId: 'firebase-uid-123' }));
    const result = await loginWithFirebase(ID_TOKEN, {
      fetchFn: fetchFn as unknown as typeof fetch,
      gatewayBaseUrl: 'http://localhost:8100',
    });

    // The gateway got exactly the Firebase token, nothing else.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8100/auth/firebase');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ idToken: ID_TOKEN });

    // The SAME storage path as the local-dev login now holds the JWT.
    expect(loadToken()).toBe(jwt);
    expect(result).toEqual({ loggedIn: true, principal: 'firebase-uid-123' });
    expect(status().loggedIn).toBe(true);
  });

  it('rejects empty and malformed ID tokens without touching the network', async () => {
    const fetchFn = vi.fn();
    await expect(
      loginWithFirebase('', { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/no Firebase credential/);
    await expect(
      loginWithFirebase('not-a-jwt', { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/malformed/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(loadToken()).toBeNull();
  });

  it('maps gateway rejection (400/401) to a clear sign-in error', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(401, { error: 'invalid firebase id token: token expired' }),
    );
    await expect(
      loginWithFirebase(ID_TOKEN, { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/gateway rejected the Google sign-in.*token expired/);
    expect(loadToken()).toBeNull();
  });

  it('maps 503 to the gateway-not-configured error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(503, { error: 'firebase auth is not configured' }));
    await expect(
      loginWithFirebase(ID_TOKEN, { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('maps 429 to a rate-limit error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(429, { error: 'rate limit exceeded' }));
    await expect(
      loginWithFirebase(ID_TOKEN, { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/rate limited/);
  });

  it('maps network failure to a clear gateway-unreachable error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await expect(
      loginWithFirebase(ID_TOKEN, {
        fetchFn: fetchFn as unknown as typeof fetch,
        gatewayBaseUrl: 'http://localhost:8100',
      }),
    ).rejects.toThrow(/could not reach the gateway.*network failure/);
    expect(loadToken()).toBeNull();
  });

  it('fails closed when the gateway returns no token', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true }));
    await expect(
      loginWithFirebase(ID_TOKEN, { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/returned no token/);
    expect(loadToken()).toBeNull();
  });
});
