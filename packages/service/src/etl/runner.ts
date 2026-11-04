/**
 * ETL pipeline — recipe runner.
 *
 * Per design-docs/etl-pipeline.md:
 * - §1: runs are asynchronous with progress and per-step row counts; on
 *   completion the runner emits a change event and the engine recalculates
 *   normally. Formulas never trigger a refresh.
 * - §4: every run materializes a full copy and swaps it in atomically, so
 *   readers never see a partially written table. Old versions are retained
 *   per the retention policy; a failed run never replaces the last good load.
 * - §5: retry transient failures with backoff; quarantine rows that fail
 *   transformation with their reasons; abort when the error threshold is
 *   exceeded; always preserve the previous loaded table on failed runs.
 * - §6: the recipe stores only credential references; a scheduled run
 *   executes as the pipeline owner. Running requires read on the credential
 *   and write on the target, enforced through the authorize() port
 *   (permissions.ts); the legacy checkPermission hook still overrides when
 *   a host supplies it.
 */

import { TransientCustomError, runCustomTransform, type CustomCodeRunner } from './custom.js';
import {
  makeRecipeRunCheck,
  type AuthorizePort,
} from './permissions.js';
import {
  DEFAULT_RETENTION,
  nodeLabel,
  validateRecipe,
  type EtlNode,
  type EtlRecipe,
  type LoadTarget,
  type TableRef,
  type TransformOp,
} from './recipe.js';
import { readSource, type SourceDeps } from './sources.js';
import {
  targetKey,
  type QuarantinedRow,
  type RunRecord,
  type RunStatus,
  type RunStepRecord,
  type TableVersion,
  type VersionStore,
} from './store.js';
import { applyTransform } from './transforms.js';
import type { EtlTable } from './types.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { CredentialResolver } from './connectors.js';

export type { RunStatus, QuarantinedRow };

export interface ProgressEvent {
  recipeId: string;
  nodeId: string;
  kind: string;
  label: string;
  phase: 'start' | 'done';
  attempt: number;
  rowsIn: number;
  rowsOut: number;
}

export interface ChangeEvent {
  recipeId: string;
  target: LoadTarget;
  rows: number;
}

/**
 * All-or-nothing table writer, implemented by the host through the engine
 * protocol (e.g. one authorized transaction that clears the target range
 * and writes the new values). The runner relies on the contract: either
 * the whole table is visible afterwards, or nothing changed.
 */
export interface TableWriter {
  writeAtomic(target: LoadTarget, table: EtlTable): Promise<void>;
  /** Read the currently loaded table, for version retention. Null = unknown. */
  readCurrent?(target: LoadTarget): Promise<EtlTable | null>;
}

export interface RunnerDeps {
  fetchText: (url: string) => Promise<string>;
  connectors?: ConnectorRegistry;
  vault?: CredentialResolver;
  /** Sandboxed code runner for `custom` steps. Absent = custom steps fail closed. */
  runCode?: CustomCodeRunner;
  writer: TableWriter;
  versions?: VersionStore;
  /** Resolve non-literal TableRefs (workbook ranges, other recipes). */
  resolveTableRef?: (ref: TableRef) => Promise<EtlTable>;
  /**
   * Permission check: read on credential + write on target. Throw to deny.
   * Legacy host hook — when present it overrides the authorize() port below.
   */
  checkPermission?: (recipe: EtlRecipe) => Promise<void>;
  /**
   * Structural authorize() port (design-docs/etl-pipeline.md §6). When
   * supplied and no checkPermission hook is present, the runner enforces
   * the §6 run rights itself: read on every credential the recipe uses and
   * write on the load target (see permissions.ts). `principal` is required;
   * a missing principal fails closed.
   */
  authorize?: AuthorizePort;
  /** Acting principal for the authorize() port. */
  principal?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onProgress?: (e: ProgressEvent) => void;
  onChange?: (e: ChangeEvent) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A failure is transient (worth retrying) when the error says so. */
export function isTransientError(e: unknown): boolean {
  if (e instanceof TransientCustomError) return true;
  if (typeof e === 'object' && e !== null && (e as { transient?: unknown }).transient === true) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|HTTP 5\d\d|HTTP 429|rate limit|temporarily unavailable/i.test(msg);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries: number;
    backoffBaseMs: number;
    backoffMultiplier: number;
    sleep: (ms: number) => Promise<void>;
    onAttempt?: (attempt: number) => void;
  },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    opts.onAttempt?.(attempt);
    try {
      return await fn();
    } catch (e) {
      if (attempt >= opts.maxRetries || !isTransientError(e)) throw e;
      await opts.sleep(opts.backoffBaseMs * Math.pow(opts.backoffMultiplier, attempt));
      attempt++;
    }
  }
}

