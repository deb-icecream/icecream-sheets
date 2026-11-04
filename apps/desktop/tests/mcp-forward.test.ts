/**
 * Desktop MCP parity GAP-1: IpcForwardingEngineHost.
 *
 * The desktop's MCP ingress must serve the USER'S workbook (which lives in
 * the renderer's EngineHost), not the empty main-process one. These tests
 * simulate the renderer (fake window + preload correlator + renderer host)
 * and prove, end to end over real Streamable HTTP, that third-party MCP
 * clients see the renderer's workbook through the forwarding shim.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineHost, type EngineForwardPayload } from '@icecream-sheets/engine';

const { replyHandlers } = vi.hoisted(() => ({
  replyHandlers: new Map<string, (event: unknown, msg: unknown) => void>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (event: unknown, msg: unknown) => void) => {
      replyHandlers.set(channel, handler);
    },
  },
}));

// Imported after the electron mock so mcp-forward.ts binds the mock ipcMain.
const { IpcForwardingEngineHost } = await import('../src/mcp-forward.js');
const { callLocalMcpTool, closeLocalMcpClient, startDesktopMcpIngress } =
  await import('../src/mcp.js');
type DesktopMcpIngress = import('../src/mcp.js').DesktopMcpIngress;

const TEST_PORT = '18232';
const SAVED_ENV = { ...process.env };

function setMcpPortEnv(): void {
  process.env.ICECREAM_DESKTOP_MCP_PORT = TEST_PORT;
  delete process.env.ICECREAM_MCP_PORT;
}

/** The simulated renderer: runs the op against the renderer's real host. */
async function runRendererOp(host: EngineHost, payload: EngineForwardPayload): Promise<unknown> {
  switch (payload.op) {
    case 'execute':
      return host.execute(payload.command);
    case 'executeAsync':
      return host.executeAsync(payload.command);
    case 'readCell':
      return host.readCell(payload.ref, payload.auth);
    case 'readRange':
      return host.readRange(payload.range, payload.auth);
    case 'readSheet':
      return host.readSheet(payload.sheet, payload.auth);
    case 'snapshot':
      return host.snapshot();
    case 'usedRange':
      return host.getUsedRange(payload.sheet);
  }
}

interface FakeWindow {
  webContents: { send: (channel: string, msg: { id: number; payload: EngineForwardPayload }) => void };
  isDestroyed: () => boolean;
}

/**
 * Fake BrowserWindow whose webContents.send simulates the preload
 * correlator + the renderer's forward handler: the op runs against
 * rendererHost and the reply is delivered on 'engine:forward:reply'.
 */
function makeFakeWindow(rendererHost: EngineHost): { win: FakeWindow; sent: unknown[] } {
  const sent: unknown[] = [];
  const win: FakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, msg: { id: number; payload: EngineForwardPayload }) => {
        sent.push({ channel, msg });
        const reply = replyHandlers.get('engine:forward:reply');
        if (!reply) throw new Error('test setup: reply handler not installed');
        void (async () => {
          try {
            const result = await runRendererOp(rendererHost, msg.payload);
            reply({}, { id: msg.id, ok: true, result });
          } catch (e) {
            reply(
              {},
              { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) },
            );
          }
        })();
      },
    },
  };
  return { win, sent };
}

function makeShim(rendererHost: EngineHost) {
  const { win, sent } = makeFakeWindow(rendererHost);
  const shim = new IpcForwardingEngineHost(
    () => win as unknown as import('electron').BrowserWindow,
  );
  return { shim, win, sent };
}

let ingress: DesktopMcpIngress | null = null;

beforeAll(async () => {
  // Pre-warm the heavy module graphs (same rationale as mcp.test.ts).
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
  vi.useRealTimers();
});

