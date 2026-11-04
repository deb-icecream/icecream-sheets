/**
 * Per-user simultaneous-open cap (design doc §9A, owner ruling
 * 2026-10-23): a user may hold at most MAX_OPEN_FILES_PER_USER
 * distinct files open at once across all their client instances and
 * devices. Opening one more distinct file silently evicts the user
 * from their least recently used open file.
 *
 * This module holds the SETTING and the pure derivation helpers. The
 * enforcement itself lives in the gateway's open handler
 * (src/gateway.ts), which derives the opener's live open set at open
 * time from the two existing sources of truth — the file registry
 * (which files are live, and where) and each owning engine's
 * /session/status (who is attached, and when they were last active).
 * Nothing here is stored: a derived set cannot drift on unsignaled
 * exits (crashes, idle releases, re-ownership), which is exactly the
 * class of event a stored per-user set would get wrong.
 */

/** The cap when MAX_OPEN_FILES_PER_USER is unset or invalid. */
export const DEFAULT_MAX_OPEN_FILES_PER_USER = 4;

/**
 * MAX_OPEN_FILES_PER_USER: the per-user simultaneous-open cap. A
 * finite integer ≥ 1 wins; anything else falls back to the default —
 * a malformed value must never disable the cap or make it zero.
 */
export function maxOpenFilesPerUser(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MAX_OPEN_FILES_PER_USER ?? '');
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1
    ? n
    : DEFAULT_MAX_OPEN_FILES_PER_USER;
}

/** The slice of an engine /session/status payload the derivation reads. */
export interface EngineStatusLike {
  attachedClientCount?: unknown;
  attachedClientsByPrincipal?: unknown;
}

/** One file in a user's derived live open set. */
export interface UserOpenFileEntry {
  fileId: string;
  sessionId: string;
  ownerEndpoint: string;
  /** The principal's attached client-instance ids on this session. */
  instances: string[];
  /** The principal's last activity on this file (unix ms; 0 = none recorded). */
  lastActivityAt: number;
  /** TOTAL attached instances on the session (all principals). */
  totalAttached: number;
}

/**
 * Aggregate per-file engine statuses into ONE principal's open set:
 * exactly the files where that principal currently holds at least one
 * attached client instance. Two instances on one file produce ONE
 * entry (the cap counts distinct files, §9A).
 */
export function userOpenSetFromStatuses(
  statuses: Array<{
    fileId: string;
    sessionId: string;
    ownerEndpoint: string;
    status: EngineStatusLike;
  }>,
  principal: string,
): UserOpenFileEntry[] {
  const out: UserOpenFileEntry[] = [];
  for (const { fileId, sessionId, ownerEndpoint, status } of statuses) {
    const byPrincipal = status.attachedClientsByPrincipal;
    if (!byPrincipal || typeof byPrincipal !== 'object') continue;
    const mine = (byPrincipal as Record<string, unknown>)[principal];
    if (!mine || typeof mine !== 'object') continue;
    const instancesRaw = (mine as { instances?: unknown }).instances;
    const instances = Array.isArray(instancesRaw)
      ? instancesRaw.filter((x): x is string => typeof x === 'string')
      : [];
    if (instances.length === 0) continue;
    const lastRaw = (mine as { lastActivityAt?: unknown }).lastActivityAt;
    const totalRaw = status.attachedClientCount;
    out.push({
      fileId,
      sessionId,
      ownerEndpoint,
      instances,
      lastActivityAt:
        typeof lastRaw === 'number' && Number.isFinite(lastRaw) ? lastRaw : 0,
      totalAttached:
        typeof totalRaw === 'number' && Number.isFinite(totalRaw)
          ? totalRaw
          : instances.length,
    });
  }
  return out;
}

/**
 * The least recently used entry: smallest lastActivityAt; ties break
 * to the lexicographically smaller fileId so the choice is
 * deterministic (and unit-pinnable) rather than map-order dependent.
 */
export function pickLru(entries: UserOpenFileEntry[]): UserOpenFileEntry | null {
  let best: UserOpenFileEntry | null = null;
  for (const e of entries) {
    if (
      !best ||
      e.lastActivityAt < best.lastActivityAt ||
      (e.lastActivityAt === best.lastActivityAt && e.fileId < best.fileId)
    ) {
      best = e;
    }
  }
  return best;
}
