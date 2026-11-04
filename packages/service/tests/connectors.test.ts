/**
 * Connector abstraction tests (packages/service/src/connectors).
 *
 * Covers: spec validation/migration, table normalization, CSV/JSON/REST
 * fixtures, the SQL driver seam, the registry, and refresh swap planning.
 * All network access is faked via injected fetchText — no live HTTP.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_SPEC_VERSION,
  ConnectorRegistry,
  createConnectorRegistry,
  deserializeBindings,
  FakeSqlDriver,
  getPath,
  inferColumnType,
  jsonToTable,
  makeTableData,
  migrateConnectorSpec,
  parseStringMap,
  planSheetRefresh,
  serializeBindings,
  tablePreview,
  tableToWorkbookData,
  uniqueColumns,
  validateConnectorSpec,
  type ConnectorSpec,
  type SourceBinding,
} from '../src/connectors/index.js';

function csvSpec(params: Record<string, string> = {}): ConnectorSpec {
  return {
    version: CONNECTOR_SPEC_VERSION,
    kind: 'csv-url',
    label: 'Test CSV',
    params: { url: 'https://example.com/data.csv', ...params },
  };
}

/** Fake fetchText backed by a URL → body map; records calls. */
function fakeFetch(bodies: Record<string, string>) {
  const calls: Array<{ url: string; init?: { headers?: Record<string, string>; method?: string } }> = [];
  const fetchText = async (url: string, init?: { headers?: Record<string, string>; method?: string }) => {
    calls.push({ url, init });
    const body = bodies[url];
    if (body === undefined) throw new Error(`no fixture for ${url}`);
    return body;
  };
  return { fetchText, calls };
}

// ---------------------------------------------------------------------------
// spec.ts — validation
// ---------------------------------------------------------------------------

