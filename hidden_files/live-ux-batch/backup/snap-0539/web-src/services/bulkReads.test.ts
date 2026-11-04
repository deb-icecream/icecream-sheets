/**
 * Bulk viewport reads (Cycle 10 Phase 3/4): the first-paint fan-out fix.
 * Requests are counted AT THE TRANSPORT LAYER: hundreds of small caller
 * reads must collapse into a few bulk reads (Phase 2 measured ~548 range
 * + ~566 usedRange reads on a P95 first paint; this is the push/pull
 * counterpart — post-load navigation reads ride the same batcher).
 */
import { describe, expect, it } from 'vitest';
import type { RangeRef } from '@icecream-sheets/engine';
import {
  RangeReadBatcher,
  UsedRangeDeduper,
  mergeRangesForBulkRead,
  type RangeReadResult,
} from './bulkReads';

const tile = (startRow: number, startCol = 0): RangeRef => ({
  sheet: 'S',
  startRow,
  startCol,
  endRow: startRow + 9,
  endCol: startCol + 49,
});

describe('mergeRangesForBulkRead', () => {
  it('merges overlapping and adjacent ranges', () => {
    const merged = mergeRangesForBulkRead([tile(0), tile(10), tile(20)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ startRow: 0, endRow: 29 });
  });

  it('keeps genuinely scattered ranges separate', () => {
    const merged = mergeRangesForBulkRead([
      { sheet: 'S', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { sheet: 'S', startRow: 5000, startCol: 500, endRow: 5000, endCol: 500 },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('never merges across sheets', () => {
    const merged = mergeRangesForBulkRead([
      tile(0),
      { sheet: 'T', startRow: 0, startCol: 0, endRow: 9, endCol: 49 },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('RangeReadBatcher', () => {
  it('200 same-tick tile reads collapse into ONE bulk transport call', async () => {
    let fetchCalls = 0;
    const sinkCalls: RangeReadResult[] = [];
    const batcher = new RangeReadBatcher(
      async (range) => {
        fetchCalls++;
        const rows = range.endRow - range.startRow + 1;
        const cols = range.endCol - range.startCol + 1;
        return {
          values: Array.from({ length: rows }, () => Array(cols).fill({ kind: 'number', value: 1 })),
          formulas: Array.from({ length: rows }, () => Array(cols).fill(null)),
        };
      },
      (_range, result) => sinkCalls.push(result),
    );
    for (let i = 0; i < 200; i++) batcher.queueRange(tile(i * 10));
    await batcher.whenIdle();
    expect(fetchCalls).toBe(1);
    expect(batcher.stats.requestedReads).toBe(200);
    expect(batcher.stats.transportCalls).toBe(1);
    expect(sinkCalls.length).toBe(1);
  });
});

describe('UsedRangeDeduper', () => {
  it('50 concurrent usedRange lookups share ONE transport call', async () => {
    let fetchCalls = 0;
    const deduper = new UsedRangeDeduper(async () => {
      fetchCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return { sheet: 'S', startRow: 0, startCol: 0, endRow: 99, endCol: 9 };
    });
    const results = await Promise.all(Array.from({ length: 50 }, () => deduper.get('S')));
    expect(fetchCalls).toBe(1);
    expect(deduper.transportCalls).toBe(1);
    expect(results.every((r) => r?.endRow === 99)).toBe(true);
    // Settled cache: another lookup costs nothing.
    await deduper.get('S');
    expect(fetchCalls).toBe(1);
  });
});
