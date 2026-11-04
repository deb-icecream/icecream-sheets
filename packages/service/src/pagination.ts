/**
 * Deterministic pagination engine (design-docs/print-and-page-layout.md §1).
 *
 * Lays out pages from the versioned print snapshot — the same typed content
 * the grid renders (used range, row heights, column widths) plus the page
 * setup (page size, orientation, margins, scaling, print area, print titles)
 * and manual page breaks. Identical input produces identical pages on every
 * host: the function is pure (no clock, no randomness), sorts and dedupes
 * all break inputs, and uses fixed, documented measurement constants.
 *
 * Page setup persists as adapter metadata (`icecream.pagesetup.<sheet>`);
 * manual breaks persist as `icecream.pagebreaks.<sheet>` (see
 * pageBreaks.ts). Neither is stored in cell data (design §2).
 *
 * Units: margins and paper sizes are inches; row heights / column widths
 * are CSS px (96 px per inch), matching the grid's geometry. Scaling is a
 * percent (10–400): at 50% the content renders at half size, so twice as
 * much content fits per page.
 */

import type { PageBreaks } from './pageBreaks.js';

// ---------------------------------------------------------------------------
// Page setup
// ---------------------------------------------------------------------------

export type PageOrientation = 'portrait' | 'landscape';
export type PaperSize = 'letter' | 'a4' | 'legal' | 'a3' | 'custom';

/** Paper dimensions in inches (width × height, portrait). */
export const PAPER_SIZES_IN: Record<Exclude<PaperSize, 'custom'>, { w: number; h: number }> = {
  letter: { w: 8.5, h: 11 },
  a4: { w: 8.27, h: 11.69 },
  legal: { w: 8.5, h: 14 },
  a3: { w: 11.69, h: 16.54 },
};

export const PX_PER_INCH = 96;

export interface PageMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PrintPageSetup {
  orientation: PageOrientation;
  paperSize: PaperSize;
  /** Required when paperSize is 'custom'. Inches. */
  customSize?: { w: number; h: number };
  margins: PageMargins;
  /** Print scaling percent, clamped to 10–400. */
  scale: number;
  /** A1 print area ("A1:D20") or null for the whole used range. */
  printArea: string | null;
  /**
   * Rows repeated at the top of every vertical page, as an A1 row span
   * ("1:3"). Null for none.
   */
  printTitleRows: string | null;
  /** Columns repeated at the left of every horizontal page ("A:B"). */
  printTitleCols: string | null;
  header: string;
  footer: string;
  /**
   * Page-numbering order. 'downOver' is Excel's default (number pages down
   * the first column band, then across); 'overDown' numbers across first.
   */
  pageOrder?: 'downOver' | 'overDown';
}

export const DEFAULT_PRINT_SETUP: PrintPageSetup = {
  orientation: 'portrait',
  paperSize: 'letter',
  margins: { top: 0.75, right: 0.7, bottom: 0.75, left: 0.7 },
  scale: 100,
  printArea: null,
  printTitleRows: null,
  printTitleCols: null,
  header: '',
  footer: '',
  pageOrder: 'downOver',
};

// ---------------------------------------------------------------------------
// Snapshot input
// ---------------------------------------------------------------------------

/** Inclusive 0-based used range. */
export interface UsedRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface PrintSnapshot {
  sheet: string;
  /** Null for an empty sheet (no pages). */
  used: UsedRange | null;
  /** Row height in CSS px for a 0-based row. */
  rowHeight: (row: number) => number;
  /** Column width in CSS px for a 0-based column. */
  colWidth: (col: number) => number;
}

export interface PaginatedPage {
  sheet: string;
  pageNumber: number;
  /** Inclusive 0-based bounds of the page's own content (titles excluded). */
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  /** Print-title rows repeated at the top of this page (null when none). */
  titleRows: { startRow: number; endRow: number } | null;
  /** Print-title columns repeated at the left of this page (null when none). */
  titleCols: { startCol: number; endCol: number } | null;
}

// ---------------------------------------------------------------------------
// A1 parsing (local; keeps this module dependency-free)
// ---------------------------------------------------------------------------

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseA1Cell(a1: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(a1.trim());
  if (!m) return null;
  return { col: colLettersToIndex(m[1]), row: parseInt(m[2], 10) - 1 };
}

