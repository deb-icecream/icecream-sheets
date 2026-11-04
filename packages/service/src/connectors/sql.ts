/**
 * sql connector — run a read query against a SQL database and normalize rows
 * to a table.
 *
 * Params:
 * - driver (required): driver id the host registered (e.g. 'postgres',
 *   'mysql', 'sqlite'). Informational: the host picks the SqlDriver by this
 *   id when several are available.
 * - connection (required): opaque connection NAME (not a connection string).
 *   The actual connection string / credentials live in the service vault
 *   under credentialRef — never in the spec.
 * - query (required): the SQL SELECT to run. Only read queries are intended;
 *   drivers SHOULD reject statements outside a read allowlist.
 * - params (optional): JSON array of bound query parameters.
 *
 * DRIVER SEAM (honest status): this package ships NO database driver — there
 * is no dependency-free, production-grade SQL driver for every host (browser,
 * desktop, server). The SqlDriver interface below is fully implemented by
 * this module's SqlConnector; a host supplies a driver via
 * ConnectorDeps.sqlDriver (typically a thin adapter over node-postgres,
 * mysql2, better-sqlite3, or a JDBC/ODBC bridge in the service boundary).
 * Until a driver is wired, the 'sql' kind validates specs but fetch() throws
 * a clear "no SQL driver configured" error instead of a confusing failure.
 * Tests use the in-memory FakeSqlDriver exported here.
 */
import type { ConnectorKind, ConnectorSpec } from './spec.js';
import { makeTableData, uniqueColumns, type TableCell, type TableData } from './table.js';
import type { Connector, ResolvedConnectorDeps } from './registry.js';

/** A row returned by a SQL driver: column name → value. */
export type SqlRow = Record<string, string | number | boolean | null>;

/**
 * Driver seam. Implementations own the actual database client, connection
 * pooling, and credential handling (the secret stays inside the driver /
 * vault; the spec only names the connection).
 */
export interface SqlDriver {
  /** Driver id, matched against spec.params['driver'] (informational). */
  readonly id: string;
  /**
   * Run a read query. `connection` is the opaque connection name from the
   * spec; `sql` the query text; `params` bound parameters. The driver SHOULD
   * reject non-read statements.
   */
  query(connection: string, sql: string, params: unknown[]): Promise<SqlRow[]>;
}

export class SqlConnector implements Connector {
  readonly kind: ConnectorKind = 'sql';
  readonly displayName = 'SQL database';
  readonly paramHelp =
    'driver: registered driver id. connection: connection NAME (secret lives in the vault). query: SQL SELECT. params: JSON array of bound params (optional).';

  async fetch(spec: ConnectorSpec, deps: ResolvedConnectorDeps): Promise<TableData> {
    const driver = deps.sqlDriver;
    if (!driver) {
      throw new Error(
        'no SQL driver configured: register a SqlDriver via ConnectorDeps.sqlDriver ' +
          '(see packages/service/src/connectors/sql.ts — no driver ships by default)',
      );
    }
    const connection = (spec.params['connection'] ?? '').trim();
    const sql = (spec.params['query'] ?? '').trim();
    const params = parseParams(spec.params['params']);
    // The spec may name a credentialRef for the connection secret; the
    // driver resolves it through the vault itself. We validate presence of
    // a resolver here so misconfiguration fails fast with a clear message.
    if (spec.credentialRef && !deps.resolveCredential) {
      throw new Error(
        `spec needs credential "${spec.credentialRef}" but no credential resolver is wired`,
      );
    }
    const rows = await driver.query(connection, sql, params);
    if (rows.length === 0) return makeTableData([], []);
    const columnOrder: string[] = [];
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!columnOrder.includes(k)) columnOrder.push(k);
      }
    }
    const columns = uniqueColumns(columnOrder);
    const data: TableCell[][] = rows.map((row) =>
      columnOrder.map((k) => {
        const v = row[k] ?? null;
        return (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null) as TableCell;
      }),
    );
    return makeTableData(columns, data);
  }
}

function parseParams(raw: string | undefined): unknown[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('param "params" must be a JSON array');
  }
  if (!Array.isArray(parsed)) throw new Error('param "params" must be a JSON array');
  return parsed;
}

/**
 * In-memory fake SQL driver for tests and offline demos. Supports a tiny
 * subset: "SELECT * FROM <table>" over registered tables. Not for production.
 */
export class FakeSqlDriver implements SqlDriver {
  readonly id = 'fake';
  private readonly tables = new Map<string, SqlRow[]>();

  addTable(name: string, rows: SqlRow[]): void {
    this.tables.set(name.toLowerCase(), rows);
  }

  async query(_connection: string, sql: string, _params: unknown[]): Promise<SqlRow[]> {
    const m = /^\s*select\s+\*\s+from\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?\s*$/i.exec(sql);
    if (!m) throw new Error(`FakeSqlDriver only supports "SELECT * FROM <table>", got: ${sql}`);
    const rows = this.tables.get((m[1] as string).toLowerCase());
    if (!rows) throw new Error(`unknown table "${m[1]}"`);
    return rows.map((r) => ({ ...r }));
  }
}
