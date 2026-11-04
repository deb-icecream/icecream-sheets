/**
 * Permissioned automation API (design-docs/automation-lane.md §1).
 *
 * A typed TypeScript API sitting over the versioned engine protocol
 * (EngineHost). EVERY call — reads and writes — goes through authorize()
 * with a principal identity before touching the engine. There is no
 * privileged backdoor: recorded macros, hand-written scripts and event
 * triggers all execute through this same surface.
 *
 * Scripts declare the permissions they need up front; the user grants them
 * once and the grant is recorded (see grant()/grantsFor()). The grant
 * record is consent bookkeeping — enforcement itself stays in the engine's
 * Authorizer (the single choke point per design-docs/permission-model.md
 * §4), so revoking or tightening the engine policy takes effect
 * immediately.
 *
 * Engine-protocol coverage note (honest): the engine protocol v1 exposes
 * cells, formulas, sheets and recalculation only. Formatting, named
 * ranges, row/column insert/delete, sort and filter are part of this API's
 * typed surface — every such call IS authorized — but the engine cannot
 * execute them yet, so they fail with code 'unsupported'. This keeps the
 * API honest: a script can never silently do less than it asked for, and
 * recordings replay through exactly the same checks as hand-written code.
 */

import {
  EngineHost,
  type CalculationMode,
  type CellInput,
  type CellRef,
  type RangeRef,
  type SheetInfo,
  type TypedValue,
} from '@icecream-sheets/engine';

/** Who is acting. Scripts run as 'automation:<script-name>'; the interactive user is 'user'. */
export type AutomationPrincipal = string;

export interface AutomationApiOptions {
  /**
   * Identity every authorize() call is made with. Required — the API
   * refuses to construct without one (fail closed on identity, matching
   * Authorizer semantics).
   */
  principal: AutomationPrincipal;
}

export type AutomationErrorCode = 'denied' | 'unsupported' | 'invalid' | 'engine';

export class AutomationError extends Error {
  readonly code: AutomationErrorCode;
  constructor(code: AutomationErrorCode, message: string) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
  }
}

/** A permission a script declares it needs (automation-lane.md §1). */
export interface DeclaredPermission {
  /** e.g. 'cell.write'. */
  action: string;
  /** e.g. 'Sheet1!0,0' or 'Sheet1!0,0:2,5'. */
  target: string;
  /** Human-readable reason shown at grant time. */
  reason?: string;
}

/** Record of a user grant (automation-lane.md §1: "the grant is recorded"). */
export interface PermissionGrantRecord {
  principal: string;
  action: string;
  target: string;
  grantedBy: string;
  grantedAt: string;
}

/**
 * Cell format patch for setCellFormat(). v1 covers the common subset;
 * the engine does not execute it yet (see module doc).
 */
export interface AutomationCellFormat {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  fontColor?: string;
  fillColor?: string;
  numberFormat?: string;
}

export interface SortKey {
  /** Zero-based column offset within the range. */
  col: number;
  ascending: boolean;
}

export interface FilterCriterion {
  /** Zero-based column offset within the range. */
  col: number;
  values: Array<string | number | boolean>;
}

/** Authorization action names used by this API. */
export const AUTOMATION_ACTIONS = {
  cellRead: 'cell.read',
  cellWrite: 'cell.write',
  rangeRead: 'range.read',
  rangeWrite: 'range.write',
  rangeClear: 'range.clear',
  sheetList: 'sheet.list',
  sheetAdd: 'sheet.add',
  sheetInfo: 'sheet.info',
  calcSetMode: 'calc.setMode',
  calcRecalculate: 'calc.recalculate',
  formatWrite: 'format.write',
  nameDefine: 'name.define',
  nameRead: 'name.read',
  nameDelete: 'name.delete',
  rowInsert: 'row.insert',
  colInsert: 'col.insert',
  rowDelete: 'row.delete',
  colDelete: 'col.delete',
  rangeSort: 'range.sort',
  filterSet: 'filter.set',
  filterClear: 'filter.clear',
  uiNotify: 'ui.notify',
} as const;

function cellTarget(ref: CellRef): string {
  return `${ref.sheet}!${ref.col},${ref.row}`;
}

