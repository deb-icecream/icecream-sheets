# W21a — P95 SAVE BISECT results (A/B: completion-pass build vs current build)

**Date:** 2026-10-21 (PDT) · **Worker:** W21a bisect · **Repo:** ~/workspace/icecream-sheets
**Mandate:** bisect FIRST, no save-fix implementation. perf-evaluation.md / progress.md /
TODO.md NOT edited. No GitHub push. Scratch builds + raw evidence live OUTSIDE the repo in
`~/workspace/w21a-scratch/` (variants, RSS traces, engine/gateway logs, saved files).

## Verdict up front

**No save-path code change between the completion-pass build (A) and the current build (B)
explains the W18 death. Measured: A and B have the same save memory profile (engine peak
≈ 4.6–5.6 GB sampled on a ~1.7–1.9 GB plateau), and BOTH builds die in the real browser
flow on today's host (gateway 502 at 63.5 s for A, 68.1 s for B; kernel-kill signature, no
V8 fatal line) and BOTH complete engine-direct. The completion-pass 108.9 s pass and the
W18/today browser deaths are the same ~5 GB-class serialization spike meeting different
host headroom (Chromium co-residency + rest of stack + this VM's virtio-balloon, measured
at up to 4.95 GB silently reclaimed while idle). The defect is structural — a second
full-model serialization inside the session's own engine process at a ~3.4 GB transient
over plateau — not a regression introduced by W2, W9/D4, or W16. §2a's heap flag is
present and effective in every launch path checked (details §3); it is NOT dropped.**

The briefed fix (verbatim part copy + streaming writer, worker-process isolation per the
addendum) remains the right remedy — as NEW work, not as a revert. §6 details what the
measurements say it must achieve.

## 1. Version A — provenance and exact composition

- Source of truth: GitHub `is-cream/icecream-sheets` @ commit
  **`c2e310cf7363453112af02affd7eb83c8258b065`** (2026-10-20T15:33:41Z) — the tree tip of
  the completion-pass sign-off push batch (per-package batches 15:23:39–15:27:26Z =
  08:23–08:27 PDT, matching the ~08:25 PDT sign-off). Fetched read-only via the GitHub
  MCP connector (`get_file_contents` at that ref); preserved at
  `~/workspace/w21a-scratch/fetched-A-src/`.
