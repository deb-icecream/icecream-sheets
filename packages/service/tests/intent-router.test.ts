/**
 * Tests for the chat intent router (intentRouter.ts).
 *
 * - Labeled prompt set: the user's two canonical examples plus 24 more,
 *   covering clear app / analysis / conversation prompts and genuinely
 *   ambiguous ones (which must trigger disambiguation, never a guess).
 * - Threshold semantics: a lone weak signal can never route; a lone
 *   moderate signal can; conflicting signals need a clear winner.
 * - Type-level pipeline separation: the app path's result has no
 *   python/backend field and the analysis path's result has no reactSource
 *   field (compile-time assertions; also checked at runtime).
 * - Dispatch: stub ports prove app → generateApp, analysis → analyze,
 *   conversation → runtime turn, disambiguate → question passthrough,
 *   missing pipeline port → 'unavailable'.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyIntent,
  isAmbiguous,
  routePrompt,
  resolveDisambiguation,
  dispatchIntent,
  registerIntentPorts,
  getIntentPorts,
  hasExplicitNativeChartIntent,
  hasExplicitNativeDiagramIntent,
  mentionsDiagram,
  disambiguationOptionsFor,
  INTENT_CONFIDENCE_THRESHOLD,
  DISAMBIGUATION_OPTIONS,
  NATIVE_CHART_OPTION,
  NATIVE_DIAGRAM_OPTION,
  type AppGenerationPort,
  type AnalysisPort,
  type DiagramPort,
  type AppGenerationResult,
  type AnalysisResult,
  type IntentKind,
  type IntentRoute,
} from '../src/agent/intentRouter.js';

// ---------------------------------------------------------------------------
// Compile-time helpers (evaluated by tsc; no-ops at runtime).
// ---------------------------------------------------------------------------
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
  ? true
  : false;
function assertType<T extends true>(): void {
  /* compile-time only */
}
type HasKey<T, K extends string> = Extract<keyof T, K> extends never ? false : true;

// ---------------------------------------------------------------------------
// Labeled prompt set.
// ---------------------------------------------------------------------------
const APP_PROMPTS = [
  'build me a sortable schedule app', // user's canonical app example
  'create an app where I can see/sort the schedule',
  'create a sortable table of clients',
  'build a dashboard for the monthly budget',
  'make a form to enter new orders',
  'design an interface for the inventory sheet',
  'create a tool to track invoices',
  'dashboard', // per spec signal list, "dashboard" is an app signal → routes app
];

const ANALYSIS_PROMPTS = [
  'show me a pivot chart of sales by region', // user's canonical analysis example
  'analyze sales trends for Q3',
  'show me a diagram of the revenue breakdown',
  'give me a bar chart of quarterly revenue',
  'forecast next month\'s revenue',
  'plot the distribution of ages',
  'what is the correlation between price and demand?',
  'visualize monthly expenses',
];

const CONVERSATION_PROMPTS = [
  "what's in this sheet?", // no intent smell → spec (c) fallback, no question
  'what is in cell A5?',
  'sum column B',
  'rename this sheet to Summary',
  'write a formula that computes profit margin',
];

const AMBIGUOUS_PROMPTS = [
  'show me the data', // weak analysis smell only → ask, don't guess
  'make something with the sales numbers', // weak app smell only → ask
  'chart this as an app', // app 3 vs analysis 3 → tie → ask
  'analyze this and make it sortable', // analysis 2 vs app 3 → too close → ask
  'build an app with a revenue chart', // app 4 vs analysis 3 → below threshold → ask
];

