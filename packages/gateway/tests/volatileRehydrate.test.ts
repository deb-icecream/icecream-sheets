/**
 * Issue #67 — volatile workbooks cannot be re-opened after session release.
 *
 * The checkpoint/rehydrate full-state checksum hashed COMPUTED VALUES.
 * A volatile cell (NOW()/RAND()/…) — and every cell depending on one —
 * recomputes to a different value at rebuild time, so the rebuilt state
 * could never match the checkpoint and rehydrate hard-failed 409 forever.
 *
 * Fix contract (engineSvc.checksumFromBulk + EngineWorkbook
 * .getVolatileValueCells): volatile-tainted cells contribute their INPUT
 * (deterministic, round-trips verbatim) to the checksum instead of their
 * computed value; every other cell is hashed exactly as before, so a
 * volatile-free workbook's checksum is bit-identical to the legacy one
 * and genuine corruption — of a deterministic cell OR of a volatile
 * cell's formula — still fails the gate loudly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createEngineListener } from '../src/services/engineSvc.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };
const A1 = { sheet: 'Sheet1', row: 0, col: 0 };
const B1 = { sheet: 'Sheet1', row: 0, col: 1 };
const C1 = { sheet: 'Sheet1', row: 0, col: 2 };
const D1 = { sheet: 'Sheet1', row: 0, col: 3 };
const B2 = { sheet: 'Sheet1', row: 1, col: 1 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A1 literal; B1 deterministic dependent; C1 volatile; D1 depends on C1. */
function volatileXlsxBytes(a1 = 3, cFormula = '=A1+SECOND(NOW())'): Buffer {
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Sheet1', rows: [[a1, '=A1*2', cFormula, '=C1+1']] }],
    metadata: {},
  } as never);
  return Buffer.from(bytes);
}

function tinyXlsxBase64(): string {
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Sheet1', rows: [[10, 20], [null, '=A1+B1']] }],
    metadata: {},
  } as never);
  return Buffer.from(bytes).toString('base64');
}

describe('engine service — volatile rehydrate (issue #67)', () => {
  let svc: Started | null = null;
  let stores: MemorySessionStores;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup(): Promise<void> {
    stores = new MemorySessionStores();
    svc = await startServer(
      createEngineListener({
        sessionStores: stores,
        deployEnv: {} as NodeJS.ProcessEnv,
      }),
    );
  }

  function post(path: string, body: unknown) {
    return httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });
  }

  async function loadVolatile(): Promise<string> {
    const load = await post('/load', {
      format: 'xlsx',
      data: volatileXlsxBytes().toString('base64'),
    });
    expect(load.status).toBe(200);
    return (load.json as { sessionId: string }).sessionId;
  }

  it(
    'volatile workbook re-opens after release, repeatedly (x3)',
    async () => {
      await setup();
      const sid = await loadVolatile();
      for (let cycle = 0; cycle < 3; cycle++) {
        const rel = await post('/session/release', { sessionId: sid, reason: 'idle' });
        expect(rel.status).toBe(200);
        // Force the wall clock past a second boundary: pre-fix, the
        // rebuilt C1 (=A1+SECOND(NOW())) necessarily differs from the
        // checkpointed value and rehydrate 409s deterministically.
        await sleep(1100);
        const re = await post('/session/rehydrate', { sessionId: sid });
        expect(re.status, `cycle ${cycle}: ${JSON.stringify(re.json)}`).toBe(200);
        expect(re.json).toMatchObject({ checksumVerified: true });
        // Deterministic cells intact after every round trip.
        const b1 = await post('/read', { kind: 'cell', ref: B1 });
        expect((b1.json as { value: { value: number } }).value.value).toBe(6);
        // The volatile chain is live and self-consistent post-rehydrate.
        const c1 = await post('/read', { kind: 'cell', ref: C1 });
        const d1 = await post('/read', { kind: 'cell', ref: D1 });
        const cv = (c1.json as { value: { value: number } }).value.value;
        expect(cv).toBeGreaterThanOrEqual(3);
        expect(cv).toBeLessThanOrEqual(62);
        expect((d1.json as { value: { value: number } }).value.value).toBe(cv + 1);
      }
    },
    60_000,
  );

  it('corrupted checkpoint (deterministic content changed) still fails loudly', async () => {
    await setup();
    const sid = await loadVolatile();
    await post('/session/release', { sessionId: sid, reason: 'idle' });
    const snap = await stores.snapshots.get(sid);
    expect(snap).not.toBeNull();
    // Genuine corruption: same session, stored bytes now describe a
    // different workbook (A1 3 -> 4) under the original checksum.
    await stores.snapshots.put(sid, { ...snap!, bytes: volatileXlsxBytes(4) });
    const re = await post('/session/rehydrate', { sessionId: sid });
    expect(re.status).toBe(409);
    expect(re.json).toMatchObject({ checksumVerified: false });
    expect((re.json as { error: string }).error).toContain('checksum mismatch');
    const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: ALICE });
    expect((st.json as { status: string }).status).toBe('released');
    expect((await post('/read', { kind: 'cell', ref: A1 })).status).toBe(409);
  });

  it("tampering with a volatile cell's formula is still caught (input coverage)", async () => {
    await setup();
    const sid = await loadVolatile();
    await post('/session/release', { sessionId: sid, reason: 'idle' });
    const snap = await stores.snapshots.get(sid);
    // Only the volatile cell's formula changes (+100): its VALUE is
    // excluded from the checksum by design, so this 409 can only come
    // from the input coverage that replaces it.
    await stores.snapshots.put(sid, {
      ...snap!,
      bytes: volatileXlsxBytes(3, '=A1+SECOND(NOW())+100'),
    });
    const re = await post('/session/rehydrate', { sessionId: sid });
    expect(re.status).toBe(409);
    expect(re.json).toMatchObject({ checksumVerified: false });
    expect((re.json as { error: string }).error).toContain('checksum mismatch');
  });

  it('deterministic workbook re-open is unchanged across cycles', async () => {
    await setup();
    const load = await post('/load', { format: 'xlsx', data: tinyXlsxBase64() });
    const sid = (load.json as { sessionId: string }).sessionId;
    const ex = await post('/execute', { cmd: { cmd: 'setCell', ref: A1, value: 15 } });
    expect(ex.status).toBe(200);
    for (let cycle = 0; cycle < 2; cycle++) {
      const rel = await post('/session/release', { sessionId: sid, reason: 'idle' });
      expect(rel.status).toBe(200);
      const re = await post('/session/rehydrate', { sessionId: sid });
      expect(re.status).toBe(200);
      expect(re.json).toMatchObject({ checksumVerified: true });
      const a1 = await post('/read', { kind: 'cell', ref: A1 });
      expect((a1.json as { value: { value: number } }).value.value).toBe(15);
      const b2 = await post('/read', { kind: 'cell', ref: B2 });
      expect((b2.json as { value: { value: number } }).value.value).toBe(35);
    }
  });
});
