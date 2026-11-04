/**
 * Workflow layer tests (design-docs/agent-workflows.md §2 + §4.0).
 *
 * Same harness shape as agent-runtime.test.ts: a real MCP server over a
 * real in-memory EngineHost, with SCRIPTED model backends — the driver
 * mechanics (engagement, per-step budgets, verification, steering
 * retry, re-plan, stuck, resume, cancel, supersede, promotion) are
 * what is under test, not any model's judgment.
 */
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '@icecream-sheets/mcp-server';
import { EngineHost } from '@icecream-sheets/engine';
import { AgentRuntime, isChatChartRequest } from '../src/agent/runtime.js';
import { parseJobPlan } from '../src/agent/openaiBackend.js';
import {
  deserializeWorkflows,
  migrateWorkflow,
  normalizeStepDeclaration,
  serializeWorkflows,
  stepAllowsNativeChart,
  type AgentWorkflow,
} from '../src/agent/workflows.js';
import {
  TemplateAppGenerator,
  type AppGenerator,
  type ArtifactSpec,
} from '../src/artifacts/index.js';
import type { MetadataStore } from '../src/metadataStore.js';
import { createArtifactStore, memoryPersistence, type Persistence } from '../src/metadataStore.js';
import type {
  JobPlan,
  JobPlanInput,
  ModelBackend,
  PlannerInput,
  PlannerOutput,
} from '../src/agent/types.js';

interface ScriptedBackend extends ModelBackend {
  planCalls: PlannerInput[];
  planJobCalls: JobPlanInput[];
}

function scriptedBackend(opts: {
  /** planJob results, shifted per call; omit the method entirely when undefined. */
  plans?: (JobPlan | null)[];
  onPlan: (input: PlannerInput) => PlannerOutput;
}): ScriptedBackend {
  const planCalls: PlannerInput[] = [];
  const planJobCalls: JobPlanInput[] = [];
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
    backend.planJob = async (input: JobPlanInput): Promise<JobPlan | null> => {
      planJobCalls.push(input);
      return queue.length > 0 ? queue.shift()! : null;
    };
  }
  return backend;
}

async function makeRuntime(opts: {
  backend: ModelBackend;
  maxIterations?: number;
  workflowPersistence?: Persistence;
  artifactStore?: MetadataStore<ArtifactSpec>;
  appGenerator?: AppGenerator;
}) {
  const host = new EngineHost();
  const server: McpServer = createServer(host);
  const runtime = new AgentRuntime({
    server,
    principal: 'test-user',
    maxIterations: opts.maxIterations ?? 5,
    ...(opts.workflowPersistence ? { workflowPersistence: opts.workflowPersistence } : {}),
    ...(opts.artifactStore ? { artifactStore: opts.artifactStore } : {}),
    ...(opts.appGenerator ? { appGenerator: opts.appGenerator } : {}),
    backend: opts.backend,
  });
  return { host, runtime };
}

function cellValue(host: EngineHost, row: number, col: number): unknown {
  const v = host.getView().readCell({ sheet: 'Sheet1', row, col }).value;
  return v.kind === 'number' || v.kind === 'string' ? v.value : v.kind;
}

const writeB2 = (value: number): PlannerOutput => ({
  message: `Writing ${value} into B2.`,
  actions: [
    {
      type: 'tool',
      tool: 'write_cells',
      args: { cells: [{ sheet: 'Sheet1', row: 1, col: 1, value }] },
    },
  ],
});
const doneWith = (message: string): PlannerOutput => ({ message, actions: [{ type: 'done' }] });

