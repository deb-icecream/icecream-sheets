/**
 * AI Agent types (track 29, design-docs/ai-agent.md).
 *
 * The agent is the one product-native agent. It lives inside the service
 * boundary, acts only through versioned MCP tools (never a private path to
 * the engine), acts as the user through authorize(), and keeps an audit
 * trail of everything it does.
 */

import type { ArtifactSpec } from '../artifacts/spec.js';
import type { DerivedDiagramSpec } from './diagramSpec.js';

export type AgentRole = 'user' | 'agent' | 'system';

export interface AgentMessage {
  role: AgentRole;
  text: string;
  ts: number;
}

/** A single tool invocation the planner wants to perform. */
export interface ToolCallAction {
  type: 'tool';
  tool: string;
  args: Record<string, unknown>;
  rationale?: string;
}

/**
 * Human-in-the-loop (ai-agent.md §12): when the agent needs the user it
 * pauses and asks. The runtime surfaces the question to the chat UI and
 * resumes when the user responds. There is no path around the user:
 * the agent cannot proceed until the user answers.
 */
export interface AskAction {
  type: 'ask';
  question: string;
  options?: string[];
  /**
   * Product-constructed intent choice (the #139 help menu: "What
   * would you like to do with your spreadsheet?" with fixed options):
   * the question is a structured choice the PRODUCT offers, not a
   * fact the planner is fishing for, so the runtime's grounding gate
   * lets it park before any tool use. Set ONLY by product code
   * (runtime.ts helpMenuAsk). The LLM action parser
   * (openaiBackend.ts) builds ask actions by explicit whitelist and never
   * copies this field from model output, so a planner-generated ask can
   * never carry it.
   */
  intentChoice?: boolean;
}

export interface DoneAction {
  type: 'done';
}

export type AgentAction = ToolCallAction | AskAction | DoneAction;

/** What the planner saw from the last round of tool executions. */
export interface ToolResultRecord {
  tool: string;
  ok: boolean;
  /** Short human-readable summary (also stored in the audit trail). */
  summary: string;
  data?: unknown;
}

export interface PlannerInput {
  /** The latest user message (also the resume answer after a pause). */
  userText: string;
  history: AgentMessage[];
  /** Tool results since the previous plan (empty on the first iteration). */
  toolResults: ToolResultRecord[];
  iteration: number;
  /**
   * Workbook context injected by the runtime (agent-failures-fix W3):
   * the open workbook's REAL sheet names, fetched through the
   * list_sheets MCP tool at turn start. These are the only sheets that
   * exist — backends render them into the planner's context so the
   * model grounds sheet references (and any which-sheet choice) on
   * them instead of inventing names. Absent when no workbook is bound
   * or the lookup failed; behavior is then exactly as before.
   */
  sheetContext?: {
    sheets: string[];
    /**
     * #135: the sheet the user is currently on (client-passed turn
     * context). Backends read THIS sheet for sheet-less data access;
     * absent = the workbook's first sheet, never a hardcoded name.
     */
    activeSheet?: string;
  };
}

export interface PlannerOutput {
  /** Message to show the user when this turn ends. */
  message: string;
  actions: AgentAction[];
}

/**
 * A machine-checkable step outcome (design-docs/agent-workflows.md §2.3):
 * the workflow runtime verifies a step against ground truth read back
 * through the MCP tools — never against the planner's self-report.
 * Rows/cols are 0-based, matching read_cells.
 */
export type StepCheck =
  | { kind: 'cell-equals'; sheet: string; row: number; col: number; equals: number | string }
  | { kind: 'cell-nonempty'; sheet: string; row: number; col: number }
  | {
      kind: 'range-filled';
      sheet: string;
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
    }
  | { kind: 'sheet-exists'; sheet: string }
  | {
      kind: 'column-sum-equals';
      sheet: string;
      col: number;
      startRow: number;
      endRow: number;
      equals: number;
    }
  | {
      kind: 'cell-sum-equals';
      /** Sheet holding the written total cell. */
      sheet: string;
      row: number;
      col: number;
      /**
       * #155: source range whose ENGINE values must sum to the total
       * cell. The expected value is recomputed by the runtime from
       * this range — the planner declares only structure (total cell
       * + source range), never a value, so a computed total is
       * checked against independent ground truth instead of the
       * planner's own arithmetic. range-filled proves landing only
       * and must never be the sole check for a computed total.
       */
      sourceSheet: string;
      sourceStartRow: number;
      sourceStartCol: number;
      sourceEndRow: number;
      sourceEndCol: number;
    };

