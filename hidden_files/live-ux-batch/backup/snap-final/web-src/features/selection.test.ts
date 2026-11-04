import { describe, expect, it } from 'vitest';
import {
  allSelection,
  cellSelection,
  headerDragSpans,
  headerSelect,
  inSelection,
  insertTarget,
  isSingleCell,
  mergeSpans,
  rangeSelection,
  selectionBounds,
  selectionRects,
} from './selection';

const MAX_R = 99;
const MAX_C = 25;
const noMods = { shift: false, ctrl: false };

describe('selection shapes → rects / bounds / membership', () => {
  it('cell: one 1x1 rect, only the anchor is in', () => {
    const sel = cellSelection(3, 4);
    expect(sel.shape).toBe('cell');
    expect(isSingleCell(sel)).toBe(true);
    expect(selectionRects(sel, MAX_R, MAX_C)).toEqual([
      { startRow: 3, startCol: 4, endRow: 3, endCol: 4 },
    ]);
    expect(selectionBounds(sel, MAX_R, MAX_C)).toEqual({
      startRow: 3, startCol: 4, endRow: 3, endCol: 4,
    });
    expect(inSelection(sel, 3, 4, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, 3, 5, MAX_R, MAX_C)).toBe(false);
    expect(inSelection(sel, 4, 4, MAX_R, MAX_C)).toBe(false);
  });

  it('range: normalized rect regardless of drag direction', () => {
    const sel = rangeSelection(5, 6, 2, 3);
    expect(sel.shape).toBe('range');
    expect(isSingleCell(sel)).toBe(false);
    expect(selectionRects(sel, MAX_R, MAX_C)).toEqual([
      { startRow: 2, startCol: 3, endRow: 5, endCol: 6 },
    ]);
    expect(selectionBounds(sel, MAX_R, MAX_C)).toEqual({
      startRow: 2, startCol: 3, endRow: 5, endCol: 6,
    });
    expect(inSelection(sel, 2, 3, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, 5, 6, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, 4, 4, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, 1, 4, MAX_R, MAX_C)).toBe(false);
    expect(inSelection(sel, 4, 7, MAX_R, MAX_C)).toBe(false);
  });

  it('rangeSelection collapses to cell when anchor == focus', () => {
    const sel = rangeSelection(2, 2, 2, 2);
    expect(sel.shape).toBe('cell');
    expect(isSingleCell(sel)).toBe(true);
  });

  it('rows: one full-width rect per span; gap rows are NOT in selection', () => {
    let sel = headerSelect(cellSelection(0, 0), 'rows', 1, noMods, MAX_R, MAX_C);
    sel = headerSelect(sel, 'rows', 4, { shift: false, ctrl: true }, MAX_R, MAX_C);
    expect(sel.shape).toBe('rows');
    expect(sel.rowSpans).toEqual([
      { start: 1, end: 1 },
      { start: 4, end: 4 },
    ]);
    expect(selectionRects(sel, MAX_R, MAX_C)).toEqual([
      { startRow: 1, startCol: 0, endRow: 1, endCol: MAX_C },
      { startRow: 4, startCol: 0, endRow: 4, endCol: MAX_C },
    ]);
    expect(selectionBounds(sel, MAX_R, MAX_C)).toEqual({
      startRow: 1, startCol: 0, endRow: 4, endCol: MAX_C,
    });
    expect(inSelection(sel, 1, 0, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, 1, MAX_C, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, 4, 7, MAX_R, MAX_C)).toBe(true);
    // The gap between the two spans is not selected (multi-span membership).
    expect(inSelection(sel, 2, 3, MAX_R, MAX_C)).toBe(false);
    expect(inSelection(sel, 3, 3, MAX_R, MAX_C)).toBe(false);
  });

  it('cols: one full-height rect per span; gap cols are NOT in selection', () => {
    let sel = headerSelect(cellSelection(0, 0), 'cols', 2, noMods, MAX_R, MAX_C);
    sel = headerSelect(sel, 'cols', 5, { shift: false, ctrl: true }, MAX_R, MAX_C);
    expect(sel.shape).toBe('cols');
    expect(selectionRects(sel, MAX_R, MAX_C)).toEqual([
      { startRow: 0, startCol: 2, endRow: MAX_R, endCol: 2 },
      { startRow: 0, startCol: 5, endRow: MAX_R, endCol: 5 },
    ]);
    expect(selectionBounds(sel, MAX_R, MAX_C)).toEqual({
      startRow: 0, startCol: 2, endRow: MAX_R, endCol: 5,
    });
    expect(inSelection(sel, 50, 2, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, 50, 5, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, 50, 3, MAX_R, MAX_C)).toBe(false);
    expect(inSelection(sel, 50, 4, MAX_R, MAX_C)).toBe(false);
  });

  it('all: one rect covering the grid; every cell in', () => {
    const sel = allSelection(7, 8);
    expect(sel.shape).toBe('all');
    expect(selectionRects(sel, MAX_R, MAX_C)).toEqual([
      { startRow: 0, startCol: 0, endRow: MAX_R, endCol: MAX_C },
    ]);
    expect(selectionBounds(sel, MAX_R, MAX_C)).toEqual({
      startRow: 0, startCol: 0, endRow: MAX_R, endCol: MAX_C,
    });
    expect(inSelection(sel, 0, 0, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, MAX_R, MAX_C, MAX_R, MAX_C)).toBe(true);
    expect(inSelection(sel, MAX_R + 1, 0, MAX_R, MAX_C)).toBe(false);
  });
});

