/**
 * App-chart capability tests (option A, 2026-10-26): when the user asks
 * for a chart, the generated app must render the host AppChart
 * component — year labels as plain text are not a chart, and nothing
 * caught that before because the prompt never mentioned charts.
 */
import { describe, expect, it } from 'vitest';
import {
  CANNED_CHART_APP,
  LlmAppGenerator,
  hasAppChartComponent,
  validateChartRequirement,
  validateControlWiring,
  validateDesignSystem,
  validateInitialSelection,
  wantsChart,
  type AppGenerationInput,
  type CodeGenBackend,
} from '../src/artifacts/llm.js';

const INPUT: AppGenerationInput = {
  prompt: 'build me an app with a chart of revenue by year',
  sheet: 'Sheet1',
  binding: { startRow: 0, startCol: 0, endRow: 5, endCol: 2, hasHeaderRow: true },
  columns: [
    { name: 'Year', type: 'text', index: 0 },
    { name: 'Revenue', type: 'numeric', index: 1 },
  ],
  template: 'data-table',
};

/** A styled card app that fakes a chart with year labels as text —
 * the exact failure the round-2 proof showed. */
const TEXT_LABELS_APP = [
  'function App() {',
  '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
  '    <h2 className="card-title">Revenue by Year</h2>',
  '    <div>2012 2013 2014 2015 2016 2017 2018 2019 2020 2021</div>',
  '  </div></div>;',
  '}',
].join('\n');

/** Same card, but with the real component. */
const REAL_CHART_APP = [
  'function App() {',
  '  var points = [{ label: "2012", value: 102007 }, { label: "2021", value: 183416 }];',
  '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
  '    <AppChart data={points} title="Revenue by Year" />',
  '  </div></div>;',
  '}',
].join('\n');

class QueueBackend implements CodeGenBackend {
  readonly name = 'queue-backend';
  readonly calls: string[] = [];
  constructor(private readonly codes: string[]) {}
  async generateCode(prompt: string): Promise<string> {
    this.calls.push(prompt);
    return this.codes[Math.min(this.calls.length - 1, this.codes.length - 1)] ?? '';
  }
}

function generator(codes: string[]): LlmAppGenerator {
  return new LlmAppGenerator({ backend: new QueueBackend(codes) });
}

describe('wantsChart', () => {
  it('matches chart/graph/plot/visualization wording', () => {
    expect(wantsChart('show me a chart of revenue')).toBe(true);
    expect(wantsChart('plot the trend')).toBe(true);
    expect(wantsChart('a bar graph please')).toBe(true);
    expect(wantsChart('add a visualisation')).toBe(true);
  });

  it('does not fire on a plain dashboard request', () => {
    expect(wantsChart('build me a sortable hours app')).toBe(false);
    expect(wantsChart('show the totals')).toBe(false);
  });
});

describe('hasAppChartComponent', () => {
  it('detects JSX and h() forms', () => {
    expect(hasAppChartComponent('<AppChart data={points} />')).toBe(true);
    expect(hasAppChartComponent("h(AppChart, { data: points })")).toBe(true);
  });

  it('does not mistake a mention or a div chart for the component', () => {
    expect(hasAppChartComponent('AppChart is great')).toBe(false);
    expect(hasAppChartComponent('<div className="chart">2012</div>')).toBe(false);
  });
});

describe('validateChartRequirement', () => {
  it('rejects a chart request rendered as text labels', () => {
    const v = validateChartRequirement(TEXT_LABELS_APP, INPUT.prompt);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/AppChart/);
  });

  it('passes a chart request rendered with AppChart', () => {
    expect(validateChartRequirement(REAL_CHART_APP, INPUT.prompt).ok).toBe(true);
    expect(validateChartRequirement(CANNED_CHART_APP, INPUT.prompt).ok).toBe(true);
  });

  it('passes a non-chart request with no chart component', () => {
    expect(
      validateChartRequirement(TEXT_LABELS_APP, 'build me a sortable hours app').ok,
    ).toBe(true);
  });
});

