import { describe, it, expect } from 'vitest';
import { EngineWorkbook } from '../src/index.js';

describe('AGGREGATE function_num 16-19', () => {
  it('PERCENTILE.INC (16) with k', () => {
    const wb = new EngineWorkbook({
      S1: [
        [1, 2, 3, 4, 5],
        ['=AGGREGATE(16,0,A1:E1,0.5)'], // median of 1..5 = 3
      ],
    });
    const v = wb.getValue({ sheet: 'S1', row: 1, col: 0 });
    expect(v.kind).toBe('number');
    if (v.kind === 'number') expect(v.value).toBeCloseTo(3, 10);
  });

  it('QUARTILE.INC (17)', () => {
    const wb = new EngineWorkbook({
      S1: [
        [1, 2, 3, 4],
        ['=AGGREGATE(17,0,A1:D1,1)'], // Q1 of 1..4 = 1.75
      ],
    });
    const v = wb.getValue({ sheet: 'S1', row: 1, col: 0 });
    expect(v.kind).toBe('number');
    if (v.kind === 'number') expect(v.value).toBeCloseTo(1.75, 10);
  });

  it('LARGE (14) with k', () => {
    const wb = new EngineWorkbook({
      S1: [
        [1, 5, 3],
        ['=AGGREGATE(14,0,A1:C1,2)'], // 2nd largest = 3
      ],
    });
    const v = wb.getValue({ sheet: 'S1', row: 1, col: 0 });
    expect(v.kind).toBe('number');
    if (v.kind === 'number') expect(v.value).toBe(3);
  });

  it('SMALL (15) with k', () => {
    const wb = new EngineWorkbook({
      S1: [
        [1, 5, 3],
        ['=AGGREGATE(15,0,A1:C1,2)'], // 2nd smallest = 3
      ],
    });
    const v = wb.getValue({ sheet: 'S1', row: 1, col: 0 });
    expect(v.kind).toBe('number');
    if (v.kind === 'number') expect(v.value).toBe(3);
  });
});
