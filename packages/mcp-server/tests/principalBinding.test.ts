/**
 * F-10: the verified session identity is authoritative.
 *
 * Before the fix, `principalOf` let a tool call's `principal` ARGUMENT
 * override the server's bound identity (ServerOptions.defaultPrincipal,
 * set from the verified Bearer token by the HTTP layer / from the
 * authenticated caller by the agent service): any client could read
 * another user's permission-hidden cells by asserting their principal.
 * Now: bound + mismatching argument → refusal (no data); bound +
 * matching/absent argument → the bound identity; unbound servers
 * (stdio/local, process = trust boundary) keep caller assertion; the
 * allowPrincipalAssertion escape hatch exists only for trusted local
 * embeddings (the HTTP layer grants it solely to anonymous local-dev
 * sessions).
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
import { createServer, type ServerOptions } from '../src/server.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

interface RawResult {
  isError: boolean;
  text: string;
  json: Record<string, unknown> | null;
}

async function rawCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: ToolTextContent[];
    isError?: boolean;
  };
  const text = result.content?.[0]?.text ?? '';
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // error results carry a plain-text message, not JSON
  }
  return { isError: result.isError === true, text, json };
}

/** One protected workbook (A1 hidden, exempt: 'owner'; sheet locked), shared by every server below. */
async function makeProtectedHost(): Promise<EngineHost> {
  const protection = new ProtectionManager();
  protection.setHiddenExemptPrincipals(['owner']);
  const host = new EngineHost(
    undefined,
    new Authorizer(protection.protectionPolicy(allowAllPolicy())),
  );
  host.setHiddenCheck((ref, principal) =>
    protection.isHiddenFrom(ref.sheet, ref.row, ref.col, principal),
  );
  // Seed through an UNBOUND server (the stdio/local posture): the owner
  // asserts its principal per call, exactly as before F-10.
  const seedClient = await connect(host, undefined);
  const seeded = await rawCall(seedClient, 'write_cells', {
    cells: [
      { sheet: 'Sheet1', row: 0, col: 0, value: 'top-secret' },
      { sheet: 'Sheet1', row: 1, col: 0, value: 'public' },
    ],
    principal: 'owner',
  });
  expect(seeded.isError).toBe(false);
  protection.hideRanges('Sheet1', ['A1'], { principal: 'owner' });
  protection.protectSheet('Sheet1', undefined, {}, { principal: 'owner' });
  return host;
}

async function connect(host: EngineHost, options?: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host, options);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const READ_A1_A2 = { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 0 };

describe('F-10: bound session identity is authoritative', () => {
  it('a spoofed principal argument is refused and hidden data is NOT read', async () => {
    const host = await makeProtectedHost();
    const client = await connect(host, { defaultPrincipal: 'user:alice' });
    const res = await rawCall(client, 'read_cells', { ...READ_A1_A2, principal: 'owner' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('principal mismatch');
    expect(res.text).not.toContain('top-secret');
  });

  it('a spoofed WRITE is refused and the cell is unchanged', async () => {
    const host = await makeProtectedHost();
    const client = await connect(host, { defaultPrincipal: 'user:alice' });
    const res = await rawCall(client, 'write_cells', {
      cells: [{ sheet: 'Sheet1', row: 1, col: 0, value: 'pwned' }],
      principal: 'owner',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('principal mismatch');
    // Verify as the owner through an unbound (local) server.
    const ownerClient = await connect(host, undefined);
    const check = await rawCall(ownerClient, 'read_cells', { ...READ_A1_A2, principal: 'owner' });
    expect((check.json?.cells as unknown[][])[1]?.[0]).toBe('public');
  });

  it('absent argument acts as the bound identity (hidden cell stays hidden)', async () => {
    const host = await makeProtectedHost();
    const client = await connect(host, { defaultPrincipal: 'user:alice' });
    const res = await rawCall(client, 'read_cells', { ...READ_A1_A2 });
    expect(res.isError).toBe(false);
    const cells = res.json?.cells as unknown[][];
    expect(cells[0]?.[0]).toEqual({ error: '#PERM!' });
    expect(cells[1]?.[0]).toBe('public');
  });

  it('a MATCHING principal argument is accepted', async () => {
    const host = await makeProtectedHost();
    const client = await connect(host, { defaultPrincipal: 'user:alice' });
    const res = await rawCall(client, 'read_cells', {
      ...READ_A1_A2,
      principal: 'user:alice',
    });
    expect(res.isError).toBe(false);
    const cells = res.json?.cells as unknown[][];
    expect(cells[1]?.[0]).toBe('public');
  });

  it('an unbound server keeps caller assertion (stdio/local posture)', async () => {
    const host = await makeProtectedHost();
    const client = await connect(host, undefined);
    const res = await rawCall(client, 'read_cells', { ...READ_A1_A2, principal: 'owner' });
    expect(res.isError).toBe(false);
    expect((res.json?.cells as unknown[][])[0]?.[0]).toBe('top-secret');
  });

  it('allowPrincipalAssertion (trusted local embedding) still honors arguments', async () => {
    const host = await makeProtectedHost();
    const client = await connect(host, {
      defaultPrincipal: 'mcp-client',
      allowPrincipalAssertion: true,
    });
    const res = await rawCall(client, 'read_cells', { ...READ_A1_A2, principal: 'owner' });
    expect(res.isError).toBe(false);
    expect((res.json?.cells as unknown[][])[0]?.[0]).toBe('top-secret');
  });
});
