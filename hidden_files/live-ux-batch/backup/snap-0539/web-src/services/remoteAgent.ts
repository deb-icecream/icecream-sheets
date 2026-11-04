/**
 * Remote AI Agent backend (spec a/b): the web app's AgentChat UI talks to
 * the AI Agent host service through the API gateway instead of running
 * the AgentRuntime in-process.
 *
 * Implements the narrow surface AgentChat needs. Proactive watch runs
 * through the agent service's wake loop (ai-agent.md §6): POST /watch
 * starts a server-side watch (MCP subscription + batching + rate-limiting
 * + persisted per-user mute) and pollWatch drains its wakes. Chat/answer/
 * audit/model-config/mute are fully supported.
 */
import type {
  AgentChartAttachment,
  AgentReply,
  AuditEntry,
  PendingInput,
  PendingAskView,
  ProactiveMuteConfig,
} from '@icecream-sheets/service';
import { GatewayClient } from './gatewayClient';

/** Narrow backend surface consumed by AgentChat. */
export interface AgentChatBackend {
  chat(threadId: string, text: string): Promise<AgentReply>;
  answer(threadId: string, text: string): Promise<AgentReply>;
  getAuditLog(threadId?: string): AuditEntry[];
  watch(events: string[], sheet?: string): Promise<string>;
  unwatch(subscriptionId: string): Promise<void>;
  pollWatch(
    subscriptionId: string,
    maxEvents?: number,
  ): Promise<{ seq: number; ts: number; type: string; detail: unknown }[]>;
  close(): Promise<void>;
  /**
   * Human-in-the-loop asks (ai-agent.md §12): what the paused agent is
   * waiting for. Present on backends that surface the agent.* tools
   * (local runtime, gateway, desktop); absent where unsupported.
   */
  listPendingAsks?(): Promise<PendingAskView[]>;
  /** Deliver the human's answer, unblocking the paused turn. */
  answerPendingAsk?(askId: string, answer: string, note?: string): Promise<void>;
  /**
   * Model backend selection (ai-agent.md §8). The key itself is never
   * readable through getModelConfig — only whether one is stored.
   */
  getModelConfig?(): Promise<AgentModelConfigView>;
  /**
   * Switch the model provider. `apiKey` (non-empty string) is stored in
   * the service credential vault; `null` revokes the stored key;
   * `undefined` leaves the stored key untouched.
   */
  setModelConfig?(input: SetAgentModelConfigInput): Promise<AgentModelConfigView>;
  /** Proactive mute config (ai-agent.md §6): per user, persisted. */
  getProactiveMute?(): Promise<ProactiveMuteConfig>;
  /** Patch the proactive mute config; returns the full resulting config. */
  setProactiveMute?(patch: {
    mutedAll?: boolean;
    muted?: Partial<Record<string, boolean>>;
  }): Promise<ProactiveMuteConfig>;
}

/** Model backend selection as seen by the UI (the key is never readable). */
export interface AgentModelConfigView {
  provider: string;
  baseUrl?: string;
  model?: string;
  hasKey: boolean;
  /**
   * For the shipped default choice (provider 'heuristic'), what will
   * actually serve it: 'vertex' = the product's default model (Gemini on
   * Vertex AI, served by the app), 'heuristic' = the local deterministic
   * planner. Absent when an explicit provider is configured.
   */
  defaultBackend?: 'vertex' | 'heuristic';
  /** The default model id when defaultBackend is 'vertex'. */
  defaultModel?: string;
}

export interface SetAgentModelConfigInput {
  provider: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string | null;
}

interface AgentMessageResponse {
  threadId: string;
  message: string;
  needsInput?: PendingInput | null;
  audit: AuditEntry[];
  /**
   * Analysis chart attachment as emitted by the agent service
   * (agentSvc.ts: `chart: reply.chart ?? null`): an AgentChartAttachment
   * ({ title, config: Chart.js config }) or null when the turn produced
   * no chart.
   */
  chart?: AgentChartAttachment | null;
}

export class RemoteAgentBackend implements AgentChatBackend {
  private threadId: string | null = null;
  private auditCache: AuditEntry[] = [];

  constructor(private readonly client: GatewayClient) {}

