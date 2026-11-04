# Selection Tours A/B — End-to-End Re-Run Report

## Plan
- Re-run Selection Tours A and B END-TO-END against the current tree to close the
  selection-model validation row (stuck at 95% only because the original tours were
  never re-run after open-defects sweep items I/J/K were fixed).
- Sources: hidden_files/selection-model/BRIEF.md (tour definitions) +
  hidden_files/selection-model/validation/VALIDATION-REPORT.md (original results + defects).
- Build web dist ONLY via `npm run build:local-stack` + `scripts/verify-dist.mjs`.
- Isolated production-topology stack (gateway + engine, signed access mode) on the
  claimed port block below; headless Chrome via playwright-core; screenshots per tour
  leg, self-inspected.
- Coverage minimum: cell/row/column/select-all shapes; lock badge visible ONLY within
  the current selection (user ruling 2026-10-21, workbook-protection-and-encryption.md §2);
  multi-row/multi-column incl. Ctrl+click non-contiguous; rectangular range via drag
  and click+Shift+click; Delete = content clear in one undo step.
- Defects found: root-cause + fix in-scope with regression tests (related tests during
  build; full apps/web suite + tsc at the end). Do NOT touch progress.md. Do NOT push.

## Port block (isolated stack) — CLAIMED 9030-9039
- gateway: 9030
- engine: 9031
- web: 9032
- (9033-9039 reserved)

## Log
- Checkpoint created FIRST per restart-survival protocol. Reading brief + original validation report next.

## Tour A verdict: PENDING
## Tour B verdict: PENDING

## Progress — Tour A pre-fix runs (current tree, dists built 2026-10-22)
- Setup: gateway dist via `npm run build:local-stack` (verify-dist PASS) + plain local
  dist; gateway package rebuilt (tsc clean). Stack on 9030/9031/9032/9033, all health 200.
  GridSelectionDefects.test.tsx 8/8 PASS (unit level) before the tours.
- tour-a.mjs: 23/28 raw. All 5 raw FAILs = the original run's adjudicated harness
  artifacts (anchor renders .selected not .in-selection: range-drag, range-shiftclick,
  select-all 747/748; stale value-vs-formula + line-count expectations: copy-row,
  copy-col). A2 lock badges 6/6 PASS with exact marker sets. A3 deletes 5/5 PASS.
- tour-a2.mjs A1 section: ALL PASS — range-drag coverage exact 3x3;
  **A1.click-inside-range-collapses PASS (D-SEL-1 fix proven in browser; it FAILed in
  the original run)**; shift-click after drag clean (no stale anchor); select-all 748/748.
- tour-a2/a3 A3 copy sections: NEW DEFECT reproduced (below). Header-menu copies are
  correct (copy-row 27 cells incl. formula text; copy-col content exact by index —
  its line count 20 vs 13 is the known used-range-growth artifact of the preceding
  row paste at A20, adjudicated PASS on content).

## DEFECT D-SEL-4 (found by this re-run) — cell context menu collapses the selection
`handleCellContext` (apps/web/src/Grid.tsx:932) unconditionally runs
`emitSel(cellSelection(row, col))` before opening the cell context menu: right-clicking
any cell — including one inside a range or a select-all — collapses the selection to
that single cell, so the menu's Copy/Clear/Delete act on ONE cell. Evidence:
tour-a2 + tour-a3 `A3.copy-range` -> clipboard "3" (anchor B2 only, want the 2x2 TSV);
`A3.copy-all` -> 1 line (want 13). This is the cell-side remainder of D-SEL-2: the
sweep fix gave HEADER menus the keeps-selection rule (headerCtxKeepsSelection) but the
cell handler was never given it; the original tours masked it because menu closures
then captured the pre-menu selection. In the original run the same checks either
passed spuriously (stale capture) or failed on empty writes; the behavior was never
correct end-to-end. FIX (in-scope): keep the selection when the right-clicked cell
is inside it (inSelection), re-point only when outside — Excel semantics, mirroring
the header rule. Regression tests + tour re-runs to follow.

## FIX D-SEL-4 (applied + proven)
- `apps/web/src/Grid.tsx` `handleCellContext`: re-point only when the right-clicked
  cell is outside the current selection (`inSelection(effSel, row, col, MAX_ROWS-1,
  MAX_COLS-1)`), mirroring the D-SEL-2 header rule. Comment in code.
- Regression tests: 6 new cases in
  `apps/web/src/components/GridSelectionDefects.test.tsx` (D-SEL-4 describe block):
  14/14 PASS post-fix; negative control — with the fix reverted, the 4
  keeps-selection tests FAIL (the 2 re-point tests pass either way, as designed).
- Harness adaptation (documented in rerun/tour-a3.mjs): the original script's
  post-drag "burn click" removed — it existed only to consume the click D-SEL-1
  left pending; post-fix the trailing click is consumed by the container handler
  and an extra genuine click inside the range would correctly collapse it.
- Both dists rebuilt post-fix (build:local-stack + verify-dist OK; plain vite
  build), stack restarted, all ports 200.

## TOUR A VERDICT: PASS (post-fix re-runs, dists built from the fixed tree)
- tour-a.mjs: 23/28 raw; the 5 raw FAILs are exactly the original run's
  adjudicated harness artifacts (anchor `.selected` vs `.in-selection` counting
  on range-drag / range-shiftclick / select-all 747-of-748; stale value-vs-formula
  and line-count expectations on copy-row / copy-col). No product failure.
