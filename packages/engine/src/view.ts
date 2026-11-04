/**
 * Typed computational view: the projection over storage that the grid UI,
 * MCP agents and automation consume. Never exposes storage internals.
 *
 * v1: projects over an EngineWorkbook. Later: over any StorageAdapter via
 * the same read surface.
 */
import type { EngineWorkbook } from './workbook.js';
import type { AuthContext } from './permissions.js';
import {
  err,
  image,
  scalar,
  type CellRef,
  type ErrorCode,
  type RangeRef,
  type TypedValue,
} from './types.js';

export interface TypedCell {
  ref: CellRef;
  value: TypedValue;
  formula?: string;
}

export class TypedView {
  constructor(private workbook: EngineWorkbook) {}

  readCell(ref: CellRef, auth?: AuthContext): TypedCell {
    return {
      ref,
      value: this.workbook.getValue(ref, auth),
      formula: this.workbook.getFormula(ref),
    };
  }

  readRange(range: RangeRef, auth?: AuthContext): TypedCell[][] {
    const rows: TypedCell[][] = [];
    for (let r = range.startRow; r <= range.endRow; r++) {
      const row: TypedCell[] = [];
      for (let c = range.startCol; c <= range.endCol; c++) {
        row.push(this.readCell({ sheet: range.sheet, row: r, col: c }, auth));
      }
      rows.push(row);
    }
    return rows;
  }

  /** Values only, as a 2-D array (convenient for agents/tests). */
  readRangeValues(range: RangeRef): TypedValue[][] {
    return this.readRange(range).map((row) => row.map((cell) => cell.value));
  }

  /** The used range of a sheet, or null when the sheet is empty. */
  usedRange(sheet: string): RangeRef | null {
    const info = this.workbook.getSheets().find((s) => s.name === sheet);
    if (!info || info.rowCount === 0 || info.colCount === 0) return null;
    return {
      sheet,
      startRow: 0,
      startCol: 0,
      endRow: info.rowCount - 1,
      endCol: info.colCount - 1,
    };
  }

  /** Whole-sheet values; empty sheet -> []. */
  readSheet(sheet: string): TypedValue[][] {
    const range = this.usedRange(sheet);
    if (!range) return [];
    return this.readRangeValues(range);
  }

  /** Coerce a TypedValue to a plain JSON value for transport. */
  static toJson(v: TypedValue): number | string | boolean | null | { error: string } | { image: string } {
    if (v.kind === 'error') return { error: v.code };
    if (v.kind === 'image') return { image: v.src };
    return v.value;
  }

  static fromJson(j: unknown): TypedValue {
    if (j !== null && typeof j === 'object' && 'error' in j) {
      const code = (j as { error: string }).error as ErrorCode;
      return err(code);
    }
    if (j !== null && typeof j === 'object' && 'image' in j) {
      return image(String((j as { image: unknown }).image), '');
    }
    if (typeof j === 'number' || typeof j === 'string' || typeof j === 'boolean' || j === null) {
      return scalar(j);
    }
    return scalar(null);
  }
}
