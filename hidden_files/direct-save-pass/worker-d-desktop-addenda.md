# Worker D — Desktop follow-up: Addendums 3 + 4 (+ 5 + 6 refinements)

Scope: extend worker C's desktop direct save with the AutoSave batch-sync
model (Addendum 3), the save pin + CoW stash (Addendum 4), batch
materialization semantics + the structural-op barrier (Addendum 5), and
autosave ownership / strict no-op / extras sync (Addendum 6). Single
author, local file destination, NO co-authoring. packages/gateway
untouched. No git push.

State note: the Part 1 core (scheduler in direct-save.ts, IPC handlers in
main.ts, preload bridge, desktopAgent wrapper, App.tsx flush branch) and a
9-test checkpoint suite (`apps/desktop/tests/direct-save-checkpoint.test.ts`)
landed in an earlier partial pass of this brief; this pass audited it
against the brief, closed the gaps (settle-env wiring, skip testability,
pin wiring, overflow retry), and implemented Addendums 5 + 6 in full.

## Part 1 — Addendum 3: continuous batch checkpointing

### Scheduler design (apps/desktop/src/direct-save.ts)

- Journal: `noteDesktopSaveOp` (called from engine-ipc on every
  successful mutating command) appends to the save-op journal AND drives
  the scheduler: (re)arms a settle timer, or forces a flush at the op cap.
- Defaults: settle **1500 ms** (`CHECKPOINT_SETTLE_MS`), op cap **200
  pending ops** (`CHECKPOINT_MAX_PENDING_OPS`). Settle is overridable via
  env **`ICECREAM_AUTOSAVE_SETTLE_MS`** — `resolveAutosaveSettleMs(env)`
  (unset / non-numeric / ≤ 0 → default), wired in main.ts
  `configureDesktopCheckpoints({ settleMs: resolveAutosaveSettleMs(process.env) })`.
- Flush (`flushDesktopCheckpoint(reason)`): coalesces concurrent calls
  onto the in-flight checkpoint; captures the journal **cut** up front —
  ops journaled during the flight are past the cut and form the next
  batch. Checkpoint = `serializeDesktopWorkbook` (with the Addendum-4
  pin, Part 2) → `saveToDestinationAtomically` (C's temp-in-dir → verify
  → atomic rename). On success `storageRevision` advances to the cut; on
  failure the batch stays pending and the settle timer re-arms (never a
  hot loop). Never throws.
- Revisions: `liveRevision` = total journaled ops since load;
  `storageRevision` = journal cut covered by the last successful
  checkpoint/save (`markStorageCovered`).

### Destination learning

- `recordAutosaveTarget(path)`: called by main.ts after a successful
  `engine:saveXlsxDirect` save AND by `file:saveBytes` for the workbook's
  own xlsx-family saves (`noteSaveBytesDestination` — exports with a
  suggestedName and non-xlsx extensions never become the target).
- Open-from-path: `noteDesktopLoadForAutosave(filename)` in engine-ipc's
  `engine:load` handler — desktop opens (file:pickOpen, icecream:open-path)
  pass the ABSOLUTE path as the load filename, so the opened file becomes
  the target; a bare name (library/URL open) CLEARS the target.
- `engine:new` / New Workbook clears the target (`clearAutosaveTarget`).
- No known target → the scheduler does nothing (no writes, no timers run
  a flush: flush returns immediately with flushedOps 0).

### Flush confirmation bridge

- IPC `engine:autosaveFlush` (main.ts) → `flushDesktopCheckpoint('renderer-flush')`,
  returns `{ storageRevision, liveRevision, caughtUp, flushedOps }`
  (caughtUp === storage covers live; Addendum 6 adds the extras flag —
  see below). Extras riding on the call fold into the pending extras store.
- Preload: `file.autosaveFlush(extras?)`. desktopAgent:
  `desktopAutosaveFlush(extras?)` — feature-detect, `null` when absent.
