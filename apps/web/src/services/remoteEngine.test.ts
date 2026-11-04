/**
 * RemoteEngineHost tests (Cycle 10 Phase 3 integration).
 *
 * The Phase 2 sync-XHR bridge is GONE: render reads ride the async
 * transport behind the view cache (bulk-batched + deduped), edits route
 * through routeRecalc (routedEdit.ts), and opens consume the server's
 * progressive NDJSON stream (display-before-graph).
 */
import { describe, expect, it, vi } from 'vitest';
import { EngineHost, EngineWorkbook } from '@icecream-sheets/engine';
import type { EngineLoadResult } from './engineTransport';
import { GatewayClient, GatewayRateLimitError } from './gatewayClient';
import { RemoteEngineHost } from './remoteEngine';
import { CollabTransport, type EventSourceLike, type StorageLike } from './collabTransport';

const LOAD: EngineLoadResult = {
  ok: true,
  sheets: ['Sales', 'Ledger'],
  file: {
    sheets: [
      { name: 'Sales', formats: { codes: [], columns: {} } },
      { name: 'Ledger', formats: { codes: [], columns: {} } },
    ],
    metadata: {},
  },
  columnCounts: { Sales: [3], Ledger: [] },
};

function fakeTransport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    loadXlsx: vi.fn(async () => LOAD),
    reset: vi.fn(async () => undefined),
    sheetNames: vi.fn(async () => ['Sales', 'Ledger']),
    execute: vi.fn(async () => ({ ok: true })),
    readCell: vi.fn(async () => ({ value: { kind: 'null', value: null } })),
    readRange: vi.fn(async (range: { startRow: number; endRow: number; startCol: number; endCol: number }) => {
      const rows = range.endRow - range.startRow + 1;
      const cols = range.endCol - range.startCol + 1;
      return {
        values: Array.from({ length: rows }, () => Array(cols).fill({ kind: 'number', value: 7 })),
        formulas: Array.from({ length: rows }, () => Array(cols).fill(null)),
      };
    }),
    readSheet: vi.fn(async () => []),
    usedRange: vi.fn(async () => ({ sheet: 'Sales', startRow: 0, startCol: 0, endRow: 99, endCol: 9 })),
    snapshot: vi.fn(async () => ({ protocolVersion: 1, sheets: [] })),
    events: vi.fn(async () => []),
    ...overrides,
  };
}

function makeHost(transport: ReturnType<typeof fakeTransport>): RemoteEngineHost {
  const client = new GatewayClient('http://gateway.test');
  return new RemoteEngineHost(client, 60000, transport as never);
}

