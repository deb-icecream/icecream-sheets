/**
 * Product layer — per-user tier store + file catalog
 * (hidden_files/product-layer/CONTRACT.md §Tiers, §File catalog).
 *
 * Two small durable stores, both following the fileRegistry.ts /
 * sessionStore.ts adapter posture:
 *   local — JSON file under USER_STORE_DIR (default
 *     <sessionDataDir>/user-store), guarded by a cross-process
 *     lockfile mutex; atomic tmp+rename writes; IO errors THROW.
 *   memory — interface-level fake for unit tests.
 *   prod — Firestore-shaped structural adapter (collections
 *     `icecream_user_tiers` / `icecream_user_files`). Factories FAIL
 *     CLOSED in prod mode (USER_STORE=prod) without an injected
 *     Firestore client — never a silent local fallback.
 *
 * Tiers: exactly 'default' | 'pro'. Default caps come from named,
 * env-configurable constants (CONTRACT §Tiers). Pending promotions by
 * email are consumed at first record creation (resolveTier with that
 * email): an operator can promote an email before the user has ever
 * signed in, and the first login lands at the promoted tier.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { sessionDataDir, wrapFirestore, type FirestoreLike } from './sessionStore.js';
import { FirestoreUserDirectory } from './userDirectory.js';

// ---------------------------------------------------------------------------
// Tiers + caps
// ---------------------------------------------------------------------------

export type Tier = 'default' | 'pro';

/** P75 workbook size (bytes) — the Default-tier upload cap default. */
export const DEFAULT_UPLOAD_MAX_BYTES = 1_285_214;
/** Default-tier workspace file-count cap default. */
export const DEFAULT_FILE_LIMIT = 10;

/** TIER_DEFAULT_UPLOAD_MAX_BYTES override. */
export function defaultUploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TIER_DEFAULT_UPLOAD_MAX_BYTES ?? '');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_UPLOAD_MAX_BYTES;
}

/** TIER_DEFAULT_FILE_LIMIT override. */
export function defaultFileLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TIER_DEFAULT_FILE_LIMIT ?? '');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FILE_LIMIT;
}

/** Limits view for a tier: null = unrestricted (pro). */
export function tierLimits(
  tier: Tier,
  env: NodeJS.ProcessEnv = process.env,
): { uploadMaxBytes: number | null; fileLimit: number | null } {
  return tier === 'pro'
    ? { uploadMaxBytes: null, fileLimit: null }
    : { uploadMaxBytes: defaultUploadMaxBytes(env), fileLimit: defaultFileLimit(env) };
}

export function isTier(x: unknown): x is Tier {
  return x === 'default' || x === 'pro';
}

// ---------------------------------------------------------------------------
// Env config (shared by both stores — same env/dir family)
// ---------------------------------------------------------------------------

/** USER_STORE: 'local' (default) | 'prod' (Firestore). */
export function userStoreProvider(env: NodeJS.ProcessEnv = process.env): 'local' | 'prod' {
  const v = (env.USER_STORE ?? '').trim().toLowerCase();
  return v === 'prod' || v === 'firestore' ? 'prod' : 'local';
}

/** USER_STORE_DIR: local adapter root (default <sessionDataDir>/user-store). */
export function userStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.USER_STORE_DIR ?? '').trim();
  return fromEnv !== '' ? fromEnv : join(sessionDataDir(env), 'user-store');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Lockfile mutex (LocalFileRegistry pattern)
// ---------------------------------------------------------------------------

const LOCK_SPIN_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function makeLock(lockFile: string): { withLock<T>(fn: () => T): T } {
  function acquireLock(): void {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(lockFile, 'wx');
        writeFileSync(fd, `${process.pid} ${Date.now()}`);
        closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
        try {
          const content = readFileSync(lockFile, 'utf8');
          const ts = Number(content.trim().split(/\s+/)[1] ?? '0');
          if (ts > 0 && Date.now() - ts > LOCK_STALE_MS) {
            unlinkSync(lockFile);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`user store: lock timeout after ${LOCK_TIMEOUT_MS}ms (fail closed)`);
        }
        sleepSync(LOCK_SPIN_MS);
      }
    }
  }
  function releaseLock(): void {
    try {
      unlinkSync(lockFile);
    } catch {
      // Already gone (stale-recovered by a peer).
    }
  }
  return {
    withLock<T>(fn: () => T): T {
      acquireLock();
      try {
        return fn();
      } finally {
        releaseLock();
      }
    },
  };
}

function readJsonFile<T>(file: string, empty: T): T {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return empty;
    throw e;
  }
  const parsed = JSON.parse(text) as T;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('user store: corrupt store file (fail closed)');
  }
  return parsed;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), 'utf8');
  renameSync(tmp, file);
}

// ===========================================================================
// Tier store
// ===========================================================================

export interface UserTierRecord {
  userId: string;
  email?: string;
  tier: Tier;
  createdAt: number;
  updatedAt: number;
}

