/**
 * #99 file-bound agent binding tests.
 *
 * The panel names its open workbook in every message (fileId). The
 * service must then read THAT file's live session — even when another
 * live session of the same principal is more recently updated (the old
 * pickActiveSession lottery bound the agent to a different spreadsheet
 * and it answered "A1 is empty" about that file's A1) — and must
 * answer honestly when the named file has no live session, touching
 * no engine at all (never another file, never the empty private host;
 * #86's silent-fallback shape on the read side).
 *
 * Owner's routing ruling 2026-10-23 extends the same file to the
 * whole rule: ONE registry-by-fileId mechanism for reads AND writes,
 * the permission check per action (a viewer reads but a refused write
 * must never compose as "Done."), no tier-default address (a record
 * without ownerEndpoint is unbound, never the fallback URL), and no
 * cached/stale address (an owner move rebuilds the runtime even when
 * the session id is reused).
 *
 * Owner's correction 2026-10-23 (v2) reshapes the mechanism without
 * changing the properties: the binding is established ONCE at bind
 * time and cached as a direct signed link — steady-state turns for a
 * bound file perform ZERO registry lookups (counting-resolver test
 * below); the registry is consulted again ONLY on link refresh
 * (engine refusal: unreachable, unauthorized, forbidden, session
 * absent). An owner move is followed once the old endpoint refuses
 * (fencing, §9) and the next turn refreshes to the new endpoint.
 *
 * Owner's decision 2026-10-24 (#108 shape) reshapes it again: the
 * gateway-attached signed binding REPLACES the service-side link.
 * The gateway resolves the binding from the registry at proxy time
 * and attaches it, HMAC-signed, to each call (x-agent-binding
 * header); the service verifies the signature and uses the endpoint
 * it was given — it NEVER reads the registry for binding and caches
 * NO link. Each message carries a fresh binding, so an owner move is
 * reflected on the very next turn with no refresh dance, and the
 * zero-registry-read property below is structural (the listener
 * takes no registry for file-bound turns at all). The properties
 * above — named file wins, honest unbound, no tier fallback, role as
 * primary gate, engine verification as secondary gate — are
 * unchanged; only the mechanism moved from service-side link to
 * gateway-attached binding. The tests below therefore sign bindings
 * directly (the gateway's job in production) and pass them as
 * headers, instead of handing the listener a resolver.
 *
 * Owner's refinement 2026-10-23 23:14 (v2, three layers): (1) the
 * binding resolves from the registry at open time to the SAME
 * instance + session as the grid (the link IS the grid's session
 * record — same-instance test below); (2) the agent's capability IS
 * the user's resolved role on the file, enforced as a PRIMARY GATE
 * in the agent service BEFORE engine contact — a viewer write is
 * refused with ZERO engine traffic (not an attempted-then-403 write),
 * and a capability refusal never poisons the link; (3) the engine's
 * per-call token verification (#104) stays behind the primary gate
 * as the secondary gate (defense in depth, audited separately).
 */
import type { RequestListener } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TypedValue } from '@icecream-sheets/engine';
import {
  createAgentSessionResolver,
  createFileSessionResolver,
  type AgentSessionRecord,
} from '../src/services/agentSessionResolver.js';
import {
  AGENT_WORKBOOK_UNBOUND_MESSAGE,
  createAgentChartSink,
  createAgentListener,
} from '../src/services/agentSvc.js';
import type { ResolvedAgentSession } from '../src/services/agentSessionResolver.js';
import type { ChartSink } from '@icecream-sheets/mcp-server';
import { signAgentBinding, verifyEngineAccessToken } from '../src/deploy/engineAccess.js';
import type { FileRegistry } from '../src/deploy/fileRegistry.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const NOW = 1_800_000_000_000;
const FAKE_SECRET = 'test-only-agent-file-binding-secret';
const CAROL = { 'x-principal': 'user:carol' };

