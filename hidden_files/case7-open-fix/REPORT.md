# Case-7 open_data_source fix — checkpoint report

Task: agent-driven open_data_source completes approvals but never materializes the sheet.
Port block: **8980–8989** (gateway 8980, engine 8981, agent 8985, CSV HTTP 8998). State under ~/workspace/tmp-case7-fix.
Status: analysis done; reproduction next.

## Evidence recap (agent-rerun REPORT.md, ITEM 3 phase C + CORRECTION)
- Approvals ARE answerable (answer must be literal 'approve'). With all 3
  approvals granted (actions: open_csv, materialize_csv x2), every
  agent.request_approval audit entry is ok, yet NO 'Inventory CSV' sheet
  exists; planner read_cells -> 404; ask budget burned; abort.
- Audit shows request_approval x3 ok and NO open_data_source execution.
- CSV/SQL connector paths proven at product layer (SUM revenue 4027.86 exact).

## Static trace (2026-10-22, this program)
1. `open_csv`/`materialize_csv` exist NOWHERE in source — they are not tool
   names. The runtime's own approval gate (runtime.ts requiresConfirmation)
   only gates write_cells/set_formulas, with action = tool name. So the three
   approval asks were the PLANNER emitting `agent.request_approval` tool
   actions itself, with self-invented action names.
2. WHY the planner improvised: `open_data_source` is unreachable for the LLM
   planner —
   - packages/service/src/agent/openaiBackend.ts DEFAULT_ALLOWED_TOOLS
     (line ~69) does NOT include open_data_source / list_data_sources /
     refresh_data_source; "Available tools" sent to the model omits them.
   - SYSTEM_PROMPT documents NO schema for open_data_source.
   - validatePlan() throws on any tool action outside the allowed set, so
     even a hallucinated open_data_source call dies in plan validation.
   The model, told to open+materialize a CSV and offered only
   agent.request_approval as a "gate" tool, requested approvals for invented
   steps (open_csv, materialize_csv x2); each 'approve' returned
   approved:true, which it read as step completion. No real tool ever ran.
