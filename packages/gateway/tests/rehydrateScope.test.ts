/**
 * Issue #26 — rehydrate scope coherence (the F-3/#18 restore blocker).
 *
 * Defect: after a session is released and later REHYDRATED, a joined
 * client's reads fail persistently. Root cause (proven in
 * hidden_files/rehydrate-scope/REPORT.md): the W20 load-build gate's
 * sticky error (`lastBuildError` in engineSvc) outlives the session it
 * belonged to. A failed load for session S2 (e.g. a corrupt file)
 * records its parse error; the restore then installs S1 again via
 * claim → rehydrate — no load begins, so the gate is never cleared —
 * and every subsequent /read against the healthy rehydrated S1 throws
 * S2's parse error (500) forever, while /ops, /sheets and /snapshot
 * (which never consult the gate) work. Values never repaint.
 *
 * These tests drive the EXACT F-3 sequence through the real gateway
 * join handshake + engine, and pin:
 *  - the restored session's reads serve its values again (the fix);
 *  - the W20 same-session contract is intact: within the failed
 *    session itself, reads still surface the build error;
 *  - access validation is NOT weakened: tokens scoped to the dead
 *    session, to another file, or to no real session stay refused.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import { MemoryFileRegistry } from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'rehydrate-scope-test-secret';
const DATA_A1 = { sheet: 'Data', row: 0, col: 0 };

function workbookBase64(): string {
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Data', rows: [[10, 20], [30, 40]] }],
    metadata: {},
  } as never);
  return Buffer.from(bytes).toString('base64');
}

const CORRUPT_B64 = Buffer.from('this is not a spreadsheet at all').toString('base64');

function signedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ENGINE_ACCESS_SECRET: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
    // Test pacing only: the production default (lease/3 = 10 s) would
    // make the epoch-adoption wait below dominate the test.
    OWNERSHIP_HEARTBEAT_MS: '100',
    ...extra,
  } as NodeJS.ProcessEnv;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function until(pred: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
describe('issue #26 — gateway F-3 restore sequence', () => {
  let engine: Started | null = null;
  let gw: Started | null = null;
  let registry: MemoryFileRegistry | null = null;

  afterEach(async () => {
    if (gw) await stop(gw);
    if (engine) await stop(engine);
    gw = null;
    engine = null;
    registry = null;
  });

  async function setup() {
    registry = new MemoryFileRegistry();
    const stores = new MemorySessionStores();
    engine = await startServer(
      createEngineListener({
        sessionStores: stores,
        fileRegistry: registry,
        deployEnv: signedEnv(),
      }),
    );
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-test-secret',
        routes: { '/api/engine': engine.url },
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
  }

  async function login(userId: string): Promise<string> {
    const r = await httpJson('POST', `${gw!.url}/auth/login`, { body: { userId } });
    expect(r.status).toBe(200);
    return (r.json as { token: string }).token;
  }

  interface Opened {
    fileId: string;
    sessionId: string;
    accessToken: string;
    engineUrl: string;
    joined: boolean;
  }

  async function open(jwt: string, body: unknown): Promise<Opened> {
    const r = await httpJson('POST', `${gw!.url}/api/engine/open`, { headers: bearer(jwt), body });
    expect(r.status).toBe(200);
    return r.json as Opened;
  }

  /** A session-scoped access grant — what the signed client transport loads/reads with. */
  async function accessGrant(jwt: string, sessionId?: string): Promise<{ accessToken: string; sessionId: string }> {
    const r = await httpJson('POST', `${gw!.url}/api/engine/access`, {
      headers: bearer(jwt),
      body: sessionId ? { sessionId } : {},
    });
    expect(r.status).toBe(200);
    return r.json as { accessToken: string; sessionId: string };
  }

  function engineCall(token: string, path: string, body?: unknown) {
    return httpJson(body === undefined ? 'GET' : 'POST', `${engine!.url}${path}`, {
      headers: bearer(token),
      ...(body === undefined ? {} : { body }),
    });
  }

  it(
    'failed open of file B, then restore of file A: rehydrated session serves reads again',
    async () => {
      await setup();
      const jwt = await login('alice');

      // 1. Open file A (gateway handshake claims a fresh session) and
      //    load a real workbook into it via the access-grant lane.
      const a = await open(jwt, {});
      const gA = await accessGrant(jwt, a.sessionId);
      const load = await engineCall(gA.accessToken, '/load', {
        format: 'xlsx',
        data: workbookBase64(),
        sessionId: a.sessionId,
      });
      expect(load.status).toBe(200);
      const rd0 = await engineCall(gA.accessToken, '/read', { kind: 'cell', ref: DATA_A1 });
      expect(rd0.status).toBe(200);
      expect((rd0.json as { value: unknown }).value).toEqual({ kind: 'number', value: 10 });

      // Wait for the engine to adopt its ownership epoch so the
      // release below clears the gateway lease (the production path:
      // reopening A then takes the CLAIM path, which rehydrates).
      await until(async () => {
        const st = await engineCall(a.accessToken, '/session/status');
        return (st.json as { ownershipEpoch: unknown }).ownershipEpoch === 1;
      });

      // 2. Switch away: the client releases A's session
      //    (superseded-by-new-open) — checkpoint + evict.
      const relA = await engineCall(a.accessToken, '/session/release', {
        sessionId: a.sessionId,
        reason: 'superseded-by-new-open',
      });
      expect(relA.status).toBe(200);

      // 3. Open file B and fail its load (corrupt bytes).
      const b = await open(jwt, {});
      const gB = await accessGrant(jwt, b.sessionId);
      const badLoad = await engineCall(gB.accessToken, '/load', {
        format: 'xlsx',
        data: CORRUPT_B64,
        sessionId: b.sessionId,
      });
      expect(badLoad.status).toBe(400);
      // W20 contract WITHIN the failed session: its reads surface the
      // build error (never a stale/blank answer). This must survive
      // the fix — the error belongs to S2 while S2 is the session.
      const rdB = await engineCall(gB.accessToken, '/read', { kind: 'cell', ref: DATA_A1 });
      expect(rdB.status).toBe(500);
      expect(JSON.stringify(rdB.json)).toContain('failed to parse xlsx');

      // 4. Claim hygiene: the failed claim is released.
      const relB = await engineCall(b.accessToken, '/session/release', {
        sessionId: b.sessionId,
        reason: 'load-failed',
      });
      expect(relB.status).toBe(200);

      // 5. RESTORE: reopen file A. The gateway claim rehydrates A's
      //    checkpointed session — the SAME session id.
      const restored = await open(jwt, { fileId: a.fileId });
      expect(restored.sessionId).toBe(a.sessionId);

      // 6. THE ACCEPTANCE: reads against the rehydrated session serve
      //    its values again — via BOTH token lanes (the fid-scoped
      //    open token and a fresh session-scoped access grant).
      const gA2 = await accessGrant(jwt, restored.sessionId);
      const rd1 = await engineCall(gA2.accessToken, '/read', { kind: 'cell', ref: DATA_A1 });
      expect(rd1.status).toBe(200);
      expect((rd1.json as { value: unknown }).value).toEqual({ kind: 'number', value: 10 });
      const rd2 = await engineCall(restored.accessToken, '/read', {
        kind: 'cell',
        ref: { sheet: 'Data', row: 1, col: 1 },
      });
      expect(rd2.status).toBe(200);
      expect((rd2.json as { value: unknown }).value).toEqual({ kind: 'number', value: 40 });
      const sheets = await engineCall(gA2.accessToken, '/sheets');
      expect(sheets.status).toBe(200);
      const snap = await engineCall(gA2.accessToken, '/snapshot');
      expect(snap.status).toBe(200);

      // 7. The restored session is fully live: an op lands and reads back.
      const op = await engineCall(restored.accessToken, '/ops', {
        clientId: 'alice-c',
        clientSeq: 1,
        baseRev: 0,
        cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 2, col: 0 }, value: 99 },
      });
      expect(op.status).toBe(200);
      expect(op.json).toMatchObject({ ok: true, revision: 1 });
      const rd3 = await engineCall(gA2.accessToken, '/read', {
        kind: 'cell',
        ref: { sheet: 'Data', row: 2, col: 0 },
      });
      expect((rd3.json as { value: unknown }).value).toEqual({ kind: 'number', value: 99 });

      // 8. NEGATIVES — access validation is not weakened by the fix:
      // a token scoped to the DEAD session S2 is refused…
      const deadTok = issueEngineAccessToken({
        secret: SECRET,
        principal: 'user:alice',
        sessionId: b.sessionId,
        tier: 'standard',
        fid: a.fileId,
        role: 'editor',
      }).token;
      const rdDead = await engineCall(deadTok, '/read', { kind: 'cell', ref: DATA_A1 });
      expect(rdDead.status).toBe(401);
      expect(JSON.stringify(rdDead.json)).toContain('wrong-session');
      // …a token for the right session but the WRONG file is refused
      // on the file-scoped routes…
      const wrongFileTok = issueEngineAccessToken({
        secret: SECRET,
        principal: 'user:alice',
        sessionId: a.sessionId,
        tier: 'standard',
        fid: b.fileId,
        role: 'editor',
      }).token;
      const opWrongFile = await engineCall(wrongFileTok, '/ops', {
        clientId: 'alice-c',
        clientSeq: 2,
        baseRev: 1,
        cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 0 }, value: 1 },
      });
      expect(opWrongFile.status).toBe(401);
      expect(JSON.stringify(opWrongFile.json)).toContain('wrong-file');
      // …and an unscoped grant (a fresh random session — what an
      // unbound transport would hold) is refused too.
      const stray = await accessGrant(jwt);
      const rdStray = await engineCall(stray.accessToken, '/read', { kind: 'cell', ref: DATA_A1 });
      expect(rdStray.status).toBe(401);
      expect(JSON.stringify(rdStray.json)).toContain('wrong-session');
    },
    60_000,
  );

  it(
    'rejoin CAS epoch bump is adopted, not fenced (#107 complement)',
    async () => {
      await setup();
      const jwt = await login('alice');

      // 1. Open file A and load a real workbook into it.
      const a = await open(jwt, {});
      const gA = await accessGrant(jwt, a.sessionId);
      const load = await engineCall(gA.accessToken, '/load', {
        format: 'xlsx',
        data: workbookBase64(),
        sessionId: a.sessionId,
      });
      expect(load.status).toBe(200);
      const rd0 = await engineCall(gA.accessToken, '/read', { kind: 'cell', ref: DATA_A1 });
      expect(rd0.status).toBe(200);
      expect((rd0.json as { value: unknown }).value).toEqual({ kind: 'number', value: 10 });

      // 2. Wait for epoch adoption: state epoch must be NON-NULL
      // (1) here, so the post-bump tick MUST take the adopt-higher
      // branch — the null-epoch adopt path would not prove it.
      await until(async () => {
        const st = await engineCall(a.accessToken, '/session/status');
        return (st.json as { ownershipEpoch: unknown }).ownershipEpoch === 1;
      });

      // 3. Simulate the gateway's rejoin CAS: the SAME session on
      // the SAME instance, re-adopted at epoch 2 with a live lease.
      // The record is never released, so no tick can fence on a
      // released record — the ONLY question is whether the tick
      // adopts epoch 2 or fences 'epoch changed'. (A release-then-
      // reopen variant would race the heartbeat tick in the gap and
      // is inherently flaky; the rapid-reclaim gap is documented in
      // the report as a residual, not papered over here.)
      const recBefore = await registry!.lookup(a.fileId);
      expect(recBefore?.ownershipEpoch).toBe(1);
      const bumped = await registry!.claim(
        {
          ...recBefore!,
          ownershipEpoch: 2,
          leaseExpiry: Date.now() + 30_000,
        },
        1,
      );
      expect(bumped).toBe(true);

      // 4. THE ACCEPTANCE: ticks adopt epoch 2 (not fence), and the
      // session serves writes. Epoch 2 with a non-null prior epoch 1
      // is attributable ONLY to the adopt-higher branch: the
      // null-epoch adopt path cannot produce it, and without the
      // branch the tick fences 'epoch changed' and the op 409s.
      await until(async () => {
        const st = await engineCall(a.accessToken, '/session/status');
        return (st.json as { ownershipEpoch: unknown }).ownershipEpoch === 2;
      });
      const stAfter = await engineCall(a.accessToken, '/session/status');
      expect((stAfter.json as { status: unknown }).status).toBe('active');
      expect((stAfter.json as { fenced: unknown }).fenced).toBe(false);
      const op = await engineCall(a.accessToken, '/ops', {
        clientId: 'alice-c',
        clientSeq: 1,
        baseRev: 0,
        cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 2, col: 0 }, value: 99 },
      });
      expect(op.status).toBe(200);
      expect(op.json).toMatchObject({ ok: true, revision: 1 });
      const rd1 = await engineCall(a.accessToken, '/read', {
        kind: 'cell',
        ref: { sheet: 'Data', row: 2, col: 0 },
      });
      expect((rd1.json as { value: unknown }).value).toEqual({ kind: 'number', value: 99 });
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
describe('issue #26 — explicit /session/rehydrate after an interleaved failed load', () => {
  let svc: Started | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  function tokenFor(sid: string, fid?: string): string {
    return issueEngineAccessToken({
      secret: SECRET,
      principal: 'user:alice',
      sessionId: sid,
      tier: 'standard',
      ...(fid ? { fid } : {}),
    }).token;
  }

  function call(token: string, path: string, body?: unknown) {
    return httpJson(body === undefined ? 'GET' : 'POST', `${svc!.url}${path}`, {
      headers: bearer(token),
      ...(body === undefined ? {} : { body }),
    });
  }

  it(
    'rehydrate installs session S1 clean: the dead session S2 build error no longer fails S1 reads',
    async () => {
      const stores = new MemorySessionStores();
      svc = await startServer(
        createEngineListener({ sessionStores: stores, deployEnv: signedEnv() }),
      );
      const t1 = tokenFor('sess_a');
      const load = await call(t1, '/load', {
        format: 'xlsx',
        data: workbookBase64(),
        sessionId: 'sess_a',
      });
      expect(load.status).toBe(200);
      const rel = await call(t1, '/session/release', { sessionId: 'sess_a', reason: 'test-switch' });
      expect(rel.status).toBe(200);

      // A different session is claimed first (the client's open
      // handshake installs the pending session), then its load fails.
      // #104: /session/claim refuses legacy (no-fid) tokens in signed
      // mode, so the claim here uses a file-scoped token, as the
      // gateway open flow does in production. The rest of the test
      // keeps the legacy token, which is what the read/load path
      // runs on (legacy tokens remain accepted there).
      const t2 = tokenFor('sess_b');
      const claimB = await call(tokenFor('sess_b', 'file-b'), '/session/claim', {
        fileId: 'file-b',
        sessionId: 'sess_b',
      });
      expect(claimB.status).toBe(200);
      const bad = await call(t2, '/load', {
        format: 'xlsx',
        data: CORRUPT_B64,
        sessionId: 'sess_b',
      });
      expect(bad.status).toBe(400);
      const relB = await call(t2, '/session/release', { sessionId: 'sess_b', reason: 'load-failed' });
      expect(relB.status).toBe(200);

      // Explicit rehydrate of S1 (the idle-rule resume path).
      const re = await call(t1, '/session/rehydrate', { sessionId: 'sess_a' });
      expect(re.status).toBe(200);
      expect(re.json).toMatchObject({ ok: true, checksumVerified: true });

      const rd = await call(t1, '/read', { kind: 'cell', ref: DATA_A1 });
      expect(rd.status).toBe(200);
      expect((rd.json as { value: unknown }).value).toEqual({ kind: 'number', value: 10 });

      // Negative: the dead session's token stays refused after rehydrate.
      const rdDead = await call(t2, '/read', { kind: 'cell', ref: DATA_A1 });
      expect(rdDead.status).toBe(401);
      expect(JSON.stringify(rdDead.json)).toContain('wrong-session');
    },
    60_000,
  );
});
