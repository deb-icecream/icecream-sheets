/**
 * Tests for JWT identity (auth.ts): issue/verify round-trip, expiry,
 * tampered signatures, wrong secrets, malformed tokens, and the
 * user:<id> principal helper. Claims carry identity only.
 */
import { describe, expect, it } from 'vitest';
import { issueToken, principalFromToken, verifyToken } from '../src/index.js';

const SECRET = 'test-hmac-secret-0123456789';

describe('issueToken / verifyToken', () => {
  it('round-trips identity claims', async () => {
    const token = await issueToken({
      userId: 'u123',
      attrs: { displayName: 'Debajyoti' },
      secret: SECRET,
      ttlSeconds: 3600,
    });
    expect(token.split('.')).toHaveLength(3);
    const claims = await verifyToken(token, SECRET);
    expect(claims.userId).toBe('u123');
    expect(claims.attrs).toEqual({ displayName: 'Debajyoti' });
    expect(claims.exp).toBe(claims.iat + 3600);
  });

  it('accepts a Uint8Array secret', async () => {
    const secret = new TextEncoder().encode(SECRET);
    const token = await issueToken({ userId: 'u1', secret, ttlSeconds: 60 });
    const claims = await verifyToken(token, secret);
    expect(claims.userId).toBe('u1');
  });

  it('throws on expired tokens', async () => {
    const token = await issueToken({ userId: 'u1', secret: SECRET, ttlSeconds: 60, issuedAt: 1000 });
    await expect(verifyToken(token, SECRET, { nowSeconds: 2000 })).rejects.toThrow(/expired/);
    // but still valid before expiry
    const claims = await verifyToken(token, SECRET, { nowSeconds: 1050 });
    expect(claims.userId).toBe('u1');
  });

  it('throws on tampered signatures', async () => {
    const token = await issueToken({ userId: 'u1', secret: SECRET, ttlSeconds: 60 });
    const parts = token.split('.');
    const tamperedSig = parts[2].slice(0, -1) + (parts[2].endsWith('A') ? 'B' : 'A');
    await expect(verifyToken(`${parts[0]}.${parts[1]}.${tamperedSig}`, SECRET)).rejects.toThrow(
      /signature/,
    );
  });

  it('throws on tampered payloads', async () => {
    const token = await issueToken({ userId: 'u1', secret: SECRET, ttlSeconds: 60 });
    const parts = token.split('.');
    // flip a char in the payload segment
    const tamperedPay = parts[1].slice(0, 4) + (parts[1][4] === 'A' ? 'B' : 'A') + parts[1].slice(5);
    await expect(verifyToken(`${parts[0]}.${tamperedPay}.${parts[2]}`, SECRET)).rejects.toThrow();
  });

  it('throws with the wrong secret', async () => {
    const token = await issueToken({ userId: 'u1', secret: SECRET, ttlSeconds: 60 });
    await expect(verifyToken(token, 'different-secret')).rejects.toThrow(/signature/);
  });

  it('throws on malformed tokens', async () => {
    await expect(verifyToken('not-a-token', SECRET)).rejects.toThrow(/malformed/);
    await expect(verifyToken('a.b', SECRET)).rejects.toThrow(/malformed/);
    await expect(verifyToken('', SECRET)).rejects.toThrow();
  });

  it('throws on tokens issued in the future', async () => {
    const token = await issueToken({ userId: 'u1', secret: SECRET, ttlSeconds: 3600, issuedAt: 999999 });
    await expect(verifyToken(token, SECRET, { nowSeconds: 1000 })).rejects.toThrow(/future/);
  });

  it('carries identity only — attrs are coarse strings, no permission fields', async () => {
    const token = await issueToken({
      userId: 'u1',
      attrs: { displayName: 'Ada' },
      secret: SECRET,
      ttlSeconds: 60,
    });
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
      ),
    );
    expect(Object.keys(payload).sort()).toEqual(['attrs', 'exp', 'iat', 'sub']);
  });
});

describe('principalFromToken', () => {
  it("builds 'user:<id>' principals", () => {
    expect(principalFromToken({ userId: 'abc' })).toBe('user:abc');
  });

  it('rejects ambiguous ids (fail closed)', () => {
    expect(() => principalFromToken({ userId: 'a:b' })).toThrow();
    expect(() => principalFromToken({ userId: '' })).toThrow();
    expect(() => principalFromToken({ userId: 'has space' })).toThrow();
  });
});
