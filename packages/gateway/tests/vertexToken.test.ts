/**
 * GCP access-token providers for Vertex calls: the service-account JWT
 * exchange is verified end-to-end here — a throwaway RSA key signs, the
 * fake token endpoint captures the assertion, and the signature is
 * verified with the public key. Caching is pinned (two calls, one
 * exchange). No network, no real credentials.
 */
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServiceAccountTokenProvider } from '../src/services/vertexToken.js';

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('createServiceAccountTokenProvider', () => {
  it('exchanges a signed JWT for an access token and caches it', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const dir = mkdtempSync(join(tmpdir(), 'ics-sa-'));
    const keyPath = join(dir, 'key.json');
    writeFileSync(
      keyPath,
      JSON.stringify({
        type: 'service_account',
        client_email: 'icecream-deployer@dreamscapes-zero.iam.gserviceaccount.com',
        private_key: privatePem,
      }),
    );

    const assertions: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const params = new URLSearchParams(String(init.body));
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      assertions.push(params.get('assertion') ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'ya29.fake-token', expires_in: 3600 }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = createServiceAccountTokenProvider(keyPath, fetchImpl);
    const token = await provider();
    expect(token).toBe('ya29.fake-token');
    expect(assertions).toHaveLength(1);

    // The assertion is a well-formed RS256 JWT for the right audience,
    // and its signature verifies against the public key.
    const parts = assertions[0].split('.');
    expect(parts).toHaveLength(3);
    expect(decodeSegment(parts[0])).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    const claims = decodeSegment(parts[1]);
    expect(claims.iss).toBe('icecream-deployer@dreamscapes-zero.iam.gserviceaccount.com');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(String(claims.scope)).toContain('cloud-platform');
    const signatureOk = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
    expect(signatureOk).toBe(true);

    // Second call is served from the cache — no new exchange.
    const again = await provider();
    expect(again).toBe('ya29.fake-token');
    expect(assertions).toHaveLength(1);
  });

  it('returns null for a missing key file (fail soft)', async () => {
    const provider = createServiceAccountTokenProvider(
      '/nonexistent/key.json',
      (async () => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch,
    );
    expect(await provider()).toBeNull();
  });
});
