/**
 * ETL pipeline component (design-docs/etl-pipeline.md).
 *
 * Service-layer component, beside the pure engine (AGENT.md §2): repeatable
 * extract-transform-load recipes that materialize typed tables. Everything
 * here is host-agnostic and browser-safe; hosts inject I/O (fetch, vault,
 * code runner, table writer) through the runner's deps.
 *
 * nodeRunner.js (Node-only sandbox binding) is intentionally not re-exported
 * here — server hosts import it directly.
 */

export {
  emptyTable,
  columnNames,
  isEtlValue,
  toEtlValue,
  makeTable,
  formatValue,
  type EtlValue,
  type EtlRow,
  type EtlColumnType,
  type EtlColumn,
  type EtlTable,
  type RowFailure,
} from './types.js';

export {
  ETL_RECIPE_VERSION,
  DEFAULT_RETENTION,
  TRANSFORM_OP_KINDS,
  defaultFailurePolicy,
  inferOutputColumns,
  validateRecipe,
  validateRecipeColumns,
  executionOrder,
  serializeRecipe,
  deserializeRecipe,
  migrateRecipe,
  nodeLabel,
  type EtlSource,
  type CsvTextSource,
  type JsonTextSource,
  type UrlSource,
  type ConnectorSource,
  type SourceNode,
  type FilterOperator,
  type SortDir,
  type ConvertTarget,
  type JoinHow,
  type Aggregation,
  type TableRef,
  type TransformOp,
  type TransformOpKind,
  type TransformNode,
  type LoadTarget,
  type LoadNode,
  type EtlNode,
  type EtlEdge,
  type ScheduleSpec,
  type FailurePolicy,
  type EtlRecipe,
  type RecipeIssue,
} from './recipe.js';

export {
  applyTransform,
  selectColumns,
  dropColumns,
  renameColumns,
  convertType,
  filterRows,
  sortRows,
  splitColumn,
  mergeColumns,
  pivotTable,
  unpivotTable,
  joinTables,
  appendTables,
  groupBy,
  fillDown,
  deduplicate,
  type TransformResult,
  type GroupAggregation,
} from './transforms.js';

export {
  runCustomTransform,
  contractToTable,
  TransientCustomError,
  DEFAULT_CUSTOM_TIMEOUT_MS,
  MAX_CUSTOM_TIMEOUT_MS,
  type CustomLanguage,
  type CustomCodeInput,
  type CustomCodeResult,
  type CustomCodeRunner,
  type CustomTransformSpec,
} from './custom.js';

export {
  adaptEtlConnector,
  extractAll,
  coerceRow,
  type CredentialRef,
  type CredentialResolver,
  serviceVaultResolver,
  type ConnectorSession,
  type ExtractPage,
  type ExtractOptions,
  type EtlConnector,
  /** @deprecated Use ConnectorRegistry from '../connectors/registry.js'. */
  EtlConnectorRegistry,
} from './connectors.js';

export {
  readSource,
  csvTextToTable,
  jsonTextToTable,
  type SourceDeps,
} from './sources.js';

export {
  runRecipe,
  isTransientError,
  makeVersionStoreResolver,
  type RunStatus,
  type QuarantinedRow,
  type ProgressEvent,
  type ChangeEvent,
  type TableWriter,
  type RunnerDeps,
} from './runner.js';

export {
  ETL_MANAGE_ACTION,
  ETL_CREDENTIAL_READ_ACTION,
  ETL_TARGET_WRITE_ACTION,
  etlRecipeObjectId,
  etlCredentialObjectId,
  etlLoadTargetObjectId,
  credentialRefsOfRecipe,
  loadTargetOfRecipe,
  checkRecipeEdit,
  makeRecipeRunCheck,
} from './permissions.js';

export {
  createRecipeStore,
  serializeRecipes,
  deserializeRecipes,
  exportRecipe,
  importRecipe,
  createRunHistoryStore,
  serializeRuns,
  deserializeRuns,
  MAX_RUN_HISTORY,
  createVersionStore,
  targetKey,
  serializeVersions,
  deserializeVersions,
  VersionStore,
  type StoredRecipes,
  type RunStepRecord,
  type RunRecord,
  type StoredRuns,
  type TableVersion,
  type StoredVersions,
} from './store.js';
