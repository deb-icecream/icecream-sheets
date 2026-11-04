/**
 * #151 coherence fix tests: (part 1) cell-sum-equals checks render
 * as exact write-target + source-range instruction lines, in the
 * tools' 0-based frame as well as A1; (part 2) failure re-plan
 * grounding covers check SOURCE sheets, not only target sheets.
 *
 * The failing run: planner prose "row 1, columns 1-3" was read
 * 1-based by the agent (Summaries A1:C1) while its checks read B2:D2
 * (0-based) — and attempt 3 re-derived wrong source rows because
 * replanRemainder grounded only on Summaries, never Income.
 */
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '@icecream-sheets/mcp-server';
import { EngineHost } from '@icecream-sheets/engine';
import { AgentRuntime } from '../src/agent/runtime.js';
import {
  checkGroundingLines,
  replanGroundingSheets,
} from '../src/agent/workflows.js';
import type {
  JobPlan,
  ModelBackend,
  PlannerInput,
  PlannerOutput,
  StepCheck,
} from '../src/agent/types.js';

const REVENUE_CHECK: StepCheck = {
  kind: 'cell-sum-equals',
  sheet: 'Summaries',
  row: 1,
  col: 1,
  sourceSheet: 'Income',
  sourceStartRow: 6,
  sourceStartCol: 1,
  sourceEndRow: 6,
  sourceEndCol: 10,
};

