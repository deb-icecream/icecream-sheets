/**
 * ETL pipeline — Node.js host binding for custom transforms.
 *
 * Server-only: dynamically imports the mcp-server sandbox (node:vm for
 * JavaScript, restricted subprocess for Python) and adapts it to the
 * `CustomCodeRunner` contract from custom.js.
 *
 * This module is deliberately NOT re-exported from etl/index.js: the
 * service package also bundles for the browser, where node:vm and
 * child_process don't exist. Server hosts (MCP server, API layer) import
 * `@icecream-sheets/service/dist/etl/nodeRunner.js` directly.
 *
 * Contracts:
 * - JavaScript: the script's completion value must be
 *   `{ columns: string[], rows: Record<string, scalar>[] }`. `args` holds
 *   `{ columns, rows }` (frozen), per the mcp-server sandbox convention.
 * - Python: the program receives `args` (same shape) and MUST assign
 *   `result` to the same table-out shape; it is printed as JSON on stdout.
 * - TypeScript is accepted by the recipe schema but NOT executed by this
 *   host in v1 (the sandbox has no type-stripper); it fails closed with a
 *   clear message so a future host can add support without a schema change.
 */

import type {
  CustomCodeInput,
  CustomCodeResult,
  CustomCodeRunner,
  CustomLanguage,
} from './custom.js';

type McpSandbox = {
  runJavaScript: (
    code: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ) => { value: unknown } | { error: string };
  runPython: (
    code: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ) => { value: unknown } | { error: string };
};

let sandbox: McpSandbox | null = null;

// The specifier is intentionally non-literal: tsc then skips type
// resolution of '@icecream-sheets/mcp-server' (resolving it would pull
// mcp-server/dist/*.d.ts → @icecream-sheets/service → this package's own
// dist into the program, a type cycle that breaks the build with TS5055).
// Node still resolves the package at runtime; the cast defines the shape.
const MCP_SERVER_SPECIFIER: string = '@icecream-sheets/mcp-server';

async function loadSandbox(): Promise<McpSandbox> {
  if (!sandbox) {
    // Dynamic import: never statically bundled, never loaded in the browser.
    const mod = (await import(/* @vite-ignore */ MCP_SERVER_SPECIFIER)) as unknown as McpSandbox;
    if (typeof mod.runJavaScript !== 'function' || typeof mod.runPython !== 'function') {
      throw new Error('mcp-server sandbox surface not found (runJavaScript/runPython)');
    }
    sandbox = mod;
  }
  return sandbox;
}

function argsOf(input: CustomCodeInput): Record<string, unknown> {
  return { columns: input.columns, rows: input.rows };
}

export function nodeSandboxRunner(): CustomCodeRunner {
  return async (
    language: CustomLanguage,
    code: string,
    input: CustomCodeInput,
    opts: { timeoutMs: number },
  ): Promise<CustomCodeResult> => {
    const sb = await loadSandbox();
    const args = argsOf(input);
    if (language === 'javascript') {
      return sb.runJavaScript(code, args, { timeoutMs: opts.timeoutMs });
    }
    if (language === 'python') {
      return sb.runPython(code, args, { timeoutMs: opts.timeoutMs });
    }
    return {
      error: `typescript custom transforms are not executable by this host (v1): strip type annotations or use javascript`,
    };
  };
}
