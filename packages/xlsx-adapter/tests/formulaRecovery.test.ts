import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter } from '../src/adapter.js';
import {
  decodeRef,
  recoverSheetFormulas,
  sheetPartPaths,
  translateSharedFormula,
} from '../src/formulaRecovery.js';

describe('translateSharedFormula', () => {
  it('shifts relative refs by the slave offset', () => {
    expect(translateSharedFormula('B3/C3', 7, 0)).toBe('B10/C10');
  });
  it('shifts both axes of a range', () => {
    expect(translateSharedFormula('SUM(A1:B2)', 1, 1)).toBe('SUM(B2:C3)');
  });
  it('leaves absolute axes unmoved', () => {
    expect(translateSharedFormula('SUM($A$1:A5)', 3, 0)).toBe('SUM($A$1:A8)');
    expect(translateSharedFormula('$A1+A$1', 1, 1)).toBe('$A2+B$1');
  });
  it('keeps string literals verbatim', () => {
    expect(translateSharedFormula('"A1"&A1', 1, 1)).toBe('"A1"&B2');
    expect(translateSharedFormula('"say ""hi"" A1"&A1', 1, 0)).toBe('"say ""hi"" A1"&A2');
  });
  it('does not touch function names containing ref-like text', () => {
    expect(translateSharedFormula('LOG10(A1)', 1, 0)).toBe('LOG10(A2)');
  });
  it('keeps sheet-qualified and 3D refs qualified', () => {
    expect(translateSharedFormula("'My Sheet'!A1+A1", 0, 1)).toBe("'My Sheet'!B1+B1");
    expect(translateSharedFormula('Sheet1:Sheet3!A1', 1, 1)).toBe('Sheet1:Sheet3!B2');
    expect(translateSharedFormula("'O''Brien'!A1", 1, 0)).toBe("'O''Brien'!A2");
  });
  it('leaves #REF! and defined names alone', () => {
    expect(translateSharedFormula('#REF!+A1', 2, 0)).toBe('#REF!+A3');
    expect(translateSharedFormula('MyName+A1', 1, 0)).toBe('MyName+A2');
  });
  it('emits #REF! when a ref is shifted out of the grid', () => {
    expect(translateSharedFormula('A1+XFD1048576', 1, 0)).toBe('A2+#REF!');
    expect(translateSharedFormula('A1', -1, 0)).toBe('#REF!');
  });
  it('returns the formula unchanged for a zero offset', () => {
    expect(translateSharedFormula('B3/C3', 0, 0)).toBe('B3/C3');
  });
});