describe('checkGroundingLines (part 1)', () => {
  it('names the exact target cell in A1 and in 0-based write_cells args', () => {
    const lines = checkGroundingLines([REVENUE_CHECK]);
    expect(lines).toHaveLength(1);
    // B2 = 0-based (1,1); the line must carry BOTH frames.
    expect(lines[0]).toContain('Summaries!B2');
    expect(lines[0]).toContain('write_cells row 1, column 1');
  });

  it('names the exact source range in A1 and in 0-based coords', () => {
    const lines = checkGroundingLines([REVENUE_CHECK]);
    // Income row 6, cols 1-10 (0-based) = B7:K7 in A1.
    expect(lines[0]).toContain('Income!B7:K7');
    expect(lines[0]).toContain('rows 6-6');
    expect(lines[0]).toContain('columns 1-10');
  });

  it('converts columns past Z (AA) and row 0 correctly', () => {
    const lines = checkGroundingLines([
      {
        kind: 'cell-sum-equals',
        sheet: 'S',
        row: 0,
        col: 26,
        sourceSheet: 'T',
        sourceStartRow: 0,
        sourceStartCol: 27,
        sourceEndRow: 0,
        sourceEndCol: 27,
      },
    ]);
    expect(lines[0]).toContain('S!AA1');
    expect(lines[0]).toContain('T!AB1:AB1');
  });

  it('renders one line per cell-sum-equals check, in order', () => {
    const lines = checkGroundingLines([
      REVENUE_CHECK,
      { ...REVENUE_CHECK, col: 2, sourceStartRow: 8, sourceEndRow: 8 },
      { ...REVENUE_CHECK, col: 3, sourceStartRow: 20, sourceEndRow: 20 },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Summaries!B2');
    expect(lines[1]).toContain('Summaries!C2');
    expect(lines[2]).toContain('Summaries!D2');
  });

  it('renders nothing for other check kinds — and never leaks a cell-equals value', () => {
    const lines = checkGroundingLines([
      { kind: 'cell-equals', sheet: 'Summaries', row: 1, col: 1, equals: 123456789 },
      { kind: 'column-sum-equals', sheet: 'Summaries', col: 1, startRow: 0, endRow: 9, equals: 999 },
      { kind: 'range-filled', sheet: 'Summaries', startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
      { kind: 'sheet-exists', sheet: 'Summaries' },
      { kind: 'cell-nonempty', sheet: 'Summaries', row: 1, col: 1 },
    ]);
    expect(lines).toEqual([]);
  });

  it('renders nothing for undefined or empty checks', () => {
    expect(checkGroundingLines(undefined)).toEqual([]);
    expect(checkGroundingLines([])).toEqual([]);
  });
});

describe('replanGroundingSheets (part 2)', () => {
  it('includes the cell-sum-equals SOURCE sheet alongside the target sheet', () => {
    // The old loop collected only c.sheet (Summaries); Income is the
    // fix — without it the re-plan re-derives source rows blind.
    expect(replanGroundingSheets([REVENUE_CHECK])).toEqual(['Summaries', 'Income']);
  });

  it('deduplicates and keeps target-first order across mixed checks', () => {
    const sheets = replanGroundingSheets([
      REVENUE_CHECK,
      { kind: 'range-filled', sheet: 'Dashboard', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { ...REVENUE_CHECK, col: 2 },
    ]);
    expect(sheets).toEqual(['Summaries', 'Income', 'Dashboard']);
  });

  it('skips empty sheet names and handles undefined', () => {
    expect(replanGroundingSheets(undefined)).toEqual([]);
    expect(
      replanGroundingSheets([
        { kind: 'cell-sum-equals', sheet: '', row: 0, col: 0, sourceSheet: '', sourceStartRow: 0, sourceStartCol: 0, sourceEndRow: 0, sourceEndCol: 0 },
      ]),
    ).toEqual([]);
  });
});

/**
 * Wiring: the grounding block must actually reach the step executor's
 * prompt AND change the outcome. The scripted model below mimics the
 * failing run's agent: it writes where the step text tells it to —
 * the grounding line when present (B2), the ambiguous prose ("row 1")
 * when absent (A1, 1-based read). Pre-fix the prompt carries no block,
 * so the model writes A1 and verification reads null at B2 — the exact
 * #151 failure. Post-fix the block names B2 and the workflow completes.
 */
interface ScriptedBackend extends ModelBackend {
  planCalls: PlannerInput[];
}

function scriptedBackend(opts: {
  plans: (JobPlan | null)[];
  onPlan: (input: PlannerInput) => PlannerOutput;
}): ScriptedBackend {
  const planCalls: PlannerInput[] = [];
  const backend: ScriptedBackend = {
    name: 'scripted',
    planCalls,
    async plan(input: PlannerInput): Promise<PlannerOutput> {
      planCalls.push(input);
      return opts.onPlan(input);
    },
  };
  const queue = [...opts.plans];
  backend.planJob = async (): Promise<JobPlan | null> =>
    queue.length > 0 ? queue.shift()! : null;
  return backend;
}

const doneWith = (message: string): PlannerOutput => ({ message, actions: [{ type: 'done' }] });

/** Seed Sheet1 row 0, cols 1-3 with 10/20/30 (sum 60). */
function seedSource(host: EngineHost): void {
  [10, 20, 30].forEach((value, i) => {
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 + i }, value });
  });
}

function groundingPlan(): JobPlan {
  return {
    steps: [
      {
        title: 'Write the total',
        // Deliberately ambiguous prose, mirroring the failing run's
        // "row 1, columns 1-3": read 1-based, this points at A1.
        instruction: 'Write the total to row 1 of Sheet1.',
        expectedChange: 'sheet-write',
        checks: [
          {
            kind: 'cell-sum-equals',
            sheet: 'Sheet1',
            row: 1,
            col: 1,
            sourceSheet: 'Sheet1',
            sourceStartRow: 0,
            sourceStartCol: 1,
            sourceEndRow: 0,
            sourceEndCol: 3,
          },
        ],
      },
      {
        title: 'Report back',
        instruction: 'Tell the user the total landed.',
        expectedChange: 'none',
      },
    ],
  };
}

async function runGroundingWorkflow(followBlock: boolean): Promise<{
  status: string | undefined;
  stepPrompts: string[];
  verification: string | undefined;
}> {
  const plan = groundingPlan();
  const backend = scriptedBackend({
    plans: [plan, plan, plan, plan, plan],
    onPlan: (input) => {
      if (input.userText.includes('This step: Write the total')) {
        if (input.iteration !== 1) return doneWith('Wrote the total.');
        // The model follows the grounding line when it sees one;
        // otherwise it follows the prose ("row 1" → A1, 1-based read).
        const seesBlock = input.userText.includes('Sheet1!B2');
        const target = followBlock && seesBlock ? { row: 1, col: 1 } : { row: 0, col: 0 };
        return {
          message: 'Writing the total.',
          actions: [
            {
              type: 'tool',
              tool: 'write_cells',
              args: { cells: [{ sheet: 'Sheet1', row: target.row, col: target.col, value: 60 }] },
            },
          ],
        };
      }
      if (input.userText.includes('This step: Tell the user the total landed')) {
        return doneWith('The total landed.');
      }
      return doneWith('Unexpected prompt.');
    },
  });
  const host = new EngineHost();
  const server: McpServer = createServer(host);
  const runtime = new AgentRuntime({ server, principal: 'test-user', maxIterations: 5, backend });
  try {
    seedSource(host);
    const reply = await runtime.chat('t1', 'Write the total and then report back.');
    const wf = runtime.getWorkflow('t1');
    return {
      status: reply.workflow?.status,
      stepPrompts: backend.planCalls.map((c) => c.userText),
      verification: wf?.steps[0]?.verification,
    };
  } finally {
    await runtime.close();
  }
}

describe('stepPrompt grounding wiring (part 1, end to end)', () => {
  it('the step prompt carries the grounding block and the workflow completes', async () => {
    const r = await runGroundingWorkflow(true);
    const stepPrompt = r.stepPrompts.find((p) => p.includes('This step: Write the total'));
    expect(stepPrompt).toBeDefined();
    expect(stepPrompt).toContain('Write targets for this step');
    expect(stepPrompt).toContain('Sheet1!B2');
    expect(stepPrompt).toContain('write_cells row 1, column 1');
    expect(r.status).toBe('done');
  });

  it('control: a model writing to the prose cell (A1) fails verification with the #151 null-read', async () => {
    const r = await runGroundingWorkflow(false);
    expect(r.status).toBe('stuck');
    expect(r.verification).toContain('holds null');
  });
});
