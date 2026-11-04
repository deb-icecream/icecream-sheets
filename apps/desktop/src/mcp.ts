/**
 * Desktop MCP direct ingress (design-docs/platform-shell.md §8).
 *
 * Typed cell, range, formula and recalculation operations are exposed through
 * the MCP server on EVERY host. On desktop that means the Electron main
 * process runs the MCP server's OWN Streamable-HTTP ingress — deliberately
 * NOT behind the API gateway (user's deployment ruling: the gateway has no
 * /api/mcp route, never sees MCP traffic and never validates MCP users).
 * Third-party MCP clients connect directly to http://127.0.0.1:<port>/mcp,
 * exactly as they do against the deployed MCP service (:8106).
 *
 * The ingress is given the main process's EngineHost (Cycle 10: the user's
 * workbook lives in the main process). Its SubscriptionManager attaches to
 * the same host's engine events, so third-party clients see live workbook
 * changes via poll_events. `callLocalMcpTool` gives built-in callers the
 * same typed (tool, args) surface the web app uses
 * (apps/web/src/services/mcpToolClient.ts), over the direct ingress instead
 * of the dead gateway route.
 *
 * MCP authenticates itself per the MCP spec: a Bearer <redacted> is verified
 * with MCP's own secret (MCP_AUTH_SECRET, see @icecream-sheets/mcp-server).
 * Without a token the caller is the anonymous local-dev principal
 * (`mcp-client`); set MCP_REQUIRE_AUTH=1 to reject unauthenticated callers.
 * MCP enforces its own rate-limit tier, independent of the gateway's.
 */
import type http from 'node:http';
import type { EngineHost } from '@icecream-sheets/engine';

/** Loopback only: the desktop MCP ingress never binds a public interface. */
const MCP_HOST = '127.0.0.1';

/**
 * Configured MCP port: ICECREAM_DESKTOP_MCP_PORT, else ICECREAM_MCP_PORT,
 * else 8106 (the same default as the deployed MCP service).
 */
export function desktopMcpPort(): number {
  const raw = process.env.ICECREAM_DESKTOP_MCP_PORT ?? process.env.ICECREAM_MCP_PORT ?? '8106';
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `invalid MCP port "${raw}" (set ICECREAM_DESKTOP_MCP_PORT to 1-65535)`,
    );
  }
  return port;
}

/** Actual bound port once the ingress has started (null before start). */
let boundPort: number | null = null;

/**
 * URL of the desktop's own MCP ingress. Before start() this is the
 * configured URL; after start() it is the actually-bound URL (which may
 * differ when the configured port was taken and we fell back).
 */
export function desktopMcpUrl(): string {
  return `http://${MCP_HOST}:${boundPort ?? desktopMcpPort()}`;
}

export interface DesktopMcpIngress {
  /** The bound node http.Server (close it to shut the ingress down). */
  readonly server: http.Server;
  /** Actually-bound URL, e.g. http://127.0.0.1:8106 */
  readonly url: string;
  /**
   * Rebind the ingress to a new EngineHost (workbook lifecycle: New/Open).
   * With the forwarding shim the host instance is stable — the renderer's
   * workbook is the source of truth — so this only refreshes the listener
   * (and drops stale MCP sessions). Keeps the bound port when possible.
   */
  restart(host: EngineHost): Promise<void>;
  /** Stop the ingress. */
  close(): Promise<void>;
}

type StartMcpHttp = (
  port: number,
  opts: { host?: EngineHost; requireAuth?: boolean },
  host?: string,
) => http.Server;

async function loadStartMcpHttp(): Promise<StartMcpHttp> {
  // @icecream-sheets/mcp-server ships as ESM; the Electron main process
  // compiles to CJS, so import it dynamically.
  const mod = await import('@icecream-sheets/mcp-server/http');
  if (typeof mod.startMcpHttp !== 'function') {
    throw new Error('@icecream-sheets/mcp-server/http does not export startMcpHttp');
  }
  return mod.startMcpHttp as StartMcpHttp;
}

