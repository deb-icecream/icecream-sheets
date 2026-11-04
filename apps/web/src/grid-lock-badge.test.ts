// @vitest-environment jsdom
/**
 * Lock badge rule (user ruling 2026-10-21, design-docs/
 * workbook-protection-and-encryption.md §2): the 🔒 badge and its
 * amber inset edge on locked cells are SELECTION-ACTIVATED — they
 * render only on locked cells inside the current selection, never
 * across the whole sheet. The app's selection model is a single
 * active cell (Selection {row, col}); it exposes no range / whole-
 * row / whole-column / select-all shapes today, so this suite pins
 * the rule for the shapes that exist:
 *   (a) an UNLOCKED cell selected → no badge anywhere;
 *   (b) a LOCKED cell selected → badge on that cell only;
 *   (c) the aria-label "(locked)" announcement is NOT gated by the
 *       selection (accessibility unchanged).
 * When richer selection shapes are built, this suite is where their
 * cases belong (badge on locked cells of the selected row/column,
 * select-all = today's old everywhere behavior).
 *
 * The rich selection model (features/selection.ts) HAS now been built;
 * the (c)/(d)/(e) cases below drive it through Grid's `selection` prop:
 *   (c) rows selection covering row 1 → badges only on row 1's locked cells;
 *   (d) cols selection covering col 1 → badges only in column 1;
 *   (e) all selection → badges on every rendered locked cell.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import Grid from './Grid';
import { allSelection, cellSelection, headerSelect } from './features/selection';
import { createFormatStore, createDataTypeStore } from './features/formatting';
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

function mount(ui: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  // Give the grid a real viewport so body cells render.
  const grid = container.querySelector('[role="grid"]') as HTMLElement;
  Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 600 });
  act(() => {
    roCallback?.();
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

/** Protected sheet: every cell locked EXCEPT A1 (the one input cell). */
const isCellLocked = (row: number, col: number) => !(row === 0 && col === 0);

const baseProps = {
  host: mockHost(),
  sheet: 'Sheet1',
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
  isCellLocked,
};

describe('lock badge is selection-activated', () => {
  it('(a) unlocked cell selected: no badge or amber inset anywhere', () => {
    const el = mount(h(Grid, { ...baseProps, sel: { row: 0, col: 0 } }));
    expect(el.querySelectorAll('.cell-locked-marker')).toHaveLength(0);
    for (const cell of el.querySelectorAll('[role="gridcell"]')) {
      expect((cell as HTMLElement).style.boxShadow ?? '').not.toContain('inset');
    }
  });

  it('(b) locked cell selected: badge + inset on that cell only', () => {
    const el = mount(h(Grid, { ...baseProps, sel: { row: 1, col: 1 } }));
    const markers = el.querySelectorAll('.cell-locked-marker');
    expect(markers).toHaveLength(1);
    const owner = markers[0].closest('[role="gridcell"]');
    expect(owner?.id).toBe('cell-1-1');
    expect((owner as HTMLElement).style.boxShadow).toContain('inset');
    // Every other rendered locked cell stays clean.
    for (const cell of el.querySelectorAll('[role="gridcell"]')) {
      if (cell.id !== 'cell-1-1') {
        expect((cell as HTMLElement).style.boxShadow ?? '').not.toContain('inset');
        expect(cell.querySelector('.cell-locked-marker')).toBeNull();
      }
    }
  });

  it('(c) aria-label "(locked)" announcement is not selection-gated', () => {
    const el = mount(h(Grid, { ...baseProps, sel: { row: 0, col: 0 } }));
    const lockedUnselected = el.querySelector('#cell-1-1');
    expect(lockedUnselected?.getAttribute('aria-label')).toContain('(locked)');
    const unlocked = el.querySelector('#cell-0-0');
    expect(unlocked?.getAttribute('aria-label')).not.toContain('(locked)');
  });

  it('moving the selection moves the badge', () => {
    const el = mount(h(Grid, { ...baseProps, sel: { row: 2, col: 2 } }));
    expect(el.querySelectorAll('.cell-locked-marker')).toHaveLength(1);
    expect(el.querySelector('.cell-locked-marker')?.closest('[role="gridcell"]')?.id).toBe('cell-2-2');
  });

  it('(c) rows selection: badges only on locked cells of the selected row', () => {
    const selection = headerSelect(cellSelection(0, 0), 'rows', 1, { shift: false, ctrl: false }, 100, 26);
    const el = mount(h(Grid, { ...baseProps, sel: { row: 1, col: 0 }, selection }));
    const markers = el.querySelectorAll('.cell-locked-marker');
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      const owner = m.closest('[role="gridcell"]') as HTMLElement;
      // Every badge lives in row 1 (ids are cell-<row>-<col>).
      expect(owner.id.startsWith('cell-1-')).toBe(true);
    }
    // Locked cells in other rows show nothing.
    for (const cell of el.querySelectorAll('[role="gridcell"]')) {
      if (!(cell as HTMLElement).id.startsWith('cell-1-')) {
        expect(cell.querySelector('.cell-locked-marker')).toBeNull();
      }
    }
  });

  it('(d) cols selection: badges only on locked cells of the selected column', () => {
    const selection = headerSelect(cellSelection(0, 0), 'cols', 1, { shift: false, ctrl: false }, 100, 26);
    const el = mount(h(Grid, { ...baseProps, sel: { row: 0, col: 1 }, selection }));
    const markers = el.querySelectorAll('.cell-locked-marker');
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      const owner = m.closest('[role="gridcell"]') as HTMLElement;
      expect(owner.id.endsWith('-1')).toBe(true);
      expect(owner.getAttribute('aria-colindex')).toBe('2');
    }
    for (const cell of el.querySelectorAll('[role="gridcell"]')) {
      if (cell.getAttribute('aria-colindex') !== '2') {
        expect(cell.querySelector('.cell-locked-marker')).toBeNull();
      }
    }
  });

  it('(e) select-all: badges on every rendered locked cell', () => {
    const selection = allSelection(0, 0);
    const el = mount(h(Grid, { ...baseProps, sel: { row: 0, col: 0 }, selection }));
    const cells = [...el.querySelectorAll('[role="gridcell"]')] as HTMLElement[];
    expect(cells.length).toBeGreaterThan(0);
    let lockedCount = 0;
    for (const cell of cells) {
      const row = Number(cell.id.split('-')[1]);
      const col = Number(cell.id.split('-')[2]);
      const locked = !(row === 0 && col === 0); // A1 is the one unlocked cell
      if (locked) {
        lockedCount++;
        expect(cell.querySelector('.cell-locked-marker')).not.toBeNull();
      } else {
        expect(cell.querySelector('.cell-locked-marker')).toBeNull();
      }
    }
    expect(lockedCount).toBeGreaterThan(0);
  });
});
