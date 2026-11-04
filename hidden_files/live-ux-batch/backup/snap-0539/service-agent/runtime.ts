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
  AuditEntry,
  AuditKind,
  ModelBackend,
  PlannerOutput,
  ToolCallAction,
  ToolResultRecord,
} from './types.js';
import { AgentTurnCancelled } from './types.js';
import { HeuristicModelBackend } from './backends.js';
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
  /** Sheet the app binds to. Defaults to 'Sheet1'. */
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
export function agentRateLimitMessage(limitPerMinute: number): string {
  return (
    `You're sending requests too quickly — the limit is ${fmtCount(limitPerMinute)} requests ` +
    'per minute. Please wait a moment and try again.'
  );
}

/**
 * The scope-decline text: polite, names what the agent CAN do (the spirit
 * of the heuristic backend's HELP_QUESTION, widened to the full product
 * surface), and answers nothing of the off-topic question.
 */
export const AGENT_SCOPE_DECLINE_MESSAGE =
  "I can only help with spreadsheet, data, and Icecream Sheets questions, so I can't answer that one. " +
  'I can read and write cells and ranges (e.g. "sum of A1:A10", "set B2 to 5"), set formulas, ' +
  'recalculate, remember notes ("remember that the budget is 5000"), analyze data with charts and ' +
  'pivots, build apps from your data, run ETL recipes and automations, work with data sources, and ' +
  'generate reports. What would you like to do with your spreadsheet?';

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

  constructor(opts: AgentRuntimeOptions) {
    this.server = opts.server;
    this.backend = opts.backend ?? new HeuristicModelBackend();
    this.principal = opts.principal ?? 'agent-user';
    this.userId = opts.userId ?? this.principal;
    this.maxIterations = opts.maxIterations ?? 5;
    this.maxAsksPerTurn = opts.maxAsksPerTurn ?? 1;
    this.confirmThreshold = opts.confirmThreshold ?? 10;
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

  /** Close the MCP client connection. */
  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  private log(
    threadId: string,
    kind: AuditKind,
    fields: Partial<Pick<AuditEntry, 'tool' | 'args' | 'ok' | 'summary' | 'text'>> = {},
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
    let result: GenerateArtifactResult;
    try {
      result = await generateAndSaveArtifact(
        { prompt, sheet: opts.sheet ?? 'Sheet1' },
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
    if (this.scopeGateEnabled && classifyScope(userText) === 'off-topic') {
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
      const reply = await this.runLoop(threadId, userText, [], 0, false, userText, Date.now(), -1, 0, null, hooks);
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

  private async runLoop(
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
  ): Promise<AgentReply> {
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
    // choice may park ungrounded — the app-generation "Describe the app /
    // Analyze the data instead" ask and the unknown-intent help menu,
    // both built by the deterministic backend and marked
    // intentChoice: true (see AskAction). No tool can answer an intent
    // choice and there is nothing to ground on yet. The exemption used to
    // cover ANY ask carrying options, on the assumption that ask cascades
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
          ...(sheets && sheets.length > 0 ? { sheetContext: { sheets } } : {}),
        });
      } catch (e) {
        // Planner-fix M4-slim (2026-10-22, merged with FIX-R4): the
        // backend already retries transient provider failures with
        // backoff (FIX-R4 round 2); a throw that still escapes plan()
        // used to propagate out of chat() and surface as a raw HTTP 500
        // with provider error text. End the turn with an honest busy
        // reply instead. No runtime-level retry — the backend's own
        // backoff already ran.
        this.log(threadId, 'timeout', {
          text: 'planner',
          summary: `planner call failed (${e instanceof Error ? e.message : String(e)})`,
        });
        // W1 honest progress: a failed planner call mid-batch must not
        // read as "nothing happened" when earlier chunks already landed.
        const landedBeforeFailure = this.landedWriteCells(auditStart);
        const message =
          'The model service is busy right now, so I could not finish that request. Please try again in a moment.' +
          (landedBeforeFailure > 0
            ? ` Note: ${landedBeforeFailure} cell(s) were already written before the failure — those changes are in the sheet.`
            : '');
        hist.push({ role: 'agent', text: message, ts: Date.now() });
        this.log(threadId, 'agent_message', { text: message });
        return { threadId, message, actionsTaken: [], chart: this.chartAttachment(results) };
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
        const done = await this.executeTools(threadId, rest.filter(isTool), hooks);
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
        if (verdict === 'timeout') return this.hitlTimeoutReply(threadId);
        this.log(threadId, 'confirmation', {
          text: verdict.note ?? (verdict.approved ? 'yes' : 'no'),
          summary: verdict.approved ? 'user confirmed the write' : 'user declined the write',
        });
        if (!verdict.approved) {
          const declined = "OK — I didn't make any changes.";
          hist.push({ role: 'agent', text: declined, ts: Date.now() });
          this.log(threadId, 'agent_message', { text: declined });
          return { threadId, message: declined, actionsTaken: [] };
        }
        // Approved: execute the confirming actions, then keep planning.
        const confirmed = await this.executeTools(threadId, needsConfirm.filter(isTool), hooks);
        if (confirmed.length > 0) grounded = true;
        results = [...results, ...confirmed];
        continue;
      }

      const ask = plan.actions.find((a): a is Extract<AgentAction, { type: 'ask' }> => a.type === 'ask');
      // Execute tool actions (asks pause after tools run).
      const toolActions = plan.actions.filter(isTool);
      const newResults = await this.executeTools(threadId, toolActions, hooks);
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
        if (answered === 'timeout') return this.hitlTimeoutReply(threadId);
        hist.push({ role: 'user', text: answered, ts: Date.now() });
        // Planner-fix M2 (2026-10-22, merged with FIX-R4): the answered
        // ask resumes with the ACCUMULATED tool results, not an empty
        // slate — restarting from [] made the planner re-fetch (and
        // often re-ask) from scratch, burning the step budget. The
        // FIX-R4 ask count and grounding flag ride along: it is the
        // same turn. So does the agent-failures-fix turn context
        // (origin text, turn start, audit offset, aggregate-correction
        // count, sheet names).
        return this.runLoop(
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
        return { threadId, message, actionsTaken: [], chart: this.chartAttachment(results) };
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
    return { threadId, message, actionsTaken: [], chart: this.chartAttachment(results) };
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

  private async executeTools(
    threadId: string,
    actions: ToolCallAction[],
    hooks?: AgentTurnHooks,
  ): Promise<ToolResultRecord[]> {
    const client = await this.ensureConnected();
    const out: ToolResultRecord[] = [];
    for (const a of actions) {
      if (hooks?.isCancelled?.()) throw new AgentTurnCancelled();
      hooks?.onEvent?.({ type: 'tool', phase: 'start', tool: a.tool });
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
