/**
 * Real principals on MCP tools (faces c/d/e).
 *
 * Every tool accepts an optional `principal`; authorize() enforces per
 * subject. Hidden cells are unreadable to non-exempt principals through
 * read_cells/get_results (no leak), and locked cells reject writes from
 * unauthorized principals through write_cells/set_formulas.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  Authorizer,
  EngineHost,
  ProtectionManager,
  allowAllPolicy,
} from '@icecream-sheets/engine';
import { createServer } from '../src/server.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  return payloadOf(result);
}

/** Server whose engine enforces protection: A1 hidden (owner exempt), sheet locked. */
async function makeProtectedClient(): Promise<Client> {
  const protection = new ProtectionManager();
  protection.setHiddenExemptPrincipals(['owner']);
  const host = new EngineHost(
    undefined,
    new Authorizer(protection.protectionPolicy(allowAllPolicy())),
  );
  host.setHiddenCheck((ref, principal) =>
    protection.isHiddenFrom(ref.sheet, ref.row, ref.col, principal),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  // Seed data as the owner, then hide A1 and lock the sheet.
  await call(client, 'write_cells', {
    cells: [
      { sheet: 'Sheet1', row: 0, col: 0, value: 'top-secret' },
      { sheet: 'Sheet1', row: 1, col: 0, value: 'public' },
    ],
    principal: 'owner',
  });
  protection.hideRanges('Sheet1', ['A1'], { principal: 'owner' });
  protection.protectSheet('Sheet1', undefined, {}, { principal: 'owner' });
  return client;
}

describe('MCP tool principals', () => {
  it('read_cells returns #PERM! for hidden cells to non-exempt principals', async () => {
    const client = await makeProtectedClient();
    const guest = await call(client, 'read_cells', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 0,
      principal: 'guest',
    });
    const cells = guest.cells as unknown[][];
    expect(cells[0]?.[0]).toEqual({ error: '#PERM!' });
    expect(cells[1]?.[0]).toBe('public');
    // Exempt owner sees the hidden value.
    const owner = await call(client, 'read_cells', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      principal: 'owner',
    });
    expect((owner.cells as unknown[][])[0]?.[0]).toBe('top-secret');
  });

  it('get_results never leaks hidden cells', async () => {
    const client = await makeProtectedClient();
    const res = await call(client, 'get_results', { sheet: 'Sheet1', principal: 'guest' });
    const cells = res.cells as unknown[][];
    expect(cells[0]?.[0]).toEqual({ error: '#PERM!' });
  });

  it('write_cells to a locked cell is denied for unauthorized principals', async () => {
    const client = await makeProtectedClient();
    const res = await call(client, 'write_cells', {
      cells: [{ sheet: 'Sheet1', row: 5, col: 5, value: 'x' }],
      principal: 'guest',
    });
    // Locked sheet: every cell locked by default -> write fails.
    expect(res.ok).toBe(false);
  });

  it('subscribe stamps the caller principal, not a hardcoded one', async () => {
    const client = await makeProtectedClient();
    const sub = await call(client, 'subscribe', {
      events: ['cells_changed'],
      principal: 'guest',
    });
    expect(sub.ok).toBe(true);
    const list = await call(client, 'list_subscriptions', {});
    const subs = list.subscriptions as { principal: string }[];
    expect(subs.some((s) => s.principal === 'guest')).toBe(true);
  });

  it('agent memory persists through the injected persistence', async () => {
    const { memoryPersistence } = await import('@icecream-sheets/service');
    const persistence = memoryPersistence();
    const [t1, s1] = InMemoryTransport.createLinkedPair();
    const server = createServer(undefined, { persistence });
    await server.connect(s1);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(t1);
    await call(client, 'memory_save', { userId: 'u1', key: 'k', value: 'v' });
    // A second server over the same persistence sees the value: the service
    // metadata store is the authority, not server-local state.
    const [t2, s2] = InMemoryTransport.createLinkedPair();
    const server2 = createServer(undefined, { persistence });
    await server2.connect(s2);
    const client2 = new Client({ name: 'c2', version: '0' });
    await client2.connect(t2);
    const loaded = await call(client2, 'memory_load', { userId: 'u1', key: 'k' });
    expect(loaded.found).toBe(true);
    expect(loaded.value).toBe('v');
  });
});
