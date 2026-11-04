/**
 * Regression tests for the formula-audit v2 function bugs.
 *
 * Every expected value below is Excel's cached `<v>` from the real-world
 * corpus (formula-audit-v2-report.md §2e/§2f/§1F), verified against the raw
 * OOXML. Failing-test-first: each of these failed before the fix.
 */
import { describe, it, expect } from 'vitest';
import { EngineWorkbook } from '../src/index.js';

function num(wb: EngineWorkbook, sheet: string, row: number, col: number): number {
  const v: any = wb.getValue({ sheet, row, col });
  expect(v.kind).toBe('number');
  return v.value;
}

function errCode(wb: EngineWorkbook, sheet: string, row: number, col: number): string {
  const v: any = wb.getValue({ sheet, row, col });
  expect(v.kind).toBe('error');
  return v.code;
}

describe('AGGREGATE options (audit §2c)', () => {
  // Mirrors closedxml-xlsx-functions-excel-2010.xlsx Sheet2: C1:C9 are plain
  // numbers (sum 441), C10 is a nested AGGREGATE, C11 a nested SUBTOTAL.
  function aggWb() {
    const detail = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const rows: any[][] = [];
    for (let i = 0; i < 9; i++) {
      rows.push([detail[i], 49]); // A=detail, B=49s (sum 441)
    }
    rows.push(['', '=AGGREGATE(9,4,A1:A9)']); // B10: nested AGGREGATE = 45
    rows.push(['', '=SUBTOTAL(9,A1:A9)']); // B11: nested SUBTOTAL = 45
    rows.push(['=AGGREGATE(1,0,B1:B11)']); // row 11: Excel cached 49
    rows.push(['=AGGREGATE(9,0,B1:B11)']); // row 12: 441
    rows.push(['=AGGREGATE(9,4,B1:B11)']); // row 13: 531 (nested included)
    rows.push(['=AGGREGATE(1,2,B1:B11)']); // row 14: 49 (options 2: nested+errors)
    rows.push(['=AGGREGATE(1,,B1:B11)']); // row 15: empty options = 0 → 49
    return new EngineWorkbook({ S: rows });
  }

  it('options=0 excludes nested SUBTOTAL/AGGREGATE (Excel cached 49)', () => {
    const wb = aggWb();
    expect(num(wb, 'S', 11, 0)).toBeCloseTo(49, 10);
  });

  it('options=0 SUM excludes nested (441, not 531)', () => {
    const wb = aggWb();
    expect(num(wb, 'S', 12, 0)).toBeCloseTo(441, 10);
  });

  it('options=4 includes nested SUBTOTAL/AGGREGATE (531)', () => {
    const wb = aggWb();
    expect(num(wb, 'S', 13, 0)).toBeCloseTo(531, 10);
  });

  it('options=2 ignores nested and errors', () => {
    const wb = aggWb();
    expect(num(wb, 'S', 14, 0)).toBeCloseTo(49, 10);
  });

  it('empty options cell means 0', () => {
    const wb = aggWb();
    expect(num(wb, 'S', 15, 0)).toBeCloseTo(49, 10);
  });

  it('error values: ignored with options 6, propagated with options 4', () => {
    const wb = new EngineWorkbook({
      S: [
        [5, '=1/0'],
        ['=AGGREGATE(9,6,A1:B1)'], // 5
        ['=AGGREGATE(9,0,A1:B1)'], // #DIV/0!
        ['=AGGREGATE(9,7,A1:B1)'], // 5 (errors + nested ignored)
      ],
    } as any);
    expect(num(wb, 'S', 1, 0)).toBe(5);
    expect(errCode(wb, 'S', 2, 0)).toBe('#DIV/0!');
    expect(num(wb, 'S', 3, 0)).toBe(5);
  });

  it('a scalar SUBTOTAL argument is excluded with options=0', () => {
    const wb = new EngineWorkbook({
      S: [
        [1, 2, 3],
        ['=AGGREGATE(9,0,SUBTOTAL(9,A1:C1),A1)'], // 1, not 7
        ['=AGGREGATE(9,4,SUBTOTAL(9,A1:C1),A1)'], // 7
      ],
    } as any);
    expect(num(wb, 'S', 1, 0)).toBe(1);
    expect(num(wb, 'S', 2, 0)).toBe(7);
  });

  it('invalid function_num / options give #VALUE!', () => {
    const wb = new EngineWorkbook({
      S: [
        [1, 2, 3],
        ['=AGGREGATE(20,0,A1:C1)'],
        ['=AGGREGATE(9,8,A1:C1)'],
        ['=AGGREGATE(0,0,A1:C1)'],
      ],
    } as any);
    expect(errCode(wb, 'S', 1, 0)).toBe('#VALUE!');
    expect(errCode(wb, 'S', 2, 0)).toBe('#VALUE!');
    expect(errCode(wb, 'S', 3, 0)).toBe('#VALUE!');
  });

  it('existing behavior without nesting is unchanged', () => {
    const wb = new EngineWorkbook({
      S: [
        [1, 2, 3, 4, 5],
        ['=AGGREGATE(9,0,A1:E1)'],
        ['=AGGREGATE(1,0,A1:E1)'],
        ['=AGGREGATE(4,0,A1:E1)'],
      ],
    } as any);
    expect(num(wb, 'S', 1, 0)).toBe(15);
    expect(num(wb, 'S', 2, 0)).toBe(3);
    expect(num(wb, 'S', 3, 0)).toBe(5);
  });
});

