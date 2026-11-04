/**
 * FIX-G — the create_chart MCP tool (trace §4.1a): builds a ChartSpec
 * from an A1 range read through the bound host and delivers it via the
 * ServerOptions.charts sink; FAILS CLOSED with an honest error when no
 * sink is wired (this server owns no workbook session).
 */
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EngineHost } from '@icecream-sheets/engine';
import type { ChartSpec } from '@icecream-sheets/service';
import { createServer, type ChartSink } from '../src/server.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

async function makeClient(options?: Parameters<typeof createServer>[1]): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(undefined, options);
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
  return payloadOf(await client.callTool({ name, arguments: args }));
}

async function seedData(client: Client): Promise<void> {
  const written = await call(client, 'write_cells', {
    cells: [
      { sheet: 'Sheet1', row: 0, col: 0, value: 'Quarter' },
      { sheet: 'Sheet1', row: 0, col: 1, value: 'Sales' },
      { sheet: 'Sheet1', row: 1, col: 0, value: 'Q1' },
      { sheet: 'Sheet1', row: 1, col: 1, value: 10 },
      { sheet: 'Sheet1', row: 2, col: 0, value: 'Q2' },
      { sheet: 'Sheet1', row: 2, col: 1, value: 20 },
      { sheet: 'Sheet1', row: 3, col: 0, value: 'Q3' },
      { sheet: 'Sheet1', row: 3, col: 1, value: 30 },
    ],
  });
  expect(written.ok).toBe(true);
}

describe('create_chart tool (FIX-G)', () => {
  it('is registered in the tool list', async () => {
    const client = await makeClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('create_chart');
  });

  it('fails closed with an honest error when no chart sink is wired', async () => {
    const client = await makeClient();
    await seedData(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      range: 'A1:B4',
      kind: 'column',
      title: 'Sales',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('chart creation is not available in this session');
  });

  it('builds a native ChartSpec from the range and delivers it to the sink', async () => {
    const captured: Array<{ spec: ChartSpec; principal: string }> = [];
    const sink: ChartSink = {
      async addChart(spec, principal) {
        captured.push({ spec, principal });
        return { id: spec.id, revision: 7 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedData(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      range: 'A1:B4',
      kind: 'column',
      title: 'Sales by Quarter',
    });
    expect(out.ok).toBe(true);
    expect(out.revision).toBe(7);
    expect(out.kind).toBe('column-clustered');
    expect(out.title).toBe('Sales by Quarter');
    expect(captured).toHaveLength(1);
    const spec = captured[0]!.spec;
    expect(spec.nativePart).toBe(true);
    expect(spec.range).toEqual({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 3, endCol: 1 });
    expect(spec.seriesRanges).toEqual([
      {
        name: 'Sales',
        cat: { sheet: 'Sheet1', startRow: 1, startCol: 0, endRow: 3, endCol: 0 },
        val: { sheet: 'Sheet1', startRow: 1, startCol: 1, endRow: 3, endCol: 1 },
      },
    ]);
    // Default anchor: below the data, fixed 8 cols × 15 rows.
    expect(spec.anchorCells).toEqual({ fromCol: 0, fromRow: 5, toCol: 8, toRow: 20 });
    expect(captured[0]!.principal).toBe('mcp-client');
  });

  it('honors an explicit anchor cell and kind mapping (bar → bar-clustered)', async () => {
    const captured: ChartSpec[] = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push(spec);
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedData(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      range: 'A1:B4',
      kind: 'bar',
      anchor: 'E2',
    });
    expect(out.ok).toBe(true);
    expect(captured[0]!.kind).toBe('bar-clustered');
    expect(captured[0]!.anchorCells).toEqual({ fromCol: 4, fromRow: 1, toCol: 12, toRow: 16 });
  });

  it('refuses a range with no numeric data column (sink never called)', async () => {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 'Name' },
        { sheet: 'Sheet1', row: 0, col: 1, value: 'City' },
        { sheet: 'Sheet1', row: 1, col: 0, value: 'Ann' },
        { sheet: 'Sheet1', row: 1, col: 1, value: 'Oslo' },
      ],
    });
    const out = await call(client, 'create_chart', { sheet: 'Sheet1', range: 'A1:B2', kind: 'pie' });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('no numeric data column');
    expect(calls).toBe(0);
  });

  it('refuses an unknown sheet', async () => {
    const sink: ChartSink = { async addChart() { return { id: 1, revision: 1 }; } };
    const client = await makeClient({ charts: sink });
    const out = await call(client, 'create_chart', { sheet: 'Nope', range: 'A1:B2', kind: 'line' });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('unknown sheet');
  });
});

