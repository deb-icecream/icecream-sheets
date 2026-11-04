/**
 * At-rest encryption for the service boundary.
 *
 * Per design-docs/workbook-protection-and-encryption.md:
 * - §3: workbook data is encrypted at rest in service storage; keys are
 *   managed by the service key management system (KeyManager below).
 * - §4: password protection — the password derives the encryption key.
 *   Passwords are never stored; only the salt travels with the payload.
 *   Decryption with the wrong password fails, which is the verifier
 *   (no separate password hash is needed).
 * - §7: keys are per-workbook; rotation keeps the old key for decryption
 *   and issues a new one for encryption; compromised keys are revoked.
 * - §9: v1 excludes customer-managed keys, field-level encryption and
 *   digital signatures.
 *
 * WebCrypto only (crypto.subtle): works in browsers and Node 20+.
 * Pure/headless: no DOM, no engine imports.
 */

import type { Persistence } from './metadataStore.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('crypto: WebCrypto subtle is unavailable in this environment');
  return s;
}

/** Cryptographically secure random bytes. */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error('crypto: randomBytes needs a non-negative integer');
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Result of encryptBytes: everything needed to decrypt. */
export interface EncryptedBytes {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * AES-256-GCM encrypt. Generates a fresh 96-bit IV per call.
 * The key must be an AES-GCM 256-bit CryptoKey with 'encrypt' usage.
 */
export async function encryptBytes(plaintext: Uint8Array, key: CryptoKey): Promise<EncryptedBytes> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource);
  return { iv, ciphertext: new Uint8Array(ct) };
}

/**
 * AES-256-GCM decrypt. Throws when the key is wrong, the IV is wrong, or
 * the ciphertext was tampered with. This failure IS the password verifier:
 * a wrong password derives the wrong key, so decryption fails.
 */
export async function decryptBytes(iv: Uint8Array, ciphertext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(pt);
}

/**
 * Derive an AES-GCM 256-bit key from a password via PBKDF2-SHA256 with
 * 210,000 iterations. The salt must be random per workbook and is stored
 * alongside the encrypted payload (in the envelope) — the password itself
 * is never stored anywhere.
 */
export async function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('crypto: password must be a non-empty string');
  }
  if (!(salt instanceof Uint8Array) || salt.length < 16) {
    throw new Error('crypto: salt must be at least 16 bytes');
  }
  const base = await subtle().importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 210_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Generate a fresh random AES-256-GCM data key (extractable so the KeyManager can persist it). */
export async function generateDataKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Export a data key's raw bytes (for the KeyManager's serializable records). */
export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle().exportKey('raw', key));
}

/** Import raw key bytes back into an AES-GCM CryptoKey. */
export async function importKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// ---------------------------------------------------------------------------
// base64 helpers (envelope serialization)
// ---------------------------------------------------------------------------

const B64_CHUNK = 0x8000;

/** base64-encode bytes (chunked so large workbooks don't blow the stack). */
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
}

/** base64-decode to bytes. */
export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Encrypted workbook envelope
// ---------------------------------------------------------------------------

/**
 * JSON-serializable envelope for an encrypted workbook.
 * - version: envelope format version (1).
 * - keyId: which KeyManager key encrypted this payload (needed after rotation).
 * - salt: base64 PBKDF2 salt, present only when a password-derived key
 *   was used. The password is never stored.
 * - iv / ciphertext: base64 AES-256-GCM output.
 */
export interface EncryptedWorkbook {
  version: 1;
  keyId: string;
  salt?: string;
  iv: string;
  ciphertext: string;
}

/**
 * Encrypt workbook bytes into an envelope. Pass the PBKDF2 `salt` when the
 * key was password-derived so the opener can re-derive it.
 */
export async function encryptWorkbook(
  plaintext: Uint8Array,
  key: CryptoKey,
  keyId: string,
  salt?: Uint8Array,
): Promise<EncryptedWorkbook> {
  const { iv, ciphertext } = await encryptBytes(plaintext, key);
  return {
    version: 1,
    keyId,
    ...(salt ? { salt: bytesToB64(salt) } : {}),
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(ciphertext),
  };
}

