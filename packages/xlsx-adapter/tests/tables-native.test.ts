/**
 * OOXML wave-2 slice B (audit §11): TABLES (ListObjects) — full
 * definition import + native write in the XLSX adapter.
 *
 * Fixtures are hand-built OOXML packages (the way Excel writes them):
 * a worksheet with <tableParts>, a sheet .rels entry, and a real
 * xl/tables/table1.xml part carrying totalsRowFunction /
 * totalsRowLabel / calculatedColumnFormula / tableStyleInfo / the
 * table's own <autoFilter>.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { WorkbookData } from '@icecream-sheets/engine';
import {
  XlsxAdapter,
  parseTablePartXml,
  readTables,
  rewriteStructuredRefs,
  subtotalCodeForTotalsRowFunction,
  tableDefToXml,
  totalsRowFunctionForSubtotalCode,
  type SheetDataWithTables,
  type TableDef,
} from '../src/index.js';

const dec = new TextDecoder();
const adapter = new XlsxAdapter();

function partText(bytes: Uint8Array, path: string): string {
  const parts = unzipSync(bytes.slice());
  const raw = parts[path];
  return raw ? dec.decode(raw) : '';
}

function partPaths(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes.slice()));
}

/* ------------------------------------------------------------------ */
/* Hand-built native source package (as Excel would write it)          */
/* ------------------------------------------------------------------ */

const TABLE_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'id="1" name="Sales" displayName="Sales" ref="A1:D5" headerRowCount="1" totalsRowCount="1" totalsRowShown="1">' +
  '<autoFilter ref="A1:D4">' +
  '<filterColumn colId="0"><filters><filter val="Apples"/><filter val="Pears"/></filters></filterColumn>' +
  '<filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="1"/></customFilters></filterColumn>' +
  '</autoFilter>' +
  '<tableColumns count="4">' +
  '<tableColumn id="1" name="Item" totalsRowLabel="Grand Total"/>' +
  '<tableColumn id="2" name="Qty" totalsRowFunction="sum"/>' +
  '<tableColumn id="3" name="Price" totalsRowFunction="average"/>' +
  '<tableColumn id="4" name="Amount" totalsRowFunction="custom">' +
  '<calculatedColumnFormula>Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]</calculatedColumnFormula>' +
  '<totalsRowFormula>SUBTOTAL(109,Sales[Amount])</totalsRowFormula>' +
  '</tableColumn>' +
  '</tableColumns>' +
  '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="1" showLastColumn="0" showRowStripes="1" showColumnStripes="1"/>' +
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
    '<row r="2"><c r="A2" t="inlineStr"><is><t>Apples</t></is></c><c r="B2"><v>2</v></c><c r="C2"><v>3</v></c><c r="D2"><v>6</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>Pears</t></is></c><c r="B3"><v>1</v></c><c r="C3"><v>5</v></c><c r="D3"><v>5</v></c></row>' +
    '<row r="4"><c r="A4" t="inlineStr"><is><t>Apples</t></is></c><c r="B4"><v>3</v></c><c r="C4"><v>4</v></c><c r="D4"><v>12</v></c></row>' +
    '<row r="5"><c r="A5" t="inlineStr"><is><t>Grand Total</t></is></c><c r="B5"><v>6</v></c><c r="D5"><v>23</v></c></row>' +
    '</sheetData>' +
    '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' +
    '</worksheet>';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
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
      '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>' +
      '</Relationships>',
    ),
    'xl/tables/table1.xml': strToU8(TABLE_XML),
  });
}

function dataSheet(data: WorkbookData): SheetDataWithTables {
  return data.sheets[0] as SheetDataWithTables;
}

/* ------------------------------------------------------------------ */
/* Full-definition import                                              */
/* ------------------------------------------------------------------ */

