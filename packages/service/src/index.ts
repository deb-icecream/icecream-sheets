/**
 * @icecream-sheets/service — service-layer components.
 *
 * Per design-docs/native-reports-and-dashboards.md §1, the report builder and
 * renderer are service-layer components: they read through the typed
 * computational view and never touch the engine or storage directly.
 *
 * The automation lane (design-docs/automation-lane.md) is the deliberate
 * exception: its permissioned API wraps the versioned engine protocol, and
 * every call goes through authorize() with a principal identity. There is
 * no privileged path. Node-only pieces (sandboxed execution, trigger
 * runtime) are exported from '@icecream-sheets/service/automation-node'
 * and are not re-exported here, keeping this entrypoint browser-safe.
 *
 * Everything exported here is headless (no DOM), so it runs identically on
 * web, desktop, and the MCP server.
 */

// PivotTable component (pure functions over records read via TypedView).
export {
  PIVOT_SPEC_VERSION,
  PIVOT_AGGREGATIONS,
  PIVOT_DATE_UNITS,
  createPivot,
  refreshPivot,
  getPivotValue,
  recordsFromGrid,
  pivotToMatrix,
  applyGroupings,
  groupDateValue,
  groupNumericValue,
  groupCustomValue,
  isPivotGroupValue,
  type PivotAggregation,
  type PivotValueField,
  type PivotFilter,
  type PivotSpec,
  type PivotRecord,
  type PivotResult,
  type PivotGrouping,
  type PivotDateGrouping,
  type PivotNumericGrouping,
  type PivotCustomGrouping,
  type PivotCustomGroup,
  type PivotDateUnit,
  type PivotGroupValue,
} from './pivot.js';

// Imported XLSX pivot tables → service PivotSpec/PivotResult mapping, plus
// the engine-registry wiring (GETPIVOTDATA + OLAP cubes) both hosts need on
// file open: the web app's local open flow and the engine service's /load
// (Cycle 10 — the registries live in whichever process runs the engine).
export {
  importedPivotsFromMetadata,
  pivotPartsFromMetadata,
  importedPivotToSpec,
  importedPivotRecords,
  buildImportedPivotResult,
  importedPivotSourceRange,
  importedPivotMatrix,
  registerImportedPivotsForEngine,
  type ImportedPivotSourceRange,
  type RegisteredImportedPivot,
} from './importedPivots.js';

// OLAP data-model cubes rebuilt from worksheet ranges (CUBE* functions):
// same both-hosts rationale — the cube registers in the engine's process.
export {
  connectionsFromMetadata,
  cubeConnectionNamesFromSheets,
  dimensionHintsFromSheets,
  parseConnectionRangeRef,
  buildCubeFromRange,
  registerDataModelCubes,
  type ImportedConnection,
  type ParsedRangeRef,
} from './cubeDataModels.js';

// Data-model source built at open from worksheet ranges (#114, Piece 2).
export {
  buildDataModel,
  parseAnchorRef,
  parseDimensionField,
  parseMeasureBase,
  splitMdxName,
  type DataModelBuild,
  type DataModelBuildInput,
  type DataModelPivot,
} from './dataModel.js';

// Chart component core (versioned spec + chart.js config builder).
export {
  CHART_SPEC_VERSION,
  ALL_KINDS,
  CHART_GROUPS,
  CHART_PALETTE,
  a1RangeString,
  boxPlotStats,
  buildChartConfig,
  colIndexToLetters,
  colLettersToIndex,
  colorFor,
  contourGeometry,
  extractSeries,
  extractSeriesFromRanges,
  groupLabelForKind,
  histogramBins,
  is3DKind,
  isSvgKind,
  isUnsupportedKind,
  kindLabel,
  lerpColor,
  makeChartSpec,
  migrateChart,
  numericValues,
  paretoTransform,
  parseA1Range,
  splitCompoundPie,
  stockColumns,
  sturgesBinCount,
  surfaceGeometry,
  surfaceGrid,
  toPercentStacked,
  waterfallSegments,
  dataLabelsPlugin,
  boxWhiskerPlugin,
  THREE_D_FALLBACK,
  UNSUPPORTED_KINDS,
  type BoxStats,
  type BuiltConfig,
  type BuiltDetailChart,
  type CellReader,
  type ChartDataset,
  type ChartGroup,
  type ChartKind,
  type ChartKindEntry,
  type ChartRange,
  type ChartSeries,
  type ChartSeriesRange,
  type ChartSpec,
  type CompoundPieSplit,
  type ContourBand,
  type ContourGeometry,
  type ContourLevelLine,
  type Histogram,
  type LegendPosition,
  type ParetoData,
  type SheetCellReader,
  type StockColumns,
  type SurfaceGeometry,
  type SurfaceGrid,
  type SurfacePoint,
  type SurfaceQuad,
  type WaterfallData,
} from './chartModel.js';
// Chart.js configuration type used by ChartSpec.config; re-exported so
// hosts (web UI) can type chart configs without importing chart.js directly.
export type { ChartConfiguration } from 'chart.js';

