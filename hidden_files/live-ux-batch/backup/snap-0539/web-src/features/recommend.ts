/**
 * Recommendation engines for Recommended Charts and Recommended
 * PivotTables (Insert tab).
 *
 * Pure analysis over plain data:
 * - recommendCharts: inspects a cell range's shape (label column vs
 *   numeric columns, row count, date-like labels) and ranks chart kinds.
 * - recommendPivots: inspects table headers + distinct values and proposes
 *   row/value field combos as PivotSpecs.
 *
 * The dialogs render these with the real chart/pivot engines
 * (buildChartConfig / createPivot) and hand the chosen spec to the parent.
 */
import {
  PIVOT_SPEC_VERSION,
  type CellReader,
  type ChartKind,
  type ChartRange,
  type PivotSpec,
} from '@icecream-sheets/service';

// ---------------------------------------------------------------------------
// Recommended Charts
// ---------------------------------------------------------------------------

export interface ChartRecommendation {
  kind: ChartKind;
  reason: string;
}

interface RangeProfile {
  rows: number;
  cols: number;
  labelCol: boolean;
  numericCols: number[];
  textCols: number[];
  dateLikeLabels: boolean;
}

function isDateLike(s: string): boolean {
  const t = s.trim();
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(t)) return true;
  if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(t)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[ ,.-]*\d{0,4}$/i.test(t)) return true;
  if (/^q[1-4](\s*\d{4})?$/i.test(t)) return true;
  return false;
}

/**
 * Profile a range: first column treated as labels when it is mostly text,
 * other columns classified numeric vs text by majority of sampled cells.
 */
export function profileRange(read: CellReader, range: ChartRange): RangeProfile {
  const rows = range.endRow - range.startRow + 1;
  const cols = range.endCol - range.startCol + 1;
  const sampleRows = Math.min(rows, 50);

  const colKind = (c: number): 'numeric' | 'text' | 'mixed' => {
    let num = 0, txt = 0;
    for (let i = 0; i < sampleRows; i++) {
      const cell = read(range.startRow + i, c);
      if (cell.text === '') continue;
      if (cell.num !== null) num++;
      else txt++;
    }
    if (num > 0 && txt === 0) return 'numeric';
    if (txt > 0 && num === 0) return 'text';
    return 'mixed';
  };

  const kinds = Array.from({ length: cols }, (_, c) => colKind(range.startCol + c));
  const labelCol = cols > 1 && kinds[0] !== 'numeric';
  const numericCols: number[] = [];
  const textCols: number[] = [];
  kinds.forEach((k, i) => {
    if (i === 0 && labelCol) return;
    if (k === 'numeric') numericCols.push(i);
    else if (k === 'text') textCols.push(i);
  });

  let dateLikeLabels = false;
  if (labelCol) {
    let dateLike = 0, total = 0;
    for (let i = 0; i < sampleRows; i++) {
      const cell = read(range.startRow + i, range.startCol);
      if (cell.num === null && cell.text.trim() !== '') {
        total++;
        if (isDateLike(cell.text)) dateLike++;
      }
    }
    dateLikeLabels = total > 0 && dateLike / total >= 0.6;
  }

  return { rows, cols, labelCol, numericCols, textCols, dateLikeLabels };
}

/**
 * Rank chart kinds for a range. Returns up to 3 recommendations with
 * human-readable reasons, best first.
 */
