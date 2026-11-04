/**
 * Agent service configuration (design-docs/ai-agent.md §8).
 *
 * The product ships a default model and the user can point the agent at
 * another provider with their own key. This module owns:
 *
 * - AgentModelConfig: the per-user model selection (provider id, base URL,
 *   model id, and a *reference* to the vault credential holding the key —
 *   never the key itself).
 * - AgentConfigStore: per-user config persisted in the service metadata
 *   store (never in workbook bytes; ai-agent.md §9).
 * - createModelBackend(): builds the ModelBackend for the user's config,
 *   resolving the API key from the service credential vault at request
 *   time. The key is never stored in the config, never logged, and never
 *   returned by any read surface.
 * - DelegatingModelBackend: a ModelBackend that re-resolves the real
 *   backend on every plan() call, so a provider switch takes effect
 *   immediately without tearing down the agent runtime.
 */

import type { CredentialVault } from '../vault.js';
import type {
  JobPlan,
  JobPlanInput,
  ModelBackend,
  PlannerInput,
  PlannerOptions,
  PlannerOutput,
} from './types.js';
import { NoModelConfiguredBackend } from './backends.js';
import { OpenAICompatibleBackend } from './openaiBackend.js';
import type { Persistence } from '../metadataStore.js';

/**
 * Selectable model providers (#137, owner ruling 2026-10-25).
 * 'vertex' is the DEFAULT: the deployment's GCP Vertex AI model
 * (gemini-3.1-flash-lite, global endpoint), resolved gateway-side by
 * selectBackend — the service process itself holds no GCP token
 * provider, so service-side resolution of 'vertex' yields the no-model
 * backend (the gateway is what serves Vertex). 'openai-compatible' is
 * a user-configured endpoint with a vault-stored key. There is NO
 * heuristic provider anymore: the regex planner was DELETED, and any
 * other id (including legacy stored 'heuristic' values, which
 * AgentConfigStore.get() normalizes to the default) fails closed to
 * the no-model backend — never a guessed turn.
 */
export type ModelProviderId = 'vertex' | 'openai-compatible';

export const MODEL_PROVIDERS: readonly ModelProviderId[] = ['vertex', 'openai-compatible'];

export function isModelProviderId(id: string): id is ModelProviderId {
  return (MODEL_PROVIDERS as readonly string[]).includes(id);
}

/**
 * Per-user model configuration. `keyRef` is an opaque reference into the
 * service credential vault — never a secret value. `hasKey` is a derived
 * read-surface flag (the key itself is never readable through config).
 */
export interface AgentModelConfig {
  provider: ModelProviderId;
  /** Required for 'openai-compatible': e.g. 'https://api.openai.com/v1'. */
  baseUrl?: string;
  /** Model id for 'openai-compatible'. Defaults to 'gpt-4o-mini'. */
  model?: string;
  /** Vault credential reference holding the user's API key. */
  keyRef?: string;
}

export interface AgentServiceSettings {
  model: AgentModelConfig;
}

/** The default model is Vertex AI (gateway-resolved) — never heuristic. */
export function defaultAgentSettings(): AgentServiceSettings {
  return { model: { provider: 'vertex' } };
}

/** Vault reference holding a user's agent model API key. Namespaced per user. */
export function modelKeyRef(principal: string): string {
  return `agent:${principal}:model-api-key`;
}

const CONFIG_STORAGE_KEY = 'icecream-sheets.agent.config.v1';
const CONFIG_VERSION = 1;

interface StoredAgentConfig {
  version: number;
  users: Record<string, AgentServiceSettings>;
}

/**
 * Per-user agent settings persisted in the service metadata store
 * (ai-agent.md §9: conversation/config state lives in the service metadata
 * store, per user, never in workbook bytes).
 */
export class AgentConfigStore {
  private cache: StoredAgentConfig | null = null;

  constructor(private readonly persistence: Persistence) {}

  /** The user's settings, or the default (Vertex AI model). Legacy
   *  stored 'heuristic' values normalize to the default here, so old
   *  configs get the Vertex model instead of erroring. */
  get(principal: string): AgentServiceSettings {
    const stored = this.load().users[principal];
    if (!stored) return defaultAgentSettings();
    const model = stored.model ?? { provider: 'vertex' as ModelProviderId };
    return {
      model: {
        provider: isModelProviderId(model.provider) ? model.provider : 'vertex',
        ...(typeof model.baseUrl === 'string' ? { baseUrl: model.baseUrl } : {}),
        ...(typeof model.model === 'string' ? { model: model.model } : {}),
        ...(typeof model.keyRef === 'string' ? { keyRef: model.keyRef } : {}),
      },
    };
  }

  /** Replace the user's settings (write-through). */
  save(principal: string, settings: AgentServiceSettings): void {
    const stored = this.load();
    stored.users[principal] = {
      model: {
        provider: settings.model.provider,
        ...(settings.model.baseUrl !== undefined ? { baseUrl: settings.model.baseUrl } : {}),
        ...(settings.model.model !== undefined ? { model: settings.model.model } : {}),
        ...(settings.model.keyRef !== undefined ? { keyRef: settings.model.keyRef } : {}),
      },
    };
    this.persist(stored);
  }

