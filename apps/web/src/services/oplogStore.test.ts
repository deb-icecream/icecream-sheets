/**
 * Op-log store selection semantics (issue #50): the registry read
 * tolerates corruption, and the desktop purge removes exactly the
 * enumerated op logs + the registry — never neighbouring keys such as
 * the collab queue (`icecream.collab.<fileId>`).
 *
 * Issue #93: a server-backed page (file or share link) is never an
 * op-log replay page — replaying a stored log there re-executes
 * superseded generations through the live session (refresh flash).
 */
import { describe, expect, it } from 'vitest';
import {
  OPLOG_KEY_PREFIX,
  OPLOG_TABS_KEY,
  isServerBackedLocation,
  purgeStoredOpLogs,
  readOpLogTabIds,
  type OpLogStorage,
} from './oplogStore';

function fakeStorage(seed: Record<string, string> = {}): OpLogStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('oplogStore', () => {
  it('reads the tab registry; absent or corrupt registry reads as empty', () => {
    expect(readOpLogTabIds(fakeStorage())).toEqual([]);
    expect(readOpLogTabIds(fakeStorage({ [OPLOG_TABS_KEY]: 'not json' }))).toEqual([]);
    expect(readOpLogTabIds(fakeStorage({ [OPLOG_TABS_KEY]: '{"x":1}' }))).toEqual([]);
    expect(
      readOpLogTabIds(fakeStorage({ [OPLOG_TABS_KEY]: JSON.stringify(['a', 7, 'b']) })),
    ).toEqual(['a', 'b']);
  });

  it('purge removes every registered tab log + the registry, and nothing else', () => {
    const storage = fakeStorage({
      [OPLOG_TABS_KEY]: JSON.stringify(['tab-old', 'tab-older']),
      [`${OPLOG_KEY_PREFIX}tab-old`]: 'serialized-log-1',
      [`${OPLOG_KEY_PREFIX}tab-older`]: 'serialized-log-2',
      'icecream.collab.file-1': 'collab queue — must survive',
      'icecream.library.v1': 'library metadata — must survive',
    });
    const purged = purgeStoredOpLogs(storage);
    expect(purged).toEqual(['tab-old', 'tab-older']);
    expect(storage.map.has(`${OPLOG_KEY_PREFIX}tab-old`)).toBe(false);
    expect(storage.map.has(`${OPLOG_KEY_PREFIX}tab-older`)).toBe(false);
    expect(storage.map.has(OPLOG_TABS_KEY)).toBe(false);
    expect(storage.map.get('icecream.collab.file-1')).toBe('collab queue — must survive');
    expect(storage.map.get('icecream.library.v1')).toBe('library metadata — must survive');
  });

  it('purge with no registry is a no-op that still drops a stray registry key', () => {
    const storage = fakeStorage({ [OPLOG_TABS_KEY]: 'corrupt' });
    expect(purgeStoredOpLogs(storage)).toEqual([]);
    expect(storage.map.size).toBe(0);
  });

  it('#93: file and share links are server-backed; bare root is not', () => {
    // Canonical deep link + legacy hash form.
    expect(isServerBackedLocation({ search: '?file=file-123', hash: '' })).toBe(true);
    expect(isServerBackedLocation({ search: '', hash: '#file=file-123' })).toBe(true);
    // A share link opens a server session too (join/import path).
    expect(isServerBackedLocation({ search: '?share=share-9', hash: '' })).toBe(true);
    // Bare root (Workspace / landing / local workbook) keeps the
    // legacy local op-log behavior exactly.
    expect(isServerBackedLocation({ search: '', hash: '' })).toBe(false);
    expect(isServerBackedLocation({})).toBe(false);
    // Unrelated params do not make a page server-backed.
    expect(isServerBackedLocation({ search: '?theme=dark', hash: '' })).toBe(false);
  });
});
