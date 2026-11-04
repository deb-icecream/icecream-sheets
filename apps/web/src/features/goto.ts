/**
 * Go To… / Go To Special… logic (Home > Editing > Find & Select).
 *
 * Pure helpers over a small cell-access interface so the dialog stays
 * engine-agnostic; the app implements the accessor from EngineHost.
 */
import type { NamedRangeDef } from '@icecream-sheets/service';

export type CellKind = 'blank' | 'constant' | 'formula';

export interface UsedBounds {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface GoToAccess {
  getCellKind: (row: number, col: number) => CellKind;
  usedRange: () => UsedBounds | null;
}

export type GoToSpecialKind = 'constants' | 'formulas' | 'blanks';

/**
 * Parse a Go To target: an A1 reference ("B5", "A1:C3") or a defined name.
 * Returns the resolved 0-based range, or null when neither parses.
 */
export function parseGoToTarget(
  text: string,
  names: NamedRangeDef[],
): UsedBounds | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const ref = parseA1(trimmed);
  if (ref) return ref;
  const name = names.find((n) => n.name.toLowerCase() === trimmed.toLowerCase());
  if (name?.ref) {
    return {
      startRow: name.ref.startRow,
      startCol: name.ref.startCol,
      endRow: name.ref.endRow,
      endCol: name.ref.endCol,
    };
  }
  return null;
}

/** Parse "A1" or "A1:C3" (with optional $) into 0-based bounds. */
function parseA1(text: string): UsedBounds | null {
  const clean = text.replace(/\s+/g, '');
  const part = '\\$?([A-Za-z]{1,3})\\$?([0-9]+)';
  const m = new RegExp(`^${part}(?::${part})?$`).exec(clean);
  if (!m) return null;
  const colOf = (letters: string): number => {
    let idx = 0;
    for (const ch of letters.toUpperCase()) idx = idx * 26 + (ch.charCodeAt(0) - 64);
    return idx - 1;
  };
  const sc = colOf(m[1]);
  const sr = Number(m[2]) - 1;
  const ec = m[3] !== undefined ? colOf(m[3]) : sc;
  const er = m[4] !== undefined ? Number(m[4]) - 1 : sr;
  if (sr < 0 || er < 0 || sr > 1048575 || er > 1048575) return null;
  if (sc < 0 || ec < 0 || sc > 16383 || ec > 16383) return null;
  return {
    startRow: Math.min(sr, er), startCol: Math.min(sc, ec),
    endRow: Math.max(sr, er), endCol: Math.max(sc, ec),
  };
}

/**
 * All cells of a special kind inside the used range, row-major.
 * Excel's Go To Special selects every match; the caller focuses the first.
 */
export function findSpecialCells(access: GoToAccess, kind: GoToSpecialKind): { row: number; col: number }[] {
  const used = access.usedRange();
  if (!used) return [];
  const out: { row: number; col: number }[] = [];
  for (let r = used.startRow; r <= used.endRow; r++) {
    for (let c = used.startCol; c <= used.endCol; c++) {
      if (matchesKind(access.getCellKind(r, c), kind)) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}

function matchesKind(cellKind: CellKind, kind: GoToSpecialKind): boolean {
  if (kind === 'constants') return cellKind === 'constant';
  if (kind === 'formulas') return cellKind === 'formula';
  return cellKind === 'blank';
}

/**
 * Current Region (Ctrl+*): the maximal contiguous block of non-blank cells
 * containing (row, col), found by flood fill. Returns just the cell when it
 * is blank and isolated.
 */
export function currentRegion(access: GoToAccess, row: number, col: number): UsedBounds {
  const used = access.usedRange();
  const single = { startRow: row, startCol: col, endRow: row, endCol: col };
  if (!used) return single;
  if (access.getCellKind(row, col) === 'blank') return single;

  const seen = new Set<string>();
  let minR = row, maxR = row, minC = col, maxC = col;
  const queue: [number, number][] = [[row, col]];
  while (queue.length > 0) {
    const [r, c] = queue.pop() as [number, number];
    const key = `${r},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r < used.startRow || r > used.endRow || c < used.startCol || c > used.endCol) continue;
    if (access.getCellKind(r, c) === 'blank') continue;
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
    queue.push([r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]);
  }
  return { startRow: minR, startCol: minC, endRow: maxR, endCol: maxC };
}
