# Ribbon

Excel-style tabbed command bar for the Icecream Sheets web UI
(`src/ribbon/`). Pure UI layer: every enabled button calls back into `App`,
which owns the engine wiring (all mutations via `EngineHost.execute()`,
file I/O via the xlsx adapter helpers).

## Tab / group / button inventory

| Tab      | Group             | Buttons                                              | State    |
|----------|-------------------|------------------------------------------------------|----------|
| File     | Workbook          | New                                                  | enabled  |
| File     | File              | Open .xlsx, Save .xlsx                               | enabled  |
| Home     | Clipboard         | Cut, Copy, Paste                                     | enabled  |
| Home     | Font              | Bold, Italic, Underline                              | disabled |
| Home     | Cells             | Clear Contents                                       | enabled  |
| Insert   | Sheets            | New Sheet                                            | enabled  |
| Formulas | Function Library  | SUM, AVERAGE, COUNT, MIN, MAX, IF                    | enabled  |
| Formulas | Calculation       | Recalculate, Automatic/Manual toggle                 | enabled  |
| Data     | Sort & Filter     | Sort A to Z, Sort Z to A, Filter                     | disabled |
| View     | Zoom              | Zoom In, Zoom Out, 100% (+ live % readout)           | enabled  |
| View     | Show              | Gridlines (toggle), Formula Bar (toggle)             | enabled  |

## Disabled controls (honesty log)

- **Font group (Bold / Italic / Underline)** — the engine has no cell
  formatting model (no fonts, colors, or styles in `TypedValue` or the
  protocol). Tooltip: "Requires cell formatting, not in the engine yet".
- **Sort & Filter group** — the engine has no sorting or filtering
  operations. Tooltip: "Requires sorting and filtering support, not in the
  engine yet".

Disabled buttons render visibly dimmed with the reason in the `title`
tooltip. They become enabled only when the underlying engine capability
lands — never wired to no-ops.

## Behavior notes

- **Cut / Copy / Paste** use `navigator.clipboard` with TSV text. Copy
  writes the cell's edit text (formula with `=` when present, otherwise the
  display value) so pasting through `parseEdit` round-trips formulas.
  Single-cell only in v1 (`firstCellText` takes the first line's first
  tab field). Clipboard denial surfaces via the status bar error.
- **Function buttons** insert a skeleton (`=SUM()`, `=IF(,,)`, …) into the
  formula bar as a draft for the selected cell; nothing is committed until
  the user presses Enter.
- **New Sheet** auto-names `Sheet1`, `Sheet2`, … skipping taken names
  (`nextSheetName` in `clipboard.ts`, unit tested).
- **Zoom** applies the CSS `zoom` property on the grid wrapper (Chromium
  only — fine for the web app and the Electron shell), 50%–200%.
- **Gridlines** toggles cell borders via a wrapper class; headers keep
  their borders.
