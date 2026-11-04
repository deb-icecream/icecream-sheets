# Agentic Features — Live End-to-End Validation (+ fixes) — BRIEF

Issued: 2026-10-21. User design + playback confirmed in chat 2026-10-21
16:08–16:14 PDT, including the user's correction: the WIDER five
AI-native components are IN SCOPE for this gate (not a second tier).

## Verified starting state (parent, code-checked 2026-10-21 16:1x PDT)

All of the following EXIST as real modules with dedicated test suites
(76 test files in packages/service/tests): agent runtime
(packages/service/src/agent: runtime, intentRouter, backends, threads),
data analysis (src/analysis + src/python), generated-app artifacts
(src/artifacts + src/appbuilder, llm.ts on Vertex), ETL (src/etl),
automation lane (src/automation), reports/dashboards (src/reports),
add-ons (src/addons), connectors incl. SQL (src/connectors: csv, json,
rest, sql, registry, vault seam). Web wiring exists: AgentChat.tsx,
ArtifactHost.tsx, AppBuilder.tsx, features/dataSources.ts.

THE GAP this brief closes: the live path has never been validated end
to end — test-mode codegen was network-isolated by design, so no run
has yet driven the REAL chat UI with the REAL model. The user requires
that validation BEFORE deployment; anything it exposes as missing or
broken gets BUILT/FIXED, then re-validated. This workstream is a
DEPLOY-GATE condition.

## Model & access

- Model: **Vertex AI Gemini, gemini-2.5-flash-lite** (the standing
  cheap-model ruling; VERTEX_DEFAULT_MODEL in
  packages/service/src/artifacts/llm.ts). NO test backend, NO mocks on
  the live path.
- Local access: GCP project dreamscapes-zero; credentials via the
  deployer key at ~/.config/gcp/deployer-key.json (it holds
  aiplatform.user for deployer-side Vertex validation) wired through
  the service's credential vault/config seams. NEVER print, log, or
  commit credential values. If the local service config lacks a Vertex
  project/credentials setting, add it behind config (defaults preserve
  existing behavior).

## Validation matrix — live, real browser, local stack (production topology)

Every case: prompt typed into the REAL AgentChat UI in a real browser
against the local stack; the agent acts ONLY through MCP tools;
evidence = chat screenshots + tool-call transcripts + the resulting
sheet state (values/formulas read back) + save/reopen where stated.
Numbers in analysis results are checked against independently computed
values. A case without evidence is NOT RUN.

### A. Core agent loop (user's four families)
1. **Table query in chat**: select-style prompt (named columns, row
   limit, a filter condition) over an open workbook → result table
   rendered INLINE in chat; rows/values match the sheet exactly.
2. **Read + write prompts**: agent reads values/formulas from the
   sheet, then writes (set cells, apply a change) → sheet state
   verified cell-by-cell afterwards.
3. **Analysis + visualization inline**: analysis prompt → visual
   rendered inline in chat. Exercise BOTH routes and prove the intent
   router chose correctly: (a) data-analysis route (schema → Python →
   deterministic execution → Chart.js visual), results numerically
   verified; (b) generated-app route (LLM-generated React/JSX app,
   MCP as backend, embedded in chat as a persistent artifact, two-way
   live binding — an edit in the app writes back to the sheet).
4. **Native visual into the spreadsheet**: prompt → agent inserts a
   NATIVE chart (a supported kind) into the sheet itself, bound to
   sheet data; visible in the grid; save → reopen → still present and
   bound.

### B. User's accepted additions
5. **Multi-step chain**: one prompt requiring several sequenced tool
   calls (read → compute → write → re-read to confirm); transcript
   proves the chain, final state correct.
6. **Honesty case**: a prompt that cannot be fulfilled (missing data /
   ambiguous target) → agent declines or asks, and invents NOTHING;
   sheet unchanged.
7. **Non-Excel sources**: repeat case 1 (and one write-free analysis)
   against (a) a **CSV** source and (b) a **SQL** source — the SQL
   connector (src/connectors/sql.ts) configured directly with a
   connection string against a LOCAL SQL database seeded for the test
   (no external dependency); same MCP tools, same chat behavior.

### C. The wider five — live proof each (implement/fix whatever fails)
8. **ETL pipeline**: define + run a recipe from a source to a sheet;
   output rows verified.
9. **Automation lane**: record or author an automation; trigger it;
   its effect on the sheet verified.
10. **Reports/dashboards**: generate a report/dashboard from sheet
    data; rendered output screenshot; figures verified.
11. **Add-on model**: install/enable an add-on from the catalog; its
    contributed capability exercised in the sheet.
12. **No-code app builder**: build an app via the builder UI (not only
    via chat); it reads/writes the sheet live.

## Out of scope for the build (proposal only)