describe('RemoteEngineHost — async-only viewport pipeline', () => {
  it('fails soft on render reads for unknown sheets (never throws into the grid)', async () => {
    const h = makeHost(fakeTransport());
    await h.loadXlsxAsync('QQ==');
    expect(h.readCell({ sheet: 'Nope', row: 0, col: 0 })).toEqual({ kind: 'null', value: null });
    expect(h.getView().readCell({ sheet: 'Nope', row: 0, col: 0 }).value).toEqual({
      kind: 'null',
      value: null,
    });
    const grid = h.getView().readRange({ sheet: 'Nope', startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(grid).toHaveLength(2);
    expect(grid[0]?.[0]?.value).toEqual({ kind: 'null', value: null });
    h.dispose();
  });

  it('a 429 never breaks render reads; routed edits surface the failure + rollback', async () => {
    const transport = fakeTransport({
      execute: vi.fn(async () => {
        throw new GatewayRateLimitError('rate limited', 10);
      }),
    });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    expect(h.getView().readCell({ sheet: 'Sales', row: 0, col: 0 }).value).toEqual({
      kind: 'null',
      value: null,
    });
    const outcome = await h.executeRoutedAsync({
      cmd: 'setCell',
      ref: { sheet: 'Sales', row: 0, col: 0 },
      value: 5,
    });
    expect(outcome.result.ok).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(h.getOptimisticSession().baseRev).toBe(0);
    h.dispose();
  });

  it('issue #66: an in-flight local-route edit paints provisional values and repaints at begin', async () => {
    let release!: (v: { ok: boolean }) => void;
    const gate = new Promise<{ ok: boolean }>((resolve) => {
      release = resolve;
    });
    const transport = fakeTransport({ execute: vi.fn(() => gate) });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    // Mirror installed exactly as the open flows install it.
    h.setLocalMirror(new EngineHost(new EngineWorkbook({ Sales: [[1, '=A1+1']] })), 2);
    let repaints = 0;
    const unsub = h.subscribe(() => {
      repaints++;
    });
    const pending = h.executeRoutedAsync({
      cmd: 'setCell',
      ref: { sheet: 'Sales', row: 0, col: 0 },
      value: 5,
    });
    await new Promise((r) => setTimeout(r, 0));
    // The server has NOT answered yet (gate held): the grid's read
    // surface already serves the locally computed values — the edited
    // cell and its dependent — and a repaint was emitted at begin.
    expect(h.getView().readCell({ sheet: 'Sales', row: 0, col: 0 }).value).toEqual({
      kind: 'number',
      value: 5,
    });
    expect(h.getView().readCell({ sheet: 'Sales', row: 0, col: 1 }).value).toEqual({
      kind: 'number',
      value: 6,
    });
    expect(repaints).toBeGreaterThan(0);
    release({ ok: true });
    const out = await pending;
    expect(out.decision?.route).toBe('local');
    expect(out.result.ok).toBe(true);
    unsub();
    h.dispose();
  });

  it('executeRoutedAsync passes non-edit commands straight through the transport', async () => {
    const transport = fakeTransport();
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    const outcome = await h.executeRoutedAsync({ cmd: 'addSheet', name: 'Extra' });
    expect(outcome.result.ok).toBe(true);
    expect(transport.execute).toHaveBeenCalled();
    h.dispose();
  });

  it('bulk fan-out: 120 small tile reads in one tick collapse to O(few) transport calls', async () => {
    const transport = fakeTransport();
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    const view = h.getView();
    // First-paint fan-out shape (Phase 2 measured ≈548 range + ≈566
    // usedRange small reads ≈ 5.7s max task at P95): tiles read in one
    // render tick now merge into bulk reads through the batcher.
    for (let i = 0; i < 120; i++) {
      view.readRange({ sheet: 'Sales', startRow: i * 10, startCol: 0, endRow: i * 10 + 9, endCol: 49 });
    }
    await h.whenReadsIdle();
    const callsAfterFanout = (transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFanout).toBeLessThanOrEqual(3);
    const stats = h.viewportReadStats();
    expect(stats.requestedReads).toBeGreaterThanOrEqual(120);
    expect(stats.transportCalls).toBe(callsAfterFanout);
    // Warm cache: re-reading a painted cell issues ZERO new transport calls.
    expect(view.readCell({ sheet: 'Sales', row: 55, col: 3 }).value).toEqual({ kind: 'number', value: 7 });
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFanout);
    h.dispose();
  });

  it('usedRange is deduped: 50 concurrent lookups share one transport call', async () => {
    const transport = fakeTransport();
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    const results = await Promise.all(Array.from({ length: 50 }, () => h.usedRangeAsync('Sales')));
    expect((transport.usedRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(results.every((r) => r && r.endRow === 99)).toBe(true);
    h.dispose();
  });

  it('pending-calc cells render as pending (never a final blank) until live values land', async () => {
    const h = makeHost(fakeTransport());
    await h.loadXlsxAsync('QQ==');
    const ref = { sheet: 'Sales', row: 0, col: 1 };
    h.seedStreamedCells({
      Sales: [
        { row: 0, col: 0, value: { kind: 'number', value: 5 } },
        { row: 0, col: 1, value: { kind: 'null', value: null }, formula: '=A1*2', pending: true },
      ],
    });
    expect(h.isPendingCalc(ref)).toBe(true);
    expect(h.pendingCalcCount()).toBe(1);
    // A sibling with a real cached value paints immediately.
    expect(h.readCell({ sheet: 'Sales', row: 0, col: 0 })).toEqual({ kind: 'number', value: 5 });
    // When calc lands, the pending mark clears and the live value paints.
    h.seedStreamedCells({
      Sales: [{ row: 0, col: 1, value: { kind: 'number', value: 10 }, formula: '=A1*2' }],
    });
    expect(h.isPendingCalc(ref)).toBe(false);
    expect(h.readCell(ref)).toEqual({ kind: 'number', value: 10 });
    h.dispose();
  });

  it('snapshot: name-only until pulled; snapshotAsync caches; a routed edit invalidates', async () => {
    const snap = {
      protocolVersion: 1,
      sheets: [{ name: 'Sales', cells: [{ ref: { sheet: 'Sales', row: 0, col: 0 }, input: 5 }] }],
    };
    const transport = fakeTransport({ snapshot: vi.fn(async () => snap) });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    // Sync snapshot before any pull: name-only fallback (no cells) — the
    // shape that must never reach a serializer on its own.
    const cold = h.snapshot() as { sheets: { name: string; cells: unknown[] }[] };
    expect(cold.sheets.length).toBeGreaterThan(0);
    expect(cold.sheets.every((s) => s.cells.length === 0)).toBe(true);
    // Pull: the authoritative snapshot lands in the sync cache.
    const pulled = await h.snapshotAsync();
    expect(pulled).toBe(snap);
    expect(h.snapshot()).toBe(snap);
    expect(transport.snapshot).toHaveBeenCalledTimes(1);
    // Cached: a second pull does not refetch.
    await h.snapshotAsync();
    expect(transport.snapshot).toHaveBeenCalledTimes(1);
    // A routed cell edit invalidates: the next pull refetches.
    const outcome = await h.executeRoutedAsync({ cmd: 'setCell', ref: { sheet: 'Sales', row: 0, col: 0 }, value: 9 });
    expect(outcome.result.ok).toBe(true);
    await h.snapshotAsync();
    expect(transport.snapshot).toHaveBeenCalledTimes(2);
    h.dispose();
  });

  it('snapshotAsync carries the snapshot metadata channel verbatim (File-2 D1 follow-up)', async () => {
    // The engine /snapshot response carries an additive `metadata`
    // field (source metadata merged under session extras). The web
    // host must surface it untouched: the shell's join/rehydrate path
    // hydrates imported pictures/text boxes from exactly this record.
    const metadata = {
      'icecream.pictures': [
        { id: 1, x: 902, y: 23, w: 14, h: 18, dataUrl: 'data:image/png;base64,AA==', name: 'logo', sheet: 'icons' },
      ],
      'icecream.textboxes': [{ id: 2, x: 0, y: 30, w: 1152, h: 155, text: 'note', sheet: 'International URLs' }],
    };
    const snap = { protocolVersion: 1, sheets: [{ name: 'icons', cells: [] }], metadata };
    const transport = fakeTransport({ snapshot: vi.fn(async () => snap) });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    const pulled = await h.snapshotAsync();
    expect(pulled.metadata).toEqual(metadata);
    expect(h.snapshot().metadata).toEqual(metadata);
    h.dispose();
  });

  it('consumes the real /load/stream schema: meta → rows → data-done (Calculating) → built', async () => {
    const ndjson = [
      JSON.stringify({
        type: 'meta',
        sheets: ['Sales'],
        totalSheets: 1,
        totalCells: 2,
        metadata: {},
        progress: { sheetsDone: 0, cellsDone: 0, totalSheets: 1, totalCells: 2 },
      }),
      JSON.stringify({
        type: 'rows',
        sheet: 'Sales',
        index: 0,
        startRow: 0,
        rows: [[5, '=A1*2']],
        display: [[5, null]],
        formats: { codes: [], columns: {} },
        pendingCalc: ['0:1'],
        progress: { sheetsDone: 0, cellsDone: 2, totalSheets: 1, totalCells: 2 },
      }),
      JSON.stringify({
        type: 'data-done',
        totalCells: 2,
        progress: { sheetsDone: 1, cellsDone: 2, totalSheets: 1, totalCells: 2 },
      }),
      JSON.stringify({
        type: 'built',
        response: {
          ok: true,
          sheets: ['Sales'],
          file: { sheets: [{ name: 'Sales', formats: { codes: [], columns: {} } }], metadata: {} },
          columnCounts: { Sales: [2] },
        },
      }),
    ].join('\n') + '\n';
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('/load/stream')) {
        return new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
      }
      if (url.includes('/sheets')) {
        return new Response(JSON.stringify({ sheets: ['Sales'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const client = new GatewayClient('http://gateway.test');
      const h = new RemoteEngineHost(client, 60000); // real GatewayEngineTransport
      const summaries: Array<{ rawType: string; progressPct?: number; calculating?: boolean }> = [];
      const result = await h.loadXlsxAsync('QQ==', (_acc, _done, chunk) => {
        summaries.push({
          rawType: chunk.rawType,
          progressPct: chunk.progressPct,
          calculating: chunk.calculating,
        });
        if (chunk.rawType === 'rows') {
          // Display-before-graph: the cached value paints mid-stream,
          // before the engine build (built) has even arrived.
          expect(h.readCell({ sheet: 'Sales', row: 0, col: 0 })).toEqual({ kind: 'number', value: 5 });
          expect(h.isPendingCalc({ sheet: 'Sales', row: 0, col: 1 })).toBe(true);
        }
      });
      expect(summaries.map((s) => s.rawType)).toEqual(['meta', 'rows', 'data-done', 'built']);
      // data-done: all data in, engine still building → Calculating…
      const dataDone = summaries.find((s) => s.rawType === 'data-done');
      expect(dataDone?.calculating).toBe(true);
      expect(dataDone?.progressPct).toBe(100);
      const builtSummary = summaries[summaries.length - 1];
      expect(builtSummary?.calculating).toBe(false);
      expect(result.sheets).toEqual(['Sales']);
      h.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('RemoteEngineHost — Phase 2 collab transport (SSE always-on)', () => {
  class FakeES implements EventSourceLike {
    private listeners = new Map<string, Array<(ev: { data?: string }) => void>>();
    onerror: ((ev: unknown) => void) | null = null;
    constructor(readonly url: string) {
      FakeES.last = this;
    }
    static last: FakeES | null = null;
    addEventListener(type: string, l: (ev: { data?: string }) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(l);
      this.listeners.set(type, list);
    }
    emit(type: string, data: unknown): void {
      for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(data) });
    }
    close(): void {}
  }

  function makeCollabTransport(fetchFn: typeof fetch): CollabTransport {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    return new CollabTransport({
      gateway: {
        openFile: async () => ({
          ok: true as const,
          fileId: 'file-1',
          sessionId: 'sess-1',
          engineUrl: 'http://engine-1',
          accessToken: 'tok-1',
          role: 'editor' as const,
          revision: 0,
          joined: false,
          ownershipEpoch: 1,
        }),
      } as never,
      host: {
        applyDeltaCells: () => {},
        applySessionEvent: () => {},
        resync: async () => undefined,
      },
      storage,
      fetchFn,
      eventSourceFactory: (url) => new FakeES(url),
    });
  }

  const okFetch = (async (url: string) =>
    ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('/ops')
          ? { ok: true, revision: 1, ack: { revision: 1, changedCellCount: 1, checksum: 'x' } }
          : { ok: true },
      text: async () => '{}',
      headers: { get: () => null },
    }) as unknown as Response) as typeof fetch;

  it('stops /events polling while the collab transport is attached (§8: no polling fallback)', async () => {
    const transport = fakeTransport();
    const client = new GatewayClient('http://gateway.test');
    const h = new RemoteEngineHost(client, 5, transport as never);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Phase 2 fix (read gate): before any session is bound there is NO
    // polling at all — the unbound poll was part of the boot storm.
    await wait(40);
    expect((transport.events as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    // Bind via a load (the load introduces the session): polling runs.
    await h.loadXlsxAsync('QQ==');
    await wait(40);
    const pollingCalls = (transport.events as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(pollingCalls).toBeGreaterThan(0);
    const collab = makeCollabTransport(okFetch);
    h.attachCollabTransport(collab);
    expect(h.collabActive).toBe(true);
    await wait(40);
    // ZERO further /events calls while SSE is the channel.
    expect((transport.events as ReturnType<typeof vi.fn>).mock.calls.length).toBe(pollingCalls);
    h.detachCollabTransport();
    await wait(40);
    expect((transport.events as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(pollingCalls);
    collab.disconnect();
    h.dispose();
  });

  it('applyDeltaCells seeds the confirmed layer; hidden cells are cleared, never shown', async () => {
    const h = makeHost(fakeTransport());
    await h.loadXlsxAsync('QQ==');
    h.applyDeltaCells(
      [{ sheet: 'Sales', row: 2, col: 2, value: { kind: 'number', value: 99 } }],
      { revision: 1, origin: { clientId: 'peer' } },
    );
    expect(h.readCell({ sheet: 'Sales', row: 2, col: 2 })).toEqual({ kind: 'number', value: 99 });
    h.applyDeltaCells([{ sheet: 'Sales', row: 2, col: 2, hidden: true }], {
      revision: 2,
      origin: { clientId: 'peer' },
    });
    expect(h.readCell({ sheet: 'Sales', row: 2, col: 2 })).toEqual({ kind: 'null', value: null });
    h.dispose();
  });

  it('routes mutating executes through POST /ops with the envelope once the transport is bound', async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchFn = (async (url: string, init?: { body?: string }) => {
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return okFetch(url, init as never);
    }) as typeof fetch;
    const collab = makeCollabTransport(fetchFn);
    await collab.connect('file-1');
    FakeES.last!.emit('hello', { revision: 0, storedRevision: 0, fileId: 'file-1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(collab.connectionState).toBe('connected');

    const transport = fakeTransport();
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    h.attachCollabTransport(collab);
    const outcome = await h.executeRoutedAsync({
      cmd: 'setCell',
      ref: { sheet: 'Sales', row: 0, col: 0 },
      value: 5,
    });
    expect(outcome.result.ok).toBe(true);
    const opsPost = fetchCalls.find((c) => c.url === 'http://engine-1/ops');
    expect(opsPost).toBeTruthy();
    expect(opsPost!.body).toMatchObject({
      clientId: collab.clientId,
      clientSeq: 1,
      baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sales', row: 0, col: 0 }, value: 5 },
    });
    // The legacy proxied execute path was NOT used for the mutation.
    expect(transport.execute).not.toHaveBeenCalled();
    collab.disconnect();
    h.dispose();
  });

  it('#98: an edit issued in the join window waits for the bind — never transport.execute with a pre-bind grant', async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchFn = (async (url: string, init?: { body?: string }) => {
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return okFetch(url, init as never);
    }) as typeof fetch;
    const collab = makeCollabTransport(fetchFn);
    const transport = fakeTransport();
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    h.attachCollabTransport(collab);
    // Join window: attached, but connect() has not run — no fileId yet.
    expect(collab.fileId).toBeNull();
    const pending = h.executeRoutedAsync({
      cmd: 'setCell',
      ref: { sheet: 'Sales', row: 0, col: 0 },
      value: 5,
    });
    // The edit must NOT fall through to transport.execute while unbound
    // (old behavior: fired immediately with the pre-bind grant — the
    // VM-pass burst: /execute -> tier URL -> 401).
    await new Promise((r) => setTimeout(r, 150));
    expect(transport.execute).not.toHaveBeenCalled();
    // Now the join completes: the edit submits through /ops on the
    // open-time signed link, and transport.execute is never touched.
    await collab.connect('file-1');
    FakeES.last!.emit('hello', { revision: 0, storedRevision: 0, fileId: 'file-1' });
    const outcome = await pending;
    expect(outcome.result.ok).toBe(true);
    expect(fetchCalls.some((c) => c.url === 'http://engine-1/ops')).toBe(true);
    expect(transport.execute).not.toHaveBeenCalled();
    expect(fetchCalls.some((c) => c.url.endsWith('/execute'))).toBe(false);
    collab.disconnect();
    h.dispose();
  });

  it('#98: an edit issued while the join never completes rejects visibly — never transport.execute', async () => {
    const collab = makeCollabTransport(okFetch);
    const transport = fakeTransport();
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    h.attachCollabTransport(collab);
    expect(collab.fileId).toBeNull();
    // The 10 s bind wait times out: the edit is rejected (rolled back)
    // with NO stray request — the old code would have fired
    // transport.execute at the tier URL with a pre-bind grant here.
    const outcome = await h.executeRoutedAsync({
      cmd: 'setCell',
      ref: { sheet: 'Sales', row: 0, col: 0 },
      value: 5,
    });
    expect(outcome.result.ok).toBe(false);
    expect(transport.execute).not.toHaveBeenCalled();
    collab.disconnect();
    h.dispose();
  }, 20000);
});

describe('RemoteEngineHost — W16 windowed retention for huge no-mirror opens', () => {
  it('bounds the view cache past the threshold and preserves pending marks across the terminal reset', async () => {
    const rowsChunk = (startRow: number, display: unknown[][], rows: unknown[][], pendingCalc: string[]) => ({
      rawType: 'rows',
      raw: {
        type: 'rows',
        sheet: 'Sales',
        index: 0,
        startRow,
        rows,
        display,
        formats: { codes: [], columns: {} },
        pendingCalc,
        progress: { sheetsDone: 0, cellsDone: 0, totalSheets: 1, totalCells: null },
      },
    });
    const transport = fakeTransport({
      loadXlsxProgressive: vi.fn(
        async (
          _b64: string,
          onChunk: (acc: unknown, done: boolean, chunk: unknown) => void,
        ) => {
          const acc = {
            ok: true,
            sheets: ['Sales'],
            file: { sheets: [{ name: 'Sales', formats: { codes: [], columns: {} } }], metadata: {} },
            columnCounts: { Sales: [30] },
          };
          // 30 value cells in 3 chunks (threshold 10) + 1 pending cell.
          for (let s = 0; s < 3; s++) {
            const disp = [Array.from({ length: 10 }, (_, i) => s * 10 + i)];
            onChunk(acc, false, rowsChunk(s, disp, disp, []));
          }
          onChunk(acc, false, rowsChunk(3, [[null]], [['=A1*2']], ['3:0']));
          onChunk(acc, true, { rawType: 'built' });
          return acc;
        },
      ),
    });
    const client = new GatewayClient('http://gateway.test');
    const h = new RemoteEngineHost(client, 60000, transport as never, { threshold: 10, cap: 12 });
    await h.loadXlsxAsync('QQ==');
    const stats = h.viewCacheStats();
    expect(stats.windowed).toBe(true);
    // The pending mark seeded mid-stream survived the terminal reset
    // (the reset clears the value cache; marks are restored).
    expect(h.isPendingCalc({ sheet: 'Sales', row: 3, col: 0 })).toBe(true);
    expect(stats.pendingCalc).toBe(1);
    // Seeding beyond the cap trims to the window; an evicted cell is a
    // plain cache miss that re-reads through the bulk path.
    h.seedStreamedCells({
      Sales: Array.from({ length: 20 }, (_, i) => ({
        row: 10,
        col: i,
        value: { kind: 'number', value: i } as const,
      })),
    });
    expect(h.viewCacheStats().cachedCells).toBeLessThanOrEqual(12);
    const evicted = h.readCell({ sheet: 'Sales', row: 0, col: 0 });
    expect(evicted).toEqual({ kind: 'null', value: null });
    await h.whenReadsIdle();
    expect(h.readCell({ sheet: 'Sales', row: 0, col: 0 })).toEqual({ kind: 'number', value: 7 });
    h.dispose();
  });
});

describe('RemoteEngineHost — Phase 2 fix: read gate, direct collab load, failure breaker', () => {
  it('issues ZERO network reads before a session is bound; reads flow after the load binds', async () => {
    const transport = fakeTransport();
    const h = makeHost(transport);
    const view = h.getView();
    // Boot state: the grid renders an empty workbook and asks for
    // names + cells. Pre-fix this stormed the gateway proxy (8,195
    // requests in ~65 s, all 401/429 in signed mode).
    view.readCell({ sheet: 'Sales', row: 0, col: 0 });
    view.readRange({ sheet: 'Sales', startRow: 0, startCol: 0, endRow: 9, endCol: 9 });
    await h.refreshSheetNames();
    await h.whenReadsIdle();
    expect(h.isSessionBound).toBe(false);
    expect(transport.sheetNames).not.toHaveBeenCalled();
    expect(transport.readRange).not.toHaveBeenCalled();
    expect(transport.usedRange).not.toHaveBeenCalled();
    expect(transport.events).not.toHaveBeenCalled();
    // The load introduces the session → bound → reads flow.
    await h.loadXlsxAsync('QQ==');
    expect(h.isSessionBound).toBe(true);
    view.readCell({ sheet: 'Sales', row: 40, col: 3 });
    await h.whenReadsIdle();
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    await h.refreshSheetNames();
    expect(transport.sheetNames).toHaveBeenCalled();
    h.dispose();
  });

  it('bounds a failure storm: after the first failure, fresh-key reads add no transport calls inside the backoff window', async () => {
    const transport = fakeTransport({
      readRange: vi.fn(async () => {
        throw new Error('engine access denied: wrong-session (401)');
      }),
      usedRange: vi.fn(async () => {
        throw new Error('engine access denied: wrong-session (401)');
      }),
    });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    const view = h.getView();
    view.readCell({ sheet: 'Sales', row: 0, col: 0 });
    await h.whenReadsIdle();
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // A render walk minting FRESH keys (new rows) must not mint fresh
    // requests while the breaker window is open.
    for (let r = 10; r < 40; r++) view.readCell({ sheet: 'Sales', row: r, col: 0 });
    view.readRange({ sheet: 'Ledger', startRow: 0, startCol: 0, endRow: 20, endCol: 5 });
    await h.whenReadsIdle();
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const stats = h.readGateStats();
    expect(stats.failStreak).toBeGreaterThanOrEqual(1);
    expect(stats.downUntil).toBeGreaterThan(Date.now());
    h.dispose();
  });

  it('issue #87: the sheet-name fetch is failure-bounded — a render storm during a persistent failure mints ONE fetch, and the retry timer heals it', async () => {
    let failing = true;
    const transport = fakeTransport({
      sheetNames: vi.fn(async () => {
        if (failing) throw new Error('engine access denied: wrong-session (401)');
        return ['Sales', 'Ledger'];
      }),
    });
    const h = makeHost(transport);
    // Bind WITHOUT a load (the load path seeds the name cache; the #87
    // field state is the post-resync one: session bound, name cache
    // empty, every /sheets fetch failing).
    h.markSessionBound();
    const calls = () =>
      (transport.sheetNames as ReturnType<typeof vi.fn>).mock.calls.length;
    // A render storm: sheetNames() is called on every render while the
    // cache is empty. Pre-fix each call minted its own fetch (the local
    // repro counted 1,014 fetches in 15 s of this).
    for (let i = 0; i < 50; i++) h.sheetNames();
    await h.refreshSheetNames(); // joins the in-flight attempt
    expect(calls()).toBe(1);
    // Inside the failure-backoff window, further renders mint NOTHING.
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 50; i++) h.sheetNames();
    await h.refreshSheetNames();
    expect(calls()).toBe(1);
    // The failure clears; the armed retry timer re-drives the refresh
    // on its own (no render needed) and the names land.
    failing = false;
    await new Promise((r) => setTimeout(r, 650));
    expect(calls()).toBe(2);
    expect(h.sheetNames()).toEqual(['Sales', 'Ledger']);
    h.dispose();
  });

  it('issue #87 (cycle 2): a breaker-gated readCellAsync settles WITHOUT a repaint tick (the FormulaBar loop)', async () => {
    const transport = fakeTransport({
      readRange: vi.fn(async () => {
        throw new Error('engine access denied: wrong-session (401)');
      }),
    });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    let ticks = 0;
    h.subscribe(() => {
      ticks++;
    });
    // Arm the failure breaker with one real (doomed) bulk read.
    await expect(
      h.readRangeAsync({ sheet: 'Sales', startRow: 0, startCol: 0, endRow: 2, endCol: 2 }),
    ).rejects.toThrow();
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const ticksAfterArming = ticks;
    // Inside the breaker window, resolve the selected cell's formula
    // state the way FormulaBar's effect does on every host tick. The
    // cell is not formula-resolved, so this rides the batcher — gated.
    // Pre-fix the gated read RESOLVED empty and readRangeNow reported
    // a settle (tick++), the effect re-ran on the new tick, and the
    // pair cycled for the whole window. Post-fix the gated read
    // rejects inside the batcher, readCellAsync answers from the sync
    // view, and NO tick is emitted — and no transport call is made.
    const got = await h.readCellAsync({ sheet: 'Sales', row: 0, col: 0 });
    expect(got.value).toEqual({ kind: 'null', value: null });
    expect(ticks).toBe(ticksAfterArming);
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    h.dispose();
  });

  it('loads through the collab transport DIRECTLY once a handshake session is opened (never the legacy transport load)', async () => {
    const ndjson =
      [
        JSON.stringify({
          type: 'meta',
          sheets: ['Sales'],
          totalSheets: 1,
          totalCells: 0,
          metadata: {},
          progress: { sheetsDone: 0, cellsDone: 0, totalSheets: 1, totalCells: 0 },
        }),
        JSON.stringify({
          type: 'built',
          response: {
            ok: true,
            sheets: ['Sales'],
            file: { sheets: [{ name: 'Sales', formats: { codes: [], columns: {} } }], metadata: {} },
            columnCounts: { Sales: [0] },
          },
        }),
      ].join('\n') + '\n';
    const bytes = new TextEncoder().encode(ndjson);
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchFn = (async (url: string, init?: { body?: string }) => {
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith('/load/stream')) {
        let i = 0;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () =>
                i++ < 1 ? { done: false, value: bytes } : { done: true, value: undefined },
            }),
          },
          json: async () => ({}),
          text: async () => ndjson,
          headers: { get: () => null },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response;
    }) as typeof fetch;
    const storage: StorageLike = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const collab = new CollabTransport({
      gateway: {
        openFile: async () => ({
          ok: true as const,
          fileId: 'file-1',
          sessionId: 'sess-1',
          engineUrl: 'http://engine-1',
          accessToken: 'tok-1',
          role: 'editor' as const,
          revision: 0,
          joined: false,
          ownershipEpoch: 1,
        }),
      } as never,
      host: {
        applyDeltaCells: () => {},
        applySessionEvent: () => {},
        resync: async () => undefined,
      },
      storage,
      fetchFn,
      eventSourceFactory: (url) =>
        ({
          url,
          onerror: null,
          addEventListener: () => {},
          close: () => {},
        }) as EventSourceLike,
    });
    await collab.connect('file-1');
    const transport = fakeTransport();
    const h = makeHost(transport);
    h.attachCollabTransport(collab);
    const result = await h.loadXlsxAsync('QQ==');
    expect(result.sheets).toEqual(['Sales']);
    // The load went DIRECT to the owner engine with the claimed
    // sessionId; the legacy transport load was never touched.
    expect(transport.loadXlsx).not.toHaveBeenCalled();
    const streamCall = fetchCalls.find((c) => c.url.endsWith('/load/stream'));
    expect(streamCall).toBeTruthy();
    expect(streamCall!.url).toBe('http://engine-1/load/stream');
    expect(streamCall!.body).toMatchObject({ sessionId: 'sess-1', format: 'xlsx' });
    expect(h.isSessionBound).toBe(true);
    collab.disconnect();
    h.dispose();
  });

  it('resets through the collab transport DIRECTLY once a handshake session is opened (never the legacy transport reset)', async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchFn = (async (url: string, init?: { body?: string }) => {
      fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith('/reset')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, sessionId: 'sess-1' }),
          text: async () => '{}',
          headers: { get: () => null },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response;
    }) as typeof fetch;
    const storage: StorageLike = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const collab = new CollabTransport({
      gateway: {
        openFile: async () => ({
          ok: true as const,
          fileId: 'file-1',
          sessionId: 'sess-1',
          engineUrl: 'http://engine-1',
          accessToken: 'tok-1',
          role: 'editor' as const,
          revision: 0,
          joined: false,
          ownershipEpoch: 1,
        }),
      } as never,
      host: {
        applyDeltaCells: () => {},
        applySessionEvent: () => {},
        resync: async () => undefined,
      },
      storage,
      fetchFn,
      eventSourceFactory: (url) =>
        ({
          url,
          onerror: null,
          addEventListener: () => {},
          close: () => {},
        }) as EventSourceLike,
    });
    await collab.connect('file-1');
    const transport = fakeTransport();
    const h = makeHost(transport);
    h.attachCollabTransport(collab);
    await h.resetRemoteAsync();
    expect(transport.reset).not.toHaveBeenCalled();
    const resetCall = fetchCalls.find((c) => c.url === 'http://engine-1/reset');
    expect(resetCall).toBeTruthy();
    expect(h.isSessionBound).toBe(true);
    collab.disconnect();
    h.dispose();
  });

  it('resetRemoteAsync falls back to the legacy transport reset when no handshake session is opened', async () => {
    const transport = fakeTransport();
    const h = makeHost(transport);
    await h.resetRemoteAsync();
    expect(transport.reset).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});

describe('RemoteEngineHost — File-2 defect D2: breaker-lift retry + gated used-range', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('re-notifies when the failure-breaker window elapses, so reads queued during the window get re-rendered', async () => {
    const transport = fakeTransport({
      readRange: vi.fn(async () => {
        throw new Error('Unknown sheet: Sheet1 (404)');
      }),
    });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    let notifications = 0;
    h.subscribe(() => {
      notifications++;
    });
    const view = h.getView();
    // One doomed read (the open-phase superseded-workbook 404 family):
    // the batch fails, the breaker arms for 500 ms, the settle notifies.
    view.readCell({ sheet: 'Sales', row: 0, col: 0 });
    await h.whenReadsIdle();
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(h.readGateStats().downUntil).toBeGreaterThan(Date.now());
    const settledNotifications = notifications;
    expect(settledNotifications).toBeGreaterThan(0);
    // No further reads at all: when the window elapses, the lift nudge
    // must fire on its own (pre-fix nothing ever re-rendered, and a
    // sheet first visited inside the window stayed blank all visit).
    await wait(750);
    expect(notifications).toBeGreaterThan(settledNotifications);
    // The nudge itself issues no fetches — it only re-runs the render.
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    h.dispose();
  });

  it('a used-range read gated by the breaker resolves null WITHOUT caching it — the post-lift read fetches for real', async () => {
    const transport = fakeTransport({
      readRange: vi.fn(async () => {
        throw new Error('Unknown sheet: Sheet1 (404)');
      }),
    });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    const view = h.getView();
    // usedRangeAsync is a RemoteView method the TypedView type does not
    // surface; the host's view IS the RemoteView at runtime.
    const usedRangeAsync = (sheet: string) =>
      (view as unknown as { usedRangeAsync(s: string): Promise<unknown> }).usedRangeAsync(sheet);
    view.readCell({ sheet: 'Sales', row: 0, col: 0 });
    await h.whenReadsIdle();
    expect(h.readGateStats().downUntil).toBeGreaterThan(Date.now());
    // Inside the breaker window: contract still resolves null, but the
    // non-answer must not reach the transport NOR the deduper cache.
    // ('Ledger' was never read or warmed, so its cache is empty; the one
    // usedRange call so far is the legitimate pre-failure 'Sales' warm.)
    const callsBefore = (transport.usedRange as ReturnType<typeof vi.fn>).mock.calls.length;
    const gated = await usedRangeAsync('Ledger');
    expect(gated).toBeNull();
    expect((transport.usedRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    // After the window: the same call fetches and returns the real range.
    await wait(750);
    const real = await usedRangeAsync('Ledger');
    expect((transport.usedRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
    expect((transport.usedRange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('Ledger');
    expect(real).toEqual({ sheet: 'Sales', startRow: 0, startCol: 0, endRow: 99, endCol: 9 });
    h.dispose();
  });
});

describe('RemoteEngineHost — Wave-C W5: breaker-lift must survive an interleaved success', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a success landing while a lift is pending fires the lift notify instead of disarming it', async () => {
    // The used-range fetch stays in flight until released, so it can
    // succeed AFTER a concurrent range read has failed — the exact
    // interleaving a join burst produces (~25 concurrent reads: the
    // window 404s fail fast, slower reads succeed afterwards).
    let releaseUsedRange!: (v: unknown) => void;
    const usedRangeGate = new Promise((res) => {
      releaseUsedRange = res;
    });
    const transport = fakeTransport({
      readRange: vi.fn(async () => {
        throw new Error('Unknown sheet: Sheet1 (404)');
      }),
      usedRange: vi.fn(async () => usedRangeGate),
    });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    let notifications = 0;
    h.subscribe(() => {
      notifications++;
    });
    const view = h.getView();
    const usedRangeAsync = (sheet: string) =>
      (view as unknown as { usedRangeAsync(s: string): Promise<unknown> }).usedRangeAsync(sheet);

    // 1) A used-range fetch goes in flight FIRST (breaker still up).
    const pendingUsed = usedRangeAsync('Ledger');
    // 2) A range read fails fast: breaker arms (500 ms), lift timer armed.
    view.readCell({ sheet: 'Sales', row: 0, col: 0 });
    await h.whenReadsIdle();
    expect(h.readGateStats().downUntil).toBeGreaterThan(Date.now());
    const settled = notifications;
    expect(settled).toBeGreaterThan(0);
    // 3) The in-flight used-range now SUCCEEDS (reads flow again). On
    //    the broken code, noteFetchOk clears the lift timer silently:
    //    no notification ever fires again, and a sheet first rendered
    //    inside the window stays blank for the whole visit — the W5
    //    join evidence (3 of 4 joins blank; only a tab switch revives).
    releaseUsedRange({ sheet: 'Ledger', startRow: 0, startCol: 0, endRow: 99, endCol: 9 });
    await pendingUsed;
    // 4) Well past the breaker window, the lift must have fired — at
    //    the disarming success or at window elapse.
    await wait(750);
    expect(notifications).toBeGreaterThan(settled);
    h.dispose();
  });
});

describe('RemoteEngineHost — issue #43: formula resolution for the formula bar', () => {
  it('readCellAsync resolves the formula for a stream-seeded values-only cell, once', async () => {
    // Same contract as the desktop host: a cell seeded by the
    // progressive stream may carry a VALUE without its formula in
    // cache. readCellAsync must not trust that cache state — it falls
    // through to the authoritative one-cell bulk read, whose payload
    // settles the formula state; later calls answer from cache.
    const transport = fakeTransport({
      readRange: vi.fn(async () => ({
        values: [[{ kind: 'number', value: 30 }]],
        formulas: [['SUM(A1:A2)']],
      })),
    });
    const h = makeHost(transport);
    await h.loadXlsxAsync('QQ==');
    const ref = { sheet: 'Sales', row: 0, col: 0 };
    h.seedStreamedCells({ Sales: [{ row: 0, col: 0, value: { kind: 'number', value: 30 } }] });
    const syncCell = h.getView().readCell(ref);
    expect(syncCell.value).toEqual({ kind: 'number', value: 30 });
    expect(syncCell.formula).toBeUndefined(); // values-only seed, pinned
    const callsBefore = (transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(h.readCellAsync(ref)).resolves.toEqual({
      value: { kind: 'number', value: 30 },
      formula: 'SUM(A1:A2)',
    });
    // The resolution cost at least one authoritative transport read
    // (batcher coalescing decides the exact count, not this contract).
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    // Resolved via the bulk payload: the sync view now carries it too,
    // and once reads settle, a second async read issues NO further
    // transport call — the resolved state is cached.
    expect(h.getView().readCell(ref).formula).toBe('SUM(A1:A2)');
    await h.whenReadsIdle();
    const settledCalls = (transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(h.readCellAsync(ref)).resolves.toEqual({
      value: { kind: 'number', value: 30 },
      formula: 'SUM(A1:A2)',
    });
    expect((transport.readRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(settledCalls);
    h.dispose();
  });
});
