import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SETUP,
  PAGE_SETUP_METADATA_PREFIX,
  PAPER_SIZES,
  pageGrid,
  pageSetupFromMetadata,
  pageSetupToMetadata,
  type PageSetup,
} from './PrintLayout';
import type { PaginatedPage } from '@icecream-sheets/service';

const setup = (over: Partial<PageSetup> = {}): PageSetup => ({ ...DEFAULT_PAGE_SETUP, ...over });

const page = (over: Partial<PaginatedPage> = {}): PaginatedPage => ({
  sheet: 'S',
  pageNumber: 1,
  startRow: 5,
  endRow: 9,
  startCol: 2,
  endCol: 4,
  titleRows: null,
  titleCols: null,
  ...over,
});

describe('page setup metadata', () => {
  it('round-trips through metadata', () => {
    const s = setup({ orientation: 'landscape', scale: 85, printArea: 'A1:D20', header: 'H', footer: 'F' });
    expect(pageSetupFromMetadata(pageSetupToMetadata(s))).toEqual(s);
  });
  it('rejects corrupt metadata', () => {
    expect(pageSetupFromMetadata(null)).toBeNull();
    expect(pageSetupFromMetadata({})).toBeNull();
    expect(pageSetupFromMetadata({ orientation: 'diagonal' })).toBeNull();
  });
  it('metadata prefix is namespaced', () => {
    expect(PAGE_SETUP_METADATA_PREFIX).toBe('icecream.pagesetup.');
  });
  it('paper sizes are sane', () => {
    expect(PAPER_SIZES.letter.w).toBe(8.5);
    expect(PAPER_SIZES.a4.h).toBeGreaterThan(PAPER_SIZES.a4.w);
  });
  it('default setup matches the service defaults', () => {
    expect(DEFAULT_PAGE_SETUP).toMatchObject({
      orientation: 'portrait',
      paperSize: 'letter',
      scale: 100,
      printArea: null,
      header: '',
      footer: '',
    });
  });
});

describe('pageGrid', () => {
  it('renders the page bounds when there are no print titles', () => {
    const g = pageGrid(page());
    expect(g.rows).toEqual([5, 6, 7, 8, 9]);
    expect(g.cols).toEqual([2, 3, 4]);
    expect(g.isTitle(5, 2)).toBe(false);
    expect(g.isTitle(9, 4)).toBe(false);
  });

  it('prepends title rows and columns, flagged as titles', () => {
    const g = pageGrid(
      page({ titleRows: { startRow: 0, endRow: 1 }, titleCols: { startCol: 0, endCol: 0 } }),
    );
    expect(g.rows).toEqual([0, 1, 5, 6, 7, 8, 9]);
    expect(g.cols).toEqual([0, 2, 3, 4]);
    expect(g.isTitle(0, 2)).toBe(true);
    expect(g.isTitle(1, 4)).toBe(true);
    expect(g.isTitle(5, 0)).toBe(true);
    expect(g.isTitle(5, 2)).toBe(false);
    expect(g.isTitle(9, 4)).toBe(false);
  });
});
