/**
 * Dynamic-array spill ranges for the grid (OOXML #69 item 3, display side).
 *
 * Pure helpers over the spill model parsed by
 * `@icecream-sheets/xlsx-adapter` (`spillMetadata.ts`: one `SpillRange`
 * per `<f t="array">` anchor — anchor formula, stored extent, cached
 * values). This file deliberately does NOT import the adapter at runtime:
 * it takes the same shape structurally, so the grid can render spills
 * from any source (adapter parse, engine spill result, app-authored
 * spill) without a dist rebuild coupling.
 *
 * Display semantics (Excel's, as rendered — NOT engine semantics):
 * - The anchor cell shows the formula; every other cell of the extent is
 *   a SPILLED cell: it displays a computed value but holds no formula of
 *   its own, and editing it is an error in Excel (the spill is blocked).
 * - When any non-anchor cell of the extent is occupied by an entered
 *   value, Excel shows `#SPILL!` on the anchor. `spillBlockedBy` finds
 *   those blockers; `spillErrorLabel` turns that into the display label.
 *   Whether the ENGINE computes `#SPILL!` is a follow-up (it currently
 *   emulates spills with static neighbour writes); this helper only
 *   exposes what the grid needs to render the state.
 *
 * Rows/cols are 0-based everywhere; A1 refs are 1-based text.
 */

/** Structural shape of one spill range (mirrors the adapter's SpillRange). */
export interface SpillDisplayRange {
  anchorRow: number;
  anchorCol: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Formula text as stored, without a leading `=`. */
  formula: string;
  /** 'dynamic' for FILTER/SORT/SEQUENCE-style formulas, else 'legacy'. */
  kind: 'dynamic' | 'legacy';
}

/** The adapter's SpillRange shape, structurally (no runtime import). */
export interface AdapterSpillShape {
  anchor: { row: number; col: number; ref: string };
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  ref: string;
  formula: string;
  kind: 'dynamic' | 'legacy';
  cachedValues: unknown[][];
}

/** Convert an adapter SpillRange into the display shape. */
export function fromAdapterSpill(spill: AdapterSpillShape): SpillDisplayRange {
  return {
    anchorRow: spill.anchor.row,
    anchorCol: spill.anchor.col,
    startRow: spill.startRow,
    startCol: spill.startCol,
    endRow: spill.endRow,
    endCol: spill.endCol,
    formula: spill.formula,
    kind: spill.kind,
  };
}

function colLetters(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 0-based (row, col) → A1 ref, e.g. (0, 0) → "A1". */
export function spillA1(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`;
}

/** Extent label, e.g. "A1:C3" (single cell: "A1"). */
export function spillRangeLabel(spill: SpillDisplayRange): string {
  const a = spillA1(spill.startRow, spill.startCol);
  if (spill.startRow === spill.endRow && spill.startCol === spill.endCol) return a;
  return `${a}:${spillA1(spill.endRow, spill.endCol)}`;
}

/** Spill-operator label for the anchor, e.g. "A1#" (Excel's `A1#` notation). */
export function spillRefLabel(spill: SpillDisplayRange): string {
  return `${spillA1(spill.anchorRow, spill.anchorCol)}#`;
}

/** True when (row, col) lies inside the spill extent (anchor included). */
export function spillContains(spill: SpillDisplayRange, row: number, col: number): boolean {
  return (
    row >= spill.startRow && row <= spill.endRow &&
    col >= spill.startCol && col <= spill.endCol
  );
}

/** True when (row, col) is exactly the anchor cell. */
export function isSpillAnchor(spill: SpillDisplayRange, row: number, col: number): boolean {
  return row === spill.anchorRow && col === spill.anchorCol;
}

/** Number of rows / columns in the extent. */
export function spillSize(spill: SpillDisplayRange): { rows: number; cols: number } {
  return {
    rows: spill.endRow - spill.startRow + 1,
    cols: spill.endCol - spill.startCol + 1,
  };
}

export type SpillCellRole = 'anchor' | 'spilled';

export interface SpillCell {
  row: number;
  col: number;
  ref: string;
  role: SpillCellRole;
}

/** Every cell of the extent, row-major, labelled anchor vs spilled. */
export function spillCells(spill: SpillDisplayRange): SpillCell[] {
  const out: SpillCell[] = [];
  for (let r = spill.startRow; r <= spill.endRow; r++) {
    for (let c = spill.startCol; c <= spill.endCol; c++) {
      out.push({
        row: r,
        col: c,
        ref: spillA1(r, c),
        role: isSpillAnchor(spill, r, c) ? 'anchor' : 'spilled',
      });
    }
  }
  return out;
}

/** The spill (if any) whose extent contains (row, col). */
export function spillAt(
  spills: readonly SpillDisplayRange[],
  row: number,
  col: number,
): SpillDisplayRange | undefined {
  return spills.find((s) => spillContains(s, row, col));
}

/** The spill anchored at (row, col), if any. */
export function spillAnchoredAt(
  spills: readonly SpillDisplayRange[],
  row: number,
  col: number,
): SpillDisplayRange | undefined {
  return spills.find((s) => isSpillAnchor(s, row, col));
}

/**
 * Non-anchor extent cells occupied by an entered value, per `isOccupied`.
 * Empty = the spill is unblocked. The anchor itself is never a blocker
 * (it holds the formula). This is the display-side `#SPILL!` condition;
 * it does not decide what the engine calculates.
 */
export function spillBlockedBy(
  spill: SpillDisplayRange,
  isOccupied: (row: number, col: number) => boolean,
): SpillCell[] {
  const out: SpillCell[] = [];
  for (const cell of spillCells(spill)) {
    if (cell.role === 'spilled' && isOccupied(cell.row, cell.col)) out.push(cell);
  }
  return out;
}

/** `'#SPILL!'` when blocked, else null — the anchor's display label. */
export function spillErrorLabel(
  spill: SpillDisplayRange,
  isOccupied: (row: number, col: number) => boolean,
): '#SPILL!' | null {
  return spillBlockedBy(spill, isOccupied).length > 0 ? '#SPILL!' : null;
}
