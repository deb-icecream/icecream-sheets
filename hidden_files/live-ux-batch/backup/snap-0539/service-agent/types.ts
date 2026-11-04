/**
 * AI Agent types (track 29, design-docs/ai-agent.md).
 *
 * The agent is the one product-native agent. It lives inside the service
 * boundary, acts only through versioned MCP tools (never a private path to
 * the engine), acts as the user through authorize(), and keeps an audit
 * trail of everything it does.
 */

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
   * Product-constructed intent choice (app-generation "Describe the app /
   * Analyze the data instead", the unknown-intent help menu): the question
   * is a structured choice the PRODUCT offers, not a fact the planner is
   * fishing for, so the runtime's grounding gate lets it park before any
   * tool use. Set ONLY by product code (the deterministic backend's
   * appgen/unknown constructions in backends.ts). The LLM action parser
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
  sheetContext?: { sheets: string[] };
}

export interface PlannerOutput {
  /** Message to show the user when this turn ends. */
  message: string;
  actions: AgentAction[];
}

/**
 * Live increments of a running turn (#40 streaming). The planner loop
 * genuinely produces these as it works: an iteration begins (thinking),
 * an intermediate plan narrates itself (thought), tools start and end.
 * The final ANSWER text is NOT among them — the backend interface
 * returns whole planner outputs, so the answer lands atomically with
 * the turn's reply (the design doc's sanctioned fallback; no fabricated
 * token stream).
 */
export type AgentTurnEvent =
  | { type: 'thinking'; iteration: number }
  | { type: 'thought'; text: string }
  | { type: 'tool'; phase: 'start' | 'end'; tool: string; ok?: boolean; summary?: string };

/** Per-turn streaming/cancellation hooks threaded through the loop. */
export interface AgentTurnHooks {
  onEvent?: (e: AgentTurnEvent) => void;
  /** Cooperative cancel: checked at iteration and tool boundaries. */
  isCancelled?: () => boolean;
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
 * The product ships HeuristicModelBackend as the default; users can point
 * the agent at another provider by implementing this interface.
 */
export interface ModelBackend {
  readonly name: string;
  plan(input: PlannerInput): Promise<PlannerOutput>;
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
  | 'guardrail';

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
}
