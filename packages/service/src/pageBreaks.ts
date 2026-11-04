/**
 * Manual page breaks (design-docs/print-and-page-layout.md §2, §5).
 *
 * Page breaks are page setup: they persist as adapter metadata
 * (`icecream.pagebreaks.<sheet>`) and round-trip through XLSX natively as
 * worksheet row/column breaks (`<rowBreaks>`/`<colBreaks>` in the sheet XML
 * — SheetJS CE neither parses nor writes these, so the xlsx-adapter injects
 * and parses the XML itself). They are never stored in cell data.
 *
 * A row break after 0-based row r means: the next page starts at row r+1.
 * Column breaks work the same way. All functions are pure and return new
 * objects; break lists are always sorted, unique, non-negative integers.
 */

export interface PageBreaks {
  /** 0-based row indices: a page break runs AFTER each of these rows. */
  rows: number[];
  /** 0-based column indices: a page break runs AFTER each of these columns. */
  cols: number[];
}

/** Workbook-metadata key prefix: `icecream.pagebreaks.<sheet>`. */
export const PAGE_BREAKS_METADATA_PREFIX = 'icecream.pagebreaks.';

export function pageBreaksMetadataKey(sheet: string): string {
  return `${PAGE_BREAKS_METADATA_PREFIX}${sheet}`;
}

export const EMPTY_PAGE_BREAKS: PageBreaks = { rows: [], cols: [] };

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].filter((v) => Number.isInteger(v) && v >= 0).sort((a, b) => a - b);
}

/** Insert a row break after 0-based row `row`. Idempotent. */
export function insertRowBreak(breaks: PageBreaks, row: number): PageBreaks {
  return { rows: sortedUnique([...breaks.rows, row]), cols: [...breaks.cols] };
}

/** Remove the row break after 0-based row `row` (no-op when absent). */
export function removeRowBreak(breaks: PageBreaks, row: number): PageBreaks {
  return { rows: breaks.rows.filter((r) => r !== row), cols: [...breaks.cols] };
}

/** Insert a column break after 0-based column `col`. Idempotent. */
export function insertColBreak(breaks: PageBreaks, col: number): PageBreaks {
  return { rows: [...breaks.rows], cols: sortedUnique([...breaks.cols, col]) };
}

/** Remove the column break after 0-based column `col` (no-op when absent). */
export function removeColBreak(breaks: PageBreaks, col: number): PageBreaks {
  return { rows: [...breaks.rows], cols: breaks.cols.filter((c) => c !== col) };
}

/** Clear all manual breaks for the sheet. */
export function resetPageBreaks(): PageBreaks {
  return { rows: [], cols: [] };
}

/** True when the break set has at least one manual break. */
export function hasPageBreaks(breaks: PageBreaks): boolean {
  return breaks.rows.length > 0 || breaks.cols.length > 0;
}

/** Serialize for workbook metadata (plain JSON). */
export function pageBreaksToMetadata(breaks: PageBreaks): unknown {
  return { rows: [...breaks.rows], cols: [...breaks.cols] };
}

/**
 * Restore from workbook metadata. Never throws: malformed input yields an
 * empty break set (a corrupt hint must not break the open).
 */
export function pageBreaksFromMetadata(meta: unknown): PageBreaks {
  if (typeof meta !== 'object' || meta === null) return { ...EMPTY_PAGE_BREAKS };
  const r = meta as Record<string, unknown>;
  return {
    rows: Array.isArray(r.rows)
      ? sortedUnique(r.rows.filter((v): v is number => typeof v === 'number'))
      : [],
    cols: Array.isArray(r.cols)
      ? sortedUnique(r.cols.filter((v): v is number => typeof v === 'number'))
      : [],
  };
}
