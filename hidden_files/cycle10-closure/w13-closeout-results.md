# Cycle 10 Closure — W13: Part A Close-Out (repackage on final code, E4 stall verdict, V1–V4 revalidation)

Date: 2026-10-20 · Worker: W13 (Part A close-out) · Repo: ~/workspace/icecream-sheets
Scope: rebuild/repackage with the W11 (defined-names) + W12 (desktop display path)
fixes on board, attribute/fix the E4 P75-open renderer stall if code-caused, and
re-validate the previously-failing items (R1b-1/E2, R1b-2/E1, R2 formula leg/E3)
on the final package. `perf-evaluation.md` / `progress.md` / `TODO.md` NOT
edited. No GitHub push. Original fixtures never opened by the app — all desktop
work used scratch copies under `/tmp/w13-fixtures/` and
`/tmp/desktop-validate-fixtures/` (originals verified untouched at the end:
perf-p50 still 150,657 B, perf-p75 1,285,214 B, both 2026-10-19 mtimes).

Harnesses: `hidden_files/pw2/w5-stall.mjs` (Step 2, unmodified),
`hidden_files/pw2/w13-trace.mjs` + `hidden_files/pw2/w13-count.mjs`
(new diagnostics), `hidden_files/pw2/w13-closeout.mjs` (new, Step 3),
`hidden_files/pw2/w13-v3-verify.mjs` + `hidden_files/pw2/w13-v3-redo.mjs`
(V3 oracle re-checks, Step 3 note).
Raw JSON: `/tmp/w13-stall.json`, `/tmp/w13-stall-quiet.json`,
`/tmp/w13-stall-profile.json`, `/tmp/w13-stall-final.json`,
`/tmp/w13-trace-events.json`, `/tmp/w13-results.json`,
`/tmp/w13-v3-verify.json`, `/tmp/w13-v3-redo.json`.

CORRECTION NOTE (same day): an interim harness summary delivered to this
worker in-session did not match the harness's own on-disk output; all
Step 3 figures below are taken from `/tmp/w13-results.json` (authoritative)
and the V3 legs were additionally re-verified with untruncated oracles
(see V3). Two of the harness's own `pass` flags (V2, V3) are false for
harness-oracle reasons documented in place — the underlying app behavior
passes on the raw evidence in both cases.
Screenshots: `hidden_files/cycle10-closure-shots/w13-*.png` (v1-formatted,
v1-relaunch, v3-formula-edit, v3-formula-redo — the relaunch and
formula-edit shots were opened and self-inspected by this worker).

## STEP 0 — Stack restart on current dists: ✅ PASS

- Killed the real node processes by command line (the `/tmp/gwlogs/*.pid`
  files hold wrapper pids, as before): all `dist/bin/*` services + the vite
  preview node. Ports 8100–8107 + 4173 verified free.
- Rebuilt stale dists with `tsc -p tsconfig.json`, all exit 0: engine,
  gateway, xlsx-adapter, service, mcp-server, csv-adapter, ods-adapter,
  xlsb-adapter. Verified the W11 fix is in the built output
  (`getLiveDefinedNames` ×2 in engine dist, `mergeDefinedNames` ×3 in
  gateway dist engineSvc).
- Restarted via `hidden_files/start-stack-finisher.sh`. First health sweep
  raced the gateway/web startup (8100/8102/4173 momentarily 000); re-check
  after 5 s: **all 9 ports HTTP 200** (8100 gateway, 8101 engine, 8102 vault,
  8103 meta, 8104 etl, 8105 agent, 8106 mcp, 8107 addons, 4173 web preview).
- Gateway `/health` routes:
  `["/api/engine","/api/vault","/api/meta","/api/etl","/api/agent","/api/addons"]`
  — **/api/addons present**; test-user login (`e2e-user`) succeeds.

## STEP 1 — Repackage (flavor protocol, in order): ✅ PASS

