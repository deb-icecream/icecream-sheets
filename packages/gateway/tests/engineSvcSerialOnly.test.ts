/**
 * Issue #60 — SERIAL-ONLY recalc on the gateway (owner decision
 * 2026-10-23): runExecuteInternal must evaluate an edit EXACTLY ONCE
 * (the serial pass inside host.execute). The former parallel
 * recalculateParallel follow-up ("encore") recomputed already-complete
 * values and is removed; true parallel returns via issue #62.
 *
 * Proof shape (adapted from the reverted #60 worker's wave suite):
 * a >5,000-cell workbook (past the MT threshold) with TWO independent
 * chains hanging off one root — the exact shape that used to take the
 * parallel route. Evaluation waves are counted via GET /events: a
 * serial evaluation surfaces as a cellsChanged event whose refs reach
 * a chain tail; the parallel encore surfaces as a `recalcComplete`
 * event (EngineHost.executeAsync emits it after recalculateParallel —
 * the merge itself changes no values, so it fires no cellsChanged).
 * Old composition: 1 tail wave + 1 recalcComplete = TWO evaluations.
 * Serial-only: exactly 1 tail wave + 0 recalcComplete, and the tail
 * values are the complete serial values (identical in both worlds —
 * the same assertions run against the pre-change file fail ONLY on
 * the recalcComplete count).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import type { TypedValue } from '@icecream-sheets/engine';
import { createEngineListener } from '../src/services/engineSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };
const SHEET = 'Fan';
const ROOT = { sheet: SHEET, row: 0, col: 0 }; // A1
const TAIL_B = { sheet: SHEET, row: 99, col: 1 }; // B100
const TAIL_C = { sheet: SHEET, row: 99, col: 2 }; // C100

/** 100 rows x 54 cols: A=root, B/C = two 100-cell chains, E..BB filler
 *  literals (100*50 = 5,000) so totalCellCount ≈ 5,201 > MT threshold. */
function fanXlsxBase64(): string {
  const rows: (number | string | null)[][] = [];
  for (let r = 0; r < 100; r++) {
    const row: (number | string | null)[] = new Array(54).fill(null);
    if (r === 0) {
      row[0] = 2;
      row[1] = '=A1+1';
      row[2] = '=A1+2';
    } else {
      row[1] = `=B${r}+1`;
      row[2] = `=C${r}+1`;
    }
    for (let c = 4; c < 54; c++) row[c] = r * 100 + c;
    rows.push(row);
  }
  const bytes = new XlsxAdapter().write({ sheets: [{ name: SHEET, rows }], metadata: {} } as never);
  return Buffer.from(bytes).toString('base64');
}

interface Evt {
  seq: number;
  event: { type: string; refs?: { sheet: string; row: number; col: number }[] };
}

describe('issue #60 — serial-only evaluation (one wave, exact values)', () => {
  let svc: Started | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  function post(path: string, body: unknown) {
    return httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });
  }

  async function loadFan() {
    svc = await startServer(createEngineListener());
    const load = await post('/load', { format: 'xlsx', data: fanXlsxBase64() });
    expect(load.status).toBe(200);
  }

  async function lastSeq(): Promise<number> {
    const r = await httpJson('GET', `${svc!.url}/events?since=0`, { headers: ALICE });
    const { events } = r.json as { events: Evt[] };
    return events.length ? events[events.length - 1]!.seq : 0;
  }

  async function wavesReaching(since: number, ref: { row: number; col: number }): Promise<number> {
    const r = await httpJson('GET', `${svc!.url}/events?since=${since}`, { headers: ALICE });
    const { events } = r.json as { events: Evt[] };
    return events.filter(
      (e) =>
        e.event.type === 'cellsChanged' &&
        (e.event.refs ?? []).some((x) => x.sheet === SHEET && x.row === ref.row && x.col === ref.col),
    ).length;
  }

  /** Parallel-encore signature: one recalcComplete per executeAsync('recalculateParallel'). */
  async function recalcCompletes(since: number): Promise<number> {
    const r = await httpJson('GET', `${svc!.url}/events?since=${since}`, { headers: ALICE });
    const { events } = r.json as { events: Evt[] };
    return events.filter((e) => e.event.type === 'recalcComplete').length;
  }

  async function readCell(ref: { sheet: string; row: number; col: number }): Promise<TypedValue> {
    const rd = await post('/read', { kind: 'cell', ref });
    expect(rd.status).toBe(200);
    return (rd.json as { value: TypedValue }).value;
  }

  it('POST /execute: multi-chain edit on a >5000-cell workbook = exactly ONE wave, serial-complete values', async () => {
    await loadFan();
    const since = await lastSeq();
    const ex = await post('/execute', { cmd: { cmd: 'setCell', ref: ROOT, value: 5 } });
    expect(ex.status).toBe(200);
    expect((ex.json as { ok: boolean }).ok).toBe(true);
    expect(await wavesReaching(since, TAIL_B)).toBe(1);
    expect(await wavesReaching(since, TAIL_C)).toBe(1);
    expect(await recalcCompletes(since)).toBe(0); // no parallel encore
    // Serial-complete values: B100 = 5+1+99, C100 = 5+2+99.
    expect(await readCell(TAIL_B)).toEqual({ kind: 'number', value: 105 });
    expect(await readCell(TAIL_C)).toEqual({ kind: 'number', value: 106 });
  });

  it('POST /ops: same edit through the collab envelope = exactly ONE wave, serial-complete values', async () => {
    await loadFan();
    const since = await lastSeq();
    const r = await post('/ops', {
      clientId: 'serial-c',
      clientSeq: 1,
      baseRev: 0,
      cmd: { cmd: 'setCell', ref: ROOT, value: 7 },
    });
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    expect(await wavesReaching(since, TAIL_B)).toBe(1);
    expect(await wavesReaching(since, TAIL_C)).toBe(1);
    expect(await recalcCompletes(since)).toBe(0); // no parallel encore
    // Serial-complete values: B100 = 7+1+99, C100 = 7+2+99.
    expect(await readCell(TAIL_B)).toEqual({ kind: 'number', value: 107 });
    expect(await readCell(TAIL_C)).toEqual({ kind: 'number', value: 108 });
  });

  it('ack-checksum path still returns an ack over the affected set (semantics preserved)', async () => {
    await loadFan();
    const ex = await post('/execute', {
      cmd: { cmd: 'setCell', ref: ROOT, value: 9 },
      ackChecksum: true,
    });
    expect(ex.status).toBe(200);
    const ack = (ex.json as { ack?: { changedCellCount: number; checksum: string } }).ack;
    expect(ack).toBeTruthy();
    // Affected set = root + both full chains (200 dependents).
    expect(ack!.changedCellCount).toBe(201);
    expect(await readCell(TAIL_B)).toEqual({ kind: 'number', value: 109 });
  });
});
