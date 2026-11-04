# W2 Recon — Live Wiring Map for Agentic Features (gateway mode)

Read-only code recon, 2026-10-21. Scope: web app `:4173` → gateway `:8100` →
services (engine `:8101`, vault `:8102`, meta `:8103`, etl `:8104`, agent
`:8105`, MCP http `:8106`, addons `:8107`). Every claim cites `file:line`
in the repo at `~/workspace/icecream-sheets`. No code was changed, no
browser was driven, the stack was not restarted.

## Headline findings (blockers first)

1. **Gateway chat drops analysis charts.** The agent service returns
   `chart` (`packages/gateway/src/services/agentSvc.ts:229`), but the
   web's `RemoteAgentBackend` never reads it — its response interface has
   no `chart` field (`apps/web/src/services/remoteAgent.ts:76`) and
   `send()` does not map one (`apps/web/src/services/remoteAgent.ts:89`).
   Case 3a can produce a text summary in gateway mode but **no inline
   visual** until this is fixed.
2. **App generation is template-only everywhere, and fully blocked in
   gateway mode.** Nothing in the repo ever constructs `LlmAppGenerator`
   / `VertexAiCodeGenBackend` / `TestCodeGenBackend` outside
   `packages/service/src/artifacts/llm.ts` itself (grep over `packages/`
   + `apps/`, tests excluded: only re-exports in
   `packages/service/src/artifacts/index.ts:81`). The live generator is
   always `TemplateAppGenerator`. In gateway mode the artifact MCP call
   is forced to `null` (`apps/web/src/App.tsx:653`), so even template
   generation throws before it starts. Case 3b **cannot run at all** in
   gateway mode today.
3. **No native-chart insertion path exists for the agent** (case 4):
   no MCP chart tool, no chart API in the `execute_code` sandboxes, no
   "insert into sheet" action in AgentChat. Details in §3.
4. **The connectors service (`:8108`) — the only real SQL driver in the
   product — is not started by the stack script** and its bin is not in
   `packages/gateway/dist/bin/` (only `service.js`, the combined runner,
   is). Gateway route `/api/connectors` → `127.0.0.1:8108`
   (`packages/gateway/src/bin/gateway.ts:59`) is dead until someone
   builds/starts it. Case 7b depends on it (via the web UI route; the
   MCP route can never work — see §5).
