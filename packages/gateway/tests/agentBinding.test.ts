/**
 * FIX-B (F1 + D4) tests:
 * - session resolver over fixture registry data,
 * - NodeRemoteEngineHost over a mock fetch (read mapping, /ops envelope
 *   with baseRev/clientSeq tracking, token re-mint on 401),
 * - agentSvc-level: a chat tool call lands on a FAKE engine HTTP server
 *   for the principal's registry session (and falls back to the private
 *   host when the resolution disappears),
 * - D4: the gateway proxy no longer kills /api/agent/message at ~30s.
 */
import type { RequestListener } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TypedValue } from '@icecream-sheets/engine';
import type { ModelBackend, PlannerInput, PlannerOutput } from '@icecream-sheets/service';
import {
  createAgentSessionResolver,
  createFileSessionResolver,
  pickActiveSession,
  pickSessionForFile,
  type AgentSessionRecord,
  type ResolvedAgentSession,
} from '../src/services/agentSessionResolver.js';
import {
  NodeRemoteEngineHost,
  type RemoteEngineFetch,
  type RemoteEngineFetchInit,
} from '../src/services/remoteEngineHost.js';
import { createAgentListener } from '../src/services/agentSvc.js';
import {
  issueEngineAccessToken,
  verifyEngineAccessToken,
} from '../src/deploy/engineAccess.js';
import { AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS, createGateway } from '../src/gateway.js';

/**
 * #137 stub planner for the binding tests: plans the exact tool calls
 * the test prompts need. The binding assertions (which engine got the
 * call, which values came back) are the subject; this stub stands in
 * for a model — it is not the product's request path, and it matches
 * only the test's own prompt shapes. Iteration-based (no cross-turn
 * state): tool plans on iteration 1, finishing plans after.
 */
function makeBindingStub(): ModelBackend {
  return {
    name: 'stub-binding',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.toolResults.length > 0) {
        // Read loop, iteration 2: sum the read_cells matrix from the
        // tool result — the value proves the read hit the bound engine.
        const matrix = (input.toolResults[0]!.data as { cells?: unknown[][] } | null)?.cells;
        let sum = 0;
        if (Array.isArray(matrix)) {
          for (const row of matrix) {
            for (const cell of row) {
              if (typeof cell === 'number') sum += cell;
            }
          }
        }
        return { message: `The sum is ${sum}.`, actions: [{ type: 'done' }] };
      }
      if (input.iteration > 1) {
        return { message: 'Done.', actions: [{ type: 'done' }] };
      }
      const text = input.userText;
      const setMatch = /set C1 to (\d+)/.exec(text);
      if (setMatch) {
        return {
          message: '',
          actions: [
            {
              type: 'tool',
              tool: 'write_cells',
              args: { cells: [{ sheet: 'Sheet1', row: 0, col: 2, value: Number(setMatch[1]) }] },
            },
          ],
        };
      }
      if (text.includes('sum of')) {
        return {
          message: '',
          actions: [
            {
              type: 'tool',
              tool: 'read_cells',
              args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
            },
          ],
        };
      }
      if (text.includes('recalculate')) {
        return { message: '', actions: [{ type: 'tool', tool: 'recalculate', args: {} }] };
      }
      return { message: 'Done.', actions: [{ type: 'done' }] };
    },
  };
}
import { httpJson, startServer, stop, type Started } from './helpers.js';

const NOW = 1_800_000_000_000;

function rec(partial: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    fileId: 'file-1',
    sessionId: 'sess_1',
    ownerInstance: 'engine-1',
    ownerEndpoint: 'http://127.0.0.1:8101',
    leaseExpiry: NOW + 30_000,
    ownershipEpoch: 1,
    currentRevision: 3,
    storedRevision: 3,
    updatedAt: NOW - 1000,
    creatorPrincipal: 'user:alice',
    ...partial,
  };
}

