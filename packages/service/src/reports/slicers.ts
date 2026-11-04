/**
 * Report slicers — native reports (see design-docs/native-reports-and-dashboards.md §5).
 *
 * A slicer is bound to a field name (not a grid column). It filters EVERY
 * visual on the report whose data binding includes that field. Empty
 * `selected` = "select all" = no filtering.
 *
 * SERVICE-LAYER, pure and headless: operates on plain JSON records read
 * through the typed computational view. Values are matched against display
 * labels ('(blank)' for blanks, 'TRUE'/'FALSE' for booleans), the same
 * convention pivot filters use.
 */

import type { PivotRecord } from '../pivot.js';
import type { ReportBinding } from './spec.js';

/**
 * Report filter (typed, validated against the binding schema). Applies to
 * every visual whose binding includes `field`, like slicers.
 */
export type ReportFilterOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains';

export const REPORT_FILTER_OPS: { id: ReportFilterOp; label: string }[] = [
  { id: '=', label: 'equals' },
  { id: '!=', label: 'does not equal' },
  { id: '>', label: 'greater than' },
  { id: '>=', label: 'greater than or equal' },
  { id: '<', label: 'less than' },
  { id: '<=', label: 'less than or equal' },
  { id: 'contains', label: 'contains' },
];

export interface ReportFilter {
  id: string;
  field: string;
  op: ReportFilterOp;
  value: string | number | boolean;
}

/** Field-bound slicer on a report page. */
export interface ReportSlicer {
  id: string;
  /** Field name in the bound tables. */
  field: string;
  /** Selected display labels; empty = select all (no filter). */
  selected: string[];
}

