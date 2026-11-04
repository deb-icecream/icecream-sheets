/**
 * Phase-2 function-coverage tests: living/modern MATH, TEXT, INFO,
 * LOOKUP and DATE functions that previously had no gold or unit
 * coverage (see hidden_files/function-coverage/TEST-COVERAGE-AUDIT.md).
 *
 * Expected values are Microsoft Support's worked examples or are
 * computed independently in plain JS (the NETWORKDAYS.INTL day-loop
 * below). Engine disagreements with documented behavior are
 * Engine disagreements were recorded as FOUND DEFECTS D15 / D16 / D20 /
 * D21 / D22 / D25 in the audit file; all were fixed in Phase 2
 * (2026-10-21) and promoted from it.fails to plain `it`.
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook, type TypedValue } from '../src/index.js';

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
function str(v: TypedValue): string {
  if (v.kind !== 'string') throw new Error(`expected string, got ${JSON.stringify(v)}`);
  return v.value as string;
}
function errCode(v: TypedValue): string {
  if (v.kind !== 'error') throw new Error(`expected error, got ${JSON.stringify(v)}`);
  return v.code;
}

// ---------------------------------------------------------------- rounding (Microsoft examples)
describe('CEILING.MATH / FLOOR.PRECISE / ISO.CEILING', () => {
  const ev = evalMap([
    '=CEILING.MATH(24.3,5)', '=CEILING.MATH(-8.1,2)', '=CEILING.MATH(-8.1,2,1)',
    '=CEILING.MATH(6.4,0.25)', '=CEILING.MATH(-5.5,2,-1)',
    '=FLOOR.PRECISE(24.3,5)', '=FLOOR.PRECISE(-3.9,2)', '=FLOOR.PRECISE(3.9,-2)',
    '=FLOOR.PRECISE(-4.1)',
    '=ISO.CEILING(4.3)', '=ISO.CEILING(-4.3)', '=ISO.CEILING(4.3,2)',
    '=ISO.CEILING(4.3,-2)', '=ISO.CEILING(-4.3,2)', '=ISO.CEILING(-4.3,-2)',
  ]);
  // Microsoft Support, CEILING.MATH function: 24.3 to a multiple of 5
  // -> 25; -8.1 to a multiple of 2 -> -8 (negatives toward zero by
  // default) and -> -10 with a nonzero mode (away from zero).
  it('CEILING.MATH matches the Microsoft examples', () => {
    expect(num(ev('=CEILING.MATH(24.3,5)'))).toBe(25);
    expect(num(ev('=CEILING.MATH(-8.1,2)'))).toBe(-8);
    expect(num(ev('=CEILING.MATH(-8.1,2,1)'))).toBe(-10);
    expect(num(ev('=CEILING.MATH(6.4,0.25)'))).toBeCloseTo(6.5, 12);
  });
  it('CEILING.MATH with mode -1 (any nonzero mode) rounds away from zero', () => {
    expect(num(ev('=CEILING.MATH(-5.5,2,-1)'))).toBe(-6);
  });
  // Microsoft Support, FLOOR.PRECISE function: rounds down to the
  // nearest multiple, ignoring the sign of significance; negatives go
  // away from zero (-4.1 -> -5).
  it('FLOOR.PRECISE matches the documented behavior', () => {
    expect(num(ev('=FLOOR.PRECISE(24.3,5)'))).toBe(20);
    expect(num(ev('=FLOOR.PRECISE(-3.9,2)'))).toBe(-4);
    expect(num(ev('=FLOOR.PRECISE(3.9,-2)'))).toBe(2);
    expect(num(ev('=FLOOR.PRECISE(-4.1)'))).toBe(-5);
  });
  // Microsoft Support, ISO.CEILING function: the full worked-example
  // table (mathematical ceiling, significance sign ignored).
  it('ISO.CEILING matches the Microsoft example table', () => {
    expect(num(ev('=ISO.CEILING(4.3)'))).toBe(5);
    expect(num(ev('=ISO.CEILING(-4.3)'))).toBe(-4);
    expect(num(ev('=ISO.CEILING(4.3,2)'))).toBe(6);
    expect(num(ev('=ISO.CEILING(4.3,-2)'))).toBe(6);
    expect(num(ev('=ISO.CEILING(-4.3,2)'))).toBe(-4);
    expect(num(ev('=ISO.CEILING(-4.3,-2)'))).toBe(-4);
  });
});

// ---------------------------------------------------------------- text width / Thai / phonetic
describe('ASC / DBCS / BAHTTEXT / PHONETIC', () => {
  const ev = evalMap([
    '=ASC("EXCEL")', '=ASC("ＥＸＣＥＬ")', '=DBCS("EXCEL")',
    '=BAHTTEXT(1)', '=BAHTTEXT(12.65)', '=PHONETIC("abc")',
  ]);
  // Microsoft Support, ASC function: =ASC("EXCEL") equals "EXCEL"
  // (no full-width letters -> unchanged); full-width input narrows.
  it('ASC matches the Microsoft example and narrows full-width text', () => {
    expect(str(ev('=ASC("EXCEL")'))).toBe('EXCEL');
    expect(str(ev('=ASC("ＥＸＣＥＬ")'))).toBe('EXCEL');
  });
  it('DBCS widens half-width text to full-width (the JIS/DBCS conversion)', () => {
    expect(str(ev('=DBCS("EXCEL")'))).toBe('ＥＸＣＥＬ');
  });
  // Microsoft documents BAHTTEXT as converting a number to THAI text:
  // BAHTTEXT(1) is "หนึ่งบาทถ้วน" (one baht exactly).
  it('BAHTTEXT(1) returns the Thai text', () => {
    expect(str(ev('=BAHTTEXT(1)'))).toBe('หนึ่งบาทถ้วน');
  });
  it('BAHTTEXT returns text (never #NAME?)', () => {
    expect(ev('=BAHTTEXT(12.65)').kind).toBe('string');
  });
  // PHONETIC extracts furigana; with no phonetic data attached to the
  // input the engine's documented-in-code behavior is to return the
  // text itself (behavioral test — no furigana fixture exists).
  it('PHONETIC returns a string for plain text', () => {
    expect(str(ev('=PHONETIC("abc")'))).toBe('abc');
  });
});

// ---------------------------------------------------------------- INFO / AREAS / PERCENTOF
describe('INFO, AREAS, PERCENTOF', () => {
  const ev = evalMap([
    '=INFO("numfile")', '=INFO("recalc")', '=INFO("system")', '=INFO("bogus")',
    '=AREAS(B2)', '=PERCENTOF(15,60)', '=PERCENTOF(15,0)',
    '=PERCENTOF({10,20},{10,20,30})',
  ]);
  // INFO values are environment-specific by design (Microsoft lists
  // "numfile", "recalc", "system", ... as installation facts), so the
  // contract tested here is type + the #VALUE! error for unknown types.
  it('INFO("numfile") is a positive number and INFO("recalc") is "Automatic"', () => {
    expect(num(ev('=INFO("numfile")'))).toBeGreaterThanOrEqual(1);
    expect(str(ev('=INFO("recalc")'))).toBe('Automatic');
    expect(str(ev('=INFO("system")')).length).toBeGreaterThan(0);
  });
  it('INFO with an unknown type returns #VALUE! (Microsoft contract)', () => {
    expect(errCode(ev('=INFO("bogus")'))).toBe('#VALUE!');
  });
  it('AREAS counts one area in a single contiguous reference', () => {
    expect(num(ev('=AREAS(B2)'))).toBe(1);
  });
  // Microsoft documents PERCENTOF(data_subset, data_all) as
  // SUM(data_subset) / SUM(data_all) — the GROUPBY/PIVOTBY aggregator.
  it('PERCENTOF of scalars is subset / total', () => {
    expect(num(ev('=PERCENTOF(15,60)'))).toBeCloseTo(0.25, 12);
  });
  it('PERCENTOF with a zero total returns #DIV/0!', () => {
    expect(errCode(ev('=PERCENTOF(15,0)'))).toBe('#DIV/0!');
  });
  it('PERCENTOF sums its range arguments (30 / 60 = 0.5)', () => {
    expect(num(ev('=PERCENTOF({10,20},{10,20,30})'))).toBeCloseTo(0.5, 12);
  });
});

// ---------------------------------------------------------------- matrix stubs (MINVERSE / MUNIT)
describe('MINVERSE and MUNIT', () => {
  const ev = evalMap(['=MUNIT(0)']);
  it('MINVERSE of a singular matrix returns #NUM! (Microsoft contract)', () => {
    // Isolated sheet on purpose: with another formula inside the
    // would-be spill range, HyperFormula's ArrayVertex reports #SPILL!
    // ("No space for array result") before the function's own error can
    // surface — platform behavior for blocked array results, verified
    // at the HF level 2026-10-21 (function-coverage Phase 2). The
    // function's error contract itself is #NUM!, asserted here.
    const wb = new EngineWorkbook({ S: [['=MINVERSE({1,2;2,4})']] });
    expect(errCode(wb.getValue({ sheet: 'S', row: 0, col: 0 }))).toBe('#NUM!');
  });
  it('MUNIT(0) returns #VALUE! (Microsoft contract)', () => {
    expect(errCode(ev('=MUNIT(0)'))).toBe('#VALUE!');
  });

  // [[1,2],[3,4]] in A1:B2; its inverse is [[-2,1],[1.5,-0.5]].
  const wb = new EngineWorkbook({ S: [[1, 2], [3, 4]] });
  wb.setFormula({ sheet: 'S', row: 2, col: 0 }, '=SUM(MINVERSE(A1:B2))');
  wb.setFormula({ sheet: 'S', row: 2, col: 1 }, '=INDEX(MINVERSE(A1:B2),2,1)');
  wb.setFormula({ sheet: 'S', row: 3, col: 0 }, '=SUM(MUNIT(3))');
  wb.setFormula({ sheet: 'S', row: 3, col: 1 }, '=INDEX(MUNIT(3),2,2)');
  wb.setFormula({ sheet: 'S', row: 3, col: 2 }, '=INDEX(MUNIT(3),1,2)');
  const sumInv = wb.getValue({ sheet: 'S', row: 2, col: 0 });
  const inv21 = wb.getValue({ sheet: 'S', row: 2, col: 1 });
  const sumUnit = wb.getValue({ sheet: 'S', row: 3, col: 0 });
  const unit22 = wb.getValue({ sheet: 'S', row: 3, col: 1 });
  const unit12 = wb.getValue({ sheet: 'S', row: 3, col: 2 });

  it('MINVERSE returns the full inverse (entries sum to 0)', () => {
    expect(num(sumInv)).toBeCloseTo(-2 + 1 + 1.5 - 0.5, 12);
  });
  it('MINVERSE entry (2,1) is 1.5', () => {
    expect(num(inv21)).toBeCloseTo(1.5, 12);
  });
  it('MUNIT(3) is the 3x3 identity (trace 3)', () => {
    expect(num(sumUnit)).toBeCloseTo(3, 12);
  });
  it('MUNIT(3) has 1s on the diagonal and 0s off it', () => {
    expect(num(unit22)).toBe(1);
    expect(num(unit12)).toBe(0);
  });
});

// ---------------------------------------------------------------- NETWORKDAYS.INTL
const serial = (y: number, m: number, d: number): number =>
  Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
/** Independent workday counter implementing Microsoft's weekend table. */
function networkdaysIntl(
  start: number,
  end: number,
  weekend: number | string,
  holidays: ReadonlySet<number> = new Set(),
): number {
  // mask[0] is Monday ... mask[6] is Sunday.
  const mask = [false, false, false, false, false, false, false];
  if (typeof weekend === 'string') {
    [...weekend].forEach((ch, i) => {
      mask[i] = ch === '1';
    });
  } else {
    // Weekend numbers: day-of-week indexes with 0 = Sunday (Microsoft table).
    const table: Record<number, number[]> = {
      1: [0, 6], 2: [0, 1], 3: [1, 2], 4: [2, 3], 5: [3, 4], 6: [4, 5], 7: [5, 6],
      11: [0], 12: [1], 13: [2], 14: [3], 15: [4], 16: [5], 17: [6],
    };
    for (const dow of table[weekend] ?? []) mask[(dow + 6) % 7] = true;
  }
  const step = start <= end ? 1 : -1;
  let count = 0;
  for (let s = start; step > 0 ? s <= end : s >= end; s += step) {
    const dow = new Date(Date.UTC(1899, 11, 30) + s * 86400000).getUTCDay();
    if (!mask[(dow + 6) % 7] && !holidays.has(s)) count += step;
  }
  return count;
}
describe('NETWORKDAYS.INTL', () => {
  const ev = evalMap([
    '=NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31))',
    '=NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),11)',
    '=NETWORKDAYS.INTL(DATE(2013,1,1),DATE(2013,1,31),"0000011")',
    '=NETWORKDAYS.INTL(DATE(2013,1,31),DATE(2013,1,1))',
  ]);
  it('default weekend (Sat/Sun), January 2006', () => {
    expect(num(ev('=NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31))')))
      .toBe(networkdaysIntl(serial(2006, 1, 1), serial(2006, 1, 31), 1));
  });
  it('weekend 11 (Sunday only), January 2006', () => {
    expect(num(ev('=NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),11)')))
      .toBe(networkdaysIntl(serial(2006, 1, 1), serial(2006, 1, 31), 11));
  });
  it('weekend string "0000011" (Sat/Sun), January 2013', () => {
    expect(num(ev('=NETWORKDAYS.INTL(DATE(2013,1,1),DATE(2013,1,31),"0000011")')))
      .toBe(networkdaysIntl(serial(2013, 1, 1), serial(2013, 1, 31), '0000011'));
  });
  it('reversed dates return the negative count (Microsoft contract)', () => {
    expect(num(ev('=NETWORKDAYS.INTL(DATE(2013,1,31),DATE(2013,1,1))')))
      .toBe(networkdaysIntl(serial(2013, 1, 31), serial(2013, 1, 1), 1));
  });
  it('holidays in a range are excluded', () => {
    const holidays = new Set([serial(2013, 1, 1), serial(2013, 1, 15)]);
    const wb = new EngineWorkbook({ S: [[serial(2013, 1, 1)], [serial(2013, 1, 15)]] });
    wb.setFormula(
      { sheet: 'S', row: 3, col: 0 },
      '=NETWORKDAYS.INTL(DATE(2013,1,1),DATE(2013,1,31),1,A1:A2)',
    );
    expect(num(wb.getValue({ sheet: 'S', row: 3, col: 0 })))
      .toBe(networkdaysIntl(serial(2013, 1, 1), serial(2013, 1, 31), 1, holidays));
  });
});

