# Agent Failures Fix Program — Brief (user directive, 2026-10-22 ~11:02 PDT)

Source of verdicts: hidden_files/agent-rerun/REPORT.md ITEM 4 (final
per-case table) + hidden_files/case5-closure/REPORT.md. Already handled
elsewhere, NOT in this program: Finding F2 sheet.add (FIXED, pushed
565c9095) and case-7 open_data_source non-materialization (fix running,
hidden_files/case7-open-fix/). This program takes every REMAINING agent
failure that has a product-side lever. Read the two reports above before
designing anything.

## Sequencing constraint
packages/service/src/agent/runtime.ts is also being touched by the
case-7 fix (hidden_files/case7-open-fix/REPORT.md). Read that report
first; if its fix has not landed yet, start with W5/W2-prompt work and
pick up runtime.ts items after it lands. Never overwrite its changes.

## Workstreams

### W1 — Case 5: plan-splitting for multi-write plans (FAIL 0/12)
Mechanism proven: the planner's single completion for a 12-write plan
comes back non-JSON (starts well-formed, degenerates). The output
budget lever (PLANNER_MAX_OUTPUT_TOKENS=16,384) landed and the re-run
STILL failed — the completion misbehaves at a budget the plan should
fit in ~4x over, so the lever is plan SHAPE, not size (planner-fix
report's named follow-up 2). Fix: the planner/runtime splits a plan
with many writes into sequential sub-plans (e.g. chunked per-row or
per-few-rows completions), each parsed and executed before the next is
requested; a failed chunk retries within the existing bounded retry,
and partial progress is reported honestly (never a silent busy reply
over zero writes when some chunks landed). Gate: case-5 confirmation
re-run (agent-rerun confirm-cases.mjs case5) — PASS = 12/12 values in
column D read back from the engine. If splitting still fails, report
the new evidence plainly; do not tune blindly.

### W2 — Aggregate integrity: cases 1 (total leg), 7a, 7b (FAIL legs)
Failure shape: the planner sums PARTIAL read windows by hand and
presents the partial sum as the total (case 1: 35,300 reproduced 3/3;
7a: answered 40 vs 55 after an ask, without recomputing; 7b: 167.83 vs
4027.86). The established product rule (planner-fix program) is that
aggregates are ENGINE-COMPUTED: scratch SUM/SUMIF formula + read-back,
hand addition FORBIDDEN — it is evidently not holding for totals over
read windows. Fix: strengthen the contract where it actually breaks —
planner instructions + runtime support so that any total/aggregate
answer is produced by (a) a scratch-formula engine computation with
read-back, or (b) analyze_data under the header contract; a final
answer whose number appears in NO tool result and matches a partial
window sum must not be presentable as the total. Add unit coverage for
the enforcement you build. Gate: re-runs of case 1 (all four legs),
7a, 7b on an isolated stack — PASS = exact ground truths (159,400
total; 55; 4027.86) in >=4/5 attempts each. If flash-lite still fails
deterministically after the enforcement, close as a documented model
limit WITH the attempt evidence — do not loop forever.

### W3 — Sheet-context grounding: case 15 (FAIL) + case 18's redundant ask
Failure shape: vague phrasing -> planner fixates on asking WHICH sheet
(gate suppresses repeatedly), detours through memory, and its final
ask carries FABRICATED sheet options (Sheet1/2/3 that do not exist);
the turn dies on a wrong sheet name. Case 18 passed but still burned a
redundant which-sheet ask on a one-sheet-evident context. Fix: (a)
inject the open workbook's real sheet names + active sheet into the
planner's context every turn; (b) validate ask options that name
sheets against the real list — fabricated options are rejected before
the ask parks (regenerate or convert to a grounded action). Gate:
case 15 re-run reaches the data and answers; case 18 re-run has no
redundant which-sheet ask.

### W4 — Finding 3: gate-suppressed asks must not stay answerable
A gate-SUPPRESSED ask still leaves an answerable pending entry;
answering it runs a turn on a DIFFERENT (deterministic-backend)
runtime and can spawn a help-menu loop. Fix: suppressed asks are
consumed/closed at suppression time; answering a consumed ask is a
clean no-op response, never a cross-runtime turn. Unit-pinned.

### W5 — Case 17 (PARTIAL): product-knowledge for how-to questions
The pivot how-to described the AGENT's analyze_data tool path instead
of the product UI (Insert > PivotTable). The agent's scope rule allows
Icecream-Sheets product knowledge as a source — there is no curated
corpus, so answers are model-parametric. Fix: add a small curated
product-knowledge set for the common how-tos (create a PivotTable,
create a chart, freeze panes, filter, conditional formatting — each
describing the real UI path from the shipped product; verify each
step against the actual Ribbon/UI code, do not invent UI). Gate:
case 17 re-run describes the Insert > PivotTable UI path.

### W6 — Case 2 (FAIL, model limit): header-write guardrail (mitigation)
The planner wrote a value onto the header cell (0,2), silently
corrupting "Revenue"; the write tool executed the coordinates exactly.
The model limit itself is documented; the PRODUCT gap is that a
header overwrite is silent. Fix: a runtime guardrail — when a planned
write targets a cell in a detected header row and would overwrite a
non-empty text header with a value, route it through the existing
HITL confirmation (agent.request_approval) instead of executing
silently. The user/planner then sees the exact target before it
happens. Gate: case 2 re-run no longer corrupts the header silently
(the write is either corrected by the planner, confirmed knowingly, or
refused); the sheet's header survives the turn. Do NOT reclassify the
model limit; report the mitigation's effect honestly.

## Validation + record
- Isolated stack, own port block stated in the report FIRST; the
  agent-rerun harness patterns (cases/, confirm-cases.mjs) are the
  drivers; ground truths: 159,400 / 89,100 / 55 / 4027.86.
- Related suites green per workstream (agent family, agent-runtime,
  agent-modelconfig, analysis) + service tsc clean; run the FULL
  packages/service suite once at the end.
- Record: hidden_files/agent-failures-fix/REPORT.md — checkpoint FIRST
  and after each workstream; per-workstream verdict with the re-run
  evidence; anything not landed named with its reason. TMPDIR under
  ~/workspace. Do NOT touch progress.md. No git push (parent handles).
