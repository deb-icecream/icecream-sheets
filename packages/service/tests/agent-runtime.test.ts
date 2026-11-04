/**
 * AgentRuntime integration tests: the agent drives a real MCP server
 * (createServer) over an in-memory transport. Asserts the ai-agent.md
 * contracts: MCP-only access, user identity, audit trail, write
 * discipline, and human-in-the-loop pause/resume.
 */
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '@icecream-sheets/mcp-server';
import { EngineHost } from '@icecream-sheets/engine';
import { AgentRuntime } from '../src/agent/runtime.js';
import {
  HELP_MENU_OPTIONS,
  HELP_MENU_QUESTION,
  helpMenuAsk,
  isChartPlacementAsk,
  isHelpMenuRequest,
} from '../src/agent/runtime.js';
import { OpenAICompatibleBackend } from '../src/agent/openaiBackend.js';
import type { ModelBackend, PlannerInput, PlannerOutput } from '../src/agent/types.js';
import type { PendingAskView } from '../src/agent/pendingAsks.js';
import {
  TemplateAppGenerator,
  type AppGenerator,
  type ArtifactSpec,
} from '../src/artifacts/index.js';
import type { MetadataStore } from '../src/metadataStore.js';
import { createArtifactStore, memoryPersistence } from '../src/metadataStore.js';

/** Poll until the runtime has at least one pending human-in-the-loop ask. */
async function waitForPending(runtime: AgentRuntime, timeoutMs = 8000): Promise<PendingAskView[]> {
  const start = Date.now();
  for (;;) {
    const asks = await runtime.listPendingAsks();
    if (asks.length > 0) return asks;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a pending ask');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Backend that asks one free-text question, then completes using the
 * answer. Under the FIX-R4 grounding gate a free-text ask may only park
 * after a real tool execution, so the first plan grounds itself with a
 * read in the same plan (the shape the cascade test below also uses) —
 * these tests verify the HITL park/answer mechanics, not ask policy.
 */
function makeAskBackend(): ModelBackend {
  let asked = false;
  return {
    name: 'ask-test',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (!asked) {
        asked = true;
        return {
          message: 'One question first.',
          actions: [
            {
              type: 'tool',
              tool: 'read_cells',
              args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
            },
            { type: 'ask', question: 'What should I do?' },
          ],
        };
      }
      return { message: `Heard: ${input.userText}`, actions: [{ type: 'done' }] };
    },
  };
}

/**
 * #137 test stubs: the heuristic planner was DELETED, so tests that
 * need a planning backend use small scripted stubs. Each stub plans
 * exactly what its test needs (prompt in, tool-call JSON out, tool
 * executed by the runtime); the runtime mechanics under test — not
 * the planning — are the subject. Iteration-based, no cross-turn
 * state except makeMemoryStub's per-test save map.
 */
function sumMatrix(data: unknown): number {
  const matrix = (data as { cells?: unknown[][] } | null)?.cells;
  if (!Array.isArray(matrix)) return NaN;
  let sum = 0;
  for (const row of matrix) {
    for (const cell of row) {
      if (typeof cell === 'number') sum += cell;
    }
  }
  return sum;
}

function doneStub(name: string, first: (input: PlannerInput) => PlannerOutput): ModelBackend {
  return {
    name,
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.iteration > 1) return { message: 'Done.', actions: [{ type: 'done' }] };
      return first(input);
    },
  };
}

function makeSumStub(): ModelBackend {
  return {
    name: 'stub-sum',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.toolResults.length > 0) {
        return { message: `The sum is ${sumMatrix(input.toolResults[0]!.data)}.`, actions: [{ type: 'done' }] };
      }
      return {
        message: '',
        actions: [
          {
            type: 'tool',
            tool: 'read_cells',
            args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
          },
        ],
      };
    },
  };
}

function makeReadStub(): ModelBackend {
  return {
    name: 'stub-read',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.toolResults.length > 0) {
        const matrix = (input.toolResults[0]!.data as { cells?: unknown[][] } | null)?.cells;
        const vals = Array.isArray(matrix) ? matrix.flat().join(', ') : '';
        return { message: `Values: ${vals}`, actions: [{ type: 'done' }] };
      }
      return {
        message: '',
        actions: [
          {
            type: 'tool',
            tool: 'read_cells',
            args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
          },
        ],
      };
    },
  };
}

function makeWriteStub(): ModelBackend {
  return doneStub('stub-write', () => ({
    message: '',
    actions: [
      {
        type: 'tool',
        tool: 'write_cells',
        args: { cells: [{ sheet: 'Sheet1', row: 1, col: 1, value: 42 }] },
      },
    ],
  }));
}

function makeFormulaStub(): ModelBackend {
  return doneStub('stub-formula', () => ({
    message: '',
    actions: [
      {
        type: 'tool',
        tool: 'set_formulas',
        args: { formulas: [{ sheet: 'Sheet1', row: 0, col: 1, formula: '=SUM(A1:A3)' }] },
      },
    ],
  }));
}

function makeRecalcStub(): ModelBackend {
  return {
    name: 'stub-recalc',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.iteration > 1) return { message: 'Recalculation complete.', actions: [{ type: 'done' }] };
      return { message: '', actions: [{ type: 'tool', tool: 'recalculate', args: {} }] };
    },
  };
}

function makeMemoryStub(): ModelBackend {
  const saved = new Map<string, unknown>();
  const coerce = (raw: string): unknown => (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
  return {
    name: 'stub-memory',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.toolResults.length > 0) {
        const first = input.toolResults[0]!;
        if (first.tool === 'memory_load') {
          const d = first.data as { found?: boolean; value?: unknown } | null;
          const key = [...saved.keys()][0] ?? '';
          return {
            message: d?.found ? `${key} is ${d.value}` : 'I have nothing saved yet.',
            actions: [{ type: 'done' }],
          };
        }
        return { message: 'I will remember that.', actions: [{ type: 'done' }] };
      }
      const text = input.userText;
      const m = /remember that (?:the )?(\w+) is (.+)/i.exec(text);
      if (m) {
        const value = coerce(m[2].trim());
        saved.set(m[1], value);
        return {
          message: '',
          actions: [{ type: 'tool', tool: 'memory_save', args: { key: m[1], value } }],
        };
      }
      if (/what do you remember/i.test(text)) {
        const key = [...saved.keys()][0] ?? 'budget';
        return {
          message: '',
          actions: [{ type: 'tool', tool: 'memory_load', args: { key } }],
        };
      }
      return { message: 'Done.', actions: [{ type: 'done' }] };
    },
  };
}

