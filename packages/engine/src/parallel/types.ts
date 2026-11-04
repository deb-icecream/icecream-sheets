/**
 * Parallel recalculation (track 13): shared types for the worker pool,
 * partition planner, and the worker wire protocol.
 *
 * Design: HyperFormula itself is single-threaded, so parallel recalculation
 * partitions the workbook's dependency graph by INDEPENDENT CALC CHAINS
 * (Cycle 10, Excel-style): formula cells are levelised by topological depth
 * over the dependency graph. Cells at the same depth have no dependencies
 * on each other, so they are split across workers; a cell's dependents sit
 * in later stages and therefore serialize behind it in topological order.
 * Cells caught in (or downstream of) a dependency cycle are merged into a
 * single partition that evaluates together, exactly as serial iterative
 * calculation would. Each partition is evaluated in its own HyperFormula
 * instance inside a worker; cross-partition references are resolved by
 * injecting earlier stages' computed values as literal boundary cells.
 * The merge is deterministic: partitions own disjoint cell sets and
 * results are applied in sorted cell order, so parallel evaluation
 * produces exactly the serial values.
 *
 * Multithreading is an EXECUTION strategy, not a routing tier: this module
 * only decides how a large recalculation executes on whichever engine
 * host runs it (server engine for long chains, desktop engine, web
 * worker pool). Whether a recalculation is routed locally or to the
 * server is a separate, two-tier decision owned elsewhere.
 */
import type { CellInput } from '../workbook.js';
import type { CellRef, DefinedName } from '../types.js';
import type { SupportedLocale } from '../localization.js';
import type { ExternalLink } from '../external-refs.js';

/** JSON-safe computed value (TypedView.toJson output). */
export type JsonValue =
  | number
  | string
  | boolean
  | null
  | { error: string }
  | { image: string };

/** One sheet's full contents for a worker: formulas and literals. */
export interface PartitionSheet {
  name: string;
  cells: Array<{ row: number; col: number; input: CellInput }>;
}

/** A precedent cell living in another partition, injected as a literal. */
export interface BoundaryCell {
  sheet: string;
  row: number;
  col: number;
  value: JsonValue;
}

/** A unit of parallel work: owned formula cells + boundary reads from elsewhere. */
export interface RecalcPartition {
  /**
   * Formula cells OWNED by this partition: disjoint across all partitions
   * of the plan; every formula cell is owned by exactly one partition.
   * Sorted deterministically by (sheet, row, col).
   */
  cells: CellRef[];
  /** Sheets that hold owned cells (distinct, sorted) — informational. */
  sheets: string[];
  /**
   * Precedent cells not owned by this partition (deduped): literals and
   * earlier-stage formula values, injected into the worker as literals.
   */
  boundary: CellRef[];
}

/** Partition plan: stages of mutually independent partitions. */
export interface PartitionPlan {
  /** stages[i] = partitions safe to evaluate concurrently. */
  stages: RecalcPartition[][];
  /** Formula cells across the whole workbook. */
  formulaCellCount: number;
  /** ALL non-empty cells (formulas + literals) across the workbook. */
  totalCellCount: number;
  usesProviderBackedFunctions: boolean;
  /**
   * Set only when planning stopped early (PlanPartitionsOptions.earlyExit):
   * after `stagesCompleted` stages the planner PROVED the finished plan
   * would be degenerate — even the most favorable completion of the
   * remaining graph (every remaining formula cell becoming its own
   * partition, packed into the fewest possible stages) cannot lift the
   * average stage width to `maxPossibleAvgWidth`'s bound, which is
   * already below the caller's floor. `stages` is empty in that case:
   * no plan exists to execute, and the caller must fall back to serial
   * (which is always value-identical — see parallel-recalc.ts).
   */
  degenerateEarlyExit?: {
    stagesCompleted: number;
    partitionsCompleted: number;
    maxPossibleAvgWidth: number;
    unprocessedFormulaCells: number;
  };
}

