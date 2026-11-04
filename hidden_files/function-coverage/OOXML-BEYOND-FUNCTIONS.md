# OOXML Beyond Worksheet Functions — Excel-Parity Audit

**Date:** 2026-10-21 · **Scope:** every OOXML / [MS-XLSX] Excel capability *other than
worksheet functions* (function coverage lives in `FUNCTION-LIST-AND-GAPS.md` in this folder).
**Method:** spec first (ISO/IEC 29500-1:2012 Part 1 §18 SpreadsheetML + DrawingML/ChartML,
and [MS-XLSX] v20250520 for the `x14`/`x15`/`xr`/threaded-comment extension namespaces),
then **every claim verified by grep/read against the code on disk** —
`packages/xlsx-adapter/src` (parse/serialize), `packages/engine/src`,
`packages/service/src`, `apps/web/src/features` + `apps/web/src` (UI/runtime).
FEATURES.md / TODO.md / DESIGN-AUDIT.md claims were cross-checked but **code wins**;
several doc claims do not survive that check (see §2.3).

---

## 1. Summary

### 1.1 Counts by verdict (54 entries)

| Verdict | Count | Meaning |
|---|---|---|
| **HAVE** | 5 | Parses natively, works/renders in the app, and round-trips to native OOXML on save |
| **PARTIAL** | 34 | Some real layer exists — app-native model, import-only, or preservation-only — with a named missing piece |
| **MISSING-BUILD-CANDIDATE** | 10 | No parse, no render, no native write; a real Excel feature worth building |
| **NOT-APPLICABLE** | 5 | Deliberate non-goal / deprecated by Microsoft / superseded by the product's own architecture |
| **Total** | **54** | |

### 1.2 The one fact that explains most PARTIALs — there are two save paths

Verified in `packages/service/src/save/directSave.ts` (header) and
`packages/xlsx-adapter/src/streamingSave.ts` (header) vs `packages/xlsx-adapter/src/adapter.ts:274`
(`preservesUnknownParts: false`):

