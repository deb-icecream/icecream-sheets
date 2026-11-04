import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  computePageBreaks,
  DEFAULT_PAGE_SETUP,
  pageNumberAt,
  pageSizePx,
  zoomToFit,
} from './workbookViews';

describe('workbookViews', () => {
  it('clamps zoom to 25–400', () => {
    expect(clampZoom(10)).toBe(25);
    expect(clampZoom(500)).toBe(400);
    expect(clampZoom(137.6)).toBe(138);
  });
  it('computes column breaks when content exceeds printable width', () => {
    // 20 columns × 100px = 2000px; printable ≈ (8.5−1.4)*96 = 681px at 100%
    const breaks = computePageBreaks(Array(20).fill(100), Array(50).fill(20), DEFAULT_PAGE_SETUP, 100);
    expect(breaks.colBreaks.length).toBeGreaterThan(0);
    expect(breaks.colBreaks[0]).toBe(5); // 6 cols fit in 681px
  });
  it('computes no breaks when everything fits', () => {
    const breaks = computePageBreaks([100, 100], [20, 20], DEFAULT_PAGE_SETUP, 100);
    expect(breaks).toEqual({ colBreaks: [], rowBreaks: [] });
  });
  it('numbers pages in row-major order', () => {
    const breaks = { colBreaks: [5], rowBreaks: [10] };
    expect(pageNumberAt(0, 0, breaks)).toBe(1);
    expect(pageNumberAt(6, 0, breaks)).toBe(2);
    expect(pageNumberAt(0, 11, breaks)).toBe(3);
    expect(pageNumberAt(6, 11, breaks)).toBe(4);
  });
  it('zoomToFit fits the selection and clamps', () => {
    expect(zoomToFit(800, 600, 400, 300, 100)).toBe(200);
    expect(zoomToFit(800, 600, 4000, 3000, 100)).toBe(25); // clamped
    expect(zoomToFit(800, 600, 0, 0, 100)).toBe(100); // degenerate → unchanged
  });
  it('pageSizePx respects orientation', () => {
    const p = pageSizePx(DEFAULT_PAGE_SETUP, 100);
    expect(p.w).toBeCloseTo(8.5 * 96, 0);
    expect(p.h).toBeCloseTo(11 * 96, 0);
    const land = pageSizePx({ ...DEFAULT_PAGE_SETUP, orientation: 'landscape' }, 100);
    expect(land.w).toBeGreaterThan(land.h);
  });
});
