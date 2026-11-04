/**
 * Tests for the prod Firestore trigger store (triggers program,
 * 2026-10-22 scope ruling): the write-through bridge in
 * automation/hostFirestore.ts over a fake AsyncPersistence, the
 * 1 MiB cap through FirestoreMetadataPersistence with the triggers
 * collection (persistence layer directly — named in the test), and
 * the prodTriggerConfig fail-closed matrix. Fake-based, established
 * style (see firestoreMetadata.test.ts). The local/file-backed path
 * is covered unchanged by automationTriggerHost/automationTriggers.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import type { AsyncPersistence } from '../src/secureStore.js';
import { SessionTriggerHost } from '../src/automation/node.js';
import { TRIGGER_GRANTS_KEY } from '../src/automation/host.js';
import { TRIGGER_STORE_KEY } from '../src/automation/triggerSpecs.js';
import {
  TRIGGER_METADATA_COLLECTION,
  createProdTriggerScopePersistence,
  createTriggerScopePersistence,
  prodTriggerConfig,
} from '../src/automation/hostFirestore.js';
import {
  FirestoreMetadataPersistence,
  MCP_METADATA_COLLECTION,
  MCP_METADATA_DOC_CAP_BYTES,
  type FirestoreDbLike,
  type FirestoreDocLike,
} from '../src/firestoreMetadata.js';

const WRITE_PERMS = [
  { action: 'cell.write', target: 'Sheet1!1,0' },
  { action: 'cell.read', target: 'Sheet1!0,0' },
];

function edit(host: EngineHost, row = 0, col = 0, value: unknown = 1) {
  host.execute({
    cmd: 'setCell',
    ref: { sheet: 'Sheet1', row, col },
    value: value as never,
    auth: { principal: 'user' },
  });
}

/** Toggleable fake AsyncPersistence (in-memory map). */
function fakeAsyncPersistence() {
  const map = new Map<string, string>();
  const state = { failSave: false };
  const persistence: AsyncPersistence = {
    load: async (k) => map.get(k) ?? null,
    save: async (k, v) => {
      if (state.failSave) throw new Error('firestore write unavailable');
      map.set(k, v);
    },
    clear: async (k) => {
      map.delete(k);
    },
  };
  return { persistence, map, state };
}

describe('TRIGGER_STORE_KEY', () => {
  it('is the established store key string', () => {
    expect(TRIGGER_STORE_KEY).toBe('icecream-sheets.triggers.v1');
    expect(TRIGGER_METADATA_COLLECTION).toBe('icecream_trigger_metadata');
  });
});

