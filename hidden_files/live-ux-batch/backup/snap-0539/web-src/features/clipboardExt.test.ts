/**
 * Unit tests for clipboard extensions: TSV parsing, paste-special-as-values,
 * and format-painter state.
 */
import { describe, expect, it } from 'vitest';
import {
  parseTsvGrid,
  stripToValues,
  captureFormat,
  applyFormatToCell,
  FormatPainterState,
} from './clipboardExt';
import { createFormatStore, type FormatStore } from './formatting';

const emptyStore = (): FormatStore => createFormatStore();

describe('parseTsvGrid', () => {
  it('parses a single cell', () => {
    expect(parseTsvGrid('hello')).toEqual([['hello']]);
  });

  it('parses a tab-separated row', () => {
    expect(parseTsvGrid('a\tb\tc')).toEqual([['a', 'b', 'c']]);
  });

  it('parses multiple rows', () => {
    expect(parseTsvGrid('a\tb\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseTsvGrid('a\tb\r\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('preserves empty cells', () => {
    expect(parseTsvGrid('a\t\tc')).toEqual([['a', '', 'c']]);
  });

  it('ignores a single trailing newline', () => {
    expect(parseTsvGrid('a\tb\n')).toEqual([['a', 'b']]);
  });

  it('parses ragged rows', () => {
    expect(parseTsvGrid('a\tb\nc')).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });
});

describe('stripToValues', () => {
  it('strips a leading = from formula cells', () => {
    expect(stripToValues('=SUM(A1:A2)\ttext')).toBe('SUM(A1:A2)\ttext');
  });

  it('leaves non-formula cells untouched', () => {
    expect(stripToValues('42\t=NOT(A1)\thello')).toBe('42\tNOT(A1)\thello');
  });

  it('only strips the leading =', () => {
    expect(stripToValues('a=b')).toBe('a=b');
  });

  it('trims trailing empty rows', () => {
    expect(stripToValues('a\tb\n\n')).toBe('a\tb');
  });

  it('trims trailing empty columns', () => {
    expect(stripToValues('a\t\t\nb\t\t')).toBe('a\nb');
  });

  it('trims both trailing empty rows and columns', () => {
    expect(stripToValues('=A1+1\t\n\n')).toBe('A1+1');
  });

  it('keeps interior empty cells', () => {
    expect(stripToValues('a\t\tc')).toBe('a\t\tc');
  });

  it('returns empty string for empty input', () => {
    expect(stripToValues('')).toBe('');
  });

  it('preserves a lone = as an empty cell', () => {
    expect(stripToValues('=')).toBe('');
  });

  it('handles multi-row grids with mixed content', () => {
    expect(stripToValues('=1+1\t2\n3\t=4')).toBe('1+1\t2\n3\t4');
  });
});

describe('captureFormat / applyFormatToCell', () => {
  it('captures the format of a formatted cell', () => {
    let store = applyFormatToCell(emptyStore(), 'S1', 0, 0, { bold: true });
    expect(captureFormat(store, 'S1', 0, 0)).toEqual({ bold: true });
    expect(store.cells.size).toBe(1);
  });

  it('returns undefined for an unformatted cell', () => {
    expect(captureFormat(emptyStore(), 'S1', 0, 0)).toBeUndefined();
  });

  it('applyFormatToCell does not mutate the input store', () => {
    const store = emptyStore();
    const next = applyFormatToCell(store, 'S1', 0, 0, { bold: true });
    expect(store.cells.size).toBe(0);
    expect(next.cells.size).toBe(1);
  });
});

describe('FormatPainterState', () => {
  it('copies the source cell format onto a target cell', () => {
    let store = applyFormatToCell(emptyStore(), 'S1', 0, 0, { bold: true, italic: true });
    const painter = new FormatPainterState();
    painter.start({ sheet: 'S1', row: 0, col: 0 });
    store = painter.apply(store, 'S1', 1, 1);
    expect(captureFormat(store, 'S1', 1, 1)).toEqual({ bold: true, italic: true });
  });

  it('returns the store unchanged when there is no source', () => {
    const store = emptyStore();
    const painter = new FormatPainterState();
    expect(painter.apply(store, 'S1', 1, 1)).toBe(store);
  });

  it('returns the store unchanged when the source cell has no format', () => {
    const store = emptyStore();
    const painter = new FormatPainterState();
    painter.start({ sheet: 'S1', row: 9, col: 9 });
    expect(painter.apply(store, 'S1', 1, 1)).toBe(store);
  });

  it('stop() clears the active source', () => {
    let store = applyFormatToCell(emptyStore(), 'S1', 0, 0, { bold: true });
    const painter = new FormatPainterState();
    painter.start({ sheet: 'S1', row: 0, col: 0 });
    painter.stop();
    expect(painter.source).toBeNull();
    expect(painter.apply(store, 'S1', 1, 1)).toBe(store);
  });

  it('applies the format as a copy, not a shared reference', () => {
    let store = applyFormatToCell(emptyStore(), 'S1', 0, 0, { bold: true });
    const painter = new FormatPainterState();
    painter.start({ sheet: 'S1', row: 0, col: 0 });
    store = painter.apply(store, 'S1', 2, 2);
    const target = captureFormat(store, 'S1', 2, 2);
    expect(target).toEqual({ bold: true });
    expect(target).not.toBe(captureFormat(store, 'S1', 0, 0));
  });
});
