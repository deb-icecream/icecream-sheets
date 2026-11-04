# Wave C Fixes — Report

Coordinator started: 2026-10-22 (~05:30 PDT).
Brief: `hidden_files/wave-c-fixes/BRIEF.md` (user direction 2026-10-22 ~05:27 PDT).
Source evidence: `hidden_files/agent-rerun/REPORT.md` ("WAVE C VERDICTS" +
case-4 re-run findings) and its `cases/` evidence files.

Status legend: PENDING / DIAGNOSING / FIX LANDED / VALIDATING / PASS / FAIL.

## Stage log

- [x] Brief read; report skeleton created.
- [x] Recon (coordinator): FIX-R4 chart-sink retry located in
  `packages/gateway/src/services/agentSvc.ts` (~L204–269); intent-router
  options confirmed at `packages/service/src/agent/intentRouter.ts`
  (~L160–170: exactly 'Build an app' / 'Analyze & visualize' /
  'Just answer'); app-frame path = `apps/web/src/components/artifactFrame.ts`
  + `ArtifactHost.tsx`. Planner-fix program still iterating (verdicts
  PENDING, merged delta not in the real repo); re-run successor has Wave D
  harness staged, live runs waiting on the combined build. Workers briefed
  to coordinate (own isolated stacks, no shared-service restarts).
- [x] Workers dispatched 2026-10-22 ~05:3x PDT: W1, W2, W3, W4 (parallel;
  per-item notes in `w1-notes.md` … `w4-notes.md` in this folder).
- [x] W1 — first-turn sheet-context failure (root fix) — PASS
- [x] W2 — case 3b generated app: heading renders, body blank — PASS
- [x] W3 — intent-router dead end for native-chart requests — PASS
      (routing + dead-end fix; one upstream planner leg FAIL, flagged)
- [x] W4 — UI-built apps persist server-side per user+file — PASS
- [x] W5 — `#file=` join paint flakiness (verification first) — PASS
  via a join-path fix (NOT covered by D2 alone): the pre-fix series
  painted 1/4; root cause white-box-proven (the join's late
  `notifyHostReplaced` stomped the user's tab switch back to the
  near-empty first sheet) + a secondary breaker-lift disarm; final
  series on the fixed build 4/4. Full record in the W5 section.

---

## W1 — First-turn sheet-context failure (root fix)

Status: **PASS** (fix landed + fully validated 2026-10-22)

### Diagnosis
PROVEN (worker 0fbafaa4, ~05:40 PDT; full record in `w1-notes.md`).
Mechanism is at the AGENT HOST layer, not the resolver and not an engine
load race: `NodeRemoteEngineHost.sheetNames()`
(`packages/gateway/src/services/remoteEngineHost.ts`) is cache-only — on a
cold cache it returns `[]` while firing a background refresh. The MCP
`create_chart` (`packages/mcp-server/src/server.ts`) awaits that list, gets
`[]`, and returns `unknown sheet "Sales"` BEFORE the engine/chart sink is
reached — which is why the FIX-R4 sink retry never helped. Deterministic:
first create_chart per fresh runtime always fails; the background refresh
warms the cache, so turn 2 passes (3/3). Secondary: the cache is never
invalidated after warm (post-binding rename/add goes stale the same way).
Ruled out from evidence: resolver staleness (reads fresh per resolve),
runtime thread-creation snapshot (none exists).
NOTE: the first worker died in a daemon restart after checkpointing this
diagnosis; a successor was dispatched to land the fix (populate-on-cold +
one fresh re-check before declaring a sheet unknown) with the full
diagnosis in its brief.

### Fix
LANDED (successor worker, verified on disk by the coordinator):
`remoteEngineHost.ts` — new `sheetNamesAsync()`: an awaited, always-fresh
`GET /sheets`, deduped onto ONE in-flight request shared with
`refreshSheetNames()` (a sync `sheetNames()` warm-up joins the same
request; once no fetch is in flight the next call fetches fresh — covers
post-warm renames/adds). Sync `sheetNames()` contract unchanged.
`packages/mcp-server/src/server.ts` — `create_chart` awaits
`sheetNamesAsync()` as authoritative when the bound host exposes it,
else falls back to the sync list (surgical edit; planner-fix additions
in the same file untouched; the FIX-R4 sink retry untouched).

