/**
 * #137: the LLM tool-call loop. Every agent turn goes to the model
 * backend; the backend plans tool calls; the runtime executes them.
 * No heuristic parsing anywhere on the request path; no model means
 * a clear error, never a guessed write.
 *
 * The stub backends below ARE the loop's proof: prompt in, tool-call
 * JSON out (as PlannerOutput actions), tool executed by the runtime.
 * The B2 case is the exact symptom that exposed the defect — the old
 * parser wrote "Debajyoti Saikia on cell" for "put Debajyoti Saikia
 * on cell B2". The loop cannot mangle: no parser runs, the tool call
 * carries the exact value, and the engine stores exactly that.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '@icecream-sheets/mcp-server';
import { EngineHost } from '@icecream-sheets/engine';
import { AgentRuntime } from '../src/agent/runtime.js';
import {
  NO_MODEL_CONFIGURED_MESSAGE,
  NoModelConfiguredBackend,
  NoModelConfiguredError,
} from '../src/agent/backends.js';
import {
  createEnvModelBackend,
  createModelBackend,
  defaultAgentSettings,
  modelKeyRef,
} from '../src/agent/config.js';
import { createEnvCodeGenBackend, OpenAiCompatibleCodeGenBackend } from '../src/artifacts/llm.js';
import { CredentialVault } from '../src/vault.js';
import { KeyManager } from '../src/crypto.js';
import { memoryPersistence } from '../src/metadataStore.js';
import type { ModelBackend, PlannerInput, PlannerOutput } from '../src/agent/types.js';

async function testVault(): Promise<CredentialVault> {
  const vault = await CredentialVault.create(memoryPersistence(), new KeyManager(), {
    check: () => true,
  });
  await vault.store(modelKeyRef('alice'), '<redacted>', 'alice');
  return vault;
}

function makeRuntime(opts: { backend?: ModelBackend } = {}) {
  const host = new EngineHost();
  const server: McpServer = createServer(host);
  const runtime = new AgentRuntime({ server, principal: 'test-user', ...opts });
  return { host, server, runtime };
}

function seed(host: EngineHost, sheet: string, row: number, col: number, value: unknown) {
  host.execute({ cmd: 'setCell', ref: { sheet, row, col }, value });
}

function readCell(host: EngineHost, sheet: string, row: number, col: number): unknown {
  // EngineHost.readRange returns TypedValue objects ({ kind, value }).
  const cell = host.readRange({ sheet, startRow: row, startCol: col, endRow: row, endCol: col })[0]![0] as unknown;
  if (cell && typeof cell === 'object' && 'value' in (cell as Record<string, unknown>)) {
    return (cell as { value: unknown }).value;
  }
  return cell;
}

/** Sum the numbers in a read_cells result matrix ({ cells: unknown[][] }). */
function sumMatrix(data: unknown): number {
  const matrix = (data as { cells?: unknown[][] } | null)?.cells;
  if (!Array.isArray(matrix)) return NaN;
  let sum = 0;
  for (const row of matrix) {
    for (const cell of row) {
      if (typeof cell === 'number') sum += cell;
    }
  }
  return sum;
}

/**
 * Stub LLM for the sum loop: first plan reads A1:A3, second plan sums
 * the tool result and finishes. The sum is computed from the tool
 * result, never hardcoded — the reply value proves the tool ran.
 */
function makeSumStub(): { backend: ModelBackend; inputs: PlannerInput[] } {
  const inputs: PlannerInput[] = [];
  const backend: ModelBackend = {
    name: 'stub-sum',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      inputs.push(input);
      if (input.toolResults.length === 0) {
        return {
          message: '',
          actions: [
            {
              type: 'tool',
              tool: 'read_cells',
              args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
            },
          ],
        };
      }
      const sum = sumMatrix(input.toolResults[0]!.data);
      return { message: `The sum is ${sum}.`, actions: [{ type: 'done' }] };
    },
  };
  return { backend, inputs };
}