/** One step of a job plan (agent-workflows.md §2.1): a goal the step
 * loop pursues, plus the completion checks the runtime verifies. */
/**
 * The kind of change a step is expected to make, declared by the LLM
 * planner (#151). Verification is driven ONLY by this declaration:
 * 'sheet-write' → verify the sheet changed; 'app-create' → verify
 * only that the app was created; 'none' (or absent) → no
 * verification at all, because there is nothing to validate. The
 * runtime never imposes a default check from the step's wording.
 */
export type StepExpectedChange = 'sheet-write' | 'app-create' | 'none';

export interface JobStep {
  title: string;
  /** Self-contained instruction for the step's planner loop. */
  instruction: string;
  checks?: StepCheck[];
  expectedChange?: StepExpectedChange;
}

/** A whole-job plan as data (agent-workflows.md §2.1). */
export interface JobPlan {
  steps: JobStep[];
}

/** Input to a backend's job-planning call (agent-workflows.md §2.1). */
export interface JobPlanInput {
  /** The user's ask being decomposed. */
  userText: string;
  history: AgentMessage[];
  /**
   * Declaration-frame fix: tool results the planner must bind check
   * ranges to (e.g. a describe_sheet result from a completed discovery
   * step). The initial plan is written BEFORE any tool runs, so without
   * this channel the planner invents check ranges blind; the runtime
   * re-plans the remainder after discovery with the schema attached
   * here. Absent on the initial plan call (nothing has run yet).
   */
  toolResults?: ToolResultRecord[];
  sheetContext?: {
    sheets: string[];
    /** #135: the sheet the user is currently on (see PlannerInput). */
    activeSheet?: string;
  };
}

/**
 * Live increments of a running turn (#40 streaming, #137 token
 * streaming). The planner loop genuinely produces these as it works:
 * an iteration begins (thinking), an intermediate plan narrates
 * itself (thought), tools start and end — and, since #137, the
 * provider's reply text streams token by token ('token') while the
 * final plan is still arriving. The 'done' payload stays
 * authoritative: the panel REPLACES streamed text with it, so a
 * failed-then-retried stream can never duplicate text.
 */
export type AgentTurnEvent =
  | { type: 'thinking'; iteration: number }
  | { type: 'thought'; text: string }
  | { type: 'tool'; phase: 'start' | 'end'; tool: string; ok?: boolean; summary?: string }
  | { type: 'token'; text: string };

/**
 * Optional per-plan options (#137 streaming). onToken receives the
 * plan's "message" text progressively as the provider streams it
 * (progress lines on intermediate plans, the final answer on the
 * last plan). Callers MUST treat the turn's done payload as
 * authoritative and replace streamed text with it. Backends without
 * streaming simply ignore opts.
 */
export interface PlannerOptions {
  onToken?: (text: string) => void;
}

/** Per-turn streaming/cancellation hooks threaded through the loop. */
export interface AgentTurnHooks {
  onEvent?: (e: AgentTurnEvent) => void;
  /** Cooperative cancel: checked at iteration and tool boundaries. */
  isCancelled?: () => boolean;
  /**
   * #135: the sheet the user is currently on, passed by the client
   * with the turn. The planner reads THIS sheet for sheet-less data
   * access; absent = the workbook's first sheet, never a hardcoded
   * name. Carried through runTurn/runLoopDetailed into the backend's
   * sheetContext — it is turn context, not a cancel/event hook.
   */
  sheet?: string;
}

/** Thrown inside the loop when a turn's cancel hook fires. */
export class AgentTurnCancelled extends Error {
  constructor() {
    super('agent turn cancelled');
    this.name = 'AgentTurnCancelled';
  }
}

/**
 * Pluggable model backend (ai-agent.md §8). Tools and behavior do not
 * change with the model: the backend only plans; the runtime executes.
 * #137: the request path resolves ONLY to a real LLM backend or to
 * NoModelConfiguredBackend (a clear error when no model is configured);
 * the old heuristic planner is gated out of the request path. Users can
 * point the agent at another provider by implementing this interface.
 */
