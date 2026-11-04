/**
 * Parallel recalculation (track 13) tests.
 *
 * Core guarantee under test: parallel evaluation produces EXACTLY the
 * serial values. Every parallel==serial test builds twin workbooks from
 * the same initial data, recalculates one via the worker pool and the
 * other via the serial path, and compares every cell.
 *
 * The InlineWorkerBackend runs the identical executePartition() code path
 * in-process (no threads): any divergence it catches is a logic bug, not
 * a threading artifact. A separate test exercises real worker_threads.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  EngineWorkbook,
  InlineWorkerBackend,
  NodeWorkerBackend,
  ParallelRecalculator,
  TypedView,
  clearPartitionCache,
  executePartition,
  planPartitions,
  normalizeParallelOptions,
  defaultWorkerCount,
  shouldEnableParallelRecalc,
  resolveParallelCellThreshold,
  DEFAULT_PARALLEL_CELL_THRESHOLD,
  type ParallelRecalcOptions,
  type RecalcRequest,
  type TypedValue,
} from '../src/index.js';
import type { JsonValue } from '../src/index.js';

function val(wb: EngineWorkbook, sheet: string, row: number, col: number): TypedValue {
  return wb.getValue({ sheet, row, col });
}

/** Read every cell of every sheet (suspension-safe via tracked inputs). */
function readAll(wb: EngineWorkbook): Map<string, string> {
  const out = new Map<string, string>();
  for (const { ref } of wb.getTrackedCells()) {
    out.set(
      `${ref.sheet}!${ref.row},${ref.col}`,
      JSON.stringify(TypedView.toJson(val(wb, ref.sheet, ref.row, ref.col))),
    );
  }
  return out;
}

function serialTwin(initial: Record<string, (string | number | boolean | null)[][]>): EngineWorkbook {
  const wb = new EngineWorkbook(initial);
  wb.setCalculationMode('manual');
  return wb;
}

async function parallelRecalc(
  wb: EngineWorkbook,
  opts: Partial<ParallelRecalcOptions> = {},
): Promise<{ parallel: boolean; reason?: string }> {
  wb.setParallelRecalcOptions({
    enabled: true,
    workerCount: 2,
    minFormulaCells: 0,
    // Bypass the auto-MT cell-count gate in these differential tests: they
    // use small fixtures, and the gate itself is tested separately.
    cellCountThreshold: 0,
    factory: { create: () => new InlineWorkerBackend() },
    ...opts,
  });
  const stats = await wb.recalculateParallel();
  wb.disposeParallelWorkers();
  return { parallel: stats.parallel, reason: stats.reason };
}

function expectSameValues(a: EngineWorkbook, b: EngineWorkbook): void {
  const va = readAll(a);
  const vb = readAll(b);
  expect([...va.keys()].sort()).toEqual([...vb.keys()].sort());
  for (const [k, v] of va) {
    expect(v, `cell ${k}`).toEqual(vb.get(k));
  }
}

