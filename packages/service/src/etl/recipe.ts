/**
 * ETL pipeline — recipe DAG model.
 *
 * Per design-docs/etl-pipeline.md §1: a recipe is a versioned, serializable
 * typed DAG — exactly one source node, zero or more transform nodes, exactly
 * one load node, with typed table edges. The recipe is schema-validated at
 * design time, before anything executes.
 *
 * Credentials: a connector source stores ONLY a `credentialRef` (an opaque
 * vault reference). Secrets never appear in recipe bytes; they are resolved
 * at run time through a `CredentialResolver` — in production, the service
 * credential vault via `serviceVaultResolver` (see connectors.ts).
 */

import type { EtlTable } from './types.js';

export const ETL_RECIPE_VERSION = 1;

// ---------------------------------------------------------------------------
// Source nodes
// ---------------------------------------------------------------------------

export interface CsvTextSource {
  type: 'csv-text';
  /** Raw CSV text pasted or uploaded by the recipe author. */
  text: string;
  /** Delimiter override; omitted = auto-detect. */
  delimiter?: string;
  /** First row holds headers. Defaults to true. */
  hasHeader?: boolean;
}

export interface JsonTextSource {
  type: 'json-text';
  /** JSON array of objects (or `{ "data": [...] }` wrapper). */
  text: string;
}

export interface UrlSource {
  type: 'url';
  url: string;
  format: 'auto' | 'csv' | 'json';
}

export interface ConnectorSource {
  type: 'connector';
  /** Connector id in the connector registry (see connectors.ts). */
  connectorId: string;
  /**
   * Opaque reference into the service credential vault — never a secret.
   * Resolved at run time; scheduled runs execute as the pipeline owner.
   */
  credentialRef: string;
  parameters?: Record<string, string>;
}

export type EtlSource = CsvTextSource | JsonTextSource | UrlSource | ConnectorSource;

export interface SourceNode {
  id: string;
  kind: 'source';
  label?: string;
  source: EtlSource;
}

// ---------------------------------------------------------------------------
// Transform nodes — the fixed typed operation library (§3 of the design doc)
// ---------------------------------------------------------------------------

export type FilterOperator =
  | 'eq' | 'neq' | 'contains' | 'not-contains'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'is-null' | 'is-not-null';

export type SortDir = 'asc' | 'desc';
export type ConvertTarget = 'text' | 'number' | 'date' | 'boolean';
export type JoinHow = 'inner' | 'left' | 'right' | 'outer';
export type Aggregation =
  | 'sum' | 'avg' | 'min' | 'max'
  | 'count' | 'count-distinct' | 'first' | 'last';

/**
 * The "other" table for merge/append nodes. The recipe keeps exactly one
 * source node (§1), so the second table arrives by reference: an inline
 * literal, a workbook range read at run time, or the output of another
 * recipe (same-workbook only in v1; cross-workbook references are v2).
 */
export type TableRef =
  | { kind: 'literal'; table: EtlTable }
  | { kind: 'workbook-range'; sheetName: string; range: string }
  | { kind: 'recipe'; recipeId: string };

export type TransformOp =
  | { op: 'select'; columns: string[] }
  | { op: 'drop'; columns: string[] }
  | { op: 'rename'; mapping: Record<string, string> }
  | { op: 'convert'; column: string; to: ConvertTarget }
  | { op: 'filter'; column: string; operator: FilterOperator; value?: string | number | boolean | null }
  | { op: 'sort'; keys: { column: string; dir: SortDir }[] }
  | { op: 'split'; column: string; delimiter: string; into: string[] }
  | { op: 'merge-columns'; columns: string[]; delimiter: string; into: string }
  | { op: 'pivot'; index: string[]; column: string; value: string; agg: Aggregation }
  | { op: 'unpivot'; idColumns: string[]; variableColumn: string; valueColumn: string; valueColumns?: string[] }
  | { op: 'join'; with: TableRef; on: string[]; how: JoinHow }
  | { op: 'append'; with: TableRef }
  | { op: 'group-by'; keys: string[]; aggregations: { column: string; agg: Aggregation; as: string }[] }
  | { op: 'fill-down'; column: string }
  | { op: 'deduplicate'; columns?: string[]; keep?: 'first' | 'last' }
  | { op: 'custom'; language: 'python' | 'javascript' | 'typescript'; code: string; timeoutMs?: number };

