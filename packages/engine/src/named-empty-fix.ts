/**
 * BUG-2 fix (formula audit): named empty-cell comparisons against "".
 *
 * HyperFormula materializes every named expression as a formula vertex on
 * the synthetic sheet NamedExpressions.SHEET_FOR_WORKBOOK_EXPRESSIONS (-1).
 * The engine builds HyperFormula with `evaluateNullToZero: true` (Excel
 * parity for regular formula cells: =A18 on an empty A18 displays 0), and
 * Evaluator.evaluateAstToCellValue rewrites an EmptyValue formula result to
 * 0 when caching the vertex value. A named *reference* to an empty cell
 * therefore compared as the number 0: =Name="" -> FALSE, =Name<>"" -> TRUE.
 *
 * Excel treats a defined name that refers to a cell exactly like the cell
 * reference itself: =Name="" -> TRUE when the cell is empty (while =Name
 * still displays 0). The interpreter's comparison operators already handle
 * the EmptyValue singleton correctly (ArithmeticHelper.compare coerces
 * empty to the other operand's type), so the fix is to keep EmptyValue in
 * the named-expression vertex cache instead of converting it to 0.
 *
 * Only named-expression vertices (sheet === -1) are affected: regular
 * formula cells keep the evaluateNullToZero behavior (display 0, and
 * =B1="" -> FALSE when B1 contains =A18 — both Excel-correct).
 *
 * Side-effectful: patches Evaluator.prototype once at import time. It MUST
 * be imported before any EngineWorkbook is constructed; it is imported via
 * plugins.ts so the parallel-recalc worker (which imports plugins.ts, not
 * index.ts) applies the identical behavior in worker threads.
 */
import { EmptyValue, SimpleRangeValue } from 'hyperformula';
import { Evaluator } from 'hyperformula/commonjs/Evaluator.js';
import { NamedExpressions } from 'hyperformula/commonjs/NamedExpressions.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { Ast } from 'hyperformula/typings/parser/Ast.js';

/** The private Evaluator surface this patch needs. */
interface EvaluatorInternals {
  interpreter: { evaluateAst(ast: Ast, state: InterpreterState): unknown };
  config: { evaluateNullToZero: boolean };
}

type EvaluateAstToCellValue = (
  this: EvaluatorInternals,
  ast: Ast,
  state: InterpreterState,
) => unknown;

const evaluatorProto = Evaluator.prototype as unknown as {
  evaluateAstToCellValue: EvaluateAstToCellValue;
};

// Reimplementation of HyperFormula 2.7.1's Evaluator#evaluateAstToCellValue
// with one change: the EmptyValue -> 0 rewrite (evaluateNullToZero) is
// skipped for named-expression vertices, so a name that resolves to an
// empty cell keeps comparing as empty text ("") instead of the number 0.
evaluatorProto.evaluateAstToCellValue = function (
  this: EvaluatorInternals,
  ast: Ast,
  state: InterpreterState,
): unknown {
  const interpreterValue = this.interpreter.evaluateAst(ast, state);
  if (interpreterValue instanceof SimpleRangeValue) {
    return interpreterValue;
  }
  if (
    interpreterValue === EmptyValue &&
    this.config.evaluateNullToZero &&
    state.formulaAddress.sheet !== NamedExpressions.SHEET_FOR_WORKBOOK_EXPRESSIONS
  ) {
    return 0;
  }
  return interpreterValue;
};
