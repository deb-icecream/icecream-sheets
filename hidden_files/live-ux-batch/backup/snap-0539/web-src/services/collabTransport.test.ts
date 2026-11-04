/**
 * CollabTransport tests (Phase 2): durable queue, in-order delta apply
 * with gap catch-up, own-op ack matching, rejected-op retention,
 * reconnect re-lookup + in-order resubmission, and the gateway
 * openFile handshake shape. All against fakes — the live-stack matrix
 * is the coordinator's gate (§10).
 */
import { describe, expect, it, vi } from 'vitest';
import type { EngineCommand } from '@icecream-sheets/engine';
import {
  CollabTransport,
  getOrCreateClientId,
  participantDisplayName,
  participantInitials,
  type CollabHostAdapter,
  type EventSourceLike,
  type StorageLike,
} from './collabTransport';
import { GatewayClient, type EngineOpenResult } from './gatewayClient';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, Array<(ev: { data?: string }) => void>>();
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: { data?: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, data: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(data) });
  }
  drop(): void {
    this.onerror?.(new Error('connection lost'));
  }
  close(): void {
    this.closed = true;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function makeFetch(handler?: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (handler) return handler(call);
    if (call.url.includes('/ops')) {
      return jsonResponse({ ok: true, revision: 1, ack: { revision: 1, changedCellCount: 1, checksum: 'x' } });
    }
    return jsonResponse({ ok: true });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeGateway(revision = 0) {
  let n = 0;
  const opened: EngineOpenResult[] = [];
  const gateway = {
    openFile: vi.fn(async (_opts?: unknown) => {
      n++;
      const res: EngineOpenResult = {
        ok: true,
        fileId: 'file-1',
        sessionId: 'sess-1',
        engineUrl: `http://engine-${n}`,
        accessToken: `tok-${n}`,
        role: 'editor',
        revision,
        joined: n > 1,
        ownershipEpoch: n,
      };
      opened.push(res);
      return res;
    }),
  };
  return { gateway: gateway as unknown as Pick<GatewayClient, 'openFile'>, opened };
}

function makeHost(resyncImpl?: () => Promise<number | void>) {
  const applied: Array<{ revision: number; cells: unknown[] }> = [];
  const sessionEvents: unknown[] = [];
  let resyncCalls = 0;
  const host: CollabHostAdapter = {
    applyDeltaCells: (cells, meta) => {
      applied.push({ revision: meta.revision, cells });
    },
    applySessionEvent: (ev) => {
      sessionEvents.push(ev);
    },
    resync: async () => {
      resyncCalls++;
      return resyncImpl ? resyncImpl() : undefined;
    },
  };
  return { host, applied, sessionEvents, resyncCalls: () => resyncCalls };
}

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const SET_A1: EngineCommand = { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 42 };

function makeTransport(overrides: {
  storage?: FakeStorage;
  gateway?: ReturnType<typeof makeGateway>;
  host?: ReturnType<typeof makeHost>;
  fetch?: ReturnType<typeof makeFetch>;
  deps?: Partial<ConstructorParameters<typeof CollabTransport>[0]>;
} = {}) {
  FakeEventSource.instances = [];
  const storage = overrides.storage ?? new FakeStorage();
  const gw = overrides.gateway ?? makeGateway();
  const h = overrides.host ?? makeHost();
  const f = overrides.fetch ?? makeFetch();
  const transport = new CollabTransport({
    gateway: gw.gateway,
    host: h.host,
    storage,
    fetchFn: f.fetchFn,
    eventSourceFactory: (url) => new FakeEventSource(url),
    principal: 'user:alice',
    ...(overrides.deps ?? {}),
  });
  return { transport, storage, gw, h, f };
}

async function connectAndHello(
  t: CollabTransport,
  hello: { revision: number; storedRevision?: number } = { revision: 0 },
): Promise<FakeEventSource> {
  await t.connect('file-1');
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  es.emit('hello', { revision: hello.revision, storedRevision: hello.storedRevision ?? 0, fileId: 'file-1' });
  await tick();
  return es;
}

// ---------------------------------------------------------------------------

describe('identity', () => {
  it('mints the clientId once and persists it under icecream.clientId', () => {
    const storage = new FakeStorage();
    const a = getOrCreateClientId(storage);
    const b = getOrCreateClientId(storage);
    expect(a).toBe(b);
    expect(storage.getItem('icecream.clientId')).toBe(a);
    const { transport } = makeTransport({ storage });
    expect(transport.clientId).toBe(a);
    transport.disconnect();
  });

  it('derives avatar initials from principals (incl. user:/email forms)', () => {
    expect(participantInitials('user:alice@example.com')).toBe('AL');
    expect(participantInitials('Bob Smith')).toBe('BS');
    expect(participantInitials('user:bob.smith@x.io')).toBe('BS');
    expect(participantInitials('You')).toBe('YO');
  });
});

describe('gatewayClient.openFile', () => {
  it('POSTs /api/engine/open and returns the join-handshake shape', async () => {
    const fetchStub = vi.fn(async (url: string) =>
      url.includes('/api/engine/open')
        ? jsonResponse({
            ok: true,
            fileId: 'file-9',
            sessionId: 'sess-9',
            engineUrl: 'http://engine-9',
            accessToken: 'tok-9',
            role: 'editor',
            revision: 12,
            joined: true,
            ownershipEpoch: 3,
          })
        : jsonResponse({}),
    );
    vi.stubGlobal('fetch', fetchStub);
    try {
      const client = new GatewayClient('http://gateway.test');
      const res = await client.openFile('file-9');
      expect(res).toMatchObject({
        fileId: 'file-9',
        sessionId: 'sess-9',
        engineUrl: 'http://engine-9',
        accessToken: 'tok-9',
        role: 'editor',
        revision: 12,
        joined: true,
        ownershipEpoch: 3,
      });
      const [url, init] = fetchStub.mock.calls[0] as unknown as [string, { body: string }];
      expect(url).toBe('http://gateway.test/api/engine/open');
      expect(JSON.parse(init.body)).toEqual({ fileId: 'file-9' });
      // No fileId → the mint-new-file form posts an empty body object.
      await client.openFile();
      const [, init2] = fetchStub.mock.calls[1] as unknown as [string, { body: string }];
      expect(JSON.parse(init2.body)).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('durable outbound queue', () => {
  it('persists queued ops across a simulated reload and resubmits them unmodified', async () => {
    const storage = new FakeStorage();
    const first = makeTransport({ storage });
    const es = await connectAndHello(first.transport, { revision: 3 });
    // Drop the connection: the op queues durably instead of submitting.
    es.drop();
    expect(first.transport.connectionState).toBe('reconnecting');
    const pending = first.transport.submitCommand(SET_A1);
    void pending.catch(() => undefined);
    expect(first.transport.queue).toHaveLength(1);
    const persisted = JSON.parse(storage.getItem('icecream.collab.file-1')!) as {
      queue: unknown[];
      clientSeq: number;
      lastAppliedRev: number;
    };
    expect(persisted.queue).toHaveLength(1);
    expect(persisted.clientSeq).toBe(1);
    expect(persisted.lastAppliedRev).toBe(3);
    first.transport.disconnect();

    // Reload: a fresh transport over the same storage sees the queue and
    // flushes it on hello — content AND baseRev unmodified (design doc
    // §7: the sequencer rebases against the op's authored baseRev).
    const second = makeTransport({ storage });
    expect(second.transport.clientId).toBe(first.transport.clientId);
    await connectAndHello(second.transport, { revision: 3 });
    await tick();
    const opsPosts = second.f.calls.filter((c) => c.url.includes('/ops'));
    expect(opsPosts).toHaveLength(1);
    expect(opsPosts[0].body).toMatchObject({
      clientId: second.transport.clientId,
      clientSeq: 1,
      baseRev: 3,
      cmd: SET_A1,
    });
    expect(second.transport.queue).toHaveLength(0);
    second.transport.disconnect();
  });

  it('an HTTP-refused op (429) retries with backoff and lands without a reconnect (D6)', async () => {
    let opsAttempts = 0;
    const f = makeFetch((call) => {
      if (call.url.includes('/ops')) {
        opsAttempts++;
        if (opsAttempts <= 2) {
          // Platform refusal (the production D6 shape): an HTTP error
          // response, NOT a transport failure — the delta stream stays
          // up, so no reconnect/hello ever re-drives the queue.
          return jsonResponse({ ok: false, error: 'platform: no available instance' }, 429);
        }
        return jsonResponse({ ok: true, revision: 1, ack: { revision: 1, changedCellCount: 1, checksum: 'x' } });
      }
      return jsonResponse({ ok: true });
    });
    const { transport } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    vi.useFakeTimers();
    try {
      const pending = transport.submitCommand(SET_A1);
      void pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(100); // attempt 1 → 429
      expect(opsAttempts).toBe(1);
      expect(transport.queue).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000); // backoff 1s → attempt 2 → 429
      expect(opsAttempts).toBe(2);
      expect(transport.queue).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2000); // backoff 2s → attempt 3 → ack
      expect(opsAttempts).toBe(3);
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(transport.queue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      transport.disconnect();
    }
  });

  it('moves visibly rejected ops to the retained rejected list with input intact', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/ops')
        ? jsonResponse({ ok: false, rejected: true, reason: 'viewer-role' })
        : jsonResponse({ ok: true }),
    );
    const rejectedSeen: unknown[] = [];
    const { transport, storage } = makeTransport({
      fetch: f,
      deps: { onRejected: (e) => rejectedSeen.push(e) },
    });
    await connectAndHello(transport, { revision: 0 });
    const res = await transport.submitCommand(SET_A1);
    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toBe('viewer-role');
    expect(transport.queue).toHaveLength(0);
    expect(transport.rejected).toHaveLength(1);
    expect(transport.rejected[0]).toMatchObject({ reason: 'viewer-role', cmd: SET_A1 });
    expect(rejectedSeen).toHaveLength(1);
    // Retained across reload (persisted), dismissible explicitly.
    const persisted = JSON.parse(storage.getItem('icecream.collab.file-1')!) as { rejected: unknown[] };
    expect(persisted.rejected).toHaveLength(1);
    transport.clearRejected(1);
    expect(transport.rejected).toHaveLength(0);
    transport.disconnect();
  });
});

describe('delta application', () => {
  it('applies in order; a gap holds and catches up from the journal first', async () => {
    const f = makeFetch((call) => {
      if (call.url.includes('/revisions')) {
        return jsonResponse({
          revisions: [
            {
              revision: 6,
              origin: { clientId: 'peer', clientSeq: 4, principal: 'user:bob' },
              cells: [{ sheet: 'Sheet1', row: 0, col: 0, value: { kind: 'number', value: 6 } }],
            },
          ],
        });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, h } = makeTransport({ fetch: f });
    const es = await connectAndHello(transport, { revision: 5 });
    expect(transport.lastAppliedRev).toBe(5);
    // Rev 7 arrives before 6: held, catch-up fetches 5→6, then both apply.
    es.emit('delta', {
      revision: 7,
      origin: { clientId: 'peer', clientSeq: 5, principal: 'user:bob' },
      cells: [{ sheet: 'Sheet1', row: 1, col: 0, value: { kind: 'number', value: 7 } }],
    });
    await tick();
    expect(h.applied.map((a) => a.revision)).toEqual([6, 7]);
    const revCall = f.calls.find((c) => c.url.includes('/revisions'));
    expect(revCall?.url).toContain('from=5');
    expect(revCall?.url).toContain('to=6');
    expect(transport.lastAppliedRev).toBe(7);
    // Next consecutive delta applies directly; a duplicate is ignored.
    es.emit('delta', {
      revision: 8,
      origin: { clientId: 'peer', clientSeq: 6, principal: 'user:bob' },
      cells: [],
    });
    es.emit('delta', { revision: 8, origin: { clientId: 'peer' }, cells: [] });
    await tick();
    expect(h.applied.map((a) => a.revision)).toEqual([6, 7, 8]);
    transport.disconnect();
  });

  it('acks a queued own op when its delta arrives (queue entry + waiter settle)', async () => {
    // /ops POST hangs (response lost); the delta is the ack.
    const f = makeFetch((call) => {
      if (call.url.includes('/ops')) return new Promise<Response>(() => {});
      return jsonResponse({ ok: true });
    });
    const acks: number[] = [];
    const { transport } = makeTransport({
      fetch: f,
      deps: { onAck: (entry) => acks.push(entry.clientSeq) },
    });
    const es = await connectAndHello(transport, { revision: 0 });
    const resultPromise = transport.submitCommand(SET_A1);
    expect(transport.queue).toHaveLength(1);
    es.emit('delta', {
      revision: 1,
      origin: { clientId: transport.clientId, clientSeq: 1, principal: 'user:alice' },
      cells: [{ sheet: 'Sheet1', row: 0, col: 0, value: { kind: 'number', value: 42 } }],
    });
    const res = await resultPromise;
    expect(res.ok).toBe(true);
    expect(transport.queue).toHaveLength(0);
    expect(acks).toEqual([1]);
    expect(transport.lastAppliedRev).toBe(1);
    transport.disconnect();
  });

  it('409 before-retention re-streams the confirmed layer and NEVER clears the queue', async () => {
    const storage = new FakeStorage();
    storage.setItem(
      'icecream.collab.file-1',
      JSON.stringify({
        queue: [{ clientSeq: 5, cmd: SET_A1, baseRev: 2, enqueuedAt: 1 }],
        rejected: [],
        clientSeq: 5,
        lastAppliedRev: 2,
      }),
    );
    let queueLenAtResync = -1;
    const f = makeFetch((call) => {
      if (call.url.includes('/revisions')) return jsonResponse({ error: 'before-retention', oldestRevision: 9 }, 409);
      if (call.url.includes('/ops')) {
        return jsonResponse({ ok: true, revision: 11, ack: { revision: 11, changedCellCount: 1, checksum: 'x' } });
      }
      return jsonResponse({ ok: true });
    });
    const h = makeHost();
    const { transport } = makeTransport({ storage, fetch: f, host: h });
    const origResync = h.host.resync;
    h.host.resync = async () => {
      queueLenAtResync = transport.queue.length;
      return origResync();
    };
    await transport.connect('file-1');
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    es.emit('hello', { revision: 10, storedRevision: 10, fileId: 'file-1' });
    await tick();
    expect(h.resyncCalls()).toBe(1);
    // The durable queue survived the resync (still held its op at that
    // moment); only the post-hello flush ack removed it.
    expect(queueLenAtResync).toBe(1);
    expect(transport.lastAppliedRev).toBe(10);
    await tick();
    expect(transport.queue).toHaveLength(0);
    transport.disconnect();
  });

  it('feeds status, presence, and session events to their consumers', async () => {
    const statuses: unknown[] = [];
    const participantsSeen: unknown[] = [];
    const { transport, h } = makeTransport({
      deps: {
        onStatus: (s) => statuses.push(s),
        onParticipants: (p) => participantsSeen.push(p),
      },
    });
    const es = await connectAndHello(transport, { revision: 1 });
    es.emit('status', { revision: 3, storedRevision: 2, saving: true });
    es.emit('presence', {
      participants: [
        { principal: 'user:bob', color: '#dc2626', sheet: 'Sheet1', row: 4, col: 2, editing: false },
      ],
    });
    es.emit('session', { kind: 'structure' });
    await tick();
    expect(statuses).toEqual([{ revision: 3, storedRevision: 2, saving: true }]);
    expect(transport.currentStatus).toMatchObject({ revision: 3, storedRevision: 2, saving: true });
    expect(participantsSeen).toHaveLength(1);
    expect(transport.currentParticipants[0]).toMatchObject({ principal: 'user:bob', row: 4, col: 2 });
    expect(h.sessionEvents).toEqual([{ kind: 'structure' }]);
    transport.disconnect();
  });

  it('never surfaces the client its own presence (D8: self-filter at ingestion)', async () => {
    const participantsSeen: unknown[] = [];
    const { transport } = makeTransport({
      deps: { onParticipants: (p) => participantsSeen.push(p) },
    });
    const es = await connectAndHello(transport, { revision: 1 });
    // The engine broadcasts EVERY participant, including the sender
    // (this transport's principal is user:alice). The echo must be
    // dropped here so no consumer can render a self-marker.
    es.emit('presence', {
      participants: [
        { principal: 'user:alice', color: '#2563eb', sheet: 'Sheet1', row: 0, col: 0 },
        { principal: 'user:bob', name: 'Bob B', color: '#dc2626', sheet: 'Sheet1', row: 4, col: 2 },
      ],
    });
    await tick();
    expect(participantsSeen).toHaveLength(1);
    expect(transport.currentParticipants.map((p) => p.principal)).toEqual(['user:bob']);
    transport.disconnect();
  });

  it('routes session {kind:charts} to onCharts, not to the host (FIX-G)', async () => {
    const chartsSeen: unknown[] = [];
    const { transport, h } = makeTransport({
      deps: {
        onCharts: (charts) => chartsSeen.push(charts),
      },
    });
    const es = await connectAndHello(transport, { revision: 1 });
    const spec = { id: 5, kind: 'column-clustered', title: 'Agent Chart', nativePart: true };
    es.emit('session', { kind: 'charts', revision: 2, charts: [spec] });
    await tick();
    expect(chartsSeen).toEqual([[spec]]);
    // The host has no chart concept: the event must not reach it.
    expect(h.sessionEvents).toEqual([]);
    transport.disconnect();
  });
});

describe('session extras via the collab channel (Worker F, F3)', () => {
  it('POSTs /session-extras DIRECTLY to the owning engine with the session token once connected', async () => {
    const { transport, f } = makeTransport();
    await connectAndHello(transport, { revision: 0 });
    const extras = { sheetStyles: { Sheet1: {} }, extraMetadata: { a: 1 } };
    await expect(transport.postSessionExtras(extras)).resolves.toBe(true);
    const call = f.calls.find((c) => c.url.includes('/session-extras'));
    expect(call).toBeDefined();
    expect(call!.url).toBe('http://engine-1/session-extras');
    expect(call!.method).toBe('POST');
    expect(call!.body).toEqual(extras);
    transport.disconnect();
  });

  it('returns false (no request) when not connected — caller keeps the legacy fallback', async () => {
    const { transport, f } = makeTransport();
    await expect(transport.postSessionExtras({ sheetStyles: {} })).resolves.toBe(false);
    expect(f.calls.filter((c) => c.url.includes('/session-extras'))).toHaveLength(0);
    transport.disconnect();
  });
});

describe('download metadata via the collab channel (F3 family)', () => {
  it('POSTs /download DIRECTLY to the owning engine and returns the metadata', async () => {
    const { transport, f } = makeTransport();
    await connectAndHello(transport, { revision: 0 });
    const meta = await transport.downloadMetadata({ format: 'xlsx', filename: 'workbook.xlsx' });
    expect(meta).not.toBeNull();
    const call = f.calls.find((c) => c.url.includes('/download'));
    expect(call).toBeDefined();
    expect(call!.url).toBe('http://engine-1/download');
    expect(call!.method).toBe('POST');
    expect(call!.body).toEqual({ format: 'xlsx', filename: 'workbook.xlsx' });
    transport.disconnect();
  });

  it('returns null (no request) when no file session is open — proxied fallback stays', async () => {
    const { transport, f } = makeTransport();
    await expect(transport.downloadMetadata({ format: 'xlsx' })).resolves.toBeNull();
    expect(f.calls.filter((c) => c.url.includes('/download'))).toHaveLength(0);
    transport.disconnect();
  });
});

describe('download bytes via the collab channel (residual (p))', () => {
  function bytesResponse(bytes: Uint8Array, contentType: string, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null),
      },
      blob: async () => new Blob([bytes.buffer as ArrayBuffer], { type: contentType }),
      json: async () => {
        throw new Error('not json');
      },
      text: async () => new TextDecoder().decode(bytes),
    } as unknown as Response;
  }

  it('POSTs /download DIRECTLY to the owning engine and returns the byte body as a Blob', async () => {
    const csv = new TextEncoder().encode('a,b\n10,20\n');
    const f = makeFetch((call) =>
      call.url.includes('/download')
        ? bytesResponse(csv, 'text/csv')
        : jsonResponse({ ok: true }),
    );
    const { transport } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const blob = await transport.downloadBytes({ format: 'csv', filename: 'workbook.csv' });
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe('a,b\n10,20\n');
    const call = f.calls.find((c) => c.url.includes('/download'));
    expect(call).toBeDefined();
    expect(call!.url).toBe('http://engine-1/download');
    expect(call!.method).toBe('POST');
    expect(call!.body).toEqual({ format: 'csv', filename: 'workbook.csv' });
    transport.disconnect();
  });

  it('carries a named-range scope through untouched (xlsx subset is a byte response too)', async () => {
    const subset = new TextEncoder().encode('PK fake xlsx subset');
    const f = makeFetch((call) =>
      call.url.includes('/download')
        ? bytesResponse(subset, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        : jsonResponse({ ok: true }),
    );
    const { transport } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const namedRange = {
      name: 'MyRange',
      ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    };
    const blob = await transport.downloadBytes({ format: 'xlsx', scope: 'namedRange', namedRange });
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe('PK fake xlsx subset');
    const call = f.calls.find((c) => c.url.includes('/download'));
    expect(call!.body).toEqual({ format: 'xlsx', scope: 'namedRange', namedRange });
    transport.disconnect();
  });

  it('returns null (no request) when no file session is open — proxied fallback stays', async () => {
    const { transport, f } = makeTransport();
    await expect(transport.downloadBytes({ format: 'csv' })).resolves.toBeNull();
    expect(f.calls.filter((c) => c.url.includes('/download'))).toHaveLength(0);
    transport.disconnect();
  });

  it('returns null on an engine error instead of surfacing error bytes as a file', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/download')
        ? bytesResponse(new TextEncoder().encode('boom'), 'text/plain', 500)
        : jsonResponse({ ok: true }),
    );
    const { transport } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.downloadBytes({ format: 'ods' })).resolves.toBeNull();
    transport.disconnect();
  });

  it('returns null when the engine answers JSON (metadata class — never file bytes)', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/download')
        ? bytesResponse(
            new TextEncoder().encode(JSON.stringify({ ok: true, entryId: 'dl_1' })),
            'application/json',
          )
        : jsonResponse({ ok: true }),
    );
    const { transport } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.downloadBytes({ format: 'xlsx' })).resolves.toBeNull();
    transport.disconnect();
  });
});

