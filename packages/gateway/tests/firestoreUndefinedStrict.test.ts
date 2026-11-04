/**
 * Regression (batch-2 live-proof failure, 2026-10-23): the real
 * @google-cloud/firestore client REJECTS any document containing an
 * `undefined` value, while the in-memory fakes accept it silently —
 * so adapter payloads with naturally-unset optional fields passed
 * every suite and threw on the first live write (FirestoreFileRegistry
 * .claim() wrote `grants: cur?.grants` = undefined for every new file;
 * the gateway failed the open closed with 503 'session registry
 * unavailable').
 *
 * This suite runs the prod adapters against a STRICT fake whose
 * set() deep-scans the payload and throws on undefined exactly like
 * the real client. The adapters must strip undefined fields at the
 * write boundary (stripUndefinedDeep, deploy/sessionStore.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  FirestoreFileRegistry,
  type FileRegistryRecord,
} from '../src/deploy/fileRegistry.js';
import {
  FirestoreSessionStores,
  type FirestoreLike,
  type StorageLike,
} from '../src/deploy/sessionStore.js';

function assertNoUndefined(value: unknown, path: string): void {
  if (value === undefined) {
    throw new Error(
      `Cannot use "undefined" as a Firestore value (found in field "${path}")`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, path ? `${path}.${k}` : k);
  }
}

function makeStrictFakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const refKeys = new WeakMap<object, string>();
  let txnChain: Promise<unknown> = Promise.resolve();
  const applySet = (key: string, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
    assertNoUndefined(data, '');
    docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : { ...data });
  };
  const db: FirestoreLike = {
    runTransaction: (fn) => {
      const run = txnChain.then(async () => {
        const writes: Array<() => void> = [];
        const result = await fn({
          get: async (ref) => {
            const key = refKeys.get(ref as object);
            if (key === undefined) throw new Error('strict fake txn: unknown ref');
            return { exists: docs.has(key), data: () => docs.get(key) };
          },
          set: (ref, data, opts) => {
            const key = refKeys.get(ref as object);
            if (key === undefined) throw new Error('strict fake txn: unknown ref');
            assertNoUndefined(data, '');
            writes.push(() => applySet(key, data, opts));
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
          get: async () => ({ exists: docs.has(key), data: () => docs.get(key) }),
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            applySet(key, data, opts);
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

const stubStorage: StorageLike = {
  bucket: () => ({
    file: () => ({
      save: async () => undefined,
      download: async () => [Buffer.alloc(0)],
      getMetadata: async () => [{}],
    }),
  }),
};

function claimRecord(fileId: string, epoch: number): FileRegistryRecord {
  // The exact shape gateway.ts builds for a first claim: grants comes
  // from `rec?.grants` — undefined when there is no prior record.
  return {
    fileId,
    sessionId: 'sess_strict',
    ownerInstance: 'engine-1',
    ownerEndpoint: 'http://127.0.0.1:8101',
    leaseExpiry: Date.now() + 30_000,
    ownershipEpoch: epoch,
    currentRevision: 0,
    storedRevision: 0,
    updatedAt: Date.now(),
    creatorPrincipal: 'user:alice',
    grants: undefined,
  } as FileRegistryRecord;
}

describe('prod Firestore adapters vs a strict (real-client-like) fake', () => {
  it('file registry: first claim of a NEW file writes no undefined fields', async () => {
    const { db } = makeStrictFakeFirestore();
    const reg = new FirestoreFileRegistry(db, 30_000);
    await expect(reg.claim(claimRecord('file-strict-1', 1), null)).resolves.toBe(true);
    const rec = await reg.lookup('file-strict-1');
    expect(rec?.creatorPrincipal).toBe('user:alice');
    expect(rec?.ownershipEpoch).toBe(1);
  });

  it('file registry: takeover claim, grant, heartbeat, release all stay writeable', async () => {
    const { db } = makeStrictFakeFirestore();
    const reg = new FirestoreFileRegistry(db, 30_000);
    await expect(reg.claim(claimRecord('file-strict-2', 1), null)).resolves.toBe(true);
    await expect(reg.noteGrant('file-strict-2', 'user:bob', 'viewer', 'user:alice')).resolves.toBe(true);
    await expect(reg.claim(claimRecord('file-strict-2', 2), 1)).resolves.toBe(true);
    const after = await reg.lookup('file-strict-2');
    expect(after?.grants).toEqual({ 'user:bob': 'viewer' }); // grants survive the takeover claim
    await expect(reg.heartbeat('file-strict-2', 'sess_strict', 2, 3, 3)).resolves.toBe(true);
    await expect(
      reg.noteParticipant('file-strict-2', 'sess_strict', 2, 'user:bob', 'viewer'),
    ).resolves.toBe(true);
    await expect(reg.release('file-strict-2', 'sess_strict', 2)).resolves.toBe(true);
  });

  it('session stores: register/update tolerate unset optional fields', async () => {
    const { db } = makeStrictFakeFirestore();
    const stores = new FirestoreSessionStores(db, stubStorage, 'bucket-x');
    await stores.registry.register({
      sessionId: 'sess-strict',
      instanceId: 'engine-1',
      principal: 'user:alice',
      status: 'active',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
      // snapshotChecksum / snapshotRevision / releaseReason unset.
    });
    await stores.registry.update('sess-strict', { revision: 1, snapshotChecksum: undefined });
    const rec = await stores.registry.lookup('sess-strict');
    expect(rec?.revision).toBe(1);
  });

  it('session stores: journal segments tolerate entries without delta/origin', async () => {
    const { db } = makeStrictFakeFirestore();
    const stores = new FirestoreSessionStores(db, stubStorage, 'bucket-x');
    await stores.journal.appendSegment({
      sessionId: 'sess-strict',
      fromRevision: 0,
      toRevision: 1,
      at: 1,
      ops: [{ revision: 1, op: { cmd: 'setCell', value: undefined }, at: 1 }],
    });
    const ops = await stores.journal.readFrom('sess-strict', 0);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.revision).toBe(1);
  });
});
