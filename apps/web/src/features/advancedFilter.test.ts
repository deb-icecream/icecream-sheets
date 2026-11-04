import { describe, expect, it } from 'vitest';
import { applyAdvancedFilter } from './advancedFilter';

const DATA = [
  ['Name', 'Age', 'City'],
  ['Alice', '30', 'NYC'],
  ['Bob', '25', 'LA'],
  ['Cara', '35', 'NYC'],
  ['Dan', '25', 'SF'],
];

describe('applyAdvancedFilter', () => {
  it('ANDs criteria within a row', () => {
    const out = applyAdvancedFilter(DATA, [['City', 'Age'], ['NYC', '>28']], { uniqueOnly: false });
    expect(out.slice(1).map((r) => r[0])).toEqual(['Alice', 'Cara']);
  });
  it('ORs across criteria rows', () => {
    const out = applyAdvancedFilter(DATA, [['City'], ['NYC'], ['LA']], { uniqueOnly: false });
    expect(out.slice(1).map((r) => r[0])).toEqual(['Alice', 'Bob', 'Cara']);
  });
  it('supports wildcards and case-insensitive match', () => {
    const out = applyAdvancedFilter(DATA, [['Name'], ['a*']], { uniqueOnly: false });
    expect(out.slice(1).map((r) => r[0])).toEqual(['Alice']);
  });
  it('supports <> operator', () => {
    const out = applyAdvancedFilter(DATA, [['Age'], ['<>25']], { uniqueOnly: false });
    expect(out.slice(1).map((r) => r[0])).toEqual(['Alice', 'Cara']);
  });
  it('ignores criteria columns with blank headers', () => {
    const out = applyAdvancedFilter(DATA, [['', 'Age'], ['zzz', '25']], { uniqueOnly: false });
    expect(out.slice(1).map((r) => r[0])).toEqual(['Bob', 'Dan']);
  });
  it('blank criteria row matches everything', () => {
    const out = applyAdvancedFilter(DATA, [['City'], ['']], { uniqueOnly: false });
    expect(out.length).toBe(5);
  });
  it('uniqueOnly dedupes identical rows', () => {
    const dup = [...DATA, ['Bob', '25', 'LA']];
    const out = applyAdvancedFilter(dup, [['Age'], ['25']], { uniqueOnly: true });
    expect(out.slice(1).map((r) => r[0])).toEqual(['Bob', 'Dan']);
  });
  it('returns header only when nothing matches', () => {
    const out = applyAdvancedFilter(DATA, [['City'], ['ZZZ']], { uniqueOnly: false });
    expect(out).toEqual([['Name', 'Age', 'City']]);
  });
});