describe('planPartitions (chain semantics, Cycle 10)', () => {
  it('independent formula cells form one stage, split into partitions', () => {
    const wb = new EngineWorkbook({
      A: [['=1+1']],
      B: [['=2*3']],
      C: [[42]],
    });
    const plan = planPartitions(wb, { workerCount: 4 });
    // Literal-only sheets own no partitions; A and B are both depth-0 and
    // independent, so one stage with two partitions.
    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0]).toHaveLength(2);
    expect(plan.formulaCellCount).toBe(2);
    expect(plan.totalCellCount).toBe(3);
    expect(plan.usesProviderBackedFunctions).toBe(false);
    // Every formula cell is owned exactly once.
    const owned = plan.stages[0]!.flatMap((p) => p.cells);
    expect(owned.map((c) => `${c.sheet}!${c.row},${c.col}`).sort()).toEqual([
      'A!0,0',
      'B!0,0',
    ]);
  });

  it('dependency chains stage in topological order', () => {
    const wb = new EngineWorkbook({
      Base: [[10]],
      Mid: [['=Base!A1*2']],
      Top: [['=Mid!A1+1']],
    });
    const plan = planPartitions(wb, { workerCount: 2 });
    // Mid (depth 0, literal precedent) then Top (depth 1). Base is a
    // literal — it owns no partition; Mid reads it as boundary.
    expect(plan.stages).toHaveLength(2);
    expect(plan.stages[0]![0]!.cells.map((c) => c.sheet)).toEqual(['Mid']);
    expect(plan.stages[1]![0]!.cells.map((c) => c.sheet)).toEqual(['Top']);
    const midBoundary = plan.stages[0]![0]!.boundary;
    expect(midBoundary).toHaveLength(1);
    expect(midBoundary[0]).toMatchObject({ sheet: 'Base', row: 0, col: 0 });
    const topBoundary = plan.stages[1]![0]!.boundary;
    expect(topBoundary).toHaveLength(1);
    expect(topBoundary[0]).toMatchObject({ sheet: 'Mid', row: 0, col: 0 });
  });

  it('multiple independent chains on ONE sheet partition apart', () => {
    // The case sheet-granular partitioning missed: one sheet, two chains
    // with no dependency between them at the same depth must fan out to
    // workers. B1 (=A1*2) and A3 (=B2*2) are both depth 0 and independent.
    const wb = new EngineWorkbook({
      S: [
        [1, '=A1*2'],
        [10, 20],
        ['=B2*2'],
      ],
    });
    const plan = planPartitions(wb, { workerCount: 2 });
    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0]).toHaveLength(2);
    const owned0 = plan.stages[0]![0]!.cells.map((c) => `R${c.row}C${c.col}`);
    const owned1 = plan.stages[0]![1]!.cells.map((c) => `R${c.row}C${c.col}`);
    expect([owned0, owned1]).toEqual([['R0C1'], ['R2C0']]);
    expect(plan.stages[0]![0]!.sheets).toEqual(['S']);
    // First partition reads literal A1 as boundary; second reads literal B2.
    expect(plan.stages[0]![0]!.boundary.map((c) => `R${c.row}C${c.col}`)).toEqual(['R0C0']);
    expect(plan.stages[0]![1]!.boundary.map((c) => `R${c.row}C${c.col}`)).toEqual(['R1C1']);
  });

  it('diamond dependencies: middle layer parallels, top serializes', () => {
    const wb = new EngineWorkbook({
      A: [[1]],
      B: [['=A!A1+1']],
      C: [['=A!A1+2']],
      D: [['=B!A1+C!A1']],
    });
    const plan = planPartitions(wb, { workerCount: 2 });
    expect(plan.stages).toHaveLength(2);
    expect(plan.stages[0]).toHaveLength(2); // B and C in parallel
    expect(plan.stages[1]).toHaveLength(1); // D waits for both
    expect(plan.stages[1]![0]!.boundary.map((c) => c.sheet).sort()).toEqual(['B', 'C']);
  });

  it('a single long chain never fans out (stages stay serial)', () => {
    const wb = new EngineWorkbook({
      S: [[1], ['=A1+1'], ['=A2+1'], ['=A3+1'], ['=A4+1']],
    });
    const plan = planPartitions(wb, { workerCount: 8 });
    expect(plan.stages).toHaveLength(4);
    for (const stage of plan.stages) expect(stage).toHaveLength(1);
  });

  it('cycles merge into a single partition', () => {
    const wb = new EngineWorkbook({
      X: [['=Y!A1+1']],
      Y: [['=X!A1+1']],
    });
    const plan = planPartitions(wb, { workerCount: 2 });
    const total = plan.stages.reduce((n, s) => n + s.length, 0);
    expect(total).toBe(1);
    expect(plan.stages[0]![0]!.cells.map((c) => c.sheet).sort()).toEqual(['X', 'Y']);
    expect(plan.stages[0]![0]!.sheets).toEqual(['X', 'Y']);
  });

  it('flags provider-backed functions', () => {
    const wb = new EngineWorkbook({ S: [['=PY("result=1")']] });
    expect(planPartitions(wb).usesProviderBackedFunctions).toBe(true);
    const wb2 = new EngineWorkbook({ S: [['=SUM(A1:A2)']] });
    expect(planPartitions(wb2).usesProviderBackedFunctions).toBe(false);
  });

  it('large stage chunks cells to at most workerCount partitions', () => {
    const grid: (string | number)[][] = [];
    for (let r = 0; r < 20; r++) grid.push([r, `=A${r + 1}*2`]);
    const wb = new EngineWorkbook({ S: grid });
    const plan = planPartitions(wb, { workerCount: 4 });
    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0]).toHaveLength(4);
    const sizes = plan.stages[0]!.map((p) => p.cells.length);
    expect(sizes).toEqual([5, 5, 5, 5]);
  });
});

