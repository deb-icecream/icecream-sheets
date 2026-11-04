/**
 * Shared browser ETL stores (design-docs/etl-pipeline.md §4, §7).
 *
 * The ETL recipe, run-history, and retained-version stores live in the
 * service metadata store (localStorage-backed in this client). Memoized
 * singletons so the ETL editor and the report refresh path (which runs
 * ETL-backed tables through the pipeline on refresh) share one view of
 * the same persisted state — no stale in-memory caches between them.
 */
import {
  KeyManager,
  createRecipeStore,
  createRunHistoryStore,
  createVersionStore,
  type Persistence,
  type VersionStore,
} from '@icecream-sheets/service';

function localStoragePersistence(): Persistence {
  return {
    load: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    save: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* storage full/blocked */
      }
    },
    clear: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* storage blocked */
      }
    },
  };
}

let persistence: Persistence | null = null;
let recipeStore: ReturnType<typeof createRecipeStore> | null = null;
let runHistoryStore: ReturnType<typeof createRunHistoryStore> | null = null;
let versionStorePromise: Promise<VersionStore> | null = null;

export function etlPersistence(): Persistence {
  if (!persistence) persistence = localStoragePersistence();
  return persistence;
}

export function etlRecipeStore(): ReturnType<typeof createRecipeStore> {
  if (!recipeStore) recipeStore = createRecipeStore(etlPersistence());
  return recipeStore;
}

export function etlRunHistoryStore(): ReturnType<typeof createRunHistoryStore> {
  if (!runHistoryStore) runHistoryStore = createRunHistoryStore(etlPersistence());
  return runHistoryStore;
}

/**
 * Encrypted retained-version store (WebCrypto, so async). One instance per
 * page lifetime; the KeyManager loads the persisted service-scope key, so
 * versions written by the ETL editor stay readable here and vice versa.
 */
export function etlVersionStore(): Promise<VersionStore> {
  if (!versionStorePromise) {
    versionStorePromise = createVersionStore(etlPersistence(), new KeyManager(etlPersistence()));
  }
  return versionStorePromise;
}

/** Shared fetch for ETL URL sources (same behavior as the editor's inline fetch). */
export async function etlFetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
