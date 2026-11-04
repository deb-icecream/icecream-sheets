/**
 * Tests for the at-rest encryption wiring (secureStore.ts):
 * EncryptedPersistence, AsyncMetadataStore, createEncryptedServiceStores and
 * EncryptedWorkbookStore. Round-trips, "stored bytes are ciphertext" checks,
 * tamper/revocation fail-closed behavior, key rotation, and §4
 * password-protected workbooks.
 */
import { describe, expect, it } from 'vitest';
import {
  AsyncMetadataStore,
  EncryptedPersistence,
  EncryptedWorkbookStore,
  KeyManager,
  MetadataStore,
  createEncryptedServiceStores,
  makeChartSpec,
  memoryAsyncPersistence,
  memoryPersistence,
  toAsyncPersistence,
  type AsyncPersistence,
} from '../src/index.js';

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function setup() {
  const inner = memoryPersistence();
  const keys = new KeyManager(memoryPersistence());
  return { inner, keys };
}

async function encryptedSetup(scopeId = 'scope-1') {
  const { inner, keys } = setup();
  const ep = await EncryptedPersistence.create(inner, keys, scopeId);
  return { inner, keys, ep };
}

describe('EncryptedPersistence', () => {
  it('round-trips save → load', async () => {
    const { ep } = await encryptedSetup();
    await ep.save('k', 'workbook metadata payload');
    await expect(ep.load('k')).resolves.toBe('workbook metadata payload');
  });

  it('returns null for a missing key', async () => {
    const { ep } = await encryptedSetup();
    await expect(ep.load('nope')).resolves.toBeNull();
  });

  it('stores ciphertext, not plaintext, in the inner persistence', async () => {
    const { inner, ep } = await encryptedSetup();
    const secret = 'super-secret-cell-values-12345';
    await ep.save('k', secret);
    const raw = inner.load('icecream-sheets.secure.v1/scope-1/k');
    expect(raw).not.toBeNull();
    expect(raw as string).not.toContain(secret);
    const env = JSON.parse(raw as string) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.keyId).toBe('string');
    expect(typeof env.iv).toBe('string');
    expect(typeof env.ciphertext).toBe('string');
    expect(env.salt).toBeUndefined();
  });

  it('fails closed when the stored ciphertext is tampered with', async () => {
    const { inner, ep } = await encryptedSetup();
    await ep.save('k', 'payload');
    const storageKey = 'icecream-sheets.secure.v1/scope-1/k';
    const env = JSON.parse(inner.load(storageKey) as string) as Record<string, string>;
    // Flip a character in the base64 ciphertext (keeps it valid base64).
    const ct = env.ciphertext;
    env.ciphertext = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    inner.save(storageKey, JSON.stringify(env));
    await expect(ep.load('k')).rejects.toThrow(/fail closed/);
  });

  it('fails closed when plaintext is planted under the storage key', async () => {
    const { inner, ep } = await encryptedSetup();
    inner.save('icecream-sheets.secure.v1/scope-1/k', JSON.stringify({ plain: 'data' }));
    await expect(ep.load('k')).rejects.toThrow(/fail closed/);
  });

  it('fails closed after the key is revoked', async () => {
    const { keys, ep } = await encryptedSetup();
    await ep.save('k', 'payload');
    keys.revoke('scope-1');
    await expect(ep.load('k')).rejects.toThrow(/fail closed/);
  });

  it('generates the scope key on first use', async () => {
    const { keys } = setup();
    expect(keys.hasCurrentKey('fresh-scope')).toBe(false);
    await EncryptedPersistence.create(memoryPersistence(), keys, 'fresh-scope');
    expect(keys.hasCurrentKey('fresh-scope')).toBe(true);
  });

  it('rotate(): old payloads still decrypt; new saves use the new key', async () => {
    const { inner, keys, ep } = await encryptedSetup();
    await ep.save('old', 'before rotation');
    const before = JSON.parse(inner.load('icecream-sheets.secure.v1/scope-1/old') as string) as {
      keyId: string;
    };
    const { current, previous } = await ep.rotate();
    expect(current.keyId).not.toBe(previous.keyId);
    // Re-encrypted under the new key…
    const after = JSON.parse(inner.load('icecream-sheets.secure.v1/scope-1/old') as string) as {
      keyId: string;
    };
    expect(after.keyId).toBe(current.keyId);
    expect(before.keyId).toBe(previous.keyId);
    // …and still readable.
    await expect(ep.load('old')).resolves.toBe('before rotation');
    await ep.save('new', 'after rotation');
    const env = JSON.parse(inner.load('icecream-sheets.secure.v1/scope-1/new') as string) as {
      keyId: string;
    };
    expect(env.keyId).toBe(current.keyId);
    // The previous key record is retained for decryption (§7).
    expect(keys.recordsSnapshot().some((r) => r.keyId === previous.keyId && r.status === 'previous')).toBe(true);
  });

  it('rekey() re-encrypts listed keys after an out-of-band rotation', async () => {
    const { inner, keys } = setup();
    const ep = await EncryptedPersistence.create(inner, keys, 'scope-1');
    await ep.save('k', 'payload');
    const before = JSON.parse(inner.load('icecream-sheets.secure.v1/scope-1/k') as string) as {
      keyId: string;
    };
    // Rotate behind the instance's back (simulates a restart).
    const { current } = await keys.rotate('scope-1');
    const ep2 = await EncryptedPersistence.create(inner, keys, 'scope-1');
    // Old envelope still decrypts via the previous key (keyId lookup).
    await expect(ep2.load('k')).resolves.toBe('payload');
    await ep2.rekey(['k']);
    const after = JSON.parse(inner.load('icecream-sheets.secure.v1/scope-1/k') as string) as {
      keyId: string;
    };
    expect(before.keyId).not.toBe(current.keyId);
    expect(after.keyId).toBe(current.keyId);
    await expect(ep2.load('k')).resolves.toBe('payload');
  });

  it('clear() removes the value and untracks it', async () => {
    const { ep } = await encryptedSetup();
    await ep.save('k', 'v');
    expect(ep.listTrackedKeys()).toContain('k');
    await ep.clear('k');
    await expect(ep.load('k')).resolves.toBeNull();
    expect(ep.listTrackedKeys()).not.toContain('k');
  });

  it('rejects empty keys and non-string values', async () => {
    const { ep } = await encryptedSetup();
    await expect(ep.save('', 'v')).rejects.toThrow();
    await expect(ep.load('')).rejects.toThrow();
    // @ts-expect-error runtime check
    await expect(ep.save('k', 42)).rejects.toThrow();
  });
});

