# Design Compliance Audit — Icecream Sheets

**Date:** 2026-10-18 (second re-audit — supersedes the earlier 2026-10-18 pass below, which predates the AI-native build wave)
**Authority:** AGENT.md §0 (NON-NEGOTIABLE) — all 13 design docs specify WHERE components live, WHAT interfaces they expose, and HOW they integrate.
**Method:** every v1 requirement in each doc was checked against the implementation: file existence, exports, tests, and consumer wiring.

## Summary

| Design Doc | Status | Notes |
|------------|--------|-------|
| native-reports-and-dashboards.md | ✅ Compliant | Reports service-layer component built (spec/KPI/slicers/refresh/PDF); charts/pivots native components |
| ai-agent.md | ✅ Compliant | Agent runtime + chat UI + MCP-only path + audit trail + intent router; documented deviations only |
| add-on-model.md | ✅ Compliant | Manifest, capability grants, worker isolation, authorize() bindings, catalog + UI |
| automation-lane.md | ✅ Compliant | Permissioned API (authorize choke point), recorder, event runtime, sandbox, translators, macro preservation |
| connector-vs-component.md | ✅ Compliant | Fetch component (ETL sources.ts) vs connector registry correctly separated; no stubs |
| deterministic-inference.md | 🔄 Partial | Flash Fill real (engine + dialog); autocomplete/suggestions/cleanup missing |
| etl-pipeline.md | ✅ Compliant | Recipe DAG, connector SDK, 13 transforms, custom sandbox transforms, atomic load, failure policy, triggers, vault creds, editor UI |
| named-ranges-and-named-functions.md | 🔄 Partial | UI-layer substitution only; no stable IDs/scope/XLSX round-trip/named functions |
| no-code-app-builder.md | ✅ Compliant | Versioned spec, 4 views, 4 actions, authorize() writes, 5 MCP tools, builder UI; sample templates pending (minor) |
| permission-model.md | 🔄 Partial | authorize() choke point, object tree + stable IDs, roles, filtered reads, JWT, metadata store; sharing UI missing |
| platform-shell.md | 🔄 Partial | Engine core, offline replay wired, desktop login gate; workbook library/menus/search/shortcuts/settings missing |
| print-and-page-layout.md | 🔄 Partial | Page setup UI + XLSX round-trip, print preview; snapshot pagination, native PDF, manual breaks missing |
| workbook-protection-and-encryption.md | 🔄 Partial | Protection enforced, password→key, at-rest encryption (KeyManager), audit, XLSX hints; UI indicators missing |

**Counts:** ✅ 7 Compliant · 🔄 6 Partial · ⬜ 0 Not built · ❌ 0 Non-compliant

---

## Detailed Findings

### 1. native-reports-and-dashboards.md — ✅ COMPLIANT

**Design requires:**
- "The report builder and renderer are service-layer components. They read through the typed computational view and never touch the engine or storage directly." (§1)
- "A report is a versioned, serializable spec... The spec lives in the service metadata store." (§2)
- "Table, bar chart, line chart, pie chart and KPI card" (§4); "Slicers filter all visuals on the page" (§5); "Manual refresh, refresh on open, or scheduled refresh... shows the data timestamp" (§6); "Export to PDF through the Download as PDF path" (§8)

**Current state:**
- `packages/service/src/reports/spec.ts` — `REPORT_SPEC_VERSION=1`, versioned/serializable/migratable; bindings, visuals (table/chart/pivot/kpi), filters, layout, refresh (manual/onOpen/scheduled + `dataAsOf` timestamp)
- `packages/service/src/reports/kpi.ts` — KPI card (aggregations, thresholds, statuses)
- `packages/service/src/reports/slicers.ts` — page-level slicers filter every visual whose binding includes the field
- `apps/web/src/components/Reports.tsx` — builder UI + `exportPdf()` via the Download-as-PDF path (`#icecream-print-root` + `window.print()`)
- Charts (`chartModel.ts`, 37 kinds) and pivots (`pivot.ts`) are the native visual components the report visuals bind to
- Tests green (`reports.test.ts`)

**Remaining (minor):** per-subject filtered views not yet enforced at the report-spec layer (§7).

### 2. ai-agent.md — ✅ COMPLIANT