describe('parallel == serial', () => {
  it('independent sheets', async () => {
    const initial = {
      S1: [[1], [2], ['=SUM(A1:A2)']],
      S2: [[10], [20], ['=AVERAGE(A1:A2)']],
      S3: [['x'], ['=UPPER(A1)']],
    };
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    const { parallel } = await parallelRecalc(pw);
    expect(parallel).toBe(true);
    sw.recalculate();
    expectSameValues(pw, sw);
  });

  it('chained sheets propagate boundary values', async () => {
    const initial = {
      Inputs: [[5], [7]],
      Calc: [['=Inputs!A1*Inputs!A2'], ['=SUM(Inputs!A1:A2)']],
      Output: [['=Calc!A1+Calc!A2'], ['=Calc!A1*10']],
    };
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    const { parallel } = await parallelRecalc(pw);
    expect(parallel).toBe(true);
    sw.recalculate();
    expectSameValues(pw, sw);
    // 5*7=35, 5+7=12, 35+12=47
    expect(TypedView.toJson(val(pw, 'Output', 0, 0))).toBe(47);
  });

  it('error values propagate across partitions', async () => {
    const initial = {
      Src: [['=1/0'], [5]],
      Dst: [['=Src!A1+1'], ['=IF(ISERROR(Src!A1),"err","ok")'], ['=Src!A2*2']],
    };
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    const { parallel } = await parallelRecalc(pw);
    expect(parallel).toBe(true);
    sw.recalculate();
    expectSameValues(pw, sw);
    expect(TypedView.toJson(val(pw, 'Dst', 0, 0))).toEqual({ error: '#DIV/0!' });
    expect(TypedView.toJson(val(pw, 'Dst', 1, 0))).toBe('err');
    expect(TypedView.toJson(val(pw, 'Dst', 2, 0))).toBe(10);
  });

  it('cross-sheet ranges as boundary', async () => {
    const initial = {
      Data: [[1], [2], [3], [4]],
      Agg: [['=SUM(Data!A1:A4)'], ['=AVERAGE(Data!A1:A4)'], ['=MAX(Data!A1:A4)']],
    };
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    await parallelRecalc(pw);
    sw.recalculate();
    expectSameValues(pw, sw);
    expect(TypedView.toJson(val(pw, 'Agg', 0, 0))).toBe(10);
  });

  it('named expressions replicate in workers', async () => {
    const mk = () => {
      const wb = new EngineWorkbook({
        S1: [[100]],
        S2: [['=Rate*2'], ['=S1!A1*Rate']],
      });
      wb.addNamedExpression('Rate', 'S1!$A$1');
      wb.setCalculationMode('manual');
      return wb;
    };
    const pw = mk();
    pw.setCalculationMode('manual');
    const sw = mk();
    sw.setCalculationMode('manual');
    await parallelRecalc(pw);
    sw.recalculate();
    expectSameValues(pw, sw);
    expect(TypedView.toJson(val(pw, 'S2', 0, 0))).toBe(200);
  });

  it('dirty literals merge with fresh values (no stale cache)', async () => {
    // Regression: the merge used to include formula cells only, leaving
    // edited literals with stale pre-recalc values in manual mode.
    const mk = () => {
      const wb = new EngineWorkbook({ A: [[1], [2], ['=A1+A2']], B: [[10], ['=A1*2']] });
      wb.setCalculationMode('manual');
      wb.setCell({ sheet: 'A', row: 0, col: 0 }, 999);
      return wb;
    };
    const pw = mk();
    const sw = mk();
    const { parallel } = await parallelRecalc(pw);
    expect(parallel).toBe(true);
    sw.recalculate();
    expectSameValues(pw, sw);
    expect(TypedView.toJson(val(pw, 'A', 0, 0))).toBe(999);
    expect(TypedView.toJson(val(pw, 'A', 2, 0))).toBe(1001);
  });

  it('deterministic across repeated runs', async () => {
    const initial = {
      A: [[3], ['=A1^2']],
      B: [['=A!A2*2']],
    };
    const first = async (): Promise<string> => {
      const wb = serialTwin(initial);
      await parallelRecalc(wb);
      return JSON.stringify([...readAll(wb).entries()].sort());
    };
    expect(await first()).toBe(await first());
  });

  it('larger multi-sheet workbook', async () => {
    const initial: Record<string, (string | number)[][]> = {};
    for (let s = 0; s < 6; s++) {
      const grid: (string | number)[][] = [];
      for (let r = 0; r < 50; r++) {
        grid.push([r + 1, s * 100 + r, `=A${r + 1}*B${r + 1}`, `=SUM(C${r + 1}:C${r + 1})+${s}`]);
      }
      initial[`Sheet${s}`] = grid;
    }
    // One dependent sheet reading all others.
    initial['Total'] = [['=SUM(Sheet0!C1:C50,Sheet1!C1:C50)']];
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    const { parallel } = await parallelRecalc(pw);
    expect(parallel).toBe(true);
    sw.recalculate();
    expectSameValues(pw, sw);
  });
});

