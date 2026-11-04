/**
 * Window Split (View > Window > Split).
 *
 * A split divides the grid into up to 4 independently-scrollable panes at
 * the current selection: the split point sits above the selected row and
 * left of the selected column. This module is the pure state model;
 * rendering is owned by Grid (see the integration spec below).
 *
 * GRID INTEGRATION SPEC (for the parent wiring Grid.tsx):
 * 1. App state: `split: SplitPoint | null` (null = no split). Ribbon
 *    "Split" toggles: set from the current selection via
 *    splitPointFromSelection(sel) — sel.row/sel.col become the split's
 *    first unfrozen row/col; "Remove Split" sets null.
 * 2. Grid props to add: `split: SplitPoint | null`.
 * 3. Grid render: when split != null, render up to 4 pane viewports
 *    (top-left when split.row>0 && split.col>0, top-right, bottom-left,
 *    bottom-right). Each pane has its OWN scroll offsets; the top panes
 *    share the horizontal scroll of the bottom panes per column side, and
 *    the left panes share the vertical scroll of the right panes per row
 *    side — i.e. scroll sync is per-axis within each row-band/column-band,
 *    exactly like Excel.
 * 4. Cell geometry helper: paneOf(row, col, split) tells which pane a
 *    cell belongs to; use it to clip each pane's rendered range and to
 *    route pointer events (selection moves to the pane under the cursor).
 * 5. Splitter bars: render draggable bars at the split pixel position;
 *    on drag end, convert the pixel position back to a row/col via the
 *    rowHeights/colWidths maps and update `split`.
 * 6. Freeze Panes and Split are mutually exclusive in Excel; when a
 *    split is set, clear `freeze` (and vice versa).
 */

export interface SplitPoint {
  /** First row of the bottom band (0 = no horizontal split). */
  row: number;
  /** First column of the right band (0 = no vertical split). */
  col: number;
}

export type PaneId = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

/** Build a split point from the current selection (split above/left of it). */
export function splitPointFromSelection(sel: { row: number; col: number }): SplitPoint | null {
  if (sel.row === 0 && sel.col === 0) return null; // nothing to split at A1
  return { row: sel.row, col: sel.col };
}

/** Which pane owns the cell at (row, col) under the given split. */
export function paneOf(row: number, col: number, split: SplitPoint | null): PaneId {
  if (!split) return 'bottomRight';
  const top = split.row > 0 && row < split.row;
  const left = split.col > 0 && col < split.col;
  if (top && left) return 'topLeft';
  if (top) return 'topRight';
  if (left) return 'bottomLeft';
  return 'bottomRight';
}

/** Number of visible panes for a split (2, 3 or 4; 1 when no split). */
export function paneCount(split: SplitPoint | null): number {
  if (!split) return 1;
  return (split.row > 0 ? 2 : 1) * (split.col > 0 ? 2 : 1);
}

/**
 * Per-pane scroll state. Each pane keeps its own scroll offsets, but
 * Excel couples axes: panes in the same row band share vertical scroll,
 * panes in the same column band share horizontal scroll. Applying a
 * scroll delta to one pane propagates it to its band partners.
 */
export interface PaneScroll {
  top: number;
  left: number;
}

export type AllPaneScrolls = Record<PaneId, PaneScroll>;

export function initialPaneScrolls(): AllPaneScrolls {
  const zero = (): PaneScroll => ({ top: 0, left: 0 });
  return { topLeft: zero(), topRight: zero(), bottomLeft: zero(), bottomRight: zero() };
}

const ROW_BANDS: Record<PaneId, PaneId[]> = {
  topLeft: ['topLeft', 'topRight'],
  topRight: ['topLeft', 'topRight'],
  bottomLeft: ['bottomLeft', 'bottomRight'],
  bottomRight: ['bottomLeft', 'bottomRight'],
};

const COL_BANDS: Record<PaneId, PaneId[]> = {
  topLeft: ['topLeft', 'bottomLeft'],
  bottomLeft: ['topLeft', 'bottomLeft'],
  topRight: ['topRight', 'bottomRight'],
  bottomRight: ['topRight', 'bottomRight'],
};

/**
 * Scroll one pane; the delta propagates to band partners (shared axes).
 * Returns the updated scroll record (immutable).
 */
export function scrollPane(
  scrolls: AllPaneScrolls,
  pane: PaneId,
  delta: { dTop?: number; dLeft?: number },
): AllPaneScrolls {
  const next: AllPaneScrolls = {
    topLeft: { ...scrolls.topLeft },
    topRight: { ...scrolls.topRight },
    bottomLeft: { ...scrolls.bottomLeft },
    bottomRight: { ...scrolls.bottomRight },
  };
  if (delta.dTop !== undefined && delta.dTop !== 0) {
    for (const p of ROW_BANDS[pane]) next[p] = { ...next[p], top: Math.max(0, next[p].top + delta.dTop) };
  }
  if (delta.dLeft !== undefined && delta.dLeft !== 0) {
    for (const p of COL_BANDS[pane]) next[p] = { ...next[p], left: Math.max(0, next[p].left + delta.dLeft) };
  }
  return next;
}