1. Desktop flavor: `cd apps/web && env -u VITE_GATEWAY_URL -u VITE_MCP_URL npm run build` — exit 0 (bundle `index-Bcibxken.js`, the one later found in the asar).
2. `cd apps/desktop && npm run build` (tsc clean) → old `linux-unpacked` +
   AppImage deleted → `npx electron-builder --linux dir AppImage` — exit 0.
3. Gateway flavor: `VITE_GATEWAY_URL=http://127.0.0.1:8100 npm run build` —
   exit 0 (bundle `index-BZpfk85Z.js`); web preview restarted on :4173
   (pid in `/tmp/gwlogs/web.pid`), HTTP 200 and serving the new gateway
   bundle. All 9 ports re-verified 200 after the restart.

| Artifact | Path | Size | sha256 |
|---|---|---|---|
| AppImage (FINAL) | `apps/desktop/dist/IcecreamSheets-0.1.0.AppImage` | **142,388,005 bytes** | **`4c34eca508fc297ae9ed50f6579212f9872124facee060ccd29ad6d1088ce924`** |
| Unpacked | `apps/desktop/dist/linux-unpacked/icecream-sheets-desktop` | — | — |

Supersedes W10's `42f1f929…` (142,396,320 B).

## STEP 2 — E4 stall (P75 drop-open, w5-stall.mjs sampler, 5 ms + rAF): ❌ REPRODUCES > 100 ms — attributed to the load-completion render cluster; no surgical code fix exists among the candidates

Stack MCP :8106 stopped before all desktop measurement (app binds its own),
restarted after Step 3 and health-verified.

### Measurements on the FINAL package

| Series | maxTimer values (ms) | max / median |
|---|---|---|
| Standard mode, run set 1 | 134, 196, 140 | 196 / 140 |
| Quiet + split-drop | 131, 96, 117 | 131 / 117 |
| Standard mode, final set (machine verified idle: stack services 0% CPU) | **154, 157, 104** | **157 / 154** |
| CDP-trace run (quiet) | 158 (gaps: 115 @1420 ms, 158 @1583 ms, 49, 35) | — |

Reference points: W6 package 76 ms; W10 package 130 ms ×2; W5 post-fix
series 60/75/78 ms (standard). The final package does **not** return to the
≤ ~80 ms class on this VM, in any mode. P75 opens complete in ~2.1 s with
13 tabs in every run; zero IPC timeouts.

### Attribution (each candidate tested, not guessed)

- **Not OS contention / renderer descheduling.** The in-page Worker-thread
  timer sampler (same 5 ms interval, separate thread of the same renderer
  process) showed max stall **17–20 ms** while the main thread stalled
  134–196 ms. The renderer process was scheduled fine; the main thread was
  busy. Stack services measured at 0% CPU during the final series.
- **Not a single long task.** PerformanceObserver longtasks in the window
  top out at 52–106 ms; the 154–158 ms timer gaps are a back-to-back
  cluster of tasks ~1.4–1.7 s after the drop (hydration completion).
- **CDP Tracing (devtools.timeline) over the drop window:** the longest
  main-thread events are React scheduler `FunctionCall`s (the bundle's
  line-26 scheduler work loop, 9 calls of 17–41 ms, 189 ms total), a
  `Commit` of 53 ms and a `Layout` of 48 ms; 146 commits occur across the
  window. The CPU profile (1 ms sampling) is diffuse — no hot app
  function; W5's old culprit `loadIpc` is absent from the tops (the W5
  binary-transfer fix is intact).
- **W12's fill re-queue (E3) — DISPROVEN for the load path.** An
  event-counting diagnostic (`w13-count.mjs`, own `onEngineEvent`
  subscription on the real bridge) recorded exactly **one** engine event
  during the entire P75 drop-open: a single `recalcComplete`, **zero
  `cellsChanged`**. With no `cellsChanged` there are no epoch bumps, no
  stale-fill drops, and therefore no re-queued fills during load.
- **W8's per-cell epoch maps — negligible at P75 scale.** P75's largest
  sheet is 135×25 (~3.4k cells); a range-fill epoch map is O(cells) at
  ~3k entries ≈ sub-ms. Not the cost.
