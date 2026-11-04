/**
 * Phase-2 function-coverage tests: living/modern FINANCIAL functions that
 * previously had no gold or unit coverage (see
 * hidden_files/function-coverage/TEST-COVERAGE-AUDIT.md).
 *
 * Expected values are Microsoft Support's worked examples (cited per test)
 * or are computed independently in plain JS from the formula Microsoft
 * documents for the function — never by calling the engine.
 *
 * Cases where the engine originally disagreed with Microsoft's documented
 * result were recorded as FOUND DEFECTS D1–D10 / D23 / D24 in the audit
 * file. All were fixed in Phase 2 (2026-10-21) and promoted from it.fails
 * to plain `it` — this suite is now a plain regression suite.
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook, type TypedValue } from '../src/index.js';

/** Evaluate a batch of formulas in ONE workbook (one row each). */
function evalMap(formulas: string[]): (formula: string) => TypedValue {
  const wb = new EngineWorkbook({ S: formulas.map((f) => [f]) });
  const map = new Map(
    formulas.map((f, i) => [f, wb.getValue({ sheet: 'S', row: i, col: 0 })] as const),
  );
  return (f) => {
    const v = map.get(f);
    if (!v) throw new Error(`formula not in batch: ${f}`);
    return v;
  };
}
function num(v: TypedValue): number {
  if (v.kind !== 'number') throw new Error(`expected number, got ${JSON.stringify(v)}`);
  return v.value as number;
}
function errCode(v: TypedValue): string {
  if (v.kind !== 'error') throw new Error(`expected error, got ${JSON.stringify(v)}`);
  return v.code;
}

// ---------------------------------------------------------------- ACCRINT
describe('ACCRINT', () => {
  const ev = evalMap([
    '=ACCRINT(DATE(2011,3,1),DATE(2011,8,31),DATE(2011,5,1),0.1,1000,2,0)',
    '=ACCRINT(DATE(2008,3,5),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0,FALSE)',
    '=ACCRINT(DATE(2008,4,5),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0,TRUE)',
    '=ACCRINT(DATE(2011,3,1),DATE(2011,8,31),DATE(2011,5,1),0.1,1000,2,3)',
  ]);
  // Microsoft Support, ACCRINT function: the three worked examples return
  // 16.666667, 15.555556 (calc_method FALSE) and 7.2222222 (TRUE).
  it('matches the Microsoft example (16.666667)', () => {
    expect(num(ev('=ACCRINT(DATE(2011,3,1),DATE(2011,8,31),DATE(2011,5,1),0.1,1000,2,0)')))
      .toBeCloseTo(16.666667, 4);
  });
  it('calc_method FALSE example (15.555556)', () => {
    expect(num(ev('=ACCRINT(DATE(2008,3,5),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0,FALSE)')))
      .toBeCloseTo(15.555556, 4);
  });
  it('calc_method TRUE example (7.2222222)', () => {
    expect(num(ev('=ACCRINT(DATE(2008,4,5),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0,TRUE)')))
      .toBeCloseTo(7.2222222, 4);
  });
  it('basis 3 (actual/365): par x rate x actual days / 365', () => {
    // Mar 1 -> May 1 is 61 actual days; 1000 x 0.1 x 61/365.
    expect(num(ev('=ACCRINT(DATE(2011,3,1),DATE(2011,8,31),DATE(2011,5,1),0.1,1000,2,3)')))
      .toBeCloseTo((1000 * 0.1 * 61) / 365, 9);
  });
});

// ---------------------------------------------------------------- ACCRINTM
describe('ACCRINTM', () => {
  const ev = evalMap([
    '=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,3)',
    '=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,0)',
    '=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,2)',
  ]);
  // Microsoft Support, ACCRINTM function: issue 2008-04-01, maturity
  // 2008-06-15, rate 10%, par 1000, basis 3 (actual/365) -> 20.54794521
  // (= 1000 x 0.1 x 75 actual days / 365).
  it('matches the Microsoft example, basis 3 (20.54794521)', () => {
    expect(num(ev('=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,3)')))
      .toBeCloseTo(20.54794521, 6);
  });
  it('basis 0 uses 30/360 days (74)', () => {
    expect(num(ev('=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,0)')))
      .toBeCloseTo((1000 * 0.1 * 74) / 360, 9);
  });
  it('basis 2 (actual/360) is exact', () => {
    expect(num(ev('=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,2)')))
      .toBeCloseTo((1000 * 0.1 * 75) / 360, 9);
  });
});

