/**
 * Phase 2 co-authoring (design doc §§7–9): gateway join handshake,
 * ownership registry integration, the single sequencer (FIFO,
 * idempotency, OT rebase, obsolete rejection), the always-on SSE
 * delta channel with per-principal hidden filtering, presence
 * (never journaled), journal retention (§1), and fencing (§9).
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createGateway } from '../src/gateway.js';
import {
  createEngineListener,
  presenceColorFor,
  retentionPruneUpto,
  segmentPrunable,
} from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import { MemoryFileRegistry, type FileRegistry } from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'phase2-test-secret';
const A1 = { sheet: 'Sheet1', row: 0, col: 0 };

function tinyXlsxBase64(): string {
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Sheet1', rows: [[10, 20], [null, '=A1+B1']] }],
    metadata: {},
  } as never);
  return Buffer.from(bytes).toString('base64');
}

function signedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ENGINE_ACCESS_SECRET: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
    ...extra,
  } as NodeJS.ProcessEnv;
}

function tokenFor(
  principal: string,
  sid: string,
  fid: string,
  role: 'editor' | 'viewer' = 'editor',
  withFid = true,
): string {
  return issueEngineAccessToken({
    secret: SECRET,
    principal,
    sessionId: sid,
    tier: 'standard',
    ...(withFid ? { fid, role } : {}),
  }).token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// -- minimal SSE client -------------------------------------------------------
interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}
interface SseClient {
  events: SseEvent[];
  waitFor(pred: (e: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  close(): void;
}

function connectSse(baseUrl: string, token: string): Promise<SseClient> {
  const u = new URL(`${baseUrl}/deltas`);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: u.hostname, port: u.port, path: u.pathname, headers: bearer(token) },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE status ${res.statusCode}`));
          return;
        }
        const events: SseEvent[] = [];
        const waiters: Array<{ pred: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }> = [];
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (block.startsWith(':')) continue;
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            const parsed: SseEvent = { event, data: JSON.parse(data) as Record<string, unknown> };
            events.push(parsed);
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i]!.pred(parsed)) {
                waiters[i]!.resolve(parsed);
                waiters.splice(i, 1);
              }
            }
          }
        });
        resolve({
          events,
          waitFor(pred, timeoutMs = 5000) {
            const found = events.find(pred);
            if (found) return Promise.resolve(found);
            return new Promise<SseEvent>((res2, rej2) => {
              const timer = setTimeout(
                () => rej2(new Error(`SSE waitFor timeout; saw: ${events.map((e) => e.event).join(',')}`)),
                timeoutMs,
              );
              waiters.push({
                pred,
                resolve: (e) => {
                  clearTimeout(timer);
                  res2(e);
                },
              });
            });
          },
          close() {
            req.destroy();
          },
        });
      },
    );
    req.on('error', reject);
  });
}

async function until(pred: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
describe('phase 2 — engine sequencer, SSE deltas, presence, retention', () => {
  let svc: Started | null = null;
  let stores: MemorySessionStores;
  let registry: MemoryFileRegistry;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup(extraEnv: Record<string, string> = {}) {
    stores = new MemorySessionStores();
    registry = new MemoryFileRegistry();
    svc = await startServer(
      createEngineListener({
        sessionStores: stores,
        fileRegistry: registry,
        deployEnv: signedEnv(extraEnv),
      }),
    );
    return svc;
  }

  /** Claim a pending session for `fid` and fill it with the tiny workbook. */
  async function claimAndLoad(fid: string, sid: string, principal = 'user:alice') {
    const tok = tokenFor(principal, sid, fid);
    const claim = await httpJson('POST', `${svc!.url}/session/claim`, {
      headers: bearer(tok),
      body: { fileId: fid, sessionId: sid },
    });
    expect(claim.status).toBe(200);
    const load = await httpJson('POST', `${svc!.url}/load`, {
      headers: bearer(tok),
      body: { format: 'xlsx', data: tinyXlsxBase64(), sessionId: sid },
    });
    expect(load.status).toBe(200);
    return tok;
  }

  function ops(token: string, body: unknown) {
    return httpJson('POST', `${svc!.url}/ops`, { headers: bearer(token), body });
  }

  it('/session/claim: pending session binds the file; a different file is refused 409', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    // Same file: joins the live session.
    const again = await httpJson('POST', `${svc!.url}/session/claim`, {
      headers: bearer(tokenFor('user:bob', 'sess_1', 'file-1')),
      body: { fileId: 'file-1', sessionId: 'sess_1' },
    });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, sessionId: 'sess_1', fileId: 'file-1' });
    // A different file on the same instance: hard refusal, no copy.
    const other = await httpJson('POST', `${svc!.url}/session/claim`, {
      headers: bearer(tokenFor('user:bob', 'sess_2', 'file-2')),
      body: { fileId: 'file-2', sessionId: 'sess_2' },
    });
    expect(other.status).toBe(409);
    expect(alice).toBeTruthy();
  });

  it('/session/claim: a registry record naming a DIFFERENT owner evicts the stale session instead of wedging', async () => {
    await setup();
    await claimAndLoad('file-1', 'sess_1');
    // The registry now names another session as file-1's owner (a
    // takeover landed on another instance): the held sess_1 is stale
    // and owns nothing. Batch-2 wedge fix: the claim for a different
    // file must evict it (checkpoint first) and proceed — a permanent
    // 409 here is what wedged every other file on the instance.
    const seeded = await registry.claim(
      {
        fileId: 'file-1',
        sessionId: 'sess_other',
        ownerInstance: 'engine-2',
        ownerEndpoint: 'http://127.0.0.1:1',
        leaseExpiry: Date.now() + 30_000,
        ownershipEpoch: 1,
        currentRevision: 0,
        storedRevision: 0,
        updatedAt: Date.now(),
        creatorPrincipal: 'user:alice',
      },
      null,
    );
    expect(seeded).toBe(true);
    const other = await httpJson('POST', `${svc!.url}/session/claim`, {
      headers: bearer(tokenFor('user:bob', 'sess_2', 'file-2')),
      body: { fileId: 'file-2', sessionId: 'sess_2' },
    });
    expect(other.status).toBe(200);
    expect(other.json).toMatchObject({ ok: true, sessionId: 'sess_2', fileId: 'file-2' });
  });

  it('/session/claim: a registry READ failure keeps the hard 409 (fail closed, never evict)', async () => {
    await setup();
    await claimAndLoad('file-1', 'sess_1');
    const orig = registry.lookup.bind(registry);
    registry.lookup = (async () => {
      throw new Error('registry down');
    }) as typeof registry.lookup;
    try {
      const other = await httpJson('POST', `${svc!.url}/session/claim`, {
        headers: bearer(tokenFor('user:bob', 'sess_2', 'file-2')),
        body: { fileId: 'file-2', sessionId: 'sess_2' },
      });
      expect(other.status).toBe(409);
    } finally {
      registry.lookup = orig;
    }
  });

  it('sequencer: ops from two principals get sequential revisions + EditAck; retries are idempotent', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');

    const r1 = await ops(alice, {
      clientId: 'alice-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: A1, value: 11 },
    });
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ ok: true, revision: 1, ack: { revision: 1 } });
    const ack1 = (r1.json as { ack: { changedCellCount: number; checksum: string } }).ack;
    // A1 + its dependent B1 changed.
    expect(ack1.changedCellCount).toBe(2);
    expect(typeof ack1.checksum).toBe('string');

    const r2 = await ops(bob, {
      clientId: 'bob-c', clientSeq: 1, baseRev: 1,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 7 },
    });
    expect(r2.json).toMatchObject({ ok: true, revision: 2 });

    // Idempotent retry of bob's op: stored ack, NO re-apply.
    const retry = await ops(bob, {
      clientId: 'bob-c', clientSeq: 1, baseRev: 1,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 999 },
    });
    expect(retry.json).toEqual(r2.json);
    const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: bearer(alice) });
    expect((st.json as { revision: number }).revision).toBe(2);
    const rd = await httpJson('POST', `${svc!.url}/read`, {
      headers: bearer(alice),
      body: { kind: 'cell', ref: { sheet: 'Sheet1', row: 1, col: 0 } },
    });
    expect((rd.json as { value: unknown }).value).toEqual({ kind: 'number', value: 7 });

    // Catch-up: /revisions serves both revisions with delta cells.
    const revs = await httpJson('GET', `${svc!.url}/revisions?from=0&to=2`, { headers: bearer(bob) });
    expect(revs.status).toBe(200);
    const list = (revs.json as { revisions: Array<{ revision: number; origin: { principal: string }; cells: unknown[] }> }).revisions;
    expect(list.map((r) => r.revision)).toEqual([1, 2]);
    expect(list[0]!.origin.principal).toBe('user:alice');
    expect(list[0]!.cells.length).toBe(2);
  });

  it('legacy /execute routes through the sequencer and broadcasts its delta', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    const sse = await connectSse(svc!.url, bob);
    try {
      const hello = await sse.waitFor((e) => e.event === 'hello');
      expect(hello.data).toMatchObject({ revision: 0, fileId: 'file-1' });
      const ex = await httpJson('POST', `${svc!.url}/execute`, {
        headers: bearer(alice),
        body: { cmd: { cmd: 'setCell', ref: A1, value: 33 } },
      });
      expect(ex.json).toEqual({ ok: true });
      const delta = await sse.waitFor((e) => e.event === 'delta');
      expect(delta.data.revision).toBe(1);
      const cells = delta.data.cells as Array<{ sheet: string; row: number; col: number; value: unknown }>;
      expect(cells.some((c) => c.row === 0 && c.col === 0 && JSON.stringify(c.value).includes('33'))).toBe(true);
      // A status event follows the revision change.
      await sse.waitFor((e) => e.event === 'status' && (e.data as { revision: number }).revision === 1);
    } finally {
      sse.close();
    }
  });

  it('status events + save-status carry the last checkpoint size (#105)', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    const sse = await connectSse(svc!.url, bob);
    try {
      await sse.waitFor((e) => e.event === 'hello');
      // Before any checkpoint there is no stored size.
      const pre = await sse.waitFor((e) => e.event === 'status');
      expect((pre.data as { storedBytes?: number }).storedBytes).toBe(0);
      const ex = await httpJson('POST', `${svc!.url}/execute`, {
        headers: bearer(alice),
        body: { cmd: { cmd: 'setCell', ref: A1, value: 33 } },
      });
      expect(ex.json).toEqual({ ok: true });
      // Force a checkpoint (library-save = force save for the owner).
      const save = await httpJson('POST', `${svc!.url}/library-save`, {
        headers: bearer(alice),
        body: {},
      });
      expect(save.status).toBe(200);
      // The checkpoint's status broadcast reports the stored size:
      // the client relays exactly this into the workspace catalog.
      const st = await sse.waitFor(
        (e) =>
          e.event === 'status' &&
          (e.data as { storedRevision: number }).storedRevision === 1 &&
          ((e.data as { storedBytes?: number }).storedBytes ?? 0) > 0,
      );
      expect((st.data as { storedBytes: number }).storedBytes).toBeGreaterThan(0);
      const ss = await httpJson('GET', `${svc!.url}/session-save-status`, {
        headers: bearer(alice),
      });
      expect(ss.status).toBe(200);
      expect((ss.json as { storedBytes: number }).storedBytes).toBeGreaterThan(0);
    } finally {
      sse.close();
    }
  });

  it('storedBytes resets on a new session: no cross-session size leak (#105)', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    await ops(alice, {
      clientId: 'a', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: A1, value: 33 },
    });
    const save = await httpJson('POST', `${svc!.url}/library-save`, {
      headers: bearer(alice),
      body: {},
    });
    expect(save.status).toBe(200);
    const ss1 = await httpJson('GET', `${svc!.url}/session-save-status`, {
      headers: bearer(alice),
    });
    expect((ss1.json as { storedBytes: number }).storedBytes).toBeGreaterThan(0);
    // Evict sess_1 via a registry record naming another owner (the
    // wedge-fix path), then claim a DIFFERENT file on this same
    // (single-session) engine process. The new session must report
    // storedBytes 0 — without the registerSession reset it inherits
    // sess_1's checkpoint size, and the client's catalog sync would
    // record a foreign file's size (proven in the #105 browser proof:
    // an untouched file listed the previous file's 3013 bytes).
    const seeded = await registry.claim(
      {
        fileId: 'file-1',
        sessionId: 'sess_other',
        ownerInstance: 'engine-2',
        ownerEndpoint: 'http://127.0.0.1:1',
        leaseExpiry: Date.now() + 30_000,
        ownershipEpoch: 1,
        currentRevision: 0,
        storedRevision: 0,
        updatedAt: Date.now(),
        creatorPrincipal: 'user:alice',
      },
      null,
    );
    expect(seeded).toBe(true);
    const claim2 = await httpJson('POST', `${svc!.url}/session/claim`, {
      headers: bearer(tokenFor('user:bob', 'sess_2', 'file-2')),
      body: { fileId: 'file-2', sessionId: 'sess_2' },
    });
    expect(claim2.status).toBe(200);
    const sse2 = await connectSse(svc!.url, tokenFor('user:bob', 'sess_2', 'file-2'));
    try {
      const first = await sse2.waitFor((e) => e.event === 'status');
      expect((first.data as { storedBytes?: number }).storedBytes).toBe(0);
      const ss2 = await httpJson('GET', `${svc!.url}/session-save-status`, {
        headers: bearer(tokenFor('user:bob', 'sess_2', 'file-2')),
      });
      expect(ss2.status).toBe(200);
      expect((ss2.json as { storedBytes: number }).storedBytes).toBe(0);
    } finally {
      sse2.close();
    }
  });

  it('structural rebase: a concurrent edit below an inserted row lands at the shifted address', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    // Bob authors an edit to A2 (row 1) against revision 0...
    // ...but Alice's row insert at the top is sequenced first.
    const ins = await ops(alice, {
      clientId: 'alice-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'insertRows', sheet: 'Sheet1', row: 0, count: 1 },
    });
    expect(ins.json).toMatchObject({ ok: true, revision: 1 });
    // Bob's stale op (baseRev 0) is rebased: row 1 → row 2.
    const rebased = await ops(bob, {
      clientId: 'bob-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 77 },
    });
    expect(rebased.json).toMatchObject({ ok: true, revision: 2 });
    const at2 = await httpJson('POST', `${svc!.url}/read`, {
      headers: bearer(alice),
      body: { kind: 'cell', ref: { sheet: 'Sheet1', row: 2, col: 0 } },
    });
    expect((at2.json as { value: unknown }).value).toEqual({ kind: 'number', value: 77 });
    const at1 = await httpJson('POST', `${svc!.url}/read`, {
      headers: bearer(alice),
      body: { kind: 'cell', ref: { sheet: 'Sheet1', row: 1, col: 0 } },
    });
    expect((at1.json as { value: unknown }).value).not.toEqual({ kind: 'number', value: 77 });
  });

  it('obsolete rejection: an op on a since-deleted sheet is visibly rejected, nothing journaled', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    const add = await ops(alice, {
      clientId: 'alice-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'addSheet', name: 'Temp' },
    });
    expect(add.json).toMatchObject({ ok: true, revision: 1 });
    const del = await ops(alice, {
      clientId: 'alice-c', clientSeq: 2, baseRev: 1,
      cmd: { cmd: 'deleteSheet', name: 'Temp' },
    });
    expect(del.json).toMatchObject({ ok: true, revision: 2 });
    // Bob's op was authored at baseRev 1 (Temp still existed for him).
    const obs = await ops(bob, {
      clientId: 'bob-c', clientSeq: 1, baseRev: 1,
      cmd: { cmd: 'setCell', ref: { sheet: 'Temp', row: 0, col: 0 }, value: 1 },
    });
    expect(obs.status).toBe(200);
    expect(obs.json).toMatchObject({ ok: false, rejected: true, reason: 'obsolete', revision: 2 });
    // Nothing was journaled for the rejected op. (The structural
    // barrier checkpoint at revision 1 pruned the delta log to that
    // floor — no attached clients — so catch-up starts from 1.)
    const revs = await httpJson('GET', `${svc!.url}/revisions?from=1`, { headers: bearer(alice) });
    expect(revs.status).toBe(200);
    const list = (revs.json as { revisions: Array<{ revision: number }> }).revisions;
    expect(list.map((r) => r.revision)).toEqual([2]);
  });

  it('SSE delta filtering: a hidden cell crosses as { hidden: true } with NO value/formula', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const owner = tokenFor('user:owner', 'sess_1', 'file-1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    const hide = await httpJson('POST', `${svc!.url}/protection/hide`, {
      headers: bearer(owner),
      body: { sheet: 'Sheet1', ranges: ['A1'] },
    });
    expect(hide.status).toBe(200);
    const sse = await connectSse(svc!.url, bob);
    try {
      await sse.waitFor((e) => e.event === 'hello');
      // The (exempt) owner edits the hidden cell; the delta broadcasts.
      const r = await ops(owner, {
        clientId: 'owner-c', clientSeq: 1, baseRev: 0,
        cmd: { cmd: 'setCell', ref: A1, value: 'topsecret' },
      });
      expect(r.json).toMatchObject({ ok: true, revision: 1 });
      const delta = await sse.waitFor((e) => e.event === 'delta');
      const cells = delta.data.cells as Array<Record<string, unknown>>;
      const a1 = cells.find((c) => c.row === 0 && c.col === 0);
      expect(a1).toBeDefined();
      expect(a1!.hidden).toBe(true);
      expect('value' in a1!).toBe(false);
      expect('formula' in a1!).toBe(false);
      expect(JSON.stringify(delta.data)).not.toContain('topsecret');
      // Alice (also not exempt) is filtered the same way via /revisions.
      const revs = await httpJson('GET', `${svc!.url}/revisions?from=0`, { headers: bearer(alice) });
      const rcells = (revs.json as { revisions: Array<{ cells: Array<Record<string, unknown>> }> }).revisions[0]!.cells;
      const ra1 = rcells.find((c) => c.row === 0 && c.col === 0);
      expect(ra1!.hidden).toBe(true);
      expect('value' in ra1!).toBe(false);
    } finally {
      sse.close();
    }
  });

  it('presence: broadcast with deterministic color, never journaled, never a revision', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    const sse = await connectSse(svc!.url, bob);
    try {
      await sse.waitFor((e) => e.event === 'hello');
      const p = await httpJson('POST', `${svc!.url}/presence`, {
        headers: bearer(alice),
        body: { sheet: 'Sheet1', row: 3, col: 2, editing: true },
      });
      expect(p.status).toBe(200);
      const ev = await sse.waitFor((e) => e.event === 'presence' && (e.data.participants as unknown[]).length > 0);
      const parts = ev.data.participants as Array<{ principal: string; color: string; row: number; col: number }>;
      expect(parts).toEqual([
        {
          principal: 'user:alice',
          color: presenceColorFor('user:alice'),
          sheet: 'Sheet1',
          row: 3,
          col: 2,
          editing: true,
        },
      ]);
      // No revision was assigned and nothing reached the journal.
      const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: bearer(alice) });
      expect((st.json as { revision: number }).revision).toBe(0);
      expect(await stores.journal.headRevision('sess_1')).toBe(0);
      expect(await stores.journal.readSegments('sess_1', 0)).toEqual([]);
      const leave = await httpJson('POST', `${svc!.url}/presence/leave`, {
        headers: bearer(alice),
        body: {},
      });
      expect(leave.status).toBe(200);
      await sse.waitFor(
        (e) => e.event === 'presence' && (e.data.participants as unknown[]).length === 0,
      );
    } finally {
      sse.close();
    }
  });

  it('retention (§1): a slow attached client blocks pruning; its ack unblocks it', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    const sse = await connectSse(svc!.url, bob);
    try {
      await sse.waitFor((e) => e.event === 'hello'); // bob appliedRev = 0
      await ops(alice, { clientId: 'a', clientSeq: 1, baseRev: 0, cmd: { cmd: 'setCell', ref: A1, value: 1 } });
      await ops(alice, { clientId: 'a', clientSeq: 2, baseRev: 1, cmd: { cmd: 'setCell', ref: A1, value: 2 } });
      // Force a checkpoint (library-save = force save for the owner).
      const save1 = await httpJson('POST', `${svc!.url}/library-save`, { headers: bearer(alice), body: {} });
      expect(save1.status).toBe(200);
      // Bob is attached at appliedRev 0 → NOTHING may be pruned, even
      // though storedRevision == checkpoint == 2.
      const segs1 = await stores.journal.readSegments('sess_1', 0);
      expect(segs1.length).toBeGreaterThan(0);
      expect(segs1[0]!.toRevision).toBe(2);
      const revs = await httpJson('GET', `${svc!.url}/revisions?from=0`, { headers: bearer(bob) });
      expect((revs.json as { revisions: unknown[] }).revisions).toHaveLength(2);
      // Bob acks up to 2; a new op + checkpoint may now prune ≤ 2.
      const ack = await httpJson('POST', `${svc!.url}/deltas/ack`, {
        headers: bearer(bob),
        body: { revision: 2 },
      });
      expect(ack.status).toBe(200);
      await ops(alice, { clientId: 'a', clientSeq: 3, baseRev: 2, cmd: { cmd: 'setCell', ref: A1, value: 3 } });
      const save2 = await httpJson('POST', `${svc!.url}/library-save`, { headers: bearer(alice), body: {} });
      expect(save2.status).toBe(200);
      const segs2 = await stores.journal.readSegments('sess_1', 0);
      expect(segs2.map((s) => s.toRevision)).toEqual([3]);
      // Catch-up from before the pruned floor is a 409 before-retention.
      const tooOld = await httpJson('GET', `${svc!.url}/revisions?from=0`, { headers: bearer(bob) });
      expect(tooOld.status).toBe(409);
      expect(tooOld.json).toMatchObject({ error: 'before-retention', oldestRevision: 3 });
      const okRevs = await httpJson('GET', `${svc!.url}/revisions?from=2`, { headers: bearer(bob) });
      expect((okRevs.json as { revisions: Array<{ revision: number }> }).revisions.map((r) => r.revision)).toEqual([3]);
    } finally {
      sse.close();
    }
  });

  it('fencing (§9): a higher epoch in the registry fences this owner — /ops and /deltas refuse 409', async () => {
    await setup({ OWNERSHIP_LEASE_MS: '2000', OWNERSHIP_HEARTBEAT_MS: '50' });
    const alice = await claimAndLoad('file-1', 'sess_1');
    // The gateway's claim, as the registry record of record.
    await registry.claim(
      {
        fileId: 'file-1', sessionId: 'sess_1', ownerInstance: 'engine-1',
        ownerEndpoint: svc!.url, leaseExpiry: Date.now() + 2000, ownershipEpoch: 1,
        currentRevision: 0, storedRevision: 0, updatedAt: Date.now(),
        creatorPrincipal: 'user:alice',
      },
      null,
    );
    // Let the owner adopt epoch 1 via its heartbeat.
    await until(async () => {
      const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: bearer(alice) });
      return (st.json as { ownershipEpoch: unknown }).ownershipEpoch === 1;
    });
    // Takeover: another instance claims with epoch 2.
    const won = await registry.claim(
      {
        fileId: 'file-1', sessionId: 'sess_takeover', ownerInstance: 'engine-2',
        ownerEndpoint: 'http://127.0.0.1:9999', leaseExpiry: Date.now() + 2000, ownershipEpoch: 2,
        currentRevision: 0, storedRevision: 0, updatedAt: Date.now(),
        creatorPrincipal: 'user:alice',
      },
      1,
    );
    expect(won).toBe(true);
    await until(async () => {
      const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: bearer(alice) });
      return (st.json as { fenced: boolean }).fenced === true;
    });
    const op = await ops(alice, {
      clientId: 'a', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: A1, value: 1 },
    });
    expect(op.status).toBe(409);
    expect(op.json).toMatchObject({ error: 'fenced' });
    const deltas = await httpJson('GET', `${svc!.url}/deltas`, { headers: bearer(alice) });
    expect(deltas.status).toBe(409);
    expect(deltas.json).toMatchObject({ error: 'fenced' });
  });

  it('legacy token (no fid) is refused on /ops and /deltas but works on session routes', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const legacy = tokenFor('user:alice', 'sess_1', 'file-1', 'editor', false);
    const op = await ops(legacy, {
      clientId: 'a', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: A1, value: 1 },
    });
    expect(op.status).toBe(403);
    const deltas = await httpJson('GET', `${svc!.url}/deltas`, { headers: bearer(legacy) });
    expect(deltas.status).toBe(403);
    const rd = await httpJson('POST', `${svc!.url}/read`, {
      headers: bearer(legacy),
      body: { kind: 'cell', ref: A1 },
    });
    expect(rd.status).toBe(200);
    expect(alice).toBeTruthy();
  });

  it('sequencer FIFO: concurrent ops from many clients serialize into a gapless revision order', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const clients = ['user:alice', 'user:bob', 'user:carol', 'user:dave', 'user:erin'].map((p, i) => ({
      token: p === 'user:alice' ? alice : tokenFor(p, 'sess_1', 'file-1'),
      clientId: `c${i}`,
    }));
    const results = await Promise.all(
      clients.map((c, i) =>
        ops(c.token, {
          clientId: c.clientId, clientSeq: 1, baseRev: 0,
          cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: i, col: 0 }, value: i },
        }),
      ),
    );
    const revisions = results.map((r) => (r.json as { revision: number }).revision).sort((a, b) => a - b);
    expect(revisions).toEqual([1, 2, 3, 4, 5]);
    for (const r of results) expect((r.json as { ok: boolean }).ok).toBe(true);
  });

  it('/session/claim after release rehydrates the checkpointed session for the same file', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const r1 = await ops(alice, {
      clientId: 'a', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: A1, value: 21 },
    });
    expect(r1.json).toMatchObject({ ok: true, revision: 1 });
    const rel = await httpJson('POST', `${svc!.url}/session/release`, {
      headers: bearer(alice),
      body: { sessionId: 'sess_1', reason: 'test' },
    });
    expect(rel.status).toBe(200);
    // A fresh claim for the same file rehydrates (snapshot + journal
    // + checksum), it does NOT create a blank competing copy.
    const claim2 = await httpJson('POST', `${svc!.url}/session/claim`, {
      headers: bearer(alice),
      body: { fileId: 'file-1', sessionId: 'sess_1' },
    });
    expect(claim2.status).toBe(200);
    expect(claim2.json).toMatchObject({ ok: true, sessionId: 'sess_1', rehydrated: true, revision: 1 });
    const rd = await httpJson('POST', `${svc!.url}/read`, {
      headers: bearer(alice),
      body: { kind: 'cell', ref: A1 },
    });
    expect((rd.json as { value: unknown }).value).toEqual({ kind: 'number', value: 21 });
  });

});

