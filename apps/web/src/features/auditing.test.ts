import { describe, expect, it } from 'vitest';
import {
  dependentArrows,
  expandRefs,
  extractRefs,
  findErrors,
  nextEvalStep,
  precedentArrows,
  traceDependents,
  tracePrecedents,
  tracePrecedentsTransitive,
  type AuditCellReader,
  type UsedRange,
} from './auditing';
import type { CellRef } from '@icecream-sheets/engine';

function readerOf(cells: Record<string, { formula?: string; value: string; error?: boolean }>): AuditCellReader {
  const key = (r: CellRef) => `${r.sheet}!${r.row},${r.col}`;
  return {
    formulaAt: (r) => cells[key(r)]?.formula,
    valueTextAt: (r) => cells[key(r)]?.value ?? '',
    isErrorAt: (r) => cells[key(r)]?.error ?? false,
  };
}

const R = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });
const used: UsedRange[] = [{ sheet: 'Sheet1', startRow: 0, endRow: 4, startCol: 0, endCol: 2 }];

describe('extractRefs', () => {
  it('extracts plain and absolute cell refs and ranges', () => {
    const refs = extractRefs('=SUM($A$1:A10)+B2');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ sheet: null, startRow: 0, startCol: 0, endRow: 9, endCol: 0 });
    expect(refs[1]).toMatchObject({ startRow: 1, startCol: 1, endRow: 1, endCol: 1 });
  });

  it('handles sheet qualifiers including quoted names', () => {
    const refs = extractRefs("='My Sheet'!A1+Sheet2!B2:C3");
    expect(refs[0].sheet).toBe('My Sheet');
    expect(refs[1]).toMatchObject({ sheet: 'Sheet2', startRow: 1, startCol: 1, endRow: 2, endCol: 2 });
  });

  it('skips string literals and function names', () => {
    expect(extractRefs('=IF(A1>0,"A1","no")')).toHaveLength(1);
    expect(extractRefs('=SUM(A1:A3)')).toHaveLength(1);
  });

  it('ignores identifiers that merely contain ref-like text', () => {
    expect(extractRefs('=A1B+1')).toHaveLength(0);
    expect(extractRefs('=Total1+1')).toHaveLength(0);
  });
});

describe('expandRefs', () => {
  it('expands ranges to cells with a default sheet', () => {
    const cells = expandRefs([{ sheet: null, startRow: 0, startCol: 0, endRow: 1, endCol: 1 }], 'S');
    expect(cells).toHaveLength(4);
    expect(cells[0]).toEqual({ sheet: 'S', row: 0, col: 0 });
  });
});

describe('trace precedents', () => {
  const reader = readerOf({
    'Sheet1!2,1': { formula: '=SUM(A1:A2)+Sheet2!B1', value: '7' },
    'Sheet1!0,0': { value: '1' },
    'Sheet1!1,0': { value: '2' },
    'Sheet2!0,1': { value: '4' },
  });

  it('finds direct precedents across sheets', () => {
    const p = tracePrecedents(reader, R('Sheet1', 2, 1));
    expect(p).toHaveLength(3);
    expect(p).toContainEqual({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(p).toContainEqual({ sheet: 'Sheet1', row: 1, col: 0 });
    expect(p).toContainEqual({ sheet: 'Sheet2', row: 0, col: 1 });
  });

  it('returns [] for constants', () => {
    expect(tracePrecedents(reader, R('Sheet1', 0, 0))).toEqual([]);
  });

  it('walks transitively without cycles', () => {
    const cyclic = readerOf({
      'S!0,0': { formula: '=B1+1', value: '1' },
      'S!0,1': { formula: '=A1+1', value: '2' },
    });
    const p = tracePrecedentsTransitive(cyclic, R('S', 0, 0));
    expect(p).toContainEqual({ sheet: 'S', row: 0, col: 1 });
    // The start cell itself is never re-added.
    expect(p.filter((c) => c.row === 0 && c.col === 0)).toHaveLength(0);
  });

  it('builds precedent arrows pointing at the cell', () => {
    const arrows = precedentArrows(reader, R('Sheet1', 2, 1));
    expect(arrows).toHaveLength(3);
    expect(arrows.every((a) => a.kind === 'precedent' && a.to.row === 2)).toBe(true);
  });
});

describe('trace dependents', () => {
  const reader = readerOf({
    'Sheet1!0,0': { value: '1' },
    'Sheet1!1,0': { formula: '=A1*2', value: '2' },
    'Sheet1!2,1': { formula: '=SUM(A1:A2)', value: '3' },
    'Sheet1!3,0': { formula: '="A1"', value: 'A1' },
  });

  it('finds cells whose formulas reference the target', () => {
    const d = traceDependents(reader, R('Sheet1', 0, 0), used);
    expect(d).toContainEqual({ sheet: 'Sheet1', row: 1, col: 0 });
    expect(d).toContainEqual({ sheet: 'Sheet1', row: 2, col: 1 });
    // A string literal "A1" is not a dependent.
    expect(d).not.toContainEqual({ sheet: 'Sheet1', row: 3, col: 0 });
  });

  it('builds dependent arrows fanning out from the cell', () => {
    const arrows = dependentArrows(reader, R('Sheet1', 0, 0), used);
    expect(arrows).toHaveLength(2);
    expect(arrows.every((a) => a.kind === 'dependent' && a.from.row === 0)).toBe(true);
  });
});

describe('findErrors', () => {
  it('collects error cells with their formulas', () => {
    const reader = readerOf({
      'S!0,0': { formula: '=1/0', value: '#DIV/0!', error: true },
      'S!0,1': { formula: '=A1+1', value: '#DIV/0!', error: true },
      'S!1,0': { value: '5' },
    });
    const errors = findErrors(reader, [{ sheet: 'S', startRow: 0, endRow: 1, startCol: 0, endCol: 1 }]);
    expect(errors).toHaveLength(2);
    expect(errors[0].formula).toBe('=1/0');
    expect(errors[0].valueText).toBe('#DIV/0!');
  });
});

describe('nextEvalStep', () => {
  // evalExpr always receives a complete formula string (leading '=').
  const evalExpr = (expr: string): string => {
    const table: Record<string, string> = {
      '=(3+4)': '7',
      '=1+2*7': '15',
      '=SUM(A1:A3)': '6',
      '=6*2': '12',
    };
    return table[expr] ?? `?${expr}`;
  };

  it('reduces the innermost group first', () => {
    const r = nextEvalStep('=1+2*(3+4)', evalExpr);
    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.step).toEqual({ expression: '(3+4)', result: '7' });
      expect(r.next).toBe('=1+2*7');
    }
  });

  it('finishes when no parens remain', () => {
    const r = nextEvalStep('=1+2*7', evalExpr);
    expect(r).toEqual({ done: true, result: '15' });
  });

  it('includes function names in the reduced expression', () => {
    const r = nextEvalStep('=SUM(A1:A3)*2', evalExpr);
    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.step.expression).toBe('SUM(A1:A3)');
      expect(r.next).toBe('=6*2');
    }
  });

  it('quotes text results on substitution', () => {
    const r = nextEvalStep('=CONCAT("a","b")&"!"', (e) => (e === '=CONCAT("a","b")' ? 'ab' : e));
    expect(r.done).toBe(false);
    if (!r.done) expect(r.next).toBe('="ab"&"!"');
  });

  it('ignores parens inside string literals', () => {
    const r = nextEvalStep('="(" & (1+1)', (e) => (e === '=(1+1)' ? '2' : e));
    expect(r.done).toBe(false);
    if (!r.done) expect(r.step.expression).toBe('(1+1)');
  });
});
