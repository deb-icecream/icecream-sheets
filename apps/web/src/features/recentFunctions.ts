/**
 * Recently Used functions (Formulas > Function Library > Recently Used).
 *
 * MRU list of function names, most recent first, capped at MAX_RECENT.
 * Persisted to localStorage when available; always keeps an in-memory
 * copy so it works in any environment (and in tests).
 */

const STORAGE_KEY = 'icecream.recentFunctions';
export const MAX_RECENT = 10;

let memory: string[] = [];

function load(): string[] {
  if (memory.length > 0) return [...memory];
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    memory = parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_RECENT);
    return [...memory];
  } catch {
    return [];
  }
}

function save(list: string[]): void {
  memory = list;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage full or unavailable — the in-memory list still works.
  }
}

/** Record a function use; returns the updated MRU list. */
export function recordFunctionUse(name: string): string[] {
  const clean = name.trim().toUpperCase();
  if (!clean) return getRecentFunctions();
  const list = [clean, ...load().filter((n) => n !== clean)].slice(0, MAX_RECENT);
  save(list);
  return list;
}

/** Most-recently-used function names, most recent first. */
export function getRecentFunctions(): string[] {
  return load();
}

export function clearRecentFunctions(): void {
  save([]);
}

/** Test hook: reset the in-memory list without touching storage. */
export function __resetRecentForTests(): void {
  memory = [];
}
