# AGENTIC FEATURES — FINAL REPORT (coordinator, 2026-10-22 ~08:15 PDT)

Verdict key: PASS = live evidence on disk · FAIL = live evidence of wrong
behavior · FAIL-GAP = capability absent in the product · NOT RUN = no
artifact-backed evidence (prose claims from dead workers are NOT counted).

## Per-case verdicts 1–20

| # | Case | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Table query in chat | **NOT RUN** (blocked, see D2) | UI turns on workbook pages never reached the gateway agent (diag-net: zero /api/agent requests; chat spins local). API-level equivalent proven in the FIX-B probe (agent read live grid values) |
| 2 | Read + write prompts | **NOT RUN** (blocked, D2) | API-level write proven in FIX-B probe (agent C1=424242 read back via engine API) |
| 3a | Analysis route | **NOT RUN** (blocked, D2) | Pipeline exists (FIX-D); live UI run not completed |
| 3b | Generated-app route | **NOT RUN** (blocked, D2) | Backend built + unit-proven (FIX-E); live UI generation not completed |
| 4 | Native chart into sheet | **NOT RUN** (blocked, D2) | Full machinery built + real-engine parse-back test PASSES (FIX-G/G2: valCache [10,20,30] in xl/charts/chart1.xml); live chat→grid→save→reopen tour not completed |
| 5 | Multi-step chain | **NOT RUN** (blocked, D2) | — |
| 6 | Honesty (unfulfillable) | **NOT RUN** (blocked, D2) | Behavior covered by prompt + scope tests (FIX-H/J) |
| 7 | CSV + SQL sources | **NOT RUN** | Shared fixtures staged (hidden_files/shared-fixtures, ground truth SUM=4027.86); phase-C script exists, was never run before the worker died |
| 8 | ETL recipe | **PASS** | TOUR-W4.md + cases/case-08/ (Filter→Sort preview exact; "Loaded 3 rows") |
| 9 | Automation | **FAIL-GAP** | Manual script leg works live (cases/case-09/ DOM shows the script's cell write); NO trigger surface exists in the product UI (`triggerUiFound:false`) — TriggerRuntime is hosted nowhere |
| 10 | Reports/dashboards | **PASS** | cases/case-10/ (KPI cards 58 / 7 match ground truth) |
| 11 | Add-on install + use | **FAIL** | cases/case-11/: installed + granted + ran, but bound to document `local-workbook` while file-27fddeba… was open — the web add-on host does not pass the open gateway file's id |
| 12 | No-code app builder | **NOT RUN** | Worker timed out on a ribbon selector; coordinator re-run not completed |
| 13 | Over-cap paste | **NOT RUN** live (unit-proven) | FIX-H/H2: server-side cap 2,000 default; 2,001-char boundary test; rejection names limit + rationale. A worker prose-claimed FAIL live; never reproduced with artifacts |
| 14 | Weather declined | **NOT RUN** live (unit-proven) | FIX-J classifyScope declines weather deterministically (tests). A worker prose-claimed it was answered as a workbook question live; never reproduced with artifacts — flagged for re-test |
| 15 | Borderline in-scope | **NOT RUN** live (unit-proven) | classifyScope in-scope families tested green |
| 16 | "Who is Einstein?" | **NOT RUN** live (unit-proven) | classifyScope trivia families declined (tests) |
| 17 | Product question answered | **NOT RUN** live | Note: NO product-docs corpus exists — answers are model-parametric; reliable for function semantics, ungrounded for this app's UI flows |
| 18 | Cross-session data question | **NOT RUN** | — |
| 19 | Session memory | **NOT RUN** live (worker prose-claimed PASS, no artifacts) | threads.ts per §9 exists + FIX-J persist() fix |
| 20 | Long-term memory | **PASS** | fixes/fix-k-report.md + cases/case-20/transcript.json: S1 memory_save×(protocol) via MCP tools; NEW session recalled "Friday" via memory_load after one live HITL nudge — with a disclosed blemish: the planner's first instinct in a fresh thread can still be to ASK for the fact (now named verbatim in the prompt as forbidden); recall completes after the user points it at its memory |

## Decisions Addendum items (verdict + evidence)

- **A1 cap 2,000 (configurable, raw input only, rejection names limit +
  rationale)** — BUILT (FIX-H/H2, guardrail tests incl. 2,001 boundary).
- **A2 rate 30/min, concurrency 3/principal, reply bound 8,000** — BUILT
  (FIX-H tests).
- **B two-source scope** — BUILT (FIX-J classifyScope + TWO-SOURCE prompt
  block; Einstein/capital/trivia/weather declined deterministically;
  greetings in-scope by design). Live UI confirmation outstanding (D2).
- **C MCP-tools-only execution** — PROVEN at the binding level (FIX-B:
  gateway runtimes wrap the LIVE engine session; probe3 transcripts show
  reads/writes landing on the real grid).
- **D memory both kinds** — session threads (threads.ts, FIX-J persist
  read-modify-write) + long-term ONLY as MCP tool calls. **LangGraph:
  zero references — NOT introduced.** Case 20 PASS live.
- **E component naming** — packages/service/src/agent ("AI Agent") as
  specced.
- **Connector-setup UI** — PROPOSAL ONLY (below); nothing built, per brief.

## Everything built/fixed (coordinator + workers, all in-tree)

FIX-A planner contract (exact zod-mirrored schemas in prompt; real MCP
error text surfaced) · FIX-B **the binding** (gateway agent runtimes wrap
the live engine session via NodeRemoteEngineHost + agentSessionResolver —
before this, the web agent answered from a private stale workbook) ·
FIX-D web maps analysis charts into AgentReply · FIX-E app generation in
gateway mode (Vertex LlmAppGenerator; /artifacts/generate fail-closed
503 without a token, no template fallback; /tools/call server-side
allowlist, everything else 403) · FIX-F trace (UI charts never become
native parts) · FIX-G native charts end-to-end (xlsx-adapter
chartsAuthor.ts; POST /charts + journaled `chart.add` op + rehydrate
replay; web onCharts merge; MCP create_chart; real-engine parse-back
test) · FIX-G2 create_chart in the agent's default tools + prompt ·
FIX-H/H2 guardrails (cap/rate/concurrency/output, deterministic scope
classifier) · FIX-J MemoryStore.persist() + scope tightening + two-source
prompt · FIX-K→K4 memory protocol in the planner prompt (index
convention, recall-first, answer-directly, anti-ask rule — case 20) ·
functions.ts TS2367 cast (function-coverage workstream owns the real
fix) · start-stack-agent.sh env repairs (ENGINE_ACCESS_MODE=signed,
ENGINE_ACCESS_SECRET, MCP_AUTH_SECRET).

⚠️ **RATIFICATION FLAG: `chart.add` is an additive journal op kind —
needs the design owner's ratification.**

## Defects found (not fixed — owned by other workstreams / need decisions)

- **D2 (TOUR-BLOCKING, web/phase-2): the web app's gateway engagement
  from a workbook page is unreliable post-reboot.** Diag evidence
  (cases/diag-net.mjs, diag-creator.mjs): a #file= deep-link join makes
  ZERO gateway requests and never paints; the chat then runs the LOCAL
  in-page runtime (deterministic backend, capability-menu replies,
  turns that spin forever) instead of the Vertex-backed gateway agent.
  Creator-upload pages DO reach the gateway (upload-grant, staged PUT,
  session-extras all fire) but open slowly. Pre-reboot, joins painted
  ~50% and one full trace succeeded; post-reboot the join leg has not
  painted once in 6+ attempts. Fix direction (from the earlier trace):
  the initial range fetch is not re-triggered when the active sheet's
  usedrange resolves; also the engine 500s on reads for the
  not-yet-known placeholder sheet instead of answering benignly.
- **D-JOIN-RACE** is the same defect family (recorded in COORDINATION.md).
- **FIX-B residuals**: (1) runtime swap can orphan a parked HITL turn;
  (2) prod/Firestore registry lacks a list op → resolver needs a listing
  adapter; (3) **non-creator participants don't bind yet** (opens record
  only creatorPrincipal); (4) **minted tokens are always 'editor' — a
  viewer-joiner's agent could write**; (3)+(4) share one fix;
  (5) subscribe() polls /events every 1.5s, not SSE.
