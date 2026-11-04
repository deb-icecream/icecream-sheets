/**
 * R1: AGGREGATE options 1/3/5/7 must exclude hidden rows.
 *
 * Mirrors Sheet2 of test-data/real-world/closedxml-xlsx-functions-excel-2010.xlsx:
 * row 6 (0-based index 5) is hidden, C6=96, D6=71; C10/C11 hold nested
 * AGGREGATE/SUBTOTAL calls. Expected values are Excel's cached values from
 * the Cycle-3 formula audit (C19 43.125, D19 8, F19 77, K19 345, K23 448.54…).
 */
import { describe, it, expect } from 'vitest';
import { EngineWorkbook } from '../src/index.js';
import type { TypedValue } from '../src/index.js';

function num(v: TypedValue): number {
  expect(v.kind).toBe('number');
  if (v.kind !== 'number') throw new Error(`expected number, got ${v.kind}`);
  return v.value;
}

/**
 * Sheet2-like fixture. Column C has the hidden row's 96 at index 5 plus two
 * nested subtotal cells at the bottom; column D is plain data with 71 hidden.
 */
function fixture() {
  return {
    S2: [
      [null, null, 15, 8],
      [null, null, 77, 65],
      [null, null, 30, 60],
      [null, null, 28, 63],
      [null, null, 31, 53],
      [null, null, 96, 71], // <- hidden row (index 5)
      [null, null, 77, 55],
      [null, null, 53, 83],
      [null, null, 34, -500],
      [null, null, '=AGGREGATE(1,4,D1:D11)', 91],
      [null, null, '=SUBTOTAL(4,D1:D11)', 89],
    ],
  };
}

function wbWithHidden() {
  return new EngineWorkbook(fixture(), { hiddenRows: { S2: [5] } });
}

describe('AGGREGATE hidden rows (options 1/3/5/7)', () => {
  it('options=1 excludes the hidden row: AVERAGE = 43.125 (Excel C19)', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(1,1,C1:C11)');
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBeCloseTo(43.125, 10);
  });

  it('options=1 excludes the hidden row: COUNT = 8 (Excel D19)', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(2,1,C1:C11)');
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBe(8);
  });

  it('options=1 excludes the hidden row: MAX = 77 (Excel F19)', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(4,1,C1:C11)');
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBe(77);
  });

  it('options=1 excludes the hidden row: SUM = 345 (Excel K19)', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,1,C1:C11)');
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBe(345);
  });

  it('options=1 still drops nested SUBTOTAL/AGGREGATE cells', () => {
    // Without hidden-row filtering the sum would be 441 + 138/11 + 91;
    // 345 proves both the hidden 96 AND the nested C10/C11 are excluded.
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,1,C1:C11)');
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBe(345);
  });

  it('options=5 ignores hidden rows but keeps nested: SUM = 448.545… (Excel K23)', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,5,C1:C11)');
    // 345 + AVERAGE(D1:D11)=138/11 + MAX(D1:D11)=91
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBeCloseTo(448.54545454545456, 10);
  });

  it('options=7 ignores hidden rows and errors but keeps nested: SUM = 448.545…', () => {
    // Like options=5 here (no error cells in C1:C11): nested C10/C11 are
    // KEPT — options 6/7 do not ignore nested SUBTOTAL/AGGREGATE (Excel).
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,7,C1:C11)');
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBeCloseTo(448.54545454545456, 10);
  });

  it('options=6 ignores errors but keeps nested and hidden rows', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,6,C1:C11)');
    // nested kept (+138/11 +91), hidden 96 kept: 441 + 103.545… = 544.545…
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBeCloseTo(544.5454545454545, 10);
  });

  it('options=3 ignores hidden rows and nested: SUM = 345', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,3,C1:C11)');
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBe(345);
  });

  it('options 0/2/4/6 still include hidden rows', () => {
    const wb = wbWithHidden();
    const opts = [0, 2, 4, 6];
    opts.forEach((o, i) => {
      wb.setCell({ sheet: 'S2', row: 12, col: i }, `=AGGREGATE(9,${o},D1:D11)`);
    });
    // D1:D11 has no nested cells; hidden D6=71 stays included for all of 0/2/4/6.
    for (let i = 0; i < opts.length; i++) {
      expect(num(wb.getValue({ sheet: 'S2', row: 12, col: i }))).toBe(138);
    }
  });

  it('options=0 includes the hidden row in a range with nested cells', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,0,C1:C11)');
    // nested C10/C11 dropped, hidden 96 kept: 345 + 96 = 441
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBe(441);
  });

  it('a lone cell reference on a hidden row is excluded (options=1)', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,1,C6)');
    const v = wb.getValue({ sheet: 'S2', row: 12, col: 0 });
    expect(v.kind).toBe('error'); // no values left -> #NUM!
    if (v.kind === 'error') expect(v.code).toBe('#NUM!');
  });

  it('a lone cell reference on a hidden row is kept with options=0', () => {
    const wb = wbWithHidden();
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,0,C6)');
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBe(96);
  });

  it('without hiddenRows info, hidden filtering is inert (backward compatible)', () => {
    const wb = new EngineWorkbook(fixture());
    wb.setCell({ sheet: 'S2', row: 12, col: 0 }, '=AGGREGATE(9,1,C1:C11)');
    // nested dropped, hidden 96 kept: 441
    expect(num(wb.getValue({ sheet: 'S2', row: 12, col: 0 }))).toBe(441);
  });

  it('hidden rows are keyed per sheet', () => {
    const wb = new EngineWorkbook(
      {
        S1: [[10], [20], [30], ['=AGGREGATE(9,1,A1:A3)']],
        S2: [[100], [1], [2], ['=AGGREGATE(9,1,A1:A3)']],
      },
      { hiddenRows: { S2: [0] } },
    );
    // S1 has no hidden rows: 60. S2 hides row 1 (100): 3.
    expect(num(wb.getValue({ sheet: 'S1', row: 3, col: 0 }))).toBe(60);
    expect(num(wb.getValue({ sheet: 'S2', row: 3, col: 0 }))).toBe(3);
  });
});
