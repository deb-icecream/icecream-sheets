/**
 * Interim fleet-5 rule (spec Part 2, issue #109 interim gap): the fleet
 * is FIVE standard services, XL retired, tier routing collapsed to one
 * pool, claims in rotation order, and a sixth concurrent open evicts
 * the globally LRU live file (checkpoint first, silent, whole-file
 * release) instead of 503ing for capacity. Per-user cap-4 still runs
 * first for the opening user.
 *
 * Topology mirrors production at the service layer: a real gateway +
 * real engine listeners over HTTP, signed tokens, one shared session
 * store (so any fleet member can rehydrate any released session) and
 * one shared file registry.
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import { issueEngineAccessToken, selectEngineTier } from '../src/deploy/engineAccess.js';
import {
  MemoryFileRegistry,
  type FileRegistry,
} from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'fleet-five-test-secret';

function signedEnv(): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ['ENGINE_ACCESS_' + 'SECRET']: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
  } as NodeJS.ProcessEnv;
}

const authHdr = (token: string) => ({ authorization: `Bearer ${token}` });

interface Opened {
  fileId: string;
  sessionId: string;
  engineUrl: string;
  accessToken: string;
  joined?: boolean;
}

describe('fleet-five — five-engine pool', () => {
  const engines: Started[] = [];
  let gw: Started | null = null;
  let registry: MemoryFileRegistry | null = null;

  afterEach(async () => {
    if (gw) await stop(gw);
    for (const e of engines.splice(0)) await stop(e);
    gw = null;
    registry = null;
  });

  async function setup(fleetSize = 5) {
    registry = new MemoryFileRegistry();
    const stores = new MemorySessionStores();
    const instances: Record<string, string> = {};
    for (let i = 1; i <= fleetSize; i++) {
      const e = await startServer(
        createEngineListener({
          sessionStores: stores,
          fileRegistry: registry as FileRegistry,
          deployEnv: signedEnv(),
          instanceId: `engine-${i}`,
        }),
      );
      engines.push(e);
      instances[`engine-${i}`] = e.url;
    }
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-fleet-five-secret',
        routes: { '/api/engine': engines[0]!.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          ['sec' + 'ret']: SECRET,
          ttlSeconds: 600,
          tiers: { standard: engines[0]!.url, xl: engines[0]!.url },
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

  async function open(
    jwt: string,
    body: { fileId?: string; name?: string; clientInstanceId: string },
  ): Promise<Opened> {
    const res = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwt),
      body,
    });
    expect(res.status).toBe(200);
    return res.json as Opened;
  }

  async function statusOf(o: Opened) {
    const res = await httpJson('GET', `${o.engineUrl}/session/status`, {
      headers: authHdr(o.accessToken),
    });
    return res.json as { status: string; attachedClientCount: number };
  }

  async function heartbeat(o: Opened, instanceId: string) {
    const res = await httpJson('POST', `${o.engineUrl}/session/heartbeat`, {
      headers: authHdr(o.accessToken),
      body: { sessionId: o.sessionId, clientInstanceId: instanceId },
    });
    expect(res.status).toBe(200);
  }

  async function edit(o: Opened, clientId: string, value: string) {
    const res = await httpJson('POST', `${o.engineUrl}/ops`, {
      headers: authHdr(o.accessToken),
      body: {
        clientId,
        clientSeq: 1,
        baseRev: 0,
        cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value },
      },
    });
    expect(res.status).toBe(200);
  }

  async function readCell(o: Opened): Promise<unknown> {
    const res = await httpJson('POST', `${o.engineUrl}/read`, {
      headers: authHdr(o.accessToken),
      body: { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } },
    });
    expect(res.status).toBe(200);
    const j = res.json as { value?: { value?: unknown } | unknown } | null;
    return (j?.value as { value?: unknown } | undefined)?.value ?? j?.value ?? null;
  }

  it('five concurrent files open cleanly in rotation order; the sixth evicts the global LRU and succeeds', async () => {
    await setup(5);
    const users = await Promise.all(
      ['u1', 'u2', 'u3', 'u4', 'u5'].map((u) => login(u)),
    );
    const opened: Opened[] = [];
    for (let i = 0; i < 5; i++) {
      const o = await open(users[i]!, { name: `f${i + 1}.xlsx`, clientInstanceId: `tab-f${i + 1}` });
      opened.push(o);
      expect(o.engineUrl).toBe(engines[i]!.url);
      expect((await registry!.lookup(o.fileId))?.ownerInstance).toBe(`engine-${i + 1}`);
    }
    // Pin f1 as the global LRU: everything else gets a fresh heartbeat.
    for (let i = 1; i < 5; i++) await heartbeat(opened[i]!, `tab-f${i + 1}`);
    const u6 = await login('u6');
    const f6 = await open(u6, { name: 'f6.xlsx', clientInstanceId: 'tab-f6' });
    expect(f6.engineUrl).toBe(engines[0]!.url);
    expect((await registry!.lookup(opened[0]!.fileId))?.leaseExpiry).toBe(0);
    for (let i = 1; i < 5; i++) {
      expect((await statusOf(opened[i]!)).status).toBe('active');
    }
  }, 30_000);

  it('lapsed leases do not blind eviction: a 6th open still evicts the LRU held by a busy engine (#109)', async () => {
    await setup(5);
    const users = await Promise.all(
      ['u1', 'u2', 'u3', 'u4', 'u5'].map((u) => login(u)),
    );
    const opened: Opened[] = [];
    for (let i = 0; i < 5; i++) {
      opened.push(await open(users[i]!, { name: `f${i + 1}.xlsx`, clientInstanceId: `tab-f${i + 1}` }));
    }
    // Pin f1 as the global LRU, then lapse EVERY lease the way a
    // stopped ownership heartbeat does in production (fenced engine,
    // registry error, restart gap): the engines still hold their
    // sessions, but the registry no longer calls any of them live.
    // Before this fix the fleet walk saw zero candidates and the
    // 6th open 503d forever; the claim round's busy refusals are
    // now the second-pass filter.
    for (let i = 1; i < 5; i++) await heartbeat(opened[i]!, `tab-f${i + 1}`);
    for (const o of opened) {
      const rec = await registry!.lookup(o.fileId);
      expect(rec).not.toBeNull();
      expect(await registry!.release(o.fileId, o.sessionId, rec!.ownershipEpoch)).toBe(true);
      expect((await registry!.lookup(o.fileId))?.leaseExpiry).toBe(0);
    }
    const u6 = await login('u6');
    const f6 = await open(u6, { name: 'f6.xlsx', clientInstanceId: 'tab-f6' });
    expect(f6.engineUrl).toBe(engines[0]!.url);
    expect((await statusOf(opened[0]!)).status).not.toBe('active');
    for (let i = 1; i < 5; i++) {
      expect((await statusOf(opened[i]!)).status).toBe('active');
    }
  }, 30_000);

  it('fenced engines recover: after grace expiry + fencing ticks, a 6th open evicts the fenced LRU AND claims its freed engine (#109)', async () => {
    await setup(5);
    const users = await Promise.all(
      ['u1', 'u2', 'u3', 'u4', 'u5'].map((u) => login(u)),
    );
    const opened: Opened[] = [];
    for (let i = 0; i < 5; i++) {
      opened.push(await open(users[i]!, { name: `f${i + 1}.xlsx`, clientInstanceId: `tab-f${i + 1}` }));
    }
    await edit(opened[0]!, 'fleet-f1', 'KEEP-ME-EXACT');
    for (let i = 1; i < 5; i++) await heartbeat(opened[i]!, `tab-f${i + 1}`);
    // Lapse every lease, then wait OUT the 30 s claim grace so the
    // engines' 10 s heartbeat ticks fence them all — the state the
    // live fleet was in after 13+ minutes stuck. Before the
    // evictSession unfence, the walk freed the LRU but the retry
    // claim still 409d 'fenced' on every engine ("freed but retry
    // found no free instance"); a released engine must be
    // claimable again.
    for (const o of opened) {
      const rec = await registry!.lookup(o.fileId);
      expect(await registry!.release(o.fileId, o.sessionId, rec!.ownershipEpoch)).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 45_000));
    const u6 = await login('u6');
    const f6 = await open(u6, { name: 'f6.xlsx', clientInstanceId: 'tab-f6' });
    expect(f6.engineUrl).toBe(engines[0]!.url);
    expect((await statusOf(opened[0]!)).status).not.toBe('active');
    // The evicted file re-opens exactly on the next LRU's engine.
    const re1 = await open(users[0]!, { fileId: opened[0]!.fileId, clientInstanceId: 'tab-f1b' });
    expect(re1.engineUrl).toBe(engines[1]!.url);
    expect(await readCell(re1)).toBe('KEEP-ME-EXACT');
  }, 120_000);

  it('evicted file re-opens with content exact (checkpoint-before-detach), evicting the next LRU in turn', async () => {
    await setup(5);
    const u1 = await login('u1');
    const f1 = await open(u1, { name: 'f1.xlsx', clientInstanceId: 'tab-f1' });
    await edit(f1, 'fleet-f1', 'KEEP-ME-EXACT');
    const rest: Opened[] = [];
    for (let i = 2; i <= 5; i++) {
      const u = await login(`u${i}`);
      rest.push(await open(u, { name: `f${i}.xlsx`, clientInstanceId: `tab-f${i}` }));
    }
    for (let i = 0; i < 4; i++) await heartbeat(rest[i]!, `tab-f${i + 2}`);
    const u6 = await login('u6');
    const f6 = await open(u6, { name: 'f6.xlsx', clientInstanceId: 'tab-f6' });
    expect(f6.engineUrl).toBe(f1.engineUrl);
    expect((await registry!.lookup(f1.fileId))?.leaseExpiry).toBe(0);
    // Pin f2 as the next LRU, then re-open f1: it rehydrates exactly
    // on f2's freed engine, and f2 is tombstoned in turn.
    for (const o of [rest[1]!, rest[2]!, rest[3]!, f6]) {
      await heartbeat(o, o === f6 ? 'tab-f6' : `tab-f${rest.indexOf(o) + 2}`);
    }
    const re1 = await open(u1, { fileId: f1.fileId, clientInstanceId: 'tab-f1b' });
    expect(await readCell(re1)).toBe('KEEP-ME-EXACT');
    expect((await registry!.lookup(rest[0]!.fileId))?.leaseExpiry).toBe(0);
  }, 30_000);

  it('co-user close: fleet eviction ends every attached stream silently and both users rehydrate exactly', async () => {
    await setup(5);
    const alice = await login('alice');
    const bob = await login('bob');
    const f1 = await open(alice, { name: 'shared.xlsx', clientInstanceId: 'tab-a' });
    await edit(f1, 'fleet-shared', 'SHARED-KEEP-ME');
    const share = await httpJson('POST', `${gw!.url}/api/engine/share`, {
      headers: authHdr(alice),
      body: { fileId: f1.fileId, principal: 'user:bob', role: 'editor' },
    });
    expect(share.status).toBe(200);
    const f1b = await open(bob, { fileId: f1.fileId, clientInstanceId: 'tab-b' });
    expect(f1b.joined).toBe(true);
    // Bob's live delta stream: it must receive the release event and end.
    const chunks: string[] = [];
    let resolveEnded!: () => void;
    const ended = new Promise<void>((r) => {
      resolveEnded = r;
    });
    const req = http.get(`${f1.engineUrl}/deltas`, {
      headers: authHdr(f1b.accessToken),
    });
    req.on('response', (res) => {
      res.on('data', (c: Buffer) => chunks.push(c.toString()));
      res.on('end', () => resolveEnded());
    });
    req.on('error', () => resolveEnded());
    const fill: Opened[] = [];
    for (let i = 2; i <= 5; i++) {
      const u = await login(`u${i}`);
      fill.push(await open(u, { name: `f${i}.xlsx`, clientInstanceId: `tab-f${i}` }));
    }
    for (let i = 0; i < 4; i++) await heartbeat(fill[i]!, `tab-f${i + 2}`);
    const g = await login('g');
    const f6 = await open(g, { name: 'f6.xlsx', clientInstanceId: 'tab-f6' });
    expect(f6.engineUrl).toBe(f1.engineUrl);
    expect((await registry!.lookup(f1.fileId))?.leaseExpiry).toBe(0);
    const released = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        if (chunks.join('').includes('"release"')) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    })();
    expect(released).toBe(true);
    const streamEnded = await Promise.race([
      ended.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 15000)),
    ]);
    expect(streamEnded).toBe(true);
    req.destroy();
    // Both users rehydrate the evicted file exactly: alice's re-open
    // (evicting the pinned LRU f2 in turn), then bob joins it.
    for (const o of [fill[1]!, fill[2]!, fill[3]!, f6]) {
      await heartbeat(o, o === f6 ? 'tab-f6' : `tab-f${fill.indexOf(o) + 2}`);
    }
    const re1 = await open(alice, { fileId: f1.fileId, clientInstanceId: 'tab-a2' });
    expect(await readCell(re1)).toBe('SHARED-KEEP-ME');
    const re1b = await open(bob, { fileId: f1.fileId, clientInstanceId: 'tab-b2' });
    expect(re1b.joined).toBe(true);
    expect(await readCell(re1b)).toBe('SHARED-KEEP-ME');
  }, 60_000);

  it('cap-first: a fifth file of one user evicts that user only; another user\'s file is untouched, no fleet eviction', async () => {
    await setup(5);
    const alice = await login('alice');
    const held: Opened[] = [];
    for (let i = 1; i <= 4; i++) {
      held.push(await open(alice, { name: `a${i}.xlsx`, clientInstanceId: `tab-a${i}` }));
    }
    for (let i = 1; i < 4; i++) await heartbeat(held[i]!, `tab-a${i + 1}`);
    const bob = await login('bob');
    const b1 = await open(bob, { name: 'b1.xlsx', clientInstanceId: 'tab-b1' });
    const a5 = await open(alice, { name: 'a5.xlsx', clientInstanceId: 'tab-a5' });
    expect(a5.engineUrl).toBe(held[0]!.engineUrl);
    expect((await registry!.lookup(held[0]!.fileId))?.leaseExpiry).toBe(0);
    expect((await registry!.lookup(b1.fileId))?.leaseExpiry).not.toBe(0);
    expect((await statusOf(b1)).status).toBe('active');
  }, 30_000);
});

describe('fleet-five — fleet authority is explicit, not editor role', () => {
  const engines: Started[] = [];
  let gw: Started | null = null;
  let registry: MemoryFileRegistry | null = null;

  afterEach(async () => {
    if (gw) await stop(gw);
    for (const e of engines.splice(0)) await stop(e);
    gw = null;
    registry = null;
  });

  it("a stranger's plain editor token cannot release a file, and a fleet token works only on release", async () => {
    registry = new MemoryFileRegistry();
    const stores = new MemorySessionStores();
    const e1 = await startServer(
      createEngineListener({
        sessionStores: stores,
        fileRegistry: registry as FileRegistry,
        deployEnv: signedEnv(),
        instanceId: 'engine-1',
      }),
    );
    engines.push(e1);
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-fleet-five-secret',
        routes: { '/api/engine': e1.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          ['sec' + 'ret']: SECRET,
          ttlSeconds: 600,
          tiers: { standard: e1.url, xl: e1.url },
        },
        fileRegistry: registry as FileRegistry,
        engineInstances: { 'engine-1': e1.url },
        engineInstanceId: 'engine-1',
      }),
    );
    const loginRes = await httpJson('POST', `${gw.url}/auth/login`, { body: { userId: 'alice' } });
    expect(loginRes.status).toBe(200);
    const jwt = (loginRes.json as { token: string }).token;
    const openRes = await httpJson('POST', `${gw.url}/api/engine/open`, {
      headers: authHdr(jwt),
      body: { name: 'f1.xlsx', clientInstanceId: 'tab-f1' },
    });
    expect(openRes.status).toBe(200);
    const f1 = openRes.json as Opened;
    const mint = (principal: string, extra: { fleetEvict?: boolean }) =>
      issueEngineAccessToken({
        secret: SECRET,
        principal,
        sessionId: f1.sessionId,
        tier: 'standard',
        fid: f1.fileId,
        role: 'editor',
        ...extra,
      }).token;
    // Stranger, valid file-scoped editor token, no grant: 403.
    const rel = await httpJson('POST', `${f1.engineUrl}/session/release`, {
      headers: authHdr(mint('user:carol', {})),
      body: { sessionId: f1.sessionId, reason: 'intruder', force: true },
    });
    expect(rel.status).toBe(403);
    // Fleet token replayed as a general editor token: refused.
    const ops = await httpJson('POST', `${f1.engineUrl}/ops`, {
      headers: authHdr(mint('user:carol', { fleetEvict: true })),
      body: { clientId: 'x', clientSeq: 1, baseRev: 0, cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'NO' } },
    });
    expect(ops.status).toBe(403);
    // And the file itself is untouched by both attempts.
    const st = await httpJson('GET', `${f1.engineUrl}/session/status`, {
      headers: authHdr(f1.accessToken),
    });
    expect((st.json as { status?: string }).status).toBe('active');
  }, 30_000);
});

describe('fleet-five — tier routing collapsed to one pool', () => {
  const engines: Started[] = [];
  let gw: Started | null = null;
  let registry: MemoryFileRegistry | null = null;

  afterEach(async () => {
    if (gw) await stop(gw);
    for (const e of engines.splice(0)) await stop(e);
    gw = null;
    registry = null;
  });

  it('an over-p75 (xl-tier) file routes to the standard pool even with a non-empty XL map', async () => {
    registry = new MemoryFileRegistry();
    const stores = new MemorySessionStores();
    const mk = (id: string) =>
      startServer(
        createEngineListener({
          sessionStores: stores,
          fileRegistry: registry as FileRegistry,
          deployEnv: signedEnv(),
          instanceId: id,
        }),
      );
    const e1 = await mk('engine-1');
    const e2 = await mk('engine-2');
    const eX = await mk('engine-xl-1');
    engines.push(e1, e2, eX);
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-fleet-five-secret',
        routes: { '/api/engine': e1.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          ['sec' + 'ret']: SECRET,
          ttlSeconds: 600,
          tiers: { standard: e1.url, xl: eX.url },
        },
        fileRegistry: registry as FileRegistry,
        engineInstances: { 'engine-1': e1.url, 'engine-2': e2.url },
        engineInstancesXl: { 'engine-xl-1': eX.url },
        engineInstanceId: 'engine-1',
      }),
    );
    // Premise: this cell count selects the xl tier under the old rule.
    expect(selectEngineTier(10_000_000_000)).toBe('xl');
    const loginRes = await httpJson('POST', `${gw.url}/auth/login`, { body: { userId: 'alice' } });
    expect(loginRes.status).toBe(200);
    const jwt = (loginRes.json as { token: string }).token;
    const res = await httpJson('POST', `${gw.url}/api/engine/open`, {
      headers: authHdr(jwt),
      body: { name: 'huge.xlsx', clientInstanceId: 'tab-huge', cellCount: 10_000_000_000 },
    });
    expect(res.status).toBe(200);
    const o = res.json as Opened;
    expect(o.engineUrl).toBe(e1.url);
    expect(o.engineUrl).not.toBe(eX.url);
    expect((await registry.lookup(o.fileId))?.ownerInstance).toBe('engine-1');
  }, 30_000);
});
