/**
 * UI-layer undo/redo manager.
 *
 * The engine protocol has no undo command, so the UI records the
 * before-state of every committed cell (value + formula, read through
 * the protocol's view) and replays it via EngineHost.execute().
 * Everything goes through the protocol; nothing touches HyperFormula.
 */
import type { EngineHost } from '@icecream-sheets/engine';
import type { NamedRangeDef } from '@icecream-sheets/service';
import { cellRef } from '../engine';
import type { FormatStore } from './formatting';

export interface CellBefore {
  sheet: string;
  row: number;
  col: number;
  /** Raw input value (null = empty). */
  value: string | number | boolean | null;
  /** Formula text with leading '=', if the cell holds a formula. */
  formula?: string;
}

export interface UndoEntry {
  /** Cells changed by one user action, with their before-state. */
  cells: CellBefore[];
  /** Named-range definitions before the action (undo restores them). */
  namesBefore?: NamedRangeDef[];
  /**
   * Format-store state before the action (issue #21: ribbon format
   * changes are undoable actions). The store is immutable — every
   * mutation helper returns a fresh store — so the reference IS the
   * snapshot. Undo restores it; the entry pushed to the opposite stack
   * carries the then-current store the same way.
   */
  formatsBefore?: FormatStore;
  label: string;
}

/**
 * Hooks letting the undo manager capture/restore named-range definitions
 * alongside cell state. Registered by the app once (the store lives in
 * the name-services layer, not in this engine-agnostic module).
 */
export interface NamesUndoHooks {
  /** Snapshot current definitions (opaque, restorable). */
  snapshotNames(): NamedRangeDef[];
  /** Restore definitions captured by snapshotNames(); refreshes the UI. */
  restoreNames(defs: NamedRangeDef[]): void;
}

/**
 * Hooks letting the undo manager capture/restore the UI format store
 * around format actions (issue #21). Same pattern as NamesUndoHooks:
 * the store lives in the app (React state), not in this module.
 */
export interface FormatsUndoHooks {
  /** Snapshot the current format store (immutable — reference is enough). */
  snapshotFormats(): FormatStore;
  /** Restore a captured store; repaints and marks formats dirty. */
  restoreFormats(store: FormatStore): void;
}

function readBefore(host: EngineHost, sheet: string, row: number, col: number): CellBefore {
  const cell = host.getView().readCell(cellRef(sheet, row, col));
  const v = cell.value;
  let value: string | number | boolean | null = null;
  if (v.kind === 'number' || v.kind === 'string' || v.kind === 'boolean') {
    value = v.value as string | number | boolean;
  }
  return {
    sheet,
    row,
    col,
    value,
    formula: cell.formula,
  };
}

function applyState(host: EngineHost, state: CellBefore): boolean {
  const ref = cellRef(state.sheet, state.row, state.col);
  const res =
    state.formula !== undefined
      ? host.execute({ cmd: 'setFormula', ref, formula: state.formula })
      : host.execute({ cmd: 'setCell', ref, value: state.value });
  return res.ok;
}

// ---------------------------------------------------------------------------
// Async hosts (Cycle 10 closure, defect D2)
//
// RemoteEngineHost (gateway) and IpcEngineHost (desktop) keep the base
// class's synchronous SIGNATURES but execute() returns a Promise at
// runtime, and their view reads are read-through caches: a miss returns
// the EMPTY placeholder synchronously and queues a background fill. The
// synchronous UndoManager paths above are therefore wrong on those hosts
// in two ways:
//   1. applyState reads `.ok` off a Promise (undefined) — undo()/redo()
//      ALWAYS reported failure ("Nothing to undo.") even though the
//      restore execute had in fact been dispatched.
//   2. readBefore captures the placeholder instead of the real value
//      whenever the cell is not in the host's cache at capture time —
//      notably the redo-state capture inside undo(), which runs right
//      after the edit's cellsChanged invalidation evicted the cell, so
//      redo restored a phantom empty value.
// The async variants below await the host's authoritative async read
// (readCellAsync — both async hosts expose it; the local in-process host
// does not, and falls back to the sync read) and await each restore
// execute, so the reported result is the engine's real result. Undo/redo
// restores go through host.execute() exactly like the original edit —
// on the gateway host that IS the routed-edit path (HYBRID-CONSISTENCY:
// the server stays source of truth; an undo is itself a routed edit).
// ---------------------------------------------------------------------------

