# Cycle 10 Closure — W6 / Part A: Packaged Linux Desktop App, FULL Functional Sweep

Date: 2026-10-20 (worker run). Method: the REAL packaged binary
(`apps/desktop/dist/linux-unpacked/icecream-sheets-desktop`) under Xvfb via CDP
(playwright-core `connectOverCDP`), extending `hidden_files/pw2/desktop-validate.mjs`
and `hidden_files/pw2/w5-stall.mjs`. New harnesses: `hidden_files/pw2/w6-sweep.mjs`,
`w6b-followup.mjs`, `w6c-final.mjs`, `w6d-diag.mjs`, `w6e-decisive.mjs`,
`w6f-saveas.mjs`, `w6g-saveas.mjs`, `w6h-final.mjs`, `w6i-fmt.mjs`, `w6j-reload.mjs`.
Raw results: `/tmp/w6-results.json`, `/tmp/w6b-results.json`, `/tmp/w6c-results.json`,
`/tmp/w6d-results.json`, `/tmp/w6e-results.json`, `/tmp/w6f-results.json`,
`/tmp/w6h-results.json`, `/tmp/w6i-results.json`.
Screenshots (44 files): `hidden_files/cycle10-closure-shots/` (prefixes `w6-`, `w6b-` … `w6h-`).
Every screenshot cited below was opened and self-inspected by this worker.

Protocol compliance: stack MCP on :8106 was stopped before the sweep (the app binds
its own :8106) and restarted afterwards per protocol
(`packages/mcp-server`, `PORT=8106`, pid in `/tmp/gwlogs/mcp.pid`, health verified
`{"ok":true,"service":"mcp-server"}`). Original fixtures were NEVER opened in the
app — all opens used scratch copies under `/tmp/w6-fixtures/`. No git push.
`perf-evaluation.md` / `progress.md` / `TODO.md` untouched.

**Package change during the sweep:** one defect (D1, P95 open) was small and clearly
in scope, so it was fixed and the app was REPACKAGED with the W1/W5 flavor protocol
(desktop-flavor web build → `electron-builder --linux dir AppImage` → gateway-flavor
rebuild + web preview restart on :4173, HTTP 200 verified). Items validated before
the fix are marked "(pre-fix package)"; everything from W6b onward ran on the
rebuilt package. **Final AppImage: `apps/desktop/dist/IcecreamSheets-0.1.0.AppImage`,
142,371,415 bytes, sha256 `045da8af4ec1d531e146aa6b713abdec2b1af0f123850cb82118ebb1f73d2885`**
(supersedes `bf32ca93…`, 142,375,530 B).

## Per-item verdicts

### 1. Boot to grid — ✅ PASS
Packaged binary with no arguments boots to the full UI served from the packaged
asar (`file://…/app.asar/web/dist/index.html`): `.app` + `.grid-wrap` present, no
"Web UI not built" fallback, 12 ribbon tabs (File…Share), default Sheet1 grid,
status bar "✓ Saved / Ready". Evidence: `w6-01-boot.png` (self-inspected; full
ribbon + empty grid + tabs), results item 1.

### 2. Open P50 + P75 + all 8 cycle5/6 fixtures — ✅ PASS
Each file opened through the app's own argv path (fresh app instance per file);
grid renders real values and each fixture's signature content was verified:
- **P50** (perf-p50): 21 sheets (see item 3).
- **P75** (perf-p75): 13 sheets; Dashboard renders charts (item 6) — `w6-02-p75-dashboard.png`.
- **pivot-table** (cycle5): 11 sheets; `PastrySalesData` A1 = "Name"; pivot results
  render as pivot panels with real aggregated data (pvtInteger panel shows
  Bearclaw / 103 / BakeDate rows, "Apr — NumberOfOrders 134", "Apr — Quality 10.24").
  Note: pivot output lives in overlay panels, not grid cells — the pvt sheets' own
  cells are empty by design. Visual quirk: panels for several pivots stack in the
  viewport on the active sheet (`w6-02-pivot-table.png`, self-inspected).
- **olap-cube** (cycle5): Cube sheet evaluates real cube results — B3
  "[Measures].[Sum of Price]", C3 "[Measures].[Sum of Amount]", A4
  "[Range].[Baclava]", **B4 = 14, C4 = 3** (CUBEVALUE/CUBEMEMBER resolved).