5. **Agent↔workbook binding (coordinator's open question):** the agent
   service builds its MCP server with `createServer(undefined, …)`
   (`packages/gateway/src/services/agentSvc.ts:137`), and `createServer`
   falls back to a fresh private `new EngineHost()`
   (`packages/mcp-server/src/server.ts:228`). Nothing in `agentSvc.ts`
   loads or binds the engine-service (`:8101`) workbook. Every
   MCP-backed case (1, 2, 3a, 5, 7-via-chat) inherits this; W1's probe
   must settle it with evidence.

---

## 1. Analysis route (case 3a)

### End-to-end trace

- Chat entry: `AgentChat.send()` classifies with `routePrompt`
  (`apps/web/src/components/AgentChat.tsx:300` area, `send`/`handleRoute`
  at `AgentChat.tsx:240`). For route `analysis`, `handleRoute` first
  checks the browser-side intent-port registry; in gateway mode no
  analysis port is registered in the browser (see "Why the browser port
  is absent" below), so it falls back to `runtime.chat(threadId, prompt)`
  and pushes `reply.chart` (`apps/web/src/components/AgentChat.tsx:283`).
- Gateway hop: `RemoteAgentBackend.send()` POSTs `/api/agent/message`
  (`apps/web/src/services/remoteAgent.ts:89`); gateway proxies
  `/api/agent` → `http://127.0.0.1:8105`
  (`packages/gateway/src/bin/gateway.ts:57`); `agentSvc` calls
  `rt.chat(...)` and returns `{ threadId, message, needsInput, audit,
  chart: reply.chart ?? null }`
  (`packages/gateway/src/services/agentSvc.ts:229`).
- Planner (agent service process): `AgentRuntime.runLoop` asks its
  `ModelBackend` to plan (`packages/service/src/agent/runtime.ts:575`
  area). The default/heuristic backend detects analysis intent via
  `routeChatIntent` + `classifyAnalysisIntent` and emits an
  `analyze_data` tool action (`packages/service/src/agent/backends.ts:262`);
  on the tool result it composes the reply message
  (`packages/service/src/agent/backends.ts:347`). With the
  `openai-compatible` provider configured (per-principal, `/api/agent/config`,
  `packages/gateway/src/services/agentSvc.ts` config endpoints), an LLM
  planner can emit the same tool call — the tool pipeline below is
  identical either way.
- MCP tool: `analyze_data` (`packages/mcp-server/src/server.ts:1515`)
  → `runAnalysisPipeline` (`packages/mcp-server/src/server.ts:1407`):
  1. resolve sheet/range (explicit bounds or engine used-range),
  2. authorized read through the MCP server's `EngineHost`
     (`readAnalysisGrid`, `#PERM!` cells excluded),
  3. `extractDataSchema` (`packages/mcp-server/src/server.ts:1417`),
  4. `classifyAnalysisIntent(opts.intent)` (`server.ts:1418`),
  5. generate Python (`server.ts:1419`),
  6. `executeAnalysis(analysisPythonRunner, …)` (`server.ts:1433`),
  7. persist an `AnalysisArtifact` in the MCP server's analysis store
     and return `{ artifactId, summary, intentKind, rangeRef, analysis,
     chartSpec, scriptVersion }`.
- Chart back to chat: `AgentRuntime.chartAttachment()` finds the latest
  successful `analyze_data` result, validates its `chartSpec` and
  converts it to a Chart.js config
  (`packages/service/src/agent/runtime.ts:639`); the reply carries it at
  `runtime.ts:622` / `runtime.ts:629`. `agentSvc` forwards it (above).
  **The chain breaks at the last hop:** `RemoteAgentBackend` drops it
  (Headline 1). AgentChat would render it as
  `<ChartCanvas config={m.chart.config} …>` inside the message bubble
  (`apps/web/src/components/AgentChat.tsx:478`) — `ChartCanvas` is the
  Chart.js wrapper component (`apps/web/src/components/ChartCanvas.tsx:65`,
  `new ChartJS(canvas, config)` at `ChartCanvas.tsx:76`).

### Who writes the Python — deterministic templates, NOT an LLM

- The planner is a regex grammar: `classifyAnalysisIntent` in
  `packages/service/src/analysis/planner.ts` (intent rules table +
  `columnHints`/`topNCount`; kinds: summarize, aggregate, trend,
  distribution, correlation, compare, top-n). No model call anywhere in
  the analysis lane.
- The generator actually used is hardcoded:
  `new TemplatePythonGenerator().generate(schema, plan)`
  (`packages/mcp-server/src/server.ts:1419`).
  `TemplatePythonGenerator` (`packages/service/src/analysis/generator.ts`,
  class at the "Deterministic template generator" section) emits one
  fixed template per intent kind; same (schema, plan) → same source,
  byte for byte. Scripts are stamped `analysis-script-version: 1` and
  must assign `result = { analysis, chartSpec }`.
- An LLM seam exists but is **never wired**: `FreeformPythonGenerator` +
  `buildFreeformPrompt` + `FreeformSource` in
  `packages/service/src/analysis/generator.ts` have no construction site
  in `server.ts`, the agent service, or anywhere else. No backend,
  config, or env var selects it.

### Where Python executes — subprocess sandbox, pinned venv

- `executeAnalysis` (`packages/service/src/analysis/executor.ts`)
  validates input/output size caps and the chartSpec, and delegates to
  an injected `PythonRunner`. The MCP server binds the real one:
  `analysisPythonRunner` (`packages/mcp-server/src/server.ts:1257`)
  dynamically imports `./sandbox/python.js` and calls
  `runPython(code, { columns, rows }, { timeoutMs })`.
- `runPython` (`packages/mcp-server/src/sandbox/python.ts`) spawns the
  interpreter via `execFileSync` (no shell) under a restricted prelude:
  safe-builtins subset, import allowlist (stdlib `math, json, re,
  itertools, functools, datetime, statistics`; pinned runs add
  `pandas, numpy, matplotlib, io, base64`), 256 MB best-effort
  `RLIMIT_AS`, clean env (`PATH` only), timeout (executor default
  10 s, cap 30 s — `packages/service/src/analysis/executor.ts`
  `DEFAULT_ANALYSIS_TIMEOUT_MS`/`MAX_ANALYSIS_TIMEOUT_MS`).
- Default runs use the **pinned venv**: `PinnedPythonEnv`
  (`packages/service/src/python/env.ts:37` pins
  `numpy==1.26.4, pandas==2.2.3, matplotlib==3.8.4`), content-addressed
  under `~/.cache/icecream-sheets/pyenvs/<fingerprint>/`, provisioned
  lazily on first use (`ensurePinnedEnv`,
  `packages/mcp-server/src/sandbox/python.ts` — `python3 -m venv` + pip
  install, up to 15 min, honest failure, **no fallback to system
  python**). Results are content-addressed-cached
  (`PythonResultCache`). On this VM the env is already provisioned
  (one fingerprint dir present under `~/.cache/icecream-sheets/pyenvs/`,
  python 3.12.3) — verified by directory listing during recon.
- The separate `packages/service/src/python/provider.ts`
  (`createPinnedPythonProvider`) is the engine `PY()`-formula provider,
  not the analysis path; analysis does not use it.
- Config/env needed by the analysis lane itself: **none** beyond
  `python3` on `PATH`. No LLM keys, no Vertex, no network (after venv
  provisioning).

### Why the browser-side analysis port is absent in gateway mode

`createServer()` registers an `AnalysisPort` with the intent router as a
side effect (`packages/mcp-server/src/server.ts:1484`,
`createAnalysisPort` from `packages/service/src/analysis/port.ts`). In
the browser that only happens via `getLocalMcpCall(host)`
(`apps/web/src/services/mcpToolClient.ts:53`), which `App.tsx`
short-circuits in gateway mode (`apps/web/src/App.tsx:653`:
`if (isGatewayMode()) { setArtifactMcpCall(null); return; }`). The agent
service's own `createServer` registers the port in the *agent process's*
registry — a different JS realm, invisible to the browser. So gateway
chat always takes the `runtime.chat` fallback, which is the correct
route — it just loses the chart at `RemoteAgentBackend` (Headline 1).

### What would make this route run LIVE against a workbook in gateway mode

1. The agent-binding fix (Headline 5): the pipeline reads whatever the
   agent service's private `EngineHost` holds — today, per the code,
   nothing syncs the browser's `:8101` workbook into it, so a live run
   would analyze an empty/default workbook or fail with "workbook has
   no sheets" / "sheet is empty".
2. The `RemoteAgentBackend` chart fix (Headline 1) for the visual half
   of the case; the text summary + numbers already flow.

**Live-run requirement:** (a) W1/fix stream binds the agent runtime's
MCP server to the user's engine-service session (or otherwise loads the
open workbook into it) — no config flag exists for this today;
(b) patch `apps/web/src/services/remoteAgent.ts` to carry `chart`
through `AgentMessageResponse`/`send()` and rebuild `apps/web/dist`
in a coordinated dist window; (c) no LLM/Vertex config is needed —
the pipeline is deterministic templates + the already-provisioned
pinned Python venv in the agent-service process.

---

## 2. App-generation route (case 3b)

### Where it executes in gateway mode — the browser bundle (and it's blocked)

- Routing: `AgentChat.handleRoute` route `app` →
  `dispatchIntent(route, ports, prompt)` with ports from
  `getIntentPorts()` (`apps/web/src/components/AgentChat.tsx:252`).
- The port is registered once by `App.tsx`
  (`apps/web/src/App.tsx:674`): `createAppGenerationPort`
  (`apps/web/src/services/appGenerationPort.ts:30`) →
  `generateAndSaveArtifact({ prompt, sheet }, { callTool: mcpCall,
  store, template: detectTemplate(prompt) })`
  (`appGenerationPort.ts:40`). **All of this is service-package code
  imported into the web bundle.** There is no gateway endpoint for
  artifacts (`agentSvc.ts` has no artifact route) and the agent service
  is not involved. `AgentRuntime.createAppArtifact`
  (`packages/service/src/agent/runtime.ts:202`) exists but has no
  gateway/web caller.
- **Gateway block:** the port's `getMcpCall` reads
  `artifactMcpCallRef.current`, which `App.tsx` forces to `null` in
  gateway mode (`apps/web/src/App.tsx:653`), so it throws
  `"Generated apps need the local engine — not available through the
  gateway in v1."` (`apps/web/src/App.tsx:677`). The UI says the same
  in three places: Apps tab (`apps/web/src/components/AgentChat.tsx:465`),
  `ArtifactFrame` when `mcpCall` is null
  (`apps/web/src/components/ArtifactHost.tsx:264`), and the port error
  surfaces as a chat notice via `dispatchIntent`'s `unavailable`/throw
  path. In local mode the call fn is an in-process MCP client over
  `createServer(host)` (`apps/web/src/services/mcpToolClient.ts:46`).

### Which generator — always TemplateAppGenerator; test-vs-Vertex decided nowhere

- `generateAndSaveArtifact` defaults the generator:
  `deps.generator ?? new TemplateAppGenerator()`
  (`packages/service/src/artifacts/generator.ts`, generation-flow
  section). `createAppGenerationPort` passes **no** `generator`, and no
  other live caller passes one either.
- `LlmAppGenerator`, `VertexAiCodeGenBackend` (native
  `generateContent`, `VERTEX_DEFAULT_MODEL = 'gemini-2.5-flash-lite'`,
  `packages/service/src/artifacts/llm.ts:51`),
  `TestCodeGenBackend`, and the `resolveAppGenerator(mode, vertex)`
  switch (`llm.ts:289`) are **exported but never constructed** in
  product code (grep, tests excluded). The mode is "whichever backend
  object you construct" by design (`llm.ts` header) — and since nothing
  constructs either, there is **no env var, config endpoint, or UI
  setting** that selects test vs Vertex. The agent `/api/agent/config`
  provider switch (`heuristic` | `openai-compatible`) affects only the
  chat *planner* backend, never artifact codegen.

### Persistence and rendering

- Persistence: `generateAndSaveArtifact` validates the spec
  (`validateArtifactSpec`) and `store.add(spec)`. The web store is a
  service `MetadataStore<ArtifactSpec>` over **browser localStorage**
  (`apps/web/src/App.tsx:639`: `createArtifactStore(localStoragePersistence())`).
  Nothing is persisted server-side; artifacts do not survive a browser
  profile change and are not shared with the agent service.
- Rendering: `AgentChat` opens the artifact panel →
  `ArtifactFrame` (`apps/web/src/components/ArtifactHost.tsx:231`):
  sandboxed iframe (`sandbox="allow-scripts"`, opaque origin),
  `srcDoc` built by `buildArtifactSrcDoc` with React/ReactDOM UMD
  inlined (no CDN, no build step; generated source is plain JS
  `function App()` using `h()`).
- Two-way binding: iframe ⇄ host via `postMessage` bridge
  (`packages/service/src/artifacts/bridge.ts`): iframe sends
  `{ __icecream_bridge: 1, kind: 'call', tool, args }`; `ArtifactBridgeHost`
  validates against `ALLOWED_BRIDGE_TOOLS` (`read_cells, write_cells,
  set_formulas, get_results, recalculate, subscribe, unsubscribe,
  poll_events` — `bridge.ts` bridge-tool list) and executes through the
  host's `mcpCall`. Sheet→app liveness rides MCP `subscribe`/`poll_events`
  forwarded as bridge `event` messages; templates embed
  `mcp.subscribe(['cells_changed'], …)` reload + `mcp.call('write_cells', …)`
  commit-on-edit (`packages/service/src/artifacts/generator.ts`
  `LOADER_SNIPPET` / data-table template). **In gateway mode the
  transport under `mcpCall` does not exist** (null, above) — there is no
  gateway/MCP-http transport wired for artifacts; the MCP http service
  on `:8106` (`packages/mcp-server/src/http.ts:232`) is not referenced
  by the web artifact path at all.

**Live-run requirement:** two build items, no config-only path:
(a) give the web artifact lane a gateway-mode `McpCallFn` — e.g. wire
`artifactMcpCall` to the MCP http service (`:8106`) or a gateway
endpoint bound to the user's engine session (same binding question as
Headline 5; the MCP http server's host is its own `EngineHost`, see
`packages/mcp-server/src/http.ts:28` "All sessions share the
EngineHost" — that host is also not the browser's `:8101` session
without binding work); (b) construct the Vertex generator at the port:
`new LlmAppGenerator({ backend: new VertexAiCodeGenBackend({ project:
'dreamscapes-zero', getAccessToken }) })` passed as `generator` into
`generateAndSaveArtifact` (via `createAppGenerationPort` deps), with
`getAccessToken` resolving a GCP access token (vault seam per
`llm.ts:59` doc, or the deployer-token route in COORDINATION.md).
Then rebuild service+web dist and restart in a coordinated window.