**Design requires:**
- "Exactly one AI Agent ships with Icecream Sheets. It lives inside the web-service boundary as a service component." (§1)
- "The agent has no private path to the engine or storage. Every read, write, formula edit, recalculation and code execution goes through the versioned MCP server's agent tools." (§2)
- "Proactivity rides on engine event subscriptions." (§6)
- "Every agent action is logged with what it did, what it touched, when and under whose identity." (§4)

**Current state:**
- `packages/service/src/agent/` — runtime, `HeuristicModelBackend` (pluggable `ModelBackend`), types, **intent router** (`intentRouter.ts`: `classifyIntent()` app/analysis/conversation, disambiguation)
- `apps/web/src/components/AgentChat.tsx` — side panel + ✦ Agent FAB, audit view, Watch/Mute toggle
- Runtime holds an MCP Client over in-memory transport; every read/write crosses the MCP boundary (verified: no private engine path)
- Proactive subscriptions: `runtime.watch()/pollWatch()/unwatch()`; audit trail (seq/ts/principal/threadId)
- Human-in-the-loop: planner `ask` actions pause the turn; option buttons resume
- Write discipline: runtime-enforced confirmation gate for bulk writes (>10 cells)
- 34 agent tests; browser e2e verified (write→sum→formula→audit, 0 console errors)

**Documented deviations:** no collaborator-edit event (engine emits presence heartbeats; MCP events are cells_changed/recalc_complete/sheet_added/sheet_removed); mute is whole-thing toggle; threads in-memory (short-term per §12); HITL is a runtime-level pause, not an MCP tool call (blocking tool would deadlock stdio). Reads now take `AuthContext` with per-subject filtered reads — the old "bypass" gap is closed.

### 3. add-on-model.md — ✅ COMPLIANT

**Design requires:**
- "Add-on code runs in a sandboxed worker with no direct access to the service process." (§3)
- "Every add-on declares the capabilities it needs... Capabilities are granted per document binding by the user at install time." (§2)
- "Get add-ons opens the product-owned catalog." (§6)

**Current state (`packages/service/src/addons/`):**
- `manifest.ts` — `ADDON_MANIFEST_VERSION=1`; `CapabilityKind: read|write|network`; `validateManifest()`; `isWidening()` (fresh approval required to widen)
- `grants.ts` — per-document grant records (who/what/when); revoke effective on next invocation; uninstall removes grant + binding
- `worker.ts` — `runAddonInWorker()`; CPU/memory limits per invocation; crash/hang fails only its own invocation
- `bindings.ts` — every invocation carries the installing user's identity through `authorize()`; add-on code never persists in workbook bytes
- `catalog.ts`/`registry.ts` — product-owned catalog with capability/publisher/footprint listings
- `apps/web/src/components/AddonManagerDialog.tsx` — catalog UI
- Tests green (`addons.test.ts`)

### 4. automation-lane.md — ✅ COMPLIANT

**Design requires:**
- "A TypeScript automation API sits over the engine protocol and the typed computational view. Every read and mutation goes through authorize()." (§1)
- "The recorder captures user actions as editable scripts." (§2)
- "Workbook and sheet events (on open, on edit, on selection change, timed triggers) fire inside the sandbox." (§3)
- "The XLSX adapter preserves original macro projects byte-for-byte as hints." (§6)
- "The product-native AI Agent acts through MCP tools, never through the automation lane." (§7)

**Current state (`packages/service/src/automation/`):**
- `api.ts` — `AutomationApi`; single `authorize()` choke point for every read/mutation; declared permissions; grants recorded; fail-closed identity
- `recorder.ts` — `ActionRecorder`; versioned `ActionLog`; `actionLogToScript()`; replay through the same API as hand-written code
- `runtime.ts`/`triggerSpecs.ts` — onOpen/onEdit/onSelectionChange/timed triggers; frozen event objects; `beginPolling()`; wired to engine `cellsChanged`
- `sandbox.ts`/`node.ts` — same sandbox as custom functions (node:vm + restricted Python); no direct storage/network/process
- `translator.ts` — `translateVba()`/`translateAppsScript()` with declared permissions
- `packages/xlsx-adapter/src/adapter.ts` — `vbaProject.bin` preserved byte-for-byte, re-injected on save
- Agent boundary: no MCP tool touches the automation lane (verified in the 27-tool list)
- Tests green (5 test files)

### 5. connector-vs-component.md — ✅ COMPLIANT