describe('fallbacks', () => {
  it('single partition falls back to serial with fresh values', async () => {
    const wb = serialTwin({ Only: [[1], [2], ['=A1+A2']] });
    const { parallel, reason } = await parallelRecalc(wb);
    expect(parallel).toBe(false);
    expect(reason).toMatch(/single partition/);
    expect(TypedView.toJson(val(wb, 'Only', 2, 0))).toBe(3);
  });

  it('below threshold falls back to serial', async () => {
    const wb = serialTwin({ A: [['=1+1']], B: [['=2+2']] });
    const { parallel, reason } = await parallelRecalc(wb, { minFormulaCells: 100000 });
    expect(parallel).toBe(false);
    expect(reason).toMatch(/below threshold/);
  });

  it('provider-backed functions fall back to serial', async () => {
    const wb = serialTwin({ A: [['=PY("result=1")']], B: [['=1+1']] });
    const { parallel, reason } = await parallelRecalc(wb);
    expect(parallel).toBe(false);
    expect(reason).toMatch(/provider-backed/);
  });

  it('disabled option falls back to serial', async () => {
    const wb = serialTwin({ A: [['=1+1']], B: [['=2+2']] });
    wb.setParallelRecalcOptions({ enabled: false, minFormulaCells: 0 });
    const stats = await wb.recalculateParallel();
    expect(stats.parallel).toBe(false);
    wb.disposeParallelWorkers();
  });

  it('worker error falls back to serial with fresh values', async () => {
    const wb = serialTwin({ A: [['=1+1']], B: [['=2+2']] });
    const boom = {
      create: () => ({
        run: async () => {
          throw new Error('boom');
        },
        dispose: () => {},
      }),
    };
    wb.setParallelRecalcOptions({
      enabled: true,
      workerCount: 2,
      minFormulaCells: 0,
      cellCountThreshold: 0,
      factory: boom,
    });
    const stats = await wb.recalculateParallel();
    expect(stats.parallel).toBe(false);
    expect(stats.reason).toMatch(/worker error/);
    expect(TypedView.toJson(val(wb, 'B', 0, 0))).toBe(4);
    wb.disposeParallelWorkers();
  });
});

