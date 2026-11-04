// @vitest-environment jsdom
/**
 * Open Data Source Gallery dialog tests (CONTRACT.md):
 * - gallery template cards render (CSV/JSON as ONE card with a format
 *   select, REST API, SQL database, Google Sheets);
 * - SCHEMA PREVIEW (columns + types + row count) appears after Test and
 *   BEFORE Open is enabled;
 * - SQL flow: connection stored → tables listed → pick a table →
 *   declared schema via /sql/schema;
 * - secrets are stored via the connectors service BEFORE any fetch,
 *   and the opened spec carries only the credentialRef;
 * - VAULT-SEAM: the marker secret entered through both the REST and
 *   SQL flows appears NOWHERE in localStorage, persisted bindings
 *   JSON, or captured console output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import { serializeBindings } from '@icecream-sheets/service/connectors';
import type { ConnectorSpec, TableData } from '../features/dataSources';
import OpenDataSourceDialog, { type ConnectorGateway } from './OpenDataSourceDialog';

const MARKER = 'TESTSECRET-ds-gallery-7f3a';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let consoleLines: string[] = [];
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

function setup(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
}

beforeEach(() => {
  localStorage.clear();
  consoleLines = [];
  consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => String(a)).join(' '));
    }),
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  consoleSpies.forEach((s) => s.mockRestore());
});

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(container!.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text || b.textContent?.includes(text),
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

async function click(text: string): Promise<void> {
  const btn = buttonByText(text);
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

function fieldByLabel(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const rows = Array.from(container!.querySelectorAll('.dialog-row'));
  for (const row of rows) {
    const span = row.querySelector('span');
    if (span?.textContent === label) {
      const el = row.querySelector('input, textarea, select');
      if (el) return el as HTMLInputElement;
    }
  }
  throw new Error(`field not found: ${label}`);
}

function setField(label: string, value: string): void {
  const el = fieldByLabel(label);
  act(() => {
    Simulate.change(el, { target: { value } } as unknown as Parameters<typeof Simulate.change>[1]);
  });
}

function localStorageDump(): string {
  const parts: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) as string;
    parts.push(k, localStorage.getItem(k) ?? '');
  }
  return parts.join('\n');
}

interface MockGateway extends ConnectorGateway {
  calls: string[];
}

function mockGateway(overrides: Partial<ConnectorGateway> & { calls?: string[] } = {}): MockGateway {
  const calls = overrides.calls ?? [];
  return {
    calls,
    connectorsStoreCredential: async (name: string) => {
      calls.push('storeCredential');
      return { ok: true as const, ref: `user:test:ds:rest:${name}` };
    },
    connectorsStoreSqlConnection: async (connection: string) => {
      calls.push('storeSqlConnection');
      return { ok: true as const, ref: `user:test:ds:sql:${connection}` };
    },
    connectorsSqlTables: async () => {
      calls.push('sqlTables');
      return {
        ok: true as const,
        tables: [
          { name: 'sales', type: 'table' },
          { name: 'products', type: 'table' },
        ],
      };
    },
    connectorsSqlSchema: async (_connection: string, table: string) => {
      calls.push('sqlSchema');
      return {
        ok: true as const,
        table,
        columns: [
          { name: 'order_id', type: 'INTEGER', notnull: false, pk: true },
          { name: 'region', type: 'TEXT', notnull: true, pk: false },
          { name: 'revenue', type: 'REAL', notnull: false, pk: false },
        ],
        rowCount: 24,
      };
    },
    ...overrides,
  } as MockGateway;
}

const CSV_TEXT = 'order_id,region,revenue\n1001,North,19.98\n1002,South,39.98\n';

describe('OpenDataSourceDialog gallery', () => {
  it('renders the four gallery template cards, CSV/JSON as one card with a format select', () => {
    setup(h(OpenDataSourceDialog, { onClose: () => {}, onOpen: () => {} }));
    const text = container!.textContent ?? '';
    expect(text).toContain('CSV / JSON URL');
    expect(text).toContain('REST API');
    expect(text).toContain('SQL database');
    expect(text).toContain('Google Sheets');
    const format = fieldByLabel('Format') as HTMLSelectElement;
    expect(Array.from(format.options).map((o) => o.textContent)).toEqual(['CSV', 'JSON']);
  });

  it('local mode disables secret fields with a gateway hint', async () => {
    setup(h(OpenDataSourceDialog, { onClose: () => {}, onOpen: () => {} }));
    await click('REST API');
    const token = fieldByLabel('API token') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(token.disabled).toBe(true);
    expect(container!.textContent).toMatch(/gateway mode/i);
  });

  it('CSV: schema preview (columns + types + row count) shows before Open is enabled', async () => {
    let opened: { spec: ConnectorSpec; table: TableData } | null = null;
    setup(
      h(OpenDataSourceDialog, {
        onClose: () => {},
        onOpen: (spec: ConnectorSpec, table: TableData) => {
          opened = { spec, table };
        },
        connectorDeps: { fetchText: async () => CSV_TEXT },
      }),
    );
    setField('URL', 'http://127.0.0.1:8199/sales.csv');
    const openBtn = buttonByText('Open');
    expect(openBtn.disabled).toBe(true); // no schema preview yet
    await click('Test connection & preview schema');
    const text = container!.textContent ?? '';
    expect(text).toContain('Schema preview');
    expect(text).toContain('2 rows');
    // Column | Type rows from the fetched table's inferred types.
    const schemaTable = container!.querySelector('table.ds-schema');
    expect(schemaTable?.textContent).toContain('order_id');
    expect(schemaTable?.textContent).toContain('number');
    expect(schemaTable?.textContent).toContain('region');
    expect(schemaTable?.textContent).toContain('text');
    // Sample rows remain below the schema.
    expect(text).toContain('North');
    expect(buttonByText('Open').disabled).toBe(false);
    await click('Open');
    expect(opened).not.toBeNull();
    expect(opened!.spec.kind).toBe('csv-url');
    expect(opened!.table.rows).toHaveLength(2);
  });
});

describe('OpenDataSourceDialog REST flow + vault seam', () => {
  it('stores the API token BEFORE fetching; the spec carries only the ref; the marker leaks nowhere', async () => {
    const order: string[] = [];
    const seenAuth: string[] = [];
    const gateway = mockGateway({ calls: order });
    let opened: { spec: ConnectorSpec; table: TableData } | null = null;
    setup(
      h(OpenDataSourceDialog, {
        onClose: () => {},
        onOpen: (spec: ConnectorSpec, table: TableData) => {
          opened = { spec, table };
        },
        gateway,
        connectorDeps: {
          resolveCredential: {
            resolveCredential: async (ref: string) => {
              order.push('resolveCredential');
              expect(ref).toBe('user:test:ds:rest:api-token');
              return MARKER;
            },
          },
          fetchText: async (_url: string, init?: { headers?: Record<string, string> }) => {
            order.push('fetch');
            if (init?.headers?.['Authorization']) seenAuth.push(init.headers['Authorization']);
            return JSON.stringify({ records: [{ order_id: 1, revenue: 10 }] });
          },
        },
      }),
    );
    await click('REST API');
    setField('URL', 'http://127.0.0.1:8199/api/sales');
    setField('Path', 'records');
    setField('API token', MARKER);
    await click('Test connection & preview schema');

    // Store happened strictly before the fetch, and the resolved secret
    // reached the endpoint as a Bearer header (transient use only).
    expect(order[0]).toBe('storeCredential');
    expect(order.indexOf('fetch')).toBeGreaterThan(order.indexOf('storeCredential'));
    expect(seenAuth).toEqual([`Bearer ${MARKER}`]);
    expect(container!.textContent).toContain('Schema preview');

    await click('Open');
    expect(opened).not.toBeNull();
    expect(opened!.spec.credentialRef).toBe('user:test:ds:rest:api-token');
    expect(JSON.stringify(opened!.spec)).not.toContain(MARKER);

    // VAULT SEAM: persist the binding exactly like App does, then hunt
    // for the marker in storage, the bindings JSON, console, and DOM.
    const bindingsJson = serializeBindings([
      {
        id: 'API data',
        sheetName: 'API data',
        spec: opened!.spec,
        lastRefresh: new Date().toISOString(),
        rowCount: 2,
        colCount: 2,
      },
    ]);
    localStorage.setItem('test.bindings', bindingsJson);
    expect(bindingsJson).not.toContain(MARKER);
    expect(localStorageDump()).not.toContain(MARKER);
    expect(consoleLines.join('\n')).not.toContain(MARKER);
    expect(container!.textContent ?? '').not.toContain(MARKER);
  });
});

describe('OpenDataSourceDialog SQL flow + vault seam', () => {
  it('stores the connection, lists tables, previews the declared schema; the connection string leaks nowhere', async () => {
    const order: string[] = [];
    const gateway = mockGateway({ calls: order });
    let opened: { spec: ConnectorSpec; table: TableData } | null = null;
    const connectionString = `sqlite:///tmp/${MARKER}.db`;
    setup(
      h(OpenDataSourceDialog, {
        onClose: () => {},
        onOpen: (spec: ConnectorSpec, table: TableData) => {
          opened = { spec, table };
        },
        gateway,
        connectorDeps: {
          resolveCredential: {
            resolveCredential: async () => connectionString,
          },
          sqlDriver: {
            id: 'sqlite',
            query: async () => {
              order.push('sqlQuery');
              return [{ order_id: 1001, region: 'North', revenue: 19.98 }];
            },
          },
        },
      }),
    );
    await click('SQL database');
    setField('Connection', 'sales-fixture');
    setField('Connection string', connectionString);
    await click('Test connection & preview schema');

    // Connection stored before the tables list was requested.
    expect(order[0]).toBe('storeSqlConnection');
    expect(order.indexOf('sqlTables')).toBeGreaterThan(0);
    // Tables listed for picking.
    expect(container!.textContent).toContain('sales');
    expect(container!.textContent).toContain('products');

    await click('sales');
    expect(order).toContain('sqlSchema');
    // Declared schema (types from PRAGMA table_info) + row count.
    const schemaTable = container!.querySelector('table.ds-schema');
    expect(schemaTable?.textContent).toContain('order_id');
    expect(schemaTable?.textContent).toContain('INTEGER');
    expect(schemaTable?.textContent).toContain('region');
    expect(schemaTable?.textContent).toContain('TEXT');
    expect(container!.textContent).toContain('24 rows');
    // The query auto-filled from the picked table.
    const queryField = fieldByLabel('Query') as HTMLTextAreaElement;
    expect(queryField.value).toBe('SELECT * FROM "sales"');

    await click('Open');
    expect(opened).not.toBeNull();
    expect(opened!.spec.kind).toBe('sql');
    expect(opened!.spec.params['connection']).toBe('sales-fixture');
    expect(opened!.spec.credentialRef).toBe('user:test:ds:sql:sales-fixture');
    expect(JSON.stringify(opened!.spec)).not.toContain(MARKER);

    // VAULT SEAM for the SQL flow.
    const bindingsJson = serializeBindings([
      {
        id: 'SQL data',
        sheetName: 'SQL data',
        spec: opened!.spec,
        lastRefresh: new Date().toISOString(),
        rowCount: 2,
        colCount: 3,
      },
    ]);
    localStorage.setItem('test.bindings', bindingsJson);
    expect(bindingsJson).not.toContain(MARKER);
    expect(localStorageDump()).not.toContain(MARKER);
    expect(consoleLines.join('\n')).not.toContain(MARKER);
    expect(container!.textContent ?? '').not.toContain(MARKER);
  });
});
