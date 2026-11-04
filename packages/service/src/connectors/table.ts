/**
 * TableData — the normalized shape every connector produces.
 *
 * A connector fetches from its source and normalizes to this columnar table.
 * tableToWorkbookData() then projects it to the engine's WorkbookData
 * (header row + data rows), which io.ts loads into the typed computational
 * view. Formulas, charts and pivots operate on the view, never on the
 * connector, so all of them work over connected data automatically.
 */
import type { CellInput, WorkbookData } from '@icecream-sheets/engine';

/** Cell values a connector may produce. Rich values stay strings. */
export type TableCell = string | number | boolean | null;

/** Inferred column type (best-effort; the engine re-types at the view). */
export type ColumnType = 'text' | 'number' | 'boolean' | 'date' | 'unknown';

export interface TableData {
  /** Unique, non-empty column names (connectors de-duplicate). */
  columns: string[];
  /** Row-major data cells; rows[i].length === columns.length. */
  rows: TableCell[][];
  /** One entry per column; 'unknown' when the column is empty/all null. */
  types: ColumnType[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Best-effort column type inference over non-null values. */
export function inferColumnType(values: TableCell[]): ColumnType {
  let sawText = false;
  for (const v of values) {
    if (v === null) continue;
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'string') {
      const t = v.trim();
      if (t !== '' && ISO_DATE.test(t) && !Number.isNaN(Date.parse(t))) return 'date';
      sawText = true;
    }
  }
  return sawText ? 'text' : 'unknown';
}

/**
 * Build a TableData, normalizing ragged rows (short rows pad with null,
 * long rows are truncated) and inferring column types.
 */
export function makeTableData(columns: string[], rows: TableCell[][]): TableData {
  const norm = rows.map((r) =>
    columns.map((_, i) => (i < r.length ? (r[i] ?? null) : null)),
  );
  const types = columns.map((_, i) => inferColumnType(norm.map((r) => r[i] as TableCell)));
  return { columns: [...columns], rows: norm, types };
}

/** De-duplicate column names: "a", "a_2", "a_3", … (blank → "Column N"). */
export function uniqueColumns(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, i) => {
    const base = raw.trim() === '' ? `Column${i + 1}` : raw.trim();
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  });
}

function cellToInput(v: TableCell): CellInput {
  // NOTE: strings starting with '=' become formulas via EngineWorkbook.setCell,
  // exactly like CSV import today. Connectors carry data, so a literal "=1+1"
  // in source data evaluates — documented behavior, same as CSV open.
  return v;
}

/**
 * Project a TableData to the engine's WorkbookData: a single sheet whose
 * first row is the header and whose data rows follow. This is the typed
 * computational view the grid, formulas, charts and pivots consume.
 */
export function tableToWorkbookData(table: TableData, sheetName: string): WorkbookData {
  const rows: CellInput[][] = [
    table.columns.map((c) => c as CellInput),
    ...table.rows.map((r) => r.map(cellToInput)),
  ];
  return { sheets: [{ name: sheetName, rows }], metadata: {} };
}

/** First N data rows of a table, for connection-test previews. */
export function tablePreview(table: TableData, n: number): TableData {
  return { columns: table.columns, rows: table.rows.slice(0, n), types: table.types };
}
