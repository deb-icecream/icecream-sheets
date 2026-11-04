/**
 * Column width / row height sizing (Home > Cells > Format).
 *
 * Excel measures column width in "characters of the standard font" and row
 * height in points. These pure helpers estimate content size from display
 * text so the app can offer AutoFit without measuring the DOM; the app
 * applies the results through its rowHeights/colWidths state.
 */

export const DEFAULT_ROW_HEIGHT = 15;
export const DEFAULT_COL_WIDTH = 8.43;
export const MIN_ROW_HEIGHT = 5;
export const MAX_ROW_HEIGHT = 409;
export const MIN_COL_WIDTH = 0;
export const MAX_COL_WIDTH = 255;

export interface SizeOptions {
  /** Font size in points (default 11, like Calibri 11). */
  fontSize?: number;
}

/** True for full-width (CJK etc.) characters, which take ~2 Latin widths. */
function isWideChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x20000
  );
}

/**
 * Width of one line of text in "character units" (wide chars count 2,
 * everything else 1). Tabs expand to 4.
 */
export function lineWidthChars(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === '\t') w += 4;
    else w += isWideChar(ch) ? 2 : 1;
  }
  return w;
}

/** Widest line of a possibly multi-line string, in character units. */
export function textWidthChars(text: string): number {
  return text.split('\n').reduce((m, line) => Math.max(m, lineWidthChars(line)), 0);
}

export function clampColWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_COL_WIDTH;
  return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, width));
}

export function clampRowHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_ROW_HEIGHT;
  return Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, height));
}

/**
 * AutoFit Column Width: widest display text in the column (in character
 * units) plus padding, clamped to Excel's 0..255 range. An empty column
 * returns the default width.
 */
export function autoFitColumnWidth(texts: string[], opts: SizeOptions = {}): number {
  void opts;
  if (texts.length === 0) return DEFAULT_COL_WIDTH;
  const widest = texts.reduce((m, t) => Math.max(m, textWidthChars(t)), 0);
  if (widest === 0) return DEFAULT_COL_WIDTH;
  return clampColWidth(widest + 1.2);
}

/**
 * AutoFit Row Height: tallest cell in the row, where each wrapped line
 * costs fontSize * 1.2 points (Excel's line pitch), clamped to 5..409.
 * Wrapped line count is estimated from column widths (character units);
 * pass 0/undefined widths for no wrapping.
 */
export function autoFitRowHeight(
  texts: string[],
  colWidths: (number | undefined)[] = [],
  opts: SizeOptions = {},
): number {
  const fontSize = opts.fontSize ?? 11;
  const linePitch = fontSize * 1.2;
  if (texts.every((t) => t === '')) return DEFAULT_ROW_HEIGHT;
  let lines = 1;
  texts.forEach((text, i) => {
    const width = colWidths[i] ?? 0;
    let textLines = 0;
    for (const paragraph of text.split('\n')) {
      textLines += width > 0 ? Math.max(1, Math.ceil(lineWidthChars(paragraph) / width)) : 1;
    }
    lines = Math.max(lines, textLines);
  });
  return clampRowHeight(Math.ceil(lines * linePitch));
}

/** Validate a Default Width dialog value (Excel: 0..255). */
export function isValidDefaultWidth(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_COL_WIDTH && value <= MAX_COL_WIDTH;
}

// ---------------------------------------------------------------------------
// Unit conversion: Excel units -> the app's pixel-based rowHeights/colWidths
// ---------------------------------------------------------------------------

/**
 * Column-width units to pixels. pxPerUnit defaults to 96 / 8.43 ≈ 11.39 so
 * the Excel default width maps to the app's 96px default column width.
 */
export function colWidthUnitsToPx(units: number, pxPerUnit = 96 / DEFAULT_COL_WIDTH): number {
  if (!Number.isFinite(units)) return 96;
  return Math.max(0, Math.round(units * pxPerUnit));
}

/** Points to pixels (CSS: 96dpi). */
export function rowHeightPointsToPx(points: number): number {
  if (!Number.isFinite(points)) return 24;
  return Math.max(1, Math.round((points * 96) / 72));
}

/** Pixels to points (for the Row Height dialog, which speaks points). */
export function rowHeightPxToPoints(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_ROW_HEIGHT;
  return Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, Math.round((px * 72) / 96)));
}