export interface UserTierStore {
  /**
   * The tier for a user, creating the record on first sight (default
   * tier, unless a pending promotion exists for the supplied email —
   * consumed here) and backfilling the email on an existing record.
   */
  resolveTier(input: { userId: string; email?: string }): Promise<Tier>;
  /** The stored record, or null when the user was never seen. */
  getRecord(userId: string): Promise<UserTierRecord | null>;
  /**
   * Promote/demote by email: updates the record when one carries that
   * email (returns it); otherwise records a PENDING promotion consumed
   * at that email's first resolveTier (returns null).
   */
  setTierByEmail(email: string, tier: Tier): Promise<UserTierRecord | null>;
  /** Promote/demote by userId: updates or creates the record. */
  setTierByUserId(userId: string, tier: Tier): Promise<UserTierRecord>;
  /** The pending promotion tier for an email, or null. */
  getPendingByEmail(email: string): Promise<Tier | null>;
  /**
   * Account deletion: remove the user's record entirely, plus any
   * pending promotion keyed by the record's email (a later sign-in
   * must land as a FRESH account — a surviving pending promotion
   * would silently re-tier it). Returns true when a record existed.
   */
  deleteRecord(userId: string): Promise<boolean>;
}

interface TierFileShape {
  records: Record<string, UserTierRecord>;
  pending: Record<string, Tier>;
}

export class MemoryUserTierStore implements UserTierStore {
  private readonly records = new Map<string, UserTierRecord>();
  private readonly pending = new Map<string, Tier>();

  async resolveTier(input: { userId: string; email?: string }): Promise<Tier> {
    const cur = this.records.get(input.userId);
    if (cur) {
      if (input.email && cur.email !== input.email) {
        const next = { ...cur, email: input.email, updatedAt: Date.now() };
        this.records.set(input.userId, next);
        return next.tier;
      }
      return cur.tier;
    }
    let tier: Tier = 'default';
    if (input.email) {
      const key = normalizeEmail(input.email);
      const p = this.pending.get(key);
      if (p) {
        tier = p;
        this.pending.delete(key);
      }
    }
    const now = Date.now();
    this.records.set(input.userId, {
      userId: input.userId,
      ...(input.email ? { email: input.email } : {}),
      tier,
      createdAt: now,
      updatedAt: now,
    });
    return tier;
  }

  async getRecord(userId: string): Promise<UserTierRecord | null> {
    const rec = this.records.get(userId);
    return rec ? { ...rec } : null;
  }

  async setTierByEmail(email: string, tier: Tier): Promise<UserTierRecord | null> {
    const key = normalizeEmail(email);
    for (const rec of this.records.values()) {
      if (rec.email && normalizeEmail(rec.email) === key) {
        const next = { ...rec, tier, updatedAt: Date.now() };
        this.records.set(rec.userId, next);
        return { ...next };
      }
    }
    this.pending.set(key, tier);
    return null;
  }

  async setTierByUserId(userId: string, tier: Tier): Promise<UserTierRecord> {
    const cur = this.records.get(userId);
    const now = Date.now();
    const next: UserTierRecord = cur
      ? { ...cur, tier, updatedAt: now }
      : { userId, tier, createdAt: now, updatedAt: now };
    this.records.set(userId, next);
    return { ...next };
  }

  async getPendingByEmail(email: string): Promise<Tier | null> {
    return this.pending.get(normalizeEmail(email)) ?? null;
  }

  async deleteRecord(userId: string): Promise<boolean> {
    const rec = this.records.get(userId);
    if (!rec) return false;
    this.records.delete(userId);
    if (rec.email) this.pending.delete(normalizeEmail(rec.email));
    return true;
  }
}

