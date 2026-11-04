/**
 * Action recorder (design-docs/automation-lane.md §2).
 *
 * Captures user actions as an editable TypeScript script. The serializable
 * ActionLog is the interchange format; actionLogToScript() renders it as
 * readable script text using only the permissioned automation API, and
 * replayActionLog() executes a log through that same API — so a recording
 * can never do what a hand-written script cannot.
 */

import {
  AUTOMATION_ACTIONS,
  AutomationApi,
  AutomationError,
  type AutomationCellFormat,
  type DeclaredPermission,
  type FilterCriterion,
  type SortKey,
} from './api.js';
import type { CalculationMode, CellInput, CellRef, RangeRef } from '@icecream-sheets/engine';

/** Version of the ActionLog format. Bump on any breaking action change. */
export const ACTION_LOG_VERSION = 1;

export type AutomationAction =
  | { kind: 'setCell'; ref: CellRef; value: CellInput }
  | { kind: 'setFormula'; ref: CellRef; formula: string }
  | { kind: 'setRange'; range: RangeRef; values: CellInput[][] }
  | { kind: 'clearRange'; range: RangeRef }
  | { kind: 'addSheet'; name: string }
  | { kind: 'setCellFormat'; range: RangeRef; format: AutomationCellFormat }
  | { kind: 'defineName'; name: string; ref: string }
  | { kind: 'insertRows'; sheet: string; atRow: number; count: number }
  | { kind: 'insertColumns'; sheet: string; atCol: number; count: number }
  | { kind: 'deleteRows'; sheet: string; atRow: number; count: number }
  | { kind: 'deleteColumns'; sheet: string; atCol: number; count: number }
  | { kind: 'sortRange'; range: RangeRef; keys: SortKey[] }
  | { kind: 'setAutoFilter'; range: RangeRef; criteria: FilterCriterion[] }
  | { kind: 'clearAutoFilter'; sheet: string }
  | { kind: 'recalculate' }
  | { kind: 'setCalculationMode'; mode: CalculationMode };

export interface ActionLog {
  version: number;
  name: string;
  recordedAt: string;
  actions: AutomationAction[];
}

/** Create an empty log (used by the recorder and by tests). */
export function createActionLog(name = 'Recorded macro'): ActionLog {
  return { version: ACTION_LOG_VERSION, name, recordedAt: new Date().toISOString(), actions: [] };
}

/** Serialize a log to JSON (the editable/persistable form). */
export function serializeActionLog(log: ActionLog): string {
  return JSON.stringify(log);
}

/**
 * Parse a serialized log, validating its shape. Throws a descriptive
 * Error for corrupt payloads (a log is user-authored script source —
 * silently returning an empty log would hide data loss).
 */
