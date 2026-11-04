/**
 * Agent workflow records (design-docs/agent-workflows.md §2).
 *
 * A workflow is the durable form of a multi-step job: the plan as data
 * (ordered steps, each with a goal and completion checks), per-step
 * execution state, and the checkpoint the runtime resumes from after a
 * crash, a timeout, or a human-in-the-loop pause. Records live in the
 * service metadata store, per user, alongside the conversation threads
 * (ai-agent.md §9) — never in workbook bytes.
 *
 * Checkpoint discipline (§2.4): the runtime rewrites the record after
 * EVERY step transition (planned, started, attempt failed, verified,
 * done, and every status change), so the persisted state is never more
 * than one transition behind the live job.
 */
import type { JobStep, StepCheck, StepExpectedChange } from './types.js';
import type { Persistence } from '../metadataStore.js';
import { MetadataStore } from '../metadataStore.js';

/** Current workflow-record schema version. */
export const AGENT_WORKFLOW_VERSION = 1;

/** Storage key prefix; the full key is `<prefix>.<userId>`. */
export const AGENT_WORKFLOW_KEY_PREFIX = 'icecream-sheets.agent-workflows.v1';

/**
 * Workflow lifecycle. Terminal: done / halted / cancelled / superseded.
 * 'running' and 'stuck' are resumable: the next message on the thread
 * picks the job up from its checkpoint ('stuck' additionally resets the
 * stuck step's attempt counter — the user's message is presumed to
 * carry the unblocking information the stuck report asked for).
 */
export type WorkflowStatus =
  | 'running'
  | 'done'
  | 'stuck'
  | 'halted'
  | 'cancelled'
  | 'superseded';

/** Per-step execution state. */
export type WorkflowStepStatus = 'pending' | 'active' | 'done' | 'failed';

export interface WorkflowStepRecord extends JobStep {
  status: WorkflowStepStatus;
  /** Attempts spent on this step so far (plain + steering + re-planned). */
  attempts: number;
  /** Outcome of the last verification, human-readable (check detail or
   *  the effect-based verdict). Absent until the step is first verified. */
  verification?: string;
  /** What the step's final loop segment answered (bounded), kept so a
   *  resumed run — and the final report — can build on it. */
  resultSummary?: string;
}

export interface AgentWorkflow {
  version: number;
  id: string;
  threadId: string;
  userId: string;
  /** The user's original ask, verbatim (bounded by the chat input cap). */
  originText: string;
  status: WorkflowStatus;
  steps: WorkflowStepRecord[];
  /** Index of the step to run next / currently running. */
  currentStep: number;
  /**
   * How the current run was interrupted when status is 'running' but no
   * turn is driving it: a human gate timed out mid-step, or the process
   * died. The next step attempt is steered to verify state first.
   */
  interruptedPhase?: 'hitl-timeout' | 'process-exit';
  /** Plain-language reason recorded when the workflow stopped (stuck /
   *  halted / cancelled): what was attempted and what would unblock it. */
  stopDetail?: string;
  /** User messages received while the job was open, folded into the
   *  active step as steering (resume path). */
  steering: string[];
  createdAt: number;
  updatedAt: number;
}

/** On-disk envelope for a user's workflow list. */
export interface StoredWorkflows {
  version: number;
  userId: string;
  workflows: AgentWorkflow[];
}

