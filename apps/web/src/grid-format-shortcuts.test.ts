// @vitest-environment jsdom
/**
 * Issue #82: Ctrl/Cmd+B / I / U toggle bold / italic / underline on the
 * current selection. Driven through the REAL Grid in jsdom with the
 * same wiring App uses: the grid fires onToggleFormat(key), and the
 * caller computes `{ [key]: !selectedFormat?.[key] }` into its format
 * path — character-for-character the toggle the ribbon B/I/U buttons
 * perform (Ribbon toggleFormat → onFormat → App handleFormat), over the
 * same FormatStore the ribbon's selectedFormat state derives from.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import Grid, { MAX_ROWS, MAX_COLS } from './Grid';
import { cellSelection, isSingleCell, selectionRects, type GridSelection } from './features/selection';
import {
  createFormatStore,
  createDataTypeStore,
  getFormat,
  setFormat,
  setRangeFormat,
  type CellFormat,
  type FormatStore,
} from './features/formatting';
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

interface Observed {
  store: () => FormatStore;
  /** App's selectedFormat derivation (what the ribbon consumes). */
  selectedFormat: () => CellFormat | undefined;
  formatAt: (row: number, col: number) => CellFormat | undefined;
}

function Harness({ observed, wire }: { observed: { current: Observed | null }; wire: boolean }) {
  const [sel, setSel] = useState({ row: 0, col: 0 });
  const [gridSel, setGridSel] = useState<GridSelection>(() => cellSelection(0, 0));
  const [formats, setFormats] = useState<FormatStore>(() => createFormatStore());
  const [host] = useState(() => mockHost());
  // App's selectedFormat: the format of the anchor cell, from the store.
  const selectedFormat = getFormat(formats, 'Sheet1', sel.row, sel.col);
  // App's handleFormat shape: single cell → setFormat; otherwise one
  // setRangeFormat per selection rect.
  const handleFormat = (update: Partial<CellFormat>) => {
    if (isSingleCell(gridSel)) {
      setFormats((prev) => setFormat(prev, 'Sheet1', sel.row, sel.col, update));
    } else {
      setFormats((prev) => {
        let next = prev;
        for (const rect of selectionRects(gridSel, MAX_ROWS - 1, MAX_COLS - 1)) {
          next = setRangeFormat(next, 'Sheet1', rect.startRow, rect.startCol, rect.endRow, rect.endCol, update);
        }
        return next;
      });
    }
  };
  // The ribbon toggle computation itself (Ribbon toggleFormat), which is
  // exactly what App's handleToggleFormat performs for the keys.
  const onToggleFormat = (key: 'bold' | 'italic' | 'underline') => {
    handleFormat({ [key]: !selectedFormat?.[key] } as Partial<CellFormat>);
  };
  observed.current = {
    store: () => formats,
    selectedFormat: () => selectedFormat,
    formatAt: (row: number, col: number) => getFormat(formats, 'Sheet1', row, col),
  };
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
      setGridSel(next);
      setSel({ row: next.anchorRow, col: next.anchorCol });
    },
    onClearSelection: () => {},
    ...(wire ? { onToggleFormat } : {}),
    onCommit: () => {},
    version: 1,
    cfRules: [],
    validations: [],
    merges: [],
    freeze: null,
    filters: new Map(),
    sortState: null,
    formats,
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

function mount(wire = true): { el: HTMLElement; grid: HTMLElement; observed: { current: Observed | null } } {
  const observed: { current: Observed | null } = { current: null };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(h(Harness, { observed, wire }));
  });
  const grid = container.querySelector('[role="grid"]') as HTMLElement;
  Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 600 });
  act(() => {
    roCallback?.();
  });
  return { el: container, grid, observed };
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

function key(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const ev = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

function mouse(el: HTMLElement, type: string, init: MouseEventInit = {}) {
  act(() => {
    el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, ...init }));
  });
}

describe('grid format shortcuts (issue #82)', () => {
  it('Ctrl+B toggles bold on and off; ribbon state and cell style reflect it', () => {
    const { el, grid, observed } = mount();
    const cell = el.querySelector('#cell-0-0') as HTMLElement;
    expect(observed.current!.selectedFormat()?.bold).toBeFalsy();
    expect(cell.style.fontWeight).not.toBe('700');

    const ev = key(grid, { key: 'b', ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(observed.current!.selectedFormat()?.bold).toBe(true);
    expect((el.querySelector('#cell-0-0') as HTMLElement).style.fontWeight).toBe('700');

    key(grid, { key: 'b', ctrlKey: true });
    expect(observed.current!.selectedFormat()?.bold).toBe(false);
    expect((el.querySelector('#cell-0-0') as HTMLElement).style.fontWeight).not.toBe('700');
  });

  it('Ctrl+I toggles italic on and off', () => {
    const { el, grid, observed } = mount();
    key(grid, { key: 'i', ctrlKey: true });
    expect(observed.current!.selectedFormat()?.italic).toBe(true);
    expect((el.querySelector('#cell-0-0') as HTMLElement).style.fontStyle).toBe('italic');
    key(grid, { key: 'i', ctrlKey: true });
    expect(observed.current!.selectedFormat()?.italic).toBe(false);
    expect((el.querySelector('#cell-0-0') as HTMLElement).style.fontStyle).not.toBe('italic');
  });

  it('Ctrl+U toggles underline on and off', () => {
    const { grid, observed } = mount();
    key(grid, { key: 'u', ctrlKey: true });
    expect(observed.current!.selectedFormat()?.underline).toBe(true);
    key(grid, { key: 'u', ctrlKey: true });
    expect(observed.current!.selectedFormat()?.underline).toBe(false);
  });

  it('Cmd+B toggles bold too (macOS convention)', () => {
    const { grid, observed } = mount();
    key(grid, { key: 'b', metaKey: true });
    expect(observed.current!.selectedFormat()?.bold).toBe(true);
    key(grid, { key: 'b', metaKey: true });
    expect(observed.current!.selectedFormat()?.bold).toBe(false);
  });

  it('Ctrl+B applies to a multi-cell range selection', () => {
    const { el, grid, observed } = mount();
    mouse(el.querySelector('#cell-1-1') as HTMLElement, 'click');
    mouse(el.querySelector('#cell-3-3') as HTMLElement, 'click', { shiftKey: true });
    key(grid, { key: 'b', ctrlKey: true });
    expect(observed.current!.formatAt(1, 1)?.bold).toBe(true);
    expect(observed.current!.formatAt(2, 2)?.bold).toBe(true);
    expect(observed.current!.formatAt(3, 3)?.bold).toBe(true);
    expect(observed.current!.formatAt(4, 4)?.bold).toBeFalsy();
    // The ribbon state follows the anchor cell of the range.
    expect(observed.current!.selectedFormat()?.bold).toBe(true);
    key(grid, { key: 'b', ctrlKey: true });
    expect(observed.current!.formatAt(2, 2)?.bold).toBe(false);
  });

  it('while the cell editor is open, Ctrl+B stays with the editor (no toggle)', () => {
    const { el, grid, observed } = mount();
    key(grid, { key: 'F2' });
    const input = el.querySelector('input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    key(input as HTMLInputElement, { key: 'b', ctrlKey: true });
    expect(observed.current!.selectedFormat()?.bold).toBeFalsy();
    expect(observed.current!.formatAt(0, 0)?.bold).toBeFalsy();
  });

  it('without the caller wiring onToggleFormat, Ctrl+B is inert', () => {
    const { grid, observed } = mount(false);
    const ev = key(grid, { key: 'b', ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(observed.current!.selectedFormat()?.bold).toBeFalsy();
  });
});
