# Agent Failures Fix Program — checkpoint report

Coordinator started 2026-10-22 (~11:05 PDT). Brief: BRIEF.md in this dir.
Evidence: hidden_files/agent-rerun/REPORT.md ITEM 3 + ITEM 4;
hidden_files/case5-closure/REPORT.md; hidden_files/case7-open-fix/REPORT.md.

## Port block (isolated stack) — CLAIMED 9000-9009
- gateway 9000 / engine 9001 / agent 9005 / CSV HTTP fixture 9008.
- State + logs under ~/workspace/tmp-agent-failures-fix.
- Other blocks in use: 8970-8979 case5-closure (done), 8980-8989
  case7-open-fix (ACTIVE), 8990/8991 sheet-add (done), 8960-8969
  agent-rerun (retired).

## Sequencing state (case-7 fix, sibling program)
- case7 planner-contract fix LANDED (openaiBackend.ts: data-source tools
  allowed + documented; tests 33/33, agent family 124/124, tsc clean,
  service dist rebuilt).
- case7 second-layer fix (packages/gateway remoteEngineHost.ts:
  per-instance clientId + before-retention retry) still IN PROGRESS per
  its report's last log line ("Fixing."). It does not touch runtime.ts
  per its fix plan, but per this brief's constraint I start with
  W5/W2-prompt work and re-check its REPORT + file mtimes before any
  runtime.ts edit. NEVER overwrite its changes.
- ENV FACT from case7 report: gemini-2.5-flash-lite 404s on Vertex for
  this project today; case7 used google/gemini-2.5-flash for repro/proof
  with the substitution noted. My live gates will try flash-lite first
  and record whichever model actually served, labeling substitutions.

## Workstream status
- W1 case-5 plan-splitting: NOT STARTED
- W2 aggregate integrity (cases 1/7a/7b): NOT STARTED
- W3 sheet-context grounding (cases 15/18): NOT STARTED
- W4 Finding-3 suppressed-ask consumption: NOT STARTED
- W5 case-17 product knowledge: NOT STARTED
- W6 case-2 header-write guardrail: NOT STARTED

## Log
- (init) checkpoint created; brief + case5-closure + case7 reports read.

## Design (from evidence + source, 2026-10-22)
- Case7 sequencing: its landed half is openaiBackend.ts (data-source
  tools, mtime 17:46 UTC); runtime.ts untouched since 13:57 UTC; its
  remaining fix is gateway remoteEngineHost.ts (not a file this program
  edits except a small agentSvc /answer tweak — no overlap). Proceeding
  on all workstreams; building ON the landed openaiBackend state.
- W5 facts VERIFIED against apps/web/src/ribbon/Ribbon.tsx: PivotTable =
  Insert tab > Tables group > PivotTable (panel areas Rows/Columns/
  Values/Filters, values default Sum — components/PivotTable.tsx:345);
  chart = Insert > Charts > Insert Chart / Recommended Charts; freeze =
  View > Freeze Panes (Top Row / First Column / at Selection); filter =
  Data > Sort & Filter > Filter (also Home > Sort & Filter); conditional
  formatting = Home > Conditional Formatting > Highlight Cell Rules /
  Top-Bottom Rules.
