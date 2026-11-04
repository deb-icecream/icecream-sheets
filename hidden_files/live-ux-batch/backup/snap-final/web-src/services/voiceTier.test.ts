/**
 * Palette tier resolution tests: the JWT tier claim stamped at login
 * drives the Pro gate; no gateway session means the hosted tier system
 * is not engaged (standalone). The claim's real wire shape — nested in
 * the token's `attrs` object, verified against a live /auth/login
 * token in the gateway-mode proof — is pinned by its own cases.
 */
import { describe, expect, it } from 'vitest';
import { GATEWAY_TOKEN_KEY, resolvePaletteTier } from './voiceTier';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fakeToken(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.signature`;
}

function storageWith(token: string | null) {
  return {
    getItem: (key: string) => (key === GATEWAY_TOKEN_KEY ? token : null),
  };
}

describe('resolvePaletteTier', () => {
  it('no stored token → standalone (tier system not engaged)', () => {
    expect(resolvePaletteTier(storageWith(null))).toBe('standalone');
    expect(resolvePaletteTier(null)).toBe('standalone');
  });

  it('tier claim "pro" → pro', () => {
    expect(resolvePaletteTier(storageWith(fakeToken({ sub: 'user:a', tier: 'pro' })))).toBe('pro');
  });

  it('the real wire shape — attrs.tier "pro" → pro', () => {
    const live = fakeToken({ sub: 'palette-pro', attrs: { tier: 'pro' }, iat: 1, exp: 2 });
    expect(resolvePaletteTier(storageWith(live))).toBe('pro');
  });

  it('the real wire shape — attrs.tier "default" → default (gated)', () => {
    const live = fakeToken({ sub: 'palette-default', attrs: { tier: 'default' }, iat: 1, exp: 2 });
    expect(resolvePaletteTier(storageWith(live))).toBe('default');
  });

  it('tier claim "default" → default (gated)', () => {
    expect(resolvePaletteTier(storageWith(fakeToken({ sub: 'user:a', tier: 'default' })))).toBe('default');
  });

  it('token without a tier claim → default (fail closed)', () => {
    expect(resolvePaletteTier(storageWith(fakeToken({ sub: 'user:a' })))).toBe('default');
  });

  it('garbage token with a session shape → default (fail closed)', () => {
    expect(resolvePaletteTier(storageWith('not-a-jwt'))).toBe('default');
  });
});
