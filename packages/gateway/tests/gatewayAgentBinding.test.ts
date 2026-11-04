/**
 * #108: gateway-attached signed binding tests.
 *
 * The gateway resolves a file's engine binding from the registry at
 * proxy time and attaches it, HMAC-signed, to each call to the AI
 * service (x-agent-binding header). The service verifies the
 * signature and uses the endpoint it was given; it never reads the
 * registry for binding. These tests prove the gateway half of that
 * contract through the real gateway proxy:
 *  - a bound call carries a valid signed binding (claims match the
 *    registry record: session, role, endpoint);
 *  - a client-supplied binding is stripped / overwritten, never
 *    forwarded (forgery vector closed at the gateway);
 *  - unbound calls are proxied WITHOUT a binding (service answers
 *    unbound) — never a tier/localhost fallback;
 *  - no-grant calls are refused 403 BEFORE the service is contacted
 *    (primary gate), registry failures 503 fail-closed, and a dead
 *    or wrong-session engine never yields a binding;
 *  - the end-to-end chain (gateway → real agent listener → fake
 *    engine) serves reads and writes on the right engine;
 *  - the sign/verify unit contract (tamper, expiry, scope, endpoint
 *    shape).
 *
 * The service half (listener verifies, zero registry reads) is
 * covered in agentFileBinding.test.ts (poison-registry test).
 */
import type { RequestListener } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TypedValue } from '@icecream-sheets/engine';
import { createGateway } from '../src/gateway.js';
import { createAgentListener } from '../src/services/agentSvc.js';
import {
  AgentBindingError,
  signAgentBinding,
  verifyAgentBinding,
  verifyEngineAccessToken,
} from '../src/deploy/engineAccess.js';
import { MemoryFileRegistry } from '../src/deploy/fileRegistry.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'gateway-binding-test-secret';
const NUM = (value: number): TypedValue => ({ kind: 'number', value });
const NULLV: TypedValue = { kind: 'null', value: null };

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(gwUrl: string, userId: string): Promise<string> {
  const r = await httpJson('POST', `${gwUrl}/auth/login`, { body: { userId } });
  expect(r.status).toBe(200);
  return (r.json as { token: string }).token;
}