/** Sign a gateway-attached binding (the gateway's job in production). */
function signedBinding(opts: {
  principal: string;
  fileId: string;
  sessionId: string;
  engineUrl: string;
  role: 'editor' | 'viewer';
  epoch?: number;
  rev?: number;
}): string {
  return signAgentBinding({
    secret: FAKE_SECRET,
    principal: opts.principal,
    fileId: opts.fileId,
    sessionId: opts.sessionId,
    role: opts.role,
    endpoint: opts.engineUrl,
    epoch: opts.epoch ?? 1,
    rev: opts.rev ?? 0,
  }).binding;
}

/** Principal headers carrying an attached binding (what the gateway proxy sends). */
function boundHeaders(principal: string, binding: string): Record<string, string> {
  return { 'x-principal': principal, 'x-agent-binding': binding };
}

const NUM = (value: number): TypedValue => ({ kind: 'number', value });
const STR = (value: string): TypedValue => ({ kind: 'string', value });
const NULLV: TypedValue = { kind: 'null', value: null };

function rec(partial: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    fileId: 'file-99-grid',
    sessionId: 'sess_99_grid',
    ownerInstance: 'engine-1',
    ownerEndpoint: 'http://127.0.0.1:8101',
    leaseExpiry: NOW + 30_000,
    ownershipEpoch: 1,
    currentRevision: 0,
    storedRevision: 0,
    updatedAt: NOW,
    creatorPrincipal: 'user:carol',
    ...partial,
  };
}

interface FakeEngine {
  started: Started;
  readsSeen: Array<Record<string, unknown>>;
  opsSeen: Array<{ role: string; body: Record<string, unknown> }>;
}

function makeFakeEngine(
  sessionId: string,
  fileId: string,
  cells: Map<string, TypedValue>,
  opts: {
    principal?: string;
    roles?: string[];
    refuseOpsRoles?: string[];
  } = {},
): Promise<FakeEngine> {
  const principal = opts.principal ?? 'user:carol';
  const roles = opts.roles ?? ['editor'];
  const refuseOpsRoles = opts.refuseOpsRoles ?? [];
  const readsSeen: Array<Record<string, unknown>> = [];
  const opsSeen: Array<{ role: string; body: Record<string, unknown> }> = [];
  return startServer((async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-engine');
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    let claims: { fid?: string; role?: string };
    try {
      claims = verifyEngineAccessToken(token, FAKE_SECRET, {
        sessionId,
        principal,
      });
      if (claims.fid !== fileId || !roles.includes(claims.role ?? '')) {
        throw new Error('scope');
      }
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
      return send(200, { ok: true, sessionId, fileId, revision: 0 });
    }
    if (url.pathname === '/ops') {
      const role = claims.role ?? '';
      opsSeen.push({ role, body });
      if (refuseOpsRoles.includes(role)) {
        return send(403, { ok: false, error: 'viewer role cannot write' });
      }
      const cmd = body.cmd as {
        cmd?: string;
        ref?: { sheet: string; row: number; col: number };
        value?: unknown;
      };
      if (cmd?.cmd === 'setCell' && cmd.ref) {
        const v = cmd.value;
        cells.set(
          `${cmd.ref.sheet}!${cmd.ref.row}:${cmd.ref.col}`,
          typeof v === 'number' ? NUM(v) : typeof v === 'string' ? STR(v) : NULLV,
        );
      }
      return send(200, { ok: true, revision: 1, ack: null });
    }
    if (url.pathname === '/read') {
      readsSeen.push(body);
      if (body.kind === 'range') {
        const range = body.range as {
          sheet: string;
          startRow: number;
          startCol: number;
          endRow: number;
          endCol: number;
        };
        const values: TypedValue[][] = [];
        const formulas: (string | null)[][] = [];
        for (let r = range.startRow; r <= range.endRow; r++) {
          const vRow: TypedValue[] = [];
          const fRow: (string | null)[] = [];
          for (let c = range.startCol; c <= range.endCol; c++) {
            vRow.push(cells.get(`${range.sheet}!${r}:${c}`) ?? NULLV);
            fRow.push(null);
          }
          values.push(vRow);
          formulas.push(fRow);
        }
        return send(200, { values, formulas });
      }
      if (body.kind === 'cell') {
        const ref = body.ref as { sheet: string; row: number; col: number };
        return send(200, {
          value: cells.get(`${ref.sheet}!${ref.row}:${ref.col}`) ?? NULLV,
        });
      }
      if (body.kind === 'usedrange') {
        return send(200, {
          range: { sheet: body.sheet, startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
        });
      }
      return send(400, { ok: false, error: 'bad kind' });
    }
    if (url.pathname === '/snapshot') {
      return send(200, { protocolVersion: 1, sheets: [{ name: 'Sheet1', cells: [] }] });
    }
    if (url.pathname === '/sheets') return send(200, { sheets: ['Sheet1'] });
    if (url.pathname === '/events') return send(200, { events: [] });
    if (url.pathname === '/execute') return send(200, { ok: true });
    return send(404, { ok: false, error: `fake engine: no route ${url.pathname}` });
  }) as RequestListener).then((started) => ({ started, readsSeen, opsSeen }));
}

