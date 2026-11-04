/**
 * W4 built apps (hidden_files/wave-c-fixes/BRIEF.md): UI-built apps
 * persist SERVER-SIDE, keyed by owner principal + gateway file id.
 * Store units (memory / local / Firestore-shaped / fail-closed
 * factory) + the gateway HTTP surface: CRUD, owner isolation,
 * file binding, invalid-spec rejection, account-deletion purge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateAppSpec,
  type AppSpec,
} from '@icecream-sheets/service';
import { createGateway } from '../src/gateway.js';
import {
  createBuiltAppStore,
  FirestoreBuiltAppStore,
  LocalBuiltAppStore,
  MemoryBuiltAppStore,
  type BuiltAppStore,
} from '../src/deploy/builtAppStore.js';
import {
  MemoryUserSettingsStore,
  MemoryUserTierStore,
  MemoryUserFileCatalog,
} from '../src/deploy/userStore.js';
import type { FirestoreLike } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'test-built-apps-secret';

function makeSpec(id: string, name = 'Sales App'): AppSpec {
  const spec = generateAppSpec(
    name,
    { sheet: 'Sales', startRow: 0, startCol: 0, endRow: 12, endCol: 2, headerRow: true },
    [
      { name: 'Month', type: 'text' },
      { name: 'Region', type: 'text' },
      { name: 'Revenue', type: 'numeric' },
    ],
    { id },
  );
  return spec;
}

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

async function exerciseStore(store: BuiltAppStore): Promise<void> {
  const spec = makeSpec('app_1');
  const rec = await store.upsert({ ownerPrincipal: 'user:alice', fileId: 'file-A', spec });
  expect(rec.appId).toBe('app_1');
  expect(rec.spec.fileId).toBe('file-A'); // route binding stamped
  expect(rec.spec.name).toBe('Sales App');

  // Same file lists it; another file does not; another owner does not.
  expect((await store.listByOwnerAndFile('user:alice', 'file-A')).map((r) => r.appId)).toEqual(['app_1']);
  expect(await store.listByOwnerAndFile('user:alice', 'file-B')).toEqual([]);
  expect(await store.listByOwnerAndFile('user:bob', 'file-A')).toEqual([]);
  expect(await store.get('user:bob', 'file-A', 'app_1')).toBeNull();

  // Upsert by id replaces (no duplicate), preserving createdAt.
  const renamed = await store.upsert({
    ownerPrincipal: 'user:alice',
    fileId: 'file-A',
    spec: makeSpec('app_1', 'Renamed App'),
  });
  expect(renamed.createdAt).toBe(rec.createdAt);
  expect(renamed.spec.name).toBe('Renamed App');
  expect(await store.listByOwnerAndFile('user:alice', 'file-A')).toHaveLength(1);

  // A second app on another file for the same owner.
  await store.upsert({ ownerPrincipal: 'user:alice', fileId: 'file-B', spec: makeSpec('app_2') });
  expect((await store.listByOwner('user:alice')).map((r) => r.appId).sort()).toEqual(['app_1', 'app_2']);

  // Invalid spec is rejected loudly, never stored.
  await expect(
    store.upsert({ ownerPrincipal: 'user:alice', fileId: 'file-A', spec: { id: 'x' } }),
  ).rejects.toThrow(/invalid app spec/);
  expect(await store.listByOwnerAndFile('user:alice', 'file-A')).toHaveLength(1);

  // Owner-scoped remove: wrong owner cannot delete.
  expect(await store.remove('user:bob', 'file-A', 'app_1')).toBe(false);
  expect(await store.remove('user:alice', 'file-A', 'app_1')).toBe(true);
  expect(await store.get('user:alice', 'file-A', 'app_1')).toBeNull();

  // Account-deletion purge.
  expect(await store.removeAllForOwner('user:alice')).toBe(1);
  expect(await store.listByOwner('user:alice')).toEqual([]);
}

describe('BuiltAppStore', () => {
  it('memory adapter: keyed CRUD + validation + isolation', async () => {
    await exerciseStore(new MemoryBuiltAppStore());
  });

  it('local adapter: same contract + persistence across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'built-apps-'));
    try {
      await exerciseStore(new LocalBuiltAppStore(dir));
      const again = new LocalBuiltAppStore(dir);
      await again.upsert({ ownerPrincipal: 'user:carol', fileId: 'file-A', spec: makeSpec('app_9') });
      const third = new LocalBuiltAppStore(dir);
      expect((await third.listByOwnerAndFile('user:carol', 'file-A')).map((r) => r.appId)).toEqual(['app_9']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('firestore adapter: same contract over the structural fake', async () => {
    const { db } = makeFakeFirestore();
    await exerciseStore(new FirestoreBuiltAppStore(db));
  });

  it('factory fails closed in prod mode without a Firestore client', () => {
    expect(() => createBuiltAppStore({ BUILT_APP_STORE: 'prod' } as NodeJS.ProcessEnv)).toThrow(
      /fail closed/,
    );
    const { db } = makeFakeFirestore();
    expect(createBuiltAppStore({ BUILT_APP_STORE: 'prod' } as NodeJS.ProcessEnv, { firestoreDb: db }))
      .toBeInstanceOf(FirestoreBuiltAppStore);
  });
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

let gateway: Started | null = null;
let store: MemoryBuiltAppStore;

async function setup(): Promise<void> {
  store = new MemoryBuiltAppStore();
  const listener = createGateway({
    devLoginEnabled: true,
    authSecret: SECRET,
    routes: {},
    rateLimit: { points: 1000, perSeconds: 60 },
    builtAppStore: store,
    userSettingsStore: new MemoryUserSettingsStore(),
    userTierStore: new MemoryUserTierStore(),
    userFileCatalog: new MemoryUserFileCatalog(),
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

describe('/api/built-apps', () => {
  it('requires sign-in', async () => {
    await setup();
    const r = await httpJson('GET', `${gateway!.url}/api/built-apps?fileId=file-A`);
    expect(r.status).toBe(401);
  });

  it('create -> list -> update -> delete, bound to user + file', async () => {
    await setup();
    const alice = await login('alice');
    const spec = makeSpec('app_1');

    const created = await httpJson('POST', `${gateway!.url}/api/built-apps`, {
      headers: auth(alice),
      body: { fileId: 'file-A', spec },
    });
    expect(created.status).toBe(201);
    const app = (created.json as { app: { appId: string; spec: AppSpec } }).app;
    expect(app.appId).toBe('app_1');
    expect(app.spec.fileId).toBe('file-A');

    // Fresh-profile read: list for the same user + file shows it.
    const list = await httpJson('GET', `${gateway!.url}/api/built-apps?fileId=file-A`, {
      headers: auth(alice),
    });
    expect(list.status).toBe(200);
    const apps = (list.json as { apps: { appId: string; spec: AppSpec }[] }).apps;
    expect(apps).toHaveLength(1);
    expect(apps[0]!.spec.name).toBe('Sales App');
    expect(apps[0]!.spec.dataSource.binding.sheet).toBe('Sales');

    // Another file: nothing. Another user, same file: nothing.
    const otherFile = await httpJson('GET', `${gateway!.url}/api/built-apps?fileId=file-B`, {
      headers: auth(alice),
    });
    expect((otherFile.json as { apps: unknown[] }).apps).toEqual([]);
    const bob = await login('bob');
    const bobList = await httpJson('GET', `${gateway!.url}/api/built-apps?fileId=file-A`, {
      headers: auth(bob),
    });
    expect((bobList.json as { apps: unknown[] }).apps).toEqual([]);

    // Update (spec mutation) round-trips.
    const updated = await httpJson('PUT', `${gateway!.url}/api/built-apps/app_1`, {
      headers: auth(alice),
      body: { fileId: 'file-A', spec: makeSpec('app_1', 'Renamed App') },
    });
    expect(updated.status).toBe(200);
    const list2 = await httpJson('GET', `${gateway!.url}/api/built-apps?fileId=file-A`, {
      headers: auth(alice),
    });
    expect((list2.json as { apps: { spec: AppSpec }[] }).apps[0]!.spec.name).toBe('Renamed App');

    // Bob cannot delete alice's app; alice can.
    const bobDel = await httpJson('DELETE', `${gateway!.url}/api/built-apps/app_1?fileId=file-A`, {
      headers: auth(bob),
    });
    expect(bobDel.status).toBe(404);
    const del = await httpJson('DELETE', `${gateway!.url}/api/built-apps/app_1?fileId=file-A`, {
      headers: auth(alice),
    });
    expect(del.status).toBe(200);
    const list3 = await httpJson('GET', `${gateway!.url}/api/built-apps?fileId=file-A`, {
      headers: auth(alice),
    });
    expect((list3.json as { apps: unknown[] }).apps).toEqual([]);
  });

  it('rejects invalid specs and mismatched ids with 400', async () => {
    await setup();
    const alice = await login('alice');
    const bad = await httpJson('POST', `${gateway!.url}/api/built-apps`, {
      headers: auth(alice),
      body: { fileId: 'file-A', spec: { id: 'app_x', name: 'Broken' } },
    });
    expect(bad.status).toBe(400);
    expect((bad.json as { code?: string }).code).toBe('INVALID_APP_SPEC');

    const mismatch = await httpJson('PUT', `${gateway!.url}/api/built-apps/app_1`, {
      headers: auth(alice),
      body: { fileId: 'file-A', spec: makeSpec('app_2') },
    });
    expect(mismatch.status).toBe(400);

    const noFile = await httpJson('GET', `${gateway!.url}/api/built-apps`, {
      headers: auth(alice),
    });
    expect(noFile.status).toBe(400);
  });

  it('account deletion purges the caller built apps only', async () => {
    await setup();
    const alice = await login('alice');
    const bob = await login('bob');
    await httpJson('POST', `${gateway!.url}/api/built-apps`, {
      headers: auth(alice),
      body: { fileId: 'file-A', spec: makeSpec('app_1') },
    });
    await httpJson('POST', `${gateway!.url}/api/built-apps`, {
      headers: auth(bob),
      body: { fileId: 'file-A', spec: makeSpec('app_2') },
    });
    const del = await httpJson('DELETE', `${gateway!.url}/api/account`, { headers: auth(alice) });
    expect(del.status).toBe(200);
    expect((del.json as { deleted: Record<string, unknown> }).deleted['builtApps']).toBe(1);
    expect(await store.listByOwner('user:bob')).toHaveLength(1);
    expect(await store.listByOwner('user:alice')).toEqual([]);
  });
});
