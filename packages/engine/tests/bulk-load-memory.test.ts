/**
 * Bulk-load memory bookkeeping (Cycle 10 closure W16, P99):
 * construction is the recalculation baseline, so the constructor's
 * populate must not leave one dirty-input key per cell behind, and the
 * value cache stays a lazily-filled memo in automatic mode (manual
 * mode re-seeds it at suspend time — setCalculationMode — which is
 * what keeps suspended reads exact without a construction-time seed
 * of every cell).
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook } from '../src/index.js';

describe('bulk-load bookkeeping (W16)', () => {
  it('construction leaves the dirty-input set empty; edits dirty, recalc clears', () => {
    const wb = new EngineWorkbook({
      S: [
        [1, 2, '=A1+B1'],
        [4, 5, '=A2+B2'],
      ],
    });
    expect(wb.getDirtyInputKeys().size).toBe(0);
    wb.setCell({ sheet: 'S', row: 0, col: 0 }, 10);
    expect(wb.getDirtyInputKeys().size).toBe(1);
    expect(wb.getValue({ sheet: 'S', row: 0, col: 2 })).toEqual({ kind: 'number', value: 12 });
    wb.recalculate();
    expect(wb.getDirtyInputKeys().size).toBe(0);
  });

  it('manual mode serves seeded values while deferred and fresh values after recalc', () => {
    const wb = new EngineWorkbook({
      S: [
        [1, 2, '=A1+B1'],
        [4, 5, '=A2+B2'],
      ],
    });
    wb.setCalculationMode('manual');
    // Suspended reads serve the values seeded when the mode switched.
    expect(wb.getValue({ sheet: 'S', row: 0, col: 2 })).toEqual({ kind: 'number', value: 3 });
    wb.setCell({ sheet: 'S', row: 0, col: 0 }, 10);
    // Deferred: the dependent still shows its last-computed value.
    expect(wb.getValue({ sheet: 'S', row: 0, col: 2 })).toEqual({ kind: 'number', value: 3 });
    wb.recalculate();
    expect(wb.getValue({ sheet: 'S', row: 0, col: 2 })).toEqual({ kind: 'number', value: 12 });
    wb.setCalculationMode('automatic');
  });

  it('automatic-mode reads stay exact for formula cells (cache is a memo, HF is authoritative)', () => {
    const wb = new EngineWorkbook({
      S: [
        [3, '=A1*7', '=SUM(A1:B1)'],
        [null, null, null],
      ],
    });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 1 })).toEqual({ kind: 'number', value: 21 });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 2 })).toEqual({ kind: 'number', value: 24 });
    wb.setCell({ sheet: 'S', row: 0, col: 0 }, 4);
    expect(wb.getValue({ sheet: 'S', row: 0, col: 2 })).toEqual({ kind: 'number', value: 32 });
  });
});
