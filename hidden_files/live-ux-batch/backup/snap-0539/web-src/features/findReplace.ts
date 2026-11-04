/**
 * Find/replace over the sheet's used range, through the engine protocol.
 *
 * Search reads cell display values via the protocol view; replace writes
 * through EngineHost.execute(). Nothing touches HyperFormula directly.
 */
import type { EngineHost } from '@icecream-sheets/engine';
import { cellRef, formatDisplay } from '../engine';

export interface FindOptions {
  matchCase: boolean;
  wholeCell: boolean;
}

export interface FoundCell {
  row: number;
  col: number;
}

function matches(text: string, query: string, opts: FindOptions): boolean {
  if (!opts.matchCase) {
    text = text.toLowerCase();
    query = query.toLowerCase();
  }
  if (opts.wholeCell) return text === query;
  return text.includes(query);
}

function replaceText(text: string, query: string, replacement: string, opts: FindOptions): string {
  if (opts.wholeCell) {
    return matches(text, query, opts) ? replacement : text;
  }
  if (opts.matchCase) {
    return text.split(query).join(replacement);
  }
  // Case-insensitive replace: walk with a regex.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), replacement);
}

/** All cells in the used range whose display text matches. */
export function findAll(
  host: EngineHost,
  sheet: string,
  query: string,
  opts: FindOptions,
): FoundCell[] {
  if (query === '') return [];
  const used = host.getView().usedRange(sheet);
  if (!used) return [];
  const values = host.readRange({
    sheet,
    startRow: used.startRow,
    startCol: used.startCol,
    endRow: used.endRow,
    endCol: used.endCol,
  });
  const out: FoundCell[] = [];
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      const text = formatDisplay(values[r][c]);
      if (matches(text, query, opts)) {
        out.push({ row: used.startRow + r, col: used.startCol + c });
      }
    }
  }
  return out;
}

/**
 * Replace in every matching cell. Formulas are replaced in their formula
 * text; values in their display text (committed back as plain text edits).
 * Returns the number of cells changed.
 */
export function replaceAll(
  host: EngineHost,
  sheet: string,
  query: string,
  replacement: string,
  opts: FindOptions,
): number {
  const found = findAll(host, sheet, query, opts);
  let changed = 0;
  for (const { row, col } of found) {
    const cell = host.getView().readCell(cellRef(sheet, row, col));
    const ref = cellRef(sheet, row, col);
    let res;
    if (cell.formula !== undefined) {
      const next = replaceText(cell.formula, query, replacement, opts);
      if (next === cell.formula) continue;
      res = host.execute({ cmd: 'setFormula', ref, formula: next });
    } else {
      const text = formatDisplay(cell.value);
      const next = replaceText(text, query, replacement, opts);
      if (next === text) continue;
      // Commit as a raw string so "123" replacements don't coerce unexpectedly.
      // Use setCell with the string value directly.
      res = host.execute({ cmd: 'setCell', ref, value: next });
    }
    if (res.ok) changed++;
  }
  return changed;
}
