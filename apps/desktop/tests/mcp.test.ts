/**
 * Desktop MCP direct ingress (design-docs/platform-shell.md §8).
 *
 * The desktop must NOT route MCP through the API gateway (which deliberately
 * has no /api/mcp route). Instead it runs the MCP server's own direct
 * ingress on loopback, sharing the main-process EngineHost, and serviceCall
 * connects 'mcp' straight to it — no login required (local engine feature).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import {
  callLocalMcpTool,
  closeLocalMcpClient,
  desktopMcpPort,
  desktopMcpUrl,
  startDesktopMcpIngress,
  type DesktopMcpIngress,
} from '../src/mcp.js';

const TEST_PORT = '18231';

const SAVED_ENV = { ...process.env };

function setMcpPortEnv(): void {
  process.env.ICECREAM_DESKTOP_MCP_PORT = TEST_PORT;
  delete process.env.ICECREAM_MCP_PORT;
}

beforeEach(() => {
  process.env = { ...SAVED_ENV };
});

let ingress: DesktopMcpIngress | null = null;

/**
 * One-time module-load amortization.
 *
 * startDesktopMcpIngress() dynamically imports @icecream-sheets/mcp-server/http
 * (which pulls in the full engine + HyperFormula module graph — ~3s of module
 * load on this 2-CPU VM) and callLocalMcpTool() imports the MCP SDK client.
 * Node caches both after the first import, so pre-warming them once in
 * beforeAll keeps the first-load cost inside the 10s hook budget instead of
 * inside the first ingress test's 5s budget, where it made that test flaky.
 */
beforeAll(async () => {
  await import('@icecream-sheets/mcp-server/http');
  await import('@modelcontextprotocol/sdk/client/index.js');
  await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
}, 20000);

afterEach(async () => {
  await closeLocalMcpClient();
  if (ingress) {
    await ingress.close();
    ingress = null;
  }
  process.env = { ...SAVED_ENV };
  vi.restoreAllMocks();
});

describe('desktopMcpPort', () => {
  it('defaults to 8106 (the deployed MCP service default)', () => {
    delete process.env.ICECREAM_DESKTOP_MCP_PORT;
    delete process.env.ICECREAM_MCP_PORT;
    expect(desktopMcpPort()).toBe(8106);
  });

  it('honors ICECREAM_DESKTOP_MCP_PORT, then ICECREAM_MCP_PORT', () => {
    process.env.ICECREAM_MCP_PORT = '9001';
    process.env.ICECREAM_DESKTOP_MCP_PORT = '9002';
    expect(desktopMcpPort()).toBe(9002);
    delete process.env.ICECREAM_DESKTOP_MCP_PORT;
    expect(desktopMcpPort()).toBe(9001);
  });

  it('rejects invalid ports', () => {
    for (const bad of ['0', '-1', '65536', 'abc', '8.5']) {
      process.env.ICECREAM_DESKTOP_MCP_PORT = bad;
      expect(() => desktopMcpPort()).toThrow(/invalid MCP port/);
    }
  });

  it('desktopMcpUrl points at loopback, never the gateway', () => {
    setMcpPortEnv();
    expect(desktopMcpUrl()).toBe(`http://127.0.0.1:${TEST_PORT}`);
    expect(desktopMcpUrl()).not.toContain('8100');
  });
});

describe('desktop MCP direct ingress', () => {
  // Ingress tests bind a real loopback HTTP server and run a real Streamable
  // HTTP MCP handshake; even with modules pre-warmed (see beforeAll above),
  // first bind + handshake on a loaded 2-CPU VM can take several seconds, so
  // these two tests get a 15s budget instead of the default 5s.
  it('serves /health and real MCP tool calls sharing the EngineHost', { timeout: 15000 }, async () => {
    setMcpPortEnv();
    const host = new EngineHost();
    expect(
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 41 }).ok,
    ).toBe(true);

    ingress = await startDesktopMcpIngress(host);
    expect(ingress.url).toBe(desktopMcpUrl());

    const health = await fetch(`${ingress.url}/health`).then((r) => r.json());
    expect(health).toMatchObject({ ok: true, service: 'mcp-server' });

    // Typed MCP tool call over the direct ingress (Streamable HTTP), through
    // the SDK client — the same cell the host wrote is visible via MCP.
    const data = (await callLocalMcpTool('read_cells', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    })) as { cells?: unknown[][] };
    expect(data.cells?.[0]?.[0]).toBe(41);
  });

  it('rejects empty tool names without touching the network', async () => {
    await expect(callLocalMcpTool('   ')).rejects.toThrow(/tool name is required/);
  });

  it('restart rebinds the ingress to a new EngineHost', { timeout: 15000 }, async () => {
    setMcpPortEnv();
    const host1 = new EngineHost();
    host1.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 });
    ingress = await startDesktopMcpIngress(host1);
    const urlBefore = ingress.url;

    const host2 = new EngineHost();
    host2.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 2 });
    await closeLocalMcpClient();
    await ingress.restart(host2);
    expect(ingress.url).toBe(urlBefore);

    const data = (await callLocalMcpTool('read_cells', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    })) as { cells?: unknown[][] };
    expect(data.cells?.[0]?.[0]).toBe(2);
  });
});

describe("serviceCall 'mcp' routing", () => {
  it("goes to the direct ingress, never the gateway, and needs no login", async () => {
    setMcpPortEnv();
    const mcpMod = await import('../src/mcp.js');
    const spy = vi.spyOn(mcpMod, 'callLocalMcpTool').mockResolvedValue({ ok: true });

    // services.ts imports electron at module top; under plain node/vitest the
    // electron package resolves to its binary path (no app runtime), which is
    // fine because serviceCall('mcp') never touches safeStorage/app.
    const { serviceCall } = await import('../src/services.js');

    // Logged out: no token on disk → gateway services would fail closed, but
    // 'mcp' is a local engine feature and must work regardless.
    const result = await serviceCall('mcp', 'read_cells', 'POST', { sheet: 'Sheet1' });
    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('read_cells', { sheet: 'Sheet1' });
  });

  it('rejects non-POST methods for mcp', async () => {
    const { serviceCall } = await import('../src/services.js');
    await expect(serviceCall('mcp', 'read_cells', 'GET')).rejects.toThrow(/unsupported method/);
  });
});
