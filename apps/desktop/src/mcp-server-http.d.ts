/**
 * Ambient types for the `@icecream-sheets/mcp-server/http` subpath.
 *
 * The desktop compiles to CJS with classic node module resolution, which
 * does not read the mcp-server `exports` map (the `./http` subpath), so
 * tsc cannot see `dist/http.d.ts` on its own. The runtime dynamic import()
 * in mcp.ts resolves fine through Node itself; this file only supplies the
 * types. Keep the signature in sync with packages/mcp-server/src/http.ts.
 */
declare module '@icecream-sheets/mcp-server/http' {
  import type http from 'node:http';
  import type { EngineHost } from '@icecream-sheets/engine';
  export interface McpHttpListenOptions {
    host?: EngineHost;
    requireAuth?: boolean;
  }
  export function startMcpHttp(
    port: number,
    opts?: McpHttpListenOptions,
    host?: string,
  ): http.Server;
}
