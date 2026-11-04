/**
 * Desktop edit dispatch (Cycle 10 Phase 3): the main-process engine —
 * in the "server" role — funnels edits through the same pure routeRecalc
 * policy as the web gateway flow (dispatchDesktopEdit in engine-ipc.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  Authorizer,
  EngineHost,
  EngineWorkbook,
  InlineWorkerBackend,
  type CellInput,
} from '@icecream-sheets/engine';
import { dispatchDesktopEdit } from '../src/engine-ipc.js';

describe('dispatchDesktopEdit', () => {
  it('tiny edit takes the local path and recalcs', async () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1, '=A1+1']] }));
    const { result, decision } = await dispatchDesktopEdit(host, {
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 41,
    });
    expect(result.ok).toBe(true);
    expect(decision?.reason).toBe('tiny-set-local');
    expect(host.getView().readCell({ sheet: 'Sheet1', row: 0, col: 1 }).value).toEqual({
      kind: 'number',
      value: 42,
    });
  });

  it('multi-chain fan-out on a flag-ON workbook decides server/parallel', async () => {
    // A1 fans out to 60 dependents (beats the tiny hatch) and the
    // workbook exceeds its tiny MT threshold → parallel follow-up runs
    // through executeAsync (its own serial fallbacks apply inside).
    const rows: CellInput[][] = [];
    for (let i = 0; i < 60; i++) rows.push(i === 0 ? [1, '=A1+1'] : [null, '=A1+1']);
    const host = new EngineHost(
      new EngineWorkbook(
        { Sheet1: rows },
        { hybridRecalc: { mtCellCountThreshold: 10 } },
      ),
    );
    const { result, decision } = await dispatchDesktopEdit(host, {
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 10,
    });
    expect(result.ok).toBe(true);
    expect(decision?.route).toBe('server');
    expect(decision?.reason).toBe('multiple-chains');
    expect(decision?.serverThreading).toBe('parallel');
    expect(host.getView().readCell({ sheet: 'Sheet1', row: 59, col: 1 }).value).toEqual({
      kind: 'number',
      value: 11,
    });
  });

  it('structural commands execute with no routing decision', async () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1]] }));
    const { result, decision } = await dispatchDesktopEdit(host, { cmd: 'addSheet', name: 'Extra' });
    expect(result.ok).toBe(true);
    expect(decision).toBeNull();
    expect(host.sheetNames()).toContain('Extra');
  });
});

/**
 * Issue #58 + owner ruling (2026-10-23): SERIAL ONLY. Every edit
 * through the dispatch gets exactly ONE serial evaluation — the
 * parallel follow-up is gone — the post-edit values ride the execute
 * reply (one roundtrip), and the dispatch never suspends evaluation.
 *
 * The suspended-apply composition (suspend → apply → one
 * recalculateParallel as the only evaluation) was implemented and
 * REVERTED on probe evidence (see the dispatch doc comment in
 * engine-ipc.ts): while held, empty-cell reads / snapshot /
 * bulkReadback throw "Computations are suspended", and resuming after
 * a merge re-derives the whole closure (the second evaluation in a
 * new costume). True parallel recalc is future work behind an engine
 * merge-finalize primitive. The routing DECISION is still measured
 * and returned (policy surface intact); it triggers no second pass.
 *
 * The fan-out fixture spreads one root over 60 dependents (beats the
 * tiny hatch; multiple chains for the router) on a workbook whose MT
 * threshold is 10 cells, with the parallel planner genuinely engaged
 * (InlineWorkerBackend, zero gates — the seam tests' pattern) so the
 * OLD composition comparison below runs a true parallel pass.
 */
