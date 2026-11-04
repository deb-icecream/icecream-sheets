import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINT_SETUP,
  paginateSheet,
  parseA1Range,
  type PrintPageSetup,
  type PrintSnapshot,
} from '../src/pagination.js';

function snapshot(used: { startRow: number; endRow: number; startCol: number; endCol: number } | null): PrintSnapshot {
  return {
    sheet: 'Sheet1',
    used,
    rowHeight: () => 24,
    colWidth: () => 96,
  };
}

function setup(patch: Partial<PrintPageSetup> = {}): PrintPageSetup {
  return { ...DEFAULT_PRINT_SETUP, ...patch };
}

describe('paginateSheet', () => {
  it('returns no pages for an empty sheet', () => {
    expect(paginateSheet(snapshot(null), setup())).toEqual([]);
  });

  it('lays out uniform cells on letter portrait (7 cols x 38 rows per page)', () => {
    const pages = paginateSheet(
      snapshot({ startRow: 0, endRow: 99, startCol: 0, endCol: 19 }),
      setup(),
    );
    // Usable: (8.5-1.4)*96 = 681.6px → 7 cols; (11-1.5)*96/24 = 38 rows.
    expect(pages).toHaveLength(9);
    expect(pages[0]).toMatchObject({ pageNumber: 1, startRow: 0, endRow: 37, startCol: 0, endCol: 6 });
    // Default page order is down-then-over (Excel default).
    expect(pages[1]).toMatchObject({ pageNumber: 2, startRow: 38, endRow: 75, startCol: 0, endCol: 6 });
    expect(pages[3]).toMatchObject({ pageNumber: 4, startRow: 0, endRow: 37, startCol: 7, endCol: 13 });
    expect(pages[8]).toMatchObject({ pageNumber: 9, startRow: 76, endRow: 99, startCol: 14, endCol: 19 });
  });

  it('is deterministic: identical input → identical pages', () => {
    const snap = snapshot({ startRow: 0, endRow: 199, startCol: 0, endCol: 29 });
    const s = setup({ scale: 80, orientation: 'landscape', printTitleRows: '1:2' });
    const a = paginateSheet(snap, s, { rows: [10, 50], cols: [5] });
    const b = paginateSheet(snap, s, { rows: [50, 10], cols: [5, 5] }); // unsorted + dupes
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(paginateSheet(snap, s, { rows: [10, 50], cols: [5] })));
  });

  it('scaling 50% doubles page capacity', () => {
    const base = paginateSheet(snapshot({ startRow: 0, endRow: 99, startCol: 0, endCol: 19 }), setup());
    const half = paginateSheet(
      snapshot({ startRow: 0, endRow: 99, startCol: 0, endCol: 19 }),
      setup({ scale: 50 }),
    );
    expect(half.length).toBeLessThan(base.length);
    expect(half[0]).toMatchObject({ startRow: 0, endRow: 75, startCol: 0, endCol: 13 });
  });

  it('clamps scale to 10–400', () => {
    const lo = paginateSheet(snapshot({ startRow: 0, endRow: 10, startCol: 0, endCol: 2 }), setup({ scale: 1 }));
    const lo10 = paginateSheet(snapshot({ startRow: 0, endRow: 10, startCol: 0, endCol: 2 }), setup({ scale: 10 }));
    expect(lo).toEqual(lo10);
  });

  it('honors manual breaks: a row break forces a new band', () => {
    const pages = paginateSheet(
      snapshot({ startRow: 0, endRow: 20, startCol: 0, endCol: 3 }),
      setup(),
      { rows: [9], cols: [] },
    );
    // Without the break this would be one page (21 rows < 38); the manual
    // break splits it into two.
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ startRow: 0, endRow: 9 });
    expect(pages[1]).toMatchObject({ startRow: 10, endRow: 20 });
  });

  it('honors manual column breaks', () => {
    const pages = paginateSheet(
      snapshot({ startRow: 0, endRow: 5, startCol: 0, endCol: 10 }),
      setup(),
      { rows: [], cols: [4] },
    );
    // 11 cols auto-paginate as [0-6],[7-10]; the manual break after col 4
    // forces [0-4], and the remaining 6 cols still fit one band: [5-10].
    expect(pages.map((p) => [p.startCol, p.endCol])).toEqual([[0, 4], [5, 10]]);
  });

  it('repeats print-title rows on every page and reserves their height', () => {
    const pages = paginateSheet(
      snapshot({ startRow: 0, endRow: 79, startCol: 0, endCol: 3 }),
      setup({ printTitleRows: '1:2' }),
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      expect(p.titleRows).toEqual({ startRow: 0, endRow: 1 });
      expect(p.startRow).toBeGreaterThanOrEqual(2);
    }
    // 80 rows incl. 2 title rows; title height 48px reserved per page.
    expect(pages[0]).toMatchObject({ startRow: 2, endRow: 37 });
  });

  it('repeats print-title columns on every page', () => {
    const pages = paginateSheet(
      snapshot({ startRow: 0, endRow: 5, startCol: 0, endCol: 15 }),
      setup({ printTitleCols: 'A:B' }),
    );
    for (const p of pages) {
      expect(p.titleCols).toEqual({ startCol: 0, endCol: 1 });
      expect(p.startCol).toBeGreaterThanOrEqual(2);
    }
    // 14 content cols at 96px, minus 2 title cols (192px) from 681.6px usable.
    expect(pages[0]).toMatchObject({ startCol: 2, endCol: 6 });
  });

  it('intersects with the print area', () => {
    const pages = paginateSheet(
      snapshot({ startRow: 0, endRow: 99, startCol: 0, endCol: 19 }),
      setup({ printArea: 'A1:D20' }),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ startRow: 0, endRow: 19, startCol: 0, endCol: 3 });
  });

  it('ignores a malformed print area', () => {
    const pages = paginateSheet(
      snapshot({ startRow: 0, endRow: 5, startCol: 0, endCol: 3 }),
      setup({ printArea: 'not-a-range' }),
    );
    expect(pages).toHaveLength(1);
  });

  it('supports overDown page order', () => {
    const pages = paginateSheet(
      snapshot({ startRow: 0, endRow: 99, startCol: 0, endCol: 19 }),
      setup({ pageOrder: 'overDown' }),
    );
    expect(pages[1]).toMatchObject({ startRow: 0, endRow: 37, startCol: 7, endCol: 13 });
  });

  it('never splits a cell: an oversized column gets its own band', () => {
    const snap: PrintSnapshot = {
      sheet: 'S',
      used: { startRow: 0, endRow: 2, startCol: 0, endCol: 2 },
      rowHeight: () => 24,
      colWidth: (c) => (c === 1 ? 2000 : 96),
    };
    const pages = paginateSheet(snap, setup());
    expect(pages.map((p) => [p.startCol, p.endCol])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it('landscape swaps page dimensions', () => {
    const portrait = paginateSheet(
      snapshot({ startRow: 0, endRow: 200, startCol: 0, endCol: 200 }),
      setup({ orientation: 'portrait' }),
    );
    const landscape = paginateSheet(
      snapshot({ startRow: 0, endRow: 200, startCol: 0, endCol: 200 }),
      setup({ orientation: 'landscape' }),
    );
    expect(portrait.length).not.toBe(landscape.length);
    // Landscape fits more columns per page.
    expect(landscape[0].endCol).toBeGreaterThan(portrait[0].endCol);
  });
});

describe('parseA1Range', () => {
  it('parses A1:D20 and single cells', () => {
    expect(parseA1Range('A1:D20')).toEqual({ startRow: 0, endRow: 19, startCol: 0, endCol: 3 });
    expect(parseA1Range('B2')).toEqual({ startRow: 1, endRow: 1, startCol: 1, endCol: 1 });
    expect(parseA1Range('$A$1:$D$20')).toEqual({ startRow: 0, endRow: 19, startCol: 0, endCol: 3 });
  });

  it('returns null for malformed input', () => {
    expect(parseA1Range('nope')).toBeNull();
    expect(parseA1Range('A1:B2:C3')).toBeNull();
  });
});
