# Icecream Sheets — 29 Capability Tracks, 718 Features (audit-refresh 2026-10-18, second re-audit same day)

> Generated from `inventory/feature-inventory.json` (259 features),
> `inventory/function-categories.json` (459 functions), `catalog/tracks.md`,
> design docs, and codebase probes. Audit-refresh 2026-10-18: every track was
> re-verified against the actual repo (file existence + export/import/test
> wiring). FEATURES.md's pre-audit probes dated from 2026-10-13 and were stale.
> Legend: `[x]` built · `[ ]` pending · `[~]` partial/in-progress

## Track 1: Calculation engine (`calc-engine`)
**Status:** ✅ Built (calc modes automatic/manual done; parallel recalculation NOT yet built — see track 13)
**Scope:** Dependency DAG, recalculation chain, iterative circular solving, volatile functions and automatic or manual calculation controls

**Features:**
- [x] Calculation controls: Automatic (on) _(surfaces: Tools)_
- [x] Calculation controls: Manual _(surfaces: Tools)_

## Track 2: Formula language (`formula-language`)
**Status:** ✅ Built (second re-audit 2026-10-18; Phase-2 coverage audit 2026-10-21) — 517 of 523 Excel names resolve with REAL implementations; zero #N/A stubs (`external-stubs.ts` deleted). The 6 non-implemented names are legacy DBCS byte functions (FINDB, LEFTB, MIDB, REPLACEB, RIGHTB, SEARCHB) — documented skips under the user's 2026-10-21 triage ruling (see hidden_files/function-coverage/FUNCTION-LIST-AND-GAPS.md; LENB IS implemented). Phase 2 (2026-10-21) added GROUPBY/PIVOTBY (`groupby-functions.ts`) and ODDFPRICE/ODDFYIELD/ODDLPRICE/ODDLYIELD (`financial-functions3.ts`), fixed INT/MOD to Excel semantics (negative operands), and its test-coverage audit found and fixed 25 defects in previously "implemented" functions — including LINEST/LOGEST/MINVERSE/MUNIT, which had been stubs; all 511 previously-implemented functions now have test coverage (511/511). Follow-on wave completed: AMORDEGRC/AMORLINC/COUPDAYBS/COUPDAYSNC/COUPNCD/COUPPCD/PRICEMAT/YIELDMAT (`financial-functions2.ts`), FORECAST.ETS family/FREQUENCY/MODE.MULT/LENB/T (`extended-functions8.ts`), GETPIVOTDATA/CELL/IMAGE (`extended-functions9.ts`), DETECTLANGUAGE/ENCODEURL (`extended-functions10.ts`), CUBE*/STOCKHISTORY/WEBSERVICE/RTD/COPILOT/PY/CALL/REGISTER.ID (`cube-functions.ts`, `extended-functions11.ts`). DETECTLANGUAGE/TRANSLATE ship real heuristic defaults + pluggable providers (not stubs).
**Scope:** Excel and Google Sheets function coverage, arrays, LET, LAMBDA, sandboxed custom code and external-data functions

**Features:**
- [~] Quick function buttons (sum, average, count, max, min) _(surfaces: Insert, Toolbar)_ — Buttons for the five functions below; the functions themselves are listed once in the catalog.
- [~] Function category submenus (All, Array, Database, Date, Engineering, Filter, Financial, Google, Info, Logical, Lookup, Math, Operator, Parser, Statistical, Text, Web) _(surfaces: Insert, Toolbar)_
- [~] Learn more _(surfaces: Insert, Toolbar)_

**Function coverage (517 of 523 Excel names with real implementations; 6 legacy DBCS byte functions documented-skipped per user ruling 2026-10-21; zero stubs):**
- [x] **Array** — all implemented
- [x] **Database** — all implemented
- [x] **Date** (100%)
- [x] **Engineering** (100%)
- [x] **Filter** — all implemented
- [x] **Financial** — all implemented incl. bond functions (AMORDEGRC/AMORLINC/COUP*/PRICEMAT/YIELDMAT)
- [x] **Google** — DETECTLANGUAGE (heuristic detector + provider seam), TRANSLATE (phrasebook + provider seam); GOOGLEFINANCE via market-data connector
- [x] **Info** — CELL implemented; ERROR.TYPE implemented
- [x] **Lookup** — GETPIVOTDATA implemented (resolves against the pivot engine)
- [x] **Math** — all implemented (LCM via HyperFormula, accepts ranges)
- [x] **Operator** — all implemented
- [x] **Parser** — all implemented
- [x] **Statistical** — all implemented incl. FORECAST.ETS family, FREQUENCY, MODE.MULT
- [x] **Text** — all implemented incl. LENB, T
- [~] **Web** — ENCODEURL/WEBSERVICE implemented; IMPORTDATA/IMPORTFEED/IMPORTHTML/IMPORTXML are not formula functions (shared fetch substrate exists in ETL)

## Track 3: Grid (`grid`)
**Status:** ✅ Built
**Scope:** Grid rendering, selection, editing, View and Format controls, toolbar, formula bar, name box, sheets and editor commands

