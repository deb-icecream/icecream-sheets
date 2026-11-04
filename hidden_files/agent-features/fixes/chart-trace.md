# FIX-F — Native Chart Trace (case 4) — READ-ONLY

Trace date: 2026-10-21. Repo: `~/workspace/icecream-sheets`. No code changed.
Brief bar (BRIEF.md case 4): prompt → agent inserts a **native** chart into the
sheet, bound to sheet data, visible in the grid; save → reopen → still present
and bound. COORDINATION.md F4 adds: parse-back of the downloaded file is the
bar; do not fake it via the web store.

## Verdict up front

- **No native chart-authoring implementation exists anywhere in the repo.**
  The premise in the tasking ("follow the adapter chart-authoring code used by
  local saves") is false: local saves never author a chart part. A UI-created
  chart survives save/reopen **only as JSON in a custom document property**
  (`icecream.chartspecs`), never as `xl/charts/chartN.xml`. Excel would show
  nothing. This is the single most important correction in this report.
- **No hard blocker / no store redesign is required.** Charts are package
  parts, not engine cells, at every layer of this codebase (adapter metadata,
  verbatim streaming save). The engine service session already owns the two
  things authoring needs — the retained source package (`state.sourceBytes`)
  and the save serializer — so the missing store is one in-memory session
  field in `engineSvc`, following existing patterns. `EngineWorkbook` /
  HyperFormula never need to know charts exist.
- **GO (conditional)** for building in this workstream, after FIX-B
  (agent↔engine binding) lands, with a fail-closed v1 kind subset.
  Estimated ~1,300–1,700 lines including tests across 6 packages — a small
  feature, not a fix. NO-GO for any chartspecs-only shortcut (see §4.0).

---

## 1. LOCAL-MODE SAVE — what serializes chartStore specs into the .xlsx?

**Nothing serializes them into chart parts. There is no spec→chart-XML
mapping in the codebase.**

The actual chain for a UI-created chart:

1. Create: ribbon `insert.chart` (`apps/web/src/App.tsx:7829`) →
   `handleInsertChart` (`App.tsx:3270`) → `ChartDialog` →
   `handleCreateChart` (`App.tsx:3288`) commits the `ChartSpec` to App state
   and to the localStorage chart store (`persistCharts`,
   `apps/web/src/features/chartStore.ts:51` → service `createChartStore`,
   `packages/service/src/metadataStore.ts:142`).
2. Save (local/desktop in-tab path): `buildDownloadBytes`
   (`App.tsx`, `applyClientSaveMetadata`) writes
   `wbData.metadata[CHART_SPECS_METADATA_KEY] =
   pivotChartSpecsToMetadata(charts, …)` (`App.tsx:6317-6321`). That function
   (`apps/web/src/features/importedCharts.ts:565`, key
   `icecream.chartspecs` at `importedCharts.ts:557`) JSON-serializes **all**
   specs (the name is historical; pivot bindings are converted to
   pivot-name form, everything else passes through verbatim).
3. `XlsxAdapter.write` (`packages/xlsx-adapter/src/adapter.ts:694`) persists
   every `icecream.*` metadata key as a **custom document property**:
   `custProps['IcecreamSheets.Meta.' + key] = JSON.stringify(value)`
   (`adapter.ts:702-716`, prefix constants `adapter.ts:238-243`). The result
   lands in `docProps/custom.xml`. No `xl/charts/*`, no `xl/drawings/*`, no
   sheet `<drawing>` element is ever emitted for an app-authored chart.
4. Reopen: `pivotChartSpecsFromMetadata` (`importedCharts.ts:585`) restores
   the specs and the app re-renders overlays (`App.tsx:5624-5635`). The
   round-trip is app-private: the file contains no chart Excel can see.

### What chart code *does* exist in the adapter

- **Import only.** `packages/xlsx-adapter/src/charts.ts` is a parser:
  `readCharts(files)` (`charts.ts:569`) walks sheet rels → drawing part →
  `twoCellAnchor` → chart part and extracts kind / barDir / title /
  per-series `catFormula`+`valFormula` / caches / trendlines / anchor /
  `pivotSource`. Header (`charts.ts:1-20`) says so explicitly.
- The adapter's own read-side comment concedes the write side drops native
  charts: imported charts are carried through metadata *"so charts — and
  their trendlines — survive an app save, which drops drawing parts via
  SheetJS"* (`adapter.ts:586-603`). On re-read, if the package has no native
  charts, the stored `icecream.charts` custom-property hint is kept instead
  of `[]` (`adapter.ts:596-600`) — metadata round-trip, not parts. The test
  suite pins exactly this: "trendlines survive read → write → read **via the
  metadata channel**" (`packages/xlsx-adapter/tests/charts.test.ts:380-402`).
- **One genuine XML serializer fragment exists:** `serializeTrendlineXml`
  (`charts.ts:317-331`) — emits one `<c:trendline>` element; round-trip
  tested (`charts.test.ts:330-365`). It is a building block, not a chart
  author: no `chartSpace`, no series, no axes, no drawing, no rels.
- Gateway mode changes nothing above: UI charts reach the server save as
  the same `icecream.chartspecs` string inside `extraMetadata`
  (`buildServerSaveExtras`, `App.tsx:6394ff`, which deletes only the pivot /
  SmartArt / external-link keys), are merged into the save metadata in
  `runDirectSave` (`packages/gateway/src/services/engineSvc.ts` metadata
  merge, `engineSvc.ts:2036-2045`), and are written as custom properties by
  `mergeCustomPropsXml` (`packages/xlsx-adapter/src/streamingSave.ts:429`)
  on the verbatim path or by the adapter custprop loop on fallback.

**Q1 answer: no real chart-authoring implementation exists. It must be
written new (§4), reusing the parser as its inverse oracle plus the
SmartArt/Pivot injection scaffolding (§5).**

---

## 2. GATEWAY-MODE MODEL — how does the engine service hold chart parts?

### 2.1 At load: charts become metadata JSON; part bytes live only inside `sourceBytes`

- Parse: `XlsxAdapter.extractZipMetadata` sets
  `metadata['icecream.charts'] = JSON.stringify(readCharts(zip))`
  (`adapter.ts:586-600`, key `CHARTS_METADATA_KEY` at `charts.ts:114`).
  The parsed `ImportedChart[]` (kind, series formulas, caches, anchor,
  pivotSource) is the only chart representation the session model ever
  holds by name.
- Unlike pivots and SmartArt, **chart/drawing part bytes are NOT stashed
  separately**: pivots stash raw parts under `xlsx.pivotParts` and SmartArt
  under `xlsx.smartartParts` (`adapter.ts:607-634`); there is no
  `xlsx.chartParts`. Chart parts survive only implicitly, inside the whole
  retained package:
- `EngineState.sourceBytes` — *"the retained source bytes of the last
  successful /load … the direct streaming serializer copies UNTOUCHED parts
  of this package byte-for-byte"* (`engineSvc.ts:668-687`; assigned in the
  load tail, `engineSvc.ts:~3498`). The parsed metadata mirror is
  `state.sourceMetadata` (`engineSvc.ts:527-541`).