  /** Read surface for UIs: provider + endpoint + whether a key is stored. Never the key. */
  describe(principal: string): {
    provider: ModelProviderId;
    baseUrl?: string;
    model?: string;
    hasKey: boolean;
  } {
    const m = this.get(principal).model;
    return {
      provider: m.provider,
      ...(m.baseUrl !== undefined ? { baseUrl: m.baseUrl } : {}),
      ...(m.model !== undefined ? { model: m.model } : {}),
      hasKey: typeof m.keyRef === 'string' && m.keyRef.length > 0,
    };
  }

  private load(): StoredAgentConfig {
    if (this.cache) return this.cache;
    let users: Record<string, AgentServiceSettings> = {};
    try {
      const raw = this.persistence.load(CONFIG_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredAgentConfig>;
        if (parsed && parsed.version === CONFIG_VERSION && typeof parsed.users === 'object' && parsed.users !== null) {
          users = parsed.users as Record<string, AgentServiceSettings>;
        }
      }
    } catch {
      users = {};
    }
    this.cache = { version: CONFIG_VERSION, users };
    return this.cache;
  }

  private persist(stored: StoredAgentConfig): void {
    this.cache = stored;
    this.persistence.save(CONFIG_STORAGE_KEY, JSON.stringify(stored));
  }
}

export interface BackendFactoryDeps {
  /** The user's settings (provider selection). */
  config: AgentServiceSettings;
  /** Service credential vault; the key is resolved from it at request time. */
  vault: CredentialVault;
  /** Principal the backend acts as (scopes the vault reference). */
  principal: string;
  /** fetch implementation for the HTTP provider (inject a fake in tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Environment-configured model backend (#137, local test model).
 *
 * Reads (never stores) at resolve time, so a key supplied at service
 * runtime takes effect without a restart (the gateway re-resolves per
 * plan() via DelegatingModelBackend):
 * - AGENT_MODEL_BASE_URL: OpenAI-compatible endpoint, e.g. Groq's
 *   https://api.groq.com/openai/v1 (required, http(s) only).
 * - AGENT_MODEL_API_KEY: the API key (required; read fresh from
 *   process.env on every plan() call — never logged, never persisted).
 * - AGENT_MODEL_ID: model id (optional; when unset the backend's own
 *   default applies — set it explicitly for non-OpenAI endpoints).
 * Returns null when base URL or key is absent: no model, no backend,
 * and the caller falls through to the clear no-model error.
 */
export function createEnvModelBackend(deps: { fetchImpl?: typeof fetch } = {}): ModelBackend | null {
  const baseUrl = process.env.AGENT_MODEL_BASE_URL;
  const key = process.env.AGENT_MODEL_API_KEY;
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl) || !key) return null;
  const model = process.env.AGENT_MODEL_ID;
  return new OpenAICompatibleBackend({
    baseUrl,
    ...(model ? { model } : {}),
    // Read at call time, not construction time: rotation and
    // runtime-injected keys work, and the key never lives in an object.
    getApiKey: async () => process.env.AGENT_MODEL_API_KEY ?? '',
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

/**
 * Build the ModelBackend for the user's config. 'openai-compatible'
 * yields an HTTP backend whose API key is resolved from the vault per
 * request — the key never lives in the config and never appears in
 * logs. Anything else yields NoModelConfiguredBackend (#137): a clear
 * error, never a guessed turn. That includes 'vertex' service-side —
 * the Vertex model is resolved gateway-side (selectBackend), where the
 * GCP token provider lives; a bare service process has no token
 * provider, so it correctly reports no model.
 */
export function createModelBackend(deps: BackendFactoryDeps): ModelBackend {
  const m = deps.config.model;
  if (m.provider === 'openai-compatible') {
    if (!m.baseUrl || !/^https?:\/\//i.test(m.baseUrl)) {
      throw new Error('agent model config: openai-compatible provider needs a valid http(s) baseUrl');
    }
    const keyRef = m.keyRef ?? modelKeyRef(deps.principal);
    const vault = deps.vault;
    const principal = deps.principal;
    return new OpenAICompatibleBackend({
      baseUrl: m.baseUrl,
      model: m.model,
      getApiKey: () => vault.retrieve(keyRef, principal),
      fetchImpl: deps.fetchImpl,
    });
  }
  return new NoModelConfiguredBackend();
}

/**
 * A ModelBackend that re-resolves the real backend on every plan() call
 * from the user's current config. Lets the user switch providers (or
 * rotate the key) without restarting the agent runtime; tools and behavior
 * do not change with the model (§8).
 */
export class DelegatingModelBackend implements ModelBackend {
  readonly name = 'delegating';

  constructor(private readonly resolve: () => Promise<ModelBackend> | ModelBackend) {}

  async plan(input: PlannerInput, opts?: PlannerOptions): Promise<PlannerOutput> {
    const backend = await this.resolve();
    return backend.plan(input, opts);
  }

  /**
   * Job planning delegates like plan() (agent-workflows.md §2.1). A
   * resolved backend without planJob yields null — "no plan
   * available" — and the runtime falls back to the ordinary loop.
   */
  async planJob(input: JobPlanInput): Promise<JobPlan | null> {
    const backend = await this.resolve();
    if (typeof backend.planJob !== 'function') return null;
    return backend.planJob(input);
  }
}
