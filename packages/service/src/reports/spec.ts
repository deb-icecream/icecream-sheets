/**
 * Report spec — native reports and dashboards (design-docs/native-reports-and-dashboards.md §2).
 *
 * A report is a versioned, serializable spec: data bindings, visuals,
 * filters/slicers, layout and refresh settings. The spec lives in the
 * service metadata store (metadataStore.ts), never in the engine.
 *
 * SERVICE-LAYER component: pure and headless, reads through the typed
 * computational view via plain JSON records handed in by the caller.
 * Never touches the engine or storage directly.
 */

import { ALL_KINDS, CHART_SPEC_VERSION, migrateChart, type ChartSpec } from '../chartModel.js';
import { PIVOT_SPEC_VERSION, type PivotSpec } from '../pivot.js';
import { KPI_SPEC_VERSION, makeKpiSpec, validateKpiSpec, type KpiSpec } from './kpi.js';
import { makeHeatmapSpec, type HeatmapSpec } from './heatmap.js';
import {
  normalizeCalculatedExpression,
  validateCalculatedField,
  type CalculatedField,
} from './calculatedFields.js';
import {
  validateReportFilter,
  validateReportSlicer,
  type ReportFilter,
  type ReportSlicer,
} from './slicers.js';

/** Current version of the serialized ReportSpec. Bump when the shape changes. */
export const REPORT_SPEC_VERSION = 2 as const;

/** One data binding: a named table read from a sheet range through the view. */
export interface ReportBinding {
  id: string;
  /** Display name shown in the builder. */
  name: string;
  /** Source sheet name. */
  sheet: string;
  /** 0-based source range (inclusive). */
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** 0-based absolute row of the header row within the sheet. */
  headerRow: number;
  /** Typed field names from the computational view (header cells). */
  fields: string[];
  /**
   * ETL-backed table (design-docs/native-reports-and-dashboards.md §6):
   * id of the ETL recipe whose pipeline loads this binding's table. On
   * report refresh the recipe runs through the ETL pipeline before the
   * visuals recompute. Absent = the table is read as-is from the sheet.
   */
  etlRecipeId?: string;
  /**
   * Report-level calculated fields (design §3): { name, expression } in the
   * formula language over the bound row, e.g. `=[Revenue]-[Cost]`.
   * Usable everywhere a column-bound field is (tables, KPIs, chart series
   * via pivots, filters/sorting). Added in spec version 2.
   */
  calculatedFields: CalculatedField[];
}

export interface ReportVisualBase {
  id: string;
  title: string;
  /** Id of the binding this visual reads. */
  bindingId: string;
}

/**
 * Visuals in v1 (design §4): table, charts, KPI card, heatmap matrix.
 * PivotSpec wires in as a report visual (it is a first-class building
 * block of this design doc). Heatmap is a matrix visual, not a chart kind
 * (RESOLVED 2026-10-18 — Excel has no native heatmap chart type).
 */
export type ReportVisual =
  | (ReportVisualBase & { kind: 'chart'; chart: ChartSpec })
  | (ReportVisualBase & { kind: 'pivot'; pivot: PivotSpec })
  | (ReportVisualBase & { kind: 'kpi'; kpi: KpiSpec })
  | (ReportVisualBase & { kind: 'heatmap'; heatmap: HeatmapSpec })
  | (ReportVisualBase & { kind: 'table'; fields: string[]; maxRows: number });

export const REPORT_VISUAL_KINDS = ['chart', 'pivot', 'kpi', 'heatmap', 'table'] as const;
export type ReportVisualKind = (typeof REPORT_VISUAL_KINDS)[number];

