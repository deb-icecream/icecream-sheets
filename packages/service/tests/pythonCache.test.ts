/**
 * Tests for the PY() content-addressed result cache + dependency-graph
 * invalidation (packages/service/src/python/cache.ts). Browser-safe module:
 * no Node imports, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  PyDependencyIndex,
  PythonResultCache,
  pythonCacheKey,
  sha256Hex,
} from '../src/python/cache.js';
import { memoryPersistence } from '../src/metadataStore.js';
import { KeyManager } from '../src/crypto.js';
import { SERVICE_SCOPE_ID } from '../src/secureStore.js';

function keys() {
  return new KeyManager(memoryPersistence());
}

const ENCRYPTED_CACHE_KEY = `icecream-sheets.secure.v1/${SERVICE_SCOPE_ID}/icecream-sheets.py-cache.v1`;

describe('sha256Hex', () => {
  it('matches known vectors', async () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is deterministic and input-sensitive', async () => {
    expect(sha256Hex('py1')).toBe(sha256Hex('py1'));
    expect(sha256Hex('py1')).not.toBe(sha256Hex('py2'));
  });
});

describe('pythonCacheKey', () => {
  it('is deterministic for identical inputs', async () => {
    const k1 = pythonCacheKey('envA', 'result = 1', '[]');
    expect(pythonCacheKey('envA', 'result = 1', '[]')).toBe(k1);
  });
  it('changes when code, args or env change', async () => {
    const base = pythonCacheKey('envA', 'result = 1', '[]');
    expect(pythonCacheKey('envA', 'result = 2', '[]')).not.toBe(base);
    expect(pythonCacheKey('envA', 'result = 1', '[1]')).not.toBe(base);
    expect(pythonCacheKey('envB', 'result = 1', '[]')).not.toBe(base);
  });
});

function entry(key: string, value: unknown, plot?: string) {
  return {
    key,
    value,
    ...(plot ? { plot } : {}),
    envFingerprint: 'envA',
    codeHash: 'codehash',
    ranAt: new Date().toISOString(),
  };
}

describe('PythonResultCache', () => {
  it('set/get round-trips values and plots', async () => {
    const c = new PythonResultCache();
    await c.set(entry('k1', 42));
    await c.set(entry('k2', [1, 2], 'iVBORw0KGgoAAA'));
    expect(c.get('k1')?.value).toBe(42);
    expect(c.get('k2')?.plot).toBe('iVBORw0KGgoAAA');
    expect(c.get('missing')).toBeUndefined();
  });

  it('evicts oldest-first past maxEntries (LRU)', async () => {
    const c = new PythonResultCache({ maxEntries: 2 });
    await c.set(entry('k1', 1));
    await c.set(entry('k2', 2));
    c.get('k1'); // touch k1 -> k2 is now oldest
    await c.set(entry('k3', 3));
    expect(c.get('k2')).toBeUndefined();
    expect(c.get('k1')?.value).toBe(1);
    expect(c.get('k3')?.value).toBe(3);
  });

  it('evicts past maxBytes', async () => {
    const c = new PythonResultCache({ maxBytes: 1024 });
    await c.set(entry('big', 'x'.repeat(2000)));
    await c.set(entry('small', 1));
    expect(c.get('big')).toBeUndefined();
    expect(c.get('small')?.value).toBe(1);
  });

  it('invalidate drops matching entries and reports the count', async () => {
    const c = new PythonResultCache();
    await c.set({ ...entry('a', 1), envFingerprint: 'envA' });
    await c.set({ ...entry('b', 2), envFingerprint: 'envB' });
    expect(await c.invalidate((e) => e.envFingerprint === 'envA')).toBe(1);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')?.value).toBe(2);
    expect(await c.invalidate()).toBe(1);
    expect(c.size()).toBe(0);
  });

  it('persists across instances via encrypted Persistence (warm start)', async () => {
    const p = memoryPersistence();
    const k = keys();
    const c1 = await PythonResultCache.create({ persistence: p, keys: k });
    await c1.set(entry('k1', { deep: [1, 2, 3] }));
    const c2 = await PythonResultCache.create({ persistence: p, keys: k });
    expect(c2.get('k1')?.value).toEqual({ deep: [1, 2, 3] });
  });

  it('stored bytes are ciphertext, not plaintext', async () => {
    const p = memoryPersistence();
    const c = await PythonResultCache.create({ persistence: p, keys: keys() });
    await c.set(entry('k1', 'classified-result-value'));
    const raw = p.load(ENCRYPTED_CACHE_KEY);
    expect(raw).not.toBeNull();
    expect(raw as string).not.toContain('classified-result-value');
    const env = JSON.parse(raw as string) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.ciphertext).toBe('string');
  });

  it('tolerates corrupt persisted payloads', async () => {
    const p = memoryPersistence();
    p.save(ENCRYPTED_CACHE_KEY, 'not-json{{{');
    const c = await PythonResultCache.create({ persistence: p, keys: keys() });
    expect(c.size()).toBe(0);
    await c.set(entry('k1', 1));
    expect(c.get('k1')?.value).toBe(1);
  });
});

describe('PyDependencyIndex', () => {
  it('reports code-changed addresses as stale', async () => {
    const idx = new PyDependencyIndex();
    idx.noteEvaluated('Sheet1!A1', 'result = 1', 'cachekey-1');
    idx.noteEvaluated('Sheet1!A2', 'result = 2', 'cachekey-2');
    const stale = idx.staleAddresses(
      new Map([
        ['Sheet1!A1', 'result = 1'],
        ['Sheet1!A2', 'result = 3'], // edited
      ]),
    );
    expect(stale).toEqual([
      { addressKey: 'Sheet1!A2', cacheKey: 'cachekey-2', reason: 'code-changed' },
    ]);
  });

  it('reports removed formulas as stale', async () => {
    const idx = new PyDependencyIndex();
    idx.noteEvaluated('Sheet1!A1', 'result = 1', 'cachekey-1');
    const stale = idx.staleAddresses(new Map());
    expect(stale).toEqual([
      { addressKey: 'Sheet1!A1', cacheKey: 'cachekey-1', reason: 'formula-removed' },
    ]);
  });

  it('is quiet when nothing changed', async () => {
    const idx = new PyDependencyIndex();
    idx.noteEvaluated('Sheet1!A1', 'result = 1', 'cachekey-1');
    expect(idx.staleAddresses(new Map([['Sheet1!A1', 'result = 1']]))).toEqual([]);
  });

  it('drop/clear forget addresses', async () => {
    const idx = new PyDependencyIndex();
    idx.noteEvaluated('Sheet1!A1', 'result = 1', 'k1');
    idx.noteEvaluated('Sheet1!A2', 'result = 2', 'k2');
    idx.drop('Sheet1!A1');
    expect(idx.size()).toBe(1);
    idx.clear();
    expect(idx.size()).toBe(0);
    expect(idx.staleAddresses(new Map())).toEqual([]);
  });
});
