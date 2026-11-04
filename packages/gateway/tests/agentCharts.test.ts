/**
 * FIX-G Part 5 — the agent service's chart sink (trace §4.1a/§4.2):
 * createAgentChartSink resolves the principal's live engine session,
 * mints an engine-access token, and POSTs the spec to the owning
 * engine's /charts. No session → fails closed honestly. The final
 * test drives the sink against a REAL engine listener and proves the
 * chart lands as a native part in the downloaded bytes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { XlsxAdapter, readCharts } from '@icecream-sheets/xlsx-adapter';
import type { ChartSpec } from '@icecream-sheets/service';
import { createAgentChartSink } from '../src/services/agentSvc.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import type { ResolvedAgentSession } from '../src/services/agentSessionResolver.js';
import type {
  RemoteEngineFetch,
  RemoteEngineFetchInit,
} from '../src/services/remoteEngineHost.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = 'user:alice';

const SESSION: ResolvedAgentSession = {
  fileId: 'file-1',
  sessionId: 'sess_1',
  engineUrl: 'http://engine-9:8101',
  ownershipEpoch: 1,
  creatorPrincipal: ALICE,
  role: 'editor',
  currentRevision: 0,
  updatedAt: Date.now(),
};

const SPEC = {
  id: 5,
  kind: 'column-clustered',
  title: 'Sales by Quarter',
  range: { sheet: 'Data', startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
  nativePart: true,
} as unknown as ChartSpec;

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe('createAgentChartSink (FIX-G)', () => {
  it('POSTs the spec to the resolved engine /charts with the minted token', async () => {
    const calls: Array<{ url: string; init: RemoteEngineFetchInit }> = [];
    const fetchFn: RemoteEngineFetch = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true, id: 5, revision: 3 });
    };
    const sink = createAgentChartSink({
      resolveSession: async () => SESSION,
      mintEngineToken: (principal, session) => {
        expect(principal).toBe(ALICE);
        expect(session.sessionId).toBe('sess_1');
        return 'tok-abc';
      },
      fetchFn,
    });
    const out = await sink.addChart(SPEC, ALICE);
    expect(out).toEqual({ id: 5, revision: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://engine-9:8101/charts');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers['authorization']).toBe('Bearer tok-abc');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ spec: SPEC });
  });

  it('fails closed when the principal has no live session', async () => {
    const sink = createAgentChartSink({
      resolveSession: async () => null,
      mintEngineToken: () => 'tok',
      fetchFn: async () => {
        throw new Error('fetch must not be called');
      },
    });
    await expect(sink.addChart(SPEC, ALICE)).rejects.toThrow(
      'chart creation is not available in this session',
    );
  });

  it('fails closed when the resolver throws (broken registry)', async () => {
    const sink = createAgentChartSink({
      resolveSession: async () => {
        throw new Error('registry corrupt');
      },
      mintEngineToken: () => 'tok',
    });
    await expect(sink.addChart(SPEC, ALICE)).rejects.toThrow(
      'chart creation is not available in this session',
    );
  });

  it('surfaces an engine rejection as an error (never a silent success)', async () => {
    const sink = createAgentChartSink({
      resolveSession: async () => SESSION,
      mintEngineToken: () => 'tok',
      fetchFn: async () => jsonResponse(400, { error: 'invalid chart spec' }),
    });
    await expect(sink.addChart(SPEC, ALICE)).rejects.toThrow(/HTTP 400/);
  });

  it('FIX-R4: retries ONCE on a transient unknown-sheet refusal and succeeds', async () => {
    let fetches = 0;
    let resolves = 0;
    const sink = createAgentChartSink({
      resolveSession: async () => {
        resolves++;
        return SESSION;
      },
      mintEngineToken: () => 'tok',
      retryDelayMs: 0,
      fetchFn: async () => {
        fetches++;
        return fetches === 1
          ? jsonResponse(400, { error: 'unknown sheet: Data' })
          : jsonResponse(200, { ok: true, id: 5, revision: 3 });
      },
    });
    const out = await sink.addChart(SPEC, ALICE);
    expect(out).toEqual({ id: 5, revision: 3 });
    expect(fetches).toBe(2);
    expect(resolves).toBe(2); // re-resolved before the retry
  });

  it('FIX-R4: a persistent unknown-sheet refusal still fails after exactly one retry', async () => {
    let fetches = 0;
    const sink = createAgentChartSink({
      resolveSession: async () => SESSION,
      mintEngineToken: () => 'tok',
      retryDelayMs: 0,
      fetchFn: async () => {
        fetches++;
        return jsonResponse(400, { error: 'unknown sheet: Data' });
      },
    });
    await expect(sink.addChart(SPEC, ALICE)).rejects.toThrow(/HTTP 400/);
    expect(fetches).toBe(2);
  });

  it('FIX-R4: does not retry a non-transient rejection', async () => {
    let fetches = 0;
    const sink = createAgentChartSink({
      resolveSession: async () => SESSION,
      mintEngineToken: () => 'tok',
      retryDelayMs: 0,
      fetchFn: async () => {
        fetches++;
        return jsonResponse(400, { error: 'spec validation failed' });
      },
    });
    await expect(sink.addChart(SPEC, ALICE)).rejects.toThrow(/HTTP 400/);
    expect(fetches).toBe(1);
  });
});

describe('agent chart sink against a REAL engine listener (FIX-G)', () => {
  let engine: Started | null = null;
  afterEach(async () => {
    if (engine) await stop(engine);
    engine = null;
  });

  it('sink → POST /charts → download parse-back shows the native chart part', async () => {
    engine = await startServer(
      createEngineListener({ sessionStores: new MemorySessionStores() }),
    );
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
    const load = await httpJson('POST', `${engine.url}/load`, {
      headers: { 'x-principal': ALICE },
      body: { format: 'xlsx', data: Buffer.from(bytes).toString('base64') },
    });
    expect(load.status).toBe(200);
    const sessionId = (load.json as { sessionId: string }).sessionId;

    const sink = createAgentChartSink({
      resolveSession: async () => ({ ...SESSION, sessionId, engineUrl: engine!.url }),
      // Proxy-mode engine: no signing secret in this topology, so the
      // sink falls back to the x-principal header (remote-host rule).
      mintEngineToken: () => null,
    });
    const spec = {
      ...SPEC,
      seriesRanges: [
        {
          name: 'Sales',
          cat: { sheet: 'Data', startRow: 1, startCol: 0, endRow: 3, endCol: 0 },
          val: { sheet: 'Data', startRow: 1, startCol: 1, endRow: 3, endCol: 1 },
        },
      ],
      anchorCells: { fromCol: 3, fromRow: 1, toCol: 11, toRow: 16 },
    } as unknown as ChartSpec;
    const out = await sink.addChart(spec, ALICE);
    expect(out.revision).toBe(1);

    const dl = await fetch(`${engine.url}/download`, { headers: { 'x-principal': ALICE } });
    expect(dl.status).toBe(200);
    const meta = (await dl.json()) as { entryId: string };
    const entry = await fetch(`${engine.url}/library/${meta.entryId}`, {
      headers: { 'x-principal': ALICE },
    });
    const dlBytes = new Uint8Array(await entry.arrayBuffer());
    const files: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(unzipSync(dlBytes.slice()))) files[k] = v as Uint8Array;
    const charts = readCharts(files);
    expect(charts).toHaveLength(1);
    expect(charts[0]!.title).toBe('Sales by Quarter');
    expect(charts[0]!.series[0]!.valCache).toEqual([10, 20, 30]);
  });
});