describe('memoryAsyncPersistence / toAsyncPersistence', () => {
  it('memoryAsyncPersistence round-trips', async () => {
    const p: AsyncPersistence = memoryAsyncPersistence();
    await p.save('a', 'b');
    await expect(p.load('a')).resolves.toBe('b');
    await p.clear('a');
    await expect(p.load('a')).resolves.toBeNull();
  });

  it('toAsyncPersistence bridges a sync adapter', async () => {
    const p = toAsyncPersistence(memoryPersistence());
    await p.save('a', 'b');
    await expect(p.load('a')).resolves.toBe('b');
  });
});

describe('EncryptedWorkbookStore (§§3, 4, 7)', () => {
  it('round-trips workbook bytes', async () => {
    const { inner, keys } = setup();
    const store = EncryptedWorkbookStore.create(inner, keys);
    const bytes = text('fake-xlsx-bytes:{"sheets":[{"cells":{"A1":42}}}');
    await store.save('wb-1', bytes);
    expect(store.has('wb-1')).toBe(true);
    const out = await store.load('wb-1');
    expect(new TextDecoder().decode(out)).toBe(new TextDecoder().decode(bytes));
  });

  it('stores ciphertext, not plaintext workbook bytes', async () => {
    const { inner, keys } = setup();
    const store = EncryptedWorkbookStore.create(inner, keys);
    const marker = 'PLAINTEXT-MARKER-9f8e7d6c';
    await store.save('wb-1', text(`bytes:${marker}`));
    const raw = inner.load('icecream-sheets.workbooks.v1/wb-1') as string;
    expect(raw).not.toContain(marker);
    const env = JSON.parse(raw) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.keyId).toBe('string');
    expect(typeof env.iv).toBe('string');
    expect(typeof env.ciphertext).toBe('string');
  });

  it('uses a per-workbook key (§7)', async () => {
    const { keys } = setup();
    const store = EncryptedWorkbookStore.create(memoryPersistence(), keys);
    await store.save('wb-a', text('a'));
    await store.save('wb-b', text('b'));
    expect(keys.hasCurrentKey('wb-a')).toBe(true);
    expect(keys.hasCurrentKey('wb-b')).toBe(true);
    const ids = keys.recordsSnapshot().filter((r) => r.status === 'current').map((r) => r.keyId);
    expect(new Set(ids).size).toBe(2);
  });

  it('throws for unknown workbooks', async () => {
    const { inner, keys } = setup();
    const store = EncryptedWorkbookStore.create(inner, keys);
    await expect(store.load('ghost')).rejects.toThrow(/unknown workbook/);
    expect(store.has('ghost')).toBe(false);
  });

  it('password mode: correct password decrypts, wrong/missing password fails (§4)', async () => {
    const { inner, keys } = setup();
    const store = EncryptedWorkbookStore.create(inner, keys);
    await store.save('wb-pw', text('protected content'), { password: 'correct horse battery staple' });
    // The stored envelope carries a salt but never the password.
    const raw = inner.load('icecream-sheets.workbooks.v1/wb-pw') as string;
    expect(raw).not.toContain('correct horse battery staple');
    const env = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof env.salt).toBe('string');
    expect((env.keyId as string).startsWith('pw:')).toBe(true);

    const out = await store.load('wb-pw', { password: 'correct horse battery staple' });
    expect(new TextDecoder().decode(out)).toBe('protected content');
    // The wrong password fails decryption — that failure IS the verifier.
    await expect(store.load('wb-pw', { password: 'wrong password' })).rejects.toThrow(/wrong password/);
    await expect(store.load('wb-pw')).rejects.toThrow(/requires a password/);
  });

  it('rotateKey(): re-encrypts under the new key; reads keep working', async () => {
    const { inner, keys } = setup();
    const store = EncryptedWorkbookStore.create(inner, keys);
    await store.save('wb-1', text('v1 bytes'));
    const before = JSON.parse(inner.load('icecream-sheets.workbooks.v1/wb-1') as string) as {
      keyId: string;
    };
    const { current, previous } = await store.rotateKey('wb-1');
    expect(current.keyId).not.toBe(previous.keyId);
    const after = JSON.parse(inner.load('icecream-sheets.workbooks.v1/wb-1') as string) as {
      keyId: string;
    };
    expect(after.keyId).toBe(current.keyId);
    expect(before.keyId).toBe(previous.keyId);
    const out = await store.load('wb-1');
    expect(new TextDecoder().decode(out)).toBe('v1 bytes');
    // New saves use the new key.
    await store.save('wb-1', text('v2 bytes'));
    const out2 = await store.load('wb-1');
    expect(new TextDecoder().decode(out2)).toBe('v2 bytes');
  });

  it('rotateKey(): password envelopes stay readable with the password', async () => {
    const { inner, keys } = setup();
    const store = EncryptedWorkbookStore.create(inner, keys);
    await store.save('wb-pw', text('protected'), { password: 's3cret' });
    await store.rotateKey('wb-pw');
    const out = await store.load('wb-pw', { password: 's3cret' });
    expect(new TextDecoder().decode(out)).toBe('protected');
  });

  it('revokeKey(): payloads become undecryptable (fail closed)', async () => {
    const { inner, keys } = setup();
    const store = EncryptedWorkbookStore.create(inner, keys);
    await store.save('wb-1', text('bytes'));
    store.revokeKey('wb-1');
    await expect(store.load('wb-1')).rejects.toThrow(/fail closed/);
    // Key material is destroyed.
    expect(keys.recordsSnapshot().every((r) => r.keyB64 === '' && r.status === 'revoked')).toBe(true);
  });

  it('tampered workbook envelope fails closed', async () => {
    const { inner, keys } = setup();
    const store = EncryptedWorkbookStore.create(inner, keys);
    await store.save('wb-1', text('bytes'));
    const sk = 'icecream-sheets.workbooks.v1/wb-1';
    const env = JSON.parse(inner.load(sk) as string) as Record<string, string>;
    const ct = env.ciphertext;
    env.ciphertext = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    inner.save(sk, JSON.stringify(env));
    await expect(store.load('wb-1')).rejects.toThrow(/fail closed/);
  });

  it('delete() removes the payload', async () => {
    const { inner, keys } = setup();
    const store = EncryptedWorkbookStore.create(inner, keys);
    await store.save('wb-1', text('bytes'));
    store.delete('wb-1');
    expect(store.has('wb-1')).toBe(false);
  });
});

