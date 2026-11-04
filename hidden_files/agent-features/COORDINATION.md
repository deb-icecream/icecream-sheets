# Agentic Features — coordination notes (coordinator, 2026-10-21)

## Architecture facts (code-read by coordinator, 2026-10-21 ~16:2x PDT)

- Local stack is UP (started ~15:08 PDT): gateway :8100, engine :8101,
  vault :8102, meta :8103, etl :8104, agent :8105, MCP http :8106,
  addons :8107, web preview :4173. Other coordinators active: Phase 2
  validation (engine restarted ~16:1x), product layer (running product
  tests ~16:2x). DO NOT restart the stack or rebuild apps/web/dist
  without checking their report dirs first.
- Agent path (gateway mode): web AgentChat → RemoteAgentBackend →
  gateway POST /api/agent/message → agent service :8105
  (packages/gateway/src/services/agentSvc.ts) → AgentRuntime
  (packages/service/src/agent/runtime.ts) → MCP Client over
  InMemoryTransport → createServer(undefined) (packages/mcp-server)
  → **a per-principal in-process `new EngineHost()` inside the agent
  service process**.
- ⚠️ BINDING QUESTION (the probe must settle this with evidence): in
  gateway mode NOTHING syncs the browser's engine-service (:8101)
  workbook into the agent's private EngineHost, and agentSvc exposes
  no bind/load endpoint. In LOCAL web mode the chat runtime wraps the
  SAME host as the grid (App.tsx getAgentRuntime), so the loop closes
  there. If the probe confirms the gateway-mode agent sees an empty
  workbook, that is the central defect this workstream must fix
  (bind the agent runtime's MCP server to the user's engine session)
  and re-validate. Design doc ai-agent.md §3 ("agent acts as the user",
  "sees per-subject filtered views") supports the binding expectation;
  §9 scopes THREADS (not data) to the user.
- Model backend: per-principal config via GET/POST /api/agent/config
  (gateway). Providers: 'heuristic' (default, deterministic regex
  planner — NOT an LLM) | 'openai-compatible' (baseUrl + model + key
  in the service vault under `agent:<principal>:model-api-key`).
  DelegatingModelBackend re-resolves per plan() — config change needs
  no restart.
- Vertex route for the planner: Vertex AI's OpenAI-compatible endpoint
  https://us-central1-aiplatform.googleapis.com/v1/projects/dreamscapes-zero/locations/us-central1/endpoints/openapi
  + model `google/gemini-2.5-flash-lite`, Bearer = GCP access token
  (mint: ~/workspace/tools/google-cloud-sdk/bin/gcloud auth
  print-access-token — deployer SA, has aiplatform.user). Token ~1h
  life; mint fresh per run, NEVER print/log/write it anywhere except
  into the vault via POST /api/agent/config (the designed seam).
- Artifacts codegen (separate LLM surface): packages/service/src/
  artifacts/llm.ts — VertexAiCodeGenBackend (native generateContent,
  VERTEX_DEFAULT_MODEL=gemini-2.5-flash-lite) vs TestCodeGenBackend
  (network-isolated). Which one the live stack uses, and where
  generation runs in gateway mode, is W2's recon question.
- MCP tool surface (38 tools): read_cells, write_cells, set_formulas,
  recalculate, get_results, execute_code, analyze_data, list_analyses,
  rerun_analysis, list_data_sources, open_data_source,
  refresh_data_source, create_pivot, get_pivot_data, refresh_pivot,
  report_{create,get,list,update,delete}_spec, appbuilder_{create,get,
  list,update,delete}_spec, memory_{load,save,update}, subscribe,
  unsubscribe, poll_events, list_subscriptions, rtd_publish,
  agent.{ask_question, offer_options, request_approval, list_pending,
  answer_pending}. NOTE: no chart-insert tool and no xlsx-load tool in
  the MCP surface — case 4's mechanism is an open question (chart via
  analyze_data ChartSpec + web insert? execute_code?).
- Browser harness (reuse): hidden_files/phase2-coauthoring/leg-a/
  harness/lib.mjs — playwright-core from hidden_files/pw2/node_modules,
  Chrome at ~/.cache/puppeteer/chrome/linux-155.0.8059.79/.../chrome,
  login = POST :8100/auth/login {userId} → JWT → localStorage
  'icecream-sheets.gateway-token'. API session helpers included.

