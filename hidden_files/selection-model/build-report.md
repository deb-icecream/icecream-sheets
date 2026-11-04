# Grid Selection Model — Build Report (2026-10-21)

Implemented in full, for real, no stubs. No git push, no `apps/web/dist`
rebuild (validation tours own the shared dist, per the brief's sequencing
constraint). Browser screenshots / desktop packaging NOT done — the
coordinator runs validation tours separately, per tasking.

## What was built, per shape

New pure module **`apps/web/src/features/selection.ts`** (no React, no
imports from Grid/App): `SelectionShape`, `SelSpan`, `GridSelection`,
`SelRect`, and the pure functions `cellSelection`, `rangeSelection`
(collapses to `cell` when anchor == focus), `allSelection`,
`selectionRects`, `inSelection`, `selectionBounds`, `isSingleCell`,
`mergeSpans`, `headerSelect`, `headerDragSpans`, plus `insertTarget`
(addendum, below).

- **Cell** — click selects one cell; anchor behavior unchanged.
- **Rectangular range** — (a) mouse drag: `onMouseDown` records the press,
  `onMouseEnter` sweeps `rangeSelection(anchor, entered)`, window `mouseup`
  clears; a drag-completed trailing click is swallowed once via
  `dragMovedRef` so it cannot start an edit. (b) Shift+click extends from
  the anchor. (c) Shift+Arrow moves the focus corner. Plain arrows keep
  the old collapse-to-cell move.
- **Row** — row-number header `mousedown` → `headerSelect(..., 'rows', …)`;
  anchor = (row, 0); header gets `row-header active` (span-aware);
  in-selection cells render `cell in-selection` + `aria-selected`.
- **Column** — column-letter header `mousedown` (ignored when the event
  target is inside the filter `<button>`) → `'cols'`; anchor = (0, col);
  `col-header active` is span-aware.
- **Select all** — Ctrl/Cmd+A on the grid container (INPUT targets keep
  the pre-existing early return, so the cell editor is unaffected), and
  clicking the top-left corner div. Shape `'all'`; corner gets `active`.
- **Multi-row / multi-column (non-contiguous)** — all three mechanisms:
  1. **Header drag** across headers sweeps a span (`headerDragSpans`).
  2. **Shift+click / shift+mousedown** on a header extends the last span
     of that kind from its start to the clicked index.
  3. **Ctrl/Cmd+click** toggles a header: adds a span when not covered,
     removes it when covered — removing a span's middle SPLITS the span;
     toggling off the last span collapses to a cell selection.
  Switching kind (rows ↔ cols) replaces the selection. Membership is
  exact and span-aware: a cell in the gap between two row spans is NOT
  in the selection (unit-tested).

## Where selection state lives; what a selection change triggers

- State: App holds `gridSel: GridSelection` next to the legacy
  `sel: Selection` (anchor, kept EXACTLY as-is). `applyGridSelection`
  sets both (`sel` = anchor) and reuses the extracted
  `announceSelection` (the same screen-reader announcement
  `handleSelectWithPainter` always made). Grid receives
  `selection` / `onSelectionChange` / `onClearSelection` as OPTIONAL
  props; without them Grid falls back to `cellSelection(sel)` +
  `onSelect(anchor)` and behaves exactly as before (existing suites pin
  this — all green, below).
- **View-only, confirmed**: a selection change is React state + re-render
  only. No `host.execute`, no `readRange`, no network, no revision/op
  traffic in any selection path (`emitSel` in Grid, `headerSelect`,
  drag handlers, Ctrl+A, `applyGridSelection`). The only host touch is
  the pre-existing anchor announcement read (`readCell` for the
  announcement text) that the legacy click path always performed.
  Presence heartbeat still advertises only the anchor cell — not
  extended to ranges.
- **Performance**: rows/cols/all are shapes + spans, never enumerated
  per-cell lists. Consumers iterate `selectionRects(...)` ∩ used range
  (bounded, capped) — never the full grid; formatting stores ONE range
  entry per rect.
- Per-sheet: selection collapses to cell (0,0) wherever the existing
  code already reset `sel` on sheet lifecycle changes (host replacement,
  add/delete/rename sheet, etc. — all 7 existing `setSel({0,0})` sites
  now mirror `setGridSel(cellSelection(0,0))`). Plain tab switches did
  not reset `sel` before and still don't; gridSel persists with it
  (acceptable v1, noted per tasking).
- Format Painter: Grid's rich-selection callback routes through
  `handleGridSelectionChange`, which honors an armed painter exactly
  like the legacy path — applies the source format at the clicked
  anchor, disarms, and collapses to the anchor cell instead of changing
  shape.

