/**
 * ETL recipe model tests: DAG validation, typed-edge inference,
 * serialization/migration (design-docs/etl-pipeline.md §1).
 */
import { describe, expect, it } from 'vitest';
import {
  ETL_RECIPE_VERSION,
  defaultFailurePolicy,
  deserializeRecipe,
  executionOrder,
  inferOutputColumns,
  migrateRecipe,
  nodeLabel,
  serializeRecipe,
  validateRecipe,
  validateRecipeColumns,
  type EtlNode,
  type EtlRecipe,
  type TransformOp,
} from '../src/index.js';

function node(id: string, n: Omit<EtlNode, 'id'>): EtlNode {
  return { id, ...n } as EtlNode;
}

function makeRecipe(nodes: EtlNode[], edges: { from: string; to: string }[]): EtlRecipe {
  return {
    version: ETL_RECIPE_VERSION,
    id: 'r1',
    name: 'Sales pipeline',
    owner: 'debajyoti',
    nodes,
    edges,
    schedule: { trigger: 'manual' },
    failurePolicy: defaultFailurePolicy(),
  };
}

function chainRecipe(transforms: TransformOp[] = []): EtlRecipe {
  const tNodes: EtlNode[] = transforms.map((t, i) => node(`t${i}`, { kind: 'transform', transform: t }));
  const nodes: EtlNode[] = [
    node('src', { kind: 'source', source: { type: 'csv-text', text: 'a,b\n1,2' } }),
    ...tNodes,
    node('load', {
      kind: 'load',
      target: { kind: 'workbook-table', workbookId: 'w1', sheetName: 'Sheet1', tableName: 'Sales' },
    }),
  ];
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
  return makeRecipe(nodes, edges);
}