/** Worker request: everything a worker needs, nothing shared. */
export interface RecalcRequest {
  jobId: string;
  /**
   * Stable identity of the partition this request belongs to (stage +
   * index within the stage, e.g. "s0p1"). Two partitions may own cells
   * on the SAME sheet, so sheet names alone cannot key the worker-side
   * workbook cache — the partition id can. Omitted by hand-built
   * requests; the cache then falls back to the sheet-name key.
   */
  partitionId?: string;
  /**
   * Stable ID for the workbook across recalculateParallel() calls. Lets
   * the worker cache its parsed EngineWorkbook and apply only changed
   * cells on subsequent runs (parse once, not per recalc).
   */
  workbookId: string;
  /** Force a full rebuild, ignoring any cached workbook. */
  fullRebuild: boolean;
  /**
   * Delta request: `sheets` contains ONLY changed cells (not the full
   * partition). The worker applies them to its cached workbook and skips
   * the deletion pass. Requires a warm worker cache; the worker throws a
   * cache-miss error otherwise.
   */
  deltaOnly: boolean;
  /** This partition's sheets (formulas + literals). */
  sheets: PartitionSheet[];
  /** Stub sheets for upstream partitions (computed literals only). */
  boundarySheets: Array<{
    name: string;
    cells: Array<{ row: number; col: number; value: JsonValue }>;
  }>;
  definedNames: DefinedName[];
  /** Named expressions (HF-level, usable in formulas), workbook + sheet scope. */
  namedExpressions: Array<{ name: string; formula: string; sheetIndex?: number }>;
  /**
   * External workbook links ([N]Sheet!Ref). Workers resolve ICEEXTREF
   * against cached values identically to the serial path; live providers
   * never cross the worker boundary (parallel-recalc stays serial while
   * any are registered).
   */
  externalLinks?: ExternalLink[];
  language: SupportedLocale;
}

/** Worker response: computed values for the partition's content cells. */
export interface RecalcResponse {
  jobId: string;
  values: Array<{ sheet: string; row: number; col: number; value: JsonValue }>;
  /** Set when the worker could not compute (serial fallback applies). */
  error?: string;
}

/** Platform worker abstraction: worker_threads (Node) or Web Workers (browser). */
export interface WorkerBackend {
  run(req: RecalcRequest): Promise<RecalcResponse>;
  dispose(): void;
}

export interface WorkerBackendFactory {
  create(): WorkerBackend;
}

export interface ParallelRecalcOptions {
  enabled: boolean;
  workerCount: number;
  /**
   * Minimum formula cells before the parallel path is used. Below this,
   * worker spawn/startup overhead exceeds the gain — serial wins.
   */
  minFormulaCells?: number;
  /**
   * Automatic-multithreading gate (Cycle 10, user's ruling): the total
   * number of non-empty cells in the workbook must EXCEED this threshold
   * before multithreaded recalc engages at all — thread overhead is not
   * worth it on small models (mirrors Excel). Distinct from
   * minFormulaCells, which counts formula work only. Default
   * DEFAULT_PARALLEL_CELL_THRESHOLD (5,000 — a starting point at P75
   * scale, to be tuned from Cycle 10 Phase 4 perf measurements).
   * Configurable via settings (this field) or the
   * ICECREAM_MT_CELL_COUNT_THRESHOLD env var (resolveParallelCellThreshold;
   * ICECREAM_PARALLEL_CELL_THRESHOLD is a legacy alias).
   * Set to 0 to gate only on there being any cells at all.
   */
  cellCountThreshold?: number;
}

export interface ParallelRecalcStats {
  /** False when the serial fallback was used. */
  parallel: boolean;
  partitions: number;
  stages: number;
  workersUsed: number;
  cellsComputed: number;
  elapsedMs: number;
  /** Why the serial path was used (when parallel === false). */
  reason?: string;
}

export const DEFAULT_MIN_FORMULA_CELLS = 2000;
export const MAX_WORKERS = 64;

/**
 * Starting-point threshold for the automatic multithreading flag (Cycle 10).
 * A workbook whose total non-empty cell count EXCEEDS this value
 * automatically qualifies for multithreaded recalc; at or below it,
 * recalculation stays single-threaded. 5,000 is a P75-scale starting
 * point — the final value gets tuned from Cycle 10 Phase 4 perf
 * measurements, so consume it via resolveParallelCellThreshold() or
 * shouldEnableParallelRecalc() rather than hard-coding.
 */
export const DEFAULT_PARALLEL_CELL_THRESHOLD = 5000;