describe('agent session resolver (fixture registry data)', () => {
  it('resolves the creator’s live session', async () => {
    const resolve = createAgentSessionResolver({ records: [rec({})], nowMs: () => NOW });
    const s = await resolve('user:alice');
    expect(s).toMatchObject({
      fileId: 'file-1',
      sessionId: 'sess_1',
      engineUrl: 'http://127.0.0.1:8101',
      ownershipEpoch: 1,
      currentRevision: 3,
    });
  });

  it('returns null for other principals, expired leases, and released sessions', async () => {
    const resolve = createAgentSessionResolver({
      records: [
        rec({ fileId: 'file-expired', sessionId: 'sess_exp', leaseExpiry: NOW - 1 }),
        rec({ fileId: 'file-released', sessionId: 'sess_rel', leaseExpiry: 0 }),
        rec({ fileId: 'file-bob', sessionId: 'sess_bob', creatorPrincipal: 'user:bob' }),
      ],
      nowMs: () => NOW,
    });
    expect(await resolve('user:alice')).toBeNull();
    expect((await resolve('user:bob'))?.sessionId).toBe('sess_bob');
  });

  it('participant records alone no longer bind a session (issue #51 section 4)', () => {
    // Access comes ONLY from a grant: a principal recorded merely as
    // a participant (any legacy shape) matches NOTHING — those records
    // were join-time advisory data, and pre-fix they were written by
    // the very open hole section 4 closes.
    const asObjects = rec({ participants: [{ principal: 'user:carol', role: 'editor' }] });
    const asStrings = rec({ fileId: 'f2', sessionId: 's2', participants: ['user:carol'] });
    const asMap = rec({ fileId: 'f3', sessionId: 's3', participants: { 'user:carol': 'viewer' } });
    for (const r of [asObjects, asStrings, asMap]) {
      expect(pickActiveSession([r], 'user:carol', { nowMs: () => NOW })).toBeNull();
    }
    // A grants entry binds, with the grant's role.
    const granted = rec({ fileId: 'f4', sessionId: 's4', grants: { 'user:carol': 'editor' } });
    expect(pickActiveSession([granted], 'user:carol', { nowMs: () => NOW })?.sessionId).toBe('s4');
    expect(pickActiveSession([granted], 'user:dave', { nowMs: () => NOW })).toBeNull();
  });

  it('resolves the session role per principal (FIX-B residual 4)', () => {
    // Creator is always an editor.
    expect(pickActiveSession([rec({})], 'user:alice', { nowMs: () => NOW })?.role).toBe('editor');
    // A grantee gets exactly their grant's role (issue #51 section 4).
    const mapViewer = rec({ grants: { 'user:carol': 'viewer' } });
    expect(pickActiveSession([mapViewer], 'user:carol', { nowMs: () => NOW })?.role).toBe('viewer');
    const mapEditor = rec({ grants: { 'user:carol': 'editor' } });
    expect(pickActiveSession([mapEditor], 'user:carol', { nowMs: () => NOW })?.role).toBe('editor');
    // A participant-recorded 'editor' WITHOUT a grant (legacy shapes,
    // recorded through the pre-fix open hole) binds nothing at all.
    const objEditor = rec({ participants: [{ principal: 'user:carol', role: 'editor' }] });
    expect(pickActiveSession([objEditor], 'user:carol', { nowMs: () => NOW })).toBeNull();
    const bareString = rec({ participants: ['user:carol'] });
    expect(pickActiveSession([bareString], 'user:carol', { nowMs: () => NOW })).toBeNull();
    const bareObject = rec({ participants: [{ principal: 'user:carol' }] });
    expect(pickActiveSession([bareObject], 'user:carol', { nowMs: () => NOW })).toBeNull();
    // Creator precedence: even a (nonsensical) viewer entry for the
    // creator cannot demote them.
    const creatorListed = rec({ participants: { 'user:alice': 'viewer' } });
    expect(pickActiveSession([creatorListed], 'user:alice', { nowMs: () => NOW })?.role).toBe('editor');
  });

  it('most recently updated live session wins', async () => {
    const resolve = createAgentSessionResolver({
      records: [
        rec({ fileId: 'file-old', sessionId: 'sess_old', updatedAt: NOW - 5000 }),
        rec({ fileId: 'file-new', sessionId: 'sess_new', updatedAt: NOW - 100 }),
        rec({ fileId: 'file-newer-dead', sessionId: 'sess_dead', updatedAt: NOW, leaseExpiry: NOW - 1 }),
      ],
      nowMs: () => NOW,
    });
    expect((await resolve('user:alice'))?.sessionId).toBe('sess_new');
  });

  it('falls back to ENGINE_PUBLIC_URL when a record has no ownerEndpoint', async () => {
    const resolve = createAgentSessionResolver({
      records: [rec({ ownerEndpoint: '' })],
      nowMs: () => NOW,
      env: { ENGINE_PUBLIC_URL: 'http://engine.example:9999/' } as NodeJS.ProcessEnv,
    });
    expect((await resolve('user:alice'))?.engineUrl).toBe('http://engine.example:9999');
  });

  it('reads the on-disk registry file; missing file → null; corrupt file → throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-registry-'));
    const env = { FILE_REGISTRY_DIR: dir } as NodeJS.ProcessEnv;
    const resolve = createAgentSessionResolver({ env, nowMs: () => NOW });
    expect(await resolve('user:alice')).toBeNull(); // no file yet
    writeFileSync(
      join(dir, 'file-registry.json'),
      JSON.stringify({ 'file-1': rec({}) }),
      'utf8',
    );
    expect((await resolve('user:alice'))?.sessionId).toBe('sess_1');
    writeFileSync(join(dir, 'file-registry.json'), 'not json', 'utf8');
    await expect(resolve('user:alice')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// File-scoped resolution (FIX-R3: the add-on binding's question)
// ---------------------------------------------------------------------------

describe('file-scoped session resolver (FIX-R3)', () => {
  it('picks the requested file when the principal has several live sessions', async () => {
    const resolve = createFileSessionResolver({
      records: [
        rec({ fileId: 'file-a', sessionId: 'sess_a', updatedAt: NOW - 100 }),
        rec({ fileId: 'file-b', sessionId: 'sess_b', updatedAt: NOW - 5000 }),
      ],
      nowMs: () => NOW,
    });
    // The principal-scoped resolver would pick file-a (most recent);
    // the file-scoped one must return exactly the requested file.
    expect((await resolve('user:alice', 'file-b'))?.sessionId).toBe('sess_b');
    expect((await resolve('user:alice', 'file-a'))?.sessionId).toBe('sess_a');
    expect(await resolve('user:alice', 'file-missing')).toBeNull();
  });

  it('returns null for a principal with no stake in the file, and for dead leases', async () => {
    const resolve = createFileSessionResolver({
      records: [
        rec({ fileId: 'file-a', sessionId: 'sess_a', creatorPrincipal: 'user:bob' }),
        rec({ fileId: 'file-dead', sessionId: 'sess_dead', leaseExpiry: NOW - 1 }),
      ],
      nowMs: () => NOW,
    });
    expect(await resolve('user:alice', 'file-a')).toBeNull();
    expect(await resolve('user:alice', 'file-dead')).toBeNull();
    expect((await resolve('user:bob', 'file-a'))?.sessionId).toBe('sess_a');
  });

  it('carries the per-principal role for the requested file', async () => {
    const record = rec({
      fileId: 'file-a',
      sessionId: 'sess_a',
      grants: { 'user:carol': 'viewer', 'user:dave': 'editor' },
    });
    const resolve = createFileSessionResolver({ records: [record], nowMs: () => NOW });
    expect((await resolve('user:alice', 'file-a'))?.role).toBe('editor'); // creator
    expect((await resolve('user:carol', 'file-a'))?.role).toBe('viewer');
    expect((await resolve('user:dave', 'file-a'))?.role).toBe('editor');
    expect(await resolve('user:eve', 'file-a')).toBeNull();
    // pickSessionForFile agrees with the factory-built resolver.
    expect(pickSessionForFile([record], 'user:carol', 'file-a', { nowMs: () => NOW })?.role).toBe('viewer');
    expect(pickSessionForFile([record], 'user:carol', 'file-other', { nowMs: () => NOW })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Remote host over mock fetch
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  init: RemoteEngineFetchInit;
  body: Record<string, unknown> | null;
}

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function mockFetch(handler: (call: RecordedCall, n: number) => unknown) {
  const calls: RecordedCall[] = [];
  const fetchFn: RemoteEngineFetch = async (url, init) => {
    const call: RecordedCall = {
      url,
      init,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return handler(call, calls.length) as ReturnType<RemoteEngineFetch>;
  };
  return { calls, fetchFn };
}

const NUM = (value: number): TypedValue => ({ kind: 'number', value });

function makeHost(fetchFn: RemoteEngineFetch, extra: Partial<{ initialRevision: number }> = {}) {
  return new NodeRemoteEngineHost({
    engineUrl: 'http://engine.test:8101/',
    principal: 'user:carol',
    sessionId: 'sess_host',
    fileId: 'file-host',
    getAccessToken: () => 'tok-1',
    fetchFn,
    pollMs: 60_000,
    ...extra,
  });
}

describe('NodeRemoteEngineHost (mock fetch)', () => {
  it('maps range reads over POST /read and carries the minted token', async () => {
    const { calls, fetchFn } = mockFetch(() =>
      jsonResponse(200, {
        values: [[NUM(7001)], [NUM(7002)], [NUM(7003)]],
        formulas: [[null], [null], [null]],
      }),
    );
    const host = makeHost(fetchFn);
    const values = await host.readRange({
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 0,
    });
    expect(values).toEqual([[NUM(7001)], [NUM(7002)], [NUM(7003)]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://engine.test:8101/read');
    expect(calls[0]!.init.headers['authorization']).toBe('Bearer tok-1');
    expect(calls[0]!.body).toEqual({
      kind: 'range',
      range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
    });
    host.dispose();
  });

  it('submits mutating ops via /ops with clientSeq + baseRev tracking, auth stripped', async () => {
    let revision = 5;
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith('/ops')) {
        revision += 1;
        return jsonResponse(200, {
          ok: true,
          revision,
          ack: { revision, changedCellCount: 1, checksum: 'x' },
        });
      }
      throw new Error(`unexpected ${call.url}`);
    });
    const host = makeHost(fetchFn, { initialRevision: 5 });
    const r1 = await host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 2 },
      value: 424242,
      auth: { principal: 'user:mallory' }, // must NOT cross the wire
    });
    expect(r1.ok).toBe(true);
    const r2 = await host.execute({
      cmd: 'setFormula',
      ref: { sheet: 'Sheet1', row: 1, col: 2 },
      formula: '=SUM(A1:A3)',
    });
    expect(r2.ok).toBe(true);
    const ops = calls.filter((c) => c.url.endsWith('/ops'));
    expect(ops).toHaveLength(2);
    expect(ops[0]!.body).toEqual({
      clientId: expect.stringMatching(/^agent:user:carol:/),
      clientSeq: 1,
      baseRev: 5,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 2 }, value: 424242 },
    });
    expect(ops[1]!.body).toMatchObject({ clientSeq: 2, baseRev: 6 });
    expect(host.lastKnownRevision).toBe(7);
    host.dispose();
  });

  it('seeds baseRev from /session/status when no initial revision is known', async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith('/session/status')) return jsonResponse(200, { ok: true, revision: 9 });
      if (call.url.endsWith('/ops')) return jsonResponse(200, { ok: true, revision: 10, ack: null });
      throw new Error(`unexpected ${call.url}`);
    });
    const host = makeHost(fetchFn);
    await host.execute({ cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 }, value: 1 });
    const ops = calls.filter((c) => c.url.endsWith('/ops'));
    expect(ops[0]!.body).toMatchObject({ baseRev: 9, clientSeq: 1 });
    host.dispose();
  });

  it('routes non-mutating commands through /execute (no envelope, no revision)', async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith('/execute')) return jsonResponse(200, { ok: true });
      throw new Error(`unexpected ${call.url}`);
    });
    const host = makeHost(fetchFn, { initialRevision: 2 });
    const r = await host.execute({ cmd: 'recalculate' });
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ cmd: { cmd: 'recalculate' } });
    expect(host.lastKnownRevision).toBe(2);
    host.dispose();
  });

  it('re-mints the token on a 401 and retries exactly once', async () => {
    let minted = 0;
    const { calls, fetchFn } = mockFetch((call, n) =>
      n === 1 ? jsonResponse(401, { error: 'expired' }) : jsonResponse(200, { value: NUM(5) }),
    );
    const host = new NodeRemoteEngineHost({
      engineUrl: 'http://engine.test:8101',
      principal: 'user:carol',
      sessionId: 'sess_host',
      fileId: 'file-host',
      getAccessToken: () => `tok-${++minted}`,
      fetchFn,
      pollMs: 60_000,
    });
    const v = await host.readCellAsync({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(v).toEqual(NUM(5));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.headers['authorization']).toBe('Bearer tok-1');
    expect(calls[1]!.init.headers['authorization']).toBe('Bearer tok-2');
    expect(minted).toBe(2);
    host.dispose();
  });

  it('surfaces a visible /ops rejection as { ok:false } and adopts its revision', async () => {
    const { fetchFn } = mockFetch(() =>
      jsonResponse(403, { ok: false, rejected: true, reason: 'viewer-role', revision: 12 }),
    );
    const host = makeHost(fetchFn, { initialRevision: 11 });
    const r = await host.execute({ cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 }, value: 1 });
    expect(r).toEqual({ ok: false, error: 'viewer-role' });
    expect(host.lastKnownRevision).toBe(12);
    host.dispose();
  });

  it('clientId is unique per host instance (no seenOps collision across instances)', async () => {
    // Case-7 root cause: the engine session dedups /ops by
    // (clientId, clientSeq) for the life of the session, and every new
    // host instance restarts clientSeq at 1. Two instances sharing one
    // bare clientId replay each other's cached results — a rebuilt
    // runtime's addSheet was silently answered from the previous
    // instance's payloads and never executed. Instances must differ.
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith('/ops')) return jsonResponse(200, { ok: true, revision: 1, ack: null });
      throw new Error(`unexpected ${call.url}`);
    });
    const h1 = makeHost(fetchFn, { initialRevision: 0 });
    const h2 = makeHost(fetchFn, { initialRevision: 0 });
    await h1.execute({ cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 }, value: 1 });
    await h2.execute({ cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 }, value: 2 });
    const ops = calls.filter((c) => c.url.endsWith('/ops'));
    expect(ops).toHaveLength(2);
    // Both instances start their sequences at 1 (the collision
    // precondition) — it is the clientId that must separate them.
    expect(ops[0]!.body).toMatchObject({ clientSeq: 1 });
    expect(ops[1]!.body).toMatchObject({ clientSeq: 1 });
    expect(ops[0]!.body!.clientId).toMatch(/^agent:user:carol:/);
    expect(ops[1]!.body!.clientId).toMatch(/^agent:user:carol:/);
    expect(ops[0]!.body!.clientId).not.toBe(ops[1]!.body!.clientId);
    expect(h1.boundClientId).not.toBe(h2.boundClientId);
    h1.dispose();
    h2.dispose();
  });

  it('before-retention rejection resyncs the revision seed and retries the op once', async () => {
    // Case-7 proof3: a stale seed (other clients advanced the session,
    // checkpoints pruned the journal) made the FIRST op of
    // open_data_source die with 409 before-retention, aborting the
    // whole tool. The host must resync + retry once, not surface it.
    let opsCalls = 0;
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith('/ops')) {
        opsCalls += 1;
        if (opsCalls === 1) {
          return jsonResponse(409, {
            ok: false,
            rejected: true,
            reason: 'before-retention',
            oldestRevision: 41,
            revision: 40,
          });
        }
        return jsonResponse(200, { ok: true, revision: 41, ack: null });
      }
      throw new Error(`unexpected ${call.url}`);
    });
    const host = makeHost(fetchFn, { initialRevision: 3 });
    const r = await host.execute({ cmd: 'addSheet', name: 'Sales CSV' });
    expect(r.ok).toBe(true);
    const ops = calls.filter((c) => c.url.endsWith('/ops'));
    expect(ops).toHaveLength(2);
    expect(ops[0]!.body).toMatchObject({ clientSeq: 1, baseRev: 3 });
    // Retry: fresh clientSeq, baseRev resynced to the sequencer's
    // current revision carried by the rejection payload.
    expect(ops[1]!.body).toMatchObject({ clientSeq: 2, baseRev: 40 });
    expect(host.lastKnownRevision).toBe(41);
    host.dispose();
  });

  it('before-retention without a payload revision resyncs via /session/status', async () => {
    let opsCalls = 0;
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith('/session/status')) return jsonResponse(200, { ok: true, revision: 40 });
      if (call.url.endsWith('/ops')) {
        opsCalls += 1;
        if (opsCalls === 1) return jsonResponse(409, { ok: false, rejected: true, reason: 'before-retention' });
        return jsonResponse(200, { ok: true, revision: 41, ack: null });
      }
      throw new Error(`unexpected ${call.url}`);
    });
    const host = makeHost(fetchFn, { initialRevision: 3 });
    const r = await host.execute({ cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 }, value: 1 });
    expect(r.ok).toBe(true);
    const ops = calls.filter((c) => c.url.endsWith('/ops'));
    expect(ops).toHaveLength(2);
    expect(ops[1]!.body).toMatchObject({ clientSeq: 2, baseRev: 40 });
    host.dispose();
  });

  it('a second before-retention rejection is terminal (retry exactly once)', async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith('/ops')) {
        return jsonResponse(409, { ok: false, rejected: true, reason: 'before-retention', revision: 40 });
      }
      throw new Error(`unexpected ${call.url}`);
    });
    const host = makeHost(fetchFn, { initialRevision: 3 });
    const r = await host.execute({ cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 }, value: 1 });
    expect(r).toEqual({ ok: false, error: 'before-retention' });
    expect(calls.filter((c) => c.url.endsWith('/ops'))).toHaveLength(2);
    host.dispose();
  });

  it('a viewer-role rejection is NOT retried', async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith('/ops')) {
        return jsonResponse(403, { ok: false, rejected: true, reason: 'viewer-role', revision: 12 });
      }
      throw new Error(`unexpected ${call.url}`);
    });
    const host = makeHost(fetchFn, { initialRevision: 11 });
    const r = await host.execute({ cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 }, value: 1 });
    expect(r).toEqual({ ok: false, error: 'viewer-role' });
    expect(calls.filter((c) => c.url.endsWith('/ops'))).toHaveLength(1);
    host.dispose();
  });
});

