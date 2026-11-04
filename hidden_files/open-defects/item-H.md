# Item H — investigation evidence

## FINAL VERDICTS
- **Observation 1 (/read 500 x4 per load): FIXED.** Real defect, not a
  harness artifact. Root cause + fix + evidence below.
- **Observation 2 (Download dialog 'No defined names' on names-rich
  files): FIXED.** Real defect, not a harness artifact. Root cause +
  fix + evidence below.
- Both browser-validated end-to-end post-fix on BOTH audit files
  (perf-p75: 0x /read 500, dialog lists 28 names; drawing file: 0x
  /read 500, dialog lists 506 names).

Worker started fresh 2026-10-21 ~21:33 PDT (predecessor killed by daemon restart, no file).

## RESUME 2026-10-21 ~23:28 PDT (resume worker 067bbe6b; parent task + coordinator verified state)
Predecessor's checkpoint (above) says the obs-1 regression tests were
ALREADY written and v2 (404 for non-pended unknown-sheet) was the final
contract. Coordinator's verified state says the fix symbols are present
(waitForLoadBuild pended flag, 409 for pended-absent-sheet reads,
[engine] log lines) but its test brief parenthetical says "non-pended
unknown-sheet still 500s, W20 contract preserved" — that CONTRADICTS the
code on disk (v2: non-pended absent-sheet cell/range reads → 404
`Unknown sheet: X`, never 500; explicit design reasoning in the /read
comment block, engineSvc.ts:4615-4640). A 500-expecting test would FAIL
against current code. Resolution: the code + in-code design comment +
test-file header + item-H.md history are all self-consistent on v2 as
the final contract; I will run the tests as written (they pin the real
behavior) and flag the brief-vs-code mismatch to the parent rather
than re-cutting the contract or writing a failing test.
Code verified present on current tree:
- waitForLoadBuild(): Promise<boolean> (pended flag) — engineSvc.ts:1956
- /read 409 path: pended + absent sheet → 409 'read superseded by a
  workbook load...' + `[engine] /read superseded by workbook load`
  log — engineSvc.ts:4639-4652
- /read 404 path: non-pended + absent sheet → 404 `Unknown sheet: X`
  — engineSvc.ts:4653
- outer catch logs `[engine] request failed ${method} ${path}: ${msg}`
  before sendError 500 — engineSvc.ts:~5457
- Test file packages/gateway/tests/engineSvcReadDuringBuild.test.ts
  already contains the 3 Item H tests (superseded-409 ×4 + control +
  post-build 404; 500-logging via console.log capture; W20 no-build
  test revised 500→404 with reason in header + test). It is UNTRACKED
  (??) — predecessor wrote it; needs the run now.
- App.tsx obs-2 wiring INTACT: hydrateOpenedWorkbook calls
  nameServices.importFromDefinedNames(data.definedNames, ...) at
  App.tsx:5847 (was 8695; drifted under sibling edits), comment block
  5828-5845. Obs-2 test files untracked and present:
  apps/web/src/features/nameServices.test.ts,
  apps/web/src/components/DownloadDialog.test.tsx.
- /tmp: 483M free (no TMPDIR override needed).

## Obs-1 regression run (resume worker, 2026-10-21 ~23:32 PDT)
`vitest run tests/engineSvcReadDuringBuild.test.ts` (packages/gateway):
**7/7 PASSED, 53.41s** — log hidden_files/open-defects/logs-itemh-w20-resume.log.
Pinning verified: 4 superseded reads → 409 (never 500, never served;
`[engine] /read superseded by workbook load` logged ×4); control read
served from NEW workbook with correct values; 500 path logs
`[engine] request failed POST /read: ...` (also visible live in the
failed-build tests); post-build/no-build unknown-sheet reads → 404
`Unknown sheet: X` (never 500). The 4 W20 tests still pin the
pend-then-serve-new-values contract.

## Obs-2 regression re-run (resume worker, 2026-10-21 ~23:36 PDT)
`vitest run src/features/nameServices.test.ts src/components/DownloadDialog.test.tsx`
(apps/web): **6/6 PASSED, 54.98s** — log
hidden_files/open-defects/logs-itemh-web-resume.log. App.tsx's
hydrateOpenedWorkbook → nameServices.importFromDefinedNames wiring
re-verified intact at App.tsx:5847 (anchor drifted from 8695 under
sibling edits; call + comment block unchanged).

