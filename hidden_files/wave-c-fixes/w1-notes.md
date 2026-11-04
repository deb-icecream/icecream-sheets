# W1 — First-turn sheet-context failure (root fix) — worker notes

Owner: W1 fix worker (session 0fbafaa4). Coordinator owns REPORT.md — do not touch it.
Started: 2026-10-22 ~05:32 PDT

## Diagnosis
- (pending — reading BRIEF + agent-rerun REPORT + transcripts)

## Fix
- (pending)

## Validation
- (pending)

## Coordination / waits
- (pending — must read planner-fix REPORT + agent-rerun REPORT checkpoints, check mtimes before editing shared files; never restart shared stack on 8105/gateway; live validation on isolated ports only)

## Diagnosis — PROVEN (2026-10-22 ~05:40 PDT, code + evidence)

Mechanism = candidate (a) variant at the AGENT HOST layer, NOT the resolver and
NOT an engine load race:

1. `packages/gateway/src/services/remoteEngineHost.ts` — `NodeRemoteEngineHost`
   (the host agentSvc binds to the user's engine session, agentSvc.ts
   runtimeFor) overrides the sync `sheetNames()` as CACHE-ONLY:
   `if (this.sheetNameCache) return [...]; void this.refreshSheetNames(); return [];`
   The cache starts null on every fresh runtime and is populated ONLY by
   `refreshSheetNames()` (fire-and-forget background), `snapshotAsync()`,
   or a `/sheets` fetch completing. Reads (`/read`) never populate it.
2. `packages/mcp-server/src/server.ts` create_chart (only sheetNames consumer
   in the MCP tool set): `const sheetNames = await engine.sheetNames();`
   Awaiting a sync `[]` is still `[]` → FIRST create_chart on any fresh
   runtime returns `unknown sheet "<name>"` for a sheet the session provably
   holds. The background refresh that same call kicked off warms the cache,
   so the identical call seconds later (turn 2) passes — deterministic, not
   a timing race: first call per fresh runtime always fails.
3. Evidence pin: planner-diag audit (results-prefix.json) captured text is
   `create_chart failed: unknown sheet \"Sales\"` — the MCP-layer format
   (quotes). Engine formats differ (`unknown sheet: Sales` from /charts,
   `Unknown sheet: index` from /read), so the failure happened BEFORE the
   chart sink — the FIX-R4 sink retry (agentSvc) can never see it, which is
   why 3/3 first-turn failures persisted after FIX-R4. In that same audit,
   analyze_data with an explicit sheet does NOT populate the cache
   (analysisSheetName returns the explicit name without snapshot()).
4. Ruled out: (b) resolver staleness — agentSessionResolver reads the
   registry fresh per resolve, no cache; pre-chat read-backs through the
   same binding succeeded. (c) runtime snapshot at thread creation — the
   runtime snapshots nothing sheet-related; threads.ts untouched by the
   path. Engine-load gate (W20) covers /read only, but /read succeeding
   pre-chat while create_chart failed in the same window contradicts a
   pure load race for THIS evidence; the cold-cache mechanism is
   deterministic and matches turn-1-fail/turn-2-pass 3/3.
5. Also noted: cache is never invalidated/refreshed after warm, so a
   grid-side rename/add after binding would go stale the same way. Fix
   must fetch fresh at the sheet-validation point, not just warm once.

Coordination check at start: runtime.ts mtime 12:32 UTC (re-run successor
grounding gate ACTIVE — do not touch runtime.ts); mcp-server server.ts
mtime 12:19 UTC (planner-fix far-write guard landed there — edit
surgically, re-check mtime first); engineSvc.ts 12:24 UTC (other worker —
avoid); remoteEngineHost.ts untouched since 00:03 UTC (safe, primary layer);
agentSvc.ts 11:30 UTC (keep FIX-R4 retry untouched; no edit planned).