## Consumers — what copy / delete / format do per shape

All consumers intersect selection rects with the **used range (the full
data model), never the rendered/virtualized window** — a selected row
means every model cell in that row inside the used range, including
off-screen cells. Ops go through the existing edit paths only
(`commitCell` / `host.execute` + UndoManager capture).

- **Copy** (`handleCopy` → `selectionTsv`): TSV from rects ∩ used range,
  rows `'\n'`, cells `'\t'`, text via
  `cellEditText(host.getView().readCell(cellRef(...)))` (same read path
  as before). Multiple rects (multi-span rows/cols) → blocks in rect
  order separated by `'\n'`. Single cell → byte-identical to before.
- **Cut**: copy, then the clear path below.
- **Delete / Clear** (`handleClearSelection`, NEW): content clear only —
  for cell, range, rows, cols and all alike. Gates first
  (`workbookLoadedRef`, `sessionDisconnectedRef`, same messages as
  `commitCell`); per-cell `protection.isCellEditable` filter; ONE undo
  capture over the affected cells (cap 5,000, label `clear-selection`);
  each affected cell cleared via `host.execute({cmd:'setCell', value:
  null})`; stale formula-text entries dropped; `bumpUndo()` + dirty
  marking once for the batch (mirroring `commitCell`'s bookkeeping).
  Grid's Delete/Backspace routes here when `onClearSelection` exists and
  the selection is not a single cell; a single cell in Grid keeps the
  legacy `onCommit(row, col, '')` keydown path (unit-pinned).
- **Paste** (`handlePaste`): `parseTsvGrid`; 1×1 keeps the exact legacy
  `firstCellText` → `commitCell` path; larger grids write from the
  anchor via `commitCell` per cell, skipping non-editable cells, cap
  5,000 cells (truncation surfaces `setLastError`). Paste Special >
  Values unchanged.
- **Formatting** (`handleFormat`, preset applier `handleCellStyle`,
  `handleClearFormat`): single-cell selections keep the legacy
  `setFormat`/`clearFormat` cell-level path byte-for-byte; rich shapes
  call `setRangeFormat` / `clearRangeFormat` ONCE PER RECT (rows/cols/
  all cost O(spans) range entries, not per-cell). `recordAction`'s range
  now carries `selectionBounds`. Cascade precedence was verified
  (formatting.test-style unit in grid-selection.test.ts): cell-level
  entries beat range entries in `getFormat`, so the single-cell
  `setFormat` path stays visible even over a stale range entry, and
  range-applied formats resolve through `getFormat`.

## Existed vs built (addendum items 2–3) — verified against the code

### Delete
- **Before**: Grid keydown Delete/Backspace → `onCommit(row, col, '')`
  for the single anchor cell only. `handleClear` (ribbon/commands/
  context menus) → `commitCell(sel.row, sel.col, '')` — also single
  cell only. A separate `handleClearAll` existed using
  `host.execute setCell value:null` for one cell (plus format clear).
  Row/column context menus even advertised "Clear all cells in this
  column/row" but cleared only the anchor cell.
- **Now**: `handleClearSelection` (above) uses the uniform
  `host.execute setCell value:null` path for ALL shapes INCLUDING
  single cell — deliberately NOT `commitCell('')` delegation, per the
  addendum, so formula removal is guaranteed by construction (value AND
  formula gone, cell truly empty, dependents recalc through the engine;
  formats untouched; no structural deletion). `handleClear` now aliases
  `handleClearSelection`, so ribbon/context/commands all operate on the
  full selection. No existing test pinned the old
  `handleClear → commitCell('')` behavior (grep of `*.test.*` for
  handleClear/commitCell('') — none), so nothing broke silently; the
  one behavior pin that exists (Grid single-cell Delete →
  `onCommit(row,col,'')`) is preserved and green.

### Context-menu inserts
- **Before (verified, not taken on word)**: all four handlers existed —
  `handleInsertRow` (above), `handleInsertRowBelow`,
  `handleInsertCol` (left), `handleInsertColRight` — built on
  `runSheetOp` + `insertRows`/`insertCols` (features/sheetOps) +
  `shiftNamesForStructure` + `recordAction`. The CELL context menu
  already offered all four ("1 Row Above/Below", "1 Column Left/Right",
  App.tsx Insert submenu). The RIBBON receives only `onInsertRow` /
  `onInsertCol` (above/left). The ROW header menu had only
  "Insert Rows" (above, at `sel.row`, count 1) and the COLUMN header
  menu only "Insert Columns" (left) — no below/right entries, and no
  selection-aware counts anywhere.
- **Built**: row menu now offers **"Insert row above"** and **"Insert
  row below"**; column menu **"Insert column left"** and **"Insert
  column right"** (replacing the single above/left entries in those two
  header menus). They call new `handleInsertRowsMenu(clicked, side)` /
  `handleInsertColsMenu(clicked, side)` → pure helper
  **`insertTarget(sel, kind, clickedIndex, side) → {at, count}`** in
  features/selection.ts: if the selection is of the same kind and the
  clicked header is inside it, count = total spanned indices, above/
  left inserts at the selection minimum, below/right at maximum + 1;
  otherwise count 1 at the clicked index (+1 for after). Execution goes
  through the same `runSheetOp` + `insertRows`/`insertCols` +
  `shiftNamesForStructure` engine-protocol path as the ribbon handlers,
  so references shift per Excel semantics. `insertTarget` is unit-tested
  (inside/outside/wrong-kind/multi-span cases).

