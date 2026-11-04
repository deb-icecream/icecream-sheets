# W3 — Intent-router dead end for native-chart requests

## Diagnosis
- Live flow (traced in code + main-run transcript): web AgentChat.send()
  (apps/web/src/components/AgentChat.tsx:320) calls routePrompt() from
  packages/service/src/agent/intentRouter.ts BEFORE any runtime turn.
- Case-4 prompt "Create a column chart of revenue by region in the Sales
  sheet — a native chart in the sheet itself, not an image in the chat":
  classifier scores app=2 (create) vs analysis=3 (chart) -> confidence
  3/7 = 0.43 < 0.45 threshold -> 'disambiguate' with exactly
  DISAMBIGUATION_OPTIONS = Build an app / Analyze & visualize / Just answer.
  NO native-chart option, despite explicit sheet-placement language.
- "Build an app" branch (main-run-*): answerIntent() forces route 'app' ->
  dispatchIntent -> web AppGenerationPort -> gateway /artifacts/generate
  (agentSvc passes template: detectTemplate(prompt), i.e. routing is forced)
  -> an app titled with the truncated chart prompt is built and the chat
  replies 'Built "..." — it's open in the panel beside the chat.'
  End state: revision 0, no chart, no parse-back chart part. NOT silence —
  a wrong-product "success" that terminates the request with no hand-back
  to an answerable path. The app branch can never satisfy a native-chart
  request. That is the dead end.
- The native-chart path itself is sound: conversation/analysis routes fall
  through in AgentChat.handleRoute to runtime.chat(), whose planner
  (openaiBackend SYSTEM_PROMPT chart-routes section) maps explicit
  in-sheet chart wording to the create_chart MCP tool -> chart sink ->
  chart.add revision -> overlay -> saved xl/charts/chart1.xml
  (branch-analyze + branch-answer both PASS, 2/2 once reached).
- routeChatIntent (analysis/planner.ts) delegates to classifyIntent:
  kinds other than app/analysis map to 'other' (conversation fallback).

