/**
 * Analysis chart spec — the visual contract between the sandboxed Python
 * script and the renderer (design-docs: data-analysis component §5).
 *
 * The generated Python script emits a chartSpec of this shape (as part of
 * the ONE JSON object it assigns to `result`). This module validates the
 * shape on the host side and maps it to a chart.js ChartConfiguration,
 * which renders through the existing ChartCanvas component.
 *
 * This is deliberately a SUBSET of Chart.js: fixed chart types, plain
 * label/data arrays, no callbacks or plugin objects — so a sandboxed
 * script can produce it from JSON alone and the host can validate it
 * cheaply. READ-ONLY with respect to packages/service/src/chartModel.ts:
 * chart-kind parity lives in the sibling lane; this file never imports
 * or edits chartModel.
 */
import type { ChartConfiguration } from 'chart.js';

export type AnalysisChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter' | 'radar';

/** One series. For 'scatter', data points are {x, y} objects. */
export interface AnalysisChartDataset {
  label: string;
  data: (number | { x: number; y: number } | null)[];
  backgroundColor?: string;
  borderColor?: string;
  /** Dashed stroke, e.g. the forecast overlay on a trend line. */
  borderDash?: number[];
  fill?: boolean;
}

export interface AnalysisChartSpec {
  type: AnalysisChartType;
  title?: string;
  labels?: string[];
  datasets: AnalysisChartDataset[];
}

const TYPES: AnalysisChartType[] = ['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar'];

const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

export const colorFor = (i: number): string => PALETTE[i % PALETTE.length];

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPoint(v: unknown): v is { x: number; y: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    isNum((v as { x?: unknown }).x) &&
    isNum((v as { y?: unknown }).y)
  );
}

function isDataset(v: unknown): v is AnalysisChartDataset {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  if (typeof d.label !== 'string' || !Array.isArray(d.data)) return false;
  if (d.data.length > 100_000) return false;
  return d.data.every((p) => p === null || isNum(p) || isPoint(p));
}

/**
 * Validate an untrusted chartSpec (it crossed the sandbox boundary).
 * Returns the spec when valid, or an error string when not.
 */
export function validateAnalysisChartSpec(value: unknown): { ok: true; spec: AnalysisChartSpec } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'chartSpec must be an object' };
  }
  const s = value as Record<string, unknown>;
  if (!TYPES.includes(s.type as AnalysisChartType)) {
    return { ok: false, error: `chartSpec.type must be one of ${TYPES.join(', ')}` };
  }
  if (s.title !== undefined && typeof s.title !== 'string') {
    return { ok: false, error: 'chartSpec.title must be a string' };
  }
  if (s.labels !== undefined) {
    if (!Array.isArray(s.labels) || s.labels.some((l) => typeof l !== 'string')) {
      return { ok: false, error: 'chartSpec.labels must be a string array' };
    }
    if (s.labels.length > 100_000) return { ok: false, error: 'chartSpec.labels too long' };
  }
  if (!Array.isArray(s.datasets) || s.datasets.length === 0 || s.datasets.length > 64) {
    return { ok: false, error: 'chartSpec.datasets must be a non-empty array (max 64)' };
  }
  if (!s.datasets.every(isDataset)) {
    return { ok: false, error: 'chartSpec.datasets entries must have { label: string, data: (number|{x,y}|null)[] }' };
  }
  const type = s.type as AnalysisChartType;
  if (type === 'scatter') {
    for (const d of s.datasets as AnalysisChartDataset[]) {
      if (!d.data.every((p) => p === null || isPoint(p))) {
        return { ok: false, error: 'scatter datasets must contain {x, y} points' };
      }
    }
  } else {
    for (const d of s.datasets as AnalysisChartDataset[]) {
      if (!d.data.every((p) => p === null || isNum(p)) || d.data.some(isPoint)) {
        return { ok: false, error: `${type} datasets must contain plain numbers` };
      }
    }
  }
  const labels = (s.labels ?? []) as string[];
  if (type !== 'scatter' && labels.length > 0) {
    for (const d of s.datasets as AnalysisChartDataset[]) {
      if (d.data.length !== labels.length) {
        return { ok: false, error: 'dataset length must match labels length' };
      }
    }
  }
  return {
    ok: true,
    spec: {
      type,
      title: typeof s.title === 'string' ? s.title : undefined,
      labels: s.labels as string[] | undefined,
      datasets: s.datasets as AnalysisChartDataset[],
    },
  };
}

function withDefaults(spec: AnalysisChartSpec): AnalysisChartSpec {
  return {
    ...spec,
    datasets: spec.datasets.map((d, i) => ({
      backgroundColor: spec.type === 'line' || spec.type === 'radar' ? `${colorFor(i)}33` : colorFor(i),
      borderColor: colorFor(i),
      ...d,
    })),
  };
}

/**
 * Map a validated AnalysisChartSpec to a chart.js ChartConfiguration for
 * ChartCanvas. Pure and DOM-free.
 */
export function toChartConfiguration(spec: AnalysisChartSpec): ChartConfiguration {
  const s = withDefaults(spec);
  const data: ChartConfiguration['data'] = {
    labels: s.labels,
    datasets: s.datasets.map((d) => ({
      label: d.label,
      data: d.data as (number | { x: number; y: number } | null)[],
      backgroundColor: d.backgroundColor,
      borderColor: d.borderColor,
      borderDash: d.borderDash,
      fill: d.fill ?? (s.type === 'line' || s.type === 'radar'),
    })),
  };
  return {
    type: s.type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        title: { display: !!s.title, text: s.title ?? '' },
        legend: { display: s.datasets.length > 1 || s.type === 'pie' || s.type === 'doughnut' },
      },
    },
  };
}
