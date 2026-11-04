/**
 * MCP report tools: the AI Agent's generate/edit surface for report specs
 * (design-docs/native-reports-and-dashboards.md §2;
 * design-docs/report-duplicates-preserved.md: "The AI Agent can generate
 * report specs through MCP tools"). Exercises create/get/list/update/
 * delete through the real MCP protocol surface, plus validation and auth
 * behavior. Follows the appbuilder_* test pattern.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import {
  makeReportSpec,
  validateReportSpec,
  type ReportSpec,
} from '@icecream-sheets/service';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): { payload: Record<string, unknown>; isError?: boolean } {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
  expect(res.content[0].type).toBe('text');
  return { payload: JSON.parse(res.content[0].text) as Record<string, unknown>, isError: res.isError };
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
): Promise<{ payload: Record<string, unknown>; isError?: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  return payloadOf(result);
}

/** A minimal valid report spec, as plain JSON. */
function validSpec(id?: string): Record<string, unknown> {
  const spec: ReportSpec = makeReportSpec({
    ...(id ? { id } : {}),
    name: 'Sales report',
    bindings: [
      {
        id: 'b1',
        sheet: 'Sheet1',
        startRow: 0,
        startCol: 0,
        endRow: 10,
        endCol: 2,
        headerRow: 0,
        fields: ['Region', 'Sales'],
      },
    ],
    visuals: [{ id: 'v1', kind: 'table', bindingId: 'b1', title: 'Sales', fields: ['Region', 'Sales'], maxRows: 50 }],
  });
  expect(validateReportSpec(spec)).toEqual([]);
  return JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
}

describe('report_* MCP tools', () => {
  it('creates, gets, lists, updates and deletes a report spec', async () => {
    const client = await makeClient();

    const created = await call(client, 'report_create_spec', { spec: validSpec() });
    expect(created.isError).toBeFalsy();
    const id = (created.payload.report as Record<string, unknown>).id as string;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const listed = await call(client, 'report_list_specs', {});
    expect(listed.isError).toBeFalsy();
    expect((listed.payload.reports as unknown[])).toHaveLength(1);

    const fetched = await call(client, 'report_get_spec', { id });
    expect(fetched.isError).toBeFalsy();
    expect((fetched.payload.report as Record<string, unknown>).name).toBe('Sales report');

    const updatedSpec = { ...validSpec(id), name: 'Sales report v2' };
    const updated = await call(client, 'report_update_spec', { id, spec: updatedSpec });
    expect(updated.isError).toBeFalsy();
    expect((updated.payload.report as Record<string, unknown>).name).toBe('Sales report v2');

    const removed = await call(client, 'report_delete_spec', { id });
    expect(removed.isError).toBeFalsy();
    expect(removed.payload.removed).toBe(true);

    const listed2 = await call(client, 'report_list_specs', {});
    expect((listed2.payload.reports as unknown[])).toHaveLength(0);

    const missing = await call(client, 'report_get_spec', { id });
    expect(missing.isError).toBe(true);
  });

  it('rejects an invalid report spec with the validation errors', async () => {
    const client = await makeClient();
    const bad = validSpec();
    bad.visuals = [{ id: 'v9', kind: 'table', bindingId: 'no-such-binding', title: 'X' }];
    const res = await call(client, 'report_create_spec', { spec: bad });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.payload)).toMatch(/invalid report spec/);
    const listed = await call(client, 'report_list_specs', {});
    expect((listed.payload.reports as unknown[])).toHaveLength(0);
  });

  it('rejects duplicate ids and id mismatches on update', async () => {
    const client = await makeClient();
    const first = await call(client, 'report_create_spec', { spec: validSpec('r_dup') });
    expect(first.isError).toBeFalsy();
    const dup = await call(client, 'report_create_spec', { spec: validSpec('r_dup') });
    expect(dup.isError).toBe(true);
    const mismatch = await call(client, 'report_update_spec', {
      id: 'r_dup',
      spec: validSpec('other'),
    });
    expect(mismatch.isError).toBe(true);
    expect(JSON.stringify(mismatch.payload)).toMatch(/does not match/);
  });

  it('errors on unknown ids for update and delete', async () => {
    const client = await makeClient();
    const upd = await call(client, 'report_update_spec', { id: 'nope', spec: validSpec('nope') });
    expect(upd.isError).toBe(true);
    const del = await call(client, 'report_delete_spec', { id: 'nope' });
    expect(del.isError).toBe(true);
  });
});
