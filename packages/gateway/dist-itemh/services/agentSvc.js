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
import { ALLOWED_BRIDGE_TOOLS, AgentRuntime, CredentialVault, DelegatingModelBackend, KeyManager, LlmAppGenerator, ProactiveWatcher, VERTEX_DEFAULT_LOCATION, VERTEX_DEFAULT_MODEL, VertexAiCodeGenBackend, createArtifactStore, createModelBackend, detectTemplate, isModelProviderId, isProactiveEventType, memoryPersistence, modelKeyRef, AgentConfigStore, VertexTranscriber, } from '@icecream-sheets/service';
import { createServer } from '@icecream-sheets/mcp-server';
import { handlePreflight, readBody, requestPrincipal, sendError, sendJson } from '../httpUtils.js';
import { filePersistence, gatewayDataDir } from '../filePersistence.js';
import { createGcpAccessTokenProvider } from './vertexToken.js';
import { engineAccessSecret, issueEngineAccessToken, } from '../deploy/engineAccess.js';
import { createAgentSessionResolver, } from './agentSessionResolver.js';
import { NodeRemoteEngineHost, } from './remoteEngineHost.js';
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
 * Engine-access tokens for a bound agent host: SHORT-lived (2 min) and
 * re-minted on every engine request by the host's getAccessToken
 * callback — never cached, never logged. Role is always 'editor': the
 * agent acts as the user (§3), and the user's own session role was
 * already established when they opened the file; a viewer-only binding
 * is a future refinement (the engine would reject its /ops visibly).
 */
const AGENT_ENGINE_TOKEN_TTL_SECONDS = 120;
/**
 * Runtime cache, keyed by principal; each entry also records the
 * session it is bound to (sessionId, or null for the private-host
 * fallback). A changed resolution replaces the entry (see runtimeFor).
 */
const runtimes = new Map();
/** Default resolver: the on-disk session ownership registry (F1). */
const defaultSessionResolver = createAgentSessionResolver();
/**
 * Default token minter: the deploy/engineAccess signer over
 * ENGINE_ACCESS_SECRET (the agent process carries it in its env,
 * inherited from its launcher — bin/agent.ts and the combined
 * servicePackage.ts pass process.env through untouched). Returns null
 * when no secret is configured: binding then stays OFF and the
 * private-host fallback is preserved, because an unsigned host could
 * not authenticate to a signed-mode engine anyway.
 */
