/**
 * AI-generated app artifact tests (AI-GENERATED APP PATTERN spec).
 *
 * - ArtifactSpec validation / migration.
 * - Persistent store round-trip (service metadata store).
 * - Bridge protocol validation (allow-list, malformed messages).
 * - Live-binding round-trip through ArtifactBridgeHost with a mock MCP
 *   client: app -> sheet writes land in real time; sheet -> app events
 *   are forwarded into the iframe.
 * - Intent routing (canonical agent/intentRouter: app vs data-analysis vs
 *   conversation vs disambiguate) and the template generator (all three
 *   templates define App(), use mcp.call, and carry the subscription hook).
 * - generateAndSaveArtifact end-to-end with a mock MCP client.
 * - AgentRuntime.createAppArtifact against a real MCP server.
 * - Generated app execution: the data-table template source runs against
 *   the real MCP server with a minimal React shim (no direct hydration).
 */
import { describe, expect, it } from 'vitest';
import { createServer } from '@icecream-sheets/mcp-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EngineHost } from '@icecream-sheets/engine';
import {
  ARTIFACT_SPEC_VERSION,
  ArtifactBridgeHost,
  LlmAppGenerator,
  TemplateAppGenerator,
  TestCodeGenBackend,
  createArtifactStore,
  detectTemplate,
  generateAndSaveArtifact,
  inferSchema,
  isBridgeMessage,
  memoryPersistence,
  migrateArtifactSpec,
  newArtifactId,
  routePrompt,
  validateArtifactSpec,
  validateBridgeMessage,
  ALLOWED_BRIDGE_TOOLS,
  FORBIDDEN_BRIDGE_TOOLS,
  type ArtifactSpec,
  type McpCallFn,
  type McpEvent,
} from '../src/index.js';
import { AgentRuntime } from '../src/agent/runtime.js';

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Mock MCP client (in-memory sheet + subscriptions)
// ---------------------------------------------------------------------------

interface MockMcp {
  callTool: McpCallFn;
  calls: { tool: string; args: Record<string, unknown> }[];
  /** Simulate an external sheet change (fires into live subscriptions). */
  emitExternalChange: (detail?: unknown) => void;
  readCell: (sheet: string, row: number, col: number) => unknown;
}

function makeMockMcp(seed: unknown[][] = []): MockMcp {
  const cells = new Map<string, unknown>();
  const put = (sheet: string, row: number, col: number, value: unknown): void => {
    cells.set(`${sheet}:${row}:${col}`, value);
  };
  seed.forEach((row, r) => row.forEach((v, c) => put('Sheet1', r, c, v)));
  const subs = new Map<string, { events: string[]; sheet?: string; queue: McpEvent[] }>();
  let subSeq = 1;
  let evSeq = 1;
  const calls: MockMcp['calls'] = [];

  const emit = (type: string, detail: unknown): void => {
    for (const s of subs.values()) {
      if (s.events.includes(type)) s.queue.push({ seq: evSeq++, ts: Date.now(), type, detail });
    }
  };

  const callTool: McpCallFn = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'read_cells') {
      const { sheet, startRow, startCol, endRow, endCol } = args as {
        sheet: string; startRow: number; startCol: number; endRow: number; endCol: number;
      };
      const out: unknown[][] = [];
      for (let r = startRow; r <= endRow; r++) {
        const row: unknown[] = [];
        for (let c = startCol; c <= endCol; c++) row.push(cells.get(`${sheet}:${r}:${c}`) ?? null);
        out.push(row);
      }
      return { cells: out };
    }
    if (tool === 'write_cells') {
      const list = (args.cells ?? []) as { sheet: string; row: number; col: number; value: unknown }[];
      for (const cell of list) put(cell.sheet, cell.row, cell.col, cell.value);
      emit('cells_changed', { count: list.length });
      return { written: list.length };
    }
    if (tool === 'set_formulas') {
      const list = (args.formulas ?? []) as { sheet: string; row: number; col: number; formula: string }[];
      for (const f of list) put(f.sheet, f.row, f.col, f.formula);
      emit('cells_changed', { count: list.length });
      return { set: list.length };
    }
    if (tool === 'get_results') {
      const sheet = (args.sheet as string) ?? 'Sheet1';
      let maxR = -1;
      let maxC = -1;
      for (const k of cells.keys()) {
        const [s, r, c] = k.split(':');
        if (s !== sheet) continue;
        maxR = Math.max(maxR, Number(r));
        maxC = Math.max(maxC, Number(c));
      }
      const out: unknown[][] = [];
      for (let r = 0; r <= maxR; r++) {
        const row: unknown[] = [];
        for (let c = 0; c <= maxC; c++) row.push(cells.get(`${sheet}:${r}:${c}`) ?? null);
        out.push(row);
      }
      return { cells: out };
    }
    if (tool === 'subscribe') {
      const id = `sub_${subSeq++}`;
      subs.set(id, {
        events: (args.events as string[]) ?? [],
        sheet: args.sheet as string | undefined,
        queue: [],
      });
      return { subscriptionId: id };
    }
    if (tool === 'poll_events') {
      const s = subs.get(args.subscriptionId as string);
      const events = s ? s.queue.splice(0, s.queue.length) : [];
      return { events };
    }
    if (tool === 'unsubscribe') {
      subs.delete(args.subscriptionId as string);
      return {};
    }
    if (tool === 'recalculate') return { recalculated: true };
    throw new Error(`mock: unexpected tool ${tool}`);
  };

  return {
    callTool,
    calls,
    emitExternalChange: (detail: unknown = {}) => emit('cells_changed', detail),
    readCell: (sheet, row, col) => cells.get(`${sheet}:${row}:${col}`) ?? null,
  };
}

