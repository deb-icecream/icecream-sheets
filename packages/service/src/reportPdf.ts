/**
 * Native report PDF (design-docs/native-reports-and-dashboards.md §8).
 *
 * "Export to PDF through the Download as PDF path. The layout renderer
 * handles pagination." This module is that path: it renders report blocks
 * (KPI cards, tables, heatmaps, chart images) to real PDF bytes with a
 * deterministic flow layout — no window.print(), no browser involved.
 *
 * Pure TypeScript, zero dependencies: runs identically in the browser
 * bundle, Node, and the service boundary. PDF 1.4, base-14 fonts
 * (Helvetica / Helvetica-Bold, WinAnsi), deterministic output (the
 * CreationDate is a fixed constant unless the caller overrides it).
 * Text measurement reuses the Adobe Helvetica width table from pdf.ts.
 *
 * Charts arrive as client-captured JPEG bytes (canvas → toDataURL, SVG →
 * rasterized through a canvas) and embed verbatim as /DCTDecode XObjects.
 */

import {
  DEFAULT_PDF_CREATED,
  fitText,
  measureTextPt,
  parseJpegDimensions,
  pdfNum,
  pdfString,
  renderGenericPdfDocument,
  type PdfGenericPage,
  type PdfImageXObject,
} from './pdf.js';

// ---------------------------------------------------------------------------
// Block model (built by the caller from computed report visuals)
// ---------------------------------------------------------------------------

export interface ReportPdfKpi {
  label: string;
  value: string;
  /** Hex status color, e.g. '#1a7f37'. */
  color: string;
  deltaText: string | null;
  /** Hex delta color or null (falls back to #444). */
  deltaColor: string | null;
  targetText: string | null;
}

export interface ReportPdfCell {
  text: string;
  /** Hex fill color (heatmaps) or undefined for none. */
  fill?: string;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
}

export type ReportPdfBlock =
  /** Visual title. */
  | { kind: 'heading'; text: string }
  /** Error / empty / informational line. */
  | { kind: 'note'; text: string }
  /** One row of KPI cards (each visual contributes its own row). */
  | { kind: 'kpiRow'; kpis: ReportPdfKpi[] }
  /** Table with a header row (repeated when the table spans pages). */
  | { kind: 'table'; headers: ReportPdfCell[]; rows: ReportPdfCell[][] }
  /** Chart image; scaled to fit the page, never split. */
  | { kind: 'image'; jpeg: Uint8Array; caption: string | null };

export interface RenderReportPdfInput {
  title: string;
  /** Small gray lines under the title (data-as-of, slicer summary). */
  meta: string[];
  blocks: ReportPdfBlock[];
  /** Fixed CreationDate (default: constant → deterministic). */
  created?: string;
}

// ---------------------------------------------------------------------------
// Layout constants (points)
// ---------------------------------------------------------------------------

const PT_PER_IN = 72;
const PAGE_W = 8.5 * PT_PER_IN; // Letter portrait
const PAGE_H = 11 * PT_PER_IN;
const MARGIN = 0.7 * PT_PER_IN;
const USABLE_W = PAGE_W - 2 * MARGIN;
const TOP_Y = PAGE_H - MARGIN;
const BOTTOM_Y = MARGIN + 18; // room for the page footer

const TITLE_SIZE = 18;
const META_SIZE = 9;
const HEADING_SIZE = 13;
const NOTE_SIZE = 10;
const KPI_LABEL_SIZE = 9;
const KPI_VALUE_SIZE = 16;
const KPI_SUB_SIZE = 9;
const TABLE_HEADER_SIZE = 10;
const TABLE_BODY_SIZE = 10;
const TABLE_ROW_H = 16;
const CAPTION_SIZE = 9;
const FOOTER_SIZE = 9;

const INK: [number, number, number] = [0.07, 0.07, 0.07];
const GRAY: [number, number, number] = [0.4, 0.4, 0.4];
const GRID: [number, number, number] = [0.82, 0.85, 0.89]; // #d0d7e3
const HEADER_FILL: [number, number, number] = [0.949, 0.965, 0.988]; // #f2f6fc

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return INK;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// ---------------------------------------------------------------------------
// Content-stream writer
// ---------------------------------------------------------------------------

class Page {
  ops: string[] = [];
  images: PdfImageXObject[] = [];
  /** Current baseline cursor (y grows downward in this writer). */
  y: number = TOP_Y;
  private imgSeq = 0;

  /** Set the fill/text color for subsequent operators. */
  color(rgb: [number, number, number]): void {
    this.ops.push(`${pdfNum(rgb[0])} ${pdfNum(rgb[1])} ${pdfNum(rgb[2])} rg`);
  }

  text(x: number, y: number, s: string, size: number, font: 'F1' | 'F2'): void {
    this.ops.push(
      `BT /${font} ${pdfNum(size)} Tf 1 0 0 1 ${pdfNum(x)} ${pdfNum(y)} Tm ${pdfString(s)} Tj ET`,
    );
  }

