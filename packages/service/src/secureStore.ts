/**
 * Encrypted service storage — at-rest encryption for the service boundary.
 *
 * Per design-docs/workbook-protection-and-encryption.md:
 * - §3: workbook data is encrypted at rest in the service storage; keys are
 *   managed by the service key management system (KeyManager in crypto.ts).
 * - §4: password protection — the password derives the encryption key via
 *   PBKDF2. Passwords are never stored; only the salt travels with the
 *   payload. Decryption failure IS the verifier (no password hash needed).
 * - §7: encryption keys are per-workbook. Rotation keeps the old key for
 *   decryption and issues a new key for encryption. Compromised keys are
 *   revoked (destroying their material) and can be reissued.
 * - §9 (out of scope for v1): customer-managed keys, field-level encryption,
 *   digital signatures.
 *
 * The service's storage seam is the synchronous `Persistence` interface
 * (metadataStore.ts). WebCrypto is async, so encryption cannot live behind
 * that sync interface — this module provides the async layer:
 *
 * - `AsyncPersistence`: the async counterpart of `Persistence`.
 * - `EncryptedPersistence`: an `AsyncPersistence` that encrypts every value
 *   with AES-256-GCM under a KeyManager key scoped to `scopeId`. Each stored
 *   value carries its own envelope `{ version, keyId, iv, ciphertext }`, so
 *   reads after a key rotation keep working (decryption looks the key up by
 *   keyId, which resolves current AND previous keys) and `rotate()` can
 *   re-encrypt tracked keys under the new key.
 * - `AsyncMetadataStore<T>`: the async analog of `MetadataStore<T>`, reusing
 *   the same versioned serialize/deserialize functions and storage keys.
 * - `createEncryptedServiceStores()`: the whole versioned-spec metadata
 *   surface (charts, pivots, reports, apps, data-source bindings, chat
 *   artifacts, analysis artifacts, ETL recipes + run history, automation
 *   triggers, add-on registry + capability grants, per-user agent threads)
 *   encrypted at rest under one service scope.
 * - `EncryptedWorkbookStore`: per-workbook encrypted document storage — the
 *   §3 wiring. Keys are per-workbook (§7); `save()`/`load()` accept an
 *   optional password for §4 password-to-open protection.
 *
 * Fail-closed everywhere: tampered envelopes, revoked/unknown keys and
 * corrupt payloads throw — they never silently return plaintext or empty
 * data. (The KeyManager's own key records stay in the metadata store inside
 * the trust boundary, per crypto.ts; only CredentialVault entries were
 * encrypted before this module.)
 */

import {
  KeyManager,
  b64ToBytes,
  decryptWorkbook,
  deriveKeyFromPassword,
  encryptWorkbook,
  randomBytes,
  type EncryptedWorkbook,
  type KeyRecord,
} from './crypto.js';
import {
  ARTIFACT_SPEC_VERSION,
  deserializeArtifacts,
  serializeArtifacts,
  type ArtifactSpec,
} from './artifacts/spec.js';
import {
  CONNECTOR_SPEC_VERSION,
  deserializeBindings,
  serializeBindings,
  type SourceBinding,
} from './connectors/spec.js';
import {
  type Persistence,
  deserializeApps,
  deserializeCharts,
  deserializePivots,
  serializeApps,
  serializeCharts,
  serializePivots,
} from './metadataStore.js';
import {
  deserializeReports,
  serializeReports,
  type ReportSpec,
} from './reports/spec.js';
import { type AppSpec } from './appbuilder/spec.js';
import type { ChartSpec } from './chartModel.js';
import type { PivotSpec } from './pivot.js';
import {
  ANALYSIS_STORE_KEY,
  deserializeAnalyses,
  serializeAnalyses,
  type AnalysisArtifact,
} from './analysis/artifact.js';
import {
  deserializeRecipes,
  deserializeRuns,
  serializeRecipes,
  serializeRuns,
  type RunRecord,
} from './etl/store.js';
import type { EtlRecipe } from './etl/recipe.js';
import {
  deserializeTriggers,
  serializeTriggers,
  type TriggerSpec,
} from './automation/triggerSpecs.js';
import {
  deserializeAddons,
  serializeAddons,
  type StoredAddon,
} from './addons/registry.js';
import {
  deserializeGrants,
  serializeGrants,
  type CapabilityGrant,
} from './addons/grants.js';
import {
  AGENT_THREAD_KEY_PREFIX,
  deserializeThreads,
  serializeThreads,
  type AgentThread,
} from './agent/threads.js';
import {
  PENDING_ASK_KEY,
  PendingAskStore,
  deserializePendingAsks,
  serializePendingAsks,
  type PendingAsk,
} from './agent/pendingAsks.js';

