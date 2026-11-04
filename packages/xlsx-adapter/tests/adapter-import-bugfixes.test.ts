/**
 * Regression tests for the five adapter import bugs from the formula audit
 * v2 (2026-10-18), each verified against raw OOXML:
 *
 * 1. Structured ref with CRLF in the column name vs `_x000a_` in table1.xml
 * 2. Text cell "=A*B" (t="s", no <f>) misread as a formula
 * 3. Legacy t="array" formulas spilling into their own member cells
 * 4. Inlined array-constant defined names spilling into occupied cells
 * 5. GETPIVOTDATA #REF! cascading into HYPERLINK/CELL dependents
 *    (engine-side CELL/HYPERLINK fixes; end-to-end here)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import { EngineWorkbook, err, isError, scalar, type CellRef } from '@icecream-sheets/engine';
import { XlsxAdapter } from '../src/index.js';
import { rewriteStructuredRefs, type TableDef } from '../src/tables.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = join(HERE, '..', '..', '..', 'test-data', 'real-world');
const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

function loadReal(file: string): { wb: EngineWorkbook; rows: unknown[][]; definedNames: unknown } {
  const bytes = new Uint8Array(readFileSync(join(REAL, file)));
  const data = new XlsxAdapter().read(bytes);
  const initial: Record<string, unknown[][]> = {};
  for (const s of data.sheets) initial[s.name] = s.rows.map((r) => [...r]);
  const wb = new EngineWorkbook(initial as never, { definedNames: data.definedNames as never });
  return { wb, rows: data.sheets.map((s) => s.rows) as unknown[][], definedNames: data.definedNames };
}

function sheetRowsOf(data: { sheets: { name: string; rows: unknown[][] }[] }, name: string): unknown[][] {
  const s = data.sheets.find((x) => x.name === name);
  if (!s) throw new Error(`sheet ${name} missing`);
  return s.rows;
}

/**
 * Assemble a minimal .xlsx from a raw worksheet XML string (for constructs
 * SheetJS's writer cannot emit, e.g. t="array" formulas with cell.F).
 */
function rawXlsx(sheetXml: string, definedNamesXml = ''): Uint8Array {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    '_rels/.rels': enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>${definedNamesXml}</workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/styles.xml': enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`,
    ),
    'xl/worksheets/sheet1.xml': enc.encode(sheetXml),
  };
  return zipSync(files);
}