// Trendlines (Excel: Format Trendline) — pure fitting math + chart.js
// config augmentation.
export {
  TRENDLINE_TYPES,
  addTrendlinesToConfig,
  fitTrendline,
  forecastTrendline,
  formatTrendCoef,
  trendlineDatasets,
  trendlineEquation,
  trendlineLabel,
  trendlineRSquared,
  type TrendlineDataset,
  type TrendlineSpec,
  type TrendlineType,
} from './trendline.js';

// PivotCharts — charts bound to live pivot results.
export {
  describePivotBinding,
  isPivotChartFileBinding,
  pivotBindingFromFile,
  pivotBindingToFile,
  pivotResultToSeries,
  type PivotChartBinding,
  type PivotChartFileBinding,
  type PivotChartOrientation,
} from './pivotChart.js';

// Filled-map (choropleth) geometry: bundled world boundaries, country
// lookup, color scaling and pure-SVG rendering (mapGeometry.ts).
export {
  MAP_LOW_COLOR,
  MAP_HIGH_COLOR,
  MAP_NO_DATA_COLOR,
  resolveCountry,
  mapColorScale,
  mapSeriesToCountries,
  projectLonLat,
  countryPathData,
  buildMapSvg,
  type MapRegion,
  type MapData,
  type MapSvgOptions,
} from './mapGeometry.js';
export { WORLD_COUNTRIES, type WorldCountry } from './worldGeo.js';

// Service metadata store (versioned specs live here, not in client state).
export {
  MetadataStore,
  memoryPersistence,
  createChartStore,
  createPivotStore,
  createReportStore,
  createAsyncReportStore,
  createAppStore,
  createAsyncAppStore,
  createArtifactStore,
  createDataSourceStore,
  createAsyncDataSourceStore,
  serializeCharts,
  deserializeCharts,
  serializePivots,
  deserializePivots,
  serializeApps,
  deserializeApps,
  serializeArtifacts,
  deserializeArtifacts,
  type Persistence,
  type SourceBinding,
  type StoredApps,
  type StoredArtifacts,
  type StoredCharts,
  type StoredPivots,
  type StoredReports,
} from './metadataStore.js';

// At-rest encryption wiring (design-docs/workbook-protection-and-encryption.md
// §§3, 4, 7): KeyManager-backed encrypted persistence for the service
// storage, per-workbook encrypted document storage, and the async metadata
// surface. This is where the §3 "encrypted at rest" requirement is met.
export {
  AsyncMetadataStore,
  EncryptedPersistence,
  EncryptedWorkbookStore,
  SECURE_STORAGE_PREFIX,
  SERVICE_SCOPE_ID,
  WORKBOOK_STORAGE_PREFIX,
  PASSWORD_KEY_ID_PREFIX,
  createEncryptedServiceStores,
  createEncryptedPendingAskStore,
  memoryAsyncPersistence,
  toAsyncPersistence,
  type AsyncPersistence,
  type CreateEncryptedStoresOptions,
  type EncryptedServiceStores,
  type WorkbookLoadOptions,
  type WorkbookSaveOptions,
} from './secureStore.js';

// Firestore-backed MCP metadata persistence (durable-store migration) is
// deliberately NOT re-exported here: firestoreMetadata.ts imports
// node:crypto, and this barrel is bundled for the browser by the web app.
// It lives behind the node-only subpath entry instead:
//   import { FirestoreMetadataPersistence } from '@icecream-sheets/service/firestore-node'

