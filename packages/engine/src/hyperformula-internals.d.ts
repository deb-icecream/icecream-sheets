/**
 * Minimal ambient typings for HyperFormula subpath runtime imports.
 *
 * The engine consumes the CommonJS build of HyperFormula (see
 * localization.ts, which imports i18n packs from
 * 'hyperformula/commonjs/...'). These declarations cover the runtime pieces
 * used outside the package root: AbsoluteCellRange (range address
 * iteration), the AstNodeType enum (AST dispatch), the number formatter
 * (TEXT % scaling override), and getRawValue (RichNumber unwrapping). Only
 * the members the engine touches are declared.
 */
declare module 'hyperformula/commonjs/AbsoluteCellRange.js' {
  import type { SimpleCellAddress } from 'hyperformula';
  import type {
    CellRangeAst,
    ColumnRangeAst,
    RowRangeAst,
  } from 'hyperformula/typings/parser/Ast.js';

  export class AbsoluteCellRange {
    readonly start: SimpleCellAddress;
    readonly end: SimpleCellAddress;
    readonly sheet: number;
    static fromAst(
      ast: CellRangeAst | ColumnRangeAst | RowRangeAst,
      baseAddress: SimpleCellAddress,
    ): AbsoluteCellRange;
    static fromSimpleCellAddresses(
      start: SimpleCellAddress,
      end: SimpleCellAddress,
    ): AbsoluteCellRange;
    /** Geometric intersection; undefined when ranges don't overlap. */
    intersectionWith(other: AbsoluteCellRange): AbsoluteCellRange | undefined;
    /** Row-major addresses; unbounded ends are clamped to the used range. */
    addresses(dependencyGraph?: unknown): SimpleCellAddress[];
  }
}

declare module 'hyperformula/commonjs/parser/Ast.js' {
  export enum AstNodeType {
    EMPTY = 'EMPTY',
    NUMBER = 'NUMBER',
    STRING = 'STRING',
    CELL_REFERENCE = 'CELL_REFERENCE',
    CELL_RANGE = 'CELL_RANGE',
    COLUMN_RANGE = 'COLUMN_RANGE',
    ROW_RANGE = 'ROW_RANGE',
    FUNCTION_CALL = 'FUNCTION_CALL',
    PROCEDURE = 'PROCEDURE',
    NAMED_EXPRESSION = 'NAMED_EXPRESSION',
  }
}

declare module 'hyperformula/commonjs/format/format.js' {
  import type { Config } from 'hyperformula';
  import type { DateTimeHelper } from 'hyperformula/typings/DateTimeHelper.js';
  import type { RawScalarValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';

  export function format(
    value: number,
    formatArg: string,
    config: Config,
    dateHelper: DateTimeHelper,
  ): RawScalarValue;
}

declare module 'hyperformula/commonjs/interpreter/InterpreterValue.js' {
  /** Unwraps RichNumber (DateNumber, CurrencyNumber, …) to the raw number. */
  export function getRawValue<T>(num: T): number | T;
}

declare module 'hyperformula/commonjs/Evaluator.js' {
  /** HyperFormula's formula evaluator (one instance per HyperFormula). */
  export class Evaluator {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prototype: any;
  }
}

declare module 'hyperformula/commonjs/NamedExpressions.js' {
  export class NamedExpressions {
    /** Synthetic sheet id of workbook/sheet-scoped named-expression vertices. */
    static SHEET_FOR_WORKBOOK_EXPRESSIONS: number;
  }
}