## FINAL VERDICTS (resume worker)
- OBS-1 (/read 500 ×4): FIXED at the service contract level and pinned
  by regression tests (7/7 green on current tree). Note for the parent:
  the on-disk contract is v2 — pended+absent-sheet → 409, non-pended
  absent-sheet → 404 — which CONTRADICTS the task brief's parenthetical
  ("non-pended unknown-sheet still 500s, W20 contract preserved"). The
  404 is deliberate, documented in-code (engineSvc.ts:4615-4640) and in
  the test header, and motivated by the browser re-validation (the
  socket-queue window still produced 500s under v1). I did NOT change
  the code contract; if the parent wants 500 preserved for the
  non-pended case, that is a design decision requiring a code + test
  change beyond "add tests".
- OBS-2 (Download dialog "No defined names"): FIXED (wiring intact) and
  pinned by regression tests (6/6 green on current tree, third run
  overall).
- Constraints honored: no progress.md edits, no git push, no App.tsx
  routing/shell changes, no MCP/residual-(p) touches.

## Sources read
- hidden_files/roundtrip-audit/BRIEF.md; probe/diag9-netlog.txt (only preserved netlog);
  diag9.mjs (loads test-data/perf-fixtures/perf-p75.xlsx via drop, fresh stack, signed engine 127.0.0.1:18301)
- p75-orig.json: perf-p75 has 40 defined names; draw-orig.json: drawing file has 512.

## Observation 2 — Download dialog "No defined names" — code-level root cause FOUND
- Dialog: apps/web/src/components/DownloadDialog.tsx:100 prints
  'No defined names in this workbook yet (Formulas > Define Name…).' iff names.length===0.
- Its ONLY source in App.tsx:8695-8710: `nameServices.services.ranges.list()` (service NamedRangeStore).
- That store is populated on open NOWHERE: `useNameServices.importFromDefinedNames`
  (features/useNameServices.ts:45) has ZERO callers in apps/web/src (grep-verified);
  features/nameServices.ts:189 importDefinedNames likewise unused by App.
- Precedent in-code (App.tsx buildDownloadBytes, ~6720): comment states verbatim
  "the store is never populated on open, so every save wrote ZERO defined names"
  (defect E1) — E1 was fixed for SAVE by merging host.snapshot().definedNames as
  primary, but the Download dialog (and its confirm handler) were left reading
  the store alone.
- Netlog evidence (diag9): dialog text captured verbatim with perf-p75 (40 names).
- Status: REPRODUCED in browser (see Obs1 repro run: dialog text captured
  verbatim 'No defined names in this workbook yet' for perf-p75).

## Observation 2 — FIX (applied)
- App.tsx hydrateOpenedWorkbook (the funnel for local/desktop/gateway
  opens, deferred + terminal): if data.definedNames non-empty, fire
  nameServices.importFromDefinedNames(data.definedNames, sheetNames)
  (catch-swallowed, async; changed() re-renders dialogs on settle).
  Deps of the callback extended [protection] -> [protection, nameServices].
  This is a data-source wiring fix inside the existing hydrate, NOT a
  routing/shell change. The designed import path (module header:
  'On open, defined names ... are imported into the stores') finally
  has its caller.
- Effect: Download dialog lists the file's real range names (dangling
  shown disabled #REF!); handleConfirmDownload's store lookup now finds
  them, so named-range download works for file-carried names too.
- Import semantics (service store, pre-existing): plain ranges import;
  constants/expressions/_xlcn.* connection refs/LAMBDAs skipped with
  reasons; collisions skipped -> deferred+terminal double-hydrate is
  idempotent (pinned by test).
- Regression tests (new):
  * apps/web/src/features/nameServices.test.ts (3 tests): import of
    perf-p75-shaped names populates ranges.list() with parsed refs +
    dangling; non-range names skipped; second import duplicates
    nothing; imported names export back for save.
  * apps/web/src/components/DownloadDialog.test.tsx (3 tests): names
    supplied -> no false claim, options listed, dangling disabled,
    named-range download fires with id; empty -> claim + disabled radio.
- Tests: apps/web vitest — 2 files, 6/6 passed (pre- and post-restart
  runs; logs/itemh/web-tests.log).
- Browser end-to-end: POST-FIX run 1 dialog lists 28 real defined-name
  options for perf-p75, no false claim (logs/itemh/postfix-netlog.txt,
  postfix-dialog.png). Run 2 (with Obs1 v2) pending at checkpoint time.