describe('createEncryptedServiceStores', () => {
  it('round-trips chart specs through the encrypted layer', async () => {
    const { inner, keys } = setup();
    const stores = await createEncryptedServiceStores(inner, keys);
    const spec = makeChartSpec({
      kind: 'column-clustered',
      title: 'Revenue by quarter — CONFIDENTIAL',
      range: { sheet: 'S1', startRow: 0, startCol: 0, endRow: 9, endCol: 3 },
    });
    await stores.charts.add(spec);
    const all = await stores.charts.all();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Revenue by quarter — CONFIDENTIAL');
    // At rest the spec is an encrypted envelope, not the JSON spec.
    const raw = inner.load('icecream-sheets.secure.v1/__service__/icecream-sheets.charts.v1') as string;
    expect(raw).not.toContain('CONFIDENTIAL');
    expect(raw).not.toContain('column-clustered');
    const env = JSON.parse(raw) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.ciphertext).toBe('string');
  });

  it('persists every store surface and reloads it from a fresh instance', async () => {
    const { inner, keys } = setup();
    const stores = await createEncryptedServiceStores(inner, keys, { agentUserId: 'u1' });
    await stores.pivots.saveAll([]);
    await stores.etlRecipes.saveAll([]);
    await stores.triggers.saveAll([]);
    await stores.addons.saveAll([]);
    await stores.grants.saveAll([]);
    await stores.agentThreads.saveAll([]);
    const stores2 = await createEncryptedServiceStores(inner, keys, { agentUserId: 'u1' });
    await expect(stores2.pivots.all()).resolves.toEqual([]);
    await expect(stores2.etlRecipes.all()).resolves.toEqual([]);
    await expect(stores2.triggers.all()).resolves.toEqual([]);
    await expect(stores2.addons.all()).resolves.toEqual([]);
    await expect(stores2.grants.all()).resolves.toEqual([]);
    await expect(stores2.agentThreads.all()).resolves.toEqual([]);
  });

  it('agent threads are namespaced per user', async () => {
    const { inner, keys } = setup();
    const a = await createEncryptedServiceStores(inner, keys, { agentUserId: 'alice' });
    const b = await createEncryptedServiceStores(inner, keys, { agentUserId: 'bob' });
    expect(inner.load('icecream-sheets.secure.v1/__service__/icecream-sheets.agent-threads.v1.alice')).toBeNull();
    await a.agentThreads.saveAll([]);
    await expect(b.agentThreads.all()).resolves.toEqual([]);
  });

  it('uses a custom scope id when provided', async () => {
    const { keys } = setup();
    await createEncryptedServiceStores(memoryPersistence(), keys, { scopeId: 'tenant-9' });
    expect(keys.hasCurrentKey('tenant-9')).toBe(true);
  });
});

