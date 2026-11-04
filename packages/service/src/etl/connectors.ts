/**
 * ETL pipeline — connector SDK surface.
 *
 * Per design-docs/etl-pipeline.md §2, connector authors implement a small
 * SDK surface: authenticate using a credential reference, describe the
 * source schema, and extract with pagination and incremental cursors.
 *
 * RESOLVED 2026-10-18 — single connector registry: the canonical registry
 * is packages/service/src/connectors/registry.ts. There is no ETL-local
 * registry anymore; ETL source nodes consume the canonical registry via
 * fetch(). Connector authors who prefer this file's paginated SDK surface
 * (EtlConnector) register through adaptEtlConnector(), which wraps them as
 * a canonical Connector.
 *
 * Per §6 (Credentials and permissions) and design-docs/connector-vs-component.md:
 * credentials live in the SERVICE VAULT, never in recipe bytes. The recipe
 * stores only an opaque `credentialRef` string. At run time the runner
 * resolves the ref through a `CredentialResolver` — in production the real
 * service vault adapted with `serviceVaultResolver(vault, owner)`; the
 * vault implementation itself lives in the service API layer (inside the
 * JWT-auth boundary per the user's design rulings), not in this package. A
 * scheduled run executes as the pipeline owner: the runner asks the host
 * (`RunnerDeps.checkPermission`) for read-on-credential and
 * write-on-target before executing.
 *
 * Permissions follow the permission model: the recipe is an object in the
 * permission tree; editing needs the manage right, running needs read on
 * the credential and write on the target.
 */

import type { EtlColumn, EtlRow } from './types.js';
import type { CredentialVault as ServiceVault } from '../vault.js';
import type {
  Connector,
  ResolvedConnectorDeps,
} from '../connectors/registry.js';
import type { ConnectorKind, ConnectorSpec } from '../connectors/spec.js';
import { makeTableData } from '../connectors/table.js';

/** Opaque reference into the service credential vault. Never a secret. */
export type { CredentialRef } from '../connectors/registry.js';
import type { CredentialRef } from '../connectors/registry.js';

/**
 * Vault integration point: the minimal surface ETL needs. The production
 * implementation is the service `CredentialVault` (vault.js) — secrets are
 * encrypted at rest under the vault master key and `retrieve` enforces the
 * `vault.retrieve` authorization check. Use `serviceVaultResolver` to adapt
 * it; tests and local hosts inject a fake.
 *
 * (Re-exported from the canonical connectors package — one shape serves both.)
 */
export type { CredentialResolver } from '../connectors/registry.js';
import type { CredentialResolver } from '../connectors/registry.js';

/**
 * Adapt the service credential vault to the ETL resolver surface.
 * `requester` should be the pipeline owner: a scheduled run executes as
 * the owner (design-docs/etl-pipeline.md §6), so the vault's
 * read-on-credential check is evaluated for that principal.
 */
export function serviceVaultResolver(vault: ServiceVault, requester: string): CredentialResolver {
  return {
    resolveCredential: (ref) => vault.retrieve(ref, requester),
  };
}

/** Authenticated session handle, opaque to the runner. */
export interface ConnectorSession {
  connectorId: string;
  /** Opaque session token/state owned by the connector. */
  state: unknown;
}

export interface ExtractPage {
  columns: EtlColumn[];
  rows: EtlRow[];
  /** Opaque cursor for the next page; absent when extraction is complete. */
  nextCursor?: string;
}

export interface ExtractOptions {
  cursor?: string;
  pageSize?: number;
  parameters?: Record<string, string>;
}

/**
 * The connector SDK surface. Connector authors implement this; the ETL
 * runner drives it. All network/auth happens inside the connector — the
 * recipe and runner only ever see the credential *reference*.
 */