export class LocalUserTierStore implements UserTierStore {
  private readonly file: string;
  private readonly lock: { withLock<T>(fn: () => T): T };

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'user-tiers.json');
    this.lock = makeLock(join(dir, 'user-tiers.lock'));
  }

  private readAll(): TierFileShape {
    const parsed = readJsonFile<Partial<TierFileShape>>(this.file, {});
    return {
      records: (parsed.records ?? {}) as Record<string, UserTierRecord>,
      pending: (parsed.pending ?? {}) as Record<string, Tier>,
    };
  }

  async resolveTier(input: { userId: string; email?: string }): Promise<Tier> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const cur = all.records[input.userId];
      if (cur) {
        if (input.email && cur.email !== input.email) {
          all.records[input.userId] = { ...cur, email: input.email, updatedAt: Date.now() };
          writeJsonAtomic(this.file, all);
          return all.records[input.userId]!.tier;
        }
        return cur.tier;
      }
      let tier: Tier = 'default';
      if (input.email) {
        const key = normalizeEmail(input.email);
        const p = all.pending[key];
        if (p) {
          tier = p;
          delete all.pending[key];
        }
      }
      const now = Date.now();
      all.records[input.userId] = {
        userId: input.userId,
        ...(input.email ? { email: input.email } : {}),
        tier,
        createdAt: now,
        updatedAt: now,
      };
      writeJsonAtomic(this.file, all);
      return tier;
    });
  }

  async getRecord(userId: string): Promise<UserTierRecord | null> {
    return this.lock.withLock(() => {
      const rec = this.readAll().records[userId];
      return rec ? { ...rec } : null;
    });
  }

  async setTierByEmail(email: string, tier: Tier): Promise<UserTierRecord | null> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const key = normalizeEmail(email);
      for (const rec of Object.values(all.records)) {
        if (rec.email && normalizeEmail(rec.email) === key) {
          const next = { ...rec, tier, updatedAt: Date.now() };
          all.records[rec.userId] = next;
          writeJsonAtomic(this.file, all);
          return { ...next };
        }
      }
      all.pending[key] = tier;
      writeJsonAtomic(this.file, all);
      return null;
    });
  }

  async setTierByUserId(userId: string, tier: Tier): Promise<UserTierRecord> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const cur = all.records[userId];
      const now = Date.now();
      const next: UserTierRecord = cur
        ? { ...cur, tier, updatedAt: now }
        : { userId, tier, createdAt: now, updatedAt: now };
      all.records[userId] = next;
      writeJsonAtomic(this.file, all);
      return { ...next };
    });
  }

  async getPendingByEmail(email: string): Promise<Tier | null> {
    return this.lock.withLock(() => this.readAll().pending[normalizeEmail(email)] ?? null);
  }

  async deleteRecord(userId: string): Promise<boolean> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const rec = all.records[userId];
      if (!rec) return false;
      delete all.records[userId];
      if (rec.email) delete all.pending[normalizeEmail(rec.email)];
      writeJsonAtomic(this.file, all);
      return true;
    });
  }
}

const USER_TIERS_COLLECTION = 'icecream_user_tiers';

function pendingDocId(normalizedEmail: string): string {
  return `pending:${normalizedEmail}`;
}

export class FirestoreUserTierStore implements UserTierStore {
  constructor(private readonly db: FirestoreLike) {}

  private doc(id: string) {
    return this.db.collection(USER_TIERS_COLLECTION).doc(id);
  }

  async getRecord(userId: string): Promise<UserTierRecord | null> {
    const snap = await this.doc(userId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data || (data as { pendingEmail?: unknown }).pendingEmail !== undefined) return null;
    return data as unknown as UserTierRecord;
  }

  async getPendingByEmail(email: string): Promise<Tier | null> {
    const snap = await this.doc(pendingDocId(normalizeEmail(email))).get();
    if (!snap.exists) return null;
    const data = snap.data();
    const tier = (data as { tier?: unknown } | undefined)?.tier;
    return isTier(tier) ? tier : null;
  }

  async resolveTier(input: { userId: string; email?: string }): Promise<Tier> {
    const cur = await this.getRecord(input.userId);
    if (cur) {
      if (input.email && cur.email !== input.email) {
        const next = { ...cur, email: input.email, updatedAt: Date.now() };
        await this.doc(input.userId).set({ ...next } as unknown as Record<string, unknown>);
        return next.tier;
      }
      return cur.tier;
    }
    let tier: Tier = 'default';
    if (input.email) {
      const p = await this.getPendingByEmail(input.email);
      if (p) {
        tier = p;
        await this.doc(pendingDocId(normalizeEmail(input.email))).delete();
      }
    }
    const now = Date.now();
    const rec: UserTierRecord = {
      userId: input.userId,
      ...(input.email ? { email: input.email } : {}),
      tier,
      createdAt: now,
      updatedAt: now,
    };
    await this.doc(input.userId).set({ ...rec } as unknown as Record<string, unknown>);
    return tier;
  }

  async setTierByEmail(email: string, tier: Tier): Promise<UserTierRecord | null> {
    const key = normalizeEmail(email);
    const rows = await this.db.collection(USER_TIERS_COLLECTION).queryEq('email', email);
    const match = rows
      .map((r) => r.data())
      .find(
        (d): d is Record<string, unknown> =>
          !!d && typeof d['email'] === 'string' && normalizeEmail(d['email'] as string) === key,
      );
    if (match) {
      const rec = match as unknown as UserTierRecord;
      const next = { ...rec, tier, updatedAt: Date.now() };
      await this.doc(rec.userId).set({ ...next } as unknown as Record<string, unknown>);
      return { ...next };
    }
    await this.doc(pendingDocId(key)).set({ pendingEmail: key, tier });
    return null;
  }

  async setTierByUserId(userId: string, tier: Tier): Promise<UserTierRecord> {
    const cur = await this.getRecord(userId);
    const now = Date.now();
    const next: UserTierRecord = cur
      ? { ...cur, tier, updatedAt: now }
      : { userId, tier, createdAt: now, updatedAt: now };
    await this.doc(userId).set({ ...next } as unknown as Record<string, unknown>);
    return { ...next };
  }

