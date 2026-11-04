/**
 * Hidden-row registry for formula evaluation.
 *
 * Excel models row visibility; AGGREGATE's `options` 1, 3, 5, 7 must exclude
 * hidden rows (R1: the biggest single root cause in the Cycle-3 formula
 * audit — 151 mismatch cells in closedxml-xlsx-functions-excel-2010.xlsx).
 * HyperFormula itself has no row-visibility concept, so the engine keeps a
 * per-workbook registry keyed by the DependencyGraph instance: the one object
 * both the EngineWorkbook (which receives hiddenRows at construction, via
 * EngineWorkbookOptions.hiddenRows, imported from the file's row dimensions
 * by the adapters) and the function plugins (which evaluate formulas) can
 * reach. WeakMap so workbooks are GC'd normally.
 *
 * Rows are 0-based indices, matching the adapter's SheetData.hiddenRows and
 * HyperFormula's SimpleCellAddress.row. Sheets are keyed by HyperFormula
 * sheetId (what state.formulaAddress.sheet carries at evaluation time).
 */
import type { DependencyGraph } from 'hyperformula/typings/DependencyGraph/DependencyGraph.js';

/** Per-workbook map: sheetId -> set of hidden 0-based row indices. */
export type HiddenRowMap = Map<number, Set<number>>;

const registry = new WeakMap<DependencyGraph, HiddenRowMap>();

/** Register (or replace) the hidden-row map for a workbook's dependency graph. */
export function setHiddenRows(graph: DependencyGraph, rows: HiddenRowMap): void {
  registry.set(graph, rows);
}

/** True when `row` (0-based) on `sheetId` is hidden in this workbook. */
export function isRowHidden(graph: DependencyGraph, sheetId: number, row: number): boolean {
  return registry.get(graph)?.get(sheetId)?.has(row) ?? false;
}
