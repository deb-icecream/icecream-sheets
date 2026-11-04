/**
 * EngineHost evaluation-hold delegations (issue #58 desktop dispatch;
 * the gateway #60 fix consumes the same seam): suspendEvaluation() /
 * resumeEvaluation() / isEvaluationSuspended() on EngineHost forward
 * to the workbook's host-managed transient suspension, which lets a
 * dispatcher apply an op with evaluation held, run exactly one
 * recalculateParallel as the edit's only evaluation, and release the
 * hold later with a single flush — all without touching the user's
 * calculation mode.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '../src/protocol.js';
import { EngineWorkbook, InlineWorkerBackend } from '../src/index.js';

function makeHost() {
  // Two INDEPENDENT chains (B1 from A1, B2 from A2): a lone dependent
  // chain serializes by definition, so the parallel planner would
  // (correctly) decline and fall back to a serial recalculate.
  const wb = new EngineWorkbook({ Sheet1: [[1, '=A1+1'], [10, '=A2*2']] });
  // Engage the real parallel path on a tiny fixture (the same gate
  // bypass the parallel-recalc differential tests use).
  wb.setParallelRecalcOptions({
    enabled: true,
    workerCount: 2,
    minFormulaCells: 0,
    cellCountThreshold: 0,
    factory: { create: () => new InlineWorkerBackend() },
  });
  const host = new EngineHost(wb);
  return { wb, host };
}

const A1 = { sheet: 'Sheet1', row: 0, col: 0 };
const B1 = { sheet: 'Sheet1', row: 0, col: 1 };

describe('EngineHost evaluation-hold delegations (#58/#60 seam)', () => {
  it('forwards suspend/resume/isEvaluationSuspended to the workbook', () => {
    const { wb, host } = makeHost();
    expect(host.isEvaluationSuspended()).toBe(false);
    host.suspendEvaluation();
    expect(wb.isEvaluationSuspended()).toBe(true);
    expect(host.isEvaluationSuspended()).toBe(true);
    host.resumeEvaluation();
    expect(wb.isEvaluationSuspended()).toBe(false);
    expect(host.isEvaluationSuspended()).toBe(false);
  });

  it('a suspended apply evaluates nothing; one recalculateParallel computes; resume restores inline evaluation', async () => {
    const { wb, host } = makeHost();
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 2 });

    host.suspendEvaluation();
    const applied = host.execute({ cmd: 'setCell', ref: A1, value: 10 });
    expect(applied.ok).toBe(true);
    // No evaluation happened: the dependent still serves its
    // last-computed value from the workbook cache.
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 2 });

    const recalc = await host.executeAsync({ cmd: 'recalculateParallel' });
    expect(recalc.ok).toBe(true);
    // The parallel merge refreshed the cache — the one evaluation.
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 11 });
    // The hold is still outstanding: the parallel pass does not
    // consume it (only resume / mode change / recalculate flush do).
    expect(host.isEvaluationSuspended()).toBe(true);

    host.resumeEvaluation();
    expect(host.isEvaluationSuspended()).toBe(false);
    // HyperFormula is the read authority again: a serial edit
    // evaluates inline.
    host.execute({ cmd: 'setCell', ref: A1, value: 20 });
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 21 });
    wb.disposeParallelWorkers();
  });

  it('never resumes a manual-mode suspension it did not create', () => {
    const { wb, host } = makeHost();
    wb.setCalculationMode('manual');
    host.suspendEvaluation(); // no-op: manual mode already holds suspension
    expect(host.isEvaluationSuspended()).toBe(false);
    host.execute({ cmd: 'setCell', ref: A1, value: 5 });
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 2 }); // manual: deferred
    host.resumeEvaluation(); // must NOT flush the manual suspension
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 2 });
    wb.setCalculationMode('automatic'); // the mode change itself flushes
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 6 });
  });

  it('double suspend is one hold; resume without a hold is a no-op', () => {
    const { host } = makeHost();
    host.resumeEvaluation(); // no hold outstanding: must not throw
    host.suspendEvaluation();
    host.suspendEvaluation();
    expect(host.isEvaluationSuspended()).toBe(true);
    host.resumeEvaluation();
    expect(host.isEvaluationSuspended()).toBe(false);
  });
});
