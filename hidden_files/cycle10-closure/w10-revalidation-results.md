# Cycle 10 Closure — W10: Rebuild + Repackage + Revalidation of W6-D1 / W8 / W9 Fixes

Date: 2026-10-20 (revalidation worker run). Scope: rebuild everything from
current source, fix the stack starter (addons), repackage the desktop app
(W1/W5 flavor protocol), and re-validate the fixed sweep items on the REAL
packaged app + the real gateway browser flow. No git push.
`perf-evaluation.md` / `progress.md` / `TODO.md` untouched. Original
fixtures were NEVER opened by the app — all desktop work used scratch
copies under `/tmp/w10-fixtures/` (originals verified untouched at the
end: sizes/mtimes unchanged, perf-p50 still 150,657 B, 2026-10-19 mtime).

Harnesses: `hidden_files/pw2/w10-revalidate.mjs` (R1/R2/R3/R5/R6 first
pass), `w10-r4c.mjs` (R4 + R1b settle-poll + R5 re-measure, per-phase
result writes), `w10-r1-diag.mjs` (R1b disambiguation), `w10-r2-formula.mjs`
+ `w10-r2-poll.mjs` + `w10-r2-scroll.mjs` (R2 formula leg), `w10-r7.mjs`
(R7 browser). Raw JSON: `/tmp/w10-results-c.json`, `/tmp/w10-r1-diag.json`,
`/tmp/w10-r2f.json`, `/tmp/w10-r7-results.json`. Screenshots:
`hidden_files/cycle10-closure-shots/w10-*.png`, each cited below was
opened and self-inspected by this worker.

**Ground-truth correction that affects two verdicts:** MONTHLY VIEW
(LITE) C10 in perf-p50 is a check cell, `=ROUND(SUM(C9:N9)-1,4)`, whose
true value is **0** (file cached value 0, openpyxl-verified). The
"0.1667 / 16.67%" figure in the W6 sweep and W9 repro was from a
synthetic unit repro, not this file. Correct expectations used here:
C10 renders "0.00%" when percentage-formatted; C9 = 0.083333…;
C13 = `=C9*'OPERATING MODEL'!$E$8` = 132,942.88335317458.

## STEP 1 — Rebuild + stack: ✅ PASS

- tsc builds from source, all clean (exit 0): `packages/engine`,
  `packages/xlsx-adapter`, `packages/csv-adapter`, `packages/ods-adapter`,
  `packages/xlsb-adapter`, `packages/service`, `packages/gateway`,
  `packages/mcp-server`.
- Stack starter fixed: `hidden_files/start-stack-finisher.sh` gained
  `start addons $GW dist/bin/addons.js 8107 ""` (same `start()` pattern)
  and 8107 in its health loop. (The gateway binary already routed
  `/api/addons` → :8107; only the service was never started by the
  script.)
- Stack restarted with the updated script (old processes killed first —
  note the `/tmp/gwlogs/*.pid` files hold wrapper pids, not the node
  pids; the real node pids were killed directly). Health, all HTTP 200:

  | Port | Service | Check |
  |---|---|---|
  | 8100 | gateway | `/health` routes = `["/api/engine","/api/vault","/api/meta","/api/etl","/api/agent","/api/addons"]` — **/api/addons present** |
  | 8101 | engine | 200; cmdline verified: `node --max-old-space-size=6144 dist/bin/engine.js` |
  | 8102 | vault | 200 |
  | 8103 | meta | 200 |
  | 8104 | etl | 200 |
  | 8105 | agent | 200 |
  | 8106 | mcp | 200 `{"ok":true,"service":"mcp-server"}` |
  | 8107 | addons | 200 (newly started by the fixed script) |
  | 4173 | web preview | 200 |

- `GET /api/addons/catalog` **via the gateway** as test user
  (`POST /auth/login {"userId":"e2e-user"}` per e2e-gateway.sh):
  **200**, body lists add-on listings (first: `com.icecream.sample-sum-reporter`).
  The Cycle 10 "add-ons catalog 404 in gateway mode" follow-up is closed
  by the combination of the gateway route (already in source) + the
  starter now actually running the service.

