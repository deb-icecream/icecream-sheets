import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import {
  applySpillsToSheetXml,
  isDynamicArrayFormula,
  parseSheetSpills,
  parseSpillRefsFromFormula,
  spillCellsXml,
  spillFormulaXml,
  spillsEqual,
  type SpillRange,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = (name: string): string => join(HERE, '..', '..', '..', 'test-data', 'real-world', name);

const SHEET_HEAD =
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
const SHEET_TAIL = '</sheetData></worksheet>';

/** Synthetic modern dynamic-array spill, as Excel 365 stores it. */
const MODERN_XML =
  SHEET_HEAD +
  '<row r="1"><c r="A1"><f t="array" ref="A1:C3">SEQUENCE(3,3)</f><v>1</v></c>' +
  '<c r="B1"><v>2</v></c><c r="C1"><v>3</v></c></row>' +
  '<row r="2"><c r="A2"><v>4</v></c><c r="B2"><v>5</v></c><c r="C2"><v>6</v></c></row>' +
  '<row r="3"><c r="A3"><v>7</v></c><c r="B3"><v>8</v></c><c r="C3"><v>9</v></c></row>' +
  '<row r="5"><c r="A5"><f>SUM(A1#)</f><v>45</v></c></row>' +
  SHEET_TAIL;

/** Synthetic legacy CSE array formula (the xlsxwriter/ClosedXML shape). */
const LEGACY_XML =
  SHEET_HEAD +
  '<row r="1"><c r="A1"><f t="array" ref="A1:A3">SUM(B1:C1*B2:C2)</f><v>0</v></c>' +
  '<c r="A2"><v>0</v></c><c r="A3"><v>0</v></c></row>' +
  SHEET_TAIL;

function sheetXmlOfPackage(bytes: Uint8Array, partSuffix: string): string {
  const files = unzipSync(bytes.slice()) as Record<string, Uint8Array>;
  const key = Object.keys(files).find((k) => k.endsWith(partSuffix));
  expect(key).toBeDefined();
  return new TextDecoder().decode(files[key as string] as Uint8Array);
}

describe('spillMetadata parse', () => {
  it('parses a modern dynamic spill as typed metadata, not static neighbours', () => {
    const { spills, spillRefs } = parseSheetSpills(MODERN_XML);
    expect(spills).toHaveLength(1);
    const s = spills[0] as SpillRange;
    expect(s.anchor).toEqual({ row: 0, col: 0, ref: 'A1' });
    expect(s.ref).toBe('A1:C3');
    expect(s.formula).toBe('SEQUENCE(3,3)');
    expect(s.kind).toBe('dynamic');
    expect(s.cachedValues).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    // The SUM(A1#) formula in A5 is a spill REFERENCE, not a spill.
    expect(spillRefs).toHaveLength(1);
    expect(spillRefs[0]).toMatchObject({
      anchor: { row: 0, col: 0, ref: 'A1' },
      text: 'A1#',
      fromRow: 4,
      fromCol: 0,
    });
  });

  it('classifies legacy CSE formulas as legacy but keeps formula + ref exact', () => {
    const { spills } = parseSheetSpills(LEGACY_XML);
    expect(spills).toHaveLength(1);
    expect(spills[0]).toMatchObject({
      ref: 'A1:A3',
      formula: 'SUM(B1:C1*B2:C2)',
      kind: 'legacy',
    });
    expect(spills[0]?.cachedValues).toEqual([[0], [0], [0]]);
  });

  it('parses real legacy array files from test-data', () => {
    const xlsxwriter = sheetXmlOfPackage(
      new Uint8Array(readFileSync(REAL('xlsxwriter-array_formula01.xlsx'))),
      'worksheets/sheet1.xml',
    );
    const w = parseSheetSpills(xlsxwriter);
    expect(w.spills.length).toBeGreaterThanOrEqual(1);
    const anchor = w.spills.find((s) => s.anchor.ref === 'A1');
    expect(anchor).toBeDefined();
    expect(anchor?.ref).toBe('A1:A3');
    expect(anchor?.kind).toBe('legacy');

    const closedxml = sheetXmlOfPackage(
      new Uint8Array(readFileSync(REAL('closedxml-xlsx-matrix-multiplication.xlsx'))),
      'worksheets/sheet1.xml',
    );
    const c = parseSheetSpills(closedxml);
    const mmult = c.spills.find((s) => s.anchor.ref === 'G5');
    expect(mmult).toBeDefined();
    expect(mmult?.ref).toBe('G5:G6');
    expect(mmult?.formula).toBe('MMULT(A1:C2,E1:E3)');
    expect(mmult?.cachedValues[0]?.[0]).toBe(49.2);
  });

  it('resolves shared-string cached members when a table is supplied', () => {
    const xml =
      SHEET_HEAD +
      '<row r="1"><c r="A1" t="str"><f t="array" ref="A1:B1">TEXTSPLIT("a,b",",")</f><v>a</v></c>' +
      '<c r="B1" t="s"><v>1</v></c></row>' +
      SHEET_TAIL;
    // Without the table the s-typed member cannot resolve (null, not a throw).
    expect(parseSheetSpills(xml).spills[0]?.cachedValues).toEqual([['a', null]]);
    // With it, the member resolves.
    expect(parseSheetSpills(xml, { sharedStrings: ['x', 'b'] }).spills[0]?.cachedValues)
      .toEqual([['a', 'b']]);
  });

  it('never throws on corrupt input; corrupt cells yield fewer entries', () => {
    expect(parseSheetSpills('')).toEqual({ spills: [], spillRefs: [] });
    expect(parseSheetSpills('<worksheet><sheetData><row><c><f t="array" ref="ZZZ">X</f></c>')).toEqual({
      spills: [],
      spillRefs: [],
    });
    // A corrupt second spill does not drop the good first one.
    const mixed =
      SHEET_HEAD +
      '<row r="1"><c r="A1"><f t="array" ref="A1:B1">SEQUENCE(1,2)</f><v>1</v></c><c r="B1"><v>2</v></c></row>' +
      '<row r="2"><c r="A2"><f t="array" ref="bogus">SEQUENCE(1)</f><v>1</v></c></row>' +
      SHEET_TAIL;
    const { spills } = parseSheetSpills(mixed);
    expect(spills).toHaveLength(2);
    expect(spills[0]?.ref).toBe('A1:B1');
    // No ref → single-cell extent at the anchor, formula preserved.
    expect(spills[1]?.ref).toBe('A2');
  });
});

describe('spillMetadata spill refs', () => {
  it('parses bare, absolute, and sheet-qualified spill refs', () => {
    expect(parseSpillRefsFromFormula('SUM(A1#)')).toMatchObject([
      { anchor: { ref: 'A1' }, text: 'A1#' },
    ]);
    expect(parseSpillRefsFromFormula('SUM($A$1#)')).toMatchObject([
      { anchor: { ref: 'A1' }, text: '$A$1#' },
    ]);
    expect(parseSpillRefsFromFormula("SUM('My Data'!$B$2#)")).toMatchObject([
      { anchor: { ref: 'B2' }, sheet: 'My Data', text: "'My Data'!$B$2#" },
    ]);
    expect(parseSpillRefsFromFormula('SUM(Data!C3#)')).toMatchObject([
      { anchor: { ref: 'C3' }, sheet: 'Data' },
    ]);
  });

  it('does not mistake string literals or error literals for spill refs', () => {
    expect(parseSpillRefsFromFormula('"A1#"')).toEqual([]);
    expect(parseSpillRefsFromFormula('IF(A1="#DIV/0!",1,2)')).toEqual([]);
    expect(parseSpillRefsFromFormula('FOOA1#')).toEqual([]);
  });

  it('classifies dynamic functions at any nesting depth', () => {
    expect(isDynamicArrayFormula('SEQUENCE(3)')).toBe(true);
    expect(isDynamicArrayFormula('SUM(FILTER(A1:A5,A1:A5>10))')).toBe(true);
    expect(isDynamicArrayFormula('_xlfn._xlws.FILTER(A1:A5,TRUE)')).toBe(true);
    expect(isDynamicArrayFormula('MMULT(A1:C2,E1:E3)')).toBe(false);
    expect(isDynamicArrayFormula('SUM(A1:A5)')).toBe(false);
    expect(isDynamicArrayFormula('"FILTER("')).toBe(false);
  });
});

describe('spillMetadata write → re-parse identity', () => {
  it('round-trips a modern spill through apply + re-parse', () => {
    const { spills } = parseSheetSpills(MODERN_XML);
    const rewritten = applySpillsToSheetXml(MODERN_XML, spills);
    const back = parseSheetSpills(rewritten);
    expect(spillsEqual(back.spills, spills)).toBe(true);
    // The spill-ref formula survives untouched.
    expect(back.spillRefs).toHaveLength(1);
    expect(back.spillRefs[0]?.text).toBe('A1#');
  });

  it('round-trips after shrinking the extent and changing cached values', () => {
    const { spills } = parseSheetSpills(MODERN_XML);
    const edited: SpillRange = {
      ...(spills[0] as SpillRange),
      endRow: 1,
      endCol: 1,
      ref: 'A1:B2',
      cachedValues: [
        [10, 20],
        [30, 40],
      ],
    };
    const rewritten = applySpillsToSheetXml(MODERN_XML, [edited]);
    const back = parseSheetSpills(rewritten);
    expect(back.spills).toHaveLength(1);
    expect(back.spills[0]).toMatchObject({ ref: 'A1:B2', formula: 'SEQUENCE(3,3)' });
    expect(back.spills[0]?.cachedValues).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it('writes a spill into a sheet that lacks the member cells', () => {
    const bare =
      SHEET_HEAD +
      '<row r="1"><c r="A1"><f>SEQUENCE(2)</f><v>1</v></c></row>' +
      SHEET_TAIL;
    const spill: SpillRange = {
      anchor: { row: 0, col: 0, ref: 'A1' },
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 0,
      ref: 'A1:A2',
      formula: 'SEQUENCE(2)',
      kind: 'dynamic',
      cachedValues: [[1], [2]],
    };
    const rewritten = applySpillsToSheetXml(bare, [spill]);
    const back = parseSheetSpills(rewritten);
    expect(back.spills).toHaveLength(1);
    expect(back.spills[0]?.cachedValues).toEqual([[1], [2]]);
    expect(spillFormulaXml(spill)).toBe('<f t="array" ref="A1:A2">SEQUENCE(2)</f>');
    expect(spillCellsXml(spill)).toHaveLength(2);
  });

  it('never throws on corrupt write input', () => {
    const spill: SpillRange = {
      anchor: { row: 0, col: 0, ref: 'A1' },
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      ref: 'A1',
      formula: 'SEQUENCE(1)',
      kind: 'dynamic',
      cachedValues: [[1]],
    };
    expect(applySpillsToSheetXml('', [spill])).toBe('');
    expect(applySpillsToSheetXml('not xml at all', [spill])).toBe('not xml at all');
  });
});
