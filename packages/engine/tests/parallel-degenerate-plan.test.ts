/**
 * Degenerate-plan guard (Cycle 10 finisher pass).
 *
 * Regression: on the P95 workbook (1.8M cells), editing the head of the
 * Ledger running-balance chain routed to a parallel follow-up whose plan
 * had ~30k stages of average width ~1.5 (each balance cell feeds the next
 * balance AND its row's status cell — fan-out 2 at every row, so the plan
 * passes a max-width check while being effectively serial). The parallel
 * pass re-derives the whole workbook stage by stage and took ~12 minutes
 * to repeat a serial recalc that had already produced the correct values;
 * on the gateway host the process died in that window. The orchestrator
 * must recognize a chain-dominated plan (average stage width below
 * MIN_AVG_STAGE_WIDTH) and fall back to serial.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineWorkbook,
  InlineWorkerBackend,
  ParallelRecalculator,
  planPartitions,
} from '../src/index.js';

/**
 * A Ledger-shaped sheet: E/F inputs, G running balance
 * (G(r) = G(r-1) + E(r) - F(r)), H status derived from G. The G/H braid
 * gives most stages width 2 — enough to pass a max-width guard, far too
 * thin to parallelize.
 */
function ledgerLike(rows: number): Record<string, (string | number | null)[][]> {
  const grid: (string | number | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: (string | number | null)[] = new Array(8).fill(null);
    row[4] = r + 1; // E: debit input
    row[5] = 1; // F: credit input
    // G (col 6): running balance. Row 0 has no predecessor.
    row[6] = r === 0 ? '=E1-F1' : `=G${r}+E${r + 1}-F${r + 1}`;
    // H (col 7): status derived from the balance.
    row[7] = `=IF(G${r + 1}>0,1,0)`;
    grid.push(row);
  }
  return { Ledger: grid };
}

describe('degenerate-plan guard', () => {
  it('a chain-dominated plan has average stage width below the parallel floor', () => {
    const wb = new EngineWorkbook(ledgerLike(400));
    const plan = planPartitions(wb, { workerCount: 4 });
    const totalPartitions = plan.stages.reduce((n, s) => n + s.length, 0);
    const avgWidth = totalPartitions / plan.stages.length;
    // Sanity on the fixture's shape: hundreds of stages, none wide.
    expect(plan.stages.length).toBeGreaterThan(100);
    expect(avgWidth).toBeLessThan(4);
    wb.disposeParallelWorkers();
  });

  it('recalculate() falls back to serial for a chain-dominated plan', async () => {
    const wb = new EngineWorkbook(ledgerLike(400));
    const recalc = new ParallelRecalculator({ create: () => new InlineWorkerBackend() });
    const result = await recalc.recalculate(wb, {
      enabled: true,
      workerCount: 4,
      minFormulaCells: 0,
      cellCountThreshold: 0,
    });
    expect(result.stats.parallel).toBe(false);
    expect(result.stats.reason).toContain('degenerate plan');
    wb.disposeParallelWorkers();
  });

  it('a genuinely wide plan still goes parallel', async () => {
    // 64 independent two-cell chains: stage widths are large, depth is 1.
    const sheets: Record<string, (string | number | null)[][]> = {};
    for (let i = 0; i < 64; i++) {
      sheets[`S${i}`] = [[i + 1, `=A1*2`]];
    }
    const wb = new EngineWorkbook(sheets);
    const recalc = new ParallelRecalculator({ create: () => new InlineWorkerBackend() });
    const result = await recalc.recalculate(wb, {
      enabled: true,
      workerCount: 4,
      minFormulaCells: 0,
      cellCountThreshold: 0,
    });
    expect(result.stats.parallel).toBe(true);
    wb.disposeParallelWorkers();
  });
});
