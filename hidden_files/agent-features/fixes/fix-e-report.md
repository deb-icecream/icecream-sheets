# FIX-E — Gateway-mode generated-app support

Status: IN PROGRESS (started 2026-10-21)
Owner: subagent 36a40353

## Checklist
- [x] Part 1 — token provider — RESOLVED BY REUSE (coordinator): the brief's premise was wrong; the gateway ALREADY owns this seam — `packages/gateway/src/services/vertexToken.ts` `createGcpAccessTokenProvider(env)` (SA-key JWT exchange + GCE/Cloud Run metadata-server fallback, soft-null, cached) already powers agentSvc's /transcribe route, and the service package receives token callbacks by injection (established pattern; service→gateway import would invert the dependency). The coordinator's duplicate `packages/service/src/artifacts/gcpAccessToken.ts` (+tests, 4/4 passing) was DELETED in favor of the existing provider; Part 3 wires the artifacts route to it. Deviation from the original FIX-E brief, flagged per instructions: implementation location corrected to the repo's existing seam; no design-doc conflict (ai-generated-apps.md does not place the provider).
- [x] Part 2 — runtime seam — DONE BY COORDINATOR: public `AgentRuntime.callTool(tool, args)` added (ensureConnected → stampUser → parseToolResult, throws tool error text); createAppArtifact's private closure now delegates to it (identical semantics). NO `appGenerator` runtime option needed: `CreateAppArtifactOptions.generator` already injects per call, and `generateAndSaveArtifact` defaults to TemplateAppGenerator when absent (generator.ts:578) — the gateway route passes LlmAppGenerator per call. ALSO LANDED HERE (was FIX-J part 2's runtime half): input-cap default 4,000 → **2,000** (`DEFAULT_AGENT_MAX_INPUT_CHARS`, runtime.ts) + rejection message now carries the rationale (normal prompts are a few hundred chars; longer content belongs in a file/data source) with the original first sentence verbatim. Cap verified to gate the RAW user input only (chat() userText / createAppArtifact prompt, pre-composition) per addendum A1. packages/service `tsc --noEmit` CLEAN.
- [x] Part 3 — gateway routes — DONE BY COORDINATOR (agentSvc.ts): POST /artifacts/generate (Vertex LlmAppGenerator via the existing vertexToken chain; project GCP_PROJECT_ID ?? GOOGLE_CLOUD_PROJECT ?? 'dreamscapes-zero'; model VERTEX_DEFAULT_MODEL; token probe → 503 fail-closed, NO template fallback; deps.appGenerator override for tests, null → 503) running rt.createAppArtifact with createArtifactStore over the shared file persistence + detectTemplate forced (mirrors the web port). POST /tools/call forwards to the new runtime.callTool with the SERVER-SIDE allowlist = ALLOWED_BRIDGE_TOOLS verbatim (read_cells, write_cells, set_formulas, get_results, recalculate, subscribe, unsubscribe, poll_events); everything else 403. ALSO LANDED HERE (FIX-J part 2): both createServer calls in runtimeFor now pass `persistence: agentThreadPersistence()` — MemoryStore (and pivot/report spec stores + pending asks) are durable across runtime swaps/restarts (ai-agent.md §12). Tests: tests/agentArtifacts.test.ts 6/6 PASS (503 disabled, 400, full generation flow seeded via the bridge route, over-cap 502 naming the 2,000 limit, 403 ×4 tools, bridge read 200). Gateway tsc clean; service dist rebuilt.
- [x] Part 4 — web branch — DONE BY COORDINATOR: GatewayClient.generateApp + callTool; appGenerationPort gateway lane (delegates, upserts the returned spec into the SAME web artifact store, never touches local MCP; local lane byte-identical); App.tsx — gateway mode now sets artifactMcpCall to a gateway-backed McpCallFn (client resolved at call time) instead of null, the port registration passes gatewayGenerate in gateway mode, and the "not available through the gateway in v1" string is GONE. Tests: apps/web appGenerationPort.test.ts 3/3 + remoteAgent.test.ts 8/8 PASS. Web tsc: only pre-existing sibling error in src/features/functions.ts (function-coverage workstream; none of the FIX-E files error).

## Env required (for the coordinator's stack window)
- The AGENT service process (packages/gateway agentSvc, :8105) needs:
  GOOGLE_APPLICATION_CREDENTIALS=<deployer key path> and
  GCP_PROJECT_ID=dreamscapes-zero. Without them /artifacts/generate
  answers 503 (fail closed) — everything else is unaffected.
- The WEB build needs NOTHING new (no GCP config client-side).

## Allowlist (/tools/call) — justification
The route enforces ALLOWED_BRIDGE_TOOLS verbatim — the list the
artifact bridge protocol (packages/service/src/artifacts/bridge.ts)
already defines for generated apps: read_cells, write_cells,
set_formulas, get_results, recalculate, subscribe, unsubscribe,
poll_events. These are exactly the data read/write + event tools a
generated app needs at runtime. Deliberately excluded (403, tested):
execute_code (arbitrary code), agent.* HITL tools, memory_save and
all memory administration, analyze_data, and every other MCP tool.

## Status: FIX-E COMPLETE (coordinator-built after 3 worker deaths).
Live proof still owed: case 3b in the browser tour (real Vertex
generation through this route) — the route tests used the service's
TestCodeGenBackend at the AppGenerator seam, by design.