## Observation 1 — /read 500 x4 — partial
- Endpoint: packages/gateway/src/services/engineSvc.ts:4433 POST /read.
- W20 build gate already exists (engineSvc.ts:1747-1840, waitForLoadBuild called
  at 4437; tests packages/gateway/tests/engineSvcReadDuringBuild.test.ts pin
  pend-on-build, failed-build, no-build behavior).
- Outer catch engineSvc.ts:5229-5232 sends 500 `engine error: …` with NO logging
  anywhere — matches audit's "engine logs nothing" (silent error path = defect
  candidate regardless of trigger).
- Netlog order (diag9): /sheets 200 x2, /read 200 x1, /read 500 x4, then many /read 200.
  So the 4 failures are NOT the first reads and occur AFTER at least one success —
  not a simple pre-session / pre-build race on its face.

## Observation 1 — REPRODUCED + ROOT-CAUSED (browser, isolated itemh stack 193xx, current src)
Repro script /tmp/itemh/browser-repro.mjs (diag9 flow, perf-p75, request+response
body capture; full log /tmp/itemh/browser-netlog.txt):
- Client issues, right after the collab /deltas connect and while /load/stream
  is in flight: usedrange Sheet1 (→200 {"range":null}, squeezed in pre-gate),
  range Sheet1 0,0-33,21, range Sheet1 0,0-0,0 — then the SAME pair again
  (2 shapes x 2 consumers).
