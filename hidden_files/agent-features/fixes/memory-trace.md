# Memory + scope trace — ai-agent.md §9/§12 vs code (coordinator, 2026-10-21)

Verified by direct file reads + the coordinator's own test run
(the five service agent test files: 74/74 green — agent-modelconfig,
agent-guardrails, agent-runtime, agentThreads,
agentThreadPersistence). User rule under test
(2026-10-21 17:40 PDT): the agent answers ONLY from (1) data in
context via tools and (2) icecream-sheets product knowledge;
memory = §9 session threads + §12 long-term memory as versioned
MCP tool calls; NO LangGraph.

## A. Session memory (§9) — IMPLEMENTED
- `packages/service/src/agent/threads.ts` exists; AgentRuntime takes
  `threadPersistence?: Persistence` (runtime.ts:93) and builds
  `createAgentThreadStore(persistence, userId)` (runtime.ts:229).
- Gateway: agentSvc.ts:149-158 — file-backed thread persistence
  (`filePersistence(gatewayDataDir())`), keys
  `icecream-sheets.agent-threads.v1.<userId>`, shared by every
  runtime in the process, "deployed threads survive restarts"
  (cites §9 / Cycle-3 GAP-4).
- Planner receives history: runtime chat paths call
  `this.history(threadId)` and pass `history: [...hist]` into plan
  calls (runtime.ts:435, 498, 568, 610, 767-785). Prior assistant
  replies (which state computed values) are part of thread history,
  so "the total you computed before" has the material it needs.
- Tests: agentThreads.test.ts + agentThreadPersistence.test.ts pass
  in the coordinator's 74/74 run of the five agent test files.
- Case 19 machinery: READY (live proof still owed).

## B. Long-term memory (§12) — PARTIAL: store correct, gateway wiring MISSING (case-20 blocker)
- Store: `packages/mcp-server/src/memory.ts` — MemoryStore,
  per-user key→value maps, ops load/save/update matching the MCP
  tools memory_load / memory_save / memory_update; header states
  the §12 contract ("no private memory channel… service metadata
  store"). Persists a whole-blob snapshot under
  `icecream-sheets.mcp.agent-memory.v1` via an injected
  Persistence; **constructor default is `memoryPersistence()`
  (in-memory)** (memory.ts:23).
- Planner: memory_save/load/update are in DEFAULT_ALLOWED_TOOLS
  (openaiBackend.ts:50-52) with exact schemas (lines 102-104,
  "runtime stamps the user id itself"); runtime.ts:938 stamps the
  user on memory tool calls; the capabilities/decline text
  advertises "remember notes" (runtime.ts:164).
- **DEFECT**: agentSvc `runtimeFor` calls
  `createServer(host, { hitlTimeoutMs, defaultPrincipal })` —
  **no `persistence` option** (agentSvc.ts:258-276) — while the
  SAME function passes shared file-backed `threadPersistence` for
  threads. So in gateway mode every runtime gets a fresh in-memory
  MemoryStore: memory survives only while one cached runtime lives
  (same principal + same workbook session); it is LOST on session
  change (FIX-B runtime swap), on opening a different file, and on
  agent-process restart. Case 20 (save in session 1 → recall in a
  NEW session) fails in exactly the scenario it tests.
- Secondary hazard for the fix: MemoryStore lazy-loads once and
  persists whole-blob snapshots; multiple live instances sharing
  one file persistence (different principals' runtimes coexist)
  can clobber each other's saves. The fix must make persist()
  read-modify-write (reload + merge before save).

## C. Product knowledge (case 17) — routing IMPLEMENTED; grounding = model parametric (flag)
- intentRouter.ts:273-274 — explicit "Product anchors": the
  product itself, "in this app", product how-to whose object is a
  spreadsheet feature → product questions classify IN SCOPE.
- No product docs corpus / knowledge tool exists anywhere in the
  agent path. Product answers therefore come from the model's
  parametric knowledge: reliable for standard function semantics
  (XLOOKUP etc. — the product implements standard semantics),
  NOT grounded for product-specific UI flows ("how do I create a
  pivot table?" in THIS app's UI). Case 17's bar is "answered
  correctly" — validate live and report accuracy honestly; a
  grounded product-knowledge source is a larger build the user
  has not (yet) directed.

## D. Scope rule vs the two-source tightening — classifier strong; prompt backstop to add
- classifyScope (intentRouter.ts) is deterministic, conservative
  (ambiguity → in-scope), with strong/weak anchor families
  (lines 260/282) and off-topic families declining WITHOUT planner
  calls (FIX-H; guardrail tests green in the 139/139 run).
- Gaps vs the 17:40 tightening: (1) fixtures do not yet include
  "Who is Einstein?" / general-fact / chit-chat families (FIX-H2
  scope); (2) AGENT_SYSTEM_PROMPT carries tool schemas but no
  explicit TWO-SOURCE rule as the model-layer backstop for prompts
  the classifier lets through.

## E. LangGraph — CLEAN
- Zero `langgraph` hits in packages/service, packages/mcp-server,
  packages/gateway package.json files. Thread state is held by our
  own runtime + thread store per §12.

## BUILD LIST (FIX-J)
Part 1 (collision-free now):
1. mcp-server memory.ts: persist() becomes read-modify-write
   (reload blob, merge this instance's state, save); tests proving
   two MemoryStore instances over one shared file persistence do
   not lose each other's saves, and a fresh instance (simulated
   runtime swap) recalls what an earlier instance saved.
2. intentRouter.ts + guardrail fixtures: Einstein/general-fact/
   trivia/chit-chat fixtures decline with zero planner calls; the
   20 in-scope fixtures still pass.
3. openaiBackend.ts AGENT_SYSTEM_PROMPT: explicit TWO-SOURCE rule
   block (answer only from tool-reachable data in context or
   icecream-sheets product knowledge; decline everything else;
   product questions answered directly, no tools needed when no
   user data is involved).
Part 2 (after FIX-E releases agentSvc.ts + runtime.ts):
4. agentSvc: pass shared file-backed persistence into both
   createServer calls (`persistence: agentThreadPersistence()` —
   same adapter the threads use) so MemoryStore is durable and
   shared across runtime swaps.
5. runtime.ts: input-cap default 4,000 → 2,000 + rejection-message
   rationale (the FIX-H2 remainder, user directive 17:34 PDT).