/** Parse "A1:D20" into 0-based bounds; null on malformed input. */
export function parseA1Range(a1: string): UsedRange | null {
  const parts = a1.split(':');
  if (parts.length === 1) {
    const cell = parseA1Cell(parts[0]);
    return cell ? { startRow: cell.row, endRow: cell.row, startCol: cell.col, endCol: cell.col } : null;
  }
  if (parts.length !== 2) return null;
  const a = parseA1Cell(parts[0]);
  const b = parseA1Cell(parts[1]);
  if (!a || !b) return null;
  return {
    startRow: Math.min(a.row, b.row),
    endRow: Math.max(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endCol: Math.max(a.col, b.col),
  };
}

/** Parse a row span like "1:3" (1-based, as Excel shows it). */
function parseRowSpan(text: string): { startRow: number; endRow: number } | null {
  const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  const a = parseInt(m[1], 10) - 1;
  const b = parseInt(m[2], 10) - 1;
  if (a < 0 || b < 0) return null;
  return { startRow: Math.min(a, b), endRow: Math.max(a, b) };
}

/** Parse a column span like "A:B". */
function parseColSpan(text: string): { startCol: number; endCol: number } | null {
  const m = /^\s*\$?([A-Za-z]+)\s*:\s*\$?([A-Za-z]+)\s*$/.exec(text);
  if (!m) return null;
  const a = colLettersToIndex(m[1]);
  const b = colLettersToIndex(m[2]);
  if (a < 0 || b < 0) return null;
  return { startCol: Math.min(a, b), endCol: Math.max(a, b) };
}

// ---------------------------------------------------------------------------
// Pagination
//
// Header/footer code expansion lives in headerFooter.ts (expandHFCodes);
// this engine treats header/footer as opaque page-setup strings.
// ---------------------------------------------------------------------------

function normalizeSetup(setup: PrintPageSetup): Required<Omit<PrintPageSetup, 'customSize' | 'pageOrder'>> & Pick<PrintPageSetup, 'customSize' | 'pageOrder'> {
  const margins = {
    top: Math.max(0, Number.isFinite(setup.margins.top) ? setup.margins.top : 0),
    right: Math.max(0, Number.isFinite(setup.margins.right) ? setup.margins.right : 0),
    bottom: Math.max(0, Number.isFinite(setup.margins.bottom) ? setup.margins.bottom : 0),
    left: Math.max(0, Number.isFinite(setup.margins.left) ? setup.margins.left : 0),
  };
  const scale = Math.min(400, Math.max(10, Number.isFinite(setup.scale) ? setup.scale : 100));
  return {
    orientation: setup.orientation === 'landscape' ? 'landscape' : 'portrait',
    paperSize: setup.paperSize,
    customSize: setup.customSize,
    margins,
    scale,
    printArea: typeof setup.printArea === 'string' && setup.printArea.trim() !== '' ? setup.printArea : null,
    printTitleRows: typeof setup.printTitleRows === 'string' && setup.printTitleRows.trim() !== '' ? setup.printTitleRows : null,
    printTitleCols: typeof setup.printTitleCols === 'string' && setup.printTitleCols.trim() !== '' ? setup.printTitleCols : null,
    header: typeof setup.header === 'string' ? setup.header : '',
    footer: typeof setup.footer === 'string' ? setup.footer : '',
    pageOrder: setup.pageOrder === 'overDown' ? 'overDown' : 'downOver',
  };
}

function paperSizeIn(setup: ReturnType<typeof normalizeSetup>): { w: number; h: number } {
  if (setup.paperSize === 'custom' && setup.customSize && setup.customSize.w > 0 && setup.customSize.h > 0) {
    return { w: setup.customSize.w, h: setup.customSize.h };
  }
  const known = PAPER_SIZES_IN[setup.paperSize as Exclude<PaperSize, 'custom'>] ?? PAPER_SIZES_IN.letter;
  return { w: known.w, h: known.h };
}

function sortedBreaks(values: number[]): number[] {
  return [...new Set(values)].filter((v) => Number.isInteger(v) && v >= 0).sort((a, b) => a - b);
}

/**
 * Split an inclusive [start, end] index range into bands. A band grows by
 * accumulating `sizeOf(i)` until adding the next index would exceed
 * `usable` — a cell is never split across pages. `forcedAfter` holds
 * sorted "break after index" positions that always end the current band.
 * Indices in `excluded` (print titles) are skipped for banding but still
 * validated: a title index inside [start, end] is simply not paginated as
 * content (it repeats on every page instead).
 */
function bandRange(
  start: number,
  end: number,
  sizeOf: (i: number) => number,
  usable: number,
  forcedAfter: number[],
  excluded: Set<number>,
): [number, number][] {
  const breaks = new Set(forcedAfter.filter((b) => b >= start && b < end));
  const bands: [number, number][] = [];
  let bandStart = -1;
  let used = 0;
  const flush = (last: number) => {
    if (bandStart >= 0) bands.push([bandStart, last]);
    bandStart = -1;
    used = 0;
  };
  for (let i = start; i <= end; i++) {
    if (excluded.has(i)) {
      // A title index ends the current band (titles never share a band
      // with content) but is not itself emitted as content.
      flush(i - 1);
      continue;
    }
    const size = Math.max(0, sizeOf(i));
    if (bandStart >= 0 && used + size > usable) flush(i - 1);
    if (bandStart < 0) bandStart = i;
    used += size;
    if (breaks.has(i)) flush(i);
  }
  flush(end);
  return bands;
}

/**
 * Deterministic pagination: same snapshot + same setup + same breaks →
 * same pages. Pure: no I/O, no clock, no randomness.
 */
export function paginateSheet(
  snapshot: PrintSnapshot,
  setup: PrintPageSetup,
  breaks: PageBreaks = { rows: [], cols: [] },
): PaginatedPage[] {
  const s = normalizeSetup(setup);
  if (!snapshot.used) return [];
  const paper = paperSizeIn(s);
  const pageWIn = (s.orientation === 'portrait' ? paper.w : paper.h) - s.margins.left - s.margins.right;
  const pageHIn = (s.orientation === 'portrait' ? paper.h : paper.w) - s.margins.top - s.margins.bottom;
  if (pageWIn <= 0 || pageHIn <= 0) return [];
  // Content is scaled: usable CSS px = physical px / (scale/100).
  // Snapped to 1e-6 px so exact-fit boundaries (e.g. 38 rows of exactly
  // 912 px) don't lose a row to float dust like 911.9999999999999.
  const snap = (v: number): number => Math.round(v * 1e6) / 1e6;
  const usableW = Math.max(1, snap(((pageWIn * PX_PER_INCH) / s.scale) * 100));
  const usableH = Math.max(1, snap(((pageHIn * PX_PER_INCH) / s.scale) * 100));

  // Intersect with the print area when set and parseable.
  let { startRow, endRow, startCol, endCol } = snapshot.used;
  if (s.printArea) {
    const area = parseA1Range(s.printArea);
    if (area) {
      startRow = Math.max(startRow, area.startRow);
      endRow = Math.min(endRow, area.endRow);
      startCol = Math.max(startCol, area.startCol);
      endCol = Math.min(endCol, area.endCol);
    }
  }
  if (endRow < startRow || endCol < startCol) return [];

  // Print titles: clamped to the used range; excluded from banding, repeated
  // on every page, and their size is reserved from the usable space.
  const titleRowSpan = s.printTitleRows ? parseRowSpan(s.printTitleRows) : null;
  const titleColSpan = s.printTitleCols ? parseColSpan(s.printTitleCols) : null;
  const titleRows =
    titleRowSpan && titleRowSpan.endRow >= startRow && titleRowSpan.startRow <= endRow
      ? {
          startRow: Math.max(titleRowSpan.startRow, startRow),
          endRow: Math.min(titleRowSpan.endRow, endRow),
        }
      : null;
  const titleCols =
    titleColSpan && titleColSpan.endCol >= startCol && titleColSpan.startCol <= endCol
      ? {
          startCol: Math.max(titleColSpan.startCol, startCol),
          endCol: Math.min(titleColSpan.endCol, endCol),
        }
      : null;
  const excludedRows = new Set<number>();
  if (titleRows) for (let r = titleRows.startRow; r <= titleRows.endRow; r++) excludedRows.add(r);
  const excludedCols = new Set<number>();
  if (titleCols) for (let c = titleCols.startCol; c <= titleCols.endCol; c++) excludedCols.add(c);

  let contentW = usableW;
  if (titleCols) {
    for (let c = titleCols.startCol; c <= titleCols.endCol; c++) {
      contentW -= Math.max(0, snapshot.colWidth(c));
    }
  }
  let contentH = usableH;
  if (titleRows) {
    for (let r = titleRows.startRow; r <= titleRows.endRow; r++) {
      contentH -= Math.max(0, snapshot.rowHeight(r));
    }
  }
  contentW = Math.max(1, contentW);
  contentH = Math.max(1, contentH);

  const colBands = bandRange(startCol, endCol, snapshot.colWidth, contentW, sortedBreaks(breaks.cols), excludedCols);
  const rowBands = bandRange(startRow, endRow, snapshot.rowHeight, contentH, sortedBreaks(breaks.rows), excludedRows);
  if (colBands.length === 0 || rowBands.length === 0) return [];

  // Cross product in the requested page order; numbers assigned in order.
  const ordered: { rb: [number, number]; cb: [number, number] }[] = [];
  if (s.pageOrder === 'overDown') {
    for (const rb of rowBands) for (const cb of colBands) ordered.push({ rb, cb });
  } else {
    for (const cb of colBands) for (const rb of rowBands) ordered.push({ rb, cb });
  }

  return ordered.map(({ rb, cb }, i) => ({
    sheet: snapshot.sheet,
    pageNumber: i + 1,
    startRow: rb[0],
    endRow: rb[1],
    startCol: cb[0],
    endCol: cb[1],
    titleRows,
    titleCols,
  }));
}
