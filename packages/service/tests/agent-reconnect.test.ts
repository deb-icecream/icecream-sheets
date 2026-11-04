/**
 * #150 (second defect): AgentRuntime.ensureConnected() must never return
 * a dead client.
 *
 * ensureConnected() caches its connection attempt in connectPromise and
 * only resets it when the attempt FAILS. close() nulls this.client but
 * leaves connectPromise holding the resolved (now closed) client — so
 * every later callTool reuses the dead client and throws the MCP SDK's
 * exact `Not connected`, forever, with no recovery. That is why the
 * wave-3 leg5 turn never recovered within the turn: the observer poll
 * closed its runtime, and the runtime could not reconnect.
 *
 * Post-fix, close() invalidates connectPromise too, so the next
 * callTool reconnects (new transport pair, same MCP server) and works.
 */
import { describe, expect, it } from 'vitest';
import { createServer } from '@icecream-sheets/mcp-server';
import { AgentRuntime } from '../src/agent/runtime.js';

describe('AgentRuntime reconnect after close() (#150)', () => {
  it('callTool works again after close()', async () => {
    const server = createServer();
    const rt = new AgentRuntime({ server, principal: 'test-user' });
    const first = (await rt.callTool('agent.list_pending', {})) as { asks?: unknown };
    expect(Array.isArray(first.asks)).toBe(true);
    await rt.close();
    // Pre-fix this throws Error('Not connected') — the prod signature.
    const second = (await rt.callTool('agent.list_pending', {})) as { asks?: unknown };
    expect(Array.isArray(second.asks)).toBe(true);
    await rt.close();
  });
});
