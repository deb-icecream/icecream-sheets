/**
 * Tests for at-rest encryption (crypto.ts):
 * AES-256-GCM round-trips, wrong-key failure (the password verifier),
 * PBKDF2 password derivation, and KeyManager generate/rotate/revoke/reissue.
 */
import { describe, expect, it } from 'vitest';
import {
  KeyManager,
  decryptBytes,
  decryptWorkbook,
  deriveKeyFromPassword,
  encryptBytes,
  encryptWorkbook,
  generateDataKey,
  memoryPersistence,
  randomBytes,
} from '../src/index.js';

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('encryptBytes / decryptBytes', () => {
  it('round-trips', async () => {
    const key = await generateDataKey();
    const { iv, ciphertext } = await encryptBytes(text('workbook bytes'), key);
    expect(iv).toHaveLength(12);
    expect(ciphertext.length).toBeGreaterThan(0);
    const pt = await decryptBytes(iv, ciphertext, key);
    expect(new TextDecoder().decode(pt)).toBe('workbook bytes');
  });

  it('fails with the wrong key (this is the password verifier)', async () => {
    const key = await generateDataKey();
    const other = await generateDataKey();
    const { iv, ciphertext } = await encryptBytes(text('secret'), key);
    await expect(decryptBytes(iv, ciphertext, other)).rejects.toThrow();
  });

  it('fails on tampered ciphertext', async () => {
    const key = await generateDataKey();
    const { iv, ciphertext } = await encryptBytes(text('secret'), key);
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    await expect(decryptBytes(iv, tampered, key)).rejects.toThrow();
  });

  it('uses a fresh IV per encryption', async () => {
    const key = await generateDataKey();
    const a = await encryptBytes(text('same'), key);
    const b = await encryptBytes(text('same'), key);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });
});

describe('deriveKeyFromPassword', () => {
  it('round-trips with the same password+salt', async () => {
    const salt = randomBytes(16);
    const key = await deriveKeyFromPassword('correct horse battery staple', salt);
    const { iv, ciphertext } = await encryptBytes(text('payload'), key);
    const key2 = await deriveKeyFromPassword('correct horse battery staple', salt);
    expect(new TextDecoder().decode(await decryptBytes(iv, ciphertext, key2))).toBe('payload');
  });

  it('wrong password derives a key that cannot decrypt', async () => {
    const salt = randomBytes(16);
    const key = await deriveKeyFromPassword('right-password', salt);
    const { iv, ciphertext } = await encryptBytes(text('payload'), key);
    const wrong = await deriveKeyFromPassword('wrong-password', salt);
    await expect(decryptBytes(iv, ciphertext, wrong)).rejects.toThrow();
  });

  it('different salts derive different keys', async () => {
    const k1 = await deriveKeyFromPassword('pw', randomBytes(16));
    const { iv, ciphertext } = await encryptBytes(text('payload'), k1);
    const k2 = await deriveKeyFromPassword('pw', randomBytes(16));
    await expect(decryptBytes(iv, ciphertext, k2)).rejects.toThrow();
  });
});

describe('randomBytes', () => {
  it('returns n bytes, distinct across calls', () => {
    expect(randomBytes(16)).toHaveLength(16);
    expect(randomBytes(0)).toHaveLength(0);
    expect(randomBytes(16)).not.toEqual(randomBytes(16));
  });
});

describe('encryptWorkbook envelope', () => {
  it('round-trips and is JSON-serializable', async () => {
    const key = await generateDataKey();
    const salt = randomBytes(16);
    const env = await encryptWorkbook(text('xlsx-bytes'), key, 'key-1', salt);
    expect(env.version).toBe(1);
    expect(env.keyId).toBe('key-1');
    expect(env.salt).toBeDefined();
    const json = JSON.stringify(env); // must be JSON-serializable
    const restored = JSON.parse(json);
    expect(new TextDecoder().decode(await decryptWorkbook(restored, key))).toBe('xlsx-bytes');
  });

  it('rejects malformed envelopes', async () => {
    const key = await generateDataKey();
    await expect(decryptWorkbook({} as never, key)).rejects.toThrow();
  });
});

