import { describe, expect, it } from 'vitest';
import { err, scalar, type TypedCell } from '@icecream-sheets/engine';
import { cellEditText, firstCellText, nextSheetName } from './clipboard';

function cell(value: TypedCell['value'], formula?: string): TypedCell {
  return { ref: { sheet: 'Sheet1', row: 0, col: 0 }, value, formula };
}

describe('cellEditText', () => {
  it('prefers the formula, normalizing a leading =', () => {
    expect(cellEditText(cell(scalar(3), '=SUM(A1:A2)'))).toBe('=SUM(A1:A2)');
    expect(cellEditText(cell(scalar(3), 'SUM(A1:A2)'))).toBe('=SUM(A1:A2)');
  });

  it('falls back to display text for plain values', () => {
    expect(cellEditText(cell(scalar(42)))).toBe('42');
    expect(cellEditText(cell(scalar('hi')))).toBe('hi');
    expect(cellEditText(cell(scalar(true)))).toBe('TRUE');
    expect(cellEditText(cell(scalar(null)))).toBe('');
  });

  it('renders error codes as text', () => {
    expect(cellEditText(cell(err('#DIV/0!')))).toBe('#DIV/0!');
  });
});

describe('firstCellText', () => {
  it('takes the first field of the first line', () => {
    expect(firstCellText('a\tb\nc\td')).toBe('a');
    expect(firstCellText('hello')).toBe('hello');
    expect(firstCellText('=SUM(A1:A2)')).toBe('=SUM(A1:A2)');
  });

  it('handles CRLF and empty input', () => {
    expect(firstCellText('x\r\ny')).toBe('x');
    expect(firstCellText('')).toBe('');
  });
});

describe('nextSheetName', () => {
  it('starts at Sheet1 and skips taken names', () => {
    expect(nextSheetName([])).toBe('Sheet1');
    expect(nextSheetName(['Sheet1'])).toBe('Sheet2');
    expect(nextSheetName(['Sheet1', 'Sheet2', 'Sheet3'])).toBe('Sheet4');
  });

  it('fills gaps and ignores custom names', () => {
    expect(nextSheetName(['Sheet2'])).toBe('Sheet1');
    expect(nextSheetName(['Budget', 'Sheet1'])).toBe('Sheet2');
  });
});
