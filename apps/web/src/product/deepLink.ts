/**
 * Deep links for workspace files (BRIEF.md §3, CONTRACT.md §Web).
 *
 * A file's canonical URL is the app URL with `?file=<fileId>`. The
 * legacy `#file=<fileId>` hash form is still READ (older links), but the
 * search parameter always wins when both are present. When a logged-out
 * visitor lands on a file link, the fileId is stashed in sessionStorage
 * before the sign-in round trip and taken back out (read-once) after
 * auth, so login returns the user to the file they opened.
 */

export const RETURN_FILE_KEY = 'icecream-sheets.return-file';

/** fileId from a `?file=` search string (with or without the '?'). */
export function fileIdFromSearch(search: string): string | null {
  if (!search) return null;
  const query = search.startsWith('?') ? search.slice(1) : search;
  const value = new URLSearchParams(query).get('file');
  return value ? value : null;
}

/** fileId from the legacy `#file=` hash form (with or without the '#'). */
export function fileIdFromHash(hash: string): string | null {
  if (!hash) return null;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!body) return null;
  const value = new URLSearchParams(body).get('file');
  return value ? value : null;
}

/**
 * fileId from a location-like object: the search parameter wins over
 * the legacy hash form.
 */
export function fileIdFromUrl(loc: { search?: string; hash?: string }): string | null {
  return fileIdFromSearch(loc.search ?? '') ?? fileIdFromHash(loc.hash ?? '');
}

/** Canonical deep-link URL for a file: origin + pathname + `?file=`. */
export function buildFileUrl(fileId: string): string {
  const loc = (globalThis as { location?: Location }).location;
  const base = loc ? `${loc.origin}${loc.pathname}` : '';
  return `${base}?file=${encodeURIComponent(fileId)}`;
}

/**
 * The HOME url (#31): the app root with no deep link. The shell routes
 * it by auth state — signed in lands on the Workspace, signed out on
 * the landing page — so every brand/logo click everywhere uses this
 * one href and always goes home.
 */
export function buildHomeUrl(): string {
  const loc = (globalThis as { location?: Location }).location;
  return loc ? `${loc.origin}${loc.pathname}` : '/';
}

/** Remember the file a logged-out visitor was headed to (pre-login). */
export function stashReturnFile(fileId: string): void {
  try {
    globalThis.sessionStorage?.setItem(RETURN_FILE_KEY, fileId);
  } catch {
    // Storage unavailable — the return-to-file nicety is best-effort.
  }
}

/** Take the stashed return file, removing it (read-once). */
export function takeReturnFile(): string | null {
  try {
    const store = globalThis.sessionStorage;
    if (!store) return null;
    const value = store.getItem(RETURN_FILE_KEY);
    if (value) store.removeItem(RETURN_FILE_KEY);
    return value ? value : null;
  } catch {
    return null;
  }
}