describe('DCOUNT field=0 (audit §1F)', () => {
  function dbWb() {
    return new EngineWorkbook({
      S: [
        ['Name', 'Age', 'Children'],
        ['name1', 2, 0],
        ['name2', 3, 1],
        ['name3', 4, 1],
        ['name4', 5, 3],
        ['name5', 6, 2],
        ['name6', 7, 2],
        [],
        ['Name', 'Age', 'Children'],
        ['', '>=4', 2],
        ['=DCOUNT(A1:C7,0,A9:C10)'], // Excel cached 2
        ['=DCOUNT(A1:C7,2,A9:C10)'], // field=Age → 2
        ['=DCOUNTA(A1:C7,0,A9:C10)'], // 2
        ['=DSUM(A1:C7,0,A9:C10)'], // #VALUE! (field required)
      ],
    } as any);
  }

  it('field=0 counts all matching records (Excel cached 2)', () => {
    const wb = dbWb();
    expect(num(wb, 'S', 10, 0)).toBe(2);
  });

  it('numeric field still works; DCOUNTA field=0 counts records', () => {
    const wb = dbWb();
    expect(num(wb, 'S', 11, 0)).toBe(2);
    expect(num(wb, 'S', 12, 0)).toBe(2);
  });

  it('DSUM with field=0 is #VALUE!', () => {
    const wb = dbWb();
    expect(errCode(wb, 'S', 13, 0)).toBe('#VALUE!');
  });
});

describe('BETA.DIST upstream 5x bug (audit §2e)', () => {
  it('PDF matches Excel cached 0.06688884219206157', () => {
    const wb = new EngineWorkbook({
      S: [['=BETA.DIST(2,2/15,2/15,FALSE,1,6)']],
    } as any);
    // Excel's cached value, verified against math.gamma to 15 digits.
    expect(num(wb, 'S', 0, 0)).toBeCloseTo(0.06688884219206157, 12);
  });

  it('CDF is consistent (scipy: 0.422848132802469)', () => {
    const wb = new EngineWorkbook({
      S: [['=BETA.DIST(2,2/15,2/15,TRUE,1,6)']],
    } as any);
    expect(num(wb, 'S', 0, 0)).toBeCloseTo(0.422848132802469, 10);
  });

  it('out-of-range arguments give #NUM!', () => {
    const wb = new EngineWorkbook({
      S: [
        ['=BETA.DIST(7,2/15,2/15,TRUE,1,6)'],
        ['=BETA.DIST(2,0,2/15,TRUE,1,6)'],
      ],
    } as any);
    expect(errCode(wb, 'S', 0, 0)).toBe('#NUM!');
    expect(errCode(wb, 'S', 1, 0)).toBe('#NUM!');
  });
});

