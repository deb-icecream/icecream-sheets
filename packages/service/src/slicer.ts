/**
 * Slicer → pivot binding (Excel parity: slicers filter connected PivotTables).
 *
 * A slicer is a field-level filter control: `selected` holds the display
 * labels the user picked, and an empty selection means "select all" (no
 * filtering). A slicer can be bound to zero or more pivot tables; whenever
 * the selection changes, every bound pivot is recomputed with the slicer's
 * selection merged into its filters.
 *
 * SERVICE-LAYER, pure and headless: this module operates on plain JSON
 * records and versioned, serializable specs. It imports nothing from
 * workbook.ts, protocol.ts, or any storage code. Display-label conventions
 * match pivot.ts and reports/slicers.ts: '(blank)' for blanks, 'TRUE' /
 * 'FALSE' for booleans, String(v) otherwise.
 */

import type { PivotFilter, PivotRecord, PivotSpec } from './pivot.js';

export const SLICER_BINDING_VERSION = 1 as const;

/**
 * A slicer's field-level selection. `selected` is empty when everything is
 * selected (no filtering), matching the slicer UI convention.
 */
export interface SlicerSelection {
  /** Field name the slicer filters (matches PivotFilter.field). */
  field: string;
  /** Selected display labels; empty = select all. */
  selected: string[];
}

/**
 * Versioned, serializable binding between one slicer and the pivot tables
 * it drives. Lives in the service metadata store next to the pivot specs.
 */
export interface SlicerPivotBinding {
  version: typeof SLICER_BINDING_VERSION;
  /** Stable binding id (e.g. `slicerbinding-<n>`). */
  id: string;
  /** Id of the slicer that owns the selection. */
  slicerId: string;
  /** Field name the slicer filters. */
  field: string;
  /** Ids of the pivot tables this slicer drives. */
  pivotIds: string[];
}

export function makeSlicerPivotBinding(
  partial: Partial<SlicerPivotBinding> & { slicerId: string; field: string },
): SlicerPivotBinding {
  return {
    version: SLICER_BINDING_VERSION,
    id: partial.id ?? `slicerbinding-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    slicerId: partial.slicerId,
    field: partial.field,
    pivotIds: Array.isArray(partial.pivotIds) ? [...new Set(partial.pivotIds)] : [],
  };
}

/** Bind a pivot table to the slicer (idempotent). */
export function bindSlicerToPivot(binding: SlicerPivotBinding, pivotId: string): SlicerPivotBinding {
  if (binding.pivotIds.includes(pivotId)) return binding;
  return { ...binding, pivotIds: [...binding.pivotIds, pivotId] };
}

/** Remove a pivot table from the slicer's bindings. */
export function unbindSlicerFromPivot(binding: SlicerPivotBinding, pivotId: string): SlicerPivotBinding {
  if (!binding.pivotIds.includes(pivotId)) return binding;
  return { ...binding, pivotIds: binding.pivotIds.filter((id) => id !== pivotId) };
}

/** Ids of the pivot tables a slicer drives. */
export function boundPivotIds(binding: SlicerPivotBinding): string[] {
  return [...binding.pivotIds];
}

/** All bindings that drive a given pivot table. */
export function bindingsForPivot(bindings: SlicerPivotBinding[], pivotId: string): SlicerPivotBinding[] {
  return bindings.filter((b) => b.pivotIds.includes(pivotId));
}

/** Structural validation; returns human-readable errors (empty = valid). */
export function validateSlicerPivotBinding(binding: SlicerPivotBinding): string[] {
  const errs: string[] = [];
  if (binding.version !== SLICER_BINDING_VERSION) {
    errs.push(`Unsupported slicer binding version: ${String(binding.version)}.`);
  }
  if (!binding.id || binding.id.trim() === '') errs.push('Binding id is required.');
  if (!binding.slicerId || binding.slicerId.trim() === '') errs.push('Binding slicerId is required.');
  if (!binding.field || binding.field.trim() === '') errs.push('Binding field is required.');
  if (!Array.isArray(binding.pivotIds)) errs.push('Binding pivotIds must be an array.');
  else if (new Set(binding.pivotIds).size !== binding.pivotIds.length) {
    errs.push('Binding pivotIds contains duplicates.');
  }
  return errs;
}

/**
 * True when a display label passes a slicer selection. Empty selection =
 * select-all = everything passes.
 */
export function slicerSelectionPasses(selected: string[], label: string): boolean {
  return selected.length === 0 || selected.includes(label);
}

/**
 * Merge slicer selections into a pivot spec, producing a NEW spec (the
 * stored spec is never mutated). Rules:
 * - A slicer with an empty selection contributes no filter (select all).
 * - A slicer's filter REPLACES any existing pivot filter on the same
 *   field, so the slicer is the authority for that field while bound.
 * - Filters on fields no slicer touches are preserved untouched.
 */
export function applySlicersToPivotSpec(spec: PivotSpec, slicers: SlicerSelection[]): PivotSpec {
  const active = slicers.filter((s) => s.field.trim() !== '' && s.selected.length > 0);
  if (active.length === 0) return spec;
  const slicerFields = new Set(active.map((s) => s.field));
  const kept: PivotFilter[] = (spec.filters ?? []).filter((f) => !slicerFields.has(f.field));
  const merged: PivotFilter[] = [
    ...kept,
    ...active.map((s) => ({ field: s.field, selected: [...s.selected] })),
  ];
  return { ...spec, filters: merged };
}

/**
 * Remove every slicer-contributed filter for `field` from a spec (used
 * when a slicer is unbound from a pivot). Filters on other fields survive.
 */
export function removeSlicerFiltersFromSpec(spec: PivotSpec, field: string): PivotSpec {
  if (!spec.filters || spec.filters.length === 0) return spec;
  return { ...spec, filters: spec.filters.filter((f) => f.field !== field) };
}

/** Display label for a raw record value (pivot-filter convention). */
export function slicerBindingLabelOf(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/**
 * Filter plain records by a set of slicer selections (pre-filter helper
 * for hosts that apply slicers before handing records to the pivot).
 */
export function filterRecordsBySlicers(records: PivotRecord[], slicers: SlicerSelection[]): PivotRecord[] {
  const active = slicers.filter((s) => s.selected.length > 0);
  if (active.length === 0) return records;
  return records.filter((r) => active.every((s) => slicerSelectionPasses(s.selected, slicerBindingLabelOf(r[s.field]))));
}
