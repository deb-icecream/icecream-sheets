/**
 * ETL pipeline — core table model.
 *
 * Per design-docs/etl-pipeline.md §1, recipe edges carry *typed* tables:
 * every node consumes and produces an EtlTable (named, typed columns plus
 * rows of scalar values). This model is deliberately narrow — no nested
 * objects, no dates-as-objects — so tables stay JSON-serializable (recipes,
 * run history and retained versions all live in the service metadata
 * store) and so sandboxed custom transforms have a fixed contract.
 */

/** Scalar value a table cell can hold. Dates are ISO-8601 strings. */
export type EtlValue = string | number | boolean | null;

/** One row: column name -> value. */
export type EtlRow = Record<string, EtlValue>;

export type EtlColumnType = 'text' | 'number' | 'date' | 'boolean' | 'unknown';

export interface EtlColumn {
  name: string;
  type: EtlColumnType;
}

export interface EtlTable {
  columns: EtlColumn[];
  rows: EtlRow[];
}

/** A row that failed a transform step, kept for quarantine reporting. */
export interface RowFailure {
  rowIndex: number;
  column?: string;
  reason: string;
}

export function emptyTable(): EtlTable {
  return { columns: [], rows: [] };
}

export function columnNames(table: EtlTable): string[] {
  return table.columns.map((c) => c.name);
}

export function isEtlValue(v: unknown): v is EtlValue {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
}

/** Coerce an unknown value into an EtlValue; throws on objects/arrays. */
export function toEtlValue(v: unknown): EtlValue {
  if (isEtlValue(v)) return v;
  if (typeof v === 'number' && Number.isNaN(v)) return null;
  throw new Error(`value is not a scalar EtlValue: ${typeof v}`);
}

/**
 * Build a table from header names and matrix rows. Short rows are padded
 * with null; extra values are dropped.
 */
export function makeTable(headers: string[], matrix: EtlValue[][]): EtlTable {
  const columns: EtlColumn[] = headers.map((h) => ({ name: h, type: 'unknown' as EtlColumnType }));
  const rows: EtlRow[] = matrix.map((r) => {
    const row: EtlRow = {};
    headers.forEach((h, i) => {
      row[h] = i < r.length ? r[i] : null;
    });
    return row;
  });
  return { columns, rows };
}

/** Format an EtlValue for display / grid loading. */
export function formatValue(v: EtlValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}
