/**
 * Grid selection model (user directive 2026-10-21): cell / rectangular
 * range / whole-row(s) / whole-column(s) / select-all as ONE first-class
 * model that copy, delete, formatting and the lock badge all consume.
 *
 * Selection is a VIEW-ONLY concern: this module is pure (no React, no
 * engine/host imports, no I/O). Selection state lives in the client view
 * layer (App + Grid); changing it triggers view state + re-render only —
 * no engine calls, no network, no revision/op traffic.
 *
 * Performance invariant: row/column/select-all selections are represented
 * as shapes + spans, NEVER as enumerated per-cell lists. Consumers turn a
 * selection into rects via selectionRects() and intersect those rects with
 * the used range before iterating any cells.
 */

export type SelectionShape = 'cell' | 'range' | 'rows' | 'cols' | 'all';

/** Inclusive index span, start <= end. */
export interface SelSpan {
  start: number;
  end: number;
}

export interface GridSelection {
  shape: SelectionShape;
  /** Active cell (mirrors App's Selection {row, col}). */
  anchorRow: number;
  anchorCol: number;
  /** Opposite corner for 'cell'/'range' shapes. */
  focusRow: number;
  focusCol: number;
  /** Row spans for shape 'rows' (merged, sorted). */
  rowSpans: SelSpan[];
  /** Column spans for shape 'cols' (merged, sorted). */
  colSpans: SelSpan[];
}

export interface SelRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function clampIdx(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}

/** A single-cell selection anchored (and focused) at (row, col). */
export function cellSelection(row: number, col: number): GridSelection {
  return {
    shape: 'cell',
    anchorRow: row,
    anchorCol: col,
    focusRow: row,
    focusCol: col,
    rowSpans: [],
    colSpans: [],
  };
}

/**
 * A rectangular range between the anchor and focus corners. Collapses to
 * a 'cell' selection when anchor == focus.
 */
export function rangeSelection(
  anchorRow: number,
  anchorCol: number,
  focusRow: number,
  focusCol: number,
): GridSelection {
  if (anchorRow === focusRow && anchorCol === focusCol) {
    return cellSelection(anchorRow, anchorCol);
  }
  return {
    shape: 'range',
    anchorRow,
    anchorCol,
    focusRow,
    focusCol,
    rowSpans: [],
    colSpans: [],
  };
}

/** Select-all: the whole grid, represented as a flag — never enumerated. */
export function allSelection(anchorRow: number, anchorCol: number): GridSelection {
  return {
    shape: 'all',
    anchorRow,
    anchorCol,
    focusRow: anchorRow,
    focusCol: anchorCol,
    rowSpans: [],
    colSpans: [],
  };
}

