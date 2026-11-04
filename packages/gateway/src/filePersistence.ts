/**
 * File-backed Persistence adapter for the gateway's local services
 * (the metadata store's storage-adapter interface from
 * @icecream-sheets/service).
 *
 * Cycle-3 GAP-4 (design-docs/ai-agent.md §9): conversation threads must live
 * in the service metadata store so they survive restarts. The deployed agent
 * service previously passed no threadPersistence, so threads died with the
 * process. This adapter stores one file per metadata-store key under a data
 * directory and is passed as the AgentRuntime's threadPersistence.
 *
 * - Directory: $ICECREAM_DATA_DIR, else ~/.icecream-sheets/data (created on
 *   demand). Tests point the env var at a temp dir.
 * - Filenames are sanitized (keys embed user ids) with a hash suffix so
 *   distinct keys never collide.
 * - Writes are atomic (temp file + rename); load() returns null for a
 *   missing key. The interface is synchronous, matching Persistence.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Persistence } from '@icecream-sheets/service';

/** Env var overriding the gateway data directory. */
export const GATEWAY_DATA_DIR_ENV = 'ICECREAM_DATA_DIR';

/**
 * Resolve (and create) the gateway data directory. Reads the env var on
 * every call so tests can redirect it before the first persistence use.
 */
export function gatewayDataDir(): string {
  const fromEnv = (process.env[GATEWAY_DATA_DIR_ENV] ?? '').trim();
  const dir = fromEnv !== '' ? fromEnv : join(homedir(), '.icecream-sheets', 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One file per key: sanitized name + hash suffix (no collisions). */
export function persistenceFileFor(dir: string, key: string): string {
  const safe = key
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120)
    .replace(/^\.+/, '');
  const hash = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
  return join(dir, `${safe === '' ? 'key' : safe}.${hash}.json`);
}

/**
 * Build a file-backed Persistence rooted at `dir` (default:
 * gatewayDataDir()). Each save() rewrites the whole key file atomically.
 */
export function filePersistence(dir?: string): Persistence {
  const root = dir ?? gatewayDataDir();
  mkdirSync(root, { recursive: true });
  return {
    load: (key: string): string | null => {
      try {
        return readFileSync(persistenceFileFor(root, key), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw e;
      }
    },
    save: (key: string, value: string): void => {
      const target = persistenceFileFor(root, key);
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, value, 'utf8');
      renameSync(tmp, target);
    },
    clear: (key: string): void => {
      try {
        unlinkSync(persistenceFileFor(root, key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      }
    },
  };
}
