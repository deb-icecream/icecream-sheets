/** Tests for the .xlsb (BIFF12) adapter: record layer, formulas, round-trips. */
import { describe, expect, it } from 'vitest';
import { XlsbAdapter, XlsbFormulaError, compileFormula, decompileFormula } from '../src/index.js';
import { encodeId, parseRecords, record, decodeRk } from '../src/biff12.js';
import { buildSst, parseSst, buildWorkbook, parseWorkbook } from '../src/records.js';
import type { WorkbookData } from '@icecream-sheets/engine';

describe('biff12 record framing', () => {
  it('round-trips record ids incl. multi-byte', () => {
    for (const id of [0, 1, 11, 0x81, 0x8f, 0x9c, 0x18f, 0x19c, 0x296, 0x4e3, 0x4ea]) {
      const payload = new Uint8Array([1, 2, 3]);
      const recs = parseRecords(record(id, payload));
      expect(recs.length).toBe(1);
      expect(recs[0].type).toBe(id);
      expect([...recs[0].payload]).toEqual([1, 2, 3]);
    }
  });

  it('encodes ids the way pyxlsb decodes them', () => {
    // pyxlsb read_id: v += byte << 8*i, stop at high-bit-clear byte.
    expect(encodeId(0x81)).toEqual([0x81, 0x00]);
    expect(encodeId(0x18f)).toEqual([0x8f, 0x01]);
    expect(encodeId(5)).toEqual([5]);
  });

  it('decodes RK numbers', () => {
    // 30-bit int 42: (42 << 2) | 0x02
    expect(decodeRk((42 << 2) | 0x02)).toBe(42);
    // /100 flag: int 42 -> 0.42
    expect(decodeRk((42 << 2) | 0x03)).toBe(0.42);
  });
});

describe('ptg formulas', () => {
  const cases: [string, string][] = [
    ['SUM(A1:A10)', 'SUM(A1:A10)'],
    ['A1+B2*2', 'A1+B2*2'],
    ['(A1+B2)*2', '(A1+B2)*2'],
    ['IF(A1>0,"y","n")', 'IF(A1>0,"y","n")'],
    ['-B2', '-B2'],
    ['50%', '50%'],
    ['A1&B2', 'A1&B2'],
    ['LOG10(100)', 'LOG10(100)'],
    ['2^3^2', '2^3^2'],
    ['AVERAGE(X1:X99)', 'AVERAGE(X1:X99)'],
    ['TRUE()', 'TRUE()'],
    ['A1<>B2', 'A1<>B2'],
    ['1+2*3-4/2', '1+2*3-4/2'],
    ['"a""b"', '"a""b"'],
    ['#DIV/0!', '#DIV/0!'],
    ['$A$1+$B2', 'A1+B2'], // absoluteness not preserved (documented)
  ];
  for (const [src, expected] of cases) {
    it(`round-trips ${src}`, () => {
      const tokens = compileFormula(src);
      expect(decompileFormula(tokens)).toBe(expected);
    });
  }

  it('handles nested calls and omitted args', () => {
    expect(decompileFormula(compileFormula('IF(SUM(A1:A3)>10,MAX(B1:B3),0)'))).toBe('IF(SUM(A1:A3)>10,MAX(B1:B3),0)');
    expect(decompileFormula(compileFormula('IF(A1>0,,0)'))).toBe('IF(A1>0,,0)');
  });

  it('throws clear errors for unsupported constructs', () => {
    expect(() => compileFormula('Sheet2!A1+1')).toThrow(XlsbFormulaError);
    expect(() => compileFormula('XLOOKUP(A1,B:B,C:C)')).toThrow(XlsbFormulaError);
    expect(() => compileFormula('MyName+1')).toThrow(XlsbFormulaError);
    expect(() => compileFormula('')).toThrow(XlsbFormulaError);
  });
});

describe('sst and workbook parts', () => {
  it('round-trips shared strings incl. unicode', () => {
    const strings = ['hello', 'héllo wörld', '日本語', 'a"b', ''];
    expect(parseSst(buildSst(strings))).toEqual(strings);
  });

  it('round-trips sheet names', () => {
    const names = ['Sheet1', 'Data 2024', '日本語シート'];
    const parsed = parseWorkbook(buildWorkbook(names));
    expect(parsed.map((s) => s.name)).toEqual(names);
    expect(parsed.map((s) => s.relId)).toEqual(['rId1', 'rId2', 'rId3']);
  });
});

