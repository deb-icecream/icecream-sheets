/**
 * Agent guardrails (user directive 2026-10-21): input cap, per-principal
 * rate + concurrency limits, reply-size bound, and the scope gate.
 *
 * Every guardrail is proven at the runtime boundary with a counting fake
 * backend: a guardrail reply must mean ZERO plan() calls (and therefore
 * zero tool calls), and every in-scope fixture must reach the backend.
 */
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '@icecream-sheets/mcp-server';
import { EngineHost } from '@icecream-sheets/engine';
import {
  AgentRuntime,
  AGENT_SCOPE_DECLINE_MESSAGE,
  type AgentRuntimeOptions,
} from '../src/agent/runtime.js';
import { classifyScope } from '../src/agent/intentRouter.js';
import type { ModelBackend, PlannerInput, PlannerOutput } from '../src/agent/types.js';
import type { PendingAskView } from '../src/agent/pendingAsks.js';
import type { MetadataStore } from '../src/metadataStore.js';
import type { ArtifactSpec } from '../src/artifacts/index.js';

/** Fake backend that records plan() calls; never touches tools by itself. */
class CountingBackend implements ModelBackend {
  readonly name = 'counting-fake';
  calls = 0;
  constructor(
    private readonly responder?: (
      input: PlannerInput,
      call: number,
    ) => PlannerOutput | Promise<PlannerOutput>,
  ) {}
  async plan(input: PlannerInput): Promise<PlannerOutput> {
    this.calls++;
    if (this.responder) return this.responder(input, this.calls);
    return { message: 'planned ok', actions: [{ type: 'done' }] };
  }
}

async function makeRuntime(
  backend: ModelBackend,
  opts: Partial<AgentRuntimeOptions> = {},
): Promise<AgentRuntime> {
  const host = new EngineHost();
  const server: McpServer = createServer(host);
  return new AgentRuntime({ server, backend, principal: 'guardrail-user', ...opts });
}