/** Sort spans and merge overlapping or adjacent ones. */
export function mergeSpans(spans: SelSpan[]): SelSpan[] {
  if (spans.length === 0) return [];
  const sorted = spans
    .map((s) => ({ start: Math.min(s.start, s.end), end: Math.max(s.start, s.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: SelSpan[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const s = sorted[i];
    if (s.start <= last.end + 1) {
      if (s.end > last.end) last.end = s.end;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function spansContain(spans: SelSpan[], index: number): boolean {
  return spans.some((s) => index >= s.start && index <= s.end);
}

/** Remove `index` from a span list, splitting a span when removing its middle. */
function spansRemoveIndex(spans: SelSpan[], index: number): SelSpan[] {
  const out: SelSpan[] = [];
  for (const s of spans) {
    if (index < s.start || index > s.end) {
      out.push(s);
    } else if (s.start === s.end) {
      // Sole member removed — span disappears.
    } else if (index === s.start) {
      out.push({ start: s.start + 1, end: s.end });
    } else if (index === s.end) {
      out.push({ start: s.start, end: s.end - 1 });
    } else {
      out.push({ start: s.start, end: index - 1 });
      out.push({ start: index + 1, end: s.end });
    }
  }
  return out;
}

/**
 * Header-click selection logic (row-number / column-letter headers).
 *
 * - plain click: single span at `index`; anchor = (index, 0) for rows,
 *   (0, index) for cols.
 * - shift: extend the LAST span of that kind from its start to `index`
 *   (if the previous selection is not of that kind, start a fresh span
 *   anchored at the previous anchor's row/col index).
 * - ctrl/cmd: toggle `index` — add a span when not covered, remove it when
 *   covered (splitting a span when removing its middle).
 *
 * Switching kind (rows ↔ cols, or from any other shape) replaces the
 * selection, except that shift/ctrl build on the same kind's spans.
 */
export function headerSelect(
  prev: GridSelection,
  kind: 'rows' | 'cols',
  index: number,
  mods: { shift: boolean; ctrl: boolean },
  maxRow: number,
  maxCol: number,
): GridSelection {
  const idx = clampIdx(index, kind === 'rows' ? maxRow : maxCol);
  const sameKind = prev.shape === kind;
  const prevSpans = kind === 'rows' ? prev.rowSpans : prev.colSpans;

  let spans: SelSpan[];
  if (mods.ctrl) {
    const base = sameKind ? prevSpans : [];
    spans = spansContain(base, idx)
      ? spansRemoveIndex(base, idx)
      : mergeSpans([...base, { start: idx, end: idx }]);
    if (spans.length === 0) {
      // Toggling off the last span collapses back to the anchor cell.
      return cellSelection(prev.anchorRow, prev.anchorCol);
    }
  } else if (mods.shift) {
    if (sameKind && prevSpans.length > 0) {
      const last = prevSpans[prevSpans.length - 1];
      const extended: SelSpan = {
        start: Math.min(last.start, idx),
        end: Math.max(last.start, idx),
      };
      spans = mergeSpans([...prevSpans.slice(0, -1), extended]);
    } else {
      const from = kind === 'rows' ? prev.anchorRow : prev.anchorCol;
      spans = [{ start: Math.min(from, idx), end: Math.max(from, idx) }];
    }
  } else {
    spans = [{ start: idx, end: idx }];
  }

  if (kind === 'rows') {
    const anchorRow = mods.ctrl && sameKind ? prev.anchorRow : spans[0].start;
    return {
      shape: 'rows',
      anchorRow,
      anchorCol: 0,
      focusRow: anchorRow,
      focusCol: 0,
      rowSpans: spans,
      colSpans: [],
    };
  }
  const anchorCol = mods.ctrl && sameKind ? prev.anchorCol : spans[0].start;
  return {
    shape: 'cols',
    anchorRow: 0,
    anchorCol,
    focusRow: 0,
    focusCol: anchorCol,
    rowSpans: [],
    colSpans: spans,
  };
}

/**
 * Header-drag spans: the base spans (already-selected headers, for
 * ctrl-drag) merged with the span swept between the drag start and the
 * current index.
 */
export function headerDragSpans(
  baseSpans: SelSpan[],
  startIndex: number,
  index: number,
): SelSpan[] {
  return mergeSpans([
    ...baseSpans,
    { start: Math.min(startIndex, index), end: Math.max(startIndex, index) },
  ]);
}

/**
 * The selection as rectangles within the grid bounds [0..maxRow]×[0..maxCol].
 * - cell/range → one normalized rect;
 * - rows → one full-width rect per row span;
 * - cols → one full-height rect per column span;
 * - all → one rect covering the whole grid.
 * Rect counts stay proportional to the span count — never to cell counts.
 */
export function selectionRects(sel: GridSelection, maxRow: number, maxCol: number): SelRect[] {
  switch (sel.shape) {
    case 'cell':
      return [{
        startRow: clampIdx(sel.anchorRow, maxRow),
        startCol: clampIdx(sel.anchorCol, maxCol),
        endRow: clampIdx(sel.anchorRow, maxRow),
        endCol: clampIdx(sel.anchorCol, maxCol),
      }];
    case 'range':
      return [{
        startRow: clampIdx(Math.min(sel.anchorRow, sel.focusRow), maxRow),
        startCol: clampIdx(Math.min(sel.anchorCol, sel.focusCol), maxCol),
        endRow: clampIdx(Math.max(sel.anchorRow, sel.focusRow), maxRow),
        endCol: clampIdx(Math.max(sel.anchorCol, sel.focusCol), maxCol),
      }];
    case 'rows':
      return mergeSpans(sel.rowSpans).map((s) => ({
        startRow: clampIdx(s.start, maxRow),
        startCol: 0,
        endRow: clampIdx(s.end, maxRow),
        endCol: maxCol,
      }));
    case 'cols':
      return mergeSpans(sel.colSpans).map((s) => ({
        startRow: 0,
        startCol: clampIdx(s.start, maxCol),
        endRow: maxRow,
        endCol: clampIdx(s.end, maxCol),
      }));
    case 'all':
      return [{ startRow: 0, startCol: 0, endRow: maxRow, endCol: maxCol }];
  }
}

/** Exact, span-aware membership test for one cell. */
export function inSelection(
  sel: GridSelection,
  row: number,
  col: number,
  maxRow: number,
  maxCol: number,
): boolean {
  switch (sel.shape) {
    case 'cell':
      return row === sel.anchorRow && col === sel.anchorCol;
    case 'range': {
      const sr = Math.min(sel.anchorRow, sel.focusRow);
      const er = Math.max(sel.anchorRow, sel.focusRow);
      const sc = Math.min(sel.anchorCol, sel.focusCol);
      const ec = Math.max(sel.anchorCol, sel.focusCol);
      return row >= sr && row <= er && col >= sc && col <= ec;
    }
    case 'rows':
      return row >= 0 && row <= maxRow && spansContain(sel.rowSpans, row);
    case 'cols':
      return col >= 0 && col <= maxCol && spansContain(sel.colSpans, col);
    case 'all':
      return row >= 0 && row <= maxRow && col >= 0 && col <= maxCol;
  }
}

/** Bounding box of the selection's rects. */
export function selectionBounds(sel: GridSelection, maxRow: number, maxCol: number): SelRect {
  const rects = selectionRects(sel, maxRow, maxCol);
  if (rects.length === 0) {
    const r = clampIdx(sel.anchorRow, maxRow);
    const c = clampIdx(sel.anchorCol, maxCol);
    return { startRow: r, startCol: c, endRow: r, endCol: c };
  }
  let out = { ...rects[0] };
  for (const rect of rects.slice(1)) {
    out = {
      startRow: Math.min(out.startRow, rect.startRow),
      startCol: Math.min(out.startCol, rect.startCol),
      endRow: Math.max(out.endRow, rect.endRow),
      endCol: Math.max(out.endCol, rect.endCol),
    };
  }
  return out;
}

export function isSingleCell(sel: GridSelection): boolean {
  return sel.shape === 'cell';
}

/**
 * Where a header context-menu structural insert lands, and how many
 * rows/columns it inserts (addendum 2026-10-21):
 * - if the selection is of the same kind ('rows'/'cols') AND the clicked
 *   index is inside it: count = total spanned indices; 'before' inserts
 *   at the selection's minimum index, 'after' at its maximum + 1.
 * - otherwise: count 1 at the clicked index ('before') or clicked + 1
 *   ('after').
 */
export function insertTarget(
  sel: GridSelection,
  kind: 'rows' | 'cols',
  clickedIndex: number,
  side: 'before' | 'after',
): { at: number; count: number } {
  const spans = kind === 'rows' ? sel.rowSpans : sel.colSpans;
  if (sel.shape === kind && spans.length > 0 && spansContain(spans, clickedIndex)) {
    const count = spans.reduce((n, s) => n + (s.end - s.start + 1), 0);
    const min = Math.min(...spans.map((s) => s.start));
    const max = Math.max(...spans.map((s) => s.end));
    return { at: side === 'before' ? min : max + 1, count };
  }
  return { at: side === 'before' ? clickedIndex : clickedIndex + 1, count: 1 };
}
