/**
 * Parallel recalculation orchestrator (track 13, Cycle 10 chain partitioning).
 *
 * Takes a workbook snapshot, partitions it by independent calc chains (see
 * partition.ts), evaluates each stage's independent partitions concurrently
 * in workers, and merges results deterministically.
 *
 * Multithreading is an EXECUTION strategy, not a routing tier: this class
 * decides how a large recalculation executes on whichever engine host runs
 * it (server engine for long chains, desktop engine, web worker pool). The
 * automatic-multithreading gate (shouldEnableParallelRecalc) applies on
 * TOTAL non-empty cell count, not formula count — thread overhead is not
 * worth it on small models, mirroring Excel.
 *
 * Correctness argument: partitions own disjoint cell sets; every
 * cross-partition read is served from an earlier stage's computed values
 * (or from literals, which never change). Cells in the same stage have no
 * dependencies on each other by construction (topological depth), so
 * splitting them across workers is order-independent. Each cell's value is
 * therefore a pure function of fixed inputs — the parallel merge equals
 * the serial recalculation exactly. The fallback guards (no independent
 * partitions, below the cell-count gate, below the formula-cell threshold,
 * provider-backed functions) choose serial instead of producing a wrong
 * or misleading result.
 */
import type { EngineWorkbook } from '../workbook.js';
import { TypedView } from '../view.js';
import type { CellRef, TypedValue } from '../types.js';
import { planPartitions } from './partition.js';
import { RecalcWorkerPool, InlineWorkerBackend } from './pool.js';
import type {
  JsonValue,
  ParallelRecalcOptions,
  ParallelRecalcStats,
  RecalcRequest,
  WorkerBackendFactory,
} from './types.js';
import {
  DEFAULT_MIN_FORMULA_CELLS,
  DEFAULT_PARALLEL_CELL_THRESHOLD,
  shouldEnableParallelRecalc,
} from './types.js';

export interface ParallelRecalcResult {
  merged: Array<{ ref: CellRef; value: TypedValue }>;
  stats: ParallelRecalcStats;
}

function keyOf(sheet: string, row: number, col: number): string {
  return `${sheet}\u0000${row}\u0000${col}`;
}

/**
 * Minimum AVERAGE partitions per stage for the parallel path to pay off:
 * below this the plan is chain-dominated and per-stage orchestration costs
 * more than the parallel compute saves (see the degenerate-plan guard).
 */
export const MIN_AVG_STAGE_WIDTH = 4;

/**
 * Stage-count floor for the degenerate-plan guard: plans with at most this
 * many stages are never "degenerate" — their total orchestration cost is
 * trivial regardless of width.
 */
export const DEGENERATE_STAGE_FLOOR = 64;

let jobSeq = 0;

export class ParallelRecalculator {
  constructor(private readonly factory?: WorkerBackendFactory) {}

