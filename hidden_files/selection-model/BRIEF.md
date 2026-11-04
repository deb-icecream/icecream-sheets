# Grid Selection Model — Build Brief (user directive 2026-10-21 18:42 PDT)

## Why
The user ruled the grid's selection model is incomplete and foundational: without
proper selection shapes, copy/delete and every selection-dependent operation are
crippled. This also unblocks the lock-badge ruling's unvalidated shapes (c)/(d)/(e)
(design-docs/workbook-protection-and-encryption.md §2).

## Required selection shapes and interactions (all mandatory)
1. **Cell** — click selects one cell (exists).
2. **Rectangular range** — (a) click a cell and DRAG to the opposite corner;
   (b) click a cell, then SHIFT+CLICK another cell → the rectangle between them.
3. **Row** — click a ROW NUMBER header → the entire row is selected.
4. **Column** — click a COLUMN LETTER header (A, B, C, D…) → the entire column is selected.
5. **Select all** — Ctrl+A selects the whole grid.
6. **Multi-row / multi-column** — selecting several rows or several columns is allowed
   (header drag across multiple headers, and Shift+click to extend a header selection;
   Ctrl+click for non-contiguous headers if the existing model supports it — report
   what you implement).
7. Selection must be a first-class model the rest of the grid consumes: copy, delete,
   formatting, and the lock badge all read the SAME selection state. Verify copy and
   delete actually operate correctly on each shape (row, column, range, select-all).

## Lock-badge completion (part of acceptance)
With shapes 3–5 in place, validate the §2 ruling for ALL shapes with the 5-shape
screenshot set: (a) unlocked-selected → no badges; (b) locked cell selected → badge;
(c) row selected → badges only on that row's locked cells; (d) column selected →
badges only on that column's locked cells; (e) select-all → badges everywhere locked.
Aria "(locked)" announcement unchanged.

## Where
Shared grid (apps/web/src/Grid.tsx and its selection state) — web AND desktop get it
through the shared code. Follow existing grid patterns; do not fork a desktop variant.

## Addendum — operations on selections (user directives, 2026-10-21 18:44–18:50 PDT)
1. **Selection state is VIEW-ONLY**: it lives in the client/view layer — selecting
   triggers no server/engine call, no op, no revision. Web and desktop both.
   Represent select-all and full row/column selections as ranges/flags, never as
   enumerated per-cell lists; no full-grid scans on selection changes (no perf cost
   at any workbook size).
2. **Operations act on the DATA MODEL, not the DOM**: the grid is virtualized (only
   the visible window ± overscan is rendered). A selected row/column/range means
   every cell in it in the model, including cells far outside the rendered window.
   Validation must prove an operation reaches off-screen cells (engine read-back).
3. **Delete key = CONTENT CLEAR**: clears value AND formula (a formula cell is left
   truly empty; dependents recalculate). It never deletes row/column structure.
   The clear is a real op through the engine path — in web mode it goes to the
   server, and client mirror + server must agree afterwards (prove by read-back).
4. **Context-menu inserts**: the grid's right-click context menu must offer, for a
   row selection, "Insert row above" and "Insert row below"; for a column selection,
   "Insert column left" and "Insert column right". Existing state (parent-verified):
   engine protocol supports insertRows/insertCols/deleteRows/deleteCols;
   features/sheetOps.ts wraps inserts; the ribbon offers above/left only. The
   context-menu entries (incl. below/right) are the build. Structural inserts flow
   through the engine protocol so references shift and recalc per Excel semantics,
   client and server consistent. Validate all four inserts in the browser
   (content position + a formula reference shifting correctly, read back after).
5. Report precisely what existed vs what was built for items 3–4.

## Sequencing constraint (binding)
Phase 2 co-authoring validation is running tours on the shared stack/dist. Build and
unit-test freely, but do NOT rebuild the shared dist or run browser tours against the
shared stack while that validation is mid-tour — use an isolated stack/port for your
browser proof, or coordinate timing through the parent. No regressions to the
Phase-1/Phase-2 baselines.

## Validation (user: "definitely validate it")
- Unit tests for the selection model: every shape, extension, multi-select, and
  shape transitions (cell→range→row→column→all).
- Browser proof with screenshots, one per shape, self-inspected: row selected via
  row header, column via column header, range via drag, range via shift-click,
  multi-row, multi-column, select-all via Ctrl+A.
- Copy + delete proven on row, column, and range selections (values verified after).
- Lock-badge 5-shape screenshot set (above).
- Desktop spot-check on the packaged app (shared grid) for row/column/select-all.
- Report: what was built, per-shape evidence, anything NOT done stated plainly.
