import { describe, expect, it } from 'vitest';
import {
  HEADER_FOOTER_VERSION,
  defaultHeaderFooter,
  emptyHFSection,
  expandHFCodes,
  isHFEmpty,
  renderHFSectionPreview,
  sectionForPage,
  validateHeaderFooter,
  type HFRenderContext,
} from '../src/index.js';

const ctx: HFRenderContext = {
  page: 3,
  pages: 12,
  date: new Date(2026, 9, 18, 14, 5), // 2026-10-18 14:05 local
  fileName: 'budget.xlsx',
  sheetName: 'Summary',
};

describe('expandHFCodes', () => {
  it('expands &P &N &D &T &F &A', () => {
    expect(expandHFCodes('Page &P of &N', ctx)).toBe('Page 3 of 12');
    expect(expandHFCodes('&D', ctx)).toBe('2026-10-18');
    expect(expandHFCodes('&T', ctx)).toBe('14:05');
    expect(expandHFCodes('&F', ctx)).toBe('budget.xlsx');
    expect(expandHFCodes('&A', ctx)).toBe('Summary');
  });

  it('renders && as a literal ampersand', () => {
    expect(expandHFCodes('R&&D', ctx)).toBe('R&D');
    expect(expandHFCodes('&&P', ctx)).toBe('&P');
  });

  it('strips formatting codes and leaves unknown codes verbatim', () => {
    expect(expandHFCodes('&"Arial,Bold"&14&BTitle&I&U', ctx)).toBe('Title');
    expect(expandHFCodes('&X&Y&Ssub', ctx)).toBe('sub');
    expect(expandHFCodes('&Z &P', ctx)).toBe('&Z 3');
  });

  it('handles a trailing lone &', () => {
    expect(expandHFCodes('end&', ctx)).toBe('end&');
  });

  it('leaves plain text untouched', () => {
    expect(expandHFCodes('Confidential', ctx)).toBe('Confidential');
  });
});

describe('header/footer model', () => {
  it('defaults to empty and validates clean', () => {
    const s = defaultHeaderFooter();
    expect(s.version).toBe(HEADER_FOOTER_VERSION);
    expect(isHFEmpty(s)).toBe(true);
    expect(validateHeaderFooter(s)).toEqual([]);
    expect(emptyHFSection()).toEqual({ left: '', center: '', right: '' });
  });

  it('detects non-empty settings', () => {
    const s = defaultHeaderFooter();
    s.footer.center = 'Page &P of &N';
    expect(isHFEmpty(s)).toBe(false);
  });

  it('flags a bad version', () => {
    const s = { ...defaultHeaderFooter(), version: 99 as never };
    expect(validateHeaderFooter(s).length).toBeGreaterThan(0);
  });

  it('sectionForPage honors different-first and different-odd-even', () => {
    const s = defaultHeaderFooter();
    s.header = { left: 'odd', center: '', right: '' };
    s.differentOddEven = true;
    s.evenHeader = { left: 'even', center: '', right: '' };
    s.differentFirst = true;
    s.firstHeader = { left: 'first', center: '', right: '' };
    expect(sectionForPage(s, 'header', 1).left).toBe('first');
    expect(sectionForPage(s, 'header', 2).left).toBe('even');
    expect(sectionForPage(s, 'header', 3).left).toBe('odd');
  });

  it('renderHFSectionPreview joins and expands sections', () => {
    const s = defaultHeaderFooter();
    s.footer = { left: '&F', center: 'Page &P of &N', right: '' };
    expect(renderHFSectionPreview(s.footer, ctx)).toBe('budget.xlsx | Page 3 of 12');
  });
});