describe('validateRecipe', () => {
  it('accepts a minimal source->load recipe', () => {
    expect(validateRecipe(chainRecipe())).toEqual([]);
  });

  it('accepts a recipe with transforms', () => {
    const r = chainRecipe([
      { op: 'select', columns: ['a'] },
      { op: 'filter', column: 'a', operator: 'gt', value: 0 },
    ]);
    expect(validateRecipe(r)).toEqual([]);
  });

  it('rejects zero or two sources', () => {
    const noSource = chainRecipe();
    noSource.nodes = noSource.nodes.filter((n) => n.kind !== 'source');
    noSource.edges = [];
    expect(validateRecipe(noSource).some((i) => /exactly one source/.test(i.message))).toBe(true);

    const two = chainRecipe();
    two.nodes = [...two.nodes, node('src2', { kind: 'source', source: { type: 'csv-text', text: 'x' } })];
    expect(validateRecipe(two).some((i) => /exactly one source/.test(i.message))).toBe(true);
  });

  it('rejects a missing load node', () => {
    const r = chainRecipe();
    r.nodes = r.nodes.filter((n) => n.kind !== 'load');
    r.edges = [{ from: 'src', to: 'src' }];
    expect(validateRecipe(r).some((i) => /exactly one load/.test(i.message))).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const r = chainRecipe();
    r.nodes = [...r.nodes, node('src', { kind: 'load', target: { kind: 'adapter', adapterId: 'x' } })];
    expect(validateRecipe(r).some((i) => /unique/.test(i.message))).toBe(true);
  });

  it('rejects edges that skip the chain (disconnected node)', () => {
    const r = chainRecipe([{ op: 'select', columns: ['a'] }]);
    // Drop the edge into the transform: t0 becomes disconnected.
    r.edges = r.edges.filter((e) => e.to !== 't0');
    expect(validateRecipe(r).length).toBeGreaterThan(0);
  });

  it('rejects fan-out edges', () => {
    const r = chainRecipe();
    r.nodes = [...r.nodes, node('extra', { kind: 'transform', transform: { op: 'drop', columns: ['a'] } })];
    r.edges = [...r.edges, { from: 'src', to: 'extra' }];
    expect(validateRecipe(r).some((i) => /exactly one outgoing/.test(i.message))).toBe(true);
  });

  it('rejects cycles', () => {
    const r = chainRecipe([{ op: 'select', columns: ['a'] }]);
    r.edges = [
      { from: 'src', to: 't0' },
      { from: 't0', to: 'src' },
      { from: 'src', to: 'load' },
    ];
    expect(validateRecipe(r).length).toBeGreaterThan(0);
  });

  it('rejects a connector source without a credentialRef', () => {
    const r = chainRecipe();
    (r.nodes[0] as { source: unknown }).source = {
      type: 'connector', connectorId: 'crm', credentialRef: '',
    };
    expect(validateRecipe(r).some((i) => /credentialRef/.test(i.message))).toBe(true);
  });

  it('rejects a non-http url source', () => {
    const r = chainRecipe();
    (r.nodes[0] as { source: unknown }).source = { type: 'url', url: 'ftp://x/y.csv', format: 'auto' };
    expect(validateRecipe(r).some((i) => /http\(s\)/.test(i.message))).toBe(true);
  });

  it('validates transform params', () => {
    const r = chainRecipe([{ op: 'select', columns: [] }]);
    expect(validateRecipe(r).some((i) => /select/.test(i.message))).toBe(true);
    const r2 = chainRecipe([{ op: 'rename', mapping: { a: 'b', c: 'b' } }]);
    expect(validateRecipe(r2).some((i) => /unique/.test(i.message))).toBe(true);
    const r3 = chainRecipe([{ op: 'custom', language: 'python', code: '   ' }]);
    expect(validateRecipe(r3).some((i) => /code must not be empty/.test(i.message))).toBe(true);
  });

  it('validates cron expressions', () => {
    const r = chainRecipe();
    r.schedule = { trigger: 'scheduled', cron: 'not a cron' };
    expect(validateRecipe(r).some((i) => /cron/.test(i.message))).toBe(true);
    const ok = chainRecipe();
    ok.schedule = { trigger: 'scheduled', cron: '0 6 * * *' };
    expect(validateRecipe(ok)).toEqual([]);
  });

  it('validates the failure policy', () => {
    const r = chainRecipe();
    r.failurePolicy = { ...defaultFailurePolicy(), maxRetries: -1 };
    expect(validateRecipe(r).some((i) => /maxRetries/.test(i.message))).toBe(true);
    const r2 = chainRecipe();
    r2.failurePolicy = { ...defaultFailurePolicy(), errorThresholdPct: 101 };
    expect(validateRecipe(r2).some((i) => /errorThresholdPct/.test(i.message))).toBe(true);
  });

  it('rejects unsupported versions without validating further', () => {
    const r = chainRecipe();
    r.version = 99;
    const issues = validateRecipe(r);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unsupported recipe version/);
  });
});

describe('executionOrder', () => {
  it('returns source-first order for a chain', () => {
    const r = chainRecipe([{ op: 'select', columns: ['a'] }]);
    const order = executionOrder(r)!;
    expect(order.map((n) => n.id)).toEqual(['src', 't0', 'load']);
  });

  it('returns null for a broken chain', () => {
    const r = chainRecipe();
    r.edges = [];
    expect(executionOrder(r)).toBeNull();
  });
});

