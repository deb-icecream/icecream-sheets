/**
 * Web client support for connected data sources.
 *
 * The spreadsheet is a VIEW over any data source: a connector fetches a
 * TableData, which is materialized as a sheet in the engine's typed
 * computational view (header row + data rows) through the normal
 * host.execute() mutation path — every write goes through authorize(), so
 * formulas, charts and pivots work over connected data unchanged.
 *
 * Source bindings (spec + sheet + last refresh) persist in the service
 * metadata store bound to browser localStorage, following the chartStore.ts
 * pattern. Pure spec/table/refresh logic lives in
 * @icecream-sheets/service/connectors and is re-exported here for
 * convenience.
 */
import {
  createDataSourceStore,
  type Persistence,
  type SourceBinding,
} from '@icecream-sheets/service';
import {
  applyRefreshPlanToHost,
  CONNECTOR_SPEC_VERSION,
  createConnectorRegistry,
  planSheetRefresh,
  sanitizeSheetName,
  tablePreview,
  uniqueSheetName,
  validateConnectorSpec,
  writeTableToNewSheet,
  type ConnectorDeps,
  type ConnectorKind,
  type ConnectorSpec,
  type RefreshPlan,
  type TableData,
} from '@icecream-sheets/service/connectors';
import type { GatewayClient } from '../services/gatewayClient';
import { createHttpSqlDriver } from '../services/httpSqlDriver';

export {
  applyRefreshPlanToHost as applyRefreshPlan,
  CONNECTOR_SPEC_VERSION,
  createConnectorRegistry,
  planSheetRefresh,
  sanitizeSheetName,
  tablePreview,
  uniqueSheetName,
  validateConnectorSpec,
  writeTableToNewSheet,
  type ConnectorDeps,
  type ConnectorKind,
  type ConnectorSpec,
  type SourceBinding,
  type TableData,
};

/**
 * Connector deps for the gateway topology (Open Data Source Gallery):
 * credential refs resolve through the gateway vault (the App.tsx:6641
 * resolver pattern) and SQL runs through the connectors service via
 * the HTTP SQL driver — the browser never sees a connection string.
 * Without a gateway client (local mode) returns {}: public URL sources
 * still work and SQL fails with the connector's clear no-driver error.
 */
export function buildConnectorDeps(gateway: GatewayClient | null): ConnectorDeps {
  if (!gateway) return {};
  return {
    resolveCredential: {
      resolveCredential: async (ref: string) => (await gateway.vaultRetrieve(ref)).secret,
    },
    sqlDriver: createHttpSqlDriver(gateway),
  };
}

/** localStorage-backed persistence for the web client. */
const localStoragePersistence: Persistence = {
  load: (key) => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  save: (key, value) => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      // Storage full / private mode — bindings still live in App state.
    }
  },
  clear: (key) => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

/** Singleton data-source binding store for the web client. */
const dataSourceStore = createDataSourceStore(localStoragePersistence);

/** Restore persisted source bindings. No-op outside browsers. */
export function restoreDataSourceBindings(): SourceBinding[] {
  return dataSourceStore.all();
}

/** Persist source bindings to the browser metadata store. */
export function persistDataSourceBindings(bindings: SourceBinding[]): void {
  dataSourceStore.saveAll(bindings);
}

/** Shared registry with the built-in connectors (csv-url, json-url, rest-api, sql). */
export const dataSourceRegistry = createConnectorRegistry();

/** Find the binding feeding a sheet, if any. */
export function bindingForSheet(bindings: SourceBinding[], sheetName: string): SourceBinding | undefined {
  return bindings.find((b) => b.sheetName === sheetName);
}

/** Human "x ago" for the connected-source tab tooltip. */
export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
