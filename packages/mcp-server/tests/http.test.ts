/**
 * Streamable-HTTP transport for the MCP server (src/http.ts).
 *
 * Spins the real node:http listener on an ephemeral port and drives it
 * with the SDK's Client + StreamableHTTPClientTransport:
 *  (a) GET /health
 *  (b) full MCP handshake: list tools, write_cells → read_cells round-trip
 *  (c) x-principal header becomes the default principal (audit-log proof)
 *  (d) an explicit `principal` tool arg overrides the header default
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EngineHost } from '@icecream-sheets/engine';
import { issueToken } from '@icecream-sheets/service';
import { createMcpHttpListener } from '../src/http.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.isError ?? false).toBe(false);
  expect(res.content).toHaveLength(1);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

let server: http.Server;
let port: number;
const host = new EngineHost();

async function makeClient(
  headers?: Record<string, string>,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client({ name: 'http-test-client', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function closeClient(conn: {
  client: Client;
  transport: StreamableHTTPClientTransport;
}): Promise<void> {
  try {
    await conn.transport.terminateSession();
  } catch {
    // Session may already be gone; teardown must not fail the test.
  }
  await conn.client.close();
}

beforeAll(async () => {
  server = http.createServer(createMcpHttpListener({ host }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}, 15_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('GET /health', () => {
  it('returns ok outside the MCP transport', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'mcp-server' });
  });
});

describe('MCP over Streamable HTTP', () => {
  it('handshakes, lists tools, and round-trips write_cells/read_cells', async () => {
    const conn = await makeClient();
    try {
      const { tools } = await conn.client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('read_cells');
      expect(names).toContain('write_cells');
      expect(names).toContain('set_formulas');

      const written = payloadOf(
        await conn.client.callTool({
          name: 'write_cells',
          arguments: {
            cells: [
              { sheet: 'Sheet1', row: 0, col: 0, value: 10 },
              { sheet: 'Sheet1', row: 1, col: 0, value: 20 },
            ],
          },
        }),
      );
      expect(written.ok).toBe(true);
      expect(written.written).toBe(2);

      const set = payloadOf(
        await conn.client.callTool({
          name: 'set_formulas',
          arguments: { formulas: [{ sheet: 'Sheet1', row: 2, col: 0, formula: '=SUM(A1:A2)' }] },
        }),
      );
      expect(set.ok).toBe(true);

      const read = payloadOf(
        await conn.client.callTool({
          name: 'read_cells',
          arguments: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
        }),
      );
      expect(read.ok).toBe(true);
      expect(read.cells).toEqual([[10], [20], [30]]);
    } finally {
      await closeClient(conn);
    }
  });

  it('ignores the x-principal header — it is never trusted (MCP is its own ingress)', async () => {
    const mark = host.getAuthorizer().auditLog().length;
    const conn = await makeClient({ 'x-principal': 'user:alice' });
    try {
      const written = payloadOf(
        await conn.client.callTool({
          name: 'write_cells',
          arguments: { cells: [{ sheet: 'Sheet1', row: 5, col: 5, value: 'alice-was-here' }] },
        }),
      );
      expect(written.ok).toBe(true);
    } finally {
      await closeClient(conn);
    }
    const newEntries = host.getAuthorizer().auditLog().slice(mark);
    const writes = newEntries.filter((e) => e.action === 'cell.write');
    expect(writes.length).toBeGreaterThan(0);
    // The spoofed header must NOT become the principal: anonymous fallback.
    for (const e of writes) expect(e.principal).toBe('mcp-client');

    // A second, independent connection sees the same shared workbook state.
    const conn2 = await makeClient();
    try {
      const read = payloadOf(
        await conn2.client.callTool({
          name: 'read_cells',
          arguments: { sheet: 'Sheet1', startRow: 5, startCol: 5, endRow: 5, endCol: 5 },
        }),
      );
      expect(read.cells).toEqual([['alice-was-here']]);
    } finally {
      await closeClient(conn2);
    }
  });

  it('verifies a Bearer JWT itself and stamps user:<id> as the session principal', async () => {
    const token = await issueToken({ userId: 'alice', secret: 'local-dev-secret', ttlSeconds: 3600 });
    const mark = host.getAuthorizer().auditLog().length;
    const conn = await makeClient({ authorization: `Bearer ${token}` });
    try {
      const written = payloadOf(
        await conn.client.callTool({
          name: 'write_cells',
          arguments: { cells: [{ sheet: 'Sheet1', row: 6, col: 5, value: 'jwt-alice' }] },
        }),
      );
      expect(written.ok).toBe(true);
    } finally {
      await closeClient(conn);
    }
    const newEntries = host.getAuthorizer().auditLog().slice(mark);
    const writes = newEntries.filter((e) => e.action === 'cell.write');
    expect(writes.length).toBeGreaterThan(0);
    for (const e of writes) expect(e.principal).toBe('user:alice');
  });

  it('rejects a forged Bearer token — falls back to anonymous, never trusts it', async () => {
    const forged = await issueToken({ userId: 'mallory', secret: 'wrong-secret', ttlSeconds: 3600 });
    const mark = host.getAuthorizer().auditLog().length;
    const conn = await makeClient({ authorization: `Bearer ${forged}` });
    try {
      const written = payloadOf(
        await conn.client.callTool({
          name: 'write_cells',
          arguments: { cells: [{ sheet: 'Sheet1', row: 7, col: 5, value: 'mallory-was-here' }] },
        }),
      );
      expect(written.ok).toBe(true);
    } finally {
      await closeClient(conn);
    }
    const newEntries = host.getAuthorizer().auditLog().slice(mark);
    const writes = newEntries.filter((e) => e.action === 'cell.write');
    expect(writes.length).toBeGreaterThan(0);
    for (const e of writes) expect(e.principal).toBe('mcp-client');
  });

  it('F-10: an explicit principal tool arg may NOT override the verified session identity', async () => {
    const token = await issueToken({ userId: 'alice', secret: 'local-dev-secret', ttlSeconds: 3600 });
    const mark = host.getAuthorizer().auditLog().length;
    const conn = await makeClient({ authorization: `Bearer ${token}` });
    try {
      const res = (await conn.client.callTool({
        name: 'write_cells',
        arguments: {
          cells: [{ sheet: 'Sheet1', row: 8, col: 5, value: 'bob-override' }],
          principal: 'user:bob',
        },
      })) as { content: { text: string }[]; isError?: boolean };
      // Refused at the tool layer: the verified identity (user:alice)
      // is authoritative; the asserted user:bob never reaches the engine.
      expect(res.isError ?? false).toBe(true);
      expect(res.content[0]?.text ?? '').toContain('principal mismatch');
    } finally {
      await closeClient(conn);
    }
    const newEntries = host.getAuthorizer().auditLog().slice(mark);
    const writes = newEntries.filter((e) => e.action === 'cell.write');
    expect(writes).toHaveLength(0);
  });
});

describe('MCP self-auth (requireAuth)', () => {
  let authServer: http.Server;
  let authPort: number;

  beforeAll(async () => {
    authServer = http.createServer(
      createMcpHttpListener({ host: new EngineHost(), requireAuth: true, authSecret: 'test-secret' }),
    );
    await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));
    authPort = (authServer.address() as AddressInfo).port;
  }, 15_000);

  afterAll(async () => {
    authServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      authServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function postMcp(headers?: Record<string, string>): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${authPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    return res.status;
  }

  it('rejects unauthenticated session creation with 401', async () => {
    expect(await postMcp()).toBe(401);
  });

  it('rejects a token signed with the wrong secret with 401', async () => {
    const forged = await issueToken({ userId: 'mallory', secret: 'wrong-secret', ttlSeconds: 3600 });
    expect(await postMcp({ authorization: `Bearer ${forged}` })).toBe(401);
  });

  it('accepts a valid Bearer JWT verified with MCP’s own secret', async () => {
    const token = await issueToken({ userId: 'carol', secret: 'test-secret', ttlSeconds: 3600 });
    // 400 (not 401): auth passed, the SDK then rejects the bare initialize
    // shape — proving the request got past MCP's own auth layer.
    const status = await postMcp({ authorization: `Bearer ${token}` });
    expect(status).not.toBe(401);
  });
});

describe("MCP's own rate-limit tier", () => {
  let rlServer: http.Server;
  let rlPort: number;

  beforeAll(async () => {
    rlServer = http.createServer(
      createMcpHttpListener({ host: new EngineHost(), rateLimit: { points: 2, perSeconds: 60 } }),
    );
    await new Promise<void>((resolve) => rlServer.listen(0, '127.0.0.1', resolve));
    rlPort = (rlServer.address() as AddressInfo).port;
  }, 15_000);

  afterAll(async () => {
    rlServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      rlServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('returns 429 with Retry-After once the bucket is exhausted', async () => {
    const url = `http://127.0.0.1:${rlPort}/mcp`;
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    };
    // 2 points: first two requests pass auth+rate-limit (they fail later in
    // the SDK handshake, which is fine — we only assert on rate limiting).
    await fetch(url, init);
    await fetch(url, init);
    const limited = await fetch(url, init);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});