* **Server/direct save (the production path):** *verbatim* streaming. Untouched parts are copied
  byte-for-byte; a changed sheet is regenerated **inside its source head/tail**
  (`streamingSave.ts:sheetXmlChunks` — everything before `<sheetData>` and after `</sheetData>`
  is the source's bytes). So on this path, almost any worksheet-level part the app does not
  understand — `<conditionalFormatting>`, `<dataValidations>`, `<hyperlinks>`, `<mergeCells>`,
  `<sheetViews>`, slicer/drawing/media/customXml parts — **survives a save untouched, but is
  never read, rendered, or editable, and app-created equivalents are never written natively.**
* **Classic in-tab / fallback save (`XlsxAdapter.write`, SheetJS CE rebuild):** the package is
  rebuilt from SheetJS's model. Only the families the adapter explicitly re-injects survive:
  defined names, page setup/breaks, protection, cell styles, external links, macro project,
  and the **raw bytes** of pivot and SmartArt parts. Everything else native is **dropped**.
  App features instead persist as `icecream.*` keys in `docProps/custom.xml`
  (`adapter.ts:702ff`; `apps/web/src/App.tsx:applyClientSaveMetadata` ~L6277) — readable only
  by icecream-sheets, invisible to Excel.
* `applyClientSaveMetadata` (App.tsx) is the authoritative list of what a save carries. It
  attaches: pictures, data-type metadata, page setup/print titles, page breaks, header/footer
  settings, theme, ink, drawing canvases, external links, raw pivot/SmartArt parts, chart specs.
  It does **not** attach conditional-formatting rules, data validations, comments, notes,
  hyperlinks, merges, slicers, sparklines, timelines, form controls, groups, or backgrounds —
  those are session/React state only and are lost on *any* save → reopen, in either path,
  unless the verbatim path happens to preserve the *original file's* version of them.

**Reading rule for every verdict below:** "preserves on round-trip" means *only* the verbatim
server path (and only for content the app didn't need to regenerate); "renders/works" means
the web app; "native write" means the file Excel receives contains the real OOXML part.

### 1.3 Ranked High-importance PARTIAL / MISSING gaps (the build tasking)

| # | Gap | Verdict | Why it ranks here |
|---|---|---|---|
| 1 | **Conditional formatting: no native import or export** (§5.1) | PARTIAL | CF is in a large share of real business files. Imported rules never render (adapter never parses `<conditionalFormatting>`); app-created rules never reach Excel. Only the verbatim save keeps the original file's rules — still invisible in-app. |
| 2 | **Data validation: no native import or export; app model is list-only, single-cell** (§6.1) | PARTIAL | Dropdown/whole/date/custom validations silently vanish on open; a file that relies on DV for data integrity opens unguarded. |
| 3 | **Threaded comments + person records: absent** (§3.2) | MISSING | The default comment form in every Excel file saved since ~2019. Modern review threads open as *nothing* (legacy comments are a different part). |
| 4 | **Merge cells: not imported into the app model** (§14.3) | PARTIAL | `SheetData` has no merges field; imported merged titles/headers render unmerged. App merges are session-only. |
| 5 | **AutoFilter / sortState: not imported** (§14.4) | PARTIAL | Files saved with a filter applied open showing all rows, unfiltered and unsorted-by-state; the app's own filter is a separate session model. |
| 6 | **`_xlfn` serialization on write** (§9.4) | PARTIAL | Import strips *all* `_xlfn.` prefixes (`fastSheetParse.ts:685`); write emits bare names and never re-adds `_xlfn.`/`_xlpm.` — post-2007 functions and LAMBDA defined names are written in a form Excel did not produce and stricter readers can reject. |
| 7 | **Slicers / timeline slicers: no native import or export** (§4.1–4.2) | PARTIAL | Dashboard files' primary interaction surface. App slicers work, but an imported slicer (cache + drawing) is invisible and an app slicer never reaches Excel. |
| 8 | **Native pictures & shapes in drawings: not imported** (§13.2) | PARTIAL | The drawing part is mined only for charts and SmartArt. Ordinary photos/logos/shapes in a real file don't render (app pictures are a separate data-URL/custom-property model). |
| 9 | **Tables (ListObject): definition never written natively** (§11) | PARTIAL | Structured references are rewritten to A1 on import (good), but the `xl/tables/tableN.xml` part, table style, totals-row functions and calculated-column formulas have no native write; classic save drops the table, verbatim keeps only the original. |
| 10 | **Charts: no native write-back** (§8.1) | PARTIAL | Import is genuinely good (kind/title/series/caches/trendlines/pivot source), but edits and app charts persist only as `icecream.chartspecs` custom properties — Excel sees the stale original chart (verbatim) or no chart (classic). |
| 11 | **Dynamic-array spill metadata** (§9.3) | PARTIAL | Modern files are full of spilling formulas. Legacy `t="array"` is handled, but spill ranges are emulated by writing static neighbour values; no dynamic-array `<f>` metadata is read as such or written. |
| 12 | **Rich values / cell metadata (`vm`) for linked data types** (§9.2) | PARTIAL | Stocks/Geography in a real file arrive as numbers/strings with their richValue + `xl/metadata.xml` records unparsed — field extraction (`FIELDVALUE`, dot notation) has nothing to bind to. |

### 1.4 What is genuinely strong (don't re-litigate)

Defined names incl. print titles/areas (§10), the protection option matrix (§12.1),
pivot-table import with byte-for-byte raw-part round-trip (§7.1), external workbook links
(§9.5), chart *import* (§8.1), SmartArt import (§13.3), page setup / breaks / header-footer
native XML (§§14.5, 15.2), and VBA-project byte preservation (§12.4).

---

## 2. Method notes & doc-vs-code corrections

### 2.1 Spec sources
ISO/IEC 29500-1:2012 full text (reginfo.gov, objectID 136723002) — §18 is SpreadsheetML;
chart parts are ChartML (§21.2 in the 2012 numbering), spreadsheet drawings are DrawingML
(§20.5), diagrams §21.3. [MS-XLSX] (Microsoft Learn / Open Specs, v20250520) defines the
extension namespaces: `x14` (Excel 2010: sparklines, slicer caches, CF/DV extensions),
`x15` (Excel 2013: timeline slicers, chart extensions, data-model connections), threaded
comments/persons (`CT_ThreadedComment` [MS-XLSX] §2.6.205 area, `CT_Person` §2.6.203),
rich values (§2.6.170s, supporting property bags), and the DataMashup (Power Query) part.

### 2.2 Verification convention
Each entry cites the file(s) grepped/read. "No hits" claims were checked across
`packages/xlsx-adapter/src`, `packages/engine/src`, `packages/service/src`, and
`apps/web/src` for the OOXML element/part names (e.g. `sparklineGroup`, `slicerCache`,
`threadedComment`, `richValue`, `customXml`, `dataValidation` in the adapter).

### 2.3 Where FEATURES.md / TODO.md overstate (code wins)
* FEATURES.md tracks 4/5/14 say slicers, sparklines, timelines, PivotCharts are "built/wired" —
  true only as *app-native* features. None has OOXML import/export (§§4, 5, 7).
* FEATURES.md track 7 / TODO.md Part 2.4 say data validation and conditional formatting are
  done — again app-session models only (`apps/web/src/features/models.ts` header says so
  explicitly: "UI-layer state (the engine protocol has no formatting model)").
* TODO.md Part 5.1 says named ranges are now 95% with XLSX round-trip — verified true (§10);
  this is one doc claim that *does* hold in code.

---

## 3. Comments, notes, threaded comments

### 3.1 Legacy comments & notes — **PARTIAL** · Importance: **Medium**
*What:* the classic cell comment: a `xl/commentsN.xml` part (`<commentList>/<comment>`,
ISO §18.7) plus a VML legacy drawing for the comment box shape/visibility, referenced from
the worksheet via `<legacyDrawing>`. Excel's "Notes" today *are* this legacy form.
*Code:* the app has two separate session models — `apps/web/src/features/comments.ts`
(plain text per cell) and `apps/web/src/features/notes.ts` (`CellNote{text,author,createdAt}`,
header explicitly modelling Excel's note/comment distinction) — plus `CommentsDialog.tsx` /
`NotesPanel.tsx`. **But:** zero hits for `comments`, `legacyDrawing`, or `vml` in
`packages/xlsx-adapter/src` (the one `legacyDrawing` hit is a string in a page-setup anchor
list, `pageSetupXml.ts:776`). Neither model is in `applyClientSaveMetadata`, so neither is
persisted even as `icecream.*` metadata.
*Missing exactly:* native parse of `xl/comments*.xml` on open; native write on save;
author/timestamp import. Verbatim server save preserves an *original* file's comments part
untouched — the app still can't see or edit them.

### 3.2 Threaded comments + person records — **MISSING-BUILD-CANDIDATE** · Importance: **High**
*What:* modern Excel comments: `xl/threadedComments/threadedCommentN.xml`
(`<threadedComment ref dT personId id parentId done>` with `<text>` and `<mentions>`) plus
`xl/persons/person.xml` (`CT_Person`: display name, initials, provider id) — [MS-XLSX]
§2.6.203–2.6.206; the worksheet links them via an `extLst` `x18at:threadedComments` extension.
Replies, @mentions, resolved state (`done`) all live here, *not* in §18.7 comments.
*Code:* zero hits for `threadedComment`, `persons`, `CT_Person`, `personId` anywhere in
`packages/` or `apps/web/src`. The app comment UI (§3.1) is single-text, no threads,
replies, mentions, or resolve state.
*Why High:* any file commented in current Excel uses this form exclusively; those threads
are currently invisible on open and dropped on a classic save.

---

## 4. Slicers, timelines, sparklines

### 4.1 Slicers (incl. pivot/table slicer caches) — **PARTIAL** · Importance: **High**
*What:* a slicer = a drawing control bound to a *slicer cache* part:
`xl/slicerCaches/slicerCacheN.xml` (base §: [MS-XLSX] `x14:slicerCache`, cache definition,
items, selection) + `xl/slicers/slicerN.xml` per sheet, plus the pivot-side
`pivotCache` `cacheSource` and x14 pivot extensions that record slicer→pivot linkage.
*Code:* app-native slicers are real and good — `apps/web/src/features/slicers.ts`
(`SlicerSpec`, toggle/clear, `pivotIds` binding), `apps/web/src/components/Slicer.tsx`,
`packages/service/src/slicer.ts` (`applySlicersToPivotSpec`, 13 tests per TODO.md),
report slicers in `packages/service/src/reports/slicers.ts`. **But:** zero hits for
`slicerCache`, `slicers/`, or `x14:slicer` in the adapter; imported slicers are not parsed,
and `SlicerSpec` is not in `applyClientSaveMetadata` (session/local state only).
*Missing exactly:* slicer-cache import (items/selection/cache source), native slicer write,
and the x14 pivot slicer-cache linkage (§7.4).

### 4.2 Timeline slicers — **PARTIAL** · Importance: **Medium**
*What:* the date slicer: `x15:timelineCache` + `xl/timelines/timelineN.xml` and
`x15:timeline` drawing elements ([MS-XLSX] x15 extensions), with granularity
(days/months/quarters/years) and a selected date range, bound to a pivot cache field.
*Code:* app timelines exist — `apps/web/src/features/timelines.ts` (`TimelineSpec`,
bucketing by day/month/quarter/year, Excel-serial date parsing) + `components/Timeline.tsx`,
filtering grid rows. No `timelineCache`/`x15:timeline` hits in the adapter; not persisted
natively (same save gap as §4.1).
*Missing exactly:* native timeline-cache import/export and pivot binding (app timelines
bind to a grid column, not a pivot cache).

### 4.3 Sparklines — **PARTIAL** · Importance: **Medium**
*What:* in-cell mini charts: worksheet `extLst` → `x14:sparklineGroups` →
`<x14:sparklineGroup type="line|column|stacked" …>` with per-group colors, markers,
axis (incl. custom min/max, date axis), and `<x14:sparklines>` data refs (ISO §18.3 base
has no sparklines; they are entirely an x14 extension, [MS-XLSX] §2.3.2).
*Code:* app sparklines render line/column/win-loss as SVG — `apps/web/src/features/sparklines.ts`
(`SparklineSpec`, `renderSparkline`, min/max markers) + `SparklineDialog.tsx`, Grid rendering.
Zero hits for `sparklineGroup` / `x14:sparkline` in the adapter *and* engine; the spec type
has no negative-value, axis, marker-color, or stacked support, and placements are not in
`applyClientSaveMetadata`.
*Missing exactly:* x14 import (groups, refs, axis/markers), x14 write, stacked type.

---

## 5. Conditional formatting

### 5.1 Base CF (`cellIs`, `expression`, `colorScale`, `dataBar`, `iconSet`) — **PARTIAL** · Importance: **High**
*What:* worksheet `<conditionalFormatting sqref>` → `<cfRule type …>` (ISO §18.3.1.18;
`cfRule` §18.3.1.10), with the applied format in styles `<dxfs>` (`dxfId`), operators,
formulas, stop-if-true, priority. `dataBar`/`colorScale`/`iconSet` are *base* 2007 types
(with `cfvo` thresholds).
*Code:* two app models exist and render in the Grid — base `CFRule`
(`apps/web/src/features/models.ts`: operators gt/lt/eq/between/contains, one bg color) and
`apps/web/src/features/cfExtended.ts` (`ExtCFRule`: dataBar width %, 2-color scale,
3-arrow icon set) wired in `App.tsx` (~L3106) and `CFRuleDialogs.tsx`. **But:** no
`conditionalFormatting`/`cfRule` parse anywhere in the adapter (the only `dxf` hits are a
comment in `fastSheetParse.ts:142` warning *not* to confuse `<dxfs>` numFmts with cell
formats, and styles cloning in `stylesXml.ts`). Rules are not in `applyClientSaveMetadata`.
*Missing exactly:* (a) import — an opened file's CF never renders; (b) export — app rules
never become `<cfRule>`+`<dxf>`; (c) dxf fidelity (font/fill/border/numFmt differentials),
priority/stopIfTrue, multi-operand and error/text operators in the base model.
Verbatim save preserves the original file's CF XML untouched — invisible in-app either way.

### 5.2 CF rule breadth (`top10`, `aboveAverage`, `duplicateValues`, `containsText`, `timePeriod`, `notContainsErrors`, …) — **PARTIAL** · Importance: **Medium**
*What:* the remaining base `cfRule` types (ISO §18.3.1.10, `ST_CfType`).
*Code:* `cfExtended.ts` implements top/bottom-N (with tie handling) and `aboveAverage`
(strictly-greater-than-mean) and formula rules (relative-ref shifting); base model has
text `contains`. Absent: `duplicateValues`/`uniqueValues`, `timePeriod` (yesterday/last7Days/…),
`notContainsText`/`beginsWith`/`endsWith`, error/no-error rules, `aboveAverage` with
equal-average / std-dev variants, and below-average as a first-class rule.
All of it inherits §5.1's no-import/no-export gap.

### 5.3 x14 CF extensions — **MISSING-BUILD-CANDIDATE** · Importance: **Medium**
*What:* worksheet `extLst` `x14:conditionalFormattings` ([MS-XLSX] x14): data bars with
**negative fill / axis position / direction / border**, icon sets with custom icons and
`reverse`/`showValue` per-icon state beyond the 2007 set, and CF over filtered data.
Modern Excel writes data bars *only* in this extended form (the base element is a stub).
*Code:* zero `x14` CF handling anywhere; `cfExtended.ts` data bars are a 0–100 % width
from range min/max (`dataBarWidth`) — no negatives, no axis, no gradient/border model,
and icon sets are exactly one hard-coded `arrows3` (file comment: "only 'arrows3' is
supported for now").

### 5.4 PivotTable conditional formatting — **MISSING-BUILD-CANDIDATE** · Importance: **Low**
*What:* `<conditionalFormatting pivot="1">` with `<pivotAreas>` scoping CF to pivot
fields/intersections (ISO §18.3.1.18 `pivot` attr; `ST_Scope` §18.18.67).
*Code:* no `pivotAreas`/`pivot="1"` handling; imported pivots (§7.1) are recomputed by the
service pivot engine, which has no CF model. Low because pivot-scoped CF is rare in the wild
compared with §5.1.

---

## 6. Data validation

### 6.1 Base validations — **PARTIAL** · Importance: **High**
*What:* worksheet `<dataValidations>` → `<dataValidation type="whole|decimal|list|date|
time|textLength|custom" operator allowBlank showErrorMessage … sqref>` with `<formula1/2>`,
prompt (`promptTitle/prompt`) and error (`errorTitle/error`, `errorStyle`) (ISO §18.3.1.32).
*Code:* the app model is `ValidationRule{id,sheet,row,col,list[]}` — **list-only, single-cell**
(`apps/web/src/features/models.ts:83ff`), enforced at edit time in `App.tsx:1966`
(`findValidation` + reject), rendered as a ▼ indicator in `Grid.tsx:951`, dialog in
`FormatDialogs.tsx`. No `dataValidation` hits in the adapter at all.
*Missing exactly:* native import (all types), native export, range `sqref` (app is per-cell),
whole/decimal/date/time/textLength/custom-formula types, operators, allow-blank, input
prompts, error alerts/styles, dropdown-in-cell fidelity, dependent/cascading lists.

### 6.2 x14 extension validations — **MISSING-BUILD-CANDIDATE** · Importance: **Low**
*What:* `x14:dataValidations` in `extLst` ([MS-XLSX]): validations whose list formula
references another sheet / structured refs, and validations Excel 2010+ writes when the
base form can't express them.
*Code:* none (see §6.1). Low standalone — it should be built *with* §6.1, since real modern
files put cross-sheet list validations here and a §6.1-only importer would still miss them.

---

## 7. PivotTables, pivot caches, slicer caches

### 7.1 PivotTable + pivot cache import & round-trip — **HAVE** · Importance: **High**
*What:* `xl/pivotTables/pivotTableN.xml` (definition: location, row/col/page/data fields,
style — ISO §18.10.1) + `xl/pivotCache/pivotCacheDefinitionN.xml` (fields, shared items,
cache source) + `pivotCacheRecordsN.xml` (the cached data).
*Code — verified strong:* `packages/xlsx-adapter/src/pivotTables.ts` (1,062 lines) follows
sheet rels → pivot part → cache definition/records, parses shared items, data fields with
`subtotal` → aggregation mapping, hidden-item filters, and cache source kinds
(worksheet/external/scenario/consolidation). Raw parts are captured (`PivotRawParts`,
base64) and **re-injected byte-for-byte on write** (`injectPivotParts`, `adapter.ts:805ff`) —
the same preservation pattern as the VBA project. The web app maps the import to the service
pivot engine (`packages/service/src/pivot.ts`, `importedPivots.ts`) and *recomputes* the
layout live, registers GETPIVOTDATA + an OLAP cube per pivot. This is the one heavyweight
OOXML family with genuine import + preserve + works.
*Caveat (why not more of §7 is HAVE):* the recomputation is the app's own pivot model —
see §§7.2–7.4 for what the import drops.

### 7.2 Pivot grouping — **PARTIAL** · Importance: **Medium**
*What:* cache-field grouping: date grouping (`<fieldGroup>` with `groupBy` days/months/…,
`<rangePr>`), numeric range grouping, and custom discrete groups (`<discretePr>`) (ISO §18.10.1).
*Code:* `pivotTables.ts` parses fields/items/filters but has no `fieldGroup`/`rangePr`/
`discretePr` handling (grep: no hits). The app has grouping UI for *native* pivots
(`PivotTableGrouping.test.tsx`, service pivot grouping keys) — TODO.md itself lists
"date/numeric/custom grouping operators not yet" for the service engine.
*Missing exactly:* imported group definitions (a date-grouped pivot imports as flat dates),
and grouped-field write-back.

### 7.3 Calculated fields / members / items — **PARTIAL** · Importance: **Medium**
*What:* `<calculatedField>` definitions on the cache, calculated members/items in OLAP
pivots, and `dataField` `baseField/baseItem` show-data-as variants (ISO §18.10.1).
*Code:* no `calculatedField`/`calculatedMember` parsing in `pivotTables.ts`. The product
has calculated fields only for *reports* (`packages/service/src/reports/calculatedFields.ts` —
formula over a report binding row), which is a different object from a pivot calculated
field. Show-data-as (% of total, difference from) is likewise not in the imported model —
`ImportedPivotValueField` carries only field + aggregation + label.
*Missing exactly:* calc-field/member import & evaluation in pivots; show-data-as modes.

### 7.4 Pivot x14 extensions & slicer caches — **MISSING-BUILD-CANDIDATE** · Importance: **Medium**
*What:* [MS-XLSX] x14 pivot extensions: `x14:pivotCacheDefinition` (incl. slicer-cache
linkage), pivot-table `extLst` (e.g. `x14:pivotTable` with slicer references), timeline
caches (§4.2), and conditional-formatting / sort-by-value extensions on pivots.
*Code:* the import reads only base-2007 pivot XML; no `slicerCache` or x14 pivot parsing.
Consequence: a dashboard pivot + slicer set imports as a pivot with no slicers (§4.1).

---

## 8. Charts

### 8.1 Base charts (DrawingML ChartML) — **PARTIAL** · Importance: **High**
*What:* `xl/charts/chartN.xml` (ChartML, ISO §21.2): plotArea chart types, series
(`tx`/`cat`/`val` with caches), axes, legend, data labels, title; anchored from
`xl/drawings/drawingN.xml` (`xdr:twoCellAnchor`); embedded workbook part for external data.
*Code — import is real:* `packages/xlsx-adapter/src/charts.ts` (647 lines) walks
drawing rels → chart part and parses kind (every `c:*Chart` child, incl. combo plot types
and secondary-axis detection), bar direction, title, per-series name/cat/val formulas,
**cached cat/val points** (used for first paint per the Cycle-10 progressive rule), and
per-series **trendlines** (`serializeTrendlineXml` is the only write-back helper — for
trendlines inside the parsed model). `<c:pivotSource>` is parsed so PivotCharts bind to
the live pivot (§7.1). The app renders these as native Chart.js overlays
(`apps/web/src/features/importedCharts.ts`, `components/Charts.tsx`); app-authored charts
(37 kinds, trendlines in `packages/service/src/trendline.ts`, PivotCharts in
`pivotChart.ts`) are a full parallel model.
*Missing exactly:* **no native chart write** — `adapter.ts` write path re-injects pivots and
SmartArt but has no chart injection; app charts persist only as `icecream.chartspecs`
custom properties (App.tsx `applyClientSaveMetadata`). Axes formatting, data labels,
series formatting (fill/line/markers/smooth), legend position, and gap/overlap are not in
`ImportedChart` (kind/title/series/anchor/pivotSource only), so an imported chart renders
approximately. On classic save the native chart is gone; on verbatim save it is the
*original*, ignoring app edits.

### 8.2 Chart x15 extensions, chart style/color parts — **MISSING-BUILD-CANDIDATE** · Importance: **Medium**
*What:* [MS-XLSX] x15 chart extensions in chart `extLst`: filtered/hidden-data handling,
**leader lines** for data labels, series `x15` extensions, plus the separate
`xl/charts/styleN.xml` and `colorsN.xml` parts (chart style & color style, Excel 2013+)
and data-label rich formatting.
*Code:* no `x15`, `leaderLines`, `chartStyle`, or style/colors-part handling in
`charts.ts` (grep: no hits). Modern Excel files routinely carry these parts; today they
survive only via verbatim copy, unrendered.

### 8.3 Chart sheets — **MISSING-BUILD-CANDIDATE** · Importance: **Low**
*What:* a chart as its own sheet (`xl/chartsheets/sheetN.xml`, ISO §18.2 workbook sheet
types), plus legacy dialog sheets and Excel 4.0 macro sheets.
*Code:* the adapter iterates `wb.SheetNames` as worksheets (`adapter.ts:305ff`) and
`SheetData` has no sheet-kind concept; `fastSheetParse.ts` expects worksheet XML.
A chart sheet has no grid to load and no representation in the app.

---

## 9. Data model, connections, rich values, formula-file metadata

### 9.1 Spreadsheet data model (model tables, relationships, DAX measures) — **PARTIAL** · Importance: **Medium**
*What:* [MS-XLSX] dataModel: `xl/model/item.data` (the embedded VertiPaq/xVelocity model),
model tables declared via `x15:connection model="1"` + `<x14:connection>` extensions,
table relationships, and DAX measures stored as model metadata (Power Pivot).
*Code:* `packages/xlsx-adapter/src/connections.ts` parses `xl/connections.xml` *only* far
enough to serve CUBE functions: it detects data-model connections (`dbPr command="Model"`,
x15 `model="1"`, `olapPr`, type 5) and range connections (`x15:rangePr` → hidden `_xlcn.*`
defined name → A1 ref), dropping all other connections ("they carry no data the host can
rebuild a cube from" — file header). `packages/service/src/cubeDataModels.ts` then rebuilds
a local OLAP cube from that range (`cubeFromPivot` + `registerCube`), so CUBEVALUE/
CUBEMEMBER over a range-fed model genuinely compute.
*Missing exactly:* the `xl/model/item.data` model itself (never parsed — a model fed by
external data, multiple tables, or relationships has no range to rebuild from), DAX
measures, model relationships, and any Data Model UI. A Power Pivot file whose model
isn't a single worksheet range degrades to #NAME?-style cube misses.

### 9.2 Rich data types, richValue records & cell metadata — **PARTIAL** · Importance: **High**
*What:* linked/rich data types are stored as: cell `vm="N"` attribute → `xl/metadata.xml`
(`<metadataRecords>` / value-metadata) → `xl/richData/richValue*.xml` records with a
supporting property bag (fields), plus `rdRichValueTypes` ([MS-XLSX] §2.6.170s, §2.4.8
metadata). FIELDVALUE and field-access (`.Name`) read from these records.
*Code:* the *feature* exists app-side — `apps/web/src/features/dataTypes.ts` (Stocks +
Geography rich values with live Stooq/Nominatim providers + sample fallback, detail cards,
field extraction) and all five smart chips (`features/smartChips.ts`). **But:** zero hits
for `richValue`, `valueMetadata`, `cellMetadata`, or `metadata.xml` in the adapter/engine;
`TypedValue` (`packages/engine/src/types.ts:35`) is `Scalar | Error | ImageValue` — there is
no rich-value kind. `SheetData` carries no `vm` indices.
*Missing exactly:* import of a real file's rich values (a Stocks cell arrives as its cached
scalar only, fields unrecoverable), native export of app data types (they persist as
`icecream.*` data-type metadata, App.tsx `dataTypesToMetadata`), and identity/refresh
semantics for Excel-created entities.

### 9.3 Dynamic-array formula metadata — **PARTIAL** · Importance: **High**
*What:* modern dynamic arrays are written as a normal `<f>` on the anchor with the spill
range implied, plus `cm`/metadata in newer writers; legacy CSE arrays are
`<f t="array" ref="…">` on the anchor with member cells carrying cached values only
(ISO §18.3.1.40 formula types). Excel also uses `<f t="dataTable">` for What-If data tables.
*Code:* legacy arrays are handled deliberately — `fastSheetParse.ts:709ff` keeps the anchor
formula, records the array range, and **nulls member cells**; shared formulas are translated
(`translateSharedFormula`); empty `<f/>` dataTable members fall through to cached values
(`fastSheetParse.ts:735`, `formulaRecovery.ts:289`). The engine emulates spill:
`packages/engine/src/dynamic-arrays.ts` computes the 2D result and hosts write neighbours as
**static values** via `toSpillWrites` (header documents this as the design).
*Missing exactly:* spill-range as a live object (editing/blocking semantics, #SPILL!
obstruction handling beyond the error code, spill ref `#` operator round-trip), and on
write the anchor is emitted as a plain `<f>` with neighbours as static cached cells
(`streamingSave.ts:cellXml`) — Excel will treat the result as ordinary values, not a
spilling array, and any later edit in Excel won't re-spill.

### 9.4 LAMBDA / LET serialization (`_xlfn`, `_xlpm`, `_xlws`) — **PARTIAL** · Importance: **High**
*What:* functions newer than the 2007 spec are stored prefixed: `_xlfn.XLOOKUP`,
`_xlfn._xlws.FILTER`, `_xlfn.LAMBDA`, with lambda parameters as `_xlfn._xlpm.<name>`;
LET/LAMBDA themselves are `_xlfn`-prefixed, and a LAMBDA stored in a defined name is how
Excel persists user functions (ISO §18.2.6 future-function prefix convention; [MS-XLSX]
documents the newer prefixes).
*Code:* the engine genuinely implements LET/LAMBDA/MAP/REDUCE/… by AST substitution
(`packages/engine/src/lambda-functions.ts`) and named functions ride defined names
(`packages/service/src/names/namedFunctions.ts`). Import: `fastSheetParse.ts:685` strips
`_xlfn.` **globally and indiscriminately** (mirroring SheetJS), which makes known functions
parse — but also erases the distinction between e.g. `_xlfn._xlws.*` dynamic-array functions
and any unknown future function (an unimplemented `_xlfn.` function becomes a bare name
that fails later, with no record of what it was). Grep: **no `_xlpm` or `_xlws` handling
anywhere**, and **no write-side prefixing** in `adapter.ts`, `streamingSave.ts:cellXml`,
or the service save — formulas are emitted with bare function names.
*Missing exactly:* prefix-preserving import (keep the original token for unknown functions),
`_xlpm` parameter round-trip for LAMBDA defined names, and write-side re-prefixing of
post-2007 functions so Excel and strict readers see the form Excel itself writes.

### 9.5 External workbook links — **HAVE** · Importance: **Medium**
*What:* `xl/externalLinks/externalLinkN.xml` parts: target workbook, sheet names, and the
cached value data set behind `=[N]Sheet!A1` formulas (ISO §18.8).
*Code — verified:* `packages/xlsx-adapter/src/externalLinks.ts` parses every link part into
metadata, the engine binds `[N]…` formulas to an `ICEEXTREF` dispatcher resolving through
the cached table, and write **regenerates** the link parts, rels, content types, and
`<externalReferences>` from the records (file header: "real regeneration, not byte-faithful").
App link registry/dialog in `apps/web/src/features/externalLinks.ts`. RTD is engine-local
(`publishRtdTopic`) per FEATURES.md track 20.

### 9.6 External connections & query tables — **PARTIAL** · Importance: **Medium**
*What:* `xl/connections.xml` full connection definitions (`dbPr` connection strings,
`odbcPr`/`oledbPr`, `textPr`, `webPr`, `refreshOnLoad`/background refresh) and
`xl/queryTables/queryTableN.xml` (the sheet range a connection refreshes into, field
properties) (ISO §18.12, §18.5 connections/queryTable parts).
*Code:* connections are parsed only for the cube use case (§9.1 — non-model, non-range
connections are dropped in `readConnections`). Query-table parts: zero hits in the adapter.
The app's refreshable-import story is its own: ETL pipeline (`packages/service/src/etl/`)
and `apps/web/src/features/queries.ts` (text/csv/web queries in localStorage) +
`QueriesPane.tsx` — functional equivalents, not the file's connections.
*Missing exactly:* connection-string/type/refresh-property import, queryTable import,
refresh-against-source for a file's own connections, and native write of app queries.

### 9.7 Power Query mashup part — **MISSING-BUILD-CANDIDATE** · Importance: **Medium**
*What:* a Power Query query lives in the package as a `xl/model` companion: the
`DataMashup` custom XML part (`customXml` item with the mashup XML containing every
query's M code, base64 package parts) referenced from `xl/workbook.xml` extensions
([MS-XLSX] §2.4.1 DataMashup). "Queries & Connections" in a modern file *is* this part.
*Code:* zero hits for `DataMashup`/`mashup`. The product's Power Query story is the ETL
pipeline + an M-subset translator (`packages/service/src/mLanguage.ts`, M → ETL recipe) —
so M *language* competence exists, but a real file's queries are neither extracted nor
re-emitted; opening a PQ-heavy file shows only its loaded result ranges.

---

## 10. Defined names

### 10.1 Defined names (workbook + sheet scope) — **HAVE** · Importance: **High**
*What:* `<definedNames>` in `xl/workbook.xml`: name, refers-to (range, constant, or
formula — incl. LAMBDA), `localSheetId` scope, hidden/comment attributes (ISO §18.2.6).
*Code — verified:* SheetJS `Workbook.Names` are read in `adapter.ts:325ff` into
`WorkbookData.definedNames` (dangling #REF! names kept deliberately); HF-unbindable names
(`Global1`-style) are rewritten to A1 by `packages/xlsx-adapter/src/names.ts`
(`rewriteDefinedNames`, scope-shadowing, chained-name resolution); the service model
(`packages/service/src/names/`: stable `nr:` ids, scope/shadowing, dangling detection)
round-trips through the adapter on save, and `streamingSave.ts:regenerateWorkbookXml`
rewrites the names block while preserving `_xlnm.*` verbatim. Defect-E1 history in
`apps/web/src/io.ts:mergeDefinedNames` shows this path is actively defended by tests.

### 10.2 Print titles / print areas & built-in `_xlnm` names — **HAVE** · Importance: **Medium**
*What:* `_xlnm.Print_Area`, `_xlnm.Print_Titles` (sheet-scoped defined names), plus
`_xlnm.FilterDatabase`, `_xlnm._FilterDatabase`, sheet-title names (ISO §18.2.6 built-ins).
*Code:* print area/titles are parsed from the native names into the app model and written
back natively — `packages/xlsx-adapter/src/pageSetupXml.ts` (`PRINT_TITLES_APP_META_PREFIX`,
`sheetPageSetupToAppTitles`, merge logic §544ff), carried per-sheet through save in
App.tsx (GAP-9 stash). The adapter deliberately *skips* `_xlnm.*` when building the formula
name list (`adapter.ts:341`) and the streaming writer preserves them verbatim.
*Exception:* `_xlnm.FilterDatabase` gets no special treatment — see §14.4.

---

## 11. Tables (ListObjects) — **PARTIAL** · Importance: **High**
*What:* `xl/tables/tableN.xml`: `<table name displayName ref headerRowCount totalsRowShown>`
with `<tableColumn>`s (name, `totalsRowFunction` — subtotal 101–111, `totalsRowLabel`,
`calculatedColumnFormula`), `<tableStyleInfo>` (style name + first/last/row/col stripes),
and the table's own `<autoFilter>` (ISO §18.5.1). Formulas use structured references
(`Table[Column]`, `[[#Totals],[Col]]`, `[@Col]`).
*Code:* import handles the *formula* half well — `packages/xlsx-adapter/src/tables.ts`
reads table defs (name, ref, columns, header/totals flags) solely to **rewrite structured
references to A1** before the engine sees them (`rewriteStructuredRefs`, all specifier
forms incl. `#Headers/#Data/#Totals/#All`, this-row, control-char-escaped column names).
Web table styles exist app-side (`features/tableStyles.ts`, `TableStyleGallery.tsx`).
*Missing exactly:* `totalsRowFunction`/`totalsRowLabel` per column (not parsed — only the
`totalsRowShown` boolean), `calculatedColumnFormula`, `tableStyleInfo` (style name/stripes
not imported), table `<autoFilter>`, and **any native table write** — there is no
`injectTables`/table serializer in the adapter write path, so classic save drops the table
definition (formulas survive as A1), and the verbatim path preserves only the original
file's table part, which then disagrees with edited data extents.

---

## 12. Protection, signatures, macros

### 12.1 Workbook & sheet protection option matrix — **HAVE** · Importance: **Medium**
*What:* `<sheetProtection>` (15 boolean options: formatCells/Columns/Rows, insert/delete
rows/columns, sort, autoFilter, pivotTables, objects, scenarios, selectLocked/Unlocked),
`<workbookProtection>` (structure/windows), and cell-xf `<protection locked hidden>`
(ISO §18.3.1.86, §18.2.13, styles §18.8.47).
*Code — verified:* `packages/xlsx-adapter/src/protectionXml.ts` (867 lines) parses and
writes the **full 15-attribute matrix** (`SHEET_PROTECTION_ATTRS` table, L118) with correct
Excel defaults, parses workbook structure/windows, and round-trips per-cell locked/hidden
xf flags (materializing empty styled cells like Excel does). Passwords are never read or
written — a verifier becomes `hasPassword: true` only (design §4). Enforcement model in
`packages/engine/src/protection.ts` mirrors the same options type. (At-rest/password-to-open
*encryption* is the separate service-layer `crypto.ts` KeyManager story, not an OOXML matrix
item.)

### 12.2 Protected ranges (`<protectedRanges>` / Allow Edit Ranges) — **PARTIAL** · Importance: **Medium**
*What:* worksheet `<protectedRanges><protectedRange name sqref securityDescriptor/password>`
— per-range edit passwords on a protected sheet (ISO §18.3.1.71).
*Code:* the feature exists app-side — `apps/web/src/features/editRanges.ts` (salted SHA-256
range passwords, session unlock) + Review UI. But it persists to **localStorage**
(`icecream.editRanges.v1`), not the file; `protectionXml.ts` has no `protectedRange`
parse/write (grep: no hits), so Excel's protected ranges don't import and app ranges
don't export.

### 12.3 Digital signatures — **MISSING-BUILD-CANDIDATE** · Importance: **Low**
*What:* `xl/_xmlsignatures/` parts + `docProps` signature lines (OOXML Part 2 digital
signature provisions; signature line drawings in VML/drawing).
*Code:* zero hits for `_xmlsignatures`/`digitalSignature` in the adapter. Note for triage:
any edit invalidates an OOXML signature by design, so the honest feature is
*detect-and-warn* ("this file was signed; edits will invalidate it"), not preservation.
Low frequency outside regulated workflows.

### 12.4 VBA & macro parts — **NOT-APPLICABLE** · Importance: —
*What:* `xl/vbaProject.bin` (+ `vbaData.xml`, macro sheets) in `.xlsm` (ISO Part 3
transitional macro-presence provisions).
*Why N/A:* executing VBA is a documented v2 non-goal (automation-lane design doc): the
product ships a permissioned TypeScript automation lane + VBA/Apps-Script *translators*
(`packages/service/src/automation/translator.ts`). What parity requires — not losing the
macros — **is** done: `packages/xlsx-adapter/src/macroProject.ts` extracts `vbaProject.bin`
and re-injects it byte-for-byte on save (`adapter.ts:640ff, 831ff`), and the streaming
writer copies it verbatim. Verdict N/A for *execution*, with preservation verified HAVE-level.

### 12.5 ActiveX controls — **NOT-APPLICABLE** · Importance: —
*What:* `xl/activeX/activeXN.xml` + binary control parts + `<control>` drawing anchors —
Windows COM controls (ISO Part 3 / [MS-XLSX] control extensions).
*Why N/A:* ActiveX is Windows-only binary COM; no web/Electron renderer can or should host
it (FEATURES.md track 18: "absent by design (preserve/migrate only)"). The functional
equivalents exist as native app controls (§13.1). Preservation: verbatim server save copies
the parts untouched; classic save drops them — acceptable for a non-goal, noted for honesty.

---

## 13. Drawings: controls, OLE, pictures, shapes, SmartArt

### 13.1 Form controls — **PARTIAL** · Importance: **Medium**
*What:* Excel form controls are drawing shapes with `<controlPr>`/form-control properties
(button, checkbox, combo/list box, spin, scroll bar, radio/group) bound to a linked cell
and list range (DrawingML §20.5 + [MS-XLSX] `x14:formControl` extensions for newer files).
*Code:* app controls are real — `apps/web/src/components/FormControls.tsx` (Button, Checkbox,
Dropdown, Listbox overlays bound to cell values, Insert menu CRUD) — but they are React
state, not parsed from or written to any drawing part (no `controlPr`/`formControl` hits
in the adapter). Spin/scroll-bar/radio/group-box kinds don't exist even app-side.
*Missing exactly:* native import/export of control type, anchor, linked cell, and list range.

### 13.2 Pictures & shapes (native drawings) — **PARTIAL** · Importance: **High**
*What:* `xl/drawings/drawingN.xml` `xdr:pic` (embedded `xl/media/*` image) and `xdr:sp`
shapes with geometry/fill/line/text — the ordinary content of most real files' drawings.
*Code:* the drawing part is opened only to extract **charts** (§8.1) and **SmartArt**
(§13.3). There is no `xdr:pic`/`blip`/`xdr:sp` parsing in the adapter (grep: no hits).
App pictures are a separate model — `components/Pictures.tsx`: user-inserted images as
data URLs persisted via the `icecream.pictures` custom property (not native media parts) —
and app shapes are an SVG overlay catalog (`packages/service/src/shapes.ts`, 120 shapes;
`components/Overlays.tsx`), likewise not written as DrawingML.
*Missing exactly:* import of a file's photos/logos/shapes (they simply don't appear),
native media/drawing write for app pictures/shapes. Verbatim save keeps the original
drawing untouched — including anchors that may no longer match edited rows/columns.

### 13.3 SmartArt (diagrams) — **PARTIAL** · Importance: **Low**
*What:* `xl/diagrams/{data,layout,colors,quickStyle}N.xml` bound from a drawing
`graphicFrame` (DrawingML diagrams, ISO §21.3).
*Code:* import is real — `packages/xlsx-adapter/src/smartart.ts` (758 lines) maps every
layout to one of 7 render families (never silently dropped; substitutions carry a
`fallbackNote`), renders as picture overlays, and raw parts round-trip byte-for-byte
(`injectSmartArtParts`, `adapter.ts:817ff`). Partial only because rendering is a
family approximation, not the layout engine, and app edits to a diagram don't write back
to the diagram parts.

### 13.4 OLE objects & embedded packages — **PARTIAL** · Importance: **Low**
*What:* `xl/embeddings/oleObjectN.bin` + `<oleObjects>` worksheet references (embedded
Word/PDF/another workbook rendered via a drawing fallback image) (ISO §18.3.1.60).
*Code:* no `oleObject`/`embeddings` handling anywhere. Verbatim server save copies the
parts byte-for-byte (preservation-only); classic save drops them; nothing renders or
indicates an embedded object in the app. Low: uncommon, and opening embedded packages is
out of scope for a web renderer — but silent disappearance on classic save is the gap.

---

## 14. Worksheet & workbook structure

### 14.1 Outlines / grouping — **PARTIAL** · Importance: **Medium**
*What:* row/column grouping is stored as `outlineLevel` (0–7) + `collapsed`/`hidden` on
`<row>` and `<col>` elements, with `<outlinePr>` summary direction (ISO §18.3.1.67/§18.3.1.13).
*Code:* the app has a group model — `apps/web/src/features/groups.ts` (row/col groups,
collapse toggling, hidden-by-group) + View UI. But the fast parser's `RawRowDef`/`RawColDef`
(`fastSheetParse.ts:279ff`) capture only height/width + `hidden` — **no `outlineLevel`**
(grep: no hits in the adapter). On write, `streamingSave.ts:emitRow` emits height/hidden
only, so a regenerated sheet loses its outline levels even on the verbatim path; the app's
own groups are not in `applyClientSaveMetadata`.
*Missing exactly:* outlineLevel/collapsed import, native write, summary-direction.

### 14.2 Background picture — **PARTIAL** · Importance: **Low**
*What:* worksheet `<picture r:id>` (sheet background image → `xl/media`) + legacy
`<backgroundImage>` in sheetPr (ISO §18.3.1.66).
*Code:* app backgrounds exist — `components/BackgroundDialog.tsx` (color or data-URL image,
persisted as `icecream.background.<sheet>` custom-property metadata). No `<picture>`
parsing in the adapter; an Excel-set background doesn't import, and an app-set background
isn't a native background in Excel. (Streaming head preservation does keep an *original*
file's `<picture>` element + media part untouched.)

### 14.3 Merge cells — **PARTIAL** · Importance: **High**
*What:* worksheet `<mergeCells><mergeCell ref>` (ISO §18.3.1.55); only the top-left cell
carries a value.
*Code:* merges are a pure UI model — `MergeRange` in `apps/web/src/features/models.ts`,
state in `App.tsx:734`, Grid rendering. **`SheetData` has no merges field**
(`packages/engine/src/storage.ts:75ff`) and neither read path extracts merges (SheetJS's
`ws['!merges']` is never read in `adapter.ts`; the fast parser ignores `<mergeCells>`).
Imported files therefore render merged areas unmerged. App merges are not in
`applyClientSaveMetadata` (session-only). Verbatim save preserves the original
`<mergeCells>` (it's in the sheet tail) — which can then contradict app merge edits.

### 14.4 AutoFilter & sort state — **PARTIAL** · Importance: **High**
*What:* worksheet `<autoFilter ref>` with `<filterColumn>` (value/date/custom filters,
top10, dynamic dates) and `<sortState>` (sort keys, case sensitivity) (ISO §18.3.1.2,
§18.3.1.92); table autoFilters (§11) are the same mechanism scoped to a table.
*Code:* grid filter/sort are app features (Data tab, `FilterState` in models.ts, Sort
dialog). No `autoFilter`/`sortState` parsing exists in the adapter — the only hits are the
*protection* option named `autoFilter` (`protectionXml.ts:130`). An imported file's active
filter (hidden rows + criteria) and saved sort are not reproduced; `hiddenRows` import
means filtered-out rows at least arrive hidden, but with no criteria to re-apply or clear.
App filter state is not written natively either.

### 14.5 Sheet views, freeze panes, selections, custom views — **PARTIAL** · Importance: **Medium**
*What:* `<sheetViews><sheetView workbookViewId zoomScale …><pane ySplit xSplit topLeftCell
activePane/><selection …>` per sheet, `<workbookViews>`, and **custom views**
(`xl/customViews` in workbook + per-sheet `customSheetViews` with their own print/filter
state) (ISO §18.3.1.87, §18.2.14).
*Code:* app view features exist — workbook views Normal/Page-Break/Page-Layout
(`features/workbookViews.ts`), split panes model (`features/windowSplit.ts`), freeze and
zoom in the Grid. None is backed by native parse/write: `SheetData` carries no view state,
and the adapter never reads `<sheetViews>` (the one hit in `streamingSave.ts:119` is the
dimension-insertion anchor list). The verbatim path preserves the source head — which
contains `<sheetViews>` — so an original freeze/zoom/selection *does* survive a server
save verbatim, but the app doesn't import it into its own freeze/zoom state, and app-set
freeze/zoom is never written natively. Custom views: no model at all.

### 14.6 Rich text runs in cells — **PARTIAL** · Importance: **Medium**
*What:* a cell's text can be multiple runs with per-run formatting (`<is><r><rPr>…<t>`,
shared-string `<si>` runs) — mixed bold/color/size inside one cell (ISO §18.4 shared
strings / §18.3.1.53 inline strings).
*Code:* text survives, formatting doesn't: `fastSheetParse.ts:concatTextRuns` concatenates
all `<t>` runs into a plain string (used for both shared strings and inline strings), and
`TypedValue` strings are plain. The streaming writer emits a single `<t>` per string cell.
Per-run formatting is lost on classic save; on verbatim save the shared-strings part is
never rewritten, so *unmodified* shared-string runs survive — inline-string runs in a
regenerated sheet do not.

### 14.7 Themes — **PARTIAL** · Importance: **Low**
*What:* `xl/theme/themeN.xml` (color scheme, font scheme, format scheme) that cell `theme`
color references and chart styles resolve against (ISO Part 1 §14 themes).
*Code:* app themes are an own model — `apps/web/src/features/themes.ts` (12-color sets,
font pairs, `icecream.theme` metadata). The adapter never parses the theme part (no hits);
theme-indexed colors in imported styles resolve only insofar as `stylesXml.ts` handles
literal colors. Verbatim save copies the theme part untouched (so the file stays
self-consistent), but switching the app theme doesn't rewrite the native theme.

---

## 15. Print & page setup (beyond-functions slice)

### 15.1 Page setup, margins, breaks — **HAVE-adjacent** *(counted in §10.2/§12 totals as part of the print stack; not a separate verdict row)*
Native `<pageSetup>/<pageMargins>/<sheetPr><pageSetUpPr>` and `<rowBreaks>/<colBreaks>`
are parsed and written natively — `pageSetupXml.ts` (852 lines) and `pageBreaksXml.ts`,
with LibreOffice-verified round-trip (TODO.md Part 4.3). Listed here so the §1 counts
aren't misread as "print is missing": it isn't.

### 15.2 Header/footer — **PARTIAL** · Importance: **Medium**
*What:* worksheet `<headerFooter>` with `oddHeader/oddFooter/evenHeader/evenFooter/
firstHeader/firstFooter` sections, each a string with `&`-codes: field codes
(`&P &N &D &T &F &A &Z &G`) **and rich formatting codes** (`&"font,style"`, `&NN` size,
`&B &I &U &S &X &Y &E`, color `&K`) (ISO §18.3.1.44).
*Code:* the native part round-trips — `pageSetupXml.ts:parseHeaderFooter` reads all six
sections + `differentOddEven/differentFirstPage` flags and re-injects them. Rendering is
the gap: `packages/service/src/headerFooter.ts:expandHFCodes` expands field codes but
**strips** formatting codes by design ("they affect rendering, not text"), and `&G`
(header picture, from `drawingHF`) has no support. The app's richer HF editor model
persists via `icecream.headerfooter.*` metadata in parallel with the native part.
*Missing exactly:* formatted rendering of header/footer text (font/size/bold/color),
`&G` pictures.

---

## 16. Text & accessibility-adjacent parts

### 16.1 Phonetic guides (furigana) — **PARTIAL** · Importance: **Low**
*What:* `<rPh>` phonetic runs + `<phoneticPr>` on shared strings / inline strings —
ruby text over Japanese (and other CJK) cell text (ISO §18.4.7).
*Code:* explicitly discarded on import — `fastSheetParse.ts:107`:
`concatTextRuns` strips `<rPh>…</rPh>` before concatenating (correct for display text,
lossy for the phonetic data). No phonetic model, display, or write anywhere. Verbatim
save preserves phonetics inside the untouched shared-strings part only.

### 16.2 SmartTags — **NOT-APPLICABLE** · Importance: —
*What:* `<smartTags>` / smart-tag properties on cells (ISO §18.3.1.90) — the Office
"smart tag" recognizer annotations.
*Why N/A:* Microsoft deprecated Smart Tags in Excel 2010 and removed the feature;
files carrying them are legacy curiosities. The correct behavior is ignore-on-read
(current behavior) — no build candidate.

### 16.3 Accessibility & document properties — **PARTIAL** · Importance: **Medium**
*What:* three distinct things: (a) `docProps/core.xml` (title/author/keywords/…),
`docProps/app.xml` (application, company, sheet titles), `docProps/custom.xml`;
(b) **alt text** on drawing objects (`<cNvPr descr>` / `xdr` non-visual properties) —
what screen readers announce for pictures/charts/shapes; (c) accessibility checking.
*Code:* (a) custom properties are the adapter's metadata bus — but only `icecream.*` keys
are interpreted (`adapter.ts:560ff`); core/app properties are not surfaced as workbook
metadata in the app (SheetJS `wb.Props` is never read), and the streaming writer preserves
other producers' custom props verbatim (`streamingSave.ts:mergeCustomPropsXml`).
(b) No `descr`/alt-text parsing for imported drawings — app pictures carry `alt={name}`
only (the file name). (c) An app accessibility checker exists
(`apps/web/src/features/accessibility.ts`: 6 rules incl. missing-alt-text, contrast,
merged cells) — it can *report* missing alt text but the alt text itself has nowhere
native to live. Sensitivity/MIP labels are a product feature (`service/sensitivity.ts`),
not OOXML — Excel's own MIP labels ride in custom properties / a separate label part and
are not imported.

---

## 17. Collaboration & legacy workbook parts (triage)

### 17.1 OOXML revision logs / shared-workbook parts — **NOT-APPLICABLE** · Importance: —
*What:* legacy "shared workbook" change tracking: `xl/revisions/revisionHeaders.xml` +
per-user revision logs, and co-authoring `xr` extensions ([MS-XLSX] `xr` namespace).
*Why N/A:* Excel itself deprecated shared-workbook revision logs in favor of cloud
co-authoring, which does not travel in the file. Icecream-sheets implements co-authoring
as its own server revision model (design-docs/revision-model-save-and-coauthoring.md:
one sequencer, revision journal, SSE deltas) — importing 2007-era revision logs would not
interoperate with any living Excel feature. Correct behavior: ignore (current).

### 17.2 Scenarios (stored) — **MISSING-BUILD-CANDIDATE** · Importance: **Low**
*What:* Excel *does* store scenarios in the file: worksheet `<scenarios>` with
`<scenario name userName comment><inputCells r val>` (ISO §18.3.1.76) — the changing-cell
values for each named scenario.
*Code:* the Scenario *Manager* works app-side (`packages/engine/src/whatif.ts`:
`ScenarioSet`, capture/apply/summary — service-owned serializable data), but there is no
`<scenarios>` parse/write in the adapter (grep: no hits), so a file's stored scenarios
don't import and app scenarios don't reach Excel.

### 17.3 Goal seek / Solver / What-If data tables (engines vs storage) — **PARTIAL** · Importance: **Low**
*What:* goal seek stores nothing (it is a transient solve — **that slice is genuinely
NOT-APPLICABLE**); Solver models persist only as cell formulas/defined names a user saves
manually (no dedicated OOXML part); What-If data tables persist as `<f t="dataTable">`
formula ranges (§9.3).
*Code:* engines are real — `goalSeek` + Data Tables in `packages/engine/src/whatif.ts`,
Solver (Nelder-Mead, constraints incl. int/bin) in `packages/engine/src/solver.ts`, both
with dialogs. Data-table *cells* import as their cached values (§9.3) but the dataTable
formula itself is not reconstituted, so the table doesn't recompute as a table.
Verdict PARTIAL on the data-table slice only; goal seek/Solver need no file work.

### 17.4 Data consolidation — **PARTIAL** · Importance: **Low**
*What:* Data > Consolidate aggregates ranges by position or labels; in OOXML it leaves
almost no trace except when the source is a pivot-cache `consolidation` source
(§18.10.1 cache sources) — there is no standalone consolidation part.
*Code:* the operation works app-side (`apps/web/src/features/consolidate.ts`:
position + label modes, 5 functions; `ConsolidateDialog.tsx`). Pivot cache sources of
kind `consolidation` are at least *recognized* by the pivot importer
(`ImportedPivotSource` includes `'consolidation'`). Nothing else to import/export —
PARTIAL only in that consolidation *results* are static values, as in Excel.

---

## 18. Full verdict index

| § | Feature | Verdict | Importance |
|---|---|---|---|
| 3.1 | Legacy comments & notes | PARTIAL | Medium |
| 3.2 | Threaded comments + persons | MISSING-BUILD-CANDIDATE | High |
| 4.1 | Slicers (+ slicer caches) | PARTIAL | High |
| 4.2 | Timeline slicers | PARTIAL | Medium |
| 4.3 | Sparklines (x14) | PARTIAL | Medium |
| 5.1 | Conditional formatting (base) | PARTIAL | High |
| 5.2 | CF rule breadth (top10/aboveAverage/…) | PARTIAL | Medium |
| 5.3 | CF x14 extensions | MISSING-BUILD-CANDIDATE | Medium |
| 5.4 | PivotTable CF | MISSING-BUILD-CANDIDATE | Low |
| 6.1 | Data validations (base) | PARTIAL | High |
| 6.2 | DV x14 extensions | MISSING-BUILD-CANDIDATE | Low |
| 7.1 | PivotTables + caches (import/round-trip) | **HAVE** | High |
| 7.2 | Pivot grouping | PARTIAL | Medium |
| 7.3 | Pivot calculated fields/members | PARTIAL | Medium |
| 7.4 | Pivot x14 / slicer-cache linkage | MISSING-BUILD-CANDIDATE | Medium |
| 8.1 | Charts (base ChartML) | PARTIAL | High |
| 8.2 | Charts x15 + style/color parts | MISSING-BUILD-CANDIDATE | Medium |
| 8.3 | Chart sheets | MISSING-BUILD-CANDIDATE | Low |
| 9.1 | Data model / DAX measures | PARTIAL | Medium |
| 9.2 | Rich types / richValue / cell metadata | PARTIAL | High |
| 9.3 | Dynamic-array metadata | PARTIAL | High |
| 9.4 | LAMBDA/LET `_xlfn` serialization | PARTIAL | High |
| 9.5 | External workbook links | **HAVE** | Medium |
| 9.6 | Connections & query tables | PARTIAL | Medium |
| 9.7 | Power Query mashup part | MISSING-BUILD-CANDIDATE | Medium |
| 10.1 | Defined names | **HAVE** | High |
| 10.2 | Print titles/areas (`_xlnm`) | **HAVE** | Medium |
| 11 | Tables (ListObject) | PARTIAL | High |
| 12.1 | Protection option matrices | **HAVE** | Medium |
| 12.2 | Protected ranges | PARTIAL | Medium |
| 12.3 | Digital signatures | MISSING-BUILD-CANDIDATE | Low |
| 12.4 | VBA / macros (execution) | NOT-APPLICABLE | — |
| 12.5 | ActiveX controls | NOT-APPLICABLE | — |
| 13.1 | Form controls | PARTIAL | Medium |
| 13.2 | Pictures & shapes (native drawings) | PARTIAL | High |
| 13.3 | SmartArt | PARTIAL | Low |
| 13.4 | OLE objects / embedded packages | PARTIAL | Low |
| 14.1 | Outlines / grouping | PARTIAL | Medium |
| 14.2 | Background picture | PARTIAL | Low |
| 14.3 | Merge cells (native) | PARTIAL | High |
| 14.4 | AutoFilter & sortState | PARTIAL | High |
| 14.5 | Sheet views / freeze / custom views | PARTIAL | Medium |
| 14.6 | Rich text runs | PARTIAL | Medium |
| 14.7 | Themes (native part) | PARTIAL | Low |
| 15.2 | Header/footer rich formatting | PARTIAL | Medium |
| 16.1 | Phonetic guides | PARTIAL | Low |
| 16.2 | SmartTags | NOT-APPLICABLE | — |
| 16.3 | Accessibility & doc properties | PARTIAL | Medium |
| 17.1 | Revision logs / shared workbook | NOT-APPLICABLE | — |
| 17.2 | Scenarios (stored in file) | MISSING-BUILD-CANDIDATE | Low |
| 17.3 | Goal seek / Solver / data tables | PARTIAL | Low |
| 17.4 | Data consolidation | PARTIAL | Low |

*Counts check: HAVE 5 (§§7.1, 9.5, 10.1, 10.2, 12.1) · PARTIAL 34 (33 rows above + custom
XML parts / XML maps in the appendix) · MISSING-BUILD-CANDIDATE 10 (§§3.2, 5.3, 5.4, 6.2, 7.4,
8.2, 8.3, 9.7, 12.3, 17.2) · NOT-APPLICABLE 5 (§§12.4, 12.5, 16.2, 17.1 + DDE in the
appendix). Total = 54.*

## Appendix — seed-list items triaged in one line

* **DDE links — NOT-APPLICABLE:** legacy Windows DDEML IPC; `parseDDELink` exists for link
  *parsing* only (FEATURES.md track 20, documented non-goal). No OOXML part to build.
* **Notes vs comments:** covered as one native part in §3.1 (Excel stores notes *as* legacy
  comments); the app's separate notes model is an icecream distinction, not an OOXML one.
* **People / rich-type services:** the service-backed side of §9.2 (entity resolution,
  refresh) exists app-side via providers; the *file-format* side is §9.2's gap.
* **Custom XML parts & XML maps** — folded into §9.7/§16.3 reasoning and counted here:
  **PARTIAL, Importance Low.** `xl/customXml/itemN.xml` + `itemProps` and worksheet
  `<controls>`/XML-map bindings (`xl/xmlMaps.xml`, dataBinding on tables): zero hits in
  the adapter; verbatim save copies customXml parts untouched (preservation-only), classic
  save drops them, and no XML map/binding is parsed or honored. (This is the 34th PARTIAL
  in the §1 count; it has no standalone section because there is no code to cite beyond
  its absence and the verbatim-copy mechanism in §1.2.)
* **Co-authoring parts in-file:** §17.1.
* **Workbook metadata properties (general):** §16.3.

---

## 19. Wave-2 build addendum (2026-10-21, successor coordinator)

Four ranked gaps were built at the adapter layer (parse → typed model →
native write on the classic path → round-trip tests), each verified
firsthand by the successor coordinator after two worker batches were
lost to daemon restarts:

| § | Feature | Wave-2 result |
|---|---|---|
| 3.2 | Threaded comments + persons | **BUILT** — `src/threadedComments.ts` (849 lines, 15 tests): persons part + per-sheet threadedComment parts parsed to a typed model (replies by parentId, mentions, done, dT verbatim), native write incl. workbook/worksheet rels, content types, and the worksheet extLst `x18at:threadedComments` element. NAMED CAVEAT: the extension URI GUID (`{E9A180F0-9CD2-4F85-A628-08839FB49195}`) could not be verified against [MS-XLSX] text from this environment (the rels link, which the Open XML SDK builds on, is authored alongside; unknown ext URIs are ignored by readers). `<presenceInfo>` person children not modeled. App consumption + streaming-path write remain follow-ons, same boundary as wave 1. |
| 11 | Tables (ListObject) | **NATIVE WRITE LANDED** — full-definition import (totalsRowFunction/Label, calculatedColumnFormula, tableStyleInfo, table autoFilter) + `injectTables` emitting real `xl/tables/tableN.xml`, `<tableParts>`, rels, content types (14 tests). Model `ref` wins over sheet extents. Streaming path still preserves-only (see §1.2). Not modeled: table-level cell styles, table `<sortState>`, `<xmlColumnPr>`. |
| 13.2 | Pictures & shapes (native drawings) | **BUILT** — `src/drawings.ts` (899 lines, 14 tests): xdr:pic import (media bytes byte-identical, anchors incl. EMU offsets, alt text), xdr:sp import (preset/fill/line/text), byte-for-byte preservation of original drawing+media through the classic rebuild, and native authoring of pictures AND shapes (read-back identical). Gradient/pattern fills import as null; absoluteAnchor not parsed. |
| 4.3 | Sparklines (x14) | **BUILT** — `src/sparklinesXml.ts` (427 lines, 11 tests): full group model incl. markers, axis min/max, negative colors, date-axis groups; extLst parse + serialize + adapter round-trip. |

**Defect found BY the wave-2 integration gate (fixed, regression-tested):**
activating `attachTablesToSheets` (§11) switched on the pre-existing
`restoreStructuredRefs` in `XlsxAdapter.write`, which emits the
single-bracket this-row shorthand `T[@Col]` — a form the read-side
rewriter did not resolve (only `T[[@Col]]` / `T[[#This Row],[Col]]`).
Every calculated-column cell's formula text changed across a
save → re-read (roundtrip-fidelity failure, beyond-excel-bxl3way.xlsx
Imports D7:D96+). Fix: `resolveStructured` in `tables.ts` now resolves
the single-bracket `[@Col]` inner form; regression assertions added to
`tables-native.test.ts`. This also repairs direct import of real Excel
files whose cells use `[@Col]` (previously left unrewritten for the
engine). Post-fix: tables-native + tables-restore + roundtrip-fidelity
= 33/33 green.

**Also noted:** §8.1's "no native chart write" was already out of date
at wave-2 start — `src/chartsAuthor.ts` (native chart authoring +
`injectChartParts`) exists and its suite passes.

**Updated counts:** MISSING-BUILD-CANDIDATE 10 → 9 (§3.2 built at the
adapter layer; app-layer consumption outstanding). Remaining ranked
build candidates: slicers/timeline native parts (§§4.1–4.2), rich
values (§9.2), dynamic-array spill metadata (§9.3), plus the
cross-cutting app wiring of wave-1/wave-2 native features through the
client save payload, and the medium/low PARTIAL tail.

**Verification caveat (environment):** the adapter integration gate ran
in halves during repeated runtime restarts and a /tmp (512 MB tmpfs)
exhaustion caused by concurrent tracks. Every adapter test file was
run green on the final tree EXCEPT the three corpus-evaluating files
(`audit-v2-full`, `real-world-audit`, `real-world-detail`), whose
vitest workers were killed by the environment on every attempt
(0 ms of tests executed; no assertion failures). Compensating
evidence: a coordinator probe read all 99 real-world files through
the final wave-2 read path (all OK), and roundtrip-fidelity — which
round-trips 10 real files incl. bxl3way — is green. Those three files
passed in the pre-wave-2 baseline (284/284) and should be re-run on a
quiet machine to close the gate formally.
