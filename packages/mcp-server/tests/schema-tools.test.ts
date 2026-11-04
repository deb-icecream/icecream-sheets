/**
 * Schema-first agent tools: describe_sheet, find_label, aggregate_cells.
 * Income-shaped horizontal data (years row = dimension, measure rows
 * below) plus a vertical-layout sheet. Built through the real MCP
 * protocol surface (InMemoryTransport), same pattern as server.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
  expect(res.content[0].type).toBe('text');
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

async function makeClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  return payloadOf(result);
}

// Ground-truth Revenue row, Income sheet, years 2012-2021 (0-based row 6,
// cols 1-10). Sum = 1501837.907806084 (parent-verified from bxl3way).
const REVENUE = [
  102007, 118086, 131345, 142341, 150772, 158310.6, 165434.577, 172051.96008,
  178073.77868279998, 183415.99204328397,
];

async function buildIncome(client: Client): Promise<void> {
  const cells: { sheet: string; row: number; col: number; value: string | number }[] = [
    { sheet: 'Income', row: 0, col: 0, value: 'Income Statement' },
    { sheet: 'Income', row: 6, col: 0, value: 'Revenue' },
    { sheet: 'Income', row: 8, col: 0, value: 'Gross Profit' },
    { sheet: 'Income', row: 20, col: 0, value: 'Net Earnings' },
  ];
  for (let i = 0; i < 10; i++) {
    cells.push({ sheet: 'Income', row: 5, col: 1 + i, value: 2012 + i });
    cells.push({ sheet: 'Income', row: 6, col: 1 + i, value: REVENUE[i] });
    cells.push({ sheet: 'Income', row: 8, col: 1 + i, value: 60000 + i * 1000 });
    cells.push({ sheet: 'Income', row: 20, col: 1 + i, value: 2000 + i * 500 });
  }
  const written = await call(client, 'write_cells', { cells });
  expect(written.ok).toBe(true);
}

describe('schema-first tools', () => {
  it('describe_sheet maps the horizontal Income layout without dumping values', async () => {
    const client = await makeClient();
    await buildIncome(client);
    const desc = await call(client, 'describe_sheet', { sheet: 'Income' });
    expect(desc.ok).toBe(true);
    expect(desc).not.toHaveProperty('cells');
    const used = desc.usedRange as { startRow: number; startCol: number; endRow: number; endCol: number };
    expect(used.startRow).toBe(0);
    expect(used.startCol).toBe(0);
    expect(used.endRow).toBe(20);
    expect(used.endCol).toBe(10);
    expect(desc.scanned).toBe(true);
    // Years row (0-based 5) is the dimension; measure rows are not.
    expect(desc.dimensionRows).toEqual([5]);
    expect(desc.dimensionCols).toEqual([]);
    expect(desc.suggestedLayout).toBe('horizontal');
    const rows = desc.rowSummaries as { row: number; label: string | null; numericCount: number; dimensionLike: boolean }[];
    const revenue = rows.find((r) => r.row === 6);
    expect(revenue?.label).toBe('Revenue');
    expect(revenue?.numericCount).toBe(10);
    expect(revenue?.dimensionLike).toBe(false);
    const netEarnings = rows.find((r) => r.row === 20);
    expect(netEarnings?.label).toBe('Net Earnings');
  });

  it('describe_sheet labels the coordinate frame as absolute (rows never re-based to the dimension row)', async () => {
    // Regression for the re-proof frame bug: the agent read Revenue as
    // "row 1" (absolute row 6 minus the years-row origin 5) and used it
    // as absolute in aggregate_cells + verification declarations. The
    // response must now state the frame explicitly — including that
    // rows are NOT offsets from the dimension row — and the rows must
    // be absolute. (This host reports the used range from the sheet
    // origin, so startRow is 0 even though content starts at row 5;
    // the regression pin is the absolute row + the label, not the
    // used-range start.)
    const client = await makeClient();
    const cells: { sheet: string; row: number; col: number; value: string | number }[] = [];
    for (let i = 0; i < 10; i++) {
      cells.push({ sheet: 'Offset', row: 5, col: 1 + i, value: 2012 + i });
      cells.push({ sheet: 'Offset', row: 6, col: 1 + i, value: REVENUE[i] });
      cells.push({ sheet: 'Offset', row: 8, col: 1 + i, value: 60000 + i * 1000 });
      cells.push({ sheet: 'Offset', row: 20, col: 1 + i, value: 2000 + i * 500 });
    }
    cells.push({ sheet: 'Offset', row: 6, col: 0, value: 'Revenue' });
    cells.push({ sheet: 'Offset', row: 8, col: 0, value: 'Gross Profit' });
    cells.push({ sheet: 'Offset', row: 20, col: 0, value: 'Net Earnings' });
    const written = await call(client, 'write_cells', { cells });
    expect(written.ok).toBe(true);
    const desc = await call(client, 'describe_sheet', { sheet: 'Offset' });
    expect(desc.ok).toBe(true);
    expect(typeof desc.coordinateFrame).toBe('string');
    expect(desc.coordinateFrame as string).toContain('ABSOLUTE');
    expect(desc.coordinateFrame as string).toContain('col 0 is column A');
    const used = desc.usedRange as { startRow: number; endRow: number };
    expect(used.startRow).toBe(0);
    const rows = desc.rowSummaries as { row: number; label: string | null }[];
    // Absolute, NOT block-relative (6-5=1 would be the re-proof error).
    expect(rows.find((r) => r.label === 'Revenue')?.row).toBe(6);
    expect(rows.find((r) => r.label === 'Gross Profit')?.row).toBe(8);
    expect(rows.find((r) => r.label === 'Net Earnings')?.row).toBe(20);
    expect(desc.dimensionRows).toEqual([5]);
    expect(desc.suggestedLayout).toBe('horizontal');
    // find_label carries the same frame label on its absolute matches.
    const found = await call(client, 'find_label', { sheet: 'Offset', label: 'Revenue' });
    expect(found.ok).toBe(true);
    expect(found.matches).toContainEqual({ row: 6, col: 0, axis: 'row' });
    expect(typeof found.coordinateFrame).toBe('string');
  });

  it('describe_sheet flags a vertical year column as the dimension', async () => {
    const client = await makeClient();
    const cells: { sheet: string; row: number; col: number; value: string | number }[] = [
      { sheet: 'Vertical', row: 0, col: 0, value: 'Year' },
      { sheet: 'Vertical', row: 0, col: 1, value: 'Sales' },
    ];
    for (let i = 0; i < 5; i++) {
      cells.push({ sheet: 'Vertical', row: 1 + i, col: 0, value: 2019 + i });
      cells.push({ sheet: 'Vertical', row: 1 + i, col: 1, value: 10 * (i + 1) });
    }
    await call(client, 'write_cells', { cells });
    const desc = await call(client, 'describe_sheet', { sheet: 'Vertical' });
    expect(desc.ok).toBe(true);
    expect(desc.dimensionCols).toEqual([0]);
    expect(desc.dimensionRows).toEqual([]);
    expect(desc.suggestedLayout).toBe('vertical');
  });

  it('describe_sheet on an empty sheet fails honestly', async () => {
    const client = await makeClient();
    const desc = await call(client, 'describe_sheet', { sheet: 'Nope' });
    expect(desc.ok).toBe(false);
  });

  it('aggregate_cells returns engine truth for sum/avg/count/min/max', async () => {
    const client = await makeClient();
    await buildIncome(client);
    const range = { sheet: 'Income', startRow: 6, startCol: 1, endRow: 6, endCol: 10 };
    const sum = await call(client, 'aggregate_cells', { ...range, op: 'sum' });
    expect(sum.ok).toBe(true);
    expect(sum.value as number).toBeCloseTo(1501837.907806084, 6);
    expect(sum.numericCount).toBe(10);
    const avg = await call(client, 'aggregate_cells', { ...range, op: 'avg' });
    expect(avg.value as number).toBeCloseTo(150183.7907806084, 6);
    const count = await call(client, 'aggregate_cells', { ...range, op: 'count' });
    expect(count.value).toBe(10);
    const min = await call(client, 'aggregate_cells', { ...range, op: 'min' });
    expect(min.value).toBe(102007);
    const max = await call(client, 'aggregate_cells', { ...range, op: 'max' });
    expect(max.value as number).toBeCloseTo(183415.99204328397, 6);
  });

  it('aggregate_cells over a text-only range fails instead of inventing a total', async () => {
    const client = await makeClient();
    await buildIncome(client);
    const res = await call(client, 'aggregate_cells', {
      sheet: 'Income',
      startRow: 6,
      startCol: 0,
      endRow: 6,
      endCol: 0,
      op: 'sum',
    });
    expect(res.ok).toBe(false);
  });

  it('find_label resolves exact labels and never guesses', async () => {
    const client = await makeClient();
    await buildIncome(client);
    const revenue = await call(client, 'find_label', { sheet: 'Income', label: 'Revenue' });
    expect(revenue.ok).toBe(true);
    expect(revenue.found).toBe(true);
    expect(revenue.matches).toContainEqual({ row: 6, col: 0, axis: 'row' });
    const net = await call(client, 'find_label', { sheet: 'Income', label: 'Net Earnings' });
    expect(net.found).toBe(true);
    expect(net.matches).toContainEqual({ row: 20, col: 0, axis: 'row' });
    // Not-found is explicit, never fuzzy: 'Total Revenue' is not a row.
    const missing = await call(client, 'find_label', { sheet: 'Income', label: 'Total Revenue' });
    expect(missing.found).toBe(false);
    expect(missing.matches).toEqual([]);
    // Case-sensitive exactness: lowercase does not match.
    const cased = await call(client, 'find_label', { sheet: 'Income', label: 'revenue' });
    expect(cased.found).toBe(false);
  });
});
