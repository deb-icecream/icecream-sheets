/**
 * Per-user simultaneous-open cap (design doc §9A, owner ruling
 * 2026-10-23): a user may hold at most MAX_OPEN_FILES_PER_USER (4)
 * DISTINCT files open at once across all their client instances.
 * Opening one more distinct file SILENTLY evicts the user from their
 * least recently used open file — ranked by the user's OWN last
 * activity there — detaching only that user's instances (mechanism
 * B); the copy itself is released only by the pre-existing
 * zero-count rule (mechanism A). The cap never refuses an open, and
 * an eviction never loses the evicted user's work (the engine's
 * detach gate confirms the checkpoint first).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import {
  MemoryFileRegistry,
  type FileRegistry,
} from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import {
  maxOpenFilesPerUser,
  pickLru,
  userOpenSetFromStatuses,
  type UserOpenFileEntry,
} from '../src/deploy/userOpenCap.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'open-cap-test-secret';
const CAP = 4;

function signedEnv(): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ['ENGINE_ACCESS_' + 'SECRET']: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
  } as NodeJS.ProcessEnv;
}

const authHdr = (token: string) => ({ authorization: `Bearer ${token}` });
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

type Opened = {
  fileId: string;
  sessionId: string;
  engineUrl: string;
  accessToken: string;
  joined?: boolean;
  revision?: number;
};

describe('per-user open cap — pure helpers', () => {
  it('maxOpenFilesPerUser: default 4, valid override wins, junk falls back', () => {
    expect(maxOpenFilesPerUser({})).toBe(4);
    expect(maxOpenFilesPerUser({ MAX_OPEN_FILES_PER_USER: '3' })).toBe(3);
    expect(maxOpenFilesPerUser({ MAX_OPEN_FILES_PER_USER: '5' })).toBe(5);
    expect(maxOpenFilesPerUser({ MAX_OPEN_FILES_PER_USER: '0' })).toBe(4);
    expect(maxOpenFilesPerUser({ MAX_OPEN_FILES_PER_USER: '-2' })).toBe(4);
    expect(maxOpenFilesPerUser({ MAX_OPEN_FILES_PER_USER: 'x' })).toBe(4);
    expect(maxOpenFilesPerUser({ MAX_OPEN_FILES_PER_USER: '2.5' })).toBe(4);
  });

  it('userOpenSetFromStatuses counts distinct files once; pickLru is deterministic', () => {
    const st = (fileId: string, byPrincipal: unknown, total: number) => ({
      fileId,
      sessionId: `sess-${fileId}`,
      ownerEndpoint: 'http://engine',
      status: { attachedClientCount: total, attachedClientsByPrincipal: byPrincipal },
    });
    const entries = userOpenSetFromStatuses(
      [
        st('file-b', { 'user:a': { instances: ['t1', 't2'], lastActivityAt: 100 } }, 2),
        st('file-a', { 'user:a': { instances: ['t3'], lastActivityAt: 100 } }, 3),
        st('file-c', { 'user:b': { instances: ['t9'], lastActivityAt: 50 } }, 1),
        st('file-d', { 'user:a': { instances: [], lastActivityAt: 10 } }, 0),
      ],
      'user:a',
    );
    // file-c is another user's; file-d has no attached instance for a.
    expect(entries.map((e) => e.fileId).sort()).toEqual(['file-a', 'file-b']);
    expect(entries.find((e) => e.fileId === 'file-b')!.instances).toEqual(['t1', 't2']);
    expect(entries.find((e) => e.fileId === 'file-a')!.totalAttached).toBe(3);
    // Tie on lastActivityAt → lexicographically smaller fileId wins.
    expect(pickLru(entries)!.fileId).toBe('file-a');
    const older: UserOpenFileEntry[] = [
      { fileId: 'file-z', sessionId: 's', ownerEndpoint: 'e', instances: ['i'], lastActivityAt: 5, totalAttached: 1 },
      { fileId: 'file-a', sessionId: 's', ownerEndpoint: 'e', instances: ['i'], lastActivityAt: 9, totalAttached: 1 },
    ];
    expect(pickLru(older)!.fileId).toBe('file-z');
    expect(pickLru([])).toBeNull();
  });
});

describe('per-user open cap — gateway + engine enforcement', () => {
  const engines: Started[] = [];
  let gw: Started | null = null;
  let registry: MemoryFileRegistry | null = null;

  afterEach(async () => {
    if (gw) await stop(gw);
    for (const e of engines.splice(0)) await stop(e);
    gw = null;
    registry = null;
  });

  async function setup(fleetSize = 5, stores: MemorySessionStores = new MemorySessionStores()) {
    registry = new MemoryFileRegistry();
    // ONE stores instance shared by every engine — the production
    // topology's durable stores (Firestore/GCS) are shared exactly
    // this way, which is what lets any fleet member rehydrate any
    // released session. Per-engine stores would make cross-engine
    // rehydrate impossible and the no-loss leg meaningless.
    const instances: Record<string, string> = {};
    for (let i = 1; i <= fleetSize; i++) {
      const e = await startServer(
        createEngineListener({
          sessionStores: stores,
          fileRegistry: registry as FileRegistry,
          deployEnv: signedEnv(),
          // The production contract (deploy/CONFIG.md): each fleet
          // engine's registry identity equals its pool key — the
          // ownership heartbeat's adoption and the release path's
          // epoch resolution both key on it.
          instanceId: `engine-${i}`,
        }),
      );
      engines.push(e);
      instances[`engine-${i}`] = e.url;
    }
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-cap-test-secret',
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
        maxOpenFilesPerUser: CAP,
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
  ): Promise<{ status: number; opened: Opened }> {
    const res = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwt),
      body,
    });
    return { status: res.status, opened: res.json as Opened };
  }

  async function statusOf(o: Opened) {
    const res = await httpJson('GET', `${o.engineUrl}/session/status`, {
      headers: authHdr(o.accessToken),
    });
    return res.json as {
      status: string;
      revision: number;
      attachedClientCount: number;
      attachedClientsByPrincipal: Record<string, { instances: string[]; lastActivityAt: number }>;
    };
  }

  async function heartbeat(o: Opened, instanceId: string) {
    return httpJson('POST', `${o.engineUrl}/session/heartbeat`, {
      headers: authHdr(o.accessToken),
      body: { sessionId: o.sessionId, clientInstanceId: instanceId },
    });
  }

  async function edit(
    o: Opened,
    clientId: string,
    seq: number,
    baseRev: number,
    value: string,
    row = 0,
  ) {
    return httpJson('POST', `${o.engineUrl}/ops`, {
      headers: authHdr(o.accessToken),
      body: {
        clientId,
        clientSeq: seq,
        baseRev,
        cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row, col: 0 }, value },
      },
    });
  }

  async function readCell(o: Opened, row = 0) {
    const res = await httpJson('POST', `${o.engineUrl}/read`, {
      headers: authHdr(o.accessToken),
      body: { kind: 'cell', ref: { sheet: 'Sheet1', row, col: 0 } },
    });
    const j = res.json as { value?: { value?: unknown } | unknown } | null;
    return (j?.value as { value?: unknown } | undefined)?.value ?? j?.value ?? null;
  }

  it('fifth distinct open evicts the LRU file by ACTIVITY order, not open order', async () => {
    await setup();
    const alice = await login('alice');
    const opens: Opened[] = [];
    for (let i = 1; i <= 4; i++) {
      const { status, opened } = await open(alice, {
        name: `f${i}.xlsx`,
        clientInstanceId: `tab-a${i}`,
      });
      expect(status).toBe(200);
      opens.push(opened);
      await tick();
    }
    // Activity AFTER opening: F2, F3, F4, then F1 — so the activity
    // order (stalest first) is F2 < F3 < F4 < F1 even though F1 was
    // opened first. The eviction must take F2, NOT F1.
    for (const idx of [1, 2, 3, 0]) {
      const hb = await heartbeat(opens[idx]!, `tab-a${idx + 1}`);
      expect(hb.status).toBe(200);
      await tick();
    }
    const { status, opened: f5 } = await open(alice, {
      name: 'f5.xlsx',
      clientInstanceId: 'tab-a5',
    });
    expect(status).toBe(200);
    // F2 evicted: alice detached; she was its only user → the copy
    // was released (mechanism A). Asserted on the REGISTRY record:
    // with evict-before-claim (§9A order) the new claim may land on
    // F2's just-freed engine, whose status endpoint then serves the
    // NEW session — the registry's zeroed lease is the durable truth.
    const recF2 = await registry!.lookup(opens[1]!.fileId);
    expect(recF2?.leaseExpiry).toBe(0);
    // F1, F3, F4 untouched and still held by alice.
    for (const idx of [0, 2, 3]) {
      const st = await statusOf(opens[idx]!);
      expect(st.status).toBe('active');
      expect(st.attachedClientsByPrincipal['user:alice']?.instances).toEqual([
        `tab-a${idx + 1}`,
      ]);
    }
    const stF5 = await statusOf(f5);
    expect(stF5.attachedClientsByPrincipal['user:alice']?.instances).toEqual(['tab-a5']);
  }, 60_000);

  it('two instances on one file count once; eviction detaches BOTH', async () => {
    await setup();
    const alice = await login('alice');
    const f1a = (await open(alice, { name: 'one.xlsx', clientInstanceId: 'tab-1a' })).opened;
    await tick();
    const f2 = (await open(alice, { name: 'two.xlsx', clientInstanceId: 'tab-2' })).opened;
    await tick();
    const f3 = (await open(alice, { name: 'three.xlsx', clientInstanceId: 'tab-3' })).opened;
    await tick();
    // Second tab on F1: a JOIN — still 3 distinct files.
    const f1b = (
      await open(alice, { fileId: f1a.fileId, clientInstanceId: 'tab-1b' })
    ).opened;
    expect(f1b.joined).toBe(true);
    expect(f1b.sessionId).toBe(f1a.sessionId);
    // Fourth distinct file: at the cap exactly — no eviction.
    const f4 = (await open(alice, { name: 'four.xlsx', clientInstanceId: 'tab-4' })).opened;
    const stF1 = await statusOf(f1a);
    expect(stF1.status).toBe('active');
    expect(stF1.attachedClientCount).toBe(2);
    // Refresh activity on F2, F3, F4 so F1 is alice's LRU.
    await heartbeat(f2, 'tab-2');
    await tick();
    await heartbeat(f3, 'tab-3');
    await tick();
    await heartbeat(f4, 'tab-4');
    await tick();
    // Fifth distinct file → evict F1, detaching both of its tabs.
    const { status } = await open(alice, { name: 'five.xlsx', clientInstanceId: 'tab-5' });
    expect(status).toBe(200);
    // Both tabs detached; F1's copy released (registry lease zeroed
    // — the engine itself may already serve the new file's session).
    const recF1 = await registry!.lookup(f1a.fileId);
    expect(recF1?.leaseExpiry).toBe(0);
    // The survivors are untouched.
    for (const o of [f2, f3, f4]) {
      const st = await statusOf(o);
      expect(st.status).toBe('active');
      expect(st.attachedClientsByPrincipal['user:alice']).toBeDefined();
    }
  }, 60_000);

  it('shared file: evicting one user leaves the collaborator working, uninterrupted', async () => {
    await setup();
    const alice = await login('alice');
    const bob = await login('bob');
    const x = (await open(alice, { name: 'shared.xlsx', clientInstanceId: 'tab-x-a' })).opened;
    // Alice writes her marker at row 5 (bob's later A1 write must not
    // be able to mask the no-loss read-back).
    const ed = await edit(x, 'cap-a', 1, 0, 'ALICE-MARKER', 5);
    expect(ed.status).toBe(200);
    // Owner-recorded grant → bob joins the SAME session.
    const share = await httpJson('POST', `${gw!.url}/api/engine/share`, {
      headers: authHdr(alice),
      body: { fileId: x.fileId, principal: 'user:bob', role: 'editor' },
    });
    expect(share.status).toBe(200);
    const xb = (await open(bob, { fileId: x.fileId, clientInstanceId: 'tab-x-b' })).opened;
    expect(xb.joined).toBe(true);
    expect(xb.sessionId).toBe(x.sessionId);
    // Alice fills her cap with three more files; X becomes her LRU
    // (activity refreshed on the others, never on X).
    const others: Opened[] = [];
    for (let i = 2; i <= 4; i++) {
      const o = (await open(alice, { name: `a${i}.xlsx`, clientInstanceId: `tab-a${i}` })).opened;
      others.push(o);
      await tick();
    }
    for (const o of others) {
      await heartbeat(o, `tab-a${others.indexOf(o) + 2}`);
      await tick();
    }
    // Alice's fifth distinct open evicts HER from X — and only her.
    const { status } = await open(alice, { name: 'a5.xlsx', clientInstanceId: 'tab-a5' });
    expect(status).toBe(200);
    const stX = await statusOf(x);
    expect(stX.status).toBe('active');
    expect(stX.attachedClientsByPrincipal['user:alice']).toBeUndefined();
    expect(stX.attachedClientsByPrincipal['user:bob']?.instances).toEqual(['tab-x-b']);
    // Bob keeps working, uninterrupted: he writes and reads back exact.
    const bobEd = await edit(xb, 'cap-b', 1, stX.revision, 'BOB-STILL-HERE');
    expect(bobEd.status).toBe(200);
    const bobRead = await readCell(xb);
    expect(bobRead).toBe('BOB-STILL-HERE');
    // No loss: alice re-opens X (a fresh join) and HER marker — in
    // its own cell, untouched by bob's write — reads back exact.
    const xa2 = (await open(alice, { fileId: x.fileId, clientInstanceId: 'tab-x-a2' })).opened;
    expect(xa2.joined).toBe(true);
    expect(await readCell(xa2, 5)).toBe('ALICE-MARKER');
    const stX2 = await statusOf(x);
    expect(stX2.attachedClientsByPrincipal['user:alice']?.instances).toEqual(['tab-x-a2']);
  }, 60_000);

  it('no loss: the evicted user\'s edits are present exactly on re-open (sole user, copy released)', async () => {
    await setup();
    const alice = await login('alice');
    const f1 = (await open(alice, { name: 'keep.xlsx', clientInstanceId: 'tab-k1' })).opened;
    const ed = await edit(f1, 'cap-k', 1, 0, 'KEEP-ME-EXACT');
    expect(ed.status).toBe(200);
    const rest: Opened[] = [];
    for (let i = 2; i <= 4; i++) {
      const o = (await open(alice, { name: `n${i}.xlsx`, clientInstanceId: `tab-n${i}` })).opened;
      rest.push(o);
      await tick();
    }
    for (const o of rest) {
      await heartbeat(o, `tab-n${rest.indexOf(o) + 2}`);
      await tick();
    }
    // Fifth open evicts F1 (her LRU); she was its only user, so the
    // copy is checkpointed + released by the zero-count rule.
    const { status } = await open(alice, { name: 'n5.xlsx', clientInstanceId: 'tab-n5' });
    expect(status).toBe(200);
    const recF1 = await registry!.lookup(f1.fileId);
    expect(recF1?.leaseExpiry).toBe(0);
    // Re-open: rehydrates (claim path) with the edit exactly as left.
    const back = await open(alice, { fileId: f1.fileId, clientInstanceId: 'tab-k2' });
    expect(back.status).toBe(200);
    expect(back.opened.sessionId).toBe(f1.sessionId);
    const v = await readCell(back.opened);
    expect(v).toBe('KEEP-ME-EXACT');
  }, 60_000);

  it('capacity composition: with the whole fleet held by the user, eviction frees the instance the 5th claim needs', async () => {
    await setup(4);
    const alice = await login('alice');
    const held: Opened[] = [];
    for (let i = 1; i <= 4; i++) {
      const { status, opened } = await open(alice, {
        name: `c${i}.xlsx`,
        clientInstanceId: `tab-c${i}`,
      });
      expect(status).toBe(200);
      held.push(opened);
      await tick();
    }
    // Fleet exhausted AND cap reached. The 5th open's claim sees
    // only busy refusals; the restricted (sole-attached) cap
    // eviction frees F1's instance and the retried claim lands there.
    const { status, opened: f5 } = await open(alice, {
      name: 'c5.xlsx',
      clientInstanceId: 'tab-c5',
    });
    expect(status).toBe(200);
    expect(f5.engineUrl).toBe(held[0]!.engineUrl);
    const stF5 = await statusOf(f5);
    expect(stF5.attachedClientsByPrincipal['user:alice']?.instances).toEqual(['tab-c5']);
    // The other three files are untouched.
    for (const o of held.slice(1)) {
      const st = await statusOf(o);
      expect(st.status).toBe('active');
      expect(st.attachedClientsByPrincipal['user:alice']).toBeDefined();
    }
  }, 60_000);

  it('full-fleet cap crossing: the shared LRU is evicted semantically FIRST (§9A order), then the stalest sole file frees the claim', async () => {
    await setup(4);
    const alice = await login('alice');
    const bob = await login('bob');
    // Shared file X first (fleet slot 1) — alice's LRU, with bob
    // attached. §9A's sequence evicts the LRU before the claim:
    // alice is detached from X (bob's copy survives), and because
    // that frees no instance, the capacity step then frees her
    // stalest SOLE-attached file (s1) so the claim can land.
    const x = (await open(alice, { name: 'capskip-x.xlsx', clientInstanceId: 'tab-x-a' })).opened;
    const share = await httpJson('POST', `${gw!.url}/api/engine/share`, {
      headers: authHdr(alice),
      body: { fileId: x.fileId, principal: 'user:bob', role: 'editor' },
    });
    expect(share.status).toBe(200);
    const xb = (await open(bob, { fileId: x.fileId, clientInstanceId: 'tab-x-b' })).opened;
    expect(xb.joined).toBe(true);
    // Alice fills the remaining fleet slots with sole-attached files.
    const s1 = (await open(alice, { name: 'capskip-s1.xlsx', clientInstanceId: 'tab-s1' })).opened;
    const s2 = (await open(alice, { name: 'capskip-s2.xlsx', clientInstanceId: 'tab-s2' })).opened;
    const s3 = (await open(alice, { name: 'capskip-s3.xlsx', clientInstanceId: 'tab-s3' })).opened;
    await tick();
    // Ranking: X stalest (shared), then s1, s2, s3 by heartbeat order.
    await heartbeat(s1, 'tab-s1');
    await heartbeat(s2, 'tab-s2');
    await heartbeat(s3, 'tab-s3');
    await tick();
    const { status, opened: f5 } = await open(alice, {
      name: 'capskip-s4.xlsx',
      clientInstanceId: 'tab-s4',
    });
    expect(status).toBe(200);
    // The claim landed on the capacity-freed instance (s1's engine).
    expect(f5.engineUrl).toBe(s1.engineUrl);
    // Semantic eviction: alice detached from X; bob's copy ACTIVE
    // and bob still attached.
    const stX = await statusOf(x);
    expect(stX.status).toBe('active');
    expect(stX.attachedClientsByPrincipal['user:alice']).toBeUndefined();
    expect(stX.attachedClientsByPrincipal['user:bob']?.instances).toEqual(['tab-x-b']);
    // Capacity eviction: s1 released (alice was its sole user) —
    // registry lease zeroed (s1's engine now serves f5, asserted
    // above, so its status endpoint speaks for the new session).
    const recS1 = await registry!.lookup(s1.fileId);
    expect(recS1?.leaseExpiry).toBe(0);
    for (const o of [s2, s3]) {
      const st = await statusOf(o);
      expect(st.status).toBe('active');
      expect(st.attachedClientsByPrincipal['user:alice']).toBeDefined();
    }
  }, 60_000);

  it('eviction release survives a transient checkpoint failure inside the release itself (storage already current)', async () => {
    const inner = new MemorySessionStores();
    // Flaky snapshot store, armed per session: put #1 = the edit's
    // autosave, put #2 = the detach GATE's checkpoint (confirms
    // storage current), put #3 = the release's OWN checkpoint —
    // the one that threw a GCS 'socket hang up' on the real stack
    // and once stranded a session active with zero clients. The
    // release must still complete: storage provably holds the
    // current revision, so teardown loses nothing.
    const putCounts = new Map<string, number>();
    let failSessionId: string | null = null;
    const stores = {
      ...inner,
      snapshots: {
        ...inner.snapshots,
        put: async (sessionId: string, snap: never) => {
          const n = (putCounts.get(sessionId) ?? 0) + 1;
          putCounts.set(sessionId, n);
          if (sessionId === failSessionId && n === 3) {
            throw new Error('simulated socket hang up');
          }
          return inner.snapshots.put(sessionId, snap);
        },
      },
    } as unknown as MemorySessionStores;
    await setup(5, stores);
    const alice = await login('alice');
    const f1 = (await open(alice, { name: 'flaky.xlsx', clientInstanceId: 'tab-f1' })).opened;
    const ed = await edit(f1, 'cap-flaky', 1, 0, 'FLAKY-KEEP-ME');
    expect(ed.status).toBe(200);
    // Wait for the autosave checkpoint (put #1) to land.
    for (let i = 0; i < 60; i++) {
      const st = (await statusOf(f1)) as unknown as { storageRevision?: number };
      if (st.storageRevision === 1) break;
      await tick(50);
    }
    failSessionId = f1.sessionId;
    const rest: Opened[] = [];
    for (let i = 2; i <= 4; i++) {
      const o = (await open(alice, { name: `flaky-n${i}.xlsx`, clientInstanceId: `tab-f${i}` })).opened;
      rest.push(o);
      await tick();
    }
    for (const o of rest) {
      await heartbeat(o, `tab-f${rest.indexOf(o) + 2}`);
      await tick();
    }
    // The crossing open evicts F1; its release's checkpoint (put #3)
    // throws — the eviction must STILL complete (open succeeds,
    // copy released), and the edit must survive exactly.
    const { status } = await open(alice, { name: 'flaky-n5.xlsx', clientInstanceId: 'tab-f5' });
    expect(status).toBe(200);
    const recF1 = await registry!.lookup(f1.fileId);
    expect(recF1?.leaseExpiry).toBe(0);
    const back = await open(alice, { fileId: f1.fileId, clientInstanceId: 'tab-f1b' });
    expect(back.status).toBe(200);
    expect(back.opened.joined).toBe(false);
    expect(await readCell(back.opened)).toBe('FLAKY-KEEP-ME');
  }, 60_000);

  it('detach-user engine pins: identity gate, tombstone, sanctioned re-attach', async () => {
    await setup();
    const alice = await login('alice');
    const bob = await login('bob');
    const o = (await open(alice, { name: 'pins.xlsx', clientInstanceId: 'tab-p1' })).opened;
    // Bob joins too, so the session SURVIVES alice's detach (the
    // tombstone must be distinguishable from a released session).
    const share = await httpJson('POST', `${gw!.url}/api/engine/share`, {
      headers: authHdr(alice),
      body: { fileId: o.fileId, principal: 'user:bob', role: 'editor' },
    });
    expect(share.status).toBe(200);
    const ob = (await open(bob, { fileId: o.fileId, clientInstanceId: 'tab-p2' })).opened;
    expect(ob.sessionId).toBe(o.sessionId);
    const tokenFor = (principal: string) =>
      issueEngineAccessToken({
        ['sec' + 'ret']: SECRET,
        principal,
        sessionId: o.sessionId,
        tier: 'standard',
        fid: o.fileId,
        role: 'editor',
      }).token;
    // Wrong-principal detach is refused: the body names alice but
    // the token is bob's — a caller may only detach as itself.
    const wrong = await httpJson('POST', `${o.engineUrl}/session/detach-user`, {
      headers: authHdr(tokenFor('user:bob')),
      body: { sessionId: o.sessionId, principal: 'user:alice' },
    });
    expect(wrong.status).toBe(403);
    const stStill = await statusOf(o);
    expect(stStill.attachedClientsByPrincipal['user:alice']).toBeDefined();
    // Correct detach (as the gateway performs it during alice's own
    // cap-crossing open): only alice's instance goes; bob's session
    // is untouched and NOT released.
    const det = await httpJson('POST', `${o.engineUrl}/session/detach-user`, {
      headers: authHdr(tokenFor('user:alice')),
      body: { sessionId: o.sessionId, principal: 'user:alice' },
    });
    expect(det.status).toBe(200);
    const detJson = det.json as { detachedInstances: number; released: boolean };
    expect(detJson.detachedInstances).toBe(1);
    expect(detJson.released).toBe(false);
    const stAfter = await statusOf(o);
    expect(stAfter.status).toBe('active');
    expect(stAfter.attachedClientsByPrincipal['user:alice']).toBeUndefined();
    expect(stAfter.attachedClientsByPrincipal['user:bob']?.instances).toEqual(['tab-p2']);
    // TOMBSTONE: alice's detached instance heartbeating must NOT
    // resurrect it — the refusal is the 'detached' shape, and the
    // session (alive for bob) does not regain her instance.
    const hb = await heartbeat(o, 'tab-p1');
    expect(hb.status).toBe(409);
    expect((hb.json as { error?: string }).error).toBe('detached');
    const stTomb = await statusOf(o);
    expect(stTomb.attachedClientsByPrincipal['user:alice']).toBeUndefined();
    // A gateway /session/attach (a fresh sanctioned open) clears the
    // tombstone: the instance attaches again and heartbeats succeed.
    const att = await httpJson('POST', `${o.engineUrl}/session/attach`, {
      headers: authHdr(tokenFor('user:alice')),
      body: { sessionId: o.sessionId, clientInstanceId: 'tab-p1' },
    });
    expect(att.status).toBe(200);
    const hb2 = await heartbeat(o, 'tab-p1');
    expect(hb2.status).toBe(200);
    const stBack = await statusOf(o);
    expect(stBack.attachedClientsByPrincipal['user:alice']?.instances).toEqual(['tab-p1']);
  }, 60_000);
});
