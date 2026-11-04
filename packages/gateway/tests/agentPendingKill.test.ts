/**
 * #150 regression tests — the prod agent/service data path.
 *
 * T1 (observer kill): a bound chat turn must survive the panel's
 * unconditional 2s /pending poll (AgentChat.tsx polls listPendingAsks
 * while the panel is open, not only while parked). Pre-fix, the
 * no-fileId /pending resolution returns null in a registry-less
 * process — the prod service container's shape, where the agent
 * listener was created with no registry and no local registry file
 * exists — and runtimeFor's swap loop then CLOSES the in-flight
 * bound turn's runtime. Its MCP client dies, and every later tool
 * call throws the MCP SDK's exact `Not connected` (the wave-3 leg5
 * signature: ~30 tool calls, all `Not connected`, never recovering
 * within the turn, because ensureConnected() returns the dead client).
 * Post-fix, observer endpoints never swap, so the tool succeeds.
 *
 * T2 (bridge binding): POST /tools/call carrying fileId + a valid
 * gateway-attached binding must read the LIVE engine (leg3's "null"
 * cells and leg4b's "Sheet1 is empty" both came from the bridge
 * resolving to the private scratch host in prod). Without fileId the
 * bridge keeps today's private-host behavior (live engine untouched).
 */
import type { RequestListener } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TypedValue } from '@icecream-sheets/engine';
import type { ModelBackend, PlannerInput, PlannerOutput } from '@icecream-sheets/service';
import { createAgentListener } from '../src/services/agentSvc.js';
import { signAgentBinding } from '../src/deploy/engineAccess.js';
import { verifyEngineAccessToken } from '../src/deploy/engineAccess.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const FAKE_SECRET = 'agent-pending-kill-test-secret';
const PRINCIPAL = 'user:carol';
const HEADERS = { 'x-principal': PRINCIPAL };
const FILE_ID = 'file-150';
const SESSION_ID = 'sess_150';

function NUM(v: number): TypedValue {
  return { kind: 'number', value: v };
}

function signBinding(endpoint: string): string {
  return signAgentBinding({
    secret: FAKE_SECRET,
    principal: PRINCIPAL,
    fileId: FILE_ID,
    sessionId: SESSION_ID,
    role: 'editor',
    endpoint,
    epoch: 1,
    rev: 0,
  }).binding;
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('#150 observer kill (T1)', () => {
  let agent: Started | null = null;
  let savedSecret: string | undefined;
  let savedRegistryDir: string | undefined;
  let savedDataDir: string | undefined;
  let planCalls = 0;
  let releaseGate!: () => void;
  let gate: Promise<void>;

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedRegistryDir = process.env.FILE_REGISTRY_DIR;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    // Prod service-container shape: no registry dep, and no local
    // registry file exists -> the no-fileId resolver returns null.
    process.env.FILE_REGISTRY_DIR = mkdtempSync(join(tmpdir(), 'agent-150-empty-registry-'));
    process.env.ICECREAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'agent-150-data-'));
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const stub: ModelBackend = {
      name: 'stub-pending-kill',
      async plan(input: PlannerInput): Promise<PlannerOutput> {
        planCalls += 1;
        if (planCalls === 1) {
          // Park the turn mid-flight so the test can fire the poll
          // while the turn's runtime is live and cached.
          await gate;
          return {
            message: '',
            actions: [{ type: 'tool', tool: 'agent.list_pending', args: {} }],
          };
        }
        return { message: 'Done.', actions: [{ type: 'done' }] };
      },
    };
    agent = await startServer(createAgentListener({ modelBackend: stub }));
  });

  afterAll(async () => {
    if (agent) await stop(agent);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedRegistryDir === undefined) delete process.env.FILE_REGISTRY_DIR;
    else process.env.FILE_REGISTRY_DIR = savedRegistryDir;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('a bound turn survives a concurrent /pending poll', async () => {
    const binding = signBinding('http://127.0.0.1:9');
    const turnPromise = httpJson('POST', `${agent!.url}/message`, {
      headers: { ...HEADERS, 'x-agent-binding': binding },
      body: { threadId: 't150', text: 'list my pending asks', fileId: FILE_ID },
    });
    await waitFor(() => planCalls >= 1, 'first plan call');
    // The panel's unconditional 2s poll, mid-turn.
    const pend = await httpJson('GET', `${agent!.url}/pending`, { headers: HEADERS });
    expect(pend.status).toBe(200);
    releaseGate();
    const turn = await turnPromise;
    expect(turn.status).toBe(200);
    const reply = turn.json as { audit: Array<{ tool?: string; ok?: boolean; summary?: string }> };
    const toolCall = reply.audit.find((a) => a.tool === 'agent.list_pending');
    expect(toolCall).toBeDefined();
    // Pre-fix this is ok:false with summary
    // 'agent.list_pending threw: Not connected' — the prod signature.
    expect(toolCall?.ok).toBe(true);
    expect(toolCall?.summary ?? '').toContain('agent.list_pending ok');
  });
});

