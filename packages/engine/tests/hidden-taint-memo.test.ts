/**
 * Regression (Cycle 10 defect D3): EngineHost.readCell used to re-walk a
 * formula cell's entire transitive precedent closure on every read to answer
 * the hidden-taint question, so bulk reads of a chain sheet (running balance)
 * cost O(cells × chain depth) and wedged the engine service for minutes.
 * The taint computation is now a memoized fixed point over the closure.
 * These tests pin the SEMANTICS (taint must still be exact, including
 * through chains and cycles, and must invalidate on edits) — the perf win
 * is measured live in perf-evaluation.md §7.
 */
import { describe, expect, it } from 'vitest';
import { Authorizer, allowAllPolicy } from '../src/permissions.js';
import { ProtectionManager } from '../src/protection.js';
import { EngineHost } from '../src/protocol.js';
import { isError } from '../src/types.js';

const GUEST = { principal: 'user:guest' };

function makeHost() {
  const protection = new ProtectionManager();
  const host = new EngineHost(
    undefined,
    new Authorizer(protection.protectionPolicy(allowAllPolicy())),
  );
  host.setHiddenCheck((ref, principal) =>
    protection.isHiddenFrom(ref.sheet, ref.row, ref.col, principal),
  );
  protection.setHiddenExemptPrincipals(['user:owner']);
  return { host, protection };
}

function buildChain(host: EngineHost, rows: number) {
  host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 });
  for (let r = 1; r < rows; r++) {
    host.execute({
      cmd: 'setFormula',
      ref: { sheet: 'Sheet1', row: r, col: 0 },
      formula: `A${r}+1`,
    });
  }
}

describe('hidden-taint memo (D3)', () => {
  it('taint flows through a long chain and stays exact on repeat reads', () => {
    const { host, protection } = makeHost();
    buildChain(host, 300);
    protection.hideRanges('Sheet1', ['A1']); // hide A1 from non-exempt principals
    const deep = host.readCell({ sheet: 'Sheet1', row: 299, col: 0 }, GUEST);
    expect(isError(deep) && deep.code === '#PERM!').toBe(true);
    // Repeat read (memo hit) must give the same verdict.
    const again = host.readCell({ sheet: 'Sheet1', row: 299, col: 0 }, GUEST);
    expect(isError(again) && again.code === '#PERM!').toBe(true);
    // Owner is exempt: real value, chain of 300 ones = 300.
    const owner = host.readCell({ sheet: 'Sheet1', row: 299, col: 0 }, { principal: 'user:owner' });
    expect(isError(owner)).toBe(false);
  });

  it('an unhidden chain reads real values end to end', () => {
    const { host } = makeHost();
    buildChain(host, 300);
    const deep = host.readCell({ sheet: 'Sheet1', row: 299, col: 0 }, GUEST);
    expect(deep.kind).toBe('number');
    if (deep.kind === 'number') expect(deep.value).toBe(300);
  });

  it('edits invalidate the memo: rewiring a formula clears its taint', () => {
    const { host, protection } = makeHost();
    buildChain(host, 50);
    protection.hideRanges('Sheet1', ['A1']);
    const before = host.readCell({ sheet: 'Sheet1', row: 49, col: 0 }, GUEST);
    expect(isError(before) && before.code === '#PERM!').toBe(true);
    // Rewire A50 to a constant: no longer touches the hidden cell.
    host.execute({
      cmd: 'setFormula',
      ref: { sheet: 'Sheet1', row: 49, col: 0 },
      formula: '7*6',
    });
    const after = host.readCell({ sheet: 'Sheet1', row: 49, col: 0 }, GUEST);
    expect(after.kind).toBe('number');
    if (after.kind === 'number') expect(after.value).toBe(42);
  });

  it('bulk range reads over a chain complete with correct values', () => {
    const { host } = makeHost();
    buildChain(host, 2000);
    const grid = host.readRange(
      { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1999, endCol: 0 },
      GUEST,
    );
    expect(grid.length).toBe(2000);
    const last = grid[1999][0];
    expect(last.kind).toBe('number');
    if (last.kind === 'number') expect(last.value).toBe(2000);
  });
});
