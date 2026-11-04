/**
 * Issue #100 — gateway JOIN liveness probe.
 *
 * A registry record can outlive its engine copy (crash/recycle,
 * lost beacon, swallowed registry.release failure) while the lease
 * is still warm. Before this fix the JOIN branch trusted
 * isLiveOwner(rec) alone and returned a JOIN to the dead endpoint;
 * the client's reconnect loop then re-ran the same dead lookup
 * until the lease lapsed, leaving a refreshed page empty with a
 * manual "Reconnect now" banner. Now the JOIN branch probes the
 * recorded owner's /session/status first: only an 'active' report
 * for THIS sessionId earns a JOIN. Anything else falls through to
 * the existing CLAIM path (same sessionId, epoch+1, adopted or
 * rehydrated on a live instance) — once per open/refresh event,
 * never per call (§9 corrected model: steady-state calls use the
 * direct signed link the open returns).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import {
  MemoryFileRegistry,
  type FileRegistry,
  type FileRegistryRecord,
} from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'join-liveness-test-secret';

function signedEnv(): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ['ENGINE_ACCESS_' + 'SECRET']: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
  } as NodeJS.ProcessEnv;
}

const authHdr = (token: string) => ({ authorization: `Bearer ${token}` });

describe('open JOIN liveness (#100)', () => {
  let engine1: Started | null = null;
  let engine2: Started | null = null;
  let gw: Started | null = null;
  let registry: MemoryFileRegistry | null = null;

  afterEach(async () => {
    if (gw) await stop(gw);
    if (engine1) await stop(engine1);
    if (engine2) await stop(engine2);
    gw = null;
    engine1 = null;
    engine2 = null;
    registry = null;
  });

  async function setup() {
    registry = new MemoryFileRegistry();
    const mkEngine = () =>
      startServer(
        createEngineListener({
          sessionStores: new MemorySessionStores(),
          fileRegistry: registry as FileRegistry,
          deployEnv: signedEnv(),
        }),
      );
    engine1 = await mkEngine();
    engine2 = await mkEngine();
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-test-secret',
        routes: { '/api/engine': engine1!.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          ['sec' + 'ret']: SECRET,
          ttlSeconds: 600,
          tiers: { standard: engine1!.url, xl: engine1!.url },
        },
        fileRegistry: registry as FileRegistry,
        engineInstances: { 'engine-1': engine1!.url, 'engine-2': engine2!.url },
        engineInstanceId: 'engine-1',
      }),
    );
  }

  async function login(userId: string): Promise<string> {
    const res = await httpJson('POST', `${gw!.url}/auth/login`, { body: { userId } });
    expect(res.status).toBe(200);
    return (res.json as { token: string }).token;
  }

  async function open(
    jwt: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, any> }> {
    const res = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwt),
      body,
    });
    return { status: res.status, json: res.json as Record<string, any> };
  }

  function seedRecord(rec: FileRegistryRecord): Promise<boolean> {
    return (registry as MemoryFileRegistry).claim(rec, null);
  }

  it('live owner still JOINs: probe passes, same session + endpoint', async () => {
    await setup();
    const jwt = await login('alice');
    const first = await open(jwt, { name: 'a.xlsx', clientInstanceId: 'tab-a1' });
    expect(first.status).toBe(200);
    expect(first.json.joined).toBe(false);
    const second = await open(jwt, {
      fileId: first.json.fileId,
      clientInstanceId: 'tab-a2',
    });
    expect(second.status).toBe(200);
    expect(second.json.joined).toBe(true);
    expect(second.json.sessionId).toBe(first.json.sessionId);
    expect(second.json.engineUrl).toBe(first.json.engineUrl);
    expect(second.json.engineUrl).toBe(engine1!.url);
  });

  it('dead owner (crashed engine) falls through to CLAIM on a live instance, same sessionId', async () => {
    await setup();
    const jwt = await login('bob');
    // A URL that answers nothing: a server started and stopped before seeding.
    const dead = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const deadUrl = dead.url;
    await stop(dead);
    const fileId = 'file-dead-owner-100';
    const sessionId = 'sess_deadowner10000000000000000001';
    const seeded = await seedRecord({
      fileId,
      sessionId,
      ownerInstance: 'engine-1',
      ownerEndpoint: deadUrl,
      leaseExpiry: Date.now() + 60_000,
      ownershipEpoch: 1,
      currentRevision: 0,
      storedRevision: 0,
      updatedAt: Date.now(),
      creatorPrincipal: 'user:bob',
    });
    expect(seeded).toBe(true);
    const reopened = await open(jwt, { fileId, clientInstanceId: 'tab-b2' });
    expect(reopened.status).toBe(200);
    // NEVER a dead JOIN: the reply is a claim onto a live instance…
    expect(reopened.json.joined).toBe(false);
    expect(reopened.json.sessionId).toBe(sessionId);
    expect(reopened.json.ownershipEpoch).toBe(2);
    expect(reopened.json.engineUrl).not.toBe(deadUrl);
    // …and the returned link is itself live for this session.
    const status = await httpJson('GET', `${reopened.json.engineUrl}/session/status`, {
      headers: authHdr(reopened.json.accessToken),
    });
    expect(status.status).toBe(200);
    expect((status.json as { status: string }).status).toBe('active');
    expect((status.json as { sessionId: string }).sessionId).toBe(sessionId);
  });

  it('owner reporting released falls through to CLAIM, never a JOIN onto the released copy', async () => {
    await setup();
    const jwt = await login('carol');
    const fileId = 'file-released-100';
    const sessionId = 'sess_released10000000000000000001';
    // Stub engine: its session is released. The gateway must not JOIN
    // the released copy; the fall-through CLAIM lands on a live fleet
    // member (home instance first) with the same sessionId.
    const stub = await startServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/session/status' && req.method === 'GET') {
          res.end(JSON.stringify({ ok: true, status: 'released', sessionId }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const seeded = await seedRecord({
      fileId,
      sessionId,
      ownerInstance: 'engine-1',
      ownerEndpoint: stub.url,
      leaseExpiry: Date.now() + 60_000,
      ownershipEpoch: 1,
      currentRevision: 0,
      storedRevision: 0,
      updatedAt: Date.now(),
      creatorPrincipal: 'user:carol',
    });
    expect(seeded).toBe(true);
    try {
      const reopened = await open(jwt, { fileId, clientInstanceId: 'tab-c2' });
      expect(reopened.status).toBe(200);
      expect(reopened.json.joined).toBe(false);
      expect(reopened.json.sessionId).toBe(sessionId);
      expect(reopened.json.engineUrl).toBe(engine1!.url);
      expect(reopened.json.ownershipEpoch).toBe(2);
      const status = await httpJson('GET', `${reopened.json.engineUrl}/session/status`, {
        headers: authHdr(reopened.json.accessToken),
      });
      expect(status.status).toBe(200);
      expect((status.json as { status: string }).status).toBe('active');
    } finally {
      await stop(stub);
    }
  });
});
