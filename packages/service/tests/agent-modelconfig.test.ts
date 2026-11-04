/**
 * Tests for the pluggable model backend (design-docs/ai-agent.md §8):
 * provider selection switches backends, the vault-stored key is used for
 * provider requests, and the key never leaks into logs/errors/read surfaces.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  AgentConfigStore,
  DelegatingModelBackend,
  createModelBackend,
  defaultAgentSettings,
  isModelProviderId,
  modelKeyRef,
  type AgentServiceSettings,
} from '../src/agent/config.js';
import { NoModelConfiguredBackend } from '../src/agent/backends.js';
import { OpenAICompatibleBackend, PLANNER_MAX_OUTPUT_TOKENS, SYSTEM_PROMPT, SYSTEM_PROMPT_MAX_CHARS, validatePlan } from '../src/agent/openaiBackend.js';
import { CredentialVault } from '../src/vault.js';
import { KeyManager } from '../src/crypto.js';
import { memoryPersistence } from '../src/metadataStore.js';
import type { PlannerInput } from '../src/agent/types.js';

const SECRET = 'sk-test-very-secret-key-12345';

async function testVault(): Promise<CredentialVault> {
  const vault = await CredentialVault.create(memoryPersistence(), new KeyManager(), {
    check: () => true,
  });
  await vault.store(modelKeyRef('alice'), SECRET, 'alice');
  return vault;
}

function input(userText: string): PlannerInput {
  return { userText, history: [], toolResults: [], iteration: 1 };
}

/** Fake OpenAI chat-completions endpoint. Captures the request for assertions. */
function fakeChatCompletions(planJson: unknown, opts: { status?: number } = {}) {
  const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(planJson) } }] }),
      text: async () => 'provider says no',
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, seen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provider selection', () => {
  it('the Vertex default resolves to the no-model backend service-side (#137)', async () => {
    // Service-side there is no GCP token provider, so the Vertex
    // default correctly reports no model; the gateway serves Vertex.
    const vault = await testVault();
    expect(defaultAgentSettings().model.provider).toBe('vertex');
    const backend = createModelBackend({ config: defaultAgentSettings(), vault, principal: 'alice' });
    expect(backend).toBeInstanceOf(NoModelConfiguredBackend);
  });

  it('a legacy heuristic provider fails closed to the no-model backend', async () => {
    const vault = await testVault();
    const backend = createModelBackend({
      config: { model: { provider: 'heuristic' as never } },
      vault,
      principal: 'alice',
    });
    expect(backend).toBeInstanceOf(NoModelConfiguredBackend);
  });

  it('switches to the OpenAI-compatible backend when configured', async () => {
    const vault = await testVault();
    const backend = createModelBackend({
      config: { model: { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-x' } },
      vault,
      principal: 'alice',
    });
    expect(backend).toBeInstanceOf(OpenAICompatibleBackend);
    expect((backend as OpenAICompatibleBackend).providerModel).toBe('gpt-x');
  });

  it('rejects an invalid baseUrl for the HTTP provider', async () => {
    const vault = await testVault();
    expect(() =>
      createModelBackend({
        config: { model: { provider: 'openai-compatible', baseUrl: 'not-a-url' } },
        vault,
        principal: 'alice',
      }),
    ).toThrow(/baseUrl/);
  });

  it('isModelProviderId guards the provider enum', () => {
    expect(isModelProviderId('vertex')).toBe(true);
    expect(isModelProviderId('openai-compatible')).toBe(true);
    expect(isModelProviderId('heuristic')).toBe(false);
    expect(isModelProviderId('evil')).toBe(false);
  });

  it('DelegatingModelBackend re-resolves per plan() so switches take effect live', async () => {
    const vault = await testVault();
    // One delegating instance; the resolver closure reads a mutable
    // config, so a mid-flight switch changes the next plan's backend.
    // (#137: the old version proved this with the heuristic backend as
    // the first leg; the heuristic no longer serves the request path,
    // so both legs are HTTP backends over different fake endpoints.)
    let current: AgentServiceSettings = {
      model: { provider: 'openai-compatible', baseUrl: 'https://a.example.com/v1' },
    };
    const { fetchImpl: fetchA, seen: seenA } = fakeChatCompletions({
      message: 'from A',
      actions: [{ type: 'done' }],
    });
    const { fetchImpl: fetchB, seen: seenB } = fakeChatCompletions({
      message: 'from B',
      actions: [{ type: 'done' }],
    });
    const delegating = new DelegatingModelBackend(() =>
      createModelBackend({
        config: current,
        vault,
        principal: 'alice',
        fetchImpl: current.model.baseUrl === 'https://a.example.com/v1' ? fetchA : fetchB,
      }),
    );
    const out1 = await delegating.plan(input('hello'));
    expect(out1.message).toBe('from A');
    expect(seenA).toHaveLength(1);
    current = { model: { provider: 'openai-compatible', baseUrl: 'https://b.example.com/v1' } };
    const out2 = await delegating.plan(input('hello'));
    expect(out2.message).toBe('from B');
    expect(seenB).toHaveLength(1);
    expect(seenA).toHaveLength(1);
  });
});

