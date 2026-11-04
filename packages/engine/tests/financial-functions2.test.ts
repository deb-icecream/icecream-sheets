/**
 * Tests for financial-functions2.ts: AMORDEGRC, AMORLINC, COUPDAYBS,
 * COUPDAYSNC, COUPNCD, COUPPCD, PRICEMAT, YIELDMAT.
 *
 * Expected values are verified against Excel's documented examples
 * (Microsoft Support) and hand-computed day counts:
 * - AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1) = 776
 * - AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1) = 360
 * - AMORDEGRC(2000,DATE(2020,2,1),DATE(2020,12,31),10,4,0.1,0) = 163
 *   and AMORLINC(...) = 200 (documented linear/degressive examples)
 * - COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),2,1) = 71
 * - COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,15),2,1) = 110
 * - COUPNCD(...) -> 2011-05-15 (serial 40678), COUPPCD(...) -> 2010-11-15 (40497)
 * - PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,0)
 *   = 99.98449888
 * - YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,0)
 *   = 0.06095433369
 */
import { describe, expect, it } from 'vitest';
import { HyperFormula } from 'hyperformula';
import { registerFinancialFunctions2 } from '../src/financial-functions2.js';

registerFinancialFunctions2();

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
  // getCellValue surfaces errors as DetailedCellError objects; duck-type the
  // `.type` field the same way EngineWorkbook does.
  expect(typeof v).toBe('object');
  expect(v).not.toBeNull();
  const t = (v as { type?: unknown }).type;
  expect(typeof t).toBe('string');
  return t as string;
}

