/**
 * Connectors service: the server-side home of the Open Data Source
 * Gallery's secret handling and SQL driver (CONTRACT.md,
 * hidden_files/idea-datasource-gallery).
 *
 * Why server-side: specs NEVER carry secrets (connectors/spec.ts). The
 * browser sends a secret exactly once, over the authenticated gateway
 * route /api/connectors, to this service, which stores it in the vault
 * service (VAULT_URL, default http://127.0.0.1:8102) under a ref derived
 * SERVER-SIDE from the gateway-injected x-principal — the same rule
 * vaultSvc enforces (refs must start with `${principal}:`). From then
 * on only the opaque credentialRef travels: in specs, in bindings, and
 * back here when a query needs the connection string resolved.
 *
 * Endpoints:
 * - GET  /health
 * - POST /credential/store      { name, secret, kind?: 'rest'|'sql' }
 *                               → vault store `${principal}:ds:<kind>:<name>`; { ref }
 * - POST /sql/store-connection  { connection, connectionString }
 *                               → vault store `${principal}:ds:sql:<connection>`; { ref }
 * - POST /sql/tables            { connection } → tables+views from sqlite_master
 * - POST /sql/schema            { connection, table } → PRAGMA table_info + row count
 * - POST /sql/query             { connection, query, params } → { columns, rows, truncated }
 *
 * SQL driver: node:sqlite DatabaseSync, opened READ-ONLY. Statement
 * allowlist (single statement; SELECT / WITH…SELECT / EXPLAIN / read
 * PRAGMA), hard row cap 10_000 with a `truncated` flag. Connection
 * strings: sqlite://<path>, sqlite:<path>, or a bare absolute path —
 * any other scheme is rejected with a clear error (only the sqlite
 * driver ships in this build).
 */
import type { RequestListener } from 'node:http';
/** Hard cap on rows returned by /sql/query (contract). */
export declare const SQL_ROW_CAP = 10000;
export interface ConnectorServiceOptions {
    /** Vault service base URL. Default: VAULT_URL env or http://127.0.0.1:8102. */
    vaultUrl?: string;
}
/**
 * Resolve a stored connection string to a sqlite filesystem path.
 * Accepted forms: sqlite://<path>, sqlite:<path>, bare absolute path,
 * and ':memory:' (via any sqlite: form). Anything else — postgres://,
 * mysql://, relative paths — is rejected with a clear error.
 */
export declare function sqlitePathFromConnectionString(connectionString: string): string;
/**
 * Enforce the read-only statement allowlist. Returns the single
 * statement (one trailing ';' removed). Throws HttpError(400) on
 * multi-statement input or any non-read statement.
 */
export declare function assertReadOnlyStatement(raw: string): string;
export declare function createConnectorListener(opts?: ConnectorServiceOptions): RequestListener;
