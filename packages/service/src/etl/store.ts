/**
 * ETL pipeline — service metadata stores.
 *
 * Per design-docs/etl-pipeline.md §4, old loaded versions are retained
 * "according to the retention policy", and §7's editor needs a run history.
 * Recipes, runs and retained versions live in the service metadata store
 * (packages/service/src/metadataStore.ts) — not in the engine, not in the
 * workbook file, not in client component state.
 */

import {
  MetadataStore,
  type Persistence,
} from '../metadataStore.js';
import { KeyManager } from '../crypto.js';
import {
  AsyncMetadataStore,
  EncryptedPersistence,
  SERVICE_SCOPE_ID,
} from '../secureStore.js';
import {
  deserializeRecipe,
  ETL_RECIPE_VERSION,
  migrateRecipe,
  serializeRecipe,
  validateRecipe,
  type EtlRecipe,
  type LoadTarget,
} from './recipe.js';
import type { EtlTable } from './types.js';

// ---------------------------------------------------------------------------
// Shared run types (also used by runner.ts)
// ---------------------------------------------------------------------------

export type RunStatus = 'succeeded' | 'failed' | 'aborted';

export interface QuarantinedRow {
  stepId: string;
  rowIndex: number;
  row: Record<string, string | number | boolean | null>;
  reason: string;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface StoredRecipes {
  version: number;
  recipes: EtlRecipe[];
}

export function serializeRecipes(recipes: EtlRecipe[]): string {
  const stored: StoredRecipes = { version: ETL_RECIPE_VERSION, recipes };
  return JSON.stringify(stored);
}

/** Deserialize; drops corrupt entries, migrates the rest. */
export function deserializeRecipes(json: string): EtlRecipe[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const stored = parsed as Partial<StoredRecipes>;
  if (!Array.isArray(stored.recipes)) return [];
  const out: EtlRecipe[] = [];
  for (const raw of stored.recipes) {
    if (typeof raw !== 'object' || raw === null) continue;
    try {
      const recipe = migrateRecipe(raw as EtlRecipe);
      if (validateRecipe(recipe).length === 0) out.push(recipe);
    } catch {
      // Skip unparseable recipes rather than failing the whole store.
    }
  }
  return out;
}

export function createRecipeStore(persistence: Persistence): MetadataStore<EtlRecipe> {
  return new MetadataStore<EtlRecipe>(
    'icecream-sheets.etl.recipes.v1',
    persistence,
    serializeRecipes,
    deserializeRecipes,
  );
}

/** Round-trip a single recipe through JSON (used by the editor's export). */
export function exportRecipe(recipe: EtlRecipe): string {
  return serializeRecipe(recipe);
}

export function importRecipe(json: string): EtlRecipe {
  const recipe = deserializeRecipe(json);
  if (!recipe) throw new Error('not a valid ETL recipe');
  const issues = validateRecipe(recipe);
  if (issues.length > 0) {
    throw new Error(`invalid ETL recipe: ${issues[0].message}`);
  }
  return recipe;
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export interface RunStepRecord {
  nodeId: string;
  kind: string;
  label: string;
  rowsIn: number;
  rowsOut: number;
  quarantined: number;
  ms: number;
}

export interface RunRecord {
  id: string;
  recipeId: string;
  recipeName: string;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  steps: RunStepRecord[];
  rowsLoaded: number;
  quarantined: QuarantinedRow[];
  error?: string;
}

/** Cap: the history store keeps the most recent N runs overall. */
export const MAX_RUN_HISTORY = 500;

export interface StoredRuns {
  version: number;
  runs: RunRecord[];
}

export function serializeRuns(runs: RunRecord[]): string {
  const stored: StoredRuns = { version: 1, runs: runs.slice(-MAX_RUN_HISTORY) };
  return JSON.stringify(stored);
}

export function deserializeRuns(json: string): RunRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const stored = parsed as Partial<StoredRuns>;
  if (!Array.isArray(stored.runs)) return [];
  return stored.runs.filter(
    (r): r is RunRecord =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as RunRecord).id === 'string' &&
      typeof (r as RunRecord).recipeId === 'string' &&
      Array.isArray((r as RunRecord).steps),
  );
}

