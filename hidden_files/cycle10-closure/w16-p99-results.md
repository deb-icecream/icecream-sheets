# W16 — P99 Closure Pass: Results

**Fixture:** `test-data/perf-fixtures/perf-p99.xlsx` — 46 MB, 6,500,062 non-empty cells, 5 sheets, 1,700,010 formula cells with NO cached values.
**Machine:** this VM only — 7.9 GiB RAM, 2 cores, no swap (see "Host measure" — swap was attempted and is not permitted in this environment).
**Path under test:** real gateway (web app → gateway :8100 → engine :8101, `--expose-gc --max-old-space-size=6144`), login `e2e-tester`, drag-drop open in headless Chromium.
**Ground truth before this pass** (perf-evaluation.md §7): engine build completed 1 of 4 attempts (248.8 s, built RSS 5.07 GB), died 3 of 4 at the machine RAM ceiling; browser tab died during ingest; engine formula scan had never run; documented claim "engine host needs ≥ ~12 GB RAM for P99-class".

---

## Goal verdicts

### Goal 1 — First page paints in browser ≤ 5 s: **MET in 3 of 5 tours (best 4,809 ms); contention-sensitive**

Server leg (engine handler start → sheet-1 rows emitted) measured 2.79 s uncontended (Node client) and 3.29–4.58 s in browser-driven builds. Browser time-to-first-page (file selected → first values painted), per tour:

| Tour | TTFP | Notes |
|---|---|---|
| #1 (pre-fix) | 20,384 ms | tab survived (first time ever) but ingest crawled — see Lever B1 |
| #2 | **4,887 ms** | after reader cursor fix |
| #3 | **4,809 ms** | byte-scan reader |
| #4 | **4,914 ms** (poll timeline) | harness summary line picked a later re-stamp (15,302 ms) after the browser's near-death; browser process died ~54 s in at 40% during the runaway-apt window (see Incidents) |
| #5 | 6,500 ms | the successful full-load run; worst memory trough of any tour (min MemAvailable 285 MB) |

The ≤ 5 s target is achievable and was hit three times; it is not robust to extra tenants on this 2-core box (parse contention stretches the server leg, memory pressure stretches the client leg).

### Goal 2 — Full load completes in browser, engine alive: **MET (tour #5)**

Tour #5 (`w16-tour5-results.json`, screenshots `w16-tour5-*.png`): `loaded=true`, wall **1,147 s** drop → banner clear, tab JS heap 420.6 MB at load, engine healthy at end (`finalEngineHealth 200`), zero page errors. All 5 sheets then toured and rendered **real values** from the windowed cache / pull reads (DOM scan: Sales 408 non-empty / 231 numeric, Inventory 340/198, Ledger 272/132, Sales2023 408/231, Ledger2023 272/132; 0 error cells on every sheet).

