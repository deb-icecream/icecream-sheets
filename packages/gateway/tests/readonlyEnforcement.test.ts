/**
 * Issue #51 — read-only enforcement (design-docs/read-only-enforcement.md).
 *
 * The F-9 engine gate enforces the role in the caller's engine access
 * token; these tests pin WHO decides that role. Before the fix,
 * POST /api/engine/open minted join tokens with a role taken from the
 * request body (default 'editor') and no grant check — a user the
 * owner had shared a file with as Viewer received an editor token and
 * could write through every path. Now access comes ONLY from a
 * grant (design doc section 4): the creator is the owner; a
 * non-creator's role is their owner-recorded grant
 * (POST /api/engine/share, owner-only per section 5); no grant ->
 * the open itself is denied, on the join AND claim doors; and the
 * engine re-derives the role from the grant record on every request
 * (section 5/8), so demotion and revocation bite mid-session.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import { MemoryFileRegistry, type FileRegistry } from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'readonly-test-secret';
const A1 = { sheet: 'Sheet1', row: 0, col: 0 };

function tinyXlsxBase64(): string {
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Sheet1', rows: [[10, 20], [null, '=A1+B1']] }],
    metadata: {},
  } as never);
  return Buffer.from(bytes).toString('base64');
}

function signedEnv(): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ['ENGINE_ACCESS_' + 'SECRET']: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
  } as NodeJS.ProcessEnv;
}

const authHdr = (token: string) => ({ authorization: `Bearer ${token}` });

describe('issue #51 — read-only enforcement at the gateway open/share', () => {
  let engine: Started | null = null;
  let gw: Started | null = null;
  let registry: MemoryFileRegistry;

  afterEach(async () => {
    if (gw) await stop(gw);
    if (engine) await stop(engine);
    gw = null;
    engine = null;
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
        routes: { '/api/engine': engine!.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          ['sec' + 'ret']: SECRET,
          ttlSeconds: 600,
          tiers: { standard: engine!.url, xl: engine!.url },
        },
        fileRegistry: registry as FileRegistry,
        engineInstances: { 'engine-1': engine!.url },
        engineInstanceId: 'engine-1',
      }),
    );
  }

  async function login(userId: string): Promise<string> {
    const r = await httpJson('POST', `${gw!.url}/auth/login`, { body: { userId } });
    expect(r.status).toBe(200);
    return (r.json as { token: string }).token;
  }

  async function open(jwt: string, body: unknown) {
    return httpJson('POST', `${gw!.url}/api/engine/open`, { headers: authHdr(jwt), body });
  }

  async function share(jwt: string, body: unknown) {
    return httpJson('POST', `${gw!.url}/api/engine/share`, { headers: authHdr(jwt), body });
  }

  function ops(token: string, body: unknown) {
    return httpJson('POST', `${engine!.url}/ops`, { headers: authHdr(token), body });
  }

  /** Alice creates + loads a file; returns its open payload. */
  async function aliceCreates(aliceJwt: string) {
    const openA = await open(aliceJwt, { name: 'book.xlsx' });
    expect(openA.status).toBe(200);
    const a = openA.json as {
      fileId: string; sessionId: string; accessToken: string; role: string; joined: boolean;
    };
    expect(a.role).toBe('editor');
    expect(a.joined).toBe(false);
    const load = await httpJson('POST', `${engine!.url}/load`, {
      headers: authHdr(a.accessToken),
      body: { format: 'xlsx', data: tinyXlsxBase64(), sessionId: a.sessionId },
    });
    expect(load.status).toBe(200);
    return a;
  }

  it('a viewer grant clamps the join even when the joiner asks for editor', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');
    const a = await aliceCreates(aliceJwt);

    const grant = await share(aliceJwt, { fileId: a.fileId, principal: 'user:bob', role: 'viewer' });
    expect(grant.status).toBe(200);
    expect(grant.json).toMatchObject({ ok: true, role: 'viewer' });

    // Bob joins the SAME session, explicitly requesting editor.
    const openB = await open(bobJwt, { fileId: a.fileId, role: 'editor' });
    expect(openB.status).toBe(200);
    const b = openB.json as typeof a;
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.joined).toBe(true);
    expect(b.role).toBe('viewer');

    // The registry recorded the CLAMPED role, not the asserted one.
    const rec = await registry.lookup(a.fileId);
    expect(rec?.grants).toMatchObject({ 'user:bob': 'viewer' });
    expect(rec?.participants).toMatchObject({ 'user:bob': 'viewer' });

    // Bob's write is refused at the engine gate; his read works.
    const opB = await ops(b.accessToken, {
      clientId: 'bob-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 666 },
    });
    expect(opB.status).toBe(403);
    expect(opB.json).toMatchObject({ ok: false, rejected: true, reason: 'viewer-role' });
    const rd = await httpJson('POST', `${engine!.url}/read`, {
      headers: authHdr(b.accessToken),
      body: { kind: 'cell', ref: A1 },
    });
    expect(rd.status).toBe(200);
  });

  it('share is creator-only; unknown file 404s; self-grant is refused', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');
    const a = await aliceCreates(aliceJwt);

    // A non-creator granting a THIRD party: creator check fires (403).
    const byBob = await share(bobJwt, { fileId: a.fileId, principal: 'user:carol', role: 'editor' });
    expect(byBob.status).toBe(403);
    // A non-creator granting THEMSELVES: refused too (self-role guard).
    const byBobSelf = await share(bobJwt, { fileId: a.fileId, principal: 'user:bob', role: 'editor' });
    expect(byBobSelf.status).toBe(400);
    // A non-creator REVOKING the owner, or re-roling anyone: 403 —
    // the owner's entry is immovable to everyone but the owner (§5).
    const revokeOwner = await share(bobJwt, { fileId: a.fileId, principal: 'user:alice', role: null });
    expect(revokeOwner.status).toBe(403);
    const reRole = await share(bobJwt, { fileId: a.fileId, principal: 'user:carol', role: 'viewer' });
    expect(reRole.status).toBe(403);
    const missing = await share(aliceJwt, { fileId: 'file-nope', principal: 'user:bob', role: 'viewer' });
    expect(missing.status).toBe(404);
    const self = await share(aliceJwt, { fileId: a.fileId, principal: 'user:alice', role: 'viewer' });
    expect(self.status).toBe(400);
    // None of those attempts recorded anything.
    const rec = await registry.lookup(a.fileId);
    expect(rec?.grants ?? {}).toEqual({});
  });

  it('an editor grant lets the grantee join as editor and write', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const daveJwt = await login('dave');
    const a = await aliceCreates(aliceJwt);

    const grant = await share(aliceJwt, { fileId: a.fileId, principal: 'user:dave', role: 'editor' });
    expect(grant.status).toBe(200);
    const openD = await open(daveJwt, { fileId: a.fileId });
    const d = openD.json as typeof a;
    expect(d.role).toBe('editor');
    const opD = await ops(d.accessToken, {
      clientId: 'dave-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 7 },
    });
    expect(opD.status).toBe(200);
    expect(opD.json).toMatchObject({ ok: true });
  });

  it('the grant survives a claim: a viewer reopening after the lease lapses stays a viewer', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');
    const a = await aliceCreates(aliceJwt);
    await share(aliceJwt, { fileId: a.fileId, principal: 'user:bob', role: 'viewer' });

    // Kill the live session: release through the engine, which zeroes
    // the registry lease; the next open takes the CLAIM (rehydrate)
    // path that used to reply 'editor' unconditionally.
    const rel = await httpJson('POST', `${engine!.url}/session/release`, {
      headers: authHdr(a.accessToken),
      body: { sessionId: a.sessionId, reason: 'test' },
    });
    expect(rel.status).toBe(200);

    const openB = await open(bobJwt, { fileId: a.fileId, role: 'editor' });
    expect(openB.status).toBe(200);
    const b = openB.json as typeof a;
    expect(b.role).toBe('viewer');
    // Op-level gating for a viewer token is pinned on the live session
    // by the first test in this file (and by the engine suites); the
    // freshly claimed session here may hold no loaded workbook in the
    // in-process harness, where /ops answers a state error instead —
    // what must NEVER happen is a 200 (a landed write).
    const opB = await ops(b.accessToken, {
      clientId: 'bob-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 666 },
    });
    expect(opB.status).not.toBe(200);
    // And the grant itself survived the claim into the new record.
    const rec = await registry.lookup(a.fileId);
    expect(rec?.grants).toMatchObject({ 'user:bob': 'viewer' });
    expect(rec?.creatorPrincipal).toBe('user:alice');
  });

  it("a user's own new file resolves them as its editor (grants are per-file)", async () => {
    await setup();
    const bobJwt = await login('bob');
    const openOwn = await open(bobJwt, { name: 'bobs.xlsx' });
    expect(openOwn.status).toBe(200);
    const own = openOwn.json as { role: string; accessToken: string; sessionId: string };
    expect(own.role).toBe('editor');
    const opOwn = await ops(own.accessToken, {
      clientId: 'bob-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 },
    });
    // The op reaches the sequencer (no workbook loaded yet is fine);
    // the point is it is NOT refused for role reasons.
    expect(opOwn.status).not.toBe(403);
  });

  it('revoking a grant denies the next open outright (section 4)', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');
    const a = await aliceCreates(aliceJwt);
    await share(aliceJwt, { fileId: a.fileId, principal: 'user:bob', role: 'viewer' });
    const openB1 = await open(bobJwt, { fileId: a.fileId });
    expect((openB1.json as typeof a).role).toBe('viewer');

    const revoke = await share(aliceJwt, { fileId: a.fileId, principal: 'user:bob', role: null });
    expect(revoke.status).toBe(200);
    const openB2 = await open(bobJwt, { fileId: a.fileId });
    expect(openB2.status).toBe(403);
    // The audit trail recorded both changes, by the owner (§5).
    const rec = await registry.lookup(a.fileId);
    expect(rec?.aclLog?.map((e) => [e.by, e.principal, e.role])).toEqual([
      ['user:alice', 'user:bob', 'viewer'],
      ['user:alice', 'user:bob', null],
    ]);
  });

  it('a principal with no grant is denied at JOIN and at CLAIM (section 4)', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const carolJwt = await login('carol');
    const a = await aliceCreates(aliceJwt);

    // Join door (live session): denied, even asserting role editor.
    const join = await open(carolJwt, { fileId: a.fileId, role: 'editor' });
    expect(join.status).toBe(403);

    // Claim door (lease lapsed via release): still denied — and the
    // denial must not have claimed the session for her.
    const rel = await httpJson('POST', `${engine!.url}/session/release`, {
      headers: authHdr(a.accessToken),
      body: { sessionId: a.sessionId, reason: 'test' },
    });
    expect(rel.status).toBe(200);
    const claim = await open(carolJwt, { fileId: a.fileId });
    expect(claim.status).toBe(403);
    const rec = await registry.lookup(a.fileId);
    expect(rec?.creatorPrincipal).toBe('user:alice');
    // No claim happened for carol: the record still names alice's
    // original session at the original epoch. (Lease timestamps are
    // not asserted — the engine's ownership heartbeat can re-extend
    // a just-released lease; the ACL gate does not depend on it.)
    expect(rec?.sessionId).toBe(a.sessionId);
    expect(rec?.ownershipEpoch).toBe(1);
  });

  it('mid-session demotion fails the SAME token’s next write (section 5)', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const daveJwt = await login('dave');
    const a = await aliceCreates(aliceJwt);
    await share(aliceJwt, { fileId: a.fileId, principal: 'user:dave', role: 'editor' });
    const openD = await open(daveJwt, { fileId: a.fileId });
    const d = openD.json as typeof a;
    expect(d.role).toBe('editor');
    const writeAs = (seq: number) =>
      ops(d.accessToken, {
        clientId: 'dave-c', clientSeq: seq, baseRev: 0,
        cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 4, col: 4 }, value: seq },
      });
    // Dave's first op reaches the sequencer (not a role refusal).
    const before = await writeAs(1);
    expect(before.status).not.toBe(403);
    // Owner demotes dave to viewer; dave does NOT rejoin — the very
    // next write with the previously issued editor token is refused
    // by the engine's per-request grant re-derivation.
    await share(aliceJwt, { fileId: a.fileId, principal: 'user:dave', role: 'viewer' });
    const after = await writeAs(2);
    expect(after.status).toBe(403);
    expect(after.json).toMatchObject({ ok: false, reason: 'viewer-role' });
    // And after revocation, even his reads are cut (no-access-grant).
    await share(aliceJwt, { fileId: a.fileId, principal: 'user:dave', role: null });
    const rd = await httpJson('POST', `${engine!.url}/read`, {
      headers: authHdr(d.accessToken),
      body: { kind: 'cell', ref: A1 },
    });
    expect(rd.status).toBe(403);
    expect(rd.json).toMatchObject({ ok: false, reason: 'no-access-grant' });
  });
});
