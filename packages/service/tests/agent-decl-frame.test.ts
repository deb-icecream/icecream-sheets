/**
 * Declaration-frame fix tests: the workflow planner must bind check
 * ranges to schema discovery output, not invent them blind.
 *
 * The gap (pinned from code, 2026-10-26): the initial job plan is
 * written BEFORE any tool runs, and JobPlanInput had no toolResults
 * channel at all — planJob rendered only user text + the last 6
 * history messages at 300 chars each + sheet names. A describe_sheet
 * result (with its coordinateFrame label) therefore NEVER reached the
 * planner, so compute-step check ranges were invented blind ("Revenue
 * row 1" — relative to the dimension row — declared as absolute, and a
 * 9-value range that dropped the last year column). The step loop
 * itself saw the schema and computed correctly; only the frozen
 * declaration stayed wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  JOB_PLAN_SYSTEM_PROMPT,
  OpenAICompatibleBackend,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_MAX_CHARS,
} from '../src/agent/openaiBackend.js';
import type { JobPlanInput } from '../src/agent/types.js';

const FRAME =
  'All row and col numbers in this response are 0-based ABSOLUTE sheet coordinates: ' +
  'row 0 is the first row of the sheet and col 0 is column A (so B=1, C=2, ...). ' +
  'They are NOT offsets from usedRange.startRow/startCol, NOT positions inside the ' +
  'rowSummaries/colSummaries arrays, and NOT offsets from the dimension row.';

/** Income-shaped describe_sheet payload at realistic size (~3.5KB). */
function incomeSchemaData(): Record<string, unknown> {
  const labels: Record<number, string> = {
    5: 'Income Statement',
    6: 'Revenue',
    8: 'Gross Profit',
    20: 'Net Earnings',
  };
  const rowSummaries = Array.from({ length: 22 }, (_, row) => ({
    row,
    label: labels[row] ?? null,
    numericCount: row === 5 ? 10 : row === 6 || row === 8 || row === 20 ? 10 : 0,
    textCount: labels[row] ? 1 : 0,
    dimensionLike: row === 5,
  }));
  const colSummaries = Array.from({ length: 12 }, (_, col) => ({
    col,
    label: col === 0 ? null : String(2011 + col),
    numericCount: col === 0 ? 0 : 20,
    textCount: col === 0 ? 4 : 0,
    dimensionLike: false,
  }));
  return {
    coordinateFrame: FRAME,
    sheet: 'Income',
    usedRange: { sheet: 'Income', startRow: 0, startCol: 0, endRow: 21, endCol: 11 },
    scanned: true,
    rowSummaries,
    colSummaries,
    dimensionRows: [5],
    dimensionCols: [],
    suggestedLayout: 'horizontal',
  };
}

function planJobBackend(captured: string[]): OpenAICompatibleBackend {
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: { role: string; content: string }[];
    };
    captured.push(body.messages?.[1]?.content ?? '');
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                steps: [{ title: 'Only step', instruction: 'Do the thing.' }],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return new OpenAICompatibleBackend({
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    getApiKey: async () => 'fake-key-for-test-only',
    fetchImpl,
    retryDelaysMs: [],
  });
}

describe('declaration-frame fix: planJob receives schema tool results', () => {
  it('renders the describe_sheet result — frame label plus late rows — into the plan request', async () => {
    const captured: string[] = [];
    const backend = planJobBackend(captured);
    const input: JobPlanInput = {
      userText: 'Total the Income sheet.',
      history: [],
      toolResults: [
        { tool: 'describe_sheet', ok: true, summary: 'describe_sheet ok', data: incomeSchemaData() },
      ],
    };
    const plan = await backend.planJob(input);
    expect(plan.steps.length).toBe(1);
    const prompt = captured[0] ?? '';
    expect(prompt).toContain('Tool results (ground truth');
    expect(prompt).toContain('coordinateFrame');
    // Late rows must survive: a 2000-char data cap would cut Net
    // Earnings (row 20, near the end of rowSummaries) and the tail.
    expect(prompt).toContain('Net Earnings');
    expect(prompt).toContain('suggestedLayout');
    expect(prompt).toContain('horizontal');
  });

  it('omits the tool-results section when no tool results are supplied', async () => {
    const captured: string[] = [];
    const backend = planJobBackend(captured);
    await backend.planJob({ userText: 'Do a thing.', history: [] });
    expect(captured[0] ?? '').not.toContain('Tool results (ground truth');
  });

  it('JOB_PLAN prompt carries the schema-binding and no-placeholder rules', () => {
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('SCHEMA-BOUND CHECKS');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('0-based ABSOLUTE');
    expect(JOB_PLAN_SYSTEM_PROMPT).toContain('123456789');
  });

  it('SYSTEM_PROMPT is untouched by this fix (zero prompt cost)', () => {
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(SYSTEM_PROMPT_MAX_CHARS);
    expect(SYSTEM_PROMPT).not.toContain('SCHEMA-BOUND CHECKS');
  });
});