describe('classifyIntent — labeled prompt set', () => {
  it("routes the user's canonical app example to 'app'", () => {
    const c = classifyIntent('build me a sortable schedule app');
    expect(c.kind).toBe('app');
    expect(c.confidence).toBeGreaterThanOrEqual(INTENT_CONFIDENCE_THRESHOLD);
  });

  it("routes the user's canonical analysis example to 'analysis'", () => {
    const c = classifyIntent('show me a pivot chart of sales by region');
    expect(c.kind).toBe('analysis');
    expect(c.confidence).toBeGreaterThanOrEqual(INTENT_CONFIDENCE_THRESHOLD);
  });

  it.each(APP_PROMPTS)('app prompt → app: %s', (prompt) => {
    const c = classifyIntent(prompt);
    expect(c.kind).toBe('app');
    expect(isAmbiguous(c)).toBe(false);
  });

  it.each(ANALYSIS_PROMPTS)('analysis prompt → analysis: %s', (prompt) => {
    const c = classifyIntent(prompt);
    expect(c.kind).toBe('analysis');
    expect(isAmbiguous(c)).toBe(false);
  });

  it.each(CONVERSATION_PROMPTS)('conversation prompt → conversation: %s', (prompt) => {
    const c = classifyIntent(prompt);
    expect(c.kind).toBe('conversation');
    // Spec (c): the plain-chat fallback never asks a clarifying question.
    expect(isAmbiguous(c)).toBe(false);
  });

  it.each(AMBIGUOUS_PROMPTS)('ambiguous prompt triggers disambiguation: %s', (prompt) => {
    const c = classifyIntent(prompt);
    expect(isAmbiguous(c)).toBe(true);
    const route = routePrompt(prompt);
    expect(route.route).toBe('disambiguate');
    if (route.route === 'disambiguate') {
      expect(route.question).toContain('app');
      // W3: chart-mentioning ambiguous prompts additionally offer the
      // native-chart option FIRST; the rest keep the original three.
      const expected = /\bcharts?\b/.test(prompt)
        ? ['Native chart in sheet', 'Build an app', 'Analyze & visualize', 'Just answer']
        : ['Build an app', 'Analyze & visualize', 'Just answer'];
      expect([...route.options]).toEqual(expected);
    }
  });
});

describe('confidence threshold', () => {
  it('is 0.45 (documented in intentRouter.ts)', () => {
    expect(INTENT_CONFIDENCE_THRESHOLD).toBe(0.45);
  });

  it('a lone weak signal can never route ("show me the numbers")', () => {
    const c = classifyIntent('show me the numbers');
    expect(c.signals).toContain('show');
    expect(c.confidence).toBeLessThan(INTENT_CONFIDENCE_THRESHOLD);
    expect(isAmbiguous(c)).toBe(true);
  });

  it('a lone moderate signal routes ("visualize the data")', () => {
    const c = classifyIntent('visualize the data');
    expect(c.kind).toBe('analysis');
    expect(isAmbiguous(c)).toBe(false);
  });

  it('an empty prompt falls back to conversation without asking', () => {
    const c = classifyIntent('');
    expect(c.kind).toBe('conversation');
    expect(isAmbiguous(c)).toBe(false);
  });
});

describe('signals (explainability)', () => {  it('lists the matched keywords for the canonical app prompt', () => {
    const c = classifyIntent('build me a sortable schedule app');
    expect(c.signals).toEqual(expect.arrayContaining(['app', 'build me', 'sortable']));
  });

  it('lists the matched keywords for the canonical analysis prompt', () => {
    const c = classifyIntent('show me a pivot chart of sales by region');
    expect(c.signals).toEqual(expect.arrayContaining(['pivot', 'chart']));
  });

  it('conflicting prompts list both sides of signals', () => {
    const c = classifyIntent('chart this as an app');
    expect(c.signals).toEqual(expect.arrayContaining(['app', 'chart']));
  });
});

describe('analysis grammar verbs (added by the analysis lane)', () => {
  it.each([
    'summarize the sales data',
    'show a histogram of response times',
    'group by region and sum revenue',
    'rank the salespeople by revenue',
    'top 10 customers by order value',
  ])('routes to analysis: %s', (prompt) => {
    const c = classifyIntent(prompt);
    expect(c.kind).toBe('analysis');
    expect(isAmbiguous(c)).toBe(false);
  });

  it('does not treat "Summary" as the summarize verb ("rename this sheet to Summary")', () => {
    const c = classifyIntent('rename this sheet to Summary');
    expect(c.signals).not.toContain('summarize');
    expect(c.kind).toBe('conversation');
  });
});

