/**
 * App shares (idea-app-gallery, user-confirmed design 2026-10-21):
 * the gateway HTTP surface for app + data snapshot shares.
 * Signed-in only; create validates the package (credentials can never
 * travel); any signed-in recipient can fetch; revoke is owner-only
 * and per-link; missing and revoked are the same 404.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createAppSharePackage, type AppSharePackage, type ArtifactSpec } from '@icecream-sheets/service';
import { createGateway } from '../src/gateway.js';
import { MemoryAppShareStore } from '../src/deploy/shareStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = '<redacted>'

function makePackage(): AppSharePackage {
  const spec: ArtifactSpec = {
    id: 'artifact_1',
    version: 1,
    kind: 'react-app',
    name: 'Score viewer',
    prompt: 'show me the scores',
    template: 'data-table',
    source: 'function App() { return h("div", null, "scores"); }',
    binding: {
      sheet: 'Scores',
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 1,
      hasHeaderRow: true,
      columns: [
        { name: 'Player', type: 'text', index: 0 },
        { name: 'Points', type: 'numeric', index: 1 },
      ],
    },
    principal: 'user:alice',
    createdAt: 1000,
    updatedAt: 1000,
  };
  return createAppSharePackage(spec, [
    ['Player', 'Points'],
    ['Ada', 30],
    ['Grace', 25],
  ]);
}

let gateway: Started | null = null;
let store: MemoryAppShareStore;

async function setup(): Promise<void> {
  store = new MemoryAppShareStore();
  const listener = createGateway({
    devLoginEnabled: true,
    authSecret: SECRET,
    routes: {},
    rateLimit: { points: 1000, perSeconds: 60 },
    appShareStore: store,
  });
  gateway = await startServer(listener);
}

afterEach(async () => {
  if (gateway) await stop(gateway);
  gateway = null;
});

async function login(userId: string): Promise<string> {
  const r = await httpJson('POST', `${gateway!.url}/auth/login`, { body: { userId } });
  expect(r.status).toBe(200);
  return (r.json as { token: string }).token;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('/api/shares', () => {
  it('requires sign-in', async () => {
    await setup();
    const r = await httpJson('GET', `${gateway!.url}/api/shares`);
    expect(r.status).toBe(401);
  });

  it('create → list (metadata only) → recipient fetch → revoke → gone', async () => {
    await setup();
    const alice = await login('alice');
    const bob = await login('bob');
    const pkg = makePackage();

    const created = await httpJson('POST', `${gateway!.url}/api/shares`, {
      headers: auth(alice),
      body: { package: pkg },
    });
    expect(created.status).toBe(201);
    const share = (created.json as { share: Record<string, unknown> }).share;
    expect(share['appName']).toBe('Score viewer');
    expect(share['sourceSheet']).toBe('Scores');
    expect(share['rowCount']).toBe(2);
    expect(share['revokedAt']).toBeNull();
    expect(share['pkg']).toBeUndefined(); // summaries never carry the package
    const shareId = share['shareId'] as string;
    expect(shareId.startsWith('share-')).toBe(true);

    // "Shared by you": alice sees it, bob does not.
    const aliceList = await httpJson('GET', `${gateway!.url}/api/shares`, { headers: auth(alice) });
    expect((aliceList.json as { shares: unknown[] }).shares).toHaveLength(1);
    const bobList = await httpJson('GET', `${gateway!.url}/api/shares`, { headers: auth(bob) });
    expect((bobList.json as { shares: unknown[] }).shares).toHaveLength(0);

    // Recipient fetch (signed in, not the owner): full app + data package.
    const fetched = await httpJson('GET', `${gateway!.url}/api/shares/${shareId}`, {
      headers: auth(bob),
    });
    expect(fetched.status).toBe(200);
    const gotPkg = (fetched.json as { package: AppSharePackage }).package;
    expect(gotPkg.app.name).toBe('Score viewer');
    expect(gotPkg.snapshot.cells).toEqual(pkg.snapshot.cells);

    // Revoke is owner-only: bob gets the same 404 as a missing link.
    const bobRevoke = await httpJson('DELETE', `${gateway!.url}/api/shares/${shareId}`, {
      headers: auth(bob),
    });
    expect(bobRevoke.status).toBe(404);
    const stillThere = await httpJson('GET', `${gateway!.url}/api/shares/${shareId}`, {
      headers: auth(bob),
    });
    expect(stillThere.status).toBe(200);

    // Owner revokes → link is dead for everyone; list shows the revoke.
    const revoked = await httpJson('DELETE', `${gateway!.url}/api/shares/${shareId}`, {
      headers: auth(alice),
    });
    expect(revoked.status).toBe(200);
    const gone = await httpJson('GET', `${gateway!.url}/api/shares/${shareId}`, {
      headers: auth(bob),
    });
    expect(gone.status).toBe(404);
    const listAfter = await httpJson('GET', `${gateway!.url}/api/shares`, { headers: auth(alice) });
    const sharesAfter = (listAfter.json as { shares: { revokedAt: number | null }[] }).shares;
    expect(sharesAfter[0].revokedAt).not.toBeNull();
  });

  it('rejects a package smuggling credentials at create time', async () => {
    await setup();
    const alice = await login('alice');
    const pkg = JSON.parse(JSON.stringify(makePackage())) as Record<string, unknown>;
    (pkg['snapshot'] as Record<string, unknown>)['connectionString'] = 'postgres://u:p@h/db';
    const r = await httpJson('POST', `${gateway!.url}/api/shares`, {
      headers: auth(alice),
      body: { package: pkg },
    });
    expect(r.status).toBe(400);
    expect((r.json as { code?: string }).code).toBe('INVALID_SHARE_PACKAGE');
    // Nothing was stored.
    const list = await httpJson('GET', `${gateway!.url}/api/shares`, { headers: auth(alice) });
    expect((list.json as { shares: unknown[] }).shares).toHaveLength(0);
  });
});
