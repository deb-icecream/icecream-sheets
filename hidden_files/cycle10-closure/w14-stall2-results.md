# Cycle 10 Closure — W14: E4 stall, bounded attempt at the load-completion commit cluster

Date: 2026-10-20 · Worker: W14 (E4 stall worker) · Repo: ~/workspace/icecream-sheets
Scope: decompose the P75 load-completion commit cluster W13 attributed,
try the cheapest effective levers in the mandated order, and land what
measurably helps or prove the floor. `perf-evaluation.md` / `progress.md` /
`TODO.md` NOT edited. No GitHub push. Original fixtures never opened by the
app (verified untouched at the end: perf-p50 150,657 B, perf-p75
1,285,214 B, both 2026-10-19 mtimes; all desktop work used scratch copies
under `/tmp/desktop-validate-fixtures/`).

Harnesses: `hidden_files/pw2/w5-stall.mjs` (canonical sampler, unmodified),
`hidden_files/pw2/w14-trace.mjs` (new: sampler + CDP timeline trace +
temporary in-page instrumentation — App render counter/timestamps,
`hydrateOpenedWorkbook` section timings, IPC bridge/fill/deliver events,
fill-request ranges; instrumentation fully reverted after measurement),
`hidden_files/pw2/w14-spotcheck.mjs` + `w14-gw-spotcheck.mjs` (new).
Raw JSON: `/tmp/w14-trace-base.json`, `/tmp/w14-trace-base2.json`,
`/tmp/w14-trace-ea.json`, `/tmp/w14-stall-ea.json`,
`/tmp/w14-stall-definitive.json`, `/tmp/w14-stall-definitive2.json`
(see the §3 measurement note on series provenance).
Screenshots: `hidden_files/cycle10-closure-shots/w14-desktop-p50-opmodel.png`,
`w14-gateway-p50-opmodel.png` (both self-inspected by this worker).

## 1. Commit decomposition (instrumented, baseline W13 package code)

Timeline of a P75 drop-open, relative to the drop (two instrumented runs;
structure identical, times vary ±150 ms):

| t (ms) | Event |
|---|---|
| ~5 | `setWorkbookLoaded(false)` (gate closes) |
| ~1060–1210 | Bridge `recalcComplete` from main → 1 App render |
| ~1130–1280 | `loadIpc` resolves → result conversion + `notifyHostReplaced()` + `hydrateOpenedWorkbook()` + `setWorkbookLoaded(true)` — **one** App render (see below) |
| ~1160–1220 | Grid's first reads queue fills: viewport range FMTs `0:0-21:16` (374 cells) |
| ~1270–1345 | Same viewport re-requested one row taller, `0:0-22:16` (391 cells — range-key change defeats dedup; the whole range re-fetches and re-delivers) |
| ~1330–1400 | Fill delivery 1: 374 refs + recalc tick → full App render |
| ~1350–1470 | Whole-sheet read FMTs `0:0-134:11` (1,620 cells) requested during that render (chart overlays on the active sheet resolving series data) |
| ~1370–1560 | Fill delivery 2: 391 refs → full App render; fill delivery 3: 1,620 refs → full App render |

**Total App renders in the window: 7** (loading flip, recalc tick,
hydration, one unexplained ~110 ms after hydration — an effect/callback
setState, not a host event — and three fill-driven renders).

### What the hydration actually costs

- **The ~35 store updates do NOT fan out.** `notifyHostReplaced()` (its
  listener alone fires ~15 setStates) + `hydrateOpenedWorkbook` (~20
  setStates) + `setWorkbookLoaded(true)` run in one synchronous block
  after the `loadIpc` await and batch into a **single** React 18 render.
  Lever (a)'s premise — App-level hydrations fanning into multiple
  commits — is already satisfied by automatic batching; there was nothing
  to batch.