export interface ModelBackend {
  readonly name: string;
  plan(input: PlannerInput, opts?: PlannerOptions): Promise<PlannerOutput>;  /**
   * Job planning (design-docs/agent-workflows.md §2.1): decompose an
   * ask into an explicit step plan. Optional — a backend without it
   * cannot drive the workflow layer's plan-first path, and the runtime
   * falls back to today's single-turn loop (plus exhaustion promotion,
   * which re-asks here). Returns null when no plan is available.
   * A plan with at most one step means "not multi-step work": the
   * runtime runs the ordinary loop, unchanged.
   */
  planJob?(input: JobPlanInput): Promise<JobPlan | null>;
}

export type AuditKind =
  | 'user_message'
  | 'agent_message'
  | 'tool_call'
  | 'question'
  | 'memory'
  | 'confirmation'
  | 'timeout'
  /** Agent guardrails (2026-10-21): input-cap / rate / concurrency
   *  rejections and scope-gate declines. The summary names the guardrail
   *  and the limit; no planner or tool activity follows one of these. */
  | 'guardrail'
  /** Workflow layer (design-docs/agent-workflows.md §2.5): step events
   *  (started / verifying / done / retrying / …) the chat UI renders as
   *  the live plan. The structured payload rides in `workflow`. */
  | 'workflow';

/**
 * Structured payload on a 'workflow' audit entry (agent-workflows.md
 * §2.5 — the step-event contract the chat UI consumes). `summary` on the
 * same entry carries the human-readable line.
 */
export interface WorkflowEventPayload {
  workflowId: string;
  event:
    | 'started'
    | 'resumed'
    | 'step_started'
    | 'step_verifying'
    | 'step_done'
    | 'step_retrying'
    | 'step_replanned'
    | 'step_replan_failed'
    | 'done'
    | 'stuck'
    | 'halted'
    | 'cancelled'
    | 'superseded';
  /** 0-based step index the event concerns, when step-scoped. */
  stepIndex?: number;
  stepTitle?: string;
  /** 1-based attempt number, on step_retrying / step events after a retry. */
  attempt?: number;
  /** Workflow status after the event. */
  status?: string;
  /** Machine-readable detail (verification outcome, stop reason). */
  detail?: string;
}

/** One audit-trail row (ai-agent.md §4): what, what it touched, when, whose. */
export interface AuditEntry {
  seq: number;
  ts: number;
  principal: string;
  threadId: string;
  kind: AuditKind;
  tool?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  summary?: string;
  text?: string;
  /** Present on kind 'workflow' entries: the structured step event. */
  workflow?: WorkflowEventPayload;
}

export interface PendingInput {
  question: string;
  options?: string[];
}

import type { ChartConfiguration } from 'chart.js';

/**
 * A rendered-visual attachment: the data-analysis component produced a
 * Chart.js config (analysis produces spec + render request); the chat UI
 * renders it through ChartCanvas. Never edited by hand — it is the
 * deterministic output of an executed analysis script.
 */
export interface AgentChartAttachment {
  title: string;
  config: ChartConfiguration;
}

export interface AgentReply {
  threadId: string;
  message: string;
  /** Audit entries created during this turn. */
  actionsTaken: AuditEntry[];
  /** Present when the agent paused for user input (ask or confirmation). */
  needsInput?: PendingInput;
  /**
   * Present when the turn ran the data-analysis pipeline: the chart to
   * render next to the message (spec + render request handoff).
   */
  chart?: AgentChartAttachment;
  /**
   * Present when the turn built an app through the loop's generate_app
   * tool (#141): the full spec. The panel stores it (Apps tab) and
   * renders it on click; the client only ever renders code it receives.
   */
  artifact?: ArtifactSpec;
  /**
   * Present when the turn built a diagram through the loop's
   * create_diagram tool (#138): the model-generated spec (layout +
   * node labels + title). The panel renders it as SmartArt SVG; the
   * client only ever renders a spec it receives.
   */
  diagram?: DerivedDiagramSpec;
  /**
   * Present when the turn engaged the workflow layer
   * (design-docs/agent-workflows.md): the workflow's id, its status at
   * reply time, and step counts. The full record (plan, per-step state)
   * is available through the runtime's getWorkflow / the gateway's
   * GET /workflow; the step-by-step event stream is in the audit trail
   * as kind 'workflow' entries.
   */
  workflow?: {
    id: string;
    status: string;
    stepsPlanned: number;
    stepsCompleted: number;
    stepsRetried: number;
  };
}