// Native reports & dashboards: versioned ReportSpec, KPI card, slicers.
// (design-docs/native-reports-and-dashboards.md §2–§6)
export {
  REPORT_SPEC_VERSION,
  makeReportSpec,
  migrateReportSpec,
  migrateBinding,
  migrateCalculatedFields,
  migrateVisual,
  migrateRefresh,
  migrateLayout,
  validateReportSpec,
  serializeReports,
  deserializeReports,
  isRefreshDue,
  collectEtlRecipeIds,
  type ReportBinding,
  type ReportVisual,
  type ReportVisualBase,
  type ReportVisualKind,
  type ReportLayout,
  type ReportLayoutCell,
  type RefreshMode,
  type RefreshSchedule,
  type ReportRefresh,
  type ReportSpec,
  type StoredReports as StoredReportSpecs,
} from './reports/spec.js';

export {
  KPI_SPEC_VERSION,
  KPI_AGGREGATIONS,
  KPI_STATUSES,
  makeKpiSpec,
  validateKpiSpec,
  computeKpi,
  type KpiAggregation,
  type KpiStatus,
  type KpiThreshold,
  type KpiFormat,
  type KpiSpec,
  type KpiResult,
} from './reports/kpi.js';

// Calculated fields: formula-language fields over the bound row
// (design-docs/native-reports-and-dashboards.md §3). Evaluated with the
// engine's formula evaluator; usable everywhere a column-bound field is.
export {
  CalculatedFieldEvaluator,
  extractFieldReferences,
  materializeCalculatedFields,
  normalizeCalculatedExpression,
  validateCalculatedField,
  type CalculatedField,
  type CalculatedValue,
} from './reports/calculatedFields.js';

export {
  HEATMAP_SPEC_VERSION,
  HEATMAP_NO_DATA_COLOR,
  buildHeatmap,
  makeHeatmapSpec,
  heatmapFromRecords,
  correlationHeatmap,
  type HeatmapSpec,
  type HeatmapCell,
  type BuiltHeatmap,
} from './reports/heatmap.js';

export {
  REPORT_FILTER_OPS,
  makeReportSlicer,
  clearReportSlicer,
  toggleSlicerValue,
  slicerPasses,
  slicerLabelOf,
  distinctFieldValues,
  slicerAppliesToBinding,
  applySlicers,
  filterPasses,
  applyReportFilters,
  applyFiltersAndSlicers,
  validateReportSlicer,
  validateReportFilter,
  type ReportFilter,
  type ReportFilterOp,
  type ReportSlicer,
} from './reports/slicers.js';

// Report refresh through the ETL pipeline
// (design-docs/native-reports-and-dashboards.md §6).
export {
  refreshReportEtlBindings,
  type EtlRefreshPort,
  type EtlRefreshCompleted,
  type EtlRefreshThrown,
  type EtlRefreshSummary,
} from './reports/etlRefresh.js';

// Per-subject report views (design-docs/native-reports-and-dashboards.md §7):
// authorize()-backed view gating + per-cell filtering (hidden → #PERM!).
export {
  PERM_DENIED_CELL,
  reportCellTarget,
  reportRangeTarget,
  canSubjectReadCell,
  canSubjectWriteCell,
  subjectCellAccess,
  filterBindingRecordsForSubject,
  filterReportForSubject,
  canViewReport,
  type AuthorizePort,
  type SubjectCellAccess,
} from './reports/reportPermissions.js';

// Deterministic pagination engine (design-docs/print-and-page-layout.md §1):
// page breaks from the print snapshot (row heights, column widths, page
// setup, print titles/area, manual breaks). Pure + deterministic.
export {
  PAPER_SIZES_IN,
  PX_PER_INCH,
  DEFAULT_PRINT_SETUP,
  paginateSheet,
  type PageOrientation,
  type PaperSize,
  type PageMargins,
  type PrintPageSetup,
  type UsedRange,
  type PrintSnapshot,
  type PaginatedPage,
} from './pagination.js';

// Manual page breaks (design-docs/print-and-page-layout.md §2, §5): the
// canonical model; persists as `icecream.pagebreaks.<sheet>` metadata.
export {
  PAGE_BREAKS_METADATA_PREFIX,
  EMPTY_PAGE_BREAKS,
  pageBreaksMetadataKey,
  insertRowBreak,
  removeRowBreak,
  insertColBreak,
  removeColBreak,
  resetPageBreaks,
  hasPageBreaks,
  pageBreaksToMetadata,
  pageBreaksFromMetadata,
  type PageBreaks,
} from './pageBreaks.js';