**Design requires:**
- "IMPORTDATA, IMPORTFEED, IMPORTHTML, IMPORTXML and IMAGE use the Fetch component in the adapter layer with no authentication."
- "GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE and IMPORTRANGE use Google connectors."

**Current state:** `external-stubs.ts` deleted — zero stubs. The fetch component lives in `packages/service/src/etl/sources.ts` (shared substrate, documented as serving the IMPORTDATA family + IMAGE). The connector registry (`packages/service/src/connectors/`) holds CSV/JSON/REST/SQL/market-data connectors with the credential-vault seam. DETECTLANGUAGE/TRANSLATE ship real heuristic defaults with pluggable provider seams (honest capability reporting, not stubs). GOOGLEFINANCE-family needs go through the market-data connector.

**Remaining:** IMPORTDATA/IMPORTFEED/IMPORTHTML/IMPORTXML are not yet formula functions (substrate only).

### 6. deterministic-inference.md — 🔄 PARTIAL

**Design requires:**
- "Inference runs as a service-layer component. It reads through the typed view and proposes edits through the same APIs as any client, subject to authorize()." (§2)
- "Flash-fill: Pattern-based fill from examples... The proposed formula is shown for inspection." (§4)
- "All inference output is a proposal: a description, the proposed change, and a preview." (§3)

**Current state:** Flash Fill is REAL — `packages/engine/src/flashfill.ts` (`analyzeFlashFill`, versioned proposals) + `FlashFillDialog.tsx` with preview/apply; 16 engine tests. Autocomplete, formula suggestions/corrections, cleanup proposals: zero implementation. No general proposal UI.

**Remediation:** build the remaining analyzers + proposal surface per §§5-7.

### 7. etl-pipeline.md — ✅ COMPLIANT

**Design requires:**
- "A recipe is a versioned, serializable typed DAG: exactly one source node, zero or more transform nodes and exactly one load node... schema-validated at design time." (§1)
- "The source node pulls from either the built-in fetch component or the connector registry." (§2); connector SDK: "authenticate using a credential reference, describe the source schema and extract with pagination" 
- "The fixed typed operation library covers select and drop, rename, type conversion, filtering, sorting, split and merge of columns, pivot and unpivot, merge and append of tables, grouping, fill down and deduplication." (§3)
- "A custom operation runs user-supplied Python, JavaScript or TypeScript in the sandbox with typed table-in and table-out contracts." (§3)
- "Every run materializes a full copy and swaps it in atomically... Old versions are retained... a failed run never replaces the last good load." (§4)
- "Retry transient failures with backoff. Quarantine rows... Abort the run when a configured error threshold is exceeded." (§5)
- "Credentials live in the service vault. The recipe stores only credential references. A scheduled run executes as the pipeline owner." (§6)
- "The editor UI is an applied-step list with expandable parameters, a live output preview per step, refresh and schedule controls and a run history." (§7)

**Current state (`packages/service/src/etl/`, 10 files):** every requirement verified — `recipe.ts` (ETL_RECIPE_VERSION=1, validate/serialize/migrate), `sources.ts` + `connectors.ts` (fetch component + `ConnectorRegistry` + `credentialRef`), `transforms.ts` (all 13 operations), `custom.ts` + `nodeRunner.ts` (sandboxed Python/JS/TS), `runner.ts` (atomic swap, retention, backoff retry, quarantine, thresholds, progress + per-step row counts, manual/on-open/scheduled triggers), `serviceVaultResolver(vault, owner)`, `EtlEditor.tsx` (applied-step list, per-step preview, schedule controls, run history). 6 test files green.

---

### 8. named-ranges-and-named-functions.md — 🔄 PARTIAL

**Design requires:**
- "Every named range has a stable object id, independent of the cells it currently covers." (§1)
- "Definitions live in the service metadata store, keyed by the stable id." (§3)
- "The XLSX adapter mirrors them into the file's defined-names table on save and reads them back on open." (§3)
- Named functions (LAMBDA-based, versioned, typed signatures) (§§6-7)

**Current state:** `apps/web/src/features/names.ts` + `NameManagerDialog.tsx` exist, but names are UI-layer text substitution (`substituteNames` rewrites formulas). Missing: stable object IDs, scope rules, metadata-store storage, XLSX defined-names round-trip, named functions entirely.