const SHEET_WRAPPER = (inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${inner}</sheetData></worksheet>`;

describe('bug 1: structured refs with CRLF vs _x000a_ column names', () => {
  it('rewrites Table1[Purchase<CRLF> price] via the real file', () => {
    const bytes = new Uint8Array(
      readFileSync(join(REAL, 'closedxml-TryToLoad-TableHeadersWithLineBreaks.xlsx')),
    );
    const data = new XlsxAdapter().read(bytes);
    const rows = sheetRowsOf(data, 'Sheet1');
    // The _x000a_ escape decodes to LF, matching the formula's line break.
    expect(rows[6]![7]).toBe('=SUBTOTAL(109,Sheet1!$H$2:Sheet1!$H$7)');
    expect(rows[6]![8]).toBe('=SUBTOTAL(109,Sheet1!$I$2:Sheet1!$I$7)');
  });

  it('evaluates the rewritten column range (proves the right column matched)', () => {
    const { wb } = loadReal('closedxml-TryToLoad-TableHeadersWithLineBreaks.xlsx');
    // Same range minus the self-referencing totals-row cell: 4290+9263+8172+9144+2190.
    (wb as unknown as { setCell(r: CellRef, v: unknown): void }).setCell(
      c('Sheet1', 10, 7),
      '=SUBTOTAL(109,Sheet1!$H$2:Sheet1!$H$6)',
    );
    expect(wb.getValue(c('Sheet1', 10, 7))).toEqual(scalar(33059));
  });

  it('matches CRLF in the formula against LF in the table definition', () => {
    const table: TableDef = {
      name: 'T',
      sheet: 'S',
      startRow: 0,
      startCol: 0,
      endRow: 5,
      endCol: 1,
      columns: ['plain', 'Purchase\n price'], // as decoded from Purchase_x000a_ price
      headerRow: true,
      totalsRow: false,
    };
    expect(rewriteStructuredRefs('=SUM(T[Purchase\r\n price])', 0, [table])).toBe(
      '=SUM(S!$B$2:S!$B$6)',
    );
  });
});

describe('bug 6: structured refs inside string literals must not be rewritten', () => {
  // Mirrors tblBS on Calcs from beyond-excel-bxl3way.xlsx:
  // table ref Calcs!$BJ$6:$BJ$16, header row 6, data body $BJ$7:$BJ$16.
  const table: TableDef = {
    name: 'tblBS',
    sheet: 'Calcs',
    startRow: 5,
    startCol: 61,
    endRow: 15,
    endCol: 61,
    columns: ['Total Assets'],
    headerRow: true,
    totalsRow: false,
  };

  it('rewrites the real ref but preserves the friendly-name string literal', () => {
    expect(
      rewriteStructuredRefs(
        '=HYPERLINK("#" & CELL("address", tblBS[Total Assets]),"tblBS[Total Assets]")',
        6,
        [table],
      ),
    ).toBe('=HYPERLINK("#" & CELL("address", Calcs!$BJ$7:Calcs!$BJ$16),"tblBS[Total Assets]")');
  });

  it('handles escaped quotes ("") inside string literals', () => {
    expect(
      rewriteStructuredRefs('=SUM(tblBS[Total Assets])&" say ""tblBS[Total Assets]""!"', 0, [table]),
    ).toBe('=SUM(Calcs!$BJ$7:Calcs!$BJ$16)&" say ""tblBS[Total Assets]""!"');
  });

  it('preserves a lone structured ref inside a string literal', () => {
    expect(rewriteStructuredRefs('="tblBS[Total Assets]"', 0, [table])).toBe(
      '="tblBS[Total Assets]"',
    );
  });

  it('rewrites refs when no string literals are present', () => {
    expect(rewriteStructuredRefs('=SUM(tblBS[Total Assets])', 0, [table])).toBe(
      '=SUM(Calcs!$BJ$7:Calcs!$BJ$16)',
    );
  });

  it('round-trips CHKs!G7 from beyond-excel-bxl3way.xlsx', () => {
    const bytes = new Uint8Array(readFileSync(join(REAL, 'beyond-excel-bxl3way.xlsx')));
    const data = new XlsxAdapter().read(bytes);
    const rows = sheetRowsOf(data, 'CHKs');
    expect(rows[6]![6]).toBe(
      '=HYPERLINK("#" & CELL("address", Calcs!$BJ$7:Calcs!$BJ$16),"tblBS[Total Assets]")',
    );
  });
});

describe('bug 2: text cells starting with "=" are not formulas', () => {
  it('keeps One-Var!C1 as the text "=A*B" (real file)', () => {
    const bytes = new Uint8Array(
      readFileSync(join(REAL, 'closedxml-data-table-one-variable.xlsx')),
    );
    const data = new XlsxAdapter().read(bytes);
    const rows = sheetRowsOf(data, 'One-Var');
    // Apostrophe escape: the engine stores this as literal text.
    expect(rows[0]![2]).toBe("'=A*B");
    const { wb } = loadReal('closedxml-data-table-one-variable.xlsx');
    expect(wb.getValue(c('One-Var', 0, 2))).toEqual(scalar('=A*B'));
  });

  it('escapes shared-string cells with "=" content but no <f>', () => {
    const wb = XLSX.utils.book_new();
    const ws: XLSX.WorkSheet = {
      A1: { t: 's', v: '=A*B' }, // text cell, no formula
      A2: { t: 's', v: '=SUM(A1)', f: 'SUM(A1)' }, // formula cell wins via <f>
      A3: { t: 's', v: 'plain' },
      '!ref': 'A1:A3',
    };
    XLSX.utils.book_append_sheet(wb, ws, 'T');
    const data = new XlsxAdapter().read(
      new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer),
    );
    const rows = sheetRowsOf(data, 'T');
    expect(rows[0]![0]).toBe("'=A*B");
    expect(rows[1]![0]).toBe('=SUM(A1)');
    expect(rows[2]![0]).toBe('plain');
  });

  it('write round-trip stores the text without a visible apostrophe', () => {
    const bytes = new Uint8Array(
      readFileSync(join(REAL, 'closedxml-data-table-one-variable.xlsx')),
    );
    const adapter = new XlsxAdapter();
    const out = adapter.write(adapter.read(bytes));
    const parts = unzipSync(out);
    const sheetXml = strFromU8(parts['xl/worksheets/sheet1.xml']!);
    expect(sheetXml).toContain('=A*B');
    expect(sheetXml).not.toContain("'=A*B");
    // And the re-read is stable.
    const back = adapter.read(out);
    expect(sheetRowsOf(back, 'One-Var')[0]![2]).toBe("'=A*B");
  });
});

describe('bug 3: legacy t="array" formulas', () => {
  it('spills the array across its member cells (real file)', () => {
    const { wb } = loadReal('closedxml-xlsx-matrix-multiplication.xlsx');
    expect(wb.getValue(c('Sheet1', 4, 6))).toEqual(scalar(49.2));
    expect(wb.getValue(c('Sheet1', 5, 6))).toEqual(scalar(103.6));
  });

  it('leaves member cells empty for the anchor spill (synthetic)', () => {
    const bytes = rawXlsx(
      SHEET_WRAPPER(
        `<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>` +
          `<row r="2"><c r="A2"><v>3</v></c><c r="B2"><v>4</v></c></row>` +
          `<row r="4"><c r="D4"><f t="array" ref="D4:D5">SUM(A1:B2)</f><v>10</v></c></row>` +
          `<row r="5"><c r="D5"><v>99</v></c></row>`,
      ),
    );
    const data = new XlsxAdapter().read(bytes);
    const rows = sheetRowsOf(data, 'Sheet1');
    expect(rows[3]![3]).toBe('=SUM(A1:B2)');
    // Member cell cleared: the anchor spills into it instead of #SPILL!.
    expect(rows[4]![3]).toBeNull();
  });

  it('keeps cached member values when the anchor formula was dropped', () => {
    const bytes = rawXlsx(
      SHEET_WRAPPER(
        `<row r="4"><c r="D4"><f t="array" ref="D4:D5"></f><v>10</v></c></row>` +
          `<row r="5"><c r="D5"><v>99</v></c></row>`,
      ),
    );
    const data = new XlsxAdapter().read(bytes);
    const rows = sheetRowsOf(data, 'Sheet1');
    // No anchor formula survived: member keeps its cached value (no data loss).
    expect(rows[4]![3]).toBe(99);
  });
});

describe('bug 4: inlined array-constant defined names', () => {
  it('expands Global4 to per-cell values when the spill is blocked (real file)', () => {
    const { wb } = loadReal('closedxml-xlsx-named-ranges-global.xlsx');
    const want = [1, 2, 3, 4, 5, 6];
    let i = 0;
    for (const [r, cc] of [[3, 0], [3, 1], [3, 2], [4, 0], [4, 1], [4, 2]] as const) {
      expect(wb.getValue(c('Sheet2', r, cc))).toEqual(scalar(want[i]!));
      i++;
    }
  });

  it('leaves the spill formula alone when the area is free (synthetic)', () => {
    const wb = XLSX.utils.book_new();
    const ws: XLSX.WorkSheet = { A1: { t: 's', v: 'x' }, '!ref': 'A1:A1' };
    // A3 holds =QZX9 (bare unbindable name -> array constant); B3:C4 empty.
    (ws as Record<string, unknown>)['A3'] = { t: 'n', v: 0, f: 'QZX9' };
    (ws as Record<string, unknown>)['!ref'] = 'A1:C4';
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    (wb as unknown as { Workbook: unknown }).Workbook = {
      Names: [{ Name: 'QZX9', Ref: '{1,2,3;4,5,6}' }],
    };
    const data = new XlsxAdapter().read(
      new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer),
    );
    const rows = sheetRowsOf(data, 'S');
    // Free spill area: the formula stays and the engine spills it.
    expect(rows[2]![0]).toBe('={1,2,3;4,5,6}');
    const initial: Record<string, unknown[][]> = { S: rows.map((r) => [...r]) };
    const ewb = new EngineWorkbook(initial as never, { definedNames: data.definedNames as never });
    expect(ewb.getValue(c('S', 2, 0))).toEqual(scalar(1));
    expect(ewb.getValue(c('S', 2, 2))).toEqual(scalar(3));
    expect(ewb.getValue(c('S', 3, 1))).toEqual(scalar(5));
  });

  it('does not expand non-bare uses like =SUM(name)', () => {
    const wb = XLSX.utils.book_new();
    const ws: XLSX.WorkSheet = { A1: { t: 'n', v: 0, f: 'SUM(QZX9)' }, '!ref': 'A1:A1' };
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    (wb as unknown as { Workbook: unknown }).Workbook = {
      Names: [{ Name: 'QZX9', Ref: '{1,2,3;4,5,6}' }],
    };
    const data = new XlsxAdapter().read(
      new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer),
    );
    const rows = sheetRowsOf(data, 'S');
    expect(rows[0]![0]).toBe('=SUM({1,2,3;4,5,6})');
    const initial: Record<string, unknown[][]> = { S: rows.map((r) => [...r]) };
    const ewb = new EngineWorkbook(initial as never, { definedNames: data.definedNames as never });
    expect(ewb.getValue(c('S', 0, 0))).toEqual(scalar(21));
  });
});

describe('bug 5: GETPIVOTDATA must not cascade #REF! into dependents', () => {
  it('unresolvable GETPIVOTDATA stays #REF! (Excel behavior), HYPERLINK dependents resolve', () => {
    const { wb } = loadReal('beyond-excel-bxl3way.xlsx');
    // The pivot metadata is not imported (OLAP data-model pivots): like
    // Excel with a broken pivot reference, these are #REF!.
    expect(isError(wb.getValue(c('CHKs', 15, 1)))).toBe(true);
    expect(isError(wb.getValue(c('CHKs', 17, 1)))).toBe(true);
    expect(isError(wb.getValue(c('CHKs', 19, 1)))).toBe(true);
    // ...but CELL("address", <errored ref>) still yields the address, so the
    // HYPERLINK cells show their friendly names instead of cascading #REF!.
    expect(wb.getValue(c('CHKs', 7, 6))).toEqual(scalar('Income_Statement_Pivot'));
    expect(wb.getValue(c('CHKs', 8, 6))).toEqual(scalar('Cash_Flow_Pivot'));
    expect(wb.getValue(c('CHKs', 9, 6))).toEqual(scalar('Balance_Sheet_Pivot'));
  });
});