// ---------------------------------------------------------------------------
// AsyncPersistence
// ---------------------------------------------------------------------------

/** Async counterpart of the sync `Persistence` interface (metadataStore.ts). */
export interface AsyncPersistence {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
}

/** In-memory AsyncPersistence for servers/tests. */
export function memoryAsyncPersistence(): AsyncPersistence {
  const map = new Map<string, string>();
  return {
    load: async (k) => map.get(k) ?? null,
    save: async (k, v) => {
      map.set(k, v);
    },
    clear: async (k) => {
      map.delete(k);
    },
  };
}

/** Bridge a synchronous Persistence adapter into the async interface (no encryption). */
export function toAsyncPersistence(p: Persistence): AsyncPersistence {
  if (!p) throw new Error('secureStore: persistence adapter is required');
  return {
    load: async (k) => p.load(k),
    save: async (k, v) => p.save(k, v),
    clear: async (k) => p.clear(k),
  };
}

// ---------------------------------------------------------------------------
// EncryptedPersistence
// ---------------------------------------------------------------------------

/** Storage-key prefix for encrypted values. */
export const SECURE_STORAGE_PREFIX = 'icecream-sheets.secure.v1';

/** KeyManager scope id for the service-wide metadata surface. */
export const SERVICE_SCOPE_ID = '__service__';

function assertScope(scopeId: string): void {
  if (typeof scopeId !== 'string' || scopeId.length === 0) {
    throw new Error('secureStore: scopeId must be a non-empty string');
  }
}

function assertStoreKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('secureStore: key must be a non-empty string');
  }
}

function parseEnvelope(raw: string, key: string): EncryptedWorkbook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`secureStore: stored value for '${key}' is not valid JSON (fail closed)`);
  }
  const e = parsed as Partial<EncryptedWorkbook>;
  if (
    typeof e !== 'object' ||
    e === null ||
    e.version !== 1 ||
    typeof e.keyId !== 'string' ||
    typeof e.iv !== 'string' ||
    typeof e.ciphertext !== 'string'
  ) {
    throw new Error(`secureStore: stored value for '${key}' is not an encrypted envelope (fail closed)`);
  }
  return e as EncryptedWorkbook;
}

/**
 * AsyncPersistence that encrypts every value with AES-256-GCM under the
 * KeyManager key for `scopeId` before handing it to the inner (plaintext)
 * persistence adapter. Stored values are JSON envelopes
 * `{ version, keyId, iv, ciphertext }` — never plaintext.
 *
 * Reads are rotation-tolerant: the envelope's keyId is resolved through
 * `KeyManager.getKeyById`, which accepts current AND previous keys, so
 * payloads encrypted before a rotation still decrypt. `rotate()` re-encrypts
 * every key written through this instance under the new current key.
 */
export class EncryptedPersistence implements AsyncPersistence {
  private readonly tracked = new Set<string>();

  private constructor(
    private readonly inner: Persistence,
    private readonly keys: KeyManager,
    private readonly scopeId: string,
    private readonly prefix: string,
  ) {}

