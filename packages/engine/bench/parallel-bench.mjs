/**
 * Benchmark: serial recalculate() vs parallel recalculateParallel().
 *
 * Workload: 8 independent sheets x 4000 rows x 2 formula columns = 64k
 * formulas, each with 12 transcendental ops (compute-heavy).
 *
 * Measures:
 *  - Serial: full recalculate() in manual mode.
 *  - Parallel (cold): first recalculateParallel() — workers spawn and parse.
 *  - Parallel (warm): second recalculateParallel() — workers use cached
 *    workbooks with delta-only requests (parse once, not per recalc).
 *
 * Asserts identical results (checksums). Run with: node bench/parallel-bench.mjs
 *
 * NOTE: Speedup depends on CPU count and system load. On a 2-CPU VM the
 * theoretical max is 2x; measured 1.15x on a quiet machine. The primary
 * guarantee is correctness (identical results), not raw speed.
 */
import { EngineWorkbook, TypedView, NodeWorkerBackend } from '../dist/index.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, '..', 'dist', 'parallel', 'node-worker.js');

const SHEETS = 8;
const ROWS = 4000;

function buildInitial() {
  const initial = {};
  for (let s = 0; s < SHEETS; s++) {
    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      const a = `A${r + 1}`;
      grid.push([
        r + 1,
        `=SIN(${a})+COS(${a})+TAN(${a})+SIN(2*${a})+COS(2*${a})+TAN(2*${a})` +
          `+EXP(0.01*${a})+LOG(${a}+1)+SQRT(${a})+ABS(SIN(${a}))+SIN(${a}*3)+COS(${a}*3)`,
      ]);
    }
    initial[`Sheet${s}`] = grid;
  }
  return initial;
}

function checksum(wb) {
  let h = 0;
  for (const { ref } of wb.getTrackedCells()) {
    const v = JSON.stringify(TypedView.toJson(wb.getValue(ref)));
    for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function buildDirty(v) {
  const wb = new EngineWorkbook(buildInitial());
  wb.setCalculationMode('manual');
  for (let s = 0; s < SHEETS; s++) {
    for (let r = 0; r < ROWS; r++) {
      wb.setCell({ sheet: `Sheet${s}`, row: r, col: 0 }, v + r);
    }
  }
  return wb;
}

const time = async (fn) => {
  const t0 = process.hrtime.bigint();
  const out = await fn();
  return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
};

const mkFactory = () => ({
  create: () => new NodeWorkerBackend(workerPath),
});

// Serial baseline.
const sw = buildDirty(1000);
const { ms: serialMs } = await time(() => sw.recalculate());
console.log(`serial:           ${serialMs.toFixed(0)} ms`);

// Parallel: cold (full parse) then warm (delta).
const pw = buildDirty(1000);
pw.setParallelRecalcOptions({
  enabled: true,
  workerCount: 2,
  minFormulaCells: 0,
  factory: mkFactory(),
});
const { ms: coldMs } = await time(() => pw.recalculateParallel());
console.log(`parallel (cold):  ${coldMs.toFixed(0)} ms  (worker spawn + full parse)`);

for (let s = 0; s < SHEETS; s++) {
  for (let r = 0; r < ROWS; r++) {
    pw.setCell({ sheet: `Sheet${s}`, row: r, col: 0 }, 2000 + r);
  }
}
const { out: stats, ms: warmMs } = await time(() => pw.recalculateParallel());
const parSum = checksum(pw);
console.log(
  `parallel (warm):  ${warmMs.toFixed(0)} ms  ` +
    `(workers=${stats.workersUsed}, partitions=${stats.partitions}, delta protocol)`,
);

// Serial with identical dirtying, for checksum comparison.
const sw2 = buildDirty(2000);
await sw2.recalculate();
const serialSum = checksum(sw2);

console.log(`identical results: ${parSum === serialSum}`);
console.log(`speedup (warm vs serial): ${(serialMs / warmMs).toFixed(2)}x`);
pw.disposeParallelWorkers();

if (parSum !== serialSum) {
  console.error('MISMATCH: parallel results differ from serial!');
  process.exit(1);
}
