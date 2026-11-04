/**
 * Tests for financial-functions3.ts: ODDFPRICE, ODDFYIELD, ODDLPRICE,
 * ODDLYIELD (odd first / last coupon period bond functions).
 *
 * Expected values for the Microsoft cases are the worked examples on
 * Microsoft's Support pages (full-precision values as published on
 * Microsoft's DAX reference pages, which use the same examples):
 * - ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),
 *     DATE(2009,3,1),0.0785,0.0625,100,2,1) = 113.5977
 * - ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),
 *     DATE(2009,3,1),0.0575,84.50,100,2,0) = 0.0772455415972989
 * - ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),
 *     0.0375,0.0405,100,2,0) = 99.8782860147213
 * - ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),
 *     0.0375,99.875,100,2,0) = 0.04519 (full precision 0.04519223563)
 *
 * The short/long quasi-coupon cases were computed independently from
 * Microsoft's documented algorithms (quasi-coupon DCi/NLi sums, segment
 * discounting Nq + DSC/E for the odd-first functions, and the published
 * odd-last equation), and are additionally cross-checked by price<->yield
 * round-trips through the paired function in the same sheet.
 */
import { describe, expect, it } from 'vitest';
import { HyperFormula } from 'hyperformula';
import { registerFinancialFunctions3 } from '../src/financial-functions3.js';

registerFinancialFunctions3();

function build(formulas: string[]): HyperFormula {
  return HyperFormula.buildFromArray([formulas], { licenseKey: 'gpl-v3' });
}

function cellValue(hf: HyperFormula, col: number): unknown {
  return hf.getCellValue({ sheet: 0, row: 0, col });
}

function num(hf: HyperFormula, col: number): number {
  const v = cellValue(hf, col);
  expect(typeof v).toBe('number');
  return v as number;
}

function errKind(hf: HyperFormula, col: number): string {
  const v = cellValue(hf, col);
  expect(typeof v).toBe('object');
  expect(v).not.toBeNull();
  const t = (v as { type?: unknown }).type;
  expect(typeof t).toBe('string');
  return t as string;
}

