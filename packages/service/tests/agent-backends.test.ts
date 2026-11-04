/**
 * Tests for the cell-reference parsers (parseA1Cell, parseRangeRef).
 * The heuristic planner these tests once covered was DELETED (#137,
 * owner ruling 2026-10-25); its planning tests went with it.
 */
import { describe, expect, it } from 'vitest';
import { colLettersToIndex, parseA1Cell, parseRangeRef } from '../src/agent/backends.js';

describe('A1 parsing', () => {
  it('colLettersToIndex', () => {
    expect(colLettersToIndex('A')).toBe(0);
    expect(colLettersToIndex('Z')).toBe(25);
    expect(colLettersToIndex('AA')).toBe(26);
    expect(colLettersToIndex('a')).toBe(0);
  });

  it('parseA1Cell', () => {
    expect(parseA1Cell('A1')).toEqual({ row: 0, col: 0 });
    expect(parseA1Cell('B3')).toEqual({ row: 2, col: 1 });
    expect(parseA1Cell('AA10')).toEqual({ row: 9, col: 26 });
    expect(() => parseA1Cell('nope')).toThrow();
  });

  it('parseRangeRef', () => {
    expect(parseRangeRef('A1:B2')).toMatchObject({
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
    });
    expect(parseRangeRef('Data!C3')).toMatchObject({ sheet: 'Data', startRow: 2, startCol: 2 });
    expect(parseRangeRef('D4')).toMatchObject({ startRow: 3, startCol: 3, endRow: 3, endCol: 3 });
    expect(parseRangeRef('hello world')).toBeNull();
  });

  it('parseRangeRef defaults bare refs to the active sheet when given (#135)', () => {
    expect(parseRangeRef('A1:B2', 'FMTs')).toMatchObject({ sheet: 'FMTs' });
    expect(parseRangeRef('Data!C3', 'FMTs')).toMatchObject({ sheet: 'Data' });
    expect(parseRangeRef('A1:B2')).toMatchObject({ sheet: 'Sheet1' });
  });
});