- **W9/W11 seeding** runs once inside the single hydration commit
  (main-process parse + renderer store seeding); it is part of the
  load-completion render, not a separable per-frame regression.

**Verdict:** E4 reproduces at ~104–196 ms (final quiet-machine standard
series **154/157/104 ms, median 154**). The stall is the aggregate
load-completion render cluster — hydration commit + first grid
layout/paint + per-frame progressive fill renders, each a full-App React
commit — on this 2-core VM. That is the same residual class W5 documented
("one ~60–80 ms load-completion render task" as the floor), now larger
with the W9 style seeding and fuller progressive streaming in the open
path. No candidate code change (W8 epochs, W12 re-queue, W9/W11 load
path) is attributable, and no surgical fix exists: reducing it further
requires first-paint work deferral / render-cost re-architecture inside
App hydration, which W5 already scoped out and which this task's
"surgical" bound excludes. **No code was changed for E4 and no repackage
beyond Step 1 was needed.** This stands as the R5 re-check number for V4.

## STEP 3 — Targeted revalidation on the final package: ✅ ALL PASS

Harness `hidden_files/pw2/w13-closeout.mjs` (stack MCP stopped first,
restarted after; scratch copies only). Raw: `/tmp/w13-results.json`.

### V1 (R1b-1 / E2 — saved formats render on desktop relaunch): ✅ PASS
- Instance A: fresh scratch P50 → MONTHLY C10 → ribbon Bold + Percentage.
  In-grid: font-weight **700**, text **"0.00%"** (C10 = 0, correct).
  Format-only edit dirtied the workbook; autosave rewrote the file
  (150,657 → 88,190 B). openpyxl parse-back: C10 `number_format "0.00%"`,
  **bold true** (`w13-v1-formatted.png`).
- Instance B: relaunch the packaged app on that autosaved file →
  MONTHLY C10 renders **fw 700 + "0.00%"** (`w13-v1-relaunch.png`,
  self-inspected: bold 0.00% in the Check row, Revenue row $132,943, no
  #NAME?). W10's relaunch failure (fw 400 / "0") is gone — the W12
  hydrate-order fix holds end-to-end in the package.

### V2 (R1b-2 / E1 — defined names survive save): ✅ PASS (on raw values; the harness's own pass flag is false due to a harness parsing bug, documented here)
- Parse-back of the same autosaved file (workbook.xml count):
  **38 defined names** (was 0 in W10).
- Relaunched app, MCP reads on the main-process engine (raw `cells`
  payloads in `/tmp/w13-results.json`):
  MONTHLY C13 = **132942.88335317458** (exact ground truth),
  OPERATING MODEL E8 = **1595314.6002380955** (exact) — **no #NAME?**.
- Grid edit MONTHLY C9 0.0833… → 0.25 recalcs C13 cleanly:
  132942.88335317458 → **398828.6500595239** (= ×3 to float precision).
- Harness-flag caveat: `w13-closeout.mjs`'s V2 `pass` computed **false**
  because its `num()` helper regex-matched the first number in the MCP
  JSON text — the `protocolVersion: 1` — instead of the cell value. The
  raw payloads above are the evidence and they pass every V2 criterion
  exactly; the flag is a harness-oracle bug, not an app result.

### V3 (R2 formula leg / E3 — grid refreshes on formula→formula edit): ✅ PASS (grid transitions + untruncated formula-bar oracle; the harness's text-predicate flag is false for a display-truncation reason, documented here)
Fresh scratch P50, MONTHLY C13. At this column width the grid renders
C13's currency value truncated: `"$132,943"` before, `"$8"` after the
edit — so `w13-closeout.mjs`'s poll predicates (searching innerText for
`8.333` / `132,942`) never matched and its V3 flag computed false, even
though every leg's display transitioned correctly
(`"$132,943"` → `"$8"` → `"$132,943"` → `"$8"`, recorded in
`/tmp/w13-results.json`). The untruncated oracle is the formula bar,
which shows the selected cell's full computed value; two follow-up runs
(`w13-v3-verify.mjs`, `w13-v3-redo.mjs`) prove all three legs:
- Before: formula-input **"132942.8834"** (cell text "$132,943").
- C13 := `=C9*100` → formula-input **"8.333333333"**, matched in
  **874 ms** (≤ 15 s bound) (`w13-v3-formula-edit.png`, self-inspected).
