/**
 * Native Download-as-PDF (design-docs/print-and-page-layout.md §3).
 *
 * Download-as-PDF is the single print path. This module renders paginated
 * sheet content to real PDF bytes — no window.print(), no browser involved.
 * It is pure TypeScript with zero dependencies, so it runs identically in
 * the browser bundle, Node, and the service boundary.
 *
 * PDF 1.4, base-14 fonts (Helvetica / Helvetica-Bold, WinAnsi encoding),
 * deterministic output: the same input renders byte-identical PDF (the
 * CreationDate is a fixed constant unless the caller overrides it).
 *
 * Text measurement uses the published Adobe Helvetica width table, so
 * ellipsis clipping is exact and deterministic.
 */

import {
  paginateSheet,
  PX_PER_INCH,
  type PaginatedPage,
  type PrintPageSetup,
  type PrintSnapshot,
  type PageOrientation,
} from './pagination.js';
import { expandHFCodes } from './headerFooter.js';
import type { PageBreaks } from './pageBreaks.js';

// ---------------------------------------------------------------------------
// Helvetica metrics (Adobe standard widths, units per 1000, ASCII 32–126)
// ---------------------------------------------------------------------------

const GLYPHS = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];

const widthByChar = new Map<string, number>();
for (let i = 0; i < GLYPHS.length; i++) widthByChar.set(GLYPHS[i], WIDTHS[i]);

/** Width of one character in units-per-1000 (fallback 556 = '?'). */
function charWidthUnits(ch: string): number {
  return widthByChar.get(ch) ?? 556;
}

/** Text width in points at the given font size. Non-WinAnsi chars count as '?'. */
export function measureTextPt(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    units += charWidthUnits(code > 255 ? '?' : ch);
  }
  return (units / 1000) * fontSize;
}

/**
 * Clip text to fit `maxWidthPt`, appending '…' when truncated.
 * Deterministic: pure function of (text, width, size).
 */
export function fitText(text: string, maxWidthPt: number, fontSize: number): string {
  if (measureTextPt(text, fontSize) <= maxWidthPt) return text;
  const ell = '…';
  const ellW = measureTextPt(ell, fontSize);
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const w = measureTextPt(text.slice(0, mid), fontSize) + ellW;
    if (w <= maxWidthPt) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(0, Math.max(0, lo - 1)) + ell;
}

// ---------------------------------------------------------------------------
// PDF string encoding (WinAnsi)
// ---------------------------------------------------------------------------

/** Encode a JS string as a PDF literal string (WinAnsi; CJK+ → '?'). */
export function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (code === 0x5c) out += '\\\\';
    else if (code === 0x28) out += '\\(';
    else if (code === 0x29) out += '\\)';
    else if (code === 0x0d || code === 0x0a) out += ' ';
    else if (code > 255) out += '?';
    else out += String.fromCharCode(code);
  }
  return out + ')';
}

/** Fixed default CreationDate → byte-identical output for identical input. */
export const DEFAULT_PDF_CREATED = 'D:20260101000000Z';

function fmt(n: number): string {
  // Two decimals, trimmed — deterministic float formatting.
  const s = n.toFixed(2);
  return s.replace(/\.?0+$/, '') || '0';
}

/** Deterministic number formatting for PDF content streams (2 decimals, trimmed). */
export function pdfNum(n: number): string {
  return fmt(n);
}

/**
 * Latin-1 encode: every char becomes exactly one byte (charCode & 0xff).
 * All PDF assembly strings are ASCII or pdfString() output (≤ U+00FF by
 * construction), so this is exact — TextEncoder (UTF-8) would corrupt
 * WinAnsi bytes ≥ 0x80 and desync the xref offsets.
 */
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

export interface PdfPageInput {
  sheet: string;
  pageNumber: number;
  totalPages: number;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  titleRows: { startRow: number; endRow: number } | null;
  titleCols: { startCol: number; endCol: number } | null;
  colWidth: (col: number) => number;
  rowHeight: (row: number) => number;
  /** Display text of one cell. */
  cellText: (row: number, col: number) => string;
}