describe('workflow engagement (§4.0 regression guard)', () => {
  it('a backend without planJob keeps the plain path — no workflow, no events', async () => {
    const backend = scriptedBackend({
      onPlan: (input) =>
        input.iteration === 1
          ? {
              message: 'Reading.',
              actions: [
                {
                  type: 'tool',
                  tool: 'read_cells',
                  args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
                },
              ],
            }
          : doneWith('The answer is 60.'),
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'What is in A1:A3?');
      expect(reply.message).toContain('60');
      expect(reply.workflow).toBeUndefined();
      expect(reply.actionsTaken.some((e) => e.kind === 'workflow')).toBe(false);
      expect(runtime.getWorkflow('t1')).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it('a one-step job plan keeps the plain path exactly', async () => {
    const backend = scriptedBackend({
      plans: [{ steps: [{ title: 'Answer', instruction: 'Answer the question.' }] }],
      onPlan: () => doneWith('Simple answer.'),
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'A simple question?');
      expect(reply.message).toBe('Simple answer.');
      expect(reply.workflow).toBeUndefined();
      expect(backend.planJobCalls.length).toBe(1);
      expect(reply.actionsTaken.some((e) => e.kind === 'workflow')).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it('a stage-shaped ask re-plans once with the decomposition note (W1 engagement pin)', async () => {
    // The live W1 failure mode (2026-10-23): planJob sampled the share-
    // column ask as ONE step, the plain loop filled column D with
    // per-row shares (0.0753). A stage-shaped ask that first plans to
    // <= 1 step gets exactly one nudged re-plan; the workflow record
    // keeps the user's original text as its origin.
    const w1Ask =
      "Compute each region's share of total revenue. For every data row in the Sales sheet, write in column D that row's region's share of the total revenue as a percentage. Then tell me which region has the largest share and what that share is.";
    const backend = scriptedBackend({
      plans: [
        { steps: [{ title: 'Write shares', instruction: 'Write the share column in one go.' }] },
        {
          steps: [
            {
              title: 'Write the answer',
              instruction: 'Write 42 into cell B2 of Sheet1.',
              checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 42 }],
            },
            { title: 'Report back', instruction: 'Tell the user the value is in B2.' },
          ],
        },
      ],
      onPlan: (input) => {
        if (input.userText.includes('Write 42 into cell B2')) {
          return input.iteration === 1 ? writeB2(42) : doneWith('Wrote 42 into B2.');
        }
        if (input.userText.includes('Tell the user the value is in B2')) {
          return doneWith('The value 42 is in B2.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', w1Ask);
      expect(reply.workflow?.status).toBe('done');
      expect(reply.workflow?.stepsCompleted).toBe(2);
      expect(backend.planJobCalls.length).toBe(2);
      expect(backend.planJobCalls[0]?.userText).not.toContain('Planning note');
      expect(backend.planJobCalls[1]?.userText).toContain('Planning note');
      expect(runtime.getWorkflow('t1')?.originText).toBe(w1Ask);
    } finally {
      await runtime.close();
    }
  });

  it('a single-action ask is never nudged (§4.0 path identity)', async () => {
    const backend = scriptedBackend({
      plans: [{ steps: [{ title: 'Set the cell', instruction: 'Set the cell.' }] }],
      onPlan: () => doneWith('Done.'),
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat(
        't1',
        'Set the Revenue for Jun South to 15000 in the Sales sheet.',
      );
      expect(reply.workflow).toBeUndefined();
      expect(backend.planJobCalls.length).toBe(1);
    } finally {
      await runtime.close();
    }
  });
});

describe('workflow driving (§2.2/§2.3)', () => {
  const twoStepPlan: JobPlan = {
    steps: [
      {
        title: 'Write the answer',
        instruction: 'Write 42 into cell B2 of Sheet1.',
        checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 42 }],
      },
      { title: 'Report back', instruction: 'Tell the user the value is in B2.' },
    ],
  };

  it('runs a two-step job to completion, verifying step 1 against the sheet', async () => {
    const backend = scriptedBackend({
      plans: [twoStepPlan],
      onPlan: (input) => {
        if (input.userText.includes('Write 42 into cell B2')) {
          return input.iteration === 1 ? writeB2(42) : doneWith('Wrote 42 into B2.');
        }
        if (input.userText.includes('Tell the user the value is in B2')) {
          return doneWith('The value 42 is in B2.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { host, runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'Put the answer in B2 and tell me.');
      expect(cellValue(host, 1, 1)).toBe(42);
      expect(reply.workflow?.status).toBe('done');
      expect(reply.workflow?.stepsCompleted).toBe(2);
      expect(reply.message).toContain('The value 42 is in B2.');
      expect(reply.message).toContain('Job complete — all 2 steps finished');
      const events = reply.actionsTaken
        .filter((e) => e.kind === 'workflow')
        .map((e) => e.workflow?.event);
      expect(events).toEqual([
        'started',
        'step_started',
        'step_verifying',
        'step_done',
        'step_started',
        'step_verifying',
        'step_done',
        'done',
      ]);
      const wf = runtime.getWorkflow('t1');
      expect(wf?.status).toBe('done');
      expect(wf?.steps[0]?.verification).toContain('as expected');
    } finally {
      await runtime.close();
    }
  });

  it('a report step that only answers (no tool calls) verifies — the answer is the deliverable (case7sql pin)', async () => {
    // Regression pin (2026-10-23): in the live case7sql run, step 2 was
    // titled "Identify the region with the highest revenue" with an
    // instruction to "explicitly state" the winner. It answered
    // correctly with zero tool calls, but the old runtime guessed the
    // step's shape from its wording and failed it 3x ("no tool
    // activity"), and the job went stuck with the answer already
    // computed in step 1. Under #151 the step declares 'none' — no
    // change expected — so nothing is verified and it passes at once.
    const plan: JobPlan = {
      steps: [
        {
          title: 'Calculate total revenue per region',
          instruction: 'Group the Sales data by region and sum the revenue for each region.',
          checks: [{ kind: 'sheet-exists', sheet: 'Sheet1' }],
        },
        {
          title: 'Identify the region with the highest revenue',
          instruction:
            'Review the per-region totals from the previous step and explicitly state which region has the highest total revenue and what that amount is.',
          expectedChange: 'none',
        },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: (input) => {
        if (input.userText.includes('Identify the region with the highest revenue')) {
          return doneWith('South has the highest total revenue: 250.');
        }
        if (input.userText.includes('Group the Sales data by region')) {
          return input.iteration === 1
            ? {
                message: 'Reading the sales data.',
                actions: [
                  {
                    type: 'tool',
                    tool: 'read_cells',
                    args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 1 },
                  },
                ],
              }
            : doneWith('Per-region totals: North 100, South 250.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat(
        't1',
        'Analyze the sales data: total revenue per region, and tell me the top region.',
      );
      expect(reply.workflow?.status).toBe('done');
      expect(reply.workflow?.stepsCompleted).toBe(2);
      expect(reply.message).toContain('South has the highest total revenue: 250.');
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[1]?.attempts).toBe(1);
      expect(wf?.steps[1]?.verification).toContain('nothing to verify');
    } finally {
      await runtime.close();
    }
  });

  it('retries a failed verification with steering, then succeeds', async () => {
    let writes = 0;
    const backend = scriptedBackend({
      plans: [twoStepPlan],
      onPlan: (input) => {
        if (input.userText.includes('Write 42 into cell B2')) {
          if (input.iteration === 1) {
            writes += 1;
            return writeB2(writes === 1 ? 1 : 42); // first segment writes the wrong value
          }
          return doneWith('Wrote a value into B2.');
        }
        if (input.userText.includes('Tell the user')) return doneWith('The value 42 is in B2.');
        return doneWith('Unexpected prompt.');
      },
    });
    const { host, runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'Put the answer in B2 and tell me.');
      expect(cellValue(host, 1, 1)).toBe(42);
      expect(reply.workflow?.status).toBe('done');
      expect(reply.workflow?.stepsRetried).toBe(1);
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[0]?.attempts).toBe(2);
      const retryEvents = reply.actionsTaken.filter(
        (e) => e.kind === 'workflow' && e.workflow?.event === 'step_retrying',
      );
      expect(retryEvents.length).toBe(1);
      expect(retryEvents[0]?.workflow?.detail).toContain('verification failed');
      // The steering note reached the retry segment's planner.
      const stepPrompts = backend.planCalls
        .map((c) => c.userText)
        .filter((t) => t.includes('Write 42 into cell B2'));
      expect(stepPrompts.some((t) => t.includes('did not finish'))).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('goes provably stuck after steering + re-plan, reports plainly, and resumes on the next message', async () => {
    let careful = false;
    const badPlan: JobPlan = {
      steps: [
        {
          title: 'Write the magic value',
          instruction: 'Write the magic value into B2.',
          checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 99 }],
        },
        { title: 'Report back', instruction: 'Tell the user it is done.' },
      ],
    };
    const replan: JobPlan = {
      steps: [
        {
          title: 'Write the magic value carefully',
          instruction: 'Write the magic value into B2 carefully.',
          checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 99 }],
        },
        { title: 'Report back', instruction: 'Tell the user it is done.' },
      ],
    };
    const backend = scriptedBackend({
      plans: [badPlan, replan],
      onPlan: (input) => {
        if (input.userText.includes('magic value')) {
          if (input.iteration === 1) return writeB2(careful ? 99 : 1);
          return doneWith('Wrote a value into B2.');
        }
        if (input.userText.includes('Tell the user')) return doneWith('All done — 99 is in B2.');
        return doneWith('Unexpected prompt.');
      },
    });
    const { host, runtime } = await makeRuntime({ backend });
    try {
      const stuck = await runtime.chat('t1', 'Write the magic value into B2 and then report back.');
      expect(stuck.workflow?.status).toBe('stuck');
      expect(stuck.message).toContain('I got stuck on step 1 of 2');
      expect(stuck.message).toContain('Completed so far: none yet');
      expect(stuck.message).toContain('What would unblock it');
      expect(backend.planJobCalls.length).toBe(2); // initial plan + one re-plan
      const wfStuck = runtime.getWorkflow('t1');
      expect(wfStuck?.status).toBe('stuck');
      expect(wfStuck?.steps[0]?.attempts).toBe(3); // plain + steering + re-planned run

      // The user supplies the unblocking fact; the job resumes at step 1
      // with a fresh attempt budget and completes.
      careful = true;
      const resumed = await runtime.chat('t1', 'The magic value is 99 — continue.');
      expect(resumed.workflow?.status).toBe('done');
      expect(cellValue(host, 1, 1)).toBe(99);
      expect(runtime.getWorkflow('t1')?.status).toBe('done');
    } finally {
      await runtime.close();
    }
  });

  it('cancels an open job on a cancel message', async () => {
    const badPlan: JobPlan = {
      steps: [
        {
          title: 'Write the magic value',
          instruction: 'Write the magic value into B2.',
          checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 99 }],
        },
        { title: 'Report back', instruction: 'Tell the user it is done.' },
      ],
    };
    const backend = scriptedBackend({
      plans: [badPlan, badPlan],
      onPlan: (input) => {
        if (input.userText.includes('magic value')) {
          if (input.iteration === 1) return writeB2(1);
          return doneWith('Wrote a value into B2.');
        }
        return doneWith('Other.');
      },
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const stuck = await runtime.chat('t1', 'Write the magic value into B2 and then report back.');
      expect(stuck.workflow?.status).toBe('stuck');
      const cancelled = await runtime.chat('t1', 'Cancel the job.');
      expect(cancelled.message).toContain('stopped the job');
      expect(cancelled.workflow?.status).toBe('cancelled');
      expect(runtime.getWorkflow('t1')?.status).toBe('cancelled');
    } finally {
      await runtime.close();
    }
  });

  it('supersedes an open job for a clearly new ask, and says so in the record', async () => {
    const badPlan: JobPlan = {
      steps: [
        {
          title: 'Write the magic value',
          instruction: 'Write the magic value into B2.',
          checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 99 }],
        },
        { title: 'Report back', instruction: 'Tell the user it is done.' },
      ],
    };
    const backend = scriptedBackend({
      plans: [badPlan, badPlan, { steps: [{ title: 'Rename', instruction: 'Rename the tab.' }] }],
      onPlan: (input) => {
        if (input.userText.includes('Rename the second worksheet tab')) {
          return doneWith('Renamed the tab to Summary.');
        }
        if (input.userText.includes('magic value')) {
          if (input.iteration === 1) return writeB2(1);
          return doneWith('Wrote a value into B2.');
        }
        return doneWith('Other.');
      },
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const stuck = await runtime.chat('t1', 'Write the magic value into B2 and then report back.');
      expect(stuck.workflow?.status).toBe('stuck');
      const reply = await runtime.chat('t1', 'Rename the second worksheet tab to Summary please.');
      expect(reply.message).toBe('Renamed the tab to Summary.');
      expect(reply.workflow).toBeUndefined(); // the new ask took the plain path
      expect(runtime.getWorkflow('t1')?.status).toBe('superseded');
    } finally {
      await runtime.close();
    }
  });
});

describe('exhaustion promotion (§2 safety net)', () => {
  it('promotes a turn that runs out of steps into a workflow instead of the ran-out-of-steps reply', async () => {
    const backend = scriptedBackend({
      plans: [
        { steps: [{ title: 'Only step', instruction: 'Do the whole thing.' }] },
        {
          steps: [
            {
              title: 'Write the value',
              instruction: 'Write 7 into cell B2 of Sheet1.',
              checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 7 }],
            },
            { title: 'Report back', instruction: 'Tell the user the value landed.' },
          ],
        },
      ],
      onPlan: (input) => {
        if (input.userText.includes('Write 7 into cell B2')) {
          return input.iteration === 1 ? writeB2(7) : doneWith('Wrote 7 into B2.');
        }
        if (input.userText.includes('Tell the user the value landed')) {
          return doneWith('The value 7 landed in B2.');
        }
        // The plain ask: reads forever, never finishes.
        return {
          message: 'Reading.',
          actions: [
            {
              type: 'tool',
              tool: 'read_cells',
              args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
            },
          ],
        };
      },
    });
    const { host, runtime } = await makeRuntime({ backend, maxIterations: 2 });
    try {
      const reply = await runtime.chat('t1', 'Do the whole long thing for me.');
      expect(reply.message).not.toContain('ran out of steps');
      expect(reply.workflow?.status).toBe('done');
      expect(cellValue(host, 1, 1)).toBe(7);
    } finally {
      await runtime.close();
    }
  });

  it('promotes with a deterministic fallback step when the backend has no planJob', async () => {
    const backend = scriptedBackend({
      onPlan: (input) => {
        if (input.userText.includes('[Step 1 of 1')) {
          return input.iteration === 1 ? writeB2(5) : doneWith('Wrote 5 into B2.');
        }
        return {
          message: 'Reading.',
          actions: [
            {
              type: 'tool',
              tool: 'read_cells',
              args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
            },
          ],
        };
      },
    });
    const { host, runtime } = await makeRuntime({ backend, maxIterations: 2 });
    try {
      const reply = await runtime.chat('t1', 'Write 5 into B2 of Sheet1, however long it takes.');
      expect(reply.message).not.toContain('ran out of steps');
      expect(reply.workflow?.status).toBe('done');
      expect(cellValue(host, 1, 1)).toBe(5);
      // The promoted step was steered to check state before writing.
      const stepPrompt = backend.planCalls.map((c) => c.userText).find((t) => t.includes('[Step 1 of 1'));
      expect(stepPrompt).toContain('already ran');
    } finally {
      await runtime.close();
    }
  });
});

describe('checkpoint + resume across runtimes (§2.4)', () => {
  it('a fresh runtime resumes an open workflow from its checkpoint without repeating done steps', async () => {
    const persistence = memoryPersistence();
    const plan: JobPlan = {
      steps: [
        {
          title: 'Write the magic value',
          instruction: 'Write the magic value into B2.',
          checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 99 }],
        },
        { title: 'Report back', instruction: 'Tell the user it is done.' },
      ],
    };
    // Runtime A gets stuck (planner writes the wrong value throughout).
    const backendA = scriptedBackend({
      plans: [plan, plan],
      onPlan: (input) => {
        if (input.userText.includes('magic value')) {
          if (input.iteration === 1) return writeB2(1);
          return doneWith('Wrote a value into B2.');
        }
        return doneWith('Other.');
      },
    });
    const a = await makeRuntime({ backend: backendA, workflowPersistence: persistence });
    const stuck = await a.runtime.chat('t1', 'Write the magic value into B2 and then report back.');
    expect(stuck.workflow?.status).toBe('stuck');
    await a.runtime.close();

    // Hand-edit the persisted record into the "interrupted mid-job"
    // shape a service kill leaves behind: step 1 done, step 2 pending,
    // status running. (A kill during a drive leaves exactly this: the
    // last checkpoint on disk.)
    const stored = deserializeWorkflows(
      persistence.load('icecream-sheets.agent-workflows.v1.test-user') ?? '',
    );
    expect(stored.length).toBe(1);
    const interrupted: AgentWorkflow = {
      ...stored[0]!,
      status: 'running',
      currentStep: 1,
      interruptedPhase: 'process-exit',
      steps: stored[0]!.steps.map((s, i) =>
        i === 0 ? { ...s, status: 'done' as const, attempts: 1 } : { ...s, status: 'pending' as const, attempts: 0 },
      ),
    };
    persistence.save(
      'icecream-sheets.agent-workflows.v1.test-user',
      serializeWorkflows('test-user', [interrupted]),
    );

    // Runtime B (same persistence, same workbook host state is NOT
    // shared — a fresh host — but the workflow record is what carries
    // the job; step 2 is a report step needing no sheet state).
    const backendB = scriptedBackend({
      plans: [],
      onPlan: (input) => {
        if (input.userText.includes('Tell the user it is done')) {
          return doneWith('All done — the job finished.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const b = await makeRuntime({ backend: backendB, workflowPersistence: persistence });
    try {
      const reply = await b.runtime.chat('t1', 'continue');
      expect(reply.workflow?.status).toBe('done');
      expect(reply.message).toContain('the job finished');
      // Step 1 was never re-run on runtime B (its prompt would carry
      // step 1's own instruction after "This step:"; the overall-job
      // line legitimately repeats the original ask in every prompt).
      expect(
        backendB.planCalls.some((c) => c.userText.includes('This step: Write the magic value into B2.')),
      ).toBe(false);
      expect(b.runtime.getWorkflow('t1')?.status).toBe('done');
    } finally {
      await b.runtime.close();
    }
  });
});

describe('job plan parsing (openaiBackend)', () => {
  it('accepts a valid plan and drops unusable checks', () => {
    const plan = parseJobPlan({
      steps: [
        {
          title: 'Fill the column',
          instruction: 'Fill D2:D13 with shares.',
          checks: [
            { kind: 'range-filled', sheet: 'Sales', startRow: 1, startCol: 3, endRow: 12, endCol: 3 },
            { kind: 'bogus', sheet: 'Sales' },
            { kind: 'cell-equals', sheet: 'Sales', row: 'x', col: 1, equals: 5 },
          ],
        },
        { title: 'Report', instruction: 'Report the result.' },
      ],
    });
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[0]?.checks).toEqual([
      { kind: 'range-filled', sheet: 'Sales', startRow: 1, startCol: 3, endRow: 12, endCol: 3 },
    ]);
  });

  it('rejects empty or step-less plans', () => {
    expect(() => parseJobPlan({ steps: [] })).toThrow();
    expect(() => parseJobPlan({ steps: [{ title: '', instruction: '' }] })).toThrow();
    expect(() => parseJobPlan('nope')).toThrow();
  });

  it('preserves a declared expectedChange and drops an invalid one (#151)', () => {
    const plan = parseJobPlan({
      steps: [
        { title: 'Build', instruction: 'Build the app.', expectedChange: 'app-create' },
        { title: 'Write', instruction: 'Write the value.', expectedChange: 'sheet-write' },
        { title: 'Tell', instruction: 'Tell the user.', expectedChange: 'none' },
        { title: 'Bogus', instruction: 'Do a thing.', expectedChange: 'cell-write' },
        { title: 'Silent', instruction: 'Do a thing.' },
      ],
    });
    expect(plan.steps[0]?.expectedChange).toBe('app-create');
    expect(plan.steps[1]?.expectedChange).toBe('sheet-write');
    expect(plan.steps[2]?.expectedChange).toBe('none');
    expect(plan.steps[3]?.expectedChange).toBeUndefined();
    expect(plan.steps[4]?.expectedChange).toBeUndefined();
  });
});

describe('workflow record persistence (workflows.ts)', () => {
  it('round-trips and sanitizes corrupt fields', () => {
    const raw = {
      version: 1,
      id: 'wf-test',
      threadId: 't1',
      userId: 'test-user',
      originText: 'Do the job.',
      status: 'running',
      currentStep: 1,
      steering: ['note'],
      steps: [
        { title: 'One', instruction: 'Do one.', status: 'done', attempts: 1 },
        {
          title: 'Two',
          instruction: 'Do two.',
          status: 'bogus',
          attempts: -3,
          expectedChange: 'sheet-write',
          checks: [{ kind: 'sheet-exists', sheet: 'Data' }, { kind: 'nope' }],
        },
      ],
      createdAt: 1,
      updatedAt: 2,
    };
    const wf = migrateWorkflow(raw);
    expect(wf?.status).toBe('running');
    expect(wf?.steps[1]?.status).toBe('pending'); // bogus status sanitized
    expect(wf?.steps[1]?.attempts).toBe(0);
    expect(wf?.steps[1]?.expectedChange).toBe('sheet-write'); // #151 declaration survives sanitize
    expect(wf?.steps[1]?.checks).toEqual([{ kind: 'sheet-exists', sheet: 'Data' }]);
    const back = deserializeWorkflows(serializeWorkflows('test-user', [wf!]));
    expect(back.length).toBe(1);
    expect(back[0]?.id).toBe('wf-test');
    expect(deserializeWorkflows('not json')).toEqual([]);
  });
});

describe('#151 declared-change verification (owner-refined shape)', () => {
  // Verification is driven ONLY by the LLM planner's per-step
  // expectedChange declaration: 'app-create' verifies only the
  // created artifact, 'sheet-write' verifies only a sheet change,
  // 'none' (or absent) verifies nothing at all. No default check is
  // ever imposed from the step's wording — that default was the bug:
  // an app step failed 3/3 with "no write landed" although app
  // generation writes no cells.

  async function seedSchedule(host: EngineHost): Promise<void> {
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'Time' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'Event' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: '09:00' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 1 }, value: 'Standup' });
  }

  const appPlan: JobPlan = {
    steps: [
      {
        title: 'Create the KPI dashboard app',
        instruction: 'Create the KPI dashboard app for the workbook data.',
        expectedChange: 'app-create',
      },
      {
        title: 'Report back',
        instruction: 'Tell the user the app is ready.',
        expectedChange: 'none',
      },
    ],
  };

  it('an app step declared app-create verifies by the artifact and the artifact rides the done reply', async () => {
    const store = createArtifactStore(memoryPersistence());
    const backend = scriptedBackend({
      plans: [appPlan],
      onPlan: (input) => {
        if (input.userText.includes('This step: Create the KPI dashboard app')) {
          return input.iteration === 1
            ? {
                message: 'Building the app.',
                actions: [{ type: 'tool', tool: 'generate_app', args: { prompt: 'KPI dashboard app' } }],
              }
            : doneWith('Dashboard app created.');
        }
        if (input.userText.includes('This step: Tell the user the app is ready')) {
          return doneWith('Your KPI dashboard app is ready.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { host, runtime } = await makeRuntime({
      backend,
      artifactStore: store,
      appGenerator: new TemplateAppGenerator(),
    });
    try {
      await seedSchedule(host);
      const reply = await runtime.chat('t1', 'Build me a KPI dashboard app and then confirm it is ready.');
      expect(reply.workflow?.status).toBe('done');
      expect(reply.workflow?.stepsCompleted).toBe(2);
      // The artifact propagates from the app step through the done
      // reply (pill + auto-open), not just from a last step.
      expect(reply.artifact).toBeDefined();
      expect(reply.artifact!.kind).toBe('react-app');
      expect(store.all()).toHaveLength(1);
      expect(store.all()[0].id).toBe(reply.artifact!.id);
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[0]?.verification).toContain('app artifact');
      expect(wf?.steps[0]?.verification).not.toContain('no write landed');
    } finally {
      await runtime.close();
    }
  });

  it('an app step declared app-create that produces no app goes stuck with an app detail, never "no write landed"', async () => {
    const backend = scriptedBackend({
      plans: [appPlan, appPlan],
      onPlan: (input) => {
        if (input.userText.includes('This step: Create the KPI dashboard app')) {
          return doneWith('I made an app (no tool call).');
        }
        if (input.userText.includes('This step: Tell the user the app is ready')) {
          return doneWith('Your KPI dashboard app is ready.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'Build me a KPI dashboard app and then confirm it is ready.');
      expect(reply.workflow?.status).toBe('stuck');
      expect(reply.artifact).toBeUndefined();
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[0]?.attempts).toBe(3);
      expect(wf?.steps[0]?.verification).toContain('no app artifact');
      expect(wf?.steps[0]?.verification).not.toContain('no write landed');
    } finally {
      await runtime.close();
    }
  });

  it('a sheet-write step declared sheet-write that lands no write still fails with "no write landed"', async () => {
    const plan: JobPlan = {
      steps: [
        {
          title: 'Write the value',
          instruction: 'Write 42 into cell B2 of Sheet1.',
          expectedChange: 'sheet-write',
        },
        {
          title: 'Report back',
          instruction: 'Tell the user the value landed.',
          expectedChange: 'none',
        },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan, plan],
      onPlan: (input) => {
        if (input.userText.includes('This step: Write 42 into cell B2')) {
          return doneWith('Wrote 42 into B2 (no tool call).');
        }
        if (input.userText.includes('This step: Tell the user the value landed')) {
          return doneWith('The value 42 landed in B2.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'Do the sheet write and then report back.');
      expect(reply.workflow?.status).toBe('stuck');
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[0]?.attempts).toBe(3);
      expect(wf?.steps[0]?.verification).toContain('no write landed');
    } finally {
      await runtime.close();
    }
  });

  it('a step declared no change passes in one attempt with no verification', async () => {
    const plan: JobPlan = {
      steps: [
        {
          title: 'Answer the question',
          instruction: 'Answer: the capital of France is Paris.',
          expectedChange: 'none',
        },
        {
          title: 'Report back',
          instruction: 'Tell the user the answer is Paris.',
          expectedChange: 'none',
        },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: (input) => {
        if (input.userText.includes('This step: Answer: the capital')) {
          return doneWith('The capital of France is Paris.');
        }
        if (input.userText.includes('This step: Tell the user the answer is Paris')) {
          return doneWith('Confirmed: Paris.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'Answer my question and then confirm.');
      expect(reply.workflow?.status).toBe('done');
      expect(reply.workflow?.stepsCompleted).toBe(2);
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[0]?.attempts).toBe(1);
      expect(wf?.steps[0]?.verification).toContain('nothing to verify');
      expect(wf?.steps[1]?.verification).toContain('nothing to verify');
    } finally {
      await runtime.close();
    }
  });

  it('a failed app step is never re-planned into sheet writes that clear existing data (#161)', async () => {
    // v3: after repeated generate_app rejections, the failure re-plan
    // substituted an "Initialize Dashboard structure" sheet-write step,
    // which cleared the totals a previous turn had written. The guard
    // drops sheet-write replacements after an app failure, so the job
    // stops visibly and the existing cells survive.
    const store = createArtifactStore(memoryPersistence());
    const failingGenerator: AppGenerator = {
      name: 'failing',
      generate: async () => {
        throw new Error(
          "LLM-generated source does not use the design system and was rejected after one repair attempt: bare <button> without its DaisyUI 'btn' class renders as a native control.",
        );
      },
    };
    const sheetSubstitute: JobPlan = {
      steps: [
        {
          title: 'Initialize Dashboard structure',
          instruction: 'Initialize the Dashboard structure in Sheet1, clearing the old totals row first.',
          expectedChange: 'sheet-write',
        },
      ],
    };
    let substituteRan = false;
    const backend = scriptedBackend({
      plans: [appPlan, sheetSubstitute],
      onPlan: (input) => {
        if (input.userText.includes('This step: Initialize Dashboard structure')) {
          substituteRan = true;
          return input.iteration === 1
            ? {
                message: 'Initializing.',
                actions: [
                  {
                    type: 'tool',
                    tool: 'write_cells',
                    args: {
                      cells: [
                        { sheet: 'Sheet1', row: 0, col: 0, value: '' },
                        { sheet: 'Sheet1', row: 0, col: 1, value: '' },
                      ],
                    },
                  },
                ],
              }
            : doneWith('Initialized.');
        }
        if (input.userText.includes('This step: Create the KPI dashboard app')) {
          return {
            message: 'Building the app.',
            actions: [{ type: 'tool', tool: 'generate_app', args: { prompt: 'KPI dashboard app' } }],
          };
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { host, runtime } = await makeRuntime({
      backend,
      maxIterations: 2,
      artifactStore: store,
      appGenerator: failingGenerator,
    });
    try {
      // The v3 totals row, seeded directly (not via a chat turn, so no
      // planJob call is consumed before the app workflow starts).
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1501837.91 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 945097.33 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 2 }, value: 301572.03 });
      const reply = await runtime.chat('t1', 'Build me a KPI dashboard app and then confirm it is ready.');
      expect(reply.workflow?.status).toBe('stuck');
      expect(reply.message).toContain('I got stuck on step 1 of 2');
      expect(substituteRan).toBe(false);
      // Read-back proves the untouched sheet intact (the #161 requirement).
      expect(cellValue(host, 0, 0)).toBe(1501837.91);
      expect(cellValue(host, 0, 1)).toBe(945097.33);
      expect(cellValue(host, 0, 2)).toBe(301572.03);
      expect(backend.planJobCalls.length).toBe(2); // initial plan + one re-plan (rejected by the guard)
    } finally {
      await runtime.close();
    }
  });
});

describe('declaration-frame fix: planner binds checks to discovered schema', () => {
  it('re-plans the remainder after a discovery step, carrying the describe_sheet result', async () => {
    // Initial plan: the compute step's check range is invented blind
    // (rows 1-1, the relative frame) — exactly the live failure.
    const initialPlan: JobPlan = {
      steps: [
        {
          title: 'Discover Sheet1 schema',
          instruction: 'Call describe_sheet on Sheet1 and report the schema.',
          expectedChange: 'none',
        },
        {
          title: 'Total the values',
          instruction: 'Write the total of the values into B9.',
          expectedChange: 'sheet-write',
          checks: [
            {
              kind: 'cell-sum-equals',
              sheet: 'Sheet1',
              row: 8,
              col: 1,
              sourceSheet: 'Sheet1',
              sourceStartRow: 1,
              sourceStartCol: 1,
              sourceEndRow: 1,
              sourceEndCol: 10,
            },
          ],
        },
      ],
    };
    const replacementPlan: JobPlan = {
      steps: [
        {
          title: 'Total the values',
          instruction: 'Write the total of the values into B9.',
          expectedChange: 'sheet-write',
          checks: [{ kind: 'sheet-exists', sheet: 'Sheet1' }],
        },
      ],
    };
    const backend = scriptedBackend({
      plans: [initialPlan, replacementPlan],
      onPlan: (input) => {
        // Step loops carry the step prompt as userText; only the
        // discovery step's loop calls describe_sheet, once.
        if (input.userText.startsWith('[Step 1 of')) {
          if (input.toolResults.some((r) => r.tool === 'describe_sheet')) {
            return doneWith('Schema discovered.');
          }
          return {
            message: 'Discovering schema.',
            actions: [
              { type: 'tool', tool: 'describe_sheet', args: { sheet: 'Sheet1' } },
            ],
          };
        }
        return doneWith('Total step done.');
      },
    });
    const { host, runtime } = await makeRuntime({ backend });
    try {
      // Seed Sheet1 so describe_sheet has a used range.
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 5, col: 0 }, value: 'Income Statement' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 5, col: 1 }, value: 2012 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 6, col: 0 }, value: 'Revenue' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 6, col: 1 }, value: 100 });
      const reply = await runtime.chat('t1', 'Discover the Sheet1 schema, then total the values.');
      expect(reply.workflow?.status).toBe('done');
      // Exactly one re-plan: initial plan + discovery re-plan.
      expect(backend.planJobCalls.length).toBe(2);
      const schema = backend.planJobCalls[1]?.toolResults?.find(
        (r) => r.tool === 'describe_sheet',
      );
      expect(schema?.ok).toBe(true);
      expect(JSON.stringify(schema?.data)).toContain('coordinateFrame');
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[0]?.status).toBe('done');
      // The stale declared range is gone: step 2 carries the
      // replacement plan's check, not the initial rows 1-1 range.
      expect(wf?.steps[1]?.checks).toEqual([{ kind: 'sheet-exists', sheet: 'Sheet1' }]);
    } finally {
      await runtime.close();
    }
  });

  it('failure re-plan carries describe_sheet results for the failed step\'s sheets', async () => {
    const badPlan: JobPlan = {
      steps: [
        {
          title: 'Write the magic value',
          instruction: 'Write the magic value into B2.',
          expectedChange: 'sheet-write',
          checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 99 }],
        },
        { title: 'Report back', instruction: 'Tell the user it is done.' },
      ],
    };
    const replan: JobPlan = {
      steps: [
        {
          title: 'Write the magic value carefully',
          instruction: 'Write the magic value into B2 carefully.',
          expectedChange: 'sheet-write',
          checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 99 }],
        },
        { title: 'Report back', instruction: 'Tell the user it is done.' },
      ],
    };
    const backend = scriptedBackend({
      plans: [badPlan, replan],
      onPlan: (input) => {
        if (input.userText.includes('magic value')) {
          if (input.iteration === 1) return writeB2(1);
          return doneWith('Wrote a value into B2.');
        }
        if (input.userText.includes('Tell the user')) return doneWith('All done.');
        return doneWith('Unexpected prompt.');
      },
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const stuck = await runtime.chat('t1', 'Write the magic value into B2 and then report back.');
      expect(stuck.workflow?.status).toBe('stuck');
      expect(backend.planJobCalls.length).toBe(2); // initial plan + one re-plan
      const schema = backend.planJobCalls[1]?.toolResults?.find(
        (r) => r.tool === 'describe_sheet',
      );
      expect(schema?.ok).toBe(true);
      expect(JSON.stringify(schema?.data)).toContain('coordinateFrame');
    } finally {
      await runtime.close();
    }
  });
});

describe('round-2 v3 fixes: chart-step verification + overshoot guard (#162, leg B2)', () => {
  it('normalizeStepDeclaration corrects a misdeclared chart step, leaves app steps alone', () => {
    // The live misdeclaration: 'Create revenue chart' declared app-create.
    expect(
      normalizeStepDeclaration(
        'Create revenue chart',
        'Create a column chart of revenue by year on Sheet1 with create_chart.',
        'app-create',
      ),
    ).toBe('sheet-write');
    // A chat-chart step names analyze_data: it changes nothing in the sheet.
    expect(
      normalizeStepDeclaration(
        'Show revenue chart',
        'Show the chart in the chat reply with analyze_data.',
        'app-create',
      ),
    ).toBe('none');
    // Genuine app steps — including an app WITH a chart — keep app-create.
    expect(
      normalizeStepDeclaration(
        'Create KPI and Chart App',
        'Build an app with KPI cards and a chart via generate_app.',
        'app-create',
      ),
    ).toBe('app-create');
    expect(
      normalizeStepDeclaration('Build dashboard', 'Build the app via generate_app.', 'app-create'),
    ).toBe('app-create');
    // Non-app-create declarations and absent declarations are untouched.
    expect(
      normalizeStepDeclaration('Write totals', 'Write the total into B2.', 'sheet-write'),
    ).toBe('sheet-write');
    expect(normalizeStepDeclaration('Read data', 'Read Sheet1.', undefined)).toBeUndefined();
  });

  it('stepAllowsNativeChart admits only steps about native chart creation', () => {
    expect(stepAllowsNativeChart('Create revenue chart')).toBe(true);
    expect(stepAllowsNativeChart('Discover Sheet1 schema')).toBe(false);
    expect(stepAllowsNativeChart('Show chart in the chat reply with analyze_data')).toBe(false);
    expect(stepAllowsNativeChart('Create KPI and Chart App')).toBe(false);
    expect(stepAllowsNativeChart('Create chart in the app')).toBe(false);
  });

  it('a misdeclared chart step verifies as a sheet write, not as an app step (#162)', async () => {
    // End-to-end dispatch: the step declares app-create but executes
    // a sheet write. Without normalization, verification would demand
    // an app artifact and fail; with it, the write effect verifies.
    const plan: JobPlan = {
      steps: [
        {
          title: 'Create revenue chart',
          instruction: 'Create a column chart of revenue by year on Sheet1 with create_chart.',
          expectedChange: 'app-create',
        },
        { title: 'Report back', instruction: 'Tell the user the chart is ready.' },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: (input) => {
        if (input.userText.includes('This step: Create a column chart')) {
          return input.iteration === 1
            ? {
                message: 'Charting.',
                actions: [
                  {
                    type: 'tool',
                    tool: 'write_cells',
                    args: { cells: [{ sheet: 'Sheet1', row: 0, col: 0, value: 1 }] },
                  },
                ],
              }
            : doneWith('Chart created.');
        }
        if (input.userText.includes('This step: Tell the user the chart is ready.')) {
          return doneWith('The chart is ready.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { host, runtime } = await makeRuntime({ backend });
    try {
      // Round-3: the prompt must carry placement wording for a
      // native-chart workflow — a bare "chart the revenue" is a
      // Gate 1(a) chat-chart request and the guard discards its plan.
      const reply = await runtime.chat('t1', 'Add a chart to the Sheet1 sheet for the revenue and confirm.');
      expect(reply.workflow?.status).toBe('done');
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[0]?.expectedChange).toBe('sheet-write');
      expect(wf?.steps[0]?.verification).toContain('sheet change verified');
      expect(cellValue(host, 0, 0)).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it('a discovery step that overshoots into create_chart is refused before MCP (leg B2)', async () => {
    // The recording sink is the discriminator: without the guard, the
    // step-1 overshoot would reach it (1 chart); with the guard, the
    // refusal happens before any MCP call (0 charts) and the workflow
    // still completes via the genuine step-2 chart step.
    const captured: unknown[] = [];
    const host = new EngineHost();
    const server: McpServer = createServer(host, {
      charts: {
        addChart: async (spec) => {
          captured.push(spec);
          return { id: 1, revision: 1 };
        },
      },
    });
    const plan: JobPlan = {
      steps: [
        {
          title: 'Discover Sheet1 schema',
          instruction: 'Discover the Sheet1 schema with describe_sheet.',
          expectedChange: 'none',
        },
        {
          title: 'Create revenue chart',
          instruction: 'Create a column chart of revenue by year on Sheet1 with create_chart.',
          expectedChange: 'sheet-write',
        },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: (input) => {
        if (input.userText.includes('This step: Discover the Sheet1 schema')) {
          return input.iteration === 1
            ? {
                message: 'Discovering.',
                actions: [
                  { type: 'tool', tool: 'describe_sheet', args: { sheet: 'Sheet1' } },
                  {
                    type: 'tool',
                    tool: 'create_chart',
                    args: { sheet: 'Sheet1', range: 'A1:B4', kind: 'column', title: 'Overshoot' },
                  },
                ],
              }
            : doneWith('Schema discovered; chart refused as out of scope.');
        }
        if (input.userText.includes('This step: Create a column chart')) {
          return input.iteration === 1
            ? {
                message: 'Charting.',
                actions: [
                  {
                    type: 'tool',
                    tool: 'write_cells',
                    // An EMPTY cell: overwriting a seeded header would
                    // (correctly) trigger the §7 confirmation wait and
                    // hang the test with no human to answer it.
                    args: { cells: [{ sheet: 'Sheet1', row: 5, col: 0, value: 7 }] },
                  },
                ],
              }
            : doneWith('Chart step done.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const runtime = new AgentRuntime({
      server,
      principal: 'test-user',
      maxIterations: 5,
      backend,
    });
    try {
      // describe_sheet fails on an empty sheet, so seed data first:
      // the discovery step must have a real (successful) read for
      // the guard's refusal to be the only failed call in its segment.
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'Year' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'Revenue' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 2012 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 1 }, value: 102007 });
      // Round-3: same placement-wording note as the #162 test above.
      const reply = await runtime.chat('t1', 'Discover the schema, then add a chart to the Sheet1 sheet.');
      expect(reply.workflow?.status).toBe('done');
      expect(captured).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('a re-planned action step with zero tool calls fails honestly instead of completing vacuously (#162)', async () => {
    // Leg A: a re-planned 'Analyze revenue data' step with no tool
    // call 'completed' a chart job that produced nothing. An action
    // step with no effects now fails verification, so the job goes
    // stuck visibly instead of claiming completion. Pure answer steps
    // (case7sql pin: 'Identify the region...') still pass — they are
    // not action steps, and their effect IS the answer.
    const plan: JobPlan = {
      steps: [
        {
          title: 'Read the revenue data',
          instruction: 'Read the revenue values from Sheet1 with read_cells.',
          expectedChange: 'none',
        },
        {
          title: 'Analyze revenue data',
          instruction: 'Analyze the revenue data and report the trend.',
          expectedChange: 'none',
        },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: (input) => {
        if (input.userText.includes('This step: Read the revenue values')) {
          return input.iteration === 1
            ? {
                message: 'Reading.',
                actions: [
                  {
                    type: 'tool',
                    tool: 'read_cells',
                    args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
                  },
                ],
              }
            : doneWith('Read.');
        }
        if (input.userText.includes('This step: Analyze the revenue data')) {
          return doneWith('Revenue rises steadily.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { runtime } = await makeRuntime({ backend, maxIterations: 2 });
    try {
      const reply = await runtime.chat('t1', 'Read and analyze the revenue.');
      expect(reply.workflow?.status).toBe('stuck');
      expect(reply.message).toContain('I got stuck on step 2 of 2');
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[1]?.verification).toContain('the step produced no effects');
    } finally {
      await runtime.close();
    }
  });
});

describe('round-3 mechanical Gate 1(a) + exhaustion verification', () => {
  it('isChatChartRequest classifies Gate 1(a) shapes only', () => {
    // The exact R3 prompt: sheet named as DATA SOURCE, not placement.
    expect(
      isChatChartRequest(
        'Create a small chart of revenue by year from the Income sheet, using the real numbers from the file.',
      ),
    ).toBe(true);
    expect(isChatChartRequest('Show me a graph of sales by month')).toBe(true);
    expect(isChatChartRequest('Visualize the revenue data')).toBe(true);
    // "Add a chart" without a "to" destination + a source phrase stays chat.
    expect(isChatChartRequest('Add a chart of revenue by year from the Income sheet')).toBe(true);
    // Placement wording -> native, not chat.
    expect(isChatChartRequest('Add a chart to the Income sheet showing revenue by year')).toBe(false);
    expect(isChatChartRequest('Insert a chart of revenue')).toBe(false);
    expect(isChatChartRequest('Create a chart in the Sheet1 sheet')).toBe(false);
    expect(isChatChartRequest('Put a chart on the Dashboard sheet')).toBe(false);
    expect(isChatChartRequest('Create a native chart of revenue')).toBe(false);
    // Chart plus other work (Gate 1(c)) -> planner keeps it.
    expect(isChatChartRequest('Create a chart of revenue by year and show me the totals')).toBe(false);
    expect(isChatChartRequest('Build an app with a chart of revenue')).toBe(false);
    // No chart language at all.
    expect(isChatChartRequest('What is the total revenue?')).toBe(false);
  });

  it('a violating multi-step plan for a chat-chart request is discarded to the plain loop', async () => {
    // The round-2 leg-A shape: the planner returns discovery +
    // create_chart for the R3 prompt. The guard must not run it as a
    // workflow; the turn goes plain instead.
    const plan: JobPlan = {
      steps: [
        {
          title: 'Discover Income sheet schema',
          instruction: 'Discover the Income sheet schema with describe_sheet.',
          expectedChange: 'none',
        },
        {
          title: 'Create revenue chart',
          instruction: 'Create a column chart of revenue by year on Sheet1 with create_chart.',
          expectedChange: 'sheet-write',
        },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: () => doneWith('Here is your chart.'),
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat(
        't1',
        'Create a small chart of revenue by year from the Income sheet, using the real numbers from the file.',
      );
      expect(reply.workflow).toBeUndefined();
      expect(runtime.getWorkflow('t1')).toBeNull();
      expect(backend.planJobCalls).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('the same plan shape for a native prompt still runs as a workflow', async () => {
    const plan: JobPlan = {
      steps: [
        {
          title: 'Create revenue chart',
          instruction: 'Create a column chart of revenue by year on Sheet1 with create_chart.',
          expectedChange: 'sheet-write',
        },
        { title: 'Report back', instruction: 'Tell the user the chart is ready.' },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: (input) => {
        // Step prompts carry the INSTRUCTION ("This step: Create a
        // column chart ..."), not the title.
        if (input.userText.includes('This step: Create a column chart')) {
          return input.iteration === 1
            ? {
                message: 'Charting.',
                actions: [
                  {
                    type: 'tool',
                    tool: 'write_cells',
                    args: { cells: [{ sheet: 'Sheet1', row: 5, col: 0, value: 7 }] },
                  },
                ],
              }
            : doneWith('Chart step done.');
        }
        if (input.userText.includes('This step: Tell the user the chart is ready.')) {
          return doneWith('The chart is ready.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { runtime } = await makeRuntime({ backend });
    try {
      const reply = await runtime.chat('t1', 'Add a chart to the Sheet1 sheet showing revenue by year.');
      expect(reply.workflow?.status).toBe('done');
    } finally {
      await runtime.close();
    }
  });

  it('an exhausted chart step whose create_chart landed still completes (leg B)', async () => {
    // Leg-B attempt-1 shape: the loop exhausts on its last iteration
    // right after a successful create_chart, never producing the
    // concluding 'done' plan. Verification on exhaustion must complete
    // the step instead of failing it.
    const captured: unknown[] = [];
    const host = new EngineHost();
    const server: McpServer = createServer(host, {
      charts: {
        addChart: async (spec) => {
          captured.push(spec);
          return { id: 1, revision: 1 };
        },
      },
    });
    const plan: JobPlan = {
      steps: [
        {
          title: 'Create revenue chart',
          instruction: 'Create a column chart of revenue by year on Sheet1 with create_chart.',
          expectedChange: 'sheet-write',
        },
        { title: 'Report back', instruction: 'Tell the user the chart is ready.' },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: (input) => {
        if (input.userText.includes('This step: Create a column chart')) {
          // Never a 'done' plan: every iteration calls create_chart,
          // so the loop exhausts with the effect landed.
          return {
            message: 'Charting.',
            actions: [
              {
                type: 'tool',
                tool: 'create_chart',
                args: { sheet: 'Sheet1', range: 'A1:B2', kind: 'column', title: 'Revenue' },
              },
            ],
          };
        }
        if (input.userText.includes('This step: Tell the user the chart is ready.')) {
          return doneWith('The chart is ready.');
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const runtime = new AgentRuntime({
      server,
      principal: 'test-user',
      maxIterations: 1,
      backend,
    });
    try {
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'Year' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'Revenue' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 2012 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 1 }, value: 102007 });
      const reply = await runtime.chat('t1', 'Add a chart to the Sheet1 sheet showing revenue by year.');
      expect(reply.workflow?.status).toBe('done');
      expect(captured).toHaveLength(1);
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[0]?.verification).toContain('sheet change verified');
    } finally {
      await runtime.close();
    }
  });

  it('an exhausted undeclared step still fails instead of completing vacuously', async () => {
    // Narrow scope pin: exhaustion-verification runs ONLY for
    // verifiable steps (checks, sheet-write, app-create). A 'none'
    // step that never answers still goes stuck — even when its reads
    // landed, because its product is the answer it never gave. Two
    // steps so the exhausting step runs inside a workflow (a lone
    // step would take the plain path + promotion instead).
    const plan: JobPlan = {
      steps: [
        {
          title: 'Read the revenue data',
          instruction: 'Read the revenue values from Sheet1 with read_cells.',
          expectedChange: 'none',
        },
        {
          title: 'Fetch the revenue data',
          instruction: 'Fetch the revenue values from Sheet1 with read_cells.',
          expectedChange: 'none',
        },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: (input) => {
        if (input.userText.includes('This step: Read the revenue values')) {
          return input.iteration === 1
            ? {
                message: 'Reading.',
                actions: [
                  {
                    type: 'tool',
                    tool: 'read_cells',
                    args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
                  },
                ],
              }
            : doneWith('Read.');
        }
        if (input.userText.includes('This step: Fetch the revenue values')) {
          // Never a 'done' plan: the loop exhausts with reads landed.
          return {
            message: 'Fetching.',
            actions: [
              {
                type: 'tool',
                tool: 'read_cells',
                args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
              },
            ],
          };
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { host, runtime } = await makeRuntime({ backend, maxIterations: 1 });
    try {
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'Year' });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'Revenue' });
      const reply = await runtime.chat('t1', 'Read the revenue data, then fetch it again.');
      expect(reply.workflow?.status).toBe('stuck');
    } finally {
      await runtime.close();
    }
  });
});

describe('#165 false completion on zero-effect exhausted chart steps', () => {
  // Round-4 leg B shape: the re-planned 'Create revenue chart' step
  // carried machine checks that measure PRE-EXISTING state (here a
  // sheet-exists check), and all 9 create_chart calls were refused by
  // the MCP trap guard — yet the workflow reported 'complete: all 2
  // steps done' with zero canvases. The round-3 exhaustion change let
  // verification run on exhausted steps, and the checks branch
  // short-circuits the declaration branches, so a chart step passed
  // on checks alone with no chart landed. A chart step must land a
  // chart effect; checks about pre-existing state cannot substitute.
  const seedIncomeBlock = (host: EngineHost): void => {
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 4, col: 1 }, value: 'Year' });
    const years = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021];
    const revenue = [
      102007, 118086, 131345, 142341, 150772, 158310.6, 165434.577,
      172051.96008, 178073.77868279998, 183415.99204328397,
    ];
    years.forEach((y, i) => {
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 5, col: 1 + i }, value: y });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 6, col: 1 + i }, value: revenue[i] });
    });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 5, col: 0 }, value: 'Income Statement' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 6, col: 0 }, value: 'Revenue' });
  };

  const chartPlan = (): JobPlan => ({
    steps: [
      {
        title: 'Discover Sheet1 schema',
        instruction: 'Discover the Sheet1 sheet schema with describe_sheet.',
        expectedChange: 'none',
      },
      {
        title: 'Create revenue chart',
        instruction: 'Create a column chart of revenue by year on Sheet1 with create_chart.',
        expectedChange: 'sheet-write',
        // The re-plan shape: a machine check about pre-existing state,
        // which passes whether or not any chart lands.
        checks: [{ kind: 'sheet-exists', sheet: 'Sheet1' }],
      },
    ],
  });

  const chartBackend = (range: string): ScriptedBackend =>
    scriptedBackend({
      plans: [chartPlan()],
      onPlan: (input) => {
        if (input.userText.includes('This step: Discover the Sheet1 sheet schema')) {
          return input.iteration === 1
            ? {
                message: 'Discovering.',
                actions: [
                  { type: 'tool', tool: 'describe_sheet', args: { sheet: 'Sheet1' } },
                ],
              }
            : doneWith('Schema discovered.');
        }
        if (input.userText.includes('This step: Create a column chart')) {
          // Never a 'done' plan: every iteration calls create_chart,
          // so the loop exhausts. The range decides the outcome: the
          // B5:K6 trap range is refused by the MCP trap guard, while
          // A6:K7 (years row + revenue row) lands a real chart.
          return {
            message: 'Charting.',
            actions: [
              {
                type: 'tool',
                tool: 'create_chart',
                args: { sheet: 'Sheet1', range, kind: 'column', title: 'Revenue' },
              },
            ],
          };
        }
        return doneWith('Unexpected prompt.');
      },
    });

  it('an exhausted chart step with only vacuous checks and zero landed charts FAILS', async () => {
    const host = new EngineHost();
    const server: McpServer = createServer(host);
    const backend = chartBackend('B5:K6');
    const runtime = new AgentRuntime({
      server,
      principal: 'test-user',
      maxIterations: 2,
      backend,
    });
    try {
      seedIncomeBlock(host);
      const reply = await runtime.chat(
        't1',
        'Add a chart to the Sheet1 sheet showing revenue by year.',
      );
      expect(reply.workflow?.status).toBe('stuck');
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[1]?.verification).toMatch(/no chart/i);
    } finally {
      await runtime.close();
    }
  });

  it('an exhausted chart step with passing checks AND a landed chart still completes', async () => {
    // Round-3 intent preserved WITH checks present: the floor is
    // about zero-effect steps, not about checks. A landed chart
    // satisfies it, and the passing checks then complete the step.
    const captured: unknown[] = [];
    const host = new EngineHost();
    const server: McpServer = createServer(host, {
      charts: {
        addChart: async (spec) => {
          captured.push(spec);
          return { id: 1, revision: 1 };
        },
      },
    });
    const backend = chartBackend('A6:K7');
    const runtime = new AgentRuntime({
      server,
      principal: 'test-user',
      maxIterations: 2,
      backend,
    });
    try {
      seedIncomeBlock(host);
      const reply = await runtime.chat(
        't1',
        'Add a chart to the Sheet1 sheet showing revenue by year.',
      );
      expect(reply.workflow?.status).toBe('done');
      expect(captured.length).toBeGreaterThanOrEqual(1);
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[1]?.verification).toContain('checks passed');
    } finally {
      await runtime.close();
    }
  });

  it('an exhausted-but-verified final step never leaks the ran-out-of-steps apology into the done reply', async () => {
    // User pin: a 3-step Sheet1 job replied with both
    // "I ran out of steps for that request. Could you break it into
    // smaller parts?" AND "Job complete — all 3 steps finished".
    // The last step exhausted its per-step budget after its write
    // landed, verified ok, and the done return reused the loop's
    // apology text as its lead-in. The done reply must read as a
    // success; the apology must not appear.
    const plan: JobPlan = {
      steps: [
        {
          title: 'Write the answer',
          instruction: 'Write 42 into cell B2 of Sheet1.',
          checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 1, col: 1, equals: 42 }],
        },
        {
          title: 'Append the estimate',
          instruction: 'Write 99 into cell C3 of Sheet1.',
          checks: [{ kind: 'cell-equals', sheet: 'Sheet1', row: 2, col: 2, equals: 99 }],
        },
      ],
    };
    const backend = scriptedBackend({
      plans: [plan],
      onPlan: (input) => {
        if (input.userText.includes('Write 42 into cell B2')) {
          return input.iteration === 1 ? writeB2(42) : doneWith('Wrote 42 into B2.');
        }
        if (input.userText.includes('Write 99 into cell C3')) {
          // Never a 'done' plan: every iteration writes, so the loop
          // exhausts with the effect landed — then verifies on checks.
          return {
            message: 'Writing.',
            actions: [
              {
                type: 'tool',
                tool: 'write_cells',
                args: { cells: [{ sheet: 'Sheet1', row: 2, col: 2, value: 99 }] },
              },
            ],
          };
        }
        return doneWith('Unexpected prompt.');
      },
    });
    const { host, runtime } = await makeRuntime({ backend, maxIterations: 1 });
    try {
      const reply = await runtime.chat('t1', 'Put the answer in B2, then append the estimate to C3.');
      expect(cellValue(host, 1, 1)).toBe(42);
      expect(cellValue(host, 2, 2)).toBe(99);
      expect(reply.workflow?.status).toBe('done');
      expect(reply.message).toContain('Job complete — all 2 steps finished');
      expect(reply.message).not.toMatch(/ran out of steps/i);
      const wf = runtime.getWorkflow('t1');
      expect(wf?.steps[1]?.resultSummary).not.toMatch(/ran out of steps/i);
    } finally {
      await runtime.close();
    }
  });
});

describe('round-4 plain-loop chart guard (leg A)', () => {
  const R3 =
    'Create a small chart of revenue by year from the Income sheet, using the real numbers from the file.';

  it('a plain-loop create_chart for a chat-chart request is refused before MCP, naming analyze_data', async () => {
    // Combined-proof leg A: the round-3 gate killed the workflow, but
    // the plain loop still picked create_chart for the exact R3 prompt.
    // The refusal must land before any MCP call (0 charts in the sink)
    // and the next plan must see it as a failed tool result carrying
    // the analyze_data correction.
    const captured: unknown[] = [];
    const host = new EngineHost();
    const server: McpServer = createServer(host, {
      charts: {
        addChart: async (spec) => {
          captured.push(spec);
          return { id: 1, revision: 1 };
        },
      },
    });
    const backend = scriptedBackend({
      onPlan: (input) =>
        input.iteration === 1
          ? {
              message: 'Charting.',
              actions: [
                {
                  type: 'tool',
                  tool: 'create_chart',
                  args: { sheet: 'Sheet1', range: 'A1:B2', kind: 'column', title: 'Revenue' },
                },
              ],
            }
          : doneWith('Chart shown in chat.'),
    });
    const runtime = new AgentRuntime({
      server,
      principal: 'test-user',
      maxIterations: 3,
      backend,
    });
    try {
      const reply = await runtime.chat('t1', R3);
      expect(captured).toHaveLength(0);
      expect(reply.workflow).toBeUndefined();
      const refusal = backend.planCalls[1]?.toolResults.find((r) => r.tool === 'create_chart');
      expect(refusal?.ok).toBe(false);
      expect(refusal?.summary).toContain('analyze_data');
    } finally {
      await runtime.close();
    }
  });

  it('a placement-wording plain-loop turn still places a native chart (guard fail-open)', async () => {
    const captured: unknown[] = [];
    const host = new EngineHost();
    const server: McpServer = createServer(host, {
      charts: {
        addChart: async (spec) => {
          captured.push(spec);
          return { id: 1, revision: 1 };
        },
      },
    });
    const backend = scriptedBackend({
      onPlan: (input) =>
        input.iteration === 1
          ? {
              message: 'Charting.',
              actions: [
                {
                  type: 'tool',
                  tool: 'create_chart',
                  args: { sheet: 'Sheet1', range: 'A1:C2', kind: 'column', title: 'Revenue' },
                },
              ],
            }
          : doneWith('Chart placed.'),
    });
    const runtime = new AgentRuntime({
      server,
      principal: 'test-user',
      maxIterations: 3,
      backend,
    });
    try {
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 2012 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 2013 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 2 }, value: 2014 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 102007 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 1 }, value: 118086 });
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 2 }, value: 131345 });
      await runtime.chat('t1', 'Add a chart to the Sheet1 sheet showing revenue by year.');
      expect(captured).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
});