## SUCCESSOR RESUME (2026-10-22 ~05:48 PDT, session 41616b46)
- Successor worker resumed W1 from predecessor diagnosis above (PROVEN section). Diagnosis accepted: NodeRemoteEngineHost.sheetNames() cache-only, cold cache returns [] while background refresh fires; create_chart in mcp-server awaits that sync [] -> first-turn unknown sheet; cache never invalidated after warm -> stale rename/add.
- Plan: (1) refresh mtime survey, (2) verify code in remoteEngineHost.ts + all sheetNames consumers, (3) fix at host layer: cold cache -> await /sheets fetch before answering; absent requested sheet -> one fresh fetch + re-check before unknown. Keep sync contract if sync callers exist. (4) Regression tests both mechanisms (fail before, pass after). (5) Suites gateway + mcp-server + tsc. (6) Live isolated-stack: fresh session turn-1 read + create_chart 3/3, zero unknown sheet.
- Constraints: do NOT touch progress.md, REPORT.md, runtime.ts, agentSvc.ts FIX-R4 retry. Edit mcp-server/server.ts surgically (planner-fix work there). Do NOT git push. Live on isolated ports only, never restart shared 8105/8100.

## Successor checkpoint 1 — tests already landed by predecessor (2026-10-22 ~05:52 PDT)
- Mtime survey refreshed: remoteEngineHost.ts 00:03 UTC, mcp server.ts 12:19 UTC, runtime.ts 12:32 UTC, agentSvc.ts 11:30 UTC — all unchanged from predecessor survey. No edit conflicts.
- Code verified: remoteEngineHost.ts:446-450 cache-only sheetNames() exactly as diagnosed. Consumers: engineSvc.ts state.host is the engine service's OWN local host (not NodeRemote) — unaffected. ONLY async consumer of the remote host's sheet list is mcp-server create_chart (server.ts:526).
- FOUND: predecessor landed regression tests just before dying (mtimes 12:42/12:43 UTC, untracked): packages/gateway/tests/remoteHostSheetNames.test.ts (host: sheetNamesAsync first-call/single-fetch/warm-cache, rename-after-warm fresh, concurrent dedupe to 1 request; composition: turn-1 create_chart succeeds, genuinely-unknown refused) and the W1 describe block in packages/mcp-server/tests/create-chart.test.ts (create_chart MUST prefer sheetNamesAsync; async list authoritative — stale sync name refused; unknown still refused).
- Design (matches tests + brief): host adds sheetNamesAsync() = awaited FRESH /sheets fetch, deduped via a shared in-flight promise also used by refreshSheetNames() (so the background warm-up kicked off by a sync sheetNames() call joins the same single request); sync sheetNames() contract unchanged. create_chart: when the bound host exposes sheetNamesAsync, await it and treat it as authoritative; otherwise fall back to the sync list.

## Successor checkpoint 2 — FIX LANDED (2026-10-22 ~05:55 PDT)
- Failing-before (successor-verified): gateway remoteHostSheetNames.test.ts 4 failed / 1 passed; mcp-server create-chart.test.ts 2 failed / 7 passed.
- remoteEngineHost.ts: added `sheetNamesFetch` in-flight field; refreshSheetNames() now dedupes concurrent callers onto ONE GET /sheets and clears in-flight on settle; new sheetNamesAsync() = awaited fresh fetch via refreshSheetNames() (fresh every call once no fetch is in flight — covers post-warm rename/add; joins the background warm-up a sync sheetNames() kicked off — exactly 1 request). Sync sheetNames() contract unchanged. Verified on disk (grep: lines 171, 467-483).
- mcp-server/src/server.ts create_chart ONLY (surgical, mtime re-checked 12:19 UTC immediately before edit): when the bound host exposes sheetNamesAsync, await it and treat it as authoritative; else fall back to sync sheetNames(). Planner-fix additions untouched; agentSvc.ts FIX-R4 retry untouched; runtime.ts untouched.
- Next: run both regression files (expect all pass), then full gateway + mcp-server suites + tsc, then live isolated-stack proof.

## Coordinator validation (parent coordinator, 2026-10-22 ~06:05 PDT)
- Successor (41616b46) died in a daemon restart AFTER landing the fix; the
  coordinator ran the remaining validation directly.
- mcp-server tests/create-chart.test.ts: 9/9 PASS (incl. the W1 cold-cache
  first-call test).
- Gateway tests/remoteHostSheetNames.test.ts initially 4/5: the composition
  test failed because @icecream-sheets/mcp-server resolves to dist/, and
  dist (built 12:39 UTC for the planner-fix program) predated the W1 src
  edit (12:52 UTC) — the composition ran the STALE create_chart. Not a
  product gap. After `npm run build` in packages/mcp-server (dist 13:03
  UTC): gateway file 5/5 PASS — fresh host + real MCP create_chart as the
  FIRST tool call succeeds, sink captured sheet 'Sales'.