describe('vault-stored key', () => {
  it('is sent as the Bearer token and read from the vault per request', async () => {
    const vault = await testVault();
    const ref = modelKeyRef('alice');
    const { fetchImpl, seen } = fakeChatCompletions({ message: 'ok', actions: [{ type: 'done' }] });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: () => vault.retrieve(ref, 'alice'),
      fetchImpl,
    });
    const out = await backend.plan(input('hello'));
    expect(out.message).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    // Key rotation takes effect on the next request (resolved per request).
    await vault.store(ref, 'sk-rotated', 'alice');
    await backend.plan(input('hello again'));
    expect(seen[1]!.headers.authorization).toBe('Bearer sk-rotated');
  });

  it('sends an explicit planner output-token budget on every request (case-5 closure)', async () => {
    const { fetchImpl, seen } = fakeChatCompletions({ message: 'ok', actions: [{ type: 'done' }] });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => SECRET,
      fetchImpl,
    });
    await backend.plan(input('add a share-of-total column for every row'));
    expect(seen).toHaveLength(1);
    const body = seen[0]!.body as { max_tokens?: unknown; temperature?: unknown };
    // The per-row batch-write plan shape (case 5) was truncated mid-JSON
    // at the provider default; the request must carry the explicit,
    // generous budget so a 12+-write plan fits with headroom.
    expect(body.max_tokens).toBe(PLANNER_MAX_OUTPUT_TOKENS);
    expect(PLANNER_MAX_OUTPUT_TOKENS).toBe(16_384);
    expect(body.temperature).toBe(0);
  });

  it('never leaks into logs or error messages', async () => {
    const vault = await testVault();
    const ref = modelKeyRef('alice');
    const logs: string[] = [];
    const errs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => void errs.push(a.join(' ')));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a) => void errs.push(a.join(' ')));

    // Failing provider: the thrown error must not carry the key.
    // (retryDelaysMs: [] — this test's subject is key leakage, not the
    // FIX-R4 retry timing; the retry path has its own describe below.)
    const failing = fakeChatCompletions(null, { status: 500 });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: () => vault.retrieve(ref, 'alice'),
      fetchImpl: failing.fetchImpl,
      retryDelaysMs: [],
    });
    await expect(backend.plan(input('hello'))).rejects.toThrow(/provider returned 500/);
    await expect(backend.plan(input('hello'))).rejects.not.toThrow(SECRET);

    // Network failure: same guarantee.
    const netFail = (async () => {
      throw new Error('socket hangup');
    }) as typeof fetch;
    const backend2 = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: () => vault.retrieve(ref, 'alice'),
      fetchImpl: netFail,
      retryDelaysMs: [],
    });
    const err = await backend2.plan(input('hello')).catch((e: Error) => e);
    expect(err.message).not.toContain(SECRET);

    // Non-JSON plan from the provider: same guarantee.
    // (retryDelaysMs: [] — a malformed plan is retried on the default
    // schedule since planner-fix round 2; this test's subject is key
    // leakage, not retry timing.)
    const badJson = (async () =>
      ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) }) as Response) as typeof fetch;
    const backend3 = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: () => vault.retrieve(ref, 'alice'),
      fetchImpl: badJson,
      retryDelaysMs: [],
    });
    await expect(backend3.plan(input('hello'))).rejects.not.toThrow(SECRET);

    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(errs.join('\n')).not.toContain(SECRET);
  });

  it('plan() with no key fails closed without exposing anything', async () => {
    const { fetchImpl, seen } = fakeChatCompletions({ message: 'ok', actions: [{ type: 'done' }] });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => '',
      fetchImpl,
    });
    await expect(backend.plan(input('hello'))).rejects.toThrow(/no API key/);
    expect(seen).toHaveLength(0); // no request went out
  });
});

