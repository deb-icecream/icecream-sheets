/**
 * Password-to-open / password-on-download round-trips (faces a & b).
 *
 * The password derives the encryption key (PBKDF2); it is never stored.
 * A wrong password fails GCM authentication — that failure IS the verifier.
 */
import { describe, expect, it } from 'vitest';
import {
  decryptFileWithPassword,
  encryptFileWithPassword,
  encryptedFilename,
  isEncryptedFile,
  parseEncryptedFile,
} from './fileCrypto.js';

const XLSX_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

describe('password-protected files', () => {
  it('encrypt -> decrypt round-trips the exact bytes', async () => {
    const enc = await encryptFileWithPassword(XLSX_MAGIC, 's3cret', 'budget.xlsx');
    expect(isEncryptedFile(enc)).toBe(true);
    expect(isEncryptedFile(XLSX_MAGIC)).toBe(false);
    const { bytes, filename } = await decryptFileWithPassword(enc, 's3cret');
    expect(bytes).toEqual(XLSX_MAGIC);
    expect(filename).toBe('budget.xlsx');
  });

  it('a wrong password fails to decrypt (and never reveals bytes)', async () => {
    const enc = await encryptFileWithPassword(XLSX_MAGIC, 'right', 'a.xlsx');
    await expect(decryptFileWithPassword(enc, 'wrong')).rejects.toThrow(/wrong password/i);
  });

  it('the envelope never contains the password', async () => {
    const enc = await encryptFileWithPassword(XLSX_MAGIC, 'never-store-me', 'a.xlsx');
    const text = new TextDecoder().decode(enc);
    expect(text).not.toContain('never-store-me');
    const env = parseEncryptedFile(enc);
    expect(env.salt).toBeDefined();
    expect(typeof env.ciphertext).toBe('string');
  });

  it('same password + random salts produce different ciphertexts', async () => {
    const a = await encryptFileWithPassword(XLSX_MAGIC, 'same', 'a.xlsx');
    const b = await encryptFileWithPassword(XLSX_MAGIC, 'same', 'a.xlsx');
    expect(new TextDecoder().decode(a)).not.toBe(new TextDecoder().decode(b));
  });

  it('tampered ciphertext fails authentication', async () => {
    const enc = await encryptFileWithPassword(XLSX_MAGIC, 'pw', 'a.xlsx');
    const env = parseEncryptedFile(enc);
    // Flip a byte in the decoded ciphertext, re-encode.
    const raw = JSON.parse(new TextDecoder().decode(enc)) as Record<string, string>;
    const chars = raw.ciphertext!.split('');
    chars[10] = chars[10] === 'A' ? 'B' : 'A';
    raw.ciphertext = chars.join('');
    const tampered = new TextEncoder().encode(JSON.stringify(raw));
    expect(env.ciphertext).toBeDefined();
    await expect(decryptFileWithPassword(tampered, 'pw')).rejects.toThrow();
  });

  it('rejects empty passwords and garbage input', async () => {
    await expect(encryptFileWithPassword(XLSX_MAGIC, '', 'a.xlsx')).rejects.toThrow();
    await expect(decryptFileWithPassword(XLSX_MAGIC, 'pw')).rejects.toThrow();
    expect(isEncryptedFile(new Uint8Array([]))).toBe(false);
  });

  it('encryptedFilename keeps the .xlsx hint', () => {
    expect(encryptedFilename('budget.xlsx')).toBe('budget.xlsx.enc');
  });
});
