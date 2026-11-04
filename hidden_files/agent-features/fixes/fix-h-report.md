# FIX-H — Agent guardrails (user directive 2026-10-21, BRIEF addendum)

Scope honored: `packages/service` only (agent runtime + intent router +
planner prompt). No `packages/gateway` edits, no dist rebuild, no stack
restart, no git push.

## What already existed vs what was built

**Already existed (verified in code before edits, unchanged):**
- `AgentRuntime.maxIterations` (default 5) — planner iteration cap.
- Thread message cap `MAX_THREAD_MESSAGES` (threads.ts).
- Gateway generic 1 MB body cap (not agent-specific; untouched).
- Heuristic backend's `HELP_QUESTION` capabilities fallback for unknown
  intents (backends.ts) — an in-backend behavior, not a gate: the LLM
  planner path had **no** scope restriction at all.
- Tool-result prompt truncations in the planner backends (kept as-is).

**Built by FIX-H (all missing per the coordinator inventory):**
1. **Input-length cap** on `chat()`, `answer()`, and `createAppArtifact()`.
2. **Per-principal rate + concurrency limits** in the runtime with busy /
   rate replies that bypass the planner entirely.
3. **Reply-size bound** (message text only).
4. **Deterministic scope gate** (`classifyScope` in intentRouter.ts)
   enforced in the runtime before planning, plus the scope rule appended
   to the LLM planner `SYSTEM_PROMPT` as the second layer.
5. **Configuration**: new `AgentRuntimeOptions` fields with `AGENT_*` env
   fallbacks, so the gateway's `agentSvc` (which constructs runtimes
   without new wiring) is configured by env on the agent process.
6. New audit kind `'guardrail'` (types.ts) so rejections/declines are
   audit-logged distinctly; new exports in `src/index.ts`.

## Where each guardrail lives (file:line, packages/service/src)

