/**
 * MCP routes to the same engine instance as all other callers
 * (design doc `mcp-and-service-engine-routing.md` §4 + §5).
 *
 * Proves, against fake engines, the HTTP layer, and REAL engine
 * listeners (the engineAuth104 pattern):
 * - editor/viewer/stranger/no-record/dead-owner binding outcomes;
 * - the permission check happens BEFORE any engine contact (stranger =
 *   zero fetches, not even a liveness probe);
 * - viewer writes are refused by the host before contact (readOnly
 *   primary gate), and the engine's per-call token check (#104) is the
 *   secondary gate behind it;
 * - wrong-file-never: a request for file A never touches file B's
 *   engine (URL-prefix assertions on every fetch, plus distinct values
 *   on two real engines);
 * - MCP never claims: no live session → honest unbound refusal.
 *
 * No gateway source is touched by these tests; the gateway package is
 * consumed only through its public exports (index for the real-engine
 * listener, /remote for the registry + token + host surface).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EngineHost, TypedView } from '@icecream-sheets/engine';
import { issueToken } from '@icecream-sheets/service';
import {
  createEngineListener,
  MemoryFileRegistry,
  MemorySessionStores,
} from '@icecream-sheets/gateway';
import {
  issueEngineAccessToken,
  verifyEngineAccessToken,
  type FileRegistryRecord,
  type RemoteEngineFetch,
} from '@icecream-sheets/gateway/remote';
import {
  mcpAclAllows,
  mcpAclRoleFor,
  McpFileBindingError,
  resolveMcpFileBinding,
} from '../src/remoteFileBinding.js';
import { createMcpHttpListener } from '../src/http.js';

const MCP_SECRET = 'local-dev-secret';
const ENGINE_SECRET = 'test-engine-secret-123';
const ALICE = 'user:alice';
const BOB = 'user:bob';
const MALLORY = 'user:mallory';

interface FakeCall {
  url: string;
  method: string;
  auth: string | undefined;
  body: unknown;
}

function fakeRes(status: number, json: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

interface FakeEngineOpts {
  sessionId: string;
  probe: 'live' | 'mismatch' | 'gone' | 'throw';
  sheets?: string[];
  rangeValues?: unknown[][];
}

/** A stub engine: probe + /sheets + /read + /ops, logging every call. */
function makeFakeEngine(log: FakeCall[], opts: FakeEngineOpts): RemoteEngineFetch {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    let body: unknown;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    } catch {
      body = init?.body;
    }
    log.push({ url, method, auth: init?.headers?.authorization, body });
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/session/status') {
      if (opts.probe === 'throw') throw new Error('connection refused (fake dead engine)');
      if (opts.probe === 'gone') return fakeRes(404, { ok: false, error: 'no session' });
      return fakeRes(200, {
        status: 'active',
        sessionId: opts.probe === 'mismatch' ? 'session-other' : opts.sessionId,
        revision: 0,
      });
    }
    if (path === '/sheets' && method === 'GET') {
      return fakeRes(200, { sheets: opts.sheets ?? ['Sheet1'] });
    }
    if (path === '/read' && method === 'POST') {
      const kind = (body as { kind?: string } | undefined)?.kind;
      if (kind === 'range') {
        // Values are TypedValue objects ({kind, value}), never raw
        // numbers — the tool layer runs TypedView.toJson over them,
        // and a raw number degrades to null there.
        const values = opts.rangeValues ?? [[{ kind: 'number', value: 42 }]];
        return fakeRes(200, {
          values,
          formulas: (values as unknown[][]).map((row) => row.map(() => null)),
        });
      }
      if (kind === 'sheet') {
        return fakeRes(200, { values: opts.rangeValues ?? [[{ kind: 'number', value: 42 }]] });
      }
      if (kind === 'usedrange') return fakeRes(200, { range: null });
      if (kind === 'cell') return fakeRes(200, { value: { kind: 'number', value: 42 } });
      return fakeRes(400, { ok: false, error: 'unknown kind' });
    }
    if (path === '/ops' && method === 'POST') {
      return fakeRes(200, { ok: true, revision: 8 });
    }
    if (path === '/execute' && method === 'POST') {
      return fakeRes(200, { ok: true, data: {} });
    }
    return fakeRes(404, { ok: false, error: 'not found' });
  }) as unknown as RemoteEngineFetch;
}

