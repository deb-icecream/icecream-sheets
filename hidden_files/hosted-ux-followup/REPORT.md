# Hosted-UX FOLLOW-UP batch — checkpoint record

Started: 2026-10-22 (worker session, follow-up to hosted-ux-fixes batch)
Port block claimed: 9080-9089
Scope: F-3 (issue #18), F-4 (issue #17), F-7 (issue #21), #8 residual (StatusBar collaborators roster, no separate number).
Constraints: do NOT push; do NOT touch progress.md. Sibling worker (sweep-findings-fix) edits apps/web concurrently — re-read files before editing, keep edits surgical.
Validation rule: re-run ONLY the specific screenshot scenario per defect (before/after pair), no full tours.

## Status log
- [~] F-3 (#18) — CLIENT/LOADER FIXES LANDED + PROVEN; restore repaint blocked by an engine/gateway rehydrate scope defect (see FINAL VERDICTS) — not claimed ready to close
- [x] F-4 (#17) — FIXED + AFTER-PROVEN, ready to close #17
- [x] F-7 (#21) — FIXED + AFTER-PROVEN (incl. final build), ready to close #21
- [x] #8res — FIXED + unit/solo-browser proven, ready to close #8 residual

## Findings log
(checkpoint entries appended as work lands)

## Initial read (from the two source reports)
- F-3: sweep phase 1c — healthy +New session, ribbon open of simple.xls FAILS (F-2: engine /load refuses), then the still-open blank workbook stops accepting edits; /execute + /session-save-status 401 storm for the rest of the run. The hosted-UX batch proved the UPLOAD path clean on the current tree and explicitly left the LOCAL-OPEN trigger as a distinct, unprobed path. Dev posture in the sweep (dev sign-in) — note the batch wired the reauth provider ONLY in non-dev posture, so withReauth is an unlikely mechanism here; look at what the open path itself does to session/token state on failure.
- F-4: sweep phase 1d — Workspace click on simple.xlsx -> gateway 409 (legit one-file-one-owner) -> app renders live grid (header name, ribbon, no sheet tab) + red status-bar text leaking raw file UUIDs + gateway JSON ("Could not join file file-<uuid>: gateway 409: {...}"). Fix = blocking error state (file name + next step) + sanitized copy.
- F-7: sweep phase 5c — B2=10 -> Percent Style ("1,000.00%") -> ONE Ctrl+Z -> grid cell EMPTY at 10 polls/15s, formula bar "10" throughout; value intact in engine; a redo+navigation later restored paint. Specific to FORMAT-op undo deltas (value undo is fine). D6 family (issue #6).
- #8res: batch's own residual — StatusBar roster via bridge CollabSession.collaborators() lists participants by principal text (and includes self, which is fine for a roster). Fix = participantDisplayName chain (services/presenceNames.ts), self as name + "(You)", raw principal never renders.

## ISSUE NUMBER CORRECTION (parent, verified against the live tracker)
F-3 = #18 · F-4 = #17 · F-7 = #21 · roster = "#8 residual" (no separate number).

## F-7 (#21) REPRO round 1 (stack 9080-9082, current tree, repro-f7.mjs)
- Variant A (Percent on B3, NO undo): grid stable "2,000.00%" x8 polls — NOT time-based.
- Variant C (click B4, Ctrl+Z, empty undo stack, no format): grid stable "30",
  status shows "Nothing to undo." — a no-op undo alone does NOT blank.
- Variant D (edit B5=42 -> Percent "4,200.00%" -> Ctrl+Z): grid "" at ALL 8 polls
  (8s), formula bar "42" throughout — REPRODUCED with a non-empty undo stack.
- Variant B (the sweep's exact 5c trajectory): after the polls, a navigation
  probe (click A5) revived B2's paint as "1,000.00%" — the engine value and the
  UI format both survive; the PAINT is what dies and only an unrelated
  navigation revives it. (B's own poll trajectory was cut from the console
  tail; repro round 2 logs it in full with SSE frames.)
- Session rosters in status text render the raw principal ("user:f7b") —
  #8 residual BEFORE evidence captured in the same runs (shots f7-*.png).

## F-4 (#17) BEFORE evidence captured incidentally (f7 round-2 run)
The round-2 F-7 run joined while the engine still owned round 1's file ->
gateway 409 -> the FULL phantom state, screenshot
shots/f4-before-phantom.png (copy saved from that run): header chip shows
the file NAME, ribbon live, grid empty with NO sheet tab (only "+"), B2
selectable, "Unsaved changes" from a format click on the void, and the
status bar in red: 'Could not join file file-e498ffa1-...: gateway 409:
{"ok":false,"error":"engine claim failed: engine already owns a different
file: file-4b33327d-..."}' — raw UUIDs + gateway JSON on the user surface,
verbatim. The same shot's roster segment renders the raw principal
"user:f7round2" (#8 residual BEFORE evidence).

## F-7 (#21) ROOT CAUSE — PROVEN by DOM micro-probe (repro-f7b/f7c)
The sweep trajectory is: select B2 -> ribbon Percent -> CLICK B2 AGAIN ->
Ctrl+Z. Grid.handleCellClick (Grid.tsx:826) starts an EDIT when the
already-selected cell is clicked: `if (sel.row === row && sel.col === col
&& !editing) startEdit(row, col)`. So the second click silently opens the
cell editor (draft "10", input focused); Ctrl+Z then lands INSIDE the
input (App's handler skips inputs by design) and the app undo never runs.
The cell "paints blank" because it is in edit mode: the display span is
replaced by the editor input (innerText "", and visually near-blank).
Probes: at the blank moment #cell-1-1 contains only
<span class="cell-editor-wrap"><input class="cell-editor" value="10">,
document.activeElement = that input; Escape cancels the edit and the
paint returns ("1,000.00%"); navigation revives via blur-commit. NO /read
or SSE traffic follows the Ctrl+Z (tap shows only session-extras/presence
200s) — the engine value was never touched.
SECOND defect (same acceptance): ribbon format changes record NO undo
entry anywhere (UndoManager captures values/formulas only), so even a
properly delivered Ctrl+Z cannot revert a format — it pops an unrelated
value entry (repro round 1 variant D: the edit under the format) or
reports "Nothing to undo."
FIX: (1) Grid.handleCellClick — a plain click on the selected cell keeps
the selection, never starts an edit (Excel parity: edit = double-click /
F2 / typing; product tests already describe double-click as the gesture;
no test pins the click-to-edit branch). (2) Format undoability —
UndoManager gains format entries captured by App's format handlers
(before/after FormatStore snapshots for the affected cells); undo/redo
restore them, mark format-dirty, and repaint.
BEFORE shots: shots/f7-before-B-blank.png, shots/f7-before-B-revived.png.

## F-3 (#18) REPRO (current tree) — acceptance FAILS, shape evolved
Sibling's F-2 fix has landed (.xls now opens: B2=10). Corrupt-.xlsx
fallback trigger: /load/stream -> 400. Aftermath in the current tree: the
tab does NOT return to the prior workbook — it shows a fresh blank
"Sheet1" (chip "Shared file"); typing lands in the void workbook
("Kiwi" at A9, shots/f3-poison-test.png). 401 storm largely healed by the
predecessor batch (4 total), but the PRIOR SESSION IS LOST to the tab.
Code: the switch in openRemoteBuffer releases the previous session
BEFORE minting; the mint-failure path restores it (rejoin + abort), but
the LOAD-failure catch only releases the failed claim and never rejoins
the previous file. FIX: mirror the mint-failure restore into the
load-failure catch (hoist prevFileId + a dropped-prev flag).
## F-4 (#17) REPRO (current tree) — defect present verbatim
repro-f4: ctxB status = 'Could not join file file-f56b84a8-...: gateway
409: {"ok":false,"error":"engine claim failed: engine already owns a
different file: file-27b97133-..."}'; sheet tabs ["+","+"] (no sheet);
typing "ghost" dies silently, status degrades to "engine access token
rejected (401)". Shots: f4-phantom-grid.png, f4-phantom-typed.png.
## #8 residual REPRO — status roster renders "user:ownerx" / "user:f7b"
raw principal text as the participant label (multiple runs).

## F-7 (#21) FIX LANDED (code; validation pending)
1. Grid.tsx handleCellClick: removed the click-on-selected-cell ->
   startEdit branch (plain click keeps the selection; edit stays
   double-click / F2 / typing, Excel parity).
2. features/undo.ts: UndoEntry gains formatsBefore (immutable
   FormatStore reference); FormatsUndoHooks + setFormatsHooks +
   captureFormatsOnly, mirroring the names pattern; all four
   undo/redo paths restore the captured store and carry the current
   store into the counterpart entry.
3. App.tsx: formatsRef + setFormatsHooks registration (snapshot = live
   store; restore = setFormats + markFormatDirty, so an undone format
   still autosaves); captureFormatsOnly called BEFORE mutation in
   handleFormat ('Format cells'), handleCellStyle, handleClearFormat,
   handleFormatAsTable, and both Format Painter apply sites.

## F-3 (#18) FIX LANDED (code; validation pending)
App.tsx openRemoteBuffer: prevFileId + droppedPrevSession hoisted to
the load's try scope; the switch sets droppedPrevSession when it
releases/disconnects the previous session; the LOAD-failure catch now —
after the existing failed-claim release — rejoins the previous file
(transport.connect(prevFileId) + setCollabFile) when the transport is
unbound, mirroring the mint-failure restore. The open error still
surfaces via setLastError.
## F-4 (#17) FIX LANDED (code; validation pending)
App.tsx: joinFailureMessage() maps raw gateway failures to plain
language (409/claim -> already-open wording; 401/403 -> access/sign-in;
404 -> not found; else generic). The join catch logs the raw error to
console only, sets a sanitized lastError, and raises a BLOCKING
full-app overlay (role=alertdialog, .join-failure-* in index.css,
theme tokens) naming the file — resolved from the owner's catalog like
the header chip, neutral 'Shared file' fallback — with 'Back to files'
(strips the file param) and 'Try again' (reload).

## #8 residual FIX LANDED (code; validation pending)
collab.ts: CollabBridge keeps a participantNames map fed by
setRemoteParticipants (which now accepts + retains the presence
payload's name instead of dropping it) and a setSelfDisplayNameProvider
(read live). collaborators() stamps each entry with name + isSelf.
App.tsx wires the provider to effectiveDisplayName() — the same chain
the outgoing presence payload is stamped with. StatusBar.tsx renders
participantDisplayName(p) (+ ' (You)' for self) as the label AND the
tooltip; the raw principal survives only as the React key.

## F-3 (#18) ROOT CAUSE — DEEPENED (supersedes the earlier note)
The App-level restore alone could never fire: the load failure never
reached openRemoteBuffer's catch. ALL THREE progressive loaders
(collabTransport.loadXlsxProgressiveDirect, signedEngineTransport,
engineTransport GatewayEngineTransport) shared the same catch shape:
`if (accumulated) return accumulated; if (streamError) throw ...` —
and mergeLoadChunks turns an error chunk into an (empty) accumulation,
so an engine-reported parse failure RESOLVED as a successful blank
load. The previous session was already dropped by the switch: the
user landed on a blank Sheet1 bound to the failed file's session.
FIX (landed): in all three loaders the streamError check now precedes
the accumulated fallback. Regression tests: collabTransport (error
chunk after meta rejects), signedEngineTransport (meta+error and
error-only both reject), engineTransport (meta+error rejects). The
App-level restore in the load catch (previous section) completes the
acceptance once the failure actually surfaces.
VALIDATION STATE: F-7 AFTER proven on build5. F-3/F-4/roster AFTER
runs are BLOCKED on a sibling-caused build break: the current tree
crashes the grid with React error #185 (max update depth) on +New —
introduced by another worker's in-flight AgentChat/Ribbon edits
(build5, without them, ran clean). Waiting for the tree to settle,
then rebuild + re-run the three scenarios.

## FINAL VERDICTS (2026-10-22, worker 6f6c63dd)

### F-4 (#17) — AFTER: PASS ✅
- Wipe + repro-f4 on the fixed build: ctxB's join 409 now renders the BLOCKING
  `.join-failure-overlay` — screenshot shots/f4-after-blocking.png: title
  "simple.xlsx" (real file name resolved from the joiner's own catalog), body
  "This file is already open in another session. Close it there, or wait a
  moment for that session to end, then try again.", buttons "Back to files" /
  "Try again". The grid is fully covered; scripted typing never reached a cell
  (A1 stayed empty; before-fix it showed "● Unsaved changes" + a 401 rejection).
  Status bar carries NO 'gateway 409', NO file UUID, NO raw JSON (before-fix
  status leaked all three — see the F-4 BEFORE section).
- Second branch proven incidentally (roster staging): a non-owner deep-link
  join is refused by the gateway with 404 (POST /api/engine/open user:bob ->
  404 even with the owner's session live) and renders the overlay's not-found
  branch — shots/roster-b-joined.png: title "Shared file" (neutral fallback),
  "This file could not be found. It may have been deleted, or the link may be
  incomplete." Sanitized, blocking, actionable.

### #8 RESIDUAL — AFTER: PASS (unit + solo browser) ✅
- Unit: collab.test (bridge stamps payload names + live self-name provider,
  skips self-echo) and StatusBar.test (renders 'Alice A (You)', 'Bob B',
  'Guest' fallback; asserts NO raw principal string anywhere in the HTML) —
  all pass.
- Browser solo AFTER (three independent runs — F-7 AFTER, F-4 ctxA, F-3
  restore): the status roster renders "Guest (You)" — the participantDisplay
  Name chain's neutral fallback (the dev-login display name equals the bare
  id in this stack, and the settings display-name does not load in the
  gateway-only local topology — the sweep noted the same /api/settings
  environment gap) — and NEVER the raw "user:<id>" the BEFORE runs showed.
- A two-client roster screenshot could NOT be staged in this posture: the
  gateway refuses cross-owner joins (404 above), so a second user cannot
  enter the owner's session without a share grant. Flagging for the parent:
  cross-user co-authoring entry in the current product posture needs that
  grant path; the D8 batch's two-client presence proof predates the
  owner-scoped catalog.

### F-3 (#18) — ROOT CAUSE (deepened twice) + FIXES LANDED
1. **Load failures never surfaced (the core defect).** The corrupt file's
   /load/stream answers HTTP 200 with an in-stream error chunk ("failed to
   parse xlsx: XlsxAdapter.read: not a readable spreadsheet package"). All
   THREE progressive loaders (collabTransport.loadXlsxProgressiveDirect,
   signedEngineTransport.loadXlsxProgressive,
   engineTransport.GatewayEngineTransport.loadXlsxProgressive) caught the
   rejection with `if (accumulated) return accumulated; if (streamError)
   throw` — and mergeLoadChunks turns an error chunk into an empty
   accumulation, so a parse failure RESOLVED as a successful BLANK load.
   openRemoteBuffer's restore catch never fired; the user landed on a blank
   Sheet1 bound to the failed file's session. FIX: the streamError check now
   precedes the accumulated fallback in all three loaders. Regression tests
   added in all three transports (meta+error stream and error-only stream
   reject); all pass.
2. **Restore of the previous session (App).** openRemoteBuffer now tracks
   prevFileId + droppedPrevSession at function scope; the load catch, after
   releasing the failed claim (engine log confirms release reason
   "load-failed"), stashes a plain-language notice in sessionStorage and
   navigates to `?file=<prevFileId>` — a full reload was chosen after two
   in-place rejoin variants restored the session server-side but never
   repainted the client view. A boot effect surfaces the notice once the
   restored workbook finishes loading ("The file could not be opened (…).
   Your previous workbook was restored.").
3. **Engine side PROVEN intact:** the previous (.xls) session checkpoints
   (4,537 B, checksum 8949afbb…), is released "superseded-by-new-open", the
   corrupt session is released "load-failed", and on the restore navigation
   the engine logs `session rehydrated … checksum=8949afbb…` (content
   intact); post-restore edits autosave (rev0/rev1 checkpoints).
4. **REMAINING BLOCKER (engine/gateway territory, NOT fixed here):** after a
   release → rehydrate → join, the client's reads fail persistently with
   401 "engine access denied: wrong-session" (response capture in
   debug-f3e: /read, /sheets, /snapshot all 401 after initial 409
   "session is released (idle) — rehydrate to resume"). The rehydrated
   workbook's FRAME returns (sheet tab "Data") and the session accepts ops
   (typed input landed + saved), but cell values do not repaint because the
   gateway-minted access scope does not match the engine's rehydrated
   session id. This is the same family as the sibling worker's flagged
   cross-finding (stale sessions wedging opens with 409) and sits in the
   engine/gateway rehydrate path, outside this batch's client scope.
   => F-3 is NOT claimed ready to close: items 1–3 (the client/loader
   defects that made a failed open poison the session and hide the error)
   are fixed and proven; the rehydrate scope coherence needs an
   engine/gateway fix before the restore paints values again.

### F-7 (#21) — CONFIRMED ON THE FINAL BUILD ✅
Re-run on build11 (all batch fixes + siblings' settled tree): the sweep
trajectory (B2=10 -> ribbon Percent "1,000.00%" -> one Ctrl+Z) leaves B2
painted "10" in its restored format at every poll; screenshot
shots/f7-after-B-stable.png shows the full sheet painted (Apples 10 /
Oranges 20 / Total 30 / Dav 2026-10-22 / Rate 25%), formula bar "10",
no editor stuck open. Ready to close #21.

### F-3 (#18) — FINAL VALIDATION (build13, two consecutive wipe-fresh runs)
- Status after the corrupt open, both runs: "… Guest (You) **That file
  could not be opened. Your previous workbook was restored.**" — the
  failure surfaces, in plain language, no parser internals, no ids.
- Poison test, both runs: typing 'Kiwi' at A9 in the restored workbook
  LANDS (the prior session is editable; the build12 run's one miss was
  the rehydrate path's own flakiness — 2/2 here plus the build10
  engine-log proof that the op autosaved rev0->rev1).
- 401 counts for whole runs: 9 and 6 total (boot/sign-in/rehydrate
  transitions) — the sweep's continuous /execute + /session-save-status
  storm is gone.
- STILL OPEN (the one acceptance gap): the restored workbook's cell
  VALUES do not repaint (B2/A1 read empty) — reads fail 401
  "wrong-session" against the rehydrated session (evidence in the F-3
  section above; engine/gateway rehydrate scope coherence — route with
  the sibling's stale-session cross-finding).

## Tests (final tree)
Related suites only: 133 passed / 0 failed — undo, undoAsync, collab,
StatusBar, collabTransport, signedEngineTransport, engineTransport,
GridSelectionDefects, grid-commit-once (new regression tests: 3 loaders
reject error-chunk streams; undo captures/restores format stores;
bridge stamps names + isSelf; roster renders names, never principals).
Web build (build:local-stack, tsc + vite + verify-dist): exit 0
(build13). No push (per brief); progress.md untouched.
