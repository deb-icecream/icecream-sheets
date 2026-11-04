/**
 * Slicers (track 14: sparklines-slicers-timelines).
 *
 * A slicer is a floating filter control bound to a column: it lists distinct
 * values as toggle buttons; selecting values filters the grid (and any bound
 * pivot/table) to matching rows. Pure state helpers + React component.
 */

export interface SlicerSpec {
  id: number;
  /** Column index the slicer filters. */
  col: number;
  /** Header label shown on the slicer. */
  field: string;
  /** Selected values; empty = "select all" (no filter). */
  selected: string[];
  /** Ids of pivot tables this slicer drives (slicer → pivot binding). */
  pivotIds: number[];
  x: number;
  y: number;
  w: number;
  /** Sheet the control lives on (imported slicers only). Undefined = legacy
   * app-authored global control, shown on every sheet as before. */
  sheet?: string;
  /** Native slicer-cache name this spec was imported from (features/
   * nativeSlicersTimelines.ts). Present only for imported controls; it is
   * the key the save path uses to write timeline/slicer state back into
   * the native model instead of fabricating a new cache. */
  nativeCache?: string;
  /** Native per-sheet view name this spec was imported from. */
  nativeView?: string;
  /**
   * OLAP binding (#114): present only for OLAP slicers. There is no
   * worksheet column (col is -1) — the slicer filters bound pivots by
   * re-querying the data model, never by filtering grid rows.
   */
  olap?: {
    /** Dimension table, e.g. 'tblCal'. */
    table: string;
    /** Dimension column, e.g. 'Year'. */
    column: string;
    /** Native slicer-cache name (same as nativeCache). */
    cacheName: string;
  };
  /**
   * Pivot refs for OLAP slicers (#114): the (tabId, name) pairs the
   * cache lists. The refresh path queries by these directly, so it
   * works even on snapshot-join where no pivot registry exists and
   * pivotIds stay empty.
   */
  olapPivotRefs?: Array<{ tabId?: number; name: string }>;
}

/** Toggle a value in the selection. Empty array = all selected. */
export function toggleSlicerValue(spec: SlicerSpec, value: string, allValues: string[]): SlicerSpec {
  const current = spec.selected.length === 0 ? [...allValues] : [...spec.selected];
  const i = current.indexOf(value);
  if (i >= 0) current.splice(i, 1);
  else current.push(value);
  // Selecting everything collapses back to "all".
  const selected =
    current.length === allValues.length && allValues.every((v) => current.includes(v))
      ? []
      : current;
  return { ...spec, selected };
}

/** Clear the slicer (select all). */
export function clearSlicer(spec: SlicerSpec): SlicerSpec {
  return { ...spec, selected: [] };
}

/** True if a row value passes the slicer filter. */
export function slicerPasses(spec: SlicerSpec, value: string): boolean {
  return spec.selected.length === 0 || spec.selected.includes(value);
}

/** Distinct sorted display values from one async single-column range read
 * (the slicer-values refresh path: rows × 1 column, first cell per row).
 * The caller supplies the display formatter so this module stays free of
 * the engine's value rendering. Blanks are skipped, like
 * distinctColumnValues. */
export function slicerValuesFromRangeRows<T>(
  rows: Array<Array<T | undefined>>,
  format: (v: T) => string,
): string[] {
  const found = new Set<string>();
  for (const row of rows ?? []) {
    const cell = row[0];
    if (cell === undefined) continue;
    const text = format(cell);
    if (text !== '') found.add(text);
  }
  return [...found].sort();
}

/** Distinct sorted values for a column from a row reader. */
export function distinctColumnValues(
  col: number,
  rowCount: number,
  readCell: (row: number, col: number) => string,
): string[] {
  const set = new Set<string>();
  for (let r = 0; r < rowCount; r++) {
    const v = readCell(r, col);
    if (v !== '') set.add(v);
  }
  return [...set].sort();
}

/** Bind a pivot table to the slicer (idempotent). */
export function bindSlicerPivot(spec: SlicerSpec, pivotId: number): SlicerSpec {
  if (spec.pivotIds.includes(pivotId)) return spec;
  return { ...spec, pivotIds: [...spec.pivotIds, pivotId] };
}

/** Remove a pivot table from the slicer's bindings. */
export function unbindSlicerPivot(spec: SlicerSpec, pivotId: number): SlicerSpec {
  if (!spec.pivotIds.includes(pivotId)) return spec;
  return { ...spec, pivotIds: spec.pivotIds.filter((id) => id !== pivotId) };
}

/** Make a fresh SlicerSpec with no pivot bindings. */
export function makeSlicerSpec(partial: Omit<SlicerSpec, 'pivotIds'> & { pivotIds?: number[] }): SlicerSpec {
  return { ...partial, pivotIds: partial.pivotIds ?? [] };
}