### 2.2 Parts are addressed by zip path inside the serializer, never by the session model

`serializeLiveWorkbook` (`packages/service/src/save/directSave.ts:383`,
input contract `directSave.ts:159-184`) unzips `sourceBytes` into a
`files: Record<string, Uint8Array>` path→bytes map (`directSave.ts:521-524`),
resolves worksheet parts via `formulaRecoverySheetPartPaths`, and in
`serializeVerbatim`'s assembly loop copies **every part not explicitly
regenerated byte-for-byte** (`directSave.ts:659-695`: generated sheet parts,
styles, workbook.xml, custom.xml and [Content_Types].xml are the only
special cases; everything else — including `xl/charts/*`,
`xl/drawings/*`, their `.rels` — goes through `verbatimChunks`,
`directSave.ts:685`). Two preservation details matter for §4:

- A *changed* sheet keeps its chart: `splitSheetXml`
  (`streamingSave.ts:94-108`) splits the source sheet XML at `<sheetData>`,
  so the `<drawing r:id="…"/>` element (which sits after `</sheetData>`)
  survives in the tail when the sheet part is regenerated.
- A chart is lost only if its sheet is deleted/renamed (sheet-set change →
  adapter fallback, `directSave.ts:471-481`) — the SheetJS fallback drops
  all drawing/chart parts, same as local mode.

So "untouched parts verbatim" is keyed purely by **zip entry path string**
in the source package. There is no part registry, no part id, and no API
surface over parts.

### 2.3 Is there ANY op or API that adds/replaces a part or a chart? No.

- Engine op vocabulary: `EngineCommand` is a closed union of 21 commands —
  cells, sheets, calc mode, names, named functions, row/col inserts only
  (`packages/engine/src/protocol.ts:69-92`). No chart, drawing, part, or
  metadata command. `EngineEvent` likewise has no chart event
  (`protocol.ts:97-101`).
- Collab mapping: `cmdToCollabOp` returns `null` for anything outside
  cell/structural basics (`engineSvc.ts:392-423`), so a hypothetical new
  command would get no rebase/delta semantics for free.
- Save journal: `SAVE_MUTATING_OPS` (`engineSvc.ts:725`) mirrors the same
  21-name set (copy in `directSave.ts:186ff`); unknown commands are not
  journaled, get no revision (`runExecuteInternal`, `engineSvc.ts:~3345`:
  non-`SAVE_MUTATING_OPS` executes return with no revision/delta), and are
  invisible to the changed-sheet derivation.