/** Decrypt an envelope back to workbook bytes. Throws on wrong key/tampering. */
export async function decryptWorkbook(envelope: EncryptedWorkbook, key: CryptoKey): Promise<Uint8Array> {
  if (!envelope || envelope.version !== 1 || typeof envelope.keyId !== 'string') {
    throw new Error('crypto: malformed EncryptedWorkbook envelope');
  }
  return decryptBytes(b64ToBytes(envelope.iv), b64ToBytes(envelope.ciphertext), key);
}

// ---------------------------------------------------------------------------
// KeyManager — per-workbook keys, rotation, revocation
// ---------------------------------------------------------------------------

export const KEYS_STORAGE_KEY = 'icecream-sheets.keys.v1';
export const KEYS_RECORD_VERSION = 1;

export type KeyStatus = 'current' | 'previous' | 'revoked';

/**
 * Serializable key record for the service metadata store.
 * keyB64 holds the raw AES-256 key bytes (base64) — the metadata store is
 * inside the trust boundary. An empty keyB64 means the material was
 * destroyed (revoked).
 */
export interface KeyRecord {
  keyId: string;
  workbookId: string;
  version: number;
  keyB64: string;
  status: KeyStatus;
  createdAt: string;
  rotatedAt?: string;
}

interface StoredKeys {
  version: number;
  keys: KeyRecord[];
}

/**
 * Service key management (§7). One KeyManager per service instance;
 * records persist through the injected Persistence adapter so they can
 * live in the service metadata store.
 */
export class KeyManager {
  private records = new Map<string, KeyRecord>(); // keyId -> record
  /**
   * In-flight ensureKey()/generate() calls, keyed by scope. Concurrent
   * callers share one generation instead of racing check-then-generate.
   */
  private readonly pendingEnsure = new Map<string, Promise<KeyRecord>>();

  constructor(private readonly persistence?: Persistence) {
    this.load();
  }

  // -- lifecycle -----------------------------------------------------------

  /** Generate the first key for a workbook. Throws if one already exists. */
  async generate(workbookId: string): Promise<KeyRecord> {
    assertId(workbookId);
    if (this.currentRecord(workbookId)) {
      throw new Error(`keys: workbook ${workbookId} already has a key (use rotate)`);
    }
    const record = await this.newRecord(workbookId, 1);
    this.records.set(record.keyId, record);
    this.save();
    return { ...record };
  }

  /**
   * Idempotent get-or-create: returns the current key record for a scope,
   * generating it exactly once even under concurrent calls. Prefer this
   * over the hasCurrentKey()+generate() pair, which races: two interleaved
   * callers can both pass the check and generate competing keys (and the
   * loser's save() then clobbers the winner's records).
   */
  async ensureKey(scopeId: string): Promise<KeyRecord> {
    assertId(scopeId);
    const current = this.currentRecord(scopeId);
    if (current) return { ...current };
    let pending = this.pendingEnsure.get(scopeId);
    if (!pending) {
      pending = this.generate(scopeId).finally(() => {
        if (this.pendingEnsure.get(scopeId) === pending) this.pendingEnsure.delete(scopeId);
      });
      this.pendingEnsure.set(scopeId, pending);
    }
    return pending;
  }

  /**
   * Rotate: the old key stays (status 'previous') for decrypting existing
   * payloads; the new key (status 'current') is used for new encryption.
   */
  async rotate(workbookId: string): Promise<{ current: KeyRecord; previous: KeyRecord }> {
    assertId(workbookId);
    const old = this.currentRecord(workbookId);
    if (!old) throw new Error(`keys: no key to rotate for workbook ${workbookId}`);
    old.status = 'previous';
    old.rotatedAt = new Date().toISOString();
    const next = await this.newRecord(workbookId, old.version + 1);
    this.records.set(next.keyId, next);
    this.save();
    return { current: { ...next }, previous: { ...old } };
  }

  /**
   * Revoke: destroys all key material for the workbook (keyB64 zeroed) and
   * marks every record revoked. Previously encrypted payloads become
   * undecryptable — that is the point.
   */
  revoke(workbookId: string): void {
    assertId(workbookId);
    let found = false;
    for (const r of this.records.values()) {
      if (r.workbookId === workbookId) {
        r.status = 'revoked';
        r.keyB64 = '';
        found = true;
      }
    }
    if (!found) throw new Error(`keys: no key to revoke for workbook ${workbookId}`);
    this.save();
  }