describe('AgentConfigStore', () => {
  it('round-trips per-user settings and persists across instances', () => {
    const persistence = memoryPersistence();
    const store = new AgentConfigStore(persistence);
    expect(store.get('alice')).toEqual(defaultAgentSettings());

    store.save('alice', {
      model: { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-x', keyRef: modelKeyRef('alice') },
    });
    const again = new AgentConfigStore(persistence);
    expect(again.get('alice').model).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-x',
    });
    // Other users are unaffected.
    expect(again.get('bob')).toEqual(defaultAgentSettings());
  });

  it('describe() reports hasKey but never the key', () => {
    const store = new AgentConfigStore(memoryPersistence());
    store.save('alice', {
      model: { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', keyRef: modelKeyRef('alice') },
    });
    const described = store.describe('alice');
    expect(described).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      hasKey: true,
    });
    expect(JSON.stringify(described)).not.toContain(SECRET);
    // Persisted bytes contain only the ref, never the secret.
    expect(JSON.stringify(store.get('alice'))).not.toContain(SECRET);
  });

  it('falls back to the default on corrupt persisted data', () => {
    const persistence = memoryPersistence();
    persistence.save('icecream-sheets.agent.config.v1', 'not json{{{');
    const store = new AgentConfigStore(persistence);
    expect(store.get('alice')).toEqual(defaultAgentSettings());
  });
});

