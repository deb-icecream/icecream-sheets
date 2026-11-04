/**
 * HTTP SQL driver (web): the SqlDriver seam (packages/service
 * connectors/sql.ts) backed by the gateway connectors service.
 *
 * The browser NEVER sees the connection string after the one store
 * call in the Open Data Source dialog: the spec names only the opaque
 * connection NAME, the connectors service resolves name → connection
 * string from the vault server-side, and runs the read-only query
 * there. This driver just forwards { connection, query, params }.
 */
import type { SqlDriver, SqlRow } from '@icecream-sheets/service/connectors';
import type { GatewayClient } from './gatewayClient';

export function createHttpSqlDriver(gateway: GatewayClient): SqlDriver {
  return {
    id: 'sqlite',
    async query(connection: string, sql: string, params: unknown[]): Promise<SqlRow[]> {
      const res = await gateway.connectorsSqlQuery(connection, sql, params);
      return res.rows;
    },
  };
}
