import { describe, expect, it } from 'vitest';
import {
  EMPTY_PAGE_BREAKS,
  hasPageBreaks,
  insertColBreak,
  insertRowBreak,
  pageBreaksFromMetadata,
  pageBreaksMetadataKey,
  pageBreaksToMetadata,
  removeColBreak,
  removeRowBreak,
  resetPageBreaks,
} from './pageBreaks';
import { DEFAULT_PAGE_SETUP } from '../components/PrintLayout';
import { DEFAULT_PRINT_TITLES, toPrintPageSetup } from '../components/PageSetupDialog';
import { paginateSheet, type PrintSnapshot } from '@icecream-sheets/service';

describe('page break model', () => {
  it('inserts and removes row breaks, keeping them sorted and unique', () => {
    let b = EMPTY_PAGE_BREAKS;
    b = insertRowBreak(b, 20);
    b = insertRowBreak(b, 5);
    b = insertRowBreak(b, 20);
    expect(b.rows).toEqual([5, 20]);
    b = removeRowBreak(b, 5);
    expect(b.rows).toEqual([20]);
  });

  it('inserts and removes column breaks', () => {
    let b = insertColBreak(EMPTY_PAGE_BREAKS, 3);
    b = insertColBreak(b, 1);
    expect(b.cols).toEqual([1, 3]);
    b = removeColBreak(b, 1);
    expect(b.cols).toEqual([3]);
  });

  it('rejects negative and non-integer breaks', () => {
    const b = insertRowBreak(insertColBreak(EMPTY_PAGE_BREAKS, -2), 2.5);
    expect(b.rows).toEqual([]);
    expect(b.cols).toEqual([]);
  });

  it('reset clears everything', () => {
    const b = resetPageBreaks();
    expect(hasPageBreaks(b)).toBe(false);
    expect(hasPageBreaks(insertRowBreak(b, 4))).toBe(true);
  });

  it('round-trips through metadata and uses a per-sheet key', () => {
    const b = insertColBreak(insertRowBreak(EMPTY_PAGE_BREAKS, 9), 2);
    expect(pageBreaksFromMetadata(pageBreaksToMetadata(b))).toEqual(b);
    expect(pageBreaksMetadataKey('Sheet1')).toBe('icecream.pagebreaks.Sheet1');
    expect(pageBreaksFromMetadata(null)).toEqual(EMPTY_PAGE_BREAKS);
    expect(pageBreaksFromMetadata({ rows: 'x', cols: [1] })).toEqual({ rows: [], cols: [1] });
  });
});

describe('breaks through the service pagination engine', () => {
  // The client-side paginateWithBreaks fork was removed (design
  // print-and-page-layout.md §4): manual breaks flow into paginateSheet,
  // the same engine the print preview and Download-as-PDF use.
  const snapshot = (used: PrintSnapshot['used']): PrintSnapshot => ({
    sheet: 'Sheet1',
    used,
    rowHeight: () => 24,
    colWidth: () => 96,
  });
  const setup = toPrintPageSetup(DEFAULT_PAGE_SETUP, DEFAULT_PRINT_TITLES);
  const used = { startRow: 0, endRow: 99, startCol: 0, endCol: 19 };

  it('matches plain pagination when there are no breaks', () => {
    expect(paginateSheet(snapshot(used), setup, EMPTY_PAGE_BREAKS)).toEqual(
      paginateSheet(snapshot(used), setup),
    );
  });

  it('splits pages along manual breaks and renumbers', () => {
    const breaks = insertColBreak(insertRowBreak(EMPTY_PAGE_BREAKS, 49), 9);
    const pages = paginateSheet(snapshot(used), setup, breaks);
    // Every page boundary must respect the breaks: no page may span row 49/50 or col 9/10.
    for (const p of pages) {
      expect(p.startRow > 49 || p.endRow < 50).toBe(true);
      expect(p.startCol > 9 || p.endCol < 10).toBe(true);
    }
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((p, i) => expect(p.pageNumber).toBe(i + 1));
    // Full coverage: union of pages covers the used range exactly once per cell.
    const seen = new Set<string>();
    for (const p of pages) {
      for (let r = p.startRow; r <= p.endRow; r++) {
        for (let c = p.startCol; c <= p.endCol; c++) {
          const k = `${r},${c}`;
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }
    }
    expect(seen.size).toBe(100 * 20);
  });
});