describe('sheetPartPaths', () => {
  const enc = new TextEncoder();
  const pkg = (target: string): Record<string, Uint8Array> => ({
    'xl/workbook.xml': enc.encode(
      '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': enc.encode(
      `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/></Relationships>`,
    ),
  });
  it('resolves relative targets against xl/', () => {
    expect(sheetPartPaths(pkg('worksheets/sheet1.xml')).get('Data')).toBe('xl/worksheets/sheet1.xml');
  });
  it('normalizes absolute part URIs (leading slash)', () => {
    expect(sheetPartPaths(pkg('/xl/worksheets/sheet1.xml')).get('Data')).toBe('xl/worksheets/sheet1.xml');
  });
  it('keeps already-prefixed targets unchanged', () => {
    expect(sheetPartPaths(pkg('xl/worksheets/sheet1.xml')).get('Data')).toBe('xl/worksheets/sheet1.xml');
  });
});

describe('decodeRef', () => {
  it('decodes A1 refs to 0-based coordinates', () => {
    expect(decodeRef('A1')).toEqual({ r: 0, c: 0 });
    expect(decodeRef('XFD1048576')).toEqual({ r: 1048575, c: 16383 });
  });
  it('rejects malformed refs', () => {
    expect(decodeRef('A0')).toBeNull();
    expect(decodeRef('XFE1')).toBeNull();
    expect(decodeRef('A1048577')).toBeNull();
    expect(decodeRef('1A')).toBeNull();
  });
});

const SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:B2"/>
<sheetData>
<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>B2+B3</f></c></row>
<row r="2"><c r="A2"/><c r="B2"><f t="shared" si="1" ref="B2:B4">A2*2</f></c></row>
<row r="3"><c r="B3"><f t="shared" si="1"/></c></row>
<row r="4"><c r="B4"><f t="shared" si="1" /></c><c r="C4"><f t="array" ref="C4:C5">SUM(A1:A2)</f></c></row>
<row r="5"><c r="A5" t="e"><v>#DIV/0!</v></c></row>
</sheetData></worksheet>`;

describe('recoverSheetFormulas', () => {
  it('recovers formulas SheetJS drops (no cached <v>) and translates shared slaves', () => {
    // Simulate SheetJS having parsed only A1 (value) and nothing else.
    const { formulas, maxRow, maxCol } = recoverSheetFormulas(SHEET_XML, (ref) => ref === 'A1');
    expect(maxRow).toBe(4);
    expect(maxCol).toBe(2);
    expect(formulas.get('B1')).toBe('B2+B3');
    expect(formulas.get('B2')).toBe('A2*2');
    expect(formulas.get('B3')).toBe('A3*2');
    expect(formulas.get('B4')).toBe('A4*2');
    expect(formulas.get('C4')).toBe('SUM(A1:A2)');
    // Bare error cell has no formula to recover.
    expect(formulas.has('A5')).toBe(false);
  });
  it('never overwrites cells SheetJS already parsed', () => {
    const { formulas } = recoverSheetFormulas(SHEET_XML, () => true);
    expect(formulas.size).toBe(0);
  });
  it('unions <dimension> with out-of-dimension <c> refs', () => {
    const { maxRow, maxCol } = recoverSheetFormulas(SHEET_XML, () => true);
    expect(maxRow).toBe(4); // C4/B4 row 4 > dimension A1:B2
    expect(maxCol).toBe(2);
  });
  it('does not span matches across elements (self-closing <c/> skipped)', () => {
    const xml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"/><c r="B1"><v>5</v></c></row></sheetData></worksheet>`;
    const { formulas, maxRow, maxCol } = recoverSheetFormulas(xml, () => false);
    expect(formulas.size).toBe(0);
    expect(maxRow).toBe(0);
    expect(maxCol).toBe(1);
  });
  it('unescapes XML entities in formula text', () => {
    const xml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>IF(B1&gt;0,C1&amp;\"x\",0)</f></c></row></sheetData></worksheet>`;
    const { formulas } = recoverSheetFormulas(xml, () => false);
    expect(formulas.get('A1')).toBe('IF(B1>0,C1&"x",0)');
  });
});

describe('XlsxAdapter formula recovery (real-world regression)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');
  const adapter = new XlsxAdapter();
  const cellAt = (sheetName: string, ref: string): unknown => {
    const wb = adapter.read(
      new Uint8Array(readFileSync(join(dir, 'xlsxpopulate-ranges-out.xlsx'))),
    );
    const sheet = wb.sheets.find((s) => s.name === sheetName);
    const rc = decodeRef(ref);
    return rc ? sheet?.rows[rc.r]?.[rc.c] : undefined;
  };

  it('recovers shared formulas without cached values (xlsx-populate)', () => {
    expect(cellAt('ClickThroughRateSheet', 'D3')).toBe('=B3/C3');
    expect(cellAt('ClickThroughRateSheet', 'D10')).toBe('=B10/C10');
    expect(cellAt('ClickThroughRateSheet', 'D13')).toBe('=B13/C13');
  });

  it('keeps cells outside a stale <dimension> (xlsx-populate rows 10-13)', () => {
    expect(cellAt('ClickThroughRateSheet', 'B10')).toBe(853);
    expect(cellAt('ClickThroughRateSheet', 'C10')).toBe(889534);
    expect(cellAt('ClickThroughRateSheet', 'B13')).toBe(254);
    expect(cellAt('ClickThroughRateSheet', 'C13')).toBe(727259);
  });

  it('recovers formulas and out-of-dimension cells (excelize)', () => {
    const wb = adapter.read(new Uint8Array(readFileSync(join(dir, 'excelize-Book1.xlsx'))));
    const sheet = wb.sheets.find((s) => s.name === 'Sheet2');
    const at = (ref: string): unknown => {
      const rc = decodeRef(ref);
      return rc ? sheet?.rows[rc.r]?.[rc.c] : undefined;
    };
    expect(at('E1')).toBe('inlineStr'); // parsed by SheetJS but outside stale <dimension>
    expect(at('E11')).toBe('=B2+B3');
    expect(at('F11')).toBe('=IF(B2>0, (D2/B2)*100, 0)');
    expect(at('H11')).toBe('=IF(D2>0, (F2/D2)*100, 0)'); // shared slave translated +2 cols
    expect(at('I11')).toBe('=IF(D2>0, (F2/D2)*100, 0)'); // si=1 slave, same +2 col shift from G11
  });
});
