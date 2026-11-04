/**
 * Unit tests for the header/footer model.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultHeaderFooter,
  emptySection,
  isHFEmpty,
  renderHFSection,
  renderHFText,
  type HFRenderContext,
} from './headerFooter';

const CTX: HFRenderContext = {
  page: 3,
  pages: 12,
  date: new Date(2026, 9, 18, 14, 5),
  fileName: 'budget.xlsx',
  sheetName: 'Sheet1',
};

describe('renderHFText', () => {
  it('expands page codes', () => {
    expect(renderHFText('Page &P of &N', CTX)).toBe('Page 3 of 12');
  });

  it('expands date and time', () => {
    expect(renderHFText('&D &T', CTX)).toBe('2026-10-18 14:05');
  });

  it('expands file and sheet names', () => {
    expect(renderHFText('&F — &A', CTX)).toBe('budget.xlsx — Sheet1');
  });

  it('renders && as a literal ampersand', () => {
    expect(renderHFText('R&&D', CTX)).toBe('R&D');
  });

  it('leaves unknown codes alone', () => {
    expect(renderHFText('&Q &', CTX)).toBe('&Q &');
  });

  it('handles trailing &', () => {
    expect(renderHFText('end&', CTX)).toBe('end&');
  });
});

describe('renderHFSection', () => {
  it('joins non-empty parts', () => {
    expect(renderHFSection({ left: '&D', center: 'Title', right: 'Page &P' }, CTX)).toBe(
      '2026-10-18 | Title | Page 3',
    );
  });

  it('skips empty parts', () => {
    expect(renderHFSection({ left: '', center: 'Only', right: '' }, CTX)).toBe('Only');
  });
});

describe('isHFEmpty', () => {
  it('is true for defaults', () => {
    expect(isHFEmpty(defaultHeaderFooter())).toBe(true);
  });

  it('is false when any text is set', () => {
    const s = defaultHeaderFooter();
    s.footer.center = 'Page &P';
    expect(isHFEmpty(s)).toBe(false);
  });
});

describe('emptySection', () => {
  it('returns blank parts', () => {
    expect(emptySection()).toEqual({ left: '', center: '', right: '' });
  });
});