| Guardrail | Location |
|---|---|
| Options + defaults + message builders | `agent/runtime.ts:104–188` (options 112–120; `DEFAULT_AGENT_*` 124–127; `resolveGuardrailLimit` 173) |
| Resolved limits + turn tracking state | `agent/runtime.ts:212–219`, constructor resolution `237–260` |
| Input cap — `chat()` | `agent/runtime.ts:524–532` |
| Concurrency check — `chat()` | `agent/runtime.ts:534–542` |
| Rate check (rolling 60 s) — `chat()` | `agent/runtime.ts:545–553` |
| Scope check — `chat()` (after length/rate, before planning) | `agent/runtime.ts:555–562` |
| Admitted-turn accounting (counters only for admitted turns) | `agent/runtime.ts:565–566`, decrement in `finally` |
| Input cap — `answer()` (before the pending ask is touched) | `agent/runtime.ts:597–606` |
| Input cap — `createAppArtifact()` (before `ensureConnected`/any tool call) | `agent/runtime.ts:333–341` |
| Guardrail reply plumbing (audit + thread handling) | `agent/runtime.ts:492–509` (`guardrailReply`) |
| Reply bound | `agent/runtime.ts:511–515` (`boundReplyText`); applied where replies are composed in `runLoop` (805, 842, 866) and as a safety net on the `chat()` return (575) |
| Scope classifier | `agent/intentRouter.ts:236` (`ScopeVerdict`), anchors/off-topic families 243–340, `classifyScope` 343–378 |
| Planner prompt second layer | `agent/openaiBackend.ts:123–126` (`SYSTEM_PROMPT` "SCOPE (hard rule)" block, appended after FIX-A's rewrite) |
| Audit kind | `agent/types.ts:90` (`'guardrail'`) |

## Defaults + configuration

| Option | Default | Env override |
|---|---|---|
| `maxInputChars` | 4,000 | `AGENT_MAX_INPUT_CHARS` |
| `maxConcurrentTurns` | 3 | `AGENT_MAX_CONCURRENT_TURNS` |
| `maxTurnsPerMinute` | 30 (rolling 60 s window) | `AGENT_MAX_TURNS_PER_MINUTE` |
| `maxReplyChars` | 8,000 | `AGENT_MAX_REPLY_CHARS` |
| `scopeGateEnabled` | `true` | `AGENT_SCOPE_GATE` (`'0'` disables) |

Resolution order: explicit option (positive finite number / boolean) →
env (parsed defensively; invalid → default) → default.

## Message texts (verbatim)

- Input cap (numbers substituted):
  `That message is too long for the agent — the limit is 4,000 characters (yours was 10,000). Please shorten it and try again.`
- Busy (concurrency):
  `I'm still working on your previous request — please wait for it to finish, then send that again.`
- Rate limit (default shown):
  `You're sending requests too quickly — the limit is 30 requests per minute. Please wait a moment and try again.`
- Scope decline:
  `I can only help with spreadsheet, data, and Icecream Sheets questions, so I can't answer that one. I can read and write cells and ranges (e.g. "sum of A1:A10", "set B2 to 5"), set formulas, recalculate, remember notes ("remember that the budget is 5000"), analyze data with charts and pivots, build apps from your data, run ETL recipes and automations, work with data sources, and generate reports. What would you like to do with your spreadsheet?`
- Reply truncation suffix:
  `… [reply truncated at the 8,000-character limit]` (message cut so the
  total length equals the cap exactly)

## Design decisions (made + documented in code)

- **Rejected turns are not stored as user messages.** A guardrail reply
  is recorded in the thread as a `system`-role notice plus the agent
  reply text, so an oversized paste or an off-topic prompt cannot poison
  the history later planner calls see (or burn the thread's message
  budget). Audit: one `guardrail` entry (summary names the guardrail +
  limit) + one `agent_message` entry; `actionsTaken` on the returned
  reply carries both. Zero `plan()` and zero tool calls — proven by a
  counting fake backend in tests.
- **Guardrail replies consume no rate/concurrency budget.** Counters are
  only touched by turns that pass every gate; declines are deterministic
  and cost no planner/tool work, and counting them could lock a user out
  for pasting one long message.
- **HITL is never blocked by the counters.** `answer()`/`answerPendingAsk`
  and `watch`/`pollWatch` bypass rate/concurrency entirely (proven in the
  concurrency test while a turn is in flight). The input cap *does* apply
  to `answer()` text, checked before the pending ask is touched, so an
  over-long answer never consumes the ask (tested). Note: `answer()` with
  **no** pending ask falls through to `chat()` and is treated as the new
  turn it is (all gates apply).
- **Greetings are in-scope, not runtime-intercepted.** `classifyScope`
  returns `'in-scope'` for agent-directed greetings/small talk; the
  capabilities reply then comes from the backend layer (the heuristic
  backend's HELP_QUESTION *is* the capabilities reply; an LLM backend
  answers politely under the prompt's scope rule). Intercepting greetings
  in the runtime would break the pluggable-backend contract — an existing
  baseline test expects a custom backend's own reply to "hello".
- **`createAppArtifact` rejects by throwing.** Its signature returns
  `GenerateArtifactResult` — there is no `AgentReply` channel — so an
  over-cap prompt throws an `Error` carrying the exact limit-naming
  message, audit-logged as a guardrail rejection, before the MCP client
  is even connected.
- **Classifier conservatism.** Order: greeting/agent-self → weather
  special-case (off-topic unless about weather *data*) → strong anchors
  (cell refs, sheet/data/product nouns, wider-five vocabulary, memory,
  product how-to, follow-up anaphora) → general-coding check →
  weak verb anchors + any `classifyIntent` signal → off-topic families
  (news, sports, jokes/essays, translation, general knowledge) → default
  **in-scope**. The coding check sits between the anchor tiers so "sort
  a list in python" is off-topic while "sort the Sales column" is saved
  by its strong anchors first.

## Tests — baseline vs after (packages/service)

Baseline (run BEFORE edits), 7 agent-related files: **139 passed, 0
failed** — agent-runtime 24, agent-modelconfig 16, intent-router 57,
agent-backends 17, agent-proactive 11, agentThreads 10,
agentThreadPersistence 4. Package `tsc --noEmit`: clean (exit 0).

After: the same 7 files still **139 passed** (no count or behavior
regressions), plus new `tests/agent-guardrails.test.ts`: **17 passed**,
plus `artifacts.test.ts` + `analysis.test.ts` (createAppArtifact /
router-adjacent): 94 passed. **Run total: 10 files, 250 passed, 0
failed.** Package `tsc --noEmit`: clean (exit 0).

New-test coverage, mapped to the task's required cases:
- (a) 10,000-char input → rejection naming 4,000/10,000, zero `plan()`
  calls, guardrail audit entry, no user message in history, thread still
  usable; 3,999-char in-scope input passes; `createAppArtifact` and
  `answer()` caps (incl. pending ask not consumed); env override.
- (b) Classifier + runtime: 10 off-topic fixtures (weather ×2, news,
  joke, sports, Python ×2, president trivia, translation, essay) →
  decline, zero `plan()` calls, capabilities text present; 20 in-scope
  fixtures covering cases 1, 2, 3, 3b/12, the wider five (ETL, automation,
  report, add-on), memory, product how-to, case-6 style
  ("delete the Q9 sheet"), a follow-up ("now do the same for column C"),
  case-15 borderline ("which product line looks strongest and why?"),
  greetings — every one returns `'in-scope'` from `classifyScope` AND
  produces a backend-planned turn at runtime.
- (c) Rate: `maxTurnsPerMinute=3` → 4th rapid chat = rate reply, no
  additional `plan()` calls. Concurrency: `maxConcurrentTurns=1` with a
  test-gated blocking backend → second chat = busy reply while the first
  completes normally after release; watch/pollWatch proven unblocked
  mid-turn.
- (d) Reply bound: 20,000-char backend message → exactly 8,000 chars with
  the truncation suffix; custom cap (100) honored; short replies intact.
- (e) Scope gate disabled via option and via `AGENT_SCOPE_GATE=0` →
  off-topic prompts reach the backend.

## Flagged but NOT changed

- **Per-process limits.** Rate/concurrency state lives in the runtime
  instance — per-principal in `agentSvc`, per-user in local mode, as
  specified. If the agent service ever runs multiple processes for one
  principal, the limits are per-process, not global; a shared limiter
  would be a gateway/service-infra change, out of FIX-H scope.
- **Known conservative slips** (accepted, per "ambiguity → in-scope";
  the planner-prompt layer is the backstop): bare building verbs with
  off-topic objects ("create a workout plan") and "what's the forecast
  for tomorrow?" (the word *forecast* is an analysis anchor; the word
  *weather* is what triggers the weather rule) resolve in-scope.
- **Gateway 1 MB body cap** remains a generic cap, not the agent limit —
  the runtime cap (4,000 chars) is the binding agent limit and fires
  first for any normally-delivered request.
- The heuristic backend still answers unknown-but-in-scope prompts with
  its HELP_QUESTION ask flow (unchanged); scope declines happen before
  it is ever consulted.
