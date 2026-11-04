/**
 * POST /auth/firebase endpoint tests (Cycle 9: Firebase Google login).
 *
 * The desktop login exchanges the Firebase ID token here for the gateway
 * JWT, so this pins the contract the desktop depends on: request shape,
 * 200 response shape (a gateway JWT verifiable with the gateway secret),
 * 503 when the project id is not configured, 401 on a rejected token.
 * The Firebase verifier itself is mocked — its own tests live in
 * firebaseToken.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@icecream-sheets/service';
import { createGateway, type GatewayListener } from '../src/gateway.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

vi.mock('../src/firebaseToken.js', () => ({
  verifyFirebaseIdToken: vi.fn(),
}));

const { verifyFirebaseIdToken } = await import('../src/firebaseToken.js');
const mockVerify = verifyFirebaseIdToken as unknown as ReturnType<typeof vi.fn>;

const SECRET = 'test-gateway-secret';

describe('POST /auth/firebase', () => {
  let gateway: Started | null = null;
  let listener: GatewayListener | null = null;

  async function setup(firebaseProjectId?: string) {
    listener = createGateway({
      authSecret: SECRET,
      routes: {},
      rateLimit: { points: 1000, perSeconds: 60 },
      firebaseProjectId,
    });
    gateway = await startServer(listener);
  }

  afterEach(async () => {
    if (gateway) await stop(gateway);
    gateway = null;
    listener = null;
    mockVerify.mockReset();
  });

  it('returns 503 when no Firebase project id is configured', async () => {
    await setup(undefined);
    const r = await httpJson('POST', `${gateway!.url}/auth/firebase`, {
      body: { idToken: 'fake.token.here' },
    });
    expect(r.status).toBe(503);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('exchanges a verified Firebase token for a gateway JWT', async () => {
    mockVerify.mockResolvedValue({ uid: 'firebase-uid-1', email: 'a@example.com', name: 'A' });
    await setup('demo-project');
    const r = await httpJson('POST', `${gateway!.url}/auth/firebase`, {
      body: { idToken: 'fake.token.here' },
    });
    expect(r.status).toBe(200);
    const json = r.json as { ok: boolean; token: string; userId: string; expiresIn: number };
    expect(json.ok).toBe(true);
    expect(json.userId).toBe('firebase-uid-1');
    // The minted token is a real gateway JWT for the Firebase uid.
    const claims = await verifyToken(json.token, SECRET);
    expect(claims.userId).toBe('firebase-uid-1');
    expect(claims.attrs['email']).toBe('a@example.com');
    expect(mockVerify).toHaveBeenCalledWith('fake.token.here', { projectId: 'demo-project' });
  });

  it('returns 401 when the Firebase token is rejected', async () => {
    mockVerify.mockRejectedValue(new Error('firebase: token expired'));
    await setup('demo-project');
    const r = await httpJson('POST', `${gateway!.url}/auth/firebase`, {
      body: { idToken: 'bad.token.here' },
    });
    expect(r.status).toBe(401);
    expect((r.json as { error: string }).error).toMatch(/invalid firebase id token/);
  });

  it('returns 400 when idToken is missing', async () => {
    await setup('demo-project');
    const r = await httpJson('POST', `${gateway!.url}/auth/firebase`, {
      body: {},
    });
    expect(r.status).toBe(400);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
