/**
 * Item B: structured references must survive a save. Import rewrites
 * them to A1 ranges BY DESIGN (the engine cannot parse the structured
 * syntax; pinned by tables-native.test.ts), so the serializer must
 * restore them — restoreStructuredRefs is the exact inverse of
 * rewriteStructuredRefs for the absolute forms the rewriter emits.
 * Folded in from the scratch zz-itemb-repro fixture.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  XlsxAdapter,
  restoreStructuredRefs,
  rewriteStructuredRefs,
  type SheetDataWithTables,
  type TableDef,
} from '../src/index.js';

const dec = new TextDecoder();
const adapter = new XlsxAdapter();

const sales: TableDef = {
  name: 'Sales',
  sheet: 'Data',
  startRow: 0,
  startCol: 0,
  endRow: 4,
  endCol: 3,
  columns: ['Item', 'Qty', 'Price', 'Amount'],
  headerRow: true,
  totalsRow: true,
};

describe('restoreStructuredRefs: unit', () => {
  it('restores a per-column data range to T[Col] (qualified, cross-sheet, unqualified, half-qualified)', () => {
    expect(restoreStructuredRefs('=SUM(Data!$B$2:Data!$B$4)', 0, 'Data', [sales])).toBe('=SUM(Sales[Qty])');
    // Qualified reference from another sheet restores too.
    expect(restoreStructuredRefs('=SUM(Data!$D$2:Data!$D$4)', 0, 'Calc', [sales])).toBe('=SUM(Sales[Amount])');
    // Unqualified form assumed on formulaSheet.
    expect(restoreStructuredRefs('=SUM($B$2:$B$4)', 0, 'Data', [sales])).toBe('=SUM(Sales[Qty])');
    expect(restoreStructuredRefs('=SUM($B$2:$B$4)', 0, 'Calc', [sales])).toBe('=SUM($B$2:$B$4)');
    // Second endpoint unqualified (engine-style range spelling).
    expect(restoreStructuredRefs('=SUM(Data!$B$2:$B$4)', 0, 'Data', [sales])).toBe('=SUM(Sales[Qty])');
  });

  it('restores #All / #Headers / #Totals / #Data ranges', () => {
    expect(restoreStructuredRefs('=Data!$A$1:Data!$D$5', 0, 'Data', [sales])).toBe('=Sales[#All]');
    expect(restoreStructuredRefs('=Data!$A$1:Data!$D$1', 0, 'Data', [sales])).toBe('=Sales[#Headers]');
    expect(restoreStructuredRefs('=Data!$A$5:Data!$D$5', 0, 'Data', [sales])).toBe('=Sales[#Totals]');
    expect(restoreStructuredRefs('=SUM(Data!$A$2:Data!$D$4)', 0, 'Calc', [sales])).toBe('=SUM(Sales[#Data])');
  });

  it('restores header/totals single cells and same-row data cells', () => {
    expect(restoreStructuredRefs('=Data!$B$1', 0, 'Data', [sales])).toBe('=Sales[[#Headers],[Qty]]');
    expect(restoreStructuredRefs('=Data!$B$5', 0, 'Data', [sales])).toBe('=Sales[[#Totals],[Qty]]');
    expect(restoreStructuredRefs('=Data!$B$3*Data!$C$3', 2, 'Data', [sales])).toBe('=Sales[@Qty]*Sales[@Price]');
    expect(restoreStructuredRefs('=$B$3', 2, 'Data', [sales])).toBe('=Sales[@Qty]');
  });

  it('handles quoted sheet names', () => {
    const orders: TableDef = { ...sales, name: 'Orders', sheet: 'My Data' };
    expect(
      restoreStructuredRefs("=SUM('My Data'!$C$2:'My Data'!$C$4)", 0, 'My Data', [orders]),
    ).toBe('=SUM(Orders[Price])');
  });

  it('leaves string literals untouched', () => {
    expect(restoreStructuredRefs('="Data!$B$2:Data!$B$4"', 0, 'Data', [sales])).toBe('="Data!$B$2:Data!$B$4"');
    expect(restoreStructuredRefs('="x"&Data!$B$1', 0, 'Data', [sales])).toBe('="x"&Sales[[#Headers],[Qty]]');
    expect(restoreStructuredRefs('="a ""Data!$B$1"" b"', 0, 'Data', [sales])).toBe('="a ""Data!$B$1"" b"');
  });

  it('graceful degradation: no exact shape match stays A1', () => {
    // Partial column range (edited/shifted) — not the table shape.
    expect(restoreStructuredRefs('=SUM(Data!$B$2:Data!$B$3)', 0, 'Data', [sales])).toBe('=SUM(Data!$B$2:Data!$B$3)');
    // Data single cell NOT on the formula's own row.
    expect(restoreStructuredRefs('=Data!$B$3', 1, 'Data', [sales])).toBe('=Data!$B$3');
    // Relative refs are not the absolute forms the rewriter emits.
    expect(restoreStructuredRefs('=SUM(B2:B4)', 0, 'Data', [sales])).toBe('=SUM(B2:B4)');
    // Unknown sheet / non-table range.
    expect(restoreStructuredRefs('=SUM(Other!$B$2:Other!$B$4)', 0, 'Data', [sales])).toBe('=SUM(Other!$B$2:Other!$B$4)');
    // A range whose first endpoint alone looks like a totals single is
    // not partially converted.
    expect(restoreStructuredRefs('=Data!$B$5:Data!$B$6', 0, 'Data', [sales])).toBe('=Data!$B$5:Data!$B$6');
    // No tables -> unchanged.
    expect(restoreStructuredRefs('=SUM(Data!$B$2:Data!$B$4)', 0, 'Data', [])).toBe('=SUM(Data!$B$2:Data!$B$4)');
  });

  it('is the inverse of rewriteStructuredRefs for the rewriter forms', () => {
    const roundTrip = (structured: string, row: number): string =>
      restoreStructuredRefs(rewriteStructuredRefs(structured, row, [sales]), row, 'Data', [sales]);
    expect(roundTrip('=SUM(Sales[Qty])', 0)).toBe('=SUM(Sales[Qty])');
    expect(roundTrip('=Sales[[#Totals],[Qty]]', 0)).toBe('=Sales[[#Totals],[Qty]]');
    expect(roundTrip('=Sales[[#Headers],[Qty]]', 0)).toBe('=Sales[[#Headers],[Qty]]');
    expect(roundTrip('=Sales[#Headers]', 0)).toBe('=Sales[#Headers]');
    expect(roundTrip('=Sales[#Totals]', 0)).toBe('=Sales[#Totals]');
    expect(roundTrip('=Sales[#All]', 0)).toBe('=Sales[#All]');
    expect(roundTrip('=SUM(Sales[#Data])', 0)).toBe('=SUM(Sales[#Data])');
    // This-row forms restore to the canonical [@Col] spelling.
    expect(roundTrip('=Sales[[@Qty]]', 2)).toBe('=Sales[@Qty]');
    expect(roundTrip('=Sales[[#This Row],[Price]]', 3)).toBe('=Sales[@Price]');
  });
});

/* ------------------------------------------------------------------ */
/* Classic-write parse-back (fixture folded in from zz-itemb-repro)    */
/* ------------------------------------------------------------------ */

