/**
 * In-process MCP client for the web app (local engine mode).
 *
 * The AI-generated app bridge (ArtifactHost) executes iframe {tool, args}
 * requests through the REAL product MCP server — the same server instance
 * the AI Agent runtime uses — over an in-memory transport. There is no
 * private path: authorization, per-subject filtered views and tool
 * versioning apply identically to agent and generated-app calls.
 *
 * The client is shared per EngineHost and rebuilt when the host changes
 * (workbook open). Gateway/desktop-remote modes have no local MCP server;
 * callers must gate on getLocalMcpCall resolving (it rejects there).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '@icecream-sheets/mcp-server/server';
import type { EngineHost } from '@icecream-sheets/engine';
import type { McpCallFn } from '@icecream-sheets/service';

interface RpcText {
  type: 'text';
  text: string;
}

/** Unwrap the MCP content envelope; throws on tool errors. */
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

let box: { host: EngineHost; client: Client; call: McpCallFn } | null = null;

/**
 * Shared MCP call function for the current local engine host.
 * Rejects when there is no local engine (gateway mode).
 */
export async function getLocalMcpCall(host: EngineHost): Promise<McpCallFn> {
  if (box && box.host === host) return box.call;
  if (box) {
    await box.client.close().catch(() => undefined);
    box = null;
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer(host);
  const client = new Client({ name: 'icecream-artifact-host', version: '0.1.0' });
  await server.connect(serverT);
  await client.connect(clientT);
  const call: McpCallFn = async (tool, args) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const parsed = parseToolResult(res);
    if (!parsed.ok) throw new Error(parsed.error ?? `${tool} failed`);
    return parsed.data;
  };
  box = { host, client, call };
  return call;
}