  /**
   * Create an EncryptedPersistence. Ensures a current KeyManager key exists
   * for `scopeId` (generating one on first use, per §7).
   */
  static async create(
    inner: Persistence,
    keys: KeyManager,
    scopeId: string,
    opts: { prefix?: string } = {},
  ): Promise<EncryptedPersistence> {
    if (!inner) throw new Error('secureStore: persistence adapter is required');
    if (!keys) throw new Error('secureStore: KeyManager is required');
    assertScope(scopeId);
    const ep = new EncryptedPersistence(inner, keys, scopeId, opts.prefix ?? SECURE_STORAGE_PREFIX);
    // Idempotent: concurrent creators share one generation (see ensureKey).
    await keys.ensureKey(scopeId);
    return ep;
  }

  /** The scope this instance encrypts under. */
  getScopeId(): string {
    return this.scopeId;
  }

  /** Storage keys written through this instance (used by rotate()). */
  listTrackedKeys(): string[] {
    return [...this.tracked].sort();
  }

  private namespaced(key: string): string {
    return `${this.prefix}/${this.scopeId}/${key}`;
  }

  private currentKeyId(): string {
    const rec = this.keys
      .recordsSnapshot()
      .find((r) => r.workbookId === this.scopeId && r.status === 'current');
    if (!rec) throw new Error(`secureStore: no current key for scope '${this.scopeId}'`);
    return rec.keyId;
  }

  /** Encrypt and store. The persisted bytes are ciphertext, never plaintext. */
  async save(key: string, value: string): Promise<void> {
    assertStoreKey(key);
    if (typeof value !== 'string') throw new Error('secureStore: value must be a string');
    const encKey = await this.keys.getEncryptionKey(this.scopeId);
    const envelope = await encryptWorkbook(
      new TextEncoder().encode(value),
      encKey,
      this.currentKeyId(),
    );
    this.inner.save(this.namespaced(key), JSON.stringify(envelope));
    this.tracked.add(key);
  }

  /**
   * Load and decrypt. Returns null when nothing is stored. Throws (fail
   * closed) on tampering, revoked/unknown keys, or corrupt envelopes.
   */
  async load(key: string): Promise<string | null> {
    assertStoreKey(key);
    const raw = this.inner.load(this.namespaced(key));
    if (raw === null) return null;
    const envelope = parseEnvelope(raw, key);
    let decKey: CryptoKey;
    try {
      decKey = await this.keys.getKeyById(envelope.keyId);
    } catch (e) {
      throw new Error(
        `secureStore: key '${envelope.keyId}' for '${key}' is unavailable (revoked or unknown) — fail closed`,
        { cause: e },
      );
    }
    try {
      const bytes = await decryptWorkbook(envelope, decKey);
      return new TextDecoder().decode(bytes);
    } catch (e) {
      throw new Error(`secureStore: cannot decrypt '${key}' (tampered ciphertext or wrong key) — fail closed`, {
        cause: e,
      });
    }
  }

  async clear(key: string): Promise<void> {
    assertStoreKey(key);
    this.tracked.delete(key);
    this.inner.clear(this.namespaced(key));
  }

  /**
   * Rotate the scope's key (§7): the old key stays (status 'previous') for
   * decryption, the new key is used for new encryption, and every tracked
   * key is re-encrypted under the new key. Reads of untracked keys still
   * work — their envelopes resolve the previous key by keyId.
   */
  async rotate(): Promise<{ current: KeyRecord; previous: KeyRecord }> {
    const { current, previous } = await this.keys.rotate(this.scopeId);
    await this.rekey([...this.tracked]);
    return { current, previous };
  }

  /**
   * Re-encrypt the given storage keys under the current key. Use after a
   * restart (when `tracked` is empty) or to re-encrypt keys written through
   * another instance sharing the same scope.
   */
  async rekey(storageKeys: string[]): Promise<void> {
    for (const key of storageKeys) {
      const value = await this.load(key); // decrypts via envelope keyId (old or new)
      if (value === null) continue;
      await this.save(key, value); // encrypts under the current key
    }
  }
}

