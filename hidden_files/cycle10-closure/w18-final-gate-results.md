# W18 — FINAL GATE results (Cycle 10 closure pass, last measurement run)

**Date:** 2026-10-20 (PDT) · **Worker:** W18 final gate · **Repo:** ~/workspace/icecream-sheets
**Code state:** FINAL — includes W16's P99 memory fixes and W17b's config-defaulted-off
deployment code. perf-evaluation.md / progress.md / TODO.md NOT edited. No GitHub push.
**P99: NOT re-run** (per gate instructions; W16's completed run stands).

Method: W15 settled method (harness family of `hidden_files/pw2/tour.mjs` — login as
`e2e-tester`, drag-drop fixture, TTFP = the app's own `window.__icecreamFirstPage.
timeToFirstPageMs`; settled runs wait for the load banner to clear before the next run).
Perf harness: `hidden_files/cycle10-closure/w18-perf.mjs` (tour pattern minus tabs/save —
the P95 save is a dedicated step, §4). Raw per-run JSON: `w18-perf-*.json` in this folder.
Tour evidence: `w18-shots/` (screenshots + `*-tour.json` per fixture).

Host: 2 cores, 7.7 GiB RAM, no swap. Host was quiet for all measurement runs (no sibling
heavy work; load average ≤ ~1.7 at run starts, rising only from the run under measurement
itself). One incident before measurements began: the VM restarted once during the first
stack start (boot-time tenant); the stack was restarted cleanly afterwards and all
numbers below are post-restart on the final build.

---

## 0. Rebuild + restart (step 1) — DONE

- Package dists rebuilt with `tsc -p` (exit 0 each): engine, service, xlsx-adapter,
  gateway, mcp-server.
- Web dist rebuilt gateway-flavor: `VITE_GATEWAY_URL=http://127.0.0.1:8100 npm run build`
  in `apps/web` (tsc + vite, exit 0; gateway URL verified present in the emitted bundle).
- Stack restarted via `hidden_files/start-stack-finisher.sh` (engine with
  `--expose-gc --max-old-space-size=6144`). All 9 ports healthy (8100–8107, 4173 → 200).
- Test-user login verified: `POST /auth/login {userId:"e2e-tester"}` → token issued;
  authed `POST /api/engine/reset` → `{"ok":true,...}`.

## 1. Fixture tours — web-regression check for all closure shared-code changes (step 2)

Gateway mode, every sheet visited, DOM scanned for formula-error values
(#REF!/#NAME?/#VALUE!/#DIV/0!/#NUM!/#N/A/#NULL!/#GETTING_DATA), tour's own save test included.
"Console errors" counts exclude nothing; the single 404 seen on every tour (including
W15's recorded P75 tour on the pre-closure build) is the pre-existing baseline resource
404 — it is listed for honesty and not counted as a failure below.

| Fixture | Sheets | Formula-error cells | Page errors | Console errors | Save (tour) | Verdict |
|---|---|---|---|---|---|---|
| cycle5 pivot-table-closedxml.xlsx | 11/11 | 0 | 0 | 1× 404 (baseline) | ok, 1,472 ms | **PASS** |
| cycle5 olap-cube-closedxml.xlsx | 2/2 | 0 | 0 | 1× 404 (baseline) | ok, 1,419 ms | **PASS** |
| cycle5 external-link-closedxml.xlsx | 1/1 | 0 | 0 | 1× 404 (baseline) | ok, 1,389 ms | **PASS** |
| cycle5 binom-dist-libretexts.xlsx | 5/5 | 0 | 0 | 1× 404 (baseline) | ok, 1,336 ms | **PASS** |
| cycle6 trendline.xlsx | 2/2 | 0 | 0 | 1× 404 (baseline) | ok, 1,310 ms | **PASS** |
| cycle6 pivotchart.xlsx | 13/13 | 0 | 0 | 1× 404 (baseline) | ok, 1,734 ms | **PASS** |
| cycle6 smartart.xlsx | 2/2 | 0 | 0 | 1× 404 (baseline) | ok, 1,333 ms | **PASS** |
| cycle6 geocode.xlsx | 1/1 | 0 | 0 | 1× 404 + **81× 500** (run 1); re-run: 1× 404 + **105× 500** | ok, 2,930 / 3,337 ms | **FAIL** (strict zero-console-error criterion — see Blocker 2) |

Geocode detail: the sheet renders fully (136 non-empty viewport cells, real city data),
save succeeds, zero formula-error cells, zero page errors. The 500s are
`POST /api/engine/read` responses (fast, 1–28 ms) bursting during the load window;
reads issued after the build completes return 200 (verified directly against the
resident workbook: cell/range reads at rows 0, 34,000 and 34,163 all 200 with correct
values). Same pattern at P95 scale (§2): the client issues reads while the engine is
mid-build and they fail instead of queueing. Load/render/save are unaffected.

## 2. Perf gate runs — real gateway path, firstPagePerf marks (step 3)

Recorded post-closure medians (W15): TTFP P50 305 ms / P75 348 ms / P95 2,930 ms;
walls P50 3.73 s / P75 5.45 s / P95 ≈47.8 s. Median of 2 runs = mean of the two.
Regression rule: > +25% vs recorded median = blocker.

| Fixture | Runs (TTFP ms) | **TTFP median** | vs recorded | Runs (wall) | **Wall median** | vs recorded | Heap at loaded (median) | Long tasks cnt/total/max (per run) |
|---|---|---|---|---|---|---|---|---|
| P50 | 362.5 / 397.1 | **379.8 ms** | 305 ms → **+24.5%** (under blocker threshold; watch item) | 2.34 s / 2.31 s | **2.32 s** | 3.73 s → −37.7% ✅ | 45.7 MB | 9/1,789/695 · 9/1,673/579 |
| P75 | 456.3 / 272.0 | **364.2 ms** | 348 ms → +4.6% ✅ | 2.89 s / 2.34 s | **2.61 s** | 5.45 s → −52.1% ✅ | 64.1 MB | 10/2,056/855 · 9/1,765/723 |
| P95 | 3,333.5 / 3,182.2 / 2,546.8 | **3,182.2 ms** | 2,930 ms → +8.6% ✅ | 56.5 s / 66.9 s / 51.6 s | **56.5 s** | ≈47.8 s → +18.2% (under threshold) | 382.6 MB | 77/20,306/3,837 · 69/19,332/5,225 · 74/17,699/3,854 |

Corroboration: the dedicated P95 save-tour load (§4, fresh engine, quiet host) recorded
TTFP **2,201.6 ms** and wall **47.8 s** — at the recorded medians.

**No perf metric crosses the +25% regression blocker threshold.** P50 TTFP (+24.5%)
sits immediately under it while its wall improved 38% — recorded as a watch item,
not a blocker (see §5).

Console errors during perf runs: P50/P75 runs: only the baseline 1× 404 each.
P95 runs: 1× 404 + 65 / 120 / 111× read-500 + 5× 502 each (Blocker 2 pattern; the 502s
are gateway upstream failures while the engine event loop is blocked in the ~28–32 s
build). Loads completed in all runs; zero page errors.

## 3. Edits — real UI path, `edit-timer2.mjs`, et2 configs (step 4)

Settle = engine-side watch cell changed (polled via gateway read), Enter → settle.

| Fixture | Edit | Load wall | Commit (target cell) | Watch settle | Deep settle |
|---|---|---|---|---|---|
| P75 short | Constants!B8 0.003→0.004 (5 transitive) | 2.57 s | 143 ms | n/a — watch cell is a CHK boolean; stayed `true` (check still passes; value correctly unchanged) | — |
| P75 long | Constants!B11 6→7 (155 dependents) | 2.55 s | 435 ms | 591 ms | — |
| P95 short | Sales!F2 Qty→999 (3 dependents, server-routed) | 48.9 s | 188 ms | 247 ms (LineTotal 78,250.47 → 679,758.47) | — |
| P95 long | Ledger!E2→12,345.67 (running-balance chain ~30,000 deep) | 50.4 s | 4,315 ms | 4,474 ms | 4,794 ms (Ledger row 30,001 balance updated) |

All four edits committed and propagated correctly through the gateway path.

## 4. P95 SAVE SEQUENCE on the quiet host — the thrice-owed item (step 5)

**Verdict: FAIL — engine death during server-side serialization. Clean failure record:**

- Setup: fresh gateway-mode load of `perf-p95.xlsx` in the browser (tour harness),
  nothing else running on the host (load avg 1.67 and falling at start; the only other
  process was a 2 s-cadence RSS sampler for the engine pid).
- Load: TTFP 2,201.6 ms, fully-loaded wall 47.8 s, all 3 sheets rendered with real
  values, 0 formula-error cells, browser heap 380.8 MB.
- Save: Ctrl+S → Download dialog → Download (the W2 server-side flow,
  `POST /api/engine/download` through the gateway).
  - **Wall time: no completion.** The browser download event never fired; the tour's
    240 s download wait timed out (`TimeoutError: page.waitForEvent: Timeout 240000ms
    exceeded while waiting for event "download"`).
  - **Engine did NOT stay alive.** Gateway log: `POST /api/engine/download
    principal=user:e2e-tester status=502 49626ms` — the engine died **~49.6 s into the
    save**, and the gateway surfaced 502. Engine log contains **no** `/download`
    completion line for this attempt (every successful tour save in this gate logged
    one). Engine pid confirmed gone afterwards; `GET :8101/health` → connection
    refused. No saved file was produced (downloads dir empty).
  - **Engine RSS peak (observed):** 4,124,324 KB (≈4.12 GB) — max of the 2 s-cadence
    sampler over the whole gate (engine resident with P95; the sampler may have
    missed the instantaneous peak at death). Machine: 7.7 GiB total, no swap;
    after the death, available memory recovered to 4.7 GiB. `dmesg` is not readable
    in this VM, so kernel-OOM vs V8 heap-limit cannot be distinguished from logs;
    the death phase is unambiguous: during `/download` serialization of the
    1.8 M-cell workbook, ~50 s in, before any download bytes completed.
  - **Parse-back: NOT POSSIBLE** — no output file exists. Expected counts
    (1,320,031 value cells + 480,005 formula cells, W2's engine-level parse-back)
    could not be verified this run. (W2 proved those exact counts on this same code
    path in its own session; on this quiet-host final-code run the save does not
    survive to produce a file.)
- This matches the W15/W16 pattern (P95 save is the known coexistence ceiling on
  this 7.7 GiB VM); W16's memory fixes did not close it. P75-and-below saves are
  proven repeatedly in this gate (§1: all 8 fixture saves + P75 tour save ok).
- **Recovery:** the engine was restarted after the failure (same finisher flags);
  at gate close the full stack is running and healthy (all ports 200, login + reset
  verified — §6).

## 5. Blockers

1. **P95 save kills the engine (FAIL, §4).** Gateway-mode save of perf-p95.xlsx
   (1,800,036 cells) on the quiet host: engine process dies ~49.6 s into
   `POST /api/engine/download` (gateway 502), no file produced, parse-back
   impossible. The thrice-owed P95 save remains unproven/failing on this VM.
2. **Client reads fail during engine build (tour criterion failure, §1–§2).**
   geocode.xlsx tour: 81× (run 1) / 105× (run 2) console errors —
   `POST /api/engine/read` → 500 during the load window; P95 opens: 65–120× 500
   plus 5× 502 per run. Loads still complete and post-build reads return 200 with
   correct values, but the gate's zero-console-error criterion is not met for
   geocode, and the read-during-build behavior is systemic (scales with build
   duration). No code was fixed in this gate, per instructions.

**Watch item (not a blocker):** P50 TTFP median 379.8 ms vs recorded 305 ms
(+24.5%, immediately under the +25% threshold), with P50 wall improved −37.7%.

## 6. Final state

- Stack LEFT RUNNING: gateway :8100, engine :8101 (restarted after the §4 death,
  `--expose-gc --max-old-space-size=6144`), vault :8102, meta :8103, etl :8104,
  agent :8105, MCP :8106, addons :8107, web preview :4173 — all `/health` 200;
  e2e-tester login + engine reset verified after the restart.
- Evidence in this folder: this file, `w18-perf-*.json` (raw perf runs),
  `w18-shots/` (8 fixture tours + screenshots + saved files),
  `w18-p95save/` (P95 save-tour JSON, screenshots; downloads dir empty),
  `w18-perf.mjs` (perf harness).