// ---------------------------------------------------------------- COUPDAYS / COUPNUM
describe('COUPDAYS and COUPNUM', () => {
  const ev = evalMap([
    '=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,1)',
    '=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,0)',
    '=COUPNUM(DATE(2007,1,25),DATE(2008,11,15),2,1)',
    '=COUPNUM(DATE(2011,1,25),DATE(2011,11,15),2,1)',
  ]);
  // Microsoft Support, COUPDAYS function: settlement 2011-01-25, maturity
  // 2011-11-15, semiannual, basis 1 -> 181 (the Nov 15 -> May 15 period).
  it('COUPDAYS matches the Microsoft example (181)', () => {
    expect(num(ev('=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,1)'))).toBe(181);
  });
  it('COUPDAYS basis 0 is 180 (30/360 half-year)', () => {
    expect(num(ev('=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,0)'))).toBe(180);
  });
  // Microsoft Support, COUPNUM function: 2007-01-25 -> 2008-11-15 -> 4.
  it('COUPNUM matches the Microsoft example (4)', () => {
    expect(num(ev('=COUPNUM(DATE(2007,1,25),DATE(2008,11,15),2,1)'))).toBe(4);
  });
  it('COUPNUM counts the two remaining 2011 coupons', () => {
    expect(num(ev('=COUPNUM(DATE(2011,1,25),DATE(2011,11,15),2,1)'))).toBe(2);
  });
});

// ---------------------------------------------------------------- DISC / INTRATE / RECEIVED
describe('DISC, INTRATE, RECEIVED (documented formulas)', () => {
  const ev = evalMap([
    '=DISC(DATE(2007,1,25),DATE(2007,6,15),97.975,100,0)',
    '=DISC(DATE(2008,2,15),DATE(2008,5,15),95,100,2)',
    '=INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,2)',
    '=INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,0)',
    '=RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,0)',
    '=RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,2)',
  ]);
  // Microsoft documents DISC = ((redemption - pr) / redemption) x (B / DIM).
  // Basis 0: DIM = 140 (30/360, Jan 25 -> Jun 15), B = 360.
  it('DISC Microsoft example terms, basis 0', () => {
    expect(num(ev('=DISC(DATE(2007,1,25),DATE(2007,6,15),97.975,100,0)')))
      .toBeCloseTo(((100 - 97.975) / 100) * (360 / 140), 9);
  });
  it('DISC basis 2: (5/100) x (360/90) = 0.2 exactly', () => {
    expect(num(ev('=DISC(DATE(2008,2,15),DATE(2008,5,15),95,100,2)'))).toBeCloseTo(0.2, 12);
  });
  // Microsoft Support, INTRATE function: the worked example (basis 2) -> 0.05768.
  it('INTRATE matches the Microsoft example (0.05768, basis 2)', () => {
    expect(num(ev('=INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,2)')))
      .toBeCloseTo(0.05768, 9);
  });
  it('INTRATE basis 0: DIM is also 90, so the same 0.05768', () => {
    expect(num(ev('=INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,0)')))
      .toBeCloseTo(0.05768, 9);
  });
  // Microsoft Support, RECEIVED function: 2008-02-15 -> 2008-05-15,
  // investment 1,000,000, discount 5.75%, basis 0 -> 1,014,584.65
  // (= investment / (1 - discount x DIM/B), DIM/B = 90/360).
  it('RECEIVED matches the Microsoft example (basis 0)', () => {
    expect(num(ev('=RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,0)')))
      .toBeCloseTo(1000000 / (1 - 0.0575 * (90 / 360)), 4);
  });
  it('RECEIVED basis 2 gives the same documented value', () => {
    expect(num(ev('=RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,2)')))
      .toBeCloseTo(1000000 / (1 - 0.0575 * (90 / 360)), 4);
  });
});

