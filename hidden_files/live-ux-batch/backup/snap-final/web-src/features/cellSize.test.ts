/**
 * Unit tests for column width / row height sizing helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  autoFitColumnWidth,
  autoFitRowHeight,
  clampColWidth,
  clampRowHeight,
  colWidthUnitsToPx,
  DEFAULT_COL_WIDTH,
  DEFAULT_ROW_HEIGHT,
  isValidDefaultWidth,
  lineWidthChars,
  MAX_COL_WIDTH,
  MAX_ROW_HEIGHT,
  rowHeightPointsToPx,
  rowHeightPxToPoints,
  textWidthChars,
} from './cellSize';

describe('lineWidthChars / textWidthChars', () => {
  it('counts latin chars as 1', () => {
    expect(lineWidthChars('hello')).toBe(5);
  });

  it('counts CJK chars as 2', () => {
    expect(lineWidthChars('日本語')).toBe(6);
  });

  it('expands tabs', () => {
    expect(lineWidthChars('a\tb')).toBe(6);
  });

  it('takes the widest line of multi-line text', () => {
    expect(textWidthChars('ab\ncdef')).toBe(4);
  });
});

describe('autoFitColumnWidth', () => {
  it('sizes to the widest text plus padding', () => {
    expect(autoFitColumnWidth(['a', 'abcde'])).toBeCloseTo(6.2, 5);
  });

  it('returns the default for an empty column', () => {
    expect(autoFitColumnWidth([])).toBe(DEFAULT_COL_WIDTH);
    expect(autoFitColumnWidth(['', ''])).toBe(DEFAULT_COL_WIDTH);
  });

  it('counts wide chars double', () => {
    expect(autoFitColumnWidth(['日本'])).toBeCloseTo(5.2, 5);
  });

  it('clamps to the Excel maximum', () => {
    expect(autoFitColumnWidth(['x'.repeat(500)])).toBe(MAX_COL_WIDTH);
  });
});

describe('autoFitRowHeight', () => {
  it('returns one line pitch for short text', () => {
    // 11pt * 1.2 = 13.2 -> ceil 14
    expect(autoFitRowHeight(['hello'], [20])).toBe(14);
  });

  it('wraps long text across the column width', () => {
    // 30 chars in a 10-char column -> 3 lines -> 3 * 13.2 = 39.6 -> 40
    expect(autoFitRowHeight(['x'.repeat(30)], [10])).toBe(40);
  });

  it('counts explicit newlines', () => {
    expect(autoFitRowHeight(['a\nb\nc'])).toBe(40); // 3 * 13.2 -> 40
  });

  it('returns the default for an empty row', () => {
    expect(autoFitRowHeight(['', ''])).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('clamps to the Excel maximum', () => {
    expect(autoFitRowHeight(['x'.repeat(100000)], [1])).toBe(MAX_ROW_HEIGHT);
  });
});

describe('clampColWidth / clampRowHeight', () => {
  it('clamps out-of-range values', () => {
    expect(clampColWidth(999)).toBe(MAX_COL_WIDTH);
    expect(clampColWidth(-5)).toBe(0);
    expect(clampRowHeight(9999)).toBe(MAX_ROW_HEIGHT);
    expect(clampRowHeight(0)).toBe(5);
  });

  it('falls back to defaults for non-finite input', () => {
    expect(clampColWidth(NaN)).toBe(DEFAULT_COL_WIDTH);
    expect(clampRowHeight(NaN)).toBe(DEFAULT_ROW_HEIGHT);
  });
});

describe('isValidDefaultWidth', () => {
  it('accepts the Excel range', () => {
    expect(isValidDefaultWidth(8.43)).toBe(true);
    expect(isValidDefaultWidth(0)).toBe(true);
    expect(isValidDefaultWidth(255)).toBe(true);
    expect(isValidDefaultWidth(256)).toBe(false);
    expect(isValidDefaultWidth(-1)).toBe(false);
    expect(isValidDefaultWidth(NaN)).toBe(false);
  });
});

describe('unit converters', () => {
  it('maps the default column width to ~96px', () => {
    expect(colWidthUnitsToPx(DEFAULT_COL_WIDTH)).toBe(96);
  });

  it('converts points to pixels at 96dpi', () => {
    expect(rowHeightPointsToPx(15)).toBe(20);
    expect(rowHeightPointsToPx(72)).toBe(96);
  });

  it('round-trips pixels to points', () => {
    expect(rowHeightPxToPoints(20)).toBe(15);
  });

  it('falls back for non-finite input', () => {
    expect(colWidthUnitsToPx(NaN)).toBe(96);
    expect(rowHeightPointsToPx(NaN)).toBe(24);
    expect(rowHeightPxToPoints(NaN)).toBe(DEFAULT_ROW_HEIGHT);
  });
});