- Manual-save skip: `shouldSkipCheckpointCurrentSave({suggestedPath,
  destPath, destExists})` in direct-save.ts (extracted from main.ts so it
  is unit-testable): in-place save + dest === autosave target + nothing
  pending + storage === live (+ !extrasDirty per Addendum 6) + file still
  exists → handler returns `{ path, mode: 'checkpoint-current', skipped:
  true }` without serializing, and counts a noopSkip (Addendum 6).

## Part 2 — Addendum 4: pin + CoW stash

**Engine state: worker E's API HAS LANDED** (`packages/engine/src/protocol.ts`:
`beginSavePin(opts?) → SavePin {id, rev}`, `bulkReadbackSheetPinned(pin,
sheet, auth?)`, `releaseSavePin(pin)`, `savePinStashCells(pin)`,
`SavePinOverflowError` exported from `@icecream-sheets/engine`, name-set
exactly as declared). Engine rebuilt (`packages/engine npm run build`);
desktop's pinned path is verified against the REAL host (tests below),
not only fakes. The desktop code feature-detects the API
(`savePinHostOf`) so it still compiles/runs against a pre-pin engine
build, falling back to the single `bulkReadback()` pass.

- `assembleBulkReadbackPinned(host, sheetNames)` (direct-save.ts):
  begin pin → per sheet `bulkReadbackSheetPinned`, awaiting a
  **setImmediate between sheets** (renderer IPC executes arriving during
  the read run while the pin holds state — proven by an event-order
  test) → capture `savePinStashCells` → **release the pin immediately
  after assembly** (in a `finally`: also on read errors), before any
  serialization. `serializeDesktopWorkbook` uses it and logs
  `save pin rev <n>: assembled <k> cell(s) sheet-by-sheet (CoW stash at
  release: <m> cell(s))`.
- IPC execute (engine-ipc.ts): `dispatchDesktopEditWithSavePinRetry` —
  catches `SavePinOverflowError` (matched by error/constructor name via
  `isSavePinOverflowError`, realm-safe), logs the queueing once, retries
  every **25 ms up to 30 s**; after the timeout the error surfaces as a
  failed command result — the op is never lost silently. Non-overflow
  errors propagate immediately. This mirrors the gateway behavior.
- Real-engine evidence (tests): pin a real host, `setCell` during the
  pin is CoW-stashed (`savePinStashCells(pin) === 1`) and the pinned
  readback still returns pin-time state; a structural `addSheet` during
  the pin throws the REAL `SavePinOverflowError` (instanceof the engine
  export) and is NOT applied; the IPC retry wrapper applies it after
  `releaseSavePin`.

## Addendum 5 — batch materialization + structural-op barrier

### 5.1 Materialization semantics (by construction, asserted in tests)

The checkpoint materializes from the LIVE model at the journal cut via
the pin: final value per cell, written once; one regeneration per dirty
sheet per batch. **The op journal is NOT collapsed** — only file
materialization collapses; the journal keeps every op (the watermark
`storageRevision` moves, entries are retained for the serializer's
verbatim planning until load/new). Test evidence
(`direct-save-autosync.test.ts`, "batch materialization semantics"):
- Fake-state batch: 3 ops on `Sheet1!A1` (1→2→3) + 1 on Sheet2 in one
  batch → exactly 1 serialization; the batch's changed-sheet set is
  `['Sheet1','Sheet2']` (Sheet1 once); the written file holds the final
  value 3 (once); journal still holds all 4 ops afterwards.
- REAL serializer: 3 setCells on one sheet → `result.changedSheets ===
  ['Sheet1']` exactly once; parse-back holds the final values (42, 7).

### 5.2 Structural-op barrier — wiring

- Classification in direct-save.ts mirrors the gateway's
  `CHECKPOINT_CELL_OPS` / `CHECKPOINT_NAME_OPS` (engineSvc.ts) and the
  shared serializer's planner classes (service/save/directSave.ts):
  cell ops = {setCell, setFormula}; name ops = {defineName, deleteName,
  renameName, updateNameRefersTo, defineFunction, updateFunction,
  rollbackFunction, deleteFunction}; structural = any other mutating op
  (`isStructuralBarrierOp`, gated on the mutating set so recalculate /
  unknown verbs never barrier).
