/**
 * AI Agent runtime (track 29, design-docs/ai-agent.md).
 *
 * - Lives in the service boundary as a service component (§1).
 * - Acts ONLY through versioned MCP tools: the runtime holds an MCP Client
 *   connected to the product MCP server over an in-memory transport. There
 *   is no private path to the engine — even in-process, every read/write
 *   crosses the MCP protocol boundary (§2).
 * - Acts as the user: the principal (and memory userId) stamp every call (§3).
 * - Audit trail: every action logged with what/when/whose (§4).
 * - Chat is one surface; the same runtime also drives proactivity (§5).
 * - Write discipline (§7): broad/destructive writes require explicit user
 *   confirmation BEFORE executing — enforced by the runtime regardless of
 *   which model backend planned them.
 * - Human-in-the-loop (§12): the planner emits an `ask` action (or a write
 *   trips the §7 confirmation gate); the runtime pauses by calling the
 *   versioned agent.ask_question / agent.offer_options /
 *   agent.request_approval MCP tools. The tool call blocks until the human
 *   answers via agent.answer_pending — JSON-RPC allows delayed tool
 *   responses, so there is no deadlock and no path around MCP. Pauses live
 *   in the shared PendingAskStore (pendingAsks.ts), never in a parallel
 *   runtime-level implementation.
 * - Short-term memory (threads) belongs to the runtime (§12). Long-term
 *   memory goes through the versioned memory_* MCP tools (§12).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  AgentAction,
  AgentMessage,
  AgentReply,
  AgentTurnHooks,
  AskAction,
  AuditEntry,
  AuditKind,
  JobPlan,
  ModelBackend,
  PlannerOutput,
  StepCheck,
  ToolCallAction,
  ToolResultRecord,
  WorkflowEventPayload,
} from './types.js';
import { AgentTurnCancelled } from './types.js';
import type { DerivedDiagramSpec } from './diagramSpec.js';
import {
  checkGroundingLines,
  createAgentWorkflowStore,
  newStepRecord,
  replanGroundingSheets,
  stepAllowsNativeChart,
  MAX_STORED_WORKFLOWS,
  type AgentWorkflow,
  type WorkflowStepRecord,
} from './workflows.js';
import { memoryPersistence } from '../metadataStore.js';
import { NoModelConfiguredBackend, NoModelConfiguredError } from './backends.js';
import { classifyScope } from './intentRouter.js';
import {
  createAgentThreadStore,
  newThread,
  MAX_THREAD_MESSAGES,
  type AgentThread,
} from './threads.js';
import {
  DEFAULT_HITL_TIMEOUT_MS,
  type PendingAskView,
} from './pendingAsks.js';
import {
  detectTemplate,
  generateAndSaveArtifact,
  type AppGenerator,
  type AppTemplateKind,
  type ArtifactSpec,
  type GenerateArtifactResult,
} from '../artifacts/index.js';
import type { MetadataStore, Persistence } from '../metadataStore.js';

export interface CreateAppArtifactOptions {
  /** Artifact store (service metadata store). */
  store: MetadataStore<ArtifactSpec>;
  /** Sheet the app binds to. Absent = the workbook's first sheet (#135). */
  sheet?: string;
  /** Generator to use; defaults to the built-in template generator. */
  generator?: AppGenerator;
  /**
   * Force a template kind (the caller already routed the prompt to the
   * app lane — e.g. the chat intent router, or the gateway route
   * mirroring the web app-generation port). Passed through to
   * generateAndSaveArtifact so the flow does not re-route the prompt.
   */
  template?: AppTemplateKind;
}
import {
  toChartConfiguration,
  validateAnalysisChartSpec,
} from '../analysis/chartspec.js';
import { detectHeaderRow } from '../analysis/schema.js';
import type { CellInput } from '../appbuilder/model.js';
import type { ChartConfiguration } from 'chart.js';

export interface AgentRuntimeOptions {
  /** The product MCP server (created via createServer). Never the engine. */
  server: McpServer;
  backend?: ModelBackend;
  /** Identity stamped on tool calls and audit rows (ai-agent.md §3). */
  principal?: string;
  /** userId for memory_* tools. Defaults to principal. */
  userId?: string;
  /** Max planner iterations per turn. */
  maxIterations?: number;
  /**
   * Max clarifying questions (planner `ask` actions) per turn. Beyond the
   * budget the ask is NOT parked with the user: the planner gets a steering
   * note and must determine the missing fact from the sheet (headers, used
   * range, list_sheets) or answer with what it has. Guards against ask
   * cascades where each answer re-enters the loop with a fresh budget
   * (FIX-R4: a simple total question produced five sequential asks and a
   * 240 s parked turn). Write confirmations (§7) are a separate safety
   * gate and never count against this budget. Default 1.
   */
  maxAsksPerTurn?: number;
  /** write_cells/set_formulas touching more than this many cells need confirmation. */
  confirmThreshold?: number;
  /**
   * Persistence for conversation threads (ai-agent.md §9). When provided,
   * threads are read-through/write-through against the service metadata
   * store (per userId) and survive restarts. Human-in-the-loop pauses are
   * NOT part of thread state: they live in the shared PendingAskStore
   * behind the agent.* MCP tools (§12). When omitted, threads stay in
   * memory (previous behavior).
   */
  threadPersistence?: Persistence;
  /**
   * How long the human-in-the-loop MCP tool calls (agent.ask_question /
   * agent.offer_options / agent.request_approval) wait for an answer.
   * MUST be >= the MCP server's hitlTimeoutMs (the server owns the wait;
   * the runtime passes this value plus a margin as the client-side request
   * timeout because the SDK defaults client requests to 60s). Defaults to
   * DEFAULT_HITL_TIMEOUT_MS (10 minutes).
   */
  hitlTimeoutMs?: number;
  /**
   * Guardrails (user directive 2026-10-21). All optional; when an option
   * is absent the runtime falls back to the matching AGENT_* env override
   * (parsed defensively — invalid values fall back to the default), then
   * to the DEFAULT_AGENT_* constants below. The env path is deliberate:
   * the gateway's agentSvc constructs runtimes without guardrail wiring,
   * so env on the agent process configures the live stack.
   */
  /** Max characters accepted in one chat/answer/app prompt. Default 4000. Env: AGENT_MAX_INPUT_CHARS. */
  maxInputChars?: number;
  /** Max chat turns in flight at once for this principal. Default 3. Env: AGENT_MAX_CONCURRENT_TURNS. */
  maxConcurrentTurns?: number;
  /** Max chat turns started per rolling 60s window. Default 30. Env: AGENT_MAX_TURNS_PER_MINUTE. */
  maxTurnsPerMinute?: number;
  /** Max characters in a reply message (truncated with a notice beyond). Default 8000. Env: AGENT_MAX_REPLY_CHARS. */
  maxReplyChars?: number;
  /** Scope gate on/off. Default on. Env: AGENT_SCOPE_GATE ('0' disables). */
  scopeGateEnabled?: boolean;
  /**
   * Persistence for workflow records (design-docs/agent-workflows.md
   * §2.4: the plan + checkpoint live with the thread). When provided,
   * workflows survive process restarts and resume from their last
   * checkpoint. When omitted, an in-memory store is used — workflows
   * still run, but an interrupted job cannot resume after a restart.
   * The gateway's agentSvc always passes the durable file-backed store.
   */
  workflowPersistence?: Persistence;
  /** Workflow layer on/off (agent-workflows.md §2). Default on; env
   * AGENT_WORKFLOWS ('0' disables) is the operator kill switch. When
   * off, every turn takes the plain loop, exactly as before this layer
   * existed — the switch exists so an operator can A/B a regression
   * report without a redeploy.
   */
  workflowsEnabled?: boolean;
  /**
   * #141: loop app generation. The artifact store + code generator the
   * generate_app loop tool persists through. Absent (local in-process
   * runtimes, which keep the lane path) the tool fails honestly with
   * "not configured" instead of guessing. The gateway's agentSvc wires
   * both from the same store + generator the /artifacts/generate
   * route uses.
   */
  artifactStore?: MetadataStore<ArtifactSpec>;
  appGenerator?: AppGenerator;
}

/** Guardrail defaults (user directive 2026-10-21; the input cap was
 * refined the same day, 17:34 PDT: 2,000 characters — the user's
 * 10,000 figure was an abuse example, not the limit). */
export const DEFAULT_AGENT_MAX_INPUT_CHARS = 2_000;
export const DEFAULT_AGENT_MAX_CONCURRENT_TURNS = 3;
export const DEFAULT_AGENT_MAX_TURNS_PER_MINUTE = 30;
export const DEFAULT_AGENT_MAX_REPLY_CHARS = 8_000;

/** Rolling window for the per-principal turn-rate limit. */
const RATE_WINDOW_MS = 60_000;

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** The input-cap rejection text: names the limit and the actual length,
 * plus the rationale (user directive 2026-10-21 17:34 PDT): normal chat
 * prompts are a few hundred characters; longer content belongs in a
 * file or data source the agent reads via its tools. */
export function agentInputTooLongMessage(limit: number, actual: number): string {
  return (
    `That message is too long for the agent — the limit is ${fmtCount(limit)} characters ` +
    `(yours was ${fmtCount(actual)}). Normal chat prompts are a few hundred characters; ` +
    `if you have longer content, put it in a file or a data source and ask me to read it ` +
    `from there. Please shorten it and try again.`
  );
}

/** The concurrency rejection text: a previous turn is still in flight. */
export const AGENT_BUSY_MESSAGE =
  "I'm still working on your previous request — please wait for it to finish, then send that again.";

/** The rate-limit rejection text: names the per-minute limit. */
/**
 * #143: planner-error text safe to show the user. Backend errors carry
 * status + bounded provider detail and never a key by construction;
 * scrub key-like patterns anyway (a provider echoing a credential
 * must never reach the panel) and bound the length.
 */
