// @vitest-environment jsdom
/**
 * Grid selection model interactions (user directive 2026-10-21): row /
 * column header clicks, Ctrl+A select-all, shift+click ranges, mouse
 * drag ranges, and Delete routing for multi-cell selections — driven
 * through the REAL Grid in jsdom with the same wiring App uses
 * (selection + onSelectionChange + onClearSelection).
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import Grid from './Grid';
import { cellSelection, type GridSelection } from './features/selection';
import { createFormatStore, createDataTypeStore, getFormat, setFormat, setRangeFormat } from './features/formatting';
import { DEFAULT_LOCALE } from './features/locale';
import type { EngineHost, TypedValue } from '@icecream-sheets/engine';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let roCallback: (() => void) | null = null;
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function () {};
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  constructor(cb: () => void) {
    roCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
};

function mockHost(): EngineHost {
  const num = (value: number): TypedValue => ({ kind: 'number', value });
  const view = {
    usedRange: () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 5 }),
    readCell: () => ({ value: num(1), formula: undefined }),
  };
  const readRange = ({ startRow, startCol, endRow, endCol }: {
    startRow: number; startCol: number; endRow: number; endCol: number;
  }): TypedValue[][] => {
    const rows: TypedValue[][] = [];
    for (let r = startRow; r <= endRow; r++) {
      const row: TypedValue[] = [];
      for (let c = startCol; c <= endCol; c++) row.push(num(r * 10 + c));
      rows.push(row);
    }
    return rows;
  };
  return {
    getView: () => view,
    readRange,
    readCell: (ref: unknown) => {
      const r = ref as { row: number; col: number };
      return num(r.row * 10 + r.col);
    },
  } as unknown as EngineHost;
}

interface Spies {
  commits: { row: number; col: number; text: string }[];
  clears: number;
  lastSel: () => GridSelection;
}

function Harness({ spies }: { spies: Omit<Spies, 'lastSel'> & { setLast: (s: GridSelection) => void } }) {
  const [sel, setSel] = useState({ row: 0, col: 0 });
  const [gridSel, setGridSel] = useState<GridSelection>(() => cellSelection(0, 0));
  const [host] = useState(() => mockHost());
  return h(Grid, {
    host,
    sheet: 'Sheet1',
    sel,
    onSelect: (row: number, col: number) => {
      setSel({ row, col });
      setGridSel(cellSelection(row, col));
    },
    selection: gridSel,
    onSelectionChange: (next: GridSelection) => {
      spies.setLast(next);
      setGridSel(next);
      setSel({ row: next.anchorRow, col: next.anchorCol });
    },
    onClearSelection: () => {
      spies.clears++;
    },
    onCommit: (row: number, col: number, text: string) => {
      spies.commits.push({ row, col, text });
    },
    version: 1,
    cfRules: [],
    validations: [],
    merges: [],
    freeze: null,
    filters: new Map(),
    sortState: null,
    formats: createFormatStore(),
    dataTypes: createDataTypeStore(),
    locale: DEFAULT_LOCALE,
    showHeadings: true,
    rowHeights: new Map(),
    colWidths: new Map(),
    hiddenRows: new Set<number>(),
    hiddenCols: new Set<number>(),
    showFormulas: false,
    formulaTexts: new Map(),
    comments: new Map(),
    dataTypeCells: new Map(),
    dataTypeCardKey: null,
    onToggleDataTypeCard: () => {},
    slicerSpecs: [],
    timelineSpecs: [],
    sparklineCells: new Map(),
    smartChipCells: new Map(),
    smartChipCardKey: null,
    onToggleSmartChipCard: () => {},
    focusCell: true,
    extCfStyle: () => null,
    onContextMenu: () => {},
    onOpenFilter: () => {},
    getCellMenu: () => [],
    getColumnMenu: () => [],
    getRowMenu: () => [],
  });
}

function mount(): { el: HTMLElement; spies: Spies } {
  let last: GridSelection = cellSelection(0, 0);
  const raw = {
    commits: [] as Spies['commits'],
    clears: 0,
    setLast: (s: GridSelection) => {
      last = s;
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(h(Harness, { spies: raw }));
  });
  const grid = container.querySelector('[role="grid"]') as HTMLElement;
  Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 600 });
  act(() => {
    roCallback?.();
  });
  return {
    el: container,
    spies: { commits: raw.commits, get clears() { return raw.clears; }, lastSel: () => last },
  };
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mouse(el: HTMLElement, type: string, init: MouseEventInit = {}) {
  act(() => {
    el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, ...init }));
  });
}

describe('grid selection model interactions', () => {
  it('clicking a row header selects the whole row', () => {
    const { el, spies } = mount();
    const header = el.querySelector('[aria-label="Row 2"]') as HTMLElement;
    expect(header).not.toBeNull();
    mouse(header, 'mousedown');
    const sel = spies.lastSel();
    expect(sel.shape).toBe('rows');
    expect(sel.rowSpans).toEqual([{ start: 1, end: 1 }]);
    expect(header.className).toContain('active');
    // A body cell in row 1 is in-selection; a cell in row 2 is not.
    const inRow = el.querySelector('#cell-1-3') as HTMLElement;
    expect(inRow.getAttribute('aria-selected')).toBe('true');
    expect(inRow.className).toContain('in-selection');
    const otherRow = el.querySelector('#cell-2-3') as HTMLElement;
    expect(otherRow.getAttribute('aria-selected')).toBe('false');
  });

  it('clicking a column header selects the whole column', () => {
    const { el, spies } = mount();
    const header = [...el.querySelectorAll('[role="columnheader"]')]
      .find((n) => n.getAttribute('aria-label')?.startsWith('Column B')) as HTMLElement;
    expect(header).not.toBeNull();
    mouse(header, 'mousedown');
    const sel = spies.lastSel();
    expect(sel.shape).toBe('cols');
    expect(sel.colSpans).toEqual([{ start: 1, end: 1 }]);
    expect(header.className).toContain('active');
    const inCol = el.querySelector('#cell-3-1') as HTMLElement;
    expect(inCol.getAttribute('aria-selected')).toBe('true');
    const otherCol = el.querySelector('#cell-3-2') as HTMLElement;
    expect(otherCol.getAttribute('aria-selected')).toBe('false');
  });

  it('Ctrl+A on the grid selects all', () => {
    const { el, spies } = mount();
    const grid = el.querySelector('[role="grid"]') as HTMLElement;
    act(() => {
      grid.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    });
    expect(spies.lastSel().shape).toBe('all');
    for (const cell of el.querySelectorAll('[role="gridcell"]')) {
      expect(cell.getAttribute('aria-selected')).toBe('true');
    }
  });

  it('shift+click extends a rectangular range from the anchor', () => {
    const { el, spies } = mount();
    const anchor = el.querySelector('#cell-1-1') as HTMLElement;
    mouse(anchor, 'click');
    const target = el.querySelector('#cell-3-3') as HTMLElement;
    mouse(target, 'click', { shiftKey: true });
    const sel = spies.lastSel();
    expect(sel.shape).toBe('range');
    expect(sel.anchorRow).toBe(1);
    expect(sel.anchorCol).toBe(1);
    expect(sel.focusRow).toBe(3);
    expect(sel.focusCol).toBe(3);
    const inside = el.querySelector('#cell-2-2') as HTMLElement;
    expect(inside.getAttribute('aria-selected')).toBe('true');
    expect(inside.className).toContain('in-selection');
    const outside = el.querySelector('#cell-4-2') as HTMLElement;
    expect(outside.getAttribute('aria-selected')).toBe('false');
  });

  it('mousedown + mouseenter drag extends a range, and the trailing click does not start an edit', () => {
    const { el, spies } = mount();
    const start = el.querySelector('#cell-0-0') as HTMLElement;
    mouse(start, 'mousedown');
    const mid = el.querySelector('#cell-2-2') as HTMLElement;
    // React synthesizes onMouseEnter from mouseover in jsdom.
    mouse(mid, 'mouseover');
    const sel = spies.lastSel();
    expect(sel.shape).toBe('range');
    expect(sel.focusRow).toBe(2);
    expect(sel.focusCol).toBe(2);
    // The click that ends the drag is swallowed once (no editor opens).
    mouse(mid, 'mouseup');
    mouse(mid, 'click');
    expect(el.querySelector('.cell-editor')).toBeNull();
  });

  it('Delete with a range selection calls onClearSelection, not onCommit', () => {
    const { el, spies } = mount();
    const anchor = el.querySelector('#cell-1-1') as HTMLElement;
    mouse(anchor, 'click');
    const target = el.querySelector('#cell-2-2') as HTMLElement;
    mouse(target, 'click', { shiftKey: true });
    expect(spies.lastSel().shape).toBe('range');
    const grid = el.querySelector('[role="grid"]') as HTMLElement;
    act(() => {
      grid.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(spies.clears).toBe(1);
    expect(spies.commits).toEqual([]);
  });

  it('Delete with a single cell keeps the legacy onCommit path', () => {
    const { el, spies } = mount();
    const grid = el.querySelector('[role="grid"]') as HTMLElement;
    act(() => {
      grid.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(spies.clears).toBe(0);
    expect(spies.commits).toEqual([{ row: 0, col: 0, text: '' }]);
  });

  it('formatting cascade: single-cell path (setFormat) is visible, and range-applied formats resolve via getFormat', () => {
    // App's handleFormat: single-cell → setFormat (legacy); multi-cell →
    // setRangeFormat per rect. Both must be VISIBLE through getFormat,
    // and a cell-level entry must beat a range entry (cascade order).
    let store = createFormatStore();
    store = setRangeFormat(store, 'Sheet1', 0, 0, 5, 5, { bold: true });
    expect(getFormat(store, 'Sheet1', 2, 2)?.bold).toBe(true);
    store = setFormat(store, 'Sheet1', 2, 2, { bold: false });
    expect(getFormat(store, 'Sheet1', 2, 2)?.bold).toBe(false); // cell wins over range
    expect(getFormat(store, 'Sheet1', 3, 3)?.bold).toBe(true); // neighbours keep range format
  });

  it('shift+arrow extends the focus corner', () => {
    const { el, spies } = mount();
    const grid = el.querySelector('[role="grid"]') as HTMLElement;
    act(() => {
      grid.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    });
    act(() => {
      grid.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    });
    const sel = spies.lastSel();
    expect(sel.shape).toBe('range');
    expect(sel.focusRow).toBe(1);
    expect(sel.focusCol).toBe(1);
    // A plain arrow afterwards collapses back to a single cell move.
    act(() => {
      grid.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(spies.lastSel().shape).toBe('cell');
  });
});
