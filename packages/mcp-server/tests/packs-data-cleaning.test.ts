/**
 * Data-cleaning pack end-to-end tests: real MCP protocol
 * (SDK Client <-> InMemoryTransport <-> server), tools only.
 * Includes the shared-fixture ground truth: sales.csv revenue must
 * SUM to 4027.86 after the pack coerces the text column to numbers.
 */
import { readFileSync } from 'node:fs';
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
  return JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function makeClient(host?: EngineHost): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host);
  await server.connect(serverTransport);
  const client = new Client({ name: 'cleaning-test-client', version: '0.0.0' });
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

/** Seed a whole table (header + rows) into a sheet through write_cells. */
async function seedTable(
  client: Client,
  sheet: string,
  matrix: (string | number | null)[][],
): Promise<void> {
  const cells: Record<string, unknown>[] = [];
  matrix.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value !== null) cells.push({ sheet, row: r, col: c, value });
    });
  });
  for (let i = 0; i < cells.length; i += 500) {
    const res = await call(client, 'write_cells', { cells: cells.slice(i, i + 500) });
    expect(res.ok).toBe(true);
  }
}

async function readAll(client: Client, sheet: string): Promise<unknown[][]> {
  const res = await call(client, 'get_results', { sheet });
  expect(res.ok).toBe(true);
  return res.cells as unknown[][];
}