export function sanitizePlannerError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .replace(/(gsk|sk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function agentRateLimitMessage(limitPerMinute: number): string {
  return (
    `You're sending requests too quickly — the limit is ${fmtCount(limitPerMinute)} requests ` +
    'per minute. Please wait a moment and try again.'
  );
}

/**
 * The scope-decline text: polite, names what the agent CAN do (widened
 * to the full product surface), and answers nothing of the off-topic
 * question.
 */
export const AGENT_SCOPE_DECLINE_MESSAGE =
  "I can only help with spreadsheet, data, and Icecream Sheets questions, so I can't answer that one. " +
  'I can read and write cells and ranges (e.g. "sum of A1:A10", "set B2 to 5"), set formulas, ' +
  'recalculate, remember notes ("remember that the budget is 5000"), analyze data with charts and ' +
  'pivots, build apps from your data, run ETL recipes and automations, work with data sources, and ' +
  'generate reports. What would you like to do with your spreadsheet?';

/**
 * #139 — the help menu, rebuilt as a runtime-constructed product ask.
 * The heuristic backend's unknown-intent help menu died with #137;
 * this is its replacement: fixed product wording, built by the
 * runtime (never by the planner — the LLM action parser cannot set
 * intentChoice), parked through the normal HITL mechanism with the
 * grounding-gate exemption that only a product-constructed intent
 * choice carries. Triggered when the user literally asks for help
 * ("help" / "help menu"), not by any planner guess: an off-topic or
 * unclassifiable prompt still gets the model's answer or the scope
 * decline, never this menu. The chosen option becomes the resumed
 * turn's user text, exactly like an answered planner ask.
 */
export const HELP_MENU_QUESTION = 'What would you like to do with your spreadsheet?';
export const HELP_MENU_OPTIONS = [
  'Build an app from this data',
  'Analyze this data',
  'Add a chart',
  'Something else',
] as const;

/** True when the user is literally asking for the help menu. */
export function isHelpMenuRequest(userText: string): boolean {
  const text = userText.trim().toLowerCase();
  return text === 'help' || text === 'help menu';
}

/** The product-constructed intent-choice ask (intentChoice: true). */
export function helpMenuAsk(): AskAction {
  return {
    type: 'ask',
    question: HELP_MENU_QUESTION,
    options: [...HELP_MENU_OPTIONS],
    intentChoice: true,
  };
}

/**
 * Resolve one numeric guardrail limit: explicit option (when a positive
 * finite number) → env override (when it parses to a positive integer) →
 * default. Anything invalid falls through defensively.
 */
function resolveGuardrailLimit(
  option: number | undefined,
  envName: string,
  fallback: number,
): number {
  if (typeof option === 'number' && Number.isFinite(option) && option > 0) {
    return Math.floor(option);
  }
  const raw = process.env[envName];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

interface RpcText {
  type: 'text';
  text: string;
}

/**
 * How a planner-loop segment ended (design-docs/agent-workflows.md §2).
 * The classic turn path only ever consumed the reply text; the workflow
 * layer needs the end kind to decide whether a step is done, must be
 * retried with steering, hit a human gate, or exhausted its per-step
 * budget. 'answered' is the only success end.
 */
type LoopEndKind = 'answered' | 'exhausted' | 'declined' | 'hitl-timeout' | 'planner-failed';

interface LoopOutcome {
  reply: AgentReply;
  end: LoopEndKind;
  /** Tool results accumulated across the segment (incl. ask resumes). */
  results: ToolResultRecord[];
}

export class AgentRuntime {
  private readonly server: McpServer;
  private readonly backend: ModelBackend;
  private readonly principal: string;
  private readonly userId: string;
  private readonly maxIterations: number;
  private readonly maxAsksPerTurn: number;
  private readonly confirmThreshold: number;
  private client: Client | null = null;
  private threads = new Map<string, AgentMessage[]>();
  private audit: AuditEntry[] = [];
  private auditSeq = 1;
  /** Metadata-store thread persistence (§9); null keeps in-memory threads. */
  private readonly threadStore: MetadataStore<AgentThread> | null;
  private readonly threadMap = new Map<string, AgentThread>();
  private threadsLoaded = false;
  /** Client-side timeout for the blocking HITL tool calls (server timeout + margin). */
  private readonly hitlClientTimeoutMs: number;
  // Guardrails (2026-10-21): resolved limits + per-principal turn tracking.
  private readonly maxInputChars: number;
  private readonly maxConcurrentTurns: number;
  private readonly maxTurnsPerMinute: number;
  private readonly maxReplyChars: number;
  private readonly scopeGateEnabled: boolean;
  /** Chat turns currently in flight (incremented only for turns that pass every gate). */
  private inFlightTurns = 0;
  /** Start timestamps of admitted chat turns, pruned to the rolling rate window. */
  private turnStarts: number[] = [];
  // Workflow layer (agent-workflows.md §2): durable per-user workflow
  // records + the open-workflow index. Mirrors the thread persistence
  // shape: an in-memory cache over a metadata store, written through
  // after every step transition (the checkpoint).
  private readonly workflowStore: MetadataStore<AgentWorkflow>;
  private readonly workflowMap = new Map<string, AgentWorkflow>();
  /** threadId → id of the thread's most recent workflow. */
  private readonly workflowByThread = new Map<string, string>();
  private workflowsLoaded = false;
  private workflowSeq = 0;
  private readonly workflowsEnabled: boolean;
  /** #141: loop app generation store + generator (see AgentRuntimeOptions). */
  private readonly artifactStore?: MetadataStore<ArtifactSpec>;
  private readonly appGenerator?: AppGenerator;

  constructor(opts: AgentRuntimeOptions) {
    this.server = opts.server;
    // #137: no backend arg means NO model — never a heuristic guess.
    // A runtime without an explicit LLM backend fails every turn with
    // the clear no-model message (see the planner-failed catch below).
    this.backend = opts.backend ?? new NoModelConfiguredBackend();
    this.principal = opts.principal ?? 'agent-user';
    this.userId = opts.userId ?? this.principal;
    this.maxIterations = opts.maxIterations ?? 5;
    this.maxAsksPerTurn = opts.maxAsksPerTurn ?? 1;
    this.confirmThreshold = opts.confirmThreshold ?? 10;
    // #141: loop app generation wiring (absent = tool fails honestly).
    this.artifactStore = opts.artifactStore;
    this.appGenerator = opts.appGenerator;
    this.threadStore = opts.threadPersistence
      ? createAgentThreadStore(opts.threadPersistence, this.userId)
      : null;
    const hitlTimeoutMs =
      opts.hitlTimeoutMs && opts.hitlTimeoutMs > 0 ? opts.hitlTimeoutMs : DEFAULT_HITL_TIMEOUT_MS;
    // Margin over the server-side wait: the server always answers first
    // (clean timeout error), the client never fires first.
    this.hitlClientTimeoutMs = hitlTimeoutMs + 30_000;
    this.maxInputChars = resolveGuardrailLimit(
      opts.maxInputChars,
      'AGENT_MAX_INPUT_CHARS',
      DEFAULT_AGENT_MAX_INPUT_CHARS,
    );
    this.maxConcurrentTurns = resolveGuardrailLimit(
      opts.maxConcurrentTurns,
      'AGENT_MAX_CONCURRENT_TURNS',
      DEFAULT_AGENT_MAX_CONCURRENT_TURNS,
    );
    this.maxTurnsPerMinute = resolveGuardrailLimit(
      opts.maxTurnsPerMinute,
      'AGENT_MAX_TURNS_PER_MINUTE',
      DEFAULT_AGENT_MAX_TURNS_PER_MINUTE,
    );
    this.maxReplyChars = resolveGuardrailLimit(
      opts.maxReplyChars,
      'AGENT_MAX_REPLY_CHARS',
      DEFAULT_AGENT_MAX_REPLY_CHARS,
    );
    this.scopeGateEnabled =
      typeof opts.scopeGateEnabled === 'boolean'
        ? opts.scopeGateEnabled
        : process.env.AGENT_SCOPE_GATE !== '0';
    this.workflowStore = createAgentWorkflowStore(
      opts.workflowPersistence ?? memoryPersistence(),
      this.userId,
    );
    this.workflowsEnabled =
      typeof opts.workflowsEnabled === 'boolean'
        ? opts.workflowsEnabled
        : process.env.AGENT_WORKFLOWS !== '0';
  }

  /** In-flight connect: concurrent callers share one connection attempt. */
  private connectPromise: Promise<Client> | null = null;

  private ensureConnected(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connectPromise) {
      const attempt = (async (): Promise<Client> => {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'icecream-ai-agent', version: '0.1.0' });
        await this.server.connect(serverT);
        await client.connect(clientT);
        this.client = client;
        return client;
      })();
      // A failed attempt must not poison later calls: reset so they retry.
      attempt.catch(() => {
        if (this.connectPromise === attempt) this.connectPromise = null;
      });
      this.connectPromise = attempt;
    }
    return this.connectPromise;
  }

  /**
   * Close the MCP client connection.
   * #150: closing must ALSO invalidate the cached connection attempt:
   * connectPromise otherwise keeps resolving to the closed client
   * forever (it is only reset when an attempt FAILS), so every later
   * callTool reuses the dead client and throws the SDK's
   * `Not connected` with no recovery. After close(), the next
   * ensureConnected() reconnects (new transport pair, same server).
   */
  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.connectPromise = null;
  }

  private log(
    threadId: string,
    kind: AuditKind,
    fields: Partial<Pick<AuditEntry, 'tool' | 'args' | 'ok' | 'summary' | 'text' | 'workflow'>> = {},
  ): AuditEntry {
    const entry: AuditEntry = {
      seq: this.auditSeq++,
      ts: Date.now(),
      principal: this.principal,
      threadId,
      kind,
      ...fields,
    };
    this.audit.push(entry);
    return entry;
  }

  /** Full audit trail, optionally filtered to a thread (ai-agent.md §4). */
  getAuditLog(threadId?: string): AuditEntry[] {
    return threadId ? this.audit.filter((e) => e.threadId === threadId) : [...this.audit];
  }

  /**
   * AI-generated app artifact flow (AI-GENERATED APP PATTERN spec).
   *
   * Routes the chat prompt (app vs data-analysis), reads the sheet schema
   * through MCP, generates the React source, and persists the artifact in
   * the service metadata store. Like everything the agent does, all data
   * access crosses the MCP protocol boundary; the artifact creation itself
   * is audit-logged (§4).
   */
  /**
   * Direct MCP tool call through this runtime's connected client
   * (FIX-E). The gateway's POST /api/tools/call forwards here so a
   * generated app running in gateway mode reaches the SAME MCP server
   * — and the same session-bound engine host — as chat, through the
   * protocol boundary only (ai-agent.md §2). The user id is stamped
   * exactly as for planner-driven calls. Returns the tool's parsed
   * data; throws with the tool's own error text on failure.
   */
  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureConnected();
    const res = await client.callTool({ name: tool, arguments: this.stampUser(tool, args) });
    const parsed = parseToolResult(res);
    if (!parsed.ok) throw new Error(parsed.error ?? `${tool} failed`);
    return parsed.data;
  }

  async createAppArtifact(
    threadId: string,
    prompt: string,
    opts: CreateAppArtifactOptions,
  ): Promise<GenerateArtifactResult> {
    // Guardrail: the input cap applies to app-generation prompts too,
    // before any MCP/tool activity. This method returns a
    // GenerateArtifactResult (there is no AgentReply channel), so the
    // rejection is a thrown Error carrying the same limit-naming message
    // chat() returns — and it is audit-logged as a guardrail rejection.
    if (prompt.length > this.maxInputChars) {
      const message = agentInputTooLongMessage(this.maxInputChars, prompt.length);
      this.log(threadId, 'guardrail', {
        text: message,
        summary: `guardrail rejection: app prompt too long (${prompt.length} chars > limit ${this.maxInputChars})`,
      });
      throw new Error(message);
    }
    const callTool = (tool: string, args: Record<string, unknown>): Promise<unknown> =>
      this.callTool(tool, args);
    // #135: no sheet context -> resolve the workbook's FIRST sheet
    // through list_sheets. Never a hardcoded name: a workbook need
    // not contain 'Sheet1' (bxl3way's first sheet is FMTs), and
    // guessing it produced "sheet 'Sheet1' is empty" for exactly
    // such workbooks. If the sheet list itself is unavailable, fail
    // honestly instead of guessing.
    let sheet = opts.sheet;
    if (!sheet) {
      try {
        const listed = (await this.callTool('list_sheets', {})) as
          | { sheets?: unknown }
          | undefined;
        const names = Array.isArray(listed?.sheets)
          ? (listed.sheets as unknown[]).filter(
              (n): n is string => typeof n === 'string' && n.length > 0,
            )
          : [];
        sheet = names[0];
      } catch {
        sheet = undefined;
      }
      if (!sheet) {
        throw new Error(
          'Cannot build the app: the workbook has no readable sheets to build from.',
        );
      }
    }
    let result: GenerateArtifactResult;
    try {
      result = await generateAndSaveArtifact(
        { prompt, sheet },
        {
          callTool,
          store: opts.store,
          generator: opts.generator,
          template: opts.template,
          principal: this.principal,
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(threadId, 'tool_call', {
        tool: 'create_app_artifact',
        ok: false,
        summary: `app generation failed: ${message}`,
      });
      throw e;
    }
    if (result.routed === 'app') {
      this.log(threadId, 'tool_call', {
        tool: 'create_app_artifact',
        ok: true,
        summary: `generated app artifact "${result.spec.name}" (${result.spec.template})`,
      });
    } else {
      this.log(threadId, 'agent_message', {
        text: `prompt routed to ${result.routed}: ${result.reason}`,
      });
    }
    return result;
  }

  /**
   * Proactive subscriptions (ai-agent.md §6): subscribe the agent to engine
   * events through the MCP subscription tools. The caller polls with
   * pollWatch() and decides what deserves the user's attention.
   */
  async watch(
    events: ('cells_changed' | 'recalc_complete' | 'sheet_added' | 'sheet_removed')[],
    sheet?: string,
  ): Promise<string> {
    const client = await this.ensureConnected();
    const res = await client.callTool({
      name: 'subscribe',
      arguments: { events, ...(sheet ? { sheet } : {}), principal: this.principal },
    });
    const parsed = parseToolResult(res);
    if (!parsed.ok) throw new Error(`subscribe failed: ${parsed.error}`);
    const data = parsed.data as { subscriptionId?: string };
    if (!data.subscriptionId) throw new Error('subscribe returned no subscriptionId');
    return data.subscriptionId;
  }

  async pollWatch(
    subscriptionId: string,
    maxEvents = 50,
  ): Promise<{ seq: number; ts: number; type: string; detail: Record<string, unknown> }[]> {
    const client = await this.ensureConnected();
    const res = await client.callTool({
      name: 'poll_events',
      arguments: { subscriptionId, maxEvents },
    });
    const parsed = parseToolResult(res);
    if (!parsed.ok) throw new Error(`poll_events failed: ${parsed.error}`);
    const data = parsed.data as { events?: { seq: number; ts: number; type: string; detail: Record<string, unknown> }[] };
    return data.events ?? [];
  }

  async unwatch(subscriptionId: string): Promise<void> {
    const client = await this.ensureConnected();
    await client.callTool({ name: 'unsubscribe', arguments: { subscriptionId } });
  }

  getThreads(): string[] {
    if (!this.threadStore) return [...this.threads.keys()];
    this.ensureThreadsLoaded();
    return [...this.threadMap.keys()];
  }

  getHistory(threadId: string): AgentMessage[] {
    if (!this.threadStore) return [...(this.threads.get(threadId) ?? [])];
    this.ensureThreadsLoaded();
    return [...(this.threadMap.get(threadId)?.messages ?? [])];
  }

  private history(threadId: string): AgentMessage[] {
    if (this.threadStore) return this.threadRecord(threadId).messages;
    let h = this.threads.get(threadId);
    if (!h) {
      h = [];
      this.threads.set(threadId, h);
    }
    return h;
  }

  // ============ thread persistence (ai-agent.md §9) ============

  /** Load all threads from the metadata store into the cache (once). */
  private ensureThreadsLoaded(): void {
    if (this.threadsLoaded || !this.threadStore) return;
    for (const t of this.threadStore.all()) this.threadMap.set(t.threadId, t);
    this.threadsLoaded = true;
  }

  /** Get (creating if needed) the thread record; its messages array is live. */
  private threadRecord(threadId: string): AgentThread {
    this.ensureThreadsLoaded();
    let rec = this.threadMap.get(threadId);
    if (!rec) {
      rec = newThread(threadId, this.userId);
      this.threadMap.set(threadId, rec);
    }
    return rec;
  }

  /** Write the thread back to the metadata store (write-through). */
  private saveThread(threadId: string): void {
    if (!this.threadStore) return;
    const rec = this.threadMap.get(threadId);
    if (!rec) return;
    if (rec.messages.length > MAX_THREAD_MESSAGES) {
      rec.messages = rec.messages.slice(-MAX_THREAD_MESSAGES);
    }
    rec.updatedAt = Date.now();
    this.threadStore.saveAll([...this.threadMap.values()]);
  }

  // ============ guardrails (user directive 2026-10-21) ============

  /**
   * A guardrail reply (input cap / busy / rate limit / scope decline).
   *
   * Thread handling — DECISION: the rejected input is NEVER stored as a
   * user message. A 10,000-char paste or an off-topic prompt sitting in
   * history as a user turn would poison every later planner call on the
   * thread (and burn the thread's message budget). Instead the reply is
   * recorded as a SYSTEM notice plus the agent's reply text, the turn is
   * audit-logged with kind 'guardrail' (summary names the guardrail and
   * the limit), and NO backend plan() and NO tool call happens. Guardrail
   * replies also never consume rate/concurrency budget: the counters are
   * only touched by turns that pass every gate.
   */
  private guardrailReply(
    threadId: string,
    message: string,
    summary: string,
    turnStart: number,
  ): AgentReply {
    const hist = this.history(threadId);
    hist.push({ role: 'system', text: message, ts: Date.now() });
    this.log(threadId, 'guardrail', { text: message, summary });
    this.log(threadId, 'agent_message', { text: message });
    this.saveThread(threadId);
    return { threadId, message, actionsTaken: this.audit.slice(turnStart) };
  }

  /**
   * Output bound: reply MESSAGE text only (tool-driven artifacts and
   * chart attachments are never truncated). Over-cap text is cut to the
   * cap with a suffix that names the limit.
   */
  private boundReplyText(text: string): string {
    if (text.length <= this.maxReplyChars) return text;
    const suffix = `… [reply truncated at the ${fmtCount(this.maxReplyChars)}-character limit]`;
    return text.slice(0, Math.max(0, this.maxReplyChars - suffix.length)) + suffix;
  }

  /** Send a user message and run the turn. A human-in-the-loop pause inside
   *  the turn blocks here: the runtime's ask path calls the versioned
   *  agent.* MCP tools and waits for the human's answer (§12). */
  async chat(threadId: string, userText: string, hooks?: AgentTurnHooks): Promise<AgentReply> {
    const turnStart = this.audit.length;

    // Guardrail 1 — input cap, before any planner/tool activity.
    if (userText.length > this.maxInputChars) {
      return this.guardrailReply(
        threadId,
        agentInputTooLongMessage(this.maxInputChars, userText.length),
        `guardrail rejection: input too long (${userText.length} chars > limit ${this.maxInputChars})`,
        turnStart,
      );
    }
    // Guardrail 2a — concurrency: a parked/finished turn never reaches
    // here; only genuinely in-flight turns count against the cap.
    if (this.inFlightTurns >= this.maxConcurrentTurns) {
      return this.guardrailReply(
        threadId,
        AGENT_BUSY_MESSAGE,
        `guardrail rejection: concurrency limit (${this.inFlightTurns} turn(s) in flight >= limit ${this.maxConcurrentTurns})`,
        turnStart,
      );
    }
    // Guardrail 2b — rate: rolling 60s window over admitted turn starts.
    const now = Date.now();
    this.turnStarts = this.turnStarts.filter((ts) => now - ts < RATE_WINDOW_MS);
    if (this.turnStarts.length >= this.maxTurnsPerMinute) {
      return this.guardrailReply(
        threadId,
        agentRateLimitMessage(this.maxTurnsPerMinute),
        `guardrail rejection: rate limit (${this.turnStarts.length} turns in the last 60s >= limit ${this.maxTurnsPerMinute}/min)`,
        turnStart,
      );
    }
    // Guardrail 4 — scope gate, after the length/rate checks, before
    // planning. Deterministic classifier; ambiguity resolves in-scope.
    // #139: a literal help request skips the gate — the help menu
    // below answers it instead of a decline.
    if (this.scopeGateEnabled && !isHelpMenuRequest(userText) && classifyScope(userText) === 'off-topic') {
      return this.guardrailReply(
        threadId,
        AGENT_SCOPE_DECLINE_MESSAGE,
        'guardrail scope decline: prompt classified off-topic (no spreadsheet/data/product anchor)',
        turnStart,
      );
    }

    // Admitted: this turn now counts against rate + concurrency.
    this.turnStarts.push(now);
    this.inFlightTurns++;
    try {
      const hist = this.history(threadId);
      hist.push({ role: 'user', text: userText, ts: Date.now() });
      this.log(threadId, 'user_message', { text: userText });
      // #139: the help menu parks BEFORE any planning — the runtime
      // constructs the intent-choice ask itself; the planner never
      // sees the 'help' text and never guesses at it.
      const reply = isHelpMenuRequest(userText)
        ? await this.runHelpMenu(threadId, hooks)
        : await this.runTurn(threadId, userText, hooks);
      this.saveThread(threadId);
      return {
        ...reply,
        message: this.boundReplyText(reply.message),
        actionsTaken: this.audit.slice(turnStart),
      };
    } catch (e) {
      if (e instanceof AgentTurnCancelled) {
        // Cooperative cancel (#40 Stop): the turn stops at a step
        // boundary; the thread keeps the exchange with an honest
        // stopped marker instead of a dangling user message.
        const message = 'Stopped — I ended that request early. Nothing further was changed.';
        const hist = this.history(threadId);
        hist.push({ role: 'agent', text: message, ts: Date.now() });
        this.log(threadId, 'agent_message', { text: message });
        this.saveThread(threadId);
        return { threadId, message, actionsTaken: this.audit.slice(turnStart) };
      }
      throw e;
    } finally {
      this.inFlightTurns--;
    }
  }

  /**
   * Streaming twin of chat() (#40): identical turn, with the turn's
   * genuine increments delivered to onEvent as they happen and the
   * AbortSignal wired to the cooperative cancel hook. Lets in-process
   * hosts (the web app's local mode) drive the same streaming UI as
   * the gateway's SSE route.
   */
  async chatStream(
    threadId: string,
    userText: string,
    onEvent: (e: import('./types.js').AgentTurnEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgentReply> {
    return this.chat(threadId, userText, {
      onEvent,
      isCancelled: () => signal?.aborted ?? false,
    });
  }

  // ============ workflow layer (design-docs/agent-workflows.md §2) ============
  //
  // A turn runs in three possible shapes:
  //  1. PLAIN (the historical path, byte-identical): the ask is not
  //     multi-step work — no job plan, or a one-step plan — so the
  //     ordinary planner loop answers it exactly as before this layer.
  //  2. WORKFLOW: a multi-step ask (job plan with >= 2 steps) runs as a
  //     durable workflow: steps execute one at a time through the same
  //     loop, each with its OWN iteration budget, verified against the
  //     sheet before the job advances, checkpointed after every
  //     transition.
  //  3. PROMOTION: a plain turn that still ends by exhausting its
  //     budget is promoted into a workflow (re-planned, or a single
  //     "finish the request" step with fresh per-step budgets) instead
  //     of returning the ran-out-of-steps reply. The only turns whose
  //     outcome changes are turns that today END in that failure.
  //
  // The only permitted stops (§1): done, user cancel, a human gate
  // (declined confirmation / HITL timeout — the job stays resumable),
  // or provably stuck (no verified progress across a step's attempts,
  // after steering and a re-plan) with a plain-language report.

  /** Run one admitted turn: resume / classify / promote / plain. */
  /**
   * #139 — the help-menu park. The runtime constructs the
   * intent-choice ask (helpMenuAsk, intentChoice: true) and parks it
   * through the normal HITL mechanism (agent.offer_options); the
   * chosen option becomes the resumed turn's user text, exactly like
   * an answered planner ask. No planner call happens before the park
   * — there is nothing to ground on yet, which is why the exemption
   * exists. On timeout the standard HITL timeout reply ends the turn.
   */
  private async runHelpMenu(threadId: string, hooks?: AgentTurnHooks): Promise<AgentReply> {
    const ask = helpMenuAsk();
    this.log(threadId, 'question', {
      text: ask.question,
      summary: 'help menu: runtime-constructed intent choice',
    });
    const message = this.boundReplyText(ask.question);
    const hist = this.history(threadId);
    hist.push({ role: 'agent', text: message, ts: Date.now() });
    this.log(threadId, 'agent_message', { text: message });
    const answered = await this.askUser(threadId, ask.question, ask.options);
    if (answered === 'timeout') return this.hitlTimeoutReply(threadId);
    hist.push({ role: 'user', text: answered, ts: Date.now() });
    this.log(threadId, 'user_message', { text: answered });
    return this.runTurn(threadId, answered, hooks);
  }

  private async runTurn(threadId: string, userText: string, hooks?: AgentTurnHooks): Promise<AgentReply> {
    if (!this.workflowsEnabled) {
      const outcome = await this.runLoopDetailed(threadId, userText, [], 0, false, userText, Date.now(), -1, 0, null, hooks);
      return outcome.reply;
    }
    // Audit offset of this turn's start (chat() has just logged the
    // user message): lets a promoted workflow's stop report count the
    // cells the plain segment wrote before promotion (W1 honesty).
    const turnAuditStart = this.audit.length;

    // Resume path: an open workflow on this thread owns the turn.
    const open = this.openWorkflowFor(threadId);
    if (open) {
      if (isCancelText(userText)) {
        open.status = 'cancelled';
        open.stopDetail = 'cancelled by the user';
        this.saveWorkflow(open);
        this.emitWorkflowEvent(threadId, open, 'cancelled', {
          status: open.status,
          detail: open.stopDetail,
        });
        const message =
          `OK — I stopped the job "${truncateText(open.originText, 120)}". ` +
          `Steps already completed stay in place: ${doneStepList(open)}. The remaining steps will not run.`;
        const hist = this.history(threadId);
        hist.push({ role: 'agent', text: message, ts: Date.now() });
        this.log(threadId, 'agent_message', { text: message });
        return { threadId, message, actionsTaken: [], workflow: workflowReplySummary(open) };
      }
      if (!this.shouldSupersede(open, userText)) {
        const note = userText.trim();
        if (note.length > 0 && !isBareContinuation(note)) {
          open.steering.push(note.slice(0, 500));
        }
        if (open.status === 'stuck') {
          // The user's message is presumed to carry the unblocking
          // information the stuck report asked for: the stuck step gets
          // a fresh set of attempts.
          const stuckStep = open.steps[open.currentStep];
          if (stuckStep) {
            stuckStep.attempts = 0;
            stuckStep.status = 'active';
          }
          open.status = 'running';
          open.stopDetail = undefined;
        }
        this.saveWorkflow(open);
        this.emitWorkflowEvent(threadId, open, 'resumed', {
          status: open.status,
          stepIndex: open.currentStep,
          detail: 'resumed from checkpoint',
        });
        const sheets = await this.fetchSheetNames();
        return this.driveWorkflow(threadId, open, sheets, 0, hooks);
      }
      // A clearly new ask supersedes the open job (recorded, never silent).
      open.status = 'superseded';
      open.stopDetail = 'superseded by a new request on the thread';
      this.saveWorkflow(open);
      this.emitWorkflowEvent(threadId, open, 'superseded', {
        status: open.status,
        detail: open.stopDetail,
      });
    }

    const sheets = await this.fetchSheetNames();
    let plan = await this.planJobSafe(threadId, userText, sheets, hooks?.sheet);
    // Round-3 mechanical Gate 1(a): a pure no-placement chart request
    // must never become a workflow — the planner ignored Gate 1(a)
    // live twice. A violating multi-step plan is discarded (the
    // established fail-open: a planJob failure already means "no
    // plan"), so the turn runs the plain loop, whose SYSTEM_PROMPT
    // chart rule routes the same shape to analyze_data. A compliant
    // single analyze_data step already takes the plain path below.
    if (plan && plan.steps.length >= 2 && isChatChartRequest(userText)) {
      plan = null;
    }
    if (plan && plan.steps.length >= 2) {
      const wf = this.createWorkflow(threadId, userText, plan);
      this.emitWorkflowEvent(threadId, wf, 'started', {
        status: wf.status,
        detail: `${wf.steps.length} steps planned`,
      });
      return this.driveWorkflow(threadId, wf, sheets, 0, hooks);
    }

    // Decomposition nudge: a stage-shaped ask (a per-row/per-file batch,
    // or a multi-segment write-and-report chain) that the planner read
    // as one step — or failed to plan at all — gets ONE re-plan with an
    // explicit decomposition note before the plain loop takes it. The
    // W1 ask is the canonical case: sampled as a single "write the
    // column" step, the plain loop fills it with per-row shares (the
    // recorded baseline failure, northShare 0.0753); decomposed —
    // totals first, then the write, then the report — the same model
    // completes it correctly (0.5590). The shape test is conservative
    // (see isStageShapedAsk): no §4.0 simple ask matches it, so their
    // path is untouched.
    if (isStageShapedAsk(userText)) {
      const nudged = await this.planJobSafe(threadId, userText + STAGE_SHAPED_NUDGE, sheets, hooks?.sheet);
      if (nudged && nudged.steps.length >= 2 && !isChatChartRequest(userText)) {
        const wf = this.createWorkflow(threadId, userText, nudged);
        this.emitWorkflowEvent(threadId, wf, 'started', {
          status: wf.status,
          detail: `${wf.steps.length} steps planned (decomposition re-plan)`,
        });
        return this.driveWorkflow(threadId, wf, sheets, 0, hooks);
      }
    }

    const outcome = await this.runLoopDetailed(
      threadId,
      userText,
      [],
      0,
      false,
      userText,
      Date.now(),
      -1,
      0,
      sheets,
      hooks,
    );
    if (outcome.end !== 'exhausted') return outcome.reply;

    // Promotion (§2 safety net): the ask was bigger than one turn's
    // budget. Re-plan it as steps; without a planner, fall back to a
    // single finish-the-request step. Either way the step machinery
    // (fresh per-step budgets, steering retries, verification) replaces
    // the bare ran-out-of-steps ending.
    // Round-3: a chat-chart request that exhausted the plain loop is
    // NOT re-planned into a workflow (the re-plan could reintroduce
    // the violating discovery + create_chart shape); the single
    // "Finish the request" fallback below retries it in the loop.
    const replan = isChatChartRequest(userText)
      ? null
      : await this.planJobSafe(
          threadId,
          `${userText}\n\n(Planning note: a first attempt at this request ran out of steps partway through. ` +
            'Plan the REMAINING work as steps. Steps whose effects already landed will be checked against their declared change, not repeated blindly.)',
          sheets,
        );
    const wf = this.createWorkflow(
      threadId,
      userText,
      replan && replan.steps.length > 0
        ? replan
        : { steps: [{ title: 'Finish the request', instruction: userText }] },
      [
        'A previous attempt at this job already ran and may have written some cells. ' +
          'Check the current state of the sheet first and do only what is still missing.',
      ],
    );
    this.emitWorkflowEvent(threadId, wf, 'started', {
      status: wf.status,
      detail: `promoted after the single-turn budget ran out; ${wf.steps.length} step(s) planned`,
    });
    return this.driveWorkflow(threadId, wf, sheets, this.landedWriteCells(turnAuditStart), hooks);
  }

  /**
   * Ask the backend for a job plan, fail-open: any error, timeout, or a
   * backend without planJob yields null and the caller takes the plain
   * path. The call is deliberately invisible — backend planning is not
   * audit-logged (plan() never was), and it issues no tool calls, so a
   * simple ask's observable path is unchanged (§4.0).
   */
  private async planJobSafe(
    threadId: string,
    userText: string,
    sheets: string[] | undefined,
    activeSheet?: string,
    // Declaration-frame fix: tool results the planner must bind check
    // ranges to (discovery output). Absent on the initial plan call.
    toolResults?: ToolResultRecord[],
  ): Promise<JobPlan | null> {
    const backend = this.backend;
    if (typeof backend.planJob !== 'function') return null;
    try {
      const plan = await Promise.race([
        backend.planJob({
          userText,
          history: [...this.history(threadId)],
          ...(toolResults && toolResults.length > 0 ? { toolResults } : {}),
          ...(sheets && sheets.length > 0
            ? {
                sheetContext: {
                  sheets,
                  ...(activeSheet ? { activeSheet } : {}),
                },
              }
            : {}),
        }),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), PLAN_JOB_TIMEOUT_MS),
        ),
      ]);
      if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;
      return plan;
    } catch {
      return null;
    }
  }

  /** Create + persist a workflow record from a plan. */
  private createWorkflow(
    threadId: string,
    originText: string,
    plan: JobPlan,
    initialSteering: string[] = [],
  ): AgentWorkflow {
    this.ensureWorkflowsLoaded();
    const wf: AgentWorkflow = {
      version: 1,
      id: `wf-${Date.now().toString(36)}-${(this.workflowSeq++).toString(36)}-${Math.floor(
        Math.random() * 1e9,
      ).toString(36)}`,
      threadId,
      userId: this.userId,
      originText,
      status: 'running',
      steps: plan.steps.map(newStepRecord),
      currentStep: 0,
      steering: [...initialSteering],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.workflowMap.set(wf.id, wf);
    this.workflowByThread.set(threadId, wf.id);
    this.saveWorkflow(wf);
    return wf;
  }

  /** The thread's open (resumable) workflow, if one exists. */
  private openWorkflowFor(threadId: string): AgentWorkflow | null {
    this.ensureWorkflowsLoaded();
    const id = this.workflowByThread.get(threadId);
    if (!id) return null;
    const wf = this.workflowMap.get(id);
    if (!wf) return null;
    return wf.status === 'running' || wf.status === 'stuck' ? wf : null;
  }

  /** The thread's most recent workflow record (any status), or null. */
  getWorkflow(threadId: string): AgentWorkflow | null {
    this.ensureWorkflowsLoaded();
    const id = this.workflowByThread.get(threadId);
    if (!id) return null;
    const wf = this.workflowMap.get(id);
    return wf ? (JSON.parse(JSON.stringify(wf)) as AgentWorkflow) : null;
  }

  private ensureWorkflowsLoaded(): void {
    if (this.workflowsLoaded) return;
    for (const w of this.workflowStore.all()) {
      this.workflowMap.set(w.id, w);
      const prev = this.workflowByThread.get(w.threadId);
      if (!prev) {
        this.workflowByThread.set(w.threadId, w.id);
      } else {
        const prevWf = this.workflowMap.get(prev);
        if (prevWf && w.updatedAt >= prevWf.updatedAt) {
          this.workflowByThread.set(w.threadId, w.id);
        }
      }
    }
    this.workflowsLoaded = true;
  }

  /** Checkpoint: write the workflow record through to the store (§2.4). */
  private saveWorkflow(wf: AgentWorkflow): void {
    wf.updatedAt = Date.now();
    this.ensureWorkflowsLoaded();
    this.workflowMap.set(wf.id, wf);
    let all = [...this.workflowMap.values()];
    if (all.length > MAX_STORED_WORKFLOWS) {
      // Drop oldest TERMINAL records first; open jobs are never pruned.
      const terminal = all
        .filter((w) => w.status !== 'running' && w.status !== 'stuck')
        .sort((a, b) => a.updatedAt - b.updatedAt);
      const excess = all.length - MAX_STORED_WORKFLOWS;
      const drop = new Set(terminal.slice(0, excess).map((w) => w.id));
      all = all.filter((w) => !drop.has(w.id));
      for (const id of drop) {
        this.workflowMap.delete(id);
        for (const [t, wid] of this.workflowByThread) {
          if (wid === id) this.workflowByThread.delete(t);
        }
      }
    }
    this.workflowStore.saveAll(all);
  }

  /** Emit one step event (§2.5): an audit entry the chat UI renders as
   *  the live plan, carrying the structured workflow payload. */
  private emitWorkflowEvent(
    threadId: string,
    wf: AgentWorkflow,
    event: WorkflowEventPayload['event'],
    fields: {
      stepIndex?: number;
      stepTitle?: string;
      attempt?: number;
      status?: string;
      detail?: string;
    } = {},
  ): void {
    const payload: WorkflowEventPayload = {
      workflowId: wf.id,
      event,
      ...(fields.stepIndex !== undefined ? { stepIndex: fields.stepIndex } : {}),
      ...(fields.stepTitle !== undefined ? { stepTitle: fields.stepTitle } : {}),
      ...(fields.attempt !== undefined ? { attempt: fields.attempt } : {}),
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
    };
    this.log(threadId, 'workflow', {
      summary: workflowEventSummary(wf, payload),
      workflow: payload,
    });
  }

  /** Supersede rule (recorded in the program report): a message resumes
   *  the open job UNLESS it shares no content word with the job AND
   *  reads as a complete standalone request — then it is a new ask and
   *  the job is marked superseded, never silently dropped. Bare
   *  continuations and cancels are handled before this is consulted. */
  private shouldSupersede(wf: AgentWorkflow, userText: string): boolean {
    if (isBareContinuation(userText)) return false;
    const step = wf.steps[wf.currentStep];
    const jobWords = contentWords(
      `${wf.originText} ${step?.title ?? ''} ${step?.instruction ?? ''}`,
    );
    const textWords = contentWords(userText);
    if (textWords.size < 4) return false;
    for (const w of textWords) if (jobWords.has(w)) return false;
    return true;
  }

  /**
   * Drive a workflow from its checkpoint to a permitted stop (§1):
   * every step verified before advancing; a failed step is retried
   * with steering, then the remainder is re-planned, before the job
   * may call itself stuck. Checkpoints land after every transition.
   */
  private async driveWorkflow(
    threadId: string,
    wf: AgentWorkflow,
    sheets: string[] | undefined,
    /** Cells written earlier in this turn, before the drive (promotion). */
    landedBeforeDrive = 0,
    hooks?: AgentTurnHooks,
  ): Promise<AgentReply> {
    // Consume resume steering + interruption context into this drive's
    // first step attempt, then clear them (checkpointed) so a later
    // resume does not replay stale notes.
    const resumeNotes: string[] = [...wf.steering];
    if (wf.interruptedPhase === 'hitl-timeout') {
      resumeNotes.push(
        'A previous run of this step stopped while waiting for the user. ' +
          'Check the current state of the sheet first, then do only what is still missing.',
      );
    } else if (wf.interruptedPhase === 'process-exit') {
      resumeNotes.push(
        'A previous run of this step was interrupted. ' +
          'Check the current state of the sheet first, then do only what is still missing.',
      );
    }
    wf.steering = [];
    wf.interruptedPhase = undefined;
    this.saveWorkflow(wf);

    let lastOutcome: LoopOutcome | null = null;
    // #151: an app a step built must reach the final reply (pill +
    // auto-open), even when the app step is not the last step — the
    // done return below reads this, not just the last step's outcome.
    let jobArtifact: ArtifactSpec | undefined;
    let segmentsThisDrive = 0;
    // Declaration-frame fix: at most one schema re-plan per drive.
    let schemaReplanned = false;
    // W1 honesty, carried into the workflow era: a stop report names
    // the cells that DID land during this drive, never reads as zero
    // progress when writes succeeded.
    const driveAuditStart = this.audit.length;

    for (let i = wf.currentStep; i < wf.steps.length; i++) {
      wf.currentStep = i;
      let failure = '';
      let replanned = false;
      let stepDone = false;

      for (;;) {
        const step = wf.steps[i];
        if (!step) break;
        if (step.status === 'done') {
          stepDone = true;
          break;
        }
        if (step.attempts >= MAX_STEP_ATTEMPTS) break; // -> stuck
        if (segmentsThisDrive >= MAX_SEGMENTS_PER_DRIVE) break; // -> stuck (safety valve)

        // Re-plan the remainder BEFORE the final attempt (§2.2).
        if (step.attempts === MAX_STEP_ATTEMPTS - 1 && failure.length > 0 && !replanned) {
          replanned = true;
          const replaced = await this.replanRemainder(threadId, wf, i, failure, sheets);
          if (replaced) {
            this.emitWorkflowEvent(threadId, wf, 'step_replanned', {
              stepIndex: i,
              stepTitle: wf.steps[i]?.title,
              detail: failure,
            });
            this.saveWorkflow(wf);
            continue; // re-read the replacement step
          }
        }

        step.attempts += 1;
        step.status = 'active';
        this.saveWorkflow(wf);
        this.emitWorkflowEvent(threadId, wf, 'step_started', {
          stepIndex: i,
          stepTitle: step.title,
          attempt: step.attempts,
        });

        const steering: string[] = [];
        if (resumeNotes.length > 0) steering.push(...resumeNotes.splice(0));
        if (step.attempts > 1 && failure.length > 0) {
          steering.push(
            `The previous attempt at this step did not finish: ${failure}. ` +
              'Look at the current state of the sheet first, then do only what is still missing — ' +
              'do not repeat work that already landed.',
          );
        }
        const auditStart = this.audit.length;
        segmentsThisDrive += 1;
        const outcome = await this.runLoopDetailed(
          threadId,
          this.stepPrompt(wf, i, steering),
          [],
          0,
          false,
          wf.originText,
          Date.now(),
          auditStart,
          0,
          sheets,
          hooks,
          `${step.title}\n${step.instruction}`,
        );
        lastOutcome = outcome;
        // #151: remember any app a step built; the done return
        // carries the latest one so the panel gets its pill.
        if (outcome.reply.artifact) jobArtifact = outcome.reply.artifact;

        // Round-3 (leg B): an exhausted step whose declared effect
        // LANDED still verifies — verification previously ran only on
        // 'answered', so a create_chart ok on the last budget
        // iteration failed the step and the workflow went stuck
        // despite the chart existing. Verifiable on exhaustion =
        // machine checks, or a declared sheet-write/app-create
        // change. Undeclared/'none' steps keep failing: their
        // product is the answer, which an exhausted loop never gave.
        const verifiableOnExhaustion =
          (step.checks !== undefined && step.checks.length > 0) ||
          step.expectedChange === 'sheet-write' ||
          step.expectedChange === 'app-create';
        if (
          outcome.end === 'answered' ||
          (outcome.end === 'exhausted' && verifiableOnExhaustion)
        ) {
          this.emitWorkflowEvent(threadId, wf, 'step_verifying', {
            stepIndex: i,
            stepTitle: step.title,
            attempt: step.attempts,
          });
          const verdict = await this.verifyStep(step, auditStart, outcome.end === 'exhausted');
          step.verification = verdict.detail;
          if (verdict.ok) {
            step.status = 'done';
            // An exhausted-but-verified step's reply text is the loop's
            // apology ("ran out of steps"), not a summary of the work —
            // storing it poisons the next step's "Already completed"
            // context and the final report. Keep ground truth instead.
            step.resultSummary =
              outcome.end === 'exhausted'
                ? truncateText(verdict.detail, 300)
                : truncateText(outcome.reply.message, 300);
            wf.currentStep = i + 1;
            this.saveWorkflow(wf);
            this.emitWorkflowEvent(threadId, wf, 'step_done', {
              stepIndex: i,
              stepTitle: step.title,
              attempt: step.attempts,
              detail: verdict.detail,
            });
            stepDone = true;
            // Declaration-frame fix: the initial plan was written
            // before any tool ran, so its check ranges for later steps
            // are invented blind. If this step discovered a schema,
            // re-plan the remainder now, with the schema attached, so
            // the replacement checks bind to absolute coordinates. A
            // failed re-plan keeps the original steps (today's
            // behavior) and is event-visible; the outer loop then
            // advances onto the replacement's first step (currentStep
            // already points past the done step, and the splice keeps
            // indices 0..i intact).
            if (!schemaReplanned) {
              schemaReplanned = await this.replanAfterDiscovery(
                threadId,
                wf,
                i,
                lastOutcome?.results ?? [],
                sheets,
              );
            }
            break;
          }
          failure =
            outcome.end === 'exhausted'
              ? `the step used up its iteration budget before finishing (verification: ${verdict.detail})`
              : `verification failed — ${verdict.detail}`;
        } else if (outcome.end === 'declined') {
          // Human gate (§1): the user declined a write inside this
          // step. The job halts; the completed steps stay.
          wf.status = 'halted';
          wf.stopDetail = 'the user declined a confirmation inside this step';
          this.saveWorkflow(wf);
          this.emitWorkflowEvent(threadId, wf, 'halted', {
            stepIndex: i,
            stepTitle: step.title,
            status: wf.status,
            detail: wf.stopDetail,
          });
          const message =
            `${outcome.reply.message}\n\nThe job stopped there — ${doneStepList(wf)} of ${wf.steps.length} steps ` +
            'were complete. The remaining steps were not run.';
          return {
            threadId,
            message,
            actionsTaken: [],
            ...(outcome.reply.chart ? { chart: outcome.reply.chart } : {}),
            workflow: workflowReplySummary(wf),
          };
        } else if (outcome.end === 'hitl-timeout') {
          // Human gate (§1): the job stays open at this step; the
          // next message on the thread resumes it from the checkpoint.
          wf.interruptedPhase = 'hitl-timeout';
          this.saveWorkflow(wf);
          this.emitWorkflowEvent(threadId, wf, 'step_retrying', {
            stepIndex: i,
            stepTitle: step.title,
            attempt: step.attempts,
            detail: 'waiting for the user; the job is saved at this step',
          });
          const message =
            `${outcome.reply.message}\n\nYour job is saved at step ${i + 1} of ${wf.steps.length} ` +
            `("${step.title}") — send any message and I will resume it from there. ` +
            'Completed steps will not be repeated.';
          return {
            threadId,
            message,
            actionsTaken: [],
            workflow: workflowReplySummary(wf),
          };
        } else {
          failure =
            outcome.end === 'exhausted'
              ? 'the step used up its iteration budget before finishing'
              : 'the model service failed during this step';
        }

        // Failed attempt: checkpoint + retry event, then loop (the
        // next pass applies steering, or re-plans before the last try).
        this.saveWorkflow(wf);
        if (step.attempts < MAX_STEP_ATTEMPTS) {
          this.emitWorkflowEvent(threadId, wf, 'step_retrying', {
            stepIndex: i,
            stepTitle: step.title,
            attempt: step.attempts,
            detail: failure,
          });
        }
      }

      if (!stepDone) {
        // Provably stuck (§1): attempts spent, steering + re-plan
        // tried, no verified progress. Report plainly and stop; the
        // record stays resumable — the user's next message re-arms
        // this step with whatever unblocks it.
        const step = wf.steps[i];
        wf.status = 'stuck';
        wf.stopDetail = failure || 'the step made no verified progress';
        this.saveWorkflow(wf);
        this.emitWorkflowEvent(threadId, wf, 'stuck', {
          stepIndex: i,
          stepTitle: step?.title,
          status: wf.status,
          detail: wf.stopDetail,
        });
        const landedTotal = landedBeforeDrive + this.landedWriteCells(driveAuditStart);
        const message =
          `I got stuck on step ${i + 1} of ${wf.steps.length} ("${step?.title ?? 'step'}") ` +
          `after ${step?.attempts ?? MAX_STEP_ATTEMPTS} attempts. ${wf.stopDetail}.\n` +
          `Completed so far: ${doneStepList(wf)}.\n` +
          (landedTotal > 0
            ? `Note: ${landedTotal} cell(s) were written along the way — those changes are in the sheet.\n`
            : '') +
          `What would unblock it: ${stuckUnblockHint(wf.stopDetail)} ` +
          `Send a message with that — or just "continue" — and I will resume from step ${i + 1}; ` +
          'the completed steps will not be repeated.';
        const hist = this.history(threadId);
        hist.push({ role: 'agent', text: message, ts: Date.now() });
        this.log(threadId, 'agent_message', { text: message });
        return {
          threadId,
          message,
          actionsTaken: [],
          ...(lastOutcome?.reply.chart ? { chart: lastOutcome.reply.chart } : {}),
          workflow: workflowReplySummary(wf),
        };
      }
    }

    // Every step verified done.
    wf.status = 'done';
    wf.currentStep = wf.steps.length;
    this.saveWorkflow(wf);
    this.emitWorkflowEvent(threadId, wf, 'done', {
      status: wf.status,
      detail: `${wf.steps.length} step(s) completed`,
    });
    // The last step may have exhausted its per-step budget yet still
    // verified (its effect landed). Its reply text is then the loop's
    // "ran out of steps" apology — never use it as the success lead-in,
    // or the done reply contradicts itself.
    const base =
      !lastOutcome || lastOutcome.end === 'exhausted'
        ? 'Done.'
        : (lastOutcome.reply.message ?? 'Done.');
    const message =
      wf.steps.length >= 2
        ? `${base}\n\nJob complete — all ${wf.steps.length} steps finished: ${wf.steps
            .map((s) => s.title)
            .join('; ')}.`
        : base;
    return {
      threadId,
      message,
      actionsTaken: [],
      ...(lastOutcome?.reply.chart ? { chart: lastOutcome.reply.chart } : {}),
      // #151: an app built by any step rides the done reply so the
      // panel stores it (Apps tab) and auto-opens it.
      ...(jobArtifact ? { artifact: jobArtifact } : {}),
      workflow: workflowReplySummary(wf),
    };
  }

  /** The step executor's prompt: the step, framed by the whole job and
   *  the verified results of the steps before it. */
  private stepPrompt(wf: AgentWorkflow, stepIndex: number, steering: string[]): string {
    const step = wf.steps[stepIndex]!;
    const done = wf.steps
      .slice(0, stepIndex)
      .filter((s) => s.status === 'done')
      .map((s, k) => `${k + 1}. "${s.title}" — ${s.resultSummary ?? 'done'}`);
    // #151 coherence fix (part 1): the agent follows the step text,
    // never the checks — so when the text and a cell-sum-equals check
    // disagree on the write target (prose "row 1" read 1-based vs a
    // 0-based check), the write lands where verification never reads.
    // Name the check's exact target cells + source ranges, in the
    // tools' own 0-based frame, right after the step text, so text
    // and check agree on the cells before the agent acts.
    const grounding = checkGroundingLines(step.checks);
    const lines = [
      `[Step ${stepIndex + 1} of ${wf.steps.length} of a multi-step job] ${step.title}`,
      `The overall job: ${wf.originText}`,
      done.length > 0 ? `Already completed:\n${done.join('\n')}` : 'Nothing is completed yet.',
      `This step: ${step.instruction}`,
      ...(grounding.length > 0
        ? [
            'Write targets for this step — this step is checked against EXACTLY these cells, so write each total to the cell named on its line and to no other cell (a total written anywhere else fails even if its value is right):',
            ...grounding,
          ]
        : []),
      'Work only on this step. When this step\'s goal is fully met, finish with a brief summary of what you did or found for this step.',
      'How to work this step: read the actual data you will change BEFORE writing — never assume separators, formats, or values from the step text alone. For one-off data transforms (cleaning, splitting, converting values), write the computed literal values rather than formulas. A rewrite of a range must preserve every column and row this step does not name — never drop data the step was not asked to remove. After writing, read the changed range back and compare it against this step\'s goal; if it does not match, fix it within this step before finishing.',
    ];
    for (const note of steering) lines.push(`Note: ${note}`);
    return lines.join('\n');
  }

  /**
   * Declaration-frame fix: re-plan the steps AFTER a completed
   * discovery step, with the discovered schema attached to the plan
   * call. The initial plan is written before any tool runs, so its
   * check ranges for compute steps are invented blind (observed live:
   * "Revenue row 1" — relative to the dimension row — declared as an
   * absolute range, and a 9-value range that dropped the last year
   * column). The step loop itself sees describe_sheet output and
   * computes correctly, but verifyStep reads the plan's frozen checks,
   * so without this re-plan the declaration never heals. Returns true
   * when the remainder was replaced; false when nothing was discovered,
   * nothing remains, or the re-plan produced no usable plan (the
   * original steps are then kept — today's behavior — and the failure
   * is event-visible). The re-plan prompt names the discovered sheets
   * and restricts rebinding to steps touching them, so a step working
   * another sheet keeps its original checks.
   */
  private async replanAfterDiscovery(
    threadId: string,
    wf: AgentWorkflow,
    doneIndex: number,
    stepResults: ToolResultRecord[],
    sheets: string[] | undefined,
  ): Promise<boolean> {
    const discovered = stepResults.filter((r) => r.tool === 'describe_sheet' && r.ok);
    if (discovered.length === 0) return false;
    const next = doneIndex + 1;
    if (next >= wf.steps.length) return false;
    const describedSheets = [
      ...new Set(
        discovered
          .map((r) => {
            const d = r.data as { sheet?: unknown } | undefined;
            return typeof d?.sheet === 'string' ? d.sheet : '';
          })
          .filter((s) => s.length > 0),
      ),
    ];
    const doneTitles = wf.steps
      .slice(0, next)
      .filter((s) => s.status === 'done')
      .map((s) => s.title);
    const plan = await this.planJobSafe(
      threadId,
      `The overall job: ${wf.originText}\n` +
        `Steps already completed (do not redo them): ${doneTitles.length > 0 ? doneTitles.join('; ') : 'none'}.\n` +
        `Schema discovery just completed for ${describedSheets.length > 0 ? describedSheets.map((s) => `"${s}"`).join(', ') : 'a sheet'} — the tool results below are ground truth. ` +
        'Re-plan the REMAINING steps (starting after the completed discovery step) as new steps, binding every check\'s row/col ranges to the coordinates in these tool results (0-based ABSOLUTE sheet coordinates). ' +
        'Rebind ONLY steps that touch a discovered sheet; for any step touching another sheet, keep its original checks unchanged. ' +
        'Never reuse ranges from the original plan or from conversation summaries for a discovered sheet.',
      sheets,
      undefined,
      discovered,
    );
    if (!plan || plan.steps.length === 0) {
      this.emitWorkflowEvent(threadId, wf, 'step_replan_failed', {
        stepIndex: next,
        detail: 'schema re-plan returned no usable plan; original steps kept',
      });
      return false;
    }
    const replacement = plan.steps.map(newStepRecord);
    wf.steps = [...wf.steps.slice(0, next), ...replacement];
    wf.currentStep = next;
    this.saveWorkflow(wf);
    this.emitWorkflowEvent(threadId, wf, 'step_replanned', {
      stepIndex: next,
      detail: `re-planned after schema discovery for ${describedSheets.join(', ') || 'a sheet'}`,
    });
    return true;
  }

  /**
   * Re-plan the remaining steps (§2.2): ask the backend for a fresh
   * plan for the work from `stepIndex` on, given what completed and
   * how the current step failed. The replacement step inherits the
   * spent attempts minus one, so a re-plan buys exactly one fresh
   * attempt per step position — the retry budget stays bounded, the
   * job as a whole has no step ceiling. Returns false when no usable
   * plan came back (the caller then spends the last attempt on the
   * original step, with steering).
   */
  private async replanRemainder(
    threadId: string,
    wf: AgentWorkflow,
    stepIndex: number,
    failure: string,
    sheets: string[] | undefined,
  ): Promise<boolean> {
    const failed = wf.steps[stepIndex];
    if (!failed) return false;
    const doneTitles = wf.steps
      .slice(0, stepIndex)
      .filter((s) => s.status === 'done')
      .map((s) => s.title);
    // Ground truth for the re-plan (§2.2): a failed step often means
    // the original plan was written against an ASSUMED layout. Read
    // the current header row of the sheets the failed step targeted
    // (falling back to the workbook's first sheets) so replacement
    // steps and their checks bind to the layout that actually exists.
    const layoutLines: string[] = [];
    // #151 coherence fix (part 2): ground the failure re-plan on the
    // check's SOURCE sheets too, not only its target sheets — the old
    // collection read only Summaries, so the re-plan re-derived
    // source rows without Income grounding and produced wrong-row
    // checks (years/COGS/Taxes) on attempt 3.
    const targetSheets = new Set<string>(replanGroundingSheets(failed.checks));
    const readHeader = async (sheet: string): Promise<boolean> => {
      try {
        const data = (await this.callTool('read_cells', {
          sheet,
          startRow: 0,
          startCol: 0,
          endRow: 0,
          endCol: 15,
        })) as { cells?: unknown };
        const headers: string[] = [];
        for (let col = 0; col < 16; col++) {
          const v = cellAt(data, 0, col);
          if (v === null || v === undefined || v === '') break;
          headers.push(String(v));
        }
        if (headers.length === 0) return false;
        layoutLines.push(
          `Sheet "${sheet}" currently starts with these columns, in order: ${headers.join(' | ')}.`,
        );
        return true;
      } catch {
        return false;
      }
    };
    for (const sheet of [...targetSheets].slice(0, 3)) await readHeader(sheet);
    if (layoutLines.length === 0 && sheets) {
      for (const sheet of sheets.slice(0, 2)) await readHeader(sheet);
    }
    // Declaration-frame fix: the failure re-plan gets the same schema
    // channel as the discovery re-plan. Row-0 headers (above) are
    // useless ground truth for horizontal layouts — row 0 is not a
    // header row there — so ALSO attach describe_sheet results for
    // the failed step's sheets; the planner binds replacement checks
    // to those absolute coordinates. A describe_sheet failure just
    // leaves the row-0 lines as the fallback.
    const schemaResults: ToolResultRecord[] = [];
    for (const sheet of [...targetSheets].slice(0, 3)) {
      try {
        const data = await this.callTool('describe_sheet', { sheet });
        schemaResults.push({ tool: 'describe_sheet', ok: true, summary: 'describe_sheet ok', data });
      } catch {
        /* row-0 headers above remain the fallback */
      }
    }
    const plan = await this.planJobSafe(
      threadId,
      `The overall job: ${wf.originText}\n` +
        `Steps already completed (do not redo them): ${doneTitles.length > 0 ? doneTitles.join('; ') : 'none'}.\n` +
        `The step "${failed.title}" (${failed.instruction}) has failed twice. Latest failure: ${failure}.\n` +
        (layoutLines.length > 0
          ? `Current workbook layout (ground truth — bind sheet names and column indexes in the new steps and their checks to THIS, not to what the failed plan assumed):\n${layoutLines.join('\n')}\n`
          : '') +
        // #161: the observed failure mode re-planned a rejected app step
        // into sheet writes ("initialize" a sheet with the app's content),
        // clearing real data. An app failure stays an app failure.
        `If the failed step was building an app (its instruction mentions an app, or generate_app failed), the replacement MUST still build the app with generate_app or report the failure visibly — NEVER substitute writing the app as sheet content, and NEVER clear, overwrite, or "initialize" an existing sheet to make room for it.\n` +
        'Plan the REMAINING work — starting with a replacement for the failed step, split into smaller steps if that helps — as new steps.',
      sheets,
      undefined,
      schemaResults,
    );
    if (!plan || plan.steps.length === 0) return false;
    const replacement = plan.steps.map(newStepRecord);
    // #161 (mechanical): the prompt rule above is not enough on its own —
    // a planner that already substituted sheet writes once will do it
    // again. After an app failure the only safe replacements are another
    // app attempt or a report step; anything else is dropped, including
    // undeclared steps (a replacement that writes without declaring is
    // exactly the destructive shape). An empty remainder fails the
    // re-plan, so the job stops visibly with the original app failure
    // instead of destroying sheet data. Normal write steps are untouched:
    // this filter runs only after an app failure.
    const failedIsAppStep =
      failed.expectedChange === 'app-create' ||
      /\bapp\b/i.test(`${failed.title} ${failed.instruction}`) ||
      /generate_app/.test(failure);
    const kept = failedIsAppStep
      ? replacement.filter((s) => s.expectedChange === 'app-create' || s.expectedChange === 'none')
      : replacement;
    if (kept.length === 0) return false;
    kept[0]!.attempts = MAX_STEP_ATTEMPTS - 1;
    wf.steps = [...wf.steps.slice(0, stepIndex), ...kept];
    wf.currentStep = stepIndex;
    return true;
  }

  /**
   * Verify a step before the job advances (§2.3): ground truth over
   * self-report, driven ONLY by the LLM planner's declared expected
   * change (#151). With machine checks, each check is read back
   * through the MCP tools. Without checks, the declared kind selects
   * the one matching check — sheet-write verifies a sheet change,
   * app-create verifies only the created artifact — and no
   * declaration means no verification at all. No default check is
   * ever imposed from the step's wording.
   */
  private async verifyStep(
    step: WorkflowStepRecord,
    auditStart: number,
    onExhaustion = false,
  ): Promise<{ ok: boolean; detail: string }> {
    const segment = this.audit.slice(auditStart);
    const okCalls = segment.filter((e) => e.kind === 'tool_call' && e.ok === true);
    // #162's report-step predicate, hoisted so the #165 floor below
    // shares it: a step whose title or instruction STARTS with a
    // reporting verb is a report step, not an action step — its
    // effect IS the answer — even when the sentence mentions work
    // nouns ('Tell the user the chart is ready' mentions a chart
    // but asks for no tool call).
    const isReportStep =
      /^(report|tell|say|answer|summarize|summarise|explain|state)\b/i.test(
        step.title.trim(),
      ) ||
      /^(report|tell|say|answer|summarize|summarise|explain|state)\b/i.test(
        step.instruction.trim(),
      );
    // #165: on an EXHAUSTED step, a chart-shaped action step must
    // have landed a chart effect — otherwise the round-3 exhaustion
    // verification passes it on machine checks that measure
    // PRE-EXISTING state (sheet-exists, range-filled on already-filled
    // data), which is how round-4 leg B reported 'complete: all 2
    // steps done' with zero canvases after 9 refused create_chart
    // calls. The checks branch below short-circuits the declaration
    // branches, so without this floor checks alone can complete a
    // chart step that produced nothing. Report steps are exempt
    // (their product is the answer about a chart built elsewhere);
    // app steps are exempt (their chart lives inside the app,
    // verified via generate_app). A landed panel chart (analyze_data
    // ok) counts alongside a landed native chart (create_chart ok).
    // Answered steps keep their existing semantics: this floor gates
    // only the exhaustion path the regression came from.
    const stepText = `${step.title}\n${step.instruction}`;
    const isChartStep =
      /\bchart(s|ing|ed)?\b/i.test(stepText) && !/\bapp\b/i.test(stepText);
    if (onExhaustion && isChartStep && !isReportStep) {
      const chartEffects = okCalls.filter(
        (e) => e.tool === 'create_chart' || e.tool === 'analyze_data',
      ).length;
      if (chartEffects === 0) {
        return {
          ok: false,
          detail:
            'the chart step produced no chart (no successful create_chart or analyze_data call in this attempt)',
        };
      }
    }
    if (step.checks && step.checks.length > 0) {
      const failures: string[] = [];
      const passes: string[] = [];
      for (const check of step.checks) {
        const r = await this.runStepCheck(check);
        if (r.ok) passes.push(r.detail);
        else failures.push(r.detail);
      }
      if (failures.length === 0) {
        return { ok: true, detail: `checks passed: ${passes.join('; ')}` };
      }
      return { ok: false, detail: failures.join('; ') };
    }
    // #151 (owner-refined): verification runs ONLY on a declared
    // change, and the check matches the declared kind and nothing
    // else. The declaration is the LLM planner's own
    // step.expectedChange — never a runtime guess from the step's
    // wording. Machine checks above are themselves an explicit
    // declaration and are unchanged. No declaration (or 'none')
    // means nothing to validate: the step passes unverified. The
    // old default branches (sheet-change check on write-shaped
    // wording, tool-activity check on anything else) are gone:
    // imposing a check the LLM never declared is the bug.
    // (segment/okCalls are computed at the top of this method, where
    // the #165 floor uses them.)
    if (step.expectedChange === 'app-create') {
      const appCalls = okCalls.filter((e) => e.tool === 'generate_app');
      if (appCalls.length > 0) {
        return {
          ok: true,
          detail: `app artifact created via generate_app (${appCalls.length} successful call(s))`,
        };
      }
      return {
        ok: false,
        detail: 'the app step produced no app artifact (no successful generate_app call)',
      };
    }
    if (step.expectedChange === 'sheet-write') {
      const writeEffects = okCalls.filter(
        (e) => e.tool !== undefined && WRITE_EFFECT_TOOLS.has(e.tool),
      ).length;
      if (writeEffects === 0) {
        return {
          ok: false,
          detail: 'the step was supposed to change the sheet but no write landed',
        };
      }
      return {
        ok: true,
        detail: `sheet change verified: ${writeEffects} write effect(s)`,
      };
    }
    // #162: a step that asks for an ACTION but lands no tool call at
    // all has done nothing — it must not pass vacuously and let the
    // workflow claim completion (observed live: a re-planned
    // 'Analyze revenue data' step with no tool call 'completed' a
    // chart job that produced no panel chart). Scoped deliberately
    // narrow in two ways. (1) ONLY tool-effect verbs count, as FULL
    // WORDS with boundaries on both sides — stem matching is wrong
    // here ('read' as a stem fires on 'ready' in 'Tell the user the
    // app is ready', which broke the #151 app test). (2) A step
    // whose title or instruction STARTS with a reporting verb
    // (report/tell/say/answer/summarize/explain/state) is a report
    // step, not an action step — its effect IS the answer — even
    // when the sentence mentions work nouns ('Tell the user the
    // chart is ready' mentions a chart but asks for no tool call).
    // Pure answer/report steps ('Identify the region...', 'Tell the
    // user...') still pass (case7sql pin), and the promotion
    // fallback ('Finish the request', no action verb) still passes.
    // A re-planned action step that does nothing now fails honestly
    // instead of completing vacuously. (isReportStep is computed at
    // the top of this method, where the #165 floor shares it.)
    const actionStep =
      !isReportStep &&
      /\b(analyze|analyzes|analyzing|analyzed|chart|charts|charting|charted|create|creates|creating|created|compute|computes|computing|computed|calculate|calculates|calculating|calculated|write|writes|writing|written|wrote|build|builds|building|built|generate|generates|generating|generated|plot|plots|plotting|plotted|fetch|fetches|fetching|fetched|read|reads|reading|find|finds|finding|found|discover|discovers|discovering|discovered|list|lists|listing|listed|check|checks|checking|checked|verify|verifies|verifying|verified|set|sets|setting|update|updates|updating|updated|delete|deletes|deleting|deleted|clear|clears|clearing|cleared|move|moves|moving|moved|copy|copies|copying|copied|import|imports|importing|imported|export|exports|exporting|exported|refresh|refreshes|refreshing|refreshed|recalculate|recalculates|recalculating|recalculated)\b/i.test(
        `${step.title}\n${step.instruction}`,
      );
    if (actionStep && okCalls.length === 0) {
      return {
        ok: false,
        detail: 'the step produced no effects (no tool call landed)',
      };
    }
    return { ok: true, detail: 'no change declared; nothing to verify' };
  }

  /** Run one machine check through the MCP tools (§2 — no private path). */
  private async runStepCheck(check: StepCheck): Promise<{ ok: boolean; detail: string }> {
    try {
      switch (check.kind) {
        case 'sheet-exists': {
          const data = (await this.callTool('list_sheets', {})) as { sheets?: unknown };
          const sheets = Array.isArray(data?.sheets) ? (data.sheets as unknown[]) : [];
          const ok = sheets.some((s) => s === check.sheet);
          return {
            ok,
            detail: ok
              ? `sheet "${check.sheet}" exists`
              : `sheet "${check.sheet}" does not exist (sheets: ${sheets.join(', ') || 'none'})`,
          };
        }
        case 'cell-equals':
        case 'cell-nonempty': {
          const data = (await this.callTool('read_cells', {
            sheet: check.sheet,
            startRow: check.row,
            startCol: check.col,
            endRow: check.row,
            endCol: check.col,
          })) as { cells?: unknown };
          const v = cellAt(data, 0, 0);
          const ref = `${check.sheet}!${a1Ref(check.row, check.col)}`;
          if (check.kind === 'cell-nonempty') {
            return isEmptyCell(v)
              ? { ok: false, detail: `${ref} is empty` }
              : { ok: true, detail: `${ref} is filled` };
          }
          const ok = cellEquals(v, check.equals);
          return {
            ok,
            detail: ok
              ? `${ref} = ${JSON.stringify(check.equals)} as expected`
              : `${ref} holds ${JSON.stringify(v ?? null)}, expected ${JSON.stringify(check.equals)}`,
          };
        }
        case 'range-filled': {
          const rows = Math.min(check.endRow, check.startRow + 999) - check.startRow + 1;
          const cols = Math.min(check.endCol, check.startCol + 99) - check.startCol + 1;
          const data = (await this.callTool('read_cells', {
            sheet: check.sheet,
            startRow: check.startRow,
            startCol: check.startCol,
            endRow: check.startRow + rows - 1,
            endCol: check.startCol + cols - 1,
          })) as { cells?: unknown };
          let empty = 0;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (isEmptyCell(cellAt(data, r, c))) empty++;
            }
          }
          const total = rows * cols;
          return empty === 0
            ? { ok: true, detail: `range ${check.sheet} rows ${check.startRow}-${check.endRow} cols ${check.startCol}-${check.endCol} fully filled (${total} cells)` }
            : { ok: false, detail: `${empty} of ${total} cells in the checked range on ${check.sheet} are empty` };
        }
        case 'column-sum-equals': {
          const data = (await this.callTool('read_cells', {
            sheet: check.sheet,
            startRow: check.startRow,
            startCol: check.col,
            endRow: check.endRow,
            endCol: check.col,
          })) as { cells?: unknown };
          let sum = 0;
          let numeric = 0;
          for (let r = 0; r <= check.endRow - check.startRow; r++) {
            const v = cellAt(data, r, 0);
            if (typeof v === 'number' && Number.isFinite(v)) {
              sum += v;
              numeric++;
            }
          }
          if (numeric === 0) {
            return { ok: false, detail: `no numeric values in ${check.sheet} column ${check.col} rows ${check.startRow}-${check.endRow}` };
          }
          const ok = numEq(sum, check.equals);
          return {
            ok,
            detail: ok
              ? `${check.sheet} column segment sums to ${check.equals} as expected`
              : `${check.sheet} column segment sums to ${sum}, expected ${check.equals}`,
          };
        }
        case 'cell-sum-equals': {
          // #155: a written total is checked against an INDEPENDENTLY
          // recomputed truth — the engine's own sum over the declared
          // source range — never against a value the planner supplied
          // (the planner's arithmetic is exactly what was wrong).
          // range-filled proves landing only; this proves the value.
          const rows = Math.min(check.sourceEndRow, check.sourceStartRow + 999) - check.sourceStartRow + 1;
          const cols = Math.min(check.sourceEndCol, check.sourceStartCol + 99) - check.sourceStartCol + 1;
          const data = (await this.callTool('read_cells', {
            sheet: check.sourceSheet,
            startRow: check.sourceStartRow,
            startCol: check.sourceStartCol,
            endRow: check.sourceStartRow + rows - 1,
            endCol: check.sourceStartCol + cols - 1,
          })) as { cells?: unknown };
          let sum = 0;
          let numeric = 0;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const v = cellAt(data, r, c);
              if (typeof v === 'number' && Number.isFinite(v)) {
                sum += v;
                numeric++;
              }
            }
          }
          if (numeric === 0) {
            return { ok: false, detail: `no numeric values in source range ${check.sourceSheet} rows ${check.sourceStartRow}-${check.sourceEndRow} cols ${check.sourceStartCol}-${check.sourceEndCol}` };
          }
          const target = (await this.callTool('read_cells', {
            sheet: check.sheet,
            startRow: check.row,
            startCol: check.col,
            endRow: check.row,
            endCol: check.col,
          })) as { cells?: unknown };
          const v = cellAt(target, 0, 0);
          const ref = `${check.sheet}!${a1Ref(check.row, check.col)}`;
          const ok = cellEquals(v, sum);
          return {
            ok,
            detail: ok
              ? `${ref} = ${JSON.stringify(v ?? null)} matches the source sum ${sum} (${numeric} values) as expected`
              : `${ref} holds ${JSON.stringify(v ?? null)}, but the source range sums to ${sum} (${numeric} values)`,
          };
        }
      }
    } catch (e) {
      return {
        ok: false,
        detail: `verification read failed (${e instanceof Error ? e.message : String(e)})`,
      };
    }
  }

  /**
   * Answer a pending human-in-the-loop ask. This is the programmatic
   * counterpart of the web UI's answer buttons: it delivers the answer
   * through the versioned agent.answer_pending MCP tool, which unblocks
   * the paused tool call (there is no runtime-level pending map — the
   * single implementation is the shared PendingAskStore). Answers the
   * most recent pending ask for this runtime's principal.
   *
   * With NO pending ask, the answer is a clean NO-OP (agent-failures-fix
   * W4): the ask it targets was already answered, timed out, or was
   * suppressed at the grounding gate and withdrawn. It must never start
   * a chat turn — runtimes are rebuilt on session swaps in the gateway,
   * so an answer landing on a runtime with nothing parked used to fall
   * through to chat() on a fallback (heuristic) backend, whose help-menu
   * ask re-parked and looped against the answerer. A caller who wants a
   * new turn sends a normal message (chat), not an answer.
   */
  async answer(threadId: string, answerText: string): Promise<AgentReply> {
    // Guardrail: the input cap applies to answers too (an over-long
    // answer must not be delivered to the pending ask). Rate/concurrency
    // limits deliberately do NOT apply here: a parked turn awaiting its
    // answer is not a new turn, and answering it must never be blocked.
    if (answerText.length > this.maxInputChars) {
      return this.guardrailReply(
        threadId,
        agentInputTooLongMessage(this.maxInputChars, answerText.length),
        `guardrail rejection: answer too long (${answerText.length} chars > limit ${this.maxInputChars})`,
        this.audit.length,
      );
    }
    const asks = await this.listPendingAsks();
    if (asks.length === 0) {
      // W4 no-op: nothing is parked for this principal, so the answer
      // targets an already-consumed ask. Record it in the audit (the
      // user DID send it) and reply without planning or tools.
      const turnStart = this.audit.length;
      const message =
        'That question is no longer pending — it was already answered or withdrawn, so there is nothing to resume. Send a new message if you would like me to do something.';
      const hist = this.history(threadId);
      hist.push({ role: 'system', text: message, ts: Date.now() });
      this.log(threadId, 'confirmation', {
        text: answerText,
        summary: 'answer received with no pending ask (already consumed) — clean no-op, no turn started',
      });
      this.log(threadId, 'agent_message', { text: message });
      this.saveThread(threadId);
      return { threadId, message, actionsTaken: this.audit.slice(turnStart) };
    }
    const ask = asks[asks.length - 1]!;
    await this.answerPendingAsk(ask.id, answerText);
    const turnStart = this.audit.length;
    const hist = this.history(threadId);
    hist.push({ role: 'user', text: answerText, ts: Date.now() });
    this.log(threadId, 'user_message', { text: answerText });
    this.log(threadId, 'confirmation', {
      text: answerText,
      summary: `answered pending ${ask.kind} ask ${ask.id}; the paused turn resumes from it`,
    });
    const message = 'Answer recorded — the paused turn resumes from it.';
    hist.push({ role: 'agent', text: message, ts: Date.now() });
    this.log(threadId, 'agent_message', { text: message });
    this.saveThread(threadId);
    return { threadId, message, actionsTaken: this.audit.slice(turnStart) };
  }

  /**
   * Pending human-in-the-loop asks for this runtime's principal, oldest
   * first (ai-agent.md §12). Surfaced by the chat UI so the user can see
   * and answer what the paused agent is waiting for. Backed by the
   * versioned agent.list_pending MCP tool.
   */
  async listPendingAsks(): Promise<PendingAskView[]> {
    const client = await this.ensureConnected();
    const res = await client.callTool({
      name: 'agent.list_pending',
      arguments: { principal: this.principal },
    });
    const parsed = parseToolResult(res);
    if (!parsed.ok) throw new Error(`agent.list_pending failed: ${parsed.error}`);
    const asks = (parsed.data as { asks?: unknown }).asks;
    return Array.isArray(asks) ? (asks as PendingAskView[]) : [];
  }

  /**
   * Deliver the human's answer to a pending ask (ai-agent.md §12),
   * unblocking the paused agent.* tool call. Principal-scoped: the tool
   * rejects answers to another principal's asks.
   */
  async answerPendingAsk(askId: string, answer: string, note?: string): Promise<void> {
    const client = await this.ensureConnected();
    const res = await client.callTool({
      name: 'agent.answer_pending',
      arguments: {
        askId,
        answer,
        ...(note !== undefined ? { note } : {}),
        principal: this.principal,
      },
    });
    const parsed = parseToolResult(res);
    if (!parsed.ok) throw new Error(`agent.answer_pending failed: ${parsed.error}`);
  }

  /**
   * Human-in-the-loop question via the versioned MCP tool (§12): the call
   * blocks until the human answers. Returns the answer text, or 'timeout'
   * when nobody answered in time.
   */
  private async askUser(
    threadId: string,
    question: string,
    options?: string[],
  ): Promise<string | 'timeout'> {
    const client = await this.ensureConnected();
    const useOptions = !!options && options.length > 0;
    const tool = useOptions ? 'agent.offer_options' : 'agent.ask_question';
    const args = {
      principal: this.principal,
      question,
      ...(useOptions ? { options } : {}),
    };
    this.log(threadId, 'tool_call', {
      tool,
      args,
      ok: true,
      summary: `human-in-the-loop ${tool}: paused waiting for the user`,
    });
    let res: unknown;
    try {
      res = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: this.hitlClientTimeoutMs,
      });
    } catch (e) {
      // Client-side timeout: only reachable when the runtime's
      // hitlTimeoutMs is smaller than the server's — a wiring bug.
      this.log(threadId, 'timeout', {
        text: tool,
        summary: `HITL wait hit the client timeout: ${e instanceof Error ? e.message : String(e)}`,
      });
      return 'timeout';
    }
    const parsed = parseToolResult(res);
    if (!parsed.ok) {
      this.log(threadId, 'timeout', {
        text: tool,
        summary: `HITL wait ended: ${parsed.error}`,
      });
      return 'timeout';
    }
    const data = parsed.data as { answer?: unknown; selected?: unknown };
    const answer = useOptions ? data.selected : data.answer;
    if (typeof answer !== 'string') {
      this.log(threadId, 'timeout', { text: tool, summary: 'HITL tool returned no answer' });
      return 'timeout';
    }
    this.log(threadId, 'user_message', { text: answer });
    return answer;
  }

  /**
   * Write-discipline confirmation via the versioned MCP tool (§7 + §12):
   * blocks until the human approves or denies.
   */
  private async requestApproval(
    threadId: string,
    action: string,
    detail: string,
  ): Promise<{ approved: boolean; note?: string } | 'timeout'> {
    const client = await this.ensureConnected();
    this.log(threadId, 'tool_call', {
      tool: 'agent.request_approval',
      args: { principal: this.principal, action, detail },
      ok: true,
      summary: 'human-in-the-loop agent.request_approval: paused waiting for the user',
    });
    let res: unknown;
    try {
      res = await client.callTool(
        { name: 'agent.request_approval', arguments: { principal: this.principal, action, detail } },
        undefined,
        { timeout: this.hitlClientTimeoutMs },
      );
    } catch (e) {
      this.log(threadId, 'timeout', {
        text: 'agent.request_approval',
        summary: `approval wait hit the client timeout: ${e instanceof Error ? e.message : String(e)}`,
      });
      return 'timeout';
    }
    const parsed = parseToolResult(res);
    if (!parsed.ok) {
      this.log(threadId, 'timeout', {
        text: 'agent.request_approval',
        summary: `approval wait ended: ${parsed.error}`,
      });
      return 'timeout';
    }
    const data = parsed.data as { approved?: unknown; note?: unknown };
    return {
      approved: data.approved === true,
      note: typeof data.note === 'string' ? data.note : undefined,
    };
  }

  /** Graceful end of a turn whose human never answered. */
  private hitlTimeoutReply(threadId: string): AgentReply {
    const message =
      "I didn't get an answer in time, so I stopped here. Ask me again when you're ready and we can continue.";
    const hist = this.history(threadId);
    hist.push({ role: 'agent', text: message, ts: Date.now() });
    this.log(threadId, 'agent_message', { text: message });
    this.saveThread(threadId);
    return { threadId, message, actionsTaken: [] };
  }

  private async runLoopDetailed(
    threadId: string,
    userText: string,
    toolResults: ToolResultRecord[],
    asksUsed = 0,
    groundedSeed = false,
    // Turn-scoped context (agent-failures-fix): threaded unchanged
    // through the ask-resume recursion — it is the same turn.
    originText: string = userText,
    turnStartedAt: number = Date.now(),
    auditStart: number = -1,
    aggregateCorrections = 0,
    sheetNames: string[] | undefined | null = null,
    /** #40 streaming/cancel hooks for this turn (undefined = one-shot). */
    hooks?: AgentTurnHooks,
    /** Round-2 step scope (workflow steps only): "title\ninstruction"
     * of the step this loop executes. When set, create_chart calls
     * from steps that are not about native chart creation are
     * refused at execution (discovery overshoot guard). Undefined
     * in plain-loop turns: the guard is inactive there. */
    stepScope?: string,
  ): Promise<LoopOutcome> {
    const hist = this.history(threadId);
    if (auditStart < 0) auditStart = this.audit.length;
    // W3: fetch the workbook's real sheet names once per turn (through
    // the list_sheets MCP tool) for planner context + ask validation.
    // undefined = lookup failed / no workbook: W3 behavior disables.
    let sheets: string[] | undefined | null = sheetNames;
    if (sheets === null) sheets = await this.fetchSheetNames();
    let results = toolResults;
    // Grounding (FIX-R4): whether any REAL tool has executed this turn.
    // An ask may only park once the planner has looked at the sheet /
    // memory / workbook — a first-move ask about facts the tools can
    // supply ("which column contains the revenue data?") is suppressed.
    // Suppression notes (tool 'agent.ask_question') never count. The
    // ask-resume recursion passes the flag along: it is the same turn.
    // EXEMPTION (narrowed 2026-10-22): only a PRODUCT-CONSTRUCTED intent
    // choice may park ungrounded — the #139 help menu, built by the
    // runtime (helpMenuAsk) and marked intentChoice: true (see
    // AskAction). No tool can answer an intent choice and there is
    // nothing to ground on yet. The exemption used to cover ANY ask carrying options, on the assumption that ask cascades
    // were free-text; the combined-build live proof falsified that — the
    // planner packaged its first-move fact-fishing question ("which
    // column contains the revenue data?") as an options ask and parked
    // ungrounded for the full HITL wait. A planner-generated ask is
    // therefore gated whether or not it carries options; the marker
    // cannot be forged by model output (the LLM action parser whitelists
    // the fields it copies, and this is not one of them).
    let grounded = groundedSeed || toolResults.some((r) => r.tool !== 'agent.ask_question');

    for (let iter = 1; iter <= this.maxIterations; iter++) {
      if (hooks?.isCancelled?.()) throw new AgentTurnCancelled();
      hooks?.onEvent?.({ type: 'thinking', iteration: iter });
      let plan: PlannerOutput;
      try {
        plan = await this.backend.plan({
          userText,
          history: [...hist],
          toolResults: results,
          iteration: iter,
          // #135: the client's active sheet rides with the workbook
          // context so sheet-less data access reads the sheet the
          // user is on; absent = first-sheet fallback downstream.
          ...(sheets && sheets.length > 0
            ? {
                sheetContext: {
                  sheets,
                  ...(hooks?.sheet ? { activeSheet: hooks.sheet } : {}),
                },
              }
            : {}),
        },
        // #137 streaming: the backend's streamed message text flows
        // out as 'token' events; the gateway forwards them as SSE
        // 'turn' events and the panel appends them (done reconciles).
        hooks?.onEvent
          ? { onToken: (text: string) => hooks.onEvent?.({ type: 'token', text }) }
          : undefined,
        );
      } catch (e) {
        // Planner-fix M4-slim (2026-10-22, merged with FIX-R4): the
        // backend already retries transient provider failures with
        // backoff (FIX-R4 round 2); a throw that still escapes plan()
        // used to propagate out of chat() and surface as a raw HTTP 500
        // with provider error text. End the turn with an honest reply
        // instead. No runtime-level retry — the backend's own
        // backoff already ran.
        // #137 EXCEPTION: a no-model failure is a configuration error,
        // not a transient one — it must surface VERBATIM (never the
        // generic busy text), with zero tool calls, so the user sees
        // exactly why nothing ran.
        if (e instanceof NoModelConfiguredError) {
          const noModelMessage = e.message;
          this.log(threadId, 'timeout', {
            text: 'planner',
            summary: `planner call failed: no model configured`,
          });
          hist.push({ role: 'agent', text: noModelMessage, ts: Date.now() });
          this.log(threadId, 'agent_message', { text: noModelMessage });
          return {
            reply: { threadId, message: noModelMessage, actionsTaken: [], chart: this.chartAttachment(results) },
            end: 'planner-failed',
            results,
          };
        }
        this.log(threadId, 'timeout', {
          text: 'planner',
          summary: `planner call failed (${e instanceof Error ? e.message : String(e)})`,
        });
        // #143: surface the REAL upstream error instead of the generic
        // busy text — the busy text hid the provider rejection that
        // killed the Groq legs, making the failure undiagnosable from
        // any log. Backend errors never carry a key; scrub key-like
        // patterns anyway and bound the length.
        const cause = sanitizePlannerError(e);
        // Server-side breadcrumb: the audit entry above records it,
        // but service stdout is what the next diagnosis reads first.
        console.error(`[agent] planner call failed: ${cause}`);
        // W1 honest progress: a failed planner call mid-batch must not
        // read as "nothing happened" when earlier chunks already landed.
        const landedBeforeFailure = this.landedWriteCells(auditStart);
        const message =
          `The model call failed: ${cause}.` +
          (landedBeforeFailure > 0
            ? ` Note: ${landedBeforeFailure} cell(s) were already written before the failure — those changes are in the sheet.`
            : '');
        hist.push({ role: 'agent', text: message, ts: Date.now() });
        this.log(threadId, 'agent_message', { text: message });
        return {
          reply: { threadId, message, actionsTaken: [], chart: this.chartAttachment(results) },
          end: 'planner-failed',
          results,
        };
      }
      // #40: an intermediate plan (it still has work to do) narrates
      // itself into the thought stream; the FINAL plan's message is the
      // answer and arrives with the reply.
      if (hooks?.onEvent && plan.actions.length > 0 && plan.message.trim().length > 0) {
        hooks.onEvent({ type: 'thought', text: plan.message });
      }

      // Write discipline (§7): confirm broad/destructive writes first.
      const { confirm: needsConfirm, headerNotes } = await this.confirmationTargets(
        threadId,
        plan.actions.filter(isTool),
      );
      const needsConfirmSet = new Set<ToolCallAction>(needsConfirm);
      const rest = plan.actions.filter((a) => !(isTool(a) && needsConfirmSet.has(a)));
      if (needsConfirm.length > 0) {
        const n = needsConfirm.reduce((c, a) => c + cellCount(a), 0);
        const question =
          headerNotes.length > 0
            ? `${headerNotes[0]}${headerNotes.length > 1 ? ` (and ${headerNotes.length - 1} more header overwrite(s))` : ''} Proceed?`
            : `This will modify ${n} cell(s). Proceed?`;
        this.log(threadId, 'question', { text: question, summary: 'confirmation requested' });
        // Execute the non-confirming actions now so the turn isn't lost;
        // only the confirming actions wait for the user's answer.
        const done = await this.executeTools(threadId, rest.filter(isTool), hooks, stepScope, userText);
        if (done.length > 0) grounded = true;
        results = [...results, ...done];
        // Human-in-the-loop (§7 + §12): the pause is a versioned MCP tool
        // call — the turn blocks here until the human approves or denies.
        // There is no runtime-level pending map; the shared PendingAskStore
        // is the single implementation.
        const message = this.boundReplyText(`${plan.message} ${question}`);
        hist.push({ role: 'agent', text: message, ts: Date.now() });
        this.log(threadId, 'agent_message', { text: message });
        const toolNames = [...new Set(needsConfirm.filter(isTool).map((a) => a.tool))];
        const verdict = await this.requestApproval(
          threadId,
          toolNames.join(',') || 'write',
          `${message} (planned: ${needsConfirm
            .filter(isTool)
            .map((a) => `${a.tool} ${JSON.stringify(a.args).slice(0, 200)}`)
            .join('; ')})`,
        );
        if (verdict === 'timeout') {
          return { reply: this.hitlTimeoutReply(threadId), end: 'hitl-timeout', results };
        }
        this.log(threadId, 'confirmation', {
          text: verdict.note ?? (verdict.approved ? 'yes' : 'no'),
          summary: verdict.approved ? 'user confirmed the write' : 'user declined the write',
        });
        if (!verdict.approved) {
          const declined = "OK — I didn't make any changes.";
          hist.push({ role: 'agent', text: declined, ts: Date.now() });
          this.log(threadId, 'agent_message', { text: declined });
          return { reply: { threadId, message: declined, actionsTaken: [] }, end: 'declined', results };
        }
        // Approved: execute the confirming actions, then keep planning.
        const confirmed = await this.executeTools(threadId, needsConfirm.filter(isTool), hooks, stepScope, userText);
        if (confirmed.length > 0) grounded = true;
        results = [...results, ...confirmed];
        continue;
      }

      const ask = plan.actions.find((a): a is Extract<AgentAction, { type: 'ask' }> => a.type === 'ask');
      // Execute tool actions (asks pause after tools run).
      const toolActions = plan.actions.filter(isTool);
      const newResults = await this.executeTools(threadId, toolActions, hooks, stepScope, userText);
      if (toolActions.length > 0) grounded = true;
      results = [...results, ...newResults];

      if (ask) {
        // Grounding gate (FIX-R4): an ask before ANY tool use this turn
        // is suppressed — the planner must look before it asks.
        // (Observed live: the total-revenue question's first plan was an
        // ask about which column holds the revenue, parking the turn for
        // 240 s.) The ONLY exemption is a product-constructed intent
        // choice (ask.intentChoice — see the grounding note at the top
        // of runLoop): a planner-generated ask is gated with or without
        // options.
        if (!grounded && ask.intentChoice !== true) {
          this.log(threadId, 'question', {
            text: ask.question,
            summary: 'ask suppressed: planner has not used any tool yet this turn',
          });
          await this.consumeSuppressedAsk(ask.question, turnStartedAt);
          results = [
            ...results,
            {
              tool: 'agent.ask_question',
              ok: false,
              summary:
                'Ask suppressed: you have not used any tool yet this turn. Ground yourself first — ' +
                'read the sheet (header row plus a bounded data probe), list_sheets, or memory_load as appropriate — ' +
                'then compute the answer, or ask only if you are still genuinely blocked after looking.',
            },
          ];
          continue;
        }
        // Ask budget (FIX-R4): beyond maxAsksPerTurn the ask is NOT parked
        // with the user — each parked ask used to re-enter this loop with
        // a fresh iteration budget, so a weak planner could cascade five
        // questions (and a 240 s park) onto a question that needed none.
        // The planner instead gets a steering note as a tool result and
        // the SAME loop continues: determine the fact from the sheet or
        // answer with what it has.
        if (asksUsed >= this.maxAsksPerTurn) {
          this.log(threadId, 'question', {
            text: ask.question,
            summary: 'ask suppressed: per-turn ask budget exhausted',
          });
          await this.consumeSuppressedAsk(ask.question, turnStartedAt);
          results = [
            ...results,
            {
              tool: 'agent.ask_question',
              ok: false,
              summary:
                'Ask budget for this turn is exhausted — do NOT ask the user another question. ' +
                'Determine sheet names with list_sheets and column identity from the header row / used range by reading the sheet, ' +
                'then compute or answer with what you have.',
            },
          ];
          continue;
        }
        // Sheet-context grounding (W3): with the workbook's real sheet
        // names known, an ask that offers INVENTED sheet names as its
        // options, or that asks which sheet when the sheet is already
        // determined (the request names one, or there is only one),
        // never parks — that is the case-15/18 failure shape (fabricated
        // Sheet1/2/3 options; redundant which-sheet detours that burn
        // the turn). The planner gets the real names as a steering
        // result and must proceed from them.
        const sheetBlock = sheetAskProblem(ask, originText, sheets ?? undefined);
        if (sheetBlock) {
          this.log(threadId, 'question', {
            text: ask.question,
            summary: `ask suppressed: ${sheetBlock.reason}`,
          });
          await this.consumeSuppressedAsk(ask.question, turnStartedAt);
          results = [
            ...results,
            { tool: 'agent.ask_question', ok: false, summary: sheetBlock.correction },
          ];
          continue;
        }
        // Chart-placement guard (#153): when this turn already computed a
        // chart via analyze_data (a validated chartSpec is attached to
        // the reply by chartAttachment), a placement ask — insert into a
        // sheet vs keep in chat — must never park: analyze_data IS the
        // chat-only chart, so there is no placement decision left, and
        // parking it drops the computed chart (hitlTimeoutReply carries
        // no chart). The planner gets a steering result and must finish
        // with a done plan; the chart rides that reply itself.
        if (this.chartAttachment(results) && isChartPlacementAsk(ask.question, ask.options)) {
          this.log(threadId, 'question', {
            text: ask.question,
            summary: 'ask suppressed: chart already computed via analyze_data; placement ask must not park',
          });
          await this.consumeSuppressedAsk(ask.question, turnStartedAt);
          results = [
            ...results,
            {
              tool: 'agent.ask_question',
              ok: false,
              summary:
                'Ask suppressed: a chart is already computed for this turn via analyze_data and it renders in the chat reply. ' +
                'Do NOT ask about sheet placement — finish with a done plan describing the chart; the chart rides the reply itself. ' +
                'Inserting it into a sheet would be a separate create_chart request the user has not made.',
            },
          ];
          continue;
        }
        this.log(threadId, 'question', { text: ask.question, summary: 'agent asked user' });
        const message = this.boundReplyText(
          plan.message ? `${plan.message}\n\n${ask.question}` : ask.question,
        );
        hist.push({ role: 'agent', text: message, ts: Date.now() });
        this.log(threadId, 'agent_message', { text: message });
        // Human-in-the-loop (§12): the pause is a versioned MCP tool call —
        // this turn blocks here until the human answers. The answer becomes
        // the new user text for re-planning.
        const answered = await this.askUser(threadId, ask.question, ask.options);
        if (answered === 'timeout') {
          return { reply: this.hitlTimeoutReply(threadId), end: 'hitl-timeout', results };
        }
        hist.push({ role: 'user', text: answered, ts: Date.now() });
        // Planner-fix M2 (2026-10-22, merged with FIX-R4): the answered
        // ask resumes with the ACCUMULATED tool results, not an empty
        // slate — restarting from [] made the planner re-fetch (and
        // often re-ask) from scratch, burning the step budget. The
        // FIX-R4 ask count and grounding flag ride along: it is the
        // same turn. So does the agent-failures-fix turn context
        // (origin text, turn start, audit offset, aggregate-correction
        // count, sheet names).
        return this.runLoopDetailed(
          threadId,
          answered,
          results,
          asksUsed + 1,
          grounded,
          originText,
          turnStartedAt,
          auditStart,
          aggregateCorrections,
          sheets,
          hooks,
          stepScope,
        );
      }

      // D2: a plan that carries tool actions NEVER ends the turn — the
      // tools have just executed above and the planner must get another
      // iteration with their results to compose the real answer. A
      // {"type":"done"} riding along in the same plan is ignored (LLM
      // planners were instructed to append one to every plan, which used
      // to end every turn on the first plan's status message). The turn
      // ends only when a plan has NO tool actions: a done-only plan (the
      // heuristic backend's iteration-2 shape — its composed message is
      // the reply, exactly as before) or an empty plan.
      if (toolActions.length === 0) {
        // Aggregate integrity (W2): on an aggregate-shaped request, a
        // final answer that cites a partial-window sum as the total
        // (the proven case-1/7 failure signature) must not end the
        // turn. The planner gets ONE steering correction and must
        // produce the aggregate through the engine; a second attempt
        // stands as given (no loop).
        if (aggregateCorrections < 1) {
          const problem = aggregateIntegrityProblem(originText, plan.message, results);
          if (problem) {
            this.log(threadId, 'guardrail', {
              text: plan.message,
              summary: `aggregate integrity: ${problem.reason}`,
            });
            results = [
              ...results,
              { tool: 'agent.aggregate_check', ok: false, summary: problem.correction },
            ];
            aggregateCorrections++;
            continue;
          }
        }
        const message = this.boundReplyText(plan.message || 'Done.');
        hist.push({ role: 'agent', text: message, ts: Date.now() });
        this.log(threadId, 'agent_message', { text: message });
        // #141: a turn that built an app carries its spec so the
        // panel can store it (Apps tab) and render it on click.
        const artifact = this.appAttachment(results);
        // #138: same for a turn that built a diagram.
        const diagram = this.diagramAttachment(results);
        return {
          reply: {
            threadId,
            message,
            actionsTaken: [],
            chart: this.chartAttachment(results),
            ...(artifact ? { artifact } : {}),
            ...(diagram ? { diagram } : {}),
          },
          end: 'answered',
          results,
        };
      }
      // Tool actions ran (any done in this plan is disregarded): loop on
      // to the next planner iteration with the fresh results.
    }

    // W1 honest progress: running out of steps mid-batch reports what
    // already landed instead of reading as a zero-progress failure.
    const landedAtExhaustion = this.landedWriteCells(auditStart);
    const message =
      landedAtExhaustion > 0
        ? `I ran out of steps for that request, but ${landedAtExhaustion} cell(s) were already written — those changes are in the sheet. Send a follow-up and I will continue from there.`
        : 'I ran out of steps for that request. Could you break it into smaller parts?';
    hist.push({ role: 'agent', text: message, ts: Date.now() });
    this.log(threadId, 'agent_message', { text: message });
    // #141: same as the answered path — an app built before exhaustion
    // still reaches the panel instead of being silently lost.
    const exhaustedArtifact = this.appAttachment(results);
    // #138: same for a diagram.
    const exhaustedDiagram = this.diagramAttachment(results);
    return {
      reply: {
        threadId,
        message,
        actionsTaken: [],
        chart: this.chartAttachment(results),
        ...(exhaustedArtifact ? { artifact: exhaustedArtifact } : {}),
        ...(exhaustedDiagram ? { diagram: exhaustedDiagram } : {}),
      },
      end: 'exhausted',
      results,
    };
  }

  /**
   * Handoff from the data-analysis pipeline to the chat UI: the latest
   * successful analyze_data result carries a validated chartSpec; convert
   * it to a Chart.js config for ChartCanvas. The artifact lane
   * (chartModel.ts) is untouched — this is the analysis component's own
   * spec + render request.
   */
  private chartAttachment(results: ToolResultRecord[]):
    | { title: string; config: ChartConfiguration }
    | undefined {
    const hit = [...results].reverse().find((r) => r.tool === 'analyze_data' && r.ok);
    if (!hit) return undefined;
    const data = hit.data as { chartSpec?: unknown } | undefined;
    const checked = validateAnalysisChartSpec(data?.chartSpec);
    if (!checked.ok) return undefined;
    return {
      title: checked.spec.title ?? 'Analysis',
      config: toChartConfiguration(checked.spec),
    };
  }

  /**
   * #141: the app a turn built, for the reply. Mirrors
   * chartAttachment: the latest successful generate_app result whose
   * generation actually routed to an app carries its full spec, so
   * the panel can store it (Apps tab) and render it on click.
   */
  private appAttachment(results: ToolResultRecord[]): ArtifactSpec | undefined {
    const hit = [...results].reverse().find((r) => r.tool === 'generate_app' && r.ok);
    const data = hit?.data as GenerateArtifactResult | undefined;
    return data?.routed === 'app' ? data.spec : undefined;
  }

  /**
   * #138: the diagram a turn built, for the reply. Mirrors
   * appAttachment: the latest successful create_diagram result
   * carries its spec, so the panel can render it.
   */
  private diagramAttachment(results: ToolResultRecord[]): DerivedDiagramSpec | undefined {
    const hit = [...results].reverse().find((r) => r.tool === 'create_diagram' && r.ok);
    const data = hit?.data as DerivedDiagramSpec | undefined;
    return data && typeof data.layout === 'string' && Array.isArray(data.items) ? data : undefined;
  }

  /** §7 gate: bulk writes need explicit confirmation. */
  private requiresConfirmation(a: ToolCallAction): boolean {
    if (a.tool !== 'write_cells' && a.tool !== 'set_formulas') return false;
    return cellCount(a) > this.confirmThreshold;
  }

  /**
   * W3: the open workbook's real sheet names, fetched through the
   * list_sheets MCP tool (§2 — no private path to the engine). Returns
   * undefined when the lookup fails or no workbook is bound: sheet
   * context then stays off and behavior is exactly as before.
   */
  private async fetchSheetNames(): Promise<string[] | undefined> {
    try {
      const data = (await this.callTool('list_sheets', {})) as { sheets?: unknown };
      if (Array.isArray(data?.sheets)) {
        return data.sheets.filter(
          (s): s is string => typeof s === 'string' && s.length > 0,
        );
      }
    } catch {
      /* no workbook bound / older MCP server: context stays off */
    }
    return undefined;
  }

  /**
   * W4 consumption: when an ask is suppressed at a gate, any UNANSWERED
   * pending entry with the same question that PREDATES this turn is a
   * zombie twin — the live turn just decided this question must not be
   * asked, so the twin (left by an earlier segment or a since-swapped
   * runtime) must not stay answerable: answering it used to start a
   * turn on a different runtime. It is withdrawn through the versioned
   * agent.withdraw_pending tool (§12). Asks created during this turn (a
   * concurrently parked twin with a live waiter) are left alone.
   * Best-effort: hygiene never fails the turn.
   */
  private async consumeSuppressedAsk(question: string, turnStartedAt: number): Promise<void> {
    try {
      const asks = await this.listPendingAsks();
      for (const a of asks) {
        if (a.answered || a.question !== question) continue;
        if (a.createdAt >= turnStartedAt) continue;
        await this.callTool('agent.withdraw_pending', { askId: a.id });
      }
    } catch {
      /* hygiene only — never fail the turn on it */
    }
  }

  /** W1: cells written by successful write_cells/set_formulas calls
   * since the given audit offset (honest partial-progress reporting). */
  private landedWriteCells(auditStart: number): number {
    let n = 0;
    for (const e of this.audit.slice(auditStart)) {
      if (e.kind !== 'tool_call' || e.ok !== true) continue;
      if (e.tool === 'write_cells' || e.tool === 'set_formulas') {
        n += cellCount({ type: 'tool', tool: e.tool, args: e.args ?? {} });
      }
    }
    return n;
  }

  /**
   * §7 gate targets (agent-failures-fix W6 extends the count rule): the
   * actions that must be confirmed before executing. Two triggers:
   * (1) the bulk count rule (unchanged); (2) a HEADER OVERWRITE — a
   * write whose target sits in the sheet's detected header row (row 0,
   * per the product's header contract) and would replace a non-empty
   * text header with a different value. Case 2's planner wrote 15000
   * onto the "Revenue" header cell and the write tool executed it
   * silently; the model limit is documented, but the silence is a
   * product gap. The header trigger names the exact target in the
   * approval (headerNotes), so the human sees what is about to happen.
   * The probe reads CURRENT values through read_cells; any probe
   * failure falls back to the count rule alone (audited, never blocks).
   */
  private async confirmationTargets(
    threadId: string,
    actions: ToolCallAction[],
  ): Promise<{ confirm: ToolCallAction[]; headerNotes: string[] }> {
    const confirm = actions.filter((a) => this.requiresConfirmation(a));
    const confirmSet = new Set<ToolCallAction>(confirm);
    const headerNotes: string[] = [];
    const writeActions = actions.filter(
      (a) => !confirmSet.has(a) && (a.tool === 'write_cells' || a.tool === 'set_formulas'),
    );
    if (writeActions.length === 0) return { confirm, headerNotes };

    interface Target {
      action: ToolCallAction;
      sheet: string;
      row: number;
      col: number;
      value: unknown;
      isFormula: boolean;
    }
    const targets: Target[] = [];
    for (const a of writeActions) {
      const entries = (a.tool === 'write_cells' ? a.args.cells : a.args.formulas) as
        | Record<string, unknown>[]
        | undefined;
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        if (typeof e?.sheet !== 'string' || typeof e?.row !== 'number' || typeof e?.col !== 'number') {
          continue;
        }
        targets.push({
          action: a,
          sheet: e.sheet,
          row: e.row,
          col: e.col,
          value: a.tool === 'write_cells' ? (e.value ?? null) : (e.formula ?? null),
          isFormula: a.tool === 'set_formulas',
        });
      }
    }
    const headerTargets = targets.filter((t) => t.row === 0);
    if (headerTargets.length === 0 || targets.length > 64) return { confirm, headerNotes };

    try {
      const bySheet = new Map<string, Target[]>();
      for (const t of headerTargets) {
        const arr = bySheet.get(t.sheet) ?? [];
        arr.push(t);
        bySheet.set(t.sheet, arr);
      }
      for (const [sheet, sheetTargets] of bySheet) {
        const maxCol = Math.min(63, Math.max(...sheetTargets.map((t) => t.col)));
        const top = (await this.callTool('read_cells', {
          sheet,
          startRow: 0,
          startCol: 0,
          endRow: 2,
          endCol: maxCol,
        })) as { cells?: unknown };
        const grid = (Array.isArray(top?.cells) ? top.cells : []) as CellInput[][];
        if (!detectHeaderRow(grid)) continue;
        for (const t of sheetTargets) {
          const current = grid[0]?.[t.col];
          if (typeof current !== 'string' || current.trim() === '') continue;
          // Rewriting the identical text is not an overwrite; any other
          // value (number, boolean, null, a different string, a formula)
          // destroys the header label.
          if (!t.isFormula && t.value === current) continue;
          if (!confirmSet.has(t.action)) {
            confirmSet.add(t.action);
            confirm.push(t.action);
          }
          headerNotes.push(
            `Writing ${t.isFormula ? `the formula ${JSON.stringify(String(t.value))}` : JSON.stringify(t.value)} over the header ${JSON.stringify(current)} at ${sheet}!${a1Ref(t.row, t.col)}`,
          );
        }
      }
    } catch (e) {
      this.log(threadId, 'tool_call', {
        tool: 'agent.header_probe',
        ok: false,
        summary: `header-overwrite probe failed (count rule only for this plan): ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    return { confirm, headerNotes };
  }

  /**
   * #141: native generate_app execution. The model already decided this
   * is an app request, so the template is forced from the prompt —
   * generateAndSaveArtifact then skips its routePrompt re-route
   * entirely (gateway-mode chat must never consult routePrompt, and
   * re-routing could divert an app request to analysis). Sheet-less
   * requests resolve via createAppArtifact's #135 first-sheet rule.
   * Returns the tool-result triple executeTools records.
   */
  private async executeGenerateApp(
    threadId: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; summary: string; data: unknown }> {
    const prompt = args.prompt;
    const sheet = args.sheet;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return { ok: false, summary: 'generate_app failed: prompt is required', data: undefined };
    }
    if (sheet !== undefined && (typeof sheet !== 'string' || sheet.length === 0)) {
      return { ok: false, summary: 'generate_app failed: sheet must be a non-empty string', data: undefined };
    }
    if (!this.artifactStore) {
      return {
        ok: false,
        summary: 'generate_app failed: app generation is not configured on this runtime (no artifact store)',
        data: undefined,
      };
    }
    try {
      const result = await this.createAppArtifact(threadId, prompt, {
        store: this.artifactStore,
        ...(typeof sheet === 'string' ? { sheet } : {}),
        ...(this.appGenerator ? { generator: this.appGenerator } : {}),
        template: detectTemplate(prompt),
      });
      if (result.routed !== 'app') {
        return {
          ok: false,
          summary: `generate_app routed to ${result.routed}: ${result.reason}`,
          data: result,
        };
      }
      return {
        ok: true,
        summary: `generate_app ok: built "${result.spec.name}"`,
        data: result,
      };
    } catch (e) {
      return {
        ok: false,
        summary: truncateText(`generate_app failed: ${e instanceof Error ? e.message : String(e)}`),
        data: undefined,
      };
    }
  }

  /**
   * #138: native create_diagram execution. The MODEL generates the
   * spec (layout + node labels + title) — the local lane's
   * deterministic deriver is not consulted here, per the owner's
   * ruling that diagram generation goes through the LLM. The runtime
   * only validates: layout in the SmartArt enum, 2–6 non-empty
   * labels, optional title. No sheet access, no persistence: the
   * diagram rides the reply and the panel renders it (like an
   * analysis chart — ephemeral, not an in-sheet picture; in-sheet
   * placement stays the local lane's #126 behavior).
   */
  private executeCreateDiagram(args: Record<string, unknown>): {
    ok: boolean;
    summary: string;
    data: unknown;
  } {
    const LAYOUTS = ['list', 'process', 'cycle', 'hierarchy', 'relationship', 'pyramid', 'matrix'];
    const layout = args.layout;
    const items = args.items;
    const title = args.title;
    if (typeof layout !== 'string' || !LAYOUTS.includes(layout)) {
      return {
        ok: false,
        summary: `create_diagram failed: layout must be one of ${LAYOUTS.join(', ')}`,
        data: undefined,
      };
    }
    if (
      !Array.isArray(items) ||
      items.length < 2 ||
      items.length > 6 ||
      !items.every((x): x is string => typeof x === 'string' && x.trim().length > 0)
    ) {
      return {
        ok: false,
        summary: 'create_diagram failed: items must be 2–6 non-empty labels',
        data: undefined,
      };
    }
    if (title !== undefined && typeof title !== 'string') {
      return { ok: false, summary: 'create_diagram failed: title must be a string', data: undefined };
    }
    const spec: DerivedDiagramSpec = {
      layout: layout as DerivedDiagramSpec['layout'],
      items: (items as string[]).map((x) => x.trim()),
      title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'Diagram',
    };
    return { ok: true, summary: `create_diagram ok: "${spec.title}" (${spec.layout})`, data: spec };
  }

  private async executeTools(
    threadId: string,
    actions: ToolCallAction[],
    hooks?: AgentTurnHooks,
    stepScope?: string,
    loopUserText?: string,
  ): Promise<ToolResultRecord[]> {
    const client = await this.ensureConnected();
    const out: ToolResultRecord[] = [];
    for (const a of actions) {
      if (hooks?.isCancelled?.()) throw new AgentTurnCancelled();
      hooks?.onEvent?.({ type: 'tool', phase: 'start', tool: a.tool });
      // Round-2 overshoot guard: inside a workflow step, a native
      // chart may only be created by a step that is itself about
      // native chart creation. A discovery step's loop calling
      // create_chart (leg B2: describe_sheet + create_chart inside
      // 'Discover Income sheet schema') is refused here, before any
      // MCP call, so no duplicate chart can land — the loop sees a
      // failed tool result with the correction and stays in scope.
      // Plain-loop turns pass no stepScope, so the guard is inactive
      // there; generate_app/create_diagram below are unaffected.
      if (
        a.tool === 'create_chart' &&
        stepScope !== undefined &&
        !stepAllowsNativeChart(stepScope)
      ) {
        const summary =
          'create_chart refused: the current step does not name native chart creation ' +
          '(a step that names analyze_data shows a chat chart; a step that builds an app ' +
          'uses generate_app for its chart)';
        this.log(threadId, 'tool_call', { tool: a.tool, args: a.args, ok: false, summary });
        hooks?.onEvent?.({ type: 'tool', phase: 'end', tool: a.tool, ok: false, summary });
        out.push({ tool: a.tool, ok: false, summary });
        continue;
      }
      // Round-4 plain-loop guard: a plain-loop turn whose user text is
      // a chat-chart request (isChatChartRequest: chart language, no
      // sheet-placement wording, no other-work keywords) must never
      // place a native chart — the SYSTEM_PROMPT chart rule alone did
      // not move the model (combined proof leg A: exact R3 prompt
      // still picked create_chart with a CORRECT native chart, so this
      // is purely a routing choice). Refuse before any MCP call with
      // the correction (call analyze_data); the loop sees a failed
      // tool result and steers to the panel chart. Workflow steps pass
      // stepScope, so this guard (stepScope === undefined) never fires
      // there; placement-wording and mixed-work turns classify false
      // and are unaffected (fail-open, like the plan gate).
      if (
        a.tool === 'create_chart' &&
        stepScope === undefined &&
        loopUserText !== undefined &&
        isChatChartRequest(loopUserText)
      ) {
        const summary =
          'create_chart refused: this request asks for a chart with no sheet-placement wording, ' +
          'so it is a chat chart — call analyze_data to show it in the chat reply instead of ' +
          'placing a native chart in the sheet';
        this.log(threadId, 'tool_call', { tool: a.tool, args: a.args, ok: false, summary });
        hooks?.onEvent?.({ type: 'tool', phase: 'end', tool: a.tool, ok: false, summary });
        out.push({ tool: a.tool, ok: false, summary });
        continue;
      }
      // #141/#138: generate_app and create_diagram are NATIVE loop
      // tools — their execution lives in the service (app generator +
      // store; diagram spec validation), not the MCP server (which
      // has no such tools), so they never cross the MCP client.
      // Their result data carries what the reply attaches (app spec /
      // diagram spec).
      if (a.tool === 'generate_app' || a.tool === 'create_diagram') {
        const res =
          a.tool === 'generate_app'
            ? await this.executeGenerateApp(threadId, a.args)
            : this.executeCreateDiagram(a.args);
        this.log(threadId, 'tool_call', {
          tool: a.tool,
          args: a.args,
          ok: res.ok,
          summary: res.summary,
        });
        hooks?.onEvent?.({
          type: 'tool',
          phase: 'end',
          tool: a.tool,
          ok: res.ok,
          summary: res.summary,
        });
        out.push({ tool: a.tool, ok: res.ok, summary: res.summary, data: res.data });
        continue;
      }
      const args = this.stampUser(a.tool, a.args);
      let ok = true;
      let summary: string;
      let data: unknown;
      try {
        // HITL tools block until the human answers: give them the
        // human-scale client timeout, not the SDK's 60s default.
        const res = await client.callTool(
          { name: a.tool, arguments: args },
          undefined,
          a.tool.startsWith('agent.') ? { timeout: this.hitlClientTimeoutMs } : undefined,
        );
        const parsed = parseToolResult(res);
        ok = parsed.ok;
        data = parsed.data;
        // D1b: the summary is what the planner sees next iteration (and
        // what the audit trail keeps) — it must carry the REAL error
        // text, never "failed: undefined", and stay bounded.
        summary = parsed.ok
          ? `${a.tool} ok`
          : truncateText(`${a.tool} failed: ${parsed.error ?? 'unknown error'}`);
      } catch (e) {
        ok = false;
        summary = truncateText(`${a.tool} threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.log(threadId, 'tool_call', { tool: a.tool, args, ok, summary });
      hooks?.onEvent?.({ type: 'tool', phase: 'end', tool: a.tool, ok, summary });
      if (a.tool === 'memory_save' || a.tool === 'memory_load' || a.tool === 'memory_update') {
        this.log(threadId, 'memory', { tool: a.tool, ok, summary });
      }
      out.push({ tool: a.tool, ok, summary, data });
    }
    return out;
  }

  /**
   * Act as the user (§3): stamp the memory userId so agent memory calls
   * are scoped to the invoking user, never a shared namespace; stamp the
   * principal on human-in-the-loop tool calls so asks are owned by the
   * invoking user (principal-scoped answering); and neutralize any
   * foreign `principal` argument on ANY tool call to the runtime's own
   * identity (F-10).
   */
  private stampUser(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    // F-10: the runtime acts as its user (ai-agent.md §3) — a
    // planner-emitted `principal` argument naming someone else is
    // neutralized to the runtime's own identity before the call, so a
    // model-generated argument can never widen the agent's authority
    // (bound MCP servers also refuse mismatches on their side).
    const scoped =
      args.principal !== undefined && args.principal !== this.principal
        ? { ...args, principal: this.principal }
        : args;
    if (tool === 'memory_save' || tool === 'memory_load' || tool === 'memory_update') {
      return { ...scoped, userId: this.userId };
    }
    if (tool.startsWith('agent.')) {
      return { ...scoped, principal: this.principal };
    }
    return scoped;
  }
}

