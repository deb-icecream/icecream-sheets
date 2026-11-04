/**
 * Connected data sources over MCP: list_data_sources -> open_data_source ->
 * read_cells (the typed view) -> refresh_data_source, through the real MCP
 * protocol surface (SDK Client <-> InMemoryTransport <-> server).
 *
 * Verifies the AI Agent can discover and open connected sources and query
 * them with the existing read_cells tool — no new read path needed because
 * connected data lives in the engine.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EngineHost } from '@icecream-sheets/engine';
import { createServer } from '../src/server.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

async function makeClient(fixtures: Record<string, string>, seen?: { url: string; headers?: Record<string, string> }[]) {
  const fetchText = async (url: string, init?: { headers?: Record<string, string>; method?: string }) => {
    seen?.push({ url, headers: init?.headers });
    const body = fixtures[url];
    if (body === undefined) throw new Error(`no fixture for ${url}`);
    return body;
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(new EngineHost(), { dataSources: { fetchText } });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  return payloadOf(result);
}

const CSV_URL = 'https://example.com/sales.csv';
const CSV_V1 = 'Name,Amount\nAlice,100\nBob,200\n';
const CSV_V2 = 'Name,Amount\nAlice,150\n';

describe('data source MCP tools', () => {
  it('list_data_sources reports kinds and starts empty', async () => {
    const client = await makeClient({});
    const listed = await call(client, 'list_data_sources', {});
    expect(listed.ok).toBe(true);
    const kinds = listed.kinds as Array<{ kind: string; displayName: string; paramHelp: string }>;
    expect(kinds.map((k) => k.kind).sort()).toEqual(['csv-url', 'google-sheets', 'json-url', 'mail', 'marketdata', 'rest-api', 'sql']);
    for (const k of kinds) {
      expect(k.displayName.length).toBeGreaterThan(0);
      expect(k.paramHelp.length).toBeGreaterThan(0);
    }
    expect(listed.sources).toEqual([]);
  });

  it('open_data_source -> read_cells sees the connected table (end-to-end)', async () => {
    const client = await makeClient({ [CSV_URL]: CSV_V1 });
    const opened = await call(client, 'open_data_source', {
      kind: 'csv-url',
      label: 'Sales',
      params: { url: CSV_URL },
    });
    expect(opened.ok).toBe(true);
    expect(opened.sheet).toBe('Sales');
    expect(opened.rows).toBe(2);
    expect(opened.columns).toEqual(['Name', 'Amount']);

    // The typed computational view serves the connected data: no new read path.
    const read = await call(client, 'read_cells', {
      sheet: 'Sales',
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 1,
    });
    expect(read.ok).toBe(true);
    expect(read.cells).toEqual([
      ['Name', 'Amount'],
      ['Alice', 100],
      ['Bob', 200],
    ]);

    // Formulas compute over the connected sheet.
    const formula = await call(client, 'set_formulas', {
      formulas: [{ sheet: 'Sales', row: 3, col: 1, formula: '=SUM(B2:B3)' }],
    });
    expect(formula.ok).toBe(true);
    const total = await call(client, 'read_cells', {
      sheet: 'Sales',
      startRow: 3,
      startCol: 1,
      endRow: 3,
      endCol: 1,
    });
    expect((total.cells as unknown[][])[0]?.[0]).toBe(300);

    // list_data_sources now shows the binding.
    const listed = await call(client, 'list_data_sources', {});
    const sources = listed.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.sheet).toBe('Sales');
    expect(sources[0]?.kind).toBe('csv-url');
    expect(sources[0]?.lastRefresh).toBeTruthy();
  });

  it('rows semantics are uniform: list summary rows are DATA rows, matching the open result', async () => {
    // Pinning test: tool outputs report DATA rows (excluding the header
    // row). The CSV fixture has a header + 2 data rows; open returns
    // rows === 2, and the list_data_sources summary for the same binding
    // must report the same 2 — not the connector layer's sheet-row
    // count (header included), which binding.rowCount carries for
    // refresh planning.
    const client = await makeClient({ [CSV_URL]: CSV_V1 });
    const opened = await call(client, 'open_data_source', {
      kind: 'csv-url',
      label: 'Sales',
      params: { url: CSV_URL },
    });
    expect(opened.ok).toBe(true);
    expect(opened.rows).toBe(2);

    const listed = await call(client, 'list_data_sources', {});
    const sources = listed.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.rows).toBe(opened.rows);
    expect(sources[0]?.rows).toBe(2);
  });

  it('open_data_source rejects invalid specs without fetching', async () => {
    const seen: { url: string }[] = [];
    const client = await makeClient({}, seen);
    const opened = await call(client, 'open_data_source', {
      kind: 'csv-url',
      params: { url: 'file:///etc/passwd' },
    });
    expect(opened.ok).toBe(false);
    expect(String(opened.error)).toContain('http(s)');
    expect(seen).toHaveLength(0);
  });

  it('refresh_data_source swaps the sheet data atomically', async () => {
    const fixtures: Record<string, string> = { [CSV_URL]: CSV_V1 };
    const client = await makeClient(fixtures);
    await call(client, 'open_data_source', {
      kind: 'csv-url',
      label: 'Sales',
      params: { url: CSV_URL },
    });
    // Source changes upstream (fewer rows, new value).
    fixtures[CSV_URL] = CSV_V2;
    const refreshed = await call(client, 'refresh_data_source', { sheet: 'Sales' });
    expect(refreshed.ok).toBe(true);
    expect(refreshed.rows).toBe(1);

    const read = await call(client, 'read_cells', {
      sheet: 'Sales',
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 1,
    });
    // Stale tail row cleared (null), new value present.
    expect(read.cells).toEqual([
      ['Name', 'Amount'],
      ['Alice', 150],
      [null, null],
    ]);
  });

  it('refresh_data_source errors for unbound sheets', async () => {
    const client = await makeClient({});
    const refreshed = await call(client, 'refresh_data_source', { sheet: 'Nope' });
    expect(refreshed.ok).toBe(false);
    expect(String(refreshed.error)).toContain('no connected data source');
  });

  it('credentialRef fails closed without a resolver, works with one', async () => {
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createServer(new EngineHost(), {
      dataSources: {
        fetchText: async (url: string, init?: { headers?: Record<string, string> }) => {
          seen.push({ url, headers: init?.headers });
          return '[{"a":1}]';
        },
      },
    });
    await server.connect(st);
    const client = new Client({ name: 't', version: '0.0.0' });
    await client.connect(ct);

    const denied = await call(client, 'open_data_source', {
      kind: 'rest-api',
      params: { url: 'https://api.example.com/rows' },
      credentialRef: 'vault:token',
    });
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toContain('no credential resolver');

    // With a resolver the secret travels as a transient Bearer header.
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const server2 = createServer(new EngineHost(), {
      dataSources: {
        fetchText: async (url: string, init?: { headers?: Record<string, string> }) => {
          seen.push({ url, headers: init?.headers });
          return '[{"a":1}]';
        },
        resolveCredential: { resolveCredential: async () => 's3cret' },
      },
    });
    await server2.connect(st2);
    const client2 = new Client({ name: 't', version: '0.0.0' });
    await client2.connect(ct2);
    const opened = await call(client2, 'open_data_source', {
      kind: 'rest-api',
      label: 'API rows',
      params: { url: 'https://api.example.com/rows' },
      credentialRef: 'vault:token',
    });
    expect(opened.ok).toBe(true);
    expect(seen[seen.length - 1]?.headers?.['Authorization']).toBe('Bearer s3cret');
  });

  it('duplicate sheet names are uniquified', async () => {
    const client = await makeClient({ [CSV_URL]: CSV_V1 });
    const first = await call(client, 'open_data_source', {
      kind: 'csv-url',
      label: 'Sales',
      params: { url: CSV_URL },
    });
    const second = await call(client, 'open_data_source', {
      kind: 'csv-url',
      label: 'Sales',
      params: { url: CSV_URL },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.sheet).toBe('Sales 2');
  });
});
