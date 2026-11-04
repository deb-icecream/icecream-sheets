# AI Agent Validation — Re-run + Residual Fixes — REPORT

Coordinator: agent-rerun (dispatched 2026-10-22 ~01:57 PDT)
Brief: hidden_files/agent-rerun/BRIEF.md
Predecessor record: hidden_files/agent-features/FINAL-REPORT.md
Join-defect proof: hidden_files/shell-integration/REPORT.md

## Verdict standard
PASS = live evidence on disk (transcripts, screenshots, read-backs).
Prose claims without artifacts do NOT count.

## Scope checklist
- [x] 1. Case 11 fix: web add-on host passes open gateway file id (FIX-R1) + token-minting residual (FIX-R3) + live validation PASS
- [ ] 2. FIX-B residuals (3)+(4): participant binding + role-scoped agent tokens (refused-write proof)
- [ ] 3. Live re-runs: cases 1, 2, 3a, 3b, 4, 5, 6, 7, 12, 13, 14, 15, 16, 17, 18, 19
- [ ] 4. Case 20 blemish re-check (K4 prompt protocol)
- [ ] 5. Case 9: FAIL-GAP (user decision pending — do NOT build triggers)

## Per-case verdicts
(pending)

## Fix records
(pending)

## NOT RUN list
(pending)

## Log
- 2026-10-22 ~01:57 PDT: REPORT.md skeleton created; reading brief + predecessor reports.

## Recon findings (2026-10-22 ~02:0x PDT, code-read by coordinator)

### Case 11 root cause (confirmed in code)
- `apps/web/src/ribbonParity.tsx:765`: `addonDocumentId = ctx.documentId ?? 'local-workbook'`.
- `apps/web/src/App.tsx` `useRibbonParity({...})` (~line 3278) NEVER passes `documentId` (zero hits in App.tsx), so gateway sessions always bind add-ons to 'local-workbook'.
- App.tsx tracks the open file in `collabFileId` state (~line 1317). FIX: pass `documentId: collabFileId ?? undefined` — local mode keeps the 'local-workbook' default (collabFileId is null there).
- Server side is consistent: gateway addons svc /run resolves the binding via `resolveBinding(documentId)` → engine-service binding; grants are keyed by documentId. The real file id is the missing piece.

