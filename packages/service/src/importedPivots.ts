/**
 * Imported XLSX pivot tables → live pivot overlays.
 *
 * The xlsx-adapter extracts every embedded pivot table (cache fields +
 * records + table definition) into `icecream.pivots` metadata as
 * `ImportedPivotTable[]`. This module maps that shape onto the service
 * pivot component: `ImportedPivotTable` → versioned `PivotSpec` →
 * `createPivot` (the service-layer layout engine from
 * design-docs/native-reports-and-dashboards.md §1) → `PivotResult`, which
 * the existing `PivotTableView` renders. Imported pivots also feed the
 * engine-local OLAP cube (`cubeFromPivot` + `registerCube`, so the CUBE*
 * functions resolve them) and the GETPIVOTDATA registry (`registerPivot`
 * at the pivot's sheet location).
 *
 * Layout note: the service `PivotResult` always renders value fields across
 * columns. When the file puts the Values area on rows (`dataOnRows`,
 * `x="-2"` in rowFields) with several value fields, `importedPivotMatrix`
 * nests the values under the row keys instead — the Excel layout.
 */

import {
  PIVOT_SPEC_VERSION,
  createPivot,
  pivotToMatrix,
  recordsFromGrid,
  type PivotRecord,
  type PivotResult,
  type PivotSpec,
} from './pivot.js';
import { cubeFromPivot, registerCube, registerPivot } from '@icecream-sheets/engine';
import type { ImportedPivotTable } from '@icecream-sheets/xlsx-adapter';

export type { ImportedPivotTable };

/**
 * Parse the `icecream.pivots` metadata value into ImportedPivotTable[].
 * Returns [] for missing/corrupt metadata (never throws).
 */
export function importedPivotsFromMetadata(value: unknown): ImportedPivotTable[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is ImportedPivotTable =>
        !!t &&
        typeof t === 'object' &&
        typeof (t as ImportedPivotTable).name === 'string' &&
        typeof (t as ImportedPivotTable).sheetName === 'string' &&
        Array.isArray((t as ImportedPivotTable).fieldNames) &&
        Array.isArray((t as ImportedPivotTable).records) &&
        Array.isArray((t as ImportedPivotTable).values),
    );
  } catch {
    return [];
  }
}

/**
 * Validate the `xlsx.pivotParts` metadata value (raw part bytes for the
 * write path). Returns undefined for missing/corrupt metadata (never
 * throws) — the adapter then simply skips pivot re-injection.
 */
export function pivotPartsFromMetadata(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { tables?: unknown; parts?: unknown };
  if (!Array.isArray(v.tables) || typeof v.parts !== 'object' || v.parts === null) {
    return undefined;
  }
  return value;
}

/** Map an imported pivot table onto a versioned service PivotSpec. */
export function importedPivotToSpec(t: ImportedPivotTable): PivotSpec {
  return {
    version: PIVOT_SPEC_VERSION,
    rows: [...t.rows],
    columns: [...t.columns],
    values: t.values.map((v) => ({
      field: v.field,
      aggregation: v.aggregation,
      label: v.label,
    })),
    filters: t.filters.length > 0 ? t.filters.map((f) => ({ ...f, selected: [...f.selected] })) : undefined,
  };
}

/** Records for the service pivot component (headers = cache field names). */
export function importedPivotRecords(t: ImportedPivotTable): PivotRecord[] {
  return recordsFromGrid(t.fieldNames, t.records);
}

/**
 * Compute the pivot layout from the imported cache + definition, reusing
 * the service aggregation logic. Returns null when the pivot has no cached
 * records or no value fields (the caller renders the warning/notice
 * instead) — never throws.
 */
export function buildImportedPivotResult(t: ImportedPivotTable): PivotResult | null {
  try {
    if (!t.hasRecords || t.records.length === 0) return null;
    if (t.values.length === 0) return null;
    return createPivot(importedPivotRecords(t), importedPivotToSpec(t));
  } catch {
    return null;
  }
}

