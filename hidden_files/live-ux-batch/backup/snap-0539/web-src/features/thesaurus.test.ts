import { describe, expect, it } from 'vitest';
import { lookupThesaurus, thesaurusHeadwords, thesaurusSize } from './thesaurus';

describe('thesaurus', () => {
  it('finds synonyms for a common word', () => {
    const e = lookupThesaurus('increase');
    expect(e?.synonyms).toContain('raise');
    expect(e?.antonyms).toContain('decrease');
  });
  it('is case-insensitive', () => {
    expect(lookupThesaurus('Happy')?.synonyms).toContain('glad');
  });
  it('matches plural forms', () => {
    expect(lookupThesaurus('profits')?.synonyms).toContain('gain');
  });
  it('returns undefined for unknown words', () => {
    expect(lookupThesaurus('xylophonezz')).toBeUndefined();
  });
  it('has a sizable bundled list', () => {
    expect(thesaurusSize()).toBeGreaterThan(100);
    expect(thesaurusHeadwords()).toContain('forecast');
  });
});
