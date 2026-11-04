/**
 * "Open data source" gallery — the CORE ARCHITECTURE entry point: the
 * spreadsheet is a VIEW over any data source, not a file editor. An Excel
 * file is just one data source; here the user connects CSV/JSON over HTTP,
 * a REST API, a SQL database, or Google Sheets through a connector.
 *
 * Flow: pick a gallery template card → enter params → "Test connection
 * & preview schema" (fetches through the real connector and shows the
 * SCHEMA — column names + types + row count — BEFORE anything opens) →
 * Open (the table is materialized as a new sheet in the engine's typed
 * computational view, and the connector spec is persisted as a source
 * binding for Refresh).
 *
 * Credentials (CONTRACT.md, idea-datasource-gallery): secrets are typed
 * into password fields and sent EXACTLY ONCE to the gateway connectors
 * service, which stores them in the vault under a principal-derived
 * ref. The spec carries only the returned credentialRef — the secret
 * never persists in the spec, in bindings, or in localStorage. In local
 * (non-gateway) mode the secret fields are disabled with a hint; public
 * sources still work and SQL shows the connector's no-driver error.
 */
import { useMemo, useState } from 'react';
import A11yDialog from './A11yDialog';
import {
  CONNECTOR_SPEC_VERSION,
  createConnectorRegistry,
  tablePreview,
  validateConnectorSpec,
  type ConnectorDeps,
  type ConnectorKind,
  type ConnectorSpec,
  type TableData,
} from '../features/dataSources';
import type { GatewayClient } from '../services/gatewayClient';

/** The gateway surface the dialog uses (GatewayClient satisfies this). */
export type ConnectorGateway = Pick<
  GatewayClient,
  'connectorsStoreCredential' | 'connectorsStoreSqlConnection' | 'connectorsSqlTables' | 'connectorsSqlSchema'
>;

interface OpenDataSourceDialogProps {
  onClose: () => void;
  onOpen: (spec: ConnectorSpec, table: TableData) => void;
  /** Gateway client when running in gateway mode; null in local mode. */
  gateway?: ConnectorGateway | null;
  /** Deps for registry.fetch (credential resolver + SQL driver). */
  connectorDeps?: ConnectorDeps;
}

type Template = 'url' | 'rest-api' | 'sql' | 'google-sheets';

const TEMPLATES: Array<{ template: Template; label: string; blurb: string }> = [
  { template: 'url', label: 'CSV / JSON URL', blurb: 'Fetch a CSV or JSON file over HTTP.' },
  { template: 'rest-api', label: 'REST API', blurb: 'GET a REST endpoint, optionally with a vault-stored API token.' },
  { template: 'sql', label: 'SQL database', blurb: 'Run a read query against a SQLite database via the connectors service.' },
  { template: 'google-sheets', label: 'Google Sheets', blurb: 'Read a range from a Google Sheet (the IMPORTRANGE connector).' },
];

const TEMPLATE_HELP: Record<Template, string> = {
  url: 'Fetch a CSV/TSV or JSON file over HTTP. Headers become column names; nested JSON objects flatten to dot-notation columns.',
  'rest-api': 'GET a REST endpoint; authenticate with an API token stored in the vault (sent once, never persisted here).',
  sql: 'Store the connection string in the vault, list its tables, preview the schema, then open a table. Only read queries run.',
  'google-sheets':
    'Read a range from a Google Sheet through the Sheets API v4 (the connector behind IMPORTRANGE). ' +
    'Authenticate with an OAuth2 token or API key via the vault credential reference below.',
};

interface SchemaColumn {
  name: string;
  type: string;
}

interface SchemaPreview {
  columns: SchemaColumn[];
  rowCount: number;
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="dialog-row" style={{ alignItems: 'flex-start' }}>
      <span style={{ paddingTop: 4 }}>{label}</span>
      <div style={{ flex: 1 }}>
        {children}
        {hint && <div className="dialog-hint" style={{ marginTop: 4, marginBottom: 0 }}>{hint}</div>}
      </div>
    </div>
  );
}

