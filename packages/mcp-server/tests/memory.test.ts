/**
 * Tests for the agent long-term memory tools (ai-agent.md §12).
 *
 * Durable-store migration: MemoryStore is async (AsyncPersistence seam);
 * every store call is awaited. The FIX-J read-modify-write merge semantics
 * are covered exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../src/server.js';
import { MemoryStore } from '../src/memory.js';
import {
  memoryAsyncPersistence,
  memoryPersistence,
  toAsyncPersistence,
  type AsyncPersistence,
} from '@icecream-sheets/service';

interface RpcText {
  type: 'text';
  text: string;
}

function payload(res: unknown): Record<string, unknown> {
  const r = res as { content: RpcText[]; isError?: boolean };
  if (r.isError) throw new Error(`tool error: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe('MemoryStore (unit)', () => {
  it('load misses on empty store', async () => {
    const m = new MemoryStore();
    await expect(m.load('u1', 'k')).resolves.toEqual({ found: false });
  });

  it('save then load round-trips JSON values', async () => {
    const m = new MemoryStore();
    await m.save('u1', 'prefs', { theme: 'dark', zoom: 1.25 });
    await expect(m.load('u1', 'prefs')).resolves.toEqual({
      found: true,
      value: { theme: 'dark', zoom: 1.25 },
    });
  });

  it('namespaces are per-user', async () => {
    const m = new MemoryStore();
    await m.save('alice', 'k', 1);
    await expect(m.load('bob', 'k')).resolves.toEqual({ found: false });
    await expect(m.keys('alice')).resolves.toEqual(['k']);
    await expect(m.keys('bob')).resolves.toEqual([]);
  });

  it('update merges plain objects', async () => {
    const m = new MemoryStore();
    await m.save('u1', 'prefs', { theme: 'dark', zoom: 1 });
    await expect(m.update('u1', 'prefs', { zoom: 2 })).resolves.toEqual({ theme: 'dark', zoom: 2 });
  });

  it('update replaces non-objects', async () => {
    const m = new MemoryStore();
    await m.save('u1', 'n', 5);
    await expect(m.update('u1', 'n', 6)).resolves.toBe(6);
    await m.save('u1', 's', 'a');
    await expect(m.update('u1', 's', { x: 1 })).resolves.toEqual({ x: 1 });
  });

  it('update on missing key creates it', async () => {
    const m = new MemoryStore();
    await expect(m.update('u1', 'new', [1, 2])).resolves.toEqual([1, 2]);
    await expect(m.load('u1', 'new')).resolves.toEqual({ found: true, value: [1, 2] });
  });
});

describe('MemoryStore over a SHARED persistence (FIX-J read-modify-write)', () => {
  it('(a) a fresh instance recalls what a previous instance saved (runtime swap)', async () => {
    const shared = toAsyncPersistence(memoryPersistence());
    const a = new MemoryStore(shared);
    await a.save('u1', 'budget', 5000);
    await a.save('u1', 'prefs', { theme: 'dark' });

    // The gateway runtime swap: a brand-new store over the same blob.
    const b = new MemoryStore(shared);
    await expect(b.load('u1', 'budget')).resolves.toEqual({ found: true, value: 5000 });
    await expect(b.load('u1', 'prefs')).resolves.toEqual({ found: true, value: { theme: 'dark' } });
    await expect(b.keys('u1').then((k) => k.sort())).resolves.toEqual(['budget', 'prefs']);
  });

  it("(b) two already-loaded instances do not clobber each other's saves", async () => {
    const shared = toAsyncPersistence(memoryPersistence());
    const a = new MemoryStore(shared);
    const b = new MemoryStore(shared);
    // Both instances load (empty) BEFORE either saves: under the old
    // whole-blob snapshot persist, B's save would erase A's key.
    await expect(a.keys('u1')).resolves.toEqual([]);
    await expect(b.keys('u1')).resolves.toEqual([]);

    await a.save('u1', 'key1', 'from-a');
    await b.save('u1', 'key2', 'from-b');

    const c = new MemoryStore(shared);
    await expect(c.load('u1', 'key1')).resolves.toEqual({ found: true, value: 'from-a' });
    await expect(c.load('u1', 'key2')).resolves.toEqual({ found: true, value: 'from-b' });
    await expect(c.keys('u1').then((k) => k.sort())).resolves.toEqual(['key1', 'key2']);
    // B adopted the merged blob on its own persist, so it sees key1 too.
    await expect(b.load('u1', 'key1')).resolves.toEqual({ found: true, value: 'from-a' });
  });

  it("(b2) this instance's keys win for keys it holds when both write the same key", async () => {
    const shared = toAsyncPersistence(memoryPersistence());
    const a = new MemoryStore(shared);
    const b = new MemoryStore(shared);
    await a.save('u1', 'k', 'a-first');
    await b.save('u1', 'k', 'b-second');
    const c = new MemoryStore(shared);
    await expect(c.load('u1', 'k')).resolves.toEqual({ found: true, value: 'b-second' });
  });

  it('(c) per-user isolation holds under the shared blob', async () => {
    const shared = toAsyncPersistence(memoryPersistence());
    const a = new MemoryStore(shared);
    const b = new MemoryStore(shared);
    await a.save('alice', 'k', 'alice-secret');
    await b.save('bob', 'k', 'bob-value');
    await b.save('bob', 'other', 42);

    const c = new MemoryStore(shared);
    await expect(c.load('alice', 'k')).resolves.toEqual({ found: true, value: 'alice-secret' });
    await expect(c.load('bob', 'k')).resolves.toEqual({ found: true, value: 'bob-value' });
    await expect(c.load('bob', 'other')).resolves.toEqual({ found: true, value: 42 });
    await expect(c.load('carol', 'k')).resolves.toEqual({ found: false });
    await expect(c.keys('alice')).resolves.toEqual(['k']);
    await expect(c.keys('bob').then((k) => k.sort())).resolves.toEqual(['k', 'other']);
    await expect(c.keys('carol')).resolves.toEqual([]);
  });

  it('clearUser drops the user from the shared blob (not resurrected by the merge)', async () => {
    const shared = toAsyncPersistence(memoryPersistence());
    const a = new MemoryStore(shared);
    await a.save('u1', 'k', 1);
    await a.save('u2', 'k', 2);
    await a.clearUser('u1');
    const c = new MemoryStore(shared);
    await expect(c.load('u1', 'k')).resolves.toEqual({ found: false });
    await expect(c.load('u2', 'k')).resolves.toEqual({ found: true, value: 2 });
  });

  it('corrupt persisted blob: starts empty, never throws, next save recovers', async () => {
    let blob: string | null = 'not json{{{';
    const corrupt: AsyncPersistence = {
      load: async () => blob,
      save: async (_k, v) => void (blob = v),
      clear: async () => void (blob = null),
    };
    const a = new MemoryStore(corrupt);
    await expect(a.load('u1', 'k')).resolves.toEqual({ found: false });
    await expect(a.save('u1', 'k', 'recovered')).resolves.toBeUndefined();
    const b = new MemoryStore(corrupt);
    await expect(b.load('u1', 'k')).resolves.toEqual({ found: true, value: 'recovered' });
  });

  it('persist failure is best-effort: in-memory state stays usable', async () => {
    const failing: AsyncPersistence = {
      load: async () => null,
      save: async () => {
        throw new Error('disk full');
      },
      clear: async () => {},
    };
    const a = new MemoryStore(failing);
    await expect(a.save('u1', 'k', 7)).resolves.toBeUndefined();
    await expect(a.load('u1', 'k')).resolves.toEqual({ found: true, value: 7 });
  });

  it('works over a native async adapter (memoryAsyncPersistence)', async () => {
    const m = new MemoryStore(memoryAsyncPersistence());
    await m.save('u1', 'k', 'v');
    await expect(m.load('u1', 'k')).resolves.toEqual({ found: true, value: 'v' });
  });
});

describe('memory tools (integration)', () => {
  async function harness() {
    const server: McpServer = createServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await server.connect(serverT);
    await client.connect(clientT);
    const call = async (name: string, args: Record<string, unknown>) =>
      payload(await client.callTool({ name, arguments: args }));
    return { call, close: async () => { await client.close(); await server.close(); } };
  }

  it('memory_save -> memory_load -> memory_update', async () => {
    const h = await harness();
    try {
      const miss = await h.call('memory_load', { userId: 'u9', key: 'prefs' });
      expect(miss.found).toBe(false);

      await h.call('memory_save', { userId: 'u9', key: 'prefs', value: { a: 1 } });
      const hit = await h.call('memory_load', { userId: 'u9', key: 'prefs' });
      expect(hit).toMatchObject({ found: true, value: { a: 1 } });

      const upd = await h.call('memory_update', { userId: 'u9', key: 'prefs', value: { b: 2 } });
      expect(upd.value).toEqual({ a: 1, b: 2 });
    } finally {
      await h.close();
    }
  });

  it('memory is isolated per user', async () => {
    const h = await harness();
    try {
      await h.call('memory_save', { userId: 'alice', key: 'k', value: 'secret' });
      const bob = await h.call('memory_load', { userId: 'bob', key: 'k' });
      expect(bob.found).toBe(false);
    } finally {
      await h.close();
    }
  });
});
