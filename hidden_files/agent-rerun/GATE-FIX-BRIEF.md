# GATE FIX BRIEF — grounding-gate options-exemption hole

Written by the parent 2026-10-22 ~06:55 PDT, at the user's direction (document it → send it to the coding agent → fix properly → validation required). Program record: `hidden_files/agent-rerun/REPORT.md` (see its "GATE DIAGNOSIS" section, parent, 2026-10-22 ~06:47 PDT — this brief formalizes that diagnosis as the tasking).

## Background

The agent validation re-run lost three coordinators in a row to daemon restarts (dbe8fd0f ended mid-validation; 20f66d5e died after landing the combined build; 939df38b died <5 min into its resume). The parent performed the diagnosis directly from the on-disk evidence. The remaining proof program (cases 1/2/5 confirmation, case 3a spot check, Wave D, final verdict table) is OUT of this brief's scope — it re-dispatches once the gate is proven.

## The defect (proven, parent-verified)

The grounding gate (FIX-R4) in `packages/service/src/agent/runtime.ts` forbids the planner from asking the user anything before it has executed a real tool this turn — with one documented EXEMPTION (the EXEMPTION comment at the top of `runLoop`, and the gate condition ~`runtime.ts:928`): **an ask carrying options may park ungrounded**, on the stated assumption that ask cascades are free-text and options asks are structured intent choices offered by product flows.

Evidence that the assumption is false — `hidden_files/agent-rerun/cases/planner-diag/results-combined.json`, turn 1, on the combined build (gate present in src and dist; dist grep = 8 hits for "grounded"):

- audit: `user_message` → `question` ("Which column in the Sales sheet contains the revenue data?") → `tool_call agent.offer_options ok:true` → `timeout`. NO tool execution preceded the ask. Wall ~255 s (the full HITL wait), reply = the graceful timeout message (M4 working, HTTP 200).
- Turn 2 of the same run (a write instruction) succeeded end-to-end in 29.6 s (reads + write + success reply) — the machinery is sound when the planner leads with tools.
- The unit suite PINS the exemption (`packages/service/tests/agent-runtime.test.ts:269`, "an options ask may park ungrounded"), which is why units were green while the live shape failed.

Root cause: flash-lite packaged a fact-fishing question — the exact failure class the gate was built to kill — as an options ask, and the exemption waved it through.

## The fix (user-endorsed direction)

**Do NOT delete the exemption. Scope it to the product flows it was written for** (app-generation / unknown-intent choice asks, e.g. "Describe the app / Analyze the data instead" — protected by test :570, which must stay green).

Requirements:

1. A planner-generated ask on a data turn is gated **whether or not it carries options**: if the planner has not grounded this turn, the ask is suppressed with the existing steering note and the loop continues (suppression mechanics unchanged).
2. Product-flow options asks still park ungrounded, exactly as today.
3. Discrimination between the two, in preference order — pick the narrowest the code actually supports and justify the choice in the report:
   a. routed-intent context available at the gate (the turn's intent is a data question vs an app-generation/unknown-intent flow);
   b. an explicit marker carried by product-constructed asks;
   c. product-defined option sets.
4. FORBIDDEN: classifying by question text; deleting the exemption; weakening the gate for free-text asks.

## Validation (required)

Unit:
- Rewrite the pinning test at `agent-runtime.test.ts:269` to the new rule: an options ask on a data turn is suppressed; a product-flow options ask still parks.
- Test :570 (app-generation options pause) green; full agent family green; `npx tsc --noEmit` clean in packages/service.

Live (isolated stack, own ports, TMPDIR under ~/workspace):
- Note the dist rebuild in REPORT.md BEFORE rebuilding `packages/service` dist (the shared stack loads dist at process start; the Wave C coordinator is live on the same tree — read `hidden_files/wave-c-fixes/REPORT.md` first; never restart shared services).
- Single-turn diagnostic — "What is the total revenue in the Sales sheet?" — PASS requires ALL of: the reply computes **159,400**; the audit contains **no question/park entries**; no HITL wait.
- One app-generation-shaped turn to prove the legitimate exemption still parks with its options (the product flow is not collateral damage).

Evidence (audit excerpts, test counts, the discrimination chosen and why) goes into the "GATE FIX" section of `hidden_files/agent-rerun/REPORT.md`. Do NOT touch progress.md. No git push.
