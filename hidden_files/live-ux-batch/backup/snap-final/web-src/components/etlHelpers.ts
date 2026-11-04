/**
 * ETL editor helpers (apps/web): pure, testable logic for the pipeline
 * editor dialog. The React component (EtlEditor.tsx) is a thin shell over
 * these plus the @icecream-sheets/service ETL component.
 */
import {
  applyTransform,
  columnNames,
  csvTextToTable,
  ETL_RECIPE_VERSION,
  formatValue,
  inferOutputColumns,
  jsonTextToTable,
  nodeLabel,
  validateRecipe,
  type EtlNode,
  type EtlRecipe,
  type EtlTable,
  type TransformOp,
} from '@icecream-sheets/service';

export interface StepPreview {
  nodeId: string;
  kind: string;
  label: string;
  table: EtlTable | null;
  error: string | null;
  columnsBefore: string[] | null;
}

/**
 * Preview every step of a recipe without running I/O: URL sources use the
 * caller-supplied fetch cache, connector sources and custom steps report
 * why they can't preview in the browser.
 */
export function previewRecipe(
  recipe: EtlRecipe,
  urlTables: Record<string, EtlTable> = {},
): { previews: StepPreview[]; issues: string[] } {
  const issues = validateRecipe(recipe).map((i) => i.message);
  const previews: StepPreview[] = [];

  // Walk the chain even when structural issues exist — the editor shows the
  // issues separately, and per-step previews are still useful. A visited
  // set guards against cycles (which validation would flag).
  const byId = new Map(recipe.nodes.map((n) => [n.id, n]));
  const next = new Map(recipe.edges.map((e) => [e.from, e.to]));
  let cursor: EtlNode | undefined = recipe.nodes.find((n) => n.kind === 'source');
  const visited = new Set<string>();

  let current: EtlTable | null = null;
  let columnsBefore: string[] | null = null;
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const label = nodeLabel(cursor);
    if (cursor.kind === 'source') {
      try {
        const s = cursor.source;
        if (s.type === 'csv-text') current = csvTextToTable(s.text, s.delimiter, s.hasHeader ?? true);
        else if (s.type === 'json-text') current = jsonTextToTable(s.text);
        else if (s.type === 'url') {
          const cached = urlTables[cursor.id];
          if (!cached) throw new Error('URL not fetched yet — click Fetch to preview');
          current = cached;
        } else {
          throw new Error(`connector "${s.connectorId}" preview needs the service host (vault + connector)`);
        }
        columnsBefore = columnNames(current);
        previews.push({ nodeId: cursor.id, kind: 'source', label, table: current, error: null, columnsBefore: null });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        previews.push({ nodeId: cursor.id, kind: 'source', label, table: null, error, columnsBefore: null });
        break;
      }
    } else if (cursor.kind === 'transform') {
      const op = cursor.transform;
      try {
        if (!current) throw new Error('no input table');
        if (op.op === 'custom') {
          throw new Error(`custom ${op.language} steps run on the service host (sandboxed) — not previewable here`);
        }
        let other: EtlTable | null = null;
        if (op.op === 'join' || op.op === 'append') {
          if (op.with.kind !== 'literal') {
            throw new Error(`"${op.with.kind}" table refs resolve at run time on the service host`);
          }
          other = op.with.table;
        }
        const { table } = applyTransform(current, op, other ? () => other : undefined);
        columnsBefore = columnNames(current);
        current = table;
        previews.push({ nodeId: cursor.id, kind: op.op, label, table, error: null, columnsBefore });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        previews.push({ nodeId: cursor.id, kind: op.op, label, table: null, error, columnsBefore });
        break;
      }
    } else {
      previews.push({ nodeId: cursor.id, kind: 'load', label, table: current, error: null, columnsBefore });
    }
    const nxt = next.get(cursor.id);
    cursor = nxt === undefined ? undefined : byId.get(nxt);
  }
  return { previews, issues };
}

/** Column names available at a transform node's input (typed edges). */
export function inputColumnsFor(recipe: EtlRecipe, nodeId: string): string[] {
  const { previews } = previewRecipe(recipe);
  const idx = previews.findIndex((p) => p.nodeId === nodeId);
  if (idx <= 0) return [];
  // Walk the typed edges from the source instead of trusting previews.
  const byId = new Map(recipe.nodes.map((n) => [n.id, n]));
  const next = new Map(recipe.edges.map((e) => [e.from, e.to]));
  let cursor: EtlNode | undefined = recipe.nodes.find((n) => n.kind === 'source');
  let cols: string[] | null = null;
  while (cursor && cursor.id !== nodeId) {
    if (cursor.kind === 'source') {
      const p = previews.find((x) => x.nodeId === cursor!.id);
      cols = p?.table ? columnNames(p.table) : null;
    } else if (cursor.kind === 'transform') {
      cols = inferOutputColumns(cursor, cols);
    }
    const nxt = next.get(cursor.id);
    cursor = nxt === undefined ? undefined : byId.get(nxt);
    void byId;
  }
  return cols ?? [];
}

