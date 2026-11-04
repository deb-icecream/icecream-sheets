/**
 * No-code app builder: action semantics (design-docs/no-code-app-builder.md §5).
 *
 * v1 actions: add row, edit row, delete row, navigate between views. Deleting
 * a row requires confirmation. Every write goes through authorize() as the
 * end user before any mutation, exactly like any other client.
 *
 * The service layer never touches the engine directly: the host implements
 * RowMutationPort (engine protocol + authorize), e.g. EngineHost.execute()
 * with auth:{principal} in the web app and MCP server. Tests use an
 * in-memory fake port.
 */

import type { ActionKind, AppSpec, ColumnSpec, ColumnType, RangeBinding } from './spec.js';
import { specColumns } from './spec.js';
import type { AppRecord, CellInput } from './model.js';

/** Thrown when authorize() denies an action. Never a silent empty. */
export class AuthorizationError extends Error {
  constructor(
    public readonly principal: string,
    public readonly action: string,
    public readonly target: string,
  ) {
    super(`denied: ${principal} may not ${action} ${target}`);
    this.name = 'AuthorizationError';
  }
}

/** Thrown when a deleteRow action is invoked without confirmed=true. */
export class ConfirmationRequiredError extends Error {
  constructor(public readonly actionId: string) {
    super(`action "${actionId}" deletes a row and requires confirmation`);
    this.name = 'ConfirmationRequiredError';
  }
}

/** Thrown for invalid action invocations (bad values, unknown rows, ...). */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

/**
 * Host-supplied mutation port. Reads/writes go through the engine protocol;
 * authorize() is the permission-model.md §4 choke point and must throw
 * AuthorizationError on denial.
 */
export interface RowMutationPort {
  principal: string;
  /** Authorize an app-level action; throws AuthorizationError when denied. */
  authorize(action: 'app.read' | 'app.write' | 'app.manage', target: string): void;
  /** Number of data rows currently in the bound table. */
  rowCount(binding: RangeBinding): number;
  /** Insert a data row at `index` (0-based), shifting later rows down. */
  insertRow(binding: RangeBinding, index: number, values: Record<string, CellInput>): void;
  /** Replace cells of the data row at `index`. */
  updateRow(binding: RangeBinding, index: number, values: Record<string, CellInput>): void;
  /** Delete the data row at `index`, shifting later rows up. */
  deleteRow(binding: RangeBinding, index: number): void;
  /** Read the bound table as header-keyed records (per-subject filtered). */
  readRows(binding: RangeBinding): AppRecord[];
}

export interface ActionInvocation {
  spec: AppSpec;
  actionId: string;
  /** Data-row index the action targets (edit/delete). */
  rowIndex?: number;
  /** Column -> value for add/edit. */
  values?: Record<string, CellInput>;
  /** Delete actions require confirmed=true (the UI confirms first). */
  confirmed?: boolean;
}

export interface ActionOutcome {
  /** For navigate actions: the view id the UI should show. */
  navigatedTo?: string;
  /** Data-row index the action created or touched. */
  rowIndex?: number;
}

/**
 * Permission-tree target for an app (permission-model.md §1: the app is an
 * object in the tree; tableId names the bound table node when known).
 */
export function appTarget(spec: AppSpec): string {
  const table = spec.dataSource.binding.tableId ?? spec.dataSource.binding.sheet;
  return `app:${spec.id}/table:${table}`;
}

