/**
 * #104: the ENGINE verifies authorization on EVERY direct read/write
 * call against the token's scope — signature, expiry, session match,
 * file match, role-permits-action. Token possession alone is never
 * authorization; the gateway's open-time check is not a substitute.
 *
 * Pins, per endpoint class:
 *  - a token for file B cannot read or write file A's session (401);
 *  - a revoked principal (valid token, no grant) is refused (403);
 *  - an expired token is refused (401);
 *  - a forged/tampered token is refused (401);
 *  - a viewer token's write is refused (403, class pinned; the full
 *    per-route suite lives in viewerRoleGates.test.ts);
 *  - an editor token's legitimate read/write still succeeds;
 *  - legacy (no-fid) tokens keep working on the read/load path the
 *    live web client runs on, but are newly refused on /session/claim;
 *  - a registry read failure fails closed (403), not open.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createEngineListener } from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import {
  MemoryFileRegistry,
  type FileRegistryRecord,
} from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'engine-auth-104-test-secret';
const FILE_A = 'file-auth-a';
const FILE_B = 'file-auth-b';
const SID = 'sess-auth-a';
const ALICE = 'user:alice';
const CAROL = 'user:carol';
const DAVE = 'user:dave';

function tinyXlsxBase64(marker = 10): string {
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Sheet1', rows: [[marker, 20], [null, '=A1+B1']] }],
    metadata: {},
  } as never);
  return Buffer.from(bytes).toString('base64');
}

function tokenFor(
  principal: string,
  sid: string,
  fid?: string,
  role?: 'editor' | 'viewer',
  ttlSeconds?: number,
): string {
  return issueEngineAccessToken({
    secret: SECRET,
    principal,
    sessionId: sid,
    tier: 'standard',
    ...(fid !== undefined ? { fid } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  }).token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function signedEnv(): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ENGINE_ACCESS_SECRET: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
  } as NodeJS.ProcessEnv;
}

/** File registry that serves one injected record (grants included). */
class GrantRegistry extends MemoryFileRegistry {
  private injected = new Map<string, FileRegistryRecord>();
  inject(rec: FileRegistryRecord): void {
    this.injected.set(rec.fileId, rec);
  }
  override async lookup(fileId: string): Promise<FileRegistryRecord | null> {
    const inj = this.injected.get(fileId);
    if (inj) return { ...inj };
    return super.lookup(fileId);
  }
}

/** File registry whose lookups throw once armed (registry-outage simulation). */
class FlakyRegistry extends MemoryFileRegistry {
  fail = false;
  override async lookup(fileId: string): Promise<FileRegistryRecord | null> {
    if (this.fail) throw new Error('registry down');
    return super.lookup(fileId);
  }
}

function recordFor(
  fileId: string,
  sessionId: string,
  grants?: Record<string, 'editor' | 'viewer'>,
): FileRegistryRecord {
  return {
    fileId,
    sessionId,
    ownerInstance: 'engine-test',
    ownerEndpoint: 'http://engine-test',
    leaseExpiry: Date.now() + 60_000,
    ownershipEpoch: 1,
    currentRevision: 0,
    storedRevision: 0,
    updatedAt: Date.now(),
    creatorPrincipal: ALICE,
    ...(grants ? { grants } : {}),
  };
}

