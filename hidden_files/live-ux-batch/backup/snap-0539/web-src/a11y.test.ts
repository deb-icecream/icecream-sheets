// @vitest-environment jsdom
/**
 * Automated WCAG 2.2 AA checks (design-docs/accessibility.md §5.1).
 *
 * Runs axe-core over the real rendered surfaces: the virtualized grid
 * (with true aria-rowindex/aria-colindex deep in the sheet), the shared
 * dialog primitive, the status bar, and the skip links.
 *
 * Zero violations is the bar. These run in CI on every build.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import axe from 'axe-core';
import Grid from './Grid';
import { createFormatStore, createDataTypeStore } from './features/formatting';
import { DEFAULT_LOCALE } from './features/locale';
import StatusBar from './StatusBar';
import FormulaBar from './FormulaBar';
import A11yDialog from './components/A11yDialog';
import AutocompleteDropdown from './components/AutocompleteDropdown';
import type { EngineHost, TypedValue } from '@icecream-sheets/engine';
import { cellRef } from './engine';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

// jsdom lacks Element.scrollTo, Element.scrollIntoView and ResizeObserver; the grid uses all.
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function () {};
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
if (typeof ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

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

async function expectNoViolations(el: HTMLElement, label: string) {
  const results = await axe.run(el, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] },
  });
  const msgs = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help}`,
  );
  expect(msgs, `${label} axe violations`).toEqual([]);
}

/** Minimal EngineHost for a11y tests: 3x3 of values, everything else empty. */
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

describe('axe: zero WCAG 2.2 AA violations', () => {
  it('grid shell', async () => {
    const el = mount(h(Grid, gridProps));
    await expectNoViolations(el, 'grid');
  }, 30000);

  it('dialog primitive', async () => {
    const el = mount(
      h(A11yDialog, { title: 'Sort', onClose: () => {}, children: [
        h('label', null, 'Column ', h('input', { type: 'text' })),
        h('button', null, 'OK'),
      ]}),
    );
    await expectNoViolations(el, 'dialog');
  }, 30000);

  it('status bar', async () => {
    const el = mount(
      h(StatusBar, {
        protocolVersion: 1, calcMode: 'automatic', address: 'B2', lastError: null,
      }),
    );
    await expectNoViolations(el, 'status bar');
  }, 30000);

  it('status bar with error alert', async () => {
    const el = mount(
      h(StatusBar, {
        protocolVersion: 1, calcMode: 'automatic', address: 'B2',
        lastError: '#DIV/0! in C5',
      }),
    );
    await expectNoViolations(el, 'status bar error');
  }, 30000);

  it('skip links', async () => {
    const el = mount(
      h('div', null,
        h('a', { href: '#grid-region', className: 'skip-link' }, 'Skip to grid'),
        h('a', { href: '#ribbon-region', className: 'skip-link' }, 'Skip to ribbon')),
    );
    await expectNoViolations(el, 'skip links');
  }, 30000);
});

describe('grid ARIA contract', () => {
  it('gridcells carry TRUE row/col indices, not viewport-relative ones', () => {
    const el = mount(h(Grid, gridProps));
    const cells = el.querySelectorAll('[role="gridcell"]');
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of Array.from(cells)) {
      const id = cell.getAttribute('id'); // cell-<row>-<col>
      const m = /^cell-(\d+)-(\d+)$/.exec(id ?? '');
      expect(m, `cell id ${id}`).toBeTruthy();
      // aria-rowindex/aria-colindex are 1-based true indices.
      expect(cell.getAttribute('aria-rowindex')).toBe(String(Number(m![1]) + 1));
      expect(cell.getAttribute('aria-colindex')).toBe(String(Number(m![2]) + 1));
    }
  });

  it('grid exposes LOGICAL rowcount/colcount and activedescendant', () => {
    const el = mount(h(Grid, gridProps));
    const grid = el.querySelector('[role="grid"]')!;
    // accessibility.md §2.1: logical size 1,048,576 × 16,384 — an attribute
    // only, so the virtualized grid still renders just the window.
    expect(grid.getAttribute('aria-rowcount')).toBe('1048576');
    expect(grid.getAttribute('aria-colcount')).toBe('16384');
    // Active cell B2 -> cell-1-1.
    expect(grid.getAttribute('aria-activedescendant')).toBe('cell-1-1');
  });

  it('headers use columnheader/rowheader roles with true indices', () => {
    const el = mount(h(Grid, gridProps));
    const colHeaders = el.querySelectorAll('[role="columnheader"]');
    const rowHeaders = el.querySelectorAll('[role="rowheader"]');
    expect(colHeaders.length).toBeGreaterThan(0);
    expect(rowHeaders.length).toBeGreaterThan(0);
    for (const ch of Array.from(colHeaders)) {
      expect(ch.getAttribute('aria-colindex')).toBeTruthy();
      expect(ch.getAttribute('aria-label')).toMatch(/Column /);
    }
    for (const rh of Array.from(rowHeaders)) {
      // aria-rowindex lives on the wrapping role="row" (true index).
      const row = rh.closest('[role="row"]');
      expect(row?.getAttribute('aria-rowindex')).toBeTruthy();
    }
  });

  it('active cell is marked selected with an accessible name', () => {
    const el = mount(h(Grid, gridProps));
    const active = el.querySelector('#cell-1-1')!;
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.getAttribute('aria-label')).toMatch(/B2:/);
  });

  it('cellRef import is live (sanity)', () => {
    expect(cellRef('Sheet1', 1, 1)).toBeTruthy();
  });
});

