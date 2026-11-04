/**
 * Agent-failures-fix program tests (2026-10-22): unit pins for the six
 * workstreams that close the remaining agent-validation failures —
 * W1 batched-write progress honesty, W2 aggregate integrity, W3
 * sheet-context grounding, W4 suppressed-ask consumption + answer()
 * no-op, W5 curated product knowledge, W6 header-overwrite guardrail.
 * Runtime tests drive a real MCP server over an in-memory EngineHost,
 * like agent-runtime.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '@icecream-sheets/mcp-server';
import { EngineHost } from '@icecream-sheets/engine';
import {
  AgentRuntime,
  aggregateIntegrityProblem,
  sheetAskProblem,
} from '../src/agent/runtime.js';
import { OpenAICompatibleBackend, SYSTEM_PROMPT } from '../src/agent/openaiBackend.js';
import {
  createPendingAskStoreOver,
  type PendingAsk,
  type PendingAskBackend,
  type PendingAskView,
} from '../src/agent/pendingAsks.js';
import type { ModelBackend, PlannerInput, PlannerOutput } from '../src/agent/types.js';

async function waitForPending(runtime: AgentRuntime, timeoutMs = 8000): Promise<PendingAskView[]> {
  const start = Date.now();
  for (;;) {
    const asks = await runtime.listPendingAsks();
    if (asks.length > 0) return asks;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a pending ask');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function makeRuntime(opts: {
  backend?: ModelBackend;
  server?: McpServer;
  confirmThreshold?: number;
  maxIterations?: number;
} = {}) {
  const host = new EngineHost();
  const server: McpServer = opts.server ?? createServer(host);
  const runtime = new AgentRuntime({
    server,
    principal: 'test-user',
    ...(opts.backend ? { backend: opts.backend } : {}),
    ...(opts.confirmThreshold !== undefined ? { confirmThreshold: opts.confirmThreshold } : {}),
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
  });
  return { host, server, runtime };
}

/** Sales-shaped fixture: header row + 12 data rows; Revenue (col 2)
 * sums to 159,400 with a first-three prefix of exactly 35,300. */
function seedSalesSheet(host: EngineHost) {
  const headers = ['Month', 'Region', 'Revenue'];
  headers.forEach((h, c) =>
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: c }, value: h }),
  );
  const rows: [string, string, number][] = [
    ['Jan', 'North', 12000],
    ['Feb', 'North', 13500],
    ['Mar', 'South', 9800],
    ['Apr', 'North', 15800],
    ['May', 'South', 16900],
    ['Jun', 'North', 16700],
    ['Jun', 'South', 14200],
    ['Jul', 'South', 11000],
    ['Aug', 'North', 12500],
    ['Sep', 'South', 13000],
    ['Oct', 'North', 11500],
    ['Nov', 'South', 12500],
  ];
  rows.forEach((r, i) =>
    r.forEach((v, c) =>
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: i + 1, col: c }, value: v }),
    ),
  );
}

const REVENUE_COLUMN_READ = {
  tool: 'read_cells',
  ok: true,
  summary: 'read_cells ok',
  data: {
    cells: [
      ['Revenue'],
      [12000],
      [13500],
      [9800],
      [15800],
      [16900],
      [16700],
      [14200],
      [11000],
      [12500],
      [13000],
      [11500],
      [12500],
    ],
  },
};

// ---------------- W2: aggregate integrity (pure) ----------------

