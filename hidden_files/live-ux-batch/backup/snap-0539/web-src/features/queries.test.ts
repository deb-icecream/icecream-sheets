import { describe, expect, it } from 'vitest';
import {
  defaultQueryName,
  deleteQuery,
  loadQueries,
  newQueryId,
  saveQuery,
  touchQuery,
  type QueryEntry,
} from './queries';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

function entry(over: Partial<QueryEntry> = {}): QueryEntry {
  return {
    id: newQueryId(),
    name: 'Q',
    kind: 'csv',
    sourceText: 'a,b\n1,2',
    sheetName: 'Sheet1',
    createdAt: new Date().toISOString(),
    refreshedAt: null,
    rowCount: 1,
    status: 'ok',
    ...over,
  };
}

describe('queries registry', () => {
  it('starts empty', () => {
    expect(loadQueries(memStore())).toEqual([]);
  });
  it('saves and updates', () => {
    const s = memStore();
    const q = entry({ name: 'First' });
    saveQuery(q, s);
    saveQuery({ ...q, name: 'Renamed' }, s);
    const all = loadQueries(s);
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('Renamed');
  });
  it('deletes', () => {
    const s = memStore();
    const q = entry();
    saveQuery(q, s);
    deleteQuery(q.id, s);
    expect(loadQueries(s)).toEqual([]);
  });
  it('touchQuery marks refresh state', () => {
    const s = memStore();
    const q = entry();
    saveQuery(q, s);
    touchQuery(q.id, { refreshedAt: '2026-01-01', rowCount: 5, status: 'ok' }, s);
    const got = loadQueries(s)[0];
    expect(got.refreshedAt).toBe('2026-01-01');
    expect(got.rowCount).toBe(5);
  });
  it('touchQuery records errors', () => {
    const s = memStore();
    const q = entry();
    saveQuery(q, s);
    touchQuery(q.id, { refreshedAt: '2026-01-01', status: 'error', error: 'boom' }, s);
    expect(loadQueries(s)[0].error).toBe('boom');
  });
});

describe('defaultQueryName', () => {
  it('names web queries from the URL', () => {
    expect(defaultQueryName('web', undefined, 'https://example.com/data.csv')).toBe('Web: data.csv');
  });
  it('names text queries from the first line', () => {
    expect(defaultQueryName('csv', 'Name,Age\nAlice,30')).toBe('Text: Name,Age');
  });
});