function makeAnalyzeStub(): ModelBackend {
  return {
    name: 'stub-analyze',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.toolResults.length > 0) {
        const d = input.toolResults[0]!.data as { summary?: unknown } | null;
        const summary = typeof d?.summary === 'string' && d.summary.length > 0 ? d.summary : 'Sales analysis done.';
        return { message: summary, actions: [{ type: 'done' }] };
      }
      return {
        message: '',
        actions: [{ type: 'tool', tool: 'analyze_data', args: { intent: input.userText } }],
      };
    },
  };
}

function makeAppAskStub(): ModelBackend {
  return {
    name: 'stub-app-ask',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.iteration > 1) return { message: 'Done.', actions: [{ type: 'done' }] };
      return {
        message: '',
        actions: [
          {
            type: 'ask',
            question: 'Do you want me to build an app, or analyze the data and show a visual?',
            options: ['Describe the app', 'Analyze the data instead'],
            intentChoice: true,
          },
        ],
      };
    },
  };
}

async function makeRuntime(opts: {
  backend?: ModelBackend;
  principal?: string;
  userId?: string;
  confirmThreshold?: number;
  maxIterations?: number;
  artifactStore?: MetadataStore<ArtifactSpec>;
  appGenerator?: AppGenerator;
} = {}) {
  const host = new EngineHost();
  const server: McpServer = createServer(host);
  const runtime = new AgentRuntime({ server, principal: 'test-user', ...opts });
  return { host, server, runtime };
}

async function seedSumFixture(host: EngineHost) {
  host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 10 });
  host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 20 });
  host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 2, col: 0 }, value: 30 });
}

