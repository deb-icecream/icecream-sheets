/**
 * KPI card visual — native reports (see design-docs/native-reports-and-dashboards.md §4).
 *
 * A KPI card shows one big number (an aggregation over a numeric field),
 * its label, the delta against a target, and threshold-based coloring.
 *
 * SERVICE-LAYER component: operates purely on plain JSON records that the
 * caller obtained via the typed computational view. No engine, DOM, or
 * storage imports. Fully unit-testable.
 */

import type { PivotRecord } from '../pivot.js';

/** Current version of the serialized KpiSpec. Bump when the shape changes. */
export const KPI_SPEC_VERSION = 1 as const;

/** Aggregations the KPI card supports (subset of the pivot aggregations). */
export type KpiAggregation = 'sum' | 'average' | 'count' | 'countnums' | 'max' | 'min';

export const KPI_AGGREGATIONS: { id: KpiAggregation; label: string }[] = [
  { id: 'sum', label: 'Sum' },
  { id: 'average', label: 'Average' },
  { id: 'count', label: 'Count' },
  { id: 'countnums', label: 'Count Numbers' },
  { id: 'max', label: 'Max' },
  { id: 'min', label: 'Min' },
];

/** Threshold-driven color for the big number. */
export type KpiStatus = 'good' | 'warn' | 'bad' | 'neutral';

export const KPI_STATUSES: KpiStatus[] = ['good', 'warn', 'bad', 'neutral'];

export interface KpiThreshold {
  /** The KPI value is at or above this bound for the threshold to match. */
  value: number;
  status: Exclude<KpiStatus, 'neutral'>;
  /** Optional label, e.g. "On target". */
  label?: string;
}

export type KpiFormat = 'number' | 'currency' | 'percent';

/**
 * Versioned, serializable KPI card spec. References a field on the visual's
 * data binding; the binding itself lives on the ReportSpec.
 */
export interface KpiSpec {
  version: typeof KPI_SPEC_VERSION;
  /** Numeric field to aggregate. */
  field: string;
  aggregation: KpiAggregation;
  /** Card label shown under the big number. */
  label: string;
  /** Optional target for the delta readout; null = no delta. */
  target: number | null;
  /**
   * Thresholds, evaluated from highest bound down: the first threshold whose
   * value the KPI meets or exceeds wins. No match → 'neutral'.
   */
  thresholds: KpiThreshold[];
  format: KpiFormat;
}

/** Build a KpiSpec with defaults. */
export function makeKpiSpec(partial: Partial<KpiSpec> & { field: string }): KpiSpec {
  const thresholds = (partial.thresholds ?? []).filter(
    (t): t is KpiThreshold => typeof t === 'object' && t !== null && typeof t.value === 'number',
  );
  return {
    version: KPI_SPEC_VERSION,
    field: partial.field,
    aggregation: partial.aggregation ?? 'sum',
    label: partial.label ?? partial.field,
    target: typeof partial.target === 'number' && Number.isFinite(partial.target) ? partial.target : null,
    thresholds: [...thresholds].sort((a, b) => b.value - a.value),
    format: partial.format ?? 'number',
  };
}

/**
 * Validate a KPI spec. Returns a list of error strings; empty = valid.
 * Pass the binding's field names to also check the field exists.
 */
