/**
 * Tests for the data-analysis + visualization pipeline
 * (packages/service/src/analysis/).
 *
 * - schema.ts: extraction, type inference, statistics, denied-cell handling
 * - planner.ts: intent grammar classification + chat routing
 * - generator.ts: template emission (stdout-contract structure), determinism,
 *   freeform seam
 * - executor.ts: deterministic execution via mock runner, contract/cap guards
 * - chartspec.ts: spec validation + Chart.js config mapping
 * - port.ts: AnalysisPort seam for the chat intent router
 * - artifact.ts: versioning, migration, metadata store
 * - agent wiring: heuristic backend routes analysis/app prompts correctly
 */
import { describe, expect, it } from 'vitest';
import {
  a1Ref,
  ANALYSIS_ARTIFACT_VERSION,
  analysisSummary,
  ANALYSIS_INTENT_KINDS,
  ANALYSIS_SCRIPT_VERSION,
  buildFreeformPrompt,
  categoricalColumns,
  classifyAnalysisIntent,
  createAnalysisPort,
  createAnalysisStore,
  deserializeAnalyses,
  detectHeaderRow,
  executeAnalysis,
  extractDataSchema,
  extractScriptVersion,
  FreeformPythonGenerator,
  hashInput,
  isAnalysisPrompt,
  makeArtifact,
  MAX_ANALYSIS_INPUT_BYTES,
  MAX_ANALYSIS_OUTPUT_BYTES,
  migrateAnalysis,
  numericColumns,
  resolvePlan,
  routeChatIntent,
  serializeAnalyses,
  TemplatePythonGenerator,
  toChartConfiguration,
  toChartJsVisualSpec,
  validateAnalysisChartSpec,
  validatePythonSource,
  type AnalysisInput,
  type AnalysisPlan,
  type CellInput,
  type DataSchema,
  type PythonRunner,
} from '../src/analysis/index.js';
import { memoryPersistence } from '../src/metadataStore.js';
import type { PlannerInput } from '../src/agent/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRID: CellInput[][] = [
  ['Region', 'Sales', 'Units', 'SoldAt', 'Active'],
  ['North', 100, 5, '2026-01-01', true],
  ['South', 200, 8, '2026-01-02', false],
  ['North', 150, 6, '2026-01-03', true],
  ['South', 250, 9, '2026-01-04', true],
  ['East', 50, 4, '2026-01-05', false],
];

const RANGE = { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 5, endCol: 4 };

const reader = async (): Promise<CellInput[][]> => GRID;

async function sampleSchema(): Promise<DataSchema> {
  return extractDataSchema(reader, RANGE);
}

function planFor(kind: AnalysisPlan['intentKind'], extra: Partial<AnalysisPlan> = {}): AnalysisPlan {
  return { intentKind: kind, targetColumns: [], params: {}, summary: `${kind} analysis`, ...extra };
}

const VALID_CHART = {
  type: 'bar',
  title: 't',
  labels: ['a', 'b'],
  datasets: [{ label: 's', data: [1, 2] }],
};

function mockRunner(resultValue: unknown): PythonRunner {
  return async (_code: string, _input: AnalysisInput) => ({ value: resultValue });
}

function plannerInput(text: string): PlannerInput {
  return { userText: text, history: [], toolResults: [], iteration: 1 };
}

// ---------------------------------------------------------------------------
// schema.ts
// ---------------------------------------------------------------------------

