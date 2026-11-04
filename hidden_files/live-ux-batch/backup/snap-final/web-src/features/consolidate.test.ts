import { describe, expect, it } from 'vitest';
import { consolidate, aggregateCells } from './consolidate';

describe('aggregateCells', () => {
  it('sums numerics and ignores text', () => {
    expect(aggregateCells(['1', 'x', '2'], 'sum')).toBe('3');
  });
  it('counts numeric entries', () => {
    expect(aggregateCells(['1', 'x', ''], 'count')).toBe('1');
  });
  it('averages', () => {
    expect(aggregateCells(['2', '4'], 'average')).toBe('3');
  });
  it('returns blank for max/min with no numbers', () => {
    expect(aggregateCells(['x'], 'max')).toBe('');
  });
});

describe('consolidate by position', () => {
  const a = [['1', '2'], ['3', '4']];
  const b = [['10', '20'], ['30', '40']];
  it('sums element-wise', () => {
    expect(consolidate([a, b], 'sum', 'position')).toEqual([['11', '22'], ['33', '44']]);
  });
  it('takes max element-wise', () => {
    expect(consolidate([a, b], 'max', 'position')).toEqual([['10', '20'], ['30', '40']]);
  });
  it('rejects mismatched row counts', () => {
    expect(() => consolidate([a, [['1']]], 'sum', 'position')).toThrow();
  });
});

describe('consolidate by labels', () => {
  const q1 = [['', 'Jan', 'Feb'], ['East', '1', '2'], ['West', '3', '4']];
  const q2 = [['', 'Feb', 'Mar'], ['West', '30', '40'], ['East', '10', '20']];
  it('aligns on the union of labels', () => {
    const out = consolidate([q1, q2], 'sum', 'labels');
    expect(out[0]).toEqual(['', 'Jan', 'Feb', 'Mar']);
    expect(out[1]).toEqual(['East', '1', '12', '20']);
    expect(out[2]).toEqual(['West', '3', '34', '40']);
  });
  it('counts entries per label cell', () => {
    const out = consolidate([q1, q2], 'count', 'labels');
    expect(out[1][2]).toBe('2'); // East/Feb appears in both
    expect(out[1][1]).toBe('1'); // East/Jan only in q1
  });
});