export function makeReportSlicer(partial: Partial<ReportSlicer> & { field: string }): ReportSlicer {
  return {
    id: partial.id ?? `slicer-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    field: partial.field,
    selected: Array.isArray(partial.selected) ? [...partial.selected] : [],
  };
}

/** Display label for a raw record value (pivot-filter convention). */
export function slicerLabelOf(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** Toggle a value in the slicer selection; selecting all collapses to []. */
export function toggleSlicerValue(slicer: ReportSlicer, value: string, allValues: string[]): ReportSlicer {
  const current = slicer.selected.length === 0 ? [...allValues] : [...slicer.selected];
  const i = current.indexOf(value);
  if (i >= 0) current.splice(i, 1);
  else current.push(value);
  const selected =
    current.length === allValues.length && allValues.every((v) => current.includes(v)) ? [] : current;
  return { ...slicer, selected };
}

/** Clear the slicer (select all). */
export function clearReportSlicer(slicer: ReportSlicer): ReportSlicer {
  return { ...slicer, selected: [] };
}

/** True when a display label passes the slicer. */
export function slicerPasses(slicer: ReportSlicer, label: string): boolean {
  return slicer.selected.length === 0 || slicer.selected.includes(label);
}

/** Distinct sorted display labels for a field, for the slicer UI. */
export function distinctFieldValues(records: PivotRecord[], field: string): string[] {
  const set = new Set<string>();
  for (const r of records) set.add(slicerLabelOf(r[field]));
  return [...set].sort();
}

/** A slicer applies to a binding when the binding's fields include the field. */
export function slicerAppliesToBinding(slicer: ReportSlicer, binding: ReportBinding): boolean {
  return binding.fields.includes(slicer.field);
}

/** Filter records through the slicers that apply to the binding. */
export function applySlicers(
  records: PivotRecord[],
  binding: ReportBinding,
  slicers: ReportSlicer[],
): PivotRecord[] {
  const active = slicers.filter((s) => slicerAppliesToBinding(s, binding) && s.selected.length > 0);
  if (active.length === 0) return records;
  return records.filter((r) => active.every((s) => slicerPasses(s, slicerLabelOf(r[s.field]))));
}

function isNumericLike(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function coerceNumber(v: unknown): number | null {
  if (isNumericLike(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** True when a record passes one typed report filter. */
export function filterPasses(filter: ReportFilter, record: PivotRecord): boolean {
  const raw = record[filter.field];
  const fv = filter.value;
  switch (filter.op) {
    case '=':
      return isNumericLike(fv) && isNumericLike(raw) ? raw === fv : slicerLabelOf(raw) === String(fv);
    case '!=':
      return isNumericLike(fv) && isNumericLike(raw) ? raw !== fv : slicerLabelOf(raw) !== String(fv);
    case 'contains':
      return slicerLabelOf(raw).toLowerCase().includes(String(fv).toLowerCase());
    case '>':
    case '>=':
    case '<':
    case '<=': {
      // Prefer numeric comparison when both sides parse as numbers,
      // otherwise fall back to lexicographic comparison of labels.
      const a = coerceNumber(raw);
      const b = coerceNumber(fv);
      if (a !== null && b !== null) {
        if (filter.op === '>') return a > b;
        if (filter.op === '>=') return a >= b;
        if (filter.op === '<') return a < b;
        return a <= b;
      }
      const as = slicerLabelOf(raw);
      const bs = String(fv);
      if (filter.op === '>') return as > bs;
      if (filter.op === '>=') return as >= bs;
      if (filter.op === '<') return as < bs;
      return as <= bs;
    }
  }
}

/**
 * Apply typed report filters to records. A filter applies only to bindings
 * that include its field (same rule as slicers); pass only the filters that
 * apply, or filter here and let the caller pre-select them.
 */
export function applyReportFilters(records: PivotRecord[], filters: ReportFilter[]): PivotRecord[] {
  if (filters.length === 0) return records;
  return records.filter((r) => filters.every((f) => filterPasses(f, r)));
}

/**
 * Combined pipeline for one visual: report-level typed filters first, then
 * the field-bound slicers — both restricted to filters/slicers whose field
 * the binding includes.
 */
export function applyFiltersAndSlicers(
  records: PivotRecord[],
  binding: ReportBinding,
  slicers: ReportSlicer[],
  filters: ReportFilter[],
): PivotRecord[] {
  const applicableFilters = filters.filter((f) => binding.fields.includes(f.field));
  const applicableSlicers = slicers.filter((s) => slicerAppliesToBinding(s, binding));
  return applySlicers(applyReportFilters(records, applicableFilters), binding, applicableSlicers);
}

/** Validate one slicer spec. */
export function validateReportSlicer(slicer: unknown): string[] {
  const errors: string[] = [];
  if (typeof slicer !== 'object' || slicer === null) return ['slicer must be an object'];
  const s = slicer as Partial<ReportSlicer>;
  if (typeof s.id !== 'string' || s.id.trim() === '') errors.push('slicer id must be a non-empty string');
  if (typeof s.field !== 'string' || s.field.trim() === '') errors.push('slicer field must be a non-empty string');
  if (!Array.isArray(s.selected) || !s.selected.every((v) => typeof v === 'string')) {
    errors.push('slicer selected must be an array of strings');
  }
  return errors;
}

/** Validate one typed report filter (shape only; field existence is checked against bindings). */
export function validateReportFilter(filter: unknown): string[] {
  const errors: string[] = [];
  if (typeof filter !== 'object' || filter === null) return ['filter must be an object'];
  const f = filter as Partial<ReportFilter>;
  if (typeof f.id !== 'string' || f.id.trim() === '') errors.push('filter id must be a non-empty string');
  if (typeof f.field !== 'string' || f.field.trim() === '') errors.push('filter field must be a non-empty string');
  if (!REPORT_FILTER_OPS.some((o) => o.id === f.op)) errors.push(`unknown filter op "${String(f.op)}"`);
  if (typeof f.value !== 'string' && typeof f.value !== 'number' && typeof f.value !== 'boolean') {
    errors.push('filter value must be a string, number or boolean');
  }
  return errors;
}