/** Max workflows retained per user (oldest terminal ones dropped first). */
export const MAX_STORED_WORKFLOWS = 50;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const STEP_STATUSES: readonly string[] = ['pending', 'active', 'done', 'failed'];
const WORKFLOW_STATUSES: readonly string[] = [
  'running',
  'done',
  'stuck',
  'halted',
  'cancelled',
  'superseded',
];
const CHECK_KINDS: readonly string[] = [
  'cell-equals',
  'cell-nonempty',
  'range-filled',
  'sheet-exists',
  'column-sum-equals',
  'cell-sum-equals',
];

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Sanitize one persisted step check; null when the shape is unusable. */
export function sanitizeStepCheck(raw: unknown): StepCheck | null {
  if (!isObject(raw)) return null;
  if (typeof raw.kind !== 'string' || !CHECK_KINDS.includes(raw.kind)) return null;
  if (typeof raw.sheet !== 'string' || raw.sheet.length === 0) return null;
  const sheet = raw.sheet;
  switch (raw.kind) {
    case 'cell-equals': {
      if (!isFiniteNum(raw.row) || !isFiniteNum(raw.col)) return null;
      if (typeof raw.equals !== 'number' && typeof raw.equals !== 'string') return null;
      return { kind: 'cell-equals', sheet, row: raw.row, col: raw.col, equals: raw.equals };
    }
    case 'cell-nonempty': {
      if (!isFiniteNum(raw.row) || !isFiniteNum(raw.col)) return null;
      return { kind: 'cell-nonempty', sheet, row: raw.row, col: raw.col };
    }
    case 'range-filled': {
      if (
        !isFiniteNum(raw.startRow) ||
        !isFiniteNum(raw.startCol) ||
        !isFiniteNum(raw.endRow) ||
        !isFiniteNum(raw.endCol)
      ) {
        return null;
      }
      return {
        kind: 'range-filled',
        sheet,
        startRow: raw.startRow,
        startCol: raw.startCol,
        endRow: raw.endRow,
        endCol: raw.endCol,
      };
    }
    case 'sheet-exists':
      return { kind: 'sheet-exists', sheet };
    case 'column-sum-equals': {
      if (!isFiniteNum(raw.col) || !isFiniteNum(raw.startRow) || !isFiniteNum(raw.endRow)) {
        return null;
      }
      if (!isFiniteNum(raw.equals)) return null;
      return {
        kind: 'column-sum-equals',
        sheet,
        col: raw.col,
        startRow: raw.startRow,
        endRow: raw.endRow,
        equals: raw.equals,
      };
    }
    case 'cell-sum-equals': {
      // #155: same preserve-valid / drop-invalid semantics as every
      // other check — an unusable shape is dropped, never guessed.
      if (!isFiniteNum(raw.row) || !isFiniteNum(raw.col)) return null;
      if (typeof raw.sourceSheet !== 'string' || raw.sourceSheet.length === 0) return null;
      if (
        !isFiniteNum(raw.sourceStartRow) ||
        !isFiniteNum(raw.sourceStartCol) ||
        !isFiniteNum(raw.sourceEndRow) ||
        !isFiniteNum(raw.sourceEndCol)
      ) {
        return null;
      }
      return {
        kind: 'cell-sum-equals',
        sheet,
        row: raw.row,
        col: raw.col,
        sourceSheet: raw.sourceSheet,
        sourceStartRow: raw.sourceStartRow,
        sourceStartCol: raw.sourceStartCol,
        sourceEndRow: raw.sourceEndRow,
        sourceEndCol: raw.sourceEndCol,
      };
    }
    default:
      return null;
  }
}

function sanitizeStep(raw: unknown): WorkflowStepRecord | null {
  if (!isObject(raw)) return null;
  if (typeof raw.title !== 'string' || raw.title.length === 0) return null;
  if (typeof raw.instruction !== 'string' || raw.instruction.length === 0) return null;
  const checks = Array.isArray(raw.checks)
    ? raw.checks.map(sanitizeStepCheck).filter((c): c is StepCheck => c !== null)
    : [];
  // #151: carry the planner's declared expected change through a
  // persisted record; an invalid value is dropped (no declaration).
  // #162: the same chart-step misdeclaration correction as
  // newStepRecord, so a resumed workflow heals too.
  const expectedChange = normalizeStepDeclaration(
    raw.title,
    raw.instruction,
    raw.expectedChange === 'sheet-write' ||
      raw.expectedChange === 'app-create' ||
      raw.expectedChange === 'none'
      ? raw.expectedChange
      : undefined,
  );
  return {
    title: raw.title,
    instruction: raw.instruction,
    ...(expectedChange ? { expectedChange } : {}),
    ...(checks.length > 0 ? { checks } : {}),
    status:
      typeof raw.status === 'string' && STEP_STATUSES.includes(raw.status)
        ? (raw.status as WorkflowStepStatus)
        : 'pending',
    attempts: isFiniteNum(raw.attempts) && raw.attempts > 0 ? Math.floor(raw.attempts) : 0,
    ...(typeof raw.verification === 'string' ? { verification: raw.verification } : {}),
    ...(typeof raw.resultSummary === 'string' ? { resultSummary: raw.resultSummary } : {}),
  };
}

