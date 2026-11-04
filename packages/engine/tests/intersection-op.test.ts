/**
 * Tests for Excel's intersection (space) operator (src/intersection-op.ts).
 *
 * HyperFormula has no intersection operator: `=A1:B2 C3:D4` used to fail
 * parsing (ErrorType.ERROR → the typed view's '#ERROR'). The engine now
 * rewrites the space operator to the ICEINTERSECT dispatcher, so a
 * non-overlapping intersection yields the distinct '#NULL!' error code and
 * an overlapping one yields the intersecting values.
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook } from '../src/index.js';
import {
  hasIntersectionCalls,
  rewriteIntersectionOperator,
  unrewriteIntersectionOperator,
} from '../src/intersection-op.js';

function wb(): EngineWorkbook {
  return new EngineWorkbook({
    S: [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
    T: [[10]],
  } as any);
}

function val(w: EngineWorkbook, sheet: string, row: number, col = 0): any {
  return (w as any).getValue({ sheet, row, col });
}

function code(w: EngineWorkbook, sheet: string, row: number, col = 0): string {
  const v = val(w, sheet, row, col);
  return v && v.kind === 'error' ? v.code : JSON.stringify(v?.value);
}

describe('rewriteIntersectionOperator (pure text rewrite)', () => {
  it('wraps a disjoint range intersection', () => {
    expect(rewriteIntersectionOperator('=A1:B2 C3:D4')).toBe(
      '=ICEINTERSECT(A1:B2,C3:D4)',
    );
  });
  it('wraps single-cell intersections', () => {
    expect(rewriteIntersectionOperator('=A1 A1')).toBe('=ICEINTERSECT(A1,A1)');
  });
  it('wraps chained intersections into one n-ary call', () => {
    expect(rewriteIntersectionOperator('=A1 B2 C3')).toBe(
      '=ICEINTERSECT(A1,B2,C3)',
    );
  });
  it('rewrites inside function arguments', () => {
    expect(rewriteIntersectionOperator('=SUM(A1:B2 B1:B2)')).toBe(
      '=SUM(ICEINTERSECT(A1:B2,B1:B2))',
    );
  });
  it('intersection binds tighter than union', () => {
    expect(rewriteIntersectionOperator('=A1:B2,C3:D4 E5')).toBe(
      '=A1:B2,ICEINTERSECT(C3:D4,E5)',
    );
  });
  it('handles absolute and sheet-qualified references', () => {
    expect(rewriteIntersectionOperator("=$A$1:$B$2 'My Sheet'!C3")).toBe(
      "=ICEINTERSECT($A$1:$B$2,'My Sheet'!C3)",
    );
  });
  it('collapses spaces around the range operator first', () => {
    expect(rewriteIntersectionOperator('=A1 : B2 C3')).toBe(
      '=ICEINTERSECT(A1:B2,C3)',
    );
  });
  it('leaves ordinary spacing alone', () => {
    expect(rewriteIntersectionOperator('=SUM( A1 , A2 )')).toBe('=SUM( A1 , A2 )');
    expect(rewriteIntersectionOperator('=A1+B2')).toBe('=A1+B2');
    expect(rewriteIntersectionOperator('=A1 + B2')).toBe('=A1 + B2');
    expect(rewriteIntersectionOperator('=- 5')).toBe('=- 5');
    expect(rewriteIntersectionOperator('="a b"')).toBe('="a b"');
    expect(rewriteIntersectionOperator('=IF(A1="x y",1,2)')).toBe('=IF(A1="x y",1,2)');
  });
  it('leaves non-reference operands alone', () => {
    // `5` is not reference-shaped: no rewrite (was #ERROR before, still is).
    expect(rewriteIntersectionOperator('=5 5')).toBe('=5 5');
    expect(hasIntersectionCalls(rewriteIntersectionOperator('=5 5'))).toBe(false);
  });
});

describe('unrewriteIntersectionOperator (display round-trip)', () => {
  it('restores the space operator, including nesting', () => {
    expect(unrewriteIntersectionOperator('=ICEINTERSECT(A1:B2,C3:D4)')).toBe(
      '=A1:B2 C3:D4',
    );
    expect(
      unrewriteIntersectionOperator('=SUM(ICEINTERSECT(A1,B2),ICEINTERSECT(C3,D4))'),
    ).toBe('=SUM(A1 B2,C3 D4)');
  });
  it('round-trips through rewrite', () => {
    for (const f of [
      '=A1:B2 C3:D4',
      '=A1 B2 C3',
      "=SUM(A1:B2 'S'!C1)",
      '=A1:B2,C3:D4 E5',
    ]) {
      expect(unrewriteIntersectionOperator(rewriteIntersectionOperator(f))).toBe(f);
    }
  });
});

describe('#NULL! end-to-end (formula → engine → typed view)', () => {
  it('disjoint ranges yield the distinct #NULL! code, not #ERROR', () => {
    const w = wb();
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=A1:B2 C3:D4');
    expect(code(w, 'S', 5)).toBe('#NULL!');
    expect(val(w, 'S', 5)).toEqual({
      kind: 'error',
      code: '#NULL!',
      message: expect.any(String),
    });
  });
  it('disjoint single cells yield #NULL!', () => {
    const w = wb();
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=A1 B2');
    expect(code(w, 'S', 5)).toBe('#NULL!');
  });
  it('cross-sheet intersections yield #NULL!', () => {
    const w = wb();
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=S!A1 T!A1');
    expect(code(w, 'S', 5)).toBe('#NULL!');
  });
  it('overlapping ranges yield the intersecting values to aggregations', () => {
    const w = wb();
    // A1:B2 ∩ B1:C3 = B1:B2 = 2,5 → SUM = 7 (the canonical Excel pattern).
    (w as any).setCell({ sheet: 'S', row: 6, col: 0 }, '=SUM(A1:B2 B1:C3)');
    expect(code(w, 'S', 6)).toBe('7');
    (w as any).setCell({ sheet: 'S', row: 7, col: 0 }, '=AVERAGE(A1:B2 A1:A2)');
    expect(code(w, 'S', 7)).toBe('2.5'); // (1+4)/2
  });
  it('single-cell intersections return the scalar', () => {
    const w = wb();
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=B2 B2');
    expect(code(w, 'S', 5)).toBe('5');
    (w as any).setCell({ sheet: 'S', row: 6, col: 0 }, '=A1 A1');
    expect(code(w, 'S', 6)).toBe('1');
  });
  it('a multi-cell intersection as a bare anchor behaves like a bare range', () => {
    // The engine shows #VALUE! for any bare range anchor (=B1:B2 does the
    // same); Excel's legacy implicit intersection only picks a value when
    // the formula cell's row/column crosses the range.
    const w = wb();
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=A1:B2 B1:C3');
    expect(code(w, 'S', 5)).toBe('#VALUE!');
    (w as any).setCell({ sheet: 'S', row: 6, col: 0 }, '=B1:B2');
    expect(code(w, 'S', 6)).toBe('#VALUE!');
  });
  it('absolute and sheet-qualified intersections work', () => {
    const w = wb();
    // $A$1:$B$2 ∩ $B$1:$C$2 = B1:B2 = 2,5.
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=SUM($A$1:$B$2 $B$1:$C$2)');
    expect(code(w, 'S', 5)).toBe('7');
    // $A$1:$B$2 ∩ $B$2:$C$3 = B2 = 5 (single cell → scalar).
    (w as any).setCell({ sheet: 'S', row: 6, col: 0 }, '=$A$1:$B$2 $B$2:$C$3');
    expect(code(w, 'S', 6)).toBe('5');
    (w as any).setCell({ sheet: 'S', row: 7, col: 0 }, '=S!A1:B2 S!B2:C3');
    expect(code(w, 'S', 7)).toBe('5'); // B2
  });
  it('column/row range intersections work', () => {
    const w = wb();
    // A:A ∩ 2:2 = A2 = 4.
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=A:A 2:2');
    expect(code(w, 'S', 5)).toBe('4');
  });
  it('error operands propagate through the intersection', () => {
    const w = wb();
    (w as any).setCell({ sheet: 'S', row: 0, col: 5 }, '=1/0'); // F1 = #DIV/0!
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=F1 F1');
    expect(code(w, 'S', 5)).toBe('#DIV/0!');
    (w as any).setCell({ sheet: 'S', row: 6, col: 0 }, '=SUM(F1:F2 F1:G1)');
    expect(code(w, 'S', 6)).toBe('#DIV/0!');
  });
  it('getFormula shows the original space-operator text', () => {
    const w = wb();
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=A1:B2 C3:D4');
    expect((w as any).getFormula({ sheet: 'S', row: 5, col: 0 })).toBe(
      '=A1:B2 C3:D4',
    );
  });
  it('the #NULL! literal still works', () => {
    const w = wb();
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=#NULL!');
    expect(code(w, 'S', 5)).toBe('#NULL!');
  });
  it('works under a non-English formula language', () => {
    const w = new EngineWorkbook({ S: [[1, 2], [3, 4]] } as any);
    (w as any).setFormulaLanguage('deDE');
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=A1:B2 C3:D4');
    expect(code(w, 'S', 5)).toBe('#NULL!');
    (w as any).setCell({ sheet: 'S', row: 6, col: 0 }, '=SUMME(A1:B2 B1:B2)');
    expect(code(w, 'S', 6)).toBe('6');
    expect((w as any).getFormula({ sheet: 'S', row: 5, col: 0 })).toBe(
      '=A1:B2 C3:D4',
    );
  });
  it('unrelated formulas are unaffected', () => {
    const w = wb();
    (w as any).setCell({ sheet: 'S', row: 5, col: 0 }, '=SUM(A1:A3)');
    (w as any).setCell({ sheet: 'S', row: 6, col: 0 }, '="a b"');
    (w as any).setCell({ sheet: 'S', row: 7, col: 0 }, '=A1 + B2');
    expect(code(w, 'S', 5)).toBe('12');
    expect(val(w, 'S', 6)).toEqual({ kind: 'string', value: 'a b' });
    expect(code(w, 'S', 7)).toBe('6'); // A1=1, B2=5 — spacing must not rewrite
  });
});
