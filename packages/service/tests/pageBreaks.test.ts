import { describe, expect, it } from 'vitest';
import {
  EMPTY_PAGE_BREAKS,
  hasPageBreaks,
  insertColBreak,
  insertRowBreak,
  pageBreaksFromMetadata,
  pageBreaksMetadataKey,
  pageBreaksToMetadata,
  PAGE_BREAKS_METADATA_PREFIX,
  removeColBreak,
  removeRowBreak,
  resetPageBreaks,
} from '../src/pageBreaks.js';

describe('pageBreaks model', () => {
  it('inserts row breaks sorted, unique and idempotent', () => {
    const b = insertRowBreak(insertRowBreak(insertRowBreak(EMPTY_PAGE_BREAKS, 9), 3), 9);
    expect(b.rows).toEqual([3, 9]);
    expect(b.cols).toEqual([]);
  });

  it('inserts column breaks sorted and unique', () => {
    const b = insertColBreak(insertColBreak(EMPTY_PAGE_BREAKS, 7), 2);
    expect(b.cols).toEqual([2, 7]);
  });

  it('rejects negative and non-integer breaks', () => {
    const b = insertRowBreak(insertRowBreak(EMPTY_PAGE_BREAKS, -1), 2.5);
    expect(b.rows).toEqual([]);
  });

  it('removes breaks (no-op when absent)', () => {
    const b = insertRowBreak(EMPTY_PAGE_BREAKS, 4);
    expect(removeRowBreak(b, 4).rows).toEqual([]);
    expect(removeRowBreak(b, 99).rows).toEqual([4]);
  });

  it('removes column breaks', () => {
    const b = insertColBreak(EMPTY_PAGE_BREAKS, 1);
    expect(removeColBreak(b, 1).cols).toEqual([]);
  });

  it('resetPageBreaks clears everything', () => {
    const b = insertColBreak(insertRowBreak(EMPTY_PAGE_BREAKS, 1), 2);
    expect(hasPageBreaks(b)).toBe(true);
    expect(resetPageBreaks()).toEqual({ rows: [], cols: [] });
    expect(hasPageBreaks(resetPageBreaks())).toBe(false);
    expect(hasPageBreaks(EMPTY_PAGE_BREAKS)).toBe(false);
  });

  it('is immutable: inputs are never mutated', () => {
    const before = { rows: [1], cols: [] };
    insertRowBreak(before, 5);
    expect(before.rows).toEqual([1]);
  });

  it('round-trips through metadata', () => {
    const b = insertColBreak(insertRowBreak(EMPTY_PAGE_BREAKS, 9), 4);
    const meta = pageBreaksToMetadata(b);
    expect(pageBreaksFromMetadata(meta)).toEqual(b);
  });

  it('tolerates malformed metadata', () => {
    expect(pageBreaksFromMetadata(null)).toEqual({ rows: [], cols: [] });
    expect(pageBreaksFromMetadata('junk')).toEqual({ rows: [], cols: [] });
    expect(pageBreaksFromMetadata({ rows: [3, 'x', -2, 3] })).toEqual({ rows: [3], cols: [] });
  });

  it('uses the documented metadata key prefix', () => {
    expect(pageBreaksMetadataKey('Sheet1')).toBe(`${PAGE_BREAKS_METADATA_PREFIX}Sheet1`);
    expect(PAGE_BREAKS_METADATA_PREFIX).toBe('icecream.pagebreaks.');
  });
});
