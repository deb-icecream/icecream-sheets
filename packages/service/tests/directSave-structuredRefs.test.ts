/**
 * Item B: structured references on the production save path.
 *
 * directSave's verbatim path regenerates any CHANGED sheet from the
 * live bulk readback, whose formulas are the A1 forms import produced
 * (e.g. `=SUM(Data!$B$2:Data!$B$4)`). Without restoration the saved
 * file degrades those to A1 expansions while the table parts survive
 * verbatim. The adapter-fallback path previously dropped the `tables`
 * field entirely in groupedToWorkbookData, losing even the parts.
 * Fixture folded in from the xlsx-adapter zz-itemb-repro scratch file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import type { CellInput, TypedValue, WorkbookData } from '@icecream-sheets/engine';
import {
  serializeLiveWorkbook,
  verifyXlsxPackage,
  type DirectSaveCell,
  type DirectSaveInput,
  type DirectSaveParsedSheet,
} from '../src/save/directSave.js';

const dec = new TextDecoder();

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

function valueOf(input: CellInput): TypedValue {
  if (typeof input === 'number') return { kind: 'number', value: input };
  if (typeof input === 'boolean') return { kind: 'boolean', value: input };
  if (typeof input === 'string' && input.startsWith('=')) return { kind: 'number', value: 0 };
  if (typeof input === 'string') return { kind: 'string', value: input };
  return { kind: 'null', value: null };
}

function bulkFromData(data: WorkbookData): DirectSaveCell[] {
  const bulk: DirectSaveCell[] = [];
  for (const sheet of data.sheets) {
    sheet.rows.forEach((row, r) => {
      row.forEach((input, c) => {
        if (input === null || input === undefined || input === '') return;
        bulk.push({ ref: { sheet: sheet.name, row: r, col: c }, input, value: valueOf(input) });
      });
    });
  }
  return bulk;
}

function formulasIn(bytes: Uint8Array, part: string): string[] {
  const parts = unzipSync(bytes.slice());
  const xml = parts[part] ? dec.decode(parts[part]) : '';
  return [...xml.matchAll(/<f>([^<]*)<\/f>/g)].map((m) => m[1]!);
}

describe('item B: serializeLiveWorkbook structured refs', () => {
  const tmpdirs: string[] = [];
  afterEach(() => {
    for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeInput(overrides: Partial<DirectSaveInput> = {}): { input: DirectSaveInput; out: string; sourceBytes: Uint8Array; data: WorkbookData } {
    const dir = mkdtempSync(join(tmpdir(), 'direct-save-sr-'));
    tmpdirs.push(dir);
    const sourceBytes = sourcePackage();
    const data = new XlsxAdapter().read(sourceBytes.slice());
    const out = join(dir, 'out.xlsx');
    const parsedSheets = new Map<string, DirectSaveParsedSheet>();
    for (const s of data.sheets) parsedSheets.set(s.name, {});
    const input: DirectSaveInput = {
      bulk: bulkFromData(data),
      sheetNames: data.sheets.map((s) => s.name),
      definedNames: data.definedNames ?? [],
      metadata: data.metadata ?? {},
      sourceBytes,
      parsedSheets,
      sheets: data.sheets.map((s) => ({ name: s.name, clientStyles: false, clientDims: false })),
      ops: [],
      outPath: out,
      ...overrides,
    };
    return { input, out, sourceBytes, data };
  }

  it('verbatim path: an edit on the table sheet regenerates it with structured refs restored', () => {
    const data0 = new XlsxAdapter().read(sourcePackage().slice());
    const bulk = bulkFromData(data0);
    const b2 = bulk.find((c) => c.ref.sheet === 'Data' && c.ref.row === 1 && c.ref.col === 1)!;
    b2.input = 7;
    b2.value = { kind: 'number', value: 7 };
    const { input, out, sourceBytes } = makeInput({
      bulk,
      ops: [{ cmd: 'setCell', ref: { sheet: 'Data', row: 1, col: 1 } }],
    });
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('verbatim');
    expect(result.changedSheets).toEqual(['Data']);
    expect(verifyXlsxPackage(out).ok).toBe(true);

    const outBytes = new Uint8Array(readFileSync(out));
    // Regenerated sheet: A1 bulk forms restored to structured refs.
    expect(formulasIn(outBytes, 'xl/worksheets/sheet1.xml')).toEqual([
      'SUM(Sales[Qty])',
      'Sales[@Qty]*Sales[@Price]',
      'SUM(Sales[Amount])',
      'Sales[@Qty]*Sales[@Price]',
      'Sales[@Qty]*Sales[@Price]',
      'SUBTOTAL(109,Sales[Qty])',
    ]);
    // Table part + tableParts survive on the regenerated sheet.
    expect(Object.keys(unzipSync(outBytes.slice()))).toContain('xl/tables/table1.xml');
    const sheet1Xml = dec.decode(unzipSync(outBytes.slice())['xl/worksheets/sheet1.xml']!);
    expect(sheet1Xml).toContain('<tableParts');
    // The edited value landed.
    const back = new XlsxAdapter().read(outBytes);
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[1]![1]).toBe(7);
    // Parse-back: range forms return to the identical A1 model.
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]![5]).toBe('=SUM(Data!$B$2:Data!$B$4)');
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[4]![1]).toBe('=SUBTOTAL(109,Data!$B$2:Data!$B$4)');
    // Untouched Calc sheet is byte-identical to the source part
    // (its structured refs were never at risk on this path).
    const srcParts = unzipSync(sourceBytes.slice());
    const outParts = unzipSync(outBytes.slice());
    expect(Buffer.from(outParts['xl/worksheets/sheet2.xml']!)).toEqual(
      Buffer.from(srcParts['xl/worksheets/sheet2.xml']!),
    );
  });

  it('adapter-fallback path: table parts AND restored refs survive', () => {
    const { input, out } = makeInput({ ops: [{ cmd: 'setCalculationMode' }] });
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('adapter-fallback');
    expect(result.fallbackReason).toBe('structural-op:setCalculationMode');
    expect(verifyXlsxPackage(out).ok).toBe(true);

    const outBytes = new Uint8Array(readFileSync(out));
    const parts = Object.keys(unzipSync(outBytes.slice()));
    // The fallback previously dropped the tables field entirely:
    // no table part at all. Now the part survives...
    expect(parts.some((p) => /^xl\/tables\/table\d+\.xml$/.test(p))).toBe(true);
    const sheet1Xml = dec.decode(unzipSync(outBytes.slice())['xl/worksheets/sheet1.xml']!);
    expect(sheet1Xml).toContain('<tableParts');
    // ...and the formulas are structured, not A1 expansions —
    // including the cross-sheet references on Calc.
    expect(formulasIn(outBytes, 'xl/worksheets/sheet1.xml')).toContain('SUM(Sales[Qty])');
    expect(formulasIn(outBytes, 'xl/worksheets/sheet1.xml')).toContain('SUBTOTAL(109,Sales[Qty])');
    expect(formulasIn(outBytes, 'xl/worksheets/sheet2.xml')).toEqual([
      'SUM(Sales[Amount])',
      'SUM(Sales[#Data])',
    ]);
    // Parse-back still carries the table definition.
    const back = new XlsxAdapter().read(outBytes);
    const dataSheet = back.sheets.find((s) => s.name === 'Data') as unknown as {
      tables?: unknown[];
    };
    expect(dataSheet.tables).toHaveLength(1);
  });
});
