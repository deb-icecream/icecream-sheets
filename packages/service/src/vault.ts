/**
 * Credential vault for the service boundary.
 *
 * Per design-docs/etl-pipeline.md §6: "Credentials live in the service
 * vault. The recipe stores only credential references." A scheduled run
 * executes as the pipeline owner. Running a recipe requires read on the
 * credential and write on the target — that authorization happens via the
 * injected `check` callback (see access.ts), never inside stored recipes.
 *
 * Rules enforced here:
 * - Secrets are encrypted with the vault master key, which the KeyManager
 *   holds under the reserved id '__vault__'. Only credential REFERENCES are
 *   ever persisted in recipes/metadata; secret VALUES never leave the vault
 *   except to an authorized retriever.
 * - `check` is consulted on every store/retrieve/revoke. Denied (or a
 *   check that throws) fails closed. The default check denies everything.
 * - Secret values are never logged, never listed, and never appear in
 *   persisted payloads (only ciphertext does).
 */

import type { Persistence } from './metadataStore.js';
import { KeyManager, encryptBytes, decryptBytes, bytesToB64, b64ToBytes } from './crypto.js';

/** Reserved KeyManager id for the vault master key. */
export const VAULT_KEY_ID = '__vault__';
export const VAULT_STORAGE_KEY = 'icecream-sheets.vault.v1';
export const VAULT_RECORD_VERSION = 1;

export type VaultAction = 'vault.store' | 'vault.retrieve' | 'vault.revoke';

/**
 * Authorizer callback: return true to allow `action` on credential `target`
 * (the ref). Throwing or returning false denies — fail closed.
 */
export type VaultCheck = (action: VaultAction, target: string) => boolean;

interface StoredVaultEntry {
  iv: string;
  ciphertext: string;
  storedBy: string;
  storedAt: string;
}

interface StoredVault {
  version: number;
  entries: Record<string, StoredVaultEntry>;
}

export interface CredentialVaultOptions {
  /**
   * Authorizer. Defaults to deny-all (fail closed). Wire this to
   * accessPolicy()/authorize() in the service boundary.
   */
  check?: VaultCheck;
}

export class CredentialVault {
  private entries = new Map<string, StoredVaultEntry>();
  private masterKey: CryptoKey | null = null;
  private readonly check: VaultCheck;

  private constructor(
    private readonly persistence: Persistence,
    private readonly keys: KeyManager,
    opts: CredentialVaultOptions,
  ) {
    this.check = opts.check ?? (() => false);
  }

  /**
   * Create a vault. Ensures the vault master key exists in the KeyManager
   * (generating it on first use) and loads persisted entries.
   */
  static async create(
    persistence: Persistence,
    keys: KeyManager,
    opts: CredentialVaultOptions = {},
  ): Promise<CredentialVault> {
    const vault = new CredentialVault(persistence, keys, opts);
    await vault.init();
    return vault;
  }

  private async init(): Promise<void> {
    if (!this.keys.hasCurrentKey(VAULT_KEY_ID)) {
      await this.keys.generate(VAULT_KEY_ID);
    }
    this.masterKey = await this.keys.getEncryptionKey(VAULT_KEY_ID);
    const raw = this.persistence.load(VAULT_STORAGE_KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredVault>;
      if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null) {
        for (const [ref, e] of Object.entries(parsed.entries)) {
          if (isStoredEntry(e)) this.entries.set(ref, e);
        }
      }
    } catch {
      // Corrupt vault store: start empty (fail closed — nothing is retrievable).
    }
  }

  /** Store (or replace) a secret under a reference. Only the ref is ever shared with recipes. */
  async store(ref: string, secret: string, requester: string): Promise<void> {
    assertRef(ref);
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error('vault: secret must be a non-empty string');
    }
    assertRequester(requester);
    this.authorize('vault.store', ref);
    const { iv, ciphertext } = await encryptBytes(new TextEncoder().encode(secret), this.key());
    this.entries.set(ref, {
      iv: bytesToB64(iv),
      ciphertext: bytesToB64(ciphertext),
      storedBy: requester,
      storedAt: new Date().toISOString(),
    });
    this.persist();
  }

  /** Retrieve a secret by reference. Throws when denied or unknown (fail closed). */
  async retrieve(ref: string, requester: string): Promise<string> {
    assertRef(ref);
    assertRequester(requester);
    this.authorize('vault.retrieve', ref);
    const entry = this.entries.get(ref);
    if (!entry) throw new Error(`vault: unknown credential reference '${ref}'`);
    const bytes = await decryptBytes(b64ToBytes(entry.iv), b64ToBytes(entry.ciphertext), this.key());
    return new TextDecoder().decode(bytes);
  }

  /** Revoke (delete) a credential reference. */
  async revoke(ref: string, requester: string): Promise<void> {
    assertRef(ref);
    assertRequester(requester);
    this.authorize('vault.revoke', ref);
    if (!this.entries.delete(ref)) throw new Error(`vault: unknown credential reference '${ref}'`);
    this.persist();
  }

  /**
   * List credential references. Refs only — never values, never ciphertext.
   * (Refs are names like 'etl:stripe-api-key', safe to show in recipe UIs.)
   */
  listRefs(): string[] {
    return [...this.entries.keys()].sort();
  }

  /** Whether a reference exists (no authorization needed; refs are non-secret names). */
  has(ref: string): boolean {
    return this.entries.has(ref);
  }

  // -- internals -----------------------------------------------------------

  private key(): CryptoKey {
    if (!this.masterKey) throw new Error('vault: master key unavailable');
    return this.masterKey;
  }

  private authorize(action: VaultAction, target: string): void {
    let allowed = false;
    try {
      allowed = this.check(action, target) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new Error(`vault: denied ${action} on '${target}' (fail closed)`);
    }
  }

  private persist(): void {
    const stored: StoredVault = {
      version: VAULT_RECORD_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    this.persistence.save(VAULT_STORAGE_KEY, JSON.stringify(stored));
  }
}

function isStoredEntry(x: unknown): x is StoredVaultEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.iv === 'string' &&
    typeof e.ciphertext === 'string' &&
    typeof e.storedBy === 'string' &&
    typeof e.storedAt === 'string'
  );
}

function assertRef(ref: string): void {
  if (typeof ref !== 'string' || ref.length === 0) throw new Error('vault: ref must be a non-empty string');
}

function assertRequester(requester: string): void {
  if (typeof requester !== 'string' || requester.length === 0) {
    throw new Error('vault: requester must be a non-empty principal');
  }
}
