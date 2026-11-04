import { describe, expect, it } from 'vitest';
import { gridContentX, gridContentY } from '../Grid';
import { anchorFromPx } from './chartAnchors';

const emptyMap = new Map<number, number>();
const emptySet = new Set<number>();

describe('anchorFromPx', () => {
  it('maps the header origin to cell (0,0) with zero offsets', () => {
    // Headings shown: origin x=44 (row-header width), y=24 (col-header height).
    const a = anchorFromPx(44, 24, 96, 24, emptyMap, emptySet, emptyMap, emptySet, true);
    expect(a).toEqual({
      fromCol: 0, fromRow: 0, toCol: 1, toRow: 1,
      fromColOff: 0, fromRowOff: 0, toColOff: 0, toRowOff: 0,
    });
  });
  it('keeps sub-cell pixel offsets (no cell snapping)', () => {
    const a = anchorFromPx(170, 58, 100, 30, emptyMap, emptySet, emptyMap, emptySet, true);
    // x=170 -> col 1 (starts 140) offset 30; y=58 -> row 1 (starts 48) offset 10.
    expect(a.fromCol).toBe(1);
    expect(a.fromColOff).toBe(30);
    expect(a.fromRow).toBe(1);
    expect(a.fromRowOff).toBe(10);
    // Far edge: x+w=270 -> col 2 (starts 236) offset 34; y+h=88 -> row 2 (starts 72) offset 16.
    expect(a.toCol).toBe(2);
    expect(a.toColOff).toBe(34);
    expect(a.toRow).toBe(2);
    expect(a.toRowOff).toBe(16);
  });
  it('round-trips through the forward mapping', () => {
    const colWidths = new Map([[0, 50], [2, 120]]);
    const rowHeights = new Map([[1, 30]]);
    const a = anchorFromPx(200, 90, 250, 60, colWidths, emptySet, rowHeights, emptySet, true);
    expect(gridContentX(a.fromCol, colWidths, emptySet, true) + a.fromColOff).toBe(200);
    expect(gridContentY(a.fromRow, rowHeights, emptySet, true) + a.fromRowOff).toBe(90);
    expect(gridContentX(a.toCol, colWidths, emptySet, true) + a.toColOff).toBe(450);
    expect(gridContentY(a.toRow, rowHeights, emptySet, true) + a.toRowOff).toBe(150);
  });
  it('skips hidden columns (zero width) as anchor cells', () => {
    const hidden = new Set([1]);
    const a = anchorFromPx(140, 24, 96, 24, emptyMap, hidden, emptyMap, emptySet, true);
    // col 1 is hidden: x=140 (right after col 0) is col 2's start.
    expect(a.fromCol).toBe(2);
    expect(a.fromColOff).toBe(0);
  });
  it('works without headings (origin 0,0)', () => {
    const a = anchorFromPx(96, 24, 96, 24, emptyMap, emptySet, emptyMap, emptySet, false);
    expect(a.fromCol).toBe(1);
    expect(a.fromRow).toBe(1);
    expect(a.fromColOff).toBe(0);
  });
});
