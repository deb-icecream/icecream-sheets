/**
 * Streaming disconnect reaping — regression for the production 429
 * outage (deploy-run post-mortem, 2026-10-22): on Cloud Run
 * (containerConcurrency=1, maxScale=3) the engine's never-ending
 * /deltas SSE responses whose clients had been killed pinned every
 * engine-standard instance, and the platform rejected all new
 * requests. The handlers must reap on client disconnect:
 *
 *   - res 'close'/'error' ends the response and removes the
 *     subscription (no further writes are attempted on it);
 *   - writes carry callbacks: a failed flush reaps the subscriber;
 *   - a heartbeat that cannot flush successfully within
 *     SSE_REAP_TIMEOUT_MS reaps the subscriber (the half-open socket
 *     case, where 'close' may never be delivered);
 *   - /load/stream's awaited data-done flush is bounded by
 *     STREAM_WRITE_TIMEOUT_MS and the handler still completes
 *     (build gate settles) when the client vanishes mid-stream.
 *
 * Observability: the tests wrap the real listener in their own HTTP
 * server and spy on the REAL ServerResponse's write()/end() for the
 * streaming routes — `endCalls > 0` is the server-side handler having
 * ENDED the response, and a frozen write count after a broadcast is
 * proof the subscription is gone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineListener } from '../src/services/engineSvc.js';
import { stop, type Started } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const P75 = join(HERE, '..', '..', '..', 'test-data', 'perf-fixtures', 'perf-p75.xlsx');

const ALICE = { 'x-principal': 'user:alice' };
const BOB = { 'x-principal': 'user:bob' };

// -- response capture ---------------------------------------------------------

type WriteMode = 'ok' | 'error' | 'blackhole';

interface Captured {
  res: http.ServerResponse;
  /** Every payload the handler ATTEMPTED to write, in order. */
  writes: string[];
  /** How many times the handler called res.end(). */
  endCalls: number;
  /**
   * Simulated socket health for writes:
   *  - ok:        real write, real callback;
   *  - error:     write callback reports EPIPE asynchronously (the
   *               dead-socket case) and nothing is sent;
   *  - blackhole: write never calls back and nothing is sent (the
   *               half-open case: no flush success, no error, no close).
   */
  writeMode: WriteMode;
}

interface Svc {
  started: Started;
  caps: Map<string, Captured[]>;
}

async function startSvc(env: NodeJS.ProcessEnv): Promise<Svc> {
  const listener = createEngineListener({ deployEnv: env, fileRegistry: null });
  const caps = new Map<string, Captured[]>();
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    if (path === '/deltas' || path === '/load/stream') {
      const cap: Captured = { res, writes: [], endCalls: 0, writeMode: 'ok' };
      const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
      const origEnd = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
      (res as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
        cap.writes.push(String(chunk));
        if (cap.writeMode !== 'ok') {
          const cb = rest.find((a) => typeof a === 'function') as
            | ((err?: Error) => void)
            | undefined;
          if (cap.writeMode === 'error' && cb) {
            queueMicrotask(() => cb(new Error('EPIPE (simulated dead socket)')));
          }
          return false;
        }
        return origWrite(chunk, ...rest);
      };
      (res as { end: unknown }).end = (...args: unknown[]) => {
        cap.endCalls++;
        return origEnd(...args);
      };
      const arr = caps.get(path) ?? [];
      arr.push(cap);
      caps.set(path, arr);
    }
    listener(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return { started: { server, port: addr.port, url: `http://127.0.0.1:${addr.port}` }, caps };
}

function streamEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SSE_HEARTBEAT_MS: '100',
    SSE_REAP_TIMEOUT_MS: '600',
    STREAM_WRITE_TIMEOUT_MS: '2000',
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
    ...extra,
  } as NodeJS.ProcessEnv;
}

// -- raw HTTP helpers (agent:false → no keep-alive pooling) -------------------

interface RawResponse {
  req: http.ClientRequest;
  res: http.IncomingMessage;
  /** Everything received so far. */
  text: () => string;
  /** Resolves when the response ends/closes/errors (attached at response time). */
  closed: Promise<void>;
}

function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
        });
        const closed = new Promise<void>((res2) => {
          res.on('end', () => res2());
          res.on('close', () => res2());
          res.on('error', () => res2());
        });
        resolve({ req, res, text: () => buf, closed });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function rawJson(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const { res, text, closed } = await rawRequest(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  await Promise.race([
    closed,
    new Promise<never>((_r, rej) =>
      setTimeout(() => rej(new Error(`rawJson: response from ${url} never completed`)), 5000),
    ),
  ]);
  let json: unknown = null;
  try {
    json = JSON.parse(text());
  } catch {
    // leave null
  }
  return { status: res.statusCode ?? 0, json };
}

async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function connectionCount(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.getConnections((_e, n) => resolve(n)));
}