// ---------------------------------------------------------------------------
// Horizontal layouts (follow-up 2026-10-26): a range whose first row
// holds a year sequence with measure rows below must chart with the
// year cells as categories and one series per measure row — not refuse,
// and never as one series per year-column (the #157 years-as-values
// mode). Ground truth: Revenue row 7 (1-based) = 0-based row 6.
// ---------------------------------------------------------------------------

const H_REVENUE = [
  102007, 118086, 131345, 142341, 150772, 158310.6, 165434.577, 172051.96008,
  178073.77868279998, 183415.99204328397,
];

async function seedHorizontal(client: Client): Promise<void> {
  const cells: { sheet: string; row: number; col: number; value: string | number }[] = [];
  for (let i = 0; i < 10; i++) {
    cells.push({ sheet: 'Income', row: 5, col: 1 + i, value: 2012 + i });
    cells.push({ sheet: 'Income', row: 6, col: 1 + i, value: H_REVENUE[i] });
    cells.push({ sheet: 'Income', row: 8, col: 1 + i, value: 60000 + i * 1000 });
  }
  cells.push({ sheet: 'Income', row: 6, col: 0, value: 'Revenue' });
  cells.push({ sheet: 'Income', row: 8, col: 0, value: 'Gross Profit' });
  const written = await call(client, 'write_cells', { cells });
  expect(written.ok).toBe(true);
}

async function readRowValues(
  client: Client,
  sheet: string,
  row: number,
  startCol: number,
  endCol: number,
): Promise<unknown[]> {
  const out = await call(client, 'read_cells', {
    sheet,
    startRow: row,
    startCol,
    endRow: row,
    endCol,
  });
  expect(out.ok).toBe(true);
  const cells = out.cells as unknown[][];
  return cells[0]!;
}

describe('create_chart on horizontal layouts', () => {
  it('charts years-as-categories with one Revenue series (values exact)', async () => {
    const captured: ChartSpec[] = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push(spec);
        return { id: spec.id, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedHorizontal(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'A6:K7',
      kind: 'column',
      title: 'Revenue by Year',
    });
    expect(out.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const spec = captured[0]!;
    // One series, NOT one per year-column (the #157 failure mode).
    expect(spec.seriesRanges).toHaveLength(1);
    expect(spec.seriesRanges[0]).toEqual({
      name: 'Revenue',
      cat: { sheet: 'Income', startRow: 5, startCol: 1, endRow: 5, endCol: 10 },
      val: { sheet: 'Income', startRow: 6, startCol: 1, endRow: 6, endCol: 10 },
    });
    // The val range really holds the Revenue row, exactly.
    const cats = await readRowValues(client, 'Income', 5, 1, 10);
    expect(cats).toEqual([2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021]);
    const vals = await readRowValues(client, 'Income', 6, 1, 10);
    expect(vals).toEqual(H_REVENUE);
  });

  it('charts two measure rows as two series, skipping empty rows', async () => {
    const captured: ChartSpec[] = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push(spec);
        return { id: spec.id, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedHorizontal(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'A6:K9',
      kind: 'column',
      title: 'Revenue and Gross Profit by Year',
    });
    expect(out.ok).toBe(true);
    const spec = captured[0]!;
    expect(spec.seriesRanges).toHaveLength(2);
    expect(spec.seriesRanges[0]!.name).toBe('Revenue');
    expect(spec.seriesRanges[0]!.val).toEqual({
      sheet: 'Income',
      startRow: 6,
      startCol: 1,
      endRow: 6,
      endCol: 10,
    });
    expect(spec.seriesRanges[1]!.name).toBe('Gross Profit');
    expect(spec.seriesRanges[1]!.val).toEqual({
      sheet: 'Income',
      startRow: 8,
      startCol: 1,
      endRow: 8,
      endCol: 10,
    });
  });

  it('still refuses a year row with no numeric measure row (sink never called)', async () => {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Income', row: 5, col: 1, value: 2012 },
        { sheet: 'Income', row: 5, col: 2, value: 2013 },
        { sheet: 'Income', row: 5, col: 3, value: 2014 },
        { sheet: 'Income', row: 6, col: 0, value: 'Revenue' },
      ],
    });
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'A6:D7',
      kind: 'column',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('no numeric measure row');
    expect(calls).toBe(0);
  });

  it('still refuses a single-row year range', async () => {
    const sink: ChartSink = {
      async addChart() {
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Income', row: 5, col: 1, value: 2012 },
        { sheet: 'Income', row: 5, col: 2, value: 2013 },
        { sheet: 'Income', row: 5, col: 3, value: 2014 },
      ],
    });
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'A6:D6',
      kind: 'column',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('header row and at least one data row');
  });
});

