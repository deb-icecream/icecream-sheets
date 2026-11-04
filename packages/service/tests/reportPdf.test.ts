/**
 * Tests for the native report PDF renderer (renderReportPdf) and the JPEG
 * dimension parser it relies on for chart image embedding.
 */
import { describe, expect, it } from 'vitest';
import {
  renderReportPdf,
  type RenderReportPdfInput,
  type ReportPdfBlock,
} from '../src/reportPdf.js';
import { parseJpegDimensions } from '../src/pdf.js';

/** Minimal JPEG: SOI + APP0 + SOF0 (3×2, grayscale) + EOI. Enough for the dimension parser. */
function tinyJpeg(width: number, height: number, components: 1 | 3): Uint8Array {
  const ncomp = components;
  const sofLen = 8 + 3 * ncomp;
  const bytes: number[] = [
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0, len 16
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, (sofLen >> 8) & 0xff, sofLen & 0xff, // SOF0
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    ncomp,
  ];
  for (let c = 1; c <= ncomp; c++) bytes.push(c, 0x11, 0x00);
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

function bytesToAscii(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
}

/** Parse the xref table and return (objectNumber -> byteOffset). */
function parseXref(bytes: Uint8Array): Map<number, number> {
  const text = bytesToAscii(bytes.slice(0, 200000));
  const xrefAt = text.indexOf('xref\n');
  expect(xrefAt).toBeGreaterThanOrEqual(0);
  const lines = text.slice(xrefAt).split('\n');
  const count = parseInt(lines[1].split(' ')[1], 10);
  const map = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    map.set(i, parseInt(lines[2 + i].slice(0, 10), 10));
  }
  return map;
}

function sampleInput(blocks: ReportPdfBlock[]): RenderReportPdfInput {
  return {
    title: 'Q3 Sales Report',
    meta: ['Data as of 2026-10-18', 'Slicers: Region: All'],
    blocks,
  };
}

