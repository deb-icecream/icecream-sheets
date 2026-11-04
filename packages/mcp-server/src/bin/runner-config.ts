/**
 * Runner configuration for the shipped MCP HTTP bin (src/bin/http.ts).
 *
 * Pure and unit-testable: resolveRunnerConfig(env) validates the
 * environment and builds the options the bin passes to startMcpHttp.
 * The bin calls it BEFORE listening and exits 1 on any error thrown
 * here — the shipped runner fails closed, never silently insecure or
 * silently ephemeral.
 *
 * Auth posture: requireAuth is ALWAYS true in the shipped runner.
 * There is NO anonymous escape hatch in the bin: no design doc
 * sanctions one for the shipped runner, and desktop does not use this
 * bin (apps/desktop/src/mcp.ts calls the library startMcpHttp directly
 * with its own MCP_REQUIRE_AUTH). The library default in src/http.ts
 * (requireAuth: false, for local-dev embedding) is unchanged.
 *
 * Persistence: mirrors the codebase's SESSION_STORE /
 * FILE_REGISTRY_STORE env-selector pattern (MCP_STORE).
 * - MCP_STORE=local (or unset): file-backed sync Persistence, bridged
 *   to async at the server layer via toAsyncPersistence.
 * - MCP_STORE=prod: Firestore-backed native AsyncPersistence
 *   (FirestoreMetadataPersistence over @google-cloud/firestore),
 *   injected as options.asyncPersistence. Fails closed when
 *   misconfigured — never silently ephemeral.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AsyncPersistence,
  type Persistence,
} from '@icecream-sheets/service';
import {
  FirestoreMetadataPersistence,
  MCP_METADATA_COLLECTION,
  type FirestoreDbLike,
} from '@icecream-sheets/service/firestore-node';
import { packsFromEnv, resolveSkillPacks } from '../packs/index.js';

export interface RunnerConfig {
  /** Always true in the shipped runner — see module header. */
  requireAuth: true;
  /** The MCP_AUTH_SECRET value, passed through verbatim for token verification. */
  authSecret: string;
  /** Sync persistence (local file mode). Undefined in prod. */
  persistence?: Persistence;
  /** Native async persistence (prod Firestore mode). Undefined in local. */
  asyncPersistence?: AsyncPersistence;
  /** Selected store provider. */
  store: 'local' | 'prod';
  /** Data directory backing the local store ('' in prod). */
  dataDir: string;
  /**
   * Skill-pack selection from MCP_PACKS (comma-separated pack ids).
   * Undefined → every bundled pack is installed. Validated here so an
   * unknown id fails startup, not the first session (fail closed).
   */
  packs?: string[];
}

/**
 * Parse + validate the MCP_PACKS selection. Throws a fail-closed
 * error naming the bundled packs when an id is unknown.
 */