// ---------------------------------------------------------------------------
describe('phase 2 — retention rule (§1, pure)', () => {
  it('all three conditions must hold; the bound is the minimum of them', () => {
    // (a) stored, (b) slowest attached client, (c) checkpoint.
    expect(retentionPruneUpto({ storedRevision: 10, minAppliedRev: 8, checkpointRevision: 9 })).toBe(8);
    expect(retentionPruneUpto({ storedRevision: 5, minAppliedRev: 8, checkpointRevision: 9 })).toBe(5);
    expect(retentionPruneUpto({ storedRevision: 10, minAppliedRev: 8, checkpointRevision: 6 })).toBe(6);
    // No checkpoint → nothing prunes, however far storage/clients are.
    expect(retentionPruneUpto({ storedRevision: 10, minAppliedRev: 10, checkpointRevision: null })).toBe(0);
    // No attached clients: the applied bound is vacuous (Infinity).
    expect(
      retentionPruneUpto({ storedRevision: 7, minAppliedRev: Number.POSITIVE_INFINITY, checkpointRevision: 7 }),
    ).toBe(7);
    expect(segmentPrunable(8, { storedRevision: 10, minAppliedRev: 8, checkpointRevision: 9 })).toBe(true);
    expect(segmentPrunable(9, { storedRevision: 10, minAppliedRev: 8, checkpointRevision: 9 })).toBe(false);
    expect(segmentPrunable(5, { storedRevision: 4, minAppliedRev: 8, checkpointRevision: 9 })).toBe(false);
    expect(segmentPrunable(5, { storedRevision: 10, minAppliedRev: 8, checkpointRevision: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('phase 2 — gateway join handshake (§9)', () => {
  let engine: Started | null = null;
  let gw: Started | null = null;
  let registry: MemoryFileRegistry;

  afterEach(async () => {
    if (gw) await stop(gw);
    if (engine) await stop(engine);
    gw = null;
    engine = null;
  });

  async function setup(fileRegistry?: FileRegistry) {
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
        fileRegistry: fileRegistry ?? registry,
        engineInstances: { 'engine-1': engine.url },
        engineInstanceId: 'engine-1',
      }),
    );
    return { engine, gw };
  }

  async function login(userId: string): Promise<string> {
    const r = await httpJson('POST', `${gw!.url}/auth/login`, { body: { userId } });
    expect(r.status).toBe(200);
    return (r.json as { token: string }).token;
  }

  async function open(jwt: string, body: unknown) {
    return httpJson('POST', `${gw!.url}/api/engine/open`, { headers: bearer(jwt), body });
  }

  it('two users open the same file → same sessionId; ops from both sequence; viewer cannot submit ops', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');

    const openA = await open(aliceJwt, { name: 'book.xlsx' });
    expect(openA.status).toBe(200);
    const a = openA.json as {
      fileId: string; sessionId: string; engineUrl: string; accessToken: string;
      role: string; joined: boolean; ownershipEpoch: number; revision: number;
    };
    expect(a.fileId.startsWith('file-')).toBe(true);
    expect(a.joined).toBe(false);
    expect(a.role).toBe('editor');
    expect(a.ownershipEpoch).toBe(1);
    expect(a.engineUrl).toBe(engine!.url);

    // Alice fills the pending session via /load with her access token.
    const load = await httpJson('POST', `${engine!.url}/load`, {
      headers: bearer(a.accessToken),
      body: { format: 'xlsx', data: tinyXlsxBase64(), sessionId: a.sessionId },
    });
    expect(load.status).toBe(200);

    // Issue #51 (design doc section 4): joining requires a grant —
    // alice (the owner) records bob as editor and carol as viewer
    // through the owner-only share endpoint before either opens.
    const grantBob = await httpJson('POST', `${gw!.url}/api/engine/share`, {
      headers: bearer(aliceJwt),
      body: { fileId: a.fileId, principal: 'user:bob', role: 'editor' },
    });
    expect(grantBob.status).toBe(200);
    const grantCarol = await httpJson('POST', `${gw!.url}/api/engine/share`, {
      headers: bearer(aliceJwt),
      body: { fileId: a.fileId, principal: 'user:carol', role: 'viewer' },
    });
    expect(grantCarol.status).toBe(200);

    // Bob opens the SAME fileId → JOIN, identical response shape.
    const openB = await open(bobJwt, { fileId: a.fileId });
    expect(openB.status).toBe(200);
    const b = openB.json as typeof a;
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.joined).toBe(true);
    expect(b.fileId).toBe(a.fileId);
    expect(b.engineUrl).toBe(a.engineUrl);
    expect(b.ownershipEpoch).toBe(1);

    // Registry evidence: one record, owner engine-1.
    const rec = await registry.lookup(a.fileId);
    expect(rec?.sessionId).toBe(a.sessionId);
    expect(rec?.ownerInstance).toBe('engine-1');
    expect(rec?.creatorPrincipal).toBe('user:alice');

    // Ops from both principals sequence on the one session.
    const opA = await httpJson('POST', `${engine!.url}/ops`, {
      headers: bearer(a.accessToken),
      body: { clientId: 'alice-c', clientSeq: 1, baseRev: 0, cmd: { cmd: 'setCell', ref: A1, value: 5 } },
    });
    expect(opA.json).toMatchObject({ ok: true, revision: 1 });
    const opB = await httpJson('POST', `${engine!.url}/ops`, {
      headers: bearer(b.accessToken),
      body: { clientId: 'bob-c', clientSeq: 1, baseRev: 1, cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 6 } },
    });
    expect(opB.json).toMatchObject({ ok: true, revision: 2 });

    // A viewer joins but cannot submit ops.
    const carolJwt = await login('carol');
    const openC = await open(carolJwt, { fileId: a.fileId, role: 'viewer' });
    const c = openC.json as typeof a;
    expect(c.role).toBe('viewer');
    expect(c.sessionId).toBe(a.sessionId);
    const opC = await httpJson('POST', `${engine!.url}/ops`, {
      headers: bearer(c.accessToken),
      body: { clientId: 'carol-c', clientSeq: 1, baseRev: 2, cmd: { cmd: 'setCell', ref: A1, value: 0 } },
    });
    expect(opC.status).toBe(403);
    expect(opC.json).toMatchObject({ ok: false, rejected: true, reason: 'viewer-role' });
    // ...but the viewer CAN read and subscribe.
    const rd = await httpJson('POST', `${engine!.url}/read`, {
      headers: bearer(c.accessToken),
      body: { kind: 'cell', ref: A1 },
    });
    expect((rd.json as { value: unknown }).value).toEqual({ kind: 'number', value: 5 });
  });

  it('registry failure at open → 503 fail-closed, no session created', async () => {
    const throwing: FileRegistry = {
      lookup: async () => {
        throw new Error('db unreachable');
      },
      listAll: async () => {
        throw new Error('db unreachable');
      },
      claim: async () => {
        throw new Error('db unreachable');
      },
      heartbeat: async () => false,
      release: async () => false,
      noteParticipant: async () => false,
    };
    await setup(throwing);
    const aliceJwt = await login('alice');
    const r = await open(aliceJwt, { name: 'book.xlsx' });
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ error: 'session registry unavailable' });
    // The engine never got a session: its status shows none.
    const probe = tokenFor('user:alice', 'sess_probe', 'file-probe');
    const st = await httpJson('GET', `${engine!.url}/session/status`, { headers: bearer(probe) });
    expect(st.status).toBe(200);
    expect((st.json as { sessionId: unknown }).sessionId).toBeNull();
    expect((st.json as { fileId: unknown }).fileId).toBeNull();
  });
});