// ---------------------------------------------------------------------------
// W1 — first-turn sheet-context failure (root fix). Forwarding hosts (the
// gateway's NodeRemoteEngineHost) serve the SYNC sheetNames() from a cache
// that starts EMPTY on a fresh session binding and warms only via a
// background fetch: the first create_chart of a fresh session therefore
// saw [] and reported `unknown sheet "Sales"` for a sheet the session
// provably held (case-4 re-run, 3/3; planner-diag audit). Such hosts expose
// sheetNamesAsync() — an awaited, fresh read — and create_chart MUST
// prefer it over the sync cache view.
// ---------------------------------------------------------------------------

async function makeClientWithHost(
  host: EngineHost,
  options?: Parameters<typeof createServer>[1],
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host, options);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('create_chart on a forwarding host with a cold sync sheet cache (W1)', () => {
  it('succeeds on the FIRST call when sheetNamesAsync knows the sheet but the sync cache is cold', async () => {
    const host = new EngineHost();
    const sink: ChartSink = {
      async addChart(spec) {
        return { id: spec.id, revision: 3 };
      },
    };
    const client = await makeClientWithHost(host, { charts: sink });
    await seedData(client);
    // Simulate the fresh-binding remote host AFTER seeding: its sync
    // sheetNames() cache has not warmed yet ([]), the async accessor
    // fetches the real list.
    const patched = host as unknown as {
      sheetNames: () => string[];
      sheetNamesAsync?: () => Promise<string[]>;
    };
    patched.sheetNames = () => [];
    patched.sheetNamesAsync = async () => ['Sheet1'];
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      range: 'A1:B4',
      kind: 'column',
      title: 'First turn',
    });
    expect(out.ok).toBe(true);
    expect(out.revision).toBe(3);
  });

  it('prefers sheetNamesAsync over a STALE sync cache (sheet renamed after binding)', async () => {
    const host = new EngineHost();
    const sink: ChartSink = {
      async addChart(spec) {
        return { id: spec.id, revision: 4 };
      },
    };
    const client = await makeClientWithHost(host, { charts: sink });
    await seedData(client);
    const patched = host as unknown as {
      sheetNames: () => string[];
      sheetNamesAsync?: () => Promise<string[]>;
    };
    patched.sheetNames = () => ['OldName'];
    patched.sheetNamesAsync = async () => ['Sheet1'];
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      range: 'A1:B4',
      kind: 'column',
    });
    expect(out.ok).toBe(true);
    // And the stale name is refused: the async list is authoritative.
    const stale = await call(client, 'create_chart', {
      sheet: 'OldName',
      range: 'A1:B4',
      kind: 'column',
    });
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toContain('unknown sheet "OldName"');
  });

  it('still refuses a genuinely unknown sheet when sheetNamesAsync is present', async () => {
    const host = new EngineHost();
    const sink: ChartSink = {
      async addChart(spec) {
        return { id: spec.id, revision: 1 };
      },
    };
    const client = await makeClientWithHost(host, { charts: sink });
    const patched = host as unknown as {
      sheetNames: () => string[];
      sheetNamesAsync?: () => Promise<string[]>;
    };
    patched.sheetNames = () => [];
    patched.sheetNamesAsync = async () => ['Sheet1'];
    const out = await call(client, 'create_chart', { sheet: 'Nope', range: 'A1:B2', kind: 'line' });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('unknown sheet "Nope"');
  });
});

