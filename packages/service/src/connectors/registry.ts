/**
 * Connector registry — the service-layer home of the connector abstraction.
 *
 * Per design-docs/connector-vs-component.md a connector reaches a separate
 * service (often with authentication); per AGENT.md §2 the ETL pipeline is a
 * separate component beside the pure engine. This registry is the shared
 * substrate: "Open data source" and refresh use it directly, and ETL source
 * nodes consume it via fetch() (single-registry resolution, 2026-10-18 —
 * there is no ETL-local registry; see ../etl/connectors.ts adaptEtlConnector).
 *
 * Everything here is headless and dependency-free (no node builtins), so it
 * runs in the browser, the desktop shell, and the MCP server. Network access
 * is injected via FetchText; tests inject fakes and never hit the network.
 *
 * NOTE: connector modules import this file with `import type` only, so the
 * static imports below create no runtime module cycle.
 */
import { CsvUrlConnector } from './csv.js';
import { JsonUrlConnector } from './json.js';
import { RestApiConnector } from './rest.js';
import { SqlConnector } from './sql.js';
import { MarketDataConnector } from './marketdata.js';
import { MailConnector } from './mail.js';
import { GoogleSheetsConnector } from './google.js';
import type { SqlDriver } from './sql.js';
import type { ConnectorKind, ConnectorSpec } from './spec.js';
import { validateConnectorSpec } from './spec.js';
import type { TableData } from './table.js';

/**
 * Opaque reference into the service credential vault. Never a secret value.
 * (Same shape as ETL's CredentialRef so one resolver serves both.)
 */
export type CredentialRef = string;

/**
 * Vault integration seam. Production wires this to the real service
 * CredentialVault (../vault.ts) scoped to the requesting principal; the
 * sibling vault workstream owns that implementation. Tests inject a fake.
 *
 * The secret value is used transiently (e.g. an Authorization header) and is
 * never persisted or logged by any connector.
 */
export interface CredentialResolver {
  resolveCredential(ref: CredentialRef): Promise<string>;
}

/** Fetch function injected by the host (browser fetch, node fetch, or a fake). */
export type FetchText = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string },
) => Promise<string>;

/** Runtime dependencies for connector fetches. */
export interface ConnectorDeps {
  /** Fetch URL text. Defaults to globalThis.fetch. Injected in tests. */
  fetchText?: FetchText;
  /**
   * Resolves credentialRef → secret. Absent in anonymous contexts; connectors
   * fail closed with a clear error when a spec needs one and none is wired.
   */
  resolveCredential?: CredentialResolver;
  /** SQL driver for the 'sql' kind. No driver ships by default (see sql.ts). */
  sqlDriver?: SqlDriver;
  /** Safety cap on materialized rows. Defaults to 100_000 (ETL convention). */
  maxRows?: number;
}

/** Resolved, validated deps with defaults applied. */
export interface ResolvedConnectorDeps {
  fetchText: FetchText;
  resolveCredential: CredentialResolver | null;
  sqlDriver: SqlDriver | null;
  maxRows: number;
}

export function resolveDeps(deps: ConnectorDeps = {}): ResolvedConnectorDeps {
  const maxRows = deps.maxRows ?? 100_000;
  return {
    fetchText:
      deps.fetchText ??
      (async (url, init) => {
        const res = await globalThis.fetch(url, init);
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
        return res.text();
      }),
    resolveCredential: deps.resolveCredential ?? null,
    sqlDriver: deps.sqlDriver ?? null,
    maxRows,
  };
}

/**
 * The connector interface. Implementations fetch from their source and
 * normalize to TableData. All network/auth happens inside fetch(); the spec
 * and registry only ever see the credential *reference*.
 */
export interface Connector {
  readonly kind: ConnectorKind;
  readonly displayName: string;
  /** Short human description of the params this kind needs. */
  readonly paramHelp: string;
  fetch(spec: ConnectorSpec, deps: ResolvedConnectorDeps): Promise<TableData>;
}

/**
 * Registry of connectors by kind. Built-ins are registered by
 * createConnectorRegistry(); hosts can register custom kinds (e.g. a
 * Google Sheets connector or a proprietary API) without touching this
 * package.
 */
export class ConnectorRegistry {
  private readonly map = new Map<ConnectorKind, Connector>();

  register(connector: Connector): void {
    if (this.map.has(connector.kind)) {
      throw new Error(`connector already registered for kind "${connector.kind}"`);
    }
    this.map.set(connector.kind, connector);
  }

  get(kind: ConnectorKind): Connector {
    const c = this.map.get(kind);
    if (!c) throw new Error(`no connector registered for kind "${kind}"`);
    return c;
  }

  kinds(): ConnectorKind[] {
    return [...this.map.keys()];
  }

  /** Validate the spec, then fetch through the kind's connector. */
  async fetch(spec: ConnectorSpec, deps: ConnectorDeps = {}): Promise<TableData> {
    // Custom registered kinds validate too (shape/secrets/URLs); only
    // built-in kinds get the required-params check. See spec.ts.
    const validation = validateConnectorSpec(spec, this.kinds());
    if (!validation.ok) {
      throw new Error(`invalid connector spec: ${validation.errors.join('; ')}`);
    }
    const resolved = resolveDeps(deps);
    const table = await this.get(spec.kind).fetch(spec, resolved);
    if (table.rows.length > resolved.maxRows) {
      throw new Error(`source returned ${table.rows.length} rows (max ${resolved.maxRows})`);
    }
    return table;
  }
}

/**
 * Create a registry with the built-in connectors: csv-url, json-url,
 * rest-api, sql, marketdata, mail, google-sheets. The 'sql' kind validates specs but fetch()
 * fails with a clear error until a SqlDriver is supplied via fetch deps
 * (see sql.ts). The 'marketdata' kind defaults to Stooq (free, no key);
 * 'alphavantage' needs a credentialRef API key. The 'mail' kind is send-only:
 * registry.fetch() on it throws and directs callers at sendEmail().
 * The 'google-sheets' kind is the Google-connector source behind IMPORTRANGE:
 * it reads a range through spreadsheets.values.get with the OAuth2 token or
 * API key resolved from the spec's vault credentialRef.
 */
export function createConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(new CsvUrlConnector());
  registry.register(new JsonUrlConnector());
  registry.register(new RestApiConnector());
  registry.register(new SqlConnector());
  registry.register(new MarketDataConnector());
  registry.register(new MailConnector());
  registry.register(new GoogleSheetsConnector());
  return registry;
}
