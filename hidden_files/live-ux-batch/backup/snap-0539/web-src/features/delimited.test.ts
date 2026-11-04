import { describe, expect, it } from 'vitest';
import { parseDelimited, detectDelimiter, delimitedToGrid } from './delimited';

describe('parseDelimited', () => {
  it('parses tab-delimited text', () => {
    const t = parseDelimited('a\tb\n1\t2', '\t');
    expect(t.headers).toEqual(['a', 'b']);
    expect(t.rows).toEqual([['1', '2']]);
  });
  it('parses semicolons and respects quotes', () => {
    const t = parseDelimited('a;b\n"x;y";2', ';');
    expect(t.rows[0]).toEqual(['x;y', '2']);
  });
  it('pads short rows to the header width', () => {
    const t = parseDelimited('a,b,c\n1,2', ',');
    expect(t.rows[0]).toEqual(['1', '2', '']);
  });
  it('returns empty table for blank input', () => {
    expect(parseDelimited('   \n', ',')).toEqual({ headers: [], rows: [] });
  });
});

describe('detectDelimiter', () => {
  it('detects tabs', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
  it('detects semicolons', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });
  it('defaults to comma', () => {
    expect(detectDelimiter('a,b\n1,2')).toBe(',');
  });
});

describe('delimitedToGrid', () => {
  it('keeps header row when firstRowIsHeader', () => {
    const g = delimitedToGrid({ headers: ['a'], rows: [['1']] }, true);
    expect(g).toEqual([['a'], ['1']]);
  });
  it('synthesizes headers when not', () => {
    const g = delimitedToGrid({ headers: ['a'], rows: [['1']] }, false);
    expect(g).toEqual([['Column1'], ['a'], ['1']]);
  });
});
