/**
 * Issue #71 — GET /api/engine/share: the read side of the share
 * contract (the web Share dialog's data source). The POST endpoint
 * (issue #51) was write-only; the dialog needs the file's owner, the
 * caller's own role, and the recorded grants. The read resolves all
 * three through aclRoleFor on the current registry record (design
 * doc read-only-enforcement section 8): anyone on the access list
 * may read it; a principal with NO role gets the same 404 as a
 * nonexistent file (no existence leak, mirroring the catalog
 * guard); grants change only through the POST (noteGrant's single
 * call site).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import { MemoryFileRegistry, type FileRegistry } from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'share-read-test-secret';

function signedEnv(): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ['ENGINE_ACCESS_' + 'SECRET']: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
  } as NodeJS.ProcessEnv;
}

const authHdr = (token: string) => ({ authorization: `Bearer ${token}` });

describe('issue #71 — GET /api/engine/share (share-state read)', () => {
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
        authSecret: 'gw-share-read-secret',
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

  async function share(jwt: string, body: unknown) {
    return httpJson('POST', `${gw!.url}/api/engine/share`, { headers: authHdr(jwt), body });
  }

  async function read(jwt: string, fileId: string) {
    return httpJson('GET', `${gw!.url}/api/engine/share?fileId=${encodeURIComponent(fileId)}`, {
      headers: authHdr(jwt),
    });
  }

  /** Alice opens (claims) a fresh file; returns its fileId. */
  async function aliceCreates(aliceJwt: string): Promise<string> {
    const openA = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(aliceJwt),
      body: { name: 'book.xlsx' },
    });
    expect(openA.status).toBe(200);
    return (openA.json as { fileId: string }).fileId;
  }

  it('owner reads her own file: owner role, no grants yet', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const fileId = await aliceCreates(aliceJwt);
    const r = await read(aliceJwt, fileId);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, fileId, owner: 'user:alice', role: 'owner', grants: [] });
  });

  it('a principal with no grant gets the same 404 as a nonexistent file', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');
    const fileId = await aliceCreates(aliceJwt);
    const noGrant = await read(bobJwt, fileId);
    const noFile = await read(bobJwt, 'file-does-not-exist');
    expect(noGrant.status).toBe(404);
    expect(noFile.status).toBe(404);
    expect(noGrant.json).toEqual(noFile.json);
  });

  it('grants appear for grantees with their own role, and follow re-role + revoke', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const bobJwt = await login('bob');
    const fileId = await aliceCreates(aliceJwt);

    const grant = await share(aliceJwt, { fileId, principal: 'user:bob', role: 'viewer' });
    expect(grant.status).toBe(200);

    const bobRead = await read(bobJwt, fileId);
    expect(bobRead.status).toBe(200);
    expect(bobRead.json).toMatchObject({
      owner: 'user:alice',
      role: 'viewer',
      grants: [{ principal: 'user:bob', role: 'viewer' }],
    });

    const aliceRead = await read(aliceJwt, fileId);
    expect(aliceRead.json).toMatchObject({
      role: 'owner',
      grants: [{ principal: 'user:bob', role: 'viewer' }],
    });

    const rerole = await share(aliceJwt, { fileId, principal: 'user:bob', role: 'editor' });
    expect(rerole.status).toBe(200);
    const bobRead2 = await read(bobJwt, fileId);
    expect(bobRead2.json).toMatchObject({
      role: 'editor',
      grants: [{ principal: 'user:bob', role: 'editor' }],
    });

    const revoke = await share(aliceJwt, { fileId, principal: 'user:bob', role: null });
    expect(revoke.status).toBe(200);
    const bobRead3 = await read(bobJwt, fileId);
    expect(bobRead3.status).toBe(404);
    const aliceRead2 = await read(aliceJwt, fileId);
    expect(aliceRead2.json).toMatchObject({ grants: [] });
  });

  it('an editor-grantee can read the list (any recorded role may)', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const carolJwt = await login('carol');
    const fileId = await aliceCreates(aliceJwt);
    await share(aliceJwt, { fileId, principal: 'user:carol', role: 'editor' });
    await share(aliceJwt, { fileId, principal: 'user:bob', role: 'viewer' });
    const r = await read(carolJwt, fileId);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      role: 'editor',
      grants: [
        { principal: 'user:bob', role: 'viewer' },
        { principal: 'user:carol', role: 'editor' },
      ],
    });
  });

  it('malformed fileId is a 400, and the read never mutates the record', async () => {
    await setup();
    const aliceJwt = await login('alice');
    const fileId = await aliceCreates(aliceJwt);
    await share(aliceJwt, { fileId, principal: 'user:bob', role: 'viewer' });
    const before = await registry.lookup(fileId);
    const bad = await httpJson('GET', `${gw!.url}/api/engine/share?fileId=${encodeURIComponent('bad id!')}`, {
      headers: authHdr(aliceJwt),
    });
    expect(bad.status).toBe(400);
    await read(aliceJwt, fileId);
    const after = await registry.lookup(fileId);
    expect(after?.grants).toEqual(before?.grants);
    expect(after?.aclLog).toEqual(before?.aclLog);
  });
});
