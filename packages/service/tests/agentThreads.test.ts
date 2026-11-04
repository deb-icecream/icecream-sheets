/**
 * Tests for agent conversation threads in the service metadata store
 * (packages/service/src/agent/threads.ts, ai-agent.md §9).
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_THREAD_KEY_PREFIX,
  AGENT_THREAD_VERSION,
  createAgentThreadStore,
  deserializeThreads,
  MAX_THREAD_MESSAGES,
  migrateThread,
  newThread,
  serializeThreads,
  type AgentThread,
} from '../src/agent/threads.js';
import { memoryPersistence } from '../src/metadataStore.js';

function msg(role: 'user' | 'agent', text: string): { role: 'user' | 'agent'; text: string; ts: number } {
  return { role, text, ts: Date.now() };
}

describe('agent threads', () => {
  it('round-trips threads through serialize/deserialize', () => {
    const t = newThread('t1', 'u1', 'My chat');
    t.messages.push(msg('user', 'hi'), msg('agent', 'hello'));
    const json = serializeThreads('u1', [t]);
    const back = deserializeThreads(json);
    expect(back).toHaveLength(1);
    expect(back[0]!.threadId).toBe('t1');
    expect(back[0]!.userId).toBe('u1');
    expect(back[0]!.title).toBe('My chat');
    expect(back[0]!.messages.map((m) => m.text)).toEqual(['hi', 'hello']);
    expect(back[0]!.version).toBe(AGENT_THREAD_VERSION);
  });

  it('drops a legacy v1 paused-turn `pending` field on migration (ai-agent.md §12)', () => {
    // Pauses are human-in-the-loop tool-call pauses held by the runtime's
    // PendingAskStore — not fields on the thread record — so migration
    // deliberately drops a legacy `pending` field rather than round-tripping it.
    const raw = JSON.parse(serializeThreads('u1', [newThread('t1', 'u1', 'My chat')])) as {
      threads: Record<string, unknown>[];
    };
    raw.threads[0]!['pending'] = { kind: 'ask', question: 'Which?', toolResults: [], userText: 'hi' };
    const back = deserializeThreads(JSON.stringify(raw));
    expect(back).toHaveLength(1);
    expect((back[0] as unknown as Record<string, unknown>).pending).toBeUndefined();
  });

  it('caps messages at MAX_THREAD_MESSAGES (newest win)', () => {
    const t = newThread('t1', 'u1');
    for (let i = 0; i < MAX_THREAD_MESSAGES + 50; i++) t.messages.push(msg('user', `m${i}`));
    const back = deserializeThreads(serializeThreads('u1', [t]));
    expect(back[0]!.messages).toHaveLength(MAX_THREAD_MESSAGES);
    expect(back[0]!.messages[0]!.text).toBe('m50');
    expect(back[0]!.messages[MAX_THREAD_MESSAGES - 1]!.text).toBe(`m${MAX_THREAD_MESSAGES + 49}`);
  });

  it('tolerates corrupt payloads', () => {
    expect(deserializeThreads('not json')).toEqual([]);
    expect(deserializeThreads('{"threads": "nope"}')).toEqual([]);
    expect(deserializeThreads('{"threads": [{}, {"threadId": ""}]}')).toEqual([]);
  });

  it('dedupes threads by threadId', () => {
    const a = newThread('t1', 'u1');
    const b = newThread('t1', 'u1');
    expect(deserializeThreads(serializeThreads('u1', [a, b]))).toHaveLength(1);
  });

  it('migrates a version-0 record forward', () => {
    const migrated = migrateThread({
      version: 0,
      threadId: 'old',
      messages: [{ role: 'user', text: 'hey', ts: 1 }],
    });
    expect(migrated?.version).toBe(AGENT_THREAD_VERSION);
    expect(migrated?.title).toBe('old');
    expect(migrated?.messages).toHaveLength(1);
    expect(migrated?.pending).toBeUndefined();
  });

  it('rejects records from a newer version', () => {
    expect(migrateThread({ version: 999, threadId: 'x' })).toBeNull();
  });

  it('stores threads per user under a versioned key', () => {
    const persistence = memoryPersistence();
    const store = createAgentThreadStore(persistence, 'alice');
    const t = newThread('t1', 'alice');
    t.messages.push(msg('user', 'hello'));
    store.add(t);
    expect(persistence.load(`${AGENT_THREAD_KEY_PREFIX}.alice`)).toContain('"threadId":"t1"');
    // A different user gets a different, empty store.
    const bob = createAgentThreadStore(persistence, 'bob');
    expect(bob.all()).toEqual([]);
    expect(store.all().map((x) => x.threadId)).toEqual(['t1']);
  });

  it('requires a persistence adapter and a userId', () => {
    expect(() => createAgentThreadStore(null as never, 'u')).toThrow();
    expect(() => createAgentThreadStore(memoryPersistence(), '')).toThrow();
  });

  it('sanitizes malformed messages and pending turns', () => {
    const t = migrateThread({
      version: 1,
      threadId: 't',
      userId: 'u',
      messages: [{ role: 'hacker', text: 'x' }, { role: 'user', text: 'ok', ts: 5 }, null],
      pending: { kind: 'bogus', question: 1 },
    }) as AgentThread;
    expect(t.messages.map((m) => m.text)).toEqual(['ok']);
    expect(t.pending).toBeUndefined();
  });
});
