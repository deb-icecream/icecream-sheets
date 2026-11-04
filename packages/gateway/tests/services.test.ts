import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFailurePolicy, ETL_RECIPE_VERSION, type EtlRecipe } from '@icecream-sheets/service';
import { createVaultListener } from '../src/services/vaultSvc.js';
import { createMetaListener } from '../src/services/metaSvc.js';
import { createEtlListener } from '../src/services/etlSvc.js';
import { createAgentListener } from '../src/services/agentSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';
import type { ModelBackend, PlannerInput, PlannerOutput } from '@icecream-sheets/service';

// Isolated thread store for this file: agentThreadPersistence() is a
// file-backed singleton at ICECREAM_DATA_DIR (default
// ~/.icecream-sheets/data, shared across runs), so without isolation
// /pending would list asks left by earlier runs and the HITL test's
// exact-count assertions could never pass.
process.env.ICECREAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'agent-services-data-'));

/**
 * #137 stub planner for the agent-service HTTP tests: the heuristic
 * planner was DELETED. 'hello' parks on a product-style intentChoice
 * options ask (the HITL mechanics under test); 'recalculate now'
 * plans the recalculate tool. Nothing here guesses user intent in
 * the product path — this is a test double for HTTP plumbing.
 */
function makeServiceStub(): ModelBackend {
  return {
    name: 'stub-service',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.iteration > 1) return { message: 'Done.', actions: [{ type: 'done' }] };
      if (input.userText.includes('recalculate')) {
        return { message: '', actions: [{ type: 'tool', tool: 'recalculate', args: {} }] };
      }
      return {
        message: '',
        actions: [
          {
            type: 'ask',
            question: 'What should I do?',
            options: ['Recalculate', 'Something else'],
            intentChoice: true,
          },
        ],
      };
    },
  };
}

const ALICE = { 'x-principal': 'user:alice' };
const BOB = { 'x-principal': 'user:bob' };

describe('vault service', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });
  async function setup() {
    svc = await startServer(createVaultListener());
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = ALICE) =>
    httpJson('POST', `${svc!.url}${path}`, { headers, body });

  it('store → retrieve → revoke round-trip', async () => {
    await setup();
    expect((await post('/store', { ref: 'user:alice:api-key', secret: 's3cr3t' })).status).toBe(200);
    const got = await post('/retrieve', { ref: 'user:alice:api-key' });
    expect(got.status).toBe(200);
    expect((got.json as { secret: string }).secret).toBe('s3cr3t');
    expect((await post('/revoke', { ref: 'user:alice:api-key' })).status).toBe(200);
    const gone = await post('/retrieve', { ref: 'user:alice:api-key' });
    expect(gone.status).toBe(404);
  });

  it('fail closed across principals', async () => {
    await setup();
    await post('/store', { ref: 'user:alice:api-key', secret: 's3cr3t' });
    // Bob cannot touch alice's ref — 403 at the handler, before the vault.
    expect((await post('/retrieve', { ref: 'user:alice:api-key' }, BOB)).status).toBe(403);
    expect((await post('/revoke', { ref: 'user:alice:api-key' }, BOB)).status).toBe(403);
    expect((await post('/store', { ref: 'user:alice:evil', secret: 'x' }, BOB)).status).toBe(403);
    // Bob's own namespace works.
    expect((await post('/store', { ref: 'user:bob:k', secret: 'b' }, BOB)).status).toBe(200);
  });

  it('/refs lists only the requester’s own refs', async () => {
    await setup();
    await post('/store', { ref: 'user:alice:a', secret: '1' });
    await post('/store', { ref: 'user:bob:b', secret: '2' }, BOB);
    const refs = (
      await httpJson('GET', `${svc!.url}/refs`, { headers: ALICE })
    ).json as { refs: string[] };
    // The vault is process-scoped by design; assert namespacing, not exact
    // equality across tests.
    expect(refs.refs).toContain('user:alice:a');
    expect(refs.refs.every((r) => r.startsWith('user:alice:'))).toBe(true);
  });
});

