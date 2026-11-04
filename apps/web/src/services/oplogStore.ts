/**
 * Persistence for the cross-tab op log (App.tsx's offline op log).
 *
 * On the WEB, every tab persists its serialized op log under
 * `icecream-sheets.oplog.v1.<tabId>` and registers itself in
 * `icecream-sheets.oplog.tabs.v1`; a mounting tab replays the other
 * registered tabs' logs to catch up (multi-tab convergence + offline /
 * crash recovery for the local workbook).
 *
 * Restore SELECTION semantics (issue #50): a persisted log may only
 * ever be replayed by the web flow above. On DESKTOP nothing is
 * restored from renderer storage: the app is a single-instance shell
 * whose persistence is owned by the main process (revision-model
 * design §§5/11 — main's checkpoint scheduler + save journal), there
 * are no peer tabs, and any op log found in desktop storage is a
 * previous app generation's leftover. Replaying one resurrected a
 * stale workbook at every cold launch (F-PERF-3: the same run-2
 * battery doc repainted behind the load gate forever, because the tab
 * registry was append-only and the logs were never evicted). The
 * desktop boot therefore PURGES the stored logs (purgeStoredOpLogs)
 * and never writes new ones (see logOp in App.tsx).
 *
 * The collab outbound queue is a different key family
 * (`icecream.collab.<fileId>`, services/collabTransport.ts) and is
 * never touched here.
 */

/** Minimal storage surface (localStorage-compatible) for testability. */
export interface OpLogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

import { fileIdFromUrl } from '../product/deepLink';
import { shareIdFromSearch } from '../product/sharesApi';

/**
 * Issue #93: whether this page opens a SERVER-BACKED workbook — a file
 * deep link (`?file=` / `#file=`) or a share link (`?share=`).
 *
 * For such pages the cross-tab op log must NEVER be replayed (mount
 * replay, storage-event replay, or persisted writes): the server
 * session is the authoritative convergence channel (snapshot +
 * /revisions catch-up + SSE deltas), and every op in a stored log was
 * already executed through the server when authored. Replaying the log
 * re-executes superseded generations through the live session — on a
 * refresh the new tabId replays its dead predecessor's whole history
 * (the tab registry is append-only; a refresh mints a fresh random
 * tabId, so the previous page's log always looks like "another tab's"
 * log), the concurrent fire-and-forget executes race the load reads,
 * and the grid paints an intermediate generation — transiently (the
 * owner's #93 flash) or pinned, when a mid-replay read lands after the
 * replay's deltas (refresh-1/2 settled on GEN2, leave-reopen on a
 * GEN3/GEN1 mix in the #93 repro). The log stays a local-workbook
 * mechanism only: pages with no file/share link keep the old behavior
 * exactly. The collab durable queue (`icecream.collab.<fileId>`) is a
 * different key family and is NOT gated here — offline server-file
 * edits still recover through it.
 */
export function isServerBackedLocation(loc: { search?: string; hash?: string }): boolean {
  try {
    return fileIdFromUrl(loc) !== null || shareIdFromSearch(loc.search ?? '') !== null;
  } catch {
    return false;
  }
}

/** localStorage key prefix for one tab's serialized op log. */
export const OPLOG_KEY_PREFIX = 'icecream-sheets.oplog.v1.';
/** localStorage key for the op-log tab registry (JSON string array). */
export const OPLOG_TABS_KEY = 'icecream-sheets.oplog.tabs.v1';

/** The registered op-log tab ids, tolerating a corrupt/absent registry. */
export function readOpLogTabIds(storage: OpLogStorage): string[] {
  try {
    const raw = storage.getItem(OPLOG_TABS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Remove every persisted op log named by the registry, plus the
 * registry itself. Returns the purged tab ids. Only keys enumerated
 * in the registry are removed — no other storage is touched.
 */
export function purgeStoredOpLogs(storage: OpLogStorage): string[] {
  const tabs = readOpLogTabIds(storage);
  for (const t of tabs) {
    try {
      storage.removeItem(OPLOG_KEY_PREFIX + t);
    } catch {
      /* storage unavailable */
    }
  }
  try {
    storage.removeItem(OPLOG_TABS_KEY);
  } catch {
    /* storage unavailable */
  }
  return tabs;
}