function rangeTarget(range: RangeRef): string {
  return `${range.sheet}!${range.startCol},${range.startRow}:${range.endCol},${range.endRow}`;
}

function isValidRef(ref: CellRef): boolean {
  return (
    typeof ref.sheet === 'string' &&
    ref.sheet.length > 0 &&
    Number.isInteger(ref.row) &&
    ref.row >= 0 &&
    Number.isInteger(ref.col) &&
    ref.col >= 0
  );
}

function isValidRange(range: RangeRef): boolean {
  return (
    typeof range.sheet === 'string' &&
    range.sheet.length > 0 &&
    Number.isInteger(range.startRow) &&
    Number.isInteger(range.startCol) &&
    Number.isInteger(range.endRow) &&
    Number.isInteger(range.endCol) &&
    range.startRow >= 0 &&
    range.startCol >= 0 &&
    range.endRow >= range.startRow &&
    range.endCol >= range.startCol
  );
}

function isValidInput(value: CellInput): boolean {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  );
}

/**
 * Permissioned automation API over the engine protocol.
 *
 * Construct with an EngineHost and a principal. Every method authorizes
 * before acting; a denied call throws AutomationError('denied') and the
 * denial is recorded in the engine Authorizer's audit log.
 */
export class AutomationApi {
  private readonly host: EngineHost;
  private readonly principal: AutomationPrincipal;
  private readonly grants: PermissionGrantRecord[] = [];
  private readonly notifications: string[] = [];

  constructor(host: EngineHost, options: AutomationApiOptions) {
    if (!host) throw new AutomationError('invalid', 'AutomationApi requires an EngineHost');
    const principal = options?.principal;
    if (typeof principal !== 'string' || principal.length === 0) {
      // Fail closed on identity — matches Authorizer.authorize semantics.
      throw new AutomationError('invalid', 'AutomationApi requires a non-empty principal');
    }
    this.host = host;
    this.principal = principal;
  }

  /** The principal every authorize() call in this session is made with. */
  getPrincipal(): AutomationPrincipal {
    return this.principal;
  }