describe('routePrompt', () => {
  it('carries the active sheet into the analysis route (#135)', () => {
    const route = routePrompt('show me a pivot chart of sales by region', { sheet: 'FMTs' });
    expect(route.route).toBe('analysis');
    if (route.route !== 'analysis') throw new Error('expected analysis route');
    expect(route.sheet).toBe('FMTs');
  });

  it('routes the reported bxl3way earnings prompt to analysis, not a Sheet1 default (#135)', () => {
    const route = routePrompt(
      'Build a quarterly-earnings aggregator and visualizer app from this spreadsheet data: read the Income and Summaries sheets, aggregate quarterly earnings, and show them as charts and totals.',
      { sheet: 'FMTs' },
    );
    expect(route.route).toBe('analysis');
    if (route.route !== 'analysis') throw new Error('expected analysis route');
    expect(route.sheet).toBe('FMTs');
  });
  it('passes the active range through to the analysis route', () => {
    const route = routePrompt('show me a pivot chart of sales by region', { range: 'A1:D20' });
    expect(route.route).toBe('analysis');
    if (route.route === 'analysis') expect(route.range).toBe('A1:D20');
  });

  it('non-ambiguous prompts never route to disambiguate', () => {
    const route = routePrompt('build me a sortable schedule app');
    expect(route.route).toBe('app');
  });
});

describe('resolveDisambiguation', () => {
  it.each([
    ['Build an app', 'app'],
    ['Analyze & visualize', 'analysis'],
    ['Just answer', 'conversation'],
    ['Native chart in sheet', 'chart'],
  ] as [string, IntentKind][])('maps %s → %s', (answer, kind) => {
    expect(resolveDisambiguation(answer)).toBe(kind);
  });

  it('every offered disambiguation option maps to a live intent (no dead ends)', () => {
    for (const opt of [...DISAMBIGUATION_OPTIONS, NATIVE_CHART_OPTION]) {
      expect(resolveDisambiguation(opt)).not.toBeNull();
    }
    for (const opt of disambiguationOptionsFor('chart this as an app')) {
      expect(resolveDisambiguation(opt)).not.toBeNull();
    }
  });

  it('returns null for an unrecognized answer', () => {
    expect(resolveDisambiguation('maybe later')).toBeNull();
  });

  it('exposes exactly the three specified option buttons', () => {
    expect([...DISAMBIGUATION_OPTIONS]).toEqual([
      'Build an app',
      'Analyze & visualize',
      'Just answer',
    ]);
  });
});