export interface ReportLayoutCell {
  visualId: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/** Grid layout of visuals on the report page. */
export interface ReportLayout {
  columns: number;
  cells: ReportLayoutCell[];
}

/** v1 refresh modes (design §6). Scheduled = serializable spec; the host
 *  decides how to honor it — no cron daemon in v1. */
export type RefreshMode = 'manual' | 'onOpen' | 'scheduled';

export interface RefreshSchedule {
  kind: 'hourly' | 'daily' | 'weekly';
  /** "HH:MM" local time for daily/weekly. */
  time?: string;
  /** 0=Sunday..6=Saturday for weekly. */
  days?: number[];
}

export interface ReportRefresh {
  mode: RefreshMode;
  schedule?: RefreshSchedule | null;
}

/**
 * Versioned, serializable report spec.
 */
export interface ReportSpec {
  version: typeof REPORT_SPEC_VERSION;
  id: string;
  name: string;
  bindings: ReportBinding[];
  visuals: ReportVisual[];
  /** Page-level slicers: each filters every visual whose binding includes its field. */
  slicers: ReportSlicer[];
  /** Typed page-level filters: same field-scoping rule as slicers. */
  filters: ReportFilter[];
  layout: ReportLayout;
  refresh: ReportRefresh;
  /** ISO timestamp of the last data refresh, or null if never refreshed. */
  dataAsOf: string | null;
}

// ---------------------------------------------------------------------------
// Construction / migration
// ---------------------------------------------------------------------------

let reportSeq = 0;
function nextReportId(): string {
  reportSeq += 1;
  return `report-${Date.now()}-${reportSeq}`;
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

function intOr(v: unknown, d: number): number {
  return isInt(v) ? v : d;
}

function strOr(v: unknown, d: string): string {
  return typeof v === 'string' ? v : d;
}

/** Normalize calculated fields: drop malformed entries, normalize expressions. */
export function migrateCalculatedFields(partial: unknown, columnFields: string[]): CalculatedField[] {
  if (!Array.isArray(partial)) return [];
  const out: CalculatedField[] = [];
  const seen = new Set<string>();
  for (const item of partial) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Partial<CalculatedField>;
    if (typeof c.name !== 'string' || c.name.trim() === '') continue;
    if (typeof c.expression !== 'string' || c.expression.trim() === '') continue;
    const name = c.name.trim();
    if (seen.has(name) || columnFields.includes(name)) continue;
    seen.add(name);
    out.push({ name, expression: normalizeCalculatedExpression(c.expression) });
  }
  return out;
}

/** Normalize one binding, filling defaults. */
export function migrateBinding(partial: Partial<ReportBinding>): ReportBinding {
  const startRow = intOr(partial.startRow, 0);
  const endRow = Math.max(startRow, intOr(partial.endRow, startRow));
  const startCol = intOr(partial.startCol, 0);
  const endCol = Math.max(startCol, intOr(partial.endCol, startCol));
  const headerRow = Math.min(Math.max(intOr(partial.headerRow, startRow), startRow), endRow);
  const fields = Array.isArray(partial.fields)
    ? [...new Set(partial.fields.filter((f): f is string => typeof f === 'string' && f.trim() !== ''))]
    : [];
  return {
    id: strOr(partial.id, `binding-${Date.now()}-${reportSeq}`),
    name: strOr(partial.name, 'Table'),
    sheet: strOr(partial.sheet, 'Sheet1'),
    startRow,
    startCol,
    endRow,
    endCol,
    headerRow,
    fields,
    calculatedFields: migrateCalculatedFields(partial.calculatedFields, fields),
    // ETL-backed binding (§6): keep only a non-empty recipe id.
    ...(typeof partial.etlRecipeId === 'string' && partial.etlRecipeId.trim() !== ''
      ? { etlRecipeId: partial.etlRecipeId.trim() }
      : {}),
  };
}

/**
 * ETL-backed bindings (design-docs/native-reports-and-dashboards.md §6):
 * distinct recipe ids referenced by the spec's bindings, in first-use
 * order. Empty when no binding is ETL-backed.
 */
export function collectEtlRecipeIds(spec: ReportSpec): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of spec.bindings ?? []) {
    const id = typeof b?.etlRecipeId === 'string' ? b.etlRecipeId.trim() : '';
    if (id !== '' && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Normalize one visual, filling defaults. */
export function migrateVisual(partial: Partial<ReportVisual> & { kind?: string }): ReportVisual {
  const base = {
    id: strOr(partial.id, `visual-${Date.now()}-${reportSeq}`),
    title: strOr(partial.title, 'Visual'),
    bindingId: strOr(partial.bindingId, ''),
  };
  const kind = (partial as { kind?: string }).kind;
  switch (kind) {
    case 'chart': {
      const chart = (partial as { chart?: Partial<ChartSpec> }).chart;
      return { ...base, kind: 'chart', chart: migrateChart(chart ?? ({} as Partial<ChartSpec>)) };
    }
    case 'pivot': {
      const pivot = (partial as { pivot?: Partial<PivotSpec> }).pivot ?? {};
      const normalized: PivotSpec = {
        version: PIVOT_SPEC_VERSION,
        rows: Array.isArray(pivot.rows) ? pivot.rows.filter((f): f is string => typeof f === 'string') : [],
        columns: Array.isArray(pivot.columns)
          ? pivot.columns.filter((f): f is string => typeof f === 'string')
          : [],
        values: Array.isArray(pivot.values)
          ? pivot.values.filter((v): v is PivotSpec['values'][number] => typeof v === 'object' && v !== null)
          : [],
        filters: Array.isArray(pivot.filters)
          ? pivot.filters.filter((f): f is NonNullable<PivotSpec['filters']>[number] => typeof f === 'object' && f !== null)
          : [],
      };
      return { ...base, kind: 'pivot', pivot: normalized };
    }
    case 'kpi': {
      const kpi = (partial as { kpi?: Partial<KpiSpec> }).kpi ?? {};
      return {
        ...base,
        kind: 'kpi',
        kpi: makeKpiSpec({ field: strOr(kpi.field, ''), ...kpi }),
      };
    }
    case 'heatmap': {
      const heatmap = (partial as { heatmap?: Partial<HeatmapSpec> }).heatmap ?? {};
      return { ...base, kind: 'heatmap', heatmap: makeHeatmapSpec(heatmap) };
    }
    case 'table':
    default: {
      const t = partial as { fields?: unknown; maxRows?: unknown };
      return {
        ...base,
        kind: 'table',
        fields: Array.isArray(t.fields) ? t.fields.filter((f): f is string => typeof f === 'string') : [],
        maxRows: intOr(t.maxRows, 50) > 0 ? intOr(t.maxRows, 50) : 50,
      };
    }
  }
}

/** Normalize the refresh settings. */
export function migrateRefresh(partial: Partial<ReportRefresh> | undefined): ReportRefresh {
  const mode: RefreshMode =
    partial?.mode === 'onOpen' || partial?.mode === 'scheduled' ? partial.mode : 'manual';
  if (mode !== 'scheduled') return { mode, schedule: null };
  const s = partial?.schedule;
  const kind = s?.kind === 'hourly' || s?.kind === 'weekly' ? s.kind : 'daily';
  const schedule: RefreshSchedule = { kind };
  if (typeof s?.time === 'string' && /^\d{2}:\d{2}$/.test(s.time)) schedule.time = s.time;
  if (Array.isArray(s?.days)) {
    const days = s.days.filter((d): d is number => isInt(d) && d >= 0 && d <= 6);
    if (days.length > 0) schedule.days = [...new Set(days)].sort();
  }
  return { mode, schedule };
}

/** Normalize the layout; auto-place visuals that have no cell yet. */
export function migrateLayout(
  partial: Partial<ReportLayout> | undefined,
  visualIds: string[],
): ReportLayout {
  const columns = intOr(partial?.columns, 2) > 0 ? intOr(partial?.columns, 2) : 2;
  const cells: ReportLayoutCell[] = [];
  const seen = new Set<string>();
  if (Array.isArray(partial?.cells)) {
    for (const c of partial.cells) {
      if (typeof c !== 'object' || c === null) continue;
      const cc = c as Partial<ReportLayoutCell>;
      if (typeof cc.visualId !== 'string' || seen.has(cc.visualId)) continue;
      if (!visualIds.includes(cc.visualId)) continue;
      seen.add(cc.visualId);
      cells.push({
        visualId: cc.visualId,
        row: Math.max(0, intOr(cc.row, 0)),
        col: Math.max(0, Math.min(intOr(cc.col, 0), columns - 1)),
        rowSpan: Math.max(1, intOr(cc.rowSpan, 1)),
        colSpan: Math.max(1, Math.min(intOr(cc.colSpan, 1), columns)),
      });
    }
  }
  // Auto-place visuals missing from the layout, row-major after the last row.
  let nextRow = cells.reduce((m, c) => Math.max(m, c.row + c.rowSpan), 0);
  for (const id of visualIds) {
    if (seen.has(id)) continue;
    cells.push({ visualId: id, row: nextRow, col: 0, rowSpan: 1, colSpan: Math.min(2, columns) });
    nextRow += 1;
  }
  return { columns, cells };
}

/**
 * Migrate any older/partial payload to the current ReportSpec shape,
 * filling defaults. Never throws on malformed input (returns a valid,
 * possibly empty, spec instead).
 */
export function migrateReportSpec(partial: unknown): ReportSpec {
  const p = (typeof partial === 'object' && partial !== null ? partial : {}) as Partial<ReportSpec>;
  const bindings = Array.isArray(p.bindings) ? p.bindings.map(migrateBinding) : [];
  const visuals = Array.isArray(p.visuals)
    ? p.visuals
        .filter((v) => typeof v === 'object' && v !== null)
        .map((v) => migrateVisual(v as Partial<ReportVisual> & { kind?: string }))
    : [];
  const slicers = Array.isArray(p.slicers)
    ? p.slicers.filter((s): s is ReportSlicer => typeof s === 'object' && s !== null)
    : [];
  const filters = Array.isArray(p.filters)
    ? p.filters.filter((f): f is ReportFilter => typeof f === 'object' && f !== null)
    : [];
  const dataAsOf =
    typeof p.dataAsOf === 'string' && !Number.isNaN(Date.parse(p.dataAsOf)) ? p.dataAsOf : null;
  return {
    version: REPORT_SPEC_VERSION,
    id: strOr(p.id, nextReportId()),
    name: strOr(p.name, 'Untitled report').trim() || 'Untitled report',
    bindings,
    visuals,
    slicers,
    filters,
    layout: migrateLayout(p.layout, visuals.map((v) => v.id)),
    refresh: migrateRefresh(p.refresh),
    dataAsOf,
  };
}

/** Build a fresh report spec from named fields. */
export function makeReportSpec(partial: Partial<ReportSpec> & { name: string }): ReportSpec {
  return migrateReportSpec({ ...partial, version: REPORT_SPEC_VERSION });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function uniqueIds<T extends { id: string }>(items: T[], what: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) errors.push(`duplicate ${what} id "${item.id}"`);
    seen.add(item.id);
  }
}

/**
 * Validate a report spec against the current schema. Returns a list of
 * error strings; empty = valid. Cross-checks bindings, visual references,
 * slicer/filter field scope, and layout integrity.
 */
export function validateReportSpec(spec: unknown): string[] {
  const errors: string[] = [];
  if (typeof spec !== 'object' || spec === null) return ['report spec must be an object'];
  const s = spec as Partial<ReportSpec>;

  if (s.version !== REPORT_SPEC_VERSION) {
    errors.push(`unsupported report spec version ${String(s.version)} (expected ${REPORT_SPEC_VERSION})`);
    return errors; // Shape may differ; deeper checks would mislead.
  }
  if (typeof s.id !== 'string' || s.id.trim() === '') errors.push('report id must be a non-empty string');
  if (typeof s.name !== 'string' || s.name.trim() === '') errors.push('report name must be a non-empty string');

  // Bindings.
  if (!Array.isArray(s.bindings)) {
    errors.push('report bindings must be an array');
  } else {
    uniqueIds(s.bindings, 'binding', errors);
    s.bindings.forEach((b, i) => {
      const where = `bindings[${i}]`;
      if (typeof b !== 'object' || b === null) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (typeof b.id !== 'string' || b.id.trim() === '') errors.push(`${where}.id must be a non-empty string`);
      if (typeof b.sheet !== 'string' || b.sheet.trim() === '') errors.push(`${where}.sheet must be a non-empty string`);
      for (const k of ['startRow', 'startCol', 'endRow', 'endCol', 'headerRow'] as const) {
        if (!isInt(b[k]) || (b[k] as number) < 0) errors.push(`${where}.${k} must be a non-negative integer`);
      }
      if (isInt(b.startRow) && isInt(b.endRow) && b.startRow > b.endRow) {
        errors.push(`${where}: startRow must be <= endRow`);
      }
      if (isInt(b.startCol) && isInt(b.endCol) && b.startCol > b.endCol) {
        errors.push(`${where}: startCol must be <= endCol`);
      }
      if (isInt(b.headerRow) && isInt(b.startRow) && isInt(b.endRow) && (b.headerRow < b.startRow || b.headerRow > b.endRow)) {
        errors.push(`${where}: headerRow must be within the binding range`);
      }
      if (!Array.isArray(b.fields) || b.fields.length === 0) {
        errors.push(`${where}.fields must be a non-empty array of field names`);
      } else {
        const bad = b.fields.filter((f) => typeof f !== 'string' || f.trim() === '');
        if (bad.length > 0) errors.push(`${where}.fields must all be non-empty strings`);
        const dupes = b.fields.filter((f, idx) => b.fields.indexOf(f) !== idx);
        if (dupes.length > 0) errors.push(`${where}.fields has duplicates: ${[...new Set(dupes)].join(', ')}`);
      }
      // ETL-backed table (§6): when present, the recipe id must be a non-empty string.
      if (b.etlRecipeId !== undefined && (typeof b.etlRecipeId !== 'string' || b.etlRecipeId.trim() === '')) {
        errors.push(`${where}.etlRecipeId must be a non-empty string when present`);
      }
      // Calculated fields (spec v2): validated against the column fields;
      // sibling calculated names are visible for chaining.
      if (b.calculatedFields !== undefined) {
        if (!Array.isArray(b.calculatedFields)) {
          errors.push(`${where}.calculatedFields must be an array`);
        } else {
          const siblingNames = new Set<string>();
          b.calculatedFields.forEach((cf, j) => {
            for (const e of validateCalculatedField(cf, b.fields ?? [], siblingNames)) {
              errors.push(`${where}.calculatedFields[${j}]: ${e}`);
            }
            if (typeof cf === 'object' && cf !== null && typeof (cf as { name?: unknown }).name === 'string') {
              siblingNames.add((cf as { name: string }).name);
            }
          });
        }
      }
    });
  }
  const bindingById = new Map<string, ReportBinding>();
  const allFields = new Set<string>();
  for (const b of s.bindings ?? []) {
    if (b && typeof b.id === 'string') bindingById.set(b.id, b);
    for (const f of b?.fields ?? []) allFields.add(f);
    // Calculated fields are usable everywhere a column-bound field is.
    for (const cf of (b as Partial<ReportBinding>)?.calculatedFields ?? []) {
      if (typeof cf?.name === 'string') allFields.add(cf.name);
    }
  }

  // Visuals.
  if (!Array.isArray(s.visuals)) {
    errors.push('report visuals must be an array');
  } else {
    uniqueIds(s.visuals, 'visual', errors);
    s.visuals.forEach((v, i) => {
      const where = `visuals[${i}]`;
      if (typeof v !== 'object' || v === null) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (typeof v.id !== 'string' || v.id.trim() === '') errors.push(`${where}.id must be a non-empty string`);
      if (typeof v.title !== 'string') errors.push(`${where}.title must be a string`);
      const binding = typeof v.bindingId === 'string' ? bindingById.get(v.bindingId) : undefined;
      if (!binding) {
        errors.push(`${where}: unknown bindingId "${String(v.bindingId)}"`);
        return;
      }
      const kind = (v as { kind?: string }).kind;
      if (!REPORT_VISUAL_KINDS.includes(kind as ReportVisualKind)) {
        errors.push(`${where}: unknown visual kind "${String(kind)}"`);
        return;
      }
      switch (kind) {
        case 'chart': {
          const chart = (v as { chart?: Partial<ChartSpec> }).chart;
          if (!chart || typeof chart !== 'object') {
            errors.push(`${where}: chart visual needs a chart spec`);
          } else {
            if (chart.version !== CHART_SPEC_VERSION) {
              errors.push(`${where}: unsupported chart spec version ${String(chart.version)}`);
            }
            if (!ALL_KINDS.includes(chart.kind as (typeof ALL_KINDS)[number])) {
              errors.push(`${where}: unknown chart kind "${String(chart.kind)}"`);
            }
          }
          break;
        }
        case 'pivot': {
          const pivot = (v as { pivot?: Partial<PivotSpec> }).pivot;
          if (!pivot || typeof pivot !== 'object') {
            errors.push(`${where}: pivot visual needs a pivot spec`);
          } else {
            if (pivot.version !== PIVOT_SPEC_VERSION) {
              errors.push(`${where}: unsupported pivot spec version ${String(pivot.version)}`);
            }
            if (!Array.isArray(pivot.values) || pivot.values.length === 0) {
              errors.push(`${where}: pivot visual needs at least one value field`);
            }
          }
          break;
        }
        case 'kpi': {
          const kpi = (v as { kpi?: Partial<KpiSpec> }).kpi;
          // Calculated fields are valid KPI fields (design §3).
          const kpiFields = [
            ...binding.fields,
            ...(binding.calculatedFields ?? []).map((cf) => cf.name),
          ];
          const kpiErrors = validateKpiSpec(kpi, kpiFields);
          for (const e of kpiErrors) errors.push(`${where}: ${e}`);
          break;
        }
        case 'table': {
          const t = v as { fields?: unknown; maxRows?: unknown };
          if (!Array.isArray(t.fields) || t.fields.length === 0) {
            errors.push(`${where}: table visual needs at least one field`);
          } else {
            const tableFields = new Set([
              ...binding.fields,
              ...(binding.calculatedFields ?? []).map((cf) => cf.name),
            ]);
            for (const f of t.fields) {
              if (typeof f !== 'string' || !tableFields.has(f)) {
                errors.push(`${where}: unknown table field "${String(f)}" for binding "${binding.id}"`);
              }
            }
          }
          if (!isInt(t.maxRows) || (t.maxRows as number) < 1) {
            errors.push(`${where}: table maxRows must be a positive integer`);
          }
          break;
        }
      }
    });
  }
  const visualIds = new Set((s.visuals ?? []).map((v) => v?.id));

  // Slicers.
  if (!Array.isArray(s.slicers)) {
    errors.push('report slicers must be an array');
  } else {
    uniqueIds(s.slicers, 'slicer', errors);
    s.slicers.forEach((sl, i) => {
      for (const e of validateReportSlicer(sl)) errors.push(`slicers[${i}]: ${e}`);
      if (typeof sl?.field === 'string' && !allFields.has(sl.field)) {
        errors.push(`slicers[${i}]: field "${sl.field}" is in no binding's fields`);
      }
    });
  }

  // Filters.
  if (!Array.isArray(s.filters)) {
    errors.push('report filters must be an array');
  } else {
    uniqueIds(s.filters, 'filter', errors);
    s.filters.forEach((f, i) => {
      for (const e of validateReportFilter(f)) errors.push(`filters[${i}]: ${e}`);
      if (typeof f?.field === 'string' && !allFields.has(f.field)) {
        errors.push(`filters[${i}]: field "${f.field}" is in no binding's fields`);
      }
    });
  }

  // Layout.
  const layout = s.layout;
  if (typeof layout !== 'object' || layout === null) {
    errors.push('report layout must be an object');
  } else {
    if (!isInt(layout.columns) || layout.columns < 1) {
      errors.push('layout.columns must be a positive integer');
    }
    if (!Array.isArray(layout.cells)) {
      errors.push('layout.cells must be an array');
    } else {
      const placed = new Set<string>();
      const cols = isInt(layout.columns) && layout.columns > 0 ? layout.columns : 2;
      layout.cells.forEach((c, i) => {
        const where = `layout.cells[${i}]`;
        if (typeof c !== 'object' || c === null) {
          errors.push(`${where} must be an object`);
          return;
        }
        if (typeof c.visualId !== 'string' || !visualIds.has(c.visualId)) {
          errors.push(`${where}: unknown visualId "${String(c.visualId)}"`);
          return;
        }
        if (placed.has(c.visualId)) errors.push(`${where}: visual "${c.visualId}" is placed twice`);
        placed.add(c.visualId);
        for (const k of ['row', 'col'] as const) {
          if (!isInt(c[k]) || (c[k] as number) < 0) errors.push(`${where}.${k} must be a non-negative integer`);
        }
        for (const k of ['rowSpan', 'colSpan'] as const) {
          if (!isInt(c[k]) || (c[k] as number) < 1) errors.push(`${where}.${k} must be a positive integer`);
        }
        if (isInt(c.col) && isInt(c.colSpan) && c.col + c.colSpan > cols) {
          errors.push(`${where}: col + colSpan exceeds layout columns`);
        }
      });
      // Overlap check.
      const rects = layout.cells
        .filter(
          (c): c is ReportLayoutCell =>
            typeof c === 'object' &&
            c !== null &&
            isInt(c.row) &&
            isInt(c.col) &&
            isInt(c.rowSpan) &&
            isInt(c.colSpan),
        )
        .map((c) => ({ id: c.visualId, r1: c.row, r2: c.row + c.rowSpan - 1, c1: c.col, c2: c.col + c.colSpan - 1 }));
      for (let a = 0; a < rects.length; a += 1) {
        for (let b = a + 1; b < rects.length; b += 1) {
          const A = rects[a];
          const B = rects[b];
          if (A.r1 <= B.r2 && B.r1 <= A.r2 && A.c1 <= B.c2 && B.c1 <= A.c2) {
            errors.push(`layout: visuals "${A.id}" and "${B.id}" overlap`);
          }
        }
      }
      for (const id of visualIds) {
        if (!placed.has(id)) errors.push(`layout: visual "${id}" has no cell`);
      }
    }
  }

  // Refresh.
  const refresh = s.refresh;
  if (typeof refresh !== 'object' || refresh === null) {
    errors.push('report refresh must be an object');
  } else {
    if (refresh.mode !== 'manual' && refresh.mode !== 'onOpen' && refresh.mode !== 'scheduled') {
      errors.push(`unknown refresh mode "${String(refresh.mode)}"`);
    }
    if (refresh.mode === 'scheduled') {
      const sched = refresh.schedule;
      if (typeof sched !== 'object' || sched === null) {
        errors.push('scheduled refresh needs a schedule');
      } else {
        if (sched.kind !== 'hourly' && sched.kind !== 'daily' && sched.kind !== 'weekly') {
          errors.push(`unknown schedule kind "${String(sched.kind)}"`);
        }
        if (sched.time !== undefined && !/^\d{2}:\d{2}$/.test(sched.time)) {
          errors.push('schedule.time must be "HH:MM"');
        }
        if (sched.days !== undefined) {
          if (
            !Array.isArray(sched.days) ||
            sched.days.some((d) => !isInt(d) || d < 0 || d > 6)
          ) {
            errors.push('schedule.days must be an array of 0–6');
          }
        }
      }
    }
  }

  // Data timestamp.
  if (s.dataAsOf !== null && s.dataAsOf !== undefined) {
    if (typeof s.dataAsOf !== 'string' || Number.isNaN(Date.parse(s.dataAsOf))) {
      errors.push('dataAsOf must be an ISO timestamp or null');
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Serialization for the metadata store
// ---------------------------------------------------------------------------

export interface StoredReports {
  version: number;
  reports: ReportSpec[];
}

/** Serialize report specs for the metadata store. */
export function serializeReports(reports: ReportSpec[]): string {
  const stored: StoredReports = { version: REPORT_SPEC_VERSION, reports };
  return JSON.stringify(stored);
}

/**
 * Deserialize report specs, migrating older versions forward.
 * Returns an empty list (not an exception) for corrupt payloads.
 */
export function deserializeReports(json: string): ReportSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const stored = parsed as Partial<StoredReports>;
  if (!Array.isArray(stored.reports)) return [];
  return stored.reports
    .filter((r) => typeof r === 'object' && r !== null)
    .map((r) => migrateReportSpec(r));
}

/** True when a refresh schedule is due after the last data timestamp. */
export function isRefreshDue(spec: ReportSpec, now: Date = new Date()): boolean {
  if (spec.refresh.mode !== 'scheduled' || !spec.refresh.schedule) return false;
  const last = spec.dataAsOf ? Date.parse(spec.dataAsOf) : NaN;
  if (Number.isNaN(last)) return true;
  const elapsedMs = now.getTime() - last;
  const { kind } = spec.refresh.schedule;
  if (kind === 'hourly') return elapsedMs >= 60 * 60 * 1000;
  if (kind === 'daily') return elapsedMs >= 24 * 60 * 60 * 1000;
  return elapsedMs >= 7 * 24 * 60 * 60 * 1000;
}