export default function OpenDataSourceDialog({
  onClose,
  onOpen,
  gateway = null,
  connectorDeps,
}: OpenDataSourceDialogProps) {
  const [template, setTemplate] = useState<Template>('url');
  const [urlFormat, setUrlFormat] = useState<'csv' | 'json'>('csv');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [delimiter, setDelimiter] = useState('auto');
  const [hasHeader, setHasHeader] = useState(true);
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const [headers, setHeaders] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [tokenName, setTokenName] = useState('api-token');
  const [driver, setDriver] = useState('sqlite');
  const [connection, setConnection] = useState('');
  const [connectionString, setConnectionString] = useState('');
  const [sql, setSql] = useState('SELECT * FROM ');
  const [sqlParams, setSqlParams] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [sheetId, setSheetId] = useState('');
  const [sheetRange, setSheetRange] = useState('Sheet1!A1:Z1000');
  const [sheetAuth, setSheetAuth] = useState('oauth2');
  const [testing, setTesting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<TableData | null>(null);
  const [schema, setSchema] = useState<SchemaPreview | null>(null);
  const [tables, setTables] = useState<{ name: string; type: string }[] | null>(null);
  const [selectedTable, setSelectedTable] = useState('');

  const registry = useMemo(() => createConnectorRegistry(), []);
  const gatewayMode = gateway !== null && gateway !== undefined;

  const kind: ConnectorKind =
    template === 'url' ? (urlFormat === 'csv' ? 'csv-url' : 'json-url') : template;

  const resetResults = () => {
    setPreview(null);
    setSchema(null);
    setError('');
  };

  const buildSpec = (storedRef?: string, queryOverride?: string): ConnectorSpec => {
    const params: Record<string, string> = {};
    if (kind === 'csv-url') {
      params['url'] = url.trim();
      if (delimiter !== 'auto') params['delimiter'] = delimiter;
      params['hasHeader'] = hasHeader ? 'true' : 'false';
    } else if (kind === 'json-url') {
      params['url'] = url.trim();
      if (path.trim()) params['path'] = path.trim();
    } else if (kind === 'rest-api') {
      params['url'] = url.trim();
      if (path.trim()) params['path'] = path.trim();
      if (query.trim()) params['query'] = query.trim();
      if (headers.trim()) params['headers'] = headers.trim();
    } else if (kind === 'google-sheets') {
      params['spreadsheetId'] = sheetId.trim();
      params['range'] = sheetRange.trim();
      if (sheetAuth !== 'oauth2') params['auth'] = sheetAuth;
    } else {
      params['driver'] = driver.trim() || 'sqlite';
      params['connection'] = connection.trim();
      params['query'] = (queryOverride ?? sql).trim();
      if (sqlParams.trim()) params['params'] = sqlParams.trim();
    }
    const spec: ConnectorSpec = {
      version: CONNECTOR_SPEC_VERSION,
      kind,
      label: label.trim() || registry.get(kind).displayName,
      params,
    };
    const ref = storedRef ?? credentialRef.trim();
    if (ref) spec.credentialRef = ref;
    return spec;
  };

  /**
   * Store any entered secret via the connectors service BEFORE any
   * fetch, and return the vault ref the spec should carry. The secret
   * itself never lands in the spec. Local mode: no secret can be
   * entered (fields disabled), so this is a no-op there.
   */
  const storeSecretFirst = async (): Promise<string | undefined> => {
    if (!gatewayMode) return undefined;
    if (kind === 'rest-api' && apiToken !== '') {
      const { ref } = await gateway.connectorsStoreCredential(tokenName.trim() || 'api-token', apiToken, 'rest');
      return ref;
    }
    if (kind === 'sql' && connectionString !== '') {
      const { ref } = await gateway.connectorsStoreSqlConnection(connection.trim(), connectionString);
      return ref;
    }
    return undefined;
  };

  const validationErrors = useMemo(() => {
    try {
      return validateConnectorSpec(buildSpec()).errors;
    } catch {
      return ['could not build spec'];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, label, url, delimiter, hasHeader, path, query, headers, driver, connection, sql, sqlParams, credentialRef, sheetId, sheetRange, sheetAuth]);

  /** SQL: after the connection is stored, load one table's declared schema + sample rows. */
  const loadSqlSchema = async (tableName: string, storedRef?: string) => {
    if (!gatewayMode) return;
    const schemaRes = await gateway.connectorsSqlSchema(connection.trim(), tableName);
    setSchema({
      columns: schemaRes.columns.map((c) => ({ name: c.name, type: c.type })),
      rowCount: schemaRes.rowCount,
    });
    const spec = buildSpec(storedRef, `SELECT * FROM "${tableName.replace(/"/g, '""')}"`);
    const v = validateConnectorSpec(spec);
    if (v.ok) {
      const table = await registry.fetch(spec, connectorDeps);
      setPreview(tablePreview(table, 8));
    }
  };

  const pickTable = async (tableName: string) => {
    setSelectedTable(tableName);
    setSql(`SELECT * FROM "${tableName.replace(/"/g, '""')}"`);
    setError('');
    try {
      await loadSqlSchema(tableName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runTest = async () => {
    setTesting(true);
    setError('');
    setPreview(null);
    setSchema(null);
    try {
      // Secrets go to the vault FIRST; the spec carries only the ref.
      const storedRef = await storeSecretFirst();
      const spec = buildSpec(storedRef);
      const v = validateConnectorSpec(spec);
      if (!v.ok) throw new Error(v.errors.join('; '));

      if (kind === 'sql' && gatewayMode) {
        // SQL flow: connection stored → list tables → (pick a table) →
        // declared schema. With a table already picked, refresh its schema.
        const { tables: found } = await gateway.connectorsSqlTables(connection.trim());
        setTables(found);
        if (selectedTable && found.some((t) => t.name === selectedTable)) {
          await loadSqlSchema(selectedTable, storedRef);
        }
        return;
      }

      const table = await registry.fetch(spec, connectorDeps);
      setSchema({
        columns: table.columns.map((c, i) => ({ name: c, type: table.types[i] ?? 'unknown' })),
        rowCount: table.rows.length,
      });
      setPreview(tablePreview(table, 8));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const runOpen = async () => {
    setOpening(true);
    setError('');
    try {
      const storedRef = await storeSecretFirst();
      const spec = buildSpec(storedRef);
      const v = validateConnectorSpec(spec);
      if (!v.ok) throw new Error(v.errors.join('; '));
      const table = await registry.fetch(spec, connectorDeps);
      onOpen(spec, table);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  const inputStyle = { width: '100%' } as const;
  const localSecretHint = gatewayMode
    ? undefined
    : 'Available in gateway mode: sign in through the gateway to store credentials in the vault. Public sources work without one.';

  return (
    <A11yDialog title={<>Open data source</>} width={720} onClose={onClose}>
        <div className="dialog-hint">
          Connect a live data source. Its data opens as a sheet in the grid — formulas, charts and
          pivots work over it like any other sheet. Use Refresh to re-fetch later.
        </div>

        <div
          className="dialog-row"
          role="listbox"
          aria-label="Data source templates"
          style={{ flexWrap: 'wrap', gap: 8 }}
        >
          {TEMPLATES.map((t) => (
            <button
              key={t.template}
              role="option"
              aria-selected={template === t.template}
              className={template === t.template ? 'tab-active' : ''}
              onClick={() => { setTemplate(t.template); resetResults(); setTables(null); setSelectedTable(''); }}
              style={{ textAlign: 'left', padding: '8px 10px', maxWidth: 200 }}
            >
              <strong>{t.label}</strong>
              <div className="dialog-hint" style={{ margin: 0 }}>{t.blurb}</div>
            </button>
          ))}
        </div>
        <div className="dialog-hint">{TEMPLATE_HELP[template]}</div>

        <Row label="Label">
          <input
            type="text"
            value={label}
            style={inputStyle}
            placeholder={registry.get(kind).displayName}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Row>

        {template === 'url' && (
          <Row label="Format">
            <select
              aria-label="URL format"
              value={urlFormat}
              onChange={(e) => { setUrlFormat(e.target.value as 'csv' | 'json'); resetResults(); }}
            >
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
          </Row>
        )}

        {kind !== 'sql' && kind !== 'google-sheets' && (
          <Row label="URL" hint="http(s) only.">
            <input
              type="text"
              value={url}
              style={inputStyle}
              placeholder="https://example.com/data.csv"
              onChange={(e) => setUrl(e.target.value)}
            />
          </Row>
        )}

        {kind === 'google-sheets' && (
          <>
            <Row
              label="Spreadsheet"
              hint="The Sheets id, or a full https://docs.google.com/spreadsheets/d/<id>/… URL."
            >
              <input
                type="text"
                value={sheetId}
                style={inputStyle}
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
                onChange={(e) => setSheetId(e.target.value)}
              />
            </Row>
            <Row label="Range" hint='A1 notation, e.g. "Sheet1!A1:D50".'>
              <input
                type="text"
                value={sheetRange}
                style={inputStyle}
                onChange={(e) => setSheetRange(e.target.value)}
              />
            </Row>
            <Row label="Auth" hint="How the vault credential is sent to the Sheets API.">
              <select value={sheetAuth} onChange={(e) => setSheetAuth(e.target.value)}>
                <option value="oauth2">OAuth2 access token (Bearer)</option>
                <option value="apikey">API key (key= parameter)</option>
              </select>
            </Row>
          </>
        )}

        {kind === 'csv-url' && (
          <>
            <Row label="Delimiter">
              <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                <option value="auto">Auto-detect</option>
                <option value="comma">Comma</option>
                <option value="tab">Tab</option>
                <option value="semicolon">Semicolon</option>
                <option value="pipe">Pipe</option>
              </select>
            </Row>
            <Row label="Header">
              <label>
                <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />{' '}
                First row is the header
              </label>
            </Row>
          </>
        )}

        {(kind === 'json-url' || kind === 'rest-api') && (
          <Row label="Path" hint='Dot/bracket path to the records, e.g. "data.items". Empty = document root.'>
            <input
              type="text"
              value={path}
              style={inputStyle}
              placeholder="data.items"
              onChange={(e) => setPath(e.target.value)}
            />
          </Row>
        )}

        {kind === 'rest-api' && (
          <>
            <Row label="Query" hint='JSON object, e.g. {"limit":"100"}.'>
              <input
                type="text"
                value={query}
                style={inputStyle}
                placeholder='{"limit":"100"}'
                onChange={(e) => setQuery(e.target.value)}
              />
            </Row>
            <Row label="Headers" hint='JSON object of extra headers. Never put secrets here — use the API token below.'>
              <input
                type="text"
                value={headers}
                style={inputStyle}
                placeholder='{"X-Tenant":"acme"}'
                onChange={(e) => setHeaders(e.target.value)}
              />
            </Row>
            <Row label="Token name" hint="Name the stored credential is kept under in the vault.">
              <input
                type="text"
                value={tokenName}
                style={inputStyle}
                disabled={!gatewayMode}
                placeholder="api-token"
                onChange={(e) => setTokenName(e.target.value)}
              />
            </Row>
            <Row
              label="API token"
              hint={localSecretHint ?? 'Optional. Stored in the vault before fetching; the data source keeps only a reference to it.'}
            >
              <input
                type="password"
                value={apiToken}
                style={inputStyle}
                disabled={!gatewayMode}
                autoComplete="off"
                placeholder={gatewayMode ? 'Bearer token (optional)' : 'Gateway mode only'}
                onChange={(e) => setApiToken(e.target.value)}
              />
            </Row>
          </>
        )}

        {kind === 'sql' && (
          <>
            <Row label="Driver" hint="Driver id registered by the host (sqlite ships in this build).">
              <input type="text" value={driver} style={inputStyle} onChange={(e) => setDriver(e.target.value)} />
            </Row>
            <Row label="Connection" hint="Connection NAME. The connection string itself is stored in the vault under this name, never in the spec.">
              <input type="text" value={connection} style={inputStyle} placeholder="sales-fixture" onChange={(e) => setConnection(e.target.value)} />
            </Row>
            <Row
              label="Connection string"
              hint={localSecretHint ?? 'sqlite://<path>, sqlite:<path>, or a bare absolute path. Stored in the vault before testing; never persisted in the spec.'}
            >
              <input
                type="password"
                value={connectionString}
                style={inputStyle}
                disabled={!gatewayMode}
                autoComplete="off"
                placeholder={gatewayMode ? 'sqlite:///path/to/data.db' : 'Gateway mode only'}
                onChange={(e) => setConnectionString(e.target.value)}
              />
            </Row>
            {tables && (
              <Row label="Tables" hint="Pick a table to preview its declared schema.">
                <div role="listbox" aria-label="Database tables">
                  {tables.map((t) => (
                    <button
                      key={t.name}
                      role="option"
                      aria-selected={selectedTable === t.name}
                      className={selectedTable === t.name ? 'tab-active' : ''}
                      onClick={() => void pickTable(t.name)}
                      style={{ marginRight: 6 }}
                    >
                      {t.name}
                    </button>
                  ))}
                  {tables.length === 0 && <span className="dialog-hint">No tables found.</span>}
                </div>
              </Row>
            )}
            <Row label="Query">
              <textarea
                value={sql}
                style={{ ...inputStyle, minHeight: 64, fontFamily: 'monospace' }}
                onChange={(e) => setSql(e.target.value)}
              />
            </Row>
            <Row label="Params" hint='JSON array of bound parameters, e.g. ["2026-01-01"].'>
              <input type="text" value={sqlParams} style={inputStyle} onChange={(e) => setSqlParams(e.target.value)} />
            </Row>
          </>
        )}

        <Row
          label="Credential ref"
          hint="Optional opaque vault reference for an already-stored credential (e.g. user:you:ds:rest:api-token). Secrets are never stored in the spec."
        >
          <input
            type="text"
            value={credentialRef}
            style={inputStyle}
            placeholder="vault:…"
            onChange={(e) => setCredentialRef(e.target.value)}
          />
        </Row>

        {validationErrors.length > 0 && (
          <div className="dialog-hint" style={{ color: 'var(--danger, #c00)' }}>
            {validationErrors.join('; ')}
          </div>
        )}
        {error && (
          <div className="dialog-hint" style={{ color: 'var(--danger, #c00)' }}>
            {error}
          </div>
        )}

        {schema && (
          <div style={{ marginTop: 8, overflowX: 'auto' }} aria-label="Schema preview">
            <div className="dialog-hint">
              Schema preview — {schema.rowCount} row{schema.rowCount === 1 ? '' : 's'}
            </div>
            <table className="ds-schema" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ border: '1px solid var(--border, #ccc)', padding: '2px 6px', textAlign: 'left' }}>Column</th>
                  <th style={{ border: '1px solid var(--border, #ccc)', padding: '2px 6px', textAlign: 'left' }}>Type</th>
                </tr>
              </thead>
              <tbody>
                {schema.columns.map((c) => (
                  <tr key={c.name}>
                    <td style={{ border: '1px solid var(--border, #ccc)', padding: '2px 6px' }}>{c.name}</td>
                    <td style={{ border: '1px solid var(--border, #ccc)', padding: '2px 6px' }}>{c.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {preview && (
          <div style={{ marginTop: 8, overflowX: 'auto' }}>
            <div className="dialog-hint">
              Preview — first {preview.rows.length} row{preview.rows.length === 1 ? '' : 's'}
            </div>
            <table className="pq-preview" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c} style={{ border: '1px solid var(--border, #ccc)', padding: '2px 6px', textAlign: 'left' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} style={{ border: '1px solid var(--border, #ccc)', padding: '2px 6px' }}>
                        {v === null ? '' : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button onClick={runTest} disabled={testing || validationErrors.length > 0}>
            {testing ? 'Testing…' : 'Test connection & preview schema'}
          </button>
          <button onClick={runOpen} disabled={opening || validationErrors.length > 0 || schema === null}>
            {opening ? 'Opening…' : 'Open'}
          </button>
        </div>
      </A11yDialog>
  );
}
