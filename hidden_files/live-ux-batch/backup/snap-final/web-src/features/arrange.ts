/**
 * Arrange (Page Layout > Arrange): z-order, alignment, distribution and
 * rotation for floating overlays (pictures, shapes, charts, text boxes).
 *
 * ArrangeItem is the generic adapter: the App maps each overlay kind into
 * it, runs the pure functions here, and maps the result back. z is the
 * explicit paint order (higher paints on top); normalizeZ() compacts it.
 */

export interface ArrangeItem {
  id: number | string;
  /** Display name shown in the Selection Pane. */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  hidden?: boolean;
  /** Clockwise degrees. */
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
}

function byZ(items: ArrangeItem[]): ArrangeItem[] {
  return [...items].sort((a, b) => a.z - b.z || String(a.id).localeCompare(String(b.id)));
}

/** Reassign z as 0..n-1 in the GIVEN order (no re-sort). */
function assignZ(ordered: ArrangeItem[]): ArrangeItem[] {
  return ordered.map((it, i) => ({ ...it, z: i }));
}

/** Reassign z as 0..n-1 in current paint order. */
export function normalizeZ(items: ArrangeItem[]): ArrangeItem[] {
  return assignZ(byZ(items));
}

function swapZ(items: ArrangeItem[], id: number | string, dir: 1 | -1): ArrangeItem[] {
  const ordered = byZ(items);
  const i = ordered.findIndex((it) => it.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ordered.length) return items;
  const tmp = ordered[i];
  ordered[i] = ordered[j];
  ordered[j] = tmp;
  return assignZ(ordered);
}

/** Move one step toward the front. */
export function bringForward(items: ArrangeItem[], id: number | string): ArrangeItem[] {
  return swapZ(items, id, 1);
}

/** Move one step toward the back. */
export function sendBackward(items: ArrangeItem[], id: number | string): ArrangeItem[] {
  return swapZ(items, id, -1);
}

/** Move to the very front. */
export function bringToFront(items: ArrangeItem[], id: number | string): ArrangeItem[] {
  const ordered = byZ(items);
  const i = ordered.findIndex((it) => it.id === id);
  if (i < 0) return items;
  const [it] = ordered.splice(i, 1);
  ordered.push(it);
  return assignZ(ordered);
}

/** Move to the very back. */
export function sendToBack(items: ArrangeItem[], id: number | string): ArrangeItem[] {
  const ordered = byZ(items);
  const i = ordered.findIndex((it) => it.id === id);
  if (i < 0) return items;
  const [it] = ordered.splice(i, 1);
  ordered.unshift(it);
  return assignZ(ordered);
}

function selected(items: ArrangeItem[], ids: (number | string)[]): ArrangeItem[] {
  const set = new Set(ids);
  return items.filter((it) => set.has(it.id));
}

function mapSelected(
  items: ArrangeItem[],
  ids: (number | string)[],
  fn: (it: ArrangeItem, sel: ArrangeItem[]) => ArrangeItem,
): ArrangeItem[] {
  const sel = selected(items, ids);
  if (sel.length === 0) return items;
  return items.map((it) => (sel.some((s) => s.id === it.id) ? fn(it, sel) : it));
}

const minX = (s: ArrangeItem[]) => Math.min(...s.map((i) => i.x));
const maxR = (s: ArrangeItem[]) => Math.max(...s.map((i) => i.x + i.w));
const minY = (s: ArrangeItem[]) => Math.min(...s.map((i) => i.y));
const maxB = (s: ArrangeItem[]) => Math.max(...s.map((i) => i.y + i.h));

export function alignLeft(items: ArrangeItem[], ids: (number | string)[]): ArrangeItem[] {
  return mapSelected(items, ids, (it, sel) => ({ ...it, x: minX(sel) }));
}

export function alignCenterH(items: ArrangeItem[], ids: (number | string)[]): ArrangeItem[] {
  return mapSelected(items, ids, (it, sel) => {
    const c = (minX(sel) + maxR(sel)) / 2;
    return { ...it, x: c - it.w / 2 };
  });
}

