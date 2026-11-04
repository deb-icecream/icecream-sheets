/**
 * FIX-G — native chart creation in the engine service (trace §4.1c):
 * POST /charts (sequenced, revision++, journaled as the additive
 * `chart.add` kind), SSE `session {kind:'charts'}` broadcast, directSave
 * merging sessionCharts into a real xl/charts/chartN.xml part, and the
 * rehydrateSession replay branch reconstructing the chart from the
 * journal. The downloaded bytes' readCharts parse-back is the proof.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { XlsxAdapter, readCharts } from '@icecream-sheets/xlsx-adapter';
import { createEngineListener } from '../src/services/engineSvc.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };

function chartWorkbookBase64(): string {
  const bytes = new XlsxAdapter().write({
    sheets: [
      {
        name: 'Data',
        rows: [
          ['Quarter', 'Sales'],
          ['Q1', 10],
          ['Q2', 20],
          ['Q3', 30],
        ],
      },
    ],
    metadata: {},
  } as never);
  return Buffer.from(bytes).toString('base64');
}

const SPEC = {
  version: 2,
  id: 99,
  kind: 'column-clustered',
  title: 'Sales by Quarter',
  range: { sheet: 'Data', startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
  xAxisTitle: '',
  yAxisTitle: '',
  legend: 'bottom',
  dataLabels: false,
  x: 0,
  y: 0,
  w: 480,
  h: 320,
  seriesRanges: [
    {
      name: 'Sales',
      cat: { sheet: 'Data', startRow: 1, startCol: 0, endRow: 3, endCol: 0 },
      val: { sheet: 'Data', startRow: 1, startCol: 1, endRow: 3, endCol: 1 },
    },
  ],
  anchorCells: { fromCol: 3, fromRow: 1, toCol: 11, toRow: 16 },
};

describe('engine service — POST /charts (FIX-G)', () => {
  let svc: Started | null = null;
  let stores: MemorySessionStores;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup(env: Record<string, string> = {}): Promise<void> {
    stores = new MemorySessionStores();
    svc = await startServer(
      createEngineListener({ sessionStores: stores, deployEnv: env as NodeJS.ProcessEnv }),
    );
  }

  function post(path: string, body: unknown) {
    return httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });
  }

  async function loadWorkbook(): Promise<string> {
    const load = await post('/load', { format: 'xlsx', data: chartWorkbookBase64() });
    expect(load.status).toBe(200);
    return (load.json as { sessionId: string }).sessionId;
  }

  async function downloadCharts(): Promise<ReturnType<typeof readCharts>> {
    const res = await fetch(`${svc!.url}/download`, { headers: ALICE });
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { entryId: string };
    const entry = await fetch(`${svc!.url}/library/${meta.entryId}`, { headers: ALICE });
    expect(entry.status).toBe(200);
    const bytes = new Uint8Array(await entry.arrayBuffer());
    const files: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(unzipSync(bytes.slice()))) files[k] = v as Uint8Array;
    expect(Object.keys(files)).toContain('xl/charts/chart1.xml');
    return readCharts(files);
  }

  it('refuses with 409 before any session is loaded', async () => {
    await setup();
    const r = await post('/charts', { spec: SPEC });
    expect(r.status).toBe(409);
  });

  it('accepts a chart: revision++, journaled as chart.add, download parse-back shows the native part', async () => {
    await setup({ JOURNAL_SEGMENT_MAX_OPS: '1' });
    const sid = await loadWorkbook();

    // Fail-closed validation: non-authorable kind and unknown sheet.
    const badKind = await post('/charts', { spec: { ...SPEC, kind: 'scatter' } });
    expect(badKind.status).toBe(400);
    const badSheet = await post('/charts', {
      spec: { ...SPEC, range: { ...SPEC.range, sheet: 'Nope' } },
    });
    expect(badSheet.status).toBe(400);

    const ok = await post('/charts', { spec: SPEC });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, id: 99, revision: 1 });

    // The journal segment carries exactly the additive chart.add kind.
    const entries = await stores.journal.readFrom(sid, 0);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.revision).toBe(1);
    expect((entries[0]!.op as { cmd: string }).cmd).toBe('chart.add');
    expect(entries[0]!.delta).toEqual([]);

    // Download → real native part, parsed back by the real parser.
    const charts = await downloadCharts();
    expect(charts).toHaveLength(1);
    expect(charts[0]!.kind).toBe('barChart');
    expect(charts[0]!.title).toBe('Sales by Quarter');
    expect(charts[0]!.series[0]!.valFormula).toBe('Data!$B$2:$B$4');
    expect(charts[0]!.series[0]!.valCache).toEqual([10, 20, 30]);
  });

  it('broadcasts the charts session event over SSE to connected clients', async () => {
    await setup();
    await loadWorkbook();
    const ctrl = new AbortController();
    const res = await fetch(`${svc!.url}/deltas`, { headers: ALICE, signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
      } catch {
        // aborted at test end
      }
    })();
    // Give the hello/status/presence events a moment to land.
    await new Promise((r) => setTimeout(r, 100));
    expect(buf).not.toContain('"kind":"charts"');
    const ok = await post('/charts', { spec: SPEC });
    expect(ok.status).toBe(200);
    const deadline = Date.now() + 5000;
    while (!buf.includes('"kind":"charts"') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    ctrl.abort();
    await pump.catch(() => undefined);
    expect(buf).toContain('"kind":"charts"');
    expect(buf).toContain('Sales by Quarter');
  });

  it('journal replay on rehydrate reconstructs the chart (chart.add branch)', async () => {
    await setup();
    const sid = await loadWorkbook();
    // Release: snapshot at revision 0 (no chart in the snapshot bytes).
    const rel = await post('/session/release', { sessionId: sid, reason: 'idle' });
    expect(rel.status).toBe(200);
    // Simulate the instance-loss case: a chart.add segment journaled
    // after the last snapshot.
    await stores.journal.appendSegment({
      sessionId: sid,
      fromRevision: 0,
      toRevision: 1,
      ops: [
        {
          revision: 1,
          op: { cmd: 'chart.add', spec: { ...SPEC, nativePart: true } },
          at: Date.now(),
          delta: [],
        },
      ],
      at: Date.now(),
    });
    const re = await post('/session/rehydrate', { sessionId: sid });
    expect(re.status).toBe(200);
    expect(re.json).toMatchObject({ checksumVerified: true, replayedOps: 1, revision: 1 });
    // The replayed chart is in sessionCharts → the next save authors it.
    const charts = await downloadCharts();
    expect(charts).toHaveLength(1);
    expect(charts[0]!.title).toBe('Sales by Quarter');
  });
});