function listenOnce(
  server: http.Server,
  port: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

async function bindIngress(
  startMcpHttp: StartMcpHttp,
  host: EngineHost,
  port: number,
): Promise<http.Server> {
  const server = startMcpHttp(
    port,
    {
      host,
      requireAuth: process.env.MCP_REQUIRE_AUTH === '1',
    },
    MCP_HOST,
  );
  await listenOnce(server, port);
  const addr = server.address();
  boundPort =
    typeof addr === 'object' && addr !== null ? addr.port : port;
  return server;
}

/**
 * Start the desktop's own MCP ingress on the given host. The caller passes
 * the IpcForwardingEngineHost (./mcp-forward) so the ingress serves the
 * renderer's workbook (desktop MCP parity, GAP-1) — never a bare
 * main-process EngineHost, which would be a different, empty workbook.
 * On EADDRINUSE the configured port is taken (e.g. the deployed stack runs
 * alongside the desktop) — fall back to an ephemeral port and log the real
 * URL instead of failing app startup.
 */
export async function startDesktopMcpIngress(host: EngineHost): Promise<DesktopMcpIngress> {
  const startMcpHttp = await loadStartMcpHttp();
  const configured = desktopMcpPort();
  let server: http.Server;
  try {
    server = await bindIngress(startMcpHttp, host, configured);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
    console.warn(
      `[mcp] port ${configured} is taken (ICECREAM_DESKTOP_MCP_PORT to override) — ` +
        'binding the desktop MCP ingress to an ephemeral port',
    );
    server = await bindIngress(startMcpHttp, host, 0);
  }
  console.log(`[mcp] direct ingress listening at ${desktopMcpUrl()}/mcp (health at /health)`);

  const closeServer = (s: http.Server): Promise<void> =>
    new Promise<void>((resolve) => s.close(() => resolve()));

  let current = server;
  return {
    server,
    url: desktopMcpUrl(),
    async restart(newHost: EngineHost): Promise<void> {
      const port = boundPort ?? configured;
      await closeServer(current);
      try {
        current = await bindIngress(startMcpHttp, newHost, port);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
        current = await bindIngress(startMcpHttp, newHost, 0);
      }
      console.log(`[mcp] direct ingress rebound at ${desktopMcpUrl()}/mcp`);
    },
    async close(): Promise<void> {
      await closeServer(current);
      boundPort = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in direct MCP calls (typed tool surface, like the web app's
// McpCallFn) — over the direct ingress, never the gateway.
// ---------------------------------------------------------------------------

interface RpcText {
  type: 'text';
  text: string;
}

/** Unwrap the MCP content envelope; throws on tool errors (mirrors the web app). */
function parseToolResult(res: unknown): { ok: boolean; data?: unknown; error?: string } {
  const r = res as { content?: RpcText[]; isError?: boolean };
  const text = r.content?.[0]?.text ?? '';
  try {
    const p = JSON.parse(text) as { ok?: boolean; error?: string } & Record<string, unknown>;
    if (p.ok === false) return { ok: false, error: p.error ?? 'unknown error' };
    const { ok: _ok, ...data } = p;
    void _ok;
    return { ok: !r.isError, data };
  } catch {
    return { ok: !r.isError, data: { text } };
  }
}

interface McpSdkClient {
  connect(transport: unknown): Promise<void>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

let mcpClient: McpSdkClient | null = null;

async function getLocalMcpClient(): Promise<McpSdkClient> {
  if (mcpClient) return mcpClient;
  // ESM SDK from the CJS main process: dynamic import.
  const clientMod = (await import('@modelcontextprotocol/sdk/client/index.js')) as unknown as {
    Client: new (info: { name: string; version: string }) => McpSdkClient;
  };
  const transportMod = (await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )) as unknown as {
    StreamableHTTPClientTransport: new (url: URL) => unknown;
  };
  const client = new clientMod.Client({ name: 'icecream-desktop-main', version: '0.1.0' });
  const transport = new transportMod.StreamableHTTPClientTransport(new URL('/mcp', desktopMcpUrl()));
  await client.connect(transport);
  mcpClient = client;
  return client;
}

/** Drop the cached MCP client (e.g. after an ingress restart); next call reconnects. */
export async function closeLocalMcpClient(): Promise<void> {
  if (mcpClient) {
    await mcpClient.close().catch(() => undefined);
    mcpClient = null;
  }
}

/**
 * Call a typed MCP tool on the desktop's own direct ingress. This is the
 * built-in equivalent of the web app's McpCallFn — the path serviceCall
 * uses for the 'mcp' service now that the gateway route is gone.
 */
export async function callLocalMcpTool(tool: string, args?: unknown): Promise<unknown> {
  const name = tool.trim();
  if (!name) throw new Error('mcp: tool name is required');
  let client: McpSdkClient;
  try {
    client = await getLocalMcpClient();
  } catch (err) {
    throw new Error(
      `mcp: cannot reach the desktop MCP ingress at ${desktopMcpUrl()}/mcp: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let res: unknown;
  try {
    res = await client.callTool({
      name,
      arguments: (args ?? {}) as Record<string, unknown>,
    });
  } catch (err) {
    // Session died (e.g. ingress restarted) — drop the client so the next
    // call reconnects instead of failing forever.
    await closeLocalMcpClient();
    throw err instanceof Error ? err : new Error(String(err));
  }
  const parsed = parseToolResult(res);
  if (!parsed.ok) throw new Error(parsed.error ?? `mcp tool "${name}" failed`);
  return parsed.data;
}
