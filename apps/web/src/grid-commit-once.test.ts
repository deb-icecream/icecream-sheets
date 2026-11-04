// @vitest-environment jsdom
/**
 * One-edit-one-commit regression (Worker F, defect F2 — Phase 2
 * co-authoring): a single grid edit produced TWO server ops (same
 * clientId, clientSeq n and n+1, identical value; server revs r and
 * r+1), violating the design contract that every user edit submits
 * exactly one op (revision-model doc §§7–8; HYBRID-CONSISTENCY §2).
 *
 * Root cause (proven live, request-counted): Grid's editor commits on
 * Enter/Tab and then moveSel() focuses the scroll container; focusing
 * SYNCHRONOUSLY blurs the editor input, and the blur handler's closure
 * still held the pre-commit `editing` state (React had not re-rendered
 * yet), so commitEdit() fired onCommit a second time for the same
 * keystroke. Click-away commits fired exactly once, which isolated the
 * bug to these keyboard paths. The fix funnels every editor commit
 * through an identity-guarded helper (committedEditingRef).
 *
 * These tests drive the REAL Grid in jsdom exactly as the browser
 * does: double-click to edit, type, then Enter/Tab. jsdom's focus()
 * fires blur synchronously like a browser, so the re-entrant blur
 * commit happens inside the keydown dispatch — pre-fix this suite
 * counts 2 commits per edit; post-fix exactly 1.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import Grid from './Grid';
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

type Commit = { row: number; col: number; text: string };

function Harness({ commits }: { commits: Commit[] }) {
  const [sel, setSel] = useState({ row: 0, col: 0 });
  // Stable host identity (as in App): Grid clears the editor whenever
  // the host object changes, so an inline mockHost() per render would
  // instantly close every edit.
  const [host] = useState(() => mockHost());
  return h(Grid, {
    host,
    sheet: 'Sheet1',
    sel,
    onSelect: (row: number, col: number) => setSel({ row, col }),
    onCommit: (row: number, col: number, text: string) => {
      commits.push({ row, col, text });
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

function mount(commits: Commit[]): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(h(Harness, { commits }));
  });
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
  vi.restoreAllMocks();
});

function typeIntoEditor(el: HTMLElement, row: number, col: number, text: string): HTMLInputElement {
  const cell = el.querySelector(`#cell-${row}-${col}`) as HTMLElement;
  expect(cell, `cell ${row},${col} rendered`).not.toBeNull();
  // Browser sequence for a double-click: click (select), click (the
  // now-selected cell starts editing), dblclick (startEdit again).
  act(() => {
    cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  const cellAgain = el.querySelector(`#cell-${row}-${col}`) as HTMLElement;
  act(() => {
    cellAgain.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    cellAgain.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  });
  const input = el.querySelector('.cell-editor') as HTMLInputElement;
  expect(input, 'editor opened').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  return input;
}

describe('grid editor commit — one edit, one commit (F2)', () => {
  it('Enter commits exactly once (the moveSel focus blur must not re-commit)', () => {
    const commits: Commit[] = [];
    const el = mount(commits);
    const input = typeIntoEditor(el, 2, 0, '777');
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(commits).toEqual([{ row: 2, col: 0, text: '777' }]);
  });

  it('Tab commits exactly once', () => {
    const commits: Commit[] = [];
    const el = mount(commits);
    const input = typeIntoEditor(el, 3, 0, '888');
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(commits).toEqual([{ row: 3, col: 0, text: '888' }]);
  });

  it('a later genuine edit still commits (the guard is per editing session)', () => {
    const commits: Commit[] = [];
    const el = mount(commits);
    const first = typeIntoEditor(el, 2, 0, '777');
    act(() => {
      first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const second = typeIntoEditor(el, 4, 0, '999');
    act(() => {
      second.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(commits).toEqual([
      { row: 2, col: 0, text: '777' },
      { row: 4, col: 0, text: '999' },
    ]);
  });

  it('blur commit (click-away) fires exactly once', () => {
    const commits: Commit[] = [];
    const el = mount(commits);
    const input = typeIntoEditor(el, 2, 0, '555');
    const other = el.querySelector('#cell-0-1') as HTMLElement;
    // Browser order on mousedown: blur fires (its own task — React
    // flushes the editing=null state) before the click lands in a
    // later task, so the click only selects. Two separate acts model
    // that separation; this path was never doubled (live evidence:
    // click-away produced exactly one /ops POST).
    act(() => {
      input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    });
    act(() => {
      other.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(commits).toEqual([{ row: 2, col: 0, text: '555' }]);
  });
});
