/**
 * ETL runner tests (design-docs/etl-pipeline.md §§1,4,5,6):
 * execution, retry with backoff, quarantine, error thresholds,
 * atomic load + version retention, run records, progress events.
 */
import { describe, expect, it } from 'vitest';
import {
  KeyManager,
  createVersionStore,
  defaultFailurePolicy,
  ETL_RECIPE_VERSION,
  isTransientError,
  makeTable,
  makeVersionStoreResolver,
  memoryPersistence,
  runRecipe,
  type EtlRecipe,
  type EtlTable,
  type LoadTarget,
  type ProgressEvent,
  type RunnerDeps,
  type TableWriter,
  type TransformOp,
} from '../src/index.js';

const TARGET: LoadTarget = {
  kind: 'workbook-table', workbookId: 'w1', sheetName: 'Sheet1', tableName: 'Sales',
};

function recipe(csv = 'a,b\n1,x\n2,y', transforms: Extract<EtlRecipe['nodes'][number], { kind: 'transform' }>[] = []): EtlRecipe {
  const ids = ['src', ...transforms.map((t) => t.id), 'load'];
  return {
    version: ETL_RECIPE_VERSION,
    id: 'r1',
    name: 'Test pipeline',
    owner: 'debajyoti',
    nodes: [
      { id: 'src', kind: 'source', source: { type: 'csv-text', text: csv } },
      ...transforms,
      { id: 'load', kind: 'load', target: TARGET, retention: 2 },
    ],
    edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })),
    schedule: { trigger: 'manual' },
    failurePolicy: defaultFailurePolicy(),
  };
}

/** Minimal transform-node factory. */
function step(id: string, transform: TransformOp): Extract<EtlRecipe['nodes'][number], { kind: 'transform' }> {
  return { id, kind: 'transform', transform };
}

class MemoryWriter implements TableWriter {
  written: { target: LoadTarget; table: EtlTable }[] = [];
  current: EtlTable | null = null;
  failNextWrite: string | null = null;

  async writeAtomic(target: LoadTarget, table: EtlTable): Promise<void> {
    if (this.failNextWrite) {
      const msg = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(msg); // previous table untouched: all-or-nothing
    }
    this.written.push({ target, table });
    this.current = table;
  }

  async readCurrent(): Promise<EtlTable | null> {
    return this.current;
  }
}

function deps(writer: MemoryWriter, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    fetchText: async () => { throw new Error('no network'); },
    writer,
    sleep: async () => {},
    now: () => new Date('2026-10-18T10:00:00Z'),
    ...overrides,
  };
}

describe('runRecipe happy path', () => {
  it('runs source -> transforms -> atomic load and emits a change event', async () => {
    const writer = new MemoryWriter();
    const changes: { rows: number }[] = [];
    const progress: ProgressEvent[] = [];
    const r = recipe('a,b\n1,x\n2,y', [
      step('t0', { op: 'filter', column: 'a', operator: 'eq', value: '1' }),
    ]);
    const run = await runRecipe(r, deps(writer, {
      onChange: (e) => { changes.push(e); },
      onProgress: (e) => { progress.push(e); },
    }));
    expect(run.status).toBe('succeeded');
    expect(run.rowsLoaded).toBe(1);
    expect(run.steps.map((s) => s.kind)).toEqual(['source', 'filter', 'load']);
    expect(run.steps[1]).toMatchObject({ rowsIn: 2, rowsOut: 1, quarantined: 0 });
    expect(writer.written).toHaveLength(1);
    expect(writer.written[0].table.rows).toEqual([{ a: '1', b: 'x' }]);
    expect(changes).toHaveLength(1);
    expect(changes[0].rows).toBe(1);
    expect(progress.filter((p) => p.phase === 'done')).toHaveLength(3);
    expect(run.error).toBeUndefined();
  });

  it('throws for an invalid recipe instead of returning a failed run', async () => {
    const writer = new MemoryWriter();
    const r = recipe();
    r.nodes = r.nodes.filter((n) => n.kind !== 'load');
    await expect(runRecipe(r, deps(writer))).rejects.toThrow(/invalid recipe/);
    expect(writer.written).toHaveLength(0);
  });

  it('denies the run when the permission check throws', async () => {
    const writer = new MemoryWriter();
    const run = await runRecipe(recipe(), deps(writer, {
      checkPermission: async () => { throw new Error('denied: no write on target'); },
    })).catch((e: unknown) => e);
    expect(run).toBeInstanceOf(Error);
    expect(writer.written).toHaveLength(0);
  });
});

