/**
 * FIX-E routes on the agent service:
 * - POST /artifacts/generate — gateway-mode app generation. The route
 *   delegates to an injected AppGenerator — here a REAL LlmAppGenerator
 *   over the service package's TestCodeGenBackend, so the full
 *   generateAndSaveArtifact flow runs without any network. Production
 *   injects nothing and gets the Vertex AI generator (503 when no GCP
 *   credentials are available).
 * - POST /tools/call — the generated-app runtime bridge, enforced
 *   server-side against ALLOWED_BRIDGE_TOOLS.
 * The runtime behind both is the real session-aware runtimeFor; with
 * no live session it falls back to the per-principal private host,
 * which is exactly the no-workbook-open case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmAppGenerator,
  TestCodeGenBackend,
  type AppGenerator,
  type GenerateArtifactResult,
} from '@icecream-sheets/service';
import { createAgentListener } from '../src/services/agentSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };

const stubGenerator: AppGenerator = new LlmAppGenerator({ backend: new TestCodeGenBackend() });

describe('agent /artifacts/generate + /tools/call (FIX-E)', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup(appGenerator: AppGenerator | null) {
    svc = await startServer(createAgentListener({ appGenerator }));
  }
  const post = (path: string, body: unknown) =>
    httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });

  it('503 when app generation is disabled (appGenerator: null)', async () => {
    await setup(null);
    const r = await post('/artifacts/generate', { prompt: 'build a data table app' });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.json)).toContain('not configured');
  });

  it('400 on a missing prompt', async () => {
    await setup(stubGenerator);
    const r = await post('/artifacts/generate', { sheet: 'Sheet1' });
    expect(r.status).toBe(400);
  });

  it('generates an app artifact through the full flow', async () => {
    await setup(stubGenerator);
    // Seed the (private-host) workbook through the bridge route itself:
    // generation refuses an empty sheet, by design.
    const seed = await post('/tools/call', {
      tool: 'write_cells',
      args: {
        cells: [
          { sheet: 'Sheet1', row: 0, col: 0, value: 'Item' },
          { sheet: 'Sheet1', row: 0, col: 1, value: 'Qty' },
          { sheet: 'Sheet1', row: 1, col: 0, value: 'Pens' },
          { sheet: 'Sheet1', row: 1, col: 1, value: 5 },
          { sheet: 'Sheet1', row: 2, col: 0, value: 'Pads' },
          { sheet: 'Sheet1', row: 2, col: 1, value: 3 },
        ],
      },
    });
    expect(seed.status).toBe(200);
    const r = await post('/artifacts/generate', {
      prompt: 'build a data table app for my sheet',
      sheet: 'Sheet1',
    });
    expect(r.status).toBe(200);
    const result = (r.json as { result: GenerateArtifactResult }).result;
    expect(result.routed).toBe('app');
    if (result.routed === 'app') {
      expect(result.spec.source).toContain('function App(');
      expect(result.spec.id).toBeTruthy();
    }
  });

  it('404 with a plain-language error when the named sheet does not exist (#64)', async () => {
    await setup(stubGenerator);
    const r = await post('/artifacts/generate', {
      prompt: 'build a data table app for my sheet',
      sheet: 'NoSuchSheet',
    });
    expect(r.status).toBe(404);
    expect((r.json as { error: string }).error).toBe(
      'Sheet "NoSuchSheet" does not exist in this workbook.',
    );
  });

  it('rejects an over-cap prompt with the 2,000-char limit named (guardrail)', async () => {
    await setup(stubGenerator);
    const r = await post('/artifacts/generate', { prompt: 'x'.repeat(2_500) });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toContain('limit is 2,000 characters');
  });

  it('/tools/call refuses non-bridge tools with 403', async () => {
    await setup(stubGenerator);
    for (const tool of ['execute_code', 'agent.ask_question', 'memory_save', 'analyze_data']) {
      const r = await post('/tools/call', { tool, args: {} });
      expect(r.status, tool).toBe(403);
    }
  });

  it('/tools/call serves an allowed bridge tool through the runtime', async () => {
    await setup(stubGenerator);
    const r = await post('/tools/call', {
      tool: 'read_cells',
      args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    });
    expect(r.status).toBe(200);
    expect((r.json as { data: unknown }).data).toBeDefined();
  });
});

describe('agent GET /artifacts (#142)', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  const CAROL = { 'x-principal': 'user:carol' };
  const postAs = (headers: Record<string, string>) => (path: string, body: unknown) =>
    httpJson('POST', `${svc!.url}${path}`, { headers, body });
  const getAs = (headers: Record<string, string>) => (path: string) =>
    httpJson('GET', `${svc!.url}${path}`, { headers });

  it('lists a route-generated app for its owner, and hides it from another principal', async () => {
    svc = await startServer(createAgentListener({ appGenerator: stubGenerator }));
    const carolPost = postAs(CAROL);
    // Seed carol's private-host workbook (generation refuses an empty sheet).
    const seed = await carolPost('/tools/call', {
      tool: 'write_cells',
      args: {
        cells: [
          { sheet: 'Sheet1', row: 0, col: 0, value: 'Item' },
          { sheet: 'Sheet1', row: 0, col: 1, value: 'Qty' },
          { sheet: 'Sheet1', row: 1, col: 0, value: 'Pens' },
          { sheet: 'Sheet1', row: 1, col: 1, value: 5 },
        ],
      },
    });
    expect(seed.status).toBe(200);
    const gen = await carolPost('/artifacts/generate', {
      prompt: 'build a data table app for my sheet',
      sheet: 'Sheet1',
    });
    expect(gen.status).toBe(200);
    const result = (gen.json as { result: GenerateArtifactResult }).result;
    expect(result.routed).toBe('app');
    if (result.routed !== 'app') throw new Error('unreachable');
    // The owner sees it (full spec, so the tab can open it).
    const mine = await getAs(CAROL)('/artifacts');
    expect(mine.status).toBe(200);
    const specs = (mine.json as { artifacts: { id: string; source: string }[] }).artifacts;
    const found = specs.find((s) => s.id === result.spec.id);
    expect(found).toBeDefined();
    expect(found!.source).toContain('function App(');
    // Another principal does not.
    const theirs = await getAs(ALICE)('/artifacts');
    expect(theirs.status).toBe(200);
    const other = (theirs.json as { artifacts: { id: string }[] }).artifacts;
    expect(other.some((s) => s.id === result.spec.id)).toBe(false);
  });
});
