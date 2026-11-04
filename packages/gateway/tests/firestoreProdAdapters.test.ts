/**
 * Firestore prod adapters (user ruling 2026-10-22: features broken in
 * production are blockers in principle):
 *
 * Gap 1 — the agent / add-on session resolvers enumerate the session
 * ownership registry via FileRegistry.listAll(). All three adapters
 * (Local / Memory / Firestore) list with identical semantics, and the
 * resolvers exclude dead-lease records identically over every source
 * (the shared isLiveOwner filter — exactly as records read from the
 * local registry file are treated today).
 *
 * Gap 2 — the app-share store's Firestore adapter (SHARE_STORE=prod):
 * create/read/revoke round trip against an in-memory fake, sha256-hex
 * doc ids, the 1 MiB document cap rejecting loudly, and prod
 * construction failing closed without GCP_PROJECT_ID / a client.
 *
 * No live Firestore is reachable from this VM: all proof is fake-based
 * (the deployAccess.test.ts fake style); the live proof rides the
 * post-deploy verification.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createAppSharePackage,
  type AppSharePackage,
  type ArtifactSpec,
} from '@icecream-sheets/service';
import {
  FirestoreFileRegistry,
  LocalFileRegistry,
  MemoryFileRegistry,
  type FileRegistry,
  type FileRegistryRecord,
} from '../src/deploy/fileRegistry.js';
import { wrapFirestore, type FirestoreLike } from '../src/deploy/sessionStore.js';
import {
  createAgentSessionResolver,
  createFileSessionResolver,
} from '../src/services/agentSessionResolver.js';
import {
  APP_SHARES_COLLECTION,
  FirestoreAppShareStore,
  createAppShareStore,
  createProdAppShareStore,
  prodShareConfig,
  shareDocId,
} from '../src/deploy/shareStore.js';

// ---------------------------------------------------------------------------
// In-memory FirestoreLike fake (deployAccess.test.ts style)
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
// Gap 1 — registry listing + resolver binding over the Firestore path
// ---------------------------------------------------------------------------

function rec(fileId: string, over: Partial<FileRegistryRecord> = {}): FileRegistryRecord {
  return {
    fileId,
    sessionId: `sess_${fileId}`,
    ownerInstance: 'engine-1',
    ownerEndpoint: 'http://127.0.0.1:8101',
    leaseExpiry: Date.now() + 60_000,
    ownershipEpoch: 1,
    currentRevision: 0,
    storedRevision: 0,
    updatedAt: Date.now(),
    creatorPrincipal: 'user:alice',
    ...over,
  };
}

describe('registry listAll + resolvers (gap 1)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The same record set in every adapter: one live, one dead-lease,
   *  one released (lease 0), one live-but-someone-else's. */
  async function seed(registry: FileRegistry): Promise<void> {
    await registry.claim(rec('file-live'), null);
    await registry.claim(
      rec('file-dead', { leaseExpiry: Date.now() - 1_000, creatorPrincipal: 'user:dave' }),
      null,
    );
    await registry.claim(rec('file-released'), null);
    await registry.release('file-released', 'sess_file-released', 1);
    await registry.claim(rec('file-other', { creatorPrincipal: 'user:carol' }), null);
  }

  function allThree(): Array<readonly [string, FileRegistry]> {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-freg-list-'));
    dirs.push(dir);
    const { db } = makeFakeFirestore();
    return [
      ['memory', new MemoryFileRegistry()],
      ['local', new LocalFileRegistry(dir)],
      ['firestore', new FirestoreFileRegistry(db)],
    ] as const;
  }

  it('listAll returns the same record set from every adapter (live and dead alike)', async () => {
    for (const [name, registry] of allThree()) {
      await seed(registry);
      const listed = await registry.listAll();
      expect(listed.map((r) => r.fileId).sort(), name).toEqual([
        'file-dead',
        'file-live',
        'file-other',
        'file-released',
      ]);
      // Returned records are copies: mutating one cannot corrupt the store.
      listed[0]!.leaseExpiry = 0;
      const again = await registry.listAll();
      expect(
        again.find((r) => r.fileId === listed[0]!.fileId)?.leaseExpiry,
        name,
      ).not.toBe(0);
    }
  });

  it('resolvers exclude dead/released records identically over every adapter source', async () => {
    for (const [name, registry] of allThree()) {
      await seed(registry);
      const resolve = createAgentSessionResolver({ registry });
      // Alice's only LIVE session is file-live (dead + released never resolve).
      const alice = await resolve('user:alice');
      expect(alice?.fileId, name).toBe('file-live');
      expect(alice?.role, name).toBe('editor');
      // Dave's only record is dead-lease: no session, exactly as the
      // local-file source treats a dead record today.
      expect(await resolve('user:dave'), name).toBeNull();
      // Carol resolves her own live session; a stranger resolves none.
      expect((await resolve('user:carol'))?.fileId, name).toBe('file-other');
      expect(await resolve('user:nobody'), name).toBeNull();
    }
  });

  it('registry source and explicit records source pick the same session', async () => {
    const { db } = makeFakeFirestore();
    const registry = new FirestoreFileRegistry(db);
    await seed(registry);
    const viaRegistry = await createAgentSessionResolver({ registry })('user:alice');
    const viaRecords = await createAgentSessionResolver({
      records: await registry.listAll(),
    })('user:alice');
    expect(viaRecords).toEqual(viaRegistry);
  });

  it('a participant noted through the Firestore registry binds with their join role', async () => {
    const { db } = makeFakeFirestore();
    const registry = new FirestoreFileRegistry(db);
    await registry.claim(rec('file-shared', { creatorPrincipal: 'user:carol' }), null);
    // Bob JOINs as a viewer; the gateway notes it on the live record.
    expect(
      await registry.noteParticipant('file-shared', 'sess_file-shared', 1, 'user:bob', 'viewer'),
    ).toBe(true);
    // Read-only enforcement (design doc sections 4/8): the participant
    // note alone confers nothing — the OWNER's grant is what binds Bob,
    // at the granted role (mirrored into participants by noteGrant).
    expect(await registry.noteGrant('file-shared', 'user:bob', 'viewer', 'user:carol')).toBe(true);
    const resolveForFile = createFileSessionResolver({ registry });
    const bob = await resolveForFile('user:bob', 'file-shared');
    expect(bob?.sessionId).toBe('sess_file-shared');
    expect(bob?.role).toBe('viewer');
    // The creator binds as editor; a non-participant does not bind at all.
    expect((await resolveForFile('user:carol', 'file-shared'))?.role).toBe('editor');
    expect(await resolveForFile('user:eve', 'file-shared')).toBeNull();
    // A note against a dead record is refused, same as the Local adapter.
    await registry.claim(
      rec('file-gone', { leaseExpiry: Date.now() - 5_000, creatorPrincipal: 'user:carol' }),
      null,
    );
    expect(
      await registry.noteParticipant('file-gone', 'sess_file-gone', 1, 'user:bob', 'viewer'),
    ).toBe(false);
    expect(await resolveForFile('user:bob', 'file-gone')).toBeNull();
  });

  it('wrapFirestore exposes the collection scan the listing rides on', async () => {
    const rawDocs = [
      { id: 'file-a', data: () => ({ fileId: 'file-a', sessionId: 'sess_a' }) },
      { id: 'file-b', data: () => ({ fileId: 'file-b', sessionId: 'sess_b' }) },
    ];
    const raw = {
      collection: (_name: string) => ({
        doc: (_id: string) => ({
          get: async () => ({ exists: false, data: () => undefined }),
          set: async () => undefined,
          delete: async () => undefined,
        }),
        where: (_f: string, _op: string, _v: string) => ({
          get: async () => ({ docs: rawDocs }),
        }),
        get: async () => ({ docs: rawDocs }),
      }),
    };
    const wrapped = wrapFirestore(raw);
    const rows = await wrapped.collection('icecream_file_registry').listAll();
    expect(rows.map((r) => r.id)).toEqual(['file-a', 'file-b']);
    expect(rows[0]?.data()).toMatchObject({ fileId: 'file-a' });
    // And a FirestoreFileRegistry over the wrapped client lists them.
    const registry = new FirestoreFileRegistry(wrapped);
    expect((await registry.listAll()).map((r) => r.fileId)).toEqual(['file-a', 'file-b']);
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — share-store Firestore adapter
// ---------------------------------------------------------------------------

function makePackage(rows?: unknown[][]): AppSharePackage {
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
  return createAppSharePackage(
    spec,
    (rows ?? [
      ['Player', 'Points'],
      ['Ada', 30],
      ['Grace', 25],
    ]) as never,
  );
}

describe('share store Firestore adapter (gap 2)', () => {
  it('create / get / listByOwner / revoke round trip against the fake', async () => {
    const { db, docs } = makeFakeFirestore();
    const store = new FirestoreAppShareStore(db);
    const pkg = makePackage();
    const created = await store.create({
      shareId: 'share-1',
      ownerPrincipal: 'user:alice',
      pkg,
    });
    expect(created).toMatchObject({
      shareId: 'share-1',
      ownerPrincipal: 'user:alice',
      appName: 'Score viewer',
      sourceSheet: 'Scores',
      rowCount: 2, // data rows (header excluded, per createAppSharePackage)
      revokedAt: null,
    });

    // The document lives under the sha256-hex doc id, not the raw id.
    const expectedKey = `${APP_SHARES_COLLECTION}/${shareDocId('share-1')}`;
    expect(shareDocId('share-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(shareDocId('share-1')).toBe(
      createHash('sha256').update('share-1', 'utf8').digest('hex'),
    );
    expect([...docs.keys()]).toEqual([expectedKey]);

    // A second store instance over the same db sees the share (the
    // data is in the store, not in instance memory).
    const store2 = new FirestoreAppShareStore(db);
    const got = await store2.get('share-1');
    expect(got?.shareId).toBe('share-1');
    expect(got?.pkg.snapshot.rows).toEqual(pkg.snapshot.rows);
    expect(await store2.get('share-missing')).toBeNull();

    expect((await store2.listByOwner('user:alice')).map((r) => r.shareId)).toEqual(['share-1']);
    expect(await store2.listByOwner('user:bob')).toEqual([]);

    // Revoke is owner-only and idempotent; the record stays readable
    // (callers enforce revoked, exactly as the Local/Memory adapters).
    expect(await store2.revoke('share-1', 'user:bob')).toBe(false);
    expect((await store2.get('share-1'))?.revokedAt).toBeNull();
    expect(await store2.revoke('share-1', 'user:alice')).toBe(true);
    expect((await store2.get('share-1'))?.revokedAt).toEqual(expect.any(Number));
    expect(await store2.revoke('share-1', 'user:alice')).toBe(true);
    expect(await store2.revoke('share-missing', 'user:alice')).toBe(false);
  });

  it('an over-cap share package is rejected loudly and nothing is written', async () => {
    const { db, docs } = makeFakeFirestore();
    const store = new FirestoreAppShareStore(db);
    const big = makePackage([
      ['Player', 'Points'],
      ['x'.repeat(1_100_000), 1],
    ]);
    await expect(
      store.create({ shareId: 'share-big', ownerPrincipal: 'user:alice', pkg: big }),
    ).rejects.toThrow(/document cap/);
    expect(docs.size).toBe(0);
    expect(await store.get('share-big')).toBeNull();
  });

  it('a malformed stored document reads as missing, never as a half-record', async () => {
    const { db, docs } = makeFakeFirestore();
    docs.set(`${APP_SHARES_COLLECTION}/${shareDocId('share-x')}`, { nope: true });
    const store = new FirestoreAppShareStore(db);
    expect(await store.get('share-x')).toBeNull();
    expect(await store.listByOwner('user:alice')).toEqual([]);
  });

  it('prod construction fails closed without GCP_PROJECT_ID or an injected client', async () => {
    expect(() => prodShareConfig({} as NodeJS.ProcessEnv)).toThrow(/GCP_PROJECT_ID/);
    expect(prodShareConfig({ GCP_PROJECT_ID: 'p' } as NodeJS.ProcessEnv)).toEqual({
      projectId: 'p',
    });
    // The async prod constructor validates config BEFORE any client load.
    await expect(createProdAppShareStore({} as NodeJS.ProcessEnv)).rejects.toThrow(
      /GCP_PROJECT_ID/,
    );
    // The sync factory in prod mode without an injected client throws —
    // never a silent local fallback.
    expect(() => createAppShareStore({ SHARE_STORE: 'prod' } as NodeJS.ProcessEnv)).toThrow(
      /fail closed/,
    );
    // With an injected client, prod construction succeeds and works.
    const { db } = makeFakeFirestore();
    const store = createAppShareStore({ SHARE_STORE: 'prod' } as NodeJS.ProcessEnv, {
      firestoreDb: db,
    });
    expect(store).toBeInstanceOf(FirestoreAppShareStore);
    const rec = await store.create({
      shareId: 'share-prod',
      ownerPrincipal: 'user:alice',
      pkg: makePackage(),
    });
    expect(rec.shareId).toBe('share-prod');
  });
});