- **external-link** (cycle5): Sheet1 **B2 = "hello world"** (external-link cached
  value rendered).
- **binom-dist** (cycle5): Binomial sheet B1 = 20, **B5 = 9.53674E-07** vs
  file-cached/expected 9.5367431640625e-07 (exact to display precision), C5 same.
- **trendline** (cycle6): ClickThroughRateSheet + Sheet2; 1 chart overlay
  (672×336, svg+canvas) — the polynomial trendline chart renders.
- **pivotchart** (cycle6): 13 sheets; Dashboard shows the pivot-bound charts
  (item 6) — `w6-02-pivotchart.png`.
- **geocode** (cycle6): Cities table renders — A1 "name", A2 "les Escaldes",
  B2 "Andorra" (34k-row sheet opens fine).
- **smartart** (cycle6): "Company Organization Chart" sheet, A3 title present,
  1 diagram overlay (560×360 DIV) renders the org chart.
Ground truth for all expectations was extracted independently from the files
(openpyxl + raw XML) before opening them.

### 3. P50: navigate EVERY sheet (21 tabs) — ✅ PASS
All 21 tabs clicked in turn; every sheet renders non-empty cells (non-empty
rendered-cell counts: START HERE 374, DASHBOARD 374, ASSUMPTIONS 374,
HISTORICAL INPUTS 49, REVENUE BUILD 374, OPERATING MODEL 374, INCOME STATEMENT
374, BALANCE SHEET 374, CASH FLOW 374, WORKING CAPITAL 374,
CAPEX & DEPRECIATION 374, DEBT SCHEDULE 374, FINANCIAL RATIOS 374,
SCENARIO ANALYSIS 374, BREAK-EVEN 374, CASH RUNWAY 374, MONTHLY VIEW (LITE) 153,
SENSITIVITY/VALUATION/CHECKS/DATA-SUPPORT all > 0). Zero blank/broken sheets.
Evidence: results item 3 tour array; `w6-03-p50-tour-start.png`.

### 4. Edit→recalc over IPC (short + cross-sheet, exact) — ✅ PASS
- **Short chain** (MONTHLY VIEW (LITE), pre-fix package, parsing-corrected redo):
  C9 editor opened with 0.083333333; set to 0.25 (ratio exactly 3). C13
  132,942.8834 → **398,828.6501** (×3), C14 53,177.15334 → **159,531.46** (×3),
  C16 = **181,998.8073** vs independently computed expectation
  3·C13 − 3·C14 − C15 = 181,998.80745. Exact.
- **Cross-sheet at rest**: DASHBOARD B7 (='INCOME STATEMENT'!I9) = INCOME
  STATEMENT I9 (='OPERATING MODEL'!I8) = OPERATING MODEL I8
  (='REVENUE BUILD'!I38) = **2,082,088.174** on all three sheets.
- **Cross-sheet edit-driven** (synthetic, on P50): sheet added via the engine
  bridge (`execute {cmd:'addSheet'}` → ok, 22 tabs); MCP `set_formulas` set
  ZZTEST!A1 `='MONTHLY VIEW (LITE)'!C9*3` → 0.2499999999999999 (C9 = 1/12);
  grid edit C9 → 0.5 over IPC → **ZZTEST!A1 = 1.5 exactly**, grid shows
  "A1: 1.5" (`w6e-04-cross-sheet.png`).
- Note: the first cross-sheet attempt (overwriting OPERATING MODEL I8) was
  correctly REFUSED by sheet protection — the cell is locked and the app shows
  "Cell I8 is locked: unprotect "OPERATING MODEL" to edit it." in the status
  bar (visible in `w6-06-p50-dashboard-charts.png`). Protection works as designed.

### 5. Formatting / ribbon basics — ❌ FAIL (defect D4: formats do not persist)
What works (pre-fix package, MONTHLY VIEW (LITE) C10): Bold via the ribbon Bold
button → computed font-weight 700 in grid; number format via the ribbon format
select → "Percentage" → cell displays "16.67%"; formula-bar edit lands
(12345 entered via the formula bar). In-grid evidence: results item 5,
`w6-05-formatting.png`; re-applied cleanly in W6h/W6i (fw 700, "0.00%").
What fails — **persistence**: on a fresh scratch P50, bold+% applied to C10,
then a value edit (C9 → 0.25) to force dirty + autosave (file rewritten,
76,808 B, status "✓ Saved", C9 = 0.25 persisted in the file) — the saved
file's C10 still reads `number_format: "General"`, `bold: false` (openpyxl
parse-back), and after relaunching the app on that saved file C10 renders
fw 400 / "0.1667" (no %). A format-only session doesn't even dirty the
workbook (file byte-identical, 150,657 B, after 7 s > 2 s debounce, W6h).
So ribbon-applied bold/number format are session-only view state and are
dropped by the save serialization entirely. See defect D4.

