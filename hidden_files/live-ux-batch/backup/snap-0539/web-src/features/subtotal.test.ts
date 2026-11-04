import { describe, expect, it } from 'vitest';
import { applySubtotal, rowVisible, stepOutlineLevel, visibleRows } from './subtotal';

const DATA = [
  ['Region', 'Sales'],
  ['East', '10'],
  ['West', '30'],
  ['East', '20'],
  ['West', '40'],
];

describe('applySubtotal', () => {
  it('groups, sorts, and emits subtotal + grand total rows', () => {
    const rows = applySubtotal(DATA, { groupCol: 0, valueCols: [1], fn: 'sum' });
    const labels = rows.map((r) => r.values[0]);
    expect(labels).toEqual(['Region', 'East', 'East', 'East Total', 'West', 'West', 'West Total', 'Grand Total']);
    expect(rows[3].values[1]).toBe('30');
    expect(rows[6].values[1]).toBe('70');
    expect(rows[7].values[1]).toBe('100');
  });
  it('tags outline levels correctly', () => {
    const rows = applySubtotal(DATA, { groupCol: 0, valueCols: [1], fn: 'count' });
    expect(rows[0].level).toBe(3); // header
    expect(rows.find((r) => r.values[0] === 'East Total')?.level).toBe(2);
    expect(rows.find((r) => r.values[0] === 'Grand Total')?.level).toBe(1);
  });
  it('supports average', () => {
    const rows = applySubtotal(DATA, { groupCol: 0, valueCols: [1], fn: 'average' });
    expect(rows.find((r) => r.values[0] === 'East Total')?.values[1]).toBe('15');
  });
  it('throws when no value columns', () => {
    expect(() => applySubtotal(DATA, { groupCol: 0, valueCols: [], fn: 'sum' })).toThrow();
  });
});

describe('outline levels', () => {
  const rows = applySubtotal(DATA, { groupCol: 0, valueCols: [1], fn: 'sum' });
  it('level 1 shows only grand total', () => {
    expect(visibleRows(rows, 1).map((r) => r.values[0])).toEqual(['Grand Total']);
  });
  it('level 2 shows subtotals + grand total', () => {
    expect(visibleRows(rows, 2).map((r) => r.values[0])).toEqual(['East Total', 'West Total', 'Grand Total']);
  });
  it('level 3 shows everything', () => {
    expect(visibleRows(rows, 3).length).toBe(rows.length);
  });
  it('rowVisible respects level', () => {
    expect(rowVisible(rows[1], 2)).toBe(false); // detail row at level 2
    expect(rowVisible(rows[1], 3)).toBe(true);
  });
  it('stepOutlineLevel clamps', () => {
    expect(stepOutlineLevel(1, -1)).toBe(1);
    expect(stepOutlineLevel(3, 1)).toBe(3);
    expect(stepOutlineLevel(2, 1)).toBe(3);
  });
});