## Fix
- LANDED (source): intentRouter.ts is the primary file; runtime.ts NOT touched.
  1. New IntentKind/route 'chart'. hasExplicitNativeChartIntent(): chart
     noun + sheet/workbook placement (in/into/on/to (the|this) (Name)
     sheet|workbook, "native chart", or insertion-verb+chart+sheet
     mention), with an explicit-app-object guard ("build an app with a
     chart in the sheet" stays app lane). classifyIntent checks it FIRST
     at confidence 1 — explicit placement is unambiguous, so it SKIPS
     disambiguation (consistent with the header's zero-signal reasoning).
  2. Disambiguation for chart-mentioning ambiguous prompts now offers
     NATIVE_CHART_OPTION 'Native chart in sheet' FIRST (question text
     names it too); non-chart ambiguous prompts keep the original 3
     options/question verbatim. resolveDisambiguation maps the new
     option (+aliases) to 'chart'.
  3. dispatchIntent 'chart' reuses the EXISTING conversation port (the
     agent runtime turn) — no parallel chart port invented; the planner's
     chart-routes contract turns the wording into create_chart.
  4. Dead-end fix: artifacts/generator.ts generateAndSaveArtifact hands
     back {routed:'not-artifact', reason: NATIVE_CHART_HANDOFF} for an
     explicit native-chart prompt BEFORE routing AND before forced-
     template generation — so neither the disambiguation 'Build an app'
     answer nor the gateway lane's unconditional template can silently
     build an app and report success for a chart request; the reply
     names the answerable chart path instead.
  5. AgentChat.tsx: handleRoute treats 'chart' like conversation
     (runtime.chat); answerIntent forces a 'chart' IntentRoute for the
     new option. Service index + artifacts index export the new symbols.
- Files changed: packages/service/src/agent/intentRouter.ts,
  packages/service/src/index.ts, packages/service/src/artifacts/generator.ts,
  packages/service/src/artifacts/index.ts,
  apps/web/src/components/AgentChat.tsx. Tests: see Validation.

## Validation
- Service tsc --noEmit: CLEAN (TSC_EXIT=0, tmp-w3-tsc2.log).
- Targeted vitest: tests/intent-router.test.ts 71/71 PASS (new W3 block:
  explicit prompts route 'chart' at confidence 1 incl. the exact case-4
  main-run prompt; no-placement chart prompts stay analysis; app-object
  guard; ambiguous chart prompt offers 'Native chart in sheet' first;
  every offered option resolves + dispatches to a real outcome; chart
  dispatch goes through the conversation port only) +
  tests/artifacts.test.ts 31/31 PASS (new: explicit chart prompt ->
  not-artifact hand-back with store empty; forced-template chart prompt
  -> same hand-back). Log: ~/workspace/tmp-w3-vitest.log.
- Full service suite: 1574 passed / 4 failed / 1 skipped (82 files).
  The 4 failures are NOT in W3-touched areas and are accounted for:
  (a) automationSandbox x2 — PASS 13/13 on isolated re-run (load flakes;
  full-suite durations were 23 s/11 s under heavy VM contention);
  (b) agent-guardrails input-cap answer() — isolated re-run 18/19, the
  same test times out at the 5 s test limit while suite collect alone
  took 39 s (transform 21.8 s) under load;
  (c) agentThreadPersistence 'pending ask survives restart' — fails
  deterministically, root cause is runtime.ts:964's NEW ask-budget
  steering reply ('Ask budget for this turn is exhausted...') replacing
  the expected "didn't get an answer in time" — that text/behavior is
  part of the planner-fix/grounding-gate runtime.ts delta (+455 lines,
  landed 12:32 UTC, minutes before W3 dispatch); the test file is
  unmodified vs baseline and its prompt never intersects the W3
  classifier branch. PRE-EXISTING vs W3, owned by the planner/grounding
  programs — flagged here, not fixed (runtime.ts is their hot file).
- Web tsc (apps/web, includes AgentChat.tsx change): CLEAN.
- Service dist rebuilt (BUILD_EXIT=0); web built to isolated outDir
  ~/workspace/tmp-w3/webdist with VITE_GATEWAY_URL=http://localhost:8950
  (WEB_BUILD_EXIT=0; bundle contains the new 'Native chart in sheet'
  routing). LIVE: pending below.

## Validation — LIVE (isolated stack: gateway 8950, services 8951-8958,
## web preview 4185 from isolated outDir ~/workspace/tmp-w3/webdist,
## ICECREAM_DATA_DIR=~/workspace/tmp-w3/data; shared 8100 stack untouched;
## stack stopped after the runs)
- Tour script: hidden_files/wave-c-fixes/w3-live/tour-w3.mjs (adapted
  case-4 branch harness; adds a W3 assertion: no intent disambiguation
  for explicit chart prompts). Vertex live (probe 1.1-2.0 s per run).
- ROUTING PROVEN 5/5 live runs (run-b3, run-b4, run-b5, run-a, run-c):
  explicit native-chart prompts NEVER hit intent disambiguation
  (W3 assertion PASS in every result.json) — before the fix this was
  the main-run's first response. The 'Build an app' dead end is
  unreachable for explicit chart requests.
- END-TO-END CREATION PASS (run-c, prompt: 'Add a column chart of Month
  vs Revenue to the Sales sheet using the data in A1:C13.'):
  result.json 9/9 assertions PASS — chart overlay visible in grid
  (screenshot self-inspected: 'Month vs Revenue' column chart in the
  sheet, chat confirms 'bound to A1:C13'), revision 0->1 (chart.add),
  saved (storageRevision 1), reopen in 2nd context visible, download
  parse-back xl/charts/chart1.xml + drawing1.xml, series
  Sales!$C$2:$C$13 / cats Sales!$A$2:$A$13, valCache = all 12 fixture
  revenues EXACT. Evidence: w3-live/run-c/.
- HAND-BACK PROVEN LIVE: POST :8950/api/agent/artifacts/generate with
  'Add a column chart of Month vs Revenue to the Sales sheet.' returned
  200 {result:{routed:'not-artifact', reason:'This is a native-chart
  request... no app was built. Ask the chat for the chart instead...'}}
  — the gateway lane that previously built an app for this prompt.
- Web targeted suite: appGenerationPort.test.ts 3/3 PASS.

## Known remaining failure — NOT W3 routing (flagged for coordinator)
- The BARE prompts ('Add a column chart of Month vs Revenue to the
  Sales sheet.' and the totals main-run prompt) reach the runtime
  correctly now but the flash-lite PLANNER fails them deterministically
  on the current combined build (3/3 browser + 1/1 API for prompt B):
  audit (~/workspace/tmp-w3-diag2.log) shows plan 1 = create_chart with
  a GUESSED range A1:B13 (Month+Region, never read the headers) ->
  tool refuses 'no numeric data column'; planner asks the range
  question; after the A1:C13 answer the resumed segment PARROTS the
  failure text as its final message instead of retrying create_chart
  with the corrected range. Totals prompt: same shape (guessed A1:B3).
  Hypothesis (labeled, not proven): the planner-fix M2 change (tool
  results now preserved across asks) puts the failed create_chart in
  the resumed segment's context and the model anchors on it — the
  morning branch runs on the pre-M2 runtime (results discarded on
  resume) succeeded 2/2 with the same prompts. This is planner/
  ask-resume behavior in runtime.ts/openaiBackend.ts — the planner-fix
  + re-run successor programs' files; W3 did not touch them. The
  openaiBackend prompt already orders 'corrected retry BEFORE any ask';
  the model violates it after an answered ask.
- Verdict split: W3 routing + dead-end fix = PASS (unit + live above).
  Bare-prompt end-to-end on this planner build = FAIL, owned upstream
  (planner ask-resume), evidence attached. Honest FAIL stays FAIL for
  that leg — do not mark case 4 fully green on run-c alone.
