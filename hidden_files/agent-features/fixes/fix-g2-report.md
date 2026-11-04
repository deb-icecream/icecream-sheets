# FIX-G2 report — planner support for create_chart (COORDINATOR-VERIFIED)

Status: **COMPLETE** (verified by the coordinator directly, 2026-10-21
~17:5x PDT, after two daemon restarts killed the original worker and
its recovery worker before either could write this report).

## What is on disk (packages/service/src/agent/openaiBackend.ts)

- Line 54: `'create_chart'` is in DEFAULT_ALLOWED_TOOLS.
- Line 81: convention guard — create_chart is named as the SOLE
  exception that takes an A1 "range" string (all other tools use
  numeric bounds / exact field names).
- Lines 95–96: exact create_chart schema in AGENT_SYSTEM_PROMPT:
  {sheet, range (A1 string, includes header row, numeric data
  columns, text category column allowed), kind:
  column|bar|line|area|pie|doughnut (fail-closed — other kinds
  rejected by the tool), title?, anchor? (default below the data)}.
- Line 97: RETURN CONTRACT — no follow-up tool call, no
  execute_code/analyze_data redraw; the done reply states the chart
  was added to the sheet with title/kind/range.
- Lines 98–101: CHART ROUTES distinction — analyze_data = ephemeral
  chat-only chart; create_chart = native chart IN the sheet
  (persists, saves with the file); wording cues for sheet placement
  → create_chart; ambiguous placement → ASK the user instead of
  guessing.
- Lines 127–129: worked example — one create_chart action
  {sheet "Sheet1", range "A1:B5", kind "column", title "Monthly
  Sales"}, no riding done action.

## Test evidence (coordinator's own run)

`tests/agent-modelconfig.test.ts:348` — describe block "create_chart
planner support (FIX-G2)" including "validatePlan accepts a
create_chart plan with the prompt example arguments".

Coordinator run (packages/service):
`npx vitest run tests/agent-modelconfig.test.ts
tests/agent-guardrails.test.ts tests/agent-runtime.test.ts
tests/agentThreads.test.ts tests/agentThreadPersistence.test.ts`
→ **5 files, 74 tests, ALL PASSED (0 failed)** (vitest completion
output for the run, 265s wall under concurrent tree load).
CORRECTION: an earlier draft of this report cited 139 tests from a
mid-flow handoff figure; the run's own completion output says 74 —
74 is the verified number.

## Notes

- Depends on FIX-G (the create_chart MCP tool itself) for live
  case 4; the planner side is done.
- No other worker action remains for G2.
