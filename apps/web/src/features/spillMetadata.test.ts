import { describe, expect, it } from 'vitest';
import {
  fromAdapterSpill,
  isSpillAnchor,
  spillAt,
  spillBlockedBy,
  spillCells,
  spillContains,
  spillErrorLabel,
  spillRangeLabel,
  spillRefLabel,
  spillSize,
  type SpillDisplayRange,
} from './spillMetadata';

const SPILL: SpillDisplayRange = {
  anchorRow: 0,
  anchorCol: 0,
  startRow: 0,
  startCol: 0,
  endRow: 2,
  endCol: 2,
  formula: 'SEQUENCE(3,3)',
  kind: 'dynamic',
};

describe('spillMetadata display helper', () => {
  it('labels the extent and the spill-operator ref', () => {
    expect(spillRangeLabel(SPILL)).toBe('A1:C3');
    expect(spillRefLabel(SPILL)).toBe('A1#');
    expect(spillSize(SPILL)).toEqual({ rows: 3, cols: 3 });
  });

  it('marks the anchor vs spilled cells', () => {
    const cells = spillCells(SPILL);
    expect(cells).toHaveLength(9);
    expect(cells[0]).toEqual({ row: 0, col: 0, ref: 'A1', role: 'anchor' });
    expect(cells.filter((c) => c.role === 'spilled')).toHaveLength(8);
    expect(spillContains(SPILL, 2, 2)).toBe(true);
    expect(spillContains(SPILL, 3, 0)).toBe(false);
    expect(isSpillAnchor(SPILL, 0, 0)).toBe(true);
    expect(isSpillAnchor(SPILL, 0, 1)).toBe(false);
  });

  it('finds spills by contained cell and by anchor', () => {
    expect(spillAt([SPILL], 1, 1)).toBe(SPILL);
    expect(spillAt([SPILL], 5, 5)).toBeUndefined();
    expect(spillAt([], 0, 0)).toBeUndefined();
  });

  it('reports blockers and the #SPILL! label only for occupied spilled cells', () => {
    const free = () => false;
    expect(spillBlockedBy(SPILL, free)).toEqual([]);
    expect(spillErrorLabel(SPILL, free)).toBeNull();
    // An occupied anchor-adjacent member blocks; the anchor itself never does.
    const occupied = (r: number, c: number) => (r === 1 && c === 1) || (r === 0 && c === 0);
    const blockers = spillBlockedBy(SPILL, occupied);
    expect(blockers).toEqual([{ row: 1, col: 1, ref: 'B2', role: 'spilled' }]);
    expect(spillErrorLabel(SPILL, occupied)).toBe('#SPILL!');
  });

  it('converts the adapter shape without a runtime import', () => {
    expect(
      fromAdapterSpill({
        anchor: { row: 4, col: 6, ref: 'G5' },
        startRow: 4,
        startCol: 6,
        endRow: 5,
        endCol: 6,
        ref: 'G5:G6',
        formula: 'MMULT(A1:C2,E1:E3)',
        kind: 'legacy',
        cachedValues: [[49.2], [0]],
      }),
    ).toEqual({
      anchorRow: 4,
      anchorCol: 6,
      startRow: 4,
      startCol: 6,
      endRow: 5,
      endCol: 6,
      formula: 'MMULT(A1:C2,E1:E3)',
      kind: 'legacy',
    });
  });
});