  async deleteRecord(userId: string): Promise<boolean> {
    const rec = await this.getRecord(userId);
    if (!rec) return false;
    await this.doc(userId).delete();
    if (rec.email) {
      await this.doc(pendingDocId(normalizeEmail(rec.email))).delete();
    }
    return true;
  }
}

/**
 * Build the tier store for the configured provider. 'prod' REQUIRES an
 * injected Firestore client — fail closed, never a local fallback.
 */
export function createUserTierStore(
  env: NodeJS.ProcessEnv = process.env,
  opts: { firestoreDb?: FirestoreLike; dir?: string } = {},
): UserTierStore {
  if (userStoreProvider(env) === 'prod') {
    if (!opts.firestoreDb) {
      throw new Error(
        'user tier store: USER_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)',
      );
    }
    return new FirestoreUserTierStore(opts.firestoreDb);
  }
  return new LocalUserTierStore(opts.dir ?? userStoreDir(env));
}

// ===========================================================================
// File catalog
// ===========================================================================

export type SourceFormat = 'xlsx' | 'csv' | 'xls';

/**
 * Derive the source format from a filename's extension, case-insensitive.
 * Returns null for anything that is not a supported upload type.
 * ('.xls' = legacy BIFF: the engine parses it through SheetJS — sweep
 * finding F-2; note '.xlsx' must be tested before '.xls' would matter —
 * endsWith('.xls') is false for '.xlsx', so order is safe.)
 */
export function sourceFormatForFileName(name: string): SourceFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xls')) return 'xls';
  return null;
}

/**
 * Canonical MIME type for an upload format — the Content-Type the
 * browser MUST send on the staging PUT, because a GCS v4 signed URL
 * binds contentType and rejects any other value (403). Deriving it
 * from the format (not the browser's File.type, which varies by
 * OS/browser and is empty for some files) makes the PUT deterministic
 * for all three supported formats (#96 reopen: the old code bound the
 * xlsx MIME for every format, so .csv/.xls PUTs could never match).
 */
export function canonicalMimeForSourceFormat(format: SourceFormat): string {
  switch (format) {
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'csv':
      return 'text/csv';
  }
}

function isSourceFormat(x: unknown): x is SourceFormat {
  return x === 'xlsx' || x === 'csv' || x === 'xls';
}

/** Normalize a persisted record: records written before sourceFormat existed load as 'xlsx'. */
function normalizeFileRecord(rec: UserFileRecord): UserFileRecord {
  return isSourceFormat(rec.sourceFormat) ? rec : { ...rec, sourceFormat: 'xlsx' };
}

