/**
 * Workbook library (design-docs/platform-shell.md §2).
 *
 * New, Open, Make a copy and Move to trash operate on the workbook
 * metadata store. Open lists the user's workbooks with owner, created and
 * modified times, size and storage backend. Make a copy duplicates bytes
 * and metadata under a new id. Move to trash soft-deletes with restore
 * inside the retention window (30 days), then permanent delete.
 *
 * Local mode: metadata in localStorage (versioned key), workbook bytes in
 * IndexedDB with an in-memory fallback. Gateway mode: the service metadata
 * store owns both (see packages/service/src/metadataStore.ts); this store
 * is the local-host equivalent of the same §2 lifecycle.
 */

export type StorageBackend = 'local' | 'gateway' | 'file';

export interface LibraryEntry {
  /** Stable id (uuid). */
  id: string;
  name: string;
  owner: string;
  createdAt: number;
  modifiedAt: number;
  sizeBytes: number;
  backend: StorageBackend;
  trashed: boolean;
  trashedAt?: number;
}

/** Retention window for soft-deleted workbooks (30 days, per §2). */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const META_KEY = 'icecream.library.v1';

/** Bytes backend: IndexedDB in the browser, in-memory otherwise (tests). */
export interface BytesBackend {
  put(id: string, bytes: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array | null>;
  remove(id: string): Promise<void>;
}

function memoryBackend(): BytesBackend {
  const map = new Map<string, Uint8Array>();
  return {
    put: async (id, bytes) => void map.set(id, bytes),
    get: async (id) => map.get(id) ?? null,
    remove: async (id) => void map.delete(id),
  };
}

function indexedDbBackend(): BytesBackend | null {
  try {
    if (typeof indexedDB === 'undefined') return null;
  } catch {
    return null;
  }
  const DB = 'icecream-library';
  const STORE = 'bytes';
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const tx = async (mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest) =>
    new Promise<unknown>((resolve, reject) => {
      open().then(
        (db) => {
          const t = db.transaction(STORE, mode);
          const req = fn(t.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          t.oncomplete = () => db.close();
        },
        reject,
      );
    });
  return {
    put: async (id, bytes) => {
      await tx('readwrite', (s) => s.put(bytes, id));
    },
    get: async (id) => {
      const v = await tx('readonly', (s) => s.get(id));
      return v instanceof Uint8Array ? v : null;
    },
    remove: async (id) => {
      await tx('readwrite', (s) => s.delete(id));
    },
  };
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `wb-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function readMeta(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version: number; entries: LibraryEntry[] };
    return parsed.version === 1 && Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function writeMeta(entries: LibraryEntry[]): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify({ version: 1, entries }));
  } catch {
    // Storage full / private mode: the in-memory copy still works for the session.
  }
}

/**
 * The workbook library. One instance per app session; entries live in
 * localStorage metadata, bytes in IndexedDB (in-memory fallback).
 */
export class WorkbookLibrary {
  private entries: LibraryEntry[];
  private bytes: BytesBackend;

  constructor(bytes?: BytesBackend) {
    this.entries = readMeta();
    this.bytes = bytes ?? indexedDbBackend() ?? memoryBackend();
  }

  /** Visible (non-trashed) workbooks, newest first. */
  list(): LibraryEntry[] {
    return this.entries
      .filter((e) => !e.trashed)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /** Trashed workbooks inside the retention window. */
  trash(): LibraryEntry[] {
    const now = Date.now();
    return this.entries
      .filter((e) => e.trashed && now - (e.trashedAt ?? 0) < TRASH_RETENTION_MS)
      .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  }

  get(id: string): LibraryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** New: store workbook bytes under a new id. */
  async create(name: string, bytes: Uint8Array, owner: string, backend: StorageBackend = 'local'): Promise<LibraryEntry> {
    const now = Date.now();
    const entry: LibraryEntry = {
      id: newId(),
      name,
      owner,
      createdAt: now,
      modifiedAt: now,
      sizeBytes: bytes.byteLength,
      backend,
      trashed: false,
    };
    await this.bytes.put(entry.id, bytes);
    this.entries.push(entry);
    writeMeta(this.entries);
    return entry;
  }

  /** Open: fetch the stored bytes for a workbook id. */
  async open(id: string): Promise<Uint8Array | null> {
    const entry = this.get(id);
    if (!entry || entry.trashed) return null;
    return this.bytes.get(id);
  }

  /** Make a copy: duplicate bytes + metadata under a new id. */
  async copy(id: string, owner: string): Promise<LibraryEntry | null> {
    const src = this.get(id);
    if (!src || src.trashed) return null;
    const bytes = await this.bytes.get(id);
    if (!bytes) return null;
    return this.create(`Copy of ${src.name}`, bytes, owner, src.backend);
  }

  /** Move to trash (soft delete). */
  trashEntry(id: string): boolean {
    const entry = this.get(id);
    if (!entry || entry.trashed) return false;
    entry.trashed = true;
    entry.trashedAt = Date.now();
    writeMeta(this.entries);
    return true;
  }

  /** Restore from trash inside the retention window. */
  restore(id: string): boolean {
    const entry = this.get(id);
    if (!entry || !entry.trashed) return false;
    if (Date.now() - (entry.trashedAt ?? 0) >= TRASH_RETENTION_MS) return false;
    entry.trashed = false;
    delete entry.trashedAt;
    writeMeta(this.entries);
    return true;
  }

  /** Permanent delete: metadata + bytes. */
  async deletePermanent(id: string): Promise<boolean> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    writeMeta(this.entries);
    await this.bytes.remove(id);
    return true;
  }

  /** Rename a workbook (metadata only). */
  rename(id: string, name: string): boolean {
    const entry = this.get(id);
    if (!entry || entry.trashed) return false;
    entry.name = name;
    entry.modifiedAt = Date.now();
    writeMeta(this.entries);
    return true;
  }

  /**
   * Register/refresh an entry whose bytes live in the SERVER library
   * store (gateway mode, Cycle 10 closure): metadata is mirrored locally
   * so the library dialog lists it like any other entry, but no bytes
   * are stored in (or ever passed through) this tab's bytes backend —
   * opening it fetches the stored bytes from the engine service.
   */
  upsertRemote(input: {
    id: string;
    name: string;
    owner: string;
    sizeBytes: number;
    modifiedAt?: number;
  }): LibraryEntry {
    const modifiedAt = input.modifiedAt ?? Date.now();
    const existing = this.get(input.id);
    if (existing) {
      existing.name = input.name;
      existing.sizeBytes = input.sizeBytes;
      existing.modifiedAt = modifiedAt;
      existing.backend = 'gateway';
      existing.trashed = false;
      delete existing.trashedAt;
      writeMeta(this.entries);
      return { ...existing };
    }
    const entry: LibraryEntry = {
      id: input.id,
      name: input.name,
      owner: input.owner,
      createdAt: modifiedAt,
      modifiedAt,
      sizeBytes: input.sizeBytes,
      backend: 'gateway',
      trashed: false,
    };
    this.entries.push(entry);
    writeMeta(this.entries);
    return { ...entry };
  }

  /** Touch modified time + size after a save-overwrite. */
  async updateBytes(id: string, bytes: Uint8Array): Promise<boolean> {
    const entry = this.get(id);
    if (!entry || entry.trashed) return false;
    await this.bytes.put(id, bytes);
    entry.modifiedAt = Date.now();
    entry.sizeBytes = bytes.byteLength;
    writeMeta(this.entries);
    return true;
  }

  /** For tests: expose the bytes backend. */
  bytesBackend(): BytesBackend {
    return this.bytes;
  }
}

/** Format bytes for display, e.g. "1.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