export interface ImportedPivotSourceRange {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Parse the pivot cache's worksheet source ("D3:E4" on "Area Source") into
 * a live-refresh range. Returns null unless the source is a worksheet
 * range on a named sheet — other sources (tables, external, scenario,
 * consolidation) refresh from the cached records instead.
 */
export function importedPivotSourceRange(t: ImportedPivotTable): ImportedPivotSourceRange | null {
  const src = t.source;
  if (src.kind !== 'worksheet' || !src.sheet || !src.ref) return null;
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(src.ref.trim());
  if (!m) return null;
  const startCol = colLettersToIndex(m[1]!);
  const startRow = parseInt(m[2]!, 10) - 1;
  const endCol = colLettersToIndex(m[3]!);
  const endRow = parseInt(m[4]!, 10) - 1;
  if (startRow < 0 || startCol < 0 || endRow < startRow || endCol < startCol) return null;
  return { sheet: src.sheet, startRow, startCol, endRow, endCol };
}

type MatrixCell = string | number | null;

/**
 * Render a pivot result as a display matrix, honoring the file's Values
 * placement. The service `pivotToMatrix` always renders values across
 * columns; with `dataOnRows` and several value fields the values nest
 * under the row keys (the Excel "values on rows" layout). Single-value
 * and degenerate cases are identical either way, so they use the standard
 * matrix.
 */
export function importedPivotMatrix(result: PivotResult, dataOnRows: boolean): MatrixCell[][] {
  const nVals = result.valueLabels.length;
  if (
    !dataOnRows ||
    nVals < 2 ||
    result.colKeys.length === 0 ||
    (result.rowFieldNames.length === 0 && result.colFieldNames.length === 0)
  ) {
    return pivotToMatrix(result);
  }
  const colHeaderFor = (colKey: string[]): string => colKey.join(' | ');
  const matrix: MatrixCell[][] = [];
  matrix.push([
    null,
    ...result.rowFieldNames,
    null,
    ...result.colKeys.map(colHeaderFor),
    'Grand Total',
  ]);
  result.rowKeys.forEach((rk, ri) => {
    for (let vi = 0; vi < nVals; vi += 1) {
      const row: MatrixCell[] = [
        null,
        // Row-key labels repeat on the first value row; continuation rows
        // leave them blank (Excel's outline look).
        ...(vi === 0 ? rk : rk.map(() => '')),
        result.valueLabels[vi] ?? null,
      ];
      result.colKeys.forEach((ck, ci) => {
        row.push(result.data[ri]?.[ci]?.[vi] ?? null);
      });
      row.push(result.rowTotals[ri]?.[vi] ?? null);
      matrix.push(row);
    }
  });
  for (let vi = 0; vi < nVals; vi += 1) {
    const totalRow: MatrixCell[] = [
      'Grand Total',
      ...result.rowFieldNames.map(() => null),
      result.valueLabels[vi] ?? null,
    ];
    result.colKeys.forEach((ck, ci) => {
      totalRow.push(result.colTotals[ci]?.[vi] ?? null);
    });
    totalRow.push(result.grandTotals[vi] ?? null);
    matrix.push(totalRow);
  }
  return matrix;
}

export interface RegisteredImportedPivot {
  /** Engine pivot-registry key (`xlsx:<name>#<index>`), for unregistration. */
  key: string;
  /** Engine OLAP cube name, for unregistration. */
  cubeName: string;
}

/**
 * Server-side registration for imported XLSX pivot tables (Cycle 10,
 * Phase 2). Mirrors the web app's open flow exactly: each imported pivot
 * table with cached records and value fields is registered in the
 * engine-local GETPIVOTDATA registry (at its sheet location) and as an
 * OLAP cube (under a workbook-unique disambiguated name, so CUBE*
 * formulas resolve). Empty shells and broken caches register nothing —
 * the caller renders them as notices instead.
 *
 * The engine service calls this on /load; the returned keys/cube names
 * must be unregistered when the next file loads (registries are
 * process-global in the engine package).
 */
export function registerImportedPivotsForEngine(
  tables: ImportedPivotTable[],
): RegisteredImportedPivot[] {
  const registered: RegisteredImportedPivot[] = [];
  const usedNames = new Set<string>();
  tables.forEach((t, i) => {
    if (t.warning || t.values.length === 0) return;
    const result = buildImportedPivotResult(t);
    if (!result) return;
    const key = `xlsx:${t.name}#${i}`;
    // Cube names are workbook-unique in Excel, but some producers
    // duplicate them — disambiguate so no pivot silently replaces another.
    let cubeName = t.name;
    if (usedNames.has(cubeName)) {
      let n = 2;
      cubeName = `${t.name} — ${t.sheetName}`;
      while (usedNames.has(cubeName)) {
        cubeName = `${t.name} — ${t.sheetName} (${n})`;
        n += 1;
      }
    }
    usedNames.add(cubeName);
    try {
      const matrix = importedPivotMatrix(result, t.dataOnRows);
      registerPivot(key, result, {
        sheet: t.sheetIndex,
        col: t.anchor.col,
        row: t.anchor.row,
        cols: Math.max(1, matrix[0]?.length ?? 1),
        rows: Math.max(1, matrix.length),
      });
      registerCube(cubeFromPivot(result, cubeName));
      registered.push({ key, cubeName });
    } catch {
      // Registration must never break the open.
    }
  });
  return registered;
}
