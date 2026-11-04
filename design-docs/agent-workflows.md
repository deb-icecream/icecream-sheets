# Agent Workflows — Multi-Step Autonomous Flows

Status: OWNER DIRECTIVE, 2026-10-22 ~21:44 PDT. The owner rejects any
functional limit on agent work: "There should not be any limit. The
agent should be working no matter what, whether it is a multi-step thing
or a very long process." This doc defines the normal use cases and the
workflow runtime that makes them complete.

## 0. The limit that exists today (measured, in code)

- One chat turn runs a planner loop of AT MOST 10 iterations
  (`AGENT_MAX_ITERATIONS = 10`, packages/gateway/src/services/agentSvc.ts:130;
  the service runtime default is 5, runtime.ts:257; loop at runtime.ts:886).
  Every iteration is one plan → execute round. A task needing an 11th
  round dies unfinished, mid-work.
- The recorded failure (agent program, case W1) is worse than the cap:
  the planner WASTES rounds — re-planning instead of progressing, and
  mishandling confirmation resume — scoring 9/12, 9/12, 0/12 on a
  multi-step case. Raising the number alone does not fix wasted rounds.
- `PLANNER_MAX_OUTPUT_TOKENS = 16_384` (openaiBackend.ts:67) stays — it
  is a per-call output budget, not a task limit.

## 1. The requirement, translated honestly

No TASK-level limit: a legitimate job runs to completion however many
steps it takes. The only permitted stops are: the job is DONE, the user
cancels, the job needs a human decision (ask/approval — the existing
gates), or the job is PROVABLY STUCK (no progress across consecutive
steps on the same sub-goal, after retries with steering) — and a stuck
stop must say what it completed, what it was attempting, and what would
unblock it. A raw round count is never a stop reason.

## 2. The workflow runtime (what to build)

Layer a durable workflow over the existing turn runtime; do not rewrite
the planner.

1. **Plan as data.** For a multi-step ask, the agent first produces an
   explicit step plan (ordered steps, each with a goal and a completion
   check). The plan is stored with the thread (the runtime already has
   thread persistence) and is VISIBLE to the user (it feeds the #40
   streaming UI's thought/progress region).
2. **Step execution.** Steps run one at a time through the existing
   planner/tool loop, each with its OWN iteration budget — the budget
   scopes to a step, never to the job. A step that exhausts its budget
   is RETRIED with steering (what was tried, what failed), then
   re-planned (split/replace the step), before the job may call itself
   stuck.
3. **Verify each step.** Where a step has a checkable outcome (a total,
   a row count, a cell value, a created object), the runtime verifies it
   before moving on — ground truth over the planner's self-report.
   Failed verification = the step is not done; retry/re-plan per (2).
4. **Checkpoint + resume.** After every completed step, the workflow
   state (plan, completed steps, key results) is persisted. A crash, a
   timeout, or a confirmation pause resumes from the last checkpoint —
   never from zero, never repeating completed steps. Confirmation
   resume is step-aware (the W1 resume bug is in scope to fix).
5. **Progress, not silence.** The workflow emits step events (started /
   done / verifying / retrying) that the chat UI renders as the live
   plan — this is the server side of design-docs/agent-chat-ux-design-
   system.md §2/§3.
6. **Cost guardrails are operational, not functional.** Per-step token
   budgets and the existing rate/concurrency guards stay. There is no
   per-job step ceiling. If operations later need a safety valve, it is
   an operator alarm + user-visible notice, never a silent kill.

## 3. The normal use cases (each is an acceptance workflow)

Fixtures with known ground truth (sales.csv: SUM(revenue) = 4027.86)
anchor the numeric ones. Each use case must run END-TO-END, through the
agent, to a verified result.

- **UC-1 Clean a messy dataset.** Dedupe rows, fix column types, split
  a combined column, fill/flag blanks, trim junk. Verify: row counts,
  no dupes, types correct on sampled cells.
- **UC-2 Build a summary from raw data.** Group + aggregate + a pivot-
  style summary sheet + a chart. Verify: totals equal ground truth.
- **UC-3 Answer a business question end-to-end.** "Which region grew
  fastest last quarter, and show me" — find data, compute, chart,
  explain. Verify: the number, the chart's data.
- **UC-4 Restructure a workbook.** Normalize a flat table (extract
  dimension sheets, link by keys) or split one sheet into many by a
  column. Verify: total rows preserved, totals reconcile.
- **UC-5 Consolidate many files into one.** Several workbooks → one
  master with per-file sections and a reconciled grand total.
  Verify: grand total = sum of parts.
- **UC-6 Repair a broken sheet.** Find error cells / broken formulas,
  diagnose, fix, re-verify the sheet calculates clean.
- **UC-7 Build an app from data.** Data → generated app → live binding
  proven by editing a value and seeing the app update.
- **UC-8 Set up a recurring automation.** A trigger that refreshes a
  summary on new data; prove it fires and updates the output.
- **UC-9 Long-horizon composite (the depth proof).** One ask that
  chains UC-1 → UC-2 → UC-7: clean the raw file, summarize it, build
  the app — 25+ steps across at least 3 planner turns' worth of work.
  Verify: every stage's ground truth + the final app. THIS is the case
  the old 10-round cap killed; it must complete.

## 4. Validation

### 4.0 Regression guard (OWNER DIRECTIVE, 2026-10-22 ~21:49 PDT)
Nothing that works today may break because of this change. Concretely:
- BEFORE changing the runtime, run the existing agent case set
  (agent-rerun / agent-failures-fix records, incl. the gated cases and
  the case-7 open_data_source ground truth) and record the baseline
  results in the program report.
- AFTER the change, the same set must pass identically. Any case that
  changes behavior — pass→fail, different totals, different ask/
  confirmation behavior — is a regression to fix, not a footnote.
- Single-turn behavior is untouched by design: simple asks that the
  current runtime answers in one or two rounds must take the same path
  with the same results; the workflow layer engages for multi-step work
  and must be invisible elsewhere. List every intentional behavioral
  difference in the report, with its reason.

- Every UC runs on the local production-topology stack, driven the way
  a user drives it (chat), with the workflow's plan + step log captured.
- Each UC reports: steps planned / completed / retried, verification
  results vs ground truth, wall time, and any stuck-stop (there must be
  none on the UC set).
- UC-9 additionally: kill the service mid-workflow once; the job must
  resume from checkpoint and still complete correctly.
- Regression: the existing agent case set (agent-rerun /
  agent-failures-fix records) must not degrade; the W1 case in
  particular must now complete via workflow steps.
- Related tests only; tsc clean. No changes to apps/web in this program
  (the step-event contract is recorded for the #40 UI work to consume).