// ---------------------------------------------------------------------------
// AsyncMetadataStore<T>
// ---------------------------------------------------------------------------

/**
 * Async analog of `MetadataStore<T>`: owns serialization, migration and
 * persistence for one spec kind under one storage key, over an
 * AsyncPersistence (e.g. EncryptedPersistence). Same semantics as the sync
 * version, including fail-soft deserializers returning [] for corrupt
 * payloads — except encrypted reads fail closed (throw) before the
 * deserializer ever runs.
 */
export class AsyncMetadataStore<T> {
  private cache: T[] | null = null;

  constructor(
    private readonly key: string,
    private readonly persistence: AsyncPersistence,
    private readonly serialize: (items: T[]) => string,
    private readonly deserialize: (json: string) => T[],
  ) {}

  /** Read all specs (cached after first load). */
  async all(): Promise<T[]> {
    if (this.cache === null) {
      const raw = await this.persistence.load(this.key);
      this.cache = raw === null ? [] : this.deserialize(raw);
    }
    return [...this.cache];
  }

  /** Replace all specs and persist. */
  async saveAll(items: T[]): Promise<void> {
    this.cache = [...items];
    await this.persistence.save(this.key, this.serialize(items));
  }

  /** Add one spec and persist. */
  async add(item: T): Promise<void> {
    await this.saveAll([...(await this.all()), item]);
  }

  /** Remove specs matching a predicate and persist. Returns removed count. */
  async remove(predicate: (item: T) => boolean): Promise<number> {
    const all = await this.all();
    const kept = all.filter((i) => !predicate(i));
    await this.saveAll(kept);
    return all.length - kept.length;
  }

  /** Drop everything (cache + persisted). */
  async clear(): Promise<void> {
    this.cache = [];
    await this.persistence.clear(this.key);
  }

  /** Force re-read from persistence on next all(). */
  invalidate(): void {
    this.cache = null;
  }
}

// ---------------------------------------------------------------------------
// Encrypted service metadata stores (§3: the metadata surface at rest)
// ---------------------------------------------------------------------------

export interface CreateEncryptedStoresOptions {
  /** KeyManager scope for the metadata surface. Defaults to SERVICE_SCOPE_ID. */
  scopeId?: string;
  /** userId for the per-user agent-thread store. Defaults to 'default'. */
  agentUserId?: string;
}

/** The service's versioned-spec metadata surface, encrypted at rest. */
export interface EncryptedServiceStores {
  charts: AsyncMetadataStore<ChartSpec>;
  pivots: AsyncMetadataStore<PivotSpec>;
  reports: AsyncMetadataStore<ReportSpec>;
  apps: AsyncMetadataStore<AppSpec>;
  dataSources: AsyncMetadataStore<SourceBinding>;
  artifacts: AsyncMetadataStore<ArtifactSpec>;
  analysis: AsyncMetadataStore<AnalysisArtifact>;
  etlRecipes: AsyncMetadataStore<EtlRecipe>;
  etlRuns: AsyncMetadataStore<RunRecord>;
  triggers: AsyncMetadataStore<TriggerSpec>;
  addons: AsyncMetadataStore<StoredAddon>;
  grants: AsyncMetadataStore<CapabilityGrant>;
  agentThreads: AsyncMetadataStore<AgentThread>;
}

/**
 * Build the whole service metadata surface over an EncryptedPersistence, so
 * every spec written to the service storage lands encrypted at rest. Uses
 * the same versioned serialize/deserialize functions and the same storage
 * keys as the sync factories — a store flipped from plaintext to encrypted
 * fails closed on pre-existing plaintext data (it is not a valid envelope).
 */