3. Execution layer checked and sound (would work if called):
   - MCP open_data_source (mcp-server/src/server.ts:2072) fetches via the
     connector registry, then writeTableToNewSheet (service connectors/
     engine.ts) -> host.execute addSheet + setCells.
   - In the gateway topology the MCP server wraps NodeRemoteEngineHost
     (agentSvc.ts runtimeFor) bound to the live session; its execute()
     routes addSheet/setCell through POST /ops with proper EngineCommand
     shapes; snapshot()/sheetNames are properly overridden (remote).
   - engineSvc /ops handler maps addSheet<->sheet.add correctly for
     EngineCommand-shaped cmds. (Finding 2's "Unknown command" came from a
     diag that sent a CollabOp-shaped {type:'sheet.add'} as cmd — not the
     agent's path.)
4. requiresConfirmation does NOT gate open_data_source (write_cells/
   set_formulas only) — after the fix the turn needs no approvals.

## Fix plan
- openaiBackend.ts: add open_data_source (+ list_data_sources,
  refresh_data_source) to DEFAULT_ALLOWED_TOOLS; document exact schemas in
  SYSTEM_PROMPT mirroring mcp-server zod schemas; add routing guidance
  (open/import CSV/JSON/SQL -> open_data_source, one call does
  fetch+materialize; never request approval for it).
- Regression tests in the service agent family pinning: allowed set contains
  the data-source tools; validatePlan accepts an open_data_source action;
  SYSTEM_PROMPT documents the open_data_source schema.
- Rebuild service dist; restart agent on isolated stack; live proof.

## Reproduction (2026-10-22, this stack, pre-fix dist)
- Stack up: gateway 8980 / engine 8981 / agent 8985 all /health 200.
  Fixture: bob's workbook (Sales sheet, Amount total 550) + live session.
  Probe turn PASS (real model): total = 550.
  NOTE: gemini-2.5-flash-lite 404s on Vertex for this project today
  ("Publisher model ... was not found"); config set to
  google/gemini-2.5-flash (verified live) for repro/proof — same planner
  contract, noted as a model substitution, not part of the defect.
- REPRO turn: "Open the CSV data source at http://localhost:8998/sales.csv
  and materialize it as a new sheet named 'Sales CSV'."
  Result: NO tool executed (audit = user_message + agent_message only);
  the planner replied it "cannot directly open a CSV from a URL and
  materialize it as a new sheet... import the CSV first" — a capability
  the product HAS (open_data_source) but the planner contract hides.
  Readback: GET sheet 'Sales CSV' -> 404 Unknown sheet. DEFECT REPRODUCED.
  (The flash-lite run in the validation program surfaced the same root
  cause differently: invented agent.request_approval steps. Both models
  fail because open_data_source is not offered/documented/allowed.)

## Second-layer defect — FOUND LIVE (proof turns on the fixed planner)
proof2 (planner fix live): open_data_source now EXECUTES.
- Call 1 (sheetName 'Sales CSV'): FAILED "Unknown sheet: Sales CSV"
  (= engine workbook.sheetId() throw on a setCell).
- Call 2 (retry, planner-chosen name 'SalesData'): SUCCEEDED — sheet
  materialized with all 24 rows. Planner route fixed; execution flaky.
proof3 (same prompt again): call FAILED "before-retention" (the /ops
409 stale-baseRev rejection) and the planner did not retry.

ROOT CAUSE (both in NodeRemoteEngineHost's /ops client discipline,
packages/gateway/src/services/remoteEngineHost.ts):
1. clientSeq restarts at 0 for every new host instance while clientId
   stays `agent:<principal>`. The engine session's seenOps map replays
   the PREVIOUS instance's (clientId, clientSeq) results: after an
   agent-process restart, the new host's addSheet (seq 1..k) was
   answered from the pre-restart host's cached payloads — the sheet
   was never added — until seq advanced past the old maximum, when a
   real setCell hit workbook.sheetId() -> "Unknown sheet: Sales CSV",
   aborting the open mid-write. (Explains proof2 call1/call2 exactly:
   call 2 started past the collision window and ran fully real.)
2. No recovery from a stale-base rejection: when the host's
   knownRevision falls behind the journal retention floor (other
   clients advance the session; checkpoints prune), /ops rejects
   409 before-retention and executeRemote surfaces it as a terminal
   op failure. refreshRevision() exists "to refresh the seed after a
   rejection" but is never called on rejection. Multi-op tools
   (open_data_source = ~176 writes) abort on write #1.

FIX (this layer):
- Per-instance clientId: `agent:<principal>:<instance nonce>` so a
  rebuilt runtime can never collide with a predecessor's seenOps
  entries (clientId is the /ops envelope origin/dedup key; the web
  client likewise uses a per-tab id).
- executeRemote: on a before-retention rejection, re-seed the
  revision via refreshRevision() and retry the op ONCE with a fresh
  clientSeq; other rejections (viewer-role, obsolete) stay terminal.

## LIVE PROOF (fully fixed build: service dist + gateway dist rebuilt)
Turn 1 — "Open the CSV data source at http://localhost:8998/sales.csv
and materialize it as a new sheet named 'Sales CSV'.":
- Audit: ONE tool_call open_data_source ok:true. No approvals, no
  retries, no invented steps. Reply: "Opened the CSV as the sheet
  'Sales CSV' with 24 data rows (columns: order_id, order_date,
  region, product, units, unit_price, revenue)."
- Independent engine readback: 25 rows incl. header; SUM(revenue) =
  4027.86 EXACT; per-region East 1947.00 / South 1199.40 / North
  539.46 / West 342.00 — all match the fixture ground truth.
Question turn — "Analyze the 'Sales CSV' sheet and tell me the sum of
revenue grouped by region, plus the overall total revenue.":
- Agent answered: North 539.46, South 1199.40, East 1947.00, West
  342.00, "Overall total revenue: 4027.86" — EXACT on all five values.
- DISCLOSED: two earlier phrasings of the total question exposed the
  validation program's known Finding-4 planner-grounding class on wide
  tables (NOT the open defect): a partial hand-sum (3600.07) and an
  off-by-one SUM range (3937.61) whose scratch write also clobbered
  the A1 header (repaired via /ops and re-verified: header pristine,
  SUM 4027.86, before the passing turn). One attempt was also lost to
  the gateway process dying mid-turn (launcher-session reap; gateway
  restarted detached, stack finished green).

## Tests
- packages/service agent family: 7 files, 124/124 PASS (incl. 3 new
  case-7 tests in agent-modelconfig, now 33/33). Service tsc clean.
- packages/gateway: agentBinding 28/28 (incl. 5 new remote-host
  tests), remoteHostSheetNames 5/5, agentArtifacts + agentCharts +
  agentThreadPersistence + agentTranscribe 20/20. Gateway tsc clean.
- Dists rebuilt: packages/service, packages/gateway.

## Files changed
- packages/service/src/agent/openaiBackend.ts (allowed tools + prompt)
- packages/service/tests/agent-modelconfig.test.ts (+3 tests)
- packages/gateway/src/services/remoteEngineHost.ts (per-instance
  clientId nonce + before-retention resync/retry-once)
- packages/gateway/tests/agentBinding.test.ts (2 assertions relaxed
  to the per-instance clientId form + 5 new tests)

## Not landed / notes
- Nothing in scope was left unlanded. The planner's wide-table
  aggregation grounding (Finding 4 of the validation program) remains
  a model-quality matter, disclosed above; the open_data_source
  defect itself is closed at both layers.
- Finding 2 of the validation program (diag sending a CollabOp-shaped
  cmd to /ops) is a harness-shape artifact, not the agent path —
  noted for the parent; no engine change made.
