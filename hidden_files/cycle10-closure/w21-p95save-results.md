# W21b — P95 SAVE FIX: results

**Status: complete — verified by W21c (2026-10-21).** The gateway-mode P95
save completes in the browser flow on this 7.7 GiB VM, with exact parse-back,
a live engine afterwards, and the serialization transient moved out of the
engine into a per-save worker process. §3 carries the evidence item by item
(each marked artifact-verified or re-run by W21c); §5 names every fallback
and three residuals (the `_xlcn.*` defined-name degradation, §5.7, the
engine handoff transient, §5.8, and structured-reference expansion
on regenerated sheets, §5.10).

---

## 1. Architecture

### 1.1 Spawn model — per-save worker process

Every whole-workbook `.xlsx` save (`/download`, and `/library-save` which
shares the handoff) is executed by a **freshly spawned Node child process**
(`packages/gateway/src/bin/saveWorker.ts`, spawned by
`services/saveWorkerSpawn.ts`), never by the engine that owns the session.

Why per-save spawn (not a pool, not worker threads):

- The bisect proved the failure is a *fate-sharing* failure: in-engine
  serialization dies with the session. A process boundary is the guarantee;
  threads share the heap and the fate.
- A fresh process per save has exactly one job, a clean heap, and no state
  carried between saves to corrupt or leak. Pool reuse was rejected: a
  pooled worker that survived a bad save would need the same distrust
  machinery the checksum already gives us per-save, for no measured benefit
  at save frequency.
- If the worker dies (OOM, kill, timeout), the engine returns
  `500 download serialization failed: …` and the session is untouched —
  proven live in §3.5.

The live engine's whole part in a save: build the handoff (source bytes
reference, executed-op journal, merged metadata, live defined names,
client-reported sheet styles/dims, expected state checksum), spawn, stream
the worker's output file back. Engine transients at handoff are bounded and
GC'd before spawn (`maybeGc()` at the end of `buildSaveHandoff`).

**Heap budget.** `SAVE_WORKER_HEAP_MB` (default **3072**, clamped
48–8192) is passed as `--max-old-space-size` to the worker. Rationale: the
worker's *designed* working set is streamed (below), but its rebuild phase
must hold a full engine graph — measured plateau ~1.6 GB, the same as the
live engine's. 3072 MB gives the rebuild + one bulk readback headroom
without letting a pathological serialize grow into the host: total host
footprint during a save = engine plateau ~1.7 GB + worker peak + browser
~0.5 GB + services ~0.9 GB must fit 7.7 GiB *after* balloon variance.
Timeout `SAVE_WORKER_TIMEOUT_MS` default 570 s (gateway upstream is 600 s).

**Peak-RSS accounting is honest by construction.** The worker self-samples
`process.memoryUsage()` every 200 ms, but that sampler goes blind during
long synchronous serialize stretches (its event loop is blocked exactly
when allocations peak — the first browser run "reported" 938 MB while an
external sampler saw 2.4 GB). The parent therefore also samples
`/proc/<pid>/status` VmRSS every 250 ms while it waits, and the reported
`workerPeakRssMb` is the max of the two. The numbers in §3 are the
parent-sampled ones.

**Orphan watchdog.** The worker checks `process.ppid` every second; if it
is reparented (the engine died — the exact failure this design isolates),
it exits instead of lingering with gigabytes resident.

### 1.2 Rebuild + verify (the guarantee layer)

The worker rebuilds workbook state through the engine's own rehydration
path (`services/saveWorkerCore.ts`):

1. `parseWorkbookFast` over the retained source bytes (the bytes the
   engine kept from `/load`), `registerDataModelCubes`, `EngineWorkbook`
   construction with the source's defined names / external links /
   imported pivots, a `freshHost()` wired exactly as the engine service
   wires it (ProtectionManager, owner hidden-exempt, Authorizer), and
   protection state hydrated from the merged save metadata.
2. The parsed grids are released **before** replay (the W16 load
   discipline), then the session's executed-op journal is replayed in
   order under owner authority. The journal is captured in `engineSvc`'s
   `/execute` for every successful mutating op (`SAVE_MUTATING_OPS`),
   capped at 200,000 ops (see §5).