export interface UserFileRecord {
  fileId: string;
  ownerPrincipal: string;
  name: string;
  /** Format of the bytes the user originally uploaded ('xlsx' for created-in-app files). */
  sourceFormat: SourceFormat;
  /**
   * How the file entered the owner's workspace: uploaded, created
   * in-app, or received by accepting a share (a copy of someone
   * else's app + data placed in the recipient's workspace — the
   * share/accept flow itself belongs to the gallery layer; the
   * catalog only records the resulting copy like any other entry).
   */
  origin: 'upload' | 'created' | 'shared';
  sizeBytes: number;
  storageRef: { bucket: string; object: string } | null;
  libraryEntryId: string | null;
  hasStoredState: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

export type UserFilePatch = Partial<
  Pick<
    UserFileRecord,
    'name' | 'hasStoredState' | 'libraryEntryId' | 'sizeBytes' | 'storageRef' | 'lastOpenedAt'
  >
>;

export interface UserFileCatalog {
  create(input: {
    fileId: string;
    ownerPrincipal: string;
    name: string;
    origin: 'upload' | 'created' | 'shared';
    sourceFormat?: SourceFormat;
    sizeBytes?: number;
    storageRef?: { bucket: string; object: string } | null;
    libraryEntryId?: string | null;
    hasStoredState?: boolean;
  }): Promise<UserFileRecord>;
  get(fileId: string): Promise<UserFileRecord | null>;
  /** Owner's files, most recently opened first (lastOpenedAt DESC). */
  listByOwner(ownerPrincipal: string): Promise<UserFileRecord[]>;
  update(fileId: string, patch: UserFilePatch): Promise<UserFileRecord | null>;
  remove(fileId: string): Promise<boolean>;
  countByOwner(ownerPrincipal: string): Promise<number>;
  /** Stamp lastOpenedAt = now (recents order). */
  touchOpened(fileId: string): Promise<UserFileRecord | null>;
  /**
   * Move a catalog record's owner (issue #84b ownership transfer):
   * only when the record exists AND its owner is `from`; returns the
   * updated record, or null when there is nothing to move (no record,
   * or a different owner — the caller decides what that means).
   */
  transfer(fileId: string, from: string, to: string): Promise<UserFileRecord | null>;
}

function buildRecord(input: Parameters<UserFileCatalog['create']>[0], now: number): UserFileRecord {
  return {
    fileId: input.fileId,
    ownerPrincipal: input.ownerPrincipal,
    name: input.name,
    sourceFormat: input.sourceFormat ?? 'xlsx',
    origin: input.origin,
    sizeBytes: input.sizeBytes ?? 0,
    storageRef: input.storageRef ?? null,
    libraryEntryId: input.libraryEntryId ?? null,
    hasStoredState: input.hasStoredState ?? false,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
}

function byRecency(a: UserFileRecord, b: UserFileRecord): number {
  return b.lastOpenedAt - a.lastOpenedAt || b.createdAt - a.createdAt;
}

export class MemoryUserFileCatalog implements UserFileCatalog {
  private readonly records = new Map<string, UserFileRecord>();

  async create(input: Parameters<UserFileCatalog['create']>[0]): Promise<UserFileRecord> {
    const rec = buildRecord(input, Date.now());
    this.records.set(rec.fileId, rec);
    return { ...rec };
  }
  async get(fileId: string): Promise<UserFileRecord | null> {
    const rec = this.records.get(fileId);
    return rec ? { ...normalizeFileRecord(rec) } : null;
  }
  async listByOwner(ownerPrincipal: string): Promise<UserFileRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.ownerPrincipal === ownerPrincipal)
      .sort(byRecency)
      .map((r) => ({ ...normalizeFileRecord(r) }));
  }
  async update(fileId: string, patch: UserFilePatch): Promise<UserFileRecord | null> {
    const cur = this.records.get(fileId);
    if (!cur) return null;
    const next = { ...cur, ...patch, fileId, updatedAt: Date.now() };
    this.records.set(fileId, next);
    return { ...next };
  }
  async remove(fileId: string): Promise<boolean> {
    return this.records.delete(fileId);
  }
  async countByOwner(ownerPrincipal: string): Promise<number> {
    let n = 0;
    for (const r of this.records.values()) if (r.ownerPrincipal === ownerPrincipal) n++;
    return n;
  }
  async touchOpened(fileId: string): Promise<UserFileRecord | null> {
    const cur = this.records.get(fileId);
    if (!cur) return null;
    const now = Date.now();
    const next = { ...cur, lastOpenedAt: now, updatedAt: now };
    this.records.set(fileId, next);
    return { ...next };
  }
  async transfer(fileId: string, from: string, to: string): Promise<UserFileRecord | null> {
    const cur = this.records.get(fileId);
    if (!cur || cur.ownerPrincipal !== from) return null;
    const next = { ...cur, ownerPrincipal: to, updatedAt: Date.now() };
    this.records.set(fileId, next);
    return { ...next };
  }
}

type CatalogFileShape = Record<string, UserFileRecord>;

export class LocalUserFileCatalog implements UserFileCatalog {
  private readonly file: string;
  private readonly lock: { withLock<T>(fn: () => T): T };

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'user-files.json');
    this.lock = makeLock(join(dir, 'user-files.lock'));
  }

  private readAll(): CatalogFileShape {
    const raw = readJsonFile<CatalogFileShape>(this.file, {});
    const out: CatalogFileShape = {};
    for (const [k, v] of Object.entries(raw)) out[k] = normalizeFileRecord(v);
    return out;
  }

  async create(input: Parameters<UserFileCatalog['create']>[0]): Promise<UserFileRecord> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const rec = buildRecord(input, Date.now());
      all[rec.fileId] = rec;
      writeJsonAtomic(this.file, all);
      return { ...rec };
    });
  }
  async get(fileId: string): Promise<UserFileRecord | null> {
    return this.lock.withLock(() => {
      const rec = this.readAll()[fileId];
      return rec ? { ...rec } : null;
    });
  }
  async listByOwner(ownerPrincipal: string): Promise<UserFileRecord[]> {
    return this.lock.withLock(() =>
      Object.values(this.readAll())
        .filter((r) => r.ownerPrincipal === ownerPrincipal)
        .sort(byRecency)
        .map((r) => ({ ...r })),
    );
  }
  async update(fileId: string, patch: UserFilePatch): Promise<UserFileRecord | null> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const cur = all[fileId];
      if (!cur) return null;
      const next = { ...cur, ...patch, fileId, updatedAt: Date.now() };
      all[fileId] = next;
      writeJsonAtomic(this.file, all);
      return { ...next };
    });
  }
  async remove(fileId: string): Promise<boolean> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      if (!all[fileId]) return false;
      delete all[fileId];
      writeJsonAtomic(this.file, all);
      return true;
    });
  }
  async countByOwner(ownerPrincipal: string): Promise<number> {
    return this.lock.withLock(
      () => Object.values(this.readAll()).filter((r) => r.ownerPrincipal === ownerPrincipal).length,
    );
  }
  async touchOpened(fileId: string): Promise<UserFileRecord | null> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const cur = all[fileId];
      if (!cur) return null;
      const now = Date.now();
      const next = { ...cur, lastOpenedAt: now, updatedAt: now };
      all[fileId] = next;
      writeJsonAtomic(this.file, all);
      return { ...next };
    });
  }
  async transfer(fileId: string, from: string, to: string): Promise<UserFileRecord | null> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const cur = all[fileId];
      if (!cur || cur.ownerPrincipal !== from) return null;
      const next = { ...cur, ownerPrincipal: to, updatedAt: Date.now() };
      all[fileId] = next;
      writeJsonAtomic(this.file, all);
      return { ...next };
    });
  }
}

