/**
 * ACCRINT basis-3 (Actual/365) regression battery.
 *
 * Added by the function-coverage successor coordinator (2026-10-21) while
 * chasing a classified "ACCRINT basis-3 numeric defect" from the Phase 2
 * consolidated engine-suite run (progress.md Phase 2 row). The expected
 * values are computed independently of the engine: for basis 3 with
 * calc_method TRUE, Excel's documented ACCRINT formula
 * (par x rate/freq x SUM(Ai/NLi), NLi = 365/freq) telescopes to
 * par x rate x (actual days issue->settlement)/365; with calc_method
 * FALSE and settlement after first_interest, accrual runs from
 * first_interest instead. Day counts below were verified by hand.
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook, type TypedValue } from '../src/index.js';

function ev(formula: string): number {
  const wb = new EngineWorkbook({ S: [[formula]] });
  const v: TypedValue = wb.getValue({ sheet: 'S', row: 0, col: 0 });
  if (v.kind !== 'number') throw new Error(`expected number, got ${JSON.stringify(v)}`);
  return v.value as number;
}

describe('ACCRINT basis 3 (actual/365)', () => {
  it('semiannual, settlement in first quasi period: 61 days', () => {
    // 2011-03-01 -> 2011-05-01 = 61 actual days.
    expect(ev('=ACCRINT(DATE(2011,3,1),DATE(2011,8,31),DATE(2011,5,1),0.1,1000,2,3)'))
      .toBeCloseTo((1000 * 0.1 * 61) / 365, 9);
  });
  it('annual frequency: 181 days', () => {
    // 2010-01-15 -> 2010-07-15 = 181 actual days.
    expect(ev('=ACCRINT(DATE(2010,1,15),DATE(2011,1,15),DATE(2010,7,15),0.08,5000,1,3)'))
      .toBeCloseTo((5000 * 0.08 * 181) / 365, 9);
  });
  it('quarterly, leap-year issue date: 46 days', () => {
    // 2012-02-29 -> 2012-04-15 = 46 actual days.
    expect(ev('=ACCRINT(DATE(2012,2,29),DATE(2012,5,31),DATE(2012,4,15),0.06,2000,4,3)'))
      .toBeCloseTo((2000 * 0.06 * 46) / 365, 9);
  });
  it('settlement after first_interest, calc TRUE: 427 days total', () => {
    // 2011-03-01 -> 2012-05-01 = 427 actual days (spans two quasi periods).
    expect(ev('=ACCRINT(DATE(2011,3,1),DATE(2011,8,31),DATE(2012,5,1),0.1,1000,2,3,TRUE)'))
      .toBeCloseTo((1000 * 0.1 * 427) / 365, 9);
  });
  it('settlement after first_interest, calc FALSE: accrues from first_interest (244 days)', () => {
    // 2011-08-31 -> 2012-05-01 = 244 actual days.
    expect(ev('=ACCRINT(DATE(2011,3,1),DATE(2011,8,31),DATE(2012,5,1),0.1,1000,2,3,FALSE)'))
      .toBeCloseTo((1000 * 0.1 * 244) / 365, 9);
  });
  it('odd LONG first period: 167 days', () => {
    // 2010-11-15 -> 2011-05-01 = 167 actual days.
    expect(ev('=ACCRINT(DATE(2010,11,15),DATE(2011,8,31),DATE(2011,5,1),0.1,1000,2,3)'))
      .toBeCloseTo((1000 * 0.1 * 167) / 365, 9);
  });
  it('frequency 12 is rejected with #NUM! (Excel allows only 1, 2, 4)', () => {
    const wb = new EngineWorkbook({
      S: [['=ACCRINT(DATE(2013,1,31),DATE(2013,5,31),DATE(2013,4,15),0.05,10000,12,3)']],
    });
    const v = wb.getValue({ sheet: 'S', row: 0, col: 0 });
    expect(v.kind).toBe('error');
    if (v.kind === 'error') expect(v.code).toBe('#NUM!');
  });
});