describe('OpenAI planner prompt contract (D1/D2)', () => {
  it('system prompt carries the exact MCP argument schema for every allowed tool', () => {
    // read_cells {sheet, startRow, startCol, endRow, endCol}
    expect(SYSTEM_PROMPT).toContain('read_cells');
    for (const f of ['"sheet"', '"startRow"', '"startCol"', '"endRow"', '"endCol"']) {
      expect(SYSTEM_PROMPT).toContain(f);
    }
    // write_cells {cells: [{sheet, row, col, value}]} — an ARRAY, not a dict
    expect(SYSTEM_PROMPT).toContain('write_cells');
    expect(SYSTEM_PROMPT).toContain('"cells": [{');
    for (const f of ['"row"', '"col"', '"value"']) {
      expect(SYSTEM_PROMPT).toContain(f);
    }
    expect(SYSTEM_PROMPT).toMatch(/never an object\/dictionary keyed by cell address/);
    // set_formulas {formulas: [{sheet, row, col, formula}]}
    expect(SYSTEM_PROMPT).toContain('set_formulas');
    expect(SYSTEM_PROMPT).toContain('"formulas": [{');
    expect(SYSTEM_PROMPT).toContain('"formula"');
    // recalculate {}
    expect(SYSTEM_PROMPT).toContain('recalculate: {}');
    // analyze_data {intent, sheet?, startRow?, startCol?, endRow?, endCol?}
    expect(SYSTEM_PROMPT).toContain('analyze_data');
    expect(SYSTEM_PROMPT).toContain('"intent"');
    expect(SYSTEM_PROMPT).toMatch(/all-or-none/);
    // memory tools {key, value} / {key}
    for (const t of ['memory_save', 'memory_load', 'memory_update']) {
      expect(SYSTEM_PROMPT).toContain(t);
    }
    expect(SYSTEM_PROMPT).toContain('"key"');
    // HITL tools are named, with their schemas, but routed via ask actions
    for (const t of ['agent.ask_question', 'agent.offer_options', 'agent.request_approval']) {
      expect(SYSTEM_PROMPT).toContain(t);
    }
    expect(SYSTEM_PROMPT).toContain('"question"');
    expect(SYSTEM_PROMPT).toContain('"options"');
    expect(SYSTEM_PROMPT).toContain('"action"');
    expect(SYSTEM_PROMPT).toContain('"detail"');
  });

  it('system prompt states 0-based indexing, value typing, and the invented-shape bans', () => {
    expect(SYSTEM_PROMPT).toMatch(/0-based/);
    expect(SYSTEM_PROMPT).toContain('A1 is row 0, col 0');
    expect(SYSTEM_PROMPT).toMatch(/JSON numbers/);
    expect(SYSTEM_PROMPT).toContain('starting with "="');
    // The shapes Gemini invented live (probe D1) are explicitly banned.
    for (const banned of ['"sheet_name"', '"cell_range"']) {
      expect(SYSTEM_PROMPT).toContain(banned);
    }
  });

  it('system prompt fixes the done contract and grounds tool args in a worked example', () => {
    expect(SYSTEM_PROMPT).not.toContain('End every plan with');
    expect(SYSTEM_PROMPT).toContain('do NOT include a {"type": "done"}');
    expect(SYSTEM_PROMPT).toMatch(/SOLE action/);
    // Worked example grounds exact args (the chart example; the sum/CSV
    // examples were removed to fund the web-research scope in budget).
    expect(SYSTEM_PROMPT).toContain('add a column chart of this to the sheet titled Monthly Sales');
    expect(SYSTEM_PROMPT).toContain('"range": "A1:B5"');
    expect(SYSTEM_PROMPT).toContain('"title": "Monthly Sales"');
  });

  it('the prompt actually sent to the provider is the contract prompt', async () => {
    const { fetchImpl, seen } = fakeChatCompletions({ message: 'ok', actions: [{ type: 'done' }] });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => 'k',
      fetchImpl,
    });
    await backend.plan(input('hello'));
    const body = seen[0]!.body as { messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toBe(SYSTEM_PROMPT);
    expect(system).toContain('"startRow"');
    expect(system).toContain('"formulas": [{');
  });

  it('failed tool results reach the next planner call with their real error text (D1b)', async () => {
    const { fetchImpl, seen } = fakeChatCompletions({ message: 'ok', actions: [{ type: 'done' }] });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => 'k',
      fetchImpl,
    });
    const errorText = 'MCP error -32602: Invalid arguments for tool read_cells: "sheet" is required';
    await backend.plan({
      userText: 'sum of A1:A3',
      history: [],
      iteration: 2,
      toolResults: [
        { tool: 'read_cells', ok: false, summary: `read_cells failed: ${errorText}`, data: { text: errorText } },
      ],
    });
    const body = seen[0]!.body as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('read_cells FAILED');
    expect(user).toContain(errorText);
    expect(user).not.toContain('failed: undefined');
  });
});

describe('system prompt size budget (Groq 8K TPM trim)', () => {
  it('system prompt stays within its chars cap so a first turn fits the token window', () => {
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(SYSTEM_PROMPT_MAX_CHARS);
  });
  it('estimated first-turn tokens stay well under 8,000 (chars/4 + overhead)', () => {
    // First turn ~= system prompt + user text + tool names + sheet names + overhead.
    // Budget 500 tokens of overhead on top of the prompt; the cap keeps the total
    // near ~6,100 tokens, leaving ~1,900 tokens of headroom for history and output.
    const estimatedFirstTurnTokens = Math.ceil(SYSTEM_PROMPT.length / 4) + 500;
    expect(estimatedFirstTurnTokens).toBeLessThan(7000);
  });
});