- Engine-service HTTP surface (route dispatch `engineSvc.ts:3691-5030`):
  `/load[/stream|/storage-ref]`, `/execute`, `/ops`, `/deltas[/ack]`,
  `/revisions`, `/presence[/leave]`, `/read`, `/snapshot`, `/events`,
  `/sheets`, `/language`, `/download`, `/library[-save]`, `/reset`,
  `/protection/*`, `/session/*`. **No `/charts`, no part endpoint.** The
  closest existing channel is `POST /session-extras`
  (`engineSvc.ts:3779-3814`), which accepts exactly four presentation keys
  (`sheetStyles`, `sheetDims`, `definedNames`, `extraMetadata`) into
  `state.pendingExtras` (`engineSvc.ts:600-612`) — client→server,
  replace-per-key, hash-dirtied, merged under per-request extras at save.
  It is how gateway UI charts' `chartspecs` already reach autosave (§1),
  and it proves the *plumbing pattern* for session-held save content — but
  it carries no native-part semantics.
- MCP surface: 38 tools, none for charts (recon §3; tool registrations
  `packages/mcp-server/src/server.ts:370-1840`). `createServer(host?,
  options?)` (`server.ts:228`) takes a concrete `EngineHost` plus an
  options bag with injectable seams — the pattern to copy is
  `DataSourceServerOptions.sqlDriver` (`server.ts:160-176`): an optional
  injected capability that **fails closed with a clear error when absent**
  (`packages/service/src/connectors/sql.ts`, per recon §5).

**Q2 answer: the session model holds charts only as (a) parsed metadata
JSON in `sourceMetadata` and (b) opaque bytes inside `sourceBytes`,
addressed by zip path at save time. No op, endpoint, or journal entry can
add or replace a part or a chart. That link must be built — but it can be
built entirely inside `engineSvc` + the save serializer (§4).**

---

## 3. GRID RENDERING in gateway mode — from what data?

- The grid never renders chart *parts*. It renders `ChartSpec[]` from React
  state: `const [charts, setCharts] = useState(() => restoreCharts())`
  (`App.tsx:824`, localStorage store), filtered by
  `ch.range.sheet === activeSheet` and painted as `ChartOverlay`s in the
  grid's overlay layer (`App.tsx:7899-7925`), reading live cell values
  through `chartReaderForSheet` / `extractSeries` on every tick — i.e. the
  overlay is *bound live by range*, not by cached part data.
- In gateway mode those specs arrive **once, at load**: `/load[/stream]`
  returns `file.metadata` (`EngineLoadResponse.file.metadata`,
  `engineSvc.ts:~1150ff`, binary-safe via `encodeMetadataForJson`), and
  `hydrateOpenedWorkbook` converts `icecream.charts` →
  `importedChartToSpec` and merges `icecream.chartspecs` restorations
  (`App.tsx:5573-5635`). There is **no charts list endpoint and no
  re-fetch**: `RemoteEngineHost` exposes no chart call, and `App.tsx` never
  re-reads metadata after hydration.
- SSE deltas cannot carry a chart today. The `/deltas` channel has exactly
  five event kinds — `hello`, `delta` (cells only, `DeltaCell[]`),
  `status`, `presence`, `session` — subscribed in
  `apps/web/src/services/collabTransport.ts:459-497`. `session` kinds are
  `structure | load | reset | release | fenced`
  (`collabTransport.ts:104-108`; emitted at `engineSvc.ts:3403, 3502,
  4623, 5004`), and `RemoteEngineHost.applySessionEvent`
  (`apps/web/src/services/remoteEngine.ts:810-830`) maps them to sheet-name
  refresh / view-cache clear / reset only. A `charts` payload would fall
  into the `default:` arm (bare `recalcComplete`) and be ignored as data.
  The legacy `/events` poll (`engineSvc.ts:4329`) carries `EngineEvent`s,
  which have no chart type either (§2.3).

**Q3 answer: rendering data = load-time metadata → App `charts` state.
If a chart part enters the session model server-side today, connected
clients would render nothing new until a full reload. The minimal refresh
path is a new SSE `session` event kind (`charts`, carrying the full
session chart-spec list) plus an App-side callback — both have direct
precedents: `broadcastSession` (`engineSvc.ts:1478`) and the
`onParticipants`/`onStatus` callback pattern in `CollabTransportDeps`
(`collabTransport.ts:178`). No new transport is needed.**

---

## 4. THE MINIMAL CORRECT BUILD

### 4.0 What does *not* satisfy the bar (rejected shortcuts)

