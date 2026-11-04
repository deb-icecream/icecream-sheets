/**
 * Automation lane — browser-safe surface (design-docs/automation-lane.md).
 *
 * This entrypoint is safe to import in the browser: the permissioned API,
 * the action recorder, versioned trigger specs and the migration
 * translator are all pure TypeScript over the engine protocol. Sandboxed
 * execution (node:vm / child_process) lives in './node.js' and is
 * intentionally NOT re-exported here.
 */
export {
  AutomationApi,
  AutomationError,
  AUTOMATION_ACTIONS,
  type AutomationApiOptions,
  type AutomationCellFormat,
  type AutomationErrorCode,
  type AutomationPrincipal,
  type DeclaredPermission,
  type FilterCriterion,
  type PermissionGrantRecord,
  type SortKey,
} from './api.js';

export {
  ACTION_LOG_VERSION,
  ActionRecorder,
  actionLogToScript,
  createActionLog,
  parseActionLog,
  permissionsForAction,
  replayActionLog,
  serializeActionLog,
  validateAction,
  type ActionLog,
  type AutomationAction,
} from './recorder.js';

export {
  TRIGGER_SPEC_VERSION,
  createTriggerSpec,
  createTriggerStore,
  deserializeTriggers,
  migrateTrigger,
  serializeTriggers,
  validateTriggerSpec,
  type TriggerEvent,
  type TriggerLanguage,
  type TriggerSpec,
  type TriggerSpecInit,
  type StoredTriggers,
} from './triggerSpecs.js';

export {
  translateAppsScript,
  translateVba,
  type TranslationResult,
  type UntranslatedLine,
} from './translator.js';

export {
  stripTypeAnnotations,
  TypeStripError,
} from './tsStrip.js';

export {
  runUserScript,
  type UserScriptResult,
  type UserScriptRunOptions,
} from './userScript.js';

// Engine value types the generated/translated scripts reference.
export type {
  CalculationMode,
  CellInput,
  CellRef,
  RangeRef,
  SheetInfo,
  TypedValue,
} from '@icecream-sheets/engine';