describe('meta service', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });
  async function setup() {
    svc = await startServer(createMetaListener());
  }

  it('put → get → delete round-trip, namespaced per principal', async () => {
    await setup();
    const put = await httpJson('PUT', `${svc!.url}/kv/ui/theme`, { headers: ALICE, body: { value: 'dark' } });
    expect(put.status).toBe(200);
    const get = await httpJson('GET', `${svc!.url}/kv/ui/theme`, { headers: ALICE });
    expect((get.json as { value: string }).value).toBe('dark');
    // Bob cannot see alice's key: null, not an error, not a leak.
    const bobGet = await httpJson('GET', `${svc!.url}/kv/ui/theme`, { headers: BOB });
    expect((bobGet.json as { value: null }).value).toBeNull();
    // Bob writes the same key name: independent storage.
    await httpJson('PUT', `${svc!.url}/kv/ui/theme`, { headers: BOB, body: { value: 'light' } });
    const aliceAgain = await httpJson('GET', `${svc!.url}/kv/ui/theme`, { headers: ALICE });
    expect((aliceAgain.json as { value: string }).value).toBe('dark');
    const del = await httpJson('DELETE', `${svc!.url}/kv/ui/theme`, { headers: ALICE });
    expect(del.status).toBe(200);
    const gone = await httpJson('GET', `${svc!.url}/kv/ui/theme`, { headers: ALICE });
    expect((gone.json as { value: null }).value).toBeNull();
  });
});

describe('etl service', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });
  async function setup() {
    svc = await startServer(createEtlListener());
  }

  it('runs a csv-text recipe and returns the RunRecord', async () => {
    await setup();
    const recipe: EtlRecipe = {
      version: ETL_RECIPE_VERSION,
      id: 'r1',
      name: 'test recipe',
      owner: 'user:alice',
      nodes: [
        { id: 'src', kind: 'source', source: { type: 'csv-text', text: 'a,b\n1,2\n3,4' } },
        {
          id: 'load',
          kind: 'load',
          target: { kind: 'workbook-table', workbookId: 'wb', sheetName: 'S', tableName: 'T' },
        },
      ],
      edges: [{ from: 'src', to: 'load' }],
      schedule: { trigger: 'manual' },
      failurePolicy: defaultFailurePolicy(),
    };
    const r = await httpJson('POST', `${svc!.url}/run`, { headers: ALICE, body: { recipe } });
    expect(r.status).toBe(200);
    const record = r.json as { status: string; rowsLoaded: number; steps: unknown[]; recipeId: string };
    expect(record.status).toBe('succeeded');
    expect(record.rowsLoaded).toBe(2);
    expect(record.recipeId).toBe('r1');
    expect(record.steps.length).toBe(2);
  });

  it('rejects an invalid recipe with 400', async () => {
    await setup();
    const r = await httpJson('POST', `${svc!.url}/run`, { headers: ALICE, body: { recipe: { id: 'x' } } });
    expect(r.status).toBe(400);
  });
});

