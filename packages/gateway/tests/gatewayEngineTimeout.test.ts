/**
 * Item D (open-defects sweep) — gateway proxy timeout vs long engine ops.
 *
 * Residual (o): a checkpoint/save of a large session proxied through the
 * gateway can exceed the proxy timeout; a /download that joins an
 * in-flight P95 checkpoint timed out while the server completed
 * correctly. Re-derived against current code (2026-10-21):
 *
 * - gateway.ts gave the 600 s upstream class ONLY to /load,
 *   /load/stream, GET /snapshot, /download, /library* and /read.
 *   Every other engine route kept the 30 s default — including the
 *   checkpoint-class routes:
 *     POST /session/release     (checkpoint + evict: evictSession
 *                                awaits checkpointSession)
 *     POST /session/rehydrate   (snapshot build + journal replay)
 *     POST /load/storage-ref    (a full workbook build, like /load)
 *     POST /ops, /execute       (sequencer: a structural op first runs
 *                                a barrier checkpoint; ops also queue
 *                                behind a save pin / in-flight save)
 * - Deployment design: engine traffic is 600 s-class proxy work
 *   ("600 s-class streaming proxy/load traffic is service work";
 *   engine request timeout is the long class, worst real ops are
 *   P99 build ~249 s / P95 save ~109 s). The fix therefore puts the
 *   WHOLE /api/engine route on the 600 s class (ENGINE_UPSTREAM_
 *   TIMEOUT_MS) instead of enumerating routes that drift again.
 *   Non-engine routes keep the 30 s fail-fast default.
 *
 * These tests park a stub upstream for 32 s (> the old 30 s default)
 * and prove the request survives through the gateway — the same
 * controlled-slow-endpoint pattern as the D4 agent-message test in
 * agentBinding.test.ts — plus a control proving a non-engine route
 * still fails fast at ~30 s. Per-test timeouts are generous (150 s)
 * because this VM is shared: in the first post-fix run every timer
 * was inflated by contention (a 32 s park completed at 75.8 s through
 * the gateway — still a 200, where pre-fix it died at 30,395 ms).
 */
import { describe, expect, it } from 'vitest';
import { createGateway, ENGINE_UPSTREAM_TIMEOUT_MS } from '../src/gateway.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const PARK_MS = 32_000;

/** Stub upstream that answers every request after PARK_MS. */
async function startParkingBackend(): Promise<Started> {
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, parkedMs: PARK_MS, echoedBodyBytes: body.length }));
      }, PARK_MS);
    });
  });
}

async function setup() {
  const backend = await startParkingBackend();
  const gateway = await startServer(
    createGateway({
      devLoginEnabled: true,
      authSecret: 'itemd-test-secret',
      routes: { '/api/engine': backend.url, '/api/echo': backend.url },
      rateLimit: { points: 1000, perSeconds: 60 },
    }),
  );
  const login = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'itemd' } });
  const token = (login.json as { token: string }).token;
  return { backend, gateway, auth: { Authorization: `Bearer ${token}` } };
}

describe('Item D: gateway engine-route proxy timeout', () => {
  it('exposes a 600s engine upstream timeout class', () => {
    expect(ENGINE_UPSTREAM_TIMEOUT_MS).toBe(600_000);
  });

  it(
    'POST /api/engine/session/release (checkpoint + evict) survives a >30s upstream park',
    async () => {
      const { backend, gateway, auth } = await setup();
      try {
        const started = Date.now();
        const r = await httpJson('POST', `${gateway.url}/api/engine/session/release`, {
          headers: auth,
          body: { sessionId: 'sess-1', reason: 'client' },
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(31_000);
        expect(r.status).toBe(200);
        expect((r.json as { ok: boolean }).ok).toBe(true);
      } finally {
        await stop(gateway);
        await stop(backend);
      }
    },
    150_000,
  );

  it(
    'POST /api/engine/load/storage-ref (load-class build) survives a >30s upstream park',
    async () => {
      const { backend, gateway, auth } = await setup();
      try {
        const started = Date.now();
        const r = await httpJson('POST', `${gateway.url}/api/engine/load/storage-ref`, {
          headers: auth,
          body: { object: 'user/file.xlsx', format: 'xlsx' },
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(31_000);
        expect(r.status).toBe(200);
        expect((r.json as { ok: boolean }).ok).toBe(true);
      } finally {
        await stop(gateway);
        await stop(backend);
      }
    },
    150_000,
  );

  it(
    'POST /api/engine/ops (sequencer; structural ops run a barrier checkpoint) survives a >30s upstream park',
    async () => {
      const { backend, gateway, auth } = await setup();
      try {
        const started = Date.now();
        const r = await httpJson('POST', `${gateway.url}/api/engine/ops`, {
          headers: auth,
          body: { clientId: 'c1', clientSeq: 1, baseRev: 0, cmd: { cmd: 'setCell' } },
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(31_000);
        expect(r.status).toBe(200);
        expect((r.json as { ok: boolean }).ok).toBe(true);
      } finally {
        await stop(gateway);
        await stop(backend);
      }
    },
    150_000,
  );

  it(
    'POST /api/engine/session/rehydrate (snapshot build + journal replay) survives a >30s upstream park',
    async () => {
      const { backend, gateway, auth } = await setup();
      try {
        const started = Date.now();
        const r = await httpJson('POST', `${gateway.url}/api/engine/session/rehydrate`, {
          headers: auth,
          body: { sessionId: 'sess-1' },
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(31_000);
        expect(r.status).toBe(200);
        expect((r.json as { ok: boolean }).ok).toBe(true);
      } finally {
        await stop(gateway);
        await stop(backend);
      }
    },
    150_000,
  );

  it(
    'control: a non-engine route still fails fast at the 30s default (502), not the engine class',
    async () => {
      const { backend, gateway, auth } = await setup();
      try {
        const started = Date.now();
        const r = await httpJson('POST', `${gateway.url}/api/echo/anything`, {
          headers: auth,
          body: { hello: 'world' },
        });
        const elapsed = Date.now() - started;
        expect(r.status).toBe(502);
        expect(elapsed).toBeGreaterThanOrEqual(29_000);
        expect(elapsed).toBeLessThan(45_000);
      } finally {
        await stop(gateway);
        await stop(backend);
      }
    },
    90_000,
  );
});
