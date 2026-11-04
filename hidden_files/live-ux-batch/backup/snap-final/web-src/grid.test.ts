import { describe, expect, it } from 'vitest';
import {
  COL_HEADER_HEIGHT,
  COL_WIDTH,
  OVERSCAN,
  ROW_HEADER_WIDTH,
  ROW_HEIGHT,
  computeVisibleRange,
} from './Grid';

describe('computeVisibleRange', () => {
  it('starts at the origin with overscan clamped to zero', () => {
    const r = computeVisibleRange(0, 0, 800, 600, 100, 26, 44, 24);
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    // Visible rows: (600 - 24) / 24 = 24, plus overscan.
    expect(r.endRow).toBe(24 + OVERSCAN);
    // Visible cols: (800 - 44) / 96 = 7.875 -> 8, plus overscan.
    expect(r.endCol).toBe(8 + OVERSCAN);
  });

  it('tracks a scrolled viewport with overscan on both sides', () => {
    // Scroll exactly to row 500 / col 10.
    const scrollTop = COL_HEADER_HEIGHT + 500 * ROW_HEIGHT;
    const scrollLeft = ROW_HEADER_WIDTH + 10 * COL_WIDTH;
    const r = computeVisibleRange(scrollTop, scrollLeft, 800, 600, 10000, 500, 44, 24);
    expect(r.startRow).toBe(500 - OVERSCAN);
    // 600px shows 25 rows (500..524); endRow overshoots by one (conservative
    // ceil) plus overscan.
    expect(r.endRow).toBe(500 + Math.ceil(600 / ROW_HEIGHT) + OVERSCAN);
    expect(r.startCol).toBe(10 - OVERSCAN);
    // (800 - 44) / 96 = 7.875 -> 9 visible cols (10..18), ceil overshoots one.
    expect(r.endCol).toBe(10 + 9 + OVERSCAN);
  });

  it('clamps the window to the grid dimensions at the far edge', () => {
    // Scroll far past the end; the window must stop at the last row/col.
    const r = computeVisibleRange(1e9, 1e9, 800, 600, 100, 26, 44, 24);
    expect(r.endRow).toBe(99);
    expect(r.endCol).toBe(25);
    expect(r.startRow).toBeLessThanOrEqual(r.endRow);
    expect(r.startCol).toBeLessThanOrEqual(r.endCol);
  });

  it('always covers the full viewport height in rows', () => {
    // Every visible row index must lie inside [startRow, endRow].
    const scrollTop = COL_HEADER_HEIGHT + 37 * ROW_HEIGHT + 5;
    const h = 500;
    const r = computeVisibleRange(scrollTop, 0, 800, h, 10000, 100, 44, 24);
    const firstVisible = Math.floor((scrollTop - COL_HEADER_HEIGHT) / ROW_HEIGHT);
    const lastVisible = Math.ceil((scrollTop - COL_HEADER_HEIGHT + h) / ROW_HEIGHT) - 1;
    expect(r.startRow).toBeLessThanOrEqual(firstVisible);
    expect(r.endRow).toBeGreaterThanOrEqual(lastVisible);
  });
});