describe('#150 bridge binding (T2)', () => {
  let engine: Started | null = null;
  let agent: Started | null = null;
  let savedSecret: string | undefined;
  let savedRegistryDir: string | undefined;
  let savedDataDir: string | undefined;
  const readsSeen: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedRegistryDir = process.env.FILE_REGISTRY_DIR;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    process.env.FILE_REGISTRY_DIR = mkdtempSync(join(tmpdir(), 'agent-150-empty-registry-'));
    process.env.ICECREAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'agent-150-data-'));

    engine = await startServer((async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake-engine');
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
      try {
        const claims = verifyEngineAccessToken(token, FAKE_SECRET, {
          sessionId: SESSION_ID,
          principal: PRINCIPAL,
        });
        if (claims.fid !== FILE_ID || claims.role !== 'editor') throw new Error('scope');
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
        return send(200, { ok: true, sessionId: SESSION_ID, fileId: FILE_ID, revision: 0 });
      }
      if (url.pathname === '/read') {
        readsSeen.push(body);
        if (body.kind === 'range') {
          const range = body.range as { startRow: number; startCol: number; endRow: number; endCol: number };
          const values: TypedValue[][] = [];
          const formulas: (string | null)[][] = [];
          for (let r = range.startRow; r <= range.endRow; r++) {
            const vRow: TypedValue[] = [];
            const fRow: (string | null)[] = [];
            for (let c = range.startCol; c <= range.endCol; c++) {
              vRow.push(NUM(7001 + r * 10 + c));
              fRow.push(null);
            }
            values.push(vRow);
            formulas.push(fRow);
          }
          return send(200, { values, formulas });
        }
        return send(400, { ok: false, error: 'bad kind' });
      }
      if (url.pathname === '/sheets') return send(200, { sheets: ['Sheet1'] });
      if (url.pathname === '/snapshot') {
        return send(200, { protocolVersion: 1, sheets: [{ name: 'Sheet1', cells: [] }] });
      }
      if (url.pathname === '/events') return send(200, { events: [] });
      if (url.pathname === '/execute') return send(200, { ok: true });
      return send(404, { ok: false, error: `fake engine: no route ${url.pathname}` });
    }) as RequestListener);

    agent = await startServer(createAgentListener({}));
  });

  afterAll(async () => {
    if (agent) await stop(agent);
    if (engine) await stop(engine);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedRegistryDir === undefined) delete process.env.FILE_REGISTRY_DIR;
    else process.env.FILE_REGISTRY_DIR = savedRegistryDir;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('a bridge call with fileId + binding reads the live engine', async () => {
    const binding = signBinding(engine!.url);
    const r = await httpJson('POST', `${agent!.url}/tools/call`, {
      headers: { ...HEADERS, 'x-agent-binding': binding },
      body: {
        tool: 'read_cells',
        args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        fileId: FILE_ID,
      },
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).toContain('7001');
    expect(readsSeen.length).toBeGreaterThan(0);
  });

  it('a bridge call without fileId never touches the live engine', async () => {
    const before = readsSeen.length;
    const r = await httpJson('POST', `${agent!.url}/tools/call`, {
      headers: HEADERS,
      body: {
        tool: 'read_cells',
        args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      },
    });
    // Today's private-host behavior, preserved: the response may be
    // empty or an error, but the live engine must see nothing.
    expect(readsSeen.length).toBe(before);
    expect(r.status).toBeLessThan(500);
  });
});
