# Selection Model — VALIDATION REPORT

Validator: selection-model validation coordinator (browser proof tours, isolated stacks).
Build under test: worker dd0c466d's selection-model build (`hidden_files/selection-model/build-report.md`).
Date: 2026-10-21/22 PDT. **No product code was changed by validation. No git push. progress.md untouched.**

Isolation: own stack (gateway :8400, engine :8401, web :4473 gateway-mode dist, web :4474
plain local-mode dist), own data dir, own dist builds under
`hidden_files/selection-model/validation/runtime/` — the shared `apps/web/dist` was never
rebuilt or touched, and no other coordinator's ports were used. Both dists were built from
source and the gateway dist passed `scripts/verify-dist.mjs` before the documented
`localhost:8100`→`localhost:8400` rewrite.

Raw result files contain superseded harness iterations (anchor-counting and line-count
expectation errors in early tour scripts). Verdicts below are the ADJUDICATED ones; every
adjudication names the follow-up probe that settled it.

---

## TOUR A (local mode) — VERDICT: PASS, with defects D-SEL-1/2/3 (below)

### A1. Selection shapes — ALL PASS
Evidence: `tour-a-results.json`, `tour-a2-results.json`, `shots/a1-shape-*.png` (10).

| Shape | Verdict | Note |
|---|---|---|
| Single cell | PASS | |
| Range by drag | PASS | Raw check "failed" on counting: the drag ANCHOR renders `.selected`, the rest `.in-selection`; the union is the exact 3×3. Anchor-aware recount = exact. |
| Range by click + Shift+click | PASS | Proven in clean state by probe dbg13 (click (2,2) → shift+click (4,4) = exact 3×3). Doing shift+click immediately after a drag is polluted by D-SEL-1 (stale anchor) — see defects. |
| Row via row-number header | PASS | 21 in-selection cells |
| Column via column-letter header | PASS | 33 in-selection cells |
| Multi-row (header drag 2–4) | PASS | |
| Multi-row ctrl+click (2,5,7) | PASS | Gap rows absent from the selection |
| Multi-column (header drag B–D) | PASS | |
| Multi-column ctrl+click (B,E) | PASS | Gap columns absent |
| Select-all via Ctrl+A | PASS | Coverage 748/748 rendered cells, corner header `.active` (raw 747/748 = the same anchor-counting artifact) |

### A2. Lock badge (design doc workbook-protection-and-encryption.md §2) — 6/6 PASS
Fixture `lock-fixture.xlsx` (sheet protection ON; B2/C3/D4 unlocked, everything else locked;
verified in the package XML). Evidence: `tour-a2-results.json`, `shots/a2-badge-*.png` (6).
Exact DOM marker sets (`.cell-locked-marker`):

- Baseline (unlocked B2 selected): **0** markers.
- (a) Cell A1 selected → exactly `[cell-0-0]`.
- (b) Range A1:B2 → `[cell-0-0, cell-0-1, cell-1-0]` — unlocked B2 correctly absent.
- (c) Row 3 → 21 markers = every rendered row-2 cell except unlocked C3.
- (d) Column C → 33 markers = every rendered col-2 cell except unlocked C3.
- (e) Select-all → 745 markers = 748 rendered − 3 unlocked.

Screenshots (c) and (e) self-inspected: badges confined to the selected row; select-all shows
badges everywhere except the 3 unlocked cells; status bar shows "🔒 Protected". The §2 ruling
(badge ONLY within the current selection; unselected areas none) holds for all five shapes.
The aria "(locked)" announcement remains ungated, per the ruling (Grid.tsx:1164).

### A3. Copy + delete PER SHAPE — PASS (with D-SEL-3 for keyboard chords)
Delete (local mode, DOM + formula-bar proof; `shots/a3-delete-*.png`): single cell B13
(formula bar `=Z6+1` → empty), range D2:D3 (sum 150→136), row 4 (→126), column C (all
amounts → 0), select-all (no cell text remains) — **5/5 PASS**.

