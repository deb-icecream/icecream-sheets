# ITEMS I, J, K — Selection-model defect fixes (fix worker trail)

Status: COMPLETE (2026-10-22 ~07:30 UTC / 2026-10-21 23:30 PDT) — all three items fixed + tested. Full apps/web suite: 145 files / 1816 tests green. tsc clean. Browser probe 14/14 vs fresh local dist.

Source of truth: `../selection-model/validation/VALIDATION-REPORT.md` §DEFECTS FOUND
(D-SEL-1 → item I, D-SEL-2 → item J, D-SEL-3 → item K).
Probes: `../selection-model/validation/` dbg10, dbg11, dbg7, dbg8, dbg6.

## Plan

### I — Post-drag swallowed click (Grid.tsx: `dragMovedRef` ~421, consumed ~781)
- Diagnose exact lifecycle of `dragMovedRef` (enterCellDrag set, handleCellClick consume).
- Fix options: (a) clear the flag when the drag ends (mouse-up of the drag sequence /
  container click trailing a drag), (b) only arm/swallow when the trailing click's
  target is part of the drag. Target: trailing container click after drag must NOT
  swallow the next genuine cell click; click-inside-range collapses on that click.
- Regression test: replicate dbg10 harness — drag (1,1)→(3,3), then genuine
  mousedown/mouseup/click on a cell → assert selection collapses; shift+click after a
  drag extends from the correct anchor (the clicked cell, not the stale anchor).

### J — Header context menu destroys selection + stale closures
- Grid.tsx ~1063 row-header onContextMenu, ~974 column-header onContextMenu:
  change `emitSel(cellSelection(r,0))`/`emitSel(cellSelection(0,c))` to Excel semantics:
  if the right-clicked header index is INSIDE the current selection (same-kind
  selection covering it), leave the selection alone; only re-point when clicked
  outside the current selection.
- Stale closures: App's `getRowMenu`/`getColumnMenu` build menu items synchronously at
  contextmenu time. Fix: menu action handlers must read the CURRENT selection at action
  time (e.g. via a live getter / ref), not capture it during build. (Need to check how
  App stores selection — selectionCells / a ref / store — and route menu handlers
  through it.)
- Regression tests: (1) row selected → right-click header inside selection → Escape →
  coverage still full row; (2) header-menu Copy right after right-clicking a
  non-preselected row → clipboard TSV == that row (dbg7 repro, now fixed); plus
  right-click OUTSIDE current selection still re-points.

### K — Bind Ctrl+C/X/V through the data-model paths
- Find the data-model copy/cut/paste path used by context menus (App-level handlers).
- Bind chords in the global key handler (App.tsx 8095–8147) or Grid keydown, using the
  same handlers; ensure cells being edited (input/textarea focus) keep native behavior
  where appropriate — check how other chords gate on editing state.
- Regression tests per shape: cell, range, row(s), column(s), select-all → chord
  triggers copy with TSV == context-menu Copy TSV (engine read-back / stubbed
  clipboard compare, following dbg6 approach).

