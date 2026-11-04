# @icecream-sheets/web — Grid UI (Phase 4)

Vite + React + TypeScript spreadsheet UI. A **pure consumer of the engine
protocol**: every read and mutation goes through `EngineHost` from
`@icecream-sheets/engine` (`execute` / `readCell` / `readRange` / `snapshot` /
`subscribe`). No UI file imports `hyperformula` or engine internals.

## Run

```sh
npm run dev --workspace @icecream-sheets/web     # dev server
npm run build --workspace @icecream-sheets/web  # tsc + vite build -> dist/
npm test --workspace @icecream-sheets/web       # vitest (headless)
```

## Layout

- `src/main.tsx` — React root.
- `src/App.tsx` — layout (toolbar, formula bar, grid, sheet tabs, status bar)
  and all engine interaction: selection, commit, recalc, calc-mode, open/save.
- `src/Grid.tsx` — the cell grid.
- `src/FormulaBar.tsx` — address + formula/value editor for the selection.
- `src/SheetTabs.tsx` — sheet list, switch, '+' to add via protocol.
- `src/Toolbar.tsx` — Open .xlsx, Download .xlsx, Recalculate, calc-mode toggle.
- `src/StatusBar.tsx` — protocol version, calc mode, selection, last error.
- `src/engine.ts` — host singleton, display formatting, edit parsing, A1 helpers.
- `src/io.ts` — pure snapshot <-> WorkbookData conversion (used by Open/Save,
  covered by headless tests).
- `src/xlsx.ts` — re-exports `XlsxAdapter` from `@icecream-sheets/xlsx-adapter`.
- `src/index.css` — plain CSS, no frameworks.

## What works

- Click / double-click / type-to-edit cells; Enter/Tab/arrows navigate and commit.
- Formulas (`=SUM(A1:A2)`) via `setFormula`; values via `setCell` with
  number/boolean coercion; Delete clears.
- Formula bar edits the selected cell's formula (or value).
- Sheet tabs: switch and add sheets through the protocol.
- Recalculate button and automatic/manual calculation-mode toggle.
- Open `.xlsx` (rebuilds the workbook from adapter data) and Download `.xlsx`
  (snapshot -> adapter -> file download). Uses the real
  `@icecream-sheets/xlsx-adapter` (SheetJS).
- Status bar shows protocol version, calc mode, selected cell, last error.

## Honest limitations (v1)

- **Fixed 100 x 26 grid window** (rows 1..100, cols A..Z). Cells outside the
  window exist in the engine but are not reachable in the UI. Virtualization
  for larger sheets is a follow-up (see the comment in `Grid.tsx`).
- **No clipboard** (copy/paste), no fill handle, no range selection, no column
  resize, no cell formatting (fonts, colors, number formats) yet.
- **Editing is single-cell**; the formula bar and grid editor both commit one
  cell at a time.
- **Number display is unformatted** (`String(value)`); no thousands separators
  or decimal control.
- **Errors surface two ways**: cell errors show their code in the grid
  (`#DIV/0!` etc.); command failures (e.g. denied by policy, bad sheet name)
  appear in the status bar.
- **Open replaces the current workbook** (with the previous host disposed);
  there is no unsaved-changes prompt.
- **XLSX fidelity** is whatever `@icecream-sheets/xlsx-adapter` provides:
  values and formulas round-trip; formatting/charts/macros are out of scope
  for the adapter.
- **Bundle size**: ~1.15 MB minified (React + HyperFormula + SheetJS); the
  vite chunk-size warning is expected for a spreadsheet app and not a defect.
- **No network calls**: the app never fetches anything; all data stays local.
- The dev server (`npm run dev`) was smoke-tested; interactive browser QA of
  the grid has not been done in this environment.
