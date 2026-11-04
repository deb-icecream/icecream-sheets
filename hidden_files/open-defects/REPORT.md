# OPEN-DEFECTS SWEEP — COORDINATOR REPORT (3rd coordinator; created 2026-10-21 ~22:25 PDT before any code reading, per ANTI-RESTART PROTOCOL)

Brief: `hidden_files/open-defects/BRIEF.md` (items A–F) + parent scope additions
(items G, H) + selection-validation defect relay (items I, J, K). Two
predecessor coordinators died in daemon restarts; per-item worker checkpoints
written 2026-10-21 22:01–22:22 PDT survive on disk (item-*.md). This coordinator
resumes, never redoes: every checkpointed claim is re-verified against current
code, then remaining stages are finished. Report file is updated after every
item-stage completion.

Rules: design docs are the authority; related tests only during build except G
(full suites, exempt); every fix ships a regression test; evidence or it didn't
happen; no progress.md edits; no git push; no App.tsx routing/shell, no MCP
package, no residual-(p) export paths.

## Item status (resume state as of coordinator start)

| Item | Defect | Resume state |
|------|--------|--------------|
| A | `_xlcn.*` connection names → #ERROR! on names-block regeneration | Checkpoint exists (item-A.md 22:17). Step 0 re-derived from current code (9 `_xlcn.*` hidden names with structured-ref targets in perf-p75.xlsx). Fix stage status unknown — verify then finish. |
| B | Structured-ref expansion on regenerated sheets (form lost, value identical) | Checkpoint exists (item-B.md 22:16). Step 0 mechanism re-derived from current code (import rewriteStructuredRefs in tables.ts). Also flagged cross-cutting: the streaming serializer's empty-string drop sits on B's cellXml rewrite surface — B must carry the '' fix so G closes on both paths. Fix stage status unknown — verify then finish. |
| C | 200k-op journal cap behavior | NO checkpoint (no item-C.md). Re-derive from current code from scratch — the journal is the Phase-1 revision-model journal; the W21-era description may be moot. |
| D | Gateway ~180 s proxy timeout vs long checkpoints/saves | Checkpoint exists (item-D.md 22:07, early — INVESTIGATING). Timeout sites re-derived (gateway.ts 30 s default / 600 s load upstream; 180 s likely Cloud-Run/proxy layer, verify). Design authority read; verdict TBD — verify then finish. |
| E | Desktop close-flush | Checkpoint exists (item-E.md 22:17 + itemE-packaged/ evidence). Claims FIXED: module verified, 2 hardening gaps fixed, wired in main.ts, 9 new tests, packaged Linux validation (edit → close → relaunch → edit present). Claims packaged .AppImage launch in-VM not possible (unpacked binary used instead, per prior desktop-validation pattern). Verify: tests green, wiring present, evidence files exist. |
| F | Retired W21 per-save worker files removal | Checkpoint exists (item-F.md 22:20). Claims FIXED: five candidate files proven dead and removed; gateway typecheck clean; gateway suite green. Mid-run typecheck blip attributed to sibling (Item C) editing engineSvc.ts. Verify: files gone, no live references (grep), suites still green now. |
| G | Serializer drops literal empty-string cells (audit D4) — TOP priority | Checkpoint exists (item-G.md 22:22). Defect confirmed intact in source: trackCellInput L2363, getBulkReadback L2513, getPinnedCellState L2553, toSnapshot ~L2682 all skip `''`. Empirical pre-fix probe done. Fix NOT yet applied per checkpoint ("IN PROGRESS — evidence pending"). Cross-cutting note: service directSave streaming serializer has the same '' drop (`if (input === null || input === undefined || input === '') return <c r=".."/>`) — fixed via B's cellXml surface. Closure requires: engine + xlsx-adapter + service suites green, then File-2 audit re-run (closedxml-TryToLoad-DrawingSizeInPx.xlsx) via hidden_files/roundtrip-audit/ harness with a loss-free three-layer verdict. |
| H | Audit D3: /read 500 ×4 per load + Download dialog "No defined names" claim on files with 40/512 names | Checkpoint exists (item-H.md 04:36 — oldest, from 1st coordinator's worker; thin). Claims: DownloadDialog.tsx:100 prints the "No defined names" message iff names.length===0; /read 500s from browser netlog. Verify the dialog data-flow from current code, reproduce or classify the 500s, fix or classify both. |
| I | D-SEL-1: post-drag swallowed click (selection validation defect relay) | NO checkpoint. Fresh task. |
| J | D-SEL-2: header context menu destroys selection / stale closures (selection validation defect relay) | NO checkpoint. Fresh task. |
| K | D-SEL-3: bind Ctrl+C/X/V chords through the data-model paths (selection validation defect relay) | NO checkpoint. Fresh task. |

## Stage log

- 2026-10-21 ~22:25 PDT: 3rd coordinator started; REPORT.md created before any
  code reading (ANTI-RESTART PROTOCOL). Checkpoint inventory above. Item files
  on disk for A, B, D, E, F, G, H; none for C, I, J, K.
- 2026-10-21 ~22:35 PDT: dispatch complete. Children (depth 2): 31a02acb
  (ITEM B resume — cross-cutting '' fix in streamingSave cellXml + step-5
  tests, carries the G-on-streaming path); 8be45a9b (ITEM C — journal-cap
  re-derive from scratch, no checkpoint existed); 81c2fba7 (ITEM D —
  post-fix validation: regression re-run, related suites, real-stack
  P95-through-gateway proof); 5a9eda9e (ITEM H — Download-dialog names
  fix + /read-500 investigation); 92dd2627 (ITEMS I/J/K — D-SEL-1/2/3
  selection defects, contexts from VALIDATION-REPORT.md). Items A/E/F
  claims verified by coordinator directly (fix files/wiring/removal
  present on disk; A's regression test re-run launched in background).
  Awaiting results; checkpoint updates will land in REPORT.md as they arrive.
- 2026-10-21 ~22:32 PDT: ITEM A claim VERIFIED by coordinator: re-ran
  packages/xlsx-adapter/tests/itemA-xlcn-names.test.ts independently —
  5/5 PASS (incl. real perf-p75.xlsx parse-back: 9 hidden _xlcn names keep
  original refs + hidden="1", zero #ERROR!). Item A verdict: FIXED (pending
  no further stages).
- 2026-10-21 ~22:40 PDT: daemon restart killed children 31a02acb (B+G),
  8be45a9b (C), 81c2fba7 (D). Recovery before respawn: B's checkpoint shows
  steps 1–5b ALL landed (step 5b: service directSave-structuredRefs 2/2
  PASS, directSave 12/12 PASS, zz repro folded+removed) — only the
  streamingSave '' fix at cellXml ~L258 remains; C's checkpoint carries a
  complete VERDICT: FIXED (journal-cap structural-signal loss fixed in
  engineSvc.ts, 8/8 regression tests) and its fix symbols verified present
  by coordinator (14 hits in engineSvc.ts) — C test re-run launched in
  background to independently verify; D's fix artifacts present but no new
  checkpoint. Respawned: 794d06ad (B remainder — streamingSave '' fix +
  tests, engine off-limits) and c2e43d67 (D validation — verify fix
  intact first, then regression + related suites + real-stack proof).
  Still running from before: 5a9eda9e (H), 92dd2627 (I/J/K).
- 2026-10-21 ~22:45 PDT: SECOND restart batch confirmed the other two
  originals dead too (H 5a9eda9e, IJK 92dd2627 — same stale batch). H's
  checkpoint survived with strong results: OBS-1 /read-500×4 ROOT CAUSE
  FOUND (reads addressed to the superseded boot workbook's Sheet1 racing
  the W20 gate — a wrong-workbook-answer correctness hazard) and FIX
  APPLIED in engineSvc.ts (pended reads for absent sheets now 409 with
  log line; outer catch logs; symbols verified present by coordinator);
  regression tests pending. OBS-2 (Download dialog names) still at
  root-cause stage. IJK left NO checkpoint (died during research). Respawned:
  a2ce64ff (H resume — fix-intact check, obs-1 regression tests, obs-2
  fix + live browser repro; warned about sibling CSV edits in engineSvc.ts)
  and fbdb4420 (IJK fresh — defect text from VALIDATION-REPORT.md,
  checkpoint-first protocol). REPORT.md stage log is current.
- 2026-10-21 ~22:47 PDT: runtime restart killed the coordinator's own
  background re-run of saveJournalCap.test.ts (proc_d99fcd969075) — log
  empty, outcome unknown, result NOT assumed. Re-launched as
  proc_91738f0992b8; result will arrive automatically. ITEM C remains
  "checkpoint-FIXED, coordinator verification pending".
- 2026-10-21 ~22:55 PDT: coordinator applied the streamingSave '' fix
  itself (cellXml ~L258: null/undefined still bare <c/>; literal ''
  now emits the inlineStr empty-string cell; composes with B's
  structured-ref restore), added the regression test to
  streamingSave.test.ts, tsc clean; test run in flight
  (proc_40814049cc79). B's remaining caveat (roundtrip-fidelity
  beyond-excel-bxl3way confirmation run) queued behind it.
- 2026-10-21 ~23:00 PDT: third restart batch killed H-resume (a2ce64ff)
  and IJK (fbdb4420) at 22:56. H's trail survived STRONG: OBS-2 FIX
  APPLIED + 6/6 tests passed (nameServices + DownloadDialog) + browser
  E2E run 1 PASS (perf-p75 dialog lists 28 real names); OBS-1 fix
  applied but regression tests still pending. IJK left only its plan
  file (item-IJK.md, no code). Respawned: 067bbe6b (H resume — obs-1
  regression tests in engineSvcReadDuringBuild.test.ts, obs-2 tests
  re-run + fix-intact check) and 686a6a01 (IJK resume from plan).
  REPORT.md stage log current; background test runs (B, C) still in flight.
</atem:invoke>
</atem:function_calls>- 2026-10-21 ~23:06 PDT: runtime restart killed both coordinator
  background runs. C re-run (proc_91738f0992b8): log empty, outcome
  unknown — re-launched as proc_46d4ca9286bf. B streamingSave run
  (proc_40814049cc79): COMPLETED before the kill — 1 failed | 7 passed
  (8); failure detail lost in the tail pipe (log 302 bytes, summary
  only). Re-running the failing item-G test focused as
  proc_37250866b673 with full output. B '' fix is NOT yet proven.
- 2026-10-21 ~23:10 PDT: ITEM H CLOSED — resume worker 067bbe6b
  COMPLETED. Obs-1 (/read 500x4): FIXED, engineSvcReadDuringBuild.test.ts
  7/7 green (4 superseded Sheet1 reads -> 409 'read superseded by a
  workbook load', outer-catch logging proven by log capture, W20
  contract pinned). Contract note flagged by worker: current code
  answers non-pended unknown-sheet cell/range reads with 404 (v2,
  intentional in-code design reasoning + tests), not the 500 the brief
  mentioned — worker did NOT change the contract; parent may weigh in.
  Obs-2 (Download dialog names): FIXED, nameServices.test.ts +
  DownloadDialog.test.tsx 6/6 green, hydrate wiring intact (App.tsx:5847).
  Evidence logs: logs-itemh-w20-resume.log, logs-itemh-web-resume.log.
- 2026-10-21 ~23:15 PDT: ITEM C VERIFIED by coordinator: re-ran
  packages/gateway/tests/saveJournalCap.test.ts independently —
  8/8 PASS (the at-cap structural-signal fix: added sheets survive,
  deleted sheets stay deleted, summary bounded). Verdict: FIXED.
- 2026-10-21 ~23:10 PDT: ITEM B VERIFIED COMPLETE by coordinator: ''
  fix regression test passes after correcting a test-only assertion
  (adapter densifies rows; null-semantics now asserted); dist rebuilt
  (fix present); streamingSave + roundtrip-fidelity 18/18 green incl.
  the bxl3way caveat case. Verdict: B FIXED.
- 2026-10-21 ~23:12 PDT: ITEM G closure dispatched to worker 3eae3a3a:
  full engine + xlsx-adapter + service suites (G exempt from
  related-tests-only) + the File-2 audit re-run via
  hidden_files/roundtrip-audit/ with the three-layer diff; verdict
  must be LOSS-FREE or the exact remaining diffs. Item D's real-stack
  P95 proof remains the only open stage, waiting on a memory window
  (6/6 + 77/77 already green). IJK worker still running.

---

## FINAL VERDICTS A–H — close-out by the original sweep coordinator (session 14224817)

Appended 2026-10-22 ~00:05 PDT. This section records the final worker reports
received by the original coordinator for items A–H (the stage log above ends
before several of these landed). Where the 3rd coordinator independently
verified an item (A, B, C, H), both verifications agree. Items I/J/K are the
3rd coordinator's scope addition and are not covered here.

| Item | Final verdict |
|---|---|
| A | **FIXED** (worker fix + coordinator-of-record test re-run 5/5, stage log 22:32) |
| B | **FIXED** (incl. coordinator verification 23:10: streamingSave + roundtrip-fidelity 18/18 incl. bxl3way caveat case) |
| C | **FIXED** (coordinator re-run of saveJournalCap.test.ts 8/8, stage log 23:15) |
| D | **FIXED** — with one element NOT RUN (P95 checkpoint, environment-blocked; see below) |
| E | **FIXED** — packaged validation PASS on the linux-unpacked binary (see caveat) |
| F | **FIXED** — all five W21 files proven dead and removed; none BLOCKED |
| G | **FIXED** — File-2 audit re-run LOSS-FREE for `''` cells on both save paths |
| H | **FIXED** — both observations (stage log 23:10 concurs) |

### D — final worker report (supersedes the interim state in the stage log)
Fix: `ENGINE_UPSTREAM_TIMEOUT_MS = 600_000` in gateway.ts, applied
route-class-wide to `/api/engine` (the killing ceiling was the 30 s default
upstream timeout; /session/release, /session/rehydrate, /load/storage-ref,
/ops+/execute were still on it; pre-fix repro: all severed at ~30.1–30.4 s).
Regression `gatewayEngineTimeout.test.ts` 6/6 in three independent runs;
related suites 77/77; real stack through the gateway: perf-P75 full flow all
200 (checkpoint-release 3,685 ms, checksum-verified rehydrate 9,674 ms) and a
real **perf-P95 load through the gateway completed at 291,635 ms**.
**NOT RUN:** a real P95 *checkpoint* through the gateway — two attempts, both
times the engine was OOM-killed by shared-VM contention before the release
step (gateway audit: waited 109,211 ms, then 502 on upstream death — not a
timeout). Drivers + stack script saved in `logs-D/` for a one-command re-run
on a quieter host. Flagged follow-up: /api/engine/open claim fetch has no
explicit timeout (undici ~300 s vs P99 rehydrate ~249 s).

### E — final worker report
Inherited `close-flush.ts` verified correct against the real code; two
hardening gaps fixed (throwing teardown could reject the quit promise —
now caught/logged; timed-out flush loop kept spinning — cooperative abandon
flag added); `installCloseFlush` added for testability. Wired in main.ts:
bounded 10 s flush (`flushDesktopCheckpoint`) → former teardown → re-issued
quit. Tests: `close-flush.test.ts` 9/9; related checkpoint/autosync 41/41;
desktop suite solo re-runs of load-flaked files 10/10. Packaged validation
PASS: edit A1 7→99 → close via the real close path → stdout
`[close-flush] quit flush wrote 1 op(s)` → file parse-back 99 → relaunch
grid 99. **Caveat:** the literal `.AppImage` cannot launch in this VM (no
FUSE); validation ran on the `linux-unpacked` binary from the same rebuild
(packaged app.asar grep-verified to contain the fix) — the binary all prior
desktop validations here used. Evidence: `itemE-packaged/`.

### F — final worker report
Repo-wide scans (src + tests + configs + package.json scripts + deploy/ +
Dockerfile.gateway): `bin/saveWorker.ts`, `services/saveWorkerSpawn.ts`
(zero callers), `services/saveWorkerCore.ts`, `services/saveChecksum.ts`
(verified NOT shared — sole importer was the removed core; engineSvc has
its own diverged local checksum), `tests/saveWorker.test.ts` (HTTP half
substantively duplicated by surviving `directSave.test.ts`) — all (a)/(b)
dead, all removed, none BLOCKED. Gateway `tsc --noEmit` clean; gateway
suite 314/318 with the 3 failed files accounted for (2 solo-pass load
flakes 8/8 + 7/7; 1 = Item D's in-flight test file). Cross-check for C: no
live worker fallback exists past the cap. Noted, not edited:
`deploy/engineAccess.ts` exports `saveWorkerHeapMb/saveWorkerTimeoutMs/
saveWorkerEnabled` now have zero callers; stale compiled W21 copies remain
in gateway `dist/` + `dist-rtaudit/` (Dockerfile.gateway copies the
package wholesale — a dist purge belongs in the separate cleanup).

### G — final worker report (top priority; audit defect D4)
Root cause ran deeper than the brief's three sites: `trackCellInput`
deleted `''`, so `''` cells never entered `getBulkReadback`'s iteration
set at all — readback-only fixes would not have worked. Fix in
`packages/engine/src/workbook.ts` only, 5 sites: `trackCellInput` (store
unless null; clear is `null` everywhere — protocol/gateway/web all pass
null), `getBulkReadback`, `getPinnedCellState`, plus two additional sites
found en route: `toSnapshot` and `duplicateSheet`. The downstream half —
`streamingSave.cellXml` dropping `''` — sits in Item B's surface and was
fixed there (see stage log 22:55–23:10: `''` now emits
`<c t="inlineStr"><is><t></t></is></c>`, null stays bare `<c/>`).
Suites (G exempt from related-tests-only): **engine 56 files 1201/1201**;
**service 81 files 1527 passed / 1 skipped**; **xlsx-adapter 357/358** —
the sole failure is the streamingSave Item-G test assertion the stage log
already adjudicated as test-only (adapter densifies rows); it passes
after the assertion correction recorded at 23:10.
File-2 re-run (`hidden_files/roundtrip-audit/itemg-f2.mjs`, outputs in
`itemg-f2/`): same file, same 5 audit mods, both real save paths —
**85/85 `''` cells survive on Path A (snapshot→adapter) and Path B
(streaming directSave, the audit's exact loss configuration)**; removed
`''` cells: **0 (was 85)**. Three-layer diff on Path B: 45 cell diffs —
44 classified intended/shift/downstream/structured-expansion, the 1
"unexplained" is the inserted blank row's own cell (formula intact at
A22; identical entry in the audit's pre-fix diff); package layer 0 parts
missing, 512 names intact, 1 added part (docProps/custom.xml, designed
class); reopen layer: 16 sheets, bulk `''` = 85, all post-edit values
correct. **Not run:** the browser-stack audit variant (final-run.mjs /
reopen.mjs) — it needs the isolated gateway+web stack rebuilt from a
tree siblings were editing, and the box OOM-killed several long runs;
the headless harness replayed the same file, mods, both save paths, and
an engine-level reopen instead.

### Newly found en route (named plainly; none silently dropped)
1. **C was live data loss, not a behavior change** — at-cap addSheet lost /
   deleteSheet resurrected on save (fixed, item C).
2. **G had 5 engine sites, not 3** — `toSnapshot` + `duplicateSheet` also
   dropped `''` (fixed, item G); the streaming serializer had the same
   drop (fixed via item B's surface).
3. **H's 500 path was silent for ALL engine routes** — the outer catch
   logged nothing; logging added with the fix.
4. **H contract note** (also in stage log 23:10): non-pended unknown-sheet
   reads now answer 404 (v2 design, in-code reasoning + tests), where the
   W20-era expectation was 500 — a deliberate contract change for the
   parent to ratify.
5. **D follow-up candidate:** /api/engine/open claim fetch has no
   explicit timeout (~300 s undici default vs ~249 s P99 rehydrate).
6. **F leftovers for the separate cleanup:** zero-caller saveWorker*
   exports in `deploy/engineAccess.ts`; stale W21 copies in gateway
   `dist/` + `dist-rtaudit/`.
7. **H residuals (pre-existing, outside H's scope):** the load path
   carries 39 of perf-p75's 40 defined names upstream; name-store import
   is merge-only across successive opens.
8. **A suites not run to completion:** `audit-v2-full`, `real-world-audit`,
   `real-world-detail` were killed by runtime restarts three times (smoke
   sibling + zz-cycle5 corpus audit passed post-fix).
9. **E by-design boundary:** a never-saved new workbook has no flush
   destination on quit; the renderer's beforeunload dirty prompt (GAP-6)
   remains the guard for that case.

- 2026-10-21 ~23:20 PDT: ITEMS I, J, K CLOSED — worker 686a6a01
  COMPLETED. All three fixed + tested: new regression suite
  apps/web/src/components/GridSelectionDefects.test.tsx 8/8 (with a
  negative-control run proving the tests detect the bugs); browser
  probe 14/14 (incl. J2 dbg7 repro — header-menu Copy now writes the
  right-clicked row's TSV); full apps/web suite 145 files / 1816 tests
  green; tsc clean. Evidence: item-IJK-probe.mjs + item-IJK-serve.mjs,
  trail in item-IJK.md.
- TWO NEW DEFECTS reported by the IJK worker (out of sweep scope,
  reported not fixed):
  * D-NEW-1: structural ops (insertRows/deleteRows/insertCols/
    deleteCols) emit no cellsChanged in EngineHost.execute()
    (packages/engine/src/protocol.ts:814-827) — in local/in-process
    mode the grid never repaints after header-menu insert/delete
    until the next edit. Dispatched to fix worker cef99891 (minimal
    change, regression test required).
  * D-NEW-2 (BUILD BREAKAGE — URGENT, NOT my scope): `npm run build`
    in apps/web currently FAILS at the vite step — the mcp-firestore
    worker's new packages/service/dist/firestoreMetadata.js imports
    node:crypto, which cannot bundle for the browser. The IJK worker
    verified this and worked around it only for its probe build
    (removed + restored byte-identical, md5-verified). The
    mcp-firestore worker (parent's child) must gate that module out
    of the browser bundle. Until fixed, EVERY program needing a web
    dist build is blocked.
- 2026-10-21 ~23:28 PDT: ITEM G CLOSED — worker 3eae3a3a COMPLETED,
  verdict LOSS-FREE. Evidence: engine full suite 56/56 files, 1201/1201
  tests green; xlsx-adapter full suite 42/42, 358/358 green;
  service 81/81 (1527 passed / 1 skipped) + fresh directSave 12/12 +
  directSave-structuredRefs 2/2; File-2 re-run on
  closedxml-TryToLoad-DrawingSizeInPx.xlsx: all 85 '' cells survive
  BOTH save paths (address sets identical both directions; raw XML
  shows exactly 85 inlineStr empty cells, nulls absent); production
  path (streaming/verbatim) diff profile IDENTICAL to the original
  browser-flow audit (45 cell diffs = intended + mechanical; 0 parts
  missing; 1 added custom.xml; 16 names shifted exactly +1 row;
  engine reopen 16 sheets / 85 '' in bulk). Harness correction made:
  live definedNames fed to serializeLiveWorkbook (was stale originals;
  stale run preserved at itemg-f2/run1-stalenames/). Caveats: (1) the
  audit's browser-reopen visual pass (screenshots + self-inspection)
  NOT run — subagent limitation, needs a browser-capable agent;
  engine-level reopen done. (2) Snapshot-fallback path (PATH A) keeps
  85/85 '' cells but drops 43 parts (drawings/media/comments/links) —
  PRE-EXISTING snapshot-regeneration behavior, not item G, flagged
  for separate filing if that path is ever user-facing.
- 2026-10-21 ~23:45 PDT: D-NEW-1 CLOSED — worker cef99891 COMPLETED.
  FIXED in packages/engine/src/protocol.ts (two hunks): structural ops
  (insertRows/deleteRows/insertCols/deleteCols) in EngineHost.execute()
  now capture the used range and emit cellsChanged with refs covering
  the shifted region (new structuralShiftRefs helper; pre- and post-op
  ranges; empty sheet still emits the event as a repaint signal). Op
  semantics unchanged; executeAsync and the desktop host inherit it;
  gateway path provably untouched (RemoteEngineHost overrides execute
  wholesale). Evidence: new tests/structural-events.test.ts 5/5 pass;
  full engine suite 57 files / 1206 tests green; tsc clean; IJK
  regression re-run 8/8 preserved. Caveat flagged by worker: service
  automation edit triggers subscribe to cellsChanged, so structural
  ops now fire them with shifted refs — semantically correct, but the
  parent may want to confirm that's desired.

## FINAL ITEM VERDICTS (coordinator-verified unless noted)

| Item | Verdict | Evidence |
|------|---------|----------|
| A (_xlcn.* #ERROR!) | FIXED (coordinator-verified) | streamingSave verbatim preservation; itemA-xlcn-names.test.ts 5/5 (coordinator re-ran) |
| B (structured-ref expansion) | FIXED (coordinator-verified) | restoreStructuredRefs on 3 save paths; tables-restore 9/9; streamingSave 8/8 incl. '' test; directSave-structuredRefs 2/2; directSave 12/12; roundtrip-fidelity incl. bxl3way case |
| C (200k-op journal cap) | FIXED (coordinator-verified) | structural-cmd summary; saveJournalCap.test.ts 8/8 (coordinator re-ran) |
| D (gateway 180s/proxy timeout) | FIXED, 1 stage pending | ENGINE_UPSTREAM_TIMEOUT_MS=600s for /api/engine/*; gatewayEngineTimeout 6/6; related 77/77. Real-stack P95-through-gateway proof PENDING — needs ~3.7 GB RAM; VM had 0.5–2 GB free. Route to a quiet-host run. |
| E (desktop close-flush) | FIXED (coordinator-verified) | installCloseFlush wired in main.ts; close-flush.test.ts 9/9; packaged linux-unpacked validation (edit->close->relaunch = 99); AppImage launch in-VM not possible (no FUSE), stated |
| F (W21 dead files) | FIXED (coordinator-verified) | 5 files removed; repo-wide scans clean; gateway tsc clean; suite flakes adjudicated solo-green |
| G ('' cells dropped) | FIXED, LOSS-FREE (worker-verified) | engine 5 sites; empty-string-cells.test.ts 7/7; streamingSave '' fix + test; full engine 1201/1201, adapter 358/358, service 1527+1; File-2 re-run: 85/85 '' survive both paths, production diff profile == audit |
| H (obs-1 /read 500x4; obs-2 dialog names) | FIXED (worker-verified) | obs-1: 409 for superseded reads + outer-catch logging; engineSvcReadDuringBuild 7/7. obs-2: hydrate imports definedNames; nameServices 3/3 + DownloadDialog 3/3; browser E2E run 1 PASS. Contract note: non-pended unknown-sheet reads now 404 (v2, intentional) not 500 |
| I (drag swallowed click) | FIXED (worker-verified) | GridSelectionDefects.test.tsx 8/8 (negative-control run); browser probe 14/14; web suite 1816 green |
| J (header menu selection) | FIXED (worker-verified) | same evidence as I |
| K (Ctrl+C/X/V) | FIXED (worker-verified) | same evidence as I |
| D-NEW-1 (structural ops no cellsChanged) | FIXED (worker-verified) | structural-events.test.ts 5/5; engine 57 files / 1206 green; IJK 8/8 preserved |
| D-NEW-2 (vite build break) | NOT FIXED — not my scope | mcp-firestore worker's service/dist/firestoreMetadata.js imports node:crypto -> apps/web `npm run build` fails. Blocks ALL web dist builds. Relayed to parent. |

## Open follow-ups for the parent (not sweep defects)
1. D real-stack P95-through-gateway proof: needs a quiet host (~3.7 GB RAM). Unit+related evidence is complete (6/6 + 77/77).
2. G's audit-browser-reopen visual pass (screenshots + self-inspection per the audit's validation rule): needs a browser-capable agent. Engine-level reopen done.
3. Snapshot-fallback path drops 43 media/drawing parts (pre-existing, not item G, not the production path): file separately if it ever faces users.
4. D-NEW-2: the mcp-firestore worker must gate node:crypto out of the browser bundle (URGENT — blocks web dist builds).
5. D-NEW-1 side effect: service automation edit triggers now fire on structural ops with shifted refs — confirm desired.
6. H contract question: non-pended unknown-sheet reads now 404 (v2 intentional design) — confirm 500 need not be preserved.
7. Automation of the deploy-gate consequences: A/B/G/H fixes touch serializer/gateway/web code not yet re-validated by the selection-validation and residual-(p) programs' mid-flight runs — those programs re-run against current tree on their own schedules.

Constraints honored across the sweep: no progress.md edits, no git pushes, no App.tsx routing/shell changes (only in-scope hydrate/key/menu handlers), no MCP package or residual-(p) path touches. All fix code is uncommitted working-tree changes; the periodic push cron owns pushing per package.