export function recommendCharts(read: CellReader, range: ChartRange): ChartRecommendation[] {
  const p = profileRange(read, range);
  const recs: ChartRecommendation[] = [];
  const push = (kind: ChartKind, reason: string) => {
    if (!recs.some((r) => r.kind === kind)) recs.push({ kind, reason });
  };

  const nNum = p.numericCols.length;

  if (p.labelCol && nNum === 1) {
    if (p.rows <= 12 && !p.dateLikeLabels) {
      push('pie', 'One value per category — a pie shows each share of the total.');
      push('column-clustered', 'Compare the values across categories side by side.');
      push('bar-clustered', 'Horizontal bars make long category names easy to read.');
    } else {
      push('line', p.dateLikeLabels
        ? 'Date-like labels — a line shows the trend over time.'
        : 'Many points — a line keeps the trend readable.');
      push('column-clustered', 'Compare values across each label.');
      push('area', 'An area chart emphasizes the cumulative shape of the data.');
    }
  } else if (p.labelCol && nNum > 1) {
    push('column-clustered', `${nNum} numeric series across categories — clustered columns compare them directly.`);
    push('bar-clustered', 'Horizontal bars keep multiple series readable.');
    push('line', 'Lines show how each series moves across the categories.');
  } else if (!p.labelCol && nNum === 2) {
    push('scatter', 'Two numeric columns — a scatter plot reveals their relationship.');
    push('line', 'A line traces the paired values in row order.');
    push('column-clustered', 'Columns compare the two series row by row.');
  } else if (!p.labelCol && nNum >= 1) {
    push('column-clustered', 'Numeric data without labels — columns show each value.');
    push('line', 'A line shows the shape of the sequence.');
    push('bar-clustered', 'Bars compare the values horizontally.');
  } else {
    push('column-clustered', 'General-purpose comparison chart for this range.');
    push('bar-clustered', 'Horizontal alternative for category comparison.');
    push('pie', 'Shows each value as a share of the total.');
  }

  return recs.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Recommended PivotTables
// ---------------------------------------------------------------------------

export interface PivotTableRecommendation {
  title: string;
  reason: string;
  spec: PivotSpec;
}

export interface PivotSourceProfile {
  headers: string[];
  /** Distinct display values per header. */
  distinct: Record<string, string[]>;
  /** Headers whose values are mostly numeric. */
  numericFields: string[];
  rowCount: number;
}

function lowCardinalityTextFields(profile: PivotSourceProfile): string[] {
  return profile.headers.filter(
    (h) =>
      !profile.numericFields.includes(h) &&
      (profile.distinct[h]?.length ?? 0) > 1 &&
      (profile.distinct[h]?.length ?? 0) <= Math.max(10, profile.rowCount / 4),
  );
}

/**
 * Propose up to 3 pivot tables: (1) sum of the first numeric field by the
 * first low-cardinality text field, (2) the same crossed with a second
 * text field as columns, (3) a row count by the first text field.
 */
export function recommendPivots(profile: PivotSourceProfile): PivotTableRecommendation[] {
  const out: PivotTableRecommendation[] = [];
  const textFields = lowCardinalityTextFields(profile);
  const numeric = profile.numericFields;
  const rowField = textFields[0];
  const colField = textFields[1];

  if (rowField && numeric[0]) {
    out.push({
      title: `Sum of ${numeric[0]} by ${rowField}`,
      reason: `${rowField} has ${profile.distinct[rowField].length} distinct values — a natural grouping.`,
      spec: {
        version: PIVOT_SPEC_VERSION,
        rows: [rowField],
        columns: [],
        values: [{ field: numeric[0], aggregation: 'sum' }],
        filters: [],
      },
    });
  }
  if (rowField && colField && numeric[0]) {
    out.push({
      title: `Sum of ${numeric[0]} by ${rowField} and ${colField}`,
      reason: `Cross-tabulates two categorical fields against ${numeric[0]}.`,
      spec: {
        version: PIVOT_SPEC_VERSION,
        rows: [rowField],
        columns: [colField],
        values: [{ field: numeric[0], aggregation: 'sum' }],
        filters: [],
      },
    });
  }
  if (rowField) {
    out.push({
      title: `Count by ${rowField}`,
      reason: `Distribution of the ${profile.rowCount} rows across ${rowField}.`,
      spec: {
        version: PIVOT_SPEC_VERSION,
        rows: [rowField],
        columns: [],
        values: [{ field: rowField, aggregation: 'count' }],
        filters: [],
      },
    });
  }
  if (numeric[0] && out.length === 0) {
    out.push({
      title: `Summary of ${numeric[0]}`,
      reason: 'Single-number summary of the numeric column.',
      spec: {
        version: PIVOT_SPEC_VERSION,
        rows: [],
        columns: [],
        values: [
          { field: numeric[0], aggregation: 'sum' },
          { field: numeric[0], aggregation: 'average' },
        ],
        filters: [],
      },
    });
  }
  return out.slice(0, 3);
}