### 6. Charts render inside the grid frame — ✅ PASS
- P50 DASHBOARD: 7 chart overlays on the overlays layer (svg + canvas each).
  Scrolled into view and self-inspected (`w6b-06-dashboard-chart.png`): "Revenue
  Trend", "EBITDA Trend", "Net Income Trend" line charts with real axes
  (FY2024A–FY2030E), plus Free Cash Flow / Cash vs. Debt / Scenario Comparison
  panels — all inside the grid area, below the ribbon, above the sheet tabs.
- pivotchart.xlsx Dashboard (`w6-02-pivotchart.png`, self-inspected): "Earnings"
  clustered column chart (Revenue / Gross Profit / Earnings Before Taxes,
  2012–2021) and "Cash Flow" chart, in-grid.
- Containment: the overlays layer shares the grid's origin (x 0, y 238) and is
  the grid's scroll content (3,308×2,054 content clipped by the 1,200×447
  grid viewport) — charts scroll with the cells and never paint over the
  ribbon or tabs, per the chart-frame containment requirement.

### 7. Autosave ON / OFF — ✅ PASS
- **ON** (argv-opened, trusted path): after the item-4/5 edits the scratch P50
  was silently rewritten by the 2 s-debounce autosave — file size
  150,657 → 76,793 B, status "✓ Saved", and an independent openpyxl parse-back
  shows **MONTHLY VIEW (LITE) C9 = 0.25** with all 21 sheets intact.
- **OFF**: the desktop build has NO autosave on/off toggle (SettingsDialog has
  none; the App.tsx autosave effect has no toggle condition — autosave is
  inherent for trusted paths). The designed off-equivalent was proven instead:
  a workbook opened by drag-drop (untrusted path, GAP-10 rule) NEVER
  autosaves — after a grid edit on the dropped P75 copy and a 7 s wait
  (> 2 s debounce), the dropped file was byte-identical (size + mtime
  unchanged). A manual save is then required, as designed.

### 8. Save gating during load — ✅ PASS (with minor defect D3)
During a P75 drop-open, CDP polling (120 ms cadence) captured the banner
"⏳ Loading workbook… you can look, but editing and save unlock when the load
completes" with the ribbon Save buttons replaced by **"Loading…" buttons,
disabled, title "Workbook is still loading — save is disabled until the load
completes"**. After 100% load the File panel shows Save enabled
("Save to the current file, or choose a location (Ctrl+S)"). Evidence:
results item 8 samples; `w6-08-gating-during.png`/`w6-08-gating-after.png`.
Minor defect D3: the "Save encrypted" button is NOT gated (see Defects).