describe('create_chart planner support (FIX-G2)', () => {
  // The prompt's worked-example arguments: data A1:B5, "add a column chart
  // of this to the sheet titled Monthly Sales".
  const exampleArgs = { sheet: 'Sheet1', range: 'A1:B5', kind: 'column', title: 'Monthly Sales' };

  it('validatePlan accepts a create_chart plan with the prompt example arguments', () => {
    const out = validatePlan(
      {
        message: "Adding a column chart of A1:B5 titled 'Monthly Sales' to Sheet1.",
        actions: [{ type: 'tool', tool: 'create_chart', args: exampleArgs, rationale: 'user asked to add a chart to the sheet' }],
      },
      new Set(['create_chart']),
    );
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'create_chart', args: exampleArgs });
  });

  it('planner with default allowlist accepts a create_chart plan (create_chart is in DEFAULT_ALLOWED_TOOLS)', async () => {
    const { fetchImpl, seen } = fakeChatCompletions({
      message: "Adding a column chart of A1:B5 titled 'Monthly Sales' to Sheet1.",
      actions: [{ type: 'tool', tool: 'create_chart', args: exampleArgs, rationale: 'user asked to add a chart to the sheet' }],
    });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => 'k',
      fetchImpl,
    });
    const out = await backend.plan(input('add a column chart of this to the sheet titled Monthly Sales'));
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'create_chart', args: exampleArgs });
    // The provider was offered create_chart among the available tools.
    const body = seen[0]!.body as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('create_chart');
  });

  it('system prompt carries the exact create_chart schema, return contract, and chart-route disambiguation', () => {
    // Exact schema: A1 range incl. header row, numeric data + text category, kind union, anchor default.
    expect(SYSTEM_PROMPT).toContain('create_chart');
    expect(SYSTEM_PROMPT).toContain('"range"');
    expect(SYSTEM_PROMPT).toContain('A1:C10');
    expect(SYSTEM_PROMPT).toMatch(/INCLUDES the header row/);
    expect(SYSTEM_PROMPT).toContain('numeric data columns');
    expect(SYSTEM_PROMPT).toContain('text category column');
    for (const kind of ['"column"', '"bar"', '"line"', '"area"', '"pie"', '"doughnut"']) {
      expect(SYSTEM_PROMPT).toContain(kind);
    }
    expect(SYSTEM_PROMPT).toContain('"anchor"');
    expect(SYSTEM_PROMPT).toContain('below the data');
    // Return contract: no follow-up / no redraw; reply states chart added with title/kind/range.
    expect(SYSTEM_PROMPT).toMatch(/NO follow-up tool call/);
    expect(SYSTEM_PROMPT).toMatch(/NO execute_code\/analyze_data redraw/);
    expect(SYSTEM_PROMPT).toMatch(/chart was added to the sheet/);
    // Two routes, explicitly distinguished.
    expect(SYSTEM_PROMPT).toMatch(/ephemeral chart shown in the CHAT reply only/);
    expect(SYSTEM_PROMPT).toMatch(/NATIVE chart placed IN the sheet \(persists, saves with the file\)/);
    expect(SYSTEM_PROMPT).toContain('chart in the sheet');
    expect(SYSTEM_PROMPT).toContain('add a chart to the sheet');
    expect(SYSTEM_PROMPT).toContain('insert chart');
    expect(SYSTEM_PROMPT).toContain('chart / plot / graph / visualize');
    // Ambiguous placement -> ask instead of guessing.
    expect(SYSTEM_PROMPT).toMatch(/sheet placement is ambiguous/);
    expect(SYSTEM_PROMPT).toMatch(/ASK the user which they want instead of guessing/);
    // Worked example with the exact example arguments.
    expect(SYSTEM_PROMPT).toContain('add a column chart of this to the sheet titled Monthly Sales');
    expect(SYSTEM_PROMPT).toContain('"range": "A1:B5"');
    expect(SYSTEM_PROMPT).toContain('"kind": "column"');
    expect(SYSTEM_PROMPT).toContain('"title": "Monthly Sales"');
  });
});

