/**
 * Survey-analysis pack end-to-end tests: real MCP protocol, tools
 * only. Covers response coding (with a synonym mapping and an
 * unmapped answer), frequency tables, cross-tabulation, and charting
 * through an injected ChartSink (plus the fail-closed no-sink path,
 * mirroring create_chart).
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EngineHost } from '@icecream-sheets/engine';
import type { ChartSpec } from '@icecream-sheets/service';
import { createServer, type ServerOptions } from '../src/server.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
  return JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function makeClient(options?: ServerOptions, host?: EngineHost): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host, options);
  await server.connect(serverTransport);
  const client = new Client({ name: 'survey-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return payloadOf(await client.callTool({ name, arguments: args }));
}

const RESPONSES: (string | number | null)[][] = [
  ['Plan', 'Satisfaction', 'Heard'],
  ['Free', 'Happy', 'Friend'],
  ['Pro', 'Happy', ' friend '],
  ['Free', 'Sad', 'FRIEND'],
  ['Pro', 'Happy', 'Google'],
  ['Free', 'Neutral', 'google search'],
  ['Pro', 'Sad', 'Podcast'],
  ['Free', 'Happy', null],
  ['Pro', 'Neutral', 'Google'],
];

async function seedResponses(client: Client): Promise<void> {
  const cells: Record<string, unknown>[] = [];
  RESPONSES.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value !== null) cells.push({ sheet: 'Responses', row: r, col: c, value });
    });
  });
  const res = await call(client, 'write_cells', { cells });
  expect(res.ok).toBe(true);
}

async function makeSeededClient(options?: ServerOptions): Promise<Client> {
  const host = new EngineHost();
  await host.execute({ cmd: 'addSheet', name: 'Responses' });
  const client = await makeClient(options, host);
  await seedResponses(client);
  return client;
}

describe('survey-analysis pack', () => {
  it('survey_code_responses canonicalizes with a mapping and reports unmapped', async () => {
    const client = await makeSeededClient();
    const res = await call(client, 'survey_code_responses', {
      sheet: 'Responses',
      column: 'Heard',
      mapping: { Friend: 'Referral', Google: 'Search', 'Google Search': 'Search' },
    });
    expect(res.ok).toBe(true);
    expect(res.coded).toBe(6);
    expect(res.missing).toBe(1);
    const codebook = res.codebook as { code: string; count: number }[];
    expect(codebook).toEqual([
      { code: 'Referral', label: 'Friend', count: 3 },
      { code: 'Search', label: 'Google', count: 3 },
    ]);
    expect(res.unmapped).toEqual([{ label: 'Podcast', count: 1 }]);

    const table = await call(client, 'get_results', { sheet: 'Responses' });
    const cells = table.cells as unknown[][];
    expect(cells[0]?.[3]).toBe('Heard Code');
    expect(cells[1]?.[3]).toBe('Referral');
    expect(cells[6]?.[3]).toBeNull();
  });

  it('survey_code_responses without a mapping uses canonical labels as codes', async () => {
    const client = await makeSeededClient();
    const res = await call(client, 'survey_code_responses', {
      sheet: 'Responses',
      column: 'Satisfaction',
    });
    expect(res.ok).toBe(true);
    const codebook = res.codebook as { code: string; count: number }[];
    expect(codebook).toEqual([
      { code: 'Happy', label: 'Happy', count: 4 },
      { code: 'Neutral', label: 'Neutral', count: 2 },
      { code: 'Sad', label: 'Sad', count: 2 },
    ]);
  });

  it('survey_frequencies counts and percents sum to the valid total', async () => {
    const client = await makeSeededClient();
    const res = await call(client, 'survey_frequencies', {
      sheet: 'Responses',
      column: 'Satisfaction',
    });
    expect(res.ok).toBe(true);
    expect(res.totalResponses).toBe(8);
    expect(res.validResponses).toBe(8);
    const table = res.table as { label: string; count: number; percent: number }[];
    expect(table[0]).toMatchObject({ label: 'Happy', count: 4, percent: 0.5 });
    expect(table.reduce((a, r) => a + r.percent, 0)).toBeCloseTo(1, 9);

    const sheet = await call(client, 'get_results', { sheet: 'Frequencies' });
    expect((sheet.cells as unknown[][])[0]).toEqual([
      'Satisfaction',
      'Count',
      'Percent',
      'Cumulative %',
    ]);
  });

  it('survey_crosstab builds the full matrix with totals', async () => {
    const client = await makeSeededClient();
    const res = await call(client, 'survey_crosstab', {
      sheet: 'Responses',
      rowColumn: 'Plan',
      columnColumn: 'Satisfaction',
    });
    expect(res.ok).toBe(true);
    expect(res.rowLabels).toEqual(['Free', 'Pro']);
    expect(res.columnLabels).toEqual(['Happy', 'Neutral', 'Sad']);
    expect(res.matrix).toEqual([
      [2, 1, 1],
      [2, 1, 1],
    ]);
    expect(res.rowTotals).toEqual([4, 4]);
    expect(res.columnTotals).toEqual([4, 2, 2]);
    expect(res.grandTotal).toBe(8);

    const sheet = await call(client, 'get_results', { sheet: 'Crosstab' });
    expect(sheet.cells).toEqual([
      ['Plan', 'Happy', 'Neutral', 'Sad', 'Total'],
      ['Free', 2, 1, 1, 4],
      ['Pro', 2, 1, 1, 4],
      ['Total', 4, 2, 2, 8],
    ]);
  });

  it('survey_chart_results charts through the sink and fails closed without one', async () => {
    const captured: ChartSpec[] = [];
    const sink = {
      addChart: async (spec: ChartSpec) => {
        captured.push(spec);
        return { id: 'chart-42', revision: 7 };
      },
    };
    const client = await makeSeededClient({ charts: sink });
    const res = await call(client, 'survey_chart_results', {
      sheet: 'Responses',
      column: 'Satisfaction',
      kind: 'pie',
    });
    expect(res.ok).toBe(true);
    expect(res.chartId).toBe('chart-42');
    expect(res.revision).toBe(7);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('pie');
    expect(captured[0]?.seriesRanges[0]?.val.sheet).toBe('Chart Data');

    const bare = await makeSeededClient();
    const refused = await call(bare, 'survey_chart_results', {
      sheet: 'Responses',
      column: 'Satisfaction',
    });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('chart creation is not available');
  });
});
