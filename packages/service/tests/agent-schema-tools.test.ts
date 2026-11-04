/**
 * Schema-first agent tools: planner-side wiring. The MCP handlers live in
 * packages/mcp-server (tests/schema-tools.test.ts); this file proves the
 * planner learns the new tools: allowlist membership, SYSTEM_PROMPT
 * schema entries mirroring the zod schemas, the schema-first workflow
 * note, and the prompt staying within its size budget.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_TOOLS,
  OpenAICompatibleBackend,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_MAX_CHARS,
  JOB_PLAN_SYSTEM_PROMPT,
} from '../src/agent/openaiBackend.js';
import type { PlannerInput } from '../src/agent/types.js';

function input(userText: string): PlannerInput {
  return { userText, history: [], toolResults: [], iteration: 1 };
}

function fakeChatCompletions(planJson: unknown) {
  const fetchImpl = (async (_url: unknown, _init?: RequestInit) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(planJson) } }] }),
      text: async () => 'provider says no',
    } as Response;
  }) as typeof fetch;
  return { fetchImpl };
}

describe('schema-first planner wiring', () => {
  it('default allowlist includes the three schema-first tools', () => {
    expect(DEFAULT_ALLOWED_TOOLS).toContain('describe_sheet');
    expect(DEFAULT_ALLOWED_TOOLS).toContain('find_label');
    expect(DEFAULT_ALLOWED_TOOLS).toContain('aggregate_cells');
  });

  it('SYSTEM_PROMPT teaches the new tool schemas', () => {
    expect(SYSTEM_PROMPT).toContain('describe_sheet');
    expect(SYSTEM_PROMPT).toContain('find_label');
    expect(SYSTEM_PROMPT).toContain('aggregate_cells');
    expect(SYSTEM_PROMPT).toContain('"op": "sum" | "avg" | "count" | "min" | "max"');
    expect(SYSTEM_PROMPT).toContain('SCHEMA FIRST');
    expect(SYSTEM_PROMPT).toContain('Call FIRST on any unmapped sheet');
    // The scratch-formula dance is gone: aggregates go through the tool.
    expect(SYSTEM_PROMPT).not.toContain('put the aggregate formula in an empty scratch cell');
  });

  it('SYSTEM_PROMPT stays within its size budget', () => {
    expect(SYSTEM_PROMPT_MAX_CHARS).toBe(22500);
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(SYSTEM_PROMPT_MAX_CHARS);
  });

  it('JOB_PLAN prompt orders schema discovery first on data requests', () => {
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('SCHEMA FIRST');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('describe_sheet');
  });

  it('JOB_PLAN prompt routes charts: chat charts are one analyze_data step, no discovery (#159)', () => {
    // Regression guard: the R3 panel-chart prompt decomposed into a
    // discovery + create_chart workflow after SCHEMA FIRST landed, so a
    // chat chart became a native chart. The planner must route it.
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('CHART ROUTES');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain(
      'EXACTLY ONE step whose instruction names analyze_data explicitly',
    );
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('do NOT add a discovery step');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('names create_chart explicitly');
  });

  it('planner with default allowlist accepts a describe_sheet plan', async () => {
    const { fetchImpl } = fakeChatCompletions({
      message: 'Mapping the Income sheet first.',
      actions: [
        {
          type: 'tool',
          tool: 'describe_sheet',
          args: { sheet: 'Income' },
          rationale: 'map the schema before reading values',
        },
      ],
    });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => 'k',
      fetchImpl,
    });
    const out = await backend.plan(input('What is total revenue by year?'));
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'describe_sheet' });
  });

  it('planner with default allowlist accepts an aggregate_cells plan', async () => {
    const { fetchImpl } = fakeChatCompletions({
      message: 'Summing the Revenue row through the engine.',
      actions: [
        {
          type: 'tool',
          tool: 'aggregate_cells',
          args: { sheet: 'Income', startRow: 6, startCol: 1, endRow: 6, endCol: 10, op: 'sum' },
          rationale: 'engine-truth total, never hand-added',
        },
      ],
    });
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'https://api.example.com/v1',
      getApiKey: async () => 'k',
      fetchImpl,
    });
    const out = await backend.plan(input('What is total revenue?'));
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'aggregate_cells' });
  });
});

describe('JOB_PLAN prompt decision flow (round-2 restructure, owner 2026-10-26)', () => {
  it('is a flowchart-style flow: chart gate precedes schema-first, first match wins', () => {
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('DECISION FLOW');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('GATE 1 — CHART REQUEST?');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('GATE 2 — DATA REQUEST NEEDING SHEET DATA?');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('FIRST gate that matches');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('NEVER overrides an earlier one');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('Flowchart: request asks for a chart?');
    // Precedence is structural, not a tie-break the model must weigh:
    // the chart gate must appear before the schema-first gate.
    expect(JOB_PLAN_SYSTEM_PROMPT.indexOf('GATE 1')).toBeLessThan(
      JOB_PLAN_SYSTEM_PROMPT.indexOf('GATE 2'),
    );
  });

  it('carries an explicit importance level on every gate; critical rules are VERY IMPORTANT', () => {
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('GATE 1 — CHART REQUEST? [VERY IMPORTANT]');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('GATE 4 — DECLARATIONS FOR EVERY STEP [VERY IMPORTANT]');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('GATE 5 — VALUES [VERY IMPORTANT]');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('GATE 2 — DATA REQUEST NEEDING SHEET DATA? [IMPORTANT]');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('GATE 3 — ONE STEP OR STAGED? [IMPORTANT]');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('GATE 6 — CONSTRUCTION DETAILS [NORMAL]');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain(
      'VERY IMPORTANT = violating it breaks routing, verification, or sheet data',
    );
  });

  it('chart gate explicitly overrides schema-first for no-placement charts', () => {
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('OVERRIDES Gate 2');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('NEVER gets a discovery step');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('This gate does NOT apply to Gate 1(a) chat charts');
  });

  it('states verification dispatch per step kind, so chart steps declare correctly', () => {
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('verifies ONLY the declared kind');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('app-create" verifies ONLY that an app artifact exists');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('a NATIVE create_chart step declares "sheet-write"');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('an analyze_data chat-chart step declares "none"');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('Declaring "app-create" on a step that builds no app');
  });
});