describe('open_data_source planner support (case-7 fix)', () => {
  // The prompt's worked-example arguments: the exact repro request from
  // the agent validation program (case 7) that previously never reached
  // the tool — the planner contract hid open_data_source entirely.
  const exampleArgs = {
    kind: 'csv-url',
    params: { url: 'http://example.com/sales.csv' },
    sheetName: 'Sales CSV',
  };

  it('validatePlan accepts an open_data_source plan with the prompt example arguments', () => {
    const out = validatePlan(
      {
        message: "Opening the CSV as a new sheet named 'Sales CSV'.",
        actions: [{ type: 'tool', tool: 'open_data_source', args: exampleArgs, rationale: 'user asked to open the CSV data source' }],
      },
      new Set(['open_data_source']),
    );
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'open_data_source', args: exampleArgs });
  });

  it('planner with default allowlist accepts an open_data_source plan (open_data_source is in DEFAULT_ALLOWED_TOOLS)', async () => {
    const { fetchImpl, seen } = fakeChatCompletions({
      message: "Opening the CSV as a new sheet named 'Sales CSV'.",
      actions: [{ type: 'tool', tool: 'open_data_source', args: exampleArgs, rationale: 'user asked to open the CSV data source' }],
    });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => 'k',
      fetchImpl,
    });
    const out = await backend.plan(input("Open the CSV data source at http://example.com/sales.csv and materialize it as a new sheet named 'Sales CSV'."));
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'open_data_source', args: exampleArgs });
    // The provider was offered the data-source tools among the available tools.
    const body = seen[0]!.body as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('open_data_source');
    expect(user).toContain('list_data_sources');
    expect(user).toContain('refresh_data_source');
  });

  it('system prompt carries the exact open_data_source schema and the data-source route', () => {
    expect(SYSTEM_PROMPT).toContain('open_data_source');
    // Kind union mirrors the MCP zod enum exactly.
    for (const kind of ['"csv-url"', '"json-url"', '"rest-api"', '"sql"', '"google-sheets"']) {
      expect(SYSTEM_PROMPT).toContain(kind);
    }
    // csv-url params mirror the connector's param contract.
    expect(SYSTEM_PROMPT).toContain('"url"');
    expect(SYSTEM_PROMPT).toContain('materializes it as a NEW sheet');
    expect(SYSTEM_PROMPT).toContain('"sheetName"');
    expect(SYSTEM_PROMPT).toContain('"credentialRef"');
    // One call does fetch + materialize; no invented split steps.
    expect(SYSTEM_PROMPT).toMatch(/ONE call/);
    expect(SYSTEM_PROMPT).toMatch(/no "open_csv" or "materialize" tool/);
    // The route: never decline, never tell the user to import it first,
    // never request approval for it.
    expect(SYSTEM_PROMPT).toMatch(/DATA SOURCE ROUTE/);
    expect(SYSTEM_PROMPT).toMatch(/Do NOT decline it/);
    expect(SYSTEM_PROMPT).toMatch(/import the file themselves first/);
    expect(SYSTEM_PROMPT).toMatch(/never put a secret value in params/);
    // The CSV worked example was removed to fund the web-research scope
    // in the prompt budget; the route + schema above carry the contract.
    expect(SYSTEM_PROMPT).toMatch(/DATA SOURCE ROUTE \(explicit\)/);
  });
});

