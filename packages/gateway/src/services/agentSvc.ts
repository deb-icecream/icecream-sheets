/**
 * Agent service: the AI Agent runtime behind HTTP.
 *
 * Wraps AgentRuntime (packages/service/src/agent/runtime.ts). The runtime
 * acts ONLY through versioned MCP tools: it holds an MCP Client connected
 * to the product MCP server (createServer from @icecream-sheets/mcp-server)
 * over an InMemoryTransport — the same in-process hosting the web app uses.
 * There is no private path to the engine.
 *
 * Identity: one AgentRuntime per requesting principal (a Map keyed by the
 * gateway-verified x-principal), so tool calls and the audit trail are
 * stamped with the right user. Threads are keyed by threadId; a thread is
 * created when the client passes none. Conversation threads are persisted
 * per user in the service metadata store (file-backed Persistence,
 * ai-agent.md §9) so they survive service restarts.
 *
 * Endpoints:
 * - GET  /health
 * - POST /message  { threadId?, text } →
 *        { threadId, message, needsInput: null | { prompt, options }, audit }
 * - GET  /audit?threadId=… → { audit }
 * - GET  /pending → { asks } — the caller's pending human-in-the-loop asks
 *        (ai-agent.md §12); the chat UI polls this while a turn is parked.
 * - POST /answer { askId, answer, note? } → { ok: true } — delivers the
 *        human's answer through the versioned agent.answer_pending MCP
 *        tool, unblocking the paused turn. Principal-scoped like the tool.
 * - POST /watch { events?, sheet? } → { watchId } — start a proactive
 *        event watch (ai-agent.md §6). The service polls the MCP
 *        subscription, batches rapid events, rate-limits pings, applies
 *        the user's mute config, and queues wakes.
 * - GET  /watch/poll?watchId= → { wakes } — drain queued proactive wakes.
 * - POST /watch/stop { watchId } → { ok } — stop a watch.
 * - GET  /watch/mute → the user's proactive mute config.
 * - POST /watch/mute { mutedAll?, muted? } → updated mute config
 *        (ai-agent.md §6: whole-thing toggle + per-category, persisted).
 * - GET  /config → { provider, baseUrl?, model?, hasKey } — the user's
 *        model backend selection (ai-agent.md §8). The key is never
 *        returned, only whether one is stored.
 * - POST /config { provider, baseUrl?, model?, apiKey? } — switch the
 *        model provider; apiKey (when a non-empty string) is stored in
 *        the service credential vault, never in the config. apiKey: null
 *        revokes the stored key.
 * - POST /transcribe { audioBase64, mimeType } → { ok, text, model } —
 *        dictation for the voice command palette. Speech-to-text runs on
 *        the cheapest Gemini on Vertex AI (VERTEX_STT_MODEL; user ruling
 *        2026-10-21) through the service package's VertexTranscriber.
 *        Unconfigured service (no GCP project/credentials) → 503.
 * - POST /artifacts/generate { prompt, sheet?, threadId? } → { result }
 *        (FIX-E) — generated-app creation for gateway mode: the same
 *        generateAndSaveArtifact flow the web port runs locally, over
 *        this principal's session-bound runtime (MCP tools only), with
 *        the LLM generator on Vertex AI (gemini-2.5-flash-lite). No GCP
 *        credentials → 503 (fail closed; no template fallback here).
 * - POST /tools/call { tool, args? } → { data } (FIX-E) — the runtime
 *        bridge generated apps call through the gateway. Server-side
 *        allowlist: ALLOWED_BRIDGE_TOOLS only; anything else → 403.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  ALLOWED_BRIDGE_TOOLS,
  AgentRuntime,
  CredentialVault,
  DelegatingModelBackend,
  KeyManager,
  LlmAppGenerator,
  NoModelConfiguredBackend,
  OpenAICompatibleBackend,
  ProactiveWatcher,
  SheetNotFoundError,
  VERTEX_DEFAULT_LOCATION,
  VERTEX_DEFAULT_MODEL,
  VertexAiCodeGenBackend,
  createArtifactStore,
  createEnvCodeGenBackend,
  createEnvModelBackend,
  createModelBackend,
  detectTemplate,
  isModelProviderId,
  isProactiveEventType,
  memoryPersistence,
  modelKeyRef,
  AgentConfigStore,
  VertexTranscriber,
  type AgentServiceSettings,
  type AppGenerator,
  type ModelBackend,
  type Persistence,
  type ProactiveEvent,
  type ProactiveEventType,
  type Transcriber,
} from '@icecream-sheets/service';
import { createServer, type ChartSink } from '@icecream-sheets/mcp-server';
import { getWebResearchProvider } from './webResearch.js';
import { handlePreflight, readBody, requestPrincipal, sendError, sendJson } from '../httpUtils.js';
import { filePersistence, gatewayDataDir } from '../filePersistence.js';
import { createGcpAccessTokenProvider } from './vertexToken.js';
import {
  AGENT_BINDING_HEADER,
  engineAccessSecret,
  issueEngineAccessToken,
  verifyAgentBinding,
  type AgentBindingClaims,
} from '../deploy/engineAccess.js';
import {
  createAgentSessionResolver,
  type ResolvedAgentSession,
} from './agentSessionResolver.js';
import type { FileRegistry } from '../deploy/fileRegistry.js';
import {
  NodeRemoteEngineHost,
  type RemoteEngineFetch,
} from './remoteEngineHost.js';
import {
  EngineHost,
  type AsyncCommandResult,
  type CommandResult,
  type EngineCommand,
} from '@icecream-sheets/engine';

/**
 * One runtime per principal per process. Each runtime owns its MCP server
 * (and therefore its own engine view of the workbook), so users never share
 * agent memory or tool-call identity.
 *
 * Human-in-the-loop (§12): the runtime pauses by calling the versioned
 * agent.* MCP tools, which block until the human answers. The wait here is
 * 4 minutes — deliberately under Node's default 5-minute HTTP request
 * timeout so a parked /message POST ends with the clean HITL timeout
 * error instead of a severed socket. The runtime's client-side timeout is
 * derived from the same value, so the server always answers first.
 */