## Lock badge (§2) — code side complete

Grid's badge predicate is now `cellLocked && inSelection(effSel, …)`
(main body + the stale single-cell comment replaced with the real
model's description); `aria-selected` follows `inSelection` in the main
body and both frozen strips; the "(locked)" aria announcement stays
ungated. Screenshot validation of shapes (c)/(d)/(e) is the
coordinator's tour; the unit side is pinned in grid-lock-badge.test.ts
(see tests).

## Files changed

- `apps/web/src/features/selection.ts` — NEW (model + insertTarget).
- `apps/web/src/features/selection.test.ts` — NEW (22 tests).
- `apps/web/src/grid-selection.test.ts` — NEW (9 tests).
- `apps/web/src/Grid.tsx` — optional rich-selection props, `effSel` /
  `emitSel`, drag + shift-click + shift-arrow + Ctrl+A, header
  click/drag/context, corner select-all, `in-selection` rendering,
  lock-badge predicate.
- `apps/web/src/App.tsx` — `gridSel` state + `applyGridSelection` /
  `handleGridSelectionChange`, `selectionCells`, `handleClearSelection`,
  selection-aware copy/cut/paste/format, menu insert handlers/entries,
  Grid prop wiring, sel-reset mirroring.
- `apps/web/src/index.css` — `.cell.in-selection` (lighter tint via
  color-mix of `--accent-soft` with `--panel`), `.row-header.active`,
  `.corner.active`.
- `apps/web/src/grid-lock-badge.test.ts` — existing (a)/(b)/(c-aria)
  cases UNCHANGED and passing; added rows (c), cols (d), all (e) shape
  cases via the new `selection` prop.

## Test results (exact)

Mandated run — `npx vitest run src/features/selection.test.ts
src/grid-selection.test.ts src/grid-lock-badge.test.ts src/grid.test.ts
src/grid-a11y.test.ts src/grid-commit-once.test.ts`:

- **6 files passed, 54 tests passed, 0 failed** (selection 22,
  grid-selection 9, grid-lock-badge 7, grid 4, grid-a11y 8,
  grid-commit-once 4). Baseline before the change was 21 passed across
  grid/grid-a11y/grid-commit-once/grid-lock-badge(4 tests).
- Extra sanity: formatting + clipboardExt + ribbonParity suites —
  3 files, 92 tests, all passed.
- `npx tsc --noEmit`: **exit 0, zero errors** for the whole app
  (including all touched files). Mid-build there were 2 errors in
  `apps/web/src/features/functions.ts` — another coordinator's in-flight
  file, never touched here; they resolved in the tree by the final run.

## Deviations / notes

- `insertTarget` takes a 4th `side: 'before' | 'after'` parameter
  beyond the addendum's sketched 3-arg signature — above vs below
  cannot be derived without it. Behavior matches the addendum exactly.
- `headerSelect` on shift from a same-kind selection extends the LAST
  span from ITS start (per spec); repeated shift-clicks therefore
  re-anchor at that span's start.
- Frozen corner strip cells keep their previous rendering (no
  aria-selected change), per spec; frozen row/col strips got full
  in-selection treatment.
- Undo capture for the batch clear is the synchronous
  `UndoManager.capture` (the `handleClearAll`/`runSheetOp` precedent),
  not `captureAsync`; on async hosts this inherits those precedents'
  known characteristics.
- Clear-format for rich shapes IS wired (via `clearRangeFormat` per
  rect) — not left single-cell-only.
- NOT done (by design of this tasking): browser screenshot tours
  (5-shape lock-badge set, per-shape selection proof, copy/delete
  tours), desktop packaged spot-check, dist rebuild, git push. The
  coordinator's validation must still prove copy/delete on row/column/
  range against the live stack, including an op reaching off-screen
  cells via engine read-back.