3. **Checksum gate.** The worker computes the whole-workbook state
   checksum over its rebuilt state and compares it to the live engine's
   checksum computed at handoff (`expectedChecksum`). Mismatch →
   `SaveChecksumError` (worker exit 3), **no file is emitted**, the
   client gets a save error. Serialization never starts on unverified
   state.

   The checksum (`services/saveChecksum.ts`) uses the engine's
   ack-checksum *serialization* — sheets in name order, cells sorted by
   (row, col), one typed-value line per cell (`serializeAckValue`),
   U+0003 between lines — but digests it with **streaming SHA-256**,
   not `computeAckChecksum`'s FNV-1a. Measured reasons at 1.8M cells:
   the FNV path materializes ~150 MB of line strings (itself a
   save-class transient in *both* processes) and its byte-wise BigInt
   loop cost ~75–80 s of the worker's rebuild. Streaming SHA-256 over
   the identical serialization costs ~3.6 s and O(1) extra memory.
   Both sides of the save gate call the same function, so the
   comparison is exact; the per-edit ack path (small sets) keeps FNV
   untouched. The checksum is the **owner's** view (state truth); the
   serialized product is the **requesting principal's**
   permission-filtered view (§5h).

4. One bulk readback serves both the checksum and (when requester ==
   owner, the ordinary save) the serialization grouping — the 1.8M-cell
   pass is never paid twice.

### 1.3 Verbatim part copy (inside the worker)

The output package is assembled from the **source zip's parts**
(`packages/xlsx-adapter/src/streamingSave.ts`):

- The changed set is derived, not assumed: sheets touched by cell ops in
  the replayed journal ∪ sheets whose *resolved presentation* differs
  from the source's ∪ sheets with no source part. Resolution happens in
  the worker: the engine forwards only what the client *reported*
  (per-sheet styles/dims overlays); the worker compares them against its
  own parse of the source (per-cell resolved (style, formatCode) pairs —
  a client `{numberFormatCode: X}` equals a source formats entry X).
  "Reported" alone never forces regeneration: the browser reports every
  sheet on every save, and an unedited save comes out with
  `changedSheets=0` (§3.6).
- Untouched parts — unmodified sheets' XML, charts, media, drawings,
  theme, docProps — are copied **byte-for-byte** (hash-proven in §3.4).
- Changed sheets are regenerated row-by-row (§1.4) from the rebuilt,
  verified state.
- **Workbook-global parts.** `styles.xml`: regenerated only through an
  append-only streaming resolver (`createStreamingStyles`): original
  cellXfs keep their indices, new (style, format) pairs append, so
  verbatim sheets' `s=` indices stay valid. `sharedStrings.xml` is
  **never modified** — regenerated sheets write strings as `inlineStr`,
  so append-only holds trivially. `workbook.xml` is touched only when
  the defined-names table actually changed (surgical regeneration that
  preserves `_xlnm.*` entries raw). `docProps/custom.xml` regenerates
  only when the `icecream.*` metadata changed. `calcChain.xml` is
  dropped (with its content-type override) whenever any sheet changed
  — Excel rebuilds it; keeping a stale chain is the corrupt option.
- Structural ops (insert/delete rows/cols, sheet add/delete/rename,
  calculation mode, …) or a changed sheet set make the save
  verbatim-ineligible: it falls back to `XlsxAdapter.write` over the
  rebuilt snapshot **inside the worker** (isolation + checksum still
  hold; the mode is reported as `adapter-fallback`). A verbatim-planning
  exception takes the same in-worker fallback rather than losing the save.

### 1.4 Streaming writer

Changed sheets are generated by the `sheetXmlChunks` generator —
row-by-row from the grouped verified cells, preserving the source
sheet's head/tail XML (dimension, cols, sheetViews, page setup travel
with the part) — into temp files, then streamed into an fflate
streaming `Zip` (`ZipDeflate`, level 6, stable mtime) written
incrementally to the output file. At no point on this path is a whole
sheet's XML string, a whole-workbook SheetJS object, or the whole zip
materialized. Before the zip phase, the worker drops the rebuilt
engine graph and the bulk wrappers (`workerGc()` at phase boundaries):
the worker's peak is the **max** of its phases, not their sum
(serialize phase measured at 10.6 s / well under the graph's footprint
in isolation, down from 33.9 s before the release was added).

### 1.5 Handoff slimming (engine side)

Two engine-side transients were found and removed while building this:

- `buildSaveHandoff` originally read defined names via
  `host.snapshot()` — which *unparses every formula cell* (480k
  `getSerialized` calls at P95) just to read the names table. The engine
  gained an additive `EngineHost.getDefinedNames()` passthrough
  (O(names), the same pattern as the existing `sheetNames()` fix for
  this exact trap); the handoff uses it.