  /**
   * Single choke point for this API: authorize an action against the
   * engine's Authorizer. Throws AutomationError('denied') when rejected.
   */
  private check(action: string, target: string): void {
    let allowed = false;
    try {
      allowed = this.host
        .getAuthorizer()
        .authorize(action, target, { principal: this.principal });
    } catch (e) {
      throw new AutomationError(
        'denied',
        `authorization failed for ${action} ${target}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!allowed) {
      throw new AutomationError('denied', `Denied by policy: ${action} ${target}`);
    }
  }

  /**
   * Mark an operation as authorized-but-not-executable. The authorize()
   * call above it already ran, so the attempt is audit-logged exactly like
   * a permitted one — there is no silent privileged path around it.
   */
  private unsupported(what: string): never {
    throw new AutomationError(
      'unsupported',
      `${what} is not supported by engine protocol v${this.host.protocolVersion} ` +
        `(authorized, but the engine cannot execute it yet)`,
    );
  }

  // ------------------------------------------------------------------
  // Cells (executed by the engine protocol)
  // ------------------------------------------------------------------

  /** Read one cell's computed value. Authorizes 'cell.read' first. */
  getCell(ref: CellRef): TypedValue {
    if (!isValidRef(ref)) throw new AutomationError('invalid', `invalid cell ref`);
    this.check(AUTOMATION_ACTIONS.cellRead, cellTarget(ref));
    try {
      return this.host.readCell(ref);
    } catch (e) {
      throw new AutomationError('engine', e instanceof Error ? e.message : String(e));
    }
  }

  /** Write one cell. Strings starting with '=' are stored as formulas (engine behavior). */
  setCell(ref: CellRef, value: CellInput): void {
    if (!isValidRef(ref)) throw new AutomationError('invalid', `invalid cell ref`);
    if (!isValidInput(value)) throw new AutomationError('invalid', `invalid cell value`);
    this.check(AUTOMATION_ACTIONS.cellWrite, cellTarget(ref));
    const res = this.host.execute({ cmd: 'setCell', ref, value, auth: { principal: this.principal } });
    if (!res.ok) throw new AutomationError('engine', res.error);
  }

  /** Read a cell's formula text, if any. */
  getFormula(ref: CellRef): string | undefined {
    if (!isValidRef(ref)) throw new AutomationError('invalid', `invalid cell ref`);
    this.check(AUTOMATION_ACTIONS.cellRead, cellTarget(ref));
    try {
      return this.host.getView().readCell(ref).formula ?? undefined;
    } catch (e) {
      throw new AutomationError('engine', e instanceof Error ? e.message : String(e));
    }
  }

  /** Write a formula (with or without the leading '='). */
  setFormula(ref: CellRef, formula: string): void {
    if (!isValidRef(ref)) throw new AutomationError('invalid', `invalid cell ref`);
    if (typeof formula !== 'string' || formula.length === 0) {
      throw new AutomationError('invalid', 'formula must be a non-empty string');
    }
    this.check(AUTOMATION_ACTIONS.cellWrite, cellTarget(ref));
    const res = this.host.execute({
      cmd: 'setFormula',
      ref,
      formula,
      auth: { principal: this.principal },
    });
    if (!res.ok) throw new AutomationError('engine', res.error);
  }

  /** Read a rectangular range of computed values. */
  getRange(range: RangeRef): TypedValue[][] {
    if (!isValidRange(range)) throw new AutomationError('invalid', `invalid range`);
    this.check(AUTOMATION_ACTIONS.rangeRead, rangeTarget(range));
    try {
      return this.host.readRange(range);
    } catch (e) {
      throw new AutomationError('engine', e instanceof Error ? e.message : String(e));
    }
  }

  /** Write a rectangular block of values (row-major, must match the range shape). */
  setRange(range: RangeRef, values: CellInput[][]): void {
    if (!isValidRange(range)) throw new AutomationError('invalid', `invalid range`);
    const rows = range.endRow - range.startRow + 1;
    const cols = range.endCol - range.startCol + 1;
    if (
      !Array.isArray(values) ||
      values.length !== rows ||
      values.some((r) => !Array.isArray(r) || r.length !== cols || !r.every(isValidInput))
    ) {
      throw new AutomationError(
        'invalid',
        `values must be a ${rows}x${cols} array of cell inputs`,
      );
    }
    this.check(AUTOMATION_ACTIONS.rangeWrite, rangeTarget(range));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const res = this.host.execute({
          cmd: 'setCell',
          ref: { sheet: range.sheet, row: range.startRow + r, col: range.startCol + c },
          value: values[r]![c]!,
          auth: { principal: this.principal },
        });
        if (!res.ok) throw new AutomationError('engine', res.error);
      }
    }
  }

  /** Clear all values in a range. */
  clearRange(range: RangeRef): void {
    if (!isValidRange(range)) throw new AutomationError('invalid', `invalid range`);
    this.check(AUTOMATION_ACTIONS.rangeClear, rangeTarget(range));
    const rows = range.endRow - range.startRow + 1;
    const cols = range.endCol - range.startCol + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const res = this.host.execute({
          cmd: 'setCell',
          ref: { sheet: range.sheet, row: range.startRow + r, col: range.startCol + c },
          value: null,
          auth: { principal: this.principal },
        });
        if (!res.ok) throw new AutomationError('engine', res.error);
      }
    }
  }

  // ------------------------------------------------------------------
  // Sheets (executed by the engine protocol)
  // ------------------------------------------------------------------

  listSheets(): SheetInfo[] {
    this.check(AUTOMATION_ACTIONS.sheetList, 'workbook');
    try {
      return this.host.snapshot().sheets.map((s) => this.sheetInfoOf(s.name, s.cells));
    } catch (e) {
      throw new AutomationError('engine', e instanceof Error ? e.message : String(e));
    }
  }

  private sheetInfoOf(name: string, cells: Array<{ ref: CellRef }>): SheetInfo {
    let rowCount = 0;
    let colCount = 0;
    for (const cell of cells) {
      if (cell.ref.row + 1 > rowCount) rowCount = cell.ref.row + 1;
      if (cell.ref.col + 1 > colCount) colCount = cell.ref.col + 1;
    }
    return { name, rowCount, colCount };
  }

  addSheet(name: string): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new AutomationError('invalid', 'sheet name must be a non-empty string');
    }
    this.check(AUTOMATION_ACTIONS.sheetAdd, name);
    const res = this.host.execute({ cmd: 'addSheet', name, auth: { principal: this.principal } });
    if (!res.ok) throw new AutomationError('engine', res.error);
  }

  getSheetInfo(name: string): SheetInfo {
    if (typeof name !== 'string' || name.length === 0) {
      throw new AutomationError('invalid', 'sheet name must be a non-empty string');
    }
    this.check(AUTOMATION_ACTIONS.sheetInfo, name);
    try {
      const found = this.host.snapshot().sheets.find((s) => s.name === name);
      if (!found) throw new AutomationError('invalid', `unknown sheet: ${name}`);
      return this.sheetInfoOf(found.name, found.cells);
    } catch (e) {
      if (e instanceof AutomationError) throw e;
      throw new AutomationError('engine', e instanceof Error ? e.message : String(e));
    }
  }

  // ------------------------------------------------------------------
  // Calculation (executed by the engine protocol)
  // ------------------------------------------------------------------

  setCalculationMode(mode: CalculationMode): void {
    if (mode !== 'automatic' && mode !== 'manual') {
      throw new AutomationError('invalid', `invalid calculation mode: ${String(mode)}`);
    }
    this.check(AUTOMATION_ACTIONS.calcSetMode, 'workbook');
    const res = this.host.execute({ cmd: 'setCalculationMode', mode, auth: { principal: this.principal } });
    if (!res.ok) throw new AutomationError('engine', res.error);
  }

  recalculate(): void {
    this.check(AUTOMATION_ACTIONS.calcRecalculate, 'workbook');
    const res = this.host.execute({ cmd: 'recalculate', auth: { principal: this.principal } });
    if (!res.ok) throw new AutomationError('engine', res.error);
  }

  // ------------------------------------------------------------------
  // Declared surface the engine protocol v1 cannot execute yet.
  // Each call authorizes first (audit-logged), then fails 'unsupported'.
  // ------------------------------------------------------------------

  /** Apply formatting to a range. Authorized; engine cannot execute yet. */
  setCellFormat(range: RangeRef, _format: AutomationCellFormat): void {
    if (!isValidRange(range)) throw new AutomationError('invalid', `invalid range`);
    if (typeof _format !== 'object' || _format === null) {
      throw new AutomationError('invalid', 'format must be an object');
    }
    this.check(AUTOMATION_ACTIONS.formatWrite, rangeTarget(range));
    this.unsupported('setCellFormat');
  }

  /** Define a named range. Authorized; engine cannot execute yet. */
  defineName(name: string, _ref: string): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new AutomationError('invalid', 'name must be a non-empty string');
    }
    this.check(AUTOMATION_ACTIONS.nameDefine, `name:${name}`);
    this.unsupported('defineName');
  }

  /** Resolve a named range. Authorized; engine cannot execute yet. */
  getNamedRef(name: string): string {
    if (typeof name !== 'string' || name.length === 0) {
      throw new AutomationError('invalid', 'name must be a non-empty string');
    }
    this.check(AUTOMATION_ACTIONS.nameRead, `name:${name}`);
    this.unsupported('getNamedRef');
  }

  /** Delete a named range. Authorized; engine cannot execute yet. */
  deleteName(name: string): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new AutomationError('invalid', 'name must be a non-empty string');
    }
    this.check(AUTOMATION_ACTIONS.nameDelete, `name:${name}`);
    this.unsupported('deleteName');
  }

  insertRows(sheet: string, atRow: number, count: number): void {
    this.checkRowColArgs('row.insert', sheet, atRow, count);
    this.unsupported('insertRows');
  }

  insertColumns(sheet: string, atCol: number, count: number): void {
    this.checkRowColArgs('col.insert', sheet, atCol, count);
    this.unsupported('insertColumns');
  }

  deleteRows(sheet: string, atRow: number, count: number): void {
    this.checkRowColArgs('row.delete', sheet, atRow, count);
    this.unsupported('deleteRows');
  }

  deleteColumns(sheet: string, atCol: number, count: number): void {
    this.checkRowColArgs('col.delete', sheet, atCol, count);
    this.unsupported('deleteColumns');
  }

  private checkRowColArgs(action: string, sheet: string, at: number, count: number): void {
    if (typeof sheet !== 'string' || sheet.length === 0) {
      throw new AutomationError('invalid', 'sheet must be a non-empty string');
    }
    if (!Number.isInteger(at) || at < 0 || !Number.isInteger(count) || count <= 0) {
      throw new AutomationError('invalid', 'position must be >= 0 and count must be >= 1');
    }
    this.check(action, `${sheet}!${at}+${count}`);
  }

  /** Sort a range. Authorized; engine cannot execute yet. */
  sortRange(range: RangeRef, keys: SortKey[]): void {
    if (!isValidRange(range)) throw new AutomationError('invalid', `invalid range`);
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new AutomationError('invalid', 'sort requires at least one key');
    }
    this.check(AUTOMATION_ACTIONS.rangeSort, rangeTarget(range));
    this.unsupported('sortRange');
  }

  /** Apply an auto-filter. Authorized; engine cannot execute yet. */
  setAutoFilter(range: RangeRef, _criteria: FilterCriterion[]): void {
    if (!isValidRange(range)) throw new AutomationError('invalid', `invalid range`);
    this.check(AUTOMATION_ACTIONS.filterSet, rangeTarget(range));
    this.unsupported('setAutoFilter');
  }

  /** Clear an auto-filter. Authorized; engine cannot execute yet. */
  clearAutoFilter(sheet: string): void {
    if (typeof sheet !== 'string' || sheet.length === 0) {
      throw new AutomationError('invalid', 'sheet must be a non-empty string');
    }
    this.check(AUTOMATION_ACTIONS.filterClear, sheet);
    this.unsupported('clearAutoFilter');
  }

  // ------------------------------------------------------------------
  // Notifications (MsgBox equivalent) and permission grants
  // ------------------------------------------------------------------

  /**
   * Show a notification to the user (the MsgBox / alert equivalent for
   * migrated macros). Authorized as 'ui.notify'. Delivery is the host's
   * job; the API records the message so tests and the trigger runtime can
   * observe it. Never a privileged path — just an outbox.
   */
  notify(message: string): void {
    if (typeof message !== 'string') throw new AutomationError('invalid', 'message must be a string');
    this.check(AUTOMATION_ACTIONS.uiNotify, 'workbook');
    this.notifications.push(message);
  }

  /** Messages queued via notify() in this session. */
  getNotifications(): string[] {
    return [...this.notifications];
  }

  clearNotifications(): void {
    this.notifications.length = 0;
  }

  /**
   * Record a user grant: "the user grants them once and the grant is
   * recorded" (automation-lane.md §1). Enforcement stays in the engine
   * Authorizer; this ledger is the consent record the trigger runtime
   * consults before running a script.
   */
  grantPermissions(
    principal: string,
    permissions: DeclaredPermission[],
    grantedBy: string,
  ): void {
    if (typeof principal !== 'string' || principal.length === 0) {
      throw new AutomationError('invalid', 'grant requires a non-empty principal');
    }
    if (!Array.isArray(permissions)) {
      throw new AutomationError('invalid', 'permissions must be an array');
    }
    const at = new Date().toISOString();
    for (const p of permissions) {
      this.grants.push({
        principal,
        action: p.action,
        target: p.target,
        grantedBy,
        grantedAt: at,
      });
    }
  }

  /** Consent records for a principal. */
  grantsFor(principal: string): PermissionGrantRecord[] {
    return this.grants.filter((g) => g.principal === principal);
  }

  /**
   * Has the user granted every declared permission for this principal?
   * The trigger runtime refuses to run scripts that fail this check.
   */
  hasGrantsFor(principal: string, permissions: DeclaredPermission[]): boolean {
    const granted = this.grantsFor(principal);
    return permissions.every((p) =>
      granted.some((g) => g.action === p.action && g.target === p.target),
    );
  }
}
