/**
 * Tests for the built-in spell checker (Review tab).
 */
import { describe, expect, it } from 'vitest';
import { isCorrect, checkText, suggest, wordListSize } from './spelling';

describe('word list', () => {
  it('holds at least 200 words', () => {
    expect(wordListSize()).toBeGreaterThanOrEqual(200);
  });

  it('includes months, days and number words', () => {
    for (const w of ['january', 'february', 'december', 'monday', 'friday', 'twenty', 'hundred', 'thousand']) {
      expect(isCorrect(w)).toBe(true);
    }
  });
});

describe('isCorrect', () => {
  it('accepts common words', () => {
    for (const w of ['the', 'quick', 'brown', 'fox', 'hello', 'world', 'spreadsheet', 'formula']) {
      expect(isCorrect(w)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isCorrect('The')).toBe(true);
    expect(isCorrect('Hello')).toBe(true);
    expect(isCorrect('XYZZY')).toBe(false); // 5 letters: not an acronym, not in list
  });

  it('rejects misspellings', () => {
    expect(isCorrect('teh')).toBe(false);
    expect(isCorrect('recieve')).toBe(false);
    expect(isCorrect('xyzzy')).toBe(false);
  });

  it('ignores words containing digits', () => {
    expect(isCorrect('abc123')).toBe(true);
    expect(isCorrect('q2')).toBe(true);
  });

  it('ignores single letters', () => {
    expect(isCorrect('a')).toBe(true);
    expect(isCorrect('I')).toBe(true);
    expect(isCorrect('x')).toBe(true);
  });

  it('ignores ALL-CAPS acronyms of length <= 4', () => {
    expect(isCorrect('NASA')).toBe(true);
    expect(isCorrect('CEO')).toBe(true);
    expect(isCorrect('TV')).toBe(true);
  });

  it('does not ignore long ALL-CAPS words', () => {
    expect(isCorrect('UNESCO')).toBe(false);
    expect(isCorrect('XYZZY')).toBe(false);
  });

  it('treats the empty string as correct', () => {
    expect(isCorrect('')).toBe(true);
  });
});

describe('checkText', () => {
  it('returns no misspellings for clean text', () => {
    expect(checkText('The quick brown fox')).toEqual([]);
  });

  it('finds misspellings with their offsets', () => {
    const found = checkText('teh cat sat');
    expect(found).toEqual([{ word: 'teh', index: 0 }]);
  });

  it('finds multiple misspellings', () => {
    const found = checkText('teh recieve xyzzy');
    expect(found.map((m) => m.word)).toEqual(['teh', 'recieve', 'xyzzy']);
    expect(found[1].index).toBe(4);
    expect(found[2].index).toBe(12);
  });

  it('tokenizes on non-letters', () => {
    const found = checkText('well-known, top-rate!');
    expect(found.map((m) => m.word)).toEqual([]);
  });

  it('skips numbers, single letters and acronyms', () => {
    expect(checkText('a b c 123 NASA Q1')).toEqual([]);
  });

  it('handles empty text', () => {
    expect(checkText('')).toEqual([]);
  });
});

describe('suggest', () => {
  it('suggests "the" for "teh" (transposition)', () => {
    expect(suggest('teh')).toContain('the');
  });

  it('suggests "receive" for "recieve" (transposition)', () => {
    expect(suggest('recieve')).toContain('receive');
  });

  it('suggests via deletion', () => {
    expect(suggest('thee')).toContain('the');
  });

  it('suggests via substitution', () => {
    expect(suggest('wrold')).toContain('world');
  });

  it('returns at most 3 suggestions', () => {
    const s = suggest('te');
    expect(s.length).toBeLessThanOrEqual(3);
  });

  it('returns an empty array for gibberish', () => {
    expect(suggest('zzzqxj')).toEqual([]);
  });

  it('returns an empty array for very long words', () => {
    expect(suggest('supercalifragilisticexpialidocious')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(suggest('Teh')).toContain('the');
  });
});