**Features:**
- [x] Undo (Ctrl+Z) _(surfaces: Edit, Toolbar)_
- [x] Redo (Ctrl+Y) _(surfaces: Edit, Toolbar)_
- [x] Cut (Ctrl+X) _(surfaces: Edit, Column menu)_
- [x] Copy (Ctrl+C) _(surfaces: Edit, Column menu)_
- [x] Paste (Ctrl+V) _(surfaces: Edit, Column menu)_
- [x] Paste special: Values only (Ctrl+Shift+V) _(surfaces: Edit, Column menu)_
- [x] Paste special: Format only (Ctrl+Alt+V) _(surfaces: Edit, Column menu)_
- [x] Paste special: Formula only _(surfaces: Edit, Column menu)_
- [x] Paste special: Conditional formatting only _(surfaces: Edit, Column menu)_
- [x] Paste special: Data validation only _(surfaces: Edit, Column menu)_
- [x] Paste special: Transposed _(surfaces: Edit, Column menu)_
- [x] Paste special: Column width only _(surfaces: Edit, Column menu)_
- [x] Paste special: All except borders _(surfaces: Edit, Column menu)_
- [x] Move (submenu) _(surfaces: Edit)_
- [x] Delete: Values _(surfaces: Edit)_
- [x] Delete: Row _(surfaces: Edit)_
- [x] Delete: Column _(surfaces: Edit)_
- [x] Delete: Cells and shift up _(surfaces: Edit)_
- [x] Delete: Cells and shift left _(surfaces: Edit)_
- [x] Delete: Notes _(surfaces: Edit)_
- [x] Find and replace _(surfaces: Edit)_
- [x] Show: Formula bar (on) _(surfaces: View)_
- [x] Show: Gridlines (on) _(surfaces: View)_
- [x] Show: Formulas (Ctrl+backtick) _(surfaces: View)_
- [x] Show: Protected ranges _(surfaces: View)_
- [x] Freeze: No rows _(surfaces: View)_
- [x] Freeze: 1 row _(surfaces: View)_
- [x] Freeze: 2 rows _(surfaces: View)_
- [x] Freeze: Up to row 1 _(surfaces: View)_
- [x] Freeze: No columns _(surfaces: View)_
- [x] Freeze: 1 column _(surfaces: View)_
- [x] Freeze: 2 columns _(surfaces: View)_
- [x] Freeze: Up to column A _(surfaces: View)_
- [x] Freeze up to column B _(surfaces: Column menu)_
- [x] Group _(surfaces: View)_
- [x] Ungroup _(surfaces: View)_
- [x] Hidden sheets (submenu) _(surfaces: View)_
- [x] Zoom: 50% _(surfaces: View)_
- [x] Zoom: 75% _(surfaces: View)_
- [x] Zoom: 90% _(surfaces: View)_
- [x] Zoom: 100% (on) _(surfaces: View)_
- [x] Zoom: 125% _(surfaces: View)_
- [x] Zoom: 150% _(surfaces: View)_
- [x] Zoom: 200% _(surfaces: View)_
- [x] Zoom combobox (50% to 200%) _(surfaces: Toolbar)_ — Toolbar mirror of the View > Zoom levels.
- [x] Full screen _(surfaces: View)_
- [x] Insert cells and shift right _(surfaces: Insert)_
- [x] Insert cells and shift down _(surfaces: Insert)_
- [x] Insert 1 row above _(surfaces: Insert)_
- [x] Insert 1 row below _(surfaces: Insert)_
- [x] Insert 1 column left _(surfaces: Insert, Column menu)_
- [x] Insert 1 column right _(surfaces: Insert, Column menu)_
- [x] Sheet (Shift+F11) _(surfaces: Insert)_
- [x] Pre-built tables _(surfaces: Insert)_
- [x] Image (submenu) _(surfaces: Insert)_
- [x] Drawing _(surfaces: Insert)_
- [x] Link (Ctrl+K) _(surfaces: Insert, Toolbar)_
- [x] Emoji _(surfaces: Insert)_
- [x] Theme _(surfaces: Format)_
- [x] Number format: Automatic (on) _(surfaces: Format)_
- [x] Number format: Plain text _(surfaces: Format)_
- [x] Number format: Number (1,000.12) _(surfaces: Format)_
- [x] Number format: Percent (10.12%) _(surfaces: Format)_
- [x] Number format: Scientific (1.01E+03) _(surfaces: Format)_
- [x] Number format: Accounting _(surfaces: Format)_
- [x] Number format: Financial _(surfaces: Format)_
- [x] Number format: Currency _(surfaces: Format)_
- [x] Number format: Currency rounded _(surfaces: Format)_
- [x] Number format: Date (26/09/2008) _(surfaces: Format)_
- [x] Number format: Time (15:59:00) _(surfaces: Format)_
- [x] Number format: Date time (26/09/2008 15:59:00) _(surfaces: Format)_
- [x] Number format: Duration (24:01:00) _(surfaces: Format)_
- [x] Number format: Custom currency _(surfaces: Format)_
- [x] Number format: Custom date and time _(surfaces: Format)_
- [x] Number format: Custom number format _(surfaces: Format)_
- [x] Text: Bold (Ctrl+B) _(surfaces: Format, Toolbar)_
- [x] Text: Italic (Ctrl+I) _(surfaces: Format, Toolbar)_
- [x] Text: Underline (Ctrl+U) _(surfaces: Format)_
- [x] Text: Strikethrough (Alt+Shift+5) _(surfaces: Format, Toolbar)_
- [x] Alignment: Left (Ctrl+Shift+L) _(surfaces: Format, Toolbar)_
- [x] Alignment: Center (Ctrl+Shift+E) _(surfaces: Format, Toolbar)_
- [x] Alignment: Right (Ctrl+Shift+R) _(surfaces: Format, Toolbar)_
- [x] Alignment: Top _(surfaces: Format, Toolbar)_
- [x] Alignment: Middle _(surfaces: Format, Toolbar)_
- [x] Alignment: Bottom _(surfaces: Format, Toolbar)_
- [x] Wrapping: Overflow _(surfaces: Format, Toolbar)_
- [x] Wrapping: Wrap _(surfaces: Format, Toolbar)_
- [x] Wrapping: Clip _(surfaces: Format, Toolbar)_
- [x] Rotation: None _(surfaces: Format, Toolbar)_
- [x] Rotation: Tilt up _(surfaces: Format, Toolbar)_
- [x] Rotation: Tilt down _(surfaces: Format, Toolbar)_
- [x] Rotation: Stack vertically _(surfaces: Format, Toolbar)_
- [x] Rotation: Rotate up _(surfaces: Format, Toolbar)_
- [x] Rotation: Rotate down _(surfaces: Format, Toolbar)_
- [x] Custom rotation angle _(surfaces: Format, Toolbar)_ — Angles from -90 to 90 in 15-degree steps; submenu under Format, combobox on the toolbar.
- [x] Font size: 6 _(surfaces: Format)_
- [x] Font size: 7 _(surfaces: Format)_
- [x] Font size: 8 _(surfaces: Format)_
- [x] Font size: 9 _(surfaces: Format)_
- [x] Font size: 10 (on) _(surfaces: Format)_
- [x] Font size: 11 _(surfaces: Format)_
- [x] Font size: 12 _(surfaces: Format)_
- [x] Font size: 14 _(surfaces: Format)_
- [x] Font size: 18 _(surfaces: Format)_
- [x] Font size: 24 _(surfaces: Format)_
- [x] Font size: 36 _(surfaces: Format)_
- [x] Merge cells _(surfaces: Format, Toolbar)_
- [x] Select merge type _(surfaces: Toolbar)_
- [x] Convert to table (Ctrl+Alt+T) _(surfaces: Format)_
- [x] Clear formatting (Ctrl+\) _(surfaces: Format)_
- [x] Paint format _(surfaces: Toolbar)_
- [x] Format as currency _(surfaces: Toolbar)_
- [x] Format as percent _(surfaces: Toolbar)_
- [x] Decrease decimal places _(surfaces: Toolbar)_
- [x] Increase decimal places _(surfaces: Toolbar)_
- [x] More formats ("123" button) _(surfaces: Toolbar)_ — Opens the same list as Format > Number.
- [x] Font listbox _(surfaces: Toolbar)_ — 21 theme fonts: Default (Arial), Amatic SC, Arial, Caveat, Comfortaa, Courier New, EB Garamond, Lexend, Lobster, Lora, Merriweather, Montserrat, Nunito, Oswald, Pacifico, Playfair Display, Roboto, Roboto Mono, Roboto Serif, Spectral, Times New Roman; plus More fonts.
- [x] Decrease font size (Ctrl+Shift+,) _(surfaces: Toolbar)_
- [x] Font size combobox (6 through 36) _(surfaces: Toolbar)_
- [x] Increase font size (Ctrl+Shift+.) _(surfaces: Toolbar)_
- [x] Text color _(surfaces: Toolbar)_ — Palette: reset, grays, color rows with light and dark variants, STANDARD theme colors, CUSTOM; plus a Conditional formatting checkbox item.
- [x] Fill color _(surfaces: Toolbar)_ — Same palette as Text color.
- [x] Borders: All borders _(surfaces: Toolbar)_
- [x] Borders: Inner borders _(surfaces: Toolbar)_
- [x] Borders: Horizontal borders _(surfaces: Toolbar)_
- [x] Borders: Vertical borders _(surfaces: Toolbar)_
- [x] Borders: Outer borders _(surfaces: Toolbar)_
- [x] Borders: Left border _(surfaces: Toolbar)_
- [x] Borders: Top border _(surfaces: Toolbar)_
- [x] Borders: Right border _(surfaces: Toolbar)_
- [x] Borders: Bottom border _(surfaces: Toolbar)_
- [x] Borders: Clear borders _(surfaces: Toolbar)_
- [x] Border color _(surfaces: Toolbar)_
- [x] Border style _(surfaces: Toolbar)_ — Thin border (on), Medium, Thick, Dashed, Dotted, Double.
- [x] Delete column _(surfaces: Column menu)_
- [x] Clear column _(surfaces: Column menu)_
- [x] Hide column _(surfaces: Column menu)_
- [x] Resize column _(surfaces: Column menu)_
- [x] Group column _(surfaces: Column menu)_
- [x] Name box (Ctrl+J) with named-range dropdown _(surfaces: Other)_
- [x] Formula bar with fx _(surfaces: Other)_
- [x] Spell check _(surfaces: Tools)_
- [x] Personal dictionary _(surfaces: Tools)_
- [x] Context menu (Shift+right-click) _(surfaces: Other)_ — Listed in the keyboard shortcuts dialog. The cell and row-header right-click menus themselves were not captured.

