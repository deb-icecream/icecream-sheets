/**
 * Tests for MCP event subscriptions (track 28).
 * Drives the tools through a real McpServer + EngineHost via in-memory
 * transport, the same way the AI Agent consumes them.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EngineHost } from '@icecream-sheets/engine';
import { createServer } from '../src/server.js';
import { SubscriptionManager } from '../src/subscriptions.js';

interface RpcText {
  type: 'text';
  text: string;
}

function payload(res: unknown): Record<string, unknown> {
  const r = res as { content: RpcText[]; isError?: boolean };
  if (r.isError) throw new Error(`tool error: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

async function harness() {
  const host = new EngineHost();
  const server: McpServer = createServer(host);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverT);
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown>) =>
    payload(await client.callTool({ name, arguments: args }));
  return { host, client, call, close: async () => { await client.close(); await server.close(); } };
}

describe('SubscriptionManager (unit)', () => {
  let mgr: SubscriptionManager;
  let host: EngineHost;
  beforeEach(() => {
    mgr = new SubscriptionManager();
    host = new EngineHost();
    mgr.attach(host);
  });

  it('buffers cells_changed with A1 refs', () => {
    const id = mgr.subscribe(['cells_changed']);
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 42 });
    const events = mgr.poll(id);
    expect(events).toHaveLength(1);
    expect(events?.[0]?.type).toBe('cells_changed');
    expect((events?.[0]?.detail.refs as string[])[0]).toBe('Sheet1!A1');
  });

  it('routes recalc_complete', () => {
    const id = mgr.subscribe(['recalc_complete']);
    host.execute({ cmd: 'recalculate' });
    const events = mgr.poll(id);
    expect(events?.[0]?.type).toBe('recalc_complete');
  });

  it('routes sheet_added with name', () => {
    const id = mgr.subscribe(['sheet_added']);
    host.execute({ cmd: 'addSheet', name: 'Data' });
    const events = mgr.poll(id);
    expect(events?.[0]?.type).toBe('sheet_added');
    expect(events?.[0]?.detail.name).toBe('Data');
  });

  it('only delivers subscribed types', () => {
    const id = mgr.subscribe(['recalc_complete']);
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 1 }, value: 1 });
    expect(mgr.poll(id)).toHaveLength(0);
  });

  it('sheet filter limits cells_changed', () => {
    const id = mgr.subscribe(['cells_changed'], { sheet: 'Sheet1' });
    host.execute({ cmd: 'addSheet', name: 'Other' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Other', row: 0, col: 0 }, value: 1 });
    expect(mgr.poll(id)).toHaveLength(0);
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 2 });
    expect(mgr.poll(id)).toHaveLength(1);
  });

  it('unsubscribe stops delivery and poll returns null', () => {
    const id = mgr.subscribe(['cells_changed']);
    expect(mgr.unsubscribe(id)).toBe(true);
    expect(mgr.unsubscribe(id)).toBe(false);
    expect(mgr.poll(id)).toBeNull();
  });

  it('list reports buffered counts', () => {
    const id = mgr.subscribe(['cells_changed'], {}, 'alice');
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 });
    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(id);
    expect(list[0]?.principal).toBe('alice');
    expect(list[0]?.buffered).toBe(1);
  });

  it('poll drains and respects maxEvents', () => {
    const id = mgr.subscribe(['cells_changed']);
    for (let i = 0; i < 5; i++) {
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: i, col: 0 }, value: i });
    }
    expect(mgr.poll(id, 2)).toHaveLength(2);
    expect(mgr.poll(id)).toHaveLength(3);
    expect(mgr.poll(id)).toHaveLength(0);
  });

  it('caps the buffer at MAX_BUFFERED_EVENTS', () => {
    const id = mgr.subscribe(['cells_changed']);
    for (let i = 0; i < 600; i++) {
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: i, col: 0 }, value: i });
    }
    const list = mgr.list();
    expect(list[0]?.buffered).toBe(500);
  });

  it('sheet_removed subscriptions are accepted but never fire', () => {
    const id = mgr.subscribe(['sheet_removed']);
    host.execute({ cmd: 'recalculate' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 9 });
    expect(mgr.poll(id)).toHaveLength(0);
    expect(mgr.list()[0]?.events).toContain('sheet_removed');
  });
});

describe('subscription tools (integration)', () => {
  it('subscribe -> poll -> unsubscribe round trip', async () => {
    const h = await harness();
    try {
      const sub = await h.call('subscribe', { events: ['cells_changed'] });
      const sid = sub.subscriptionId as string;
      expect(sid).toMatch(/^sub_/);

      const listed = await h.call('list_subscriptions', {});
      expect((listed.subscriptions as unknown[])).toHaveLength(1);

      h.host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 2, col: 1 }, value: 'hi' });
      const polled = await h.call('poll_events', { subscriptionId: sid });
      const events = polled.events as { type: string; detail: { refs: string[] } }[];
      expect(events).toHaveLength(1);
      expect(events[0]?.detail.refs[0]).toBe('Sheet1!B3');

      const unsub = await h.call('unsubscribe', { subscriptionId: sid });
      expect(unsub.removed).toBe(true);
      const listed2 = await h.call('list_subscriptions', {});
      expect((listed2.subscriptions as unknown[])).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('rejects unknown subscription ids', async () => {
    const h = await harness();
    try {
      await expect(h.call('poll_events', { subscriptionId: 'sub_999' })).rejects.toThrow();
      await expect(h.call('unsubscribe', { subscriptionId: 'sub_999' })).rejects.toThrow();
    } finally {
      await h.close();
    }
  });

  it('rejects invalid event types at the schema level', async () => {
    const h = await harness();
    try {
      await expect(h.call('subscribe', { events: ['bogus'] })).rejects.toThrow();
      await expect(h.call('subscribe', { events: [] })).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
});
