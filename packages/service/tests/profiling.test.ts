import { describe, expect, it } from 'vitest';
import { profileColumn, profileColumnSet, profileGrid } from '../src/index.js';

describe('profileColumn', () => {
  it('computes counts, unique, nulls and type distribution', () => {
    const p = profileColumn({
      name: 'A',
      values: [1, 2, 2, 'x', true, null, '', new Date('2024-01-02T00:00:00Z'), { error: '#DIV/0!' }],
    });
    expect(p.name).toBe('A');
    expect(p.count).toBe(7);
    expect(p.blankCount).toBe(2);
    expect(p.uniqueCount).toBe(6); // 1,2,'x',true,date,error
    expect(p.typeCounts).toEqual({ number: 3, text: 1, boolean: 1, date: 1, error: 1, blank: 2 });
  });

  it('computes numeric aggregates (min/max/mean/median/sample stddev)', () => {
    const p = profileColumn({ name: 'N', values: [2, 4, 4, 4, 5, 5, 7, 9] });
    expect(p.min).toBe(2);
    expect(p.max).toBe(9);
    expect(p.mean).toBe(5);
    expect(p.median).toBe(4.5);
    // Sample stddev of [2,4,4,4,5,5,7,9]: mean 5, SS=32, var=32/7 (Excel STDEV.S)
    expect(p.stddev).toBeCloseTo(2.138089935299395, 10);
  });

  it('returns null aggregates when there are no finite numbers', () => {
    const p = profileColumn({ name: 'T', values: ['a', 'b', null] });
    expect(p.min).toBeNull();
    expect(p.max).toBeNull();
    expect(p.mean).toBeNull();
    expect(p.median).toBeNull();
    expect(p.stddev).toBeNull();
  });

  it('excludes NaN/Infinity from aggregates but counts them as numbers', () => {
    const p = profileColumn({ name: 'N', values: [1, NaN, Infinity, 3] });
    expect(p.typeCounts.number).toBe(4);
    expect(p.min).toBe(1);
    expect(p.max).toBe(3);
    expect(p.mean).toBe(2);
  });

  it('single numeric value has null stddev (n-1 undefined)', () => {
    const p = profileColumn({ name: 'N', values: [42] });
    expect(p.mean).toBe(42);
    expect(p.stddev).toBeNull();
  });

  it('reports most-common values with deterministic ordering', () => {
    const p = profileColumn({ name: 'C', values: ['b', 'a', 'b', 'a', 'c', 'b', true, true, 7] });
    expect(p.mostCommon.slice(0, 3)).toEqual([
      { value: 'b', count: 3 },
      { value: 'TRUE', count: 2 },
      { value: 'a', count: 2 },
    ]);
    expect(p.mostCommon.length).toBeLessThanOrEqual(5);
  });

  it('distinguishes numbers from numeric strings for uniqueness', () => {
    const p = profileColumn({ name: 'M', values: [1, '1', 1.0] });
    expect(p.uniqueCount).toBe(2);
  });

  it('handles an empty column', () => {
    const p = profileColumn({ name: 'E', values: [] });
    expect(p.count).toBe(0);
    expect(p.uniqueCount).toBe(0);
    expect(p.mostCommon).toEqual([]);
    expect(p.mean).toBeNull();
  });

  it('respects topN', () => {
    const p = profileColumn({ name: 'C', values: ['a', 'b', 'c', 'a', 'b', 'a'] }, { topN: 2 });
    expect(p.mostCommon).toEqual([
      { value: 'a', count: 3 },
      { value: 'b', count: 2 },
    ]);
  });
});

describe('profileColumnSet / profileGrid', () => {
  it('profiles several columns at once', () => {
    const out = profileColumnSet([
      { name: 'X', values: [1, 2, 3] },
      { name: 'Y', values: ['a', 'a'] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].mean).toBe(2);
    expect(out[1].mostCommon).toEqual([{ value: 'a', count: 2 }]);
  });

  it('profileGrid maps headers to columns', () => {
    const out = profileGrid(['A', 'B'], [[1, 2], ['x']]);
    expect(out.map((p) => p.name)).toEqual(['A', 'B']);
    expect(out[0].count).toBe(2);
    expect(out[1].count).toBe(1);
  });
});