- Fetched COMPLETE at A: `packages/gateway/src/**` (incl. `engineSvc.ts`, 1,101 lines vs
  B's 2,493), `packages/xlsx-adapter/src/**` (all 19 files), `packages/service/src/**`.
- **Not fetched: the GitHub MCP began returning HTTP 429 (rate limit) mid-fetch and was
  treated as a hard stop.** Missing: most of `packages/engine/src/**` (13 of ~55 files
  landed; `workbook.ts`/`protocol.ts` did not), all of `apps/web/src/**`, and
  `packages/gateway/src/bin/gateway.ts`. Consequence: the runnable "A-savepath" variant =
  **A gateway service code (incl. A `engineSvc` + A `/download` handler) + A xlsx-adapter,
  compiled against the CURRENT (B) engine package and B service dists**, with a minimal
  harness gateway runner (A-era route table; documented in the scratch tree). The B web
  dist drove the browser runs (A's handler ignores the `sheetStyles` field it doesn't
  know). The A engine *package* could not be A/B-built this attempt — see §5 for what
  that does and does not leave open.

### A vs B save path, from source (fetched A files diffed against current)

- A's `/download` (engineSvc.ts, A line 948): xlsx-only; extras =
  {format, filename, extraMetadata, definedNames, sheetDims}; body =
  `snapshotToWorkbookData(filteredSnapshot(principal), metadata, definedNames)` →
  `new XlsxAdapter().write(wbData)` → 256 KB-chunked response. **Identical pipeline to
  B's whole-workbook path** (the correction in the re-brief is confirmed from source:
  the dense conversion was born with defect 2c's fix, not with W2).
- Deltas in B's handler: format generalization (xlsb/csv/tsv/ods/html), named-range scope,
  library-save, E1 defined-names merge, **D4 styles/formats attach** (client
  `sheetStyles` authoritative per sheet; source formats/styles fallback), W17b session
  lifecycle, W20 read gate. A retains NO source formats/styles state at all (no
  `sourceSheetFormats`/`sourceSheetStyles` in A's EngineState).
- Adapter A→B diff is EXACTLY the D4 `stylesXml.ts` module (new file at B): read-side
  `applyNativeStyles`, write-side `injectCellStyles`, one `rowsToWorksheet` guard.
  Nothing else in the adapter changed.
- **Fixture fact that disciplines the styles theory:** perf-p95.xlsx carries 420,001
  number-formatted cells (Sales 180,001 / Inventory 60,000 / Ledger 180,000) but
  **zero full `CellStyle` records** (adapter read: `styles: 0` per sheet; the fixture's
  styles.xml is 3.2 KB, 6 cellXfs, formats are numFmt-only). So server-side, B's
  `injectCellStyles` **never engages for this fixture without client extras**, and with
  the browser's extras it engages as a scan whose xf merges are no-ops (measured cost:
  +10.9 s serialization, §4 run 5). It is not the peak driver at P95.

## 2. Runtime-flag verification (checked FIRST, from live processes — not script text)

| Check | Result |
|---|---|
| Live engine cmdline (finisher stack) | `node --expose-gc --max-old-space-size=6144 dist/bin/engine.js` — read from `/proc/<pid>/cmdline` on two separate stack starts |
| `hidden_files/start-stack-finisher.sh` | line 16 starts the engine with `--expose-gc --max-old-space-size=6144` |
| `packages/gateway/package.json` `start:engine` | `node --expose-gc --max-old-space-size=6144 dist/bin/engine.js` — flag present |
| Flag effect on this Node (v24.20.0 probe) | `v8.getHeapStatistics().heap_size_limit`: **6,336 MB with the flag vs 2,240 MB default** |

So §7 defect 2a's load-bearing flag is applied in both launch paths today. Note the
death signature is inconsistent with a dropped flag anyway: a 2,240 MB heap limit dies
with a V8 `FATAL ERROR: Ineffective mark-compacts…` line in the engine log (the original
2a signature); **no engine log in any run below (B or A, direct or browser) contains a
FATAL line** — the processes vanish mid-serialization, i.e. SIGKILL from the host
(kernel OOM), at RSS values (4.4–5.6 GB) BELOW the 6,336 MB heap cap.

## 3. Host factor measured today: virtio-balloon

`/proc/meminfo` `Balloon:` was **4,952,888 kB (≈4.95 GB)** when first checked this
session — the host had silently reclaimed ~64% of the VM's 7.7 GiB while the stack sat
idle (total process RSS at that moment: 341 MB; `MemAvailable`: 1.5 GB). Under memory
pressure the balloon deflated (0–1.7 GB during the measured runs; 0 at the end of two
runs). It cannot be controlled from inside the guest. During W18's gate the balloon state
is unrecorded; W18 did record "available memory recovered to 4.7 GiB" after the death,
which bounds total non-engine demand then. The balloon is a real, measured co-factor for
ANY marginal-memory workload on this VM, and it was at its worst today before the first
run. All runs below note their balloon state; none of the deaths required it (browser
runs died with balloon ≤ ~1.2 GB).

## 4. Measurements — identical protocol, quiet host

Protocol per run: fresh engine (nothing else loaded, main stack stopped for direct
runs) → P95 loaded through the gateway (`/load/stream`, base64 fixture) → 5 s settle
(plateau = median RSS over the pre-save window) → save via `POST /api/engine/download`
(direct runs: driver streams the response to disk; browser runs: pw2 `tour.mjs`, real
web app, drag-drop load, every-sheet tour, Ctrl+S download dialog flow) → 2 s-cadence
RSS sampler on the engine pid throughout → parse-back with the repo XlsxAdapter
(value/formula cell counts). Host: 2 cores, 7.7 GiB, no swap. W20's validation was
finished before these runs; nothing else heavy ran concurrently.

| # | Build | Flow | Extras | Plateau | Peak RSS (2 s sampler) | Engine serialization | Gateway wall | Outcome | Output |
|---|---|---|---|---|---|---|---|---|---|
| 1 | B | direct | minimal | 1.70 GB | **5.05 GB** | 41.1 s | 59.2 s (200) | **SURVIVED** | 80,176,889 B — parse-back **exact** 1,320,031 + 480,005 |
| 2 | B − `injectCellStyles` | direct | minimal | 1.65 GB | 5.59 GB (last sample) | — | 502 @ 60.1 s | **DIED ~60 s** | none |
| 3 | A-savepath | direct | A-era | 1.91 GB | **5.13 GB** | 46.8 s | 48.0 s (200) | **SURVIVED** | 77,656,582 B — parse-back **exact** |
| 4 | B | direct | realistic client payload (16.8 MB `sheetStyles`, 420,001 entries) | 1.72 GB | 4.59 GB | 52.0 s | 71.9 s (200) | **SURVIVED** | 80,176,889 B — parse-back **exact** |
| 5 | B (full finisher stack) | **browser tour** | real client | — | 4.37 GB | — | **502 @ 68.1 s** | **DIED ~68 s** | none; downloads dir empty |
| 6 | A-savepath (+ B web) | **browser tour** | real client | — | 4.69 GB | — | **502 @ 63.5 s** | **DIED ~63 s** | none; downloads dir empty |

Historical anchors: completion pass (full A incl. A engine package): browser flow
**SURVIVED**, wall 108.9 s, serialization 75.1 s, output 77,659,232 B, parse-back exact.
W18 final gate (B, browser, quiet host): **DIED** ~49.6 s, sampler peak 4.12 GB.

Reading the table:

- **Peaks do not separate A from B.** Direct peaks: B 5.05 / B-nostyles 5.59 /
  A-savepath 5.13 / B-realextras 4.59 GB — one band (~±0.5 GB sampler noise on a spike),
  ~+3.4 GB over plateau in every build. Run 2's patch was later proven inert for this
  fixture (§1: no server-side styles at P95), so runs 1/2/4 are three samples of the
  SAME B serializer: survived, died, survived — run-to-run variance at the ceiling,
  not a code difference.
- **The browser flow kills both builds** (runs 5/6, replicating W18 for B and new for
  A). The delta direct-vs-browser is co-residency: Chromium (tab JS heap measured
  380.7–457.7 MB; total browser RSS several× that) + gateway + 7 sibling services +
  vite, on top of the engine's ~5 GB-class spike, against 7.7 GB minus balloon.
- **Plateau went DOWN, not up, A→B** (1.91 → 1.70 GB, same B engine package in both
  variants; the difference is engineSvc load-path retention — W16-era run-length
  formats + parsed-row release working as intended). Residency growth is not the story.
- Second-order A→B growth that IS real but does not decide survival: with the real
  client payload, B's serialization is 52.0 s vs B-minimal 41.1 s (**+10.9 s** for the
  D4 client-styles attach + `injectCellStyles` scan) and B's output is
  **+2,520,307 B** larger than A's (80,176,889 vs 77,656,582; B writes per-cell format
  codes for the 420,001 formatted cells). A's own serialization (46.8 s) sits between
  B's two numbers. (The historical A output was 77,659,232 B — 2,650 B above today's
  A-savepath output; the delta rides on the B engine package's snapshot inputs, since
  the serializer bytes are A's own.)
