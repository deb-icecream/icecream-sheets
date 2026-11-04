/**
 * @icecream-sheets/engine — headless calculation engine core.
 * No UI imports. No persistence imports. No native dependencies.
 */
export { ENGINE_PROTOCOL_VERSION } from './types.js';
export type {
  AuthContext,
  GrantRecord,
  Policy,
} from './permissions.js';
export { Authorizer, allowAllPolicy } from './permissions.js';
export type {
  AdapterCapabilities,
  CellBorderSide,
  CellBorderStyle,
  CellBordersData,
  CellStyle,
  DefinedName,
  SheetData,
  StorageAdapter,
  WorkbookData,
} from './storage.js';
export type {
  AsyncCommandResult,
  CommandResult,
  EngineCommand,
  EngineEvent,
  EngineEventListener,
  EngineForwardPayload,
  EngineLoadResult,
  EngineLoadSheetSummary,
  SavePin,
} from './protocol.js';
export {
  DEFAULT_SAVE_PIN_STASH_CAP_CELLS,
  EngineHost,
  SavePinOverflowError,
} from './protocol.js';
export type {
  CellInput,
  CalculationMode,
  EngineWorkbookOptions,
  NamedFunctionBinding,
} from './workbook.js';
export { EngineWorkbook } from './workbook.js';
// Hybrid recalc routing (Cycle 10 Phase 3): chain-length measurement over
// the dependency graph, configurable thresholds, and the pure local/server
// routing policy. See calc-chain.ts and HYBRID-CONSISTENCY.md.
export { computeAckChecksum, fnv1a64, serializeAckInput, serializeAckValue, sortAckRefs } from './ack-checksum.js';
export type { EditAck } from './ack-checksum.js';
export {
  DEFAULT_CHAIN_LENGTH_THRESHOLD,
  DEFAULT_MT_CELL_COUNT_THRESHOLD,
  DEFAULT_TINY_SET_THRESHOLD,
  ENV_CHAIN_LENGTH_THRESHOLD,
  ENV_MT_CELL_COUNT_THRESHOLD,
  ENV_TINY_SET_THRESHOLD,
  autoMtEnabled,
  deriveMirrorMode,
  hybridRecalcConfigFromEnv,
  measureCalcChain,
  normalizeHybridRecalcConfig,
  routeRecalc,
} from './calc-chain.js';
export type {
  CalcChainGraphSource,
  CalcChainMeasurement,
  GraphCellAddress,
  GraphCellRange,
  GraphDependent,
  GraphTarget,
  HybridRecalcConfig,
  MirrorMode,
  NamedExpressionNode,
  RecalcRoute,
  RecalcRouteContext,
  RecalcRouteDecision,
  RecalcRouteReason,
  RecalcShape,
  RouteRecalcInput,
} from './calc-chain.js';
// Named ranges / named functions: parse-time binding helpers, the
// permission-denied sentinel, and the shared lambda-application machinery.
export {
  NAMEDFUNC_DISPATCH,
  hasDispatchCalls,
  rewriteNamedFunctionCalls,
  unrewriteNamedFunctionCalls,
} from './named-function-plugin.js';
export { PERM_DENIED_SENTINEL, PERM_DENIED_FUNCTION } from './perm-error.js';
// External workbook references ([N]Sheet!Ref): link model, live-provider
// registry seam, parse-time rewrite helpers, and the ambient evaluation
// context used by the ICEEXTREF dispatcher.
export {
  EXTERNAL_REF_DISPATCH,
  EXTERNAL_CACHE_SEP,
  ExternalWorkbookRegistry,
  defaultExternalRegistry,
  externalCacheKey,
  getExternalLinkContext,
  normalizeA1Ref,
  registerExternalRefPlugin,
  resolveExternalRef,
  rewriteExternalRefs,
  unrewriteExternalRefs,
  withExternalLinkContext,
  type ExternalLink,
  type ExternalLinkContext,
  type ExternalWorkbookProvider,
} from './external-refs.js';
export { LambdaValue, applyLambdaValue } from './lambda-functions.js';
export type {
  CellRef,
  CellSnapshot,
  ErrorCode,
  RangeRef,
  ScalarKind,
  ScalarValue,
  ErrorValue,
  SheetInfo,
  SheetSnapshot,
  TypedValue,
  WorkbookSnapshot,
} from './types.js';
export { err, isError, isImage, image, scalar, toA1 } from './types.js';
export type { ImageValue } from './types.js';
export { TypedView, type TypedCell } from './view.js';
// Excel-compat function plugins (side-effectful registration with
// HyperFormula on import, before any EngineWorkbook is constructed).
// Extracted to plugins.ts so the parallel-recalc worker can register the
// identical plugin set without importing the whole index (circularity).
import './plugins.js';
// Provider seams for hosts (web app, desktop, services):
// WEBSERVICE → setWebFetchProvider, PY → setPythonProvider,
// COPILOT → setCopilotProvider, RTD → publishRtdTopic/rtdTopicKey.
export {
  setWebFetchProvider,
  resetWebFetchProvider,
  setMarketDataProvider,
  resetMarketDataProvider,
  setPythonProvider,
  resetPythonProvider,
  setPythonTimeoutMs,
  getPythonTimeoutMs,
  PY_TIMEOUT_DEFAULT_MS,
  setCopilotProvider,
  resetCopilotProvider,
  publishRtdTopic,
  rtdTopicKey,
  fetchUrlText,
  PY_PRELUDE,
  PY_PLOT_MAX_B64_CHARS,
  parsePythonEnvelope,
  pyPlotToImageValue,
  type WebFetchProvider,
  type MarketDataProvider,
  type PythonProvider,
  type PythonResult,
  type PythonPlotResult,
  type CopilotProvider,
} from './extended-functions11.js';
// IMPORTDATA/IMPORTFEED/IMPORTHTML/IMPORTXML — the Fetch-component formula
// functions (design-docs/connector-vs-component.md). Registered via
// plugins.ts (imported above); re-exported here for hosts.
export {
  registerImportFunctions,
  importDataValues,
  importFeedValues,
  importHtmlValues,
  importXmlValues,
  parseFeed,
  spillImportData,
  spillImportFeed,
  spillImportHtml,
  spillImportXml,
} from './import-functions.js';
// OLAP cube functions (CUBEVALUE, ...) — registered via plugins.ts (imported
// above); re-export the explicit registrar plus the cube registry helpers
// for hosts that adapt service data into an OlapCube (see cubeFromPivot()).
export {
  registerCubeFunctions,
  registerCube,
  unregisterCube,
  clearCubes,
  listCubes,
  cubeFromPivot,
  type OlapCube,
  type OlapKpi,
} from './cube-functions.js';
// Live pivot queries over a worksheet-range data model (#114, Piece 1):
// pure aggregation over a resolved model, beside the cube registry.
export {
  queryOlapPivot,
  olapMemberLabel,
  type OlapModel,
  type OlapModelTable,
  type OlapResolvedPivot,
  type OlapResolvedValue,
  type OlapPivotMatrix,
} from './olap-model-query.js';
// Engine-local pivot registry (extended-functions9.ts): hosts register a
// pivot table's rendered position so GETPIVOTDATA can resolve it. The pivot
// shape is the structural PivotResultLike (service PivotResult adapts to it).
export {
  registerPivot,
  unregisterPivot,
  findPivotContaining,
  setImportedPivotInfos,
  type PivotResultLike,
  type PivotAnchor,
  type PivotRegistration,
  type ImportedPivotInfo,
} from './extended-functions9.js';
// IMPORTRANGE/GOOGLEFINANCE — the Google-connector formula functions
// (design-docs/connector-vs-component.md). Registered via plugins.ts
// (imported above); re-exported here for hosts.
export {
  registerGoogleFunctions,
  publishImportRangeData,
  clearImportRangeData,
  parseSpreadsheetId,
  fetchSheetsRange,
  setGoogleApiCredential,
  getGoogleApiCredential,
  type GoogleApiCredential,
} from './google-functions.js';
// getMarketBars: the shared market-data seam behind STOCKHISTORY and
// GOOGLEFINANCE (extended-functions11.ts).
export { getMarketBars } from './extended-functions11.js';
// TRANSLATE/DETECTLANGUAGE provider seams (extended-functions10.ts):
// hosts inject real providers (e.g. Google Cloud Translation) via these
// setters. Re-exported here because the service-layer Google host wiring
// (packages/service/src/connectors/googleSeams.ts) drives them — previously
// they were only reachable inside the engine package, so no host could call
// them (Cycle-3 GAP-1).
export {
  setTranslatorProvider,
  resetTranslatorProvider,
  setLanguageDetectorProvider,
  resetLanguageDetectorProvider,
  type TranslatorProvider,
  type LanguageDetectorProvider,
} from './extended-functions10.js';
// FIELDVALUE rich-value binding (Phase E piece B): hosts register a
// file's resolved rich values so FIELDVALUE resolves from the record.
export {
  clearRichValueFieldValueEntities,
  findFieldValueSample,
  registerRichValueFieldValueEntities,
  resetFieldValueDataProvider,
  richValueToFieldValueEntity,
  setFieldValueDataProvider,
  type FieldValueDataProvider,
  type FieldValueEntity,
  type RichValueFieldValueInput,
} from './extended-functions10.js';
// HTML download adapter (track 9): write-only StorageAdapter rendering a
// workbook as a standalone HTML document.
export {
  HtmlAdapter,
  renderWorkbookHtml,
  workbookToHtmlTables,
  HTML_MAX_ROWS,
  HTML_MAX_COLS,
  type HtmlSheetTable,
} from './html-export.js';
// Re-export spill helpers for hosts (web UI / EngineWorkbook).
export {
  checkedSpillWrites,
  spill,
  spillExtentOf,
  toSpillWrites,
  to2DArray,
  type ArrayResult,
  type SpillExtent,
} from './dynamic-arrays.js';
// (LambdaValue / applyLambdaValue are exported with the named-range API above.)
// PivotTable moved to @icecream-sheets/service (service-layer component per
// design-docs/native-reports-and-dashboards.md §1). Import from there.
// Solver service component (track 7, data-tools): GRG-class nonlinear
// optimization, Goal Seek, and Data Tables. Pure; the caller supplies an
// evaluator callback implemented over the typed view.
export {
  SOLVER_SPEC_VERSION,
  solve,
  goalSeek,
  computeOneVarTable,
  computeTwoVarTable,
  type SolverConstraint,
  type SolverConstraintOp,
  type SolverEvaluator,
  type SolverObjective,
  type SolverOptions,
  type SolverResult,
  type SolverSpec,
  type GoalSeekOptions,
  type GoalSeekResult,
  type OneVarDataTableSpec,
  type TwoVarDataTableSpec,
  type DataTableEvaluator,
} from './solver.js';
// What-If Scenario Manager (track 7): pure scenario data helpers.
export {
  SCENARIO_SPEC_VERSION,
  createScenarioSet,
  addScenario,
  deleteScenario,
  editScenario,
  captureScenario,
  scenarioWrites,
  scenarioSummary,
  type Scenario,
  type ScenarioSet,
} from './whatif.js';
// Flash Fill — deterministic inference (track 16,
// design-docs/deterministic-inference.md): pattern synthesis producing
// inspectable proposals. Pure; reads plain strings from the typed view.
export {
  FLASHFILL_SPEC_VERSION,
  analyzeFlashFill,
  analyzeFlashFillTwoCol,
  instantiateFormula,
  type FlashFillProposal,
} from './flashfill.js';
// Adapter registry (track 9): extension/name -> StorageAdapter resolution.
export { AdapterRegistry, defaultAdapters } from './adapters.js';
export type { AdapterRegistration } from './adapters.js';
// Workbook & sheet protection (track 19,
// design-docs/workbook-protection-and-encryption.md). v1 = protection
// enforcement here + at-rest encryption in @icecream-sheets/service.
// Enforcement via Authorizer policy wrapper.
export {
  ProtectionManager,
  hashPassword,
  randomSalt,
  sha256Hex,
  parseA1CellRef,
  parseA1RangeRef,
  DEFAULT_SHEET_OPTIONS,
  PROTECTION_WORKBOOK_META_KEY,
  PROTECTION_SHEET_META_PREFIX,
  PROTECTION_HIDDEN_META_PREFIX,
  PROTECTION_CELLFLAGS_META_PREFIX,
} from './protection.js';
export type {
  ProtectionAuditRecord,
  SheetProtectionOptions,
  SheetProtectionState,
  WorkbookProtectionState,
  CellProtectionFlags,
} from './protection.js';
// Collaboration foundation (track 10): OT ops, presence, change tracking.
// Real-time transport is v2; these are the data structures.
export { CollabSession, ops, transform } from './collaboration.js';
// Offline op log: typed mutation log with replay + conflict detection
// (companion to the real-time OT in collaboration.ts).
export { OpLog, replay, detectConflicts } from './oplog.js';
export type { Op, OpInput, OpKind, OpApplier, OpConflict } from './oplog.js';
export type {
  ChangeRecord,
  CollabOp,
  CollabOpType,
  CollabSessionOptions,
  Presence,
} from './collaboration.js';
// Formula localization (track 22): locale packs for function names.
export {
  registerLocales,
  localizeFunctionName,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './localization.js';
// Volatile function recalculation policy.
export {
  VOLATILE_FUNCTIONS,
  isVolatileFormula,
  shouldRecalcVolatile,
  type CalcMode,
} from './volatile.js';
// Iterative calculation settings.
export {
  DEFAULT_ITERATIVE,
  normalizeIterative,
  iterateUntilConverged,
  type IterativeSettings,
} from './iterative.js';
// Parallel recalculation (track 13, Cycle 10 chain partitioning): worker
// pool over independent calc chains. Web Workers (browser) +
// worker_threads (Node) behind one WorkerBackend abstraction;
// InlineWorkerBackend is the single-threaded fallback with identical
// results. Multithreading is an execution strategy, not a routing tier —
// this module decides HOW a large recalculation executes on whichever
// engine host runs it.
export {
  clearPartitionCache,
  executePartition,
} from './parallel/worker-logic.js';
export {
  planPartitions,
  type PlanPartitionsOptions,
} from './parallel/partition.js';
export {
  RecalcWorkerPool,
  InlineWorkerBackend,
  NodeWorkerBackend,
  defaultWorkerBackendFactory,
} from './parallel/pool.js';
export {
  ParallelRecalculator,
} from './parallel/parallel-recalc.js';
export type {
  JsonValue,
  PartitionSheet,
  BoundaryCell,
  RecalcPartition,
  PartitionPlan,
  RecalcRequest,
  RecalcResponse,
  WorkerBackend,
  WorkerBackendFactory,
  ParallelRecalcOptions,
  ParallelRecalcStats,
} from './parallel/types.js';
export {
  DEFAULT_MIN_FORMULA_CELLS,
  DEFAULT_PARALLEL_CELL_THRESHOLD,
  MAX_WORKERS,
  defaultWorkerCount,
  defaultParallelOptions,
  normalizeParallelOptions,
  resolveParallelCellThreshold,
  shouldEnableParallelRecalc,
} from './parallel/types.js';
export {
  NamedRangeRegistry,
  isValidDefinedName,
  quoteSheetNames,
} from './names.js';
export type {
  NamedRangeRegistryOptions,
  NameScope,
  NamedRangeDef,
  ResolvedNamedRange,
  NameAuthorizeHook,
} from './names.js';
export {
  NamedFunctionRegistry,
  NamePermissionError,
  stripTypeScript,
  withFunctionCallContext,
  getFunctionCallContext,
  interpreterToJs,
  invokeRunner,
} from './names-functions.js';
export type {
  NamedFunctionRegistryOptions,
  NamedFunctionLanguage,
  NamedFunctionType,
  NamedFunctionParam,
  NamedFunctionSignature,
  NamedFunctionDef,
  NamedFunctionVersion,
  DefineFunctionInput,
  FunctionCallContext,
} from './names-functions.js';
// Versioned function registry (design-docs/platform-shell.md §5) — the
// source of truth for the function inventory. Hosts generate their function
// lists from it (packages/engine/scripts/gen-function-list.mjs) and compare
// FUNCTION_LIST_VERSION against FUNCTION_REGISTRY_VERSION to detect stale
// bundled lists.
export {
  FUNCTION_REGISTRY_VERSION,
  getFunctionRegistry,
  getRegistryMetadataKeys,
  getRegistryPluginVersions,
  type FunctionRegistryEntry,
} from './function-registry.js';
