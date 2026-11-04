/**
 * F-10, agent path: the agent runtime acts as its user, end to end.
 *
 * agentSvc builds the runtime's MCP server BOUND to the authenticated
 * caller (defaultPrincipal). The planner (model) emits tool arguments —
 * including, potentially, a `principal` argument naming someone else.
 * Two mechanisms keep that from widening the agent's authority:
 *   1. the runtime's stampUser funnel neutralizes a foreign principal
 *      argument to the runtime's own identity before the call;
 *   2. the bound MCP server refuses any mismatching argument.
 * This test pins the composed behavior: a planner action carrying
 * principal "mallory" still executes — as the runtime's user, NOT as
 * mallory and NOT refused — and returns real data.
 */
import { describe, expect, it } from 'vitest';
import { createServer } from '@icecream-sheets/mcp-server';
import { EngineHost } from '@icecream-sheets/engine';
import { AgentRuntime } from '../src/agent/runtime.js';
import type { ModelBackend, PlannerInput, PlannerOutput, ToolResultRecord } from '../src/agent/types.js';

class SpoofBackend implements ModelBackend {
  readonly name = 'spoof-fake';
  seenToolResults: ToolResultRecord[] = [];
  async plan(input: PlannerInput): Promise<PlannerOutput> {
    if (input.iteration === 1) {
      return {
        message: 'Reading the sheet.',
        actions: [
          {
            type: 'tool',
            tool: 'read_cells',
            args: {
              sheet: 'Sheet1',
              startRow: 0,
              startCol: 0,
              endRow: 0,
              endCol: 0,
              // The planner tries to act as someone else.
              principal: 'mallory',
            },
          },
        ],
      };
    }
    this.seenToolResults = input.toolResults;
    return { message: 'Done.', actions: [{ type: 'done' }] };
  }
}

describe('F-10: agent runtime principal binding', () => {
  it('a planner-emitted foreign principal is neutralized; the call runs as the runtime user', async () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 42 } as never);
    // Bound exactly the way agentSvc binds it.
    const server = createServer(host, { defaultPrincipal: 'agent-user' });
    const backend = new SpoofBackend();
    const runtime = new AgentRuntime({ server, backend, principal: 'agent-user' });
    try {
      const reply = await runtime.chat('t1', 'what is in A1?');
      expect(reply.message).toContain('Done');
      const read = backend.seenToolResults.find((r) => r.tool === 'read_cells');
      expect(read).toBeDefined();
      // NOT refused (a principal-mismatch refusal would surface as !ok)…
      expect(read!.ok).toBe(true);
      expect(read!.summary).not.toContain('principal mismatch');
      // …and it returned the real value, acting as the runtime's user.
      expect(JSON.stringify(read!.data)).toContain('42');
    } finally {
      await runtime.close();
    }
  });
});
