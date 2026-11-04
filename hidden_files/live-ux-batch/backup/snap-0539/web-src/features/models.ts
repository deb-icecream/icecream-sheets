/**
 * UI-layer models for formatting/validation features.
 *
 * Conditional formatting rules, data validation rules, and merged ranges
 * are UI-layer state (the engine protocol has no formatting model).
 * They are evaluated against values read through the protocol view.
 */
import type { TypedValue } from '@icecream-sheets/engine';
import { formatDisplay } from '../engine';

// ---------------------------------------------------------------------------
// Conditional formatting
// ---------------------------------------------------------------------------

export type CFOperator = 'gt' | 'lt' | 'eq' | 'between' | 'contains';

export interface CFRule {
  id: number;
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  operator: CFOperator;
  /** For 'between': [low, high]. Otherwise [value]. */
  operands: string[];
  /** Background color applied on match. */
  color: string;
}

let cfId = 1;
export function makeCFRule(rule: Omit<CFRule, 'id'>): CFRule {
  return { ...rule, id: cfId++ };
}

function numOrNaN(s: string): number {
  const n = Number(s);
  return Number.isNaN(n) ? NaN : n;
}

export function cfMatches(rule: CFRule, value: TypedValue): boolean {
  const text = formatDisplay(value);
  switch (rule.operator) {
    case 'gt': {
      const n = numOrNaN(text);
      const t = numOrNaN(rule.operands[0] ?? '');
      return !Number.isNaN(n) && !Number.isNaN(t) && n > t;
    }
    case 'lt': {
      const n = numOrNaN(text);
      const t = numOrNaN(rule.operands[0] ?? '');
      return !Number.isNaN(n) && !Number.isNaN(t) && n < t;
    }
    case 'eq':
      return text === (rule.operands[0] ?? '');
    case 'between': {
      const n = numOrNaN(text);
      const lo = numOrNaN(rule.operands[0] ?? '');
      const hi = numOrNaN(rule.operands[1] ?? '');
      return !Number.isNaN(n) && !Number.isNaN(lo) && !Number.isNaN(hi) && n >= lo && n <= hi;
    }
    case 'contains':
      return text.toLowerCase().includes((rule.operands[0] ?? '').toLowerCase());
  }
}

export function cfColorFor(
  rules: CFRule[],
  sheet: string,
  row: number,
  col: number,
  value: TypedValue,
): string | null {
  for (const rule of rules) {
    if (rule.sheet !== sheet) continue;
    if (row < rule.startRow || row > rule.endRow || col < rule.startCol || col > rule.endCol) continue;
    if (cfMatches(rule, value)) return rule.color;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Data validation
// ---------------------------------------------------------------------------

export interface ValidationRule {
  id: number;
  sheet: string;
  row: number;
  col: number;
  /** Allowed values for list validation. */
  list: string[];
}

let vId = 1;
export function makeValidationRule(rule: Omit<ValidationRule, 'id'>): ValidationRule {
  return { ...rule, id: vId++ };
}

export function findValidation(
  rules: ValidationRule[],
  sheet: string,
  row: number,
  col: number,
): ValidationRule | null {
  return rules.find((r) => r.sheet === sheet && r.row === row && r.col === col) ?? null;
}

/** Check a raw edit string against a list-validation rule. */
export function validateEdit(rule: ValidationRule, text: string): boolean {
  return rule.list.includes(text.trim());
}

// ---------------------------------------------------------------------------
// Merged cells
// ---------------------------------------------------------------------------

export interface MergeRange {
  id: number;
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

let mId = 1;
export function makeMerge(range: Omit<MergeRange, 'id'>): MergeRange {
  return { ...range, id: mId++ };
}

/** The merge containing (row, col), if any. */
export function findMerge(
  merges: MergeRange[],
  sheet: string,
  row: number,
  col: number,
): MergeRange | null {
  return (
    merges.find(
      (m) =>
        m.sheet === sheet &&
        row >= m.startRow &&
        row <= m.endRow &&
        col >= m.startCol &&
        col <= m.endCol,
    ) ?? null
  );
}

/** True when (row, col) is the top-left anchor of its merge. */
export function isMergeAnchor(m: MergeRange, row: number, col: number): boolean {
  return m.startRow === row && m.startCol === col;
}

// ---------------------------------------------------------------------------
// Filters (UI display filtering)
// ---------------------------------------------------------------------------

/** Per-column allowed values; a row shows when every filtered column's display value is allowed. */
export type FilterState = Map<number, Set<string>>;

export function rowPassesFilter(
  filters: FilterState,
  rowValues: Map<number, string>,
): boolean {
  for (const [col, allowed] of filters) {
    const v = rowValues.get(col) ?? '';
    if (!allowed.has(v)) return false;
  }
  return true;
}