- The handoff no longer decodes/forwards source styles — the worker's
  own parse of the same bytes is the same record (§1.3).

---

## 2. Bisect → design mapping

| W21a bisect finding | Design response |
|---|---|
| Serialization transient ≈ +3.4 GB over the ~1.7 GB engine plateau; peaks one 4.6–5.6 GB band | Serialization moved to a separate process with its own heap budget (§1.1); the engine's save-time footprint is the handoff only, then plateau |
| Browser co-residency (Chromium + 8 services) tips the combined peak over 7.7 GiB; kernel SIGKILLs the engine (largest RSS) | The transient now peaks in a *disposable* process; if anything is killed, it is the worker and the client gets an error — the session cannot be taken down by a save (§3.5) |
| Engine-direct saves survive unfixed (41–52 s) — the path was never wrong, its *location* was | Same serializer semantics (permission-filtered snapshot content, E1 names rule, client-authoritative styles) reproduced in the worker; correctness pinned by parse-backs + the per-principal gateway test |
| `--max-old-space-size=6144` verified live on the engine | Engine flags untouched; worker gets its own explicit budget (`SAVE_WORKER_HEAP_MB`, default 3072) |
| W9 styles module inert for P95 (numFmt only) | Styles handling is resolution-based, not module-based: (style, formatCode) pairs resolved per cell; append-only xf merge keeps verbatim sheets valid (§1.3) |
| virtio-balloon silently reclaims up to ~4.95 GB while the VM idles (≈64% of 7.7 GiB; MemAvailable fell to 1.5 GB with only 341 MB of process RSS); it deflates under real pressure (0–1.7 GB during W21a's measured runs) and cannot be controlled from inside the guest [row completed by W21c from w21a-bisect-results.md §3] | No in-guest control exists, so the design budgets for it: the worker heap default (3072 MB) is sized so engine plateau (~1.7 GB) + worker peak + browser (~0.5 GB) + services (~0.9 GB) fit 7.7 GiB *after* balloon variance (§1.1). W21c's re-analysis of the W21b traces: balloon 0–1,924 MB during the API save window, 0–1,487 MB during the browser save window (§3.1/§3.2) |

---

## 3. Acceptance evidence (verified by W21c, 2026-10-21)

W21b ran the acceptance work but died before writing this section. W21c
re-derived every number below from the artifacts in `w21-evidence/` (plus
`/tmp/gwlogs/gateway.log` and `/tmp/w21probe/`) and re-ran whatever the
artifacts did not prove. Tags: **[artifact-verified]** = recomputed by W21c
from W21b's on-disk artifacts; **[re-run by W21c]** = executed fresh by
W21c on the current code.

RSS traces: `/tmp/w21-sampler.sh` decodes the format — 1 s cadence,
`ts engineKB workerKB(max single) workerCount availKB balloonKB`, all RSS
via `ps`. The engine's own `/download` log lines for the two P95 runs were
lost when the engine was restarted during the failure-mode test (§3.5);
P95 mode is proven from the saved products' part structure + the worker
process's presence in the traces instead (§5.9).

### 3.1 API-level P95 save + parse-back [artifact-verified]

- `api-p95-measure.log`: load wall 46.0 s; save **HTTP 200**,
  16,437,549 bytes, wall **186.9 s**, `engineAliveAfter: true`,
  `deathAtS: null`. The harness's plateau/peak are the *engine* pid:
  plateau 1,836,596 KB (1,794 MB), peakSave 2,590,800 KB (2,530 MB) —
  the peak matches `rss-api-p95.txt` engine column max exactly.
- `rss-api-p95.txt`, worker window t+70–237 s (168 s): worker (`ps` RSS)
  peak **2,494 MB**; engine ≤ 2,352 MB inside the window and **1,693 MB
  at the worker's crest second**, settling to 1,695 MB after the window;
  MemAvailable minimum 72 MB; balloon 0–1,924 MB in-window.
- Honest qualification: the engine's own 2,530 MB peak lands at t+68 s,
  immediately *before* worker spawn — that is the handoff (bulk readback
  + expected checksum), ≈ +736 MB over the 1,794 MB plateau median. It
  is not the old 4.6–5.6 GB serialization spike (§2), and at the
  worker's crest the engine sat at plateau.
- **Parse-back (W21c streaming count of the file on disk): exact.**
  Source fixture, `api-p95-saved.xlsx`, and the browser-saved file
  (§3.2) all count identically: **1,800,036 cells = 1,320,031 value
  cells + 480,005 formula cells**, exactly the expected counts. The
  value cells decompose as 720,000 numeric `<v>` cells + 600,031
  string cells (the fixture stores strings as inlineStr; it has no
  sharedStrings part); every formula cell carries a `<v>` element.
- Spot values (identical in source / API-saved / tour-saved):
  Sales!A2 = 100002; B2 = 45140; H2 = 0.0307; formulas preserved
  verbatim — I2 `F2*G2*(1-H2)`, K2 `I2+J2`. The spot-checked source
  formula cells ship *empty* cached values; the API-saved file carries the computed
  caches (I2 = 78250.47430500001, K2 = 84510.51224940001), matching
  the browser DOM samples (78250.47431 / 84510.51225).
- numFmt-styled cell: Sales!B2 carries s=2 in the source (xf numFmtId
  164, `yyyy-mm-dd`). The API-saved file remaps it to appended xf 6
  with the **same numFmtId 164** (+ `applyNumberFormat`); styles.xml
  grew 3,204 → 3,459 B with original xfs 0–5 untouched — append-only
  resolution preserved the format (§1.3).
- Defined names: **perf-p95.xlsx's defined-names table is empty**
  (`<definedNames/>`) in the source and in both saved files, so no
  defined-name-dependent cell exists in this fixture to spot-check.
  Name preservation is evidenced on P75 instead (§3.4).
- Scope note: this was an API-level run (gateway `/load/stream` +
  `/download` with a client payload). It does not by itself satisfy
  the browser-flow item — §3.2 does.

### 3.2 Browser-flow P95 save [artifact-verified]

- `tour-p95.log` / `tour-p95/p95-tour.json`: all 3 sheets toured
  (Sales / Inventory / Ledger), 0 DOM error values; save
  **ok: true, 182,511 ms** browser-observed, product
  `tour-p95/downloads/p95-saved.xlsx`, **13,524,008 bytes** on disk.
- Gateway corroboration (`/tmp/gwlogs/gateway.log`):
  `POST /api/engine/load/stream` 200 in 48,008 ms;
  `POST /api/engine/download` **200 in 175,849 ms** (the browser
  figure adds dialog handling), followed by continued session traffic
  and the P75/P50/edit-guard saves on the same engine.
- `rss-tour-p95.txt`, worker window 0 (t+95–250 s, 156 s): worker
  peak **2,407 MB**; engine ≤ 2,512 MB inside the window, **1,753 MB
  at the worker's crest second**, ~1,757 MB at window end and still
  resident afterwards; MemAvailable minimum 153 MB in-window; balloon
  0–1,487 MB. The engine's overall peak, 2,823 MB at t+93 s, is the
  same pre-spawn handoff transient as §3.1.
- Parse-back of the browser-saved file: **exact** (same counts as
  §3.1). Part diff vs source (hash check, §3.4 method): only
  `[Content_Types].xml`, `docProps/custom.xml` (added — icecream
  metadata), `xl/styles.xml` (append-only), and
  `xl/worksheets/sheet3.xml` (Ledger) differ; Sales and Inventory
  parts are byte-identical, which is the verbatim mode's signature.
  Style indices survive verbatim (B2 s=2, H2 s=4, as in the source).
  Ledger cell-level diff (480,010 cells each side, none added or
  lost): **0 formula diffs**; the only value diffs are 60,002 —
  every Ledger formula cell — whose cached value went from empty
  in the source to the computed value (e.g. G34787 →
  −16334142.88). No value was lost or altered.
- Verdict: the browser-flow P95 save **completed** under the worker
  architecture with the engine alive afterwards. The evidence is
  complete and mutually corroborating, so W21c did not re-run the
  3-minute browser save.

### 3.3 P50 / P75 gateway saves [artifact-verified]

- **P50** (`tour-p50.log`): 21 sheets toured, 0 errors; save ok,
  4,844 ms browser-observed; product on disk. Parse-back totals
  identical to source: 5,646 cells / 2,403 formulas / 3,942
  value-or-inline. Part diff: `docProps/custom.xml`, `xl/styles.xml`,
  `xl/worksheets/sheet21.xml` only (56 parts SAME, 3 DIFF); 23 string
  cells on the regenerated sheet written as inlineStr (§5.4).
- **P75** (`tour-p75.log`): 13 sheets toured, 0 errors; save ok,
  5,023 ms browser-observed; product 486,997 bytes. Parse-back
  totals identical to source: 5,076 cells / 761 formulas / 2,957
  value-or-inline. Regenerated sheet13 (CHKs) cell-diff: 124 cells
  each side, none added or lost; 46 string cells rewritten
  shared → inlineStr with identical resolved strings; **9 formulas
  differ textually** — structured table references in the source
  (`tblBS[Total Assets]`, `tblIC[Passed]`, `tblIS[Net Earnings]`,
  …) are written back as the A1 ranges they denote
  (`Calcs!$BJ$7:Calcs!$BJ$16`, `CHKs!$F$7:CHKs!$F$11`, …). No
  formula is lost and none changes what it references, but the
  structured-reference form is not preserved — recorded as a
  residual in §5.10.
- RSS: the sampler kept running across tours — windows 1–3 of
  `rss-tour-p95.txt` are the P75 / P50 / edit-guard saves (worker
  peaks 316 / 226 / 260 MB; engine ~1.5 GB throughout).

### 3.4 Edit-guard (P75: edit one sheet, save, hash-prove the rest) [artifact-verified; hash check re-run by W21c]

- `edit-guard.log`: Constants!B8 0.003 → **0.00777**; F16 set to
  `=B8*2` → **0.01554** (read back through the engine); save ok in
  5,649 ms via the Download dialog.
- In the saved file (W21c): B8 is `<v>0.00777</v>` under appended
  style s=199 (the bold edit); F16 is `<f>B8*2</f><v>0.01554</v>`.
  Totals move exactly by the edits: 5,077 cells / 762 formulas vs
  source 5,076 / 761 (+1, the new F16).
- `w21-hashcheck.mjs` source vs `edit-guard/p75-edited-saved.xlsx`
  (re-run by W21c): **240 parts SAME, 6 DIFF**, and the diffs are
  exactly the designed set — `xl/worksheets/sheet4.xml` (Constants,
  the edited sheet), `xl/styles.xml` (append-only), `xl/workbook.xml`
  (names block, below), `[Content_Types].xml` (calcChain override
  dropped), `xl/calcChain.xml` (dropped), `docProps/custom.xml`
  (added). `xl/sharedStrings.xml` is byte-identical; **every
  untouched sheet part is byte-identical**.
- Defined names: count **40 → 40**, and workbook.xml outside the
  names block is byte-identical. 31 of 40 names are byte-faithful;
  9 `_xlcn.WorksheetConnection_*` names degrade to `#ERROR!` —
  a real residual, recorded in §5.7, not hidden by the count.

### 3.5 Failure mode: dead worker ⇒ save error, engine alive, session usable [artifact-corroborated; re-run by W21c]

- W21b's trail: the gateway log shows a P75 load → `POST
  /api/engine/download` **500 in 958 ms** → successful read/execute
  round-trips on the same engine (the `/tmp/w21probe/postfail.mjs`
  pattern: read Constants!B8, setCell, read back, restore) → the
  engine was then restarted clean (the 09:44 restart command
  verified the new engine carries no `TEST_KILL` in its environ) →
  final download 200 in 4,372 ms producing
  `/tmp/w21probe/final-p75.xlsx` (486,997 B). No dedicated failure
  log was left, and the restart truncated the engine log, so the
  500's cause is not recorded in W21b's own artifacts.
- **W21c re-run** (throwaway engine instances, direct engine API,
  perf-p75.xlsx; main stack untouched):
  - Control (clean env): download **200**, `mode=verbatim`,
    `changedSheets=0`, `workerPeakRssMb=311.8`, 486,997 bytes.
  - `ICECREAM_SAVE_WORKER_TEST_KILL=1`: download **500 in 965 ms**,
    error `download serialization failed: save worker died
    (exit 42, heap budget 3072 MB)`; `/health` 200 afterwards;
    `setCell` 200; read-back 0.00321; restore 200. (965 ms vs
    W21b's 958 ms gateway timing corroborates that W21b's 500 was
    this same kill-switch test.)
  - `SAVE_WORKER_HEAP_MB=48` (the documented low-end clamp, whose
    stated purpose in `deploy/engineAccess.ts` is proving this
    failure mode): download **500 in 3,210 ms**, worker died
    `SIGABRT` (V8 OOM at the 48 MB budget); `/health` 200
    afterwards; the same edit round-trip succeeded.
- Verdict: forced worker failure — by either lever — is a save
  error, never a dead session. **Proven.**

### 3.6 Unedited-save verbatim purity [artifact-verified]

- Worker-direct P95 runs (`/tmp/w21probe/result2.json`,
  `result3.json`): `mode=verbatim`, `changedSheets=[]`,
  `verbatimParts=10`, and both runs produce the identical
  workerChecksum `75ef244b…` (the checksum gate is deterministic).
  The §3.5 control run shows `changedSheets=0` on P75 as well.
- Browser saves may still regenerate a sheet whose *resolved
  presentation* differs under the client's reported overlays
  (Ledger at P95, CHKs at P75, DATA-SUPPORT at P50) — the §1.3
  rule. §3.2/§3.3 cell-diff those regenerations: no cell, formula,
  or value is lost; the textual differences are empty→computed
  cache fills (P95 Ledger), shared→inline string storage (P75),
  and structured-reference expansion (§5.10).

---

## 4. Suites [re-run by W21c]

No suite output was recorded anywhere for W21b's changes (searched
`hidden_files/` and `/tmp`), so W21c ran the related suites on the
current tree, 2026-10-21:

| Suite | Result |
|---|---|
| gateway `tsc -p tsconfig.json --noEmit` | clean (exit 0) |
| gateway vitest | **18 files / 176 tests passed**, 0 failed |
| xlsx-adapter vitest | **31 files / 243 tests passed**, 0 failed |
| engine vitest | **44 files / 987 tests passed**, 0 failed |
| web vitest | **125 files / 1,597 tests passed**, 0 failed |

Web-suite note: the first web run reported 15 test *files* failed
with `ENOSPC: no space left on device, write` and 1,512 tests
passed / 0 failed — `/tmp` (a 512 MB tmpfs) was 96% full of stale
save-worker scratch dirs from earlier runs. After removing the
orphaned `/tmp/icecream-save-*` scratch (243 MB free), the 4 named
files passed standalone and the full re-run is the green line
above. The ENOSPC was environmental, not a code failure.

---

## 5. Fallbacks and residuals

Facts below are extracted from §1 and re-verified by W21c against
the code on disk (`engineSvc.ts`, `saveWorkerCore.ts`,
`saveWorkerSpawn.ts`, `saveChecksum.ts`, `deploy/engineAccess.ts`,
`streamingSave.ts`).

### 5.1 Adapter-fallback (still inside the worker)

Verbatim planning is abandoned — and `XlsxAdapter.write` runs over
the rebuilt, checksum-verified snapshot **in the worker**
(`mode=adapter-fallback`) — when: (a) the replayed journal contains
structural ops (anything outside the cell-op and name-op sets:
insert/delete rows/cols, sheet add/delete/rename, calculation
mode, …); (b) the rebuilt sheet set differs from the source's; or
(c) verbatim planning itself throws (e.g. unparseable styles, a
chartsheet in the changed set). Isolation and the checksum gate
still hold; what returns is the whole-package materialization —
inside the disposable process, where it can do no harm.

### 5.2 The 200,000-op journal cap — the one fallback that re-enters the engine

The save journal (`saveOps`, `SAVE_OPS_CAP = 200_000`) is the
worker's replay log. When a session's mutating-op count reaches
the cap, `engineSvc` sets `saveWorkerEligible = false` and clears
the journal: from then on, whole-workbook .xlsx saves (and
`/library-save`, which shares the gate) use the **in-engine path**
for the rest of the session. Eligibility resets on the next load
or checkpoint rehydrate. Named plainly: past the cap, the
serialization transient is back inside the engine — the W21a
failure geometry — until the workbook is reloaded.

### 5.3 Worker unavailable / disabled

`SAVE_WORKER=off`, a missing worker script, or an ineligible
session (§5.2) all route whole-workbook saves to the in-engine
path. By design (not fallback), named-range subsets and the
non-xlsx server formats (xlsb/csv/tsv/ods/html) also stay
in-engine: their outputs are small and the subset builder never
materializes the full dense workbook.

### 5.4 inlineStr

Regenerated sheets write strings as `inlineStr`; `sharedStrings.xml`
is **never modified** (hash-identical in the §3.4 check). This is
what makes the append-only styles invariant trivially safe: no new
shared-string indices can invalidate verbatim sheets. Observed
conversions: 46 cells on P75/CHKs, 23 on P50/DATA-SUPPORT — string
values identical after resolution (§3.3).

### 5.5 Checksum divergence note

The save gate's checksum reuses the ack-checksum *serialization*
(sheets in name order, cells sorted by (row, col), one
`serializeAckValue` line per cell, U+0003 separators) but digests
with **streaming SHA-256**, not `computeAckChecksum`'s FNV-1a.
The two digests are therefore *different functions by design* and
must never be compared against each other: the gate compares
saveChecksum-vs-saveChecksum (live engine at handoff vs worker
after rebuild), which is exact. The per-edit ack path keeps FNV
untouched. Measured basis (§1.2): FNV materializes ~150 MB of
line strings and costs ~75–80 s at 1.8M cells; streaming SHA-256
costs ~3.6 s at O(1) extra memory — corroborated by
`/tmp/w21probe/result3.json` (`checksumMs: 3627` once the bulk
readback was shared with serialization).

### 5.6 Per-principal filtering (the "§5h" pointer in §1.2)

The checksum is always computed over the **owner's** bulk
readback — state truth. The serialized product is the
**requesting principal's** permission-filtered view (the
protection model's per-subject filtered view: hidden cell values
are unreadable to unauthorized subjects). In
`saveWorkerCore.ts`, when requester ≠ owner a second bulk
readback is taken under the requester's principal and every
`#PERM!` cell is dropped from the output — hidden values never
leak into a save. When requester == owner (the ordinary save),
one readback serves both purposes (§1.2 point 4).

### 5.7 Residual: `_xlcn.*` defined names degrade to `#ERROR!`

On P75, any save that regenerates the workbook.xml names block
(both tour saves and the edit-guard save share the regenerated
block) round-trips 9 of the 40 defined names — all
`_xlcn.WorksheetConnection_*` external-connection names whose
refersTo is a table token (`tblCF[]`, `tblPAA[]`, …) — as
`#ERROR!`. Count (40) and order are preserved and no cell data is
affected, but the names' targets are lost. §1.3's raw-preservation
rule covers `_xlnm.*` entries only. Whether the in-engine path
shares this degradation is not established by these artifacts.
**Open follow-up — not fixed by W21.**

### 5.8 Residual: engine handoff transient

Moving serialization out did not make the engine free at save
time: the handoff (bulk readback + expected-checksum over 1.8M
cells) peaks the engine at 2,530 MB (API run) / 2,823 MB (browser
run) against a ~1.7–1.9 GB plateau. Both runs survived with thin
headroom (MemAvailable minima 72 MB / 153 MB), and the
virtio-balloon (§2) is the swing factor. The peak is bounded and
an order below the old in-engine spike, but it is the number to
watch if fixtures grow.

### 5.9 Evidence gaps (declared, not papered over)

- The engine-side `/download` log lines for the two P95 runs
  (mode / workerPeakRssMb as the engine computed them) were lost
  when the failure-mode test restarted the engine and truncated
  `/tmp/gwlogs/engine.log`. P95 mode and peaks in §3 stand on the
  saved products' part structure, the external `ps` traces, the
  tour logs, and the gateway log instead.
- `rss-tour-p95.txt` kept sampling after the P95 tour: windows
  1–3 are the P75/P50/edit-guard saves (§3.3); later windows are
  suite-run workers sampled against a by-then-dead engine pid and
  are not stack evidence.
- W21b left no dedicated failure-mode log; §3.5's W21b half is
  reconstructed from the gateway log + `/tmp/w21probe/` and is
  corroborated — not replaced — by W21c's re-run.

### 5.10 Residual: structured table references expand to A1 ranges on regenerated sheets

On a regenerated sheet, formulas that use Excel structured
references (`tblBS[Total Assets]`, `INDEX(tblIS[Net Earnings],
Periods)`, …) are written back with those references expanded to
the A1 ranges they denote (`Calcs!$BJ$7:Calcs!$BJ$16`, …) — the
engine's internal form. 9 such formulas on P75/CHKs (§3.3). The
references are semantically identical and values are unaffected,
but a workbook that round-trips through a regenerated sheet
loses the structured-reference form (and with it, the formula's
tie to the table's dynamic range). Verbatim-copied sheets are
unaffected. **Open follow-up — not fixed by W21.**