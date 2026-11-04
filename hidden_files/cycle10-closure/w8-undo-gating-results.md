# Cycle 10 Closure — W8: Undo/Redo on Async Hosts (D2) + Save-Gating Audit (D3)

Date: 2026-10-20 (worker run). Scope: defects D2 + D3 from
`w6-desktop-sweep-results.md`. No git push. `perf-evaluation.md` /
`progress.md` / `TODO.md` untouched. Desktop app NOT repackaged (a
revalidation worker will repackage once all fixes land).

## D2 — Undo/redo broken for grid edits

### Root cause (per host mode)

`UndoManager` (`apps/web/src/features/undo.ts`) was written against a
SYNCHRONOUS host. Two of the three hosts are async at runtime while
keeping synchronous signatures:

| Host mode | execute() runtime | View reads | Undo before fix |
|---|---|---|---|
| Local in-process `EngineHost` (web local mode) | real `CommandResult`, sync | real values, sync | ✅ worked |
| `RemoteEngineHost` (web gateway mode) | **Promise** (routed edit) | read-through cache; miss = EMPTY placeholder | ❌ broken |
| `IpcEngineHost` (desktop) | **Promise** (IPC round-trip) | read-through cache; miss = EMPTY placeholder | ❌ broken (W6 repro) |

Three compounding failures on the async hosts, proven with a repro
(real `IpcEngineHost` over a stateful mock bridge + real `UndoManager`,
edit C10 0.1667 → 0.5, then undo):

1. **False verdict.** `applyState()` read `.ok` off the Promise returned
   by `host.execute()` (`undefined`) → `undo()`/`redo()` ALWAYS returned
   false → App showed **"Nothing to undo."** — exactly W6's symptom.
   W6's inference "edits are never recorded" was wrong in mechanism: the
   entry IS recorded (`capture()` runs in `commitCell` before execute on
   every host) and the restore execute WAS dispatched (the mock engine
   store did revert) — the app just reported failure.
2. **Placeholder before/redo states.** `readBefore()` reads through
   `getView().readCell()`. On async hosts an uncached cell reads as the
   EMPTY placeholder. The worst case is the redo-state capture inside
   `undo()` itself: it runs right after the edit's `cellsChanged`
   invalidation evicted the cell from the cache, so redo recorded a
   phantom empty value and would have "reapplied" a cell clear. The
   pre-edit capture had the same hole for any cell not yet cached.
3. **Stale cache fills (IPC host).** A background fill whose IPC read
   was issued before a mutation could land after it and resurrect the
   pre-edit value in the renderer's value cache — in the repro, after
   undo the engine store held 0.1667 but the renderer view still showed
   0.5. (This is a contributing reason W6 saw the grid value unchanged.)

### Fix