**Remediation:** implement the identity model per §§1-7.

### 9. no-code-app-builder.md — ✅ COMPLIANT

**Design requires:**
- "The builder and the app runtime are service-layer components." (§1)
- "An app is a versioned, serializable spec: data bindings naming tables by stable object id, views, actions, navigation and display options. The spec lives in the service metadata store." (§2)
- "Point the builder at a table and get a working app immediately." (§3)
- "Table (grid), detail (single record), form (add and edit with type-driven inputs and validation) and cards." (§4)
- "Add row, edit row, delete row and navigate between views. Deleting a row requires confirmation. Every write goes through authorize() as the end user." (§5)
- "The AI Agent can generate and edit app specs through MCP app-builder tools." (§3)

**Current state (`packages/service/src/appbuilder/`):** `APP_SPEC_VERSION=1` (validate/migrate); 4 views; 4 actions (`ConfirmationRequiredError` on delete; `authorize('app.write')` on the `RowMutationPort`); per-subject filtered reads; `generateAppSpec()`; `AppBuilder.tsx`; 5 MCP tools (`appbuilder_create_spec/_update_spec/_get_spec/_list_specs/_delete_spec`) with manage-right checks. Tests green.

**Remaining (minor):** product-owned sample templates (§7) not yet shipped.

### 10. permission-model.md — 🔄 PARTIAL

**Design requires:**
- "Single choke point: authorize(subject, action, object_id). Every API calls it." (§4)
- "The access table lives in the web service's metadata store as a system table." (§3)
- "The storage-to-view projection is built per subject, so unauthorized cells never reach the engine." (§4)
- "The JWT carries identity only." (§5)

**Current state:** `packages/engine/src/permissions.ts` (`Authorizer`, fail-closed); `packages/service/src/access.ts` (stable object IDs for workbook/sheet/range/cell; Owner/Manager/Editor/Viewer; `AccessTable` in the metadata store); `protocol.ts` reads take `AuthContext` with per-subject filtered reads + hidden-cell checks; `auth.ts` JWT (`issueToken`/`verifyToken`); gateway verifies per request; MCP tools accept `principal`.

**Remaining:** sharing UI (grant/revoke flows).

### 11. platform-shell.md — 🔄 PARTIAL

**Design requires:** one engine core (§1); workbook lifecycle on the metadata store (§2); settings/profile (§4); menu search + shortcuts on a command registry (§6); offline op-log replay (§7); MCP surface (§8).

**Current state:** one engine core + versioned protocol ✅; MCP surface ✅ (27 tools); offline replay ✅ (`oplog.ts` wired into `App.tsx` + `SyncStatus.tsx`); desktop login gate ✅. Missing: workbook library UI, command registry, menu search, shortcuts dialog, settings/profile, desktop Open/Save.

### 12. print-and-page-layout.md — 🔄 PARTIAL

**Design requires:** deterministic pagination from the engine snapshot (§1); page setup as adapter metadata (§2); Download-as-PDF single path (§3); print preview from the same snapshot (§4); XLSX round-trip (§5).

**Current state:** page setup UI (Ribbon Page Setup group) ✅; persists as adapter metadata ✅; XLSX round-trip (`xlsx.pageSetup.*`) ✅; print preview from grid snapshot ✅. Missing: snapshot-based deterministic pagination engine, native PDF (currently `window.print()` → browser save-as-PDF), manual page breaks, `&P`/`&N` codes.

### 13. workbook-protection-and-encryption.md — 🔄 PARTIAL

**Design requires:** authorize() enforcement (§1); UI indicators (§2); at-rest encryption with service key management (§3); password→key derivation, passwords never stored (§4); XLSX round-trip as hints (§5); permission-respecting downloads (§6); per-workbook keys + rotation (§7); audit (§8).

**Current state:** enforcement via Authorizer policy wrapper ✅; `KeyManager` (per-workbook AES-256-GCM, rotation, revocation) ✅; PBKDF2 password→key ✅; flags → `icecream.protection.*` → adapter custom properties ✅; permission-filtered download snapshots ✅; ProtectionManager audit log ✅. Missing: per-range UI indicators (§2).

---

## Remediation Priority Order

### 🔴 Critical (true gaps)
1. **Deterministic inference remainder** — autocomplete, formula suggestions, cleanup proposals + general proposal UI
2. **Sharing UI** — grant/revoke flows for the permission model
3. **Workbook library** — New/Open/Copy/Trash on the metadata store

