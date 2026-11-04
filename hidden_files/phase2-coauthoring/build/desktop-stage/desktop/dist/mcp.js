"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.desktopMcpPort = desktopMcpPort;
exports.desktopMcpUrl = desktopMcpUrl;
exports.startDesktopMcpIngress = startDesktopMcpIngress;
exports.closeLocalMcpClient = closeLocalMcpClient;
exports.callLocalMcpTool = callLocalMcpTool;
/** Loopback only: the desktop MCP ingress never binds a public interface. */
const MCP_HOST = '127.0.0.1';
/**
 * Configured MCP port: ICECREAM_DESKTOP_MCP_PORT, else ICECREAM_MCP_PORT,
 * else 8106 (the same default as the deployed MCP service).
 */
function desktopMcpPort() {
    const raw = process.env.ICECREAM_DESKTOP_MCP_PORT ?? process.env.ICECREAM_MCP_PORT ?? '8106';
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`invalid MCP port "${raw}" (set ICECREAM_DESKTOP_MCP_PORT to 1-65535)`);
    }
    return port;
}
/** Actual bound port once the ingress has started (null before start). */
let boundPort = null;
/**
 * URL of the desktop's own MCP ingress. Before start() this is the
 * configured URL; after start() it is the actually-bound URL (which may
 * differ when the configured port was taken and we fell back).
 */
function desktopMcpUrl() {
    return `http://${MCP_HOST}:${boundPort ?? desktopMcpPort()}`;
}
async function loadStartMcpHttp() {
    // @icecream-sheets/mcp-server ships as ESM; the Electron main process
    // compiles to CJS, so import it dynamically.
    const mod = await Promise.resolve().then(() => __importStar(require('@icecream-sheets/mcp-server/http')));
    if (typeof mod.startMcpHttp !== 'function') {
        throw new Error('@icecream-sheets/mcp-server/http does not export startMcpHttp');
    }
    return mod.startMcpHttp;
}
function listenOnce(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.removeListener('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
    });
}
async function bindIngress(startMcpHttp, host, port) {
    const server = startMcpHttp(port, {
        host,
        requireAuth: process.env.MCP_REQUIRE_AUTH === '1',
    }, MCP_HOST);
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
async function startDesktopMcpIngress(host) {
    const startMcpHttp = await loadStartMcpHttp();
    const configured = desktopMcpPort();
    let server;
    try {
        server = await bindIngress(startMcpHttp, host, configured);
    }
    catch (err) {
        if (err?.code !== 'EADDRINUSE')
            throw err;
        console.warn(`[mcp] port ${configured} is taken (ICECREAM_DESKTOP_MCP_PORT to override) — ` +
            'binding the desktop MCP ingress to an ephemeral port');
        server = await bindIngress(startMcpHttp, host, 0);
    }
    console.log(`[mcp] direct ingress listening at ${desktopMcpUrl()}/mcp (health at /health)`);
    const closeServer = (s) => new Promise((resolve) => s.close(() => resolve()));
    let current = server;
    return {
        server,
        url: desktopMcpUrl(),
        async restart(newHost) {
            const port = boundPort ?? configured;
            await closeServer(current);
            try {
                current = await bindIngress(startMcpHttp, newHost, port);
            }
            catch (err) {
                if (err?.code !== 'EADDRINUSE')
                    throw err;
                current = await bindIngress(startMcpHttp, newHost, 0);
            }
            console.log(`[mcp] direct ingress rebound at ${desktopMcpUrl()}/mcp`);
        },
        async close() {
            await closeServer(current);
            boundPort = null;
        },
    };
}
/** Unwrap the MCP content envelope; throws on tool errors (mirrors the web app). */
function parseToolResult(res) {
    const r = res;
    const text = r.content?.[0]?.text ?? '';
    try {
        const p = JSON.parse(text);
        if (p.ok === false)
            return { ok: false, error: p.error ?? 'unknown error' };
        const { ok: _ok, ...data } = p;
        void _ok;
        return { ok: !r.isError, data };
    }
    catch {
        return { ok: !r.isError, data: { text } };
    }
}
let mcpClient = null;
async function getLocalMcpClient() {
    if (mcpClient)
        return mcpClient;
    // ESM SDK from the CJS main process: dynamic import.
    const clientMod = (await Promise.resolve().then(() => __importStar(require('@modelcontextprotocol/sdk/client/index.js'))));
    const transportMod = (await Promise.resolve().then(() => __importStar(require('@modelcontextprotocol/sdk/client/streamableHttp.js'))));
    const client = new clientMod.Client({ name: 'icecream-desktop-main', version: '0.1.0' });
    const transport = new transportMod.StreamableHTTPClientTransport(new URL('/mcp', desktopMcpUrl()));
    await client.connect(transport);
    mcpClient = client;
    return client;
}
/** Drop the cached MCP client (e.g. after an ingress restart); next call reconnects. */
async function closeLocalMcpClient() {
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
async function callLocalMcpTool(tool, args) {
    const name = tool.trim();
    if (!name)
        throw new Error('mcp: tool name is required');
    let client;
    try {
        client = await getLocalMcpClient();
    }
    catch (err) {
        throw new Error(`mcp: cannot reach the desktop MCP ingress at ${desktopMcpUrl()}/mcp: ${err instanceof Error ? err.message : String(err)}`);
    }
    let res;
    try {
        res = await client.callTool({
            name,
            arguments: (args ?? {}),
        });
    }
    catch (err) {
        // Session died (e.g. ingress restarted) — drop the client so the next
        // call reconnects instead of failing forever.
        await closeLocalMcpClient();
        throw err instanceof Error ? err : new Error(String(err));
    }
    const parsed = parseToolResult(res);
    if (!parsed.ok)
        throw new Error(parsed.error ?? `mcp tool "${name}" failed`);
    return parsed.data;
}
//# sourceMappingURL=mcp.js.map