---

## 3. Native chart into the sheet (case 4)

### What exists

- **MCP tools: none for charts.** The full tool surface in
  `packages/mcp-server/src/server.ts` (38 tools per COORDINATION.md)
  contains no chart create/insert/update tool; the only chart-shaped
  output is `analyze_data`/`rerun_analysis` returning a `chartSpec`
  JSON (analysis lane, §1) — a *chat-render* spec, not a workbook
  object.
- **`execute_code` cannot do it.** Its sandboxes expose no host API at
  all: JS runs in a fresh `node:vm` context whose only host data is the
  JSON `args` payload (no `require`, `process`, `fetch`, or engine
  bindings — `packages/mcp-server/src/sandbox/javascript.ts` header);
  Python runs under the restricted prelude (§1). The result is a JSON
  value and nothing else. There is no `sheets`/`charts`/`engine` object
  to call.
- **Engine: no chart API.** Charts are not engine-protocol objects.
  The native chart model lives in the service/web layer:
  `packages/service/src/chartModel.ts` (`ChartSpec`, `ChartKind` at
  `chartModel.ts:24`), persisted by the web in a localStorage-backed
  chart store (`apps/web/src/features/chartStore.ts:51`) and held in
  `App` state (`apps/web/src/App.tsx:824`, `restoreCharts()`).