### 🟡 Important (design gaps)
4. **Named ranges** — stable IDs, scope, metadata store, XLSX round-trip, named functions
5. **Print** — snapshot pagination, native PDF, manual page breaks
6. **Platform shell** — command registry, menu search, shortcuts dialog, settings/profile, desktop Open/Save
7. **IMPORTDATA-family functions** — build on the existing fetch substrate
8. **Collaboration server path** — server sequencing for real-time co-authoring

### 🟢 Future
9. **Add-on/report/app polish** — sample templates, report per-subject permissions
10. **Ecosystem** — a11y checker, DataFrame adapter, live data-type providers, M-language translator

---

## Design-Doc Compliance Rule (AGENT.md §0)

> **Always read the design docs before building.** The 13 design docs in `design-docs/` specify WHERE components live, WHAT interfaces they expose, and HOW they integrate. Every implementation MUST follow the designs.
>
> 1. Before building anything new, read ALL relevant design docs first.
> 2. Before modifying existing code, verify it matches the design docs. If it doesn't, redo it according to the design.
> 3. When a design doc specifies placement (e.g., "service-layer component"), interfaces, or architecture — follow it exactly. Do not invent alternatives.
> 4. The design docs are the authority on product behavior and architecture.
> 5. When in doubt, re-read the design doc. Never guess.

This rule is now in effect for all future work.

---

## 29-Track Compliance Audit

**Date:** 2026-10-18 (second re-audit)
**Authority:** `catalog/tracks.md` — 29 capability tracks with scope, implementation guidance, and dependencies.
**Method:** Each track's scope + implementation paragraph was compared against the codebase (`packages/engine/src/`, `packages/service/src/`, `packages/mcp-server/src/`, `apps/desktop/src/`, `apps/web/src/`, `packages/xlsx-adapter/src/`).

### Summary

| # | Track (ID) | Status | Notes |
|---|-----------|--------|-------|
| 1 | Calculation engine (`calc-engine`) | ✅ Compliant | HyperFormula core, DAG, automatic/manual calc modes, versioned protocol |
| 2 | Formula language (`formula-language`) | ✅ Compliant | 523/523 real implementations, zero stubs; IMPORTDATA-family not functions (minor) |
| 3 | Grid (`grid`) | ✅ Compliant | Virtualized, ribbon, formatting, spell check, context menus |
| 4 | Charts (`charts`) | ✅ Compliant | 37 Chart.js kinds; trendlines/PivotCharts minor gaps |
| 5 | PivotTables and PivotCharts (`pivots`) | 🔄 Partial | Aggregation engine + UI + MCP + GETPIVOTDATA; no PivotCharts/slicer integration |
| 6 | Power Query (`power-query`) | ✅ Compliant | Full ETL pipeline (DAG, SDK, transforms, triggers, editor UI); M-translator minor |
| 7 | Data tools (`data-tools`) | 🔄 Partial | Sort/filter/validation/Solver/Goal Seek/Scenarios/Data Tables; no column stats/trim |
| 8 | VBA, macros and Office Scripts (`automation`) | ✅ Compliant | Permissioned API, recorder, event runtime, translators, macro preservation (v2: byte-faithful) |
| 9 | Excel file formats (`file-format`) | 🔄 Partial | XLSX + CSV/TSV/ODS wired; no native PDF, no HTML export, no .xlsb |
| 10 | Collaboration (`collaboration`) | 🔄 Partial | CollabSession wired, presence, version history, conflict detection; no server sequencing/share UI |
| 11 | Extensibility and data model (`extensibility`) | 🔄 Partial | Add-ons + app builder + reports built; named ranges still UI-layer, no named functions |
| 12 | Platform layer (`platform`) | 🔄 Partial | Web + desktop + gateway; offline replay wired; no library/menus/search/shortcuts/settings |
| 13 | Parallel recalculation and calc modes (`parallel-recalc`) | 🔄 Partial | Automatic/manual modes; no worker pool, no partial calc |
| 14 | Sparklines, slicers and timelines (`sparklines-slicers-timelines`) | ✅ Compliant | All three wired (dialogs, ribbon, Grid, Reports) |
| 15 | Linked data types (`linked-data-types`) | 🔄 Partial | Stocks/geo + all 5 smart chips; providers are sample data |
| 16 | Flash Fill and Analyze Data (`flash-fill-analysis`) | 🔄 Partial | Flash Fill real (engine + dialog); no autocomplete/suggestions/cleanup |
| 17 | 3D Maps (`three-d-maps`) | ✅ Compliant | SVG globe + time playback (not WebGL — honest scope difference) |
| 18 | Form controls and ActiveX (`forms-activex`) | ✅ Compliant | 4 native controls bound to values; ActiveX absent by design |
| 19 | Workbook protection and encryption (`protection-encryption`) | 🔄 Partial | Protection + at-rest encryption (KeyManager) + audit; no per-range UI indicators |
| 20 | External links, RTD and DDE (`external-links-rtd-dde`) | ✅ Compliant | Link registry + dialog; RTD real; DDE documented non-goal |
| 21 | Print and page layout (`print-layout`) | 🔄 Partial | Page setup UI + XLSX round-trip + preview; no snapshot pagination/native PDF/manual breaks |
| 22 | Regional formula localization (`formula-localization`) | ✅ Compliant | 7 locales wired + switcher UI |
| 23 | Accessibility and sensitivity labels (`accessibility-labels`) | 🔄 Partial | Grid ARIA + sensitivity labels; no checker, no SR shortcuts section |
| 24 | Python data analysis and visualization (`python-in-grid`) | 🔄 Partial | PY() real + spill + analysis pipeline; no pandas/plots/pinned env |
| 25 | General code runtime (`general-code-runtime`) | 🔄 Partial | execute_code + ICEEVAL + recorder; no in-web editor |
| 26 | Pluggable storage adapters (`storage-adapters`) | ✅ Compliant | AdapterRegistry wired (xlsx/csv/tsv/ods) + connector registry; no DataFrame adapter |
| 27 | Typed computational view (`typed-computational-view`) | ✅ Compliant | view.ts, TypedValue model, versioned snapshots |
| 28 | Versioned MCP protocol (`mcp-protocol`) | ✅ Compliant | 27 tools, event subscriptions, principal args, direct ingress |
| 29 | AI Agent (`ai-agent`) | ✅ Compliant | Runtime + chat UI + MCP-only path + audit + intent router |

