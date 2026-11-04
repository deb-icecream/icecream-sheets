/**
 * App-share store (idea-app-gallery, user-confirmed share design
 * 2026-10-21): a share is an app PLUS a materialized snapshot of its
 * bound data (AppSharePackage, packages/service artifacts/gallery.ts).
 * The gateway stores the package opaquely per share link; recipients
 * (signed in) fetch it and materialize their OWN bound copies — the
 * owner's records are never mutated by a recipient.
 *
 * Adapter posture mirrors userStore.ts: local JSON file + lockfile
 * mutex + atomic writes for the local stack; memory adapter for tests;
 * Firestore adapter for prod (SHARE_STORE=prod), following the
 * firestoreMetadata.ts pattern (narrow structural client, sha256-hex
 * document ids, loud failure — never silent truncation). The factory
 * FAILS CLOSED in prod mode without a Firestore client / config: prod
 * construction never silently falls back to local disk.
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
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sessionDataDir, wrapFirestore, type FirestoreLike } from './sessionStore.js';
import type { AppSharePackage } from '@icecream-sheets/service';

export interface AppShareRecord {
  shareId: string;
  ownerPrincipal: string;
  appName: string;
  sourceSheet: string;
  rowCount: number;
  colCount: number;
  createdAt: number;
  revokedAt: number | null;
  /** The shared app + data snapshot (service AppSharePackage shape). */
  pkg: AppSharePackage;
}

/** Metadata view for "shared by you" lists — never carries the package. */
export type AppShareSummary = Omit<AppShareRecord, 'pkg'>;

export function shareSummary(rec: AppShareRecord): AppShareSummary {
  const { pkg: _pkg, ...rest } = rec;
  return rest;
}

export interface AppShareStore {
  create(input: {
    shareId: string;
    ownerPrincipal: string;
    pkg: AppSharePackage;
  }): Promise<AppShareRecord>;
  /** The record (revoked included) or null. Callers enforce revoked. */
  get(shareId: string): Promise<AppShareRecord | null>;
  listByOwner(ownerPrincipal: string): Promise<AppShareRecord[]>;
  /** Owner-only revoke. Returns false when missing or not the owner's. */
  revoke(shareId: string, ownerPrincipal: string): Promise<boolean>;
  /**
   * HARD delete (account deletion): the record — package data and
   * all — is gone, not merely revoked. Returns false when missing.
   * Ownership is the CALLER's job (it enumerates via listByOwner).
   */
  remove(shareId: string): Promise<boolean>;
}

function buildRecord(
  input: Parameters<AppShareStore['create']>[0],
  now: number,
): AppShareRecord {
  return {
    shareId: input.shareId,
    ownerPrincipal: input.ownerPrincipal,
    appName: input.pkg.app.name,
    sourceSheet: input.pkg.snapshot.sheet,
    rowCount: input.pkg.rowCount,
    colCount: input.pkg.colCount,
    createdAt: now,
    revokedAt: null,
    pkg: input.pkg,
  };
}

export class MemoryAppShareStore implements AppShareStore {
  private readonly records = new Map<string, AppShareRecord>();

  async create(input: Parameters<AppShareStore['create']>[0]): Promise<AppShareRecord> {
    const rec = buildRecord(input, Date.now());
    this.records.set(rec.shareId, rec);
    return { ...rec };
  }
  async get(shareId: string): Promise<AppShareRecord | null> {
    const rec = this.records.get(shareId);
    return rec ? { ...rec } : null;
  }
  async listByOwner(ownerPrincipal: string): Promise<AppShareRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.ownerPrincipal === ownerPrincipal)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ ...r }));
  }
  async revoke(shareId: string, ownerPrincipal: string): Promise<boolean> {
    const rec = this.records.get(shareId);
    if (!rec || rec.ownerPrincipal !== ownerPrincipal) return false;
    if (rec.revokedAt === null) {
      this.records.set(shareId, { ...rec, revokedAt: Date.now() });
    }
    return true;
  }
  async remove(shareId: string): Promise<boolean> {
    return this.records.delete(shareId);
  }
}

// ---------------------------------------------------------------------------
// Local JSON-file adapter (same lock/atomic posture as userStore.ts)
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_SPIN_MS = 10;

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
          throw new Error(`share store: lock timeout after ${LOCK_TIMEOUT_MS}ms (fail closed)`);
        }
        sleepSync(LOCK_SPIN_MS);
      }
    }
  }
  return {
    withLock<T>(fn: () => T): T {
      acquireLock();
      try {
        return fn();
      } finally {
        try {
          unlinkSync(lockFile);
        } catch {
          // Already gone (stale-recovered by a peer).
        }
      }
    },
  };
}

