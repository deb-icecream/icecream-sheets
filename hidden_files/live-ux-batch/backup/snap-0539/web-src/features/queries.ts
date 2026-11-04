/**
 * Queries & Connections registry (Data > Queries & Connections).
 *
 * A "query" is a saved, refreshable import: the source payload plus the
 * sheet it loads into. Refresh re-runs the import (web URLs are
 * re-fetched; pasted text is static and reported as such). "Connections"
 * (existing data-source bindings from features/dataSources.ts) are read
 * separately and merged in the QueriesPane UI.
 */

export type QueryKind = 'text' | 'csv' | 'web';

export interface QueryEntry {
  id: string;
  name: string;
  kind: QueryKind;
  /** Raw text for text/csv kinds. */
  sourceText?: string;
  /** URL for web kind. */
  url?: string;
  /** Delimiter used for text/csv kinds. */
  delimiter?: string;
  /** Sheet the query loads into. */
  sheetName: string;
  createdAt: string;
  refreshedAt: string | null;
  rowCount: number;
  status: 'ok' | 'stale' | 'error';
  error?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'icecream.queries.v1';

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
    };
  } catch {
    return null;
  }
}

export function loadQueries(store?: StorageLike): QueryEntry[] {
  const s = store ?? defaultStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function persistQueries(queries: QueryEntry[], store?: StorageLike): void {
  const s = store ?? defaultStorage();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, JSON.stringify(queries)); } catch { /* storage full */ }
}

/** Insert or update a query by id; returns the updated list. */
export function saveQuery(query: QueryEntry, store?: StorageLike): QueryEntry[] {
  const queries = loadQueries(store);
  const idx = queries.findIndex((q) => q.id === query.id);
  const next = idx === -1 ? [...queries, query] : queries.map((q, i) => (i === idx ? query : q));
  persistQueries(next, store);
  return next;
}

export function deleteQuery(id: string, store?: StorageLike): QueryEntry[] {
  const next = loadQueries(store).filter((q) => q.id !== id);
  persistQueries(next, store);
  return next;
}

/** Mark a query refreshed (or failed); returns the updated list. */
export function touchQuery(
  id: string,
  patch: { refreshedAt: string; rowCount?: number; status: QueryEntry['status']; error?: string },
  store?: StorageLike,
): QueryEntry[] {
  const next = loadQueries(store).map((q) =>
    q.id === id ? { ...q, ...patch, error: patch.error } : q,
  );
  persistQueries(next, store);
  return next;
}

export function newQueryId(): string {
  return `q_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Default name for a query derived from its source. */
export function defaultQueryName(kind: QueryKind, sourceText?: string, url?: string): string {
  if (kind === 'web' && url) {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      return last ? `Web: ${last}` : `Web: ${u.hostname}`;
    } catch {
      return 'Web query';
    }
  }
  const firstLine = (sourceText ?? '').split('\n')[0]?.slice(0, 32) ?? '';
  return `Text: ${firstLine || 'pasted data'}`;
}
