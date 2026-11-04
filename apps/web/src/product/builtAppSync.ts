/**
 * Built-app sync planning (W4): the pure merge between the client's
 * localStorage app cache and the server-side built-app store for the
 * currently open gateway file.
 *
 * Rules (gateway mode, a file open):
 * - The SERVER list for (user, file) is authoritative: for an app id
 *   present on both sides, the server spec wins in the merged list.
 * - Local apps bound to a DIFFERENT file are never uploaded for this
 *   file and never removed locally — they simply are not this file's
 *   business (the local store is global; other files' apps stay in
 *   the cache so switching files keeps working).
 * - MIGRATION (upload-on-open): local apps missing from the server
 *   list are uploaded so they stop being stranded in one browser:
 *   * stamped apps (`fileId` === open file): uploaded as-is;
 *   * legacy apps (no `fileId` — pre-W4 records): their owning file
 *     cannot be proven from the record, so they upload bound to the
 *     open file ONLY when their bound sheet name exists in the open
 *     workbook, and the uploaded copy is stamped with that fileId.
 *     This heuristic is disclosed in hidden_files/wave-c-fixes/
 *     w4-notes.md; it never fires in local/desktop mode.
 * - Uploads are deduped by app id against the server list.
 *
 * Pure and headless: App.tsx performs the effects (API calls +
 * appStore.saveAll) from the returned plan.
 */
import type { AppSpec } from '@icecream-sheets/service';

export interface BuiltAppSyncPlan {
  /** Local specs to upload to the server for `fileId` (post-stamp). */
  uploads: AppSpec[];
  /**
   * The merged local list: every local app, with server versions
   * substituted for same-id apps, plus server apps not yet local.
   */
  merged: AppSpec[];
}

export function planBuiltAppSync(input: {
  local: AppSpec[];
  server: AppSpec[];
  fileId: string;
  sheetNames: string[];
}): BuiltAppSyncPlan {
  const { local, server, fileId } = input;
  const sheetNames = new Set(input.sheetNames);
  const serverById = new Map(server.map((a) => [a.id, a]));
  const localIds = new Set(local.map((a) => a.id));

  const uploads: AppSpec[] = [];
  for (const app of local) {
    if (serverById.has(app.id)) continue; // already server-side: dedupe
    if (app.fileId === fileId) {
      uploads.push(app);
    } else if (!app.fileId && sheetNames.has(app.dataSource.binding.sheet)) {
      uploads.push({ ...app, fileId });
    }
    // Apps bound to another file, and legacy apps whose sheet is not
    // in this workbook, stay local-only for now.
  }

  const merged: AppSpec[] = local.map((a) => serverById.get(a.id) ?? a);
  for (const app of server) {
    if (!localIds.has(app.id)) merged.push(app);
  }
  return { uploads, merged };
}
