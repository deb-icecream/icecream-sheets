/**
 * Prod (Firestore) persistence for the trigger hosting core —
 * the write-through bridge named in hidden_files/triggers/REPORT.md
 * ("HOSTING DESIGN", persistence story, updated by the user's
 * 2026-10-22 scope ruling: the Firestore trigger store is IN SCOPE).
 *
 * Mechanism (locked in the design — follow it, do not reinvent):
 * a write-through cache hydrated at attach. `SessionTriggerHost` and
 * `TriggerRuntime` consume a SYNCHRONOUS `Persistence`; Firestore is
 * async. So at scope-attach time this module:
 *
 *   1. Hydrates both scoped keys through `AsyncMetadataStore` over the
 *      injected `AsyncPersistence` (in prod: a
 *      `FirestoreMetadataPersistence` in the triggers collection):
 *        - `${scope}::${TRIGGER_STORE_KEY}`  → TriggerSpec[]
 *        - `${scope}::${TRIGGER_GRANTS_KEY}` → TriggerGrantRecord[]
 *   2. Seeds a synchronous in-memory facade with the EXACT serialized
 *      strings the sync stores/grants code produce, so the sync side
 *      reads its local copy at full speed.
 *   3. Every facade save/clear updates the local copy AND writes
 *      through to the async persistence on a tracked promise chain.
 *      The supervisor awaits `flush()` after CRUD calls and before
 *      detach; a failed write makes `flush()` REJECT — failures are
 *      loud at the caller's boundary, never silently swallowed, and a
 *      failed write poisons subsequent `flush()` calls until a later
 *      write to the same key succeeds.
 *
 * Hydration honesty: the facade only knows the two hydrated keys.
 * Loading (or writing) any other key throws loudly — an unhydrated
 * key must never silently read as empty.
 *
 * Consistency story (from the design): the writer for a file's
 * specs/grants is the one supervisor that has that file's live session
 * attached (the session registry guarantees one live session owner).
 *
 * Node-only (it constructs the Firestore client in prod). Import from
 * '@icecream-sheets/service/automation-firestore-node', never from the
 * browser bundle.
 */

import type { Persistence } from '../metadataStore.js';
import {
  AsyncMetadataStore,
  type AsyncPersistence,
} from '../secureStore.js';
import {
  FirestoreMetadataPersistence,
  type FirestoreDbLike,
} from '../firestoreMetadata.js';
import {
  TRIGGER_STORE_KEY,
  deserializeTriggers,
  serializeTriggers,
  type TriggerSpec,
} from './triggerSpecs.js';
import { TRIGGER_GRANTS_KEY, type TriggerGrantRecord } from './host.js';

/** Firestore collection holding trigger metadata documents. */
export const TRIGGER_METADATA_COLLECTION = 'icecream_trigger_metadata';

/** A hydrated sync persistence facade plus its write-through drain. */
export interface TriggerScopePersistence {
  persistence: Persistence;
  flush(): Promise<void>;
  /**
   * Re-hydrate the cache from the async persistence (picking up
   * writes made by other processes sharing the store). Local writes
   * still queued on the write-through chain are drained first; a
   * poisoned (failed) write skips the refresh — that failure is
   * surfaced loudly at the CRUD boundary instead.
   */
  refresh(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Grant-record serialization (mirrors SessionTriggerHost's grants code:
// a bare JSON array, shape-filtered on read)
// ---------------------------------------------------------------------------

function serializeGrantRecords(records: TriggerGrantRecord[]): string {
  return JSON.stringify(records);
}

function deserializeGrantRecords(json: string): TriggerGrantRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (r): r is TriggerGrantRecord =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as TriggerGrantRecord).triggerId === 'string' &&
      typeof (r as TriggerGrantRecord).grantedBy === 'string' &&
      typeof (r as TriggerGrantRecord).at === 'string',
  );
}

// ---------------------------------------------------------------------------
// Write-through bridge
// ---------------------------------------------------------------------------

/**
 * Hydrate the trigger scope (specs + grant records) from an async
 * persistence and return the synchronous write-through facade the
 * hosting core consumes.
 */
