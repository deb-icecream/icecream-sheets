/**
 * MCP app-builder tools: the AI Agent's generate/edit surface for app specs
 * (no-code-app-builder.md §3, ai-agent.md §2). Exercises create/get/list/
 * update/delete through the real MCP protocol surface, plus validation and
 * auth behavior.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
  expect(res.content[0].type).toBe('text');
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

async function makeClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  return payloadOf(result);
}

function validSpec(id?: string): Record<string, unknown> {
  return {
    ...(id ? { id } : {}),
    version: 1,
    name: 'Test App',
    dataSource: {
      kind: 'range',
      binding: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 5, endCol: 2, headerRow: true },
      columns: [
        { name: 'Name', type: 'text' },
        { name: 'Age', type: 'numeric' },
        { name: 'Hired', type: 'date' },
      ],
    },
    views: [
      { id: 'view_table', kind: 'table', title: 'Table' },
      { id: 'view_detail', kind: 'detail', title: 'Detail' },
      { id: 'view_form', kind: 'form', title: 'Form', formMode: 'both' },
      { id: 'view_cards', kind: 'cards', title: 'Cards', titleColumn: 'Name' },
    ],
    actions: [
      { id: 'action_add', kind: 'addRow', label: 'Add', requiresConfirm: false },
      { id: 'action_edit', kind: 'editRow', label: 'Edit', requiresConfirm: false },
      { id: 'action_delete', kind: 'deleteRow', label: 'Delete', requiresConfirm: true },
      { id: 'goto_detail', kind: 'navigate', label: 'Detail', targetViewId: 'view_detail', requiresConfirm: false },
    ],
    navigation: { initialViewId: 'view_table' },
  };
}

describe('appbuilder MCP tools', () => {
  it('create -> get -> list round-trips a spec', async () => {
    const client = await makeClient();
    const created = await call(client, 'appbuilder_create_spec', {
      spec: validSpec('app_e2e'),
      principal: 'ai-agent',
    });
    expect(created.ok).toBe(true);
    expect((created.app as { id: string }).id).toBe('app_e2e');

    const got = await call(client, 'appbuilder_get_spec', { id: 'app_e2e' });
    expect(got.ok).toBe(true);
    expect((got.app as { name: string }).name).toBe('Test App');
    expect((got.app as { version: number }).version).toBe(1);

    const listed = await call(client, 'appbuilder_list_specs', {});
    expect(listed.ok).toBe(true);
    const apps = listed.apps as { id: string; name: string }[];
    expect(apps.some((a) => a.id === 'app_e2e')).toBe(true);
  });

  it('assigns an id when the spec omits one', async () => {
    const client = await makeClient();
    const created = await call(client, 'appbuilder_create_spec', { spec: validSpec() });
    expect(created.ok).toBe(true);
    expect(typeof (created.app as { id: string }).id).toBe('string');
  });

  it('rejects invalid specs with validation errors', async () => {
    const client = await makeClient();
    const bad = await call(client, 'appbuilder_create_spec', {
      spec: { version: 1, name: '' },
    });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toMatch(/invalid app spec/);
  });

  it('rejects duplicate ids', async () => {
    const client = await makeClient();
    const first = await call(client, 'appbuilder_create_spec', { spec: validSpec('app_dup') });
    expect(first.ok).toBe(true);
    const second = await call(client, 'appbuilder_create_spec', { spec: validSpec('app_dup') });
    expect(second.ok).toBe(false);
    expect(String(second.error)).toMatch(/already exists/);
  });

  it('update replaces the spec; id mismatch is rejected', async () => {
    const client = await makeClient();
    await call(client, 'appbuilder_create_spec', { spec: validSpec('app_upd') });
    const next = validSpec('app_upd');
    next['name'] = 'Renamed';
    const updated = await call(client, 'appbuilder_update_spec', { id: 'app_upd', spec: next });
    expect(updated.ok).toBe(true);
    expect((updated.app as { name: string }).name).toBe('Renamed');

    const mismatch = await call(client, 'appbuilder_update_spec', {
      id: 'app_upd',
      spec: validSpec('other_id'),
    });
    expect(mismatch.ok).toBe(false);

    const missing = await call(client, 'appbuilder_update_spec', {
      id: 'ghost',
      spec: validSpec('ghost'),
    });
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toMatch(/unknown app spec/);
  });

  it('delete removes the spec', async () => {
    const client = await makeClient();
    await call(client, 'appbuilder_create_spec', { spec: validSpec('app_del') });
    const deleted = await call(client, 'appbuilder_delete_spec', { id: 'app_del' });
    expect(deleted.ok).toBe(true);
    const got = await call(client, 'appbuilder_get_spec', { id: 'app_del' });
    expect(got.ok).toBe(false);
    const again = await call(client, 'appbuilder_delete_spec', { id: 'app_del' });
    expect(again.ok).toBe(false);
  });

  it('migrates a versionless draft on create', async () => {
    const client = await makeClient();
    const draft = validSpec('app_migrate');
    delete draft['version'];
    const created = await call(client, 'appbuilder_create_spec', { spec: draft });
    expect(created.ok).toBe(true);
    const got = await call(client, 'appbuilder_get_spec', { id: 'app_migrate' });
    expect(got.ok).toBe(true);
    expect((got.app as { version: number }).version).toBe(1);
  });

  it('carries the caller principal on every call', async () => {
    const client = await makeClient();
    // The default-allow v1 policy accepts; the point is the principal is
    // accepted and threaded through authorize() without error.
    const created = await call(client, 'appbuilder_create_spec', {
      spec: validSpec('app_principal'),
      principal: 'debajyoti',
    });
    expect(created.ok).toBe(true);
    expect(created.protocolVersion).toBe(1);
  });
});