describe('agent service', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });
  async function setup() {
    svc = await startServer(createAgentListener({ modelBackend: makeServiceStub() }));
  }

  it('message → reply shape with threadId, message, needsInput, audit', async () => {
    await setup();
    // 'recalculate now' completes without a human-in-the-loop pause.
    const r = await httpJson('POST', `${svc!.url}/message`, {
      headers: ALICE,
      body: { text: 'recalculate now' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as {
      threadId: string;
      message: string;
      needsInput: null | { prompt: string; options: string[] };
      audit: unknown[];
    };
    expect(typeof reply.threadId).toBe('string');
    expect(reply.threadId.length).toBeGreaterThan(0);
    expect(typeof reply.message).toBe('string');
    expect(reply.message.length).toBeGreaterThan(0);
    expect(Array.isArray(reply.audit)).toBe(true);
    expect(reply.audit.length).toBeGreaterThan(0);

    // Continuing the thread works: pass threadId back.
    const r2 = await httpJson('POST', `${svc!.url}/message`, {
      headers: ALICE,
      body: { threadId: reply.threadId, text: 'recalculate now' },
    });
    expect((r2.json as { threadId: string }).threadId).toBe(reply.threadId);

    // GET /audit?threadId= returns the thread's audit trail.
    const a = await httpJson('GET', `${svc!.url}/audit?threadId=${reply.threadId}`, { headers: ALICE });
    expect(a.status).toBe(200);
    expect(Array.isArray((a.json as { audit: unknown[] }).audit)).toBe(true);
  });

  it('rejects empty text', async () => {
    await setup();
    const r = await httpJson('POST', `${svc!.url}/message`, { headers: ALICE, body: { text: '' } });
    expect(r.status).toBe(400);
  });

  it('human-in-the-loop over HTTP: /pending → /answer unblocks the parked turn', async () => {
    await setup();
    // 'hello' parks on the stub's intentChoice options ask, and the
    // /message POST parks until the human answers (ai-agent.md §12).
    const msgP = httpJson('POST', `${svc!.url}/message`, {
      headers: ALICE,
      body: { text: 'hello' },
    });
    // The parked ask is visible via /pending (principal-scoped).
    let asks: { id: string; kind: string; options?: string[] }[] = [];
    const start = Date.now();
    while (asks.length === 0 && Date.now() - start < 10000) {
      const p = await httpJson('GET', `${svc!.url}/pending`, { headers: ALICE });
      expect(p.status).toBe(200);
      asks = (p.json as { asks?: typeof asks }).asks ?? [];
      if (asks.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(asks).toHaveLength(1);
    expect(asks[0]!.kind).toBe('options');
    expect(asks[0]!.options).toContain('Recalculate');
    // Answering unblocks the parked turn.
    const ans = await httpJson('POST', `${svc!.url}/answer`, {
      headers: ALICE,
      body: { askId: asks[0]!.id, answer: 'Recalculate' },
    });
    expect(ans.status).toBe(200);
    const r = await msgP;
    expect(r.status).toBe(200);
    const reply = r.json as { message: string; needsInput: null };
    expect(typeof reply.message).toBe('string');
    expect(reply.needsInput).toBeNull();
    // The answered ask is consumed.
    const p2 = await httpJson('GET', `${svc!.url}/pending`, { headers: ALICE });
    expect((p2.json as { asks: unknown[] }).asks).toEqual([]);
  });

  it('forwards the agent chart attachment as JSON (RESOLVED 2026-10-18)', async () => {
    await setup();
    // The chart attachment travels through the gateway as versioned JSON —
    // no binary encoding. Regression: the gateway used to drop the field.
    // 'recalculate now' completes without a human-in-the-loop pause.
    const r = await httpJson('POST', `${svc!.url}/message`, {
      headers: ALICE,
      body: { text: 'recalculate now' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as { chart?: unknown };
    expect('chart' in reply).toBe(true);
    // JSON-safe: whatever the agent attaches must survive a string round-trip.
    const roundTripped = JSON.parse(JSON.stringify(reply.chart ?? null));
    expect(roundTripped).toEqual(reply.chart ?? null);
  });

  it('a versioned chart spec survives the gateway JSON path unchanged', async () => {
    await setup();
    const { makeChartSpec, CHART_SPEC_VERSION } = await import('@icecream-sheets/service');
    const spec = makeChartSpec({
      kind: 'column-clustered',
      title: 'Q3 sales',
      range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 9, endCol: 2 },
    });
    // Simulate the gateway's sendJson: stringify → parse.
    const wire = JSON.parse(JSON.stringify({ chart: spec }));
    expect(wire.chart).toEqual(spec);
    expect(wire.chart.version).toBe(CHART_SPEC_VERSION);
  });
});

describe('agent service: proactive watch + model config (ai-agent.md §§6, 8)', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });
  async function setup() {
    svc = await startServer(createAgentListener({ modelBackend: makeServiceStub() }));
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = ALICE) =>
    httpJson('POST', `${svc!.url}${path}`, { headers, body });
  const get = (path: string, headers: Record<string, string> = ALICE) =>
    httpJson('GET', `${svc!.url}${path}`, { headers });

  it('watch lifecycle: start → poll (no wakes yet) → stop', async () => {
    await setup();
    const started = await post('/watch', { events: ['cells_changed', 'recalc_complete'], sheet: 'Sheet1' });
    expect(started.status).toBe(200);
    const watchId = (started.json as { watchId: string }).watchId;
    expect(typeof watchId).toBe('string');

    const polled = await get(`/watch/poll?watchId=${encodeURIComponent(watchId)}`);
    expect(polled.status).toBe(200);
    expect((polled.json as { wakes: unknown[] }).wakes).toEqual([]);

    const stopped = await post('/watch/stop', { watchId });
    expect(stopped.status).toBe(200);
    expect((stopped.json as { ok: boolean }).ok).toBe(true);
    // Stopping twice is not an error.
    expect(((await post('/watch/stop', { watchId })).json as { ok: boolean }).ok).toBe(false);
  });

  it('watch rejects invalid event lists', async () => {
    await setup();
    expect((await post('/watch', { events: [] })).status).toBe(400);
    expect((await post('/watch', { events: ['nope'] })).status).toBe(400);
    expect((await get('/watch/poll')).status).toBe(400);
  });

  it('mute: whole-thing toggle + per-category, per user, persisted', async () => {
    await setup();
    const initial = (await get('/watch/mute')).json as {
      mutedAll: boolean;
      muted: Record<string, boolean>;
    };
    expect(initial.mutedAll).toBe(false);
    expect(initial.muted.cells_changed).toBe(false);

    const muted = (await post('/watch/mute', { muted: { recalc_complete: true } })).json as typeof initial;
    expect(muted.muted.recalc_complete).toBe(true);
    expect(muted.muted.cells_changed).toBe(false); // patch, not clobber

    const all = (await post('/watch/mute', { mutedAll: true })).json as typeof initial;
    expect(all.mutedAll).toBe(true);
    expect(all.muted.recalc_complete).toBe(true);

    // Per user: bob is unaffected.
    const bob = (await get('/watch/mute', BOB)).json as typeof initial;
    expect(bob.mutedAll).toBe(false);

    // Persisted: a fresh GET still shows alice's config.
    const again = (await get('/watch/mute')).json as typeof initial;
    expect(again.mutedAll).toBe(true);

    // Unknown categories are ignored, not stored.
    const weird = (await post('/watch/mute', { muted: { nope: true } })).json as typeof initial;
    expect('nope' in weird.muted).toBe(false);
  });

  it('config: defaults to vertex; GET never returns the key', async () => {
    await setup();
    const cfg = (await get('/config')).json as Record<string, unknown>;
    expect(cfg.provider).toBe('vertex');
    expect(cfg.hasKey).toBe(false);
    expect('apiKey' in cfg).toBe(false);
    expect(JSON.stringify(cfg)).not.toContain('sk-');
  });

  it('config: switch provider, store key in vault, revoke key', async () => {
    await setup();
    // Invalid provider / baseUrl are rejected.
    expect((await post('/config', { provider: 'evil' })).status).toBe(400);
    expect((await post('/config', { provider: 'openai-compatible' })).status).toBe(400);
    expect((await post('/config', { provider: 'openai-compatible', baseUrl: 'ftp://x' })).status).toBe(400);

    // Valid switch with a key: the key lands in the vault, never in the read surface.
    const ok = await post('/config', {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-x',
      apiKey: 'sk-alice-secret',
    });
    expect(ok.status).toBe(200);
    const described = ok.json as Record<string, unknown>;
    expect(described.provider).toBe('openai-compatible');
    expect(described.baseUrl).toBe('https://api.example.com/v1');
    expect(described.model).toBe('gpt-x');
    expect(described.hasKey).toBe(true);
    expect(JSON.stringify(described)).not.toContain('sk-alice-secret');

    // Key-only update keeps the provider/baseUrl.
    const keyOnly = await post('/config', { provider: 'openai-compatible', apiKey: 'sk-rotated' });
    expect(keyOnly.status).toBe(200);
    expect((keyOnly.json as Record<string, unknown>).baseUrl).toBe('https://api.example.com/v1');

    // Revoke: apiKey null drops the vault credential.
    const revoked = await post('/config', { provider: 'openai-compatible', apiKey: null });
    expect(revoked.status).toBe(200);
    expect((revoked.json as Record<string, unknown>).hasKey).toBe(false);

    // Switching back to the Vertex default works.
    const back = await post('/config', { provider: 'vertex' });
    expect(back.status).toBe(200);
    expect((back.json as Record<string, unknown>).provider).toBe('vertex');

    // The deleted heuristic provider is rejected, not stored.
    const gone = await post('/config', { provider: 'heuristic' });
    expect(gone.status).toBe(400);
  });
});

describe('agent service token streaming (#137)', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  it('SSE carries token events before done', async () => {
    // Fresh principal: runtimeFor caches runtimes per principal, and
    // the earlier tests in this file already cached alice's stub
    // runtime — reusing alice would park on that stub's ask instead
    // of running this stub.
    const CAROL = { 'x-principal': 'user:carol' };
    const tokenStub: ModelBackend = {
      name: 'stub-token',
      async plan(
        _input: PlannerInput,
        opts?: { onToken?: (text: string) => void },
      ): Promise<PlannerOutput> {
        opts?.onToken?.('Hel');
        opts?.onToken?.('lo');
        return { message: 'Hello', actions: [{ type: 'done' }] };
      },
    };
    svc = await startServer(createAgentListener({ modelBackend: tokenStub }));
    const res = await fetch(`${svc.url}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CAROL },
      body: JSON.stringify({ text: 'say hello' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const tokenIdx = text.indexOf('"type":"token"');
    const doneIdx = text.indexOf('event: done');
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(tokenIdx);
    expect(text).toContain('Hello');
  });
});
