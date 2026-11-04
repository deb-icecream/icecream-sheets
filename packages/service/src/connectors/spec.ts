/**
 * Connector spec — the versioned, serializable description of a connected
 * data source (packages/service/src/connectors).
 *
 * CORE ARCHITECTURE: the spreadsheet is a VIEW over any data source, not a
 * file editor. An Excel file is just one data source. Any source (SQL, REST
 * API, CSV/JSON over HTTP) connects through a connector; the fetched table
 * becomes a WorkbookData sheet in the engine's typed computational view, so
 * formulas, charts and pivots work over it unchanged.
 *
 * Rules (per design-docs/connector-vs-component.md and the user's design
 * rulings):
 * - The spec NEVER carries secrets. Authentication uses `credentialRef`, an
 *   opaque reference into the service credential vault (a sibling workstream
 *   is building the vault; the integration seam is `CredentialResolver` in
 *   registry.ts, compatible with the ETL resolver surface in
 *   ../etl/connectors.ts so ETL source nodes can consume this abstraction).
 * - Params are plain strings only (serializable, loggable). Anything that
 *   looks like a secret key in params fails validation.
 * - Only http(s) URLs are fetchable. This is enforced at validation time so
 *   a malicious spec cannot exfiltrate file:// or other schemes.
 */

export const CONNECTOR_SPEC_VERSION = 1;

/** Built-in connector kinds. Third parties register more via ConnectorRegistry. */
export type ConnectorKind = 'csv-url' | 'json-url' | 'rest-api' | 'sql' | 'marketdata' | 'mail' | 'google-sheets';

/** All known connector kinds (built-ins; the registry may hold more). */
export const CONNECTOR_KINDS: readonly ConnectorKind[] = [
  'csv-url',
  'json-url',
  'rest-api',
  'sql',
  'marketdata',
  'mail',
  'google-sheets',
];

/**
 * Versioned connector spec. Serializable to JSON; persisted in the service
 * metadata store (see createDataSourceStore in ../metadataStore.ts) keyed by
 * sheet/workbook binding.
 */
export interface ConnectorSpec {
  /** Must equal CONNECTOR_SPEC_VERSION. */
  version: number;
  kind: ConnectorKind;
  /** User-facing label, e.g. "Q3 sales CSV". Shown on the sheet tab tooltip. */
  label: string;
  /** Kind-specific parameters. Strings only; never secrets. */
  params: Record<string, string>;
  /**
   * Opaque reference into the service credential vault. Resolved at fetch
   * time through CredentialResolver; the secret value is never persisted,
   * never logged, and never appears in the spec payload.
   */
  credentialRef?: string;
}

/** Required params per connector kind (documented in each connector module). */
const REQUIRED_PARAMS: Record<ConnectorKind, string[]> = {
  'csv-url': ['url'],
  'json-url': ['url'],
  'rest-api': ['url'],
  sql: ['driver', 'connection', 'query'],
  // marketdata connector (marketdata.ts): symbol is required; start/end optional.
  marketdata: ['symbol'],
  // mail connector (mail.ts) is send-only: no fetch params are required.
  mail: [],
  // google-sheets connector (google.ts): the Google-connector source behind IMPORTRANGE.
  'google-sheets': ['spreadsheetId', 'range'],
};

/** Param keys that look like secret smuggling — rejected by validation. */
const SECRET_LIKE_KEYS = ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'private_key'];