describe('PERCENTRANK.INC (audit §2e)', () => {
  it('minimum ranks 0 (Excel cached 0, not 0.167)', () => {
    const wb = new EngineWorkbook({
      S: [['=PERCENTRANK.INC({4,8,2,1},1)']],
    } as any);
    expect(num(wb, 'S', 0, 0)).toBe(0);
  });

  it('maximum ranks 1; interior interpolates', () => {
    const wb = new EngineWorkbook({
      S: [
        ['=PERCENTRANK.INC({1,2,4,8},8)'],
        ['=PERCENTRANK.INC({1,2,4,8},3)'],
        ['=PERCENTRANK.INC({1,2,4,8},2)'],
      ],
    } as any);
    expect(num(wb, 'S', 0, 0)).toBe(1);
    expect(num(wb, 'S', 1, 0)).toBe(0.5);
    // Excel rounds to 3 significant digits by default.
    expect(num(wb, 'S', 2, 0)).toBe(0.333);
  });

  it('ties rank by count of lesser values', () => {
    const wb = new EngineWorkbook({
      S: [['=PERCENTRANK.INC({1,2,2,4},2)']],
    } as any);
    expect(num(wb, 'S', 0, 0)).toBe(0.333);
  });

  it('out-of-range x is #N/A', () => {
    const wb = new EngineWorkbook({
      S: [['=PERCENTRANK.INC({1,2,4,8},9)']],
    } as any);
    expect(errCode(wb, 'S', 0, 0)).toBe('#N/A');
  });
});

describe('WORKDAY.INTL holidays (audit §2e)', () => {
  function wdWb() {
    return new EngineWorkbook({
      S: [
        [41709, 41714, 41733, 41718, 41640],
        ['=WORKDAY.INTL(A1,24,,B1:E1)'], // Excel cached 41745
        ['=WORKDAY.INTL(A1,24,13,B1:E1)'], // Excel cached 41740
        ['=WORKDAY.INTL(A1,24,"0101010",B1:E1)'], // Excel cached 41754
      ],
    } as any);
  }

  it('default weekend honors holidays (Excel cached 41745)', () => {
    expect(num(wdWb(), 'S', 1, 0)).toBe(41745);
  });

  it('weekend code 13 honors holidays (Excel cached 41740)', () => {
    expect(num(wdWb(), 'S', 2, 0)).toBe(41740);
  });

  it('weekend mask string honors holidays (Excel cached 41754)', () => {
    expect(num(wdWb(), 'S', 3, 0)).toBe(41754);
  });
});

describe('FLOOR.MATH mode (audit §2e)', () => {
  it('mode=-1 rounds negatives toward zero (Excel cached -23)', () => {
    const wb = new EngineWorkbook({
      S: [
        ['=FLOOR.MATH(-23.5,1,-1)'],
        ['=FLOOR.MATH(-23.5,-1,-1)'],
      ],
    } as any);
    expect(num(wb, 'S', 0, 0)).toBe(-23);
    expect(num(wb, 'S', 1, 0)).toBe(-23);
  });

  it('default mode rounds negatives away from zero', () => {
    const wb = new EngineWorkbook({
      S: [
        ['=FLOOR.MATH(-23.5,1)'],
        ['=FLOOR.MATH(-23.5,-1)'],
        ['=FLOOR.MATH(-23.5)'],
        ['=FLOOR.MATH(23.5,1)'],
      ],
    } as any);
    expect(num(wb, 'S', 0, 0)).toBe(-24);
    expect(num(wb, 'S', 1, 0)).toBe(-24);
    expect(num(wb, 'S', 2, 0)).toBe(-24);
    expect(num(wb, 'S', 3, 0)).toBe(23);
  });

  it('significance 0 gives 0; significance sign is ignored (Excel cached 23)', () => {
    const wb = new EngineWorkbook({
      S: [
        ['=FLOOR.MATH(23.5,0)'],
        ['=FLOOR.MATH(23.5,-1)'],
        ['=FLOOR.MATH(23.5,-1,-1)'],
        ['=FLOOR.MATH(-23.5,-2)'],
      ],
    } as any);
    expect(num(wb, 'S', 0, 0)).toBe(0);
    expect(num(wb, 'S', 1, 0)).toBe(23);
    expect(num(wb, 'S', 2, 0)).toBe(23);
    expect(num(wb, 'S', 3, 0)).toBe(-24);
  });
});