function recordFor(over: Partial<FileRegistryRecord> & { fileId: string }): FileRegistryRecord {
  return {
    sessionId: 'session-1',
    ownerInstance: 'engine-1',
    ownerEndpoint: 'http://engine-a.test',
    leaseExpiry: Date.now() + 60_000,
    ownershipEpoch: 1,
    currentRevision: 7,
    storedRevision: 0,
    updatedAt: Date.now(),
    creatorPrincipal: ALICE,
    ...over,
  };
}

async function bindError(
  fn: () => Promise<unknown>,
): Promise<McpFileBindingError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(McpFileBindingError);
    return e as McpFileBindingError;
  }
  throw new Error('expected a binding error, got a binding');
}

function engineTokenFrom(authHeader: string | undefined): string {
  expect(authHeader).toMatch(/^Bearer /);
  return (authHeader as string).slice('Bearer '.length);
}

describe('mcpAclRoleFor / mcpAclAllows (gateway fileRegistry semantics)', () => {
  const rec = recordFor({ fileId: 'file-A', grants: { [BOB]: 'viewer' } });
  it('creator is owner; grants name editor/viewer; strangers are null', () => {
    expect(mcpAclRoleFor(null, ALICE)).toBe('owner');
    expect(mcpAclRoleFor(rec, ALICE)).toBe('owner');
    expect(mcpAclRoleFor(rec, BOB)).toBe('viewer');
    expect(mcpAclRoleFor(rec, MALLORY)).toBeNull();
    expect(mcpAclRoleFor(recordFor({ fileId: 'f', grants: { [BOB]: 'editor' } }), BOB)).toBe('editor');
  });
  it('write needs owner|editor; read needs any recorded role', () => {
    expect(mcpAclAllows(rec, ALICE, 'write')).toBe(true);
    expect(mcpAclAllows(rec, BOB, 'write')).toBe(false);
    expect(mcpAclAllows(rec, BOB, 'read')).toBe(true);
    expect(mcpAclAllows(rec, MALLORY, 'read')).toBe(false);
  });
});