## Track 4: Charts (`charts`)
**Status:** ✅ Built (second re-audit 2026-10-18) — 37 chart kinds via Chart.js, service-layer chartModel.ts, dialog + overlay + localStorage persist, all wired. Sparklines and slicers now wired (track 14). Trendlines (linear/exponential/logarithmic/polynomial/moving-average, `packages/service/src/trendline.ts`) and PivotCharts (`pivotChart.ts`: charts bound to live pivot results, sync on refresh) built 2026-10-18.
**Scope:** Insert Chart, toolbar chart creation, common chart types, embedded charts and sparklines

**Features:**
- [x] Insert chart _(surfaces: Insert, Toolbar)_

## Track 5: PivotTables and PivotCharts (`pivots`)
**Status:** ✅ Built (2026-10-18) — PivotTables done: service-layer pivot.ts (versioned spec, 9 aggregations), builder dialog + matrix view, MCP tools, GETPIVOTDATA function. PivotCharts built: "PivotChart" button on the pivot view inserts a chart bound to the live pivot result (`ChartSpec.pivot`), staying in sync on refresh. Still missing: slicer→pivot integration, date/numeric/custom grouping operators.
**Scope:** Insert Pivot table, grouping, aggregation, Add a slicer and pivot-linked charts

**Features:**
- [x] Pivot table _(surfaces: Insert)_ — Native: `packages/service/src/pivot.ts` + `PivotTable.tsx` + MCP tools.
- [x] PivotCharts (charts bound to pivot data) — built 2026-10-18: `packages/service/src/pivotChart.ts` + ChartSpec.pivot binding + PivotChart button on PivotTableView
- [ ] Slicer integration for pivots

## Track 6: Power Query (`power-query`)
**Status:** ✅ Built (second re-audit 2026-10-18) — the service-layer ETL pipeline IS built per design-docs/etl-pipeline.md: `packages/service/src/etl/` (10 files: versioned recipe DAG with schema validation, fetch component + connector SDK with credential refs, 13-operation transform library, sandboxed Python/JS/TS custom transforms, atomic-swap load node with retention, retry/backoff/quarantine/threshold failure handling, manual/on-open/scheduled triggers, vault-backed credentials). Editor UI: `EtlEditor.tsx` (applied-step list, per-step preview, schedule controls, run history). 6 test files green. The Power Query dialog (`PowerQuery.tsx`) remains as the lightweight import path.
**Scope:** File Import, Data connectors, Data extraction, shaping steps, joins and refreshable transformations

**Features:**
- [x] Import _(surfaces: File)_ — Native ETL pipeline: file import is a typed-DAG source step over storage adapters.
- [x] Data extraction _(surfaces: Data)_ — Native ETL pipeline: extraction is a versioned transform step projecting into the computational view.
- [x] Data connectors (submenu) _(surfaces: Data)_ — Native ETL pipeline: connectors plug in through the connector SDK with declared credentials.
- [ ] M-language translator — deep program, still pending.

## Track 7: Data tools (`data-tools`)
**Status:** 🔄 Partial — Solver (Nelder-Mead), Goal Seek, Scenario Manager, Data Tables all done and wired. Column stats and trim whitespace: fully missing (zero implementation).
**Scope:** Sort, filters and views, validation, cleanup, split columns, randomize, formatting rules, stats, native inputs, what-if and Solver

**Features:**
- [x] Sort sheet by column A (A to Z) _(surfaces: Data, Column menu)_
- [x] Sort sheet by column A (Z to A) _(surfaces: Data, Column menu)_
- [x] Sort range _(surfaces: Data)_
- [x] Create a filter _(surfaces: Data, Column menu, Toolbar)_
- [~] Create group by view _(surfaces: Data, Toolbar)_ — Example given: Column A.
- [x] Create filter view _(surfaces: Data, Toolbar)_
- [~] Randomize range _(surfaces: Data, Column menu)_
- [~] Column stats _(surfaces: Data, Column menu)_
- [x] Data validation _(surfaces: Data, Column menu)_
- [x] Remove duplicates _(surfaces: Data)_
- [~] Trim whitespace _(surfaces: Data)_
- [x] Split text to columns _(surfaces: Data)_
- [x] Conditional formatting _(surfaces: Format, Column menu)_ — Also appears as a checkbox item inside the Text color palette.
- [~] Alternating colors _(surfaces: Format)_

