/**
 * Parallel recalculation (track 13).
 *
 * HyperFormula is single-threaded, so parallel recalculation partitions the
 * workbook's dependency graph into independent subgraphs (sheet-granular
 * partitions forming a DAG of stages). Each partition is evaluated in its
 * own HyperFormula instance inside a worker; cross-partition references are
 * resolved by injecting upstream partitions' computed values as literal
 * boundary cells. The merge is deterministic, so parallel results equal
 * serial results exactly.
 */
export type {
  JsonValue,
  PartitionSheet,
  BoundaryCell,
  RecalcPartition,
  PartitionPlan,
  RecalcRequest,
  RecalcResponse,
  WorkerBackend,
  WorkerBackendFactory,
  ParallelRecalcOptions,
  ParallelRecalcStats,
} from './types.js';
export {
  DEFAULT_MIN_FORMULA_CELLS,
  MAX_WORKERS,
  defaultWorkerCount,
  defaultParallelOptions,
  normalizeParallelOptions,
} from './types.js';
export { planPartitions } from './partition.js';
export { executePartition } from './worker-logic.js';
export {
  RecalcWorkerPool,
  InlineWorkerBackend,
  NodeWorkerBackend,
  defaultWorkerBackendFactory,
} from './pool.js';
export { ParallelRecalculator, type ParallelRecalcResult } from './parallel-recalc.js';
