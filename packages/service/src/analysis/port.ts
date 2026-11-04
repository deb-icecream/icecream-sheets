/**
 * AnalysisPort implementation for the chat intent router
 * (agent/intentRouter.ts: "Implemented by the data-analysis pipeline
 * lane (the `analyze_data` MCP tool)").
 *
 * The host (MCP server) binds this port to the real pipeline via
 * registerIntentPorts() and injects the engine-bound runner through
 * AnalysisPortDeps. The chat then reaches the pipeline through
 * dispatchIntent's 'analysis' route — the same deterministic
 * generate -> sandboxed-execute -> Chart.js-spec pipeline as the
 * analyze_data MCP tool, never a separate code path.
 *
 * Pipeline separation (compile-time, enforced in intentRouter.ts):
 * the analysis result carries NO reactSource/react field.
 */

import type { AnalysisPort, ChartJsVisualSpec } from '../agent/intentRouter.js';
import { toChartConfiguration, type AnalysisChartSpec } from './chartspec.js';

/** Host-injected seam: runs the pipeline for one prompt (+ optional range/sheet). */
export interface AnalysisPortDeps {
  runAnalysis: (req: {
    prompt: string;
    range?: string;
    /** #135: the client's active sheet; wins over the range's sheet. */
    sheet?: string;
  }) => Promise<{ summary: string; chartSpec: AnalysisChartSpec }>;
}

/**
 * Map the validated AnalysisChartSpec to the router's ChartJsVisualSpec
 * ({ type, data, options }) via the Chart.js config builder.
 */
export function toChartJsVisualSpec(spec: AnalysisChartSpec): ChartJsVisualSpec {
  const config = toChartConfiguration(spec);
  return {
    type: spec.type,
    data: { ...(config.data as unknown as Record<string, unknown>) },
    options: { ...((config.options ?? {}) as Record<string, unknown>) },
  };
}

/** Build the AnalysisPort the router dispatches 'analysis' routes to. */
export function createAnalysisPort(deps: AnalysisPortDeps): AnalysisPort {
  return {
    analyze: async ({ prompt, range, sheet }) => {
      const { summary, chartSpec } = await deps.runAnalysis({ prompt, range, sheet });
      return { analysis: summary, chartSpec: toChartJsVisualSpec(chartSpec) };
    },
  };
}