Copy/paste (via context menus / command palette with a recording clipboard stub;
`tour-a3-results.json`, `shots/a3-copy-*.png`, cross-checked by probe dbg12): the app copies
ONLY via `navigator.clipboard.writeText(selectionTsv())` (App.tsx:3158/3167). Range B2:C3 →
TSV exactly `3\t2\n4\t2`, paste lands correctly; row copy carries the FORMULA TEXT
(`=B2*C2` travels in the TSV and re-parses as a formula on paste — by design, cellEditText);
column copy carries `=Z6+1`; select-all copy = exactly 13 lines × 27 cells with correct
formula entries. Content assertions all matched. The two raw "FAIL" lines in tour-a3 were
the harness's own line-count expectations (20 vs 13) after an earlier paste extended the
used range — NOT product failures. **Keyboard Ctrl+C / Ctrl+X / Ctrl+V do not exist — D-SEL-3.**

---

## TOUR B (gateway mode, server-side read-back) — VERDICT: PASS

Read-back: `POST {engineUrl}/read {kind:'cell'}` against the live server session for every
assertion. Evidence: `tour-b-run8.log` (B4), `tour-b-results-B5.*.json` + `tour-b-B5.*.log`
(per case), `shots/b4-*.png`, `shots/b5-*.png`.

### B4. Delete = CONTENT CLEAR on a row selection — 8/8 PASS (tour-b-run8.log)
Fixture `tourb.xlsx` (row 6 carries off-screen Z6=777 and AA6 `=B6*10`; B13 `=Z6+1`;
D13 `=SUM(D2:D11)`).

- before-state exact on the server.
- **Selection is view-only** (brief Addendum): POSTs during row selection were
  `/presence` + `/session-extras` only — zero op traffic.
- After Delete, server read-back: row 6 A..F all empty; **Z6 and AA6 empty — the OFF-SCREEN
  cells (cols 25/26, far outside the virtualized window) were cleared too**; dependents
  recalculated (B13 = 1 with formula `=Z6+1` kept; D13 = 136); structure untouched
  (A5/A7/D7 unchanged, no row shift).
- **Exactly ONE Ctrl+Z restored the whole row** (Z6=777, D6 {14, `=B6*C6`}, AA6 {70,
  `=B6*10`}, B13=778, D13=150).
- Screenshots self-inspected: cleared row empty, neighbours unshifted, B13=1 / D13=136 in
  the grid, "Saving…" visible in the status bar.

Non-reproduced anomaly (flagged, not counted): in one earlier run (tour-b-run5.log,
browser-upload session on the pre-rebuild /tmp stack), the single undo restored visible
cells but the Z6 poll timed out with AA6 unrestored. The identical assertion set passed
cleanly in run 8 and the underlying clear was correct in both runs. Recommend the Phase 2
coordinator keep an eye on undo-of-batch-clear under load; I could not reproduce it.

### B5. Context-menu inserts, all four + multi-span — ALL PASS
Each case: fresh isolated stack, browser session, formula reference read back on the server
after the insert (`shots/b5-menu-row.png`, `b5-menu-col.png`, `b5-*-after.png`,
`b5-multi-*.png` — the row-header menu screenshot was self-inspected: it shows
"Insert row above" / "Insert row below" / "Delete Rows" / "Clear Contents").

- **Insert row above** (row 2 header menu): P2 empty; P3=5; P4 {10, `=P3*2`} — formula
  `=P2*2` shifted to `=P3*2`. PASS
- **Insert row below** (row 11 header menu): P11 empty; P12 {201, `=P13+1`} — `=P12+1`
  shifted to `=P13+1`; P13=200. PASS
- **Insert column left** (column S header menu): R1 empty; S1=7; T1 {21, `=S1*3`} —
  `=R1*3` shifted to `=S1*3`. PASS
- **Insert column right** (column S header menu): R5=50 untouched; S5 empty; T5 {42,
  `=U5+2`} — `=T5+2` shifted to `=U5+2`; U5=40. PASS
- **Multi-row span**: rows 2–4 drag-selected, right-click inside → "Insert row above"
  inserted exactly **3** rows (A2/A3/A4 empty; Item2 lands at row 5 with D5 {6, `=B5*C5`};
  Item3/Item4 follow). Excel span semantics confirmed. PASS

