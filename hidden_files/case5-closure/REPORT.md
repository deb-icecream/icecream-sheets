# Case-5 Closure Attempt + Merged-Tree Completeness Run

Status: STARTED (worker dispatched 2026-10-22).

## Plan
1. Set explicit generous planner output-token budget in packages/service/src/agent/openaiBackend.ts (max-output-tokens on request construction); pin with a test in the agent-modelconfig suite. No other behavior changes.
2. Rebuild service dist; ONE case-5 confirmation run on an isolated stack (own port block, stated below before use) using the agent-rerun harness patterns; per-row share column over the 12-row Sales fixture. Verdict: 12/12 = PASS, else FAIL with observed shape. No budget re-raising inside this task.
3. Run FULL packages/service suite once on the final merged tree; record exact counts (retires planner-fix "not re-run" note / review-resume F7).
4. Final report with budget value + location, test result, case-5 verdict + evidence path, full-suite counts, any new failure attributed not chased.

## Port block (isolated stack) — CLAIMED 8970-8979
- gateway 8970 / engine 8971 / agent 8975. State + logs under
  ~/workspace/tmp-case5closure. (8960-8969 was the agent-rerun program's
  block and is retired; 892x/893x/894x/895x belong to other programs.)
- Stack recipe: the agent-rerun successor #4 stack script
  (~/workspace/tmp-agent-proof/stack.sh), adapted to this block + state
  dir; driver: hidden_files/agent-rerun/confirm-cases.mjs case5 with
  LEGA_GW=http://localhost:8970.

## Step log
- Checkpoint created.
- Step 1 landed + unit-validated (see below).
- DIST REBUILD NOTICE (recorded before rebuilding, per protocol):
  rebuilding packages/service dist so the isolated proof stack's agent
  process exercises the new budget code. Running processes are
  unaffected (Node loads dist at start).

## Step 1 — output budget LANDED
- packages/service/src/agent/openaiBackend.ts: exported `PLANNER_MAX_OUTPUT_TOKENS = 16_384`, sent as `max_tokens` in the chat-completions request body (the only request-construction change; retry schedule, parse-retry, temperature 0 untouched).
  - Reasoning: a 12+-write plan is ~1–4k tokens of JSON even with verbose rationales; the provider default truncated it mid-JSON (proven by the bounded-prefix logging). 16,384 = ~4–8x headroom over the largest observed plan, far below gemini-2.5-flash-lite's 65,536 output ceiling; it is a ceiling, not a target — the 60 s per-call timeout still bounds runaway generation first.
- Test pinned: packages/service/tests/agent-modelconfig.test.ts — "sends an explicit planner output-token budget on every request (case-5 closure)" asserts the captured request body carries max_tokens == PLANNER_MAX_OUTPUT_TOKENS == 16_384 (and temperature still 0).
- Validation: service tsc --noEmit clean; agent-modelconfig suite 30/30 PASS.

## Step 2 — case-5 confirmation: FAIL (0/12), same signature at the new budget
- Stack: isolated block 8970-8979 as claimed; service dist rebuilt first
  (dist/agent/openaiBackend.js verified to carry max_tokens), then the
  stack started, so the agent process on :8975 ran the budgeted code.
- Driver: hidden_files/agent-rerun/confirm-cases.mjs case5,
  LEGA_GW=http://localhost:8970. ONE run, per tasking. Evidence:
  hidden_files/case5-closure/case5-confirm.json (also left at the
  harness's own path, cases/confirm/case5.json; successor #4's pre-fix
  evidence preserved as cases/confirm/case5-prefix-successor4.json).
- Observed: HTTP 200 in 52.7 s; reply = the graceful busy message;
  column D read back 0/12 filled. Audit: user_message -> timeout ->
  agent_message. The timeout entry names the cause: the planner call
  for the multi-write plan returned a NON-JSON completion. Its bounded
  prefix begins as a well-formed plan ({"message": "Calculating each
  region's share of total revenue and writing it to column D..."), so
  the completion starts correctly and is cut off / degenerates beyond
  the 200-char observable window. Before that call, the planner parked
  one options ask ("Which column ... contains the revenue data?"),
  answered 'Revenue' by the driver as a user would.
- Verdict (strict task rule): **FAIL** — 0/12 rows written. Plainly:
  raising the output budget to 16,384 did NOT yield a parseable plan
  for this turn shape in this run; the failure signature (first
  big-plan completion non-JSON -> parse-retries exhausted -> graceful
  busy reply, zero writes) is unchanged from the pre-budget runs.
  Whether the body truncated exactly at the new 16,384 ceiling cannot
  be proven from the bounded prefix; what is proven is non-JSON at the
  new budget. Per tasking, the budget was NOT raised further and the
  run was NOT repeated.

## Step 3 — full packages/service suite on the final merged tree
- Command: `npx vitest run` in packages/service (final tree, incl. the
  budget change + the new modelconfig test).
- Result: **Test Files 83 passed (83); Tests 1605 passed, 1 skipped,
  0 failed.** Duration 93.7 s.
- This retires the planner-fix report's "NOT re-run on the final tree"
  note (review-resume item F7): the merged tree (FIX-R4 + grounding
  gate + M2/M4 + header contract + budget) is now suite-proven whole,
  up from the pre-merge partial baseline of 81 files / 1532 passed.

## FINAL SUMMARY
1. Budget: PLANNER_MAX_OUTPUT_TOKENS = 16,384, exported from
   packages/service/src/agent/openaiBackend.ts and sent as `max_tokens`
   on every planner chat-completions request. Nothing else changed
   (retry schedule [1000, 2500, 6000], parse-retry, temperature 0).
   Pinned by a new agent-modelconfig test asserting the captured
   request body; that suite is 30/30 PASS; service tsc clean; service
   dist rebuilt.
2. Case 5: **FAIL, 0/12** — one confirmation run on the isolated
   8970-8979 stack with the budgeted dist. The multi-write plan's
   planner completion was again non-JSON (well-formed start per the
   bounded prefix), retries exhausted, graceful busy reply, zero
   writes. The raised budget did not close case 5 in this run; per
   tasking it was not raised again and the run was not repeated.
   Evidence: hidden_files/case5-closure/case5-confirm.json.
3. Full suite: 83 files / 1605 passed / 1 skipped / 0 failed.
4. New failures observed: none in the suite. The case-5 live failure
   is the pre-existing, already-attributed defect (planner completion
   non-JSON on the longest plan shape), not a regression from this
   change — the budget change is request-construction only and the
   failing call's error class is identical to the pre-budget runs.
