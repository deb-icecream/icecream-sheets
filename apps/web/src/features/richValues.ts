/**
 * Display helpers for native rich values (Stocks/Geography) parsed by
 * packages/xlsx-adapter/src/richValues.ts.
 *
 * Pure functions only — no DOM, no grid wiring, no provider calls. The
 * input shape is structural: an adapter `ResolvedRichValue` satisfies it
 * directly (its `fields` are `{key, type?, value, rawText}`), so the app
 * can pass resolved values straight through without an adapter import.
 * FIELDVALUE / dot-notation binding and grid wiring are follow-ups (see
 * hidden_files/ooxml-69/piece-b-rich-values/REPORT.md); this file only
 * answers "what should the user see for this rich value?".
 */

export type RichValueScalar = string | number | boolean;

export interface RichValueDisplayField {
  key: string;
  type?: string;
  value: RichValueScalar;
  rawText?: string;
}

/** Structural input: adapter ResolvedRichValue, or a hand-built equivalent. */
export interface RichValueDisplayInput {
  fields: RichValueDisplayField[];
  /** Record `<fb>` text, else the cell's cached fallback. */
  fallback?: string;
  /** Explicit display text, when the caller already knows one. */
  display?: string;
  /** Metadata type name (normally `XLRICHVALUE`) or rich type (`_Stock`). */
  typeName?: string;
}

export type RichValueKind = 'stock' | 'geography';

/**
 * Infer the linked-data kind from a type name: `_Stock`/`STOCK` →
 * 'stock', `_Geography`/`GEOGRAPHY` → 'geography', anything else → null.
 * Matching is case-insensitive and ignores leading underscores/spaces.
 */
export function inferRichValueKind(typeName?: string): RichValueKind | null {
  if (!typeName) return null;
  const n = typeName.trim().replace(/^_+/, '').toLowerCase();
  if (n === 'stock' || n.includes('stock')) return 'stock';
  if (n === 'geography' || n.includes('geograph')) return 'geography';
  return null;
}

/** Normalize a field name the way the engine does: case-insensitive, spaces/underscores ignored. */
export function normalizeRichValueFieldName(field: string): string {
  return field.toLowerCase().replace(/[\s_]+/g, '');
}

/** Look up one field by name (normalized); null when absent. */
export function richValueField(input: RichValueDisplayInput, name: string): RichValueScalar | null {
  const want = normalizeRichValueFieldName(name);
  const found = input.fields.find((f) => normalizeRichValueFieldName(f.key) === want);
  return found ? found.value : null;
}

/** Format one scalar the way Excel displays it: booleans as TRUE/FALSE, otherwise plain text. */
export function formatRichValueScalar(value: RichValueScalar): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/** The text a grid cell shows for a rich value: explicit display, else fallback, else the first field. */
export function richValueLabel(input: RichValueDisplayInput): string {
  if (input.display !== undefined && input.display !== '') return input.display;
  if (input.fallback !== undefined && input.fallback !== '') return input.fallback;
  const first = input.fields[0];
  return first ? formatRichValueScalar(first.value) : '';
}

/** Fields as label/value pairs for a detail card, in structure order. */
export function richValueFields(input: RichValueDisplayInput): { label: string; value: string }[] {
  return input.fields.map((f) => ({ label: f.key, value: formatRichValueScalar(f.value) }));
}

/** Detail-card lines ("Label: value"), one per field. */
export function richValueDetailLines(input: RichValueDisplayInput): string[] {
  return richValueFields(input).map((f) => `${f.label}: ${f.value}`);
}

/** Type guard for unknown values that might be a rich-value display input. */
export function isRichValueDisplayInput(v: unknown): v is RichValueDisplayInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as { fields?: unknown };
  return Array.isArray(o.fields);
}

/**
 * Grid key (`${sheet}:${row}:${col}`, the dataTypeCells convention) for a
 * resolved rich value's cell, or null when the A1 ref does not parse.
 * Used by App's hydrate to index resolved values by sheet+ref.
 */
export function richValueCellKey(sheetName: string, ref: string): string | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  const letters = m[1]!;
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  const row = Number(m[2]) - 1;
  if (row < 0 || col < 0) return null;
  return `${sheetName}:${row}:${col}`;
}
