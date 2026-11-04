/**
 * Cycle 10 Phase 3 — calc-chain measurement, threshold config, routing policy.
 *
 * Part A: shape/length semantics on hand-built fake graphs (exact control).
 * Part B: real EngineWorkbook fixtures (HyperFormula graph integration:
 *   diamonds, ranges, cross-sheet, defined names, merges, cycles).
 * Part C: threshold config (defaults, normalize, env seam, workbook option).
 * Part D: routing policy — tiny hatch, mirror mode, structural rule,
 *   the full fail-safe table, offline, MT orthogonality.
 * Part E: workbook integration (measureCalcChain / routeEditRecalc / mirrorMode).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAIN_LENGTH_THRESHOLD,
  DEFAULT_MT_CELL_COUNT_THRESHOLD,
  DEFAULT_TINY_SET_THRESHOLD,
  EngineWorkbook,
  autoMtEnabled,
  deriveMirrorMode,
  hybridRecalcConfigFromEnv,
  measureCalcChain,
  normalizeHybridRecalcConfig,
  routeRecalc,
  type CalcChainGraphSource,
  type CellRef,
  type GraphDependent,
  type GraphTarget,
  type RouteRecalcInput,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({
  sheet,
  row,
  col,
});

// ---------------------------------------------------------------------------
// Part A: fake graphs
// ---------------------------------------------------------------------------

/** Build a CalcChainGraphSource from an adjacency map. Node ids are strings. */
function fakeGraph(
  edges: Record<string, string[]>,
  opts: {
    cellAddr?: Record<string, { sheet: number; row: number; col: number }>;
    neIndex?: Record<string, number>;
    ranges?: Record<string, GraphTarget>;
    unknownSheets?: Set<number>;
    unresolvableNE?: Set<number>;
  } = {},
): { source: CalcChainGraphSource; addrOf: (id: string) => { sheet: number; row: number; col: number } } {
  const cellAddr = opts.cellAddr ?? {};
  const neIndex = opts.neIndex ?? {};
  const addrOf = (id: string) => {
    if (cellAddr[id]) return cellAddr[id];
    throw new Error(`no addr for ${id}`);
  };
  const source: CalcChainGraphSource = {
    dependentsOf: (target: GraphTarget): GraphDependent[] => {
      let id: string | undefined;
      if ('start' in target) {
        id = Object.keys(opts.ranges ?? {}).find(
          (k) => opts.ranges![k] === target,
        );
      } else if (target.sheet === -1) {
        id = Object.keys(neIndex).find((k) => neIndex[k] === target.row);
      } else {
        id = Object.keys(cellAddr).find((k) => {
          const a = cellAddr[k];
          return a.sheet === target.sheet && a.row === target.row && a.col === target.col;
        });
      }
      if (id === undefined) return [];
      return (edges[id] ?? []).map((depId): GraphDependent => {
        if (opts.ranges && opts.ranges[depId]) return opts.ranges[depId] as GraphDependent;
        if (neIndex[depId] !== undefined)
          return { sheet: -1, row: neIndex[depId], col: 0 };
        const a = addrOf(depId);
        return { sheet: a.sheet, row: a.row, col: a.col };
      });
    },
    sheetName: (sheetId: number) =>
      opts.unknownSheets?.has(sheetId) ? undefined : `Sheet${sheetId}`,
    namedExpression: (index: number) => {
      if (opts.unresolvableNE?.has(index)) return undefined;
      const id = Object.keys(neIndex).find((k) => neIndex[k] === index);
      return id === undefined ? undefined : { name: id };
    },
  };
  return { source, addrOf };
}

function cellIds(n: number): Record<string, { sheet: number; row: number; col: number }> {
  const out: Record<string, { sheet: number; row: number; col: number }> = {};
  for (let i = 0; i < n; i++) out[`n${i}`] = { sheet: 0, row: i, col: 0 };
  return out;
}

