/**
 * Recent Sources (Data > Get & Transform > Recent Sources).
 *
 * MRU list of data sources the user imported from (text pastes, CSV
 * text, web URLs). Stored in the service metadata store
 * (localStorage-backed), capped at 10 entries, most-recent-first.
 * Re-importing a recent source re-runs the import through QuickImport.
 */

export type RecentSourceKind = 'text' | 'csv' | 'web';

export interface RecentSource {
  id: string;
  kind: RecentSourceKind;
  /** Human label, e.g. the URL or "Pasted text (42 rows)". */
  label: string;
  /** The payload needed to re-import: raw text or URL. */
  payload: string;
  at: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'icecream.recentSources.v1';
const MAX_SOURCES = 10;

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

export function loadRecentSources(store?: StorageLike): RecentSource[] {
  const s = store ?? defaultStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentSource[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(sources: RecentSource[], store?: StorageLike): void {
  const s = store ?? defaultStorage();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, JSON.stringify(sources)); } catch { /* storage full */ }
}

/**
 * Record a source import. Re-importing the same payload moves it to the
 * front instead of duplicating it. Returns the updated list.
 */
export function addRecentSource(
  input: { kind: RecentSourceKind; label: string; payload: string },
  store?: StorageLike,
): RecentSource[] {
  const sources = loadRecentSources(store).filter(
    (s) => !(s.kind === input.kind && s.payload === input.payload),
  );
  const entry: RecentSource = {
    id: `rs_${Date.now().toString(36)}`,
    kind: input.kind,
    label: input.label,
    payload: input.payload,
    at: new Date().toISOString(),
  };
  const next = [entry, ...sources].slice(0, MAX_SOURCES);
  persist(next, store);
  return next;
}

export function clearRecentSources(store?: StorageLike): void {
  persist([], store);
}
