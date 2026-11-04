/**
 * Tests for the human-in-the-loop MCP tools (design-docs/ai-agent.md §12):
 *
 * - agent.ask_question / agent.offer_options / agent.request_approval PAUSE
 *   the caller: the tool call blocks until agent.answer_pending delivers
 *   the human's answer (JSON-RPC allows delayed tool responses — no
 *   deadlock, no stdio special-casing).
 * - The wait always ends: a timeout returns a clean error, never a hang.
 * - Asks and answers are principal-scoped (ai-agent.md §3).
 * - Pending asks persist in the service metadata store across restarts.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { memoryPersistence } from '@icecream-sheets/service';
import { createServer, type ServerOptions } from '../src/server.js';

interface RpcText {
  type: 'text';
  text: string;
}

function raw(res: unknown): { ok: boolean; payload: Record<string, unknown>; text: string } {
  const r = res as { content: RpcText[]; isError?: boolean };
  const text = r.content[0]?.text ?? '';
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // leave empty
  }
  return { ok: !r.isError && payload.ok !== false, payload, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connectTo(server: McpServer): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'hitl-test', version: '0.1.0' });
  await client.connect(clientT);
  return client;
}

async function harness(options?: ServerOptions) {
  const server: McpServer = createServer(undefined, options);
  const client = await connectTo(server);
  // Client-side request timeout: always comfortably above the server's
  // HITL wait so the SERVER's timeout (the clean error) fires first.
  const call = (name: string, args: Record<string, unknown>, timeout = 60_000) =>
    client.callTool({ name, arguments: args }, undefined, { timeout }).then(raw);
  return {
    server,
    client,
    call,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

function asksOf(listRes: { payload: Record<string, unknown> }): Record<string, unknown>[] {
  return (listRes.payload.asks ?? []) as Record<string, unknown>[];
}

describe('agent.ask_question blocks until answered', () => {
  it('pauses the tool call until agent.answer_pending delivers the answer', async () => {
    const h = await harness({ hitlTimeoutMs: 30_000 });
    try {
      let settled = false;
      const pending = h
        .call('agent.ask_question', { question: 'Which range?', principal: 'alice' })
        .then((r) => {
          settled = true;
          return r;
        });
      await sleep(250);
      // Still blocked: the tool call has NOT returned.
      expect(settled).toBe(false);

      // The pending ask is visible via agent.list_pending while blocked.
      const list = await h.call('agent.list_pending', { principal: 'alice' });
      const asks = asksOf(list);
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ kind: 'question', question: 'Which range?' });
      const askId = asks[0]!.id as string;

      // The human answers through the answer tool (same client, second
      // in-flight request — the server handles both concurrently).
      const ans = await h.call('agent.answer_pending', {
        askId,
        answer: 'A1:A10',
        principal: 'alice',
      });
      expect(ans.ok).toBe(true);

      // The paused tool call unblocks with the answer as its result, and
      // the pending record is consumed.
      const done = await pending;
      expect(settled).toBe(true);
      expect(done.ok).toBe(true);
      expect(done.payload.answer).toBe('A1:A10');
      expect(asksOf(await h.call('agent.list_pending', { principal: 'alice' }))).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('agent.offer_options returns the selected option', async () => {
    const h = await harness({ hitlTimeoutMs: 30_000 });
    try {
      const pending = h.call('agent.offer_options', {
        question: 'Pick one',
        options: ['alpha', 'beta'],
        principal: 'alice',
      });
      await sleep(150);
      const asks = asksOf(await h.call('agent.list_pending', { principal: 'alice' }));
      expect(asks).toHaveLength(1);
      const askId = asks[0]!.id as string;

      // An answer outside the offered options is rejected; the ask stays pending.
      const bad = await h.call('agent.answer_pending', {
        askId,
        answer: 'gamma',
        principal: 'alice',
      });
      expect(bad.ok).toBe(false);
      expect(bad.text).toMatch(/one of the offered options/);
      expect(asksOf(await h.call('agent.list_pending', { principal: 'alice' }))).toHaveLength(1);

      const good = await h.call('agent.answer_pending', {
        askId,
        answer: 'beta',
        principal: 'alice',
      });
      expect(good.ok).toBe(true);
      const done = await pending;
      expect(done.ok).toBe(true);
      expect(done.payload.selected).toBe('beta');
    } finally {
      await h.close();
    }
  });

  it('agent.request_approval returns approved true/false and keeps ambiguous notes', async () => {
    const h = await harness({ hitlTimeoutMs: 30_000 });
    try {
      // Approve.
      const p1 = h.call('agent.request_approval', {
        action: 'write_cells',
        detail: 'Write 20 cells.',
        principal: 'alice',
      });
      await sleep(150);
      const id1 = asksOf(await h.call('agent.list_pending', { principal: 'alice' }))[0]!.id as string;
      await h.call('agent.answer_pending', { askId: id1, answer: 'yes', principal: 'alice' });
      const r1 = await p1;
      expect(r1.ok).toBe(true);
      expect(r1.payload.approved).toBe(true);
      expect(r1.payload.note).toBeUndefined();

      // Deny.
      const p2 = h.call('agent.request_approval', {
        action: 'write_cells',
        detail: 'Write 20 cells.',
        principal: 'alice',
      });
      await sleep(150);
      const id2 = asksOf(await h.call('agent.list_pending', { principal: 'alice' }))[0]!.id as string;
      await h.call('agent.answer_pending', { askId: id2, answer: 'no', principal: 'alice' });
      const r2 = await p2;
      expect(r2.ok).toBe(true);
      expect(r2.payload.approved).toBe(false);

      // Ambiguous: denied, text kept as a note — the agent must not guess.
      const p3 = h.call('agent.request_approval', {
        action: 'write_cells',
        detail: 'Write 20 cells.',
        principal: 'alice',
      });
      await sleep(150);
      const id3 = asksOf(await h.call('agent.list_pending', { principal: 'alice' }))[0]!.id as string;
      await h.call('agent.answer_pending', {
        askId: id3,
        answer: 'maybe later',
        principal: 'alice',
      });
      const r3 = await p3;
      expect(r3.ok).toBe(true);
      expect(r3.payload.approved).toBe(false);
      expect(r3.payload.note).toBe('maybe later');
    } finally {
      await h.close();
    }
  });
});

describe('HITL timeout', () => {
  it('returns a clean timeout error and consumes the stale ask', async () => {
    const h = await harness({ hitlTimeoutMs: 250 });
    try {
      const r = await h.call(
        'agent.ask_question',
        { question: 'Anybody there?', principal: 'alice' },
        10_000,
      );
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/timed out/);
      // The stale ask was consumed: nothing left pending.
      expect(asksOf(await h.call('agent.list_pending', { principal: 'alice' }))).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe('principal scoping (ai-agent.md §3)', () => {
  it('only the owning principal can see or answer an ask', async () => {
    const h = await harness({ hitlTimeoutMs: 30_000 });
    try {
      const pending = h.call('agent.ask_question', {
        question: "Alice's question",
        principal: 'alice',
      });
      await sleep(150);
      const askId = asksOf(await h.call('agent.list_pending', { principal: 'alice' }))[0]!
        .id as string;

      // Bob cannot answer Alice's ask.
      const bobAnswer = await h.call('agent.answer_pending', {
        askId,
        answer: 'sneaky',
        principal: 'bob',
      });
      expect(bobAnswer.ok).toBe(false);
      expect(bobAnswer.text).toMatch(/authorization denied/);

      // Bob cannot even see Alice's ask.
      expect(asksOf(await h.call('agent.list_pending', { principal: 'bob' }))).toEqual([]);
      // Alice still can.
      expect(asksOf(await h.call('agent.list_pending', { principal: 'alice' }))).toHaveLength(1);

      // Alice answers; the paused call unblocks.
      await h.call('agent.answer_pending', { askId, answer: 'mine', principal: 'alice' });
      const done = await pending;
      expect(done.payload.answer).toBe('mine');
    } finally {
      await h.close();
    }
  });

  it('answering an unknown ask is an error', async () => {
    const h = await harness();
    try {
      const r = await h.call('agent.answer_pending', {
        askId: 'ask_nope',
        answer: 'x',
        principal: 'alice',
      });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/unknown pending ask/);
    } finally {
      await h.close();
    }
  });
});

describe('pending asks survive restarts (metadata store round-trip)', () => {
  it('a pending ask is visible after a simulated restart', async () => {
    const persistence = memoryPersistence();
    const server1 = createServer(undefined, { persistence, hitlTimeoutMs: 30_000 });
    const c1 = await connectTo(server1);
    try {
      const pending = c1
        .callTool(
          { name: 'agent.ask_question', arguments: { question: 'Survive?', principal: 'alice' } },
          undefined,
          { timeout: 60_000 },
        )
        .then(raw);
      await sleep(150);

      // "Restart": a brand-new server over the same persistence.
      const server2 = createServer(undefined, { persistence, hitlTimeoutMs: 30_000 });
      const c2 = await connectTo(server2);
      try {
        const list = raw(
          await c2.callTool({ name: 'agent.list_pending', arguments: { principal: 'alice' } }),
        );
        const asks = asksOf(list);
        expect(asks).toHaveLength(1);
        expect(asks[0]).toMatchObject({ kind: 'question', question: 'Survive?' });
        const askId = asks[0]!.id as string;

        // Answer through the original server: the persisted record and the
        // live waiter are the same ask.
        const ans = raw(
          await c1.callTool({
            name: 'agent.answer_pending',
            arguments: { askId, answer: 'yes', principal: 'alice' },
          }),
        );
        expect(ans.ok).toBe(true);
        const done = await pending;
        expect(done.payload.answer).toBe('yes');
      } finally {
        await c2.close().catch(() => undefined);
        await server2.close().catch(() => undefined);
      }
    } finally {
      await c1.close().catch(() => undefined);
      await server1.close().catch(() => undefined);
    }
  });

  it('an answer recorded by another instance unblocks the waiter (store poll)', async () => {
    const persistence = memoryPersistence();
    const server1 = createServer(undefined, { persistence, hitlTimeoutMs: 30_000 });
    const server2 = createServer(undefined, { persistence, hitlTimeoutMs: 30_000 });
    const c1 = await connectTo(server1);
    const c2 = await connectTo(server2);
    try {
      const pending = c1
        .callTool(
          { name: 'agent.ask_question', arguments: { question: 'Cross?', principal: 'alice' } },
          undefined,
          { timeout: 60_000 },
        )
        .then(raw);
      await sleep(150);
      const askId = asksOf(
        raw(await c1.callTool({ name: 'agent.list_pending', arguments: { principal: 'alice' } })),
      )[0]!.id as string;

      // The answer lands on the OTHER server instance; server1's waiter
      // picks it up via its store poll.
      const ans = raw(
        await c2.callTool({
          name: 'agent.answer_pending',
          arguments: { askId, answer: 'cross-instance', principal: 'alice' },
        }),
      );
      expect(ans.ok).toBe(true);
      const done = await pending;
      expect(done.ok).toBe(true);
      expect(done.payload.answer).toBe('cross-instance');
    } finally {
      await c1.close().catch(() => undefined);
      await c2.close().catch(() => undefined);
      await server1.close().catch(() => undefined);
      await server2.close().catch(() => undefined);
    }
  });
});
