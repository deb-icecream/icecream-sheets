/**
 * Native cell-style round-trip (stylesXml.ts) — defect D4.
 *
 * SheetJS CE cannot write fonts/fills/borders, so the adapter injects
 * SheetData.styles into xl/styles.xml + worksheet `s` attributes at the
 * OOXML level and parses them back on read. These tests pin: bold +
 * number format (the exact D4 scenario), the other ribbon format fields,
 * empty-cell materialization without phantom values, composition with
 * the number-format (cell.z) path and with protection injection, and
 * import of a hand-built styled package.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { XlsxAdapter } from '../src/index.js';
import type { WorkbookData } from '@icecream-sheets/engine';

function stylesXmlOf(bytes: Uint8Array): string {
  const files = unzipSync(bytes.slice());
  return new TextDecoder().decode(files['xl/styles.xml']!);
}

describe('XlsxAdapter cell styles (D4)', () => {
  it('round-trips bold + Percentage on a valued cell (the D4 scenario)', () => {
    const adapter = new XlsxAdapter();
    const data: WorkbookData = {
      sheets: [
        {
          name: 'S',
          rows: [[0.1667]],
          styles: { '0:0': { bold: true, numberFormatCode: '0.00%' } },
        },
      ],
      metadata: {},
    };
    const bytes = adapter.write(data);
    // Raw proof: a bold font exists in styles.xml.
    expect(stylesXmlOf(bytes)).toContain('<b/>');
    const back = adapter.read(bytes);
    expect(back.sheets[0]!.styles?.['0:0']).toEqual({ bold: true, numberFormatCode: '0.00%' });
    // The number-format channel agrees.
    expect(back.sheets[0]!.formats?.['0:0']).toBe('0.00%');
    expect(back.sheets[0]!.rows[0]![0]).toBe(0.1667);
  });

  it('round-trips italic/underline/font size/font color/fill/alignment/borders', () => {
    const adapter = new XlsxAdapter();
    const style = {
      italic: true,
      underline: true as const,
      fontSize: 14,
      fontName: 'Georgia',
      fontColor: '#FF0000',
      fillColor: '#FFFF00',
      hAlign: 'center' as const,
      vAlign: 'middle' as const,
      wrapText: true,
      borders: {
        top: { style: 'thin' as const, color: '#000000' },
        bottom: { style: 'double' as const, color: '#305496' },
      },
    };
    const bytes = adapter.write({
      sheets: [{ name: 'S', rows: [['x']], styles: { '0:0': style } }],
      metadata: {},
    });
    const back = adapter.read(bytes);
    expect(back.sheets[0]!.styles?.['0:0']).toEqual(style);
  });

  it('materializes a styled EMPTY cell without inventing a value', () => {
    const adapter = new XlsxAdapter();
    const bytes = adapter.write({
      sheets: [
        {
          name: 'S',
          rows: [[1, null]],
          styles: { '0:1': { bold: true } },
          formats: { '0:1': '0.00%' },
        },
      ],
      metadata: {},
    });
    const back = adapter.read(bytes);
    expect(back.sheets[0]!.styles?.['0:1']?.bold).toBe(true);
    // No phantom 0: the cell still reads back empty.
    expect(back.sheets[0]!.rows[0]![1]).toBeNull();
  });

  it('keeps SheetJS number formats on cells without a full style', () => {
    const adapter = new XlsxAdapter();
    const bytes = adapter.write({
      sheets: [
        {
          name: 'S',
          rows: [[0.5, 0.25]],
          formats: { '0:0': '0.00%' },
          styles: { '0:1': { bold: true, numberFormatCode: '#,##0.00' } },
        },
      ],
      metadata: {},
    });
    const back = adapter.read(bytes);
    expect(back.sheets[0]!.formats?.['0:0']).toBe('0.00%');
    expect(back.sheets[0]!.styles?.['0:1']).toEqual({ bold: true, numberFormatCode: '#,##0.00' });
  });

  it('preserves an imported style the save does not touch', () => {
    const adapter = new XlsxAdapter();
    const first = adapter.write({
      sheets: [{ name: 'S', rows: [[1, 2]], styles: { '0:0': { bold: true, fillColor: '#C6EFCE' } } }],
      metadata: {},
    });
    const imported = adapter.read(first);
    // Second save carries the imported styles forward (as the app does by
    // seeding its format store from them) plus one new style.
    const second = adapter.write({
      sheets: [
        {
          name: 'S',
          rows: imported.sheets[0]!.rows,
          styles: { ...imported.sheets[0]!.styles, '0:1': { italic: true } },
        },
      ],
      metadata: {},
    });
    const back = adapter.read(second);
    expect(back.sheets[0]!.styles?.['0:0']).toEqual({ bold: true, fillColor: '#C6EFCE' });
    expect(back.sheets[0]!.styles?.['0:1']).toEqual({ italic: true });
  });

  it('imports styles from a hand-built package (foreign producer shape)', () => {
    const enc = new TextEncoder();
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      ),
      '_rels/.rels': enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      'xl/workbook.xml': enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
      'xl/styles.xml': enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="10" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>`,
      ),
      'xl/worksheets/sheet1.xml': enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>0.5</v></c></row></sheetData></worksheet>`,
      ),
    };
    const bytes = zipSync(files);
    const back = new XlsxAdapter().read(bytes);
    expect(back.sheets[0]!.styles?.['0:0']).toEqual({ bold: true, numberFormatCode: '0.00%' });
  });
});
