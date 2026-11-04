/**
 * ETL permission enforcement tests (design-docs/etl-pipeline.md §6):
 * the recipe is an object in the permission tree; editing needs the manage
 * right; running needs read on the credential + write on the target. The
 * runner wires the authorize() port itself — no host hook required.
 */
import { describe, expect, it } from 'vitest';
import {
  checkRecipeEdit,
  credentialRefsOfRecipe,
  defaultFailurePolicy,
  ETL_CREDENTIAL_READ_ACTION,
  ETL_MANAGE_ACTION,
  ETL_TARGET_WRITE_ACTION,
  etlCredentialObjectId,
  etlLoadTargetObjectId,
  etlRecipeObjectId,
  ETL_RECIPE_VERSION,
  loadTargetOfRecipe,
  makeRecipeRunCheck,
  makeTable,
  runRecipe,
  type AuthorizePort,
  type EtlRecipe,
  type EtlTable,
  type LoadTarget,
  type RunnerDeps,
  type TableWriter,
} from '../src/index.js';

const TARGET: LoadTarget = {
  kind: 'workbook-table', workbookId: 'w1', sheetName: 'Sheet1', tableName: 'Sales',
};

function recipe(): EtlRecipe {
  return {
    version: ETL_RECIPE_VERSION,
    id: 'r1',
    name: 'Pipeline',
    owner: 'debajyoti',
    nodes: [
      {
        id: 'src',
        kind: 'source',
        source: { type: 'connector', connectorId: 'c1', credentialRef: 'vault:cred1' },
      },
      { id: 'load', kind: 'load', target: TARGET, retention: 2 },
    ],
    edges: [{ from: 'src', to: 'load' }],
    schedule: { trigger: 'manual' },
    failurePolicy: defaultFailurePolicy(),
  };
}

/** Deny-list authorize port: allowed unless listed as denied. */
function port(denied: string[] = []): { authorize: AuthorizePort; calls: string[] } {
  const calls: string[] = [];
  const authorize: AuthorizePort = (action, target, ctx) => {
    calls.push(`${action} ${target} ${ctx.principal}`);
    if (ctx.principal.length === 0) throw new Error('authorize: missing principal (fail closed)');
    return !denied.includes(action);
  };
  return { authorize, calls };
}

class MemoryWriter implements TableWriter {
  written = 0;
  async writeAtomic(_t: LoadTarget, _table: EtlTable): Promise<void> {
    this.written += 1;
  }
}

function deps(writer: MemoryWriter, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    fetchText: async () => {
      throw new Error('no network');
    },
    writer,
    sleep: async () => {},
    now: () => new Date('2026-10-18T10:00:00Z'),
    ...overrides,
  };
}

describe('etl object ids and helpers', () => {
  it('builds the permission-tree object ids', () => {
    expect(etlRecipeObjectId('r1')).toBe('etl:recipe:r1');
    expect(etlCredentialObjectId('vault:cred1')).toBe('etl:credential:vault:cred1');
    expect(etlLoadTargetObjectId(TARGET)).toBe('workbook:w1');
    expect(etlLoadTargetObjectId({ kind: 'adapter', adapterId: 'a1' })).toBe('etl:adapter:a1');
  });

  it('collects credential refs and the load target', () => {
    const r = recipe();
    expect(credentialRefsOfRecipe(r)).toEqual(['vault:cred1']);
    expect(loadTargetOfRecipe(r)).toBe(TARGET);
  });
});

describe('checkRecipeEdit', () => {
  it('passes when the policy grants the manage right on the recipe', () => {
    const { authorize, calls } = port();
    expect(() => checkRecipeEdit(authorize, 'r1', 'debajyoti')).not.toThrow();
    expect(calls).toEqual([`${ETL_MANAGE_ACTION} etl:recipe:r1 debajyoti`]);
  });

  it('throws when the manage right is denied', () => {
    const { authorize } = port([ETL_MANAGE_ACTION]);
    expect(() => checkRecipeEdit(authorize, 'r1', 'intruder')).toThrow(/manage right/);
  });

  it('fails closed on a missing principal', () => {
    const { authorize } = port();
    expect(() => checkRecipeEdit(authorize, 'r1', '')).toThrow(/missing principal/);
  });
});