export interface EtlConnector {
  readonly id: string;
  readonly displayName: string;
  authenticate(credentialRef: CredentialRef, vault: CredentialResolver): Promise<ConnectorSession>;
  describeSchema(session: ConnectorSession): Promise<EtlColumn[]>;
  extract(session: ConnectorSession, opts: ExtractOptions): Promise<ExtractPage>;
}

/**
 * REMOVED 2026-10-18 (single-registry resolution): the ETL-local
 * ConnectorRegistry class lived here. The canonical registry is
 * packages/service/src/connectors/registry.ts — ETL source nodes consume
 * it via fetch(). Use adaptEtlConnector() to register an EtlConnector
 * there. This deprecated alias keeps existing imports compiling; new code
 * must import from '../connectors/registry.js'.
 *
 * @deprecated Use ConnectorRegistry from '../connectors/registry.js'.
 */
export { ConnectorRegistry as EtlConnectorRegistry } from '../connectors/registry.js';

/**
 * Adapt an EtlConnector (this file's paginated SDK surface) to the
 * canonical Connector interface so it can be registered in the single
 * connector registry. The adapter authenticates once per fetch, drains all
 * pages via extractAll, and normalizes to TableData.
 */
export function adaptEtlConnector(connector: EtlConnector): Connector {
  return {
    kind: connector.id as ConnectorKind,
    displayName: connector.displayName,
    paramHelp: 'ETL SDK connector: params are passed through as extraction parameters.',
    fetch: async (spec: ConnectorSpec, deps: ResolvedConnectorDeps) => {
      const resolver: CredentialResolver = {
        resolveCredential: async (ref: CredentialRef) => {
          if (!deps.resolveCredential) {
            throw new Error('no credential resolver configured for connector fetch');
          }
          return deps.resolveCredential.resolveCredential(ref);
        },
      };
      const { columns, rows } = await extractAll(
        connector,
        spec.credentialRef ?? '',
        resolver,
        { parameters: spec.params, maxRows: deps.maxRows },
      );
      const names = columns.map((c) => c.name);
      const matrix = rows.map((r) =>
        names.map((n) => {
          const v: unknown = r[n];
          return v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
            ? (v as string | number | boolean | null)
            : String(v);
        }),
      );
      return makeTableData(names, matrix);
    },
  };
}

/**
 * Pull every page from a connector until the cursor is exhausted.
 * Pagination parameters (pageSize) are a connector concern; the runner
 * just follows cursors.
 */
export async function extractAll(
  connector: EtlConnector,
  credentialRef: CredentialRef,
  vault: CredentialResolver,
  opts: { pageSize?: number; parameters?: Record<string, string>; maxRows?: number } = {},
): Promise<{ columns: EtlColumn[]; rows: EtlRow[] }> {
  const session = await connector.authenticate(credentialRef, vault);
  const columns = await describeColumns(connector, session);
  const rows: EtlRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await connector.extract(session, { cursor, pageSize: opts.pageSize, parameters: opts.parameters });
    for (const r of page.rows) {
      const row: EtlRow = {};
      for (const c of columns) row[c.name] = c.name in r ? r[c.name] : null;
      rows.push(row);
    }
    if (opts.maxRows !== undefined && rows.length >= opts.maxRows) break;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { columns, rows: opts.maxRows === undefined ? rows : rows.slice(0, opts.maxRows) };
}

async function describeColumns(connector: EtlConnector, session: ConnectorSession): Promise<EtlColumn[]> {
  const cols = await connector.describeSchema(session);
  if (cols.length === 0) throw new Error(`connector "${connector.id}" described an empty schema`);
  return cols;
}

/** Type guard for values crossing the connector boundary. */
export function coerceRow(raw: Record<string, unknown>, columns: EtlColumn[]): EtlRow {
  const row: EtlRow = {};
  for (const c of columns) {
    const v: unknown = raw[c.name];
    row[c.name] =
      v === null || v === undefined ? null
      : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v
      : String(v);
  }
  return row;
}

