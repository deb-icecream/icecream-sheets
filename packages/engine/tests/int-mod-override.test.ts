/**
 * INT / MOD Excel-semantics override (hf-overrides.ts IntModOverridePlugin).
 *
 * HyperFormula's INT truncates toward zero and its MOD is the JS remainder
 * (sign of the dividend). Excel: INT rounds DOWN toward −∞ and MOD follows
 * the sign of the divisor (MOD(n,d) = n − d·INT(n/d), Microsoft's documented
 * definition). Expected values below are Excel's: the two gold-corpus cases
 * (samples/generate-golden.mjs: INT(-7.1) = -8, MOD(-10,3) = 2) plus the
 * sign/edge matrix from Microsoft's INT and MOD function pages.
 */
import { describe, it, expect } from 'vitest';
import { EngineWorkbook } from '../src/index.js';

function evalFormulas(formulas: string[]): unknown[] {
  const wb = new EngineWorkbook({ S: formulas.map((f) => [f]) });
  return formulas.map((_, i) => {
    const v: any = wb.getValue({ sheet: 'S', row: i, col: 0 });
    return v.kind === 'error' ? v.code : v.value;
  });
}

describe('INT — Excel floor semantics', () => {
  it('rounds down toward −∞ for positives and negatives', () => {
    expect(
      evalFormulas([
        '=INT(7.9)',
        '=INT(-7.1)', // gold case: Excel -8 (HF truncation gave -7)
        '=INT(-7)',
        '=INT(0.5)',
        '=INT(-0.5)',
        '=INT(8.9)',
        '=INT(-8.9)',
        '=INT(19.5)',
      ]),
    ).toEqual([7, -8, -7, 0, -1, 8, -9, 19]);
  });

  it('works through cell references and propagates errors', () => {
    const wb = new EngineWorkbook({
      S: [[-7.1], ['=INT(A1)'], ['=INT("x")'], ['=INT(1/0)']],
    });
    const v: any = wb.getValue({ sheet: 'S', row: 1, col: 0 });
    expect(v).toMatchObject({ kind: 'number', value: -8 });
    const e: any = wb.getValue({ sheet: 'S', row: 2, col: 0 });
    expect(e.kind).toBe('error');
    const e2: any = wb.getValue({ sheet: 'S', row: 3, col: 0 });
    expect(e2.kind).toBe('error');
  });
});

describe('MOD — Excel sign-of-divisor semantics', () => {
  it('matches Excel across the sign matrix', () => {
    expect(
      evalFormulas([
        '=MOD(10,3)',
        '=MOD(-10,3)', // gold case: Excel 2 (JS remainder gave -1)
        '=MOD(10,-3)',
        '=MOD(-10,-3)',
        '=MOD(3,-2)',
        '=MOD(-3,2)',
        '=MOD(6,3)',
        '=MOD(-6,3)',
        '=MOD(5.5,2)',
        '=MOD(-5.5,2)',
      ]),
    ).toEqual([1, 2, -2, -1, -1, 1, 0, 0, 1.5, 0.5]);
  });

  it('MOD(n, 0) is #DIV/0! like Excel', () => {
    expect(evalFormulas(['=MOD(5,0)'])).toEqual(['#DIV/0!']);
  });

  it('satisfies MOD(n,d) = n − d·INT(n/d) with the overridden INT', () => {
    expect(evalFormulas(['=MOD(-10,3)=-10-3*INT(-10/3)', '=MOD(7,3)=7-3*INT(7/3)'])).toEqual([
      true,
      true,
    ]);
  });
});