describe('precision gaps (audit §2f)', () => {
  function precWb() {
    return new EngineWorkbook({
      S: [
        ['=ERF.PRECISE(2)'], // Excel cached 0.9953222650189527
        ['=ERFC.PRECISE(2)'], // Excel cached 0.0046777349810472645
        ['=T.INV(2/15,5)'], // Excel cached -1.2498497882652577
        ['=T.INV.2T(2/15,6)'], // Excel cached 1.7355217310679223
        ['=F.DIST.RT(2,5,6)'], // Excel cached 0.21167432749937592
        ['=CONFIDENCE.T(2/15,6.6,44)'], // Excel cached 1.5223611251194489
      ],
    } as any);
  }

  it('ERF.PRECISE matches Excel to 12 digits', () => {
    expect(num(precWb(), 'S', 0, 0)).toBeCloseTo(0.9953222650189527, 12);
  });

  it('ERFC.PRECISE matches Excel to 12 digits', () => {
    expect(num(precWb(), 'S', 1, 0)).toBeCloseTo(0.0046777349810472645, 12);
  });

  it('T.INV matches Excel to 12 digits', () => {
    expect(num(precWb(), 'S', 2, 0)).toBeCloseTo(-1.2498497882652577, 12);
  });

  it('T.INV.2T matches Excel to 12 digits', () => {
    expect(num(precWb(), 'S', 3, 0)).toBeCloseTo(1.7355217310679223, 12);
  });

  it('F.DIST.RT matches Excel to 12 digits', () => {
    expect(num(precWb(), 'S', 4, 0)).toBeCloseTo(0.21167432749937592, 12);
  });

  it('CONFIDENCE.T matches Excel to 11 digits', () => {
    expect(num(precWb(), 'S', 5, 0)).toBeCloseTo(1.5223611251194489, 11);
  });
});