### B6. Build report's existed-vs-built claims — CONFIRMED against the code
- Clear: BEFORE = single-anchor-cell only (Grid keydown → `onCommit('')`; ribbon
  handleClear → `commitCell('')`). NOW = `handleClearSelection` (App.tsx:2534): gates on
  loaded/connected, `selectionCells()`, protection filter via `protection.isCellEditable`,
  ONE `UndoManager.capture` (label 'clear-selection', cap 5,000), per-cell
  `host.execute({cmd:'setCell', value: null})`, one dirty bump. `handleClear` aliases it
  (App.tsx:2576-2578). Grid Delete routes to it for non-single-cell selections; single-cell
  keyboard Delete keeps the legacy path (unit-pinned) — and Tour A proved the legacy path
  also fully removes a formula (formula bar emptied).
- Inserts: all four engine-level handlers pre-existed (`handleInsertRow/Below`,
  `handleInsertCol/Right` via runSheetOp + sheetOps insertRows/insertCols +
  shiftNamesForStructure), and the CELL context menu already had all four entries
  (App.tsx:5631-5634). The ribbon still receives ONLY above/left (App.tsx:8579/8581) — as
  the build report says. BUILT by this build: header menus offer "Insert row above/below"
  (App.tsx:5719-5720 → `handleInsertRowsMenu`, App.tsx:2657) and "Insert column left/right"
  (App.tsx:5695-5696 → `handleInsertColsMenu`), using pure `insertTarget(sel, kind,
  clickedIndex, side)` (features/selection.ts:338): same-kind selection containing the
  clicked header → count = total spanned indices, at = min (above/left) or max+1
  (below/right); else {clicked(+1), 1}. Every build-report claim checked was accurate.

---

## DEFECTS FOUND (reported precisely; NOT silently fixed)

### D-SEL-1 — Post-drag swallowed click (moderate UX; introduced by this build's drag)
`dragMovedRef` (Grid.tsx ~421) is set by enterCellDrag and consumed ONLY in handleCellClick
(Grid.tsx:781). A completed range drag's trailing click lands on the COMMON ANCESTOR of the
press/release cells (different cells → the click target is the container, never a cell), so
the flag survives the drag and silently swallows the user's NEXT genuine click. Proven by
probe dbg10: after a (1,1)→(3,3) drag, a full mousedown/mouseup/click on cell-2-2 produced
NO selection change; a synthetic `.click()` collapsed correctly. Consequences: clicking
inside a range does not collapse it to one cell (Excel collapses on mouse-up) — this is the
raw FAIL `A1.click-inside-range-collapses` in tour-a2-results.json — and a shift+click right
after a drag extends from the STALE anchor. Harness workaround used throughout: one burn
click after drags.

### D-SEL-2 — Header context menu destroys the selection; menu actions use stale closures
Row-header onContextMenu (Grid.tsx ~1063) does `emitSel(cellSelection(r, 0))`; column-header
onContextMenu (Grid.tsx ~974) does `emitSel(cellSelection(0, c))` — merely OPENING (even
cancelling) a header menu collapses any existing selection to a single cell. Proven by probe
dbg11: row 3 selected (22 cells covered) → right-click header → Escape → coverage =
`[cell-2-0]` only. Compounding: App builds menu items synchronously during the contextmenu
event (openCtxMenu ← getRowMenu/getColumnMenu), so item closures capture the PRE-menu
selection state — header-menu Copy was proven (dbg7) to write the PREVIOUS selection's
content ("Item" = A1) instead of the right-clicked row; with the row pre-selected by
left-click first, Copy writes the correct row TSV (dbg8). Selection-dependent header-menu
actions (Copy/Cut/Paste/Clear Contents) therefore act on the WRONG selection when the
right-click itself changes it. Inserts are shielded (insertTarget's clicked-index fallback
+ pre-made selections), which is why B5 passed despite this defect.