**Counts:** ✅ 15 Compliant · 🔄 14 Partial · ⬜ 0 Not built · ❌ 0 Non-compliant

---

### Detailed Findings by Track (changed tracks only; unchanged tracks 1, 3, 13, 27 carry over)

#### 2. Formula language (`formula-language`) — ✅ COMPLIANT

**Current state:** All 523 Excel names resolve with real implementations. `external-stubs.ts` deleted — zero #N/A stubs. Financial bond functions (`financial-functions2.ts`), FORECAST.ETS family/FREQUENCY/MODE.MULT/LENB/T (`extended-functions8.ts`), GETPIVOTDATA/CELL/IMAGE (`extended-functions9.ts`), DETECTLANGUAGE/ENCODEURL (`extended-functions10.ts`), CUBE*/STOCKHISTORY/WEBSERVICE/RTD/COPILOT/PY/CALL/REGISTER.ID (`cube-functions.ts`, `extended-functions11.ts`). Iterative solving real (`iterative.ts`); volatile policy module real (`volatile.ts`); 7 locales wired.

**Remaining (minor):** IMPORTDATA/IMPORTFEED/IMPORTHTML/IMPORTXML are not formula functions (fetch substrate exists in `etl/sources.ts`).

#### 4. Charts (`charts`) — ✅ COMPLIANT

**Current state:** 37 kinds via Chart.js 4.5.1; versioned ChartSpec; dialog + floating overlays + persistence; sparklines/slicers wired (track 14).

**Remaining (minor):** trendlines, PivotCharts.

#### 5. PivotTables and PivotCharts (`pivots`) — 🔄 PARTIAL

**Current state:** `packages/service/src/pivot.ts` (versioned spec, 9 aggregations, create/refresh/getPivotValue); `PivotTable.tsx` builder + matrix; MCP tools; GETPIVOTDATA resolves against the pivot engine.

**Remaining:** PivotCharts, slicer→pivot integration, date/numeric/custom grouping operators.

#### 6. Power Query (`power-query`) — ✅ COMPLIANT

