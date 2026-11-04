/**
 * Tests for batch 9: GETPIVOTDATA, CELL, IMAGE, HYPERLINK.
 *
 * Imports ONLY the new module (plus the external hyperformula/vitest
 * packages): the pivot registry is fed a hand-constructed PivotResultLike,
 * and formulas are evaluated through a plain HyperFormula instance with
 * registerExtendedFunctions9() called explicitly.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { HyperFormula } from 'hyperformula';
import {
  findPivotContaining,
  registerExtendedFunctions9,
  registerPivot,
  unregisterPivot,
  type PivotResultLike,
} from '../src/extended-functions9.js';
import { EngineWorkbook } from '../src/index.js';

registerExtendedFunctions9();

/** HyperFormula 2.x surfaces errors as DetailedCellError (duck-typed: {type}). */
function errType(v: unknown): string | undefined {
  if (v !== null && typeof v === 'object' && 'type' in v) {
    return String((v as { type: unknown }).type);
  }
  return undefined;
}

const PIVOT_ID = 'test-pivot-9';

const pivot: PivotResultLike = {
  rowFieldNames: ['Region'],
  colFieldNames: ['Year'],
  valueLabels: ['Sum of Sales'],
  rowKeys: [['North'], ['South']],
  colKeys: [['2024'], ['2025']],
  data: [
    [[100], [150]],
    [[200], [250]],
  ],
  rowTotals: [[250], [450]],
  colTotals: [[300], [400]],
  grandTotals: [700],
};

function buildHf(): HyperFormula {
  return HyperFormula.buildFromSheets(
    { Sheet1: [[42, 'hello', true]] },
    { licenseKey: 'gpl-v3' },
  );
}

/** Put a formula in A5 and read its evaluated value. */
function evalFormula(hf: HyperFormula, formula: string): unknown {
  hf.setCellContents({ sheet: 0, col: 0, row: 4 }, formula);
  return hf.getCellValue({ sheet: 0, col: 0, row: 4 });
}

beforeEach(() => {
  registerPivot(PIVOT_ID, pivot, { sheet: 0, col: 0, row: 0, cols: 6, rows: 6 });
});

afterEach(() => {
  unregisterPivot(PIVOT_ID);
});

describe('PivotRegistry', () => {
  it('finds a pivot by a cell inside its anchor', () => {
    const found = findPivotContaining(0, 2, 3);
    expect(found?.id).toBe(PIVOT_ID);
    expect(findPivotContaining(0, 9, 9)).toBeUndefined();
    expect(findPivotContaining(1, 0, 0)).toBeUndefined();
  });

  it('unregisterPivot removes the entry', () => {
    unregisterPivot(PIVOT_ID);
    expect(findPivotContaining(0, 0, 0)).toBeUndefined();
  });
});

describe('GETPIVOTDATA', () => {
  it('resolves a fully-specified cell', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=GETPIVOTDATA("Sum of Sales", A1, "Region", "North", "Year", "2024")')).toBe(100);
    expect(evalFormula(hf, '=GETPIVOTDATA("Sum of Sales", A1, "Region", "South", "Year", "2025")')).toBe(250);
    hf.destroy();
  });

  it('matches "Sum of X" against bare "X" and case-insensitively', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=GETPIVOTDATA("sales", A1, "region", "north", "year", "2024")')).toBe(100);
    hf.destroy();
  });

  it('accepts a range as the pivot_table reference', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=GETPIVOTDATA("Sum of Sales", A1:C4, "Region", "South", "Year", "2024")')).toBe(200);
    hf.destroy();
  });

  it('uses totals for unspecified dimensions', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=GETPIVOTDATA("Sum of Sales", A1)')).toBe(700);
    expect(evalFormula(hf, '=GETPIVOTDATA("Sum of Sales", A1, "Region", "North")')).toBe(250);
    expect(evalFormula(hf, '=GETPIVOTDATA("Sum of Sales", A1, "Year", "2025")')).toBe(400);
    hf.destroy();
  });

  it('returns #REF! for unknown fields, items, or missing pivots', () => {
    const hf = buildHf();
    expect(errType(evalFormula(hf, '=GETPIVOTDATA("Sum of Sales", A1, "Nope", "North")'))).toBe('REF');
    expect(errType(evalFormula(hf, '=GETPIVOTDATA("Sum of Sales", A1, "Region", "East")'))).toBe('REF');
    expect(errType(evalFormula(hf, '=GETPIVOTDATA("Sum of Sales", Z99)'))).toBe('REF');
    expect(errType(evalFormula(hf, '=GETPIVOTDATA("Nope", A1)'))).toBe('REF');
    hf.destroy();
  });
});

