# Cell Coverage Sweep — all 97 real-world files, every sheet

Date: 2026-10-18/19 (UTC). Method: per `test-data/real-world/*.xlsx`, every sheet —
raw non-empty `<c>` refs from the worksheet XML (Python `xml.etree`, real parser)
diffed against `XlsxAdapter.read()` non-null cells from `sheet.rows`.

**Verdict: NOT fully clean — 96/97 files clean; 1 file has 26 missing cells, all
classified as a documented representational boundary (see §4). Zero EXTRA cells
(no phantom cells invented) across all 97 files.**

## Summary

| Metric | Value |
|---|---|
| Files swept | 97 |
| Sheets swept | 271 |
| Raw non-empty cells (effective-value rule) | 92,475 |
| Files clean | 96 |
| Files with issues | 1 |
| Total MISSING refs | 26 |
| Total EXTRA refs | 0 |
| Adapter read errors | 0 |

## Methodology (rules, documented per task)

- **Raw side** (`/tmp/sweep/raw_refs.py`, `xml.etree`): a `<c>` counts as non-empty iff
  not self-closing AND (has `<f>` with text, OR a shared-formula `<f t="shared">`
  resolvable from its master, OR `<is>` with concatenated text ≠ `''`, OR `<v>` whose
  *effective* value ≠ `''`). `t="s"` cells resolve through `xl/sharedStrings.xml` —
  an empty shared string counts as **empty** (mirrors the adapter/engine treating
  `''` as blank). Both transitional and strict-OOXML namespaces handled
  (`http://purl.oclc.org/ooxml/spreadsheetml/main`, incl. strict `r:id` namespace).
- **Adapter side** (`/tmp/sweep/diff.mjs`): cell present iff
  `v !== null && v !== undefined && v !== ''`; row/col indices → A1 refs
  (adapter output is always A1-based).
- Sheet-name → part mapping via `xl/workbook.xml` + `xl/_rels/workbook.xml.rels`
  on both sides (no index guessing).

## Fixes applied (real root-cause fixes, rebuilt, re-swept)

Two systematic drop bugs were found and fixed in `packages/xlsx-adapter`
(new module `src/formulaRecovery.ts`, changes to `src/adapter.ts`; 19 new tests in
`tests/formulaRecovery.test.ts`; full suite 98/98 green):

1. **Stale `<dimension>`** — `worksheetToRows()` sized row arrays from `ws['!ref']`
   alone. Writers (excelize, xlsx-populate) emit `<dimension>` smaller than the real
   `<c>` content, so parsed cells outside it were silently dropped
   (excelize `E1`; xlsx-populate `B10:D13`, 12 cells).
   **Fix:** range = union of `!ref` and every cell key SheetJS actually parsed.
2. **Formula cells without cached `<v>` dropped by SheetJS CE** — writers aren't
   required to cache values; SheetJS drops `<f>`-only cells entirely, including all
   shared-formula slaves (`<f t="shared" si="N"/>`, 25 cells across excelize +
   xlsx-populate).
   **Fix:** best-effort raw-XML reconciliation pass in `read()` (before the
   structured-ref/defined-name/OFFSET rewrites): recovers formula text for dropped
   cells and translates shared-formula slaves from their master's text with proper
   relative-reference shifting (absolute `$` axes don't move; out-of-grid shifts →
   `#REF!`; string literals, function names like `LOG10(`, `#REF!`, defined names
   untouched). Verified end-to-end: recovered `=B10/C10` evaluates to the correct
   value in the engine.

Before the fix: 5 files, 136 missing. After: 1 file, 26 missing (all §4).

## The 26 remaining missing cells (classified, not fixable in the adapter)

File: `closedxml-Formulas-DataTableFormula-Excel-Input.xlsx` — the five
"Deleted Input" sheets (data-table experiments whose inputs were deleted, so
results became `#REF!` errors):

- `1D Row - Deleted Input`: C3, C4, C5
- `1D Column - Deleted Input`: B4, C4, D4, E4, F4
- `2D - Input1 Deleted`: D4, E4, D5, E5, D6, E6
- `2D - Input2 Deleted`: C3, D3, C4, D4, C5, D5
- `2D - Input 1&2 Deleted`: C2, D2, C3, D3, C4, D4