interface RecordedCall {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A fake service backend that records what the gateway proxied to it. */
async function startRecorder(): Promise<{
  started: Started;
  calls: RecordedCall[];
  reply: (payload: unknown) => void;
}> {
  const calls: RecordedCall[] = [];
  let replyPayload: unknown = { ok: true };
  const started = await startServer((async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    calls.push({
      path: new URL(req.url ?? '/', 'http://recorder').pathname,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(replyPayload));
  }) as RequestListener);
  return { started, calls, reply: (p: unknown) => { replyPayload = p; } };
}

/**
 * Minimal fake engine: answers the gateway's liveness probe
 * (/session/status) and the agent host's tool routes (/read, /ops,
 * /sheets, /snapshot, /events, /execute). /session/status verifies
 * only the token signature + principal and echoes the token's
 * session id (or the statusSessionId override) — so one engine can
 * serve probes for several records; the tool routes verify sid/fid/
 * role strictly like the real engine's #104 preamble.
 */
async function startFakeEngine(
  sessionId: string,
  fileId: string,
  cells: Map<string, TypedValue>,
  opts: { principal?: string; statusSessionId?: string; status?: string } = {},
): Promise<Started> {
  const principal = opts.principal ?? 'user:carol';
  return startServer((async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-engine');
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    let claims: { sid?: string; fid?: string; role?: string };
    try {
      claims = verifyEngineAccessToken(token, SECRET, { principal });
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
      return send(200, {
        ok: true,
        sessionId: opts.statusSessionId ?? claims.sid ?? sessionId,
        fileId,
        status: opts.status ?? 'active',
        revision: 0,
      });
    }
    // Tool routes: strict scope like the real engine.
    if (claims.sid !== sessionId || claims.fid !== fileId) {
      return send(401, { ok: false, error: 'engine access denied' });
    }
    if (claims.role !== 'editor' && claims.role !== 'viewer') {
      return send(401, { ok: false, error: 'engine access denied' });
    }
    if (url.pathname === '/ops') {
      if (claims.role !== 'editor') {
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
          typeof v === 'number' ? NUM(v) : NULLV,
        );
      }
      return send(200, { ok: true, revision: 1, ack: null });
    }
    if (url.pathname === '/read') {
      if (body.kind === 'cell') {
        const ref = body.ref as { sheet: string; row: number; col: number };
        return send(200, {
          value: cells.get(`${ref.sheet}!${ref.row}:${ref.col}`) ?? NULLV,
        });
      }
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
      if (body.kind === 'usedrange') {
        return send(200, {
          range: { sheet: body.sheet, startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
        });
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
}

function liveRecord(opts: {
  fileId: string;
  sessionId: string;
  endpoint: string;
  creator: string;
  epoch?: number;
}): {
  fileId: string;
  sessionId: string;
  ownerInstance: string;
  ownerEndpoint: string;
  leaseExpiry: number;
  ownershipEpoch: number;
  currentRevision: number;
  storedRevision: number;
  updatedAt: number;
  creatorPrincipal: string;
} {
  return {
    fileId: opts.fileId,
    sessionId: opts.sessionId,
    ownerInstance: 'engine-1',
    ownerEndpoint: opts.endpoint,
    leaseExpiry: Date.now() + 60_000,
    ownershipEpoch: opts.epoch ?? 1,
    currentRevision: 0,
    storedRevision: 0,
    updatedAt: Date.now(),
    creatorPrincipal: opts.creator,
  };
}

class CountingRegistry extends MemoryFileRegistry {
  lookupCalls = 0;
  override async lookup(fileId: string) {
    this.lookupCalls++;
    return super.lookup(fileId);
  }
}

describe('gateway attaches a signed binding (header contract)', () => {
  let engine: Started | null = null;
  let recorder: Awaited<ReturnType<typeof startRecorder>> | null = null;
  let gw: Started | null = null;
  let registry: CountingRegistry | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;

  beforeEach(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'gateway-binding-data-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    engine = await startFakeEngine('sess_g', 'file-g', new Map([['Sheet1!0:0', NUM(5)]]));
    recorder = await startRecorder();
    registry = new CountingRegistry();
    // file-g: carol is the creator (editor).
    expect(
      await registry.claim(
        liveRecord({
          fileId: 'file-g',
          sessionId: 'sess_g',
          endpoint: engine.url,
          creator: 'user:carol',
        }),
        null,
      ),
    ).toBe(true);
    // file-stranger: owned by someone else, no grant for carol.
    expect(
      await registry.claim(
        liveRecord({
          fileId: 'file-stranger',
          sessionId: 'sess_stranger',
          endpoint: engine.url,
          creator: 'user:owner',
        }),
        null,
      ),
    ).toBe(true);
    // file-viewer: owned by someone else, viewer grant for carol.
    expect(
      await registry.claim(
        liveRecord({
          fileId: 'file-viewer',
          sessionId: 'sess_viewer',
          endpoint: engine.url,
          creator: 'user:owner',
        }),
        null,
      ),
    ).toBe(true);
    expect(await registry.noteGrant('file-viewer', 'user:carol', 'viewer', 'user:owner')).toBe(true);

    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-test-secret',
        routes: { '/api/agent': recorder.started.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          secret: SECRET,
          ttlSeconds: 600,
          tiers: { standard: engine.url, xl: engine.url },
        },
        fileRegistry: registry,
        engineInstances: { 'engine-1': engine.url },
        engineInstanceId: 'engine-1',
      }),
    );
  });

  afterEach(async () => {
    if (gw) await stop(gw);
    if (recorder) await stop(recorder.started);
    if (engine) await stop(engine);
    gw = null;
    recorder = null;
    engine = null;
    registry = null;
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  async function postAgent(jwt: string, body: unknown, extraHeaders: Record<string, string> = {}) {
    return httpJson('POST', `${gw!.url}/api/agent/message`, {
      headers: { ...bearer(jwt), ...extraHeaders },
      body,
    });
  }

  it('a bound call carries a valid signed binding matching the registry record', async () => {
    const jwt = await login(gw!.url, 'carol');
    const lookupsBefore = registry!.lookupCalls;
    const r = await postAgent(jwt, { threadId: randomUUID(), fileId: 'file-g', text: 'hi' });
    expect(r.status).toBe(200);
    // Exactly one registry lookup for this message: fresh binding
    // per message, no gateway-side caching.
    expect(registry!.lookupCalls).toBe(lookupsBefore + 1);
    expect(recorder!.calls).toHaveLength(1);
    const call = recorder!.calls[0]!;
    expect(call.headers['x-principal']).toBe('user:carol');
    const header = call.headers['x-agent-binding'];
    expect(typeof header).toBe('string');
    const claims = verifyAgentBinding(header as string, SECRET, {
      principal: 'user:carol',
      fileId: 'file-g',
    });
    expect(claims.sid).toBe('sess_g');
    expect(claims.role).toBe('editor');
    expect(claims.endpoint).toBe(engine!.url);
    expect(claims.epoch).toBe(1);
  });

  it('a viewer grant binds with the viewer role', async () => {
    const jwt = await login(gw!.url, 'carol');
    const r = await postAgent(jwt, { threadId: randomUUID(), fileId: 'file-viewer', text: 'hi' });
    expect(r.status).toBe(200);
    expect(recorder!.calls).toHaveLength(1);
    const claims = verifyAgentBinding(recorder!.calls[0]!.headers['x-agent-binding'] as string, SECRET, {
      principal: 'user:carol',
      fileId: 'file-viewer',
    });
    expect(claims.role).toBe('viewer');
    expect(claims.sid).toBe('sess_viewer');
  });

  it('a client-supplied binding is overwritten by the gateway binding, never forwarded', async () => {
    const jwt = await login(gw!.url, 'carol');
    // Forged binding: validly signed (the test knows the secret) but
    // pointing at an attacker engine for a different file. If it
    // reached the service, the service would call the wrong engine.
    const forged = signAgentBinding({
      secret: SECRET,
      principal: 'user:carol',
      fileId: 'file-evil',
      sessionId: 'sess_evil',
      role: 'editor',
      endpoint: 'http://127.0.0.1:9',
      epoch: 1,
      rev: 0,
    }).binding;
    const r = await postAgent(
      jwt,
      { threadId: randomUUID(), fileId: 'file-g', text: 'hi' },
      { 'x-agent-binding': forged },
    );
    expect(r.status).toBe(200);
    expect(recorder!.calls).toHaveLength(1);
    const forwarded = recorder!.calls[0]!.headers['x-agent-binding'] as string;
    expect(forwarded).not.toBe(forged);
    const claims = verifyAgentBinding(forwarded, SECRET, {
      principal: 'user:carol',
      fileId: 'file-g',
    });
    expect(claims.endpoint).toBe(engine!.url);
    expect(claims.sid).toBe('sess_g');
  });

  it('an unbound call is proxied WITHOUT a binding (a forged header does not leak through)', async () => {
    const jwt = await login(gw!.url, 'carol');
    const forged = signAgentBinding({
      secret: SECRET,
      principal: 'user:carol',
      fileId: 'file-gone',
      sessionId: 'sess_gone',
      role: 'editor',
      endpoint: 'http://127.0.0.1:9',
      epoch: 1,
      rev: 0,
    }).binding;
    const r = await postAgent(
      jwt,
      { threadId: randomUUID(), fileId: 'file-gone', text: 'hi' },
      { 'x-agent-binding': forged },
    );
    expect(r.status).toBe(200);
    expect(recorder!.calls).toHaveLength(1);
    // No binding attached (no live session) AND the client's forged
    // header stripped — the service sees neither.
    expect(recorder!.calls[0]!.headers['x-agent-binding']).toBeUndefined();
  });

  it('a principal with no grant is refused 403 BEFORE the service is contacted', async () => {
    const jwt = await login(gw!.url, 'carol');
    const r = await postAgent(jwt, { threadId: randomUUID(), fileId: 'file-stranger', text: 'hi' });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).toContain('no access grant');
    expect(recorder!.calls).toHaveLength(0);
  });

  it('a registry failure fails closed 503 with zero service contact', async () => {
    const throwing = {
      lookup: async () => {
        throw new Error('registry down');
      },
    } as unknown as MemoryFileRegistry;
    const gw2 = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-test-secret',
        routes: { '/api/agent': recorder!.started.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          secret: SECRET,
          ttlSeconds: 600,
          tiers: { standard: engine!.url, xl: engine!.url },
        },
        fileRegistry: throwing,
        engineInstances: { 'engine-1': engine!.url },
        engineInstanceId: 'engine-1',
      }),
    );
    try {
      const jwt = await login(gw2.url, 'carol');
      const r = await httpJson('POST', `${gw2.url}/api/agent/message`, {
        headers: bearer(jwt),
        body: { threadId: randomUUID(), fileId: 'file-g', text: 'hi' },
      });
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.json)).toContain('session registry unavailable');
      expect(recorder!.calls).toHaveLength(0);
    } finally {
      await stop(gw2);
    }
  });

  it('a dead engine yields 503, never a binding', async () => {
    // Record pointing at a dead endpoint (nothing listening).
    expect(
      await registry!.claim(
        liveRecord({
          fileId: 'file-dead',
          sessionId: 'sess_dead',
          endpoint: 'http://127.0.0.1:9',
          creator: 'user:carol',
        }),
        null,
      ),
    ).toBe(true);
    const jwt = await login(gw!.url, 'carol');
    const r = await postAgent(jwt, { threadId: randomUUID(), fileId: 'file-dead', text: 'hi' });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.json)).toContain('engine unavailable');
    expect(recorder!.calls).toHaveLength(0);
  });

  it('a live response naming another session yields no binding (never a wrong-engine call)', async () => {
    const wrongEngine = await startFakeEngine('sess_wrong', 'file-wrong', new Map(), {
      statusSessionId: 'sess_NOT_THIS',
    });
    try {
      expect(
        await registry!.claim(
          liveRecord({
            fileId: 'file-wrong',
            sessionId: 'sess_wrong',
            endpoint: wrongEngine.url,
            creator: 'user:carol',
          }),
          null,
        ),
      ).toBe(true);
      const jwt = await login(gw!.url, 'carol');
      const r = await postAgent(jwt, { threadId: randomUUID(), fileId: 'file-wrong', text: 'hi' });
      // Proxied (not failed) but WITHOUT a binding: the service
      // answers unbound rather than calling the wrong engine.
      expect(r.status).toBe(200);
      expect(recorder!.calls).toHaveLength(1);
      expect(recorder!.calls[0]!.headers['x-agent-binding']).toBeUndefined();
    } finally {
      await stop(wrongEngine);
    }
  });
});

