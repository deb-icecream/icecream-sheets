# Wave C Fixes — Brief

**Origin:** Agent validation re-run, Wave C verdicts + findings
(`hidden_files/agent-rerun/REPORT.md`, "WAVE C VERDICTS" + case-4 re-run
findings). **User direction (2026-10-22 ~05:27 PDT):** if these are new
issues, fix them — documented first, then built, with validation.

**Record:** `hidden_files/wave-c-fixes/REPORT.md` — create it FIRST
(skeleton, one section per item), append after each landed piece.
Daemon restarts are frequent; nothing counts until it is on disk. Do
NOT touch progress.md. Do NOT git push.

## What is NOT in this brief (already covered — do not redo)

- **Case 3a's root fix is LANDED** (FIX-R4 round 2: the analysis
  aggregate classifier now recognizes "<measure> by <dimension>" /
  "per <word>", and aggregates are engine-computed via SUM/SUMIF
  scratch formulas). Its live spot-check belongs to the re-run
  successor's combined-build proof. If your work here touches the
  analysis lane, coordinate — do not fork it.
- **Cases 1/2/5 (planner degradation)** belong to the planner-fix
  program + the re-run successor's live proof. Not yours.
- **File-2's two defects** (pictures not rendering; blank sheet after
  the checkpoint window) are a different layer (grid display) with
  their own worker. Only item W5 touches that boundary, as a
  verification.

## The items

### W1 — First-turn sheet-context failure (root fix)

Evidence: 3/3 case-4 re-run runs — on turn 1 the agent reports sheet
'Sales' "not found" although pre-chat read-backs prove the session
holds it; turn 2 works. Suspected session-binding warm-up race.
FIX-R4 added a chart-sink retry (retry a 400 'unknown sheet' once
after re-resolving) — that is a symptom patch on ONE sink, not the
root fix.

Task: find where the agent runtime's first-turn view of the workbook
(session binding, sheet list, resolver cache) is stale or unpopulated,
and fix it at that layer so a fresh session's FIRST turn sees the real
sheets for reads and tools alike. Keep the sink retry. Validation:
fresh session → turn-1 read of a named sheet + turn-1 create_chart,
3/3 consecutive runs, no 'unknown sheet' anywhere; regression tests
for the mechanism you find.

### W2 — Case 3b: generated app renders heading, body blank

Evidence: the generated artifact is valid (stored, embedded, persists
across reload; Apps tab lists it) but the panel body shows no data
rows in any frame — its `mcp.call('read_cells', …)` returns nothing
renderable. The same shape was observed in shell-integration (seeded
app rendered its heading, not its rows). Mechanism not yet proven.

Task: trace the generated-app data path end to end (artifact code →
app frame host → MCP call with the app binding → engine/host read →
render) and find where the rows die. Fix at the proven layer.
Validation: the case-3b scenario re-run — the generated app displays
the fixture's rows, and two-way binding is demonstrable (edit the
sheet → the app reflects it). Screenshots inspected.

### W3 — Intent-router dead end for native-chart requests

Evidence: for an explicit in-sheet chart request, the disambiguation
offers "Build an app / Analyze & visualize / Just answer" — NO
native-chart option — and the "Build an app" branch dead-ends.
`create_chart` itself is sound (2/2 once reached).

Task: an explicit native-chart intent must route to (or offer) the
native chart path; no offered branch may dead-end. Fix in the intent
router / disambiguation construction. Validation: the case-4 main-run
scenario — an explicit "chart X vs Y in this sheet" request reaches a
created native chart; unit tests for the routing decision.

### W4 — UI-built apps persist only in one browser's localStorage

Evidence (case 12 limitation, new defect class): apps built in the
app-builder UI persist only in the creating browser profile's
localStorage — a fresh profile for the same user+file shows "No apps
yet". Agent-generated apps already persist server-side (gallery/app
store); the UI builder bypasses that store.

Task: persist UI-built apps through the server-side app store, keyed
by user and bound to the file, like generated apps; localStorage may
remain a cache but is never the only copy. Migration honesty: apps
already stranded in a browser's localStorage should be picked up on
next open of that file in that browser (upload-on-open) or the gap
stated plainly in the report. Validation: build an app in browser
profile A → fresh profile, same user+file → the app is listed and
opens with its data; suites green.

### W5 — `#file=` join paint flakiness (verification first)

Evidence: 2 of 4 Wave C joins never painted the grid despite valid
server sessions. The File-2 D2 fix (client RemoteView failure-breaker
re-notify + used-range deduper null-caching, worker 96909359) may
share this mechanism — the join's first reads race the same load
window.

Task: AFTER the File-2 D2 fix lands (watch
`hidden_files/file2-defects-fix/REPORT.md`), re-run the join scenario
4× on the fixed build. If 4/4 paint: close W5 as "covered by the D2
fix" WITH the evidence attached. If any join still fails to paint,
diagnose in the join path (deep link → session join → first paint)
and fix it there. Do not close this on a single lucky run.

## Coordination (binding)

- The re-run successor (grounding-gate validation → combined-build
  live proof → Wave D) and the planner-fix program are working the
  same agent stack and some of the same files. Read their REPORT.md
  checkpoints before editing shared files; land atomically; never
  restart shared services while their live proof is in flight — run
  your live validation on YOUR OWN isolated ports/stack, and sequence
  behind their proof where the same service must be restarted.
- Never disturb: the shared 8100 stack (beyond what the established
  harnesses do), the deploy run, the triggers/settings builders'
  files. TMPDIR under ~/workspace.

## Validation bar (all items)

Root cause stated from evidence (logs/audit/code path), not guessed;
fix at the proven layer; regression tests pinning the mechanism;
affected suites green + tsc clean; live browser proof with
self-inspected screenshots for W2/W4/W5 and the W1/W3 scenarios.
Honest FAILs stay FAILs in the report — a verdict is earned by the
re-run, not by the fix landing.