describe('AND/OR/XOR ignore empty cells and text in ranges (audit R2)', () => {
  function boolOf(wb: EngineWorkbook, row: number, col: number): boolean {
    const v: any = wb.getValue({ sheet: 'S', row, col });
    expect(v.kind).toBe('boolean');
    return v.value;
  }
  function strOf(wb: EngineWorkbook, row: number, col: number): string {
    const v: any = wb.getValue({ sheet: 'S', row, col });
    expect(v.kind).toBe('string');
    return v.value;
  }
  // Mirrors closedxml-xlsx-ceiling-floor.xlsx: K1=AND(K3:K81) with logicals
  // and empties below — Excel cached TRUE.
  function logicWb() {
    return new EngineWorkbook({
      S: [
        [true, '', '', ''], // A1=TRUE, B1:D1 empty
        ['', '', '', ''],
        ['=AND(A1:D2)'], // row 2: TRUE (empties ignored)
        ['=OR(A1:D2)'], // row 3: TRUE
        ['=AND(B1:D2)'], // row 4: TRUE (all-empty range)
        ['=OR(B1:D2)'], // row 5: FALSE (all-empty range)
        ['=XOR(A1:D2)'], // row 6: TRUE (one TRUE)
        ['=AND(A1,A1)'], // row 7: TRUE
        ['=OR(B1,B2)'], // row 8: FALSE (all-empty refs)
      ],
    } as any);
  }

  it('AND ignores empty cells: =AND(A1:A4) with A1=TRUE, rest empty → TRUE', () => {
    expect(boolOf(logicWb(), 2, 0)).toBe(true);
  });

  it('OR over a range with one TRUE → TRUE', () => {
    expect(boolOf(logicWb(), 3, 0)).toBe(true);
  });

  it('all-empty range: AND=TRUE, OR=FALSE', () => {
    const wb = logicWb();
    expect(boolOf(wb, 4, 0)).toBe(true);
    expect(boolOf(wb, 5, 0)).toBe(false);
  });

  it('XOR ignores empties: one TRUE → TRUE', () => {
    expect(boolOf(logicWb(), 6, 0)).toBe(true);
  });

  it('single-cell refs: AND(A1,A1)=TRUE, OR(B1,B2)=FALSE', () => {
    const wb = logicWb();
    expect(boolOf(wb, 7, 0)).toBe(true);
    expect(boolOf(wb, 8, 0)).toBe(false);
  });

  it('mixed text/empty/logical: text ignored, FALSE still flips AND', () => {
    const wb = new EngineWorkbook({
      S: [
        [true, 'hello', '', false],
        ['=AND(A1:D1)'], // FALSE: an actual FALSE is present
        ['=OR(A1:D1)'], // TRUE
        ['=AND(A1:C1)'], // TRUE: text ignored, no FALSE
        ['=XOR(A1:C1)'], // TRUE: exactly one TRUE
        ['=XOR(A1:A1)'], // TRUE
        ['=XOR(A1:D1)'], // TRUE: exactly one TRUE (FALSE counts as not-TRUE)
      ],
    } as any);
    expect(boolOf(wb, 1, 0)).toBe(false);
    expect(boolOf(wb, 2, 0)).toBe(true);
    expect(boolOf(wb, 3, 0)).toBe(true);
    expect(boolOf(wb, 4, 0)).toBe(true);
    expect(boolOf(wb, 5, 0)).toBe(true);
    expect(boolOf(wb, 6, 0)).toBe(true); // one TRUE among ignored text/empty
  });

  it('numbers count: AND(1,2)=TRUE, AND(0,1)=FALSE, ranges too', () => {
    const wb = new EngineWorkbook({
      S: [
        [1, 2, 0],
        ['=AND(A1:B1)'], // TRUE
        ['=AND(A1:C1)'], // FALSE (0 present)
        ['=OR(C1:C1)'], // FALSE
        ['=AND(1,2)'], // TRUE (direct scalars)
        ['=AND(0,1)'], // FALSE
      ],
    } as any);
    expect(boolOf(wb, 1, 0)).toBe(true);
    expect(boolOf(wb, 2, 0)).toBe(false);
    expect(boolOf(wb, 3, 0)).toBe(false);
    expect(boolOf(wb, 4, 0)).toBe(true);
    expect(boolOf(wb, 5, 0)).toBe(false);
  });

  it('errors propagate; direct text → #VALUE!; no args → #VALUE!', () => {
    const wb = new EngineWorkbook({
      S: [
        [true, '=1/0'],
        ['=AND(A1:B1)'], // #DIV/0!
        ['=OR(A1:B1)'], // #DIV/0!
        ['=AND("x")'], // #VALUE!
        ['=AND()'], // #VALUE!
        ['=OR()'], // #VALUE!
        ['=AND(FALSE,B1)'], // #DIV/0!: errors propagate even when decided
        ['=XOR(TRUE,B1)'], // #DIV/0!
      ],
    } as any);
    expect(errCode(wb, 'S', 1, 0)).toBe('#DIV/0!');
    expect(errCode(wb, 'S', 2, 0)).toBe('#DIV/0!');
    expect(errCode(wb, 'S', 3, 0)).toBe('#VALUE!');
    expect(errCode(wb, 'S', 4, 0)).toBe('#VALUE!');
    expect(errCode(wb, 'S', 5, 0)).toBe('#VALUE!');
    expect(errCode(wb, 'S', 6, 0)).toBe('#DIV/0!');
    expect(errCode(wb, 'S', 7, 0)).toBe('#DIV/0!');
  });

  it('NOT keeps Excel semantics (untouched by the override)', () => {
    const wb = new EngineWorkbook({
      S: [['=NOT(TRUE)'], ['=NOT(Z99)'], ['=NOT("x")']],
    } as any);
    expect(boolOf(wb, 0, 0)).toBe(false);
    expect(boolOf(wb, 1, 0)).toBe(true); // NOT(empty)=TRUE
    expect(errCode(wb, 'S', 2, 0)).toBe('#VALUE!');
  });
});