describe('AsyncMetadataStore (durable-store migration step 1)', () => {
  interface Item {
    id: number;
    name: string;
  }
  const KEY = 'test.async-store.v1';
  const ser = (items: Item[]): string => JSON.stringify(items);
  const de = (json: string): Item[] => {
    try {
      const v: unknown = JSON.parse(json);
      return Array.isArray(v) ? (v as Item[]) : [];
    } catch {
      return [];
    }
  };
  const mk = (p: AsyncPersistence) => new AsyncMetadataStore<Item>(KEY, p, ser, de);
  const item = (id: number): Item => ({ id, name: `n${id}` });

  it('round-trips saveAll -> all over an async adapter', async () => {
    const store = mk(memoryAsyncPersistence());
    await expect(store.all()).resolves.toEqual([]);
    await store.saveAll([item(1), item(2)]);
    await expect(store.all()).resolves.toEqual([item(1), item(2)]);
  });

  it('add appends and remove drops by predicate with a count', async () => {
    const store = mk(memoryAsyncPersistence());
    await store.add(item(1));
    await store.add(item(2));
    await store.add(item(3));
    await expect(store.all()).resolves.toHaveLength(3);
    const removed = await store.remove((i) => i.id !== 2);
    expect(removed).toBe(2);
    await expect(store.all()).resolves.toEqual([item(2)]);
  });

  it('clear drops cache and persisted bytes; invalidate forces re-read', async () => {
    const p = memoryAsyncPersistence();
    const store = mk(p);
    await store.saveAll([item(1)]);
    await store.clear();
    await expect(store.all()).resolves.toEqual([]);
    await expect(p.load(KEY)).resolves.toBeNull();
    // invalidate: an external write becomes visible on next all()
    await store.saveAll([item(9)]);
    await p.save(KEY, ser([item(7)]));
    await expect(store.all()).resolves.toEqual([item(9)]); // cached
    store.invalidate();
    await expect(store.all()).resolves.toEqual([item(7)]); // re-read
  });

  it('tolerates a corrupt persisted payload as empty', async () => {
    const p = memoryAsyncPersistence();
    await p.save(KEY, 'not-json{{{');
    await expect(mk(p).all()).resolves.toEqual([]);
  });

  it('is key-compatible with the sync MetadataStore over a bridged adapter', async () => {
    // Migration premise: a store flipped from sync to async must see the
    // same rows. Same storage key + same ser/de over one underlying adapter.
    const inner = memoryPersistence();
    const sync = new MetadataStore<Item>(KEY, inner, ser, de);
    const asyncStore = mk(toAsyncPersistence(inner));
    sync.saveAll([item(1), item(2)]);
    await expect(asyncStore.all()).resolves.toEqual([item(1), item(2)]);
    await asyncStore.add(item(3));
    // Both stores cache after first read; invalidate the sync store so it
    // re-reads the rows the async store wrote (same caching rule both ways).
    sync.invalidate();
    expect(sync.all()).toEqual([item(1), item(2), item(3)]);
  });

  it('does not disturb unrelated keys or the sync seam', async () => {
    const inner = memoryPersistence();
    const asyncStore = mk(toAsyncPersistence(inner));
    const other = new MetadataStore<Item>('other.key', inner, ser, de);
    other.saveAll([item(5)]);
    await asyncStore.saveAll([item(1)]);
    expect(other.all()).toEqual([item(5)]);
    expect(inner.load('other.key')).toBe(ser([item(5)]));
  });
});
