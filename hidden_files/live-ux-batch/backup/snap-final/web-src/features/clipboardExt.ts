/**
 * Clipboard extensions for the web UI: TSV parsing, "paste special as
 * values", and format-painter state.
 *
 * Pure logic — no DOM or clipboard API access here; the caller supplies the
 * clipboard text / format store and receives transformed values back.
 */
import type { CellFormat, FormatStore } from './formatting';
import { getFormat, setFormat } from './formatting';

// ---------------------------------------------------------------------------
// TSV parsing
// ---------------------------------------------------------------------------

/**
 * Parse clipboard TSV text into a 2D grid of cell strings. Handles CRLF and
 * LF line endings; empty cells are preserved as ''. A trailing newline does
 * not create an extra empty row.
 */
export function parseTsvGrid(text: string): string[][] {
  const rows = text.split(/\r\n|\n/);
  // Drop a single trailing empty line produced by a final newline.
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows.map((row) => row.split('\t'));
}

/**
 * Convert clipboard TSV to "values" for Paste Special > Values: any cell
 * whose text begins with '=' has that leading '=' stripped so the content
 * pastes as literal text instead of a formula. Trailing fully-empty rows and
 * trailing fully-empty columns are trimmed.
 */
export function stripToValues(text: string): string {
  const grid = parseTsvGrid(text).map((row) =>
    row.map((cell) => (cell.startsWith('=') ? cell.slice(1) : cell)),
  );

  // Trim trailing empty rows.
  let lastRow = grid.length - 1;
  while (lastRow >= 0 && grid[lastRow].every((cell) => cell === '')) lastRow--;
  const rows = grid.slice(0, lastRow + 1);
  if (rows.length === 0) return '';

  // Trim trailing empty columns (cols empty in every remaining row).
  const width = Math.max(...rows.map((row) => row.length));
  let lastCol = width - 1;
  while (lastCol >= 0 && rows.every((row) => (row[lastCol] ?? '') === '')) lastCol--;

  return rows
    .map((row) => Array.from({ length: lastCol + 1 }, (_, i) => row[i] ?? '').join('\t'))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Format painter
// ---------------------------------------------------------------------------

/** Look up the format of the cell the format painter sampled. */
export function captureFormat(
  formats: FormatStore,
  sheet: string,
  row: number,
  col: number,
): CellFormat | undefined {
  return getFormat(formats, sheet, row, col);
}

/** Copy a captured format onto a target cell (overwrites that cell's format). */
export function applyFormatToCell(
  formats: FormatStore,
  sheet: string,
  row: number,
  col: number,
  fmt: CellFormat,
): FormatStore {
  return setFormat(formats, sheet, row, col, fmt);
}

/** The cell the format painter sampled from, or null when inactive. */
export interface FormatPainterSource {
  sheet: string;
  row: number;
  col: number;
}

/**
 * Format-painter interaction state. `start` samples a source cell; `apply`
 * copies that cell's format onto a target cell in the format store. Returns
 * the store unchanged when there is no active source or the source cell has
 * no format.
 */
export class FormatPainterState {
  source: FormatPainterSource | null = null;

  start(source: FormatPainterSource): void {
    this.source = source;
  }

  stop(): void {
    this.source = null;
  }

  apply(
    formats: FormatStore,
    targetSheet: string,
    targetRow: number,
    targetCol: number,
  ): FormatStore {
    if (!this.source) return formats;
    const fmt = getFormat(formats, this.source.sheet, this.source.row, this.source.col);
    if (!fmt) return formats;
    return setFormat(formats, targetSheet, targetRow, targetCol, { ...fmt });
  }
}