// Native Download-as-PDF (design-docs/print-and-page-layout.md §3): pure-TS
// PDF 1.4 renderer driven by the pagination engine. No window.print().
export {
  DEFAULT_PDF_CREATED,
  measureTextPt,
  fitText,
  parseJpegDimensions,
  pdfNum,
  pdfString,
  renderPdfDocument,
  renderGenericPdfDocument,
  renderSheetPdf,
  type GenericPdfOptions,
  type PdfGenericPage,
  type PdfImageXObject,
  type PdfPageInput,
  type RenderPdfOptions,
  type SheetPdfInput,
} from './pdf.js';

// Native report PDF (design-docs/native-reports-and-dashboards.md §8):
// report blocks → paginated PDF bytes through the Download-as-PDF path.
export {
  renderReportPdf,
  type RenderReportPdfInput,
  type ReportPdfBlock,
  type ReportPdfCell,
  type ReportPdfKpi,
} from './reportPdf.js';

// ETL pipeline component (design-docs/etl-pipeline.md): versioned recipe DAG,
// fetch component + connector SDK, typed transform library, sandboxed custom
// transforms, atomic loads with version retention, run history.
export * from './etl/index.js';
// Power Query M-language translator: M queries -> equivalent ETL recipes.
export {
  MParseError,
  MTranslateError,
  parseM,
  translateM,
  type MAst,
  type MQuery,
  type MStep,
  type MTranslateOptions,
  type MTranslateResult,
  type MWarning,
} from './mLanguage.js';
// Columnar DataFrame storage (Python/pandas handoff, ETL bridge).
export { DataFrame, type DfAgg, type DfColumn, type DfColumnType, type DfGroupAgg, type DfValue } from './dataframe.js';
// Collaboration server: server-sequenced operation log with vector clocks.
export {
  CollabServer,
  ServerDocument,
  clockDominates,
  type CollabServerOptions,
  type DocumentStats,
  type ServerOp,
  type SubmitRejectionReason,
  type SubmitResult,
  type VectorClock,
} from './collabServer.js';
// Canonical connector registry (design-docs/etl-pipeline.md §2 — the single
// registry ETL source nodes consume). RESOLVED 2026-10-18: one registry.
export {
  ConnectorRegistry,
  createConnectorRegistry,
  type ConnectorSpec,
  type ConnectorKind,
} from './connectors/index.js';
// Google-connector formula host wiring (Cycle-3 GAP-1): the service-layer
// host that resolves the vault Google credential into the engine's
// TRANSLATE/DETECTLANGUAGE/IMPORTRANGE seams.
export {
  wireGoogleFormulaSeams,
  makeGoogleCloudTranslator,
  makeGoogleCloudLanguageDetector,
  DEFAULT_GOOGLE_CREDENTIAL_REF,
  type GoogleAuthMode,
  type GoogleFormulaSeamsOptions,
  type GoogleFormulaSeamStatus,
} from './connectors/index.js';
// Service component inside the web-service boundary; acts only through
// versioned MCP tools, never a private path to the engine.
export {
  AgentRuntime,
  DEFAULT_AGENT_MAX_INPUT_CHARS,
  DEFAULT_AGENT_MAX_CONCURRENT_TURNS,
  DEFAULT_AGENT_MAX_TURNS_PER_MINUTE,
  DEFAULT_AGENT_MAX_REPLY_CHARS,
  AGENT_BUSY_MESSAGE,
  AGENT_SCOPE_DECLINE_MESSAGE,
  agentInputTooLongMessage,
  agentRateLimitMessage,
  type AgentRuntimeOptions,
} from './agent/runtime.js';
export {
  AGENT_THREAD_VERSION,
  MAX_THREAD_MESSAGES,
  AGENT_THREAD_KEY_PREFIX,
  createAgentThreadStore,
  deserializeThreads,
  migrateThread,
  newThread,
  serializeThreads,
  type AgentThread,
  type StoredThreads,
} from './agent/threads.js';
// Agent workflows (design-docs/agent-workflows.md §2): the durable
// plan-as-data records — steps, checkpoints, resume state — persisted
// per user alongside the threads.
export {
  AGENT_WORKFLOW_VERSION,
  AGENT_WORKFLOW_KEY_PREFIX,
  MAX_STORED_WORKFLOWS,
  createAgentWorkflowStore,
  deserializeWorkflows,
  migrateWorkflow,
  newStepRecord,
  sanitizeStepCheck,
  serializeWorkflows,
  type AgentWorkflow,
  type StoredWorkflows,
  type WorkflowStatus,
  type WorkflowStepRecord,
  type WorkflowStepStatus,
} from './agent/workflows.js';
// Human-in-the-loop pending asks (ai-agent.md §12): the single shared
// store behind the agent.ask_question / agent.offer_options /
// agent.request_approval / agent.answer_pending / agent.list_pending tools.
export {
  PendingAskStore,
  createPendingAskStoreOver,
  parseApprovalAnswer,
  toPendingAskView,
  serializePendingAsks,
  deserializePendingAsks,
  DEFAULT_HITL_TIMEOUT_MS,
  PENDING_ASK_KEY,
  PENDING_ASK_VERSION,
  type PendingAsk,
  type PendingAskBackend,
  type PendingAskKind,
  type PendingAskView,
  type CreatePendingAsk,
} from './agent/pendingAsks.js';
export {
  NO_MODEL_CONFIGURED_MESSAGE,
  NoModelConfiguredBackend,
  NoModelConfiguredError,
  parseRangeRef,
  parseA1Cell,
  colLettersToIndex as agentColLettersToIndex,
  type ParsedRange,
} from './agent/backends.js';
// Pluggable model backends (ai-agent.md §8): the shipped default plus the
// user-configurable OpenAI-compatible provider (key from the vault).
export {
  OpenAICompatibleBackend,
  SYSTEM_PROMPT as AGENT_SYSTEM_PROMPT,
  validatePlan as validateOpenAIPlan,
  type OpenAICompatibleBackendOptions,
} from './agent/openaiBackend.js';
// Agent service config: per-user model provider selection persisted in the
// service metadata store; DelegatingModelBackend re-resolves per plan().
export {
  AgentConfigStore,
  DelegatingModelBackend,
  createEnvModelBackend,
  createModelBackend,
  defaultAgentSettings,
  isModelProviderId,
  modelKeyRef,
  MODEL_PROVIDERS,
  type AgentModelConfig,
  type AgentServiceSettings,
  type BackendFactoryDeps,
  type ModelProviderId,
} from './agent/config.js';
// Proactive event subscriptions (ai-agent.md §6): the wake loop with
// batching, rate-limiting and per-user persisted mute.
export {
  ProactiveWatcher,
  buildContext,
  defaultMuteConfig,
  isProactiveEventType,
  summarizeBatch,
  PROACTIVE_EVENT_TYPES,
  type ProactiveContext,
  type ProactiveDecider,
  type ProactiveDecision,
  type ProactiveEvent,
  type ProactiveEventType,
  type ProactiveMuteConfig,
  type ProactiveWake,
  type ProactiveWatcherDeps,
  type ProactiveWatcherOptions,
  type ProactiveWatchRequest,
} from './agent/proactive.js';