export type TransformOpKind = TransformOp['op'];

export const TRANSFORM_OP_KINDS: TransformOpKind[] = [
  'select', 'drop', 'rename', 'convert', 'filter', 'sort',
  'split', 'merge-columns', 'pivot', 'unpivot',
  'join', 'append', 'group-by', 'fill-down', 'deduplicate', 'custom',
];

export interface TransformNode {
  id: string;
  kind: 'transform';
  label?: string;
  transform: TransformOp;
}

// ---------------------------------------------------------------------------
// Load node
// ---------------------------------------------------------------------------

export type LoadTarget =
  | { kind: 'workbook-table'; workbookId: string; sheetName: string; tableName: string }
  | { kind: 'adapter'; adapterId: string; options?: Record<string, string> };

export interface LoadNode {
  id: string;
  kind: 'load';
  label?: string;
  target: LoadTarget;
  /**
   * Prior loaded versions retained in the service metadata store.
   * Defaults to DEFAULT_RETENTION.
   */
  retention?: number;
}

export const DEFAULT_RETENTION = 5;

export type EtlNode = SourceNode | TransformNode | LoadNode;

export interface EtlEdge {
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Schedule, failure policy, recipe
// ---------------------------------------------------------------------------

/**
 * Serializable schedule spec. `scheduled` carries a 5-field cron expression;
 * there is no cron daemon in v1 — the host evaluates the spec.
 */
export type ScheduleSpec =
  | { trigger: 'manual' }
  | { trigger: 'on-open' }
  | { trigger: 'scheduled'; cron: string };

/** Per-recipe failure handling (§5 of the design doc). */
export interface FailurePolicy {
  /** Retries of transient failures (fetch, sandbox timeouts). */
  maxRetries: number;
  /** First backoff delay; multiplied by backoffMultiplier per attempt. */
  backoffBaseMs: number;
  backoffMultiplier: number;
  /** Abort when quarantined rows exceed this % of source rows (optional). */
  errorThresholdPct?: number;
  /** Abort when quarantined rows exceed this count (optional). */
  maxErrorRows?: number;
  /** Keep failing rows with reasons instead of failing the step. */
  quarantine: boolean;
}

export function defaultFailurePolicy(): FailurePolicy {
  return {
    maxRetries: 3,
    backoffBaseMs: 500,
    backoffMultiplier: 2,
    errorThresholdPct: 5,
    quarantine: true,
  };
}

export interface EtlRecipe {
  version: number;
  id: string;
  name: string;
  description?: string;
  /** The user the scheduled run executes as (§6 of the design doc). */
  owner: string;
  nodes: EtlNode[];
  edges: EtlEdge[];
  schedule: ScheduleSpec;
  failurePolicy: FailurePolicy;
}

// ---------------------------------------------------------------------------
// Typed edges: output-column inference per node
// ---------------------------------------------------------------------------

/**
 * Infer a node's output column names from its input column names.
 * Returns null when the output schema is data-dependent (pivot value
 * columns, custom code, opaque table refs) — callers must skip
 * column-reference checks downstream of such nodes.
 */
export function inferOutputColumns(node: EtlNode, input: string[] | null): string[] | null {
  if (input === null) return null;
  if (node.kind === 'source' || node.kind === 'load') return [...input];
  const t = node.transform;
  switch (t.op) {
    case 'select': return [...t.columns];
    case 'drop': return input.filter((c) => !t.columns.includes(c));
    case 'rename': return input.map((c) => t.mapping[c] ?? c);
    case 'convert':
    case 'filter':
    case 'sort':
    case 'fill-down':
    case 'deduplicate':
      return [...input];
    case 'split': {
      const rest = input.filter((c) => c !== t.column);
      return [...rest, ...t.into];
    }
    case 'merge-columns': {
      const rest = input.filter((c) => !t.columns.includes(c));
      return [...rest, t.into];
    }
    case 'pivot':
      // Value columns are data-dependent (distinct values of `column`).
      return null;
    case 'unpivot': {
      const valueCols = t.valueColumns ?? input.filter((c) => !t.idColumns.includes(c));
      void valueCols;
      return [...t.idColumns, t.variableColumn, t.valueColumn];
    }
    case 'group-by':
      return [...t.keys, ...t.aggregations.map((a) => a.as)];
    case 'join': {
      if (t.with.kind !== 'literal') return null;
      const right = t.with.table.columns.map((c) => c.name).filter((c) => !t.on.includes(c));
      return [...input, ...right];
    }
    case 'append':
      return [...input];
    case 'custom':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Validation (design-time, before anything executes)
// ---------------------------------------------------------------------------

export interface RecipeIssue {
  nodeId?: string;
  message: string;
}

const NON_EMPTY = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
const CRON_FIELD = /^[\d*,/\-]+$/;

function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}

function validateTransformParams(t: TransformOp): string[] {
  const issues: string[] = [];
  const cols = (cs: unknown): cs is string[] =>
    Array.isArray(cs) && cs.length > 0 && cs.every(NON_EMPTY);
  switch (t.op) {
    case 'select':
    case 'drop':
      if (!cols(t.columns)) issues.push(`${t.op}: columns must be a non-empty list of names`);
      break;
    case 'rename': {
      const entries = Object.entries(t.mapping ?? {});
      if (entries.length === 0) issues.push('rename: mapping must not be empty');
      const targets = entries.map(([, v]) => v);
      if (new Set(targets).size !== targets.length) issues.push('rename: target names must be unique');
      if (entries.some(([k, v]) => !NON_EMPTY(k) || !NON_EMPTY(v))) issues.push('rename: names must be non-empty');
      break;
    }
    case 'convert':
      if (!NON_EMPTY(t.column)) issues.push('convert: column is required');
      break;
    case 'filter':
      if (!NON_EMPTY(t.column)) issues.push('filter: column is required');
      break;
    case 'sort':
      if (!Array.isArray(t.keys) || t.keys.length === 0 || t.keys.some((k) => !NON_EMPTY(k.column))) {
        issues.push('sort: at least one key with a column is required');
      }
      break;
    case 'split':
      if (!NON_EMPTY(t.column)) issues.push('split: column is required');
      if (!cols(t.into)) issues.push('split: into must be a non-empty list of new column names');
      if (new Set(t.into ?? []).size !== (t.into ?? []).length) issues.push('split: into names must be unique');
      break;
    case 'merge-columns':
      if (!cols(t.columns)) issues.push('merge-columns: columns must be a non-empty list');
      if (!NON_EMPTY(t.into)) issues.push('merge-columns: into is required');
      break;
    case 'pivot':
      if (!cols(t.index)) issues.push('pivot: index must be a non-empty list of columns');
      if (!NON_EMPTY(t.column) || !NON_EMPTY(t.value)) issues.push('pivot: column and value are required');
      break;
    case 'unpivot':
      if (!cols(t.idColumns)) issues.push('unpivot: idColumns must be a non-empty list');
      if (!NON_EMPTY(t.variableColumn) || !NON_EMPTY(t.valueColumn)) issues.push('unpivot: variableColumn and valueColumn are required');
      break;
    case 'join':
      if (!cols(t.on)) issues.push('join: on must be a non-empty list of key columns');
      if (!t.with || typeof t.with !== 'object') issues.push('join: with (other table) is required');
      break;
    case 'append':
      if (!t.with || typeof t.with !== 'object') issues.push('append: with (other table) is required');
      break;
    case 'group-by': {
      if (!Array.isArray(t.aggregations) || t.aggregations.length === 0) {
        issues.push('group-by: at least one aggregation is required');
      } else {
        const names = t.aggregations.map((a) => a.as);
        if (new Set(names).size !== names.length) issues.push('group-by: aggregation output names (as) must be unique');
        if (t.aggregations.some((a) => !NON_EMPTY(a.column) || !NON_EMPTY(a.as))) {
          issues.push('group-by: aggregation column and as are required');
        }
      }
      break;
    }
    case 'fill-down':
      if (!NON_EMPTY(t.column)) issues.push('fill-down: column is required');
      break;
    case 'deduplicate':
      break;
    case 'custom':
      if (!NON_EMPTY(t.code)) issues.push('custom: code must not be empty');
      if (t.timeoutMs !== undefined && (!Number.isFinite(t.timeoutMs) || t.timeoutMs <= 0)) {
        issues.push('custom: timeoutMs must be a positive number');
      }
      break;
  }
  return issues;
}

/**
 * Validate a recipe's structure and node parameters. Returns a list of
 * issues; an empty list means the recipe is executable.
 */
export function validateRecipe(recipe: EtlRecipe): RecipeIssue[] {
  const issues: RecipeIssue[] = [];
  if (recipe.version !== ETL_RECIPE_VERSION) {
    issues.push({ message: `unsupported recipe version ${recipe.version} (expected ${ETL_RECIPE_VERSION})` });
    return issues;
  }
  if (!NON_EMPTY(recipe.id)) issues.push({ message: 'recipe id is required' });
  if (!NON_EMPTY(recipe.name)) issues.push({ message: 'recipe name is required' });

  const ids = recipe.nodes.map((n) => n.id);
  if (new Set(ids).size !== ids.length) issues.push({ message: 'node ids must be unique' });
  if (ids.some((id) => !NON_EMPTY(id))) issues.push({ message: 'node ids must be non-empty' });

  const sources = recipe.nodes.filter((n) => n.kind === 'source');
  const loads = recipe.nodes.filter((n) => n.kind === 'load');
  if (sources.length !== 1) issues.push({ message: `recipe must have exactly one source node (found ${sources.length})` });
  if (loads.length !== 1) issues.push({ message: `recipe must have exactly one load node (found ${loads.length})` });

  const byId = new Map(recipe.nodes.map((n) => [n.id, n]));
  for (const e of recipe.edges) {
    if (!byId.has(e.from)) issues.push({ message: `edge references unknown node "${e.from}"` });
    if (!byId.has(e.to)) issues.push({ message: `edge references unknown node "${e.to}"` });
    if (e.from === e.to) issues.push({ nodeId: e.from, message: 'edge must not be a self-loop' });
  }

  // Chain check: walk from the source; every node must be visited exactly
  // once and the walk must end at the load node.
  if (sources.length === 1 && loads.length === 1) {
    const out = new Map<string, string[]>();
    const indeg = new Map<string, number>();
    for (const n of recipe.nodes) { out.set(n.id, []); indeg.set(n.id, 0); }
    for (const e of recipe.edges) {
      if (byId.has(e.from) && byId.has(e.to)) {
        out.get(e.from)!.push(e.to);
        indeg.set(e.to, indeg.get(e.to)! + 1);
      }
    }
    const src = sources[0].id;
    const load = loads[0].id;
    // Walk from the source; every node must be visited exactly once and the
    // walk must end at the load node (fan-out is v2 scope).
    const visited = new Set<string>();
    let cur: string | undefined = src;
    while (cur !== undefined && !visited.has(cur)) {
      visited.add(cur);
      const next: string[] = out.get(cur)!;
      cur = next.length === 1 ? next[0] : undefined;
    }
    if (visited.size !== recipe.nodes.length) {
      issues.push({ message: 'edges must form a single chain from the source through every node to the load node' });
    } else if (!visited.has(load)) {
      issues.push({ message: 'the node chain must end at the load node' });
    }
    for (const [id, deg] of indeg) {
      if (id !== src && deg !== 1) issues.push({ nodeId: id, message: `node must have exactly one incoming edge (found ${deg})` });
      if (id === src && deg !== 0) issues.push({ nodeId: id, message: 'source node must have no incoming edges' });
    }
    for (const [id, outs] of out) {
      if (id !== load && outs.length !== 1) issues.push({ nodeId: id, message: `node must have exactly one outgoing edge (found ${outs.length})` });
      if (id === load && outs.length !== 0) issues.push({ nodeId: id, message: 'load node must have no outgoing edges' });
    }
  }

  for (const n of recipe.nodes) {
    if (n.kind === 'transform') {
      for (const m of validateTransformParams(n.transform)) issues.push({ nodeId: n.id, message: m });
    } else if (n.kind === 'source') {
      const s = n.source;
      if (s.type === 'url' && !/^https?:\/\//i.test(s.url)) {
        issues.push({ nodeId: n.id, message: 'url source must be an http(s) URL' });
      }
      if (s.type === 'connector') {
        if (!NON_EMPTY(s.connectorId)) issues.push({ nodeId: n.id, message: 'connector source needs a connectorId' });
        if (!NON_EMPTY(s.credentialRef)) issues.push({ nodeId: n.id, message: 'connector source needs a credentialRef (vault reference, never a secret)' });
      }
    } else if (n.kind === 'load') {
      const t = n.target;
      if (t.kind === 'workbook-table') {
        if (!NON_EMPTY(t.sheetName)) issues.push({ nodeId: n.id, message: 'load target needs a sheetName' });
        if (!NON_EMPTY(t.tableName)) issues.push({ nodeId: n.id, message: 'load target needs a tableName' });
      } else if (!NON_EMPTY(t.adapterId)) {
        issues.push({ nodeId: n.id, message: 'adapter load target needs an adapterId' });
      }
      if (n.retention !== undefined && (!Number.isInteger(n.retention) || n.retention < 0)) {
        issues.push({ nodeId: n.id, message: 'retention must be a non-negative integer' });
      }
    }
  }

  const sched = recipe.schedule;
  if (sched.trigger === 'scheduled' && !isValidCron(sched.cron)) {
    issues.push({ message: 'scheduled trigger needs a valid 5-field cron expression' });
  }
  const fp = recipe.failurePolicy;
  if (!Number.isInteger(fp.maxRetries) || fp.maxRetries < 0) issues.push({ message: 'failurePolicy.maxRetries must be a non-negative integer' });
  if (!(fp.backoffBaseMs > 0)) issues.push({ message: 'failurePolicy.backoffBaseMs must be positive' });
  if (!(fp.backoffMultiplier >= 1)) issues.push({ message: 'failurePolicy.backoffMultiplier must be >= 1' });
  if (fp.errorThresholdPct !== undefined && (fp.errorThresholdPct < 0 || fp.errorThresholdPct > 100)) {
    issues.push({ message: 'failurePolicy.errorThresholdPct must be between 0 and 100' });
  }
  if (fp.maxErrorRows !== undefined && (!Number.isInteger(fp.maxErrorRows) || fp.maxErrorRows < 0)) {
    issues.push({ message: 'failurePolicy.maxErrorRows must be a non-negative integer' });
  }
  return issues;
}

/**
 * Validate column references against a known source schema. Walks the chain
 * inferring output columns per node; checks every column a transform names
 * exists in its input. Stops checking after a data-dependent node
 * (pivot/custom/opaque join), whose output schema is only known at run time.
 */
export function validateRecipeColumns(recipe: EtlRecipe, sourceColumns: string[]): RecipeIssue[] {
  const issues: RecipeIssue[] = [];
  const ordered = executionOrder(recipe);
  if (!ordered) return [{ message: 'recipe edges do not form a single chain' }];
  let cols: string[] | null = [...sourceColumns];
  const KNOWN_OP_COLUMNS: Record<string, (t: TransformOp) => string[]> = {
    'select': (t) => (t.op === 'select' ? t.columns : []),
    'drop': (t) => (t.op === 'drop' ? t.columns : []),
    'convert': (t) => (t.op === 'convert' ? [t.column] : []),
    'filter': (t) => (t.op === 'filter' ? [t.column] : []),
    'sort': (t) => (t.op === 'sort' ? t.keys.map((k) => k.column) : []),
    'split': (t) => (t.op === 'split' ? [t.column] : []),
    'merge-columns': (t) => (t.op === 'merge-columns' ? t.columns : []),
    'rename': (t) => (t.op === 'rename' ? Object.keys(t.mapping) : []),
    'pivot': (t) => (t.op === 'pivot' ? [...t.index, t.column, t.value] : []),
    'unpivot': (t) => (t.op === 'unpivot' ? t.idColumns : []),
    'join': (t) => (t.op === 'join' ? t.on : []),
    'group-by': (t) => (t.op === 'group-by' ? [...t.keys, ...t.aggregations.map((a) => a.column)] : []),
    'fill-down': (t) => (t.op === 'fill-down' ? [t.column] : []),
    'deduplicate': (t) => (t.op === 'deduplicate' && t.columns ? t.columns : []),
    'append': () => [],
    'custom': () => [],
  };
  for (const node of ordered) {
    if (node.kind === 'source') continue;
    if (node.kind === 'load') break;
    const t = node.transform;
    const refs = KNOWN_OP_COLUMNS[t.op](t);
    if (cols !== null) {
      for (const c of refs) {
        if (!cols.includes(c)) {
          issues.push({ nodeId: node.id, message: `unknown column "${c}" (available: ${cols.join(', ') || 'none'})` });
        }
      }
    }
    cols = inferOutputColumns(node, cols);
  }
  return issues;
}

/** Node execution order (source first, load last), or null if not a chain. */
export function executionOrder(recipe: EtlRecipe): EtlNode[] | null {
  const byId = new Map(recipe.nodes.map((n) => [n.id, n]));
  const next = new Map<string, string>();
  for (const e of recipe.edges) {
    if (next.has(e.from)) return null;
    next.set(e.from, e.to);
  }
  const src = recipe.nodes.find((n) => n.kind === 'source');
  if (!src) return null;
  const ordered: EtlNode[] = [];
  const seen = new Set<string>();
  let cur: EtlNode | undefined = src;
  while (cur) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    ordered.push(cur);
    const nxt = next.get(cur.id);
    cur = nxt === undefined ? undefined : byId.get(nxt);
    if (nxt !== undefined && !cur) return null;
  }
  return ordered.length === recipe.nodes.length ? ordered : null;
}

// ---------------------------------------------------------------------------
// Serialization (versioned, migratable)
// ---------------------------------------------------------------------------

export function serializeRecipe(recipe: EtlRecipe): string {
  return JSON.stringify(recipe);
}

/** Parse recipe JSON; returns null for corrupt payloads. Migrates old versions. */
export function deserializeRecipe(json: string): EtlRecipe | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Partial<EtlRecipe>;
  if (!Array.isArray(r.nodes) || !Array.isArray(r.edges)) return null;
  const version = typeof r.version === 'number' ? r.version : 0;
  const migrated = migrateRecipe({ ...(r as EtlRecipe), version });
  return migrated;
}

