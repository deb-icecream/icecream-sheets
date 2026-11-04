// @vitest-environment jsdom
/**
 * Grid screen-reader semantics (design-docs/accessibility.md §5.1).
 *
 * The grid virtualizes 1M+ rows, so a screen reader depends entirely on the
 * ARIA indices: every rendered gridcell's aria-rowindex/aria-colindex must
 * equal its TRUE sheet indices (not its position in the rendered window),
 * and headers must carry columnheader/rowheader roles.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import Grid, {
  computeVisibleRange,
  ROW_HEIGHT,
  COL_WIDTH,
  COL_HEADER_HEIGHT,
  ROW_HEADER_WIDTH,
} from './Grid';
import { createFormatStore, createDataTypeStore } from './features/formatting';
import { DEFAULT_LOCALE } from './features/locale';
import type { EngineHost, TypedValue } from '@icecream-sheets/engine';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

// jsdom lacks Element.scrollTo and ResizeObserver; the grid uses both.
// The ResizeObserver stub captures its callback so tests can drive resizes.
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

function mount(ui: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
});

/** Minimal EngineHost: values everywhere, everything else empty. */
function mockHost(): EngineHost {
  const num = (value: number): TypedValue => ({ kind: 'number', value });
  const view = {
    usedRange: () => ({ startRow: 0, startCol: 0, endRow: 2, endCol: 2 }),
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

const gridProps = {
  host: mockHost(),
  sheet: 'Sheet1',
  sel: { row: 1, col: 1 },
  onSelect: () => {},
  onCommit: () => {},
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
};

/** Give the grid a real viewport in jsdom (clientWidth/Height are 0). */
function setViewport(el: HTMLElement, w: number, h: number) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: w });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: h });
  act(() => {
    roCallback?.();
  });
}

/** Scroll the grid so the given 0-based row is at the top of the window. */
function scrollToRow(el: HTMLElement, row: number) {
  const grid = el.querySelector('[role="grid"]') as HTMLElement;
  setViewport(grid, 800, 600);
  act(() => {
    grid.scrollTop = COL_HEADER_HEIGHT + row * ROW_HEIGHT;
    grid.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

describe('grid ARIA structure', () => {
  it('exposes role=grid with row/column counts and a label', () => {
    const el = mount(h(Grid, gridProps));
    const grid = el.querySelector('[role="grid"]');
    expect(grid).not.toBeNull();
    expect(grid!.getAttribute('aria-label')).toContain('Sheet1');
    expect(Number(grid!.getAttribute('aria-rowcount'))).toBeGreaterThan(0);
    expect(Number(grid!.getAttribute('aria-colcount'))).toBeGreaterThan(0);
  });

  it('column headers carry columnheader roles with true 1-based indices', () => {
    const el = mount(h(Grid, gridProps));
    const headers = [...el.querySelectorAll('[role="columnheader"]')];
    expect(headers.length).toBeGreaterThan(0);
    for (const hd of headers) {
      const idx = Number(hd.getAttribute('aria-colindex'));
      expect(idx).toBeGreaterThanOrEqual(1);
      expect(hd.getAttribute('aria-label')).toMatch(/^Column [A-Z]+/);
    }
    // First header is column A at index 1.
    expect(headers[0].getAttribute('aria-colindex')).toBe('1');
    expect(headers[0].getAttribute('aria-label')).toMatch(/^Column A/);
  });

  it('row headers carry rowheader roles with true labels', () => {
    const el = mount(h(Grid, gridProps));
    const headers = [...el.querySelectorAll('[role="rowheader"]')];
    expect(headers.length).toBeGreaterThan(0);
    for (const hd of headers) {
      expect(hd.getAttribute('aria-label')).toMatch(/^Row \d+$/);
    }
    expect(headers[0].getAttribute('aria-label')).toBe('Row 1');
  });

  it('gridcells carry true 1-based aria-rowindex/aria-colindex near the top', () => {
    const el = mount(h(Grid, gridProps));
    const cells = [...el.querySelectorAll('[role="gridcell"]')];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      // id is `cell-{0-based row}-{0-based col}`; indices must be +1.
      const m = /^cell-(\d+)-(\d+)$/.exec(cell.id);
      expect(m).not.toBeNull();
      expect(cell.getAttribute('aria-rowindex')).toBe(String(Number(m![1]) + 1));
      expect(cell.getAttribute('aria-colindex')).toBe(String(Number(m![2]) + 1));
    }
  });

  it('the selected cell is marked aria-selected and is the activedescendant', () => {
    const el = mount(h(Grid, { ...gridProps, sel: { row: 1, col: 1 } }));
    const grid = el.querySelector('[role="grid"]')!;
    expect(grid.getAttribute('aria-activedescendant')).toBe('cell-1-1');
    const selected = el.querySelectorAll('[role="gridcell"][aria-selected="true"]');
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe('cell-1-1');
  });
});

describe('grid ARIA deep in the virtualized grid (§5.1: row 500000)', () => {
  it('computeVisibleRange windows the true row 500000', () => {
    const scrollTop = COL_HEADER_HEIGHT + 500000 * ROW_HEIGHT;
    const range = computeVisibleRange(scrollTop, 0, 800, 600, 1048576, 16384, ROW_HEADER_WIDTH, COL_HEADER_HEIGHT);
    expect(range.startRow).toBeLessThanOrEqual(500000);
    expect(range.endRow).toBeGreaterThanOrEqual(500000);
  });

  it('rendered gridcells deep in the grid report true indices', () => {
    // Selecting a deep cell grows the grid and the scroll below brings it
    // into the rendered window.
    const el = mount(h(Grid, { ...gridProps, sel: { row: 500000, col: 5 } }));
    scrollToRow(el, 500000);
    const cells = [...el.querySelectorAll('[role="gridcell"]')];
    expect(cells.length).toBeGreaterThan(0);
    // Every rendered cell's indices match its true position…
    for (const cell of cells) {
      const m = /^cell-(\d+)-(\d+)$/.exec(cell.id);
      expect(m).not.toBeNull();
      expect(cell.getAttribute('aria-rowindex')).toBe(String(Number(m![1]) + 1));
      expect(cell.getAttribute('aria-colindex')).toBe(String(Number(m![2]) + 1));
    }
    // …and the deep cell itself is present with its true A1 address.
    const deep = el.querySelector('[aria-rowindex="500001"][aria-colindex="6"]');
    expect(deep).not.toBeNull();
    expect(deep!.getAttribute('aria-label')).toMatch(/^F500001:/);
  });

  it('deep row headers keep true labels after scrolling', () => {
    const el = mount(h(Grid, { ...gridProps, sel: { row: 500000, col: 0 } }));
    scrollToRow(el, 500000);
    const labels = [...el.querySelectorAll('[role="rowheader"]')].map((hd) =>
      hd.getAttribute('aria-label'),
    );
    expect(labels).toContain('Row 500001');
  });
});