describe('measureCalcChain on hand-built graphs', () => {
  it('a linear chain is single with its length', () => {
    const { source, addrOf } = fakeGraph(
      { n0: ['n1'], n1: ['n2'], n2: ['n3'], n3: [] },
      { cellAddr: cellIds(4) },
    );
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(3);
    expect(m.affectedCount).toBe(3);
    expect(m.exact).toBe(true);
    expect(m.cells.map((r) => r.row)).toEqual([1, 2, 3]);
    expect(m.namedExpressions).toEqual([]);
  });

  it('a diamond is multiple chains; cells still counted once, length null', () => {
    const { source, addrOf } = fakeGraph(
      { n0: ['n1', 'n2'], n1: ['n3'], n2: ['n3'], n3: [] },
      { cellAddr: cellIds(4) },
    );
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.shape).toBe('multiple-chains');
    expect(m.chainLength).toBeNull();
    expect(m.affectedCount).toBe(3);
    expect(m.cells).toHaveLength(3);
  });

  it('a cycle back into the edited cell is multiple chains and terminates', () => {
    const { source, addrOf } = fakeGraph(
      { n0: ['n1'], n1: ['n2'], n2: ['n0'] },
      { cellAddr: cellIds(3) },
    );
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.shape).toBe('multiple-chains');
    expect(m.affectedCount).toBe(2);
    expect(m.exact).toBe(true);
  });

  it('an in-cycle merge (in-degree 2, all out-degrees 1) is multiple chains', () => {
    const { source, addrOf } = fakeGraph(
      { n0: ['n1'], n1: ['n2'], n2: ['n1'] },
      { cellAddr: cellIds(3) },
    );
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.shape).toBe('multiple-chains');
    expect(m.affectedCount).toBe(2);
  });

  it('follows range vertices through to their users without counting them', () => {
    const range: GraphTarget = {
      start: { sheet: 0, row: 0, col: 0 },
      end: { sheet: 0, row: 9, col: 0 },
    };
    const { source, addrOf } = fakeGraph(
      { n0: ['r0'], r0: ['n1'], n1: [] },
      { cellAddr: cellIds(2), ranges: { r0: range } },
    );
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(1);
    expect(m.cells[0].row).toBe(1);
  });

  it('traverses named-expression vertices (counting each as one unit)', () => {
    const { source, addrOf } = fakeGraph(
      { n0: ['TaxRate'], TaxRate: ['n1'], n1: [] },
      { cellAddr: cellIds(2), neIndex: { TaxRate: 0 } },
    );
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(2);
    expect(m.namedExpressions).toEqual([{ index: 0, name: 'TaxRate', scope: undefined }]);
    expect(m.cells).toHaveLength(1);
  });

  it('traverses defined-name range indirection (cell -> range -> NE -> cell)', () => {
    const range: GraphTarget = {
      start: { sheet: 0, row: 0, col: 0 },
      end: { sheet: 0, row: 2, col: 0 },
    };
    const { source, addrOf } = fakeGraph(
      { n0: ['r0'], r0: ['DataCol'], DataCol: ['n1'], n1: [] },
      { cellAddr: cellIds(2), ranges: { r0: range }, neIndex: { DataCol: 3 } },
    );
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(2);
    expect(m.namedExpressions[0].name).toBe('DataCol');
  });

  it('truncates at maxNodes and reports a lower bound', () => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) edges[`n${i}`] = i < 9 ? [`n${i + 1}`] : [];
    const { source, addrOf } = fakeGraph(edges, { cellAddr: cellIds(10) });
    const m = measureCalcChain(source, addrOf('n0'), { maxNodes: 4 });
    expect(m.chainLength).toBe(4);
    expect(m.exact).toBe(false);
    const full = measureCalcChain(source, addrOf('n0'));
    expect(full.chainLength).toBe(9);
    expect(full.exact).toBe(true);
  });

  it('skips dependents on unknown sheets but keeps walking', () => {
    const { source, addrOf } = fakeGraph(
      { n0: ['n1', 'n2'], n1: [], n2: ['n3'], n3: [] },
      {
        cellAddr: {
          n0: { sheet: 0, row: 0, col: 0 },
          n1: { sheet: 99, row: 0, col: 0 }, // unknown sheet
          n2: { sheet: 0, row: 2, col: 0 },
          n3: { sheet: 0, row: 3, col: 0 },
        },
        unknownSheets: new Set([99]),
      },
    );
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.affectedCount).toBe(2); // n2, n3 — n1 skipped
    expect(m.shape).toBe('single-chain');
  });

  it('keeps traversing through unresolvable named expressions', () => {
    const { source, addrOf } = fakeGraph(
      { n0: ['Ghost'], Ghost: ['n1'], n1: [] },
      {
        cellAddr: cellIds(2),
        neIndex: { Ghost: 7 },
        unresolvableNE: new Set([7]),
      },
    );
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.affectedCount).toBe(2); // ghost NE + n1
    expect(m.namedExpressions[0].name).toContain('unresolved');
  });

  it('an edit with no dependents is a single chain of length 0', () => {
    const { source, addrOf } = fakeGraph({ n0: [] }, { cellAddr: cellIds(1) });
    const m = measureCalcChain(source, addrOf('n0'));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(0);
    expect(m.exact).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part B: real EngineWorkbook fixtures
// ---------------------------------------------------------------------------

describe('measureCalcChain on real workbooks', () => {
  it('counts a linear chain', () => {
    const wb = new EngineWorkbook({
      Sheet1: [[1, '=A1+1', '=B1*2', '=C1+1']],
    });
    const m = wb.measureCalcChain(c('Sheet1', 0, 0));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(3);
    expect(m.cells.map((r) => r.col)).toEqual([1, 2, 3]);
  });

  it('a diamond is multiple chains, each cell counted once', () => {
    const wb = new EngineWorkbook({
      Sheet1: [[1, '=A1+1', '=A1+2', '=B1+C1']],
    });
    const m = wb.measureCalcChain(c('Sheet1', 0, 0));
    expect(m.shape).toBe('multiple-chains');
    expect(m.chainLength).toBeNull();
    expect(m.affectedCount).toBe(3);
    expect(m.cells).toHaveLength(3);
  });

  it('handles range dependents without expanding the range', () => {
    const rows: (number | string)[][] = [];
    for (let r = 0; r < 10; r++) rows.push([r + 1, '', '', '', r === 0 ? '=SUM(A1:A10)' : '']);
    const wb = new EngineWorkbook({ Sheet1: rows });
    const m = wb.measureCalcChain(c('Sheet1', 4, 0));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(1);
    expect(m.cells[0]).toEqual({ sheet: 'Sheet1', row: 0, col: 4 });
    const m2 = wb.measureCalcChain(c('Sheet1', 0, 0));
    expect(m2.chainLength).toBe(1);
  });

  it('follows cross-sheet dependents (fanning out = multiple chains)', () => {
    const wb = new EngineWorkbook({
      Sheet1: [[5, '=A1*2']],
      Sheet2: [['=Sheet1!A1*10', '=A1+1']],
    });
    const m = wb.measureCalcChain(c('Sheet1', 0, 0));
    // B1 (same sheet) + Sheet2!A1 + Sheet2!B1 (via Sheet2!A1): two branches.
    expect(m.shape).toBe('multiple-chains');
    expect(m.affectedCount).toBe(3);
    const sheets = m.cells.map((r) => r.sheet).sort();
    expect(sheets).toEqual(['Sheet1', 'Sheet2', 'Sheet2']);
  });

  it('traverses defined-name (value) indirection', () => {
    const wb = new EngineWorkbook({ Sheet1: [[10, '=TaxRate+1']] });
    wb.addNamedExpression('TaxRate', '=Sheet1!$A$1*0.2');
    const m = wb.measureCalcChain(c('Sheet1', 0, 0));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(2);
    expect(m.namedExpressions).toHaveLength(1);
    expect(m.namedExpressions[0].name).toBe('TaxRate');
    expect(m.cells[0]).toEqual({ sheet: 'Sheet1', row: 0, col: 1 });
  });

  it('traverses named-expression chains (name -> name -> cell)', () => {
    const wb = new EngineWorkbook({ Sheet1: [[10, '', '=DoubleTax+1']] });
    wb.addNamedExpression('TaxRate', '=Sheet1!$A$1*0.2');
    wb.addNamedExpression('DoubleTax', '=TaxRate*2');
    const m = wb.measureCalcChain(c('Sheet1', 0, 0));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(3);
    expect(m.namedExpressions.map((n) => n.name).sort()).toEqual([
      'DoubleTax',
      'TaxRate',
    ]);
    expect(m.cells).toHaveLength(1);
  });

  it('traverses defined-name RANGE indirection', () => {
    const wb = new EngineWorkbook({ Sheet1: [[10], [20], [30], ['=SUM(DataCol)']] });
    wb.addNamedExpression('DataCol', '=Sheet1!$A$1:$A$3');
    const m = wb.measureCalcChain(c('Sheet1', 1, 0));
    // A2 -> range A1:A3 (routing) -> NE DataCol -> A4 (SUM cell)
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(2);
    expect(m.namedExpressions[0].name).toBe('DataCol');
    expect(m.cells[0]).toEqual({ sheet: 'Sheet1', row: 3, col: 0 });
  });

  it('handles whole-column references', () => {
    // SUM over A:A lives in column B: A:A's range vertex routes to it.
    const wb = new EngineWorkbook({ Sheet1: [[1, '=SUM(A:A)'], [2, ''], [3, '']] });
    const m = wb.measureCalcChain(c('Sheet1', 0, 0));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(1);
    expect(m.cells[0]).toEqual({ sheet: 'Sheet1', row: 0, col: 1 });
  });

  it('a formula inside its own summed column is a self-cycle (multiple chains)', () => {
    // =SUM(A:A) placed in A3: A3 is a member of its own range, so the
    // range vertex routes back to A3 — a genuinely cyclic affected set.
    // The structural test classifies it multiple -> server (conservative:
    // local/server cycle semantics are exactly where engines can differ).
    const wb = new EngineWorkbook({ Sheet1: [[1, 2, 3], ['', '', ''], ['=SUM(A:A)']] });
    const m = wb.measureCalcChain(c('Sheet1', 0, 0));
    expect(m.shape).toBe('multiple-chains');
  });

  it('follows spill-source ranges to the array anchor and beyond', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1], [2], [3], ['=A1:A3*2'], ['=A4+1']] });
    const m = wb.measureCalcChain(c('Sheet1', 1, 0));
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(2);
    const coords = m.cells.map((r) => ({ row: r.row, col: r.col }));
    expect(coords).toContainEqual({ row: 3, col: 0 });
    expect(coords).toContainEqual({ row: 4, col: 0 });
  });

  it('a direct edge plus a range path to the same cell is a merge (multiple)', () => {
    // B1 = SUM(A1:A2) reads A1 through the range; A2 = A1+1 reads it
    // directly. Two effective paths reach the recalc work -> not one
    // sequence (conservative structural test, see calc-chain.ts header).
    const wb = new EngineWorkbook({
      Sheet1: [
        [1, '=SUM(A1:A2)'],
        ['=A1+1', ''],
      ],
    });
    const m = wb.measureCalcChain(c('Sheet1', 0, 0));
    expect(m.shape).toBe('multiple-chains');
    expect(m.affectedCount).toBe(2);
  });

  it('truncates a long real chain at maxNodes', () => {
    const rows: (number | string)[][] = [[1]];
    for (let r = 1; r < 300; r++) rows.push([`=A${r}+1`]);
    const wb = new EngineWorkbook({ Sheet1: rows });
    const capped = wb.measureCalcChain(c('Sheet1', 0, 0), { maxNodes: 201 });
    expect(capped.affectedCount).toBe(201);
    expect(capped.exact).toBe(false);
    const full = wb.measureCalcChain(c('Sheet1', 0, 0));
    expect(full.chainLength).toBe(299);
    expect(full.exact).toBe(true);
  });

  it('throws on an invalid cell ref', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]] });
    expect(() => wb.measureCalcChain(c('Nope', 0, 0))).toThrow();
    expect(() => wb.measureCalcChain(c('Sheet1', -1, 0))).toThrow();
  });

  it('calcChainDependents returns one hop', () => {
    const wb = new EngineWorkbook({
      Sheet1: [[1, '=A1+1', '=A1+2', '=B1+C1']],
    });
    const one = wb.calcChainDependents(c('Sheet1', 0, 0));
    expect(one.map((r) => r.col).sort()).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Part C: threshold config
// ---------------------------------------------------------------------------

describe('hybrid recalc config', () => {
  it('has documented defaults', () => {
    expect(DEFAULT_TINY_SET_THRESHOLD).toBe(50);
    expect(DEFAULT_CHAIN_LENGTH_THRESHOLD).toBe(200);
    expect(DEFAULT_MT_CELL_COUNT_THRESHOLD).toBe(5000);
    expect(normalizeHybridRecalcConfig({})).toEqual({
      tinySetThreshold: 50,
      chainLengthThreshold: 200,
      mtCellCountThreshold: 5000,
    });
  });

  it('normalize keeps valid values and floors fractional ones', () => {
    const out = normalizeHybridRecalcConfig({
      tinySetThreshold: 25,
      chainLengthThreshold: 50.9,
      mtCellCountThreshold: 10000,
    });
    expect(out).toEqual({
      tinySetThreshold: 25,
      chainLengthThreshold: 50,
      mtCellCountThreshold: 10000,
    });
  });

  it('normalize falls back to defaults on invalid input', () => {
    for (const bad of [0, -5, NaN, Infinity, 'abc', '']) {
      const out = normalizeHybridRecalcConfig({
        chainLengthThreshold: bad as never,
      });
      expect(out.chainLengthThreshold).toBe(DEFAULT_CHAIN_LENGTH_THRESHOLD);
      const out2 = normalizeHybridRecalcConfig({ tinySetThreshold: bad as never });
      expect(out2.tinySetThreshold).toBe(DEFAULT_TINY_SET_THRESHOLD);
    }
  });

  it('env seam parses valid values and ignores garbage', () => {
    expect(
      hybridRecalcConfigFromEnv({
        ICECREAM_TINY_SET_THRESHOLD: '25',
        ICECREAM_CHAIN_LENGTH_THRESHOLD: '350',
        ICECREAM_MT_CELL_COUNT_THRESHOLD: '8000',
      }),
    ).toEqual({ tinySetThreshold: 25, chainLengthThreshold: 350, mtCellCountThreshold: 8000 });
    expect(
      hybridRecalcConfigFromEnv({
        ICECREAM_CHAIN_LENGTH_THRESHOLD: 'nope',
        ICECREAM_MT_CELL_COUNT_THRESHOLD: '-3',
      }),
    ).toEqual(normalizeHybridRecalcConfig({}));
    expect(hybridRecalcConfigFromEnv({})).toEqual(normalizeHybridRecalcConfig({}));
  });

  it('workbook accepts hybridRecalc overrides via constructor', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]] }, { hybridRecalc: { chainLengthThreshold: 42 } });
    expect(wb.hybridRecalcConfig()).toEqual({
      tinySetThreshold: DEFAULT_TINY_SET_THRESHOLD,
      chainLengthThreshold: 42,
      mtCellCountThreshold: DEFAULT_MT_CELL_COUNT_THRESHOLD,
    });
  });

  it('totalCellCount sums used-range bounding boxes', () => {
    const wb = new EngineWorkbook({
      Sheet1: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      Sheet2: [[1]],
    });
    expect(wb.totalCellCount()).toBe(2 * 3 + 1);
  });

  it('autoMtEnabled / deriveMirrorMode are the shared size-flag predicates', () => {
    expect(autoMtEnabled(5000)).toBe(false);
    expect(autoMtEnabled(5001)).toBe(true);
    expect(autoMtEnabled(5001, 10000)).toBe(false);
    expect(autoMtEnabled(-1)).toBe(false);
    expect(autoMtEnabled(NaN)).toBe(false);
    expect(deriveMirrorMode(5000)).toBe('mirror');
    expect(deriveMirrorMode(5001)).toBe('no-mirror');
    expect(deriveMirrorMode(NaN)).toBe('no-mirror'); // fail-safe
  });
});