All 26 are **literal error cells** (`<c t="e"><v>#REF!</v></c>`, some with a
text-less `<f t="dataTable"/>`). The adapter maps them to `null` per its documented,
deliberate contract ("Error cells cannot be represented as CellInput, so they read
back as null" — `adapter.ts` header). This is a representational boundary, not a
drop bug:

- `CellInput = string | number | boolean | null` cannot carry an error value.
- Verified empirically: HyperFormula throws `Unable to parse value` when given a
  `CellError` as raw input (`setCellContents` and `buildFromSheets`), so no
  adapter-level representation exists.
- The alternatives (emitting the error text as a *string*, or fabricating a
  formula like `=1/0`) would corrupt data semantics — worse than the honest null.

Proper support for error literals needs a **product decision**: extending
`CellInput` end-to-end (engine, protocol, service, web UI — ~20 files reference
`CellInput`). Recommended follow-up; out of scope for this adapter sweep.

Note: the other 38 error cells in the corpus carry real `<f>` text
(e.g. ClosedXML's `<f>#DIV/0!</f>` quirk) and are preserved as formulas — present.

## Per-file results

✅ beyond-excel-bxl3way.xlsx (13 sheets, 2957 cells)
✅ closedxml-Cubes-CubeFromRange-Input.xlsx (2 sheets, 27 cells)
✅ closedxml-ExternalLinks-WorkbookWithExternalLink.xlsx (1 sheets, 1 cells)
❌ closedxml-Formulas-DataTableFormula-Excel-Input.xlsx
   sheet "1D Row - Deleted Input": raw=7 adapter=4 missing=[C3,C4,C5] extra=[]
   sheet "1D Column - Deleted Input": raw=12 adapter=7 missing=[B4,C4,D4,E4,F4] extra=[]
   sheet "2D - Input1 Deleted": raw=13 adapter=7 missing=[D4,E4,D5,E5,D6,E6] extra=[]
   sheet "2D - Input2 Deleted": raw=13 adapter=7 missing=[C3,D3,C4,D4,C5,D5] extra=[]
   sheet "2D - Input 1&2 Deleted": raw=12 adapter=6 missing=[C2,D2,C3,D3,C4,D4] extra=[]
   (all 26 = literal t="e" #REF! cells — CellInput boundary, see §4)
✅ closedxml-MergedCellsBorder-inputfile.xlsx (3 sheets, 8 cells)
✅ closedxml-Sources-PivotTable-AllSources-input.xlsx (12 sheets, 62 cells)
✅ closedxml-TryToLoad-CellsWithDateTimeDataTypeOrFormatting.xlsx (1 sheets, 51 cells)
✅ closedxml-TryToLoad-CellsWithTimeSpanDataTypeOrFormatting.xlsx (1 sheets, 36 cells)
✅ closedxml-TryToLoad-DrawingSizeInPx.xlsx (16 sheets, 13567 cells)
✅ closedxml-TryToLoad-FileWithDefaultStyleNameNotInEnglish.xlsx (1 sheets, 77 cells)
✅ closedxml-TryToLoad-PivotTableWithMissingReference.xlsx (3 sheets, 351 cells)
✅ closedxml-TryToLoad-TableHeadersWithLineBreaks.xlsx (1 sheets, 65 cells)
✅ closedxml-TryToLoad-TemplateWithTableSourcePivotTables.xlsx (28 sheets, 1789 cells)
✅ closedxml-data-table-multi-table.xlsx (1 sheets, 172 cells)
✅ closedxml-data-table-one-variable.xlsx (1 sheets, 34 cells)
✅ closedxml-shared-formula-3d-reference.xlsx (2 sheets, 35 cells)
✅ closedxml-shared-formula-basic.xlsx (3 sheets, 38 cells)
✅ closedxml-shared-formula-text-results.xlsx (2 sheets, 28 cells)
✅ closedxml-track-changes-simple-cell-changes.xlsx (3 sheets, 7 cells)
✅ closedxml-xlsx-bug-fixes.xlsx (2 sheets, 11 cells)
✅ closedxml-xlsx-ceiling-floor.xlsx (1 sheets, 451 cells)
✅ closedxml-xlsx-column-style-autofilter.xlsx (24 sheets, 62015 cells)
✅ closedxml-xlsx-database.xlsx (3 sheets, 60 cells)
✅ closedxml-xlsx-external-refs.xlsx (3 sheets, 4 cells)
✅ closedxml-xlsx-formats.xlsx (4 sheets, 40 cells)
✅ closedxml-xlsx-functions-excel-2010.xlsx (2 sheets, 973 cells)
✅ closedxml-xlsx-matrix-multiplication.xlsx (3 sheets, 11 cells)
✅ closedxml-xlsx-named-ranges-global.xlsx (2 sheets, 21 cells)
✅ closedxml-xlsx-pivot_table_first_header_row.xlsx (2 sheets, 250 cells)
✅ closedxml-xlsx-pivottable_bool_field_filter.xlsx (2 sheets, 27 cells)
✅ closedxml-xlsx-pivottable_duplicated_member_filter.xlsx (2 sheets, 149 cells)
✅ closedxml-xlsx-pivottable_error_item_filter.xlsx (1 sheets, 20 cells)
✅ closedxml-xlsx-pivottable_tabular_mode.xlsx (2 sheets, 166 cells)
✅ closedxml-xlsx-ref_string.xlsx (1 sheets, 3 cells)
✅ closedxml-xlsx-tdf81939.xlsx (3 sheets, 5 cells)
✅ closedxml-xlsx-universal-content-strict.xlsx (2 sheets, 8 cells)
✅ closedxml-xlsx-universal-content.xlsx (2 sheets, 8 cells)
✅ compressexcel-saas-3statement.xlsx (21 sheets, 3942 cells)
✅ dropbox-shortcut-master.xlsx (3 sheets, 1986 cells)
✅ excelize-Book1.xlsx (2 sheets, 41 cells)
✅ excelize-CalcChain.xlsx (1 sheets, 2 cells)
✅ exceljs-data-bogus-defined-name.xlsx (1 sheets, 1 cells)
✅ exceljs-data-fibonacci.xlsx (1 sheets, 38 cells)
✅ exceljs-data-formulas.xlsx (1 sheets, 4 cells)
✅ exceljs-data-gold.xlsx (1 sheets, 12 cells)
✅ exceljs-data-test-issue-1364.xlsx (1 sheets, 6 cells)
✅ exceljs-data-test-issue-877.xlsx (5 sheets, 977 cells)
✅ exceljs-data-test-issue-880.xlsx (5 sheets, 982 cells)
✅ xlsxpopulate-ranges-out.xlsx (2 sheets, 36 cells)
✅ xlsxwriter-array_formula01.xlsx (1 sheets, 9 cells)
✅ xlsxwriter-array_formula02.xlsx (1 sheets, 9 cells)
✅ xlsxwriter-array_formula03.xlsx (1 sheets, 7 cells)
✅ xlsxwriter-array_formula04.xlsx (1 sheets, 3 cells)
✅ xlsxwriter-autofilter01.xlsx (1 sheets, 204 cells)
✅ xlsxwriter-autofilter04.xlsx (1 sheets, 204 cells)
✅ xlsxwriter-chart_area01.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_bar01.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_bar03.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_column01.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_column04.xlsx (1 sheets, 10 cells)
✅ xlsxwriter-chart_crossing01.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_data_labels01.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_data_labels10.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_doughnut01.xlsx (1 sheets, 6 cells)
✅ xlsxwriter-chart_layout01.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_layout05.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_line01.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_line03.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_pattern01.xlsx (1 sheets, 24 cells)
✅ xlsxwriter-chart_pie01.xlsx (1 sheets, 6 cells)
✅ xlsxwriter-chart_points01.xlsx (1 sheets, 6 cells)
✅ xlsxwriter-chart_radar01.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_scatter01.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_scatter05.xlsx (1 sheets, 15 cells)
✅ xlsxwriter-chart_stock01.xlsx (1 sheets, 20 cells)
✅ xlsxwriter-chart_stock02.xlsx (1 sheets, 20 cells)
✅ xlsxwriter-cond_format01.xlsx (1 sheets, 4 cells)
✅ xlsxwriter-cond_format06.xlsx (1 sheets, 4 cells)
✅ xlsxwriter-cond_format11.xlsx (1 sheets, 5 cells)
✅ xlsxwriter-data_validation01.xlsx (1 sheets, 0 cells)
✅ xlsxwriter-data_validation03.xlsx (1 sheets, 0 cells)
✅ xlsxwriter-defined_name01.xlsx (3 sheets, 2 cells)
✅ xlsxwriter-formula_results01.xlsx (1 sheets, 12 cells)
✅ xlsxwriter-hyperlink01.xlsx (1 sheets, 1 cells)
✅ xlsxwriter-hyperlink12.xlsx (1 sheets, 2 cells)
✅ xlsxwriter-hyperlink20.xlsx (1 sheets, 2 cells)
✅ xlsxwriter-image01.xlsx (1 sheets, 0 cells)
✅ xlsxwriter-image07.xlsx (2 sheets, 0 cells)
✅ xlsxwriter-panes01.xlsx (13 sheets, 13 cells)
✅ xlsxwriter-print_area01.xlsx (1 sheets, 1 cells)
✅ xlsxwriter-rich_string01.xlsx (1 sheets, 3 cells)
✅ xlsxwriter-table01.xlsx (1 sheets, 4 cells)
✅ xlsxwriter-table07.xlsx (1 sheets, 1 cells)
✅ xlsxwriter-table12.xlsx (1 sheets, 13 cells)
✅ xlsxwriter-table18.xlsx (1 sheets, 5 cells)
✅ xlsxwriter-textbox01.xlsx (1 sheets, 0 cells)
✅ xlsxwriter-textbox08.xlsx (1 sheets, 0 cells)

## What remains / recommended follow-ups

1. **Error-literal support (product decision):** 26 literal `#REF!` cells read as
   null. Carrying error values needs `CellInput` extended end-to-end (engine +
   protocol + service + web UI). Until then the grid shows these as blank — a
   known, documented fidelity gap.
2. **Sweep tooling** (ephemeral, `/tmp/sweep/`): `raw_refs.py` (raw extraction),
   `diff.mjs` (adapter diff), `raw.json`, `diff.json`, `perfile.txt`. Re-runnable.
3. Note: `packages/xlsx-adapter` was concurrently modified during this task
   (numfmt support: `src/numfmt.ts`, `cellNF: true`, `sheet.formats`). My changes
   merged cleanly and the full suite (98/98) passes with both.
