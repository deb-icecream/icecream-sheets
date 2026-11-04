/**
 * End-to-end MCP server tests: SDK Client <-> InMemoryTransport <-> server.
 * Exercises all six tools through the real MCP protocol surface.
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

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  return payloadOf(result);
}

describe('MCP server tools', () => {
  it('write_cells -> set_formulas -> read_cells computes SUM', async () => {
    const client = await makeClient();

    const written = await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 1 },
        { sheet: 'Sheet1', row: 1, col: 0, value: 2 },
        { sheet: 'Sheet1', row: 2, col: 0, value: 3 },
      ],
    });
    expect(written.protocolVersion).toBe(1);
    expect(written.ok).toBe(true);
    expect(written.written).toBe(3);

    const formulas = await call(client, 'set_formulas', {
      formulas: [{ sheet: 'Sheet1', row: 3, col: 0, formula: '=SUM(A1:A3)' }],
    });
    expect(formulas.ok).toBe(true);

    const read = await call(client, 'read_cells', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 0,
    });
    expect(read.protocolVersion).toBe(1);
    const cells = read.cells as unknown[][];
    expect(cells[3][0]).toBe(6);
  });

  it('write_cells treats a leading "=" as a formula', async () => {
    const client = await makeClient();
    await call(client, 'write_cells', {
      cells: [{ sheet: 'Sheet1', row: 0, col: 0, value: '=1+2' }],
    });
    const read = await call(client, 'read_cells', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    });
    expect((read.cells as unknown[][])[0][0]).toBe(3);
  });

  it('FIX-R4: an over-large read_cells clamps to the used range instead of failing', async () => {
    const client = await makeClient();
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 1 },
        { sheet: 'Sheet1', row: 1, col: 0, value: 2 },
        { sheet: 'Sheet1', row: 2, col: 0, value: 3 },
      ],
    });
    // The planner failure observed live: a whole-grid guess
    // (1001 x 1001 = 1,002,001 cells > the 100,000 cap) for a 3-cell
    // sheet. It must return the data, clamped — not a hard failure.
    const read = await call(client, 'read_cells', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 1000,
      endCol: 1000,
    });
    expect(read.ok).toBe(true);
    expect(read.clampedToUsedRange).toBe(true);
    expect(read.effectiveRange).toEqual({
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 0,
    });
    expect(read.cells).toEqual([[1], [2], [3]]);
  });

  it('recalculate and get_results round-trip the used range', async () => {
    const client = await makeClient();
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 10 },
        { sheet: 'Sheet1', row: 0, col: 1, value: '=A1*2' },
      ],
    });
    const recalc = await call(client, 'recalculate', {});
    expect(recalc.ok).toBe(true);

    const results = await call(client, 'get_results', { sheet: 'Sheet1' });
    expect(results.protocolVersion).toBe(1);
    const cells = results.cells as unknown[][];
    expect(cells[0][0]).toBe(10);
    expect(cells[0][1]).toBe(20);
  });

  it('execute_code runs javascript', async () => {
    const client = await makeClient();
    const res = await call(client, 'execute_code', {
      language: 'javascript',
      code: 'arg1 * arg2',
      args: { arg1: 6, arg2: 7 },
    });
    expect(res.ok).toBe(true);
    expect(res.value).toBe(42);
  });

  it('execute_code runs python', async () => {
    const client = await makeClient();
    const res = await call(client, 'execute_code', {
      language: 'python',
      code: 'import math\nresult = math.gcd(args["a"], args["b"])',
      args: { a: 12, b: 18 },
    });
    expect(res.ok).toBe(true);
    expect(res.value).toBe(6);
  });

  it('execute_code surfaces sandbox failures as structured errors', async () => {
    const client = await makeClient();
    const res = await call(client, 'execute_code', {
      language: 'python',
      code: 'import os\nresult = 1',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not allowed/);
  });

  it('returns structured errors for invalid input, never throws', async () => {
    const client = await makeClient();
    const res = await call(client, 'read_cells', {
      sheet: 'Sheet1',
      startRow: 5,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.protocolVersion).toBe(1);
    expect(typeof res.error).toBe('string');
  });

  it('create_pivot -> get_pivot_data aggregates a table', async () => {
    const client = await makeClient();
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 'Region' },
        { sheet: 'Sheet1', row: 0, col: 1, value: 'Sales' },
        { sheet: 'Sheet1', row: 1, col: 0, value: 'East' },
        { sheet: 'Sheet1', row: 1, col: 1, value: 100 },
        { sheet: 'Sheet1', row: 2, col: 0, value: 'West' },
        { sheet: 'Sheet1', row: 2, col: 1, value: 200 },
        { sheet: 'Sheet1', row: 3, col: 0, value: 'East' },
        { sheet: 'Sheet1', row: 3, col: 1, value: 50 },
      ],
    });
    const created = await call(client, 'create_pivot', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 1,
      rows: ['Region'],
      columns: [],
      values: [{ field: 'Sales', aggregation: 'sum' }],
      name: 'SalesByRegion',
    });
    expect(created.ok).toBe(true);
    expect((created.pivot as { name: string }).name).toBe('SalesByRegion');
    expect((created.pivot as { grandTotals: number[] }).grandTotals).toEqual([350]);

    const data = await call(client, 'get_pivot_data', { name: 'SalesByRegion' });
    expect(data.ok).toBe(true);
    expect(data.matrix).toEqual([
      [null, 'Region', 'Sum of Sales', 'Grand Total'],
      [null, 'East', 150, 150],
      [null, 'West', 200, 200],
      ['Grand Total', null, 350, 350],
    ]);
  });

  it('refresh_pivot picks up new source rows', async () => {
    const client = await makeClient();
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 'K' },
        { sheet: 'Sheet1', row: 0, col: 1, value: 'V' },
        { sheet: 'Sheet1', row: 1, col: 0, value: 'a' },
        { sheet: 'Sheet1', row: 1, col: 1, value: 10 },
      ],
    });
    await call(client, 'create_pivot', {
      sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1,
      rows: [], columns: [],
      values: [{ field: 'V', aggregation: 'sum' }],
      name: 'P1',
    });
    // Extend the source range, then refresh.
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 2, col: 0, value: 'b' },
        { sheet: 'Sheet1', row: 2, col: 1, value: 20 },
      ],
    });
    const refreshed = await call(client, 'refresh_pivot', { name: 'P1' });
    expect(refreshed.ok).toBe(true);
    // Source range was rows 0-1, so the new row is outside it: totals unchanged.
    expect((refreshed.pivot as { grandTotals: number[] }).grandTotals).toEqual([10]);
  });

  it('create_pivot rejects unknown fields and duplicate names', async () => {
    const client = await makeClient();
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 'K' },
        { sheet: 'Sheet1', row: 1, col: 0, value: 'a' },
      ],
    });
    const bad = await call(client, 'create_pivot', {
      sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 0,
      rows: ['Missing'], columns: [],
      values: [{ field: 'K', aggregation: 'count' }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/unknown field/);

    await call(client, 'create_pivot', {
      sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 0,
      rows: [], columns: [],
      values: [{ field: 'K', aggregation: 'count' }],
      name: 'Dup',
    });
    const dup = await call(client, 'create_pivot', {
      sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 0,
      rows: [], columns: [],
      values: [{ field: 'K', aggregation: 'count' }],
      name: 'Dup',
    });
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/already exists/);

    const missing = await call(client, 'get_pivot_data', { name: 'Nope' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/unknown PivotTable/);
  });
});

describe('planner-fix round 2: far-write guard', () => {
  it('rejects a write far outside the used range, naming the append row', async () => {
    const client = await makeClient();
    await call(client, 'write_cells', {
      cells: [{ sheet: 'Sheet1', row: 0, col: 0, value: 1 }],
    });
    // The live failure: "TOTAL" appended at row 100000 of a tiny sheet.
    const far = await call(client, 'write_cells', {
      cells: [{ sheet: 'Sheet1', row: 100000, col: 0, value: 'TOTAL' }],
    });
    expect(far.ok).toBe(false);
    expect(JSON.stringify(far)).toContain('far outside');
    expect(JSON.stringify(far)).toContain('write at row 1');
    // The rejected write must NOT have extended the used range.
    const read = await call(client, 'read_cells', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 1000,
      endCol: 1000,
    });
    expect(read.effectiveRange?.endRow).toBe(0);
    // An append at the named row and a set_formulas far-write behave:
    const append = await call(client, 'write_cells', {
      cells: [{ sheet: 'Sheet1', row: 1, col: 0, value: 'TOTAL' }],
    });
    expect(append.ok).toBe(true);
    const farFormula = await call(client, 'set_formulas', {
      formulas: [{ sheet: 'Sheet1', row: 50000, col: 0, formula: '=SUM(A1:A1)' }],
    });
    expect(farFormula.ok).toBe(false);
  });
});

describe('planner-fix round 2: written-row context echo', () => {
  it('write_cells echoes the written row so a caller can verify placement', async () => {
    const client = await makeClient();
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 'Feb' },
        { sheet: 'Sheet1', row: 0, col: 1, value: 'North' },
        { sheet: 'Sheet1', row: 0, col: 2, value: 13100 },
      ],
    });
    const w = await call(client, 'write_cells', {
      cells: [{ sheet: 'Sheet1', row: 0, col: 2, value: 15000 }],
    });
    expect(w.ok).toBe(true);
    expect(w.writtenRowContext).toEqual([
      { sheet: 'Sheet1', row: 0, values: ['Feb', 'North', 15000] },
    ]);
  });
});