export interface RenderPdfOptions {
  orientation: PageOrientation;
  /** Paper size key or explicit inches. */
  paper: { w: number; h: number };
  margins: { top: number; right: number; bottom: number; left: number };
  /** Print scaling percent (10–400). */
  scale: number;
  header: string;
  footer: string;
  fileName: string;
  /** Cell font size in points (default 10). */
  fontSize?: number;
  /** Header/footer font size in points (default 9). */
  headerFontSize?: number;
  title?: string;
  author?: string;
  /** PDF CreationDate string; defaults to a fixed constant (deterministic). */
  created?: string;
  /** Fixed date/time text for &D / &T codes (default: fixed constant). */
  dateText?: string;
  timeText?: string;
}

const PT_PER_IN = 72;

/** Points per content px at the given scale percent. */
function ptPerPx(scale: number): number {
  return (scale / 100) * (PT_PER_IN / PX_PER_INCH);
}

/** Build the content stream for one page. */
function pageContent(page: PdfPageInput, opts: RenderPdfOptions): string {
  const fontSize = opts.fontSize ?? 10;
  const headerSize = opts.headerFontSize ?? 9;
  const ppp = ptPerPx(Math.min(400, Math.max(10, opts.scale)));
  const pageW = (opts.orientation === 'portrait' ? opts.paper.w : opts.paper.h) * PT_PER_IN;
  const pageH = (opts.orientation === 'portrait' ? opts.paper.h : opts.paper.w) * PT_PER_IN;
  const mL = opts.margins.left * PT_PER_IN;
  const mR = opts.margins.right * PT_PER_IN;
  const mT = opts.margins.top * PT_PER_IN;
  const mB = opts.margins.bottom * PT_PER_IN;

  const parts: string[] = [];
  // Fixed date for &D/&T keeps output deterministic unless overridden.
  const hfDate = new Date(`${opts.dateText ?? '2026-01-01'}T${opts.timeText ?? '00:00'}:00Z`);
  const hfCtx = {
    page: page.pageNumber,
    pages: page.totalPages,
    date: hfDate,
    fileName: opts.fileName,
    sheetName: page.sheet,
  };

  // Header / footer (centered in the margin band, codes expanded).
  const drawCentered = (text: string, y: number, size: number, font: string) => {
    if (!text) return;
    const w = measureTextPt(text, size);
    const x = (pageW - w) / 2;
    parts.push(`BT /${font} ${fmt(size)} Tf 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm ${pdfString(text)} Tj ET`);
  };
  drawCentered(
    expandHFCodes(opts.header, hfCtx),
    pageH - mT / 2 + headerSize * 0.35,
    headerSize,
    'F1',
  );
  drawCentered(
    expandHFCodes(opts.footer, hfCtx),
    mB / 2 + headerSize * 0.35,
    headerSize,
    'F1',
  );

  // Column x-edges: title cols first, then the page's own cols.
  const colEdges: number[] = [mL];
  const pushCols = (a: number, b: number) => {
    for (let c = a; c <= b; c++) colEdges.push(colEdges[colEdges.length - 1] + page.colWidth(c) * ppp);
  };
  const titleColCount = page.titleCols ? page.titleCols.endCol - page.titleCols.startCol + 1 : 0;
  if (page.titleCols) pushCols(page.titleCols.startCol, page.titleCols.endCol);
  pushCols(page.startCol, page.endCol);

  // Row y-tops: title rows first, then the page's own rows (y grows upward).
  const contentTop = pageH - mT;
  const rowTops: number[] = [contentTop];
  const pushRows = (a: number, b: number) => {
    for (let r = a; r <= b; r++) rowTops.push(rowTops[rowTops.length - 1] - page.rowHeight(r) * ppp);
  };
  const titleRowCount = page.titleRows ? page.titleRows.endRow - page.titleRows.startRow + 1 : 0;
  if (page.titleRows) pushRows(page.titleRows.startRow, page.titleRows.endRow);
  pushRows(page.startRow, page.endRow);

  const colIndex = (i: number): number =>
    i < titleColCount && page.titleCols
      ? page.titleCols.startCol + i
      : page.startCol + (i - titleColCount);
  const rowIndex = (i: number): number =>
    i < titleRowCount && page.titleRows
      ? page.titleRows.startRow + i
      : page.startRow + (i - titleRowCount);
  const isTitleCell = (ci: number, ri: number): boolean => ci < titleColCount || ri < titleRowCount;

  const nCols = colEdges.length - 1;
  const nRows = rowTops.length - 1;
  for (let ri = 0; ri < nRows; ri++) {
    const yTop = rowTops[ri];
    const yBot = rowTops[ri + 1];
    const h = yTop - yBot;
    if (h <= 0) continue;
    for (let ci = 0; ci < nCols; ci++) {
      const x = colEdges[ci];
      const w = colEdges[ci + 1] - x;
      if (w <= 0) continue;
      const row = rowIndex(ri);
      const col = colIndex(ci);
      // Title cells get a light-gray fill; content cells are white.
      if (isTitleCell(ci, ri)) {
        parts.push(`${fmt(0.93)} ${fmt(0.93)} ${fmt(0.93)} rg ${fmt(x)} ${fmt(yBot)} ${fmt(w)} ${fmt(h)} re f`);
      }
      parts.push(`0.75 0.75 0.75 RG ${fmt(0.5)} w ${fmt(x)} ${fmt(yBot)} ${fmt(w)} ${fmt(h)} re S`);
      const raw = page.cellText(row, col);
      if (raw !== '') {
        const text = fitText(raw, Math.max(0, w - 4), fontSize);
        // Clip to the cell rect, then draw left-aligned with 2pt padding.
        parts.push(
          `q ${fmt(x)} ${fmt(yBot)} ${fmt(w)} ${fmt(h)} re W n ` +
            `BT /F1 ${fmt(fontSize)} Tf 1 0 0 1 ${fmt(x + 2)} ${fmt(yBot + (h - fontSize) / 2)} Tm ` +
            `${pdfString(text)} Tj ET Q`,
        );
      }
    }
  }
  return parts.join('\n');
}