describe('download token refresh (D2: stale handshake token in a live session)', () => {
  function bytesResponse(bytes: Uint8Array, contentType: string, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null),
      },
      blob: async () => new Blob([bytes.buffer as ArrayBuffer], { type: contentType }),
      json: async () => {
        throw new Error('not json');
      },
      text: async () => new TextDecoder().decode(bytes),
    } as unknown as Response;
  }

  it('downloadMetadata refreshes the session once on a 401 and retries on the fresh session', async () => {
    const f = makeFetch((call) => {
      if (call.url.includes('/download')) {
        return call.url.startsWith('http://engine-1')
          ? jsonResponse({ ok: false, error: 'engine access denied: expired' }, 401)
          : jsonResponse({ ok: true, entryId: 'dl_9', revision: 3 });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const meta = await transport.downloadMetadata({ format: 'xlsx', filename: 'workbook.xlsx' });
    expect(meta).toEqual({ ok: true, entryId: 'dl_9', revision: 3 });
    // Initial connect + exactly one refresh (fresh gateway lookup, §9).
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const dlCalls = f.calls.filter((c) => c.url.includes('/download'));
    expect(dlCalls.map((c) => c.url)).toEqual([
      'http://engine-1/download',
      'http://engine-2/download',
    ]);
    transport.disconnect();
  });

  it('downloadBytes refreshes the session once on a 401 and retries on the fresh session', async () => {
    const csv = new TextEncoder().encode('a,b\n10,20\n');
    const f = makeFetch((call) => {
      if (call.url.includes('/download')) {
        return call.url.startsWith('http://engine-1')
          ? bytesResponse(new TextEncoder().encode('denied'), 'text/plain', 401)
          : bytesResponse(csv, 'text/csv');
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const blob = await transport.downloadBytes({ format: 'csv', filename: 'workbook.csv' });
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe('a,b\n10,20\n');
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    transport.disconnect();
  });

  it('a second 401 after the refresh returns null — no refresh loop, proxied fallback preserved', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/download')
        ? jsonResponse({ ok: false, error: 'denied' }, 401)
        : jsonResponse({ ok: true }),
    );
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.downloadMetadata({ format: 'xlsx' })).resolves.toBeNull();
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    expect(f.calls.filter((c) => c.url.includes('/download'))).toHaveLength(2);
    transport.disconnect();
  });
});

describe('secondary-path token refresh (Item L: same stale-token family as D2)', () => {
  const stale401 = { ok: false, error: 'engine access denied: expired' };

  it('postEntry refreshes the session once on a 401 and resubmits the op UNMODIFIED', async () => {
    const f = makeFetch((call) => {
      if (call.url.includes('/ops')) {
        return call.url.startsWith('http://engine-1')
          ? jsonResponse(stale401, 401)
          : jsonResponse({ ok: true, revision: 1, ack: { revision: 1, changedCellCount: 1, checksum: 'x' } });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const res = await transport.submitCommand(SET_A1);
    expect(res.ok).toBe(true);
    // Initial connect + exactly one refresh (fresh gateway lookup, §9).
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const opsCalls = f.calls.filter((c) => c.url.includes('/ops'));
    expect(opsCalls.map((c) => c.url)).toEqual(['http://engine-1/ops', 'http://engine-2/ops']);
    // The retry carries the op UNMODIFIED — same clientSeq, same
    // authored baseRev (design doc §7: only the token is refreshed).
    expect(opsCalls[1]!.body).toEqual(opsCalls[0]!.body);
    expect(opsCalls[1]!.body).toMatchObject({ clientSeq: 1, baseRev: 0, cmd: SET_A1 });
    expect(transport.queue).toHaveLength(0);
    transport.disconnect();
  });

  it('postEntry double-401 keeps the entry queued — legacy fall-through, no refresh loop', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/ops') ? jsonResponse(stale401, 401) : jsonResponse({ ok: true }),
    );
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const pending = transport.submitCommand(SET_A1);
    void pending.catch(() => undefined);
    await tick();
    // Not acked, not rejected: still queued for the next flush, and
    // exactly one refresh was attempted (2 /ops calls, never a loop).
    expect(transport.queue).toHaveLength(1);
    expect(transport.rejected).toHaveLength(0);
    expect(f.calls.filter((c) => c.url.includes('/ops'))).toHaveLength(2);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    transport.disconnect();
  });

  it('catchUp refreshes the session once on a 401 and applies the journal in order', async () => {
    const f = makeFetch((call) => {
      if (call.url.includes('/revisions')) {
        return call.url.startsWith('http://engine-1')
          ? jsonResponse(stale401, 401)
          : jsonResponse({
              revisions: [
                {
                  revision: 1,
                  origin: { clientId: 'peer', clientSeq: 1, principal: 'user:bob' },
                  cells: [{ sheet: 'Sheet1', row: 0, col: 0, value: { kind: 'number', value: 1 } }],
                },
                {
                  revision: 2,
                  origin: { clientId: 'peer', clientSeq: 2, principal: 'user:bob' },
                  cells: [{ sheet: 'Sheet1', row: 1, col: 0, value: { kind: 'number', value: 2 } }],
                },
              ],
            });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw, h } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    await transport.catchUp(0, 2);
    expect(h.applied.map((a) => a.revision)).toEqual([1, 2]);
    expect(transport.lastAppliedRev).toBe(2);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const revCalls = f.calls.filter((c) => c.url.includes('/revisions'));
    expect(revCalls.map((c) => c.url)).toEqual([
      'http://engine-1/revisions?from=0&to=2',
      'http://engine-2/revisions?from=0&to=2',
    ]);
    transport.disconnect();
  });

  it('catchUp double-401 throws the same catch-up failure a raw 401 produced', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/revisions') ? jsonResponse(stale401, 401) : jsonResponse({ ok: true }),
    );
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.catchUp(0, 2)).rejects.toThrow('revisions catch-up failed: 401');
    expect(f.calls.filter((c) => c.url.includes('/revisions'))).toHaveLength(2);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    transport.disconnect();
  });

  it('postSessionExtras refreshes the session once on a 401 and retries', async () => {
    const f = makeFetch((call) => {
      if (call.url.includes('/session-extras')) {
        return call.url.startsWith('http://engine-1')
          ? jsonResponse(stale401, 401)
          : jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.postSessionExtras({ a: 1 })).resolves.toBe(true);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const calls = f.calls.filter((c) => c.url.includes('/session-extras'));
    expect(calls.map((c) => c.url)).toEqual([
      'http://engine-1/session-extras',
      'http://engine-2/session-extras',
    ]);
    expect(calls[1]!.body).toEqual({ a: 1 });
    transport.disconnect();
  });

  it('postSessionExtras double-401 returns false — legacy behavior preserved', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/session-extras') ? jsonResponse(stale401, 401) : jsonResponse({ ok: true }),
    );
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.postSessionExtras({ a: 1 })).resolves.toBe(false);
    expect(f.calls.filter((c) => c.url.includes('/session-extras'))).toHaveLength(2);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    transport.disconnect();
  });

  it('postPresence refreshes the session once on a 401 and retries (hello re-send)', async () => {
    const f = makeFetch((call) => {
      if (call.url.endsWith('/presence')) {
        return call.url.startsWith('http://engine-1')
          ? jsonResponse(stale401, 401)
          : jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ fetch: f });
    // Recorded while disconnected; handleHello re-sends it on connect.
    transport.sendPresence({ sheet: 'Sheet1', row: 1, col: 2 });
    await connectAndHello(transport, { revision: 0 });
    await tick(12);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const calls = f.calls.filter((c) => c.url.endsWith('/presence'));
    expect(calls.map((c) => c.url)).toEqual(['http://engine-1/presence', 'http://engine-2/presence']);
    expect(calls[1]!.body).toEqual({ sheet: 'Sheet1', row: 1, col: 2 });
    transport.disconnect();
  });

  it('postPresence double-401 is swallowed — best-effort, no loop, session stays connected', async () => {
    let deny = true;
    const f = makeFetch((call) =>
      call.url.endsWith('/presence') && deny ? jsonResponse(stale401, 401) : jsonResponse({ ok: true }),
    );
    const { transport, gw } = makeTransport({ fetch: f });
    transport.sendPresence({ sheet: 'Sheet1', row: 0, col: 0 });
    await connectAndHello(transport, { revision: 0 });
    await tick(12);
    // Exactly one refresh + retry, both refused, failure swallowed.
    expect(f.calls.filter((c) => c.url.endsWith('/presence'))).toHaveLength(2);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    // The refresh re-ran connect(): state recovers to 'connected' when
    // the fresh EventSource's hello lands (same cycle as a reconnect).
    deny = false;
    const es2 = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    es2.emit('hello', { revision: 0, storedRevision: 0, fileId: 'file-1' });
    await tick(12);
    expect(transport.connectionState).toBe('connected');
    transport.disconnect();
  });

  it('postDeltaAck refreshes the session once on a 401 and retries', async () => {
    const f = makeFetch((call) => {
      if (call.url.endsWith('/deltas/ack')) {
        return call.url.startsWith('http://engine-1')
          ? jsonResponse(stale401, 401)
          : jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw, h } = makeTransport({ fetch: f });
    const es = await connectAndHello(transport, { revision: 0 });
    es.emit('delta', { revision: 1, origin: { clientId: 'peer' }, cells: [] });
    await tick(12);
    expect(h.applied.map((a) => a.revision)).toEqual([1]);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const calls = f.calls.filter((c) => c.url.endsWith('/deltas/ack'));
    expect(calls.map((c) => c.url)).toEqual([
      'http://engine-1/deltas/ack',
      'http://engine-2/deltas/ack',
    ]);
    expect(calls[1]!.body).toEqual({ revision: 1 });
    transport.disconnect();
  });

  it('postDeltaAck double-401 is swallowed — delta still applied, no loop', async () => {
    const f = makeFetch((call) =>
      call.url.endsWith('/deltas/ack') ? jsonResponse(stale401, 401) : jsonResponse({ ok: true }),
    );
    const { transport, gw, h } = makeTransport({ fetch: f });
    const es = await connectAndHello(transport, { revision: 0 });
    es.emit('delta', { revision: 1, origin: { clientId: 'peer' }, cells: [] });
    await tick(12);
    expect(h.applied.map((a) => a.revision)).toEqual([1]);
    expect(f.calls.filter((c) => c.url.endsWith('/deltas/ack'))).toHaveLength(2);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    // The refresh re-ran connect(): state recovers to 'connected' when
    // the fresh EventSource's hello lands (same cycle as a reconnect).
    const es2 = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    es2.emit('hello', { revision: 1, storedRevision: 1, fileId: 'file-1' });
    await tick(12);
    expect(transport.connectionState).toBe('connected');
    transport.disconnect();
  });

  it('releaseOpenedSession refreshes the session once on a 401 and still releases + forgets', async () => {
    const f = makeFetch((call) => {
      if (call.url.includes('/session/release')) {
        return call.url.startsWith('http://engine-1')
          ? jsonResponse(stale401, 401)
          : jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const ok = await transport.releaseOpenedSession('load-failed');
    expect(ok).toBe(true);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const calls = f.calls.filter((c) => c.url.includes('/session/release'));
    expect(calls.map((c) => c.url)).toEqual([
      'http://engine-1/session/release',
      'http://engine-2/session/release',
    ]);
    expect(calls[1]!.body).toMatchObject({ sessionId: 'sess-1', reason: 'load-failed' });
    // Forgotten locally even though the refresh swapped the opened
    // object mid-call (the forget check compares by fileId now).
    expect(transport.sessionId).toBeNull();
    expect(transport.connectionState).toBe('disconnected');
    transport.disconnect();
  });

  it('releaseOpenedSession double-401 returns false and still forgets the session locally', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/session/release') ? jsonResponse(stale401, 401) : jsonResponse({ ok: true }),
    );
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const ok = await transport.releaseOpenedSession('load-failed');
    expect(ok).toBe(false);
    expect(f.calls.filter((c) => c.url.includes('/session/release'))).toHaveLength(2);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    expect(transport.sessionId).toBeNull();
    expect(transport.connectionState).toBe('disconnected');
    transport.disconnect();
  });
});

describe('reconnect', () => {
  it('re-runs the gateway lookup (fresh endpoint + token) and resubmits the queue in order', async () => {
    const gw = makeGateway();
    const { transport, f } = makeTransport({ gateway: gw });
    const es1 = await connectAndHello(transport, { revision: 2 });
    expect(es1.url).toContain('http://engine-1/deltas');
    expect(es1.url).toContain('access_token=tok-1');
    // Drop; queue two ops while down.
    es1.drop();
    expect(transport.connectionState).toBe('reconnecting');
    const cmdA: EngineCommand = { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'A' };
    const cmdB: EngineCommand = { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'B' };
    void transport.submitCommand(cmdA).catch(() => undefined);
    void transport.submitCommand(cmdB).catch(() => undefined);
    expect(transport.queue.map((e) => e.clientSeq)).toEqual([1, 2]);
    // Reconnect: a FRESH openFile (engine-2 + tok-2), never the stale pair.
    transport.reconnectNow();
    await tick();
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const es2 = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    expect(es2.url).toContain('http://engine-2/deltas');
    expect(es2.url).toContain('access_token=tok-2');
    es2.emit('hello', { revision: 2, storedRevision: 2, fileId: 'file-1' });
    await tick();
    const opsPosts = f.calls.filter((c) => c.url.includes('/ops'));
    expect(opsPosts.map((c) => c.url)).toEqual(['http://engine-2/ops', 'http://engine-2/ops']);
    expect(opsPosts.map((c) => (c.body?.cmd as EngineCommand))).toEqual([cmdA, cmdB]);
    expect(opsPosts.every((c) => c.body?.baseRev === 2)).toBe(true);
    expect(transport.queue).toHaveLength(0);
    expect(transport.connectionState).toBe('connected');
    transport.disconnect();
  });

  it('keeps the AUTHORED baseRev when flushing after catch-up (design doc §7 rebase)', async () => {
    // Regression (leg-a S6, 2026-10-21): an op authored offline at
    // baseRev 2 must still carry baseRev 2 when it is flushed after the
    // reconnect catch-up advanced lastAppliedRev to 5 — the sequencer
    // rebases against the intervening revisions (e.g. a structural
    // insert) only when it can see the op is stale. Refreshing baseRev
    // at submission made the op land at its pre-insert coordinates.
    const gw = makeGateway();
    const f = makeFetch((call) => {
      if (call.url.includes('/revisions')) {
        return jsonResponse({
          revisions: [3, 4, 5].map((revision) => ({
            revision,
            origin: { clientId: 'peer', clientSeq: revision, principal: 'user:alice' },
            cells: [{ sheet: 'Sheet1', row: 0, col: 0, value: { kind: 'number', value: revision } }],
          })),
        });
      }
      return jsonResponse({ ok: true });
    });
    const { transport } = makeTransport({ gateway: gw, fetch: f });
    const es1 = await connectAndHello(transport, { revision: 2 });
    es1.drop();
    expect(transport.connectionState).toBe('reconnecting');
    const cmd: EngineCommand = { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 4, col: 0 }, value: 'BOBVAL' };
    void transport.submitCommand(cmd).catch(() => undefined);
    expect(transport.queue.map((e) => e.baseRev)).toEqual([2]);
    transport.reconnectNow();
    await tick();
    const es2 = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    // The session advanced to revision 5 while we were away (catch-up).
    es2.emit('hello', { revision: 5, storedRevision: 5, fileId: 'file-1' });
    await tick();
    expect(transport.lastAppliedRev).toBe(5);
    const opsPosts = f.calls.filter((c) => c.url.includes('/ops'));
    expect(opsPosts).toHaveLength(1);
    expect(opsPosts[0].body).toMatchObject({ clientSeq: 1, baseRev: 2, cmd });
    expect(transport.queue).toHaveLength(0);
    transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Phase 2 fix: post-handshake DIRECT load + claim hygiene.
// The §10 Scenario-1 defect: after a successful /api/engine/open
// handshake, the client loaded through the gateway-PROXIED Phase-1
// endpoints, whose forwarded gateway JWT the signed-mode engine
// refuses (401) — the workbook never loaded and the blank claimed
// session squatted the engine. The load must ride the direct engine
// connection with the handshake token + claimed sessionId (§9 step 4),
// and a creator whose load fails must release the claim.
// ---------------------------------------------------------------------------

describe('direct load + claim hygiene (Phase 2 fix)', () => {
  const LOAD_RESULT = {
    ok: true,
    sheets: ['Sales'],
    file: { sheets: [{ name: 'Sales', formats: { codes: [], columns: {} } }], metadata: {} },
    columnCounts: { Sales: [1] },
  };

  const NDJSON =
    [
      JSON.stringify({
        type: 'meta',
        sheets: ['Sales'],
        totalSheets: 1,
        totalCells: 1,
        metadata: {},
        progress: { sheetsDone: 0, cellsDone: 0, totalSheets: 1, totalCells: 1 },
      }),
      JSON.stringify({
        type: 'rows',
        sheet: 'Sales',
        index: 0,
        startRow: 0,
        rows: [[5]],
        display: [[5]],
        formats: { codes: [], columns: {} },
        pendingCalc: [],
        progress: { sheetsDone: 0, cellsDone: 1, totalSheets: 1, totalCells: 1 },
      }),
      JSON.stringify({ type: 'built', response: LOAD_RESULT }),
    ].join('\n') + '\n';

  interface RecCall {
    url: string;
    method: string;
    authorization?: string;
    body: Record<string, unknown> | null;
  }

  function streamResponse(text: string, status = 200): Response {
    const bytes = new TextEncoder().encode(text);
    const mid = Math.max(1, Math.floor(bytes.length / 2));
    const chunks = [bytes.subarray(0, mid), bytes.subarray(mid)];
    let i = 0;
    return {
      ok: status >= 200 && status < 300,
      status,
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        }),
      },
      json: async () => {
        throw new Error('not a json response');
      },
      text: async () => text,
      headers: { get: () => null },
    } as unknown as Response;
  }

  function recordingFetch(handler: (call: RecCall) => Response | Promise<Response>) {
    const calls: RecCall[] = [];
    const fetchFn = vi.fn(
      async (
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        const call: RecCall = {
          url,
          method: init?.method ?? 'GET',
          authorization: init?.headers?.authorization,
          body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        };
        calls.push(call);
        return handler(call);
      },
    );
    return { fetchFn: fetchFn as unknown as typeof fetch, calls };
  }

  it('loads DIRECTLY on the owner engine with the handshake token + claimed sessionId', async () => {
    const rec = recordingFetch((call) => {
      if (call.url.endsWith('/load/stream')) return streamResponse(NDJSON);
      return jsonResponse({ ok: true });
    });
    const { transport } = makeTransport({ deps: { fetchFn: rec.fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    const chunkTypes: string[] = [];
    const result = await transport.loadXlsxProgressiveDirect('QQ==', (_acc, _done, chunk) => {
      chunkTypes.push(chunk.rawType);
    });
    expect(result.sheets).toEqual(['Sales']);
    expect(chunkTypes).toEqual(['meta', 'rows', 'built']);
    // Exactly one request: the direct stream on the OWNER engine (not
    // the gateway, not /api/engine/load[/stream]).
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toBe('http://engine-1/load/stream');
    expect(rec.calls[0]!.authorization).toBe('Bearer tok-1');
    // The engine's /load rule (body.sessionId === token.sid) holds by
    // construction: the body carries the claimed sessionId.
    expect(rec.calls[0]!.body).toMatchObject({ format: 'xlsx', data: 'QQ==', sessionId: 'sess-1' });
    transport.disconnect();
  });

  it('falls back to the direct /load when the stream cannot open', async () => {
    const rec = recordingFetch((call) => {
      if (call.url.endsWith('/load/stream')) {
        return {
          ok: false,
          status: 404,
          body: null,
          json: async () => ({}),
          text: async () => 'no stream',
          headers: { get: () => null },
        } as unknown as Response;
      }
      if (call.url.endsWith('/load')) return jsonResponse(LOAD_RESULT);
      return jsonResponse({ ok: true });
    });
    const { transport } = makeTransport({ deps: { fetchFn: rec.fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    const chunkTypes: string[] = [];
    const result = await transport.loadXlsxProgressiveDirect('QQ==', (_acc, _done, chunk) => {
      chunkTypes.push(chunk.rawType);
    });
    expect(result.sheets).toEqual(['Sales']);
    expect(chunkTypes).toEqual(['fallback']);
    const loadCall = rec.calls.find((c) => c.url === 'http://engine-1/load');
    expect(loadCall).toBeTruthy();
    expect(loadCall!.body).toMatchObject({ sessionId: 'sess-1' });
    transport.disconnect();
  });

  it('an error chunk REJECTS — never resolves as the partial accumulation (issue #18)', async () => {
    const errStream = [
      JSON.stringify({
        type: 'meta',
        sheets: ['Sales'],
        totalSheets: 1,
        totalCells: 1,
        metadata: {},
        progress: { sheetsDone: 0, cellsDone: 0, totalSheets: 1, totalCells: 1 },
      }),
      JSON.stringify({
        type: 'error',
        error: 'failed to parse xlsx: not a readable spreadsheet package',
      }),
    ].join('\n') + '\n';
    const rec = recordingFetch((call) => {
      if (call.url.endsWith('/load/stream')) return streamResponse(errStream);
      return jsonResponse({ ok: true });
    });
    const { transport } = makeTransport({ deps: { fetchFn: rec.fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.loadXlsxProgressiveDirect('QQ==', () => {})).rejects.toThrowError(
      /failed to parse xlsx/,
    );
    transport.disconnect();
  });

  it('refreshes the handshake token once on a 401 and retries the stream', async () => {
    let streamAttempts = 0;
    const rec = recordingFetch((call) => {
      if (call.url.endsWith('/load/stream')) {
        streamAttempts++;
        if (streamAttempts === 1) {
          return {
            ok: false,
            status: 401,
            body: null,
            json: async () => ({}),
            text: async () => 'expired',
            headers: { get: () => null },
          } as unknown as Response;
        }
        return streamResponse(NDJSON);
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ deps: { fetchFn: rec.fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    const result = await transport.loadXlsxProgressiveDirect('QQ==', () => {});
    expect(result.sheets).toEqual(['Sales']);
    // The retry re-ran the gateway lookup (engine-2 + tok-2) — the
    // stale pair was never reused.
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const streams = rec.calls.filter((c) => c.url.endsWith('/load/stream'));
    expect(streams.map((c) => c.url)).toEqual([
      'http://engine-1/load/stream',
      'http://engine-2/load/stream',
    ]);
    expect(streams[1]!.authorization).toBe('Bearer tok-2');
    transport.disconnect();
  });

  it('loadXlsxDirect posts the claimed sessionId to the owner engine /load', async () => {
    const rec = recordingFetch((call) => {
      if (call.url.endsWith('/load')) return jsonResponse(LOAD_RESULT);
      return jsonResponse({ ok: true });
    });
    const { transport } = makeTransport({ deps: { fetchFn: rec.fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    const result = await transport.loadXlsxDirect('QQ==');
    expect(result.sheets).toEqual(['Sales']);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toBe('http://engine-1/load');
    expect(rec.calls[0]!.body).toMatchObject({ format: 'xlsx', sessionId: 'sess-1' });
    transport.disconnect();
  });

  it('loadStorageRefDirect posts the storage ref + claimed sessionId to the owner engine', async () => {
    const rec = recordingFetch((call) => {
      if (call.url.endsWith('/load/storage-ref')) return jsonResponse(LOAD_RESULT);
      return jsonResponse({ ok: true });
    });
    const { transport } = makeTransport({ deps: { fetchFn: rec.fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    const result = await transport.loadStorageRefDirect({
      bucket: 'icecream-uploads',
      object: 'uploads/abc/file-1.xlsx',
    });
    expect(result.sheets).toEqual(['Sales']);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toBe('http://engine-1/load/storage-ref');
    expect(rec.calls[0]!.body).toMatchObject({
      bucket: 'icecream-uploads',
      object: 'uploads/abc/file-1.xlsx',
      format: 'xlsx',
      sessionId: 'sess-1',
    });
    expect(rec.calls[0]!.authorization).toBe('Bearer tok-1');
    transport.disconnect();
  });

  it('loadStorageRefDirect carries the csv format + source name for CSV records', async () => {
    const rec = recordingFetch((call) => {
      if (call.url.endsWith('/load/storage-ref')) return jsonResponse(LOAD_RESULT);
      return jsonResponse({ ok: true });
    });
    const { transport } = makeTransport({ deps: { fetchFn: rec.fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    await transport.loadStorageRefDirect({
      object: 'uploads/abc/file-2.csv',
      format: 'csv',
      sourceName: 'sales.csv',
    });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.body).toMatchObject({
      object: 'uploads/abc/file-2.csv',
      format: 'csv',
      name: 'sales.csv',
      sessionId: 'sess-1',
    });
    expect(rec.calls[0]!.body).not.toHaveProperty('bucket');
    transport.disconnect();
  });

  it('resetDirect posts to the owner engine /reset with the handshake token', async () => {
    const rec = recordingFetch((call) => {
      if (call.url.endsWith('/reset')) return jsonResponse({ ok: true, sessionId: 'sess-1' });
      return jsonResponse({ ok: true });
    });
    const { transport } = makeTransport({ deps: { fetchFn: rec.fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    await transport.resetDirect();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toBe('http://engine-1/reset');
    expect(rec.calls[0]!.method).toBe('POST');
    expect(rec.calls[0]!.authorization).toBe('Bearer tok-1');
    transport.disconnect();
  });

  it('resetDirect refreshes the handshake token once on a 401 and retries', async () => {
    let resetAttempts = 0;
    const rec = recordingFetch((call) => {
      if (call.url.endsWith('/reset')) {
        resetAttempts++;
        if (resetAttempts === 1) {
          return {
            ok: false,
            status: 401,
            body: null,
            json: async () => ({}),
            text: async () => 'expired',
            headers: { get: () => null },
          } as unknown as Response;
        }
        return jsonResponse({ ok: true, sessionId: 'sess-1' });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ deps: { fetchFn: rec.fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    await transport.resetDirect();
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const resets = rec.calls.filter((c) => c.url.endsWith('/reset'));
    expect(resets).toHaveLength(2);
    expect(resets[1]!.url).toBe('http://engine-2/reset');
    expect(resets[1]!.authorization).toBe('Bearer tok-2');
    transport.disconnect();
  });

  it('releaseOpenedSession releases the claim on the engine and forgets the session', async () => {
    const { transport, f } = makeTransport();
    await connectAndHello(transport, { revision: 0 });
    const ok = await transport.releaseOpenedSession('load-failed');
    expect(ok).toBe(true);
    const release = f.calls.find((c) => c.url === 'http://engine-1/session/release');
    expect(release).toBeTruthy();
    expect(release!.body).toMatchObject({ sessionId: 'sess-1', reason: 'load-failed' });
    expect(transport.sessionId).toBeNull();
    expect(transport.connectionState).toBe('disconnected');
  });
});

describe('librarySaveDirect (shell integration)', () => {
  it('posts the save to the claimed engine with the access token and returns the entry', async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      if (!url.endsWith('/library-save')) return new Response('', { status: 200 });
      return new Response(
        JSON.stringify({
          ok: true,
          entry: { id: 'wb_1', name: 'Score viewer', sizeBytes: 3068, modifiedAt: 42 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const { transport } = makeTransport({ deps: { fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    const entry = await transport.librarySaveDirect('Score viewer');
    expect(entry).toEqual({ id: 'wb_1', name: 'Score viewer', sizeBytes: 3068, modifiedAt: 42 });
    const save = calls.find((c) => c.url === 'http://engine-1/library-save');
    expect(save).toBeTruthy();
    expect(save!.authorization).toBe('Bearer tok-1');
    expect(save!.body).toEqual({ format: 'xlsx', name: 'Score viewer' });
    transport.disconnect();
  });

  it('surfaces a non-200 engine answer instead of swallowing it', async () => {
    const fetchFn = (async (url: string) =>
      url.endsWith('/library-save')
        ? new Response('engine access denied', { status: 401 })
        : new Response('', { status: 200 })) as typeof fetch;
    const { transport } = makeTransport({ deps: { fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.librarySaveDirect('x')).rejects.toThrow(/401/);
    transport.disconnect();
  });
});

describe('librarySave (general library save — direct provider lane)', () => {
  const ENTRY = {
    id: 'wb_9',
    name: 'Budget 2026',
    owner: 'user:alice',
    createdAt: 11,
    modifiedAt: 42,
    sizeBytes: 3068,
    backend: 'gateway',
  } as const;

  it('returns null when no file session is opened (caller falls back)', async () => {
    const { transport, f } = makeTransport();
    const entry = await transport.librarySave({ name: 'Budget 2026' });
    expect(entry).toBeNull();
    expect(f.calls.filter((c) => c.url.endsWith('/library-save'))).toHaveLength(0);
    transport.disconnect();
  });

  it('posts the full payload (id + name + extras) with the access token and returns the full entry', async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        authorization:
          init?.headers && typeof init.headers === 'object'
            ? ((init.headers as Record<string, string>)['authorization'] ?? null)
            : null,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      if (!url.endsWith('/library-save')) return new Response('', { status: 200 });
      return new Response(JSON.stringify({ ok: true, entry: ENTRY, revision: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const { transport } = makeTransport({ deps: { fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    const entry = await transport.librarySave({
      id: 'wb_9',
      name: 'Budget 2026',
      extraMetadata: { 'icecream.theme': { name: 'Office' } },
      definedNames: [{ name: 'TaxRate', ref: 'Sheet1!$B$1' }],
      sheetDims: { Sheet1: { cols: [] } },
      sheetStyles: { Sheet1: {} },
    });
    expect(entry).toEqual(ENTRY);
    const save = calls.find((c) => c.url === 'http://engine-1/library-save');
    expect(save).toBeTruthy();
    expect(save!.authorization).toBe('Bearer tok-1');
    expect(save!.body).toEqual({
      format: 'xlsx',
      id: 'wb_9',
      name: 'Budget 2026',
      extraMetadata: { 'icecream.theme': { name: 'Office' } },
      definedNames: [{ name: 'TaxRate', ref: 'Sheet1!$B$1' }],
      sheetDims: { Sheet1: { cols: [] } },
      sheetStyles: { Sheet1: {} },
    });
    transport.disconnect();
  });

  it('returns null on an engine error so the caller falls back to the proxied lane', async () => {
    const fetchFn = (async (url: string) =>
      url.endsWith('/library-save')
        ? new Response('boom', { status: 500 })
        : new Response('', { status: 200 })) as typeof fetch;
    const { transport } = makeTransport({ deps: { fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.librarySave({ name: 'x' })).resolves.toBeNull();
    transport.disconnect();
  });

  it('refreshes the handshake token once on a stale-token 401 and retries', async () => {
    let attempts = 0;
    const f = makeFetch((call) => {
      if (call.url.endsWith('/library-save')) {
        attempts++;
        if (attempts === 1) return jsonResponse({ error: 'expired' }, 401);
        return jsonResponse({ ok: true, entry: ENTRY, revision: 8 });
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const entry = await transport.librarySave({ id: 'wb_9', name: 'Budget 2026' });
    expect(entry).toEqual(ENTRY);
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const saves = f.calls.filter((c) => c.url.endsWith('/library-save'));
    expect(saves).toHaveLength(2);
    expect(saves[0]!.url).toBe('http://engine-1/library-save');
    expect(saves[1]!.url).toBe('http://engine-2/library-save');
    transport.disconnect();
  });
});

describe('libraryBytes + bindLibrary (library-entry open — direct provider lane)', () => {
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function bytesResponse(bytes: Uint8Array, contentType: string, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null),
      },
      blob: async () => new Blob([bytes.buffer as ArrayBuffer], { type: contentType }),
      json: async () => {
        throw new Error('not json');
      },
      text: async () => new TextDecoder().decode(bytes),
    } as unknown as Response;
  }

  it('libraryBytes returns null when no file session is opened (caller falls back)', async () => {
    const { transport, f } = makeTransport();
    await expect(transport.libraryBytes('wb_9')).resolves.toBeNull();
    expect(f.calls.filter((c) => c.url.includes('/library/'))).toHaveLength(0);
    transport.disconnect();
  });

  it('libraryBytes GETs /library/:id DIRECTLY on the owning engine with the access token', async () => {
    const bytes = new TextEncoder().encode('PK fake xlsx bytes');
    const f = makeFetch((call) =>
      call.url.includes('/library/')
        ? bytesResponse(bytes, XLSX_TYPE)
        : jsonResponse({ ok: true }),
    );
    const { transport } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const blob = await transport.libraryBytes('wb_9');
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe('PK fake xlsx bytes');
    const call = f.calls.find((c) => c.url.includes('/library/'));
    expect(call).toBeDefined();
    expect(call!.url).toBe('http://engine-1/library/wb_9');
    expect(call!.method).toBe('GET');
    transport.disconnect();
  });

  it('libraryBytes returns null on an engine error (404 unknown entry)', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/library/')
        ? bytesResponse(new TextEncoder().encode('no library entry'), 'text/plain', 404)
        : jsonResponse({ ok: true }),
    );
    const { transport } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.libraryBytes('wb_missing')).resolves.toBeNull();
    transport.disconnect();
  });

  it('libraryBytes returns null when the engine answers JSON (error class — never file bytes)', async () => {
    const f = makeFetch((call) =>
      call.url.includes('/library/')
        ? bytesResponse(
            new TextEncoder().encode(JSON.stringify({ ok: false, error: 'denied' })),
            'application/json',
          )
        : jsonResponse({ ok: true }),
    );
    const { transport } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.libraryBytes('wb_9')).resolves.toBeNull();
    transport.disconnect();
  });

  it('libraryBytes refreshes the handshake token once on a stale-token 401 and retries', async () => {
    const bytes = new TextEncoder().encode('PK fake xlsx bytes');
    const f = makeFetch((call) => {
      if (call.url.includes('/library/')) {
        return call.url.startsWith('http://engine-1')
          ? bytesResponse(new TextEncoder().encode('denied'), 'text/plain', 401)
          : bytesResponse(bytes, XLSX_TYPE);
      }
      return jsonResponse({ ok: true });
    });
    const { transport, gw } = makeTransport({ fetch: f });
    await connectAndHello(transport, { revision: 0 });
    const blob = await transport.libraryBytes('wb_9');
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe('PK fake xlsx bytes');
    expect(gw.gateway.openFile).toHaveBeenCalledTimes(2);
    const gets = f.calls.filter((c) => c.url.includes('/library/'));
    expect(gets.map((c) => c.url)).toEqual([
      'http://engine-1/library/wb_9',
      'http://engine-2/library/wb_9',
    ]);
    transport.disconnect();
  });

  it('bindLibrary returns null when no file session is opened (caller falls back)', async () => {
    const { transport, f } = makeTransport();
    await expect(transport.bindLibrary('wb_9', 'Budget 2026')).resolves.toBeNull();
    expect(f.calls.filter((c) => c.url.includes('/session-bind-library'))).toHaveLength(0);
    transport.disconnect();
  });

  it('bindLibrary POSTs {id, name} DIRECTLY to the owning engine and returns the binding', async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        authorization:
          init?.headers && typeof init.headers === 'object'
            ? ((init.headers as Record<string, string>)['authorization'] ?? null)
            : null,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      if (!url.endsWith('/session-bind-library')) return new Response('', { status: 200 });
      return new Response(JSON.stringify({ ok: true, boundLibraryId: 'wb_9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const { transport } = makeTransport({ deps: { fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    const res = await transport.bindLibrary('wb_9', 'Budget 2026');
    expect(res).toEqual({ ok: true, boundLibraryId: 'wb_9' });
    const bind = calls.find((c) => c.url === 'http://engine-1/session-bind-library');
    expect(bind).toBeTruthy();
    expect(bind!.authorization).toBe('Bearer tok-1');
    expect(bind!.body).toEqual({ id: 'wb_9', name: 'Budget 2026' });
    transport.disconnect();
  });

  it('bindLibrary returns null on an engine error so the caller falls back to the proxied lane', async () => {
    const fetchFn = (async (url: string) =>
      url.endsWith('/session-bind-library')
        ? new Response('no active session to bind', { status: 409 })
        : new Response('', { status: 200 })) as typeof fetch;
    const { transport } = makeTransport({ deps: { fetchFn } });
    await connectAndHello(transport, { revision: 0 });
    await expect(transport.bindLibrary('wb_9')).resolves.toBeNull();
    transport.disconnect();
  });
});

describe('page-unload session release (shell integration)', () => {
  function beaconCapture() {
    const beacons: Array<{ url: string; body: string }> = [];
    const sendBeaconFn = (url: string, data: Blob): boolean => {
      void data.text().then((body) => beacons.push({ url, body }));
      return true;
    };
    return { beacons, sendBeaconFn };
  }

  it('the claim creator beacons a release on unload (token in query, session in body)', async () => {
    const { beacons, sendBeaconFn } = beaconCapture();
    const { transport } = makeTransport({ deps: { sendBeaconFn } });
    await connectAndHello(transport, { revision: 0 });
    transport.releaseOnUnload();
    await tick();
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.url).toBe('http://engine-1/session/release?access_token=tok-1');
    expect(JSON.parse(beacons[0]!.body)).toEqual({ sessionId: 'sess-1', reason: 'page-unload' });
    transport.disconnect();
  });

  it('a joiner never releases on unload', async () => {
    const { beacons, sendBeaconFn } = beaconCapture();
    // A gateway whose FIRST handshake already joins a live session.
    let n = 0;
    const joinerGateway = {
      gateway: {
        openFile: vi.fn(async (_opts?: unknown) => {
          n++;
          return {
            ok: true,
            fileId: 'file-1',
            sessionId: 'sess-1',
            engineUrl: `http://engine-${n}`,
            accessToken: `tok-${n}`,
            role: 'editor',
            revision: 3,
            joined: true,
            ownershipEpoch: 1,
          } as EngineOpenResult;
        }),
      } as unknown as Pick<GatewayClient, 'openFile'>,
      opened: [],
    };
    const { transport } = makeTransport({
      gateway: joinerGateway as unknown as ReturnType<typeof makeGateway>,
      deps: { sendBeaconFn },
    });
    await transport.connect('file-1');
    transport.releaseOnUnload();
    await tick();
    expect(beacons).toHaveLength(0);
    transport.disconnect();
  });

  it('the creator latch survives a reconnect (re-join of the same file)', async () => {
    const { beacons, sendBeaconFn } = beaconCapture();
    const { transport } = makeTransport({ deps: { sendBeaconFn } });
    await connectAndHello(transport, { revision: 0 });
    // Reconnect: the second handshake JOINS the session this tab
    // created (gateway reports joined=true, fresh engine/token pair).
    await transport.connect('file-1');
    expect(transport.wasJoined).toBe(true);
    transport.releaseOnUnload();
    await tick();
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.url).toBe('http://engine-2/session/release?access_token=tok-2');
    transport.disconnect();
  });

  it('participantDisplayName never renders a raw principal/UID (D8)', () => {
    const base = { color: '#000', sheet: 'Sheet1', row: 0, col: 0 };
    // A real display name rides through.
    expect(participantDisplayName({ ...base, principal: 'user:abc123', name: 'Ada Lovelace' })).toBe('Ada Lovelace');
    // No name → neutral label, never the id.
    expect(participantDisplayName({ ...base, principal: 'user:2G7rqK3GIPQwAdffZfnp8cv3Uy2' })).toBe('Guest');
    // A "name" that IS the principal (or its bare id) is not a name.
    expect(participantDisplayName({ ...base, principal: 'user:abc123', name: 'user:abc123' })).toBe('Guest');
    expect(participantDisplayName({ ...base, principal: 'user:abc123', name: 'abc123' })).toBe('Guest');
    expect(participantDisplayName({ ...base, principal: 'user:abc123', name: '   ' })).toBe('Guest');
  });

  it('no opened session → no beacon', async () => {
    const { beacons, sendBeaconFn } = beaconCapture();
    const { transport } = makeTransport({ deps: { sendBeaconFn } });
    transport.releaseOnUnload();
    await tick();
    expect(beacons).toHaveLength(0);
    transport.disconnect();
  });
});