- **Web UI insertion is user-only:** ribbon/command
  `insert.chart` (`apps/web/src/App.tsx:7828`) →
  `handleInsertChart` (`App.tsx:3272`) → `ChartDialog` →
  `handleCreateChart` (`App.tsx:3289`) commits the spec to App state +
  `persistCharts`. PivotCharts similarly via
  `handleInsertPivotChart` (`App.tsx:3305`).
- **AgentChat has no insert action:** an analysis reply renders the
  chart inline via `ChartCanvas` (`AgentChat.tsx:478`) with no button
  or callback to convert it into a sheet chart. `App.tsx` passes
  `AgentChat` only `runtime`, `sheet`, `artifactStore`,
  `artifactMcpCall` (`App.tsx:9080`) — no chart-insert prop exists.
- **Save/reopen caveat:** dialog-created charts persist in the
  browser's localStorage metadata store (`chartStore.ts`), i.e. they
  are *web-client* state, not workbook-file state; imported XLSX charts
  round-trip through the XLSX layer separately (`App.tsx:5636`
  `persistCharts(importedSpecs)` on import). A chart "inserted" by any
  hypothetical agent path into the web store would still not be in the
  saved `.xlsx` bytes unless the save path serializes it — the
  coordinator should treat file-level parse-back as the bar.

### What is missing for case 4 as the brief words it

Precisely three pieces, none present:
1. An MCP tool (e.g. `create_chart { sheet, range, kind, anchor }`)
   operating on a chart store **shared between the agent's MCP server
   and the web client** — today those stores are in different processes
   with no shared backend.
2. A workbook-persistence path for such charts (chart specs into the
   engine/save model), so save → reopen keeps the chart bound.
3. (Alternative UI route) an AgentChat "Insert into sheet" action on
   `reply.chart` that calls `App`'s `handleCreateChart` with a
   converted spec — the prop/callback does not exist.

**Live-run requirement:** a build item, not a config item: implement
(1)+(2) (MCP chart tool + shared/persisted chart store), or at minimum
(3) for a UI-mediated proof — and even (3) only proves localStorage
persistence, not file round-trip. **Case 4 is NOT RUNNABLE as briefed
today; report it as a build gap, not a validation failure.**

---

## 4. The wider five (cases 8–12)

### 8. ETL — UI runs in the browser; the `:8104` service is a stub the UI never calls

- **User entry point (exists):** `App.tsx` wires `onOpenEtl`
  (`apps/web/src/App.tsx:8292`) → `EtlEditor` dialog mounted at
  `App.tsx:8893`. Editor: `apps/web/src/components/EtlEditor.tsx` —
  recipe list, source editor (CSV text / JSON text / Web URL /
  Connector), applied-step list with live preview, schedule tab, run
  history; recipes persist in localStorage-backed stores
  (`apps/web/src/components/etlStores.ts`).
- **Execution path (web):** `EtlEditor.runNow` calls the service
  package's `runRecipe` **in the browser bundle** with a browser
  writer whose `writeAtomic` calls `onLoadTable(tableToGrid(table),
  tableName)` → `App.handleEtlLoad` writes the grid into the current
  workbook through the web host. URL sources are fetched by the
  browser (`fetchUrlSource` / `etlFetchText`). Custom-code steps are
  documented in the editor as "Runs sandboxed on the service host" —
  the browser runner has no `runCode`, so per the runner contract
  custom steps fail closed in this path.
- **Service `:8104`:** `packages/gateway/src/services/etlSvc.ts`
  exposes exactly `GET /health` and `POST /run { recipe }`. Its own
  header admits the local wiring is a stub: **empty `ConnectorRegistry`**
  (`etlSvc.ts` `const connectors = new ConnectorRegistry()`),
  fail-closed vault resolver, in-memory writer, no `runCode`, no
  permission check. Gateway client method `etlRun`
  (`apps/web/src/services/gatewayClient.ts:707`) exists but has **zero
  call sites** in the web app (grep). Gateway route:
  `/api/etl` → `:8104` (`bin/gateway.ts:56`).
- **Live proof would drive:** the EtlEditor UI with a CSV-text or URL
  source (no connector source — those fail closed on both paths) →
  "Run now & load" → verify rows in the grid. A service-level proof
  (POST `/api/etl/run` with an inline-source recipe) proves the runner
  only, with output landing in the service's in-memory writer —
  invisible to the sheet.

**Live-run requirement:** none for the UI path (works in gateway mode
insofar as the web host writes reach the `:8101` session — the same
host the grid uses). Do **not** plan the proof around `/api/etl/run`;
connector-backed recipes additionally need the prod wiring the
`etlSvc.ts` header describes (real registry + vault + engine writer).

### 9. Automation — web-local only; no gateway service, no trigger host

