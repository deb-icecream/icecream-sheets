# FIX-A Report — LLM planner contract (D1, D1b, D2)

Worker: FIX-A · Scope: `packages/service` ONLY (source + tests) · Date: 2026-10-21
No dist rebuild, no stack restart, no git push (coordinated window does that later).

## Verdict

All three defects fixed and covered by new tests. Baseline 48/48 agent tests
passing → after: **57/57** in the three target files, **99/99** in the other
agent-adjacent files, `tsc --noEmit` clean before and after. No pre-existing
failures found in any of these files.

## What changed (file:line)

### D1 — planner prompt now carries the exact MCP tool schemas
`packages/service/src/agent/openaiBackend.ts:68` — `SYSTEM_PROMPT` rewritten
(and now exported as `SYSTEM_PROMPT`; re-exported from the package index as
`AGENT_SYSTEM_PROMPT`, `packages/service/src/index.ts:520`). The prompt now
mirrors the real zod schemas in `packages/mcp-server/src/server.ts` for every
tool in `DEFAULT_ALLOWED_TOOLS`:

- `read_cells {"sheet", "startRow", "startCol", "endRow", "endCol"}` — all
  required, 0-based ints, inclusive rectangle; result shape `{"cells": [[…]]}`.
- `write_cells {"cells": [{"sheet","row","col","value"}]}` — cells is an ARRAY
  (1–1000), explicitly "never an object/dictionary keyed by cell address".
- `set_formulas {"formulas": [{"sheet","row","col","formula"}]}` — array,
  formula string with leading `=`.
- `recalculate {}`.
- `analyze_data {"intent" (required), "sheet"?, "startRow"?, "startCol"?,
  "endRow"?, "endCol"?}` — bounds all-or-none.
- `memory_save {"key","value"}`, `memory_load {"key"}`,
  `memory_update {"key","value"}` — with the note that the runtime stamps
  `userId` itself (runtime.ts `stampUser` overwrites it), so the planner must
  not supply one.
- `agent.ask_question {"question"}`, `agent.offer_options {"question",
  "options"}`, `agent.request_approval {"action","detail"}` — schemas given,
  but the planner is told NOT to emit them as tool actions (see ask contract).

Plus: 0-based indexing (A1 = row 0, col 0), value typing (numbers as JSON
numbers never quoted strings, booleans, null for empty, formulas as strings
starting with `=`), explicit bans on the invented shapes from the probe
(`"sheet_name"`, `"cell_range"`, `"range"`, single `"cell"`), a FAILED-result
self-correction rule (read the error, fix args to the schema, never repeat the
identical failing call, never invent the missing data), and the worked
example: "sum of A1:A3" → iteration 1 `read_cells {sheet:"Sheet1", startRow:0,
startCol:0, endRow:2, endCol:0}` with NO done → iteration 2, given
`[[111],[222],[333]]`, done-only plan with message "The sum of A1:A3 on
Sheet1 is 666."

Ask contract: questions go through an `ask` ACTION —
`{"type":"ask","question":…}` (free text) or with `"options"` (choices) —
which the runtime maps to the `agent.ask_question` / `agent.offer_options`
MCP tools and pauses on; approvals are the runtime's own §7 gate, never a
planner-emitted tool call.

### D2 — done semantics, fixed on both sides
Prompt side (in the new `SYSTEM_PROMPT`): "If your plan contains ANY tool
actions, do NOT include a `{"type":"done"}` action… Return `done` ONLY as the
SOLE action of a plan, on the final iteration, with the complete answer in
`message`." The old "End every plan with done" instruction is gone (a test
asserts its absence).

Runtime side — `packages/service/src/agent/runtime.ts:617-634` (`runLoop`):
the old `done = plan.actions.some(a => a.type === 'done') || toolActions.length === 0`
check is replaced: after tools execute (and after the ask branch), the turn
ends **only when `toolActions.length === 0`**; a plan carrying tool actions
always continues to the next iteration, a riding `done` is ignored.
Heuristic-backend behavior is preserved exactly: its iteration-1 tool plan
(no done) continues, its iteration-2 `{message, [done]}` plan has no tool
actions and ends the turn with the composed message (all pre-existing
heuristic end-to-end tests pass unchanged). Iteration caps (`maxIterations`)
and HITL pause semantics (ask branch, §7 confirmation branch) are untouched.

### D1b — real error text propagates to the planner
Root cause found in `parseToolResult` (runtime.ts): the product server's own
errors are JSON (`{ok:false, error}`), but **MCP SDK argument-validation
failures arrive as plain text with `isError: true`** (e.g. `MCP error -32602:
Input validation error: Invalid arguments for tool read_cells: Required at
sheet / Required at startRow / …`). The old parser JSON-parsed only
`content[0]`, fell into the catch branch, returned `ok:false` with
`error: undefined`, and `executeTools` formatted that as `failed: undefined`.

Fixes:
- `packages/service/src/agent/runtime.ts:743` — `parseToolResult` rewritten:
  joins ALL text content parts; on JSON `{ok:false}` or `isError` it returns
  the payload's `error`/`message`; on non-JSON `isError` results it returns
  the raw text as the error. A failed result now always has a defined,
  real `error` (fallback is a generic "tool call failed (no error detail)"
  only when the result carries literally no text). This also fixes the other
  `parseToolResult` callers (`subscribe`, `poll_events`,
  `agent.list_pending`, `agent.answer_pending`, …) which threw
  `… failed: undefined` the same way.