export async function createEncryptedServiceStores(
  persistence: Persistence,
  keys: KeyManager,
  opts: CreateEncryptedStoresOptions = {},
): Promise<EncryptedServiceStores> {
  const ep = await EncryptedPersistence.create(persistence, keys, opts.scopeId ?? SERVICE_SCOPE_ID);
  const agentUserId = opts.agentUserId ?? 'default';
  if (agentUserId.length === 0) throw new Error('secureStore: agentUserId must be non-empty');
  return {
    charts: new AsyncMetadataStore('icecream-sheets.charts.v1', ep, serializeCharts, deserializeCharts),
    pivots: new AsyncMetadataStore('icecream-sheets.pivots.v1', ep, serializePivots, deserializePivots),
    reports: new AsyncMetadataStore('icecream-sheets.reports.v1', ep, serializeReports, deserializeReports),
    apps: new AsyncMetadataStore('icecream-sheets.apps.v1', ep, serializeApps, deserializeApps),
    dataSources: new AsyncMetadataStore(
      `icecream-sheets.data-sources.v${CONNECTOR_SPEC_VERSION}`,
      ep,
      serializeBindings,
      deserializeBindings,
    ),
    artifacts: new AsyncMetadataStore(
      `icecream-sheets.artifacts.v${ARTIFACT_SPEC_VERSION}`,
      ep,
      serializeArtifacts,
      deserializeArtifacts,
    ),
    analysis: new AsyncMetadataStore(ANALYSIS_STORE_KEY, ep, serializeAnalyses, deserializeAnalyses),
    etlRecipes: new AsyncMetadataStore('icecream-sheets.etl.recipes.v1', ep, serializeRecipes, deserializeRecipes),
    etlRuns: new AsyncMetadataStore('icecream-sheets.etl.runs.v1', ep, serializeRuns, deserializeRuns),
    triggers: new AsyncMetadataStore('icecream-sheets.triggers.v1', ep, serializeTriggers, deserializeTriggers),
    // ADDON_STORE_KEY / GRANT_STORE_KEY are not exported by their modules;
    // these literals must match addons/registry.ts and addons/grants.ts.
    addons: new AsyncMetadataStore('icecream-sheets.addons.v1', ep, serializeAddons, deserializeAddons),
    grants: new AsyncMetadataStore('icecream-sheets.addon-grants.v1', ep, serializeGrants, deserializeGrants),
    agentThreads: new AsyncMetadataStore<AgentThread>(
      `${AGENT_THREAD_KEY_PREFIX}.${agentUserId}`,
      ep,
      (threads) => serializeThreads(agentUserId, threads),
      deserializeThreads,
    ),
  };
}

/**
 * Build the human-in-the-loop PendingAskStore (ai-agent.md §12) over an
 * EncryptedPersistence, so pending questions/answers — which may carry
 * sensitive workbook content — are encrypted at rest (§3) under the
 * service scope key (§7). Same storage key as the old plaintext store;
 * pre-existing plaintext payloads fail closed (not a valid envelope).
 */
export async function createEncryptedPendingAskStore(
  persistence: Persistence,
  keys: KeyManager,
): Promise<PendingAskStore> {
  if (!persistence) throw new Error('secureStore: persistence adapter is required');
  if (!keys) throw new Error('secureStore: KeyManager is required');
  const ep = await EncryptedPersistence.create(persistence, keys, SERVICE_SCOPE_ID);
  const backend = new AsyncMetadataStore<PendingAsk>(
    PENDING_ASK_KEY,
    ep,
    serializePendingAsks,
    deserializePendingAsks,
  );
  return new PendingAskStore(backend);
}

// ---------------------------------------------------------------------------
// EncryptedWorkbookStore — per-workbook encrypted document storage (§§3,4,7)
// ---------------------------------------------------------------------------

/** Storage-key prefix for encrypted workbook documents. */
export const WORKBOOK_STORAGE_PREFIX = 'icecream-sheets.workbooks.v1';

