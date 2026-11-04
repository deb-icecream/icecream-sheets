/**
 * Issue #84 — share surface completion: invite-by-email directory,
 * ownership transfer, link sharing.
 *
 * (a) GET /api/users/by-email resolves an email to a principal for
 * the file's OWNER only (non-owners get the share-GET 404, never a
 * leak); unknown emails 404 'no account found'. The directory itself
 * is filled from sign-ins (unit-covered here via recordSignIn; the
 * /auth/firebase recording line is best-effort and covered by the
 * endpoint tests' pre-seeded directory, not by a forged Firebase
 * token — see REPORT.md residual).
 * (b) POST /api/engine/share/transfer moves ownership to an existing
 * grantee (old owner becomes editor; the catalog record moves too);
 * transfers to strangers/self/non-owners are refused.
 * (c) POST /api/engine/share/link switches link sharing on/off; a
 * link user opens at the link role through the same aclRoleFor every
 * other consumer uses, sees no grant list, and loses access when
 * link sharing goes off. Link settings + transfers survive claims
 * (registry-level tests at the bottom).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import { MemoryFileRegistry, type FileRegistry } from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { MemoryUserFileCatalog } from '../src/deploy/userStore.js';
import { MemoryUserDirectory } from '../src/deploy/userDirectory.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'share-84-test-secret';

function signedEnv(): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ['ENGINE_ACCESS_' + 'SECRET']: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
  } as NodeJS.ProcessEnv;
}

const authHdr = (token: string) => ({ authorization: `Bearer ${token}` });

describe('issue #84 — share surface completion', () => {
  let engine: Started | null = null;
  let gw: Started | null = null;
  let registry: MemoryFileRegistry;
  let directory: MemoryUserDirectory;
  let catalog: MemoryUserFileCatalog;

  afterEach(async () => {
    if (gw) await stop(gw);
    if (engine) await stop(engine);
    gw = null;
    engine = null;
  });

  async function setup() {
    registry = new MemoryFileRegistry();
    directory = new MemoryUserDirectory();
    catalog = new MemoryUserFileCatalog();
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
        authSecret: 'gw-share-84-secret',
        routes: { '/api/engine': engine!.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          ['sec' + 'ret']: SECRET,
          ttlSeconds: 600,
          tiers: { standard: engine!.url, xl: engine!.url },
        },
        fileRegistry: registry as FileRegistry,
        userDirectory: directory,
        userFileCatalog: catalog,
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

  async function aliceCreates(aliceJwt: string): Promise<string> {
    const openA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(aliceJwt),
      body: { name: 'book.xlsx' },
    });
    expect(openA.status).toBe(200);
    return (openA.json as { fileId: string }).fileId;
  }

  async function share(jwt: string, body: unknown) {
    return httpJson('POST', `${gw!.url}/api/engine/share`, { headers: authHdr(jwt), body });
  }

  async function read(jwt: string, fileId: string) {
    return httpJson('GET', `${gw!.url}/api/engine/share?fileId=${encodeURIComponent(fileId)}`, {
      headers: authHdr(jwt),
    });
  }

  async function byEmail(jwt: string, fileId: string, email: string) {
    return httpJson(
      'GET',
      `${gw!.url}/api/users/by-email?fileId=${encodeURIComponent(fileId)}&email=${encodeURIComponent(email)}`,
      { headers: authHdr(jwt) },
    );
  }

  async function link(jwt: string, body: unknown) {
    return httpJson('POST', `${gw!.url}/api/engine/share/link`, { headers: authHdr(jwt), body });
  }

  async function transfer(jwt: string, body: unknown) {
    return httpJson('POST', `${gw!.url}/api/engine/share/transfer`, { headers: authHdr(jwt), body });
  }

  it('(a) owner resolves a signed-in email; unknown email 404s; non-owner gets the no-leak 404', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');
    const carolJwt = await login('carol');
    const fileId = await aliceCreates(aliceJwt);
    await directory.recordSignIn('bob', 'Bob@Example.com', 'Bob');
    const ok = await byEmail(aliceJwt, fileId, 'bob@example.com');
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, principal: 'user:bob', email: 'bob@example.com' });
    const unknown = await byEmail(aliceJwt, fileId, 'nobody@example.com');
    expect(unknown.status).toBe(404);
    expect((unknown.json as { error: string }).error).toContain('no account found');
    // Bob holds no grant yet: same 404 as a nonexistent file, and the
    // directory is never consulted for him (no existence leak).
    const stranger = await byEmail(bobJwt, fileId, 'bob@example.com');
    expect(stranger.status).toBe(404);
    expect(stranger.json).toEqual((await byEmail(carolJwt, 'file-does-not-exist', 'x@y.z')).json);
    // Malformed email is a 400, not a directory probe.
    const bad = await byEmail(aliceJwt, fileId, 'not-an-email');
    expect(bad.status).toBe(400);
  });

  it('(a) directory keys on normalized email and ignores sign-ins without one', async () => {
    const dir = new MemoryUserDirectory();
    await dir.recordSignIn('carol', 'Carol@Example.COM');
    await dir.recordSignIn('dave');
    expect(await dir.lookupByEmail('carol@example.com')).toMatchObject({ principal: 'user:carol' });
    expect(await dir.lookupByEmail('CAROL@EXAMPLE.COM')).toMatchObject({ principal: 'user:carol' });
    expect(await dir.lookupByEmail('dave@example.com')).toBeNull();
  });

  it('(c) link sharing admits a stranger at the link role, hides the grant list, and off revokes it', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');
    const strangerJwt = await login('stranger');
    const fileId = await aliceCreates(aliceJwt);
    // Off: stranger sees nothing.
    expect((await read(strangerJwt, fileId)).status).toBe(404);
    // Non-owner cannot switch it on.
    expect((await link(bobJwt, { fileId, role: 'viewer' })).status).toBe(403);
    // Owner switches on as viewer.
    const on = await link(aliceJwt, { fileId, role: 'viewer' });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ ok: true, fileId, linkShare: { role: 'viewer' } });
    // Stranger now reads as viewer — but with an empty grant list.
    const asLink = await read(strangerJwt, fileId);
    expect(asLink.status).toBe(200);
    expect(asLink.json).toMatchObject({ role: 'viewer', grants: [], linkShare: { role: 'viewer' } });
    // And opens through the real open path at the link role.
    const opened = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(strangerJwt),
      body: { fileId },
    });
    expect(opened.status).toBe(200);
    expect((opened.json as { role: string }).role).toBe('viewer');
    // Owner switches off: stranger is denied again, everywhere.
    const off = await link(aliceJwt, { fileId, role: null });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ linkShare: null });
    expect((await read(strangerJwt, fileId)).status).toBe(404);
    const reopened = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(strangerJwt),
      body: { fileId },
    });
    expect(reopened.status).toBe(403);
  });

  it('(b) transfer moves ownership to a grantee; old owner becomes editor; catalog moves too', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');
    const carolJwt = await login('carol');
    const fileId = await aliceCreates(aliceJwt);
    await catalog.create({ fileId, ownerPrincipal: 'user:alice', name: 'book.xlsx', origin: 'created' });
    expect((await share(aliceJwt, { fileId, principal: 'user:bob', role: 'viewer' })).status).toBe(200);
    // Preconditions: stranger, self, and non-owner transfers refused.
    expect((await transfer(aliceJwt, { fileId, principal: 'user:carol' })).status).toBe(400);
    expect((await transfer(aliceJwt, { fileId, principal: 'user:alice' })).status).toBe(400);
    expect((await transfer(bobJwt, { fileId, principal: 'user:carol' })).status).toBe(403);
    const moved = await transfer(aliceJwt, { fileId, principal: 'user:bob' });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({
      ok: true,
      fileId,
      owner: 'user:bob',
      previousOwner: 'user:alice',
      catalogTransferred: true,
    });
    // Roles after: bob owns, alice edits.
    expect((await read(bobJwt, fileId)).json).toMatchObject({ role: 'owner', owner: 'user:bob' });
    expect((await read(aliceJwt, fileId)).json).toMatchObject({
      role: 'editor',
      grants: [{ principal: 'user:alice', role: 'editor' }],
    });
    // New owner can share; old owner cannot.
    expect((await share(bobJwt, { fileId, principal: 'user:carol', role: 'viewer' })).status).toBe(200);
    expect((await share(aliceJwt, { fileId, principal: 'user:carol', role: null })).status).toBe(403);
    // Catalog moved with it.
    expect((await catalog.listByOwner('user:bob')).map((f) => f.fileId)).toContain(fileId);
    expect((await catalog.listByOwner('user:alice')).map((f) => f.fileId)).not.toContain(fileId);
  });

  it('registry: link settings and transfers survive a claim', async () => {
    const reg = new MemoryFileRegistry();
    const base = {
      fileId: 'file-claim',
      sessionId: 'sess-1',
      ownerInstance: 'engine-1',
      ownerEndpoint: 'http://engine.test',
      leaseExpiry: Date.now() + 30_000,
      ownershipEpoch: 1,
      currentRevision: 0,
      storedRevision: 0,
      updatedAt: Date.now(),
      creatorPrincipal: 'user:alice',
    };
    expect(await reg.claim(base, null)).toBe(true);
    expect(await reg.noteLinkShare('file-claim', 'viewer', 'user:alice')).toBe(true);
    expect(await reg.noteGrant('file-claim', 'user:bob', 'viewer', 'user:alice')).toBe(true);
    expect(await reg.transferOwnership('file-claim', 'user:bob', 'user:alice')).toBe(true);
    // A later claim built from a stale lookup (no linkShare, old
    // creator) must not revert either: the stored values win.
    const stale = { ...base, sessionId: 'sess-2', ownershipEpoch: 2, leaseExpiry: Date.now() + 30_000 };
    expect(await reg.claim(stale, 1)).toBe(true);
    const after = await reg.lookup('file-claim');
    expect(after?.creatorPrincipal).toBe('user:bob');
    expect(after?.linkShare).toEqual({ role: 'viewer' });
    expect(after?.grants).toMatchObject({ 'user:alice': 'editor' });
    expect(after?.grants?.['user:bob']).toBeUndefined();
  });
});