describe('W2 aggregateIntegrityProblem', () => {
  it('flags a proper-prefix sum cited as the total (the case-1 signature)', () => {
    const problem = aggregateIntegrityProblem(
      'What is the total revenue in the Sales sheet?',
      'The total revenue is 35,300.',
      [REVENUE_COLUMN_READ],
    );
    expect(problem).not.toBeNull();
    expect(problem!.reason).toContain('partial-window sum');
    expect(problem!.correction).toContain('scratch');
  });

  it('accepts the true full total', () => {
    expect(
      aggregateIntegrityProblem(
        'What is the total revenue in the Sales sheet?',
        'The total revenue is 159,400.',
        [REVENUE_COLUMN_READ],
      ),
    ).toBeNull();
  });

  it('accepts a number that a tool result returned (engine-computed)', () => {
    const results = [
      REVENUE_COLUMN_READ,
      { tool: 'analyze_data', ok: true, summary: 'analyze_data ok', data: { total: 35300 } },
    ];
    expect(
      aggregateIntegrityProblem('What is the total revenue?', 'The total is 35,300.', results),
    ).toBeNull();
  });

  it('accepts a partial figure presented alongside the full total', () => {
    expect(
      aggregateIntegrityProblem(
        'What is the total revenue in the Sales sheet?',
        'The first rows subtotal 35,300; the total revenue is 159,400.',
        [REVENUE_COLUMN_READ],
      ),
    ).toBeNull();
  });

  it('does not fire on non-aggregate requests', () => {
    expect(
      aggregateIntegrityProblem(
        'List the rows where Revenue is greater than 14000.',
        'One row shows 35,300.',
        [REVENUE_COLUMN_READ],
      ),
    ).toBeNull();
  });
});

// ---------------- W2: runtime steering ----------------

describe('W2 runtime aggregate steering', () => {
  it('steers a partial-sum final answer back to an engine computation, once', async () => {
    const inputs: PlannerInput[] = [];
    const backend: ModelBackend = {
      name: 'w2-scripted',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        inputs.push(input);
        if (inputs.length === 1) {
          return {
            message: 'Reading the Revenue column.',
            actions: [
              {
                type: 'tool',
                tool: 'read_cells',
                args: { sheet: 'Sheet1', startRow: 0, startCol: 2, endRow: 12, endCol: 2 },
              },
            ],
          };
        }
        if (inputs.length === 2) {
          return { message: 'The total revenue is 35,300.', actions: [{ type: 'done' }] };
        }
        return { message: 'The total revenue is 159,400.', actions: [{ type: 'done' }] };
      },
    };
    const { host, runtime } = await makeRuntime({ backend });
    try {
      seedSalesSheet(host);
      const reply = await runtime.chat('t1', 'What is the total revenue in the Sales sheet?');
      expect(reply.message).toContain('159,400');
      expect(inputs).toHaveLength(3);
      // The third plan call received the aggregate-integrity correction.
      const correction = inputs[2]!.toolResults.find((r) => r.tool === 'agent.aggregate_check');
      expect(correction).toBeDefined();
      expect(correction!.summary).toContain('partial sum');
      const guard = reply.actionsTaken.find(
        (e) => e.kind === 'guardrail' && (e.summary ?? '').includes('aggregate integrity'),
      );
      expect(guard).toBeDefined();
    } finally {
      await runtime.close();
    }
  });
});

// ---------------- W3: sheet-context grounding ----------------

describe('W3 sheetAskProblem', () => {
  const sheets = ['Sales', 'WeatherLog'];

  it('blocks fabricated sheet options (the case-15 signature)', () => {
    const problem = sheetAskProblem(
      { question: 'Which sheet holds the weather data?', options: ['Sheet1', 'Sheet2', 'Sheet3'] },
      'show me the recorded temperature',
      sheets,
    );
    expect(problem).not.toBeNull();
    expect(problem!.correction).toContain('WeatherLog');
  });

  it('blocks a which-sheet ask when the request already names the sheet (case 18)', () => {
    const problem = sheetAskProblem(
      { question: 'Which sheet contains the Amount column?' },
      'What is the total of the Amount column in the Sales sheet?',
      ['Sales', 'WeatherLog'],
    );
    expect(problem).not.toBeNull();
    expect(problem!.reason).toContain('names the sheet');
  });

  it('blocks a which-sheet ask on a single-sheet workbook', () => {
    const problem = sheetAskProblem(
      { question: 'Which sheet should I read?' },
      'read the data',
      ['Sales'],
    );
    expect(problem).not.toBeNull();
  });

  it('lets a genuine choice between real sheets park', () => {
    expect(
      sheetAskProblem(
        { question: 'Which sheet should I chart?', options: ['Sales', 'WeatherLog'] },
        'chart the data',
        sheets,
      ),
    ).toBeNull();
  });

  it('never touches non-sheet option asks (chart placement)', () => {
    expect(
      sheetAskProblem(
        {
          question: 'Do you want the chart in the sheet or only in chat?',
          options: ['In the sheet', 'Only in chat'],
        },
        'chart this data',
        sheets,
      ),
    ).toBeNull();
  });

  it('is inert without sheet context', () => {
    expect(
      sheetAskProblem({ question: 'Which sheet?', options: ['Sheet1'] }, 'x', undefined),
    ).toBeNull();
  });
});