// ---------------------------------------------------------------------------
// agentSvc-level: chat tool calls land on a FAKE engine session
// ---------------------------------------------------------------------------

const FAKE_SECRET = 'agent-binding-test-secret';
const CAROL = { 'x-principal': 'user:carol' };

describe('agentSvc binding (fake engine HTTP server + fixture registry)', () => {
  let engine: Started | null = null;
  let agent: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;

  const FILE_ID = 'file-agent-binding';
  const SESSION_ID = 'sess_agent_binding';
  let fakeRevision = 0;
  const fakeCells = new Map<string, TypedValue>([
    ['Sheet1!0:0', NUM(7001)],
    ['Sheet1!1:0', NUM(7002)],
    ['Sheet1!2:0', NUM(7003)],
  ]);
  const opsSeen: Array<Record<string, unknown>> = [];
  const readsSeen: Array<Record<string, unknown>> = [];
  let tokenClaimsSeen = 0;

  let resolved: ResolvedAgentSession | null = null;

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-binding-data-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    engine = await startServer((async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake-engine');
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      // Every engine route requires a valid signed token for THIS
      // session/principal/file — the real engineAccess verifier.
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
      try {
        const claims = verifyEngineAccessToken(token, FAKE_SECRET, {
          sessionId: SESSION_ID,
          principal: 'user:carol',
        });
        if (claims.fid !== FILE_ID || claims.role !== 'editor') throw new Error('scope');
        tokenClaimsSeen += 1;
      } catch {
        return send(401, { ok: false, error: 'engine access denied' });
      }
      let body: Record<string, unknown> = {};
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      }
      if (url.pathname === '/session/status') {
        return send(200, { ok: true, sessionId: SESSION_ID, fileId: FILE_ID, revision: fakeRevision });
      }
      if (url.pathname === '/ops') {
        opsSeen.push(body);
        const cmd = body.cmd as { cmd: string; ref?: { sheet: string; row: number; col: number }; value?: unknown };
        if (cmd.cmd === 'setCell' && cmd.ref) {
          const v = cmd.value;
          fakeCells.set(
            `${cmd.ref.sheet}!${cmd.ref.row}:${cmd.ref.col}`,
            typeof v === 'number' ? NUM(v) : { kind: 'null', value: null },
          );
        }
        fakeRevision += 1;
        return send(200, {
          ok: true,
          revision: fakeRevision,
          ack: { revision: fakeRevision, changedCellCount: 1, checksum: 'fake' },
        });
      }
      if (url.pathname === '/execute') return send(200, { ok: true });
      if (url.pathname === '/read') {
        readsSeen.push(body);
        if (body.kind === 'range') {
          const range = body.range as { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number };
          const values: TypedValue[][] = [];
          const formulas: (string | null)[][] = [];
          for (let r = range.startRow; r <= range.endRow; r++) {
            const vRow: TypedValue[] = [];
            const fRow: (string | null)[] = [];
            for (let c = range.startCol; c <= range.endCol; c++) {
              vRow.push(fakeCells.get(`${range.sheet}!${r}:${c}`) ?? { kind: 'null', value: null });
              fRow.push(null);
            }
            values.push(vRow);
            formulas.push(fRow);
          }
          return send(200, { values, formulas });
        }
        if (body.kind === 'cell') {
          const ref = body.ref as { sheet: string; row: number; col: number };
          return send(200, { value: fakeCells.get(`${ref.sheet}!${ref.row}:${ref.col}`) ?? { kind: 'null', value: null } });
        }
        if (body.kind === 'usedrange') {
          return send(200, { range: { sheet: body.sheet, startRow: 0, startCol: 0, endRow: 2, endCol: 2 } });
        }
        return send(400, { ok: false, error: 'bad kind' });
      }
      if (url.pathname === '/snapshot') {
        return send(200, { protocolVersion: 1, sheets: [{ name: 'Sheet1', cells: [] }] });
      }
      if (url.pathname === '/sheets') return send(200, { sheets: ['Sheet1'] });
      if (url.pathname === '/events') return send(200, { events: [] });
      return send(404, { ok: false, error: `fake engine: no route ${url.pathname}` });
    }) as RequestListener);

    resolved = {
      fileId: FILE_ID,
      sessionId: SESSION_ID,
      engineUrl: engine.url,
      ownershipEpoch: 1,
      creatorPrincipal: 'user:carol',
      role: 'editor',
      currentRevision: 0,
      updatedAt: Date.now(),
    };
    agent = await startServer(
      createAgentListener({ resolveSession: async () => resolved, modelBackend: makeBindingStub() }),
    );
  });

  afterAll(async () => {
    if (agent) await stop(agent);
    if (engine) await stop(engine);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('a chat write lands on the fake engine session through /ops', async () => {
    const r = await httpJson('POST', `${agent!.url}/message`, {
      headers: CAROL,
      body: { text: 'set C1 to 424242' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as { audit: Array<{ tool?: string; ok?: boolean }> };
    const write = reply.audit.find((a) => a.tool === 'write_cells');
    expect(write?.ok).toBe(true);
    expect(opsSeen).toHaveLength(1);
    expect(opsSeen[0]).toMatchObject({
      clientId: expect.stringMatching(/^agent:user:carol:/),
      clientSeq: 1,
      baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 2 }, value: 424242 },
    });
    expect(fakeCells.get('Sheet1!0:2')).toEqual(NUM(424242));
    // The writes crossed with a real signed token (fid/role verified
    // by the fake engine above, or it would have 401'd the lot).
    expect(tokenClaimsSeen).toBeGreaterThan(0);
    // Sanity: the minter's tokens really are the deploy signer's shape.
    const probe = issueEngineAccessToken({
      secret: FAKE_SECRET,
      principal: 'user:carol',
      sessionId: SESSION_ID,
      fid: FILE_ID,
      role: 'editor',
      tier: 'standard',
      ttlSeconds: 120,
    });
    expect(verifyEngineAccessToken(probe.token, FAKE_SECRET).fid).toBe(FILE_ID);
  });

  it('a chat read answers from the fake engine’s values, not a private workbook', async () => {
    const r = await httpJson('POST', `${agent!.url}/message`, {
      headers: CAROL,
      // NB: the stub planner (above) plans the read; the binding under
      // test is which engine the read reaches and which values return.
      body: { text: 'sum of A1:A3' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as { message: string };
    expect(reply.message).toContain('21006'); // 7001+7002+7003 — only the fake engine holds these
    expect(readsSeen.some((b) => b.kind === 'range')).toBe(true);
  });

  it('falls back to the private host when the session resolution disappears', async () => {
    resolved = null;
    const opsBefore = opsSeen.length;
    const r = await httpJson('POST', `${agent!.url}/message`, {
      headers: CAROL,
      body: { text: 'recalculate now' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as { audit: Array<{ tool?: string; ok?: boolean }> };
    expect(reply.audit.find((a) => a.tool === 'recalculate')?.ok).toBe(true);
    expect(opsSeen.length).toBe(opsBefore); // nothing reached the engine session
  });
});

// ---------------------------------------------------------------------------
// FIX-B residuals (3)+(4): a non-creator participant binds, and the
// agent token minted for them carries THEIR session role — a viewer's
// agent reads fine but its writes are refused by the engine's role
// gate (mirrored here exactly as engineSvc implements it).
// ---------------------------------------------------------------------------

describe('agentSvc binding — viewer participant (role-scoped token)', () => {
  let engine: Started | null = null;
  let agent: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;

  const FILE_ID = 'file-agent-viewer';
  const SESSION_ID = 'sess_agent_viewer';
  const DAVE = { 'x-principal': 'user:dave' };
  const cells = new Map<string, TypedValue>([
    ['Sheet1!0:0', NUM(7001)],
    ['Sheet1!1:0', NUM(7002)],
    ['Sheet1!2:0', NUM(7003)],
  ]);
  const opsSeen: Array<{ role: string | undefined }> = [];
  let revision = 0;

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-viewer-data-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    engine = await startServer((async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake-engine');
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
      let claims: ReturnType<typeof verifyEngineAccessToken>;
      try {
        claims = verifyEngineAccessToken(token, FAKE_SECRET, {
          sessionId: SESSION_ID,
          principal: 'user:dave',
        });
        if (claims.fid !== FILE_ID) throw new Error('scope');
      } catch {
        return send(401, { ok: false, error: 'engine access denied' });
      }
      let body: Record<string, unknown> = {};
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      }
      if (url.pathname === '/session/status') {
        return send(200, { ok: true, sessionId: SESSION_ID, fileId: FILE_ID, revision });
      }
      if (url.pathname === '/ops') {
        opsSeen.push({ role: claims.role });
        // engineSvc's real gate: a viewer token's writes are refused.
        if (claims.role === 'viewer') {
          return send(403, { ok: false, rejected: true, reason: 'viewer-role', revision });
        }
        revision += 1;
        return send(200, {
          ok: true,
          revision,
          ack: { revision, changedCellCount: 1, checksum: 'fake' },
        });
      }
      if (url.pathname === '/execute') return send(200, { ok: true });
      if (url.pathname === '/read') {
        if (body.kind === 'range') {
          const range = body.range as { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number };
          const values: TypedValue[][] = [];
          const formulas: (string | null)[][] = [];
          for (let r = range.startRow; r <= range.endRow; r++) {
            const vRow: TypedValue[] = [];
            const fRow: (string | null)[][] = [];
            for (let c = range.startCol; c <= range.endCol; c++) {
              vRow.push(cells.get(`${range.sheet}!${r}:${c}`) ?? { kind: 'null', value: null });
              fRow.push(null);
            }
            values.push(vRow);
            formulas.push(fRow as (string | null)[]);
          }
          return send(200, { values, formulas });
        }
        if (body.kind === 'cell') {
          const ref = body.ref as { sheet: string; row: number; col: number };
          return send(200, { value: cells.get(`${ref.sheet}!${ref.row}:${ref.col}`) ?? { kind: 'null', value: null } });
        }
        if (body.kind === 'usedrange') {
          return send(200, { range: { sheet: body.sheet, startRow: 0, startCol: 0, endRow: 2, endCol: 2 } });
        }
        return send(400, { ok: false, error: 'bad kind' });
      }
      if (url.pathname === '/snapshot') {
        return send(200, { protocolVersion: 1, sheets: [{ name: 'Sheet1', cells: [] }] });
      }
      if (url.pathname === '/sheets') return send(200, { sheets: ['Sheet1'] });
      if (url.pathname === '/events') return send(200, { events: [] });
      return send(404, { ok: false, error: `fake engine: no route ${url.pathname}` });
    }) as RequestListener);

    // Dave is a recorded VIEWER participant on alice's session — the
    // resolver output the gateway's noteParticipant now produces.
    const resolvedViewer: ResolvedAgentSession = {
      fileId: FILE_ID,
      sessionId: SESSION_ID,
      engineUrl: engine.url,
      ownershipEpoch: 1,
      creatorPrincipal: 'user:alice',
      role: 'viewer',
      currentRevision: 0,
      updatedAt: Date.now(),
    };
    agent = await startServer(
      createAgentListener({ resolveSession: async () => resolvedViewer, modelBackend: makeBindingStub() }),
    );
  });

  afterAll(async () => {
    if (agent) await stop(agent);
    if (engine) await stop(engine);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it("a viewer participant's agent write is refused by the primary gate before engine contact", async () => {
    const r = await httpJson('POST', `${agent!.url}/message`, {
      headers: DAVE,
      body: { text: 'set C1 to 999999' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as { audit: Array<{ tool?: string; ok?: boolean }> };
    const write = reply.audit.find((a) => a.tool === 'write_cells');
    expect(write).toBeDefined();
    expect(write?.ok).toBe(false);
    // #99 v2 refinement — PRIMARY GATE: the agent service refuses a
    // viewer write BEFORE engine contact (v1: the attempt reached the
    // engine and the engine role gate 403'd it). The engine saw NO
    // op, and the cell was NOT modified. The engine gate (#104)
    // stays behind this as the secondary gate.
    expect(opsSeen.length).toBe(0);
    expect(cells.get('Sheet1!0:2')).toBeUndefined();
  });

  it("a viewer participant's agent can still read the shared workbook", async () => {
    const r = await httpJson('POST', `${agent!.url}/message`, {
      headers: DAVE,
      body: { text: 'sum of A1:A3' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as { message: string };
    expect(reply.message).toContain('21006');
  });
});

// ---------------------------------------------------------------------------
// D4: gateway proxy timeout for /api/agent/message
// ---------------------------------------------------------------------------

describe('D4: gateway agent-message proxy timeout', () => {
  it('exposes a ~270s agent-message timeout', () => {
    expect(AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS).toBe(270_000);
  });

  it(
    'does not kill a /api/agent/message parked past the old 30s proxy timeout',
    async () => {
      const backend = await startServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => {
          body += c.toString();
        });
        req.on('end', () => {
          // Park like a HITL wait: answer after 32s (> the old 30s cap).
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, parkedMs: 32_000, echoedBodyBytes: body.length }));
          }, 32_000);
        });
      });
      const gateway = await startServer(
        createGateway({
          devLoginEnabled: true,
          authSecret: 'd4-test-secret',
          routes: { '/api/agent': backend.url },
          rateLimit: { points: 1000, perSeconds: 60 },
        }),
      );
      try {
        const login = await httpJson('POST', `${gateway.url}/auth/login`, {
          body: { userId: 'alice' },
        });
        const token = (login.json as { token: string }).token;
        const started = Date.now();
        const r = await httpJson('POST', `${gateway.url}/api/agent/message`, {
          headers: { Authorization: `Bearer ${token}` },
          body: { text: 'hello' },
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(31_000);
        expect(r.status).toBe(200);
        expect((r.json as { ok: boolean }).ok).toBe(true);
      } finally {
        await stop(gateway);
        await stop(backend);
      }
    },
    60_000,
  );
});
