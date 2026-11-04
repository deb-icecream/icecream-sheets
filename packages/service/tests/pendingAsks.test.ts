/**
 * PendingAskStore unit tests (design-docs/ai-agent.md §12).
 *
 * The single shared implementation behind the agent.ask_question /
 * agent.offer_options / agent.request_approval / agent.answer_pending /
 * agent.list_pending MCP tools: create/answer/wait/timeout, principal
 * scoping, and metadata-store persistence across restarts.
 */
import { describe, expect, it } from 'vitest';
import {
  parseApprovalAnswer,
  serializePendingAsks,
  deserializePendingAsks,
  toPendingAskView,
  type PendingAskStore,
} from '../src/agent/pendingAsks.js';
import { createEncryptedPendingAskStore } from '../src/secureStore.js';
import { memoryPersistence } from '../src/metadataStore.js';
import { KeyManager } from '../src/crypto.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function keys() {
  return new KeyManager(memoryPersistence());
}

async function encryptedStore(
  persistence = memoryPersistence(),
  k = keys(),
): Promise<PendingAskStore> {
  return createEncryptedPendingAskStore(persistence, k);
}

describe('PendingAskStore', () => {
  it('creates and reads back asks, scoped per principal', async () => {
    const s = await encryptedStore();
    const a1 = await s.create({ kind: 'question', principal: 'alice', question: 'Q1?' });
    await s.create({ kind: 'question', principal: 'bob', question: 'Q2?' });
    expect(a1.id).toMatch(/^ask_/);
    expect((await s.get(a1.id))?.question).toBe('Q1?');
    expect((await s.listFor('alice')).map((a) => a.question)).toEqual(['Q1?']);
    expect((await s.listFor('bob')).map((a) => a.question)).toEqual(['Q2?']);
    expect(await s.listFor('carol')).toEqual([]);
  });

  it('validates kind-specific payloads on create', async () => {
    const s = await encryptedStore();
    await expect(s.create({ kind: 'question', principal: 'a' })).rejects.toThrow(/question is required/);
    await expect(s.create({ kind: 'options', principal: 'a', question: 'Q?' })).rejects.toThrow(/at least 2 choices/);
    await expect(s.create({ kind: 'options', principal: 'a', question: 'Q?', options: ['only'] })).rejects.toThrow(/at least 2 choices/);
    await expect(s.create({ kind: 'approval', principal: 'a' })).rejects.toThrow(/action is required/);
    await expect(s.create({ kind: 'approval', principal: 'a', action: 'x' })).rejects.toThrow(/detail is required/);
    await expect(s.create({ kind: 'question', principal: '', question: 'Q?' })).rejects.toThrow(/principal is required/);
  });

  it('answer records the answer and notifies waiters', async () => {
    const s = await encryptedStore();
    const ask = await s.create({ kind: 'question', principal: 'alice', question: 'Q?' });
    const waited = s.waitForAnswer(ask.id, 5000);
    await sleep(50);
    const answered = await s.answer(ask.id, 'the answer', 'alice');
    expect(answered.answer).toBe('the answer');
    expect(answered.answeredAt).toBeGreaterThan(0);
    await expect(waited).resolves.toMatchObject({ answer: 'the answer' });
    // Consumed: gone from the store.
    expect(await s.get(ask.id)).toBeUndefined();
  });

  it('waitForAnswer on an already-answered ask resolves immediately', async () => {
    const s = await encryptedStore();
    const ask = await s.create({ kind: 'question', principal: 'alice', question: 'Q?' });
    await s.answer(ask.id, 'early', 'alice');
    await expect(s.waitForAnswer(ask.id, 5000)).resolves.toMatchObject({ answer: 'early' });
    expect(await s.get(ask.id)).toBeUndefined();
  });

  it('answer rejects unknown ids, double answers, and wrong principals', async () => {
    const s = await encryptedStore();
    await expect(s.answer('ask_nope', 'x', 'alice')).rejects.toThrow(/unknown pending ask/);
    const ask = await s.create({ kind: 'question', principal: 'alice', question: 'Q?' });
    await expect(s.answer(ask.id, 'x', 'bob')).rejects.toThrow(/not authorized/);
    await s.answer(ask.id, 'first', 'alice');
    // Already consumed by the waiter-less answer? No waiter was registered,
    // so the record stays with the answer recorded; a second answer throws.
    await expect(s.answer(ask.id, 'second', 'alice')).rejects.toThrow(/already answered/);
  });

  it('options answers must be one of the offered options', async () => {
    const s = await encryptedStore();
    const ask = await s.create({
      kind: 'options',
      principal: 'alice',
      question: 'Pick',
      options: ['a', 'b'],
    });
    await expect(s.answer(ask.id, 'c', 'alice')).rejects.toThrow(/one of the offered options/);
    // Still pending after the rejected answer.
    expect((await s.get(ask.id))?.answer).toBeUndefined();
    expect((await s.answer(ask.id, 'b', 'alice')).answer).toBe('b');
  });

  it('waitForAnswer rejects on timeout and consumes the stale ask', async () => {
    const s = await encryptedStore();
    const ask = await s.create({ kind: 'question', principal: 'alice', question: 'Q?' });
    await expect(s.waitForAnswer(ask.id, 120)).rejects.toThrow(/timed out after 120ms/);
    expect(await s.get(ask.id)).toBeUndefined();
    expect(await s.listFor('alice')).toEqual([]);
  });

  it('waitForAnswer on an unknown id rejects', async () => {
    const s = await encryptedStore();
    await expect(s.waitForAnswer('ask_nope', 500)).rejects.toThrow(/unknown pending ask/);
  });

  it('an answer on another store instance unblocks the waiter (poll)', async () => {
    const persistence = memoryPersistence();
    const k = keys();
    const s1 = await encryptedStore(persistence, k);
    const s2 = await encryptedStore(persistence, k);
    const ask = await s1.create({ kind: 'question', principal: 'alice', question: 'Q?' });
    const waited = s1.waitForAnswer(ask.id, 10_000);
    await sleep(50);
    await s2.answer(ask.id, 'via s2', 'alice');
    await expect(waited).resolves.toMatchObject({ answer: 'via s2' });
  }, 15000);

  it('pending asks survive a simulated restart (metadata store round-trip)', async () => {
    const persistence = memoryPersistence();
    const k = keys();
    const s1 = await encryptedStore(persistence, k);
    const ask = await s1.create({
      kind: 'approval',
      principal: 'alice',
      action: 'write_cells',
      detail: 'Write 5 cells.',
    });
    // "Restart": a fresh store over the same persistence.
    const s2 = await encryptedStore(persistence, k);
    const found = await s2.listFor('alice');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: ask.id,
      kind: 'approval',
      action: 'write_cells',
      detail: 'Write 5 cells.',
    });
    // Still answerable after the restart.
    expect((await s2.answer(ask.id, 'yes', 'alice')).answer).toBe('yes');
  });

  it('stored bytes are ciphertext, not plaintext', async () => {
    const persistence = memoryPersistence();
    const s = await encryptedStore(persistence);
    const ask = await s.create({
      kind: 'question',
      principal: 'alice',
      question: 'What is the super-secret launch code?',
    });
    await s.answer(ask.id, 'hunter2-classified', 'alice');
    const raw = persistence.load('icecream-sheets.secure.v1/__service__/icecream-sheets.agent.pending-asks.v1');
    expect(raw).not.toBeNull();
    for (const secret of ['super-secret launch code', 'hunter2-classified', 'alice']) {
      expect(raw as string).not.toContain(secret);
    }
    const env = JSON.parse(raw as string) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.ciphertext).toBe('string');
  });

  it('serialize/deserialize round-trips and drops corrupt records', async () => {
    const s = await encryptedStore();
    const ask = await s.create({ kind: 'question', principal: 'alice', question: 'Q?' });
    const json = serializePendingAsks([ask]);
    const back = deserializePendingAsks(json);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: ask.id, question: 'Q?' });
    expect(deserializePendingAsks('not json')).toEqual([]);
    expect(deserializePendingAsks(JSON.stringify({ asks: [{ id: 1, kind: 'bogus' }] }))).toEqual(
      [],
    );
  });

  it('toPendingAskView projects the list view', async () => {
    const s = await encryptedStore();
    const ask = await s.create({
      kind: 'options',
      principal: 'alice',
      question: 'Pick',
      options: ['a', 'b'],
    });
    expect(toPendingAskView(ask)).toMatchObject({
      id: ask.id,
      kind: 'options',
      principal: 'alice',
      question: 'Pick',
      options: ['a', 'b'],
      answered: false,
    });
  });

  it('remove drops an ask and fails its waiters', async () => {
    const s = await encryptedStore();
    const ask = await s.create({ kind: 'question', principal: 'alice', question: 'Q?' });
    const waited = s.waitForAnswer(ask.id, 5000);
    const assertion = expect(waited).rejects.toThrow(/removed/);
    await s.remove(ask.id, 'alice');
    await assertion;
    expect(await s.get(ask.id)).toBeUndefined();
    await expect(s.remove(ask.id, 'bob')).resolves.not.toThrow(); // missing: no-op
  });
});

describe('parseApprovalAnswer', () => {
  it('recognizes affirmative answers', async () => {
    for (const a of ['yes', 'Yes', 'y', 'ok', 'OK', 'approve', 'confirmed', 'proceed', 'sure']) {
      expect(parseApprovalAnswer(a).approved).toBe(true);
    }
  });

  it('recognizes negative answers', async () => {
    for (const a of ['no', 'No', 'n', 'nope', 'deny', 'rejected', 'cancel', 'stop']) {
      expect(parseApprovalAnswer(a).approved).toBe(false);
    }
  });

  it('treats ambiguous answers as denied with a note', async () => {
    const v = parseApprovalAnswer('maybe later');
    expect(v.approved).toBe(false);
    expect(v.note).toBe('maybe later');
  });
});