### D-SEL-3 — Ctrl+C / Ctrl+X / Ctrl+V chords are not bound (pre-existing gap)
Exhaustive grep of apps/web/src finds NO keydown binding for c/x/v chords and no
copy/paste event handlers: App.tsx global onKey (8095–8147) binds only z/y/f/p/'/'/s;
Grid.tsx handleKeyDown (802–862) binds Ctrl+A, arrows, shift+arrows, F2, Delete/Backspace,
typing-to-edit. Yet context menus title items "Copy (Ctrl+C)" / "Paste (Ctrl+V)" and the
command registry (App.tsx:8185) lists shortcut 'Ctrl+C' — its comment claims the labels
"describe chords actually bound in the global key handler or the grid", which is false for
c/x/v. Proven live (dbg6): with a stubbed clipboard, Ctrl+C after selecting B2:C3 produced
ZERO writeText calls. Copy/paste DO work via context menus, ribbon buttons, and the command
palette (Alt+/). The selection build did not touch these handlers, but "copy proven per
shape" cannot include the keyboard because the keyboard path does not exist.

### Observation (not a defect)
A single mousedown+mouseup on the already-selected anchor cell opens the cell editor
(pre-existing click-to-edit; probe dbg4). While editing, the badge marker is replaced by
the editor and returns on Escape (dbg3).

### Environment / out-of-scope anomaly (for the Phase 2 coordinator, NOT this build)
Browser deep-link joins (`#file=<id>`) of API-created sessions intermittently render an
EMPTY grid (748 cells, sheet tab correct, "✓ Saved") while API read-back of the same
session returns the full data (proven repeatedly; evidence `gw-join-fail.json`,
`shots/gw-join-fail.png`, `shots/dbg17-join-empty.png`). The same session could render
correctly on a later join. The gateway also intermittently answers a first
`/api/engine/open` with 409 "engine already owns a different file" on a single-engine
stack until the prior session is released (`POST {engine}/session/release` between
sessions is required harness hygiene). Tour B therefore used API sessions where they
worked (B4) and browser-upload sessions (owner-connected from birth) for B5. This is
session join/stream territory — Phase 2's — and is flagged here only because it shaped
the harness. Separately, the validation VM restarted at least twice mid-tour, wiping
/tmp; all durable assets were moved under this validation directory (runtime/) and no
evidence was lost.

---

## NOT RUN
- **Packaged-desktop spot-check** (lock badge / selection in the Electron app): not part of
  this tasking (Tour A/B are web-only as briefed); the grid code is shared, but no desktop
  evidence is claimed.
- **Keyboard copy/cut/paste per shape**: impossible — the chords do not exist (D-SEL-3).
  Copy/paste per shape WAS proven via context menus + command palette.
- Nothing else in the tasking is outstanding: items 1–6 all have screenshot + read-back
  (Tour B) or screenshot + DOM/formula-bar (Tour A) evidence.

## Evidence index
All under `hidden_files/selection-model/validation/`:
- Results: `tour-a-results.json`, `tour-a2-results.json`, `tour-a3-results.json`,
  `tour-b-run8.log` (B4), `tour-b-results-B5.row-above.json`, `tour-b-results-B5.row-below.json`,
  `tour-b-results-B5.col-left.json`, `tour-b-results-B5.col-right.json`,
  `tour-b-results-B5.multi.json` (+ matching `tour-b-B5.*.log`).
- Screenshots: `shots/a1-shape-*.png` (10), `shots/a2-badge-*.png` (6),
  `shots/a3-*.png` (11), `shots/b4-*.png` (3), `shots/b5-*.png` (9).
- Anomaly evidence: `gw-join-fail.json`, `gw-open-fail.json`, `shots/gw-join-fail.png`,
  `shots/dbg17-join-empty.png`, `tour-b-run5.log` (undo non-reproduction).
- Harness: `tour-a.mjs`, `tour-a2.mjs`, `tour-a3.mjs`, `tour-b.mjs`, `undo-repro.mjs`,
  `run-case.sh`, `start_stack.py`, `lib.mjs`, fixtures `lock-fixture.xlsx`, `tourb.xlsx`
  (built by `make_fixtures.py`, XML-verified).

The isolated stack is left STOPPED (killed via its pidfiles after the final case).