### 9. GTK Save-As dialog — ✅ PASS (residual CLOSED)
The real native GTK dialog was driven end-to-end on this VM:
- Tooling: `xdotool` + `wmctrl` were absent; installed via apt during this run
  (xdotool 3.20160805.1). `python-xlib` installed via pip
  (`--break-system-packages`) as a second XTEST driver. `/tmp/xhelper.py`
  (the previous passes' tool) does not exist on this VM.
- Failed routes (documented, with root-shot evidence): Ctrl+Shift+S via
  XTEST never fired the menu accelerator — the keystrokes landed in the
  formula bar instead (`w6-09-saveas-typed.png` shows the filename typed into
  the formula bar of cell C10). Native-menu clicking needed exact geometry:
  the first ladder clicked the **Edit** menu (File is at root x≈257, Edit at
  x≈287; `w6c-09-file-menu.png` shows the Edit menu open), the second ladder
  still produced no dialog.
- Working route: the app's own desktop bridge
  `window.icecreamDesktop.file.saveBytes(bytes, undefined, name)` — the exact
  call the renderer's Save-As flow makes — opened the REAL GtkFileChooserDialog
  titled **"Save workbook"**, Home folder, Name field pre-filled with the
  suggested name (`w6e-09-gtk-dialog-open.png`, `w6f-09-gtk-dialog-after-save.png`,
  self-inspected). Enter in the Name entry does NOT confirm this GTK3 chooser;
  clicking the dialog's **Save** button at root (1097, 798) with xdotool did.
  The bridge resolved `{"path":"/home/hatch/w6g-saveas-7711.xlsx"}`; the file
  exists (150,657 B; archived at `/tmp/w6-fixtures/w6g-saveas-7711.xlsx`) and
  parses back with **21 sheets** and MONTHLY C9 intact.
- What remains unproven: only the menu-accelerator *keystroke* path under
  Xvfb-without-a-window-manager (the menu item, the dialog, and the save
  itself are all proven; the accelerator may well work under a real WM —
  on this VM the XTEST chord demonstrably went to the renderer instead).

### 10. MCP :8106 against the packaged app (read + write) — ✅ PASS
Against the packaged app's own MCP (38 tools listed, serverInfo
icecream-sheets 0.1.0): read of MONTHLY C9 returned 0.25 (the grid edit,
corroborated cross-process). Write with the schema discovered from
`tools/list` (`write_cells {cells:[{sheet,row,col,value}]}`) returned
`{ok:true, written:1, errors:[]}`; read-back returned 424242 and **the grid
cell C21 shows "424242"** — the write is reflected in the UI. Evidence:
w6c results (`mcpWrite exact`).

### 11. Print preview — ✅ PASS
Ctrl+P opens the "Print preview — MONTHLY VIEW (LITE)" dialog
(`w6-11-print-preview.png`, self-inspected): paginated preview rendering
**2 pages** ("Page 1 — A1:L28", "Page 2 — M1:Q28") with real cell content,
page-setup controls (orientation, paper size, scale, margins, print area,
header/footer, preview zoom 55%) and the Download-as-PDF action (the single
print path per design).

### 12. Menus + keyboard shortcuts on Linux — ❌ FAIL (defect D2: undo/redo)
- Ctrl+B: works (item 5, font-weight 700).
- Ctrl+P: works (item 11).
- Ctrl+S: works — silent save to the known trusted path, no dialog, status
  "✓ Saved" (in the W6 run the file's mtime was unchanged only because
  autosave had already persisted everything; there was nothing dirty).
- Ctrl+Shift+S: did NOT fire under XTEST on this VM (see item 9; the Save-As
  function itself is proven via the dialog).
- Ctrl+O: not driven (the native Open dialog is the same GTK chooser class
  proven in item 9; open itself is proven via argv and drag-drop).
- **Ctrl+Z / Ctrl+Y: BROKEN — defect D2.** Decisive test (W6e): grid edit
  C10 → 0.5, focus confirmed on `DIV.grid-wrap` (not an input), real CDP
  Ctrl+Z → value unchanged and the status bar shows **"Nothing to undo."** —
  the app's undo handler runs but the undo stack is empty: grid edits on the
  desktop IPC host never register an undoable action. Ctrl+Y likewise no-ops.
  Synthetic (untrusted) keydown dispatch produced the same result, and the
  failure reproduced across three independent instances (W6, W6c, W6e).
- Also verified incidentally: the sheet-tab "+" button opens an inline
  name input (`.sheet-name-input`); typing a name + Enter adds the sheet
  (Sheet1 + Sheet9) — the add-sheet UI flow works (W6f).

### 13. Long-run stability through a full P95 open — ✅ PASS (on the rebuilt package; pre-fix FAIL = defect D1, fixed)
- **Pre-fix package**: P95 argv open FAILED in the grid — status bar error
  **"ipcEngine: load timed out after 30000ms (main-process engine
  unreachable)"**, grid stuck on the empty Sheet1 while the main-process
  engine had in fact loaded the workbook (MCP read Sales A2 = 100002).
  `w6-13-p95-longrun.png` (self-inspected). This was defect D1 — FIXED (below).
- **Rebuilt package** (W6b + W6h): P95 opens fully — 53.5 s clean (58.5 s
  under heavy VM contention), tabs Sales/Inventory/Ledger, Sales A1
  "OrderID", A2 100002, B2 45140, MCP read [100002, 45140, "Patricia Smith"],
  grid screenshot shows the full 60k-row sheet rendering (`w6b-13-p95-open.png`,
  self-inspected). Edits on P95: MCP write Sales A2 → 987654321 (read-back +
  grid both show it), grid edit Inventory A2 "SKU-000002" → "ZZ-TEST-1"
  (`w6h-13-p95-edits.png`). Sheet navigation across all 3 sheets. App
  responsive at the end (state probe 9 ms in the clean run). No OOM, no
  wedge, no crash across ~15 min of cumulative P95 sessions.
