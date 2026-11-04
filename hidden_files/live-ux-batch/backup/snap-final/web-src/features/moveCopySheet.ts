/**
 * Move or Copy Sheet… (Home > Cells > Format > Move or Copy Sheet…)
 * index math.
 *
 * Pure helpers: the app owns the sheets array and the per-sheet cell data;
 * these compute the resulting sheet order and a non-colliding name for the
 * copy. Copying cell data itself is a readRange/setCell loop in the app
 * (see the dialog's wiring spec).
 */

/** Move `from` to just before `toIndex` in the sheet order. */
export function moveSheetOrder(sheets: string[], from: number, toIndex: number): string[] {
  const next = [...sheets];
  if (from < 0 || from >= next.length) return next;
  const [name] = next.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, next.length));
  next.splice(clamped, 0, name);
  return next;
}

/**
 * Generate a copy name that does not collide, Excel-style:
 * "Sheet1" -> "Sheet1 (2)", then "Sheet1 (3)", …
 */
export function copySheetName(sheets: string[], base: string): string {
  const taken = new Set(sheets);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/**
 * Insert a copied sheet name just before `toIndex` (or at the end when
 * toIndex is null, i.e. "(move to end)").
 */
export function insertSheetCopy(sheets: string[], copyName: string, toIndex: number | null): string[] {
  const next = [...sheets];
  const clamped = toIndex === null ? next.length : Math.max(0, Math.min(toIndex, next.length));
  next.splice(clamped, 0, copyName);
  return next;
}
