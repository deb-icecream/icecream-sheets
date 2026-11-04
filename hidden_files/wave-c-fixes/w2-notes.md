# W2 — Generated app renders heading, body blank (case 3b)

Worker: W2 focused fix worker, started 2026-10-22 ~05:32 PDT
Brief: hidden_files/wave-c-fixes/BRIEF.md item W2

## Diagnosis
- Case-3b artifact (artifact_mvjegmj6_2, template 'custom' = LLM path): source
  starts `function App() {` and calls `mcp.call('read_cells', {sheet:
  BINDING.sheet, …})` + `setData(result.cells)`. Evidence:
  cases/case-03b/artifact-source-head.txt + transcript.json srcInfo.
- HOP 1 PROVEN BROKEN (code-read): `BINDING` is defined NOWHERE for LLM apps.
  - TemplateAppGenerator prepends `var BINDING = {…};` (generator.ts
    bindingPrelude, line ~138) — template apps work.
  - LlmAppGenerator.generate (llm.ts) returns the raw model source with NO
    prelude, while its own buildPrompt contract (llm.ts:262) promises the
    model "A global BINDING = {…} is pre-defined; use it." TestCodeGenBackend's
    CANNED_TEST_APP has the same defect (uses BINDING, defines nothing).
  - The frame host does NOT inject it either: artifactFrame.ts BRIDGE_PRELUDE
    runs the source via new Function('React','h','useState','useEffect',
    'useRef','mcp', …) — no BINDING param, no window.BINDING global — even
    though every validated ArtifactSpec carries spec.binding (spec.ts).
  - Effect: evaluating the read_cells args throws ReferenceError inside the
    async fetchData → unhandled rejection, setData never runs, data stays []
    → static heading renders, body blank. Exactly the observed symptom, and
    it also explains the shell-integration seeded-app shape (same lane).
- HOP 2 PROVEN BROKEN (code-read): live binding event name. The model wrote
  `mcp.subscribe(['cell_changed'], …)` (singular). MCP subscribe validates
  events against a zod enum (mcp-server server.ts ~941: 'cells_changed',
  'recalc_complete', 'sheet_added', 'sheet_removed') — 'cell_changed' fails
  validation → ArtifactBridgeHost.createBinding swallows the error → NO
  subscription → sheet→app updates can never fire. The LLM prompt contract
  never names the valid event types.
- HOP 3 PROVEN BROKEN (code-read): prelude subscribe return shape.
  BRIDGE_PRELUDE's mcp.subscribe returns a bare unsubscribe FUNCTION; the
  generated app (natural pattern) keeps the return value and calls
  `subscription.unsubscribe()` in effect cleanup → TypeError on unmount.
  Templates use `return unsub;` (function form) — the two conventions must
  both work.
- Hops verified SOUND: MCP read_cells returns {cells: primitives[][]} via
  TypedView.toJson (mcp-server server.ts toJsonMatrix) — matches app usage
  row[1]/parseFloat(row[2]); gateway /api/agent/tools/call (agentSvc
  FIX-E) + runtime.callTool unwrap correctly; bridge host stamps principal
  and posts results back. No shape mismatch on the read path.
- Fix layer (decided): the frame host is where the "pre-defined BINDING"
  promise must be kept — buildArtifactSrcDoc gains the spec binding and
  the prelude defines window.BINDING before the app source runs (heals
  already-stored LLM artifacts; template apps' inner `var BINDING` still
  shadows with identical values). Plus prelude subscribe: alias-normalize
  'cell_changed'→'cells_changed' and return an unsubscribe fn that also
  has .unsubscribe. Plus llm.ts prompt contract: name exact event types +
  subscribe return contract (future generations).

## Reproduction (2026-10-22 ~05:4x PDT, BEFORE fix)
- Harness: w2-repro/repro.mjs — evaluates the REAL BRIDGE_PRELUDE extracted
  from artifactFrame.ts in a vm with stub React/ReactDOM + a host stub that
  answers read_cells with the 13-row fixture and validates subscribe events
  against the MCP zod enum. App source = case-3b shape (BINDING read +
  'cell_changed' subscribe + subscription.unsubscribe() cleanup).
- RESULT (exit 1): host log EMPTY (no bridge call ever posted);
  `unhandledRejection: BINDING is not defined`; 0/12 fixture rows rendered.
  The rows die at hop 1, inside the frame, before any MCP traffic — proven.

## Fix
- LANDED (source, verified on disk after exec aborts):
  1. apps/web/src/components/artifactFrame.ts:
     - buildArtifactSrcDoc gains optional 4th param `binding?: ArtifactBinding`;
       when present the prelude defines `var BINDING = {sheet,startRow,startCol,
       endRow,endCol,columns}` (JSON, '<'-escaped) before the app source runs —
       the host now keeps the generation contract's "pre-defined" promise.
       Template sources' inner `var BINDING` shadows it with identical values.
     - BRIDGE_PRELUDE mcp.subscribe: normalizes 'cell_changed'→'cells_changed'
       before posting; returns an unsubscribe function that also carries
       `.unsubscribe` (self) so both cleanup conventions work.
  2. apps/web/src/components/ArtifactHost.tsx: ArtifactFrame passes
     spec.binding into buildArtifactSrcDoc.
  3. packages/service/src/artifacts/llm.ts buildPrompt contract: names the
     exact subscribe event enum, the {cells} primitive-matrix result shape,
     and the subscribe return contract (future generations).