describe('createTriggerScopePersistence (write-through bridge)', () => {
  it('round trip: create + grant -> flush -> brand-new facade + host lists spec AND grant, and the granted trigger FIRES without re-granting', async () => {
    const scope = 'file-firestore-1';
    const backend = fakeAsyncPersistence();

    const scoped1 = await createTriggerScopePersistence(
      { persistence: backend.persistence },
      scope,
    );
    const host1 = new SessionTriggerHost({ persistence: scoped1.persistence, scope });
    const created = host1.create({
      name: 'stamp',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 42);',
      permissions: WRITE_PERMS,
    });
    host1.grant(created.id, 'alice');
    await scoped1.flush();

    // Both scoped keys landed in the async store.
    const rawSpecs = await backend.persistence.load(`${scope}::${TRIGGER_STORE_KEY}`);
    expect(rawSpecs).not.toBeNull();
    expect(rawSpecs).toContain('stamp');
    const rawGrants = await backend.persistence.load(`${scope}::${TRIGGER_GRANTS_KEY}`);
    expect(rawGrants).not.toBeNull();
    const grantRecords = JSON.parse(rawGrants!) as Array<{
      triggerId: string;
      grantedBy: string;
    }>;
    expect(grantRecords).toHaveLength(1);
    expect(grantRecords[0]!.triggerId).toBe(created.id);
    expect(grantRecords[0]!.grantedBy).toBe('alice');

    // Simulated instance restart: brand-new facade + host, same backend.
    const scoped2 = await createTriggerScopePersistence(
      { persistence: backend.persistence },
      scope,
    );
    const host2 = new SessionTriggerHost({ persistence: scoped2.persistence, scope });
    const listed = host2.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);
    expect(listed[0]!.name).toBe('stamp');
    expect(listed[0]!.granted).toBe(true);
    expect(host2.isGranted(created.id)).toBe(true);
    expect(host2.grantRecords()).toHaveLength(1);

    // The granted trigger fires against a real EngineHost, no re-grant.
    const engine = new EngineHost();
    host2.attach(engine);
    edit(engine, 0, 0, 10);
    expect(engine.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 42,
    });
    expect(host2.list()[0]!.lastRun!.ok).toBe(true);
    host2.detach();
    await scoped2.flush();
  });

  it('scope isolation: two scopes over one backend do not leak', async () => {
    const backend = fakeAsyncPersistence();
    const a = await createTriggerScopePersistence({ persistence: backend.persistence }, 'scope-a');
    const b = await createTriggerScopePersistence({ persistence: backend.persistence }, 'scope-b');
    const hostA = new SessionTriggerHost({ persistence: a.persistence, scope: 'scope-a' });
    hostA.create({
      name: 'only-a',
      event: 'onEdit',
      script: 'api.notify("a");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    await a.flush();
    const hostB = new SessionTriggerHost({ persistence: b.persistence, scope: 'scope-b' });
    expect(hostB.list()).toEqual([]);
    await b.flush();
  });

  it('hydration honesty: load/save/clear of an unhydrated key throws loudly', async () => {
    const scope = 'file-honest';
    const backend = fakeAsyncPersistence();
    const scoped = await createTriggerScopePersistence(
      { persistence: backend.persistence },
      scope,
    );
    expect(() =>
      scoped.persistence.load(`${scope}::icecream-sheets.charts.v1`),
    ).toThrow(/unhydrated key/);
    expect(() => scoped.persistence.load('totally-other-key')).toThrow(/unhydrated/);
    expect(() =>
      scoped.persistence.save(`${scope}::icecream-sheets.charts.v1`, 'x'),
    ).toThrow(/unhydrated key/);
    expect(() =>
      scoped.persistence.clear(`${scope}::icecream-sheets.charts.v1`),
    ).toThrow(/unhydrated key/);
    // The hydrated keys read as their seeded serializations, not errors.
    expect(scoped.persistence.load(`${scope}::${TRIGGER_STORE_KEY}`)).toContain(
      '"triggers":[]',
    );
    expect(scoped.persistence.load(`${scope}::${TRIGGER_GRANTS_KEY}`)).toBe('[]');
  });

  it('failure loudness: a rejecting save makes flush() reject, poisons the next flush, and a later successful write to the same key clears the poison', async () => {
    const scope = 'file-failing';
    const backend = fakeAsyncPersistence();
    const scoped = await createTriggerScopePersistence(
      { persistence: backend.persistence },
      scope,
    );
    const host = new SessionTriggerHost({ persistence: scoped.persistence, scope });

    backend.state.failSave = true;
    host.create({
      name: 'doomed',
      event: 'onEdit',
      script: 'api.notify("x");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    await expect(scoped.flush()).rejects.toThrow('firestore write unavailable');
    // Poisoned: a second flush rejects too (the error is not swallowed).
    await expect(scoped.flush()).rejects.toThrow('firestore write unavailable');

    // A later successful write to the same key clears the poison.
    backend.state.failSave = false;
    host.create({
      name: 'recovery',
      event: 'onEdit',
      script: 'api.notify("y");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    await expect(scoped.flush()).resolves.toBeUndefined();
    expect(
      await backend.persistence.load(`${scope}::${TRIGGER_STORE_KEY}`),
    ).toContain('recovery');
  });
});

describe('FirestoreMetadataPersistence with the triggers collection (persistence layer, cap)', () => {
  function fakeDb() {
    const docs = new Map<string, Record<string, unknown>>();
    const collectionsSeen: string[] = [];
    const db: FirestoreDbLike = {
      collection(name: string) {
        collectionsSeen.push(name);
        return {
          doc(id: string): FirestoreDocLike {
            const fullKey = `${name}/${id}`;
            return {
              get: async () => ({
                exists: docs.has(fullKey),
                data: () => docs.get(fullKey),
              }),
              set: async (data: Record<string, unknown>) => {
                docs.set(fullKey, data);
                return undefined;
              },
              delete: async () => {
                docs.delete(fullKey);
                return undefined;
              },
            };
          },
        };
      },
    };
    return { db, docs, collectionsSeen };
  }

  it('uses the triggers collection when constructed with it, and MCP collection by default', async () => {
    const { db, collectionsSeen } = fakeDb();
    const triggerPersistence = new FirestoreMetadataPersistence(
      db,
      TRIGGER_METADATA_COLLECTION,
    );
    expect(triggerPersistence.collection).toBe(TRIGGER_METADATA_COLLECTION);
    await triggerPersistence.save('k', 'v');
    await expect(triggerPersistence.load('k')).resolves.toBe('v');
    expect(collectionsSeen).toContain(TRIGGER_METADATA_COLLECTION);

    const mcpPersistence = new FirestoreMetadataPersistence(db);
    expect(mcpPersistence.collection).toBe(MCP_METADATA_COLLECTION);
    await mcpPersistence.save('k2', 'v2');
    expect(collectionsSeen).toContain(MCP_METADATA_COLLECTION);
  });

  it('rejects an over-cap save loudly and writes nothing (1 MiB cap, persistence layer)', async () => {
    const { db, docs } = fakeDb();
    const p = new FirestoreMetadataPersistence(db, TRIGGER_METADATA_COLLECTION);
    const tooBig = 'x'.repeat(MCP_METADATA_DOC_CAP_BYTES + 1);
    await expect(p.save('big', tooBig)).rejects.toThrow(/exceeding.*document cap/);
    expect(docs.size).toBe(0);
    await expect(p.load('big')).resolves.toBeNull();
  });
});

describe('prodTriggerConfig (fail-closed matrix)', () => {
  it('throws when GCP_PROJECT_ID is missing or blank', () => {
    expect(() => prodTriggerConfig({})).toThrow(/GCP_PROJECT_ID/);
    expect(() => prodTriggerConfig({})).toThrow(/fail closed/);
    expect(() => prodTriggerConfig({ GCP_PROJECT_ID: '   ' })).toThrow(/GCP_PROJECT_ID/);
  });

  it('returns the project (and database when set) when configured', () => {
    expect(prodTriggerConfig({ GCP_PROJECT_ID: 'my-project' })).toEqual({
      projectId: 'my-project',
    });
    expect(
      prodTriggerConfig({ GCP_PROJECT_ID: 'p', FIRESTORE_DATABASE_ID: 'mydb' }),
    ).toEqual({ projectId: 'p', databaseId: 'mydb' });
  });

  it('createProdTriggerScopePersistence rejects fail-closed before any client work when GCP_PROJECT_ID is missing', async () => {
    await expect(createProdTriggerScopePersistence({}, 'file-1')).rejects.toThrow(
      /GCP_PROJECT_ID/,
    );
  });
});

describe('createTriggerScopePersistence extraKeys (supervisor integration)', () => {
  it('extra key round-trips: save -> flush -> brand-new facade reads it back', async () => {
    const scope = 'file-extra-1';
    const extraKey = `${scope}::icecream-sheets.trigger-open-fired.v1`;
    const backend = fakeAsyncPersistence();

    const scoped1 = await createTriggerScopePersistence(
      { persistence: backend.persistence },
      scope,
      { extraKeys: [extraKey] },
    );
    // Absent = known-but-empty.
    expect(scoped1.persistence.load(extraKey)).toBeNull();
    scoped1.persistence.save(extraKey, JSON.stringify({ sessionId: 'sess-1' }));
    await scoped1.flush();
    expect(backend.map.get(extraKey)).toBe(JSON.stringify({ sessionId: 'sess-1' }));

    const scoped2 = await createTriggerScopePersistence(
      { persistence: backend.persistence },
      scope,
      { extraKeys: [extraKey] },
    );
    expect(scoped2.persistence.load(extraKey)).toBe(JSON.stringify({ sessionId: 'sess-1' }));
  });

  it('a key that was NOT hydrated still throws, even when extraKeys were given', async () => {
    const scope = 'file-extra-2';
    const backend = fakeAsyncPersistence();
    const scoped = await createTriggerScopePersistence(
      { persistence: backend.persistence },
      scope,
      { extraKeys: [`${scope}::icecream-sheets.trigger-open-fired.v1`] },
    );
    expect(() => scoped.persistence.load(`${scope}::some-other-key`)).toThrow(/unhydrated key/);
    expect(() => scoped.persistence.save(`${scope}::some-other-key`, 'x')).toThrow(/unhydrated key/);
  });

  it('extra keys colliding with the standard store keys are ignored (no double hydration)', async () => {
    const scope = 'file-extra-3';
    const backend = fakeAsyncPersistence();
    const scoped = await createTriggerScopePersistence(
      { persistence: backend.persistence },
      scope,
      { extraKeys: [`${scope}::${TRIGGER_STORE_KEY}`, `${scope}::${TRIGGER_GRANTS_KEY}`] },
    );
    expect(scoped.persistence.load(`${scope}::${TRIGGER_STORE_KEY}`)).toContain('triggers');
    expect(scoped.persistence.load(`${scope}::${TRIGGER_GRANTS_KEY}`)).toBe('[]');
  });
});

describe('createTriggerScopePersistence refresh() (cross-process pickup)', () => {
  it('refresh re-hydrates specs written by another facade over the same backend', async () => {
    const scope = 'file-refresh-1';
    const backend = fakeAsyncPersistence();
    const a = await createTriggerScopePersistence({ persistence: backend.persistence }, scope);
    const b = await createTriggerScopePersistence({ persistence: backend.persistence }, scope);
    const key = `${scope}::${TRIGGER_STORE_KEY}`;
    expect(b.persistence.load(key)).toContain('"triggers":[]');
    // A writes a spec through its facade and flushes.
    a.persistence.save(
      key,
      JSON.stringify({
        version: 1,
        triggers: [
          {
            id: 'trigger-r1',
            name: 'from-a',
            event: 'onEdit',
            language: 'javascript',
            script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 1);',
            permissions: [],
            enabled: true,
            createdAt: '2026-10-22T00:00:00.000Z',
            updatedAt: '2026-10-22T00:00:00.000Z',
          },
        ],
      }),
    );
    await a.flush();
    // B's hydrated cache is stale until refresh.
    expect(b.persistence.load(key)).not.toContain('trigger-r1');
    await b.refresh();
    expect(b.persistence.load(key)).toContain('trigger-r1');
  });
});