function defaultMintEngineToken(principal, session) {
    const secret = engineAccessSecret();
    if (!secret)
        return null;
    return issueEngineAccessToken({
        secret,
        principal,
        sessionId: session.sessionId,
        fid: session.fileId,
        role: 'editor',
        tier: 'standard',
        ttlSeconds: AGENT_ENGINE_TOKEN_TTL_SECONDS,
    }).token;
}
export function createAgentChartSink(deps) {
    const fetchFn = deps.fetchFn ?? fetch;
    return {
        async addChart(spec, principal) {
            let session = null;
            try {
                session = await deps.resolveSession(principal);
            }
            catch {
                session = null;
            }
            if (!session) {
                throw new Error('chart creation is not available in this session');
            }
            const token = deps.mintEngineToken(principal, session);
            const headers = { 'content-type': 'application/json' };
            if (token)
                headers['authorization'] = `Bearer ${token}`;
            else
                headers['x-principal'] = principal;
            const res = await fetchFn(`${session.engineUrl.replace(/\/+$/, '')}/charts`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ spec }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`engine /charts failed: HTTP ${res.status} ${text.slice(0, 200)}`);
            }
            const json = (await res.json());
            return { id: json.id ?? spec.id, revision: json.revision ?? 0 };
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
let threadPersistence = null;
function agentThreadPersistence() {
    if (!threadPersistence)
        threadPersistence = filePersistence(gatewayDataDir());
    return threadPersistence;
}
/**
 * FIX-E: the artifact store generated apps persist into on this
 * service — the service metadata store over the same file-backed
 * persistence as the conversation threads.
 */
let artifactStoreSingleton = null;
function agentArtifactStore() {
    if (!artifactStoreSingleton) {
        artifactStoreSingleton = createArtifactStore(agentThreadPersistence());
    }
    return artifactStoreSingleton;
}
/** FIX-E: lazily-built GCP token provider for Vertex AI app generation. */
let appTokenProvider = null;
function agentAppTokenProvider() {
    if (!appTokenProvider)
        appTokenProvider = createGcpAccessTokenProvider(process.env);
    return appTokenProvider;
}
/** FIX-E: the default app generator — LLM generation on Vertex AI. */
function defaultAppGenerator() {
    return new LlmAppGenerator({
        backend: new VertexAiCodeGenBackend({
            project: process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? 'dreamscapes-zero',
            location: VERTEX_DEFAULT_LOCATION,
            model: VERTEX_DEFAULT_MODEL,
            getAccessToken: agentAppTokenProvider(),
        }),
    });
}
// -- agent service state (ai-agent.md §§6, 8, 9) ---------------------------
// Per-user agent settings (model provider selection) persist in the
// service metadata store (in-memory here; prod backs this with the metadata
// store backend). API keys live in the service credential vault under
// per-user refs — never in the config, never in logs.
const configPersistence = memoryPersistence();
const configStore = new AgentConfigStore(configPersistence);
// Credential vault for agent model API keys. Refs are namespaced
// `agent:<principal>:`; each principal's vault instance pins its check to
// its own namespace (fail closed otherwise).
const vaultPersistence = memoryPersistence();
const vaultKeys = new KeyManager(memoryPersistence());
const vaults = new Map();
function agentVault(principal) {
    let p = vaults.get(principal);
    if (!p) {
        const prefix = `agent:${principal}:`;
        p = CredentialVault.create(vaultPersistence, vaultKeys, {
            check: (_action, target) => target.startsWith(prefix),
        });
        p.catch(() => {
            if (vaults.get(principal) === p)
                vaults.delete(principal);
        });
        vaults.set(principal, p);
    }
    return p;
}
/** Build the ModelBackend for the user's current config (§8). */
async function resolveBackend(principal) {
    const config = configStore.get(principal);
    const vault = await agentVault(principal);
    return createModelBackend({ config, vault, principal });
}
/**
 * Session-aware runtime resolution (FIX-B / F1).
 *
 * On every call the principal's ACTIVE session is re-resolved from the
 * registry. Outcomes:
 * - A live session (and a token minter that can sign for it): the
 *   runtime's MCP server wraps a NodeRemoteEngineHost bound to THAT
 *   session on its owning engine instance — the agent reads/writes the
 *   very workbook the user has open, through MCP tools only (§§2–3).
 * - No session / resolver failure / no signing secret: the runtime is
 *   built with createServer(undefined) — the per-principal private
 *   EngineHost, exactly the pre-F1 behavior (existing tests and the
 *   no-workbook-open case are preserved).
 *
 * Runtimes are cached by principal+sessionId: when the resolved
 * session CHANGES (opened a different file, session released, first
 * open after a private period) the old runtime is closed (rt.close())
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
async function runtimeFor(principal, deps = {}) {
    let session = null;
    try {
        session = await (deps.resolveSession ?? defaultSessionResolver)(principal);
    }
    catch (e) {
        // A broken registry must not take chat down: fall back to the
        // private host (fail-soft here; the registry itself fails closed
        // for OPENS, where a second copy would be the danger).
        console.warn(`[agent] session resolve failed for ${principal}: ${e instanceof Error ? e.message : String(e)} — using private host`);
        session = null;
    }
    const mint = deps.mintEngineToken ?? defaultMintEngineToken;
    if (session && mint(principal, session) === null) {
        console.warn(`[agent] session ${session.sessionId} found for ${principal} but no engine token can be minted (ENGINE_ACCESS_SECRET unset) — using private host`);
        session = null;
    }
    // FIX-G: the create_chart sink for this principal's runtimes. It
    // re-resolves the session per call (never a cached endpoint) and
    // fails closed when none is live — including for private-host
    // runtimes, whose MCP server then reports the honest error.
    const charts = createAgentChartSink({
        resolveSession: deps.resolveSession ?? defaultSessionResolver,
        mintEngineToken: mint,
        ...(deps.engineFetch ? { fetchFn: deps.engineFetch } : {}),
    });
    const sessionKey = session ? session.sessionId : null;
    const existing = runtimes.get(principal);
    if (existing && existing.sessionKey === sessionKey)
        return existing.rt;
    if (existing) {
        runtimes.delete(principal);
        watchers.delete(principal);
        await existing.rt.close().catch(() => undefined);
    }
    const server = session
        ? createServer(new NodeRemoteEngineHost({
            engineUrl: session.engineUrl,
            principal,
            sessionId: session.sessionId,
            fileId: session.fileId,
            clientId: `agent:${principal}`,
            initialRevision: session.currentRevision,
            getAccessToken: () => mint(principal, session),
            ...(deps.engineFetch ? { fetchFn: deps.engineFetch } : {}),
        }), {
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
        })
        : createServer(undefined, {
            hitlTimeoutMs: AGENT_HITL_TIMEOUT_MS,
            // §12 (FIX-J part 2): durable metadata persistence, as above.
            persistence: agentThreadPersistence(),
            // FIX-G: sink resolves per call; no live session → fail closed.
            charts,
        });
    const rt = new AgentRuntime({
        server,
        principal,
        userId: principal,
        hitlTimeoutMs: AGENT_HITL_TIMEOUT_MS,
        // §8: the backend re-resolves from the user's config on every plan(),
        // so switching providers (or rotating the key) takes effect without
        // tearing down the runtime or losing threads.
        backend: new DelegatingModelBackend(() => resolveBackend(principal)),
        // §9 (Cycle-3 GAP-4): conversation threads read-through/write-through
        // the file-backed metadata store per userId, so deployed threads
        // survive restarts.
        threadPersistence: agentThreadPersistence(),
    });
    runtimes.set(principal, { rt, sessionKey });
    return rt;
}
// -- proactive watches (ai-agent.md §6) ------------------------------------
// One ProactiveWatcher per principal, wired to that principal's runtime:
// subscriptions still cross the MCP protocol boundary (runtime.watch /
// pollWatch / unwatch); the watcher adds batching, rate-limiting, the
// agent-decides hook, and persisted per-user mute.
const mutePersistence = memoryPersistence();
const watchers = new Map();
async function watcherFor(principal, deps = {}) {
    let w = watchers.get(principal);
    if (!w) {
        const rt = await runtimeFor(principal, deps);
        w = new ProactiveWatcher({
            subscribe: (events, sheet) => rt.watch(events, sheet),
            poll: async (subscriptionId, maxEvents) => {
                const events = await rt.pollWatch(subscriptionId, maxEvents);
                return events.map((e) => ({
                    seq: e.seq,
                    ts: e.ts,
                    type: e.type,
                    detail: e.detail,
                }));
            },
            unsubscribe: (subscriptionId) => rt.unwatch(subscriptionId),
            mutePersistence,
        });
        watchers.set(principal, w);
    }
    return w;
}
let envTranscriber;
function defaultTranscriber() {
    if (envTranscriber !== undefined)
        return envTranscriber;
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
export function createAgentListener(deps = {}) {
    return async (req, res) => {
        if (handlePreflight(req, res))
            return;
        const url = new URL(req.url ?? '/', 'http://agent');
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const principal = requestPrincipal(req);
        try {
            if (path === '/health' && method === 'GET') {
                return sendJson(res, 200, { ok: true, service: 'agent' });
            }
            if (path === '/message' && method === 'POST') {
                const body = (await readBody(req));
                if (typeof body?.text !== 'string' || body.text.length === 0) {
                    return sendError(res, 400, '{ text: string } required');
                }
                const threadId = typeof body.threadId === 'string' && body.threadId.length > 0 ? body.threadId : randomUUID();
                const rt = await runtimeFor(principal, deps);
                // Human-in-the-loop answers resume a paused turn (ai-agent.md §12);
                // everything else starts a new chat turn.
                const reply = body.kind === 'answer'
                    ? await rt.answer(threadId, body.text)
                    : await rt.chat(threadId, body.text);
                return sendJson(res, 200, {
                    threadId,
                    message: reply.message,
                    needsInput: reply.needsInput
                        ? { prompt: reply.needsInput.question, options: reply.needsInput.options ?? [] }
                        : null,
                    audit: rt.getAuditLog(threadId),
                    // RESOLVED 2026-10-18: the agent's chart attachment travels
                    // through the gateway as plain versioned JSON (ChartSpec-derived
                    // Chart.js config) — no binary encoding. Dropped before; the
                    // client never saw analysis charts via the gateway.
                    chart: reply.chart ?? null,
                });
            }
            if (path === '/audit' && method === 'GET') {
                const threadId = url.searchParams.get('threadId') ?? '';
                if (threadId.length === 0)
                    return sendError(res, 400, '?threadId= is required');
                const rt = await runtimeFor(principal, deps);
                return sendJson(res, 200, { audit: rt.getAuditLog(threadId) });
            }
            // Human-in-the-loop surface (ai-agent.md §12): while a /message turn
            // is parked on an agent.* tool call, the UI polls /pending and
            // answers via /answer. Both delegate to the runtime's versioned MCP
            // tools — the gateway holds no parallel pause state.
            if (path === '/pending' && method === 'GET') {
                const rt = await runtimeFor(principal, deps);
                return sendJson(res, 200, { asks: await rt.listPendingAsks() });
            }
            if (path === '/answer' && method === 'POST') {
                const body = (await readBody(req));
                if (typeof body?.askId !== 'string' || typeof body?.answer !== 'string') {
                    return sendError(res, 400, '{ askId: string, answer: string } required');
                }
                const note = typeof body.note === 'string' ? body.note : undefined;
                const rt = await runtimeFor(principal, deps);
                try {
                    await rt.answerPendingAsk(body.askId, body.answer, note);
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    const status = /denied|not authorized/i.test(msg) ? 403 : 400;
                    return sendError(res, status, msg);
                }
                return sendJson(res, 200, { ok: true });
            }
            // Proactive watches (ai-agent.md §6).
            if (path === '/watch' && method === 'POST') {
                const body = (await readBody(req));
                const events = Array.isArray(body?.events)
                    ? body.events.filter((e) => typeof e === 'string' && isProactiveEventType(e))
                    : ['cells_changed', 'recalc_complete'];
                const sheet = typeof body?.sheet === 'string' && body.sheet.length > 0 ? body.sheet : undefined;
                try {
                    const watchId = await (await watcherFor(principal, deps)).startWatch(principal, { events, sheet });
                    return sendJson(res, 200, { watchId });
                }
                catch (e) {
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
            }
            if (path === '/watch/poll' && method === 'GET') {
                const watchId = url.searchParams.get('watchId') ?? '';
                if (watchId.length === 0)
                    return sendError(res, 400, '?watchId= is required');
                return sendJson(res, 200, { wakes: (await watcherFor(principal, deps)).pollWakes(watchId) });
            }
            if (path === '/watch/stop' && method === 'POST') {
                const body = (await readBody(req));
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
                const body = (await readBody(req));
                const patch = {};
                if (typeof body?.mutedAll === 'boolean')
                    patch.mutedAll = body.mutedAll;
                if (body?.muted && typeof body.muted === 'object') {
                    const m = {};
                    for (const [k, v] of Object.entries(body.muted)) {
                        if (isProactiveEventType(k) && typeof v === 'boolean')
                            m[k] = v;
                    }
                    patch.muted = m;
                }
                return sendJson(res, 200, (await watcherFor(principal, deps)).setMuteConfig(principal, patch));
            }
            // Model backend selection (ai-agent.md §8). GET never returns the key.
            if (path === '/config' && method === 'GET') {
                return sendJson(res, 200, configStore.describe(principal));
            }
            if (path === '/config' && method === 'POST') {
                const body = (await readBody(req));
                if (typeof body?.provider !== 'string' || !isModelProviderId(body.provider)) {
                    return sendError(res, 400, "{ provider: 'heuristic' | 'openai-compatible' } required");
                }
                const provider = body.provider;
                const prev = configStore.get(principal).model;
                const baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.length > 0 ? body.baseUrl : prev.baseUrl;
                if (provider === 'openai-compatible') {
                    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
                        return sendError(res, 400, 'openai-compatible provider needs a valid http(s) baseUrl');
                    }
                }
                else if (baseUrl !== undefined && !/^https?:\/\//i.test(baseUrl)) {
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
                    }
                    catch (e) {
                        return sendError(res, 403, e instanceof Error ? e.message : String(e));
                    }
                    keyRef = ref;
                }
                else if (body.apiKey === null && keyRef) {
                    try {
                        await vault.revoke(keyRef, principal);
                    }
                    catch {
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
                return sendJson(res, 200, configStore.describe(principal));
            }
            // Dictation for the voice command palette (cheapest Gemini on
            // Vertex AI — see the header). The audio clip is short dictation;
            // the body cap allows ~30s of compressed audio as base64.
            if (path === '/transcribe' && method === 'POST') {
                const transcriber = deps.transcriber !== undefined ? deps.transcriber : defaultTranscriber();
                if (!transcriber) {
                    return sendError(res, 503, 'dictation is not configured on this service (GCP_PROJECT_ID and GCP credentials are required)');
                }
                let body;
                try {
                    body = (await readBody(req, 4 * 1024 * 1024));
                }
                catch (e) {
                    if (e.code === 'BODY_TOO_LARGE') {
                        return sendError(res, 413, 'audio clip too large — keep dictation under ~30 seconds');
                    }
                    throw e;
                }
                if (typeof body?.audioBase64 !== 'string' ||
                    body.audioBase64.length === 0 ||
                    typeof body?.mimeType !== 'string' ||
                    !body.mimeType.startsWith('audio/')) {
                    return sendError(res, 400, '{ audioBase64: string, mimeType: "audio/*" } required');
                }
                try {
                    const text = await transcriber.transcribe({
                        dataBase64: body.audioBase64,
                        mimeType: body.mimeType,
                    });
                    return sendJson(res, 200, { ok: true, text, model: transcriber.modelId });
                }
                catch (e) {
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
            if (path === '/artifacts/generate' && method === 'POST') {
                const body = (await readBody(req));
                if (typeof body?.prompt !== 'string' || body.prompt.length === 0) {
                    return sendError(res, 400, '{ prompt: string } required');
                }
                const generator = deps.appGenerator === undefined ? defaultAppGenerator() : deps.appGenerator;
                if (generator === null) {
                    return sendError(res, 503, 'App generation is not configured on this service.');
                }
                if (deps.appGenerator === undefined) {
                    const token = await agentAppTokenProvider()();
                    if (!token) {
                        return sendError(res, 503, 'App generation is not configured on this service: no GCP credentials are ' +
                            'available (set GOOGLE_APPLICATION_CREDENTIALS for the agent service, or ' +
                            'run it under a GCP service account).');
                    }
                }
                const threadId = typeof body.threadId === 'string' && body.threadId.length > 0
                    ? body.threadId
                    : randomUUID();
                const rt = await runtimeFor(principal, deps);
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
                }
                catch (e) {
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
                const body = (await readBody(req));
                if (typeof body?.tool !== 'string' || body.tool.length === 0) {
                    return sendError(res, 400, '{ tool: string, args?: object } required');
                }
                if (!ALLOWED_BRIDGE_TOOLS.includes(body.tool)) {
                    return sendError(res, 403, `tool "${body.tool}" is not available to generated apps`);
                }
                const args = (typeof body.args === 'object' && body.args !== null ? body.args : {});
                const rt = await runtimeFor(principal, deps);
                try {
                    const data = await rt.callTool(body.tool, args);
                    return sendJson(res, 200, { data });
                }
                catch (e) {
                    return sendError(res, 502, e instanceof Error ? e.message : String(e));
                }
            }
            return sendError(res, 404, `not found: ${path}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return sendError(res, 500, `agent error: ${msg}`);
        }
    };
}
