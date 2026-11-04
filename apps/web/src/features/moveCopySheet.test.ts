/**
 * Unit tests for Move/Copy Sheet index math.
 */
import { describe, expect, it } from 'vitest';
import { copySheetName, insertSheetCopy, moveSheetOrder } from './moveCopySheet';

describe('moveSheetOrder', () => {
  const sheets = ['A', 'B', 'C'];

  it('moves a sheet earlier', () => {
    expect(moveSheetOrder(sheets, 2, 0)).toEqual(['C', 'A', 'B']);
  });

  it('moves a sheet later', () => {
    expect(moveSheetOrder(sheets, 0, 2)).toEqual(['B', 'C', 'A']);
  });

  it('moves to the end', () => {
    expect(moveSheetOrder(sheets, 0, 3)).toEqual(['B', 'C', 'A']);
  });

  it('clamps out-of-range targets', () => {
    expect(moveSheetOrder(sheets, 1, 99)).toEqual(['A', 'C', 'B']);
    expect(moveSheetOrder(sheets, 1, -5)).toEqual(['B', 'A', 'C']);
  });

  it('ignores an invalid source index', () => {
    expect(moveSheetOrder(sheets, 9, 0)).toEqual(sheets);
  });

  it('does not mutate the input', () => {
    const input = [...sheets];
    moveSheetOrder(input, 0, 2);
    expect(input).toEqual(sheets);
  });
});

describe('copySheetName', () => {
  it('appends (2) on collision', () => {
    expect(copySheetName(['Sheet1'], 'Sheet1')).toBe('Sheet1 (2)');
  });

  it('increments past existing copies', () => {
    expect(copySheetName(['S', 'S (2)', 'S (3)'], 'S')).toBe('S (4)');
  });

  it('keeps the base name when free', () => {
    expect(copySheetName(['A'], 'B')).toBe('B');
  });
});

describe('insertSheetCopy', () => {
  it('inserts before the target index', () => {
    expect(insertSheetCopy(['A', 'B'], 'A (2)', 1)).toEqual(['A', 'A (2)', 'B']);
  });

  it('appends at the end for null', () => {
    expect(insertSheetCopy(['A', 'B'], 'A (2)', null)).toEqual(['A', 'B', 'A (2)']);
  });

  it('clamps out-of-range indexes', () => {
    expect(insertSheetCopy(['A'], 'X', 99)).toEqual(['A', 'X']);
  });
});
