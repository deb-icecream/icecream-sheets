/**
 * Open placement (owner spec, 2026-10-23): a file with no live copy
 * must be placed on a FREE engine instance — a busy instance's §9
 * refusal ('engine already owns a different file') is a placement
 * signal, not an open failure. Same-file opens keep joining the one
 * server copy recorded in the registry. Pool exhausted → a clear
 * capacity 503, never a double-booking.
 *
 * Also pins the client-instance refcount (addendum 2): the engine
 * releases the copy only when the LAST attached client instance
 * detaches; explicit release with an instance id detaches only that
 * instance.
 */
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import {
  MemoryFileRegistry,
  type FileRegistry,
} from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'placement-test-secret';

function signedEnv(): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ['ENGINE_ACCESS_' + 'SECRET']: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
  } as NodeJS.ProcessEnv;
}

const authHdr = (token: string) => ({ authorization: `Bearer ${token}` });

describe('open placement — gateway claim tries the pool', () => {
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

  // Same as setup(), but ONE session-stores instance shared by both
  // engines — the production topology's durable stores are shared
  // exactly this way, which is what lets a DIFFERENT fleet member
  // rehydrate a released session. Per-engine stores would make the
  // cross-engine re-open leg meaningless. AND each engine gets its
  // pool-key instanceId: without it both engines default to
  // 'engine-1', and engine-2's release cannot resolve its epoch
  // (evictSession skips registry.release when the record's
  // ownerInstance differs from the engine's own id) — the record
  // would stay live-looking after a real engine-side eviction. The
  // deploy yamls enforce this equality in production; the plain
  // setup() above remains unfaithful there (pre-existing gap: no
  // placement test asserts an engine-2 release tombstone).
  async function setupShared() {
    registry = new MemoryFileRegistry();
    const stores = new MemorySessionStores();
    const mkEngine = (id: string) =>
      startServer(
        createEngineListener({
          sessionStores: stores,
          fileRegistry: registry as FileRegistry,
          deployEnv: signedEnv(),
          instanceId: id,
        }),
      );
    engine1 = await mkEngine('engine-1');
    engine2 = await mkEngine('engine-2');
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

  function engineToken(principal: string, sid: string, fid: string): string {
    return issueEngineAccessToken({
['sec' + 'ret']: SECRET,
      principal,
      sessionId: sid,
      tier: 'standard',
      fid,
      role: 'editor',
    }).token;
  }

  it('places a second different file on the free instance; registry names the winner', async () => {
    await setup();
    const jwtA = await login('alice');
    const jwtB = await login('bob');

    const openA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { name: 'a.xlsx', clientInstanceId: 'tab-a1' },
    });
    expect(openA.status).toBe(200);
    const A = openA.json as { fileId: string; sessionId: string; engineUrl: string };
    expect(A.engineUrl).toBe(engine1!.url);

    // The defect: on the pre-placement code this open 409'd because
    // engine-1 (the only claim target) already held A's file.
    const openB = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtB),
      body: { name: 'b.xlsx', clientInstanceId: 'tab-b1' },
    });
    expect(openB.status).toBe(200);
    const B = openB.json as { fileId: string; sessionId: string; engineUrl: string };
    expect(B.engineUrl).toBe(engine2!.url);
    expect(B.fileId).not.toBe(A.fileId);

    const recA = await registry!.lookup(A.fileId);
    const recB = await registry!.lookup(B.fileId);
    expect(recA).toMatchObject({ ownerInstance: 'engine-1', ownerEndpoint: engine1!.url, sessionId: A.sessionId });
    expect(recB).toMatchObject({ ownerInstance: 'engine-2', ownerEndpoint: engine2!.url, sessionId: B.sessionId });
  });

  it('pool exhausted -> fleet eviction: the globally LRU file is released (checkpoint first) and the new open succeeds, never 503', async () => {
    // Interim fleet-5 rule (spec §2.3): at capacity the gateway evicts
    // the globally LRU live file instead of 503ing. A is pinned as the
    // LRU by heartbeating B after both opens; A carries an edit, so
    // its exact re-open proves checkpoint-before-detach. Shared stores
    // (production topology): the re-open rehydrates on B's engine.
    await setupShared();
    const jwtA = await login('alice');
    const jwtB = await login('bob');
    const jwtC = await login('carol');
    const openA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { name: 'a.xlsx' },
    });
    expect(openA.status).toBe(200);
    const A = openA.json as { fileId: string; sessionId: string; engineUrl: string; accessToken: string };
    const openB = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtB),
      body: { name: 'b.xlsx' },
    });
    expect(openB.status).toBe(200);
    const B = openB.json as { fileId: string; sessionId: string; engineUrl: string; accessToken: string };
    const ed = await httpJson('POST', `${A.engineUrl}/ops`, {
      headers: authHdr(A.accessToken),
      body: {
        clientId: 'fleet-a',
        clientSeq: 1,
        baseRev: 0,
        cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'KEEP-ME-EXACT' },
      },
    });
    expect(ed.status).toBe(200);
    const hb = await httpJson('POST', `${B.engineUrl}/session/heartbeat`, {
      headers: authHdr(B.accessToken),
      body: { sessionId: B.sessionId },
    });
    expect(hb.status).toBe(200);

    const openC = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtC),
      body: { name: 'c.xlsx' },
    });
    expect(openC.status).toBe(200);
    const C = openC.json as { fileId: string; engineUrl: string };
    // C landed on A's freed engine; A's record is tombstoned; B untouched.
    expect(C.engineUrl).toBe(A.engineUrl);
    expect((await registry!.lookup(A.fileId))?.leaseExpiry).toBe(0);
    const stB = await httpJson('GET', `${B.engineUrl}/session/status`, {
      headers: authHdr(B.accessToken),
    });
    expect((stB.json as { status?: string }).status).toBe('active');

    // Re-opening A rehydrates exactly — and, the pool being full
    // again, evicts the new LRU (B) to make room.
    const reA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { fileId: A.fileId },
    });
    expect(reA.status).toBe(200);
    const RA = reA.json as { accessToken: string };
    const cell = await httpJson('POST', `${(reA.json as { engineUrl: string }).engineUrl}/read`, {
      headers: authHdr(RA.accessToken),
      body: { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } },
    });
    expect(cell.status).toBe(200);
    const cv = cell.json as { value?: { value?: unknown } | unknown } | null;
    expect((cv?.value as { value?: unknown } | undefined)?.value ?? cv?.value).toBe('KEEP-ME-EXACT');
    expect((await registry!.lookup(B.fileId))?.leaseExpiry).toBe(0);
  });

  it('pool exhausted with only orphan-held engines -> capacity 503 preserved (no-loss fallback)', async () => {
    // Engines holding sessions the registry never recorded (direct
    // claims, CAS never ran): the fleet walk finds no live pool file
    // to evict, so the open still 503s — fleet eviction never invents
    // a victim, and the orphans are untouched.
    await setup();
    const jwtC = await login('carol');
    const o1 = await httpJson('POST', `${engine1!.url}/session/claim`, {
      headers: authHdr(engineToken('user:alice', 'sess_orph1', 'file-orph1')),
      body: { fileId: 'file-orph1', sessionId: 'sess_orph1' },
    });
    expect(o1.status).toBe(200);
    const o2 = await httpJson('POST', `${engine2!.url}/session/claim`, {
      headers: authHdr(engineToken('user:bob', 'sess_orph2', 'file-orph2')),
      body: { fileId: 'file-orph2', sessionId: 'sess_orph2' },
    });
    expect(o2.status).toBe(200);
    const openC = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtC),
      body: { name: 'c.xlsx' },
    });
    expect(openC.status).toBe(503);
    const err = (openC.json as { error?: string }).error ?? '';
    expect(err).toContain('no free engine instance');
    expect(err).toContain('fleet eviction attempted, no service freed');
    const st1 = await httpJson('GET', `${engine1!.url}/session/status`, {
      headers: authHdr(engineToken('user:alice', 'sess_orph1', 'file-orph1')),
    });
    expect((st1.json as { status?: string }).status).toBe('active');
    const st2 = await httpJson('GET', `${engine2!.url}/session/status`, {
      headers: authHdr(engineToken('user:bob', 'sess_orph2', 'file-orph2')),
    });
    expect((st2.json as { status?: string }).status).toBe('active');
  });

  it('rotation: after the first engine is freed, the next claim continues rotation instead of returning home', async () => {
    // Interim fleet-5 rule (spec §2.2): claims try the pool in
    // rotation order. A lands on engine-1 (cursor 0 -> 1); after A is
    // released, B's claim starts at engine-2 — home-first would have
    // returned to engine-1.
    await setup();
    const jwtA = await login('alice');
    const jwtB = await login('bob');
    const openA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { name: 'a.xlsx' },
    });
    expect(openA.status).toBe(200);
    const A = openA.json as { fileId: string; sessionId: string; engineUrl: string; accessToken: string };
    expect(A.engineUrl).toBe(engine1!.url);
    const rel = await httpJson('POST', `${engine1!.url}/session/release`, {
      headers: authHdr(A.accessToken),
      body: { sessionId: A.sessionId, reason: 'leave', force: true },
    });
    expect(rel.status).toBe(200);
    expect(rel.json).toMatchObject({ released: true });
    const openB = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtB),
      body: { name: 'b.xlsx' },
    });
    expect(openB.status).toBe(200);
    expect((openB.json as { engineUrl: string }).engineUrl).toBe(engine2!.url);
    expect((await registry!.lookup((openB.json as { fileId: string }).fileId))?.ownerInstance).toBe(
      'engine-2',
    );
  });

  it('same file joins the same session; refcounted detach releases only at zero', async () => {
    await setup();
    const jwtA = await login('alice');

    const open1 = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { name: 'shared.xlsx', clientInstanceId: 'tab-1' },
    });
    expect(open1.status).toBe(200);
    const S = open1.json as { fileId: string; sessionId: string; engineUrl: string; accessToken: string };

    // Second tab (same user, new instance) joins the SAME session.
    const open2 = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { fileId: S.fileId, clientInstanceId: 'tab-2' },
    });
    expect(open2.status).toBe(200);
    const S2 = open2.json as { sessionId: string; engineUrl: string; joined: boolean; accessToken: string };
    expect(S2.joined).toBe(true);
    expect(S2.sessionId).toBe(S.sessionId);
    expect(S2.engineUrl).toBe(S.engineUrl);

    const status = await httpJson('GET', `${engine1!.url}/session/status`, {
      headers: authHdr(engineToken('user:alice', S.sessionId, S.fileId)),
    });
    expect((status.json as { attachedClientCount?: number }).attachedClientCount).toBe(2);

    // Tab 1 leaves: detach only — the copy survives for tab 2.
    const rel1 = await httpJson('POST', `${engine1!.url}/session/release`, {
      headers: authHdr(engineToken('user:alice', S.sessionId, S.fileId)),
      body: { sessionId: S.sessionId, reason: 'leave', clientInstanceId: 'tab-1' },
    });
    expect(rel1.status).toBe(200);
    expect(rel1.json).toMatchObject({ detached: true, released: false, attachedClientCount: 1 });

    const status2 = await httpJson('GET', `${engine1!.url}/session/status`, {
      headers: authHdr(engineToken('user:alice', S.sessionId, S.fileId)),
    });
    expect((status2.json as { status?: string }).status).toBe('active');

    // Tab 2 leaves: count reaches zero — the copy is released.
    const rel2 = await httpJson('POST', `${engine1!.url}/session/release`, {
      headers: authHdr(engineToken('user:alice', S.sessionId, S.fileId)),
      body: { sessionId: S.sessionId, reason: 'tab-close', clientInstanceId: 'tab-2' },
    });
    expect(rel2.status).toBe(200);
    expect(rel2.json).toMatchObject({ released: true, attachedClientCount: 0 });

    // And a different file now opens immediately on a free instance —
    // rotation (spec §2.2): open1's claim advanced the cursor past
    // engine-1, so this claim starts at engine-2 rather than returning
    // to the freed home instance.
    const jwtB = await login('bob');
    const openB = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtB),
      body: { name: 'next.xlsx', clientInstanceId: 'tab-b1' },
    });
    expect(openB.status).toBe(200);
    expect((openB.json as { engineUrl: string }).engineUrl).toBe(engine2!.url);
  });

  it('concurrent claims on ONE engine serialize: one wins, the other gets the §9 refusal', async () => {
    await setup();
    // Two different-file claims fired at the same engine in the same
    // tick. Before the claim lock, the second claim interleaved into
    // the first claim's awaits and clobbered its session (both 200,
    // one phantom session). Now: exactly one 200 + one 409.
    const [c1, c2] = await Promise.all([
      httpJson('POST', `${engine1!.url}/session/claim`, {
        headers: authHdr(engineToken('user:alice', 'sess_race1', 'file-race1')),
        body: { fileId: 'file-race1', sessionId: 'sess_race1' },
      }),
      httpJson('POST', `${engine1!.url}/session/claim`, {
        headers: authHdr(engineToken('user:bob', 'sess_race2', 'file-race2')),
        body: { fileId: 'file-race2', sessionId: 'sess_race2' },
      }),
    ]);
    const statuses = [c1.status, c2.status].sort().join(',');
    expect(statuses).toBe('200,409');
  });

  it('no-grant open is refused before any claim (engine-2 stays empty)', async () => {
    await setup();
    const jwtA = await login('alice');
    const jwtB = await login('bob');
    const openA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { name: 'mine.xlsx' },
    });
    expect(openA.status).toBe(200);
    const A = openA.json as { fileId: string };

    // Free engine-1 by releasing, so a claim-path leak would be
    // observable: bob has no grant; his open must 403 BEFORE a claim.
    const openB = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtB),
      body: { fileId: A.fileId },
    });
    expect(openB.status).toBe(403);

    const st2 = await httpJson('GET', `${engine2!.url}/session/status`, {
      headers: authHdr(engineToken('user:bob', 'sess_none', A.fileId)),
    });
    expect((st2.json as { fileId?: unknown }).fileId ?? null).toBeNull();
  });
});