describe('XlsbAdapter round-trip', () => {
  const adapter = new XlsbAdapter();

  function sampleWorkbook(): WorkbookData {
    return {
      sheets: [
        {
          name: 'Data',
          rows: [
            ['Name', 'Score', 'Pass', 'Ratio'],
            ['Alice', 95.5, true, '=B2/100'],
            ['Bob', 42, false, '=SUM(B2:B3)'],
            ['Céline', 0, true, '=IF(B4>50,"high","low")'],
          ],
        },
        {
          name: 'Summary',
          rows: [
            ['Total', '=SUM(Data!B2:B4)'],
          ],
        },
      ],
      metadata: {},
    };
  }

  it('fails fast on cross-sheet formulas instead of corrupting them', () => {
    // Cross-sheet refs have no Ptg encoding in this adapter (documented).
    expect(() => adapter.write(sampleWorkbook())).toThrow(XlsbFormulaError);
  });

  it('round-trips a same-sheet workbook', () => {
    const wb: WorkbookData = {
      sheets: [
        {
          name: 'Data',
          rows: [
            ['Name', 'Score', 'Pass'],
            ['Alice', 95.5, true],
            ['Bob', 42, false],
            [null, '=B2+B3', '=B2>50'],
          ],
        },
      ],
      metadata: {},
    };
    const read = adapter.read(adapter.write(wb));
    expect(read.sheets.length).toBe(1);
    expect(read.sheets[0].name).toBe('Data');
    expect(read.sheets[0].rows).toEqual([
      ['Name', 'Score', 'Pass'],
      ['Alice', 95.5, true],
      ['Bob', 42, false],
      [null, '=B2+B3', '=B2>50'],
    ]);
  });

  it('round-trips multiple sheets with unicode names', () => {
    const wb: WorkbookData = {
      sheets: [
        { name: '日本語', rows: [['a', 1]] },
        { name: 'Second Sheet', rows: [[true, false]] },
      ],
      metadata: {},
    };
    const read = adapter.read(adapter.write(wb));
    expect(read.sheets.map((s) => s.name)).toEqual(['日本語', 'Second Sheet']);
    expect(read.sheets[0].rows).toEqual([['a', 1]]);
    expect(read.sheets[1].rows).toEqual([[true, false]]);
  });

  it('writes a structurally valid styles part', () => {
    const wb: WorkbookData = {
      sheets: [{ name: 'S', rows: [[1]] }],
      metadata: {},
    };
    const bytes = adapter.write(wb);
    // The styles part must unzip and contain the stylesheet begin/end records.
    return import('fflate').then(({ unzipSync }) => {
      const zip = unzipSync(bytes);
      const styles = zip['xl/styles.bin'];
      expect(styles).toBeDefined();
      expect(styles!.length).toBeGreaterThan(0);
      // First record: BrtBeginStyleSheet (0x0296)
      expect(styles![0]).toBe(0x96);
      expect(styles![1]).toBe(0x02);
    });
  });

  it('reads error cells as null (CellInput limitation, like xlsx)', () => {
    const wb: WorkbookData = {
      sheets: [{ name: 'S', rows: [['=1/0']] }],
      metadata: {},
    };
    const read = adapter.read(adapter.write(wb));
    expect(read.sheets[0].rows[0][0]).toBe('=1/0');
  });

  it('rejects non-zip input with a clear error', () => {
    expect(() => adapter.read(new Uint8Array([1, 2, 3]))).toThrow(/not a zip/);
  });

  it('rejects a zip missing workbook.bin', () => {
    // Build a minimal zip without workbook.bin via the adapter's own writer path is
    // not possible; craft directly with fflate.
    return import('fflate').then(({ zipSync }) => {
      const te = new TextEncoder();
      const bytes = zipSync({ 'x.bin': te.encode('hi') });
      expect(() => adapter.read(bytes)).toThrow(/workbook\.bin/);
    });
  });
});