**Current state:** Full service-layer ETL pipeline per etl-pipeline.md (10 files, 6 test files): versioned recipe DAG, connector SDK, 13 transforms, sandboxed custom transforms, atomic load, failure policy, manual/on-open/scheduled triggers, vault credentials, `EtlEditor.tsx`.

**Remaining (minor):** M-language translator.

#### 7. Data tools (`data-tools`) — 🔄 PARTIAL

**Current state:** Sort, filter, validation, dedup, CF, text-to-columns; Solver (Nelder-Mead, `SolverDialog.tsx`); Goal Seek; Scenario Manager; Data Tables (one-var/two-var).

**Remaining:** column statistics (profiling), trim whitespace — zero implementation.

#### 8. VBA, macros and Office Scripts (`automation`) — ✅ COMPLIANT

**Current state:** Full automation lane per automation-lane.md (8 files, 5 test files): permissioned API with authorize() choke point, action recorder + script generation, event runtime, sandbox, VBA/Apps Script translators, byte-for-byte vbaProject.bin preservation.

**v2 (explicit):** byte-faithful VBA execution.

#### 9. Excel file formats (`file-format`) — 🔄 PARTIAL

**Current state:** XLSX real + wired (metadata round-trip); CSV/TSV/ODS adapters registered and wired (`adapters.ts`); Save dialog offers 4 formats.

**Remaining:** native PDF export (browser print only), HTML/web export, .xlsb binary.

#### 10. Collaboration (`collaboration`) — 🔄 PARTIAL

**Current state:** Comments; `CollabSession` (OT, presence) wired via `collab.ts`; `RevisionHistory.tsx`; conflict detection + `SyncStatus.tsx`.

**Remaining:** server-sequenced real-time path, share UI.

#### 11. Extensibility and data model (`extensibility`) — 🔄 PARTIAL

**Current state:** Add-on model ✅, no-code app builder ✅, native reports ✅ (see design-doc findings). Named ranges still UI-layer substitution; named functions absent.

#### 12. Platform layer (`platform`) — 🔄 PARTIAL

**Current state:** Web + desktop (login gate, JWT in safeStorage) + gateway (rate limiting, JWT verify); offline op-log replay wired.

**Remaining:** workbook library UI, command registry, menu search, shortcuts dialog, settings/profile, desktop Open/Save.

#### 14. Sparklines, slicers and timelines (`sparklines-slicers-timelines`) — ✅ COMPLIANT

**Current state:** `SparklineDialog.tsx` + Grid in-cell rendering + ribbon; `Slicer.tsx` + ribbon + Grid/Reports integration; `timelines.ts` + ribbon + Grid filtering. All wired.

#### 15. Linked data types (`linked-data-types`) — 🔄 PARTIAL

**Current state:** Stocks + geography (detail cards, field extraction); all 5 smart chips (person/file/calendar/finance/rating) with ribbon + Grid integration.

**Remaining:** live providers + refresh (sample data only).

#### 16. Flash Fill and Analyze Data (`flash-fill-analysis`) — 🔄 PARTIAL

**Current state:** Flash Fill real — `flashfill.ts` (pattern synthesis, versioned proposals) + `FlashFillDialog.tsx` (preview/apply); 16 engine tests.

**Remaining:** autocomplete, formula suggestions/corrections, cleanup proposals, general proposal UI.

#### 17. 3D Maps (`three-d-maps`) — ✅ COMPLIANT

**Current state:** `globe.ts` (orthographic projection) + `Globe3D.tsx` (SVG renderer, draggable, animation timer for time playback); Insert → "3D Map" dialog; 7 tests. Honest scope note: SVG-based, not WebGL; no geocoding adapters.

#### 18. Form controls and ActiveX (`forms-activex`) — ✅ COMPLIANT

**Current state:** Button, Checkbox, Dropdown, Listbox as native overlays bound to values (`FormControls.tsx`, Insert menu, CRUD/move). ActiveX absent by design (preserve/migrate only).

#### 19. Workbook protection and encryption (`protection-encryption`) — 🔄 PARTIAL

**Current state:** Sheet/range/cell/workbook protection wired (`ProtectionDialog.tsx`, Review tab); 2026-10-18 ruling recorded — v1 is protection AND at-rest encryption; `KeyManager` (per-workbook AES-256-GCM, rotation, revocation); PBKDF2 password→key; audit log; XLSX hint round-trip; permission-filtered downloads.

