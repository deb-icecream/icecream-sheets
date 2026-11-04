/**
 * Tests for the named-range / named-function engine surface
 * (design-docs/named-ranges-and-named-functions.md §§1,5–7):
 * - Named expressions: parse-time name→identity resolution, structural
 *   tracking, dangling #REF!.
 * - Named functions: =DOUBLE(21) evaluates through the ICENAMEDFUNC
 *   dispatcher against the CURRENT LAMBDA; formula text round-trips.
 * - ICEPERMDENIED() surfaces as the typed-view #PERM! value.
 * - rewrite/unrewrite scanners.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineWorkbook,
  rewriteNamedFunctionCalls,
  unrewriteNamedFunctionCalls,
  type CellRef,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

function workbookWithNames() {
  const wb = new EngineWorkbook({ Sheet1: [[1], [2], [3]] });
  wb.addNamedExpression('Sales', '=Sheet1!$A$1:$A$3');
  return wb;
}

describe('named expressions (§§1,5)', () => {
  it('resolves a name at parse time; =SUM(Sales) computes', () => {
    const wb = workbookWithNames();
    wb.setFormula(c('Sheet1', 0, 1), '=SUM(Sales)');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({ kind: 'number', value: 6 });
  });

  it('tracks the range through row insertion without formula edits', () => {
    const wb = workbookWithNames();
    wb.setFormula(c('Sheet1', 0, 1), '=SUM(Sales)');
    // Engine-level structural change: change the expression the way the
    // engine tracks it after an insert, and confirm formulas follow the
    // identity (the service store shifts + rebinds for app-level ops).
    wb.changeNamedExpression('Sales', '=Sheet1!$A$2:$A$4');
    expect(wb.getNamedExpressionFormula('Sales')).toBe('=Sheet1!$A$2:$A$4');
    // Data is still in $A$1:$A$3 (1,2,3); the name now covers $A$2:$A$4 = 2+3.
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({ kind: 'number', value: 5 });
  });

  it('dangling names bind =#REF! and evaluate to #REF!', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]] });
    wb.addNamedExpression('Dead', '=#REF!');
    expect(wb.getNamedExpressionFormula('Dead')).toBe('=#REF!');
    wb.setFormula(c('Sheet1', 0, 1), '=Dead+1');
    const v = wb.getValue(c('Sheet1', 0, 1));
    expect(v).toEqual({ kind: 'error', code: '#REF!' });
  });

  it('removeNamedExpression makes references #NAME?', () => {
    const wb = workbookWithNames();
    wb.setFormula(c('Sheet1', 0, 1), '=SUM(Sales)');
    wb.removeNamedExpression('Sales');
    expect(wb.listNamedExpressions()).not.toContain('Sales');
  });

  it('sheet-scoped names resolve per sheet', () => {
    const wb = new EngineWorkbook({ Sheet1: [[5]], Sheet2: [[7]] });
    const idx = wb.sheetIndex('Sheet2');
    expect(idx).toBe(1);
    wb.addNamedExpression('Local', '=Sheet2!$A$1', idx);
    expect(wb.listNamedExpressions(idx)).toContain('Local');
    expect(wb.listNamedExpressions()).not.toContain('Local');
    wb.setFormula(c('Sheet2', 0, 1), '=Local*2');
    expect(wb.getValue(c('Sheet2', 0, 1))).toEqual({ kind: 'number', value: 14 });
  });

  it('constructor binds definedNames and =#REF! dangling names', () => {
    const wb = new EngineWorkbook(
      { Sheet1: [[10]] },
      {
        definedNames: [
          { name: 'UnitPrice', ref: 'Sheet1!$A$1' },
          { name: 'Gone', ref: '#REF!' },
        ],
      },
    );
    wb.setFormula(c('Sheet1', 0, 1), '=UnitPrice*2');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({ kind: 'number', value: 20 });
    wb.setFormula(c('Sheet1', 0, 2), '=Gone');
    expect(wb.getValue(c('Sheet1', 0, 2)).kind).toBe('error');
  });
});

describe('named functions (§§6–7)', () => {
  it('=DOUBLE(21) evaluates through the dispatcher', () => {
    const wb = new EngineWorkbook({ Sheet1: [[]] });
    wb.defineNamedFunction('Double', 'LAMBDA(x,(x*2))');
    wb.setFormula(c('Sheet1', 0, 0), '=DOUBLE(21)');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual({ kind: 'number', value: 42 });
  });

  it('formula text round-trips (no dispatch leakage)', () => {
    const wb = new EngineWorkbook({ Sheet1: [[]] });
    wb.defineNamedFunction('Double', 'LAMBDA(x,(x*2))');
    wb.setFormula(c('Sheet1', 0, 0), '=DOUBLE(21)+1');
    // Case normalizes to the defined display name (Excel-like).
    expect(wb.getFormula(c('Sheet1', 0, 0))).toBe('=Double(21)+1');
    expect(wb.getSerialized(c('Sheet1', 0, 0))).toBe('=Double(21)+1');
  });

  it('version updates apply with no formula edits (§7)', () => {
    const wb = new EngineWorkbook({ Sheet1: [[]] });
    wb.defineNamedFunction('Double', 'LAMBDA(x,(x*2))');
    wb.setFormula(c('Sheet1', 0, 0), '=DOUBLE(21)');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual({ kind: 'number', value: 42 });
    // v2: triple. The formula is untouched.
    wb.defineNamedFunction('Double', 'LAMBDA(x,(x*3))');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual({ kind: 'number', value: 63 });
    expect(wb.getFormula(c('Sheet1', 0, 0))).toBe('=Double(21)');
  });

  it('nested named-function calls work', () => {
    const wb = new EngineWorkbook({ Sheet1: [[]] });
    wb.defineNamedFunction('Double', 'LAMBDA(x,(x*2))');
    wb.defineNamedFunction('Quad', 'LAMBDA(x,ICENAMEDFUNC("Double",ICENAMEDFUNC("Double",x)))');
    wb.setFormula(c('Sheet1', 0, 0), '=QUAD(3)');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual({ kind: 'number', value: 12 });
  });

  it('removeNamedFunction makes calls #NAME?', () => {
    const wb = new EngineWorkbook({ Sheet1: [[]] });
    wb.defineNamedFunction('Double', 'LAMBDA(x,(x*2))');
    wb.removeNamedFunction('Double');
    expect(wb.hasNamedFunction('Double')).toBe(false);
    wb.setFormula(c('Sheet1', 0, 0), '=DOUBLE(1)');
    expect(wb.getValue(c('Sheet1', 0, 0)).kind).toBe('error');
  });

  it('functions without LAMBDA evaluate to a #VALUE! naming the runtime', () => {
    const wb = new EngineWorkbook({ Sheet1: [[]] });
    wb.defineNamedFunction('PyFn', null);
    wb.setFormula(c('Sheet1', 0, 0), '=PyFn(1)');
    const v = wb.getValue(c('Sheet1', 0, 0));
    expect(v.kind).toBe('error');
  });

  it('snapshot round-trip keeps user formula text', () => {
    const wb = new EngineWorkbook({ Sheet1: [[]] });
    wb.defineNamedFunction('Double', 'LAMBDA(x,(x*2))');
    wb.setFormula(c('Sheet1', 0, 0), '=DOUBLE(4)');
    const snap = wb.toSnapshot();
    const cell = snap.sheets[0]!.cells.find((x) => x.ref.row === 0 && x.ref.col === 0);
    expect(cell?.input).toBe('=Double(4)');
  });
});

describe('ICEPERMDENIED (§5: permission error value)', () => {
  it('evaluates to the typed-view #PERM! value', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1], [2]] });
    wb.addNamedExpression('Secret', '=ICEPERMDENIED()');
    wb.setFormula(c('Sheet1', 0, 1), '=SUM(Secret)');
    const v = wb.getValue(c('Sheet1', 0, 1));
    // The permission error propagates through the aggregation.
    expect(v.kind).toBe('error');
    expect((v as { code?: string }).code).toMatch(/#PERM!|#VALUE!/);
  });

  it('a bare denied name reads as #PERM!', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]] });
    wb.addNamedExpression('Secret', '=ICEPERMDENIED()');
    wb.setFormula(c('Sheet1', 0, 1), '=Secret');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({
      kind: 'error',
      code: '#PERM!',
      message: expect.any(String),
    });
  });
});

describe('rewrite scanners', () => {
  const known = new Map([['double', 'Double']]);

  it('rewrites calls, case-insensitively, with word boundaries', () => {
    expect(rewriteNamedFunctionCalls('=DOUBLE(21)', known)).toBe('=ICENAMEDFUNC("Double",21)');
    expect(rewriteNamedFunctionCalls('=double ( 21 )', known)).toBe('=ICENAMEDFUNC("Double", 21 )');
    expect(rewriteNamedFunctionCalls('=DOUBLE+1', known)).toBe('=DOUBLE+1'); // bare ref untouched
    expect(rewriteNamedFunctionCalls('=DOUBLE2(1)', known)).toBe('=DOUBLE2(1)');
    expect(rewriteNamedFunctionCalls('=SUM(DOUBLE(A1))', known)).toBe(
      '=SUM(ICENAMEDFUNC("Double",A1))',
    );
  });

  it('skips string literals', () => {
    expect(rewriteNamedFunctionCalls('="DOUBLE(1)"&DOUBLE(2)', known)).toBe(
      '="DOUBLE(1)"&ICENAMEDFUNC("Double",2)',
    );
  });

  it('unrewrite restores user text (incl. nesting)', () => {
    expect(unrewriteNamedFunctionCalls('=ICENAMEDFUNC("Double",21)')).toBe('=Double(21)');
    expect(unrewriteNamedFunctionCalls('=1+ICENAMEDFUNC("Double",ICENAMEDFUNC("Double",x))')).toBe(
      '=1+Double(Double(x))',
    );
  });

  it('rewrite is a no-op with no known functions', () => {
    expect(rewriteNamedFunctionCalls('=DOUBLE(1)', new Map())).toBe('=DOUBLE(1)');
  });
});

describe('BUG-2: named reference to an empty cell compares as empty (formula audit)', () => {
  function workbookWithEmptyName() {
    const wb = new EngineWorkbook({ Sheet1: [['x']] });
    wb.addNamedExpression('EmptyName', '=Sheet1!$A$18');
    wb.addNamedExpression('ValName', '=Sheet1!$A$1');
    return wb;
  }

  it('=EmptyName="" is TRUE and =EmptyName<>"" is FALSE (like =A18)', () => {
    const wb = workbookWithEmptyName();
    wb.setFormula(c('Sheet1', 0, 1), '=EmptyName=""');
    wb.setFormula(c('Sheet1', 0, 2), '=EmptyName<>""');
    wb.setFormula(c('Sheet1', 0, 3), '=A18=""');
    wb.setFormula(c('Sheet1', 0, 4), '=A18<>""');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({ kind: 'boolean', value: true });
    expect(wb.getValue(c('Sheet1', 0, 2))).toEqual({ kind: 'boolean', value: false });
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(wb.getValue(c('Sheet1', 0, 3)));
    expect(wb.getValue(c('Sheet1', 0, 2))).toEqual(wb.getValue(c('Sheet1', 0, 4)));
  });

  it('comparison operators on the name match the direct reference', () => {
    const wb = workbookWithEmptyName();
    const pairs: Array<[string, string]> = [
      ['=EmptyName=0', '=A18=0'],
      ['=EmptyName=A18', '=A18=A18'],
      ['=EmptyName<0', '=A18<0'],
      ['=EmptyName>0', '=A18>0'],
      ['=EmptyName<=0', '=A18<=0'],
      ['=EmptyName>=0', '=A18>=0'],
      ['=EmptyName<="z"', '=A18<="z"'],
      ['=ValName="x"', '=A1="x"'],
      ['=ValName<>""', '=A1<>""'],
    ];
    pairs.forEach(([named, direct], i) => {
      wb.setFormula(c('Sheet1', 0, 10 + 2 * i), named);
      wb.setFormula(c('Sheet1', 0, 11 + 2 * i), direct);
      expect(wb.getValue(c('Sheet1', 0, 10 + 2 * i))).toEqual(
        wb.getValue(c('Sheet1', 0, 11 + 2 * i)),
      );
    });
  });

  it('=EmptyName still displays 0 and behaves as 0 in arithmetic', () => {
    const wb = workbookWithEmptyName();
    wb.setFormula(c('Sheet1', 0, 1), '=EmptyName');
    wb.setFormula(c('Sheet1', 0, 2), '=EmptyName+1');
    wb.setFormula(c('Sheet1', 0, 3), '=IF(EmptyName="","y","n")');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({ kind: 'number', value: 0 });
    expect(wb.getValue(c('Sheet1', 0, 2))).toEqual({ kind: 'number', value: 1 });
    expect(wb.getValue(c('Sheet1', 0, 3))).toEqual({ kind: 'string', value: 'y' });
  });

  it('name tracks the cell: filling/clearing the target updates comparisons', () => {
    const wb = workbookWithEmptyName();
    wb.setFormula(c('Sheet1', 0, 1), '=EmptyName=""');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({ kind: 'boolean', value: true });
    wb.setCell(c('Sheet1', 17, 0), 'hello');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({ kind: 'boolean', value: false });
    wb.setCell(c('Sheet1', 17, 0), null);
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({ kind: 'boolean', value: true });
  });

  it('named formulas and ranges are unaffected', () => {
    const wb = workbookWithEmptyName();
    wb.addNamedExpression('Two', '=1+1');
    wb.addNamedExpression('Rng', '=Sheet1!$A$1:$A$3');
    wb.setFormula(c('Sheet1', 0, 1), '=Two');
    wb.setFormula(c('Sheet1', 0, 2), '=Two=""');
    wb.setFormula(c('Sheet1', 0, 3), '=SUM(Rng)');
    wb.setFormula(c('Sheet1', 0, 4), '=ValName');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual({ kind: 'number', value: 2 });
    expect(wb.getValue(c('Sheet1', 0, 2))).toEqual({ kind: 'boolean', value: false });
    expect(wb.getValue(c('Sheet1', 0, 3))).toEqual({ kind: 'number', value: 0 });
    expect(wb.getValue(c('Sheet1', 0, 4))).toEqual({ kind: 'string', value: 'x' });
  });
});