const TABLE_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'id="1" name="Sales" displayName="Sales" ref="A1:D5" headerRowCount="1" totalsRowCount="1" totalsRowShown="1">' +
  '<tableColumns count="4">' +
  '<tableColumn id="1" name="Item" totalsRowLabel="Grand Total"/>' +
  '<tableColumn id="2" name="Qty" totalsRowFunction="sum"/>' +
  '<tableColumn id="3" name="Price"/>' +
  '<tableColumn id="4" name="Amount" totalsRowFunction="sum"/>' +
  '</tableColumns>' +
  '<tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/>' +
  '</table>';

function sourcePackage(): Uint8Array {
  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<dimension ref="A1:F5"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/>' +
    '<sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c>' +
    '<c r="C1" t="inlineStr"><is><t>Price</t></is></c><c r="D1" t="inlineStr"><is><t>Amount</t></is></c>' +
    '<c r="F1"><f>SUM(Sales[Qty])</f><v>6</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>Apples</t></is></c><c r="B2"><v>2</v></c><c r="C2"><v>3</v></c>' +
    '<c r="D2"><f>Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]</f><v>6</v></c>' +
    '<c r="F2"><f>SUM(Sales[Amount])</f><v>23</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>Pears</t></is></c><c r="B3"><v>1</v></c><c r="C3"><v>5</v></c>' +
    '<c r="D3"><f>Sales[@Qty]*Sales[@Price]</f><v>5</v></c></row>' +
    '<row r="4"><c r="A4" t="inlineStr"><is><t>Apples</t></is></c><c r="B4"><v>3</v></c><c r="C4"><v>4</v></c>' +
    '<c r="D4"><f>Sales[[@Qty]]*Sales[[@Price]]</f><v>12</v></c></row>' +
    '<row r="5"><c r="A5" t="inlineStr"><is><t>Grand Total</t></is></c>' +
    '<c r="B5"><f>SUBTOTAL(109,Sales[Qty])</f><v>6</v></c><c r="D5"><v>23</v></c></row>' +
    '</sheetData>' +
    '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' +
    '</worksheet>';
  const calcXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData><row r="1"><c r="A1"><f>SUM(Sales[Amount])</f><v>23</v></c>' +
    '<c r="B1"><f>SUM(Sales[#Data])</f><v>37</v></c></row></sheetData></worksheet>';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>' +
      '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Calc" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
      '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    'xl/worksheets/sheet2.xml': strToU8(calcXml),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>' +
      '</Relationships>',
    ),
    'xl/tables/table1.xml': strToU8(TABLE_XML),
  });
}