describe('tables: full definition import (audit §11)', () => {
  it('parses every field of the table definition onto the sheet model', () => {
    const sheet = dataSheet(adapter.read(sourcePackage()));
    expect(sheet.tables).toHaveLength(1);
    const t = sheet.tables![0]!;
    expect(t.name).toBe('Sales');
    expect(t.displayName).toBe('Sales');
    expect(t.id).toBe(1);
    expect(t.sheet).toBe('Data');
    expect(t.ref).toBe('A1:D5');
    expect([t.startRow, t.startCol, t.endRow, t.endCol]).toEqual([0, 0, 4, 3]);
    expect(t.headerRow).toBe(true);
    expect(t.totalsRow).toBe(true);
    expect(t.headerRowCount).toBe(1);
    expect(t.totalsRowCount).toBe(1);
    expect(t.columns).toEqual(['Item', 'Qty', 'Price', 'Amount']);
    expect(t.columnDetails).toEqual([
      { id: 1, name: 'Item', totalsRowLabel: 'Grand Total' },
      { id: 2, name: 'Qty', totalsRowFunction: 'sum' },
      { id: 3, name: 'Price', totalsRowFunction: 'average' },
      {
        id: 4,
        name: 'Amount',
        totalsRowFunction: 'custom',
        calculatedColumnFormula: 'Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]',
        totalsRowFormula: 'SUBTOTAL(109,Sales[Amount])',
      },
    ]);
    expect(t.tableStyleInfo).toEqual({
      name: 'TableStyleMedium2',
      showFirstColumn: true,
      showLastColumn: false,
      showRowStripes: true,
      showColumnStripes: true,
    });
    expect(t.autoFilter).toEqual({
      ref: 'A1:D4',
      filterColumns: [
        { colId: 0, filters: { values: ['Apples', 'Pears'], dateGroups: [] } },
        { colId: 1, customFilters: { and: true, filters: [{ operator: 'greaterThan', val: '1' }] } },
      ],
    });
  });

  it('readTables returns the same full definition from the raw package', () => {
    const files = unzipSync(sourcePackage().slice());
    const tables = readTables(files, ['Data']);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.columnDetails![1]!.totalsRowFunction).toBe('sum');
    expect(tables[0]!.tableStyleInfo!.name).toBe('TableStyleMedium2');
  });

  it('keeps a numeric totalsRowFunction (SUBTOTAL code) verbatim', () => {
    const xml = TABLE_XML.replace('totalsRowFunction="sum"', 'totalsRowFunction="109"');
    const t = parseTablePartXml(xml, 'Data');
    expect(t!.columnDetails![1]!.totalsRowFunction).toBe('109');
  });

  it('structured references are still rewritten to A1 on import', () => {
    const sheet = dataSheet(adapter.read(sourcePackage()));
    // F1 held =SUM(Sales[Qty]) — data rows of Qty are B2:B4 (the
    // pre-existing a1Range form repeats the sheet prefix per endpoint).
    expect(sheet.rows[0]![5]).toBe('=SUM(Data!$B$2:Data!$B$4)');
  });
});

/* ------------------------------------------------------------------ */
/* Import -> write -> re-import round-trip                             */
/* ------------------------------------------------------------------ */