describe('inferOutputColumns (typed edges)', () => {
  const n = (t: TransformOp): EtlNode => ({ id: 't', kind: 'transform', transform: t });

  it('infers select/drop/rename/convert/filter/sort', () => {
    expect(inferOutputColumns(n({ op: 'select', columns: ['b'] }), ['a', 'b'])).toEqual(['b']);
    expect(inferOutputColumns(n({ op: 'drop', columns: ['a'] }), ['a', 'b'])).toEqual(['b']);
    expect(inferOutputColumns(n({ op: 'rename', mapping: { a: 'z' } }), ['a', 'b'])).toEqual(['z', 'b']);
    expect(inferOutputColumns(n({ op: 'convert', column: 'a', to: 'number' }), ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('infers split/merge/group-by/unpivot', () => {
    expect(inferOutputColumns(n({ op: 'split', column: 'a', delimiter: ',', into: ['x', 'y'] }), ['a', 'b']))
      .toEqual(['b', 'x', 'y']);
    expect(inferOutputColumns(n({ op: 'merge-columns', columns: ['a', 'b'], delimiter: ' ', into: 'c' }), ['a', 'b']))
      .toEqual(['c']);
    expect(inferOutputColumns(
      n({ op: 'group-by', keys: ['a'], aggregations: [{ column: 'b', agg: 'sum', as: 'Total' }] }), ['a', 'b'],
    )).toEqual(['a', 'Total']);
    expect(inferOutputColumns(
      n({ op: 'unpivot', idColumns: ['a'], variableColumn: 'k', valueColumn: 'v' }), ['a', 'b', 'c'],
    )).toEqual(['a', 'k', 'v']);
  });

  it('returns null for data-dependent outputs (pivot, custom, opaque join)', () => {
    expect(inferOutputColumns(n({ op: 'pivot', index: ['a'], column: 'b', value: 'c', agg: 'sum' }), ['a', 'b', 'c'])).toBeNull();
    expect(inferOutputColumns(n({ op: 'custom', language: 'python', code: 'x' }), ['a'])).toBeNull();
    expect(inferOutputColumns(
      n({ op: 'join', with: { kind: 'recipe', recipeId: 'r2' }, on: ['a'], how: 'inner' }), ['a'],
    )).toBeNull();
  });

  it('propagates null input', () => {
    expect(inferOutputColumns(n({ op: 'select', columns: ['a'] }), null)).toBeNull();
  });
});

describe('validateRecipeColumns', () => {
  it('catches unknown column references', () => {
    const r = chainRecipe([{ op: 'filter', column: 'nope', operator: 'eq', value: 1 }]);
    const issues = validateRecipeColumns(r, ['a', 'b']);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown column "nope"/);
  });

  it('tracks renamed columns through the chain', () => {
    const r = chainRecipe([
      { op: 'rename', mapping: { a: 'z' } },
      { op: 'filter', column: 'z', operator: 'gt', value: 0 },
    ]);
    expect(validateRecipeColumns(r, ['a', 'b'])).toEqual([]);
  });

  it('stops checking after a data-dependent node', () => {
    const r = chainRecipe([
      { op: 'pivot', index: ['a'], column: 'b', value: 'c', agg: 'sum' },
      { op: 'filter', column: 'anything', operator: 'eq', value: 1 },
    ]);
    expect(validateRecipeColumns(r, ['a', 'b', 'c'])).toEqual([]);
  });
});

describe('serialization', () => {
  it('round-trips through JSON', () => {
    const r = chainRecipe([{ op: 'sort', keys: [{ column: 'a', dir: 'desc' }] }]);
    const back = deserializeRecipe(serializeRecipe(r))!;
    expect(back).toEqual(r);
    expect(validateRecipe(back)).toEqual([]);
  });

  it('returns null for corrupt JSON', () => {
    expect(deserializeRecipe('not json')).toBeNull();
    expect(deserializeRecipe('{"version":1}')).toBeNull();
  });

  it('migrates a v0 recipe (no schedule/policy) to v1', () => {
    const v0 = { ...chainRecipe(), version: 0, schedule: undefined, failurePolicy: undefined };
    const migrated = migrateRecipe(v0 as EtlRecipe);
    expect(migrated.version).toBe(ETL_RECIPE_VERSION);
    expect(migrated.schedule).toEqual({ trigger: 'manual' });
    expect(migrated.failurePolicy.maxRetries).toBe(3);
  });
});

describe('nodeLabel', () => {
  it('labels source/transform/load nodes', () => {
    expect(nodeLabel({ id: 's', kind: 'source', source: { type: 'url', url: 'https://x/y.csv', format: 'auto' } }))
      .toBe('Source: https://x/y.csv');
    expect(nodeLabel({ id: 't', kind: 'transform', transform: { op: 'select', columns: ['a', 'b'] } }))
      .toBe('Keep columns: a, b');
    expect(nodeLabel({
      id: 'l', kind: 'load',
      target: { kind: 'workbook-table', workbookId: 'w', sheetName: 'S', tableName: 'T' },
    })).toBe('Load: T → S');
  });
});
