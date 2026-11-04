/**
 * ETL source reader tests (design-docs/etl-pipeline.md §2):
 * CSV/JSON/URL via the fetch component, connector sources via the
 * connector SDK + vault reference (never a secret in recipe bytes).
 */
import { describe, expect, it } from 'vitest';
import {
  adaptEtlConnector,
  ConnectorRegistry,
  createConnectorRegistry,
  csvTextToTable,
  jsonTextToTable,
  readSource,
  serviceVaultResolver,
  type CredentialResolver,
  type EtlConnector,
  type EtlSource,
} from '../src/index.js';

const deps = { fetchText: async () => { throw new Error('no fetch in this test'); } };

describe('csvTextToTable', () => {
  it('parses headers and rows', () => {
    const t = csvTextToTable('Name,Age\nAlice,30\nBob,25');
    expect(t.columns.map((c) => c.name)).toEqual(['Name', 'Age']);
    expect(t.rows).toEqual([
      { Name: 'Alice', Age: '30' },
      { Name: 'Bob', Age: '25' },
    ]);
  });

  it('handles quoted fields with commas and escaped quotes', () => {
    const t = csvTextToTable('a,b\n"x, y","say ""hi"""');
    expect(t.rows[0]).toEqual({ a: 'x, y', b: 'say "hi"' });
  });

  it('auto-detects semicolon delimiters', () => {
    const t = csvTextToTable('a;b;c\n1;2;3');
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates blank/duplicate headers', () => {
    const t = csvTextToTable('a,,a\n1,2,3');
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'Column2', 'a_2']);
  });

  it('supports headerless input', () => {
    const t = csvTextToTable('1,2\n3,4', ',', false);
    expect(t.columns.map((c) => c.name)).toEqual(['Column1', 'Column2']);
    expect(t.rows).toHaveLength(2);
  });

  it('returns an empty table for blank input', () => {
    expect(csvTextToTable('\n\n').rows).toHaveLength(0);
  });

  it('rejects unknown delimiters', () => {
    expect(() => csvTextToTable('a,b', ':')).toThrow(/unsupported CSV delimiter/);
  });
});

describe('jsonTextToTable', () => {
  it('parses an array of objects with unioned keys', () => {
    const t = jsonTextToTable('[{"a":1,"b":"x"},{"a":2,"c":true}]');
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(t.rows[0]).toEqual({ a: 1, b: 'x', c: null });
    expect(t.rows[1]).toEqual({ a: 2, b: null, c: true });
  });

  it('accepts { data: [...] } wrappers', () => {
    const t = jsonTextToTable('{"data":[{"a":1}]}');
    expect(t.rows).toEqual([{ a: 1 }]);
  });

  it('rejects invalid JSON and non-object arrays', () => {
    expect(() => jsonTextToTable('nope')).toThrow(/not valid JSON/);
    expect(() => jsonTextToTable('[1,2,3]')).toThrow(/must contain objects/);
    expect(() => jsonTextToTable('{"a":1}')).toThrow(/array of objects/);
  });

  it('stringifies nested values', () => {
    const t = jsonTextToTable('[{"a":{"x":1}}]');
    expect(typeof t.rows[0]['a']).toBe('string');
  });
});

describe('readSource url', () => {
  it('auto-detects JSON vs CSV', async () => {
    const json = await readSource(
      { type: 'url', url: 'https://x/data', format: 'auto' },
      { fetchText: async () => '[{"a":1}]' },
    );
    expect(json.rows).toEqual([{ a: 1 }]);

    const csv = await readSource(
      { type: 'url', url: 'https://x/data.csv', format: 'auto' },
      { fetchText: async () => 'a,b\n1,2' },
    );
    expect(csv.columns.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('propagates fetch failures (transient, retried by the runner)', async () => {
    await expect(
      readSource({ type: 'url', url: 'https://x/down', format: 'auto' }, {
        fetchText: async () => { throw new Error('socket hang up'); },
      }),
    ).rejects.toThrow(/socket hang up/);
  });
});

describe('connector sources', () => {
  const fakeConnector: EtlConnector = {
    id: 'fake-crm',
    displayName: 'Fake CRM',
    authenticate: async (ref, vault) => {
      const secret = await vault.resolveCredential(ref);
      if (secret !== 's3cr3t') throw new Error('bad credentials');
      return { connectorId: 'fake-crm', state: { authed: true } };
    },
    describeSchema: async () => [
      { name: 'id', type: 'number' },
      { name: 'name', type: 'text' },
    ],
    extract: async (session, opts) => {
      if (!(session.state as { authed: boolean }).authed) throw new Error('not authed');
      if (opts.cursor === 'page2') {
        return {
          columns: [],
          rows: [{ id: 3, name: 'C' }],
        };
      }
      return {
        columns: [],
        rows: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
        nextCursor: 'page2',
      };
    },
  };

  // Single-registry resolution (2026-10-18): ETL source nodes consume the
  // canonical connector registry; SDK-style connectors register via
  // adaptEtlConnector().
  const registry: ConnectorRegistry = createConnectorRegistry();
  registry.register(adaptEtlConnector(fakeConnector));
  const vault: CredentialResolver = { resolveCredential: async (ref) => (ref === 'vault://crm' ? 's3cr3t' : 'wrong') };

  it('extracts with pagination until the cursor is exhausted', async () => {
    const source: EtlSource = {
      type: 'connector', connectorId: 'fake-crm', credentialRef: 'vault://crm',
    };
    const t = await readSource(source, { ...deps, connectors: registry, vault });
    expect(t.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(t.rows).toHaveLength(3);
  });

  it('never sees the secret — only the vault reference', async () => {
    const source: EtlSource = {
      type: 'connector', connectorId: 'fake-crm', credentialRef: 'vault://crm',
    };
    // The recipe JSON contains the ref, not the secret.
    expect(JSON.stringify(source)).not.toContain('s3cr3t');
    expect(JSON.stringify(source)).toContain('vault://crm');
    await readSource(source, { ...deps, connectors: registry, vault });
  });

  it('fails when the vault has no credential', async () => {
    const source: EtlSource = {
      type: 'connector', connectorId: 'fake-crm', credentialRef: 'vault://missing',
    };
    await expect(readSource(source, { ...deps, connectors: registry, vault })).rejects.toThrow();
  });

  it('requires a registry and vault', async () => {
    const source: EtlSource = {
      type: 'connector', connectorId: 'fake-crm', credentialRef: 'vault://crm',
    };
    await expect(readSource(source, deps)).rejects.toThrow(/no connector registry/);
    await expect(readSource(source, { ...deps, connectors: registry })).rejects.toThrow(/no credential vault/);
  });

  it('rejects duplicate connector registration', async () => {
    expect(() => registry.register(adaptEtlConnector(fakeConnector))).toThrow(/already registered/);
    await expect(
      registry.fetch(
        { version: 1, kind: 'nope' as never, label: 'x', params: {} },
        { resolveCredential: async () => 's3cr3t' },
      ),
    ).rejects.toThrow(/unknown connector kind|no connector registered/);
  });
});

describe('serviceVaultResolver', () => {
  it('adapts the service vault to the resolver surface', async () => {
    const fakeVault = { retrieve: async (ref: string, requester: string) => `${requester}:${ref}:secret` };
    const resolver = serviceVaultResolver(fakeVault as never, 'debajyoti');
    await expect(resolver.resolveCredential('vault://crm')).resolves.toBe('debajyoti:vault://crm:secret');
  });
});