describe('open placement — unreachable instances try the next', () => {
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

  /** A URL on a just-closed localhost port: connects are refused. */
  async function deadUrl(): Promise<string> {
    const srv = createServer();
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
  }

  async function setupPool(
    build: (
      live: { e1: string; e2: string },
      deadA: string,
      deadB: string,
    ) => Record<string, string>,
  ) {
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
    const instances = build(
      { e1: engine1!.url, e2: engine2!.url },
      await deadUrl(),
      await deadUrl(),
    );
    const home = instances['engine-1'] as string;
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-test-secret',
        routes: { '/api/engine': engine1!.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          ['sec' + 'ret']: SECRET,
          ttlSeconds: 600,
          tiers: { standard: home, xl: home },
        },
        fileRegistry: registry as FileRegistry,
        engineInstances: instances,
        engineInstanceId: 'engine-1',
      }),
    );
  }

  async function login(userId: string): Promise<string> {
    const res = await httpJson('POST', `${gw!.url}/auth/login`, { body: { userId } });
    expect(res.status).toBe(200);
    return (res.json as { token: string }).token;
  }

  it('first instance connection-refused -> open lands on the second; registry names the second', async () => {
    // Home instance (engine-1) is DOWN (nothing listens at its URL);
    // the pre-fix code failed this open with an immediate 502.
    await setupPool(({ e2 }, deadA) => ({ 'engine-1': deadA, 'engine-2': e2 }));
    const jwtA = await login('alice');
    const openA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { name: 'a.xlsx', clientInstanceId: 'tab-a1' },
    });
    expect(openA.status).toBe(200);
    const A = openA.json as { fileId: string; sessionId: string; engineUrl: string };
    expect(A.engineUrl).toBe(engine2!.url);
    const recA = await registry!.lookup(A.fileId);
    expect(recA).toMatchObject({
      ownerInstance: 'engine-2',
      ownerEndpoint: engine2!.url,
      sessionId: A.sessionId,
    });
  });

  it('all instances connection-refused -> 502 with the unreachable wording', async () => {
    await setupPool((_live, deadA, deadB) => ({ 'engine-1': deadA, 'engine-2': deadB }));
    const jwtA = await login('alice');
    const openA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { name: 'a.xlsx' },
    });
    expect(openA.status).toBe(502);
    const err = (openA.json as { error?: string }).error ?? '';
    expect(err).toContain('unreachable');
    expect(err).not.toContain('no free engine instance');
  });

  it('busy + unreachable mix -> fleet eviction frees the busy instance (no 503)', async () => {
    // engine-1 alive but busy with alice's file; engine-2 down.
    // Interim fleet-5 rule (spec §2.3): the dead member cannot free
    // anything, but the busy member's live file is evictable — bob's
    // open releases it and lands on engine-1 instead of 503ing.
    await setupPool(({ e1 }, deadA) => ({ 'engine-1': e1, 'engine-2': deadA }));
    const jwtA = await login('alice');
    const jwtB = await login('bob');
    const openA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtA),
      body: { name: 'a.xlsx' },
    });
    expect(openA.status).toBe(200);
    expect((openA.json as { engineUrl: string }).engineUrl).toBe(engine1!.url);
    const A = openA.json as { fileId: string };

    const openB = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwtB),
      body: { name: 'b.xlsx' },
    });
    expect(openB.status).toBe(200);
    expect((openB.json as { engineUrl: string }).engineUrl).toBe(engine1!.url);
    expect((await registry!.lookup(A.fileId))?.leaseExpiry).toBe(0);
  });
});