// AI-generated app artifacts (chat-generated React apps, embedded).
// The spec lives in the service metadata store; the sandboxed iframe talks
// to the product MCP server through the bridge protocol only.
export * from './artifacts/index.js';
export type {
  AgentRole,
  AgentMessage,
  AgentChartAttachment,
  ToolCallAction,
  AskAction,
  DoneAction,
  AgentAction,
  ToolResultRecord,
  PlannerInput,
  PlannerOutput,
  ModelBackend,
  AuditKind,
  AuditEntry,
  PendingInput,
  AgentReply,
  StepCheck,
  JobStep,
  JobPlan,
  JobPlanInput,
  WorkflowEventPayload,
} from './agent/types.js';

// Chat intent router (app generation vs data analysis vs conversation).
export {
  classifyIntent,
  classifyScope,
  type ScopeVerdict,
  isAmbiguous,
  routePrompt,
  resolveDisambiguation,
  dispatchIntent,
  registerIntentPorts,
  unregisterIntentPorts,
  getIntentPorts,
  INTENT_CONFIDENCE_THRESHOLD,
  DISAMBIGUATION_QUESTION,
  DISAMBIGUATION_QUESTION_WITH_CHART,
  DISAMBIGUATION_OPTIONS,
  NATIVE_CHART_OPTION,
  NATIVE_DIAGRAM_OPTION,
  disambiguationOptionsFor,
  disambiguationQuestionFor,
  hasExplicitNativeChartIntent,
  hasExplicitNativeDiagramIntent,
  mentionsChart,
  mentionsDiagram,
  type IntentKind,
  type IntentClassification,
  type RoutingContext,
  type IntentRoute,
  type DisambiguationOption,
  type AppArtifactMeta,
  type AppGenerationRequest,
  type AppGenerationResult,
  type AppGenerationPort,
  type AnalysisRequest,
  type AnalysisResult,
  type AnalysisPort,
  type DiagramPort,
  type DiagramCreationResult,
  type ChartJsVisualSpec,
  type IntentPorts,
  type IntentDispatchResult,
} from './agent/intentRouter.js';

