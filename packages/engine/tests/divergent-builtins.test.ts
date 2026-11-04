/**
 * Tests for the WORKDAY.INTL divergent-builtin reroute
 * (src/divergent-builtins.ts): HyperFormula returns #VALUE! for an
 * omitted/empty weekend argument and #NUM! for weekend=0; Excel treats all
 * three as weekend code 1 (Saturday/Sunday).
 *
 * Serial anchor: 41709 = 2014-03-11 (Tuesday). 24 workdays later with a
 * Sat/Sun weekend is 2014-04-14 (Monday) = serial 41743 (verified against
 * Python's datetime independently of this implementation).
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook } from '../src/index.js';
import {
  rewriteDivergentBuiltinCalls,
  unrewriteDivergentBuiltinCalls,
} from '../src/divergent-builtins.js';

function wbWith(formulas: string[][]): EngineWorkbook {
  const rows: any[][] = [[41709], [41714]];
  for (const f of formulas) rows.push(f);
  return new EngineWorkbook({ S: rows });
}

function val(wb: EngineWorkbook, row: number): any {
  return (wb as any).getValue({ sheet: 'S', row, col: 0 });
}

describe('CEILING Excel parity (divergent builtin)', () => {
  it('CEILING(x,0)=0, FLOOR(x,0)=#DIV/0!, mixed signs=#NUM!', () => {
    const wb = new EngineWorkbook({
      S: [
        ['=CEILING(23.5,0)', '=CEILING(23.5,1)', '=CEILING(23.5,-1)', '=CEILING(-23.5,-1)'],
        ['=FLOOR(23.5,0)', '=CEILING(0,0)'],
      ],
    } as any);
    const v = (r: number, c: number): string => {
      const x: any = (wb as any).getValue({ sheet: 'S', row: r, col: c });
      return x && x.kind === 'error' ? x.code : JSON.stringify(x.value);
    };
    expect(v(0, 0)).toBe('0'); // Excel: CEILING(x,0) = 0
    expect(v(0, 1)).toBe('24');
    expect(v(0, 2)).toBe('#NUM!'); // mixed signs
    expect(v(0, 3)).toBe('-24');
    expect(v(1, 0)).toBe('#DIV/0!'); // FLOOR(x,0) stays #DIV/0! in Excel
    expect(v(1, 1)).toBe('0');
    // Rewrite is transparent in getFormula.
    expect((wb as any).getFormula({ sheet: 'S', row: 0, col: 0 })).toBe('=CEILING(23.5,0)');
  });
});

describe('WORKDAY.INTL Excel parity', () => {
  it('omitted, empty, and 0 weekend all default to Saturday/Sunday', () => {
    const wb = wbWith([
      ['=WORKDAY.INTL(A1,24,,A2)'], // empty weekend
      ['=WORKDAY.INTL(A1,24,0,A2)'], // weekend = 0
      ['=WORKDAY.INTL(A1,24,1,A2)'], // weekend = 1 (explicit Sat/Sun)
    ]);
    expect(val(wb, 2)).toEqual({ kind: 'number', value: 41743 });
    expect(val(wb, 3)).toEqual({ kind: 'number', value: 41743 });
    expect(val(wb, 4)).toEqual({ kind: 'number', value: 41743 });
  });

  it('supports numeric weekend codes 2-7', () => {
    const wb = wbWith([
      ['=WORKDAY.INTL(A1,1,2)'], // Sun/Mon weekend: Tue->Wed
      ['=WORKDAY.INTL(A1,1,7)'], // Fri/Sat weekend: Tue->Wed
    ]);
    // 2014-03-11 Tue + 1 workday skipping Sun/Mon = Wed 2014-03-12 = 41710
    expect(val(wb, 2)).toEqual({ kind: 'number', value: 41710 });
    expect(val(wb, 3)).toEqual({ kind: 'number', value: 41710 });
  });

  it('supports single-day weekend codes 11-17', () => {
    const wb = wbWith([
      ['=WORKDAY.INTL(A1,1,11)'], // Sunday only: Tue->Wed
      ['=WORKDAY.INTL(A1,5,17)'], // Saturday only: Tue + 5 = Mon 3/17
    ]);
    expect(val(wb, 2)).toEqual({ kind: 'number', value: 41710 });
    // Sat-only weekend: Wed,Thu,Fri,Sun,Mon = 5 workdays → 2014-03-17 = 41715
    expect(val(wb, 3)).toEqual({ kind: 'number', value: 41715 });
  });

  it('supports 7-char mask strings', () => {
    const wb = wbWith([
      ['=WORKDAY.INTL(A1,24,"0000011",A2)'], // Sat/Sun mask
      ['=WORKDAY.INTL(A1,1,"1000000")'], // Monday only: Tue->Wed
    ]);
    expect(val(wb, 2)).toEqual({ kind: 'number', value: 41743 });
    expect(val(wb, 3)).toEqual({ kind: 'number', value: 41710 });
  });

  it('walks backwards for negative days and skips holidays', () => {
    const wb = wbWith([
      ['=WORKDAY.INTL(A1,-1,1)'], // Tue - 1 workday = Mon 3/10 = 41708
      ['=WORKDAY.INTL(A1,1,1,A2)'], // A2=41714 is a Saturday: no effect
    ]);
    expect(val(wb, 2)).toEqual({ kind: 'number', value: 41708 });
    // 1 workday from Tue 3/11 = Wed 3/12 (holiday is Sat, already weekend)
    expect(val(wb, 3)).toEqual({ kind: 'number', value: 41710 });
  });

  it('skips a weekday holiday', () => {
    // Holiday on Wed 2014-03-12 (serial 41710): 1 workday from Tue → Thu 3/13
    const wb = new EngineWorkbook({ S: [[41709], [41710], ['=WORKDAY.INTL(A1,1,1,A2)']] });
    expect(val(wb, 2)).toEqual({ kind: 'number', value: 41711 });
  });

  it('rejects an unrecognized weekend code with #NUM!', () => {
    const wb = wbWith([['=WORKDAY.INTL(A1,1,99)']]);
    const v = val(wb, 2);
    expect(v.kind).toBe('error');
    expect(v.code).toBe('#NUM!');
  });

  it('rewrite is transparent: getFormula shows WORKDAY.INTL', () => {
    const wb = wbWith([['=WORKDAY.INTL(A1,24,,A2)']]);
    const formula = (wb as any).getFormula({ sheet: 'S', row: 2, col: 0 });
    expect(formula).toBe('=WORKDAY.INTL(A1,24,,A2)');
  });

  it('rewriteDivergentBuiltinCalls handles the dotted name', () => {
    expect(rewriteDivergentBuiltinCalls('=WORKDAY.INTL(A1,24,,A2)')).toBe('=ICEWORKDAYINTL(A1,24,,A2)');
    expect(rewriteDivergentBuiltinCalls('=workday.intl(A1,24,0)')).toBe('=ICEWORKDAYINTL(A1,24,0)');
    // Plain WORKDAY is a different function: untouched.
    expect(rewriteDivergentBuiltinCalls('=WORKDAY(A1,24)')).toBe('=WORKDAY(A1,24)');
    // No false positive inside string literals.
    expect(rewriteDivergentBuiltinCalls('="WORKDAY.INTL("')).toBe('="WORKDAY.INTL("');
    expect(unrewriteDivergentBuiltinCalls('=ICEWORKDAYINTL(A1,24,,A2)')).toBe('=WORKDAY.INTL(A1,24,,A2)');
  });
});