/** Hosts whose reads/executes settle asynchronously expose this. */
interface AsyncReadableHost {
  readCellAsync(ref: {
    sheet: string;
    row: number;
    col: number;
  }): Promise<{ value: import('@icecream-sheets/engine').TypedValue; formula?: string }>;
}

function asyncReader(host: EngineHost): AsyncReadableHost | null {
  const candidate = host as EngineHost & Partial<AsyncReadableHost>;
  return typeof candidate.readCellAsync === 'function'
    ? (candidate as AsyncReadableHost)
    : null;
}

/** True when the host's execute()/reads settle asynchronously. */
export function isAsyncHost(host: EngineHost): boolean {
  return asyncReader(host) !== null;
}

async function readBeforeAsync(
  host: EngineHost,
  sheet: string,
  row: number,
  col: number,
): Promise<CellBefore> {
  const reader = asyncReader(host);
  if (!reader) return readBefore(host, sheet, row, col);
  const cell = await reader.readCellAsync({ sheet, row, col });
  const v = cell.value;
  let value: string | number | boolean | null = null;
  if (v.kind === 'number' || v.kind === 'string' || v.kind === 'boolean') {
    value = v.value as string | number | boolean;
  }
  return { sheet, row, col, value, formula: cell.formula };
}

async function applyStateAsync(host: EngineHost, state: CellBefore): Promise<boolean> {
  const ref = cellRef(state.sheet, state.row, state.col);
  const res = await (state.formula !== undefined
    ? host.execute({ cmd: 'setFormula', ref, formula: state.formula })
    : host.execute({ cmd: 'setCell', ref, value: state.value }));
  return !!res?.ok;
}

export class UndoManager {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private readonly limit = 100;
  private namesHooks: NamesUndoHooks | null = null;
  private formatsHooks: FormatsUndoHooks | null = null;

  /** Register the named-range store hooks (call once at startup). */
  setNamesHooks(hooks: NamesUndoHooks | null): void {
    this.namesHooks = hooks;
  }

  /** Register the format-store hooks (call once at startup). */
  setFormatsHooks(hooks: FormatsUndoHooks | null): void {
    this.formatsHooks = hooks;
  }

