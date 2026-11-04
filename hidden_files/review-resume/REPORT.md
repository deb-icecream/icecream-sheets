# Review Resume — pending fixes & tests (redo of the interrupted 04:08–04:55 PDT review)

Started: 2026-10-22 ~09:32 PDT. Scope: planner-fix follow-ups, same-window dispatches
(item L, perf sign-off measurements, deploy-gate rulings), planner-fix code presence.
Checkpoint-first protocol: this file is updated after each finding.

## Status log
- [x] 1. planner-fix REPORT.md read; follow-ups enumerated (F1-F7)
- [x] 2. follow-ups dispositioned (Finding 2)
- [x] 3. item L verified (Finding 3)
- [x] 4. perf sign-off measurements verified (Finding 3)
- [x] 5. deploy-gate rulings verified (Finding 3)
- [x] 6. planner-fix code presence grepped (Finding 4)
- [x] 7. final verdict table written (below)

## Finding 1 — planner-fix follow-ups enumerated (from hidden_files/planner-fix/REPORT.md)

Verdicts section + Landing status + Case 5 follow-ups name these open items:
- F1. Model's aim on content-addressed writes (case 2 t2/t3): deterministic wrong-row write
  (row 3 Feb North instead of row 12 Jun South, 5/5 attempts, even with full in-turn read +
  writtenRowContext echo); t3 off-by-one SUM range + 'TOTAL' label never written.
  Report calls it "a flash-lite spatial-grounding limit that prompt + echo did not move."
- F2. Case 5 persistently malformed completion: first planner call for that turn shape
  returns non-JSON at temperature 0; parse-retries exhausted; M4 containment graceful.
  "The backend discards unparseable bodies... the completion's actual shape is NOT
  observable with current logging."
- F3. Follow-up (1) under Case 5 verdict: "log a bounded prefix of unparseable completions
  in the backend so the malformed shape is observable."
- F4. Follow-up (2): "consider a completion-length control / plan-splitting for per-row
  batch writes."
- F5. Follow-up (3): "re-run case 5 after (1) identifies the shape."
- F6. HELD delta: packages/service/src/agent/runtime.ts M2 (results preserved across ask
  recursion) + M4 (plan()-failure containment at chat() boundary) + agent-runtime.test.ts
  M2/M4 tests — "HELD - COORDINATION REQUIRED... The parent should have ONE owner merge
  M2/M4 with the D-series." (At planner-fix close, runtime.ts was untouched in the real repo.)
- F7. Minor: "NOT re-run on the final tree: the full 81-file service suite" (agent suites
  were green; full suite was run pre-rebase 81/81, 1532 passed / 1 skipped).

## Finding 2 — planner-fix follow-up dispositions (evidence: hidden_files/agent-rerun/REPORT.md)