// ---------------------------------------------------------------- PRICE / YIELD / DURATION / MDURATION
describe('PRICE, YIELD, DURATION, MDURATION', () => {
  const ev = evalMap([
    '=PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,0)',
    '=PRICE(DATE(2016,1,1),DATE(2031,1,1),0.09,0.09,100,1,1)',
    '=YIELD(DATE(2008,2,15),DATE(2016,11,15),0.0575,95.04287,100,2,0)',
    '=DURATION(DATE(2018,7,1),DATE(2048,1,1),0.08,0.09,2,1)',
    '=DURATION(DATE(2016,1,1),DATE(2031,1,1),0.09,0.09,1,1)',
    '=MDURATION(DATE(2008,1,1),DATE(2016,1,1),0.08,0.09,2,1)',
    '=MDURATION(DATE(2016,1,1),DATE(2031,1,1),0.09,0.09,1,1)',
    '=PRICE(DATE(2017,11,15),DATE(2008,2,15),0.0575,0.065,100,2,0)',
  ]);
  // Microsoft Support, PRICE function: settlement 2008-02-15, maturity
  // 2017-11-15, rate 5.75%, yield 6.50%, redemption 100, freq 2, basis 0
  // -> 94.63436162.
  it('PRICE matches the Microsoft example (97.29206555)', () => {
    expect(num(ev('=PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,0)')))
      .toBeCloseTo(94.63436162, 4);
  });
  it('PRICE of a par bond (coupon = yield, on a coupon date) is 100', () => {
    expect(num(ev('=PRICE(DATE(2016,1,1),DATE(2031,1,1),0.09,0.09,100,1,1)')))
      .toBeCloseTo(100, 9);
  });
  // Microsoft Support, YIELD function: the companion example -> 0.065.
  it('YIELD matches the Microsoft example (0.065)', () => {
    expect(num(ev('=YIELD(DATE(2008,2,15),DATE(2016,11,15),0.0575,95.04287,100,2,0)')))
      .toBeCloseTo(0.065, 6);
  });
  // Microsoft Support, DURATION function (current page): settlement
  // 2018-07-01, maturity 2048-01-01, 8% coupon, 9% yield, freq 2,
  // basis 1 -> 10.9191453.
  it('DURATION matches the Microsoft example (10.9191453)', () => {
    expect(num(ev('=DURATION(DATE(2018,7,1),DATE(2048,1,1),0.08,0.09,2,1)')))
      .toBeCloseTo(10.9191453, 4);
  });
  it('DURATION of the par bond (independent cash-flow weighting)', () => {
    // Independent Macaulay duration: sum(t x PV(cf_t)) / sum(PV(cf_t)),
    // annual coupons of 9 plus 100 redemption at t = 15, discounted at 9%.
    let numSum = 0;
    let denSum = 0;
    for (let t = 1; t <= 15; t++) {
      const pv = 9 / Math.pow(1.09, t);
      numSum += t * pv;
      denSum += pv;
    }
    const pvRed = 100 / Math.pow(1.09, 15);
    numSum += 15 * pvRed;
    denSum += pvRed;
    expect(num(ev('=DURATION(DATE(2016,1,1),DATE(2031,1,1),0.09,0.09,1,1)')))
      .toBeCloseTo(numSum / denSum, 9);
  });
  // Microsoft Support, MDURATION function: 2008-01-01 -> 2016-01-01, 8%,
  // 9%, freq 2, basis 1 -> 5.736 (full precision 5.735669813…).
  it('MDURATION matches the Microsoft example (5.735669813…)', () => {
    expect(num(ev('=MDURATION(DATE(2008,1,1),DATE(2016,1,1),0.08,0.09,2,1)')))
      .toBeCloseTo(5.735669814, 6);
  });
  it('MDURATION of the par bond = Macaulay / (1 + y/f), computed independently', () => {
    let numSum = 0;
    let denSum = 0;
    for (let t = 1; t <= 15; t++) {
      const pv = 9 / Math.pow(1.09, t);
      numSum += t * pv;
      denSum += pv;
    }
    const pvRed = 100 / Math.pow(1.09, 15);
    numSum += 15 * pvRed;
    denSum += pvRed;
    expect(num(ev('=MDURATION(DATE(2016,1,1),DATE(2031,1,1),0.09,0.09,1,1)')))
      .toBeCloseTo(numSum / denSum / 1.09, 9);
  });
  it('PRICE returns #NUM! when settlement >= maturity (Microsoft contract)', () => {
    expect(errCode(ev('=PRICE(DATE(2017,11,15),DATE(2008,2,15),0.0575,0.065,100,2,0)')))
      .toBe('#NUM!');
  });
});

