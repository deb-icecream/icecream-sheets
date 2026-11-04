# W20 — READ-DURING-BUILD FIX results (Cycle 10 closure pass, W18 Blocker 2)

**Date:** 2026-10-21 (PDT) · **Worker:** W20 read-during-build fix · **Repo:** ~/workspace/icecream-sheets
**Scope honored:** P95-save blocker NOT touched (separate, verdict already recorded); perf-evaluation.md / progress.md / TODO.md NOT edited; no GitHub push.

---

## 1. Root cause (file + mechanism)

Reproduced locally before fixing (script: fire `POST /api/engine/read` against the live
gateway + direct to the engine while a geocode.xlsx `/load/stream` is in flight):

- After the `meta` chunk (t≈216 ms — the client now knows the sheet name `Cities`), reads
  came back **500 in ~15 ms** with body `{"ok":false,"error":"engine error: Unknown sheet: Cities"}`.
- Reads fired after `data-done` returned 200 with correct values; reads after `built` 200.

Mechanism, in `packages/gateway/src/services/engineSvc.ts`:

1. `/load/stream` (and `/load`) parse the file **asynchronously** (`parseWorkbookFast`,
   worker/inline parse, event loop free) and only swap the engine workbook at the END,
   in the synchronous `buildFromData()` → `wireFresh(workbook)`.
2. During the whole parse window, `state.host` still holds the **previous** workbook
   (or the blank boot workbook, whose only sheet is `Sheet1`). Concurrent `/read`
   requests ARE processed in that window (nothing blocked them).
3. A read for a sheet that exists only in the incoming file goes
   `host.readCell/readRange → EngineWorkbook.getValue/getFormula → addr() → sheetId(name)`,
   which throws `Unknown sheet: Cities` (`packages/engine/src/workbook.ts` `sheetId()`).
   The throw reaches the engine listener's outer catch → `500 engine error: …` — fast
   (1–28 ms in W18), matching the measured signature exactly.
4. Corollary worse than the 500: a read for a sheet name present in **both** files would
   have been silently served the **old file's values** during the window. The gate below
   fixes that too (no test existed for it; the new stream test uses a decoy workbook and
   asserts new-file values).

The build phase itself was never the 500 source: reads arriving during the synchronous
build block in the socket queue and are served from the new workbook when the loop frees
(measured in the repro: a post-`data-done` read waited ~2.4 s and returned 200).

### The 502 class (W18: 5× per P95 open) — same root-cause family, characterized precisely

- Route: `POST /api/engine/read` (the only route the client issues in volume during opens).
- Mechanism: gateway upstream timeout. `packages/gateway/src/gateway.ts` proxied `/read`
  with the **30 s default** upstream timeout. Reads issued late in a P95 open queue behind
  the engine's ~30 s synchronous build; when the gateway's 30 s socket timer fires first,
  it destroys the upstream request and, headers not yet sent, answers **502 backend
  unavailable**. They are NOT a separate defect — they are reads in the same build window,
  killed at the proxy instead of the engine. Post-fix evidence confirms it: on the fixed
  stack, P95-open reads with gateway-logged durations of **47,306–47,346 ms returned 200**
  (under the old timeout every one of those would have been a 502).

## 2. The fix (engine-side gate + gateway timeout alignment)

### `packages/gateway/src/services/engineSvc.ts` — the build gate

- New per-listener state: a **load/build gate** (`beginLoadBuild` / `endLoadBuild` /
  `waitForLoadBuild`, documented in the file header under `/read`).
