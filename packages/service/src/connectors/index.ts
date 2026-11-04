/**
 * @icecream-sheets/service/connectors — connected data sources.
 *
 * The spreadsheet is a VIEW over any data source: connectors fetch from
 * CSV/JSON/REST/SQL sources and normalize to TableData, which becomes a
 * WorkbookData sheet in the engine's typed computational view (formulas,
 * charts and pivots then work over it unchanged).
 *
 * The ETL pipeline consumes this registry directly (single-registry
 * resolution, 2026-10-18): Connector.fetch(spec, deps) → TableData is the
 * fetch step for ETL source nodes; SDK-style connectors register via
 * adaptEtlConnector() in ../etl/connectors.ts.
 */
export {
  CONNECTOR_SPEC_VERSION,
  CONNECTOR_KINDS,
  validateConnectorSpec,
  migrateConnectorSpec,
  serializeBindings,
  deserializeBindings,
  type ConnectorKind,
  type ConnectorSpec,
  type SourceBinding,
  type SpecValidation,
} from './spec.js';
export {
  makeTableData,
  uniqueColumns,
  inferColumnType,
  tableToWorkbookData,
  tablePreview,
  type TableCell,
  type TableData,
  type ColumnType,
} from './table.js';
export {
  ConnectorRegistry,
  createConnectorRegistry,
  resolveDeps,
  type Connector,
  type ConnectorDeps,
  type CredentialRef,
  type CredentialResolver,
  type FetchText,
  type ResolvedConnectorDeps,
} from './registry.js';
export { CsvUrlConnector, coerceCell } from './csv.js';
export { JsonUrlConnector, getPath, flattenRecord, jsonToTable } from './json.js';
export { RestApiConnector, parseStringMap } from './rest.js';
export { SqlConnector, FakeSqlDriver, type SqlDriver, type SqlRow } from './sql.js';
export {
  MarketDataConnector,
  MarketDataProviders,
  parseStooqCsv,
  parseAlphaVantageJson,
  type MarketDataInterval,
  type MarketDataQuoteProvider,
  type QuoteBar,
} from './marketdata.js';
export { planSheetRefresh, type CellWrite, type RefreshPlan } from './refresh.js';
export {
  sanitizeSheetName,
  uniqueSheetName,
  writeTableToNewSheet,
  applyRefreshPlanToHost,
  bindingForOpen,
} from './engine.js';
export {
  GoogleSheetsConnector,
  GOOGLE_SHEETS_MAX_CELLS,
  parseSpreadsheetId,
  parseSheetsValues,
  sheetsValuesToTable,
} from './google.js';
// Service-layer host wiring for the Google-connector formula functions
// (Cycle-3 GAP-1): resolves the vault Google credential into the engine's
// TRANSLATE/DETECTLANGUAGE/IMPORTRANGE seams.
export {
  wireGoogleFormulaSeams,
  makeGoogleCloudTranslator,
  makeGoogleCloudLanguageDetector,
  decodeTranslateEntities,
  DEFAULT_GOOGLE_CREDENTIAL_REF,
  GOOGLE_API_MAX_TEXT,
  type GoogleAuthMode,
  type GoogleSyncFetch,
  type GoogleFormulaSeamsOptions,
  type GoogleFormulaSeamStatus,
} from './googleSeams.js';
export {
  MailConnector,
  MailProviders,
  buildMimeMessage,
  base64UrlEncode,
  utf8Bytes,
  type MailAttachment,
  type MailMessage,
  type MailProvider,
  type MailSendRequest,
} from './mail.js';
