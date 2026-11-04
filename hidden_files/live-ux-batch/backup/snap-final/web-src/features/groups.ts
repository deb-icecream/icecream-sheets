/**
 * Row/column outline groups for the Data tab.
 *
 * A single Group interface covers both axes via `axis: 'row' | 'col'`.
 * All updates are immutable: helpers return new arrays.
 */

export interface Group {
  id: number;
  sheet: string;
  axis: 'row' | 'col';
  start: number;
  end: number;
  collapsed: boolean;
}

/** Module-level id counter for groups. Resettable for tests. */
let groupIdCounter = 1;

/** Allocate the next group id without creating a group. */
export function allocateGroupId(): number {
  return groupIdCounter++;
}

/** Reset the group id counter (useful in tests). */
export function resetGroupIdCounter(): void {
  groupIdCounter = 1;
}

/**
 * Append a new expanded group covering [start, end] (order-insensitive).
 * Returns a new array; the group id comes from the module counter.
 */
export function makeGroup(
  groups: Group[],
  sheet: string,
  axis: 'row' | 'col',
  start: number,
  end: number,
): Group[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return [
    ...groups,
    { id: groupIdCounter++, sheet, axis, start: lo, end: hi, collapsed: false },
  ];
}

/** Flip the collapsed flag of the group with `id`; no-op for unknown ids. */
export function toggleGroup(groups: Group[], id: number): Group[] {
  return groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g));
}

/** Remove the group with `id`; no-op for unknown ids. */
export function removeGroup(groups: Group[], id: number): Group[] {
  return groups.filter((g) => g.id !== id);
}

/** True when `row` on `sheet` falls inside a collapsed row group. */
export function isRowHiddenByGroup(groups: Group[], sheet: string, row: number): boolean {
  return groups.some(
    (g) =>
      g.axis === 'row' && g.sheet === sheet && g.collapsed && row >= g.start && row <= g.end,
  );
}

/** True when `col` on `sheet` falls inside a collapsed column group. */
export function isColHiddenByGroup(groups: Group[], sheet: string, col: number): boolean {
  return groups.some(
    (g) =>
      g.axis === 'col' && g.sheet === sheet && g.collapsed && col >= g.start && col <= g.end,
  );
}