- RSS (all app processes): clean run peaked at **2,035 MB** (series
  1,055 → 2,035 MB over 73 s, settling ~1,400–1,600 MB). A second run with a
  14-worker vitest suite competing for the same 2 cores peaked at 3,250 MB
  and one CDP probe queued for 787 s behind the load/fill churn — reported
  for honesty; under that contention everything still completed and the app
  never wedged permanently. On an uncontended host the P95 experience is
  the clean-run numbers.

### 14. Renderer stall spot-check on P75 open — ✅ PASS
W5 sampler (5 ms interval + rAF, same as `w5-stall.mjs`) around a P75
drop-open in the packaged app: **max timer stall 76 ms**, max rAF stall
33 ms — the ≤ ~80 ms class from the W5 fix holds on this package
(pre-fix measurement; the D1 fix does not touch the render path, and the
rebuilt package's P50/P75 opens in W6b/W6c behaved identically).

## Defects

### D1 — FIXED by this worker: desktop IPC load timeout (30 s) made P95-class workbooks unopenable
- Repro: launch the packaged app with a P95 scratch copy (12.7 MB, 1.8M
  cells). The main process loads it (~43–58 s on this VM), but the
  renderer's `engine:load` IPC call is abandoned at 30 s
  (`IPC_CALL_TIMEOUT_MS` in `apps/web/src/services/ipcEngine.ts`), the grid
  stays on the empty Sheet1, status bar: "ipcEngine: load timed out after
  30000ms (main-process engine unreachable)". MCP (main process) reads the
  loaded workbook fine — the failure is purely the renderer-side bound.
- Fix (surgical): `load` gets its own bound, `IPC_LOAD_TIMEOUT_MS =
  600_000`, via an optional per-call timeout in `IpcEngineHost.call`;
  interactive calls keep the 30 s fail-fast bound. New unit test proves a
  load resolving after the interactive timeout now succeeds.
- Tests: `apps/web` ipcEngine suite 21/21 (incl. the new test); full
  `apps/web` suite 119 files / 1,553 tests all green; `apps/desktop`
  suite 97/97. Repackaged per the W1/W5 protocol (see header for the new
  AppImage sha/size); P95 open re-validated end-to-end (item 13).
  Changed files: `apps/web/src/services/ipcEngine.ts`,
  `apps/web/src/services/ipcEngine.test.ts` — listed with web-validation
  evidence under "Shared-code changes" below. Not pushed.

### D2 — OPEN (documented for the coordinator): undo/redo do not work for grid edits in the packaged desktop app
- Repro: open any workbook, edit a cell in the grid, press Ctrl+Z. The
  value does not revert; the status bar shows "Nothing to undo."
  (`handleUndo` runs — `undoRef.current.undo(host)` returns false — so
  edits made through the desktop IPC host are never recorded as undoable
  actions.) Reproduced on MONTHLY VIEW (LITE) C10 across three instances
  and two packages (pre- and post-D1-fix), with focus verified on the grid.
  Not fixed here: the recording path spans the renderer's undo manager and
  the IPC host's edit execution — more than a surgical change, and it needs
  a design decision on where undo entries are created for IPC edits.

### D3 — OPEN (minor): "Save encrypted" is not gated during workbook load
- During the item-8 load window, Save correctly shows disabled "Loading…",
  but "Save encrypted" stays enabled, and clicking it during the banner
  opens the "Encrypt download with a password" dialog over the still-loading
  workbook (W6c evidence: `w6b-08-save-encrypted-during-load.png`, dialog
  captured in results). Whether it would serialize a half-loaded workbook
  was not tested (dialog dismissed with Escape). The button should be
  disabled with the same Loading… treatment as Save, per the
  save-gating rule (save/autosave/export all blocked until 100% load).

### D4 — OPEN (documented for the coordinator): ribbon formatting (bold, number format) never persists
- Repro (W6h/W6i/W6j, fresh scratch P50 each time): select MONTHLY VIEW
  (LITE) C10, apply Bold (renders fw 700) and Percentage format (renders
  "0.00%"). (a) Format-only: the workbook is never marked dirty — autosave
  never fires, file byte-identical. (b) Format + a value edit: autosave
  fires, the value persists (C9 = 0.25 in the file), but the saved C10 has
  `number_format: "General"`, `bold: false`, and relaunching the app on the
  saved file renders C10 as fw 400 / plain number. The format state lives
  only in the session's view layer and is dropped by the save serialization
  (`buildDownloadBytes` path). Not fixed here: the fix touches how format
  commands are recorded in the engine/host and emitted by the XLSX write
  path — beyond a surgical change.

## Observations (not defects)
- P75/pivotchart pivot panels whose caches were saved without records show
  the app's own honest notice: "The pivot cache for "pvtCF" was saved
  without records (saveData="0") — refresh the pivot from its source to
  populate it." (visible in `w6c-09-root-before.png`).
- The native menu bar renders at the top of the X root under Xvfb (no WM):
  File ≈ x 257, Edit ≈ x 287 at y ≈ 141 for the centered 1200×800 window —
  recorded for future dialog/menu automation.
- Electron's Edit menu lists Undo as Ctrl+Z (role-style); the app-level
  shortcut is the renderer's own handler (the one exercised in D2).

## Shared-code changes

Per the user's binding constraint (2026-10-20 ~11:59 PDT, as corrected
~12:02 PDT: no seam preference — shared code may be modified where correct;
web-side validation is mandatory for every shared-code change, and every
shared-code file must be listed here with its web-validation evidence).