function makeParallelHost() {
  const rows: CellInput[][] = [];
  for (let i = 0; i < 30; i++) {
    rows.push(i === 0 ? [1, '=A1+1', '=A1*2'] : [null, '=A1+1', '=A1*2']);
  }
  const wb = new EngineWorkbook(
    { Sheet1: rows, Calc: [[5, '=A1+10']] },
    { hybridRecalc: { mtCellCountThreshold: 10 } },
  );
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
const C30 = { sheet: 'Sheet1', row: 29, col: 2 };

describe('dispatchDesktopEdit — issue #58', () => {
  it('serial route: values ride the reply; no parallel pass runs', async () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1, '=A1+1']] }));
    const asyncSpy = vi.spyOn(host, 'executeAsync');
    const { result, decision, values } = await dispatchDesktopEdit(host, {
      cmd: 'setCell',
      ref: A1,
      value: 41,
    });
    expect(result.ok).toBe(true);
    expect(decision?.reason).toBe('tiny-set-local');
    expect(asyncSpy).not.toHaveBeenCalled();
    expect(host.isEvaluationSuspended()).toBe(false);
    // The reply carries the edited cell AND its dependent, post-edit.
    const byRef = new Map((values ?? []).map((v) => [`${v.ref.row},${v.ref.col}`, v]));
    expect(byRef.get('0,0')?.value).toEqual({ kind: 'number', value: 41 });
    expect(byRef.get('0,0')?.formulaKnown).toBe(true);
    expect(byRef.get('0,0')?.formula).toBeUndefined();
    expect(byRef.get('0,1')?.value).toEqual({ kind: 'number', value: 42 });
  });

  it('multi-chain edit: exactly ONE evaluation wave, no follow-up call, no suspension (owner serial-only ruling)', async () => {
    const { wb, host } = makeParallelHost();
    const suspendSpy = vi.spyOn(host, 'suspendEvaluation');
    const asyncSpy = vi.spyOn(host, 'executeAsync');
    // Proof (a): count cellsChanged waves REACHING a chosen dependent
    // (the #60 worker's metric): one evaluation settles B1 once.
    let wavesAtB1 = 0;
    const off = host.subscribe((e) => {
      if (
        e.type === 'cellsChanged' &&
        e.refs.some((r) => r.sheet === 'Sheet1' && r.row === 0 && r.col === 1)
      ) {
        wavesAtB1++;
      }
    });
    const { result, decision, values } = await dispatchDesktopEdit(host, {
      cmd: 'setCell',
      ref: A1,
      value: 10,
    });
    off();
    expect(result.ok).toBe(true);
    // The decision is still measured (policy surface): this edit WOULD
    // have routed server/parallel — and the dispatch runs it serially.
    expect(decision?.route).toBe('server');
    expect(decision?.serverThreading).toBe('parallel');
    expect(wavesAtB1).toBe(1);
    // Proof (c): the parallel follow-up call is GONE from the dispatch.
    expect(asyncSpy).not.toHaveBeenCalled();
    expect(suspendSpy).not.toHaveBeenCalled();
    expect(host.isEvaluationSuspended()).toBe(false);
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 11 });
    expect(host.readCell(C30)).toEqual({ kind: 'number', value: 20 });
    // Reply values: edited cell + dependents with post-edit values.
    const byRef = new Map(
      (values ?? []).map((v) => [`${v.ref.sheet}!${v.ref.row},${v.ref.col}`, v]),
    );
    expect(byRef.get('Sheet1!0,0')?.value).toEqual({ kind: 'number', value: 10 });
    expect(byRef.get('Sheet1!0,1')?.value).toEqual({ kind: 'number', value: 11 });
    expect(byRef.get('Sheet1!29,2')?.value).toEqual({ kind: 'number', value: 20 });
    wb.disposeParallelWorkers();
  });

  it('after a multi-chain edit every read path stays live (the suspended-state traps stay shut)', async () => {
    const { wb, host } = makeParallelHost();
    await dispatchDesktopEdit(host, { cmd: 'setCell', ref: A1, value: 10 });
    // Each of these THREW "Computations are suspended" under the
    // reverted hold composition (desktop probe, 2026-10-23).
    expect(host.readCell({ sheet: 'Sheet1', row: 40, col: 5 })).toEqual({
      kind: 'null',
      value: null,
    });
    expect(() => host.snapshot()).not.toThrow();
    expect(() => host.bulkReadback()).not.toThrow();
    // A serial edit and a structural op follow cleanly, values exact.
    const serial = await dispatchDesktopEdit(host, {
      cmd: 'setCell',
      ref: { sheet: 'Calc', row: 0, col: 0 },
      value: 7,
    });
    expect(serial.result.ok).toBe(true);
    expect(host.readCell({ sheet: 'Calc', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 17,
    });
    const structural = await dispatchDesktopEdit(host, { cmd: 'addSheet', name: 'Extra' });
    expect(structural.result.ok).toBe(true);
    expect(structural.decision).toBeNull();
    expect(host.sheetNames()).toContain('Extra');
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 11 });
    wb.disposeParallelWorkers();
  });

  it('a denied multi-chain edit applies nothing and suspends nothing', async () => {
    const { wb, host } = makeParallelHost();
    const denying = new EngineHost(wb, new Authorizer(() => false));
    const { result } = await dispatchDesktopEdit(denying, {
      cmd: 'setCell',
      ref: A1,
      value: 99,
    });
    expect(result.ok).toBe(false);
    expect(denying.isEvaluationSuspended()).toBe(false);
    // Nothing applied (read back through the permissive host: the
    // deny-all authorizer denies reads too, by design).
    expect(host.readCell(B1)).toEqual({ kind: 'number', value: 2 });
    wb.disposeParallelWorkers();
  });

  it('proof (b): dispatch values are identical to the OLD serial+parallel composition, cell for cell', async () => {
    const viaDispatch = makeParallelHost();
    const viaOldComposition = makeParallelHost();
    const oldAsyncSpy = vi.spyOn(viaOldComposition.host, 'executeAsync');

    const { values } = await dispatchDesktopEdit(viaDispatch.host, {
      cmd: 'setCell',
      ref: A1,
      value: 33,
    });
    // The old composition, by hand: serial apply, then the parallel
    // follow-up (a true parallel pass on this fixture).
    viaOldComposition.host.execute({ cmd: 'setCell', ref: A1, value: 33 });
    await viaOldComposition.host.executeAsync({ cmd: 'recalculateParallel' });
    expect(oldAsyncSpy).toHaveBeenCalledTimes(1); // the comparison is real

    // Every cell of both sheets agrees, and the reply values match the
    // old composition's post-pass values too.
    for (const sheet of ['Sheet1', 'Calc']) {
      for (let row = 0; row < 30; row++) {
        for (let col = 0; col < 3; col++) {
          const ref = { sheet, row, col };
          expect(viaDispatch.host.readCell(ref)).toEqual(
            viaOldComposition.host.readCell(ref),
          );
        }
      }
    }
    for (const entry of values ?? []) {
      expect(entry.value).toEqual(viaOldComposition.host.readCell(entry.ref));
    }
    expect(viaDispatch.host.readCell(B1)).toEqual({ kind: 'number', value: 34 });
    viaDispatch.wb.disposeParallelWorkers();
    viaOldComposition.wb.disposeParallelWorkers();
  });

  it('setFormula reply carries the normalized formula on the edited entry', async () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[3, null]] }));
    const { result, values } = await dispatchDesktopEdit(host, {
      cmd: 'setFormula',
      ref: B1,
      formula: 'A1+1',
    });
    expect(result.ok).toBe(true);
    const edited = (values ?? []).find((v) => v.ref.col === 1);
    expect(edited?.formulaKnown).toBe(true);
    expect(edited?.formula).toBe('=A1+1');
    expect(edited?.value).toEqual({ kind: 'number', value: 4 });
  });
});