- engine-ipc `engine:execute` handler: BEFORE dispatch (and before the
  pin-retry wrapper), `flushCheckpointBeforeStructuralOp(cmd)` runs —
  when the op is structural AND un-checkpointed ops are pending, it logs
  `[checkpoint] structural barrier: flushing <n> pending op(s) before
  <cmd> — the structural op starts a fresh batch`, awaits
  `flushDesktopCheckpoint('structural-barrier')`, then the op applies.
  Best-effort: no destination / failed checkpoint → logged, op still
  applies, batch stays pending. Barrier bookkeeping is wrapped so it can
  never fail an edit.
- IPC-order evidence (test): with a pending setCell, executing addSheet
  produces the order `['checkpoint', 'execute:addSheet']`; a defineName
  executes directly with no checkpoint.

### 5.2 Per-type handling table

| Op type | Barrier? | Batch handling (mirror of gateway) |
|---|---|---|
| setCell / setFormula | No | Same batch; verbatim regeneration of touched sheets only. |
| Name family (define/delete/rename/updateName, define/update/rollback/deleteFunction) | No | Stay in the batch — they ride workbook.xml defined-names surgery in the shared serializer (verbatim-eligible). |
| insertRows / deleteRows / insertCols / deleteCols | **Yes** — pending batch flushes first; the op starts a fresh batch | That batch regenerates ALL sheets streaming in the shared serializer; serializer keeps mode `verbatim` for these (core worker's serializeLiveWorkbook update). Desktop surfaces it in the checkpoint log: `mode=verbatim … rowColStructural=all-sheets-regen`. |
| Sheet-set changes (addSheet / deleteSheet / renameSheet / duplicateSheet / moveSheet) | **Yes** | Adapter-fallback for that batch; reason surfaced in the checkpoint log: `mode=adapter-fallback fallbackReason=sheet-set-change` (never silent). |
| setCalculationMode | **Yes** | Adapter-fallback for that batch; log carries `fallbackReason=calculation-mode-change`. |

The fallback why-class is computed by `checkpointBatchNote(journalSlice)`
and appended to every checkpoint flush log line together with the
serializer's returned mode (matching the gateway's
`fallbackReason=structural-op|verbatim-planning` convention; desktop
refines structural-op into sheet-set-change / calculation-mode-change).

## Addendum 6 — autosave ownership, strict no-op, extras sync

### Status IPC (renderer displays only)

- `engine:saveStatus` (main.ts) → `getSaveStatus()` (direct-save.ts):
  `{ liveRevision, storageRevision, extrasDirty, flushes, noopSkips,
  targetPath, pendingOps }` — cheap, no side effects, no I/O.
- Preload: `file.saveStatus()` (+ `DesktopSaveStatusResult` type).
  desktopAgent: `desktopSaveStatus()` — `null` when the bridge lacks it.
