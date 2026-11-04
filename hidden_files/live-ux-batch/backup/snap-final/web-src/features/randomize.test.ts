/**
 * Randomize range tests (features/randomize.ts).
 * The shuffle is pure and seeded; the host wrapper is exercised with a
 * minimal fake EngineHost.
 */
import { describe, expect, it } from 'vitest';
import { randomizeRange, shuffledRowOrder } from './randomize';

/** Deterministic RNG from a fixed sequence. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('shuffledRowOrder', () => {
  it('returns a permutation of the row indices', () => {
    const order = shuffledRowOrder(10, seqRng([0.1, 0.9, 0.3, 0.7, 0.2]));
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('is deterministic for a fixed RNG', () => {
    const a = shuffledRowOrder(5, seqRng([0.5]));
    const b = shuffledRowOrder(5, seqRng([0.5]));
    expect(a).toEqual(b);
  });

  it('handles edge sizes', () => {
    expect(shuffledRowOrder(0)).toEqual([]);
    expect(shuffledRowOrder(1)).toEqual([0]);
  });
});

describe('randomizeRange', () => {
  function fakeHost(cells: Record<string, { value: unknown; formula?: string }>) {
    const writes: Array<{ row: number; col: number; value: unknown; formula?: string }> = [];
    return {
      writes,
      host: {
        getView: () => ({
          readCell: (ref: { row: number; col: number }) => {
            const key = `${ref.row},${ref.col}`;
            const cell = cells[key] ?? { value: null };
            const v = cell.value;
            const kind = typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : typeof v === 'boolean' ? 'boolean' : 'blank';
            return { value: kind === 'blank' ? { kind } : { kind, value: v }, formula: cell.formula };
          },
        }),
        execute: (cmd: { cmd: string; ref: { row: number; col: number }; value?: unknown; formula?: string }) => {
          writes.push({ row: cmd.ref.row, col: cmd.ref.col, value: cmd.value ?? null, formula: cmd.formula });
          return { ok: true };
        },
      } as never,
    };
  }

  it('shuffles data rows and keeps the header row in place', () => {
    const cells: Record<string, { value: unknown }> = {
      '0,0': { value: 'Name' },
      '0,1': { value: 'Score' },
      '1,0': { value: 'a' },
      '1,1': { value: 1 },
      '2,0': { value: 'b' },
      '2,1': { value: 2 },
      '3,0': { value: 'c' },
      '3,1': { value: 3 },
    };
    const { host, writes } = fakeHost(cells);
    // rng always 0 -> Fisher-Yates rotates rows deterministically.
    const n = randomizeRange(
      host,
      { sheet: 'S', startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
      true,
      seqRng([0]),
    );
    expect(n).toBe(3);
    // Header row untouched.
    expect(writes.some((w) => w.row === 0)).toBe(false);
    // Every data row was rewritten exactly once per column.
    expect(writes.filter((w) => w.row >= 1).length).toBe(6);
    // Row order changed (rng=0 rotates: dest row r gets src row r+1...).
    const row1 = writes.filter((w) => w.row === 1).sort((a, b) => a.col - b.col);
    expect(row1.map((w) => w.value)).not.toEqual(['a', 1]);
  });

  it('returns 0 when there are no data rows', () => {
    const { host } = fakeHost({ '0,0': { value: 'H' } });
    expect(
      randomizeRange(host, { sheet: 'S', startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, true),
    ).toBe(0);
  });

  it('carries formulas with their rows', () => {
    const cells: Record<string, { value: unknown; formula?: string }> = {
      '0,0': { value: 'X' },
      '1,0': { value: 2, formula: '=1+1' },
      '2,0': { value: 3, formula: '=1+2' },
    };
    const { host, writes } = fakeHost(cells);
    randomizeRange(
      host,
      { sheet: 'S', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
      true,
      seqRng([0]),
    );
    const formulas = writes.filter((w) => w.formula !== undefined);
    expect(formulas.length).toBe(2);
    // rng=0 rotation: dest row 1 gets src row 2's formula.
    expect(formulas.find((w) => w.row === 1)?.formula).toBe('=1+2');
  });
});