describe('IpcForwardingEngineHost protocol forwarding', () => {
  it('reads come from the renderer host, not the empty local one', async () => {
    const rendererHost = new EngineHost();
    rendererHost.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 41,
    });
    const { shim, sent } = makeShim(rendererHost);

    const values = await shim.readRange(
      { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { principal: 'user' },
    );
    expect(values[0][0]).toMatchObject({ kind: 'number', value: 41 });
    // The op actually crossed the (simulated) IPC boundary.
    expect(sent).toHaveLength(1);
    expect((sent[0] as { channel: string }).channel).toBe('engine:forward');
  });

  it('writes round-trip to the renderer host', async () => {
    const rendererHost = new EngineHost();
    const { shim } = makeShim(rendererHost);

    const res = await shim.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 1, col: 2 },
      value: 'hello',
      auth: { principal: 'user' },
    });
    expect(res.ok).toBe(true);
    // The renderer's host — not the shim's empty local workbook — changed.
    expect(
      rendererHost.readCell({ sheet: 'Sheet1', row: 1, col: 2 }, { principal: 'user' }),
    ).toMatchObject({ kind: 'string', value: 'hello' });
  });

  it('snapshot reflects the renderer workbook', async () => {
    const rendererHost = new EngineHost();
    rendererHost.execute({ cmd: 'addSheet', name: 'Budget' });
    const { shim } = makeShim(rendererHost);

    const snap = await shim.snapshot();
    expect(snap.sheets.map((s) => s.name)).toContain('Budget');
  });

  it('rejects immediately when the renderer window is gone', async () => {
    const shim = new IpcForwardingEngineHost(() => null);
    await expect(
      shim.readRange(
        { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        { principal: 'user' },
      ),
    ).rejects.toThrow(/renderer window is not available/);
  });

  it('rejects after the forward timeout when the renderer never replies', async () => {
    vi.useFakeTimers();
    try {
      const deadWin: FakeWindow = {
        isDestroyed: () => false,
        webContents: { send: () => undefined }, // never replies
      };
      const shim = new IpcForwardingEngineHost(
        () => deadWin as unknown as import('electron').BrowserWindow,
      );
      const pending = shim.readCell({ sheet: 'Sheet1', row: 0, col: 0 }, { principal: 'user' });
      // Attach the rejection handler BEFORE firing the timer, otherwise the
      // rejection is briefly unhandled.
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ingestEvent fans renderer-pushed events out to subscribers', () => {
    const { shim } = makeShim(new EngineHost());
    const seen: string[] = [];
    const off = shim.subscribe((e) => seen.push(e.type));
    shim.ingestEvent({ type: 'recalcComplete' });
    shim.ingestEvent({ type: 'sheetAdded', name: 'S2' });
    off();
    shim.ingestEvent({ type: 'recalcComplete' });
    expect(seen).toEqual(['recalcComplete', 'sheetAdded']);
  });
});

describe('desktop MCP ingress over the forwarding shim (GAP-1)', () => {
  it(
    'third-party MCP clients see the renderer workbook, not an empty one',
    { timeout: 20000 },
    async () => {
      setMcpPortEnv();
      // The "user's open workbook": lives in the RENDERER's host only.
      const rendererHost = new EngineHost();
      rendererHost.execute({
        cmd: 'setCell',
        ref: { sheet: 'Sheet1', row: 0, col: 0 },
        value: 41,
      });
      const { shim } = makeShim(rendererHost);

      ingress = await startDesktopMcpIngress(shim);

      // Read path: the MCP client sees the renderer's cell.
      const data = (await callLocalMcpTool('read_cells', {
        sheet: 'Sheet1',
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 0,
      })) as { cells?: unknown[][] };
      expect(data.cells?.[0]?.[0]).toBe(41);

      // Write path: an MCP write lands in the renderer's workbook.
      await callLocalMcpTool('write_cells', {
        cells: [{ sheet: 'Sheet1', row: 0, col: 1, value: 1 }],
      });
      expect(
        rendererHost.readCell({ sheet: 'Sheet1', row: 0, col: 1 }, { principal: 'user' }),
      ).toMatchObject({ kind: 'number', value: 1 });
    },
  );
});
