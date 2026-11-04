/**
 * Automation lane — Node-only entrypoint.
 *
 * Sandboxed script execution (node:vm for JavaScript, child_process for
 * Python) and the event runtime that drives triggers. Import from
 * '@icecream-sheets/service/automation-node', never from the browser
 * bundle. Browser-safe pieces live in './index.js'.
 */
export {
  BRIDGE_METHODS,
  createBridgeHandler,
  runJavaScriptAutomation,
  runPythonAutomation,
  type AutomationSandboxOptions,
  type AutomationSandboxResult,
  type BridgeHandler,
  type ScriptRunOptions,
} from './sandbox.js';

export {
  TriggerRuntime,
  triggerPrincipal,
  type RunReport,
  type TriggerRuntimeOptions,
} from './runtime.js';

export {
  SessionTriggerHost,
  TRIGGER_GRANTS_KEY,
  type SessionTriggerHostOptions,
  type TriggerGrantRecord,
  type TriggerLastRun,
  type TriggerStatus,
} from './host.js';

// Compatibility runner for unmigrated Windows automation
// (design-docs/automation-lane.md §6): isolated child-process execution,
// never inside the engine process.
export {
  CompatRunner,
  compatCellKey,
  replayCompatActions,
  runPreservedMacroProject,
  runUnmigratedWindowsAutomation,
  snapshotCells,
  validateCompatAction,
  type CompatAction,
  type CompatCellValue,
  type CompatFailureCode,
  type CompatOpaquePayload,
  type CompatPayload,
  type CompatResult,
  type CompatRunOptions,
  type CompatScriptPayload,
  type UnmigratedRunOptions,
  type UnmigratedRunReport,
  type WindowsAutomationSource,
} from './compatRunner.js';
