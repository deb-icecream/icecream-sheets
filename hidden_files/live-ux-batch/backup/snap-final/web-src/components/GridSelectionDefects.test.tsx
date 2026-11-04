// @vitest-environment jsdom
/**
 * Regression tests for selection-model defects D-SEL-1 and D-SEL-2
 * (open-defects sweep, items I and J) and D-SEL-4 (selection tours
 * re-run, 2026-10-22).
 *
 * I (D-SEL-1): a completed body-cell drag's trailing click lands on the
 * scroll container (the common ancestor of the press/release cells), so
 * the old code never consumed dragMovedRef and the NEXT genuine cell
 * click was silently swallowed. The fix consumes the flag in the
 * container's onClick. These tests replicate the dbg10 probe harness:
 * drag (1,1)->(3,3), trailing container click, then a genuine click must
 * collapse the selection; shift+click after a drag must extend from the
 * live anchor.
 *
 * J (D-SEL-2, Grid half): header onContextMenu must not destroy the
 * selection when the right-click lands inside it (Excel semantics) —
 * only a right-click OUTSIDE the current selection re-points.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EngineHost } from '@icecream-sheets/engine';
import Grid from '../Grid';
import { cellSelection, rangeSelection, type GridSelection } from '../features/selection';
import { createFormatStore, createDataTypeStore } from '../features/formatting';
import { DEFAULT_LOCALE } from '../features/locale';
import type { Selection } from '../App';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
/** Selections emitted via onSelectionChange, in order. */
let emitted: GridSelection[] = [];

beforeAll(() => {
  // jsdom lacks these; Grid touches them on mount.
  if (!window.ResizeObserver) {
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!window.HTMLElement.prototype.scrollTo) {
    window.HTMLElement.prototype.scrollTo = () => {};
  }
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  emitted = [];
});

function Harness({ initial }: { initial: GridSelection }) {
  const [selection, setSelection] = useState<GridSelection>(initial);
  const [sel, setSel] = useState<Selection>({ row: initial.anchorRow, col: initial.anchorCol });
  return (
    <Grid
      host={new EngineHost()}
      sheet="Sheet1"
      sel={sel}
      onSelect={(row, col) => setSel({ row, col })}
      selection={selection}
      onSelectionChange={(next) => {
        emitted.push(next);
        setSelection(next);
        setSel({ row: next.anchorRow, col: next.anchorCol });
      }}
      onCommit={() => {}}
      version={0}
      cfRules={[]}
      validations={[]}
      merges={[]}
      freeze={null}
      filters={new Map()}
      sortState={null}
      formats={createFormatStore()}
      dataTypes={createDataTypeStore()}
      locale={DEFAULT_LOCALE}
      showHeadings
      rowHeights={new Map()}
      colWidths={new Map()}
      hiddenRows={new Set()}
      hiddenCols={new Set()}
      showFormulas={false}
      formulaTexts={new Map()}
      comments={new Map()}
      dataTypeCells={new Map()}
      dataTypeCardKey={null}
      onToggleDataTypeCard={() => {}}
      slicerSpecs={[]}
      timelineSpecs={[]}
      sparklineCells={new Map()}
      smartChipCells={new Map()}
      smartChipCardKey={null}
      onToggleSmartChipCard={() => {}}
      focusCell={false}
      extCfStyle={() => null}
      onContextMenu={() => {}}
      onOpenFilter={() => {}}
      getCellMenu={() => []}
      getColumnMenu={() => []}
      getRowMenu={() => []}
    />
  );
}

function mount(initial: GridSelection) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness initial={initial} />);
  });
}

const byId = (id: string) => container!.querySelector<HTMLElement>(`#${id}`)!;
const scrollContainer = () => container!.querySelector<HTMLElement>('[role="grid"]')!;

function mouseDown(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
}
/** React's onMouseEnter is polyfilled from mouseover/mouseout. */
function mouseEnter(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}
function mouseUp() {
  act(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}
function click(el: HTMLElement, shift = false) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, shiftKey: shift }));
  });
}
function contextMenu(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
  });
}

/** Replicates the dbg10 probe: drag (1,1)->(3,3) then the browser's trailing click on the container. */
function dragWithTrailingContainerClick() {
  mouseDown(byId('cell-1-1'));
  mouseEnter(byId('cell-3-3'));
  mouseUp();
  click(scrollContainer());
}

describe('D-SEL-1 post-drag swallowed click (item I)', () => {
  it('a genuine click right after a drag collapses the range', () => {
    mount(cellSelection(1, 1));
    expect(emitted).toHaveLength(0);
    dragWithTrailingContainerClick();
    // The drag itself emits the range selection (1,1)->(3,3).
    expect(emitted).toHaveLength(1);
    expect(emitted[0].shape).toBe('range');

    // The next genuine click on a cell inside the range collapses it
    // (Excel collapses on click; the old bug swallowed this click).
    click(byId('cell-2-2'));
    expect(emitted).toHaveLength(2);
    const collapsed = emitted[1];
    expect(collapsed.shape).toBe('cell');
    expect(collapsed.anchorRow).toBe(2);
    expect(collapsed.anchorCol).toBe(2);
  });

  it('shift+click after a drag extends from the live drag anchor', () => {
    mount(cellSelection(1, 1));
    dragWithTrailingContainerClick();
    expect(emitted).toHaveLength(1);

    // The drag's anchor is (1,1); shift+click must extend from there,
    // not from a stale anchor (the old bug extended from (0,0)-ish state
    // because the swallow path was never reached).
    click(byId('cell-0-3'), true);
    expect(emitted).toHaveLength(2);
    const extended = emitted[1];
    expect(extended.shape).toBe('range');
    expect(extended.anchorRow).toBe(1);
    expect(extended.anchorCol).toBe(1);
    expect(extended.focusRow).toBe(0);
    expect(extended.focusCol).toBe(3);
  });

  it('a drag that returns to its press cell still swallows the trailing cell click (no edit)', () => {
    mount(cellSelection(1, 1));
    mouseDown(byId('cell-1-1'));
    mouseEnter(byId('cell-2-2'));
    mouseEnter(byId('cell-1-1')); // back to origin
    mouseUp();
    const afterDrag = emitted.length;
    expect(afterDrag).toBeGreaterThan(0);
    // The trailing click lands on the press cell itself: swallowed once,
    // so it neither collapses the range nor starts an edit.
    click(byId('cell-1-1'));
    expect(emitted).toHaveLength(afterDrag);
  });
});

