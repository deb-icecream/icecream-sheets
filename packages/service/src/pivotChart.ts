/**
 * PivotCharts: charts bound to pivot table results.
 *
 * A PivotChart binds a ChartSpec to a pivot table (by pivot overlay id)
 * rather than to a cell range. The series are derived from the
 * PivotResult matrix: row keys become category labels, column keys become
 * datasets, and one value field (selected at insert time) supplies the
 * values. Because the chart re-derives its series from the live pivot
 * result on every render tick, it stays in sync when the pivot is
 * refreshed — no snapshot copies.
 */

import type { ChartSeries } from './chartModel.js';
import type { PivotResult } from './pivot.js';

/** Binding stored on ChartSpec.pivot: which pivot + which value field. */
export interface PivotChartBinding {
  /** Pivot overlay id (App-level), unique per workbook session. */
  pivotId: number;
  /** Index into PivotResult.valueLabels / the data cube's value axis. */
  valueIndex: number;
}

/** Transpose: column keys become labels, row keys become datasets. */
export type PivotChartOrientation = 'rowsAsLabels' | 'columnsAsLabels';

/**
 * Convert a pivot result into chart series. Each dataset is one column-key
 * tuple (or row-key tuple when transposed); labels are the opposite axis.
 * Grand-total columns/rows are excluded — the chart shows detail cells.
 */
export function pivotResultToSeries(
  result: PivotResult,
  valueIndex: number,
  orientation: PivotChartOrientation = 'rowsAsLabels',
): ChartSeries {
  const vi = Math.max(0, Math.min(result.valueLabels.length - 1, valueIndex));
  const joinKeys = (keys: string[][]): string[] => keys.map((k) => k.join(' | '));
  if (orientation === 'rowsAsLabels') {
    const labels = joinKeys(result.rowKeys);
    const datasets = result.colKeys.map((ck, ci) => ({
      label: ck.join(' | '),
      data: result.data.map((row) => row[ci]?.[vi] ?? null),
    }));
    return { labels, datasets };
  }
  const labels = joinKeys(result.colKeys);
  const datasets = result.rowKeys.map((rk, ri) => ({
    label: rk.join(' | '),
    data: result.data[ri].map((cell) => cell[vi] ?? null),
  }));
  return { labels, datasets };
}

/** Human-readable description of a pivot chart binding (chart title etc). */
export function describePivotBinding(
  result: PivotResult,
  binding: PivotChartBinding,
): string {
  const valueLabel = result.valueLabels[binding.valueIndex] ?? `Value ${binding.valueIndex + 1}`;
  return `PivotChart of ${valueLabel}`;
}

/**
 * File-persistent form of a pivot binding. Pivot overlay ids are
 * session-local, so a chart saved into an .xlsx file binds by the pivot
 * table's NAME (workbook-unique in Excel); the id is resolved back on open.
 */
export interface PivotChartFileBinding {
  pivotName: string;
  valueIndex: number;
}

/** Type guard for the file-persistent binding shape (validates metadata). */
export function isPivotChartFileBinding(v: unknown): v is PivotChartFileBinding {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.pivotName === 'string' &&
    b.pivotName.length > 0 &&
    typeof b.valueIndex === 'number' &&
    Number.isInteger(b.valueIndex) &&
    b.valueIndex >= 0
  );
}

/**
 * Convert a live (id-based) binding to its file-persistent form.
 * Returns undefined when the pivot name is unknown (the chart is saved
 * without its pivot binding rather than with a dangling name).
 */
export function pivotBindingToFile(
  binding: PivotChartBinding | undefined,
  pivotName: string | undefined,
): PivotChartFileBinding | undefined {
  if (!binding) return undefined;
  if (!pivotName || pivotName.length === 0) return undefined;
  return { pivotName, valueIndex: binding.valueIndex };
}

/**
 * Resolve a file-persistent binding back to a live (id-based) binding.
 * Returns undefined when the pivot is not present in this session — the
 * caller keeps the chart (the renderer shows a "pivot no longer exists"
 * error) rather than inventing data.
 */
export function pivotBindingFromFile(
  stored: unknown,
  pivotId: number | undefined,
): PivotChartBinding | undefined {
  if (!isPivotChartFileBinding(stored)) return undefined;
  if (pivotId === undefined) return undefined;
  return { pivotId, valueIndex: stored.valueIndex };
}