export function validateKpiSpec(spec: unknown, fields?: string[]): string[] {
  const errors: string[] = [];
  if (typeof spec !== 'object' || spec === null) return ['kpi spec must be an object'];
  const s = spec as Partial<KpiSpec>;
  if (s.version !== KPI_SPEC_VERSION) errors.push(`unsupported kpi spec version ${String(s.version)}`);
  if (typeof s.field !== 'string' || s.field.trim() === '') {
    errors.push('kpi field must be a non-empty string');
  } else if (fields && !fields.includes(s.field)) {
    errors.push(`kpi field "${s.field}" is not in the binding fields`);
  }
  if (!KPI_AGGREGATIONS.some((a) => a.id === s.aggregation)) {
    errors.push(`unknown kpi aggregation "${String(s.aggregation)}"`);
  }
  if (typeof s.label !== 'string') errors.push('kpi label must be a string');
  if (s.target !== null && s.target !== undefined && (typeof s.target !== 'number' || !Number.isFinite(s.target))) {
    errors.push('kpi target must be a finite number or null');
  }
  if (!Array.isArray(s.thresholds)) {
    errors.push('kpi thresholds must be an array');
  } else {
    s.thresholds.forEach((t, i) => {
      if (typeof t !== 'object' || t === null || typeof t.value !== 'number' || !Number.isFinite(t.value)) {
        errors.push(`kpi threshold[${i}] needs a finite numeric value`);
      } else if (t.status !== 'good' && t.status !== 'warn' && t.status !== 'bad') {
        errors.push(`kpi threshold[${i}] has unknown status "${String(t.status)}"`);
      }
    });
  }
  if (s.format !== 'number' && s.format !== 'currency' && s.format !== 'percent') {
    errors.push(`unknown kpi format "${String(s.format)}"`);
  }
  return errors;
}

/** Computed result of a KPI card over a set of records. */
export interface KpiResult {
  value: number | null;
  label: string;
  /** value - target; null when the target is unset or the value is null. */
  delta: number | null;
  /** delta as a percentage of the target; null when target is 0/unset. */
  deltaPct: number | null;
  /** Threshold coloring: 'neutral' when no threshold matches. */
  status: KpiStatus;
  /** Display strings, formatted per spec.format. */
  formatted: string;
  deltaFormatted: string | null;
  targetFormatted: string | null;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

function aggregateField(records: PivotRecord[], field: string, agg: KpiAggregation): number | null {
  const nums: number[] = [];
  let nonBlank = 0;
  for (const r of records) {
    const v = r[field];
    if (!isBlank(v)) nonBlank += 1;
    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
  }
  switch (agg) {
    case 'count':
      return nonBlank;
    case 'countnums':
      return nums.length;
    case 'sum':
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
    case 'average':
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'max':
      return nums.length === 0 ? null : Math.max(...nums);
    case 'min':
      return nums.length === 0 ? null : Math.min(...nums);
  }
}

function formatNumber(v: number, format: KpiFormat): string {
  switch (format) {
    case 'currency':
      return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'percent':
      return `${(v * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    default:
      return Number.isInteger(v) ? v.toLocaleString('en-US') : String(Math.round(v * 100) / 100);
  }
}

function formatDelta(delta: number, format: KpiFormat): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const abs = Math.abs(delta);
  switch (format) {
    case 'currency':
      return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'percent':
      // For percent-formatted KPIs the delta is in percentage points.
      return `${sign}${(abs * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp`;
    default:
      return `${sign}${Number.isInteger(abs) ? abs.toLocaleString('en-US') : String(Math.round(abs * 100) / 100)}`;
  }
}

/**
 * Compute a KPI card from records read through the typed computational view
 * (already filtered by the report's slicers/filters by the caller).
 */
export function computeKpi(records: PivotRecord[], spec: KpiSpec): KpiResult {
  const errs = validateKpiSpec(spec);
  if (errs.length > 0) throw new Error(`invalid kpi spec: ${errs.join('; ')}`);

  const value = aggregateField(records, spec.field, spec.aggregation);
  const target = spec.target;
  const delta = value !== null && target !== null ? value - target : null;
  const deltaPct = delta !== null && target !== 0 ? (delta / (target as number)) * 100 : null;

  let status: KpiStatus = 'neutral';
  if (value !== null) {
    for (const t of spec.thresholds) {
      if (value >= t.value) {
        status = t.status;
        break;
      }
    }
  }

  return {
    value,
    label: spec.label,
    delta,
    deltaPct,
    status,
    formatted: value === null ? '—' : formatNumber(value, spec.format),
    deltaFormatted: delta === null ? null : formatDelta(delta, spec.format),
    targetFormatted: target === null ? null : formatNumber(target, spec.format),
  };
}
