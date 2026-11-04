/**
 * HyperFormula evaluation-semantics fixes (formula audit v2, gaps #1–2).
 *
 * Gap #1: HyperFormula detects cycles STATICALLY over the full dependency
 * graph — including untaken IF/CHOOSE branches and self-including SUBTOTAL
 * ranges — while Excel evaluates lazily. The engine re-evaluates
 * statically-poisoned (#CYCLE!) cells against live vertex values and keeps
 * the recomputed value whenever it is not a genuine cycle.
 *
 * Gap #2: a formula that is a bare reference to an empty cell evaluates to
 * null; Excel coerces it to 0 (HyperFormula `evaluateNullToZero`).
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook, scalar, err } from '../src/index.js';

function c(sheet: string, row: number, col: number) {
  return { sheet, row, col };
}

describe('bare reference to empty cell → 0 (Excel)', () => {
  it('=B1 with B1 empty evaluates to 0, not null', () => {
    const wb = new EngineWorkbook({ S: [['=B1', null]] });
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar(0));
  });

  it('truly empty cells still read as null', () => {
    const wb = new EngineWorkbook({ S: [[null]] });
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar(null));
  });

  it('empty string stays an empty string', () => {
    const wb = new EngineWorkbook({ S: [['=""']] });
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar(''));
  });

  it('reference to a zero cell is 0', () => {
    const wb = new EngineWorkbook({ S: [['=B1', 0]] });
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar(0));
  });

  it('cross-sheet bare reference to empty cell → 0', () => {
    const wb = new EngineWorkbook({ S1: [['=S2!A1']], S2: [[]] });
    expect(wb.getValue(c('S1', 0, 0))).toEqual(scalar(0));
  });

  it('empty ref participates in arithmetic as 0', () => {
    const wb = new EngineWorkbook({ S: [['=B1+5', null]] });
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar(5));
  });
});

describe('false-positive static cycles (Excel evaluates lazily)', () => {
  it('IF with untaken INDEX branch over a dependent range', () => {
    // Mirrors beyond-excel-bxl3way.xlsx Calcs!T7:
    // T7=IF(S7=1, Debt_Opening, INDEX(V7:V16, S7-1)), V7=T7+U7.
    const wb = new EngineWorkbook({
      S: [
        [1, '=IF(A1=1, 50000, INDEX(C1:C3, A1-1))', 10],
        [null, '=B1+1', 20],
        [null, null, 30],
      ],
    });
    expect(wb.getValue(c('S', 0, 1))).toEqual(scalar(50000));
    expect(wb.getValue(c('S', 1, 1))).toEqual(scalar(50001));
  });

  it('genuine self-reference cycle stays 0 (Excel)', () => {
    const wb = new EngineWorkbook({ S: [['=A1+1']] });
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar(0));
  });

  it('genuine two-cell cycle stays 0 (Excel)', () => {
    const wb = new EngineWorkbook({ S: [['=B1+1', '=A1+1']] });
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar(0));
    expect(wb.getValue(c('S', 0, 1))).toEqual(scalar(0));
  });

  it('false cycle that becomes genuine when the branch is taken', () => {
    const wb = new EngineWorkbook({
      S: [
        [1, '=IF(A1=1, 50000, C2*2)'],
        [null, '=B1+1'],
      ],
    });
    // Untaken branch: no cycle.
    expect(wb.getValue(c('S', 0, 1))).toEqual(scalar(50000));
    expect(wb.getValue(c('S', 1, 1))).toEqual(scalar(50001));
    // Taken branch references C2 which depends on B1: genuine cycle → 0.
    wb.setCell(c('S', 0, 0), 2);
    expect(wb.getValue(c('S', 0, 1))).toEqual(scalar(0));
    // And back again.
    wb.setCell(c('S', 0, 0), 1);
    expect(wb.getValue(c('S', 0, 1))).toEqual(scalar(50000));
    expect(wb.getValue(c('S', 1, 1))).toEqual(scalar(50001));
  });

  it('cycle introduced after construction resolves via the update path', () => {
    const wb = new EngineWorkbook({ S: [[1, 7, null], [null, null, null]] });
    expect(wb.getValue(c('S', 0, 1))).toEqual(scalar(7));
    wb.setCell(c('S', 0, 1), '=IF(A1=1, 50000, C2*2)');
    wb.setCell(c('S', 1, 1), '=B1+1');
    expect(wb.getValue(c('S', 0, 1))).toEqual(scalar(50000));
    expect(wb.getValue(c('S', 1, 1))).toEqual(scalar(50001));
  });

  it('IFERROR over a false-cycle cell sees the real value (dependent cascade)', () => {
    const wb = new EngineWorkbook({
      S: [
        [1, '=IF(A1=1, 50000, C2*2)', '=IFERROR(B1, -1)'],
        [null, '=B1+1', null],
      ],
    });
    expect(wb.getValue(c('S', 0, 1))).toEqual(scalar(50000));
    expect(wb.getValue(c('S', 0, 2))).toEqual(scalar(50000));
  });

  it('manual calculation mode resolves on recalculate()', () => {
    const wb = new EngineWorkbook({
      S: [
        [1, '=IF(A1=1, 50000, C2*2)'],
        [null, '=B1+1'],
      ],
    });
    wb.setCalculationMode('manual');
    wb.setCell(c('S', 0, 0), 1);
    wb.recalculate();
    expect(wb.getValue(c('S', 0, 1))).toEqual(scalar(50000));
    expect(wb.getValue(c('S', 1, 1))).toEqual(scalar(50001));
    wb.setCalculationMode('automatic');
  });
});

describe('SUBTOTAL ignores nested SUBTOTAL/AGGREGATE (Excel)', () => {
  it('self-including totals-row range (TableHeadersWithLineBreaks K7 idiom)', () => {
    const wb = new EngineWorkbook({
      S: [[1], [2], [3], [4], [5], ['=SUBTOTAL(103,A1:A6)']],
    });
    expect(wb.getValue(c('S', 5, 0))).toEqual(scalar(5));
  });

  it('nested SUBTOTAL excluded without any cycle', () => {
    const wb = new EngineWorkbook({
      S: [[1], [2], ['=SUBTOTAL(9,A1:A2)'], ['=SUBTOTAL(9,A1:A3)']],
    });
    // A4 = 1+2, excluding A3's own subtotal (3).
    expect(wb.getValue(c('S', 3, 0))).toEqual(scalar(3));
  });

  it('nested AGGREGATE excluded from SUBTOTAL', () => {
    const wb = new EngineWorkbook({
      S: [[1], [2], ['=AGGREGATE(9,4,A1:A2)'], ['=SUBTOTAL(9,A1:A3)']],
    });
    expect(wb.getValue(c('S', 3, 0))).toEqual(scalar(3));
  });

  it('plain SUBTOTAL without nesting is unchanged', () => {
    const wb = new EngineWorkbook({
      S: [[1], [2], [3], ['=SUBTOTAL(9,A1:A3)'], ['=SUBTOTAL(1,A1:A3)'], ['=SUBTOTAL(3,A1:A3)']],
    });
    expect(wb.getValue(c('S', 3, 0))).toEqual(scalar(6));
    expect(wb.getValue(c('S', 4, 0))).toEqual(scalar(2));
    expect(wb.getValue(c('S', 5, 0))).toEqual(scalar(3));
  });

  it('SUBTOTAL still propagates errors from non-nested cells', () => {
    const wb = new EngineWorkbook({
      S: [[1], ['=1/0'], ['=SUBTOTAL(9,A1:A2)']],
    });
    expect(wb.getValue(c('S', 2, 0))).toEqual(err('#DIV/0!'));
  });

  it('invalid function number → #VALUE! (built-in parity)', () => {
    const wb = new EngineWorkbook({ S: [['=SUBTOTAL(12,A1:A2)', 5]] });
    expect(wb.getValue(c('S', 0, 0)).kind).toEqual('error');
  });
});

describe('fixpoint propagates to named expressions (Cycle-8 audit)', () => {
  // Mirrors beyond-excel-bxl3way.xlsx CHKs!B21 (=INDEX(...)): the cell is a
  // false-positive static cycle, so the fixpoint corrects it with a silent
  // vertex write. Named expressions pointing at such a cell (e.g.
  // Income_Statement_Table -> CHKs!B21) were evaluated before the
  // correction and stayed stale, because HyperFormula surfaces them as
  // sheet:-1 dependents invisible to the cell-graph walk. The fixpoint now
  // re-evaluates dependent names via changeNamedExpression.
  it('named expression over a false-cycle cell resolves after the fixpoint', () => {
    const wb = new EngineWorkbook(
      {
        S: [
          ['=MyName'], // A1: references the name before A3 exists
          [null],
          ['=IF(FALSE,A3,42)'], // A3: static self-cycle, lazy value 42
        ],
      },
      { definedNames: [{ name: 'MyName', ref: 'S!$A$3' }] },
    );
    expect(wb.getValue(c('S', 2, 0))).toEqual(scalar(42));
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar(42));
  });

  it('downstream cells of the name also settle (transitive propagation)', () => {
    const wb = new EngineWorkbook(
      {
        S: [
          ['=MyName'],
          ['=A1*2'],
          ['=IF(FALSE,A3,21)'],
        ],
      },
      { definedNames: [{ name: 'MyName', ref: 'S!$A$3' }] },
    );
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar(21));
    expect(wb.getValue(c('S', 1, 0))).toEqual(scalar(42));
  });
});