## STEP 2 — Repackage: ✅ PASS

Flavor protocol followed in order: desktop-flavor web build
(`env -u VITE_GATEWAY_URL -u VITE_MCP_URL npm run build` in apps/web) →
`apps/desktop npm run build` → old `linux-unpacked` + AppImage deleted →
`npx electron-builder --linux dir AppImage` → gateway-flavor rebuild
(`VITE_GATEWAY_URL=http://127.0.0.1:8100`) → web preview restarted on
:4173 (pid in `/tmp/gwlogs/web.pid`), HTTP 200, serving the new bundle
(`assets/index-CJhg1rli.js`).

- **New AppImage: `apps/desktop/dist/IcecreamSheets-0.1.0.AppImage`**
- **Size: 142,396,320 bytes** (previous W6 package: 142,371,415 B)
- **sha256: `42f1f92961cb6345583507cceefe77991bff3e509f98d5a4f0a3652117a2c34c`**
  (supersedes W6's `045da8af…`)

## STEP 3 — Re-validation on the packaged app

Protocol: stack MCP :8106 stopped before desktop work (the app binds
its own), restarted afterwards and health-verified; stack left fully
running at the end (all 9 ports 200).

### R6 (sanity) — ✅ PASS
Boot/argv-open of scratch P50: **21 tabs**, load ~3.7 s; START HERE shows
real content ("ULTIMATE SaaS 3-STATEMENT FINANCIAL MODEL"). App MCP
:8106 healthy (`icecream-sheets` MCP server); MCP read MONTHLY C9 =
0.0833333333333333; MCP `write_cells` C21 = 424242 → `{ok:true,written:1}`
and the **grid shows 424242** (`w10-r6-p50-mcp-write.png`, also visible
in `w10-r1-formatted.png`).

### R1 (sweep item 5 / D4) — (a) ✅ PASS, (b) ❌ FAIL
(a) **Format-only persistence — FIXED.** Fresh scratch P50 → MONTHLY
C10 → ribbon Bold + Percentage. In-grid: font-weight 700, text "0.00%"
(correct for C10 = 0), Bold button active — `w10-r1-formatted.png`
(self-inspected). With NO value edit, the workbook went dirty and
autosave rewrote the file: 150,657 → 76,857 B, status "✓ Saved".
openpyxl parse-back of the saved file: **C10 number_format "0.00%",
bold true** (value `=ROUND(SUM(C9:N9)-1,4)` intact). Both halves of the
original D4 evidence are closed at the save level.

(b) **Relaunch rendering — FAIL, two distinct failure modes:**
1. **The saved format does not render on relaunch.** Relaunching the
   packaged app on the autosaved file and settle-polling MONTHLY C10
   (reads stable across consecutive 1 s polls — not a race): font-weight
   **400**, text **"0"** (after a recalc-triggering edit: "0.1667",
   still fw 400, no %). The file verifiably carries bold + "0.00%"
   (see (a)), so the desktop-open style seeding (W9's
   `summarizeSheet` → IPC summary → renderer FormatStore path, unit-
   proven in `apps/desktop/tests/engine-load.test.ts`) is **not
   effective end-to-end in the packaged app**. Evidence:
   `w10-r1-relaunch.png`, `w10-r1-relaunch2.png`, `/tmp/w10-r1-diag.json`.
2. **The autosave drops every defined name, poisoning the relaunched
   workbook with #NAME?.** Formula diff original vs autosaved file
   (2,403 formula cells compared): sheet list identical, formulas
   identical except 6 cells where named refs were rewritten to direct
   refs (`NewEquityY1` → `ASSUMPTIONS!$C$62`, `NewBorrowingY1` →
   `ASSUMPTIONS!$C$55`). But the saved file contains **0 defined names
   (original: 38)** while **21 formulas still reference
   `DividendsPctNI`**. On relaunch the **main-process engine itself**
   holds the error — MCP read MONTHLY C13 = `{"error":"#NAME?"}`,
   'OPERATING MODEL' E8 = `{"error":"#NAME?"}` — and a C9 edit recalcs
   C10 correctly (0 → 0.1667) while C13 stays #NAME?. The original file
   opens clean (R6/R2 instances render C13 = 132,942.88). This is a
   save-fidelity defect in the client-snapshot serialization (the same
   path desktop autosave uses), surfaced by this relaunch; it also
   matches the known "named-range saves" residual from the perf pass,
   now proven to corrupt ordinary desktop saves of name-using
   workbooks, not just named-range downloads. Not fixed here (beyond
   trivial; escalated per instructions).

### R2 (sweep item 12 / D2) — ⚠️ PARTIAL: value leg ✅ PASS, formula leg ❌ FAIL (grid only)
- **Value cell (MONTHLY C10, 0 → 0.5):** grid 0 → 0.5, MCP read-back
  0.5. **Ctrl+Z → grid 0, MCP 0**, no "Nothing to undo." **Ctrl+Y →
  grid 0.5, MCP 0.5**, no "Nothing to redo." The D2 symptom is gone.
  (`w10-r2-undo-redo.png`, self-inspected: C10 = 0.5 after redo.)
- **Formula cell (MONTHLY C13 := `=C9*100`):** engine side perfect —
  MCP: 132942.88335317458 → **8.33333333333333** after edit → Ctrl+Z →
  132942.88335317458 → Ctrl+Y → 8.33333333333333. **But the GRID never
  re-renders the edited formula cell:** #cell-12-2 keeps displaying
  132,942.8834 through 15 s polls after the edit and after the redo,
  after scroll-away-and-back, and after a sheet round-trip
  (`w10-r2-formula-grid.png`, self-inspected). Literal-value edits
  display instantly (above), and precedent edits updated dependents'
  displays in W6 — the staleness is specific to a cell whose own
  formula was edited (formula→formula), i.e. a renderer value-cache
  fill for the edited cell never lands. Suspect interaction with W8's
  new per-cell mutation-epoch guard in `apps/web/src/services/ipcEngine.ts`
  (stale fills are now dropped; the post-edit fill for the edited cell
  may be dropped with them or never re-issued). New defect — reported,
  not fixed (beyond trivial).

### R3 (sweep item 8 / D3) — ✅ PASS
P75 drop-open in the packaged app, File tab open, 120 ms DOM sampling
of the load window: **4 ribbon buttons carried the "Loading…" treatment
(label "Loading…", "still loading" title), ALL disabled, and no enabled
"Save encrypted" button existed** during the window. After 100% load:
"Save encrypted" present, `disabled=false`, normal title ("Download
the workbook encrypted with a password (face b)"). The one
during-window screenshot (`w10-r3-loading.png`) raced the fast load
and shows the just-loaded state; the verdict rests on the DOM samples
(the same evidence class as W8's browser D3 check, which passed
identically). After-load state: `w10-r3-after-load.png`.

### R4 (D1 spot-check, P95 argv open) — ✅ PASS
Fresh packaged instance, argv open of scratch perf-p95: completes in
the grid — **3 tabs (Sales/Inventory/Ledger), no "timed out" error
anywhere, status "✓ Saved / Ready"**. MCP read Sales A2 = 100002,
grid Sales A2 = "100002". Grid edit Inventory A2 "SKU-000002" →
"ZZ-W10-1": grid shows it and MCP read-back returns `"ZZ-W10-1"`.
`w10-r4-p95.png` + `w10-r4-p95b.png` (self-inspected: Inventory A2 =
ZZ-W10-1, full sheet rendering). (Process note: the first run's
harness CDP connect timed out under the P95 load and orphaned the
instance; R4 was then completed against that very instance and again
end-to-end on a fresh spawn in `w10-r4c.mjs` — both agree.)

### R5 (stall spot-check, P75 open) — ❌ FAIL vs the ≤ ~80 ms class
W5 sampler (5 ms interval + rAF) around a P75 drop-open, measured
**twice independently: max timer stall 130 ms both times** (max rAF
stall 67 ms / 83 ms). The W6 packaged baseline was 76 ms. 130 ms is
reproducible on this package, not a one-off flake, and is above the
~80 ms class the task asked to confirm. Not attributable from here:
candidates are the W8/W9 renderer changes (ipcEngine epochs / format
seeding work during load) or contention on this 2-core VM (full stack
resident). Reported as measured; needs a profiling pass to attribute.

### R7 (gateway-mode format save, real browser flow) — ✅ PASS
Gateway stack + real Chrome at :4173, test user `e2e-tester`: P50
drop-open loads (21 tabs), MONTHLY C10 → Bold + Percentage via the
ribbon (in-grid fw 700, "0.00%" — `w10-r7-formatted.png`,
self-inspected; formula bar shows the real C10 formula). Download via
File → "Save .xlsx" → Download dialog → Download: the browser issued
**`POST http://127.0.0.1:8100/api/engine/download`** (server path,
observed on the wire). openpyxl parse-back of the downloaded
`workbook.xlsx`: **C10 number_format "0.00%", bold true**, 21 sheets.
W9's service-level proof now holds through the real browser flow.

## STEP 4 — Suites on final source: ✅ all green

`vitest run` per package (full suites, after all fixes + rebuilds):

| Package | Files | Tests | Result |
|---|---|---|---|
| packages/engine | 42 | **980 passed** | ✅ (matches W9) |
| packages/xlsx-adapter | 30 | **233 passed** | ✅ (matches W9) |
| packages/gateway | 13 | **131 passed** | ✅ (matches W9) |
| apps/web | 121 | **1,570 passed** | ✅ (matches W9) |
| apps/desktop | 14 | **98 passed** | ✅ (matches W9) |

Zero failures. (service / csv / ods / xlsb / mcp-server were rebuilt in
Step 1 but are outside the assigned suite list; their W9-era counts
were not re-run.)

## Scoreboard

| Item | Verdict |
|---|---|
| Step 1 rebuild + stack (+addons fix) | ✅ PASS |
| Step 2 repackage | ✅ PASS — AppImage 142,396,320 B, sha256 `42f1f92961cb6345583507cceefe77991bff3e509f98d5a4f0a3652117a2c34c` |
| R1(a) format-only dirty + autosave + parse-back | ✅ PASS (D4 save half closed) |
| R1(b) relaunch renders saved format | ❌ FAIL — format not seeded in packaged relaunch; **plus** autosave drops all 38 defined names → engine-level #NAME? on relaunch |
| R2 undo/redo | ⚠️ PARTIAL — value cell full PASS (grid + read-back); formula cell read-back PASS but **grid display of an edited formula cell never refreshes** |
| R3 encrypted-save gating | ✅ PASS (D3 closed) |
| R4 P95 argv open | ✅ PASS (D1 holds) |
| R5 P75 stall | ❌ FAIL — 130 ms max timer stall, reproduced ×2 (W6 baseline 76 ms) |
| R6 sanity | ✅ PASS |
| R7 gateway format save via browser | ✅ PASS (D4 gateway half closed end-to-end) |
| Step 4 suites | ✅ all green, counts identical to W8/W9 |

## Escalations for the coordinator (not fixed here, per instructions)

1. **Defined names dropped on save** (R1b-2): the client-snapshot
   serializer emits 0 defined names and only rewrites some named-ref
   formulas to direct refs (6 of 27+ usages); the rest dangle →
   #NAME? on any reopen, desktop autosave included. Highest severity
   of this pass: silent data corruption on save for name-using
   workbooks.
2. **Desktop-open style seeding ineffective in the packaged app**
   (R1b-1): saved bold/number-format is in the file and unit-proven
   through `buildWorkbookFromBytes`, but the packaged argv-open path
   does not render it. Needs tracing of summary → App.tsx
   reconstruction → `importedFormatsToStore` on the real path.
3. **Grid display staleness for formula→formula edits** (R2): engine
   and undo/redo are correct; the edited cell's display never
   refreshes. Prime suspect: W8's ipcEngine mutation-epoch fill guard.
4. **P75 open max timer stall regressed 76 ms → 130 ms** (R5):
   reproduce under profiling before attributing to W8/W9 changes vs
   VM contention.