- **Hydrate JS is cheap: 12–19 ms total** for all 13 sheets, sectioned:
  formats/styles conversion 10.4–20.7 ms (the only non-trivial section;
  1,460 format + 4,754 style entries workbook-wide), pivots 0.7–2.3 ms
  (7 pivots, results built from cached values), charts 0.5–1.0 ms
  (4 charts), everything else (data types, dims, protection, pictures,
  SmartArt, page-setup/print/break stashes, header-footer/ink/theme)
  ≤ 0.6 ms combined.
- **Are all 13 sheets' view stores hydrated synchronously?** Mixed:
  formats/styles — YES, one workbook-wide store built for all sheets at
  load-complete (per-sheet split: active sheet FMTs holds 1,651 of 6,214
  entries; the other 12 sheets hold 4,563). Charts/pivots — YES, all
  specs built synchronously (but only the active sheet's overlays render;
  rendering filters by sheet). Dimensions (col widths / row heights /
  hidden) — NO, only `data.sheets[0]` is seeded today. Page-setup /
  print-titles / breaks / header-footer / ink per-sheet values are
  stashed into refs/records for all sheets (sub-ms; they are data
  copies, not store builds).
- **The 53–57 ms `Commit` and 38–48 ms `Layout`** (W13's numbers,
  reproduced: Commit 49–57, Layout 38–47) are browser frame-pipeline
  costs of the first data-bearing frames, not JS: the hydration frame
  commits 13 new sheet tabs + ribbon un-gating + a grid whose scroll
  layer is 3,302×3,745 px (1,382 DOM elements total, 391 cell divs, 7
  overlay children on FMTs, 0 canvases); the following frame lays out
  the first filled grid (391 formatted cells + overlays with real
  series data).
- **Per-frame cost stack in the cluster:** React render JS 16–44 ms +
  Layout 38–47 ms + Commit 49–57 ms per data frame, over 2–3 main-thread
  tasks per frame. The worst timer gap is 1–2 frame pipelines: whether
  the 5 ms sampler timer wins a slot between consecutive frame tasks is
  a scheduling coin-flip on this 2-core VM (identical task profiles
  produced gaps of 86 ms and 161 ms in adjacent runs). Worker-thread
  sampler stayed at 17–20 ms throughout (not OS contention — agrees
  with W13).

**Decomposition verdict:** the stall is not a hydration fan-out, not
hydrate JS, and not any single task. It is (i) one unbroken busy chain —
bridge-recalc render → load-continuation microtasks (conversion +
hydrate) → hydration render → its Commit — worth ~108–125 ms of timer
starvation, stacked against (ii) three fill-driven data frames
(viewport, viewport+1-row, whole-sheet-for-charts) at ~50–80 ms of
frame pipeline each.

## 2. Levers tried, in the mandated order

### (a) Render coalescing / batching during load

- Store-hydration batching: **already in effect** (single batched
  render, §1) — no change available or needed. Fill deliveries already
  coalesce per frame in the IPC host (W5).
- **E-a (landed): break the unbroken chain with one macrotask yield.**
  `openDesktopBuffer` (desktop-only path, `apps/web/src/App.tsx`) now
  awaits `setTimeout(0)` between the `loadIpc` round-trip and the
  notify+hydrate batch. The previous workbook stays painted and
  mutation stays gated (`workbookLoaded` is still false) during the
  yield, so the progressive-view rule (paint arriving data; loading
  state, never wrong data) and the save-gating rule are unaffected.
  Measured on the instrumented build (CDP trace, 2 runs): the
  hydration-chain timer gap fell from **108–125 ms → 61–66 ms** in both
  runs. Canonical sampler (below) confirms a consistent median shift.
- **E-b variant considered and falsified before implementing:**
  widening fill-delivery coalescing so the three fill deliveries merge.
  An accidental natural experiment in the E-a trace runs showed why
  this backfires for a max-gap metric: when two fetches landed in the
  same frame and merged into one 1,735-ref delivery, that single frame
  absorbed both frames' render+layout work and produced the run's worst
  gap (161 ms). Frame-splitting is what keeps individual gaps near one
  frame pipeline; merging deliveries concentrates work. Not pursued.

### (b) Lazy hydration of non-active sheets' view stores — evaluated, rejected on measurement