// In-sheet diagram spec derivation from a chat prompt (#126, no LLM).
export {
  deriveDiagramSpec,
  type DiagramLayout,
  type DerivedDiagramSpec,
} from './agent/diagramSpec.js';

// Data-analysis + visualization pipeline (design-docs: data-analysis
// component): schema extraction, intent classification, Python generation,
// deterministic sandboxed execution, versioned artifacts. Headless.
export * from './analysis/index.js';

// At-rest encryption + service key management
// (design-docs/workbook-protection-and-encryption.md §§3, 4, 7).
export {
  KeyManager,
  KEYS_STORAGE_KEY,
  KEYS_RECORD_VERSION,
  encryptBytes,
  decryptBytes,
  deriveKeyFromPassword,
  generateDataKey,
  exportKeyRaw,
  importKeyRaw,
  randomBytes,
  bytesToB64,
  b64ToBytes,
  encryptWorkbook,
  decryptWorkbook,
  type EncryptedBytes,
  type EncryptedWorkbook,
  type KeyRecord,
  type KeyStatus,
} from './crypto.js';

// JWT identity — identity only, never per-object permissions
// (design-docs/permission-model.md §5).
export {
  issueToken,
  verifyToken,
  principalFromToken,
  type IssueOptions,
  type VerifyOptions,
  type VerifiedClaims,
} from './auth.js';

// Credential vault: secrets live here; recipes store only references
// (design-docs/etl-pipeline.md §6).
export {
  CredentialVault,
  VAULT_KEY_ID,
  VAULT_STORAGE_KEY,
  VAULT_RECORD_VERSION,
  type CredentialVaultOptions,
  type VaultAction,
  type VaultCheck,
} from './vault.js';

// Access table + policy: the single authorize() choke point
// (design-docs/permission-model.md §§1-4).
export {
  AccessTable,
  ACCESS_STORAGE_KEY,
  ACCESS_RECORD_VERSION,
  accessPolicy,
  targetToObjectId,
  parseObjectId,
  workbookObjectId,
  sheetObjectId,
  rangeObjectId,
  cellObjectId,
  namedRangeObjectId,
  type AccessLevel,
  type AccessEntry,
  type AccessRequestEntry,
  type AccessAuditEntry,
  type AccessAuditKind,
  type PolicyFn,
} from './access.js';

// Workbook library: New/Open/Make-a-copy over the service metadata store
// (design-docs/platform-shell.md §2). copy() enforces the manage right on
// the workbook via authorize() before duplicating bytes or metadata.
export {
  WorkbookLibrary,
  type WorkbookEntry,
  type WorkbookByteStore,
  type WorkbookLibraryOptions,
} from './library.js';

// Named ranges + named functions (design-docs/named-ranges-and-named-functions.md).
// Browser-safe surface: stable-id model, scope rules, versioned function
// registry, engine binding, XLSX round-trip helpers, sharing façade. The
// sandboxed execution runtime lives in '@icecream-sheets/service/names-node'.
export {
  NameError,
  nameKey,
  scopeKey,
  validateNameSyntax,
  isValidDefinedName,
  NAMED_VALUE_TYPES,
  isNamedValueType,
  NAMED_FUNCTION_LANGUAGES,
  isNamedFunctionLanguage,
  quoteSheetName,
  unquoteSheetName,
  formatAbsoluteRef,
  parseDefinedNameRef,
  refToTarget,
  NamedRangeStore,
  NamedFunctionRegistry,
  validateSignature,
  validatedSource,
  stripTypeScript,
  compileToLambda,
  extractExpressionBody,
  isExpressionSyntax,
  isFunctionBodySyntax,
  transpileJsExpressionToFormula,
  parseLambdaRef,
  bindNamedRanges,
  bindNamedFunctions,
  bindForSubject,
  bindAll,
  unbindAll,
  PERM_DENIED_EXPR,
  SharingService,
  isShareLevel,
  type NamedRangeDef,
  type NameRangeRef,
  type NameScope,
  type NamedValueType,
  type NamedFunctionParam,
  type NamedFunctionSignature,
  type NamedFunctionLanguage,
  type NamedFunctionVersion,
  type NamedFunctionDef,
  type NameErrorCode,
  type NameValidationOptions,
  type AuthorizeFn,
  type CreateNamedFunctionRegistryOptions,
  type CreateNamedRangeStoreOptions,
  type DefineNameInput,
  type DefinedNameLike,
  type NamedRangeStoreOptions,
  type NameResolution,
  type InvokeFn,
  type NamedFunctionRegistryOptions,
  type DefineFunctionInput,
  type UpdateFunctionInput,
  type NameEnginePort,
  type BindStats,
  type ShareLevel,
  type GrantRow,
  type AccessRequestRow,
  type AccessRequestOptions,
  type SharingServiceOptions,
} from './names/index.js';