describe('TEXT % / ‰ scaling (audit R3)', () => {
  function strOf(wb: EngineWorkbook, row: number, col: number): string {
    const v: any = wb.getValue({ sheet: 'S', row, col });
    expect(v.kind).toBe('string');
    return v.value;
  }
  function textWb() {
    return new EngineWorkbook({
      S: [
        ['=TEXT(0.0689037471245626,"0.0%")'], // "6.9%"
        ['=TEXT(1,"0%")'], // "100%"
        ['=TEXT(0.5,"0.00%")'], // "50.00%"
        ['=TEXT(0.0689,"0.0")'], // "0.1" (no-% control)
        ['=TEXT(0.25,"0‰")'], // "250‰" (per-mille ×1000)
        ['=TEXT(0.1234,"0.0%%")'], // "1234.0%%" (double percent ×10000)
        ['=TEXT(5,"0.0\\%")'], // escaped %: literal, no scaling (see test)
        ['=TEXT(5,T!A1)'], // T!A1 holds 0.0"%" as text: quoted % literal, no scaling
      ],
      T: [['0.0"%"']],
    } as any);
  }

  it('TEXT(0.0689037471245626,"0.0%") = "6.9%" (the DASHBOARD!B31 case)', () => {
    expect(strOf(textWb(), 0, 0)).toBe('6.9%');
  });

  it('TEXT(1,"0%")="100%", TEXT(0.5,"0.00%")="50.00%"', () => {
    const wb = textWb();
    expect(strOf(wb, 1, 0)).toBe('100%');
    expect(strOf(wb, 2, 0)).toBe('50.00%');
  });

  it('no-% control: TEXT(0.0689,"0.0")="0.1"', () => {
    expect(strOf(textWb(), 3, 0)).toBe('0.1');
  });

  it('per-mille: TEXT(0.25,"0‰")="250‰"', () => {
    expect(strOf(textWb(), 4, 0)).toBe('250‰');
  });

  it('double percent scales ×10000: TEXT(0.1234,"0.0%%")="1234.0%%"', () => {
    expect(strOf(textWb(), 5, 0)).toBe('1234.0%%');
  });

  it('escaped % does not scale: TEXT(5,"0.0\\%") formats 5, not 500', () => {
    // The upstream formatter emits the backslash literally ("5.0\%") — a
    // pre-existing formatter quirk outside this fix; what matters here is
    // that the escaped % does NOT trigger ×100 scaling.
    const s = strOf(textWb(), 6, 0);
    expect(s.startsWith('5.0')).toBe(true);
    expect(s).not.toContain('500');
  });

  it('quoted % is literal: TEXT(5,"0.0\\"%\\"") formats 5, not 500', () => {
    // The formula parser rejects "" escapes inside string literals, so the
    // quoted format arrives via cell T!A1 instead — same code path.
    // The upstream formatter emits the quote delimiters literally
    // ('5.0"%"' vs Excel's '5.0%') — a pre-existing formatter fidelity gap
    // outside this fix; what matters here is the quoted % does NOT scale.
    const s = strOf(textWb(), 7, 0);
    expect(s.startsWith('5.0')).toBe(true);
    expect(s).not.toContain('500');
  });

  it('concatenation from the real file: "grow "&TEXT(...,"0.0%")', () => {
    const wb = new EngineWorkbook({
      S: [['=TEXT(0.0689037471245626,"0.0%")']],
      T: [['="• Revenue is projected to grow "&TEXT(S!A1,"0.0%")&" in FY"']],
    } as any);
    const v: any = wb.getValue({ sheet: 'T', row: 0, col: 0 });
    expect(v.kind).toBe('string');
    expect(v.value).toBe('• Revenue is projected to grow 6.9% in FY');
  });
});

