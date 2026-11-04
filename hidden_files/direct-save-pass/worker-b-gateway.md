# Worker B — gateway integration: direct streaming save (engineSvc.ts)

Scope: `packages/gateway/src/services/engineSvc.ts` only, plus new test file
`packages/gateway/tests/directSave.test.ts`. No edits to saveWorkerCore.ts,
saveWorkerSpawn.ts, desktop files, App.tsx, perf-evaluation.md, progress.md.
No git push.

Shared API coded against (landed by the parallel worker during this task;
verified in `packages/service/dist/save/directSave.d.ts` and now exported as
`@icecream-sheets/service/save-node` in the service package.json):
`serializeLiveWorkbook(input) => DirectSaveResult` (sync),
`verifyXlsxPackage(path) => { ok: true, parts }` (throws on failure),
`DirectSaveParsedSheet` = flat `{ styles?, formats?, colWidths?, rowHeights?,
hiddenCols?, hiddenRows? }` — matches the construction below exactly.

## What changed

### New: `runDirectSave(extras, principal)` (replaces buildSaveHandoff + runWorkerSave)
1. **Recalc settle first** (addendum §1, see below): `await settlePendingRecalc()`.
2. **Pinned revision**: `const pinnedRev = state.revision` recorded after the
   settle; then metadata merge, defined names, sheet metas, parsedSheets,
   ops, bulk readback, temp-file creation and the `serializeLiveWorkbook(...)`
   call run **synchronously with no `await` between pin and serialize** —
   the event loop cannot interleave an `/execute` into the pass, so the bulk
   array is the live model at exactly the pinned revision. A defensive check
   immediately after the pass throws if `state.revision !== pinnedRev`
   (temp cleaned, no file emitted).
3. **Merged metadata** exactly like the old buildSaveHandoff:
   `state.sourceMetadata` → `state.protection.toMetadata()` →
   `extras.extraMetadata`.
4. **Defined names** (E1 rule unchanged):
   `mergeDefinedNames(state.host.getDefinedNames(), extras.definedNames)`.
5. **Sheet metas**: same client-styles/client-dims forwarding loop as
   buildSaveHandoff (`sanitizeSheetStyles` + `extras.sheetDims`), typed as
   `DirectSaveSheetMeta` (shape-identical to the old SaveWorkerSheetMeta).
6. **parsedSheets** from state, per sheet name: `styles =
   state.sourceSheetStyles.get(name)`, `formats =
   decodeFormatsWire(state.sourceSheetFormats.get(name))`, dims from
   `state.sourceSheetDims.get(name)` (colWidths/rowHeights/hiddenCols/hiddenRows).
7. **Bulk**: `state.host.bulkReadback({ principal })` — permission-filtered
   for the requesting principal; #PERM! cells are dropped by the serializer.
8. **Temp file**: `mkdtempSync(join(tmpdir(), 'icecream-direct-save-'))`,
   `out.xlsx` inside it. Returns `{ outPath, result, cleanup }` (cleanup =
   rm -rf of the temp dir), same contract spawnSaveWorker had.
9. **Verify** (Excel sequence step 3a): after the serialize pass,
   `verifyXlsxPackage(outPath)` runs before the function returns — so before
   any caller streams/stores/replaces. Coded defensively (throw, `false`,
   or `{ok:false}`/`{valid:false}` all fail); on failure the temp is cleaned
   and the save throws.

### >200k-ops handling (SAVE_OPS_CAP)
The direct path does not depend on journal completeness for *state* (it reads
the live model), but the changed-sheet set derives from `ops`, and past the
cap the journal was dropped (`state.saveWorkerEligible === false`,
/execute journaling kept AS IS). In that case runDirectSave passes
`ops = sheetNames.map(name => ({ cmd: 'setCell', ref: { sheet: name, row: 0, col: 0 } }))`
— a per-sheet setCell marker for **every** sheet, forcing all sheets changed
so no stale source part can be copied verbatim for an edited sheet the
journal lost. The per-sheet-marker form was chosen deliberately so the save
stays on the streaming path (structural fallback markers would degrade it to
adapter-fallback). Documented in a comment at the ops construction.