- Repro AFTER fix (w2-repro/repro.mjs, exit 0): read_cells posted with the
  exact binding args; subscribe posted as ['cells_changed'] → MCP-accepted;
  12/12 fixture rows rendered; effect cleanup via subscription.unsubscribe()
  clean, no errors.
- Regression tests LANDED:
  - apps/web artifactFrame.test.ts +5 (binding injection present/absent +
    functional vm execution suite: read args, alias normalization, cleanup).
    RUN: 9/9 PASS (2026-10-22 ~05:50 PDT).
  - packages/service artifactLlm.test.ts +1 (prompt contract pins).
    RUN: artifacts+artifactLlm+artifactGallery = 61/61 PASS.
  - packages/service tsc --noEmit CLEAN.
  - Web tsc --noEmit: CLEAN (background run completed, TSC_EXIT=0,
    /tmp/w2-web-tsc5.log; earlier foreground attempts were OOM/aborted by
    the runtime under shared-stack memory pressure, no diagnostics).
  - Gateway agentArtifacts.test.ts: 6/6 PASS (retry after runtime abort).

## Validation — W2 VERDICT: PASS (2026-10-22 ~07:05 PDT)
- Unit/regression (all on the fixed tree):
  - apps/web artifactFrame.test.ts 9/9 PASS (incl. functional vm suite:
    host-defined BINDING read args, 'cell_changed'→'cells_changed'
    normalization, subscription.unsubscribe() cleanup).
  - apps/web AppsGallery.test.tsx + AppViews.test.ts 13/13 PASS.
  - packages/service artifacts+artifactLlm+artifactGallery 61/61 PASS;
    appbuilder 40/40 PASS; gateway agentArtifacts 6/6 PASS.
  - tsc --noEmit: service CLEAN; web CLEAN (TSC_EXIT=0).
- Mechanism repro (w2-repro/repro.mjs, real BRIDGE_PRELUDE in a vm):
  BEFORE fix: host log empty, `BINDING is not defined`, 0/12 rows.
  AFTER fix: read_cells posted with exact binding args, subscribe
  normalized + accepted, 12/12 rows, cleanup clean (exit 0).
- LIVE case-3b scenario re-run (w2-live/tour-w2.mjs, isolated stack:
  real-repo dists on ports 8930-8938, own data dir/secrets; web dist
  built from the FIXED source served on :4274; shared 8100 stack never
  restarted — its engine was busy with another program's live session,
  so the run used my own stack per the brief):
  - Artifact seeded in the exact case-3b shape (LLM 'custom' source;
    data path verbatim from case-03b evidence). Generation itself was
    already proven in case 3b and is not the layer under test.
  - A1 panel opens from Apps tab: PASS. A2 app renders fixture rows:
    PASS — 11/11 distinct revenue values + North/South; screenshot
    app-initial.png inspected by me: heading + header + all 12 rows
    with exact values.
  - B1 sheet→app two-way binding: PASS (run 6, tour-w2-isolated6.log):
    engine /ops setCell C2=12777 → 200 rev 1; engine read-back 12777
    verified BEFORE polling; app data row showed 'Jan | North | 12777'
    via the subscription re-read; screenshot app-after-sheet-edit.png
    inspected: header clean, Jan|North|12777, all other rows exact.
  - B2 fixture restored (C2 op back to 12000, read-back verified): PASS.
  - result.json verdict PASS (TOUR_EXIT=0).
  - FALSE-POSITIVE CAUGHT + CORRECTED (run 5, evidence preserved as
    run5-*): a keyboard grid edit landed in A1 (panel overlays the grid)
    producing 'Month12777' in the header, which the app DID live-reflect
    (itself proof the subscription path works) but was NOT the required
    C2 revenue reflection; B1 was re-proven cleanly in run 6 via the
    engine op path with the exact-row assertion. Run 5's B1 assertion
    as recorded there should be read with this caveat.
  - Scope note: the case-3b app is a read-only viewer (no inputs), so
    app→sheet editing is not exercisable on it; the brief's two-way
    criterion (edit sheet → app reflects) is the proven direction.
    Bridge write_calls remain covered by artifacts.test.ts.
- Cleanup: isolated stack + static servers stopped; shared stack
  untouched throughout (no restarts, no config posts, no releases of
  other programs' sessions).

## Log
- 2026-10-22 ~05:32 PDT: notes skeleton created; read BRIEF.md, agent-rerun REPORT.md, planner-fix REPORT.md checkpoints.
- Coordination note: grounding gate on disk in packages/service/src/agent/runtime.ts (do not touch agent runtime/planner files); planner-fix delta not yet landed in real repo. W2 path is artifact frame / app binding / MCP read — avoid shared agent-stack restarts; use isolated ports for live validation.
- 2026-10-22 ~07:05 PDT: W2 complete — verdict PASS (see Validation). Files changed: apps/web/src/components/artifactFrame.ts, apps/web/src/components/ArtifactHost.tsx, apps/web/src/components/artifactFrame.test.ts, packages/service/src/artifacts/llm.ts, packages/service/tests/artifactLlm.test.ts. NOT pushed (per brief).