- **MCP tool → web chartStore / `icecream.chartspecs` only.** That is
  exactly what a UI-created chart already does (§1). It round-trips in our
  app but authors no part: `readCharts()` on the downloaded file returns
  `[]` for it, and Excel shows nothing. Calling that "native" would repeat
  the wiring-report §3 caveat as a false pass. **Rejected.**
- **New `EngineCommand` (`addChart`) through `EngineHost`/`EngineWorkbook`.**
  The workbook model has no drawing concept; this forces protocol union +
  executeInner + save-pin gate + collab mapping + three mirrored
  `SAVE_MUTATING_OPS` sets + journal replay semantics for a payload the
  engine never reads. Maximum surface, zero benefit. **Rejected** — the
  chart lives in the *package* layer, and the package owner in gateway
  mode is `engineSvc` + `serializeLiveWorkbook`, not the engine.

### 4.1 Design (one new session store, one new authoring module, one new event)

```
AgentChat prompt
  → planner (FIX-A schemas + create_chart in allowlist)
  → MCP create_chart  ──ChartSink seam──▶  agentSvc sink (FIX-B session resolver)
                                              │  POST {engine}/charts  (session token)
                                              ▼
                              engineSvc: state.sessionCharts[]  (sequenced,
                              revision++, journaled, SSE session{kind:'charts'})
                                              │
              ┌───────────────────────────────┼────────────────────────────┐
              ▼                               ▼                            ▼
   web: onCharts → setCharts          runDirectSave passes          checkpoint /
   (visible in grid, live-bound)      charts → serializer           rehydrate keep
                                              │
                          ┌───────────────────┴───────────────────┐
                          ▼                                       ▼
              verbatim path: author chart+drawing        adapter fallback:
              parts as generated entries, anchor         XlsxAdapter.write →
              sheet forced changed + <drawing>           injectChartParts()
                          └───────────────────┬───────────────────┘
                                              ▼
                       downloaded .xlsx contains xl/charts/chartN.xml;
                       readCharts() parse-back = the proof
```

#### (a) MCP tool — `packages/mcp-server/src/server.ts` (~110 lines + seam ~25)

```ts
create_chart {
  sheet: string,                 // anchor + (default) data sheet
  range: string,                 // A1 form, e.g. "A1:C5" — parsed by
                                 // chartModel.parseA1Range (chartModel.ts:685)
  kind: 'column-clustered' | 'column-stacked' | 'bar-clustered' |
        'line' | 'line-markers' | 'area' | 'pie' | 'doughnut',
  title?: string,
  anchor?: string,               // A1 cell for top-left; default = below/right
                                 // of the data range; size fixed 8 cols × 15 rows
  principal?: string
}
```

- Handler validates against the bound host exactly like `analyze_data`
  does (`server.ts:1515ff`): sheet exists, range within used range, ≥1
  numeric data column (via authorized `engine.readRange`, #PERM! cells
  excluded) — fail with a specific error, never invent a chart over empty
  data (case 6 honesty posture).
- Builds the spec with the service factory `makeChartSpec`
  (`packages/service/src/chartModel.ts:366`): `range` from the A1 parse,
  `seriesRanges` derived per §5, `anchorCells` from `anchor` + fixed size,
  `x/y/w/h` fallback geometry exactly as `importedChartToSpec` computes it
  (`importedCharts.ts:460-468`: col×64, row×20, min 240×180).
- Delivery goes through a new optional seam, mirroring the SQL-driver
  pattern (§2.3): `ServerOptions.charts?: ChartSink` where
  `ChartSink = { addChart(spec, principal): Promise<{id, revision}> }`.
  **Absent sink → tool returns `errorResult('chart insertion is not
  available in this host (no workbook session bound)')`** — fail closed,
  never a private-store write. Local/stdio mode keeps failing closed
  until someone wires a local sink (out of scope; local mode already has
  the UI path).
- Planner reachability (depends on FIX-A/FIX-B workstreams, listed for
  completeness): add `create_chart` to `DEFAULT_ALLOWED_TOOLS`
  (`packages/service/src/agent/openaiBackend.ts:44-56`) and to the
  FIX-A tool-schema prompt block; heuristic intent for "chart/graph/plot
  … of <range>" in `backends.ts` is a stretch goal (~40 lines), not
  required if the live planner is the Vertex backend.

#### (b) EngineHost surface it needs

Deliberately **not** `EngineHost`. The MCP server needs exactly two host
capabilities, both of which it already uses for other tools: authorized
range reads for validation (existing `engine.readRange`) and sheet
existence (`engine.sheetNames()` via the pivot/analysis paths). The chart
itself needs **no engine surface at all** — that is the central finding
of §2. The new surface is on the *session* (engineSvc), below.

