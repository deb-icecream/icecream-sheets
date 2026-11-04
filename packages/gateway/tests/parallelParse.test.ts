/**
 * Parallel workbook parse (Cycle 10 Phase 4) — differential + timing tests.
 *
 * The fast path (zip-level split + per-sheet XML parse, worker pool or
 * inline) must produce WorkbookData identical to XlsxAdapter.read
 * (SheetJS) on the same bytes: sheets (rows incl. formula semantics,
 * formats, dimensions), defined names, metadata.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { parseWorkbookFast } from '../src/services/parallelParse.js';

// Same hand-built edge fixture as
// packages/xlsx-adapter/tests/fastSheetParse.test.ts: shared formulas,
// array formula, rich-text SST with phonetics, error/bool/inline cells,
// custom + built-in formats, defined names (global + sheet-scoped +
// _xlnm built-in), custom properties.
const SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:F6"/>
<cols><col min="1" max="1" width="15" customWidth="1"/><col min="3" max="3" hidden="1" width="0"/></cols>
<sheetData>
<row r="1" ht="20" customHeight="1">
<c r="A1" t="s"><v>0</v></c>
<c r="B1" s="1"><v>42</v></c>
<c r="C1" t="b"><v>1</v></c>
<c r="D1" t="e"><v>#REF!</v></c>
</row>
<row r="2" hidden="1">
<c r="A2"><f>SUM(B1,10)</f><v>52</v></c>
<c r="B2"><f>NOW()</f></c>
</row>
<row r="3">
<c r="A3" t="inlineStr"><is><t>inline</t></is></c>
<c r="B3"><f t="shared" si="0">A$1*2</f><v>2</v></c>
<c r="C3"><f t="shared" si="0"/><v>4</v></c>
</row>
<row r="4">
<c r="A4"><f t="array" ref="A4:A5">ROW(1:2)</f><v>1</v></c>
<c r="A5"><v>2</v></c>
</row>
<row r="6">
<c r="A6" t="str"><v>str cached</v></c>
</row>
</sheetData>
</worksheet>`;

function fixtureBytes(): Uint8Array {
  const enc = (s: string): Uint8Array => strToU8(s);
  return zipSync({
    '[Content_Types].xml': enc(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`,
    ),
    '_rels/.rels': enc(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': enc(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="MyRange">Sheet1!$A$1:$B$1</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Sheet1!$A$1</definedName><definedName name="Local" localSheetId="0">Sheet1!$C$1</definedName></definedNames></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': enc(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': enc(SHEET_XML),
    'xl/sharedStrings.xml': enc(
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><r><t>Na</t></r><r><t>me</t></r><rPh sb="0" eb="2"><t>ナマエ</t></rPh></si></sst>`,
    ),
    'xl/styles.xml': enc(
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ),
    'docProps/custom.xml': enc(
      `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="IcecreamSheets.Meta.icecream.testprop"><vt:lpwstr>{&quot;a&quot;:1}</vt:lpwstr></property></Properties>`,
    ),
  }) as Uint8Array;
}

describe('parseWorkbookFast', () => {
  it('matches XlsxAdapter.read exactly on the edge fixture', async () => {
    const bytes = fixtureBytes();
    const sheetjs = new XlsxAdapter().read(bytes);
    const fast = await parseWorkbookFast(bytes);
    expect(fast.timings.path).not.toBe('sheetjs-fallback');
    expect(fast.data.sheets.length).toBe(1);
    const a = sheetjs.sheets[0]!;
    const b = fast.data.sheets[0]!;
    expect(b.name).toBe(a.name);
    expect(b.rows).toEqual(a.rows);
    expect(b.formats ?? {}).toEqual(a.formats ?? {});
    expect(b.colWidths ?? {}).toEqual(a.colWidths ?? {});
    expect(b.rowHeights ?? {}).toEqual(a.rowHeights ?? {});
    expect(b.hiddenCols ?? []).toEqual(a.hiddenCols ?? []);
    expect(b.hiddenRows ?? []).toEqual(a.hiddenRows ?? []);
    expect(fast.data.definedNames).toEqual(sheetjs.definedNames);
    expect(fast.data.metadata['icecream.testprop']).toEqual({ a: 1 });
    // Non-empty inputs: 4 + 2 + 3 + 1 (array anchor; member nulled) + 1.
    expect(fast.exactTotalCells).toBe(11);
    // Timings are populated and internally ordered.
    const t = fast.timings;
    expect(t.unzipMs).toBeGreaterThanOrEqual(0);
    expect(t.sheetParseMs).toBeGreaterThanOrEqual(0);
    expect(t.totalMs).toBeGreaterThanOrEqual(t.sheetParseMs);
  });

  it('exposes the meta chunk data (sheet names + estimates) before/at parse end', async () => {
    const bytes = fixtureBytes();
    const events: string[] = [];
    const fast = await parseWorkbookFast(bytes, {
      onMeta: (meta) => {
        events.push('meta');
        expect(meta.sheets).toEqual(['Sheet1']);
        expect(meta.totalSheets).toBe(1);
        expect(meta.totalCellsEstimate).toBe(36); // dimension A1:F6 area
      },
      onSheetChunk: () => events.push('chunk'),
    });
    expect(events[0]).toBe('meta');
    expect(fast.timings.firstSheetReadyMs).toBeGreaterThanOrEqual(0);
  });
});