/**
 * Stub LLM for the B2 write: iteration 1 plans one write_cells tool
 * call with the EXACT value; iteration 2 finishes (the loop ends only
 * on a tool-free plan, so a write+done single plan would re-execute).
 * The old parser turned this prompt into "Debajyoti Saikia on cell";
 * the loop stores exactly what the tool call carries.
 */
function makeWriteStub(): ModelBackend {
  return {
    name: 'stub-write',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.iteration > 1) {
        return { message: 'Done.', actions: [{ type: 'done' }] };
      }
      return {
        message: '',
        actions: [
          {
            type: 'tool',
            tool: 'write_cells',
            args: {
              cells: [{ sheet: 'Sheet1', row: 1, col: 1, value: 'Debajyoti Saikia' }],
            },
          },
        ],
      };
    },
  };
}

/** Stub LLM for a single-cell read: reads A1, echoes its value. */
function makeReadStub(): ModelBackend {
  return {
    name: 'stub-read',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      if (input.toolResults.length === 0) {
        return {
          message: '',
          actions: [
            {
              type: 'tool',
              tool: 'read_cells',
              args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
            },
          ],
        };
      }
      const matrix = (input.toolResults[0]!.data as { cells?: unknown[][] } | null)?.cells;
      const value = Array.isArray(matrix) ? matrix[0]![0] : undefined;
      return { message: `A1: ${value}`, actions: [{ type: 'done' }] };
    },
  };
}

/** Stub LLM that only records planner inputs, then finishes. */
function makeRecordingStub(): { backend: ModelBackend; inputs: PlannerInput[] } {
  const inputs: PlannerInput[] = [];
  const backend: ModelBackend = {
    name: 'stub-record',
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      inputs.push(input);
      return { message: 'done', actions: [{ type: 'done' }] };
    },
  };
  return { backend, inputs };
}

/** Fake OpenAI-compatible chat-completions endpoint: returns the plan JSON in content. */
function fakeChatCompletions(planJson: unknown) {
  const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(planJson) } }],
      }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const SAVED_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ['AGENT_MODEL_BASE_URL', 'AGENT_MODEL_API_KEY', 'AGENT_MODEL_ID']) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

