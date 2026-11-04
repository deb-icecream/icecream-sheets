/**
 * #143 probe tests for OpenAICompatibleBackend (no live key, no network:
 * every provider is a fake fetch).
 *
 * The Groq legs proved the model id/key/reachability good (the artifact
 * route returns 200) while panel chat turns died with the generic busy
 * message. The pinned shape difference: the chat loop sent
 * response_format json_object on BOTH legs (and stream:true on the SSE
 * leg); Groq rejects stream + structured output outright, and
 * JSON-object mode is model-dependent. These tests pin the fix:
 * the backend must never send response_format, must tolerate
 * fence-wrapped plans, and must fail fast carrying the provider
 * detail on a deterministically rejected shape.
 */
import { describe, expect, it } from 'vitest';
import {
  OpenAICompatibleBackend,
  ProviderHttpError,
} from '../src/agent/openaiBackend.js';
import type { PlannerInput } from '../src/agent/types.js';

const PLAN = JSON.stringify({
  message: 'Reading A1 on Sheet1.',
  actions: [
    {
      type: 'tool',
      tool: 'read_cells',
      args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      rationale: 'read the cell the user asked about',
    },
  ],
});

function input(): PlannerInput {
  return { userText: 'what is on cell A1?', history: [], toolResults: [], iteration: 1 };
}

function nonStreamPlanResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: PLAN } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function ssePlanResponse(): Response {
  const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: PLAN } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(chunk, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('#143 chat loop vs Groq-shaped provider', () => {
  it('never sends response_format, and succeeds where a response_format-rejecting provider 400s it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      bodies.push(body);
      if ('response_format' in body) {
        // Groq-shaped rejection of the old request shape.
        return new Response(
          JSON.stringify({
            error: {
              message: 'response_format is not supported with stream',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return body.stream === true ? ssePlanResponse() : nonStreamPlanResponse();
    }) as typeof fetch;
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'groq-shaped-model',
      getApiKey: async () => 'fake-key-for-test-only',
      fetchImpl,
      retryDelaysMs: [],
    });
    // Streaming leg (what the panel uses): must succeed via SSE.
    const streamed = await backend.plan(input(), { onToken: () => {} });
    expect(streamed.actions).toHaveLength(1);
    expect(streamed.actions[0]).toMatchObject({ type: 'tool', tool: 'read_cells' });
    // Non-stream leg: must succeed too.
    const plain = await backend.plan(input());
    expect(plain.actions[0]).toMatchObject({ type: 'tool', tool: 'read_cells' });
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toHaveProperty('response_format');
    }
  });

  it('parses a fence-wrapped plan once json_object mode is gone', async () => {
    const fenced = '```json\n' + PLAN + '\n```';
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: fenced } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://example.invalid/v1',
      getApiKey: async () => 'fake-key-for-test-only',
      fetchImpl,
      retryDelaysMs: [],
    });
    const out = await backend.plan(input());
    expect(out.message).toBe('Reading A1 on Sheet1.');
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'read_cells' });
  });

  it('fails fast with the provider detail on a non-retryable stream rejection', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { message: 'model decommissioned: use another model' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://example.invalid/v1',
      getApiKey: async () => 'fake-key-for-test-only',
      fetchImpl,
      retryDelaysMs: [1000, 2500, 6000],
    });
    await expect(backend.plan(input(), { onToken: () => {} })).rejects.toThrow(
      /provider returned 400.*model decommissioned/,
    );
    // Fail fast: one attempt, not the full retry schedule.
    expect(calls).toBe(1);
  });

  it('ProviderHttpError marks only 429/5xx retryable', () => {
    expect(new ProviderHttpError(400, 'bad').retryable).toBe(false);
    expect(new ProviderHttpError(401, 'bad').retryable).toBe(false);
    expect(new ProviderHttpError(429, 'slow').retryable).toBe(true);
    expect(new ProviderHttpError(503, 'down').retryable).toBe(true);
  });

  it('#141: accepts a generate_app plan action (loop tool allowlist)', async () => {
    const appPlan = JSON.stringify({
      message: 'Building the app.',
      actions: [
        { type: 'tool', tool: 'generate_app', args: { prompt: 'show earnings over time' } },
      ],
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: appPlan } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://example.invalid/v1',
      getApiKey: async () => 'fake-key-for-test-only',
      fetchImpl,
      retryDelaysMs: [],
    });
    const out = await backend.plan(input());
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'generate_app' });
  });

  it('#138: accepts a create_diagram plan action (loop tool allowlist)', async () => {
    const diagPlan = JSON.stringify({
      message: 'Creating the diagram.',
      actions: [
        {
          type: 'tool',
          tool: 'create_diagram',
          args: { layout: 'process', items: ['Order', 'Ship', 'Deliver'], title: 'Order process' },
        },
      ],
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: diagPlan } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://example.invalid/v1',
      getApiKey: async () => 'fake-key-for-test-only',
      fetchImpl,
      retryDelaysMs: [],
    });
    const out = await backend.plan(input());
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'create_diagram' });
  });

  it('#140: accepts a create_chart plan action (native-chart loop tool allowlist)', async () => {
    const chartPlan = JSON.stringify({
      message: 'Adding the chart to the sheet.',
      actions: [
        {
          type: 'tool',
          tool: 'create_chart',
          args: { sheet: 'Sheet1', range: 'A1:B4', kind: 'column', title: 'Sales' },
        },
      ],
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: chartPlan } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://example.invalid/v1',
      getApiKey: async () => 'fake-key-for-test-only',
      fetchImpl,
      retryDelaysMs: [],
    });
    const out = await backend.plan(input());
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'create_chart' });
  });
});