// ---------------------------------------------------------------------------
describe('engine streaming disconnect reaping (leg 6)', () => {
  let svc: Svc | null = null;

  afterEach(async () => {
    if (svc) {
      // Force-close any lingering sockets so server.close() cannot
      // hang the hook (a still-open stream is the failure mode under
      // test — teardown must not depend on it closing politely).
      svc.started.server.closeAllConnections();
      await stop(svc.started);
    }
    svc = null;
  });

  it('/deltas: client destroys the socket mid-stream → handler ends the response and removes the subscription', async () => {
    svc = await startSvc(streamEnv());
    const url = svc.started.url;
    const client = await rawRequest(`${url}/deltas`, { headers: ALICE });
    expect(client.res.statusCode).toBe(200);
    await until(() => client.text().includes('event: hello'));
    const cap = svc.caps.get('/deltas')![0]!;
    expect(cap.endCalls).toBe(0);

    // Kill the client mid-stream (the production curl-harness case).
    client.req.destroy();

    // The server-side handler must END the response within a bounded
    // time — a never-ending response is what pinned Cloud Run slots.
    await until(() => cap.endCalls > 0, 3000);
    // …and the server-side connection must drain.
    await until(async () => (await connectionCount(svc!.started.server)) === 0, 3000);

    // Subscription removed: a later broadcast attempts NO writes on it.
    const writesAtReap = cap.writes.length;
    const presence = await rawJson(`${url}/presence`, {
      method: 'POST',
      headers: BOB,
      body: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(presence.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(cap.writes.length).toBe(writesAtReap);
  });

  it('/deltas: a flush that reports an error (dead socket, no close event) reaps the subscriber', async () => {
    svc = await startSvc(streamEnv());
    const url = svc.started.url;
    const client = await rawRequest(`${url}/deltas`, { headers: ALICE });
    await until(() => client.text().includes('event: hello'));
    const cap = svc.caps.get('/deltas')![0]!;

    // Socket goes bad WITHOUT a close: writes now fail via callback.
    cap.writeMode = 'error';
    // The next heartbeat (100 ms) or broadcast write fails → reap.
    await until(() => cap.endCalls > 0, 3000);

    const writesAtReap = cap.writes.length;
    await rawJson(`${url}/presence`, {
      method: 'POST',
      headers: BOB,
      body: { sheet: 'Sheet1', row: 1, col: 1 },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(cap.writes.length).toBe(writesAtReap);
    client.req.destroy();
  });

  it('/deltas: a blackholed flush (no success, no error, no close) is reaped by the heartbeat timeout', async () => {
    svc = await startSvc(streamEnv());
    const url = svc.started.url;
    const client = await rawRequest(`${url}/deltas`, { headers: ALICE });
    await until(() => client.text().includes('event: hello'));
    const cap = svc.caps.get('/deltas')![0]!;

    // Half-open: writes vanish — never flushed, never error, and the
    // socket never closes. Only the heartbeat reap timeout can save
    // the instance slot. (SSE_REAP_TIMEOUT_MS=600 in this env.)
    cap.writeMode = 'blackhole';
    await until(() => cap.endCalls > 0, 4000);
    client.req.destroy();
  });

  it('/deltas: healthy clients are NOT reaped — heartbeats flow and broadcasts still arrive', async () => {
    svc = await startSvc(streamEnv());
    const url = svc.started.url;
    const a = await rawRequest(`${url}/deltas`, { headers: ALICE });
    const b = await rawRequest(`${url}/deltas`, { headers: BOB });
    await until(() => a.text().includes('event: hello') && b.text().includes('event: hello'));
    const capA = svc.caps.get('/deltas')![0]!;
    const capB = svc.caps.get('/deltas')![1]!;

    // Several heartbeat periods pass (100 ms each, reap timeout 600 ms
    // of FAILED flushes — healthy flushes keep refreshing).
    await new Promise((r) => setTimeout(r, 700));
    expect(capA.endCalls).toBe(0);
    expect(capB.endCalls).toBe(0);
    expect(a.text()).toContain(': heartbeat');

    // Broadcasts still reach both (each already got ONE presence
    // event at subscribe; the POST must produce a second).
    const presenceCount = (s: string) => s.split('event: presence').length - 1;
    await rawJson(`${url}/presence`, {
      method: 'POST',
      headers: BOB,
      body: { sheet: 'Sheet1', row: 2, col: 2 },
    });
    await until(() => presenceCount(a.text()) >= 2 && presenceCount(b.text()) >= 2);

    // A disconnects; B is unaffected and keeps receiving broadcasts.
    a.req.destroy();
    await until(() => capA.endCalls > 0, 3000);
    const aWrites = capA.writes.length;
    await rawJson(`${url}/presence`, {
      method: 'POST',
      headers: BOB,
      body: { sheet: 'Sheet1', row: 3, col: 3 },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(capA.writes.length).toBe(aWrites);
    expect(capB.endCalls).toBe(0);
    b.req.destroy();
  });

  it('/load/stream: client disconnects mid-stream → handler completes, response ended, build gate settled', async () => {
    svc = await startSvc(streamEnv());
    const url = svc.started.url;
    const bytes = new Uint8Array(readFileSync(P75));
    const client = await rawRequest(`${url}/load/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'xlsx', data: Buffer.from(bytes).toString('base64') }),
    });
    expect(client.res.statusCode).toBe(200);
    // Wait for the first NDJSON chunk, then kill the socket mid-stream.
    await until(() => client.text().includes('"meta"'), 15_000);
    client.req.destroy();

    const cap = svc.caps.get('/load/stream')![0]!;
    // The handler must reach its tail (response ended by the handler
    // or destroyed) — never parked on a dead socket's flush.
    await until(() => cap.endCalls > 0 || cap.res.destroyed, 25_000);
    // The build still completes behind the dead stream: the workbook
    // is the NEW one (13 sheets) and reads are served (gate settled —
    // a build parked on the dead stream would leave the gate open and
    // /sheets would keep serving the previous workbook).
    let sheetNames: string[] = [];
    await until(async () => {
      const sheets = await rawJson(`${url}/sheets`, { headers: ALICE });
      const names = (sheets.json as { sheets?: unknown }).sheets;
      if (Array.isArray(names) && names.length === 13) {
        sheetNames = names as string[];
        return true;
      }
      return false;
    }, 25_000);
    const read = await rawJson(`${url}/read`, {
      method: 'POST',
      headers: ALICE,
      body: { kind: 'sheet', sheet: sheetNames[0] },
    });
    expect(read.status).toBe(200);
  }, 60_000);
});
