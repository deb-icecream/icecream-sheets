/**
 * Unit tests for web UI feature modules (undo, find/replace, sheet ops,
 * conditional formatting, validation, merges, filters).
 * All through the engine protocol — no direct HyperFormula use.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import { cellRef, formatDisplay } from '../engine';
import { UndoManager } from './undo';
import { findAll, replaceAll } from './findReplace';
import { insertRows, deleteRows, insertCols, deleteCols, sortByColumn } from './sheetOps';
import {
  cfMatches, makeCFRule, validateEdit, makeValidationRule, findValidation,
  findMerge, makeMerge, isMergeAnchor, rowPassesFilter,
} from './models';

const v = (host: EngineHost, r: number, c: number) =>
  formatDisplay(host.readCell(cellRef('Sheet1', r, c)));

describe('UndoManager', () => {
  it('undoes and redoes cell edits', () => {
    const host = new EngineHost();
    const um = new UndoManager();
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 0, 0), value: 'a' });
    um.capture(host, 'Sheet1', [{ row: 0, col: 0 }], 'edit');
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 0, 0), value: 'b' });
    expect(v(host, 0, 0)).toBe('b');
    expect(um.canUndo()).toBe(true);
    um.undo(host);
    expect(v(host, 0, 0)).toBe('a');
    um.redo(host);
    expect(v(host, 0, 0)).toBe('b');
  });

  it('undoes formulas', () => {
    const host = new EngineHost();
    const um = new UndoManager();
    um.capture(host, 'Sheet1', [{ row: 0, col: 0 }], 'f');
    host.execute({ cmd: 'setFormula', ref: cellRef('Sheet1', 0, 0), formula: '=1+1' });
    expect(v(host, 0, 0)).toBe('2');
    um.undo(host);
    expect(v(host, 0, 0)).toBe('');
  });
});

describe('find/replace', () => {
  it('finds with case and whole-cell options', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 0, 0), value: 'apple pie' });
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 1, 0), value: 'APPLE' });
    expect(findAll(host, 'Sheet1', 'apple', { matchCase: false, wholeCell: false })).toHaveLength(2);
    expect(findAll(host, 'Sheet1', 'apple', { matchCase: true, wholeCell: false })).toHaveLength(1);
    expect(findAll(host, 'Sheet1', 'apple', { matchCase: false, wholeCell: true })).toHaveLength(1);
  });

  it('replaces across cells', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 0, 0), value: 'apple' });
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 1, 0), value: 'apple pie' });
    expect(replaceAll(host, 'Sheet1', 'apple', 'orange', { matchCase: false, wholeCell: false })).toBe(2);
    expect(v(host, 0, 0)).toBe('orange');
  });
});

describe('sheet ops', () => {
  it('inserts and deletes rows', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 0, 0), value: 'A' });
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 1, 0), value: 'B' });
    insertRows(host, 'Sheet1', 1, 1);
    expect(v(host, 2, 0)).toBe('B');
    expect(v(host, 1, 0)).toBe('');
    deleteRows(host, 'Sheet1', 1, 1);
    expect(v(host, 1, 0)).toBe('B');
  });

  it('inserts and deletes columns', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 0, 0), value: 'A' });
    insertCols(host, 'Sheet1', 0, 1);
    expect(v(host, 0, 1)).toBe('A');
    deleteCols(host, 'Sheet1', 0, 1);
    expect(v(host, 0, 0)).toBe('A');
  });

  it('sorts by column keeping header', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 0, 0), value: 'Name' });
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 1, 0), value: 'c' });
    host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', 2, 0), value: 'a' });
    sortByColumn(host, 'Sheet1', 0, 'asc', true);
    expect(v(host, 0, 0)).toBe('Name');
    expect(v(host, 1, 0)).toBe('a');
    expect(v(host, 2, 0)).toBe('c');
  });
});

describe('models', () => {
  it('conditional formatting matches', () => {
    const rule = makeCFRule({
      sheet: 'S', startRow: 0, startCol: 0, endRow: 1, endCol: 1,
      operator: 'gt', operands: ['10'], color: '#fff',
    });
    expect(cfMatches(rule, { kind: 'number', value: 15 } as never)).toBe(true);
    expect(cfMatches(rule, { kind: 'number', value: 5 } as never)).toBe(false);
  });

  it('validation accepts list values', () => {
    const rule = makeValidationRule({ sheet: 'S', row: 0, col: 0, list: ['a', 'b'] });
    expect(validateEdit(rule, 'a')).toBe(true);
    expect(validateEdit(rule, 'z')).toBe(false);
    expect(findValidation([rule], 'S', 0, 0)?.id).toBe(rule.id);
  });

  it('merge lookup works', () => {
    const m = makeMerge({ sheet: 'S', startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(findMerge([m], 'S', 1, 1)?.id).toBe(m.id);
    expect(findMerge([m], 'S', 2, 2)).toBeNull();
    expect(isMergeAnchor(m, 0, 0)).toBe(true);
    expect(isMergeAnchor(m, 1, 0)).toBe(false);
  });

  it('row filter passes/blocks', () => {
    const f = new Map([[0, new Set(['x'])]]);
    expect(rowPassesFilter(f, new Map([[0, 'x']]))).toBe(true);
    expect(rowPassesFilter(f, new Map([[0, 'y']]))).toBe(false);
  });
});