describe('LLM tool-call loop (stubbed model)', () => {
  it('executes a stub-planned write exactly — the B2 anti-mangle case', async () => {
    const { host, runtime } = makeRuntime({ backend: makeWriteStub() });
    try {
      const reply = await runtime.chat('t1', 'put Debajyoti Saikia on cell B2');
      expect(reply.message).not.toContain('on cell');
      expect(readCell(host, 'Sheet1', 1, 1)).toBe('Debajyoti Saikia');
      const tools = reply.actionsTaken.filter((e) => e.kind === 'tool_call').map((e) => e.tool);
      expect(tools).toContain('write_cells');
    } finally {
      await runtime.close();
    }
  });

  it('reads through the loop: the reply value comes from the tool result', async () => {
    const { host, runtime } = makeRuntime({ backend: makeReadStub() });
    try {
      seed(host, 'Sheet1', 0, 0, 42);
      const reply = await runtime.chat('t1', 'what is on cell A1?');
      expect(reply.message).toBe('A1: 42');
    } finally {
      await runtime.close();
    }
  });

  it('sums through the loop: prompt in, tool call out, tool executed', async () => {
    const { backend, inputs } = makeSumStub();
    const { host, runtime } = makeRuntime({ backend });
    try {
      seed(host, 'Sheet1', 0, 0, 10);
      seed(host, 'Sheet1', 1, 0, 20);
      seed(host, 'Sheet1', 2, 0, 30);
      const reply = await runtime.chat('t1', 'sum of A1:A3');
      expect(reply.message).toBe('The sum is 60.');
      expect(inputs).toHaveLength(2);
      expect(inputs[1]!.toolResults).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
});

describe('no model configured', () => {
  it('a runtime with no backend fails clearly and writes nothing', async () => {
    const { host, runtime } = makeRuntime();
    try {
      seed(host, 'Sheet1', 0, 0, 7);
      const reply = await runtime.chat('t1', 'put 10 on cell A1');
      expect(reply.message).toMatch(/no model configured/i);
      expect(reply.message).toBe(NO_MODEL_CONFIGURED_MESSAGE);
      expect(readCell(host, 'Sheet1', 0, 0)).toBe(7);
      // actionsTaken is the turn audit (messages included); the claim
      // is zero TOOL calls — nothing executed.
      expect(reply.actionsTaken.filter((e) => e.kind === 'tool_call')).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('NoModelConfiguredBackend plan() throws the clear error', async () => {
    const backend = new NoModelConfiguredBackend();
    expect(backend.name).toBe('no-model');
    await expect(backend.plan({ userText: 'x', history: [], toolResults: [], iteration: 1 })).rejects.toBeInstanceOf(
      NoModelConfiguredError,
    );
    await expect(backend.plan({ userText: 'x', history: [], toolResults: [], iteration: 1 })).rejects.toThrow(
      /no model configured/i,
    );
  });

  it('the Vertex default resolves to the no-model backend service-side', async () => {
    const vault = await testVault();
    expect(defaultAgentSettings().model.provider).toBe('vertex');
    const backend = createModelBackend({ config: defaultAgentSettings(), vault, principal: 'alice' });
    expect(backend).toBeInstanceOf(NoModelConfiguredBackend);
    await expect(backend.plan({ userText: 'x', history: [], toolResults: [], iteration: 1 })).rejects.toThrow(
      /no model configured/i,
    );
  });
});

describe('environment-configured model backend', () => {
  it('returns null when no model env is set', () => {
    delete process.env.AGENT_MODEL_BASE_URL;
    delete process.env.AGENT_MODEL_API_KEY;
    delete process.env.AGENT_MODEL_ID;
    expect(createEnvModelBackend()).toBeNull();
    expect(createEnvCodeGenBackend()).toBeNull();
  });

  it('plans a tool call through a stubbed OpenAI-compatible endpoint', async () => {
    // The backend's contract is a JSON PLAN OBJECT in message content
    // (response_format json_object) — not OpenAI tool_calls.
    const planJson = {
      message: '',
      actions: [
        {
          type: 'tool',
          tool: 'read_cells',
          args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        },
      ],
    };
    const { fetchImpl, seen } = fakeChatCompletions(planJson);
    process.env.AGENT_MODEL_BASE_URL = 'https://groq.test/openai/v1';
    process.env.AGENT_MODEL_API_KEY = 'dummy-test-key';
    process.env.AGENT_MODEL_ID = 'test-model';
    const backend = createEnvModelBackend({ fetchImpl });
    expect(backend).not.toBeNull();
    const out = await backend!.plan({ userText: 'what is on A1?', history: [], toolResults: [], iteration: 1 });
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'read_cells' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://groq.test/openai/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBe('Bearer dummy-test-key');
    expect((seen[0]!.body as { model: string }).model).toBe('test-model');
  });

  it('generates code through a stubbed OpenAI-compatible endpoint', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '```js\nfunction App() { return null; }\n```' } }],
      }),
      text: async () => '',
    })) as typeof fetch;
    const backend = new OpenAiCompatibleCodeGenBackend({
      baseUrl: 'https://groq.test/openai/v1',
      model: 'test-model',
      getApiKey: async () => 'dummy-test-key',
      fetchImpl,
    });
    const code = await backend.generateCode('build an app');
    expect(code).toContain('function App()');
    process.env.AGENT_MODEL_BASE_URL = 'https://groq.test/openai/v1';
    process.env.AGENT_MODEL_API_KEY = 'dummy-test-key';
    process.env.AGENT_MODEL_ID = 'test-model';
    expect(createEnvCodeGenBackend({ fetchImpl })).not.toBeNull();
  });
});

