/**
 * Tests for the credential vault (vault.ts): store/retrieve round-trip,
 * authorization failures (fail closed), revocation, and that listRefs and
 * persisted state never leak secret values.
 */
import { describe, expect, it } from 'vitest';
import { CredentialVault, KeyManager, memoryPersistence } from '../src/index.js';

const ALLOW_ALL = () => true;
const DENY_ALL = () => false;

async function makeVault(check: (action: string, target: string) => boolean = ALLOW_ALL) {
  const persistence = memoryPersistence();
  const keys = new KeyManager(memoryPersistence());
  const vault = await CredentialVault.create(persistence, keys, { check });
  return { vault, persistence, keys };
}

describe('CredentialVault', () => {
  it('store/retrieve round-trips', async () => {
    const { vault } = await makeVault();
    await vault.store('etl:stripe-api-key', 'sk-live-abc123', 'user:u1');
    expect(await vault.retrieve('etl:stripe-api-key', 'user:u1')).toBe('sk-live-abc123');
  });

  it('store overwrites an existing ref', async () => {
    const { vault } = await makeVault();
    await vault.store('ref', 'old', 'user:u1');
    await vault.store('ref', 'new', 'user:u1');
    expect(await vault.retrieve('ref', 'user:u1')).toBe('new');
  });

  it('denied requester throws on store/retrieve/revoke (fail closed)', async () => {
    const { vault } = await makeVault(DENY_ALL);
    await expect(vault.store('ref', 'secret', 'user:evil')).rejects.toThrow(/denied/);
    await expect(vault.retrieve('ref', 'user:evil')).rejects.toThrow(/denied/);
    await expect(vault.revoke('ref', 'user:evil')).rejects.toThrow(/denied/);
  });

  it('a check that throws also fails closed', async () => {
    const { vault } = await makeVault(() => {
      throw new Error('boom');
    });
    await expect(vault.retrieve('ref', 'user:u1')).rejects.toThrow(/denied/);
  });

  it('default check denies everything', async () => {
    const keys = new KeyManager(memoryPersistence());
    const vault = await CredentialVault.create(memoryPersistence(), keys);
    await expect(vault.store('ref', 'secret', 'user:u1')).rejects.toThrow(/denied/);
  });

  it('per-ref authorization is honored', async () => {
    const { vault } = await makeVault((action, target) => action === 'vault.retrieve' && target === 'public-ref');
    await expect(vault.store('ref', 'secret', 'user:u1')).rejects.toThrow(/denied/);
  });

  it('retrieve of an unknown ref throws', async () => {
    const { vault } = await makeVault();
    await expect(vault.retrieve('nope', 'user:u1')).rejects.toThrow(/unknown credential/);
  });

  it('revoke deletes; retrieve afterwards throws', async () => {
    const { vault } = await makeVault();
    await vault.store('ref', 'secret', 'user:u1');
    await vault.revoke('ref', 'user:u1');
    await expect(vault.retrieve('ref', 'user:u1')).rejects.toThrow(/unknown credential/);
    await expect(vault.revoke('ref', 'user:u1')).rejects.toThrow(/unknown credential/);
  });

  it('listRefs leaks nothing (refs only, never values)', async () => {
    const { vault } = await makeVault();
    await vault.store('etl:db-password', 'hunter2-hunter2', 'user:u1');
    await vault.store('etl:api-key', 'key-xyz', 'user:u1');
    const refs = vault.listRefs();
    expect(refs).toEqual(['etl:api-key', 'etl:db-password']);
    expect(JSON.stringify(refs)).not.toContain('hunter2');
    expect(JSON.stringify(refs)).not.toContain('key-xyz');
  });

  it('persisted state holds ciphertext, never plaintext secrets', async () => {
    const { vault, persistence } = await makeVault();
    const secret = 'super-secret-value-42';
    await vault.store('ref', secret, 'user:u1');
    const raw = persistence.load('icecream-sheets.vault.v1');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(secret);
  });

  it('entries survive reload when KeyManager persistence is shared', async () => {
    const persistence = memoryPersistence();
    const keyPersistence = memoryPersistence();
    const keys = new KeyManager(keyPersistence);
    const v1 = await CredentialVault.create(persistence, keys, { check: ALLOW_ALL });
    await v1.store('ref', 'sekret', 'user:u1');
    // fresh KeyManager over the same key persistence recovers the master key
    const keys2 = new KeyManager(keyPersistence);
    const v2 = await CredentialVault.create(persistence, keys2, { check: ALLOW_ALL });
    expect(await v2.retrieve('ref', 'user:u1')).toBe('sekret');
  });

  it('uses the reserved __vault__ key in the KeyManager', async () => {
    const { keys } = await makeVault();
    expect(keys.hasCurrentKey('__vault__')).toBe(true);
  });

  it('rejects empty refs/secrets/requesters', async () => {
    const { vault } = await makeVault();
    await expect(vault.store('', 's', 'user:u1')).rejects.toThrow();
    await expect(vault.store('ref', '', 'user:u1')).rejects.toThrow();
    await expect(vault.store('ref', 's', '')).rejects.toThrow();
  });
});