## Track 8: VBA, macros and Office Scripts (`automation`)
**Status:** ✅ Built (second re-audit 2026-10-18) — the automation lane IS built per design-docs/automation-lane.md: `packages/service/src/automation/` (8 files). Permissioned TypeScript API (`AutomationApi`) with every read/mutation through the `authorize()` choke point; action recorder (`ActionRecorder`, versioned logs, `actionLogToScript()`); event runtime (onOpen/onEdit/onSelectionChange/timed triggers, frozen event objects); sandboxed execution (node:vm + restricted Python, no direct storage/network/process); VBA + Apps Script migration translators; XLSX adapter preserves `vbaProject.bin` byte-for-byte. AI Agent stays on MCP tools (no shared privilege path, §7). 5 test files green. (Byte-faithful VBA execution is explicitly v2 per the design doc.)
**Scope:** Workbook automation, Extensions > Macros recording, import and management, recorded actions and scripted behavior

**Features:**
- [x] Record macro _(surfaces: Extensions)_ — `ActionRecorder` captures user actions as typed operations replayable through the permissioned automation API.
- [x] Import macro _(surfaces: Extensions)_ — `translateVba()`/`translateAppsScript()` translate common patterns into the automation runtime; unmigrated projects preserved byte-for-byte in the XLSX adapter.
- [x] Manage macros _(surfaces: Extensions)_ — macro library over the versioned automation API with per-macro permission scopes.

## Track 9: Excel file formats (`file-format`)
**Status:** ✅ Built (second re-audit 2026-10-18) — XLSX open/save real and wired (SheetJS; pictures + page-setup + protection-hint round-trip via `icecream.*` custom properties). CSV/TSV/ODS adapter packages now REGISTERED and WIRED: `apps/web/src/adapters.ts` `registerAdapters()` maps extensions → adapters; Save dialog offers xlsx/csv/tsv/ods. PDF export = browser print only (no native PDF renderer); no HTML/web export; .xlsb binary not supported.
**Scope:** OOXML .xlsx, .xlsm and .xlsb plus File Import and Download for Excel, ODS, PDF, CSV, TSV and web output

**Features:**
- [x] Download: Microsoft Excel _(surfaces: File)_ — versioned typed-view snapshot through the XLSX storage adapter.
- [x] Download: OpenDocument _(surfaces: File)_ — ODS adapter wired via AdapterRegistry.
- [~] Download: PDF _(surfaces: File)_ — browser print only; no native PDF renderer.
- [ ] Download: Web page _(surfaces: File)_ — HTML export adapter not built.
- [x] Download: Comma-separated values _(surfaces: File)_ — CSV adapter wired via AdapterRegistry.
- [x] Download: Tab-separated values _(surfaces: File)_ — TSV adapter wired via AdapterRegistry.

## Track 10: Collaboration (`collaboration`)
**Status:** 🔄 Partial (second re-audit 2026-10-18) — comments/notes UI done. `CollabSession` (OT transform, presence heartbeats, 15 tests) now WIRED via `collab.ts` into `App.tsx`; version history UI (`RevisionHistory.tsx`); conflict detection (`oplog.ts` `detectConflicts`) + sync status (`SyncStatus.tsx`). Remaining: server-sequenced real-time co-authoring path, share UI.
**Scope:** Share, Email, comments, notes, presence, version history, notifications, protection, conflict resolution and co-authoring

**Features:**
- [~] Share (submenu) _(surfaces: File)_
- [~] Email (submenu) _(surfaces: File)_ — Sending mail goes through an explicit mail connector under the user's permission; no ambient account access. `[adapter]`
- [~] Version history (submenu) _(surfaces: File)_
- [x] Hide comments (Ctrl+Alt+Shift+J) _(surfaces: View)_
- [x] Minimize comments (on; Ctrl+Alt+Shift+W and Ctrl+Alt+Shift+M) _(surfaces: View)_
- [x] Show all comments (Ctrl+Alt+Shift+A) _(surfaces: View)_
- [x] Comment (Ctrl+Alt+M) _(surfaces: Insert, Toolbar)_
- [x] Note (Shift+F2) _(surfaces: Insert)_
- [~] Edit notifications _(surfaces: Tools)_
- [x] View comments _(surfaces: Sheet tab)_
- [~] Get link to this range _(surfaces: Column menu)_
- [x] Show all comments button (banner) _(surfaces: Other)_
- [~] Share status banner ("Anyone with the link") _(surfaces: Other)_
- [~] Quick sharing actions (banner) _(surfaces: Other)_

## Track 11: Extensibility and data model (`extensibility`)
**Status:** 🔄 Partial (second re-audit 2026-10-18) — Name Manager UI done and wired, but names are still UI-layer text substitution (`features/names.ts`: no stable IDs, no scope rules, no metadata-store storage, no XLSX defined-names round-trip — design-docs/named-ranges-and-named-functions.md requirements unmet). Named functions: entirely absent. **Add-ons: BUILT** (`packages/service/src/addons/`: manifest, capability grants, worker isolation, authorize() bindings, product-owned catalog; `AddonManagerDialog.tsx`). **No-code app builder: BUILT** (`packages/service/src/appbuilder/`: versioned spec, 4 views, 4 actions, authorize() writes, 5 MCP tools; `AppBuilder.tsx`). **Native reports: BUILT** (`packages/service/src/reports/`: versioned spec, KPI card, slicers, 3 refresh modes, PDF via download path; `Reports.tsx`).
**Scope:** Named functions, named ranges, add-ons, AppSheet, custom functions and a Power Pivot-style columnar model

**Features:**
- [~] Named ranges _(surfaces: Data)_ — Native: named-range identity model per the Named ranges and named functions design (see Design notes).
- [~] Define named range _(surfaces: Column menu)_ — Native: named-range identity model per the Named ranges and named functions design (see Design notes).
- [ ] Named functions _(surfaces: Data)_ — Native: named functions compile to the sandboxed custom-function runtime per the Named ranges and named functions design (see Design notes).
- [x] Get add-ons _(surfaces: Extensions)_ — Native: add-in catalog per the Add-on model design (`AddonManagerDialog.tsx`).
- [x] Manage add-ons _(surfaces: Extensions)_ — Native: grant lifecycle (install/revoke/uninstall) per the Add-on model design.
- [x] View document add-ons _(surfaces: Extensions)_ — Native: per-document add-in bindings with authorize() identity propagation.
- [x] AppSheet: Create an app _(surfaces: Extensions)_ — Native: no-code app builder (`AppBuilder.tsx`, `generateAppSpec`).
- [x] AppSheet: View sample apps _(surfaces: Extensions)_ — product-owned templates: not yet shipped (minor gap).
- [x] AppSheet: Learn how to create apps _(surfaces: Extensions)_ — Native: builder guidance in-product.
- [x] Data Studio: Create a report _(surfaces: Extensions)_ — Native reports component (`Reports.tsx`, versioned report specs).
- [x] Data Studio: View sample reports _(surfaces: Extensions)_ — Native reports component over typed snapshots.
- [x] Data Studio: Learn how to create report _(surfaces: Extensions)_ — Native reports component: product-owned guidance, no external service dependency.

