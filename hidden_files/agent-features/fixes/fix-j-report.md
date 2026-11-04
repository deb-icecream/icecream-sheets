# FIX-J Part 1 — Report (checkpointed)

Source: memory-trace.md build list Part 1, items 1–3.
Started: 2026-10-21 18:04 PDT

## Checklist
- [x] Item 1 — packages/mcp-server/src/memory.ts: persist() read-modify-write + fresh-instance recall; tests (a) fresh instance loads prior save, (b) A saves key1 / B saves key2 → C sees both, (c) per-user isolation under shared blob — DONE (see below)
- [x] Item 2 — packages/service/src/agent/intentRouter.ts + tests/agent-guardrails.test.ts: off-topic fixtures decline with zero planner/backend calls (Einstein, capital of France, Eiffel Tower, penguins fun fact, football last night, chit-chat, joke); in-scope counterweights: product question + ~1500-char detailed request (against 2000 gate); existing 20 in-scope fixtures still pass — DONE (see below)
- [x] Item 3 — packages/service/src/agent/openaiBackend.ts: TWO-SOURCE SCOPE block in AGENT_SYSTEM_PROMPT near top; prompt-content test if pattern exists — DONE (see below)

## Item 1 — memory.ts read-modify-write
Status: DONE — code + tests green.
- `packages/mcp-server/src/memory.ts`: added `readPersisted()` (corrupt/missing blob → empty map, never throws); `ensureLoaded()` now uses it (a NEW instance over shared persistence recalls prior saves — runtime-swap simulation); `persist()` is READ-MODIFY-WRITE — reload blob, merge this instance's in-memory state over it (this instance's keys win for keys it holds), save merged blob, adopt merged state. Added `clearedUsers` set so `clearUser()` deletions are not resurrected by the merge (marker cleared on successful persist; a later write to that user un-clears them in `ns()`). Preserved: per-user isolation, §12 header contract (unchanged), corrupt-blob tolerance, best-effort persist (save failure keeps in-memory state usable, never throws).
- Tests `packages/mcp-server/tests/memory.test.ts`: new describe "MemoryStore over a SHARED persistence (FIX-J read-modify-write)" with 7 tests: (a) fresh instance recalls prior instance's saves; (b) two pre-loaded instances A saves key1 / B saves key2 → fresh C sees BOTH (plus B adopts merged blob and sees key1); (b2) same-key last writer wins; (c) per-user isolation under the shared blob (alice/bob/carol); clearUser not resurrected; corrupt-blob recovery; persist-failure best-effort.
- Run: `packages/mcp-server: npx vitest run tests/memory.test.ts` → 15 passed / 15 (8 pre-existing + 7 new), 1 file passed.