// ---------------------------------------------------------------------------
// W3: native-chart intent routing + the Build-an-app dead end.
// Evidence: case-4 re-run main-run — the explicit in-sheet chart request
// below scored app 2 vs analysis 3 (confidence 0.43) and disambiguated
// into three options, none of which could produce a native chart; the
// 'Build an app' answer built an app and ended the request (revision 0,
// no chart). create_chart itself passed 2/2 once the runtime was reached.
// ---------------------------------------------------------------------------
describe('native chart intent (W3)', () => {
  const EXPLICIT_CHART_PROMPTS = [
    // The exact case-4 main-run prompt.
    'Create a column chart of revenue by region in the Sales sheet — a native chart in the sheet itself, not an image in the chat. Use the region totals: North 89100 and South 70300.',
    // The case-4 retry phrasing that reached create_chart 2/2.
    'Add a column chart of Month vs Revenue to the Sales sheet.',
    // The brief's canonical form.
    'chart Month vs Revenue in this sheet',
    'insert a chart into the workbook',
    'put a bar chart on the Sales sheet',
  ];

  it.each(EXPLICIT_CHART_PROMPTS)('explicit native-chart prompt routes to chart, never disambiguates: %s', (prompt) => {
    expect(hasExplicitNativeChartIntent(prompt)).toBe(true);
    const c = classifyIntent(prompt);
    expect(c.kind).toBe('chart');
    expect(c.confidence).toBe(1);
    expect(isAmbiguous(c)).toBe(false);
    expect(routePrompt(prompt).route).toBe('chart');
  });

  it.each([
    'show me a pivot chart of sales by region', // canonical analysis example: no placement
    'give me a bar chart of quarterly revenue', // chart in chat, no placement
    'chart of sales by month', // analysis-lane phrasing, no placement
  ])('chart prompt without sheet placement is NOT native-chart: %s', (prompt) => {
    expect(hasExplicitNativeChartIntent(prompt)).toBe(false);
    expect(classifyIntent(prompt).kind).not.toBe('chart');
  });

  it('an explicit app request containing a chart is NOT stolen by the chart route', () => {
    const prompt = 'build an app with a chart in the sheet';
    expect(hasExplicitNativeChartIntent(prompt)).toBe(false);
    expect(classifyIntent(prompt).kind).not.toBe('chart');
    expect(routePrompt(prompt).route).not.toBe('chart');
  });

  it('an ambiguous chart prompt offers the native-chart option first', () => {
    const route = routePrompt('chart this as an app');
    expect(route.route).toBe('disambiguate');
    if (route.route === 'disambiguate') {
      expect(route.options[0]).toBe(NATIVE_CHART_OPTION);
      expect(route.question).toContain('native chart in the sheet');
    }
    expect(disambiguationOptionsFor('show me the data')).toEqual([...DISAMBIGUATION_OPTIONS]);
  });

  it("dispatches the chart route through the existing runtime (conversation) port", async () => {
    const seen: string[] = [];
    const route = routePrompt('Add a column chart of Month vs Revenue to the Sales sheet.');
    expect(route.route).toBe('chart');
    const res = await dispatchIntent(
      route,
      {
        conversation: async (p: string) => {
          seen.push(p);
          return 'Added a column chart to the Sales sheet.';
        },
        appGeneration: { generateApp: async () => { throw new Error('app lane must not run'); } },
        analysis: { analyze: async () => { throw new Error('analysis lane must not run'); } },
      },
      'Add a column chart of Month vs Revenue to the Sales sheet.',
    );
    expect(seen).toEqual(['Add a column chart of Month vs Revenue to the Sales sheet.']);
    expect(res).toEqual({ route: 'chart', message: 'Added a column chart to the Sales sheet.' });
  });

  it('every disambiguation answer dispatches to a real outcome (no dead-end branch)', async () => {
    const ports = {
      appGeneration: stubAppPort,
      analysis: stubAnalysisPort,
      conversation: conversationPort,
    };
    const cases: [string, IntentKind][] = [
      ['Build an app', 'app'],
      ['Analyze & visualize', 'analysis'],
      ['Native chart in sheet', 'chart'],
      ['Just answer', 'conversation'],
    ];
    for (const [answer, kind] of cases) {
      expect(resolveDisambiguation(answer)).toBe(kind);
      const classification = classifyIntent('chart this as an app');
      const forced: IntentRoute =
        kind === 'app'
          ? { route: 'app', classification }
          : kind === 'analysis'
            ? { route: 'analysis', classification }
            : kind === 'chart'
              ? { route: 'chart', classification }
              : { route: 'conversation', classification };
      const res = await dispatchIntent(forced, ports, 'chart this as an app');
      expect(res.route).toBe(kind);
      expect(res.route).not.toBe('unavailable');
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level pipeline separation (compile-time; tsc must pass).
// ---------------------------------------------------------------------------
describe('pipeline separation (type level)', () => {
  it('the app path result has no python/backend field', () => {
    assertType<Equal<HasKey<AppGenerationResult, 'pythonSource' | 'python' | 'backend'>, false>>();
    assertType<Equal<HasKey<AppGenerationResult, 'reactSource'>, true>>();
    assertType<Equal<HasKey<AppGenerationResult, 'artifactMeta'>, true>>();
  });

  it('the analysis path result has no reactSource field', () => {
    assertType<Equal<HasKey<AnalysisResult, 'reactSource' | 'react'>, false>>();
    assertType<Equal<HasKey<AnalysisResult, 'analysis'>, true>>();
    assertType<Equal<HasKey<AnalysisResult, 'chartSpec'>, true>>();
  });
});

// ---------------------------------------------------------------------------
// Dispatch with stub ports.
// ---------------------------------------------------------------------------
const stubAppPort: AppGenerationPort = {
  async generateApp(req) {
    return {
      reactSource: `// app for: ${req.prompt}\nexport default function App() { return null; }`,
      artifactMeta: { title: 'Test app', createdAt: 123 },
    };
  },
};

const stubAnalysisPort: AnalysisPort = {
  async analyze(req) {
    return {
      analysis: `analysis of ${req.prompt} over ${req.range ?? 'default range'}`,
      chartSpec: { type: 'bar', data: { labels: ['a'], datasets: [] } },
    };
  },
};

const conversationPort = async (prompt: string): Promise<string> => `runtime reply to: ${prompt}`;

describe('dispatchIntent', () => {
  it("routes 'app' to AppGenerationPort.generateApp with the prompt", async () => {
    const route: IntentRoute = routePrompt('build me a sortable schedule app');
    const res = await dispatchIntent(route, {
      appGeneration: stubAppPort,
      conversation: conversationPort,
    }, 'build me a sortable schedule app');
    expect(res.route).toBe('app');
    if (res.route !== 'app') throw new Error('expected app route');
    expect(res.result.reactSource).toContain('export default function App');
    expect(res.result.artifactMeta.title).toBe('Test app');
    // Runtime twin of the type-level check: no python on the app path.
    expect('pythonSource' in res.result).toBe(false);
    expect('python' in res.result).toBe(false);
  });

  it("routes 'analysis' to AnalysisPort.analyze with prompt + range", async () => {
    const route = routePrompt('show me a pivot chart of sales by region', { range: 'A1:D20' });
    const res = await dispatchIntent(route, {
      analysis: stubAnalysisPort,
      conversation: conversationPort,
    }, 'show me a pivot chart of sales by region');
    expect(res.route).toBe('analysis');
    if (res.route !== 'analysis') throw new Error('expected analysis route');
    expect(res.result.analysis).toContain('A1:D20');
    expect(res.result.chartSpec.type).toBe('bar');
    // Runtime twin of the type-level check: no React on the analysis path.
    expect('reactSource' in res.result).toBe(false);
  });

  it("passes the active sheet to AnalysisPort.analyze (#135)", async () => {
    const route = routePrompt('show me a pivot chart of sales by region', { sheet: 'FMTs' });
    let seen: string | undefined;
    const res = await dispatchIntent(route, {
      analysis: {
        async analyze(req) {
          seen = req.sheet;
          return { analysis: 'ok', chartSpec: { type: 'bar', data: { labels: [], datasets: [] } } };
        },
      },
      conversation: conversationPort,
    }, 'show me a pivot chart of sales by region');
    expect(res.route).toBe('analysis');
    expect(seen).toBe('FMTs');
  });

  it("routes 'conversation' to the existing agent runtime turn", async () => {
    const route = routePrompt('sum column B');
    const res = await dispatchIntent(route, { conversation: conversationPort }, 'sum column B');
    expect(res).toEqual({ route: 'conversation', message: 'runtime reply to: sum column B' });
  });

  it("passes 'disambiguate' through without calling any port", async () => {
    let called = false;
    const route = routePrompt('chart this as an app');
    expect(route.route).toBe('disambiguate');
    const res = await dispatchIntent(
      route,
      {
        appGeneration: { generateApp: async () => { called = true; throw new Error('no'); } },
        analysis: { analyze: async () => { called = true; throw new Error('no'); } },
        conversation: async () => { called = true; return 'no'; },
      },
      'chart this as an app',
    );
    expect(called).toBe(false);
    expect(res.route).toBe('disambiguate');
    if (res.route === 'disambiguate') {
      // 'chart this as an app' mentions a chart → the native-chart
      // option is offered alongside the original three (W3).
      expect(res.options).toHaveLength(4);
      expect(res.options[0]).toBe('Native chart in sheet');
    }
  });

  it("returns 'unavailable' when the app pipeline lane has not landed yet", async () => {
    const route = routePrompt('build me a sortable schedule app');
    const res = await dispatchIntent(route, { conversation: conversationPort }, 'build me a sortable schedule app');
    expect(res.route).toBe('unavailable');
    if (res.route === 'unavailable') {
      expect(res.requested).toBe('app');
      expect(res.reason).toMatch(/not wired up yet/);
    }
  });

  it("returns 'unavailable' when the analysis pipeline lane has not landed yet", async () => {
    const route = routePrompt('show me a pivot chart of sales by region');
    const res = await dispatchIntent(route, { conversation: conversationPort }, 'show me a pivot chart of sales by region');
    expect(res.route).toBe('unavailable');
    if (res.route === 'unavailable') {
      expect(res.requested).toBe('analysis');
    }
  });
});

describe('port registry (seam for the sibling lanes)', () => {
  it('registerIntentPorts / getIntentPorts publish the pipeline ports', () => {
    registerIntentPorts({ appGeneration: stubAppPort, analysis: stubAnalysisPort });
    const ports = getIntentPorts();
    expect(ports.appGeneration).toBe(stubAppPort);
    expect(ports.analysis).toBe(stubAnalysisPort);
  });
});

describe('native diagram intent (#126)', () => {
  const EXPLICIT_DIAGRAM_PROMPTS = [
    'Create a diagram inside the sheet showing the sales process from lead to close',
    'insert a diagram into the Sales sheet',
    'add a diagram to the workbook',
    'put a SmartArt diagram on the Sales sheet',
    'a native diagram in the sheet itself',
  ];

  it.each(EXPLICIT_DIAGRAM_PROMPTS)('explicit native-diagram prompt routes to diagram, never disambiguates: %s', (prompt) => {
    expect(hasExplicitNativeDiagramIntent(prompt)).toBe(true);
    const c = classifyIntent(prompt);
    expect(c.kind).toBe('diagram');
    expect(c.confidence).toBe(1);
    expect(isAmbiguous(c)).toBe(false);
    expect(routePrompt(prompt).route).toBe('diagram');
  });

  it.each([
    'show me a diagram', // no placement: stays analysis
    'analyze A1:D20 and show me a diagram', // analysis-lane phrasing, no placement
  ])('diagram prompt without sheet placement is NOT native-diagram: %s', (prompt) => {
    expect(hasExplicitNativeDiagramIntent(prompt)).toBe(false);
    expect(classifyIntent(prompt).kind).not.toBe('diagram');
  });

  it('an explicit app request containing a diagram is NOT stolen by the diagram route', () => {
    const prompt = 'build an app with a diagram in the sheet';
    expect(hasExplicitNativeDiagramIntent(prompt)).toBe(false);
    expect(classifyIntent(prompt).kind).not.toBe('diagram');
    expect(routePrompt(prompt).route).not.toBe('diagram');
  });

  it('an ambiguous diagram prompt offers the diagram option', () => {
    const route = routePrompt('diagram this as an app');
    expect(route.route).toBe('disambiguate');
    if (route.route === 'disambiguate') {
      expect(route.options).toContain(NATIVE_DIAGRAM_OPTION);
    }
    expect(resolveDisambiguation('Diagram in sheet')).toBe('diagram');
    expect(resolveDisambiguation('native diagram')).toBe('diagram');
  });

  it("routes 'diagram' to DiagramPort.createDiagram with the prompt", async () => {
    const prompt = 'Create a diagram inside the sheet showing the sales process from lead to close';
    const stubDiagramPort: DiagramPort = {
      createDiagram: async ({ prompt: p }) => ({ title: 'Process diagram', layout: 'process', itemCount: 2 }),
    };
    const route = routePrompt(prompt);
    expect(route.route).toBe('diagram');
    const res = await dispatchIntent(route, {
      diagram: stubDiagramPort,
      conversation: async () => 'should not be called',
    }, prompt);
    expect(res.route).toBe('diagram');
    if (res.route !== 'diagram') throw new Error('expected diagram route');
    expect(res.result.title).toBe('Process diagram');
  });

  it("returns 'unavailable' when the diagram pipeline lane has not landed yet", async () => {
    const prompt = 'Create a diagram inside the sheet';
    const route = routePrompt(prompt);
    const res = await dispatchIntent(route, { conversation: async () => 'runtime' }, prompt);
    expect(res.route).toBe('unavailable');
    if (res.route === 'unavailable') {
      expect(res.requested).toBe('diagram');
      expect(res.reason).toMatch(/not wired up yet/);
    }
  });
});
