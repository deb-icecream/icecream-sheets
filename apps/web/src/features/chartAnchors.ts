/**
 * Native-chart anchor math (#125): the exact inverse of the grid's
 * content-coordinate mapping (Grid.tsx gridContentX/gridContentY).
 *
 * A moved native chart keeps its anchor instead of dropping it: the
 * drag's px position converts back to (cell + px offset) here, the
 * overlay renders from that anchor (positionedChartSpec adds the
 * offsets back), and the save re-anchor writes the same cells +
 * offsets into the drawing part — so the moved position is pixel-exact
 * across save/reopen, not cell-snapped.
 */
import {
  COL_HEADER_HEIGHT,
  ROW_HEADER_WIDTH,
  gridColWidth,
  gridRowHeight,
} from '../Grid';

export interface PxAnchor {
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  fromColOff: number;
  fromRowOff: number;
  toColOff: number;
  toRowOff: number;
}

const MAX_COL = 16384;
const MAX_ROW = 1048576;

function cellAt(
  px: number,
  origin: number,
  widthOf: (i: number) => number,
  max: number,
): { index: number; offset: number } {
  const target = Math.max(origin, px);
  let start = origin;
  for (let i = 0; i < max; i++) {
    const w = widthOf(i);
    if (w <= 0) continue;
    if (target < start + w) return { index: i, offset: target - start };
    start += w;
  }
  // Beyond the last cell: clamp to the last cell with offset 0.
  return { index: max - 1, offset: 0 };
}

/**
 * Convert a content-coordinate rect (the overlay's x/y/w/h) to a cell
 * anchor with px offsets. Hidden columns/rows have zero width and are
 * never selected as anchor cells (the walk skips them, exactly like
 * the forward mapping does).
 */
export function anchorFromPx(
  x: number,
  y: number,
  w: number,
  h: number,
  colWidths: Map<number, number>,
  hiddenCols: Set<number>,
  rowHeights: Map<number, number>,
  hiddenRows: Set<number>,
  showHeadings: boolean,
): PxAnchor {
  const originX = showHeadings ? ROW_HEADER_WIDTH : 0;
  const originY = showHeadings ? COL_HEADER_HEIGHT : 0;
  const fromCol = cellAt(x, originX, (c) => gridColWidth(c, colWidths, hiddenCols), MAX_COL);
  const toCol = cellAt(
    x + Math.max(0, w),
    originX,
    (c) => gridColWidth(c, colWidths, hiddenCols),
    MAX_COL,
  );
  const fromRow = cellAt(y, originY, (r) => gridRowHeight(r, rowHeights, hiddenRows), MAX_ROW);
  const toRow = cellAt(
    y + Math.max(0, h),
    originY,
    (r) => gridRowHeight(r, rowHeights, hiddenRows),
    MAX_ROW,
  );
  return {
    fromCol: fromCol.index,
    fromRow: fromRow.index,
    toCol: toCol.index,
    toRow: toRow.index,
    fromColOff: fromCol.offset,
    fromRowOff: fromRow.offset,
    toColOff: toCol.offset,
    toRowOff: toRow.offset,
  };
}
