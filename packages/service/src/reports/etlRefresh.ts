/**
 * Report refresh through the ETL pipeline
 * (design-docs/native-reports-and-dashboards.md §6: "ETL-backed tables
 * refresh through the pipeline").
 *
 * Service-layer orchestration: for every distinct ETL recipe referenced by
 * the spec's bindings, run the recipe once through the ETL runner before
 * the report visuals recompute. The runner itself is host-injected — this
 * module never touches the engine, storage, or network; the host supplies
 * fetch/writer/versions through its own RunnerDeps (see etl/runner.ts).
 */

import type { RunRecord } from '../etl/store.js';
import { collectEtlRecipeIds, type ReportSpec } from './spec.js';

/** Host port: execute one ETL recipe and return its run record. */
export interface EtlRefreshPort {
  runEtlRecipe: (recipeId: string) => Promise<RunRecord>;
}

/** One completed pipeline run (the record may report succeeded/failed/aborted). */
export interface EtlRefreshCompleted {
  recipeId: string;
  run: RunRecord;
}

/** A runner rejection: invalid recipe, denied permission, missing recipe, I/O. */
export interface EtlRefreshThrown {
  recipeId: string;
  error: string;
}

export interface EtlRefreshSummary {
  /** Recipes whose runner resolved (check run.status for the outcome). */
  completed: EtlRefreshCompleted[];
  /** Recipes whose runner rejected. */
  thrown: EtlRefreshThrown[];
  /** Referenced recipe ids not run because no port was supplied. */
  skipped: string[];
}

/**
 * Run the ETL pipeline for every ETL-backed binding's recipe, each once,
 * in binding order. A runner rejection for one recipe does not stop the
 * others; the summary reports per-recipe outcomes so the caller can show
 * data freshness honestly (design §6: "The report shows the data timestamp").
 */
export async function refreshReportEtlBindings(
  spec: ReportSpec,
  port: EtlRefreshPort | undefined,
): Promise<EtlRefreshSummary> {
  const recipeIds = collectEtlRecipeIds(spec);
  const summary: EtlRefreshSummary = { completed: [], thrown: [], skipped: [] };
  for (const recipeId of recipeIds) {
    if (!port) {
      summary.skipped.push(recipeId);
      continue;
    }
    try {
      const run = await port.runEtlRecipe(recipeId);
      summary.completed.push({ recipeId, run });
    } catch (e) {
      summary.thrown.push({ recipeId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summary;
}