describe('executePartition wire-level', () => {
  let wbSeq = 0;
  function req(partial: Partial<RecalcRequest>): RecalcRequest {
    return {
      jobId: 't1',
      workbookId: `test-wb-${++wbSeq}`,
      fullRebuild: false,
      deltaOnly: false,
      sheets: [],
      boundarySheets: [],
      definedNames: [],
      namedExpressions: [],
      language: 'enGB',
      ...partial,
    };
  }

  it('computes a simple partition', () => {
    const res = executePartition(
      req({
        sheets: [{ name: 'S', cells: [{ row: 0, col: 0, input: 3 }, { row: 1, col: 0, input: '=A1*2' }] }],
      }),
    );
    expect(res.values).toHaveLength(2);
    const v = res.values.find((x) => x.row === 1)!.value;
    expect(v).toBe(6);
  });

  it('resolves boundary literals', () => {
    const res = executePartition(
      req({
        sheets: [{ name: 'B', cells: [{ row: 0, col: 0, input: '=Up!A1+1' }] }],
        boundarySheets: [{ name: 'Up', cells: [{ row: 0, col: 0, value: 41 }] }],
      }),
    );
    expect(res.values.find((x) => x.row === 0)!.value).toBe(42);
  });

  it('maps boundary error values to reproducing formulas', () => {
    const cases: Array<[JsonValue, unknown]> = [
      [{ error: '#DIV/0!' }, { error: '#DIV/0!' }],
      [{ error: '#N/A' }, { error: '#N/A' }],
      [{ error: '#NUM!' }, { error: '#NUM!' }],
      [{ error: '#VALUE!' }, { error: '#VALUE!' }],
      [{ error: '#REF!' }, { error: '#REF!' }],
    ];
    for (const [boundary, expected] of cases) {
      const res = executePartition(
        req({
          sheets: [{ name: 'B', cells: [{ row: 0, col: 0, input: '=Up!A1' }] }],
          boundarySheets: [{ name: 'Up', cells: [{ row: 0, col: 0, value: boundary }] }],
        }),
      );
      expect(res.values.find((x) => x.row === 0)!.value, JSON.stringify(boundary)).toEqual(expected);
    }
  });

  it('throws on unmappable boundary values', () => {
    expect(() =>
      executePartition(
        req({
          sheets: [{ name: 'B', cells: [{ row: 0, col: 0, input: '=Up!A1' }] }],
          boundarySheets: [{ name: 'Up', cells: [{ row: 0, col: 0, value: { error: '#PERM!' } }] }],
        }),
      ),
    ).toThrow(/unmappable boundary/);
  });

  it('caches the workbook and applies only diffs on repeat calls', () => {
    const wid = 'cache-test-1';
    const mkReq = (a1: number): RecalcRequest =>
      req({
        workbookId: wid,
        sheets: [{ name: 'S', cells: [{ row: 0, col: 0, input: a1 }, { row: 1, col: 0, input: '=A1*2' }] }],
      });
    const r1 = executePartition(mkReq(10));
    expect(r1.values.find((x) => x.row === 1)!.value).toBe(20);
    // Second call with a changed input: cache hit, delta applied.
    const r2 = executePartition(mkReq(21));
    expect(r2.values.find((x) => x.row === 0)!.value).toBe(21);
    expect(r2.values.find((x) => x.row === 1)!.value).toBe(42);
    // Deletion: drop A1 from the request.
    const r3 = executePartition(
      req({
        workbookId: wid,
        sheets: [{ name: 'S', cells: [{ row: 1, col: 0, input: '=A1*2' }] }],
      }),
    );
    expect(r3.values.find((x) => x.row === 1)!.value).toBe(0);
  });

  it('fullRebuild ignores the cache', () => {
    const wid = 'cache-test-2';
    executePartition(
      req({ workbookId: wid, sheets: [{ name: 'S', cells: [{ row: 0, col: 0, input: 5 }] }] }),
    );
    const r = executePartition(
      req({
        workbookId: wid,
        fullRebuild: true,
        sheets: [{ name: 'S', cells: [{ row: 0, col: 0, input: 7 }] }],
      }),
    );
    expect(r.values.find((x) => x.row === 0)!.value).toBe(7);
  });

  it('clearPartitionCache resets worker state', () => {
    const wid = 'cache-test-3';
    executePartition(
      req({ workbookId: wid, sheets: [{ name: 'S', cells: [{ row: 0, col: 0, input: 1 }] }] }),
    );
    clearPartitionCache();
    // After clearing, the next call rebuilds (no stale state).
    const r = executePartition(
      req({ workbookId: wid, sheets: [{ name: 'S', cells: [{ row: 0, col: 0, input: 2 }] }] }),
    );
    expect(r.values.find((x) => x.row === 0)!.value).toBe(2);
  });

  it('deltaOnly applies deltas without a deletion pass', () => {
    const wid = 'cache-test-4';
    // Full build first.
    executePartition(
      req({
        workbookId: wid,
        sheets: [
          {
            name: 'S',
            cells: [
              { row: 0, col: 0, input: 10 },
              { row: 1, col: 0, input: 20 },
              { row: 2, col: 0, input: '=A1+A2' },
            ],
          },
        ],
      }),
    );
    // Delta: only A1 changed. A2 must NOT be deleted.
    const r = executePartition(
      req({
        workbookId: wid,
        deltaOnly: true,
        sheets: [{ name: 'S', cells: [{ row: 0, col: 0, input: 15 }] }],
      }),
    );
    const byRow = new Map(r.values.map((v) => [v.row, v.value]));
    expect(byRow.get(0)).toBe(15);
    expect(byRow.get(1)).toBe(20); // still there (no deletion pass)
    expect(byRow.get(2)).toBe(35);
  });

  it('deltaOnly without a warm cache throws a cache-miss error', () => {
    expect(() =>
      executePartition(
        req({ workbookId: 'never-warmed', deltaOnly: true, sheets: [{ name: 'S', cells: [] }] }),
      ),
    ).toThrow(/cache miss on delta request/);
  });

  it('response values are deterministically ordered', () => {
    const res = executePartition(
      req({
        sheets: [
          {
            name: 'B',
            cells: [
              { row: 2, col: 1, input: '=1' },
              { row: 0, col: 0, input: '=2' },
            ],
          },
          { name: 'A', cells: [{ row: 0, col: 0, input: '=3' }] },
        ],
      }),
    );
    expect(res.values.map((v) => `${v.sheet}${v.row},${v.col}`)).toEqual(['A0,0', 'B0,0', 'B2,1']);
  });
});

describe('options', () => {
  it('normalizeParallelOptions clamps worker count', () => {
    // 0/undefined = default; negatives clamp to 1; huge clamps to 64.
    expect(normalizeParallelOptions({ enabled: true, workerCount: 0 }).workerCount).toBe(
      defaultWorkerCount(),
    );
    expect(normalizeParallelOptions({ enabled: true, workerCount: -3 }).workerCount).toBe(1);
    expect(normalizeParallelOptions({ enabled: true, workerCount: 1000 }).workerCount).toBe(64);
    expect(normalizeParallelOptions({}).enabled).toBe(false);
  });

  it('defaultWorkerCount is positive', () => {
    expect(defaultWorkerCount()).toBeGreaterThan(0);
  });

  it('setParallelRecalcOptions round-trips on the workbook', () => {
    const wb = new EngineWorkbook();
    wb.setParallelRecalcOptions({ enabled: true, workerCount: 3, minFormulaCells: 10 });
    expect(wb.getParallelRecalcOptions()).toMatchObject({
      enabled: true,
      workerCount: 3,
      minFormulaCells: 10,
    });
    wb.disposeParallelWorkers();
  });
});