describe('CELL', () => {
  it('reports address, row and col of a reference', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=CELL("address", B1)')).toBe('$B$1');
    expect(evalFormula(hf, '=CELL("row", B2)')).toBe(2);
    expect(evalFormula(hf, '=CELL("col", C5)')).toBe(3);
    expect(evalFormula(hf, '=CELL("address", AA10)')).toBe('$AA$10');
    hf.destroy();
  });

  it('defaults the reference to the formula\'s own cell', () => {
    const hf = buildHf();
    // Formula lives in A5.
    expect(evalFormula(hf, '=CELL("address")')).toBe('$A$5');
    expect(evalFormula(hf, '=CELL("row")')).toBe(5);
    expect(evalFormula(hf, '=CELL("col")')).toBe(1);
    hf.destroy();
  });

  it('reports type b/l/v', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=CELL("type", A1)')).toBe('v'); // 42
    expect(evalFormula(hf, '=CELL("type", B1)')).toBe('l'); // 'hello'
    expect(evalFormula(hf, '=CELL("type", C1)')).toBe('v'); // true
    expect(evalFormula(hf, '=CELL("type", Z99)')).toBe('b'); // blank
    hf.destroy();
  });

  it('reports contents as the evaluated value', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=CELL("contents", A1)')).toBe(42);
    expect(evalFormula(hf, '=CELL("contents", B1)')).toBe('hello');
    expect(evalFormula(hf, '=CELL("contents", Z99)')).toBe(0);
    hf.destroy();
  });

  it('reports format, protect, prefix, width and empty filename', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=CELL("format", A1)')).toBe('G'); // integer
    expect(evalFormula(hf, '=CELL("format", B1)')).toBe('G'); // text
    expect(evalFormula(hf, '=CELL("protect", A1)')).toBe(0);
    expect(evalFormula(hf, '=CELL("prefix", A1)')).toBe('');
    expect(evalFormula(hf, '=CELL("width", A1)')).toBe(8.43);
    expect(evalFormula(hf, '=CELL("filename", A1)')).toBe('');
    hf.destroy();
  });

  it('rejects unknown info types with #VALUE!', () => {
    const hf = buildHf();
    expect(errType(evalFormula(hf, '=CELL("bogus", A1)'))).toBe('VALUE');
    hf.destroy();
  });

  it('does not propagate the reference\u2019s error for address/row/col', () => {
    // Excel: CELL("address", B20) is "$B$20" even when B20 holds #REF! —
    // the info describes the reference, not its value. (Regression: the
    // #REF! used to cascade into HYPERLINK dependents of GETPIVOTDATA.)
    const hf = buildHf();
    hf.setCellContents({ sheet: 0, col: 1, row: 9 }, '=1/0'); // B10 = #DIV/0!
    expect(evalFormula(hf, '=CELL("address", B10)')).toBe('$B$10');
    expect(evalFormula(hf, '=CELL("row", B10)')).toBe(10);
    expect(evalFormula(hf, '=CELL("col", B10)')).toBe(2);
    hf.destroy();
  });

  it('still propagates the reference\u2019s error for value-dependent info types', () => {
    const hf = buildHf();
    hf.setCellContents({ sheet: 0, col: 1, row: 9 }, '=1/0'); // B10 = #DIV/0!
    expect(errType(evalFormula(hf, '=CELL("contents", B10)'))).toBe('DIV_BY_ZERO');
    expect(errType(evalFormula(hf, '=CELL("type", B10)'))).toBe('DIV_BY_ZERO');
    hf.destroy();
  });

  it('reports the top-left cell for multi-cell ranges (BUG-1)', () => {
    // Excel: CELL("address", A1:B2) is "$A$1"; row/col/contents/type/format
    // likewise describe the top-left cell. Used to return #VALUE! ("Wrong
    // type of argument") because runFunction's SCALAR coercion rejected
    // multi-cell ranges before the plugin ran.
    const hf = buildHf();
    expect(evalFormula(hf, '=CELL("address", A1:B2)')).toBe('$A$1');
    expect(evalFormula(hf, '=CELL("row", A1:B2)')).toBe(1);
    expect(evalFormula(hf, '=CELL("col", A1:B2)')).toBe(1);
    expect(evalFormula(hf, '=CELL("address", B2:C5)')).toBe('$B$2');
    expect(evalFormula(hf, '=CELL("row", B2:C5)')).toBe(2);
    expect(evalFormula(hf, '=CELL("col", B2:C5)')).toBe(2);
    expect(evalFormula(hf, '=CELL("type", A1:B2)')).toBe('v'); // A1 = 42
    expect(evalFormula(hf, '=CELL("contents", A1:B2)')).toBe(42); // top-left
    expect(evalFormula(hf, '=CELL("contents", B1:C2)')).toBe('hello'); // B1
    expect(evalFormula(hf, '=CELL("type", Z98:Z99)')).toBe('b'); // blank
    expect(evalFormula(hf, '=CELL("contents", Z98:Z99)')).toBe(0);
    expect(evalFormula(hf, '=CELL("format", A1:B2)')).toBe('G');
    hf.destroy();
  });

  it('keeps range address info even when the top-left cell errors', () => {
    const hf = buildHf();
    hf.setCellContents({ sheet: 0, col: 0, row: 0 }, '=1/0'); // A1 = #DIV/0!
    expect(evalFormula(hf, '=CELL("address", A1:B2)')).toBe('$A$1');
    expect(evalFormula(hf, '=CELL("row", A1:B2)')).toBe(1);
    expect(errType(evalFormula(hf, '=CELL("contents", A1:B2)'))).toBe('DIV_BY_ZERO');
    hf.destroy();
  });
});

