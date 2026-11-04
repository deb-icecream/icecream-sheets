/**
 * Macro library (View > Macros > View Macros) + Use Relative References.
 *
 * The recorder (apps/web/src/automation.ts) captures an ActionLog; this
 * module is the persistent library: named macros stored in the service
 * metadata store (localStorage), with run/edit/delete/rename. Running is
 * delegated to the parent via onRun (it owns the service replay applier);
 * editing re-opens the rendered TypeScript in the recorder dialog.
 *
 * Use Relative References: when on, a just-recorded log is rewritten so
 * cell refs are stored relative to the anchor cell active when recording
 * started (the Excel R1C1-relative behavior). The rewritten log keeps the
 * same ActionLog shape; refs become `{sheet, row, col}` offsets applied
 * from the run-time active cell by the parent's replay applier (see
 * isRelativeRef / resolveRelativeRef).
 */

import type { ActionLog, AutomationAction } from '@icecream-sheets/service';

export interface MacroEntry {
  id: string;
  name: string;
  /** Rendered TypeScript source (editable). */
  script: string;
  /** The recorded action log (runnable). */
  log: ActionLog;
  relativeRefs: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'icecream.macros.v1';
const RELREF_KEY = 'icecream.macros.useRelativeRefs';

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
    };
  } catch {
    return null;
  }
}

export function loadMacros(store?: StorageLike): MacroEntry[] {
  const s = store ?? defaultStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MacroEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function persistMacros(macros: MacroEntry[], store?: StorageLike): void {
  const s = store ?? defaultStorage();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, JSON.stringify(macros)); } catch { /* storage full */ }
}

/** Save a recorded log as a named macro (upsert by id when editing). */
export function saveMacro(
  input: { name: string; script: string; log: ActionLog; relativeRefs: boolean; id?: string },
  store?: StorageLike,
): MacroEntry[] {
  const now = new Date().toISOString();
  const macros = loadMacros(store);
  if (input.id) {
    const next = macros.map((m) =>
      m.id === input.id
        ? { ...m, name: input.name, script: input.script, log: input.log, relativeRefs: input.relativeRefs, updatedAt: now }
        : m,
    );
    persistMacros(next, store);
    return next;
  }
  const entry: MacroEntry = {
    id: `macro_${Date.now().toString(36)}`,
    name: input.name || 'Macro1',
    script: input.script,
    log: input.log,
    relativeRefs: input.relativeRefs,
    createdAt: now,
    updatedAt: now,
  };
  const next = [...macros, entry];
  persistMacros(next, store);
  return next;
}

export function deleteMacro(id: string, store?: StorageLike): MacroEntry[] {
  const next = loadMacros(store).filter((m) => m.id !== id);
  persistMacros(next, store);
  return next;
}

export function renameMacro(id: string, name: string, store?: StorageLike): MacroEntry[] {
  const next = loadMacros(store).map((m) =>
    m.id === id ? { ...m, name: name.trim() || m.name, updatedAt: new Date().toISOString() } : m,
  );
  persistMacros(next, store);
  return next;
}

// -- Use Relative References ------------------------------------------------

/** Persisted toggle (default false = absolute references). */
export function getUseRelativeReferences(store?: StorageLike): boolean {
  const s = store ?? defaultStorage();
  if (!s) return false;
  try { return s.getItem(RELREF_KEY) === '1'; } catch { return false; }
}

export function setUseRelativeReferences(on: boolean, store?: StorageLike): void {
  const s = store ?? defaultStorage();
  if (!s) return;
  try { s.setItem(RELREF_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

/**
 * A ref is "relative" when it carries the marker sheet prefix. Relative
 * refs store row/col as offsets from the anchor cell.
 */
export const RELATIVE_SHEET_MARKER = '__relative__';

export function isRelativeRef(ref: { sheet: string }): boolean {
  return ref.sheet === RELATIVE_SHEET_MARKER;
}

/** Resolve a (possibly relative) ref against the run-time active cell. */
export function resolveRelativeRef(
  ref: { sheet: string; row: number; col: number },
  anchor: { sheet: string; row: number; col: number },
): { sheet: string; row: number; col: number } {
  if (!isRelativeRef(ref)) return ref;
  return { sheet: anchor.sheet, row: Math.max(0, anchor.row + ref.row), col: Math.max(0, anchor.col + ref.col) };
}

function relativizeRef(
  ref: { sheet: string; row: number; col: number },
  anchor: { sheet: string; row: number; col: number },
): { sheet: string; row: number; col: number } {
  return { sheet: RELATIVE_SHEET_MARKER, row: ref.row - anchor.row, col: ref.col - anchor.col };
}

function relativizeRange(
  range: { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number },
  anchor: { sheet: string; row: number; col: number },
): typeof range {
  return {
    sheet: RELATIVE_SHEET_MARKER,
    startRow: range.startRow - anchor.row,
    startCol: range.startCol - anchor.col,
    endRow: range.endRow - anchor.row,
    endCol: range.endCol - anchor.col,
  };
}

/**
 * Rewrite a recorded log so cell/range refs are relative to the anchor
 * cell (the active cell when recording started). Actions without cell
 * refs pass through unchanged.
 */
export function applyRelativeRefs(
  log: ActionLog,
  anchor: { sheet: string; row: number; col: number },
): ActionLog {
  const map = (a: AutomationAction): AutomationAction => {
    switch (a.kind) {
      case 'setCell': return { ...a, ref: relativizeRef(a.ref, anchor) };
      case 'setFormula': return { ...a, ref: relativizeRef(a.ref, anchor) };
      case 'setRange': return { ...a, range: relativizeRange(a.range, anchor) };
      case 'clearRange': return { ...a, range: relativizeRange(a.range, anchor) };
      case 'setCellFormat': return { ...a, range: relativizeRange(a.range, anchor) };
      case 'sortRange': return { ...a, range: relativizeRange(a.range, anchor) };
      case 'setAutoFilter': return { ...a, range: relativizeRange(a.range, anchor) };
      default: return a;
    }
  };
  return { ...log, actions: log.actions.map(map) };
}
