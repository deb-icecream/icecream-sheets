/**
 * Slice 1 (audit §9.4): `_xlfn.` future-function prefixing on write.
 *
 * Excel stores every post-2007 function prefixed (`_xlfn.IFNA`), dynamic
 * functions have been seen as `_xlfn._xlws.FILTER`, and LAMBDA
 * parameters as `_xlfn._xlpm.x`. Import strips the prefixes (the engine
 * works bare); the write side must put them back.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { XlsxAdapter } from '../src/index.js';
import {
  FUTURE_FUNCTIONS,
  prefixFutureFunctions,
  stripFuturePrefixes,
} from '../src/futureFunctions.js';
import { parseWorksheetXml, sheetXmlChunks } from '../src/index.js';

const dec = new TextDecoder();

function sheetXmlOf(bytes: Uint8Array, part = 'xl/worksheets/sheet1.xml'): string {
  const parts = unzipSync(bytes.slice());
  return dec.decode(parts[part] as Uint8Array);
}

describe('prefixFutureFunctions (tokenizer)', () => {
  it('prefixes the task-listed 365 functions', () => {
    for (const name of [
      'IFNA', 'IFS', 'SWITCH', 'TEXTJOIN', 'CONCAT', 'MAXIFS', 'MINIFS',
      'XLOOKUP', 'XMATCH', 'FILTER', 'SORT', 'SORTBY', 'UNIQUE', 'SEQUENCE',
      'RANDARRAY', 'SINGLE', 'LET', 'LAMBDA', 'MAP', 'REDUCE', 'SCAN',
      'BYROW', 'BYCOL', 'MAKEARRAY', 'ISOMITTED', 'GROUPBY', 'PIVOTBY',
      'TRIMRANGE', 'TEXTBEFORE', 'TEXTAFTER', 'TEXTSPLIT', 'VSTACK',
      'HSTACK', 'TAKE', 'DROP', 'EXPAND', 'TOCOL', 'TOROW', 'WRAPROWS',
      'WRAPCOLS', 'ARRAYTOTEXT', 'VALUETOTEXT', 'REGEXTEST', 'REGEXEXTRACT',
      'REGEXREPLACE', 'IMAGE', 'FIELDVALUE', 'STOCKHISTORY', 'TRANSLATE',
      'DETECTLANGUAGE',
    ]) {
      expect(FUTURE_FUNCTIONS.has(name), name).toBe(true);
      expect(prefixFutureFunctions(`${name}(A1)`)).toBe(`_xlfn.${name}(A1)`);
    }
  });

  it('prefixes MS-XLSX 2010/2013 future functions incl. dotted names', () => {
    expect(prefixFutureFunctions('STDEV.S(A1:A9)+AGGREGATE(1,2,B1:B9)')).toBe(
      '_xlfn.STDEV.S(A1:A9)+_xlfn.AGGREGATE(1,2,B1:B9)',
    );
    expect(prefixFutureFunctions('IFERROR(IFNA(A1,0),1)')).toBe(
      'IFERROR(_xlfn.IFNA(A1,0),1)',
    );
  });

  it('leaves 2007 functions and plain references bare', () => {
    expect(prefixFutureFunctions('SUM(A1:B2)+IF(C1,VLOOKUP(D1,E:F,2),0)')).toBe(
      'SUM(A1:B2)+IF(C1,VLOOKUP(D1,E:F,2),0)',
    );
  });

  it('does not touch string literals, quoted sheet names or defined-name refs', () => {
    expect(prefixFutureFunctions('CONCAT("TEXTJOIN(",A1)')).toBe(
      '_xlfn.CONCAT("TEXTJOIN(",A1)',
    );
    expect(prefixFutureFunctions("'My Sheet'!A1+FILTER")).toBe("'My Sheet'!A1+FILTER");
    expect(prefixFutureFunctions('TEXTJOIN(", ",TRUE,MyList)')).toBe(
      '_xlfn.TEXTJOIN(", ",TRUE,MyList)',
    );
  });

  it('does not double-prefix already-prefixed names', () => {
    expect(prefixFutureFunctions('_xlfn.IFNA(A1,0)')).toBe('_xlfn.IFNA(A1,0)');
    expect(prefixFutureFunctions('_xlfn._xlws.FILTER(A1,B1)')).toBe('_xlfn._xlws.FILTER(A1,B1)');
    expect(prefixFutureFunctions(prefixFutureFunctions('SORT(A1)'))).toBe('_xlfn.SORT(A1)');
  });

  it('survives structured references and external-book brackets', () => {
    expect(prefixFutureFunctions('SUM(Table1[Amount])+TEXTJOIN(",",TRUE,Table1[Name])')).toBe(
      'SUM(Table1[Amount])+_xlfn.TEXTJOIN(",",TRUE,Table1[Name])',
    );
  });

  it('never prefixes a call to a defined name (LAMBDA stored in a name)', () => {
    expect(
      prefixFutureFunctions('TEXTJOIN(A1)+DOUBLEIT(A2)', { definedNames: ['TEXTJOIN', 'DoubleIt'] }),
    ).toBe('TEXTJOIN(A1)+DOUBLEIT(A2)');
  });

  it('prefixes LAMBDA itself and its parameters with _xlpm', () => {
    expect(prefixFutureFunctions('LAMBDA(x,y,x*y+1)')).toBe(
      '_xlfn.LAMBDA(_xlfn._xlpm.x,_xlfn._xlpm.y,_xlfn._xlpm.x*_xlfn._xlpm.y+1)',
    );
    expect(prefixFutureFunctions('MAP(A1:A3,LAMBDA(v,v*2))')).toBe(
      '_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlfn._xlpm.v,_xlfn._xlpm.v*2))',
    );
  });

  it('stripFuturePrefixes is the import-side inverse', () => {
    expect(stripFuturePrefixes('_xlfn._xlws.FILTER(A1)+_xlfn.IFNA(B1,0)')).toBe('FILTER(A1)+IFNA(B1,0)');
    expect(stripFuturePrefixes('_xlfn.LAMBDA(_xlfn._xlpm.x,_xlfn._xlpm.x+1)')).toBe('LAMBDA(x,x+1)');
  });
});

describe('_xlfn write round-trip (classic adapter)', () => {
  it('writes _xlfn. into sheet XML and reads back the bare originals', () => {
    const adapter = new XlsxAdapter();
    const formulas = [
      '=IFNA(VLOOKUP(A1,B:C,2,FALSE),0)',
      '=TEXTJOIN(", ",TRUE,A1:A3)',
      '=XLOOKUP(A1,B:B,C:C)',
      '=SUM(FILTER(D1:D9,E1:E9>2))',
      '=LET(x,SEQUENCE(3),SUM(x))',
      '=SUM(A1:A3)',
    ];
    const bytes = adapter.write({
      sheets: [{ name: 'S', rows: [formulas] }],
      metadata: {},
    });
    const xml = sheetXmlOf(bytes);
    expect(xml).toContain('_xlfn.IFNA(');
    expect(xml).toContain('_xlfn.TEXTJOIN(');
    expect(xml).toContain('_xlfn.XLOOKUP(');
    expect(xml).toContain('_xlfn.FILTER(');
    expect(xml).toContain('_xlfn.LET(');
    expect(xml).toContain('_xlfn.SEQUENCE(');
    expect(xml).not.toContain('_xlfn.SUM(');
    expect(xml).not.toContain('_xlfn.VLOOKUP(');
    expect(xml).not.toContain('_xlfn._xlfn');

    const back = adapter.read(bytes);
    expect(back.sheets[0]!.rows[0]).toEqual(formulas);
  });

  it('writes a LAMBDA defined name with _xlfn.LAMBDA and _xlpm params', () => {
    const adapter = new XlsxAdapter();
    const bytes = adapter.write({
      sheets: [{ name: 'S', rows: [[1]] }],
      metadata: {},
      definedNames: [{ name: 'DOUBLEIT', ref: 'LAMBDA(x,x*2)' }],
    });
    const parts = unzipSync(bytes.slice());
    const wbXml = dec.decode(parts['xl/workbook.xml'] as Uint8Array);
    expect(wbXml).toContain('_xlfn.LAMBDA(_xlfn._xlpm.x,_xlfn._xlpm.x*2)');
    const back = adapter.read(bytes);
    const dn = back.definedNames?.find((d) => d.name === 'DOUBLEIT');
    expect(dn?.ref.replace(/^=/, '')).toBe('LAMBDA(x,x*2)');
  });

  it('streaming writer (sheetXmlChunks) prefixes formulas too', () => {
    const xml = [...sheetXmlChunks({
      sourceXml: null,
      cells: [{ row: 0, col: 0, input: '=SORT(UNIQUE(A1:A5))' }],
      xfFor: () => 0,
    })].join('');
    expect(xml).toContain('_xlfn.SORT(_xlfn.UNIQUE(');
  });

  it('fast parser strips _xlws / _xlpm prefixes on import', () => {
    const xml =
      '<worksheet><sheetData><row r="1">' +
      '<c r="A1"><f>_xlfn._xlws.SORT(B1:B3)</f><v>0</v></c>' +
      '<c r="A2"><f>_xlfn.LAMBDA(_xlfn._xlpm.x,_xlfn._xlpm.x+1)</f><v>0</v></c>' +
      '</row></sheetData></worksheet>';
    const r = parseWorksheetXml(xml, [], []);
    expect(r.rows[0]![0]).toBe('=SORT(B1:B3)');
    expect(r.rows[1]![0]).toBe('=LAMBDA(x,x+1)');
  });
});