export function parseActionLog(json: string): ActionLog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('parseActionLog: not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('parseActionLog: expected a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== ACTION_LOG_VERSION) {
    throw new Error(
      `parseActionLog: unsupported action log version ${String(obj.version)} (expected ${ACTION_LOG_VERSION})`,
    );
  }
  if (!Array.isArray(obj.actions)) {
    throw new Error('parseActionLog: missing actions array');
  }
  const actions = (obj.actions as unknown[]).map((a, i) => {
    try {
      return validateAction(a);
    } catch (e) {
      throw new Error(
        `parseActionLog: action ${i} invalid: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
  return {
    version: ACTION_LOG_VERSION,
    name: typeof obj.name === 'string' ? obj.name : 'Recorded macro',
    recordedAt: typeof obj.recordedAt === 'string' ? obj.recordedAt : new Date(0).toISOString(),
    actions,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function reqRef(v: unknown, what: string): CellRef {
  if (
    !isRecord(v) ||
    typeof v.sheet !== 'string' ||
    !Number.isInteger(v.row) ||
    !Number.isInteger(v.col)
  ) {
    throw new Error(`${what} must be {sheet,row,col}`);
  }
  return { sheet: v.sheet, row: v.row as number, col: v.col as number };
}

function reqRange(v: unknown, what: string): RangeRef {
  if (
    !isRecord(v) ||
    typeof v.sheet !== 'string' ||
    !Number.isInteger(v.startRow) ||
    !Number.isInteger(v.startCol) ||
    !Number.isInteger(v.endRow) ||
    !Number.isInteger(v.endCol)
  ) {
    throw new Error(`${what} must be {sheet,startRow,startCol,endRow,endCol}`);
  }
  return {
    sheet: v.sheet,
    startRow: v.startRow as number,
    startCol: v.startCol as number,
    endRow: v.endRow as number,
    endCol: v.endCol as number,
  };
}

function reqInput(v: unknown): CellInput {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
    return v;
  }
  throw new Error('value must be a cell input (string | number | boolean | null)');
}

/** Validate one action's shape; throws on the first problem found. */
export function validateAction(value: unknown): AutomationAction {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('action must be an object with a string kind');
  }
  switch (value.kind) {
    case 'setCell':
      return { kind: 'setCell', ref: reqRef(value.ref, 'ref'), value: reqInput(value.value) };
    case 'setFormula': {
      if (typeof value.formula !== 'string') throw new Error('formula must be a string');
      return { kind: 'setFormula', ref: reqRef(value.ref, 'ref'), formula: value.formula };
    }
    case 'setRange': {
      if (!Array.isArray(value.values)) throw new Error('values must be an array');
      return {
        kind: 'setRange',
        range: reqRange(value.range, 'range'),
        values: value.values.map((row) => {
          if (!Array.isArray(row)) throw new Error('values rows must be arrays');
          return row.map(reqInput);
        }),
      };
    }
    case 'clearRange':
      return { kind: 'clearRange', range: reqRange(value.range, 'range') };
    case 'addSheet': {
      if (typeof value.name !== 'string' || value.name.length === 0) {
        throw new Error('name must be a non-empty string');
      }
      return { kind: 'addSheet', name: value.name };
    }
    case 'setCellFormat': {
      if (!isRecord(value.format)) throw new Error('format must be an object');
      return { kind: 'setCellFormat', range: reqRange(value.range, 'range'), format: value.format };
    }
    case 'defineName': {
      if (typeof value.name !== 'string' || typeof value.ref !== 'string') {
        throw new Error('defineName needs string name and ref');
      }
      return { kind: 'defineName', name: value.name, ref: value.ref };
    }
    case 'insertRows':
    case 'deleteRows':
      return {
        kind: value.kind,
        sheet: reqSheet(value.sheet),
        atRow: reqCount(value.atRow, 'atRow'),
        count: reqCount(value.count, 'count'),
      };
    case 'insertColumns':
    case 'deleteColumns':
      return {
        kind: value.kind,
        sheet: reqSheet(value.sheet),
        atCol: reqCount(value.atCol, 'atCol'),
        count: reqCount(value.count, 'count'),
      };
    case 'sortRange': {
      if (!Array.isArray(value.keys)) throw new Error('keys must be an array');
      return { kind: 'sortRange', range: reqRange(value.range, 'range'), keys: value.keys as SortKey[] };
    }
    case 'setAutoFilter': {
      if (!Array.isArray(value.criteria)) throw new Error('criteria must be an array');
      return {
        kind: 'setAutoFilter',
        range: reqRange(value.range, 'range'),
        criteria: value.criteria as FilterCriterion[],
      };
    }
    case 'clearAutoFilter':
      return { kind: 'clearAutoFilter', sheet: reqSheet(value.sheet) };
    case 'recalculate':
      return { kind: 'recalculate' };
    case 'setCalculationMode': {
      if (value.mode !== 'automatic' && value.mode !== 'manual') {
        throw new Error('mode must be automatic or manual');
      }
      return { kind: 'setCalculationMode', mode: value.mode };
    }
    default:
      throw new Error(`unknown action kind: ${value.kind}`);
  }
}

function reqSheet(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error('sheet must be a non-empty string');
  return v;
}

function reqCount(v: unknown, what: string): number {
  if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${what} must be a non-negative integer`);
  return v as number;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * Captures user actions into an ActionLog. The host (web UI, desktop)
 * calls record() as the user acts; stop() returns the finished log.
 */
export class ActionRecorder {
  private log: ActionLog | null = null;

  /** Begin capturing. Throws if a recording is already in progress. */
  start(name = 'Recorded macro'): void {
    if (this.log !== null) throw new Error('ActionRecorder: a recording is already in progress');
    this.log = createActionLog(name);
  }

  /** True while start() has been called and stop()/cancel() has not. */
  isRecording(): boolean {
    return this.log !== null;
  }

  /** Number of actions captured so far (0 when idle). */
  actionCount(): number {
    return this.log?.actions.length ?? 0;
  }

  /** Capture one user action. No-ops when not recording. */
  record(action: AutomationAction): void {
    if (this.log === null) return;
    this.log.actions.push(validateAction(action));
  }

  /** Finish and return the captured log. Throws when not recording. */
  stop(): ActionLog {
    if (this.log === null) throw new Error('ActionRecorder: not recording');
    const finished = this.log;
    this.log = null;
    return finished;
  }

  /** Discard the in-progress recording. */
  cancel(): void {
    this.log = null;
  }
}

// ---------------------------------------------------------------------------
// Script generation
// ---------------------------------------------------------------------------

function lit(value: unknown): string {
  return JSON.stringify(value);
}

function refLit(ref: CellRef): string {
  return `{ sheet: ${lit(ref.sheet)}, row: ${ref.row}, col: ${ref.col} }`;
}

function rangeLit(range: RangeRef): string {
  return (
    `{ sheet: ${lit(range.sheet)}, startRow: ${range.startRow}, ` +
    `startCol: ${range.startCol}, endRow: ${range.endRow}, endCol: ${range.endCol} }`
  );
}

function actionToStatement(action: AutomationAction): string {
  switch (action.kind) {
    case 'setCell':
      return `api.setCell(${refLit(action.ref)}, ${lit(action.value)});`;
    case 'setFormula':
      return `api.setFormula(${refLit(action.ref)}, ${lit(action.formula)});`;
    case 'setRange':
      return `api.setRange(${rangeLit(action.range)}, ${lit(action.values)});`;
    case 'clearRange':
      return `api.clearRange(${rangeLit(action.range)});`;
    case 'addSheet':
      return `api.addSheet(${lit(action.name)});`;
    case 'setCellFormat':
      return `api.setCellFormat(${rangeLit(action.range)}, ${lit(action.format)});`;
    case 'defineName':
      return `api.defineName(${lit(action.name)}, ${lit(action.ref)});`;
    case 'insertRows':
      return `api.insertRows(${lit(action.sheet)}, ${action.atRow}, ${action.count});`;
    case 'insertColumns':
      return `api.insertColumns(${lit(action.sheet)}, ${action.atCol}, ${action.count});`;
    case 'deleteRows':
      return `api.deleteRows(${lit(action.sheet)}, ${action.atRow}, ${action.count});`;
    case 'deleteColumns':
      return `api.deleteColumns(${lit(action.sheet)}, ${action.atCol}, ${action.count});`;
    case 'sortRange':
      return `api.sortRange(${rangeLit(action.range)}, ${lit(action.keys)});`;
    case 'setAutoFilter':
      return `api.setAutoFilter(${rangeLit(action.range)}, ${lit(action.criteria)});`;
    case 'clearAutoFilter':
      return `api.clearAutoFilter(${lit(action.sheet)});`;
    case 'recalculate':
      return `api.recalculate();`;
    case 'setCalculationMode':
      return `api.setCalculationMode(${lit(action.mode)});`;
  }
}

/**
 * Permissions one action needs, for the script's declared-permissions
 * manifest (automation-lane.md §1).
 */
export function permissionsForAction(action: AutomationAction): DeclaredPermission[] {
  const A = AUTOMATION_ACTIONS;
  const cellTarget = (ref: CellRef): string => `${ref.sheet}!${ref.col},${ref.row}`;
  const rangeTarget = (r: RangeRef): string =>
    `${r.sheet}!${r.startCol},${r.startRow}:${r.endCol},${r.endRow}`;
  switch (action.kind) {
    case 'setCell':
      return [{ action: A.cellWrite, target: cellTarget(action.ref) }];
    case 'setFormula':
      return [{ action: A.cellWrite, target: cellTarget(action.ref) }];
    case 'setRange':
      return [{ action: A.rangeWrite, target: rangeTarget(action.range) }];
    case 'clearRange':
      return [{ action: A.rangeClear, target: rangeTarget(action.range) }];
    case 'addSheet':
      return [{ action: A.sheetAdd, target: action.name }];
    case 'setCellFormat':
      return [{ action: A.formatWrite, target: rangeTarget(action.range) }];
    case 'defineName':
      return [{ action: A.nameDefine, target: `name:${action.name}` }];
    case 'insertRows':
      return [{ action: A.rowInsert, target: `${action.sheet}!${action.atRow}+${action.count}` }];
    case 'insertColumns':
      return [{ action: A.colInsert, target: `${action.sheet}!${action.atCol}+${action.count}` }];
    case 'deleteRows':
      return [{ action: A.rowDelete, target: `${action.sheet}!${action.atRow}+${action.count}` }];
    case 'deleteColumns':
      return [{ action: A.colDelete, target: `${action.sheet}!${action.atCol}+${action.count}` }];
    case 'sortRange':
      return [{ action: A.rangeSort, target: rangeTarget(action.range) }];
    case 'setAutoFilter':
      return [{ action: A.filterSet, target: rangeTarget(action.range) }];
    case 'clearAutoFilter':
      return [{ action: A.filterClear, target: action.sheet }];
    case 'recalculate':
      return [{ action: A.calcRecalculate, target: 'workbook' }];
    case 'setCalculationMode':
      return [{ action: A.calcSetMode, target: 'workbook' }];
  }
}

/**
 * Render a log as an editable TypeScript script. The script uses only the
 * permissioned automation API and carries its declared permissions as an
 * exported manifest, so the trigger runtime can demand the user's grant
 * before running it.
 */
export function actionLogToScript(log: ActionLog): string {
  const seen = new Map<string, DeclaredPermission>();
  for (const action of log.actions) {
    for (const p of permissionsForAction(action)) {
      seen.set(`${p.action} ${p.target}`, p);
    }
  }
  const permissions = [...seen.values()];
  const lines: string[] = [
    `/**`,
    ` * ${log.name}`,
    ` * Recorded by the Icecream Sheets macro recorder on ${log.recordedAt}.`,
    ` *`,
    ` * This script runs through the permissioned automation API: every call`,
    ` * is authorized against the principal it runs as, and it can do nothing`,
    ` * a hand-written script cannot. Edit freely, then save it as a trigger`,
    ` * or run it from the Macros dialog.`,
    ` */`,
    `import type { AutomationApi } from '@icecream-sheets/service';`,
    ``,
    `/** Permissions this script declares (automation-lane.md §1). */`,
    `export const permissions = ${JSON.stringify(permissions, null, 2)};`,
    ``,
    `export function main(api: AutomationApi): void {`,
  ];
  if (log.actions.length === 0) {
    lines.push(`  // (no actions were recorded)`);
  }
  for (const action of log.actions) {
    lines.push(`  ${actionToStatement(action)}`);
  }
  lines.push(`}`, ``);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Execute a log through the permissioned automation API. Actions the
 * engine cannot execute yet (formats, names, row/col ops, sort/filter)
 * throw AutomationError with code 'unsupported', annotated with the
 * action index — replay can never silently skip or escalate.
 */
export function replayActionLog(log: ActionLog, api: AutomationApi): void {
  log.actions.forEach((action, index) => {
    try {
      replayOne(action, api);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const code = e instanceof AutomationError ? e.code : 'engine';
      throw new AutomationError(code, `replay failed at action ${index} (${action.kind}): ${detail}`);
    }
  });
}

function replayOne(action: AutomationAction, api: AutomationApi): void {
  switch (action.kind) {
    case 'setCell':
      api.setCell(action.ref, action.value);
      return;
    case 'setFormula':
      api.setFormula(action.ref, action.formula);
      return;
    case 'setRange':
      api.setRange(action.range, action.values);
      return;
    case 'clearRange':
      api.clearRange(action.range);
      return;
    case 'addSheet':
      api.addSheet(action.name);
      return;
    case 'setCellFormat':
      api.setCellFormat(action.range, action.format);
      return;
    case 'defineName':
      api.defineName(action.name, action.ref);
      return;
    case 'insertRows':
      api.insertRows(action.sheet, action.atRow, action.count);
      return;
    case 'insertColumns':
      api.insertColumns(action.sheet, action.atCol, action.count);
      return;
    case 'deleteRows':
      api.deleteRows(action.sheet, action.atRow, action.count);
      return;
    case 'deleteColumns':
      api.deleteColumns(action.sheet, action.atCol, action.count);
      return;
    case 'sortRange':
      api.sortRange(action.range, action.keys);
      return;
    case 'clearAutoFilter':
      api.clearAutoFilter(action.sheet);
      return;
    case 'setAutoFilter':
      api.setAutoFilter(action.range, action.criteria);
      return;
    case 'recalculate':
      api.recalculate();
      return;
    case 'setCalculationMode':
      api.setCalculationMode(action.mode);
      return;
  }
}