type ShareFileShape = Record<string, AppShareRecord>;

export class LocalAppShareStore implements AppShareStore {
  private readonly file: string;
  private readonly lock: { withLock<T>(fn: () => T): T };

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'app-shares.json');
    this.lock = makeLock(join(dir, 'app-shares.lock'));
  }

  private readAll(): ShareFileShape {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
      throw e;
    }
    const parsed = JSON.parse(text) as ShareFileShape;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('share store: corrupt store file (fail closed)');
    }
    return parsed;
  }

  private writeAll(all: ShareFileShape): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), 'utf8');
    renameSync(tmp, this.file);
  }

  async create(input: Parameters<AppShareStore['create']>[0]): Promise<AppShareRecord> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const rec = buildRecord(input, Date.now());
      all[rec.shareId] = rec;
      this.writeAll(all);
      return { ...rec };
    });
  }
  async get(shareId: string): Promise<AppShareRecord | null> {
    const rec = this.readAll()[shareId];
    return rec ? { ...rec } : null;
  }
  async listByOwner(ownerPrincipal: string): Promise<AppShareRecord[]> {
    return Object.values(this.readAll())
      .filter((r) => r.ownerPrincipal === ownerPrincipal)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ ...r }));
  }
  async revoke(shareId: string, ownerPrincipal: string): Promise<boolean> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      const rec = all[shareId];
      if (!rec || rec.ownerPrincipal !== ownerPrincipal) return false;
      if (rec.revokedAt === null) {
        all[shareId] = { ...rec, revokedAt: Date.now() };
        this.writeAll(all);
      }
      return true;
    });
  }
  async remove(shareId: string): Promise<boolean> {
    return this.lock.withLock(() => {
      const all = this.readAll();
      if (!all[shareId]) return false;
      delete all[shareId];
      this.writeAll(all);
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Firestore adapter (prod) — firestoreMetadata.ts pattern: narrow
// structural client (FirestoreLike from sessionStore.ts), one document
// per share in `icecream_app_shares`, document id = sha256 hex of the
// share id (share ids are link tokens; the hash keeps doc ids uniform
// and always legal). Durability contract: create() resolves only after
// the write is acknowledged, and a record over the 1 MiB document cap
// is REJECTED LOUDLY — never silently truncated, because a truncated
// share package is corruption.
// ---------------------------------------------------------------------------

/** Firestore collection holding app-share documents. */
export const APP_SHARES_COLLECTION = 'icecream_app_shares';

/**
 * Firestore single-document ceiling enforced client-side (the same
 * 1,048,576-byte hard limit firestoreMetadata.ts enforces): a share
 * whose serialized record exceeds it fails loudly at create() time.
 */
export const APP_SHARE_DOC_CAP_BYTES = 1048576;

/** Document id for a share id: sha256 hex (always a legal doc id). */
export function shareDocId(shareId: string): string {
  return createHash('sha256').update(shareId, 'utf8').digest('hex');
}

/** Minimal shape a stored document must have to be a share record. */
function asShareRecord(data: Record<string, unknown> | undefined): AppShareRecord | null {
  if (!data) return null;
  const rec = data as Partial<AppShareRecord>;
  if (typeof rec.shareId !== 'string' || typeof rec.ownerPrincipal !== 'string') return null;
  if (!rec.pkg || typeof rec.pkg !== 'object') return null;
  return rec as AppShareRecord;
}

export class FirestoreAppShareStore implements AppShareStore {
  constructor(private readonly db: FirestoreLike) {
    if (!db) throw new Error('share store: Firestore client is required (fail closed)');
  }

  private doc(shareId: string) {
    return this.db.collection(APP_SHARES_COLLECTION).doc(shareDocId(shareId));
  }

  async create(input: Parameters<AppShareStore['create']>[0]): Promise<AppShareRecord> {
    const rec = buildRecord(input, Date.now());
    const bytes = Buffer.byteLength(JSON.stringify(rec), 'utf8');
    if (bytes > APP_SHARE_DOC_CAP_BYTES) {
      throw new Error(
        `share store: share ${rec.shareId} serializes to ${bytes} bytes, ` +
          `exceeding the ${APP_SHARE_DOC_CAP_BYTES}-byte Firestore document cap; ` +
          `refusing to write rather than truncate`,
      );
    }
    await this.doc(rec.shareId).set({ ...(rec as unknown as Record<string, unknown>) });
    return { ...rec };
  }

  async get(shareId: string): Promise<AppShareRecord | null> {
    const snap = await this.doc(shareId).get();
    if (!snap.exists) return null;
    // Tolerance contract (firestoreMetadata.ts): a malformed document
    // reads as missing, never as a half-record.
    return asShareRecord(snap.data());
  }

  async listByOwner(ownerPrincipal: string): Promise<AppShareRecord[]> {
    const rows = await this.db
      .collection(APP_SHARES_COLLECTION)
      .queryEq('ownerPrincipal', ownerPrincipal);
    const out: AppShareRecord[] = [];
    for (const row of rows) {
      const rec = asShareRecord(row.data());
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async revoke(shareId: string, ownerPrincipal: string): Promise<boolean> {
    const rec = await this.get(shareId);
    if (!rec || rec.ownerPrincipal !== ownerPrincipal) return false;
    if (rec.revokedAt === null) {
      await this.doc(shareId).set(
        { revokedAt: Date.now() } as Record<string, unknown>,
        { merge: true },
      );
    }
    return true;
  }

  async remove(shareId: string): Promise<boolean> {
    const rec = await this.get(shareId);
    if (!rec) return false;
    await this.doc(shareId).delete();
    return true;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function shareStoreProvider(env: NodeJS.ProcessEnv = process.env): 'local' | 'prod' {
  return env['SHARE_STORE'] === 'prod' ? 'prod' : 'local';
}

export function shareStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['SHARE_STORE_DIR'] ?? join(sessionDataDir(env), 'app-shares');
}

/** Validated prod configuration for the share store. */
export interface ProdShareConfig {
  projectId: string;
  databaseId?: string;
}

/**
 * SHARE_STORE=prod requires GCP_PROJECT_ID (FIRESTORE_DATABASE_ID
 * optional). Throws fail-closed BEFORE any client work when the
 * project is not configured — the MCP runner-config posture.
 */
export function prodShareConfig(env: NodeJS.ProcessEnv = process.env): ProdShareConfig {
  const projectId = (env.GCP_PROJECT_ID ?? '').trim();
  if (!projectId) {
    throw new Error(
      'share store: SHARE_STORE=prod requires GCP_PROJECT_ID to be set — refusing to start with a half-configured production share store (fail closed)',
    );
  }
  const databaseId = (env.FIRESTORE_DATABASE_ID ?? '').trim();
  return { projectId, ...(databaseId ? { databaseId } : {}) };
}

/**
 * Construct the prod (Firestore) share store: validates config first
 * (fail closed when GCP_PROJECT_ID is missing), then loads the
 * official @google-cloud/firestore client through a non-literal
 * dynamic import — the package is an optional prod dependency, and a
 * missing package is a fail-closed startup error, never a silent
 * fallback (sessionStore.loadProdClients posture).
 */
export async function createProdAppShareStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppShareStore> {
  const cfg = prodShareConfig(env); // throws, fail closed, when incomplete
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  let FirestoreCtor: unknown;
  try {
    ({ Firestore: FirestoreCtor } = await dynamicImport('@google-cloud/firestore'));
  } catch {
    throw new Error(
      'share store: SHARE_STORE=prod requires the @google-cloud/firestore package (not installed) — install it or use SHARE_STORE=local (fail closed)',
    );
  }
  const rawDb = new (FirestoreCtor as new (o: Record<string, unknown>) => unknown)({
    projectId: cfg.projectId,
    ...(cfg.databaseId ? { databaseId: cfg.databaseId } : {}),
  });
  return new FirestoreAppShareStore(wrapFirestore(rawDb));
}

/**
 * Construct the share store from env. Prod mode REQUIRES an injected
 * Firestore client (mirroring createFileRegistry / createUserTierStore:
 * the async client bootstrap lives in createProdAppShareStore, which
 * the gateway bin awaits) — without one this throws rather than
 * silently landing shares on local disk in production.
 */
export function createAppShareStore(
  env: NodeJS.ProcessEnv = process.env,
  opts: { firestoreDb?: FirestoreLike } = {},
): AppShareStore {
  if (shareStoreProvider(env) === 'prod') {
    if (!opts.firestoreDb) {
      throw new Error(
        'share store: SHARE_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)',
      );
    }
    return new FirestoreAppShareStore(opts.firestoreDb);
  }
  return new LocalAppShareStore(shareStoreDir(env));
}