const USER_FILES_COLLECTION = 'icecream_user_files';

export class FirestoreUserFileCatalog implements UserFileCatalog {
  constructor(private readonly db: FirestoreLike) {}

  private doc(fileId: string) {
    return this.db.collection(USER_FILES_COLLECTION).doc(fileId);
  }

  async create(input: Parameters<UserFileCatalog['create']>[0]): Promise<UserFileRecord> {
    const rec = buildRecord(input, Date.now());
    await this.doc(rec.fileId).set({ ...rec } as unknown as Record<string, unknown>);
    return { ...rec };
  }
  async get(fileId: string): Promise<UserFileRecord | null> {
    const snap = await this.doc(fileId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return data ? normalizeFileRecord(data as unknown as UserFileRecord) : null;
  }
  async listByOwner(ownerPrincipal: string): Promise<UserFileRecord[]> {
    const rows = await this.db.collection(USER_FILES_COLLECTION).queryEq('ownerPrincipal', ownerPrincipal);
    return rows
      .map((r) => r.data())
      .filter((d): d is Record<string, unknown> => !!d)
      .map((d) => normalizeFileRecord(d as unknown as UserFileRecord))
      .sort(byRecency)
      .map((r) => ({ ...r }));
  }
  async update(fileId: string, patch: UserFilePatch): Promise<UserFileRecord | null> {
    const cur = await this.get(fileId);
    if (!cur) return null;
    const next = { ...cur, ...patch, fileId, updatedAt: Date.now() };
    await this.doc(fileId).set({ ...next } as unknown as Record<string, unknown>);
    return { ...next };
  }
  async remove(fileId: string): Promise<boolean> {
    const cur = await this.get(fileId);
    if (!cur) return false;
    await this.doc(fileId).delete();
    return true;
  }
  async countByOwner(ownerPrincipal: string): Promise<number> {
    return (await this.listByOwner(ownerPrincipal)).length;
  }
  async touchOpened(fileId: string): Promise<UserFileRecord | null> {
    const cur = await this.get(fileId);
    if (!cur) return null;
    const now = Date.now();
    const next = { ...cur, lastOpenedAt: now, updatedAt: now };
    await this.doc(fileId).set(
      { lastOpenedAt: now, updatedAt: now } as unknown as Record<string, unknown>,
      { merge: true },
    );
    return next;
  }
  async transfer(fileId: string, from: string, to: string): Promise<UserFileRecord | null> {
    const cur = await this.get(fileId);
    if (!cur || cur.ownerPrincipal !== from) return null;
    const next = { ...cur, ownerPrincipal: to, updatedAt: Date.now() };
    await this.doc(fileId).set({ ...next } as unknown as Record<string, unknown>);
    return { ...next };
  }
}

/**
 * Build the file catalog for the configured provider. 'prod' REQUIRES
 * an injected Firestore client — fail closed, never a local fallback.
 */
export function createUserFileCatalog(
  env: NodeJS.ProcessEnv = process.env,
  opts: { firestoreDb?: FirestoreLike; dir?: string } = {},
): UserFileCatalog {
  if (userStoreProvider(env) === 'prod') {
    if (!opts.firestoreDb) {
      throw new Error(
        'user file catalog: USER_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)',
      );
    }
    return new FirestoreUserFileCatalog(opts.firestoreDb);
  }
  return new LocalUserFileCatalog(opts.dir ?? userStoreDir(env));
}

// ===========================================================================
// User settings (Workspace settings, hidden_files/workspace-settings/BRIEF.md)
// ===========================================================================
//
// One per-user settings record, two scopes kept distinct
// (platform-shell.md §4: settings live in the user profile, never in
// workbook bytes):
//   user   — the profile part: the display-name override (null = use
//            the name the identity provider supplied at sign-in).
//            Email is NOT part of this record: it is identity, owned
//            by the provider, echoed read-only from the tier record /
//            verified token claims — it can never be edited here.
//   office — the Icecream OFFICE app settings: suite-level, shared by
//            every Office product (Sheets today; Presentations and
//            Documents later read/write the SAME office part against
//            the SAME record). No sheets-specific keys, ever.
// Adapter posture is the family posture above: local JSON + lockfile,
// memory for tests, Firestore-shaped prod (collection
// `icecream_user_settings`) that FAILS CLOSED without an injected
// client. The provider switch is the family switch (USER_STORE).

export type ThemeChoice = 'light' | 'dark' | 'system';

/** App-settings default (brief: theme defaults to System). */
export const DEFAULT_THEME_CHOICE: ThemeChoice = 'system';

export function isThemeChoice(x: unknown): x is ThemeChoice {
  return x === 'light' || x === 'dark' || x === 'system';
}

export interface UserSettingsRecord {
  userId: string;
  /** Profile scope. displayName null = no override (provider name). */
  user: { displayName: string | null };
  /** Icecream Office scope (product-agnostic, suite-wide). */
  office: { theme: ThemeChoice };
  createdAt: number;
  updatedAt: number;
}

export interface UserSettingsPatch {
  /** Profile display-name override; null clears the override. */
  displayName?: string | null;
  /** Office theme choice. */
  theme?: ThemeChoice;
}

export interface UserSettingsStore {
  /** The stored record, or null when the user never saved settings. */
  get(userId: string): Promise<UserSettingsRecord | null>;
  /** Create-or-merge: only the patched fields change. */
  upsert(userId: string, patch: UserSettingsPatch): Promise<UserSettingsRecord>;
  /** Account deletion. Returns true when a record existed. */
  remove(userId: string): Promise<boolean>;
}

/** Fill defaults over a possibly-partial persisted shape. */
function normalizeSettingsRecord(
  raw: Partial<UserSettingsRecord> & { userId: string },
): UserSettingsRecord {
  const now = Date.now();
  return {
    userId: raw.userId,
    user: {
      displayName:
        typeof raw.user?.displayName === 'string' ? raw.user.displayName : null,
    },
    office: {
      theme: isThemeChoice(raw.office?.theme) ? raw.office.theme : DEFAULT_THEME_CHOICE,
    },
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  };
}

function applySettingsPatch(
  cur: UserSettingsRecord | null,
  userId: string,
  patch: UserSettingsPatch,
): UserSettingsRecord {
  const now = Date.now();
  const base: UserSettingsRecord = cur ?? {
    userId,
    user: { displayName: null },
    office: { theme: DEFAULT_THEME_CHOICE },
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...base,
    user: {
      displayName:
        patch.displayName !== undefined ? patch.displayName : base.user.displayName,
    },
    office: {
      theme: patch.theme !== undefined ? patch.theme : base.office.theme,
    },
    updatedAt: now,
  };
}

export class MemoryUserSettingsStore implements UserSettingsStore {
  private readonly records = new Map<string, UserSettingsRecord>();

