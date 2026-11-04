/**
 * Gateway POST /auth/firebase tests (Cycle 9): Firebase ID token →
 * gateway JWT exchange.
 *
 * The gateway's cert fetch is stubbed at the module level: firebaseToken
 * caches certs in-module, so these tests would hit the network without a
 * stub. We point the stub at our self-signed test cert by seeding the
 * in-module cache via the exported test hook… instead, this suite runs
 * against a gateway built with a stubbed global fetch: firebaseToken
 * calls globalThis.fetch for the Google certs URL, so stubbing fetch for
 * that one URL keeps everything else real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@icecream-sheets/service';
import { createGateway, type GatewayListener } from '../src/gateway.js';
import { clearFirebaseCertCache } from '../src/firebaseToken.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';
import {
  makeTestRsaKey,
  mintFirebaseToken,
  type TestRsaKey,
} from './firebaseTestKeys.js';

const SECRET = 'test-firebase-exchange-secret';
const PROJECT_ID = 'demo-project';

let key: TestRsaKey | null = null;
async function testKey(): Promise<TestRsaKey> {
  if (!key) key = await makeTestRsaKey('exchange-kid');
  return key;
}

/**
 * Stub globalThis.fetch ONLY for the Google certs URL; delegate every
 * other request (the tests' own HTTP calls to the gateway) to the real
 * fetch. Returns a restore function.
 */
function stubCertFetch(certPem: string): () => void {
  const realFetch = globalThis.fetch;
  const stub = (async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    if (url.includes('googleapis.com/robot/v1/metadata/x509')) {
      return new Response(JSON.stringify({ 'exchange-kid': certPem }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
      });
    }
    return (realFetch as typeof fetch)(input as never, init as never);
  }) as typeof fetch;
  vi.stubGlobal('fetch', stub);
  return () => vi.unstubAllGlobals();
}

describe('POST /auth/firebase', () => {
  let gateway: Started | null = null;
  let listener: GatewayListener | null = null;
  let restoreFetch: (() => void) | null = null;

  async function setup(firebaseProjectId?: string) {
    listener = createGateway({
      authSecret: SECRET,
      firebaseProjectId,
      routes: {},
      rateLimit: { points: 1000, perSeconds: 60 },
    });
    gateway = await startServer(listener);
  }

  beforeEach(async () => {
    const k = await testKey();
    restoreFetch = stubCertFetch(k.certPem);
  });

  afterEach(async () => {
    if (gateway) await stop(gateway);
    gateway = null;
    listener = null;
    restoreFetch?.();
    restoreFetch = null;
    clearFirebaseCertCache();
  });

  async function exchange(idToken: unknown) {
    return httpJson('POST', `${gateway!.url}/auth/firebase`, { body: { idToken } });
  }

  it('exchanges a valid Firebase ID token for a gateway JWT', async () => {
    await setup(PROJECT_ID);
    const k = await testKey();
    const idToken = await mintFirebaseToken(k);
    const r = await exchange(idToken);
    expect(r.status).toBe(200);
    const json = r.json as { ok: boolean; token: string; userId: string; expiresIn: number };
    expect(json.ok).toBe(true);
    expect(json.userId).toBe('firebase-uid-1');
    // The minted JWT verifies with the gateway secret and names the
    // user:<uid> principal.
    const claims = await verifyToken(json.token, SECRET);
    expect(claims.userId).toBe('firebase-uid-1');
    expect(claims.attrs['name']).toBe('Test User');
    expect(claims.attrs['email']).toBe('user@example.com');
    expect(json.expiresIn).toBeGreaterThan(0);
  });

  it('the minted JWT passes GET /auth/me', async () => {
    await setup(PROJECT_ID);
    const k = await testKey();
    const idToken = await mintFirebaseToken(k);
    const r = await exchange(idToken);
    const token = (r.json as { token: string }).token;
    const me = await httpJson('GET', `${gateway!.url}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect((me.json as { principal: string }).principal).toBe('user:firebase-uid-1');
  });

  it('returns 503 when Firebase is not configured on the gateway', async () => {
    await setup(undefined);
    const k = await testKey();
    const r = await exchange(await mintFirebaseToken(k));
    expect(r.status).toBe(503);
    expect(r.text).toMatch(/FIREBASE_PROJECT_ID/);
  });

  it('returns 401 for a token signed by an unknown key', async () => {
    await setup(PROJECT_ID);
    const k = await testKey();
    const other = await makeTestRsaKey('attacker-kid');
    // Attacker signs with their own key but claims the test kid.
    const forged = await mintFirebaseToken(other, {}, { kid: k.kid });
    const r = await exchange(forged);
    expect(r.status).toBe(401);
    expect(r.text).toMatch(/invalid firebase id token/);
  });

  it('returns 401 for a token minted for a different project', async () => {
    await setup(PROJECT_ID);
    const k = await testKey();
    const r = await exchange(await mintFirebaseToken(k, { aud: 'other-project' }));
    expect(r.status).toBe(401);
    expect(r.text).toMatch(/audience mismatch/);
  });

  it('returns 400 for a missing idToken', async () => {
    await setup(PROJECT_ID);
    for (const bad of [undefined, '', 42]) {
      const r = await httpJson('POST', `${gateway!.url}/auth/firebase`, { body: { idToken: bad } });
      expect(r.status).toBe(400);
    }
  });

  it('rate-limits repeated exchange attempts per IP', async () => {
    listener = createGateway({
      authSecret: SECRET,
      firebaseProjectId: PROJECT_ID,
      routes: {},
      rateLimit: { points: 2, perSeconds: 60 },
    });
    gateway = await startServer(listener);
    const k = await testKey();
    const idToken = await mintFirebaseToken(k);
    expect((await exchange(idToken)).status).toBe(200);
    expect((await exchange(idToken)).status).toBe(200);
    const r = await exchange(idToken);
    expect(r.status).toBe(429);
  });
});
