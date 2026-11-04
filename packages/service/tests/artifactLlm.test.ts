/**
 * LLM wiring for freeform React generation (user spec 2026-10-18).
 *
 * - TEST MODE: prompt is captured and diverted to the assistant's own LLM
 *   (TestCodeGenBackend). Tests prove the full pipeline:
 *   prompt -> capture -> divert -> React app -> validated artifact.
 * - PRODUCTION MODE: real Vertex AI on GCP (default gemini-3.1-flash-lite —
 *   user ruling 2026-10-21: cheap Gemini models for all LLM calls, and
 *   the absolute cheapest after a pricing check; 2.5-flash-lite retired
 *   2026-10-22, bumped to the pre-authorized 3.1-flash-lite successor;
 *   gemini-2.5-pro remains a per-deployment override). Credentials come from
 *   the vault via getAccessToken; a clear error is thrown when absent.
 * - Mode safety: test mode NEVER calls Vertex AI; production NEVER diverts
 *   to the test backend. The mode is structural (which backend was built).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CANNED_TEST_APP,
  CODEGEN_MAX_OUTPUT_TOKENS,
  LlmAppGenerator,
  OpenAiCompatibleCodeGenBackend,
  TestCodeGenBackend,
  VertexAiCodeGenBackend,
  VERTEX_DEFAULT_LOCATION,
  VERTEX_DEFAULT_MODEL,
  extractCode,
  formatDataValues,
  normalizeAppSource,
  sanitizeReactDestructure,
  vertexAiHost,
  generateAndSaveArtifact,
  resolveAppGenerator,
  type ArtifactSpec,
  type GenerateArtifactInput,
} from '../src/index.js';

const SHEET_CELLS = [
  ['Name', 'Hours'],
  ['Alice', 8],
  ['Bob', 6],
];

function testDeps(generator: LlmAppGenerator) {
  const specs: ArtifactSpec[] = [];
  return {
    deps: {
      callTool: async (tool: string) => {
        if (tool === 'get_results') return { cells: SHEET_CELLS };
        throw new Error(`unexpected tool ${tool}`);
      },
      store: { add: (s: ArtifactSpec) => specs.push(s) },
      generator,
      principal: 'test-user',
      template: 'data-table' as const,
    },
    specs,
  };
}

const INPUT: GenerateArtifactInput = { prompt: 'build me a sortable hours app', sheet: 'Sheet1' };

describe('test mode: capture -> divert -> app -> artifact', () => {
  it('runs the full pipeline through the test backend', async () => {
    const backend = new TestCodeGenBackend();
    const gen = new LlmAppGenerator({ backend });
    expect(gen.mode).toBe('test');
    const { deps, specs } = testDeps(gen);
    const result = await generateAndSaveArtifact(INPUT, deps);
    expect(result.routed).toBe('app');
    if (result.routed !== 'app') throw new Error('unreachable');
    // The prompt was captured (diverted to "the assistant's own LLM").
    expect(backend.capturedPrompts).toHaveLength(1);
    const captured = backend.capturedPrompts[0];
    expect(captured).toContain('build me a sortable hours app');
    expect(captured).toContain('Name');
    expect(captured).toContain('Hours');
    expect(captured).toContain('function App()');
    // The diverted response became a validated, persisted artifact.
    expect(specs).toHaveLength(1);
    expect(result.spec.template).toBe('custom');
    expect(result.spec.source).toContain('function App()');
    expect(result.spec.source).toContain('mcp.call');
    expect(result.spec.principal).toBe('test-user');
  });

  it('prompt contract names the exact subscribe events + BINDING + unsubscribe shape (wave-c W2)', async () => {
    // Regression pin for case 3b: the generated app guessed the event
    // name 'cell_changed' (rejected by the MCP subscribe enum, so the
    // live binding silently never fired) because the contract never
    // named the valid events or the subscribe return shape.
    const backend = new TestCodeGenBackend();
    const gen = new LlmAppGenerator({ backend });
    const { deps } = testDeps(gen);
    await generateAndSaveArtifact(INPUT, deps);
    const captured = backend.capturedPrompts[0]!;
    expect(captured).toContain('"cells_changed"');
    expect(captured).toContain('"recalc_complete"');
    expect(captured).toContain('.unsubscribe()');
    expect(captured).toContain('BINDING = {sheet,startRow,startCol,endRow,endCol,columns} is pre-defined');
    expect(captured).toContain('{cells}');
  });

  it('test backend never touches the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new TestCodeGenBackend();
    await backend.generateCode('anything');
    // No fetch property exists on the backend at all (structural safety).
    expect('fetchImpl' in backend).toBe(false);
    expect('fetch' in backend).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('canned app is a valid artifact source', () => {
    expect(CANNED_TEST_APP).toContain('function App()');
    expect(CANNED_TEST_APP).not.toContain('</script');
    expect(CANNED_TEST_APP).toContain('mcp.call');
  });

  it('rejects diverted sources that violate the contract', async () => {
    const bad = new TestCodeGenBackend();
    // Poison the canned response with a script-breakout.
    const orig = bad.generateCode.bind(bad);
    bad.generateCode = async (p: string) => (await orig(p)) + '</script>';
    const gen = new LlmAppGenerator({ backend: bad });
    await expect(
      gen.generate({
        prompt: 'x',
        sheet: 'S',
        binding: { startRow: 0, startCol: 0, endRow: 1, endCol: 1, hasHeaderRow: true },
        columns: [],
        template: 'data-table',
      }),
    ).rejects.toThrow('</script');
  });
});

describe('production mode: Vertex AI on GCP', () => {
  it('defaults to the cheapest Gemini model (user ruling 2026-10-21; bumped 2026-10-22 after 2.5-flash-lite retirement)', () => {
    expect(VERTEX_DEFAULT_MODEL).toBe('gemini-3.1-flash-lite');
    const b = new VertexAiCodeGenBackend({
      project: 'demo-proj',
      getAccessToken: async () => 'tok',
    });
    expect(b.modelId).toBe('gemini-3.1-flash-lite');
  });

  it('defaults to the global location — the default model serves only there (leg-7 probe 2026-10-22)', () => {
    expect(VERTEX_DEFAULT_LOCATION).toBe('global');
    // The global endpoint is the bare host; regional locations are prefixed.
    expect(vertexAiHost('global')).toBe('aiplatform.googleapis.com');
    expect(vertexAiHost('us-central1')).toBe('us-central1-aiplatform.googleapis.com');
    expect(vertexAiHost('europe-west1')).toBe('europe-west1-aiplatform.googleapis.com');
  });

  it('default-location requests address the global host with locations/global in the path', async () => {
    const calls: { url: string }[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push({ url });
      return {
        ok: true,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: '```javascript\nfunction App() { return null; }\n```' }] } },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const b = new VertexAiCodeGenBackend({
      project: 'demo-proj',
      getAccessToken: async () => 'tok',
      fetchImpl,
    });
    await b.generateCode('make an app');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/demo-proj/' +
        'locations/global/publishers/google/models/gemini-3.1-flash-lite:generateContent',
    );
  });

  it('model id is configurable', () => {
    const b = new VertexAiCodeGenBackend({
      project: 'demo-proj',
      model: 'gemini-2.5-pro',
      getAccessToken: async () => 'tok',
    });
    expect(b.modelId).toBe('gemini-2.5-pro');
  });

  it('fails with a clear error when credentials are absent', async () => {
    const b = new VertexAiCodeGenBackend({
      project: 'demo-proj',
      getAccessToken: async () => null,
    });
    await expect(b.generateCode('hello')).rejects.toThrow(
      /Vertex AI credentials are not configured/,
    );
  });

  it('fails clearly when the token resolver throws', async () => {
    const b = new VertexAiCodeGenBackend({
      project: 'demo-proj',
      getAccessToken: async () => {
        throw new Error('vault denied');
      },
    });
    await expect(b.generateCode('hello')).rejects.toThrow(
      /Vertex AI credentials are not configured/,
    );
  });

  it('calls the Vertex AI endpoint with the bearer token and extracts fenced code', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: '```javascript\nfunction App() { return null; }\n```' }] } },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const b = new VertexAiCodeGenBackend({
      project: 'my-proj',
      location: 'europe-west1',
      getAccessToken: async () => 'secret-token',
      fetchImpl,
    });
    const code = await b.generateCode('make an app');
    expect(code).toBe('function App() { return null; }');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('europe-west1-aiplatform.googleapis.com');
    expect(calls[0].url).toContain('/projects/my-proj/locations/europe-west1/');
    expect(calls[0].url).toContain('gemini-3.1-flash-lite:generateContent');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.contents[0].parts[0].text).toBe('make an app');
  });

  it('requests the full codegen output budget so dashboard apps are not cut mid-string', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: '```javascript\nfunction App() { return null; }\n```' }] } },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const b = new VertexAiCodeGenBackend({
      project: 'p',
      getAccessToken: async () => 't',
      fetchImpl,
    });
    await b.generateCode('make an app');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.generationConfig.maxOutputTokens).toBe(CODEGEN_MAX_OUTPUT_TOKENS);
    expect(CODEGEN_MAX_OUTPUT_TOKENS).toBeGreaterThan(8192);
  });

  it('openai-compatible codegen requests the full output budget in max_tokens', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'function App() { return null; }' } }],
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const b = new OpenAiCompatibleCodeGenBackend({
      baseUrl: 'https://models.test/v1',
      model: 'test-model',
      getApiKey: async () => 'k',
      fetchImpl,
    });
    const code = await b.generateCode('make an app');
    expect(code).toBe('function App() { return null; }');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.max_tokens).toBe(CODEGEN_MAX_OUTPUT_TOKENS);
  });

  it('rejects model output with no function App()', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'here is some prose, no code' }] } }],
      }),
    }) as unknown as Response) as typeof fetch;
    const b = new VertexAiCodeGenBackend({
      project: 'p',
      getAccessToken: async () => 't',
      fetchImpl,
    });
    await expect(b.generateCode('x')).rejects.toThrow(/no function App\(\)/);
  });

  it('surfaces Vertex AI HTTP errors', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid token',
    }) as unknown as Response) as typeof fetch;
    const b = new VertexAiCodeGenBackend({
      project: 'p',
      getAccessToken: async () => 'bad',
      fetchImpl,
    });
    await expect(b.generateCode('x')).rejects.toThrow(/Vertex AI error 401/);
  });

  it('requires a project id', () => {
    expect(
      () => new VertexAiCodeGenBackend({ project: '', getAccessToken: async () => 't' }),
    ).toThrow(/project id/);
  });
});

describe('mode safety', () => {
  it('resolveAppGenerator wires the right backend per mode', () => {
    const test = resolveAppGenerator('test', { project: 'p' });
    expect(test.name).toBe('llm-test-divert');
    const prod = resolveAppGenerator('vertex', { project: 'p' });
    expect(prod.name).toBe('llm-vertex-ai');
  });

  it('production never diverts to the test backend', () => {
    const prod = resolveAppGenerator('vertex', { project: 'p' }) as LlmAppGenerator;
    expect(prod.testBackend).toBeNull();
    expect(prod.mode).toBe('vertex');
  });

  it('extractCode pulls fenced code', () => {
    expect(extractCode('```js\nvar x = 1;\n```')).toBe('var x = 1;');
    expect(extractCode('no fences')).toBe('no fences');
  });
});

describe('#144 (host-context contract): never destructure narrow-API names from React', () => {
  it('the prompt forbids ALL React destructuring and App parameters', () => {
    const gen = new LlmAppGenerator({ backend: new TestCodeGenBackend() });
    const prompt = gen.buildPrompt({
      prompt: 'build an app',
      sheet: 'Sheet1',
      binding: { startRow: 0, startCol: 0, endRow: 2, endCol: 1, hasHeaderRow: true },
      columns: [{ name: 'Name', type: 'text', index: 0 }],
      template: 'data-table',
    });
    expect(prompt).toContain('NEVER declare parameters on App and NEVER destructure anything from React');
    expect(prompt).toContain('function App()` with NO parameters');
  });

  it('sanitizeReactDestructure strips every bare narrow-API name', () => {
    // The whole destructure goes when every name is narrow-API; the rest survives.
    const all = sanitizeReactDestructure(
      'function App() {\n  const { useState, useEffect, useRef, h } = React;\n  return h("div", null, "x");\n}',
    );
    expect(all).not.toContain('= React');
    expect(all).toContain('return h("div", null, "x");');
    expect(
      sanitizeReactDestructure('function App() {\n  const { h, useState } = React;\n  return null;\n}'),
    ).not.toContain('= React');
    // A non-narrow name in the mix survives; narrow names drop out.
    expect(
      sanitizeReactDestructure('function App() {\n  const { useState, custom } = React;\n  return null;\n}'),
    ).toContain('const { custom } = React;');
    // Lone `h` destructure: the whole statement goes, the rest survives.
    const lone = sanitizeReactDestructure(
      'function App() {\n  const { h } = React;\n  return h("div", null, "x");\n}',
    );
    expect(lone).not.toContain('= React');
    expect(lone).toContain('return h("div", null, "x");');
    // Renamed bindings and other objects are untouched.
    expect(sanitizeReactDestructure('const { h: el } = React;')).toContain('h: el');
    expect(sanitizeReactDestructure('const { a, h } = foo;')).toContain('{ a, h } = foo');
  });

  it('generate() normalizes a model reply carrying the old shape', async () => {
    const backend = new TestCodeGenBackend();
    // Override the canned reply with the exact crashing shape.
    backend.generateCode = async () =>
      'function App() {\n  const { useState, useEffect, useRef, h } = React;\n  const [v] = useState("hi");\n  return h("div", { className: "card" }, v);\n}';
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate({
      prompt: 'build an app',
      sheet: 'Sheet1',
      binding: { startRow: 0, startCol: 0, endRow: 2, endCol: 1, hasHeaderRow: true },
      columns: [{ name: 'Name', type: 'text', index: 0 }],
      template: 'data-table',
    });
    expect(out.source).not.toContain('= React');
    expect(out.source).toContain('return h("div", { className: "card" }, v);');
  });
});

describe('host-context JSX contract (#147)', () => {
  function promptFor(): string {
    const gen = new LlmAppGenerator({ backend: new TestCodeGenBackend() });
    return gen.buildPrompt({
      prompt: 'build an app',
      sheet: 'Sheet1',
      binding: { startRow: 0, startCol: 0, endRow: 2, endCol: 1, hasHeaderRow: true },
      columns: [{ name: 'Name', type: 'text', index: 0 }],
      template: 'data-table',
    });
  }

  it('the prompt allows JSX and forbids TypeScript', () => {
    const prompt = promptFor();
    expect(prompt).toContain('JSX allowed');
    expect(prompt).toContain('Do NOT write TypeScript');
    expect(prompt).not.toContain('No JSX');
  });

  it('normalizeAppSource strips App params AND the #147 destructure', () => {
    const bad =
      'function App(React, h, useState, useEffect, useRef, mcp) {\n  const { useState, useEffect } = React;\n  const [v] = useState(0);\n  return <div>{v}</div>;\n}';
    const out = normalizeAppSource(bad);
    expect(out).toContain('function App() {');
    expect(out).not.toContain('function App(React');
    expect(out).not.toContain('= React');
    expect(out).toContain('const [v] = useState(0);');
    expect(out).toContain('return <div>{v}</div>;');
  });

  it('normalizeAppSource leaves a contract-shaped source unchanged', () => {
    const good =
      'function App() {\n  const [v] = useState(0);\n  return <div className="card">{v}</div>;\n}';
    expect(normalizeAppSource(good)).toBe(good);
  });

  it('generate() normalizes the #147 shape end to end', async () => {
    const backend = new TestCodeGenBackend();
    backend.generateCode = async () =>
      'function App(React, h, useState, useEffect, useRef, mcp) {\n  const { useState, useEffect } = React;\n  return <div className="card">hi</div>;\n}';
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate({
      prompt: 'build an app',
      sheet: 'Sheet1',
      binding: { startRow: 0, startCol: 0, endRow: 2, endCol: 1, hasHeaderRow: true },
      columns: [{ name: 'Name', type: 'text', index: 0 }],
      template: 'data-table',
    });
    expect(out.source).toContain('function App() {');
    expect(out.source).not.toContain('= React');
    expect(out.source).toContain('return <div className="card">hi</div>;');
  });
});

describe('#154: code-gen prompt carries real values + totals rules', () => {
  // Income-shaped matrix: years across row 5 (0-based), measures down rows.
  const INCOME_VALUES = [
    ['Income Statement', null, null],
    [null, null, null],
    [null, null, null],
    [null, null, null],
    [null, null, null],
    ['Income Statement', 2012, 2013],
    ['Revenue', 102007, 118086],
    ['Less Cost of Goods Sold', 39023, 48004],
    ['Gross Profit', 62984, 70082],
  ];

  function promptFor(values?: unknown[][]): string {
    const gen = new LlmAppGenerator({ backend: new TestCodeGenBackend() });
    return gen.buildPrompt({
      prompt: 'build a KPI app with Total Revenue, Gross Profit, Net Income',
      sheet: 'Income',
      binding: { startRow: 0, startCol: 0, endRow: 8, endCol: 2, hasHeaderRow: true },
      columns: [{ name: 'Income Statement', type: 'text', index: 0 }],
      template: 'data-table',
      ...(values ? { values } : {}),
    });
  }

  it('includes the DATA VALUES section with the true rows and numbers', () => {
    const prompt = promptFor(INCOME_VALUES);
    expect(prompt).toContain('DATA VALUES');
    expect(prompt).toContain('row 6: "Revenue" | 102007 | 118086');
    expect(prompt).toContain('row 8: "Gross Profit" | 62984 | 70082');
    expect(prompt).toContain('row 5: "Income Statement" | 2012 | 2013');
  });

  it('states the totals + exact-label + never-zero rules', () => {
    const prompt = promptFor(INCOME_VALUES);
    expect(prompt).toContain('SUM across the year/value columns');
    expect(prompt).toContain('NEVER present a single column');
    expect(prompt).toContain('EXACT row label');
    expect(prompt).toContain('NEVER show 0');
    expect(prompt).toContain('NEVER invent');
  });

  it('omits the DATA VALUES section when no values are provided', () => {
    const prompt = promptFor();
    // The section header (with its range note) must be absent; the phrase
    // still appears in the contract rules, which reference the section.
    expect(prompt).not.toContain('DATA VALUES (the bound sheet range');
    // The rules still travel (they also guard live-read code).
    expect(prompt).toContain('SUM across the year/value columns');
  });

  it('formatDataValues caps rows/cols and says so', () => {
    const wide = Array.from({ length: 105 }, (_, r) =>
      Array.from({ length: 35 }, (_, c) => r * 100 + c),
    );
    const out = formatDataValues(wide);
    expect(out).not.toBeNull();
    expect(out!).toContain('row 99:');
    expect(out!).not.toContain('row 100:');
    expect(out!).toContain('truncated to the first 100 rows / 30 columns');
    expect(formatDataValues([])).toBeNull();
    expect(formatDataValues(undefined)).toBeNull();
  });

  it('generate() passes values through to the captured code prompt', async () => {
    const backend = new TestCodeGenBackend();
    const gen = new LlmAppGenerator({ backend });
    await gen.generate({
      prompt: 'build a KPI app',
      sheet: 'Income',
      binding: { startRow: 0, startCol: 0, endRow: 8, endCol: 2, hasHeaderRow: true },
      columns: [{ name: 'Income Statement', type: 'text', index: 0 }],
      template: 'data-table',
      values: INCOME_VALUES,
    });
    expect(backend.capturedPrompts).toHaveLength(1);
    expect(backend.capturedPrompts[0]).toContain('"Revenue" | 102007 | 118086');
  });
});
