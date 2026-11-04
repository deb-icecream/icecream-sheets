/**
 * #155 — JOB totals-step value verification.
 *
 * Same harness shape as agent-workflows.test.ts: a real MCP server over
 * a real in-memory EngineHost, with SCRIPTED model backends.
 *
 * The defect: a totals step wrote LLM-computed literals (its own
 * arithmetic, never an engine SUM) and verification passed anyway,
 * because it checked only that the target range was filled
 * (range-filled) or that some write effect existed (the sheet-write
 * fallback) — never the VALUES. The #155 numbers below are the exact
 * claimed/written values from the filed defect; the ground-truth
 * numbers are the engine sums over the seeded source rows, taken
 * from test-data/real-world/beyond-excel-bxl3way.xlsx (Income sheet:
 * Revenue row 7, Gross Profit row 9, Net Earnings row 21, years
 * 2012-2021 in columns B-K).
 *
 * The fix under test: a declared `cell-sum-equals` check recomputes
 * the total from the engine's own source-range values and compares
 * the written cell against THAT — the planner declares only structure
 * (total cell + source range), never a value.
 */
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '@icecream-sheets/mcp-server';
import { EngineHost } from '@icecream-sheets/engine';
import { AgentRuntime } from '../src/agent/runtime.js';
import { parseJobPlan } from '../src/agent/openaiBackend.js';
import {
  deserializeWorkflows,
  migrateWorkflow,
  serializeWorkflows,
} from '../src/agent/workflows.js';
import type {
  JobPlan,
  ModelBackend,
  PlannerInput,
  PlannerOutput,
} from '../src/agent/types.js';

interface ScriptedBackend extends ModelBackend {
  planCalls: PlannerInput[];
  planJobCalls: unknown[];
}

function scriptedBackend(opts: {
  plans?: (JobPlan | null)[];
  onPlan: (input: PlannerInput) => PlannerOutput;
}): ScriptedBackend {
  const planCalls: PlannerInput[] = [];
  const planJobCalls: unknown[] = [];
  const backend: ScriptedBackend = {
    name: 'scripted',
    planCalls,
    planJobCalls,
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      planCalls.push(input);
      return opts.onPlan(input);
    },
  };
  if (opts.plans !== undefined) {
    const queue = [...opts.plans];
    backend.planJob = async (input: unknown): Promise<JobPlan | null> => {
      planJobCalls.push(input);
      return queue.length > 0 ? queue.shift()! : null;
    };
  }
  return backend;
}

async function makeRuntime(backend: ModelBackend) {
  const host = new EngineHost();
  const server: McpServer = createServer(host);
  const runtime = new AgentRuntime({
    server,
    principal: 'test-user',
    maxIterations: 5,
    backend,
  });
  return { host, runtime };
}

const doneWith = (message: string): PlannerOutput => ({ message, actions: [{ type: 'done' }] });

/** bxl3way Income yearly values, 0-based rows 6/8/20, cols 1-10 (B-K). */
const REVENUE = [102007, 118086, 131345, 142341, 150772, 158310.6, 165434.577, 172051.96008, 178073.77868279998, 183415.99204328397];
const GROSS_PROFIT = [62984, 70082, 82222, 89087, 93462, 99735.67800000001, 104223.78351, 110113.25445119999, 113967.21835699199, 119220.3948281346];
const NET_EARNINGS = [2473.8292, 11790.783497877968, 21075.193885131324, 26713.47902359531, 28226.884758580287, 35155.62576000001, 38389.48668719999, 44071.360740863995, 43823.08773863423, 49852.2985892169];

function seedIncome(host: EngineHost): void {
  const rows: [number, number[]][] = [
    [6, REVENUE],
    [8, GROSS_PROFIT],
    [20, NET_EARNINGS],
  ];
  for (const [row, values] of rows) {
    values.forEach((value, i) => {
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row, col: 1 + i }, value });
    });
  }
}

function totalsPlan(opts: {
  measure: string;
  sourceRow: number;
  targetRow: number;
  checks: JobPlan['steps'][number]['checks'];
}): JobPlan {
  return {
    steps: [
      {
        title: `Write the ${opts.measure} total`,
        instruction: `Write the ${opts.measure} total into cell B${opts.targetRow + 1} of Sheet1.`,
        expectedChange: 'sheet-write',
        checks: opts.checks,
      },
      {
        title: 'Report back',
        instruction: 'Tell the user the total landed.',
        expectedChange: 'none',
      },
    ],
  };
}

