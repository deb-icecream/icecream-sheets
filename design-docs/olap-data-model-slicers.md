# OLAP data-model slicers and live pivot queries

Status: design only (owner-ordered 2026-10-24). Governs the feature that removes
the bxl3way slcYear status-bar notice. Binding like other design docs: do not
rescope it to client-local reality, do not ship stubs.

## 1. The problem, with the file as evidence

File: `test-data/real-world/beyond-excel-bxl3way.xlsx`.
Symptom: opening it shows, in the status bar, "Some imported filter controls
could not be rendered (1): slicer 'slcYear' on 'Dashboard': OLAP slicer
'Slicer_Year' has no worksheet column; it filters pivots only."

File facts (read from the file's own XML, 2026-10-24):

- `xl/slicers/slicer2.xml`: slicer `slcYear`, caption "Year", cache
  `Slicer_Year`, level 1.
- `xl/slicerCaches/slicerCache1.xml`: cache `Slicer_Year`,
  sourceName `[tblCal].[Year]`, `<olap>` data with levels
  `[tblCal].[Year].[(All)]` and `[tblCal].[Year].[Year]`, members
  2012–2021. It lists the pivot tables it filters: `pvtEarnings`,
  `pvtCF`, `pvtYoY`, `pvtCpR` (all Dashboard pivots).
- `xl/connections.xml`: connection `ThisWorkbookDataModel`
  (`<dbPr command="Model">`, type 5) plus worksheet range connections
  that feed the model from sheet ranges.
- `xl/model/item.data` (~970 KB): the embedded Power Pivot tabular
  model itself.
- The other slicer in the same file, `slcType`, is a table slicer
  (`x15:tableSlicerCache tableId="16" column="2"`) and already works:
  it filters a worksheet table column directly.

So nothing is missing from the file and nothing failed to download.
The notice is honest: the app has no way to drive an OLAP slicer yet.

## 2. The three missing pieces

### Piece 1 — A live pivot-query engine (engine package)

Today pivots arrive as frozen results: the adapter reads pivot
definitions plus cached values, and charts render from those cached
series. The engine has a cube registry that CUBE formulas query, but
those cubes are built FROM pivot output, not from a live model.
Nothing can answer a new question such as "Year = 2015, recompute
these four pivots."

Build: a query module in `@icecream-sheets/engine`, beside the
existing cube registry. Input: a pivot definition (rows, columns,
values, filters) plus a slicer selection. Output: a fresh result
matrix. It queries the model from Piece 2; it never touches the
formula recalc chain.

### Piece 2 — A data-model source the engine can query (adapter → service → engine)

Do NOT start by parsing the `item.data` binary blob. That format is
the hard, later step. For this file — and for the general first
phase — build the model from what the file already declares in
plain XML:

- Tables from worksheet ranges, via the connections the adapter
  already parses (`connections.ts`, `CONNECTIONS_METADATA_KEY`).
- Hierarchies and members from the slicer caches the adapter
  already parses (`slicersTimelines.ts`), e.g. `[tblCal].[Year]`
  with members 2012–2021.
- Relationships and measures from the pivot cache definitions and
  the connections.

Placement: adapter parses (already done for connections and slicer
caches) → service builds and registers the model (extend the
existing `registerDataModelCubes` in `packages/service/src/cubeDataModels.ts`)
→ engine holds it per session and answers Piece 1 queries against it.

Phase 2 (later, only for models whose tables are NOT backed by sheet
ranges): a reader for `xl/model/item.data`.

### Piece 3 — Slicer-to-pivot binding and refresh (web app)

Today the mapper (`apps/web/src/features/nativeSlicersTimelines.ts`)
marks OLAP slicers unresolved because they have no worksheet column,
and slicer filtering in the grid is row-hiding (`slicerPasses`).
OLAP filtering is query-based, a different path.

Build: the mapper binds an OLAP slicer to the pivot ids its cache
already lists (for slcYear: pvtEarnings, pvtCF, pvtYoY, pvtCpR)
instead of marking it unresolved. A selection change sends the
selection to the engine, the engine re-queries those pivots through
Pieces 1 and 2, and the pivot charts and pivot tables re-render.
The status-bar notice disappears when all three pieces land; until
then it stays as the honest placeholder.

## 3. Non-negotiable constraints (owner, 2026-10-24)

- NO REGRESSION of any existing functionality. The implementation
  is strictly additive and gated: the new code runs ONLY for files
  that actually carry data-model/OLAP parts. Every other file takes
  the exact same code path as today.
- NO PERFORMANCE REGRESSION of the existing app. The model is built
  ONCE, at open, on the server (never on the UI thread, never per
  click), cached per session, and freed when the session is
  released. A slicer click is one query over the cached model,
  engine-side, refreshing only the affected pivots and charts.
  Files without a model pay nothing: no build, no query, no memory.
- Existing behavior that must not change: table slicers and
  timelines (new mapper branch for OLAP only); the formula engine;
  CUBE formula resolution (live pivot query is a separate new path,
  used only for slicer-driven refresh); open must never break
  because model building failed (best-effort, like all adapter
  metadata parsing today).
- SAVE CONSTRAINT: saving a file must carry the model parts
  (connections, caches, the model blob) through untouched, or Excel
  loses the data model on round-trip. Prove round-trip before
  shipping; this is part of the design, not an afterthought.

## 4. Acceptance (all required before the feature closes)

1. Unit tests for each piece (adapter parsing, service model build,
   engine query, web mapper binding), plus the existing slicer,
   pivot, cube, and gateway suites green.
2. No-regression legs, browser-proven on a local stack:
   bxl3way values cell-by-cell (2,954 cells, zero mismatches),
   its four Dashboard charts, its table slicer (63 values, filter
   works), and open speed (TTFP) unchanged.
3. VISUAL validation with the same file, mandatory and separate
   from tests: open `beyond-excel-bxl3way.xlsx` in a real browser,
   screenshot the Dashboard with the slcYear panel, click years,
   and screenshot the pivots/charts filtered — the panel must show
   and the charts must visibly respond. A test-only proof does not
   close this feature.
4. The status-bar notice for slcYear is gone on this file, with no
   new notice elsewhere; a file without a data model shows no
   change whatsoever.
5. No live/production actions during validation; deploy follows
   the standing validate-before-deploy rule.

## 5. Relationship to other work

- This is a FEATURE, tracked separately from the Release 1 web
  stabilization sweep. It does not gate the pending deploy wave.
- It builds on, and must not disturb: the #69 slicer/timeline work,
  the #110/#111 join chart hydration, the #108 gateway-attached
  agent binding, and the #104 per-call engine auth gates.
- Excel resolves this file with no error because it ships the
  data-model engine. Google Sheets does not resolve it live either
  (no Power Pivot engine; its pivot import covers table-range
  pivots, not data-model OLAP) — it drops or flattens the slicer
  instead of reporting it. Parity target here is Excel.