const SEED = [
  ['Time', 'Event'],
  ['09:00', 'Standup'],
  ['10:30', 'Review'],
];

// ---------------------------------------------------------------------------
// Spec validation / migration
// ---------------------------------------------------------------------------

function validSpec(): ArtifactSpec {
  return {
    id: newArtifactId(),
    version: ARTIFACT_SPEC_VERSION,
    kind: 'react-app',
    name: 'Schedule table',
    prompt: 'show me the schedule times, sortable',
    template: 'data-table',
    source: 'function App() { return null; }',
    binding: {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 1,
      hasHeaderRow: true,
      columns: [
        { name: 'Time', type: 'text', index: 0 },
        { name: 'Event', type: 'text', index: 1 },
      ],
    },
    principal: 'test-user',
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe('ArtifactSpec', () => {
  it('validates a well-formed spec', () => {
    const v = validateArtifactSpec(validSpec());
    expect(v.ok).toBe(true);
  });

  it('rejects bad versions, missing source, and non-App sources', () => {
    expect(validateArtifactSpec({ ...validSpec(), version: 999 }).ok).toBe(false);
    expect(validateArtifactSpec({ ...validSpec(), source: '' }).ok).toBe(false);
    const noApp = validateArtifactSpec({ ...validSpec(), source: 'var x = 1;' });
    expect(noApp.ok).toBe(false);
    if (!noApp.ok) expect(noApp.errors.join(' ')).toContain('function App()');
  });

  it('rejects inverted ranges and bad column types', () => {
    const bad = validSpec();
    bad.binding = { ...bad.binding, startRow: 5, endRow: 2 };
    expect(validateArtifactSpec(bad).ok).toBe(false);
    const badCol = validSpec();
    badCol.binding = {
      ...badCol.binding,
      columns: [{ name: 'X', type: 'fancy' as never, index: 0 }],
    };
    expect(validateArtifactSpec(badCol).ok).toBe(false);
  });

  it('migrates a v0 draft with defaults', () => {
    const migrated = migrateArtifactSpec({ name: 'Old', source: 'function App() {}' });
    expect(migrated.version).toBe(ARTIFACT_SPEC_VERSION);
    expect(migrated.kind).toBe('react-app');
    expect(migrated.binding.sheet).toBe('Sheet1');
    expect(validateArtifactSpec(migrated).ok).toBe(true);
  });

  it('newArtifactId is unique', () => {
    expect(newArtifactId()).not.toBe(newArtifactId());
  });
});

// ---------------------------------------------------------------------------
// Persistent store
// ---------------------------------------------------------------------------

describe('artifact store', () => {
  it('round-trips through the service metadata store (survives reload)', () => {
    const persistence = memoryPersistence();
    const store = createArtifactStore(persistence);
    const spec = validSpec();
    store.add(spec);
    expect(store.all()).toHaveLength(1);

    // Simulate a new session: fresh store over the same persistence.
    const reopened = createArtifactStore(persistence);
    const all = reopened.all();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(spec.id);
    expect(all[0].source).toBe(spec.source);
  });

  it('drops corrupt entries instead of failing to load', () => {
    const persistence = memoryPersistence();
    persistence.save(
      'icecream-sheets.artifacts.v1',
      JSON.stringify({ version: 1, artifacts: [{ nope: true }, validSpec()] }),
    );
    const store = createArtifactStore(persistence);
    expect(store.all()).toHaveLength(1);
  });

  it('supports remove()', () => {
    const store = createArtifactStore(memoryPersistence());
    const spec = validSpec();
    store.add(spec);
    expect(store.remove((a) => a.id === spec.id)).toBe(1);
    expect(store.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bridge protocol
// ---------------------------------------------------------------------------

describe('bridge protocol validation', () => {
  const call = (tool: string, extra: Record<string, unknown> = {}) => ({
    __icecream_bridge: 1,
    id: 'c1',
    kind: 'call',
    tool,
    args: {},
    ...extra,
  });

  it('accepts every allowed tool and rejects the forbidden ones', () => {
    for (const tool of ALLOWED_BRIDGE_TOOLS) {
      expect(validateBridgeMessage(call(tool)).ok, tool).toBe(true);
    }
    for (const tool of FORBIDDEN_BRIDGE_TOOLS) {
      const v = validateBridgeMessage(call(tool));
      expect(v.ok, tool).toBe(false);
      expect(v.error).toContain('not available to generated apps');
    }
  });

  it('rejects malformed messages', () => {
    expect(validateBridgeMessage(null).ok).toBe(false);
    expect(validateBridgeMessage({}).ok).toBe(false);
    expect(validateBridgeMessage(call('read_cells', { id: '' })).ok).toBe(false);
    expect(validateBridgeMessage({ ...call('read_cells'), args: 'nope' }).ok).toBe(false);
    expect(
      validateBridgeMessage({ __icecream_bridge: 1, kind: 'subscribe', subKey: '', events: ['x'] }).ok,
    ).toBe(false);
    expect(
      validateBridgeMessage({ __icecream_bridge: 1, kind: 'subscribe', subKey: 's', events: [] }).ok,
    ).toBe(false);
    expect(
      validateBridgeMessage({ __icecream_bridge: 1, kind: 'whatever' }).ok,
    ).toBe(false);
  });

  it('isBridgeMessage recognizes the envelope', () => {
    expect(isBridgeMessage(call('read_cells'))).toBe(true);
    expect(isBridgeMessage({ kind: 'call' })).toBe(false);
  });
});

describe('ArtifactBridgeHost live binding (mock MCP client)', () => {
  it('round-trips app -> sheet writes and sheet -> app events', async () => {
    const mock = makeMockMcp(SEED);
    const posted: unknown[] = [];
    const host = new ArtifactBridgeHost({
      callTool: mock.callTool,
      postToFrame: (m) => posted.push(m),
      pollIntervalMs: 15,
      principal: 'test-user',
    });
    try {
      // 1. App writes a cell through the bridge (app -> sheet, real time).
      host.handleFrameMessage({
        __icecream_bridge: 1,
        id: 'w1',
        kind: 'call',
        tool: 'write_cells',
        args: { cells: [{ sheet: 'Sheet1', row: 3, col: 0, value: '11:00' }] },
      });
      await tick(30);
      const result = posted.find(
        (m) => (m as { kind: string }).kind === 'result' && (m as { id: string }).id === 'w1',
      ) as { ok: boolean; data?: { written?: number } };
      expect(result.ok).toBe(true);
      expect(result.data?.written).toBe(1);
      expect(mock.readCell('Sheet1', 3, 0)).toBe('11:00');

      // 2. App subscribes; an external sheet change is forwarded into the iframe.
      host.handleFrameMessage({
        __icecream_bridge: 1,
        kind: 'subscribe',
        subKey: 'app-sub',
        events: ['cells_changed'],
        sheet: 'Sheet1',
      });
      await tick(30);
      expect(host.bindingCount()).toBe(1);
      mock.emitExternalChange({ range: 'Sheet1!A1' });
      await tick(60);
      const evt = posted.find(
        (m) => (m as { kind: string }).kind === 'event',
      ) as { subKey: string; events: McpEvent[] } | undefined;
      expect(evt).toBeDefined();
      expect(evt!.subKey).toBe('app-sub');
      expect(evt!.events.length).toBeGreaterThan(0);
      expect(evt!.events[0].type).toBe('cells_changed');

      // 3. Unsubscribe tears down the MCP subscription.
      host.handleFrameMessage({ __icecream_bridge: 1, kind: 'unsubscribe', subKey: 'app-sub' });
      await tick(30);
      expect(host.bindingCount()).toBe(0);
      expect(mock.calls.some((c) => c.tool === 'unsubscribe')).toBe(true);
    } finally {
      host.dispose();
    }
  });

  it('shares one MCP subscription across subKeys and refcounts', async () => {
    const mock = makeMockMcp(SEED);
    const host = new ArtifactBridgeHost({
      callTool: mock.callTool,
      postToFrame: () => undefined,
      pollIntervalMs: 15,
    });
    try {
      const sub = (k: string): void =>
        host.handleFrameMessage({
          __icecream_bridge: 1,
          kind: 'subscribe',
          subKey: k,
          events: ['cells_changed'],
          sheet: 'Sheet1',
        });
      sub('a');
      sub('b');
      await tick(30);
      expect(host.bindingCount()).toBe(1);
      expect(mock.calls.filter((c) => c.tool === 'subscribe')).toHaveLength(1);
      host.handleFrameMessage({ __icecream_bridge: 1, kind: 'unsubscribe', subKey: 'a' });
      await tick(20);
      expect(host.bindingCount()).toBe(1);
      host.handleFrameMessage({ __icecream_bridge: 1, kind: 'unsubscribe', subKey: 'b' });
      await tick(20);
      expect(host.bindingCount()).toBe(0);
    } finally {
      host.dispose();
    }
  });

  it('posts an error result for forbidden tools and malformed calls', async () => {
    const mock = makeMockMcp(SEED);
    const posted: { kind: string; id?: string; ok?: boolean; error?: string }[] = [];
    const host = new ArtifactBridgeHost({
      callTool: mock.callTool,
      postToFrame: (m) => posted.push(m as never),
      pollIntervalMs: 1000,
    });
    try {
      host.handleFrameMessage({
        __icecream_bridge: 1,
        id: 'bad1',
        kind: 'call',
        tool: 'memory_load',
        args: {},
      });
      host.handleFrameMessage({
        __icecream_bridge: 1,
        id: 'bad2',
        kind: 'call',
        tool: 'subscribe',
        args: {},
      });
      await tick(30);
      const r1 = posted.find((m) => m.id === 'bad1');
      const r2 = posted.find((m) => m.id === 'bad2');
      expect(r1?.ok).toBe(false);
      expect(r1?.error).toContain('not available');
      expect(r2?.ok).toBe(false);
      expect(r2?.error).toContain('subscription protocol');
      // The forbidden tool never reached the MCP client.
      expect(mock.calls.some((c) => c.tool === 'memory_load')).toBe(false);
    } finally {
      host.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Intent routing + templates
// ---------------------------------------------------------------------------

describe('prompt intent routing (canonical agent/intentRouter)', () => {
  it('routes app prompts to app generation', () => {
    expect(routePrompt('build me a sortable app for the schedule').route).toBe('app');
    expect(routePrompt('build me a data entry form for expenses').route).toBe('app');
    expect(routePrompt('make me a dashboard for sales').route).toBe('app');
  });

  it('routes analysis/visualization prompts to the data-analysis component', () => {
    expect(routePrompt('analyze sales trends').route).toBe('analysis');
    expect(routePrompt('chart of sales by month').route).toBe('analysis');
    expect(routePrompt('forecast next quarter').route).toBe('analysis');
  });

  it('marks ambiguous prompts for disambiguation', () => {
    const r = routePrompt('make a tool to show this');
    expect(r.route).toBe('disambiguate');
    if (r.route === 'disambiguate') {
      expect(r.question.length).toBeGreaterThan(0);
      expect(r.options.length).toBeGreaterThan(0);
    }
  });

  it('sends plain chat to conversation', () => {
    expect(routePrompt('hello').route).toBe('conversation');
  });

  it('picks templates from the prompt', () => {
    expect(detectTemplate('data entry form')).toBe('data-entry-form');
    expect(detectTemplate('sales dashboard with charts')).toBe('chart-dashboard');
    expect(detectTemplate('show me the schedule times, sortable')).toBe('data-table');
  });
});

describe('TemplateAppGenerator', () => {
  const inputFor = (template: 'data-table' | 'chart-dashboard' | 'data-entry-form') => ({
    prompt: 'test',
    sheet: 'Sheet1',
    binding: { startRow: 0, startCol: 0, endRow: 2, endCol: 1, hasHeaderRow: true },
    columns: [
      { name: 'Time', type: 'text' as const, index: 0 },
      { name: 'Amount', type: 'numeric' as const, index: 1 },
    ],
    template,
  });

  it('generates valid App() sources with MCP access and the live subscription hook', async () => {
    const gen = new TemplateAppGenerator();
    for (const template of ['data-table', 'chart-dashboard', 'data-entry-form'] as const) {
      const out = await gen.generate(inputFor(template));
      expect(out.template).toBe(template);
      expect(out.source).toContain('function App()');
      expect(out.source).toContain('mcp.call');
      // Every template carries the live-binding subscription hook.
      expect(out.source, template).toContain("mcp.subscribe(['cells_changed']");
      expect(out.source).not.toContain('</script');
      // The source must parse as JavaScript.
      expect(() => new Function('React', 'h', 'useState', 'useEffect', 'useRef', 'mcp', out.source + '\n;return App;')).not.toThrow();
    }
  });

  it('data-table template writes through write_cells; form template appends rows', async () => {
    const gen = new TemplateAppGenerator();
    const table = await gen.generate(inputFor('data-table'));
    expect(table.source).toContain('write_cells');
    const form = await gen.generate(inputFor('data-entry-form'));
    expect(form.source).toContain('write_cells');
    expect(form.source).toContain('Amount');
  });
});

describe('inferSchema', () => {
  it('derives bindings, headers and column types from a cell matrix', () => {
    const schema = inferSchema([
      ['Name', 'Amount', 'Paid', 'Day'],
      ['a', 10, true, '2026-01-05'],
      ['b', 20, false, '2026-02-06'],
    ]);
    expect(schema.binding).toEqual({
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 3,
      hasHeaderRow: true,
    });
    expect(schema.columns.map((c) => c.type)).toEqual(['text', 'numeric', 'boolean', 'date']);
    expect(schema.columns.map((c) => c.name)).toEqual(['Name', 'Amount', 'Paid', 'Day']);
  });
});

// ---------------------------------------------------------------------------
// Generation flow
// ---------------------------------------------------------------------------

describe('generateAndSaveArtifact', () => {
  const APP_PROMPT = 'build me a sortable app for the schedule';

  it('builds, validates and persists an app artifact end-to-end', async () => {
    const mock = makeMockMcp(SEED);
    const store = createArtifactStore(memoryPersistence());
    const result = await generateAndSaveArtifact(
      { prompt: APP_PROMPT, sheet: 'Sheet1' },
      { callTool: mock.callTool, store, principal: 'test-user' },
    );
    expect(result.routed).toBe('app');
    if (result.routed !== 'app') throw new Error('unreachable');
    expect(result.spec.template).toBe('data-table');
    expect(result.spec.binding.sheet).toBe('Sheet1');
    expect(result.spec.binding.columns.map((c) => c.name)).toEqual(['Time', 'Event']);
    expect(validateArtifactSpec(result.spec).ok).toBe(true);
    // Persisted: re-openable from the store.
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].id).toBe(result.spec.id);
  });

  it('routes analysis prompts away from app generation', async () => {
    const mock = makeMockMcp(SEED);
    const store = createArtifactStore(memoryPersistence());
    const result = await generateAndSaveArtifact(
      { prompt: 'analyze the schedule trends', sheet: 'Sheet1' },
      { callTool: mock.callTool, store },
    );
    expect(result.routed).toBe('analysis');
    expect(store.all()).toHaveLength(0);
  });

  it('returns not-artifact for plain conversation prompts', async () => {
    const mock = makeMockMcp(SEED);
    const store = createArtifactStore(memoryPersistence());
    const result = await generateAndSaveArtifact(
      { prompt: 'hello', sheet: 'Sheet1' },
      { callTool: mock.callTool, store },
    );
    expect(result.routed).toBe('not-artifact');
    expect(store.all()).toHaveLength(0);
  });

  it('returns unknown for ambiguous prompts unless a template is forced', async () => {
    const mock = makeMockMcp(SEED);
    const store = createArtifactStore(memoryPersistence());
    const unsure = await generateAndSaveArtifact(
      { prompt: 'make a tool to show this', sheet: 'Sheet1' },
      { callTool: mock.callTool, store },
    );
    expect(unsure.routed).toBe('unknown');
    if (unsure.routed === 'unknown') {
      expect(unsure.question.length).toBeGreaterThan(0);
      expect(unsure.options.length).toBeGreaterThan(0);
    }
    const forced = await generateAndSaveArtifact(
      { prompt: 'make a tool to show this', sheet: 'Sheet1' },
      { callTool: mock.callTool, store, template: 'data-table' },
    );
    expect(forced.routed).toBe('app');
  });

  it('W3: hands back an explicit native-chart request instead of building an app (no dead end)', async () => {
    const mock = makeMockMcp(SEED);
    const store = createArtifactStore(memoryPersistence());
    const prompt =
      'Create a column chart of revenue by region in the Sales sheet — a native chart in the sheet itself, not an image in the chat.';
    const result = await generateAndSaveArtifact(
      { prompt, sheet: 'Sheet1' },
      { callTool: mock.callTool, store },
    );
    expect(result.routed).toBe('not-artifact');
    if (result.routed === 'not-artifact') {
      expect(result.reason).toContain('native-chart');
      expect(result.reason).toContain('chart in the sheet');
    }
    // Nothing was built or persisted: the request is handed back, not
    // silently "satisfied" by an app the user never asked for.
    expect(store.all()).toHaveLength(0);
  });

  it('W3: the hand-back holds even when a template is forced (the disambiguation "Build an app" path)', async () => {
    const mock = makeMockMcp(SEED);
    const store = createArtifactStore(memoryPersistence());
    const result = await generateAndSaveArtifact(
      { prompt: 'Add a column chart of Month vs Revenue to the Sales sheet.', sheet: 'Sheet1' },
      { callTool: mock.callTool, store, template: 'chart-dashboard' },
    );
    expect(result.routed).toBe('not-artifact');
    expect(store.all()).toHaveLength(0);
  });

  it('fails cleanly on an empty sheet', async () => {
    const mock = makeMockMcp([]);
    const store = createArtifactStore(memoryPersistence());
    await expect(
      generateAndSaveArtifact(
        { prompt: APP_PROMPT, sheet: 'Sheet1' },
        { callTool: mock.callTool, store },
      ),
    ).rejects.toThrow('empty');
  });
});

// ---------------------------------------------------------------------------
// AgentRuntime integration
// ---------------------------------------------------------------------------

  it('#154: generateAndSaveArtifact passes sheet values to the code-gen prompt', async () => {
    const mock = makeMockMcp(SEED);
    const store = createArtifactStore(memoryPersistence());
    const backend = new TestCodeGenBackend();
    const result = await generateAndSaveArtifact(
      { prompt: 'build me a sortable app for the schedule', sheet: 'Sheet1' },
      {
        callTool: mock.callTool,
        store,
        principal: 'test-user',
        generator: new LlmAppGenerator({ backend }),
      },
    );
    expect(result.routed).toBe('app');
    // The code-gen model must see the real values, not just column names:
    // SEED rows flow from get_results into the captured code prompt.
    expect(backend.capturedPrompts).toHaveLength(1);
    expect(backend.capturedPrompts[0]).toContain('DATA VALUES');
    expect(backend.capturedPrompts[0]).toContain('"09:00" | "Standup"');
    expect(backend.capturedPrompts[0]).toContain('"10:30" | "Review"');
  });

describe('AgentRuntime.createAppArtifact', () => {
  it('generates an artifact through the real MCP server and audit-logs it', async () => {
    const host = new EngineHost();
    const runtime = new AgentRuntime({
      server: createServer(host),
      principal: 'test-user',
      userId: 'test-user',
    });
    try {
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'Time' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'Event' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: '09:00' });
      const store = createArtifactStore(memoryPersistence());
      const result = await runtime.createAppArtifact('t1', 'build me a sortable app for the schedule', {
        store,
        sheet: 'Sheet1',
      });
      expect(result.routed).toBe('app');
      if (result.routed !== 'app') throw new Error('unreachable');
      expect(result.spec.principal).toBe('test-user');
      expect(store.all()).toHaveLength(1);
      const audit = runtime.getAuditLog('t1');
      expect(audit.some((e) => e.tool === 'create_app_artifact' && e.ok)).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('without a sheet, binds the workbook first sheet — never a hardcoded Sheet1 (#135)', async () => {
    const host = new EngineHost();
    const runtime = new AgentRuntime({
      server: createServer(host),
      principal: 'test-user',
      userId: 'test-user',
    });
    try {
      // The workbook's first (only) sheet is FMTs, not Sheet1 — the
      // exact shape that used to fail with "sheet 'Sheet1' is empty".
      host.execute({ cmd: 'renameSheet', name: 'Sheet1', newName: 'FMTs' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'FMTs', row: 0, col: 0 }, value: 'Time' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'FMTs', row: 0, col: 1 }, value: 'Event' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'FMTs', row: 1, col: 0 }, value: '09:00' });
      expect(host.sheetNames()).toEqual(['FMTs']);
      const store = createArtifactStore(memoryPersistence());
      const result = await runtime.createAppArtifact('t1', 'build me a sortable app for the schedule', {
        store,
      });
      expect(result.routed).toBe('app');
      if (result.routed !== 'app') throw new Error(`unreachable: ${JSON.stringify(result)}`);
      expect(result.spec.binding.sheet).toBe('FMTs');
    } finally {
      await runtime.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Generated app execution (mini-React + real MCP server)
// ---------------------------------------------------------------------------

describe('generated app execution', () => {
  it('data-table app loads sheet data through the real MCP server (no direct hydration)', async () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'Time' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'Event' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: '09:00' });
    const server = createServer(host);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'artifact-e2e-test', version: '0.0.0' });
    await server.connect(serverT);
    await client.connect(clientT);
    try {
      const callTool: McpCallFn = async (tool, args) => {
        const res = await client.callTool({ name: tool, arguments: args });
        const text = (res as { content?: { text: string }[] }).content?.[0]?.text ?? '';
        const p = JSON.parse(text) as { ok?: boolean; error?: string } & Record<string, unknown>;
        if (p.ok === false) throw new Error(p.error ?? `${tool} failed`);
        return p;
      };
      const store = createArtifactStore(memoryPersistence());
      const result = await generateAndSaveArtifact(
        { prompt: 'build me a sortable app for the schedule', sheet: 'Sheet1' },
        { callTool, store, principal: 'test-user' },
      );
      expect(result.routed).toBe('app');
      if (result.routed !== 'app') throw new Error('unreachable');

      const mcpCalls: { tool: string; args: Record<string, unknown> }[] = [];
      const subscriptions: { events: string[]; sheet?: string }[] = [];
      const mcp = {
        call: async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
          mcpCalls.push({ tool, args });
          return callTool(tool, args);
        },
        subscribe: (events: string[], sheet: string | undefined, _handler: unknown): (() => void) => {
          subscriptions.push({ events, sheet });
          return () => undefined;
        },
      };
      const states: unknown[] = [];
      let si = 0;
      const ReactShim = {
        useState: (init: unknown): [unknown, (v: unknown) => void] => {
          const i = si++;
          if (!(i in states)) states[i] = init;
          const set = (v: unknown): void => {
            states[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(states[i]) : v;
          };
          return [states[i], set];
        },
        useEffect: (fn: () => void): void => {
          fn();
        },
        useRef: (v: unknown): { current: unknown } => ({ current: v }),
      };
      const h = (...a: unknown[]): unknown => ({ type: a[0], props: a[1], children: a.slice(2) });
      const App = new Function(
        'React',
        'h',
        'useState',
        'useEffect',
        'useRef',
        'mcp',
        result.spec.source + '\n;return App;',
      )(ReactShim, h, ReactShim.useState, ReactShim.useEffect, ReactShim.useRef, mcp) as () => unknown;
      si = 0;
      App();
      await tick(100);

      // The app read the sheet through the MCP bridge (no direct hydration).
      expect(mcpCalls.length).toBeGreaterThan(0);
      expect(mcpCalls[0].tool).toBe('read_cells');
      const data = states[0] as { header: unknown[]; rows: unknown[][]; error: string };
      expect(data.header).toEqual(['Time', 'Event']);
      // The engine coerces '09:00' to an Excel time-of-day serial — the app
      // sees exactly what the MCP read_cells tool returns.
      expect(data.rows).toEqual([[0.375, null]]);
      expect(data.error).toBe('');
      // …and registered the live-binding subscription hook.
      expect(subscriptions).toEqual([{ events: ['cells_changed'], sheet: 'Sheet1' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
