/**
 * Data-analysis + visualization pipeline (design-docs: data-analysis component).
 *
 * General pipeline for ALL analytical requests:
 *   user asks -> classify intent + extract schema -> generate Python (AI step)
 *   -> deterministic sandboxed execution -> { analysis, chartSpec } ->
 *   Chart.js visual rendered by ChartCanvas.
 *
 * The component reads through the typed computational view (host-supplied
 * reader port) and never touches the engine or storage directly.
 */
export {
  a1Ref,
  detectHeaderRow,
  extractDataSchema,
  numericColumns,
  categoricalColumns,
  forceTextColumn,
  type CellInput,
  type RangeRef,
  type RangeReader,
  type NumericStats,
  type CategoricalStats,
  type DateStats,
  type ColumnStats,
  type ColumnInfo,
  type DataSchema,
  // Aliased: packages/service already exports the ETL lane's ExtractOptions
  // (pagination/cursor); this one is the schema-extraction option bag.
  type ExtractOptions as AnalysisExtractOptions,
} from './schema.js';

export {
  ANALYSIS_INTENT_KINDS,
  classifyAnalysisIntent,
  routeChatIntent,
  isAnalysisPrompt,
  type AnalysisIntentKind,
  type AnalysisPlan,
  type ChatIntentRoute,
} from './planner.js';

export {
  HORIZONTAL_YEAR_MIN,
  HORIZONTAL_YEAR_MAX,
  HORIZONTAL_YEAR_MIN_RUN,
  detectHorizontalYearLayout,
  transposeHorizontalYearGrid,
  type HorizontalYearLayout,
} from './horizontal.js';

export {
  ANALYSIS_SCRIPT_VERSION,
  MAX_GENERATED_BYTES,
  TemplatePythonGenerator,
  FreeformPythonGenerator,
  buildFreeformPrompt,
  validatePythonSource,
  resolvePlan,
  type PythonGenerator,
  type FreeformSource,
  type ResolvedPlan,
} from './generator.js';

export {
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  MAX_ANALYSIS_TIMEOUT_MS,
  MAX_ANALYSIS_INPUT_BYTES,
  MAX_ANALYSIS_OUTPUT_BYTES,
  executeAnalysis,
  extractScriptVersion,
  type PythonRunner,
  type AnalysisInput,
  type AnalysisValue,
  type SandboxOutcome,
  type AnalysisSuccess,
  type AnalysisFailure,
  type AnalysisResult,
  type ExecuteOptions,
} from './executor.js';

export {
  validateAnalysisChartSpec,
  toChartConfiguration,
  colorFor as analysisColorFor,
  type AnalysisChartType,
  type AnalysisChartDataset,
  type AnalysisChartSpec,
} from './chartspec.js';

export {
  ANALYSIS_ARTIFACT_VERSION,
  ANALYSIS_STORE_KEY,
  createAnalysisStore,
  createAsyncAnalysisStore,
  serializeAnalyses,
  deserializeAnalyses,
  migrateAnalysis,
  makeArtifact,
  hashInput,
  analysisSummary,
  type AnalysisArtifact,
  type StoredAnalyses,
} from './artifact.js';

export {
  createAnalysisPort,
  toChartJsVisualSpec,
  type AnalysisPortDeps,
} from './port.js';
