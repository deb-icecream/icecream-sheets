# Cycle 10 Closure — W12: Desktop Renderer Display Defects E2 + E3

Date: 2026-10-20 (fix worker run). Scope: the two revalidation failures
from `w10-revalidation-results.md` — escalation 2 / R1b-1 (saved formats
don't render on desktop relaunch) and escalation 3 / R2 formula leg
(grid display never refreshes after a formula→formula edit). Both
root-caused, fixed, and covered by new host-level regression tests.
No repackage (packaged revalidation is a later worker's job), no git
push, `perf-evaluation.md` / `progress.md` / `TODO.md` untouched.

---

## DEFECT E2 — saved formats don't render on desktop relaunch

### Verdict on the suspect path: styles were SENT and APPLIED — then OVERWRITTEN by a later step in the same update batch.

### Trace of the real (packaged) open path

1. OS argv open → `apps/desktop/src/main.ts` `openPathFromOs()` reads the
   file and sends `icecream:open-path` (queued until renderer-ready) →
   preload → App.tsx listener (~line 6502) → `openXlsxBuffer(bytes, path)`
   → `isDesktop()` → `openDesktopBuffer(buffer, filename)`.
   (File ▸ Open and library opens funnel through the same
   `openXlsxBuffer` → `openDesktopBuffer`.)
2. `openDesktopBuffer` → `IpcEngineHost.loadIpc()` (`apps/web/src/services/ipcEngine.ts`)
   → preload bridge `engine:load` → `apps/desktop/src/engine-ipc.ts`
   handler → `buildWorkbookFromBytes()` (`apps/desktop/src/engine-load.ts`)
   → adapter parse + main-process `EngineWorkbook` build + `swapWorkbook`.
3. The IPC summary is built by `summarizeSheet` (`engine-load.ts:231`):
   it DOES carry `formats` (`{...sheet.formats}`) and full `styles`
   (`{...sheet.styles}`, the W9 D4 fix) — plain records, structured-clone
   safe across `ipcRenderer.invoke`. **This leg was never broken** (and
   is now pinned for the exact W10 file shape — see tests).
4. Renderer reconstruction (App.tsx `openDesktopBuffer`): summaries →
   `WorkbookData` (rows `[]`, formats/styles carried) →
   `hydrateOpenedWorkbook(data, {skipEngineSide: true})` →
   `setFormats(importedFormatsToStore(data))` (App.tsx:5072) — the seed
   was computed correctly.
5. Grid render reads the store per cell (`Grid.tsx` `cellDisplay`:
   `getFormat(formats, …)` → `formatToCSS` bold → `fontWeight:'700'`;
   `formatCode` → `formatWithCode(value, '0.00%')` → `"0.00%"`).
   This leg was never broken either.

### Root cause (file:line)

`apps/web/src/App.tsx`, `openDesktopBuffer` (pre-fix ~line 5417): the
calls ran in the order

```
hydrateOpenedWorkbook(data, …);   // setFormats(importedFormatsToStore(data))
notifyHostReplaced();             // ← wipes it
```

`notifyHostReplaced()` fires the App's host-replaced handler
(App.tsx:1336–1353), which resets per-workbook UI state — including
`setFormats(createFormatStore())` (App.tsx:1352). Both setters are
plain-value `setState` calls in the same synchronous sequence, so the
reset landed LAST and the seeded store was discarded before paint.
Result: fw 400 / plain "0" for MONTHLY C10, exactly as W10 measured,
with reads stable across polls (not a race — a deterministic wipe).

Why only desktop: the gateway open (App.tsx:5537) and the chunk
hydration (5512) call `notifyHostReplaced()` BEFORE
`hydrateOpenedWorkbook(...)`, and the local open notifies inside
`replaceWiredHost()` before hydrating. The desktop path was the only
one with the order reversed — consistent with R7 (gateway) passing and
R1b (desktop) failing on the same build.

### Fix

- `apps/web/src/App.tsx` (`openDesktopBuffer`): swapped to
  `notifyHostReplaced()` (line 5413) **before**
  `hydrateOpenedWorkbook(...)`, with a comment marking the order as
  load-bearing. No change to the handler itself — its reset is still
  what clears a previous workbook's formats on New/host replacement.
- `apps/web/src/features/localMirror.ts:65`: the inline WorkbookData
  reconstruction was extracted verbatim into the exported
  `workbookDataFromDesktopLoadResult(result)` (sibling of the gateway
  path's existing `workbookDataFromLoadResult` in the same module), so
  the summary → hydration-data leg is unit-testable. App.tsx:5399 now
  calls it. No behavior change in the reconstruction itself.
- No main-process change: `summarizeSheet` already sent formats+styles.

### What the packaged revalidation still has to confirm

The asar runs the desktop-flavor web bundle built from `apps/web`
(App.tsx + localMirror.ts are renderer-bundle code; no desktop main
change is involved) — it must be rebuilt/repackaged by the
revalidation worker. On the repackaged app: relaunch on the R1a
autosaved P50 file and confirm MONTHLY C10 renders fw 700 / "0.00%"
(C10 = `=ROUND(SUM(C9:N9)-1,4)` = 0). Everything up to the bundle
boundary is proven by the tests below.

---

## DEFECT E3 — grid display never refreshes after a formula→formula edit

### Proof (focused repro at the IpcEngineHost level, before the fix)

A repro driving the real `IpcEngineHost` over a bridge backed by a
**real `EngineHost`** (the packaged main process's exact event
behavior) reproduced W10's numbers precisely: prime C13
(`=C9*1595314.6`, C9 = 0.08333…) → view 132942.8833…; execute
`setFormula` `=C9*100` → engine truth 8.3333…; after reads + fill
cycle the renderer view **still returned 132942.8833…**. (The repro is
preserved as the first regression test below.)

### Root cause (file:line) — W10's suspect confirmed in effect, with the precise mechanism one step upstream of the guard

1. `setFormula` optimistic overlay stores the **old** cached value:
   `apps/web/src/services/ipcEngine.ts` `setOptimistic()` — by design
   ("value pending, not stale-final"), the edited cell displays its
   pre-edit value until the engine's confirmed value arrives.
2. The overlay was cleared **only** by a `recalcComplete` event
   (`onEngineEvent`, pre-fix) or by edit failure. But the real
   main-process host emits **cellsChanged only** for an ordinary
   setCell/setFormula execute — `packages/engine/src/protocol.ts`
   `executeInner` emits `recalcComplete` only for explicit
   `recalculate`/`recalculateParallel` and `replaceWorkbook`; the
   desktop dispatch (`engine-ipc.ts` `dispatchDesktopEdit`) adds one
   only on the parallel follow-up route. So for a normal edit **no
   recalcComplete ever arrives and the overlay never clears**.
3. While the overlay exists, `readCell`/`readRange` serve it and queue
   **no fill** — so the display is pinned indefinitely (survives
   scroll and sheet round-trips, as W10 observed). Literal edits mask
   the bug (their overlay value IS the new value); dependents update
   (no overlay; their cellsChanged invalidation + refill works).
4. Compounding (W10's guard suspicion, confirmed as a second hole):
   a fill queued before the mutation is correctly **dropped** by the
   per-cell mutation-epoch guard on landing — but nothing re-issued
   it. For a one-cell range fill, the drop produced no event and no
   refetch: even with the overlay gone, that cell could stay unloaded.

Note why W8's D2 suite stayed green throughout: its stateful mock
bridge emits `cellsChanged` **+ `recalcComplete`** after every edit
(`undoAsync.test.ts` — commented "like the real one", but the real
`EngineHost` does not do this for setCell/setFormula), so the overlay
always cleared there.

### Fix (`apps/web/src/services/ipcEngine.ts` only)

1. **cellsChanged is the confirmation** — `onEngineEvent` (line ~812):
   a bridge `cellsChanged` naming a cell now also drops that cell's
   optimistic entry (`this.optimistic.delete(k)`), alongside the
   existing cache/formula invalidation and epoch bump. Justification:
   the main host emits the event from inside the mutation itself
   (`EngineWorkbook.onValuesChanged` fires synchronously within
   `execute`), so when the event crosses IPC the engine already holds
   the new value. Clearing happens before `emitLocal`, so the repaint
   the event triggers reads a cache miss and queues the post-edit
   fill. `recalcComplete` still clears overlays wholesale (unchanged).
2. **Stale drops re-issue** — new `requeueCellAfter()` (line 487):
   when the epoch guard drops a cell fill (queueCellFetch, line ~520)
   or drops cells from a range fill (queueRangeFetch, line ~574), a
   fresh single-cell fill is queued once the stale promise settles
   (unless the cell has since loaded or an optimistic edit owns it).
   The stale payload is still never written to the cache — **the W8
   root-cause-3 protection is unchanged**; only the terminal silence
   after a drop is removed. The re-issued fill captures the current
   epoch, so it lands unless another mutation intervenes.
3. Header/`onEngineEvent` comments updated to state the confirmation
   semantics (overlay clears on cellsChanged-confirmation or
   recalcComplete, not "on the engine's reply").

Residual edge (unchanged, display-correct): a formula→formula edit
whose computed value is *identical* may produce no `cellsChanged` from
HyperFormula; the overlay then persists with the old value — which is
the correct display value — and the new formula text (formula bar
reads the overlay's formula). No stale *value* can result.

---

## Changes per file

| File | Change |
|---|---|
| `apps/web/src/App.tsx` | E2: `openDesktopBuffer` — `notifyHostReplaced()` moved before `hydrateOpenedWorkbook(...)` (load-bearing-order comment); inline WorkbookData build replaced by `workbookDataFromDesktopLoadResult(res)` (+ import). |
| `apps/web/src/features/localMirror.ts` | E2: new exported `workbookDataFromDesktopLoadResult()` — the desktop summary → WorkbookData reconstruction, verbatim from App.tsx. |
| `apps/web/src/services/ipcEngine.ts` | E3: cellsChanged clears the optimistic entry for named refs; `requeueCellAfter()` re-issues fills dropped by the epoch guard (cell + range paths); comments updated. |
| `apps/web/src/services/ipcEngine.test.ts` | E3: new describe block (3 tests) — real-EngineHost-backed bridge. |
| `apps/web/src/desktopOpenFormats.test.ts` | E2: new file (2 tests) — summary → store → CSS/text chain; App.tsx call-order guard. |
| `apps/desktop/tests/engine-load.test.ts` | E2: new test — W10-shaped file through the real `buildWorkbookFromBytes`. |

## Tests

New regression tests:

- `IpcEngineHost — E3: edited formula cell display refresh (W10 R2 formula leg)` (ipcEngine.test.ts):
  1. *formula→formula edit: the edited cell cached display value updates after execute + fill cycle* — real-EngineHost bridge; edit + undo-leg + redo-leg all assert the view follows the engine (8.3333… / 132942.88…), formula cache updates, overlay gone.
  2. *a stale pre-mutation cell fill is still DROPPED, and a fresh fill is re-issued (W8 guard intact)* — late fill carrying the old value 5 is never served; a second read fetches the post-edit 2.
  3. *a stale pre-mutation RANGE fill drops only the edited cell, which is then re-filled singly* — neighbour takes the range fill, edited cell re-fetched via readCell.
- `E2: desktop-open format chain (summary → render store)` + `E2: openDesktopBuffer call order` (desktopOpenFormats.test.ts):
  1. *seeded styles reach the FormatStore and render as fw 700 / "0.00%"* — real XlsxAdapter file (MONTHLY VIEW (LITE), C10 formula, bold + "0.00%") → summary shape → `workbookDataFromDesktopLoadResult` → `importedFormatsToStore` → `getFormat` bold + formatCode, `formatToCSS` fontWeight '700', `formatWithCode(0, …)` = "0.00%".
  2. *notifies host-replaced BEFORE hydrating…* — pins the App.tsx order that caused the defect (plus helper usage).
- `engine-load — buildWorkbookFromBytes` (apps/desktop):
  - *carries a formula cell's bold + "0.00%" in the summary (defect E2, W10 R1b shape)* — real `buildWorkbookFromBytes` on the W10-shaped file: summary `formats['9:2'] === '0.00%'`, `styles['9:2']` bold + code, and the main-process engine evaluates C10 to exactly 0.

Suite results (final source, this run):

| Suite | Result |
|---|---|
| apps/web (full) | **1,575 passed / 0 failed** (122 files; W10 baseline 1,570 — +3 ipcEngine E3, +2 desktopOpenFormats) |
| apps/desktop (full) | **100 passed / 0 failed** (14 files; W10 baseline 98 — includes the +1 new engine-load E2 test; engine-load file itself 4 → 5 tests) |
| ipcEngine suite (in web run; also run standalone) | **24 passed** (21 pre-existing incl. all W8/D2 epoch + optimistic tests, +3 new) |
| features/undoAsync (W8 D2 regression) | **5 passed** |
| typecheck | `tsc --noEmit` clean in apps/web and apps/desktop |

## Remaining for the packaged revalidation worker

- Repackage (desktop-flavor web build picks up the App.tsx/localMirror/
  ipcEngine changes) and re-run W10's R1b + R2 protocols on the real
  app: R1b relaunch must render MONTHLY C10 fw 700 / "0.00%"; R2
  formula leg (C13 := `=C9*100`) must show 8.33… in the grid through
  edit/undo/redo. Both are proven here at the IpcEngineHost / store
  level against real-engine behavior; the packaged run is the
  end-to-end confirmation, per the task split.
- Out of scope / untouched: R1b-2 defined-names loss (sibling W11,
  io.ts area — no io.ts edits made here), R5 stall.
