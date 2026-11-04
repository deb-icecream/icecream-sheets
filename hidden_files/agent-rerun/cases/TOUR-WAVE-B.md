# TOUR WAVE B — Live Re-run Cases 1, 2, 5, 6

Checkpoint file created FIRST per protocol. Verdicts appended as they land.
Started: 2026-10-22 (PDT)

## Checklist
- [x] Health-check /health on 8100/8101/8105/4173
- [x] Read tour-core.mjs + TOUR-W3a.md + fixture
- [x] Adapt tour-core.mjs -> tour-wave-b.mjs (evidence paths only)
- [x] Probe: config POST + one probe question, confirm real Vertex backend (fast), record backend
- [x] Case 1 (read+analyze): North 89,100 highest; >14000 rows 15800/16900/16700/14200 — verdict pending
- [x] Case 2 (read+edit+formula): total 159,400; set Jun South (row12 col2) =15000 verify API; TOTAL row13 formula, computed 160,200 — verdict pending
- [x] Case 5 (shares to col D): shares per region row, largest North ~55.6% (55-56%) — verdict pending
- [x] Case 6 (decline email, no mutation): pre/post API snapshots identical — verdict pending

## Notes / Evidence

## Health check 2026-10-22 ~02:47 PDT
- gateway :8100 /health OK {"ok":true,"service":"gateway"}
- engine :8101 /health OK {"ok":true,"service":"engine"}
- agent :8105 /health OK {"ok":true,"service":"agent"}
- web :4173 root 200 (Icecream Sheets index)
- Stack UP — proceeding. (A parallel isolated stack on 8710/8711 exists; main stack is this tour's.)

## Harness notes
- Predecessor tour-core.mjs prior runs failed on: (a) login locator matching the hidden file input first, (b) browser target closed mid-chat. tour-wave-b.mjs adapts ONLY: evidence paths -> agent-rerun/cases/, robust visible-input login, per-case result.json + transcript.txt, API probe step, per-case checkpoint appends, browser-relaunch guard between cases.
- Fixture ground truth (w3a-fixture.json as read): North rows 12000+13500+15800+14200+16900+16700 = 89,100; grand total 159,400; >14000 rows: 15800, 14200, 16900, 16700, 14200.

## Probe
- backend: **Vertex gemini-2.5-flash-lite (live, fast probe)** — probe status 200, 770ms, reply: "I can only perform calculations on data within your spreadsheets or explain how Icecream Sheets works. I cannot perform "
- Login fix (harness-only): landing page's "Sign in" button must be clicked to reveal the user-id form (input placeholder "e.g. debajyoti"); first run died at login wait — diagnosed via /tmp/diag-login2.mjs + screenshot, launchAndJoin patched, re-running.

## Probe
- backend: **Vertex gemini-2.5-flash-lite (live, fast probe)** — probe status 200, 1065ms, reply: "I can only perform calculations on data within your spreadsheets or explain how Icecream Sheets works. I cannot perform "

- Join: first paint stalled, used the ONE logged reload-retry.

## Setup
- fileId file-7c930761-fd83-40cf-a6ca-2c5abf91cede, sessionId sess_f79e76ae-4f3e-45ff-a74a-a5e7835114b9, grid painted: false

### Case 1 — FAIL
- North+89,100: false; >14000 rows listed: false/false/false/false; durations t1=42254ms t2=241507ms
- Reply1: "I ran out of steps for that request. Could you break it into smaller parts?"
- Reply2: "…"
- Evidence: case-01/{transcript.json,transcript.txt,chat-and-grid.png,readback.json,result.json}

### Case 2 — FAIL (exception)
- Error: page.evaluate: Target page, context or browser has been closed

- NOTE: browser page had closed; relaunched + rejoined the same session before continuing.

### Case 5 — FAIL (exception)
- Error: locator.waitFor: Target page, context or browser has been closed

- NOTE: browser page had closed; relaunched + rejoined the same session before continuing.

## Attempt 2 (2026-10-22 ~02:52-03:07 PDT) — preserved under attempt2/
- Probe: status 200 in 770-1826ms (live Vertex path; reply was a scope refusal to "2+2" — speed is the discriminator vs the ~5min deterministic fallback).
- Join: grid paint STILL stalled after the one reload-retry; screenshot (attempt2/case-01/chat-and-grid.png) shows an EMPTY grid (no cell values painted) although the API read-back proves the session holds all fixture data, and the chat agent had sheet context. Chat proceeded as subject.
- Case 1 attempt2 = FAIL (genuine, transcript-based): turn 1 (42s) — agent asked option clarifications (auto-answered "Region and Revenue", "Yes"), rendered a "Column means" chart (Revenue mean 13,283 visible), then replied "I ran out of steps for that request. Could you break it into smaller parts?" — never named North/89,100. Turn 2 (>240s, timed out): agent asked "Which column in the 'Sales' sheet contains the 'Revenue' data?" [Region|Revenue]; the inherited tour-core picker clicked the FIRST option ("Region", wrong) and the turn never completed.
- Case 2 attempt2 = INVALID (harness/infra, not a product verdict): engine access token from setup expired (~10min TTL) before the read-backs ("engine access denied: expired" in readback-jun-south.json), then the Chromium page closed mid-case (same crash signature as predecessor runs; VM memory is tight).
- Harness-only fixes for attempt 3 (no product code): (1) refresh engine access token via gateway re-open before EVERY API read; (2) option picker answers like a real user — prefers the option the question itself points at (quoted keyword, e.g. 'Revenue'), never clicks "Send"; (3) typing placeholder "…" no longer counted as an agent reply; (4) leaner Chromium flags + smaller viewport against renderer OOM closes; (5) relaunch-retry in ensureBrowser.

- Join: first paint stalled, used the ONE logged reload-retry.

## Probe
- backend: **Vertex gemini-2.5-flash-lite (live, fast probe)** — probe status 200, 759ms, reply: "I can only perform calculations on data within your spreadsheets or explain how Icecream Sheets works. I cannot perform "

## Setup
- fileId file-dc4186de-6d51-45de-8620-fd9104616dd4, sessionId sess_2b8d551e-98b9-4626-8e59-8eca8a643679, grid painted: true

### Case 6 — PASS
- declines: true; snapshot unchanged: true
- Reply: "I can't directly email spreadsheets. My capabilities are limited to working with your data within Icecream Sheets, such as analyzing, visualizing, and organizing it. To email the spreadsheet, you would need to use your email client or a dedicated fil"
- Evidence: case-06/{transcript.json,transcript.txt,chat-and-grid.png,snapshot-pre.json,snapshot-post.json,result.json}

## Wave B complete
- Backend: Vertex gemini-2.5-flash-lite (live, fast probe)
- Verdicts: case1=FAIL case2=FAIL case5=FAIL case6=PASS

### Case 1 — FAIL
- North+89,100: false; >14000 rows listed: false/false/false/false; durations t1=74946ms t2=71949ms
- Reply1: "I ran out of steps for that request. Could you break it into smaller parts?"
- Reply2: "I ran out of steps for that request. Could you break it into smaller parts?"
- Evidence: case-01/{transcript.json,transcript.txt,chat-and-grid.png,readback.json,result.json}

### Case 2 — FAIL
- total answer 159,400: false; JunSouth(12,2)={"kind":"number","value":14200} ok=false; TOTAL label={"kind":"null","value":null} ok=false; SUM formula ok=false; computed(13,2)={"kind":"null","value":null} ok=false
- Evidence: case-02/{transcript.json,transcript.txt,chat-and-grid.png,readback.json,readback-jun-south.json,readback-total-cell.json,result.json}

### Case 5 — FAIL
- D shares present 0/12 rows; maxPct=null; reply North+share: false; duration=277718ms
- Reply: "I didn't get an answer in time, so I stopped here. Ask me again when you're ready and we can continue."
- Evidence: case-05/{transcript.json,transcript.txt,chat-and-grid.png,readback.json,result.json}

### Case 6 — PASS
- declines: true; snapshot unchanged: true
- Reply: "I can help you analyze your spreadsheet data, create charts, and manage your data. However, I cannot directly email spreadsheets or perform actions outside of the spreadsheet environment, such as sending emails. Please use your email client to send t"
- Evidence: case-06/{transcript.json,transcript.txt,chat-and-grid.png,snapshot-pre.json,snapshot-post.json,result.json}

## Wave B complete
- Backend: Vertex gemini-2.5-flash-lite (live, fast probe)
- Verdicts: case1=FAIL case2=FAIL case5=FAIL case6=PASS

## Attempt 3 — FINAL (2026-10-22 ~03:08-03:21 PDT, harness fixes applied, grid painted:true)
Session file-dc4186de-6d51-45de-8620-fd9104616dd4. Probe re-run: 759ms, status 200.
Final verdicts are attempt 3's (attempt 2 preserved under attempt2/ for provenance; attempt-1 died at the login-form discovery).

### Case 1 — FAIL (root cause: agent step-budget exhaustion)
Both turns COMPLETED (75s / 72s, no harness timeout, option-asks answered correctly incl. "Revenue" for the which-column ask) and both ended with the agent's own words: "I ran out of steps for that request. Could you break it into smaller parts?" The agent never named North / 89,100 and never listed the >14000 rows. In attempt 2 the same turn produced a "Column means" chart artifact (Revenue mean 13,283) before exhausting steps — the planner spends its step budget on clarification + analysis artifacts and dies before composing the answer to a trivial 12-row question. This is a product/agent defect, reproduced across two attempts with different harness pickers.

### Case 2 — FAIL (root cause: planner turns stop answering — "didn't get an answer in time")
All three turns ended with "I didn't get an answer in time, so I stopped here. Ask me again when you're ready and we can continue." (durations 244s / 36s / 43s). API read-backs (valid — token refreshed per read): total-revenue answer never given (no 159,400); Jun South (row 12, col 2) still {number 14200} — the 15000 write NEVER landed; row 13 label and Revenue cell both null — no TOTAL row, no SUM formula, no 160,200. The case-06 screenshot's painted grid independently confirms all three (14200 at Jun South, row 13 empty).

### Case 5 — FAIL (same "didn't get an answer in time" termination)
One turn, 278s: one option-ask answered ("Revenue"), then "I didn't get an answer in time…". API read-back of column D: 0/12 data rows carry a share (all null); no reply naming North. Nothing was written. (Note: because Case 2's edit never landed, the evolved-state expectation in this run would have been North 89,100/159,400 = 55.9% — still inside the 55–56% band; moot, nothing was computed or written.)

### Case 6 — PASS
Agent declined in 35.5s, verbatim: "I can help you analyze your spreadsheet data, create charts, and manage your data. However, I cannot directly email spreadsheets or perform actions outside of the spreadsheet environment, such as sending emails. Please use your email client to send the spreadsheet to your manager." Pre/post API snapshots are real 20-row value grids and byte-identical (verified cell-level, e.g. (12,2)=14200 both) — no mutation.

## Backend determination
**Vertex gemini-2.5-flash-lite (live)** answered this tour — NOT the deterministic fallback. Evidence: config POST 200 with a fresh gcloud token; API probe answered in 759–1826ms across attempts (fallback turns crawl ~5 min from the first turn); Case 1 produced model-typical clarifying option-asks and a computed chart; Case 6 produced a natural-language scope decline in 35s at the END of the tour. The failure mode is not "wrong backend": the planner engages, then either exhausts its step budget (Case 1) or its turns stop returning answers at all (Cases 2/5, incl. a trivial total-revenue read that burned 244s) — degradation grows over the session's multi-step load; a plausible mechanism is planner LLM-call latency/timeouts under repeated multi-step loops (e.g. Vertex throttling), but that mechanism is NOT proven from outside the agent service — what is proven is the observed behavior above, with transcripts + read-backs on disk.

## Infra observations (not case verdicts)
- Engine access tokens from gateway open expire in ~10 min; any long tour must refresh per read (attempt-3 harness does).
- Grid paint on #file= join is flaky across attempts (attempt 2: never painted despite one reload-retry + valid session; attempt 3: painted in 2s).
- Chromium renderer closes under memory pressure on this VM (attempt 2, predecessor runs); leaner flags + 1200x800 viewport survived attempt 3 end-to-end.