function formulasIn(bytes: Uint8Array, part: string): string[] {
  const parts = unzipSync(bytes.slice());
  const xml = parts[part] ? dec.decode(parts[part]) : '';
  return [...xml.matchAll(/<f>([^<]*)<\/f>/g)].map((m) => m[1]!);
}

describe('item B: classic XlsxAdapter.write restores structured refs', () => {
  it('write() emits structured refs on both sheets and keeps the table part, without mutating input', () => {
    const data = adapter.read(sourcePackage());
    // Import form (A1) pinned before write, to prove no input mutation.
    const dataSheet = data.sheets.find((s) => s.name === 'Data')!;
    expect(dataSheet.rows[0]![5]).toBe('=SUM(Data!$B$2:Data!$B$4)');

    const out = adapter.write(data);

    expect(formulasIn(out, 'xl/worksheets/sheet1.xml')).toEqual([
      'SUM(Sales[Qty])',
      'Sales[@Qty]*Sales[@Price]',
      'SUM(Sales[Amount])',
      // D3's source form Sales[@Qty] is A1-rewritten at import by the
      // single-bracket @ branch of resolveStructured and restores to
      // the same text here.
      'Sales[@Qty]*Sales[@Price]',
      'Sales[@Qty]*Sales[@Price]',
      'SUBTOTAL(109,Sales[Qty])',
    ]);
    expect(formulasIn(out, 'xl/worksheets/sheet2.xml')).toEqual([
      'SUM(Sales[Amount])',
      'SUM(Sales[#Data])',
    ]);
    expect(Object.keys(unzipSync(out.slice()))).toContain('xl/tables/table1.xml');

    // Input not mutated by write.
    expect(dataSheet.rows[0]![5]).toBe('=SUM(Data!$B$2:Data!$B$4)');
    expect(dataSheet.rows[1]![3]).toBe('=Data!$B$2*Data!$C$2');
  });

  it('parse-back: re-reading the written file returns the same A1 model for range forms', () => {
    const once = adapter.read(sourcePackage());
    const twice = adapter.read(adapter.write(once));
    const sheet = (wb: typeof once, name: string) => wb.sheets.find((s) => s.name === name)!;
    expect(sheet(twice, 'Data').rows[0]![5]).toBe('=SUM(Data!$B$2:Data!$B$4)');
    expect(sheet(twice, 'Data').rows[1]![5]).toBe('=SUM(Data!$D$2:Data!$D$4)');
    expect(sheet(twice, 'Data').rows[4]![1]).toBe('=SUBTOTAL(109,Data!$B$2:Data!$B$4)');
    expect(sheet(twice, 'Calc').rows[0]![0]).toBe('=SUM(Data!$D$2:Data!$D$4)');
    expect(sheet(twice, 'Calc').rows[0]![1]).toBe('=SUM(Data!$A$2:Data!$D$4)');
    expect((sheet(twice, 'Data') as SheetDataWithTables).tables).toHaveLength(1);
  });
});
