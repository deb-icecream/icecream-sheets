/**
 * ETL pipeline — custom transform node.
 *
 * Per design-docs/etl-pipeline.md §3, a custom operation runs user-supplied
 * Python, JavaScript or TypeScript in the sandbox with typed table-in and
 * table-out contracts, callable the same way formulas can call sandboxed
 * code.
 *
 * The sandbox pattern is reused from packages/mcp-server/src/sandbox
 * (node:vm for JS, restricted subprocess for Python: no ambient network,
 * filesystem, clock or randomness; CPU/memory/timeout limits). This module
 * does NOT import the sandbox directly — it takes an injected
 * `CustomCodeRunner` so the service package stays host-agnostic (it also
 * runs in the browser, where node:vm doesn't exist). Server hosts use
 * `nodeSandboxRunner()` from nodeRunner.js, which lazily binds the
 * mcp-server sandbox.
 *
 * Table contract:
 *   in:  { columns: string[], rows: Record<string, EtlValue>[] }
 *   out: { columns: string[], rows: Record<string, EtlValue>[] }
 * For Python the program must assign `result`; for JavaScript the
 * completion value is the result. Output columns must be unique
 * non-empty strings; row values must be JSON scalars (string/number/
 * boolean/null) — anything else is a contract violation.
 */

import {
  isEtlValue,
  type EtlColumn,
  type EtlRow,
  type EtlTable,
  type EtlValue,
} from './types.js';

export type CustomLanguage = 'python' | 'javascript' | 'typescript';

export interface CustomCodeInput {
  columns: string[];
  rows: EtlRow[];
}

export type CustomCodeResult = { value: unknown } | { error: string };

/**
 * Runs user code in a sandbox. Implementations MUST enforce the same
 * capability profile as the mcp-server sandbox (no I/O, CPU/memory/time
 * limits) — the browser host simply doesn't provide one, in which case
 * custom steps fail closed with a clear message.
 */
export type CustomCodeRunner = (
  language: CustomLanguage,
  code: string,
  input: CustomCodeInput,
  opts: { timeoutMs: number },
) => Promise<CustomCodeResult>;

export interface CustomTransformSpec {
  language: CustomLanguage;
  code: string;
  timeoutMs?: number;
}

export const DEFAULT_CUSTOM_TIMEOUT_MS = 5000;
export const MAX_CUSTOM_TIMEOUT_MS = 30000;

function fail(reason: string): never {
  throw new Error(`custom transform contract violation: ${reason}`);
}

/** Validate the table-out contract and build the EtlTable. */
export function contractToTable(output: unknown): EtlTable {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    fail('result must be an object { columns, rows }');
  }
  const o = output as Record<string, unknown>;
  if (!Array.isArray(o['columns']) || o['columns'].some((c) => typeof c !== 'string' || c.trim() === '')) {
    fail('result.columns must be a non-empty-name string array');
  }
  const columns = o['columns'] as string[];
  if (new Set(columns).size !== columns.length) fail('result.columns must be unique');
  if (!Array.isArray(o['rows'])) fail('result.rows must be an array');
  const rows: EtlRow[] = (o['rows'] as unknown[]).map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail(`row ${i} must be an object`);
    }
    const row: EtlRow = {};
    for (const c of columns) {
      const v: unknown = (raw as Record<string, unknown>)[c];
      const value = (v === undefined ? null : v) as EtlValue;
      if (!isEtlValue(value)) fail(`row ${i} column "${c}" is not a scalar value`);
      row[c] = value;
    }
    return row;
  });
  const cols: EtlColumn[] = columns.map((name) => ({ name, type: 'unknown' }));
  return { columns: cols, rows };
}

/**
 * Run a custom transform step. Throws on sandbox errors and contract
 * violations; the runner treats sandbox timeouts as transient (retriable).
 */
export async function runCustomTransform(
  table: EtlTable,
  spec: CustomTransformSpec,
  runCode: CustomCodeRunner,
): Promise<EtlTable> {
  if (typeof spec.code !== 'string' || spec.code.trim() === '') {
    throw new Error('custom transform: code must not be empty');
  }
  const timeoutMs = spec.timeoutMs ?? DEFAULT_CUSTOM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_CUSTOM_TIMEOUT_MS) {
    throw new Error(`custom transform: timeoutMs must be within (0, ${MAX_CUSTOM_TIMEOUT_MS}]`);
  }
  const input: CustomCodeInput = {
    columns: table.columns.map((c) => c.name),
    rows: table.rows,
  };
  const result = await runCode(spec.language, spec.code, input, { timeoutMs });
  if ('error' in result) {
    throw new Error(`custom transform failed: ${result.error}`, {
      cause: isTransientCodeError(result.error) ? new TransientCustomError(result.error) : undefined,
    });
  }
  return contractToTable(result.value);
}

/** Marker so the runner can retry transient sandbox failures with backoff. */
export class TransientCustomError extends Error {
  readonly transient = true;
  constructor(message: string) {
    super(message);
    this.name = 'TransientCustomError';
  }
}

function isTransientCodeError(message: string): boolean {
  return /timed out|timeout|ETIMEDOUT|ECONNRESET|temporarily/i.test(message);
}
