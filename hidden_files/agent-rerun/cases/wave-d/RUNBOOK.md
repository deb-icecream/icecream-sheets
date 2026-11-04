# Wave D — Runbook (cases 7, 13, 14, 15, 16, 17, 18, 19 + case-20 blemish re-check; user bob)

Staged 2026-10-22 by the successor coordinator. Scripts adapted from the
predecessor program's staged-but-never-run w3b tour
(hidden_files/agent-features/cases/w3b-work/), evidence re-pointed to
hidden_files/agent-rerun/cases/. DO NOT RUN until the combined build is
final (FIX-R4 + planner-fix merged delta + grounding gate) and live on the
shared stack — the wave runs ONCE against that build.

## Preconditions (in order)
1. Combined build: service dist rebuilt from the merged source; agent
   service (8105) restarted on it; MCP (8106) restarted if the mcp-server
   dist changed (far-write guard / written-row echo live there). Shared
   stack otherwise untouched (gateway 8100, engine 8101, web 4173).
2. `node setup-wave-d.mjs` — mints a FRESH gcloud token, POSTs bob's agent
   config (Vertex gemini-2.5-flash-lite), creates the fixture workbook,
   writes state.json here. (Ops trap: a stale cached token passes the
   config POST but every planner call then 401s into the silent
   deterministic fallback — setup mints fresh; verify with the probe in
   step 3.)
3. Probe: one API chat turn on the fixture ("What is the total of the
   Amount column in the Sales sheet?" → 550) answered by the REAL model in
   seconds. If it spins/minutes-long, STOP — config/token problem, not a
   case result.
4. Phase C only: `node cors-server.mjs` (serves inventory.csv on :8899)
   and `cp ~/workspace/icecream-sheets/hidden_files/shared-fixtures/sales.db /tmp/w3b-sales.db`.
5. Quota discipline: space phases; a graceful "model service is busy"
   reply is a 429 (product behavior), NOT a case verdict — re-run that
   case after a quiet interval.

## Run order
`node tour-wave-d.mjs A` (15, 14, 16, 17) → `B` (13, 19) → `C` (7) → `D` (18, 20).
Each phase writes transcripts/screenshots/read-backs under
agent-rerun/cases/case-NN/ and accumulates wave-d/results.json.

## Ground truths + verdict rules
- Fixture (bob): Sales = Product/Region/Amount/Quantity, 4 data rows,
  Amount total **550**; WeatherLog: Seattle 2026-10-21 = **16** (TempC).
- Case 7a (CSV): Widget Units across warehouses = 34 + 21 = **55**.
  PASS = dialog materializes "Inventory CSV" sheet + agent answers 55.
- Case 7b (SQL): SUM(revenue) = **4027.86**; per-region: **East 1947.00**
  (highest), South 1199.40, North 539.46, West 342.00.
  PASS = sales table materializes as "Sales SQL" + query answers 4027.86
  + analysis names East / 1947(.00).
- Case 13: prompt >2,000 chars rejected with the limit NAMED, sheet
  unchanged; the ~1,500-char legit prompt is answered with correct
  numbers (Amount total 550; Quantity total 47; North 320 / South 230;
  Apples combined 270; largest row Oranges 200).
- Case 14 (RE-TEST): "what is the weather today?" DECLINED + redirect,
  sheet byte-identical before/after. (A dead worker once claimed it was
  answered as a workbook question, never reproduced with artifacts — if
  the decline does not happen, root-cause the live path vs the
  deterministic classifier and record FAIL with the transcript.)
- Case 15: the vague in-scope phrasing about "how warm it was" must be
  answered from the WeatherLog: **16** (Seattle, 2026-10-21). PASS =
  answer 16 from the sheet, not a decline, not a guess.
- Case 16: "Who is Einstein?" declined like case 14, sheet unchanged.
- Case 17: pivot how-to + "what does XLOOKUP do?" answered; pivot answer
  judged against the app's own UI (ground truth screenshot of the Insert
  tab is captured by the tour). Caveat recorded in the verdict: NO
  product-docs corpus exists — answers are model-parametric, ungrounded
  for this app's UI flows.
- Case 18: in a NEW browser session on the same workbook, "What was the
  total of the Amount column … I had open earlier?" → **550**, answered
  from context (the workbook itself is the context — the agent must read
  it in the new session or recall the thread; either way the number must
  be 550 with sheet evidence in the audit).
- Case 19: turn 1 total = 550; turn 2 writes total×1.1 = **605** into
  Sales!F1; API read-back of F1 must be 605 (session memory across turns
  of one thread).
- Case 20 (blemish re-check): session 1 "remember that my weekly report
  goes out on Fridays" (memory_save via MCP tools, audit must show it);
  session 2 (fresh context) "When does my weekly report go out?" →
  "Friday(s)" via memory_load. BLEMISH RULE: PASS-clean if recall
  completes WITHOUT the planner first asking the user for the fact;
  PASS-with-blemish if it asks once and recalls after the nudge (the
  original disclosed behavior); FAIL if it never recalls. The grounding
  gate should now suppress an ungrounded first-move ask and steer it to
  memory_load — note explicitly which path the transcript shows.

## Evidence standard
PASS = artifacts on disk (transcript.json + screenshots + read-backs per
case). Prose claims do not count. Record per-case verdicts in
hidden_files/agent-rerun/REPORT.md (Wave D section) as each phase lands.
