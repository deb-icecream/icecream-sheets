/**
 * Tests for text-to-columns helpers (Data tab).
 */
import { describe, expect, it } from 'vitest';
import { splitTextToColumns, detectDelimiter, TEXT_DELIMITERS } from './textColumns';

describe('splitTextToColumns', () => {
  it('splits on commas', () => {
    expect(splitTextToColumns(['a,b,c'], ',')).toEqual([['a', 'b', 'c']]);
  });

  it('splits on tabs', () => {
    expect(splitTextToColumns(['a\tb\tc'], '\t')).toEqual([['a', 'b', 'c']]);
  });

  it('splits on semicolons', () => {
    expect(splitTextToColumns(['a;b;c'], ';')).toEqual([['a', 'b', 'c']]);
  });

  it('splits on pipes', () => {
    expect(splitTextToColumns(['a|b|c'], '|')).toEqual([['a', 'b', 'c']]);
  });

  it('splits on whitespace runs for a bare space', () => {
    expect(splitTextToColumns(['a  b   c'], ' ')).toEqual([['a', 'b', 'c']]);
  });

  it('trims each cell', () => {
    expect(splitTextToColumns(['  a , b ,c  '], ',')).toEqual([['a', 'b', 'c']]);
  });

  it('handles multiple rows independently', () => {
    expect(splitTextToColumns(['a,b', 'c,d,e'], ',')).toEqual([
      ['a', 'b'],
      ['c', 'd', 'e'],
    ]);
  });

  it('keeps empty cells between delimiters', () => {
    expect(splitTextToColumns(['a,,c'], ',')).toEqual([['a', '', 'c']]);
  });

  it('returns one trimmed cell for an empty delimiter', () => {
    expect(splitTextToColumns(['  hello  '], '')).toEqual([['hello']]);
  });

  it('handles empty strings and empty input', () => {
    expect(splitTextToColumns([''], ',')).toEqual([['']]);
    expect(splitTextToColumns([], ',')).toEqual([]);
  });

  it('supports a custom multi-character delimiter', () => {
    expect(splitTextToColumns(['a::b::c'], '::')).toEqual([['a', 'b', 'c']]);
  });

  it('does not treat regex characters in the delimiter specially', () => {
    expect(splitTextToColumns(['a.b.c'], '.')).toEqual([['a', 'b', 'c']]);
  });
});

describe('detectDelimiter', () => {
  it('detects tabs', () => {
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
  });

  it('detects commas', () => {
    expect(detectDelimiter('a,b,c')).toBe(',');
  });

  it('detects semicolons', () => {
    expect(detectDelimiter('a;b;c')).toBe(';');
  });

  it('detects pipes', () => {
    expect(detectDelimiter('a|b|c')).toBe('|');
  });

  it('picks the most frequent candidate', () => {
    expect(detectDelimiter('a,b;c,d;e,f')).toBe(',');
  });

  it('resolves ties to the earliest candidate (tab first)', () => {
    expect(detectDelimiter('a\tb,c')).toBe('\t');
  });

  it('defaults to comma when nothing matches', () => {
    expect(detectDelimiter('abc')).toBe(',');
  });

  it('defaults to comma for an empty sample', () => {
    expect(detectDelimiter('')).toBe(',');
  });

  it('counts occurrences across the whole sample', () => {
    expect(detectDelimiter('a;b\nc;d\ne;f')).toBe(';');
  });
});

describe('TEXT_DELIMITERS', () => {
  it('lists the five supported delimiters', () => {
    expect([...TEXT_DELIMITERS]).toEqual(['\t', ',', ';', ' ', '|']);
  });
});