- `packages/service/src/agent/runtime.ts:688` — `executeTools` summaries are
  built as `` `${tool} failed: ${error}` `` with a non-undefined fallback and
  bounded by the new `truncateText` helper (`MAX_SUMMARY_CHARS = 800`,
  runtime.ts:737), applied to thrown-error summaries too.
- `packages/service/src/agent/openaiBackend.ts:124,134` — `historyText` now
  surfaces a failed result's error payload (`errorTextOf` reads
  `error`/`text`/`message` from the result data) alongside the summary when
  formatting tool results into the next planner prompt, so the error text
  reaches the model even if a summary is ever shortened. Bounded at 800
  chars like the summary.

Verified empirically (throwaway probe test, removed after capture): with the
probe's invented args `{sheet_name, cell_range}` the summary is now
`read_cells failed: MCP error -32602: Input validation error: Invalid
arguments for tool read_cells: Required at sheet / Required at startRow /
Required at startCol / Required at endRow / …` — the real, actionable text.

## New prompt contract in brief

One JSON object `{"message", "actions"}`; actions are `tool` / `ask` /
`done`. Exact per-tool argument schemas as listed under D1 above; 0-based
rows/cols; numbers unquoted; formulas are `=`-strings; questions via `ask`
actions only; tool plans carry NO `done`; `done` appears only alone on the
final iteration with the full composed answer in `message`; on FAILED results,
fix args per the schema and retry, never repeat or fabricate.

## Tests

Baseline (before edits), three target files:
`agent-backends 17 + agent-runtime 20 + agent-modelconfig 11 = 48 passed, 0 failed`.
`tsc -p tsconfig.json --noEmit`: clean.

After edits:
- `tests/agent-runtime.test.ts` — 24 tests (was 20), all pass. New:
  - `planner done semantics (D2)` (line 453): tool+done plan continues the
    loop (planner called twice, read executed, final composed message wins);
    done-only plan ends in one iteration with its message.
  - `tool failure surfacing (D1b)` (line 512): stub backend emits the probe's
    wrong shapes; asserts the `ToolResultRecord.summary` the planner receives
    next iteration contains `read_cells failed:` + real error text (>10 chars
    beyond the prefix, not "unknown error"), never `undefined`, and the audit
    entry carries the identical summary.
  - `LLM planner self-correction (D1+D1b+D2, fake-fetch OpenAI backend)`
    (line 561): stateful fake-fetch `OpenAICompatibleBackend` + real
    `AgentRuntime` + real MCP server. Call 1 returns the probe's wrong-shape
    plan (`sheet_name`/`cell_range`, plus a riding `done`); call 2 asserts —
    inside the fake — nothing, but the test afterwards asserts the second
    request's user content contains `FAILED`, does not contain
    `failed: undefined`, and contains the first 60 chars of the exact error
    text from the runtime's failed audit entry; call 2 returns the corrected
    schema-exact read; call 3 receives the seeded tool data `[[10],[20],[30]]`
    in its prompt (asserted inside the fake) and returns the composed
    done-only answer. Runtime completes with "The sum of A1:A3 is 60." in
    exactly 3 planner calls, with one failed and one successful `read_cells`
    in the audit trail.
- `tests/agent-modelconfig.test.ts` — 16 tests (was 11), all pass. New
  `OpenAI planner prompt contract (D1/D2)` (line 248): exact schema field
  names for read_cells/write_cells/set_formulas/recalculate/analyze_data/
  memory_*/agent.*; indexing + typing + banned-shape assertions; done
  contract + worked-example assertions; the prompt captured from a real
  `plan()` request body equals `SYSTEM_PROMPT`; a failed tool result's error
  text appears verbatim in the next planner call's input (D1b at the
  backend-formatting layer).
- `tests/agent-backends.test.ts` — 17/17 unchanged, all pass.
- Regression sweep of the remaining agent-adjacent files (not edited):
  `agent-proactive 11 + agentThreads 10 + agentThreadPersistence 4 +
  intent-router 57 + pendingAsks 17 = 99 passed, 0 failed`.
- `tsc -p tsconfig.json --noEmit` after edits: clean (exit 0).

Totals: 48 → 57 in target files (+9 new tests), 156 agent-related tests
passing overall, 0 failures, no pre-existing failures encountered.

## Found but NOT fixed (out of FIX-A scope / FYI)

- D4 (gateway proxy kills parked `/api/agent/message` at ~30 s) and F1
  (agent↔engine-session binding) are FIX-B's scope per COORDINATION.md; not
  touched here.
- `validatePlan` (openaiBackend.ts) validates only that tool args are an
  object — per-field schema validation stays with the MCP server (by design:
  its error text is now the self-correction signal). No change made.
- `historyText` truncates history message text at 500 chars and tool data at
  2000 chars (pre-existing bounds, kept). Tool summaries/errors are bounded
  at 800; very long SDK validation errors keep their head (the field-named
  part), which is the actionable end.
- The service `dist/` is stale relative to these source edits by design —
  the coordinated rebuild window must rebuild `packages/service` (and
  re-run the W1 probe / tour) before live validation can see D1/D1b/D2 fixed.