  private async send(text: string, kind: 'chat' | 'answer'): Promise<AgentReply> {
    const res = await this.client.call<AgentMessageResponse>(
      '/api/agent/message',
      { method: 'POST' },
      { threadId: this.threadId ?? undefined, text, kind },
    );
    this.threadId = res.threadId;
    this.auditCache = res.audit ?? [];
    return {
      threadId: res.threadId,
      message: res.message,
      actionsTaken: res.audit ?? [],
      needsInput: res.needsInput ?? undefined,
      // Carry the analysis chart through unchanged, exactly as the local
      // in-process runtime's AgentReply does (chart?: AgentChartAttachment).
      // The gateway sends null when there is no chart; the local path
      // leaves the field absent in that case, so do the same here.
      ...(res.chart ? { chart: res.chart } : {}),
    };
  }

  chat(threadId: string, text: string): Promise<AgentReply> {
    if (!this.threadId) this.threadId = threadId;
    return this.send(text, 'chat');
  }

  answer(threadId: string, text: string): Promise<AgentReply> {
    if (!this.threadId) this.threadId = threadId;
    return this.send(text, 'answer');
  }

  getAuditLog(): AuditEntry[] {
    return [...this.auditCache];
  }

  async watch(events: string[], sheet?: string): Promise<string> {
    // Proactive watch through the agent service's wake loop (ai-agent.md
    // §6): the service owns the MCP subscription, batches rapid events,
    // rate-limits pings, applies the user's persisted mute config, and
    // queues wakes for pollWatch to drain.
    const res = await this.client.call<{ watchId: string }>(
      '/api/agent/watch',
      { method: 'POST' },
      { events, ...(sheet ? { sheet } : {}) },
    );
    if (!res.watchId) throw new Error('agent watch failed: no watchId returned');
    return res.watchId;
  }

  async unwatch(watchId: string): Promise<void> {
    await this.client
      .call('/api/agent/watch/stop', { method: 'POST' }, { watchId })
      .catch(() => undefined);
  }

  async pollWatch(
    watchId: string,
    maxEvents = 50,
  ): Promise<{ seq: number; ts: number; type: string; detail: unknown }[]> {
    // Wakes are already batched/rate-limited/mute-filtered server-side;
    // flatten them back into event records so the chat's existing
    // collapse-and-notice logic works unchanged.
    const res = await this.client.call<{
      wakes?: { events?: { seq: number; ts: number; type: string; detail: unknown }[] }[];
    }>(`/api/agent/watch/poll?watchId=${encodeURIComponent(watchId)}`, { method: 'GET' });
    const events = (res.wakes ?? []).flatMap((w) => w.events ?? []);
    return events.slice(0, maxEvents);
  }

  async close(): Promise<void> {
    this.threadId = null;
    this.auditCache = [];
  }

  /**
   * Human-in-the-loop (ai-agent.md §12) through the gateway: while a
   * /message turn is parked on an agent.* tool call, the chat UI polls
   * /pending and answers via /answer.
   */
  async listPendingAsks(): Promise<PendingAskView[]> {
    const res = await this.client.call<{ asks?: PendingAskView[] }>('/api/agent/pending', {
      method: 'GET',
    });
    return res.asks ?? [];
  }

  async answerPendingAsk(askId: string, answer: string, note?: string): Promise<void> {
    await this.client.call('/api/agent/answer', { method: 'POST' }, { askId, answer, note });
  }

  /**
   * Model backend selection (ai-agent.md §8) through the gateway. The key
   * is write-only: getModelConfig reports only whether one is stored.
   */
  async getModelConfig(): Promise<AgentModelConfigView> {
    return this.client.call<AgentModelConfigView>('/api/agent/config', { method: 'GET' });
  }

  async setModelConfig(input: SetAgentModelConfigInput): Promise<AgentModelConfigView> {
    return this.client.call<AgentModelConfigView>('/api/agent/config', { method: 'POST' }, input);
  }

  /** Proactive mute (ai-agent.md §6): per user, persisted server-side. */
  async getProactiveMute(): Promise<ProactiveMuteConfig> {
    return this.client.call<ProactiveMuteConfig>('/api/agent/watch/mute', { method: 'GET' });
  }

  async setProactiveMute(patch: {
    mutedAll?: boolean;
    muted?: Partial<Record<string, boolean>>;
  }): Promise<ProactiveMuteConfig> {
    return this.client.call<ProactiveMuteConfig>('/api/agent/watch/mute', { method: 'POST' }, patch);
  }
}
