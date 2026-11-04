/**
 * Named-value coverage tests (leg-C "not in sheet" follow-up): an app
 * that shows "not in sheet" for figures the data plainly holds is
 * rejected — a figure the request names that matches a DATA VALUES
 * cell must be reachable as a literal or via a read covering its cell.
 */
import { describe, expect, it } from 'vitest';
import {
  LlmAppGenerator,
  validateNamedValueCoverage,
  type AppGenerationInput,
  type CodeGenBackend,
} from '../src/artifacts/llm.js';

const PROMPT =
  "Create a dashboard with three KPI cards using DaisyUI classes. The cards should display 'Total Revenue', 'Gross Profit', and 'Net Income'. Use the values 1501837.91, 945097.33, and 301572.03 respectively.";

const VALUES: unknown[][] = [
  ['Summary Table', 'Column 2', 'Column 3', 'Column 4'],
  ['Checks Passed', 1501837.908, 945097.3291, 301572.0299],
  ['Earnings', 100, 200, 300],
];

const INPUT: AppGenerationInput = {
  prompt: PROMPT,
  sheet: 'Summaries',
  binding: { startRow: 0, startCol: 0, endRow: 15, endCol: 3, hasHeaderRow: true },
  columns: [{ name: 'Summary Table', type: 'text', index: 0 }],
  template: 'data-table',
  values: VALUES,
};

/** Leg-C shape, condensed: live read of rows 5-15 + leading-space labels. */
const BROKEN = [
  'function App() {',
  '  const [data, setData] = useState(null);',
  '  const [loading, setLoading] = useState(true);',
  '  useEffect(() => {',
  '    const fetchData = async () => {',
  '      const result = await mcp.call("read_cells", { sheet: "Summaries", startRow: 5, startCol: 0, endRow: 15, endCol: 3 });',
  '      setData(result.cells);',
  '      setLoading(false);',
  '    };',
  '    fetchData();',
  '    const sub = mcp.subscribe(["cells_changed"], "Summaries", fetchData);',
  '    return () => sub.unsubscribe();',
  '  }, []);',
  '  if (loading) return <div className="p-4">Loading...</div>;',
  '  const getMeasureData = (label) => {',
  '    const row = data.find(r => r[0] && String(r[0]).trim() === label);',
  '    if (!row) return { total: null, points: [] };',
  '    return { total: 0, points: [] };',
  '  };',
  '  const revenue = getMeasureData(" Revenue");',
  '  const gross = getMeasureData(" Gross Profit");',
  '  const net = getMeasureData(" Earnings Before Taxes");',
  '  return (<div className="card bg-base-100 shadow-sm"><div className="card-body"><div className="stats"><div className="stat"><div className="stat-title">Total Revenue</div><div className="stat-value">{revenue.total ? revenue.total : "not in sheet"}</div></div></div></div></div>);',
  '}',
].join('\n');

/** Same app, but the read covers the totals row (row 1). */
const FIXED_BY_READ = BROKEN.replace('startRow: 5', 'startRow: 0');

/** Same app, but the named figures appear as literals. */
const FIXED_BY_LITERAL = BROKEN + '\nconst TOTALS = [1501837.91, 945097.33, 301572.03];\n';

class QueueBackend implements CodeGenBackend {
  readonly name = 'queue-backend';
  readonly calls: string[] = [];
  constructor(private readonly codes: string[]) {}
  async generateCode(prompt: string): Promise<string> {
    this.calls.push(prompt);
    return this.codes[Math.min(this.calls.length - 1, this.codes.length - 1)] ?? '';
  }
}

describe('validateNamedValueCoverage', () => {
  it('fails the leg-C replica and names the exact cells', () => {
    const v = validateNamedValueCoverage(BROKEN, INPUT);
    expect(v.ok).toBe(false);
    const joined = v.errors.join('; ');
    expect(joined).toContain('Summaries!B2');
    expect(joined).toContain('Summaries!C2');
    expect(joined).toContain('Summaries!D2');
  });

  it('passes when a read covers the totals row', () => {
    expect(validateNamedValueCoverage(FIXED_BY_READ, INPUT).ok).toBe(true);
  });

  it('passes when the named figures appear as literals', () => {
    expect(validateNamedValueCoverage(FIXED_BY_LITERAL, INPUT).ok).toBe(true);
  });

  it('fails when the read is on a different sheet', () => {
    const otherSheet = BROKEN.replace('sheet: "Summaries"', 'sheet: "Income"').replace(
      'startRow: 5',
      'startRow: 0',
    );
    expect(validateNamedValueCoverage(otherSheet, INPUT).ok).toBe(false);
  });

  it('passes on a get_results read of the bound sheet', () => {
    const whole = BROKEN.replace(
      'mcp.call("read_cells", { sheet: "Summaries", startRow: 5, startCol: 0, endRow: 15, endCol: 3 })',
      'mcp.call("get_results", { sheet: "Summaries" })',
    );
    expect(validateNamedValueCoverage(whole, INPUT).ok).toBe(true);
  });

  it('fail-opens when the prompt names no large figures', () => {
    expect(
      validateNamedValueCoverage(BROKEN, { ...INPUT, prompt: 'build a KPI app' }).ok,
    ).toBe(true);
  });

  it('fail-opens when a named figure matches no cell', () => {
    expect(
      validateNamedValueCoverage(BROKEN, {
        ...INPUT,
        prompt: 'Use the values 9999999.99.',
      }).ok,
    ).toBe(true);
  });

  it('fail-opens with no values matrix', () => {
    expect(validateNamedValueCoverage(BROKEN, { ...INPUT, values: undefined }).ok).toBe(true);
  });

  it('fail-opens on an unparseable (dynamic) read bound', () => {
    const dynamic = BROKEN.replace('startRow: 5', 'startRow: BINDING.startRow');
    expect(validateNamedValueCoverage(dynamic, INPUT).ok).toBe(true);
  });

  it('does not treat year ranges as named figures', () => {
    const yearValues: unknown[][] = [[2012, 2021]];
    expect(
      validateNamedValueCoverage(BROKEN, {
        ...INPUT,
        prompt: 'trend 2012-2021',
        values: yearValues,
      }).ok,
    ).toBe(true);
  });
});

describe('generate() named-value coverage enforcement', () => {
  it('repairs a coverage miss and the result passes all checks', async () => {
    const gen = new LlmAppGenerator({ backend: new QueueBackend([BROKEN, FIXED_BY_READ]) });
    const out = await gen.generate(INPUT);
    expect(validateNamedValueCoverage(out.source, INPUT).ok).toBe(true);
    expect(out.source).toContain('startRow: 0');
  });

  it('rejects after a failed repair, naming the requirement', async () => {
    const gen = new LlmAppGenerator({ backend: new QueueBackend([BROKEN, BROKEN]) });
    await expect(gen.generate(INPUT)).rejects.toThrow(/named-value coverage requirement/);
  });
});