- Death timing varies (49.6 s W18 / ~60 s run 2 / 63.5 s A-browser / 68.1 s B-browser)
  because the spike's crest arrives at different points in each serialization; the
  signature (gateway 502, engine process gone, no FATAL line, no file) is identical in
  every death, including the completion-era defect-2a lookalike — except 2a WAS a V8
  heap death and these are not (flag verified in effect, §2).

## 5. What this bisect could not test (stated plainly)

- **A engine package** (`packages/engine` at A): not fetched (GitHub MCP HTTP 429 hard
  stop mid-fetch; 13/~55 files landed). All A-variant runs therefore used the B engine
  package — workbook residency and snapshot production are B's in every run. If a
  W16 engine-package change raised the SERIALIZATION-side peak (e.g. value-cache
  behavior during snapshot), this bisect cannot see it: it would be present in both
  arms. What bounds the risk: the measured plateau (which the engine package dominates)
  is LOWER in the B arm than perf-evaluation §2a recorded for the completion-era stack
  (2.24→2.41 GB during a /snapshot call), and the A-arm plateau with the B engine
  package (1.91 GB) is not above B's. A follow-up fetch (fresh rate-limit window) +
  an A-engine build would close this arm completely.
- Sampler granularity: 2 s cadence under-reads the true crest (deaths occur between
  samples). All peaks are lower bounds; comparisons use them consistently.
