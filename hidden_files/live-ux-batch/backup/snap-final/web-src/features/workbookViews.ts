/**
 * Workbook views + zoom (View > Workbook Views, Zoom).
 *
 * View state model for Normal / Page Break Preview / Page Layout, page
 * geometry (breaks + page numbers for the preview, page rectangles for
 * layout), and zoom math (dialog presets + Zoom to Selection).
 *
 * GRID INTEGRATION SPEC (for the parent wiring Grid.tsx / App.tsx):
 * 1. App state: `view: WorkbookView` ('normal' default), `zoom: number`
 *    (percent, 25–400), `pageSetup: PageSetup`.
 * 2. Grid props to add: `view: WorkbookView`, `zoom: number`,
 *    `pageBreaks: { colBreaks: number[]; rowBreaks: number[] } | null`,
 *    `pageSetup: PageSetup`. Grid scales cell geometry by zoom/100.
 * 3. Page Break Preview: App computes pageBreaks via
 *    computePageBreaks(colWidthsPx, rowHeightsPx, pageSetup, zoom) and
 *    Grid draws dashed blue lines after break columns/rows plus a
 *    "Page N" watermark per page (pageNumberAt() gives the number).
 * 4. Page Layout: Grid renders the sheet as page rectangles — each page
 *    is pageSetup paper size minus margins at zoom; content clips per
 *    page; header/footer zones render pageSetup.header/footer text.
 *    Ruler.tsx draws the rulers; margins shade outside the printable
 *    area.
 * 5. Zoom to Selection: App measures the selection's pixel size and calls
 *    zoomToFit() to get the new zoom, clamped to 25–400.
 */

export type WorkbookView = 'normal' | 'pageBreakPreview' | 'pageLayout';

export const WORKBOOK_VIEWS: { id: WorkbookView; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'pageBreakPreview', label: 'Page Break Preview' },
  { id: 'pageLayout', label: 'Page Layout' },
];

export interface PageSetup {
  orientation: 'portrait' | 'landscape';
  /** US Letter default; inches. */
  paperWidthIn: number;
  paperHeightIn: number;
  marginIn: number;
  header: string;
  footer: string;
}

export const DEFAULT_PAGE_SETUP: PageSetup = {
  orientation: 'portrait',
  paperWidthIn: 8.5,
  paperHeightIn: 11,
  marginIn: 0.7,
  header: '',
  footer: '',
};

export const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200, 400];
export const MIN_ZOOM = 25;
export const MAX_ZOOM = 400;

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z)));
}

export interface PageBreaks {
  /** 0-based column indexes after which a vertical break is drawn. */
  colBreaks: number[];
  /** 0-based row indexes after which a horizontal break is drawn. */
  rowBreaks: number[];
}

const PX_PER_IN = 96;

/**
 * Compute page breaks from pixel column/row sizes. Columns/rows are
 * packed greedily into printable page areas.
 */
export function computePageBreaks(
  colWidthsPx: number[],
  rowHeightsPx: number[],
  setup: PageSetup,
  zoom: number,
): PageBreaks {
  const scale = zoom / 100;
  const printableW =
    ((setup.orientation === 'portrait' ? setup.paperWidthIn : setup.paperHeightIn) - setup.marginIn * 2) *
    PX_PER_IN *
    scale;
  const printableH =
    ((setup.orientation === 'portrait' ? setup.paperHeightIn : setup.paperWidthIn) - setup.marginIn * 2) *
    PX_PER_IN *
    scale;
  const colBreaks: number[] = [];
  let acc = 0;
  colWidthsPx.forEach((w, i) => {
    acc += w;
    if (acc > printableW && i > 0) {
      colBreaks.push(i - 1);
      acc = w;
    }
  });
  const rowBreaks: number[] = [];
  acc = 0;
  rowHeightsPx.forEach((h, i) => {
    acc += h;
    if (acc > printableH && i > 0) {
      rowBreaks.push(i - 1);
      acc = h;
    }
  });
  return { colBreaks, rowBreaks };
}

/** 1-based page number of the page containing (col, row). */
export function pageNumberAt(col: number, row: number, breaks: PageBreaks): number {
  const colPage = breaks.colBreaks.filter((b) => b < col).length;
  const rowPage = breaks.rowBreaks.filter((b) => b < row).length;
  const colsPerRow = breaks.colBreaks.length + 1;
  return rowPage * colsPerRow + colPage + 1;
}

/**
 * Zoom (%) that fits a pixel rect into a viewport, clamped to 25–400.
 * currentZoom is the zoom the pixel sizes were measured at.
 */
export function zoomToFit(
  viewportW: number,
  viewportH: number,
  selW: number,
  selH: number,
  currentZoom: number,
): number {
  if (selW <= 0 || selH <= 0 || viewportW <= 0 || viewportH <= 0) return currentZoom;
  const fit = Math.min(viewportW / selW, viewportH / selH) * currentZoom;
  return clampZoom(fit);
}

/** Printable page size in px at a zoom level. */
export function pageSizePx(setup: PageSetup, zoom: number): { w: number; h: number } {
  const scale = (zoom / 100) * PX_PER_IN;
  const wIn = setup.orientation === 'portrait' ? setup.paperWidthIn : setup.paperHeightIn;
  const hIn = setup.orientation === 'portrait' ? setup.paperHeightIn : setup.paperWidthIn;
  return { w: wIn * scale, h: hIn * scale };
}