  /**
   * Recalculate the workbook. Returns merged values + stats. When the
   * parallel path is not applicable, stats.parallel is false and merged is
   * empty — the caller falls back to the serial recalculate().
   *
   * @param pool shared worker pool (reused across recalcs). When omitted, a
   * temporary pool is created and disposed.
   */
  async recalculate(
    wb: EngineWorkbook,
    opts: ParallelRecalcOptions,
    poolArg?: RecalcWorkerPool,
  ): Promise<ParallelRecalcResult> {
    const t0 = Date.now();
    const no = (reason: string): ParallelRecalcResult => ({
      merged: [],
      stats: {
        parallel: false,
        partitions: 0,
        stages: 0,
        workersUsed: 0,
        cellsComputed: 0,
        elapsedMs: Date.now() - t0,
        reason,
      },
    });
    if (!opts.enabled) return no('parallel recalculation disabled');
    // The planner gets the degenerate-guard constants as its early-exit
    // parameters (Cycle 10 closure, defect 6 residual): a chain-dominated
    // workbook's plan is PROVEN degenerate after a few dozen stages and
    // planning stops there, instead of walking the whole workbook's
    // precedents (18.7 s on the P95 workbook) before the guard below can
    // fire. Repeat calls reuse the cached plan/verdict keyed by the
    // workbook's graph version (see partition.ts).
    const plan = planPartitions(wb, {
      workerCount: opts.workerCount,
      earlyExit: { stageFloor: DEGENERATE_STAGE_FLOOR, minAvgWidth: MIN_AVG_STAGE_WIDTH },
    });
    if (plan.usesProviderBackedFunctions) {
      return no('workbook uses provider-backed functions (PY/COPILOT/WEBSERVICE/STOCKHISTORY/RTD)');
    }
    if (plan.degenerateEarlyExit) {
      const e = plan.degenerateEarlyExit;
      return no(
        `degenerate plan (proven during planning: after ${e.stagesCompleted} stages the maximum ` +
          `possible average stage width is ${e.maxPossibleAvgWidth.toFixed(2)} < ${MIN_AVG_STAGE_WIDTH} ` +
          `— dependent chains serialize; stage orchestration dominates)`,
      );
    }
    // Live external-workbook providers live in the host's JS realm and do
    // not cross worker boundaries; cached values alone are worker-safe.
    if (wb.usesLiveExternalProviders()) {
      return no('workbook uses live external-workbook providers');
    }
    // Automatic-multithreading gate (Cycle 10): total non-empty cells must
    // EXCEED the threshold. Below it, thread overhead is not worth it —
    // serial stays the fast, correct choice. Configurable via the
    // cellCountThreshold option or ICECREAM_MT_CELL_COUNT_THRESHOLD.
    const cellThreshold = opts.cellCountThreshold ?? DEFAULT_PARALLEL_CELL_THRESHOLD;
    if (!shouldEnableParallelRecalc(plan.totalCellCount, cellThreshold)) {
      return no(
        `below auto-MT cell threshold (${plan.totalCellCount} <= ${cellThreshold} total cells; ` +
          `multithreaded recalc auto-enables only above it)`,
      );
    }
    const totalPartitions = plan.stages.reduce((n, s) => n + s.length, 0);
    const maxStagePartitions = plan.stages.reduce((m, s) => Math.max(m, s.length), 0);
    if (maxStagePartitions < 2) {
      return no('single partition (no independent chains at any stage — dependent chains serialize)');
    }
    // Degenerate-plan guard (Cycle 10 finisher): a plan can pass the max-
    // width check yet still be effectively serial — e.g. a running-balance
    // chain whose per-row status cells give every stage width 2 while the
    // stage count runs to tens of thousands. Orchestration costs a worker
    // round-trip per stage, so a LONG thin plan spends its time on stage
    // churn, not parallel compute (measured: a 1.8M-cell workbook whose
    // Ledger chain produced ~30k stages of average width ~1.5 took ~12
    // minutes for the parallel pass vs seconds for the serial recalc it
    // repeats). Short plans are exempt: their absolute orchestration cost
    // is trivial either way. Past the stage floor, parallel only pays when
    // the AVERAGE stage keeps several workers busy; below that, serial is
    // both faster and already correct.
    const avgStageWidth = totalPartitions / Math.max(1, plan.stages.length);
    if (plan.stages.length > DEGENERATE_STAGE_FLOOR && avgStageWidth < MIN_AVG_STAGE_WIDTH) {
      return no(
        `degenerate plan (average stage width ${avgStageWidth.toFixed(2)} < ${MIN_AVG_STAGE_WIDTH} ` +
          `across ${plan.stages.length} stages — dependent chains serialize; stage orchestration dominates)`,
      );
    }
    const minCells = opts.minFormulaCells ?? DEFAULT_MIN_FORMULA_CELLS;
    if (plan.formulaCellCount < minCells) {
      return no(`below threshold (${plan.formulaCellCount} < ${minCells} formula cells)`);
    }

    // Suspension-safe tracked inputs (works in manual/suspended mode).
    // Inputs are keyed by cell so each partition's payload is exactly its
    // OWNED formula cells — other cells of the same sheet are NOT sent
    // (two partitions can own different chains on one sheet).
    type CellPayload = { row: number; col: number; input: Parameters<EngineWorkbook['setCell']>[1] };
    const inputByKey = new Map<string, CellPayload & { sheet: string }>();
    const formulaKeys = new Set<string>();
    const computed = new Map<string, JsonValue>();
    for (const { ref, input } of wb.getTrackedCells()) {
      const k = keyOf(ref.sheet, ref.row, ref.col);
      inputByKey.set(k, { sheet: ref.sheet, row: ref.row, col: ref.col, input });
      if (typeof input === 'string' && input.startsWith('=')) {
        formulaKeys.add(k);
      } else {
        // Literal: the input IS the JSON value (number/string/boolean/null).
        computed.set(k, input as JsonValue);
      }
    }

    // Delta requests are deliberately NOT used with chain partitioning: a
    // later-stage partition may have no owned changes while its boundary
    // (earlier-stage computed values) changed, so every partition must be
    // dispatched every run. Full owned-cell payloads are still cheap — the
    // worker diffs against its warm cache, so parsing stays one-time.
    const deltaOnly = false;

    const workerCount = Math.max(1, Math.min(opts.workerCount, totalPartitions));
    const factory: WorkerBackendFactory = this.factory ?? {
      create: () => new InlineWorkerBackend(),
    };
    // A caller-supplied pool is reused and NOT disposed; a temporary pool is
    // created and disposed per call.
    const pool = poolArg ?? new RecalcWorkerPool(factory, workerCount);
    const disposePool = poolArg === undefined;
    try {
      const language = wb.getFormulaLanguage();
      const definedNames = wb.getDefinedNames();
      const namedExpressions = wb.getTrackedNamedExpressions();
      for (let si = 0; si < plan.stages.length; si++) {
        const stage = plan.stages[si]!;
        const requests: RecalcRequest[] = stage.map((part, pi) => {
          // Group this partition's OWNED formula cells by sheet — only
          // these are sent as content cells. Boundary cells are injected
          // as literals from the running `computed` map, which already
          // holds literals plus every earlier stage's results.
          const owned = new Map<string, Array<{ row: number; col: number; input: CellPayload['input'] }>>();
          for (const ref of part.cells) {
            const payload = inputByKey.get(keyOf(ref.sheet, ref.row, ref.col));
            if (!payload) continue; // should not happen
            const arr = owned.get(ref.sheet) ?? [];
            arr.push({ row: ref.row, col: ref.col, input: payload.input });
            owned.set(ref.sheet, arr);
          }
          // Group this partition's boundary cells by sheet.
          const bySheet = new Map<string, Array<{ row: number; col: number; value: JsonValue }>>();
          for (const b of part.boundary) {
            const v = computed.get(keyOf(b.sheet, b.row, b.col)) ?? null;
            const arr = bySheet.get(b.sheet) ?? [];
            arr.push({ row: b.row, col: b.col, value: v });
            bySheet.set(b.sheet, arr);
          }
          return {
            jobId: `recalc-${++jobSeq}`,
            // Stable partition identity: two partitions may own cells on
            // the SAME sheet, so the worker cache cannot key on sheet
            // names alone.
            partitionId: `s${si}p${pi}`,
            workbookId: wb.getParallelWorkbookId(),
            fullRebuild: false,
            deltaOnly,
            sheets: [...owned.entries()].map(([name, cells]) => ({ name, cells })),
            boundarySheets: [...bySheet.entries()].map(([name, cells]) => ({ name, cells })),
            definedNames,
            namedExpressions,
            externalLinks: wb.getExternalLinks(),
            language,
          };
        });
        
        const responses = await pool.runAll(requests);
        for (const res of responses) {
          for (const v of res.values) {
            computed.set(keyOf(v.sheet, v.row, v.col), v.value);
          }
        }
      }
    } finally {
      if (disposePool) pool.dispose();
    }

    // Deterministic merge: every computed cell (literals AND formulas),
    // sorted by (sheet, row, col). Literals must be included: in manual
    // mode the host's value cache may hold stale pre-recalc values for
    // cells edited since the last calculation.
    const merged: Array<{ ref: CellRef; value: TypedValue }> = [];
    const sortedKeys = [...computed.keys()].sort();
    for (const k of sortedKeys) {
      const [sheet, row, col] = k.split('\u0000');
      const json = computed.get(k);
      if (json === undefined) continue; // should not happen
      merged.push({
        ref: { sheet: sheet!, row: Number(row), col: Number(col) },
        value: TypedView.fromJson(json),
      });
    }
    // Sanity: every formula cell must have a computed value.
    for (const k of formulaKeys) {
      if (!computed.has(k)) {
        throw new Error(`parallel recalc incomplete: missing ${k}`);
      }
    }
    return {
      merged,
      stats: {
        parallel: true,
        partitions: totalPartitions,
        stages: plan.stages.length,
        workersUsed: workerCount,
        cellsComputed: merged.length,
        elapsedMs: Date.now() - t0,
      },
    };
  }
}