/** Convert a table to a string grid (header row + data rows) for sheet loading. */
export function tableToGrid(table: EtlTable): string[][] {
  const names = columnNames(table);
  return [names, ...table.rows.map((r) => names.map((c) => formatValue(r[c])))];
}

const OP_DEFAULTS: Record<TransformOp['op'], () => TransformOp> = {
  select: () => ({ op: 'select', columns: [] }),
  drop: () => ({ op: 'drop', columns: [] }),
  rename: () => ({ op: 'rename', mapping: {} }),
  convert: () => ({ op: 'convert', column: '', to: 'number' }),
  filter: () => ({ op: 'filter', column: '', operator: 'eq', value: '' }),
  sort: () => ({ op: 'sort', keys: [] }),
  split: () => ({ op: 'split', column: '', delimiter: ',', into: [] }),
  'merge-columns': () => ({ op: 'merge-columns', columns: [], delimiter: ' ', into: '' }),
  pivot: () => ({ op: 'pivot', index: [], column: '', value: '', agg: 'sum' }),
  unpivot: () => ({ op: 'unpivot', idColumns: [], variableColumn: 'variable', valueColumn: 'value' }),
  join: () => ({
    op: 'join',
    with: { kind: 'literal', table: { columns: [], rows: [] } },
    on: [], how: 'inner',
  }),
  append: () => ({ op: 'append', with: { kind: 'literal', table: { columns: [], rows: [] } } }),
  'group-by': () => ({ op: 'group-by', keys: [], aggregations: [] }),
  'fill-down': () => ({ op: 'fill-down', column: '' }),
  deduplicate: () => ({ op: 'deduplicate', keep: 'first' }),
  custom: () => ({ op: 'custom', language: 'javascript', code: '' }),
};

/** Create a new transform node with defaults, inserted before the load node. */
export function addTransformNode(recipe: EtlRecipe, kind: TransformOp['op']): EtlRecipe {
  const id = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const load = recipe.nodes.find((n) => n.kind === 'load')!;
  const newNode = { id, kind: 'transform' as const, transform: OP_DEFAULTS[kind]() };
  const nodes = [...recipe.nodes];
  nodes.splice(nodes.indexOf(load), 0, newNode);
  const pred = recipe.edges.find((e) => e.to === load.id)!;
  const edges = [...recipe.edges.filter((e) => e !== pred), { from: pred.from, to: id }, { from: id, to: load.id }];
  return { ...recipe, nodes, edges };
}

export function removeNode(recipe: EtlRecipe, nodeId: string): EtlRecipe {
  const node = recipe.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== 'transform') return recipe; // source/load are structural
  const incoming = recipe.edges.find((e) => e.to === nodeId)!;
  const outgoing = recipe.edges.find((e) => e.from === nodeId)!;
  const edges = [
    ...recipe.edges.filter((e) => e !== incoming && e !== outgoing),
    { from: incoming.from, to: outgoing.to },
  ];
  return { ...recipe, nodes: recipe.nodes.filter((n) => n.id !== nodeId), edges };
}

export function moveNode(recipe: EtlRecipe, nodeId: string, dir: -1 | 1): EtlRecipe {
  // Rebuild the chain order, swap, then re-link edges.
  const byId = new Map(recipe.nodes.map((n) => [n.id, n]));
  const next = new Map(recipe.edges.map((e) => [e.from, e.to]));
  const order: string[] = [];
  let cursor: EtlNode | undefined = recipe.nodes.find((n) => n.kind === 'source');
  while (cursor) {
    order.push(cursor.id);
    const nxt = next.get(cursor.id);
    cursor = nxt === undefined ? undefined : byId.get(nxt);
  }
  const i = order.indexOf(nodeId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return recipe;
  const a = byId.get(order[i])!;
  const b = byId.get(order[j])!;
  if (a.kind !== 'transform' || b.kind !== 'transform') return recipe; // never move source/load
  [order[i], order[j]] = [order[j], order[i]];
  const edges = order.slice(1).map((to, k) => ({ from: order[k], to }));
  return { ...recipe, edges };
}

export function newRecipe(name: string, owner: string): EtlRecipe {
  return {
    version: ETL_RECIPE_VERSION,
    id: `etl_${Date.now().toString(36)}`,
    name,
    owner,
    nodes: [
      {
        id: 'src', kind: 'source',
        source: { type: 'csv-text', text: 'Name,Age,City\nAlice,30,NYC\nBob,25,LA' },
      },
      {
        id: 'load', kind: 'load',
        target: { kind: 'workbook-table', workbookId: 'web', sheetName: 'Sheet1', tableName: name || 'Table1' },
        retention: 5,
      },
    ],
    edges: [{ from: 'src', to: 'load' }],
    schedule: { trigger: 'manual' },
    failurePolicy: { maxRetries: 3, backoffBaseMs: 500, backoffMultiplier: 2, errorThresholdPct: 5, quarantine: true },
  };
}