- **Service lane:** `packages/service/src/automation/` — permissioned
  `AutomationApi` over `EngineHost` (`api.ts`), `ActionRecorder`
  (`recorder.ts`), `runUserScript` sandbox (`userScript.ts`), and a
  `TriggerRuntime` for event/scheduled trigger specs
  (`runtime.ts:68`).
- **User entry points (exist, all web-local):**
  - Macro recorder: `App.tsx` `onOpenMacroRecorder`
    (`App.tsx:8216`) → `MacroRecorderDialog`; the recorder singleton
    lives in `apps/web/src/automation.ts` (`macroRecorder`,
    `recordAction` fed from grid actions); stopping renders an editable
    TypeScript script via `actionLogToScript`.
  - Macro list + script editor: `ribbonParity.tsx` owns
    `MacroListDialog` (`ribbonParity.tsx:1642`) and `ScriptEditor`
    (`ribbonParity.tsx:1645`). `ScriptEditor` runs scripts via
    `new AutomationApi(host, { principal })` + `runUserScript(…,
    timeoutMs: 10_000)` against the **web `host`** with a grant dialog
    first (`apps/web/src/components/ScriptEditor.tsx:348`).
- **What does NOT exist:** any automation endpoint in the gateway
  (grep: no automation references under `packages/gateway/src`), and
  any host — web or service — that constructs `TriggerRuntime`.
  Trigger specs can be authored as data but **nothing evaluates them**;
  there is no trigger/schedule UI. "Trigger it" in case 9 can only mean
  the manual **Run** button in ScriptEditor/MacroList today.

**Live-run requirement:** drive the web UI: record a macro (or author a
script in ScriptEditor), grant its declared permissions, Run, verify
cell effects in the grid. No stack config needed. If the coordinator
wants a true event/schedule trigger proof, that is a build item
(host `TriggerRuntime` somewhere) — flag as a gap, don't fake it.

### 10. Reports/dashboards — full web UI, local store; MCP report specs are a separate island

- **User entry point (exists):** `App.tsx` `onOpenReports`
  (`apps/web/src/App.tsx:8275`) → `ReportListDialog` /
  `ReportBuilderDialog` / `ReportViewerDialog`
  (`apps/web/src/components/Reports.tsx`, mounted `App.tsx:8368`).
  Specs live in React state seeded from the web report store
  (`App.tsx:935`, `restoreReports()` from
  `apps/web/src/features/reportStore.ts` — localStorage-backed) and
  persist via `persistReports` (`App.tsx:4037` `handleSaveReport`).
- **Data/render:** reads go through the web host's typed view
  (`readReportSource`/`readReportBinding`, `App.tsx:4020` / `App.tsx:4089`),
  with per-subject filtering (`App.tsx:4132`); the viewer computes KPI /
  pivot / table / heatmap / chart visuals and renders chart visuals via
  `ChartCanvas` (`Reports.tsx:595`); PDF export maps visuals to the
  native report-PDF path (`Reports.tsx:723`). Report→ETL refresh runs
  browser-side recipes (`App.tsx:4191` `handleRunEtlBindingsForReport`).
- **Service/MCP side:** `report_create_spec`/`get`/`list`/`update`/
  `delete` MCP tools (`packages/mcp-server/src/server.ts:1147` ff.)
  operate on the MCP server's own metadata store
  (`memoryPersistence()` in the agent process). **The web UI never
  reads that store and no gateway reports endpoint exists** — an
  agent-created report spec will not appear in the Reports UI, and a
  UI-created report is invisible to the agent. Two disjoint stores.
- **Live proof would drive:** Reports UI → New → build from the open
  sheet → viewer screenshot → verify figures against the sheet; the
  ETL-refresh button optionally exercises §8's browser runner.