describe('extractDataSchema', () => {
  it('extracts headers and infers column types', async () => {
    const schema = await sampleSchema();
    expect(schema.sheet).toBe('Sheet1');
    expect(schema.rangeRef).toBe('Sheet1!A1:E6');
    expect(schema.rowCount).toBe(5);
    expect(schema.columns.map((c) => c.name)).toEqual(['Region', 'Sales', 'Units', 'SoldAt', 'Active']);
    expect(schema.columns.map((c) => c.inferredType)).toEqual(['text', 'numeric', 'numeric', 'date', 'boolean']);
  });

  it('falls back to "Column N" for blank headers', async () => {
    const grid: CellInput[][] = [[null, 'B'], [1, 2]];
    const schema = await extractDataSchema(async () => grid, {
      sheet: 'S',
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
    });
    expect(schema.columns[0]!.name).toBe('Column 1');
    expect(schema.columns[1]!.name).toBe('B');
  });

  it('computes numeric stats (min/max/mean/stdev)', async () => {
    const schema = await sampleSchema();
    const sales = schema.columns[1]!.stats.numeric!;
    expect(sales.count).toBe(5);
    expect(sales.min).toBe(50);
    expect(sales.max).toBe(250);
    expect(sales.mean).toBe(150);
    expect(sales.stdev).toBeCloseTo(79.0569, 3);
  });

  it('computes categorical stats (distinct/topValues)', async () => {
    const schema = await sampleSchema();
    const region = schema.columns[0]!.stats.categorical!;
    expect(region.distinct).toBe(3);
    expect(region.topValues[0]).toEqual({ value: 'North', count: 2 });
  });

  it('computes date stats (min/max)', async () => {
    const schema = await sampleSchema();
    const sold = schema.columns[3]!.stats.date!;
    expect(sold.count).toBe(5);
    expect(sold.min).toBe('2026-01-01');
    expect(sold.max).toBe('2026-01-05');
  });

  it('treats denied (#PERM!) cells as invisible', async () => {
    const grid: CellInput[][] = [
      ['Secret', 'Sales'],
      [{ error: '#PERM!' }, 10],
      ['visible', 20],
    ];
    const schema = await extractDataSchema(async () => grid, {
      sheet: 'S',
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 1,
    });
    // The denied cell must not leak into headers or statistics.
    expect(schema.columns[0]!.name).toBe('Secret');
    expect(schema.columns[0]!.stats.nonEmpty).toBe(1);
    expect(schema.columns[1]!.stats.numeric!.count).toBe(2);
  });

  it('a1Ref formats ranges', () => {
    expect(a1Ref({ sheet: 'S', startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toBe('S!A1');
    expect(a1Ref({ sheet: 'S', startRow: 0, startCol: 0, endRow: 9, endCol: 27 })).toBe('S!A1:AB10');
  });

  it('numericColumns / categoricalColumns helpers', async () => {
    const schema = await sampleSchema();
    expect(numericColumns(schema).map((c) => c.name)).toEqual(['Sales', 'Units']);
    expect(categoricalColumns(schema).map((c) => c.name)).toEqual(['Region', 'SoldAt', 'Active']);
  });
});

// ---------------------------------------------------------------------------
// schema.ts — header contract regression (live defect, gate-fix proof:
// cases/planner-diag/results-gatefix.json — the planner passed analyze_data
// the data-only range Sales rows 1-12 / col 2 and the pipeline consumed
// the first data row as a "header", answering 147,400 instead of 159,400)
// ---------------------------------------------------------------------------

describe('extractDataSchema header contract', () => {
  // The exact W3a Sales fixture values (hidden_files/agent-features/cases/
  // w3a-fixture.json): total 159,400; dropping the first value (Jan/North
  // 12,000) yields exactly the defective 147,400.
  const REVENUES = [12000, 9800, 13500, 11200, 15800, 12600, 14200, 10900, 16900, 11600, 16700, 14200];
  const SALES_ROWS: CellInput[][] = [
    ['Jan', 'North', 12000],
    ['Jan', 'South', 9800],
    ['Feb', 'North', 13500],
    ['Feb', 'South', 11200],
    ['Mar', 'North', 15800],
    ['Mar', 'South', 12600],
    ['Apr', 'North', 14200],
    ['Apr', 'South', 10900],
    ['May', 'North', 16900],
    ['May', 'South', 11600],
    ['Jun', 'North', 16700],
    ['Jun', 'South', 14200],
  ];
  const numericSum = (schema: DataSchema, col: number): number => {
    const n = schema.columns[col]!.stats.numeric!;
    return n.count * n.mean;
  };

  it('a data-only range aggregates ALL its rows (159,400, not 147,400)', async () => {
    // The exact live call shape: single Revenue column, sheet rows 1-12 —
    // the header row (sheet row 0) is NOT part of the range.
    const grid: CellInput[][] = REVENUES.map((v) => [v]);
    const schema = await extractDataSchema(async () => grid, {
      sheet: 'Sales',
      startRow: 1,
      startCol: 2,
      endRow: 12,
      endCol: 2,
    });
    expect(schema.hasHeaderRow).toBe(false);
    expect(schema.rowCount).toBe(12);
    expect(schema.columns[0]!.stats.numeric!.count).toBe(12);
    expect(numericSum(schema, 0)).toBeCloseTo(159400, 4);
  });

  it('a full-width data-only range keeps every row and value', async () => {
    const schema = await extractDataSchema(async () => SALES_ROWS, {
      sheet: 'Sales',
      startRow: 1,
      startCol: 0,
      endRow: 12,
      endCol: 2,
    });
    expect(schema.hasHeaderRow).toBe(false);
    expect(schema.rowCount).toBe(12);
    expect(numericSum(schema, 2)).toBeCloseTo(159400, 4);
    const regions = schema.columns[1]!.stats.categorical!;
    expect(regions.distinct).toBe(2);
    expect(Object.fromEntries(regions.topValues.map((t) => [t.value, t.count]))).toEqual({
      North: 6,
      South: 6,
    });
  });

  it('a header-inclusive range still uses its header row (auto-detected)', async () => {
    const grid: CellInput[][] = [['Month', 'Region', 'Revenue'], ...SALES_ROWS];
    const schema = await extractDataSchema(async () => grid, {
      sheet: 'Sales',
      startRow: 0,
      startCol: 0,
      endRow: 12,
      endCol: 2,
    });
    expect(schema.hasHeaderRow).toBe(true);
    expect(schema.rowCount).toBe(12);
    expect(schema.columns.map((c) => c.name)).toEqual(['Month', 'Region', 'Revenue']);
    expect(numericSum(schema, 2)).toBeCloseTo(159400, 4);
  });

  it('explicit headerRow:false treats even a header-looking first row as data', async () => {
    const grid: CellInput[][] = [['Month', 'Region', 'Revenue'], ...SALES_ROWS];
    const schema = await extractDataSchema(
      async () => grid,
      { sheet: 'Sales', startRow: 0, startCol: 0, endRow: 12, endCol: 2 },
      { headerRow: false },
    );
    expect(schema.hasHeaderRow).toBe(false);
    expect(schema.rowCount).toBe(13);
    expect(schema.columns.map((c) => c.name)).toEqual(['Column 1', 'Column 2', 'Column 3']);
  });

  it('explicit headerRow:true consumes the first row of a data-only range (declaration honored)', async () => {
    // Pins the contract's other half: when the caller DECLARES a header,
    // the declaration wins — the 147,400 figure is correct ONLY here.
    const grid: CellInput[][] = REVENUES.map((v) => [v]);
    const schema = await extractDataSchema(
      async () => grid,
      { sheet: 'Sales', startRow: 1, startCol: 2, endRow: 12, endCol: 2 },
      { headerRow: true },
    );
    expect(schema.hasHeaderRow).toBe(true);
    expect(schema.rowCount).toBe(11);
    expect(numericSum(schema, 0)).toBeCloseTo(147400, 4);
  });

  it('a text-only data column is not mistaken for a header', async () => {
    const grid: CellInput[][] = [['North'], ['South'], ['North']];
    const schema = await extractDataSchema(async () => grid, {
      sheet: 'S',
      startRow: 1,
      startCol: 1,
      endRow: 3,
      endCol: 1,
    });
    expect(schema.hasHeaderRow).toBe(false);
    expect(schema.rowCount).toBe(3);
    expect(schema.columns[0]!.stats.categorical!.distinct).toBe(2);
  });

  it('detectHeaderRow: numbers, booleans and numeric strings in row 0 are data', () => {
    expect(detectHeaderRow([[12000], [9800]])).toBe(false);
    expect(detectHeaderRow([[true], [1]])).toBe(false);
    expect(detectHeaderRow([['2024'], [100]])).toBe(false);
    expect(detectHeaderRow([['Revenue'], [100]])).toBe(true);
    expect(detectHeaderRow([['Revenue']])).toBe(false);
    expect(detectHeaderRow([['North'], ['South']])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planner.ts — intent grammar
// ---------------------------------------------------------------------------

describe('classifyAnalysisIntent', () => {
  it.each([
    ['summarize this data', 'summarize'],
    ['describe the dataset', 'summarize'],
    ['show me the revenue numbers', 'summarize'],
    ['pivot sales by region', 'aggregate'],
    ['group revenue by month', 'aggregate'],
    ['revenue by region', 'aggregate'],
    ['total sales by product', 'aggregate'],
    ['sales per region', 'aggregate'],
    ['show a chart of revenue by region', 'aggregate'],
    ['forecast next quarter revenue', 'trend'],
    ['show the sales trend over time', 'trend'],
    ['plot the distribution of ages', 'distribution'],
    ['show me a histogram of prices', 'distribution'],
    ['correlation between price and demand', 'correlation'],
    ['compare Q1 vs Q2 revenue', 'compare'],
    ['top 10 products by sales', 'top-n'],
    ['rank the regions by revenue', 'top-n'],
  ] as const)('classifies "%s" as %s', (text, kind) => {
    const plan = classifyAnalysisIntent(text);
    expect(plan.intentKind).toBe(kind);
  });

  it('covers the full documented grammar', () => {
    expect([...ANALYSIS_INTENT_KINDS].sort()).toEqual(
      ['aggregate', 'compare', 'correlation', 'distribution', 'summarize', 'top-n', 'trend'].sort(),
    );
  });

  it('extracts top-N count (explicit and default)', () => {
    expect(classifyAnalysisIntent('top 5 products by sales').params.n).toBe(5);
    expect(classifyAnalysisIntent('show the top products').params.n).toBe(10);
  });

  it('extracts column hints from "by <column>" and quotes', () => {
    const plan = classifyAnalysisIntent('pivot "Sales" by region');
    expect(plan.targetColumns).toContain('Sales');
    expect(plan.targetColumns).toContain('region');
  });

  it('extracts forecast horizon for "next quarter"', () => {
    const plan = classifyAnalysisIntent('forecast next quarter revenue');
    expect(plan.intentKind).toBe('trend');
    expect(plan.params.forecastHorizon).toBe(3);
  });
});

describe('routeChatIntent', () => {
  it('routes app-generation prompts to the app lane', () => {
    expect(routeChatIntent('build me an app from this sales data')).toBe('app-generation');
    expect(routeChatIntent('generate a React app for the budget sheet')).toBe('app-generation');
  });

  it('routes analytical prompts to the analysis component', () => {
    expect(routeChatIntent('analyze the data and show me a diagram')).toBe('analysis');
    expect(routeChatIntent('forecast next quarter')).toBe('analysis');
    expect(routeChatIntent('top 10 products by sales')).toBe('analysis');
    expect(routeChatIntent('show me a histogram of prices')).toBe('analysis');
    expect(isAnalysisPrompt('compare Q1 vs Q2')).toBe(true);
  });

  it('never guesses on ambiguous prompts', () => {
    // App + analysis signals below the confidence threshold -> 'other'.
    expect(routeChatIntent('build an app with a revenue chart')).toBe('other');
  });

  it('leaves non-analytical prompts alone', () => {
    expect(routeChatIntent('sum of A1:A10')).toBe('other');
    expect(routeChatIntent('set B2 to 5')).toBe('other');
    expect(isAnalysisPrompt('recalculate')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generator.ts
// ---------------------------------------------------------------------------

describe('TemplatePythonGenerator', () => {
  const gen = new TemplatePythonGenerator();

  it('emits a script honoring the stdout contract for every intent kind', async () => {
    const schema = await sampleSchema();
    for (const kind of ANALYSIS_INTENT_KINDS) {
      const source = (await gen.generate(schema, planFor(kind))) as string;
      expect(source).toContain(`analysis-script-version: ${ANALYSIS_SCRIPT_VERSION}`);
      // Contract: reads sandbox-injected `args`, assigns ONE `result` object.
      expect(source).toContain('args["columns"]');
      expect(source).toMatch(/(^|\n)result\s*=\s*\{/);
      expect(source).toContain('"analysis"');
      expect(source).toContain('"chartSpec"');
      // Only sandbox-allowlisted imports.
      const imports = [...source.matchAll(/^import (\w+)/gm)].map((m) => m[1]);
      for (const mod of imports) {
        expect(['json', 'math', 'statistics']).toContain(mod);
      }
    }
  });

  it('resolves plan column hints to schema columns', async () => {
    const schema = await sampleSchema();
    const source = (await gen.generate(
      schema,
      planFor('aggregate', { targetColumns: ['region', 'sales'] }),
    )) as string;
    expect(source).toContain('"Region"');
    expect(source).toContain('"Sales"');
  });

  it('is deterministic: same (schema, plan) -> byte-identical source', async () => {
    const schema = await sampleSchema();
    const plan = planFor('trend', { targetColumns: ['SoldAt', 'Sales'] });
    const a = await gen.generate(schema, plan);
    const b = await gen.generate(schema, plan);
    expect(a).toBe(b);
  });

  it('throws a clear error when the plan is unsatisfiable', async () => {
    const schema: DataSchema = {
      sheet: 'S',
      rangeRef: 'S!A1:A3',
      rowCount: 2,
      hasHeaderRow: true,
      columns: [
        {
          name: 'Name',
          index: 0,
          inferredType: 'text',
          stats: { nonEmpty: 2, nullCount: 0, numeric: null, categorical: null, date: null },
        },
      ],
    };
    expect(() => resolvePlan(schema, planFor('trend'))).toThrow(/needs a numeric column/);
    expect(() => resolvePlan(schema, planFor('correlation'))).toThrow(/at least two numeric/);
  });

  it('top-n honors the requested count', async () => {
    const schema = await sampleSchema();
    const source = (await gen.generate(schema, planFor('top-n', { params: { n: 3 } }))) as string;
    expect(source).toContain('_n = 3');
  });
});

describe('validatePythonSource', () => {
  it('accepts a contract-honoring script', () => {
    expect(validatePythonSource('result = {"analysis": {}, "chartSpec": {}}')).toEqual({ ok: true });
  });

  it('rejects empty source and source missing the result assignment', () => {
    expect(validatePythonSource('')).toEqual({ ok: false, error: expect.any(String) });
    expect(validatePythonSource('print("hello")')).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('FreeformPythonGenerator', () => {
  it('delegates to the source and validates the contract', async () => {
    const schema = await sampleSchema();
    const gen = new FreeformPythonGenerator({
      generateCode: async (prompt: string) => {
        expect(prompt).toContain('chartSpec');
        expect(prompt).toContain('Sales');
        return 'result = {"analysis": {"ok": true}, "chartSpec": {"type": "bar", "datasets": []}}';
      },
    });
    const source = await gen.generate(schema, planFor('summarize'));
    expect(source).toContain('result =');
  });

  it('rejects source that violates the contract', async () => {
    const schema = await sampleSchema();
    const gen = new FreeformPythonGenerator({
      generateCode: async () => 'print("no result assignment")',
    });
    await expect(gen.generate(schema, planFor('summarize'))).rejects.toThrow(/must assign/);
  });

  it('buildFreeformPrompt carries schema, plan and the strict contract', async () => {
    const schema = await sampleSchema();
    const prompt = buildFreeformPrompt(schema, planFor('aggregate'));
    expect(prompt).toContain('MUST assign `result`');
    expect(prompt).toContain('Allowed imports ONLY');
    expect(prompt).toContain('"Sales"');
    expect(prompt).toContain('"aggregate"');
  });
});

// ---------------------------------------------------------------------------
// executor.ts
// ---------------------------------------------------------------------------

describe('executeAnalysis', () => {
  const source = `# analysis-script-version: ${ANALYSIS_SCRIPT_VERSION}\nresult = {}`;
  const input: AnalysisInput = { columns: ['A'], rows: [[1], [2]] };

  it('returns the validated contract payload on success', async () => {
    const res = await executeAnalysis(
      mockRunner({ analysis: { n: 2 }, chartSpec: VALID_CHART }),
      source,
      input,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.analysis).toEqual({ n: 2 });
      expect(res.chartSpec.type).toBe('bar');
      expect(res.scriptVersion).toBe(ANALYSIS_SCRIPT_VERSION);
      expect(typeof res.durationMs).toBe('number');
    }
  });

  it('is deterministic: same script + same data -> byte-identical result', async () => {
    const runner = mockRunner({ analysis: { total: 42 }, chartSpec: VALID_CHART });
    const a = await executeAnalysis(runner, source, input);
    const b = await executeAnalysis(runner, source, input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rejects scripts without the version stamp', async () => {
    const res = await executeAnalysis(mockRunner({}), 'result = {}', input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/version stamp/);
  });

  it('rejects scripts with an unsupported version', async () => {
    const res = await executeAnalysis(
      mockRunner({}),
      '# analysis-script-version: 999\nresult = {}',
      input,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unsupported script version/);
  });

  it('rejects payloads missing analysis or with an invalid chartSpec', async () => {
    const noAnalysis = await executeAnalysis(mockRunner({ chartSpec: VALID_CHART }), source, input);
    expect(noAnalysis.ok).toBe(false);

    const badChart = await executeAnalysis(
      mockRunner({ analysis: {}, chartSpec: { type: 'nope', datasets: [] } }),
      source,
      input,
    );
    expect(badChart.ok).toBe(false);
    if (!badChart.ok) expect(badChart.error).toMatch(/chartSpec/);
  });

  it('surfaces sandbox errors', async () => {
    const runner: PythonRunner = async () => ({ error: 'boom' });
    const res = await executeAnalysis(runner, source, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/boom/);
  });

  it('enforces the output-size cap', async () => {
    const big = { analysis: { blob: 'x'.repeat(MAX_ANALYSIS_OUTPUT_BYTES + 1) }, chartSpec: VALID_CHART };
    const res = await executeAnalysis(mockRunner(big), source, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/output too large/);
  });

  it('enforces the input-size cap before spawning the runner', async () => {
    let called = false;
    const runner: PythonRunner = async () => {
      called = true;
      return { value: {} };
    };
    const bigInput: AnalysisInput = {
      columns: ['A'],
      rows: Array.from({ length: (MAX_ANALYSIS_INPUT_BYTES + 100) / 8 }, () => ['xxxxxxxx']),
    };
    const res = await executeAnalysis(runner, source, bigInput);
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/input too large/);
  });

  it('extractScriptVersion parses the stamp', () => {
    expect(extractScriptVersion(`# analysis-script-version: ${ANALYSIS_SCRIPT_VERSION}\n`)).toBe(
      ANALYSIS_SCRIPT_VERSION,
    );
    expect(extractScriptVersion('no stamp here')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// chartspec.ts
// ---------------------------------------------------------------------------

describe('validateAnalysisChartSpec', () => {
  it('accepts a well-formed spec', () => {
    const checked = validateAnalysisChartSpec(VALID_CHART);
    expect(checked.ok).toBe(true);
  });

  it('rejects unknown types and non-objects', () => {
    expect(validateAnalysisChartSpec({ type: 'funnel3d', datasets: [] }).ok).toBe(false);
    expect(validateAnalysisChartSpec(null).ok).toBe(false);
    expect(validateAnalysisChartSpec('bar').ok).toBe(false);
  });

  it('rejects dataset/labels length mismatches', () => {
    const checked = validateAnalysisChartSpec({
      type: 'bar',
      labels: ['a'],
      datasets: [{ label: 's', data: [1, 2] }],
    });
    expect(checked.ok).toBe(false);
  });

  it('scatter requires {x, y} points; cartesian kinds require plain numbers', () => {
    expect(
      validateAnalysisChartSpec({
        type: 'scatter',
        datasets: [{ label: 's', data: [{ x: 1, y: 2 }] }],
      }).ok,
    ).toBe(true);
    expect(
      validateAnalysisChartSpec({ type: 'scatter', datasets: [{ label: 's', data: [1, 2] }] }).ok,
    ).toBe(false);
    expect(
      validateAnalysisChartSpec({
        type: 'bar',
        labels: ['a'],
        datasets: [{ label: 's', data: [{ x: 1, y: 2 }] }],
      }).ok,
    ).toBe(false);
  });
});

describe('toChartConfiguration', () => {
  it('maps to a Chart.js config for ChartCanvas', () => {
    const config = toChartConfiguration({
      type: 'line',
      title: 'Trend',
      labels: ['a', 'b'],
      datasets: [{ label: 's', data: [1, 2] }],
    });
    expect(config.type).toBe('line');
    expect(config.data?.labels).toEqual(['a', 'b']);
    expect(config.data?.datasets).toHaveLength(1);
    expect(config.options?.plugins?.title).toMatchObject({ display: true, text: 'Trend' });
  });
});

describe('port (AnalysisPort seam)', () => {
  it('createAnalysisPort maps the pipeline result to the router shape', async () => {
    const port = createAnalysisPort({
      runAnalysis: async ({ prompt, range }) => ({
        summary: `did ${prompt} on ${range}`,
        chartSpec: { type: 'bar', datasets: [{ label: 's', data: [1] }] },
      }),
    });
    const result = await port.analyze({ prompt: 'analyze it', range: 'Sheet1!A1:B2' });
    expect(result.analysis).toBe('did analyze it on Sheet1!A1:B2');
    expect(result.chartSpec.type).toBe('bar');
    expect(result.chartSpec.data).toBeDefined();
    // Pipeline separation: the analysis path never carries React fields.
    expect('reactSource' in result).toBe(false);
    expect('react' in result).toBe(false);
  });

  it('toChartJsVisualSpec carries type/data/options', () => {
    const spec = toChartJsVisualSpec({ type: 'pie', title: 'P', datasets: [{ label: 's', data: [1, 2] }] });
    expect(spec.type).toBe('pie');
    expect(spec.data).toMatchObject({ datasets: expect.any(Array) });
    expect(spec.options).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// artifact.ts
// ---------------------------------------------------------------------------

describe('analysis artifacts', () => {
  function sampleArtifact() {
    return makeArtifact({
      id: 'analysis_1',
      intent: 'pivot sales by region',
      plan: planFor('aggregate'),
      schemaSnapshot: {
        sheet: 'Sheet1',
        rangeRef: 'Sheet1!A1:B4',
        rowCount: 3,
        hasHeaderRow: true,
        columns: [],
      },
      inputHash: hashInput('input'),
      pythonSource: `# analysis-script-version: ${ANALYSIS_SCRIPT_VERSION}\nresult = {}`,
      scriptVersion: ANALYSIS_SCRIPT_VERSION,
      result: { grandTotal: 450 },
      chartSpec: { type: 'bar', datasets: [{ label: 'Sales', data: [250, 200] }] },
      principal: 'tester',
    });
  }

  it('makeArtifact stamps the current version and timestamp', () => {
    const a = sampleArtifact();
    expect(a.version).toBe(ANALYSIS_ARTIFACT_VERSION);
    expect(a.createdAt).not.toBe('');
  });

  it('serialize/deserialize round-trips through the metadata store', () => {
    const store = createAnalysisStore(memoryPersistence());
    store.add(sampleArtifact());
    expect(store.all()).toHaveLength(1);
    const json = serializeAnalyses(store.all());
    expect(deserializeAnalyses(json)).toHaveLength(1);
    expect(deserializeAnalyses(json)[0]!.id).toBe('analysis_1');
  });

  it('migrateAnalysis drops garbage and future versions', () => {
    expect(migrateAnalysis(null)).toBeNull();
    expect(migrateAnalysis({ id: 42 })).toBeNull();
    expect(
      migrateAnalysis({ ...sampleArtifact(), version: ANALYSIS_ARTIFACT_VERSION + 1 }),
    ).toBeNull();
    const migrated = migrateAnalysis({ ...sampleArtifact(), version: 1 });
    expect(migrated?.id).toBe('analysis_1');
  });

  it('deserializeAnalyses returns [] for corrupt payloads', () => {
    expect(deserializeAnalyses('not json')).toEqual([]);
    expect(deserializeAnalyses('{"analyses": "nope"}')).toEqual([]);
  });

  it('hashInput is deterministic and discriminating', () => {
    expect(hashInput('abc')).toBe(hashInput('abc'));
    expect(hashInput('abc')).not.toBe(hashInput('abd'));
  });

  it('analysisSummary omits the script source', () => {
    const summary = analysisSummary(sampleArtifact());
    expect(summary).toMatchObject({
      id: 'analysis_1',
      intentKind: 'aggregate',
      rangeRef: 'Sheet1!A1:B4',
      scriptVersion: ANALYSIS_SCRIPT_VERSION,
    });
    expect('pythonSource' in summary).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agent wiring: heuristic backend routes analysis vs app prompts
// ---------------------------------------------------------------------------

