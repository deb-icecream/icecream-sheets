/**
 * Tests for the workbook library (platform-shell.md §2): New / Open /
 * Copy / Trash / Restore / permanent delete with a pluggable bytes
 * backend (in-memory here; IndexedDB in the browser).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbookLibrary, TRASH_RETENTION_MS, formatBytes, type BytesBackend } from './library';

function memoryBytes(): BytesBackend {
  const map = new Map<string, Uint8Array>();
  return {
    put: async (id, bytes) => void map.set(id, bytes),
    get: async (id) => map.get(id) ?? null,
    remove: async (id) => void map.delete(id),
  };
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  stubLocalStorage();
  vi.unstubAllGlobals();
  stubLocalStorage();
});

describe('WorkbookLibrary', () => {
  it('creates and lists workbooks with metadata', async () => {
    const lib = new WorkbookLibrary(memoryBytes());
    const entry = await lib.create('Budget', BYTES, 'you');
    expect(entry.name).toBe('Budget');
    expect(entry.owner).toBe('you');
    expect(entry.sizeBytes).toBe(4);
    expect(entry.backend).toBe('local');
    expect(entry.trashed).toBe(false);
    expect(entry.createdAt).toBeLessThanOrEqual(entry.modifiedAt);
    const list = lib.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(entry.id);
  });

  it('opens stored bytes by id', async () => {
    const lib = new WorkbookLibrary(memoryBytes());
    const entry = await lib.create('Budget', BYTES, 'you');
    const bytes = await lib.open(entry.id);
    expect(bytes).toEqual(BYTES);
    expect(await lib.open('nope')).toBeNull();
  });

  it('copies duplicates bytes and metadata under a new id', async () => {
    const lib = new WorkbookLibrary(memoryBytes());
    const src = await lib.create('Budget', BYTES, 'you');
    const copy = await lib.copy(src.id, 'you');
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(src.id);
    expect(copy!.name).toBe('Copy of Budget');
    expect(await lib.open(copy!.id)).toEqual(BYTES);
    expect(lib.list()).toHaveLength(2);
  });

  it('trashes, restores, and permanently deletes', async () => {
    const lib = new WorkbookLibrary(memoryBytes());
    const entry = await lib.create('Budget', BYTES, 'you');
    expect(lib.trashEntry(entry.id)).toBe(true);
    expect(lib.list()).toHaveLength(0);
    expect(lib.trash()).toHaveLength(1);
    expect(await lib.open(entry.id)).toBeNull(); // trashed: not openable
    expect(lib.restore(entry.id)).toBe(true);
    expect(lib.list()).toHaveLength(1);
    expect(await lib.deletePermanent(entry.id)).toBe(true);
    expect(lib.list()).toHaveLength(0);
    expect(lib.trash()).toHaveLength(0);
    expect(await lib.open(entry.id)).toBeNull();
  });

  it('refuses to restore past the retention window', async () => {
    const lib = new WorkbookLibrary(memoryBytes());
    const entry = await lib.create('Old', BYTES, 'you');
    lib.trashEntry(entry.id);
    const stale = lib.get(entry.id)!;
    stale.trashedAt = Date.now() - TRASH_RETENTION_MS - 1000;
    expect(lib.restore(entry.id)).toBe(false);
    expect(lib.trash()).toHaveLength(0); // expired out of the trash view
  });

  it('updates bytes in place and renames', async () => {
    const lib = new WorkbookLibrary(memoryBytes());
    const entry = await lib.create('Budget', BYTES, 'you');
    await lib.updateBytes(entry.id, new Uint8Array([9, 9]));
    expect((await lib.open(entry.id))?.length).toBe(2);
    expect(lib.rename(entry.id, 'Budget 2026')).toBe(true);
    expect(lib.get(entry.id)?.name).toBe('Budget 2026');
  });

  it('upsertRemote mirrors a server-stored entry without local bytes (gateway save)', async () => {
    const bytes = memoryBytes();
    const lib = new WorkbookLibrary(bytes);
    const entry = lib.upsertRemote({
      id: 'wb_server1',
      name: 'Remote.xlsx',
      owner: 'user:alice',
      sizeBytes: 12345,
      modifiedAt: 5000,
    });
    expect(entry.backend).toBe('gateway');
    expect(entry.sizeBytes).toBe(12345);
    expect(lib.list().map((e) => e.id)).toContain('wb_server1');
    // No bytes were written to the local bytes backend for this entry.
    expect(await bytes.get('wb_server1')).toBeNull();
    // A second upsert updates in place (autosave), keeping one entry.
    const again = lib.upsertRemote({
      id: 'wb_server1',
      name: 'Remote.xlsx',
      owner: 'user:alice',
      sizeBytes: 22222,
      modifiedAt: 9000,
    });
    expect(again.sizeBytes).toBe(22222);
    expect(lib.list()).toHaveLength(1);
    // Metadata persists across instances like any other entry.
    const lib2 = new WorkbookLibrary(bytes);
    expect(lib2.get('wb_server1')?.backend).toBe('gateway');
  });

  it('persists metadata across instances (localStorage)', async () => {
    const bytes = memoryBytes();
    const lib1 = new WorkbookLibrary(bytes);
    const entry = await lib1.create('Budget', BYTES, 'you');
    const lib2 = new WorkbookLibrary(bytes);
    expect(lib2.list().map((e) => e.id)).toContain(entry.id);
  });
});

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
