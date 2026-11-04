/**
 * MCP round-trip tests for the data-analysis pipeline tools:
 * analyze_data / rerun_analysis / list_analyses, plus the AnalysisPort
 * registration for the chat intent router.
 *
 * These run the REAL sandboxed Python (mcp-server sandbox) end to end:
 * write_cells -> analyze_data -> deterministic sandboxed execution ->
 * { analysis, chartSpec } -> artifact persisted -> rerun_analysis.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import {
  dispatchIntent,
  getIntentPorts,
  routePrompt,
} from '@icecream-sheets/service';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
  expect(res.content[0]!.type).toBe('text');
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
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

const GRID_CELLS = [
  { sheet: 'Sheet1', row: 0, col: 0, value: 'Region' },
  { sheet: 'Sheet1', row: 0, col: 1, value: 'Sales' },
  { sheet: 'Sheet1', row: 0, col: 2, value: 'Units' },
  { sheet: 'Sheet1', row: 1, col: 0, value: 'North' },
  { sheet: 'Sheet1', row: 1, col: 1, value: 100 },
  { sheet: 'Sheet1', row: 1, col: 2, value: 5 },
  { sheet: 'Sheet1', row: 2, col: 0, value: 'South' },
  { sheet: 'Sheet1', row: 2, col: 1, value: 200 },
  { sheet: 'Sheet1', row: 2, col: 2, value: 8 },
  { sheet: 'Sheet1', row: 3, col: 0, value: 'North' },
  { sheet: 'Sheet1', row: 3, col: 1, value: 150 },
  { sheet: 'Sheet1', row: 3, col: 2, value: 6 },
  { sheet: 'Sheet1', row: 4, col: 0, value: 'South' },
  { sheet: 'Sheet1', row: 4, col: 1, value: 250 },
  { sheet: 'Sheet1', row: 4, col: 2, value: 9 },
];

async function seedClient(): Promise<Client> {
  const client = await makeClient();
  const written = await call(client, 'write_cells', { cells: GRID_CELLS });
  expect(written.ok).toBe(true);
  return client;
}

describe('analyze_data', () => {
  it('runs the full pipeline: schema -> plan -> generated Python -> sandbox -> chartSpec', async () => {
    const client = await seedClient();
    const res = await call(client, 'analyze_data', {
      intent: 'pivot sales by region and show a bar chart',
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 4,
      endCol: 2,
    });
    expect(res.ok).toBe(true);
    expect(res.intentKind).toBe('aggregate');
    expect(res.rangeRef).toBe('Sheet1!A1:C5');
    expect(res.artifactId).toMatch(/^analysis_\d+$/);

    const analysis = res.analysis as Record<string, unknown>;
    expect(analysis.groupBy).toBe('Region');
    expect(analysis.measure).toBe('Sales');
    expect(analysis.groups).toEqual({ North: 250, South: 450 });
    expect(analysis.grandTotal).toBe(700);
    expect(typeof res.summary).toBe('string');
    expect(res.summary as string).toContain('North');

    // The sandboxed script produced a valid Chart.js visual spec.
    const chartSpec = res.chartSpec as Record<string, unknown>;
    expect(chartSpec.type).toBe('bar');
    expect(chartSpec.labels).toEqual(['North', 'South']);
    const datasets = chartSpec.datasets as { label: string; data: number[] }[];
    expect(datasets).toHaveLength(1);
    expect(datasets[0]!.data).toEqual([250, 450]);
  }, 30000);

  it('a data-only range aggregates EVERY row (header-contract regression: 159,400)', async () => {
    // The exact live defect (gate-fix proof, agent-rerun
    // cases/planner-diag/results-gatefix.json): the planner passed
    // analyze_data the W3a Sales fixture's Revenue column as a DATA-ONLY
    // range (sheet rows 1-12, header row 0 excluded) and the pipeline
    // consumed the first data row as a header, aggregating 11 of 12
    // values (147,400 instead of 159,400).
    const client = await makeClient();
    const cells: Record<string, unknown>[] = [
      { sheet: 'Sheet1', row: 0, col: 0, value: 'Month' },
      { sheet: 'Sheet1', row: 0, col: 1, value: 'Region' },
      { sheet: 'Sheet1', row: 0, col: 2, value: 'Revenue' },
    ];
    const rows: [string, string, number][] = [
      ['Jan', 'North', 12000], ['Jan', 'South', 9800],
      ['Feb', 'North', 13500], ['Feb', 'South', 11200],
      ['Mar', 'North', 15800], ['Mar', 'South', 12600],
      ['Apr', 'North', 14200], ['Apr', 'South', 10900],
      ['May', 'North', 16900], ['May', 'South', 11600],
      ['Jun', 'North', 16700], ['Jun', 'South', 14200],
    ];
    rows.forEach(([m, r, v], i) => {
      cells.push(
        { sheet: 'Sheet1', row: i + 1, col: 0, value: m },
        { sheet: 'Sheet1', row: i + 1, col: 1, value: r },
        { sheet: 'Sheet1', row: i + 1, col: 2, value: v },
      );
    });
    const written = await call(client, 'write_cells', { cells });
    expect(written.ok).toBe(true);

    const res = await call(client, 'analyze_data', {
      intent: 'sum of Revenue',
      sheet: 'Sheet1',
      startRow: 1,
      startCol: 2,
      endRow: 12,
      endCol: 2,
    });
    expect(res.ok).toBe(true);
    expect(res.rangeRef).toBe('Sheet1!C2:C13');
    const analysis = res.analysis as {
      rowCount: number;
      columns: Record<string, { count: number; mean: number }>;
    };
    expect(analysis.rowCount).toBe(12);
    const col = Object.values(analysis.columns)[0]!;
    expect(col.count).toBe(12);
    expect(Math.round(col.count * col.mean)).toBe(159400);

    // The stored artifact's rerun reproduces the same full-range input.
    const rerun = await call(client, 'rerun_analysis', { artifactId: res.artifactId as string });
    expect(rerun.ok).toBe(true);
    expect(rerun.inputChanged).toBe(false);
    expect(JSON.stringify(rerun.analysis)).toBe(JSON.stringify(res.analysis));
  }, 30000);

  it('headerRow:true on the same data-only range consumes its first row (declaration honored)', async () => {
    const client = await makeClient();
    const cells: Record<string, unknown>[] = [
      { sheet: 'Sheet1', row: 0, col: 0, value: 'Month' },
      { sheet: 'Sheet1', row: 0, col: 1, value: 'Region' },
      { sheet: 'Sheet1', row: 0, col: 2, value: 'Revenue' },
    ];
    const revenues = [12000, 9800, 13500, 11200, 15800, 12600, 14200, 10900, 16900, 11600, 16700, 14200];
    revenues.forEach((v, i) => {
      cells.push({ sheet: 'Sheet1', row: i + 1, col: 2, value: v });
    });
    const written = await call(client, 'write_cells', { cells });
    expect(written.ok).toBe(true);

    const res = await call(client, 'analyze_data', {
      intent: 'sum of Revenue',
      sheet: 'Sheet1',
      startRow: 1,
      startCol: 2,
      endRow: 12,
      endCol: 2,
      headerRow: true,
    });
    expect(res.ok).toBe(true);
    const analysis = res.analysis as {
      rowCount: number;
      columns: Record<string, { count: number; mean: number }>;
    };
    expect(analysis.rowCount).toBe(11);
    const col = Object.values(analysis.columns)[0]!;
    expect(col.count).toBe(11);
    expect(Math.round(col.count * col.mean)).toBe(147400);
  }, 30000);

  it('defaults to the first sheet used range when no range is given', async () => {
    const client = await seedClient();
    const res = await call(client, 'analyze_data', {
      intent: 'summarize the sales data',
    });
    expect(res.ok).toBe(true);
    expect(res.rangeRef).toBe('Sheet1!A1:C5');
    expect(res.intentKind).toBe('summarize');
  }, 30000);

  it('rejects partial bounds and empty sheets', async () => {
    const client = await seedClient();
    const partial = await call(client, 'analyze_data', {
      intent: 'analyze',
      sheet: 'Sheet1',
      startRow: 0,
    });
    expect(partial.ok).toBe(false);

    const empty = await call(client, 'analyze_data', {
      intent: 'analyze',
      sheet: 'Nope',
    });
    expect(empty.ok).toBe(false);
  });

  it('trend intent produces a forecast chart with two datasets', async () => {
    const client = await seedClient();
    const res = await call(client, 'analyze_data', {
      intent: 'forecast sales trend next quarter',
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 4,
      endCol: 2,
    });
    expect(res.ok).toBe(true);
    expect(res.intentKind).toBe('trend');
    const chartSpec = res.chartSpec as { type: string; datasets: { label: string }[] };
    expect(chartSpec.type).toBe('line');
    expect(chartSpec.datasets.map((d) => d.label)).toEqual(['Sales', 'forecast']);
    const analysis = res.analysis as { forecast: number[] };
    expect(analysis.forecast).toHaveLength(3);
  }, 30000);
});

describe('rerun_analysis', () => {
  it('re-executes deterministically and reports no input change', async () => {
    const client = await seedClient();
    const first = await call(client, 'analyze_data', {
      intent: 'pivot sales by region',
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 4,
      endCol: 2,
    });
    const artifactId = first.artifactId as string;

    const rerun = await call(client, 'rerun_analysis', { artifactId });
    expect(rerun.ok).toBe(true);
    expect(rerun.artifactId).toBe(artifactId);
    expect(rerun.inputChanged).toBe(false);
    // Same script + same data = same result.
    expect(JSON.stringify(rerun.analysis)).toBe(JSON.stringify(first.analysis));
    expect(JSON.stringify(rerun.chartSpec)).toBe(JSON.stringify(first.chartSpec));
  }, 30000);

  it('detects input drift when the data changed', async () => {
    const client = await seedClient();
    const first = await call(client, 'analyze_data', {
      intent: 'pivot sales by region',
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 4,
      endCol: 2,
    });
    await call(client, 'write_cells', {
      cells: [{ sheet: 'Sheet1', row: 1, col: 1, value: 1000 }],
    });
    const rerun = await call(client, 'rerun_analysis', { artifactId: first.artifactId });
    expect(rerun.ok).toBe(true);
    expect(rerun.inputChanged).toBe(true);
    const analysis = rerun.analysis as { groups: Record<string, number> };
    expect(analysis.groups.North).toBe(1150);
  }, 30000);

  it('errors on unknown artifact ids', async () => {
    const client = await seedClient();
    const res = await call(client, 'rerun_analysis', { artifactId: 'analysis_999' });
    expect(res.ok).toBe(false);
  });
});

describe('list_analyses', () => {
  it('lists stored artifacts newest-first without the script source', async () => {
    const client = await seedClient();
    const first = await call(client, 'analyze_data', {
      intent: 'pivot sales by region',
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 4,
      endCol: 2,
    });
    const listed = await call(client, 'list_analyses', {});
    expect(listed.ok).toBe(true);
    const analyses = listed.analyses as Record<string, unknown>[];
    expect(analyses.length).toBeGreaterThanOrEqual(1);
    const entry = analyses[0]!;
    expect(entry.id).toBe(first.artifactId);
    expect(entry.intentKind).toBe('aggregate');
    expect('pythonSource' in entry).toBe(false);
  }, 30000);
});

describe('analyze_data on a horizontal year layout', () => {
  it('groups revenue by the year ROW, not by a column (Income-sheet shape)', async () => {
    // Mirror of the real Income sheet block: 'Year' label above the run's
    // start, years 2012-2021 across one row, one measure per row below.
    const client = await makeClient();
    const years = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021];
    const revenue = [
      102007, 118086, 131345, 142341, 150772, 158310.6, 165434.577,
      172051.96008, 178073.77868279998, 183415.99204328397,
    ];
    const cells: Record<string, unknown>[] = [
      { sheet: 'Income', row: 0, col: 0, value: 'Income Statement' },
      { sheet: 'Income', row: 1, col: 1, value: 'Year' },
      { sheet: 'Income', row: 2, col: 0, value: 'Income Statement' },
    ];
    years.forEach((y, i) => {
      cells.push({ sheet: 'Income', row: 2, col: 1 + i, value: y });
      cells.push({ sheet: 'Income', row: 3, col: 1 + i, value: revenue[i] });
    });
    cells.push({ sheet: 'Income', row: 3, col: 0, value: 'Revenue' });
    const written = await call(client, 'write_cells', { cells });
    expect(written.ok).toBe(true);

    const res = await call(client, 'analyze_data', {
      intent: 'Create a small chart of revenue by year from the Income sheet, using the real numbers from the file.',
      sheet: 'Income',
    });
    expect(res.ok).toBe(true);
    expect(res.intentKind).toBe('aggregate');
    // The source range is preserved (rerun reads the same cells).
    expect(res.rangeRef).toBe('Income!A1:K4');
    const analysis = res.analysis as Record<string, unknown>;
    expect(analysis.groupBy).toBe('Year');
    expect(analysis.measure).toBe('Revenue');
    expect(analysis.groupCount).toBe(10);
    const groups = analysis.groups as Record<string, number>;
    years.forEach((y, i) => expect(groups[String(y)]).toBeCloseTo(revenue[i]!, 6));
    expect(analysis.grandTotal).toBeCloseTo(1501837.907806084, 6);

    const chartSpec = res.chartSpec as Record<string, unknown>;
    expect(chartSpec.type).toBe('bar');
    expect(chartSpec.labels).toEqual(years.map(String));
    const datasets = chartSpec.datasets as { label: string; data: number[] }[];
    expect(datasets).toHaveLength(1);
    expect(datasets[0]!.label).toBe('Revenue');
    datasets[0]!.data.forEach((v, i) => expect(v).toBeCloseTo(revenue[i]!, 6));

    // Rerun re-derives the same transposition: identical analysis, no drift.
    const rerun = await call(client, 'rerun_analysis', { artifactId: res.artifactId as string });
    expect(rerun.ok).toBe(true);
    expect(rerun.inputChanged).toBe(false);
    expect(JSON.stringify(rerun.analysis)).toBe(JSON.stringify(res.analysis));
  }, 30000);

  it('groups revenue by the year ROW when the range starts AT the years row (#152 remaining scope)', async () => {
    // Round-4 leg A shape: the agent's analyze_data call used bounds
    // starting at the years row (row 2 here, row 5 in the real file),
    // so the 'Year' label row above is OUTSIDE the range and the
    // transposed dimension falls back to 'Category'. Pre-fix this
    // failed with 'group-by needs a category column': the dimension
    // column holds year strings, which infer as NUMERIC (numeric
    // strings count as numbers), leaving zero categorical columns,
    // and the exact-hint fallback cannot match 'Category' to 'year'.
    // The dimension is categorical by construction (labels, not
    // measures), so the pipeline must force it — the group must
    // resolve via the category pool, not via a name coincidence.
    const client = await makeClient();
    const years = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021];
    const revenue = [
      102007, 118086, 131345, 142341, 150772, 158310.6, 165434.577,
      172051.96008, 178073.77868279998, 183415.99204328397,
    ];
    const cells: Record<string, unknown>[] = [
      { sheet: 'Income', row: 0, col: 0, value: 'Income Statement' },
      { sheet: 'Income', row: 1, col: 1, value: 'Year' },
      { sheet: 'Income', row: 2, col: 0, value: 'Income Statement' },
    ];
    years.forEach((y, i) => {
      cells.push({ sheet: 'Income', row: 2, col: 1 + i, value: y });
      cells.push({ sheet: 'Income', row: 3, col: 1 + i, value: revenue[i] });
    });
    cells.push({ sheet: 'Income', row: 3, col: 0, value: 'Revenue' });
    const written = await call(client, 'write_cells', { cells });
    expect(written.ok).toBe(true);

    // Bounds start AT the years row: the 'Year' label row is excluded.
    const res = await call(client, 'analyze_data', {
      intent: 'Create a small chart of revenue by year from the Income sheet, using the real numbers from the file.',
      sheet: 'Income',
      startRow: 2,
      startCol: 0,
      endRow: 3,
      endCol: 10,
    });
    expect(res.ok).toBe(true);
    expect(res.intentKind).toBe('aggregate');
    const analysis = res.analysis as Record<string, unknown>;
    // 'Category', not 'Year': the dimension name fallback is pinned
    // behavior, and the group must resolve WITHOUT a name match.
    expect(analysis.groupBy).toBe('Category');
    expect(analysis.measure).toBe('Revenue');
    expect(analysis.groupCount).toBe(10);
    const groups = analysis.groups as Record<string, number>;
    years.forEach((y, i) => expect(groups[String(y)]).toBeCloseTo(revenue[i]!, 6));
    expect(analysis.grandTotal).toBeCloseTo(1501837.907806084, 6);

    const chartSpec = res.chartSpec as Record<string, unknown>;
    expect(chartSpec.type).toBe('bar');
    expect(chartSpec.labels).toEqual(years.map(String));
    const datasets = chartSpec.datasets as { label: string; data: number[] }[];
    expect(datasets).toHaveLength(1);
    expect(datasets[0]!.label).toBe('Revenue');
    datasets[0]!.data.forEach((v, i) => expect(v).toBeCloseTo(revenue[i]!, 6));
  }, 30000);
});

describe('AnalysisPort registration (chat intent router seam)', () => {
  it('createServer registers the analysis port', async () => {
    await seedClient();
    expect(getIntentPorts().analysis).toBeDefined();
  });

  it('dispatchIntent analysis route runs the pipeline via the port', async () => {
    await seedClient();
    const route = routePrompt('pivot sales by region and show a chart', {
      range: 'Sheet1!A1:C5',
    });
    expect(route.route).toBe('analysis');
    const ports = {
      analysis: getIntentPorts().analysis!,
      conversation: async (prompt: string) => `conv: ${prompt}`,
    };
    const result = await dispatchIntent(route, ports, 'pivot sales by region and show a chart');
    expect(result.route).toBe('analysis');
    if (result.route === 'analysis') {
      expect(result.result.analysis).toContain('Sales');
      expect(result.result.analysis).toContain('Region');
      expect(result.result.chartSpec.type).toBe('bar');
      expect(result.result.chartSpec.data).toBeDefined();
      // Pipeline separation: analysis results never carry React fields.
      expect('reactSource' in result.result).toBe(false);
    }
  }, 30000);
});