describe('NodeWorkerBackend (real worker_threads)', () => {
  const workerPath = join(process.cwd(), 'dist/parallel/node-worker.js');

  it('computes across real threads with identical results', async () => {    // Requires `npm run build` first; skip gracefully otherwise.
    const { existsSync } = await import('node:fs');
    if (!existsSync(workerPath)) {
      console.warn('skipping: dist not built');
      return;
    }
    const initial = {
      A: [[4], ['=A1*A1']],
      B: [['=A!A2+1']],
      C: [[2], ['=C1*3']],
    };
    const backend = new NodeWorkerBackend(workerPath);
    try {
      const pw = serialTwin(initial);
      pw.setParallelRecalcOptions({
        enabled: true,
        workerCount: 2,
        minFormulaCells: 0,
        cellCountThreshold: 0,
        factory: { create: () => backend },
      });
      const stats = await pw.recalculateParallel();
      expect(stats.parallel).toBe(true);
      expect(stats.workersUsed).toBe(2);
      const sw = serialTwin(initial);
      sw.recalculate();
      expectSameValues(pw, sw);
      expect(TypedView.toJson(val(pw, 'B', 0, 0))).toBe(17);
    } finally {
      backend.dispose();
    }
  }, 60000);

  it('pool distributes across backends', async () => {
    const { existsSync } = await import('node:fs');
    if (!existsSync(workerPath)) {
      console.warn('skipping: dist not built');
      return;
    }
    const { RecalcWorkerPool } = await import('../src/index.js');
    const pool = new RecalcWorkerPool({ create: () => new NodeWorkerBackend(workerPath) }, 2);
    try {
      const base: RecalcRequest = {
        jobId: 'x',
        sheets: [{ name: 'S', cells: [{ row: 0, col: 0, input: '=1+1' }] }],
        boundarySheets: [],
        definedNames: [],
        language: 'enGB',
      };
      const results = await pool.runAll([
        { ...base, jobId: 'a' },
        { ...base, jobId: 'b' },
        { ...base, jobId: 'c' },
      ]);
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.values.find((v) => v.row === 0)!.value).toBe(2);
      }
    } finally {
      pool.dispose();
    }
  }, 60000);
});

describe('ParallelRecalculator guards', () => {
  it('exposes stats on the serial path', async () => {
    const wb = serialTwin({ A: [['=1']] });
    const recalc = new ParallelRecalculator();
    const { stats } = await recalc.recalculate(wb, normalizeParallelOptions({ enabled: true }));
    expect(stats.parallel).toBe(false);
    expect(typeof stats.elapsedMs).toBe('number');
  });
});

