/**
 * Cycle 10 closure (perf-evaluation §7, defect 6 residual):
 *
 * (1) Partition-plan cache — planPartitions walks the WHOLE workbook's
 * precedents (18.7 s on the P95 workbook), so repeat recalcs of one
 * workbook reuse the plan keyed by the workbook's graph version (the
 * same signal the calc-chain measurement cache uses). Value-only edits
 * must NOT invalidate; formula edits and tracked-set membership changes
 * MUST (a new literal precedent changes partition boundaries).
 *
 * (2) Early degenerate exit — with the orchestrator's guard constants,
 * planning a chain-dominated workbook stops as soon as degeneracy is
 * PROVEN (an exact bound on the best possible finished average stage
 * width), instead of completing the walk.
 *
 * (3) Deep + wide plans must still reach staged parallel evaluation
 * (the pre-gate must not divert them) and produce serial-identical
 * values — the differential guard for staged evaluation on deep chains.
 *
 * (4) Bulk readback equivalence — EngineWorkbook.getBulkReadback /
 * EngineHost.bulkReadback return exactly what per-cell
 * getSerialized/getValue/readCell return, including #PERM! outcomes
 * for hidden cells and formulas touching hidden cells.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineHost,
  EngineWorkbook,
  InlineWorkerBackend,
  ParallelRecalculator,
  planPartitions,
} from '../src/index.js';

function ledgerLike(rows: number): Record<string, (string | number | null)[][]> {
  const grid: (string | number | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: (string | number | null)[] = new Array(8).fill(null);
    row[4] = r + 1;
    row[5] = 1;
    row[6] = r === 0 ? '=E1-F1' : `=G${r}+E${r + 1}-F${r + 1}`;
    row[7] = `=IF(G${r + 1}>0,1,0)`;
    grid.push(row);
  }
  return { Ledger: grid };
}

describe('partition plan cache', () => {
  it('repeat plan calls return the identical cached plan object', () => {
    const wb = new EngineWorkbook(ledgerLike(50));
    const a = planPartitions(wb, { workerCount: 4 });
    const b = planPartitions(wb, { workerCount: 4 });
    expect(b).toBe(a);
    wb.disposeParallelWorkers();
  });

  it('a pure value edit does NOT invalidate the cached plan', () => {
    const wb = new EngineWorkbook(ledgerLike(50));
    const a = planPartitions(wb, { workerCount: 4 });
    wb.setCell({ sheet: 'Ledger', row: 0, col: 4 }, 999); // E1: value -> value
    expect(planPartitions(wb, { workerCount: 4 })).toBe(a);
    wb.disposeParallelWorkers();
  });

  it('a formula edit invalidates the cached plan', () => {
    const wb = new EngineWorkbook(ledgerLike(50));
    const a = planPartitions(wb, { workerCount: 4 });
    const v = wb.getGraphVersion();
    wb.setFormula({ sheet: 'Ledger', row: 0, col: 7 }, '=IF(G1>5,1,0)');
    expect(wb.getGraphVersion()).toBeGreaterThan(v);
    expect(planPartitions(wb, { workerCount: 4 })).not.toBe(a);
    wb.disposeParallelWorkers();
  });

  it('adding a brand-new cell (tracked-set membership) invalidates the cached plan', () => {
    const wb = new EngineWorkbook({ S: [[1, '=A1*2']] });
    const a = planPartitions(wb, { workerCount: 4 });
    const v = wb.getGraphVersion();
    wb.setCell({ sheet: 'S', row: 5, col: 5 }, 42); // previously empty cell
    expect(wb.getGraphVersion()).toBeGreaterThan(v);
    expect(planPartitions(wb, { workerCount: 4 })).not.toBe(a);
    wb.disposeParallelWorkers();
  });

  it('different worker counts cache separately', () => {
    const wb = new EngineWorkbook(ledgerLike(50));
    const a = planPartitions(wb, { workerCount: 4 });
    const b = planPartitions(wb, { workerCount: 2 });
    expect(b).not.toBe(a);
    expect(planPartitions(wb, { workerCount: 4 })).toBe(a);
    wb.disposeParallelWorkers();
  });
});

describe('early degenerate exit', () => {
  it('chain-dominated workbook: planning proves degeneracy and stops', () => {
    const wb = new EngineWorkbook(ledgerLike(400));
    const plan = planPartitions(wb, {
      workerCount: 4,
      earlyExit: { stageFloor: 64, minAvgWidth: 4 },
    });
    expect(plan.degenerateEarlyExit).toBeTruthy();
    expect(plan.degenerateEarlyExit!.stagesCompleted).toBeGreaterThan(64);
    expect(plan.degenerateEarlyExit!.maxPossibleAvgWidth).toBeLessThan(4);
    expect(plan.degenerateEarlyExit!.unprocessedFormulaCells).toBeGreaterThan(0);
    expect(plan.stages).toEqual([]);
    // Statistics the orchestrator's earlier guards rely on stay exact.
    expect(plan.formulaCellCount).toBe(800);
    expect(plan.totalCellCount).toBe(400 * 4);
    wb.disposeParallelWorkers();
  });

  it('without earlyExit the same workbook still produces the full plan', () => {
    const wb = new EngineWorkbook(ledgerLike(400));
    const plan = planPartitions(wb, { workerCount: 4 });
    expect(plan.degenerateEarlyExit).toBeUndefined();
    expect(plan.stages.length).toBeGreaterThan(100);
    wb.disposeParallelWorkers();
  });

  it('the early-exit verdict is cached across repeat recalcs', async () => {
    const wb = new EngineWorkbook(ledgerLike(400));
    const recalc = new ParallelRecalculator({ create: () => new InlineWorkerBackend() });
    const opts = { enabled: true, workerCount: 4, minFormulaCells: 0, cellCountThreshold: 0 };
    const first = await recalc.recalculate(wb, opts);
    expect(first.stats.parallel).toBe(false);
    expect(first.stats.reason).toContain('degenerate plan');
    const second = await recalc.recalculate(wb, opts);
    expect(second.stats.parallel).toBe(false);
    expect(second.stats.reason).toContain('degenerate plan');
    wb.disposeParallelWorkers();
  });
});

describe('deep + wide plans still reach staged evaluation (differential)', () => {
  // 8 independent chains, each 150 formula cells deep: 150 stages, every
  // stage 8 cells wide (4 partitions at workerCount 4) — average stage
  // width exactly 4, so neither the degenerate guard nor the early exit
  // may divert it, and staged evaluation must match serial exactly.
  function deepWide(): Record<string, (string | number | null)[][]> {
    const cols = 8;
    const rows = 151; // row 0 literals, rows 1..150 formulas (=above+1)
    const grid: (string | number | null)[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: (string | number | null)[] = [];
      for (let c = 0; c < cols; c++) {
        if (r === 0) row.push(c + 1);
        else {
          const col = String.fromCharCode(65 + c);
          row.push(`=${col}${r}+1`);
        }
      }
      grid.push(row);
    }
    return { Deep: grid };
  }

  it('plan is deep and wide (stages > 64, avg width >= 4, no early exit)', () => {
    const wb = new EngineWorkbook(deepWide());
    const plan = planPartitions(wb, {
      workerCount: 4,
      earlyExit: { stageFloor: 64, minAvgWidth: 4 },
    });
    expect(plan.degenerateEarlyExit).toBeUndefined();
    expect(plan.stages.length).toBe(150);
    const parts = plan.stages.reduce((n, s) => n + s.length, 0);
    expect(parts / plan.stages.length).toBeGreaterThanOrEqual(4);
    wb.disposeParallelWorkers();
  });

  it('staged parallel values equal serial values on the deep chains', async () => {
    const wb = new EngineWorkbook(deepWide());
    const serial = new EngineWorkbook(deepWide());
    const recalc = new ParallelRecalculator({ create: () => new InlineWorkerBackend() });
    const result = await recalc.recalculate(wb, {
      enabled: true,
      workerCount: 4,
      minFormulaCells: 0,
      cellCountThreshold: 0,
    });
    expect(result.stats.parallel).toBe(true);
    const merged = new Map(
      result.merged.map((m) => [`${m.ref.sheet}:${m.ref.row}:${m.ref.col}`, m.value]),
    );
    for (let r = 1; r <= 150; r++) {
      for (let c = 0; c < 8; c++) {
        const ref = { sheet: 'Deep', row: r, col: c };
        const expected = serial.getValue(ref);
        expect(merged.get(`Deep:${r}:${c}`)).toEqual(expected);
        expect(expected).toEqual({ kind: 'number', value: c + 1 + r });
      }
    }
    wb.disposeParallelWorkers();
    serial.disposeParallelWorkers();
  });
});

describe('bulk readback equivalence', () => {
  function fixture(): EngineWorkbook {
    return new EngineWorkbook(
      {
        S: [
          [2, '=A1*3', 'text'],
          ['=B1+1', 10, '=SUM(A2:B2)'],
        ],
        T: [['=S!B1*2', null, 7]],
      },
      { definedNames: [{ name: 'Cost', ref: 'S!$A$1' }] },
    );
  }

  it('workbook bulk readback equals per-cell getSerialized + getValue', () => {
    const wb = fixture();
    // Add a defined-name formula after construction (name scan path).
    wb.setFormula({ sheet: 'T', row: 0, col: 2 }, '=Cost*10');
    const bulk = wb.getBulkReadback({ principal: 'user' });
    const tracked = wb.getTrackedCells();
    expect(bulk.length).toBe(tracked.length);
    for (const cell of bulk) {
      expect(cell.input).toEqual(wb.getSerialized(cell.ref));
      expect(cell.value).toEqual(wb.getValue(cell.ref, { principal: 'user' }));
    }
    // Order is (sheet order, row, col) — snapshot order.
    const keys = bulk.map((c) => `${c.ref.sheet}:${c.ref.row}:${c.ref.col}`);
    expect(keys).toEqual([...keys].sort((a, b) => {
      const [sa, ra, ca] = a.split(':');
      const [sb, rb, cb] = b.split(':');
      const sheetCmp = (sa === 'S' ? 0 : 1) - (sb === 'S' ? 0 : 1);
      if (sheetCmp !== 0) return sheetCmp;
      if (Number(ra) !== Number(rb)) return Number(ra) - Number(rb);
      return Number(ca) - Number(cb);
    }));
    wb.disposeParallelWorkers();
  });

  it('bulk readback reflects edits (no stale cached values)', () => {
    const wb = fixture();
    wb.setCell({ sheet: 'S', row: 0, col: 0 }, 5);
    const bulk = wb.getBulkReadback({ principal: 'user' });
    const b1 = bulk.find((c) => c.ref.sheet === 'S' && c.ref.row === 0 && c.ref.col === 1)!;
    expect(b1.value).toEqual({ kind: 'number', value: 15 });
    wb.disposeParallelWorkers();
  });

  it('host bulk readback equals per-cell readCell, including #PERM! outcomes', () => {
    const wb = fixture();
    const host = new EngineHost(wb);
    // Hide S!A1: A1 itself is hidden; B1 (=A1*3) and A2 (=B1+1) touch it
    // transitively through their formulas.
    host.setHiddenCheck((ref) => ref.sheet === 'S' && ref.row === 0 && ref.col === 0);
    const auth = { principal: 'user' };
    const bulk = host.bulkReadback(auth);
    expect(bulk.length).toBe(wb.getTrackedCells().length);
    for (const cell of bulk) {
      expect(cell.value).toEqual(host.readCell(cell.ref, auth));
    }
    const a1 = bulk.find((c) => c.ref.sheet === 'S' && c.ref.row === 0 && c.ref.col === 0)!;
    expect(a1.value).toMatchObject({ kind: 'error', code: '#PERM!' });
    const b1 = bulk.find((c) => c.ref.sheet === 'S' && c.ref.row === 0 && c.ref.col === 1)!;
    expect(b1.value).toMatchObject({ kind: 'error', code: '#PERM!' });
    wb.disposeParallelWorkers();
  });
});