/** Coerce/validate one form value against its column type. */
export function coerceValue(column: ColumnSpec, raw: CellInput): CellInput {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') throw new ActionError(`column "${column.name}": object values are not writable`);
  const s = typeof raw === 'string' ? raw.trim() : raw;
  switch (column.type as ColumnType) {
    case 'numeric': {
      if (typeof s === 'number') return Number.isFinite(s) ? s : null;
      const n = Number(s);
      if (s === '' || Number.isNaN(n)) throw new ActionError(`column "${column.name}": "${raw}" is not a number`);
      return n;
    }
    case 'boolean': {
      if (typeof s === 'boolean') return s;
      const t = String(s);
      if (/^(true|yes|1)$/i.test(t)) return true;
      if (/^(false|no|0)$/i.test(t)) return false;
      throw new ActionError(`column "${column.name}": "${raw}" is not a boolean`);
    }
    case 'date': {
      if (typeof s !== 'string') throw new ActionError(`column "${column.name}": date must be text`);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(new Date(s).getTime())) {
        throw new ActionError(`column "${column.name}": "${raw}" is not a date (use YYYY-MM-DD)`);
      }
      return s;
    }
    case 'imageUrl': {
      if (typeof s !== 'string' || !/^https?:\/\/\S+$/.test(s)) {
        throw new ActionError(`column "${column.name}": "${raw}" is not a URL`);
      }
      return s;
    }
    case 'reference':
    case 'text':
    default:
      return typeof s === 'string' ? s : String(s);
  }
}

function findAction(spec: AppSpec, actionId: string) {
  const action = spec.actions.find((a) => a.id === actionId);
  if (!action) throw new ActionError(`unknown action "${actionId}"`);
  return action;
}

/** Build the full column->value map for a write, coercing each value. */
function buildWriteValues(
  columns: ColumnSpec[],
  values: Record<string, CellInput> | undefined,
  what: string,
): Record<string, CellInput> {
  if (!values || typeof values !== 'object') throw new ActionError(`${what}: values are required`);
  const byName = new Map(columns.map((c) => [c.name, c]));
  const out: Record<string, CellInput> = {};
  for (const [name, raw] of Object.entries(values)) {
    const col = byName.get(name);
    if (!col) throw new ActionError(`${what}: unknown column "${name}"`);
    out[name] = coerceValue(col, raw);
  }
  return out;
}

/**
 * Execute one app action through the port. Writes call authorize('app.write')
 * as the end user before any mutation (no-code-app-builder.md §5); a denial
 * throws AuthorizationError and nothing is mutated.
 */
export function executeAction(port: RowMutationPort, inv: ActionInvocation): ActionOutcome {
  const action = findAction(inv.spec, inv.actionId);
  const binding = inv.spec.dataSource.binding;
  const target = appTarget(inv.spec);
  const columns = specColumns(inv.spec);

  const kind: ActionKind = action.kind;
  switch (kind) {
    case 'addRow': {
      port.authorize('app.write', target);
      const values = buildWriteValues(columns, inv.values, `addRow "${action.id}"`);
      const index = port.rowCount(binding);
      port.insertRow(binding, index, values);
      return { rowIndex: index };
    }
    case 'editRow': {
      if (inv.rowIndex === undefined || inv.rowIndex < 0) {
        throw new ActionError(`editRow "${action.id}": rowIndex is required`);
      }
      const count = port.rowCount(binding);
      if (inv.rowIndex >= count) throw new ActionError(`editRow "${action.id}": row ${inv.rowIndex} does not exist`);
      port.authorize('app.write', target);
      const values = buildWriteValues(columns, inv.values, `editRow "${action.id}"`);
      port.updateRow(binding, inv.rowIndex, values);
      return { rowIndex: inv.rowIndex };
    }
    case 'deleteRow': {
      if (inv.rowIndex === undefined || inv.rowIndex < 0) {
        throw new ActionError(`deleteRow "${action.id}": rowIndex is required`);
      }
      if (action.requiresConfirm && inv.confirmed !== true) {
        throw new ConfirmationRequiredError(action.id);
      }
      const count = port.rowCount(binding);
      if (inv.rowIndex >= count) throw new ActionError(`deleteRow "${action.id}": row ${inv.rowIndex} does not exist`);
      port.authorize('app.write', target);
      port.deleteRow(binding, inv.rowIndex);
      return { rowIndex: inv.rowIndex };
    }
    case 'navigate': {
      const targetViewId = action.targetViewId;
      if (!targetViewId) throw new ActionError(`navigate "${action.id}": targetViewId is required`);
      if (!inv.spec.views.some((v) => v.id === targetViewId)) {
        throw new ActionError(`navigate "${action.id}": unknown view "${targetViewId}"`);
      }
      return { navigatedTo: targetViewId };
    }
  }
}