  async get(userId: string): Promise<UserSettingsRecord | null> {
    const rec = this.records.get(userId);
    return rec ? structuredClone(rec) : null;
  }
  async upsert(userId: string, patch: UserSettingsPatch): Promise<UserSettingsRecord> {
    const next = applySettingsPatch(this.records.get(userId) ?? null, userId, patch);
    this.records.set(userId, next);
    return structuredClone(next);
  }
  async remove(userId: string): Promise<boolean> {
    return this.records.delete(userId);
  }
}

type SettingsFileShape = Record<string, UserSettingsRecord>;

export class LocalUserSettingsStore implements UserSettingsStore {
  private readonly file: string;
  private readonly lock: { withLock<T>(fn: () => T): T };

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'user-settings.json');
    this.lock = makeLock(join(dir, 'user-settings.lock'));
  }

  private readAll(): SettingsFileShape {
    const raw = readJsonFile<SettingsFileShape>(this.file, {});
    const out: SettingsFileShape = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = normalizeSettingsRecord({ ...v, userId: k });
    }
    return out;
  }

  async get(userId: string): Promise<UserSettingsRecord | null> {
    return this.lock.withLock(() => {
      const rec = this.readAll()[userId];
      return rec ? { ...rec } : null;
    });
  }
  async upsert(userId: string, patch: UserSettingsPatch): Promise<UserSettingsRecord> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const next = applySettingsPatch(all[userId] ?? null, userId, patch);
      all[userId] = next;
      writeJsonAtomic(this.file, all);
      return { ...next };
    });
  }
  async remove(userId: string): Promise<boolean> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      if (!all[userId]) return false;
      delete all[userId];
      writeJsonAtomic(this.file, all);
      return true;
    });
  }
}

const USER_SETTINGS_COLLECTION = 'icecream_user_settings';

export class FirestoreUserSettingsStore implements UserSettingsStore {
  constructor(private readonly db: FirestoreLike) {}

  private doc(userId: string) {
    return this.db.collection(USER_SETTINGS_COLLECTION).doc(userId);
  }