describe('LlmAppGenerator chart repair', () => {
  it('prompt names AppChart, its props, and the requirement', () => {
    const gen = new LlmAppGenerator({ backend: new QueueBackend([REAL_CHART_APP]) });
    const prompt = gen.buildPrompt(INPUT);
    expect(prompt).toMatch(/AppChart/);
    expect(prompt).toMatch(/\{ label, value \}/);
    expect(prompt).toMatch(/NEVER render year labels/);
  });

  it('repairs a chart-less app once, naming the miss', async () => {
    const backend = new QueueBackend([TEXT_LABELS_APP, REAL_CHART_APP]);
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate(INPUT);
    expect(out.source).toMatch(/AppChart/);
    expect(backend.calls.length).toBe(2);
    expect(backend.calls[1]).toMatch(/AppChart/);
  });

  it('throws visibly when the repair still has no chart', async () => {
    const gen = generator([TEXT_LABELS_APP, TEXT_LABELS_APP]);
    await expect(gen.generate(INPUT)).rejects.toThrow(/chart requirement/);
  });

  it('canned chart app passes both validators', () => {
    expect(validateDesignSystem(CANNED_CHART_APP).ok).toBe(true);
    expect(validateChartRequirement(CANNED_CHART_APP, INPUT.prompt).ok).toBe(true);
  });

  it('chart repair throwing names a design-system regression too', async () => {
    const plain = ['function App() {', '  return h("div", null, "2012");', '}'].join('\n');
    const gen = generator([TEXT_LABELS_APP, plain]);
    await expect(gen.generate(INPUT)).rejects.toThrow(/DaisyUI component class/);
  });

  it('chart repair carries the previous source and preserves its controls (round-4 leg C)', async () => {
    // Combined proof: the chart repair regenerated from scratch and
    // the model dropped the requested toggle buttons (chart + dropdown
    // survived, buttons did not). The repair prompt must embed the
    // previous source and demand a minimal edit that keeps controls.
    const withControls = [
      'function App() {',
      '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
      '    <button className="btn btn-primary">ToggleRevenueXYZ</button>',
      '    <select className="select"><option>Revenue</option></select>',
      '    <div>2012 2013 2014 2015 2016 2017 2018 2019 2020 2021</div>',
      '  </div></div>;',
      '}',
    ].join('\n');
    const repairedWithControls = [
      'function App() {',
      '  var points = [{ label: "2012", value: 102007 }, { label: "2021", value: 183416 }];',
      '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
      '    <button className="btn btn-primary">ToggleRevenueXYZ</button>',
      '    <select className="select"><option>Revenue</option></select>',
      '    <AppChart data={points} title="Revenue by Year" />',
      '  </div></div>;',
      '}',
    ].join('\n');
    const backend = new QueueBackend([withControls, repairedWithControls]);
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate(INPUT);
    expect(backend.calls.length).toBe(2);
    expect(backend.calls[1]).toContain('ToggleRevenueXYZ');
    expect(backend.calls[1]).toMatch(/MINIMAL edit/);
    expect(backend.calls[1]).toMatch(/keep every control/);
    expect(backend.calls[1]).toMatch(/btn/);
    expect(out.source).toMatch(/AppChart/);
    expect(out.source).toContain('ToggleRevenueXYZ');
    expect(validateDesignSystem(out.source).ok).toBe(true);
    expect(validateChartRequirement(out.source, INPUT.prompt).ok).toBe(true);
  });

  it('chart repair does not regress the design system', async () => {
    const plainChartless = [
      'function App() {',
      '  return h("div", null, "2012 2013");',
      '}',
    ].join('\n');
    // First attempt fails DS (plain divs) -> DS repair returns a styled
    // chart app, so generation succeeds with both checks green.
    const gen = generator([plainChartless, REAL_CHART_APP]);
    const out = await gen.generate(INPUT);
    expect(validateDesignSystem(out.source).ok).toBe(true);
    expect(validateChartRequirement(out.source, INPUT.prompt).ok).toBe(true);
  });
});