/**
 * Automatic-multithreading flag (Cycle 10, pure + unit-testable).
 * Returns true iff the workbook's total non-empty cell count exceeds the
 * threshold.
 *
 * ONE FLAG, TWO CONSEQUENCES — always together (user's final rule, not
 * two separate mechanisms):
 *   Flag ON (total cells > threshold):
 *     (1) The client gets NO local mirror — values only, no formulas —
 *         so the client cannot recalc anything and EVERY edit routes to
 *         the server unconditionally (no local routing rule is even
 *         evaluated — tiny/short/single-chain alike).
 *     (2) The server enables multithreaded recalc — independent chains in
 *         parallel, Excel-style; dependent chains serialize.
 *   Flag OFF (total cells ≤ threshold):
 *     (1) A FULL local mirror ships at open — every cell's formula +
 *         cached value + data type (not just display values) — so the
 *         client builds a local engine and the local routing rules apply.
 *     (2) Server multithreading stays off (single thread).
 *
 * Fully automatic: the engine reads the flag itself; no per-edit decision
 * and no user prompt. The threshold value is configurable (settings),
 * tuned from Phase 4 gateway-mode perf measurements — consume it via
 * resolveParallelCellThreshold() or shouldEnableParallelRecalc() rather
 * than hard-coding.
 *
 * Server dispatch contract: a SINGLE-chain affected set runs
 * single-threaded regardless of this flag (a lone chain cannot
 * parallelize internally — fan-out is pointless); for MULTI-chain
 * affected sets the server uses this flag to pick parallel
 * (flag ON: independent chains in parallel, dependents serialize) vs
 * single-thread (flag OFF). The PartitionPlan's stage-independence guard
 * in ParallelRecalculator belts-and-braces this: when no stage has ≥2
 * partitions it falls back to serial anyway.
 */
export function shouldEnableParallelRecalc(
  totalCellCount: number,
  threshold: number = DEFAULT_PARALLEL_CELL_THRESHOLD,
): boolean {
  const count = Number.isFinite(totalCellCount) ? Math.floor(totalCellCount) : 0;
  const t =
    Number.isFinite(threshold) && threshold >= 0 ? Math.floor(threshold) : DEFAULT_PARALLEL_CELL_THRESHOLD;
  return count > t;
}

/**
 * Resolve the cell-count threshold from configuration (env/settings seam).
 * The canonical env var is ICECREAM_MT_CELL_COUNT_THRESHOLD (shared with
 * the recalc-routing layer's hybridRecalcConfigFromEnv in calc-chain.ts —
 * one threshold, one name); ICECREAM_PARALLEL_CELL_THRESHOLD is honored
 * as a legacy alias. Malformed values fall back to the default rather
 * than silently disabling parallelism. `env` is injected (never reads
 * process.env directly) so browser bundles stay clean.
 *
 * Predicate note: shouldEnableParallelRecalc is deliberately the same
 * comparison the routing layer exposes as autoMtEnabled (calc-chain.ts)
 * for every threshold ≥ 1. One deliberate difference: this module's
 * options layer accepts threshold 0 as an escape hatch ("gate on any
 * cell at all"); the routing layer's config normalization rejects < 1
 * before a value can reach either predicate — so hosts consuming either
 * seam observe identical behavior.
 *
 * @param env e.g. process.env on Node, or a settings-derived map
 */
export function resolveParallelCellThreshold(
  env: {
    ICECREAM_MT_CELL_COUNT_THRESHOLD?: string;
    ICECREAM_PARALLEL_CELL_THRESHOLD?: string;
  } = {},
): number {
  const raw =
    env['ICECREAM_MT_CELL_COUNT_THRESHOLD'] ?? env['ICECREAM_PARALLEL_CELL_THRESHOLD'];
  if (raw !== undefined && raw !== '') {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 0) return n;
    // Malformed override: fall through to the default rather than
    // silently changing the threading behavior.
  }
  return DEFAULT_PARALLEL_CELL_THRESHOLD;
}

/** Hardware concurrency on every target (browsers + Node 21+). */
export function defaultWorkerCount(): number {
  try {
    const n = navigator.hardwareConcurrency;
    if (typeof n === 'number' && n > 0) return Math.min(n, MAX_WORKERS);
  } catch {
    // navigator unavailable — fall through
  }
  return 4;
}

export function defaultParallelOptions(): ParallelRecalcOptions {
  return {
    enabled: false,
    workerCount: defaultWorkerCount(),
    minFormulaCells: DEFAULT_MIN_FORMULA_CELLS,
    cellCountThreshold: DEFAULT_PARALLEL_CELL_THRESHOLD,
  };
}

export function normalizeParallelOptions(
  opts: Partial<ParallelRecalcOptions>,
): ParallelRecalcOptions {
  const base = defaultParallelOptions();
  return {
    enabled: opts.enabled ?? base.enabled,
    workerCount: Math.max(
      1,
      Math.min(MAX_WORKERS, Math.floor(opts.workerCount ?? base.workerCount) || base.workerCount),
    ),
    minFormulaCells: Math.max(0, Math.floor(opts.minFormulaCells ?? base.minFormulaCells ?? 0)),
    cellCountThreshold: Math.max(
      0,
      Math.floor(opts.cellCountThreshold ?? base.cellCountThreshold ?? DEFAULT_PARALLEL_CELL_THRESHOLD),
    ),
  };
}