- App.tsx desktop autosave effect (xlsx): **status poll only** — an
  immediate poll + ~2 s interval while dirty; `storageRevision ===
  liveRevision && !extrasDirty` (plus C's dirty-epoch / in-flight-edit
  guard across the read) → `'saved'`; otherwise stays `'dirty'`. It
  never calls flush/serialize. **What remains of the old renderer
  autosave timer: status display only.** The Addendum-3 flush call and
  the direct-save call were removed from the timer branch; the legacy
  renderer-bytes timer survives ONLY for non-xlsx formats (no
  main-process checkpoint serializer exists for them — out of the
  direct-save brief's xlsx scope). Manual Save remains the only
  client-initiated save (saveXlsxDirect force path in main).

### Strict no-op + counters

- `flushDesktopCheckpoint`: when `pendingOps === 0 && !extrasDirty` it
  returns BEFORE any target/serialize/temp work — **zero writes, no
  temp file created** (`tempPathForDestination` is never reached on
  this path; `saveToDestinationAtomically` is not entered) — and
  increments `noopSkips`. The manual-save checkpoint-current skip
  counts a noopSkip too, and now also requires `!extrasDirty`.
- Counters live in direct-save.ts state, surfaced via saveStatus:
  `flushes` = successful checkpoint writes (flushDesktopCheckpoint
  only), `noopSkips` = strict no-op save checks.
- Test evidence ("strict no-op…"): after a real flush (flushes=1), a
  second flush check leaves the destination's **mtime and bytes
  byte-identical**, the destination directory contains ONLY the workbook
  file (no `.icecream-tmp-*` ever created), serializeFn call count
  stays 1, `noopSkips` increments per check (1, then 2).

### Extras sync to main

- IPC `engine:sessionExtras` {extras} → `setPendingSessionExtras`
  (returns `{extrasDirty}`); preload `file.syncSessionExtras(extras)`;
  desktopAgent `desktopSyncExtras(extras)` (false when bridge absent).
- direct-save.ts store: `pendingExtras` + canonical (key-order-
  insensitive) comparison — `extrasDirty` is set ONLY when the payload
  actually changes; `extrasVersion` increments per real change. A change
  arms the settle timer (main decides the flush). Consumption is
  version-cut based (`consumeSessionExtrasUpTo`): a successful flush
  consumes the extras as of its cut; a change landing mid-flight stays
  dirty. Manual save consumes via `consumeSerializedSessionExtras`
  after the atomic replace (main.ts).
- `serializeDesktopWorkbook(host, extras | undefined, …)`: an explicit
  payload folds into the pending store and is used; **no payload → the
  pending synced extras are the source** (the scheduler path passes
  `getPendingSessionExtras()`). Journal clear (load/new) resets the
  store so stale extras never leak into a new workbook.
- App.tsx: debounced (800 ms) effect in the desktop context sends
  `buildServerSaveExtras()` via `desktopSyncExtras` whenever
  `buildServerSaveExtras`' identity changes — the reused existing
  change signal (it is rebuilt when the format store, name services,
  sheet set, or client-metadata applier changes). It is state sync,
  never a save trigger.
- Extras also gate caught-up everywhere it matters: flush result
  `caughtUp`, `getCheckpointStatus`, the App poll, and the manual-save
  skip all require `!extrasDirty`.

## Consolidated-brief mappings (write-ahead ordering + flush triggers)

- **Write-ahead ordering:** on desktop, ops are journaled in main
  BEFORE any checkpoint materialization can cover them:
  `engine:execute` journals a successful op (`noteDesktopSaveOp`) before
  the scheduler can arm/fire, and `flushDesktopCheckpoint` captures its
  cut from the journal — **a checkpoint never covers ops that aren't in
  the journal** (the cut IS a journal length; the serializer receives
  exactly `getDesktopSaveOps()`). Asserted by the journal-split test
  (an op journaled mid-flight is NOT in the in-flight checkpoint's
  covered count).
- **Flush triggers on desktop:** (1) settle timer (1500 ms default,
  `ICECREAM_AUTOSAVE_SETTLE_MS`); (2) 200-pending-op cap; (3) explicit
  Save = flush confirmation (`engine:autosaveFlush` force path + the
  manual saveXlsxDirect path, incl. the checkpoint-current skip);
  (4) structural-op barrier (Addendum 5); (5) extras-change settle arm
  (Addendum 6 — same settle cadence).
- **App/window close — NO equivalent exists, stated plainly:** main's
  `before-quit` handler is teardown-only (MCP ingress close,
  parallel-worker dispose, host dispose) — there is NO quit-time
  checkpoint flush, and the GAP-6 dirty guard covers File > New
  Workbook only, NOT quit/window-close. Per the consolidated brief's
  conditional ("close if a hook exists… note the guard as the
  equivalent rather than building new quit machinery"), no new quit
  machinery was built. Residual exposure is bounded: un-checkpointed
  ops at quit are at most one settle window (≤ 1500 ms of edits, or
  < 200 ops) past the last checkpoint, and only when a destination is
  known; the journal is in-memory, so a crash has the same bound. If
  the user wants a quit flush, it needs a deliberate async before-quit
  design (preventDefault + flush + re-quit) — flagged, not built.

## Files changed (this pass)

| File | Change |
|---|---|
| `apps/desktop/src/direct-save.ts` | Settle-env resolver; save-pin assembly (feature-detected) + `isSavePinOverflowError`; op/batch classification + `checkpointBatchNote`; structural barrier helper; flush log mode/reason surfacing; Addendum 6 extras store (canonical compare, version cuts), strict no-op + `flushes`/`noopSkips` counters, `getSaveStatus`; manual-save skip helper (extracted) + extras gate; serialize consumes pending extras when caller passes none. |
| `apps/desktop/src/engine-ipc.ts` | `dispatchDesktopEditWithSavePinRetry` (25 ms poll / 30 s cap, queueing logged) used by the execute handler; structural-op barrier before dispatch. |
| `apps/desktop/src/main.ts` | `settleMs` from env; skip via `shouldSkipCheckpointCurrentSave` + noopSkip counting; `engine:saveStatus` + `engine:sessionExtras` handlers; extras consumption after manual save. |
| `apps/desktop/src/preload.ts` | `file.saveStatus()`, `file.syncSessionExtras(extras)` + `DesktopSaveStatusResult`. |
| `apps/web/src/services/desktopAgent.ts` | Optional `saveStatus` / `syncSessionExtras` bridge fns + `desktopSaveStatus()` / `desktopSyncExtras()` + status type. |
| `apps/web/src/App.tsx` | Desktop xlsx autosave effect → status poll only (flush/direct calls removed); debounced session-extras sync effect reusing `buildServerSaveExtras` identity as the change signal. |
| `apps/desktop/tests/direct-save-autosync.test.ts` | NEW — 32 tests (below). |
| `packages/engine` | Rebuilt only (work E's pin API); no desktop-side engine edits. |

## Test evidence (exact)

- NEW `apps/desktop/tests/direct-save-autosync.test.ts` — **32 tests**:
  scheduler journal-split at the cut; caught-up flush = no
  serialization; no target = no writes; settle batching; op-cap flush;
  destination learning; settle-env parsing; manual-save skip matrix;
  batch materialization (fake-state + REAL serializer changedSheets);
  pin assembly (order/yield/release/fallback) + pinned serialize
  end-to-end (fake pin host) + REAL-host pin (serialize log line, CoW
  stash counts, real SavePinOverflowError instanceof, retry applies
  after release); overflow retry (success-after-queue, timeout
  surfaces, non-overflow not retried); barrier classification, batch
  notes, barrier-before-apply (helper + IPC order), fallback-reason log
  surfacing; Addendum 6 strict no-op (mtime+bytes+no-temp+counters),
  extras change detection (key-order-insensitive), extras-dirty write
  at equal revisions + consumption + scheduler pass-through, extras
  settle-arming, pending-extras consumption by serialize, saveStatus
  shape.
- Desktop suite (full): **17 files, 153 tests, all passed** (incl. C's
  direct-save 12, the checkpoint suite 9, engine-ipc 15).
- Web related: **ipcEngine 24 + io 18 + saveInterlock 10 = 52 passed**.
- Builds: desktop `tsc` PASS; web `tsc + vite` PASS (pre-existing
  chunk-size warning only). Engine `tsc` build PASS (pin API in dist).

## Not done / residuals

- Quit-time flush: none exists and none was built (see mapping above) —
  the one flush trigger without a desktop equivalent.
- Non-xlsx desktop autosave still uses the legacy renderer-bytes timer
  (no main-process checkpoint serializer for those formats; out of the
  xlsx-scoped brief).
- `desktopAutosaveFlush` remains available as a bridge API and main's
  force-flush path remains for manual/explicit flows; the renderer no
  longer calls it from any timer.
