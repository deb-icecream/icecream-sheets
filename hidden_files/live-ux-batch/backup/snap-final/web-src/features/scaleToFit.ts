/**
 * Scale to Fit (Page Layout > Scale to Fit).
 *
 * Excel semantics: "Fit to N page(s) wide by M tall" computes the print
 * scale so the sheet fits those page counts; an explicit Scale % overrides
 * the fit. The App keeps the ScaleToFit value in state (persisted in
 * pagesetup metadata), calls effectivePrintScale() before paginating, and
 * writes the result into PageSetup.scale.
 */
import type { PageSetup } from '../components/PrintLayout';

export interface ScaleToFit {
  /** Pages wide to fit, or null for "as many as needed". */
  fitWide: number | null;
  /** Pages tall to fit, or null for "as many as needed". */
  fitTall: number | null;
  /** Explicit scale override (10–400), or null to use the fit. */
  explicitScale: number | null;
}

export const DEFAULT_SCALE_TO_FIT: ScaleToFit = { fitWide: null, fitTall: null, explicitScale: null };

export interface FitGeometry {
  /** Total columns/rows to print. */
  totalCols: number;
  totalRows: number;
  /** Columns/rows per page at 100% scale (from the page setup). */
  colsPerPageAt100: number;
  rowsPerPageAt100: number;
}

function clampScale(s: number): number {
  return Math.min(400, Math.max(10, Math.round(s)));
}

/**
 * Compute the effective print scale percent.
 *
 * - explicitScale wins when set (clamped 10–400).
 * - Otherwise each fit dimension contributes a candidate scale:
 *   candidate = fitPages * perPageAt100 / total * 100; the smallest
 *   candidate across the set dimensions wins (must fit BOTH).
 * - No fit and no override → 100.
 */
export function effectivePrintScale(s: ScaleToFit, geom: FitGeometry): number {
  if (s.explicitScale != null) return clampScale(s.explicitScale);
  const candidates: number[] = [];
  if (s.fitWide != null && s.fitWide > 0 && geom.totalCols > 0 && geom.colsPerPageAt100 > 0) {
    candidates.push((s.fitWide * geom.colsPerPageAt100 * 100) / geom.totalCols);
  }
  if (s.fitTall != null && s.fitTall > 0 && geom.totalRows > 0 && geom.rowsPerPageAt100 > 0) {
    candidates.push((s.fitTall * geom.rowsPerPageAt100 * 100) / geom.totalRows);
  }
  if (candidates.length === 0) return 100;
  return clampScale(Math.min(...candidates));
}

/**
 * Apply a ScaleToFit to a PageSetup: returns the setup with scale set to
 * the effective value. The App calls this before paginateSheet()/printing.
 */
export function applyScaleToFit(setup: PageSetup, s: ScaleToFit, geom: FitGeometry): PageSetup {
  return { ...setup, scale: effectivePrintScale(s, geom) };
}

export function scaleToFitToMetadata(s: ScaleToFit): unknown {
  return JSON.parse(JSON.stringify(s)) as unknown;
}

export function scaleToFitFromMetadata(meta: unknown): ScaleToFit {
  if (typeof meta !== 'object' || meta === null) return { ...DEFAULT_SCALE_TO_FIT };
  const r = meta as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  return {
    fitWide: num(r.fitWide),
    fitTall: num(r.fitTall),
    explicitScale: typeof r.explicitScale === 'number' && Number.isFinite(r.explicitScale) ? r.explicitScale : null,
  };
}