#### (c) Engine-service endpoint + session store — `engineSvc.ts` (~180 lines)

- New state field, next to `sourceMetadata`/`pendingExtras`:
  `sessionCharts: ChartSpec[]` (specs authored this session, in creation
  order). Lifecycle: cleared in `registerSession`; on `buildFromData`,
  seeded from the loaded file's *native* charts? **No** — imported charts
  already have parts in `sourceBytes` and are preserved verbatim; seeding
  them would double-author. Seeded **only** from charts this build itself
  authored in a previous life of the session: on rehydrate, the snapshot
  bytes contain authored parts, so verbatim preservation covers them and
  `sessionCharts` correctly restarts empty (see dedup rule in (d) for
  the one case that matters — a *second* save in the *same* session,
  where `sourceBytes` is still the pre-chart original: `sessionCharts`
  is still populated, so re-authoring reproduces the same parts
  deterministically; part numbering must therefore be a pure function
  of (source package, spec list) — first free `chartN` in spec order).
- `POST /charts { spec }` (session-scoped like `/session-extras`,
  editor-role only): validate the spec shape manually in the
  `isServerNamedRangeRef` style (`engineSvc.ts:~940ff`) + kind ∈
  authorable subset + sheet exists in `state.host.sheetNames()`. Then,
  **inside `enqueueSequenced`** (the one FIFO, `engineSvc.ts:1628`):
  append to `sessionCharts`, assign `state.revision++`, push a journal
  entry `{ revision, op: { cmd: 'chart.add', spec }, delta: [], origin }`,
  `pendingCheckpointOps++` + `armAutosaveCheckpoint()` (so server
  AutoSave materializes it without any client save call — same treatment
  as ops and extras), and `broadcastSession({ kind: 'charts', revision,
  charts: sessionCharts })`. Reply `{ ok, id, revision }`.
  - Journal replay: `rehydrateSession`'s replay loop
    (`engineSvc.ts:~2890ff`) currently feeds every entry to
    `state.host.execute(...)`, which would reject `chart.add`. Add one
  branch: `cmd === 'chart.add'` → re-append to `sessionCharts`, skip
  host execute. One branch, ~10 lines; deltaLog entry carries
  `collab: null, cells: []` (catch-up clients receive the `charts`
  session event on reconnect/hello — see (e)).
  - Save-pin interaction: none needed. A chart accepted while a save is
    pinned has revision > `pinnedRev`, so it is correctly absent from
    that save and present in the next batch — the revision model already
    defines this; do not queue it behind the pin.
  - Fencing/role gates: reuse the route preamble (signed token, file
    scope, viewer-role refusal) exactly as `/ops` does
    (`engineSvc.ts:4033-4060`).

#### (d) Part authoring — NEW `packages/xlsx-adapter/src/chartsAuthor.ts` (~380 lines)

There is no adapter code to "reuse" for the chart XML itself (§1); the
reusable assets are the parser (inverse oracle), one fragment serializer,
and two injection scaffolds:

- `buildChartXml(spec, series): string` (~200 lines) — the only genuinely
  new authoring code. Emits a minimal-but-valid `c:chartSpace`:
  `c:chart` → `c:title` (rich text, shape per `charts.ts:429`'s reader),
  `c:autoTitleDeleted val="0"`, `c:plotArea` → kind element + `c:catAx` /
  `c:valAx` pair, `c:legend`, `c:plotVisOnly`. Per series: `c:ser` →
  `c:idx`, `c:order`, `c:tx` (strRef to the header cell when the series
  came from a range column, else rich literal), `c:cat`
  (`strRef`/`numRef` with `c:f` + `strCache`/`numCache`), `c:val`
  (`numRef` with `c:f` + `numCache` incl. `formatCode` + `ptCount`),
  trendlines via the existing `serializeTrendlineXml` (`charts.ts:317`).
  Kind mapping is the inverse of `ooxmlKindToChartKind`
  (`apps/web/src/features/importedCharts.ts:55-109`):
  column-* → `barChart`(+`barDir col`, `grouping clustered|stacked`),
  bar-* → `barChart`(+`barDir bar`), line* → `lineChart`
  (markers → `c:marker` symbol), area → `areaChart`, pie → `pieChart`,
  doughnut → `doughnutChart`(+`c:holeSize`). Scatter/bubble need
  `xVal/yVal` + separate axes semantics and combo/stock/3D/SVG kinds
  (chartModel.ts `isSvgKind`) have no faithful single-part form — the
  tool rejects them (§a); widening the table later is additive.
  Series formulas and caches come from §5's derivation; caches are
  computed from caller-supplied live values (serializer bulk / adapter
  rows), so first paint in Excel and in our own importer (which reads
  caches, `charts.ts:403-426`) is correct before any recalc.
  The test fixture shape for a valid minimal package already exists:
  `packages/xlsx-adapter/tests/charts.test.ts:25-47` (`minimalPackage`)
  is effectively the acceptance template — authored output must parse
  through `readCharts` to the same kind/title/formulas/anchor.
- `authorChartParts(files, charts)` (~180 lines) — package surgery on a
  path→bytes map, cloned from the two existing scaffolds:
  `injectSmartArtParts` (`smartart.ts:648`) for drawing authoring —
  `buildDrawingXml`'s `twoCellAnchor` construction (`smartart.ts:602-632`,
  with `<c:chart r:id>` inside `a:graphicData` in place of `dgm:relIds`),
  `freePartPath` (`smartart.ts:596`), drawing/rels/content-type helpers
  (`smartart.ts:560-594`) — and `injectPivotParts`
  (`pivotTables.ts:1021`) for the part-add + content-type + sheet-rel
  pattern. Per anchor sheet it must handle **both** cases:
  (i) sheet has no drawing: create `xl/drawings/drawingN.xml` + its
  `.rels`, add the sheet→drawing rel, add content-type overrides, and
  report the drawing rId so the sheet XML gains `<drawing r:id="…"/>`;
  (ii) sheet already has a drawing (imported chart / SmartArt /
  picture): parse its XML as text, **append** the `twoCellAnchor`, and
  append the chart rel to the existing drawing `.rels` — a sheet may
  have only one drawing part, so creating a second is the classic
  corruption this step exists to avoid.
