/**
 * Print-titles plumbing: the Page Setup dialog's PrintTitles state must
 * flow into the service pagination engine (printTitleRows/Cols, repeated
 * on every page) and round-trip through adapter metadata.
 */
import { describe, expect, it } from 'vitest';
import { paginateSheet } from '@icecream-sheets/service';
import {
  DEFAULT_PRINT_TITLES,
  printTitlesFromMetadata,
  printTitlesToMetadata,
  toPrintPageSetup,
  type PrintTitles,
} from './PageSetupDialog';
import { DEFAULT_PAGE_SETUP } from './PrintLayout';

const titles = (rows: string, cols: string): PrintTitles => ({ rows, cols });
const snapshot = {
  sheet: 'Sheet1',
  used: { startRow: 0, endRow: 99, startCol: 0, endCol: 9 },
  rowHeight: () => 24,
  colWidth: () => 96,
};
const breaks = { rows: [], cols: [] };

describe('toPrintPageSetup', () => {
  it('maps blank titles to null (no titles)', () => {
    const s = toPrintPageSetup(DEFAULT_PAGE_SETUP, DEFAULT_PRINT_TITLES);
    expect(s.printTitleRows).toBeNull();
    expect(s.printTitleCols).toBeNull();
  });

  it('passes row/col title spans through to the pagination engine', () => {
    const s = toPrintPageSetup(DEFAULT_PAGE_SETUP, titles('1:2', 'A:B'));
    expect(s.printTitleRows).toBe('1:2');
    expect(s.printTitleCols).toBe('A:B');
  });

  it('trims whitespace and treats whitespace-only as no titles', () => {
    const s = toPrintPageSetup(DEFAULT_PAGE_SETUP, titles('  1:3  ', '   '));
    expect(s.printTitleRows).toBe('1:3');
    expect(s.printTitleCols).toBeNull();
  });

  it('copies the rest of the page setup unchanged', () => {
    const ps = { ...DEFAULT_PAGE_SETUP, orientation: 'landscape' as const, scale: 80 };
    const s = toPrintPageSetup(ps, DEFAULT_PRINT_TITLES);
    expect(s.orientation).toBe('landscape');
    expect(s.scale).toBe(80);
    expect(s.paperSize).toBe(DEFAULT_PAGE_SETUP.paperSize);
  });
});

describe('print titles end-to-end through paginateSheet', () => {
  it('repeats title rows on every paginated page', () => {
    const setup = toPrintPageSetup(DEFAULT_PAGE_SETUP, titles('1:2', ''));
    const pages = paginateSheet(snapshot, setup, breaks);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(p.titleRows).toEqual({ startRow: 0, endRow: 1 });
      expect(p.titleCols).toBeNull();
    }
    // Title rows are excluded from page content bands (no duplication).
    for (const p of pages) {
      expect(p.startRow).toBeGreaterThanOrEqual(2);
    }
  });

  it('repeats title columns on every paginated page', () => {
    const setup = toPrintPageSetup(DEFAULT_PAGE_SETUP, titles('', 'A:B'));
    const pages = paginateSheet(snapshot, setup, breaks);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      expect(p.titleCols).toEqual({ startCol: 0, endCol: 1 });
      expect(p.titleRows).toBeNull();
    }
  });

  it('no titles when the dialog state is blank', () => {
    const setup = toPrintPageSetup(DEFAULT_PAGE_SETUP, DEFAULT_PRINT_TITLES);
    const pages = paginateSheet(snapshot, setup, breaks);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      expect(p.titleRows).toBeNull();
      expect(p.titleCols).toBeNull();
    }
  });
});

describe('print titles metadata round-trip', () => {
  it('survives toMetadata/fromMetadata', () => {
    const t = titles('1:3', 'A:C');
    expect(printTitlesFromMetadata(printTitlesToMetadata(t))).toEqual(t);
  });

  it('rejects malformed metadata', () => {
    expect(printTitlesFromMetadata(null)).toBeNull();
    expect(printTitlesFromMetadata({ rows: '1:2' })).toBeNull();
    expect(printTitlesFromMetadata('nope')).toBeNull();
  });
});