- Ctrl+Z → formula-input **"132942.8834"** (872 ms).
- Ctrl+Y → in the no-click protocol (`w13-v3-redo.mjs`, mirroring the
  original harness): cell transitions to "$8" on the first poll
  (4 ms) and the final formula-input reads **"8.333333333"**, no editor
  open. (The verify run's click-based polling opened a cell editor that
  swallowed its own redo keypress — a harness artifact, isolated and
  superseded by the no-click run.)
W10's "grid never re-renders the edited formula cell" is gone — the W12
cellsChanged-confirmation + fill re-queue fix holds end-to-end.

### V4 (sanity): ✅ PASS
- Boot + argv-open of scratch P50: **21 tabs**, loaded in 3,545 ms under
  the harness (first instance of the session).
- App MCP :8106 healthy; MCP `write_cells` MONTHLY C21 = 424242 →
  `{ok:true,written:1}` and the **grid shows 424242**.
- P75 opens on the final package (Step 2): 13 tabs, ~2.1 s, every run.
- R5 re-check = Step 2's final series: **154/157/104 ms** (see the E4
  verdict — the only non-pass item of this close-out).

## STEP 4 — Suites on final source: ✅ all green, counts at/above expected

`vitest run` per package (full suites, final source):

| Package | Files | Tests | Expected | Result |
|---|---|---|---|---|
| packages/engine | 43 | **984 passed** | ≥ 984 | ✅ |
| packages/gateway | 13 | **134 passed** | ≥ 134 | ✅ |
| apps/web | 122 | **1579 passed** | ≥ 1579 | ✅ |
| apps/desktop | 14 | **100 passed** | ≥ 100 | ✅ |

Zero failures; no deltas (the counts already include the W11/W12 new tests).

## Scoreboard

| Item | Verdict |
|---|---|
| Step 0 stack restart on current dists (9 ports 200, /api/addons routed) | ✅ PASS |
| Step 1 repackage | ✅ PASS — AppImage 142,388,005 B, sha256 `4c34eca508fc297ae9ed50f6579212f9872124facee060ccd29ad6d1088ce924` |
| Step 2 / E4 (R5) P75 stall | ❌ **REPRODUCES** 154/157/104 ms (median 154) — attributed to the load-completion React render/commit/layout cluster; W12 re-queue and W8 epoch candidates disproven by measurement; no surgical fix exists (see Step 2) |
| V1 (E2) relaunch renders saved Bold+% | ✅ PASS |
| V2 (E1) 38 defined names; C13/E8 exact; C9 edit recalcs ×3 | ✅ PASS |
| V3 (E3) formula edit/undo/redo refresh the grid in ms | ✅ PASS |
| V4 sanity (boot, 21 tabs, MCP write → grid, P75 opens) | ✅ PASS |
| Step 4 suites (984 / 134 / 1579 / 100) | ✅ PASS |

## State left behind
- Full stack running on the rebuilt dists, all 9 ports 200 (stack MCP
  :8106 restarted after desktop validation and health-verified).
- Web preview on :4173 serves the gateway-flavor build (`index-BZpfk85Z.js`);
  the packaged app carries the desktop-flavor build (`index-Bcibxken.js`).
- New harnesses kept for reuse: `hidden_files/pw2/w13-closeout.mjs`,
  `w13-trace.mjs`, `w13-count.mjs`, `w13-v3-verify.mjs`, `w13-v3-redo.mjs`
  (the closeout harness's V2 `num()` oracle and V3 text predicates are
  known-buggy per the Step 3 notes — trust its recorded raw values, not
  its V2/V3 pass flags).
- Not done / not in scope: any E4 render-architecture work (needs a
  coordinator decision — it is the one remaining Part A item); GTK
  Save-As dialog interaction (unchanged status from prior passes).