describe('validateControlWiring', () => {
  // Round-4 leg C, verbatim shape: buttons + dropdown + real chart +
  // exact totals all render, but switching changes NOTHING — the
  // selection is read only by active classes and the select value,
  // the chart data is a fixed series, the KPI cards are static.
  const LEG_C_FAIL = [
    'function App() {',
    '  const [measure, setMeasure] = useState("Revenue");',
    '  var revenuePoints = [{ label: "2012", value: 102007 }];',
    '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
    '    <button className={measure === "Revenue" ? "btn btn-primary" : "btn"} onClick={() => setMeasure("Revenue")}>Revenue</button>',
    '    <button className={measure === "Gross Profit" ? "btn btn-primary" : "btn"} onClick={() => setMeasure("Gross Profit")}>Gross Profit</button>',
    '    <select className="select" value={measure} onChange={(e) => setMeasure(e.target.value)}><option>Revenue</option><option>Gross Profit</option></select>',
    '    <div className="stat-value">1501838</div>',
    '    <div className="stat-value">945097</div>',
    '    <AppChart data={revenuePoints} title="Revenue by Year" />',
    '  </div></div>;',
    '}',
  ].join('\n');

  // Same controls, wired: a featured figure and the chart data both
  // come from the selection through one derived lookup.
  const LEG_C_PASS = [
    'function App() {',
    '  const [measure, setMeasure] = useState("Revenue");',
    '  var MEASURES = { Revenue: { total: 1501838, points: [{ label: "2012", value: 102007 }] }, "Gross Profit": { total: 945097, points: [{ label: "2012", value: 556740 }] } };',
    '  const featured = MEASURES[measure];',
    '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
    '    <button className={measure === "Revenue" ? "btn btn-primary" : "btn"} onClick={() => setMeasure("Revenue")}>Revenue</button>',
    '    <select className="select" value={measure} onChange={(e) => setMeasure(e.target.value)}><option>Revenue</option><option>Gross Profit</option></select>',
    '    <div className="stat-value">{featured.total}</div>',
    '    <AppChart data={featured.points} title={measure + " by Year"} />',
    '  </div></div>;',
    '}',
  ].join('\n');

  it('rejects the round-4 leg C shape on BOTH legs, naming each', () => {
    const v = validateControlWiring(LEG_C_FAIL);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/no displayed content reads the selection/);
    expect(v.errors.join(' ')).toMatch(/chart data does not depend on the selection/);
  });

  it('passes the wired shape (featured figure + chart from the selection)', () => {
    expect(validateControlWiring(LEG_C_PASS).ok).toBe(true);
  });

  it('fails the active-class-only shape: className ternaries are not display', () => {
    // The leg-C sync behavior stripped bare: the selection appears
    // ONLY in className ternaries and handlers, beside static KPIs
    // and no chart. Stripping the chrome must leave no mention.
    const activeOnly = [
      'function App() {',
      '  const [measure, setMeasure] = useState("Revenue");',
      '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
      '    <button className={measure === "Revenue" ? "btn btn-primary" : "btn"} onClick={() => setMeasure("Revenue")}>Revenue</button>',
      '    <div className="stat-value">1501838</div>',
      '  </div></div>;',
      '}',
    ].join('\n');
    const v = validateControlWiring(activeOnly);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/no displayed content reads the selection/);
  });

  it('passes an app with no control set: the rule does not apply', () => {
    expect(validateControlWiring(REAL_CHART_APP).ok).toBe(true);
  });

  it('passes controls driving a table filter (visible output, not just figures)', () => {
    const filtered = [
      'function App() {',
      '  const [measure, setMeasure] = useState("Revenue");',
      '  var ROWS = [{ measure: "Revenue", value: 102007 }];',
      '  const filtered = ROWS.filter((r) => r.measure === measure);',
      '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
      '    <select className="select" value={measure} onChange={(e) => setMeasure(e.target.value)}><option>Revenue</option></select>',
      '    <div>{filtered.map((r) => r.value)}</div>',
      '  </div></div>;',
      '}',
    ].join('\n');
    expect(validateControlWiring(filtered).ok).toBe(true);
  });

  it('passes the h() form when the chart data is a function of the selection', () => {
    const hForm = [
      'function App() {',
      '  const [measure, setMeasure] = useState("Revenue");',
      '  function pointsFor(m) { return [{ label: "2012", value: 102007 }]; }',
      '  var featured = { total: 1501838 };',
      '  return h("div", { className: "card bg-base-100 shadow-sm" },',
      '    h("button", { className: "btn btn-primary", onClick: () => setMeasure("Revenue") }, "Revenue"),',
      '    h("div", { className: "stat-value" }, featured.total),',
      '    h(AppChart, { data: pointsFor(measure), title: measure }));',
      '}',
    ].join('\n');
    // featured is NOT derived from measure here, so the figure leg
    // passes only via the chart data? No: the figure leg needs a
    // derived mention in visible output — featured.total is a plain
    // value, not derived. This shape must FAIL the figure leg while
    // the chart leg passes, proving the two legs are independent.
    const v = validateControlWiring(hForm);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/no displayed content reads the selection/);
    expect(v.errors.join(' ')).not.toMatch(/chart data does not depend/);
  });

  it('repairs an unwired app once, naming the miss, and keeps all three checks green', async () => {
    const backend = new QueueBackend([LEG_C_FAIL, LEG_C_PASS]);
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate(INPUT);
    expect(backend.calls.length).toBe(2);
    expect(backend.calls[1]).toMatch(/WIRE the selection/);
    expect(backend.calls[1]).toMatch(/featured-figure/);
    expect(out.source).toMatch(/featured/);
    expect(validateDesignSystem(out.source).ok).toBe(true);
    expect(validateChartRequirement(out.source, INPUT.prompt).ok).toBe(true);
    expect(validateControlWiring(out.source).ok).toBe(true);
  });

  it('throws visibly when the wiring repair still drives nothing', async () => {
    const gen = generator([LEG_C_FAIL, LEG_C_FAIL]);
    await expect(gen.generate(INPUT)).rejects.toThrow(/control-wiring requirement/);
  });
});