// ---------------------------------------------------------------------------
// Chart-range frame fix (2026-10-26): the planner reasons in 0-based
// absolute rows (describe_sheet coordinateFrame), but A1 is 1-based and
// the prompt never said so — reproof 3 emitted 0-based rows 5/6 as
// "A5:K6" and charted years as values (reproof 2's "A6:K7" was correct
// 1-based by luck). create_chart now ALSO accepts the 0-based bounds
// the planner already has, so no +1 conversion is ever required of
// the model. A1 keeps its 1-based meaning for backward compatibility.
// ---------------------------------------------------------------------------

describe('create_chart with 0-based bounds (chart-range frame fix)', () => {
  it('binds 0-based bounds to years-as-categories + Revenue values (no +1 needed)', async () => {
    const captured: ChartSpec[] = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push(spec);
        return { id: spec.id, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedHorizontal(client);
    // 0-based absolute: years row 5, Revenue row 6, cols A-K.
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      startRow: 5,
      startCol: 0,
      endRow: 6,
      endCol: 10,
      kind: 'column',
      title: 'Revenue by Year',
    });
    expect(out.ok).toBe(true);
    expect(out.range).toBe('A6:K7');
    expect(captured).toHaveLength(1);
    const spec = captured[0]!;
    expect(spec.seriesRanges).toHaveLength(1);
    expect(spec.seriesRanges[0]).toEqual({
      name: 'Revenue',
      cat: { sheet: 'Income', startRow: 5, startCol: 1, endRow: 5, endCol: 10 },
      val: { sheet: 'Income', startRow: 6, startCol: 1, endRow: 6, endCol: 10 },
    });
    const cats = await readRowValues(client, 'Income', 5, 1, 10);
    expect(cats).toEqual([2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021]);
    const vals = await readRowValues(client, 'Income', 6, 1, 10);
    expect(vals).toEqual(H_REVENUE);
  });

  it('bounds win over a conflicting A1 range (the reproof-3 trap string)', async () => {
    const captured: ChartSpec[] = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push(spec);
        return { id: spec.id, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedHorizontal(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'A5:K6',
      startRow: 5,
      startCol: 0,
      endRow: 6,
      endCol: 10,
      kind: 'column',
      title: 'Revenue by Year',
    });
    expect(out.ok).toBe(true);
    expect(out.range).toBe('A6:K7');
    const spec = captured[0]!;
    expect(spec.seriesRanges).toHaveLength(1);
    expect(spec.seriesRanges[0]!.val).toEqual({
      sheet: 'Income',
      startRow: 6,
      startCol: 1,
      endRow: 6,
      endCol: 10,
    });
  });

  it('an A1 range alone still parses 1-based (old inputs are NOT reinterpreted)', async () => {
    // Round-4 rewrite: this test used to bless the trap shape (A5:K6
    // over a label-less seed returned ok:true with years as values).
    // The refusal below IS the 1-based proof: if A5:K6 were misread
    // as 0-based rows 5-6, the years row would be FIRST and the call
    // would chart horizontally instead of refusing. 1-based A5:K6 =
    // 0-based rows 4-5, so the years row (row 5) sits in a non-first
    // row and the trap guard refuses with the 0-based correction
    // (startRow 5 = the years row).
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedHorizontal(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'A5:K6',
      kind: 'column',
      title: 'Revenue by Year',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('refusing to chart');
    expect(String(out.error)).toContain('year sequence 2012-2021');
    expect(String(out.error)).toContain('startRow 5');
    expect(calls).toBe(0);
  });

  it('rejects inverted bounds fail-closed (sink never called)', async () => {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedHorizontal(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      startRow: 6,
      startCol: 0,
      endRow: 5,
      endCol: 10,
      kind: 'column',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('invalid 0-based chart bounds');
    expect(calls).toBe(0);
  });

  it('rejects partial bounds without a range (sink never called)', async () => {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedHorizontal(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      startRow: 5,
      startCol: 0,
      kind: 'column',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('needs either');
    expect(calls).toBe(0);
  });

  it('bounds over an empty region still refuse (sink never called)', async () => {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedHorizontal(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      startRow: 20,
      startCol: 0,
      endRow: 21,
      endCol: 10,
      kind: 'column',
    });
    expect(out.ok).toBe(false);
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round-2 trap guard (leg B): a year sequence in a NON-first row of the
// range is a frame error (the #157 / leg-B trap: "A5:K6" and "B5:K6"
// are a label row + the years row, so the years would be plotted as
// ~2,012-tall values). Refused at the tool layer with the correction,
// never landed as a wrong chart. Legitimate horizontal (year row
// FIRST) and vertical (years as a column) layouts still chart.
// ---------------------------------------------------------------------------

describe('create_chart trap guard (round-2)', () => {
  async function seedTrap(client: Client): Promise<void> {
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 'Metric' },
        { sheet: 'Sheet1', row: 0, col: 1, value: 'X' },
        { sheet: 'Sheet1', row: 0, col: 2, value: 'Y' },
        { sheet: 'Sheet1', row: 0, col: 3, value: 'Z' },
        { sheet: 'Sheet1', row: 1, col: 0, value: 'Revenue' },
        { sheet: 'Sheet1', row: 1, col: 1, value: 2012 },
        { sheet: 'Sheet1', row: 1, col: 2, value: 2013 },
        { sheet: 'Sheet1', row: 1, col: 3, value: 2014 },
      ],
    });
  }

  it('refuses an A1 trap range (label row + years row) with the correction, sink never called', async () => {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedTrap(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      range: 'A1:D2',
      kind: 'column',
      title: 'Trap',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('refusing to chart');
    expect(String(out.error)).toContain('year sequence 2012-2014');
    expect(String(out.error)).toContain('startRow 1');
    expect(calls).toBe(0);
  });

  it('refuses the same trap shape via 0-based bounds', async () => {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedTrap(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 3,
      kind: 'column',
      title: 'Trap bounds',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('year sequence 2012-2014');
    expect(calls).toBe(0);
  });

  it('still charts a legitimate horizontal layout (year row FIRST)', async () => {
    const captured: ChartSpec[] = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push(spec);
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 'Year' },
        { sheet: 'Sheet1', row: 0, col: 1, value: 2012 },
        { sheet: 'Sheet1', row: 0, col: 2, value: 2013 },
        { sheet: 'Sheet1', row: 0, col: 3, value: 2014 },
        { sheet: 'Sheet1', row: 1, col: 0, value: 'Revenue' },
        { sheet: 'Sheet1', row: 1, col: 1, value: 100 },
        { sheet: 'Sheet1', row: 1, col: 2, value: 200 },
        { sheet: 'Sheet1', row: 1, col: 3, value: 300 },
      ],
    });
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      range: 'A1:D2',
      kind: 'column',
      title: 'Horizontal',
    });
    expect(out.ok).toBe(true);
    expect(captured).toHaveLength(1);
  });

  it('still charts a legitimate vertical layout (years as a column)', async () => {
    const captured: ChartSpec[] = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push(spec);
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 'Year' },
        { sheet: 'Sheet1', row: 0, col: 1, value: 'Revenue' },
        { sheet: 'Sheet1', row: 1, col: 0, value: 2012 },
        { sheet: 'Sheet1', row: 1, col: 1, value: 100 },
        { sheet: 'Sheet1', row: 2, col: 0, value: 2013 },
        { sheet: 'Sheet1', row: 2, col: 1, value: 200 },
        { sheet: 'Sheet1', row: 3, col: 0, value: 2014 },
        { sheet: 'Sheet1', row: 3, col: 1, value: 300 },
      ],
    });
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      range: 'A1:B4',
      kind: 'column',
      title: 'Vertical',
    });
    expect(out.ok).toBe(true);
    expect(captured).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Round-4 trap-guard bypass (leg B): the round-2 guard only scanned data