describe('parseJpegDimensions', () => {
  it('reads dimensions and component count from SOF0', () => {
    expect(parseJpegDimensions(tinyJpeg(3, 2, 1))).toEqual({ width: 3, height: 2, components: 1 });
    expect(parseJpegDimensions(tinyJpeg(440, 300, 3))).toEqual({ width: 440, height: 300, components: 3 });
  });

  it('rejects non-JPEG input', () => {
    expect(() => parseJpegDimensions(new Uint8Array(0))).toThrow('missing SOI');
    expect(() => parseJpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow('missing SOI');
  });

  it('rejects JPEGs without an SOF marker', () => {
    expect(() => parseJpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrow('no SOF');
  });

  it('rejects unsupported component counts', () => {
    const bytes = tinyJpeg(2, 2, 1);
    bytes[bytes.length - 6] = 4; // patch the SOF component count to CMYK
    expect(() => parseJpegDimensions(bytes)).toThrow('unsupported component count 4');
  });
});

describe('renderReportPdf', () => {
  it('produces a well-formed PDF: header, xref offsets, trailer', () => {
    const bytes = renderReportPdf(
      sampleInput([
        { kind: 'heading', text: 'Revenue' },
        { kind: 'note', text: 'No data.' },
      ]),
    );
    const ascii = bytesToAscii(bytes);
    expect(ascii.startsWith('%PDF-1.4')).toBe(true);
    expect(ascii).toContain('%%EOF');
    expect(ascii).toContain('/Type /Catalog');
    expect(ascii).toContain('/Count 1');
    expect(ascii).toContain('(Q3 Sales Report)');
    const xref = parseXref(bytes);
    expect(xref.size).toBeGreaterThan(4);
    for (const [num, offset] of xref) {
      if (num === 0) continue;
      expect(ascii.slice(offset, offset + 24).startsWith(`${num} 0 obj`)).toBe(true);
    }
    const m = /startxref\n(\d+)\n%%EOF/.exec(ascii);
    expect(m).not.toBeNull();
    expect(ascii.slice(Number(m![1]), Number(m![1]) + 4)).toBe('xref');
  });

  it('is deterministic: identical input → byte-identical output', () => {
    const input = sampleInput([
      {
        kind: 'kpiRow',
        kpis: [
          { label: 'Revenue', value: '$1.2M', color: '#1a7f37', deltaText: '▲ $0.1M', deltaColor: '#1a7f37', targetText: 'Target: $1.0M' },
        ],
      },
    ]);
    expect(renderReportPdf(input)).toEqual(renderReportPdf(input));
  });

  it('renders every block kind without error', () => {
    const bytes = renderReportPdf(
      sampleInput([
        { kind: 'heading', text: 'Revenue' },
        {
          kind: 'kpiRow',
          kpis: [
            { label: 'Revenue', value: '$1.2M', color: '#1a7f37', deltaText: null, deltaColor: null, targetText: null },
            { label: 'Orders', value: '4,201', color: '#b7791f', deltaText: '▼ 3%', deltaColor: '#c0392b', targetText: 'Target: 5,000' },
          ],
        },
        {
          kind: 'table',
          headers: [{ text: 'Region', bold: true }, { text: 'Sales', bold: true, align: 'right' }],
          rows: [
            [{ text: 'North' }, { text: '120', align: 'right' }],
            [{ text: 'South', fill: '#fff2cc' }, { text: '95', align: 'right', fill: '#fff2cc' }],
          ],
        },
        { kind: 'image', jpeg: tinyJpeg(440, 300, 3), caption: 'Sales by region' },
        { kind: 'note', text: '⚠ Unknown binding "b2"' },
      ]),
    );
    const ascii = bytesToAscii(bytes);
    expect(ascii).toContain('(Revenue)');
    expect(ascii).toContain('($1.2M)');
    expect(ascii).toContain('(North)');
    expect(ascii).toContain('/Subtype /Image');
    expect(ascii).toContain('/Filter /DCTDecode');
    expect(ascii).toContain('/Width 440');
    expect(ascii).toContain('/Height 300');
    expect(ascii).toContain('/DeviceRGB');
    expect(ascii).toContain('Page 1 of 1');
  });

  it('splits long tables across pages and repeats the header', () => {
    const rows = Array.from({ length: 120 }, (_, i) => [{ text: `Row ${i + 1}` }, { text: String(i) }]);
    const bytes = renderReportPdf(
      sampleInput([
        {
          kind: 'table',
          headers: [{ text: 'Name', bold: true }, { text: 'Value', bold: true }],
          rows,
        },
      ]),
    );
    const ascii = bytesToAscii(bytes);
    const m = /\/Count (\d+)/.exec(ascii);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(1);
    // Header text appears once per page.
    expect(ascii.split('(Name)').length - 1).toBe(Number(m![1]));
    // All rows present.
    expect(ascii).toContain('(Row 1)');
    expect(ascii).toContain('(Row 120)');
    // Footer page numbers are sequential.
    for (let p = 1; p <= Number(m![1]); p++) {
      expect(ascii).toContain(`(Page ${p} of ${m![1]})`);
    }
  });

  it('renders an empty report as a single title page', () => {
    const bytes = renderReportPdf({ title: 'Empty', meta: [], blocks: [] });
    expect(bytesToAscii(bytes)).toContain('/Count 1');
  });

  it('tolerates malformed colors and empty tables', () => {
    const bytes = renderReportPdf(
      sampleInput([
        {
          kind: 'kpiRow',
          kpis: [{ label: 'X', value: '1', color: 'not-a-color', deltaText: null, deltaColor: null, targetText: null }],
        },
        { kind: 'table', headers: [], rows: [] },
      ]),
    );
    expect(bytesToAscii(bytes).startsWith('%PDF-1.4')).toBe(true);
  });

  it('clips overlong text with an ellipsis instead of overflowing', () => {
    const long = 'A'.repeat(500);
    const bytes = renderReportPdf(sampleInput([{ kind: 'note', text: long }]));
    const ascii = bytesToAscii(bytes);
    // '…' (U+2026) is outside WinAnsi → encoded as '?'.
    expect(ascii).toContain('?');
    expect(ascii).not.toContain(long);
  });
});