- **Case 9 trigger GAP**; **Case 11 wrong-document binding** (above).
- **Ops trap (hit 3×)**: gcloud access tokens are cached — a config
  posted with a nearly-expired token passes hasKey at POST time, then
  every planner call 401s and the runtime falls back SILENTLY to the
  deterministic backend with ~5-minute turns. Mint fresh + verify with a
  live test message before touring; consider a config-time probe in the
  product.
- **Design-doc conflicts**: dangling "data-analysis" doc reference;
  etl-pipeline §6–7 vs the stub :8104 service (the real ETL path is the
  browser EtlEditor/runRecipe — case 8 used it); unhosted automation
  triggers (case 9); reports/appbuilder MCP↔UI store disjointness; no
  product-docs corpus for case-17 grounding.

## Connector-setup UI proposal (proposal only — NOT built)

Workspace "Data sources" → "Add source": a form that takes name, kind
(SQL), and a connection string; the password portion is routed to the
vault seam (never persisted in the file record — refs only, the pattern
the gallery program proved: secret absent from localStorage, logs, and
bindings). "Test connection" lists the database's tables; on save, the
source appears in the Workspace list like a file and opens into the grid
through the existing connector registry (registry.ts already holds
CSV/JSON-URL, REST, and SQL connectors). The agent reaches the source
only through MCP tools (list/read on the connector), same as files.
Open question for the user: connection-string-only, or discrete
host/port/db/user fields composing the string client-side?

## What remains before this deploy-gate condition clears

1. **D2 fixed** (web join/boot reliability) — then re-run the UI tours:
   cases 1–7, 12, 13–19 live (scripts + fixtures all staged:
   cases/tour-core.mjs, w3a.mjs, w3b-work/, shared-fixtures/).
2. Case 9 needs a product decision: host the TriggerRuntime (UI + a
   scheduler) or descope triggers from the automation claim.
3. Case 11's document-binding fix (add-on host must pass the open file id).
4. FIX-B residuals (3)+(4) — participant binding + role-scoped tokens —
   before co-authoring ships.
5. `chart.add` journal-op ratification.
6. Case 14's worker claim (weather answered as a workbook question)
   re-tested live once D2 clears — if real, it contradicts the
   deterministic classifier and needs a root cause in the live path.

Environment note: the VM rebooted at least twice during this session
and the web dist was rebuilt mid-session by a sibling workstream
(apps/web/dist, 2026-10-22 08:06) — tour results straddling those
events are flagged as such above.
