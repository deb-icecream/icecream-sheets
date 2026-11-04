/**
 * Deterministic analysis execution (deterministic-inference.md, ai-agent.md).
 *
 * The AI generates the script; this module executes it deterministically:
 * same script + same data = same result, byte for byte. It takes an
 * injected PythonRunner (browser-safe seam, same pattern as
 * etl/custom.ts's CustomCodeRunner — the browser host simply doesn't
 * provide one, and execution fails closed). Server hosts bind the real
 * sandboxed runner (mcp-server sandbox: no I/O, CPU/memory/time limits).
 *
 * Guards: wall-clock timeout (runner-enforced), input-size cap and
 * output-size cap (host-enforced). The exact script version is recorded
 * with every result for auditability.
 */

import {
  validateAnalysisChartSpec,
  type AnalysisChartSpec,
} from './chartspec.js';
import { ANALYSIS_SCRIPT_VERSION } from './generator.js';

/** JSON scalar as handed to the sandbox. */
export type AnalysisValue = string | number | boolean | null;

/** The data payload a generated script reads as `args`. */
export interface AnalysisInput {
  columns: string[];
  rows: AnalysisValue[][];
}

/** Contract result of one deterministic execution. */
export type SandboxOutcome = { value: unknown } | { error: string };

/**
 * Injected Python execution port. Implementations MUST enforce the same
 * capability profile as the mcp-server sandbox (no ambient network,
 * filesystem, clock or randomness; CPU/memory/timeout limits).
 */
export type PythonRunner = (
  code: string,
  input: AnalysisInput,
  opts: { timeoutMs: number },
) => Promise<SandboxOutcome>;

export const DEFAULT_ANALYSIS_TIMEOUT_MS = 10_000;
export const MAX_ANALYSIS_TIMEOUT_MS = 30_000;
/** Max serialized input bytes (abuse guard before spawning the sandbox). */
export const MAX_ANALYSIS_INPUT_BYTES = 8 * 1024 * 1024;
/** Max serialized output bytes (abuse guard on the way back). */
export const MAX_ANALYSIS_OUTPUT_BYTES = 256 * 1024;

export interface AnalysisSuccess {
  ok: true;
  analysis: Record<string, unknown>;
  chartSpec: AnalysisChartSpec;
  /** Exact generator version stamped in the script header. */
  scriptVersion: number;
  durationMs: number;
}

export interface AnalysisFailure {
  ok: false;
  error: string;
  scriptVersion: number | null;
}

export type AnalysisResult = AnalysisSuccess | AnalysisFailure;

export interface ExecuteOptions {
  timeoutMs?: number;
}

/** Extract the `analysis-script-version: N` stamp from generated source. */
export function extractScriptVersion(source: string): number | null {
  const m = /analysis-script-version:\s*(\d+)/.exec(source);
  return m ? parseInt(m[1]!, 10) : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Execute a generated analysis script deterministically and validate its
 * stdout contract: ONE JSON object { analysis, chartSpec }.
 */
export async function executeAnalysis(
  runner: PythonRunner,
  source: string,
  input: AnalysisInput,
  opts: ExecuteOptions = {},
): Promise<AnalysisResult> {
  const scriptVersion = extractScriptVersion(source);
  if (scriptVersion === null) {
    return { ok: false, error: 'script is missing the analysis-script-version stamp', scriptVersion: null };
  }
  if (scriptVersion !== ANALYSIS_SCRIPT_VERSION) {
    return {
      ok: false,
      error: `unsupported script version ${scriptVersion} (expected ${ANALYSIS_SCRIPT_VERSION})`,
      scriptVersion,
    };
  }

  let inputJson: string;
  try {
    inputJson = JSON.stringify({ columns: input.columns, rows: input.rows });
  } catch {
    return { ok: false, error: 'analysis input is not JSON-serializable', scriptVersion };
  }
  if (inputJson.length > MAX_ANALYSIS_INPUT_BYTES) {
    return {
      ok: false,
      error: `analysis input too large (${inputJson.length} bytes > ${MAX_ANALYSIS_INPUT_BYTES})`,
      scriptVersion,
    };
  }

  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS, MAX_ANALYSIS_TIMEOUT_MS);
  const started = Date.now();
  let outcome: SandboxOutcome;
  try {
    outcome = await runner(source, input, { timeoutMs });
  } catch (e) {
    return { ok: false, error: `runner threw: ${e instanceof Error ? e.message : String(e)}`, scriptVersion };
  }
  const durationMs = Date.now() - started;

  if ('error' in outcome) {
    return { ok: false, error: `sandbox error: ${outcome.error}`, scriptVersion };
  }
  const outputJson = JSON.stringify(outcome.value);
  if (outputJson.length > MAX_ANALYSIS_OUTPUT_BYTES) {
    return {
      ok: false,
      error: `analysis output too large (${outputJson.length} bytes > ${MAX_ANALYSIS_OUTPUT_BYTES})`,
      scriptVersion,
    };
  }
  if (!isRecord(outcome.value)) {
    return { ok: false, error: 'script must assign `result` to an object { analysis, chartSpec }', scriptVersion };
  }
  const { analysis, chartSpec } = outcome.value as { analysis?: unknown; chartSpec?: unknown };
  if (!isRecord(analysis)) {
    return { ok: false, error: 'result.analysis must be an object', scriptVersion };
  }
  const checked = validateAnalysisChartSpec(chartSpec);
  if (!checked.ok) {
    return { ok: false, error: `result.chartSpec invalid: ${checked.error}`, scriptVersion };
  }
  return { ok: true, analysis, chartSpec: checked.spec, scriptVersion, durationMs };
}