describe('IMAGE', () => {
  it('returns a typed image value', () => {
    const hf = buildHf();
    const v = evalFormula(hf, '=IMAGE("https://example.com/a.png")');
    expect(v).toEqual({ kind: 'image', src: 'https://example.com/a.png', alt: '', sizing: 0 });
    hf.destroy();
  });

  it('passes alt text, sizing and custom dimensions through', () => {
    const hf = buildHf();
    const v = evalFormula(
      hf,
      '=IMAGE("https://example.com/a.png", "A picture", 3, 120, 80)',
    );
    expect(v).toEqual({
      kind: 'image',
      src: 'https://example.com/a.png',
      alt: 'A picture',
      sizing: 3,
      height: 120,
      width: 80,
    });
    hf.destroy();
  });

  it('accepts data: URLs', () => {
    const hf = buildHf();
    const v = evalFormula(hf, '=IMAGE("data:image/png;base64,iVBORw0KGgo=")');
    expect(v).toMatchObject({ kind: 'image', sizing: 0 });
    hf.destroy();
  });

  it('rejects unsafe sources and bad sizing with #VALUE!', () => {
    const hf = buildHf();
    expect(errType(evalFormula(hf, '=IMAGE("javascript:alert(1)")'))).toBe('VALUE');
    expect(errType(evalFormula(hf, '=IMAGE("https://example.com/a.png", "", 9)'))).toBe('VALUE');
    hf.destroy();
  });
});