/**
 * Marker prefix for envelopes whose data key was derived from a user
 * password (§4) rather than issued by the KeyManager. The suffix is the
 * workbook's KeyManager key id at save time (bookkeeping only — the
 * KeyManager key is NEVER used to decrypt a password envelope).
 */
export const PASSWORD_KEY_ID_PREFIX = 'pw:';

export interface WorkbookSaveOptions {
  /**
   * Password for §4 password-to-open protection. The key is derived with
   * PBKDF2-SHA256 (210k iterations); the password itself is never stored —
   * only the random 16-byte salt travels with the envelope.
   */
  password?: string;
}

export interface WorkbookLoadOptions {
  /** Required when the workbook was saved with a password. */
  password?: string;
}

function assertWorkbookId(workbookId: string): void {
  if (typeof workbookId !== 'string' || workbookId.length === 0) {
    throw new Error('workbookStore: workbookId must be a non-empty string');
  }
}

function parseWorkbookEnvelope(raw: string, workbookId: string): EncryptedWorkbook {
  return parseEnvelope(raw, `workbook '${workbookId}'`);
}

/**
 * Per-workbook encrypted document storage — the §3 wiring: workbook bytes
 * are encrypted at rest in the service storage, with per-workbook keys
 * managed by the KeyManager (§7). `save()`/`load()` accept an optional
 * password for §4 password-to-open protection (password-derived key, salt
 * in the envelope, wrong password fails decryption — that failure IS the
 * verifier).
 */
export class EncryptedWorkbookStore {
  private constructor(
    private readonly persistence: Persistence,
    private readonly keys: KeyManager,
  ) {}

  /** Create a store. Keys are generated lazily per workbook on first save. */
  static create(persistence: Persistence, keys: KeyManager): EncryptedWorkbookStore {
    if (!persistence) throw new Error('workbookStore: persistence adapter is required');
    if (!keys) throw new Error('workbookStore: KeyManager is required');
    return new EncryptedWorkbookStore(persistence, keys);
  }

  private storageKey(workbookId: string): string {
    return `${WORKBOOK_STORAGE_PREFIX}/${workbookId}`;
  }

  private currentKeyId(workbookId: string): string {
    const rec = this.keys
      .recordsSnapshot()
      .find((r) => r.workbookId === workbookId && r.status === 'current');
    if (!rec) throw new Error(`workbookStore: no current key for workbook '${workbookId}'`);
    return rec.keyId;
  }