  /** Capture before-state for cells about to change. Call BEFORE execute(). */
  capture(
    host: EngineHost,
    sheet: string,
    cells: { row: number; col: number }[],
    label: string,
    captureNames = false,
  ): void {
    const before = cells.map((c) => readBefore(host, sheet, c.row, c.col));
    this.undoStack.push({
      cells: before,
      namesBefore: captureNames && this.namesHooks ? this.namesHooks.snapshotNames() : undefined,
      label,
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Capture a names-only edit (define/delete/rename a named range, or a
   * structural op whose cells are already covered). Call BEFORE the edit.
   */
  captureNamesOnly(label: string): void {
    if (!this.namesHooks) return;
    this.undoStack.push({ cells: [], namesBefore: this.namesHooks.snapshotNames(), label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Capture a format-only edit (ribbon format, cell style, clear
   * formatting, format painter). Call BEFORE the format mutation —
   * issue #21: without this, Ctrl+Z after a format change popped an
   * unrelated value entry (or nothing) and the format never reverted.
   */
  captureFormatsOnly(label: string): void {
    if (!this.formatsHooks) return;
    this.undoStack.push({ cells: [], formatsBefore: this.formatsHooks.snapshotFormats(), label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Async capture: like capture(), but before-states are read through
   * the host's authoritative async read when it has one (gateway /
   * desktop IPC hosts — see the D2 note above), so an entry NEVER
   * records the read-through cache's placeholder for the real value.
   * Callers on async hosts MUST await this before executing the edit.
   */
  async captureAsync(
    host: EngineHost,
    sheet: string,
    cells: { row: number; col: number }[],
    label: string,
    captureNames = false,
  ): Promise<void> {
    const before: CellBefore[] = [];
    for (const c of cells) {
      before.push(await readBeforeAsync(host, sheet, c.row, c.col));
    }
    this.undoStack.push({
      cells: before,
      namesBefore: captureNames && this.namesHooks ? this.namesHooks.snapshotNames() : undefined,
      label,
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Current format store when the entry carries one (for the counterpart entry). */
  private currentFormats(entry: UndoEntry): FormatStore | undefined {
    return entry.formatsBefore !== undefined && this.formatsHooks
      ? this.formatsHooks.snapshotFormats()
      : undefined;
  }

  /** Restore the entry's captured format store, when it carries one. */
  private restoreFormats(entry: UndoEntry): boolean {
    if (entry.formatsBefore === undefined || !this.formatsHooks) return true;
    try {
      this.formatsHooks.restoreFormats(entry.formatsBefore);
      return true;
    } catch {
      return false;
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undoLabel(): string | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  /**
   * Undo the last entry: capture current state for redo, restore before-state
   * (cells first, then named-range definitions when the entry captured them).
   * Returns false if nothing to undo or a restore failed.
   */
  undo(host: EngineHost): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    // Capture current state so redo can restore it.
    const current = entry.cells.map((c) => readBefore(host, c.sheet, c.row, c.col));
    const currentNames =
      entry.namesBefore !== undefined && this.namesHooks ? this.namesHooks.snapshotNames() : undefined;
    const currentFormats = this.currentFormats(entry);
    let ok = true;
    for (const before of entry.cells) {
      if (!applyState(host, before)) ok = false;
    }
    if (entry.namesBefore !== undefined && this.namesHooks) {
      try {
        this.namesHooks.restoreNames(entry.namesBefore);
      } catch {
        ok = false;
      }
    }
    if (!this.restoreFormats(entry)) ok = false;
    this.redoStack.push({ cells: current, namesBefore: currentNames, formatsBefore: currentFormats, label: entry.label });
    return ok;
  }

  redo(host: EngineHost): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const current = entry.cells.map((c) => readBefore(host, c.sheet, c.row, c.col));
    const currentNames =
      entry.namesBefore !== undefined && this.namesHooks ? this.namesHooks.snapshotNames() : undefined;
    const currentFormats = this.currentFormats(entry);
    let ok = true;
    for (const state of entry.cells) {
      if (!applyState(host, state)) ok = false;
    }
    if (entry.namesBefore !== undefined && this.namesHooks) {
      try {
        this.namesHooks.restoreNames(entry.namesBefore);
      } catch {
        ok = false;
      }
    }
    if (!this.restoreFormats(entry)) ok = false;
    this.undoStack.push({ cells: current, namesBefore: currentNames, formatsBefore: currentFormats, label: entry.label });
    return ok;
  }

  /**
   * Async undo: like undo(), but the redo-state capture reads through
   * the host's authoritative async read and every restore execute is
   * awaited — so on gateway/desktop hosts the returned boolean is the
   * engine's real verdict, not `.ok` read off a Promise. Works on the
   * local host too (sync fallbacks), so callers can use it uniformly.
   */
  async undoAsync(host: EngineHost): Promise<boolean> {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const current: CellBefore[] = [];
    for (const c of entry.cells) {
      current.push(await readBeforeAsync(host, c.sheet, c.row, c.col));
    }
    const currentNames =
      entry.namesBefore !== undefined && this.namesHooks ? this.namesHooks.snapshotNames() : undefined;
    const currentFormats = this.currentFormats(entry);
    let ok = true;
    for (const before of entry.cells) {
      if (!(await applyStateAsync(host, before))) ok = false;
    }
    if (entry.namesBefore !== undefined && this.namesHooks) {
      try {
        this.namesHooks.restoreNames(entry.namesBefore);
      } catch {
        ok = false;
      }
    }
    if (!this.restoreFormats(entry)) ok = false;
    this.redoStack.push({ cells: current, namesBefore: currentNames, formatsBefore: currentFormats, label: entry.label });
    return ok;
  }

  /** Async redo: the counterpart of undoAsync (see its note). */
  async redoAsync(host: EngineHost): Promise<boolean> {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const current: CellBefore[] = [];
    for (const c of entry.cells) {
      current.push(await readBeforeAsync(host, c.sheet, c.row, c.col));
    }
    const currentNames =
      entry.namesBefore !== undefined && this.namesHooks ? this.namesHooks.snapshotNames() : undefined;
    const currentFormats = this.currentFormats(entry);
    let ok = true;
    for (const state of entry.cells) {
      if (!(await applyStateAsync(host, state))) ok = false;
    }
    if (entry.namesBefore !== undefined && this.namesHooks) {
      try {
        this.namesHooks.restoreNames(entry.namesBefore);
      } catch {
        ok = false;
      }
    }
    if (!this.restoreFormats(entry)) ok = false;
    this.undoStack.push({ cells: current, namesBefore: currentNames, formatsBefore: currentFormats, label: entry.label });
    return ok;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
