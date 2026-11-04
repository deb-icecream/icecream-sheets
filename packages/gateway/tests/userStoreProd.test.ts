/**
 * USER_STORE=prod wiring (deploy follow-up Leg 2): before this, the
 * gateway.yaml never set USER_STORE and no bin ever injected a
 * Firestore client, so the deployed gateway's tier store + file
 * catalog were instance-local JSON and bin/set-tier.ts could not
 * reach the deployed store (the deploy test user could not be
 * promoted to Pro).
 *
 * Proof here is fake-based (the firestoreProdAdapters.test.ts style —
 * no live Firestore is reachable from tests):
 *   - provider selection: unset / local stays local; 'prod' and
 *     'firestore' select prod.
 *   - prod fails closed: the sync factories throw without an injected
 *     client, and the async prod constructors (prodUserConfig /
 *     createProdUserStores / createProdUserTierStore — the exact
 *     functions bin/gateway.ts and bin/set-tier.ts call) throw /
 *     reject without GCP_PROJECT_ID, BEFORE any client work.
 *   - with an injected client, prod construction returns the Firestore
 *     adapters, and TWO instances over the same Firestore (gateway
 *     instance + set-tier operator instance) see each other's writes:
 *     a promotion written through one is read back through the other.
 *     That shared-store visibility is the property the deploy was
 *     missing.
 *   - the local default is unchanged: the sync factories return the
 *     Local adapters and persist under USER_STORE_DIR / opts.dir.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FirestoreUserFileCatalog,
  FirestoreUserSettingsStore,
  FirestoreUserTierStore,
  LocalUserFileCatalog,
  LocalUserSettingsStore,
  LocalUserTierStore,
  createProdUserStores,
  createProdUserTierStore,
  createUserFileCatalog,
  createUserSettingsStore,
  createUserTierStore,
  prodUserConfig,
  userStoreProvider,
} from '../src/deploy/userStore.js';
import type { FirestoreLike } from '../src/deploy/sessionStore.js';

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

const env = (e: Record<string, string>): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

describe('USER_STORE provider selection', () => {
  it('unset / empty / local → local; prod / firestore → prod', () => {
    expect(userStoreProvider(env({}))).toBe('local');
    expect(userStoreProvider(env({ USER_STORE: '' }))).toBe('local');
    expect(userStoreProvider(env({ USER_STORE: 'local' }))).toBe('local');
    expect(userStoreProvider(env({ USER_STORE: 'prod' }))).toBe('prod');
    expect(userStoreProvider(env({ USER_STORE: 'PROD' }))).toBe('prod');
    expect(userStoreProvider(env({ USER_STORE: 'firestore' }))).toBe('prod');
  });

  it('local default unchanged: sync factories return the Local adapters and persist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-user-store-prod-'));
    try {
      const tiers = createUserTierStore(env({}), { dir });
      const catalog = createUserFileCatalog(env({ USER_STORE: 'local' }), { dir });
      const settings = createUserSettingsStore(env({}), { dir });
      expect(tiers).toBeInstanceOf(LocalUserTierStore);
      expect(catalog).toBeInstanceOf(LocalUserFileCatalog);
      expect(settings).toBeInstanceOf(LocalUserSettingsStore);

      await tiers.setTierByUserId('u-local', 'pro');
      // A second construction over the same dir reads it back (the
      // local JSON store, exactly as before the prod wiring).
      const tiers2 = createUserTierStore(env({ USER_STORE_DIR: dir }));
      expect(tiers2).toBeInstanceOf(LocalUserTierStore);
      expect((await tiers2.getRecord('u-local'))?.tier).toBe('pro');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Prod fails closed
// ---------------------------------------------------------------------------

describe('USER_STORE=prod fails closed', () => {
  it('sync factories throw without an injected Firestore client (all three stores)', () => {
    expect(() => createUserTierStore(env({ USER_STORE: 'prod' }))).toThrow(/fail closed/);
    expect(() => createUserFileCatalog(env({ USER_STORE: 'prod' }))).toThrow(/fail closed/);
    expect(() => createUserSettingsStore(env({ USER_STORE: 'prod' }))).toThrow(/fail closed/);
    expect(() => createUserTierStore(env({ USER_STORE: 'firestore' }))).toThrow(/fail closed/);
  });

  it('prodUserConfig requires GCP_PROJECT_ID and passes FIRESTORE_DATABASE_ID through', () => {
    expect(() => prodUserConfig(env({ USER_STORE: 'prod' }))).toThrow(/GCP_PROJECT_ID/);
    expect(() => prodUserConfig(env({ GCP_PROJECT_ID: '  ' }))).toThrow(/GCP_PROJECT_ID/);
    expect(prodUserConfig(env({ GCP_PROJECT_ID: 'my-project' }))).toEqual({
      projectId: 'my-project',
    });
    expect(
      prodUserConfig(env({ GCP_PROJECT_ID: 'my-project', FIRESTORE_DATABASE_ID: 'db2' })),
    ).toEqual({ projectId: 'my-project', databaseId: 'db2' });
  });

  it('the async prod constructors reject without GCP_PROJECT_ID, before any client load', async () => {
    // These are the exact entry points bin/gateway.ts
    // (createProdUserStores) and bin/set-tier.ts
    // (createProdUserTierStore) await in prod mode.
    await expect(createProdUserStores(env({ USER_STORE: 'prod' }))).rejects.toThrow(
      /GCP_PROJECT_ID/,
    );
    await expect(createProdUserTierStore(env({ USER_STORE: 'prod' }))).rejects.toThrow(
      /GCP_PROJECT_ID/,
    );
  });
});

// ---------------------------------------------------------------------------
// Prod with an injected client (the bin injection shape)
// ---------------------------------------------------------------------------

describe('USER_STORE=prod with an injected Firestore client', () => {
  it('sync factories return the Firestore adapters', () => {
    const { db } = makeFakeFirestore();
    const prodEnv = env({ USER_STORE: 'prod', GCP_PROJECT_ID: 'my-project' });
    expect(createUserTierStore(prodEnv, { firestoreDb: db })).toBeInstanceOf(
      FirestoreUserTierStore,
    );
    expect(createUserFileCatalog(prodEnv, { firestoreDb: db })).toBeInstanceOf(
      FirestoreUserFileCatalog,
    );
    expect(createUserSettingsStore(prodEnv, { firestoreDb: db })).toBeInstanceOf(
      FirestoreUserSettingsStore,
    );
  });

  it('gateway instance and set-tier instance over the SAME Firestore see each other', async () => {
    const { db, docs } = makeFakeFirestore();
    const prodEnv = env({ USER_STORE: 'prod', GCP_PROJECT_ID: 'my-project' });
    // The "deployed gateway": built from the injected client.
    const gatewayTiers = createUserTierStore(prodEnv, { firestoreDb: db });
    const gatewayCatalog = createUserFileCatalog(prodEnv, { firestoreDb: db });
    // The "operator running set-tier": a SEPARATE store instance over
    // the same Firestore — before the prod wiring this was a local
    // JSON file on the operator's machine and the promotion never
    // reached the gateway.
    const operatorTiers = createUserTierStore(prodEnv, { firestoreDb: db });

    // First login creates the default-tier record in Firestore.
    expect(await gatewayTiers.resolveTier({ userId: 'deploy-tester', email: 't@example.com' }))
      .toBe('default');
    // The operator promotes BY EMAIL; the gateway's next read is pro.
    const promoted = await operatorTiers.setTierByEmail('t@example.com', 'pro');
    expect(promoted?.userId).toBe('deploy-tester');
    expect(await gatewayTiers.resolveTier({ userId: 'deploy-tester', email: 't@example.com' }))
      .toBe('pro');
    expect(docs.has('icecream_user_tiers/deploy-tester')).toBe(true);

    // A pending promotion for a never-seen email also travels through
    // the shared store and is consumed at that user's first login.
    expect(await operatorTiers.setTierByEmail('new@example.com', 'pro')).toBeNull();
    expect(docs.has('icecream_user_tiers/pending:new@example.com')).toBe(true);
    expect(await gatewayTiers.resolveTier({ userId: 'u-new', email: 'new@example.com' }))
      .toBe('pro');
    expect(await gatewayTiers.getPendingByEmail('new@example.com')).toBeNull();

    // Catalog writes from the gateway are durable in the same store:
    // a separate catalog instance lists them back.
    await gatewayCatalog.create({
      fileId: 'file-1',
      ownerPrincipal: 'user:deploy-tester',
      name: 'Book.xlsx',
      origin: 'created',
    });
    const catalog2 = createUserFileCatalog(prodEnv, { firestoreDb: db });
    expect((await catalog2.listByOwner('user:deploy-tester')).map((f) => f.fileId)).toEqual([
      'file-1',
    ]);
    expect(docs.has('icecream_user_files/file-1')).toBe(true);
  });

  it('createProdUserStores is not the local path: it validates config first', async () => {
    // With a project id the constructor proceeds to load the real
    // client (not exercised here — no live Firestore in tests); the
    // fail-closed half is covered above. This guards against a
    // regression where createProdUserStores silently returns local
    // stores when config is incomplete.
    await expect(createProdUserStores(env({}))).rejects.toThrow(/fail closed/);
  });
});
