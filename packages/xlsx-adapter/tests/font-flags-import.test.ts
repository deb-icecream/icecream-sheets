/**
 * Issue #81 — xlsx import dropped bold/italic when the producer wrote the
 * OOXML explicit-true boolean form `<b val="1"/>` / `<i val="1"/>`
 * (SheetJS's styles dialect, and valid CT_BooleanProperty per ECMA-376:
 * element present = true unless val is 0/false). parseFont only matched
 * the bare `<b/>` / `<b>` forms and the explicit-false forms, so the
 * explicit-true forms fell through and the flags vanished — font name,
 * size and color (value-carrying elements) survived, which is why a bold
 * Tahoma 14 cell imported as plain Tahoma 14.
 *
 * These tests pin the whole import chain (styles.xml -> parseFont ->
 * styleFromXf -> SheetData.styles) for every boolean form, plus the
 * neighboring flags that must keep surviving.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { XlsxAdapter, parseFont } from '../src/index.js';

describe('parseFont boolean-property forms (OOXML CT_BooleanProperty)', () => {
  it('bare forms are true', () => {
    expect(parseFont('<font><b/></font>').bold).toBe(true);
    expect(parseFont('<font><b></b></font>').bold).toBe(true);
    expect(parseFont('<font><i/></font>').italic).toBe(true);
  });

  it('explicit-true forms are true (the #81 defect)', () => {
    expect(parseFont('<font><b val="1"/></font>').bold).toBe(true);
    expect(parseFont('<font><b val="true"/></font>').bold).toBe(true);
    expect(parseFont('<font><i val="1"/></font>').italic).toBe(true);
    expect(parseFont('<font><i val="true"/></font>').italic).toBe(true);
  });

  it('explicit-false forms are false', () => {
    expect(parseFont('<font><b val="0"/></font>').bold).toBe(false);
    expect(parseFont('<font><b val="false"/></font>').bold).toBe(false);
    expect(parseFont('<font><i val="0"/></font>').italic).toBe(false);
    expect(parseFont('<font><i val="false"/></font>').italic).toBe(false);
  });

  it('strikethrough follows the same boolean-property forms (folded into #81)', () => {
    expect(parseFont('<font><strike/></font>').strikethrough).toBe(true);
    expect(parseFont('<font><strike val="1"/></font>').strikethrough).toBe(true);
    expect(parseFont('<font><strike val="true"/></font>').strikethrough).toBe(true);
    expect(parseFont('<font><strike val="0"/></font>').strikethrough).toBe(false);
    expect(parseFont('<font><sz val="11"/></font>').strikethrough).toBeUndefined();
  });

  it('absent elements stay absent', () => {
    const p = parseFont('<font><sz val="11"/></font>');
    expect(p.bold).toBeUndefined();
    expect(p.italic).toBeUndefined();
  });
});

// --- End-to-end fixture in the SheetJS styles dialect (the dialect of the
// file the #77 probes caught this on): <name> first, then <b val="1"/> etc.

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="6"><font><name val="Calibri"/><family val="2"/><color theme="1"/><sz val="11"/><scheme val="minor"/></font><font><name val="Tahoma"/><b val="1"/><sz val="14"/></font><font><name val="Courier New"/><i val="1"/><sz val="10"/></font><font><name val="Calibri"/><b val="true"/><i val="true"/><sz val="11"/></font><font><name val="Calibri"/><b val="1"/><color rgb="FFFF0000"/><sz val="11"/></font><font><name val="Calibri"/><u/><sz val="11"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6"><si><t>plain</t></si><si><t>bold</t></si><si><t>italic</t></si><si><t>bolditalic</t></si><si><t>bold-red</t></si><si><t>underline</t></si></sst>`;

const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" s="1" t="s"><v>1</v></c></row><row r="3"><c r="A3" s="2" t="s"><v>2</v></c></row><row r="4"><c r="A4" s="3" t="s"><v>3</v></c></row><row r="5"><c r="A5" s="4" t="s"><v>4</v></c></row><row r="6"><c r="A6" s="5" t="s"><v>5</v></c></row></sheetData></worksheet>`;

function buildFixture(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/styles.xml': strToU8(STYLES),
    'xl/sharedStrings.xml': strToU8(SHARED_STRINGS),
    'xl/worksheets/sheet1.xml': strToU8(SHEET),
  });
}

describe('#81 — explicit-true font flags survive adapter.read', () => {
  const back = new XlsxAdapter().read(buildFixture());
  const styles = back.sheets[0]!.styles ?? {};

  it('bold cell (the issue example: bold Tahoma 14)', () => {
    expect(styles['1:0']).toEqual({ bold: true, fontName: 'Tahoma', fontSize: 14 });
  });

  it('italic cell', () => {
    expect(styles['2:0']).toEqual({ italic: true, fontName: 'Courier New', fontSize: 10 });
  });

  it('bold+italic cell', () => {
    expect(styles['3:0']).toEqual({ bold: true, italic: true });
  });

  it('bold + font color keep surviving together', () => {
    expect(styles['4:0']).toEqual({ bold: true, fontColor: '#FF0000' });
  });

  it('underline neighbor still survives', () => {
    expect(styles['5:0']).toEqual({ underline: true });
  });

  it('non-bold cell stays non-bold (no style entry)', () => {
    expect(styles['0:0']).toBeUndefined();
  });
});
