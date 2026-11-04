/**
 * Password-protected workbooks (protection faces a & b).
 *
 * (a) Password-to-open: the password DERIVES the encryption key (PBKDF2);
 *     the password itself is never stored. The encrypted file is a JSON
 *     envelope wrapping the XLSX bytes.
 * (b) Password-on-download: the same envelope mechanism encrypts the
 *     downloaded file with a user-supplied password.
 *
 * Encryption primitives live in @icecream-sheets/service (crypto.ts) per
 * AGENT.md §0 — this module is the thin web-app binding: envelope framing,
 * detection, and the encrypt/decrypt flows.
 */
import {
  b64ToBytes,
  bytesToB64,
  decryptWorkbook,
  deriveKeyFromPassword,
  encryptWorkbook,
  randomBytes,
  type EncryptedWorkbook,
} from '@icecream-sheets/service';

const ENVELOPE_MARKER = 'icecreamEncrypted';

/** JSON envelope framing the EncryptedWorkbook payload. */
export interface EncryptedFileEnvelope extends EncryptedWorkbook {
  [ENVELOPE_MARKER]: true;
  /** Original filename hint (e.g. "budget.xlsx"). */
  filename?: string;
}

/** Is this buffer an encrypted-workbook envelope (face a/b)? */
export function isEncryptedFile(data: Uint8Array): boolean {
  if (data.length === 0 || data[0] !== 0x7b) return false; // '{'
  try {
    const text = new TextDecoder().decode(data.slice(0, 512));
    const parsed = JSON.parse(text) as Partial<EncryptedFileEnvelope>;
    return parsed[ENVELOPE_MARKER] === true;
  } catch {
    return false;
  }
}

/** Parse a validated envelope (throws on malformed input). */
export function parseEncryptedFile(data: Uint8Array): EncryptedFileEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error('Not an encrypted workbook file.');
  }
  const env = parsed as Partial<EncryptedFileEnvelope>;
  if (env[ENVELOPE_MARKER] !== true || env.version !== 1 || typeof env.ciphertext !== 'string') {
    throw new Error('Not an encrypted workbook file.');
  }
  return env as EncryptedFileEnvelope;
}

/**
 * Encrypt raw workbook bytes (e.g. XLSX) with a password (face b).
 * Returns the JSON envelope bytes ready for download.
 */
export async function encryptFileWithPassword(
  plaintext: Uint8Array,
  password: string,
  filename?: string,
): Promise<Uint8Array> {
  if (!password) throw new Error('encryptFileWithPassword: password is required');
  const salt = randomBytes(16);
  const key = await deriveKeyFromPassword(password, salt);
  const envelope = await encryptWorkbook(plaintext, key, 'password', salt);
  const framed: EncryptedFileEnvelope = {
    ...envelope,
    [ENVELOPE_MARKER]: true,
    ...(filename ? { filename } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(framed));
}

/**
 * Decrypt an encrypted workbook file with the password (face a).
 * Throws when the password is wrong (GCM authentication fails) — the
 * failure IS the password verifier; no password hash is ever stored.
 */
export async function decryptFileWithPassword(
  data: Uint8Array,
  password: string,
): Promise<{ bytes: Uint8Array; filename?: string }> {
  const envelope = parseEncryptedFile(data);
  if (!envelope.salt) throw new Error('Encrypted file is missing its key salt.');
  const key = await deriveKeyFromPassword(password, b64ToBytes(envelope.salt));
  let bytes: Uint8Array;
  try {
    bytes = await decryptWorkbook(envelope, key);
  } catch {
    throw new Error('Wrong password — could not decrypt this workbook.');
  }
  return { bytes, filename: envelope.filename };
}

/** Filename for a password-encrypted download. */
export function encryptedFilename(name: string): string {
  return name.endsWith('.xlsx') ? `${name}.enc` : `${name}.xlsx.enc`;
}

export { bytesToB64, b64ToBytes };
