# TOUR W4 — Wider five AI-native components (cases 8–12) — LIVE validation

User: **carol** · Stack: gateway :8100, engine :8101, agent :8105, MCP :8106, addons :8107, web http://localhost:4173 (signed access ON, production topology). Browser: playwright-core + Chromium, real UI only. No source changes, no stack restarts.

## Fixture (hand-computed ground truth)

Workbook created via gateway API (`apiSetupSession`), sheet **Sheet1**:

| Row | A Units | B Product | C Region | D Price |
|---|---|---|---|---|
| 1 (header) | Units | Product | Region | Price |
| 2 | 10 | Widget | North | 5 |
| 3 | 20 | Gadget | South | 5 |
| 4 | 5 | Widget | South | 5 |
| 5 | 15 | Gadget | North | 10 |
| 6 | 8 | Widget | North | 10 |

Ground truth: ΣUnits = **58** · count = **5** · avg Price = **7** · North rows = 3 (Units 15, 10, 8).
ETL expectation (filter Region=North, sort Units desc): header + `15,Gadget,North,10` / `10,Widget,North,5` / `8,Widget,North,10`.

Execution order (contamination control): 10 → 11 → 8 → 9 → 12 (reports need a clean used range; add-on sum must precede app-builder edits).

## Checklist

- [x] Case 8 — ETL pipeline — verdict: **PASS**
- [ ] Case 9 — Automation — verdict: **FAIL-GAP** (manual run works; no trigger surface exists)
- [x] Case 10 — Reports/dashboards — verdict: **PASS**
- [ ] Case 11 — Add-ons — verdict: **FAIL** (runs bound to `local-workbook`, not the open file)
- [ ] Case 12 — No-code app builder — verdict: **NOT RUN** (worker run died on a ribbon selector; coordinator re-run pending)

## Results

_(Worker run harvested + verified by the coordinator from `w4-summary.json`, per-case `result.json`, and screenshots; the worker died in a daemon restart before writing this file up. Case 12 re-run is the coordinator's.)_

### Case 10 — Reports/dashboards — PASS
Dashboard builder (real UI) over the fixture: two KPI blocks added — "Total Units | 58" and "Avg Price | 7" — both match the hand-computed ground truth (ΣUnits 10+20+5+15+8 = 58; avg Price (5+5+5+10+10)/5 = 7). The viewer renders both figures (`viewerHas58`/`viewerHas7` true). Evidence: `case-10/01-builder-open.png`, `02-builder-two-kpis.png`, `03-viewer.png`, `w4-summary.json#case10`.

### Case 11 — Add-ons — FAIL
Sum Reporter installed from the gateway catalog (:8107) through the real Extensions UI; grant requested and approved; the add-on ran. **But it ran against document `local-workbook`** — the Add-ons dialog itself shows "Signed in as owner on local-workbook" while the open workbook was `file-27fddeba-53d5-4ef6-a73e-33f7223e9875` (visible in the same screenshots' header) — and the expected output (sum 58) never appears on the page (`pageTextHasSum58: false`, `case-11/result.json: pass=false`). The capability was exercised against the WRONG document: the web add-on host does not pass the open gateway file's id as the add-on document binding (defaults to `local-workbook`). This is the exact binding caveat the pre-tour recon flagged. Evidence: `case-11/01..08*.png`, `case-11/result.json`.

### Case 8 — ETL pipeline — PASS
EtlEditor (real UI): recipe = Filter (Region eq North) → Sort (Units desc); step previews show exactly the expected 3 rows × 4 cols (15 Gadget North 10 / 10 Widget North 5 / 8 Widget North 10). Run: "Loaded 3 rows into \"Pipeline 1\"" (`runMsgLoaded: true`), load dialog + post-load grid captured. Note: the loaded table materializes as the named "Pipeline 1" table; verification rests on the preview contents + the run's loaded-rows message + `06-grid-after-load.png` rather than an API read-back of a separate target sheet. Evidence: `case-08/01..06*.png`, `case-08/result.json`.

### Case 9 — Automation — FAIL-GAP
Manual leg WORKS: script authored in ScriptEditor (default report-block script: `api.setCell(Sheet1!0,0, 'Hello from Apps Script')`), permission grant dialog shown and confirmed, script ran — console shows `Running "Script 1" as automation:script:…` and the grid DOM contains "Hello from Apps Script" at the top-left cell (consoleSnippet in `case-09/result.json`). (The worker's own `scriptEffectPass` check read the wrong cell/API path and returned false; the DOM evidence contradicts it — the write landed.)
Trigger leg = GAP: after searching both the ScriptEditor and the Macros UI (`06-trigger-search-scripteditor.png`, `07-trigger-search-macrolist.png`), there is NO trigger surface (`triggerUiFound: false`, no "trigger" text) — consistent with recon: `TriggerRuntime` exists in the service package but is hosted nowhere. A script cannot be made to fire on an event/schedule from the product. Verdict FAIL-GAP per the case definition (record/author + TRIGGER + effect). Evidence: `case-09/01..07*.png`, `case-09/result.json`.

### Case 12 — No-code app builder — NOT RUN (coordinator re-run pending)
The worker's run timed out waiting for `text=Build app` (`case-12/result.json`) — the ribbon carries a "Build App" entry (visible in other cases' ribbon text dumps), so this is likely a ribbon-tab/selector miss rather than a missing feature. Coordinator re-run owed before a verdict.