describe('memory protocol prompt block (FIX-K)', () => {
  it('system prompt carries the save/recall protocol with the index convention', () => {
    expect(SYSTEM_PROMPT).toContain('MEMORY PROTOCOL');
    expect(SYSTEM_PROMPT).toContain('user_memory_index');
    // Recall must be instructed BEFORE answering/asking the user.
    expect(SYSTEM_PROMPT).toContain('RECALL COMES FIRST');
    expect(SYSTEM_PROMPT).toMatch(/Do NOT ask the user which sheet/);
    // Saving maintains the index so a NEW conversation can find facts.
    expect(SYSTEM_PROMPT).toMatch(/when you save a NEW key/i);
    // Never fabricate a remembered fact.
    expect(SYSTEM_PROMPT).toMatch(/never invent a remembered fact/);
    // A successful recall is answered directly — no ask/options detour.
    expect(SYSTEM_PROMPT).toMatch(/ANSWER with it directly/);
    // The ask-the-user-for-the-asked-fact anti-pattern is named + banned.
    expect(SYSTEM_PROMPT).toMatch(/NEVER ask the user for a fact they just asked YOU about/);
  });
});

describe('three-source scope prompt block (FIX-J + web research)', () => {
  it('system prompt states the THREE-SOURCE SCOPE rule near the top, after the role framing', () => {
    expect(SYSTEM_PROMPT).toContain('THREE-SOURCE SCOPE');
    expect(SYSTEM_PROMPT).not.toContain('TWO-SOURCE SCOPE');
    // Near the top: the block precedes the tool argument schemas.
    expect(SYSTEM_PROMPT.indexOf('THREE-SOURCE SCOPE')).toBeLessThan(
      SYSTEM_PROMPT.indexOf('TOOL ARGUMENT SCHEMAS'),
    );
    // Source (1): data reachable through tools in this session.
    expect(SYSTEM_PROMPT).toMatch(/answer ONLY from three sources/);
    expect(SYSTEM_PROMPT).toContain('through your tools in this session');
    expect(SYSTEM_PROMPT).toContain('connected data sources');
    expect(SYSTEM_PROMPT).toContain("this conversation's earlier tool results");
    // Source (2): icecream-sheets product knowledge.
    expect(SYSTEM_PROMPT).toContain('Icecream Sheets product knowledge');
    expect(SYSTEM_PROMPT).toContain('how this product works, its features, and its spreadsheet functions');
    // Source (3): public web data when the sheet lacks external facts.
    expect(SYSTEM_PROMPT).toContain('search_web');
    expect(SYSTEM_PROMPT).toContain('fetch_web_page');
    expect(SYSTEM_PROMPT).toMatch(/cite source URLs/);
    expect(SYSTEM_PROMPT).toMatch(/never fabricate/);
    // Everything else is declined, NEVER answered from general knowledge.
    expect(SYSTEM_PROMPT).toMatch(/NEVER answered from general knowledge/);
    expect(SYSTEM_PROMPT).toContain('chit-chat');
    expect(SYSTEM_PROMPT).toMatch(/politely declines and redirects/);
    // Product questions are answered directly, no tool calls.
    expect(SYSTEM_PROMPT).toMatch(/Product questions are answered directly/);
    expect(SYSTEM_PROMPT).toContain('involves no user data');
    expect(SYSTEM_PROMPT).toContain('with NO tool calls');
  });
});

