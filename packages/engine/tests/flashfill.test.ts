import { describe, expect, it } from 'vitest';
import {
  analyzeFlashFill,
  analyzeFlashFillTwoCol,
  instantiateFormula,
} from '../src/index.js';

describe('analyzeFlashFill', () => {
  it('detects first-name extraction', () => {
    const p = analyzeFlashFill(
      ['John Smith', 'Jane Doe'],
      ['John', 'Jane'],
      ['Bob Jones'],
    );
    expect(p).not.toBeNull();
    expect(p!.pattern).toBe('before-first-space');
    expect(p!.values).toEqual(['Bob']);
    expect(p!.formulaTemplate).toContain('LEFT');
  });

  it('detects last-name extraction', () => {
    const p = analyzeFlashFill(['John Smith', 'Jane Doe'], ['Smith', 'Doe'], ['Bob Jones']);
    expect(p!.pattern).toBe('after-last-space');
    expect(p!.values).toEqual(['Jones']);
  });

  it('detects text after a comma delimiter', () => {
    const p = analyzeFlashFill(
      ['Smith, John', 'Doe, Jane'],
      ['John', 'Jane'],
      ['Jones, Bob'],
    );
    expect(p!.pattern).toBe('after-delimiter');
    expect(p!.values).toEqual(['Bob']);
  });

  it('detects UPPERCASE', () => {
    const p = analyzeFlashFill(['hello', 'world'], ['HELLO', 'WORLD'], ['test']);
    expect(p!.pattern).toBe('uppercase');
    expect(p!.values).toEqual(['TEST']);
    expect(p!.formulaTemplate).toBe('=UPPER({input})');
  });

  it('detects lowercase', () => {
    const p = analyzeFlashFill(['HELLO', 'WORLD'], ['hello', 'world'], ['TEST']);
    expect(p!.pattern).toBe('lowercase');
    expect(p!.values).toEqual(['test']);
  });

  it('detects Proper Case', () => {
    const p = analyzeFlashFill(['john smith', 'jane doe'], ['John Smith', 'Jane Doe'], ['bob jones']);
    expect(p!.pattern).toBe('proper');
    expect(p!.values).toEqual(['Bob Jones']);
  });

  it('detects digits-only extraction', () => {
    const p = analyzeFlashFill(
      ['(555) 123-4567', '(555) 987-6543'],
      ['5551234567', '5559876543'],
      ['(555) 000-1111'],
    );
    expect(p!.pattern).toBe('digits-only');
    expect(p!.values).toEqual(['5550001111']);
  });

  it('detects trim', () => {
    const p = analyzeFlashFill(['  John  ', '  Jane'], ['John', 'Jane'], ['  Bob   ']);
    expect(p!.pattern).toBe('trim');
    expect(p!.values).toEqual(['Bob']);
  });

  it('detects initials concatenation', () => {
    const p = analyzeFlashFill(
      ['John Smith', 'Jane Doe'],
      ['js', 'jd'],
      ['Bob Jones'],
    );
    expect(p).not.toBeNull();
    expect(p!.pattern).toBe('initials-concat');
    expect(p!.values).toEqual(['bj']);
  });

  it('returns null when no pattern explains the examples', () => {
    const p = analyzeFlashFill(['abc', 'def'], ['xyz', '123'], ['ghi']);
    expect(p).toBeNull();
  });

  it('returns null for empty examples', () => {
    expect(analyzeFlashFill([], [], ['x'])).toBeNull();
    expect(analyzeFlashFill(['a'], ['b'], ['c'])).toBeNull();
    // Matching pattern with no target rows -> empty proposal values.
    expect(analyzeFlashFill(['HELLO'], ['hello'], [])!.values).toEqual([]);
  });

  it('requires matching input/output counts', () => {
    expect(analyzeFlashFill(['a', 'b'], ['x'], ['c'])).toBeNull();
  });

  it('always reports confidence 1 and version', () => {
    const p = analyzeFlashFill(['HELLO'], ['hello'], ['WORLD']);
    expect(p!.confidence).toBe(1);
    expect(p!.version).toBe(1);
    expect(p!.description).toBeTruthy();
  });
});

describe('analyzeFlashFillTwoCol', () => {
  it('detects space-joined columns', () => {
    const p = analyzeFlashFillTwoCol(
      ['John', 'Jane'],
      ['Smith', 'Doe'],
      ['John Smith', 'Jane Doe'],
      ['Bob'],
      ['Jones'],
    );
    expect(p).not.toBeNull();
    expect(p!.values).toEqual(['Bob Jones']);
    expect(p!.formulaTemplate).toContain('CONCAT');
  });

  it('returns null on mismatch', () => {
    const p = analyzeFlashFillTwoCol(['a'], ['b'], ['zzz'], ['c'], ['d']);
    expect(p).toBeNull();
  });
});

describe('instantiateFormula', () => {
  it('substitutes the input reference', () => {
    expect(instantiateFormula('=UPPER({input})', 'A2')).toBe('=UPPER(A2)');
    expect(instantiateFormula('=LEFT({input},3)&{input}', 'B5')).toBe('=LEFT(B5,3)&B5');
  });
});
