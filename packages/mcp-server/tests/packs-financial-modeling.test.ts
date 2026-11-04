/**
 * Financial-modeling pack end-to-end tests: real MCP protocol,
 * tools only. The forecast/valuation assertions read values back
 * from the sheet, and the forecast test proves the model is LIVE
 * (changing a source value moves the forecast) — the pack writes
 * formulas, not frozen numbers.
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
  return JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function makeClient(host?: EngineHost): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host);
  await server.connect(serverTransport);
  const client = new Client({ name: 'fin-test-client', version: '0.0.0' });
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
  const res = await call(client, 'write_cells', { cells });
  expect(res.ok).toBe(true);
}

async function readCell(
  client: Client,
  sheet: string,
  row: number,
  col: number,
): Promise<unknown> {
  const res = await call(client, 'read_cells', {
    sheet,
    startRow: row,
    startCol: col,
    endRow: row,
    endCol: col,
  });
  return (res.cells as unknown[][])[0]?.[0];
}

describe('financial-modeling pack', () => {
  it('fin_forecast writes a LIVE linear model', async () => {
    const host = new EngineHost();
    await host.execute({ cmd: 'addSheet', name: 'Model' });
    const client = await makeClient(host);
    await seedTable(client, 'Model', [
      ['Period', 'Revenue'],
      [1, 100],
      [2, 110],
      [3, 120],
      [4, 130],
      [5, 140],
    ]);

    const res = await call(client, 'fin_forecast', {
      sheet: 'Model',
      valueColumn: 'Revenue',
      periodColumn: 'Period',
      periods: 3,
    });
    expect(res.ok).toBe(true);
    const forecast = res.forecast as { period: number; value: number }[];
    expect(forecast.map((f) => f.period)).toEqual([6, 7, 8]);
    expect(forecast[0]?.value).toBeCloseTo(150, 6);
    expect(forecast[1]?.value).toBeCloseTo(160, 6);
    expect(forecast[2]?.value).toBeCloseTo(170, 6);
    expect(res.slope).toBeCloseTo(10, 9);
    expect(res.intercept).toBeCloseTo(90, 9);

    // Liveness: change the first revenue 100 -> 200 and the forecast
    // (a SLOPE/INTERCEPT formula over the range) must move with it.
    await call(client, 'write_cells', {
      cells: [{ sheet: 'Model', row: 1, col: 1, value: 200 }],
    });
    // New least squares: slope -10, intercept 170 -> x=6 gives 110.
    expect(await readCell(client, 'Model', 6, 1)).toBeCloseTo(110, 6);
    expect(await readCell(client, 'Model', 6, 0)).toBe(6);
  });

  it('fin_forecast growth method compounds at the CAGR', async () => {
    const host = new EngineHost();
    await host.execute({ cmd: 'addSheet', name: 'Growth' });
    const client = await makeClient(host);
    await seedTable(client, 'Growth', [
      ['Year', 'Sales'],
      [2024, 100],
      [2025, 110],
      [2026, 121],
    ]);
    const res = await call(client, 'fin_forecast', {
      sheet: 'Growth',
      valueColumn: 'Sales',
      periodColumn: 'Year',
      periods: 2,
      method: 'growth',
    });
    expect(res.ok).toBe(true);
    expect(res.cagr).toBeCloseTo(0.1, 9);
    const forecast = res.forecast as { period: number; value: number }[];
    expect(forecast[0]?.period).toBe(2027);
    expect(forecast[0]?.value).toBeCloseTo(133.1, 6);
    expect(forecast[1]?.value).toBeCloseTo(146.41, 6);
  });

  it('fin_npv_irr values a cash-flow column with live formulas', async () => {
    const host = new EngineHost();
    await host.execute({ cmd: 'addSheet', name: 'Project' });
    const client = await makeClient(host);
    await seedTable(client, 'Project', [
      ['Period', 'CashFlow'],
      [1, 400],
      [2, 500],
      [3, 600],
    ]);

    const res = await call(client, 'fin_npv_irr', {
      sheet: 'Project',
      cashflowColumn: 'CashFlow',
      rate: 0.1,
      initialInvestment: 1000,
    });
    expect(res.ok).toBe(true);
    const expectedNpv = 400 / 1.1 + 500 / 1.1 ** 2 + 600 / 1.1 ** 3 - 1000;
    expect(res.npv).toBeCloseTo(expectedNpv, 4);

    // IRR expectation by bisection on the NPV function.
    const npvAt = (r: number) =>
      -1000 + 400 / (1 + r) + 500 / (1 + r) ** 2 + 600 / (1 + r) ** 3;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (npvAt(mid) > 0) lo = mid;
      else hi = mid;
    }
    expect(res.irr).not.toBeNull();
    expect(Math.abs((res.irr as number) - (lo + hi) / 2)).toBeLessThan(0.002);

    // The valuation sheet holds the computed values in formula cells.
    expect(await readCell(client, 'Valuation', 4, 1)).toBeCloseTo(expectedNpv, 4);
  });

  it('fin_scenario_sweep drives the sheet formulas and restores the input', async () => {
    const host = new EngineHost();
    await host.execute({ cmd: 'addSheet', name: 'Pricing' });
    const client = await makeClient(host);
    await seedTable(client, 'Pricing', [
      ['Input', 'Value'],
      ['Price', 10],
      ['Units', 100],
    ]);
    await call(client, 'set_formulas', {
      formulas: [{ sheet: 'Pricing', row: 4, col: 1, formula: '=B2*B3' }],
    });
    expect(await readCell(client, 'Pricing', 4, 1)).toBe(1000);

    const res = await call(client, 'fin_scenario_sweep', {
      sheet: 'Pricing',
      inputCell: 'B2',
      values: [8, 10, 12],
      outputCell: 'B5',
    });
    expect(res.ok).toBe(true);
    const results = res.results as { input: number; output: number }[];
    expect(results).toEqual([
      { input: 8, output: 800 },
      { input: 10, output: 1000 },
      { input: 12, output: 1200 },
    ]);
    expect(res.restoredOriginal).toBe(10);
    expect(await readCell(client, 'Pricing', 1, 1)).toBe(10);

    const table = await call(client, 'get_results', { sheet: 'Scenarios' });
    expect(table.cells).toEqual([
      ['B2', 'B5'],
      [8, 800],
      [10, 1000],
      [12, 1200],
    ]);
  });
});