describe('automatic-multithreading flag (Cycle 10)', () => {
  it('shouldEnableParallelRecalc: strictly greater than threshold', () => {
    expect(shouldEnableParallelRecalc(5000, 5000)).toBe(false);
    expect(shouldEnableParallelRecalc(5001, 5000)).toBe(true);
    expect(shouldEnableParallelRecalc(4999, 5000)).toBe(false);
    expect(shouldEnableParallelRecalc(0)).toBe(false);
    expect(shouldEnableParallelRecalc(6000)).toBe(true);
    // Defensive: non-finite / negative inputs never enable.
    expect(shouldEnableParallelRecalc(NaN)).toBe(false);
    expect(shouldEnableParallelRecalc(-3)).toBe(false);
    expect(shouldEnableParallelRecalc(Infinity)).toBe(false);
    expect(shouldEnableParallelRecalc(6000, NaN)).toBe(true); // falls back to default
  });

  it('default threshold is 5000 (pending Phase 4 tuning)', () => {
    expect(DEFAULT_PARALLEL_CELL_THRESHOLD).toBe(5000);
  });

  it('resolveParallelCellThreshold reads the env seam, falls back on garbage', () => {
    expect(resolveParallelCellThreshold({})).toBe(5000);
    expect(resolveParallelCellThreshold({ ICECREAM_PARALLEL_CELL_THRESHOLD: '12000' })).toBe(12000);
    expect(resolveParallelCellThreshold({ ICECREAM_PARALLEL_CELL_THRESHOLD: '0' })).toBe(0);
    expect(resolveParallelCellThreshold({ ICECREAM_PARALLEL_CELL_THRESHOLD: 'nope' })).toBe(5000);
    expect(resolveParallelCellThreshold({ ICECREAM_PARALLEL_CELL_THRESHOLD: '-5' })).toBe(5000);
    expect(resolveParallelCellThreshold({ ICECREAM_PARALLEL_CELL_THRESHOLD: '' })).toBe(5000);
    // Canonical name (shared with the routing layer) takes precedence.
    expect(resolveParallelCellThreshold({ ICECREAM_MT_CELL_COUNT_THRESHOLD: '7000' })).toBe(7000);
    expect(
      resolveParallelCellThreshold({
        ICECREAM_MT_CELL_COUNT_THRESHOLD: '7000',
        ICECREAM_PARALLEL_CELL_THRESHOLD: '1000',
      }),
    ).toBe(7000);
    expect(resolveParallelCellThreshold({ ICECREAM_MT_CELL_COUNT_THRESHOLD: 'junk' })).toBe(5000);
  });

  it('normalizeParallelOptions defaults the gate to 5000 and clamps', () => {
    expect(normalizeParallelOptions({}).cellCountThreshold).toBe(5000);
    expect(normalizeParallelOptions({ cellCountThreshold: 12000 }).cellCountThreshold).toBe(12000);
    expect(normalizeParallelOptions({ cellCountThreshold: -7 }).cellCountThreshold).toBe(0);
  });

  it('gate: small workbook stays single-threaded even with parallel enabled', async () => {
    const wb = serialTwin({ A: [['=1+1']], B: [['=2+2']] });
    const recalc = new ParallelRecalculator();
    // Default options: enabled + the 5000-cell gate active.
    const { stats } = await recalc.recalculate(wb, normalizeParallelOptions({ enabled: true }));
    expect(stats.parallel).toBe(false);
    expect(stats.reason).toMatch(/auto-MT cell threshold/);
  });

  it('gate: >5000 non-empty cells auto-enables multithreading', async () => {
    // 6,000 non-empty cells, all formulas independent (depth 0): with the
    // gate satisfied the parallel path engages.
    const grid: (string | number)[][] = [];
    for (let r = 0; r < 3000; r++) {
      grid.push([r, `=A${r + 1}*2`]);
    }
    const mk = () => {
      const wb = new EngineWorkbook({ S: grid });
      wb.setCalculationMode('manual');
      wb.setParallelRecalcOptions({
        enabled: true,
        workerCount: 2,
        minFormulaCells: 0,
        // Default gate (5000) applies — the fixture has 6000 cells.
        factory: { create: () => new InlineWorkerBackend() },
      });
      return wb;
    };
    const pw = mk();
    const stats = await pw.recalculateParallel();
    expect(stats.parallel).toBe(true);
    expect(stats.partitions).toBeGreaterThanOrEqual(2);
    const sw = mk();
    sw.setParallelRecalcOptions({ enabled: false });
    sw.recalculate();
    expectSameValues(pw, sw);
    pw.disposeParallelWorkers();
    sw.disposeParallelWorkers();
  });

  it('gate escape hatch: cellCountThreshold 0 gates on any cell at all', async () => {
    // Single-chain workbook: with the cell gate satisfied (threshold 0),
    // the guard that fires is 'no independent chains'.
    const wb = serialTwin({ A: [[1], ['=A1+1']] });
    const recalc = new ParallelRecalculator();
    const { stats } = await recalc.recalculate(
      wb,
      normalizeParallelOptions({ enabled: true, cellCountThreshold: 0, minFormulaCells: 0 }),
    );
    expect(stats.parallel).toBe(false);
    expect(stats.reason).toMatch(/single partition/);
});
});