const AGENT_HITL_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * Planner iteration budget per turn (FIX-R4): the runtime default of 5
 * left no headroom for the normal shape of real work — read → one
 * failed call → corrected retry → second read → answer is already 4–5
 * plans, so a single tool failure exhausted the turn ("I ran out of
 * steps") on trivial questions. 10 absorbs a failure + retry + a
 * follow-up read while still bounding a genuinely looping planner.
 */
const AGENT_MAX_ITERATIONS = 10;

/**
 * Engine-access tokens for a bound agent host: SHORT-lived (2 min) and
 * re-minted on every engine request by the host's getAccessToken
 * callback — never cached, never logged. The role is the user's OWN
 * session role as resolved from the registry (FIX-B residual 4): the
 * agent acts as the user (§3), so a user who joined as a viewer gets a
 * viewer-scoped agent token and the engine refuses its /ops visibly
 * (403 'viewer-role'); an editor's agent keeps full write access.
 */
const AGENT_ENGINE_TOKEN_TTL_SECONDS = 120;

/**
 * Runtime cache. Bound sessions share one entry per principal (the
 * key embeds the session key, so a changed binding rebuilds); the
 * null-session case splits by caller kind (#86: 'r' chat turns get
 * the write-refusing host, 'w' bridge/generate keep the writable
 * scratch host). Each entry also records the session key it is bound
 * to (sessionId:role:engineUrl, or null for the private-host
 * fallback). A changed resolution replaces the entry (see
 * runtimeFor). A file-bound turn's session comes from its
 * attached binding, so a changed binding (owner move, role change)
 * rebuilds the runtime via the sessionKey check.
 */
const runtimes = new Map<string, { rt: AgentRuntime; sessionKey: string | null }>();

/** Default resolver: the on-disk session ownership registry (F1). */
const defaultSessionResolver = createAgentSessionResolver();

/**
 * The session resolver for a request's deps: an explicit override
 * wins; a supplied FileRegistry (the production wiring — in prod the
 * registry is Firestore-backed and no local registry file exists)
 * enumerates via its listAll(); otherwise the on-disk default.
 */
function sessionResolverFor(
  deps: AgentServiceDeps,
): (principal: string) => Promise<ResolvedAgentSession | null> {
  if (deps.resolveSession) return deps.resolveSession;
  if (deps.fileRegistry) {
    return createAgentSessionResolver({ registry: deps.fileRegistry });
  }
  return defaultSessionResolver;
}

/**
 * Default token minter: the deploy/engineAccess signer over
 * ENGINE_ACCESS_SECRET (the agent process carries it in its env,
 * inherited from its launcher — bin/agent.ts and the combined
 * servicePackage.ts pass process.env through untouched). Returns null
 * when no secret is configured: binding then stays OFF and the
 * private-host fallback is preserved, because an unsigned host could
 * not authenticate to a signed-mode engine anyway.
 */
function defaultMintEngineToken(
  principal: string,
  session: ResolvedAgentSession,
): string | null {
  const secret = engineAccessSecret();
  if (!secret) return null;
  return issueEngineAccessToken({
    secret,
    principal,
    sessionId: session.sessionId,
    fid: session.fileId,
    role: session.role,
    tier: 'standard',
    ttlSeconds: AGENT_ENGINE_TOKEN_TTL_SECONDS,
  }).token;
}

/**
 * FIX-G chart sink (trace §4.1a/§4.2): the create_chart delivery for
 * session-bound runtimes. On each call it uses the turn's bound
 * session (#108: for file-bound runtimes the sink's resolver is the
 * turn's binding session constant, so a chart call performs no
 * registry lookup of its own — each message carries a fresh
 * binding),
 * mints a fresh engine-access token for it (the same minter the remote
 * host uses — short-lived, role = the user's session role), and POSTs
 * the spec to the owning engine's /charts endpoint. No live session
 * (or no token) → the call FAILS CLOSED with the tool's honest error:
 * the agent's private-host fallback has no workbook session to author
 * a native chart into. FIX-R4: a transient fresh-session refusal
 * (400 'unknown sheet' / 409) is retried ONCE after a re-resolve —
 * see addChart.
 */
export interface AgentChartSinkDeps {
  resolveSession: (principal: string) => Promise<ResolvedAgentSession | null>;
  mintEngineToken: (principal: string, session: ResolvedAgentSession) => string | null;
  /** Engine fetch override (tests). Default: global fetch. */
  fetchFn?: RemoteEngineFetch;
  /** FIX-R4 transient-retry delay override (tests). Default 2000 ms. */
  retryDelayMs?: number;
}

export function createAgentChartSink(deps: AgentChartSinkDeps): ChartSink {
  const fetchFn: RemoteEngineFetch =
    deps.fetchFn ?? ((fetch as unknown) as RemoteEngineFetch);
  return {
    async addChart(spec, principal) {
      const attempt = async (
        session: ResolvedAgentSession,
      ): Promise<{ id: number | string; revision: number }> => {
        // #99 v2 refinement — PRIMARY GATE (chart creation is a
        // workbook write): a viewer session is refused BEFORE any
        // engine contact. Gating inside attempt() covers the first
        // call AND the FIX-R4 retry (a role change mid-flight is
        // re-checked on the fresh session). The plain Error carries
        // no status, so the retry logic below treats it as final.
        if (session.role !== 'editor') {
          throw new Error(
            'chart creation is refused: this workbook is read-only for the current user',
          );
        }
        const token = deps.mintEngineToken(principal, session);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token) headers['authorization'] = `Bearer ${token}`;
        else headers['x-principal'] = principal;
        const res = await fetchFn(`${session.engineUrl.replace(/\/+$/, '')}/charts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ spec }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(
            `engine /charts failed: HTTP ${res.status} ${text.slice(0, 200)}`,
          ) as Error & { status?: number; bodyText?: string };
          err.status = res.status;
          err.bodyText = text;
          throw err;
        }
        const json = (await res.json()) as { id?: number | string; revision?: number };
        return { id: json.id ?? spec.id, revision: json.revision ?? 0 };
      };

      let session: ResolvedAgentSession | null = null;
      try {
        session = await deps.resolveSession(principal);
      } catch {
        session = null;
      }
      if (!session) {
        throw new Error('chart creation is not available in this session');
      }
      try {
        return await attempt(session);
      } catch (e) {
        // FIX-R4: a freshly opened session can transiently answer
        // 400 'unknown sheet' (or 409 'no active session') for a sheet
        // it provably holds — observed on first chart attempts against
        // just-loaded sessions (3/3 in the case-4 re-run; the planner
        // diagnostic), with the identical call seconds later
        // succeeding. That failure created NOTHING, so one re-resolve +
        // retry cannot duplicate a chart. Any other failure (auth, a
        // spec validation error, 5xx) is final and propagates as-is.
        const status = (e as { status?: number }).status;
        const bodyText = (e as { bodyText?: string }).bodyText ?? '';
        const transient =
          (status === 400 && /unknown sheet/i.test(bodyText)) || status === 409;
        if (!transient) throw e;
        await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 2000));
        let fresh: ResolvedAgentSession | null = null;
        try {
          fresh = await deps.resolveSession(principal);
        } catch {
          fresh = null;
        }
        if (!fresh) throw e;
        return attempt(fresh);
      }
    },
  };
}

/**
 * File-backed thread persistence (ai-agent.md §9, Cycle-3 GAP-4). Created
 * lazily so the data directory (and the $ICECREAM_DATA_DIR override) resolves
 * at first use, not at import time. Shared by every runtime in this process:
 * thread keys are per-user (icecream-sheets.agent-threads.v1.<userId>), so
 * one adapter serves all principals and deployed threads survive restarts.
 */
let threadPersistence: Persistence | null = null;
function agentThreadPersistence(): Persistence {
  if (!threadPersistence) threadPersistence = filePersistence(gatewayDataDir());
  return threadPersistence;
}

/**
 * FIX-E: the artifact store generated apps persist into on this
 * service — the service metadata store over the same file-backed
 * persistence as the conversation threads.
 */
let artifactStoreSingleton: ReturnType<typeof createArtifactStore> | null = null;
function agentArtifactStore(): ReturnType<typeof createArtifactStore> {
  if (!artifactStoreSingleton) {
    artifactStoreSingleton = createArtifactStore(agentThreadPersistence());
  }
  return artifactStoreSingleton;
}

/** FIX-E: lazily-built GCP token provider for Vertex AI app generation. */
let appTokenProvider: (() => Promise<string | null>) | null = null;
function agentAppTokenProvider(): () => Promise<string | null> {
  if (!appTokenProvider) appTokenProvider = createGcpAccessTokenProvider(process.env);
  return appTokenProvider;
}

/** FIX-E: the default app generator — LLM generation on Vertex AI. */
function defaultAppGenerator(): AppGenerator {
  return new LlmAppGenerator({
    backend: new VertexAiCodeGenBackend({
      project:
        process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? 'dreamscapes-zero',
      location: VERTEX_DEFAULT_LOCATION,
      model: VERTEX_DEFAULT_MODEL,
      getAccessToken: agentAppTokenProvider(),
    }),
  });
}

/**
 * #141: generator for the loop's generate_app tool. Mirrors the
 * /artifacts/generate route's resolution: an explicit deps override
 * wins (null = unconfigured, so the tool fails honestly); else the
 * env model when present; else the Vertex default (which fails at
 * call time without GCP creds, surfacing as a FAILED tool result —
 * never a silent template fallback on this path).
 */
function resolveLoopAppGenerator(deps: AgentServiceDeps): AppGenerator | null {
  if (deps.appGenerator !== undefined) return deps.appGenerator;
  const envGen = createEnvCodeGenBackend();
  if (envGen) return new LlmAppGenerator({ backend: envGen });
  return defaultAppGenerator();
}

// -- agent service state (ai-agent.md §§6, 8, 9) ---------------------------
// Per-user agent settings (model provider selection) persist in the
// service metadata store (in-memory here; prod backs this with the metadata
// store backend). API keys live in the service credential vault under
// per-user refs — never in the config, never in logs.
const configPersistence: Persistence = memoryPersistence();
const configStore = new AgentConfigStore(configPersistence);

// Credential vault for agent model API keys. Refs are namespaced
// `agent:<principal>:`; each principal's vault instance pins its check to
// its own namespace (fail closed otherwise).
const vaultPersistence: Persistence = memoryPersistence();
const vaultKeys = new KeyManager(memoryPersistence());
const vaults = new Map<string, Promise<CredentialVault>>();
function agentVault(principal: string): Promise<CredentialVault> {
  let p = vaults.get(principal);
  if (!p) {
    const prefix = `agent:${principal}:`;
    p = CredentialVault.create(vaultPersistence, vaultKeys, {
      check: (_action, target) => target.startsWith(prefix),
    });
    p.catch(() => {
      if (vaults.get(principal) === p) vaults.delete(principal);
    });
    vaults.set(principal, p);
  }
  return p;
}

/**
 * Production planner default (2026-10-22, deploy-followup leg 7; #137
 * owner ruling 2026-10-25: the DEFAULT model is Vertex AI): the default
 * config ('vertex') means "the product's default model" — it is not a
 * model choice a user made. In a deployment with a GCP identity, that
 * default model is Gemini on Vertex AI, reached through the Vertex
 * OpenAI-compatible endpoint with the SERVICE's own access token, so a
 * real signed-in user gets the real model with no per-user setup. The
 * base URL form and the publisher-qualified model id are the exact pair
 * the leg-7 live smoke proved against dreamscapes-zero (the endpoint
 * 400s on a bare model id: "Malformed publisher model").
 */
export function vertexPlannerBaseUrl(project: string): string {
  return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/endpoints/openapi`;
}

export interface VertexDefaultBackendDeps {
  /** GCP project id. Defaults to env GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT. */
  project?: string;
  /** Service token chain. Defaults to the lazy app-generator provider. */
  tokenProvider?: () => Promise<string | null>;
  /** fetch implementation (tests inject a fake). */
  fetchImpl?: typeof fetch;
}

/**
 * The Vertex-backed planner for the default config, or null when the
 * service has no GCP identity (local/dev — the default then falls to
 * the env override, else the no-model error; never a heuristic).
 * The API key is NEVER stored: getApiKey invokes the service token
 * provider on every planner call, so each request's credential comes
 * from the live token chain (the provider itself caches until shortly
 * before expiry; a ~1 h GCP access token is never persisted as a "key"
 * the way the per-user vault flow would require).
 */
export function createVertexDefaultBackend(
  deps: VertexDefaultBackendDeps = {},
): ModelBackend | null {
  const project =
    deps.project ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) return null;
  const tokenProvider = deps.tokenProvider ?? agentAppTokenProvider();
  return new OpenAICompatibleBackend({
    baseUrl: vertexPlannerBaseUrl(project),
    model: `google/${VERTEX_DEFAULT_MODEL}`,
    getApiKey: async () => {
      const token = await tokenProvider();
      if (!token) {
        throw new Error(
          'agent planner: no GCP access token available from the service identity',
        );
      }
      return token;
    },
    fetchImpl: deps.fetchImpl,
  });
}

/**
 * Backend selection (§8, #137 owner rulings 2026-10-25): an explicit
 * per-user 'openai-compatible' config always wins, untouched. The
 * DEFAULT ('vertex') resolves to the production Vertex backend when
 * one is available (GCP identity); else to the environment-configured
 * model (Groq — LOCAL TESTING ONLY, never production); else to the
 * no-model backend — a clear error, never a guessed turn, never a
 * heuristic (the heuristic backend was DELETED; there is no fallback
 * model of any kind). envBackend: undefined = resolve from env now
 * (the live path, via DelegatingModelBackend's per-plan
 * re-resolution); null = explicitly no env backend (tests).
 */
export function selectBackend(
  principal: string,
  config: AgentServiceSettings,
  vault: CredentialVault,
  vertexDefault: ModelBackend | null,
  envBackend?: ModelBackend | null,
): ModelBackend {
  if (config.model.provider === 'openai-compatible') {
    return createModelBackend({ config, vault, principal });
  }
  if (vertexDefault) return vertexDefault;
  const env = envBackend === undefined ? createEnvModelBackend() : envBackend;
  if (env) return env;
  return new NoModelConfiguredBackend();
}

/**
 * What GET/POST /config report (#32): the stored choice PLUS the
 * effective default behind it, so the settings dialog can tell the
 * truth — with no stored config the agent runs on Vertex AI when the
 * service has a GCP identity, and on NO model (clear error, never a
 * guessed turn) when neither Vertex nor the env override is available.
 */
export function describeConfig(principal: string): {
  provider: string;
  baseUrl?: string;
  model?: string;
  hasKey: boolean;
  defaultBackend: 'vertex' | 'no-model';
  defaultModel?: string;
} {
  const view = configStore.describe(principal);
  const vertex = createVertexDefaultBackend();
  return {
    ...view,
    defaultBackend: vertex ? 'vertex' : 'no-model',
    ...(vertex ? { defaultModel: `google/${VERTEX_DEFAULT_MODEL}` } : {}),
  };
}

/** Build the ModelBackend for the user's current config (§8). */
async function resolveBackend(principal: string): Promise<ModelBackend> {
  const config = configStore.get(principal);
  const vault = await agentVault(principal);
  return selectBackend(principal, config, vault, createVertexDefaultBackend());
}

/**
 * #99: a file-bound message whose named file has no live session for
 * this principal (closed, released, or never opened for them). Thrown
 * by runtimeFor so the message handlers can answer honestly instead
 * of letting the turn read another workbook — or the empty private
 * host — and report its values as the open file's (#86's
 * silent-fallback shape on the read side).
 */
export class AgentWorkbookUnboundError extends Error {
  constructor() {
    super('agent workbook unbound');
    this.name = 'AgentWorkbookUnboundError';
  }
}

/**
 * Plain-language reply for the unbound case (#99, #86): the agent
 * states it cannot see the workbook rather than answering from a
 * workbook that is not the user's open file.
 */
export const AGENT_WORKBOOK_UNBOUND_MESSAGE =
  "I can't see the workbook you have open right now — it may have been closed, or it may still be reconnecting. Open the file and ask again, and I'll read from it.";

/**
 * #99: the panel's open file, when the client names it in a message
 * body. `undefined` = absent (older clients, MCP-direct calls) → the
 * legacy active-session binding. `null` = present but malformed →
 * handlers answer 400.
 */
function parseMessageFileId(body: { fileId?: unknown } | undefined): string | null | undefined {
  if (body?.fileId === undefined) return undefined;
  return typeof body.fileId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(body.fileId)
    ? body.fileId
    : null;
}

/**
 * #108 shape (design doc §3): the gateway-attached signed binding.
 * A file-bound turn carries its binding in the x-agent-binding
 * header, signed by the gateway with the shared engine-access
 * secret. This helper verifies it (signature, expiry, principal +
 * file match) and returns the claims, or null when absent/invalid.
 * Null → the handler answers unbound. The service NEVER reads the
 * registry for binding and caches NO link: each message carries a
 * fresh binding, so an owner move is reflected on the very next
 * turn with no refresh dance. A missing/invalid binding is a warn
 * + unbound, never a fallback to another workbook or the private
 * host (#99 property, preserved).
 */
function attachedBinding(
  req: IncomingMessage,
  principal: string,
  fileId: string,
): AgentBindingClaims | null {
  const raw = req.headers[AGENT_BINDING_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string' || header.length === 0) return null;
  const secret = engineAccessSecret();
  if (!secret) {
    console.warn(
      `[agent] attached binding present for ${principal} on ${fileId} but no signing secret is configured — answering unbound`,
    );
    return null;
  }
  try {
    return verifyAgentBinding(header, secret, { principal, fileId });
  } catch (e) {
    console.warn(
      `[agent] attached binding rejected for ${principal} on ${fileId}: ${e instanceof Error ? e.message : String(e)} — answering unbound`,
    );
    return null;
  }
}

/**
 * Session-aware runtime resolution (FIX-B / F1, reshaped by #99,
 * reshaped again by #108).
 *
 * A file-bound turn's session comes from its gateway-attached
 * signed binding (opts.binding, verified by the handler): the
 * gateway resolved it fresh for THIS message, so the service
 * performs zero registry reads for binding and caches no link —
 * an owner move is reflected on the very next turn. Outcomes:
 * - A live session (and a token minter that can sign for it): the
 *   runtime's MCP server wraps a NodeRemoteEngineHost bound to THAT
 *   session on its owning engine instance — the agent reads/writes the
 *   very workbook the user has open, through MCP tools only (§§2–3).
 * - No binding / no signing secret: the runtime is built with
 *   createServer(undefined) — the per-principal private
 *   EngineHost, exactly the pre-F1 behavior (existing tests and the
 *   no-workbook-open case are preserved). For a fileId-named turn this
 *   branch is unreachable: a missing binding throws Unbound first, so
 *   the handler answers honestly instead of serving the private host.
 *
 * Runtimes are cached by principal+sessionId+role: when the resolved
 * session CHANGES (opened a different file, session released, first
 * open after a private period, role changed in the same session) the
 * old runtime is closed (rt.close())
 * and a new one built; the per-principal watcher (which closes over
 * the old runtime) is dropped with it. Config, vault and thread
 * persistence are NOT rebuilt — backend resolution and threads are
 * per-principal and shared across the swap (see the constructor args).
 *
 * RESIDUAL (documented, not hidden): if a /message turn is parked on a
 * HITL ask when the session changes, the parked turn belongs to the old
 * runtime — closing it can fail that one turn, and its pending ask (in
 * the old MCP server's store) is not visible to the new runtime's
 * /pending. The swap only happens on a genuine session change, never
 * mid-turn for a stable session.
 */
/**
 * #86: the private-host fallback's chat guard. A legacy chat turn
 * with no bound session (no live session, no grant) used to run on a
 * plain EngineHost, so its writes SUCCEEDED on its own private
 * scratch workbook and the reply reported success — while the user
 * believed the named file had changed. This subclass refuses every
 * user-data mutation on an unbound chat runtime: the MCP tool call
 * fails with a plain-language error, the reply composes the failure
 * (never 'Done.'), and the scratch workbook is never mutated.
 * Recalculation is NOT user data — it passes through, preserving
 * the pinned fallback-continuity behavior (recalculate ok=true,
 * nothing reaches an engine). Reads pass through unchanged (an
 * empty scratch workbook reads empty, as before). The refusal shape
 * mirrors the remote host's readOnly gate: execute() rejects, so
 * tool handlers surface it as a tool error, never a success.
 * Bridge (/tools/call) and generate deliberately do NOT use this
 * host: app data lives in the private host by design (pinned by
 * the artifact seed test), so they pass allowPrivateHostWrites.
 */
const UNBOUND_CHAT_REFUSAL =
  'refused: no workbook is bound for this chat — there is no live ' +
  'session and no access to a file, so nothing was written. Open a ' +
  'file you have access to and ask again.';
const UNBOUND_CHAT_ALLOWED_COMMANDS = new Set([
  'recalculate',
  'recalculateParallel',
]);
class UnboundChatEngineHost extends EngineHost {
  override execute(command: EngineCommand): CommandResult {
    if (!UNBOUND_CHAT_ALLOWED_COMMANDS.has(command.cmd)) {
      return Promise.reject(new Error(UNBOUND_CHAT_REFUSAL)) as unknown as CommandResult;
    }
    return super.execute(command);
  }
  override async executeAsync(command: EngineCommand): Promise<AsyncCommandResult> {
    if (!UNBOUND_CHAT_ALLOWED_COMMANDS.has(command.cmd)) {
      throw new Error(UNBOUND_CHAT_REFUSAL);
    }
    return super.executeAsync(command);
  }
}

async function runtimeFor(
  principal: string,
  deps: AgentServiceDeps = {},
  opts: {
    fileId?: string;
    binding?: AgentBindingClaims | null;
    allowPrivateHostWrites?: boolean;
    /**
     * #150: read-only observers (/pending, /audit, /workflow) must
     * never close another request's runtime. The swap below exists
     * for turns that TAKE OVER a session; an observer only READS one
     * runtime's state, so closing a live turn's runtime as its side
     * effect kills that turn's MCP client (every later tool call
     * throws the SDK's `Not connected`). Observers skip the swap;
     * the next bound turn still swaps correctly on its own.
     */
    noSwap?: boolean;
  } = {},
): Promise<AgentRuntime> {
  // #99: a message that names its workbook binds to THAT file's live
  // session — never to the principal's most-recently-updated session
  // (the old pickActiveSession lottery across open files), and never
  // silently to the private host when the file has no live session.
  // #108: the session IS the turn's attached binding — no registry
  // lookup, no cached link. Absent binding → Unbound below.
  const fileId =
    typeof opts.fileId === 'string' && opts.fileId.length > 0 ? opts.fileId : null;
  let session: ResolvedAgentSession | null = null;
  if (fileId) {
    const binding = opts.binding ?? null;
    if (binding) {
      session = {
        fileId: binding.file,
        sessionId: binding.sid,
        engineUrl: binding.endpoint.replace(/\/+$/, ''),
        ownershipEpoch: binding.epoch,
        // The binding carries no creator: nothing on the agent path
        // reads creatorPrincipal (the host uses sessionId/fileId/
        // role/endpoint only).
        creatorPrincipal: '',
        role: binding.role,
        currentRevision: binding.rev,
        updatedAt: Date.now(),
      };
    }
  } else {
    try {
      session = await sessionResolverFor(deps)(principal);
    } catch (e) {
      // A broken registry must not take chat down: fall back to the
      // private host (fail-soft here; the registry itself fails closed
      // for OPENS, where a second copy would be the danger).
      console.warn(
        `[agent] session resolve failed for ${principal}: ${e instanceof Error ? e.message : String(e)} — using private host`,
      );
      session = null;
    }
  }
  const mint = deps.mintEngineToken ?? defaultMintEngineToken;
  if (session && mint(principal, session) === null) {
    console.warn(
      `[agent] session ${session.sessionId} found for ${principal} but no engine token can be minted (ENGINE_ACCESS_SECRET unset) — using private host`,
    );
    session = null;
  }
  if (fileId && !session) {
    // No live session on the named file (closed, released, or never
    // opened for this principal): refuse honestly at the handler
    // instead of answering from another workbook or the empty
    // private host (#99, #86).
    throw new AgentWorkbookUnboundError();
  }
  // FIX-G: the create_chart sink for this principal's runtimes. It
  // uses the turn's session (never another file's) and fails closed
  // when none is live — including for private-host runtimes, whose
  // MCP server then reports the honest error.
  const charts = createAgentChartSink({
    // #99: a file-bound turn's charts use the SAME session as the
    // turn itself, never the active-session lottery — otherwise a
    // chart would land in (or read from) a workbook the user is not
    // looking at.
    // #108: the turn's binding session, constant for the turn (no
    // re-resolution, no registry lookup). A mid-turn owner move
    // fails the chart attempt honestly; the NEXT turn carries a
    // fresh binding. The FIX-R4 retry below reuses this session.
    resolveSession: fileId
      ? async () => session
      : sessionResolverFor(deps),
    mintEngineToken: mint,
    ...(deps.engineFetch ? { fetchFn: deps.engineFetch } : {}),
  });
  // The cache key carries the ROLE as well as the session id: the
  // bound host's getAccessToken closure captures the resolved session,
  // so a principal whose role in the SAME session changes (viewer →
  // editor promotion, or the reverse) must rebuild the runtime or
  // their agent would keep minting tokens with the stale role.
  // #99 ruling: it also carries the ENGINE URL. A reclaim reuses the
  // session id on a NEW endpoint (registry ownerEndpoint moves); the
  // bound host captures its engineUrl at construction, so without the
  // endpoint in the key the agent would keep calling the stale
  // address after an owner move instead of rebuilding on the new one.
  const sessionKey = session
    ? `${session.sessionId}:${session.role}:${session.engineUrl}`
    : null;
  // #86: cache key — bound sessions share one entry per principal
  // (the remote host already enforces role, so the caller kind is
  // irrelevant there); the null-session case splits by caller kind
  // so chat turns get the write-refusing host while bridge/generate
  // keep the writable scratch host. Key equality implies sessionKey
  // equality by construction (bound keys embed the sessionKey; null
  // keys imply a null sessionKey).
  const cacheKey =
    sessionKey === null
      ? `${principal}\0private\0${opts.allowPrivateHostWrites ? 'w' : 'r'}`
      : `${principal}\0${sessionKey}`;
  const existing = runtimes.get(cacheKey);
  if (existing) return existing.rt;
  // Close stale entries for this principal whose SESSION differs
  // (session change, bound<->null transition) — the old single-entry
  // swap, generalized. Same-session other-mode entries coexist (no
  // churn, no parked-ask loss on chat/bridge alternation). The
  // watcher is dropped only on a genuine session change, as before.
  // #150: skipped for read-only observers (noSwap) — see the option.
  if (!opts.noSwap) {
    for (const [k, entry] of runtimes) {
      if (k.startsWith(`${principal}\0`) && entry.sessionKey !== sessionKey) {
        runtimes.delete(k);
        watchers.delete(principal);
        await entry.rt.close().catch(() => undefined);
      }
    }
  }
  const server = session
    ? createServer(
        new NodeRemoteEngineHost({
          engineUrl: session.engineUrl,
          principal,
          sessionId: session.sessionId,
          fileId: session.fileId,
          clientId: `agent:${principal}`,
          initialRevision: session.currentRevision,
          getAccessToken: () => mint(principal, session),
          // #99 v2 refinement (owner 2026-10-23 23:14) — PRIMARY
          // GATE: the agent's capability IS the user's resolved role
          // on this file (session.role). A viewer host refuses every
          // tool write BEFORE engine contact; the engine's per-call
          // token verification (#104) is the secondary gate behind it.
          readOnly: session.role !== 'editor',
          ...(deps.engineFetch ? { fetchFn: deps.engineFetch } : {}),
          // #108: no onLinkRefusal — there is no link to stale. An
          // engine refusal surfaces honestly through the tool call
          // on this turn; the NEXT turn carries a fresh binding.
        }),
        {
          hitlTimeoutMs: AGENT_HITL_TIMEOUT_MS,
          // Tools that omit an explicit principal act as this user on
          // their workbook (§3) instead of the anonymous MCP fallback.
          defaultPrincipal: principal,
          // §12 (FIX-J part 2): the MCP server's metadata stores
          // (long-term memory, pivot/report specs, pending asks) live
          // in the service metadata store — the same durable
          // file-backed persistence as the conversation threads.
          // Without this, MemoryStore defaults to per-instance
          // in-memory and saved facts die on every runtime swap.
          persistence: agentThreadPersistence(),
          // FIX-G: native chart creation sink (session-bound).
          charts,
          // Web research (internet data gathering): service-boundary
          // only (engine has no ambient network). Keys are server-side
          // only via process env.
          webResearch: { provider: getWebResearchProvider() },
        },
      )
    : createServer(opts.allowPrivateHostWrites ? undefined : new UnboundChatEngineHost(), {
        hitlTimeoutMs: AGENT_HITL_TIMEOUT_MS,
        // F-10: bind the caller's identity here too (as the session
        // branch above) — the runtime acts as this user, and a bound
        // identity makes any mismatched tool-arg principal a refusal
        // instead of a silent identity swap.
        defaultPrincipal: principal,
        // §12 (FIX-J part 2): durable metadata persistence, as above.
        persistence: agentThreadPersistence(),
        // FIX-G: sink resolves per call; no live session → fail closed.
        charts,
        webResearch: { provider: getWebResearchProvider() },
      });
  const loopAppGenerator = resolveLoopAppGenerator(deps);
  const rt = new AgentRuntime({
    server,
    principal,
    userId: principal,
    hitlTimeoutMs: AGENT_HITL_TIMEOUT_MS,
    maxIterations: AGENT_MAX_ITERATIONS,
    // §8: the backend re-resolves from the user's config on every plan(),
    // so switching providers (or rotating the key) takes effect without
    // tearing down the runtime or losing threads. A deps.modelBackend
    // override (tests) replaces that resolution outright.
    backend:
      deps.modelBackend === undefined
        ? new DelegatingModelBackend(() => resolveBackend(principal))
        : (deps.modelBackend ?? new NoModelConfiguredBackend()),
    // §9 (Cycle-3 GAP-4): conversation threads read-through/write-through
    // the file-backed metadata store per userId, so deployed threads
    // survive restarts.
    threadPersistence: agentThreadPersistence(),
    // Workflows (agent-workflows.md §2.4): the plan + checkpoint persist
    // in the same durable store, so an interrupted job resumes from its
    // last completed step after a restart — never from zero.
    workflowPersistence: agentThreadPersistence(),
    // #141: the loop's generate_app tool persists through the same
    // store + generator as the /artifacts/generate route. A null
    // generator (explicitly unconfigured) leaves appGenerator absent
    // so the tool fails honestly instead of guessing.
    artifactStore: agentArtifactStore(),
    ...(loopAppGenerator ? { appGenerator: loopAppGenerator } : {}),
  });
  runtimes.set(cacheKey, { rt, sessionKey });
  return rt;
}

// -- proactive watches (ai-agent.md §6) ------------------------------------
// One ProactiveWatcher per principal, wired to that principal's runtime:
// subscriptions still cross the MCP protocol boundary (runtime.watch /
// pollWatch / unwatch); the watcher adds batching, rate-limiting, the
// agent-decides hook, and persisted per-user mute.
const mutePersistence: Persistence = memoryPersistence();
const watchers = new Map<string, ProactiveWatcher>();
async function watcherFor(
  principal: string,
  deps: AgentServiceDeps = {},
): Promise<ProactiveWatcher> {
  let w = watchers.get(principal);
  if (!w) {
    const rt = await runtimeFor(principal, deps);
    w = new ProactiveWatcher(
      {
        subscribe: (events, sheet) => rt.watch(events, sheet),
        poll: async (subscriptionId, maxEvents) => {
          const events = await rt.pollWatch(subscriptionId, maxEvents);
          return events.map(
            (e): ProactiveEvent => ({
              seq: e.seq,
              ts: e.ts,
              type: e.type as ProactiveEventType,
              detail: e.detail,
            }),
          );
        },
        unsubscribe: (subscriptionId) => rt.unwatch(subscriptionId),
        mutePersistence,
      },
    );
    watchers.set(principal, w);
  }
  return w;
}

export interface AgentServiceDeps {
  /**
   * Dictation backend for POST /transcribe. `undefined` (the default)
   * builds one from the environment — GCP_PROJECT_ID (or
   * GOOGLE_CLOUD_PROJECT), a GCP credential chain
   * (GOOGLE_APPLICATION_CREDENTIALS locally, the metadata server when
   * deployed), VERTEX_STT_MODEL as the model override. `null` disables
   * dictation (the route answers 503).
   */
  transcriber?: Transcriber | null;
  /**
   * FIX-E app generator for POST /artifacts/generate. `undefined` (the
   * default) builds the Vertex AI LLM generator from the environment
   * (GCP_PROJECT_ID, the vertexToken credential chain) and the route
   * answers 503 when no GCP token is available. `null` disables
   * generation (503). Tests inject a stub generator here.
   */
  appGenerator?: AppGenerator | null;
  /**
   * F1 session resolver override (tests). `undefined` (the default)
   * resolves the principal's active session from the on-disk session
   * ownership registry on every runtime lookup.
   */
  resolveSession?: (principal: string) => Promise<ResolvedAgentSession | null>;
  /**
   * The session ownership registry the LEGACY no-fileId resolver
   * enumerates (listAll) when no resolveSession override is given —
   * the production wiring: in prod the registry is Firestore-backed
   * and there is no on-disk registry file for the default resolver
   * to read. `undefined` keeps the on-disk default (local topology).
   * #108: file-bound turns NEVER touch this — their binding comes
   * attached by the gateway (x-agent-binding), verified, not
   * resolved. The registry stays only for the legacy paths
   * (MCP-direct, threads, /workflow, /audit, /pending, /tools/call).
   */
  fileRegistry?: FileRegistry;
  /**
   * F1 engine-token minter override (tests). `undefined` (the default)
   * signs with the deploy/engineAccess signer over
   * ENGINE_ACCESS_SECRET (role = the resolved session role for the
   * principal, 120 s, re-minted per engine request). Return null to
   * disable binding (private-host fallback).
   */
  mintEngineToken?: (principal: string, session: ResolvedAgentSession) => string | null;
  /** F1 engine fetch override (tests), passed to the remote host. */
  engineFetch?: RemoteEngineFetch;
  /**
   * #137: model backend override (tests). `undefined` (the default)
   * resolves per plan() via selectBackend (Vertex, env model, or the
   * no-model backend). A backend here is used directly (no delegation);
   * `null` means explicitly no model (the no-model backend). Tests
   * inject a stub planner here so binding tests can prove engine
   * routing without a live model.
   */
  modelBackend?: ModelBackend | null;
}

let envTranscriber: Transcriber | null | undefined;
function defaultTranscriber(): Transcriber | null {
  if (envTranscriber !== undefined) return envTranscriber;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  envTranscriber = project
    ? new VertexTranscriber({
        project,
        ...(process.env.VERTEX_STT_MODEL ? { model: process.env.VERTEX_STT_MODEL } : {}),
        getAccessToken: createGcpAccessTokenProvider(process.env),
      })
    : null;
  return envTranscriber;
}

export function createAgentListener(deps: AgentServiceDeps = {}): RequestListener {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (handlePreflight(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://agent');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const principal = requestPrincipal(req);

    try {
      if (path === '/health' && method === 'GET') {
        return sendJson(res, 200, { ok: true, service: 'agent' });
      }

      if (path === '/message' && method === 'POST') {
        const body = (await readBody(req)) as
          | { threadId?: unknown; text?: unknown; kind?: unknown; fileId?: unknown; sheet?: unknown }
          | undefined;
        if (typeof body?.text !== 'string' || body.text.length === 0) {
          return sendError(res, 400, '{ text: string } required');
        }
        const threadId =
          typeof body.threadId === 'string' && body.threadId.length > 0 ? body.threadId : randomUUID();
        // #99: the panel's open file, when named — binding failure
        // answers honestly instead of reading another workbook.
        const fileId = parseMessageFileId(body);
        if (fileId === null) {
          return sendError(res, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
        }
        let rt: AgentRuntime;
        try {
          // #108: the turn's binding comes attached by the gateway —
          // verified here, never resolved from the registry.
          rt = await runtimeFor(principal, deps, {
            fileId,
            binding: fileId !== undefined ? attachedBinding(req, principal, fileId) : null,
          });
        } catch (e) {
          if (e instanceof AgentWorkbookUnboundError) {
            return sendJson(res, 200, {
              threadId,
              message: AGENT_WORKBOOK_UNBOUND_MESSAGE,
              needsInput: null,
              audit: [],
              workflow: null,
              chart: null,
            });
          }
          throw e;
        }
        // Human-in-the-loop answers resume a paused turn (ai-agent.md §12);
        // everything else starts a new chat turn. #135: the client's
        // active sheet rides the turn so sheet-less data access reads
        // the sheet the user is on (absent = first-sheet fallback).
        const turnSheet =
          typeof body.sheet === 'string' && body.sheet.length > 0 && body.sheet.length <= 256
            ? body.sheet
            : undefined;
        const reply =
          body.kind === 'answer'
            ? await rt.answer(threadId, body.text)
            : await rt.chat(
                threadId,
                body.text,
                ...(turnSheet ? [{ sheet: turnSheet } as const] : []),
              );
        return sendJson(res, 200, {
          threadId,
          message: reply.message,
          needsInput: reply.needsInput
            ? { prompt: reply.needsInput.question, options: reply.needsInput.options ?? [] }
            : null,
          audit: rt.getAuditLog(threadId),
          // Workflow summary (agent-workflows.md §2.5): present when the
          // turn engaged the workflow layer; the step-by-step event
          // stream rides the audit trail as kind 'workflow' entries,
          // and the full record is at GET /workflow.
          workflow: reply.workflow ?? null,
          // RESOLVED 2026-10-18: the agent's chart attachment travels
          // through the gateway as plain versioned JSON (ChartSpec-derived
          // Chart.js config) — no binary encoding. Dropped before; the
          // client never saw analysis charts via the gateway.
          chart: reply.chart ?? null,
          // #141: the app a loop turn built travels the same way, so
          // the panel can store it (Apps tab) and render it on click.
          artifact: reply.artifact ?? null,
          // #138: same forwarding for a loop-built diagram spec.
          diagram: reply.diagram ?? null,
        });
      }

      // #40 streaming twin of /message: Server-Sent Events carrying the
      // turn's genuine increments (thinking / thought / tool activity)
      // as they happen, then one 'done' event with the same payload
      // /message returns. The answer text rides 'done' atomically —
      // the planner produces whole outputs (see AgentTurnEvent). A
      // client disconnect sets the cooperative cancel hook; the
      // runtime stops at the next step boundary. Mid-stream failures
      // send an 'error' event in plain language and close.
      if (path === '/message/stream' && method === 'POST') {
        const body = (await readBody(req)) as
          | { threadId?: unknown; text?: unknown; kind?: unknown; fileId?: unknown; sheet?: unknown }
          | undefined;
        if (typeof body?.text !== 'string' || body.text.length === 0) {
          return sendError(res, 400, '{ text: string } required');
        }
        const threadId =
          typeof body.threadId === 'string' && body.threadId.length > 0 ? body.threadId : randomUUID();
        // #99: same file binding + honest unbound reply as /message.
        // runtimeFor runs before writeHead, so the unbound case can
        // still answer with a normal 'done' event the panel renders.
        const fileId = parseMessageFileId(body);
        if (fileId === null) {
          return sendError(res, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
        }
        let rt: AgentRuntime;
        try {
          // #108: the turn's binding comes attached by the gateway —
          // verified here, never resolved from the registry.
          rt = await runtimeFor(principal, deps, {
            fileId,
            binding: fileId !== undefined ? attachedBinding(req, principal, fileId) : null,
          });
        } catch (e) {
          if (e instanceof AgentWorkbookUnboundError) {
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            });
            res.write(
              `event: done\ndata: ${JSON.stringify({
                threadId,
                message: AGENT_WORKBOOK_UNBOUND_MESSAGE,
                needsInput: null,
                audit: [],
                workflow: null,
                chart: null,
              })}\n\n`,
            );
            res.end();
            return;
          }
          throw e;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let cancelled = false;
        let closed = false;
        const send = (event: string, data: unknown): void => {
          if (closed || res.writableEnded) return;
          try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch {
            closed = true;
          }
        };
        // ServerResponse 'close' = the connection went away (or the
        // response finished — by then the flag is moot).
        res.on('close', () => {
          cancelled = true;
          closed = true;
        });
        try {
          const reply =
            body.kind === 'answer'
              ? await rt.answer(threadId, body.text)
              : await rt.chat(threadId, body.text, {
                  onEvent: (e) => send('turn', e),
                  isCancelled: () => cancelled,
                  // #135: same active-sheet turn context as /message.
                  ...(typeof body.sheet === 'string' && body.sheet.length > 0 && body.sheet.length <= 256
                    ? { sheet: body.sheet }
                    : {}),
                });
          send('done', {
            threadId,
            message: reply.message,
            needsInput: reply.needsInput
              ? { prompt: reply.needsInput.question, options: reply.needsInput.options ?? [] }
              : null,
            audit: rt.getAuditLog(threadId),
            // Workflow summary + step events ride the same channels as
            // /message (agent-workflows.md §2.5): summary here, step
            // events in the audit trail.
            workflow: reply.workflow ?? null,
            chart: reply.chart ?? null,
            // #141: same artifact forwarding as /message above.
            artifact: reply.artifact ?? null,
            // #138: same diagram forwarding as /message above.
            diagram: reply.diagram ?? null,
          });
        } catch (e) {
          send('error', {
            message:
              'Something went wrong while the agent was working. What you see above is as far as it got — please try again.',
            detail: e instanceof Error ? e.message : String(e),
          });
        } finally {
          if (!res.writableEnded) res.end();
        }
        return;
      }

      // Workflow record (agent-workflows.md §2.4/§2.5): the thread's
      // current job — plan, per-step state, checkpoint — for the chat
      // UI's progress region and for resume affordances.
      if (path === '/workflow' && method === 'GET') {
        const threadId = url.searchParams.get('threadId') ?? '';
        if (threadId.length === 0) return sendError(res, 400, '?threadId= is required');
        // #150: observer — never swaps (see runtimeFor noSwap).
        const rt = await runtimeFor(principal, deps, { noSwap: true });
        return sendJson(res, 200, { workflow: rt.getWorkflow(threadId) });
      }

      if (path === '/audit' && method === 'GET') {
        const threadId = url.searchParams.get('threadId') ?? '';
        if (threadId.length === 0) return sendError(res, 400, '?threadId= is required');
        // #150: observer — never swaps (see runtimeFor noSwap).
        const rt = await runtimeFor(principal, deps, { noSwap: true });
        return sendJson(res, 200, { audit: rt.getAuditLog(threadId) });
      }

      // Chat thread history per fileId (one persistent thread per
      // spreadsheet). Threads live in the runtime's threadPersistence
      // (Firestore prod, filePersistence locally) — the agent service
      // IS the history backend. Read-only observers (noSwap).
      if (path === '/threads' && method === 'GET') {
        const rt = await runtimeFor(principal, deps, { noSwap: true });
        const threads = rt.getThreads();
        return sendJson(res, 200, { threads });
      }
      if (path.startsWith('/threads/') && method === 'GET') {
        const threadId = decodeURIComponent(path.slice('/threads/'.length));
        if (!threadId) return sendError(res, 400, 'threadId is required');
        const rt = await runtimeFor(principal, deps, { noSwap: true });
        const history = rt.getHistory(threadId);
        // Map AgentMessage to {role, text} for the web client (only
        // user/agent turns are surfaced — never system messages).
        const messages = history
          .filter((m) => m.role === 'user' || m.role === 'agent')
          .map((m) => ({ role: m.role, text: m.text }));
        return sendJson(res, 200, { threadId, messages });
      }

      // Human-in-the-loop surface (ai-agent.md §12): while a /message turn
      // is parked on an agent.* tool call, the UI polls /pending and
      // answers via /answer. Both delegate to the runtime's versioned MCP
      // tools — the gateway holds no parallel pause state.
      // #150: /pending is polled every 2s while the panel is open, so
      // it MUST NOT swap: pre-fix, each poll closed the in-flight
      // turn's runtime (null resolution in a registry-less process)
      // and every later tool call threw `Not connected`.
      // /answer is deliberately NOT noSwap: it resumes a specific
      // parked turn and needs that turn's runtime (separate residual).
      if (path === '/pending' && method === 'GET') {
        const rt = await runtimeFor(principal, deps, { noSwap: true });
        return sendJson(res, 200, { asks: await rt.listPendingAsks() });
      }

      if (path === '/answer' && method === 'POST') {
        const body = (await readBody(req)) as
          | { askId?: unknown; answer?: unknown; note?: unknown }
          | undefined;
        if (typeof body?.askId !== 'string' || typeof body?.answer !== 'string') {
          return sendError(res, 400, '{ askId: string, answer: string } required');
        }
        const note = typeof body.note === 'string' ? body.note : undefined;
        const rt = await runtimeFor(principal, deps);
        try {
          await rt.answerPendingAsk(body.askId, body.answer, note);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/unknown pending ask/i.test(msg)) {
            // W4: the ask was already answered, timed out, or withdrawn
            // (e.g. suppressed at the runtime's grounding gate and
            // consumed). Answering it is a clean no-op — never an error
            // the client retries into a fresh turn.
            return sendJson(res, 200, { ok: true, note: 'That ask was already resolved.' });
          }
          const status = /denied|not authorized/i.test(msg) ? 403 : 400;
          return sendError(res, status, msg);
        }
        return sendJson(res, 200, { ok: true });
      }

      // Proactive watches (ai-agent.md §6).
      if (path === '/watch' && method === 'POST') {
        const body = (await readBody(req)) as { events?: unknown; sheet?: unknown } | undefined;
        const events = Array.isArray(body?.events)
          ? body.events.filter((e): e is ProactiveEventType => typeof e === 'string' && isProactiveEventType(e))
          : (['cells_changed', 'recalc_complete'] as ProactiveEventType[]);
        const sheet = typeof body?.sheet === 'string' && body.sheet.length > 0 ? body.sheet : undefined;
        try {
          const watchId = await (await watcherFor(principal, deps)).startWatch(principal, { events, sheet });
          return sendJson(res, 200, { watchId });
        } catch (e) {
          return sendError(res, 400, e instanceof Error ? e.message : String(e));
        }
      }

      if (path === '/watch/poll' && method === 'GET') {
        const watchId = url.searchParams.get('watchId') ?? '';
        if (watchId.length === 0) return sendError(res, 400, '?watchId= is required');
        return sendJson(res, 200, { wakes: (await watcherFor(principal, deps)).pollWakes(watchId) });
      }

      if (path === '/watch/stop' && method === 'POST') {
        const body = (await readBody(req)) as { watchId?: unknown } | undefined;
        if (typeof body?.watchId !== 'string' || body.watchId.length === 0) {
          return sendError(res, 400, '{ watchId: string } required');
        }
        const ok = await (await watcherFor(principal, deps)).stopWatch(body.watchId);
        return sendJson(res, 200, { ok });
      }

      // Proactive mute (ai-agent.md §6): whole-thing toggle + per-category,
      // per user, persisted in the service metadata store.
      if (path === '/watch/mute' && method === 'GET') {
        return sendJson(res, 200, (await watcherFor(principal, deps)).getMuteConfig(principal));
      }

      if (path === '/watch/mute' && method === 'POST') {
        const body = (await readBody(req)) as { mutedAll?: unknown; muted?: unknown } | undefined;
        const patch: {
          mutedAll?: boolean;
          muted?: Partial<Record<ProactiveEventType, boolean>>;
        } = {};
        if (typeof body?.mutedAll === 'boolean') patch.mutedAll = body.mutedAll;
        if (body?.muted && typeof body.muted === 'object') {
          const m: Partial<Record<ProactiveEventType, boolean>> = {};
          for (const [k, v] of Object.entries(body.muted as Record<string, unknown>)) {
            if (isProactiveEventType(k) && typeof v === 'boolean') m[k] = v;
          }
          patch.muted = m;
        }
        return sendJson(res, 200, (await watcherFor(principal, deps)).setMuteConfig(principal, patch));
      }

      // Model backend selection (ai-agent.md §8). GET never returns the key.
      if (path === '/config' && method === 'GET') {
        return sendJson(res, 200, describeConfig(principal));
      }

      if (path === '/config' && method === 'POST') {
        const body = (await readBody(req)) as
          | { provider?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown }
          | undefined;
        if (typeof body?.provider !== 'string' || !isModelProviderId(body.provider)) {
          return sendError(res, 400, "{ provider: 'vertex' | 'openai-compatible' } required");
        }
        const provider = body.provider;
        const prev = configStore.get(principal).model;
        const baseUrl =
          typeof body.baseUrl === 'string' && body.baseUrl.length > 0 ? body.baseUrl : prev.baseUrl;
        if (provider === 'openai-compatible') {
          if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
            return sendError(res, 400, 'openai-compatible provider needs a valid http(s) baseUrl');
          }
        } else if (baseUrl !== undefined && !/^https?:\/\//i.test(baseUrl)) {
          return sendError(res, 400, 'baseUrl must be an http(s) URL');
        }
        const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : prev.model;
        let keyRef = prev.keyRef;
        const vault = await agentVault(principal);
        if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
          // The secret goes to the vault; the config keeps only the ref.
          const ref = modelKeyRef(principal);
          try {
            await vault.store(ref, body.apiKey, principal);
          } catch (e) {
            return sendError(res, 403, e instanceof Error ? e.message : String(e));
          }
          keyRef = ref;
        } else if (body.apiKey === null && keyRef) {
          try {
            await vault.revoke(keyRef, principal);
          } catch {
            // Already gone — treat as revoked.
          }
          keyRef = undefined;
        }
        configStore.save(principal, {
          model: {
            provider,
            ...(baseUrl !== undefined ? { baseUrl } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(keyRef !== undefined ? { keyRef } : {}),
          },
        });
        return sendJson(res, 200, describeConfig(principal));
      }

      // Dictation for the voice command palette (cheapest Gemini on
      // Vertex AI — see the header). The audio clip is short dictation;
      // the body cap allows ~30s of compressed audio as base64.
      if (path === '/transcribe' && method === 'POST') {
        const transcriber =
          deps.transcriber !== undefined ? deps.transcriber : defaultTranscriber();
        if (!transcriber) {
          return sendError(
            res,
            503,
            'dictation is not configured on this service (GCP_PROJECT_ID and GCP credentials are required)',
          );
        }
        let body: { audioBase64?: unknown; mimeType?: unknown } | undefined;
        try {
          body = (await readBody(req, 4 * 1024 * 1024)) as typeof body;
        } catch (e) {
          if ((e as { code?: string }).code === 'BODY_TOO_LARGE') {
            return sendError(res, 413, 'audio clip too large — keep dictation under ~30 seconds');
          }
          throw e;
        }
        if (
          typeof body?.audioBase64 !== 'string' ||
          body.audioBase64.length === 0 ||
          typeof body?.mimeType !== 'string' ||
          !body.mimeType.startsWith('audio/')
        ) {
          return sendError(res, 400, '{ audioBase64: string, mimeType: "audio/*" } required');
        }
        try {
          const text = await transcriber.transcribe({
            dataBase64: body.audioBase64,
            mimeType: body.mimeType,
          });
          return sendJson(res, 200, { ok: true, text, model: transcriber.modelId });
        } catch (e) {
          return sendError(res, 502, e instanceof Error ? e.message : String(e));
        }
      }

      // Generated apps, generation lane (FIX-E): in gateway mode the
      // browser holds no in-process MCP server, so generation runs
      // here — the same flow the web app-generation port runs locally
      // (generateAndSaveArtifact via the runtime: input cap, audit,
      // MCP-only data access), with the LLM generator on Vertex AI.
      // Fail closed with NO GCP credentials — no template fallback on
      // this route (the template generator remains the local default
      // where it already existed).
      // #142: list the caller's server-saved apps. The panel's Apps
      // tab lists its local store; apps saved server-side without
      // panel involvement (direct route calls, another tab/device)
      // never reach it — so the panel merges this list into its
      // store when the Apps tab opens. Principal-filtered: a caller
      // never sees another user's apps.
      if (path === '/artifacts' && method === 'GET') {
        const all = agentArtifactStore().all();
        const mine = all.filter((spec) => spec.principal === principal);
        return sendJson(res, 200, { artifacts: mine });
      }
      if (path === '/artifacts/generate' && method === 'POST') {
        const body = (await readBody(req)) as
          | { prompt?: unknown; sheet?: unknown; threadId?: unknown; fileId?: unknown }
          | undefined;
        if (typeof body?.prompt !== 'string' || body.prompt.length === 0) {
          return sendError(res, 400, '{ prompt: string } required');
        }
        // #99 ruling: a generation that names its workbook binds to
        // THAT file's live session, like a chat turn — never to the
        // active-session lottery, and never silently to the private
        // host. An unbound file is a 409 with the honest message.
        const fileId = parseMessageFileId(body);
        if (fileId === null) {
          return sendError(res, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
        }
        let generator: AppGenerator | null =
          deps.appGenerator === undefined ? defaultAppGenerator() : deps.appGenerator;
        if (generator === null) {
          return sendError(res, 503, 'App generation is not configured on this service.');
        }
        if (deps.appGenerator === undefined) {
          // #137: an environment-configured model (e.g. Groq) covers
          // codegen locally — when present it replaces the Vertex
          // generator and the GCP token gate does not apply (the env
          // backend carries its own key, read at call time).
          const envGen = createEnvCodeGenBackend();
          if (envGen) {
            generator = new LlmAppGenerator({ backend: envGen });
          } else {
            const token = await agentAppTokenProvider()();
            if (!token) {
              return sendError(
                res,
                503,
                'App generation is not configured on this service: no GCP credentials are ' +
                  'available (set GOOGLE_APPLICATION_CREDENTIALS for the agent service, or ' +
                  'run it under a GCP service account).',
              );
            }
          }
        }
        const threadId =
          typeof body.threadId === 'string' && body.threadId.length > 0
            ? body.threadId
            : randomUUID();
        let rt: AgentRuntime;
        try {
          // #108: same attached-binding rule as chat turns.
          // #86: generate shares the bridge's writable private host
          // (it reads the app data the bridge seeded there).
          rt = await runtimeFor(principal, deps, {
            fileId,
            binding: fileId !== undefined ? attachedBinding(req, principal, fileId) : null,
            allowPrivateHostWrites: true,
          });
        } catch (e) {
          if (e instanceof AgentWorkbookUnboundError) {
            return sendError(res, 409, AGENT_WORKBOOK_UNBOUND_MESSAGE);
          }
          throw e;
        }
        try {
          const result = await rt.createAppArtifact(threadId, body.prompt, {
            store: agentArtifactStore(),
            ...(typeof body.sheet === 'string' && body.sheet.length > 0
              ? { sheet: body.sheet }
              : {}),
            generator,
            template: detectTemplate(body.prompt),
          });
          return sendJson(res, 200, { result });
        } catch (e) {
          // #64: a sheet that does not exist is a user-caused bad
          // reference — a clean 404 with the plain-language message,
          // never a 502. Every other generation failure keeps the 502.
          if (e instanceof SheetNotFoundError) {
            return sendError(res, 404, e.message);
          }
          return sendError(res, 502, e instanceof Error ? e.message : String(e));
        }
      }

      // Generated apps, runtime lane (FIX-E): a generated app running
      // in the browser reaches MCP tools through here. The allowlist
      // is enforced SERVER-SIDE against the same list the artifact
      // bridge protocol defines (ALLOWED_BRIDGE_TOOLS) — agent.* HITL
      // tools, execute_code, memory administration and everything
      // else are refused with 403.
      if (path === '/tools/call' && method === 'POST') {
        const body = (await readBody(req)) as
          | { tool?: unknown; args?: unknown; fileId?: unknown }
          | undefined;
        if (typeof body?.tool !== 'string' || body.tool.length === 0) {
          return sendError(res, 400, '{ tool: string, args?: object } required');
        }
        if (!(ALLOWED_BRIDGE_TOOLS as readonly string[]).includes(body.tool)) {
          return sendError(res, 403, `tool "${body.tool}" is not available to generated apps`);
        }
        const args = (
          typeof body.args === 'object' && body.args !== null ? body.args : {}
        ) as Record<string, unknown>;
        // #150: a bridge call that names its workbook binds to THAT
        // file's live session via the gateway-attached binding (the
        // gateway proxy already attaches one for /api/agent POSTs
        // carrying fileId — no gateway change needed). Without it the
        // bridge resolved to the private scratch host in prod (no
        // registry there): app reads returned null (leg3) and app
        // generation read an empty scratch 'Sheet1' (leg4b).
        // #86: the fileId-less bridge keeps the writable private host
        // — app data lives there by design (pinned by the artifact
        // seed test). A NAMED file with no valid binding is a 409,
        // never a silent private-host answer (#99).
        const bridgeFileId = parseMessageFileId(body);
        if (bridgeFileId === null) {
          return sendError(res, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
        }
        let rt: AgentRuntime;
        try {
          rt = await runtimeFor(principal, deps, {
            ...(bridgeFileId !== undefined
              ? {
                  fileId: bridgeFileId,
                  binding: attachedBinding(req, principal, bridgeFileId),
                }
              : {}),
            allowPrivateHostWrites: true,
          });
        } catch (e) {
          if (e instanceof AgentWorkbookUnboundError) {
            return sendError(res, 409, AGENT_WORKBOOK_UNBOUND_MESSAGE);
          }
          throw e;
        }
        try {
          const data = await rt.callTool(body.tool, args);
          return sendJson(res, 200, { data });
        } catch (e) {
          return sendError(res, 502, e instanceof Error ? e.message : String(e));
        }
      }

      return sendError(res, 404, `not found: ${path}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return sendError(res, 500, `agent error: ${msg}`);
    }
  };
}
