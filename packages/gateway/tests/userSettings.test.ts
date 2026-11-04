/**
 * Workspace settings (hidden_files/workspace-settings/BRIEF.md):
 * per-user settings store units (memory / local / Firestore-shaped /
 * fail-closed factory), tier-record + share hard-delete units, and the
 * gateway HTTP surface — GET/PUT /api/settings (own-settings only,
 * email read-only, provider identity echoed from the VERIFIED claims)
 * and DELETE /api/account (one action across every gateway-owned
 * per-user store; other users untouched).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueToken } from '@icecream-sheets/service';
import { createGateway, type GatewayListener } from '../src/gateway.js';
import {
  LocalUserSettingsStore,
  MemoryUserFileCatalog,
  MemoryUserSettingsStore,
  MemoryUserTierStore,
  createUserSettingsStore,
  type UserSettingsStore,
} from '../src/deploy/userStore.js';
import { MemoryAppShareStore } from '../src/deploy/shareStore.js';
import { MemoryUploadObjectStore, uploadObjectKey } from '../src/deploy/uploadStore.js';
import { MemoryFileRegistry, type FileRegistryRecord } from '../src/deploy/fileRegistry.js';
import type { FirestoreLike } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'test-settings-secret';

// ---------------------------------------------------------------------------
// FirestoreLike fake (firestoreProdAdapters.test.ts style)
// ---------------------------------------------------------------------------

function makeFakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  // F-5: transaction support — refs are keyed so txn.get/set find their
  // doc; transactions serialize on a chain (Firestore semantics) and
  // writes buffer until the callback completes (commit).
  const refKeys = new WeakMap<object, string>();
  let txnChain: Promise<unknown> = Promise.resolve();
  const db: FirestoreLike = {
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
  return { db, docs };
}

// ---------------------------------------------------------------------------
// Units: settings store
// ---------------------------------------------------------------------------

async function exerciseSettingsStore(store: UserSettingsStore): Promise<void> {
  expect(await store.get('u1')).toBeNull();
  const made = await store.upsert('u1', { displayName: 'Ada L.' });
  expect(made.user.displayName).toBe('Ada L.');
  expect(made.office.theme).toBe('system'); // default
  const themed = await store.upsert('u1', { theme: 'dark' });
  expect(themed.office.theme).toBe('dark');
  expect(themed.user.displayName).toBe('Ada L.'); // merge: untouched field survives
  const cleared = await store.upsert('u1', { displayName: null });
  expect(cleared.user.displayName).toBeNull();
  expect(cleared.office.theme).toBe('dark');
  expect(await store.get('u2')).toBeNull(); // per-user isolation
  expect(await store.remove('u1')).toBe(true);
  expect(await store.get('u1')).toBeNull();
  expect(await store.remove('u1')).toBe(false);
}

describe('UserSettingsStore', () => {
  it('memory adapter: create / merge / clear / remove', async () => {
    await exerciseSettingsStore(new MemoryUserSettingsStore());
  });

  it('local adapter: same semantics + persists across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-settings-store-'));
    try {
      await exerciseSettingsStore(new LocalUserSettingsStore(dir));
      const a = new LocalUserSettingsStore(dir);
      await a.upsert('persisted', { theme: 'light', displayName: 'Grace' });
      const b = new LocalUserSettingsStore(dir);
      const rec = await b.get('persisted');
      expect(rec?.office.theme).toBe('light');
      expect(rec?.user.displayName).toBe('Grace');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('firestore-shaped adapter: same semantics', async () => {
    const { db, docs } = makeFakeFirestore();
    const store = createUserSettingsStore({ USER_STORE: 'prod' }, { firestoreDb: db });
    await exerciseSettingsStore(store);
    await store.upsert('doc-check', { theme: 'dark' });
    expect(docs.has('icecream_user_settings/doc-check')).toBe(true);
  });

  it('factory fails closed in prod without a Firestore client', () => {
    expect(() => createUserSettingsStore({ USER_STORE: 'prod' })).toThrow(/fail closed/);
    expect(() => createUserSettingsStore({ USER_STORE: 'firestore' })).toThrow(/fail closed/);
  });
});

describe('UserTierStore.deleteRecord', () => {
  it('removes the record AND any pending promotion for its email', async () => {
    const store = new MemoryUserTierStore();
    await store.setTierByUserId('u1', 'default');
    // A pending promotion for an email no record carries yet…
    expect(await store.setTierByEmail('ada@example.com', 'pro')).toBeNull();
    // …then the record gains that email via backfill (pending survives
    // the existing-record path today).
    await store.resolveTier({ userId: 'u1', email: 'ada@example.com' });
    expect((await store.getRecord('u1'))?.email).toBe('ada@example.com');
    expect(await store.getPendingByEmail('ada@example.com')).toBe('pro');

    expect(await store.deleteRecord('u1')).toBe(true);
    expect(await store.getRecord('u1')).toBeNull();
    expect(await store.getPendingByEmail('ada@example.com')).toBeNull();
    expect(await store.deleteRecord('u1')).toBe(false);
    // A fresh sign-in with that email lands on DEFAULT (fresh account).
    expect(await store.resolveTier({ userId: 'u2', email: 'ada@example.com' })).toBe('default');
  });
});

describe('AppShareStore.remove', () => {
  it('hard-deletes the record (package data gone, not just revoked)', async () => {
    const store = new MemoryAppShareStore();
    const pkg = {
      app: { name: 'Demo App' },
      snapshot: { sheet: 'Sheet1', cells: {} },
      rowCount: 3,
      colCount: 2,
    } as never;
    const rec = await store.create({ shareId: 'share-1', ownerPrincipal: 'user:ada', pkg });
    expect(rec.appName).toBe('Demo App');
    expect(await store.remove('share-1')).toBe(true);
    expect(await store.get('share-1')).toBeNull();
    expect(await store.remove('share-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

interface Rig {
  gateway: Started;
  listener: GatewayListener;
  settings: MemoryUserSettingsStore;
  tiers: MemoryUserTierStore;
  catalog: MemoryUserFileCatalog;
  uploads: MemoryUploadObjectStore;
  shares: MemoryAppShareStore;
  registry: MemoryFileRegistry;
}

let rig: Rig | null = null;

async function setup(): Promise<Rig> {
  const settings = new MemoryUserSettingsStore();
  const tiers = new MemoryUserTierStore();
  const catalog = new MemoryUserFileCatalog();
  const uploads = new MemoryUploadObjectStore({
    tokenSecret: 'test-upload-secret',
    publicBaseUrl: 'http://127.0.0.1:1',
  });
  const shares = new MemoryAppShareStore();
  const registry = new MemoryFileRegistry();
  const listener = createGateway({
    authSecret: SECRET,
    routes: {},
    rateLimit: { points: 1000, perSeconds: 60 },
    userSettingsStore: settings,
    userTierStore: tiers,
    userFileCatalog: catalog,
    uploadStore: uploads,
    appShareStore: shares,
    fileRegistry: registry,
  });
  const gateway = await startServer(listener);
  rig = { gateway, listener, settings, tiers, catalog, uploads, shares, registry };
  return rig;
}

afterEach(async () => {
  if (rig) await stop(rig.gateway);
  rig = null;
});

/** A gateway JWT with provider identity attrs, as /auth/firebase mints. */
async function tokenFor(userId: string, attrs: Record<string, string> = {}): Promise<string> {
  return issueToken({
    userId,
    attrs: { tier: 'default', ...attrs },
    secret: SECRET,
    ttlSeconds: 3600,
  });
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('/api/settings', () => {
  it('requires auth; 404 before anything is saved', async () => {
    const { gateway } = await setup();
    const anon = await httpJson('GET', `${gateway.url}/api/settings`);
    expect(anon.status).toBe(401);
    const r = await httpJson('GET', `${gateway.url}/api/settings`, {
      headers: auth(await tokenFor('ada')),
    });
    expect(r.status).toBe(404);
    expect((r.json as { code?: string }).code).toBe('SETTINGS_NOT_FOUND');
  });

  it('the no-record 404 still echoes the caller identity from the verified claims (D4)', async () => {
    const { gateway } = await setup();
    const token = await tokenFor('ada', { name: 'Ada Lovelace', email: 'ada@example.com' });
    const r = await httpJson('GET', `${gateway.url}/api/settings`, {
      headers: auth(token),
    });
    expect(r.status).toBe(404);
    const body = r.json as {
      code?: string;
      user?: { email?: unknown; googleName?: unknown };
    };
    expect(body.code).toBe('SETTINGS_NOT_FOUND');
    // Identity belongs to the caller, not the (absent) record: the
    // settings page must be able to show the signed-in email even
    // before anything is saved.
    expect(body.user?.email).toBe('ada@example.com');
    expect(body.user?.googleName).toBe('Ada Lovelace');
  });

  it('PUT saves, GET returns it; provider identity echoes from the claims', async () => {
    const { gateway } = await setup();
    const token = await tokenFor('ada', { name: 'Ada Lovelace', email: 'ada@example.com' });
    const put = await httpJson('PUT', `${gateway.url}/api/settings`, {
      headers: auth(token),
      body: { user: { displayName: 'Ada L.' } },
    });
    expect(put.status).toBe(200);
    const got = await httpJson('GET', `${gateway.url}/api/settings`, { headers: auth(token) });
    expect(got.status).toBe(200);
    const s = (got.json as { settings: never }).settings as {
      user: { displayName: string | null; email: string | null; googleName: string | null };
      office: { theme: string };
    };
    expect(s.user.displayName).toBe('Ada L.');
    expect(s.user.email).toBe('ada@example.com');
    expect(s.user.googleName).toBe('Ada Lovelace');
    expect(s.office.theme).toBe('system');
  });

  it('partial PUTs merge; blank name clears the override; theme validates', async () => {
    const { gateway } = await setup();
    const token = await tokenFor('ada');
    await httpJson('PUT', `${gateway.url}/api/settings`, {
      headers: auth(token),
      body: { user: { displayName: 'Ada' }, office: { theme: 'dark' } },
    });
    const themeOnly = await httpJson('PUT', `${gateway.url}/api/settings`, {
      headers: auth(token),
      body: { office: { theme: 'light' } },
    });
    expect(themeOnly.status).toBe(200);
    let s = ((themeOnly.json as { settings: never }).settings ?? {}) as {
      user: { displayName: string | null };
      office: { theme: string };
    };
    expect(s.user.displayName).toBe('Ada');
    expect(s.office.theme).toBe('light');

    const cleared = await httpJson('PUT', `${gateway.url}/api/settings`, {
      headers: auth(token),
      body: { user: { displayName: '   ' } },
    });
    s = (cleared.json as { settings: never }).settings as typeof s;
    expect(s.user.displayName).toBeNull();

    const badTheme = await httpJson('PUT', `${gateway.url}/api/settings`, {
      headers: auth(token),
      body: { office: { theme: 'neon' } },
    });
    expect(badTheme.status).toBe(400);
    const longName = await httpJson('PUT', `${gateway.url}/api/settings`, {
      headers: auth(token),
      body: { user: { displayName: 'x'.repeat(121) } },
    });
    expect(longName.status).toBe(400);
  });

  it('email changes are rejected (top-level and nested) and never stored', async () => {
    const { gateway } = await setup();
    const token = await tokenFor('ada', { email: 'ada@example.com' });
    for (const body of [
      { email: 'new@example.com' },
      { user: { email: 'new@example.com', displayName: 'Ada' } },
    ]) {
      const r = await httpJson('PUT', `${gateway.url}/api/settings`, {
        headers: auth(token),
        body,
      });
      expect(r.status).toBe(400);
      expect((r.json as { code?: string }).code).toBe('EMAIL_READ_ONLY');
    }
    // Nothing was written by the rejected PUTs.
    const got = await httpJson('GET', `${gateway.url}/api/settings`, { headers: auth(token) });
    expect(got.status).toBe(404);
  });

  it("ownership: another user's settings are unaddressable", async () => {
    const { gateway } = await setup();
    const ada = await tokenFor('ada');
    const bob = await tokenFor('bob');
    await httpJson('PUT', `${gateway.url}/api/settings`, {
      headers: auth(ada),
      body: { user: { displayName: 'Ada' }, office: { theme: 'dark' } },
    });
    // Bob has no record of his own — Ada's is not visible to him.
    const bobGet = await httpJson('GET', `${gateway.url}/api/settings`, { headers: auth(bob) });
    expect(bobGet.status).toBe(404);
    // Bob's PUT writes BOB's record only.
    await httpJson('PUT', `${gateway.url}/api/settings`, {
      headers: auth(bob),
      body: { office: { theme: 'light' } },
    });
    const adaGet = await httpJson('GET', `${gateway.url}/api/settings`, { headers: auth(ada) });
    const s = (adaGet.json as { settings: never }).settings as {
      user: { displayName: string | null };
      office: { theme: string };
    };
    expect(s.user.displayName).toBe('Ada');
    expect(s.office.theme).toBe('dark');
  });
});

describe('DELETE /api/account', () => {
  it('deletes settings, tier, files + bytes, shares; releases own leases; spares others', async () => {
    const r0 = await setup();
    const { gateway } = r0;
    const ada = await tokenFor('ada', { email: 'ada@example.com' });
    const bob = await tokenFor('bob');

    // Seed Ada: settings, tier record, two files (one with bytes), a share, a live lease.
    await r0.settings.upsert('ada', { displayName: 'Ada', theme: 'dark' });
    await r0.tiers.setTierByUserId('ada', 'pro');
    const obj = uploadObjectKey('user:ada', 'file-ada-1', 'xlsx');
    await r0.uploads.put(obj, new Uint8Array([1, 2, 3]));
    await r0.catalog.create({
      fileId: 'file-ada-1',
      ownerPrincipal: 'user:ada',
      name: 'Budget.xlsx',
      origin: 'upload',
      sizeBytes: 3,
      storageRef: { bucket: 'local', object: obj },
    });
    await r0.catalog.create({
      fileId: 'file-ada-2',
      ownerPrincipal: 'user:ada',
      name: 'Notes',
      origin: 'created',
    });
    await r0.shares.create({
      shareId: 'share-ada',
      ownerPrincipal: 'user:ada',
      pkg: {
        app: { name: 'Ada App' },
        snapshot: { sheet: 'Sheet1', cells: {} },
        rowCount: 1,
        colCount: 1,
      } as never,
    });
    const lease: FileRegistryRecord = {
      fileId: 'file-ada-2',
      sessionId: 'sess-ada',
      ownerInstance: 'engine-1',
      ownerEndpoint: 'http://127.0.0.1:9',
      leaseExpiry: Date.now() + 60_000,
      ownershipEpoch: 1,
      currentRevision: 0,
      storedRevision: 0,
      updatedAt: Date.now(),
      creatorPrincipal: 'user:ada',
    };
    expect(await r0.registry.claim(lease, null)).toBe(true);

    // Seed Bob: his own settings + file must survive untouched.
    await r0.settings.upsert('bob', { displayName: 'Bob' });
    await r0.catalog.create({
      fileId: 'file-bob-1',
      ownerPrincipal: 'user:bob',
      name: 'Bob.xlsx',
      origin: 'created',
    });

    const del = await httpJson('DELETE', `${gateway.url}/api/account`, { headers: auth(ada) });
    expect(del.status).toBe(200);
    const deleted = (del.json as { deleted: Record<string, number | boolean> }).deleted;
    expect(deleted['files']).toBe(2);
    expect(deleted['storedObjects']).toBe(1);
    expect(deleted['shares']).toBe(1);
    expect(deleted['sessionsReleased']).toBe(1);
    expect(deleted['settings']).toBe(true);
    expect(deleted['tierRecord']).toBe(true);

    // After: everything of Ada's is gone through the API too.
    expect((await httpJson('GET', `${gateway.url}/api/settings`, { headers: auth(ada) })).status).toBe(404);
    expect(
      (await httpJson('GET', `${gateway.url}/api/files/file-ada-1`, { headers: auth(ada) })).status,
    ).toBe(404);
    expect(await r0.uploads.stat(obj)).toBeNull();
    expect(await r0.shares.get('share-ada')).toBeNull();
    expect(await r0.tiers.getRecord('ada')).toBeNull();
    const regAfter = await r0.registry.lookup('file-ada-2');
    expect(regAfter).not.toBeNull(); // record persists as CAS metadata…
    expect(regAfter!.leaseExpiry).toBeLessThanOrEqual(Date.now()); // …but the lease is released

    // Bob untouched.
    expect(await r0.settings.get('bob')).not.toBeNull();
    expect(await r0.catalog.get('file-bob-1')).not.toBeNull();
    const bobFiles = await httpJson('GET', `${gateway.url}/api/files`, { headers: auth(bob) });
    expect(bobFiles.status).toBe(200);

    // A fresh login for Ada lands on the default tier (fresh account).
    expect(await r0.tiers.resolveTier({ userId: 'ada', email: 'ada@example.com' })).toBe('default');
  });

  it('is a clean no-op for a user with nothing stored', async () => {
    const { gateway } = await setup();
    const token = await tokenFor('ghost');
    const del = await httpJson('DELETE', `${gateway.url}/api/account`, { headers: auth(token) });
    expect(del.status).toBe(200);
    const deleted = (del.json as { deleted: Record<string, number | boolean> }).deleted;
    expect(deleted['files']).toBe(0);
    expect(deleted['settings']).toBe(false);
    expect(deleted['tierRecord']).toBe(false);
  });

  it('fails closed (503) when the settings store cannot be constructed in prod posture', async () => {
    const prev = process.env.USER_STORE;
    process.env.USER_STORE = 'prod';
    let gw: Started | null = null;
    try {
      // No store opts: createGateway attempts env construction, the
      // prod factories throw without a Firestore client, and the
      // endpoints must serve 503 — never a silent local fallback.
      const listener = createGateway({
        authSecret: SECRET,
        routes: {},
        rateLimit: { points: 100, perSeconds: 60 },
        fileRegistry: new MemoryFileRegistry(),
        uploadStore: new MemoryUploadObjectStore({
          tokenSecret: 'test-upload-secret',
          publicBaseUrl: 'http://127.0.0.1:1',
        }),
      });
      gw = await startServer(listener);
      const token = await tokenFor('ada');
      const got = await httpJson('GET', `${gw.url}/api/settings`, { headers: auth(token) });
      expect(got.status).toBe(503);
      const del = await httpJson('DELETE', `${gw.url}/api/account`, { headers: auth(token) });
      expect(del.status).toBe(503);
    } finally {
      if (gw) await stop(gw);
      if (prev === undefined) delete process.env.USER_STORE;
      else process.env.USER_STORE = prev;
    }
  });
});