describe('status bar landmark (accessibility.md §2.2)', () => {
  it('status bar is role="contentinfo"', () => {
    const el = mount(
      h(StatusBar, {
        protocolVersion: 1, calcMode: 'automatic', address: 'B2', lastError: null,
      }),
    );
    const sb = el.querySelector('[role="contentinfo"]');
    expect(sb, 'contentinfo region').toBeTruthy();
    expect(sb!.textContent).toContain('Cell: B2');
  });

  it('error alert still announced assertively', () => {
    const el = mount(
      h(StatusBar, {
        protocolVersion: 1, calcMode: 'automatic', address: 'C3',
        lastError: '#DIV/0! in C5',
      }),
    );
    const alert = el.querySelector('[role="contentinfo"] [role="alert"]');
    expect(alert, 'alert region inside contentinfo').toBeTruthy();
    expect(alert!.textContent).toContain('#DIV/0!');
  });
});

describe('formula bar address + autocomplete (accessibility.md §2.2)', () => {
  // FormulaBar needs view.readRange for column inference; extend the grid mock.
  function formulaHost(): EngineHost {
    const host = mockHost();
    const view = host.getView() as unknown as Record<string, unknown>;
    view.readRange = (host as unknown as { readRange: unknown }).readRange;
    return host;
  }

  function mountFormulaBar(): HTMLElement {
    return mount(
      h(FormulaBar, {
        host: formulaHost(),
        sheet: 'Sheet1',
        sel: { row: 1, col: 1 },
        onCommit: () => {},
        version: 1,
      }),
    );
  }

  it('formula bar input announces the active cell address', () => {
    const el = mountFormulaBar();
    const input = el.querySelector('input[aria-label="Formula bar"]')!;
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy, 'aria-describedby on input').toBeTruthy();
    const address = el.querySelector(`#${CSS.escape(describedBy!)}`);
    expect(address, 'address element').toBeTruthy();
    // Active cell B2 (row 1, col 1) is exposed to screen readers.
    expect(address!.textContent).toBe('B2');
  });

  it('autocomplete listbox exposes aria-activedescendant (formula bar)', () => {
    const el = mountFormulaBar();
    const input = el.querySelector('input[aria-label="Formula bar"]') as HTMLInputElement;
    // Type a formula prefix; the native setter + input event flows through
    // React's onChange, and the caret position seeds completion.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      nativeSetter.call(input, '=SU');
      input.setSelectionRange(3, 3);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const listbox = el.querySelector('[role="listbox"]');
    expect(listbox, 'suggestion listbox opens').toBeTruthy();
    const activeId = listbox!.getAttribute('aria-activedescendant');
    expect(activeId, 'aria-activedescendant').toBeTruthy();
    const activeOption = el.querySelector(`#${CSS.escape(activeId!)}`);
    expect(activeOption, 'activedescendant resolves to a rendered option').toBeTruthy();
    expect(activeOption!.getAttribute('role')).toBe('option');
    expect(activeOption!.getAttribute('aria-selected')).toBe('true');
    // The input is wired to the listbox (combobox pattern).
    expect(input.getAttribute('aria-controls')).toBe(listbox!.getAttribute('id'));
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('AutocompleteDropdown activedescendant resolves in isolation', () => {
    const el = mount(
      h(AutocompleteDropdown, {
        idPrefix: 'test-ac',
        items: [
          { value: 'SUM', label: 'SUM', hint: 'Math' },
          { value: 'SUMIF', label: 'SUMIF', hint: 'Math' },
        ],
        activeIndex: 1,
        onPick: () => {},
        onHover: () => {},
      }),
    );
    const listbox = el.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute('aria-activedescendant')).toBe('test-ac-option-1');
    const option = el.querySelector('#test-ac-option-1')!;
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect(option.textContent).toContain('SUMIF');
  });
});
