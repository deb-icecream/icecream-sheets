/**
 * AgentRuntime thread-persistence tests (ai-agent.md §9, §12):
 * two runtime instances sharing one Persistence adapter see the same
 * threads, and a paused human-in-the-loop turn resumes mid-thought
 * after a "restart".
 */
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '@icecream-sheets/mcp-server';
import { EngineHost } from '@icecream-sheets/engine';
import { AgentRuntime } from '../src/agent/runtime.js';
import { memoryPersistence, type Persistence } from '../src/metadataStore.js';
import type { ModelBackend, PlannerInput, PlannerOutput } from '../src/agent/types.js';

/**
 * #137 test stubs: the heuristic planner was DELETED. Sum/recalc/ask
 * stubs stand in for a model; thread persistence (not planning) is
 * the subject.
 */
function makeSumStub(): ModelBackend {
  return {
    name: 'stub-sum',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.toolResults.length > 0) {
        const matrix = (input.toolResults[0]!.data as { cells?: unknown[][] } | null)?.cells;
        let sum = 0;
        if (Array.isArray(matrix)) {
          for (const row of matrix) {
            for (const cell of row) {
              if (typeof cell === 'number') sum += cell;
            }
          }
        }
        return { message: `The sum is ${sum}.`, actions: [{ type: 'done' }] };
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

function makeRecalcStub(): ModelBackend {
  return {
    name: 'stub-recalc',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.iteration > 1) return { message: 'Done.', actions: [{ type: 'done' }] };
      return { message: '', actions: [{ type: 'tool', tool: 'recalculate', args: {} }] };
    },
  };
}

function makeAskStub(): ModelBackend {
  return {
    name: 'stub-ask',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (/blorple/i.test(input.userText)) {
        return {
          message: '',
          actions: [
            {
              type: 'ask',
              question: 'What should I do with this?',
              options: ['Sum a range', 'Something else'],
              intentChoice: true,
            },
          ],
        };
      }
      // Resumed turn after the answer: park on a follow-up ask (the
      // scenario's second budgeted ask); closing aborts it cleanly.
      return {
        message: '',
        actions: [
          {
            type: 'ask',
            question: 'Which range should I sum?',
            options: ['A1:A3', 'Cancel'],
            intentChoice: true,
          },
        ],
      };
    },
  };
}
import { AGENT_THREAD_KEY_PREFIX } from '../src/agent/threads.js';

function makeRuntime(
  persistence: Persistence,
  principal = 'test-user',
  opts: { maxAsksPerTurn?: number; backend?: ModelBackend } = {},
) {
  const host = new EngineHost();
  // The MCP server shares the persistence adapter: pending human-in-the-loop
  // asks live in the service metadata store, so a "restart" (fresh server +
  // runtime over the same persistence) still sees them (ai-agent.md §12).
  const server: McpServer = createServer(host, { persistence });
  const runtime = new AgentRuntime({
    server,
    principal,
    userId: principal,
    threadPersistence: persistence,
    ...opts,
  });
  return { runtime, server, host };
}

function seedSumFixture(host: EngineHost) {
  host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 10 });
  host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 20 });
  host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 2, col: 0 }, value: 30 });
}