describe('validateInitialSelection', () => {
  // #166, verbatim shape from the v4 recording's app (artifact
  // mvps9lc0, 'ProfitPulse Dashboard'): the initial state is a
  // SHORT display label while the lookup keys are FULL labels, so
  // the mount lookup misses and the fallback renders 0.00 + an
  // empty chart until a button sets a full key. Buttons display
  // short labels as TEXT but SET full keys — that half is correct;
  // only the initial value is wrong.
  const V4_BROKEN = [
    'function App() {',
    '  const [selectedMeasure, setSelectedMeasure] = useState("Revenue");',
    '  const measures = {',
    '    "Total Revenue": { total: 1501837.91, points: [{ label: "2012", value: 102007 }] },',
    '    "Gross Profit": { total: 945097.33, points: [{ label: "2012", value: 62984 }] },',
    '    "Net Income": { total: 301572.03, points: [{ label: "2012", value: 2473.83 }] }',
    '  };',
    '  const current = measures[selectedMeasure] || { total: 0, points: [] };',
    '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
    '    <div className="stat-title">Featured: {selectedMeasure}</div>',
    '    <div className="stat-value">{current.total}</div>',
    '    <select className="select" value={selectedMeasure} onChange={(e) => setSelectedMeasure(e.target.value)}><option value="Total Revenue">Total Revenue</option><option value="Gross Profit">Gross Profit</option><option value="Net Income">Net Income</option></select>',
    '    <button className={selectedMeasure === "Total Revenue" ? "btn btn-primary" : "btn"} onClick={() => setSelectedMeasure("Total Revenue")}>Revenue</button>',
    '    <AppChart data={current.points} title={selectedMeasure + " by Year"} />',
    '  </div></div>;',
    '}',
  ].join('\n');

  const V4_FIXED = V4_BROKEN.replace('useState("Revenue")', 'useState("Total Revenue")');

  it('documents the gap: round-5 wiring passes the v4 shape (both legs read the state)', () => {
    expect(validateControlWiring(V4_BROKEN).ok).toBe(true);
  });

  it('fails the v4 shape: initial "Revenue" is not a lookup key', () => {
    const v = validateInitialSelection(V4_BROKEN);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/initial selection "Revenue"/);
    expect(v.errors.join(' ')).toMatch(/Total Revenue/);
  });

  it('passes the fixed shape: initial "Total Revenue" is a lookup key', () => {
    expect(validateInitialSelection(V4_FIXED).ok).toBe(true);
    expect(validateControlWiring(V4_FIXED).ok).toBe(true);
  });

  it('passes the round-5 wired shape: its initial value is already a key', () => {
    // LEG_C_PASS is scoped to the wiring describe block; restate its
    // initial/lookup pair here so this check stands alone.
    const wired = [
      'function App() {',
      '  const [measure, setMeasure] = useState("Revenue");',
      '  var MEASURES = { Revenue: { total: 1501838, points: [] }, "Gross Profit": { total: 945097, points: [] } };',
      '  const featured = MEASURES[measure];',
      '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
      '    <button className={measure === "Revenue" ? "btn btn-primary" : "btn"} onClick={() => setMeasure("Revenue")}>Revenue</button>',
      '    <select className="select" value={measure} onChange={(e) => setMeasure(e.target.value)}><option>Revenue</option></select>',
      '    <div className="stat-value">{featured.total}</div>',
      '    <AppChart data={featured.points} title={measure + " by Year"} />',
      '  </div></div>;',
      '}',
    ].join('\n');
    expect(validateInitialSelection(wired).ok).toBe(true);
  });

  it('fails open on findRow-style derivations: no lookup table, nothing to check', () => {
    const findRow = [
      'function App() {',
      '  const [selectedMeasure, setSelectedMeasure] = useState("Revenue");',
      '  const findRow = (label) => data.find((row) => row[0] === label);',
      '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
      '    <select className="select" value={selectedMeasure} onChange={(e) => setSelectedMeasure(e.target.value)}><option>Revenue</option></select>',
      '    <div className="stat-value">{findRow(selectedMeasure)}</div>',
      '  </div></div>;',
      '}',
    ].join('\n');
    expect(validateInitialSelection(findRow).ok).toBe(true);
  });

  it('fails open on non-literal and dynamic shapes: only literal-vs-literal is judged', () => {
    const nonLiteral = [
      'function App() {',
      '  const [measure, setMeasure] = useState(defaultKey);',
      '  const measures = { "Total Revenue": { total: 1, points: [] } };',
      '  const current = measures[measure];',
      '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
      '    <button className="btn" onClick={() => setMeasure("Total Revenue")}>Revenue</button>',
      '    <div className="stat-value">{current.total}</div>',
      '  </div></div>;',
      '}',
    ].join('\n');
    expect(validateInitialSelection(nonLiteral).ok).toBe(true);
    const dynamic = [
      'function App() {',
      '  const [measure, setMeasure] = useState("Revenue");',
      '  const measures = buildMeasures(rows);',
      '  const current = measures[measure];',
      '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
      '    <button className="btn" onClick={() => setMeasure("Revenue")}>Revenue</button>',
      '    <div className="stat-value">{current.total}</div>',
      '  </div></div>;',
      '}',
    ].join('\n');
    expect(validateInitialSelection(dynamic).ok).toBe(true);
  });

  it('repairs a broken initial value once, naming the miss, and keeps all four checks green', async () => {
    const backend = new QueueBackend([V4_BROKEN, V4_FIXED]);
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate(INPUT);
    expect(backend.calls.length).toBe(2);
    expect(backend.calls[1]).toMatch(/initial selection/);
    expect(backend.calls[1]).toMatch(/Total Revenue/);
    expect(validateDesignSystem(out.source).ok).toBe(true);
    expect(validateChartRequirement(out.source, INPUT.prompt).ok).toBe(true);
    expect(validateControlWiring(out.source).ok).toBe(true);
    expect(validateInitialSelection(out.source).ok).toBe(true);
  });

  it('throws visibly when the initial-value repair still resolves to nothing', async () => {
    const gen = generator([V4_BROKEN, V4_BROKEN]);
    await expect(gen.generate(INPUT)).rejects.toThrow(/initial-selection requirement/);
  });
});
