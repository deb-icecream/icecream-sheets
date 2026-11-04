/**
 * W1 — first-turn sheet-context failure (root-fix regression tests).
 *
 * Mechanism (proven from the case-4 re-run + planner-diag audit): the
 * agent's session-bound host, NodeRemoteEngineHost, served sheet names
 * from a cache that starts EMPTY on every fresh runtime and is only
 * warmed by a fire-and-forget background fetch (or a snapshot). The one
 * MCP tool that validates a sheet name — create_chart — therefore saw
 * `[]` on a fresh session's first turn and reported
 * `unknown sheet "Sales"` for a sheet the session provably held; the
 * background fetch that same call kicked off warmed the cache, so the
 * identical call on turn 2 succeeded (3/3 first-turn failures in the
 * case-4 re-run; the planner-diag audit captured the MCP-layer error
 * text `unknown sheet "Sales"`, not the engine's `unknown sheet: …`).
 *
 * The fix: the host exposes sheetNamesAsync() — an awaited, always-fresh
 * read of the engine's /sheets — and create_chart consumes it when the
 * bound host provides it (see packages/mcp-server/tests/create-chart).
 * These tests pin the host side; the composition test at the bottom
 * pins host + MCP server together exactly as agentSvc wires them.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ChartSink } from '@icecream-sheets/mcp-server';
import type { TypedValue } from '@icecream-sheets/engine';
import {
  NodeRemoteEngineHost,
  type RemoteEngineFetch,
  type RemoteEngineFetchInit,
} from '../src/services/remoteEngineHost.js';

interface RecordedCall {
  url: string;
  init: RemoteEngineFetchInit;
  body: Record<string, unknown> | null;
}

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

const NUM = (value: number): TypedValue => ({ kind: 'number', value });
const STR = (value: string): TypedValue => ({ kind: 'string', value });

/**
 * A fake engine whose workbook has ONE sheet, "Sales", with a header row
 * and two numeric data rows — the case-4 fixture shape. `state.sheets`
 * is mutable so a test can rename/add sheets engine-side mid-flight.
 */