function isTool(a: AgentAction): a is ToolCallAction {
  return a.type === 'tool';
}

/** A1-style cell reference for a 0-based row/col (header-guard notes). */
function a1Ref(row: number, col: number): string {
  let c = col + 1;
  let letters = '';
  while (c > 0) {
    const m = (c - 1) % 26;
    letters = String.fromCharCode(65 + m) + letters;
    c = Math.floor((c - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * W3 sheet-context ask validation. With the workbook's real sheet names
 * known, decide whether a planner ask must not park: (a) it asks WHICH
 * sheet while offering options that are not real sheet names (case 15's
 * fabricated Sheet1/2/3); (b) it asks which sheet although the answer
 * is already determined — the workbook has exactly one sheet, or the
 * user's request names the sheet (case 18's redundant detour). Returns
 * the block (reason + the steering correction the planner receives) or
 * null when the ask may park. Only which-sheet-shaped questions are
 * judged: other option asks (chart placement, intent choices) are not
 * sheet choices and pass untouched.
 */
/**
 * #153 chart-placement ask: the planner asks whether to insert an
 * already-computed chart into a sheet or keep it in chat. Judged only
 * on the ask's own wording: it must mention a chart AND placement
 * language (insert/place/put/add into a sheet, a sheet-vs-chat choice
 * in its options, or 'keep it here'). Which-sheet questions, intent
 * choices, and generic questions are not placement asks and pass
 * untouched. The caller additionally requires a computed chart this
 * turn (chartAttachment(results) defined) before suppressing — this
 * predicate alone never blocks an ask.
 */
export function isChartPlacementAsk(question: string, options?: string[]): boolean {
  const q = question ?? '';
  if (!/chart/i.test(q)) return false;
  if (/\b(insert|place|put|add)\b/i.test(q) && /\bsheet\b/i.test(q)) return true;
  if (/into the ['"]?\w+['"]? sheet/i.test(q)) return true;
  if (/keep (it|this) here/i.test(q)) return true;
  if (options && options.length > 0) {
    const joined = options.join(' ');
    if (/\b(insert|place|put|add)\b/i.test(joined) && /\bsheet\b|dashboard\b/i.test(joined)) return true;
    if (/keep (it|this) here|keep in chat/i.test(joined)) return true;
  }
  return false;
}

/**
 * Round-3 mechanical Gate 1(a) classifier: a PURE no-placement chart
 * request — the shape the planner prompt's Gate 1(a) routes to exactly
 * one analyze_data step with no discovery step. The planner ignored
 * that gate live twice (round-1 CHART ROUTES block, round-2 flowchart
 * gates), so runTurn enforces it mechanically: a violating multi-step
 * plan for such a request is discarded (fail-open to the plain loop,
 * whose SYSTEM_PROMPT chart rule routes the same shape to
 * analyze_data) instead of executing as a workflow.
 *
 * Placement wording mirrors the prompts' own cues ("chart in/on the
 * sheet", "add a chart to the sheet", "insert chart", "a native
 * chart"): naming a sheet as the DATA SOURCE ("chart of revenue by
 * year from the Income sheet") is NOT placement — none of these
 * patterns match a "from" source phrase, and "add a chart" without a
 * "to" destination is not placement either. Chart-plus-other-work
 * (totals, writes, an app — Gate 1(c)) is NOT pure: the planner keeps
 * those plans, and only the chart step's own wording routes it.
 */
export function isChatChartRequest(text: string): boolean {
  const t = (text ?? '').toLowerCase();
  if (!/\b(charts?|graphs?|plots?|visualis\w*|visualiz\w*)\b/.test(t)) return false;
  const placed =
    /\bcharts?\b[^.?!]{0,40}\b(?:in|into|on|onto)\b[^.?!]{0,20}\bsheets?\b/.test(t) ||
    /\badd\b[^.?!]{0,30}\bcharts?\b[^.?!]{0,20}\bto\b/.test(t) ||
    /\binsert\b[^.?!]{0,30}\bcharts?\b/.test(t) ||
    /\b(?:place|put)\b[^.?!]{0,30}\bcharts?\b/.test(t) ||
    /\bnative\b[^.?!]{0,10}\bcharts?\b/.test(t);
  if (placed) return false;
  if (
    /\b(apps?|dashboards?|totals?|sums?|averages?|means?|write|writes|writing|updates?|updating|edits?|editing|formulas?|pivots?|diagrams?|reports?)\b/.test(
      t,
    )
  )
    return false;
  return true;
}

export function sheetAskProblem(
  ask: { question: string; options?: string[] },
  originText: string,
  sheets: string[] | undefined,
): { reason: string; correction: string } | null {
  if (!sheets || sheets.length === 0) return null;
  const q = ask.question ?? '';
  const asksWhich =
    /which sheet|what sheet|sheet (should|shall|do|to) (use|read|write|open)|sheet contains|sheet has|sheet holds/i.test(
      q,
    );
  if (!asksWhich) return null;
  const lower = sheets.map((s) => s.toLowerCase());
  const listText = sheets.join(', ');
  if (ask.options && ask.options.length > 0) {
    const tainted = ask.options.filter((o) => !lower.includes(o.trim().toLowerCase()));
    if (tainted.length > 0) {
      return {
        reason: `which-sheet ask offered sheet names that do not exist (${tainted.join(', ')})`,
        correction:
          `Ask suppressed: the options you offered (${ask.options.join(', ')}) are not sheets in this workbook. ` +
          `The workbook's sheets are exactly: ${listText}. Never invent sheet names — proceed with the sheet the data or the request indicates, ` +
          `or ask again offering only real sheet names if a choice is genuinely needed.`,
      };
    }
  }
  if (sheets.length === 1) {
    return {
      reason: 'which-sheet ask on a single-sheet workbook',
      correction: `Ask suppressed: this workbook has exactly one sheet — ${listText}. There is nothing to choose; proceed with that sheet.`,
    };
  }
  const named = sheets.find((s) =>
    new RegExp(`\\b${escapeRegExp(s)}\\b`, 'i').test(originText),
  );
  if (named) {
    return {
      reason: `which-sheet ask although the request names the sheet ${named}`,
      correction: `Ask suppressed: the user's request already names the sheet ${JSON.stringify(named)}. Proceed with that sheet — read it and answer; do not ask which sheet.`,
    };
  }
  return null;
}

const AGGREGATE_REQUEST =
  /\b(total|sum|average|mean|count|how much|how many|overall|combined|altogether)\b/i;

function numbersInText(text: string): number[] {
  const out: number[] = [];
  const re = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function collectToolNumbers(data: unknown, into: number[]): void {
  if (typeof data === 'number' && Number.isFinite(data)) {
    into.push(data);
    return;
  }
  if (Array.isArray(data)) {
    for (const v of data) collectToolNumbers(v, into);
    return;
  }
  if (data !== null && typeof data === 'object') {
    for (const v of Object.values(data as Record<string, unknown>)) {
      collectToolNumbers(v, into);
    }
  }
}

const numEq = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 0.01 + Math.abs(b) * 1e-9;

/**
 * W2 aggregate integrity: detect the proven failure signature — on an
 * aggregate-shaped request, the final message cites, as its aggregate,
 * the sum of a PROPER PREFIX of a column the planner read this turn (a
 * partial-window sum: case 1's 35,300 = the first three revenue values,
 * reproduced 3/3). The cited number must NOT appear anywhere in the
 * turn's tool-result data (an engine-computed value is legitimate) and
 * the read column's full sum must NOT be cited alongside it (a message
 * presenting both a subtotal and the total is not this failure). Pure
 * and exported for unit tests; the runtime applies it once per turn.
 */
export function aggregateIntegrityProblem(
  originText: string,
  message: string,
  results: ToolResultRecord[],
): { reason: string; correction: string } | null {
  if (!AGGREGATE_REQUEST.test(originText)) return null;
  const cited = numbersInText(message).filter((v) => Math.abs(v) >= 1);
  if (cited.length === 0) return null;
  const toolNumbers: number[] = [];
  for (const r of results) {
    if (r.data !== undefined) collectToolNumbers(r.data, toolNumbers);
  }
  const inTools = (v: number) => toolNumbers.some((t) => numEq(t, v));
  const inMessage = (v: number) => cited.some((c) => numEq(c, v));
  for (const r of results) {
    if (r.tool !== 'read_cells' || !r.ok) continue;
    const cells = (r.data as { cells?: unknown } | undefined)?.cells;
    if (!Array.isArray(cells)) continue;
    const width = Math.max(0, ...cells.map((row) => (Array.isArray(row) ? row.length : 0)));
    for (let col = 0; col < width; col++) {
      const values: number[] = [];
      for (const row of cells) {
        const v = Array.isArray(row) ? row[col] : undefined;
        if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
      }
      if (values.length < 3) continue;
      const full = values.reduce((a, b) => a + b, 0);
      let prefix = 0;
      for (let k = 0; k < values.length - 1; k++) {
        prefix += values[k]!;
        for (const c of cited) {
          if (numEq(c, prefix) && !numEq(c, full) && !inTools(c) && !inMessage(full)) {
            return {
              reason:
                `final answer cites ${c}, the sum of only the first ${k + 1} of ${values.length} values ` +
                `in a read column (a partial-window sum), as the aggregate`,
              correction:
                `Aggregate integrity check: ${c} is the sum of only the first ${k + 1} values of a column you read — ` +
                `a partial sum, not the total. Do NOT present it as the total. Compute the aggregate with a scratch ` +
                `SUM/SUMIF formula over the FULL data range and read the scratch cell back (or use analyze_data over ` +
                `the full range), then answer with the engine-computed number.`,
            };
          }
        }
      }
    }
  }
  return null;
}

function cellCount(a: ToolCallAction): number {
  const cells = (a.args.cells as unknown[] | undefined)?.length;
  if (typeof cells === 'number') return cells;
  const formulas = (a.args.formulas as unknown[] | undefined)?.length;
  if (typeof formulas === 'number') return formulas;
  return 0;
}

/** Bound on tool-result summaries / error text kept in audit + planner input. */
const MAX_SUMMARY_CHARS = 800;

// ============ workflow layer helpers (agent-workflows.md §2) ============

/** Attempts per step position: plain, steering retry, then (after a
 *  re-plan) one run of the replacement step — then provably stuck. */
const MAX_STEP_ATTEMPTS = 3;

/** Job-plan classification budget: a slow job planner must never stall
 *  a turn; past this the turn takes the plain path (fail-open). */
const PLAN_JOB_TIMEOUT_MS = 25_000;

/**
 * Operational safety valve (§2.6), per DRIVE (one turn's worth of
 * driving), never per job: a drive that spends this many step segments
 * stops as resumable-stuck with a plain-language notice instead of
 * running away inside one HTTP request. The job itself has no ceiling —
 * the next message resumes it from the checkpoint.
 */
const MAX_SEGMENTS_PER_DRIVE = 60;

/** Tools whose success is a sheet/data EFFECT for verification (§2.3). */
const WRITE_EFFECT_TOOLS = new Set([
  'write_cells',
  'set_formulas',
  'create_chart',
  'create_pivot',
  'refresh_pivot',
  'open_data_source',
  'refresh_data_source',
  'rerun_analysis',
  'execute_code',
  'appbuilder_create_spec',
  'appbuilder_update_spec',
  'appbuilder_delete_spec',
  'report_create_spec',
  'report_update_spec',
  'report_delete_spec',
  'memory_save',
  'memory_update',
  'rtd_publish',
]);

/** Cancel intent for an open workflow: a leading cancel word, or a
 *  cancel verb aimed at the job/that/it. Deliberately narrow — anything
 *  else is steering or a new ask, judged by the supersede rule. */
function isCancelText(text: string): boolean {
  const t = text.trim();
  if (/^(cancel|stop|abort|never\s*mind|forget\s+it|drop\s+it|scrap\s+it)\b/i.test(t)) return true;
  return /\b(cancel|stop|abort)\b[^.!?]*\b(workflow|job|task|that|this|it)\b/i.test(t);
}

const STAGE_BATCH =
  /\b(for every|for each|every (data )?row|each (data )?row|per[- ]row|all rows|every file|each file|every sheet|each sheet)\b/i;
const STAGE_WRITE =
  /\b(write|fill|put|add|insert|create|update|set|delete|split|merge|consolidate|normalize|restructure)\b/i;
const STAGE_REPORT = /\b(tell|report|show|state|identify|explain|describe|list|summarize)\b/i;

/** Appended to the ASK (plan call only — never the chat text) when a
 *  stage-shaped request is re-planned after a one-step/null first plan. */
const STAGE_SHAPED_NUDGE =
  '\n\n[Planning note: this request has several stages — a per-row/per-file batch, or a compute-then-write-then-report chain. Decompose it into its stages, one step per stage in dependency order, instead of returning a single step.]';

/**
 * Stage-shaped ask (runTurn's decomposition nudge): the request's own
 * text marks it as staged work — a batch directive ("for every data
 * row", "for each file"), or a chain of >= 3 segments (split on
 * sentence/clause boundaries) that both writes and reports. Tuned
 * against the §4.0 case set: every simple ask there (questions, a
 * single-cell set, one TOTAL row, one analyze+chart) fails this test,
 * so the nudge can never reroute them; the W1 share-column ask matches
 * on the batch directive.
 */
function isStageShapedAsk(text: string): boolean {
  if (STAGE_BATCH.test(text)) return true;
  if (!STAGE_WRITE.test(text) || !STAGE_REPORT.test(text)) return false;
  const segments = text.split(/[.!?;]+/).filter((s) => s.trim().length > 0).length;
  return segments >= 3;
}

function isBareContinuation(text: string): boolean {
  return /^\s*(continue|go on|resume|proceed|keep going|carry on|yes|ok|okay|sure|go ahead|do it)\W*$/i.test(
    text,
  );
}

const CONTENT_STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'then', 'than', 'into',
  'your', 'yours', 'please', 'sheet', 'sheets', 'data', 'file', 'files', 'using', 'used',
  'show', 'give', 'tell', 'want', 'need', 'also', 'just', 'like', 'over', 'under', 'each',
  'every', 'them', 'they', 'will', 'would', 'should', 'could', 'there', 'here', 'have',
  'been', 'were', 'was', 'are', 'for', 'and', 'the', 'you', 'can', 'all', 'any', 'new',
]);

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !CONTENT_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** "the titles of the completed steps", for stop reports. */
function doneStepList(wf: AgentWorkflow): string {
  const done = wf.steps.filter((s) => s.status === 'done').map((s) => `"${s.title}"`);
  return done.length > 0 ? done.join(', ') : 'none yet';
}

/** The reply's workflow summary (AgentReply.workflow). */
function workflowReplySummary(wf: AgentWorkflow): NonNullable<AgentReply['workflow']> {
  return {
    id: wf.id,
    status: wf.status,
    stepsPlanned: wf.steps.length,
    stepsCompleted: wf.steps.filter((s) => s.status === 'done').length,
    stepsRetried: wf.steps.reduce((n, s) => n + Math.max(0, s.attempts - 1), 0),
  };
}

/** Human line for a step event (the audit summary; §2.5). */
function workflowEventSummary(wf: AgentWorkflow, e: WorkflowEventPayload): string {
  const n = wf.steps.length;
  const at = e.stepIndex !== undefined ? `Step ${e.stepIndex + 1}/${n}` : 'Workflow';
  switch (e.event) {
    case 'started':
      return `Workflow started: ${e.detail ?? `${n} steps planned`}.`;
    case 'resumed':
      return `Workflow resumed from its checkpoint at step ${(e.stepIndex ?? 0) + 1}/${n}.`;
    case 'step_started':
      return `${at} started${e.attempt && e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}: ${e.stepTitle ?? ''}.`;
    case 'step_verifying':
      return `${at}: verifying "${e.stepTitle ?? ''}".`;
    case 'step_done':
      return `${at} done: ${e.stepTitle ?? ''}.`;
    case 'step_retrying':
      return `${at} did not finish — ${e.detail ?? 'retrying'}.`;
    case 'step_replanned':
      return `${at}: re-planned the remaining steps (${e.detail ?? 'previous plan failed'}).`;
    case 'step_replan_failed':
      return `${at}: schema re-plan failed — ${e.detail ?? 'original steps kept'}.`;
    case 'done':
      return `Workflow complete: all ${n} steps done.`;
    case 'stuck':
      return `Workflow stuck at ${at.toLowerCase()}: ${e.detail ?? 'no verified progress'}.`;
    case 'halted':
      return `Workflow halted at ${at.toLowerCase()}: ${e.detail ?? 'human gate'}.`;
    case 'cancelled':
      return 'Workflow cancelled by the user.';
    case 'superseded':
      return 'Workflow superseded by a new request.';
    default:
      return `Workflow event: ${e.event}.`;
  }
}

/** What would unblock a stuck step, phrased from the failure detail. */
function stuckUnblockHint(detail: string): string {
  if (/model service/i.test(detail)) {
    return 'the model service was unavailable — waiting a moment and saying "continue" is enough.';
  }
  if (/verification/i.test(detail)) {
    return 'the check in the step detail above says what the sheet should hold — correct the sheet, or tell me the right target, then say "continue".';
  }
  if (/budget/i.test(detail)) {
    return 'the step may need to be split into smaller pieces — tell me how you would split it, or say "continue" and I will retry it with a fresh plan.';
  }
  return 'tell me anything that changes the picture — a corrected value, a different sheet or range — or say "continue" to retry the step.';
}

/** One cell out of a read_cells result payload ({cells: [[...]]}). */
function cellAt(data: unknown, r: number, c: number): unknown {
  const cells = (data as { cells?: unknown } | undefined)?.cells;
  if (!Array.isArray(cells)) return undefined;
  const row = cells[r];
  if (!Array.isArray(row)) return undefined;
  return row[c];
}

function isEmptyCell(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Check equality: numbers within the W2 tolerance; strings exact
 *  (trimmed); a numeric string read-back matches a numeric expectation. */
function cellEquals(v: unknown, equals: number | string): boolean {
  if (typeof equals === 'number') {
    if (typeof v === 'number') return numEq(v, equals);
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      return numEq(Number(v), equals);
    }
    return false;
  }
  return typeof v === 'string' ? v.trim() === equals : v === equals;
}

function truncateText(text: string, max = MAX_SUMMARY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function parseToolResult(res: unknown): { ok: boolean; data?: unknown; error?: string } {
  const r = res as { content?: RpcText[]; isError?: boolean };
  // MCP results can carry several text parts; use all of them. The
  // product server's own errors are JSON ({ok:false, error}), but SDK
  // argument-validation failures arrive as PLAIN TEXT with isError set —
  // the old code JSON-parsed only content[0], fell into the catch, and
  // dropped the text, surfacing literally "failed: undefined" (D1b).
  const text = (r.content ?? [])
    .filter((c) => typeof c?.text === 'string')
    .map((c) => c.text)
    .join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (r.isError) {
      const error = truncateText(text.trim() || 'tool call failed (no error detail)');
      return { ok: false, error, data: { text: error } };
    }
    return { ok: true, data: { text } };
  }
  const p = parsed as { ok?: boolean; error?: string } & Record<string, unknown>;
  if (p.ok === false || r.isError) {
    const error = truncateText(
      typeof p.error === 'string' && p.error.length > 0
        ? p.error
        : typeof (p as { message?: unknown }).message === 'string'
          ? String((p as { message?: unknown }).message)
          : text.trim() || 'tool call failed (no error detail)',
    );
    return { ok: false, error, data: p };
  }
  const { ok: _ok, protocolVersion: _pv, ...data } = p;
  void _ok;
  void _pv;
  return { ok: true, data };
}
