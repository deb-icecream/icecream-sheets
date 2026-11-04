/**
 * Fill commands (Home > Editing > Fill): Fill Down/Right/Up/Left, Fill
 * Series…, and Justify.
 *
 * All mutations go through EngineHost.execute() (setCell / setFormula);
 * reads go through the protocol view. Like sheetOps.ts, these are
 * read-shift-write sequences because the protocol has no fill command.
 *
 * Formula handling matches Excel: relative references in a copied formula
 * are shifted by the fill offset (see shiftFormulaRefs); absolute ($) parts
 * stay put. A reference shifted off the grid becomes #REF!.
 */
import type { EngineHost } from '@icecream-sheets/engine';
import { cellRef, colLabel, formatDisplay } from '../engine';

export type FillDirection = 'down' | 'up' | 'right' | 'left';

export interface FillRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// ---------------------------------------------------------------------------
// Formula reference shifting
// ---------------------------------------------------------------------------

function colLettersToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Split a formula into code / string-literal segments so reference
 * rewriting never touches text inside double quotes.
 */
function splitLiterals(formula: string): { text: string; literal: boolean }[] {
  const out: { text: string; literal: boolean }[] = [];
  let cur = '';
  let inStr = false;
  let i = 0;
  const flush = (literal: boolean) => {
    if (cur !== '') out.push({ text: cur, literal });
    cur = '';
  };
  while (i < formula.length) {
    const ch = formula[i];
    if (inStr) {
      cur += ch;
      if (ch === '"') {
        if (formula[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inStr = false;
        flush(true);
      }
      i++;
    } else if (ch === '"') {
      flush(false);
      inStr = true;
      cur = '"';
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  flush(inStr);
  return out;
}

const REF_RE = /(?<![A-Za-z0-9_.$])(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)(?![A-Za-z0-9_(])/g;

/**
 * Shift relative A1 references in a formula by (dRow, dCol), Excel-style:
 * `$` pins the column and/or row; anything shifted before row 1 / column A
 * becomes #REF!. String literals are left untouched, as are names that
 * merely contain letter-digit runs (guarded by word boundaries).
 */
export function shiftFormulaRefs(formula: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return formula;
  return splitLiterals(formula)
    .map((seg) => {
      if (seg.literal) return seg.text;
      return seg.text.replace(REF_RE, (_m, colAbs: string, letters: string, rowAbs: string, rowNum: string) => {
        const col = colLettersToIndex(letters) + (colAbs === '$' ? 0 : dCol);
        const row = Number(rowNum) - 1 + (rowAbs === '$' ? 0 : dRow);
        if (col < 0 || col > 16383 || row < 0 || row > 1048575) return '#REF!';
        return `${colAbs}${colLabel(col)}${rowAbs}${row + 1}`;
      });
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Fill Down / Up / Right / Left
// ---------------------------------------------------------------------------

interface EdgeCell {
  formula?: string;
  value: string | number | boolean | null;
}

function readEdgeCell(host: EngineHost, sheet: string, row: number, col: number): EdgeCell {
  const cell = host.getView().readCell(cellRef(sheet, row, col));
  let value: string | number | boolean | null = null;
  if (cell.value.kind === 'number' || cell.value.kind === 'string' || cell.value.kind === 'boolean') {
    value = cell.value.value as string | number | boolean;
  }
  return { formula: cell.formula, value };
}

function writeFilled(
  host: EngineHost,
  sheet: string,
  row: number,
  col: number,
  edge: EdgeCell,
  dRow: number,
  dCol: number,
): void {
  const ref = cellRef(sheet, row, col);
  if (edge.formula !== undefined) {
    host.execute({ cmd: 'setFormula', ref, formula: shiftFormulaRefs(edge.formula, dRow, dCol) });
  } else {
    host.execute({ cmd: 'setCell', ref, value: edge.value });
  }
}

/**
 * Fill a rectangular selection from its edge: Down copies the top row down,
 * Up copies the bottom row up, Right copies the left column right, Left
 * copies the right column left. Formulas adjust relative references.
 * Returns the number of cells written.
 */
export function fillDirection(host: EngineHost, sheet: string, range: FillRange, dir: FillDirection): number {
  let written = 0;
  if (dir === 'down' || dir === 'up') {
    const srcRow = dir === 'down' ? range.startRow : range.endRow;
    for (let r = range.startRow; r <= range.endRow; r++) {
      if (r === srcRow) continue;
      for (let c = range.startCol; c <= range.endCol; c++) {
        const edge = readEdgeCell(host, sheet, srcRow, c);
        writeFilled(host, sheet, r, c, edge, r - srcRow, 0);
        written++;
      }
    }
  } else {
    const srcCol = dir === 'right' ? range.startCol : range.endCol;
    for (let c = range.startCol; c <= range.endCol; c++) {
      if (c === srcCol) continue;
      for (let r = range.startRow; r <= range.endRow; r++) {
        const edge = readEdgeCell(host, sheet, r, srcCol);
        writeFilled(host, sheet, r, c, edge, 0, c - srcCol);
        written++;
      }
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Fill Series
// ---------------------------------------------------------------------------

export interface FillSeriesOptions {
  /** Step between values (default 1). For growth series this is the multiplier. */
  step?: number;
  /** Stop generating once the next value would pass this (linear only). */
  stopValue?: number;
  /** Treat numeric seeds as date serials and step by this unit. */
  dateUnit?: 'day' | 'month' | 'year';
  /** Multiply by step each row instead of adding (Growth). */
  growth?: boolean;
}

function daysToDateParts(serial: number): { y: number; m: number; d: number } {
  const ms = Math.round((serial - 25569) * 86400000);
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
}

function datePartsToSerial(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m, d) / 86400000) + 25569;
}

function addDateUnit(serial: number, unit: 'day' | 'month' | 'year', steps: number): number {
  const p = daysToDateParts(serial);
  if (unit === 'day') return serial + steps;
  if (unit === 'month') {
    const totalMonths = p.y * 12 + p.m + steps;
    return datePartsToSerial(Math.floor(totalMonths / 12), totalMonths % 12, Math.min(p.d, 28));
  }
  return datePartsToSerial(p.y + steps, p.m, Math.min(p.d, 28));
}

/**
 * Fill Series over a single row or single column range (Excel's Series…
 * dialog). Seeds come from the first cell, or the first two cells when both
 * are numeric (step inferred). Numbers extend linearly (or geometrically
 * with growth, or by date unit with dateUnit); text seeds are copied.
 * Returns the number of cells written.
 */
export function fillSeries(host: EngineHost, sheet: string, range: FillRange, opts: FillSeriesOptions = {}): number {
  const singleRow = range.startRow === range.endRow;
  const singleCol = range.startCol === range.endCol;
  if (!singleRow && !singleCol) return 0; // Excel requires a single row or column.
  const len = singleRow ? range.endCol - range.startCol + 1 : range.endRow - range.startRow + 1;
  if (len < 2) return 0;

  const at = (i: number): { row: number; col: number } =>
    singleRow ? { row: range.startRow, col: range.startCol + i } : { row: range.startRow + i, col: range.startCol };

  const seedCell = (i: number) => host.getView().readCell(cellRef(sheet, at(i).row, at(i).col));
  const seedValue = (i: number): number | string | null => {
    const v = seedCell(i).value;
    if (v.kind === 'number' && Number.isFinite(v.value)) return v.value as number;
    if (v.kind === 'string') return v.value as string;
    return null;
  };

  const v0 = seedValue(0);
  const v1 = seedValue(1);
  let step = opts.step ?? 1;
  let written = 0;

  const writeAt = (i: number, value: string | number): void => {
    const p = at(i);
    host.execute({ cmd: 'setCell', ref: cellRef(sheet, p.row, p.col), value });
    written++;
  };

  if (typeof v0 === 'number' && (typeof v1 === 'number' || v1 === null)) {
    // Numeric series.
    if (typeof v1 === 'number' && opts.step === undefined) {
      step = opts.growth && v0 !== 0 ? v1 / v0 : v1 - v0;
    }
    for (let i = 1; i < len; i++) {
      let next: number;
      if (opts.dateUnit) {
        next = addDateUnit(v0, opts.dateUnit, step * i);
      } else if (opts.growth) {
        next = v0 * Math.pow(step, i);
      } else {
        next = v0 + step * i;
      }
      if (opts.stopValue !== undefined && !opts.growth && !opts.dateUnit) {
        if ((step >= 0 && next > opts.stopValue) || (step < 0 && next < opts.stopValue)) break;
      }
      if (!Number.isFinite(next)) break;
      writeAt(i, Math.abs(next - Math.round(next)) < 1e-9 ? Math.round(next) : next);
    }
    return written;
  }

  if (typeof v0 === 'string') {
    // Text seeds are copied, Excel-style.
    for (let i = 1; i < len; i++) writeAt(i, v0);
    return written;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Justify
// ---------------------------------------------------------------------------

/**
 * Justify (Home > Editing > Fill > Justify): merge the text of a row range
 * into as few cells as needed, word-wrapping across the columns by their
 * widths (in characters; defaults to 12 per column). Overflow words that do
 * not fit the whole range are dropped, Excel-style; vacated cells are
 * cleared.
 */
export function justifyText(
  host: EngineHost,
  sheet: string,
  row: number,
  startCol: number,
  endCol: number,
  colWidths?: number[],
): void {
  const n = endCol - startCol + 1;
  if (n < 1) return;
  const widths = Array.from({ length: n }, (_, i) => Math.max(1, Math.floor(colWidths?.[i] ?? 12)));

  const words: string[] = [];
  for (let c = startCol; c <= endCol; c++) {
    const text = formatDisplay(host.getView().readCell(cellRef(sheet, row, c)).value);
    for (const w of text.split(/\s+/)) {
      if (w !== '') words.push(w);
    }
  }

  // Greedy word wrap across the columns.
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const col = Math.min(lines.length, n - 1);
    const trial = line === '' ? w : `${line} ${w}`;
    if (trial.length <= widths[col] || line === '') {
      line = trial;
    } else {
      lines.push(line);
      if (lines.length >= n) {
        line = '';
        break; // No more columns: drop the rest, like Excel.
      }
      line = w;
    }
  }
  if (line !== '' && lines.length < n) lines.push(line);

  for (let i = 0; i < n; i++) {
    host.execute({
      cmd: 'setCell',
      ref: cellRef(sheet, row, startCol + i),
      value: lines[i] ?? null,
    });
  }
}
