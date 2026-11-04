import { describe, expect, it } from 'vitest';
import { addRecentSource, clearRecentSources, loadRecentSources } from './recentSources';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('recentSources', () => {
  it('starts empty', () => {
    expect(loadRecentSources(memStore())).toEqual([]);
  });
  it('adds most-recent-first', () => {
    const s = memStore();
    addRecentSource({ kind: 'web', label: 'a', payload: 'https://a' }, s);
    addRecentSource({ kind: 'web', label: 'b', payload: 'https://b' }, s);
    expect(loadRecentSources(s).map((r) => r.label)).toEqual(['b', 'a']);
  });
  it('dedupes re-imports to the front', () => {
    const s = memStore();
    addRecentSource({ kind: 'web', label: 'a', payload: 'https://a' }, s);
    addRecentSource({ kind: 'web', label: 'b', payload: 'https://b' }, s);
    addRecentSource({ kind: 'web', label: 'a', payload: 'https://a' }, s);
    expect(loadRecentSources(s).map((r) => r.label)).toEqual(['a', 'b']);
  });
  it('caps at 10 entries', () => {
    const s = memStore();
    for (let i = 0; i < 15; i++) {
      addRecentSource({ kind: 'text', label: `${i}`, payload: `${i}` }, s);
    }
    expect(loadRecentSources(s).length).toBe(10);
  });
  it('clears', () => {
    const s = memStore();
    addRecentSource({ kind: 'text', label: 'x', payload: 'x' }, s);
    clearRecentSources(s);
    expect(loadRecentSources(s)).toEqual([]);
  });
});