describe('AgentRuntime end-to-end (heuristic backend)', () => {
  it('answers a sum question through MCP tools only', async () => {
    const { host, runtime } = await makeRuntime({ backend: makeSumStub() });
    try {
      await seedSumFixture(host);
      const reply = await runtime.chat('t1', 'sum of A1:A3');
      expect(reply.message).toContain('60');
      expect(reply.needsInput).toBeUndefined();
      const tools = reply.actionsTaken.filter((e) => e.kind === 'tool_call').map((e) => e.tool);
      expect(tools).toContain('read_cells');
    } finally {
      await runtime.close();
    }
  });

  it('reads a range and previews values', async () => {
    const { host, runtime } = await makeRuntime({ backend: makeReadStub() });
    try {
      await seedSumFixture(host);
      const reply = await runtime.chat('t1', 'show me A1:A2');
      expect(reply.message).toContain('10');
      expect(reply.message).toContain('20');
    } finally {
      await runtime.close();
    }
  });

  it('writes a single cell without confirmation', async () => {
    const { host, runtime } = await makeRuntime({ backend: makeWriteStub() });
    try {
      const reply = await runtime.chat('t1', 'set B2 to 42');
      expect(reply.needsInput).toBeUndefined();
      const v = host.getView().readCell({ sheet: 'Sheet1', row: 1, col: 1 }).value;
      expect(v.kind === 'number' && v.value).toBe(42);
    } finally {
      await runtime.close();
    }
  });

  it('sets a formula', async () => {
    const { host, runtime } = await makeRuntime({ backend: makeFormulaStub() });
    try {
      await seedSumFixture(host);
      await runtime.chat('t1', 'put =SUM(A1:A3) in B1');
      const v = host.getView().readCell({ sheet: 'Sheet1', row: 0, col: 1 }).value;
      expect(v.kind === 'number' && v.value).toBe(60);
    } finally {
      await runtime.close();
    }
  });

  it('recalculates on request', async () => {
    const { runtime } = await makeRuntime({ backend: makeRecalcStub() });
    try {
      const reply = await runtime.chat('t1', 'recalculate now');
      expect(reply.message).toMatch(/recalculat/i);
      expect(reply.actionsTaken.some((e) => e.tool === 'recalculate')).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('remembers and recalls scoped to the runtime userId', async () => {
    const { runtime } = await makeRuntime({ userId: 'alice', backend: makeMemoryStub() });
    try {
      const r1 = await runtime.chat('t1', 'remember that the budget is 5000');
      expect(r1.message).toMatch(/remember/i);
      const r2 = await runtime.chat('t1', 'what do you remember?');
      expect(r2.message).toContain('budget is 5000');
      // Memory calls are stamped with the runtime userId, not the backend default.
      const memCalls = runtime
        .getAuditLog()
        .filter((e) => e.kind === 'tool_call' && e.tool?.startsWith('memory_'));
      expect(memCalls.length).toBeGreaterThan(0);
      for (const c of memCalls) {
        expect((c.args as Record<string, unknown>).userId).toBe('alice');
      }
    } finally {
      await runtime.close();
    }
  });

  it('pauses the turn on agent.ask_question until the human answers', async () => {
    const { runtime } = await makeRuntime({ backend: makeAskBackend() });
    try {
      // The turn blocks inside chat(): the agent.* tool call pauses the agent.
      const chatP = runtime.chat('t1', 'hello');
      const asks = await waitForPending(runtime);
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ kind: 'question', question: 'What should I do?' });

      // The human answers through the versioned answer tool; the paused
      // turn resumes and the answer becomes the new user text.
      await runtime.answerPendingAsk(asks[0]!.id, 'sum it up');
      const reply = await chatP;
      expect(reply.needsInput).toBeUndefined();
      expect(reply.message).toContain('Heard: sum it up');
      // No stale ask left behind.
      expect(await runtime.listPendingAsks()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it('FIX-R4: suppresses a second ask in the same turn (ask budget) and steers the planner to answer', async () => {
    // Backend that asks on every plan until it sees the budget note in its
    // tool results — the live failure mode was a five-ask cascade where
    // each answer re-entered the loop with a fresh budget.
    const seen = { notedBudget: false };
    let plans = 0;
    const cascadeBackend: ModelBackend = {
      name: 'ask-cascade-test',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        plans++;
        if (
          input.toolResults.some(
            (r) => r.tool === 'agent.ask_question' && !r.ok && r.summary.includes('Ask budget'),
          )
        ) {
          seen.notedBudget = true;
          return { message: 'Answered without asking again.', actions: [{ type: 'done' }] };
        }
        if (plans === 1) {
          // Ground first (a real tool call in the same plan), then ask —
          // an ungrounded first-move ask would be suppressed instead.
          return {
            message: '',
            actions: [
              {
                type: 'tool',
                tool: 'read_cells',
                args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
              },
              { type: 'ask', question: 'Question 1?' },
            ],
          };
        }
        return { message: '', actions: [{ type: 'ask', question: `Question ${plans}?` }] };
      },
    };
    const { host, runtime } = await makeRuntime({ backend: cascadeBackend });
    try {
      await seedSumFixture(host);
      const chatP = runtime.chat('t1', 'what is the total?');
      const asks = await waitForPending(runtime);
      expect(asks).toHaveLength(1);
      await runtime.answerPendingAsk(asks[0]!.id, 'just compute it');
      // The second ask must NOT park: the chat promise resolves on the
      // planner's done plan (a second park would hang until the HITL
      // timeout, far beyond this test's timeout).
      const reply = await chatP;
      expect(reply.message).toContain('Answered without asking again.');
      expect(seen.notedBudget).toBe(true);
      expect(await runtime.listPendingAsks()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it('FIX-R4: suppresses an ungrounded first-move ask (no tool use yet) without parking', async () => {
    // Live failure mode: the planner's first plan for "what is the total
    // revenue?" was an ask about which column holds the revenue — a fact
    // one read answers — parking the turn for the full 240 s HITL wait.
    const seen = { notedUngrounded: false };
    const ungroundedBackend: ModelBackend = {
      name: 'ask-ungrounded-test',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        if (
          input.toolResults.some(
            (r) => r.tool === 'agent.ask_question' && !r.ok && r.summary.includes('not used any tool'),
          )
        ) {
          seen.notedUngrounded = true;
          return { message: 'Answered after looking.', actions: [{ type: 'done' }] };
        }
        return { message: '', actions: [{ type: 'ask', question: 'Which column has the data?' }] };
      },
    };
    const { runtime } = await makeRuntime({ backend: ungroundedBackend });
    try {
      // No waitForPending: the ask must never park. If the gate failed,
      // chat() would block until the HITL timeout and this test times out.
      const reply = await runtime.chat('t1', 'what is the total revenue?');
      expect(reply.message).toContain('Answered after looking.');
      expect(seen.notedUngrounded).toBe(true);
      expect(await runtime.listPendingAsks()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it('FIX-R4: a planner-generated options ask on a data turn is suppressed ungrounded (no park)', async () => {
    // The combined-build live failure: for "What is the total revenue in
    // the Sales sheet?" the planner's first move was an OPTIONS ask —
    // "Which column in the Sales sheet contains the revenue data?" — and
    // the old exemption (any ask carrying options may park ungrounded)
    // let it park for the full HITL wait. Options are not provenance:
    // a planner-generated ask is gated with or without them. Only a
    // product-constructed intent choice (intentChoice marker, next test)
    // is exempt.
    const seen = { notedUngrounded: false };
    const optionsBackend: ModelBackend = {
      name: 'ask-options-ungrounded-test',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        if (
          input.toolResults.some(
            (r) => r.tool === 'agent.ask_question' && !r.ok && r.summary.includes('not used any tool'),
          )
        ) {
          seen.notedUngrounded = true;
          return { message: 'Answered after looking.', actions: [{ type: 'done' }] };
        }
        return {
          message: '',
          actions: [
            {
              type: 'ask',
              question: 'Which column in the Sales sheet contains the revenue data?',
              options: ['Revenue', 'Units', 'Region'],
            },
          ],
        };
      },
    };
    const { runtime } = await makeRuntime({ backend: optionsBackend });
    try {
      // No waitForPending: the ask must never park. If the gate failed,
      // chat() would block until the HITL timeout and this test times out.
      const reply = await runtime.chat('t1', 'What is the total revenue in the Sales sheet?');
      expect(reply.message).toContain('Answered after looking.');
      expect(seen.notedUngrounded).toBe(true);
      expect(await runtime.listPendingAsks()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it('FIX-R4: a product-constructed intent-choice ask (intentChoice marker) may park ungrounded', async () => {
    // The product's own flows ask with options BEFORE any tool use —
    // app-generation ("Describe the app / Analyze the data instead") and
    // the unknown-intent help menu, both constructed by the deterministic
    // backend and marked intentChoice: true. No tool can answer an
    // intent choice, so the grounding gate exempts the MARKED ask;
    // pinning that here so a future tightening cannot silently break
    // those flows again. (The live deterministic-backend flow itself is
    // pinned by the app-generation test below.)
    let asked = false;
    const optionsBackend: ModelBackend = {
      name: 'ask-options-test',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        if (!asked) {
          asked = true;
          return {
            message: 'What would you like?',
            actions: [
              {
                type: 'ask',
                question: 'What would you like?',
                options: ['Describe the app', 'Analyze the data instead'],
                intentChoice: true,
              },
            ],
          };
        }
        return { message: `Heard: ${input.userText}`, actions: [{ type: 'done' }] };
      },
    };
    const { runtime } = await makeRuntime({ backend: optionsBackend });
    try {
      const chatP = runtime.chat('t1', 'build me an app from this sales data');
      const asks = await waitForPending(runtime);
      expect(asks).toHaveLength(1);
      expect(asks[0]!.kind).toBe('options');
      await runtime.answerPendingAsk(asks[0]!.id, 'Describe the app');
      const reply = await chatP;
      expect(reply.message).toContain('Heard: Describe the app');
      expect(await runtime.listPendingAsks()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it('#139 help menu is a runtime-constructed intent choice, parked before any planning', async () => {
    // Product construction, not a planner guess: fixed wording,
    // intentChoice marker set by product code.
    const ask = helpMenuAsk();
    expect(ask).toMatchObject({
      type: 'ask',
      question: HELP_MENU_QUESTION,
      intentChoice: true,
    });
    expect(ask.options).toEqual([...HELP_MENU_OPTIONS]);
    expect(ask.options!.length).toBeGreaterThanOrEqual(2);
    // Trigger is the literal request only.
    expect(isHelpMenuRequest('help')).toBe(true);
    expect(isHelpMenuRequest('  Help Menu  ')).toBe(true);
    expect(isHelpMenuRequest('help me build a chart')).toBe(false);
    expect(isHelpMenuRequest('helpful')).toBe(false);
    expect(isHelpMenuRequest('')).toBe(false);
  });

  it("#139 chat('help') parks the menu and resumes with the chosen option", async () => {
    const doneBackend: ModelBackend = {
      name: 'help-done',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        return { message: `Heard: ${input.userText}`, actions: [{ type: 'done' }] };
      },
    };
    const { runtime } = await makeRuntime({ backend: doneBackend });
    try {
      // No planner call happens before the park: the turn blocks in
      // runHelpMenu, so the pending ask appears without any tool use.
      const chatP = runtime.chat('t1', 'help');
      const asks = await waitForPending(runtime);
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({
        kind: 'options',
        question: HELP_MENU_QUESTION,
        options: [...HELP_MENU_OPTIONS],
      });
      await runtime.answerPendingAsk(asks[0]!.id, 'Build an app from this data');
      const reply = await chatP;
      expect(reply.message).toContain('Heard: Build an app from this data');
      expect(await runtime.listPendingAsks()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it('answer() delivers to the pending ask and unblocks the turn', async () => {
    const { runtime } = await makeRuntime({ backend: makeAskBackend() });
    try {
      const chatP = runtime.chat('t1', 'hello');
      const asks = await waitForPending(runtime);
      expect(asks).toHaveLength(1);
      // answer() is the programmatic counterpart of the UI's answer
      // buttons: it routes through agent.answer_pending.
      const ack = await runtime.answer('t1', 'sum it up');
      expect(ack.message).toMatch(/recorded/i);
      const reply = await chatP;
      expect(reply.message).toContain('Heard: sum it up');
    } finally {
      await runtime.close();
    }
  });

  it('answer() with no pending ask is a clean no-op (W4 — never starts a turn)', async () => {
    const { host, runtime } = await makeRuntime();
    try {
      await seedSumFixture(host);
      // The ask this "answer" targets was already consumed (answered,
      // timed out, or suppressed + withdrawn): the reply is a no-op —
      // no planner call, no tool execution, no fresh turn on any
      // backend. (Pre-W4 this fell through to chat(), which on a
      // fallback runtime spawned the help-menu loop of Finding 3.)
      const reply = await runtime.answer('t1', 'sum of A1:A3');
      expect(reply.message).toContain('no longer pending');
      const tools = reply.actionsTaken.filter((e) => e.kind === 'tool_call');
      expect(tools).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('audit trail records what/when/whose for every action', async () => {
    const { host, runtime } = await makeRuntime({ principal: 'auditor', backend: makeSumStub() });
    try {
      await seedSumFixture(host);
      const reply = await runtime.chat('t1', 'sum of A1:A3');
      expect(reply.actionsTaken.length).toBeGreaterThan(0);
      const seqs = reply.actionsTaken.map((e) => e.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      for (const e of reply.actionsTaken) {
        expect(e.principal).toBe('auditor');
        expect(e.threadId).toBe('t1');
        expect(e.ts).toBeGreaterThan(0);
      }
      expect(reply.actionsTaken.some((e) => e.kind === 'user_message')).toBe(true);
      expect(reply.actionsTaken.some((e) => e.kind === 'tool_call')).toBe(true);
      expect(reply.actionsTaken.some((e) => e.kind === 'agent_message')).toBe(true);
      // Full log queryable per thread.
      expect(runtime.getAuditLog('t1').length).toBe(reply.actionsTaken.length);
      expect(runtime.getAuditLog('other')).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('threads are isolated', async () => {
    const { runtime } = await makeRuntime({ backend: makeMemoryStub() });
    try {
      await runtime.chat('t1', 'remember that color is blue');
      await runtime.chat('t2', 'what do you remember?');
      // t2 shares the user memory namespace (per-user, not per-thread) —
      // but histories differ.
      expect(runtime.getHistory('t1').length).toBeGreaterThan(0);
      expect(runtime.getHistory('t2').length).toBeGreaterThan(0);
      expect(runtime.getThreads()).toContain('t1');
      expect(runtime.getThreads()).toContain('t2');
    } finally {
      await runtime.close();
    }
  });
});

describe('write discipline (§7)', () => {
  /** Backend that plans a 20-cell bulk write once, then reports done. */
  const bulkBackend: ModelBackend = {
    name: 'bulk-test',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.toolResults.length > 0) {
        return { message: 'Bulk write complete.', actions: [{ type: 'done' }] };
      }
      return {
        message: 'Bulk writing…',
        actions: [
          {
            type: 'tool',
            tool: 'write_cells',
            args: {
              cells: Array.from({ length: 20 }, (_, i) => ({
                sheet: 'Sheet1',
                row: i,
                col: 0,
                value: i,
              })),
            },
          },
        ],
      };
    },
  };

  it('bulk writes pause for confirmation and apply on yes', async () => {
    const { host, runtime } = await makeRuntime({ backend: bulkBackend, confirmThreshold: 10 });
    try {
      // The turn blocks on agent.request_approval (§7 + §12).
      const chatP = runtime.chat('t1', 'do it');
      const asks = await waitForPending(runtime);
      expect(asks).toHaveLength(1);
      expect(asks[0]!.kind).toBe('approval');
      expect(asks[0]!.detail).toMatch(/20 cell/);
      const before = host.getView().readCell({ sheet: 'Sheet1', row: 5, col: 0 }).value;
      expect(before.kind).toBe('null');
      await runtime.answerPendingAsk(asks[0]!.id, 'yes');
      const reply = await chatP;
      expect(reply.needsInput).toBeUndefined();
      const after = host.getView().readCell({ sheet: 'Sheet1', row: 5, col: 0 }).value;
      expect(after.kind === 'number' && after.value).toBe(5);
      expect(
        runtime.getAuditLog('t1').some((e) => e.kind === 'confirmation'),
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('declining a confirmation makes no changes', async () => {
    const { host, runtime } = await makeRuntime({ backend: bulkBackend, confirmThreshold: 10 });
    try {
      const chatP = runtime.chat('t1', 'do it');
      const asks = await waitForPending(runtime);
      expect(asks[0]!.kind).toBe('approval');
      await runtime.answerPendingAsk(asks[0]!.id, 'no way');
      const reply = await chatP;
      expect(reply.message).toMatch(/didn't make any changes/);
      const v = host.getView().readCell({ sheet: 'Sheet1', row: 0, col: 0 }).value;
      expect(v.kind).toBe('null');
    } finally {
      await runtime.close();
    }
  });

  it('writes under the threshold skip confirmation', async () => {
    const { host, runtime } = await makeRuntime({ backend: bulkBackend, confirmThreshold: 50 });
    try {
      const r = await runtime.chat('t1', 'do it');
      expect(r.needsInput).toBeUndefined();
      const v = host.getView().readCell({ sheet: 'Sheet1', row: 0, col: 0 }).value;
      expect(v.kind === 'number' && v.value).toBe(0);
    } finally {
      await runtime.close();
    }
  });
});

describe('proactive watch (ai-agent.md §6)', () => {
  it('watch -> pollWatch -> unwatch round trip', async () => {
    const { host, runtime } = await makeRuntime();
    try {
      const subId = await runtime.watch(['cells_changed'], 'Sheet1');
      expect(subId).toMatch(/^sub_/);
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 2 });
      const events = await runtime.pollWatch(subId);
      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('cells_changed');
      await runtime.unwatch(subId);
      // Polling after unwatch throws (unknown subscription).
      await expect(runtime.pollWatch(subId)).rejects.toThrow();
    } finally {
      await runtime.close();
    }
  });

  it('watch respects the sheet filter', async () => {
    const { host, runtime } = await makeRuntime();
    try {
      host.execute({ cmd: 'addSheet', name: 'Other' });
      const subId = await runtime.watch(['cells_changed'], 'Sheet1');
      host.execute({ cmd: 'setCell', ref: { sheet: 'Other', row: 0, col: 0 }, value: 1 });
      expect(await runtime.pollWatch(subId)).toHaveLength(0);
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 2 });
      expect(await runtime.pollWatch(subId)).toHaveLength(1);
      await runtime.unwatch(subId);
    } finally {
      await runtime.close();
    }
  });
});

describe('planner limits', () => {
  it('stops after maxIterations — now via workflow promotion to a provably-stuck stop', async () => {
    // CONTRACT CHANGE (design-docs/agent-workflows.md §2, 2026-10-22):
    // a turn that exhausts its iteration budget no longer ends with the
    // bare ran-out-of-steps reply. It is promoted to a workflow whose
    // step gets fresh per-step budgets (steering retries, then a
    // re-plan attempt); a planner that NEVER finishes ends provably
    // stuck with a plain-language report. The bound this test protects
    // is unchanged in kind: every segment stops after maxIterations —
    // the total is 2 (plain segment) + 3 attempts x 2 (step segments).
    const looping: ModelBackend = {
      name: 'loop',
      async plan(): Promise<PlannerOutput> {
        return { message: 'again', actions: [{ type: 'tool', tool: 'recalculate', args: {} }] };
      },
    };
    const { runtime } = await makeRuntime({ backend: looping, maxIterations: 2 });
    try {
      const r = await runtime.chat('t1', 'go');
      expect(r.workflow?.status).toBe('stuck');
      expect(r.message).toContain('I got stuck on step 1 of 1');
      expect(
        runtime.getAuditLog('t1').filter((e) => e.tool === 'recalculate').length,
      ).toBe(8);
    } finally {
      await runtime.close();
    }
  });

  it('uses the injected backend name (pluggable model, §8)', async () => {
    const custom: ModelBackend = {
      name: 'custom-llm',
      async plan(): Promise<PlannerOutput> {
        return { message: 'custom says hi', actions: [{ type: 'done' }] };
      },
    };
    const { runtime } = await makeRuntime({ backend: custom });
    try {
      const r = await runtime.chat('t1', 'hello');
      expect(r.message).toBe('custom says hi');
    } finally {
      await runtime.close();
    }
  });
});

describe('AgentRuntime data-analysis handoff', () => {
  async function seedSalesGrid(host: EngineHost) {
    const rows: (string | number)[][] = [
      ['Region', 'Sales'],
      ['North', 100],
      ['South', 200],
      ['North', 150],
    ];
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r]!.length; c++) {
        host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: r, col: c }, value: rows[r]![c]! });
      }
    }
  }

  it('chat "pivot sales by region and show a chart" returns a chart attachment', async () => {
    const { host, runtime } = await makeRuntime({ backend: makeAnalyzeStub() });
    try {
      await seedSalesGrid(host);
      const reply = await runtime.chat('t1', 'pivot sales by region and show a chart');
      expect(reply.needsInput).toBeUndefined();
      // The message summarizes the deterministic analysis run.
      expect(reply.message).toContain('Sales');
      // Spec + render request handoff: a Chart.js config for ChartCanvas.
      expect(reply.chart).toBeDefined();
      expect(reply.chart!.title).toBeTruthy();
      expect(reply.chart!.config.type).toBe('bar');
      const datasets = reply.chart!.config.data?.datasets ?? [];
      expect(datasets).toHaveLength(1);
      // North: 250, South: 200.
      expect(datasets[0]!.data).toEqual([250, 200]);
      const tools = reply.actionsTaken.filter((e) => e.kind === 'tool_call').map((e) => e.tool);
      expect(tools).toContain('analyze_data');
    } finally {
      await runtime.close();
    }
  }, 30000);

  it('#153: a placement ask after a computed chart never parks — the chart rides the done reply', async () => {
    // The r2 failure shape: analyze_data succeeds, then the planner asks
    // whether to insert the chart into a sheet or keep it in chat. The
    // guard must steer instead of parking, so the turn ends with the
    // chart attached and no timeout message.
    const placementAskBackend: ModelBackend = {
      name: 'stub-placement-ask',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        const results = input.toolResults;
        if (results.length === 0) {
          return {
            message: '',
            actions: [{ type: 'tool', tool: 'analyze_data', args: { intent: input.userText } }],
          };
        }
        const last = results[results.length - 1]!;
        if (last.tool === 'agent.ask_question' && !last.ok) {
          return { message: 'Here is the revenue chart in this chat.', actions: [{ type: 'done' }] };
        }
        return {
          message: 'I have analyzed the data.',
          actions: [
            {
              type: 'ask',
              question:
                "Would you like me to insert this chart directly into the 'Dashboard' sheet, or should I keep it here as an analysis for you to view?",
            },
          ],
        };
      },
    };
    const { host, runtime } = await makeRuntime({ backend: placementAskBackend });
    try {
      await seedSalesGrid(host);
      const reply = await runtime.chat('t1', 'pivot sales by region and show a chart');
      expect(reply.chart).toBeDefined();
      expect(reply.chart!.config.type).toBe('bar');
      expect(reply.message).not.toMatch(/didn't get an answer in time/);
      expect(await runtime.listPendingAsks()).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  }, 30000);

  it('app-generation prompts pause with options and never reach the analysis pipeline', async () => {
    const { runtime } = await makeRuntime({ backend: makeAppAskStub() });
    // The turn blocks on agent.offer_options; close() aborts the blocked
    // turn gracefully (the server-side wait is unref'd and times out
    // harmlessly).
    const chatP = runtime.chat('t1', 'build me an app from this sales data');
    try {
      const asks = await waitForPending(runtime);
      expect(asks).toHaveLength(1);
      expect(asks[0]!.kind).toBe('options');
      expect(asks[0]!.options).toContain('Describe the app');
      const tools = runtime
        .getAuditLog('t1')
        .filter((e) => e.kind === 'tool_call')
        .map((e) => e.tool);
      expect(tools).not.toContain('analyze_data');
    } finally {
      await runtime.close();
      const reply = await chatP;
      expect(reply.message).toMatch(/didn't get an answer in time/);
    }
  });
});

describe('isChartPlacementAsk (#153)', () => {
  it('matches the r2 placement question verbatim', () => {
    expect(
      isChartPlacementAsk(
        "Would you like me to insert this chart directly into the 'Dashboard' sheet, or should I keep it here as an analysis for you to view?",
      ),
    ).toBe(true);
  });

  it('matches the options form (sheet choice vs keep-in-chat)', () => {
    expect(
      isChartPlacementAsk('Where should this chart go?', ['Insert into Dashboard', 'Keep in chat']),
    ).toBe(true);
  });

  it('rejects which-sheet, generic, and bare chart questions', () => {
    expect(isChartPlacementAsk('Which sheet holds the revenue data?')).toBe(false);
    expect(isChartPlacementAsk('What should I do?')).toBe(false);
    expect(isChartPlacementAsk('Should I chart this data?')).toBe(false);
    expect(isChartPlacementAsk('What would you like to do with your spreadsheet?')).toBe(false);
  });
});

describe('planner done semantics (D2)', () => {
  it('a plan with tool actions + done continues the loop; the final composed message wins', async () => {
    let calls = 0;
    const backend: ModelBackend = {
      name: 'tool-plus-done',
      async plan(): Promise<PlannerOutput> {
        calls++;
        if (calls === 1) {
          // The D2 shape Gemini produced live: tool action AND done in
          // one plan. The old runtime ended the turn here and returned
          // the status message "Reading…" as the answer.
          return {
            message: 'Reading A1:A3…',
            actions: [
              {
                type: 'tool',
                tool: 'read_cells',
                args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
              },
              { type: 'done' },
            ],
          };
        }
        return { message: 'The sum of A1:A3 is 60.', actions: [{ type: 'done' }] };
      },
    };
    const { host, runtime } = await makeRuntime({ backend });
    try {
      await seedSumFixture(host);
      const reply = await runtime.chat('t1', 'sum of A1:A3');
      expect(calls).toBe(2);
      expect(reply.message).toBe('The sum of A1:A3 is 60.');
      const tools = reply.actionsTaken.filter((e) => e.kind === 'tool_call').map((e) => e.tool);
      expect(tools).toContain('read_cells');
    } finally {
      await runtime.close();
    }
  });

  it('a done-only plan ends the turn with its message in one iteration', async () => {
    let calls = 0;
    const backend: ModelBackend = {
      name: 'done-only',
      async plan(): Promise<PlannerOutput> {
        calls++;
        return { message: 'All done, nothing to fetch.', actions: [{ type: 'done' }] };
      },
    };
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'hello');
      expect(calls).toBe(1);
      expect(reply.message).toBe('All done, nothing to fetch.');
    } finally {
      await runtime.close();
    }
  });
});

describe('tool failure surfacing (D1b)', () => {
  it('propagates the real MCP error text into ToolResultRecord.summary (never "failed: undefined")', async () => {
    let captured: PlannerInput['toolResults'] = [];
    let calls = 0;
    const backend: ModelBackend = {
      name: 'bad-then-done',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        calls++;
        if (calls === 1) {
          // The invented shape from the live probe transcripts.
          return {
            message: 'Reading…',
            actions: [
              {
                type: 'tool',
                tool: 'read_cells',
                args: { sheet_name: 'Sheet1', cell_range: 'A1:A3' },
              },
            ],
          };
        }
        captured = input.toolResults;
        return { message: 'recovered', actions: [{ type: 'done' }] };
      },
    };
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'sum of A1:A3');
      expect(reply.message).toBe('recovered');
      expect(captured).toHaveLength(1);
      const rec = captured[0]!;
      expect(rec.ok).toBe(false);
      expect(rec.summary).toContain('read_cells failed:');
      expect(rec.summary).not.toContain('undefined');
      // Real error text, not a placeholder: something beyond the prefix.
      const errorText = rec.summary.replace('read_cells failed:', '').trim();
      expect(errorText.length).toBeGreaterThan(10);
      expect(errorText).not.toMatch(/^unknown error/);
      // The audit trail carries the same real text.
      const auditFail = runtime
        .getAuditLog('t1')
        .find((e) => e.kind === 'tool_call' && e.tool === 'read_cells' && e.ok === false);
      expect(auditFail?.summary).toBe(rec.summary);
    } finally {
      await runtime.close();
    }
  });
});

describe('LLM planner self-correction (D1 + D1b + D2, fake-fetch OpenAI backend)', () => {
  it('wrong arg shapes -> real error in the next planner call -> corrected plan -> composed answer', async () => {
    const requests: { messages: { role: string; content: string }[] }[] = [];
    let call = 0;
    let jobPlanCalls = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      // Workflow layer (agent-workflows.md §2.1): the runtime first asks
      // the backend for a JOB plan on a separate prompt. A real provider
      // answers it independently of the plan sequence, so the fake does
      // too — a one-step plan keeps this ask on the plain loop path,
      // and the plan() script below runs exactly as it did before.
      const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
      if (system.includes('job planner')) {
        jobPlanCalls++;
        const jobPlan = {
          steps: [{ title: 'Answer the sum', instruction: 'Compute the sum of A1:A3 on Sheet1.' }],
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(jobPlan) } }] }),
          text: async () => '',
        } as Response;
      }
      requests.push(body);
      call++;
      let plan: PlannerOutput;
      if (call === 1) {
        // Gemini's live failure shape (probe step 3b): invented fields,
        // plus a done action riding along (D2 shape).
        plan = {
          message: 'Reading cells A1:A3 from Sheet1 to calculate their sum.',
          actions: [
            {
              type: 'tool',
              tool: 'read_cells',
              args: { sheet_name: 'Sheet1', cell_range: 'A1:A3' },
              rationale: 'read the cells',
            },
            { type: 'done' },
          ],
        };
      } else if (call === 2) {
        // Corrected plan, in the exact MCP schema, with NO done: the
        // runtime must call the planner again with the read results.
        plan = {
          message: 'Reading A1:A3 on Sheet1.',
          actions: [
            {
              type: 'tool',
              tool: 'read_cells',
              args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
            },
          ],
        };
      } else {
        // Final iteration: compose from the tool data visible in this
        // request (seeded cells 10, 20, 30 -> sum 60) and finish with a
        // done-only plan.
        const userContent = body.messages.find((m) => m.role === 'user')?.content ?? '';
        expect(userContent).toContain('[[10],[20],[30]]');
        plan = { message: 'The sum of A1:A3 is 60.', actions: [{ type: 'done' }] };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
        text: async () => '',
      } as Response;
    }) as typeof fetch;

    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => 'test-key',
      fetchImpl,
    });
    const { host, runtime } = await makeRuntime({ backend });
    try {
      await seedSumFixture(host);
      const reply = await runtime.chat('t1', 'What is the sum of A1:A3 on Sheet1?');

      // The turn completed with the composed answer built from tool data.
      expect(reply.message).toBe('The sum of A1:A3 is 60.');
      expect(requests).toHaveLength(3);
      // The job-plan classification happened exactly once, returned a
      // one-step plan, and the turn stayed on the plain path (no
      // workflow engaged, no workflow summary on the reply).
      expect(jobPlanCalls).toBe(1);
      expect(reply.workflow).toBeUndefined();

      // The failed call's audit summary carries the real error text...
      const failed = runtime
        .getAuditLog('t1')
        .find((e) => e.kind === 'tool_call' && e.tool === 'read_cells' && e.ok === false);
      expect(failed).toBeDefined();
      expect(failed!.summary).toContain('read_cells failed:');
      expect(failed!.summary).not.toContain('undefined');
      const errorText = failed!.summary!.replace('read_cells failed:', '').trim();
      expect(errorText.length).toBeGreaterThan(10);

      // ...and that exact error text reached the second planner call's
      // input, so the model could self-correct (D1b).
      const secondUser = requests[1]!.messages.find((m) => m.role === 'user')?.content ?? '';
      expect(secondUser).toContain('FAILED');
      expect(secondUser).not.toContain('failed: undefined');
      expect(secondUser).toContain(errorText.slice(0, 60));

      // The corrected read actually succeeded against the real MCP server.
      const succeeded = runtime
        .getAuditLog('t1')
        .find((e) => e.kind === 'tool_call' && e.tool === 'read_cells' && e.ok === true);
      expect(succeeded).toBeDefined();
    } finally {
      await runtime.close();
    }
  });
});

describe('planner-fix merged delta (2026-10-22): ask state preservation + planner-failure containment', () => {
  it('preserves tool results across an ask (M2): the post-ask planner call receives the earlier read', async () => {
    const seen: PlannerInput[] = [];
    let calls = 0;
    const backend: ModelBackend = {
      name: 'planner-fix-ask',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        seen.push(input);
        calls++;
        if (calls === 1) {
          return {
            message: 'Reading, then one question.',
            actions: [
              {
                type: 'tool',
                tool: 'read_cells',
                args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
              },
              { type: 'ask', question: 'Which column should I sum?' },
            ],
          };
        }
        const read = input.toolResults.find((r) => r.tool === 'read_cells');
        const cells = (read?.data as { cells?: unknown[][] } | undefined)?.cells ?? [];
        const sum = cells
          .flat()
          .reduce((a: number, b: unknown) => a + (typeof b === 'number' ? b : 0), 0);
        return { message: `The sum is ${sum}.`, actions: [{ type: 'done' }] };
      },
    };
    const { host, runtime } = await makeRuntime({ backend });
    try {
      await seedSumFixture(host);
      const chatP = runtime.chat('t1', 'What is the sum of the values in column A of Sheet1?');
      const asks = await waitForPending(runtime);
      await runtime.answerPendingAsk(asks[0]!.id, 'column A');
      const reply = await chatP;
      expect(reply.message).toContain('The sum is 60.');
      // The post-ask plan call must carry the read result — before the
      // fix the ask recursion restarted with toolResults = [] and the
      // planner had to re-fetch (and often re-ask) from scratch.
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen[1]!.toolResults.some((r) => r.tool === 'read_cells' && r.ok)).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('surfaces the upstream planner error instead of a generic busy reply when the planner call throws (#143)', async () => {
    let calls = 0;
    const backend: ModelBackend = {
      name: 'planner-fix-down',
      async plan(): Promise<PlannerOutput> {
        calls++;
        throw new Error('openai-compatible backend: provider returned 429 (Resource exhausted)');
      },
    };
    const { runtime } = await makeRuntime({ backend });
    try {
      // Before #143 this exception ended the turn with a generic busy
      // message that hid the provider rejection (the Groq legs died
      // this way: the real detail never surfaced anywhere). The reply
      // now carries the upstream error verbatim-ish.
      const reply = await runtime.chat('t1', 'sum of A1:A3');
      expect(reply.message).toMatch(/provider returned 429.*Resource exhausted/);
      expect(reply.message).not.toMatch(/busy right now/i);
      expect(calls).toBe(1); // no runtime-level retry: the backend's own backoff already ran
    } finally {
      await runtime.close();
    }
  });
});

describe('#40 turn streaming hooks', () => {
  it('emits thinking/thought/tool events in order during a turn', async () => {
    const { host, runtime } = await makeRuntime({ backend: makeSumStub() });
    try {
      await seedSumFixture(host);
      const events: string[] = [];
      const reply = await runtime.chat('t-stream', 'What is the sum of A1:A3?', {
        onEvent: (e) => {
          events.push(
            e.type === 'thinking'
              ? `thinking:${e.iteration}`
              : e.type === 'thought'
                ? 'thought'
                : `tool:${e.phase}:${e.tool}`,
          );
        },
      });
      expect(reply.message).toContain('60');
      expect(events[0]).toMatch(/^thinking:/);
      expect(events.some((x) => x.startsWith('tool:start:'))).toBe(true);
      expect(events.some((x) => x.startsWith('tool:end:'))).toBe(true);
      // Every tool start is matched by an end before the turn returns.
      const starts = events.filter((x) => x.startsWith('tool:start:')).length;
      const ends = events.filter((x) => x.startsWith('tool:end:')).length;
      expect(ends).toBe(starts);
    } finally {
      await runtime.close();
    }
  });

  it('a fired cancel hook stops the turn with an honest stopped reply', async () => {
    const { host, runtime } = await makeRuntime({ backend: makeSumStub() });
    try {
      await seedSumFixture(host);
      const reply = await runtime.chat('t-cancel', 'What is the sum of A1:A3?', {
        isCancelled: () => true,
      });
      expect(reply.message).toContain('Stopped');
    } finally {
      await runtime.close();
    }
  });
});

describe('#141 generate_app loop tool', () => {
  /** Scripted planner: first iteration builds an app, then done. */
  function makeAppStub(): ModelBackend {
    return {
      name: 'stub-app',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        if (input.iteration > 1) {
          return { message: 'Built your app — open it beside the chat.', actions: [{ type: 'done' }] };
        }
        return {
          message: 'Building the app.',
          actions: [
            {
              type: 'tool',
              tool: 'generate_app',
              args: { prompt: 'build me a sortable app for the schedule' },
            },
          ],
        };
      },
    };
  }

  async function seedSchedule(host: EngineHost): Promise<void> {
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'Time' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'Event' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: '09:00' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 1 }, value: 'Standup' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 2, col: 0 }, value: '10:00' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 2, col: 1 }, value: 'Review' });
  }

  it('builds a real app artifact through the loop and attaches its spec to the reply', async () => {
    const store = createArtifactStore(memoryPersistence());
    const { host, runtime } = await makeRuntime({
      backend: makeAppStub(),
      artifactStore: store,
      appGenerator: new TemplateAppGenerator(),
    });
    try {
      await seedSchedule(host);
      const reply = await runtime.chat('t-app', 'build me a sortable app for the schedule');
      expect(reply.artifact).toBeDefined();
      expect(reply.artifact!.kind).toBe('react-app');
      expect(reply.artifact!.source).toContain('function App(');
      // Persisted: the Apps tab can list and reopen it by id.
      expect(store.all()).toHaveLength(1);
      expect(store.all()[0].id).toBe(reply.artifact!.id);
    } finally {
      await runtime.close();
    }
  });

  it('fails honestly with no artifact when the runtime has no artifact store', async () => {
    const { host, runtime } = await makeRuntime({ backend: makeAppStub() });
    try {
      await seedSchedule(host);
      const reply = await runtime.chat('t-app-nostore', 'build me a sortable app for the schedule');
      expect(reply.artifact).toBeUndefined();
      const entry = reply.actionsTaken.find(
        (e) => e.kind === 'tool_call' && e.tool === 'generate_app',
      );
      expect(entry?.ok).toBe(false);
      expect(entry?.summary).toMatch(/not configured/);
    } finally {
      await runtime.close();
    }
  });
});

describe('#138 create_diagram loop tool', () => {
  function makeDiagramStub(layout: unknown, items: unknown): ModelBackend {
    return {
      name: 'stub-diagram',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        if (input.iteration > 1) {
          return { message: 'Created the diagram.', actions: [{ type: 'done' }] };
        }
        return {
          message: 'Creating the diagram.',
          actions: [{ type: 'tool', tool: 'create_diagram', args: { layout, items, title: 'Order process' } }],
        };
      },
    };
  }

  it('attaches the model-generated diagram spec to the reply', async () => {
    const { host, runtime } = await makeRuntime({
      backend: makeDiagramStub('process', ['Order', 'Ship', 'Deliver']),
    });
    try {
      await seedSumFixture(host);
      const reply = await runtime.chat('t-diag', 'show the order process as a diagram');
      expect(reply.diagram).toEqual({
        layout: 'process',
        items: ['Order', 'Ship', 'Deliver'],
        title: 'Order process',
      });
    } finally {
      await runtime.close();
    }
  });

  it('fails honestly on an invalid layout, with no diagram attached', async () => {
    const { host, runtime } = await makeRuntime({
      backend: makeDiagramStub('not-a-layout', ['A', 'B']),
    });
    try {
      await seedSumFixture(host);
      const reply = await runtime.chat('t-diag-bad', 'show a diagram');
      expect(reply.diagram).toBeUndefined();
      const entry = reply.actionsTaken.find(
        (e) => e.kind === 'tool_call' && e.tool === 'create_diagram',
      );
      expect(entry?.ok).toBe(false);
      expect(entry?.summary).toMatch(/layout must be one of/);
    } finally {
      await runtime.close();
    }
  });
});

describe('#140 chart generation via the LLM loop', () => {
  it('a plain chart prompt through analyze_data yields a panel chart attachment', async () => {
    const { host, runtime } = await makeRuntime({ backend: makeAnalyzeStub() });
    try {
      const rows: (string | number)[][] = [
        ['Region', 'Sales'],
        ['North', 100],
        ['South', 200],
        ['North', 150],
      ];
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r]!.length; c++) {
          host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: r, col: c }, value: rows[r]![c]! });
        }
      }
      const reply = await runtime.chat('t-chart-plain', 'show me a chart of sales');
      expect(reply.needsInput).toBeUndefined();
      // The loop's chart route: analyze_data -> chartSpec -> reply.chart
      // (the panel renders it via AgentMsgChart, inline + expand).
      expect(reply.chart).toBeDefined();
      expect(reply.chart!.title).toBeTruthy();
      expect(reply.chart!.config.data?.datasets?.length ?? 0).toBeGreaterThan(0);
      const tools = reply.actionsTaken.filter((e) => e.kind === 'tool_call').map((e) => e.tool);
      expect(tools).toContain('analyze_data');
    } finally {
      await runtime.close();
    }
  }, 30000);
});
