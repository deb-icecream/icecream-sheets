# Rehydrate-Scope-Coherence Fix — REPORT

**Task:** Fix the engine/gateway REHYDRATE-SCOPE-COHERENCE defect in icecream-sheets (found 2026-10-22 during F-3/#18 validation).
**Port block:** 9110-9119 (claimed by this worker).
**GitHub issue:** #26 — https://github.com/is-cream/icecream-sheets/issues/26 ("Rehydrated session reads fail 401 'wrong-session' — gateway-minted access scope does not match the engine's rehydrated session id"). Related: #18 stays OPEN (partial fix documented); #17, #21 CLOSED.
**Status log:**

- [checkpoint created] Task started. Defect: after engine session release/checkpoint + REHYDRATE, joined client's reads fail persistently with 401 "engine access denied: wrong-session" — gateway-minted access scope names the PRE-RELEASE session id; engine validates against the REHYDRATED session's id.
- Next: read hidden_files/hosted-ux-followup/REPORT.md (F-3 section) + sweep-findings-fix cross-finding; then prove the identity chain in code before changing anything.
- [COMPLETE] Root cause proven (sticky W20 build-gate error outliving its session — NOT a durable session-id divergence), fix landed in engineSvc.ts (registerSession + rehydrateSession clear it), regression tests 2/2 + related suites 51/51 + tsc clean, browser before/after PASS on ports 9110-9119. Full record below. Not pushed (parent pushes).

## IDENTITY CHAIN — PROVEN IN CODE (before any change)

How one session identity is born, minted, enforced, released, rehydrated:

1. **Token format** (`packages/gateway/src/deploy/engineAccess.ts:313` `issueEngineAccessToken`): HMAC-SHA256 signed claims `{ sub, sid, fid, role, tier, iat, exp }`. Two mint paths in the gateway: (a) `POST /api/engine/open` (gateway.ts:908) — fid-scoped; (b) `POST /api/engine/access` (gateway.ts:850) — session-scoped (fid=''), sid = client-named or fresh random.
2. **Gateway open** (gateway.ts:1006-1150): registry lookup(fileId) → live owner ⇒ JOIN, reply token sid = rec.sessionId. Else CLAIM: sid = `rec.sessionId ?? newSessionId()`; POST engine `/session/claim {fileId, sessionId}` bearing an editor token for that sid; `engineSessionId` = the claim response's sessionId (engine's answer wins); CAS-claim registry {fileId → engineSessionId, epoch+1}; reply token minted for engineSessionId.
3. **Engine claim** (engineSvc.ts:4501-4607): active same-file session ⇒ returns state.sessionId. Else candidate = body.sessionId → snapshot exists ⇒ `rehydrateSession(candidate)` (SAME id) ⇒ returns candidate; no snapshot ⇒ `registerSession(candidate)` (blank pending session under candidate).
4. **Load** (engineSvc.ts:5086/5143/5195 + loadBytesIntoSession:4002): signed mode requires body.sessionId === token.sid; `registerSession(body.sessionId)` installs that id as state.sessionId; `bindLoadedSession` binds fileId from the token fid or the claim's pending binding.
5. **Release** (evictSession, engineSvc.ts:3317): checkpoint (snapshot+journal stored under state.sessionId) → fileRegistry.release (deploy/fileRegistry.ts: the record AND its sessionId are preserved; only the lease clears) → status 'released'; state.sessionId/state.fileId retained in memory.
6. **Rehydrate** (rehydrateSession, engineSvc.ts:3363): loads snapshot+journal BY sessionId, verifies checksum, sets `state.sessionId = sessionId` — the SAME id. Design docs agree (revision-model §9: one sessionId per file, gateway-minted token checked against the engine's own session; deployment-architecture: "return = rehydrate from snapshot + journal").
7. **Enforcement** (engineSvc.ts:4199-4215): every non-session-introducing route: `claims.sid !== state.sessionId` → 401 wrong-session; file-scoped routes also require claims.fid === state.fileId (401 wrong-file); a released session answers 409 to non-lifecycle routes.

**Conclusion on identity:** the designed chain is coherent — one id is born at claim, preserved by release, restored verbatim by rehydrate, minted by the gateway, enforced by the engine. There is no durable id divergence in this chain. The 401s in the F-3 capture are the TRANSIENT switch window (while the engine legitimately names the failed session S2, S1-scoped reads are correctly refused; before S2's claim, the released S1 answers 409) — correct refusals, not the persistent blocker.

## THE PERSISTENT BLOCKER — CODE-PROVEN: the W20 build gate's sticky error outlives its session

- `beginLoadBuild()` (engineSvc.ts:2152) opens the read gate for a load; `endLoadBuild(gate, err)` (:2175) settles it and records the error as `lastBuildError`.
- `waitForLoadBuild()` (:2188) — called ONLY by `/read` (:4948): gate open ⇒ pend, then throw the gate's error if the build failed (W20's intent). **No gate open ⇒ if `lastBuildError` is set, throw it — for every subsequent /read, indefinitely, until the next `beginLoadBuild`.**
- The documented contract (:2134-2138) bounds the stickiness: "until the next successful load or a /reset clears it". `/reset` clears it explicitly (:5896, "a previous load's failed build must not keep failing reads against the blank workbook").
- **But `rehydrateSession` and the claim-path session installation (`registerSession` via /session/claim) never clear it.** In the F-3 sequence: corrupt load for session S2 fails → `lastBuildError` = S2's parse error → S2 released → restore claim rehydrates S1 (no load begins, gate never cleared) → **every /read against the healthy rehydrated S1 throws S2's parse error (500) forever**, while /ops, /sheets, /snapshot (which never consult the gate) work — frame returns, edits land + autosave, values never repaint. Exactly the F-3 acceptance failure.
- Direct runtime evidence: hosted-ux-followup `runtime/logs/engine.log` lines 31-35, 40, 46-47 — after `session rehydrated session=sess_34a3322a…` (line 30), repeated `request failed POST /read: failed to parse xlsx: XlsxAdapter.read: not a readable spreadsheet package…` (the CORRUPT file's error) while the rehydrated session checkpoints/autosaves normally (lines 39-45).

## FIX (smallest, consistent with the /reset precedent + design docs)

Clear `lastBuildError` where a session identity is installed without a load: in `rehydrateSession()` (on successful install) and in `registerSession()` (covers the claim path's blank-session install; on the /load success path it is a no-op because endLoadBuild settles the gate with no error immediately after). The failed build's error then lives exactly as long as its session does — W20's pinned same-session behavior (engineSvcReadDuringBuild tests) is untouched: those flows have no session transition between the failed load and the reads. Access validation is NOT weakened: sid/fid gates unchanged; negative tests included in the regression file.

## 409-WEDGE CROSS-FINDING — explicitly NOT resolved by this fix

The sweep-findings-fix cross-finding (a never-released stale session wedges ALL opens with 409 "engine already owns a different file" for 35+ min, past the idle rule) is a different mechanism: the claim ACTIVE-branch refusal + no live-session expiry with SESSION_LIFECYCLE off. This fix touches neither session lifecycle nor the claim refusal. Stated plainly: **the wedge is unaffected**; it needs its own fix (session lifecycle/expiry territory).

## NEXT STEPS
- [x] Regression tests FIRST (tests/rehydrateScope.test.ts): full gateway F-3 sequence + explicit /session/rehydrate variant + negatives. Expect FAIL on current code at the post-restore /read.
- [x] Apply fix; re-run new tests + related suites only (engineSvcReadDuringBuild, phase2Collab, deployAccess).
- [x] Browser validation on ports 9110-9119 with rebuilt dists.

## BROWSER VALIDATION (ports 9110/9111/9112, production topology, signed mode)

Setup: gateway dist rebuilt from the current tree in two flavors — `runtime/dist-after` (fix in) and `runtime/dist-before` (the two #26 lines stripped, everything else identical) — plus a fresh web dist (`build:local-stack` + verify-dist PASS) byte-rewritten 8100→9110. Same tour both legs (scripts/tour.mjs): sign in → +New → type 'alive' → ribbon-open simple.xls → ribbon-open corrupt.xlsx → restore navigation → poll.

**BEFORE (unfixed engine):**
- XLS open: B2 = "10" ✓ (values visible pre-restore).
- After restore: **B2 = "" — values never repaint**; post-restore edit 'Kiwi' lands (ops fine); reads after restore: **ok=0, failed=66**.
- Engine log: `session rehydrated session=sess_8f2e0001… checksum=8949afbb…` (same checksum as the followup worker's evidence) followed by 6× `request failed POST /read: failed to parse xlsx: XlsxAdapter.read: not a readable spreadsheet package` — the corrupt file's error failing the restored session's reads.
- Screenshot shots/tour-before-2-restored.png (self-inspected): 'Data' tab present, grid completely blank.

**AFTER (fixed engine):**
- XLS open: B2 = "10" ✓.
- After restore: **B2 = "10" — values repaint**; status bar shows "That file could not be opened. Your previous workbook was restored."; post-restore edit 'Kiwi' lands.
- Reads after restore: ok=5, failed=4 — all four failures are the transient switch window (3× 409 while released, 1× 404 Item-H unknown-sheet for the boot workbook); **zero 401, zero 500 after convergence**.
- Engine log: identical release/rehydrate lines (same session id, checksum 8949afbb…), **zero `request failed POST /read` lines**.
- Screenshot shots/tour-after-2-restored.png (self-inspected): full values painted (Item/Amount, Apples 10, Oranges 20, Total 30, Day, Rate).

**Negative check (post-restore, service level — in tests/rehydrateScope.test.ts):** token scoped to the dead session → 401 wrong-session; token for the restored session but a different file → 401 wrong-file on /ops; unscoped random-session grant → 401 wrong-session. Access validation is not weakened. (One process note: the first AFTER attempt ran against the still-running BEFORE stack — port collision, my start script only reaps its own flavor's pids; detected from the tour's abort error + bind-crash log, stack killed, leg re-run clean. The discarded run is not counted.)

## PER-LEG VERDICTS

| Leg | Verdict |
|---|---|
| Identity chain proven in code | ✅ DONE — chain is coherent by construction; no durable sid divergence (see above) |
| Root cause | ✅ The W20 build gate's sticky `lastBuildError` outlived its session; rehydrate/claim installs never cleared it (the /reset precedent existed but didn't cover them) |
| Fix | ✅ LANDED — clear the sticky error in `registerSession()` + `rehydrateSession()` (engineSvc.ts), contract comment updated |
| Regression tests | ✅ NEW tests/rehydrateScope.test.ts 2/2 (failed pre-fix at the exact post-restore read, 500 vs 200) |
| Related suites | ✅ 51/51 (engineSvcReadDuringBuild, phase2Collab, deployAccess, engineSvcStream); gateway tsc exit 0 |
| Browser acceptance (F-3 restore) | ✅ PASS — before: blank values, 0 successful reads; after: values repaint, one coherent session identity in logs |
| Negative scope checks | ✅ PASS — dead-session / wrong-file / unscoped tokens all still refused |
| Stale-session 409 wedge | ❌ NOT addressed (explicitly): different mechanism (claim refusal + no live-session expiry); unaffected by this fix, needs its own work |

## FILES CHANGED (not pushed — parent pushes)

- `packages/gateway/src/services/engineSvc.ts` — the two clearing sites + gate contract comment.
- `packages/gateway/tests/rehydrateScope.test.ts` — NEW regression file (issue #26).
- This report + validation artifacts under `hidden_files/rehydrate-scope/` (start_stack.py, scripts/, shots/, runtime/ logs + dist flavors + engineSvc.fixed.ts provenance copy).

**Bottom line for #26 / #18:** the rehydrate-scope-coherence defect is fixed and proven end-to-end. The restored workbook's values repaint; F-3's remaining acceptance gap is closed by this fix (the client half already landed in the followup batch).


## REPRODUCTION (service level, real gateway + engine over HTTP)

New file `packages/gateway/tests/rehydrateScope.test.ts` (2 tests):
1. **Gateway F-3 sequence** — dev-login → open A (claim) → access-grant load of a real workbook (sheet 'Data', A1=10) → read 200 → wait for epoch adoption → release A ('superseded-by-new-open') → open B (claim) → load corrupt bytes → 400 → **within-session read still 500 'failed to parse xlsx' (W20 contract pinned mid-flow)** → release B ('load-failed') → reopen A → sessionId is the SAME S1 (claim rehydrate) → reads via BOTH token lanes, /sheets, /snapshot, an /ops edit + read-back → negatives: dead-S2 token 401 wrong-session; right-session/wrong-file token 401 wrong-file on /ops; unscoped random-session grant 401 wrong-session.
2. **Explicit /session/rehydrate variant** — engine-level: load S1 → release → claim S2 → failed load → release S2 → POST /session/rehydrate S1 → read 200; dead-S2 token still 401.

**Pre-fix run: BOTH tests failed exactly at the post-restore /read — expected 200, got 500** (the dead session's parse error). Every identity step passed, including the same-session-id restore — confirming the chain is coherent and the gate poison is the blocker.

## FIX LANDED (packages/gateway/src/services/engineSvc.ts)

- `registerSession()` (:2888): `lastBuildError = null` on session install (claim blank-install + load + reset paths).
- `rehydrateSession()` (:3493): `lastBuildError = null` on successful install (both restore paths — /session/claim rehydrate branch and explicit /session/rehydrate — funnel through here).
- Gate contract comment (:2134) updated to name the session-(re)install clearing alongside load/reset.
- Access validation untouched (sid/fid gates byte-identical); the sticky error still applies WITHIN the session whose load failed (pinned by the mid-flow assertion + the existing W20 suite).

## TEST RESULTS (post-fix, related suites only)

- tests/rehydrateScope.test.ts: **2/2 PASS**.
- tests/engineSvcReadDuringBuild.test.ts + phase2Collab.test.ts + deployAccess.test.ts + engineSvcStream.test.ts: **51/51 PASS** (W20 read-during-build contract intact).
- `tsc --noEmit` (packages/gateway): **exit 0**.