## Checkpoints
- [x] I planned (23:45 PDT) — consume dragMovedRef on scroll-container trailing click; keep handleCellClick swallow for drag-back-to-origin. Implementing.
- [x] I fixed (Grid.tsx: container onClick clears dragMovedRef; handleCellClick swallow kept for drag-back-to-origin) — tsc clean
- [x] I tested — new jsdom suite apps/web/src/components/GridSelectionDefects.test.tsx: 8/8 pass with fixes; surgical negative control (fixes neutralized ONLY) → exactly the 5 fix-covering tests fail, 3 behavior-preserving pass. features/selection.test.ts 22/22 still green.
- [x] J fixed — Grid: headerCtxKeepsSelection (re-point only outside same-kind/all); App: selRef/gridSelRef mirrors + 16 menu-reachable handlers routed through refs — tsc clean
- [x] J tested (Grid half) — same suite, 5 J tests (inside-keeps ×2, outside-repoints ×2 [now asserting whole-row/whole-col re-point], select-all ×1); negative control verified.
- [x] K fixed — Ctrl/Cmd+C/X/V (+Shift+V) in App global onKey via handleCopy/Cut/Paste/Values; !inInput gate; cut/paste !readOnly; effect deps updated — tsc clean
- [x] J-App-half + K tested — browser probe 14/14 vs fresh local dist (playwright-core + stubbed clipboard, dbg6/dbg7/dbg11 methodology): J1 (menu open keeps row: 22==22), J2 (menu Copy writes right-clicked row TSV, not A1), J3 (menu Clear hits right-clicked row), J4 (menu Delete Rows targets right-clicked row — proven via forced refresh), K cell/range/row/col/all chord TSVs (range+all vs expected block; cell/row/col also === menu Copy TSV), K cut (write+clear), K paste, K shift+V (values), K inInput gate (no write while editing), I-live (drag→click collapses to 1 cell).

## Evidence (to fill)
- I: jsdom suite apps/web/src/components/GridSelectionDefects.test.tsx (3 tests) + live probe check "I live drag->click collapses the range to one cell" PASS (coverage=1). Negative control: fixes neutralized → exactly the 2 I-tests fail.
- J: jsdom suite (5 tests) + probe J1/J2/J3/J4 all PASS. Negative control verified for the Grid condition. App: selRef/gridSelRef + 16 handlers ref-routed; J2/J3/J4 prove action-time reads.
- K: probe 8 checks PASS (5 shapes + cut + paste + paste-values + inInput gate). Chords route through handleCopy/handleCut/handlePaste/handlePasteValues (data-model: selectionTsv reads engine via host.getView().readCell; paste via commitCell; never DOM).