/** Migrate older recipe versions forward, filling defaults. */
export function migrateRecipe(recipe: EtlRecipe): EtlRecipe {
  if (recipe.version >= ETL_RECIPE_VERSION) {
    return { ...recipe, version: ETL_RECIPE_VERSION };
  }
  // v0 -> v1: schedule and failurePolicy did not exist yet.
  return {
    ...recipe,
    version: ETL_RECIPE_VERSION,
    schedule: recipe.schedule ?? { trigger: 'manual' },
    failurePolicy: { ...defaultFailurePolicy(), ...(recipe.failurePolicy ?? {}) },
  };
}

/** Human-readable label for a node, for the editor's applied-step list. */
export function nodeLabel(node: EtlNode): string {
  if (node.label) return node.label;
  if (node.kind === 'source') {
    const s = node.source;
    switch (s.type) {
      case 'csv-text': return 'Source: CSV text';
      case 'json-text': return 'Source: JSON text';
      case 'url': return `Source: ${s.url}`;
      case 'connector': return `Source: ${s.connectorId}`;
    }
  }
  if (node.kind === 'load') {
    const t = node.target;
    return t.kind === 'workbook-table'
      ? `Load: ${t.tableName} → ${t.sheetName}`
      : `Load: adapter ${t.adapterId}`;
  }
  const t = node.transform;
  switch (t.op) {
    case 'select': return `Keep columns: ${t.columns.join(', ')}`;
    case 'drop': return `Drop columns: ${t.columns.join(', ')}`;
    case 'rename': return `Rename: ${Object.entries(t.mapping).map(([k, v]) => `${k}→${v}`).join(', ')}`;
    case 'convert': return `Convert ${t.column} to ${t.to}`;
    case 'filter': return `Filter ${t.column} ${t.operator} ${t.value ?? ''}`.trim();
    case 'sort': return `Sort by ${t.keys.map((k) => `${k.column} ${k.dir}`).join(', ')}`;
    case 'split': return `Split ${t.column} into ${t.into.join(', ')}`;
    case 'merge-columns': return `Merge ${t.columns.join(' + ')} into ${t.into}`;
    case 'pivot': return `Pivot ${t.value} by ${t.column} (${t.agg})`;
    case 'unpivot': return `Unpivot into ${t.variableColumn}/${t.valueColumn}`;
    case 'join': return `Join (${t.how}) on ${t.on.join(', ')}`;
    case 'append': return 'Append tables';
    case 'group-by': return `Group by ${t.keys.join(', ')}`;
    case 'fill-down': return `Fill down ${t.column}`;
    case 'deduplicate': return `Deduplicate${t.columns ? ` on ${t.columns.join(', ')}` : ''}`;
    case 'custom': return `Custom ${t.language} transform`;
  }
}
