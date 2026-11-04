/**
 * Production planner default (2026-10-22, deploy-followup leg 7): the
 * shipped 'vertex' config means "the product's default model". With a
 * GCP identity the default resolves to Gemini on Vertex AI through the
 * service's own token chain; an explicit per-user config always wins;
 * without a GCP identity the default falls through to env/no-model.
 *
 * The baseUrl + publisher-qualified model pair pinned here is the exact
 * form the leg-7 live smoke proved against dreamscapes-zero (the Vertex
 * OpenAI-compatible endpoint 400s on a bare model id).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultAgentSettings,
  type AgentServiceSettings,
  type CredentialVault,
  type OpenAICompatibleBackend,
  type PlannerInput,
} from '@icecream-sheets/service';
import {
  createVertexDefaultBackend,
  selectBackend,
  vertexPlannerBaseUrl,
} from '../src/services/agentSvc.js';

const INPUT: PlannerInput = {
  userText: 'What does the SUM function do?',
  history: [],
  toolResults: [],
  iteration: 0,
};

const ENV_KEYS = ['GCP_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function planOkFetch(captured: { url: string; init: RequestInit }[]) {
  return (async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ message: 'SUM adds numbers.', actions: [] }),
            },
          },
        ],
      }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;
}

const vaultStub = {
  retrieve: async () => 'user-key',
} as unknown as CredentialVault;

describe('vertexPlannerBaseUrl', () => {
  it('is the exact global OpenAI-compat form the leg-7 smoke proved', () => {
    expect(vertexPlannerBaseUrl('dreamscapes-zero')).toBe(
      'https://aiplatform.googleapis.com/v1/projects/dreamscapes-zero/locations/global/endpoints/openapi',
    );
  });
});

describe('createVertexDefaultBackend', () => {
  it('builds the Vertex backend and fetches a FRESH token per planner call', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let tokenCalls = 0;
    const backend = createVertexDefaultBackend({
      project: 'test-proj',
      tokenProvider: async () => `tok-${++tokenCalls}`,
      fetchImpl: planOkFetch(calls),
    });
    expect(backend).not.toBeNull();
    expect(backend!.name).toBe('openai-compatible');
    expect((backend as unknown as OpenAICompatibleBackend).providerModel).toBe(
      'google/gemini-3.1-flash-lite',
    );

    const out1 = await backend!.plan(INPUT);
    const out2 = await backend!.plan(INPUT);
    expect(out1.message).toBe('SUM adds numbers.');
    expect(out2.message).toBe('SUM adds numbers.');

    // One token fetch per plan call — never a stored static key.
    expect(tokenCalls).toBe(2);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe(
        'https://aiplatform.googleapis.com/v1/projects/test-proj/locations/global/endpoints/openapi/chat/completions',
      );
      const body = JSON.parse(String(c.init.body)) as { model: string };
      expect(body.model).toBe('google/gemini-3.1-flash-lite');
    }
    const auth = calls.map(
      (c) => (c.init.headers as Record<string, string>)['authorization'],
    );
    expect(auth).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('fails the plan clearly when the token chain yields no token', async () => {
    const backend = createVertexDefaultBackend({
      project: 'test-proj',
      tokenProvider: async () => null,
      fetchImpl: planOkFetch([]),
    });
    await expect(backend!.plan(INPUT)).rejects.toThrow(/no GCP access token/);
  });

  it('reads the project from env when deps omit it', () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    process.env.GCP_PROJECT_ID = 'env-proj';
    const backend = createVertexDefaultBackend({
      tokenProvider: async () => 'tok',
      fetchImpl: planOkFetch([]),
    });
    expect(backend).not.toBeNull();
    expect(backend!.name).toBe('openai-compatible');
  });

  it('returns null with no GCP identity (local/dev falls through to env/no-model)', () => {
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    expect(createVertexDefaultBackend({})).toBeNull();
    expect(
      createVertexDefaultBackend({ tokenProvider: async () => 'tok' }),
    ).toBeNull();
  });
});

describe('selectBackend', () => {
  it('an explicit per-user config wins untouched over the Vertex default', () => {
    const config: AgentServiceSettings = {
      model: {
        provider: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        model: 'user-model',
        keyRef: 'agent:user-x:model-api-key',
      },
    };
    const vertex = createVertexDefaultBackend({
      project: 'test-proj',
      tokenProvider: async () => 'tok',
      fetchImpl: planOkFetch([]),
    });
    const chosen = selectBackend('user-x', config, vaultStub, vertex);
    expect(chosen).not.toBe(vertex);
    expect(chosen.name).toBe('openai-compatible');
    expect((chosen as unknown as OpenAICompatibleBackend).providerModel).toBe('user-model');
  });

  it('the Vertex default resolves to the Vertex backend when available', () => {
    const vertex = createVertexDefaultBackend({
      project: 'test-proj',
      tokenProvider: async () => 'tok',
      fetchImpl: planOkFetch([]),
    });
    const chosen = selectBackend('user-x', defaultAgentSettings(), vaultStub, vertex);
    expect(chosen).toBe(vertex);
  });

  it('the default resolves to the no-model backend with no GCP identity and no env (#137)', () => {
    const chosen = selectBackend('user-x', defaultAgentSettings(), vaultStub, null, null);
    expect(chosen.name).toBe('no-model');
  });

  it('a legacy heuristic provider fails closed to the no-model backend', () => {
    const chosen = selectBackend(
      'user-x',
      { model: { provider: 'heuristic' as never } },
      vaultStub,
      null,
      null,
    );
    expect(chosen.name).toBe('no-model');
  });
});