- F1 case-2 wrong-row aim: CONFIRMED + CLOSED as model limit. Agent-proof ITEM 2 case-2
  confirmation re-run (cases/confirm/case2.json + post-run sheet dump): the Jun South write
  landed on the HEADER cell (row 0, col 2) this time — same class, moving signature (row 3
  in planner-fix's 5/5). Final verdict table (ITEM 4, case 2): "FAIL — confirmed model
  limit... flash-lite spatial grounding, not a product defect." Owner: agent-proof program;
  per its tasking "not looped on."
- F2 case-5 malformed completion: MECHANISM PROVEN + CLOSED as diagnosis. The completion
  is TRUNCATED mid-JSON (output-budget exhaustion), proven by the new bounded-prefix audit
  evidence (ITEM 2 case-5 re-run; final table case 5: "FAIL — mechanism proven").
- F3 bounded-prefix logging: DONE. Landed in openaiBackend.ts (extractContent appends a
  <=200-char whitespace-collapsed JSON-escaped prefix to the thrown error); pinning test in
  agent-modelconfig.test.ts 29/29 (ITEM 2 case-5 sections; "ITEM 1 + observability fix —
  landed code summary").
- F4 completion-length control / plan-splitting: NOT implemented as written. The
  successor's diagnosis refined it: openaiBackend.ts sets NO explicit output-token cap, so
  the provider default truncates long plans; the named corrective lever is an explicit
  planner output-token budget. That lever is "named for the parent; it is outside this
  program's sanctioned fix scope, and the one sanctioned re-run is spent" — i.e. explicitly
  ESCALATED, currently with no owning program. Plan-splitting itself was never built.
- F5 re-run case 5 after F3: DONE. The one sanctioned re-run ran post-fix
  (cases/confirm/case5.json; busy reply 56.3 s; audit prefix shows the truncation).
- F6 M2/M4 held runtime delta: DONE. Ported + merged with the grounding gate in the real
  tree by the re-run successor (REPORT "MERGED DELTA PORTED + UNIT-VALIDATED" ~05:35 PDT;
  M2/M4 unit tests ported verbatim into agent-runtime.test.ts; combined build live).
- F7 full 81-file service suite on final tree: targeted suites green on the final merged
  tree (evidence in both reports); a single full-suite run post-merge still to confirm
  from the record — checking.

## Finding 3 — same-window sweep (item L, perf sign-off, deploy-gate)

- ITEM L: COMPLETE at unit level, exactly as expected. hidden_files/item-l-fix/REPORT.md:
  all six secondary collabTransport paths moved to fetchOpenedWithRefresh (postEntry,
  catchUp, postSessionExtras, postPresence, releaseOpenedSession, postDeltaAck);
  engineFetch helper RETIRED (grep-verified zero callers); collabTransport.test.ts 63/63
  (12 new Item L tests); full apps/web suite 145 files / 1,864 tests ALL PASS; tsc clean.
  The live short-TTL proof is explicitly OWED in that same REPORT ("Run the live proof
  with the next controlled dist build", ENGINE_ACCESS_TTL_SECONDS=30 pattern) — tracked,
  owner: item-l-fix record + the next controlled dist build.
- PERF — browser TTFP re-measure: OWED, tracked. perf-evaluation.md Phase 2 addendum
  (line 719+) records Phase-2 browser TTFP only under contention (4,898 ms at host load
  ~3; 9,506 ms at load ~10+) against quiet-VM Phase-1 baselines; the quiet-machine
  re-measure remains outstanding. Non-blocking per the deploy-gate ruling.
- PERF — 4,794 ms figure: OWED, tracked. perf-evaluation.md line 547 still carries the
  W18 gate-harness figure ("Enter->deep-cell settle, fresh load: 4,794 ms") beside the
  finisher rerun numbers (27.2 s / 30.6 s settle) it cannot be reconciled with; it has
  NOT been re-run with its edit documented or struck. Non-blocking per the ruling.
- PERF — item-D real P95 CHECKPOINT: OWED, tracked with a one-command re-run.
  hidden_files/open-defects/REPORT.md item D: "NOT RUN: a real P95 checkpoint through
  the gateway — two attempts, both times the engine was OOM-killed by shared-VM
  contention... Drivers + stack script saved in logs-D/ for a one-command re-run on a
  quieter host" (logs-D/ confirmed on disk). Owner: open-defects sweep record / the
  perf sign-off session. Non-blocking per the ruling.
- DEPLOY-GATE RULINGS: RECORDED + EXECUTED. hidden_files/deploy-run/REPORT.md header:
  "Authorization: user, 2026-10-22 ~04:19 PDT (unconditional)"; its log shows the run
  proceeding without waiting on pending validation ("Proceeding with the tree as-is per
  brief; the deploy does not wait", line 23) and the security-gate legs added on top.
  The three perf measurements above stayed owed THROUGH the deploy — proof the
  not-blockers ruling was operative, not just recorded.

## Finding 4 — planner-fix code presence in the tree (grep-verified 2026-10-22)

- packages/mcp-server/src/server.ts:651 `const FAR_WRITE_SLACK = 1024;` (far-write
  guard); writtenRowContext echoed in both write results (lines 762, 811).
- packages/service/src/agent/openaiBackend.ts:140 the WRITES ADDRESSED BY CONTENT
  bullet verbatim; lines ~298-349 the malformed-plan path incl. the bounded-prefix
  observability error ("provider returned non-JSON plan (completion prefix: ...)").
- packages/service/src/agent/runtime.ts: M2/M4 merge present — asksUsed/grounded
  threading (lines 820-845) and the M4 graceful busy reply (line 869).
- Test files exist: packages/mcp-server/tests/server.test.ts,
  packages/service/tests/agent-modelconfig.test.ts,
  packages/service/tests/agent-runtime.test.ts (all modified 2026-10-22).

## FINAL VERDICT TABLE

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| F1 | Case 2 content-addressed write aim (wrong-row) | CLOSED — confirmed model limit | agent-rerun/REPORT.md ITEM 2 case-2 confirmation (header-cell overwrite this run; row 3 in planner-fix 5/5) + ITEM 4 table: "FAIL — confirmed model limit... not a product defect" |
| F2 | Case 5 persistently malformed completion | CLOSED as diagnosis — mechanism proven (truncated mid-JSON, output-budget exhaustion) | agent-rerun/REPORT.md ITEM 2 case-5 re-run + ITEM 4 case 5 |
| F3 | Bounded-prefix logging of unparseable completions | DONE — landed + pinning test | agent-rerun/REPORT.md ITEM 2 case-5 sections + landed-code summary; openaiBackend.ts:341-349 (grep) |
| F4 | Completion-length control / plan-splitting | NOT BUILT — refined into the explicit planner output-token-budget lever, ESCALATED to parent, currently UNOWNED | agent-rerun/REPORT.md case-5 verdict: "The lever (planner output-token budget on the Vertex route) is named for the parent; it is outside this program's sanctioned fix scope" |
| F5 | Re-run case 5 after F3 | DONE — the one sanctioned re-run ran post-fix | agent-rerun/REPORT.md ITEM 2 case-5 (cases/confirm/case5.json) |
| F6 | Held runtime.ts M2 + M4 delta merge | DONE — ported + merged with grounding gate, tests ported verbatim | agent-rerun/REPORT.md "MERGED DELTA PORTED" ~05:35 PDT; runtime.ts:820-869 (grep) |
| F7 | Full 81-file service suite on the final merged tree | OPEN (minor) — targeted suites all green on the final tree; the single full-suite run post-merge is not evidenced in either report | planner-fix/REPORT.md:47 (named not-re-run at its close); agent-rerun cites per-area suites only |
| L | Item L token-refresh hardening | COMPLETE at unit level; live short-TTL proof OWED + tracked | hidden_files/item-l-fix/REPORT.md (63/63; web 1,864 PASS; proof "with the next controlled dist build") |
| P1 | Browser TTFP re-measure (quiet host) | OWED + tracked, non-blocking | perf-evaluation.md Phase 2 addendum (contention caveat, line 719+) |
| P2 | 4,794 ms figure resolution | OWED + tracked, non-blocking | perf-evaluation.md:547 (figure still carried, unreconciled) |
| P3 | Item-D real P95 CHECKPOINT via gateway | OWED + tracked, one-command re-run staged, non-blocking | open-defects/REPORT.md item D + logs-D/ on disk |
| G | Deploy-gate rulings (perf not blockers; P95 save accepted; deploy GO) | RECORDED + EXECUTED | deploy-run/REPORT.md header (user GO 2026-10-22 ~04:19 PDT, unconditional) + log |

## DROPPED / UNOWNED list

Nothing was silently dropped: every item named by the interrupted window is either
done, closed with evidence, or visibly tracked as owed in an owner's record.
Two items have no owning program and need a parent decision to move:
1. F4's corrective lever — an explicit planner output-token budget in
   openaiBackend.ts (no cap is set today; the provider default truncates long
   multi-write plans, which is case 5's proven failure mechanism). The agent-proof
   program named it for the parent and explicitly placed it outside its sanctioned
   scope. Until an owner picks it up, case 5 (per-row batch writes) stays FAIL.
2. F7 (minor) — one full 81-file service-suite run against the final merged tree
   to retire the planner-fix report's "not re-run" note. All touched-area suites
   are green; this is a completeness run, not a suspected failure.
