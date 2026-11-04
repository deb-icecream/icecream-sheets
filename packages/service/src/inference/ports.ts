/**
 * Deterministic inference — host ports (design-docs/deterministic-inference.md §§2, 8).
 *
 * Inference runs as a service-layer component: it reads through the typed
 * view and proposes edits through the same APIs as any client, subject to
 * authorize(). These ports are how the host binds the analyzers:
 *
 * - usedRange / read: bound to the typed computational view. Denied cells
 *   arrive as { denied: true } — analyzers must treat them as unreadable
 *   and never base statistics on them.
 * - authorize: (action, target) -> boolean with the principal already
 *   bound. Targets follow the engine conventions used by accessPolicy():
 *   'Sheet!A1' (cell), 'Sheet!A1:B2' (range), 'Sheet' (sheet).
 *
 * Everything here is headless (no DOM) so analyzers run identically on
 * web, desktop, and the MCP server.
 */

import type { CellCoord } from './types.js';

/** 0-based inclusive bounds. */
export interface RangeBounds {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** One cell as seen by an analyzer. Denied cells carry no value. */
export interface InferenceCell {
  value: string | number | boolean | null;
  formula?: string;
  /** True when the principal may not read this cell (came back #PERM!). */
  denied: boolean;
}

export type InferenceReader = (sheet: string, bounds: RangeBounds) => InferenceCell[][];

export type InferenceUsedRange = (sheet: string) => RangeBounds | null;

/**
 * Bound authorize() for one principal. `action` uses engine action names
 * ('cell.read', 'range.read', 'cell.write', 'cell.clear'); `target` uses
 * engine target conventions ('Sheet!A1', 'Sheet!A1:B2', 'Sheet').
 */
export type InferenceAuthorize = (action: string, target: string) => boolean;

export interface InferenceContext {
  principal: string;
  usedRange: InferenceUsedRange;
  read: InferenceReader;
  authorize: InferenceAuthorize;
}

// ---------------------------------------------------------------------------
// A1 helpers (0-based rows/cols; Excel-style references)
// ---------------------------------------------------------------------------

export function colToLetters(col: number): string {
  if (!Number.isInteger(col) || col < 0) throw new Error(`inference: invalid column ${col}`);
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function lettersToCol(letters: string): number {
  const t = letters.toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(t)) throw new Error(`inference: invalid column letters '${letters}'`);
  let n = 0;
  for (const ch of t) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 'Sheet1!B3' for a 0-based coordinate. Sheets with special chars are quoted. */
export function a1Cell(coord: CellCoord): string {
  const sheet = /[^A-Za-z0-9_.]/.test(coord.sheet) ? `'${coord.sheet.replace(/'/g, "''")}'` : coord.sheet;
  return `${sheet}!${colToLetters(coord.col)}${coord.row + 1}`;
}

/** 'Sheet1!B3:D9' for 0-based inclusive bounds. */
export function a1Range(sheet: string, bounds: RangeBounds): string {
  const start = a1Cell({ sheet, row: bounds.startRow, col: bounds.startCol });
  return `${start}:${colToLetters(bounds.endCol)}${bounds.endRow + 1}`;
}

/** Display string for a cell value ('' for empty). */
export function displayValue(cell: InferenceCell): string {
  if (cell.denied) return '#PERM!';
  const v = cell.value;
  if (v === null || v === undefined) return '';
  return String(v);
}

/** True for cells the analyzer may read (not denied, non-empty). */
export function isReadableValue(cell: InferenceCell): boolean {
  return !cell.denied && cell.value !== null && cell.value !== undefined && cell.value !== '';
}