- tour-a2.mjs: A1 section ALL PASS — range-drag coverage exact 3x3,
  click-inside-range-collapses PASS (D-SEL-1 browser proof), shift-click after
  drag exact, select-all 748/748. A3: copy-range PASS (full 2x2 TSV via the cell
  menu — D-SEL-4 fix proof), paste-range PASS, paste-row/col PASS; copy-row /
  copy-col / copy-all "FAIL" only against the script's stale value/line-count
  expectations while their evidence strings show the adjudicated-correct content
  (27 cells incl. `=B2*C2`; col indices exact incl. `=Z6+1` at [12]; copy-all
  carries the full sheet incl. `=B6*10` at AA6).
- tour-a3.mjs (the adjudication script, formula-text assertions): copy-range,
  paste-range, copy-row, paste-row, paste-col ALL PASS. copy-col / copy-all show
  20 lines vs the script's 13 — every content index exact (Qty/3/7/''/`=Z6+1`;
  B13 `=Z6+1`, AA6 `=B6*10`); the count delta is fully explained by the sequence's
  own row paste at A20 extending the used range before the copies — correct
  product behavior, adjudicated PASS on content.
- A2 lock badges (tour-a.mjs): 6/6 exact — 0 markers baseline; cell A1 ->
  [cell-0-0]; range A1:B2 -> 3; row 3 -> 21; column C -> 33; select-all ->
  745/748. §2 selection-gating holds in the current tree.
- A3 deletes (tour-a.mjs): 5/5 PASS — cell/range/row/column/select-all content
  clears with correct dependent-formula outcomes (D13 150 -> 136 -> 126 -> 0).

## TOUR B (gateway signed mode) — B4 + B5 behaviors
- tour-b.mjs full run (API-created session + browser deep-link join, signed
  engine access): **ALL PASS 19/19**. B4 8/8 with server read-backs:
  selection view-only (0 op POSTs during row selection); row-6 Delete clears
  visible A..F AND off-screen Z6/AA6; B13 = 1 (formula `=Z6+1` kept), D13 =
  150 -> 136; structure untouched; exactly ONE Ctrl+Z restores all
  (Z6=777, B13=778, D13=150). B5 all five cases PASS in this mode too
  (row-above/below, col-left/right, multi-row span: before+after read-backs
  exact, incl. formula shifts `=P3*2`, `=S1*3`, `=U5+2`, 3-row insert).
- Canonical B5 session mode (browser upload, fresh stack per case): BLOCKED
  by an unrelated in-flight defect in the current tree — NOT a selection
  defect. Root cause proven by probes (rerun/dbg-upload*.mjs, dbg5.log,
  shots/dbg-upload5-after.png): the app's own local-dev sign-in returns
  /auth/login 200 and identity reads succeed, but the token is not
  presented on the upload path — POST /api/files/upload-grant -> 401
  ("not authenticated (401)" rendered in the files list) and
  /api/engine/session-extras -> 401 immediately after login. The gateway
  token now lives in the secure-vault store
  (icecream-sheets.access.v1) while other paths still read the legacy
  localStorage key — the sign-in/token split the AUTH COHERENCE RULE
  (user ruling 2026-10-22) forbids, owned by the hosted-ux fix batch
  (D1) already in flight on the parent session. Harness adaptations made
  for the current shell (documented in rerun/tour-b.mjs): sign in via
  the app's dev form; upload via the app's #ics-upload-input (the old
  `.app` drag-drop target no longer exists in the product shell).
  B5's asserted behaviors are fully covered by the 19/19 run above; the
  only uncovered delta is session establishment via browser upload,
  which is the hosted-ux batch's surface, not the selection model's.

## FINAL GATES
- Full apps/web suite (post-fix tree): 150 files / 1959 tests, ALL PASS
  (513s). `tsc --noEmit` in apps/web: clean. GridSelectionDefects: 14/14
  (8 original + 6 new D-SEL-4, with negative control).
- Screenshots self-inspected: shots/a2-badge-c-row.png (badges confined
  to the selected row), shots/a3-copy-range-paste.png (2x2 block pasted
  at H2:I3 — D-SEL-4 proof), shots/b4-row6-selected.png (gateway-mode
  row selection + presence), shots/a1-shape-multi-row-noncontig.png
  (rows 2/5/7 non-contiguous; badges only on selected rows).

## VERDICTS
- **TOUR A: PASS.** All shapes exact; §2 lock-badge gating exact (6/6);
  copy/paste/delete content semantics all PASS incl. formula-text copy.
  One NEW defect found and fixed in-scope: D-SEL-4 (cell context menu
  collapsed the selection — the cell-side remainder of D-SEL-2), with
  regression tests + negative control + browser proof post-fix.
- **TOUR B: PASS** on every asserted behavior (19/19: B4 8/8, B5 5/5
  cases), with one environmental caveat: the canonical browser-upload
  session path is currently broken by the in-flight auth-coherence
  rework (hosted-ux batch D1; upload-grant 401 after a 200 login —
  evidence above). That is session plumbing owned by another batch,
  not selection behavior; it should be re-proven once D1 lands, at
  which point rerun/run-case.sh runs the five B5 cases in upload mode
  unchanged.

## Evidence map
- This report; rerun/tour-a-results.json, tour-a2-results.json,
  tour-a3-results.json, tour-b-results.json (API-mode full run);
  rerun/shots/ (43 images incl. dbg-* auth probes); rerun/dbg4.log,
  rerun/dbg5.log (auth-split traces); code: apps/web/src/Grid.tsx
  (handleCellContext), apps/web/src/components/
  GridSelectionDefects.test.tsx (D-SEL-4 block).
- Stack (ports 9030-9033) stopped at the end of this run. progress.md
  untouched; nothing pushed.