describe('provider retry (FIX-R4)', () => {
  /** Fetch that walks a scripted sequence of statuses, then succeeds. */
  function sequencedFetch(statuses: number[]) {
    let calls = 0;
    const fetchImpl = (async () => {
      const status = statuses[Math.min(calls, statuses.length - 1)]!;
      calls++;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify({ message: 'ok', actions: [{ type: 'done' }] }) } },
          ],
        }),
        text: async () => 'provider says no',
      } as Response;
    }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  function backendWith(fetchImpl: typeof fetch, retryDelaysMs: number[]) {
    return new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => 'sk-test',
      fetchImpl,
      retryDelaysMs,
    });
  }

  it('retries a 429 and succeeds when the provider recovers', async () => {
    const seq = sequencedFetch([429, 429, 200]);
    const out = await backendWith(seq.fetchImpl, [1, 1]).plan(input('hello'));
    expect(out.message).toBe('ok');
    expect(seq.calls()).toBe(3);
  });

  it('retries a 5xx and a transport failure', async () => {
    const seq = sequencedFetch([503, 200]);
    const out = await backendWith(seq.fetchImpl, [1]).plan(input('hello'));
    expect(out.message).toBe('ok');
    expect(seq.calls()).toBe(2);

    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) throw new Error('socket hangup');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify({ message: 'ok', actions: [{ type: 'done' }] }) } },
          ],
        }),
        text: async () => '',
      } as Response;
    }) as typeof fetch;
    const out2 = await backendWith(flaky, [1]).plan(input('hello'));
    expect(out2.message).toBe('ok');
    expect(n).toBe(2);
  });

  it('gives up after the configured retries on a persistent 429', async () => {
    const seq = sequencedFetch([429]);
    await expect(backendWith(seq.fetchImpl, [1, 1]).plan(input('hello'))).rejects.toThrow(
      /provider returned 429/,
    );
    expect(seq.calls()).toBe(3); // initial + 2 retries
  });

  it('does not retry a client error (400)', async () => {
    const seq = sequencedFetch([400, 200]);
    await expect(backendWith(seq.fetchImpl, [1, 1]).plan(input('hello'))).rejects.toThrow(
      /provider returned 400/,
    );
    expect(seq.calls()).toBe(1);
  });
});

describe('planner-fix round 2: malformed-plan retry', () => {
  function backendWith(fetchImpl: typeof fetch, retryDelaysMs: number[]) {
    return new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => 'sk-test',
      fetchImpl,
      retryDelaysMs,
    });
  }

  it('retries a 200 with a truncated (non-JSON) plan and succeeds on a later sample', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const content =
        calls === 1
          ? '{"message": "Adding per-row formulas", "actions": [{"type": "tool", "tool": "set_fo'
          : JSON.stringify({ message: 'ok', actions: [{ type: 'done' }] });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => '',
      } as Response;
    }) as typeof fetch;
    const out = await backendWith(fetchImpl, [1]).plan(input('hello'));
    expect(out.message).toBe('ok');
    expect(calls).toBe(2);
  });

  it('still throws after the configured retries on a persistently malformed plan', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
        text: async () => '',
      } as Response;
    }) as typeof fetch;
    await expect(backendWith(fetchImpl, [1, 1]).plan(input('hello'))).rejects.toThrow(
      /non-JSON plan/,
    );
    expect(calls).toBe(3);
  });

  it('carries a bounded prefix of the unparseable completion in the error (case-5 observability)', async () => {
    const tail = 'y'.repeat(220) + 'TAILMARKER' + 'x'.repeat(200);
    const content = `garbage opening that is not a plan ${tail}`;
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => '',
      }) as Response) as typeof fetch;
    const err = await backendWith(fetchImpl, [1])
      .plan(input('hello'))
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('non-JSON plan');
    expect(err.message).toContain('completion prefix:');
    expect(err.message).toContain('garbage opening that is not a plan');
    // The prefix is bounded: the tail beyond 200 chars never leaks.
    expect(err.message).not.toContain('TAILMARKER');
    expect(err.message.length).toBeLessThan(340);
  });
});

describe('planner-fix (2026-10-22): write-location discipline', () => {
  it('system prompt requires locating a content-addressed write target before writing', () => {
    expect(SYSTEM_PROMPT).toContain('WRITES ADDRESSED BY CONTENT');
    expect(SYSTEM_PROMPT).toContain('an unlocated write is a wrong answer');
    expect(SYSTEM_PROMPT).toContain('writtenRowContext');
    expect(SYSTEM_PROMPT).toContain('PER-ROW RESULTS');
  });
});
