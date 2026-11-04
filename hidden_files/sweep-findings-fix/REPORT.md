# Sweep findings fix program — checkpoint record

Started: 2026-10-22 (worker session, sweep-findings-fix)
Port block claimed: 9070-9079
Scope: F-5 (#19), F-2 (#16), F-8 (#22), F-9 (#23), F-6 (#20) from hidden_files/e2e-visual-sweep/REPORT.md
Constraints: do NOT push; do NOT touch progress.md. Validation = ONLY the specific screenshot scenario per finding (before/after pair). Related unit tests only.
NOTE: a second worker (hosted-UX batch) is concurrently editing apps/web — RE-READ any apps/web file immediately before editing it.

## Status log
- [x] F-5 (#19) — stored number formats dropped at load
- [x] F-2 (#16) — open web path to legacy .xls
- [x] F-8 (#22) — name box typed-ref navigation
- [x] F-9 (#23) — Freeze Top Row renders height-clipped
- [x] F-6 (#20) — Protect Sheet dialog layout

## Findings log
(checkpoint entries appended as work lands)

### F-5 (#19) — stored number formats dropped at load — FIXED (code)
Root cause PROVEN by elimination: adapter (SheetJS + fast parse) both emit formats {"5:1":"yyyy\\-mm\\-dd","6:1":"0%"}; wire encode/decode sound; formatWithCode(46317, code)="2026-10-22", (0.25,"0%")="25%"; engineSvc loadResponse/buildFromData carry formats. The loss is in App.tsx's join-by-link continuation (the Workspace-upload -> ?file= open): it called notifyHostReplaced() before hydrateOpenedWorkbook AND AGAIN after the snapshot fetch; the host-replaced handler runs setFormats(createFormatStore()), so the second notify WIPED the store hydrate had just seeded (the defect-E2 ordering doctrine, violated). Ribbon formats work because they are applied after open completes.
Fix: restructured the continuation — snapshot fetched first, ONE notifyHostReplaced() after it (preserves the Wave-C W5 tab-sync), then hydration (load payload or snapshot-overlay). apps/web/src/App.tsx join-by-link .then block.
Screenshot validation: PENDING (shots/05 scenario, after all fixes land, one stack session).

### F-2 (#16) — open web path to legacy .xls — FIXED (code; citation correction: F-8 is #22)
Parse fact established first: XlsxAdapter.read THREW on real .xls (ZIP-signature guard); SheetJS itself parses BIFF fine (values + f=SUM(B2:B3) + w= formatted text).
Wired layers:
- xlsx-adapter adapter.ts: read() accepts the OLE2 signature (D0 CF 11 E0) alongside ZIP; all OOXML-metadata stages tolerate non-ZIP bytes (best-effort catches verified live: adapter read of simple.xls returns rows incl. "=SUM(B2:B3)" AND formats {"5:1":date-code,"6:1":"0%"}).
- gateway userStore.ts: SourceFormat += 'xls' (type, sourceFormatForFileName, isSourceFormat, record + catalog-create types); uploadStore.ts uploadObjectKey format type widened.
- gateway.ts: both upload 400 messages now "only .xlsx, .xls and .csv files can be uploaded" (+ productLayer.test.ts assertions updated to the new contract — the only 2 test failures from this change, both pins of the old string).
- engineSvc.ts: loadBytesIntoSession format += 'xls' with a SheetJS-adapter parse branch (fast parser is ZIP-only); sourceBytes=null for xls (like csv — first save serializes the converted workbook in full); /load gate + cast and /load/storage-ref gate + format mapping accept 'xls'. /load/stream stays xlsx-only BY DESIGN: the collab transport's stream attempt fails fast and falls back to /load with the same format.
- web: productApi.ts sourceFormat type += 'xls'; collabTransport loadXlsxDirect/loadXlsxProgressiveDirect take a format param (threaded through retries + the /load fallback), loadStorageRefDirect ref format += 'xls'; remoteEngine loadXlsxAsync(base64, onChunk, format); App openRemoteBuffer derives 'xls' from the filename and passes it; Workspace.tsx (edited LAST, re-read first): accept=".xlsx,.xls,.csv", validation + copy updated.
Tests: xlsx-adapter full suite PASS (background run exit 0); gateway productLayer + userStoreProd + engineSvc suites PASS after the 2 message-pin updates; gateway tsc clean; web tsc clean. Legacy gateway-proxied transport (gatewayClient) intentionally unchanged — the signed/handshake path is the web open path.
Screenshot validation: PENDING (shots 04/05 scenarios with the real simple.xls).

### F-8 (#22) — name box typed-ref navigation — FIXED (code)
The name box was a plain <span class="formula-address"> in FormulaBar.tsx. Now a real <input> (same class/footprint; index.css gains input.formula-address width + focus rules): focus selects the current ref; Enter parses via the engine's parseA1RangeRef ("C7", "B2:D5", "$A$1", "Sheet2!A1") and calls the new onNavigate prop; Escape/blur discards; invalid input never reaches onNavigate and the box restores the live address (draft-clear). While not editing, the box follows sel/sheet changes exactly as the span did. App wires onNavigate: a sheet prefix naming a non-existent sheet voids the navigation; a valid one switches sheet; setSel(anchor) + setGridSel(rangeSelection(...)). Not in scope (Excel parity beyond the tasking): defined-name navigation and whole-row/column refs ("A:A") — parseA1RangeRef rejects them, so they restore harmlessly.
Screenshot validation: PENDING (finale probe scenario: type C7 -> selection lands; invalid -> restore).

### F-6 (#20) — Protect Sheet dialog layout — FIXED (code)
Root cause: NO base .dialog-field rule existed anywhere — only .appbuilder-form had one — so dialog <label class="dialog-field"> elements rendered inline: "Password (optional)" + input on one line, "Confirm" stranded at the line end, "password" + input wrapped below (shots/36). Fix: base rules added in index.css next to .dialog-hint — .dialog-field{display:block}, > span block, controls block/full-width with the appbuilder-consistent padding/border. Same fix repairs FilePasswordDialog, OpenFromUrlDialog, GatewayLogin and AppViews fields, which share the pattern.
Screenshot validation: PENDING (shots/36 scenario, desktop + mobile widths).

### VALIDATION (stack 9070/9071/9072, probes/p1-open.mjs) — F-5 + F-2 PASS
- F-5: simple.xlsx via Workspace upload -> open: DOM B6="2026-10-22", B7="25%", B4="30". Shot: shots/f5-after-05-grid-open.png (visually confirmed). BEFORE: hidden_files/e2e-visual-sweep/shots/05-grid-open.png (B6=46317, B7=0.25).
- F-2: simple.xls upload accepted (grant + complete), listed in Workspace (shot shots/f2-after-04-workspace-xls.png), opened via the service: A2=Apples, B2=10, B3=20, B4=30 with formula bar "=SUM(B2:B3)" — values AND formulas kept; formats carried too (B6=2026-10-22, B7=25%). Shot: shots/f2-after-05-grid-open-xls.png (visually confirmed). BEFORE: sweep1/sweep1c evidence (.xls offered nowhere; upload failed).

### CROSS-FINDING (observed during validation, NOT one of the five): stale session wedges ALL opens on a single-engine stack
After probe P1's browser closed, its LAST session (the .xls one, sess_c1937c3b) was never released (engine log shows the xlsx session released via page-unload; the xls session only checkpointed). From then on EVERY POST /api/engine/open — any user, any file, including brand-new uploads — returned 409 (gateway log lines 178+), the engine logged no further /load calls, and clients rendered an empty phantom grid indefinitely (45s poll). This persisted 35+ minutes, past the 10-minute idle rule. Restarting the stack cleared it. This is the F-4 (#17) 409's other face and belongs to the successor worker's F-3/F-4 scope; recorded here with log evidence (runtime/logs/{gateway,engine}.log). Validation methodology adapted: fresh stack + fresh user per probe phase, mirroring the sweep's own discipline.

### F-9 (#23) — Freeze Top Row — ROOT CAUSE PROVEN, FIXED (code)
Measured live on a fresh stack (probe p4, workbook loaded): body rows 0/1 render 15px, row 10 renders 24px. The fixture's rows carry ht="15" POINTS; the fast parse stored the point value raw into rowHeights, whose unit everywhere else is CSS px (serializer writes ht = px * 0.75). Every height-carrying row rendered 25% too short, its text clipped by the cell's overflow:hidden — the pinned row is simply where it was screenshot-caught. Fixes: (1) fastSheetParse.ts convertDimensions: heights = round(heightPt * 4/3) (comment corrected — the old one rationalized the bug via SheetJS's hpx); (2) adapter.ts worksheetToRows: prefer hpt and convert * 4/3 — SheetJS's hpx is pt*PPI/96 with PPI=96, i.e. numerically points, not px (verified against the bundled SheetJS source + live read: !rows hpt=15, hpx=15). Round-trip effect: load 20px -> save ht=15pt (stable); before, load 15 -> save 11.25pt (shrunk every round trip).
SECOND defect (the "gutter mislabels" half): the frozen-rows strip had NO gutter element — its gutter slot was transparent and the body's scrolled row header bled through (measured: a role=rowheader "29" occupying the slot). Fix: Grid.tsx renders frozenGutter row headers inside the strip (frozen rows' own numbers, sticky-left, opaque --header-bg via .row-header, click selects the row like body headers).
Screenshot validation: PENDING re-run of the 38b scenario on the rebuilt dists.

### VALIDATION — F-9 / F-8 / F-6 (stack 9070-9079, rebuilt dists)
- F-9 (probe p4, fresh stack+user): body rows with ht=15pt now render 20px (were 15px); frozen cell 20px tall, text "Item"/"Amount" present; the strip's gutter slot now contains role=rowheader "1" at the strip's exact position (before-fix probe measured a body header "29" bleeding into the slot). Shot shots/f9-after-38b-freeze-scrolled.png visually confirmed against BEFORE hidden_files/e2e-visual-sweep/shots/38b-freeze-scrolled.png: pinned row full height, text fully visible, gutter correct (1, then body 28, 29...).
- F-8 (probe p5, fresh stack+user, values loaded): "C7"+Enter -> box shows C7, cell-6-2 .selected, status bar Cell: C7 (shot shots/f8-after-namebox-c7.png); "B2:D5" -> anchor B2 .selected, D5 .in-selection, box shows B2 (shot shots/f8-after-namebox-range.png); "ZZZZ"+Enter -> box restores B2, selection unchanged; mouse click on B4 -> box follows to B4. All PASS. (An earlier P2 run on a wedge-emptied workbook had already proven the mechanics; P5 re-proves them with values.)
- F-6 (probe p2): DOM measurement — both .dialog-field labels stack above full-width inputs, no shared lines (inputTop > labelTop for both fields); shots shots/f6-after-36-protect-sheet.png (desktop) + shots/f6-after-36-protect-sheet-mobile.png (390px) visually confirmed: "Password (optional)" and "Confirm password" each intact on one line. BEFORE: sweep shots/36-protect-sheet.png.

### TEST SUMMARY (related tests only, per directive)
- xlsx-adapter: FULL suite PASS after the F-9 units changes (background run exit 0; includes fastSheetParse + streamingSave round-trip tests).
- gateway: productLayer + userStoreProd + engineSvc suites PASS (2 productLayer assertions updated — they pinned the pre-F-2 upload error string; the new string names .xls too).
- apps/web: tsc --noEmit clean after every change batch; no dedicated Grid/FormulaBar/App unit test files exist in the repo (component behavior is covered by the browser probes above + the sweep's own suite discipline).
- gateway tsc + full gateway build clean; adapter build clean.

### FINAL STATUS
- [x] F-5 (#19) FIXED + validated (screenshot pair)
- [x] F-2 (#16) FIXED + validated (screenshot pair, values+formulas+formats via the real .xls)
- [x] F-8 (#22) FIXED + validated (screenshot pair + DOM asserts)
- [x] F-9 (#23) FIXED + validated (screenshot pair + geometry asserts; TWO root causes: pt/px units + missing strip gutter)
- [x] F-6 (#20) FIXED + validated (screenshot pair desktop+mobile + DOM asserts)
Not pushed (per tasking). progress.md untouched (per tasking). Stack on 9070-9072 stopped at wrap-up; runtime/ + probes/ + shots/ retained as evidence.
Known minor deltas (recorded, not fixed — outside the findings' acceptance): the frozen gutter supports click-to-select but not header drag-select or right-click menus (body headers have both); with a column freeze as well, the strip's corner region right of the gutter relies on the pre-existing frozenCorner rendering.

### CORRECTION ADDENDUM (post-delivery, same day) — test-claim repair + a THIRD F-9 root cause
The TEST SUMMARY above claimed the adapter suite passed on a background run whose exit code came through a `| tail` pipeline — the pipe masked vitest's real exit code. True sequence, reconstructed from the un-piped logs (~/workspace/tmp-sweep-fix/adapter-suite*.log):
- Baseline (F-2 changes only): 1 failed / 363 — adapter.test.ts pinned the pre-F-2 corrupt-input message.
- After the F-9 READ-side units fix alone: 7 failed / 363 — fastSheetParse pin (fixture ht="20"pt; pinned the raw-points behavior), pageSetupXml write->read->write byte-idempotency, and 4 roundtrip-fidelity files (after-heights were exactly before x 4/3).
- THIRD ROOT CAUSE (F-9 family, write side): XlsxAdapter's worksheet builder set entry.hpx = px AND entry.hpt = px*3/4. SheetJS's sheet writer PREFERS hpx and derives the emitted ht = px2pt(hpx), which at SheetJS's default PPI=96 is the IDENTITY — so every adapter-mediated save wrote the model's px value into the file AS POINTS, inflating custom row heights by 4/3 per save (proven in the bundled SheetJS source, write_ws_xml_sheet). The gateway streamingSave path was already correct (ht = px*0.75); only the SheetJS/adapter path (desktop saves) had this bug. The pre-fix read/write pair was consistently wrong together, which is why the round-trip suite couldn't see it — the heights only rendered short (F-9's visible symptom).
- Fixes: adapter.ts write builder no longer sets hpx (hpt = px*3/4 only; guard + comments corrected); adapter.test.ts corrupt-input regex updated to the intentional F-2 message; fastSheetParse.test.ts expectation 20 -> 27 (20pt = 27px) with a unit comment.
- Final state: the 4 failed files re-run 33/33 PASS, then the FULL adapter suite re-run un-piped: 42 files, 363/363 PASS, vitest exit 0.
Also corrected from the F-9 section above: the pre-fix drift direction differed by path — gateway streamingSave shrank heights per round trip (raw pt in, x0.75 out); the adapter path did not drift but rendered short. After all three fixes both paths are unit-correct and drift-free, proven by the round-trip fidelity suite (10 real-world files) and pageSetupXml byte idempotency. The browser screenshot validations stand as delivered (they exercise the gateway/fast-parse path; adapter.write is covered by these suites).