**Workspace connector-setup UI** — the user asked for a proposal
first ("come up with your suggestions, then we can talk"). Write the
proposal into your final report (flow: Workspace "Data sources" →
Add source → type → for SQL a connection-string/fields form with the
password captured via secure vault → connection test listing tables →
source appears in the workspace like a file → opens to the grid view;
agent sees it via the same MCP tools). DO NOT build this UI in this
workstream; case 7 configures the SQL connector directly.

## Addendum — Agent guardrails (user directive 2026-10-21 17:08 PDT, binding)

1. **Anti-abuse limits, enforced server-side in the agent runtime
   (not UI-only):** per-request input length cap — **default 2,000
   characters** (configurable; refined by the user 2026-10-21 17:34
   PDT: the earlier 10,000 figure was his example of abuse, NOT the
   limit). Reject over-cap input with a clear message naming the
   limit AND the rationale (normal chat prompts are a few hundred
   characters; longer content belongs in a file/data source the
   agent reads via tools), with no planner/tool activity. Plus
   sensible per-user request-rate and concurrency limits; output
   bounds (iteration cap already exists; reply-size bound).
2. **Scope restriction — TIGHTENED (user, 2026-10-21 17:40 PDT;
   supersedes all earlier phrasing):** the agent may answer ONLY
   from two sources — (1) **the DATA IN CONTEXT**: the user's
   sheets, files, and connected data reachable through its tools;
   (2) **ICECREAM-SHEETS-SPECIFIC knowledge**: how the product
   works, its features and functions. **EVERYTHING else is
   declined** — no general knowledge, no trivia, no news, no
   chit-chat, regardless of topic (weather, "Who is Einstein?",
   general facts). Decline politely + redirect to in-scope
   capabilities; never answer from the model's general knowledge,
   no workarounds. Enforced at the intent router / runtime gate
   (the case-6 honesty pattern), with the planner prompt carrying
   the same rule as a second layer. Legitimate use must not break:
   every prompt family in cases 1–12 and 15 is in scope, and
   product questions (case 17) are answered from source (2).
3. **Validation cases added:** (13) a paste above 2,000 chars is
   rejected with the limit named, sheet unchanged — AND a legitimate
   ~1,500-char detailed request still works; (14) off-topic question
   (weather) declined politely, no fabricated answer, sheet
   unchanged; (15) a borderline data question that IS in scope still
   works end-to-end; (16) "Who is Einstein?" declined identically —
   no biographical answer, sheet unchanged. Evidence bar unchanged
   (screenshots + transcripts + read-backs). Report what already
   existed vs what was built.
4. **Memory (user, 2026-10-21 17:40 PDT; design-docs/ai-agent.md
   §9 + §12 are the authority):** the chat system must have BOTH
   (a) **session memory** — the current session's thread state
   (believed implemented: agent/threads.ts, per-user versioned
   records in the service metadata store, checkpointed per turn —
   VERIFY); and (b) **long-term user memory** — what the agent
   explicitly saves about the user across sessions, operated ONLY
   as versioned MCP tool calls (load/save/update memory per §12;
   no private channel). **LangGraph is NOT used and must NOT be
   introduced** (§12: no third-party orchestration library holds
   the thread state; the runtime is our own
   packages/service/src/agent/runtime.ts). **Validation cases
   added:** (17) product question ("how do I create a pivot
   table?" / "what does XLOOKUP do?") → ANSWERED correctly from
   product knowledge; (18) a context question about the user's own
   data from an earlier session, asked in a new session against
   the same workbook → answered from the data in context;
   (19) session memory — within one chat session, refer back to
   something established earlier in the same session ("the total
   you computed before") and show the agent uses it correctly;
   (20) long-term memory — in session 1 the agent saves a user
   fact via the memory tools; in a NEW session it is recalled and
   used; tool-call transcripts shown for both. If any of this is
   missing in code, BUILD it per the design doc and report
   precisely what was missing; flag design conflicts instead of
   deviating.

## Sequencing

Two other coordinators are active (Phase 2 validation; product layer).
Coordinate dist rebuilds and browser processes: one browser process
per output dir, never rebuild apps/web/dist while another coordinator
is mid-tour — check their report dirs for completion signals and
sequence accordingly; if blocked on a dist window, do the
service-level and MCP-level proofs first and say exactly what waits.

## Rules

- Design docs govern their domains (AGENT.md §0); flag conflicts,
  never rescope. No stubs: a feature that fails live validation is
  reported FAILED with the defect, fixed, and re-validated — or
  reported NOT FIXED with the reason. Never present test-backend or
  mocked results as live validation.
- NO git push — the parent pushes and byte-verifies.
- Final report: per-case verdicts (1–20) with evidence paths; a list
  of everything built/fixed en route; the connector-setup UI proposal;
  explicit statement of what remains before this gate condition clears.
