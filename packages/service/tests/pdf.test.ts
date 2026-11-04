import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINT_SETUP,
  type PrintSnapshot,
} from '../src/pagination.js';
import {
  fitText,
  measureTextPt,
  renderPdfDocument,
  renderSheetPdf,
  type PdfPageInput,
} from '../src/pdf.js';

function gridSnapshot(): PrintSnapshot {
  return {
    sheet: 'Sheet1',
    used: { startRow: 0, endRow: 3, startCol: 0, endCol: 2 },
    rowHeight: () => 24,
    colWidth: () => 96,
  };
}

const baseOpts = {
  orientation: 'portrait' as const,
  paper: { w: 8.5, h: 11 },
  margins: { top: 0.75, right: 0.7, bottom: 0.75, left: 0.7 },
  scale: 100,
  header: '',
  footer: '',
  fileName: 'test.xlsx',
};

function pdfPageInput(): PdfPageInput {
  return {
    sheet: 'Sheet1',
    pageNumber: 1,
    totalPages: 1,
    startRow: 0,
    endRow: 3,
    startCol: 0,
    endCol: 2,
    titleRows: null,
    titleCols: null,
    colWidth: () => 96,
    rowHeight: () => 24,
    cellText: (r, c) => `R${r + 1}C${c + 1}`,
  };
}

/** Parse the xref table and return (objectNumber -> byteOffset). */
function parseXref(bytes: Uint8Array): Map<number, number> {
  const text = Array.from(bytes.slice(0, 40000))
    .map((b) => String.fromCharCode(b))
    .join('');
  const xrefAt = text.indexOf('xref\n');
  expect(xrefAt).toBeGreaterThanOrEqual(0);
  const lines = text.slice(xrefAt).split('\n');
  // lines[0] = 'xref', lines[1] = '0 N'
  const count = parseInt(lines[1].split(' ')[1], 10);
  const map = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const line = lines[2 + i];
    const offset = parseInt(line.slice(0, 10), 10);
    map.set(i, offset);
  }
  return map;
}

function bytesToAscii(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
}

describe('renderPdfDocument', () => {
  it('produces a well-formed PDF: header, xref offsets, trailer', () => {
    const bytes = renderPdfDocument([pdfPageInput()], baseOpts);
    const ascii = bytesToAscii(bytes);
    expect(ascii.startsWith('%PDF-1.4')).toBe(true);
    expect(ascii).toContain('%%EOF');
    expect(ascii).toContain('/Type /Catalog');
    expect(ascii).toContain('/Count 1');

    // Every xref offset must point at "<n> 0 obj".
    const xref = parseXref(bytes);
    expect(xref.size).toBeGreaterThan(4);
    for (const [num, offset] of xref) {
      if (num === 0) continue; // free object
      const at = ascii.slice(offset, offset + 24);
      expect(at.startsWith(`${num} 0 obj`)).toBe(true);
    }
    // startxref must point at the xref table.
    const m = /startxref\n(\d+)\n%%EOF/.exec(ascii);
    expect(m).not.toBeNull();
    expect(ascii.slice(Number(m![1]), Number(m![1]) + 4)).toBe('xref');
  });

  it('is deterministic: identical input → byte-identical output', () => {
    const a = renderPdfDocument([pdfPageInput()], baseOpts);
    const b = renderPdfDocument([pdfPageInput()], baseOpts);
    expect(a).toEqual(b);
  });

  it('embeds cell text in the content stream', () => {
    const bytes = renderPdfDocument([pdfPageInput()], baseOpts);
    const ascii = bytesToAscii(bytes);
    expect(ascii).toContain('(R1C1)');
    expect(ascii).toContain('(R4C3)');
  });

  it('expands header/footer codes with page numbers', () => {
    const p1 = { ...pdfPageInput(), totalPages: 2 };
    const pages = [p1, { ...pdfPageInput(), pageNumber: 2, totalPages: 2 }];
    const bytes = renderPdfDocument(pages, {
      ...baseOpts,
      header: 'Report &A - page &P of &N',
      footer: '&F',
    });
    const ascii = bytesToAscii(bytes);
    expect(ascii).toContain('(Report Sheet1 - page 1 of 2)');
    expect(ascii).toContain('(Report Sheet1 - page 2 of 2)');
    expect(ascii).toContain('(test.xlsx)');
  });

  it('keeps WinAnsi bytes intact (é is one byte 0xE9)', () => {
    const bytes = renderPdfDocument(
      [{ ...pdfPageInput(), cellText: () => 'café' }],
      baseOpts,
    );
    // 'café' in WinAnsi: 63 61 66 E9 — NOT the UTF-8 two-byte sequence C3 A9.
    const ascii = bytesToAscii(bytes);
    expect(ascii).toContain('(caf\u00e9)');
    expect(ascii).not.toContain('caf\u00c3\u00a9');
  });

  it('replaces non-WinAnsi characters with ?', () => {
    const bytes = renderPdfDocument(
      [{ ...pdfPageInput(), cellText: () => '日本語' }],
      baseOpts,
    );
    const ascii = bytesToAscii(bytes);
    expect(ascii).toContain('(???)');
  });

  it('escapes parentheses and backslashes in strings', () => {
    const bytes = renderPdfDocument(
      [{ ...pdfPageInput(), cellText: () => 'a(b)\\c' }],
      baseOpts,
    );
    expect(bytesToAscii(bytes)).toContain('(a\\(b\\)\\\\c)');
  });

  it('renders an empty document (zero pages) without crashing', () => {
    const bytes = renderPdfDocument([], baseOpts);
    const ascii = bytesToAscii(bytes);
    expect(ascii).toContain('/Count 0');
    expect(ascii).toContain('%%EOF');
  });

  it('stream /Length matches the actual stream bytes', () => {
    const bytes = renderPdfDocument([pdfPageInput()], baseOpts);
    const ascii = bytesToAscii(bytes);
    const m = /(\d+) 0 obj\n<< \/Length (\d+) >>\nstream\n/.exec(ascii);
    expect(m).not.toBeNull();
    const declared = Number(m![2]);
    const streamStart = ascii.indexOf('stream\n', m!.index) + 'stream\n'.length;
    const streamEnd = ascii.indexOf('\nendstream', streamStart);
    expect(streamEnd - streamStart).toBe(declared);
  });
});

