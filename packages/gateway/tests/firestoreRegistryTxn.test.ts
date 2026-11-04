/**
 * F-5 regression: FirestoreFileRegistry claim/heartbeat/release/
 * noteParticipant are transactional.
 *
 * The pre-fix shape was read→check→set→re-read against the doc store:
 * two racing claimants could both pass the epoch check (two live
 * owners), and a stale owner's release could land after a takeover and
 * zero the CURRENT owner's lease (TOCTOU). These tests run the
 * registry against a FirestoreLike fake whose doc reads/writes YIELD
 * (so unsynchronized interleavings really happen) and whose
 * runTransaction serializes on a chain with buffered writes — the
 * semantics Firestore itself guarantees.
 */
import { describe, expect, it } from 'vitest';
import {
  FirestoreFileRegistry,
  type FileRegistryRecord,
} from '../src/deploy/fileRegistry.js';
import type { FirestoreLike } from '../src/deploy/sessionStore.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeYieldingFakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const refKeys = new WeakMap<object, string>();
  let txnChain: Promise<unknown> = Promise.resolve();
  const applySet = (key: string, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
    docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : { ...data });
  };
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
          get: async () => {
            await tick();
            return { exists: docs.has(key), data: () => docs.get(key) };
          },
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            await tick();
            applySet(key, data, opts);
          },
          delete: async () => {
            await tick();
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

describe('F-5: FirestoreFileRegistry transactions', () => {
  it('two concurrent first-claims yield exactly one owner', async () => {
    const { db } = makeYieldingFakeFirestore();
    const registry = new FirestoreFileRegistry(db);
    const a = rec('file-race', { sessionId: 'sess-A', ownerInstance: 'engine-A' });
    const b = rec('file-race', { sessionId: 'sess-B', ownerInstance: 'engine-B' });
    const [wonA, wonB] = await Promise.all([registry.claim(a, null), registry.claim(b, null)]);
    expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
    const stored = await registry.lookup('file-race');
    expect(stored?.sessionId).toBe(wonA ? 'sess-A' : 'sess-B');
    expect(stored?.ownershipEpoch).toBe(1);
  });

  it('a stale owner release after takeover cannot evict the current owner', async () => {
    const { db } = makeYieldingFakeFirestore();
    const registry = new FirestoreFileRegistry(db);
    // Owner 1 claims; owner 2 takes over (epoch 1 -> 2).
    expect(await registry.claim(rec('file-takeover', { sessionId: 'sess-old' }), null)).toBe(true);
    const takeover = rec('file-takeover', {
      sessionId: 'sess-new',
      ownerInstance: 'engine-2',
      ownershipEpoch: 2,
      leaseExpiry: Date.now() + 60_000,
    });
    expect(await registry.claim(takeover, 1)).toBe(true);
    // The stale owner's release must fail AND leave the lease intact.
    expect(await registry.release('file-takeover', 'sess-old', 1)).toBe(false);
    const stored = await registry.lookup('file-takeover');
    expect(stored?.sessionId).toBe('sess-new');
    expect(stored?.ownershipEpoch).toBe(2);
    expect(stored?.leaseExpiry).toBe(takeover.leaseExpiry);
    // The current owner can still heartbeat and release.
    expect(await registry.heartbeat('file-takeover', 'sess-new', 2, 7, 7)).toBe(true);
    expect(await registry.release('file-takeover', 'sess-new', 2)).toBe(true);
    expect((await registry.lookup('file-takeover'))?.leaseExpiry).toBe(0);
  });

  it('takeover fencing: a second claim on the same expected epoch fails', async () => {
    const { db } = makeYieldingFakeFirestore();
    const registry = new FirestoreFileRegistry(db);
    expect(await registry.claim(rec('file-fence'), null)).toBe(true);
    const t1 = rec('file-fence', { sessionId: 'sess-t1', ownershipEpoch: 2 });
    const t2 = rec('file-fence', { sessionId: 'sess-t2', ownershipEpoch: 2 });
    const [won1, won2] = await Promise.all([registry.claim(t1, 1), registry.claim(t2, 1)]);
    expect([won1, won2].filter(Boolean)).toHaveLength(1);
    expect((await registry.lookup('file-fence'))?.ownershipEpoch).toBe(2);
  });

  it('heartbeat is fenced by session + epoch inside the transaction', async () => {
    const { db } = makeYieldingFakeFirestore();
    const registry = new FirestoreFileRegistry(db, 5_000);
    expect(await registry.claim(rec('file-hb', { leaseExpiry: 1 }), null)).toBe(true);
    expect(await registry.heartbeat('file-hb', 'sess_wrong', 1, 3, 3)).toBe(false);
    expect(await registry.heartbeat('file-hb', 'sess_file-hb', 99, 3, 3)).toBe(false);
    expect(await registry.heartbeat('file-hb', 'sess_file-hb', 1, 3, 3)).toBe(true);
    const stored = await registry.lookup('file-hb');
    expect(stored?.leaseExpiry).toBeGreaterThan(Date.now());
    expect(stored?.currentRevision).toBe(3);
  });

  it('a heartbeat can never revive a released record (release is terminal until a fresh claim)', async () => {
    const { db } = makeYieldingFakeFirestore();
    const registry = new FirestoreFileRegistry(db, 5_000);
    expect(await registry.claim(rec('file-released'), null)).toBe(true);
    expect(await registry.heartbeat('file-released', 'sess_file-released', 1, 3, 3)).toBe(true);
    expect(await registry.release('file-released', 'sess_file-released', 1)).toBe(true);
    expect((await registry.lookup('file-released'))?.leaseExpiry).toBe(0);
    // The in-flight-heartbeat race: a heartbeat that lands AFTER the
    // release must be rejected, not re-extend the dead lease.
    expect(await registry.heartbeat('file-released', 'sess_file-released', 1, 4, 4)).toBe(false);
    expect((await registry.lookup('file-released'))?.leaseExpiry).toBe(0);
  });

  it('listAll returns claimed records (and skips malformed docs)', async () => {
    const { db, docs } = makeYieldingFakeFirestore();
    const registry = new FirestoreFileRegistry(db);
    expect(await registry.claim(rec('file-list-1'), null)).toBe(true);
    expect(await registry.claim(rec('file-list-2', { sessionId: 'sess-two' }), null)).toBe(true);
    // A malformed document in the collection (no sessionId) is
    // skipped, never surfaced as a record.
    docs.set('icecream_file_registry/file-malformed', { fileId: 'file-malformed' } as never);
    const all = await registry.listAll();
    expect(all.map((r) => r.fileId).sort()).toEqual(['file-list-1', 'file-list-2']);
    expect(all.find((r) => r.fileId === 'file-list-2')?.sessionId).toBe('sess-two');
  });

  it('concurrent noteParticipant calls keep both entries', async () => {
    const { db } = makeYieldingFakeFirestore();
    const registry = new FirestoreFileRegistry(db);
    expect(await registry.claim(rec('file-participants'), null)).toBe(true);
    const [n1, n2] = await Promise.all([
      registry.noteParticipant('file-participants', 'sess_file-participants', 1, 'user:bob', 'editor'),
      registry.noteParticipant('file-participants', 'sess_file-participants', 1, 'user:carol', 'viewer'),
    ]);
    expect(n1).toBe(true);
    expect(n2).toBe(true);
    const stored = await registry.lookup('file-participants');
    expect(stored?.participants).toMatchObject({ 'user:bob': 'editor', 'user:carol': 'viewer' });
  });
});