## Workstreams

- W1 (probe): Vertex wiring at API level + backend-in-path toggle
  proof + agent↔engine binding probe. Output: probe/probe-report.md.
- W2 (recon): DONE 2026-10-21 16:32 PDT — recon/wiring-report.md.
- W3 (later): browser tours cases 1–7. W4 (later): wider five 8–12.
  Scope/order set after W1+W2 land.

## W1 probe results (2026-10-21 ~16:37 PDT, probe/probe-report.md)

- Vertex OpenAI-compat endpoint HEALTHY: `google/gemini-2.5-flash-lite`
  → 200, real completions (~0.5–2.3 s). Bare id → 400 (needs
  publisher prefix). Coordinator's earlier empty-body curl = proxy/
  gzip artifact, not endpoint health. NO native-planner build needed.
- Config seam works; toggle proof done (bad key → real Vertex 401;
  fresh token → success). Gemini is genuinely in the planning path.
- BINDING: **CONCLUSIVE — NOT BOUND.** Agent answered A1:A3 with its
  private values (111/222/333) while alice's engine session held
  7001/7002/7003 + B1='GRIDWORKBOOK'; agent's C1=424242 write never
  reached the engine session (read-back null). F1 confirmed as the
  central defect, now with direct evidence.
- D1 (planner contract): OpenAICompatibleBackend SYSTEM_PROMPT carries
  NO tool arg schemas → Gemini guesses arg shapes → every natural-
  prompt tool call fails (`ok:false, "failed: undefined"`). With exact
  args dictated, tools succeed (~1.4 s) — loop machinery works.
- D1b: tool failure summaries lose the error ("failed: undefined") —
  the model gets nothing to self-correct from.
- D2: runtime ends a turn when the plan contains `done`, and the
  prompt orders `done` at the end of EVERY plan → composed answers
  never happen; replies are first-plan status text.
- D4: planner `ask` actions park /message up to the 4-min HITL wait
  but the gateway proxy kills it at ~30 s → 502 (reproduced 5×);
  design intent (agentSvc comment) is that /message can park ~4 min.
  Fix: gateway proxy timeout for /api/agent/message → ~270 s.
- Left state: alice's agent config = Vertex (token expires ~17:37
  PDT — tours re-mint + re-POST); fixture session left open.

## Fix workstreams (dispatched 2026-10-21 ~16:4x PDT; SOURCE + TESTS
ONLY — dist rebuilds/restarts wait for a coordinated window because
Phase 2 validation + product layer are active)

- FIX-A (packages/service): D1 prompt tool schemas + D1b error
  surfacing + D2 done-semantics/prompt contract.
- FIX-B (packages/gateway + engine/mcp as needed): F1 binding
  (registry resolver + Node RemoteEngineHost + session-aware
  runtimeFor + fallback) + D4 proxy timeout. Baseline gateway suite
  BEFORE edits, full suite after.
