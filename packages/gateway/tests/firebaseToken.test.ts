/**
 * Unit tests for Firebase ID-token verification (Cycle 9).
 *
 * Uses self-signed test RSA keys + a stubbed cert fetch — no network, no
 * real Google certs. Fail-closed behavior is asserted throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearFirebaseCertCache,
  spkiFromPemCert,
  verifyFirebaseIdToken,
} from '../src/firebaseToken.js';
import {
  makeTestRsaKey,
  mintFirebaseToken,
  testFetchCerts,
  type TestRsaKey,
} from './firebaseTestKeys.js';

const PROJECT_ID = 'demo-project';

let key: TestRsaKey | null = null;
async function testKey(): Promise<TestRsaKey> {
  if (!key) key = await makeTestRsaKey();
  return key;
}

afterEach(() => {
  clearFirebaseCertCache();
});

describe('spkiFromPemCert', () => {
  it('extracts the exact SubjectPublicKeyInfo from a PEM cert', async () => {
    const k = await testKey();
    expect(spkiFromPemCert(k.certPem)).toEqual(k.spki);
  });

  it('rejects empty / non-RSA input', () => {
    expect(() => spkiFromPemCert('')).toThrow(/empty certificate/);
    expect(() => spkiFromPemCert('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toThrow();
  });
});

describe('verifyFirebaseIdToken', () => {
  it('accepts a well-formed token and returns the verified identity', async () => {
    const k = await testKey();
    const token = await mintFirebaseToken(k);
    const out = await verifyFirebaseIdToken(token, {
      projectId: PROJECT_ID,
      fetchCerts: testFetchCerts(k),
    });
    expect(out).toEqual({
      uid: 'firebase-uid-1',
      email: 'user@example.com',
      name: 'Test User',
      picture: 'https://example.com/pic.png',
    });
  });

  it('caches the cert fetch across verifications', async () => {
    const k = await testKey();
    let calls = 0;
    const fetchCerts = () => {
      calls++;
      return Promise.resolve({ certs: { [k.kid]: k.certPem }, maxAgeSeconds: 3600 });
    };
    const token = await mintFirebaseToken(k);
    await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts });
    await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts });
    expect(calls).toBe(1);
  });

  it('rejects a token signed by a different key (invalid signature)', async () => {
    const k = await testKey();
    const other = await makeTestRsaKey('other-kid');
    const token = await mintFirebaseToken(other, {}, { kid: k.kid }); // kid spoofed, sig from other key
    // Serve only k's cert: signature was made by `other`.
    await expect(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/invalid token signature/);
  });

  it('rejects audience mismatch', async () => {
    const k = await testKey();
    const token = await mintFirebaseToken(k, { aud: 'evil-project' });
    await expect(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/audience mismatch/);
  });

  it('rejects issuer mismatch', async () => {
    const k = await testKey();
    const token = await mintFirebaseToken(k, { iss: 'https://securetoken.google.com/evil' });
    await expect(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/issuer mismatch/);
  });

  it('rejects expired tokens', async () => {
    const k = await testKey();
    const now = Math.floor(Date.now() / 1000);
    const token = await mintFirebaseToken(k, { exp: now - 5, iat: now - 3700, auth_time: now - 3700 });
    await expect(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/expired/);
  });

  it('rejects tokens issued in the future', async () => {
    const k = await testKey();
    const now = Math.floor(Date.now() / 1000);
    const token = await mintFirebaseToken(k, { iat: now + 3600, auth_time: now + 3600 });
    await expect(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/issued in the future/);
  });

  it('rejects a missing auth_time', async () => {
    const k = await testKey();
    const token = await mintFirebaseToken(k, { auth_time: undefined });
    // auth_time: undefined is spread as absent — still fails the type check.
    await expect(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/auth_time/);
  });

  it('rejects unknown kid', async () => {
    const k = await testKey();
    const token = await mintFirebaseToken(k, {}, { kid: 'no-such-kid' });
    await expect(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/unknown signing key/);
  });

  it('rejects non-RS256 tokens', async () => {
    const k = await testKey();
    const token = await mintFirebaseToken(k, {}, { alg: 'HS256' });
    await expect(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/unsupported token alg/);
  });

  it('rejects malformed tokens', async () => {
    const k = await testKey();
    await expect(
      verifyFirebaseIdToken('not.a.token', { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/malformed/);
    await expect(
      verifyFirebaseIdToken('', { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/idToken is required/);
  });

  it('rejects a missing subject', async () => {
    const k = await testKey();
    const token = await mintFirebaseToken(k, { sub: '' });
    await expect(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, fetchCerts: testFetchCerts(k) }),
    ).rejects.toThrow(/missing subject/);
  });
});
