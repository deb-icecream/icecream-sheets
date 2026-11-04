/**
 * Unit tests for the symbol picker data.
 */
import { describe, expect, it } from 'vitest';
import { allSymbols, searchSymbols, SYMBOL_CATEGORIES } from './symbols';

describe('SYMBOL_CATEGORIES', () => {
  it('has the expected categories', () => {
    expect(SYMBOL_CATEGORIES.map((c) => c.id)).toEqual(['greek', 'math', 'arrows', 'currency', 'misc']);
  });

  it('has no empty categories and no duplicates within a category', () => {
    for (const c of SYMBOL_CATEGORIES) {
      expect(c.symbols.length).toBeGreaterThan(0);
      expect(new Set(c.symbols).size).toBe(c.symbols.length);
    }
  });

  it('covers both greek cases', () => {
    const greek = SYMBOL_CATEGORIES.find((c) => c.id === 'greek')!.symbols;
    expect(greek).toContain('Ω');
    expect(greek).toContain('ω');
  });
});

describe('allSymbols', () => {
  it('flattens with category labels', () => {
    const all = allSymbols();
    expect(all.length).toBeGreaterThan(100);
    expect(all.find((s) => s.symbol === '∑')?.category).toBe('Math');
  });
});

describe('searchSymbols', () => {
  it('returns everything for an empty query', () => {
    expect(searchSymbols('').length).toBe(allSymbols().length);
  });

  it('finds a pasted symbol', () => {
    const found = searchSymbols('€');
    expect(found.some((s) => s.symbol === '€')).toBe(true);
  });

  it('matches category names', () => {
    const found = searchSymbols('greek');
    expect(found.length).toBeGreaterThan(20);
    expect(found.every((s) => s.category === 'Greek')).toBe(true);
  });
});