describe('renderSheetPdf', () => {
  it('paginates and renders a sheet end to end', () => {
    const bytes = renderSheetPdf({
      snapshot: gridSnapshot(),
      setup: { ...DEFAULT_PRINT_SETUP, footer: 'Page &P of &N' },
      cellText: (r, c) => `R${r + 1}C${c + 1}`,
      fileName: 's.xlsx',
    });
    const ascii = bytesToAscii(bytes);
    expect(ascii.startsWith('%PDF-1.4')).toBe(true);
    expect(ascii).toContain('(R1C1)');
    expect(ascii).toContain('(Page 1 of 1)');
  });

  it('honors manual breaks: one break → two pages', () => {
    const bytes = renderSheetPdf({
      snapshot: {
        ...gridSnapshot(),
        used: { startRow: 0, endRow: 20, startCol: 0, endCol: 2 },
      },
      setup: DEFAULT_PRINT_SETUP,
      breaks: { rows: [9], cols: [] },
      cellText: (r, c) => `${r},${c}`,
      fileName: 's.xlsx',
    });
    expect(bytesToAscii(bytes)).toContain('/Count 2');
  });

  it('is deterministic across runs', () => {
    const input = {
      snapshot: gridSnapshot(),
      setup: DEFAULT_PRINT_SETUP,
      cellText: (r: number, c: number) => `R${r + 1}C${c + 1}`,
      fileName: 's.xlsx',
    };
    expect(renderSheetPdf(input)).toEqual(renderSheetPdf(input));
  });
});

describe('measureTextPt / fitText', () => {
  it('measures Helvetica widths (A wider than i)', () => {
    expect(measureTextPt('A', 10)).toBeGreaterThan(measureTextPt('i', 10));
    expect(measureTextPt('A', 10)).toBeCloseTo(6.67, 2);
  });

  it('fitText clips with an ellipsis to the available width', () => {
    const full = measureTextPt('Hello world', 10);
    const clipped = fitText('Hello world', full / 2, 10);
    expect(clipped.endsWith('…')).toBe(true);
    expect(measureTextPt(clipped, 10)).toBeLessThanOrEqual(full / 2 + 0.01);
    expect(fitText('Hi', 1000, 10)).toBe('Hi');
  });
});