- `/load` and `/load/stream` open the gate **before the parse starts** (after body
  validation) and settle it on every exit path:
  - success → gate clears (and clears any sticky error);
  - parse failure → settled with `failed to parse xlsx: …` (the load's own error text);
  - build failure → settled with the build's error;
  - `/load/stream` settles via a `finally` around the stream body, so no exit path
    (built / parse-error chunk / build-error chunk) can leave reads hanging.
- `/read` now starts with `await waitForLoadBuild()`:
  - build in flight → the read **pends** (bounded by exported
    `BUILD_WAIT_TIMEOUT_MS = 600_000`, the load route's 600 s timeout class) and is then
    served normally from the new workbook;
  - build failed → the waiting read surfaces the build's error via the outer catch
    (500, `engine error: <build error>` — a real error, correctly). The error is **sticky**:
    reads after the failure surface it too, until the next successful load or a `/reset`
    clears it (`/reset` explicitly clears it);
  - no build in flight and no sticky failure → **zero behavior change**, including the
    honest `Unknown sheet` 500 for a genuinely nonexistent sheet (pinned by test).
- The gate promise never rejects (the error rides on the gate object), so a build with
  no waiting reads cannot produce an unhandled rejection.
- Design-contract check: HYBRID-CONSISTENCY.md specifies the ack/revision/read-your-
  confirmed-state rules for edits; the read-during-build shape follows the task's expected
  shape (pend on the build, serve the new state; a failed build is a real error) and the
  Cycle 10 rule that the view is progressive while unbuilt state is never served as if
  final. No client change was needed — Chrome's `Failed to load resource: 500` console
  noise disappears because the 500s themselves disappear; bulkReads/RemoteView already
  fail-soft on transport errors.

### `packages/gateway/src/gateway.ts` — read timeout class

- `/api/engine/read` joins the 600 s upstream-timeout class (`LOAD_UPSTREAM_TIMEOUT_MS`)
  alongside load/snapshot/download/library, with the rationale in a comment. Without this,
  a correctly pended read would still be cut at 30 s by the proxy (the 502 class).
  Body cap unchanged (1 MB default — read bodies are small).

### Bin `requestTimeout` alignment (both 300 s Node defaults → 660 s)

- `packages/gateway/src/bin/engine.ts` and `packages/gateway/src/bin/gateway.ts`:
  `server.requestTimeout = 660_000`, so Node's default 300 s whole-request cap cannot
  sever a pended read or a long `/load/stream` before the 600 s class governs.
  `headersTimeout` untouched (request headers still arrive promptly; the wait is
  response-side).

## 3. Tests

New suite `packages/gateway/tests/engineSvcReadDuringBuild.test.ts` — **5 tests, all pass**:

1. `/load/stream` of the real geocode fixture with a decoy workbook pre-loaded: reads
   fired the moment the `meta` chunk arrives (cell, range, deep-row cell) all pend and
   resolve **200 with the new file's values** (`Cities!A1 = "name"`, header row
   `name/country/subcountry/geonameid`).
2. Classic `/load`: a read issued 400 ms into the load pends and resolves 200, correct value.
3. Failed build: `/load` of non-xlsx bytes → 400 to the loader; a subsequent read surfaces
   `failed to parse xlsx` (500); a successful load clears it (reads serve the new file);
   `/reset` also clears it.
4. `/load/stream` with failing parse: a read waiting on the gate is **released with the
   build error** (500, `failed to parse xlsx`), not left hanging; the stream keeps its
   existing error-chunk contract.
5. No build in flight: read behavior unchanged — normal reads 200, and a read for a
   genuinely unknown sheet still returns the honest 500 `Unknown sheet: Nope`.

Suites (full runs, final code):

- **Gateway: 172/172 pass** (167 pre-existing + 5 new), 17 files.
- **Engine: 987/987 pass**, 44 files (no engine-package changes; run per instructions).
- Gateway `tsc -p` build: exit 0.

## 4. Browser re-validation (rebuilt gateway/engine, stack via start-stack-finisher.sh)

Curl-level repro first (same script as the pre-fix repro, geocode via gateway):

- Before: reads after `meta` → **500, 500, 500** (`Unknown sheet: Cities`, ~15 ms each).
- After: the same reads **pended** (answered at t≈2,838–2,870 ms, as the ~2.9 s build
  finished) → **200 with correct values**, direct-to-engine read included. All 9 reads 200.

### (a) geocode.xlsx gateway tour (pw2 `tour.mjs`, tag `w20-geocode`)

- **Console errors: 1× 404 only — the pre-existing baseline resource 404. ZERO read-500s**
  (W18: 81× run 1 / 105× run 2).
- Sheet `Cities` renders: 748 viewport cells, **136 non-empty**, real city data
  (screenshot self-inspected: name/country/subcountry/geonameid rows, e.g. les Escaldes /
  Andorra; status bar Ready/✓ Saved).
- Formula-error cells: 0 · page errors: 0 · **tour save ok (2,988 ms)**.
- Evidence: `hidden_files/cycle10-closure/w20-shots/w20-geocode-tour.json` + screenshots +
  `downloads/w20-geocode-saved.xlsx`. Load wall 4,683 ms, TTFP 1,216 ms.

### (b) P95 open (new harness `w20-p95open.mjs` — w18-perf pattern + per-response status capture; no save attempted, per scope)

- **read-500s: 0 · 502s (all routes): 0 · failed requests: 0 · responses ≥400: none.**
  (W18: 65–120 read-500s + 5× 502 per run.) Only console error: the baseline 1× 404.
- Load completed: wall **55.4 s**, TTFP **2,525 ms**, 3 sheet tabs (Sales / Inventory /
  Ledger), 408 non-empty viewport cells, browser heap 407.9 MB, no load timeout.
- Gateway log cross-check for the whole re-validation session: **zero** `status=500` and
  **zero** `status=502` lines; longest `/api/engine/read` durations **47.3 s, all 200** —
  the pended reads the old 30 s proxy timeout would have 502'd.
- Raw output: `hidden_files/cycle10-closure/w20-p95open.json`.

## 5. Before / after

| Scenario | Before (W18) | After (W20) |
|---|---|---|
| geocode.xlsx tour console errors | 81–105× read-500 (+1 baseline 404) | **0× read-500** (1× baseline 404 only) |
| P95 open read-500s | 65–120× per run | **0** |
| P95 open 502s | 5× per run | **0** |
| Read during parse window | 500 `Unknown sheet` in 1–28 ms, or stale old-file values | Pends on build gate → 200, new-file values |
| Read after failed build | stale/blank-workbook answer or unrelated `Unknown sheet` | Surfaces the build's own error until next good load/reset |
| Gateway suite | 167 | **172** (5 new) |
| Engine suite | — | **987** |

## 6. Left unfixed / notes

- **Nothing from this defect is left unfixed.** Both error classes (500 at the engine,
  502 at the gateway) trace to the one build window and both are closed and re-validated
  at zero.
- Out-of-scope observations, recorded not fixed:
  - Other engine routes issued during a build window (`/sheets`, `/events`, `/execute`,
    `/snapshot`) are not gated — they were not part of the measured defect (the client
    issues reads in volume during opens; mutation is already client-gated on `built`).
    A `/sheets` call mid-window would still answer from the previous workbook. Gating
    them is a one-line reuse of `waitForLoadBuild()` if the parent wants it.
  - The build-wait timeout expiry (a build exceeding 600 s) surfaces as a 500 with an
    explicit "timed out … waiting for the workbook build" message — by design (a build
    beyond the load budget is a failed load), never observed in any run here.
- Final state: full stack left running on the rebuilt code (gateway :8100, engine :8101,
  vault :8102, meta :8103, etl :8104, agent :8105, MCP :8106, addons :8107, web :4173 —
  all `/health` 200; e2e-tester login + engine reset verified after the tours).
