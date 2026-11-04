/**
 * Deployment-prep code (Cycle 10 closure W17B): signed-URL engine access,
 * session registry / op journal / snapshot stores, and the idle session
 * lifecycle — design-docs/deployment-architecture.md (Engine access
 * pattern, Idle rule, Engine extensions 1–3).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import {
  EngineAccessError,
  engineAccessMode,
  issueEngineAccessToken,
  selectEngineTier,
  verifyEngineAccessToken,
} from '../src/deploy/engineAccess.js';
import {
  FirestoreSessionStores,
  LocalSessionStores,
  MemorySessionStores,
  createSessionStores,
  prodSessionConfig,
  type FirestoreLike,
  type StorageLike,
} from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'test-engine-access-secret';
const ALICE = { 'x-principal': 'user:alice' };
const A1 = { sheet: 'Sheet1', row: 0, col: 0 };

function tinyXlsxBase64(): string {
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Sheet1', rows: [[10, 20], [null, '=A1+B1']] }],
    metadata: {},
  } as never);
  return Buffer.from(bytes).toString('base64');
}

describe('engine access tokens', () => {
  it('issue → verify round-trip carries principal/session/tier scope', () => {
    const { token, claims } = issueEngineAccessToken({
      secret: SECRET,
      principal: 'user:alice',
      sessionId: 'sess_1',
      tier: 'xl',
      ttlSeconds: 600,
    });
    expect(claims.exp - claims.iat).toBe(600);
    const verified = verifyEngineAccessToken(token, SECRET, {
      sessionId: 'sess_1',
      principal: 'user:alice',
    });
    expect(verified).toMatchObject({ sub: 'user:alice', sid: 'sess_1', tier: 'xl' });
  });

  it('rejects a tampered signature and a wrong secret', () => {
    const { token } = issueEngineAccessToken({
      secret: SECRET,
      principal: 'user:alice',
      sessionId: 'sess_1',
      tier: 'standard',
    });
    const tampered = `${token.slice(0, -2)}xx`;
    expect(() => verifyEngineAccessToken(tampered, SECRET)).toThrowError(EngineAccessError);
    expect(() => verifyEngineAccessToken(tampered, SECRET)).toThrowError(
      expect.objectContaining({ reason: 'bad-signature' }),
    );
    expect(() => verifyEngineAccessToken(token, 'other-secret')).toThrowError(
      expect.objectContaining({ reason: 'bad-signature' }),
    );
  });

  it('rejects expired tokens', () => {
    const { token } = issueEngineAccessToken({
      secret: SECRET,
      principal: 'user:alice',
      sessionId: 'sess_1',
      tier: 'standard',
      ttlSeconds: 60,
      nowMs: Date.now() - 120_000,
    });
    expect(() => verifyEngineAccessToken(token, SECRET)).toThrowError(
      expect.objectContaining({ reason: 'expired' }),
    );
  });

  it('rejects wrong session / wrong principal scope', () => {
    const { token } = issueEngineAccessToken({
      secret: SECRET,
      principal: 'user:alice',
      sessionId: 'sess_1',
      tier: 'standard',
    });
    expect(() => verifyEngineAccessToken(token, SECRET, { sessionId: 'sess_2' })).toThrowError(
      expect.objectContaining({ reason: 'wrong-session' }),
    );
    expect(() => verifyEngineAccessToken(token, SECRET, { principal: 'user:bob' })).toThrowError(
      expect.objectContaining({ reason: 'wrong-principal' }),
    );
    expect(() => verifyEngineAccessToken('not-a-token', SECRET)).toThrowError(
      expect.objectContaining({ reason: 'malformed' }),
    );
  });

  it('mode + tier config: proxy is the default; tier follows the MT threshold', () => {
    expect(engineAccessMode({} as NodeJS.ProcessEnv)).toBe('proxy');
    expect(engineAccessMode({ ENGINE_ACCESS_MODE: 'signed' } as NodeJS.ProcessEnv)).toBe('signed');
    const env = { ICECREAM_MT_CELL_COUNT_THRESHOLD: '10' } as NodeJS.ProcessEnv;
    expect(selectEngineTier(5, env)).toBe('standard');
    expect(selectEngineTier(11, env)).toBe('xl');
    expect(selectEngineTier(undefined, env)).toBe('standard');
  });
});

describe('session stores', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function exerciseStores(stores: {
    registry: MemorySessionStores['registry'];
    journal: MemorySessionStores['journal'];
    snapshots: MemorySessionStores['snapshots'];
  }): Promise<void> {
    const now = Date.now();
    await stores.registry.register({
      sessionId: 'sess_a',
      instanceId: 'engine-1',
      principal: 'user:alice',
      status: 'active',
      revision: 0,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
    expect(await stores.registry.lookup('sess_a')).toMatchObject({ status: 'active', revision: 0 });
    expect(await stores.registry.lookup('sess_nope')).toBeNull();
    // SEGMENTED journal (free-quota model): two segments, ops 1–2 and
    // 3–5, persisted as two writes total.
    const seg = (from: number, to: number) => ({
      sessionId: 'sess_a',
      fromRevision: from,
      toRevision: to,
      ops: Array.from({ length: to - from }, (_, i) => ({
        revision: from + i + 1,
        op: { cmd: 'setCell', ref: A1, value: from + i + 1 },
        at: now,
      })),
      at: now,
    });
    await stores.journal.appendSegment(seg(0, 2));
    await stores.journal.appendSegment(seg(2, 5));
    expect((await stores.journal.readSegments('sess_a', 0)).map((s) => s.toRevision)).toEqual([2, 5]);
    expect((await stores.journal.readSegments('sess_a', 2)).map((s) => s.toRevision)).toEqual([5]);
    expect((await stores.journal.readFrom('sess_a', 1)).map((e) => e.revision)).toEqual([2, 3, 4, 5]);
    expect(await stores.journal.headRevision('sess_a')).toBe(5);
    await stores.snapshots.put('sess_a', {
      bytes: new Uint8Array([1, 2, 3]),
      checksum: 'abc123',
      revision: 2,
      at: now,
    });
    const snap = await stores.snapshots.get('sess_a');
    expect(snap?.checksum).toBe('abc123');
    expect(snap?.revision).toBe(2);
    expect([...(snap?.bytes ?? [])]).toEqual([1, 2, 3]);
    // Truncate removes WHOLE segments with toRevision <= snapshot rev.
    await stores.journal.truncate('sess_a', 2);
    expect((await stores.journal.readSegments('sess_a', 0)).map((s) => s.toRevision)).toEqual([5]);
    expect((await stores.journal.readFrom('sess_a', 0)).map((e) => e.revision)).toEqual([3, 4, 5]);
    await stores.journal.truncate('sess_a', 5);
    expect(await stores.journal.readSegments('sess_a', 0)).toEqual([]);
    expect(await stores.journal.headRevision('sess_a')).toBe(0);
    await stores.registry.release('sess_a');
    expect(await stores.registry.lookup('sess_a')).toMatchObject({ status: 'released' });
  }

  it('local filesystem adapter: registry/journal/snapshot round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-sessions-'));
    dirs.push(dir);
    await exerciseStores(new LocalSessionStores(dir));
    // A second instance over the same dir sees the durable state.
    const again = new LocalSessionStores(dir);
    expect(await again.registry.lookup('sess_a')).toMatchObject({ status: 'released' });
    expect((await again.snapshots.get('sess_a'))?.checksum).toBe('abc123');
  });

  it('in-memory adapter satisfies the same contract', async () => {
    await exerciseStores(new MemorySessionStores());
  });

  it('firestore/GCS adapters satisfy the same contract against in-memory fakes', async () => {
    const docs = new Map<string, Record<string, unknown>>();
    // F-5: transaction support — refs are keyed so txn.get/set find
    // their doc; transactions serialize on a chain (Firestore
    // semantics) and writes buffer until the callback completes.
    const refKeys = new WeakMap<object, string>();
    let txnChain: Promise<unknown> = Promise.resolve();
    const fakeDb: FirestoreLike = {
      runTransaction: (fn) => {
        const run = txnChain.then(async () => {
          const writes: Array<() => void> = [];
          const result = await fn({
            get: async (ref) => {
              const key = refKeys.get(ref);
              if (key === undefined) throw new Error('fake txn: unknown ref');
              return { exists: docs.has(key), data: () => docs.get(key) };
            },
            set: (ref, data, opts) => {
              const key = refKeys.get(ref);
              if (key === undefined) throw new Error('fake txn: unknown ref');
              writes.push(() => {
                docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : { ...data });
              });
            },
          });
          for (const w of writes) w();
          return result;
        });
        txnChain = run.catch(() => undefined);
        return run;
      },
      collection: (name) => ({
        doc: (id) => {
          const key = `${name}/${id}`;
          const ref = {
            get: async () => ({
              exists: docs.has(key),
              data: () => docs.get(key),
            }),
            set: async (data, opts) => {
              docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : { ...data });
            },
            delete: async () => {
              docs.delete(key);
            },
          };
          refKeys.set(ref, key);
          return ref;
        },
        queryEq: async (field, value) =>
          [...docs.entries()]
            .filter(([k, v]) => k.startsWith(`${name}/`) && v[field] === value)
            .map(([k, v]) => ({ id: k.slice(name.length + 1), data: () => v })),
        listAll: async () =>
          [...docs.entries()]
            .filter(([k]) => k.startsWith(`${name}/`))
            .map(([k, v]) => ({ id: k.slice(name.length + 1), data: () => v })),
      }),
    };
    const files = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
    const fakeStorage: StorageLike = {
      bucket: () => ({
        file: (path) => ({
          save: async (data, opts) => {
            const md = (opts as { metadata?: { metadata?: Record<string, string> } } | undefined)
              ?.metadata?.metadata;
            files.set(path, { bytes: Buffer.from(data), metadata: md ?? {} });
          },
          download: async () => {
            const f = files.get(path);
            if (!f) throw new Error('not found');
            return [f.bytes] as [Buffer];
          },
          getMetadata: async () => {
            const f = files.get(path);
            if (!f) throw new Error('not found');
            return [{ metadata: f.metadata }] as [{ metadata: Record<string, string> }];
          },
        }),
      }),
    };
    await exerciseStores(new FirestoreSessionStores(fakeDb, fakeStorage, 'test-bucket'));
  });

  it('prod config fails closed when env is incomplete', () => {
    expect(() => prodSessionConfig({} as NodeJS.ProcessEnv)).toThrowError(/fail closed/);
    expect(() =>
      prodSessionConfig({ GCP_PROJECT_ID: 'p' } as NodeJS.ProcessEnv),
    ).toThrowError(/SESSION_SNAPSHOT_BUCKET/);
    expect(
      prodSessionConfig({
        GCP_PROJECT_ID: 'p',
        SESSION_SNAPSHOT_BUCKET: 'b',
      } as NodeJS.ProcessEnv),
    ).toEqual({ projectId: 'p', databaseId: undefined, snapshotBucket: 'b' });
    return expect(
      createSessionStores({ SESSION_STORE: 'prod' } as NodeJS.ProcessEnv),
    ).rejects.toThrowError(/fail closed/);
  });
});

describe('gateway issuance endpoint', () => {
  let gw: Started | null = null;
  afterEach(async () => {
    if (gw) await stop(gw);
    gw = null;
  });

  async function setup(withAccess: boolean): Promise<void> {
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-secret',
        routes: { '/api/engine': 'http://127.0.0.1:9' },
        rateLimit: { points: 600, perSeconds: 60 },
        ...(withAccess
          ? {
              engineAccess: {
                secret: SECRET,
                ttlSeconds: 600,
                tiers: { standard: 'http://127.0.0.1:8201', xl: 'http://127.0.0.1:8202' },
              },
            }
          : {}),
      }),
    );
  }

  async function login(): Promise<string> {
    const r = await httpJson('POST', `${gw!.url}/auth/login`, { body: { userId: 'alice' } });
    return (r.json as { token: string }).token;
  }

  it('requires a gateway JWT, then issues a scoped token + tier URL', async () => {
    await setup(true);
    const unauth = await httpJson('POST', `${gw!.url}/api/engine/access`, { body: {} });
    expect(unauth.status).toBe(401);
    const jwt = await login();
    const headers = { authorization: `Bearer ${jwt}` };
    const r = await httpJson('POST', `${gw!.url}/api/engine/access`, {
      headers,
      body: { sessionId: 'sess_9', cellCount: 100 },
    });
    expect(r.status).toBe(200);
    const body = r.json as {
      accessToken: string;
      engineUrl: string;
      sessionId: string;
      tier: string;
      expiresInSeconds: number;
    };
    expect(body.sessionId).toBe('sess_9');
    expect(body.tier).toBe('standard');
    expect(body.engineUrl).toBe('http://127.0.0.1:8201');
    expect(body.expiresInSeconds).toBe(600);
    // The issued token verifies against the shared secret + scope.
    const claims = verifyEngineAccessToken(body.accessToken, SECRET, { sessionId: 'sess_9' });
    expect(claims.sub).toBe('user:alice');
    // No sessionId named → the gateway mints one.
    const minted = await httpJson('POST', `${gw!.url}/api/engine/access`, { headers, body: {} });
    expect((minted.json as { sessionId: string }).sessionId).toMatch(/^sess_/);
  });

  it('answers 501 when signed access is not enabled (proxy default)', async () => {
    await setup(false);
    const jwt = await login();
    const r = await httpJson('POST', `${gw!.url}/api/engine/access`, {
      headers: { authorization: `Bearer ${jwt}` },
      body: {},
    });
    expect(r.status).toBe(501);
  });
});

describe('engine service — signed mode', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  function tokenFor(sessionId: string, opts: { ttlSeconds?: number; nowMs?: number } = {}): string {
    return issueEngineAccessToken({
      secret: SECRET,
      principal: 'user:alice',
      sessionId,
      tier: 'standard',
      ttlSeconds: opts.ttlSeconds ?? 600,
      nowMs: opts.nowMs,
    }).token;
  }

  async function setupSigned(extraEnv: Record<string, string> = {}): Promise<MemorySessionStores> {
    const stores = new MemorySessionStores();
    svc = await startServer(
      createEngineListener({
        sessionStores: stores,
        deployEnv: {
          ENGINE_ACCESS_MODE: 'signed',
          ENGINE_ACCESS_SECRET: SECRET,
          ...extraEnv,
        } as NodeJS.ProcessEnv,
      }),
    );
    return stores;
  }

  it('refuses every route without a token; health stays open', async () => {
    await setupSigned();
    expect((await httpJson('GET', `${svc!.url}/health`)).status).toBe(200);
    expect((await httpJson('GET', `${svc!.url}/snapshot`)).status).toBe(401);
    expect(
      (await httpJson('POST', `${svc!.url}/read`, { body: { kind: 'cell', ref: A1 } })).status,
    ).toBe(401);
  });

  it('accepts the token, enforces session scope, expiry, and query-param presentation', async () => {
    await setupSigned();
    const sid = 'sess_scope';
    const auth = { authorization: `Bearer ${tokenFor(sid)}` };
    const reset = await httpJson('POST', `${svc!.url}/reset`, { headers: auth, body: {} });
    expect(reset.status).toBe(200);
    expect((reset.json as { sessionId: string }).sessionId).toBe(sid);
    const ex = await httpJson('POST', `${svc!.url}/execute`, {
      headers: auth,
      body: { cmd: { cmd: 'setCell', ref: A1, value: 7 } },
    });
    expect(ex.status).toBe(200);
    // Query-param presentation (the sendBeacon form) works identically.
    const sheets = await httpJson(
      'GET',
      `${svc!.url}/sheets?access_token=${encodeURIComponent(tokenFor(sid))}`,
    );
    expect(sheets.status).toBe(200);
    // A token scoped to a DIFFERENT session is refused.
    const wrong = await httpJson('POST', `${svc!.url}/read`, {
      headers: { authorization: `Bearer ${tokenFor('sess_other')}` },
      body: { kind: 'cell', ref: A1 },
    });
    expect(wrong.status).toBe(401);
    expect((wrong.json as { error: string }).error).toContain('wrong-session');
    // An expired token is refused.
    const expired = await httpJson('POST', `${svc!.url}/read`, {
      headers: {
        authorization: `Bearer ${tokenFor(sid, { ttlSeconds: 5, nowMs: Date.now() - 60_000 })}`,
      },
      body: { kind: 'cell', ref: A1 },
    });
    expect(expired.status).toBe(401);
    expect((expired.json as { error: string }).error).toContain('expired');
  });

  it('load must name the token session; the response introduces it', async () => {
    await setupSigned();
    const sid = 'sess_load';
    const auth = { authorization: `Bearer ${tokenFor(sid)}` };
    const bad = await httpJson('POST', `${svc!.url}/load`, {
      headers: auth,
      body: { format: 'xlsx', data: tinyXlsxBase64(), sessionId: 'sess_elsewhere' },
    });
    expect(bad.status).toBe(401);
    const ok = await httpJson('POST', `${svc!.url}/load`, {
      headers: auth,
      body: { format: 'xlsx', data: tinyXlsxBase64(), sessionId: sid },
    });
    expect(ok.status).toBe(200);
    expect((ok.json as { sessionId: string }).sessionId).toBe(sid);
    const rd = await httpJson('POST', `${svc!.url}/read`, {
      headers: auth,
      body: { kind: 'cell', ref: { sheet: 'Sheet1', row: 1, col: 1 } },
    });
    expect((rd.json as { value: { value: number } }).value.value).toBe(30);
  });

  it('enforces the per-session rate cap after connect', async () => {
    await setupSigned({ ENGINE_SESSION_RATE_POINTS: '3', ENGINE_SESSION_RATE_WINDOW: '60' });
    const sid = 'sess_rl';
    const auth = { authorization: `Bearer ${tokenFor(sid)}` };
    expect((await httpJson('POST', `${svc!.url}/reset`, { headers: auth, body: {} })).status).toBe(200);
    expect(
      (await httpJson('POST', `${svc!.url}/execute`, {
        headers: auth,
        body: { cmd: { cmd: 'setCell', ref: A1, value: 1 } },
      })).status,
    ).toBe(200);
    expect((await httpJson('GET', `${svc!.url}/sheets`, { headers: auth })).status).toBe(200);
    const limited = await httpJson('GET', `${svc!.url}/sheets`, { headers: auth });
    expect(limited.status).toBe(429);
  });
});

describe('engine service — idle lifecycle + journal (proxy mode)', () => {
  let svc: Started | null = null;
  let stores: MemorySessionStores;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup(env: Record<string, string> = {}): Promise<void> {
    stores = new MemorySessionStores();
    svc = await startServer(
      createEngineListener({
        sessionStores: stores,
        deployEnv: env as NodeJS.ProcessEnv,
      }),
    );
  }

  function post(path: string, body: unknown) {
    return httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });
  }

  it('load → edit (journaled) → release/evict → rehydrate (checksum-verified, values intact)', async () => {
    await setup();
    const load = await post('/load', { format: 'xlsx', data: tinyXlsxBase64() });
    expect(load.status).toBe(200);
    const sid = (load.json as { sessionId: string }).sessionId;
    expect(sid).toMatch(/^sess_/);
    // Edit: BUFFERED in the journal segment buffer as it executes —
    // nothing persisted yet (the durability window; default cap 200).
    const ex = await post('/execute', { cmd: { cmd: 'setCell', ref: A1, value: 15 } });
    expect(ex.status).toBe(200);
    expect(await stores.journal.readSegments(sid, 0)).toEqual([]);
    expect(await stores.registry.lookup(sid)).toMatchObject({ status: 'active', revision: 0 });
    // Heartbeat refreshes activity.
    const hb = await post('/session/heartbeat', { sessionId: sid });
    expect(hb.status).toBe(200);
    // Release: checkpoint + evict.
    const rel = await post('/session/release', { sessionId: sid, reason: 'idle' });
    expect(rel.status).toBe(200);
    expect((rel.json as { checksum: string }).checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(await stores.registry.lookup(sid)).toMatchObject({ status: 'released' });
    // The snapshot exists and the journal was truncated to its revision.
    expect((await stores.snapshots.get(sid))?.revision).toBe(1);
    expect(await stores.journal.readFrom(sid, 0)).toHaveLength(0);
    // Evicted: workbook routes refuse (never answered from a blank host).
    expect((await post('/read', { kind: 'cell', ref: A1 })).status).toBe(409);
    const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: ALICE });
    expect((st.json as { status: string }).status).toBe('released');
    // Rehydrate: checksum-verified, values intact (edited 15; B2 = 15+20).
    const re = await post('/session/rehydrate', { sessionId: sid });
    expect(re.status).toBe(200);
    expect(re.json).toMatchObject({ checksumVerified: true, replayedOps: 0, revision: 1 });
    const rd = await post('/read', { kind: 'cell', ref: A1 });
    expect((rd.json as { value: { value: number } }).value.value).toBe(15);
    const rdB2 = await post('/read', { kind: 'cell', ref: { sheet: 'Sheet1', row: 1, col: 1 } });
    expect((rdB2.json as { value: { value: number } }).value.value).toBe(35);
  });

  it('rehydrate replays journal ops past the snapshot revision', async () => {
    await setup();
    const load = await post('/load', { format: 'xlsx', data: tinyXlsxBase64() });
    const sid = (load.json as { sessionId: string }).sessionId;
    await post('/session/release', { sessionId: sid, reason: 'idle' });
    // Simulate a segment journaled after the last snapshot (the
    // instance-loss case: ops executed + segment flushed, snapshot
    // cadence had not yet run).
    await stores.journal.appendSegment({
      sessionId: sid,
      fromRevision: 0,
      toRevision: 1,
      ops: [{ revision: 1, op: { cmd: 'setCell', ref: A1, value: 99 }, at: Date.now() }],
      at: Date.now(),
    });
    const re = await post('/session/rehydrate', { sessionId: sid });
    expect(re.status).toBe(200);
    expect(re.json).toMatchObject({ checksumVerified: true, replayedOps: 1, revision: 1 });
    const rd = await post('/read', { kind: 'cell', ref: A1 });
    expect((rd.json as { value: { value: number } }).value.value).toBe(99);
  });

  it('segment cap flushes the buffer as ONE segment write; registry revision follows the flush', async () => {
    await setup({ JOURNAL_SEGMENT_MAX_OPS: '2' });
    const load = await post('/load', { format: 'xlsx', data: tinyXlsxBase64() });
    const sid = (load.json as { sessionId: string }).sessionId;
    await post('/execute', { cmd: { cmd: 'setCell', ref: A1, value: 1 } });
    expect(await stores.journal.readSegments(sid, 0)).toEqual([]); // still buffered
    await post('/execute', { cmd: { cmd: 'setCell', ref: A1, value: 2 } });
    const segs = await stores.journal.readSegments(sid, 0);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ fromRevision: 0, toRevision: 2 });
    expect(segs[0]!.ops.map((o) => o.revision)).toEqual([1, 2]);
    expect(await stores.registry.lookup(sid)).toMatchObject({ revision: 2 });
  });

  it('torn journal on rehydrate FAILS CLOSED: 409, session stays released', async () => {
    await setup();
    const load = await post('/load', { format: 'xlsx', data: tinyXlsxBase64() });
    const sid = (load.json as { sessionId: string }).sessionId;
    await post('/session/release', { sessionId: sid, reason: 'idle' });
    // A segment survives reaching revision 1, but the registry records
    // revision 5 — a later segment write was lost (torn journal).
    await stores.journal.appendSegment({
      sessionId: sid,
      fromRevision: 0,
      toRevision: 1,
      ops: [{ revision: 1, op: { cmd: 'setCell', ref: A1, value: 5 }, at: Date.now() }],
      at: Date.now(),
    });
    await stores.registry.update(sid, { revision: 5 });
    const re = await post('/session/rehydrate', { sessionId: sid });
    expect(re.status).toBe(409);
    expect(re.json).toMatchObject({ checksumVerified: false });
    expect((re.json as { error: string }).error).toContain('torn');
    const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: ALICE });
    expect((st.json as { status: string }).status).toBe('released');
  });

  it('checksum mismatch on rehydrate is a hard 409 — session stays released', async () => {
    await setup();
    const load = await post('/load', { format: 'xlsx', data: tinyXlsxBase64() });
    const sid = (load.json as { sessionId: string }).sessionId;
    await post('/session/release', { sessionId: sid, reason: 'idle' });
    // Corrupt the stored snapshot's recorded checksum.
    const snap = await stores.snapshots.get(sid);
    await stores.snapshots.put(sid, { ...snap!, checksum: 'deadbeefdeadbeef' });
    const re = await post('/session/rehydrate', { sessionId: sid });
    expect(re.status).toBe(409);
    expect(re.json).toMatchObject({ checksumVerified: false });
    const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: ALICE });
    expect((st.json as { status: string }).status).toBe('released');
    expect((await post('/read', { kind: 'cell', ref: A1 })).status).toBe(409);
  });

  it('beacon-form release: query token + text/plain body (signed mode)', async () => {
    stores = new MemorySessionStores();
    svc = await startServer(
      createEngineListener({
        sessionStores: stores,
        deployEnv: {
          ENGINE_ACCESS_MODE: 'signed',
          ENGINE_ACCESS_SECRET: SECRET,
        } as NodeJS.ProcessEnv,
      }),
    );
    const sid = 'sess_beacon';
    const token = issueEngineAccessToken({
      secret: SECRET,
      principal: 'user:alice',
      sessionId: sid,
      tier: 'standard',
    }).token;
    const auth = { authorization: `Bearer ${token}` };
    const load = await httpJson('POST', `${svc!.url}/load`, {
      headers: auth,
      body: { format: 'xlsx', data: tinyXlsxBase64(), sessionId: sid },
    });
    expect(load.status).toBe(200);
    // sendBeacon shape: POST, ?access_token=, no Authorization header,
    // body as a text/plain Blob.
    const res = await fetch(
      `${svc!.url}/session/release?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ sessionId: sid, reason: 'tab-close' }),
      },
    );
    expect(res.status).toBe(200);
    expect(await stores.registry.lookup(sid)).toMatchObject({ status: 'released' });
  });

  it('server backstop: the sweeper checkpoints + evicts an idle session', async () => {
    await setup({
      SESSION_LIFECYCLE: 'on',
      IDLE_TIMEOUT_MS: '1000',
      SESSION_SWEEPER_MS: '250',
    });
    const load = await post('/load', { format: 'xlsx', data: tinyXlsxBase64() });
    const sid = (load.json as { sessionId: string }).sessionId;
    expect((await stores.registry.lookup(sid))?.status).toBe('active');
    const deadline = Date.now() + 8000;
    let released = false;
    while (Date.now() < deadline) {
      // NOTE: poll the store directly — polling /session/status would
      // not count as activity, but registry reads keep the test honest
      // (any served workbook request WOULD refresh activity).
      if ((await stores.registry.lookup(sid))?.status === 'released') {
        released = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(released).toBe(true);
    expect((await stores.snapshots.get(sid))?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