describe('AgentRuntime thread persistence', () => {
  it('persists history across runtime instances sharing a store', async () => {
    const persistence = memoryPersistence();
    const { runtime: r1, server: s1 } = makeRuntime(persistence, 'test-user', { backend: makeSumStub() });
    try {
      const reply = await r1.chat('thread-1', 'sum of A1:A3');
      expect(reply.message).toBeTruthy();
      expect(r1.getThreads()).toContain('thread-1');
      expect(r1.getHistory('thread-1').length).toBeGreaterThan(0);
    } finally {
      await r1.close();
      await s1.close();
    }

    // "Restart": a fresh runtime over the same persistence.
    const { runtime: r2, server: s2 } = makeRuntime(persistence, 'test-user', { backend: makeRecalcStub() });
    try {
      expect(r2.getThreads()).toContain('thread-1');
      const hist = r2.getHistory('thread-1');
      expect(hist.length).toBeGreaterThan(0);
      expect(hist[0]).toMatchObject({ role: 'user', text: 'sum of A1:A3' });
      // New turns append to the persisted thread. ('recalculate now' is
      // used because an unknown intent would now pause on a
      // human-in-the-loop ask via the agent.* tools instead of completing.)
      const r2reply = await r2.chat('thread-1', 'recalculate now');
      expect(r2reply.needsInput).toBeUndefined();
      expect(r2.getHistory('thread-1').length).toBeGreaterThan(hist.length);
    } finally {
      await r2.close();
      await s2.close();
    }

    expect(persistence.load(`${AGENT_THREAD_KEY_PREFIX}.test-user`)).toContain('thread-1');
  });

  it('a pending ask survives restart: a fresh runtime can answer it', async () => {
    const persistence = memoryPersistence();
    // Ask-budget alignment (FIX-R4 + M2): this scenario parks TWO asks in
    // one turn — the help menu, then a follow-up after the menu answer is
    // resumed (the recursion threads asksUsed, so the default budget of 1
    // would suppress the follow-up). The scenario predates the budget;
    // it verifies ask PERSISTENCE, so the turn is budgeted for both asks.
    const { runtime: r1, server: s1, host: h1 } = makeRuntime(persistence, 'test-user', {
      maxAsksPerTurn: 2,
      backend: makeAskStub(),
    });
    // Unknown intent -> the stub pauses via an intentChoice ask;
    // the turn blocks inside chat().
    const chatP = r1.chat('thread-ask', 'blorple the frabjous wobble');
    let askId: string | undefined;
    const start = Date.now();
    for (;;) {
      const asks = await r1.listPendingAsks();
      if (asks.length > 0) {
        askId = asks[0]!.id;
        break;
      }
      if (Date.now() - start > 8000) throw new Error('no pending ask appeared');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(askId).toBeTruthy();

    // "Restart": drop r1 (its blocked turn dies with the process) and bring
    // up a fresh runtime over the same persistence. The pending ask survived
    // in the metadata store and is still answerable.
    const { runtime: r2, server: s2 } = makeRuntime(persistence, 'test-user', { backend: makeSumStub() });
    try {
      const asks2 = await r2.listPendingAsks();
      expect(asks2.map((a) => a.id)).toContain(askId);
      // 'Sum a range' is one of the offered options; answering it replans
      // (and pauses on a follow-up ask, so we stop after one round).
      await r2.answerPendingAsk(askId!, 'Sum a range');
      // The answered ask is consumed by the unblocked waiter.
      const start2 = Date.now();
      for (;;) {
        const asks = await r2.listPendingAsks();
        if (!asks.some((a) => a.id === askId)) break;
        if (Date.now() - start2 > 8000) throw new Error('answered ask was never consumed');
        await new Promise((r) => setTimeout(r, 50));
      }
      // End the turn gracefully: closing the client aborts the blocked
      // follow-up wait with a clean timeout reply.
      await r1.close().catch(() => undefined);
      const reply = await chatP;
      expect(reply.needsInput).toBeUndefined();
      expect(reply.message).toMatch(/didn't get an answer in time/);
    } finally {
      await r2.close().catch(() => undefined);
      await s1.close().catch(() => undefined);
      await s2.close().catch(() => undefined);
    }
    expect(askId).toBeTruthy();
  });

  it('keeps threads per user separate', async () => {
    const persistence = memoryPersistence();
    const { runtime: ra, server: sa } = makeRuntime(persistence, 'alice', { backend: makeSumStub() });
    const { runtime: rb, server: sb } = makeRuntime(persistence, 'bob', { backend: makeSumStub() });
    try {
      await ra.chat('t', 'sum of A1:A3');
      expect(ra.getThreads()).toContain('t');
      expect(rb.getThreads()).not.toContain('t');
    } finally {
      await ra.close();
      await sa.close();
      await rb.close();
      await sb.close();
    }
  });

  it('works without threadPersistence (in-memory, previous behavior)', async () => {
    const host = new EngineHost();
    const server: McpServer = createServer(host);
    const runtime = new AgentRuntime({ server, principal: 'mem-user' });
    try {
      await runtime.chat('t-mem', 'sum of A1:A3');
      expect(runtime.getThreads()).toContain('t-mem');
      expect(runtime.getHistory('t-mem').length).toBeGreaterThan(0);
    } finally {
      await runtime.close();
      await server.close();
    }
  });
});