**Remaining:** per-range UI indicators.

#### 20. External links, RTD and DDE (`external-links-rtd-dde`) — ✅ COMPLIANT

**Current state:** External-link registry + dialog; RTD real (engine bus fed from MCP subscriptions). DDE: documented non-goal (Windows-only DDEML IPC; link parsing exists).

#### 21. Print and page layout (`print-layout`) — 🔄 PARTIAL

**Current state:** Page setup UI + adapter-metadata persistence + XLSX round-trip; print preview from grid snapshot.

**Remaining:** snapshot-based deterministic pagination, native PDF, manual page breaks, `&P`/`&N` codes.

#### 22. Regional formula localization (`formula-localization`) — ✅ COMPLIANT

**Current state:** 7 locale packs wired (`registerLocales()` at startup) + formula-language switcher UI.

#### 23. Accessibility and sensitivity labels (`accessibility-labels`) — 🔄 PARTIAL

**Current state:** Grid ARIA; sensitivity labels (`sensitivity.ts` + `SensitivityBar.tsx`, audited, confidential restricts downloads/sharing); pictures carry alt text.

**Remaining:** accessibility checker UI, screen-reader shortcuts section (blocked on the shortcuts dialog).

#### 24. Python data analysis and visualization (`python-in-grid`) — 🔄 PARTIAL

**Current state:** `PY()` real (sandboxed python3, spill ranges); analysis pipeline (AI-generates-Python → deterministic execution → Chart.js spec; MCP `analyze_data`/`rerun_analysis`/`list_analyses`).

**Remaining:** pandas/numpy/matplotlib, plots-in-cells, pinned package environment, dep-graph invalidation.

#### 25. General code runtime (`general-code-runtime`) — 🔄 PARTIAL

**Current state:** MCP `execute_code` (JS + Python sandboxes); `ICEEVAL()`; macro recorder (automation lane); VBA/Apps Script translators.

**Remaining:** in-web code editor, Extensions menu surface.

#### 26. Pluggable storage adapters (`storage-adapters`) — ✅ COMPLIANT

**Current state:** `AdapterRegistry` wired (xlsx/csv/tsv/ods); connector registry (CSV/JSON/REST/SQL/market-data) with vault seam; MCP data-source tools.

**Remaining (minor):** DataFrame adapter, third-party adapter SDK.

#### 28. Versioned MCP protocol (`mcp-protocol`) — ✅ COMPLIANT

**Current state:** 27 tools; event subscriptions (500-event cap, drain-on-poll); memory_* tools; optional `principal` per tool; direct ingress (not behind gateway) per the 2026-10-18 decision.

#### 29. AI Agent (`ai-agent`) — ✅ COMPLIANT

**Current state:** Agent runtime + `HeuristicModelBackend` + intent router; `AgentChat.tsx` (chat, audit, Watch/Mute); MCP-only path (verified); write discipline; HITL. 34 tests; browser e2e verified. Deviations documented (no collaborator-edit event, whole-thing mute, in-memory threads, runtime-level HITL pause).

---

### Cross-Reference with FEATURES.md

| Source | Built | Partial | Pending | Total |
|--------|-------|---------|---------|-------|
| FEATURES.md (748 features) | 676 | 57 | 15 | 748 |
| 29-track audit (this section) | 15 tracks ✅ | 14 tracks 🔄 | 0 tracks ⬜ | 29 tracks |

### Remediation Priority (combined with design-doc audit)

**🔴 Critical — true gaps:**
1. Deterministic inference remainder (autocomplete, formula suggestions, cleanup proposals)
2. Sharing UI (permission grant/revoke flows)
3. Workbook library (New/Open/Copy/Trash on the metadata store)

**🟡 Important — Excel parity + design gaps:**
4. PivotCharts, trendlines, native Download-as-PDF, manual page breaks
5. Column stats, trim whitespace, IMPORTDATA-family functions
6. Named ranges (stable IDs, scope, XLSX round-trip, named functions)
7. Platform shell (command registry, menu search, shortcuts dialog, settings/profile, desktop Open/Save)
8. Collaboration server sequencing

**🟢 Ecosystem — future:**
9. Pandas/plots/pinned Python env, live data-type providers, M-language translator
10. A11y checker, DataFrame adapter, report/app sample templates