- One run per cell (two for B-direct-equivalent): the marginality of the outcome IS
  the finding, but exact death probabilities per build are not estimated.

## 6. Recommendation — what the fix should restore vs build new

- **Restore: nothing.** Reverting W2's generalization, W9/D4's styles attach, or W16's
  memory work would not recover the completion-pass result: the A build of that exact
  save path died in the browser flow today (run 6), and B's plateau is lower than A's.
  The 108.9 s pass was the same spike under kinder headroom, not a leaner serializer.
- **Build new (as briefed + addendum), targeting the measured profile:**
  1. The serialization transient is **~+3.4 GB over plateau** (snapshot → dense grids →
     SheetJS model → zip, plus per-format passes). Verbatim part copy + a streaming
     row-by-row writer removes the second full model entirely — for an unedited P95
     save the added memory should be ~the source bytes (12.7 MB), not ~3.4 GB. That,
     not any revert, is what moves the peak out of the death band.
  2. Worker-process isolation is independently justified by these runs: even a
     PERFECT in-engine serializer shares fate with the session on a host whose
     balloon alone can remove 4.95 GB. With the save in a worker, the worst case
     measured here (worker SIGKILL at the crest) becomes a save error, not a dead
     session — and the live engine's plateau (1.7 GB) leaves the worker ~5 GB of
     honest headroom on this VM.
  3. Keep §2a's `--max-old-space-size=6144` (verified load-bearing: default heap here
     is 2,240 MB) and consider asserting it at engine startup (log
     `v8.getHeapStatistics().heap_size_limit` at boot) so a future launch-path change
     can't drop it silently — the two death signatures (V8 FATAL vs kernel SIGKILL)
     are distinguishable in logs only if someone looks.
- **Stopping here per instructions** — no fix code written. Coordinator to confirm
  before the W21 implementation (verbatim copy + streaming writer + worker isolation)
  proceeds. If the coordinator wants the A-engine arm closed first, the remaining
  fetch is ~42 files of `packages/engine/src` + `apps/web/src` at ref
  `c2e310cf7363453112af02affd7eb83c8258b065` in a fresh GitHub rate-limit window.

## Evidence index (all in ~/workspace/w21a-scratch/)

- `results/{B-direct,B-nostyles-direct,A-savepath-direct,B-realextras}/` — measure JSON,
  RSS traces, engine/gateway logs, saved files (surviving runs).
- `results/{B-browser,A-browser}/` — tour JSON + screenshots + RSS traces (deaths).
- `fetched-A-src/` — the A sources as fetched from GitHub @ c2e310cf73.
- `B-nostyles/`, `A-savepath/` — the scratch variant trees; `measure.mjs`,
  `parseback.mjs`, `make-extras.mjs`, `run-variant.sh`, `real-extras.json` — harness.
- Final state: main stack restarted via the finisher script and left healthy
  (all 9 ports 200, engine with the verified 6144 flag).