  async get(userId: string): Promise<UserSettingsRecord | null> {
    const snap = await this.doc(userId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return data
      ? normalizeSettingsRecord(data as Partial<UserSettingsRecord> & { userId: string })
      : null;
  }
  async upsert(userId: string, patch: UserSettingsPatch): Promise<UserSettingsRecord> {
    const cur = await this.get(userId);
    const next = applySettingsPatch(cur, userId, patch);
    await this.doc(userId).set({ ...next } as unknown as Record<string, unknown>);
    return { ...next };
  }
  async remove(userId: string): Promise<boolean> {
    const cur = await this.get(userId);
    if (!cur) return false;
    await this.doc(userId).delete();
    return true;
  }
}

/**
 * Build the settings store for the configured provider (the family
 * switch, USER_STORE). 'prod' REQUIRES an injected Firestore client —
 * fail closed, never a local fallback.
 */
export function createUserSettingsStore(
  env: NodeJS.ProcessEnv = process.env,
  opts: { firestoreDb?: FirestoreLike; dir?: string } = {},
): UserSettingsStore {
  if (userStoreProvider(env) === 'prod') {
    if (!opts.firestoreDb) {
      throw new Error(
        'user settings store: USER_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)',
      );
    }
    return new FirestoreUserSettingsStore(opts.firestoreDb);
  }
  return new LocalUserSettingsStore(opts.dir ?? userStoreDir(env));
}

// ===========================================================================
// Prod construction (Firestore) — the async client bootstrap the bins use
// ===========================================================================
//
// The sync factories above fail closed in prod mode without an injected
// client BY DESIGN: the real @google-cloud/firestore client can only be
// loaded asynchronously, and it is an optional prod dependency (loaded
// through a non-literal dynamic import — never a static import, so local
// runs and non-Node consumers of this module never resolve it). The
// gateway bin (gateway.ts) and the operator tool (set-tier.ts) therefore
// build the prod stores through the async constructors below, mirroring
// shareStore.ts's prodShareConfig + createProdAppShareStore posture:
// config is validated FIRST (fail closed, before any client work), and
// a missing package is a fail-closed error, never a local fallback.

/** Validated prod configuration for the user-store family. */
export interface ProdUserConfig {
  projectId: string;
  databaseId?: string;
}

/**
 * USER_STORE=prod requires GCP_PROJECT_ID (FIRESTORE_DATABASE_ID
 * optional). Throws fail-closed BEFORE any client work when the
 * project is not configured — the share-store posture.
 */
export function prodUserConfig(env: NodeJS.ProcessEnv = process.env): ProdUserConfig {
  const projectId = (env.GCP_PROJECT_ID ?? '').trim();
  if (!projectId) {
    throw new Error(
      'user store: USER_STORE=prod requires GCP_PROJECT_ID to be set — refusing to start with a half-configured production user store (fail closed)',
    );
  }
  const databaseId = (env.FIRESTORE_DATABASE_ID ?? '').trim();
  return { projectId, ...(databaseId ? { databaseId } : {}) };
}

/** Load the official Firestore client for a validated prod config. */
async function loadProdUserFirestoreDb(cfg: ProdUserConfig): Promise<FirestoreLike> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  let FirestoreCtor: unknown;
  try {
    ({ Firestore: FirestoreCtor } = await dynamicImport('@google-cloud/firestore'));
  } catch {
    throw new Error(
      'user store: USER_STORE=prod requires the @google-cloud/firestore package (not installed) — install it or use USER_STORE=local (fail closed)',
    );
  }
  const rawDb = new (FirestoreCtor as new (o: Record<string, unknown>) => unknown)({
    projectId: cfg.projectId,
    ...(cfg.databaseId ? { databaseId: cfg.databaseId } : {}),
  });
  return wrapFirestore(rawDb);
}

/** The three USER_STORE-family stores, all over ONE Firestore client. */
export interface ProdUserStores {
  userTierStore: UserTierStore;
  userFileCatalog: UserFileCatalog;
  userSettingsStore: UserSettingsStore;
  /** Invite-by-email directory (issue #84a), same Firestore client. */
  userDirectory: FirestoreUserDirectory;
}

/**
 * Construct the prod (Firestore) user stores: validates config first
 * (fail closed when GCP_PROJECT_ID is missing), then loads the
 * official @google-cloud/firestore client. Credentials resolve through
 * the client's own ADC discovery (the Cloud Run service account in
 * production; the operator's deployer credentials for set-tier).
 */
export async function createProdUserStores(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProdUserStores> {
  const cfg = prodUserConfig(env); // throws, fail closed, when incomplete
  const db = await loadProdUserFirestoreDb(cfg);
  return {
    userTierStore: new FirestoreUserTierStore(db),
    userFileCatalog: new FirestoreUserFileCatalog(db),
    userSettingsStore: new FirestoreUserSettingsStore(db),
    userDirectory: new FirestoreUserDirectory(db),
  };
}

/**
 * Construct ONLY the prod tier store (the set-tier operator tool's
 * target): same validation + client load as createProdUserStores.
 */
export async function createProdUserTierStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UserTierStore> {
  const cfg = prodUserConfig(env); // throws, fail closed, when incomplete
  const db = await loadProdUserFirestoreDb(cfg);
  return new FirestoreUserTierStore(db);
}