// ---------------------------------------------------------------- DPRODUCT / ISOMITTED (fixture workbooks)
describe('DPRODUCT', () => {
  it('multiplies the Score column over the criteria matches (80 x 90)', () => {
    const wb = new EngineWorkbook({
      DB: [
        ['Name', 'Age', 'Score'],
        ['a', 20, 80],
        ['b', 25, 90],
        ['c', 30, 85],
        [null, null, null],
        [null, null, null],
        ['Name', 'Age', 'Score'],
        ['a', null, null],
        ['b', null, null],
      ],
    });
    wb.setFormula({ sheet: 'DB', row: 10, col: 0 }, '=DPRODUCT(A1:C4,"Score",A7:C9)');
    wb.setFormula({ sheet: 'DB', row: 10, col: 1 }, '=AREAS(A1:B2)');
    expect(num(wb.getValue({ sheet: 'DB', row: 10, col: 0 }))).toBe(7200);
    expect(num(wb.getValue({ sheet: 'DB', row: 10, col: 1 }))).toBe(1);
  });
});

describe('ISOMITTED', () => {
  // Excel semantics: ISOMITTED is evaluated inside a LAMBDA for one of
  // its parameters; exercised here through a named LAMBDA, the same
  // pattern namedExpressions.test.ts uses for named functions.
  const wb = new EngineWorkbook({ S: [[0]] });
  wb.defineNamedFunction('CheckOmitted', 'LAMBDA(x,y,ISOMITTED(y))');
  wb.setFormula({ sheet: 'S', row: 1, col: 0 }, '=CheckOmitted(5,6)');
  wb.setFormula({ sheet: 'S', row: 2, col: 0 }, '=CheckOmitted(5)');
  const provided = wb.getValue({ sheet: 'S', row: 1, col: 0 });
  const omitted = wb.getValue({ sheet: 'S', row: 2, col: 0 });
  it('is FALSE when the argument is provided', () => {
    expect(provided.kind).toBe('boolean');
    expect((provided as { value: boolean }).value).toBe(false);
  });
  it('is TRUE when the LAMBDA argument is omitted', () => {
    expect(omitted.kind).toBe('boolean');
    expect((omitted as { value: boolean }).value).toBe(true);
  });
});