function sumCheck(sourceRow: number, targetRow: number): JobPlan['steps'][number]['checks'] {
  return [
    {
      kind: 'cell-sum-equals',
      sheet: 'Sheet1',
      row: targetRow,
      col: 1,
      sourceSheet: 'Sheet1',
      sourceStartRow: sourceRow,
      sourceStartCol: 1,
      sourceEndRow: sourceRow,
      sourceEndCol: 10,
    },
  ];
}

/** Drive one totals workflow where the step writes `written` as a literal. */
async function runTotals(opts: {
  plan: JobPlan;
  written: number;
  targetRow: number;
  measure: string;
}): Promise<{ status: string | undefined; attempts: number; verification: string | undefined; stepsCompleted: number | undefined }> {
  const backend = scriptedBackend({
    plans: [opts.plan, opts.plan, opts.plan, opts.plan],
    onPlan: (input) => {
      if (input.userText.includes(`This step: Write the ${opts.measure} total`)) {
        return input.iteration === 1
          ? {
              message: `Writing ${opts.written}.`,
              actions: [
                {
                  type: 'tool',
                  tool: 'write_cells',
                  args: { cells: [{ sheet: 'Sheet1', row: opts.targetRow, col: 1, value: opts.written }] },
                },
              ],
            }
          : doneWith(`Wrote ${opts.written}.`);
      }
      if (input.userText.includes('This step: Tell the user the total landed')) {
        return doneWith('The total landed.');
      }
      return doneWith('Unexpected prompt.');
    },
  });
  const { host, runtime } = await makeRuntime(backend);
  try {
    seedIncome(host);
    const reply = await runtime.chat('t1', `Write the ${opts.measure} total and then report back.`);
    const wf = runtime.getWorkflow('t1');
    return {
      status: reply.workflow?.status,
      attempts: wf?.steps[0]?.attempts ?? -1,
      verification: wf?.steps[0]?.verification,
      stepsCompleted: reply.workflow?.stepsCompleted,
    };
  } finally {
    await runtime.close();
  }
}

describe('#155 totals-step value verification (cell-sum-equals)', () => {
  it('the exact #155 Revenue claim 1,501,737.82 FAILS against the true total 1,501,837.91', async () => {
    const r = await runTotals({
      plan: totalsPlan({ measure: 'Revenue', sourceRow: 6, targetRow: 22, checks: sumCheck(6, 22) }),
      written: 1501737.82,
      targetRow: 22,
      measure: 'Revenue',
    });
    expect(r.status).toBe('stuck');
    expect(r.attempts).toBe(3);
    expect(r.verification).toContain('but the source range sums to');
    expect(r.verification).toContain('1501737.82');
  });

  it('the exact #155 Gross Profit claim 844,937.76 FAILS against the true total 945,097.33', async () => {
    const r = await runTotals({
      plan: totalsPlan({ measure: 'Gross Profit', sourceRow: 8, targetRow: 22, checks: sumCheck(8, 22) }),
      written: 844937.76,
      targetRow: 22,
      measure: 'Gross Profit',
    });
    expect(r.status).toBe('stuck');
    expect(r.attempts).toBe(3);
    expect(r.verification).toContain('but the source range sums to');
  });

  it('the exact #155 Net Income claim 355,286.49 FAILS against the true total 301,572.03', async () => {
    const r = await runTotals({
      plan: totalsPlan({ measure: 'Net Earnings', sourceRow: 20, targetRow: 22, checks: sumCheck(20, 22) }),
      written: 355286.49,
      targetRow: 22,
      measure: 'Net Earnings',
    });
    expect(r.status).toBe('stuck');
    expect(r.attempts).toBe(3);
    expect(r.verification).toContain('but the source range sums to');
  });

  it('the video-v2 write B1 = 20165 FAILS against the true Revenue total', async () => {
    const r = await runTotals({
      plan: totalsPlan({ measure: 'Revenue', sourceRow: 6, targetRow: 22, checks: sumCheck(6, 22) }),
      written: 20165,
      targetRow: 22,
      measure: 'Revenue',
    });
    expect(r.status).toBe('stuck');
    expect(r.attempts).toBe(3);
    expect(r.verification).toContain('20165');
    expect(r.verification).toContain('but the source range sums to');
  });

  it('the ground-truth totals PASS (Revenue, Gross Profit, Net Earnings)', async () => {
    const cases: [string, number, number, number][] = [
      ['Revenue', 6, 22, 1501837.91],
      ['Gross Profit', 8, 22, 945097.33],
      ['Net Earnings', 20, 22, 301572.03],
    ];
    for (const [measure, sourceRow, targetRow, truth] of cases) {
      const r = await runTotals({
        plan: totalsPlan({ measure, sourceRow, targetRow, checks: sumCheck(sourceRow, targetRow) }),
        written: truth,
        targetRow,
        measure,
      });
      expect(r.status).toBe('done');
      expect(r.stepsCompleted).toBe(2);
      expect(r.verification).toContain('matches the source sum');
    }
  });

  it('range-filled ALONE still passes a wrong total — it proves landing, never values (diagnosis pin)', async () => {
    const plan: JobPlan = {
      steps: [
        {
          title: 'Write the Revenue total',
          instruction: 'Write the Revenue total into cell B23 of Sheet1.',
          expectedChange: 'sheet-write',
          checks: [
            { kind: 'range-filled', sheet: 'Sheet1', startRow: 22, startCol: 1, endRow: 22, endCol: 1 },
          ],
        },
        {
          title: 'Report back',
          instruction: 'Tell the user the total landed.',
          expectedChange: 'none',
        },
      ],
    };
    const r = await runTotals({ plan, written: 1501737.82, targetRow: 22, measure: 'Revenue' });
    expect(r.status).toBe('done');
    expect(r.verification).toContain('fully filled');
  });
});