/**
 * Render pages to PDF bytes. Deterministic: identical inputs → identical
 * bytes (CreationDate defaults to a fixed constant).
 */
export function renderPdfDocument(pages: PdfPageInput[], opts: RenderPdfOptions): Uint8Array {
  const streamBytesList = pages.map((p) => latin1(pageContent(p, opts)));

  // Object numbering: 1 catalog, 2 pages, 3/4 fonts, then page+content pairs.
  // Each entry is { head, stream?, tail }: stream bytes are spliced raw so
  // WinAnsi bytes survive intact (no UTF-8 mangling).
  interface ObjParts {
    head: string;
    stream?: Uint8Array;
    tail: string;
  }
  const objects: ObjParts[] = [];
  const pageObjNums: number[] = [];
  let next = 5;
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(next);
    next += 2;
  }
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  const text = (head: string): ObjParts => ({ head, tail: '\n' });
  objects.push(text(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`));
  objects.push(text(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj`));
  objects.push(text(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj`));
  objects.push(text(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj`));

  const pageW = (opts.orientation === 'portrait' ? opts.paper.w : opts.paper.h) * PT_PER_IN;
  const pageH = (opts.orientation === 'portrait' ? opts.paper.h : opts.paper.w) * PT_PER_IN;
  for (let i = 0; i < pages.length; i++) {
    const pageNum = pageObjNums[i];
    const contentNum = pageNum + 1;
    const stream = streamBytesList[i];
    objects.push(
      text(
        `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pageW)} ${fmt(pageH)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj`,
      ),
    );
    objects.push({
      head: `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n`,
      stream,
      tail: `\nendstream\nendobj\n`,
    });
  }

  const info: string[] = [];
  if (opts.title) info.push(`/Title ${pdfString(opts.title)}`);
  if (opts.author) info.push(`/Author ${pdfString(opts.author)}`);
  info.push(`/Creator ${pdfString('Icecream Sheets')}`);
  info.push(`/Producer ${pdfString('Icecream Sheets native PDF')}`);
  info.push(`/CreationDate ${pdfString(opts.created ?? DEFAULT_PDF_CREATED)}`);
  const infoNum = next;
  objects.push(text(`${infoNum} 0 obj\n<< ${info.join(' ')} >>\nendobj`));

  // Assemble as bytes: the header comment carries the conventional >127 bytes.
  const chunks: Uint8Array[] = [
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  ];
  let byteLen = chunks[0].length;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(byteLen);
    const headB = latin1(obj.head);
    chunks.push(headB);
    byteLen += headB.length;
    if (obj.stream) {
      chunks.push(obj.stream);
      byteLen += obj.stream.length;
    }
    const tailB = latin1(obj.tail);
    chunks.push(tailB);
    byteLen += tailB.length;
  }
  const xrefPos = byteLen;
  const totalObjs = next; // highest object number
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  // objects[] is already in numeric order (1,2,3,4, page/content pairs, info).
  for (let i = 0; i < objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R /Info ${infoNum} 0 R >>\n` +
    `startxref\n${xrefPos}\n%%EOF`;
  chunks.push(latin1(xref + trailer));
  return concat(chunks);
}

// ---------------------------------------------------------------------------
// High-level: snapshot → paginate → PDF
// ---------------------------------------------------------------------------

export interface SheetPdfInput {
  snapshot: PrintSnapshot;
  setup: PrintPageSetup;
  breaks?: PageBreaks;
  /** Display text of one cell. */
  cellText: (row: number, col: number) => string;
  fileName: string;
  title?: string;
  author?: string;
  /** Fixed CreationDate (default: constant → deterministic). */
  created?: string;
}

const SETUP_PAPER: Record<string, { w: number; h: number }> = {
  letter: { w: 8.5, h: 11 },
  a4: { w: 8.27, h: 11.69 },
  legal: { w: 8.5, h: 14 },
  a3: { w: 11.69, h: 16.54 },
};

/**
 * Render one sheet to PDF bytes: paginate the snapshot with the setup and
 * manual breaks, then render every page natively. Returns an empty PDF
 * (zero pages) when the sheet has no printable content.
 */
export function renderSheetPdf(input: SheetPdfInput): Uint8Array {
  const pages = paginateSheet(input.snapshot, input.setup, input.breaks ?? { rows: [], cols: [] });
  const s = input.setup;
  const paper =
    s.paperSize === 'custom' && s.customSize
      ? { w: s.customSize.w, h: s.customSize.h }
      : (SETUP_PAPER[s.paperSize] ?? SETUP_PAPER.letter);
  const pdfPages: PdfPageInput[] = pages.map((p: PaginatedPage) => ({
    sheet: p.sheet,
    pageNumber: p.pageNumber,
    totalPages: pages.length,
    startRow: p.startRow,
    endRow: p.endRow,
    startCol: p.startCol,
    endCol: p.endCol,
    titleRows: p.titleRows,
    titleCols: p.titleCols,
    colWidth: input.snapshot.colWidth,
    rowHeight: input.snapshot.rowHeight,
    cellText: input.cellText,
  }));
  return renderPdfDocument(pdfPages, {
    orientation: s.orientation,
    paper,
    margins: s.margins,
    scale: s.scale,
    header: s.header,
    footer: s.footer,
    fileName: input.fileName,
    title: input.title ?? `${input.snapshot.sheet} — Icecream Sheets`,
    author: input.author,
    created: input.created,
  });
}

// ---------------------------------------------------------------------------
// JPEG image support (for report charts embedded as XObjects)
//
// Charts are captured client-side as JPEG data URLs (canvas → toDataURL,
// SVG → rasterized through a canvas). The raw JPEG bitstream embeds
// verbatim with /DCTDecode, so no decompression is needed — only the SOF
// marker is scanned for dimensions and component count.
// ---------------------------------------------------------------------------

/** Parse JPEG dimensions from the SOF0/SOF1/SOF2 marker. Pure; throws on invalid input. */
export function parseJpegDimensions(jpeg: Uint8Array): { width: number; height: number; components: 1 | 3 } {
  const fail = (why: string): never => {
    throw new Error(`invalid JPEG: ${why}`);
  };
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail('missing SOI marker');
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) fail(`expected marker at offset ${i}`);
    const marker = jpeg[i + 1];
    i += 2;
    if (marker === 0xd8 || marker === 0xd9) continue; // SOI / EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone
    if (i + 2 > jpeg.length) fail('truncated segment header');
    const len = (jpeg[i] << 8) | jpeg[i + 1];
    if (len < 2 || i + len > jpeg.length) fail('truncated segment');
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      // SOF: [len(2)] precision(1) height(2) width(2) components(1)
      if (len < 8) fail('truncated SOF');
      const height = (jpeg[i + 3] << 8) | jpeg[i + 4];
      const width = (jpeg[i + 5] << 8) | jpeg[i + 6];
      const components = jpeg[i + 7];
      if (width <= 0 || height <= 0) fail('zero dimensions');
      if (components !== 1 && components !== 3) fail(`unsupported component count ${components}`);
      return { width, height, components: components as 1 | 3 };
    }
    i += len;
  }
  fail('no SOF marker found');
  throw new Error('unreachable');
}

/** One JPEG image XObject on a generic page. `name` must be unique per page. */
export interface PdfImageXObject {
  /** Resource name, e.g. 'Im1'. */
  name: string;
  /** Raw JPEG bytes (embedded verbatim with /DCTDecode). */
  jpeg: Uint8Array;
  width: number;
  height: number;
  /** 1 = DeviceGray, 3 = DeviceRGB. */
  components: 1 | 3;
}

/** A page of arbitrary vector content plus optional JPEG XObjects. */
export interface PdfGenericPage {
  widthPt: number;
  heightPt: number;
  /** Content-stream operators (text must already be WinAnsi-safe via pdfString). */
  content: string;
  images: PdfImageXObject[];
}

export interface GenericPdfOptions {
  title?: string;
  author?: string;
  /** PDF CreationDate string; defaults to a fixed constant (deterministic). */
  created?: string;
}

/**
 * Assemble a PDF 1.4 document from generic pages. Object numbering: 1
 * catalog, 2 pages, 3/4 fonts (Helvetica / Helvetica-Bold, WinAnsi), then
 * per page: page object, content stream, image XObjects. Deterministic:
 * identical inputs → identical bytes.
 */
export function renderGenericPdfDocument(pages: PdfGenericPage[], opts: GenericPdfOptions = {}): Uint8Array {
  interface ObjParts {
    head: string;
    stream?: Uint8Array;
    tail: string;
  }
  const text = (head: string): ObjParts => ({ head, tail: '\n' });
  const objects: ObjParts[] = [];
  const pageObjNums: number[] = [];
  let next = 5;
  const imageObjNums = new Map<PdfImageXObject, number>();
  for (const page of pages) {
    pageObjNums.push(next);
    next += 2;
    for (const img of page.images) {
      imageObjNums.set(img, next);
      next += 1;
    }
  }
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  objects.push(text(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`));
  objects.push(text(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj`));
  objects.push(text(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj`));
  objects.push(text(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj`));

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageNum = pageObjNums[i];
    const contentNum = pageNum + 1;
    const xobjEntries = page.images
      .map((img) => `/${img.name} ${imageObjNums.get(img)} 0 R`)
      .join(' ');
    const resources =
      `/Font << /F1 3 0 R /F2 4 0 R >>` + (xobjEntries ? ` /XObject << ${xobjEntries} >>` : '');
    objects.push(
      text(
        `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(page.widthPt)} ${fmt(page.heightPt)}] ` +
          `/Resources << ${resources} >> /Contents ${contentNum} 0 R >>\nendobj`,
      ),
    );
    const stream = latin1(page.content);
    objects.push({
      head: `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n`,
      stream,
      tail: `\nendstream\nendobj\n`,
    });
    for (const img of page.images) {
      const imgNum = imageObjNums.get(img)!;
      const colorSpace = img.components === 3 ? '/DeviceRGB' : '/DeviceGray';
      objects.push({
        head:
          `${imgNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`,
        stream: img.jpeg,
        tail: `\nendstream\nendobj\n`,
      });
    }
  }

  const info: string[] = [];
  if (opts.title) info.push(`/Title ${pdfString(opts.title)}`);
  if (opts.author) info.push(`/Author ${pdfString(opts.author)}`);
  info.push(`/Creator ${pdfString('Icecream Sheets')}`);
  info.push(`/Producer ${pdfString('Icecream Sheets native PDF')}`);
  info.push(`/CreationDate ${pdfString(opts.created ?? DEFAULT_PDF_CREATED)}`);
  const infoNum = next;
  objects.push(text(`${infoNum} 0 obj\n<< ${info.join(' ')} >>\nendobj`));

  const chunks: Uint8Array[] = [
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  ];
  let byteLen = chunks[0].length;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(byteLen);
    const headB = latin1(obj.head);
    chunks.push(headB);
    byteLen += headB.length;
    if (obj.stream) {
      chunks.push(obj.stream);
      byteLen += obj.stream.length;
    }
    const tailB = latin1(obj.tail);
    chunks.push(tailB);
    byteLen += tailB.length;
  }
  const xrefPos = byteLen;
  const totalObjs = next; // highest object number
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R /Info ${infoNum} 0 R >>\n` +
    `startxref\n${xrefPos}\n%%EOF`;
  chunks.push(latin1(xref + trailer));
  return concat(chunks);
}