function newRunId(startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[-:.TZ]/g, '');
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
  return `run_${stamp}_${rand}`;
}

function checkThreshold(
  quarantined: number,
  sourceRows: number,
  fp: EtlRecipe['failurePolicy'],
): string | null {
  if (fp.maxErrorRows !== undefined && quarantined > fp.maxErrorRows) {
    return `error threshold exceeded: ${quarantined} quarantined rows > max ${fp.maxErrorRows}`;
  }
  if (fp.errorThresholdPct !== undefined && sourceRows > 0) {
    const pct = (quarantined / sourceRows) * 100;
    if (pct > fp.errorThresholdPct) {
      return `error threshold exceeded: ${pct.toFixed(1)}% quarantined rows > ${fp.errorThresholdPct}%`;
    }
  }
  return null;
}

/**
 * Execute a recipe end-to-end. Run-level failures are captured in the
 * returned RunRecord (status failed/aborted); the function throws only for
 * invalid recipes and denied permissions.
 */
export async function runRecipe(recipe: EtlRecipe, deps: RunnerDeps): Promise<RunRecord> {
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const startedAt = clock();

  const issues = validateRecipe(recipe);
  if (issues.length > 0) {
    throw new Error(`invalid recipe: ${issues[0].message}`);
  }
  if (deps.checkPermission) {
    await deps.checkPermission(recipe); // throws on denial
  } else if (deps.authorize) {
    // etl-pipeline.md §6, wired: read on credential + write on target.
    await makeRecipeRunCheck(deps.authorize, deps.principal ?? '')(recipe);
  }

  const steps: RunStepRecord[] = [];
  const quarantined: QuarantinedRow[] = [];
  const fp = recipe.failurePolicy;
  const retryOpts = {
    maxRetries: fp.maxRetries,
    backoffBaseMs: fp.backoffBaseMs,
    backoffMultiplier: fp.backoffMultiplier,
    sleep,
  };

  // Execution order: single chain source -> ... -> load (validated above).
  const byId = new Map(recipe.nodes.map((n) => [n.id, n]));
  const next = new Map(recipe.edges.map((e) => [e.from, e.to]));
  const ordered: EtlNode[] = [];
  let cursor: EtlNode | undefined = recipe.nodes.find((n) => n.kind === 'source');
  while (cursor) {
    ordered.push(cursor);
    const nxt = next.get(cursor.id);
    cursor = nxt === undefined ? undefined : byId.get(nxt);
  }

  const finish = (
    status: 'succeeded' | 'failed' | 'aborted',
    rowsLoaded: number,
    error?: string,
  ): RunRecord => ({
    id: newRunId(startedAt),
    recipeId: recipe.id,
    recipeName: recipe.name,
    startedAt: startedAt.toISOString(),
    finishedAt: clock().toISOString(),
    status,
    steps,
    rowsLoaded,
    quarantined,
    ...(error ? { error } : {}),
  });

  const progress = (e: Omit<ProgressEvent, 'recipeId'>): void => {
    deps.onProgress?.({ ...e, recipeId: recipe.id });
  };

  let current: EtlTable | null = null;
  let sourceRowCount = 0;

  try {
    for (const node of ordered) {
      const label = nodeLabel(node);
      const t0 = Date.now();
      const recordStep = (rowsIn: number, rowsOut: number, q: number): void => {
        steps.push({
          nodeId: node.id,
          kind: node.kind === 'transform' ? (node.transform as TransformOp).op : node.kind,
          label,
          rowsIn,
          rowsOut,
          quarantined: q,
          ms: Date.now() - t0,
        });
      };

      if (node.kind === 'source') {
        progress({ nodeId: node.id, kind: 'source', label, phase: 'start', attempt: 0, rowsIn: 0, rowsOut: 0 });
        const table = await withRetry(
          () =>
            readSource(node.source, {
              fetchText: deps.fetchText,
              connectors: deps.connectors,
              vault: deps.vault,
            } satisfies SourceDeps),
          {
            ...retryOpts,
            onAttempt: (attempt) =>
              progress({ nodeId: node.id, kind: 'source', label, phase: 'start', attempt, rowsIn: 0, rowsOut: 0 }),
          },
        );
        current = table;
        sourceRowCount = table.rows.length;
        recordStep(0, table.rows.length, 0);
        progress({ nodeId: node.id, kind: 'source', label, phase: 'done', attempt: 0, rowsIn: 0, rowsOut: table.rows.length });
      } else if (node.kind === 'transform') {
        const op = node.transform;
        const rowsIn = current!.rows.length;
        progress({ nodeId: node.id, kind: op.op, label, phase: 'start', attempt: 0, rowsIn, rowsOut: 0 });

        let result: EtlTable;
        let failures: { rowIndex: number; column?: string; reason: string }[] = [];
        if (op.op === 'custom') {
          if (!deps.runCode) {
            throw new Error(
              `custom transform "${node.id}" needs a sandboxed code runner — this host does not provide one`,
            );
          }
          result = await withRetry(
            () => runCustomTransform(current!, { language: op.language, code: op.code, timeoutMs: op.timeoutMs }, deps.runCode!),
            retryOpts,
          );
        } else if (op.op === 'join' || op.op === 'append') {
          const other = await resolveTableRef(op.with, deps);
          const r = applyTransform(current!, op, () => other);
          result = r.table;
          failures = r.failures;
        } else {
          // Pure transforms: logic errors are permanent, no retry.
          const r = applyTransform(current!, op);
          result = r.table;
          failures = r.failures;
        }

        if (failures.length > 0) {
          if (!fp.quarantine) {
            const f = failures[0];
            throw new Error(
              `transform "${node.id}" failed on row ${f.rowIndex}${f.column ? ` column "${f.column}"` : ''}: ${f.reason}`,
            );
          }
          for (const f of failures) {
            quarantined.push({
              stepId: node.id,
              rowIndex: f.rowIndex,
              row: current!.rows[f.rowIndex] ?? {},
              reason: f.reason,
            });
          }
        }
        current = result;
        recordStep(rowsIn, result.rows.length, failures.length);
        progress({ nodeId: node.id, kind: op.op, label, phase: 'done', attempt: 0, rowsIn, rowsOut: result.rows.length });
      } else {
        // Load node.
        const rowsIn = current!.rows.length;
        progress({ nodeId: node.id, kind: 'load', label, phase: 'start', attempt: 0, rowsIn, rowsOut: 0 });

        // Error threshold: abort BEFORE touching the target.
        const thresholdError = checkThreshold(quarantined.length, sourceRowCount, fp);
        if (thresholdError) {
          recordStep(rowsIn, 0, 0);
          return finish('aborted', 0, thresholdError);
        }

        // Retain the previous loaded table BEFORE the atomic swap.
        const retention = node.retention ?? DEFAULT_RETENTION;
        if (deps.versions && retention > 0 && deps.writer.readCurrent) {
          const prev = await deps.writer.readCurrent(node.target);
          if (prev && prev.rows.length > 0) {
            const version: TableVersion = {
              versionId: `ver_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
              recipeId: recipe.id,
              targetKey: targetKey(node.target),
              target: node.target,
              savedAt: clock().toISOString(),
              table: prev,
            };
            await deps.versions.push(version, retention);
          }
        }

        try {
          await deps.writer.writeAtomic(node.target, current!);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          recordStep(rowsIn, 0, 0);
          return finish('failed', 0, `load failed — previous table preserved: ${message}`);
        }
        recordStep(rowsIn, current!.rows.length, 0);
        progress({ nodeId: node.id, kind: 'load', label, phase: 'done', attempt: 0, rowsIn, rowsOut: current!.rows.length });
        deps.onChange?.({ recipeId: recipe.id, target: node.target, rows: current!.rows.length });
        return finish('succeeded', current!.rows.length);
      }
    }
    throw new Error('recipe has no load node');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return finish('failed', 0, message);
  }
}

async function resolveTableRef(ref: TableRef, deps: RunnerDeps): Promise<EtlTable> {
  if (ref.kind === 'literal') return ref.table;
  if (deps.resolveTableRef) return deps.resolveTableRef(ref);
  throw new Error(
    `table ref kind "${ref.kind}" needs a host resolver (resolveTableRef) — this host does not provide one`,
  );
}

/**
 * Build a TableRef resolver that serves `{ kind: 'recipe' }` refs from the
 * latest retained version of the referenced recipe. Workbook-range refs
 * still need the host (they read through the engine's typed view).
 */
export function makeVersionStoreResolver(
  versions: VersionStore,
  extra?: (ref: TableRef) => Promise<EtlTable>,
): (ref: TableRef) => Promise<EtlTable> {
  return async (ref: TableRef): Promise<EtlTable> => {
    if (ref.kind === 'recipe') {
      const v = await versions.latestForRecipe(ref.recipeId);
      if (!v) throw new Error(`no retained version for recipe "${ref.recipeId}"`);
      return v.table;
    }
    if (extra) return extra(ref);
    throw new Error(`table ref kind "${ref.kind}" needs a host resolver`);
  };
}