describe('retry with backoff', () => {
  it('retries transient source failures with exponential backoff', async () => {
    const writer = new MemoryWriter();
    const delays: number[] = [];
    let calls = 0;
    const r = recipe();
    r.nodes[0] = {
      id: 'src', kind: 'source',
      source: { type: 'url', url: 'https://x/data.csv', format: 'csv' },
    };
    r.failurePolicy = { ...defaultFailurePolicy(), maxRetries: 3, backoffBaseMs: 100, backoffMultiplier: 2 };
    const run = await runRecipe(r, deps(writer, {
      fetchText: async () => {
        calls++;
        if (calls < 3) throw new Error('socket hang up');
        return 'a\n1';
      },
      sleep: async (ms) => { delays.push(ms); },
    }));
    expect(run.status).toBe('succeeded');
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]); // base * mult^attempt
  });

  it('gives up after maxRetries and reports the failure', async () => {
    const writer = new MemoryWriter();
    const r = recipe();
    r.nodes[0] = {
      id: 'src', kind: 'source',
      source: { type: 'url', url: 'https://x/down', format: 'csv' },
    };
    r.failurePolicy = { ...defaultFailurePolicy(), maxRetries: 1, backoffBaseMs: 10 };
    const run = await runRecipe(r, deps(writer, {
      fetchText: async () => { throw new Error('socket hang up'); },
    }));
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/socket hang up/);
    expect(writer.written).toHaveLength(0);
  });

  it('does not retry permanent errors', async () => {
    const writer = new MemoryWriter();
    let calls = 0;
    const r = recipe();
    r.nodes[0] = {
      id: 'src', kind: 'source',
      source: { type: 'url', url: 'https://x/data.csv', format: 'csv' },
    };
    const run = await runRecipe(r, deps(writer, {
      fetchText: async () => { calls++; throw new Error('HTTP 404 not found'); },
    }));
    expect(run.status).toBe('failed');
    expect(calls).toBe(1);
  });

  it('isTransientError classifies correctly', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('HTTP 503 unavailable'))).toBe(true);
    expect(isTransientError(new Error('HTTP 404 not found'))).toBe(false);
    expect(isTransientError(new Error('unknown column "x"'))).toBe(false);
  });
});

describe('quarantine and error thresholds', () => {
  const badCsv = 'n\n1\nnope\n3\nnah';

  it('quarantines failing rows with reasons and loads the rest', async () => {
    const writer = new MemoryWriter();
    const r = recipe(badCsv, [step('t0', { op: 'convert', column: 'n', to: 'number' })]);
    r.failurePolicy = { ...defaultFailurePolicy(), errorThresholdPct: 100 };
    const run = await runRecipe(r, deps(writer));
    expect(run.status).toBe('succeeded');
    expect(run.quarantined).toHaveLength(2);
    expect(run.quarantined[0]).toMatchObject({ stepId: 't0', rowIndex: 1 });
    expect(run.quarantined[0].reason).toMatch(/cannot convert/);
    expect(run.steps[1].quarantined).toBe(2);
    expect(writer.written[0].table.rows.map((x) => x['n'])).toEqual([1, null, 3, null]);
  });

  it('aborts when the error threshold percent is exceeded (no load)', async () => {
    const writer = new MemoryWriter();
    const r = recipe(badCsv, [step('t0', { op: 'convert', column: 'n', to: 'number' })]);
    r.failurePolicy = { ...defaultFailurePolicy(), errorThresholdPct: 5 };
    const run = await runRecipe(r, deps(writer));
    expect(run.status).toBe('aborted');
    expect(run.error).toMatch(/error threshold exceeded/);
    expect(writer.written).toHaveLength(0); // previous table preserved
    expect(run.rowsLoaded).toBe(0);
  });

  it('aborts when maxErrorRows is exceeded', async () => {
    const writer = new MemoryWriter();
    const r = recipe(badCsv, [step('t0', { op: 'convert', column: 'n', to: 'number' })]);
    r.failurePolicy = { ...defaultFailurePolicy(), maxErrorRows: 1, errorThresholdPct: undefined };
    const run = await runRecipe(r, deps(writer));
    expect(run.status).toBe('aborted');
    expect(writer.written).toHaveLength(0);
  });

  it('fails the run (no quarantine) when quarantine is disabled', async () => {
    const writer = new MemoryWriter();
    const r = recipe(badCsv, [step('t0', { op: 'convert', column: 'n', to: 'number' })]);
    r.failurePolicy = { ...defaultFailurePolicy(), quarantine: false };
    const run = await runRecipe(r, deps(writer));
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/transform "t0" failed on row 1/);
    expect(writer.written).toHaveLength(0);
  });

  it('fails on an unknown column (permanent, no retry)', async () => {
    const writer = new MemoryWriter();
    const r = recipe('a\n1', [step('t0', { op: 'filter', column: 'nope', operator: 'eq', value: 1 })]);
    const run = await runRecipe(r, deps(writer));
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/unknown column "nope"/);
  });
});