// ---------------------------------------------------------------------------
// Part D: routing policy
// ---------------------------------------------------------------------------

const TH = normalizeHybridRecalcConfig({});

function input(partial: Partial<RouteRecalcInput>): RouteRecalcInput {
  return {
    affectedCellCount: 5000,
    shape: 'single-chain',
    chainLength: 10,
    thresholds: TH,
    mirrorMode: 'mirror',
    ...partial,
  };
}

describe('routeRecalc', () => {
  it('tiny set routes local regardless of shape (hatch first, before the shape test)', () => {
    expect(routeRecalc(input({ affectedCellCount: 3, shape: 'multiple-chains', chainLength: null }))).toEqual({
      route: 'local',
      reason: 'tiny-set-local',
    });
    // Even a huge "chain count" inside a tiny set stays local.
    expect(routeRecalc(input({ affectedCellCount: 50, shape: 'single-chain', chainLength: 49 })).route).toBe('local');
    // Boundary: === tiny threshold takes the hatch; +1 falls to the shape test.
    expect(routeRecalc(input({ affectedCellCount: 50, shape: 'multiple-chains', chainLength: null })).reason).toBe('tiny-set-local');
    expect(routeRecalc(input({ affectedCellCount: 51, shape: 'multiple-chains', chainLength: null })).reason).toBe('multiple-chains');
  });

  it('tiny hatch is skipped when the affected count is unknown', () => {
    expect(routeRecalc(input({ affectedCellCount: null, shape: 'multiple-chains', chainLength: null }))).toMatchObject({
      route: 'server',
      reason: 'multiple-chains',
    });
  });

  it('no-mirror mode: ALL edits go to the server, even tiny ones', () => {
    expect(routeRecalc(input({ mirrorMode: 'no-mirror', affectedCellCount: 3, shape: 'multiple-chains', chainLength: null }))).toEqual({
      route: 'server',
      reason: 'no-mirror',
      optimisticDisplay: true,
    });
    expect(routeRecalc(input({ mirrorMode: 'no-mirror', affectedCellCount: 0, shape: 'single-chain', chainLength: 0 })).reason).toBe('no-mirror');
    // Unknown mirror mode fails safe to no-mirror.
    expect(routeRecalc(input({ mirrorMode: null })).reason).toBe('no-mirror');
    expect(routeRecalc(input({ mirrorMode: undefined })).reason).toBe('no-mirror');
  });

  it('single chain: short -> local, long -> server single-threaded', () => {
    expect(routeRecalc(input({ affectedCellCount: 60, chainLength: 10 }))).toEqual({
      route: 'local',
      reason: 'chain-short',
    });
    // Boundary: === threshold is local.
    expect(routeRecalc(input({ affectedCellCount: 200, chainLength: 200 })).reason).toBe('chain-short');
    const long = routeRecalc(input({ affectedCellCount: 201, chainLength: 201 }));
    expect(long).toEqual({
      route: 'server',
      reason: 'chain-long',
      optimisticDisplay: true,
      serverThreading: 'single',
    });
  });

  it('a long single chain is NEVER threaded, even with the MT flag on', () => {
    const d = routeRecalc(input({ affectedCellCount: 5000, chainLength: 4000, mtEnabled: true }));
    expect(d.route).toBe('server');
    expect(d.reason).toBe('chain-long');
    expect(d.serverThreading).toBe('single');
  });

  it('multiple chains -> server always, no length test; MT flag decides threading', () => {
    const multi = { affectedCellCount: 5000, shape: 'multiple-chains' as const, chainLength: null };
    expect(routeRecalc(input({ ...multi, mtEnabled: true }))).toEqual({
      route: 'server',
      reason: 'multiple-chains',
      optimisticDisplay: true,
      serverThreading: 'parallel',
    });
    expect(routeRecalc(input({ ...multi, mtEnabled: false })).serverThreading).toBe('single');
    expect(routeRecalc(input({ ...multi })).serverThreading).toBe('single');
    // Length is never consulted for multiple chains.
    expect(routeRecalc(input({ ...multi, chainLength: 999999 })).reason).toBe('multiple-chains');
  });

  it('the MT flag never changes the ROUTE (orthogonality)', () => {
    const cases: Array<Partial<RouteRecalcInput>> = [
      { affectedCellCount: 60, shape: 'single-chain', chainLength: 10 },
      { affectedCellCount: 5000, shape: 'single-chain', chainLength: 4000 },
      { affectedCellCount: 5000, shape: 'multiple-chains', chainLength: null },
      { affectedCellCount: 3, shape: 'multiple-chains', chainLength: null },
    ];
    for (const partial of cases) {
      const on = routeRecalc(input({ ...partial, mtEnabled: true }));
      const off = routeRecalc(input({ ...partial, mtEnabled: false }));
      expect(on.route).toBe(off.route);
    }
  });

  it('structural edits -> server, and they beat the tiny hatch', () => {
    expect(routeRecalc(input({ affectedCellCount: 3, context: { structuralEdit: true } }))).toEqual({
      route: 'server',
      reason: 'structural-edit',
      optimisticDisplay: false,
    });
  });

  it('hard fail-safes beat the tiny hatch', () => {
    expect(routeRecalc(input({ affectedCellCount: 3, context: { editInFlight: true } })).reason).toBe('edit-in-flight');
    expect(routeRecalc(input({ affectedCellCount: 3, context: { hasUnreproducibleDependents: true } })).reason).toBe('unreproducible-dependents');
    expect(routeRecalc(input({ affectedCellCount: 3, context: { localEngineAvailable: false } })).reason).toBe('no-local-engine');
    expect(routeRecalc(input({ affectedCellCount: 3, context: { mirrorInSync: false } })).reason).toBe('mirror-out-of-sync');
  });

  it('unknown shape / unknown length / invalid threshold -> server', () => {
    expect(routeRecalc(input({ shape: null, affectedCellCount: 5000 })).reason).toBe('shape-unknown');
    expect(routeRecalc(input({ chainLength: null, affectedCellCount: 5000 })).reason).toBe('chain-unknown');
    expect(routeRecalc(input({ chainLength: -1, affectedCellCount: 5000 })).reason).toBe('chain-unknown');
    const badThresholds = { tinySetThreshold: 50, chainLengthThreshold: 0, mtCellCountThreshold: 5000 };
    expect(routeRecalc(input({ affectedCellCount: 5000, thresholds: badThresholds })).reason).toBe('threshold-invalid');
  });

  it('inexact measurement -> server', () => {
    expect(routeRecalc(input({ affectedCellCount: 5000, context: { measurementExact: false } }))).toEqual({
      route: 'server',
      reason: 'chain-inexact-lower-bound',
      optimisticDisplay: true,
    });
  });

  it('offline: tiny/short -> local PROVISIONAL; long single -> server deferred; multi -> server', () => {
    expect(routeRecalc(input({ affectedCellCount: 3, shape: 'multiple-chains', chainLength: null, context: { online: false } }))).toEqual({
      route: 'local',
      reason: 'tiny-set-local',
      provisional: true,
    });
    expect(routeRecalc(input({ affectedCellCount: 60, chainLength: 10, context: { online: false } }))).toEqual({
      route: 'local',
      reason: 'offline-provisional-short',
      provisional: true,
    });
    expect(routeRecalc(input({ affectedCellCount: 300, chainLength: 300, context: { online: false } }))).toEqual({
      route: 'server',
      reason: 'offline-deferred-long',
      optimisticDisplay: true,
      serverThreading: 'single',
    });
    expect(routeRecalc(input({ affectedCellCount: 300, shape: 'multiple-chains', chainLength: null, context: { online: false } })).reason).toBe('multiple-chains');
    expect(routeRecalc(input({ affectedCellCount: 60, chainLength: 10, context: { serverAvailable: false } })).reason).toBe('offline-provisional-short');
  });

  it('optimistic display: true for value-edit server routes, absent for local', () => {
    expect(routeRecalc(input({ chainLength: null, shape: 'multiple-chains', affectedCellCount: 300 })).optimisticDisplay).toBe(true);
    expect(routeRecalc(input({ affectedCellCount: 60, chainLength: 10 })).optimisticDisplay).toBeUndefined();
    expect(routeRecalc(input({ affectedCellCount: 3 })).optimisticDisplay).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part E: workbook integration
// ---------------------------------------------------------------------------

describe('EngineWorkbook.routeEditRecalc', () => {
  it('mirrorMode follows the workbook size flag', () => {
    const small = new EngineWorkbook({ Sheet1: [[1, 2], [3, 4]] });
    expect(small.mirrorMode()).toBe('mirror');
    const big = new EngineWorkbook({ Sheet1: [[1, 2], [3, 4]] }, { hybridRecalc: { mtCellCountThreshold: 3 } });
    expect(big.mirrorMode()).toBe('no-mirror');
  });

  it('a big (no-mirror) workbook routes even a tiny edit to the server', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1, '=A1+1'], [3, 4]] }, { hybridRecalc: { mtCellCountThreshold: 3 } });
    expect(wb.routeEditRecalc(c('Sheet1', 0, 0))).toEqual({
      route: 'server',
      reason: 'no-mirror',
      optimisticDisplay: true,
    });
  });

  it('a tiny diamond routes LOCAL via the hatch (shape test never runs)', () => {
    const wb = new EngineWorkbook({
      Sheet1: [[1, '=A1+1', '=A1+2', '=B1+C1']],
    });
    expect(wb.routeEditRecalc(c('Sheet1', 0, 0))).toEqual({
      route: 'local',
      reason: 'tiny-set-local',
    });
  });

  it('a short single chain beyond the tiny set routes local (chain-short)', () => {
    const rows: (number | string)[][] = [[1]];
    for (let r = 1; r < 60; r++) rows.push([`=A${r}+1`]);
    const wb = new EngineWorkbook({ Sheet1: rows });
    expect(wb.routeEditRecalc(c('Sheet1', 0, 0))).toEqual({
      route: 'local',
      reason: 'chain-short',
    });
  });

  it('a single chain just over a custom threshold routes server (chain-long, exact)', () => {
    const rows: (number | string)[][] = [[1]];
    for (let r = 1; r < 62; r++) rows.push([`=A${r}+1`]);
    const wb = new EngineWorkbook({ Sheet1: rows }, { hybridRecalc: { chainLengthThreshold: 60 } });
    expect(wb.routeEditRecalc(c('Sheet1', 0, 0))).toEqual({
      route: 'server',
      reason: 'chain-long',
      optimisticDisplay: true,
      serverThreading: 'single',
    });
  });

  it('a long single chain truncates at threshold+1 -> server (inexact lower bound)', () => {
    const rows: (number | string)[][] = [[1]];
    for (let r = 1; r < 500; r++) rows.push([`=A${r}+1`]);
    const wb = new EngineWorkbook({ Sheet1: rows });
    const d = wb.routeEditRecalc(c('Sheet1', 0, 0));
    expect(d.route).toBe('server');
    expect(d.reason).toBe('chain-inexact-lower-bound');
  });

  it('multiple chains beyond the tiny set route server; MT flag only changes threading', () => {
    const rows: (number | string)[][] = [];
    rows.push([1, '=A1+1', '=A1+1']);
    for (let r = 1; r < 30; r++) rows.push(['', `=B${r}+1`, `=C${r}+1`]);
    const wb = new EngineWorkbook({ Sheet1: rows });
    const off = wb.routeEditRecalc(c('Sheet1', 0, 0));
    expect(off).toEqual({
      route: 'server',
      reason: 'multiple-chains',
      optimisticDisplay: true,
      serverThreading: 'single',
    });
    const on = wb.routeEditRecalc(c('Sheet1', 0, 0), { mtEnabled: true });
    expect(on.route).toBe('server');
    expect(on.serverThreading).toBe('parallel');
  });

  it('context fail-safes pass through (mirror out of sync)', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1, '=A1+1']] });
    expect(wb.routeEditRecalc(c('Sheet1', 0, 0), { context: { mirrorInSync: false } })).toEqual({
      route: 'server',
      reason: 'mirror-out-of-sync',
      optimisticDisplay: true,
    });
  });

  it('an unmeasurable edit fail-safes to server (shape-unknown), never throws', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]] });
    expect(wb.routeEditRecalc(c('Nope', 0, 0))).toMatchObject({
      route: 'server',
      reason: 'shape-unknown',
    });
  });
});
