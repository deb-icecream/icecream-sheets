/**
 * ETL metadata store tests: recipe persistence, run history, version
 * retention (design-docs/etl-pipeline.md §§4,7).
 */
import { describe, expect, it } from 'vitest';
import {
  createRecipeStore,
  createRunHistoryStore,
  createVersionStore,
  defaultFailurePolicy,
  deserializeRecipes,
  deserializeRuns,
  ETL_RECIPE_VERSION,
  exportRecipe,
  importRecipe,
  makeTable,
  memoryPersistence,
  serializeRecipes,
  serializeRuns,
  targetKey,
  type EtlRecipe,
  type RunRecord,
  KeyManager,
  SERVICE_SCOPE_ID,
  type TableVersion,
} from '../src/index.js';

function makeRecipe(id: string): EtlRecipe {
  return {
    version: ETL_RECIPE_VERSION,
    id,
    name: `Pipeline ${id}`,
    owner: 'debajyoti',
    nodes: [
      { id: 'src', kind: 'source', source: { type: 'csv-text', text: 'a\n1' } },
      {
        id: 'load', kind: 'load',
        target: { kind: 'workbook-table', workbookId: 'w1', sheetName: 'S', tableName: 'T' },
      },
    ],
    edges: [{ from: 'src', to: 'load' }],
    schedule: { trigger: 'manual' },
    failurePolicy: defaultFailurePolicy(),
  };
}

function makeRun(id: string, recipeId: string): RunRecord {
  return {
    id,
    recipeId,
    recipeName: 'P',
    startedAt: '2026-10-18T10:00:00Z',
    finishedAt: '2026-10-18T10:00:01Z',
    status: 'succeeded',
    steps: [],
    rowsLoaded: 10,
    quarantined: [],
  };
}

function makeVersion(versionId: string, savedAt: string): TableVersion {
  return {
    versionId,
    recipeId: 'r1',
    targetKey: 'workbook:w1:S:T',
    target: { kind: 'workbook-table', workbookId: 'w1', sheetName: 'S', tableName: 'T' },
    savedAt,
    table: makeTable(['a'], [[versionId]]),
  };
}

describe('recipe store', () => {
  it('persists recipes across store instances (shared persistence)', () => {
    const p = memoryPersistence();
    const s1 = createRecipeStore(p);
    s1.add(makeRecipe('r1'));
    const s2 = createRecipeStore(p);
    expect(s2.all().map((r) => r.id)).toEqual(['r1']);
  });

  it('export/import round-trips a recipe', () => {
    const r = makeRecipe('r1');
    expect(importRecipe(exportRecipe(r))).toEqual(r);
  });

  it('import rejects invalid recipes', () => {
    expect(() => importRecipe('garbage')).toThrow(/not a valid ETL recipe/);
    const r = makeRecipe('r1');
    r.nodes = [];
    expect(() => importRecipe(exportRecipe(r))).toThrow(/invalid ETL recipe/);
  });

  it('deserializeRecipes drops corrupt entries but keeps good ones', () => {
    const good = makeRecipe('ok');
    const json = JSON.stringify({ version: 1, recipes: [good, { nonsense: true }, null] });
    expect(deserializeRecipes(json).map((r) => r.id)).toEqual(['ok']);
    expect(deserializeRecipes('corrupt')).toEqual([]);
  });

  it('serializeRecipes is stable JSON', () => {
    const json = serializeRecipes([makeRecipe('r1')]);
    expect(JSON.parse(json).recipes).toHaveLength(1);
  });
});

describe('run history store', () => {
  it('records runs and lists them per recipe', () => {
    const p = memoryPersistence();
    const store = createRunHistoryStore(p);
    store.add(makeRun('run1', 'r1'));
    store.add({ ...makeRun('run2', 'r1'), status: 'failed', error: 'boom' });
    store.add(makeRun('run3', 'r2'));
    const r1 = store.all().filter((r) => r.recipeId === 'r1');
    expect(r1.map((r) => r.id)).toEqual(['run1', 'run2']);
    expect(r1[1].error).toBe('boom');
  });

  it('caps history at MAX_RUN_HISTORY', () => {
    const runs: RunRecord[] = [];
    for (let i = 0; i < 510; i++) runs.push(makeRun(`run${i}`, 'r1'));
    const json = serializeRuns(runs);
    expect(deserializeRuns(json)).toHaveLength(500);
    expect(deserializeRuns(json)[0].id).toBe('run10'); // oldest dropped
  });

  it('deserializeRuns tolerates corrupt payloads', () => {
    expect(deserializeRuns('nope')).toEqual([]);
    expect(deserializeRuns('{"runs":[{"id":1}]}')).toEqual([]);
  });
});

function testKeys() {
  return new KeyManager(memoryPersistence());
}

describe('version store', () => {
  it('push prunes to the retention count per target', async () => {
    const store = await createVersionStore(memoryPersistence(), testKeys());
    await store.push(makeVersion('v1', '2026-10-18T10:00:00Z'), 2);
    await store.push(makeVersion('v2', '2026-10-18T10:01:00Z'), 2);
    await store.push(makeVersion('v3', '2026-10-18T10:02:00Z'), 2);
    const vs = await store.versionsFor('workbook:w1:S:T');
    expect(vs.map((v) => v.versionId)).toEqual(['v2', 'v3']);
  });

  it('keeps other targets untouched', async () => {
    const store = await createVersionStore(memoryPersistence(), testKeys());
    await store.push(makeVersion('v1', '2026-10-18T10:00:00Z'), 1);
    await store.push({ ...makeVersion('w1', '2026-10-18T10:00:00Z'), targetKey: 'other' }, 1);
    expect(await store.versionsFor('workbook:w1:S:T')).toHaveLength(1);
    expect(await store.versionsFor('other')).toHaveLength(1);
  });

  it('latestFor returns the newest version', async () => {
    const store = await createVersionStore(memoryPersistence(), testKeys());
    expect(await store.latestFor('workbook:w1:S:T')).toBeNull();
    await store.push(makeVersion('v1', '2026-10-18T10:00:00Z'), 5);
    await store.push(makeVersion('v2', '2026-10-18T10:01:00Z'), 5);
    expect((await store.latestFor('workbook:w1:S:T'))!.versionId).toBe('v2');
    expect((await store.latestForRecipe('r1'))!.versionId).toBe('v2');
    expect(await store.latestForRecipe('nope')).toBeNull();
  });

  it('stored bytes are ciphertext, not plaintext', async () => {
    const persistence = memoryPersistence();
    const store = await createVersionStore(persistence, testKeys());
    await store.push(makeVersion('v1', '2026-10-18T10:00:00Z'), 5);
    const raw = persistence.load(`icecream-sheets.secure.v1/${SERVICE_SCOPE_ID}/icecream-sheets.etl.versions.v1`);
    expect(raw).not.toBeNull();
    // The retained table carries real cell values — none may leak.
    // (The keyId legitimately contains the key version 'v1'; the check
    // targets the *payload* fields.)
    for (const secret of ['workbook:w1:S:T', '"versionId":"v1"', '"recipeId":"r1"']) {
      expect(raw as string).not.toContain(secret);
    }
    const env = JSON.parse(raw as string) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.ciphertext).toBe('string');
  });
});

describe('targetKey', () => {
  it('builds stable keys for both target kinds', () => {
    expect(targetKey({ kind: 'workbook-table', workbookId: 'w', sheetName: 'S', tableName: 'T' }))
      .toBe('workbook:w:S:T');
    expect(targetKey({ kind: 'adapter', adapterId: 'sql' })).toBe('adapter:sql');
  });
});