describe('atomic load and version retention', () => {
  it('retains the previous table before swapping, pruned to retention N', async () => {
    const persistence = memoryPersistence();
    const versions = await createVersionStore(persistence, new KeyManager(memoryPersistence()));
    const writer = new MemoryWriter();
    writer.current = makeTable(['a'], [['old1']]);

    const d = deps(writer, { versions });
    await runRecipe(recipe('a\nnew1'), d); // retains old1
    writer.current = makeTable(['a'], [['new1']]);
    await runRecipe(recipe('a\nnew2'), d); // retains new1
    writer.current = makeTable(['a'], [['new2']]);
    await runRecipe(recipe('a\nnew3'), d); // retains new2, prunes old1 (retention 2)

    const vs = await versions.versionsFor('workbook:w1:Sheet1:Sales');
    expect(vs.map((v) => v.table.rows[0]['a'])).toEqual(['new1', 'new2']);
  });

  it('a failed load never replaces the last good table', async () => {
    const persistence = memoryPersistence();
    const versions = await createVersionStore(persistence, new KeyManager(memoryPersistence()));
    const writer = new MemoryWriter();
    const good = makeTable(['a'], [['good']]);
    writer.current = good;
    writer.failNextWrite = 'engine transaction aborted';

    const run = await runRecipe(recipe('a\nbad'), deps(writer, { versions }));
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/previous table preserved/);
    expect(writer.current).toBe(good); // untouched
    // The retained version captured the pre-swap table, not the failed one.
    const vs = await versions.versionsFor('workbook:w1:Sheet1:Sales');
    expect(vs).toHaveLength(1);
    expect(vs[0].table.rows[0]['a']).toBe('good');
  });

  it('resolves { kind: "recipe" } table refs from retained versions', async () => {
    const persistence = memoryPersistence();
    const versions = await createVersionStore(persistence, new KeyManager(memoryPersistence()));
    await versions.push(
      {
        versionId: 'v1', recipeId: 'other', targetKey: 'workbook:w1:S:T',
        target: TARGET, savedAt: '2026-10-18T09:00:00Z',
        table: makeTable(['k', 'v'], [['a', 1]]),
      },
      5,
    );
    const resolver = makeVersionStoreResolver(versions);
    const t = await resolver({ kind: 'recipe', recipeId: 'other' });
    expect(t.rows).toEqual([{ k: 'a', v: 1 }]);
    await expect(resolver({ kind: 'recipe', recipeId: 'missing' })).rejects.toThrow(/no retained version/);
  });
});

describe('custom transforms in the runner', () => {
  it('runs a custom step through the injected code runner', async () => {
    const writer = new MemoryWriter();
    const r = recipe('a\n1\n2', [
      step('t0', { op: 'custom', language: 'javascript', code: 'double it' }),
    ]);
    const run = await runRecipe(r, deps(writer, {
      runCode: async (_lang, _code, input) => ({
        value: {
          columns: ['a', 'b'],
          rows: input.rows.map((row) => ({ a: row['a'], b: Number(row['a']) * 2 })),
        },
      }),
    }));
    expect(run.status).toBe('succeeded');
    expect(writer.written[0].table.rows[1]).toEqual({ a: '2', b: 4 });
  });

  it('fails closed when no code runner is configured', async () => {
    const writer = new MemoryWriter();
    const r = recipe('a\n1', [step('t0', { op: 'custom', language: 'python', code: 'x' })]);
    const run = await runRecipe(r, deps(writer));
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/sandboxed code runner/);
    expect(writer.written).toHaveLength(0);
  });
});

describe('join with a literal table ref', () => {
  it('joins against an inline literal table', async () => {
    const writer = new MemoryWriter();
    const other = makeTable(['a', 'rep'], [['1', 'Amy']]);
    const r = recipe('a,b\n1,x\n2,y', [
      step('t0', { op: 'join', with: { kind: 'literal', table: other }, on: ['a'], how: 'left' }),
    ]);
    const run = await runRecipe(r, deps(writer));
    expect(run.status).toBe('succeeded');
    expect(writer.written[0].table.rows[0]['rep']).toBe('Amy');
    expect(writer.written[0].table.rows[1]['rep']).toBeNull();
  });
});