describe('mergeSpans', () => {
  it('sorts and merges overlapping and adjacent spans', () => {
    expect(mergeSpans([
      { start: 5, end: 7 },
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 6, end: 9 },
      { start: 20, end: 20 },
    ])).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 9 },
      { start: 20, end: 20 },
    ]);
  });
  it('empty stays empty; reversed spans normalize', () => {
    expect(mergeSpans([])).toEqual([]);
    expect(mergeSpans([{ start: 4, end: 2 }])).toEqual([{ start: 2, end: 4 }]);
  });
});

describe('headerSelect', () => {
  it('plain row click: single span, anchor (index, 0)', () => {
    const sel = headerSelect(cellSelection(9, 9), 'rows', 3, noMods, MAX_R, MAX_C);
    expect(sel.shape).toBe('rows');
    expect(sel.rowSpans).toEqual([{ start: 3, end: 3 }]);
    expect(sel.anchorRow).toBe(3);
    expect(sel.anchorCol).toBe(0);
  });

  it('plain col click: single span, anchor (0, index)', () => {
    const sel = headerSelect(cellSelection(9, 9), 'cols', 6, noMods, MAX_R, MAX_C);
    expect(sel.shape).toBe('cols');
    expect(sel.colSpans).toEqual([{ start: 6, end: 6 }]);
    expect(sel.anchorRow).toBe(0);
    expect(sel.anchorCol).toBe(6);
  });

  it('shift extends the last span from its start (both directions)', () => {
    let sel = headerSelect(cellSelection(0, 0), 'rows', 2, noMods, MAX_R, MAX_C);
    sel = headerSelect(sel, 'rows', 5, { shift: true, ctrl: false }, MAX_R, MAX_C);
    expect(sel.rowSpans).toEqual([{ start: 2, end: 5 }]);
    sel = headerSelect(sel, 'rows', 1, { shift: true, ctrl: false }, MAX_R, MAX_C);
    expect(sel.rowSpans).toEqual([{ start: 1, end: 2 }]);
  });

  it('shift from a non-header selection starts at the anchor index', () => {
    const sel = headerSelect(cellSelection(4, 4), 'cols', 8, { shift: true, ctrl: false }, MAX_R, MAX_C);
    expect(sel.shape).toBe('cols');
    expect(sel.colSpans).toEqual([{ start: 4, end: 8 }]);
  });

  it('ctrl toggles: adds a disjoint span, merges adjacency', () => {
    let sel = headerSelect(cellSelection(0, 0), 'rows', 1, noMods, MAX_R, MAX_C);
    sel = headerSelect(sel, 'rows', 3, { shift: false, ctrl: true }, MAX_R, MAX_C);
    expect(sel.rowSpans).toEqual([{ start: 1, end: 1 }, { start: 3, end: 3 }]);
    sel = headerSelect(sel, 'rows', 2, { shift: false, ctrl: true }, MAX_R, MAX_C);
    expect(sel.rowSpans).toEqual([{ start: 1, end: 3 }]);
  });

  it('ctrl toggle-off splits a span when removing its middle', () => {
    let sel = headerSelect(cellSelection(0, 0), 'rows', 2, noMods, MAX_R, MAX_C);
    sel = headerSelect(sel, 'rows', 6, { shift: true, ctrl: false }, MAX_R, MAX_C);
    expect(sel.rowSpans).toEqual([{ start: 2, end: 6 }]);
    sel = headerSelect(sel, 'rows', 4, { shift: false, ctrl: true }, MAX_R, MAX_C);
    expect(sel.rowSpans).toEqual([{ start: 2, end: 3 }, { start: 5, end: 6 }]);
    // Removing an edge shrinks the span.
    sel = headerSelect(sel, 'rows', 2, { shift: false, ctrl: true }, MAX_R, MAX_C);
    expect(sel.rowSpans).toEqual([{ start: 3, end: 3 }, { start: 5, end: 6 }]);
  });

  it('ctrl toggling off the last span collapses to a cell', () => {
    let sel = headerSelect(cellSelection(0, 0), 'cols', 2, noMods, MAX_R, MAX_C);
    sel = headerSelect(sel, 'cols', 2, { shift: false, ctrl: true }, MAX_R, MAX_C);
    expect(sel.shape).toBe('cell');
  });

  it('switching kind replaces the selection', () => {
    let sel = headerSelect(cellSelection(0, 0), 'rows', 2, noMods, MAX_R, MAX_C);
    sel = headerSelect(sel, 'cols', 7, noMods, MAX_R, MAX_C);
    expect(sel.shape).toBe('cols');
    expect(sel.rowSpans).toEqual([]);
    expect(sel.colSpans).toEqual([{ start: 7, end: 7 }]);
  });
});

