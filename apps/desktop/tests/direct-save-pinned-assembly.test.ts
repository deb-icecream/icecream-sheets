/**
 * Issue #49 pinning test: assembleBulkReadbackPinned must assemble a
 * sheet whose readback exceeds V8's spread/argument limit (measured
 * ~10⁵–10⁶) without throwing. The pre-fix implementation appended each
 * sheet with `bulk.push(...cells)` — at p95's real 720,016-cell first
 * sheet that threw "Maximum call stack size exceeded" on EVERY
 * checkpoint, so the pending batch never flushed. The perf program
 * validated the loop-append fix end-to-end with the real fixture; this
 * test pins the assembly itself with a synthetic 800,000-cell sheet.
 */
import { describe, expect, it } from 'vitest';
import type { EngineHost } from '@icecream-sheets/engine';
import { assembleBulkReadbackPinned, type SavePinHost } from '../src/direct-save.js';

const BIG_CELLS = 800_000;

function makePinHost(): SavePinHost & { released: boolean } {
  const state = { released: false };
  return {
    get released() {
      return state.released;
    },
    beginSavePin: () => ({ id: 'pin-1', rev: 7 }),
    bulkReadbackSheetPinned: (_pin, sheet) => {
      if (sheet === 'Small') {
        return [0, 1, 2].map((i) => ({
          ref: { sheet, row: i, col: 0 },
          input: i,
          value: { kind: 'number', value: i },
        }));
      }
      const cells = new Array(BIG_CELLS);
      for (let i = 0; i < BIG_CELLS; i++) {
        cells[i] = {
          ref: { sheet, row: i, col: 0 },
          input: i,
          value: { kind: 'number', value: i },
        };
      }
      return cells;
    },
    releaseSavePin: () => {
      state.released = true;
    },
  } as SavePinHost & { released: boolean };
}

describe('assembleBulkReadbackPinned — issue #49', () => {
  it('assembles an 800,000-cell sheet without the V8 spread limit', async () => {
    const pinHost = makePinHost();
    const host = pinHost as unknown as EngineHost;
    const { bulk, pinUsed, pinRev } = await assembleBulkReadbackPinned(host, [
      'Big',
      'Small',
    ]);
    expect(pinUsed).toBe(true);
    expect(pinRev).toBe(7);
    expect(bulk).toHaveLength(BIG_CELLS + 3);
    // Sheet order preserved: Big's cells first, then Small's.
    expect(bulk[0]!.ref).toEqual({ sheet: 'Big', row: 0, col: 0 });
    expect(bulk[BIG_CELLS - 1]!.ref).toEqual({ sheet: 'Big', row: BIG_CELLS - 1, col: 0 });
    expect(bulk[BIG_CELLS]!.ref).toEqual({ sheet: 'Small', row: 0, col: 0 });
    expect(pinHost.released).toBe(true);
  });
});