describe('ROUND/ROUNDUP/ROUNDDOWN correctly-rounded (Cycle-8 audit)', () => {
  // HyperFormula computed ROUND as Math.round(x * 10^n) / 10^n; the ×10^n
  // scaling is inexact in binary FP, so near-boundary values rounded the
  // wrong way. Real case: closedxml-xlsx-functions-excel-2010.xlsx
  // Sheet2!L44 =ROUND(L22,12)=ROUND(L33,12), cached TRUE. L22 (our
  // AGGREGATE) = 939.0138241923366, L33 = 939.0138241923374; both must
  // round to 939.013824192337 at 12dp.
  function roundWb() {
    return new EngineWorkbook({
      S: [
        ['=ROUND(939.0138241923366,12)'],
        ['=ROUND(939.0138241923374,12)'],
        ['=A1=A2'],
        ['=ROUND(2.5,0)', '=ROUND(-2.5,0)'],
        ['=ROUNDUP(3.14159,3)', '=ROUNDDOWN(3.14159,3)', '=ROUNDDOWN(-3.14159,3)'],
        ['=ROUND(123.456,-1)', '=ROUND(5,-1)', '=ROUND(0.1+0.2,1)'],
      ],
    });
  }

  it('ROUND(939.0138241923366,12) = 939.013824192337 (Excel)', () => {
    expect(num(roundWb(), 'S', 0, 0)).toBe(939.013824192337);
  });

  it('ROUND(939.0138241923374,12) = 939.013824192337 (Excel)', () => {
    expect(num(roundWb(), 'S', 1, 0)).toBe(939.013824192337);
  });

  it('boundary ROUND values compare equal (the L44 audit case)', () => {
    const v: any = roundWb().getValue({ sheet: 'S', row: 2, col: 0 });
    expect(v.kind).toBe('boolean');
    expect(v.value).toBe(true);
  });

  it('half away from zero', () => {
    const wb = roundWb();
    expect(num(wb, 'S', 3, 0)).toBe(3);
    expect(num(wb, 'S', 3, 1)).toBe(-3);
  });

  it('ROUNDUP/ROUNDDOWN directions', () => {
    const wb = roundWb();
    expect(num(wb, 'S', 4, 0)).toBe(3.142);
    expect(num(wb, 'S', 4, 1)).toBe(3.141);
    expect(num(wb, 'S', 4, 2)).toBe(-3.141);
  });

  it('negative digits and FP-error-prone sums', () => {
    const wb = roundWb();
    expect(num(wb, 'S', 5, 0)).toBe(120);
    expect(num(wb, 'S', 5, 1)).toBe(10);
    expect(num(wb, 'S', 5, 2)).toBe(0.3);
  });

  it('tiny values below the cut never round up (half-away)', () => {
    // 5.55e-16 at 4dp: the first significant digit is far right of the
    // cut; half-away must give 0, not 0.0001. (Real case: saas-3statement
    // MONTHLY VIEW (LITE)!C10 =ROUND(SUM(C9:N9)-1,4), cached 0.)
    const wb = new EngineWorkbook({
      S: [['=ROUND(-5.551115123125783e-16,4)', '=ROUND(5.551115123125783e-16,4)']],
    });
    expect(num(wb, 'S', 0, 0)).toBe(0);
    expect(num(wb, 'S', 0, 1)).toBe(0);
  });

  it('cut == 0 still rounds half away from zero', () => {
    // 0.00006 at 4dp → 0.0001 (first dropped digit adjacent to the cut).
    const wb = new EngineWorkbook({
      S: [['=ROUND(0.00006,4)', '=ROUND(-0.00006,4)', '=ROUNDUP(5.55e-16,4)']],
    });
    expect(num(wb, 'S', 0, 0)).toBe(0.0001);
    expect(num(wb, 'S', 0, 1)).toBe(-0.0001);
    expect(num(wb, 'S', 0, 2)).toBe(0.0001);
  });

  it('sibling functions on the built-in RoundingPlugin still work', () => {
    const wb = new EngineWorkbook({
      S: [['=INT(8.9)', '=EVEN(3)', '=ODD(4)', '=CEILING.PRECISE(4.2)', '=FLOOR(4.9,1)']],
    });
    expect(num(wb, 'S', 0, 0)).toBe(8);
    expect(num(wb, 'S', 0, 1)).toBe(4);
    expect(num(wb, 'S', 0, 2)).toBe(5); // ODD(4) rounds away from zero → 5
    expect(num(wb, 'S', 0, 3)).toBe(5);
    expect(num(wb, 'S', 0, 4)).toBe(4);
  });
});
