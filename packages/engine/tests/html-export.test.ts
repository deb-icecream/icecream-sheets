/**
 * HTML download adapter tests (src/html-export.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  HtmlAdapter,
  renderWorkbookHtml,
  workbookToHtmlTables,
} from '../src/html-export.js';
import type { WorkbookData } from '../src/storage.js';

function wb(sheets: { name: string; rows: (string | number | boolean | null)[][] }[]): WorkbookData {
  return {
    sheets: sheets.map((s) => ({ name: s.name, rows: s.rows })),
    metadata: {},
  };
}

const SAMPLE = wb([
  {
    name: 'Sales',
    rows: [
      ['Item', 'Qty'],
      ['Apples', 10],
      ['Oranges', 20],
    ],
  },
  { name: 'Empty', rows: [] },
]);

describe('workbookToHtmlTables', () => {
  it('trims trailing blank rows and columns', () => {
    const [t] = workbookToHtmlTables(
      wb([{ name: 'S', rows: [['a', ''], [null, null], ['', '']] }]),
    );
    expect(t!.header).toEqual(['', 'A']);
    expect(t!.rows).toEqual([['1', 'a']]);
    expect(t!.capped).toBe(false);
  });

  it('caps pathological dimensions', () => {
    const rows: (string | number | boolean | null)[][] = Array.from({ length: 10001 }, () => ['x']);
    const [t] = workbookToHtmlTables(wb([{ name: 'S', rows }]));
    expect(t!.capped).toBe(true);
    expect(t!.rows.length).toBe(10000);
  });
});

describe('renderWorkbookHtml', () => {
  it('renders a standalone document with one table per sheet', () => {
    const html = renderWorkbookHtml(SAMPLE, 'My Workbook');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>My Workbook</title>');
    expect(html).toContain('<h2 id="sheet-0">Sales</h2>');
    expect(html).toContain('<td>Apples</td>');
    expect(html).toContain('<td>10</td>');
    expect(html).toContain('(empty sheet)');
    // Table of contents links the sheets.
    expect(html).toContain('href="#sheet-0"');
  });

  it('escapes HTML in cell text and sheet names', () => {
    const html = renderWorkbookHtml(
      wb([{ name: '<b>Bold</b>', rows: [['<script>alert(1)</script>']] }]),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Bold&lt;/b&gt;');
  });

  it('renders booleans Excel-style', () => {
    const html = renderWorkbookHtml(wb([{ name: 'S', rows: [[true, false]] }]));
    expect(html).toContain('<td>TRUE</td>');
    expect(html).toContain('<td>FALSE</td>');
  });
});

describe('HtmlAdapter', () => {
  it('is write-only', () => {
    const adapter = new HtmlAdapter();
    expect(adapter.name).toBe('html');
    expect(adapter.capabilities.readable).toBe(false);
    expect(adapter.capabilities.writable).toBe(true);
    expect(() => adapter.read(new Uint8Array())).toThrow('write-only');
  });

  it('writes UTF-8 HTML bytes', () => {
    const bytes = new HtmlAdapter().write(SAMPLE);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('<!DOCTYPE html>');
    expect(text).toContain('Sales');
  });
});