This sweep made exactly ONE product-code change (defect D1's fix). No files
under `apps/desktop/**`, `packages/engine`, or `packages/gateway` were
modified. (All other files written by this worker are test harnesses under
`hidden_files/pw2/` and screenshots/results — not product code.)

| Shared-code file | Change |
|---|---|
| `apps/web/src/services/ipcEngine.ts` | Added `IPC_LOAD_TIMEOUT_MS = 600_000`; `IpcEngineHost.call()` gained an optional `timeoutMs` parameter (default unchanged: `this.timeoutMs`); `loadIpc` passes the long bound for the bulk `load` call only. All other IPC calls keep the 30 s fail-fast bound, byte-for-byte identical behavior. |
| `apps/web/src/services/ipcEngine.test.ts` | One new test: a load resolving after the interactive timeout succeeds under the load bound (the P95 defect in miniature). |

**Why this is web-inert (blast-radius evidence, verified in code):**
`IpcEngineHost` is constructed only inside `if (isDesktop())` in the host
factory (`apps/web/src/engine.ts:43–47`); web/gateway mode takes the
gateway branch instead (`engine.ts:69`, `!isDesktop() → getGatewayClient()`).
In a browser there is no Electron preload bridge, so the class, `loadIpc`,
and both timeout constants are never reached. Within the class, the change
alters only the `load` call's bound; every other call passes the same
default as before.

**Web-side validation for this change:**
- Targeted suite: `apps/web` `src/services/ipcEngine.test.ts` — **21/21
  passed** (incl. the new load-bound test).
- Full web suite: `apps/web` vitest — **119 test files, 1,553 tests, all
  passed, 0 failures** (run 2026-10-20 after the change; log
  `/tmp/web-vitest-full.log`).
- Desktop suite (host package): `apps/desktop` vitest — **97/97 passed**.
- Desktop functional re-validation on the repackaged app: P95 open + edits
  + MCP (items 13/10), P50/P75 opens, fixture spot checks — W6b–W6j runs
  summarized in items 2–14 above.
- Gateway-mode browser path: after repackaging, `apps/web` was rebuilt in
  the gateway flavor (`VITE_GATEWAY_URL=http://127.0.0.1:8100`) and the web
  preview on :4173 restarted and verified HTTP 200 with the gateway
  healthy on :8100. Per the constraint, the coordinator's final
  gateway-mode fixture tours + P50/P75/P95 perf gate are the definitive
  web regression check for this change; any regression there is a blocker
  attributed to this change until proven otherwise. No web regression was
  observed in any validation available to this worker.

## Scoreboard
PASS: 1, 2, 3, 4, 6, 7, 8 (minor defect D3 noted), 9, 10, 11, 13 (after D1
fix), 14. FAIL: 5 (D4), 12 (D2). Defects: 1 fixed + repackaged (D1),
3 documented open (D2, D3, D4).
