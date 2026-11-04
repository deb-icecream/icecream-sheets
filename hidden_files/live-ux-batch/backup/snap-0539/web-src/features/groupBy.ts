/**
 * Group-by view (Data > Data Tools > Group-by View).
 *
 * Builds a pivot-style summary of the active sheet's used range: pick
 * group fields, value fields and aggregations, and get the pivot matrix
 * (via @icecream-sheets/service pivot — the same component behind the
 * pivot tables, including date/numeric/custom grouping operators).
 * The caller writes the returned matrix to a new sheet.
 *
 * Pure: operates on plain header + row arrays the caller reads through
 * the typed view.
 */
import {
  createPivot,
  pivotToMatrix,
  recordsFromGrid,
  type PivotAggregation,
  type PivotGrouping,
  type PivotSpec,
} from '@icecream-sheets/service';

export interface GroupByValueField {
  field: string;
  aggregation: PivotAggregation;
}

export interface GroupByOptions {
  /** Fields to group by (row dimensions), in order. */
  groupFields: string[];
  /** Value fields with their aggregations. */
  valueFields: GroupByValueField[];
  /** Optional grouping operators (date/numeric/custom) for group fields. */
  groupings?: PivotGrouping[];
}

export interface GroupByResult {
  /** Rendered pivot matrix (strings/numbers/null), ready to write to a sheet. */
  matrix: (string | number | null)[][];
  /** Suggested title for the destination sheet. */
  title: string;
}

/**
 * Build the group-by matrix. Throws on invalid options (unknown fields,
 * no group fields, no value fields) with human-readable messages.
 */
export function groupByView(
  headers: string[],
  dataRows: unknown[][],
  options: GroupByOptions,
): GroupByResult {
  if (options.groupFields.length === 0) {
    throw new Error('Pick at least one field to group by.');
  }
  if (options.valueFields.length === 0) {
    throw new Error('Pick at least one value field.');
  }
  const known = new Set(headers);
  for (const f of options.groupFields) {
    if (!known.has(f)) throw new Error(`Unknown field "${f}".`);
  }
  for (const vf of options.valueFields) {
    if (!known.has(vf.field)) throw new Error(`Unknown value field "${vf.field}".`);
  }
  const spec: PivotSpec = {
    version: 1,
    rows: options.groupFields,
    columns: [],
    values: options.valueFields.map((vf) => ({ field: vf.field, aggregation: vf.aggregation })),
    groupings: options.groupings,
  };
  const records = recordsFromGrid(headers, dataRows);
  const pivot = createPivot(records, spec);
  const matrix = pivotToMatrix(pivot);
  return {
    matrix,
    title: `GroupBy ${options.groupFields.join(', ')}`,
  };
}