- `features/undo.ts`: async API alongside the sync one —
  `captureAsync()` (before-states via the host's authoritative
  `readCellAsync` when present; sync fallback on the local host),
  `undoAsync()` / `redoAsync()` (awaited current-state capture + awaited
  restore executes; the returned boolean is the engine's real verdict),
  and `isAsyncHost()`. Named-range hooks behave identically in the
  async variants.
- `App.tsx` `commitCell`: on async hosts the edit now awaits
  `captureAsync` BEFORE dispatching the edit (local hosts keep the exact
  synchronous path). The smart-chip branch's identical Promise-`.ok`
  misread was fixed by routing it through the existing `settleEdit`.
- `App.tsx` `handleUndo`/`handleRedo`: use `undoAsync`/`redoAsync` on
  every host (correct on local too). The restore goes through
  `host.execute` — on the gateway host that IS the routed-edit path
  (`executeRoutedAsync`), so undo of a server-routed edit is itself a
  routed edit and the server stays source of truth per
  HYBRID-CONSISTENCY.md; on desktop it goes through the same IPC
  execute as the original edit. Optimistic display and the save
  interlock are untouched (restores count as in-flight edits in both
  hosts' `EditInFlightTracker`s, so a save still defers past an undo).
- `services/ipcEngine.ts`: per-cell mutation epochs — bumped on
  `setCell`/`setFormula` execute and on `cellsChanged` invalidation;
  cell/range background fills capture epochs at queue time and drop
  stale payloads on landing (root cause 3).

Known remaining limitation (noted, out of D2's grid-edit scope): other
`UndoManager.capture()` call sites in App.tsx (structural ops, Solver,
Goal Seek, inference proposals, …) still capture synchronously; on
async hosts their before-states have the same placeholder risk for
uncached cells. Their undo/redo RESULTS are now reported truthfully
(async apply), and grid edits — D2 — are fully fixed.

### Regression tests (new)

`apps/web/src/features/undoAsync.test.ts` (5 tests):
- IPC host: edit → `undoAsync` returns true, engine store AND renderer
  view revert; `redoAsync` returns true and reapplies the REAL edited
  value (not the placeholder).
- IPC host: `captureAsync` records the real before-value for a cell
  never primed into the cache (sync capture would have recorded EMPTY).
- IPC host: formula edit undoes to the previous value, redoes to the
  formula.
- IPC host: empty-stack undo/redo return false.
- Gateway-shaped promise host: undo is a routed edit — the "server"
  store ends reverted, redo reapplies.

## D3 — "Save encrypted" not gated during load + entry-point audit

### Fix (primary)

- `ribbon/Ribbon.tsx`: "Save encrypted" now takes Save's exact
  treatment while `desktopLoading` (= `!workbookLoaded`): label
  "Loading…", `disabled`, title "Workbook is still loading — save is
  disabled until the load completes".
- `App.tsx` `handleDownloadEncrypted`: refuses while
  `!workbookLoadedRef.current` with the same message (covers the
  command palette / any non-ribbon caller), and the command-registry
  entry `file.saveEncrypted` gained `enabled: () => workbookLoadedRef.current`
  (mirroring `file.save`).
- Backstop already existed and is unchanged: the submit path serializes
  via `fetchServerWorkbookBlob()` / `buildDownloadBytes()`, which throw
  on the load gate.

### Other entry points audited

| Entry point | Before | Action |
|---|---|---|
| Ribbon Save / Save .fmt (download dialog) | UI-gated (disabled + Loading…) | — already gated |
| **`handleDownload` (dialog opener; also web Ctrl+S)** | **ungated** — dialog opened during load (confirm then failed on the serializer gate) | **Gated** in the handler |
| Named-range download (same dialog, `handleConfirmDownload`) | serializer-gated only (`fetchServerExportBlob` / `buildNamedRangeDownloadBytes` throw) | covered by the `handleDownload` gate above |
| **Ribbon "Download as PDF"** | **UI ungated** (handler `handleDownloadPdf` gated) | **Gated** in ribbon: Loading… label, disabled, export reason title |
| **Ribbon Email items (Send Workbook / Send Active Sheet)** | **UI ungated** — dialog opened during load (send then failed on the serializer gate in `handleSendEmail`) | **Gated** in ribbon (disabled items + reason) AND in App's `onOpenEmail` wrapper |
| Library save (`handleLibrarySave`, library dialog) | fail-closed downstream only (serializers throw; error surfaced, returns null) | **Hardened**: explicit early gate with the standard message |
| Desktop Save / Save As (`handleDesktopSave/As`) | handler-gated | — already gated |
| Autosave (library + desktop path) | effect-gated on `workbookLoaded` | — already gated |
| Print preview (Ctrl+P) | preview is a view (not an export); its Download-as-PDF action calls the gated `handleDownloadPdf` | — noted, no change |
| StatusBar save segment | disabled Loading… treatment | — already gated |

### Regression tests (new)

`apps/web/src/ribbon/RibbonSaveGating.test.tsx` (3 tests, jsdom):
renders the real Ribbon, opens the File tab, and asserts — while
loading — no enabled "Save encrypted" button exists, ≥2 save buttons
carry Save's disabled Loading… treatment, and the PDF button is
disabled with the export reason; once loaded, "Save encrypted" and
"Download as PDF" are enabled with their normal titles.

## Validation

- Targeted suites: `undoAsync.test.ts` 5/5, `undo.test.ts` 6/6,
  `ipcEngine.test.ts` 21/21, `RibbonSaveGating.test.tsx` 3/3.
- TypeScript: `apps/web` `tsc --noEmit` clean.
- Full web suite: **120 test files / 1,566 tests, all passed, 0
  failures** (`apps/web` vitest, run after all changes; baseline before
  this pass was 119 files / 1,553 tests).
- Desktop suite: not run — no files under `apps/desktop/**` were
  touched; the desktop-relevant code here is the shared web renderer
  (`IpcEngineHost` + undo), covered by the web suite above.
- Browser (gateway path, `hidden_files/pw2/w8-undo-gating.mjs` against
  the running stack — gateway :8100, engine :8101, web preview :4173
  rebuilt in gateway flavor from the fixed source and restarted,
  HTTP 200; test user `e2e-tester` per e2e-gateway.sh login):
  - **D2 PASS.** Grid edit A1 = 4242 → engine read-back
    `{number, 4242}`, grid shows 4242. **Ctrl+Z → engine read-back
    `{null}`, grid empty, and NO "Nothing to undo." in the status
    text. Ctrl+Y → engine read-back `{number, 4242}`, grid 4242, no
    "Nothing to redo."** Undo/redo in gateway mode are routed edits:
    the server engine itself reverted and reapplied, verified
    independently of the UI.
  - **D3 PASS.** During a real perf-p75 drop-open (Loading banner up,
    5 samples at 120 ms cadence): 3 ribbon buttons carried a
    "still loading" title and ALL were disabled; the Save-encrypted
    button rendered label "Loading…", `disabled=true`, title
    "Workbook is still loading — save is disabled until the load
    completes". After 100% load it flipped back to enabled
    "Save encrypted" with its normal title.
- Desktop: not repackaged (per instructions). The fix was validated in
  the desktop host's own context via `IpcEngineHost` integration tests
  (stateful mock bridge = the main-process side of the IPC contract);
  the packaged-app revalidation is the revalidation worker's pass.

## Files changed

| File | Change |
|---|---|
| `apps/web/src/features/undo.ts` | Async undo API: `captureAsync`, `undoAsync`, `redoAsync`, `isAsyncHost` (+ D2 root-cause note). Sync API unchanged. |
| `apps/web/src/features/undoAsync.test.ts` | NEW — D2 regression tests (IPC host integration + gateway-shaped host). |
| `apps/web/src/services/ipcEngine.ts` | Per-cell mutation epochs; stale background fills dropped on landing. |
| `apps/web/src/App.tsx` | commitCell async capture on async hosts + chip settle fix; async handleUndo/handleRedo; D3 gates in `handleDownloadEncrypted`, `handleDownload`, `handleLibrarySave`, `onOpenEmail`; `file.saveEncrypted` command `enabled()`. |
| `apps/web/src/ribbon/Ribbon.tsx` | D3: Save encrypted / Download as PDF / Email items gated on `desktopLoading`. |
| `apps/web/src/ribbon/RibbonSaveGating.test.tsx` | NEW — D3 regression tests (real Ribbon, File tab, loading vs loaded). |
| `hidden_files/pw2/w8-undo-gating.mjs` | Browser validation harness (not product code). |
