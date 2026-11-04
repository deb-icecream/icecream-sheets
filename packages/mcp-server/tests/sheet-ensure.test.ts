/**
 * #63 — write_cells / set_formulas create a missing sheet.
 *
 * Before the fix, both tools wrote straight through execute() and every
 * write to a non-existent sheet failed ("Unknown sheet"); only the
 * table/data-source writes created sheets (addSheet first). The tools
 * now ensure the target sheet through the same execute() + authorize()
 * path: a principal denied 'sheet.add' gets that denial as the write
 * error and NO sheet is created (no permission bypass), and every cell
 * write still passes its own 'cell.write' authorization.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Authorizer, EngineHost } from '@icecream-sheets/engine';
import { createServer } from '../src/server.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
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

async function makeClient(host: EngineHost): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('#63 write tools ensure the target sheet exists', () => {
  it('write_cells creates a missing sheet and the values read back', async () => {
    const client = await makeClient(new EngineHost());
    const before = await call(client, 'list_sheets', {});
    expect(before.sheets).not.toContain('Brand New');

    const written = await call(client, 'write_cells', {
      cells: [
        { sheet: 'Brand New', row: 0, col: 0, value: 'Item' },
        { sheet: 'Brand New', row: 1, col: 0, value: 'Pens' },
        { sheet: 'Brand New', row: 1, col: 1, value: 5 },
      ],
    });
    expect(written.ok).toBe(true);
    expect(written.written).toBe(3);
    expect(written.errors).toEqual([]);

    const after = await call(client, 'list_sheets', {});
    expect(after.sheets).toContain('Brand New');

    const read = await call(client, 'get_results', { sheet: 'Brand New' });
    expect(read.ok).toBe(true);
    const cells = read.cells as unknown[][];
    expect(cells[0]?.[0]).toBe('Item');
    expect(cells[1]?.[0]).toBe('Pens');
    expect(cells[1]?.[1]).toBe(5);
  });

  it('set_formulas creates a missing sheet and the computed value reads back', async () => {
    const client = await makeClient(new EngineHost());
    const set = await call(client, 'set_formulas', {
      formulas: [{ sheet: 'Calc', row: 0, col: 0, formula: '=1+2' }],
    });
    expect(set.ok).toBe(true);
    expect(set.written).toBe(1);
    expect(set.errors).toEqual([]);

    const sheets = await call(client, 'list_sheets', {});
    expect(sheets.sheets).toContain('Calc');

    const read = await call(client, 'get_results', { sheet: 'Calc' });
    const cells = read.cells as unknown[][];
    expect(cells[0]?.[0]).toBe(3);
  });

  it('writing to an existing sheet does not create a duplicate', async () => {
    const client = await makeClient(new EngineHost());
    await call(client, 'write_cells', {
      cells: [{ sheet: 'Sheet1', row: 0, col: 0, value: 'x' }],
    });
    const sheets = await call(client, 'list_sheets', {});
    expect((sheets.sheets as string[]).filter((s) => s === 'Sheet1')).toHaveLength(1);
  });

  it('a principal denied sheet.add cannot create a sheet by writing (no ACL bypass)', async () => {
    const denySheetAdd = new Authorizer((action) => action !== 'sheet.add');
    const client = await makeClient(new EngineHost(undefined, denySheetAdd));

    const written = await call(client, 'write_cells', {
      cells: [{ sheet: 'Nope', row: 0, col: 0, value: 'x' }],
    });
    expect(written.ok).toBe(false);
    expect(JSON.stringify(written)).toContain('Denied by policy: sheet.add Nope');

    const set = await call(client, 'set_formulas', {
      formulas: [{ sheet: 'Nope', row: 0, col: 0, formula: '=1' }],
    });
    expect(set.ok).toBe(false);
    expect(JSON.stringify(set)).toContain('Denied by policy: sheet.add Nope');

    const sheets = await call(client, 'list_sheets', {});
    expect(sheets.sheets).not.toContain('Nope');
  });
});