describe('W3 runtime sheet context', () => {
  it('injects real sheet names into the planner input and suppresses fabricated options', async () => {
    const inputs: PlannerInput[] = [];
    const backend: ModelBackend = {
      name: 'w3-scripted',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        inputs.push(input);
        if (inputs.length === 1) {
          return {
            message: 'Looking at the sheet first.',
            actions: [
              {
                type: 'tool',
                tool: 'read_cells',
                args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
              },
              {
                type: 'ask',
                question: 'Which sheet should I read the data from?',
                options: ['Sheet1', 'Sheet2', 'Sheet3'],
              },
            ],
          };
        }
        return { message: 'The data is on Sheet1.', actions: [{ type: 'done' }] };
      },
    };
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'Read the data and summarize it.');
      expect(reply.message).toContain('Sheet1');
      // The planner saw the real sheet context.
      expect(inputs[0]!.sheetContext?.sheets).toEqual(['Sheet1']);
      // The fabricated-options ask never parked.
      expect(await runtime.listPendingAsks()).toHaveLength(0);
      const suppressed = reply.actionsTaken.find(
        (e) => e.kind === 'question' && (e.summary ?? '').includes('do not exist'),
      );
      expect(suppressed).toBeDefined();
      // …and the planner received the correction naming the real sheets.
      const note = inputs[1]!.toolResults.find((r) => r.tool === 'agent.ask_question');
      expect(note?.summary).toContain('Sheet1');
    } finally {
      await runtime.close();
    }
  });
});

// ---------------- W4: suppressed-ask consumption ----------------

function memoryAskBackend(): PendingAskBackend & { items: PendingAsk[] } {
  const items: PendingAsk[] = [];
  return {
    items,
    async all() {
      return [...items];
    },
    async saveAll(next: PendingAsk[]) {
      items.length = 0;
      items.push(...next);
    },
    invalidate() {},
  };
}