describe('#135 sheet-context regression in the new loop', () => {
  it('the client-passed active sheet rides in the planner input', async () => {
    const { backend, inputs } = makeRecordingStub();
    const { host, runtime } = makeRuntime({ backend });
    try {
      seed(host, 'Sheet1', 0, 0, 1);
      await runtime.chat('t1', 'what is on this sheet?', { sheet: 'FMTs' });
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.sheetContext?.activeSheet).toBe('FMTs');
      expect(inputs[0]!.sheetContext?.sheets).toContain('Sheet1');
    } finally {
      await runtime.close();
    }
  });
});

describe('#137 token streaming', () => {
  function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(chunks[i]!));
        i++;
      },
    });
  }
  function sseBlock(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  }

  it('streams the message field progressively, split escapes included', async () => {
    // Delta content splits: a partial key, a partial string, an
    // escape split across chunks (backslash at a chunk boundary),
    // then the closing actions.
    const deltas = ['{"mess', 'age": "Hel', 'lo,\\', 'nworld!', '", "actions": [{"type": "done"}]}'];
    const fetchImpl = (async () =>
      new Response(sseStream(deltas.map(sseBlock)), {
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;
    process.env.AGENT_MODEL_BASE_URL = 'https://groq.test/openai/v1';
    process.env.AGENT_MODEL_API_KEY=<redacted>
    process.env.AGENT_MODEL_ID = 'test-model';
    const backend = createEnvModelBackend({ fetchImpl });
    expect(backend).not.toBeNull();
    const tokens: string[] = [];
    const out = await backend!.plan(
      { userText: 'say hello', history: [], toolResults: [], iteration: 1 },
      { onToken: (t) => tokens.push(t) },
    );
    expect(out.message).toBe('Hello,\nworld!');
    expect(tokens.join('')).toBe('Hello,\nworld!');
    expect(tokens.length).toBeGreaterThan(1); // progressive, not one blob
  });

  it('a failed stream falls back to the non-stream path without tokens', async () => {
    const planJson = { message: 'Fallback answer.', actions: [{ type: 'done' }] };
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { stream?: boolean }) : {};
      if (body.stream === true) {
        return { ok: false, status: 500, text: async () => 'boom' } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(planJson) } }] }),
        text: async () => '',
      } as Response;
    }) as typeof fetch;
    process.env.AGENT_MODEL_BASE_URL = 'https://groq.test/openai/v1';
    process.env.AGENT_MODEL_API_KEY=<redacted>
    process.env.AGENT_MODEL_ID = 'test-model';
    const backend = createEnvModelBackend({ fetchImpl });
    const tokens: string[] = [];
    const out = await backend!.plan(
      { userText: 'say hello', history: [], toolResults: [], iteration: 1 },
      { onToken: (t) => tokens.push(t) },
    );
    expect(out.message).toBe('Fallback answer.');
    expect(tokens).toHaveLength(0);
  });

  it('the runtime forwards streamed tokens as turn events', async () => {
    const backend: ModelBackend = {
      name: 'stub-streaming',
      async plan(
        _input: PlannerInput,
        opts?: { onToken?: (text: string) => void },
      ): Promise<PlannerOutput> {
        opts?.onToken?.('Hel');
        opts?.onToken?.('lo');
        return { message: 'Hello', actions: [{ type: 'done' }] };
      },
    };
    const { runtime } = makeRuntime({ backend });
    const events: { type: string; text?: string }[] = [];
    const reply = await runtime.chat('t-stream', 'say hello', {
      onEvent: (e) => events.push(e as { type: string; text?: string }),
    });
    expect(reply.message).toBe('Hello');
    const tokenTexts = events.filter((e) => e.type === 'token').map((e) => e.text ?? '');
    expect(tokenTexts.join('')).toBe('Hello');
  });
});