// rows when the range's first row carried a label in the range's columns
// (headerHasLabel). A range whose first row has NO labels in its columns
// skipped the guard entirely and fell to the vertical fallback, plotting
// the years row as single-value 'Series N' series — the combined-proof
// bypass chart (equal ~2,012 bars on a 0-2,500 axis). On the real bxl3way
// Income layout the bypass form is C5:K6: the 'Year' label column is
// dropped, so row 4 cols 2-10 are empty and the years row (cols 2-10 =
// 2013-2021) is a non-first row the old guard never saw. A year run in
// a non-first row can never be correct categories (horizontal needs it
// first; vertical needs years in a column), so the guard must fire
// regardless of labels.
// ---------------------------------------------------------------------------

describe('create_chart trap guard bypass (round-4)', () => {
  async function seedBxl3wayShape(client: Client): Promise<void> {
    const cells: { sheet: string; row: number; col: number; value: string | number }[] = [
      { sheet: 'Income', row: 3, col: 1, value: 'Actuals' },
      { sheet: 'Income', row: 3, col: 6, value: 'Forecasts' },
      { sheet: 'Income', row: 4, col: 1, value: 'Year' },
      { sheet: 'Income', row: 6, col: 0, value: 'Revenue' },
    ];
    for (let i = 0; i < 10; i++) {
      cells.push({ sheet: 'Income', row: 5, col: 1 + i, value: 2012 + i });
      cells.push({ sheet: 'Income', row: 6, col: 1 + i, value: H_REVENUE[i] });
    }
    const written = await call(client, 'write_cells', { cells });
    expect(written.ok).toBe(true);
  }

  it('logs every create_chart invocation (args capture) to stderr', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const captured: ChartSpec[] = [];
      const sink: ChartSink = {
        async addChart(spec) {
          captured.push(spec);
          return { id: spec.id, revision: 1 };
        },
      };
      const client = await makeClient({ charts: sink });
      await seedBxl3wayShape(client);
      const out = await call(client, 'create_chart', {
        sheet: 'Income',
        range: 'A6:K7',
        kind: 'column',
        title: 'Revenue by Year',
      });
      expect(out.ok).toBe(true);
      const lines = err.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('[mcp:create_chart]') && l.includes('"range":"A6:K7"'))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it('refuses C5:K6 (label column dropped) with the correction, sink never called', async () => {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedBxl3wayShape(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'C5:K6',
      kind: 'column',
      title: 'Bypass',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('refusing to chart');
    expect(String(out.error)).toContain('year sequence 2013-2021');
    expect(String(out.error)).toContain('startRow 5');
    expect(calls).toBe(0);
  });

  it('refuses the same bypass via 0-based bounds', async () => {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedBxl3wayShape(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      startRow: 4,
      startCol: 2,
      endRow: 5,
      endCol: 10,
      kind: 'column',
      title: 'Bypass bounds',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('year sequence 2013-2021');
    expect(calls).toBe(0);
  });

  it('still charts the correct range A6:K7 on the real layout (control)', async () => {
    const captured: ChartSpec[] = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push(spec);
        return { id: spec.id, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedBxl3wayShape(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'A6:K7',
      kind: 'column',
      title: 'Revenue by Year',
    });
    expect(out.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.seriesRanges).toHaveLength(1);
    expect(captured[0]!.seriesRanges[0]!.name).toBe('Revenue');
    expect(captured[0]!.seriesRanges[0]!.val).toEqual({
      sheet: 'Income',
      startRow: 6,
      startCol: 1,
      endRow: 6,
      endCol: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// Fix (A) (leg B): the trap-guard refusal must name the corrected call
// VERBATIM — the exact 1-based A1 range AND the exact 0-based bounds
// (all four numbers), computed from the FAILED args (shift the range so
// its first row is the year row and its first column is the label column
// col 0, preserving the row span and the last column). Leg-r5-b.json
// showed 29x B5:K6 + 1x F5:O6 across 55 audit rows: the old refusal
// gave only relative recipes ('startRow N' with startRow alone, 'the
// A1 range starting one row lower') and reproduced the failed call's
// own row tokens, so the model repeated the refused range instead of
// issuing the corrected one. The refusal stays a refusal — the
// corrected call is text only, never issued by the guard.
// ---------------------------------------------------------------------------

describe('create_chart trap guard refusal names the corrected call (fix A)', () => {
  async function seedBxl(client: Client): Promise<void> {
    const cells: { sheet: string; row: number; col: number; value: string | number }[] = [
      { sheet: 'Income', row: 4, col: 1, value: 'Year' },
      { sheet: 'Income', row: 6, col: 0, value: 'Revenue' },
    ];
    for (let i = 0; i < 10; i++) {
      cells.push({ sheet: 'Income', row: 5, col: 1 + i, value: 2012 + i });
      cells.push({ sheet: 'Income', row: 6, col: 1 + i, value: H_REVENUE[i] });
    }
    const written = await call(client, 'write_cells', { cells });
    expect(written.ok).toBe(true);
  }

  function countingSink(): { sink: ChartSink; calls: () => number } {
    let calls = 0;
    const sink: ChartSink = {
      async addChart() {
        calls++;
        return { id: 1, revision: 1 };
      },
    };
    return { sink, calls: () => calls };
  }

  it('refused B5:K6 names A6:K7 and bounds {5,0,6,10} verbatim, sink never called', async () => {
    const { sink, calls } = countingSink();
    const client = await makeClient({ charts: sink });
    await seedBxl(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'B5:K6',
      kind: 'column',
      title: 'Trap',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('refusing to chart');
    expect(String(out.error)).toContain('A6:K7');
    expect(String(out.error)).toContain('startRow 5, startCol 0, endRow 6, endCol 10');
    expect(calls()).toBe(0);
  });

  it('refused bounds {4,1,5,10} name bounds {5,0,6,10} and A6:K7 verbatim', async () => {
    const { sink, calls } = countingSink();
    const client = await makeClient({ charts: sink });
    await seedBxl(client);
    const out = await call(client, 'create_chart', {
      sheet: 'Income',
      startRow: 4,
      startCol: 1,
      endRow: 5,
      endCol: 10,
      kind: 'column',
      title: 'Trap bounds',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('refusing to chart');
    expect(String(out.error)).toContain('A6:K7');
    expect(String(out.error)).toContain('startRow 5, startCol 0, endRow 6, endCol 10');
    expect(calls()).toBe(0);
  });

  it('genuinely wrong ranges A5:K6, C5:K6, B5:K6 are all still refused', async () => {
    const { sink, calls } = countingSink();
    const client = await makeClient({ charts: sink });
    await seedBxl(client);
    for (const range of ['A5:K6', 'C5:K6', 'B5:K6']) {
      const out = await call(client, 'create_chart', {
        sheet: 'Income',
        range,
        kind: 'column',
        title: 'Trap',
      });
      expect(out.ok).toBe(false);
      expect(String(out.error)).toContain('refusing to chart');
      expect(String(out.error)).toContain('A6:K7');
    }
    expect(calls()).toBe(0);
  });

  it('control: correct A6:K7 and bounds {5,0,6,10} still succeed', async () => {
    const captured: ChartSpec[] = [];
    const sink: ChartSink = {
      async addChart(spec) {
        captured.push(spec);
        return { id: 1, revision: 1 };
      },
    };
    const client = await makeClient({ charts: sink });
    await seedBxl(client);
    const outA1 = await call(client, 'create_chart', {
      sheet: 'Income',
      range: 'A6:K7',
      kind: 'column',
      title: 'Revenue by Year',
    });
    expect(outA1.ok).toBe(true);
    expect(outA1.range).toBe('A6:K7');
    const outBounds = await call(client, 'create_chart', {
      sheet: 'Income',
      startRow: 5,
      startCol: 0,
      endRow: 6,
      endCol: 10,
      kind: 'column',
      title: 'Revenue by Year',
    });
    expect(outBounds.ok).toBe(true);
    expect(outBounds.range).toBe('A6:K7');
    expect(captured).toHaveLength(2);
  });

  it('correction is computed from the failed args, not hardcoded (different shape)', async () => {
    const { sink, calls } = countingSink();
    const client = await makeClient({ charts: sink });
    await call(client, 'write_cells', {
      cells: [
        { sheet: 'Sheet1', row: 0, col: 0, value: 'Metric' },
        { sheet: 'Sheet1', row: 0, col: 1, value: 'X' },
        { sheet: 'Sheet1', row: 0, col: 2, value: 'Y' },
        { sheet: 'Sheet1', row: 0, col: 3, value: 'Z' },
        { sheet: 'Sheet1', row: 1, col: 0, value: 'Revenue' },
        { sheet: 'Sheet1', row: 1, col: 1, value: 2012 },
        { sheet: 'Sheet1', row: 1, col: 2, value: 2013 },
        { sheet: 'Sheet1', row: 1, col: 3, value: 2014 },
      ],
    });
    const out = await call(client, 'create_chart', {
      sheet: 'Sheet1',
      range: 'A1:D2',
      kind: 'column',
      title: 'Trap',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('refusing to chart');
    expect(String(out.error)).toContain('A2:D3');
    expect(String(out.error)).toContain('startRow 1, startCol 0, endRow 2, endCol 3');
    expect(calls()).toBe(0);
  });
});
