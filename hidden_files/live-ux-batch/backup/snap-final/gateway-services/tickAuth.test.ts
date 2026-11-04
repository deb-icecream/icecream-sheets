/**
 * Scheduler tick OIDC verification (Scope update 2): a local stand-in
 * IdP (generated RSA key + JWKS endpoint) signs tokens exactly the
 * way Cloud Scheduler's Google-issued tokens are shaped; only a fully
 * valid token from the configured service account verifies.
 */
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  tickAuthConfig,
  verifySchedulerOidc,
  type TickAuthEnv,
} from './tickAuth.js';

const AUDIENCE = 'https://service.example/api/automation/tick';
const SA_EMAIL = 'icecream-trigger-tick@proj.iam.gserviceaccount.com';

let server: Server;
let jwksUrl: string;
let privateKey: KeyObject;
let config: TickAuthEnv;

function b64urlJson(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

function mint(claims: Record<string, unknown>, opts: { tamper?: boolean } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', kid: 'test-key-1', typ: 'JWT' });
  const payload = b64urlJson({
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    email: SA_EMAIL,
    email_verified: true,
    iat: now,
    exp: now + 600,
    ...claims,
  });
  const data = `${header}.${payload}`;
  const sig = sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
  return opts.tamper ? `${data}.${sig.split('').reverse().join('')}` : `${data}.${sig}`;
}

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const jwks = { keys: [{ ...jwk, kid: 'test-key-1', alg: 'RS256', use: 'sig' }] };
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  jwksUrl = `http://127.0.0.1:${port}/jwks`;
  config = { audience: AUDIENCE, saEmail: SA_EMAIL, jwksUrl };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('tickAuthConfig', () => {
  it('requires audience + SA email; defaults the JWKS URL to Google', () => {
    expect(tickAuthConfig({})).toBeNull();
    expect(tickAuthConfig({ TRIGGER_TICK_AUDIENCE: AUDIENCE })).toBeNull();
    const cfg = tickAuthConfig({
      TRIGGER_TICK_AUDIENCE: AUDIENCE,
      TRIGGER_TICK_SA_EMAIL: SA_EMAIL,
    });
    expect(cfg?.jwksUrl).toBe('https://www.googleapis.com/oauth2/v3/certs');
  });
});

describe('verifySchedulerOidc', () => {
  it('accepts a valid scheduler token', async () => {
    await expect(verifySchedulerOidc(`Bearer ${mint({})}`, config)).resolves.toBe(true);
  });

  it('refuses a wrong audience', async () => {
    await expect(
      verifySchedulerOidc(`Bearer ${mint({ aud: 'https://other.example/tick' })}`, config),
    ).resolves.toBe(false);
  });

  it('refuses a wrong service-account identity', async () => {
    await expect(
      verifySchedulerOidc(`Bearer ${mint({ email: 'attacker@example.com' })}`, config),
    ).resolves.toBe(false);
  });

  it('refuses an unverified email claim', async () => {
    await expect(
      verifySchedulerOidc(`Bearer ${mint({ email_verified: false })}`, config),
    ).resolves.toBe(false);
  });

  it('refuses an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifySchedulerOidc(`Bearer ${mint({ iat: now - 7200, exp: now - 3600 })}`, config),
    ).resolves.toBe(false);
  });

  it('refuses a non-Google issuer', async () => {
    await expect(
      verifySchedulerOidc(`Bearer ${mint({ iss: 'https://evil.example' })}`, config),
    ).resolves.toBe(false);
  });

  it('refuses a tampered signature', async () => {
    await expect(
      verifySchedulerOidc(`Bearer ${mint({}, { tamper: true })}`, config),
    ).resolves.toBe(false);
  });

  it('refuses missing or malformed headers', async () => {
    await expect(verifySchedulerOidc(undefined, config)).resolves.toBe(false);
    await expect(verifySchedulerOidc('Bearer not-a-jwt', config)).resolves.toBe(false);
    await expect(verifySchedulerOidc(mint({}), config)).resolves.toBe(false);
  });
});
