import { describe, expect, it } from 'vitest';
import {
  MAX_RECENT,
  __resetRecentForTests,
  clearRecentFunctions,
  getRecentFunctions,
  recordFunctionUse,
} from './recentFunctions';

describe('recent functions MRU', () => {
  it('records uses most-recent-first and dedupes', () => {
    __resetRecentForTests();
    clearRecentFunctions();
    recordFunctionUse('sum');
    recordFunctionUse('AVERAGE');
    recordFunctionUse('SUM');
    expect(getRecentFunctions()).toEqual(['SUM', 'AVERAGE']);
  });

  it('caps the list at MAX_RECENT', () => {
    __resetRecentForTests();
    clearRecentFunctions();
    for (let i = 0; i < MAX_RECENT + 5; i++) recordFunctionUse(`FN${i}`);
    const list = getRecentFunctions();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]).toBe(`FN${MAX_RECENT + 4}`);
  });

  it('ignores blank names', () => {
    __resetRecentForTests();
    clearRecentFunctions();
    recordFunctionUse('   ');
    expect(getRecentFunctions()).toEqual([]);
  });

  it('clear empties the list', () => {
    __resetRecentForTests();
    recordFunctionUse('SUM');
    clearRecentFunctions();
    expect(getRecentFunctions()).toEqual([]);
  });
});