describe('#155 check declaration hygiene (parse + persist)', () => {
  it('parseJobPlan preserves a valid cell-sum-equals and drops invalid shapes', () => {
    const plan = parseJobPlan({
      steps: [
        {
          title: 'Total',
          instruction: 'Write the total.',
          checks: [
            {
              kind: 'cell-sum-equals',
              sheet: 'Totals',
              row: 0,
              col: 1,
              sourceSheet: 'Income',
              sourceStartRow: 6,
              sourceStartCol: 1,
              sourceEndRow: 6,
              sourceEndCol: 10,
            },
            { kind: 'cell-sum-equals', sheet: 'Totals', row: 0, col: 1 },
            { kind: 'cell-sum-equals', sheet: 'Totals', row: 'x', col: 1, sourceSheet: 'Income', sourceStartRow: 6, sourceStartCol: 1, sourceEndRow: 6, sourceEndCol: 10 },
            { kind: 'cell-sum-equals', sheet: 'Totals', row: 0, col: 1, sourceSheet: '', sourceStartRow: 6, sourceStartCol: 1, sourceEndRow: 6, sourceEndCol: 10 },
          ],
        },
      ],
    });
    expect(plan.steps[0]?.checks).toEqual([
      {
        kind: 'cell-sum-equals',
        sheet: 'Totals',
        row: 0,
        col: 1,
        sourceSheet: 'Income',
        sourceStartRow: 6,
        sourceStartCol: 1,
        sourceEndRow: 6,
        sourceEndCol: 10,
      },
    ]);
  });

  it('migrateWorkflow round-trips a valid cell-sum-equals and drops an invalid one', () => {
    const wf = migrateWorkflow({
      version: 1,
      id: 'wf-test',
      threadId: 't1',
      userId: 'test-user',
      originText: 'Do the job.',
      status: 'running',
      currentStep: 0,
      steering: [],
      steps: [
        {
          title: 'Total',
          instruction: 'Write the total.',
          status: 'pending',
          attempts: 0,
          expectedChange: 'sheet-write',
          checks: [
            {
              kind: 'cell-sum-equals',
              sheet: 'Totals',
              row: 0,
              col: 1,
              sourceSheet: 'Income',
              sourceStartRow: 6,
              sourceStartCol: 1,
              sourceEndRow: 6,
              sourceEndCol: 10,
            },
            { kind: 'cell-sum-equals', sheet: 'Totals', row: 0, col: 1 },
          ],
        },
      ],
      createdAt: 1,
      updatedAt: 2,
    });
    expect(wf?.steps[0]?.checks).toEqual([
      {
        kind: 'cell-sum-equals',
        sheet: 'Totals',
        row: 0,
        col: 1,
        sourceSheet: 'Income',
        sourceStartRow: 6,
        sourceStartCol: 1,
        sourceEndRow: 6,
        sourceEndCol: 10,
      },
    ]);
    const back = deserializeWorkflows(serializeWorkflows('test-user', [wf!]));
    expect(back[0]?.steps[0]?.checks).toEqual(wf?.steps[0]?.checks);
  });
});