describe('resolveMcpFileBinding (fake engines)', () => {
  it('editor binds; the minted token verifies (sub/sid/fid/role/ttl)', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    await registry.claim(recordFor({ fileId: 'file-A' }), null);
    const binding = await resolveMcpFileBinding({
      registry,
      fileId: 'file-A',
      principal: ALICE,
      engineSecret: ENGINE_SECRET,
      fetchFn: makeFakeEngine(log, { sessionId: 'session-1', probe: 'live' }),
    });
    expect(binding.role).toBe('owner');
    expect(binding.engineRole).toBe('editor');
    expect(binding.engineUrl).toBe('http://engine-a.test');
    const sheets = await binding.host.sheetNamesAsync();
    expect(sheets).toEqual(['Sheet1']);
    const sheetCall = log.find((c) => c.url.endsWith('/sheets'));
    expect(sheetCall).toBeDefined();
    const claims = verifyEngineAccessToken(engineTokenFrom(sheetCall?.auth), ENGINE_SECRET);
    expect(claims.sub).toBe(ALICE);
    expect(claims.sid).toBe('session-1');
    expect(claims.fid).toBe('file-A');
    expect(claims.role).toBe('editor');
    expect(claims.exp - claims.iat).toBe(120);
  });

  it('editor write flows through /ops with the registry revision as baseRev', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    await registry.claim(recordFor({ fileId: 'file-A' }), null);
    const binding = await resolveMcpFileBinding({
      registry,
      fileId: 'file-A',
      principal: ALICE,
      engineSecret: ENGINE_SECRET,
      fetchFn: makeFakeEngine(log, { sessionId: 'session-1', probe: 'live' }),
    });
    const result = await binding.host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 1,
    } as never);
    expect(result.ok).toBe(true);
    const ops = log.filter((c) => c.url.endsWith('/ops'));
    expect(ops).toHaveLength(1);
    expect((ops[0].body as { baseRev?: number }).baseRev).toBe(7);
    expect((ops[0].body as { cmd?: { cmd?: string } }).cmd?.cmd).toBe('setCell');
  });

  it('viewer binds read-only; execute() rejects BEFORE any engine contact', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    await registry.claim(recordFor({ fileId: 'file-A' }), null);
    // Grants survive claims but are never SET by one (#51 discipline):
    // only noteGrant (owner-checked) writes them.
    expect(await registry.noteGrant('file-A', BOB, 'viewer', ALICE)).toBe(true);
    const binding = await resolveMcpFileBinding({
      registry,
      fileId: 'file-A',
      principal: BOB,
      engineSecret: ENGINE_SECRET,
      fetchFn: makeFakeEngine(log, { sessionId: 'session-1', probe: 'live' }),
    });
    expect(binding.role).toBe('viewer');
    expect(binding.engineRole).toBe('viewer');
    await expect(
      binding.host.execute({
        cmd: 'setCell',
        ref: { sheet: 'Sheet1', row: 0, col: 0 },
        value: 1,
      } as never),
    ).rejects.toThrow(/read-only/);
    // Exactly one fetch total (the bind-time probe); zero /ops, zero /execute.
    expect(log).toHaveLength(1);
    expect(log[0].url.endsWith('/session/status')).toBe(true);
    expect(log.some((c) => c.url.endsWith('/ops'))).toBe(false);
    expect(log.some((c) => c.url.endsWith('/execute'))).toBe(false);
    // Reads still work for the viewer.
    expect(await binding.host.sheetNamesAsync()).toEqual(['Sheet1']);
  });

  it('stranger is refused with ZERO engine contact (not even a probe)', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    await registry.claim(recordFor({ fileId: 'file-A' }), null);
    const err = await bindError(() =>
      resolveMcpFileBinding({
        registry,
        fileId: 'file-A',
        principal: MALLORY,
        engineSecret: ENGINE_SECRET,
        fetchFn: makeFakeEngine(log, { sessionId: 'session-1', probe: 'live' }),
      }),
    );
    expect(err.kind).toBe('refused');
    expect(err.httpStatus).toBe(403);
    expect(log).toHaveLength(0);
  });

  it('no record → unbound, zero engine contact', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    const err = await bindError(() =>
      resolveMcpFileBinding({
        registry,
        fileId: 'file-nope',
        principal: ALICE,
        engineSecret: ENGINE_SECRET,
        fetchFn: makeFakeEngine(log, { sessionId: 'session-1', probe: 'live' }),
      }),
    );
    expect(err.kind).toBe('unbound');
    expect(err.httpStatus).toBe(404);
    expect(log).toHaveLength(0);
  });

  it('expired lease + dead probe → unbound; the probe is the ONLY fetch', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    await registry.claim(
      recordFor({ fileId: 'file-A', leaseExpiry: Date.now() - 1000 }),
      null,
    );
    const err = await bindError(() =>
      resolveMcpFileBinding({
        registry,
        fileId: 'file-A',
        principal: ALICE,
        engineSecret: ENGINE_SECRET,
        fetchFn: makeFakeEngine(log, { sessionId: 'session-1', probe: 'throw' }),
      }),
    );
    expect(err.kind).toBe('unbound');
    expect(log).toHaveLength(1);
    expect(log[0].url.endsWith('/session/status')).toBe(true);
  });

  it('expired lease + live probe → binds (liveness rescue, gateway JOIN pattern)', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    await registry.claim(
      recordFor({ fileId: 'file-A', leaseExpiry: Date.now() - 1000 }),
      null,
    );
    const binding = await resolveMcpFileBinding({
      registry,
      fileId: 'file-A',
      principal: ALICE,
      engineSecret: ENGINE_SECRET,
      fetchFn: makeFakeEngine(log, { sessionId: 'session-1', probe: 'live' }),
    });
    expect(binding.sessionId).toBe('session-1');
  });

  it('live lease + probe session mismatch → unbound (never trust blindly)', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    await registry.claim(recordFor({ fileId: 'file-A' }), null);
    const err = await bindError(() =>
      resolveMcpFileBinding({
        registry,
        fileId: 'file-A',
        principal: ALICE,
        engineSecret: ENGINE_SECRET,
        fetchFn: makeFakeEngine(log, { sessionId: 'session-1', probe: 'mismatch' }),
      }),
    );
    expect(err.kind).toBe('unbound');
  });

  it('no signing secret → config error, never an unsigned fallback', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    await registry.claim(recordFor({ fileId: 'file-A' }), null);
    const err = await bindError(() =>
      resolveMcpFileBinding({
        registry,
        fileId: 'file-A',
        principal: ALICE,
        engineSecret: '',
        fetchFn: makeFakeEngine(log, { sessionId: 'session-1', probe: 'live' }),
      }),
    );
    expect(err.kind).toBe('config');
    expect(err.httpStatus).toBe(500);
    expect(log).toHaveLength(0);
  });

  it('wrong-file-never: A-calls stay on engine-A, B-calls on engine-B', async () => {
    const log: FakeCall[] = [];
    const registry = new MemoryFileRegistry();
    await registry.claim(
      recordFor({ fileId: 'file-A', sessionId: 'session-A', ownerEndpoint: 'http://engine-a.test' }),
      null,
    );
    await registry.claim(
      recordFor({ fileId: 'file-B', sessionId: 'session-B', ownerEndpoint: 'http://engine-b.test' }),
      null,
    );
    const route: RemoteEngineFetch = (async (url: string, init?: never) => {
      const engine = url.startsWith('http://engine-b.test')
        ? makeFakeEngine(log, { sessionId: 'session-B', probe: 'live', sheets: ['SheetB'] })
        : makeFakeEngine(log, { sessionId: 'session-A', probe: 'live', sheets: ['SheetA'] });
      return engine(url, init as never);
    }) as unknown as RemoteEngineFetch;
    const bindA = await resolveMcpFileBinding({
      registry, fileId: 'file-A', principal: ALICE, engineSecret: ENGINE_SECRET, fetchFn: route,
    });
    const bindB = await resolveMcpFileBinding({
      registry, fileId: 'file-B', principal: ALICE, engineSecret: ENGINE_SECRET, fetchFn: route,
    });
    expect(await bindA.host.sheetNamesAsync()).toEqual(['SheetA']);
    expect(await bindB.host.sheetNamesAsync()).toEqual(['SheetB']);
    const aCalls = log.filter((c) => c.url.startsWith('http://engine-a.test'));
    const bCalls = log.filter((c) => c.url.startsWith('http://engine-b.test'));
    expect(aCalls.length).toBeGreaterThan(0);
    expect(bCalls.length).toBeGreaterThan(0);
    expect(aCalls.length + bCalls.length).toBe(log.length);
  });
});

