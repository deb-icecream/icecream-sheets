/**
 * Fast sheet parser (Cycle 10 Phase 4) — unit + differential tests.
 *
 * Builds a hand-written workbook exercising the tricky constructs
 * (shared formulas, array formulas, rich-text shared strings with
 * phonetic guides, inline strings, error cells, custom number formats,
 * defined names incl. sheet-scoped, custom properties, dimensions) and
 * asserts the fast path produces exactly what XlsxAdapter.read produces.
 */
import { describe, expect, it } from 'vitest';
import {
  builtinFormatTable,
  convertDimensions,
  newDimensionContext,
  parseDefinedNames,
  parseSharedStrings,
  parseStyleFormatCodes,
  parseWorkbookSheetParts,
  parseWorksheetXml,
  type SheetRowChunk,
} from '../src/index.js';

// SHEET_XML / SST_XML / STYLES_XML below are also used, byte for byte, by
// packages/gateway/tests/parallelParse.test.ts (the end-to-end
// differential against XlsxAdapter.read lives there, with the workbook
// zip assembled from the same parts).

const SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:F6"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormat defaultRowHeight="15"/>
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

const SST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
<si><r><t>Na</t></r><r><t>me</t></r><rPh sb="0" eb="2"><t>ナマエ</t></rPh></si>
</sst>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
<definedNames>
<definedName name="MyRange">Sheet1!$A$1:$B$1</definedName>
<definedName name="_xlnm.Print_Area" localSheetId="0">Sheet1!$A$1</definedName>
<definedName name="Local" localSheetId="0">Sheet1!$C$1</definedName>
</definedNames>
</workbook>`;

const SST = ['Name'];
const CODES = ['General', '"$"#,##0.00'];

describe('fastSheetParse unit behavior', () => {
  it('parses cells, shared formulas, array members and error cells like SheetJS', () => {
    const r = parseWorksheetXml(SHEET_XML, SST, CODES);
    expect(r.rows[0]![0]).toBe('Name'); // rich-text sst, rPh skipped
    expect(r.rows[0]![1]).toBe(42);
    expect(r.rows[0]![2]).toBe(true);
    expect(r.rows[0]![3]).toBe('#REF!');
    expect(r.rows[1]![0]).toBe('=SUM(B1,10)');
    expect(r.rows[1]![1]).toBe('=NOW()');
    expect(r.rows[2]![0]).toBe('inline');
    expect(r.rows[2]![1]).toBe('=A$1*2'); // shared master
    expect(r.rows[2]![2]).toBe('=B$1*2'); // shared slave, translated
    expect(r.rows[3]![0]).toBe('=ROW(1:2)'); // array anchor
    expect(r.rows[4]![0]).toBe(null); // array member nulled
    expect(r.rows[5]![0]).toBe('str cached');
    // Dense A1 grid: 6 rows × 6 cols from the dimension.
    expect(r.rows.length).toBe(6);
    expect(r.rows[0]!.length).toBe(6);
    // Custom format on B1.
    expect(r.formats['0:1']).toBe('"$"#,##0.00');
    // Dimensions.
    const dims = convertDimensions(r.rawCols, r.rawRows, newDimensionContext());
    expect(dims.colWidths?.['0']).toBeGreaterThan(0);
    expect(dims.hiddenCols).toEqual([2]);
    // Fixture row 1 carries ht="20" POINTS; rowHeights are CSS px
    // (1pt = 4/3 px), so 20pt -> 27px (sweep F-9 unit fix).
    expect(dims.rowHeights?.['0']).toBe(27);
    expect(dims.hiddenRows).toEqual([1]);
  });

  it('produces display rows with pending-calc marks for formula cells without cached values', () => {
    const r = parseWorksheetXml(SHEET_XML, SST, CODES, { display: true });
    expect(r.displayRows?.[0]?.[0]).toBe('Name');
    expect(r.displayRows?.[1]?.[0]).toBe(52); // cached formula result
    expect(r.displayRows?.[1]?.[1]).toBe(null); // no cached value
    expect(r.pendingCalc).toContain('1:1');
    expect(r.pendingCalc).not.toContain('1:0'); // cached present → not pending
    expect(r.displayRows?.[2]?.[2]).toBe(4); // slave cached value
    expect(r.displayRows?.[3]?.[0]).toBe(1); // anchor cached value
  });

  it('streams row chunks: first chunk is the visible window, union is complete', () => {
    const chunks: SheetRowChunk[] = [];
    const r = parseWorksheetXml(SHEET_XML, SST, CODES, {
      display: true,
      firstChunkRows: 2,
      chunkRows: 2,
      onChunk: (c) => chunks.push(c),
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startRow).toBe(0);
    expect(chunks[0]!.rows.length).toBe(2);
    expect(chunks[0]!.displayRows?.[1]?.[0]).toBe(52);
    expect(chunks[0]!.pendingCalc).toContain('1:1');
    // Union of chunks covers every row exactly once.
    const covered = new Set<number>();
    for (const c of chunks) for (let i = 0; i < c.rows.length; i++) covered.add(c.startRow + i);
    expect(covered.size).toBe(r.rows.length);
    // Union of chunk formats == total formats; union of pending == total pending.
    const fmtUnion: Record<string, string> = {};
    const pendUnion: string[] = [];
    for (const c of chunks) {
      Object.assign(fmtUnion, c.formats);
      pendUnion.push(...c.pendingCalc);
    }
    expect(fmtUnion).toEqual(r.formats);
    expect(pendUnion.sort()).toEqual([...r.pendingCalc].sort());
    expect(r.chunkingBroken).toBe(false);
  });

  it('emits the spill model for array anchors while still nulling members in rows', () => {
    const r = parseWorksheetXml(SHEET_XML, SST, CODES);
    expect(r.rows[4]![0]).toBe(null); // member nulled in the grid rows
    expect(r.spills.spills).toHaveLength(1);
    const spill = r.spills.spills[0]!;
    expect(spill.ref).toBe('A4:A5');
    expect(spill.formula).toBe('ROW(1:2)');
    expect(spill.kind).toBe('legacy');
    expect(spill.cachedValues).toEqual([[1], [2]]);
    expect(spill.anchor.ref).toBe('A4');
  });

  it('emits spill-operator references from formulas', () => {
    const xml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"><f t="array" ref="A1:A2">SEQUENCE(2)</f><v>1</v></c><c r="B1"><f>SUM(A1#)</f><v>3</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData></worksheet>`;
    const r = parseWorksheetXml(xml, [], []);
    expect(r.spills.spills).toHaveLength(1);
    expect(r.spills.spills[0]!.kind).toBe('dynamic');
    expect(r.spills.spills[0]!.cachedValues).toEqual([[1], [2]]);
    expect(r.spills.spillRefs).toHaveLength(1);
    expect(r.spills.spillRefs[0]!.text).toBe('A1#');
  });

  it('parses shared inputs and workbook structure from raw XML', () => {
    expect(parseSharedStrings(SST_XML)).toEqual(['Name']);
    expect(parseStyleFormatCodes(STYLES_XML, { 0: 'General' })).toEqual(['General', '"$"#,##0.00']);
    const parts = parseWorkbookSheetParts(WORKBOOK_XML, `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
    expect(parts).toEqual([{ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml', kind: 'worksheet' }]);
    const names = parseDefinedNames(WORKBOOK_XML);
    expect(names).toHaveLength(3);
    expect(builtinFormatTable).toBeTruthy();
  });

  it('normalizes literal CR LF / CR in shared-string text to LF, like SheetJS (#113)', () => {
    // Excel writes multi-line cell text with literal CR LF bytes. A
    // conforming XML parser (and SheetJS) normalizes those to LF before
    // the app ever sees them; the fast path used to keep the CR, so a
    // file loaded via the fast path checkpointed a different checksum
    // than the SheetJS-parsed rehydrate rebuild -- a 409 on every
    // reopen after leave, with zero edits. A character reference still
    // yields a real CR (XML S2.11: references are not line breaks).
    // CR/LF are built via fromCharCode so the fixture survives any
    // transport that normalizes line endings in source files.
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">' +
      '<si><t>line one' + CR + LF + 'line two</t></si>' +
      '<si><t>line one' + CR + 'line two</t></si>' +
      '<si><t>kept&#13;carriage</t></si>' +
      '</sst>';
    expect(parseSharedStrings(xml)).toEqual([
      'line one' + LF + 'line two',
      'line one' + LF + 'line two',
      'kept' + CR + 'carriage',
    ]);
  });
});