### FIX-B (3)+(4) root cause (confirmed in code)
- `packages/gateway/src/services/agentSessionResolver.ts` ALREADY honors `participants` on a registry record (string / {principal} / map shapes) — but no writer ever records them: `deploy/fileRegistry.ts` FileRegistryRecord has no participants field and the interface has no participant write.
- Gateway `/api/engine/open` (gateway.ts): JOIN path (live owner, and CAS-loser join) mints the joiner a token with `requestedRole` ('editor' default / 'viewer') and writes NOTHING to the registry. CLAIM path records only creatorPrincipal.
- `packages/gateway/src/services/agentSvc.ts` `defaultMintEngineToken` hardcodes `role: 'editor'` (~line 159; the comment at ~121-127 admits "a viewer-only binding is a future refinement").
- Engine enforcement EXISTS: engineSvc.ts /ops and /charts — `role = accessClaims?.role ?? participants.get(principal) ?? 'editor'`; viewer → 403 `{ok:false, rejected:true, reason:'viewer-role'}`. So a viewer-scoped agent token's writes WILL be refused by the engine; NodeRemoteEngineHost surfaces visible rejections.
- FIX PLAN (per FIX-B report's prescription — record participants+roles in the registry at open/join):
  1. fileRegistry: optional `participants?: Record<string,'editor'|'viewer'>` on the record + `noteParticipant(fileId, sessionId, epoch, principal, role)` on the interface, implemented in Local/Memory/Firestore adapters (applies only when sessionId+epoch match the live record; never touches ownership fields).
  2. gateway /open: after a successful JOIN (both join paths), best-effort noteParticipant(principal, requestedRole) — a recording failure must not fail the open. Skip when principal === creatorPrincipal (creator precedence in the resolver).
  3. resolver: extract the principal's role (creator → 'editor'; participant → recorded role; role-less legacy participant entry → 'viewer' fail-safe) and carry it on ResolvedAgentSession.
  4. agentSvc: minter uses session.role (chart sink shares the minter → role-scoped too); stale comment corrected.
  5. Tests: registry adapters, resolver role extraction, binding/minter role.
- Live proof owed: bob joins as viewer → registry shows bob:viewer → bob's agent READ works, WRITE refused (viewer-role), cell unchanged on engine read-back; bob joins as editor (control) → agent write lands.

### Stack state at start
Ports 8100/8101/8105/8107/8108/4173 UP (200); MCP http :8106 DOWN (chat path uses in-process MCP via agentSvc — not blocking; restart if a case needs it).

## Fix records (2026-10-22 ~02:1x PDT)

### FIX-R1 — Case 11: add-on host passes the open gateway file id
- `apps/web/src/App.tsx`: `useRibbonParity({...})` now passes `documentId: collabFileId ?? undefined` (with explanatory comment). Local mode unaffected (collabFileId null → 'local-workbook' default stands).
- Web `tsc --noEmit` clean.
- Live validation: PENDING (tour after dist rebuild).

### FIX-R2 — FIX-B residuals (3)+(4): participant binding + role-scoped agent tokens
- `packages/gateway/src/deploy/fileRegistry.ts`: record gains optional `participants?: Record<string, RegistryRole>`; interface gains `noteParticipant(fileId, sessionId, epoch, principal, role)` implemented in Local/Memory/Firestore adapters (live-record + session/epoch match required; ownership fields, revisions, updatedAt untouched; claims reset participants wholesale).
- `packages/gateway/src/gateway.ts`: both JOIN paths of POST /api/engine/open now best-effort `noteParticipant(principal, requestedRole)` (skipped for the creator; failure never fails the open).
- `packages/gateway/src/services/agentSessionResolver.ts`: `participantRole()` + `roleForPrincipal()` added; `ResolvedAgentSession.role` (creator 'editor'; participant = recorded role; role-less legacy participant = 'viewer' fail-safe); legacy participant shapes still honored.
- `packages/gateway/src/services/agentSvc.ts`: `defaultMintEngineToken` mints `role: session.role` (was hardcoded 'editor'); chart sink shares the minter (role-scoped too); runtime cache key now `sessionId:role` so a same-session role change rebuilds the bound runtime instead of minting stale-role tokens.
- Tests: gateway fileRegistry + agentBinding + agentCharts = **33/33 PASS** (new: noteParticipant semantics incl. fencing/dead-lease/reset-on-claim; resolver role matrix incl. creator precedence; viewer-participant describe — chat write reaches the fake engine with a viewer token, write refused, cell unchanged, read still answers 21006). phase2Collab **15/15 PASS**. Full gateway suite: **325/325 PASS (32 files)**.
- ⚠️ Write-path hazard hit + repaired: one inserted test line containing a secret-shaped assignment was redacted to literal `<redacted>` bytes on disk by the file-write path (same hazard the shell-integration worker documented); caught by esbuild, repaired via python write, verified byte-level; tree grep confirms no other touched file carries the corruption.
- Live proof: PENDING (two-user tour after dist rebuild + stack restart).

## Stack (restarted 2026-10-22 ~02:2x PDT on rebuilt dists)
- Gateway dist rebuilt (registry/resolver/agentSvc/gateway changes); web dist rebuilt via `npm run build:local-stack` — verify-dist OK (gateway 8100 + signed, 6 assets).
- mcp-server dist rebuilt (no source change — its dist predated the parent's firestore-node subpath split and failed to start: barrel import of FirestoreMetadataPersistence; rebuilt dist imports `@icecream-sheets/service/firestore-node`).
- Stack via start-stack-agent.sh: 8100/8101/8102/8103/8104/8105/8107/8108/4173 all 200; MCP :8106 restarted separately with MCP_AUTH_SECRET from .local-stack-env — 200, auth enforced, store local.

## FIX-B live proof — PASS (2026-10-22 ~02:25 PDT, coordinator-run)
Script: hidden_files/agent-rerun/fix-b-proof.mjs · Evidence: cases/fix-b-live/results.json
- alice created session (file-3cc45da2…); bob POST /api/engine/open role:'viewer' → joined:true, role 'viewer'; registry record then carried `participants: {"user:bob": "viewer"}` — residual (3) CLOSED at the data layer.
- Bob's Vertex-backed agent: "set C1 to 999999" → audit write_cells ok:false; agent replied "I cannot set C1 to 999999 because you only have viewer access to Sheet1…"; engine read-back C1 = null (write did NOT land).
- Bob's agent read as viewer: "The sum of A1:A3 is 21006." ✓
- Bob re-joined role:'editor' → registry participants updated to 'editor'; agent write ok:true; engine read-back C1 = {number, 999999} — role promotion took effect for the agent in the SAME session (sessionKey role component works).
- ALL 7 verdicts true → **scope item 2 (FIX-B residuals 3+4): DONE** (unit 33/33 + phase2Collab 15/15 + full gateway suite 325/325 across 32 files + this live proof).

## Tour plan (sequential waves — the local engine hosts ONE live session)
- Wave A: case 11 browser validation (worker 3aeaf29c) — dialog documentId + Sum Reporter sum vs engine read-back.
- Wave B: cases 1/2/5/6 (alice) via the predecessor's tour-core.mjs pattern (assertions tied to w3a-fixture.json ground truth; evidence redirected to agent-rerun/cases/).
- Wave C: cases 3a/3b/4 + 12 (carol) — analysis chart inline; generated app (embed/persist/live binding); native chart -> save -> reopen -> download parse-back; app-builder UI.
- Wave D: cases 7/13/14/15/16/17/18/19 + case-20 re-check (bob) via w3b-work patterns (tour-w3b.mjs, case20.mjs) + shared-fixtures (SUM revenue 4027.86 for CSV/SQL).
- Case 9: FAIL-GAP stands (user decision pending; triggers NOT built).

### INFRA INCIDENT 2026-10-22 ~02:3x PDT — runtime restart killed the whole stack
- Runtime restart tore down every service process (gateway/engine/vault/meta/etl/agent/addons/connectors/web + MCP). /tmp was wiped (gwlogs gone).
- Recovered: stack restarted via start-stack-agent.sh (all ports responding; 4173=200) and MCP restarted with MCP_AUTH_SECRET from .local-stack-env (health 200, unauth /mcp = 401).
- Consequences: (a) agent-service config is in-memory → Vertex config must be re-POSTed before Wave B (tour-core.mjs does this in-script with a fresh gcloud token); (b) the case-11 validation worker was mid-run during the outage — its evidence will be judged accordingly; re-run if the outage corrupted the tour.

## FIX-R3 — case-11 residual: add-on binding forwards the gateway JWT to a signed engine (2026-10-22 ~02:35 PDT)
- Worker verdict: binding fix VERIFIED (documentIdShown = file-b29841ac-50c8-4086-88c6-c449a0cccef1 = expected; API read-back exact; sum 58) but UI run FAILS: "engine access denied: malformed" — `addonEngineBinding` forwards the caller's 3-part gateway JWT; signed engine access requires the 2-part engine-access token. Worker's non-UI diagnostic with a proper engine token: POST :8107/run → 200 {sum:58, count:5}. Same banner in the ORIGINAL case-11 screenshot → predates FIX-R1.
- Coordinator-confirmed in code: addonEngineBinding.ts headers() forwards opts.authorization; wiring sites = bin/addons.ts AND services/servicePackage.ts (productionAddonDeps).
- ALSO FOUND: engineSvc /execute has NO viewer-role gate (unlike /ops ~4403 and /charts ~4332, same pattern) — once add-on tokens are role-scoped, a viewer's add-on could still write via /execute. Closing with the identical gate (sibling-route consistency; flagged as a judgment call).
- FIX PLAN: (1) agentSessionResolver gains file-scoped pickSessionForFile + createFileSessionResolver (records/live/principal-match/role via existing helpers); (2) addonEngineBinding gains getAuthorization (per-call mint, 120 s TTL, role = the user's session role) + createProductionAddonResolveBinding factory (fail closed when no live session for the document); (3) bin/addons.ts + servicePackage.ts share the factory; (4) engineSvc /execute viewer gate; (5) tests: resolver file-scoping in agentBinding.test.ts; signed-engine regression in addonRunBinding.test.ts (fake gateway JWT on /run still succeeds via minted token; old forwarding rejects 'malformed'; viewer participant reads OK but stamper write refused; no-session document → 502). Then rebuild gateway dist, restart stack, re-run case-11 browser validation.
- NOTE: the production resolver source inherits FIX-B residual (2) — local registry file locally; a Firestore listing adapter is still needed for prod, same seam as the agent resolver.

### FIX-R3 LANDED 2026-10-22 ~02:45 PDT (code + unit; live re-validation dispatched)
- `agentSessionResolver.ts`: extracted toResolvedSession + loadRecords; NEW pickSessionForFile + createFileSessionResolver (file-scoped, live lease, creator/participant match, role via roleForPrincipal).
- `addonEngineBinding.ts`: binding gains getAuthorization (per-call, wins over static authorization); NEW createProductionAddonResolveBinding — resolves the document's live session for the principal (fail closed: throw → /run 502), binding targets the session's engine endpoint, token minted per engine call {sub, sid, fid, role = user's session role, tier standard, TTL 120 s} via issueEngineAccessToken over ENGINE_ACCESS_SECRET; no secret → no bearer header (unsigned contract).
- `engineSvc.ts`: /execute gains the viewer-role gate identical to /ops and /charts (403 {ok:false, rejected:true, reason:'viewer-role'}).
- Wiring: bin/addons.ts and servicePackage.productionAddonDeps now share the factory (cannot drift); gateway index.ts re-exports it.
- Tests: agentBinding 23/23 (3 new file-scoped resolver tests); addonRunBinding 11/11 (5 new signed-engine tests: gateway-JWT-on-request run sums 60; legacy forwarding rejects /malformed/; viewer participant reads 60 but stamper write refused + cell unchanged; editor stamper control writes; no-session document → 502); phase2Collab + fileRegistry + agentCharts 28/28. Gateway tsc clean. Gateway dist rebuilt; full stack restarted — all 10 ports 200 on /health.
- Remaining: full gateway suite re-run (background, at program end) + case-11 browser re-validation.
- FULL gateway suite on the FIX-R3 tree: **333/333 PASS (32 files)** — 325 baseline + 8 new FIX-R3 tests, zero regressions (incl. all /execute callers). Web tsc was verified clean at FIX-R2; gateway tsc clean at FIX-R3.

### CASE 11 — FINAL VERDICT: PASS (2026-10-22 ~02:50 PDT, coordinator-verified on disk)
- Re-validation run (worker ccede4cb) on the FIX-R3 stack: fixture file-bc184a2d-7666-432c-b1f6-51e18035d70f, session sess_a102ca6a-4d82-4a81-a032-dd1c435343df.
- result.json: pass=true, verdict PASS, documentIdShown == expectedDocumentId (NOT local-workbook), reportedSum 58 == expectedSum (count 5), runErrorText null, apiMatch true, apiColASum 58 pre+post.
- Screenshot 09-after-run.png: dialog shows the file id, "Granted on this document", green banner Result: {"sum":58,"count":5} (worker-inspected; file on disk, 106,509 B).
- Evidence: hidden_files/agent-rerun/cases/case-11/ (result.json, case-11-run3.md, 01–09 screenshots, run.log.txt; the pre-FIX-R3 failing run preserved as result-run2-prefixed.json + case-11-run2-prefixed.md).
- **Scope item 1 DONE.** Next: Wave B (cases 1/2/5/6, alice).

## WAVE B VERDICTS (cases 1/2/5/6, alice, Vertex gemini-2.5-flash-lite LIVE — coordinator-verified on disk)
Backend proof: config POST 200 with fresh gcloud token; API probe answered in 759 ms; case 6 produced a natural-language decline in 35 s at the END of the tour — the real model was reachable throughout (NOT the deterministic fallback).
- **Case 1: FAIL.** Both turns completed (~75 s/72 s) and ended with the runtime's own "I ran out of steps for that request. Could you break it into smaller parts?" North/89,100 never named; >14000 rows never listed. Attempt 2 rendered a "Column means" chart before exhausting steps — the planner burns its step budget on clarification asks + analysis artifacts on a trivial 12-row aggregation.
- **Case 2: FAIL.** All 3 turns ended "I didn't get an answer in time, so I stopped here…" (244 s/36 s/43 s). API read-backs: Jun South (row 12, col 2) still 14200 (15000 write never landed); row 13 label + revenue both null (no TOTAL row/formula, no 160,200); total 159,400 never answered.
- **Case 5: FAIL.** One 278 s turn → same timeout termination. Column D read-back: 0/12 rows carry a share (all null).
- **Case 6: PASS.** Declined in 35.5 s ("I cannot directly email spreadsheets or perform actions outside of the spreadsheet environment…"); pre/post API snapshots byte-identical (cell-level verified) — no mutation.
- Evidence: cases/TOUR-WAVE-B.md, tour-wave-b.mjs, tour-wave-b-results.json, case-01/02/05/06/{transcript.json,transcript.txt,chat-and-grid.png,readback*.json,result.json}, case-06 snapshots; attempt-2 provenance under cases/attempt2/. Fixture session (attempt 3): file-dc4186de-6d51-45de-8620-fd9104616dd4.
- NEW DEFECT (for the parent — outside this program's named fix scope): the planner degrades on multi-step work on flash-lite — step-budget exhaustion on read/aggregation questions and LLM-call timeouts on edit/analysis turns, while short paths (declines, single reads — cf. the FIX-B proof this morning) succeed. Mechanism not provable from outside (agent.log carries no planner internals); candidates: planner loop behavior (clarification/artifact detours) + per-call latency under multi-step load. Blocks cases 1/2/5; expect related failures in Waves C/D.
- Infra notes: engine tokens expire ~10 min after gateway open (harness refreshes per read in attempt 3); #file= grid paint flaky once; Chromium died under VM memory pressure in attempt 2 (leaner flags survived attempt 3).

## WAVE C VERDICTS (cases 3a/3b/4/12, carol, Vertex LIVE — coordinator-verified on disk)
Backend proof: config POST 200 (fresh token), probe 1,181 ms; real model artifacts produced in-tour. Session file-9d9ced6e-94b3-41ea-a3b4-d8bcf40fb2b2 / sess_87e7e71d-f89c-43de-9809-b560eee67ccc. Fixture ground truth: North 89,100 / South 70,300 / total 159,400.
- **Case 3a: FAIL.** analyze_data fired; a Chart.js chart rendered inline in 5.3 s — but it is the WRONG chart: labels ["Revenue"], one dataset "mean" = [13,283.33] (grand mean), titled "Column means". No region grouping, no sums; the reply even calls the single mean bar "mean revenue by region". Root cause: the analysis lane emits its generic column-means chart and ignores the group-by + sum request (same artifact Wave B saw pre-exhaustion).
- **Case 3b: FAIL.** Generation worked: artifact artifact_mvjegmj6_2 (3,483 chars React, mcp.call('read_cells', …BINDING…)) stored, embedded in chat, persisted across reload (Apps tab "Saved apps (1)"). But the panel body rendered BLANK — no data rows in any frame — so two-way binding was not demonstrable. Consistent with the shell-integration observation (app frame renders heading, data rows empty: get_results/read returns nothing renderable). Mechanism not provable from outside.
- **Case 4: FAIL (pending one clean re-run — see below).** No native chart created: canvasCount 0 in two browser contexts, session revision stayed 0, download parse-back decisive — downloaded.xlsx 6,893 B verbatim autosave, parts=[], hasChart1Xml=false, readCharts=[]. Caveat: the chat turn ran blind (leftover Audit view hid HITL asks) to the 300 s timeout and a harness SVG-count bug suppressed the planned retry (worker's correction-note.md documents two false-positive assertions in its own result.json). End state is decisive for THIS run; a clean re-run with live HITL is required before the verdict is final.
- **Case 12: PASS.** UI builder end-to-end: Insert → "Build App" → range (Last row=13, Last col=3) → Next (Views) → Next (Configure) → App name "Wave C Sales App" → Next (Preview) → "Create app". Preview + auto-opened runner render all 12 fixture rows with exact values. LIMITATION (new finding): UI-built apps persist only in the creating browser profile's localStorage — a fresh profile for the same user+file shows "No apps yet"; not stored server-side or bound to the file.
- Evidence: cases/TOUR-WAVE-C.md, tour-wave-c*.mjs, tour-wave-c-results.json, case-03a/{chart-data.json,chat-chart-inline.png,transcript.*,result.json}, case-03b/{app-generated.png,apps-after-reload.png,artifact-source-head.txt,transcript.*,result.json}, case-04/{downloaded.xlsx,parse-back.json,chart-in-grid.png,reopened-second-context.png,correction-note.md,result.json}, case-12/{01–07 step screenshots,06-builder-step3-preview.png,verify-attempt3.json,result.json}.
- Cross-cutting: #file= join grid-paint flakiness recurred (2 of 4 joins never painted despite valid server sessions).

### CASE 4 — FINAL VERDICT: PASS (clean re-run, 2026-10-22 ~03:1x PDT, coordinator-verified on disk)
- Re-run (worker a701dddc) removed the harness defects (normal chat view throughout, live HITL, real chart detection). Canonical run branch-analyze: file file-9e523445-7b36-4ddf-90d1-2c26653b8699 / sess_7552d3d1-9171-4c8b-bdaf-e916090a90cd; replicated by branch-answer.
- Decisive evidence: revision 0 → 1 (single chart.add); storageRevision 1 after save; ChartOverlay "Month vs Revenue" (column-clustered, 750×313 canvas) visible in grid in first browser AND after reopen in a second context; downloaded.xlsx (9,064 B) parse-back: xl/charts/chart1.xml + xl/drawings/drawing1.xml present, readCharts series Sales!$C$2:$C$13, categories Sales!$A$2:$A$13, valCache = all 12 fixture revenues EXACT, catCache Jan–Jun ×2.
- All turns 8–11 s, no timeouts — the Wave B planner degradation did NOT recur on this direct tool route.
- NEW FINDINGS: (1) first-turn sheet-context failure 3/3 runs — agent reports sheet 'Sales' "not found" on turn 1 although pre-chat read-backs prove the session holds it; turn 2 works (session-binding warm-up race suspected). (2) Intent-router dead end: the disambiguation for an explicit in-sheet chart request offers "Build an app / Analyze & visualize / Just answer" — NO native-chart option; the "Build an app" branch dead-ends (FAIL preserved as main-run-*). create_chart itself is sound 2/2 once reached.
- Evidence: cases/case-04-rerun/ (result.json 8/8 assertions, case-04-rerun.md, transcript.txt, chart-in-grid.png, reopened-second-context.png, parse-back.json, downloaded.xlsx, chart1.xml, branch-analyze/, branch-answer/, main-run-*).
- **Wave C final: 3a FAIL · 3b FAIL · 4 PASS (re-run) · 12 PASS.**

## SCOPE UPDATE (user rulings 2026-10-22 ~04:08 PDT, via MEMORY.md)
- Perf sign-off measurements are NOT deploy blockers; P95 save 36.3 s ACCEPTED yellow for first deploy.
- **The user directed the planner multi-step fix (Wave B cases 1/2/5) — fix it and validate it.** Deploy gate reduces to: agent re-run verdicts WITH the planner fix validated. → The planner fix is now IN this program's scope: root-cause → fix → re-validate blocked cases (1/2/5 + any Wave D casualties + 3a if the analysis lane is touched).
- Item L (collabTransport stale-token refresh on six secondary paths) was directed in the same ruling; it belongs to the residual-(p)/sweep lineage, not the agent program — flagging for the parent to assign; not silently absorbed here.
- ORDER OF WORK REVISED: root-cause + fix the planner FIRST, then run Wave D once against the fixed build, re-running 1/2/5 as the fix validation (Wave B/C pre-fix failure evidence already on disk keeps the before/after honest).

## FIX-R4 ROOT CAUSE — planner degradation (from planner-diag.mjs, audit-log ground truth, 2026-10-22 ~03:2x PDT)
Reproduction: fresh alice session (file-955885d2-7570-4295-9348-a62b6fadd1e1), W3a Sales fixture, ONE API turn "What is the total revenue in the Sales sheet?" — 53.7 s, audit captured in cases/planner-diag/results.json. The audit proves, in order:
1. **Unbounded first read**: read_cells attempted a 1,002,001-cell range → rejected ("range too large … max 100000"). The planner has no used-range discipline; one failure derailed the turn (no corrected retry followed).
2. **Mean substituted for total**: analyze_data ok → the agent answered "the total … is not directly available, but the average revenue is 13283.33" — the analysis lane's column mean presented against a SUM question (same generic-means defect as case 3a), and never summed the values itself.
3. **Ask cascade**: FIVE sequential HITL asks followed (chart? kind? sheet/range? which sheet? list sheets?) for a question needing none — each ask is a death chance in the browser (unanswered = the 240 s HITL wait = Wave B case 2 turn 1's 244 s "didn't get an answer in time"). The asks in this API run WERE answered within seconds by an answerer outside this script (pending-ask store is shared/persisted; answerer unidentified — possibly a still-open client of the user's deployment work — flagged as an observation, not chased).
4. **create_chart 'unknown sheet "Sales"'** on the fresh session (matches the case-4 re-run's 3/3 first-turn failure; retry works) + planner hallucinated a sheet named "index" for a later read. Final reply: "Here are the sheets in your workbook: Sheet1." — wrong on every level.
5. **Follow-up turns on the thread returned HTTP 500** (231/273 ms, empty) — thread/runtime state after the cascade; mechanism not yet isolated.
- Structural parameters: maxIterations = **5** planner iterations per loop (runtime.ts:242, not overridden by agentSvc); HITL server wait 240 s (agentSvc AGENT_HITL_TIMEOUT_MS) — matches Wave B's 244 s death; step-exhaustion = 5 plans all carrying tool actions.
- FIX-R4 plan: (a) planner prompt discipline — answer first, ≤1 ask/turn and only when genuinely blocked, no post-answer chart offers, bounded reads + sum-from-values (never mean-for-total), retry-once-with-corrected-args before asking; (b) maxIterations 5 → 10 at the agentSvc runtime construction; (c) read_cells oversized-range error must carry the sheet's used range (or clamp) so a retry can succeed mechanically; (d) chart sink retries a 400 'unknown sheet' once after re-resolving (nothing was created on that failure, so the retry cannot duplicate). Then rebuild + re-validate: planner-diag turns + Wave B re-run (cases 1/2/5) + case 3a spot check.
- Deploy context (user 04:19 PDT): deploy is UNCONDITIONAL now; this fix remains owed work, not a blocker. Item L stays flagged for the parent (not this program).

### FIX-R4 ROUND 2 (2026-10-22 ~03:45 PDT) — 429 root cause + classifier + formula-path + retry
- Round-1 diag re-run: turn 1 answered in 6.1 s (clamp works — reads ok) but with a WRONG total (169,400 vs 159,400): audit args prove the planner read the CORRECT values (Month col via clamped 100,001-row request; Region col twice — an identical repeat; Revenue col) and mis-added in its head. Turn 2 (write) OK in 1.7 s; NO 500s after a clean turn 1. Turn 3 looped analyze_data ×10 (the new budget) without converging.
- **The intermittent 500s are Vertex 429s** — captured raw: "agent error: openai-compatible backend: provider returned 429 (Resource exhausted…)" via gateway 500. The backend had NO retry: one throttled call killed the turn. This also explains part of Wave B's degradation under tour burst load (loops → more calls → throttling → more deaths).
- Round-2 changes: (1) analysis/planner.ts aggregate rule widened — "<measure> by <dimension>" + "per <word>" now classify as aggregate (was: fell through to summarize → Column means; case 3a's mechanism, deterministic). Tests: analysis.test.ts +5 classification rows. (2) Prompt: aggregates are ENGINE-COMPUTED — SUM/SUMIF scratch-cell formula + read-back + clear (>5 values; hand addition forbidden); NO TOOL LOOPS rule (never repeat an identical call; one non-converging analyze_data → switch to the formula path; 3 calls without the answer → answer with what you have). (3) OpenAICompatibleBackend: bounded retry with backoff on 429/5xx/transport failures (delays [1000, 2500, 6000] ms, injectable; client errors fail fast). Tests: agent-modelconfig +4 retry tests (429-recover, 5xx/transport-recover, persistent-429 gives up after 1+2, 400 no-retry); the pre-existing persistent-500 key-leak test now injects retryDelaysMs: [] (its subject is leakage, not timing) — assertions unchanged.
- Suites: service analysis + agent-backends 87/87; agent-modelconfig 25/25; service tsc clean (round-1: mcp server.test 11/11 incl. clamp, gateway agentCharts+agentBinding 31/31, service agent suites 60/60, all tsc clean).
- Rebuilt service dist; agent + MCP restarted. Diag re-run pending (quota-dependent).

## SUCCESSOR RESUME (coordinator 20f66d5e, 2026-10-22 ~05:16 PDT)

Successor coordinator taking over the AI Agent Validation Re-Run mid-program.
Resume state (parent-verified on disk): the grounding gate in
packages/service/src/agent/runtime.ts (grounded flag in runLoop, 5th param
through ask-resume recursion, set at all three executeTools sites; ungrounded
asks suppressed with a steering note) + matching tests in
packages/service/tests/agent-runtime.test.ts are ON DISK BUT UNVALIDATED
(predecessor's test run aborted mid-flight).

Order of work: (1) unit-validate the grounding gate (tsc + agent-runtime
tests); (2) coordinate with the still-running planner-fix program — final live
validation runs ONCE against the combined build; (3) live proof (planner-diag
turn 1 must compute 159,400, then cases 1/2/5 vs Wave B ground truth + case 3a
spot check); (4) Wave D (cases 7, 13, 14 re-test, 15, 16, 17, 18, 19, case-20
blemish re-check; case 9 OUT — triggers are a separate program now); (5) final
per-case verdict table in this report.

### GROUNDING GATE — unit validation + minimal fix (successor, 2026-10-22 ~05:2x PDT)
- tsc --noEmit (packages/service): CLEAN on the landed gate.
- First vitest run of tests/agent-runtime.test.ts: 23 passed / 3 FAILED —
  all three gate-caused, not environmental:
  (1) "pauses the turn on agent.ask_question…" and (2) "answer() delivers…"
  use makeAskBackend, whose first plan is a BARE free-text ask — the gate
  suppresses it by design, so nothing ever parks.
  (3) "app-generation prompts pause with options…" — a REAL product-flow
  conflict: the heuristic backend's appgen/unknown intents ask WITH OPTIONS
  (agent.offer_options: "Describe the app / Analyze the data instead") as
  the first move. An intent choice is not a sheet fact; no tool can answer
  it and there is nothing to ground on yet.
- MINIMAL FIX (gate intent preserved — planner must touch real data before
  asking the user for FACTS): the gate now suppresses only free-text asks;
  asks carrying options are exempt (documented in runLoop + at the gate).
  Every observed ask cascade was free-text; the ask budget still applies
  to all asks. Tests: makeAskBackend grounds with a read_cells in its
  first plan (the cascade test's shape — these tests verify HITL
  mechanics, not ask policy); new test pins the options exemption.
- Coordination state: planner-fix attempt 5 is IN FLIGHT (its cases/proof5/
  created 12:16 UTC). Real-repo runtime.ts does NOT yet carry their merged
  delta: line ~960 recursion still passes [] (M2 absent), plan() is not
  wrapped (M4-slim absent); real mcp-server has no far-write guard /
  writtenRowContext; real openaiBackend has no write-location bullet.
  Their program lands the delta "at program end" — LANDING HAZARD: their
  copy tree (icecream-sheets-pfx) predates the grounding gate, so a
  wholesale file copy would WIPE the gate; the final merge must combine
  M2 with the gate's recursion (pass results AND grounded). Recorded here
  so whoever lands it (them or me) merges, not overwrites.

### GROUNDING GATE — UNIT VALIDATION COMPLETE (successor, 2026-10-22 ~05:25 PDT)
- After the minimal fix above: service tsc --noEmit CLEAN;
  tests/agent-runtime.test.ts 27/27 PASS (incl. the new options-exemption
  test; both makeAskBackend HITL tests green again).
- Agent family: agent-modelconfig 26/26 + agent-backends 17/17 +
  analysis.test.ts — 113/113 PASS across the three files. No regressions
  from the gate or its fix. STEP 1 OF THE SUCCESSOR TASKING: DONE.

### PLANNER-FIX COORDINATION STATE (successor read, 2026-10-22 ~05:26 PDT)
- Planner-fix attempt 5 (12:17 UTC, cases/proof5/): case 1 PASS (North
  $89,100 + >14000 listing, ~5-6 s/turn); case 2 FAIL (Jun South still
  14200; TOTAL label missing; a =SUM(C1:C12) formula landed summing
  146,700 — wrong range/placement, the spatial-grounding class); case 5
  FAIL on Vertex 429 (graceful busy reply — M4 containment worked; quota,
  not logic).
- Attempt 6 (12:21-12:22 UTC, cases/proof6/): IDENTICAL verdicts
  (case 1 PASS; case 2 same end-state byte-for-byte; case 5 busy again).
  Their coordinator is still iterating; their REPORT verdicts section is
  still PENDING; the merged delta has NOT landed in the real repo.
- Consequence for this program: no completed planner-fix proof exists to
  adopt. Per the revised order of work, Wave D live runs wait for the
  combined build (FIX-R4 + planner delta + grounding gate); Wave D
  harness staging proceeds now so the wave runs once, cleanly, when the
  build is final. Live-proof absorption (successor step 3) triggers when
  the planner-fix delta lands or their program ends.

### WAVE D — HARNESS STAGED (successor, 2026-10-22 ~05:3x PDT)
- hidden_files/agent-rerun/cases/wave-d/: tour-wave-d.mjs (adapted from
  the staged w3b tour; evidence re-pointed to agent-rerun/cases/),
  setup-wave-d.mjs (fresh gcloud token + bob config POST + fixture),
  cors-server.mjs (:8899 inventory.csv), inventory.csv, RUNBOOK.md.
  Both scripts pass node --check.
- SQL leg corrected to the REAL shared fixture: the staged original
  assumed an orders/customer DB that does not exist; Wave D uses
  shared-fixtures/sales.db — sales table, SUM(revenue) = 4027.86,
  per-region East 1947.00 / South 1199.40 / North 539.46 / West 342.00.
  CSV leg ground truth: Widget Units = 55. Fixture truths: Amount total
  550, Quantity 47, North 320 / South 230, Apples 270, Oranges 200 max,
  WeatherLog Seattle 2026-10-21 = 16C. Case 19 expects F1 = 605.
- Case-20 blemish rule written into the runbook (PASS-clean / PASS-with-
  blemish / FAIL) with an explicit note to record whether the grounding
  gate steered the fresh-thread planner to memory_load.
- NOT RUN yet — waits for the combined build, per the revised order.

### MERGED DELTA PORTED + UNIT-VALIDATED (successor, 2026-10-22 ~05:35 PDT)
- Planner-fix attempts 5 (12:17), 6 (12:21), 7 (12:28-30 UTC) all landed
  IDENTICAL verdicts on their build: case 1 PASS; case 2 FAIL (Jun South
  write lands wrong — deterministically row 3 / Feb North per attempts
  3-4 forensics; TOTAL formula =SUM(C1:C12) sums 146,700, label missing);
  case 5 FAIL on Vertex 429 (graceful busy reply; quota). Their REPORT
  verdicts section is still PENDING; no completed proof exists to adopt,
  so this program absorbs the combined-build proof per the tasking.
- Their 12:19 UTC landing reached the real repo for mcp-server (far-write
  guard + writtenRowContext echo — server.test.ts now 13/13 incl. the +2)
  and openaiBackend (WRITES ADDRESSED BY CONTENT bullet, line 140) but
  NOT runtime.ts (their pfx runtime predates FIX-R4's ask budget + the
  grounding gate; a wholesale copy would have wiped both).
- PORTED by successor, merged with the gate: M2 (ask-resume recursion now
  passes accumulated results + asksUsed + grounded) and M4-slim (plan()
  wrapped: post-backend-retry throw -> 'timeout' audit entry + graceful
  busy reply, no runtime retry). PlannerOutput added to type imports.
  Their M2 + M4 unit tests ported verbatim into agent-runtime.test.ts.
- VALIDATION: service tsc CLEAN; agent-runtime 29/29; agent family
  142/142 (runtime 29 + modelconfig 26 + backends 17 + analysis 70);
  mcp-server server.test.ts 13/13. Combined source backed up at
  hidden_files/agent-rerun/gate-backup/runtime.ts.combined-merged.
- Current service DIST predates the gate entirely (0 hits for grounded /
  busy) — the combined live proof rebuilds it now.

### COMBINED BUILD LIVE ON THE SHARED STACK (successor, 2026-10-22 ~05:42 PDT)
- Rebuilt packages/service dist + packages/mcp-server dist (tsc, exit 0);
  dist greps verify the combined build: service runtime.js carries the
  grounding gate (x8) + M4-slim busy reply; mcp server.js carries
  writtenRowContext + FAR_WRITE_SLACK.
- Restarted ONLY the agent service (8105) and MCP (8106) per the
  predecessor's procedure. Two mishaps, both recovered: the gwlogs pid
  files were stale (killed two wrapper pids first; new instances died
  EADDRINUSE against the still-running old listeners), and one MCP
  instance refused to start without MCP_AUTH_SECRET (fail-closed working
  as designed). Verified end state: agent 8105 pid 30538 health 200 on
  the new dist; MCP 8106 pid 30643, auth enforced (unauth /mcp = 401),
  local store. Rest of the shared stack untouched.
- Next: planner-diag on the combined build (turn 1 must compute 159,400
  WITHOUT parking on a first-move ask), then cases 1/2/5 + 3a spot check.

## SUCCESSOR #3 TAKEOVER (coordinator 939df38b, 2026-10-22 ~06:36 PDT)

Third coordinator in line; predecessors 20f66d5e (died after landing the
combined build + running ONE diag turn) and dbe8fd0f both lost to daemon
restarts. State verified against the three program records on takeover:

- Grounding gate + M2 + M4-slim merged in real
  packages/service/src/agent/runtime.ts, unit-validated (agent-runtime
  29/29, agent family 142/142, tsc clean). Planner-fix "HELD" runtime
  delta in their REPORT is DISCHARGED by that merge (their own verdicts
  section confirms M2/M4 complementary; successor #1 ported them). Do not
  re-merge.
- Planner-fix program COMPLETE, final verdicts: case 1 PASS 5/5;
  case 2 FAIL (deterministic wrong-row write row 3 vs Jun South row 12 —
  flash-lite spatial-grounding limit; t3 partial: formula at right append
  cell, off-by-one =SUM(C1:C12) range, no TOTAL label); case 5 FAIL /
  NOT PROVEN (first planner completion for that turn shape persistently
  non-JSON at temperature 0; retries exhausted; containment graceful;
  named follow-ups: (1) log bounded prefix of unparseable completions,
  (2) completion-length control / plan-splitting, (3) re-run case 5).
- Combined diag result (cases/planner-diag/results-combined.json): turn 1
  "What is the total revenue in the Sales sheet?" STILL parked on the ask
  "Which column in the Sales sheet contains the revenue data?" (~255 s =
  HITL wait), ended with the graceful timeout reply (M4 works). The
  grounding gate did NOT suppress the first-move ask. DIAGNOSIS IS JOB 1.
- Wave C (parallel coordinator, same stack): W1 diagnosis PROVEN —
  NodeRemoteEngineHost.sheetNames() is cache-only, returns [] cold, so
  MCP create_chart fails 'unknown sheet' on turn 1 deterministically
  (fix in progress by their successor worker: populate-on-cold + one
  fresh re-check). W1 is chart-path; whether it also explains THIS diag
  (a read/aggregate turn) is to be determined from the audit trail.
  W2/W3/W4 in progress; W5 blocked on File-2 D2 revalidation.
- Wave D harness staged (cases/wave-d/, RUNBOOK.md) — NOT RUN.

Order of work: (1) diagnose gate failure from results-combined.json audit
+ runtime.ts gate code; fix at the proven layer; agent family green;
(2) re-run planner-diag turn 1 — PASS = 159,400 computed with NO ask park;
(3) confirmation runs cases 1/2/5 (one each) + 3a spot check on the
combined+fixed build — identical reproduction of the planner program's
documented 2/5 failure shapes = confirmed model limit, record and move
on; case 5 non-JSON again -> bounded-prefix logging fix is in scope,
then one re-run; (4) Wave D (7/13/14/15/16/17/18/19 + case-20 re-check);
(5) final per-case verdict table here.

### GATE DIAGNOSIS (parent, 2026-10-22 ~06:47 PDT — successor #3 died <5 min in; diagnosis done in the parent turn per the restart-survival protocol)

PROVEN from cases/planner-diag/results-combined.json + packages/service/src/agent/runtime.ts + packages/service/tests/agent-runtime.test.ts:

- Combined diag turn 1 audit: user_message -> question ("Which column in the Sales sheet contains the revenue data?") -> tool_call agent.offer_options ok:true -> timeout (~255 s). NO tool execution preceded the ask. Turn 2 (the write turn) worked end-to-end in 29.6 s on the same build — the machinery is sound when the planner leads with tools.
- The gate IS present in src and dist (dist grep: 8 hits for "grounded"). It did not fire because of its own documented EXEMPTION (the EXEMPTION comment at the top of runLoop + the gate condition ~runtime.ts:928): an ask carrying OPTIONS may park ungrounded, on the stated assumption "every observed ask cascade was free-text". Turn 1's ask was an options ask (agent.offer_options) — flash-lite packaged the fact-fishing question in options clothing, defeating the assumption.
- The unit suite PINS the exemption (agent-runtime.test.ts:269 "an options ask may park ungrounded"), which is why units were green while the live shape failed. The exemption protects real product flows (test :570 — app-generation prompts pause with options, e.g. "Describe the app / Analyze the data instead"), so deleting it outright is wrong.
- FIX DIRECTION (dispatched to a focused worker 2026-10-22 ~06:50 PDT): scope the exemption to the product flows it names (intent / app-generation choice asks), not to planner-generated asks on data turns — narrowest reliable discrimination the code supports (routed-intent context at the gate, an explicit marker on product-constructed asks, or product-defined option sets; never question-text classification). Update the :269 pinning test to the new rule (options ask on a data turn -> suppressed; product-flow options ask -> parks), keep :570 green, and prove live: planner-diag turn 1 computes 159,400 with NO ask park.
- Corroboration for Wave C W1 (not this fix's scope): diag turn 3 shows repeated questions, then read_cells failing "Unknown sheet: Sales" — first-turn sheet context missing in that session.

### GATE FIX (worker, 2026-10-22)
- STARTED 2026-10-22: focused fix worker dispatched for the options-ask grounding-gate exemption defect. Scope: ONLY the gate in packages/service/src/agent/runtime.ts (+ its pinning tests). No code changed yet.
- Plan: (1) read the GATE DIAGNOSIS evidence + runtime.ts + agent-runtime.test.ts (:269 pin, :570 product flow) + hidden_files/wave-c-fixes/REPORT.md (live coordinator on the same tree); (2) pick the narrowest discrimination the code supports (routed-intent context > explicit marker on product-constructed asks > product-defined option sets; never question text); (3) implement + unit-validate (tsc + agent-runtime + agent family); (4) note dist rebuild in this section BEFORE rebuilding, restart ONLY my isolated agent-service instance, re-run turn-1 diagnostic (PASS = 159,400 computed, no question/park in audit); (5) record fix + discrimination + live evidence here.
- DISCRIMINATION CHOSEN (worker, 2026-10-22): (b) an explicit marker on product-constructed asks. Evidence: (a) routed-intent context does NOT exist at the gate — runLoop receives only userText/toolResults; chat() performs only the scope gate; the appgen/unknown "intents" are detectIntent() results internal to the deterministic backend and never reach the runtime. (c) option-set matching is brittle (two literal sets in backends.ts; any future product set would silently break). (b) is reliable because the ONLY product constructions of ask actions in src are packages/service/src/agent/backends.ts:285 (appgen: "Describe the app / Analyze the data instead") and :296 (unknown-intent help menu), AND the LLM action parser (openaiBackend.ts:363-368) builds the ask object by explicit whitelist ({type, question, options}) — a marker field set only by product code cannot be forged by model output. Design: AskAction gains optional `intentChoice?: boolean` (types.ts), set true ONLY at the two backends.ts sites; the gate at runtime.ts:928 suppresses ANY ungrounded ask unless ask.intentChoice === true. Planner asks the product prompt itself instructs (e.g. chart-placement ambiguity, openaiBackend prompt) stay gated ungrounded — the planner can ground first, then ask; grounded asks still park. Test :570 exercises the REAL deterministic backend ("build me an app...") so it stays green via the marker at :285; test :269's fake backend carries no marker, so it flips to the suppressed rule, plus a marked variant pins that product-flow options asks still park.
- FIX LANDED in source (worker, 2026-10-22): types.ts AskAction gains `intentChoice?: boolean` (doc: set ONLY by product code; the LLM parser whitelist never copies it); backends.ts marks BOTH product constructions (appgen :285, help menu :296) `intentChoice: true`; runtime.ts gate condition is now `!grounded && ask.intentChoice !== true` — any planner-generated ask, options or not, is suppressed ungrounded with the existing steering note; EXEMPTION + gate comments rewritten to the marker rule with the falsified-assumption history. Next: update the :269 pinning test to the new rule (unmarked options ask on a data turn -> suppressed; marked product-flow ask -> parks), keep :570, run tsc + agent-runtime + agent family.
- BRIEF ALIGNMENT + BASELINE EXPERIMENT (worker, 2026-10-22): formal tasking is hidden_files/agent-rerun/GATE-FIX-BRIEF.md (user-directed documentation, 2026-10-22 ~06:55 PDT); this section follows it — fix requirements 1-4 match the implementation above (marker discrimination, exemption scoped not deleted, no text classification, free-text gate untouched). Agent-family run after the fix: 228/230 pass; 2 failures (agent-guardrails "rejects an over-cap answer() without consuming the pending ask"; agentThreadPersistence "a pending ask survives restart"). BASELINE EXPERIMENT: with the gate condition temporarily reverted to the OLD options-based form (marker inert under it), BOTH tests fail identically (2 failed | 21 passed) -> PRE-EXISTING, not caused by this fix. Mechanism: both fixtures predate the FIX-R4 gate + M2 asksUsed threading landing together (the successor's validated set covered only runtime/modelconfig/backends/analysis): (i) the guardrails fixture's first-move FREE-TEXT ask has been gate-suppressed since FIX-R4 — it never parks, so waitForPending starves; (ii) the persistence scenario needs a SECOND park in the resumed turn, impossible since M2 threads asksUsed=1 against maxAsksPerTurn default 1 (the follow-up ask is budget-suppressed and the heuristic compose() surfaces the budget note as the reply). Per the brief's "full agent family green" requirement, both fixtures get minimal updates to the current intended semantics, preserving exactly what each verifies (over-cap answer does not consume a parked ask; a pending ask survives restart and stays answerable). No product-code change is implied by either failure.
- UNIT VALIDATION COMPLETE (worker, 2026-10-22): packages/service `npx tsc --noEmit` CLEAN; agent-runtime 30/30 (the :269 pin rewritten: unmarked options ask on a data turn -> suppressed with the steering note, no park; marked product-flow ask -> parks and resumes; :570 untouched and green via the real deterministic backend). The 2 pre-existing family failures fixed at the FIXTURE level only (no product code): agent-guardrails over-cap-answer fixture now grounds with list_sheets before its ask (verifies the same thing: an over-cap answer() does not consume a parked ask); agentThreadPersistence restart scenario runs with maxAsksPerTurn: 2 (its choreography parks two asks in one turn; verifies the same thing: a pending ask survives restart and stays answerable). FULL AGENT FAMILY: 9 files / 260 tests ALL PASS.
- DIST REBUILD NOTICE (per brief, recorded BEFORE rebuilding): rebuilding packages/service dist (`npm run build`) next, then starting an ISOLATED stack on ports 8920/8921/8925 (gateway/engine/agent) with SESSION_DATA_DIR + store dirs under ~/workspace/tmp-gate-fix/data. Shared-stack processes (8100-8108) are NOT restarted; Node loads dist at process start, so running processes are unaffected until their own restart. Wave C coordinator was read (REPORT.md): W1 PASS, W2/W3/W4 PENDING, W5 blocked on File-2 — no Wave C live proof is mid-flight on the shared stack at this time.
- LIVE PROOF attempt 1 (worker, 2026-10-22): isolated stack came up clean on 8920/8921/8925 (all /health 200, gateway signed-access -> engine 8921). The turn-1 driver then failed at apiSetupSession: gateway 502 "engine claim failed: engine access denied: bad-signature". ROOT CAUSE (proven from /proc + ss, not a product defect): my engine process died in the daemon-restart churn, and the WORKSPACE SETTINGS coordinator's own isolated-stack engine (hidden_files/workspace-settings/gw-dist/bin/engine.js, started 14:05:52 UTC) bound the vacated 8921 with ITS stack's secret — my gateway's claim correctly failed signature against a foreign engine. (Coordination note for the parent: two isolated stacks allocated overlapping port blocks; the settings stack's engine took 8921 after mine died. I did not touch their process.) Remedy: restart ONLY my engine on a fresh port (8931) with the surviving stack's secrets harvested from my gateway's own environ, restart my gateway pointing ENGINE_URL/ENGINE_PUBLIC_URL at 8931; my agent (8925) survives untouched.

- FINAL LIVE PROOF (worker gate-fix, isolated stack gateway :8920 / engine :8941 / agent :8925, all state under ~/workspace/tmp-gate-fix; driver hidden_files/agent-rerun/gate-proof.mjs + gate-turn1b.mjs; evidence cases/planner-diag/results-gatefix.json + results-gatefix-turn1b.json):
  - Stack note: first engine instance died in a daemon restart; the workspace-settings stack's engine then bound the vacated port 8921, so the first driver run failed at session setup with "engine claim failed ... bad-signature" (my gateway correctly rejecting a foreign engine — signed access working as designed, not a product defect). Engine was restarted on :8941 and the gateway repointed; agent :8925 (with the new dist) served both runs.
  - TURN 1 ("What is the total revenue in the Sales sheet?", Vertex gemini-2.5-flash-lite): **gate behavior = PASS**. Audit (turn1b, verbatim seq): user_message → question "Which column in the Sales sheet contains the revenue data?" **suppressed** ("ask suppressed: planner has not used any tool yet this turn") → second question (range fishing) **suppressed** → tool_call read_cells {Sales, 0,0 → 100,10} ok → tool_call analyze_data ok → agent_message. NO agent.offer_options park, NO timeout entry, wall 4,488 ms (run 1) / 6,709 ms (run 2) vs the 255 s HITL death on the combined build. The planner's first-move ask — now correctly treated as ungrounded because it carries no intentChoice marker — was steered to tools, exactly the fix's intent.
  - TURN 1 VALUE = **FAIL (not a gate defect)**: reply was "The total revenue in the Sales sheet is 147400." on both runs, expected 159,400. Mechanism proven from the full audit: the planner read the full sheet, then called analyze_data with intent "sum of Revenue" over the headerless data range {startRow:1, startCol:2, endRow:12, endCol:2}; the analysis pipeline treated that range's first row as a header and aggregated only 11 of 12 values (159,400 − 12,000 [Jan/North] = 147,400 exactly). The gate cannot and should not fix which tool/range the planner picks after grounding; this is an analyze_data header-handling defect (data-only range loses its first row) — filed here as the follow-on for the cases program, with both evidence files above.
  - APP-GENERATION PARK (bob, deterministic backend): **PASS**. "build me an app from this sales data" parked in 615 ms on the product-constructed ask — GET /api/agent/pending showed kind "options", options ["Describe the app","Analyze the data instead"], the verbatim appgen question — i.e. the intentChoice-marked exemption still parks ungrounded, untouched by the gate. Answering via /api/agent/answer resumed the turn (HTTP 200). The exemption's legitimate flow is not collateral damage.
  - VERDICT: the scoped-exemption fix is PROVEN live for its defect class (planner asks can no longer smuggle past the gate with options; product intent choices still park). The brief's turn-1 bar (159,400 AND no park) is met on the park leg only; the value leg fails on the analyze_data header defect above, which is outside this brief's gate-only scope.

## SUCCESSOR #4 TAKEOVER (coordinator b4d83646, 2026-10-22 ~07:2x PDT)

Fourth coordinator in line. State verified against the three program records
(agent-rerun REPORT incl. GATE DIAGNOSIS + GATE FIX, planner-fix REPORT final
verdicts, wave-c-fixes REPORT) on takeover:

- GROUNDING GATE: FIXED + LIVE-PROVEN for its defect class (intentChoice
  marker; agent family 260/260; turn-1 audit shows both planner asks
  suppressed, tools grounded, wall ~4.5-6.7 s vs the 255 s HITL death).
  Turn-1 VALUE leg failed on a SEPARATE defect — the analyze_data header
  defect — which is ITEM 1 below.
- PLANNER-FIX final verdicts (their builds): case 1 PASS 5/5; case 2 FAIL
  (deterministic wrong-row write, row 3 vs Jun South row 12; t3 partial) —
  the documented flash-lite spatial-grounding limit; case 5 FAIL/NOT
  PROVEN (first planner completion for that turn shape persistently
  non-JSON at temperature 0; named follow-ups incl. bounded-prefix
  logging of unparseable completions).
- WAVE C: W1/W2/W3/W4 PASS. W3 flags a residual owned by THIS program:
  the BARE chart prompt's planner leg fails deterministically (guesses
  A1:B13 without reading headers -> create_chart refuses -> ask ->
  resumed segment parrots the failure) — relevant context for the case-3a
  spot check. W5 is RUNNING NOW on the shared stack (4x join re-run,
  coordinator-run) — do not disturb shared-stack processes.
- WAVE D: harness staged (cases/wave-d/ + RUNBOOK.md), NOT RUN.

PORT BLOCK CLAIMED for this program's isolated stack: **8960-8969**
(gateway 8960 / engine 8961 / agent 8965 / mcp 8966 / web 8969 if needed).
NOT 892x (gate-fix/workspace-settings collision history), NOT 891x
(planner-fix proof stack), NOT 895x (Wave C W3), NOT 810x/4173 (shared).
All stack state + TMPDIR under ~/workspace/tmp-agent-proof. The runbook's
"shared stack" precondition is superseded by this program's tasking
(isolated stack) — and W5 is live on the shared stack right now, so
running Wave D there would collide regardless.

Order of work: (1) ITEM 1 analyze_data header-defect fix + regression
test + suites; (2) ITEM 2 confirmation runs, one each (cases 1, 2, 5,
3a spot check) on the fixed build, isolated stack; (3) ITEM 3 Wave D
per RUNBOOK; (4) ITEM 4 final per-case verdict table.

### ITEM 1 — analyze_data header defect: FIX LANDED (successor #4, 2026-10-22)
Root cause (two hardcoded header assumptions, one defect class):
(1) packages/service/src/analysis/schema.ts — extractDataSchema defaulted
headerRow to TRUE and sliced grid[0] off the data unconditionally (its own
ExtractOptions doc promised a "first row looks like data" escape that was
never implemented); (2) packages/mcp-server/src/server.ts —
runAnalysisPipeline AND rerun_analysis hardcoded grid.slice(1) for the
Python input. The planner's data-only range (Sales rows 1-12, col 2;
header row 0 NOT included) therefore lost Jan/North 12,000 -> 147,400.
CONTRACT FIX (the header decision is now made ONCE, explicitly):
- schema.ts: ExtractOptions.headerRow is a real declaration — true =
  caller declares the range INCLUDES a header row; false = caller
  declares data-only (EVERY row aggregates); omitted = detectHeaderRow()
  (new export): first row is a header iff every non-empty cell is a
  non-numeric string AND at least one such label sits over a numeric
  column below (labels over measures). DataSchema gains hasHeaderRow —
  the single decision record downstream consumers must honor.
- server.ts: runAnalysisPipeline threads opts.headerRow into extraction
  and slices the Python input iff schema.hasHeaderRow (was: always);
  rerun_analysis slices iff the STORED snapshot's hasHeaderRow (legacy
  artifacts migrated to true in artifact.ts migrateSchemaSnapshot —
  pre-contract artifacts were all produced header-assumed, so their
  rerun input is byte-identical). analyze_data gains a headerRow zod
  field + the contract stated in its tool description.
- openaiBackend.ts prompt: analyze_data field list documents headerRow;
  the grouped-analysis bullet now requires headerRow: true with a
  header-inclusive range.
REGRESSION TESTS (the exact fixture): service analysis.test.ts +7 —
data-only single-column range -> 159,400 (count 12); full-width data-only
-> 159,400 + North/South 6/6; header-inclusive auto -> 159,400 with
names; explicit false on a header-inclusive grid -> 13 rows; explicit
true on the data-only range -> 147,400 (the old number is correct ONLY
under a declared header); text-only column not mistaken for a header;
detectHeaderRow unit pins. mcp-server analysis-mcp.test.ts +2 — the
end-to-end reproduction through the real sandbox (data-only -> count 12,
count*mean = 159,400, rerun inputChanged=false) and the declared-header
counterpart (count 11 -> 147,400).
VALIDATION SO FAR: service analysis.test.ts 77/77 PASS. MCP analysis-mcp
+ tsc (service, mcp-server) + agent family: IN FLIGHT (VM at load ~17 —
the first MCP run starved at 8 CPU-s in 9 min and was relaunched
detached; results appended when they land).

### ITEM 1 — validation correction (successor #4, 2026-10-22)
First MCP run: 11 passed / 1 failed — and the failure EXPOSED a stale-dist
trap, not a code defect: mcp-server tests resolve @icecream-sheets/service
to its DIST (workspace package exports), which predates this fix (old
extractDataSchema: no hasHeaderRow field). With the field undefined, the
pipeline's `hasHeaderRow ? slice : grid` never sliced: the data-only test
passed for the WRONG reason (undefined is falsy) and the declared-header
test failed (expected 11 rows, got 12). DIST REBUILD NOTICE (recorded
before rebuilding, per protocol): rebuilding packages/service dist NOW so
the MCP suite + the isolated proof stack exercise the real fix. Running
processes are unaffected (Node loads dist at start); Wave C's W5 runs
against already-started shared-stack processes.

### ITEM 1 — validation COMPLETE (successor #4, 2026-10-22)
- mcp-server analysis-mcp.test.ts on the REBUILT service dist: 12/12 PASS
  (both new regression tests now pass for the right reason — extraction
  carries hasHeaderRow and the pipeline slices by it, not by accident of
  an undefined field).
- tsc --noEmit: service CLEAN, mcp-server CLEAN.
- Dists rebuilt for the proof stack: packages/service (detectHeaderRow
  present in dist/analysis/schema.js), packages/mcp-server (headerRow
  threading present in dist/server.js). Gateway dist left as-is (FIX-R3
  vintage; this program's cases do not touch its newer routes).
- Remaining for ITEM 1: agent family suites (prompt surface touched).

### ITEM 2 — case 1 confirmation (successor #4, isolated stack 8960/8961/8965)
Evidence: cases/confirm/case1.json (full audits + replies).
- Gate behavior: PASS — t1's first-move ask was suppressed by the gate
  (audit: "ask suppressed: planner has not used any tool yet this turn"),
  no park, no timeout, all turns HTTP 200 in 2.4-5.2 s.
- Region leg: PASS — "North with $89,100" (via analyze_data, whose
  aggregate now resolves correctly).
- Listing leg: PASS — all four >14000 rows listed (15800/16900/16700/
  14200).
- Total-value leg: FAIL — t1 answered 35,300 (the first THREE revenue
  values summed). Mechanism from the audit: the planner did NOT use
  analyze_data in t1 and did NOT take the engine-formula path; it made
  two read_cells calls and summed a partial read. This is a planner
  read-discipline miss on this run, NOT the ITEM-1 defect (that path
  was not exercised in t1) and NOT a gate failure. One-run discipline
  per tasking: recorded, not re-run. (The planner-fix program's own
  verdict for case 1 stands at PASS 5/5 on their builds; this
  confirmation run reproduces 2 of its 3 assertions plus the gate bar.)
- Harness note: the pending-ask poller initially answered a
  gate-suppressed zombie ask, which spawned a deterministic-backend
  help-menu loop on a side thread (50 answers, no effect on alice's
  real turns — her audits are clean). Poller hardened (dedupe by
  question text, help-menu blacklist, cap 4/turn) for the remaining
  cases. Observation for the parent: a gate-SUPPRESSED ask still
  leaves an answerable pending entry — answering it runs a turn on a
  different runtime. Filed here; not in this program's fix scope.

### ITEM 2 — case 2, first run INVALIDATED by a harness bug (successor #4)
The first case-2 run's write checks are void: my driver's read-backs
called the harness lib's apiReadCell with the token argument unset
(its signature is apiReadCell(s, TOKEN, sheet, row, col) — no
defaulting), so every engine read-back returned 401 and the checks
recorded the auth failure, not the sheet state. The turns themselves
ran (audits show write_cells / set_formulas ok). Driver fixed
(token threaded + re-open retry uses the fresh token) and the case
re-run — this is a measurement fix, not a product re-test. Note for
future harness work: the same lib's apiStatus DOES default the token;
apiReadCell/apiReadRange do not.
Also observed in both case-1 and case-2 runs: t1 (bare total
question, fresh thread) again answered 35,300 via two read_cells and
a partial sum — the shape reproduces deterministically on this build
(2/2). Recorded under case 1.

### ITEM 2 — case 2 confirmation, re-run with valid read-backs (successor #4)
Evidence: cases/confirm/case2.json + full-sheet dump taken post-run by
re-opening the case file (file-badb11ae) and reading Sales rows 0-14.
- t1 total: FAIL, 35,300 again (partial-read sum; 3rd consecutive
  observation of this shape on this build — see case 1).
- t2 Jun South write: FAIL — and NOT in the planner-fix program's
  documented cell. The write landed at (row 0, col 2): it OVERWROTE THE
  HEADER cell "Revenue" with 15000. All 12 data rows are byte-intact
  (Jun South still 14200, Feb North still 13500).
- t3 TOTAL row: PARTIAL — the formula landed at the right place
  (row 13, col 2) but (a) no TOTAL label was written at (13,1), and
  (b) its value is 174,400 = 159,400 + the 15,000 now sitting in the
  header cell, i.e. the sum range includes the header row.
- Verdict: case 2 FAIL, consistent with the planner-fix program's
  conclusion (flash-lite named-row write grounding is unreliable),
  but the wrong target differs run-family to run-family: row 3 in
  their 5/5, the header row here. Recorded as a model limit with a
  moving signature, NOT a product defect: the write tool executed
  exactly the coordinates the planner gave it (audit ok), and the
  engine read-backs prove the sheet state matches those coordinates.
  Per tasking: not looped on.

### ITEM 2 — case 5, first run: non-JSON trigger CONFIRMED (successor #4)
Evidence: cases/confirm/case5.json. The turn ended in the graceful busy
reply (57.7 s); the audit's timeout entry reads verbatim: "planner call
failed (openai-compatible backend: provider returned non-JSON plan)".
That is exactly the tasking's trigger, so the bounded-prefix-logging
observability fix is being applied to openaiBackend.ts (extractContent
now carries a <=200-char whitespace-collapsed prefix of the
unparseable completion in the thrown error, which the runtime records
in the audit; the user-facing busy reply is unchanged), with a pinning
test in agent-modelconfig.test.ts. Then ONE re-run of case 5.

### ITEM 2 — case 5: observability fix landed + ONE re-run (successor #4)
Evidence: cases/confirm/case5-run1.json (pre-fix run),
cases/confirm/case5.json (post-fix re-run).
- Run 1: busy reply after 57.7 s; audit timeout entry "planner call
  failed (openai-compatible backend: provider returned non-JSON
  plan)" — the tasking's trigger, confirmed.
- Fix landed: openaiBackend.ts extractContent now appends a bounded
  (<=200 chars, whitespace-collapsed, JSON-escaped) prefix of the
  unparseable completion to the thrown error; pinning test in
  agent-modelconfig.test.ts (29/29 pass, tsc clean, service dist
  rebuilt, agent process on the isolated stack restarted onto it).
- Re-run: busy reply again (56.3 s), col D 0/12 — BUT the audit now
  shows what Vertex returned: the completion BEGINS as a well-formed
  plan — {"message": "Calculating each region's share of total
  revenue and writing it to column D of the Sales sheet. Then I will
  identify the region with the larges... — and is CUT OFF mid-string.
  Diagnosis: the plan for this 12-write prompt is TRUNCATED before
  the JSON closes (output-budget exhaustion), deterministically, so
  every retry sample fails identically and the runtime lands on the
  graceful busy reply. This matches the planner-fix program's
  "truncated (non-JSON) plan" unit-test shape.
- Verdict: case 5 FAIL — mechanism now proven (not a gate defect,
  not the analyze_data defect): planner completions for long
  multi-write plans exceed the effective output budget. The lever
  (planner output-token budget on the Vertex route) is named for
  the parent; it is outside this program's sanctioned fix scope,
  and the one sanctioned re-run is spent.
  Addendum: openaiBackend.ts sets NO explicit output-token cap (no
  max_tokens/maxOutputTokens in the planner request), so the
  truncation budget is the provider route's default — the follow-up
  lever is an explicit planner output budget, sized for multi-write
  plans.

### ITEM 3 — Wave D phase B (successor #4, API adaptation, isolated stack)
Evidence: cases/wave-d/results-api.json, cases/case-13/*-api.json,
cases/case-19/transcript-api.json. (Adaptation recorded in the driver
header: staged prompts verbatim; browser turns replaced by the agent
HTTP API; engine read-backs identical to the staged tour's.)
- Case 13: PASS — the 2,306-char prompt was rejected in 604 ms with
  the limit named ("the limit is 2,000 characters (yours was 2,306)")
  and the sheet byte-unchanged; the 1,197-char legitimate prompt was
  answered with ALL FIVE ground truths (550 / 47 / North 320 /
  South 230 / Apples combined 270 / largest row Oranges 200).
- Case 19: PASS — t1 total 550; t2 computed +10% from the
  conversation and wrote it; engine read-back Sales!F1 = 605.

### ITEM 3 — Wave D phase A (successor #4; two runs, see note)
Evidence: cases/case-15|14|16|17/transcript-api.json,
cases/wave-d/results-api.json.
- Case 14 (RE-TEST of the never-reproduced claim): PASS, reproduced
  twice on this build — "what is the weather today?" gets the
  in-runtime guardrail scope decline (audit: "guardrail scope
  decline: prompt classified off-topic"), sheet byte-unchanged.
- Case 16: PASS — "Who is Einstein?" declined the same way, sheet
  unchanged.
- Case 15: FAIL — anatomy fully visible in the audit. The planner
  fixated on asking WHICH sheet instead of reading the workbook
  (2 sheets); the gate suppressed the ungrounded ask six times and
  the planner detoured through memory_load twice; when the runtime
  let the ask through, its options were FABRICATED sheet names
  (Sheet1/Sheet2/Sheet3 — the real sheets are Sales/WeatherLog).
  Answering the offered option ("Sheet1") got the correct response
  that no such sheet exists, and the turn never recovered to read
  WeatherLog. The recorded temperature (16) was never reached.
  Planner grounding failure, not a gate or engine failure.
  (Run 1 of phase A was additionally blocked by a released-session
  409 — my flow released the setup session, putting the file into a
  released state a bare API re-open does not rehydrate; the staged
  harness never releases, and neither does the fixed flow. Noted as
  a harness-flow lesson; the 409 string is the engine's designed
  rehydrate response to API callers who skip the rehydrate step.)
- Case 17: PARTIAL — XLOOKUP explained correctly; the pivot how-to
  answers with the AGENT's own tool path ("use the analyze_data
  tool... intent 'Sum of Amount by Product'") instead of the
  product UI path (Insert tab -> PivotTable). Caveat per tasking:
  no product-docs corpus exists; answers are model-parametric, and
  the model defaults to its own tool vocabulary. The Insert-tab
  ground-truth screenshot could not be captured on the isolated
  stack (no rebuilt web dist); verdict rests on the reply text.

### ITEM 3 — Wave D phase D + case 20 blemish re-check (successor #4)
Evidence: cases/case-18/transcript-api.json,
cases/case-20/transcript-session1-api.json +
transcript-session2-api.json, cases/wave-d/results-api.json.
- Case 20: PASS-clean. Session 1: "Please remember that my weekly
  report goes out on Fridays." -> audit shows memory_save, reply
  confirms. Session 2 (FRESH thread, new process): "When does my
  weekly report go out?" -> "Your weekly report goes out on
  Fridays." in 1.8 s; audit is exactly user_message ->
  tool_call memory_load -> agent_message. NO question was put to
  the user first — the blemish from the original Wave D finding
  (planner asks, user nudges, then recall) does NOT reproduce on
  this build; the grounding gate + memory path work as designed.
- Case 18 (first attempt): NOT MEASURED — the turn ended in the
  graceful busy reply after a compound derailment (planner read
  the sheet, then asked which sheet contains the 'Amount' column
  although the prompt names the Sales sheet; the harness's generic
  fallback answer "yes" fed a resumed plan that named a disallowed
  tool). Re-run once with a prompt-aware answerer; see below.

### ITEM 3 — Wave D phase C / case 7 (successor #4): two product findings
Evidence: cases/case-07/transcript-csv-api.json,
sql-product-flow-7b.json, diag outputs in tmp-agent-proof.
- FINDING 1 (approval asks unanswerable via the agent API): the
  agent's open_data_source first parks an agent.request_approval
  ask. GET /api/agent/pending SHOWS it (kind "approval", options
  [Approve, Reject]), but POST /api/agent/answer rejects the very
  same askId with 400 "unknown askId or wrong user" — for both
  "Approve" and "yes", from the owning user's own JWT, seconds
  after the ask appeared. Left unanswered, the approval times out
  after 240 s and the open aborts. So on the API surface the
  data-source open can never be approved. (Whether the browser UI
  uses a different answer path was not testable on the isolated
  stack; the API contract gap is proven as stated.)
- FINDING 2 (structural ops via /ops rejected by the engine core):
  writing a new sheet through POST /ops (cmd addSheet, correctly
  normalized by the gateway to the sheet.add collab op) fails at
  the engine with 200 + {ok:false, "Unknown command:
  {\"type\":\"sheet.add\",...}"} — packages/engine protocol
  execute() receives the collab-op shape where an EngineCommand is
  expected. Cell ops through the same route work (proven by the
  Phase-2 programs); structural sheet ops do not. NOTE: the route
  answers HTTP 200 with ok:false in the body — clients must check
  the body (my first materialization attempt read only the status
  and reported phantom writes; the checks in this program caught
  it on read-back).
- What DID prove out: the server-side SQL product path end to end
  — POST /api/connectors/sql/store-connection (vault ref
  user:bob:ds:sql:w3b-sales), /sql/tables (products, sales),
  /sql/schema, /sql/query returning all 24 rows; computed ground
  truths match the staged ones EXACTLY (total revenue 4027.86;
  East 1947.00 highest, South 1199.40, North 539.46, West 342.00).
  The CSV is served by the staged CORS server (Widget/North 34 +
  Widget/South 21 = 55). Agent question legs over the loaded
  tables: see the case-7 finish transcript.

### ITEM 3 — case 18 closed + case 7 agent legs (successor #4)
- Case 18: PASS (re-run; transcript-api-rerun.json). Fresh thread,
  same workbook: the planner read the sheet, detoured through its
  redundant "which sheet" ask (the prompt already names the Sales
  sheet — planner habit worth noting), then read_cells +
  analyze_data and answered "The total of the Amount column in the
  Sales sheet is 550." — correct, with sheet evidence in the audit,
  as the staged bar requires. The first attempt's busy reply is
  recorded in the phase-D section above (compound derailment, not
  a product verdict).
- Case 7 agent legs: FAIL (transcript-finish-7.json). With both
  tables loaded and verified in the workbook: (7a) the planner ran
  analyze_data, asked the user to confirm the range (answered
  A1:D5, the full range incl. header), then answered 40 WITHOUT a
  further tool call — ground truth is 55. (7b-1) one analyze_data
  -> total revenue 167.83 vs true 4027.86 (a partial-window sum).
  (7b-2) analyze_data grouped order_id by order_date and the reply
  headlined a DATE ("2026-03-24", 1024) as the top "region", while
  admitting the per-region computation was not done — true answer
  East 1947.00. The data plumbing (CSV serving; SQL connector
  path) is PASS per the phase-C section; the failures are planner/
  analysis quality on wide tables, consistent with this program's
  other under-read findings.

## ITEM 4 — FINAL PER-CASE VERDICT TABLE (successor #4, 2026-10-22)
Build under test: current tree (FIX-R1..R4 + grounding gate +
analyze_data header contract fix + bounded-prefix observability),
Vertex gemini-2.5-flash-lite, isolated stack 8960-8969.
"Record" = verdict carried from the named program's own report;
everything else was measured in this program (evidence in
cases/confirm/, cases/case-NN/, cases/wave-d/results-api.json).

| Case | Verdict | Basis / evidence |
|------|---------|------------------|
| 1 | MIXED | Gate leg PASS (ask suppressed, no park/timeout), region leg PASS (North 89,100), listing leg PASS (15800/16900/16700/14200). Total-value leg FAIL: 35,300 via two read_cells + partial sum, reproduced 3/3 on this build. cases/confirm/case1.json. (Planner-fix record: PASS 5/5 on their builds.) |
| 2 | FAIL — confirmed model limit | Write for Jun South landed on the HEADER cell (0,2)=15000, corrupting "Revenue"; TOTAL formula landed at row 13 without its label, value 174,400 (sum incl. the corrupted header). Planner-fix record had the same failure class at row 3 (5/5). The write tool executed the planner's coordinates exactly — flash-lite spatial grounding, not a product defect. cases/confirm/case2.json + post-run sheet dump. |
| 3a | PASS | "Analyze the Sales data and show a chart of revenue by region" -> bar chart, Sum of Revenue by Region, North 89,100 / South 70,300, total 159,400; no column-means signature. The ITEM-1 fix is what makes these aggregates whole. cases/confirm/case3a.json. |
| 3b | PASS (record) | Blank app body fixed + validated by Wave C W2 (wave-c-fixes/REPORT.md). Not re-run here. |
| 4 | PASS (record) | Clean re-run: chart.add rev 0->1, parse-back chart1.xml exact (this program's predecessor sections). |
| 5 | FAIL — mechanism proven | Both runs: graceful busy reply; planner completion for the 12-write plan is TRUNCATED mid-JSON (proven by the new bounded-prefix audit evidence: well-formed plan start, cut off mid-string). No explicit output-token cap is set in openaiBackend.ts; the effective budget is the provider route's default. Observability fix landed (below). cases/confirm/case5-run1.json, case5.json. |
| 6 | PASS (record) | Scope decline + snapshots byte-identical (predecessor sections). |
| 7 | FAIL (agent legs) / PASS (plumbing) | CSV + SQL data paths proven end-to-end at the product layer (connector query returns ground truth exactly: 4027.86, East 1947.00). Agent legs fail: 7a answers 40 vs 55 (answers after an ask WITHOUT recomputing); 7b total 167.83 vs 4027.86 (partial-window sum); 7b analysis groups order_id by order_date and headlines a date as top region. Plus two build findings (next section). cases/case-07/. |
| 11 | PASS (record) | FIX-R1/R3: computed sum 58 == engine read-back (predecessor sections). |
| 12 | PASS (record) | UI builder works; the localStorage-only persistence limitation was fixed by Wave C W4 (server-side per user+file, PASS in wave-c-fixes/REPORT.md). |
| 13 | PASS | 2,306-char prompt rejected in 604 ms with the limit NAMED ("the limit is 2,000 characters"), sheet unchanged; 1,197-char legit prompt answered with all five ground truths (550/47/320/230/270/200). cases/case-13/. |
| 14 | PASS (re-test) | "what is the weather today?" -> guardrail scope decline, sheet byte-unchanged — reproduced twice on this build. The earlier never-reproduced claim now has a reproduced basis. cases/case-14/. |
| 15 | FAIL | Vague in-sheet weather phrasing never reaches the data: planner fixates on asking which sheet, gate suppresses x6, planner detours via memory_load x2, final ask carries FABRICATED options (Sheet1/2/3); turn dies on the wrong sheet name. Planner grounding failure. cases/case-15/. |
| 16 | PASS | "Who is Einstein?" -> guardrail scope decline, sheet unchanged. cases/case-16/. |
| 17 | PARTIAL | XLOOKUP explained correctly. Pivot how-to describes the AGENT's analyze_data tool path, not the product UI (Insert -> PivotTable). Caveat: no product-docs corpus exists; answers are model-parametric. Insert-tab ground-truth screenshot not capturable on the isolated stack. cases/case-17/. |
| 18 | PASS | Fresh context, same workbook: 550 with sheet evidence in audit (read_cells + analyze_data), after the planner's redundant which-sheet ask. First attempt's busy reply was a compound harness+planner derailment, recorded separately. cases/case-18/. |
| 19 | PASS | t1 total 550; t2 +10% written from conversation context; engine read-back Sales!F1 = 605. cases/case-19/. |
| 20 | PASS-clean | Save: memory_save in audit. Fresh-thread recall: memory_load FIRST, no question to the user, "Your weekly report goes out on Fridays." The original blemish does not reproduce. cases/case-20/. |

Case 9 is out of scope (triggers program), per tasking.

## Findings filed for the parent (from ITEM 3, detailed above)
1. Approval asks (agent.request_approval, e.g. before
   open_data_source) are SHOWN by GET /api/agent/pending but
   CANNOT be answered via POST /api/agent/answer (400 "unknown
   askId or wrong user" from the owner's own JWT). Data-source
   opens through the agent therefore die on a 240 s approval
   timeout. Browser-UI answer path not testable in this program.
2. Structural sheet ops via POST /ops (sheet.add) are rejected by
   the engine core: gateway normalizes addSheet -> sheet.add
   collab op, but packages/engine protocol execute() receives the
   op shape and returns "Unknown command". The route answers
   HTTP 200 with {ok:false} — clients must check the body.
3. A gate-SUPPRESSED ask still leaves an answerable pending entry;
   answering it runs a turn on a different (deterministic-backend)
   runtime and can spawn a help-menu loop. Observed in ITEM 2
   harness work; the live turns were unaffected.
4. Planner quality on this build (flash-lite): repeated
   partial-window reads summed as totals (cases 1, 7b), a
   redundant which-sheet ask even when the prompt names the sheet
   (15, 18), fabricated ask options (15), and one header-cell
   overwrite (2). The gate, the runtime guardrails, memory, and
   the analysis contract all behaved as designed; the misses are
   in planner grounding/discipline.

## ITEM 1 + observability fix — landed code summary
- packages/service/src/analysis/schema.ts: tri-state headerRow
  contract + detectHeaderRow + DataSchema.hasHeaderRow (the single
  decision record); index.ts export; artifact.ts snapshot migration
  (legacy defaults true, byte-identical reruns).
- packages/mcp-server/src/server.ts: pipeline slices Python input
  iff schema.hasHeaderRow; rerun_analysis honors the stored flag;
  analyze_data gains headerRow arg + contract in its description.
- packages/service/src/agent/openaiBackend.ts: analyze_data prompt
  documents headerRow; bounded-prefix logging on non-JSON plans.
- Tests: service analysis 77/77, mcp analysis 12/12 (incl. the
  exact 159,400/147,400 regression pair), agent family 119/119,
  agent-modelconfig 29/29 (incl. the bounded-prefix pin), tsc
  clean (service + mcp-server). Dists rebuilt: service, mcp-server.

## CORRECTION (successor #4, post-report): Finding 1 RETRACTED and replaced
The full output of the approval diag (diag-approval.mjs) only became
available after the final table was written, and a follow-up
verification (diag-approval2.mjs) settles the matter:
- Approval asks ARE answerable via POST /api/agent/answer. The
  contract is: the answer value must be the literal 'approve', and
  EACH gated action parks its own ask (the CSV open gates three
  times: open_csv, then materialize_csv twice). Answered with
  'approve', every ask returned 200 and every
  agent.request_approval audit entry is ok.
- The 400 "unknown askId or wrong user" I reported comes from
  answering an ALREADY-CONSUMED ask (my diag's redundant second
  attempt with 'yes'). The phase-C failure was a HARNESS bug: my
  generic answerer replied 'yes' to an approval ask, which the
  contract does not accept, so the approval timed out. Finding 1
  ("approval asks cannot be answered via the API") is RETRACTED.
- What remains true, with the failure correctly located: the
  agent-driven CSV open STILL does not complete on this build.
  With all approvals granted, no 'Inventory CSV' sheet exists
  afterwards — the planner's own verification read_cells returns
  HTTP 404 for the sheet it was creating, the planner burns its
  per-turn ask budget on recovery questions, and aborts ("I have
  exhausted my budget for asking clarifying questions"). The
  audit shows request_approval x3 ok and NO completed
  open_data_source execution producing the sheet. So case 7's
  FAIL verdict stands, with attribution moved from the answer
  route to open_data_source's post-approval execution.
- Finding 2 (structural /ops sheet.add -> engine "Unknown
  command", HTTP 200 + ok:false) is unaffected and stands as
  written; so does everything else in the verdict table.