describe('HTTP layer: file-bound sessions', () => {
  let server: http.Server;
  let port: number;
  let registry: MemoryFileRegistry;
  let log: FakeCall[];

  function rawPost(path: string, headers: Record<string, string>) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    });
  }

  beforeAll(async () => {
    registry = new MemoryFileRegistry();
    log = [];
    const fetchFn = makeFakeEngine(log, {
      sessionId: 'session-1',
      probe: 'live',
      sheets: ['Sheet1'],
      rangeValues: [[{ kind: 'number', value: 7 }]],
    });
    await registry.claim(recordFor({ fileId: 'file-A' }), null);
    expect(await registry.noteGrant('file-A', BOB, 'viewer', ALICE)).toBe(true);
    server = http.createServer(
      createMcpHttpListener({
        host: new EngineHost(),
        authSecret: MCP_SECRET,
        engineSecret: ENGINE_SECRET,
        fileRegistry: registry,
        fileEngineFetch: fetchFn,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }, 15_000);

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function makeClient(headers?: Record<string, string>) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: headers ? { headers } : undefined,
    });
    const client = new Client({ name: 'remote-routing-test-client', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  }

  async function closeClient(conn: { client: Client; transport: StreamableHTTPClientTransport }) {
    try {
      await conn.transport.terminateSession();
    } catch {
      // Session may already be gone; teardown must not fail the test.
    }
    await conn.client.close();
  }

  it('editor session with a file header binds and reads through the engine', async () => {
    const token = await issueToken({ userId: 'alice', secret: MCP_SECRET, ttlSeconds: 3600 });
    const conn = await makeClient({
      authorization: `Bearer ${token}`,
      'x-icecream-file-id': 'file-A',
    });
    try {
      const read = await conn.client.callTool({
        name: 'read_cells',
        arguments: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      });
      const content = read.content as { type: string; text: string }[];
      expect(read.isError ?? false).toBe(false);
      expect(JSON.parse(content[0].text).cells).toEqual([[7]]);
    } finally {
      await closeClient(conn);
    }
  });

  it('viewer session reads but its write fails with zero /ops calls', async () => {
    log.length = 0;
    const token = await issueToken({ userId: 'bob', secret: MCP_SECRET, ttlSeconds: 3600 });
    const conn = await makeClient({
      authorization: `Bearer ${token}`,
      'x-icecream-file-id': 'file-A',
    });
    try {
      const read = await conn.client.callTool({
        name: 'read_cells',
        arguments: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      });
      expect(read.isError ?? false).toBe(false);
      const write = await conn.client.callTool({
        name: 'write_cells',
        arguments: { cells: [{ sheet: 'Sheet1', row: 1, col: 0, value: 99 }] },
      });
      expect(write.isError).toBe(true);
    } finally {
      await closeClient(conn);
    }
    expect(log.some((c) => c.url.endsWith('/ops'))).toBe(false);
  });

  it('stranger session creation fails 403', async () => {
    const token = await issueToken({ userId: 'mallory', secret: MCP_SECRET, ttlSeconds: 3600 });
    const res = await rawPost('/mcp', {
      authorization: `Bearer ${token}`,
      'x-icecream-file-id': 'file-A',
    });
    expect(res.status).toBe(403);
  });

  it('unbound file session creation fails 404', async () => {
    const token = await issueToken({ userId: 'alice', secret: MCP_SECRET, ttlSeconds: 3600 });
    const res = await rawPost('/mcp', {
      authorization: `Bearer ${token}`,
      'x-icecream-file-id': 'file-nope',
    });
    expect(res.status).toBe(404);
  });

  it('no file header → legacy shared local host, unchanged', async () => {
    const conn = await makeClient();
    try {
      const written = await conn.client.callTool({
        name: 'write_cells',
        arguments: { cells: [{ sheet: 'Sheet1', row: 3, col: 3, value: 'local-still-works' }] },
      });
      expect(written.isError ?? false).toBe(false);
      const read = await conn.client.callTool({
        name: 'read_cells',
        arguments: { sheet: 'Sheet1', startRow: 3, startCol: 3, endRow: 3, endCol: 3 },
      });
      const content = read.content as { type: string; text: string }[];
      expect(JSON.parse(content[0].text).cells).toEqual([['local-still-works']]);
    } finally {
      await closeClient(conn);
    }
  });
});