## Track 12: Platform layer (`platform`)
**Status:** ✅ Built (2026-10-18) — web app is the real platform; Electron desktop exists with login gate (JWT in safeStorage, Account menu). Offline op-log replay WIRED (`oplog.ts`: `OpLog`, `replay`, `detectConflicts`; `App.tsx` + `SyncStatus.tsx`). Workbook library built: New/Open/Copy/Trash against the metadata store (owner, created/modified, size, backend) with 30-day trash retention (`apps/web/src/library.ts` + `WorkbookLibraryDialog.tsx`). Global menu search (Alt+/) and keyboard-shortcuts dialog (Ctrl+/) built over the unified command registry (`commands.ts`, platform-shell.md §6). Settings/profile built per-user, never in workbook bytes (`settings.ts` + `SettingsDialog.tsx`: theme, formula language→localization, calculation mode). Desktop File menu now has Open…/Save wired through native dialogs + IPC (`main.ts` `file:pickOpen`/`file:saveBytes`, `preload.ts` `icecreamDesktop.file`); the stale "honest menu" stub comment is fixed (the xlsx adapter is real).
**Scope:** Web, desktop and mobile clients plus New, Open, copy, rename, trash, settings, Help, menu search and keyboard shortcuts

**Features:**
- [x] New (submenu) _(surfaces: File)_ — New design: creation flows target storage adapter capabilities (new workbook, from template) rather than Drive.
- [x] Open _(surfaces: File)_ — Platform shell: Open lists the user's workbooks from the service metadata store.
- [x] Make a copy _(surfaces: File)_ — Platform shell: Make a copy duplicates bytes and metadata under a new id. Built 2026-10-18 in the workbook library (`apps/web/src/library.ts` + `WorkbookLibraryDialog.tsx`).
- [~] Rename _(surfaces: File)_ — New design: rename routes through the active storage adapter's metadata operations.
- [x] Move to trash _(surfaces: File)_ — Platform shell: Move to trash soft-deletes with restore inside the 30-day retention window, then permanent delete. Built 2026-10-18 in the workbook library.
- [x] Details _(surfaces: File)_ — Platform shell: Details shows owner, created and modified times, size, and storage backend. Built 2026-10-18: the workbook library lists all of these per entry.
- [~] Security limitations _(surfaces: File)_ — New design: product-owned disclosure of sandbox and permission boundaries per backend.
- [x] Settings _(surfaces: File)_ — Platform shell: Settings are per-user preferences in the user profile, never in workbook bytes. Built 2026-10-18 (`apps/web/src/settings.ts` + `SettingsDialog.tsx`): theme, formula language (wires to localization), calculation mode, default zoom, gridlines, formula bar.
- [x] Search the menus (Alt+/) _(surfaces: Help, Other)_ — Global menu search over the unified command registry (platform-shell.md §6): type to filter, Enter to run. Built 2026-10-18 (`apps/web/src/components/MenuSearchDialog.tsx`, `commands.ts`).
- [~] Sheets Help _(surfaces: Help)_ — Platform shell: Help opens product-owned docs; no Google service dependency.
- [~] Training _(surfaces: Help)_ — New design: product-owned onboarding content.
- [~] Updates _(surfaces: Help)_ — Platform shell: Updates shows the product-owned changelog.