function fakeEngineFetch(state: { sheets: string[]; sheetsDelayMs?: number }) {
  const calls: RecordedCall[] = [];
  const fetchFn: RemoteEngineFetch = async (url, init) => {
    const call: RecordedCall = {
      url,
      init,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (url.endsWith('/sheets')) {
      if (state.sheetsDelayMs) {
        await new Promise((r) => setTimeout(r, state.sheetsDelayMs));
      }
      return jsonResponse(200, { sheets: [...state.sheets] });
    }
    if (url.endsWith('/read')) {
      const range = call.body?.range as
        | { startRow: number; startCol: number; endRow: number; endCol: number }
        | undefined;
      if (call.body?.kind === 'range' && range) {
        const grid: TypedValue[][] = [
          [STR('Month'), STR('Revenue')],
          [STR('Jan'), NUM(12000)],
          [STR('Feb'), NUM(9800)],
        ];
        const values: TypedValue[][] = [];
        const formulas: (string | null)[][] = [];
        for (let r = range.startRow; r <= range.endRow; r++) {
          values.push((grid[r] ?? []).slice(range.startCol, range.endCol + 1));
          formulas.push([null, null].slice(range.startCol, range.endCol + 1));
        }
        return jsonResponse(200, { values, formulas });
      }
      return jsonResponse(400, { error: 'bad read kind' });
    }
    if (url.endsWith('/session/status')) return jsonResponse(200, { ok: true, revision: 0 });
    if (url.endsWith('/events')) return jsonResponse(200, { events: [] });
    return jsonResponse(404, { error: `fake engine: no route ${url}` });
  };
  return { calls, fetchFn };
}

function makeHost(fetchFn: RemoteEngineFetch) {
  return new NodeRemoteEngineHost({
    engineUrl: 'http://engine.test:8101',
    principal: 'user:carol',
    sessionId: 'sess_w1',
    fileId: 'file-w1',
    getAccessToken: () => 'tok-1',
    fetchFn,
    pollMs: 60_000,
  });
}

describe('NodeRemoteEngineHost sheet names (W1)', () => {
  it('sheetNamesAsync returns the real sheets on the FIRST call of a fresh host', async () => {
    const { calls, fetchFn } = fakeEngineFetch({ sheets: ['Sales'] });
    const host = makeHost(fetchFn);
    // The documented sync contract stays cache-only on a cold host —
    // this is exactly why an awaiting consumer must use the async path.
    expect(host.sheetNames()).toEqual([]);
    const names = await host.sheetNamesAsync();
    expect(names).toEqual(['Sales']);
    expect(calls.filter((c) => c.url.endsWith('/sheets'))).toHaveLength(1);
    // The awaited fetch also warms the sync cache.
    expect(host.sheetNames()).toEqual(['Sales']);
    host.dispose();
  });

  it('sheetNamesAsync sees sheets renamed/added engine-side after warm-up', async () => {
    const state = { sheets: ['Sales'] };
    const { fetchFn } = fakeEngineFetch(state);
    const host = makeHost(fetchFn);
    expect(await host.sheetNamesAsync()).toEqual(['Sales']);
    // The user renames the sheet in the grid (engine-side) AFTER the
    // agent runtime was bound — a cached list would now be wrong.
    state.sheets = ['Revenue', 'Notes'];
    expect(await host.sheetNamesAsync()).toEqual(['Revenue', 'Notes']);
    expect(host.sheetNames()).toEqual(['Revenue', 'Notes']);
    host.dispose();
  });

  it('concurrent first sheetNamesAsync calls share one /sheets request', async () => {
    const { calls, fetchFn } = fakeEngineFetch({ sheets: ['Sales'], sheetsDelayMs: 25 });
    const host = makeHost(fetchFn);
    const [a, b, c] = await Promise.all([
      host.sheetNamesAsync(),
      host.sheetNamesAsync(),
      host.sheetNamesAsync(),
    ]);
    expect(a).toEqual(['Sales']);
    expect(b).toEqual(['Sales']);
    expect(c).toEqual(['Sales']);
    expect(calls.filter((call) => call.url.endsWith('/sheets'))).toHaveLength(1);
    host.dispose();
  });
});

describe('W1 composition: fresh session-bound host + MCP create_chart', () => {
  it('create_chart succeeds as the FIRST tool call on a fresh host (turn 1)', async () => {
    const { fetchFn } = fakeEngineFetch({ sheets: ['Sales'] });
    const host = makeHost(fetchFn);
    const captured: Array<{ sheet: string }> = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push({ sheet: spec.range.sheet });
        return { id: spec.id, revision: 1 };
      },
    };
    const server = createServer(host, { charts: sink });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'w1-test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      // NO prior tool call of any kind: this is the fresh session's
      // first turn, the exact case-4 re-run shape.
      const res = (await client.callTool({
        name: 'create_chart',
        arguments: { sheet: 'Sales', range: 'A1:B3', kind: 'column', title: 'Revenue' },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      const payload = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
      expect(payload.ok).toBe(true);
      expect(payload.sheet).toBe('Sales');
      expect(captured).toEqual([{ sheet: 'Sales' }]);
    } finally {
      await client.close().catch(() => undefined);
      host.dispose();
    }
  });

  it('create_chart still refuses a genuinely unknown sheet on a fresh host', async () => {
    const { fetchFn } = fakeEngineFetch({ sheets: ['Sales'] });
    const host = makeHost(fetchFn);
    const sink: ChartSink = {
      async addChart(spec) {
        return { id: spec.id, revision: 1 };
      },
    };
    const server = createServer(host, { charts: sink });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'w1-test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({
        name: 'create_chart',
        arguments: { sheet: 'Nope', range: 'A1:B3', kind: 'column' },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      const payload = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
      expect(payload.ok).toBe(false);
      expect(String(payload.error)).toContain('unknown sheet "Nope"');
    } finally {
      await client.close().catch(() => undefined);
      host.dispose();
    }
  });
});