- FIX-D (apps/web): F2 chart passthrough in remoteAgent.ts + tests.
- FIX-F (read-only trace): F4 native-chart implementation plan.
- FIX-E (app-gen gateway path + Vertex codegen) scopes AFTER FIX-B
  lands (depends on the bound runtime's shape).
- FIX-D DONE (16:49 PDT): remoteAgent.ts chart passthrough, tests
  5/5 → 8/8, apps/web tsc clean. fixes/fix-d-report.md.
- FIX-F TRACE DONE (16:51 PDT): fixes/chart-trace.md. CORRECTION to
  everyone's premise: UI-created charts NEVER become native chart
  parts in ANY mode — they persist as JSON in docProps/custom.xml
  (`icecream.chartspecs`); only IMPORTED charts round-trip as native
  parts (verbatim bytes). No chart-authoring code exists to reuse.
  GO plan (~1,700 lines incl. tests): new adapter chartsAuthor.ts
  (inverse of the parser; package surgery cloned from SmartArt/
  pivot injection), engineSvc POST /charts (sequenced, revision++,
  journaled `chart.add` kind + replay branch, state.sessionCharts,
  SSE `session {kind:'charts'}` broadcast), directSave integration,
  web merge-by-id + nativePart flag, MCP create_chart tool behind a
  fail-closed ServerOptions.charts sink (agentSvc sink over FIX-B's
  resolver). Kinds fail-closed: column/bar/line/area/pie/doughnut.
  FLAGGED for parent: journaling `chart.add` as a non-EngineCommand
  op kind is a revision-model design decision (trace §4.0 documents
  the rejected larger alternative); build proceeds additively
  (sequencing/LWW/retention untouched) and the deviation is reported,
  not hidden. FIX-G (this build) dispatches when FIX-B lands.

## W2 findings → fix scoping (coordinator, pending W1 empirics)

- F1 KEYSTONE — agent↔workbook binding (W2 headline 5): agentSvc
  createServer(undefined) → private empty EngineHost; nothing binds
  the :8101 session. Blocks cases 1, 2, 3a, 5, 6, 7-via-chat. Fix
  design: per /message, resolve the principal's active session from
  the on-disk session registry; build the runtime's MCP server over a
  Node RemoteEngineHost bound to that session (agent process already
  carries ENGINE_PUBLIC_URL + ENGINE_ACCESS_SECRET in env, so it can
  mint session access tokens with the deploy/engineAccess signer);
  rebuild runtime when the active session changes; fall back to the
  private host when no session is open (preserves current behavior).
- F2 — chart passthrough: apps/web/src/services/remoteAgent.ts drops
  reply.chart (agentSvc returns it, agentSvc.ts:229). Add chart to
  AgentMessageResponse + AgentReply mapping. Unblocks case 3a visual.
  Needs web dist rebuild (coordinated window).
- F3 — app generation gateway path + Vertex codegen (case 3b):
  (a) gateway mode forces artifactMcpCall=null (App.tsx:653) →
  generation throws "not available through the gateway in v1";
  (b) LlmAppGenerator/VertexAiCodeGenBackend never constructed —
  always TemplateAppGenerator. Fix: server-side generation in gateway
  mode — agentSvc endpoint running generateAndSaveArtifact with
  LlmAppGenerator(VertexAiCodeGenBackend{project dreamscapes-zero,
  getAccessToken}) where getAccessToken mints from the deployer key
  file (env GOOGLE_APPLICATION_CREDENTIALS on the agent process;
  Cloud Run would use its runtime SA — note for report); artifact
  bridge calls in gateway mode route through a gateway/agentSvc
  /tools/call endpoint onto the runtime's MCP client (bridge tool
  allowlist still enforced). Web: appGenerationPort uses the gateway
  path when isGatewayMode().
- F4 — native chart (case 4): no MCP chart tool; charts are web-layer
  specs (chartModel + localStorage chartStore) BUT in gateway mode
  embedded charts live in the engine model as parsed parts (load
  metadata carries chart caches; streaming save preserves them).
  Fix worker must trace the xlsx-adapter chart authoring used by
  local saves + engine-model chart representation, then implement:
  MCP create_chart tool → EngineHost.addChart → RemoteEngineHost op
  → engine session model → save writes the part → reopen renders.
  Parse-back (download + reparse) is the bar. If the trace shows the
  engine model cannot author parts, report NOT FIXED with the exact
  blocker rather than faking it via the web store.