  /** Left/center/right-aligned text within [x, x+w], clipped to the box. */
  cellText(
    x: number,
    yTop: number,
    w: number,
    h: number,
    s: string,
    size: number,
    bold: boolean,
    align: 'left' | 'center' | 'right',
    rgb: [number, number, number],
  ): void {
    const clipped = fitText(s, Math.max(0, w - 8), size);
    const tw = measureTextPt(clipped, size);
    let tx = x + 4;
    if (align === 'center') tx = x + (w - tw) / 2;
    else if (align === 'right') tx = x + w - 4 - tw;
    this.color(rgb);
    this.ops.push(
      `q ${pdfNum(x)} ${pdfNum(yTop - h)} ${pdfNum(w)} ${pdfNum(h)} re W n ` +
        `BT /${bold ? 'F2' : 'F1'} ${pdfNum(size)} Tf 1 0 0 1 ${pdfNum(tx)} ${pdfNum(yTop - (h + size) / 2 + 1)} Tm ` +
        `${pdfString(clipped)} Tj ET Q`,
    );
  }

  rect(x: number, yTop: number, w: number, h: number, fill: [number, number, number] | null, stroke: [number, number, number] | null, lineW = 0.5): void {
    if (fill) this.ops.push(`${pdfNum(fill[0])} ${pdfNum(fill[1])} ${pdfNum(fill[2])} rg`);
    if (stroke) this.ops.push(`${pdfNum(stroke[0])} ${pdfNum(stroke[1])} ${pdfNum(stroke[2])} RG ${pdfNum(lineW)} w`);
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.ops.push(`${pdfNum(x)} ${pdfNum(yTop - h)} ${pdfNum(w)} ${pdfNum(h)} re ${op}`);
  }

  /** Place a JPEG, scaled to fit (w × h) box preserving aspect ratio. Returns the drawn height. */
  placeImage(jpeg: Uint8Array, x: number, yTop: number, maxW: number, maxH: number): number {
    const { width, height, components } = parseJpegDimensions(jpeg);
    const scale = Math.min(maxW / width, maxH / height, 1);
    const dw = width * scale;
    const dh = height * scale;
    this.imgSeq += 1;
    const name = `Im${this.imgSeq}`;
    this.images.push({ name, jpeg, width, height, components });
    // PDF y-axis grows upward: draw at (x, yTop - dh).
    this.ops.push(`q ${pdfNum(dw)} 0 0 ${pdfNum(dh)} ${pdfNum(x)} ${pdfNum(yTop - dh)} cm /${name} Do Q`);
    return dh;
  }

  toGenericPage(pageNumber: number, totalPages: number): PdfGenericPage {
    // Footer: "Page N of M", centered in the bottom margin.
    const label = `Page ${pageNumber} of ${totalPages}`;
    const w = measureTextPt(label, FOOTER_SIZE);
    this.color(GRAY);
    this.text((PAGE_W - w) / 2, MARGIN - 6, label, FOOTER_SIZE, 'F1');
    return { widthPt: PAGE_W, heightPt: PAGE_H, content: this.ops.join('\n'), images: this.images };
  }
}

// ---------------------------------------------------------------------------
// Flow layout
// ---------------------------------------------------------------------------

/** Max image height on a fresh page (reserves room for the caption). */
const MAX_IMAGE_H = TOP_Y - BOTTOM_Y - CAPTION_SIZE - 6;

function imageDrawHeight(jpeg: Uint8Array): number {
  const { width, height } = parseJpegDimensions(jpeg);
  const scale = Math.min(USABLE_W / width, MAX_IMAGE_H / height, 1);
  return height * scale;
}

function kpiRowHeight(): number {
  return 66;
}