/** Migrate/sanitize one stored workflow record; null when unusable. */
export function migrateWorkflow(raw: unknown): AgentWorkflow | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (typeof raw.threadId !== 'string' || raw.threadId.length === 0) return null;
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version > AGENT_WORKFLOW_VERSION) return null; // from the future — don't guess
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map(sanitizeStep).filter((s): s is WorkflowStepRecord => s !== null)
    : [];
  const currentStep =
    isFiniteNum(raw.currentStep) && raw.currentStep > 0 ? Math.floor(raw.currentStep) : 0;
  return {
    version: AGENT_WORKFLOW_VERSION,
    id: raw.id,
    threadId: raw.threadId,
    userId: typeof raw.userId === 'string' ? raw.userId : '',
    originText: typeof raw.originText === 'string' ? raw.originText : '',
    status:
      typeof raw.status === 'string' && WORKFLOW_STATUSES.includes(raw.status)
        ? (raw.status as WorkflowStatus)
        : 'running',
    steps,
    currentStep: Math.min(currentStep, steps.length),
    ...(raw.interruptedPhase === 'hitl-timeout' || raw.interruptedPhase === 'process-exit'
      ? { interruptedPhase: raw.interruptedPhase }
      : {}),
    ...(typeof raw.stopDetail === 'string' ? { stopDetail: raw.stopDetail } : {}),
    steering: Array.isArray(raw.steering)
      ? raw.steering.filter((s): s is string => typeof s === 'string')
      : [],
    createdAt: isFiniteNum(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: isFiniteNum(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

/** Serialize a user's workflows for the metadata store. */
export function serializeWorkflows(userId: string, workflows: AgentWorkflow[]): string {
  const stored: StoredWorkflows = { version: AGENT_WORKFLOW_VERSION, userId, workflows };
  return JSON.stringify(stored);
}

/**
 * Deserialize workflows, migrating older versions forward.
 * Returns an empty list (not an exception) for corrupt payloads.
 */
export function deserializeWorkflows(json: string): AgentWorkflow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const stored = parsed as Partial<StoredWorkflows>;
  if (!Array.isArray(stored.workflows)) return [];
  const seen = new Set<string>();
  const out: AgentWorkflow[] = [];
  for (const raw of stored.workflows) {
    const w = migrateWorkflow(raw);
    if (w && !seen.has(w.id)) {
      seen.add(w.id);
      out.push(w);
    }
  }
  return out;
}

/**
 * Per-user agent-workflow store (ai-agent.md §9). Workflows are keyed
 * `icecream-sheets.agent-workflows.v1.<userId>` — per user, never in
 * workbook bytes.
 */
export function createAgentWorkflowStore(
  persistence: Persistence,
  userId: string,
): MetadataStore<AgentWorkflow> {
  if (!persistence) throw new Error('createAgentWorkflowStore requires a Persistence adapter');
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('createAgentWorkflowStore requires a non-empty userId');
  }
  return new MetadataStore<AgentWorkflow>(
    `${AGENT_WORKFLOW_KEY_PREFIX}.${userId}`,
    persistence,
    (workflows) => serializeWorkflows(userId, workflows),
    deserializeWorkflows,
  );
}

/**
 * #162: correct a planner misdeclaration on chart steps, mechanically.
 * The planner prompt's own taxonomy says charts-to-sheet are
 * "sheet-write" and analyze_data chat charts are "none" — but the
 * planner declared "app-create" on a plain 'Create revenue chart'
 * step (observed live, legs A/B2), so verification demanded an app
 * artifact that could never exist and the chart step failed
 * spuriously. A step declaring "app-create" that never mentions an
 * app but does mention a chart is that misdeclaration: rewrite it to
 * the taxonomy-correct kind (analyze_data → "none", otherwise
 * "sheet-write", since create_chart is a sheet write effect). This
 * never invents a change for an undeclared step, and never touches
 * steps that mention an app — genuine app steps, including
 * app-with-chart steps, keep "app-create".
 */
export function normalizeStepDeclaration(
  title: string,
  instruction: string,
  expectedChange: StepExpectedChange | undefined,
): StepExpectedChange | undefined {
  if (expectedChange !== 'app-create') return expectedChange;
  const text = `${title}\n${instruction}`;
  if (/\bapp\b/i.test(text)) return expectedChange;
  if (!/\bchart\b/i.test(text)) return expectedChange;
  return /analyze_data/.test(text) ? 'none' : 'sheet-write';
}

/**
 * Round-2 executor guard (discovery overshoot): a workflow step may
 * create a NATIVE chart only when the step itself is about native
 * chart creation — it names a chart, does not build an app (an app
 * step's chart belongs inside the app via generate_app, not on the
 * sheet), and does not name analyze_data (a chat-chart step must
 * never build a native chart). Steps failing this test get their
 * create_chart calls refused at execution, so a discovery step can
 * never overshoot into chart creation the way leg B2's step 1 did
 * (describe_sheet + create_chart inside 'Discover Income sheet
 * schema', duplicating the step-2 chart). Plain-loop turns carry no
 * step scope, so the guard is inactive outside workflows.
 */
export function stepAllowsNativeChart(stepText: string): boolean {
  return (
    /\bchart\b/i.test(stepText) &&
    !/\bapp\b/i.test(stepText) &&
    !/analyze_data/.test(stepText)
  );
}

/** A1 column letters for a 0-based column index. */
function colLetters(col: number): string {
  let c = col + 1;
  let letters = '';
  while (c > 0) {
    const m = (c - 1) % 26;
    letters = String.fromCharCode(65 + m) + letters;
    c = Math.floor((c - 1) / 26);
  }
  return letters;
}

/** A1-style cell reference for 0-based row/col. */
function a1Cell(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`;
}

/**
 * #151 coherence fix (part 1): the step text the agent follows and
 * the step's structured checks must agree on the write-target cells
 * in the SAME frame. The failing run proved the disagreement: the
 * planner's prose said "row 1, columns 1-3" (read 1-based by the
 * agent → Summaries A1:C1) while its cell-sum-equals checks read
 * B2:D2 (0-based), so the verifier read empty cells while the values
 * sat one row up and one column left — and the agent never sees
 * checks, so nothing corrected it. This renders each cell-sum-equals
 * check as one instruction line pairing the exact target cell with
 * the exact source range, in BOTH A1 and the 0-based numbers the
 * tools take, so the agent's write lands where verification reads
 * and its aggregates sum the range verification sums. Verification
 * semantics are unchanged: the runtime still recomputes from the
 * source and compares — the agent still has to do the work, and a
 * total written anywhere else still fails.
 *
 * Only cell-sum-equals checks are rendered: other check kinds either
 * carry no target the agent must write to (sheet-exists,
 * range-filled) or carry an EXPECTED VALUE (cell-equals,
 * column-sum-equals) that must never be handed to the agent — it
 * would let the agent copy the answer instead of computing it. A
 * cell-sum-equals source range is not an answer: the sum still has
 * to be computed and written.
 */
export function checkGroundingLines(checks: StepCheck[] | undefined): string[] {
  if (!checks) return [];
  const lines: string[] = [];
  for (const c of checks) {
    if (c.kind !== 'cell-sum-equals') continue;
    lines.push(
      `Write one total to ${c.sheet}!${a1Cell(c.row, c.col)} ` +
        `(write_cells row ${c.row}, column ${c.col}, 0-based). ` +
        `That total is the sum of ${c.sourceSheet}!${a1Cell(c.sourceStartRow, c.sourceStartCol)}:` +
        `${a1Cell(c.sourceEndRow, c.sourceEndCol)} ` +
        `(rows ${c.sourceStartRow}-${c.sourceEndRow}, columns ${c.sourceStartCol}-${c.sourceEndCol}, 0-based).`,
    );
  }
  return lines;
}

/**
 * #151 coherence fix (part 2): sheets a failure re-plan must be
 * grounded on. The old code collected only each check's target sheet
 * (Summaries), so a failed totals step re-planned against Summaries
 * layout alone and re-derived wrong source rows (years/COGS/Taxes)
 * — the check's SOURCE sheet (Income) is where the rows live. This
 * adds every cell-sum-equals check's sourceSheet, deduplicated,
 * preserving target-first order.
 */
export function replanGroundingSheets(checks: StepCheck[] | undefined): string[] {
  const sheets: string[] = [];
  if (!checks) return sheets;
  for (const c of checks) {
    if ('sheet' in c && typeof c.sheet === 'string' && c.sheet.length > 0 && !sheets.includes(c.sheet)) {
      sheets.push(c.sheet);
    }
    if (
      c.kind === 'cell-sum-equals' &&
      typeof c.sourceSheet === 'string' &&
      c.sourceSheet.length > 0 &&
      !sheets.includes(c.sourceSheet)
    ) {
      sheets.push(c.sourceSheet);
    }
  }
  return sheets;
}

/** A fresh step record from a planned step. */
export function newStepRecord(step: JobStep): WorkflowStepRecord {
  const expectedChange = normalizeStepDeclaration(
    step.title,
    step.instruction,
    step.expectedChange,
  );
  return {
    title: step.title,
    instruction: step.instruction,
    ...(expectedChange ? { expectedChange: expectedChange } : {}),
    ...(step.checks && step.checks.length > 0 ? { checks: step.checks } : {}),
    status: 'pending',
    attempts: 0,
  };
}