describe('real engines: MCP tokens verified by the engine itself (#104)', () => {
  let registry: MemoryFileRegistry;
  let engineA: http.Server;
  let engineB: http.Server;
  let urlA: string;
  let urlB: string;

  function mint(principal: string, sessionId: string, fid: string, role: 'editor' | 'viewer') {
    return issueEngineAccessToken({
      secret: ENGINE_SECRET,
      principal,
      sessionId,
      fid,
      role,
      tier: 'standard',
      ttlSeconds: 600,
    }).token;
  }

  async function engineJson(url: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json };
  }

  async function seedEngine(url: string, fileId: string, sessionId: string, value: number) {
    const token = mint(ALICE, sessionId, fileId, 'editor');
    const claim = await engineJson(url, '/session/claim', token, { fileId, sessionId });
    expect(claim.status).toBe(200);
    // A claimed session already has the default Sheet1 (proven by
    // scratch probe: addSheet fails "Sheet already exists") — seed
    // straight into it.
    let baseRev = 0;
    let clientSeq = 0;
    for (const cmd of [
      { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value },
    ]) {
      const op = await engineJson(url, '/ops', token, {
        clientId: 'seed',
        clientSeq: ++clientSeq,
        baseRev,
        cmd,
      });
      expect(op.status).toBe(200);
      expect(op.json?.ok).toBe(true);
      baseRev = op.json?.revision as number;
    }
    return baseRev;
  }

  // TypedValue → JSON, the same projection the read_cells tool uses.
  function jsonMatrix(values: unknown[][]): unknown[][] {
    return values.map((row) => row.map((v) => TypedView.toJson(v as never)));
  }

  beforeAll(async () => {
    registry = new MemoryFileRegistry();
    const deployEnv = {
      ENGINE_ACCESS_MODE: 'signed',
      ENGINE_ACCESS_SECRET: ENGINE_SECRET,
      AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
    };
    // Prod shape: ONE shared registry, but each engine keeps its OWN
    // session store (only the registry is shared across engines).
    engineA = http.createServer(
      createEngineListener({ sessionStores: new MemorySessionStores(), fileRegistry: registry, deployEnv }),
    );
    engineB = http.createServer(
      createEngineListener({ sessionStores: new MemorySessionStores(), fileRegistry: registry, deployEnv }),
    );
    await new Promise<void>((resolve) => engineA.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => engineB.listen(0, '127.0.0.1', resolve));
    urlA = `http://127.0.0.1:${(engineA.address() as AddressInfo).port}`;
    urlB = `http://127.0.0.1:${(engineB.address() as AddressInfo).port}`;

    const revA = await seedEngine(urlA, 'file-A', 'session-A', 42);
    const revB = await seedEngine(urlB, 'file-B', 'session-B', 99);
    // The gateway's claim shape: the registry record names the owning
    // engine's URL and the current revision; grants are added by the
    // owner (noteGrant), never by the claim itself. NOTE: the engine's
    // own /session/claim writes NO registry record (the gateway owns
    // registry writes in prod) — so the record is written here, the
    // way the gateway would write it, and the engine reads it back on
    // every call through the shared registry (its #104 verdict).
    for (const [fileId, sessionId, url, rev] of [
      ['file-A', 'session-A', urlA, revA],
      ['file-B', 'session-B', urlB, revB],
    ] as const) {
      const cur = await registry.lookup(fileId);
      const ownerInstance = url === urlA ? 'engine-a' : 'engine-b';
      if (cur) {
        const claimed = await registry.claim(
          {
            ...cur,
            ownerInstance,
            ownerEndpoint: url,
            leaseExpiry: Date.now() + 60_000,
            ownershipEpoch: cur.ownershipEpoch + 1,
            currentRevision: rev,
          },
          cur.ownershipEpoch,
        );
        expect(claimed).toBe(true);
      } else {
        const claimed = await registry.claim(
          {
            fileId,
            sessionId,
            ownerInstance,
            ownerEndpoint: url,
            leaseExpiry: Date.now() + 60_000,
            ownershipEpoch: 1,
            currentRevision: rev,
            storedRevision: 0,
            updatedAt: Date.now(),
            creatorPrincipal: ALICE,
          },
          null,
        );
        expect(claimed).toBe(true);
      }
    }
    expect(await registry.noteGrant('file-A', BOB, 'viewer', ALICE)).toBe(true);
  }, 30_000);

  afterAll(async () => {
    for (const s of [engineA, engineB]) {
      s.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        s.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  function loggingFetch(log: FakeCall[]): RemoteEngineFetch {
    return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      log.push({
        url,
        method: init?.method ?? 'GET',
        auth: init?.headers?.authorization,
        body: init?.body,
      });
      return fetch(url, init as RequestInit);
    }) as unknown as RemoteEngineFetch;
  }

  it('MCP reads land on the correct real engine (42 vs 99)', async () => {
    const logA: FakeCall[] = [];
    const bindA = await resolveMcpFileBinding({
      registry, fileId: 'file-A', principal: ALICE, engineSecret: ENGINE_SECRET,
      fetchFn: loggingFetch(logA),
    });
    expect(jsonMatrix(await bindA.host.readRangeAsync({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 }) as never)).toEqual([[42]]);
    expect(logA.every((c) => c.url.startsWith(urlA))).toBe(true);

    const logB: FakeCall[] = [];
    const bindB = await resolveMcpFileBinding({
      registry, fileId: 'file-B', principal: ALICE, engineSecret: ENGINE_SECRET,
      fetchFn: loggingFetch(logB),
    });
    expect(jsonMatrix(await bindB.host.readRangeAsync({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 }) as never)).toEqual([[99]]);
    expect(logB.every((c) => c.url.startsWith(urlB))).toBe(true);
  });

  it('MCP write lands on the correct real engine and nowhere else', async () => {
    const logA: FakeCall[] = [];
    const bindA = await resolveMcpFileBinding({
      registry, fileId: 'file-A', principal: ALICE, engineSecret: ENGINE_SECRET,
      fetchFn: loggingFetch(logA),
    });
    const result = await bindA.host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 1, col: 0 },
      value: 43,
    } as never);
    expect(result.ok).toBe(true);
    expect(jsonMatrix(await bindA.host.readRangeAsync({ sheet: 'Sheet1', startRow: 1, startCol: 0, endRow: 1, endCol: 0 }) as never)).toEqual([[43]]);
    expect(logA.every((c) => c.url.startsWith(urlA))).toBe(true);

    const bindB = await resolveMcpFileBinding({
      registry, fileId: 'file-B', principal: ALICE, engineSecret: ENGINE_SECRET,
      fetchFn: loggingFetch([]),
    });
    const bCell = jsonMatrix(await bindB.host.readRangeAsync({ sheet: 'Sheet1', startRow: 1, startCol: 0, endRow: 1, endCol: 0 }) as never);
    expect(bCell[0][0]).not.toBe(43);
  });

  it('viewer write refused before contact; the real value is untouched', async () => {
    const log: FakeCall[] = [];
    const bind = await resolveMcpFileBinding({
      registry, fileId: 'file-A', principal: BOB, engineSecret: ENGINE_SECRET,
      fetchFn: loggingFetch(log),
    });
    await expect(
      bind.host.execute({
        cmd: 'setCell',
        ref: { sheet: 'Sheet1', row: 0, col: 0 },
        value: 1000,
      } as never),
    ).rejects.toThrow(/read-only/);
    expect(log.some((c) => c.url.endsWith('/ops'))).toBe(false);
    expect(jsonMatrix(await bind.host.readRangeAsync({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 }) as never)).toEqual([[42]]);
  });

  it('stranger refused with zero engine contact (real engines)', async () => {
    const log: FakeCall[] = [];
    const err = await bindError(() =>
      resolveMcpFileBinding({
        registry, fileId: 'file-A', principal: MALLORY, engineSecret: ENGINE_SECRET,
        fetchFn: loggingFetch(log),
      }),
    );
    expect(err.kind).toBe('refused');
    expect(log).toHaveLength(0);
  });

  it('a record pointing at a dead engine → unbound (never a private copy)', async () => {
    const dead = http.createServer(
      createEngineListener({
        sessionStores: new MemorySessionStores(),
        fileRegistry: registry,
        deployEnv: {
          ENGINE_ACCESS_MODE: 'signed',
          ENGINE_ACCESS_SECRET: ENGINE_SECRET,
          AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
        },
      }),
    );
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const urlDead = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    const token = mint(ALICE, 'session-C', 'file-C', 'editor');
    const claim = await engineJson(urlDead, '/session/claim', token, { fileId: 'file-C', sessionId: 'session-C' });
    expect(claim.status).toBe(200);
    // Engine claims write no registry record (gateway owns that) — the
    // record is written here, the way the gateway would write it.
    const claimed = await registry.claim(
      {
        fileId: 'file-C',
        sessionId: 'session-C',
        ownerInstance: 'engine-dead',
        ownerEndpoint: urlDead,
        leaseExpiry: Date.now() + 60_000,
        ownershipEpoch: 1,
        currentRevision: 0,
        storedRevision: 0,
        updatedAt: Date.now(),
        creatorPrincipal: ALICE,
      },
      null,
    );
    expect(claimed).toBe(true);
    dead.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      dead.close((err) => (err ? reject(err) : resolve())),
    );
    const err = await bindError(() =>
      resolveMcpFileBinding({
        registry, fileId: 'file-C', principal: ALICE, engineSecret: ENGINE_SECRET,
      }),
    );
    expect(err.kind).toBe('unbound');
  });
});