describe('gateway → service → engine end to end (real agent listener)', () => {
  let engine: Started | null = null;
  let agent: Started | null = null;
  let gw: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;
  const cells = new Map<string, TypedValue>([['Sheet1!0:0', NUM(5)]]);

  beforeEach(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ENGINE_ACCESS_SECRET = SECRET;
    const dataDir = mkdtempSync(join(tmpdir(), 'gateway-binding-e2e-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ICECREAM_DATA_DIR = dataDir;

    engine = await startFakeEngine('sess_e2e', 'file-e2e', cells);
    // The service side is the REAL agent listener with NO registry:
    // it can only serve a file-bound turn from the gateway's
    // attached binding. Any registry read would be impossible (none
    // is configured) — the turn succeeds iff the binding arrived.
    agent = await startServer(createAgentListener({}));
    const registry = new MemoryFileRegistry();
    expect(
      await registry.claim(
        liveRecord({
          fileId: 'file-e2e',
          sessionId: 'sess_e2e',
          endpoint: engine.url,
          creator: 'user:carol',
        }),
        null,
      ),
    ).toBe(true);
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-test-secret',
        routes: { '/api/agent': agent.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          secret: SECRET,
          ttlSeconds: 600,
          tiers: { standard: engine.url, xl: engine.url },
        },
        fileRegistry: registry,
        engineInstances: { 'engine-1': engine.url },
        engineInstanceId: 'engine-1',
      }),
    );
  });

  afterEach(async () => {
    if (gw) await stop(gw);
    if (agent) await stop(agent);
    if (engine) await stop(engine);
    gw = null;
    agent = null;
    engine = null;
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('an agent message reaches the correct engine via the attached binding', async () => {
    const jwt = await login(gw!.url, 'carol');
    const r = await httpJson('POST', `${gw!.url}/api/agent/message`, {
      headers: bearer(jwt),
      body: { threadId: randomUUID(), fileId: 'file-e2e', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toContain('5');
  });

  it('an agent write lands on the correct engine via the attached binding', async () => {
    const jwt = await login(gw!.url, 'carol');
    const r = await httpJson('POST', `${gw!.url}/api/agent/message`, {
      headers: bearer(jwt),
      body: { threadId: randomUUID(), fileId: 'file-e2e', text: 'set C1 to 424242' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toContain('Done.');
    expect(cells.get('Sheet1!0:2')).toEqual(NUM(424242));
  });

  it('a tampered client binding is overwritten by the gateway binding (turn still succeeds)', async () => {
    const jwt = await login(gw!.url, 'carol');
    const good = signAgentBinding({
      secret: SECRET,
      principal: 'user:carol',
      fileId: 'file-e2e',
      sessionId: 'sess_e2e',
      role: 'editor',
      endpoint: engine!.url,
      epoch: 1,
      rev: 0,
    }).binding;
    // Flip a payload character: the signature no longer matches.
    const parts = good.split('.');
    const tampered = `${parts[0]!.slice(0, -1)}${parts[0]!.slice(-1) === 'A' ? 'B' : 'A'}.${parts[1]}`;
    const r = await httpJson('POST', `${gw!.url}/api/agent/message`, {
      headers: { ...bearer(jwt), 'x-agent-binding': tampered },
      body: { threadId: randomUUID(), fileId: 'file-e2e', text: 'What is the value of A1?' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { message: string }).message).toContain('5');
  });
});

describe('binding sign/verify unit contract', () => {
  const base = {
    secret: SECRET,
    principal: 'user:carol',
    fileId: 'file-u',
    sessionId: 'sess_u',
    role: 'editor' as const,
    endpoint: 'http://127.0.0.1:8101',
    epoch: 3,
    rev: 7,
  };

  it('round-trips: sign → verify returns the claims', () => {
    const { binding, claims } = signAgentBinding(base);
    expect(claims).toMatchObject({
      v: 1,
      sub: 'user:carol',
      file: 'file-u',
      sid: 'sess_u',
      role: 'editor',
      endpoint: 'http://127.0.0.1:8101',
      epoch: 3,
      rev: 7,
    });
    expect(verifyAgentBinding(binding, SECRET)).toEqual(claims);
  });

  it('a tampered payload fails bad-signature', () => {
    const { binding } = signAgentBinding(base);
    const parts = binding.split('.');
    const tampered = `${parts[0]!.slice(0, -1)}${parts[0]!.slice(-1) === 'A' ? 'B' : 'A'}.${parts[1]}`;
    expect(() => verifyAgentBinding(tampered, SECRET)).toThrowError(AgentBindingError);
    try {
      verifyAgentBinding(tampered, SECRET);
      throw new Error('unreachable');
    } catch (e) {
      expect((e as AgentBindingError).reason).toBe('bad-signature');
    }
  });

  it('a wrong secret fails bad-signature', () => {
    const { binding } = signAgentBinding(base);
    expect(() => verifyAgentBinding(binding, 'another-secret')).toThrowError(AgentBindingError);
    try {
      verifyAgentBinding(binding, 'another-secret');
      throw new Error('unreachable');
    } catch (e) {
      expect((e as AgentBindingError).reason).toBe('bad-signature');
    }
  });

  it('an expired binding fails expired', () => {
    const { binding } = signAgentBinding({ ...base, ttlSeconds: 60 });
    expect(() =>
      verifyAgentBinding(binding, SECRET, { nowMs: Date.now() + 61_000 }),
    ).toThrowError(AgentBindingError);
    try {
      verifyAgentBinding(binding, SECRET, { nowMs: Date.now() + 61_000 });
      throw new Error('unreachable');
    } catch (e) {
      expect((e as AgentBindingError).reason).toBe('expired');
    }
  });

  it('a principal or file mismatch fails with the matching reason', () => {
    const { binding } = signAgentBinding(base);
    expect(() => verifyAgentBinding(binding, SECRET, { principal: 'user:mallory' })).toThrowError(
      AgentBindingError,
    );
    try {
      verifyAgentBinding(binding, SECRET, { principal: 'user:mallory' });
      throw new Error('unreachable');
    } catch (e) {
      expect((e as AgentBindingError).reason).toBe('wrong-principal');
    }
    try {
      verifyAgentBinding(binding, SECRET, { fileId: 'file-other' });
      throw new Error('unreachable');
    } catch (e) {
      expect((e as AgentBindingError).reason).toBe('wrong-file');
    }
  });

  it('a non-http(s) endpoint fails unsupported-version', () => {
    const { binding } = signAgentBinding({ ...base, endpoint: 'ftp://example.com/x' });
    try {
      verifyAgentBinding(binding, SECRET);
      throw new Error('unreachable');
    } catch (e) {
      expect((e as AgentBindingError).reason).toBe('unsupported-version');
    }
  });

  it('a malformed binding fails malformed', () => {
    for (const bad of ['', 'nodot', '.sig', 'payload.']) {
      try {
        verifyAgentBinding(bad, SECRET);
        throw new Error('unreachable');
      } catch (e) {
        expect((e as AgentBindingError).reason).toBe('malformed');
      }
    }
  });
});