describe('AMORDEGRC', () => {
  it("matches Excel's documented example (period 1 -> 776)", () => {
    const hf = build(['=AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1)']);
    // Excel documents 776; full-precision value is 776.4344
    // (period 0 = 2400 x 0.375 x 134/366 actual/actual, period 1 on book value)
    expect(num(hf, 0)).toBeCloseTo(776.434, 2);
  });

  it('prorates period 0 by actual/actual yearfrac', () => {
    const hf = build(['=AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,0,0.15,1)']);
    // 2400 x (0.15 x 2.5) x 134/366 = 329.508 (2008 is a leap year)
    expect(num(hf, 0)).toBeCloseTo(329.508, 2);
  });

  it('matches the documented degressive example (period 4 -> 163)', () => {
    const hf = build(['=AMORDEGRC(2000,DATE(2020,2,1),DATE(2020,12,31),10,4,0.1,0)']);
    // 162.5977; documented as 163
    expect(num(hf, 0)).toBeCloseTo(162.598, 2);
  });

  it('caps cumulative depreciation at cost - salvage and then returns 0', () => {
    const hf = build([
      '=AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,5,0.15,1)',
      '=AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,6,0.15,1)',
      '=AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,30,0.15,1)',
    ]);
    // Final partial period: 2100 - (329.51+776.43+485.27+303.29+189.56) = 15.93
    expect(num(hf, 0)).toBeCloseTo(15.93, 1);
    expect(num(hf, 1)).toBe(0);
    expect(num(hf, 2)).toBe(0);
  });

  it('returns #NUM! for an asset life between 4 and 5 years', () => {
    const hf = build(['=AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,1/4.5,1)']);
    expect(errKind(hf, 0)).toBe('NUM');
  });

  it('returns #NUM! for invalid basis, negative cost, or purchased > first period', () => {
    const hf = build([
      '=AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,5)',
      '=AMORDEGRC(-5,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1)',
      '=AMORDEGRC(2400,DATE(2009,1,1),DATE(2008,12,31),300,1,0.15,1)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
    expect(errKind(hf, 2)).toBe('NUM');
  });
});

describe('AMORLINC', () => {
  it("matches Excel's documented example (period 1 -> 360)", () => {
    const hf = build(['=AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1)']);
    expect(num(hf, 0)).toBeCloseTo(360, 8);
  });

  it('matches the documented linear example (period 4 -> 200)', () => {
    const hf = build(['=AMORLINC(2000,DATE(2020,2,1),DATE(2020,12,31),10,4,0.1,0)']);
    expect(num(hf, 0)).toBeCloseTo(200, 8);
  });

  it('prorates period 0 on a 30/360 basis', () => {
    const hf = build(['=AMORLINC(2000,DATE(2020,2,1),DATE(2020,12,31),10,0,0.1,0)']);
    // 200 x 330/360 = 183.333
    expect(num(hf, 0)).toBeCloseTo(183.333, 2);
  });

  it('caps at salvage in the final period and returns 0 afterwards', () => {
    const hf = build([
      '=AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,6,0.15,1)',
      '=AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,9,0.15,1)',
    ]);
    // 2100 - (131.80 + 5x360) = 168.20
    expect(num(hf, 0)).toBeCloseTo(168.2, 1);
    expect(num(hf, 1)).toBe(0);
  });

  it('returns #NUM! for salvage > cost or rate <= 0', () => {
    const hf = build([
      '=AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),9999,1,0.15,1)',
      '=AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0,1)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
  });
});

describe('COUPDAYBS', () => {
  it("matches Excel's documented example (-> 71)", () => {
    const hf = build(['=COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),2,1)']);
    expect(num(hf, 0)).toBe(71);
  });

  it('uses 30/360 US day count with basis 0 (-> 70)', () => {
    const hf = build(['=COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),2,0)']);
    // 360 + 30x(1-11) + (25-15) = 70
    expect(num(hf, 0)).toBe(70);
  });

  it('accepts ISO date strings like Excel', () => {
    const hf = build(['=COUPDAYBS("2011-1-25",DATE(2011,11,15),2,1)']);
    expect(num(hf, 0)).toBe(71);
  });

  it('returns #NUM! for bad frequency / settlement >= maturity / bad basis', () => {
    const hf = build([
      '=COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),3,1)',
      '=COUPDAYBS(DATE(2011,11,15),DATE(2011,11,15),2,1)',
      '=COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),2,-1)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
    expect(errKind(hf, 2)).toBe('NUM');
  });

  it('returns #VALUE! for an unparseable date', () => {
    const hf = build(['=COUPDAYBS("not a date",DATE(2011,11,15),2,1)']);
    expect(errKind(hf, 0)).toBe('VALUE');
  });
});

describe('COUPDAYSNC', () => {
  it("matches Excel's documented example (-> 110)", () => {
    const hf = build(['=COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,15),2,1)']);
    expect(num(hf, 0)).toBe(110);
  });

  it('distinguishes actual vs 30/360 day counts', () => {
    const hf = build([
      '=COUPDAYSNC(DATE(2011,1,31),DATE(2011,11,15),2,1)',
      '=COUPDAYSNC(DATE(2011,1,31),DATE(2011,11,15),2,0)',
    ]);
    // actual: 28+31+30+15 = 104; 30/360 US: 30x4 + (15-30) = 105
    expect(num(hf, 0)).toBe(104);
    expect(num(hf, 1)).toBe(105);
  });

  it('returns #NUM! for invalid frequency', () => {
    const hf = build(['=COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,15),6,1)']);
    expect(errKind(hf, 0)).toBe('NUM');
  });
});

describe('COUPNCD', () => {
  it("matches Excel's documented example (-> 2011-05-15)", () => {
    const hf = build(['=COUPNCD(DATE(2011,1,25),DATE(2011,11,15),2,1)']);
    expect(num(hf, 0)).toBe(40678); // serial of 2011-05-15
  });

  it('steps quarterly coupons back from maturity', () => {
    const hf = build(['=COUPNCD(DATE(2020,5,10),DATE(2022,1,15),4,0)']);
    expect(num(hf, 0)).toBe(44027); // serial of 2020-07-15
  });

  it('returns #NUM! for invalid frequency or basis', () => {
    const hf = build([
      '=COUPNCD(DATE(2011,1,25),DATE(2011,11,15),12,1)',
      '=COUPNCD(DATE(2011,1,25),DATE(2011,11,15),2,9)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
  });
});

describe('COUPPCD', () => {
  it("matches Excel's documented example (-> 2010-11-15)", () => {
    const hf = build(['=COUPPCD(DATE(2011,1,25),DATE(2011,11,15),2,1)']);
    expect(num(hf, 0)).toBe(40497); // serial of 2010-11-15
  });

  it('matches the Exceljet example (-> 2019-07-01)', () => {
    const hf = build(['=COUPPCD(DATE(2019,9,1),DATE(2029,1,1),2,0)']);
    expect(num(hf, 0)).toBe(43647); // serial of 2019-07-01
  });

  it('returns #NUM! when settlement >= maturity', () => {
    const hf = build(['=COUPPCD(DATE(2011,11,15),DATE(2011,11,15),2,1)']);
    expect(errKind(hf, 0)).toBe('NUM');
  });
});

describe('PRICEMAT', () => {
  it("matches Excel's documented example (-> 99.98449888)", () => {
    const hf = build([
      '=PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(99.98449888, 6);
  });

  it('inverts the YIELDMAT documented example (-> ~100.0123)', () => {
    const hf = build([
      '=PRICEMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,0.06095433369,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(100.0123, 4);
  });

  it('handles actual/actual basis with hand-verified day counts', () => {
    const hf = build([
      '=PRICEMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,0.06095433369,1)',
    ]);
    // DIM=361, DSM=233, A=128, B=365 -> 100.01288379
    expect(num(hf, 0)).toBeCloseTo(100.01288379, 6);
  });

  it('returns #NUM! for negative yield or invalid basis', () => {
    const hf = build([
      '=PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,-0.01,0)',
      '=PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,7)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
  });
});

describe('YIELDMAT', () => {
  it("matches Excel's documented example (-> 0.06095433369)", () => {
    const hf = build([
      '=YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,0)',
    ]);
    expect(num(hf, 0)).toBeCloseTo(0.06095433369, 8);
  });

  it('round-trips through PRICEMAT', () => {
    const hf = build([
      '=PRICEMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,0.07,0)',
      '=YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,A1,0)',
    ]);
    expect(num(hf, 1)).toBeCloseTo(0.07, 8);
  });

  it('returns #NUM! for non-positive price or negative rate', () => {
    const hf = build([
      '=YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,0,0)',
      '=YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),-0.01,100.0123,0)',
    ]);
    expect(errKind(hf, 0)).toBe('NUM');
    expect(errKind(hf, 1)).toBe('NUM');
  });
});
