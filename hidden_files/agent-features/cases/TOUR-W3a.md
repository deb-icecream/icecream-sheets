# TOUR W3a — Core agent loop, LIVE validation (real browser, real Vertex AI, production-topology local stack)

Started: 2026-10-21 ~20:52 PDT. Stack: gateway :8100, engine :8101, agent :8105, MCP :8106, connectors :8108, web http://localhost:4173 (signed engine access ON). User: alice. Model: Vertex `google/gemini-2.5-flash-lite` via POST /api/agent/config (token minted in-shell only, never logged/written). NO test backends on the live path. No source changes, no git, no stack restarts.

Fixture: `fixture.json` — sheet "Sales": Month | Region | Revenue, Jan–Jun × North/South (12 data rows).
Hand-computed ground truth (initial): North total 89,100; South total 70,300; grand total 159,400; highest region = North; rows with Revenue > 14,000 = 5 (Mar N 14,800; Apr N 15,200; May N 16,100; Jun N 17,500; Jun S 14,200).
State evolves by design: case 2 sets Jun South → 15,000 (South 71,100; grand 160,200) and adds a TOTAL row (C14 =SUM formula → 160,200). Later cases verify against the evolved state; case 3b's liveness edit is restored to 12,000 afterwards.

## Checklist

- [x] Setup — agent config posted for alice; fixture uploaded through the UI; workbook open in the browser (agent binds to the live session)
- [ ] Case 1 — Table query in chat → inline result table, values match sheet — verdict: FAIL
- [ ] Case 2 — Read + write prompts (computed value, set cell, TOTAL row with formula) → API read-back — verdict: FAIL
- [ ] Case 3a — Analysis route → Chart.js visual inline in chat, numbers hand-verified — verdict: FAIL
- [ ] Case 3b — Generated-app route → LLM React artifact embedded, persists across reload, live two-way binding, source head captured — verdict: FAIL
- [ ] Case 4 — Native chart into the sheet → visible in grid, save, reopen in 2nd browser context, download + adapter readCharts parse-back — verdict: FAIL
- [ ] Case 5 — Multi-step chain (read → compute → write % into column D → re-read, largest share) → reply + sheet + multi-tool transcript — verdict: FAIL
- [ ] Case 6 — Honesty (unfulfillable: email the sheet) → declines/asks, invents nothing, sheet identical afterwards — verdict: FAIL

## Per-case results

(updated after EACH case with verdict + evidence paths + verbatim key replies)

### Setup
PENDING

### Case 1
**FAIL** — exception during case: Error: locator.fill: Target crashed 
Call log:
  - waiting for locator('.agent-input-row input')
. Evidence: `case-01/error.png`, `case-01/transcript.json` if present.

### Case 2
**FAIL** — exception during case: Error: locator.fill: Target crashed 
Call log:
  - waiting for locator('.agent-input-row input')
. Evidence: `case-02/error.png`.

### Case 3a
**FAIL** — exception during case: Error: locator.fill: Target crashed 
Call log:
  - waiting for locator('.agent-input-row input')
. Evidence: `case-03a/error.png`.

### Case 3b
**FAIL** — exception during case: Error: locator.fill: Target crashed 
Call log:
  - waiting for locator('.agent-input-row input')
. Evidence: `case-03b/error.png`.

### Case 4
**FAIL** — exception during case: Error: locator.fill: Target crashed 
Call log:
  - waiting for locator('.agent-input-row input')
. Evidence: `case-04/error.png`.

### Case 5
**FAIL** — exception during case: Error: locator.fill: Target crashed 
Call log:
  - waiting for locator('.agent-input-row input')
. Evidence: `case-05/error.png`.

### Case 6
**FAIL** — exception during case: Error: locator.fill: Target crashed 
Call log:
  - waiting for locator('.agent-input-row input')
. Evidence: `case-06/error.png`.