describe('HYPERLINK', () => {
  it('returns the friendly name when given', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=HYPERLINK("https://example.com", "Example")')).toBe('Example');
    hf.destroy();
  });

  it('returns the link location when no friendly name is given', () => {
    const hf = buildHf();
    expect(evalFormula(hf, '=HYPERLINK("https://example.com")')).toBe('https://example.com');
    expect(evalFormula(hf, '=HYPERLINK("#$B$20")')).toBe('#$B$20');
    hf.destroy();
  });

  it('propagates argument errors', () => {
    const hf = buildHf();
    expect(errType(evalFormula(hf, '=HYPERLINK(1/0, "x")'))).toBe('DIV_BY_ZERO');
    hf.destroy();
  });

  it('composes with CELL("address", ...) over an errored reference', () => {
    // End-to-end of the GETPIVOTDATA cascade: the link target errors, but
    // the hyperlink still resolves to its friendly name.
    const hf = buildHf();
    hf.setCellContents({ sheet: 0, col: 1, row: 9 }, '=1/0'); // B10 = #DIV/0!
    expect(evalFormula(hf, '=HYPERLINK("#" & CELL("address", B10), "jump")')).toBe('jump');
    hf.destroy();
  });
});

describe('GETPIVOTDATA rendered-grid fallback (Cycle-8 audit)', () => {
  // The file-level beforeEach registers a stub pivot covering Sheet1!A1:F6;
  // unregister it here so the grid fallback (not the stub) resolves.
  beforeEach(() => {
    unregisterPivot(PIVOT_ID);
  });
  // Mirrors beyond-excel-bxl3way.xlsx: OLAP/data-model pivots whose caches
  // carry no records are never registered via registerPivot, but their
  // rendered values ARE in the grid. The fallback resolves GETPIVOTDATA
  // from the imported layout + rendered cells (MDX names included).
  function gridWb() {
    // Rendered OLAP pivot on P: field-name row ("Year"), item row
    // (2012..2013), value labels down column A (values on rows).
    return new EngineWorkbook(
      {
        P: [
          [null, 'Year', null],
          ['P', 2012, 2013],
          ['Net Earnings', 100, 200],
          ['Closing Cash Balance', 300, 400],
        ],
        Q: [
          ['=GETPIVOTDATA("[Measures].[Sum of Closing Cash Balance]",P!$A$1,"[tblCal].[Year]","[tblCal].[Year].&[2013]")'],
          ['=GETPIVOTDATA("Net Earnings",P!$A$1,"Year","2012")'],
          ['=GETPIVOTDATA("[Measures].[Sum of Nope]",P!$A$1)'],
        ],
      },
      {
        importedPivots: [
          {
            sheetName: 'P',
            anchor: { row: 0, col: 0, ref: 'A1:C4' },
            rows: [],
            columns: ['[tblCal].[Year].[Year]'],
            values: [{ label: 'Net Earnings' }, { label: 'Closing Cash Balance' }],
            dataOnRows: true,
          },
        ],
      },
    );
  }

  it('resolves an MDX measure + MDX field/item from the rendered grid', () => {
    const wb = gridWb();
    const v: any = wb.getValue({ sheet: 'Q', row: 0, col: 0 });
    expect(v.kind).toBe('number');
    expect(v.value).toBe(400);
  });

  it('resolves plain field/item names', () => {
    const wb = gridWb();
    const v: any = wb.getValue({ sheet: 'Q', row: 1, col: 0 });
    expect(v.kind).toBe('number');
    expect(v.value).toBe(100);
  });

  it('unknown data field is #REF!', () => {
    const wb = gridWb();
    const v: any = wb.getValue({ sheet: 'Q', row: 2, col: 0 });
    expect(v.kind).toBe('error');
    expect(v.code).toBe('#REF!');
  });

  it('registered pivots still take precedence over the grid fallback', () => {
    const wb = new EngineWorkbook({ P: [[1]], Q: [['=GETPIVOTDATA("X",P!$A$1)']] });
    const v: any = wb.getValue({ sheet: 'Q', row: 0, col: 0 });
    expect(v.kind).toBe('error');
    expect(v.code).toBe('#REF!');
  });
});
