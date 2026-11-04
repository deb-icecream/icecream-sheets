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