describe('parallel == serial: chain semantics (Cycle 10)', () => {
  it('two independent chains on ONE sheet', async () => {
    const initial = {
      S: [
        [1, '=A1*2'],
        [10, 20],
        ['=B2*2', '=A1+B1+B2+A3'],
      ],
    };
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    const { parallel } = await parallelRecalc(pw, { workerCount: 4 });
    expect(parallel).toBe(true);
    sw.recalculate();
    expectSameValues(pw, sw);
    expect(TypedView.toJson(val(pw, 'S', 0, 1))).toBe(2);
    expect(TypedView.toJson(val(pw, 'S', 2, 0))).toBe(40);
  });

  it('diamonds: parallel middle layer, exact top value', async () => {
    const initial = {
      In: [[7]],
      B: [['=In!A1+1']],
      C: [['=In!A1*3']],
      Out: [['=B!A1^2+C!A1^2']],
    };
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    const { parallel } = await parallelRecalc(pw, { workerCount: 4 });
    expect(parallel).toBe(true);
    sw.recalculate();
    expectSameValues(pw, sw);
    expect(TypedView.toJson(val(pw, 'Out', 0, 0))).toBe(505);
  });

  it('same-sheet staged chains (deep dependent chain stays correct)', async () => {
    const initial = {
      S: [[2], ['=A1*3'], ['=A2+10'], ['=A3*A3'], ['=SUM(A1:A4)']],
    };
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    const { parallel } = await parallelRecalc(pw);
    expect(parallel).toBe(false); // single chain: nothing independent at any stage
    sw.recalculate();
    expectSameValues(pw, sw);
    expect(TypedView.toJson(val(pw, 'S', 4, 0))).toBe(2 + 6 + 16 + 256);
  });

  it('multi-stage cross-sheet chains with staged boundary values', async () => {
    const initial = {
      Raw: [[3], [5]],
      T1: [['=Raw!A1*Raw!A2']],
      T2: [['=T1!A1+Raw!A1']],
      T3: [['=T2!A1-T1!A1'], ['=Raw!A2^2']],
    };
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    const { parallel } = await parallelRecalc(pw, { workerCount: 4 });
    expect(parallel).toBe(true);
    sw.recalculate();
    expectSameValues(pw, sw);
    expect(TypedView.toJson(val(pw, 'T3', 0, 0))).toBe(3);
    expect(TypedView.toJson(val(pw, 'T3', 1, 0))).toBe(25);
  });

  it('formula-heavy fixture: exact values after staged parallel merge', async () => {
    const initial: Record<string, (string | number)[][]> = {};
    for (let s = 0; s < 4; s++) {
      const grid: (string | number)[][] = [];
      for (let r = 0; r < 40; r++) {
        grid.push([
          r + 1,
          `=A${r + 1}*${s + 1}`,
          `=B${r + 1}+A${r + 1}`,
          `=SUM(A${r + 1}:C${r + 1})`,
        ]);
      }
      initial[`Chain${s}`] = grid;
    }
    initial['Summary'] = [
      ['=SUM(Chain0!D1:D40)'],
      ['=SUM(Chain1!D1:D40,Chain2!D1:D40)'],
      ['=A1+A2+SUM(Chain3!D1:D40)'],
    ];
    const pw = serialTwin(initial);
    const sw = serialTwin(initial);
    const { parallel } = await parallelRecalc(pw, { workerCount: 4 });
    expect(parallel).toBe(true);
    sw.recalculate();
    expectSameValues(pw, sw);
  });

  it('worksheets edited between recalcs stay identical (warm worker cache)', async () => {
    const mk = () => {
      const wb = new EngineWorkbook({
        A: [[1], ['=A1*2']],
        B: [[10], ['=A1*2']],
      });
      wb.setCalculationMode('manual');
      return wb;
    };
    const pw = mk();
    pw.setParallelRecalcOptions({
      enabled: true,
      workerCount: 2,
      minFormulaCells: 0,
      cellCountThreshold: 0,
      factory: { create: () => new InlineWorkerBackend() },
    });
    await pw.recalculateParallel();
    // Edit an input, recalc again — workers reuse their warm caches.
    pw.setCell({ sheet: 'A', row: 0, col: 0 }, 5);
    const stats = await pw.recalculateParallel();
    expect(stats.parallel).toBe(true);
    const sw = mk();
    sw.setCell({ sheet: 'A', row: 0, col: 0 }, 5);
    sw.recalculate();
    expectSameValues(pw, sw);
    expect(TypedView.toJson(val(pw, 'B', 1, 0))).toBe(20);
    expect(TypedView.toJson(val(pw, 'A', 1, 0))).toBe(10);
    pw.disposeParallelWorkers();
  });
});

describe('worker cache: partitionId disambiguation', () => {
  let seq = 0;
  function req(partial: Parameters<typeof executePartition>[0]): Parameters<typeof executePartition>[0] {
    return {
      jobId: 't',
      workbookId: `pid-test-${++seq}`,
      fullRebuild: false,
      deltaOnly: false,
      sheets: [],
      boundarySheets: [],
      definedNames: [],
      namedExpressions: [],
      language: 'enGB',
      ...partial,
    };
  }

  it('two partitions owning different cells of the SAME sheet do not collide', () => {
    // Inline backends share one in-process cache: without partitionId in
    // the key, the second partition would reuse the first's workbook.
    const wid = 'collision-wb';
    const mk = (partitionId: string, cells: Array<{ row: number; col: number; input: string | number }>) =>
      req({ workbookId: wid, partitionId, sheets: [{ name: 'S', cells }] });
    const r1 = executePartition(mk('s0p0', [{ row: 0, col: 0, input: '=1+1' }]));
    const r2 = executePartition(mk('s0p1', [{ row: 1, col: 0, input: '=2*3' }]));
    expect(r1.values).toHaveLength(1);
    expect(r1.values[0]).toMatchObject({ row: 0, value: 2 });
    expect(r2.values).toHaveLength(1);
    expect(r2.values[0]).toMatchObject({ row: 1, value: 6 });
  });
});