describe('ODDFPRICE', () => {
  it("matches Microsoft's documented example (short first, basis 1 -> 113.5977)", () => {
    const hf = build([
      '=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)',
    ]);
    // Microsoft documents 113.5977; full precision 113.59771747
    expect(num(hf, 0)).toBeCloseTo(113.59771747, 6);
  });

  it('matches the ODDFYIELD documented example inverted (-> ~84.50)', () => {
    const hf = build([
      '=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0575,0.0772455415972989,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(84.5, 6);
  });

  it('short first period: quarterly, actual/actual (hand-computed -> 102.97124246)', () => {
    // Issue 2020-02-10 -> first coupon 2020-04-15 is ~0.72 of a quarterly
    // quasi period (65 of 91 actual days), so the first coupon is scaled.
    const hf = build([
      '=ODDFPRICE(DATE(2020,3,1),DATE(2023,4,15),DATE(2020,2,10),DATE(2020,4,15),0.04,0.03,100,4,1)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(102.97124246, 6);
  });

  it('long first period: issue->first spans two quasi periods (-> 104.76317878)', () => {
    // Issue 2019-01-15 -> first coupon 2019-09-15 spans a partial quasi
    // period (60/180) plus a full one, so the first coupon is 4.00 on a
    // 6% semiannual bond instead of the regular 3.00.
    const hf = build([
      '=ODDFPRICE(DATE(2019,3,1),DATE(2024,9,15),DATE(2019,1,15),DATE(2019,9,15),0.06,0.05,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(104.76317878, 6);
  });

  it('accepts omitted basis (defaults to 0) and ISO date strings', () => {
    const hf = build([
      '=ODDFPRICE(DATE(2019,3,1),DATE(2024,9,15),DATE(2019,1,15),DATE(2019,9,15),0.06,0.05,100,2)',
      '=ODDFPRICE("2008-11-11",DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(104.76317878, 6);
    expect(num(hf, 1)).toBeCloseTo(113.59771747, 6);
  });

  it('returns #NUM! when the date condition maturity > first > settlement > issue fails', () => {
    const hf = build([
      // issue after settlement
      '=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,12,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)',
      // settlement after first coupon
      '=ODDFPRICE(DATE(2009,4,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)',
      // first coupon after maturity
      '=ODDFPRICE(DATE(2008,11,11),DATE(2009,1,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
    expect(errKind(hf, 2)).toBe('NUM');
  });

  it('returns #NUM! for negative rate/yield, non-positive redemption, bad frequency or basis', () => {
    const hf = build([
      '=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),-0.01,0.0625,100,2,1)',
      '=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,-0.01,100,2,1)',
      '=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,0,2,1)',
      '=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,3,1)',
      '=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,5)',
    ]);
    for (let c = 0; c < 5; c++) expect(errKind(hf, c)).toBe('NUM');
  });

  it('returns #VALUE! for an unparseable date or a non-numeric rate', () => {
    const hf = build([
      '=ODDFPRICE("not a date",DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)',
      '=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),"abc",0.0625,100,2,1)',
    ]);
    expect(errKind(hf, 0)).toBe('VALUE');
    expect(errKind(hf, 1)).toBe('VALUE');
  });
});

describe('ODDFYIELD', () => {
  it("matches Microsoft's documented example (-> 0.0772455415972989)", () => {
    const hf = build([
      '=ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0575,84.50,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(0.0772455415972989, 10);
  });

  it('short first period: inverts the ODDFPRICE short case (-> 0.03)', () => {
    const hf = build([
      '=ODDFYIELD(DATE(2020,3,1),DATE(2023,4,15),DATE(2020,2,10),DATE(2020,4,15),0.04,102.9712424615673,100,4,1)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(0.03, 8);
  });

  it('long first period: inverts the ODDFPRICE long case (-> 0.05)', () => {
    const hf = build([
      '=ODDFYIELD(DATE(2019,3,1),DATE(2024,9,15),DATE(2019,1,15),DATE(2019,9,15),0.06,104.76317877632654,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(0.05, 8);
  });

  it('round-trips through ODDFPRICE inside the sheet', () => {
    const hf = build([
      '=ODDFPRICE(DATE(2019,3,1),DATE(2024,9,15),DATE(2019,1,15),DATE(2019,9,15),0.06,0.043,100,2,4)',
      '=ODDFYIELD(DATE(2019,3,1),DATE(2024,9,15),DATE(2019,1,15),DATE(2019,9,15),0.06,A1,100,2,4)',
    ]);
    expect(num(hf, 1)).toBeCloseTo(0.043, 8);
  });

  it('returns #NUM! for non-positive price, negative rate, or bad date order', () => {
    const hf = build([
      '=ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0575,0,100,2,0)',
      '=ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),-0.01,84.50,100,2,0)',
      '=ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2009,10,15),DATE(2009,3,1),0.0575,84.50,100,2,0)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
    expect(errKind(hf, 2)).toBe('NUM');
  });

  it('returns #VALUE! for an unparseable date', () => {
    const hf = build([
      '=ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),"junk",DATE(2009,3,1),0.0575,84.50,100,2,0)',
    ]);
    expect(errKind(hf, 0)).toBe('VALUE');
  });
});

describe('ODDLPRICE', () => {
  it("matches Microsoft's documented example (-> 99.8782860147213)", () => {
    const hf = build([
      '=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(99.8782860147213, 8);
  });

  it('matches the ODDLYIELD documented example inverted (-> ~99.875)', () => {
    const hf = build([
      '=ODDLPRICE(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,0.04519223562916898,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(99.875, 6);
  });

  it('short last period: maturity inside the first quasi period (-> 100.13428645)', () => {
    // Last interest 2020-01-15 -> maturity 2020-05-10 is 115 of 180
    // 30/360 days of a semiannual quasi period, so the final coupon is
    // scaled to 115/180 of the regular 2.25.
    const hf = build([
      '=ODDLPRICE(DATE(2020,3,20),DATE(2020,5,10),DATE(2020,1,15),0.045,0.035,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(100.13428645, 6);
  });

  it('long last period: maturity spans three quasi periods (-> 100.49707325)', () => {
    // Last interest 2019-01-31 -> maturity 2020-03-15 spans two full
    // semiannual quasi periods plus 45/180 of a third, so the final
    // coupon is 2.25 x the regular 2.50.
    const hf = build([
      '=ODDLPRICE(DATE(2019,8,15),DATE(2020,3,15),DATE(2019,1,31),0.05,0.04,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(100.49707325, 6);
  });

  it('returns #NUM! when maturity > settlement > last_interest fails', () => {
    const hf = build([
      // last interest after settlement
      '=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2008,3,15),0.0375,0.0405,100,2,0)',
      // settlement after maturity
      '=ODDLPRICE(DATE(2008,7,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,2,0)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
  });

  it('returns #NUM! for negative rate/yield, non-positive redemption, bad frequency or basis', () => {
    const hf = build([
      '=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),-0.01,0.0405,100,2,0)',
      '=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,-0.01,100,2,0)',
      '=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,0,2,0)',
      '=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,12,0)',
      '=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,2,-1)',
    ]);
    for (let c = 0; c < 5; c++) expect(errKind(hf, c)).toBe('NUM');
  });

  it('returns #VALUE! for an unparseable date or a non-numeric yield', () => {
    const hf = build([
      '=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),"not a date",0.0375,0.0405,100,2,0)',
      '=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,"abc",100,2,0)',
    ]);
    expect(errKind(hf, 0)).toBe('VALUE');
    expect(errKind(hf, 1)).toBe('VALUE');
  });
});

describe('ODDLYIELD', () => {
  it("matches Microsoft's documented example (-> 0.04519223563)", () => {
    const hf = build([
      '=ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,99.875,100,2,0)',
    ]);
    // Microsoft documents 0.04519 (4.52%); full precision 0.04519223563
    expect(num(hf, 0)).toBeCloseTo(0.04519223563, 8);
  });

  it('matches the ODDLPRICE documented example inverted (-> 0.0405)', () => {
    const hf = build([
      '=ODDLYIELD(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,99.8782860147213,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(0.0405, 8);
  });

  it('short last period: inverts the ODDLPRICE short case (-> 0.035)', () => {
    const hf = build([
      '=ODDLYIELD(DATE(2020,3,20),DATE(2020,5,10),DATE(2020,1,15),0.045,100.13428645473392,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(0.035, 8);
  });

  it('long last period: inverts the ODDLPRICE long case (-> 0.04)', () => {
    const hf = build([
      '=ODDLYIELD(DATE(2019,8,15),DATE(2020,3,15),DATE(2019,1,31),0.05,100.4970732457569,100,2,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(0.04, 8);
  });

  it('round-trips through ODDLPRICE inside the sheet', () => {
    const hf = build([
      '=ODDLPRICE(DATE(2019,8,15),DATE(2020,3,15),DATE(2019,1,31),0.05,0.027,100,2,3)',
      '=ODDLYIELD(DATE(2019,8,15),DATE(2020,3,15),DATE(2019,1,31),0.05,A1,100,2,3)',
    ]);
    expect(num(hf, 1)).toBeCloseTo(0.027, 8);
  });

  it('returns #NUM! for non-positive price, negative rate, or bad date order', () => {
    const hf = build([
      '=ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,0,100,2,0)',
      '=ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),-0.01,99.875,100,2,0)',
      '=ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2008,5,24),0.0375,99.875,100,2,0)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
    expect(errKind(hf, 2)).toBe('NUM');
  });

  it('returns #VALUE! for an unparseable date', () => {
    const hf = build([
      '=ODDLYIELD("junk",DATE(2008,6,15),DATE(2007,12,24),0.0375,99.875,100,2,0)',
    ]);
    expect(errKind(hf, 0)).toBe('VALUE');
  });
});

describe('frequency / basis coverage', () => {
  it('annual frequency (1) and European basis (4) round-trip (odd first)', () => {
    const hf = build([
      '=ODDFPRICE(DATE(2020,6,1),DATE(2026,3,15),DATE(2020,1,20),DATE(2021,3,15),0.05,0.041,100,1,4)',
      '=ODDFYIELD(DATE(2020,6,1),DATE(2026,3,15),DATE(2020,1,20),DATE(2021,3,15),0.05,A1,100,1,4)',
    ]);
    expect(num(hf, 1)).toBeCloseTo(0.041, 8);
  });

  it('quarterly frequency (4) and actual/360 basis (2) round-trip (odd last)', () => {
    const hf = build([
      '=ODDLPRICE(DATE(2021,5,10),DATE(2021,11,20),DATE(2021,2,28),0.06,0.052,100,4,2)',
      '=ODDLYIELD(DATE(2021,5,10),DATE(2021,11,20),DATE(2021,2,28),0.06,A1,100,4,2)',
    ]);
    expect(num(hf, 1)).toBeCloseTo(0.052, 8);
  });
});