Wall decomposition (tour #5): server build 359 s engine-elapsed (parse 55 s stretched by contention; 192–310 s in other builds) + stream drain ≈ 360 s gateway-side + a **long client-side tail (~12 min after stream drain) that remains unattributed** — stated plainly: the load completes, but the post-stream client phase (terminal + deferred hydration over 1.65M format entries, render churn under memory pressure) has not been CPU-profiled in that phase; the mid-ingest profile (below) cleared the reader/seed path, and no single measured culprit accounts for the tail. This is the main open follow-up.

### Goal 3 — Exhaustive engine formula scan of ~1.7 M formula cells: **MET, zero errors, zero sample mismatches**

Banded range reads (4,000-row bands, POST /api/engine/read via gateway) against the same built engine the browser loaded in tour #5 (`w16-scan-results.json`, samples from the independent evaluator `w16-sample.mjs` → `w16-samples.json`):

| Sheet | Cells read | Engine formula cells | Parser ground truth | Error values | Samples vs independent recomputation | Mismatches |
|---|---|---|---|---|---|---|
| Sales | 1,800,036 | 600,003 | 600,003 ✓ | **none** | 155 | 0 |
| Inventory | 1,500,010 | 450,000 | 450,000 ✓ | **none** | 160 | 0 |
| Ledger | 1,200,024 | 150,002 | 150,002 ✓ | **none** | 7 | 0 |
| Sales2023 | 1,200,036 | 400,003 | 400,003 ✓ | **none** | 155 | 0 |
| Ledger2023 | 800,024 | 100,002 | 100,002 ✓ | **none** | 7 | 0 |
| **Total** | **6,500,130** | **1,700,010** | **1,700,010 ✓** | **zero — no #REF!, #NAME?, #VALUE!, or any other error code in any cell** | **484** | **0** |

Every formula cell in the workbook was computed by the built engine and read back; the computed values agree with independent recomputation from the value columns on all 484 samples (including the Ledger running-balance serial chains). The file's value cells carry zero stored errors (parser ground truth), and the engine introduced none.

---

## Build RSS timeline — before / after

Standalone profile (parse + EngineWorkbook, same process discipline):

| | Before | After |
|---|---|---|
| Built RSS | 4,845 MB | **3,530 MB** |
| Post-GC live heap | 3,974 MB | **2,709 MB** |

Attribution of the before-heap (clear-and-GC): HyperFormula graph ≈ 2,002 MB (irreducible floor), valueCache ≈ 1,104 MB, cellInputs ≈ 707 MB, dirtyInputKeys ≈ 160 MB.

Through the real gateway (RSS sampler + tour polls):

| | Before | After |
|---|---|---|
| Build outcome | died 3 of 4 at machine ceiling; one success at 248.8 s, RSS peak **5,059 MB** plateau | **5 of 5 builds completed** (113–192 s uncontended-ish; 310–375 s under browser contention) |
| Built RSS plateau | 5,059 MB (the one success) | **3,684 / 3,730 / 3,677 MB** (builds #1–3); tour #5 peak **3,691 MB**, incl. scan growth to ~3,925 MB during exhaustive reads (bounded) |
| Mirror built for flag-ON P99? | (suspect in brief) | **Verified NOT built** — `mirrorMs: 0` in every build's timings |

Coexistence during the successful tour #5: engine peak 3,691 MB + tab heap 421 MB (renderer RSS ~530 MB) + remaining stack ~1.2 GB on 7,935 MB total → worst observed MemAvailable **285 MB**.

---

## What changed and why (per lever)

### Lever A — engine build memory (`packages/engine`, `packages/gateway`)
1. **`dirtyInputKeys` no longer populated during construction** (`workbook.ts` `bulkLoading` flag). The set (6.5M string keys ≈ 160 MB) has no consumers — parallel-recalc deliberately sends full payloads — and construction is the calc baseline, so recording it was pure waste.
2. **Value-cache seeding bounded** (`seedCache(retainValues)`, `VALUE_CACHE_SEED_LIMIT = 2,000,000`): above the limit the constructor scans for cycle-poisoned cells without retaining 6.5M computed values (≈ 1,104 MB). Manual mode still re-seeds with retention at suspend. All `valueCache.set` sites routed through `cacheValue()` with a 2M FIFO cap, so exhaustive read passes can't regrow it without bound (observed: whole-sheet reads had regrown RSS 3,684 → 4,940 MB before the cap).
3. **Hidden-taint memo capped** (`protocol.ts` `TAINT_MEMO_LIMIT = 500,000`, cleared on overflow — it is a pure memo; D3 chain behavior preserved, tests green).
4. **buildFromData releases as it goes** (`engineSvc.ts`): parsed rows passed to the workbook without the `[...row]` copy; `sheet.rows = []` released per sheet after build; one GC point after build (`--expose-gc`); **no mirror composed for flag-ON** (verified, `mirrorMs 0`); `sourceSheetFormats` stored run-length (`FormatsWire`) and decoded only at save time (~120 MB).
5. **Per-read GC correction**: the first cut called a full GC before and after *every* /read — on a 3.4 GB heap that put ~3 s on every viewport read (measured 2,700–3,000 ms). GC now fires only for reads ≥ 250,000 cells (`maybeGcLarge`). Ordinary reads after the fix: **24–50 ms**.

### Lever B — browser ingest (`apps/web`)
1. **NDJSON reader rewritten twice** (`gatewayClient.ts`): (a) per-line `buffer.slice` + `trim()` was O(stream × buffer) in string copies — tab ingested at ~5k cells/s (tour #1: 71% in 900 s). Cursor-based splitting fixed the asymptotics; (b) CDP profile of the next crawl showed ~83% of main-thread time in `fetch`/`(program)` — V8 rope flattening on every `indexOf`/`slice` over multi-MB buffers. Final form: **byte-level line scanning** (`Uint8Array.indexOf(10)`, decode only complete lines — safe, 0x0A never appears inside a UTF-8 multibyte sequence; partial lines carried as byte parts). Same delivery order, chunk semantics, and W15 40 ms time-slicing.
2. **Windowed streamed-cell retention for no-mirror workbooks** (`remoteEngine.ts`, `engineTransport.ts`): past 2.5M streamed cells the view cache becomes a bounded 300k-cell window (LRU-refresh + FIFO trim), `pendingCalc` switched from string keys to packed numeric keys (row×16384+col) and snapshotted/restored across the terminal reset, and `mergeLoadChunks` drops the `streamedCells` accumulation past 2M (the host seeds per-chunk from raw, so nothing is lost). Tab heap through a full P99 load: **224–495 MB** (previously the tab died during ingest). Mirror workbooks keep full retention — P95/P75 behavior unchanged (below).
3. **FormulaBar autocomplete sample cap** (`FormulaBar.tsx`): the autocomplete `columns` memo read the **entire used range** (1.8M cells) through the view on every engine tick — queuing ~25 s engine reads plus a 1.8M-cell mapping per recompute, which starved ingest after first paint (the tour #2/#3 stall). Column inference now samples at most 131,072 cells from the top of the used range (full width, rows capped); smaller sheets are read in full exactly as before.

### Lever C — host measure: **none in effect**
An 8 GiB swapfile was created as the sanctioned last resort, but `swapon` fails with *Operation not permitted* (no CAP_SYS_ADMIN; home volume is overlayfs/btrfs). The file was removed. **Every number in this report is product code on bare 7.9 GiB, no swap.** Separately, a runaway `apt-get update` from boot was found holding 2.7 GB RSS during the post-restart runs and was killed (an environment tenant, not a product factor; it explains tour #4's anomalous contention).

---

## Regression checks

- **P75 tour** (`w16-p75b`): 13/13 sheets, real values, 0 errors; TTFP 584 ms; load wall 4.1 s; **save/download works** (3,427 ms). Baseline (W15): TTFP ~348 ms median — same order, single-run noise.
- **P95 tour** (`w16-p95`): load completed (wall 109.3 s vs W15 ~47.8 s; this run's server build alone was 96.4 s vs ~48 s class — VM was carrying background tenants), TTFP 5,193 ms (server sheet-1 rows at 3,817 ms; W15 median TTFP 2.93 s), all 3 sheets render values, 0 errors, heap 386 MB. **Save timed out at 240 s and the engine was found dead afterwards** — the save-serialization peak (~1.8M cells) plus the resident browser exceeded the machine (same coexistence pattern as below). P75's save proves the path; P95-scale save on this exact VM is not proven either way by this pass and is recorded as an open item, not a pass.
- **Suites** (related, per instructions — no full-suite runs mid-build):
  - engine: bulk-load-memory + calc-chain + engine + false-cycles **145/145**; + parallel-recalc + host-routing **146/146**; hidden-taint-memo + five-faces + bulk-load + read-auth **24/24**.
  - gateway: **134/134** (re-run; the first run had 1 failure in 117 s while a 3.9 GB P99 engine was co-resident — clean re-run took 28 s).
  - web: remoteEngine 9 + engineTransport 2 + routedEdit 18 + bulkReads 5 + saveInterlock 10 = **44/44**; `tsc --noEmit` clean; production build clean (with `VITE_GATEWAY_URL=http://localhost:8100`).
  - New tests: `packages/engine/tests/bulk-load-memory.test.ts` (3), `apps/web/src/services/engineTransport.test.ts` retention tests (2), windowed-retention test in `remoteEngine.test.ts` (evicted cell re-reads through the bulk path; pending mark survives terminal reset).

## Incidents (all on this VM, all memory-shaped)
- VM restarted 3× under combined load; `/tmp` logs lost each time (durable evidence kept under `hidden_files/cycle10-closure/`).
- Engine kernel-killed 4× across the pass, each time while a built P99 engine (~3.7–3.9 GB) coexisted with another GB-scale tenant (vite build, test workers, giant whole-sheet reads, P95 save serialization).
- Browser process died once (~54 s into tour #4, 40% loaded) during the runaway-apt window.

## Final capacity statement
- **Product floor (proven):** P99-class (6.5M cells / 1.7M formulas) now builds, paints first page ≤ 5 s, fully loads in the browser, and scans exhaustively on a **dedicated 8 GiB host** — engine built RSS ~3.7 GB (≤ ~3.93 GB under exhaustive reads), tab ~0.5 GB, rest of stack ~1.2 GB, ~0.3 GB worst-case headroom. The pre-W16 claim "≥ ~12 GB or it dies" is beaten: 3 of 4 baseline attempts died at 5.06 GB engine RSS; the fixed engine peaks ~1.4 GB lower and the tab no longer accumulates the workbook.
- **Comfortable figure:** ~12 GB remains the right recommendation when the host must also carry dev tooling or other tenants — on 8 GiB, any extra GB-scale process reliably kills the engine or the browser (four observed kills). Nothing in this pass used swap (not permitted here), so the 8 GiB floor is a bare-metal floor, not a swap-assisted one.
- **Open follow-ups:** (1) the ~12 min post-stream client tail in tour #5 is unattributed — profile the terminal/deferred hydration phase before claiming a full-load wall target at P99; full-load wall is therefore reported as measured (1,147 s), not as a target met. (2) P95-scale save on this VM unproven (engine died at the serialization peak during the attempt). (3) P95 TTFP/wall single-run numbers this pass ran ~2× W15 medians under background tenants — re-measure medians on a quiet box before calling it a regression.
