import { describe, expect, it } from 'vitest';
import {
  initialPaneScrolls,
  paneCount,
  paneOf,
  scrollPane,
  splitPointFromSelection,
} from './windowSplit';

describe('windowSplit', () => {
  it('returns null split at A1', () => {
    expect(splitPointFromSelection({ row: 0, col: 0 })).toBeNull();
  });
  it('splits above/left of the selection', () => {
    expect(splitPointFromSelection({ row: 5, col: 3 })).toEqual({ row: 5, col: 3 });
  });
  it('assigns panes correctly', () => {
    const split = { row: 5, col: 3 };
    expect(paneOf(0, 0, split)).toBe('topLeft');
    expect(paneOf(0, 5, split)).toBe('topRight');
    expect(paneOf(9, 0, split)).toBe('bottomLeft');
    expect(paneOf(9, 9, split)).toBe('bottomRight');
    expect(paneOf(4, 2, null)).toBe('bottomRight');
  });
  it('counts panes', () => {
    expect(paneCount(null)).toBe(1);
    expect(paneCount({ row: 5, col: 0 })).toBe(2);
    expect(paneCount({ row: 0, col: 3 })).toBe(2);
    expect(paneCount({ row: 5, col: 3 })).toBe(4);
  });
  it('propagates vertical scroll within the row band', () => {
    const s = scrollPane(initialPaneScrolls(), 'bottomLeft', { dTop: 100 });
    expect(s.bottomLeft.top).toBe(100);
    expect(s.bottomRight.top).toBe(100);
    expect(s.topLeft.top).toBe(0);
  });
  it('propagates horizontal scroll within the column band', () => {
    const s = scrollPane(initialPaneScrolls(), 'topRight', { dLeft: 50 });
    expect(s.topRight.left).toBe(50);
    expect(s.bottomRight.left).toBe(50);
    expect(s.topLeft.left).toBe(0);
  });
  it('clamps scroll at zero', () => {
    const s = scrollPane(initialPaneScrolls(), 'bottomRight', { dTop: -10, dLeft: -5 });
    expect(s.bottomRight.top).toBe(0);
    expect(s.bottomRight.left).toBe(0);
  });
  it('is immutable', () => {
    const before = initialPaneScrolls();
    scrollPane(before, 'topLeft', { dTop: 10 });
    expect(before.topLeft.top).toBe(0);
  });
});