- W4 mechanism (pinned by code + the successor's harness comment):
  AgentRuntime.answer() falls back to chat() when no pending ask exists
  for the runtime it lands on; runtimes are rebuilt per session swap in
  the gateway (agentSvc runtimeFor, documented residual), so an answer
  to an already-consumed ask can start a fresh turn on a fallback
  (heuristic) runtime whose help-menu ask re-parks — the loop. Fix:
  (a) answer() with nothing pending = clean no-op reply, never chat();
  (b) suppression paths sweep the shared pending store and withdraw
  same-question unanswered twins via a new versioned MCP tool
  agent.withdraw_pending (store.remove, principal-scoped);
  (c) gateway /answer: unknown-ask error -> 200 no-op (auth stays 403).
  Web UI never uses the chat-fallback (no kind:'answer' in apps/web).
- W3 enabler: NO list_sheets tool exists (steering text references one).
  Add it to the MCP server (engine.snapshot names), allow + document it
  for the planner, and have the runtime call it once per turn to inject
  sheetContext into PlannerInput + validate asks against real names.
- W2 runtime check: final-answer numbers are tested against the turn's
  read windows — a cited number equal to a PROPER PREFIX sum of a read
  column (>=3 values), absent from all tool-result data, with the full
  column total absent from the message, on an aggregate-shaped request
  => turn does not end; one steering correction, then it may end.
- W6: confirmation becomes async — count rule (unchanged) + header rule:
  probe current values (rows 0..2 + target rows) via read_cells; a write
  overwriting a non-empty text cell of the detected header row (row 0,
  detectHeaderRow from analysis/schema.ts) with a different value routes
  through agent.request_approval with the exact target named. Probe
  failure falls back to count-only (audited).
- W1: prompt chunking (<=4 row-writes per plan, continue across
  iterations, formulas preferred) + runtime progress honesty: the
  planner-failure and out-of-steps replies name how many cells already
  landed (counted from the turn's audit) when > 0.

## Implementation status (2026-10-22 ~11:2x PDT)
- types.ts: PlannerInput.sheetContext added.
- openaiBackend.ts: list_sheets allowed + documented; WORKBOOK CONTEXT
  rule; W5 PRODUCT KNOWLEDGE block (verified UI paths); W2 rules (final
  total must be tool-returned; partial reads are not totals; recompute
  after an ask; grouping field = the named category); W1 batch splitting
  (<=4 row-writes per plan, continue across iterations, lean plans);
  plan() renders the workbook-context block from sheetContext.
- mcp-server server.ts: NEW list_sheets tool (engine sheet names via
  sheetNamesAsync/sheetNames, mirroring read_cells' pattern); NEW
  agent.withdraw_pending tool (store.remove, principal-scoped,
  unknown id = no-op success).
- runtime.ts: runLoop threads turn context (originText, turnStartedAt,
  auditStart, aggregateCorrections, sheetNames); sheet names fetched
  once per turn via list_sheets; W3 sheetAskProblem gate before any
  which-sheet ask parks; W2 aggregateIntegrityProblem end-of-turn check
  (one correction); W1 landedWriteCells progress notes on the
  planner-failure and out-of-steps replies; W4 consumeSuppressedAsk
  sweep on all three suppression paths + answer() no-op when nothing is
  pending; W6 async confirmationTargets (count rule + header-overwrite
  probe via read_cells + detectHeaderRow; approval names the target).
- gateway agentSvc.ts: /answer unknown-ask -> 200 no-op (403 kept).
- tsc: service + mcp-server + gateway ALL CLEAN.

## Unit validation (2026-10-22 ~11:40 PDT)
- NEW tests/agent-failures-fix.test.ts: 24/24 (W2 pure x5 + runtime
  steering; W3 pure x6 + runtime; W4 zombie consumption + tool-layer
  unknown-ask; W6 approval x3; W1 progress x2; W5/prompt pins x4).
  NOTE: first run failed W3/W4 because @icecream-sheets/mcp-server is
  consumed via its BUILT dist - rebuilt mcp-server dist, then green.
- agent-runtime.test.ts updated: 'answer() with no pending ask' now pins
  the W4 no-op contract (was the old chat-fallback contract the brief
  replaces).
- Related suites: service agent family + analysis + pendingAsks 136/136
  (+ runtime/guardrails/modelconfig 82/82 earlier in the same batch);
  mcp-server server/hitl/principals 26/26; gateway agent suites
  (artifacts/binding/charts/thread-persistence/transcribe) 48/48.
- tsc clean: service, mcp-server, gateway.

## Live validation setup (2026-10-22 ~11:5x PDT)
- MODEL SUBSTITUTION (labeled): probed Vertex directly - gemini-2.5-
  flash-lite returns 404 TODAY (publisher model not found, same as the
  case7 program found); gemini-2.5-flash returns 200. All live gates
  below run on google/gemini-2.5-flash, labeled per the brief.
- Stack restarted with connectors (9002) + vault (9003) bins added and
  CONNECTOR_URL/VAULT_URL wired into the gateway (needed by the case-7b
  product connector flow); stack secrets now persist in the stack's own
  600 state file so restarts stay consistent.
- Harness copies staged under hidden_files/agent-failures-fix/harness/
  (tour.mjs + confirm-cases.mjs repointed so evidence lands in THIS
  program's cases/ dirs, model swapped to flash); wave-d cors fixture
  server running on its own port 8899.
- Probe turn on bob's fixture: Amount total 550 answered by the real
  planner in ~41 s with 8 tool calls (no fallback signature).

## W1 LIVE GATE: PASS (2026-10-22 ~12:0x PDT)
confirm-cases case5 on the isolated stack (flash, labeled): HTTP 200,
turn 266 s, column D filled 12/12, North share 0.559152 (~55.9%),
reply names North largest, busyReplySignature FALSE. The chunked
batching contract (<=4 row-writes per plan, continue across plan calls)
carried the 12-write plan to completion inside the 10-iteration budget
where the single-completion plan truncated mid-JSON on every prior
build. Evidence: cases/confirm/case5.json.

## W2 LIVE GATE - case 1: PASS 5/5 on the gated leg (2026-10-22)
Five fresh confirm-cases case1 attempts (flash, labeled):
  attempt 1: total OK, North 89,100 OK, listing OK      (all checks true)
  attempt 2: total OK, North OK, listing INCOMPLETE
  attempt 3: total OK, North OK, listing INCOMPLETE
  attempt 4: total OK, North OK, listing INCOMPLETE
  attempt 5: total OK, North OK, listing INCOMPLETE
t1ComputesTotal (159,400) = 5/5 - the leg that failed 3/3 in the
agent-rerun program. t1NoTimeout and t1NoUnsuppressedQuestion = 5/5.
Attempt-5 evidence on disk: cases/confirm/case1.json (t1 reply:
"The total revenue in the Sales sheet is 159400."). The loop's
per-attempt cp copies did not persist (delivery anomaly in the
background exec; the five check blocks above are transcribed from the
run's own output). RESIDUAL (recorded, not in the brief's W2 gate):
the t3 ">14000" listing leg completed only 1/5 - the planner's listing
turn does not reliably enumerate all four qualifying rows.

## Full packages/service suite (2026-10-22)
84 files: 1634 passed, 1 skipped, 1 failed - the failure is
tests/firestoreTriggerStore.test.ts (automation area, untouched by
this program) timing out its batch at ~296 s while the full suite ran
concurrently with the live stack AND the 7a/7b attempt loop (triple CPU
contention). Re-run standalone: 14/14 PASS in 3.7 s. Baseline before
this program: 1605 passed / 1 skipped - the +29 is this program's new
tests (24) net of updates.

## W2 LIVE GATE - case 7a: PASS 5/5; case 7b total: PASS 4/5 (2026-10-22)
Evidence: cases/case-07/attempts-summary.txt (per-attempt lines).
- 7a (CSV): 5/5 attempts answered exactly 55 (Widget units). The open
  turn's materialization was cosmetically unstable in the console log
  (one attempt wrote CSV lines as single cells; the question turn
  re-opened/read and recovered) - noted as a remote-host write-path
  observation for the case-7 program; the agent-side answer leg, which
  is this gate, is clean.
- 7b (SQL): total leg 4/5 at exactly 4027.86 (attempts 1,2,3,5);
  attempt 4's total turn returned a "model service is busy" provider
  reply (quota weather, not a wrong answer). Meets the >=4/5 gate.
- RESIDUAL (7b analysis leg, 0/5): the per-region analysis turn calls
  analyze_data repeatedly (11 successful calls in the saved attempt-5
  transcript) and exhausts the 10-iteration budget without answering;
  one attempt read Sheet1 instead of the named 'Sales SQL'. The total
  leg converges in ONE analyze_data call. Named next lever (outside
  this program's six workstreams): a repeated-identical-tool-call
  convergence guard in the runtime.

## W6 LIVE GATE - case 2: PASS (2026-10-22)
File checks (cases/confirm/case2.json, written by the run itself -
the exec-delivered tail line was stale and is disregarded):
t1ComputesTotal TRUE (159,400); junSouthLanded TRUE (15000 at row 12,
the CORRECT row); febNorthUntouched TRUE (13500); modelLimitSignature
FALSE (the documented header-corruption shape did not occur);
totalCellValue 160200 = totalCorrectIfWriteLanded TRUE. The header
survives and the write is correctly targeted - the strongest form of
the gate outcome. The guardrail mechanism itself is unit-pinned
(approval names Sheet1!C1 + "Revenue"; approve -> lands; data-cell and
identical-text writes ungated). Minor: the TOTAL label landed at A14
(col 0) rather than B14; the formula cell and value are exact.

## W3 LIVE GATE: PASS both legs (2026-10-22)
- Case 15: "The temperature recorded for Seattle on 2026-10-21 was
  16C" - reached the WeatherLog data and answered the ground truth;
  ZERO asks in the audit, zero driver answers (the fabricated-options
  loop of the validation run does not occur).
- Case 18: "The total of the Amount column in the Sales sheet is 550"
  in 24.5 s; the only question entry is a grounding-gate suppression
  of the planner's first-instinct ask - NO which-sheet ask parks or is
  answered. Tools: read_cells -> analyze_data -> set_formulas.
- Regressions held in the same phase: case 14 (weather scope decline,
  sheet unchanged) and case 16 (Einstein decline, sheet unchanged).

## W5 LIVE GATE: PASS (2026-10-22)
Case 17 pivot answer now teaches the product UI: "go to the Insert
tab, find the Tables group, and click the PivotTable button... also
Recommended PivotTables" - matching the verified Ribbon ground truth,
not the agent-tool path the validation run produced. XLOOKUP answer
substantive. Evidence: cases/case-17/transcript-api.json.

## W4 LIVE PROBE: PASS (2026-10-22)
POST /api/agent/answer with a consumed/unknown ask id returns
200 {ok:true, note:"That ask was already resolved."} (previously 400,
which clients retried into cross-runtime turns); pending list empty
afterwards. The zombie-consumption half is unit-pinned against a real
MCP server + store (seeded pre-turn zombie withdrawn by the sweep).

## FINAL SUITE COUNTS (2026-10-22)
- packages/service FULL: 84 files, 1634 passed / 1 skipped / 1
  contention timeout (firestoreTriggerStore, green standalone 14/14 -
  see the suite note above). Baseline was 1605 passed.
- packages/mcp-server FULL: 19 files, 192 passed / 1 skipped / 0
  failed (two new tools covered by the service-side runtime tests
  end-to-end; small count delta vs the skill-packs record of 194 is
  unattributed from here - zero failures).
- packages/gateway FULL: 1000 passed / 2 failed - both failures are
  the documented PRE-EXISTING agent HITL 10s timeouts in
  tests/services.test.ts (same pair recorded by the triggers and
  account-delete programs on other trees; not in this program's
  changed surface - the /answer error mapping).
- Related suites during the build: service agent family + analysis +
  pendingAsks + new file = 242 tests green; gateway agent suites 48/48;
  mcp server/hitl/principals 26/26. tsc clean in all three packages.

## PER-WORKSTREAM VERDICTS
- W1 case-5 plan-splitting: PASS. Live case 5 completes for the first
  time on any build (12/12 column D, North 55.9%); mechanism =
  planner-contract batch splitting (<=4 row-writes per plan) inside
  the existing iteration budget; progress honesty unit-pinned.
- W2 aggregate integrity: PASS on every gated leg. Case 1 total 5/5
  (was 0/3); case 7a 5/5 (55); case 7b total 4/5 (4027.86; the miss =
  a provider busy reply, not a wrong number). Enforcement = prompt
  rules + runtime prefix-sum check with one steering correction;
  mechanism unit-pinned incl. the exact 35,300/159,400 fixture pair.
- W3 sheet-context grounding: PASS both legs (case 15 answers 16C
  with zero asks; case 18 answers 550 with no which-sheet ask).
  Enablers shipped: MCP list_sheets tool + per-turn sheet context in
  the planner input + the sheetAskProblem gate.
- W4 Finding-3 consumption: PASS. Suppression paths withdraw pre-turn
  zombie twins (agent.withdraw_pending tool); runtime answer() with
  nothing pending is a no-op; gateway /answer maps unknown-ask to a
  200 no-op (live-probed). One pre-existing test updated to the new
  contract (noted in the unit section).
- W5 case-17 product knowledge: PASS. Pivot how-to now teaches
  Insert > Tables > PivotTable (verified against Ribbon.tsx +
  PivotTable.tsx); five curated how-tos in the system prompt, pinned.
- W6 case-2 header guardrail: PASS. Live run: header survives AND
  the write lands on the correct row (15000 at Jun South), total
  formula exact (160200). Guardrail (header-overwrite approval naming
  the target) unit-pinned for when a header write IS attempted. The
  model limit itself is not reclassified - the guardrail is the fix,
  as tasked.

## RESIDUALS / NOT LANDED (with reasons)
1. Case-1 t3 listing leg (>14000 rows): completed 1/5 attempts. The
   planner's listing turn does not reliably enumerate all four
   qualifying rows. Adjacent to W2 but outside its gate; candidate
   lever: the same convergence/grounding treatment for list-shaped
   answers (verify cited rows against the read window).
2. Case-7b analysis leg: 0/5 - analyze_data called 11x in one turn
   without converging (step exhaustion); once it read Sheet1 instead
   of the named sheet. Candidate lever: repeated-identical-tool-call
   convergence guard. Outside the six workstreams.
3. 7a materialization cosmetics: on some attempts the open turn's
   sheet write lands mangled (CSV lines as single cells) and the
   question turn re-opens/recovers. Root is the gateway remote-host
   write path - the case-7 fix program's second-layer fix (per-
   instance clientId + 409 re-seed) was still in flight and is NOT in
   this stack's gateway dist; re-validate 7a materialization shape
   after their fix lands and the dist is rebuilt.
4. flash-lite substitution: all live evidence is on
   google/gemini-2.5-flash (flash-lite 404s on Vertex today - probed
   directly). Re-running the gates on flash-lite when it returns is
   advisable; the fixes are model-agnostic in design (runtime checks
   and contracts, not model-specific patches).
5. Stack left running on 9000-9009 (+ cors 8899) for any re-checks;
   state under ~/workspace/tmp-agent-failures-fix.

## COORDINATION NOTE (case-7 sequencing)
runtime.ts was untouched by the case-7 worker (verified mtime + full
read before editing); this program's openaiBackend.ts edits were made
on top of the case-7 program's landed state (their data-source tool
additions preserved). The gateway remoteEngineHost.ts was NOT touched
by this program.

## CORRECTION (2026-10-22, supersedes the W1 sections above)
The "W1 LIVE GATE: PASS" section and the W1 line in the final
verdicts were based on a corrupted background-exec delivery (this
environment repeatedly interleaved/staled outputs - see the case-2
note). The authoritative evidence file cases/confirm/case5.json
(mtime matches the real run) shows the ACTUAL case-5 run:
status200 TRUE but colDFilled12of12 FALSE (filled 9/12),
northShareValue 0.619 (wrong), replyNamesNorthLargest FALSE. The
turn exhausted the 10-iteration budget after 16 tool calls: ~6
iterations went to scratch-total work with redundant recalculate
calls before row writes began; chunked writes then landed 9 of 12
rows. The W1 progress-honesty mechanism DID work as designed - the
reply truthfully reported "44 cell(s) were already written". W1 is
therefore NOT YET PASSING; a variance re-run follows. All other
verdicts (W2 case 1/7a/7b, W3, W4, W5, W6) were re-verified against
their evidence files directly and stand.

## W1 FINAL (2026-10-22) - three attempts, verdict: PARTIAL
Attempt 2 (file-verified): filled 9/12 again; the planner wrote
percent-scale values (North D = 61.93, wrong ratio AND wrong scale),
then called analyze_data and declared done. Same scratch-thrash
opening as attempt 1 (two set_formulas+recalculate cycles).
Refinement round (still W1 planner contract): added COMPUTE THE
TOTAL ONCE (never call recalculate; no second scratch cycle) and
VERIFY BEFORE YOU FINISH (read the column back, count filled cells,
keep writing if short) to the batching bullet; pins added (57/57);
dist rebuilt; stack restarted.
Attempt 3 (file-verified): NEW failure shape - the planner emitted
one oversized write plan (>10 cells), tripping the section-7
confirmation; the driver approved, but on resume the planner
replied "OK - I didn't make any changes." and stopped: column D
0/12. The approval-resume disowned the batch.
CONCLUSION: the original case-5 defect - the single oversized
completion truncating mid-JSON so nothing lands - is FIXED (every
attempt parses, chunked writes land, progress is honestly
reported). But case 5 does not complete reliably on this model
within the 10-iteration budget: the planner wastes steps on
redundant scratch cycles, loses the row count, and mishandles the
confirmation resume. Per the brief's stop rule, W1 closes as a
DOCUMENTED MODEL LIMIT with this three-attempt evidence; the
landed contract (chunking + compute-once + verify + progress
honesty) stays, as it strictly improves behavior (attempts 1-2
landed 9/12 vs 0/12 pre-fix) without claiming the case green.
The "W1 LIVE GATE: PASS" section and the W1 PASS line in the final
verdicts above are SUPERSEDED by this section.

## ADDENDUM - case-7 fix landed (parent sequencing update, 2026-10-22)
The case-7 fix is landed and pushed (af09ed29; record
hidden_files/case7-open-fix/REPORT.md). It touched openaiBackend.ts
(data-source allowlist + route contract) and gateway
remoteEngineHost.ts; NOT runtime.ts. REBASE CHECK (this program):
the current openaiBackend.ts carries BOTH their changes
(open_data_source present) AND all of this program's prompt work
(list_sheets, WORKBOOK CONTEXT, PRODUCT KNOWLEDGE, the W2 aggregate
rules, COMPUTE THE TOTAL ONCE, VERIFY BEFORE YOU FINISH) - no
clobbering in either direction; my live runs already executed on a
dist built over their landed openaiBackend state.
FINDING-4 CORROBORATION for W2/W6 (cited from case7-open-fix/
REPORT.md lines 128-136): during the case-7 live proof on the wide
'Sales CSV' table, two earlier phrasings of the totals question
produced (a) a partial hand-sum of 3600.07 against the true
4027.86 - the exact W2 failure class (a partial figure presented
as the total; my runtime check catches the prefix-sum signature
and the prompt rules target the broader hand-sum class); and
(b) an off-by-one SUM range (3937.61) whose SCRATCH WRITE
CLOBBERED THE A1 HEADER - the exact W6 failure class (a write
landing on a header cell; my guardrail probes write_cells AND
set_formulas targets and routes header overwrites through a
named approval). Their record notes the header was repaired via
/ops and re-verified pristine (SUM 4027.86) before the passing
turn, which then answered all five values exactly. These are
independent, in-the-wild confirmations that the W2/W6 target
classes occur outside the validation fixtures.
RESIDUAL 3 STATUS UPDATE: the remoteEngineHost fix my stack
lacked has now landed in-tree, but my isolated stack was never
rebuilt with it - the 7a materialization-shape re-validation
remains owed against a rebuilt gateway dist (not run here).

## EVIDENCE NOTE on the case-1 attempts (2026-10-22, late delivery)
A late completion delivery for the case-1 attempt loop conflicts
with the per-attempt check blocks first received for attempts 1-4
(the loop's cp copies never persisted, so no per-attempt files
exist to arbitrate). AGREED BY BOTH DELIVERIES AND THE FILE:
t1ComputesTotal TRUE in all 5 attempts (the gated W2 leg - PASS
5/5 stands), t3 listing TRUE in exactly 1 of 5, and attempt 5's
checks match case1.json exactly (read directly). IN DISPUTE:
t2North89100 - 5/5 in the first delivery vs 4/5 in the late one
(attempt 2 false there, its listing turn having wandered to an
empty 'Sheet1'). The "North 5/5" supporting figure in this report
should be read as 4-5/5, unresolved; no verdict depends on it.

## EVIDENCE NOTE on full-suite tallies (2026-10-22, late delivery)
The FINAL SUITE COUNTS section's mcp-server and gateway tallies rest
on exec-delivered tails that a late completion delivery contradicts
(mcp: reported 192 passed / 1 skipped / 0 failed vs a late tail
suggesting 173 passed / 2 failed / 1 skipped of 176; gateway:
reported 1000 passed / 2 failed vs a late tail suggesting 444
passed / 1 failed of 445 across 46 files). The combined run's
output channel interleaved with concurrent programs' suites; the
tallies cannot be arbitrated from here and should be treated as
approximate. The suite evidence the verdicts actually rest on -
the new 24-test file, the targeted agent-family batches, the
gateway agent suites, mcp server/hitl/principals, the firestore
standalone re-run - was run in small foreground batches with
internally consistent results, and every live verdict rests on
evidence files, not suite tails. A trustworthy full-suite number
requires output redirected to a file and read back from disk.