describe('data-cleaning pack', () => {
  it('headline workflow: dedupe -> normalize -> coerce -> fill -> SUM', async () => {
    const host = new EngineHost();
    await host.execute({ cmd: 'addSheet', name: 'Orders' });
    const client = await makeClient(host);
    await seedTable(client, 'Orders', [
      ['Order', 'Customer', 'Amount', 'Qty', 'Date'],
      ['1001', '  acme corp ', '$1,234.56', 2, '01/15/2026'],
      ['1002', 'Globex', '250.00', 1, '2026-01-16'],
      ['1001', '  acme corp ', '$1,234.56', 2, '01/15/2026'],
      ['1003', 'Initech', null, 3, '2026-01-17'],
      ['1004', 'Umbrella', '89.9', 1, '2026-01-18'],
    ]);

    const deduped = await call(client, 'clean_dedupe_rows', { sheet: 'Orders' });
    expect(deduped.ok).toBe(true);
    expect(deduped.removed).toBe(1);
    expect(deduped.rowsOut).toBe(4);

    const normalized = await call(client, 'clean_normalize_text', {
      sheet: 'Orders',
      columns: ['Customer'],
      case: 'title',
    });
    expect(normalized.ok).toBe(true);
    expect(normalized.cellsChanged).toBe(1);

    const coerced = await call(client, 'clean_coerce_types', {
      sheet: 'Orders',
      conversions: [
        { column: 'Amount', type: 'number' },
        { column: 'Date', type: 'date' },
      ],
    });
    expect(coerced.ok).toBe(true);
    const conv = coerced.conversions as {
      column: string;
      converted: number;
      alreadyOk: number;
      failedCount: number;
    }[];
    // The engine itself parses plain numeric strings ('250.00', '89.9')
    // on write; only the human-formatted '$1,234.56' reaches the pack
    // as text and needs coercion.
    expect(conv.find((c) => c.column === 'Amount')?.converted).toBe(1);
    expect(conv.find((c) => c.column === 'Amount')?.alreadyOk).toBe(2);
    expect(conv.find((c) => c.column === 'Amount')?.failedCount).toBe(0);
    expect(conv.find((c) => c.column === 'Date')?.converted).toBe(1);

    const filled = await call(client, 'clean_fill_missing', {
      sheet: 'Orders',
      column: 'Amount',
      strategy: 'median',
    });
    expect(filled.ok).toBe(true);
    expect(filled.filled).toBe(1);
    expect(filled.fillValue).toBe(250);

    const table = await readAll(client, 'Orders');
    // (The engine parses the '1001' order id to a number on write.)
    expect(table[1]).toEqual([1001, 'Acme Corp', 1234.56, 2, '2026-01-15']);
    expect(table[3]?.[2]).toBe(250);

    // The cleaned Amount column is summable by the engine itself.
    await call(client, 'write_cells', {
      cells: [{ sheet: 'Orders', row: 6, col: 0, value: 'Total' }],
    });
    await call(client, 'set_formulas', {
      formulas: [{ sheet: 'Orders', row: 6, col: 2, formula: '=SUM(C2:C5)' }],
    });
    const total = await call(client, 'read_cells', {
      sheet: 'Orders',
      startRow: 6,
      startCol: 2,
      endRow: 6,
      endCol: 2,
    });
    expect((total.cells as unknown[][])[0]?.[0]).toBeCloseTo(1824.46, 2);
  });

  it('cleans the shared sales fixture to the 4027.86 ground truth', async () => {
    const csv = readFileSync(
      new URL('../../../hidden_files/shared-fixtures/sales.csv', import.meta.url),
      'utf8',
    ).trim();
    const lines = csv.split('\n').map((l) => l.split(','));
    const header = lines[0] as string[];
    const dataRows = lines.slice(1);
    expect(dataRows).toHaveLength(24);

    const host = new EngineHost();
    await host.execute({ cmd: 'addSheet', name: 'Sales' });
    const client = await makeClient(host);
    // Write revenue as TEXT (as a paste/import would) — the pack must
    // coerce it before the engine can sum it.
    const matrix: (string | number | null)[][] = [
      header,
      ...dataRows.map((r) => [
        Number(r[0]),
        r[1] as string,
        r[2] as string,
        r[3] as string,
        Number(r[4]),
        r[5] as string,
        r[6] as string,
      ]),
    ];
    await seedTable(client, 'Sales', matrix);

    const coerced = await call(client, 'clean_coerce_types', {
      sheet: 'Sales',
      conversions: [{ column: 'revenue', type: 'number' }],
    });
    expect(coerced.ok).toBe(true);

    await call(client, 'set_formulas', {
      formulas: [{ sheet: 'Sales', row: 26, col: 6, formula: '=SUM(G2:G25)' }],
    });
    const total = await call(client, 'read_cells', {
      sheet: 'Sales',
      startRow: 26,
      startCol: 6,
      endRow: 26,
      endCol: 6,
    });
    expect((total.cells as unknown[][])[0]?.[0]).toBeCloseTo(4027.86, 2);
  });

  it('splits and merges columns', async () => {
    const host = new EngineHost();
    await host.execute({ cmd: 'addSheet', name: 'People' });
    const client = await makeClient(host);
    await seedTable(client, 'People', [
      ['Name', 'City'],
      ['Doe, Jane', 'NYC'],
      ['Smith, John', 'LA'],
    ]);

    const split = await call(client, 'clean_split_column', {
      sheet: 'People',
      column: 'Name',
      delimiter: ',',
      newColumns: ['Last', 'First'],
    });
    expect(split.ok).toBe(true);
    let table = await readAll(client, 'People');
    expect(table[0]).toEqual(['Last', 'First', 'City']);
    expect(table[1]).toEqual(['Doe', 'Jane', 'NYC']);

    const merged = await call(client, 'clean_merge_columns', {
      sheet: 'People',
      columns: ['Last', 'First'],
      newColumn: 'Full Name',
      separator: ', ',
    });
    expect(merged.ok).toBe(true);
    table = await readAll(client, 'People');
    expect(table[0]).toEqual(['Last', 'First', 'City', 'Full Name']);
    expect(table[1]?.[3]).toBe('Doe, Jane');
    expect(table[2]?.[3]).toBe('Smith, John');
  });

  it('fill_missing forward-fill and drop-row behave', async () => {
    const host = new EngineHost();
    await host.execute({ cmd: 'addSheet', name: 'Log' });
    const client = await makeClient(host);
    await seedTable(client, 'Log', [
      ['Day', 'Reading'],
      ['Mon', 10],
      ['Tue', null],
      ['Wed', null],
      ['Thu', 40],
    ]);
    const fwd = await call(client, 'clean_fill_missing', {
      sheet: 'Log',
      column: 'Reading',
      strategy: 'forward',
    });
    expect(fwd.filled).toBe(2);
    const table = await readAll(client, 'Log');
    expect(table.map((r) => r[1])).toEqual(['Reading', 10, 10, 10, 40]);

    const dropped = await call(client, 'clean_fill_missing', {
      sheet: 'Log',
      column: 'Reading',
      strategy: 'drop-row',
      targetSheet: 'LogDropped',
    });
    expect(dropped.ok).toBe(true);
    // Forward-filled sheet has no missing left, so nothing drops there;
    // the point is the target-sheet path works and reports honestly.
    expect(dropped.dropped).toBe(0);
  });

  it('reports unknown columns instead of guessing', async () => {
    const client = await makeClient();
    await seedTable(client, 'Sheet1', [
      ['A', 'B'],
      [1, 2],
    ]);
    const res = await call(client, 'clean_dedupe_rows', {
      sheet: 'Sheet1',
      columns: ['Nope'],
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('unknown column "Nope"');
  });
});
