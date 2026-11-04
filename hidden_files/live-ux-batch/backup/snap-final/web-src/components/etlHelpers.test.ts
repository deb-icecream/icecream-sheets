import { describe, expect, it } from 'vitest';
import {
  addTransformNode,
  inputColumnsFor,
  moveNode,
  newRecipe,
  previewRecipe,
  removeNode,
  tableToGrid,
} from './etlHelpers';

describe('etlHelpers', () => {
  it('newRecipe builds a valid source->load recipe', () => {
    const r = newRecipe('Sales', 'debajyoti');
    expect(r.nodes.map((n) => n.kind)).toEqual(['source', 'load']);
    expect(r.edges).toEqual([{ from: 'src', to: 'load' }]);
    expect(r.schedule).toEqual({ trigger: 'manual' });
  });

  it('addTransformNode inserts before the load node and links edges', () => {
    const r = addTransformNode(newRecipe('T', 'u'), 'filter');
    expect(r.nodes.map((n) => n.kind)).toEqual(['source', 'transform', 'load']);
    const t = r.nodes[1];
    expect(t.kind === 'transform' && t.transform.op).toBe('filter');
    // Chain is intact: src -> t -> load.
    expect(r.edges).toHaveLength(2);
    const next = new Map(r.edges.map((e) => [e.from, e.to]));
    expect(next.get('src')).toBe(t.id);
    expect(next.get(t.id)).toBe('load');
  });

  it('removeNode splices a transform out and re-links', () => {
    let r = addTransformNode(newRecipe('T', 'u'), 'filter');
    const tId = r.nodes[1].id;
    r = removeNode(r, tId);
    expect(r.nodes.map((n) => n.kind)).toEqual(['source', 'load']);
    expect(r.edges).toEqual([{ from: 'src', to: 'load' }]);
  });

  it('removeNode refuses to remove source/load', () => {
    const r = newRecipe('T', 'u');
    expect(removeNode(r, 'src')).toBe(r);
    expect(removeNode(r, 'load')).toBe(r);
  });

  it('moveNode swaps adjacent transforms', () => {
    let r = addTransformNode(newRecipe('T', 'u'), 'filter');
    r = addTransformNode(r, 'sort');
    const [t1, t2] = [r.nodes[1].id, r.nodes[2].id];
    const moved = moveNode(r, t1, 1);
    expect(moved.nodes.find((n) => n.id === t2)?.kind).toBe('transform');
    const next = new Map(moved.edges.map((e) => [e.from, e.to]));
    expect(next.get('src')).toBe(t2);
    expect(next.get(t2)).toBe(t1);
    expect(next.get(t1)).toBe('load');
  });

  it('previewRecipe computes per-step tables for csv sources', () => {
    let r = newRecipe('T', 'u');
    r = addTransformNode(r, 'filter');
    const tId = r.nodes[1].id;
    r = {
      ...r,
      nodes: r.nodes.map((n) =>
        n.id === tId && n.kind === 'transform'
          ? { ...n, transform: { op: 'filter', column: 'Age', operator: 'gt', value: 26 } }
          : n,
      ),
    };
    const { previews, issues } = previewRecipe(r);
    expect(issues).toEqual([]);
    expect(previews.map((p) => p.kind)).toEqual(['source', 'filter', 'load']);
    expect(previews[0].table!.rows).toHaveLength(2);
    expect(previews[1].table!.rows).toHaveLength(1); // only Alice, 30
    expect(previews[2].table!.rows).toHaveLength(1); // load sees the filtered table
  });

  it('previewRecipe reports url sources as not-yet-fetched', () => {
    const r = newRecipe('T', 'u');
    const withUrl = {
      ...r,
      nodes: r.nodes.map((n) =>
        n.id === 'src' && n.kind === 'source'
          ? { ...n, source: { type: 'url', url: 'https://x/y.csv', format: 'auto' } as const }
          : n,
      ),
    };
    const { previews } = previewRecipe(withUrl);
    expect(previews[0].error).toMatch(/not fetched yet/);
  });

  it('previewRecipe explains custom steps honestly', () => {
    let r = addTransformNode(newRecipe('T', 'u'), 'custom');
    const { previews } = previewRecipe(r);
    expect(previews[1].error).toMatch(/service host/);
  });

  it('inputColumnsFor tracks renamed columns through typed edges', () => {
    let r = addTransformNode(newRecipe('T', 'u'), 'rename');
    const tId = r.nodes[1].id;
    r = {
      ...r,
      nodes: r.nodes.map((n) =>
        n.id === tId && n.kind === 'transform'
          ? { ...n, transform: { op: 'rename', mapping: { Name: 'FullName' } } }
          : n,
      ),
    };
    r = addTransformNode(r, 'filter');
    const filterId = r.nodes[2].id;
    expect(inputColumnsFor(r, filterId)).toEqual(['FullName', 'Age', 'City']);
  });

  it('tableToGrid renders headers + formatted values', () => {
    let r = newRecipe('T', 'u');
    const { previews } = previewRecipe(r);
    const grid = tableToGrid(previews[0].table!);
    expect(grid[0]).toEqual(['Name', 'Age', 'City']);
    expect(grid[1]).toEqual(['Alice', '30', 'NYC']);
    expect(grid).toHaveLength(3);
  });
});
