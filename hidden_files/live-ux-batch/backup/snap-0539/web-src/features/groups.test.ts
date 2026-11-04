/**
 * Tests for row/column outline groups (Data tab).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  makeGroup,
  toggleGroup,
  removeGroup,
  allocateGroupId,
  resetGroupIdCounter,
  isRowHiddenByGroup,
  isColHiddenByGroup,
  type Group,
} from './groups';

beforeEach(() => {
  resetGroupIdCounter();
});

const rows = (gs: Group[], sheet: string, row: number) => isRowHiddenByGroup(gs, sheet, row);
const cols = (gs: Group[], sheet: string, col: number) => isColHiddenByGroup(gs, sheet, col);

describe('makeGroup', () => {
  it('creates an expanded row group with an id from the counter', () => {
    const gs = makeGroup([], 'Sheet1', 'row', 2, 5);
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({ id: 1, sheet: 'Sheet1', axis: 'row', start: 2, end: 5, collapsed: false });
  });

  it('creates column groups with the col axis', () => {
    const gs = makeGroup([], 'Sheet1', 'col', 0, 3);
    expect(gs[0].axis).toBe('col');
  });

  it('allocates incrementing ids', () => {
    const gs = makeGroup(makeGroup([], 'S', 'row', 0, 1), 'S', 'row', 2, 3);
    expect(gs.map((g) => g.id)).toEqual([1, 2]);
  });

  it('normalizes reversed ranges', () => {
    const gs = makeGroup([], 'S', 'row', 5, 2);
    expect(gs[0].start).toBe(2);
    expect(gs[0].end).toBe(5);
  });

  it('does not mutate the input array', () => {
    const before: Group[] = [];
    const after = makeGroup(before, 'S', 'row', 0, 1);
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(1);
  });

  it('resetGroupIdCounter restarts ids', () => {
    makeGroup([], 'S', 'row', 0, 1);
    resetGroupIdCounter();
    const gs = makeGroup([], 'S', 'row', 0, 1);
    expect(gs[0].id).toBe(1);
  });

  it('allocateGroupId hands out ids consistent with makeGroup', () => {
    expect(allocateGroupId()).toBe(1);
    const gs = makeGroup([], 'S', 'row', 0, 1);
    expect(gs[0].id).toBe(2);
  });
});

describe('toggleGroup', () => {
  it('collapses then expands a group', () => {
    let gs = makeGroup([], 'S', 'row', 1, 4);
    gs = toggleGroup(gs, 1);
    expect(gs[0].collapsed).toBe(true);
    gs = toggleGroup(gs, 1);
    expect(gs[0].collapsed).toBe(false);
  });

  it('leaves other groups untouched', () => {
    let gs = makeGroup(makeGroup([], 'S', 'row', 0, 1), 'S', 'row', 2, 3);
    gs = toggleGroup(gs, 2);
    expect(gs[0].collapsed).toBe(false);
    expect(gs[1].collapsed).toBe(true);
  });

  it('is a no-op for unknown ids', () => {
    const gs = makeGroup([], 'S', 'row', 0, 1);
    expect(toggleGroup(gs, 99)).toEqual(gs);
  });

  it('does not mutate the input array', () => {
    const gs = makeGroup([], 'S', 'row', 0, 1);
    toggleGroup(gs, 1);
    expect(gs[0].collapsed).toBe(false);
  });
});

describe('removeGroup', () => {
  it('removes the group with the id', () => {
    let gs = makeGroup(makeGroup([], 'S', 'row', 0, 1), 'S', 'row', 2, 3);
    gs = removeGroup(gs, 1);
    expect(gs.map((g) => g.id)).toEqual([2]);
  });

  it('is a no-op for unknown ids', () => {
    const gs = makeGroup([], 'S', 'row', 0, 1);
    expect(removeGroup(gs, 42)).toHaveLength(1);
  });
});

describe('isRowHiddenByGroup', () => {
  it('hides rows inside a collapsed group', () => {
    let gs = makeGroup([], 'S', 'row', 2, 5);
    gs = toggleGroup(gs, 1);
    expect(rows(gs, 'S', 2)).toBe(true);
    expect(rows(gs, 'S', 4)).toBe(true);
    expect(rows(gs, 'S', 5)).toBe(true);
  });

  it('shows rows outside the group', () => {
    let gs = makeGroup([], 'S', 'row', 2, 5);
    gs = toggleGroup(gs, 1);
    expect(rows(gs, 'S', 1)).toBe(false);
    expect(rows(gs, 'S', 6)).toBe(false);
  });

  it('shows rows of an expanded group', () => {
    const gs = makeGroup([], 'S', 'row', 2, 5);
    expect(rows(gs, 'S', 3)).toBe(false);
  });

  it('ignores groups on other sheets', () => {
    let gs = makeGroup([], 'S1', 'row', 0, 9);
    gs = toggleGroup(gs, 1);
    expect(rows(gs, 'S2', 3)).toBe(false);
  });

  it('ignores column groups', () => {
    let gs = makeGroup([], 'S', 'col', 0, 9);
    gs = toggleGroup(gs, 1);
    expect(rows(gs, 'S', 3)).toBe(false);
  });
});

describe('isColHiddenByGroup', () => {
  it('hides cols inside a collapsed column group', () => {
    let gs = makeGroup([], 'S', 'col', 1, 3);
    gs = toggleGroup(gs, 1);
    expect(cols(gs, 'S', 1)).toBe(true);
    expect(cols(gs, 'S', 3)).toBe(true);
    expect(cols(gs, 'S', 0)).toBe(false);
    expect(cols(gs, 'S', 4)).toBe(false);
  });

  it('ignores row groups and other sheets', () => {
    let gs = makeGroup([], 'S', 'row', 0, 9);
    gs = toggleGroup(gs, 1);
    expect(cols(gs, 'S', 3)).toBe(false);
    let gs2 = makeGroup([], 'S1', 'col', 0, 9);
    gs2 = toggleGroup(gs2, 2);
    expect(cols(gs2, 'S2', 3)).toBe(false);
  });
});