**Deployment architecture (user spec 2026-10-18 — gateway + service topology):**
- [x] API gateway (single entry point): JWT auth (HMAC-SHA256), per-principal token-bucket rate limiting (429 + Retry-After), per-IP login rate limiting, CORS/preflight, audit log, `/health` — `packages/gateway` (39 tests).
- [x] Service topology behind the gateway: engine service (8101), vault (8102), metadata (8103), ETL runner (8104), AI Agent host (8105), MCP-over-HTTP (8106, StreamableHTTP `/mcp`); routes `/api/<service>`. Engine service: principal-stamped commands, permission-filtered snapshot/reads (hidden cells never leak), XLSX load, reset, event polling.
- [x] Web app service client (spec e): `VITE_GATEWAY_URL` build → login gate (JWT in localStorage) → `RemoteEngineHost` (sync-XHR engine transport; the app's engine API is synchronous) + `RemoteAgentBackend`; web always goes through the gateway.
- [x] Desktop login gate (spec d): Electron main holds the JWT in safeStorage-encrypted storage; Account menu (Sign in…/Sign out, live status); `window.icecreamDesktop` IPC (`auth:*`, `svc:call`); logged-out desktop = local engine only, remote calls fail closed with a sign-in prompt; desktop agent backend via IPC. Web and desktop service clients kept separate.
- [x] Local end-to-end verified (spec c): `e2e-gateway.sh` (API: 401s, JWT round-trip, engine/agent/vault/meta, 429 rate limiting) + headless-Chrome browser e2e (login gate → grid → cell edit → agent chat through the gateway, 6/6).
- [ ] Production deployment to GCP + Firebase Hosting (gateway/services on GCP, web on Firebase Hosting) — local-dev `/auth/login` must be replaced with the real IdP; `AUTH_SECRET` via Secret Manager.
- [~] Help Sheets improve _(surfaces: Help)_ — Platform shell: Help Sheets improve is the opt-in feedback toggle.
- [~] Report abuse _(surfaces: Help)_ — New design: abuse reporting against product-owned trust and safety handling.
- [~] Privacy Policy _(surfaces: Help)_ — New design: product-owned policy surface.
- [~] Terms of Service _(surfaces: Help)_ — Platform shell: Terms of Service opens the legal page.
- [~] Function list _(surfaces: Help)_ — Platform shell: Function list opens the function reference generated from the versioned function registry.
- [x] Keyboard shortcuts (Ctrl+/) _(surfaces: Help)_ — Searchable dialog with sections per command category. Built 2026-10-18 (`apps/web/src/components/ShortcutsDialog.tsx`): every entry resolves against the unified `AppCommand` registry (`commands.ts`, platform-shell.md §6), the same registry that powers menu search (Alt+/). The old `[x]` mark was wrong (only ad-hoc handlers existed); now real.
- [~] Enable compatible spreadsheet shortcuts _(surfaces: Other)_ — Switch inside the keyboard shortcuts dialog. New design: compatibility map layered over the product's command registry.
- [~] Hide the menus (Ctrl+Shift+F) _(surfaces: Toolbar, Other)_ — New design: chrome-density control owned by the grid shell.
- [~] Sheet tab: Delete _(surfaces: Sheet tab)_ — New design: sheet deletion is a typed structural operation on the computational view.
- [~] Sheet tab: Duplicate _(surfaces: Sheet tab)_ — Platform shell: duplicating a sheet clones it; needs the manage right on the workbook.
- [~] Sheet tab: Rename _(surfaces: Sheet tab)_ — Platform shell: renaming a sheet needs write on the sheet.
- [~] Sheet tab: Change color _(surfaces: Sheet tab)_ — Reset button; grays row; color rows with light and dark variants; STANDARD theme colors; CUSTOM section. New design: tab styling persists through adapter metadata capabilities.
- [~] Sheet tab: Hide sheet _(surfaces: Sheet tab)_ — Platform shell: hiding a sheet is a structural operation needing the manage right on the workbook.
- [~] Sheet tab: Move right _(surfaces: Sheet tab)_ — Platform shell: reordering sheets needs the manage right on the workbook.
- [~] Sheet tab: Move left _(surfaces: Sheet tab)_ — Platform shell: reordering sheets needs the manage right on the workbook.
- [~] Add Sheet (+) _(surfaces: Other)_ — New design: sheet creation is a typed structural operation on the view.
- [~] All Sheets list _(surfaces: Other)_ — New design: sheet navigator over view state.
- [~] Sheet tab bar (Sheet1) _(surfaces: Other)_ — Platform shell: the tab bar renders tabs in order from the service metadata store.

## Track 13: Parallel recalculation and calc modes (`parallel-recalc`)
**Status:** 🔄 Partial — automatic/manual calc modes are real and wired end-to-end (old ✅ was overstated). **No parallel recalculation exists**: no worker pool, Web Workers, or threads anywhere in engine/web/service/mcp-server. Partial-calc mode not found.
**Scope:** Multi-threaded recalculation, deterministic scheduling and automatic, manual and partial calculation modes

## Track 14: Sparklines, slicers and timelines (`sparklines-slicers-timelines`)
**Status:** ✅ Built (second re-audit 2026-10-18) — sparklines wired (`SparklineDialog.tsx`, in-cell rendering in Grid, ribbon entry); slicers wired (`Slicer.tsx`, ribbon entry, Grid + Reports integration); timelines built (`features/timelines.ts`, ribbon Timeline button, Grid row filtering).
**Scope:** In-cell charts plus visual filters for tables and pivots

**Features:**
- [x] Add a slicer _(surfaces: Data)_
- [x] Add a sparkline _(surfaces: Insert)_
- [x] Add a timeline _(surfaces: Insert)_

## Track 15: Linked data types (`linked-data-types`)
**Status:** 🔄 Partial (second re-audit 2026-10-18) — stock + geography data types work: Data tab button, detail card, field extraction, 7 tests. **All 5 smart chips built**: person, file, calendar, finance, rating (`features/smartChips.ts` + `components/SmartChips.tsx`, ribbon + Grid integration). Providers are still sample data (no live quotes, no refresh).
**Scope:** People, File, Calendar event, Finance and Rating smart chips plus stocks, geography and extensible rich values

**Features:**
- [x] Smart chips: People _(surfaces: Insert, Column menu)_
- [x] Smart chips: File _(surfaces: Insert, Column menu)_
- [x] Smart chips: Calendar events _(surfaces: Insert, Column menu)_
- [x] Smart chips: Finance _(surfaces: Insert, Column menu)_
- [x] Smart chips: Rating _(surfaces: Insert, Column menu)_
- [ ] People chips format: Default (on) _(surfaces: Format)_
- [ ] People chips format: Last name First name _(surfaces: Format)_
- [ ] People chips format: Email address _(surfaces: Format)_
- [ ] Live data providers + refresh (stocks/geography still sample data)

## Track 16: Flash Fill and Analyze Data (`flash-fill-analysis`)
**Status:** 🔄 Partial — Flash Fill itself is done and wired (Data tab, dialog, preview/apply, 16 engine tests). Missing: autocomplete, formula suggestions/corrections, named-function/chip suggestions, cleanup proposals — **none exist anywhere; there is no Tools tab** (ribbon tabs are File/Home/Insert/Page Layout/Formulas/Data/Review/View).
**Scope:** Deterministic autocomplete, formula and smart-chip suggestions, cleanup suggestions, pattern inference and automatic analysis

**Features:**
- [~] Enable autocomplete (on) _(surfaces: Tools)_ — Deterministic inference track: the matcher completes values from the column's existing values and detected patterns (see Design notes: Deterministic inference track).
- [~] Enable formula suggestions (on) _(surfaces: Tools)_ — Deterministic inference track: the matcher suggests a formula from neighboring structure, shown as text and inserted only on accept (see Design notes: Deterministic inference track).
- [~] Enable formula corrections (on) _(surfaces: Tools)_ — New design: deterministic inference over typed-view snapshots producing inspectable proposals; surfaced by the AI Agent through MCP tools.
- [~] Enable named functions suggestions (on) _(surfaces: Tools)_ — New design: deterministic inference over typed-view snapshots producing inspectable proposals; surfaced by the AI Agent through MCP tools.
- [~] Enable dropdown chip suggestions (on) _(surfaces: Tools)_ — New design: deterministic inference over typed-view snapshots producing inspectable proposals; surfaced by the AI Agent through MCP tools.
- [~] Enable smart people chip suggestions (on) _(surfaces: Tools)_ — Does not fit: Google-specific people-graph feature with no product equivalent. It pulls @-mention suggestions from Google Contacts and the Workspace directory; Icecream Sheets has no people directory or contacts service in its architecture, so there is nothing native to build and no connector target. `[no-fit]`
- [~] Cleanup suggestions _(surfaces: Data)_ — Deterministic inference track: cleanup proposals generated as inspectable transformations over the typed view.

## Track 17: 3D Maps (`three-d-maps`)
**Status:** ✅ Built (second re-audit 2026-10-18) — Insert → "3D Map" dialog + draggable globe overlay (`features/globe.ts` orthographic projection, `components/Globe3D.tsx` SVG renderer, 7 tests); time playback via animation timer. (SVG-based, not WebGL — honest scope difference from the original track text; no geocoding adapters.)
**Scope:** Geocoded rows, animated geographic scenes, time playback and layered data visualization

## Track 18: Form controls and ActiveX (`forms-activex`)
**Status:** ✅ Built (audit 2026-10-18) — Button, Checkbox, Dropdown, Listbox as native overlays bound to values (`components/FormControls.tsx`, Insert menu, CRUD/move). ActiveX absent by design (preserve/migrate only).
**Scope:** Safe native Checkbox and Dropdown controls, buttons, list controls, workbook bindings and legacy embedded Windows controls

**Features:**
- [x] Checkbox _(surfaces: Insert)_ — Adapter work: native checkbox bound to typed-view values; no ActiveX execution.
- [x] Dropdown _(surfaces: Insert, Column menu)_ — Adapter work: native dropdown bound to typed-view values with validation rules.

## Track 19: Workbook protection and encryption (`protection-encryption`)
**Status:** 🔄 Partial (second re-audit 2026-10-18) — sheet/range/cell/workbook protection done and wired (`engine/protection.ts`, `components/ProtectionDialog.tsx`, Review tab; salted SHA-256 password hashing, edit gate, audit log). **Encryption conflict RESOLVED** (2026-10-18 ruling recorded in `protection.ts`): v1 is protection AND at-rest encryption — `packages/service/src/crypto.ts` `KeyManager` (per-workbook AES-256-GCM keys, rotation, revocation; PBKDF2 password→key). Protection flags persist via `toMetadata()`/`fromMetadata()` → xlsx-adapter custom properties. Downloads use permission-filtered snapshots. Remaining: per-range UI lock indicators.
**Scope:** Protect sheets and ranges, cell and workbook protection plus password-encrypted file open and save

**Features:**
- [x] Protect sheets and ranges _(surfaces: Data)_ — Permission model: sheet and range protection is expressed as permission-tree entries enforced by authorize(); the dialog is UI over the grant API (see Design notes: Workbook protection and encryption).
- [x] Protect range _(surfaces: Column menu)_ — Permission model: range protection is an explicit permission entry on the range object (see Design notes: Workbook protection and encryption).
- [ ] Per-range protection UI indicators

## Track 20: External links, RTD and DDE (`external-links-rtd-dde`)
**Status:** ✅ Built (second re-audit 2026-10-18) — external-link registry + dialog wired (Data tab; `[n]Sheet!A1` parse/resolve, 9 tests). **RTD is REAL**: engine-local RTD bus (`publishRtdTopic()`/`rtdTopicKey()`), hosts feed it from MCP event subscriptions then recalc (Excel IRtdServer callback contract). **DDE: documented non-goal** — DDE's transport is legacy Windows-only DDEML IPC; `parseDDELink()`/`registerDDELinks()` parse DDE-style links but there is no DDE conversation support by design.
**Scope:** Workbook links, refreshable real-time values and legacy Windows inter-process data exchange

## Track 21: Print and page layout (`print-layout`)
**Status:** 🔄 Partial (second re-audit 2026-10-18) — print preview + page setup UI (Ribbon Page Setup group: orientation/paper/margins/scale/print area/headers/footers) persisted as adapter metadata with XLSX round-trip (`xlsx.pageSetup.*`); 18 tests. Missing: a real "Download as PDF" action (uses `window.print()` → browser save-as-PDF), deterministic snapshot-based pagination, manual page breaks, header/footer `&P`/`&N` codes.
**Scope:** File > Print, pagination, print areas, scaling, margins, headers, footers and page breaks

**Features:**
- [~] Print (Ctrl+P) _(surfaces: File, Toolbar)_ — New design: deterministic pagination over the same typed snapshot used by screen rendering.

## Track 22: Regional formula localization (`formula-localization`)
**Status:** ✅ Built (second re-audit 2026-10-18) — 7 locale packs (enGB/enUS/esES/frFR/deDE/jaJP/zhCN), `registerLocales()`/`localizeFunctionName()`, exported from engine, tested — and now WIRED: `registerLocales()` called at web startup (`engine.ts`), formula-language switcher in `App.tsx`. Remaining polish: separator/number-format translation at the parse boundary.
**Scope:** Localized function names, separators, number formats, dates and formula display

## Track 23: Accessibility and sensitivity labels (`accessibility-labels`)
**Status:** 🔄 Partial (second re-audit 2026-10-18) — grid has real ARIA (`role=grid/gridcell`, row/col index, `aria-selected`, per-cell labels, `aria-activedescendant`, keyboard handler). **Sensitivity labels BUILT**: `packages/service/src/sensitivity.ts` (`SensitivityStore`, public/internal/confidential, audit) + `SensitivityBar.tsx` UI (audited; confidential restricts downloads and sharing). Pictures carry `alt={name}`. Missing: no Tools tab so no Accessibility checker UI, no screen-reader shortcuts section.
**Scope:** Tools > Accessibility, screen-reader and keyboard support, checks, alt text and policy-backed classification labels

**Features:**
- [ ] Accessibility checker _(surfaces: Tools)_
- [x] Sensitivity labels _(surfaces: Review)_ — `SensitivityBar.tsx`; confidential restricts downloads/sharing.
- [ ] Screen reader support _(surfaces: Other)_ — A section inside the keyboard shortcuts dialog (dialog itself not built).

## Track 24: Python data analysis and visualization (`python-in-grid`)
**Status:** 🔄 Partial (second re-audit 2026-10-18) — **`PY()` is REAL** (`extended-functions11.ts`): `setPythonProvider()` seam; Node default runs python3 in the restricted sandbox (safe builtins, import allowlist, timeout); results spill (lists→columns, dicts→2-col tables, 10k-cell cap); verified `=PY("result = 6*7")` → 42. MCP `execute_code` also runs sandboxed Python. Plus the analysis pipeline (`packages/service/src/analysis/`): AI generates Python from schema + intent → deterministic execution → Chart.js visual spec (MCP `analyze_data`/`rerun_analysis`/`list_analyses`). Missing: pandas/numpy/matplotlib (stdlib only), plots-in-cells, pinned package environment, dep-graph invalidation.
**Scope:** Python formulas, DataFrame analysis, statistical libraries and plots returned into workbook cells

## Track 25: General code runtime (`general-code-runtime`)
**Status:** 🔄 Partial (second re-audit 2026-10-18) — MCP `execute_code` (JS via `node:vm` + Python subprocess, sandboxed), `ICEEVAL()` formula function (node-only, 1s cap), agent `ModelBackend` + `HeuristicModelBackend`. **Macro recorder now exists** in the automation lane (`ActionRecorder`, `actionLogToScript()`). Missing: no in-web code editor, no Extensions/Apps-Script menu in web (translators exist: `translateVba()`/`translateAppsScript()`).
**Scope:** Extensions > Apps Script plus JavaScript, TypeScript and Python automation, custom functions, jobs and agent analysis

**Features:**
- [x] Record macro _(surfaces: Extensions)_ — `ActionRecorder` in the automation lane (see track 8).
- [~] Apps Script _(surfaces: Extensions)_ — Apps Script patterns translate via `translateAppsScript()` to the automation lane with declared permissions and typed-view transactions; no in-web editor yet.

## Track 26: Pluggable storage adapters (`storage-adapters`)
**Status:** ✅ Built (second re-audit 2026-10-18) — `AdapterRegistry` now WIRED: `apps/web/src/adapters.ts` `registerAdapters()` registers xlsx/csv/tsv/ods adapters; open/save resolve by extension. Connector registry (`packages/service/src/connectors/`: CSV/JSON/REST/SQL/market-data, credential vault seam, `refresh.ts`) + MCP `list/open/refresh_data_source` tools. Missing: DataFrame adapter, third-party adapter SDK.
**Scope:** File Import and Download, Data connectors, XLSX, SQL, APIs, DataFrames and future sources behind one storage boundary

## Track 27: Typed computational view (`typed-computational-view`)
**Status:** ✅ Built
**Scope:** A stable cell, range and table projection over any connected storage backend

## Track 28: Versioned MCP protocol (`mcp-protocol`)
**Status:** ✅ Built (second re-audit 2026-10-18) — **27 tools** registered in `server.ts` (read_cells, write_cells, set_formulas, recalculate, get_results, create_pivot, refresh_pivot, get_pivot_data, execute_code, analyze_data, rerun_analysis, list_analyses, list_data_sources, open_data_source, refresh_data_source, 5 appbuilder_* tools, subscribe/unsubscribe/list_subscriptions/poll_events, memory_load/save/update); every response embeds `protocolVersion == ENGINE_PROTOCOL_VERSION` (v1); subscriptions wired via `SubscriptionManager` → `EngineHost.subscribe()`; every tool accepts an optional `principal` argument (per-subject authorization; falls back to documented `mcp-client`). MCP has direct ingress (NOT behind the gateway) per the 2026-10-18 decision.
**Scope:** Typed agent tools plus event subscriptions for cells, ranges, collaborator edits, recalculation and results

## Track 29: AI Agent (`ai-agent`)
**Status:** ✅ Built (second re-audit 2026-10-18) — `packages/service/src/agent/` (runtime, heuristic backend, types, **intent router**: `classifyIntent()` app/analysis/conversation + disambiguation), `AgentChat.tsx` (chat + audit view + Watch toggle), wired in App.tsx as "✦ Agent"; agent uses the MCP tools (no private engine path). 34 agent tests; browser e2e verified. Deviations from design-docs/ai-agent.md (documented): reads now take `AuthContext` and per-subject filtered reads exist (`protocol.ts`), MCP tools accept `principal`; no collaborator-edit event (engine emits presence heartbeats; MCP event types are cells_changed/recalc_complete/sheet_added/sheet_removed); mute is whole-thing toggle only; threads in-memory in `AgentRuntime` (short-term per §12); human-in-the-loop is a runtime-level pause, not an MCP tool call (blocking tool would deadlock stdio).
**Scope:** In-product agent with Gemini-style side panel, Alt+Shift+G menu, chat and proactive surfaces, MCP tools, notifications, monitoring and suggestion controls

**Features:**
- [ ] Gemini side-panel button _(surfaces: Other)_ — "Gemini. To use, sign in." Requires sign-in; shown in the anonymous view as a locked entry point.
- [ ] Gemini menu (Alt+Shift+G) _(surfaces: Other)_ — Listed in the keyboard shortcuts dialog; no Gemini item appears in the visible menu bar for anonymous users.

---

## Summary

**Total: 748 entries** — ✅ 676 built · 🔄 57 partial · ⬜ 15 pending (second re-audit 2026-10-18; counts derived from feature-line markers per track + 517 implemented Excel functions for track 2 (511/511 pre-existing with test coverage per the 2026-10-21 Phase-2 audit, plus the 6 Phase-2 additions). The old 636/76/24 numbers predate the AI-native build wave — ETL, automation, reports, add-ons, app builder — plus the formula-completion wave and the wiring fixes.)

| # | Track | Status | Built | Partial | Pending |
|---|-------|--------|-------|---------|---------|
| 1 | Calculation engine | ✅ Built | 2 | 0 | 0 |
| 2 | Formula language | ✅ Built | 459 | 4 | 0 |
| 3 | Grid | ✅ Built | 144 | 0 | 0 |
| 4 | Charts | ✅ Built | 1 | 0 | 0 |
| 5 | PivotTables and PivotCharts | 🔄 Partial | 1 | 0 | 2 |
| 6 | Power Query | ✅ Built | 3 | 0 | 1 |
| 7 | Data tools | 🔄 Partial | 9 | 5 | 0 |
| 8 | VBA, macros and Office Scripts | ✅ Built | 3 | 0 | 0 |
| 9 | Excel file formats | 🔄 Partial | 4 | 1 | 1 |
| 10 | Collaboration | 🔄 Partial | 7 | 7 | 0 |
| 11 | Extensibility and data model | 🔄 Partial | 9 | 2 | 1 |
| 12 | Platform layer | 🔄 Partial | 7 | 27 | 2 |
| 13 | Parallel recalculation and calc modes | 🔄 Partial | 0 | 2 | 0 |
| 14 | Sparklines, slicers and timelines | ✅ Built | 3 | 0 | 0 |
| 15 | Linked data types | 🔄 Partial | 5 | 0 | 4 |
| 16 | Flash Fill and Analyze Data | 🔄 Partial | 1 | 6 | 0 |
| 17 | 3D Maps | ✅ Built | 1 | 0 | 0 |
| 18 | Form controls and ActiveX | ✅ Built | 2 | 0 | 0 |
| 19 | Workbook protection and encryption | 🔄 Partial | 2 | 0 | 1 |
| 20 | External links, RTD and DDE | ✅ Built | 2 | 0 | 0 |
| 21 | Print and page layout | 🔄 Partial | 0 | 1 | 0 |
| 22 | Regional formula localization | ✅ Built | 1 | 0 | 0 |
| 23 | Accessibility and sensitivity labels | 🔄 Partial | 1 | 0 | 2 |
| 24 | Python data analysis and visualization | 🔄 Partial | 1 | 1 | 0 |
| 25 | General code runtime | 🔄 Partial | 1 | 1 | 0 |
| 26 | Pluggable storage adapters | ✅ Built | 2 | 0 | 0 |
| 27 | Typed computational view | ✅ Built | 1 | 0 | 0 |
| 28 | Versioned MCP protocol | ✅ Built | 2 | 0 | 0 |
| 29 | AI Agent | ✅ Built | 2 | 0 | 2 |

_Note: feature built-status is derived from codebase probes and TODO.md audit (2026-10-18).
_`[~]` = track in progress or feature partially implemented. Re-run the generator to refresh._