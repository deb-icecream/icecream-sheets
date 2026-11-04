/**
 * @icecream-sheets/mcp-server — MCP server + code sandbox for Icecream Sheets.
 *
 * Importing this module registers the ICEEVAL() formula function with
 * HyperFormula (side-effectful import of ./engine-plugin.js).
 */
import './engine-plugin.js';

export { createServer, runServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export type { ChartSink, DataSourceServerOptions, ServerOptions } from './server.js';
export {
  SKILL_PACKS,
  manifestOf,
  packsFromEnv,
  resolveSkillPacks,
  type SkillPack,
  type SkillPackManifest,
  type SkillPackPrompt,
} from './packs/index.js';
export type { PackContext, PackToolResult } from './packs/types.js';
export { runJavaScript, type SandboxOptions, type SandboxResult } from './sandbox/javascript.js';
export { runPython } from './sandbox/python.js';
export { registerIceCreamFunctions, IceCreamFunctionsPlugin } from './engine-plugin.js';

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const { runServer: run } = await import('./server.js');
  run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
