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
import type { ModelBackend, PlannerInput, PlannerOutput } from './types.js';
import { HeuristicModelBackend } from './backends.js';
import { OpenAICompatibleBackend } from './openaiBackend.js';
import type { Persistence } from '../metadataStore.js';

/** Selectable model providers. 'heuristic' is the shipped default model. */
export type ModelProviderId = 'heuristic' | 'openai-compatible';

export const MODEL_PROVIDERS: readonly ModelProviderId[] = ['heuristic', 'openai-compatible'];

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

export function defaultAgentSettings(): AgentServiceSettings {
  return { model: { provider: 'heuristic' } };
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

  /** The user's settings, or the default (shipped heuristic model). */
  get(principal: string): AgentServiceSettings {
    const stored = this.load().users[principal];
    if (!stored) return defaultAgentSettings();
    const model = stored.model ?? { provider: 'heuristic' as ModelProviderId };
    return {
      model: {
        provider: isModelProviderId(model.provider) ? model.provider : 'heuristic',
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
 * Build the ModelBackend for the user's config. 'heuristic' (or anything
 * unrecognized) yields the shipped default; 'openai-compatible' yields an
 * HTTP backend whose API key is resolved from the vault per request —
 * the key never lives in the config and never appears in logs.
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
  return new HeuristicModelBackend();
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

  async plan(input: PlannerInput): Promise<PlannerOutput> {
    const backend = await this.resolve();
    return backend.plan(input);
  }
}