async function waitForPending(runtime: AgentRuntime, timeoutMs = 8000): Promise<PendingAskView[]> {
  const start = Date.now();
  for (;;) {
    const asks = await runtime.listPendingAsks();
    if (asks.length > 0) return asks;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a pending ask');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function guardrailEntries(runtime: AgentRuntime, threadId = 't1') {
  return runtime.getAuditLog(threadId).filter((e) => e.kind === 'guardrail');
}

// ---------------------------------------------------------------------------
// Fixtures: the validation-matrix prompt families.
// ---------------------------------------------------------------------------

const OFF_TOPIC_PROMPTS = [
  'what is the weather today?',
  'will it rain tomorrow?',
  'what are the top news headlines today?',
  'tell me a joke',
  'who won the game last night?',
  'how do I reverse a string in Python?',
  'write a Python function that sorts a list',
  'who is the president of France?',
  "translate 'good morning' into Spanish",
  'write an essay about the moon',
  // FIX-J tightened scope (user directive 2026-10-21 17:40 PDT): the
  // agent answers ONLY from (1) data in context via tools and (2)
  // icecream-sheets product knowledge — ALL general knowledge and
  // substantive chit-chat decline identically.
  'Who is Einstein?',
  'What is the capital of France?',
  'How tall is the Eiffel Tower?',
  'Tell me a fun fact about penguins',
  'Who won the football game last night?',
  "How's your day going?",
  'Tell me a joke',
];

const IN_SCOPE_PROMPTS = [
  // Case 1 — table query.
  'show me the first 5 rows of the Sales sheet where Region is West',
  // Case 2 — read / write.
  'set B2 to 42',
  'what is in Sheet1 A1:A3',
  // Case 3 — analysis + visualization.
  'analyze A1:D20 and show me a chart of revenue by month',
  // Case 3b/12 — app generation / app builder.
  'build an app that lets me browse the product table',
  'open the app builder to make an app for the inventory table',
  // Wider five — ETL, automation, reports, add-ons.
  'run the ETL recipe that loads orders into the Sales sheet',
  'create an automation that refreshes the data every morning',
  'generate a monthly sales report from this data',
  'install the currency converter add-on',
  // Memory.
  'remember that the budget is 5000',
  // Product how-to.
  'how do I freeze panes in this app?',
  // FIX-J counterweight: a product question about a spreadsheet feature
  // in this app stays in scope under the tightened two-source rule.
  'how do I create a pivot table in this app?',
  // Case 6 style — unfulfillable but about the workbook: still in scope.
  'delete the Q9 sheet',
  // Follow-up referencing prior context.
  'now do the same for column C',
  // Case 15 — borderline data question.
  'looking at this data, which product line looks strongest and why?',
  // Core verbs / ranges.
  'sum of A1:A3',
  'pivot sales by region and show a chart',
  'recalculate the workbook',
  // Greetings / agent-directed small talk.
  'hi',
  'what can you do?',
];

/**
 * FIX-J counterweight: a realistic, detailed in-scope data request of
 * ~1,500 characters. It must pass BOTH gates — the scope gate (it is a
 * data request, not general knowledge) and the length gate. The length
 * budget is asserted against 2,000 characters (the tightened input-cap
 * default), so this fixture keeps passing when the cap lands.
 */
const LONG_DETAILED_IN_SCOPE_PROMPT = [
  'Please analyze the Sales sheet in detail and prepare a complete regional revenue breakdown for me.',
  'Use the data in A1:H240, where column A is the order date, column B is the Region, column C is the Product line, column D is the sales rep, column E is Units sold, column F is Unit Price, column G is Discount percent, and column H is Revenue.',
  'First compute total revenue, total units, average unit price, and average discount for each Region, then break the same numbers down by Product line within each Region.',
  'Sort the regions by total revenue from highest to lowest, and inside each region sort the product lines by revenue from highest to lowest as well.',
  'Highlight any region and product line combination whose total revenue is below 2 percent of the overall revenue, and separately list the top 5 sales reps by revenue for each region.',
  'Compare this period with the previous period if the dates allow it, and call out any region where revenue fell by more than 10 percent.',
  'Then create a summary table with one row per region showing Region, total Revenue, total Units, average Discount, share of overall revenue as a percentage, and the name of the best-selling product line in that region.',
  'Finally, show me a chart of revenue by region, and write the summary table into a new sheet named Regional Summary starting at cell A1, keeping all of the numbers formatted as currency where they are money values.',
  'Please also explain any caveats about missing or zero values in the Revenue column before you give me the final numbers, so I know how much to trust the period comparison.',
].join(' ');

describe('classifyScope', () => {
  it('classifies every off-topic fixture as off-topic', () => {
    for (const p of OFF_TOPIC_PROMPTS) {
      expect(classifyScope(p), p).toBe('off-topic');
    }
  });

  it('classifies every in-scope fixture as in-scope', () => {
    for (const p of IN_SCOPE_PROMPTS) {
      expect(classifyScope(p), p).toBe('in-scope');
    }
  });

  it('treats weather DATA questions as in-scope', () => {
    expect(classifyScope('analyze the weather data in this table')).toBe('in-scope');
    expect(classifyScope('chart the rainfall trend in Sheet1')).toBe('in-scope');
  });
});

describe('input cap', () => {
  it('rejects a 10,000-char input naming the limit, with zero plan() calls', async () => {
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      const reply = await runtime.chat('t1', 'a'.repeat(10_000));
      expect(reply.message).toContain('too long');
      expect(reply.message).toContain('2,000');
      expect(reply.message).toContain('10,000');
      // The rationale rides along (user directive 2026-10-21 17:34 PDT):
      // longer content belongs in a file/data source the agent reads.
      expect(reply.message).toContain('file or a data source');
      expect(backend.calls).toBe(0);
      // Audit-logged as a guardrail rejection.
      const entries = guardrailEntries(runtime);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.summary).toMatch(/input too long/);
      // Not stored as a user message: history holds a system notice only.
      const hist = runtime.getHistory('t1');
      expect(hist.some((m) => m.role === 'user')).toBe(false);
      expect(hist.some((m) => m.role === 'system' && m.text === reply.message)).toBe(true);
      // The thread is not poisoned: a normal turn still works afterwards.
      const ok = await runtime.chat('t1', 'sum of A1:A3');
      expect(ok.message).toBe('planned ok');
      expect(backend.calls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it('rejects a 2,001-char input (just over the 2,000 cap)', async () => {
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      const reply = await runtime.chat('t1', 'a'.repeat(2_001));
      expect(reply.message).toContain('limit is 2,000 characters');
      expect(reply.message).toContain('2,001');
      expect(backend.calls).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it('accepts a 1,999-char in-scope input (just under the 2,000 cap)', async () => {
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      const base = 'sum of A1:A3 ';
      const text = base + 'x'.repeat(1_999 - base.length);
      expect(text.length).toBe(1_999);
      const reply = await runtime.chat('t1', text);
      expect(reply.message).toBe('planned ok');
      expect(backend.calls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it('rejects an over-cap createAppArtifact prompt before any tool activity', async () => {
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      const store = {} as unknown as MetadataStore<ArtifactSpec>;
      await expect(
        runtime.createAppArtifact('t1', 'x'.repeat(10_001), { store }),
      ).rejects.toThrow(/limit is 2,000 characters \(yours was 10,001\)/);
      expect(backend.calls).toBe(0);
      expect(guardrailEntries(runtime)[0]!.summary).toMatch(/app prompt too long/);
    } finally {
      await runtime.close();
    }
  });

  it('rejects an over-cap answer() without consuming the pending ask', async () => {
    // Fixture aligned to the FIX-R4 grounding gate: a first-move ask is
    // suppressed ungrounded, so the planner grounds with a tool call
    // before its question may park. What this test verifies is unchanged:
    // an over-cap answer() is rejected and the parked ask survives it.
    const backend = new CountingBackend(async (input, call) => {
      if (call === 1) {
        return {
          message: 'Looking first.',
          actions: [{ type: 'tool', tool: 'list_sheets', args: {} }],
        };
      }
      if (call === 2) {
        return { message: 'One question first.', actions: [{ type: 'ask', question: 'What?' }] };
      }
      return { message: `Heard: ${input.userText}`, actions: [{ type: 'done' }] };
    });
    const runtime = await makeRuntime(backend);
    try {
      const chatP = runtime.chat('t1', 'sum of A1:A3');
      const asks = await waitForPending(runtime);
      expect(asks).toHaveLength(1);
      const rejected = await runtime.answer('t1', 'y'.repeat(5_000));
      expect(rejected.message).toContain('2,000');
      // The pending ask is still there, unconsumed.
      expect(await runtime.listPendingAsks()).toHaveLength(1);
      // A normal answer still unblocks the parked turn.
      const ack = await runtime.answer('t1', 'the blue one');
      expect(ack.message).toMatch(/recorded/i);
      const reply = await chatP;
      expect(reply.message).toContain('Heard: the blue one');
    } finally {
      await runtime.close();
    }
  });

  it('honors the AGENT_MAX_INPUT_CHARS env override', async () => {
    process.env.AGENT_MAX_INPUT_CHARS = '10';
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      const reply = await runtime.chat('t1', 'sum of A1:A3 please'); // 19 chars > 10
      expect(reply.message).toContain('limit is 10 characters');
      expect(backend.calls).toBe(0);
    } finally {
      delete process.env.AGENT_MAX_INPUT_CHARS;
      await runtime.close();
    }
  });
});

describe('scope gate (runtime)', () => {
  it('declines every off-topic fixture with zero plan() calls and a capabilities reply', async () => {
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      for (const p of OFF_TOPIC_PROMPTS) {
        const reply = await runtime.chat('t1', p);
        expect(reply.message, p).toBe(AGENT_SCOPE_DECLINE_MESSAGE);
        expect(reply.message).toContain('I can read and write cells and ranges');
      }
      expect(backend.calls).toBe(0);
      const entries = guardrailEntries(runtime);
      expect(entries).toHaveLength(OFF_TOPIC_PROMPTS.length);
      for (const e of entries) expect(e.summary).toMatch(/scope decline/);
      // Declines are not stored as user messages.
      expect(runtime.getHistory('t1').some((m) => m.role === 'user')).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it('lets every in-scope fixture reach the backend', async () => {
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      for (const p of IN_SCOPE_PROMPTS) {
        const before = backend.calls;
        const reply = await runtime.chat('t1', p);
        expect(reply.message, p).toBe('planned ok');
        expect(backend.calls, p).toBe(before + 1);
      }
    } finally {
      await runtime.close();
    }
  });

  it('lets a ~1,500-char detailed in-scope request reach the backend (scope gate + 2,000-char length gate)', async () => {
    // Fixture sanity: genuinely ~1,500 chars, and inside the tightened
    // 2,000-char length budget it must survive.
    expect(LONG_DETAILED_IN_SCOPE_PROMPT.length).toBeGreaterThan(1_400);
    expect(LONG_DETAILED_IN_SCOPE_PROMPT.length).toBeLessThan(2_000);
    expect(classifyScope(LONG_DETAILED_IN_SCOPE_PROMPT)).toBe('in-scope');
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      const reply = await runtime.chat('t1', LONG_DETAILED_IN_SCOPE_PROMPT);
      expect(reply.message).toBe('planned ok');
      expect(backend.calls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it('scope gate disabled via option lets off-topic prompts reach the backend', async () => {
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend, { scopeGateEnabled: false });
    try {
      const reply = await runtime.chat('t1', 'what is the weather today?');
      expect(reply.message).toBe('planned ok');
      expect(backend.calls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("scope gate disabled via AGENT_SCOPE_GATE=0 env", async () => {
    process.env.AGENT_SCOPE_GATE = '0';
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      const reply = await runtime.chat('t1', 'tell me a joke');
      expect(reply.message).toBe('planned ok');
      expect(backend.calls).toBe(1);
    } finally {
      delete process.env.AGENT_SCOPE_GATE;
      await runtime.close();
    }
  });
});

describe('rate + concurrency limits', () => {
  it('rate: with maxTurnsPerMinute=3 the 4th rapid chat gets the rate reply, no extra plan()', async () => {
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend, { maxTurnsPerMinute: 3 });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await runtime.chat('t1', 'sum of A1:A3');
        expect(r.message).toBe('planned ok');
      }
      expect(backend.calls).toBe(3);
      const limited = await runtime.chat('t1', 'sum of A1:A3');
      expect(limited.message).toContain('too quickly');
      expect(limited.message).toContain('3 requests per minute');
      expect(backend.calls).toBe(3);
      expect(guardrailEntries(runtime)[0]!.summary).toMatch(/rate limit/);
    } finally {
      await runtime.close();
    }
  });

  it('concurrency: with maxConcurrentTurns=1 a second chat gets the busy reply while the first completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const backend = new CountingBackend(async (_input, call) => {
      if (call === 1) await gate;
      return { message: 'planned ok', actions: [{ type: 'done' }] };
    });
    const runtime = await makeRuntime(backend, { maxConcurrentTurns: 1 });
    try {
      const first = runtime.chat('t1', 'sum of A1:A3');
      // Wait until the first turn is inside plan().
      for (let i = 0; i < 100 && backend.calls === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(backend.calls).toBe(1);
      const busy = await runtime.chat('t1', 'sum of A1:A3');
      expect(busy.message).toContain("I'm still working on your previous request");
      expect(backend.calls).toBe(1);
      expect(guardrailEntries(runtime)[0]!.summary).toMatch(/concurrency limit/);
      // watch/pollWatch are NOT blocked by the turn counters.
      const subId = await runtime.watch(['cells_changed'], 'Sheet1');
      expect(await runtime.pollWatch(subId)).toEqual([]);
      await runtime.unwatch(subId);
      release();
      const done = await first;
      expect(done.message).toBe('planned ok');
      // After release, the runtime admits new turns again.
      const after = await runtime.chat('t1', 'sum of A1:A3');
      expect(after.message).toBe('planned ok');
      expect(backend.calls).toBe(2);
    } finally {
      await runtime.close();
    }
  });
});

describe('reply-size bound', () => {
  it('truncates a 20,000-char reply at the 8,000 cap with a notice suffix', async () => {
    const backend = new CountingBackend(async () => ({
      message: 'y'.repeat(20_000),
      actions: [{ type: 'done' }],
    }));
    const runtime = await makeRuntime(backend);
    try {
      const reply = await runtime.chat('t1', 'sum of A1:A3');
      expect(reply.message.length).toBe(8_000);
      expect(reply.message).toContain('[reply truncated at the 8,000-character limit]');
      // History carries the same bounded text the user saw.
      const agentMsg = runtime.getHistory('t1').find((m) => m.role === 'agent');
      expect(agentMsg!.text).toBe(reply.message);
    } finally {
      await runtime.close();
    }
  });

  it('honors a custom maxReplyChars', async () => {
    const backend = new CountingBackend(async () => ({
      message: 'z'.repeat(500),
      actions: [{ type: 'done' }],
    }));
    const runtime = await makeRuntime(backend, { maxReplyChars: 100 });
    try {
      const reply = await runtime.chat('t1', 'sum of A1:A3');
      expect(reply.message.length).toBe(100);
      expect(reply.message).toContain('100-character limit');
    } finally {
      await runtime.close();
    }
  });

  it('leaves short replies untouched', async () => {
    const backend = new CountingBackend();
    const runtime = await makeRuntime(backend);
    try {
      const reply = await runtime.chat('t1', 'sum of A1:A3');
      expect(reply.message).toBe('planned ok');
    } finally {
      await runtime.close();
    }
  });
});
