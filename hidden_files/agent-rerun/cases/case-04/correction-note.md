# Case 4 — correction note (worker, written after result.json; result.json itself NOT modified)

Two assertions in result.json are tainted by harness bugs; the FAIL verdict is unaffected (the parse-back assertions are clean and decisive):

1. "native chart visible in the grid" (pass=true) and "chart still visible after reopen" (pass=true) are FALSE POSITIVES.
   The probe counted SVG elements outside the chat panels; svgCount=40 in both contexts is the ribbon/UI icon set.
   The meaningful signal is canvasCount=0 in both contexts, and both screenshots (chart-in-grid.png,
   reopened-second-context.png) show NO chart overlay and an empty grid. Corrected reading: chart NOT visible anywhere.
   The same flawed SVG test also suppressed the planned one-time retry with the W3a phrasing (retried=false).

2. "workbook saved" (pass=false) used the wrong status field name: the engine returns `storageRevision`,
   the harness read `storedRevision` (undefined). Actual status (session-status.json): revision=0,
   storageRevision=0 — nothing was ever written to the session (no chart op landed), so there was nothing to save;
   the download returned the autosave entry in verbatim mode (the original fixture bytes, 6,893 B).

Decisive, untainted evidence: parse-back.json — downloaded.xlsx has NO chart/drawing parts (parts=[]),
hasChart1Xml=false, readCharts=[] ; session revision stayed 0. No native chart was created.
Turn observation caveat: the harness's view of the chat turn was blinded (leftover Audit view from case 3a/3b
captureAudit hides .agent-msg and .agent-pending elements), so the turn ran to the 300s harness timeout with
seen.clicked=[] — if the agent parked on a HITL ask it could not be seen/answered in this run. Whether the
server-side turn stalled in the planner (Wave B's degradation pattern) or parked on an unseen ask is not
provable from outside; what is proven is the end state: no chart in the grid, none in the file.