## New defects found (out of scope, reported not fixed)
- D-NEW-1 (structural ops don't refresh the grid in local/in-process mode): EngineHost.execute() emits cellsChanged for setCell etc. but NOT for insertRows/deleteRows/insertCols/deleteCols (packages/engine/src/protocol.ts:814-827, no emit). Proof: header-menu "Delete Rows"/"Insert row above" in local dist run the op (undo enables, undo capture written) but the grid shows stale cells until the next edit forces a refresh. Tour B5 passed because it ran in gateway mode. Needs its own item: emit cellsChanged (or bump tick in runSheetOp).
- D-NEW-2 (build breakage, mcp-firestore worker's in-flight code): packages/service/dist/firestoreMetadata.js imports node:crypto, which vite cannot bundle for the browser — `npm run build` in apps/web FAILS at the vite step (tsc clean). For the probe build only, I temporarily removed the firestore re-export from service/dist (untracked-by-me files) and restored all three files byte-identical afterwards (md5-verified: 0cdfc10ae6b41c0968decc10acca4ee4). The mcp-firestore worker must gate that module out of the browser bundle.

## Evidence (to fill)
- I:
- J:
- K:

## D-NEW-1 — structural ops emit no cellsChanged in local mode (fix worker 286d2140)

Status: COMPLETE (2026-10-22 ~07:50 UTC) — fixed + tested.

Defect restated: `EngineHost.execute()`'s structural case (`insertRows/deleteRows/insertCols/deleteCols`,
packages/engine/src/protocol.ts:814-827) runs the workbook op and returns `{ ok: true }` but never emits any
event — the workbook's `onValuesChanged` only fires for value changes, and HyperFormula's add/remove
rows/cols bypass it. In local/in-process mode (`new EngineHost()`; `apps/web/src/engine.ts`) the App repaints
only on `host.subscribe` events, so header-menu insert/delete shifts cells but the grid stays stale until the
next edit. Undo works (undo capture written, revision bumped), values are correct on forced re-read.

Fix (design authority: engine protocol owns the invariant — `EngineEvent`/`cellsChanged` is its contract,
`EngineHost.execute()` is the op path):
- Layer decision (design authority): the ENGINE PROTOCOL owns the invariant. `EngineHost.execute()` is the op
  path; `EngineEvent`/`cellsChanged` is its notification contract (protocol.ts:101). Fixing there covers
  web-local, desktop main-process host, and executeAsync (delegates to execute). NOT the web `runSheetOp`
  wrapper (view-layer tick-bump would paper over consumers like ipcEngine's per-ref cache invalidation, which
  needs correct refs). Gateway path untouched: `RemoteEngineHost` overrides `execute()` wholesale, so base-class
  change cannot reach it (verified: remoteEngine.ts:1262).
- Fix: in the structural case, capture used range before/after, run the workbook op, then emit
  `cellsChanged` with refs covering the shifted region (row ops: rows [at, usedEnd] × used col span;
  col ops: cols [at, usedEnd] × used row span), pre-op + post-op so delete ops also invalidate the removed
  rows/cols' stale cache entries. Unconditional emit on success (even empty refs) — the event is the repaint
  signal; setCell/recalc paths already emit unbounded ref arrays (workbook.ts:723, 2196), so no new perf class.
- Regression test (new): engine-level vitest asserting `host.execute({cmd:'insertRows'...})` (and the other
  three ops) emits exactly one `cellsChanged` whose refs cover the shifted range, and that read-back shows the
  shift. Then: full engine suite green + re-run apps/web GridSelectionDefects.test.tsx (8/8 baseline).
- Scope guards: no op-semantics change (same workbook calls, same authz, same return shape); no gateway,
  App.tsx, MCP, or residual-(p) changes; no git push; progress.md untouched.

Checkpoints:
- [x] planned (this section)
- [x] fix landed in protocol.ts — structural case now emits cellsChanged over the shifted region (pre-+post-op used ranges); tsc clean
- [x] engine regression test written + passing (5/5)
- [x] engine suite green (57 files / 1206 tests)
- [x] GridSelectionDefects.test.tsx 8/8 re-run, no regression
- [x] verdict + evidence recorded below

## Evidence
- D-NEW-1:
  - Fix: packages/engine/src/protocol.ts — structural case in `executeInner` captures used range before the
    workbook op, runs it (unchanged semantics/authz/return shape), then emits `cellsChanged` with refs from new
    private `structuralShiftRefs()` (row ops: rows [at, usedEnd] × used col span; col ops: cols [at, usedEnd] ×
    used row span; pre-op + post-op ranges so delete ops also cover removed cells' stale cache entries). Empty
    sheet → refs [] but the event still fires (the repaint signal). `executeAsync` inherits it (delegates to
    `execute`); desktop main-process host inherits it (base class; renderer's `IpcEngineHost` only adds
    optimistic overlays for setCell/setFormula, no double-emit); gateway path provably untouched —
    `RemoteEngineHost` overrides `execute()` wholesale (apps/web/src/services/remoteEngine.ts:1262).
  - Regression test: packages/engine/tests/structural-events.test.ts — 5 tests, all pass: each of the 4 ops
    emits exactly one `cellsChanged` covering the shifted range AND read-back proves the shift (e.g. insertRows
    at 1: A3→A4, A2 blank; deleteRows at 1: A3→A2); empty-sheet op still emits (refs []).
  - Engine suite: `npx vitest run` in packages/engine — 57 files / 1206 tests, all pass (07:39–07:42 UTC).
  - No-regression: apps/web `src/components/GridSelectionDefects.test.tsx` — 8/8 pass (baseline preserved).
  - tsc: `npx tsc --noEmit -p packages/engine/tsconfig.json` clean.
  - Scope guards honored: no git push, progress.md untouched, no App.tsx/MCP/residual-(p)/gateway changes.
  - Side note: repo has heavy uncommitted churn from parallel workers (HEAD stale); my diff is the two protocol.ts
    hunks + the new test file only, verified by grep of my markers.