// Sensitivity labels (service metadata): document marking + authorize-style
// access control (faces c/e of the protection model — NOT encryption).
export {
  SensitivityStore,
  createSensitivityStore,
  SENSITIVITY_LABELS,
  isSensitivityLabel,
  labelRank,
} from './sensitivity.js';
export type { SensitivityLabel, LabelAuditEntry } from './sensitivity.js';

// Add-on component: native add-in system for third-party code
// (design-docs/add-on-model.md). Worker-isolated execution, capability
// grants per document binding, every op through authorize().
export * from './addons/index.js';

// No-code app builder (design-docs/no-code-app-builder.md): versioned app
// spec, generation from tables, view-model logic with the per-subject
// permission-filtering seam, and action semantics. Service-layer component;
// the runtime reads/writes through the typed computational view via a
// host-supplied RowMutationPort (actions.ts) and never touches the engine
// or storage directly.
export {
  APP_SPEC_VERSION,
  COLUMN_TYPES,
  VIEW_KINDS,
  ACTION_KINDS,
  FILTER_OPS,
  validateAppSpec,
  migrateAppSpec,
  newAppId,
  specColumns,
  generateAppSpec,
  type ActionKind,
  type ActionSpec,
  type AppSpec,
  type AppSpecOptions,
  type ColumnSpec,
  type ColumnType,
  type DataSource,
  type DataSourceKind,
  type FilterOp,
  type FormMode,
  type NavigationSpec,
  type RangeBinding,
  type SliceFilter,
  type ViewKind,
  type ViewSpec,
} from './appbuilder/spec.js';
export {
  inferColumnType,
  inferColumns,
  recordsFromValues,
  dropTrailingBlankRows,
  applySliceFilter,
  applySubjectFilter,
  allowAllSubjectPolicy,
  viewColumns,
  displayValue,
  isDenied,
  type AppRecord,
  type CellInput,
  type FilteredView,
  type SubjectPolicy,
  type TableSnapshot,
} from './appbuilder/model.js';
export {
  executeAction,
  coerceValue,
  appTarget,
  AuthorizationError,
  ConfirmationRequiredError,
  ActionError,
  type ActionInvocation,
  type ActionOutcome,
  type RowMutationPort,
} from './appbuilder/actions.js';
// Product-owned sample app templates (no-code-app-builder.md §7).
export {
  APP_TEMPLATES,
  appTemplateIds,
  getAppTemplate,
  type AppTemplate,
} from './appbuilder/templates.js';