export function resolvePacks(env: NodeJS.ProcessEnv): string[] | undefined {
  const packs = packsFromEnv(env.MCP_PACKS);
  if (packs !== undefined) {
    try {
      resolveSkillPacks(packs);
    } catch (e) {
      throw new Error(
        `refusing to start: invalid MCP_PACKS — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return packs;
}

/**
 * Resolve the MCP data directory (without creating it):
 *   1. MCP_DATA_DIR, when set (non-empty)
 *   2. $ICECREAM_DATA_DIR/mcp, when ICECREAM_DATA_DIR is set (non-empty)
 *   3. ~/.icecream-sheets/data/mcp
 */
export function resolveMcpDataDir(env: NodeJS.ProcessEnv): string {
  const fromMcp = (env.MCP_DATA_DIR ?? '').trim();
  if (fromMcp !== '') return fromMcp;
  const fromIcecream = (env.ICECREAM_DATA_DIR ?? '').trim();
  if (fromIcecream !== '') return join(fromIcecream, 'mcp');
  return join(homedir(), '.icecream-sheets', 'data', 'mcp');
}

/** One file per key: sanitized name + 16-char sha256 suffix (no collisions). */
export function persistenceFileFor(dir: string, key: string): string {
  const safe = key
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120)
    .replace(/^\.+/, '');
  const hash = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
  return join(dir, `${safe === '' ? 'key' : safe}.${hash}.json`);
}

/**
 * File-backed Persistence factory implementing the
 * @icecream-sheets/service Persistence seam.
 *
 * Adapter semantics mirror packages/gateway/src/filePersistence.ts
 * exactly: one file per key; sanitized name + 16-char sha256 suffix;
 * atomic tmp+rename writes; ENOENT load → null.
 *
 * Implemented here inside src/bin/ — do NOT import from the gateway
 * package: gateway depends on mcp-server, so that import would be
 * circular.
 */
export function createFilePersistence(dir: string): Persistence {
  mkdirSync(dir, { recursive: true });
  return {
    load: (key: string): string | null => {
      try {
        return readFileSync(persistenceFileFor(dir, key), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw e;
      }
    },
    save: (key: string, value: string): void => {
      const target = persistenceFileFor(dir, key);
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, value, 'utf8');
      renameSync(tmp, target);
    },
    clear: (key: string): void => {
      try {
        unlinkSync(persistenceFileFor(dir, key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      }
    },
  };
}

/** Alias matching the gateway adapter's factory name. */
export const filePersistence = createFilePersistence;

/**
 * Read the prod provider's env config; throws a clear fail-closed error
 * when incomplete. Mirrors the gateway's prodSessionConfig pattern
 * (packages/gateway/src/deploy/sessionStore.ts).
 */
export function prodMcpConfig(env: NodeJS.ProcessEnv): { projectId: string; databaseId?: string } {
  const projectId = (env.GCP_PROJECT_ID ?? '').trim();
  if (!projectId) {
    throw new Error(
      'refusing to start: MCP_STORE=prod requires GCP_PROJECT_ID to be set — ' +
        'refusing to start with a half-configured production metadata store (fail closed)',
    );
  }
  const databaseId = (env.FIRESTORE_DATABASE_ID ?? '').trim() || undefined;
  return { projectId, databaseId };
}

/**
 * Build the prod Firestore-backed AsyncPersistence. The official client
 * loads through a non-literal dynamic import (the TypeScript compiler
 * must not try to resolve it here); a missing package becomes the
 * fail-closed runtime error below — the prod provider must NEVER
 * silently degrade to local storage.
 *
 * A fail-fast probe (a single document get) runs before returning, so
 * bad credentials or an unreachable Firestore fail the startup, not the
 * first user request.
 */
export async function createProdPersistence(env: NodeJS.ProcessEnv): Promise<AsyncPersistence> {
  const { projectId, databaseId } = prodMcpConfig(env);
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  let FirestoreCtor: unknown;
  try {
    ({ Firestore: FirestoreCtor } = await dynamicImport('@google-cloud/firestore'));
  } catch {
    throw new Error(
      'refusing to start: MCP_STORE=prod requires the @google-cloud/firestore package ' +
        '(not installed) — install it or use MCP_STORE=local (fail closed)',
    );
  }
  if (typeof FirestoreCtor !== 'function') {
    throw new Error(
      'refusing to start: MCP_STORE=prod — the @google-cloud/firestore import did not ' +
        'provide a Firestore constructor (fail closed)',
    );
  }
  const db = new (FirestoreCtor as new (opts: Record<string, unknown>) => unknown)({
    projectId,
    ...(databaseId ? { databaseId } : {}),
  });
  // The official client's DocumentReference satisfies FirestoreDbLike
  // structurally (get/set/delete with compatible shapes).
  const persistence = new FirestoreMetadataPersistence(db as FirestoreDbLike);
  try {
    await persistence.load('__startup_probe__');
  } catch (e) {
    throw new Error(
      `refusing to start: MCP_STORE=prod — Firestore startup probe failed ` +
        `(project ${projectId}): ${e instanceof Error ? e.message : String(e)} (fail closed)`,
    );
  }
  return persistence;
}

/**
 * Validate env and build the shipped runner's configuration.
 * Async: the prod branch constructs the Firestore client.
 * Throws a clear, fail-closed error on any misconfiguration; the bin
 * prints it to stderr and exits 1 before listening.
 */
export async function resolveRunnerConfig(env: NodeJS.ProcessEnv): Promise<RunnerConfig> {
  const rawSecret = env.MCP_AUTH_SECRET ?? '';
  if (rawSecret.trim() === '') {
    throw new Error(
      'refusing to start: MCP_AUTH_SECRET is not set — the shipped MCP runner always enforces its own Bearer auth ' +
        '(design-docs/deployment-architecture.md: MCP direct ingress with self-authentication). ' +
        'Set MCP_AUTH_SECRET to a real secret, or for local dev any throwaway value.',
    );
  }
  const authSecret = rawSecret;

  const packs = resolvePacks(env);

  const rawStore = (env.MCP_STORE ?? '').trim();
  const storeNorm = rawStore.toLowerCase();
  if (storeNorm === 'prod') {
    const asyncPersistence = await createProdPersistence(env);
    return { requireAuth: true, authSecret, asyncPersistence, store: 'prod', dataDir: '', packs };
  }
  if (storeNorm !== '' && storeNorm !== 'local') {
    throw new Error(
      `refusing to start: unknown MCP_STORE value "${rawStore}" — expected "local" (or unset) or "prod".`,
    );
  }

  const dataDir = resolveMcpDataDir(env);
  const persistence = createFilePersistence(dataDir);
  return { requireAuth: true, authSecret, persistence, store: 'local', dataDir, packs };
}

// Re-exported for the startup log (which collection the prod probe touches).
export { MCP_METADATA_COLLECTION };