### Routes
- **`/download` (xlsx, whole workbook)**: unconditional direct path (the
  `workerScript !== null && state.saveWorkerEligible` condition is gone).
  Streams the verified temp file with `createReadStream` exactly like the old
  worker branch; `res.on('close', cleanup)`. Headers kept:
  content-type / content-disposition / content-length / cache-control;
  `x-save-worker` + `x-save-worker-peak-rss-mb` replaced by
  **`x-save-mode: <mode>`**. Log line per save (mode always visible, header +
  log, never silent):
  `[engine] /download format=xlsx scope=workbook direct mode=… changedSheets=… verbatimParts=… bytes=… serializeMs=… totalMs=… principal=…`.
  Named-range scope and non-xlsx formats keep the existing
  `buildSaveWorkbookData` path, unchanged.
- **`/library-save`**: runDirectSave, then copy temp → tmp file in the library
  dir → `renameSync` over the entry file (the existing tmp+rename logic; the
  rename is the atomic replace). Index update as before; cleanup in `finally`.
  Log line carries `direct mode=…`.
- **`checkpointSession`**: snapshot bytes now come from
  `runDirectSave({}, ownerPrincipal)` → `readFileSync(outPath)` →
  `stores.snapshots.put` → cleanup in `finally`. `fullStateChecksum()` is
  unchanged and still computed from live state.