- Remaining when this was written: full gateway + mcp-server suites + tsc
  (running), then the live 3/3 proof.

## Coordinator validation — suites (2026-10-22 ~06:30 PDT)
- Gateway tsc: EXIT 0. MCP tsc: EXIT 0.
- MCP full suite (run 2, completed): 15 files — 150 passed, 1 skipped,
  2 FAILED, both Python-sandbox environment timeouts, neither in W1's
  surface: sandbox-py "lets pandas past the import hook" (python venv
  creation spawnSync ETIMEDOUT at 120 s) and server.test "execute_code
  runs python" (ok=false at 6 s). Solo re-run of both files launched to
  test the load hypothesis (log: ~/workspace/tmp-wavec/w1-mcp-solo.log).
- Gateway full suite: killed by daemon restarts twice mid-run (moving
  tree + ~8 concurrent programs). Failures seen before the kills, NONE
  in W1's surface: engineSvc P75-fixture load test = 30 s test timeout
  under load; userSettings DELETE /api/account test = the SETTINGS
  program's own in-flight feature (their test, their mid-build tree);
  services HITL test = pending-count mismatch + hook timeout (shared
  pending-ask store interference is documented in this environment).
  Solo re-run of those 3 files queued after the MCP solo run.
- Targeted W1 evidence stands: gateway remoteHostSheetNames 5/5,
  mcp create-chart 9/9 (after the mcp dist rebuild).

## Coordinator validation — COMPLETE (unit level) (2026-10-22 ~06:45 PDT)
- Affected gateway surface solo: 7 files / 82 tests PASS, EXIT 0
  (remoteHostSheetNames, agentBinding, agentCharts, addonRunBinding,
  addonSvc, fileRegistry, phase2Collab).
- MCP suite disposition: GREEN — 150 passed in-suite; the only 2 failing
  files pass solo (server.test 13/13, execute_code python 457 ms solo vs
  6068 ms under load; sandbox-py 16 pass + 1 skip solo, 54 s vs 290 s).
  Both in-suite failures were Python-subprocess timeouts under load.
- tsc clean: gateway + mcp-server.
- Full gateway suite CAVEAT (recorded honestly): not certifiable in one
  run right now — the tree is edited concurrently by ~6 programs and the
  suite exceeds the daemon-restart window. Failures observed across runs,
  NONE in W1's surface: userSettings DELETE /api/account (the settings
  program's own in-flight feature test, fails consistently — theirs to
  fix); services HITL (shared pending-ask store interference from other
  programs' live stacks); engineSvc D4/E1 download tests (passed in one
  run, failed in another — moving tree). W1's affected surface (above)
  is the honest green claim.
- REMAINING: live proof (fresh session, turn-1 read + turn-1 create_chart,
  3/3). The tool-layer shape is already proven against a fake engine
  (composition test) and in-process (mcp tests); the real-HTTP run +
  the re-run successor's combined-build case-4 re-run (3 fresh sessions,
  the original failing scenario) close it.

## LIVE PROOF — PASS 3/3 (coordinator-run, 2026-10-22 ~07:00 PDT)
Harness: ~/workspace/tmp-wavec/w1-live/harness.mjs (log run2.log, EXIT 0).
Boots the shipped gateway+engine bins (dists rebuilt with the W1 fix) in
signed posture on isolated ports 19951/19952. Per run: fresh file ->
/api/engine/open (signed token) -> engine /load of the Sales fixture ->
NEW NodeRemoteEngineHost (cold sheet-name cache) + REAL createAgentChartSink
+ REAL MCP createServer -> read_cells and create_chart as the runtime's
first tool calls; session released before the next run (the engine hosts
one live session at a time — the first harness attempt's runs 2/3 failed
on exactly that 409 cascade, a harness bug, kept in run1.log).
- Run 1: read OK (values returned), chart OK (chartId, revision 1).
- Run 2: chart FIRST (the original failing order) OK, read OK.
- Run 3: read OK, chart OK.
Zero 'unknown sheet' in any run. W1 VALIDATION COMPLETE.