// ---------------------------------------------------------------- PRICEDISC / YIELDDISC
describe('PRICEDISC and YIELDDISC (documented formulas)', () => {
  const ev = evalMap([
    '=PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,2)',
    '=PRICEDISC(DATE(2008,2,15),DATE(2008,5,15),0.05,100,3)',
    '=PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,0)',
    '=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,2)',
    '=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,3)',
    '=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,0)',
  ]);
  // Microsoft documents PRICEDISC = redemption - discount x redemption
  // x DIM/B. The Microsoft example terms (2008-02-16 -> 2008-03-01,
  // 5.25%, 100, basis 2): DIM = 14 actual days, B = 360.
  it('PRICEDISC Microsoft example terms, basis 2 (formula value)', () => {
    expect(num(ev('=PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,2)')))
      .toBeCloseTo(100 - 0.0525 * 100 * (14 / 360), 9);
  });
  it('PRICEDISC basis 3 divides by 365', () => {
    // Feb 15 -> May 15 2008 is 90 actual days; 100 x (1 - 0.05 x 90/365).
    expect(num(ev('=PRICEDISC(DATE(2008,2,15),DATE(2008,5,15),0.05,100,3)')))
      .toBeCloseTo(100 * (1 - 0.05 * (90 / 365)), 9);
  });
  it('PRICEDISC basis 0 counts 15 days (30/360), not 14 actual', () => {
    expect(num(ev('=PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,0)')))
      .toBeCloseTo(100 - 0.0525 * 100 * (15 / 360), 9);
  });
  // Microsoft Support, YIELDDISC function: 2008-02-16 -> 2008-03-01,
  // price 99.795, redemption 100, basis 2 -> 0.052823
  // (= ((redemption - pr) / pr) x (B / DIM), DIM = 14, B = 360).
  it('YIELDDISC matches the Microsoft example (0.052823, basis 2)', () => {
    expect(num(ev('=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,2)')))
      .toBeCloseTo(((100 - 99.795) / 99.795) * (360 / 14), 9);
  });
  it('YIELDDISC basis 3 uses B = 365', () => {
    expect(num(ev('=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,3)')))
      .toBeCloseTo(((100 - 99.795) / 99.795) * (365 / 14), 9);
  });
  it('YIELDDISC basis 0 counts 15 days (30/360)', () => {
    expect(num(ev('=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,0)')))
      .toBeCloseTo(((100 - 99.795) / 99.795) * (360 / 15), 9);
  });
});

// ---------------------------------------------------------------- VDB
describe('VDB', () => {
  const ev = evalMap([
    '=VDB(2400,300,10,0,1,2)',
    '=VDB(2400,300,10,1,2,2)',
    '=VDB(2400,300,10,0,0)',
  ]);
  // Microsoft Support, VDB function: VDB(2400,300,10,0,1,2) -> 480
  // (first-year double-declining: 2400 x 2/10).
  it('matches the Microsoft example (480)', () => {
    expect(num(ev('=VDB(2400,300,10,0,1,2)'))).toBeCloseTo(480, 9);
  });
  it('second year declines on the reduced book (384)', () => {
    // Book after year 1 = 2400 - 480 = 1920; year 2 = 1920 x 2/10 = 384
    // (straight-line on the remainder, (1920-300)/9 = 180, is smaller,
    // so no switch occurs).
    expect(num(ev('=VDB(2400,300,10,1,2,2)'))).toBeCloseTo(384, 9);
  });
  it('an empty period returns 0', () => {
    expect(num(ev('=VDB(2400,300,10,0,0)'))).toBe(0);
  });
});
