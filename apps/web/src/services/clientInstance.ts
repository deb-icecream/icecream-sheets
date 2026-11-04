/**
 * Client-instance identity (placement addendum 2, owner 2026-10-23).
 *
 * A client instance is ONE attached app instance — one tab. It is NOT
 * the user: the same user in two tabs is two instances, and the server
 * refcounts attached instances per session, releasing the workbook
 * copy only when the last instance detaches. The id lives in
 * sessionStorage, which is per-tab by construction: a reload of the
 * same tab keeps the instance (it never left), a new tab is a new
 * instance, and a closed tab's id dies with it (its detach is the
 * pagehide beacon; if that is lost, the idle rule is the backstop).
 */
let cached: string | null = null;

const STORAGE_KEY = 'icecream-client-instance-id';

function randomId(): string {
  try {
    return `tab-${crypto.randomUUID()}`;
  } catch {
    return `tab-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

export function clientInstanceId(): string {
  if (cached) return cached;
  try {
    const store = window.sessionStorage;
    let existing = store.getItem(STORAGE_KEY);
    if (!existing) {
      existing = randomId();
      store.setItem(STORAGE_KEY, existing);
    }
    cached = existing;
  } catch {
    // Storage unavailable (private mode, non-browser test env): an
    // in-memory id still gives this app instance a stable identity.
    cached = randomId();
  }
  return cached;
}