  /**
   * Encrypt and persist workbook bytes. Without a password the workbook is
   * encrypted under the workbook's current KeyManager key (generated on
   * first save, §7). With a password the data key is PBKDF2-derived from
   * the password + a fresh random salt (§4); the password is never stored.
   */
  async save(workbookId: string, bytes: Uint8Array, opts: WorkbookSaveOptions = {}): Promise<void> {
    assertWorkbookId(workbookId);
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('workbookStore: bytes must be a Uint8Array');
    }
    // §7: every workbook gets a KeyManager key, password-protected or not —
    // rotation/revocation bookkeeping is always per-workbook.
    if (!this.keys.hasCurrentKey(workbookId)) {
      await this.keys.generate(workbookId);
    }
    let envelope: EncryptedWorkbook;
    if (opts.password !== undefined) {
      if (typeof opts.password !== 'string' || opts.password.length === 0) {
        throw new Error('workbookStore: password must be a non-empty string');
      }
      const salt = randomBytes(16);
      const dataKey = await deriveKeyFromPassword(opts.password, salt);
      envelope = await encryptWorkbook(
        bytes,
        dataKey,
        `${PASSWORD_KEY_ID_PREFIX}${this.currentKeyId(workbookId)}`,
        salt,
      );
    } else {
      const dataKey = await this.keys.getEncryptionKey(workbookId);
      envelope = await encryptWorkbook(bytes, dataKey, this.currentKeyId(workbookId));
    }
    this.persistence.save(this.storageKey(workbookId), JSON.stringify(envelope));
  }

  /**
   * Load and decrypt workbook bytes. For password-protected workbooks the
   * password must be supplied; a wrong password fails decryption (that
   * failure is the verifier — §4). Throws (fail closed) for unknown
   * workbooks, tampered envelopes, and revoked/unknown keys.
   */
  async load(workbookId: string, opts: WorkbookLoadOptions = {}): Promise<Uint8Array> {
    assertWorkbookId(workbookId);
    const raw = this.persistence.load(this.storageKey(workbookId));
    if (raw === null) throw new Error(`workbookStore: unknown workbook '${workbookId}'`);
    const envelope = parseWorkbookEnvelope(raw, workbookId);
    if (envelope.salt !== undefined) {
      // §4 password envelope: the KeyManager key is bookkeeping only.
      if (opts.password === undefined) {
        throw new Error(`workbookStore: workbook '${workbookId}' requires a password`);
      }
      const dataKey = await deriveKeyFromPassword(opts.password, b64ToBytes(envelope.salt));
      try {
        return await decryptWorkbook(envelope, dataKey);
      } catch (e) {
        throw new Error(`workbookStore: wrong password for workbook '${workbookId}'`, { cause: e });
      }
    }
    let dataKey: CryptoKey;
    try {
      dataKey = await this.keys.getKeyById(envelope.keyId);
    } catch (e) {
      throw new Error(
        `workbookStore: key '${envelope.keyId}' for workbook '${workbookId}' is unavailable (revoked or unknown) — fail closed`,
        { cause: e },
      );
    }
    try {
      return await decryptWorkbook(envelope, dataKey);
    } catch (e) {
      throw new Error(`workbookStore: cannot decrypt workbook '${workbookId}' (tampered ciphertext) — fail closed`, {
        cause: e,
      });
    }
  }

  /** True when an encrypted payload is stored for the workbook. */
  has(workbookId: string): boolean {
    assertWorkbookId(workbookId);
    return this.persistence.load(this.storageKey(workbookId)) !== null;
  }

  /** Delete the stored envelope (does not revoke the key — see revokeKey). */
  delete(workbookId: string): void {
    assertWorkbookId(workbookId);
    this.persistence.clear(this.storageKey(workbookId));
  }

  /**
   * Rotate the workbook's key (§7): the old key stays (status 'previous')
   * for decryption, the new key is used for new saves, and the stored
   * envelope is re-encrypted under the new key when possible. Password
   * envelopes cannot be re-encrypted (the password is never stored) — they
   * keep their password-derived key and stay readable with the password.
   */
  async rotateKey(workbookId: string): Promise<{ current: KeyRecord; previous: KeyRecord }> {
    assertWorkbookId(workbookId);
    const { current, previous } = await this.keys.rotate(workbookId);
    const raw = this.persistence.load(this.storageKey(workbookId));
    if (raw !== null) {
      const envelope = parseWorkbookEnvelope(raw, workbookId);
      if (envelope.salt === undefined && envelope.keyId === previous.keyId) {
        const oldKey = await this.keys.getKeyById(previous.keyId);
        const plaintext = await decryptWorkbook(envelope, oldKey);
        const newKey = await this.keys.getEncryptionKey(workbookId);
        const reissued = await encryptWorkbook(plaintext, newKey, current.keyId);
        this.persistence.save(this.storageKey(workbookId), JSON.stringify(reissued));
      }
    }
    return { current, previous };
  }

  /**
   * Revoke the workbook's key (§7): destroys all KeyManager key material for
   * the workbook, so KeyManager-encrypted payloads become undecryptable.
   * (Password-derived payloads are protected by the password itself, which
   * the service never held — revoking the bookkeeping key does not affect
   * them; delete() removes the payload.)
   */
  revokeKey(workbookId: string): void {
    assertWorkbookId(workbookId);
    this.keys.revoke(workbookId);
  }
}