describe('validateConnectorSpec', () => {
  it('accepts a valid csv-url spec', () => {
    expect(validateConnectorSpec(csvSpec()).ok).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateConnectorSpec(null).ok).toBe(false);
    expect(validateConnectorSpec('x').ok).toBe(false);
  });

  it('rejects unknown kinds', () => {
    const v = validateConnectorSpec({ ...csvSpec(), kind: 'soap' });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('unknown connector kind');
  });

  it('rejects unsupported versions', () => {
    const v = validateConnectorSpec({ ...csvSpec(), version: 99 });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('unsupported spec version');
  });

  it('requires kind-specific params', () => {
    const v = validateConnectorSpec({ ...csvSpec(), params: {} });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('"url"');
    const sql = validateConnectorSpec({
      version: 1,
      kind: 'sql',
      label: 'db',
      params: { driver: 'fake' },
    });
    expect(sql.ok).toBe(false);
    expect(sql.errors.join(' ')).toContain('"connection"');
  });

  it('rejects non-http(s) URLs', () => {
    const v = validateConnectorSpec(csvSpec({ url: 'file:///etc/passwd' }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('http(s)');
  });

  it('rejects secret-like param keys', () => {
    const v = validateConnectorSpec(csvSpec({ api_key: 'shh' }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('credentialRef');
  });

  it('rejects empty credentialRef', () => {
    const v = validateConnectorSpec({ ...csvSpec(), credentialRef: '  ' });
    expect(v.ok).toBe(false);
  });

  it('rejects non-string param values', () => {
    const v = validateConnectorSpec({ ...csvSpec(), params: { url: 'https://x', n: 5 } } as unknown as ConnectorSpec);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('must be a string');
  });

  it('collects multiple errors at once', () => {
    const v = validateConnectorSpec({ version: 9, kind: 'nope', label: '', params: [] });
    expect(v.errors.length).toBeGreaterThan(2);
  });

  it('rejects blank labels', () => {
    expect(validateConnectorSpec({ ...csvSpec(), label: '  ' }).ok).toBe(false);
  });
});

describe('migrateConnectorSpec', () => {
  it('migrates a v0 (unversioned) spec, defaulting the label', () => {
    const m = migrateConnectorSpec({ kind: 'json-url', params: { url: 'https://x/y.json' } });
    expect(m.version).toBe(CONNECTOR_SPEC_VERSION);
    expect(m.label).toBe('JSON data');
  });

  it('keeps label and credentialRef', () => {
    const m = migrateConnectorSpec({
      kind: 'rest-api',
      label: 'Sales API',
      params: { url: 'https://x' },
      credentialRef: 'vault:api-token',
    });
    expect(m.label).toBe('Sales API');
    expect(m.credentialRef).toBe('vault:api-token');
  });

  it('stringifies non-string params', () => {
    const m = migrateConnectorSpec({ kind: 'csv-url', params: { url: 'https://x', n: 7 } });
    expect(m.params['n']).toBe('7');
  });

  it('throws on unknown kind', () => {
    expect(() => migrateConnectorSpec({ kind: 'carrier-pigeon', params: {} })).toThrow('unknown connector kind');
  });

  it('throws on future versions', () => {
    expect(() => migrateConnectorSpec({ version: 42, kind: 'csv-url', params: {} })).toThrow(
      'cannot migrate spec version',
    );
  });

  it('throws on non-objects', () => {
    expect(() => migrateConnectorSpec(null)).toThrow('must be an object');
  });
});

describe('binding serialization', () => {
  const binding: SourceBinding = {
    id: 'b1',
    sheetName: 'Sales',
    spec: csvSpec(),
    lastRefresh: '2026-10-18T18:00:00.000Z',
    rowCount: 11,
    colCount: 3,
  };

  it('round-trips bindings', () => {
    const back = deserializeBindings(serializeBindings([binding]));
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(binding);
  });

  it('returns [] for corrupt JSON', () => {
    expect(deserializeBindings('not json')).toEqual([]);
    expect(deserializeBindings('{"bindings": 5}')).toEqual([]);
  });

  it('skips unsalvageable entries but keeps good ones', () => {
    const raw = JSON.stringify({
      version: 1,
      bindings: [binding, { sheetName: '', spec: { kind: 'nope', params: {} } }, null],
    });
    const back = deserializeBindings(raw);
    expect(back).toHaveLength(1);
    expect(back[0]?.sheetName).toBe('Sales');
  });

  it('migrates old spec versions inside bindings', () => {
    const raw = JSON.stringify({
      version: 1,
      bindings: [
        { id: 'old', sheetName: 'S', spec: { kind: 'csv-url', params: { url: 'https://x' } }, lastRefresh: null, rowCount: 0, colCount: 0 },
      ],
    });
    const back = deserializeBindings(raw);
    expect(back[0]?.spec.version).toBe(CONNECTOR_SPEC_VERSION);
    expect(back[0]?.spec.label).toBe('CSV data');
  });
});

// ---------------------------------------------------------------------------
// table.ts
// ---------------------------------------------------------------------------

describe('table helpers', () => {
  it('makeTableData pads ragged rows and infers types', () => {
    const t = makeTableData(['a', 'b'], [[1], [2, 'x', 99]]);
    expect(t.rows).toEqual([
      [1, null],
      [2, 'x'],
    ]);
    expect(t.types).toEqual(['number', 'text']);
  });

  it('inferColumnType handles boolean/date/unknown', () => {
    expect(inferColumnType([null, true])).toBe('boolean');
    expect(inferColumnType([null, '2026-10-18'])).toBe('date');
    expect(inferColumnType([null, null])).toBe('unknown');
    expect(inferColumnType(['a', 'b'])).toBe('text');
    expect(inferColumnType(['2026-13-99', 'x'])).toBe('text');
  });

  it('uniqueColumns de-duplicates and names blanks', () => {
    expect(uniqueColumns(['a', 'a', '', 'a'])).toEqual(['a', 'a_2', 'Column3', 'a_3']);
  });

  it('tableToWorkbookData writes header + data rows', () => {
    const wb = tableToWorkbookData(makeTableData(['Name', 'Age'], [['Al', 30]]), 'Src');
    expect(wb.sheets[0]?.name).toBe('Src');
    expect(wb.sheets[0]?.rows).toEqual([
      ['Name', 'Age'],
      ['Al', 30],
    ]);
  });

  it('tablePreview slices rows only', () => {
    const t = makeTableData(['a'], [[1], [2], [3]]);
    const p = tablePreview(t, 2);
    expect(p.rows).toHaveLength(2);
    expect(p.columns).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// csv.ts fixtures
// ---------------------------------------------------------------------------

describe('CsvUrlConnector', () => {
  it('parses a CSV with header and coerces types', async () => {
    const { fetchText } = fakeFetch({
      'https://example.com/data.csv': 'Name,Age,Member\nAlice,30,true\nBob,,false\n',
    });
    const t = await createConnectorRegistry().fetch(csvSpec(), { fetchText });
    expect(t.columns).toEqual(['Name', 'Age', 'Member']);
    expect(t.rows).toEqual([
      ['Alice', 30, true],
      ['Bob', null, false],
    ]);
    expect(t.types).toEqual(['text', 'number', 'boolean']);
  });

  it('auto-detects semicolon delimiters', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/data.csv': 'a;b\n1;2\n' });
    const t = await createConnectorRegistry().fetch(csvSpec(), { fetchText });
    expect(t.columns).toEqual(['a', 'b']);
  });

  it('honors explicit tab delimiter', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/data.csv': 'a\tb\n1\t2\n' });
    const t = await createConnectorRegistry().fetch(csvSpec({ delimiter: 'tab' }), { fetchText });
    expect(t.rows).toEqual([[1, 2]]);
  });

  it('names columns ColumnN when hasHeader=false', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/data.csv': '1,2\n3,4\n' });
    const t = await createConnectorRegistry().fetch(csvSpec({ hasHeader: 'false' }), { fetchText });
    expect(t.columns).toEqual(['Column1', 'Column2']);
    expect(t.rows).toHaveLength(2);
  });

  it('handles quoted fields and drops blank rows', async () => {
    const { fetchText } = fakeFetch({
      'https://example.com/data.csv': 'a,b\n"x, y","say ""hi"""\n\n',
    });
    const t = await createConnectorRegistry().fetch(csvSpec(), { fetchText });
    expect(t.rows).toEqual([['x, y', 'say "hi"']]);
  });

  it('de-duplicates duplicate headers', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/data.csv': 'a,a\n1,2\n' });
    const t = await createConnectorRegistry().fetch(csvSpec(), { fetchText });
    expect(t.columns).toEqual(['a', 'a_2']);
  });

  it('throws on unsupported delimiter names', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/data.csv': 'a,b\n1,2\n' });
    await expect(createConnectorRegistry().fetch(csvSpec({ delimiter: 'star' }), { fetchText })).rejects.toThrow(
      'unsupported CSV delimiter',
    );
  });

  it('returns an empty table for empty input', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/data.csv': '\n' });
    const t = await createConnectorRegistry().fetch(csvSpec(), { fetchText });
    expect(t.columns).toEqual([]);
    expect(t.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// json.ts fixtures
// ---------------------------------------------------------------------------

describe('JsonUrlConnector', () => {
  const spec = (params: Record<string, string>): ConnectorSpec => ({
    version: CONNECTOR_SPEC_VERSION,
    kind: 'json-url',
    label: 'J',
    params: { url: 'https://example.com/api', ...params },
  });

  it('normalizes an array of objects', async () => {
    const { fetchText } = fakeFetch({
      'https://example.com/api': JSON.stringify([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]),
    });
    const t = await createConnectorRegistry().fetch(spec({}), { fetchText });
    expect(t.columns).toEqual(['a', 'b']);
    expect(t.rows).toEqual([
      [1, 'x'],
      [2, 'y'],
    ]);
  });

  it('descends a dot path to the records array', async () => {
    const { fetchText } = fakeFetch({
      'https://example.com/api': JSON.stringify({ data: { items: [{ n: 1 }] } }),
    });
    const t = await createConnectorRegistry().fetch(spec({ path: 'data.items' }), { fetchText });
    expect(t.rows).toEqual([[1]]);
  });

  it('flattens nested objects with dot keys', async () => {
    const { fetchText } = fakeFetch({
      'https://example.com/api': JSON.stringify([{ id: 1, address: { city: 'SF', zip: '94110' } }]),
    });
    const t = await createConnectorRegistry().fetch(spec({}), { fetchText });
    expect(t.columns).toEqual(['id', 'address.city', 'address.zip']);
  });

  it('serializes nested arrays as JSON strings', async () => {
    const { fetchText } = fakeFetch({
      'https://example.com/api': JSON.stringify([{ id: 1, tags: ['a', 'b'] }]),
    });
    const t = await createConnectorRegistry().fetch(spec({}), { fetchText });
    expect(t.rows[0]?.[1]).toBe('["a","b"]');
  });

  it('treats a single object as one row', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/api': JSON.stringify({ a: 1 }) });
    const t = await createConnectorRegistry().fetch(spec({}), { fetchText });
    expect(t.rows).toEqual([[1]]);
  });

  it('flatten=false keeps nested values as JSON strings', async () => {
    const { fetchText } = fakeFetch({
      'https://example.com/api': JSON.stringify([{ id: 1, address: { city: 'SF' } }]),
    });
    const t = await createConnectorRegistry().fetch(spec({ flatten: 'false' }), { fetchText });
    expect(t.columns).toEqual(['id', 'address']);
    expect(t.rows[0]?.[1]).toBe('{"city":"SF"}');
  });

  it('throws when the path is missing', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/api': JSON.stringify({ a: 1 }) });
    await expect(createConnectorRegistry().fetch(spec({ path: 'data.missing' }), { fetchText })).rejects.toThrow(
      'not found',
    );
  });

  it('throws on invalid JSON', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/api': 'nope{' });
    await expect(createConnectorRegistry().fetch(spec({}), { fetchText })).rejects.toThrow('not valid JSON');
  });

  it('getPath supports bracket syntax', () => {
    expect(getPath({ rows: [{ v: 7 }] }, 'rows[0].v')).toBe(7);
    expect(getPath({ a: 1 }, 'b.c')).toBeUndefined();
  });

  it('jsonToTable uses first-seen column order and nulls gaps', () => {
    const t = jsonToTable([{ b: 1 }, { a: 2, b: 3 }], true);
    expect(t.columns).toEqual(['b', 'a']);
    expect(t.rows).toEqual([
      [1, null],
      [3, 2],
    ]);
  });
});

// ---------------------------------------------------------------------------
// rest.ts fixtures
// ---------------------------------------------------------------------------

describe('RestApiConnector', () => {
  const spec = (params: Record<string, string>, credentialRef?: string): ConnectorSpec => ({
    version: CONNECTOR_SPEC_VERSION,
    kind: 'rest-api',
    label: 'API',
    params: { url: 'https://api.example.com/v1/sales', ...params },
    ...(credentialRef ? { credentialRef } : {}),
  });

  it('appends query params and descends path', async () => {
    const { fetchText, calls } = fakeFetch({
      'https://api.example.com/v1/sales?limit=100': JSON.stringify({ rows: [{ id: 1 }] }),
    });
    const t = await createConnectorRegistry().fetch(
      spec({ query: '{"limit":"100"}', path: 'rows' }),
      { fetchText },
    );
    expect(calls[0]?.url).toBe('https://api.example.com/v1/sales?limit=100');
    expect(t.rows).toEqual([[1]]);
  });

  it('forwards extra headers', async () => {
    const { fetchText, calls } = fakeFetch({ 'https://api.example.com/v1/sales': '[{"a":1}]' });
    await createConnectorRegistry().fetch(spec({ headers: '{"X-Tenant":"acme"}' }), { fetchText });
    expect(calls[0]?.init?.headers?.['X-Tenant']).toBe('acme');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('rejects Authorization headers in params', async () => {
    const { fetchText } = fakeFetch({ 'https://api.example.com/v1/sales': '[]' });
    await expect(
      createConnectorRegistry().fetch(spec({ headers: '{"Authorization":"Bearer x"}' }), { fetchText }),
    ).rejects.toThrow('forbidden in params');
  });

  it('sends the vault secret as a Bearer token (never persisted)', async () => {
    const { fetchText, calls } = fakeFetch({ 'https://api.example.com/v1/sales': '[{"a":1}]' });
    const seen: string[] = [];
    const t = await createConnectorRegistry().fetch(spec({}, 'vault:token-1'), {
      fetchText,
      resolveCredential: { resolveCredential: async (ref) => { seen.push(ref); return 's3cret'; } },
    });
    expect(calls[0]?.init?.headers?.['Authorization']).toBe('Bearer s3cret');
    expect(seen).toEqual(['vault:token-1']);
    expect(t.rows).toEqual([[1]]);
  });

  it('fails closed when credentialRef has no resolver', async () => {
    const { fetchText } = fakeFetch({ 'https://api.example.com/v1/sales': '[]' });
    await expect(createConnectorRegistry().fetch(spec({}, 'vault:token-1'), { fetchText })).rejects.toThrow(
      'no credential resolver is wired',
    );
  });

  it('parseStringMap rejects malformed input', () => {
    expect(() => parseStringMap('[1,2]', 'query')).toThrow('must be a JSON object');
    expect(() => parseStringMap('{bad', 'query')).toThrow('must be a JSON object');
    expect(() => parseStringMap('{"a":1}', 'query')).toThrow('must be a string');
    expect(parseStringMap(undefined, 'query')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// sql.ts — driver seam
// ---------------------------------------------------------------------------

describe('SqlConnector', () => {
  const spec = (): ConnectorSpec => ({
    version: CONNECTOR_SPEC_VERSION,
    kind: 'sql',
    label: 'DB',
    params: { driver: 'fake', connection: 'analytics', query: 'SELECT * FROM users' },
  });

  it('fails with a clear error when no driver is wired', async () => {
    await expect(createConnectorRegistry().fetch(spec(), {})).rejects.toThrow('no SQL driver configured');
  });

  it('queries through the injected driver', async () => {
    const driver = new FakeSqlDriver();
    driver.addTable('users', [
      { id: 1, name: 'Al' },
      { id: 2, name: 'Bo' },
    ]);
    const t = await createConnectorRegistry().fetch(spec(), { sqlDriver: driver });
    expect(t.columns).toEqual(['id', 'name']);
    expect(t.rows).toEqual([
      [1, 'Al'],
      [2, 'Bo'],
    ]);
  });

  it('fake driver rejects non-SELECT statements', async () => {
    const driver = new FakeSqlDriver();
    driver.addTable('users', []);
    const bad: ConnectorSpec = {
      ...spec(),
      params: { ...spec().params, query: 'DROP TABLE users' },
    };
    await expect(createConnectorRegistry().fetch(bad, { sqlDriver: driver })).rejects.toThrow('only supports');
  });

  it('fake driver errors on unknown tables', async () => {
    const driver = new FakeSqlDriver();
    await expect(createConnectorRegistry().fetch(spec(), { sqlDriver: driver })).rejects.toThrow(
      'unknown table',
    );
  });

  it('returns an empty table when the query yields no rows', async () => {
    const driver = new FakeSqlDriver();
    driver.addTable('users', []);
    const t = await createConnectorRegistry().fetch(spec(), { sqlDriver: driver });
    expect(t.rows).toEqual([]);
  });

  it('fails fast when credentialRef has no resolver', async () => {
    const driver = new FakeSqlDriver();
    driver.addTable('users', []);
    const s: ConnectorSpec = { ...spec(), credentialRef: 'vault:db' };
    await expect(createConnectorRegistry().fetch(s, { sqlDriver: driver })).rejects.toThrow(
      'no credential resolver is wired',
    );
  });
});

// ---------------------------------------------------------------------------
// registry.ts
// ---------------------------------------------------------------------------

describe('ConnectorRegistry', () => {
  it('ships the seven built-in kinds (incl. the send-only mail connector and google-sheets)', () => {
    expect(createConnectorRegistry().kinds().sort()).toEqual(['csv-url', 'google-sheets', 'json-url', 'mail', 'marketdata', 'rest-api', 'sql']);
  });

  it('rejects duplicate registration', () => {
    const r = createConnectorRegistry();
    expect(() => r.register(r.get('csv-url'))).toThrow('already registered');
  });

  it('throws for unknown kinds', () => {
    expect(() => createConnectorRegistry().get('carrier-pigeon' as never)).toThrow('no connector registered');
  });

  it('validates before fetching (fetchText never called)', async () => {
    const { fetchText, calls } = fakeFetch({});
    await expect(
      createConnectorRegistry().fetch({ ...csvSpec(), params: {} }, { fetchText }),
    ).rejects.toThrow('invalid connector spec');
    expect(calls).toHaveLength(0);
  });

  it('enforces the maxRows cap', async () => {
    const { fetchText } = fakeFetch({ 'https://example.com/data.csv': 'a\n1\n2\n3\n' });
    await expect(createConnectorRegistry().fetch(csvSpec(), { fetchText, maxRows: 2 })).rejects.toThrow(
      'max 2',
    );
  });

  it('accepts custom connector registrations', () => {
    const r = new ConnectorRegistry();
    const custom = {
      kind: 'sheets-api',
      displayName: 'Sheets API',
      paramHelp: 'custom',
      fetch: async () => makeTableData(['z'], [[1]]),
    };
    r.register(custom as never);
    expect(r.kinds()).toEqual(['sheets-api']);
    expect(r.get('sheets-api' as never).displayName).toBe('Sheets API');
  });
});

// ---------------------------------------------------------------------------
// refresh.ts — swap planning
// ---------------------------------------------------------------------------

describe('planSheetRefresh', () => {
  const table = (cols: string[], rows: (string | number | null)[][]) => makeTableData(cols, rows);

  it('open plan: writes header + rows, clears nothing', () => {
    const p = planSheetRefresh(0, 0, table(['a', 'b'], [[1, 'x']]));
    expect(p.writes).toHaveLength(4);
    expect(p.clears).toEqual([]);
    expect(p.rowCount).toBe(2);
    expect(p.colCount).toBe(2);
    expect(p.writes[0]).toEqual({ row: 0, col: 0, value: 'a' });
    expect(p.writes[3]).toEqual({ row: 1, col: 1, value: 'x' });
  });

  it('same-size refresh clears nothing', () => {
    const p = planSheetRefresh(3, 2, table(['a', 'b'], [[1, 2], [3, 4]]));
    expect(p.clears).toEqual([]);
    expect(p.writes).toHaveLength(6);
  });

  it('shrinking rows clears the stale tail', () => {
    const p = planSheetRefresh(4, 2, table(['a', 'b'], [[1, 2]]));
    expect(p.clears).toEqual([
      { row: 2, col: 0 },
      { row: 2, col: 1 },
      { row: 3, col: 0 },
      { row: 3, col: 1 },
    ]);
  });

  it('shrinking columns clears the stale right edge', () => {
    const p = planSheetRefresh(2, 3, table(['a'], [[1]]));
    expect(p.clears).toEqual([
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ]);
  });

  it('growing the table clears nothing and writes everything', () => {
    const p = planSheetRefresh(2, 1, table(['a', 'b', 'c'], [[1, 2, 3], [4, 5, 6]]));
    expect(p.clears).toEqual([]);
    expect(p.writes).toHaveLength(9);
    expect(p.rowCount).toBe(3);
    expect(p.colCount).toBe(3);
  });

  it('empty table clears the whole previous region', () => {
    const p = planSheetRefresh(3, 2, table([], []));
    expect(p.clears).toHaveLength(6);
    expect(p.writes).toHaveLength(0);
    expect(p.rowCount).toBe(1); // header row only
    expect(p.colCount).toBe(0);
  });

  it('never clears outside the previous region', () => {
    // prev region 2x2, new table 2 rows (header+1) x 1 col: only (0,1),(1,1) clear.
    const p = planSheetRefresh(2, 2, table(['a'], [[1]]));
    expect(p.clears.every((c) => c.row < 2 && c.col < 2)).toBe(true);
    expect(p.clears).toEqual([
      { row: 0, col: 1 },
      { row: 1, col: 1 },
    ]);
  });

  it('writes null for missing cells', () => {
    const p = planSheetRefresh(0, 0, table(['a', 'b'], [[null, 'x']]));
    expect(p.writes).toContainEqual({ row: 1, col: 0, value: null });
  });
});
