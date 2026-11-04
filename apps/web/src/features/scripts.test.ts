/**
 * Tests for the Apps Script library (apps/web/src/features/scripts.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  createScript,
  extractDeclaredPermissions,
  grantScript,
  loadScripts,
  recordRun,
  revokeGrant,
  saveScripts,
  scriptTemplate,
  SCRIPT_STORAGE_KEY,
  type UserScript,
} from './scripts';

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('script library', () => {
  it('creates scripts with the starter template', () => {
    const s = createScript('Hello', 'typescript');
    expect(s.id).toMatch(/^script-/);
    expect(s.name).toBe('Hello');
    expect(s.language).toBe('typescript');
    expect(s.source).toContain('export function main');
    expect(s.source).toContain('PERMISSIONS');
    expect(s.granted).toBe(false);
    expect(s.permissions).toEqual([]);
    const js = createScript('J', 'javascript');
    expect(js.language).toBe('javascript');
    expect(js.source).toBe(scriptTemplate('javascript'));
  });

  it('round-trips through storage', () => {
    const store = memStorage();
    expect(loadScripts(store)).toEqual([]);
    const scripts = [createScript('A'), createScript('B')];
    saveScripts(scripts, store);
    expect(store.getItem(SCRIPT_STORAGE_KEY)).toContain('"name":"A"');
    const loaded = loadScripts(store);
    expect(loaded.map((s) => s.name)).toEqual(['A', 'B']);
    expect(loaded[0]!.id).toBe(scripts[0]!.id);
  });

  it('survives corrupt storage', () => {
    const store = memStorage();
    store.setItem(SCRIPT_STORAGE_KEY, 'not json{{{');
    expect(loadScripts(store)).toEqual([]);
    store.setItem(SCRIPT_STORAGE_KEY, JSON.stringify([{ bogus: true }]));
    expect(loadScripts(store)).toEqual([]);
  });

  it('extracts declared PERMISSIONS from source', () => {
    const perms = extractDeclaredPermissions(scriptTemplate('typescript'));
    expect(perms).toEqual([
      { action: 'cell.write', target: 'Sheet1!0,0:9,9', reason: 'Fill the report block' },
    ]);
    expect(extractDeclaredPermissions('export function main(api) {}')).toEqual([]);
  });

  it('grants and revokes permissions', () => {
    const s = createScript('G');
    const perms = [{ action: 'cell.write', target: 'Sheet1!0,0' }];
    const granted = grantScript(s, perms);
    expect(granted.granted).toBe(true);
    expect(granted.permissions).toEqual(perms);
    expect(granted.grantedAt).toBeTruthy();
    const revoked = revokeGrant(granted);
    expect(revoked.granted).toBe(false);
    expect(revoked.grantedAt).toBeNull();
  });

  it('records run outcomes', () => {
    const s = createScript('R');
    const after = recordRun(s, true);
    expect(after.lastRunOk).toBe(true);
    expect(after.lastRunAt).toBeTruthy();
  });
});