describe('tables: native write round-trip', () => {
  it('emits a real table part, tableParts, sheet rels and content type', () => {
    const bytes = adapter.write(adapter.read(sourcePackage()));
    expect(partPaths(bytes)).toContain('xl/tables/table1.xml');
    const tableXml = partText(bytes, 'xl/tables/table1.xml');
    expect(tableXml).toContain('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
    expect(tableXml).toContain('displayName="Sales"');
    expect(tableXml).toContain('ref="A1:D5"');
    expect(tableXml).toContain('totalsRowFunction="sum"');
    expect(tableXml).toContain('totalsRowLabel="Grand Total"');
    expect(tableXml).toContain(
      '<calculatedColumnFormula>Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]</calculatedColumnFormula>',
    );
    expect(tableXml).toContain('<tableStyleInfo name="TableStyleMedium2" showFirstColumn="1" showLastColumn="0" showRowStripes="1" showColumnStripes="1"/>');
    // CT_Table order: autoFilter before tableColumns before tableStyleInfo.
    expect(tableXml.indexOf('<autoFilter')).toBeLessThan(tableXml.indexOf('<tableColumns'));
    expect(tableXml.indexOf('<tableColumns')).toBeLessThan(tableXml.indexOf('<tableStyleInfo'));

    const sheetXml = partText(bytes, 'xl/worksheets/sheet1.xml');
    expect(sheetXml).toMatch(/<tableParts count="1"><tablePart r:id="rId\d+"\/><\/tableParts>/);
    const rels = partText(bytes, 'xl/worksheets/_rels/sheet1.xml.rels');
    expect(rels).toContain('relationships/table');
    expect(rels).toContain('Target="../tables/table1.xml"');
    expect(partText(bytes, '[Content_Types].xml')).toContain(
      '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>',
    );
  });

  it('import -> write -> re-import is value-identical (incl. totals + calculated formulas)', () => {
    const once = adapter.read(sourcePackage());
    const twice = adapter.read(adapter.write(once));
    expect(dataSheet(twice).tables).toEqual(dataSheet(once).tables);
    // And a second write cycle stays identical (idempotent).
    const thrice = adapter.read(adapter.write(twice));
    expect(dataSheet(thrice).tables).toEqual(dataSheet(once).tables);
  });

  it('a model-authored table writes a part the importer reads back identically', () => {
    const authored: TableDef = {
      name: 'Inventory',
      displayName: 'Inventory',
      sheet: 'Stock',
      id: 7,
      ref: 'A1:C4',
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 2,
      columns: ['Sku', 'Qty', 'Note'],
      headerRow: true,
      totalsRow: true,
      headerRowCount: 1,
      totalsRowCount: 1,
      columnDetails: [
        { id: 1, name: 'Sku', totalsRowLabel: 'Total' },
        { id: 2, name: 'Qty', totalsRowFunction: 'sum' },
        {
          id: 3,
          name: 'Note',
          totalsRowFunction: 'custom',
          totalsRowFormula: 'SUBTOTAL(103,Inventory[Note])',
        },
      ],
      tableStyleInfo: {
        name: 'TableStyleLight1',
        showFirstColumn: false,
        showLastColumn: false,
        showRowStripes: true,
        showColumnStripes: false,
      },
      autoFilter: {
        ref: 'A1:C3',
        filterColumns: [{ colId: 1, filters: { values: ['5'], dateGroups: [] } }],
      },
    };
    const data: WorkbookData = {
      sheets: [{
        name: 'Stock',
        rows: [
          ['Sku', 'Qty', 'Note'],
          ['A1', 5, 'x'],
          ['B2', 3, 'y'],
          ['Total', 8, null],
        ],
        tables: [authored],
      } as SheetDataWithTables],
      metadata: {},
    };
    const bytes = adapter.write(data);
    const tableXml = partText(bytes, 'xl/tables/table1.xml');
    expect(tableXml).toContain('id="7"');
    expect(tableXml).toContain('name="Inventory"');
    const back = dataSheet(adapter.read(bytes));
    expect(back.tables).toEqual([authored]);
  });

  it('writes multiple tables on one sheet with unique ids and count=2', () => {
    const mk = (name: string, id: number, sc: number): TableDef => ({
      name,
      sheet: 'S',
      id,
      startRow: 0,
      startCol: sc,
      endRow: 2,
      endCol: sc + 1,
      columns: ['A', 'B'],
      headerRow: true,
      totalsRow: false,
    });
    const data: WorkbookData = {
      sheets: [{
        name: 'S',
        rows: [['A', 'B', 'A', 'B'], [1, 2, 3, 4], [5, 6, 7, 8]],
        tables: [mk('T1', 1, 0), mk('T2', 2, 2)],
      } as SheetDataWithTables],
      metadata: {},
    };
    const bytes = adapter.write(data);
    const tables = partPaths(bytes).filter((p) => p.startsWith('xl/tables/'));
    expect(tables.sort()).toEqual(['xl/tables/table1.xml', 'xl/tables/table2.xml']);
    expect(partText(bytes, 'xl/worksheets/sheet1.xml')).toContain('<tableParts count="2">');
    const back = dataSheet(adapter.read(bytes));
    expect(back.tables!.map((t) => t.name).sort()).toEqual(['T1', 'T2']);
    expect(back.tables!.map((t) => t.ref).sort()).toEqual(['A1:B3', 'C1:D3']);
  });

  it('workbooks without tables gain no table parts', () => {
    const data: WorkbookData = { sheets: [{ name: 'S', rows: [[1, 2], [3, 4]] }], metadata: {} };
    const bytes = adapter.write(data);
    expect(partPaths(bytes).filter((p) => p.startsWith('xl/tables/'))).toEqual([]);
    expect(partText(bytes, 'xl/worksheets/sheet1.xml')).not.toContain('<tableParts');
    expect(partText(bytes, '[Content_Types].xml')).not.toContain('spreadsheetml.table+xml');
    expect(dataSheet(adapter.read(bytes)).tables).toBeUndefined();
  });

  it('control characters in column names round-trip via _xHHHH_ escapes', () => {
    const t: TableDef = {
      name: 'T',
      sheet: 'S',
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 0,
      columns: ['Unit\nPrice'],
      headerRow: true,
      totalsRow: false,
    };
    const xml = tableDefToXml(t, 1);
    expect(xml).toContain('name="Unit_x000A_Price"');
    const back = parseTablePartXml(xml, 'S');
    expect(back!.columns).toEqual(['Unit\nPrice']);
  });
});

/* ------------------------------------------------------------------ */
/* Structured-reference rewrite regressions                            */
/* ------------------------------------------------------------------ */

describe('tables: structured-ref rewrite (regression)', () => {
  const t: TableDef = {
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

  it('rewrites column, totals, headers, data and this-row forms', () => {
    expect(rewriteStructuredRefs('=SUM(Sales[Qty])', 0, [t])).toBe('=SUM(Data!$B$2:Data!$B$4)');
    expect(rewriteStructuredRefs('=Sales[[#Totals],[Qty]]', 0, [t])).toBe('=Data!$B$5');
    expect(rewriteStructuredRefs('=Sales[#Headers]', 0, [t])).toBe('=Data!$A$1:Data!$D$1');
    expect(rewriteStructuredRefs('=SUM(Sales[#Data])', 0, [t])).toBe('=SUM(Data!$A$2:Data!$D$4)');
    // Implicit this-row is supported in the double-bracket form
    // (pre-existing rewriter behavior, kept bit-identical).
    expect(rewriteStructuredRefs('=Sales[[@Qty]]', 2, [t])).toBe('=Data!$B$3');
    expect(rewriteStructuredRefs('=Sales[[#This Row],[Price]]', 3, [t])).toBe('=Data!$C$4');
    // Single-bracket implicit this-row "T[@Col]" — Excel's preferred
    // in-cell shorthand and the form restoreStructuredRefs emits at
    // save. Regression (successor coordinator, 2026-10-21): this form
    // was NOT resolved, so a save -> re-read round trip changed the
    // formula text of every calculated-column cell (roundtrip-fidelity
    // failure on beyond-excel-bxl3way.xlsx, Imports column D).
    expect(rewriteStructuredRefs('=Sales[@Qty]', 2, [t])).toBe('=Data!$B$3');
    expect(rewriteStructuredRefs('=Sales[@Price]-1', 3, [t])).toBe('=Data!$C$4-1');
    expect(rewriteStructuredRefs('=Sales[@Nope]', 2, [t])).toBe('=Sales[@Nope]');
  });

  it('leaves string literals and unknown tables untouched', () => {
    expect(rewriteStructuredRefs('="Sales[Qty]"', 0, [t])).toBe('="Sales[Qty]"');
    expect(rewriteStructuredRefs('=SUM(Other[Qty])', 0, [t])).toBe('=SUM(Other[Qty])');
    expect(rewriteStructuredRefs('=SUM(A1:A9)', 0, [t])).toBe('=SUM(A1:A9)');
  });
});

/* ------------------------------------------------------------------ */
/* SUBTOTAL code mapping                                               */
/* ------------------------------------------------------------------ */

describe('tables: totalsRowFunction <-> SUBTOTAL codes', () => {
  it('maps the codes that have an ST_TotalsRowFunction equivalent', () => {
    expect(totalsRowFunctionForSubtotalCode(101)).toBe('average');
    expect(totalsRowFunctionForSubtotalCode(102)).toBe('countNums');
    expect(totalsRowFunctionForSubtotalCode(103)).toBe('count');
    expect(totalsRowFunctionForSubtotalCode(104)).toBe('max');
    expect(totalsRowFunctionForSubtotalCode(105)).toBe('min');
    expect(totalsRowFunctionForSubtotalCode(107)).toBe('stdDev');
    expect(totalsRowFunctionForSubtotalCode(109)).toBe('sum');
    expect(totalsRowFunctionForSubtotalCode(110)).toBe('var');
    expect(subtotalCodeForTotalsRowFunction('sum')).toBe(109);
    expect(subtotalCodeForTotalsRowFunction('average')).toBe(101);
  });

  it('PRODUCT / STDEV.P / VAR.P and none/custom have no equivalent', () => {
    expect(totalsRowFunctionForSubtotalCode(106)).toBeUndefined();
    expect(totalsRowFunctionForSubtotalCode(108)).toBeUndefined();
    expect(totalsRowFunctionForSubtotalCode(111)).toBeUndefined();
    expect(subtotalCodeForTotalsRowFunction('none')).toBeUndefined();
    expect(subtotalCodeForTotalsRowFunction('custom')).toBeUndefined();
  });
});