export async function createTriggerScopePersistence(
  deps: { persistence: AsyncPersistence },
  scope: string,
  opts: { extraKeys?: string[] } = {},
): Promise<TriggerScopePersistence> {
  if (!deps?.persistence) {
    throw new Error('hostFirestore: AsyncPersistence is required');
  }
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new Error('hostFirestore: scope must be a non-empty string');
  }
  const asyncPersistence = deps.persistence;
  const triggersKey = `${scope}::${TRIGGER_STORE_KEY}`;
  const grantsKey = `${scope}::${TRIGGER_GRANTS_KEY}`;
  const knownKeys = new Set<string>([triggersKey, grantsKey]);
  // Caller-hydrated extra keys (full key strings, already scoped by the
  // caller — e.g. the supervisor's per-entry onOpen-fired record). They
  // hydrate as RAW strings: absent = known-but-empty (load → null),
  // present = the stored string. Keys NOT in the hydrated set keep
  // throwing loudly in the facade below.
  const extraKeys = [...new Set(opts.extraKeys ?? [])].filter(
    (k) => k !== triggersKey && k !== grantsKey,
  );
  for (const k of extraKeys) knownKeys.add(k);

  // Hydrate both stores from the async persistence.
  const triggerStore = new AsyncMetadataStore<TriggerSpec>(
    triggersKey,
    asyncPersistence,
    serializeTriggers,
    deserializeTriggers,
  );
  const grantStore = new AsyncMetadataStore<TriggerGrantRecord>(
    grantsKey,
    asyncPersistence,
    serializeGrantRecords,
    deserializeGrantRecords,
  );
  const [triggers, grants] = await Promise.all([triggerStore.all(), grantStore.all()]);

  // Seed the sync facade with the exact serialized strings the sync
  // MetadataStore / grants code expects.
  const cache = new Map<string, string>();
  cache.set(triggersKey, serializeTriggers(triggers));
  cache.set(grantsKey, serializeGrantRecords(grants));
  // Extra keys hydrate raw; an absent key stays unseeded (facade load
  // returns null for a known key with no cached value).
  for (const k of extraKeys) {
    const raw = await asyncPersistence.load(k);
    if (raw !== null) cache.set(k, raw);
  }

  // Tracked write-through chain. A failure is sticky: it poisons
  // flush() until a later write to the same key succeeds.
  let chain: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  let failureKey: string | null = null;

  const enqueue = (key: string, op: () => Promise<void>): void => {
    chain = chain.then(async () => {
      try {
        await op();
        if (failureKey === key) {
          failure = null;
          failureKey = null;
        }
      } catch (e) {
        if (failure === null) {
          failure = e;
          failureKey = key;
        }
      }
    });
  };

  const assertHydrated = (key: string): void => {
    if (!knownKeys.has(key)) {
      throw new Error(
        `hostFirestore: unhydrated key "${key}" for trigger scope "${scope}" — ` +
          `refusing to treat an unhydrated key as empty (fail closed)`,
      );
    }
  };

  const persistence: Persistence = {
    load: (key: string): string | null => {
      assertHydrated(key);
      return cache.get(key) ?? null;
    },
    save: (key: string, value: string): void => {
      assertHydrated(key);
      cache.set(key, value);
      enqueue(key, () => asyncPersistence.save(key, value));
    },
    clear: (key: string): void => {
      assertHydrated(key);
      cache.delete(key);
      enqueue(key, () => asyncPersistence.clear(key));
    },
  };

  const flush = async (): Promise<void> => {
    await chain;
    if (failure !== null) {
      // Throw the original error (loud, unwrapped when possible) and
      // KEEP it: a subsequent flush() must reject too until a later
      // write to the failed key succeeds.
      throw failure;
    }
  };

  const refresh = async (): Promise<void> => {
    await chain;
    if (failure !== null) return;
    const rehydrate = async (key: string): Promise<void> => {
      const raw = await asyncPersistence.load(key);
      if (raw === null) cache.delete(key);
      else cache.set(key, raw);
    };
    await rehydrate(triggersKey);
    await rehydrate(grantsKey);
    for (const k of extraKeys) await rehydrate(k);
  };

  return { persistence, flush, refresh };
}

// ---------------------------------------------------------------------------
// Prod factory (fail closed — mirrors prodMcpConfig / prodShareConfig)
// ---------------------------------------------------------------------------

/**
 * Read the prod provider's env config; throws a clear fail-closed error
 * when incomplete. TRIGGER_STORE=prod requires GCP_PROJECT_ID
 * (FIRESTORE_DATABASE_ID optional).
 */
export function prodTriggerConfig(env: NodeJS.ProcessEnv): {
  projectId: string;
  databaseId?: string;
} {
  const projectId = (env.GCP_PROJECT_ID ?? '').trim();
  if (!projectId) {
    throw new Error(
      'refusing to start: TRIGGER_STORE=prod requires GCP_PROJECT_ID to be set — ' +
        'refusing to start with a half-configured production trigger store (fail closed)',
    );
  }
  const databaseId = (env.FIRESTORE_DATABASE_ID ?? '').trim() || undefined;
  return { projectId, ...(databaseId ? { databaseId } : {}) };
}

/**
 * Build the prod Firestore-backed trigger scope persistence. The
 * official client loads through a non-literal dynamic import (the
 * TypeScript compiler must not try to resolve it here); a missing
 * package is a fail-closed error — the prod provider must NEVER
 * silently degrade to local or in-memory storage.
 *
 * A fail-fast probe (a single document get) runs before returning, so
 * bad credentials or an unreachable Firestore fail the startup, not
 * the first user request (the prodMcpConfig posture).
 */
export async function createProdTriggerScopePersistence(
  env: NodeJS.ProcessEnv,
  scope: string,
  opts: { extraKeys?: string[] } = {},
): Promise<TriggerScopePersistence> {
  const { projectId, databaseId } = prodTriggerConfig(env);
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  let FirestoreCtor: unknown;
  try {
    ({ Firestore: FirestoreCtor } = await dynamicImport('@google-cloud/firestore'));
  } catch {
    throw new Error(
      'refusing to start: TRIGGER_STORE=prod requires the @google-cloud/firestore package ' +
        '(not installed) — install it or use TRIGGER_STORE=local (fail closed)',
    );
  }
  if (typeof FirestoreCtor !== 'function') {
    throw new Error(
      'refusing to start: TRIGGER_STORE=prod — the @google-cloud/firestore import did not ' +
        'provide a Firestore constructor (fail closed)',
    );
  }
  const db = new (FirestoreCtor as new (opts: Record<string, unknown>) => unknown)({
    projectId,
    ...(databaseId ? { databaseId } : {}),
  });
  // The official client's DocumentReference satisfies FirestoreDbLike
  // structurally (get/set/delete with compatible shapes).
  const persistence = new FirestoreMetadataPersistence(
    db as FirestoreDbLike,
    TRIGGER_METADATA_COLLECTION,
  );
  try {
    await persistence.load('__startup_probe__');
  } catch (e) {
    throw new Error(
      `refusing to start: TRIGGER_STORE=prod — Firestore startup probe failed ` +
        `(project ${projectId}): ${e instanceof Error ? e.message : String(e)} (fail closed)`,
    );
  }
  return createTriggerScopePersistence({ persistence }, scope, opts);
}