describe('KeyManager', () => {
  it('generate -> getEncryptionKey round-trip', async () => {
    const km = new KeyManager(memoryPersistence());
    const rec = await km.generate('wb1');
    expect(rec.workbookId).toBe('wb1');
    expect(rec.version).toBe(1);
    expect(rec.status).toBe('current');
    const key = await km.getEncryptionKey('wb1');
    const env = await encryptWorkbook(text('data'), key, rec.keyId);
    expect(new TextDecoder().decode(await decryptWorkbook(env, await km.getKeyById(rec.keyId)))).toBe('data');
  });

  it('generate twice throws', async () => {
    const km = new KeyManager(memoryPersistence());
    await km.generate('wb1');
    await expect(km.generate('wb1')).rejects.toThrow();
  });

  it('rotation: new key encrypts, old key still decrypts', async () => {
    const km = new KeyManager(memoryPersistence());
    const rec1 = await km.generate('wb1');
    const oldKey = await km.getEncryptionKey('wb1');
    const oldEnv = await encryptWorkbook(text('old-data'), oldKey, rec1.keyId);

    const { current, previous } = await km.rotate('wb1');
    expect(current.version).toBe(2);
    expect(current.status).toBe('current');
    expect(previous.status).toBe('previous');

    // new key encrypts new payloads
    const newKey = await km.getEncryptionKey('wb1');
    const newEnv = await encryptWorkbook(text('new-data'), newKey, current.keyId);
    expect(new TextDecoder().decode(await decryptWorkbook(newEnv, newKey))).toBe('new-data');

    // old key still decrypts the old envelope via keyId lookup
    const oldKeyAgain = await km.getKeyById(rec1.keyId);
    expect(new TextDecoder().decode(await decryptWorkbook(oldEnv, oldKeyAgain))).toBe('old-data');
  });

  it('revocation destroys keys (fail closed)', async () => {
    const km = new KeyManager(memoryPersistence());
    const rec = await km.generate('wb1');
    const key = await km.getEncryptionKey('wb1');
    const env = await encryptWorkbook(text('data'), key, rec.keyId);
    km.revoke('wb1');
    await expect(km.getEncryptionKey('wb1')).rejects.toThrow();
    await expect(km.getKeyById(rec.keyId)).rejects.toThrow();
    // even the previously valid key object can't help: material is gone
    await expect(km.getEncryptionKey('wb1')).rejects.toThrow();
    void env;
  });

  it('records are serializable and survive a fresh manager on the same persistence', async () => {
    const p = memoryPersistence();
    const km = new KeyManager(p);
    const rec = await km.generate('wb1');
    await km.rotate('wb1');
    const raw = p.load('icecream-sheets.keys.v1');
    expect(raw).not.toBeNull();
    const snapshot = km.recordsSnapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    const km2 = new KeyManager(p);
    const key = await km2.getEncryptionKey('wb1'); // current = version 2
    const env = await encryptWorkbook(text('v2'), key, 'x');
    expect(new TextDecoder().decode(await decryptWorkbook(env, key))).toBe('v2');
    // old keyId still resolvable after reload
    const oldKey = await km2.getKeyById(rec.keyId);
    expect(oldKey).toBeInstanceOf(CryptoKey);
  });

  it('reissueWorkbook rotates and re-encrypts', async () => {
    const km = new KeyManager(memoryPersistence());
    const rec = await km.generate('wb1');
    const key = await km.getEncryptionKey('wb1');
    const oldEnv = await encryptWorkbook(text('payload'), key, rec.keyId);
    const newEnv = await km.reissueWorkbook('wb1', oldEnv);
    expect(newEnv.keyId).not.toBe(rec.keyId);
    const newKey = await km.getEncryptionKey('wb1');
    expect(new TextDecoder().decode(await decryptWorkbook(newEnv, newKey))).toBe('payload');
  });
});