- **Deleted worker plumbing**: `buildSaveHandoff`, `runWorkerSave`,
  `workerScript` / `workerHeapMb` / `workerTimeoutMs` resolution, the
  `EngineServiceDeps.saveWorker` field, and the now-unused imports
  (`saveWorkerEnabled/HeapMb/TimeoutMs` from deploy/engineAccess,
  `bulkStateChecksum` from saveChecksum — its only use was the handoff
  checksum, `resolveSaveWorkerScript/spawnSaveWorker/SaveWorkerJob/
  SaveWorkerSheetMeta` from saveWorkerSpawn). Grep confirms no remaining
  references in gateway src outside saveWorkerCore/saveWorkerSpawn/bin/
  saveWorker themselves (those files were left in the tree untouched, per
  instructions). Stale W21 comments updated; the `saveOps` journal and the
  `saveWorkerEligible` field remain (field now documented as "save journal
  intact").

### Password-encrypted download (verified, no change)
Grep of `apps/web/src/App.tsx` (`handleDownloadEncrypted` /
`handleFilePasswordSubmit`, ~L6414–6453): gateway mode fetches the
server-serialized bytes (`fetchServerWorkbookBlob()`) and builds the
encrypted envelope **client-side** via `encryptFileWithPassword(...)`.
Server bytes now come from the direct path; the client flow is untouched.

## Addendum: Excel save sequence

### 1. Finish pending recalc first — mechanism found
Grep over `packages/engine/src` for recalcPool/drain/settle/whenIdle/pending:
**EngineHost exposes no drain/settle/whenIdle API**, and RecalcWorkerPool
exposes no settle handle. The only async recalc surface is the
`executeAsync('recalculateParallel')` *trigger* — and `/execute` already
awaits it before responding whenever an edit routes parallel
(wantsParallel branch). Ordinary recalc is **synchronous**: HyperFormula
evaluates inside `execute()` itself, so at pin time the live state is fully
calculated by construction. The client save interlock (`awaitEditsSettled`)
covers in-flight routed edits. `runDirectSave` therefore starts with
`settlePendingRecalc()`, which probes for a `whenIdle`/`drainRecalc`/
`settleRecalc` handle and awaits it if one ever appears (future-proofing in
exactly one place, before the pin), and documents all of the above in a
comment block.

**Regression test** (`tests/directSave.test.ts`): chain workbook built via
/load (A1=1, A2=`=A1+1`, … 500 links → A501), `/execute` setCell A1=100,
then **immediately** `/download`. Parse-back asserts the formula survives
AND the cached `<v>` of A501 in the saved sheet XML is **600** (post-recalc),
not 501 (stale). **PASS** (~3.6 s).

### 2. Temp → verify → replace, per path
- `/download`: temp built completely + verified inside runDirectSave before
  `writeHead`; only the verified file streams. Failure → 500, temp cleaned,
  nothing streamed.
- `/library-save`: serialize→temp→verify → copy into library dir under tmp
  name → rename (atomic replace). The pre-existing library file is never
  touched before the rename.
- `checkpointSession`: temp→verify→read bytes→snapshot store put (commit);
  a failed save leaves the previous snapshot untouched.

### 3. Forced-failure test — evidence
`tests/directSave.test.ts`, toggling `process.env.ICECREAM_SAVE_FAULT_INJECT
= 'midwrite'` mid-test (the shared serializer reads it at call time —
verified in `packages/service/src/save/directSave.ts`; the fault fires on
the first *regenerated* sheet part, so the test makes an edit before the
faulted re-save):
load → library-save OK (stored bytes hashed) → edit → fault on →
library-save → **500**; stored library file **byte-identical** (sha256 +
Buffer equality) to the first save and still parses → `/download` under
fault → **500**, no `x-save-mode` header, body matches /download
serialization failed/ (no partial file streamed as success) → fault off →
library-save **200** → `/health` 200, edit+read round-trip works. **PASS**.
(The rewired `tests/saveWorker.test.ts` HTTP block independently pins the
same fault behaviour over `/download`.)

## Test results (exact counts)
- `npm run build` in packages/gateway: **clean** (tsc, no errors).
- `tests/directSave.test.ts` (new): **3/3 passed** — mode-header visibility,
  recalc-first 500-link regression, forced-failure sequence.
- `tests/saveWorker.test.ts`: **4/4 passed** — in-process worker-core tests
  (checksum abort, verbatim planning via the shared serializer) + the HTTP
  block the parallel worker rewired to the direct topology (direct download
  parse-back exact; mid-save fault = 500, engine alive, retry succeeds).
  Note: one transient run mid-way failed with `HAS_WORKER is not defined` —
  that was the parallel worker's half-applied edit of this file; the final
  on-disk version passes as above.
- `tests/engineSvc.test.ts` + `tests/engineSvcStream.test.ts` +
  `tests/engineSvcReadDuringBuild.test.ts` + `tests/addonRunBinding.test.ts`
  (the PERM/protection-related gateway tests; PERM grep also hits
  engineSvc.test.ts): **54/54 passed** (4 files).
- `tests/deployAccess.test.ts` + directSave re-run: **25/25 passed** (2 files).

## Left on the old path (and why)
- Named-range `/download` scope and non-xlsx formats (xlsb/csv/tsv/ods/html):
  unchanged `buildSaveWorkbookData` + adapter path, per the task — the named
  range subset never materializes the full dense workbook, and the other
  formats are small-output flows with no verbatim source package to stream.
- `saveWorkerCore.ts` / `saveWorkerSpawn.ts` / `bin/saveWorker.ts` remain in
  the tree as the non-ordinary fallback, rewired by the parallel worker to
  the shared serializer; not edited here.

---

# Addendum 3 — AutoSave: continuous batch sync (Microsoft 365 model, single author)

## Scheduler design
- State (per session, in `EngineState`): `storageRevision` (revision cut of
  the last committed checkpoint), `pendingCheckpointOps` +
  `pendingCheckpointOpCmds` (the pending batch), `autosaveCommitted`,
  `storageMode`.
- Triggers, all converging on `checkpointSession(reason, extras)` (in-flight
  deduped via `activeCheckpoint`; ops arriving during a checkpoint belong to
  the NEXT batch — accounting subtracts only the batch captured at entry,
  and only on success):
  - **Settle timer**: `armAutosaveCheckpoint()` re-arms after every executed
    mutating op; `AUTOSAVE_CHECKPOINT_SETTLE_MS` env, default **1500 ms**
    (`autosaveCheckpointSettleMs()` in `deploy/engineAccess.ts`; 0 disables).
  - **Segment cap**: pending ops reaching `AUTOSAVE_BATCH_OPS_CAP = 200`
    force `checkpointSession('segment-cap')` immediately. This is a
    dedicated constant, deliberately NOT the durability journal segment cap
    (`JOURNAL_SEGMENT_MAX_OPS` is operator-tunable; conflating the two made
    checkpointing fire per-2-ops in deploy tests).
  - **Structural barrier** (Addendum 5), **flush** (force save / download),
    **periodic** (deployment `everyOps`/`everyMs`), **idle sweeper / session
    release** via `evictSession` — see the §5 table in the compliance
    section below.
- Checkpoint = write-ahead journal segment flush FIRST
  (`flushJournalSegment()`), then `runDirectSave` at the pinned revision →
  verify → deployment snapshot put → commit of the session's autosave
  library entry `autosave_<sessionId>` (principal-scoped, atomic
  tmp+rename in `commitLibraryEntry`) → journal truncate to the pinned
  revision → registry update → `storageRevision = pinnedRev`.
  Per-checkpoint log: `[engine] checkpoint rev=<rev> ops=<n> mode=<mode>
  ms=<ms>` (+ `fallbackReason=…` when adapter-fallback — never silent).
- `storageRevision` observability: `GET /session/status` returns
  `storageRevision` + `pendingCheckpointOps`; flush responses carry
  `revision` + `storageRevision` + `caughtUp`.
- Steady state: storage jumps batch-cut to batch-cut; every committed
  batch is a complete valid workbook (changed sheets regenerated, rest
  verbatim). Save click = flush confirmation: caught up → instant
  `{ skipped: true, flushedOps: 0, caughtUp: true }` with NO serialization;
  behind → one synchronous checkpoint, then confirm.
- /download's save-first step is the same flush; the entry returned for
  the signed-URL fetch is the session's autosave entry (owner view).
  **Hidden-range guard (face e)**: the autosave entry is serialized from
  the OWNER view; if the workbook has hidden ranges
  (`sessionHasHiddenRanges()`), /download falls back to a per-principal
  filtered `dl_` entry so a restricted principal never receives cells
  hidden from them. Session-less / non-session-principals also use `dl_`.
- Autosave entries are internal: filtered out of `GET /library` listings.

## Regression test (tests/directSave.test.ts)
50k-cell Big sheet + Data sheet; batch 1 checkpoints via the settle
scheduler; the INTERMEDIATE committed file parses and matches its cut
(A1=111 present, B1 still pre-edit 0); 20 rounds of paired edits during
checkpointing; final stored file holds every edit's final value exactly
(A1=219, B1=519 — none lost, none double-applied); scheduler-only
catch-up (Addendum 6.1 form: reads only, no save call) reaches
storageRevision == liveRevision; a further save click skips. **PASS**
(also re-proven at P95 by the coordinator on the real stack, per brief).

# Addendum 4 — pin + copy-on-write stash (single-copy consistency)

- Wired against the engine API exactly as specified:
  `host.beginSavePin()`, `host.bulkReadbackSheetPinned(pin, sheet, auth)`,
  `host.releaseSavePin(pin)`, `host.savePinStashCells(pin)`,
  `SavePinOverflowError` from `@icecream-sheets/engine`.
- `runDirectSave` read phase: synchronous assembly (metadata/names/metas/
  parsed sheets/ops) at the service revision → `beginSavePin` → per-sheet
  pinned reads with `await setImmediate` between sheets (in-flight
  /execute requests genuinely process during the read) → log
  `[engine] save pin rev=<rev> stashedCells=<n>` → `releaseSavePin` in a
  finally → serialize from the frozen bulk. The old "revision moved"
  defensive throw is GONE: the live revision may legitimately advance via
  stashed edits during the read; the FILE is exactly the pinned cut.
- **Two revision domains (documented in code)**: the pin's `rev` is the
  HOST's mutating-op count; `state.revision` is the service revision.
  Both are captured at the same atomic instant; the assert throws if
  they disagree at pin time. The SERVICE domain is what responses report
  and checkpoints commit (it is the domain journal segments, storage
  revisions, and client acks use).
- /execute overflow queue: the execute call is wrapped; on
  `SavePinOverflowError` it logs `[engine] execute queued behind save
  pin (<cmd>)`, polls the engineSvc `activeSavePins` counter every
  25 ms up to 30 s, retries ONCE; timeout or a second overflow →
  retryable **503**. The degradation is bounded and logged, never silent.
- Cost note: the engine's pinned per-sheet read currently filters a full
  bulk readback per sheet (O(sheets × cells)) — engine-side
  implementation detail, correct at test scale; flagged for the engine
  worker if P95 profiling bites.
- Regression test (stronger form): Sheet1!A1=10, Sheet3!A1
  `=Sheet1!A1*2`, 4 filler sheets (40k cells); a pre-save edit on Sheet3
  puts it in the changed set so its cached value comes from the pinned
  bulk (the SheetJS-written source part carries no computed cache);
  mid-save cross-sheet edit Sheet1!A1=99 → both requests 200, edit ack
  revision > save's pinned revision, saved Sheet1 = 10 and saved Sheet3
  XML contains `<v>20</v>` and NOT `<v>198</v>` (inputs AND cached values
  consistent at the pin), live model afterwards = 99 / 198, and
  `storageRevision < liveRevision` (dirty again). **PASS**.

# Addendum 5 — batch materialization semantics

- Inherent properties asserted by test: a batch materializes from live
  state at its cut — final value per cell written once (X edited by 3
  ops stores only the final 3), a multi-op sheet regenerated once
  (`changedSheets === ['Data']` for a 4-op single-sheet batch),
  intermediate values never reach the file.
- **Structural barrier** in /execute (after cmd stamping, before
  routing): an incoming op whose cmd is NOT in the cell-ops
  `{setCell, setFormula}` and NOT in the name-ops family
  `{defineName, deleteName, renameName, updateNameRefersTo,
  defineFunction, updateFunction, rollbackFunction, deleteFunction}`
  first awaits `checkpointSession('structural-barrier')` when
  `pendingCheckpointOps > 0`, logging `[engine] structural barrier:
  flushed rev<=<cut> before <cmd>`; a barrier failure returns 500 and
  the structural op is NOT applied. Per-cell collapsing never spans the
  barrier.
- Per-type handling (serializer result drives the checkpoint log):
  | op family | next checkpoint |
  | --- | --- |
  | name-ops | verbatim, workbook.xml surgery |
  | insert/delete rows/cols | verbatim, ALL sheets regenerated |
  | sheet add/delete/rename/move, setCalculationMode | adapter-fallback, `fallbackReason` from the serializer (`sheet-set-changed` / `structural-op:<cmd>` / `verbatim-failed`) printed in the checkpoint log |
- **Journal ≠ file**: batch boundaries do not collapse the journal; only
  the pre-existing segment/checkpoint truncation applies (segments are
  truncated at a checkpoint's pinned revision, after the snapshot exists
  — the journal remains the replayable history up to that snapshot).
  Evidence test: scripted batch → flush (final values only, sheet
  regenerated once) → barrier flush before insertRows stores the
  PRE-insert cut → post-insert flush stores the shifted state →
  release → rehydrate verifies the full-state checksum
  (`checksumVerified: true`). **PASS**.
- **Engine bug found and fixed en route** (flagged for the engine
  worker's review): `EngineWorkbook.insertRows/deleteRows/insertCols/
  deleteCols` called HyperFormula's shift but never re-keyed the
  engine-side per-cell registries (`cellInputs`, `valueCache`,
  `dirtyInputKeys`, `cycleCells`), so bulk readback — the save path —
  read post-shift contents at PRE-shift refs and silently dropped cells
  pushed past the old sheet edge (the entire last row after a top
  insert). The rehydrate checksum mismatch this caused is what surfaced
  it. Fix: `remapRegistriesAfterShift()` in
  `packages/engine/src/workbook.ts`, mirroring renameSheet's re-keying;
  engine tests sheet-ops/savePin/names/measure-cache/collaboration/
  defined-names-snapshot: **90/90 PASS**. Also, `fullStateChecksum()` in
  engineSvc now excludes null-input/null-value phantom cells (a
  structural op can materialize explicit empties in the live model that
  no file round-trip preserves; the checksum's contract is value
  equality, so they are excluded on both sides).

# Consolidated brief — ordering + measurement

- **Write-ahead ordering** kept everywhere: `checkpointSessionInner`
  flushes the journal segment FIRST, then materializes (temp → verify →
  atomic replace). Storage never holds a batch the journal can't replay.
- **Flush triggers** all land on the one `checkpointSession` path:
  settle timer, segment cap (200), structural barrier, save/download
  flush, periodic (deployment config), idle sweeper → `evictSession`,
  and `/session/release` → `evictSession`. Tab close arrives as the
  client's unload beacon → session release → the same flush; no new
  beacon was built.
- **Measurement**: `flushJournalSegment` logs
  `[engine] journal segment flushed session=… ops=<n> journalBytes=<n>
  toRevision=<n>` (journalBytes = `Buffer.byteLength(JSON.stringify(ops))`),
  so journal overhead per 1k ops is reportable from logs; the save-pin
  log line covers stash size. P95-scale numbers are the coordinator's
  real-stack re-proof (tests here are in-test scale).

# Addendum 6 — autosave ownership, no-op rule, extras sync

- **Server-only autosave confirmed + hardened**: the engine-service
  scheduler is the only autosave actor in gateway mode; it flushes on
  (dirty && settle passed) with NO client call. The Addendum-3 test now
  proves catch-up with reads only (status polls) — the background-tab
  equivalent.
- **Status surfaces** (all additive):
  - `/execute` ack response: top-level `liveRevision` + `storageRevision`
    alongside `ack`.
  - `POST /session/heartbeat` response: + `liveRevision`,
    `storageRevision`, `extrasDirty` (the response the client already
    polls).
  - `GET /session/status`: + `extrasDirty`, `autosaveStats`.
  - `GET /session-save-status`: `{ ok, sessionId, liveRevision,
    storageRevision, extrasDirty, pendingCheckpointOps, autosaveStats }`.
  There is NO client-callable flush other than force save.
- **Strict no-op rule + counters**: `state.autosaveStats = { flushes,
  noopSkips, forcedFlushes }`. A flush check with
  `storageRevision == liveRevision && !extrasDirty` writes NOTHING (no
  journal write, no temp, no materialization, no storage write) — in the
  scheduler tick (counted as a noopSkip) and in `flushSessionSave`
  (instant `skipped: true` confirm, noopSkips++). Committed checkpoints
  increment `flushes`; explicit save/download flushes increment
  `forcedFlushes`. Test proof: after a flush, stored-file bytes AND
  mtime are unchanged across settle windows + a force save, noopSkips
  incremented, and one edit over several settle periods produces
  EXACTLY ONE flush. **PASS**.
- **Extras continuous sync**: `POST /session-extras { sheetStyles?,
  sheetDims?, definedNames?, extraMetadata? }` (same shapes as save
  extras) → `state.pendingExtras`, replace-per-key; `extrasDirty` set
  ONLY when the canonical-JSON sha256 differs from the stored hash (an
  identical resend does not dirty and does not flush — tested).
  `runDirectSave` merges `pendingExtras` UNDER per-request extras
  (per-request wins per top-level key). A successful checkpoint clears
  `extrasDirty` only if the extras hash is unchanged since that
  checkpoint captured it (a mid-flight push belongs to the next batch).
  Extras-only dirt is flushable: the scheduler fires with zero pending
  cell ops, and force save consumes `extrasDirty`. Test: style-only
  push → scheduler flush → stored file's parsed styles carry the new
  style, with NO /library-save call and NO cell ops. **PASS**.

## Client contract (updated — coordinator wires App.tsx)

- **Force save**: `POST /api/engine/library-save` (engine route
  `/library-save`), body = save extras only (may be `{}`). Response
  (session path): `{ ok, entry, revision, storageRevision, caughtUp,
  flushedOps, skipped, changedSheets }`. `skipped: true` = storage was
  already at the live revision; nothing was serialized or written. No
  workbook bytes in request or response.
- **Download**: `POST /api/engine/download` `{ format: 'xlsx' }` →
  save-first flush, then JSON metadata ONLY:
  `{ ok, entryId, revision, bytes, mode, serializeMs, changedSheets,
  totalMs }`. In the single-author session path `entryId` is the
  session's autosave entry (`autosave_<sessionId>`), so repeat
  downloads of an unchanged workbook reuse the stored copy;
  `dl_<ts36>_<rand>` entries are minted only for session-less /
  non-session-principal callers and for workbooks with hidden ranges
  (per-principal filtered view). `extras.filename` renames the entry
  (metadata-only).
- **Signed fetch**: `POST /api/storage/sign` `{ entryId }` (gateway,
  JWT + rate limit) → `{ ok, url, expiresAt }`; token lifetime **120 s**,
  payload `{ v: 1, entryId, principal, exp }`, scheme identical to
  engine access (base64url payload + `.` + base64url HMAC-SHA256,
  secret = `ENGINE_ACCESS_SECRET`). Client: `GET url` → Blob → browser
  download. Engine route `GET /storage/:entryId?st=<token>` serves the
  committed file directly (401 on missing/invalid/expired/mismatched
  token or principal mismatch; CORS applied). If no signing secret is
  configured, /api/storage/sign returns **501** (fail closed) while
  /download metadata still works. Env: `ENGINE_PUBLIC_URL` (direct
  engine origin for the URL; falls back to the gateway's engine
  upstream), `ENGINE_ACCESS_SECRET`.
- **Autosave display**: the client NEVER initiates autosave. It reads
  `liveRevision` / `storageRevision` from /execute acks, the heartbeat
  response, `GET /session/status`, or `GET /session-save-status`;
  Saving… ⇔ `storageRevision < liveRevision || extrasDirty`.
- **Extras sync**: as the client's styles/dims/names/metadata change,
  `POST /api/engine/session-extras` with any subset of
  `{ sheetStyles, sheetDims, definedNames, extraMetadata }` (latest
  wins per key; identical resends are free). Response
  `{ ok, extrasDirty }`. The server folds them into the next autosave
  flush on its own schedule.

# Design-doc compliance — revision-model-save-and-coauthoring.md

Walked §§1–6 + §9 (my scope; §§7–8 are Phase 2, gated, not built here).

- **§1 One live model, numbered revisions — MATCH, with one stated
  nuance.** One authoritative model per session (`state.host`), mirrors
  are caches. Service revisions are assigned per executed op in
  /execute (`state.revision`). Nuance: the service revision counter
  advances on cell ops (setCell/setFormula); structural/name ops do not
  take a service revision — they are captured in `saveOps`, split
  batches at the structural barrier, and persist via checkpoint
  snapshots (journal segments carry the cell-op history; rehydrate =
  latest snapshot + journal replay past it, checksum-verified). The
  engine pin has its own host op-count domain (see Addendum 4); the
  service domain is the one reported/committed.
- **§2 Serialization — MATCH for the ordinary whole-workbook .xlsx
  path; DEVIATION (stated, not fixed — flagged upward per instructions)
  for the rest.** Ordinary path = `serializeLiveWorkbook` via
  `runDirectSave`: one streaming pass over the live model at a pinned
  revision, untouched parts verbatim, changed sheets regenerated
  row-by-row, principal filter applied during the pass (#PERM! cells
  dropped); no rebuild, no re-parse for state, no journal replay, no
  dense conversion, no SheetJS worksheet objects. **Deviation:**
  named-range scope and non-xlsx formats (xlsb/csv/tsv/ods/html) still
  serialize via `buildSaveWorkbookData` + adapters — a whole-workbook
  object model the §2 forbidden list excludes. This predates the doc,
  was explicitly out of my brief's scope, and is stated here for the
  coordinator/user rather than silently left or unilaterally expanded.
- **§3 Save sequence — MATCH.** Recalc settle first
  (`settlePendingRecalc()` + synchronous /execute recalc; the
  500-link-chain regression test proves post-recalc values land);
  temp file → `verifyXlsxPackage` → atomic commit (rename in the
  library store; snapshot put only after verify); forced-failure test
  proves the stored file stays byte-identical, the session survives,
  and no partial download is served as success.
- **§4 Save vs download — MATCH.** Save = signal only, metadata-only
  response including the saved revision. Download = save-first flush,
  then bytes fetched directly from storage via a gateway-issued
  120 s signed URL (engine `/storage/:entryId`); bytes are never
  proxied through the gateway, and the engine route performs no
  serialization. 501 fail-closed when no signing secret is configured.
- **§5 AutoSave — MATCH.** Server-side only; client never initiates
  (no client-callable flush besides force save). Batch flush order:
  journal segment FIRST (write-ahead), then materialize temp → verify →
  atomic replace. Flush points, each verified in the wiring:
  | §5 flush point | trigger in code |
  | --- | --- |
  | settle window | `armAutosaveCheckpoint()` → `checkpointSession('autosave-settle')` |
  | idle checkpoint | idle sweeper → `evictSession('idle-sweeper')` → `checkpointSession(reason)`; plus in-session `checkpointSession('periodic')` (deployment everyOps/everyMs) |
  | tab close | client unload beacon → `POST /session/release` → `evictSession(reason)` → `checkpointSession(reason)` |
  | session close | `POST /session/release` → `evictSession` (same path); idle eviction likewise |
  | before a download | `/download` → `flushSessionSave()` → `checkpointSession('flush')` |
  | force save | `/library-save` → `flushSessionSave()` (synchronous, skips the settle window) |
  Plus two extra triggers on the same path: pending-ops segment cap
  (200, `checkpointSession('segment-cap')`) and the structural barrier.
  NO-OP RULE implemented + counted (`autosaveStats.noopSkips`; zero-write
  proven by bytes+mtime in test). Extras sync via `/session-extras`
  with a metadata-dirty flag (`extrasDirty`); extras-only changes flush.
  Batch materialization: union of the batch's ops, final value per
  cell, sheet regenerated once per batch; structural ops split batches
  (barrier). Single-author semantics only — no co-authoring, presence,
  or peer sync was built in this scope.
- **§6 Edits during a save/flush — MATCH.** Pin + copy-on-write stash
  (engine worker's API, wired in Addendum 4); the in-flight write
  produces exactly its pinned revision; mid-save ops get later
  revisions, apply to the live model, and belong to the next batch
  (workbook dirty again — asserted). Past the stash cap, ops queue
  (25 ms poll, 30 s bound, logged, retryable 503) — the doc's own
  "past the cap, ops queue briefly (graceful, logged)" clause.
  Cross-sheet torn-state regression test included and passing.
- **§9 Memory discipline — MATCH.** Journal tail, pending-batch
  counters/cmds, and the pin stash all scale with edit rate, not
  workbook size; no per-cell history is held. Measured in logs:
  `journalBytes=<n>` per segment flush and `stashedCells=<n>` per save
  pin; P95-scale numbers are the coordinator's real-stack re-proof.

## Final test results (exact counts, this pass)
- Builds: packages/engine **clean**, packages/service **clean**,
  packages/gateway **clean** (tsc).
- `tests/directSave.test.ts`: **8/8 passed** (download metadata,
  recalc-first chain, forced failure, Addendum-4 pin torn-state,
  Addendum-3 autosave, Addendum-6 ownership/no-op/extras, Addendum-5
  batch/barrier/journal, storage separation e2e).
- Gateway affected set: engineSvc 36 + deployAccess 22 + gateway 19 +
  engineSvcStream 7 + addonRunBinding 6 + engineSvcReadDuringBuild 5 +
  saveWorker 4 = **99/99 passed**.
- Engine (structural remap): sheet-ops 26 + names 28 + collaboration 15
  + measure-cache 9 + savePin 8 + defined-names-snapshot 4 =
  **90/90 passed**.