describe('headerDragSpans', () => {
  it('sweeps a span between start and current index (either direction)', () => {
    expect(headerDragSpans([], 2, 5)).toEqual([{ start: 2, end: 5 }]);
    expect(headerDragSpans([], 5, 2)).toEqual([{ start: 2, end: 5 }]);
  });
  it('merges with base spans (ctrl-drag additive)', () => {
    expect(headerDragSpans([{ start: 10, end: 11 }], 2, 4)).toEqual([
      { start: 2, end: 4 },
      { start: 10, end: 11 },
    ]);
    expect(headerDragSpans([{ start: 5, end: 6 }], 2, 4)).toEqual([
      { start: 2, end: 6 },
    ]);
  });
});

describe('shape transitions', () => {
  it('cell → range → rows → cols → all', () => {
    const cell = cellSelection(1, 1);
    const range = rangeSelection(cell.anchorRow, cell.anchorCol, 3, 4);
    expect(range.shape).toBe('range');
    const rows = headerSelect(range, 'rows', 2, noMods, MAX_R, MAX_C);
    expect(rows.shape).toBe('rows');
    const cols = headerSelect(rows, 'cols', 3, noMods, MAX_R, MAX_C);
    expect(cols.shape).toBe('cols');
    const all = allSelection(cols.anchorRow, cols.anchorCol);
    expect(all.shape).toBe('all');
    const back = cellSelection(0, 0);
    expect(back.shape).toBe('cell');
  });
});

describe('insertTarget (context-menu structural inserts)', () => {
  it('rows selection + click inside: count = total spans, at min / max+1', () => {
    let sel = headerSelect(cellSelection(0, 0), 'rows', 2, noMods, MAX_R, MAX_C);
    sel = headerSelect(sel, 'rows', 4, { shift: true, ctrl: false }, MAX_R, MAX_C); // rows 2..4
    sel = headerSelect(sel, 'rows', 7, { shift: false, ctrl: true }, MAX_R, MAX_C); // + row 7
    expect(insertTarget(sel, 'rows', 3, 'before')).toEqual({ at: 2, count: 4 });
    expect(insertTarget(sel, 'rows', 7, 'after')).toEqual({ at: 8, count: 4 });
  });

  it('click outside the selection (or wrong kind): count 1 at the click', () => {
    const sel = headerSelect(cellSelection(0, 0), 'rows', 2, noMods, MAX_R, MAX_C);
    expect(insertTarget(sel, 'rows', 9, 'before')).toEqual({ at: 9, count: 1 });
    expect(insertTarget(sel, 'rows', 9, 'after')).toEqual({ at: 10, count: 1 });
    expect(insertTarget(sel, 'cols', 9, 'before')).toEqual({ at: 9, count: 1 });
    expect(insertTarget(cellSelection(5, 5), 'rows', 5, 'after')).toEqual({ at: 6, count: 1 });
  });

  it('cols selection mirrors rows', () => {
    let sel = headerSelect(cellSelection(0, 0), 'cols', 1, noMods, MAX_R, MAX_C);
    sel = headerSelect(sel, 'cols', 3, { shift: true, ctrl: false }, MAX_R, MAX_C); // cols 1..3
    expect(insertTarget(sel, 'cols', 2, 'before')).toEqual({ at: 1, count: 3 });
    expect(insertTarget(sel, 'cols', 2, 'after')).toEqual({ at: 4, count: 3 });
  });
});