**Live-run requirement:** none (pure web UI over the grid's host).
Set expectations: the proof is UI-only; agent/MCP report-spec interop
is a build gap if the coordinator wants it.

### 11. Add-ons — the one wider-five feature with a real gateway path

- **User entry point (exists):** `AddonManagerDialog` owned by
  `ribbonParity.tsx` (`onOpenAddonManager`, dialog mounted
  `ribbonParity.tsx:1648`) with Install / Enable / Disable / Uninstall /
  grant request-approve-deny-revoke / Run actions all wired
  (`ribbonParity.tsx:892` ff.).
- **Backend switch:** with a gateway token, the dialog's backend calls
  `GatewayClient.addons*` (`ribbonParity.tsx:789`) →
  `/api/addons/*` → addons service `:8107`
  (`packages/gateway/src/services/addonSvc.ts`): `GET /catalog`,
  `GET /installed`, `POST /install|enable|disable|uninstall`,
  `GET /grants`, `POST /grants/request|approve|deny|revoke|narrow`,
  `POST /run` (`addonSvc.ts:188`–`314`). Without a token it falls back
  to an in-memory service (`createMemoryAddonService`) — non-persistent,
  browser-only.
- **Catalog:** seeded in-process with exactly two signed sample
  listings (`packages/service/src/addons/catalog.ts:119`):
  `com.icecream.sample-sum-reporter` (read; sums a range) and
  `com.icecream.sample-cell-stamper` (read+write; stamps a cell) —
  both are genuine, exercisable capabilities for case 11.
- **Run binding:** `POST /run` resolves the document binding against
  the **engine service** (`packages/gateway/src/bin/addons.ts:27`:
  `ENGINE_SERVICE_URL` default `http://127.0.0.1:8101`;
  `createEngineServiceBinding` in
  `packages/gateway/src/services/addonEngineBinding.ts`), forwarding
  the caller's token/principal so `authorize()` runs as the granting
  user. Caveat for the tour: the web passes `documentId` defaulting to
  `'local-workbook'` (`ribbonParity.tsx` `addonDocumentId = ctx.documentId
  ?? 'local-workbook'`) — the coordinator must confirm the engine
  binding resolves that id to the actually-open file/session before
  crediting a Run result, and a grant must be requested **and approved**
  before Run is offered/fails-closed.

**Live-run requirement:** gateway token present (normal gateway login);
drive AddonManager → Install "Cell Stamper" (or Sum Reporter) → Enable
→ Request grant → Approve → Run → verify the stamped cell / reported
sum in the grid. Verify the `documentId`→session binding first (above);
if `/run` targets a different/empty workbook, that is the defect to
file. No extra stack config — addons `:8107` is started by the finisher
script.

### 12. No-code app builder — full builder UI exists; web-local store, MCP appbuilder specs are a separate island

- **User entry point (exists, as the brief requires — via the UI):**
  `App.tsx` `onOpenAppBuilder` (`apps/web/src/App.tsx:8283`) →
  `AppBuilderDialog` (`apps/web/src/components/AppBuilder.tsx`):
  4-step wizard (Data source → Views → Configure → Preview), template
  picker, live preview read through `host.getView().readRangeValues`
  (`AppBuilder.tsx` `readPreviewGrid`).
- **Create/run:** `onCreate` → `App.handleCreateApp`
  (`apps/web/src/App.tsx:3847`): `appStore.add(spec)` where `appStore`
  is a module-level service app store over web persistence
  (`App.tsx:578`), then the app opens immediately in
  `AppRunnerDialog`. The runner (`apps/web/src/components/AppViews.tsx`)
  executes views/actions through an engine-protocol port over the web
  `host`: reads via `host.getView()`, writes via `host.execute({...,
  auth})` with an `authorize('app.read'|'app.write'|'app.manage', …)`
  check (`AppViews.tsx:102`), and re-renders on `host.subscribe`
  (`AppViews.tsx:531`) — i.e. **live two-way sheet binding in the web
  client**, including in gateway mode to the extent the web host
  reflects the gateway session.
- **The other island:** MCP `appbuilder_create_spec`/`get`/`list`/
  `update`/`delete` tools (`packages/mcp-server/src/server.ts:982` ff.)
  + service `src/appbuilder/` (spec/templates/actions) serve the
  agent/MCP surface with their own store. The web builder never calls
  them; there is no gateway appbuilder endpoint. Specs created in the
  UI do not appear via `appbuilder_list_specs` and vice versa. (The UI
  and MCP lanes do share the service spec *types*/validation —
  `generateAppSpec`, `validateAppSpec` imported by `AppBuilder.tsx`
  from `@icecream-sheets/service`.)

**Live-run requirement:** none — drive the builder UI exactly as case
12 words it (build via UI → runner opens → edit a record in the app →
verify the sheet cell; edit the sheet → verify the app view updates).
Judge it against the web store only; do not require the app to appear
in MCP `appbuilder_list_specs` (disjoint store, above).

---

## 5. Data sources (case 7)

### The MCP route (`open_data_source`)

- Tools: `list_data_sources` / `open_data_source` /
  `refresh_data_source` (`packages/mcp-server/src/server.ts:1708`,
  `:1729`, `:1774`). A source is **defined purely by tool arguments** —
  `{ kind, label?, params: Record<string,string>, credentialRef?,
  sheetName? }`; there is no config file, no admin API, no registry
  file. The tool builds a `ConnectorSpec`, calls
  `dataSourceRegistry.fetch(spec, dataSourceDeps)`, materializes the
  table as a **new sheet in that MCP server's `EngineHost`**, and
  stores the binding in a `DataSourceStore` over
  `options.persistence` (default `memoryPersistence()`).
- Kinds: the MCP enum allows `csv-url, json-url, rest-api, sql,
  google-sheets` (`connectorKindSchema`, `server.ts` at the
  data-source section); the underlying registry
  (`packages/service/src/connectors/registry.ts:147`
  `createConnectorRegistry`) also registers `marketdata` and `mail`.
- **CSV (case 7a):** `CsvUrlConnector`
  (`packages/service/src/connectors/csv.ts`) fetches an **http(s) URL**
  via injected `fetchText` (default: global `fetch`,
  `registry.ts` `resolveDeps`) and parses via the csv-adapter. There is
  no local-file CSV kind — a "CSV source" for the MCP route must be
  served over HTTP. In the agent process this fetch works (Node
  global fetch), but the materialized sheet lands in the agent's
  private workbook (Headline 5), invisible to the browser grid.
- **SQL (case 7b): NO driver on this route — it cannot work.**
  `SqlConnector` (`packages/service/src/connectors/sql.ts`) requires
  an injected `SqlDriver` (`ConnectorDeps.sqlDriver`,
  `packages/service/src/connectors/registry.ts:56`); the service
  package ships **no driver and no DB dependency** (no `pg`,
  `better-sqlite3`, etc. — the module header says so explicitly).
  `fetch()` throws `"no SQL driver configured…"` when absent. Neither
  live host injects one: the agent service calls
  `createServer(undefined, { hitlTimeoutMs })`
  (`packages/gateway/src/services/agentSvc.ts:137`) and the MCP http
  host calls `createServer(host, { persistence, defaultPrincipal })`
  (`packages/mcp-server/src/http.ts:232`) — no `dataSources` options
  anywhere. The only `SqlDriver` implementations in the repo are the
  test-only in-memory `FakeSqlDriver` (`sql.ts`, `SELECT * FROM
  <table>` over registered in-memory tables) and the web HTTP driver
  (below). Also note the spec semantics: `params.connection` is an
  opaque connection **NAME**, not a connection string — the brief's
  "configured directly with a connection string" matches the
  *connectors-service* flow below, not this MCP tool.
- What the SQL spec needs (for completeness): `params = { driver,
  connection, query, params? }` + optional `credentialRef` (requires a
  wired `resolveCredential`, also absent on the MCP route).

### The route that actually works: web UI + connectors service (`:8108`)

- A real SQL driver **does** exist, one layer over:
  `packages/gateway/src/services/connectorSvc.ts` uses **`node:sqlite`
  `DatabaseSync`, opened read-only** (`connectorSvc.ts:34`,
  `openReadOnly` at `connectorSvc.ts:218`), with a read-only statement
  allowlist (single statement; SELECT / WITH…SELECT / EXPLAIN / read
  PRAGMA; 10 000-row cap). Endpoints: `POST /credential/store`,
  `POST /sql/store-connection`, `POST /sql/tables`,
  `POST /sql/schema`, `POST /sql/query` (`connectorSvc.ts:287`–`372`).
  Connection strings are **SQLite only**: `sqlite://<path>`,
  `sqlite:<path>`, or a bare absolute path — any other scheme is
  rejected (`sqlitePathFromConnectionString`, `connectorSvc.ts:70`).
  The string is stored once in the vault under
  `${principal}:ds:sql:<connection>`; thereafter only the NAME travels.
- Web wiring: `createHttpSqlDriver(gateway)`
  (`apps/web/src/services/httpSqlDriver.ts:13`) implements the service
  `SqlDriver` seam by forwarding `{ connection, sql, params }` to
  `gateway.connectorsSqlQuery`; `buildConnectorDeps`
  (`apps/web/src/features/dataSources.ts:63`) bundles it (plus a
  vault-backed credential resolver) for gateway mode, `{}` in local
  mode. `OpenDataSourceDialog` (entry: `App.tsx:8144`
  `onOpenDataSource`, mounted `App.tsx:8881`) in gateway mode stores
  the connection via the gateway, lists tables, previews schema, then
  `registry.fetch(spec, connectorDeps)` and `App.handleOpenDataSource`
  (`apps/web/src/App.tsx:7321`) materializes the table into the **real
  browser/gateway workbook** and persists a binding (web
  `features/dataSources.ts` store, localStorage-backed) for Refresh.
  CSV-URL sources take this same UI path (browser fetch).
- **Blocker:** the finisher script does **not** start `:8108` (see §6),
  and `packages/gateway/dist/bin/` contains `service.js` (combined
  runner, which includes the connectors listener —
  `packages/gateway/src/services/servicePackage.ts:82`) but **no
  `connectors.js`** — the standalone bin exists in src
  (`packages/gateway/src/bin/connectors.ts`) and needs a build, or the
  combined runner must be started instead.

### Lightest real local DB

**SQLite file.** Seed it with the system `python3` (3.12.3 on this VM,
stdlib `sqlite3`) or Node's built-in `node:sqlite` — zero installs.
Store `sqlite:///abs/path/to/test.db` via the dialog /
`/api/connectors/sql/store-connection`, then query it. (Postgres/MySQL
are not options: no driver for them exists anywhere in the repo.)

**Live-run requirement:** start the connectors service before the
tour — either build the gateway package and run
`PORT=8108 node packages/gateway/dist/bin/connectors.js`, or run the
combined `dist/bin/service.js` on a free port and point
`CONNECTOR_URL` at it — in a coordinated stack window (do not restart
the finisher stack unilaterally). Seed a SQLite file as above. Then:
case 7a (CSV) and 7b (SQL) can be proven **via the web UI + agent over
the materialized sheet** (open source → sheet appears → chat query over
that sheet, subject to Headline 5's binding fix). As literally briefed
("same MCP tools" for SQL), case 7b is **impossible without a build
item**: inject a `SqlDriver` (e.g. a `node:sqlite`-backed adapter over
`connectorSvc`'s logic) into `createServer`'s `dataSources` options in
`agentSvc.ts` / MCP http host. CSV via MCP `open_data_source` works
mechanically (HTTP-served CSV) but lands in the agent's private
workbook.

---

## 6. Stack config

### How the running stack was started

`hidden_files/start-stack-finisher.sh` (mirrors `e2e-gateway.sh`):
from `packages/gateway/dist/bin/` it starts engine `:8101`
(`--expose-gc --max-old-space-size=6144`), vault `:8102`, meta `:8103`,
etl `:8104`, agent `:8105`, addons `:8107`; from
`packages/mcp-server` it starts `dist/bin/http.js` on `:8106`; then
gateway `:8100`; then `npx vite preview --port 4173` for the web dist.
Env set by the script: only `AUTH_SECRET` (redacted in this report)
and `RATE_LIMIT_POINTS`/`RATE_LIMIT_WINDOW` defaults. **Not started:
connectors `:8108` / combined service `:8108`** (§5 blocker). Ports are
also baked as gateway proxy defaults in
`packages/gateway/src/bin/gateway.ts:53` (`/api/engine`, `/api/vault`,
`/api/meta`, `/api/etl`, `/api/agent`, `/api/addons`,
`/api/connectors` → `8101/8102/8103/8104/8105/8107/8108`, each
overridable via `ENGINE_URL`/`VAULT_URL`/`META_URL`/`ETL_URL`/
`AGENT_URL`/`ADDONS_URL`/`CONNECTOR_URL`).

### LLM-related env — nothing to set; the seams are constructor/config based

Grep over `packages/service/src`, `packages/gateway/src`,
`apps/web/src` for `VERTEX*`, `LLM_*`, `GCP_*`, `OPENAI*`,
`GOOGLE_APPLICATION_CREDENTIALS`, `process.env`:

- The **only** Vertex references in product code are in
  `packages/service/src/artifacts/llm.ts`: constants
  `VERTEX_DEFAULT_MODEL = 'gemini-2.5-flash-lite'` (`llm.ts:51`) and
  `VERTEX_DEFAULT_LOCATION = 'us-central1'` (`llm.ts:52`); project,
  model override, and `getAccessToken` are **constructor arguments** to
  `VertexAiCodeGenBackend` (`llm.ts:59`). No env var is read for them
  anywhere, and (§2) nothing constructs the backend.
- `GOOGLE_APPLICATION_CREDENTIALS` appears only in the gateway deploy
  layer (`packages/gateway/src/deploy/sessionStore.ts`) for prod
  session storage — unrelated to LLM calls. `GCP_PROJECT_ID` is read
  by the engine bin for the prod upload store
  (`packages/gateway/src/bin/engine.ts:52`) — also unrelated.
- The agent **planner's** live LLM switch is not env either: it's the
  per-principal config API (`GET/POST /api/agent/config`,
  `packages/gateway/src/services/agentSvc.ts`) with providers
  `heuristic` (default) | `openai-compatible` (baseUrl + model + key
  in the service vault under `agent:<principal>:model-api-key`), via
  `DelegatingModelBackend`/`createModelBackend`
  (`packages/service/src/agent/config.ts`, `openaiBackend.ts`).
  COORDINATION.md already documents pointing this at Vertex's
  OpenAI-compatible endpoint with a minted deployer token — that
  configures the *planner*, and would make `analyze_data` reachable by
  a real model, but it does **not** affect Python generation (§1,
  templates) or app codegen (§2, unwired).

**Live-run requirement:** for Vertex **codegen** there is no env-only
flip — it needs the §2 build wiring (construct
`VertexAiCodeGenBackend({ project: 'dreamscapes-zero', getAccessToken })`
→ `LlmAppGenerator` → pass as `generator`), a service+web dist rebuild,
and a coordinated restart of the affected processes (agent/web at
minimum). For the Vertex **planner**, use the existing designed seam:
`POST /api/agent/config` with the Vertex OpenAI-compatible baseUrl +
`google/gemini-2.5-flash-lite` + a freshly minted access token as the
apiKey (token ~1 h life; never persisted outside the vault). The
finisher script needs no changes for either, except the §5 connectors
service addition.

---

## Design-doc conflicts flagged (AGENT.md §0)

1. **Dangling design reference — "data-analysis component":** the
   analysis lane's code repeatedly cites a data-analysis design doc
   (e.g. `packages/service/src/analysis/index.ts` header,
   `packages/mcp-server/src/server.ts` analysis section), but
   `design-docs/` contains no such file and AGENT.md §0's index of 17
   docs does not list one. The lane's authority is currently code
   comments + the brief, not a design doc.
2. **ai-agent.md §3 / AGENT.md §2 (agent acts as the user, through MCP,
   sees the user's views):** in gateway mode the agent's MCP server
   owns a private, empty `EngineHost` (`agentSvc.ts:137` +
   `server.ts:228`) with no binding to the user's engine-service
   session — in effect the agent does *not* act on the user's workbook.
   This is the coordinator's binding question; flagged here as a
   design conflict in effect, pending W1's probe evidence.
3. **ai-agent.md §5 / intentRouter header ("analysis produces a
   Chart.js visual, rendered"):** the gateway path silently drops the
   visual at `RemoteAgentBackend` (Headline 1) — implementation
   contradicts the documented chat behavior.
4. **etl-pipeline.md §6–§7 vs `etlSvc.ts`:** the gateway ETL service's
   own header documents that prod wiring (real connector registry,
   vault, engine writer, permissions) is absent locally; the running
   `:8104` is a stub by its own admission. The functional ETL path is
   the browser editor, which the design assigns to the service host
   for scheduled runs (the editor itself notes "the service host
   evaluates it (no scheduler in this client)" — and no host does).
5. **automation-lane.md (triggers):** `TriggerRuntime` exists with no
   host anywhere — trigger specs are unexecutable in the shipped
   wiring (§4.9).
6. **native-reports-and-dashboards.md / no-code-app-builder.md
   (specs in the service metadata store):** the web Reports and
   AppBuilder lanes persist specs in browser-localStorage metadata
   stores while parallel MCP spec stores exist server-side; the two
   never meet (§4.10, §4.12). Whether localStorage counts as "the
   service metadata store" for the web client is the standing pattern
   (charts/artifacts do the same), but the MCP↔UI disjointness means
   "the agent and the user see the same reports/apps" is not true
   today.
7. **No conflict found** for add-ons: `add-on-model.md` §5's engine
   binding is implemented as designed (`bin/addons.ts` +
   `addonEngineBinding.ts`), subject to the `documentId` verification
   in §4.11. Artifact bridge tool restrictions match the AI-generated
   app pattern (data-plane tools only, `bridge.ts`).

## Appendix — quick reference for the coordinator

| Case | Route that exists today | Blocking defect |
|------|------------------------|-----------------|
| 3a analysis | Chat → gateway → agentSvc → heuristic/LLM planner → `analyze_data` (templates + pinned-venv sandbox) | Agent private EngineHost (binding); `RemoteAgentBackend` drops `chart` |
| 3b app gen | Browser-bundle `generateAndSaveArtifact` + `TemplateAppGenerator` (local mode only) | `artifactMcpCall = null` in gateway mode; Vertex generator never constructed |
| 4 native chart | None for agent; UI-only chart creation | No MCP chart tool, no shared/persisted chart store path, no AgentChat insert action |
| 7a CSV | MCP `open_data_source` (HTTP URL) or web Open Data Source dialog | MCP route lands in agent's private workbook |
| 7b SQL | Web dialog + connectors svc (`node:sqlite`) | `:8108` not started / bin not built; MCP route has no driver at all |
| 8 ETL | `EtlEditor` UI, browser-side `runRecipe` | `:8104` service is an unwired stub; connector sources fail closed |
| 9 automation | Macro recorder + ScriptEditor (web, local host) | No trigger host; manual Run only |
| 10 reports | Reports UI (builder/viewer/PDF), web store | MCP report specs disjoint from UI store |
| 11 add-ons | AddonManager UI → gateway → `:8107`, engine-bound `/run` | Verify `documentId`→open-session binding; grant flow required |
| 12 app builder | `AppBuilderDialog` UI → web app store → `AppRunner` over web host | MCP `appbuilder_*` specs disjoint from UI store |