export function renderReportPdf(input: RenderReportPdfInput): Uint8Array {
  const finished: Page[] = [];
  let page = new Page();

  const newPage = (): void => {
    finished.push(page);
    page = new Page();
  };
  /** Start a fresh page unless the current one is still empty. */
  const breakIfNeeded = (need: number): void => {
    if (page.y - need < BOTTOM_Y && page.y < TOP_Y) newPage();
  };

  // Title + meta.
  page.color(INK);
  page.text(MARGIN, page.y - TITLE_SIZE, fitText(input.title, USABLE_W, TITLE_SIZE), TITLE_SIZE, 'F2');
  page.y -= TITLE_SIZE + 6;
  for (const m of input.meta) {
    page.color(GRAY);
    page.text(MARGIN, page.y - META_SIZE, fitText(m, USABLE_W, META_SIZE), META_SIZE, 'F1');
    page.y -= META_SIZE + 3;
  }
  if (input.meta.length > 0) page.y -= 4;

  const drawTableHeader = (p: Page, headers: ReportPdfCell[], colW: number): void => {
    headers.forEach((h, i) => {
      const x = MARGIN + i * colW;
      p.rect(x, p.y, colW, TABLE_ROW_H, HEADER_FILL, GRID);
      p.cellText(x, p.y, colW, TABLE_ROW_H, h.text, TABLE_HEADER_SIZE, true, h.align ?? 'left', INK);
    });
    p.y -= TABLE_ROW_H;
  };
  const drawTableRow = (p: Page, row: ReportPdfCell[], colW: number): void => {
    row.forEach((c, i) => {
      const x = MARGIN + i * colW;
      p.rect(x, p.y, colW, TABLE_ROW_H, c.fill ? hexToRgb(c.fill) : null, GRID);
      p.cellText(x, p.y, colW, TABLE_ROW_H, c.text, TABLE_BODY_SIZE, c.bold ?? false, c.align ?? 'left', INK);
    });
    p.y -= TABLE_ROW_H;
  };

  for (const block of input.blocks) {
    switch (block.kind) {
      case 'heading': {
        breakIfNeeded(HEADING_SIZE + 8);
        page.y -= 8; // marginTop
        page.color(INK);
        page.text(MARGIN, page.y - HEADING_SIZE, fitText(block.text, USABLE_W, HEADING_SIZE), HEADING_SIZE, 'F2');
        page.y -= HEADING_SIZE + 6;
        break;
      }
      case 'note': {
        breakIfNeeded(NOTE_SIZE + 4);
        page.color(GRAY);
        page.text(MARGIN, page.y - NOTE_SIZE, fitText(block.text, USABLE_W, NOTE_SIZE), NOTE_SIZE, 'F1');
        page.y -= NOTE_SIZE + 6;
        break;
      }
      case 'kpiRow': {
        const h = kpiRowHeight();
        breakIfNeeded(h);
        const n = Math.max(1, block.kpis.length);
        const gap = 8;
        const cardW = (USABLE_W - gap * (n - 1)) / n;
        block.kpis.forEach((kpi, i) => {
          const x = MARGIN + i * (cardW + gap);
          const yTop = page.y;
          const border = hexToRgb(kpi.color);
          page.rect(x, yTop, cardW, h, null, border, 1.2);
          const pad = 8;
          const tx = x + pad;
          const tw = cardW - 2 * pad;
          let cy = yTop - pad;
          page.cellText(tx, cy, tw, KPI_LABEL_SIZE + 2, kpi.label, KPI_LABEL_SIZE, false, 'left', GRAY);
          cy -= KPI_LABEL_SIZE + 6;
          page.cellText(tx, cy, tw, KPI_VALUE_SIZE + 4, kpi.value, KPI_VALUE_SIZE, true, 'left', border);
          cy -= KPI_VALUE_SIZE + 8;
          if (kpi.deltaText) {
            page.cellText(tx, cy, tw, KPI_SUB_SIZE + 2, kpi.deltaText, KPI_SUB_SIZE, true, 'left', kpi.deltaColor ? hexToRgb(kpi.deltaColor) : GRAY);
            cy -= KPI_SUB_SIZE + 4;
          }
          if (kpi.targetText) {
            page.cellText(tx, cy, tw, KPI_SUB_SIZE, kpi.targetText, KPI_SUB_SIZE, false, 'left', GRAY);
          }
        });
        page.y -= h + 10;
        break;
      }
      case 'table': {
        const ncols = Math.max(block.headers.length, ...block.rows.map((r) => r.length), 1);
        if (ncols === 0) break;
        const colW = USABLE_W / ncols;
        const headers: ReportPdfCell[] = block.headers.length > 0
          ? block.headers
          : Array.from({ length: ncols }, () => ({ text: '' }));
        const normRows = block.rows.map((r) =>
          Array.from({ length: ncols }, (_, i) => r[i] ?? { text: '' }),
        );
        // Emit the header, then rows; split across pages repeating the header.
        // At least one row is emitted per page so the loop always terminates.
        let first = true;
        let ri = 0;
        while (ri < normRows.length || first) {
          if (first) {
            if (page.y - TABLE_ROW_H < BOTTOM_Y && page.y < TOP_Y) newPage();
            drawTableHeader(page, headers, colW);
            first = false;
          }
          let drew = 0;
          while (ri < normRows.length && (page.y - TABLE_ROW_H >= BOTTOM_Y || drew === 0)) {
            drawTableRow(page, normRows[ri], colW);
            ri += 1;
            drew += 1;
          }
          if (ri < normRows.length) {
            newPage();
            first = true; // repeat the header on the new page
          } else {
            break;
          }
        }
        page.y -= 10;
        break;
      }
      case 'image': {
        const dh = imageDrawHeight(block.jpeg);
        const need = dh + (block.caption ? CAPTION_SIZE + 6 : 0);
        breakIfNeeded(need);
        const drawn = page.placeImage(block.jpeg, MARGIN, page.y, USABLE_W, TOP_Y - BOTTOM_Y);
        page.y -= drawn + 4;
        if (block.caption) {
          page.color(GRAY);
          page.text(MARGIN, page.y - CAPTION_SIZE, fitText(block.caption, USABLE_W, CAPTION_SIZE), CAPTION_SIZE, 'F1');
          page.y -= CAPTION_SIZE + 10;
        } else {
          page.y -= 6;
        }
        break;
      }
    }
  }

  finished.push(page);
  const total = finished.length;
  const generic = finished.map((p, i) => p.toGenericPage(i + 1, total));
  return renderGenericPdfDocument(generic, {
    title: input.title,
    created: input.created,
  });
}