## Item 2 — scope tightening fixtures / classifier
Status: DONE — code + tests green.
- Classifier audit first: "Who is Einstein?" (who-is pattern), "What is the capital of France?" (capital-of), "Who won the football game last night?" (who-won/football sports) and "Tell me a joke" (jokes) ALREADY declined via pre-existing OFF_TOPIC_PATTERNS. Three fixtures leaked through to the in-scope default and needed new families in `packages/service/src/agent/intentRouter.ts` OFF_TOPIC_PATTERNS: (1) measurement/attribute trivia — `/\bhow (?:tall|high|long|far|big|old|deep|heavy|fast|hot|cold) is (?:the|a|an|that|this)\b/` ("How tall is the Eiffel Tower?"); (2) trivia/fun-fact requests — `fun facts?|trivia|tell me (a|an)(fun) fact|facts? about|did you know` ("Tell me a fun fact about penguins"); (3) substantive chit-chat — `how's/is your day|how are you doing/feeling/today|how's/is it going|how's/is your morning/afternoon/evening/life/weekend` ("How's your day going?"). All three are only consulted AFTER strong anchors, the coding check, weak anchors and intent signals, so anchored sheet questions (e.g. "how tall is row 3" — "rows" is a strong anchor) are unaffected. Scope-gate header comment updated with the 17:40 tightening; bare agent-directed greetings ("hi", "thanks") stay in-scope per the pre-existing design (they are conversation WITH the product, not outside knowledge).
- Fixtures `packages/service/tests/agent-guardrails.test.ts`: OFF_TOPIC_PROMPTS += the 7 task prompts (Einstein, capital of France, Eiffel Tower, penguins fun fact, football last night, "How's your day going?", "Tell me a joke" — joke existed in lower case; added in the task's casing as the chit-chat fixture). The existing runtime test drives the whole array: every one declines with AGENT_SCOPE_DECLINE_MESSAGE and backend.calls stays 0, one guardrail audit entry each. IN_SCOPE_PROMPTS += counterweight product question "how do I create a pivot table in this app?" (array now 21; all 20 pre-existing fixtures still pass the classify + reach-backend loops).
- Long counterweight: `LONG_DETAILED_IN_SCOPE_PROMPT` — a realistic 9-sentence detailed Sales-sheet analysis request (range/column spec, per-region + per-product breakdowns, sorting, top-5 reps, period comparison, summary table, chart, caveats), 1,579 chars by construction, with a dedicated runtime test asserting length >1,400 and <2,000 (written against the tightened 2,000-char gate), classifyScope = in-scope, reply 'planned ok', backend.calls = 1.
- Run: `packages/service: npx vitest run tests/agent-guardrails.test.ts` → 18 passed / 18, 1 file passed.

## Item 3 — openaiBackend TWO-SOURCE prompt block
Status: DONE — code + tests green.
- `packages/service/src/agent/openaiBackend.ts` (SYSTEM_PROMPT, exported as SYSTEM_PROMPT and re-exported as AGENT_SYSTEM_PROMPT from service index): inserted a "TWO-SOURCE SCOPE (hard rule — this governs every request)" block immediately after the role-framing paragraph, before the JSON-format instructions and well before TOOL ARGUMENT SCHEMAS. It states: answer ONLY from (1) data reachable through tools in this session (user's sheets/workbooks, files, connected data sources, this conversation's earlier tool results) and (2) Icecream Sheets product knowledge (how the product works, its features, spreadsheet functions); everything else (general knowledge/trivia, news/current events, weather, sports, jokes, chit-chat, unrelated general coding) is NEVER answered from general knowledge — decline politely in a no-tool "done" plan whose message redirects to in-scope capabilities; product questions are answered directly in a "done" plan with NO tool calls when no user data is involved. NOT disturbed: all tool schemas, the create_chart block, the memory tool schemas, and the pre-existing bottom SCOPE second-layer block (kept as-is; the new block is the top-of-prompt statement of the same rule).
- Test `packages/service/tests/agent-modelconfig.test.ts`: new describe "two-source scope prompt block (FIX-J)" following the file's existing prompt-content pattern — asserts the block exists, precedes TOOL ARGUMENT SCHEMAS, and contains both sources, the NEVER-answered-from-general-knowledge decline, and the direct-answer/no-tool-calls product rule.
- Runs: agent-modelconfig 20 passed / 20 (19 pre-existing + 1 new); agent-runtime 24 passed / 24 (unchanged, confirms no runtime regression from the prompt change).

## Test runs (totals)
- `packages/mcp-server: npx vitest run tests/memory.test.ts` → 15 passed / 15, 1 file.
- `packages/service: npx vitest run tests/agent-guardrails.test.ts` → 18 passed / 18, 1 file.
- `packages/service: npx vitest run tests/agent-modelconfig.test.ts tests/agent-runtime.test.ts` → 44 passed / 44 (20 + 24), 2 files.
- Typecheck: `npx tsc -p tsconfig.json --noEmit` clean (exit 0) in BOTH packages/mcp-server and packages/service.
- No unrelated reds encountered in any touched suite — nothing to baseline-attribute.

## Notes / leftovers
- Part 2 of FIX-J (gateway agentSvc persistence wiring; runtime input-cap default 4,000 → 2,000) is NOT part of this task and was not touched — gateway and runtime.ts untouched, per boundaries. The Item 2 long fixture is written against the future 2,000 cap so it survives that change.
- No git operations, no stack restarts performed.

## Boundaries respected
Files touched limited to: memory.ts (+ mcp-server tests), intentRouter.ts, agent-guardrails.test.ts, openaiBackend.ts (+ agent-modelconfig.test.ts if needed). No gateway, no runtime.ts, no git, no stack restarts.
