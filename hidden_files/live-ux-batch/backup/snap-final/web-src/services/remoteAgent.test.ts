/**
 * Tests for the gateway-backed agent backend (ai-agent.md §§6, 8):
 * proactive watch goes through the agent service's wake loop (no more
 * "not available" throw), model-config and mute methods hit the right
 * endpoints, and wakes flatten into event records for the chat UI.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GatewayClient } from './gatewayClient';
import { RemoteAgentBackend } from './remoteAgent';

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

let seen: Seen[];
let routes: Record<string, unknown>;

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

beforeEach(() => {
  seen = [];
  routes = {};
  vi.stubGlobal(
    'fetch',
    (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const path = u.replace('http://gw.test', '');
      seen.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`;
      if (key in routes) return jsonResponse(routes[key]);
      return jsonResponse({ error: 'no route' }, 404);
    }) as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function backend(): RemoteAgentBackend {
  return new RemoteAgentBackend(new GatewayClient('http://gw.test'));
}

describe('RemoteAgentBackend proactive watch', () => {
  it('watch() starts a server-side watch instead of throwing', async () => {
    routes['POST /api/agent/watch'] = { watchId: 'watch-1' };
    const b = backend();
    const watchId = await b.watch(['cells_changed', 'recalc_complete'], 'Sheet1');
    expect(watchId).toBe('watch-1');
    expect(seen[0]).toMatchObject({
      url: 'http://gw.test/api/agent/watch',
      method: 'POST',
      body: { events: ['cells_changed', 'recalc_complete'], sheet: 'Sheet1' },
    });
  });

  it('pollWatch() flattens wakes into event records, capped at maxEvents', async () => {
    routes['GET /api/agent/watch/poll'] = {
      wakes: [
        {
          watchId: 'watch-1',
          events: [
            { seq: 1, ts: 100, type: 'cells_changed', detail: { a: 1 } },
            { seq: 2, ts: 101, type: 'recalc_complete', detail: {} },
            { seq: 3, ts: 102, type: 'cells_changed', detail: { b: 2 } },
          ],
        },
      ],
    };
    const b = backend();
    const events = await b.pollWatch('watch-1', 2);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ seq: 1, type: 'cells_changed' });
    expect(seen[0]!.url).toBe('http://gw.test/api/agent/watch/poll?watchId=watch-1');
  });

  it('unwatch() stops the server-side watch', async () => {
    routes['POST /api/agent/watch/stop'] = { ok: true };
    const b = backend();
    await b.unwatch('watch-1');
    expect(seen[0]).toMatchObject({
      url: 'http://gw.test/api/agent/watch/stop',
      method: 'POST',
      body: { watchId: 'watch-1' },
    });
  });
});

describe('RemoteAgentBackend chart passthrough', () => {
  const chart = {
    title: 'Revenue by month',
    config: {
      type: 'bar',
      data: {
        labels: ['Jan', 'Feb'],
        datasets: [{ label: 'Revenue', data: [10, 20] }],
      },
      options: { responsive: false },
    },
  };

  it('chat() carries a gateway chart through to the reply unchanged', async () => {
    routes['POST /api/agent/message'] = {
      threadId: 't-chart',
      message: 'Revenue rose in February.',
      audit: [],
      chart,
    };
    const b = backend();
    const reply = await b.chat('t-chart', 'chart revenue by month');
    expect(reply.chart).toEqual(chart);
    expect(seen[0]).toMatchObject({
      url: 'http://gw.test/api/agent/message',
      method: 'POST',
      body: { text: 'chart revenue by month', kind: 'chat' },
    });
  });

  it('answer() (sharing send()) also carries a gateway chart through', async () => {
    routes['POST /api/agent/message'] = {
      threadId: 't-chart-answer',
      message: 'Here is the breakdown.',
      audit: [],
      chart,
    };
    const b = backend();
    const reply = await b.answer('t-chart-answer', 'yes, by month');
    expect(reply.chart).toEqual(chart);
  });

  it('a gateway chart:null leaves the reply with no chart', async () => {
    routes['POST /api/agent/message'] = {
      threadId: 't-no-chart',
      message: 'Done.',
      audit: [],
      chart: null,
    };
    const b = backend();
    const reply = await b.chat('t-no-chart', 'summarize this');
    expect(reply.chart).toBeUndefined();
    expect('chart' in reply).toBe(false);
  });
});

describe('RemoteAgentBackend model config + mute', () => {
  it('getModelConfig never sees a key; setModelConfig writes one', async () => {
    routes['GET /api/agent/config'] = { provider: 'heuristic', hasKey: false };
    routes['POST /api/agent/config'] = {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      hasKey: true,
    };
    const b = backend();
    const before = await b.getModelConfig!();
    expect(before.provider).toBe('heuristic');
    expect('apiKey' in before).toBe(false);

    const after = await b.setModelConfig!({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-user-key',
    });
    expect(after.hasKey).toBe(true);
    expect(JSON.stringify(after)).not.toContain('sk-user-key');
    expect(seen[1]).toMatchObject({
      url: 'http://gw.test/api/agent/config',
      method: 'POST',
      body: { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-user-key' },
    });
  });

  it('mute get/set round-trips through the agent service', async () => {
    routes['GET /api/agent/watch/mute'] = {
      mutedAll: false,
      muted: { cells_changed: false, recalc_complete: false, sheet_added: false, sheet_removed: false },
    };
    routes['POST /api/agent/watch/mute'] = {
      mutedAll: false,
      muted: { cells_changed: false, recalc_complete: true, sheet_added: false, sheet_removed: false },
    };
    const b = backend();
    const cfg = await b.getProactiveMute!();
    expect(cfg.mutedAll).toBe(false);
    const next = await b.setProactiveMute!({ muted: { recalc_complete: true } });
    expect(next.muted.recalc_complete).toBe(true);
    expect(seen[1]).toMatchObject({
      url: 'http://gw.test/api/agent/watch/mute',
      method: 'POST',
      body: { muted: { recalc_complete: true } },
    });
  });
});

describe('RemoteAgentBackend chatStream (#40)', () => {
  function sseResponse(chunks: string[]): Response {
    const enc = new TextEncoder();
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(enc.encode(chunks[i]));
          i += 1;
        } else {
          controller.close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('forwards turn events and resolves with the done payload', async () => {
    vi.stubGlobal(
      'fetch',
      (async (url: unknown) => {
        expect(String(url)).toContain('/api/agent/message/stream');
        return sseResponse([
          'event: turn\ndata: {"type":"thinking","iteration":1}\n\n',
          'event: turn\ndata: {"type":"tool","phase":"start","tool":"read_cells"}\n',
          '\nevent: turn\ndata: {"type":"tool","phase":"end","tool":"read_cells","ok":true}\n\n',
          'event: done\ndata: {"threadId":"t-9","message":"The total is 60.","audit":[],"chart":null}\n\n',
        ]);
      }) as typeof fetch,
    );
    const b = backend();
    const events: string[] = [];
    const reply = await b.chatStream('t-9', 'total?', (e) => {
      events.push(e.type === 'tool' ? `tool:${e.phase}` : e.type);
    });
    expect(events).toEqual(['thinking', 'tool:start', 'tool:end']);
    expect(reply.message).toBe('The total is 60.');
    expect(reply.threadId).toBe('t-9');
  });

  it('an error event rejects with the plain-language message', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        sseResponse([
          'event: error\ndata: {"message":"Something went wrong while the agent was working."}\n\n',
        ])) as typeof fetch,
    );
    const b = backend();
    await expect(b.chatStream('t-1', 'x', () => undefined)).rejects.toThrow(
      'Something went wrong while the agent was working.',
    );
  });

  it('a stream that ends without done rejects as cut off', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        sseResponse(['event: turn\ndata: {"type":"thinking","iteration":1}\n\n'])) as typeof fetch,
    );
    const b = backend();
    await expect(b.chatStream('t-1', 'x', () => undefined)).rejects.toThrow('cut off');
  });
});