- Serializer integration — `packages/service/src/save/directSave.ts`
  (~250 lines):
  - `DirectSaveInput` gains `charts: ChartSpec[]` (`directSave.ts:159`);
    `engineSvc.runDirectSave` passes `state.sessionCharts`
    (`engineSvc.ts:2191` call site).
  - Verbatim path: anchor sheets are forced into the `changed` set
    (`directSave.ts:531-545` derivation — one line: union of
    `charts[].range.sheet`), and `sheetXmlChunks` gains a
    `drawingRid?: string` option (`streamingSave.ts:173-188, 241`):
    when set and the source tail has no `<drawing`, emit
    `<drawing r:id="…"/>` at the head of the tail (immediately after
    `</sheetData>`; note the schema-order caveat — `mergedCells` /
    `dataValidations` also live post-`sheetData` and precede `drawing`
    in strict CT_Worksheet order; Excel tolerates the common case, and
    the parse-back + `verifyXlsxPackage` gate in (f) is the arbiter —
    if a fixture with merged cells fails verification, the fallback is
    to route chart-bearing saves through the adapter path below for
    v1 and log it). Chart/drawing/rels parts (new or merged) become
    generated entries in the assembly loop alongside the existing
    styles/workbook/custom special cases (`directSave.ts:659-695`), and
    [Content_Types].xml gains the chart/drawing overrides via the
    existing `ensureContentTypeOverride` (`streamingSave.ts:550`).
    **Dedup rule (idempotence):** before authoring, run `readCharts`
    over the source `files` map; skip any spec whose (anchor sheet,
    title, multiset of series `valFormula`s) matches an existing part —
    this makes save #2, rehydrate-then-save, and the
    imported-chart-on-same-sheet case all non-duplicating.
  - Adapter-fallback path: `serializeViaAdapter` (`directSave.ts:~760ff`)
    calls the bytes-level wrapper `injectChartParts(bytes, charts)`
    (unzip → `authorChartParts` → `zipSyncStable`, the
    `injectPivotParts` shape) after `XlsxAdapter.write`. Fallback already
    drops imported parts, so dedup is trivially satisfied there.
  - Desktop logged-out mode uses the same `serializeLiveWorkbook` with
    `charts` absent/empty → byte-identical behavior to today.

#### (e) Client refresh path — `apps/web` (~60 lines)

- `CollabTransportDeps` gains `onCharts?: (charts: ChartSpec[]) => void`
  (pattern: `onParticipants`, `collabTransport.ts:178`); the SSE
  `session` listener routes `kind === 'charts'` to it
  (`collabTransport.ts:487-497`). `SessionEventData.kind` is already an
  open union (`collabTransport.ts:104-108`) — no protocol break.
- `App.tsx` wires `onCharts` where it constructs the transport: merge by
  spec id into `setCharts(...)` + `persistCharts(next)` — the same two
  calls `handleCreateChart` makes (`App.tsx:3289-3303`). The overlay then
  renders bound to live data through the existing reader; no other
  render change. Co-clients get the identical event (it is a
  `broadcastSession`, not a unicast).
- Reconnect/hello: a client that missed the event re-syncs on its next
  full load (load metadata now includes the authored chart as a native
  import — self-healing by construction). A `hello`-time charts echo is
  a 5-line nice-to-have in the `/deltas` subscribe handler
  (`engineSvc.ts:4127ff`); not required for case 4's single-browser bar.