  /**
   * Reissue = rotate + re-encrypt: decrypts the envelope with the old key,
   * rotates to a new key, and returns the payload re-encrypted under the
   * new key's keyId. Fails closed if the old key is gone.
   */
  async reissueWorkbook(workbookId: string, envelope: EncryptedWorkbook): Promise<EncryptedWorkbook> {
    const oldKey = await this.getKeyById(envelope.keyId);
    const plaintext = await decryptWorkbook(envelope, oldKey);
    const { current } = await this.rotate(workbookId);
    const newKey = await this.getKeyById(current.keyId);
    return encryptWorkbook(plaintext, newKey, current.keyId);
  }

  // -- lookup --------------------------------------------------------------

  /** True when a usable (non-revoked) current key exists. */
  hasCurrentKey(workbookId: string): boolean {
    return this.currentRecord(workbookId) !== undefined;
  }

  /** The current encryption key for a workbook. Throws when missing/revoked. */
  async getEncryptionKey(workbookId: string): Promise<CryptoKey> {
    const r = this.currentRecord(workbookId);
    if (!r) throw new Error(`keys: no current key for workbook ${workbookId}`);
    return this.materialize(r);
  }

  /** Look up any non-revoked key by keyId (current or previous — for decryption). */
  async getKeyById(keyId: string): Promise<CryptoKey> {
    const r = this.records.get(keyId);
    if (!r || r.status === 'revoked' || r.keyB64.length === 0) {
      throw new Error(`keys: key ${keyId} is unavailable (revoked or unknown)`);
    }
    return this.materialize(r);
  }

  /** Serializable snapshot of all records (for the metadata store / tests). */
  recordsSnapshot(): KeyRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  // -- internals -----------------------------------------------------------

  private async newRecord(workbookId: string, version: number): Promise<KeyRecord> {
    const key = await generateDataKey();
    const raw = await exportKeyRaw(key);
    // keyId embeds the workbook id and version for human debugging; a random
    // suffix keeps ids unique across re-generations.
    const suffix = [...randomBytes(6)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return {
      keyId: `${workbookId}:v${version}:${suffix}`,
      workbookId,
      version,
      keyB64: bytesToB64(raw),
      status: 'current',
      createdAt: new Date().toISOString(),
    };
  }

  private currentRecord(workbookId: string): KeyRecord | undefined {
    for (const r of this.records.values()) {
      if (r.workbookId === workbookId && r.status === 'current') return r;
    }
    return undefined;
  }

  private async materialize(record: KeyRecord): Promise<CryptoKey> {
    if (record.status === 'revoked' || record.keyB64.length === 0) {
      throw new Error(`keys: key ${record.keyId} has been revoked`);
    }
    return importKeyRaw(b64ToBytes(record.keyB64));
  }

  private load(): void {
    if (!this.persistence) return;
    const raw = this.persistence.load(KEYS_STORAGE_KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredKeys>;
      if (!Array.isArray(parsed.keys)) return;
      for (const k of parsed.keys) {
        if (isKeyRecord(k)) this.records.set(k.keyId, { ...k });
      }
    } catch {
      // Corrupt key store: start empty (fail closed — nothing decrypts).
    }
  }

  private save(): void {
    if (!this.persistence) return;
    const stored: StoredKeys = { version: KEYS_RECORD_VERSION, keys: this.recordsSnapshot() };
    this.persistence.save(KEYS_STORAGE_KEY, JSON.stringify(stored));
  }
}

function isKeyRecord(x: unknown): x is KeyRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.keyId === 'string' &&
    typeof r.workbookId === 'string' &&
    typeof r.version === 'number' &&
    typeof r.keyB64 === 'string' &&
    (r.status === 'current' || r.status === 'previous' || r.status === 'revoked')
  );
}

function assertId(workbookId: string): void {
  if (typeof workbookId !== 'string' || workbookId.length === 0) {
    throw new Error('keys: workbookId must be a non-empty string');
  }
}