describe('agent file binding (#99)', () => {
  let engineG: FakeEngine | null = null;
  let engineH: FakeEngine | null = null;
  let agent: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;
  let gridBinding = '';
  const gridCells = new Map<string, TypedValue>([
    ['Sheet1!0:0', NUM(5)],
    ['Sheet1!0:2', STR('GRID-FILE')],
  ]);
  const otherCells = new Map<string, TypedValue>([['Sheet1!0:2', STR('OTHER-FILE')]]);

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-file-binding-data-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    engineG = await makeFakeEngine('sess_99_grid', 'file-99-grid', gridCells);
    engineH = await makeFakeEngine('sess_99_other', 'file-99-other', otherCells);

    // #108: the listener takes NO resolver — the turn's binding is
    // attached by the caller (the gateway in production). H stays a
    // distractor engine that must never be consulted.
    gridBinding = signedBinding({
      principal: 'user:carol',
      fileId: 'file-99-grid',
      sessionId: 'sess_99_grid',
      engineUrl: engineG.started.url,
      role: 'editor',
    });
    agent = await startServer(createAgentListener({}));
  });

  afterAll(async () => {
    if (agent) await stop(agent);
    if (engineG) await stop(engineG.started);
    if (engineH) await stop(engineH.started);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('a file-bound read answers from the named file, not the most-recently-updated session', async () => {
    const a1 = await httpJson('POST', `${agent!.url}/message`, {
      headers: boundHeaders('user:carol', gridBinding),
      body: { threadId: randomUUID(), fileId: 'file-99-grid', text: 'What is the value of A1?' },
    });
    expect(a1.status).toBe(200);
    expect((a1.json as { message: string }).message).toContain('5');
    expect((a1.json as { message: string }).message).not.toContain('(empty)');

    const c1 = await httpJson('POST', `${agent!.url}/message`, {
      headers: boundHeaders('user:carol', gridBinding),
      body: { threadId: randomUUID(), fileId: 'file-99-grid', text: 'What is the value of C1?' },
    });
    expect(c1.status).toBe(200);
    expect((c1.json as { message: string }).message).toContain('GRID-FILE');
    expect((c1.json as { message: string }).message).not.toContain('OTHER-FILE');

    // The reads went to G's engine only — H was never consulted.
    expect(engineG!.readsSeen.length).toBeGreaterThan(0);
    expect(engineH!.readsSeen.length).toBe(0);
  });

  it('a file-bound message for a file with no live session answers honestly and touches no engine', async () => {
    const gBefore = engineG!.readsSeen.length;
    const hBefore = engineH!.readsSeen.length;
    const r = await httpJson('POST', `${agent!.url}/message`, {
      headers: CAROL,
      body: { threadId: randomUUID(), fileId: 'file-99-gone', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toBe(AGENT_WORKBOOK_UNBOUND_MESSAGE);
    expect((r.json as { audit: unknown[] }).audit).toEqual([]);
    expect(engineG!.readsSeen.length).toBe(gBefore);
    expect(engineH!.readsSeen.length).toBe(hBefore);
  });

  it('the stream twin answers the unbound case with a done event carrying the honest message', async () => {
    const r = await httpJson('POST', `${agent!.url}/message/stream`, {
      headers: CAROL,
      body: { threadId: randomUUID(), fileId: 'file-99-gone', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(200);
    const doneBlock = r.text
      .split('\n\n')
      .find((b) => b.startsWith('event: done'));
    expect(doneBlock).toBeDefined();
    const dataLine = doneBlock!
      .split('\n')
      .find((l) => l.startsWith('data:'))!
      .slice('data:'.length)
      .trim();
    const payload = JSON.parse(dataLine) as { message: string };
    expect(payload.message).toBe(AGENT_WORKBOOK_UNBOUND_MESSAGE);
  });

  it('a malformed fileId is a 400, not a silent fallback', async () => {
    const r = await httpJson('POST', `${agent!.url}/message`, {
      headers: CAROL,
      body: { threadId: randomUUID(), fileId: 'bad file!', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(400);
  });

  it('a file-bound write lands on the named file engine only (same routing as reads)', async () => {
    const r = await httpJson('POST', `${agent!.url}/message`, {
      headers: boundHeaders('user:carol', gridBinding),
      body: { threadId: randomUUID(), fileId: 'file-99-grid', text: 'set C1 to 424242' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as {
      message: string;
      audit: Array<{ tool?: string; ok?: boolean }>;
    };
    const write = reply.audit.find((a) => a.tool === 'write_cells');
    expect(write?.ok).toBe(true);
    expect(reply.message).toContain('Done.');
    expect(gridCells.get('Sheet1!0:2')).toEqual(NUM(424242));
    expect(engineH!.opsSeen).toHaveLength(0);
    expect(otherCells.get('Sheet1!0:2')).toEqual(STR('OTHER-FILE'));
  });
});

describe('file-bound viewer permission (#99 ruling: permission checked per action)', () => {
  let viewEngine: FakeEngine | null = null;
  let viewAgent: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;
  let viewerBinding = '';
  const viewCells = new Map<string, TypedValue>([
    ['Sheet1!0:0', NUM(5)],
    ['Sheet1!0:2', STR('VIEW-FILE')],
  ]);

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-file-binding-viewer-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    viewEngine = await makeFakeEngine('sess_99_view', 'file-99-view', viewCells, {
      principal: 'user:viewer',
      roles: ['viewer'],
      refuseOpsRoles: ['viewer'],
    });
    // #108: the viewer binding is attached by the caller (the
    // gateway in production, which resolved the viewer's grant).
    viewerBinding = signedBinding({
      principal: 'user:viewer',
      fileId: 'file-99-view',
      sessionId: 'sess_99_view',
      engineUrl: viewEngine.started.url,
      role: 'viewer',
    });
    viewAgent = await startServer(createAgentListener({}));
  });

  afterAll(async () => {
    if (viewAgent) await stop(viewAgent);
    if (viewEngine) await stop(viewEngine.started);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it("a viewer participant's file-bound read succeeds (read is allowed)", async () => {
    const r = await httpJson('POST', `${viewAgent!.url}/message`, {
      headers: boundHeaders('user:viewer', viewerBinding),
      body: { threadId: randomUUID(), fileId: 'file-99-view', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toContain('5');
  });

  it("a viewer participant's file-bound write is refused BEFORE engine contact and the reply never claims success", async () => {
    const opsBefore = viewEngine!.opsSeen.length;
    const r = await httpJson('POST', `${viewAgent!.url}/message`, {
      headers: boundHeaders('user:viewer', viewerBinding),
      body: { threadId: randomUUID(), fileId: 'file-99-view', text: 'set C1 to 999999' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as {
      message: string;
      audit: Array<{ tool?: string; ok?: boolean }>;
    };
    const write = reply.audit.find((a) => a.tool === 'write_cells');
    expect(write).toBeDefined();
    expect(write?.ok).toBe(false);
    // #99 v2 refinement — PRIMARY GATE: the refusal happens in the
    // agent service before any engine contact, so the engine saw NO
    // new op at all (v1: the attempt reached the engine and 403'd).
    // The cell was NOT modified, and — the ruling's honesty
    // requirement — the reply reports the refusal with its reason
    // instead of "Done."
    expect(viewEngine!.opsSeen.length).toBe(opsBefore);
    expect(viewCells.get('Sheet1!0:2')).toEqual(STR('VIEW-FILE'));
    expect(reply.message).not.toContain('Done.');
    expect(reply.message).toContain('failed');
    expect(reply.message).toContain('read-only');
  });

  it('a refused viewer write does not affect the next turn: the next read still succeeds', async () => {
    const r = await httpJson('POST', `${viewAgent!.url}/message`, {
      headers: boundHeaders('user:viewer', viewerBinding),
      body: { threadId: randomUUID(), fileId: 'file-99-view', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toContain('5');
    // A capability refusal is not a binding failure: the next turn
    // carries a fresh binding and reads fine — there is no link to
    // poison under #108.
  });
});

describe('owner move is reflected on the next turn (#108: fresh binding per message)', () => {
  let engineA: FakeEngine | null = null;
  let engineB: FakeEngine | null = null;
  let swapAgent: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-file-binding-swap-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    // Same session id on two endpoints: the reclaim shape — the
    // registry record keeps sess_swap but its ownerEndpoint moves
    // from A to B. Engine B holds the rehydrated (newer) values.
    engineA = await makeFakeEngine(
      'sess_swap',
      'file-swap',
      new Map<string, TypedValue>([['Sheet1!0:0', NUM(5)]]),
    );
    engineB = await makeFakeEngine(
      'sess_swap',
      'file-swap',
      new Map<string, TypedValue>([['Sheet1!0:0', NUM(7)]]),
    );
    // #108: the listener takes NO resolver — each turn's binding is
    // attached by the caller (the gateway re-resolves per message).
    swapAgent = await startServer(createAgentListener({}));
  });

  afterAll(async () => {
    if (swapAgent) await stop(swapAgent);
    if (engineA) await stop(engineA.started);
    if (engineB) await stop(engineB.started);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('reads follow the new endpoint on the very next turn when the same session reclaims elsewhere', async () => {
    const bindingA = signedBinding({
      principal: 'user:carol',
      fileId: 'file-swap',
      sessionId: 'sess_swap',
      engineUrl: engineA!.started.url,
      role: 'editor',
    });
    const first = await httpJson('POST', `${swapAgent!.url}/message`, {
      headers: boundHeaders('user:carol', bindingA),
      body: { threadId: randomUUID(), fileId: 'file-swap', text: 'What is the value of A1?' },
    });
    expect(first.status).toBe(200);
    expect((first.json as { message: string }).message).toContain('5');
    expect(engineA!.readsSeen.length).toBeGreaterThan(0);
    expect(engineB!.readsSeen.length).toBe(0);

    // Owner move: the SAME session id, now on B. The next turn
    // carries a fresh binding to B — no refusal dance, no refresh
    // lookup, no stale address: the sessionKey's engineUrl changes,
    // so the runtime rebuilds on B immediately.
    const bindingB = signedBinding({
      principal: 'user:carol',
      fileId: 'file-swap',
      sessionId: 'sess_swap',
      engineUrl: engineB!.started.url,
      role: 'editor',
    });
    const second = await httpJson('POST', `${swapAgent!.url}/message`, {
      headers: boundHeaders('user:carol', bindingB),
      body: { threadId: randomUUID(), fileId: 'file-swap', text: 'What is the value of A1?' },
    });
    expect(second.status).toBe(200);
    expect((second.json as { message: string }).message).toContain('7');
    expect(engineB!.readsSeen.length).toBeGreaterThan(0);
  });
});

describe('a file-bound message without an attached binding is unbound (#108: no endpoint fallback)', () => {
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-file-binding-noep-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;
  });

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('a file-bound message with no attached binding answers unbound — the service never falls back to any URL', async () => {
    // #108: the binding IS the endpoint source. With no binding the
    // service has no address to call — no tier-default, no localhost
    // fallback, no registry lookup to find one. (The resolver-level
    // fallback behavior itself is still covered by the resolver
    // describe block above; the listener simply never consults it.)
    const agent = await startServer(createAgentListener({}));
    try {
      const r = await httpJson('POST', `${agent.url}/message`, {
        headers: CAROL,
        body: { threadId: randomUUID(), fileId: 'file-noep', text: 'What is the value of A1?' },
      });
      expect(r.status).toBe(200);
      expect((r.json as { message: string }).message).toBe(AGENT_WORKBOOK_UNBOUND_MESSAGE);
    } finally {
      await stop(agent);
    }
  });
});

describe('file-bound turns make zero registry reads (#108: no registry on the service side)', () => {
  let engineG: FakeEngine | null = null;
  let engineH: FakeEngine | null = null;
  let linkAgent: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;
  let linkBinding = '';
  const linkCells = new Map<string, TypedValue>([
    ['Sheet1!0:0', NUM(5)],
    ['Sheet1!0:2', STR('LINK-FILE')],
  ]);
  const otherCells = new Map<string, TypedValue>([['Sheet1!0:2', STR('OTHER-FILE')]]);

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-link-cache-data-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    engineG = await makeFakeEngine('sess_link', 'file-link', linkCells, {
      principal: 'user:linker',
    });
    engineH = await makeFakeEngine('sess_link_other', 'file-other', otherCells, {
      principal: 'user:linker',
    });
    linkBinding = signedBinding({
      principal: 'user:linker',
      fileId: 'file-link',
      sessionId: 'sess_link',
      engineUrl: engineG.started.url,
      role: 'editor',
    });
    // #108 proof by construction: the listener is handed a POISON
    // registry — ANY read (lookup, listAll, anything) throws. If
    // file-bound turns consulted the registry at all, every turn
    // below would 500. They do not: the binding is the session.
    const poisonRegistry = new Proxy(
      {},
      {
        get: () => {
          throw new Error('registry must not be read for file-bound binding');
        },
      },
    ) as unknown as FileRegistry;
    linkAgent = await startServer(createAgentListener({ fileRegistry: poisonRegistry }));
  });

  afterAll(async () => {
    if (linkAgent) await stop(linkAgent);
    if (engineG) await stop(engineG.started);
    if (engineH) await stop(engineH.started);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('consecutive turns for the same file succeed with zero registry reads', async () => {
    const t1 = await httpJson('POST', `${linkAgent!.url}/message`, {
      headers: boundHeaders('user:linker', linkBinding),
      body: { threadId: randomUUID(), fileId: 'file-link', text: 'What is the value of A1?' },
    });
    expect(t1.status).toBe(200);
    expect((t1.json as { message: string }).message).toContain('5');

    const t2 = await httpJson('POST', `${linkAgent!.url}/message`, {
      headers: boundHeaders('user:linker', linkBinding),
      body: { threadId: randomUUID(), fileId: 'file-link', text: 'What is the value of C1?' },
    });
    expect(t2.status).toBe(200);
    expect((t2.json as { message: string }).message).toContain('LINK-FILE');

    const t3 = await httpJson('POST', `${linkAgent!.url}/message`, {
      headers: boundHeaders('user:linker', linkBinding),
      body: { threadId: randomUUID(), fileId: 'file-link', text: 'What is the value of A1?' },
    });
    expect(t3.status).toBe(200);
    expect((t3.json as { message: string }).message).toContain('5');

    // The binding served G throughout: the more-recently-updated H was
    // never consulted, and no turn touched the (poison) registry.
    expect(engineH!.readsSeen.length).toBe(0);
    expect(engineG!.readsSeen.length).toBeGreaterThan(0);
  });
});

describe('a principal with no access to the file is refused entirely (#99 v2 refinement)', () => {
  let closedEngine: FakeEngine | null = null;
  let closedAgent: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;
  const closedCells = new Map<string, TypedValue>([
    ['Sheet1!0:0', NUM(5)],
    ['Sheet1!0:2', STR('CLOSED-FILE')],
  ]);
  const STRANGER = { 'x-principal': 'user:stranger' };

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-file-binding-closed-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    // The file belongs to user:carol; user:stranger holds no grant.
    // #108: the gateway would 403 a stranger before proxying (see
    // the gateway binding tests); at the listener level a stranger
    // simply never holds a valid binding for the file.
    closedEngine = await makeFakeEngine('sess_closed', 'file-closed', closedCells);
    closedAgent = await startServer(createAgentListener({}));
  });

  afterAll(async () => {
    if (closedAgent) await stop(closedAgent);
    if (closedEngine) await stop(closedEngine.started);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('a stranger read is refused entirely with no engine contact', async () => {
    const r = await httpJson('POST', `${closedAgent!.url}/message`, {
      headers: STRANGER,
      body: { threadId: randomUUID(), fileId: 'file-closed', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toBe(AGENT_WORKBOOK_UNBOUND_MESSAGE);
    expect(closedEngine!.readsSeen.length).toBe(0);
    expect(closedEngine!.opsSeen.length).toBe(0);
  });

  it('a stranger write is refused entirely with no engine contact', async () => {
    const r = await httpJson('POST', `${closedAgent!.url}/message`, {
      headers: STRANGER,
      body: { threadId: randomUUID(), fileId: 'file-closed', text: 'set C1 to 999999' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toBe(AGENT_WORKBOOK_UNBOUND_MESSAGE);
    expect(closedEngine!.readsSeen.length).toBe(0);
    expect(closedEngine!.opsSeen.length).toBe(0);
    expect(closedCells.get('Sheet1!0:2')).toEqual(STR('CLOSED-FILE'));
  });

  it("a stranger presenting another principal's binding is refused with no engine contact", async () => {
    // Forged-principal binding: signed for user:carol, presented by
    // user:stranger — verification fails wrong-principal → unbound.
    const forged = signedBinding({
      principal: 'user:carol',
      fileId: 'file-closed',
      sessionId: 'sess_closed',
      engineUrl: closedEngine!.started.url,
      role: 'editor',
    });
    const r = await httpJson('POST', `${closedAgent!.url}/message`, {
      headers: boundHeaders('user:stranger', forged),
      body: { threadId: randomUUID(), fileId: 'file-closed', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toBe(AGENT_WORKBOOK_UNBOUND_MESSAGE);
    expect(closedEngine!.readsSeen.length).toBe(0);
    expect(closedEngine!.opsSeen.length).toBe(0);
  });
});

describe('the agent lands on the same instance and session as the grid (#99 v2 refinement)', () => {
  let gridEngine: FakeEngine | null = null;
  let otherEngine: FakeEngine | null = null;
  let sameAgent: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;
  let gridBinding = '';
  const gridCells = new Map<string, TypedValue>([
    ['Sheet1!0:0', NUM(5)],
    ['Sheet1!0:2', STR('GRID-FILE')],
  ]);
  const otherCells = new Map<string, TypedValue>([
    ['Sheet1!0:0', NUM(9)],
    ['Sheet1!0:2', STR('OTHER-FILE')],
  ]);

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-file-binding-same-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    // This binding IS the grid's session: the grid joined file-grid
    // through the gateway and holds session sess_grid on gridEngine.
    // The agent's turn must carry this exact binding — same
    // sessionId, same endpoint — never the other live session.
    gridEngine = await makeFakeEngine('sess_grid', 'file-grid', gridCells, {
      principal: 'user:griduser',
    });
    otherEngine = await makeFakeEngine('sess_grid_other', 'file-grid-other', otherCells, {
      principal: 'user:griduser',
    });
    gridBinding = signedBinding({
      principal: 'user:griduser',
      fileId: 'file-grid',
      sessionId: 'sess_grid',
      engineUrl: gridEngine.started.url,
      role: 'editor',
    });
    sameAgent = await startServer(createAgentListener({}));
  });

  afterAll(async () => {
    if (sameAgent) await stop(sameAgent);
    if (gridEngine) await stop(gridEngine.started);
    if (otherEngine) await stop(otherEngine.started);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('agent reads land on the grid engine with the grid session, never the distractor', async () => {
    const r = await httpJson('POST', `${sameAgent!.url}/message`, {
      headers: boundHeaders('user:griduser', gridBinding),
      body: { threadId: randomUUID(), fileId: 'file-grid', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toContain('5');
    // The fake verifies the token's sessionId: a successful read on
    // gridEngine proves the agent presented the GRID's session, and
    // the distractor saw nothing.
    expect(gridEngine!.readsSeen.length).toBeGreaterThan(0);
    expect(otherEngine!.readsSeen.length).toBe(0);
  });

  it('agent writes land on the grid engine only', async () => {
    const r = await httpJson('POST', `${sameAgent!.url}/message`, {
      headers: boundHeaders('user:griduser', gridBinding),
      body: { threadId: randomUUID(), fileId: 'file-grid', text: 'set C1 to 424242' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toContain('Done.');
    expect(gridCells.get('Sheet1!0:2')).toEqual(NUM(424242));
    expect(gridEngine!.opsSeen.length).toBeGreaterThan(0);
    expect(otherEngine!.opsSeen.length).toBe(0);
    expect(otherCells.get('Sheet1!0:2')).toEqual(STR('OTHER-FILE'));
  });
});

describe('charts sink primary gate (#99 v2 refinement: viewer chart refused before engine contact)', () => {
  const sessionBase: Omit<ResolvedAgentSession, 'role'> = {
    fileId: 'file-sink',
    sessionId: 'sess_sink',
    engineUrl: 'http://127.0.0.1:8199',
    ownershipEpoch: 1,
    creatorPrincipal: 'user:owner',
    currentRevision: 0,
    updatedAt: NOW,
  };
  const spec = { id: 'c1' } as unknown as Parameters<ChartSink['addChart']>[0];

  it('a viewer session is refused with zero engine fetches', async () => {
    let fetchCalls = 0;
    const sink = createAgentChartSink({
      resolveSession: async () => ({ ...sessionBase, role: 'viewer' }),
      mintEngineToken: () => 'tok',
      fetchFn: (async () => {
        fetchCalls++;
        return { ok: true, json: async () => ({ id: 'c1', revision: 1 }) };
      }) as never,
    });
    await expect(sink.addChart(spec, 'user:viewer')).rejects.toThrow(/read-only/);
    expect(fetchCalls).toBe(0);
  });

  it('an editor session posts to the owning engine', async () => {
    let fetchCalls = 0;
    let postedUrl = '';
    const sink = createAgentChartSink({
      resolveSession: async () => ({ ...sessionBase, role: 'editor' }),
      mintEngineToken: () => 'tok',
      fetchFn: (async (url: string) => {
        fetchCalls++;
        postedUrl = url;
        return { ok: true, json: async () => ({ id: 'c1', revision: 1 }) };
      }) as never,
    });
    await expect(sink.addChart(spec, 'user:owner')).resolves.toEqual({ id: 'c1', revision: 1 });
    expect(fetchCalls).toBe(1);
    expect(postedUrl).toBe('http://127.0.0.1:8199/charts');
  });
});