- One hygiene line: specs delivered this way should be excluded from the
  client's `icecream.chartspecs` save extra, or reopening a file that has
  both a native part and a chartspecs twin renders **two** overlays (the
  load-time merge dedups only on exact spec id, `App.tsx:5627-5635`,
  while the imported twin gets a fresh id). Add `nativePart?: boolean`
  to `ChartSpec` (`chartModel.ts:315-361`, +`makeChartSpec` pass-through),
  set it in the engineSvc spec and in `importedChartToSpec`, and skip
  `nativePart` specs in `pivotChartSpecsToMetadata`
  (`importedCharts.ts:565-577`). (Side benefit: this also stops
  imported-chart specs from being double-carried on every save today.)

#### (f) Save/reopen proof (the bar, in order)

1. **Adapter unit proof:** `buildChartXml` + `authorChartParts` on a
  synthetic package → `readCharts(files)` returns exactly one chart with
  the expected kind, title, `catFormula`/`valFormula`, anchor; a package
  with an existing drawing (reuse `trendline-demo.xlsx` fixture parts)
  gains a second anchor in the *same* drawing part.
2. **Service proof:** fixture workbook (headers + 4 numeric rows) →
  `/load` → `POST /charts` → `/download` → unzip assertions (chart part
  exists; parse-back as in 1) + the save's own `verifyXlsxPackage` step
  passes (`engineSvc.ts` verify step in `runDirectSave`).
3. **Idempotence proof:** download #1 bytes → `/load` into a fresh
  session → `/download` → still exactly one chart part, no `chart2.xml`
  duplicate, specs equal.
4. **Live tour (coordinated dist window, after FIX-B):** prompt in the
  real AgentChat ("Insert a column chart of A1:C5 on Sheet1 titled …")
  → transcript shows `create_chart ok` → grid screenshot: overlay
  visible on the sheet → download → reopen (second browser) →
  screenshot: overlay present → edit a data cell → overlay re-renders
  with the new value (live binding) → second download's `numCache`
  reflects the edited value.

### 4.2 Change surface estimate

| Package | Change | ~Lines (incl. tests) |
|---|---|---|
| `packages/xlsx-adapter` | NEW `chartsAuthor.ts` (chart XML + package surgery), `index.ts` exports, `chartsAuthor.test.ts` | 380 + 250 |
| `packages/service` | `chartModel.ts` `nativePart` flag; `save/directSave.ts` input + verbatim integration + fallback hook; `directSave.test.ts` additions | 280 + 120 |
| `packages/gateway` | `engineSvc.ts`: state field, `POST /charts`, journal/replay branch, serializer pass-through; `engineSvc` tests | 200 + 100 |
| `packages/mcp-server` | `create_chart` tool + `ServerOptions.charts` sink seam; tool tests | 135 + 80 |
| `packages/gateway` (agentSvc) | ChartSink impl over FIX-B's session resolver (HTTP to engine `/charts`) | ~60 |
| `packages/service` (agent) | `openaiBackend.ts` allowlist (+1 line) / FIX-A schema entry | ~10 |
| `apps/web` | `collabTransport.ts` `onCharts`; `App.tsx` wiring; `importedCharts.ts` skip-native in metadata writer | ~70 |
| **Total** | | **~1,700 (of which ~450 tests)** |

### 4.3 The one link that is *not* buildable as-is — and why it isn't this plan's problem

Nothing in the chain requires redesigning a store. The two near-misses,
stated precisely:

1. **The agent's MCP server cannot reach the session today** (recon
   Headline 5 / probe §5: `agentSvc.ts:141-145` still builds
   `createServer(undefined, …)` → private `EngineHost`). `create_chart`'s
   sink therefore has no session to target until FIX-B lands its
   registry resolver + session-aware `runtimeFor`. The tool is designed
   to fail closed in that world (§a), so FIX-F's build can land and be
   service-proven (steps f1–f3) before FIX-B, but **case 4's live tour
   (f4) is gated on FIX-B**. This is a dependency, not a blocker in the
   chart chain itself.
2. **Journal replay** is the only place the "charts aren't engine ops"
   decision costs anything: one explicit branch (§c). If a future
   workstream insists every journaled op be an `EngineCommand`, that
   *would* force the rejected design in §4.0 — flag it now so the
   revision-model owner ratifies the `chart.add` journal kind when the
   endpoint is built.

Known limitations accepted for v1 (not blockers): row/col structural ops
after chart creation do not rewrite the authored series formulas or
anchor (the same is true of imported charts under the verbatim save
today); chart *editing/deletion* by the agent is out of scope (UI delete
of a nativePart overlay will not remove the part on the next server save
— the dedup rule resurrects it as an imported overlay; deleting
session-authored charts server-side is a follow-up `DELETE /charts/:id`);
multi-chart same-sheet ordering follows spec creation order.