export function alignRight(items: ArrangeItem[], ids: (number | string)[]): ArrangeItem[] {
  return mapSelected(items, ids, (it, sel) => ({ ...it, x: maxR(sel) - it.w }));
}

export function alignTop(items: ArrangeItem[], ids: (number | string)[]): ArrangeItem[] {
  return mapSelected(items, ids, (it, sel) => ({ ...it, y: minY(sel) }));
}

export function alignMiddleV(items: ArrangeItem[], ids: (number | string)[]): ArrangeItem[] {
  return mapSelected(items, ids, (it, sel) => {
    const c = (minY(sel) + maxB(sel)) / 2;
    return { ...it, y: c - it.h / 2 };
  });
}

export function alignBottom(items: ArrangeItem[], ids: (number | string)[]): ArrangeItem[] {
  return mapSelected(items, ids, (it, sel) => ({ ...it, y: maxB(sel) - it.h }));
}

/**
 * Distribute horizontally: equal gaps between items, keeping the two
 * outermost items fixed. Needs 3+ items.
 */
export function distributeHorizontally(items: ArrangeItem[], ids: (number | string)[]): ArrangeItem[] {
  const sel = [...selected(items, ids)].sort((a, b) => a.x - b.x);
  if (sel.length < 3) return items;
  const left = sel[0].x;
  const right = sel[sel.length - 1].x + sel[sel.length - 1].w;
  const totalW = sel.reduce((a, i) => a + i.w, 0);
  const gap = (right - left - totalW) / (sel.length - 1);
  const positions = new Map<number | string, number>();
  let x = left;
  for (const it of sel) {
    positions.set(it.id, x);
    x += it.w + gap;
  }
  return items.map((it) => (positions.has(it.id) ? { ...it, x: positions.get(it.id) as number } : it));
}

/** Distribute vertically: equal gaps, outermost items fixed. Needs 3+. */
export function distributeVertically(items: ArrangeItem[], ids: (number | string)[]): ArrangeItem[] {
  const sel = [...selected(items, ids)].sort((a, b) => a.y - b.y);
  if (sel.length < 3) return items;
  const top = sel[0].y;
  const bottom = sel[sel.length - 1].y + sel[sel.length - 1].h;
  const totalH = sel.reduce((a, i) => a + i.h, 0);
  const gap = (bottom - top - totalH) / (sel.length - 1);
  const positions = new Map<number | string, number>();
  let y = top;
  for (const it of sel) {
    positions.set(it.id, y);
    y += it.h + gap;
  }
  return items.map((it) => (positions.has(it.id) ? { ...it, y: positions.get(it.id) as number } : it));
}

/** Rotate 90° clockwise (rotation accumulates mod 360). */
export function rotate90(items: ArrangeItem[], id: number | string): ArrangeItem[] {
  return items.map((it) =>
    it.id === id ? { ...it, rotation: ((it.rotation ?? 0) + 90) % 360 } : it,
  );
}

/** Rotate 90° counter-clockwise. */
export function rotate270(items: ArrangeItem[], id: number | string): ArrangeItem[] {
  return items.map((it) =>
    it.id === id ? { ...it, rotation: ((it.rotation ?? 0) + 270) % 360 } : it,
  );
}

export function flipHorizontal(items: ArrangeItem[], id: number | string): ArrangeItem[] {
  return items.map((it) => (it.id === id ? { ...it, flipH: !it.flipH } : it));
}

export function flipVertical(items: ArrangeItem[], id: number | string): ArrangeItem[] {
  return items.map((it) => (it.id === id ? { ...it, flipV: !it.flipV } : it));
}

export function renameItem(items: ArrangeItem[], id: number | string, name: string): ArrangeItem[] {
  return items.map((it) => (it.id === id ? { ...it, name } : it));
}

export function toggleHidden(items: ArrangeItem[], id: number | string): ArrangeItem[] {
  return items.map((it) => (it.id === id ? { ...it, hidden: !it.hidden } : it));
}