describe('runner authorize() wiring (run rights)', () => {
  it('denies the run when credential read is denied — nothing is written', async () => {
    const writer = new MemoryWriter();
    const { authorize, calls } = port([ETL_CREDENTIAL_READ_ACTION]);
    await expect(
      runRecipe(recipe(), deps(writer, { authorize, principal: 'debajyoti' })),
    ).rejects.toThrow(/no read on credential/);
    expect(writer.written).toBe(0);
    expect(calls.some((c) => c.startsWith(ETL_CREDENTIAL_READ_ACTION))).toBe(true);
  });

  it('denies the run when target write is denied — nothing is written', async () => {
    const writer = new MemoryWriter();
    const { authorize } = port([ETL_TARGET_WRITE_ACTION]);
    await expect(
      runRecipe(recipe(), deps(writer, { authorize, principal: 'debajyoti' })),
    ).rejects.toThrow(/no write on load target/);
    expect(writer.written).toBe(0);
  });

  it('runs when credential read and target write are granted', async () => {
    const writer = new MemoryWriter();
    const { authorize } = port();
    const r = recipe();
    // Connector sources need a registry; swap to csv-text for the happy path.
    r.nodes = [
      { id: 'src', kind: 'source', source: { type: 'csv-text', text: 'a\n1' } },
      { id: 'load', kind: 'load', target: TARGET, retention: 2 },
    ];
    r.edges = [{ from: 'src', to: 'load' }];
    const run = await runRecipe(r, deps(writer, { authorize, principal: 'debajyoti' }));
    expect(run.status).toBe('succeeded');
    expect(writer.written).toBe(1);
  });

  it('fails closed when the principal is missing', async () => {
    const writer = new MemoryWriter();
    const { authorize } = port();
    await expect(runRecipe(recipe(), deps(writer, { authorize }))).rejects.toThrow(
      /missing principal/,
    );
    expect(writer.written).toBe(0);
  });

  it('the legacy checkPermission hook still overrides the authorize port', async () => {
    const writer = new MemoryWriter();
    const { authorize } = port();
    await expect(
      runRecipe(
        recipe(),
        deps(writer, {
          authorize,
          principal: 'debajyoti',
          checkPermission: async () => {
            throw new Error('legacy hook denial');
          },
        }),
      ),
    ).rejects.toThrow(/legacy hook denial/);
    expect(writer.written).toBe(0);
  });

  it('runs without any permission config (opt-in enforcement)', async () => {
    const writer = new MemoryWriter();
    const r = recipe();
    r.nodes = [
      { id: 'src', kind: 'source', source: { type: 'csv-text', text: 'a\n1' } },
      { id: 'load', kind: 'load', target: TARGET, retention: 2 },
    ];
    r.edges = [{ from: 'src', to: 'load' }];
    const run = await runRecipe(r, deps(writer));
    expect(run.status).toBe('succeeded');
  });
});

describe('makeRecipeRunCheck', () => {
  it('throws on a throwing policy (fail closed)', async () => {
    const check = makeRecipeRunCheck(
      () => {
        throw new Error('policy blew up');
      },
      'debajyoti',
    );
    await expect(check(recipe())).rejects.toThrow(/may not run recipe/);
  });

  it('checks credential refs before the target', async () => {
    const order: string[] = [];
    const check = makeRecipeRunCheck(
      (action) => {
        order.push(action);
        return true;
      },
      'debajyoti',
    );
    await check(recipe());
    expect(order).toEqual([ETL_CREDENTIAL_READ_ACTION, ETL_TARGET_WRITE_ACTION]);
  });

  it('makeTable sanity: the table type used by the writer path exists', () => {
    const t: EtlTable = makeTable(['a'], [['1']]);
    expect(t.rows).toHaveLength(1);
  });
});