describe('#104: engine-side per-call authorization', () => {
  let svc: Started | null = null;
  let svc2: Started | null = null;

  afterEach(async () => {
    if (svc2) await stop(svc2);
    if (svc) await stop(svc);
    svc = null;
    svc2 = null;
  });

  /** Claim + load file A / session SID as alice (editor, file-scoped). */
  async function setupLoaded(
    registry?: MemoryFileRegistry,
    stores?: MemorySessionStores,
  ): Promise<{ editor: string; viewer: string }> {
    svc = await startServer(
      createEngineListener({
        sessionStores: stores ?? new MemorySessionStores(),
        fileRegistry: registry ?? new MemoryFileRegistry(),
        deployEnv: signedEnv(),
      }),
    );
    const editor = tokenFor(ALICE, SID, FILE_A, 'editor');
    const viewer = tokenFor(CAROL, SID, FILE_A, 'viewer');
    const claim = await httpJson('POST', `${svc.url}/session/claim`, {
      headers: bearer(editor),
      body: { fileId: FILE_A, sessionId: SID },
    });
    expect(claim.status).toBe(200);
    const load = await httpJson('POST', `${svc.url}/load`, {
      headers: bearer(editor),
      body: { format: 'xlsx', data: tinyXlsxBase64(), sessionId: SID },
    });
    expect(load.status).toBe(200);
    return { editor, viewer };
  }

  function post(token: string, path: string, body: unknown, base?: Started) {
    return httpJson('POST', `${(base ?? svc!).url}${path}`, { headers: bearer(token), body });
  }
  function get(token: string, path: string, base?: Started) {
    return httpJson('GET', `${(base ?? svc!).url}${path}`, { headers: bearer(token) });
  }

  it('a token for file B cannot read or write file A’s session', async () => {
    const { editor } = await setupLoaded();
    const cross = tokenFor(ALICE, SID, FILE_B, 'editor');
    const readPaths: Array<['GET' | 'POST', string, unknown?]> = [
      ['POST', '/read', { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } }],
      ['GET', '/snapshot'],
      ['GET', '/sheets'],
      ['GET', '/events?since=0'],
      ['GET', '/session-save-status'],
      ['GET', '/download'],
      ['GET', '/revisions?from=0&to=0'],
      ['POST', '/presence', { sheet: 'Sheet1', row: 0, col: 0 }],
      ['POST', '/deltas/ack', { revision: 0 }],
      ['POST', '/execute', { cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 9, col: 9 }, value: 1 } }],
      ['POST', '/ops', { clientId: 'c1', clientSeq: 0, baseRev: 0, cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 9, col: 9 }, value: 1 } }],
      ['POST', '/library-save', {}],
      ['POST', '/charts', { spec: {} }],
      ['POST', '/language', { locale: 'de-DE' }],
      ['POST', '/reset', {}],
      ['GET', '/deltas'],
    ];
    for (const [method, path, body] of readPaths) {
      const res =
        method === 'GET' ? await get(cross, path) : await post(cross, path, body);
      expect(res.status, `cross-file ${method} ${path}`).toBe(401);
    }
    // Controls: the matching token still reads and writes.
    const rd = await post(editor, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(rd.status).toBe(200);
    expect((rd.json as { value: { value: unknown } }).value.value).toBe(10);
    const ex = await post(editor, '/execute', {
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 9, col: 9 }, value: 7 },
    });
    expect(ex.status).toBe(200);
  });

  it('a viewer token’s write is refused, but its reads succeed', async () => {
    const { viewer } = await setupLoaded();
    const w = await post(viewer, '/ops', {
      clientId: 'c1',
      clientSeq: 0,
      baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 999 },
    });
    expect(w.status).toBe(403);
    expect(w.json).toMatchObject({ ok: false, rejected: true, reason: 'viewer-role' });
    const rd = await post(viewer, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(rd.status).toBe(200);
    expect((rd.json as { value: { value: unknown } }).value.value).toBe(10);
  });

  it('a revoked principal (valid token, no grant) is refused on reads', async () => {
    const registry = new GrantRegistry();
    const { editor } = await setupLoaded(registry);
    registry.inject(recordFor(FILE_A, SID, { [CAROL]: 'viewer' }));
    const revoked = tokenFor(DAVE, SID, FILE_A, 'editor');
    const paths: Array<['GET' | 'POST', string, unknown?]> = [
      ['POST', '/read', { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } }],
      ['GET', '/snapshot'],
      ['GET', '/sheets'],
      ['GET', '/events?since=0'],
      ['GET', '/session-save-status'],
      ['GET', '/revisions?from=0&to=0'],
      ['POST', '/presence', { sheet: 'Sheet1', row: 0, col: 0 }],
      ['POST', '/deltas/ack', { revision: 0 }],
      ['GET', '/download'],
      ['GET', '/deltas'],
    ];
    for (const [method, path, body] of paths) {
      const res = method === 'GET' ? await get(revoked, path) : await post(revoked, path, body);
      expect(res.status, `revoked ${method} ${path}`).toBe(403);
      expect(res.json, `revoked ${method} ${path}`).toMatchObject({
        ok: false,
        rejected: true,
        reason: 'no-access-grant',
      });
    }
    // Controls: creator reads, viewer grant reads.
    const carol = tokenFor(CAROL, SID, FILE_A, 'viewer');
    expect((await get(carol, '/sheets')).status).toBe(200);
    expect((await get(editor, '/sheets')).status).toBe(200);
  });

  it('expired and forged tokens are refused', async () => {
    await setupLoaded();
    const expired = tokenFor(ALICE, SID, FILE_A, 'editor', -60);
    const rdExpired = await post(expired, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(rdExpired.status).toBe(401);
    const good = tokenFor(ALICE, SID, FILE_A, 'editor');
    const [payload, sig] = good.split('.');
    const flippedSig = sig!.slice(0, -1) + (sig!.slice(-1) === 'a' ? 'b' : 'a');
    const forgedSig = await post(`${payload}.${flippedSig}`, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(forgedSig.status).toBe(401);
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')), fid: FILE_B }),
    ).toString('base64url');
    const forgedPayload = await post(`${tamperedPayload}.${sig}`, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(forgedPayload.status).toBe(401);
  });

  it('legacy (no-fid) tokens keep working on the read/load path, but not on claim or ops', async () => {
    await setupLoaded();
    const legacy = tokenFor(ALICE, SID);
    for (const path of ['/snapshot', '/sheets', '/events?since=0', '/session-save-status', '/download']) {
      expect((await get(legacy, path)).status, `legacy GET ${path}`).toBe(200);
    }
    const rd = await post(legacy, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(rd.status).toBe(200);
    const ops = await post(legacy, '/ops', {
      clientId: 'c1',
      clientSeq: 0,
      baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 },
    });
    expect(ops.status).toBe(403);
    // Fresh engine: a legacy token must not claim an arbitrary file.
    svc2 = await startServer(
      createEngineListener({
        sessionStores: new MemorySessionStores(),
        fileRegistry: new MemoryFileRegistry(),
        deployEnv: signedEnv(),
      }),
    );
    const legacyClaim = await httpJson('POST', `${svc2.url}/session/claim`, {
      headers: bearer(tokenFor(ALICE, 'sess-legacy-claim')),
      body: { fileId: 'file-legacy', sessionId: 'sess-legacy-claim' },
    });
    expect(legacyClaim.status).toBe(403);
    const scopedClaim = await httpJson('POST', `${svc2.url}/session/claim`, {
      headers: bearer(tokenFor(ALICE, 'sess-legacy-claim', 'file-legacy', 'editor')),
      body: { fileId: 'file-legacy', sessionId: 'sess-legacy-claim' },
    });
    expect(scopedClaim.status).toBe(200);
  });

  it('the anonymous legacy flow (reset + load) still works', async () => {
    svc = await startServer(
      createEngineListener({
        sessionStores: new MemorySessionStores(),
        fileRegistry: new MemoryFileRegistry(),
        deployEnv: signedEnv(),
      }),
    );
    const legacy = tokenFor(ALICE, 'sess-anon');
    const reset = await post(legacy, '/reset', {}, svc);
    expect(reset.status).toBe(200);
    expect((reset.json as { sessionId: string }).sessionId).toBe('sess-anon');
    const load = await post(
      legacy,
      '/load',
      { format: 'xlsx', data: tinyXlsxBase64(42), sessionId: 'sess-anon' },
      svc,
    );
    expect(load.status).toBe(200);
  });

  it('a file-scoped token may only load into the session claimed for its file', async () => {
    svc = await startServer(
      createEngineListener({
        sessionStores: new MemorySessionStores(),
        fileRegistry: new MemoryFileRegistry(),
        deployEnv: signedEnv(),
      }),
    );
    const sid2 = 'sess-pending';
    const claimTok = tokenFor(ALICE, sid2, FILE_A, 'editor');
    const claim = await httpJson('POST', `${svc.url}/session/claim`, {
      headers: bearer(claimTok),
      body: { fileId: FILE_A, sessionId: sid2 },
    });
    expect(claim.status).toBe(200);
    const wrong = await post(tokenFor(ALICE, sid2, FILE_B, 'editor'), '/load', {
      format: 'xlsx',
      data: tinyXlsxBase64(),
      sessionId: sid2,
    });
    expect(wrong.status).toBe(401);
    const wrongStream = await post(tokenFor(ALICE, sid2, FILE_B, 'editor'), '/load/stream', {
      format: 'xlsx',
      data: tinyXlsxBase64(),
      sessionId: sid2,
    });
    expect(wrongStream.status).toBe(401);
    const right = await post(claimTok, '/load', {
      format: 'xlsx',
      data: tinyXlsxBase64(),
      sessionId: sid2,
    });
    expect(right.status).toBe(200);
  });

  it('rehydrate refuses a token for another file, on live and fresh-process sessions', async () => {
    const { editor } = await setupLoaded();
    const wrong = await post(tokenFor(ALICE, SID, FILE_B, 'editor'), '/session/rehydrate', {
      sessionId: SID,
    });
    expect(wrong.status).toBe(401);
    const right = await post(editor, '/session/rehydrate', { sessionId: SID });
    expect(right.status).toBe(200);
    expect((right.json as { alreadyActive?: boolean }).alreadyActive).toBe(true);
    // Legacy tokens pass the auth gate on the live session too.
    const legacyLive = await post(tokenFor(ALICE, SID), '/session/rehydrate', { sessionId: SID });
    expect(legacyLive.status).toBe(200);
    expect((legacyLive.json as { alreadyActive?: boolean }).alreadyActive).toBe(true);

    // Fresh process, shared stores: the session record exists but this
    // process holds no file — the file-registry check is the only gate.
    const stores = new MemorySessionStores();
    const registry = new GrantRegistry();
    registry.inject(recordFor(FILE_B, 'sess-other'));
    svc2 = await startServer(
      createEngineListener({ sessionStores: stores, fileRegistry: registry, deployEnv: signedEnv() }),
    );
    // Engine 1 (shared stores) claims + loads file A / SID so a session
    // record for SID exists; engine 2 stays fresh.
    const svc1 = await startServer(
      createEngineListener({ sessionStores: stores, fileRegistry: registry, deployEnv: signedEnv() }),
    );
    try {
      const tok1 = tokenFor(ALICE, SID, FILE_A, 'editor');
      expect(
        (await httpJson('POST', `${svc1.url}/session/claim`, {
          headers: bearer(tok1),
          body: { fileId: FILE_A, sessionId: SID },
        })).status,
      ).toBe(200);
      const freshWrong = await post(tokenFor(ALICE, SID, FILE_B, 'editor'), '/session/rehydrate', {
        sessionId: SID,
      }, svc2);
      expect(freshWrong.status).toBe(401);
      // Legacy tokens pass the auth gate here too: the call reaches
      // rehydrateSession and fails only on mechanics (engine 1 never
      // checkpointed a snapshot, so there is nothing to restore) —
      // the assertion is deliberately "not an auth refusal".
      const freshLegacy = await post(tokenFor(ALICE, SID), '/session/rehydrate', {
        sessionId: SID,
      }, svc2);
      expect(freshLegacy.status).not.toBe(401);
      expect(freshLegacy.status).not.toBe(403);
    } finally {
      await stop(svc1);
    }
  });

  it('a registry read failure fails closed, not open', async () => {
    const registry = new FlakyRegistry();
    const { editor } = await setupLoaded(registry);
    const ok = await post(editor, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(ok.status).toBe(200);
    registry.fail = true;
    const refused = await post(editor, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ ok: false, rejected: true, reason: 'no-access-grant' });
    registry.fail = false;
    const okAgain = await post(editor, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(okAgain.status).toBe(200);
  });
});
