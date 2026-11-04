import { describe, expect, it } from 'vitest';
import { CellError, ErrorType } from 'hyperformula';
import {
  checkedSpillWrites,
  spill,
  spillExtentOf,
  toSpillWrites,
  type ArrayResult,
  type SpillExtent,
} from '../src/dynamic-arrays.js';

/** Tiny host grid: setCell/getCell over a Map, anchor tracked separately. */
function makeHost(initial: Record<string, unknown> = {}): {
  cells: Map<string, unknown>;
  setCell: (r: number, c: number, v: unknown) => void;
  getCell: (r: number, c: number) => unknown;
} {
  const cells = new Map<string, unknown>(Object.entries(initial));
  return {
    cells,
    setCell: (r, c, v) => {
      cells.set(`${r}:${c}`, v);
    },
    getCell: (r, c) => cells.get(`${r}:${c}`),
  };
}

describe('phase 2 spill semantics (dynamic-arrays)', () => {
  it('toSpillWrites keeps its contract: anchor excluded, row-major order', () => {
    const values: ArrayResult = [
      [1, 2],
      [3, 4],
    ];
    expect(toSpillWrites(0, 0, values)).toEqual([
      [0, 1, 2],
      [1, 0, 3],
      [1, 1, 4],
    ]);
    expect(spillExtentOf(2, 3, values)).toEqual({ startRow: 2, startCol: 3, endRow: 3, endCol: 4 });
  });

  it('checkedSpillWrites yields #SPILL! with zero writes when blocked', () => {
    const values: ArrayResult = [
      [1, 2],
      [3, 4],
    ];
    const blocked = checkedSpillWrites(0, 0, values, (r, c) => r === 1 && c === 1);
    expect('error' in blocked).toBe(true);
    if ('error' in blocked) {
      expect(blocked.error).toBeInstanceOf(CellError);
      expect(blocked.error.type).toBe(ErrorType.SPILL);
    }
    const open = checkedSpillWrites(0, 0, values, () => false);
    expect('writes' in open && open.writes).toEqual(toSpillWrites(0, 0, values));
  });

  it('checkedSpillWrites never treats previous-extent cells as blockers', () => {
    const values: ArrayResult = [
      [1, 2],
      [3, 4],
    ];
    const prev: SpillExtent = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    // Every extent cell "occupied" — but all are previous outputs.
    const res = checkedSpillWrites(0, 0, values, () => true, prev);
    expect('writes' in res).toBe(true);
  });

  it('spill() blocked writes nothing (legacy no-extent behaviour preserved)', () => {
    const host = makeHost({ '1:1': 'user value' });
    const result = spill(0, 0, [[1, 2], [3, 4]], host.setCell as never, host.getCell as never);
    expect(result).toBeInstanceOf(CellError);
    expect(host.cells.get('0:1')).toBeUndefined();
    expect(host.cells.get('1:0')).toBeUndefined();
    expect(host.cells.get('1:1')).toBe('user value');
  });

  it('spill() replay is idempotent and resizes: shrink clears stale members', () => {
    const host = makeHost();
    // First spill 2x2.
    expect(spill(0, 0, [[1, 2], [3, 4]], host.setCell as never, host.getCell as never)).toBe('ok');
    expect(host.cells.get('1:1')).toBe(4);
    const prev: SpillExtent = spillExtentOf(0, 0, [[1, 2], [3, 4]]);
    // Replay the same 2x2 over its own static writes: must NOT self-block.
    // getCell here reads the host grid, which holds the previous outputs —
    // previousExtent exempts exactly those cells.
    expect(
      spill(0, 0, [[1, 2], [3, 4]], host.setCell as never, host.getCell as never, prev),
    ).toBe('ok');
    // Shrink to 1x2: the old row-1 members clear to null.
    const prev2: SpillExtent = spillExtentOf(0, 0, [[1, 2], [3, 4]]);
    expect(spill(0, 0, [[9, 8]], host.setCell as never, host.getCell as never, prev2)).toBe('ok');
    expect(host.cells.get('0:1')).toBe(8);
    expect(host.cells.get('1:0')).toBeNull();
    expect(host.cells.get('1:1')).toBeNull();
  });

  it('spill() newly blocked clears previous members and yields #SPILL!', () => {
    const host = makeHost();
    expect(spill(0, 0, [[1, 2], [3, 4]], host.setCell as never, host.getCell as never)).toBe('ok');
    const prev: SpillExtent = spillExtentOf(0, 0, [[1, 2], [3, 4]]);
    // A user value lands OUTSIDE the previous extent but inside the new
    // (grown) extent: the replay must block, not overwrite it.
    host.setCell(2, 0, 'blocker');
    const result = spill(
      0,
      0,
      [[1, 2], [3, 4], [5, 6]],
      host.setCell as never,
      host.getCell as never,
      prev,
    );
    expect(result).toBeInstanceOf(CellError);
    expect(host.cells.get('2:0')).toBe('blocker');
    // Previous members cleared (stale outputs disappear with #SPILL!).
    expect(host.cells.get('1:1')).toBeNull();
    // The new row's other member was never written.
    expect(host.cells.get('2:1')).toBeUndefined();
  });

  it('spill() resized to nothing clears previous members', () => {
    const host = makeHost();
    expect(spill(0, 0, [[1, 2], [3, 4]], host.setCell as never, host.getCell as never)).toBe('ok');
    const prev: SpillExtent = spillExtentOf(0, 0, [[1, 2], [3, 4]]);
    expect(spill(0, 0, [], host.setCell as never, host.getCell as never, prev)).toBe('ok');
    expect(host.cells.get('1:1')).toBeNull();
  });
});
