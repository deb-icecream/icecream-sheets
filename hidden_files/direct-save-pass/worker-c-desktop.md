# Worker C — Desktop parity for the direct-streaming save fix

Scope: desktop (Electron main-process live engine, IPC transport) now saves
whole-workbook .xlsx through the SAME shared direct streaming serializer as
the web/gateway path (`serializeLiveWorkbook` from
`@icecream-sheets/service/save-node`) — no fork, no renderer snapshot on the
path. Plus Addendum 1 (Excel save sequence: temp-in-destination-dir →
verify → atomic rename, with forced-failure evidence) and Addendum 2
(save/download signal-model mapping + ops-during-save dirty correctness).
No git push. packages/gateway, perf-evaluation.md, progress.md untouched.

## Files changed

| File | Change |
|---|---|
| `apps/desktop/src/engine-load.ts` | Save base retained at load: `getDesktopSaveBase()` / `resetDesktopSaveBase()` + `DesktopSaveBase`/`DesktopParsedSheetSaveState` types. `buildWorkbookFromBytes` sets it from the adapter result: `sourceBytes` = a copy of the raw bytes ONLY for xlsx-family extensions (`xlsx/xlsm/xltx/xltm`; null for csv/tsv/ods/html/xlsb and blank workbooks), `parsedSheets` = per-sheet Map of styles/formats/colWidths/rowHeights/hiddenCols/hiddenRows (shallow-copied), `metadata` = adapter metadata verbatim. Set only after a successful parse+build, so a failed open never clobbers the live workbook's base. |
| `apps/desktop/src/direct-save.ts` | NEW. Save-op journal (`noteDesktopSaveOp` / `clearDesktopSaveOps` / `getDesktopSaveOps`), `serializeDesktopWorkbook(host, extras, outPath)`, `saveToDestinationAtomically(serializeFn, destPath)` + `tempPathForDestination`, `mergeDefinedNames`, `sanitizeDesktopSheetStyles`, `buildDesktopSheetMetas`, cached dynamic `loadSaveNode()`, `loadDirectSaveMutatingOps()`. |
| `apps/desktop/src/engine-ipc.ts` | Execute handler: on a successful mutating command (cmd ∈ `DIRECT_SAVE_MUTATING_OPS`, loaded from save-node) → `noteDesktopSaveOp({cmd, ref?})` (journaling wrapped so it can never fail an applied edit). `engine:load` → `clearDesktopSaveOps()` after swap (base is set inside engine-load). `engine:new` → `resetDesktopSaveBase()` + `clearDesktopSaveOps()`. |
| `apps/desktop/src/main.ts` | NEW IPC handler `engine:saveXlsxDirect` (see sequence below). `resetWorkbook` dep and menu `newWorkbook()` also reset save base + journal (idempotent with engine-ipc's own clearing). |
| `apps/desktop/src/preload.ts` | `file.saveXlsxDirect(extras, suggestedPath?, suggestedName?)` on `window.icecreamDesktop` following the `saveBytes` pattern, with exported `DesktopSaveExtras` / `DesktopSaveXlsxDirectResult` types (also re-declared renderer-side via `renderer.d.ts`'s existing `IcecreamDesktopApi` import — no separate edit needed). |
| `apps/web/src/services/desktopAgent.ts` | `DesktopApi.file.saveXlsxDirect?` (optional = feature-detect) + exported `desktopSaveXlsxDirect(extras, suggestedPath?, suggestedName?)` wrapper: returns `null` when the bridge fn is absent, `{path: null}` when the dialog was cancelled, rejects on save failure. Plus `DesktopSaveExtras` / `DesktopSaveXlsxDirectResult` types. |
| `apps/web/src/App.tsx` | `handleDesktopSave`, `handleDesktopSaveAs`, and the desktop autosave branch route xlsx saves through the direct path (below). Added the dirty-race guard (Addendum 2): `dirtyEpochRef` incremented at the two dirty-marking funnels, module-level `subscribeEditFlightChanges` helper. |
| `apps/desktop/tests/direct-save.test.ts` | NEW — 12 tests (journal, E1 merge, sanitize/forwarding, temp path, atomic-sequence stubs, save base, real-serializer fault injection). |

## How serializeDesktopWorkbook assembles the serializer input

- `bulk = host.bulkReadback()` — the live main-process model, default
  (owner) principal: desktop is single-user owner context.
- `sheetNames = host.sheetNames()`; `definedNames =
  mergeDefinedNames(host.getDefinedNames(), extras.definedNames)` — the
  E1 rule (live engine names primary, client extras contribute only
  missing names). Neither engine nor service exports a merge helper (the
  existing copies live in gateway `engineSvc.ts` and web `io.ts`, neither
  importable from desktop main), so the exact semantics are mirrored in
  direct-save.ts and pinned by unit tests (scope+case-insensitive key,
  earlier wins, malformed dropped).
- `metadata = { ...saveBase.metadata, ...extras.extraMetadata }`
  (extras win, per brief).
- `sheets` = gateway `buildSaveHandoff` forwarding shape, replicated:
  per live sheet `{name, clientStyles, styles?, clientDims, dims?}` built
  ONLY from the client's reported `extras.sheetStyles` (sanitized with
  gateway-identical rules) and `extras.sheetDims`; nothing is forwarded
  from the engine's own parse — the serializer compares against
  `parsedSheets` (from the save base) itself.
- `sourceBytes` / `parsedSheets` from `getDesktopSaveBase()`;
  `ops` = journal copy; serializer loaded via cached
  `import('@icecream-sheets/service/save-node')` (variable specifier,
  the engine-load.ts dynamic-import pattern for ESM-from-CJS). The
  result (incl. `mode`) is returned to the caller.
- Mutating-ops set: `DIRECT_SAVE_MUTATING_OPS` from save-node, cached;
  if the module cannot load, a local mirror of the identical set (=
  gateway's `SAVE_MUTATING_OPS`) keeps journaling correct — the save
  itself still fails closed at serializer load.

## engine:saveXlsxDirect — path trust, dialog reuse, Excel sequence

Path handling REUSES the `file:saveBytes` machinery verbatim — no new
path logic:

1. Validate args; `extras` defaults to `{}` when not a record.
2. Destination FIRST: `resolveSaveTarget(suggestedPath, trustedDir)`
   (save-paths.ts, the GAP-10 decision `file:saveBytes` uses). Direct →
   that path. Otherwise the native `dialog.showSaveDialog` with the SAME
   title/default/filters as `file:saveBytes` (`suggestedName ||
   'workbook.xlsx'`; Excel/CSV/TSV/ODS/All filters). Cancelled →
   `{path: null}` and **nothing is serialized or written**.
3. Recalc settle (Addendum 1 item 2, also commented at the handler):
   desktop execute/recalc in the main process is synchronous and the
   renderer awaits `awaitEditsSettled()` before invoking this channel,
   so the serialized state is the fully-calculated settled state; no
   mid-calc state can be pinned.
4. `saveToDestinationAtomically((tmp) => serializeDesktopWorkbook(
   engineHost, extras, tmp), destPath)`:
   - temp = `.<name>.icecream-tmp-<pid>` IN THE DESTINATION'S DIRECTORY
     (`tempPathForDestination`) — the original brief's tmpdir+copy is
     superseded by Addendum 1 and was not implemented;
   - serialize to the temp; run the shared `verifyXlsxPackage(temp)`
     (fail-closed: missing export = save error);
   - only on success `renameSync(temp, dest)` — atomic same-filesystem
     replace. Any throw (serialize, fault injection, verify) deletes
     the temp, propagates as the save error, and leaves a pre-existing
     destination byte-identical.
5. On success `trustedDir = trustedDirOf(destPath)` (same GAP-10 update
   as `file:saveBytes`) and return `{path, mode, bytes, changedSheets}`.
   Autosave arrives here with its known trusted path → step 2 resolves
   direct, no dialog: the identical sequence, silently.

## App.tsx routing

In `handleDesktopSave`, `handleDesktopSaveAs`, desktop autosave branch:
when `saveFormat === 'xlsx'`, after `awaitEditsSettled()`, call
`desktopSaveXlsxDirect(buildServerSaveExtras(), path)` (path =
`desktopPath ?? undefined`; `undefined` for Save As; the trusted
`desktopPath` for autosave). On a non-null result with a path, set
`desktopPath` / trusted ref / saveState exactly as the existing code
did. `ensureSaveSnapshot`/`buildDownloadBytes` are NOT called on this
path. Bridge absent (`null`) → `console.warn` + existing bytes path.
Direct call THROWS → the handlers' existing catch → `setLastError`;
no silent fallback. Non-xlsx formats keep the existing path untouched.

## Addendum 2.1 — save/download signal-model mapping (desktop)

Desktop "save" matches the signal model exactly after this change: the
renderer sends NO workbook data (only the small session extras from
`buildServerSaveExtras` — metadata/defined-names/dims/styles) and
receives NO workbook bytes (only `{path, mode, bytes: <size>,
changedSheets}`). The main process serializes its live model and
commits to storage itself — the local file, via the temp → verify →
atomic-rename sequence. There is no desktop "download" of the workbook
on the save path at all; `file:saveBytes` remains only for non-xlsx
formats/exports and the bridge-absent fallback.

## Addendum 2.2 — ops during a save / dirty correctness

**Found: a real race in the manual handlers as first written.** Edits
mark dirty synchronously at commit (`commitCell` and `markFormatDirty`
— the only two `setSaveState('dirty')` sources outside autosave). A
user edit landing while a direct save's IPC round-trip is in flight
sets `'dirty'`, and the save's success handler then unconditionally set
`'saved'` afterwards — clobbering it. That edit is not in the file
(main's serialize is synchronous; executes queue behind it), and with
saveState wrongly `'saved'` autosave would never re-fire for it.

**Main-process side is safe by construction:** `serializeLiveWorkbook`
runs synchronously over the live model, so an `engine:execute` IPC
either lands entirely before the serialize (and is included) or queues
behind it (and is not) — the pinned state is always a settled revision,
never mid-calc.

**Guard added (minimal, on App's existing signals):**
- `dirtyEpochRef` — incremented inside the two existing dirty-marking
  funnels (`commitCell`, `markFormatDirty`); no parallel tracking
  system, it rides the exact calls that already mark dirty.
- `subscribeEditFlightChanges(host, cb)` — subscribes to the save
  interlock's `EditInFlightTracker` via the host's existing
  `subscribeEditFlight` (fires on EVERY edit begin/end, so an edit that
  began AND settled during the save is still seen; duck-typed like
  `editFlightSourceOf`).
- In all three direct-save sites: capture epoch + subscribe before the
  call, unsubscribe in `finally`; on success mark `'saved'` ONLY when
  `flightChanges === 0 && epoch unchanged && !hostHasInFlightEdits(host)`,
  else stay `'dirty'` (autosave then re-fires and persists the edit).
  The autosave branch previously checked only `hostHasInFlightEdits`
  (an edit that settled mid-save slipped through); it now uses the
  same combined condition. Conservative by design: any observed
  movement keeps dirty — a redundant autosave is harmless, a lost one
  is not.

## Forced-failure evidence (Addendum 1 item 3)

`apps/desktop/tests/direct-save.test.ts`, real shared serializer
(service built to `dist/save/directSave.js`):

- Destination pre-filled with known bytes; `ICECREAM_SAVE_FAULT_INJECT=
  'midwrite'` → `saveToDestinationAtomically(serializeDesktopWorkbook)`
  rejects with `injected save fault (midwrite)`; destination bytes
  **byte-identical** afterwards; **no `.icecream-tmp-*` file left** in
  the directory.
- Env cleared → same sequence succeeds: mode `verbatim`, destination
  replaced, output parseable via XlsxAdapter (Sheet1 `A1 === 99` — the
  post-edit live value — and `B2 === '=A1+B1'` preserved).
- Stub-serializer tests pin the helper itself: success rename, mid-write
  throw, and verify failure (both `{ok:false}` and throwing forms) all
  leave the destination untouched with no temp behind.

## Build / test results (exact)

- `packages/service`: `npm run build` (tsc) — PASS; `dist/save/directSave.js`
  + `.d.ts` produced by the parallel worker's module.
- `apps/desktop`: `npm run build` (tsc) — PASS, no errors.
- `apps/web`: `npm run build` (tsc + vite) — PASS (chunk-size warning
  only, pre-existing).
- `apps/desktop` full suite: **15 files, 112 tests, all passed**
  (incl. new direct-save.test.ts 12 tests; engine-ipc 15; engine-load 6;
  save-paths 11).
- `apps/web` related: **ipcEngine.test.ts 24 + io.test.ts 18 +
  saveInterlock.test.ts 10 = 52 tests, all passed.**

## Where the old renderer serialization still runs on desktop (and why)

1. **Non-xlsx save formats** (csv/tsv/ods/xlsb/html) in Save / Save As /
   autosave → `buildDownloadBytes` + `desktopSaveBytes`. Per brief:
   the direct path is xlsx-only (the shared serializer writes xlsx);
   other formats keep the existing adapter path.
2. **Bridge-absent fallback** (older desktop shell without
   `saveXlsxDirect`) → same bytes path, with a `console.warn` at each
   site so the fallback is visible.
3. **Out-of-scope flows the brief did not name** — unchanged:
   browser-style Download / encrypted download, email/export fallbacks,
   and library save/autosave (IndexedDB/server library entries, not the
   native-file save). These still use `ensureSaveSnapshot` +
   `buildDownloadBytes` on desktop. If the invariant is later extended
   to library saves, the main-process serializer can write those bytes
   too, but that is a separate change (bytes would need an IPC return
   channel or a main-side library store).

## Addendum 3 — AutoSave sync model (single author): continuous batch checkpointing

Same model as the web/gateway sync design, against the local file. No
co-authoring work.

### Scheduler (apps/desktop/src/direct-save.ts)

- Lives beside the op journal: `noteDesktopSaveOp` (called from
  engine-ipc on every successful mutating command) (re)arms the
  scheduler after each op.
- **Defaults: settle timer 1500 ms** (re-armed/debounced per journaled
  op, `CHECKPOINT_SETTLE_MS`), **force-flush at 200 pending ops**
  (`CHECKPOINT_MAX_PENDING_OPS`). Timer is `unref`'d.
- A checkpoint fires only when ALL hold: scheduler configured (main.ts
  `registerIpc` → `configureDesktopCheckpoints({getHost})`), a known
  autosave target exists, and pending ops > 0. Checkpoint =
  `serializeDesktopWorkbook` → temp in destination dir →
  `verifyXlsxPackage` → atomic rename (the Addendum-1 sequence, via
  `saveToDestinationAtomically`). Extras = the last session extras a
  save/flush carried (`setLastSaveExtras`); values/formulas always come
  from the live host.
- **Revisions are journal positions:** `liveRevision` = journaled ops
  since load; `storageRevision` = the journal cut the last successful
  checkpoint/save covered. The flush captures its cut BEFORE
  serializing; ops landing during the flight sit past the cut, stay
  pending, and form the next batch (the finally-block re-arms the
  timer). A failed checkpoint never throws to callers: it logs, leaves
  the batch pending, and re-arms on the settle cadence.
- Journal/load lifecycle: `clearDesktopSaveOps` also resets
  `storageRevision` and cancels the timer; `engine:new` additionally
  clears the target.

### Where main learns the destination

- `engine:saveXlsxDirect` success → `recordAutosaveTarget(destPath)` +
  `markStorageCovered(cut)`.
- `file:saveBytes` success → recorded ONLY for the workbook's own save
  (xlsx-family extension AND no export `suggestedName` — exports like
  "Sheet1.pdf"/"data.csv" must never redirect background checkpoints).
- `engine:load` → `noteDesktopLoadForAutosave(filename)`: desktop file
  opens pass the ABSOLUTE path as the load filename (pickOpen / OS
  open), which becomes the target; a bare name (library entry, URL
  open) clears it — no background writes until the user saves to a
  path. No destination known → no background writes at all. Offline
  changes nothing (the destination is a local file).

### Flush confirmation (renderer autosave)

- Bridge: `file.autosaveFlush(extras?)` → IPC `engine:autosaveFlush`
  (main stores the extras as freshest, then
  `flushDesktopCheckpoint('renderer-flush')`). Response shape:
  `{ storageRevision, liveRevision, caughtUp, flushedOps }` —
  `caughtUp === (storageRevision === liveRevision)`, `flushedOps` = ops
  this flush wrote (0 when already caught up / no destination).
- App.tsx desktop autosave branch: when the flush bridge exists it
  calls `desktopAutosaveFlush(buildServerSaveExtras())` INSTEAD of
  serializing anything. Mapping: `'saving'` (set at branch start) =
  storage behind; result → `'saved'` only when `caughtUp` AND the
  Addendum-2 dirty-race guard is clean (dirty epoch unmoved, zero
  edit-flight changes during the flush, nothing in flight) — an edit
  landing during the flush is past the checkpoint's cut and leaves the
  workbook `'dirty'`; otherwise `'dirty'` as well. Bridge absent →
  the previous cascade (direct save → bytes path) unchanged.
- Manual Save skip: in `engine:saveXlsxDirect`, when `suggestedPath`
  resolves to the recorded autosave target AND nothing is pending
  (`storageRevision === liveRevision`) AND the destination file still
  exists, the handler returns `{path, mode: 'checkpoint-current',
  skipped: true, bytes: <file size>, changedSheets: []}` without
  re-serializing (logged in main). Save As (no suggestedPath)
  always serializes via the Addendum-1 sequence.

### Addendum 3 tests / builds

- NEW `apps/desktop/tests/direct-save-checkpoint.test.ts` — **9 tests,
  all passed**: no-destination → no serialization/no writes;
  flush-when-caught-up performs no serialization; **ops during an
  in-flight checkpoint land in the next batch** (cut 2 of 3, second
  flush covers exactly 1); settle timer flushes unaided; op cap (3)
  forces a flush off-timer; recording a destination with pending ops
  arms checkpointing; load target sync (absolute path sets, bare name
  clears); end-to-end checkpoint through the real atomic sequence
  parses back with the live value (42); failing checkpoint keeps the
  batch pending and the destination byte-intact. Fake host/serializeFn
  injection follows the atomic-helper pattern (fakes write real
  packages so the real `verifyXlsxPackage` runs).
- Builds: desktop `tsc` PASS, web `tsc + vite` PASS.
- Suites after Addendum 3: **desktop full — 16 files, 121 tests, all
  passed** (112 prior + 9 new); **web related — ipcEngine 24 + io 18 +
  saveInterlock 10 = 52, all passed.**

## Notes / residuals

- `mergeDefinedNames` is a third copy of the E1 merge (gateway, web io,
  now desktop direct-save) because no shared package exports it; worth
  hoisting into the service package in a later cleanup.
- Protection metadata: the gateway merges its server-side
  ProtectionManager state into save metadata; on desktop the brief's
  merge is save-base ← extras only, and that is what is implemented
  (the renderer's protection state is synced to main for enforcement,
  but not merged into save metadata here).
