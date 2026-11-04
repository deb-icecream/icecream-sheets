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
import type { RequestListener } from 'node:http';
import { type AppGenerator, type Transcriber } from '@icecream-sheets/service';
import { type ChartSink } from '@icecream-sheets/mcp-server';
import { type ResolvedAgentSession } from './agentSessionResolver.js';
import type { FileRegistry } from '../deploy/fileRegistry.js';
import { type RemoteEngineFetch } from './remoteEngineHost.js';
/**
 * FIX-G chart sink (trace §4.1a/§4.2): the create_chart delivery for
 * session-bound runtimes. On each call it re-resolves the principal's
 * live engine session (the same resolver runtimeFor binds with), mints
 * a fresh engine-access token for it (the same minter the remote host
 * uses — short-lived, role = the user's session role), and POSTs the
 * spec to the owning
 * engine's /charts endpoint. No live session (or no token) → the call
 * FAILS CLOSED with the tool's honest error: the agent's private-host
 * fallback has no workbook session to author a native chart into.
 * FIX-R4: a transient fresh-session refusal (400 'unknown sheet' / 409)
 * is retried ONCE after a re-resolve — see addChart.
 */
export interface AgentChartSinkDeps {
    resolveSession: (principal: string) => Promise<ResolvedAgentSession | null>;
    mintEngineToken: (principal: string, session: ResolvedAgentSession) => string | null;
    /** Engine fetch override (tests). Default: global fetch. */
    fetchFn?: RemoteEngineFetch;
    /** FIX-R4 transient-retry delay override (tests). Default 2000 ms. */
    retryDelayMs?: number;
}
export declare function createAgentChartSink(deps: AgentChartSinkDeps): ChartSink;
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
     * The session ownership registry the default resolver enumerates
     * (listAll) when no resolveSession override is given — the
     * production wiring: in prod the registry is Firestore-backed and
     * there is no on-disk registry file for the default resolver to
     * read. `undefined` keeps the on-disk default (local topology).
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
}
export declare function createAgentListener(deps?: AgentServiceDeps): RequestListener;