export function createRunHistoryStore(persistence: Persistence): MetadataStore<RunRecord> {
  return new MetadataStore<RunRecord>(
    'icecream-sheets.etl.runs.v1',
    persistence,
    serializeRuns,
    deserializeRuns,
  );
}

// ---------------------------------------------------------------------------
// Retained loaded versions (§4: "old versions are retained according to the
// retention policy, and a failed run never replaces the last good load")
// ---------------------------------------------------------------------------

export interface TableVersion {
  versionId: string;
  recipeId: string;
  /** Stable key for the load target (workbookId/sheet/table or adapter id). */
  targetKey: string;
  target: LoadTarget;
  savedAt: string;
  table: EtlTable;
}

export function targetKey(target: LoadTarget): string {
  return target.kind === 'workbook-table'
    ? `workbook:${target.workbookId}:${target.sheetName}:${target.tableName}`
    : `adapter:${target.adapterId}`;
}

export interface StoredVersions {
  version: number;
  versions: TableVersion[];
}

export function serializeVersions(versions: TableVersion[]): string {
  const stored: StoredVersions = { version: 1, versions };
  return JSON.stringify(stored);
}

export function deserializeVersions(json: string): TableVersion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const stored = parsed as Partial<StoredVersions>;
  if (!Array.isArray(stored.versions)) return [];
  return stored.versions.filter(
    (v): v is TableVersion =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as TableVersion).versionId === 'string' &&
      typeof (v as TableVersion).targetKey === 'string' &&
      typeof (v as TableVersion).table === 'object',
  );
}

/** Version store with retention pruning per target, encrypted at rest.
 *
 * Retained tables may contain full copies of loaded data — they are
 * persisted through EncryptedPersistence (§3) under the service scope key
 * (§7). Use the async `createVersionStore()` factory: reads/writes are
 * async because WebCrypto is.
 */
export class VersionStore {
  private readonly store: AsyncMetadataStore<TableVersion>;

  private constructor(store: AsyncMetadataStore<TableVersion>) {
    this.store = store;
  }

  /**
   * Build an encrypted version store (§3: retained tables are encrypted at
   * rest under the service scope key, §7). Fail-closed on tampered
   * envelopes.
   */
  static async create(persistence: Persistence, keys: KeyManager): Promise<VersionStore> {
    if (!persistence) throw new Error('etl: persistence adapter is required');
    if (!keys) throw new Error('etl: KeyManager is required');
    const ep = await EncryptedPersistence.create(persistence, keys, SERVICE_SCOPE_ID);
    const store = new AsyncMetadataStore<TableVersion>(
      'icecream-sheets.etl.versions.v1',
      ep,
      serializeVersions,
      deserializeVersions,
    );
    return new VersionStore(store);
  }

  /** Push a version, then prune to the newest `keep` for that target. */
  async push(version: TableVersion, keep: number): Promise<void> {
    const all = await this.store.all();
    const others = all.filter((v) => v.targetKey !== version.targetKey);
    const same = [...all.filter((v) => v.targetKey === version.targetKey), version]
      .sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1))
      .slice(-Math.max(keep, 0));
    await this.store.saveAll([...others, ...same]);
  }

  async versionsFor(targetKey: string): Promise<TableVersion[]> {
    return (await this.store.all())
      .filter((v) => v.targetKey === targetKey)
      .sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1));
  }

  async latestFor(targetKey: string): Promise<TableVersion | null> {
    const vs = await this.versionsFor(targetKey);
    return vs.length === 0 ? null : vs[vs.length - 1];
  }

  /** Latest retained version loaded by a given recipe (any target). */
  async latestForRecipe(recipeId: string): Promise<TableVersion | null> {
    const vs = (await this.store.all())
      .filter((v) => v.recipeId === recipeId)
      .sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1));
    return vs.length === 0 ? null : vs[vs.length - 1];
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }
}

export async function createVersionStore(
  persistence: Persistence,
  keys: KeyManager,
): Promise<VersionStore> {
  return VersionStore.create(persistence, keys);
}
