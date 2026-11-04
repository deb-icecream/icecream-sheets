/**
 * Advanced Filter (Data > Sort & Filter > Advanced…).
 *
 * Pure implementation of Excel's advanced-filter semantics over a string
 * matrix:
 * - data[0] is the header row; criteria[0] holds field names that must
 *   match data headers (blank criteria headers are ignored).
 * - Within one criteria row the non-blank cells are ANDed; criteria rows
 *   are ORed. A fully blank criteria row matches everything.
 * - Criteria support Excel comparison operators (>, <, >=, <=, <>, =)
 *   with numeric comparison when both sides parse as numbers, plus
 *   wildcards (* and ?) for text matches. Matching is case-insensitive.
 * - uniqueOnly keeps the first occurrence of each identical row.
 *
 * applyAdvancedFilterToHost() is the host-bound entry point the ribbon
 * "Reapply" command uses: it re-reads the list range and rewrites the
 * destination, so Reapply never needs the dialog open.
 */
import type { EngineHost } from '@icecream-sheets/engine';
import { typedValueText } from './typedText';
import { parseA1RangeRef } from '@icecream-sheets/engine';

export interface AdvancedFilterSpec {
  /** A1 list range, e.g. "Sheet1!A1:D50". */
  listRange: string;
  /** A1 criteria range (first row = field names). */
  criteriaRange: string;
  uniqueOnly: boolean;
  /** When set, results are copied here; otherwise the list range is rewritten in place. */
  copyTo?: string;
}

export interface AdvancedFilterOutcome {
  /** Rows written (including the header row). */
  rows: string[][];
  /** Number of source data rows (excluding header). */
  sourceRows: number;
  /** Number of matched data rows (excluding header). */
  matchedRows: number;
}

/** Split a criterion into {op, operand}. Defaults to "=" with wildcards. */
function parseCriterion(raw: string): { op: string; operand: string } {
  const t = raw.trim();
  for (const op of ['>=', '<=', '<>', '>', '<', '=']) {
    if (t.startsWith(op)) return { op, operand: t.slice(op.length).trim() };
  }
  return { op: '=', operand: t };
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

function valuesEqual(cell: string, operand: string): boolean {
  if (operand.includes('*') || operand.includes('?')) return wildcardToRegExp(operand).test(cell);
  return cell.toLowerCase() === operand.toLowerCase();
}

function compareValues(cell: string, op: string, operand: string): boolean {
  const nCell = Number(cell);
  const nOp = Number(operand);
  const numeric = cell.trim() !== '' && operand.trim() !== '' && !Number.isNaN(nCell) && !Number.isNaN(nOp);
  if (op === '=') return valuesEqual(cell, operand);
  if (numeric) {
    switch (op) {
      case '>': return nCell > nOp;
      case '<': return nCell < nOp;
      case '>=': return nCell >= nOp;
      case '<=': return nCell <= nOp;
      case '<>': return nCell !== nOp;
    }
  }
  const a = cell.toLowerCase();
  const b = operand.toLowerCase();
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '<>': return a !== b;
    default: return false;
  }
}

function criterionMatches(cell: string, criterion: string): boolean {
  if (criterion.trim() === '') return true;
  const { op, operand } = parseCriterion(criterion);
  return compareValues(cell, op, operand);
}

/**
 * Run the advanced filter over a matrix. data[0] and criteria[0] are
 * header rows. Returns the header row plus matching data rows.
 */
export function applyAdvancedFilter(
  data: string[][],
  criteria: string[][],
  opts: { uniqueOnly: boolean },
): string[][] {
  if (data.length === 0) return [];
  const header = data[0];
  const body = data.slice(1);
  const critHeader = criteria.length > 0 ? criteria[0] : [];
  const critRows = criteria.slice(1);
  // Map each criteria column to a data column index (-1 = ignored).
  const colMap = critHeader.map((h) => {
    if (h.trim() === '') return -1;
    return header.findIndex((dh) => dh.trim().toLowerCase() === h.trim().toLowerCase());
  });
  const rowMatches = (row: string[]): boolean => {
    if (critRows.length === 0) return true;
    return critRows.some((cr) => {
      let anyConstraint = false;
      for (let c = 0; c < cr.length; c++) {
        const di = colMap[c];
        if (di === -1 || di === undefined) continue;
        const crit = cr[c] ?? '';
        if (crit.trim() === '') continue;
        anyConstraint = true;
        if (!criterionMatches(row[di] ?? '', crit)) return false;
      }
      // A fully blank criteria row matches everything (Excel behavior).
      return true && (anyConstraint || cr.every((c) => c.trim() === ''));
    });
  };
  let matched = body.filter(rowMatches);
  if (opts.uniqueOnly) {
    const seen = new Set<string>();
    matched = matched.filter((r) => {
      const key = JSON.stringify(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return [header, ...matched];
}

function readMatrix(host: EngineHost, a1: string): string[][] | null {
  const parsed = parseA1RangeRef(a1.includes('!') ? a1 : a1, '');
  if (!parsed || !parsed.sheet) return null;
  const view = host.getView();
  const out: string[][] = [];
  for (let r = parsed.startRow; r <= parsed.endRow; r++) {
    const row: string[] = [];
    for (let c = parsed.startCol; c <= parsed.endCol; c++) {
      row.push(typedValueText(view.readCell({ sheet: parsed.sheet, row: r, col: c }).value));
    }
    out.push(row);
  }
  return out;
}

function writeMatrix(host: EngineHost, sheet: string, startRow: number, startCol: number, rows: string[][]): void {
  rows.forEach((row, ri) => {
    row.forEach((value, ci) => {
      host.execute({ cmd: 'setCell', ref: { sheet, row: startRow + ri, col: startCol + ci }, value });
    });
  });
}

/**
 * Host-bound advanced filter used by the dialog and by ribbon "Reapply".
 * Reads the list + criteria ranges, filters, and writes the result either
 * in place (overwriting the list range and clearing leftover rows) or to
 * the copyTo destination.
 */
export function applyAdvancedFilterToHost(host: EngineHost, spec: AdvancedFilterSpec): AdvancedFilterOutcome {
  const listRef = parseA1RangeRef(spec.listRange, '');
  const data = readMatrix(host, spec.listRange);
  const criteria = readMatrix(host, spec.criteriaRange);
  if (!listRef || !listRef.sheet || !data || !criteria) {
    throw new Error('Advanced Filter: invalid list or criteria range.');
  }
  const rows = applyAdvancedFilter(data, criteria, { uniqueOnly: spec.uniqueOnly });
  const sheet = listRef.sheet;
  if (spec.copyTo) {
    const dest = parseA1RangeRef(spec.copyTo, sheet);
    if (!dest) throw new Error('Advanced Filter: invalid copy-to range.');
    writeMatrix(host, dest.sheet || sheet, dest.startRow, dest.startCol, rows);
  } else {
    // In-place: overwrite the list range, then clear rows below the result.
    writeMatrix(host, sheet, listRef.startRow, listRef.startCol, rows);
    const leftover = data.length - rows.length;
    for (let r = 0; r < leftover; r++) {
      for (let c = listRef.startCol; c <= listRef.endCol; c++) {
        host.execute({ cmd: 'setCell', ref: { sheet, row: listRef.startRow + rows.length + r, col: c }, value: '' });
      }
    }
  }
  return { rows, sourceRows: data.length - 1, matchedRows: rows.length - 1 };
}