describe('W4 suppressed-ask consumption', () => {
  it('withdraws a pre-turn zombie twin of a gate-suppressed ask', async () => {
    const host = new EngineHost();
    const backend = memoryAskBackend();
    const store = createPendingAskStoreOver(backend);
    const zombie = await store.create({
      kind: 'question',
      principal: 'test-user',
      question: 'Which column holds the revenue data?',
    });
    // The zombie predates the turn (left by an earlier segment/runtime).
    backend.items.find((a) => a.id === zombie.id)!.createdAt = Date.now() - 5_000;
    const server = createServer(host, { pendingAsks: store });
    const planner: ModelBackend = {
      name: 'w4-scripted',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        const calls = (input.iteration ?? 1) + (input.toolResults.length > 0 ? 100 : 0);
        void calls;
        if (input.toolResults.some((r) => r.tool === 'agent.ask_question')) {
          return { message: 'Grounded answer.', actions: [{ type: 'done' }] };
        }
        return {
          message: 'One question first.',
          actions: [{ type: 'ask', question: 'Which column holds the revenue data?' }],
        };
      },
    };
    const runtime = new AgentRuntime({ server, principal: 'test-user', backend: planner });
    try {
      const reply = await runtime.chat('t1', 'What is the total revenue?');
      expect(reply.message).toContain('Grounded answer.');
      // The zombie is consumed: nothing answerable remains.
      expect(await store.listFor('test-user')).toHaveLength(0);
      expect(await runtime.listPendingAsks()).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('answering a consumed ask at the tool layer errors as unknown (gateway maps it to a no-op)', async () => {
    const { runtime } = await makeRuntime();
    try {
      await expect(runtime.answerPendingAsk('ask_nope', 'yes')).rejects.toThrow(
        /unknown pending ask/,
      );
    } finally {
      await runtime.close();
    }
  });
});

// ---------------- W6: header-overwrite guardrail ----------------

describe('W6 header-overwrite guardrail', () => {
  function headerWriteBackend(sheet: string, row: number, col: number, value: unknown): ModelBackend {
    let calls = 0;
    return {
      name: 'w6-scripted',
      async plan(): Promise<PlannerOutput> {
        calls++;
        if (calls === 1) {
          return {
            message: 'Writing the value.',
            actions: [
              { type: 'tool', tool: 'write_cells', args: { cells: [{ sheet, row, col, value }] } },
            ],
          };
        }
        return { message: 'Done.', actions: [{ type: 'done' }] };
      },
    };
  }

  it('routes a header overwrite through approval, naming the exact target (case 2)', async () => {
    const backend = headerWriteBackend('Sheet1', 0, 2, 15000);
    const { host, runtime } = await makeRuntime({ backend });
    try {
      seedSalesSheet(host);
      const chatP = runtime.chat('t1', 'Set the Revenue for Jun South to 15000 in the Sales sheet.');
      const asks = await waitForPending(runtime);
      expect(asks).toHaveLength(1);
      expect(asks[0]!.kind).toBe('approval');
      expect(asks[0]!.detail).toContain('"Revenue"');
      expect(asks[0]!.detail).toContain('Sheet1!C1');
      await runtime.answerPendingAsk(asks[0]!.id, 'approve');
      const reply = await chatP;
      expect(reply.message).toContain('Done.');
      const v = host.getView().readCell({ sheet: 'Sheet1', row: 0, col: 2 }).value;
      expect(v.kind === 'number' && v.value).toBe(15000);
    } finally {
      await runtime.close();
    }
  });

  it('does not gate a data-cell write', async () => {
    const backend = headerWriteBackend('Sheet1', 1, 2, 99999);
    const { host, runtime } = await makeRuntime({ backend });
    try {
      seedSalesSheet(host);
      const reply = await runtime.chat('t1', 'Set the Jan North revenue to 99999.');
      expect(reply.message).toContain('Done.');
      expect(await runtime.listPendingAsks()).toHaveLength(0);
      const v = host.getView().readCell({ sheet: 'Sheet1', row: 1, col: 2 }).value;
      expect(v.kind === 'number' && v.value).toBe(99999);
    } finally {
      await runtime.close();
    }
  });

  it('does not gate rewriting the identical header text', async () => {
    const backend = headerWriteBackend('Sheet1', 0, 2, 'Revenue');
    const { host, runtime } = await makeRuntime({ backend });
    try {
      seedSalesSheet(host);
      const reply = await runtime.chat('t1', 'Rewrite the Revenue header label.');
      expect(reply.message).toContain('Done.');
      expect(await runtime.listPendingAsks()).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});

// ---------------- W1: batched-write progress honesty ----------------

describe('W1 progress honesty', () => {
  it('names already-written cells when the planner fails mid-batch', async () => {
    let calls = 0;
    const backend: ModelBackend = {
      name: 'w1-failing',
      async plan(): Promise<PlannerOutput> {
        calls++;
        if (calls === 1) {
          return {
            message: 'Writing rows 1-2 of 12.',
            actions: [
              {
                type: 'tool',
                tool: 'write_cells',
                args: {
                  cells: [
                    { sheet: 'Sheet1', row: 5, col: 1, value: 1 },
                    { sheet: 'Sheet1', row: 5, col: 2, value: 2 },
                  ],
                },
              },
            ],
          };
        }
        throw new Error('provider exploded');
      },
    };
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'set B6 to 1 and C6 to 2');
      expect(reply.message).toContain('The model call failed: provider exploded');
      expect(reply.message).toContain('2 cell(s) were already written');
    } finally {
      await runtime.close();
    }
  });

  it('names already-written cells when the turn runs out of steps mid-batch', async () => {
    // CONTRACT CHANGE (design-docs/agent-workflows.md §2, 2026-10-22):
    // the ran-out-of-steps ending is replaced by workflow promotion —
    // the batch is retried as a step with fresh per-step budgets and,
    // when the planner still never finishes, ends provably stuck. The
    // W1 honesty property this test protects carries over: the stop
    // report names every cell written along the way (2 by the plain
    // segment + 2 per step attempt x 3 attempts = 8).
    let calls = 0;
    const backend: ModelBackend = {
      name: 'w1-endless',
      async plan(): Promise<PlannerOutput> {
        calls++;
        return {
          message: `Writing row ${calls}.`,
          actions: [
            {
              type: 'tool',
              tool: 'write_cells',
              args: { cells: [{ sheet: 'Sheet1', row: 4 + calls, col: 1, value: calls }] },
            },
          ],
        };
      },
    };
    const { runtime } = await makeRuntime({ backend, maxIterations: 2 });
    try {
      const reply = await runtime.chat('t1', 'set B6 to 1 and C6 to 2');
      expect(reply.workflow?.status).toBe('stuck');
      expect(reply.message).toContain('I got stuck on step 1 of 1');
      expect(reply.message).toContain('8 cell(s) were written along the way');
    } finally {
      await runtime.close();
    }
  });
});

// ---------------- W5 + prompt-contract pins ----------------

describe('W5 product knowledge + prompt contracts', () => {
  it('curates the real UI paths for the common how-tos', () => {
    expect(SYSTEM_PROMPT).toContain('PRODUCT KNOWLEDGE');
    expect(SYSTEM_PROMPT).toContain('Insert tab');
    expect(SYSTEM_PROMPT).toContain('PivotTable');
    expect(SYSTEM_PROMPT).toContain('Freeze Panes');
    expect(SYSTEM_PROMPT).toContain('Freeze Top Row');
    expect(SYSTEM_PROMPT).toContain('Conditional Formatting');
    expect(SYSTEM_PROMPT).toContain('Sort & Filter');
  });

  it('pins the W1 batch-splitting rule', () => {
    expect(SYSTEM_PROMPT).toContain('SPLIT LARGE BATCHES ACROSS PLANS');
    expect(SYSTEM_PROMPT).toContain('at most 4 row-writes');
    // Step discipline added after two live attempts starved the batch:
    // one scratch computation, no explicit recalculate, verify the
    // filled-cell count before reporting completion.
    expect(SYSTEM_PROMPT).toContain('COMPUTE THE TOTAL ONCE');
    expect(SYSTEM_PROMPT).toContain('NEVER call recalculate yourself');
    expect(SYSTEM_PROMPT).toContain('VERIFY BEFORE YOU FINISH');
  });

  it('pins the W2 aggregate rules', () => {
    expect(SYSTEM_PROMPT).toContain('YOUR FINAL TOTAL MUST BE A TOOL-RETURNED NUMBER');
    expect(SYSTEM_PROMPT).toContain('PARTIAL READS ARE NOT TOTALS');
  });

  it('renders the workbook context into the planner request (W3)', async () => {
    let bodyText = '';
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'http://planner.invalid/v1',
      model: 'test-model',
      getApiKey: async () => 'test-key',
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        bodyText = String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ message: 'ok', actions: [{ type: 'done' }] }) } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });
    await backend.plan({
      userText: 'read the data',
      history: [],
      toolResults: [],
      iteration: 1,
      sheetContext: { sheets: ['Sales', 'WeatherLog'] },
    });
    expect(bodyText).toContain('Workbook context');
    expect(bodyText).toContain('WeatherLog');
    expect(bodyText).toContain('list_sheets');
  });
});