// Automation lane (design-docs/automation-lane.md): permissioned TypeScript
// API over the engine protocol, action recorder, versioned trigger specs
// and the VBA/Apps Script migration translator. Every call goes through
// authorize() with a principal identity — there is no privileged path.
// Browser-safe; sandboxed execution and the trigger runtime live in
// '@icecream-sheets/service/automation-node'.
export {
  AutomationApi,
  AutomationError,
  AUTOMATION_ACTIONS,
  ACTION_LOG_VERSION,
  ActionRecorder,
  TRIGGER_SPEC_VERSION,
  actionLogToScript,
  createActionLog,
  createTriggerSpec,
  createTriggerStore,
  deserializeTriggers,
  migrateTrigger,
  parseActionLog,
  permissionsForAction,
  replayActionLog,
  runUserScript,
  serializeActionLog,
  serializeTriggers,
  stripTypeAnnotations,
  translateAppsScript,
  translateVba,
  TypeStripError,
  validateAction,
  validateTriggerSpec,
  type ActionLog,
  type AutomationAction,
  type AutomationApiOptions,
  type AutomationCellFormat,
  type AutomationErrorCode,
  type AutomationPrincipal,
  type CalculationMode,
  type CellRef,
  type DeclaredPermission,
  type FilterCriterion,
  type PermissionGrantRecord,
  type RangeRef,
  type SheetInfo,
  type SortKey,
  type StoredTriggers,
  type TranslationResult,
  type TriggerEvent,
  type TriggerLanguage,
  type TriggerSpec,
  type TriggerSpecInit,
  type TypedValue,
  type UntranslatedLine,
  type UserScriptResult,
  type UserScriptRunOptions,
} from './automation/index.js';

// Deterministic inference (design-docs/deterministic-inference.md):
// autocomplete, formula suggestions, cleanup proposals — deterministic
// analyzers producing inspectable, reversible proposals. Separate from
// the AI Agent; nothing auto-applies.
export * from './inference/index.js';

// PY() result cache + dependency-graph invalidation index (browser-safe
// part of the pinned Python environment; the node-only env manager lives
// under '@icecream-sheets/service/python-env').
export {
  PyDependencyIndex,
  PythonResultCache,
  pythonCacheKey,
  sha256Hex,
  type CachedPythonResult,
  type PersistedPythonResultCacheOptions,
  type PythonResultCacheOptions,
} from './python/cache.js';

// Slicer → pivot binding (Excel parity): slicer selections filter bound
// pivot tables; versioned binding model + pure spec-merge helpers.
export {
  SLICER_BINDING_VERSION,
  applySlicersToPivotSpec,
  bindingsForPivot,
  bindSlicerToPivot,
  boundPivotIds,
  filterRecordsBySlicers,
  makeSlicerPivotBinding,
  removeSlicerFiltersFromSpec,
  slicerBindingLabelOf,
  slicerSelectionPasses,
  unbindSlicerFromPivot,
  validateSlicerPivotBinding,
  type SlicerPivotBinding,
  type SlicerSelection,
} from './slicer.js';

// Column statistics profiling (Data > Column Statistics): descriptive
// stats for a column — counts, type distribution, numeric aggregates,
// most-common values.
export {
  profileColumn,
  profileColumnSet,
  profileGrid,
  type ColumnProfile,
  type CommonValue,
  type ProfileColumnInput,
  type ProfileOptions,
  type TypeDistribution,
} from './profiling.js';

// Full Excel shape gallery (Insert > Shapes): 100+ autoshapes across
// Excel's 7 categories, as viewBox-100 SVG definitions.
export {
  SHAPE_CATEGORIES,
  SHAPE_COUNT,
  SHAPE_DEFS,
  isKnownShapeId,
  shapeDefById,
  shapesByCategory,
  type ShapeCategory,
  type ShapeCategoryId,
  type ShapeDef,
} from './shapes.js';

// Header/footer model with Excel field-code expansion (Page Setup >
// Header/Footer): &P &N &D &T &F &A codes, odd/even/first variants.
export {
  HEADER_FOOTER_VERSION,
  defaultHeaderFooter,
  emptyHFSection,
  expandHFCodes,
  expandHFSection,
  isHFEmpty,
  isHFSectionEmpty,
  renderHFSectionPreview,
  sectionForPage,
  validateHeaderFooter,
  type HeaderFooterSettings,
  type HFRenderContext,
  type HFSection,
} from './headerFooter.js';

// Web research contracts (service-boundary only: the engine keeps no
// ambient network/filesystem/clock; providers live server-side).
export {
  WEB_RESEARCH_PROTOCOL_VERSION,
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  MAX_WEB_SEARCH_MAX_RESULTS,
  DEFAULT_WEB_PAGE_MAX_CHARS,
  MAX_WEB_PAGE_MAX_CHARS,
  boundedSearchResultCount,
  boundedWebPageChars,
  normalizePublicWebUrl,
  isObviouslyPrivateHost,
  normalizeWebSearchResults,
  cleanText,
  cleanWebText,
  type WebSearchResult,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebPageFetchRequest,
  type WebPageFetchResponse,
  type WebResearchProvider,
} from './webResearch.js';