---

## 5. PivotCharts / imported-chart reuse, and how charts bind to data

- **PivotCharts author nothing.** `packages/service/src/pivotChart.ts`
  is a binding + derivation module only: `PivotChartBinding { pivotId,
  valueIndex }` (`pivotChart.ts:16-21`), `pivotResultToSeries`
  (live result → `ChartSeries`), and the file form
  `PivotChartFileBinding { pivotName, valueIndex }` (`pivotChart.ts:47-52`)
  that rides inside `icecream.chartspecs`. An imported PivotChart is a
  regular chart part carrying `<c:pivotSource>` (parsed at
  `charts.ts:462-472`), converted by `importedPivotChartToSpec`
  (`importedCharts.ts:474-520`). **Reusable for the plan:** the
  name-based file binding pattern and the conversion functions — not any
  authoring code, because there is none. The v1 tool should *reject*
  pivot-bound requests (no `pivot` in its args): a native PivotChart part
  requires a real pivot table part + cache in the package, a strictly
  larger build.
- **Imported-chart handling is the plan's oracle and template:** the
  parser (`readCharts`), the kind mapping
  (`ooxmlKindToChartKind`, `importedCharts.ts:55`), the anchor/geometry
  conversion (`importedChartToSpec`, `importedCharts.ts:422-472`), the
  minimal valid package fixture (`charts.test.ts:25-47`), and
  `serializeTrendlineXml` (`charts.ts:317`). SmartArt supplies the
  drawing-authoring scaffold (§4.1d); pivots supply the post-SheetJS
  injection scaffold (`injectPivotParts`, `pivotTables.ts:1021`).
- **Binding model (so the tool args carry the right thing).** A
  `ChartSpec` (`chartModel.ts:315-361`) binds data three ways, in
  renderer precedence order:
  1. `seriesRanges?: ChartSeriesRange[]` (`chartModel.ts:270-278,
     330-338`) — per-series `{ name, cat: ChartRange|null, val:
     ChartRange }`, each range `{ sheet, startRow, startCol, endRow,
     endCol }` (0-based, `chartModel.ts:262-268`). The renderer builds
     series from these directly (`extractSeriesFromRanges`,
     `chartModel.ts:469`), bypassing layout heuristics. **This is the
     form the authored XML maps to 1:1** (`cat` → `c:cat/c:f`,
     `val` → `c:val/c:f`, `name` → `c:tx`), so the tool should populate
     it: for a range `A1:C5` with a header row, series *i* = 
     `{ name: <header cell text>, cat: A2:A5, val: <col_i>2:<col_i>5 }`.
  2. `range: ChartRange` — the single contiguous block; the renderer's
     `extractSeries` (`chartModel.ts:416`) applies Excel's layout
     convention (first text row = series names, first text column =
     categories). The tool still sets it (union of the series ranges,
     sheet = anchor sheet) because overlay filtering and several
     consumers read only `range` (`App.tsx:7899` filter).
  3. `pivot?: PivotChartBinding` — live pivot derivation instead of
     ranges (rejected for v1, above).
  Plus `cachedSeries` (first-paint cache from the part's own
  `numCache`/`strCache`, `chartModel.ts:~352-360`) — the authored part's
  caches play this role on reopen, which is why §4.1(d) writes real
  caches, and `anchorCells { fromCol, fromRow, toCol, toRow }`
  (`chartModel.ts:~330-336`) — the authored `twoCellAnchor`, 1:1.
  Hence the tool args in §4.1(a) — `{ sheet, range (A1), kind, title,
  anchor }` — are sufficient: everything else in the spec is derived
  deterministically by `makeChartSpec` + the series derivation above,
  and everything in the XML is derived from the resulting spec + live
  values at save time.

---

## Recommendation

**GO** — build §4 in this workstream, sequenced:

1. xlsx-adapter authoring + adapter/service proofs (f1–f3) — independent
   of every other fix stream, land first.
2. engineSvc `/charts` + session store + SSE `charts` event + web wiring.
3. MCP `create_chart` + sink seam (fail-closed until wired).
4. Live tour (f4) **after FIX-B** binds the agent runtime to the engine
   session and FIX-A gives the planner the tool's schema; re-mint the
   Vertex token per COORDINATION.md when touring.

**NO-GO** on shipping case 4 as "validated" by any path that does not put
`xl/charts/chartN.xml` in the downloaded bytes with `readCharts`
parse-back — including the chartspecs/metadata path, which is the
product's existing (legitimate, but app-private) chart persistence and
must not be relabeled "native".
