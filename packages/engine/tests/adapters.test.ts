/**
 * Tests for the adapter registry (track 9).
 */
import { describe, expect, it } from 'vitest';
import { AdapterRegistry, defaultAdapters } from '../src/adapters.js';
import type { StorageAdapter, WorkbookData } from '../src/storage.js';

function fakeAdapter(name: string): StorageAdapter {
  return {
    name,
    capabilities: {
      readable: true,
      writable: true,
      transactional: false,
      preservesUnknownParts: false,
      supportsEncryption: false,
    },
    read: (): WorkbookData => ({ sheets: [], metadata: {} }),
    write: () => new Uint8Array(),
  };
}

describe('AdapterRegistry', () => {
  it('resolves by extension', () => {
    const r = new AdapterRegistry();
    const a = fakeAdapter('xlsx');
    r.register({ adapter: a, extensions: ['xlsx'] });
    expect(r.forExtension('xlsx')).toBe(a);
    expect(r.forExtension('.XLSX')).toBe(a);
  });

  it('resolves by filename', () => {
    const r = new AdapterRegistry();
    const a = fakeAdapter('csv');
    r.register({ adapter: a, extensions: ['csv', 'tsv'] });
    expect(r.forFilename('data.csv')).toBe(a);
    expect(r.forFilename('data.tsv')).toBe(a);
    expect(r.forFilename('nodot')).toBeUndefined();
  });

  it('resolves by name', () => {
    const r = new AdapterRegistry();
    const a = fakeAdapter('ods');
    r.register({ adapter: a, extensions: ['ods'] });
    expect(r.forName('ODS')).toBe(a);
  });

  it('first registration wins for an extension', () => {
    const r = new AdapterRegistry();
    const a = fakeAdapter('a');
    const b = fakeAdapter('b');
    r.register({ adapter: a, extensions: ['csv'] });
    r.register({ adapter: b, extensions: ['csv'] });
    expect(r.forExtension('csv')).toBe(a);
  });

  it('unregister removes the adapter', () => {
    const r = new AdapterRegistry();
    r.register({ adapter: fakeAdapter('x'), extensions: ['x'] });
    expect(r.unregister('x')).toBe(true);
    expect(r.forName('x')).toBeUndefined();
    expect(r.unregister('x')).toBe(false);
  });

  it('rejects duplicate names', () => {
    const r = new AdapterRegistry();
    r.register({ adapter: fakeAdapter('dup'), extensions: ['d1'] });
    expect(() => r.register({ adapter: fakeAdapter('dup'), extensions: ['d2'] })).toThrow('already registered');
  });

  it('default registry exists', () => {
    expect(defaultAdapters.names()).toEqual([]);
  });
});