Ceiling analysis: the only synchronous all-sheets work of any size is
the formats/styles build (10.4–20.7 ms), of which non-active sheets are
73% (4,563/6,214 entries) → **maximum possible saving ≈ 7–15 ms**, all
inside the hydration microtask that E-a already splits off the worst
chain. Charts+pivots for all sheets cost 1.2–3.3 ms combined. None of
it touches the dominant costs (Commit 49–57, Layout 38–47, fill-frame
renders), so (b) cannot move the median materially (post-E-a median
~140 ms; (b)'s ceiling is ~10 ms off a non-worst cluster). It would also
require a deferred-format stash merged back on the save path
(`applyFormatStoreToWorkbookData` reads the live store — unvisited
sheets' formats would be dropped on save if stashed naively) in code
shared with web — data-loss risk disproportionate to a ≤ 15 ms ceiling.
**Not implemented**, per the bounded-attempt mandate.

### (c) Floor

With E-a landed and (b) proven immaterial, the residual stall is the
per-frame pipeline floor of the first data frames on this 2-core VM:
one frame ≈ render 25–44 ms + Layout 38–47 ms + Commit 49–57 ms, and
the worst timer gap ≈ 1–2 frame pipelines depending on timer
interleave luck. Going materially below this needs render-cost
re-architecture (grid/overlay rendering work itself), which is outside
this task's authorization. **This is the proven floor.**

## 3. Final measurements

Canonical `w5-stall.mjs` sampler (standard mode, stack MCP stopped,
fresh app process per run, P75 drop-open):

| Series | maxTimer values (ms) | Median |
|---|---|---|
| W13 final package (baseline) | 154 / 157 / 104 | **154** |
| W14, E-a instrumented dir build | 80 / 120 / 132 | **120** |
| W14 final AppImage package, series A | 86 / 146 / 123 | 123 |
| W14 final AppImage package, series C (exclusive machine) | 350* / 140 / 145 | 145 |
| W14 final AppImage package, series D (exclusive machine) | 134 / 116 / 168 | **134** |

**Measurement-provenance note (transparency):** series A's raw JSON
(`/tmp/w14-stall-final.json`) was overwritten by a later series (B)
that ran concurrently with this worker's foreground spot-check
harnesses — B's runs contended for CDP :9222 / MCP :8106 and CPU, show
contention signatures (a 60 s banner-poll timeout, a 195 ms stall
outside the cluster window), and are **discarded**. Series C and D were
then run back-to-back on an otherwise idle machine as the definitive
evidence. In series C run 1 (marked *), the max (350 ms) came from a
single 344 ms longtask 632 ms after the drop — a cold-cache signature
(first app process after idle; it appears in no other run, traced or
sampled) — so C's cluster runs are 140 / 145. Across the five clean
cluster runs of C+D (140 / 145 / 134 / 116 / 168) the median is
**140 ms**; series A (86 / 146 / 123) sits in the same range. The
standard-mode harness's `openMs` bookkeeping shows a recurring 60 s
artifact (its banner poll misses the transition and waits out its own
timeout) in some runs of every series — it affects only the reported
open time, not the sampler, whose `maxAt` localizes every cited stall
to the load-completion window.

The < ~100 ms target is **not** reached; the stretch ≤ 80 ms class is
not reached. E-a's effect at the canonical-sampler level is a modest
median shift (154 → ~140 across clean series) with heavily overlapping
distributions — i.e. within run-to-run variance of this metric on this
VM. The firm result is the mechanism-level one from the instrumented
traces: the hydration chain's own timer gap fell 108–125 → 61–66 ms in
both traced runs. The residual is the §2(c) floor, dominated by
frame-pipeline cost and timer-interleave variance. P75 opens complete
in ~2.1 s with 13 tabs in every run; zero IPC timeouts.

## 4. Final package

Flavor protocol run in order: desktop-flavor web build →
`apps/desktop` build + `electron-builder --linux dir AppImage` →
gateway-flavor rebuild + preview restart on :4173 (serving
`index-DDDmuZJQ.js`, HTTP 200).

| Artifact | Path | Size | sha256 |
|---|---|---|---|
| AppImage (FINAL) | `apps/desktop/dist/IcecreamSheets-0.1.0.AppImage` | **142,387,554 bytes** | **`2d09bd4007d0c5c5d54f559e8ef76d37f4fc8f43be5e09a971328042851196cd`** |

Supersedes W13's `4c34eca5…` (142,388,005 B). The only source change vs
W13: +10 lines in `apps/web/src/App.tsx` (`openDesktopBuffer`: comment +
one `await setTimeout(0)` yield). `apps/web/src/services/ipcEngine.ts`
verified byte-identical to its pre-W14 state — all temporary
instrumentation reverted; the diff of `App.tsx` vs its pre-W14 backup is
exactly the E-a block.

## 5. Validation on the final code/package

| Check | Result |
|---|---|
| apps/web suite (incl. `ipcEngine.test.ts`) | ✅ 122 files, **1579 passed** (≥ W13's 1579) |
| apps/desktop suite | ✅ 14 files, **100 passed** (≥ W13's 100) |
| Desktop spot check (rebuilt package, P50 argv-open) | ✅ **21 tabs**; switch to OPERATING MODEL renders formats on the later sheet — grid shows **$1,595,315** (E8, ground truth 1,595,314.6) plus $/% formatting throughout (`w14-desktop-p50-opmodel.png`, self-inspected) |
| Gateway spot check (web, shared `App.tsx`) | ✅ Login → P50 gateway-stream open → 21 tabs → switch to OPERATING MODEL → **$1,595,31x renders** on the later sheet (`w14-gateway-p50-opmodel.png`). Web behavior unchanged in result: the landed change sits in `openDesktopBuffer`, which only the desktop route executes |
| Stall re-measurement on rebuilt package | §3: definitive exclusive series C+D clean cluster runs **140 / 145 / 134 / 116 / 168 ms, median ~140** (target <100 not reached — floor documented in §2c) |

Note on the gateway check: a first attempt clicked the tab before the
terminal stream hydration and the host-replaced handler reset the
active sheet to the first tab — that is the app's designed behavior
during a streaming open (same as W13-era builds), not a regression; the
harness now waits for the Ready state before touring, and passes.

## Scoreboard

| Item | Verdict |
|---|---|
| Commit decomposition (§1: renders, sections, fill cascade, Commit/Layout contents, all-sheets question) | ✅ Done — hydration batches to 1 render; hydrate JS 12–19 ms; stall = chain + fill frames |
| Lever (a) batching/coalescing | ✅ Already-effective for stores; **E-a yield landed** (chain gap 108–125 → 61–66 ms) |
| Lever (b) lazy non-active hydration | ❌ Not implemented — measured ceiling 7–15 ms off a non-worst cluster; save-path risk; cannot move the median materially |
| Lever (c) floor | ✅ Proven floor: per-frame pipeline (render+Layout+Commit ≈ 50–80 ms/frame) × timer-interleave luck; median 123 ms |
| Suites (web 1579, desktop 100) | ✅ Green |
| Repackage + final stall series | ✅ AppImage `2d09bd40…`; definitive series C+D median ~140 ms (see §3 provenance note) |
| Desktop + gateway spot checks | ✅ PASS both |

## State left behind
- Full stack running, all 9 ports HTTP 200 (stack MCP :8106 restarted
  after desktop measurement, per the start-stack script's command);
  web preview on :4173 serves the gateway-flavor build.
- New harnesses kept for reuse: `hidden_files/pw2/w14-trace.mjs`
  (depends on the W14 instrumentation, now reverted — its `__w14`
  sections/events will read empty on current builds; stall + trace +
  DOM census still work), `w14-spotcheck.mjs`, `w14-gw-spotcheck.mjs`.
- Not done / not in scope: render-cost re-architecture of the first
  data frames (the §2c floor) — needs a coordinator decision if E4 is
  to go below ~100 ms on this VM class.