- F5 — case 7b SQL: the product's real SQL path is the connectors
  service (:8108, node:sqlite read-only, vault-stored sqlite://
  strings) + OpenDataSourceDialog — NOT the MCP tool (SqlConnector
  has no driver anywhere; MCP open_data_source also isn't in the LLM
  planner's allowed tools). Plan: build gateway dist (connectors bin)
  or start combined service.js on :8108 in a coordinated window;
  seed a SQLite file (python3 stdlib); tour = dialog opens SQL source
  into the session workbook → chat query + one analysis over the
  materialized sheet (needs F1). CSV 7a same dialog path (or MCP
  open_data_source after F1 — decide at tour time; dialog is the
  product flow).
- Cases 8 (ETL UI), 9 (automation UI, manual Run — TriggerRuntime
  unhosted = flagged gap), 10 (Reports UI; MCP store disjoint =
  flagged gap), 11 (AddonManager → :8107, verify documentId→session
  binding live), 12 (AppBuilder UI): UI tours, no code fixes expected.
- Design-doc conflicts (from W2, for final report): dangling
  data-analysis doc reference; ai-agent §3 binding; ai-agent §5
  chart drop; etl-pipeline §6–7 vs stub :8104; unhosted automation
  triggers; reports/appbuilder MCP↔UI store disjointness.

## FIX-B DONE (17:32 PDT) — fixes/fix-b-report.md

Binding implemented in packages/gateway: services/remoteEngineHost.ts
(NodeRemoteEngineHost — /ops envelope mirroring the web collab
transport, clientId `agent:<principal>`, baseRev tracked, 401
re-mint retry-once), services/agentSessionResolver.ts (fresh registry
read per resolve; live lease + creator/participant; most-recent
wins), agentSvc session-aware runtimeFor (principal+sessionId cache,
close-on-change, defaultPrincipal on the bound server, fail-soft to
the private host when no session/no signer). D4 done:
AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS = 270_000 for POST
/api/agent/message. Evidence: tests/agentBinding.test.ts 17/17 solo
— incl. the probe's exact numbers end-to-end through a fake engine
(sum 21006 from 7001+7002+7003; C1=424242 /ops landing) and a 32 s
parked message returning 200 at ~32.2 s through a real gateway.
Full-suite counts from that window are UNRELIABLE both directions
(siblings editing the tree mid-run; solo re-runs pass) — the window
step re-runs the gateway suite once on a quiet tree before restarts.
RESIDUALS for the final report: (1) runtime swap can orphan a parked
HITL turn; (2) prod/Firestore registry has no list operation —
resolver's records seam needs a listing adapter or binding falls
back (safe) in prod; (3) opens record only creatorPrincipal →
non-creator participants don't bind yet; (4) minted agent tokens are
always role 'editor' — a viewer-joiner's agent could write; (3)+(4)
share one fix (record participants+roles in the registry at
open/join) in the collab open path — flagged, not silently expanded;
(5) subscribe() polls /events 1.5 s instead of SSE.

## FIX-H DONE (17:32 PDT) — fixes/fix-h-report.md

Guardrails in packages/service only. EXISTED: maxIterations,
thread caps, gateway 1MB generic cap, heuristic help fallback.
BUILT: input cap 4,000 chars (chat/answer/createAppArtifact;
rejection names the limit + actual length; zero planner/tool calls;
stored as system notice; audit kind `guardrail`), rate 30 turns/min
+ concurrency 3 per principal (busy/rate replies; HITL/watch paths
bypass), reply bound 8,000 chars with notice suffix, deterministic
classifyScope() scope gate (conservative; decline names capabilities)
+ "SCOPE (hard rule)" block in the planner prompt. Config:
AgentRuntimeOptions + AGENT_* env fallbacks. Tests: 17 new guardrail
tests (20 in-scope fixtures across ALL case families pass the gate
AND reach the backend; 10 off-topic declined with zero plan calls);
run total 250/250, tsc clean. Flags: limits are per-runtime-instance;
two conservative scope slips resolve in-scope by design (planner
prompt is the backstop). NOTE: a sibling rebuilt packages/service/
dist concurrently during this window — the coordinated window must
rebuild all dists deterministically before restarts regardless.

## WINDOW LOG (coordinator, 2026-10-21 evening)

DONE: FIX-E (all 4 parts, coordinator-built; report fixes/fix-e-report.md),
FIX-J part 1 (worker, verified) + part 2 (persistence wiring landed in
agentSvc with FIX-E Part 3; cap 2,000 + rationale landed in runtime.ts
with FIX-E Part 2), FIX-H2 test updates (guardrails fixtures moved to the
2,000 regime + 2,001 boundary test added). Consolidated re-runs GREEN:
service agent trio 63/63; gateway trio (binding/thread/artifacts) 25/25;
mcp-server memory exit 0; web port+remoteAgent 11/11; service + gateway
tsc clean. Dists rebuilt: service, gateway, mcp-server.
⚠️ CROSS-WORKSTREAM FIX (flagged, minimal): apps/web
src/features/functions.ts isFunctionListStale() — TS2367 (literal '1'
vs '2' comparison) blocked build:local-stack's tsc step. Fixed with a
semantics-identical widening cast `(FUNCTION_LIST_VERSION as string)`.
NOTE the underlying signal is REAL: the bundled function list (v1) is
stale vs the engine registry (v2) — regeneration belongs to the
function-coverage workstream; the cast preserves the staleness signal.
WINDOW COMPLETE (2026-10-21 ~19:2x PDT): FIX-G landed all 5 parts
(worker 9032eb56; coordinator spot-verified: engineCharts+agentCharts
9/9 own run, sink wired, FIX-E/J edits intact). Web dist rebuilt
(verify-dist OK). Stack restarted via start-stack-agent.sh (agent env
GOOGLE_APPLICATION_CREDENTIALS + GCP_PROJECT_ID; connectors :8108 UP;
⚠️ the finisher script never set ENGINE_ACCESS_SECRET or
ENGINE_ACCESS_MODE — my script exports both, ENGINE_ACCESS_SECRET
from the script's own SECRET; gateway log confirms "signed engine
access enabled"). Alice Vertex config re-posted (openai-compatible,
google/gemini-2.5-flash-lite, hasKey true; NOTE: config store is
in-memory — re-post after EVERY agent restart; token ~1h life).
**BINDING PROOF (probe3.mjs re-run, results3.json + transcripts/
step5c-*): JOIN 200; engine sanity A1=7001 A2=7002 A3=7003
B1='GRIDWORKBOOK' C1=null; AGENT READ "The values in A1:A3 are 7001,
7002, and 7003. The value in B1 is GRIDWORKBOOK."; AGENT WRITE
424242 → engine read-back C1=424242. FIX-B LIVE-PROVEN.**
REMAINING: tours W3a (1,2,3a,3b,4,5,6), W3b (7,13,14,15,16,17,18,19,
20), W4 (8,9,10,11,12) — dispatched in parallel, distinct users
(alice/bob/carol), evidence under cases/.

## DECISIONS ADDENDUM reconciled (user, 2026-10-21 18:03 PDT)

Read in full: hidden_files/agent-features/DECISIONS-ADDENDUM-2026-10-21.md
— the binding consolidation of the 17:08–17:40 directives. Every
numbered item maps to work already done/running/queued:
A1 cap 2,000 (FIX-H built the mechanism at 4,000; FIX-J part 2 sets
2,000 + rationale) — NUANCE to verify in part 2: the cap counts
ONLY the raw user input, never system prompt/memories/tool results
(FIX-H gates the input string pre-composition — confirm in the
part-2 report). A2 rate/concurrency/output bounds: FIX-H DONE.
A3/B6 cases 13–17: in the matrix (BRIEF addendum). B4/B5 two-source
scope: FIX-J part 1 items 2–3 (fixtures + prompt block). C7
tool-call-only execution: FIX-B binding DONE; cases 5, 8–12, 3b in
the tour plan. D8 session memory: trace-verified IMPLEMENTED
(memory-trace.md §A); case 19 live proof owed. D9 long-term memory:
store + planner verified; gateway persistence wiring = FIX-J
part 2; case 20. D10: memory-trace.md IS the precise missing-list.
E11 component name "AI Agent" (packages/service/src/agent incl.
backends.ts). E12 LangGraph: verified ZERO presence. E13 Vertex
flash-lite live-only: tour plan (re-mint + real config POST).
Final report must carry a verdict + evidence per addendum item
1–13 AND per case 1–20.

## Scope TIGHTENING + memory cases (user, 2026-10-21 17:40 PDT)

Scope rule superseded again (BRIEF addendum updated): the agent
answers ONLY from (1) data in context (sheets/files/connected data
via tools) and (2) icecream-sheets-specific product knowledge.
Everything else declines. Cases 17–20 added: (17) product question
answered from product knowledge; (18) earlier-session data
question in a new session, answered from context; (19) session
memory ("the total you computed before"); (20) long-term memory —
fact saved via memory MCP tools in session 1, recalled+used in a
new session, transcripts for both. Matrix is now 20 cases.
MEM-TRACE worker dispatched to verify ai-agent.md §9+§12 against
threads.ts, the memory_* MCP tools + their store backing/gateway
persistence, planner memory usage, product-knowledge grounding,
and classifyScope vs the two-source rule. LangGraph must NOT be
introduced (§12). Builds follow the trace (FIX-J).

## Guardrails REFINEMENTS (user, 2026-10-21 17:34 PDT — binding)

(1) Input cap default is **2,000 chars**, not FIX-H's 4,000 (the
10,000 figure was the abuse example, not the limit). Rejection
message gains the rationale: normal prompts are a few hundred
chars; longer content belongs in a file/data source the agent
reads via tools. Case 13 now pairs: >2,000 paste rejected (limit
named) + a legitimate ~1,500-char detailed request still works.
(2) Scope = spreadsheet/data/product ONLY; **all** general
knowledge declines identically (new example "Who is Einstein?";
also trivia, news, general facts, chit-chat) — never answered from
the model's knowledge. **Case 16 added** (Einstein). Matrix is now
16 cases. FIX-H2 (queued, dispatches the moment FIX-E lands —
runtime.ts is FIX-E's file right now): default 4,000 → 2,000 +
rationale text in the rejection; guardrail tests updated (2,001
and 10,000 rejected; ~1,500-char in-scope request reaches the
backend); classifyScope fixtures extended with Einstein/capital-of-
France/Eiffel-Tower/fun-fact/chit-chat — all must decline with zero
plan() calls; the 20 in-scope fixtures must still pass.

## Guardrails addendum (user directive 2026-10-21 17:08 PDT)

Added to BRIEF.md as a binding addendum; cases 13–15 join the matrix.
Coordinator inventory (2026-10-21): EXISTS — maxIterations (5),
MAX_THREAD_MESSAGES, gateway 1MB body cap (generic, not the agent
limit), heuristic backend's help-question fallback for unknown
intents. MISSING — any input-length cap, any per-user rate/
concurrency limit in the runtime, any reply-size bound, and ANY
scope gate on the LLM path (Gemini would answer weather questions
freely). FIX-H (dispatched ~17:1x PDT, packages/service only —
agentSvc pass-through deliberately avoided while FIX-B is in that
file; runtime reads AGENT_* env overrides itself): input cap
(default 4,000 chars — a 10k paste is rejected with the limit
named), per-principal rate (default 30 turns/min) + concurrency
(default 3) with clear busy replies, reply bound (default 8,000
chars), deterministic scope gate in the runtime via an intentRouter
extension (conservative: ambiguous → in scope; cases 1–12 + 15
prompt fixtures must all pass the gate in tests) + the scope rule
added to the planner system prompt as the second layer.

## D-JOIN-RACE — FOUND DEFECT (2026-10-21 evening, coordinator live repro)
Browser JOIN/reopen of an existing file intermittently never renders cells:
the client fetches /snapshot + /sheets (200) and usedrange for the real
sheet (200), but sometimes no range read follows and the grid stays on
the placeholder workbook forever (observed 60-90s stalls x3: W3a run 2,
W3b phase A fatal, diag-product reload). Other runs hydrate in ~10s
(diag-trace file-498e8778). Engine side fully healthy (snapshot carries
all cells; API reads 200). Pattern: when the usedrange warm lands after
the render loop quiesces, nothing re-triggers the fetch. Tours mitigate
with ONE logged reload-retry per open (state.joinRaceReloads). Product
fix belongs to the web/phase-2 workstream: re-trigger the initial range
fetch when the active sheet's usedrange resolves (or retry the initial
fetch on a timer until first paint). Evidence: cases/diag-*.png +
this session's diag traces (reproduced stall AND success on identical
fixtures). ALSO: engine 500s on reads for the not-yet-known placeholder
sheet "Sheet1" — should be a benign empty/404, not a 500.

## FINAL (2026-10-22 ~08:15 PDT)
FINAL-REPORT.md written: verdicts for all 20 cases + every addendum item.
PASS: 8, 10, 20. FAIL: 11 (wrong-document binding). FAIL-GAP: 9 (no
trigger host). NOT RUN (D2-blocked or worker-evidence lost): 1-7, 12-19
(unit-level proof exists for 13-17 via FIX-H/J tests). Fixes A-K all
in-tree. Open: chart.add ratification, FIX-B residuals (participants/
roles), D2 web join/boot reliability (zero-gateway-traffic diag on
record), case 9 + 11 product fixes, connector UI = proposal only.