describe('D-SEL-2 header context menu keeps selection (item J, Grid half)', () => {
  const rowsSel: GridSelection = {
    shape: 'rows',
    anchorRow: 2,
    anchorCol: 0,
    focusRow: 2,
    focusCol: 0,
    rowSpans: [{ start: 2, end: 4 }],
    colSpans: [],
  };
  const colsSel: GridSelection = {
    shape: 'cols',
    anchorRow: 0,
    anchorCol: 1,
    focusRow: 0,
    focusCol: 1,
    rowSpans: [],
    colSpans: [{ start: 1, end: 2 }],
  };

  it('row header right-click INSIDE the selected rows does not re-point', () => {
    mount(rowsSel);
    contextMenu(container!.querySelector<HTMLElement>('[aria-label="Row 4"]')!);
    expect(emitted).toHaveLength(0);
  });

  it('row header right-click OUTSIDE the selected rows re-points to the whole row', () => {
    mount(rowsSel);
    contextMenu(container!.querySelector<HTMLElement>('[aria-label="Row 1"]')!);
    expect(emitted).toHaveLength(1);
    // Excel semantics: a header right-click re-points like a plain
    // header left-click — the whole row, not a single cell.
    expect(emitted[0].shape).toBe('rows');
    expect(emitted[0].rowSpans).toEqual([{ start: 0, end: 0 }]);
    expect(emitted[0].anchorRow).toBe(0);
    expect(emitted[0].anchorCol).toBe(0);
  });

  it('column header right-click INSIDE the selected columns does not re-point', () => {
    mount(colsSel);
    contextMenu(container!.querySelector<HTMLElement>('[aria-label="Column C"]')!);
    expect(emitted).toHaveLength(0);
  });

  it('column header right-click OUTSIDE the selected columns re-points to the whole column', () => {
    mount(colsSel);
    contextMenu(container!.querySelector<HTMLElement>('[aria-label="Column A"]')!);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].shape).toBe('cols');
    expect(emitted[0].colSpans).toEqual([{ start: 0, end: 0 }]);
    expect(emitted[0].anchorRow).toBe(0);
    expect(emitted[0].anchorCol).toBe(0);
  });

  it('select-all survives a header right-click', () => {
    const all = { ...cellSelection(0, 0), shape: 'all' as const };
    mount(all);
    contextMenu(container!.querySelector<HTMLElement>('[aria-label="Row 2"]')!);
    expect(emitted).toHaveLength(0);
    contextMenu(container!.querySelector<HTMLElement>('[aria-label="Column B"]')!);
    expect(emitted).toHaveLength(0);
  });
});

describe('D-SEL-4 cell context menu keeps selection (selection tours re-run)', () => {
  // K (D-SEL-4): handleCellContext unconditionally re-pointed the
  // selection to the right-clicked cell before opening the cell menu,
  // so Copy/Clear/Delete from the menu acted on ONE cell even when the
  // user had a range / row set / select-all selected. The header menus
  // got the keeps-selection rule in the D-SEL-2 fix; the cell handler
  // is its remainder. Found by the Tours A/B re-run: menu Copy on a
  // B2:C3 range wrote only "3" (the anchor), select-all wrote 1 line.
  const rangeSel = rangeSelection(1, 1, 3, 3);
  const rowsSel: GridSelection = {
    shape: 'rows',
    anchorRow: 2,
    anchorCol: 0,
    focusRow: 2,
    focusCol: 0,
    rowSpans: [{ start: 2, end: 4 }],
    colSpans: [],
  };

  it('right-click INSIDE a range does not re-point (menu acts on the range)', () => {
    mount(rangeSel);
    contextMenu(byId('cell-2-2'));
    expect(emitted).toHaveLength(0);
  });

  it('right-click on the range ANCHOR cell does not re-point either', () => {
    mount(rangeSel);
    contextMenu(byId('cell-1-1'));
    expect(emitted).toHaveLength(0);
  });

  it('right-click OUTSIDE the range re-points to the clicked cell', () => {
    mount(rangeSel);
    contextMenu(byId('cell-0-0'));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].shape).toBe('cell');
    expect(emitted[0].anchorRow).toBe(0);
    expect(emitted[0].anchorCol).toBe(0);
  });

  it('select-all survives a cell right-click', () => {
    const all = { ...cellSelection(0, 0), shape: 'all' as const };
    mount(all);
    contextMenu(byId('cell-2-2'));
    expect(emitted).toHaveLength(0);
  });

  it('a rows selection survives a right-click on a cell in a selected row', () => {
    mount(rowsSel);
    contextMenu(byId('cell-3-1'));
    expect(emitted).toHaveLength(0);
  });

  it('a rows selection re-points on a right-click on a cell in an unselected row', () => {
    mount(rowsSel);
    contextMenu(byId('cell-0-0'));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].shape).toBe('cell');
    expect(emitted[0].anchorRow).toBe(0);
    expect(emitted[0].anchorCol).toBe(0);
  });
});