export interface SpecValidation {
  ok: boolean;
  errors: string[];
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a connector spec. Returns all problems found (never throws) so
 * UIs can show them inline. Checks: shape, kind, version, required params,
 * http(s)-only URLs, and no secret-like param keys.
 *
 * `extraKinds` are custom kinds registered in a ConnectorRegistry (hosts
 * can register proprietary connectors). Custom kinds skip the required-
 * params check — the custom connector documents its own params — but all
 * other checks (shape, secrets, URL schemes) still apply.
 *
 * RESOLVED 2026-10-18: single connector registry (see etl-pipeline.md §2).
 * The registry in connectors/registry.ts is the canonical one; ETL source
 * nodes consume it via fetch(). Extra kinds let ETL-style SDK connectors
 * (adaptEtlConnector) register without touching this package.
 */
export function validateConnectorSpec(spec: unknown, extraKinds: readonly string[] = []): SpecValidation {
  const errors: string[] = [];
  if (typeof spec !== 'object' || spec === null) {
    return { ok: false, errors: ['spec must be an object'] };
  }
  const s = spec as Partial<ConnectorSpec>;
  if (s.version !== CONNECTOR_SPEC_VERSION) {
    errors.push(`unsupported spec version ${String(s.version)} (expected ${CONNECTOR_SPEC_VERSION})`);
  }
  const kind = s.kind as string;
  const isBuiltin = CONNECTOR_KINDS.includes(kind as ConnectorKind);
  if (!isBuiltin && !extraKinds.includes(kind)) {
    errors.push(`unknown connector kind ${JSON.stringify(s.kind)}`);
  }
  if (typeof s.label !== 'string' || s.label.trim() === '') {
    errors.push('label must be a non-empty string');
  }
  if (typeof s.params !== 'object' || s.params === null || Array.isArray(s.params)) {
    errors.push('params must be an object of string values');
  } else {
    for (const [k, v] of Object.entries(s.params)) {
      if (typeof v !== 'string') errors.push(`param "${k}" must be a string`);
      const kl = k.toLowerCase();
      if (SECRET_LIKE_KEYS.some((bad) => kl.includes(bad))) {
        errors.push(`param "${k}" looks like a secret: use credentialRef, not params`);
      }
    }
    const builtinKind = s.kind as ConnectorKind;
    if (isBuiltin) {
      for (const req of REQUIRED_PARAMS[builtinKind]) {
        const v = (s.params as Record<string, string>)[req];
        if (typeof v !== 'string' || v.trim() === '') {
          errors.push(`missing required param "${req}" for kind "${builtinKind}"`);
        }
      }
    }
    for (const [k, v] of Object.entries(s.params)) {
      if (typeof v === 'string' && k.toLowerCase().includes('url') && v.trim() !== '' && !isHttpUrl(v)) {
        errors.push(`param "${k}" must be an http(s) URL`);
      }
    }
  }
  if (s.credentialRef !== undefined && (typeof s.credentialRef !== 'string' || s.credentialRef.trim() === '')) {
    errors.push('credentialRef must be a non-empty string when present');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Migrate any older spec shape forward to CONNECTOR_SPEC_VERSION.
 * Throws on unsalvageable input. v0 (unversioned) specs gain version: 1 and
 * a default label derived from the kind.
 */
export function migrateConnectorSpec(spec: unknown): ConnectorSpec {
  if (typeof spec !== 'object' || spec === null) {
    throw new Error('cannot migrate: spec must be an object');
  }
  const s = spec as Partial<ConnectorSpec> & { version?: unknown };
  const version = s.version === undefined ? 0 : s.version;
  if (version !== 0 && version !== CONNECTOR_SPEC_VERSION) {
    throw new Error(`cannot migrate spec version ${String(version)}`);
  }
  const kind = s.kind as ConnectorKind;
  if (!CONNECTOR_KINDS.includes(kind)) {
    throw new Error(`cannot migrate: unknown connector kind ${JSON.stringify(s.kind)}`);
  }
  const params = s.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('cannot migrate: params must be an object');
  }
  const stringParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) stringParams[k] = String(v);
  const label = typeof s.label === 'string' && s.label.trim() !== '' ? s.label : defaultLabel(kind);
  const out: ConnectorSpec = { version: CONNECTOR_SPEC_VERSION, kind, label, params: stringParams };
  if (typeof s.credentialRef === 'string' && s.credentialRef.trim() !== '') {
    out.credentialRef = s.credentialRef;
  }
  return out;
}

function defaultLabel(kind: ConnectorKind): string {
  switch (kind) {
    case 'csv-url':
      return 'CSV data';
    case 'json-url':
      return 'JSON data';
    case 'rest-api':
      return 'API data';
    case 'sql':
      return 'SQL data';
    case 'marketdata':
      return 'Market data';
    case 'mail':
      return 'Email';
    case 'google-sheets':
      return 'Google Sheets';
  }
}

/**
 * A persisted binding between a sheet and the connector spec that feeds it.
 * Stored in the service metadata store (createDataSourceStore) keyed by
 * sheet name; refresh re-fetches through `spec` and atomically swaps the
 * sheet's data region.
 */
export interface SourceBinding {
  /** Stable id for the binding (used by MCP tools and automation). */
  id: string;
  /** Sheet holding the connected data. Bindings are keyed by sheet name. */
  sheetName: string;
  spec: ConnectorSpec;
  /** ISO timestamp of the last successful fetch, or null if never fetched. */
  lastRefresh: string | null;
  /** Dimensions (including the header row) of the last materialized table. */
  rowCount: number;
  colCount: number;
}

/** Serialize source bindings for the metadata store. */
export function serializeBindings(bindings: SourceBinding[]): string {
  return JSON.stringify({ version: CONNECTOR_SPEC_VERSION, bindings });
}

/**
 * Deserialize source bindings, migrating specs forward. Returns [] for
 * corrupt payloads; skips entries whose specs cannot be salvaged.
 */
export function deserializeBindings(json: string): SourceBinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const list = (parsed as { bindings?: unknown }).bindings;
  if (!Array.isArray(list)) return [];
  const out: SourceBinding[] = [];
  for (const b of list) {
    if (typeof b !== 'object' || b === null) continue;
    const bb = b as Partial<SourceBinding>;
    try {
      const spec = migrateConnectorSpec(bb.spec);
      if (typeof bb.sheetName !== 'string' || bb.sheetName === '') continue;
      out.push({
        id: typeof bb.id === 'string' && bb.id !== '' ? bb.id : bb.sheetName,
        sheetName: bb.sheetName,
        spec,
        lastRefresh: typeof bb.lastRefresh === 'string' ? bb.lastRefresh : null,
        rowCount: typeof bb.rowCount === 'number' ? bb.rowCount : 0,
        colCount: typeof bb.colCount === 'number' ? bb.colCount : 0,
      });
    } catch {
      // Skip unsalvageable entries; the store must never fail to load.
    }
  }
  return out;
}