- All 4 range reads PEND on the W20 gate, then execute against the NEW
  workbook, which has no 'Sheet1' → 500 {"ok":false,"error":"engine error:
  Unknown sheet: Sheet1"} — exactly 4, matching every audit run.
- 'Sheet1' is the BOOT/previous workbook's sheet: the reads were addressed
  to the superseded workbook, never to the incoming file. W20's gate
  re-targets them silently; unknown-sheet is the lucky outcome (a name
  collision would answer from the wrong workbook).
- Service-level control (/tmp/itemh/repro-read.mjs): 69 reads across all
  sheets/kinds pre/during/post load in unsigned mode — 0 failures; the
  defect needs the client's pre-open Sheet1 reads racing the gate.
VERDICT SHAPE: real defect (endpoint semantics), not a harness artifact —
the harness only makes the race deterministic by dropping the file
immediately after login.

## Observation 1 — FIX (engineSvc.ts, applied; v2 after first browser re-validation)
- waitForLoadBuild() now returns whether the caller pended on a build.
- v1 (409 for gate-penned superseded reads only) was NOT sufficient:
  post-fix browser run still showed 2x 500, 0x 409 — the remaining pair
  arrives during the build's SYNCHRONOUS block, sits in the socket
  queue, and is processed only after the gate has settled/cleared, so
  it never sees the gate. 
- v2 (final): /read pre-validates the sheet for cell/range kinds
  against state.host.sheetNames(). Absent sheet -> 409 'read superseded
  by a workbook load...' when the read pended on the load, else 404
  'Unknown sheet: X' (the engine's own message text). An absent sheet
  is a client addressing error, never a server fault — consistent with
  the other kinds (usedrange -> 200 null, sheet -> 200 []). Pended
  reads for sheets IN the new workbook still serve new values (W20);
  failed-build sticky errors still surface via the gate throw.
  Consumer check: signed/proxy transports + addonEngineBinding treat
  any non-ok generically (throw with the message) — no 500-specific
  handling anywhere; no other gateway test pinned unknown-sheet 500.
- Outer catch now logs `[engine] request failed <METHOD> <path>: <msg>`
  before sending 500 — the 500 path was completely silent for all routes.
- Regression tests: engineSvcReadDuringBuild.test.ts — 2 new Item H
  tests (superseded-four + post-build 404; 500-is-logged) and the W20
  'no build in flight' expectation revised 500 -> 404 with the reason
  recorded in the test + file header. Pre-restart run: 7/7 passed;
  post-restart v2 run: see logs/itemh/w20-test-v2.log.

## Browser validation (isolated itemh stack, current src builds)
- PRE-FIX run: 4x /read 500, bodies 'Unknown sheet: Sheet1' for the
  Sheet1 range reads (2 shapes x 2 consumers); dialog 'No defined
  names...' for perf-p75. (Run's netlog was in /tmp and lost in the
  2026-10-22 daemon restart; the identical audit evidence is preserved
  at hidden_files/roundtrip-audit/probe/diag9-netlog.txt and the bodies
  are transcribed above.)
- POST-FIX run 1 (v1 fix + Obs2 fix): Obs2 FIXED — dialog lists 28
  defined-name options (Accounts_Payable — Workbook · Inputs!B7, ...;
  reconciliation: 39 names carried by the load = 28 imported ranges +
  9 _xlcn.* skipped + Slicer_Type/Slicer_Year '#N/A' skipped); Obs1
  partially: 2x 500 remained (socket-queue window) -> motivated v2.
  Evidence: logs/itemh/postfix-netlog.txt + postfix-dialog.png.
- POST-FIX run 2 (v2, perf-p75): **0x /read 500 in the whole netlog.**
  The 4 superseded Sheet1 reads appear as 2x 409 (gate-pended window)
  + 2x 404 'Unknown sheet: Sheet1' (socket-queue window) — both
  windows covered in a single run. Engine log carries the two
  '[engine] /read superseded by workbook load...' lines and NO
  'request failed' line for reads. Dialog: 28 name options again.
  Evidence: logs/itemh/postfix2-netlog.txt, postfix2-dialog.png,
  engine-postfix2.log.
- POST-FIX run 3 (v2, drawing file closedxml-TryToLoad-DrawingSizeInPx,
  512 names): 0x /read 500; dialog lists **506 defined-name options**
  (512 - 6 skipped by the store's rules: cross-scope duplicates /
  external-ref shapes), no false claim.
  Evidence: logs/itemh/postfix3-netlog.txt, postfix3-dialog.png.

## Suite counts (final)
- packages/gateway tests/engineSvcReadDuringBuild.test.ts (W20 + Item H):
  7/7 passed (solo re-run; an earlier concurrent run died in collection
  with a vitest-worker fetch timeout and was re-run solo per protocol).
  Logs: logs/itemh/w20-test-v2b.log.
- packages/gateway related: tests/engineSvc.test.ts +
  tests/deployAccess.test.ts: 58/58 passed. Log: logs/itemh/gw-related.log.
- apps/web: src/features/nameServices.test.ts (3, new) +
  src/components/DownloadDialog.test.tsx (3, new) + src/io.test.ts +
  src/features/definedNames.test.ts + src/features/localMirror.test.ts:
  5 files, 46/46 passed. Log: logs/itemh/web-related.log.
- Typecheck: gateway tsc emit to dist-itemh clean (v2); apps/web
  tsc --noEmit clean (logs/itemh/web-tsc.log empty; an independent
  sibling run of the same tree also exited 0).

## Files changed
- packages/gateway/src/services/engineSvc.ts — waitForLoadBuild
  returns pended flag; /read sheet pre-validation (409 superseded /
  404 unknown sheet); outer catch logs every 500.
- packages/gateway/tests/engineSvcReadDuringBuild.test.ts — 2 new
  Item H tests; W20 unknown-sheet expectation revised 500 -> 404
  (reason recorded in test + header).
- apps/web/src/App.tsx — hydrateOpenedWorkbook imports the opened
  file's defined names into the service name store (one guarded call
  + deps entry). No routing/shell changes.
- apps/web/src/features/nameServices.test.ts — NEW.
- apps/web/src/components/DownloadDialog.test.tsx — NEW.
- NOT touched: progress.md, packages/mcp-server, web export code paths
  (residual p), App.tsx routing. No git push.
- Repro/validation harness copies: logs/itemh/browser-repro.mjs +
  start-stack.sh (isolated stack 19300-19307 + web 15373, gateway
  built to packages/gateway/dist-itemh — left in place, untracked
  build output like the audit's dist-rtaudit).

## Residual notes (named, not hidden)
- The load result itself carries 39 of perf-p75's 40 defined names
  into the client (one name lost upstream of the dialog — in the
  engine/adapter load path, not investigated here; it predates and is
  outside Item H's two observations; the save-side name handling is
  E1's, already pinned by io.test.ts).
- Store import is merge-only: names from a previously opened file are
  not evicted when a different file opens (the store is keyed to the
  constant workbook name 'workbook' in useNameServices). Pre-existing
  store semantics; changing them is a name-services design question,
  not part of this fix.

## NOTE — concurrent sibling edits
packages/gateway/src/services/engineSvc.ts is being edited concurrently
by a sibling worker (CSV load support landed mid-investigation, file
grew ~170 lines). My edits use exact-text anchors in /read + gate +
outer catch only; re-verified anchors at edit time.