### Validation
PASS (coordinator-run after the successor also died in a restart; full
record in `w1-notes.md`):
- Regression tests pin both mechanisms, failing-before verified
  (gateway 4F/1P, mcp 2F/7P) → passing after: gateway
  `remoteHostSheetNames.test.ts` 5/5 (incl. host + real MCP create_chart
  composition — first failed on a STALE mcp dist, passed after rebuild;
  not a product gap), mcp `create-chart.test.ts` 9/9.
- Affected suites: gateway surface solo 7 files / 82 tests PASS
  (agentBinding, agentCharts, addonRunBinding, addonSvc, fileRegistry,
  phase2Collab, remoteHostSheetNames); tsc clean (gateway + mcp-server).
  MCP full suite green modulo 2 proven load flakes (Python-subprocess
  timeouts; both files pass solo). Full gateway suite not certifiable
  in one run on the current moving tree — observed failures all outside
  W1's surface (settings program's DELETE test, HITL shared-store
  interference, engineSvc run-to-run variance), recorded in w1-notes.md.
- LIVE 3/3: shipped bins in signed posture (isolated ports), per run a
  fresh file/session/NEW host + the real production chart sink: turn-1
  read_cells + turn-1 create_chart all OK (run 2 = chart first, the
  original failing order), zero 'unknown sheet'. Harness + logs:
  `~/workspace/tmp-wavec/w1-live/` (run2.log EXIT 0; run1.log = the
  harness's own one-session-at-a-time cascade, kept for provenance).

## W2 — Case 3b: generated app renders heading, body blank

Status: **PASS** (fix landed + validated 2026-10-22; worker 3b3f70bd,
full record in `w2-notes.md`; coordinator verified code + live evidence)

### Diagnosis
THREE broken hops, all proven (code-read + deterministic repro):
1. **`BINDING` is defined nowhere for LLM-generated apps.** The template
   generator prepends `var BINDING = {…};`; `LlmAppGenerator.generate`
   returns the raw model source with NO prelude, while its own prompt
   contract promises "A global BINDING = {…} is pre-defined" — and the
   frame host never injected it either, despite every ArtifactSpec
   carrying `spec.binding`. Evaluating the app's read args throws
   ReferenceError inside the async fetch → setData never runs → static
   heading renders, body blank. Exactly the observed symptom.
2. **Event-name mismatch:** generated apps subscribe `'cell_changed'`
   (singular); the MCP zod enum accepts only `'cells_changed'` →
   bridge-host validation fails and is swallowed → sheet→app live
   updates can never fire.
3. **Subscribe return shape:** the prelude returned a bare unsubscribe
   function; generated apps call `subscription.unsubscribe()` in effect
   cleanup → TypeError on unmount.
Sound hops (verified): MCP read_cells `{cells}` primitive-matrix shape,
gateway agent tools/call path, bridge principal stamping.
Repro BEFORE (real BRIDGE_PRELUDE in a vm, case-3b-shaped app):
`unhandledRejection: BINDING is not defined`, host log empty, 0/12 rows.

### Fix
LANDED at the frame-host layer (heals already-stored artifacts;
coordinator grep-verified):
- `apps/web/src/components/artifactFrame.ts` — `buildArtifactSrcDoc`
  gains the spec binding; the prelude defines `var BINDING = {…}` before
  the app source runs (template apps' inner `var` shadows with identical
  values). `mcp.subscribe` normalizes 'cell_changed'→'cells_changed' and
  returns an unsubscribe function that also carries `.unsubscribe`.
- `apps/web/src/components/ArtifactHost.tsx` — passes `spec.binding`
  into `buildArtifactSrcDoc`.
- `packages/service/src/artifacts/llm.ts` — prompt contract now names
  the exact event enum, the {cells} result shape, and the subscribe
  return contract (future generations).

### Validation
PASS:
- Repro AFTER: read_cells posted with exact binding args, subscribe
  accepted as ['cells_changed'], 12/12 fixture rows rendered, cleanup
  clean.
- Tests: web `artifactFrame.test.ts` 9/9 (5 new); service artifacts
  suites 61/61 (incl. new prompt-contract pins); gateway
  agentArtifacts 6/6. tsc clean (service + web).
- LIVE (isolated stack, own ports/data dir; case-3b-shaped LLM app):
  runs 1–4 failed on harness issues only (template-route seeding,
  runtime crashes). **Run 5's B1 was a FALSE POSITIVE** — its keyboard
  edit landed in A1, so "12777" appeared in the app's header text
  ("Month12777"); the worker caught it from the screenshot + engine
  read-back, preserved `run5-*` as caveated evidence, and re-proved
  cleanly in **run 6** (`w2-live/result.json`, PASS 4/4): panel opens
  from Apps tab; app renders 11/11 fixture values (12 data rows);
  engine op C2 12000→12777 verified by engine read-back BEFORE
  polling, then reflected in the app's DATA ROW; fixture restored
  (engine C2 = 12000). Screenshots `w2-live/app-initial.png` +
  `app-after-sheet-edit.png` PERSONALLY INSPECTED by the coordinator:
  heading + all 12 rows visible (not blank); after-edit shot shows
  header intact and first data row "Jan | North | 12777".
  App→sheet direction: the case-3b app is a read-only viewer — n/a
  per the brief's "where the app supports it".

## W3 — Intent-router dead end for native-chart requests

Status: **PASS for the routing + dead-end fix** (worker 37bc516b, full
record in `w3-notes.md`; coordinator verified code + live evidence).
One upstream planner leg FAIL — flagged below, NOT W3's files.

### Diagnosis
PROVEN from transcripts + code: web `AgentChat.send()` calls
`routePrompt()` before any runtime turn. The case-4 prompt scored
app 2 vs analysis 3 (confidence 0.43 < 0.45) → disambiguation offered
exactly 'Build an app' / 'Analyze & visualize' / 'Just answer' — no
native-chart option. Choosing 'Build an app' forced route 'app' →
gateway `/artifacts/generate` (template forced) → built an app Titled
with the chart prompt, replied "Built …", revision 0, no chart, no
hand-back. Not silence: a wrong-product "success" that terminates the
request. The native path itself (conversation route → planner →
create_chart) was sound 2/2 once reached.

### Fix
LANDED (intentRouter.ts primary; runtime.ts NOT touched; coordinator
grep-verified):
- New `chart` IntentKind/route. `hasExplicitNativeChartIntent()` (chart
  noun + sheet/workbook placement, mirroring the planner's own
  create_chart cues; explicit-app-object guard so "build an app with a
  chart in the sheet" stays app-lane) is checked FIRST at confidence 1 —
  explicit placement skips disambiguation entirely.
- Chart-mentioning ambiguous prompts now offer **'Native chart in
  sheet'** FIRST (question text names it too); non-chart prompts keep
  the original three options verbatim. `resolveDisambiguation` maps the
  new option to 'chart'.
- `dispatchIntent` 'chart' reuses the existing conversation port
  (runtime turn → planner → create_chart) — no parallel chart port.
- Dead-end closed at its layer: `generateAndSaveArtifact` hands back
  `{routed:'not-artifact', reason: NATIVE_CHART_HANDOFF}` for explicit
  chart prompts BEFORE routing and before forced-template generation —
  neither the disambiguation answer nor the gateway lane's unconditional
  template can silently build an app for a chart request again.
- AgentChat handles/forces 'chart'; indexes export the new symbols.

### Validation
PASS:
- tsc clean (service + web). intent-router 71/71 (new W3 block: exact
  case-4 prompt routes 'chart'; no-placement chart prompts stay
  analysis; every offered option resolves + dispatches to a real
  outcome); artifacts 31/31 (incl. forced-template hand-back); web
  appGenerationPort 3/3. Full service suite 1574/1579 — the 4 failures
  are outside W3 (2 load flakes passing isolated; 1 guardrails timeout
  under load; 1 agentThreadPersistence deterministic failure traced to
  the planner/grounding ask-budget text in runtime.ts:964 — pre-existing
  vs W3, their hot file, flagged in w3-notes).
- LIVE (isolated stack 8950–8958 + web 4185, own data dir; shared 8100
  untouched): routing proven 5/5 — explicit chart prompts never hit
  disambiguation. Run-c ("…using the data in A1:C13") PASS 9/9 —
  `w3-live/run-c/result.json`: chart overlay in grid, revision 0→1,
  saved, visible on reopen in a second context, parse-back
  `xl/charts/chart1.xml` with all 12 fixture revenues exact. Screenshot
  `w3-live/run-c/chart-in-grid.png` PERSONALLY INSPECTED by the
  coordinator: native column chart "Month vs Revenue" in the grid, no
  disambiguation shown. Hand-back proven live: POST /artifacts/generate
  with a chart prompt returns `routed:'not-artifact'` + reason.
- **FLAGGED RESIDUAL (upstream, planner program's files):** the BARE
  prompt (no explicit range) now routes correctly but the flash-lite
  planner fails it deterministically on the current combined build
  (3/3): guesses A1:B13 without reading headers → create_chart refuses →
  asks → resumed segment parrots the failure instead of retrying
  (plausibly an M2 interaction: failed result now preserved across
  asks). This is planner ask-resume behavior in runtime/openaiBackend —
  case 4 must NOT be marked fully green on run-c alone. Owner:
  planner-fix coordinator / re-run successor.

## W4 — UI-built apps persist only in one browser's localStorage

Status: **PASS** (fix landed + validated 2026-10-22; worker c86c05aa,
full record in `w4-notes.md`; coordinator verified code + live evidence)

### Diagnosis
PROVEN: builder apps lived in a module-level localStorage store
(`App.tsx` `appStore = createAppStore(appPersistence)`, key
`icecream-sheets.apps.v1`); `AppSpec` had no file/user binding at all.
Generated apps are a different shape (ArtifactSpec) whose server
persistence is only the agent service's generation-time file store +
the share store — no per-user+file CRUD existed for either shape, so
one was built for AppSpec following the shareStore/userStore patterns
rather than forcing AppSpecs into the artifact store.

### Fix
LANDED (coordinator grep-verified):
- Service: `AppSpec.fileId?: string` (spec.ts:147); `migrateAppSpec`
  preserves it.
- Gateway (new): `packages/gateway/src/deploy/builtAppStore.ts` —
  keyed `(ownerPrincipal, fileId, appId)`; Memory/Local (JSON+lock)/
  Firestore adapters, prod factory fails closed; routes
  `GET/POST /api/built-apps`, `PUT/DELETE /api/built-apps/:appId`
  (owner from verified claims only; store unavailable → 503 fail
  closed); `DELETE /api/account` also purges built apps.
- Web (new): `product/builtAppsApi.ts` + pure `product/builtAppSync.ts`
  (server authoritative, dedupe by id). App.tsx: create stamps fileId
  + POSTs; spec changes PUT; an open-file sync effect merges the server
  list into the local cache (localStorage demoted to cache).
  Local/desktop untouched (no gateway client → no server calls).
- Live-tour bug found + fixed in the worker's own code: the sync
  effect's cleanup cancelled in-flight merges while the dedupe key
  stayed consumed (GET landed, commit never did) — key now stays
  consumed only on completion.

### Migration
IMPLEMENTED + live-proven: legacy pre-W4 records carry no fileId, so
their owning file is unprovable from the record; they upload on open
of a file whose workbook contains their bound sheet name, stamped with
that file (disclosed heuristic, deduped by id). Residual risk stated
plainly: a legacy app whose sheet name also exists in an unrelated
file opened first would bind there — accepted, since the record
carries no stronger signal.

### Validation
PASS:
- LIVE browser tour 8/8 (`w4-live/result.json`, isolated stack
  18100/14173, own data dir + own web dist; shared 8100 untouched):
  profile A built "W4 Sales App" via the UI; API read-back shows the
  record keyed user+file; NO leakage to another file id or another
  user; fresh profile B lists it in My Apps and the runner renders all
  12 fixture rows; seeded legacy app migrated on open in profile C and
  listed in a second fresh profile B2. Screenshots
  `w4-live/b2-runner-open.png` + `b3-my-apps-after-migration.png`
  PERSONALLY INSPECTED by the coordinator: fresh-profile runner shows
  the full Month/Region/Revenue table (12 rows); My Apps menu lists
  both "W4 Sales App" and "Legacy Stranded App".
- Suites: gateway builtApps 8/8; web product 90/90 (incl. builtAppsApi
  8/8); service appbuilder/metadata 60/60. Full gateway 376/379 — the
  3 failures proven NOT W4 (account-tier test fails identically with
  the W4 block removed — same failure the coordinator observed during
  W1; servicePackage = triggers program's new "automation" service vs
  a stale expectation; HITL = shared agent ask-store pollution).
- tsc: service + gateway clean; web 6 errors all pre-existing from
  concurrent programs, zero in W4 files.
- HONEST GAP (pre-existing, flagged not silently fixed): no delete-app
  UI affordance exists for builder apps. Server DELETE + client method
  + account-deletion purge are implemented and tested, but no UI
  surface calls delete yet — wiring one is a product decision.

## W5 — `#file=` join paint flakiness (verification first)

Status: **PASS — closed by a join-path fix, NOT by D2 alone**
(2026-10-22; final series 4/4 on the fixed build, below)
GATE STATE (final): File-2 verdicts landed — D1 FIXED + PROVEN; **D2
FIXED at the client mechanism level + unit-proven** (discriminating
regression tests; web suite 1,948/1,948), but its **live browser
verdict stayed OPEN**: five attempts at the fixed-bundle join tour
were defeated by infrastructure (engine processes dying under VM
memory pressure with several programs' tours running), with a
one-command re-run staged. So the D2 fix has landed as the brief
requires, and the 4× live join re-run below is the missing live
evidence — W5 closes only on 4/4 painted joins.

### Verification runs
Harness: `~/workspace/tmp-wavec/w5/` (start_stack.py + join-tour.mjs);
isolated stack ports **18910 (gateway) / 18911 (engine) / 18912 (web)**
(per the disjoint-port-block rule), fresh data dir per run, web dist
built fresh from the current tree (contains `scheduleLiftNotify` —
the D2 fix IS in the bundle). Scenario per run: owner uploads the
File-2 fixture and opens it (session live); a second client (same
user, fresh browser context) cold-loads `/#file=<id>`, switches to
'Dropdown Lists' the moment tabs render, then parks 90 s sampling
painted cells; ground truth = owner's count on the same sheet (418).
Evidence per run: `w5-live/runN/result.json` + screenshots.

- **Run 1: FAIL (genuine reproduction on the fixed build).** Joiner:
  tabs at 3.1 s, switch registered, parked 90 s — painted **0** cells
  at every sample vs owner ground truth 418 (threshold 334). Reads:
  3 in the first ~40 s (1× 200, 2 err — the D2 window), jumping to 25
  (23× 200) at ~+50 s — the breaker-lift re-fetch visibly fired — yet
  the grid never painted. Screenshot `w5-live/run1/joiner-parked.png`
  (coordinator-inspected): full ribbon, tab strip rendered, grid
  completely empty, status "✓ Saved". So the D2 fix un-sticks the
  READS but, in the join path, the re-fetched data still never
  reaches the render. NOT covered-by-D2 as it stands.
- Harness corrections on the way (recorded so the FAIL above is not
  confused with them): (a) the fixture's first sheet 'icons' holds
  ~0 text cells (one picture) — the owner gate now keys on content
  presence, not a cell count; (b) a different-user joiner correctly
  gets POST /api/engine/open 404 (no share — access control working,
  not a defect); the canonical join is same-user second client, as in
  Wave C and File-2's reval-d2.
- Diagnosis of the residual join-path defect: IN PROGRESS (need
  per-sheet read payloads + active-tab state + post-settle switch
  behavior to localize: lost switch vs dropped re-fetch vs poisoned
  cache).
- **Diag2 (join a SETTLED session, same instrumented shape): PASS** —
  switch painted 418/418 at the first 5 s sample; Example 221; back
  418. (`w5-live/diag1/result2.json`)
- **Diag3 (join during a "Saving…" window, ~70 s after owner-live):
  PASS** — painted 418 at sample 1; trace shows the healthy pattern:
  direct-to-engine reads, two window 404s on an internal sheet's
  ranges (recovered), DL full read = 2,178,578 B ×2 at 200.
  (`w5-live/diag3/result.json`)
- **Race1 (join DURING the owner's initial hydration): open stalled
  ~98 s** between access-grant and first read (state stream queued
  behind the owner's load on this oversubscribed host); tabs not
  rendered within the 120 s cutoff — a slowness observation, not a
  paint verdict.
- **Race2 (join ~0 s after owner-live, window active): PASS** —
  painted 418 at sample 1, DL reads 3/3 OK incl. the 2.18 MB read;
  probes healthy. (`w5-live/race2/result.json`)
- Standing puzzle: run 1's FAIL is so far UNREPRODUCED (3 PASS in
  near-identical shapes). One systematic difference: run 1's joiner
  used the plain `/#file=` URL form; every PASS used
  `/index.html#file=`. Next: canonical series with the payload
  instrumentation merged into join-tour.mjs, run in run 1's exact
  form — if the FAIL recurs, the trace localizes it; the brief's
  4/4 bar applies to the series either way.
- **Canonical series (instrumented join-tour, fresh stack+data per
  run): run2 PASS, run3 FAIL, run4 FAIL.** Series total with run1:
  **1/4 painted** — W5 does NOT close as covered-by-D2. Decisive
  probe in both FAILs: after the 90 s park at 0, switching to
  'Example' and back to 'Dropdown Lists' painted 418 immediately —
  client, session and data path are all healthy; only the FIRST
  paint of the window-switched sheet is lost.
- **Mechanism localized by the read traces** (`w5-live/run{2,3,4}/
  result.json`): in both FAILs the DL used-range (200, real range)
  and DL first-block range read (200, 28,468 B — the exact read that
  paints in the PASS) completed DURING the park, inside the same
  burst as the initial sheet's load + the all-sheets used-range warm.
  In the PASS the DL read completed ~2 s AFTER the initial sheet's
  load burst finished. So: the switched-to sheet's data ARRIVES but
  the render never commits when the read completes while the initial
  load sequence is still in flight. Not a fetch failure, not the
  breaker, not a null used-range. Fix locus: web client join/open
  render path (RemoteView completion → notify → render), the join
  path per the brief. Code diagnosis in progress by the coordinator.
- **Diag5 (FAIL with revival probes armed; diag6 PASS):** at the
  blank park the grid holds 600 rendered cell elements (all empty);
  scrolling (memo-dep change) and cell-clicking revive NOTHING and
  queue NO reads; only a tab switch revives (Example 221, back 418).
- **Root cause PINNED (code-level, `apps/web/src/services/
  remoteEngine.ts`):** the D2 recovery is a one-shot lift timer armed
  by `noteFetchFailed()` — but `noteFetchOk()` clears that timer
  WITHOUT firing its notify. In a join burst (~25 concurrent reads),
  the interleaving (window 404 arms breaker+timer → a render's
  re-queue is gated, or a session 'load' event's clearCache wipes the
  just-seeded block → an unrelated in-flight fetch then SUCCEEDS)
  makes `noteFetchOk` silently disarm the only pending re-render.
  Breaker ends OPEN, cache empty/stale for the active sheet, and no
  event ever fires again — the sheet stays blank until a tab switch
  forces a fresh activation read. Intermittency = the ordering race.
  Fix: a pending lift must convert to a fired notify when a success
  proves reads flow again (notify is an idempotent re-render).
  Unit-test-first, then the browser series re-run on the fixed build.
- **FIX LANDED + UNIT-PROVEN (coordinator, 2026-10-22):** new
  regression test in `apps/web/src/services/remoteEngine.test.ts`
  ("Wave-C W5: breaker-lift must survive an interleaved success") —
  an in-flight used-range fetch succeeding after a range read failed
  must still produce the lift notification. FAILS on the pre-fix code
  (notifications frozen at the settle count), PASSES after the fix:
  `noteFetchOk()` now fires `opts.notify()` when it consumes a
  pending lift timer instead of clearing it silently (idempotent
  repaint tick; the no-further-fetch case still rides the timer).
  remoteEngine + bulkReads suites 25/25 (both D2 tests green).
  Browser series on the rebuilt dist: PENDING (below).
- **Fixed-build browser series: 3/4 (run5 PASS, run6 FAIL, run7
  PASS, run8 PASS)** — the lift-disarm fix cut the failure rate
  (pre-fix series was 1/4) but a SECOND interleaving survives.
  Run6's trace exonerates the breaker for that instance: its only
  failures were ~26 s BEFORE an all-success burst; the DL block
  (200, 28,468 B) seeded at ~67 s and still never painted in 60+ s;
  probes revived as before. The burst also shows TRIPLICATED icons
  reads (repeated clears or multiple consumers). Next: white-box
  diagnostic build (flag-gated logging of seed/clear/emit/session
  events/Grid memo values) to catch the failing park red-handed.
- **ROOT CAUSE PROVEN (diag9, white-box log `w5-live/diag9/
  result.json` w5log):** the join-paint failure is NOT a data-path
  defect at all. Timeline (page clock): 21.1 s Grid renders
  'Dropdown Lists' (user's switch; empty, data in flight) → 21.6 s
  D2 lift re-render (still empty) → **41.1 s Grid is rendering
  'icons' again — with NO host event in between** → 41.09 s DL's
  block seeds (600 cells) and every subsequent emit renders ICONS.
  DL's data sat in the cache for the whole park; the user was
  looking at the near-empty first sheet. The stomper: App.tsx's
  `onHostReplaced` handler unconditionally `setSheet(names[0])`,
  and the join-by-link flow calls `notifyHostReplaced()` AFTER
  `await remote.snapshotAsync()` (~20 s on a loaded host) — long
  after `transport.connect()` made tabs live and switchable. The
  race: tab switch vs the join's late host replacement. (The
  triplicated icons reads = repeated warm consumers on the
  reverted sheet; the lift-disarm interleaving fixed earlier is a
  real but secondary contributor — pre-fix 1/4 → post-fix 3/4.)
  FIX (at the proven layer): the handler now preserves the current
  sheet when it exists in the new host's names — a host replacement
  is a transport rebind, not a new workbook; a genuinely new
  workbook without that sheet still lands on sheet 1.

### Fixes landed for W5 (coordinator, in the join path per the brief)
1. **`apps/web/src/App.tsx` — `onHostReplaced` handler (the root
   cause):** no longer resets the active sheet unconditionally; it
   preserves the current sheet when the new host's names contain it
   (`setSheet(prev => names.includes(prev) ? prev : names[0] ?? 'Sheet1')`).
   A transport rebind during join is not a new workbook; a genuine
   new-file open without the sheet still lands on sheet 1.
2. **`apps/web/src/services/remoteEngine.ts` — `noteFetchOk` (the
   secondary contributor):** a pending breaker-lift now fires its
   notify when a success consumes it, instead of being silently
   disarmed. Regression test added in `remoteEngine.test.ts`
   ("Wave-C W5: breaker-lift must survive an interleaved success" —
   fails pre-fix, passes post-fix).
   (The temporary white-box diagnostics used to catch diag9 were
   fully removed afterwards — zero `w5diag` references in the tree.)

### Final validation
- Web tsc clean; **full web suite 150 files / 1,928 tests ALL PASS**
  (both fixes in, diagnostics out).
- **Final browser series on the fixed build: 4/4 PASS** — runs 9–12
  (`w5-live/run{9,10,11,12}/result.json`), each a fresh stack + fresh
  data dir + fresh file: joiner via `#file=`, immediate switch to
  'Dropdown Lists', parked — painted **418/418** every time (owner
  ground truth 418; threshold 334). Run12 screenshot
  `w5-live/run12/joiner-parked.png` PERSONALLY INSPECTED by the
  coordinator: grid fully painted with the sheet's real data, both
  clients present, mid-"Saving…" — the exact shape that failed
  pre-fix. Failure-rate arc on this scenario: pre-fix 1/4 painted →
  after the lift fix alone 3/4 → after both fixes 4/4.
- Honest residuals from the hunt (not W5 defects): race1's ~98 s
  join stall during the owner's initial hydration is engine-load
  slowness on an oversubscribed host (open completes; worth a perf
  look someday, not a paint defect); the handler still resets the
  in-sheet selection to A1 on host replacement (pre-existing,
  cosmetic next to the sheet stomp).

### Verdict
**PASS.** W5 does NOT close as "covered by the D2 fix" — the brief's
second branch applied: the join scenario still failed on the
D2-fixed build, the join path was diagnosed from evidence (two
mechanisms, the decisive one white-box-proven in diag9), fixed at
the proven layers, and re-proven 4/4. D2's fix remains necessary
context (it un-sticks gated reads) but was not sufficient.
