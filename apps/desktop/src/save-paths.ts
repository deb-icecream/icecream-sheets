/**
 * Save-path hardening (GAP-10).
 *
 * `file:saveBytes` accepts a `suggestedPath` from the renderer and writes
 * bytes there. A compromised renderer could hand over an arbitrary absolute
 * path and make the main process write anywhere on disk. The shell therefore
 * only honors a suggested path when it lives inside the directory of the
 * last file the user explicitly picked or saved (via a native dialog or an
 * OS-triggered open). Anything else falls back to the Save dialog.
 *
 * Pure functions (no Electron imports) so they can be unit-tested with node.
 */

import * as path from 'node:path';

/** Directory of a file the user explicitly chose, resolved to an absolute path. */
export function trustedDirOf(filePath: string): string {
  return path.resolve(path.dirname(filePath));
}

/**
 * True when `candidate` resolves to a file inside `trustedDir` (or is
 * `trustedDir` itself — harmless). False when there is no trusted dir yet,
 * or the candidate escapes it (e.g. via `..` segments or an absolute path
 * elsewhere). Resolution first, so `../` traversal cannot smuggle a path out.
 */
export function isPathInsideDir(candidate: string, trustedDir: string | null): boolean {
  if (!trustedDir) return false;
  const resolved = path.resolve(candidate);
  const dir = path.resolve(trustedDir);
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

/**
 * GAP-10 decision for `file:saveBytes`, extracted pure so it can be
 * unit-tested without Electron: honor `suggestedPath` only when it lands
 * inside the trusted directory, otherwise fall back to the native Save
 * dialog. No trusted dir yet → dialog.
 */
export type SaveTarget = { mode: 'direct'; path: string } | { mode: 'dialog' };

export function resolveSaveTarget(
  suggestedPath: string | undefined,
  trustedDir: string | null,
): SaveTarget {
  if (suggestedPath && isPathInsideDir(suggestedPath, trustedDir)) {
    return { mode: 'direct', path: suggestedPath };
  }
  return { mode: 'dialog' };
}
